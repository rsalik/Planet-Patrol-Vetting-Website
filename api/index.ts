const express = require('express');
const app = express();
const path = require('path');

const port = process.env.PORT || 3000;

// load environment variables from .env if not in production
if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config();
}

// Google Drive Libraries for Tic Files
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

var session = require('cookie-session');

// Express session settings
let sess = {
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: true,
  },
};

app.set('trust proxy', 1); // Trust first proxy

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

// Get the TIC list periodically (probably won't update too much).

// Get user data
app.post('/api/auth/google', async (req: any, res: any) => {
  const { token } = req.body;

  if (!token) {
    res.status(400).send('No token provided.');
    return;
  }

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
    user = { _id: userId, name: name };
    db.insert(user);
  }

  // Save userId for later API calls
  req.session.userId = userId;

  res.status(200);
  res.json(user);
});

// Logout
app.delete('/api/auth/logout', async (req: any, res: any) => {
  req.session = null; // Destroy saved userId

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
    const { disposition, comments, group } = req.body;

    if (!disposition) {
      res.status(400);
      res.json({ message: 'Malformed request.' });
      return;
    }

    try {
      let fileId = 'tic:' + req.params.ticId;
      let file = await db.get(fileId);

      let key = req.session.userId;

      if (group) {
        if (req.user.group) key = 'user:group';
        else {
          res.status(403);
          res.json({ message: 'You do not have permission to submit as group.' });
        }
      }

      if (file.dispositions) file.dispositions[key] = { disposition: disposition, comments: comments };
      else {
        let dispositions: { [key: string]: any } = {};
        dispositions[key] = { disposition: disposition, comments: comments };
        file.dispositions = dispositions;
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

app.get('/api/all-tics', async (req: any, res: any) => {
  try {
    res.json(ticList);
    res.status(200);
  } catch {
    res.status(500);
    res.json({ message: 'An error occurred.' });
  }
});

app.get('/api/answered-tics', async (req: any, res: any) => {
  if (req.user) {
    let unansweredTics = [];
    let answeredTics = [];

    for (let tic of ticList) {
      let id = tic.id.split(':')[1];
      if (tic.doc.dispositions && tic.doc.dispositions[req.session.userId])
        answeredTics.push({ id, length: Object.keys(tic.doc.dispositions).length });
      else unansweredTics.push({ id, length: Object.keys(tic.doc.dispositions).length });
    }

    res.json({ unanswered: unansweredTics, answered: answeredTics });
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

      dispositionsRealName.push({
        disposition: tic.dispositions[key].disposition,
        comments: tic.dispositions[key].comments,
        name: name,
        _id: key,
      });
    });

    tic.dispositions = dispositionsRealName;

    res.json(tic);
    res.status(200);
  } catch {
    res.status(404);
    res.json({ message: 'The request TIC could not be found.' });
  }
});

app.get('/api/files/:ticId', async (req: any, res: any) => {
  const files = await getTicFiles(req.params.ticId);

  if (files.length) {
    res.json(files);
    res.status(200);
  } else {
    res.json({ message: 'No files found. ' });
    res.status(404);
  }
});

app.get(['/api/csv', '/api/csv/all'], async (req: any, res: any) => {
  let tics = ticList;
  let all = req.url.includes('all');

  let csv =
    'TIC ID,ExoFOP-TESS,Sectors,Epoch [BJD],Period [Days],Duration [Hours],Depth [ppm],Depth [%],Rtranister [RJup],Rstar [RSun],Tmag,Delta Tmag,Paper disp (LC),Paper comm\n';

  tics.forEach((tic: any) => {
    if (!all && !tic.doc.dispositions['user:paper']) return;

    let ticId = tic.id.split(':')[1];

    let newLine = [
      ticId,
      `https://exofop.ipac.caltech.edu/tess/target.php?id=${ticId.replace(/\([\s\S]*?\)/g, '')}`,
      `"${tic.doc.sectors}"`,
      `"${tic.doc.epoch}"`,
      `"${tic.doc.period}"`,
      `"${tic.doc.duration}"`,
      `"${tic.doc.depth}"`,
      `"${tic.doc.depthPercent}"`,
      `"${tic.doc.rTranister}"`,
      `"${tic.doc.rStar}"`,
      `"${tic.doc.tmag}"`,
      `"${tic.doc.deltaTmag}"`,
      `"${tic.doc.dispositions['user:paper'] ? tic.doc.dispositions['user:paper'].disposition : ''}"`,
      `"${tic.doc.dispositions['user:paper'] ? tic.doc.dispositions['user:paper'].comments : ''}"`,
    ].join(',');
    csv += newLine + '\n';
  });

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename=planet-patrol-dispositions${all ? '-all' : ''}.csv`);
  res.status(200);
  res.send(csv);
});

async function getTicFiles(ticId: string) {
  let files = [] as any[];
  for await (let folder of folderList) {
    let newFiles = await getTicFilesFromFolder(ticId, folder.id);
    if (newFiles) files = files.concat(newFiles);
  }

  return files;
}

function getTicFilesFromFolder(ticId: string, folderId: string) {
  return new Promise((resolve, reject) => {
    drive.files.list(
      {
        q: `'${folderId}' in parents and name contains '${ticId}' and mimeType != 'application/vnd.google-apps.folder'`,
        pageSize: 1000,
        fields: 'nextPageToken, files(id, webContentLink, name, mimeType)',
      },
      async (err: any, driveRes: any) => {
        if (err) reject(console.error(err));

        let files = driveRes.data.files;

        if (driveRes.data.nextPageToken) {
          files = files.concat(await getTicFilesFromFolder(ticId, folderId));
        }

        resolve(files);
      }
    );
  });
}

let folderList: any[] = [];
async function recursiveGetSubfolders(folderId: string, pageToken?: string) {
  return new Promise((resolve, reject) => {
    let folderIds: any[] = [];

    drive.files.list(
      {
        q: `'${folderId}' in parents and mimeType = 'application/vnd.google-apps.folder'`,
        pageSize: 1000,
        fields: 'nextPageToken, files(id, webContentLink, name, mimeType)',
        pageToken: pageToken,
      },
      async (err: any, driveRes: any) => {
        if (err) {
          console.error('The API returned an error: ' + err);
          reject(err);
        }

        if (driveRes.data.nextPageToken) {
          folderIds = folderIds.concat(await recursiveGetSubfolders(folderId, driveRes.data.nextPageToken));
        }

        for await (const file of driveRes.data.files) {
          // Skip TIC-specific folders
          /*if (file.name.match(/^\d+$/)) {
            continue;
          }*/

          folderIds = folderIds.concat(await recursiveGetSubfolders(file.id));
        }

        folderIds = folderIds.concat(driveRes.data.files);
        resolve(folderIds);
      }
    );
  });
}

app.get('/*', (_req: any, res: any) => {
  res.sendFile(INDEX_FILE, { DIST_DIR });
});

app.listen(port);

async function getTicList() {
  let newTicList: any[] = [];
  let pList: any = {};

  do {
    try {
      await new Promise((r) => setTimeout(r, 1000)); // Prevent rate limiting
      let startKey = newTicList[newTicList.length - 1]?.id || null;

      if (startKey) pList = await db.partitionedList('tic', { include_docs: true, startkey: `${startKey}\0` });
      else pList = await db.partitionedList('tic', { include_docs: true });
      newTicList = newTicList.concat(pList.rows);
    } catch (e) {
      console.error(e);
      console.error('getTicList failed, retrying in 5 seconds.');
      setTimeout(getTicList, 5000);
      return;
    }
  } while (newTicList.length < pList.total_rows);

  ticList = newTicList;
  console.log('Successfully fetched ticList.');
  return ticList;
}

async function updateFolderList() {
  folderList = (await recursiveGetSubfolders('1Z74BU-ijJy710QA3M9YwE_l1cE_dpSHA')) as [];
  console.log('Got folder list');
}

updateFolderList();
setInterval(updateFolderList, 60 * 60 * 1000 /* 60 minutes */);

let ticList: any[] = [];
getTicList();
setInterval(getTicList, 5 * 60 * 1000 /* 5 minutes */);

async function asyncForEach(array: any[], callback: Function) {
  for (let index = 0; index < array.length; index++) {
    await callback(array[index], index, array);
  }
}
