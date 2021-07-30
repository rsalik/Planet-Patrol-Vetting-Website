const express = require('express');
const app = express();
const path = require('path');
const anywhere = require('express-cors-anywhere').default;

const port = process.env.PORT || 3000;

// load environment variables from .env if not in production
if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config();
}

// Google Drive Libraries for PDFs
const { google } = require('googleapis');

const scopes = ['https://www.googleapis.com/auth/drive'];

const auth = new google.auth.JWT(process.env.GOOGLE_CLIENT_EMAIL, null, process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/gm, '\n'), scopes);
const drive = google.drive({ version: 'v3', auth });

// Google Auth Library client creation
const { OAuth2Client } = require('google-auth-library');
const client = new OAuth2Client(process.env.CLIENT_ID);

// Cloudant instance creation (lowercase c for instance)
const Cloudant = require('@cloudant/cloudant');
const cloudant = new Cloudant({ url: process.env.CLOUDANT_URL, plugins: { iamauth: { iamApiKey: process.env.CLOUDANT_API_KEY } } });

const db = cloudant.use('planet-patrol-db');

// Local files
const DIST_DIR = path.join(__dirname, '../dist');
const INDEX_FILE = path.join(__dirname, '../dist/index.html');

// Express Middleware
app.use(express.static(DIST_DIR));
app.use(express.json());

var session = require('express-session');

// Express session settings
let sess = {
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: true,
  },
};

//app.set('trust proxy', 1); // trust first proxy

if (process.env.NODE_ENV !== 'production') {
  sess.cookie.secure = false;
}

app.use(session(sess));

// Middleware to automatically set req.user property if the user already logged in
app.use(async (req: any, _res: any, next: Function) => {
  if (req.session.userId) {
    try {
      req.user = await db.get(req.session.userId);
    } catch {}
  }

  next();
});

// Get user data
app.post('/api/auth/google', async (req: any, res: any) => {
  const { token } = req.body;

  const ticket = await client.verifyIdToken({
    idToken: token,
    audience: process.env.CLIENT_ID,
  });

  const { email, name } = ticket.getPayload();

  let userId = 'user:' + email;

  let user;

  try {
    // Try to find the existing user
    user = await db.get(userId);
  } catch {
    // User not found, create the user
    user = { _id: userId, name: name, tics: [] };
    db.insert(user);
  }

  // Save userId for later API calls
  req.session.userId = userId;

  res.status(200);
  res.json(user);
});

// Logout
app.delete('/api/auth/logout', async (req: any, res: any) => {
  await req.session.destroy(); // Destroy saved userId

  res.status(200);
  res.json({
    message: 'Logged out successfully.',
  });
});

app.get('/api/me', async (req: any, res: any) => {
  if (req.user) {
    res.status(200);
  } else {
    res.status(404);
  }

  res.json(req.user);
});

// User submits or updates disposition
app.post('/api/submit/:ticId', async (req: any, res: any) => {
  if (req.user) {
    const { disposition, comments } = req.body;

    if (!disposition) {
      res.status(400);
      res.json({ message: 'Malformed request.' });
      return;
    }

    try {
      let fileId = 'tic:' + req.params.ticId;
      let file = await db.get(fileId);

      if (file.dispositions) file.dispositions[req.session.userId] = { disposition: disposition, comments: comments };
      else {
        let dispositions: { [key: string]: any } = {};
        dispositions[req.session.userId] = { disposition: disposition, comments: comments };
        file.dispositions = dispositions;
      }

      if (!req.user.tics.includes(req.params.ticId)) {
        req.user.tics.push(req.params.ticId);
        db.insert(req.user);
      }

      db.insert(file);
      res.status(200);
      res.json({ message: 'Success' });
    } catch (e) {
      res.status(400);
      res.json({ message: 'The request TIC could not be found.' });
    }
  } else {
    res.status(401);
    res.json({ message: 'You are not signed in.' });
  }
});

app.get('/api/unanswered-tics', async (req: any, res: any) => {
  if (req.user) {
    let ticList = await db.partitionedList('tic', { include_docs: true });
    let ticArr = [];

    for (let tic of ticList.rows) {
      let id = tic.id.split(':')[1];
      if (!req.user.tics.includes(id)) ticArr.push(id);
    }

    res.json({ list: ticArr });
    res.status(200);
  } else {
    res.status(401);
    res.json({ message: 'You are not signed in.' });
  }
});

app.get('/api/tic/:ticId', async (req: any, res: any) => {
  try {
    const tic = await db.get('tic:' + req.params.ticId);

    let dispositionsRealName: {}[] = [];

    await asyncForEach(Object.keys(tic.dispositions), async (key: string) => {
      let name = '';
      try {
        const nameDoc = await db.get(key);
        name = nameDoc.name;
      } catch {
        return;
      }

      dispositionsRealName.push({ disposition: tic.dispositions[key].disposition, comments: tic.dispositions[key].comments, name: name });
    });

    tic.dispositions = dispositionsRealName;

    res.json(tic);
    res.status(200);
  } catch {
    res.status(404);
    res.json({ message: 'The request TIC could not be found.' });
  }
});

app.get('/api/pdfs/:ticId', (req: any, res: any) => {
  drive.files.list(
    {
      q: `name contains '${req.params.ticId}' and '1A6NKNFKZcx_i7WHdBsFDj_io3x70GMxi' in parents and mimeType = 'application/pdf'`,
      pageSize: 10,
      fields: 'nextPageToken, files(id, webContentLink, name)',
    },
    (err: any, driveRes: any) => {
      if (err) return console.error('The API returned an error: ' + err);

      const files = driveRes.data.files;

      console.log(files);

      if (files.length) {
        res.json(files);
        res.status(200);
      } else {
        res.json({ message: 'No files found. ' });
        res.status(404);
      }
    }
  );
});

app.get('/*', (_req: any, res: any) => {
  res.sendFile(INDEX_FILE, { DIST_DIR });
});

// Cors Anywhere Proxy Middleware
async () => {
  await new Promise((resolve) => app.use('/api/proxy/*', anywhere()).listen(port, resolve));
};

async function asyncForEach(array: any[], callback: Function) {
  for (let index = 0; index < array.length; index++) {
    await callback(array[index], index, array);
  }
}
