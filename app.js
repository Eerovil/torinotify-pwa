import bodyParser from 'body-parser';
import express from 'express';
import morgan from 'morgan';
import path from 'path';
import webPush from 'web-push';
import secrets from './secrets.js';
import { JsonDB, Config } from 'node-json-db';

var db = new JsonDB(new Config("db", true, true, '/'));
let users;
try {
  users = await db.getData("/users");
} catch (error) {
  db.push("/users[]", {username: "admin"});
  users = await db.getData("/users");
}
// initialize the db subscriptions to empty array if missing
try {
  await db.getData("/subscriptions");
} catch (error) {
  await db.push("/subscriptions", []);
}

const app = express();
const port = process.env.PORT || 3000;

app.use(bodyParser.json());
app.set('views', path.resolve('views'));
app.set('view engine', 'pug');
app.use(morgan('dev'));
app.use(express.static('public'));

// TODO: Generate VAPID keys (e.g. https://vapidkeys.com/)
const vapid = secrets;

webPush.setVapidDetails(
  vapid.subject,
  vapid.publicKey,
  vapid.privateKey
);

app.get('/', (req, res) => {
  res.render('index', { vapidPublicKey: vapid.publicKey });
});

function login(body) {
  const username = body.username;
  const password = body.password;
  console.log('Login attempt:', username, password);
  if (password != secrets.password) {
    return false;
  }
  if (!users.find((u) => u.username === username)) {
    return false;
  }
  delete body.username;
  delete body.password;
  return true;
}

app.post('/subscribe', async (req, res) => {
  if (!login(req.body)) {
    return res.status(401).end();
  }
  const sub = req.body;
  if (!sub.endpoint) {
    console.log('Invalid subscription:', sub);
    return res.status(200).end();
  }
  console.log('New subscription:', sub.endpoint);
  const subscriptions = await db.getData("/subscriptions");
  // If the subscription is already in the db, don't add it again
  if (subscriptions.find((s) => s.endpoint === sub.endpoint)) {
    return res.status(200).end();
  }
  db.push("/subscriptions[]", sub);
  res.status(200).end();
});

async function pushNotification(payload) {
  const subscriptions = await db.getData("/subscriptions");
  console.log("subscriptions", subscriptions)
  console.log('Sending notification to', subscriptions.length, 'subscribers');
  await Promise.all(subscriptions.map(async (sub) => {
    try {
      await webPush.sendNotification(sub, payload); // throws if not successful
    } catch (err) {
      console.log(sub.endpoint, '->', err.message);
      // TODO: Delete subscription (e.g. from db)
    }
  }));
}

// Send test notification every 10 seconds
setInterval(() => {
  pushNotification('This is a test notification!');
}, 10 * 1000);

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});

process.on('SIGTERM', () => {
  process.exit();
});
