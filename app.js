import bodyParser from 'body-parser';
import express from 'express';
import morgan from 'morgan';
import path from 'path';
import webPush from 'web-push';
import secrets from './secrets.js';
import { JsonDB, Config } from 'node-json-db';
import { parse } from 'node-html-parser';
import axios from 'axios';
import https from 'https';

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
try {
  await db.getData("/watchers");
} catch (error) {
  await db.push("/watchers", {});
}

const app = express();
const port = process.env.PORT || 3000;

app.use(bodyParser.json());
app.set('views', path.resolve('views'));
app.use(morgan('dev'));
app.use(express.static('public'));

// TODO: Generate VAPID keys (e.g. https://vapidkeys.com/)
const vapid = secrets;

webPush.setVapidDetails(
  vapid.subject,
  vapid.publicKey,
  vapid.privateKey
);

function login(authorization) {
  const split = authorization.split(':');
  if (split.length !== 2) return false;
  const username = split[0];
  const password = split[1];
  console.log('Login attempt:', username, password);
  if (password != secrets.password) {
    return false;
  }
  if (!users.find((u) => u.username === username)) {
    return false;
  }
  return true;
}

app.post('/subscribe', async (req, res) => {
  if (!login(req.headers.authorization)) {
    return res.status(401).end();
  }
  const sub = req.body;
  if (!sub.endpoint) {
    console.log('Invalid subscription:', sub);
    res.json({vapidPublicKey: vapid.publicKey});
    return res.status(200).end();
  }
  sub.username = req.headers.authorization.split(':')[0];
  console.log('New subscription:', sub.endpoint);
  const subscriptions = await db.getData("/subscriptions");
  // If the subscription is already in the db, don't add it again
  if (subscriptions.find((s) => s.endpoint === sub.endpoint)) {
    return res.status(200).end();
  }
  db.push("/subscriptions[]", sub);
  res.status(200).end();
});

async function getNewId(dbPath) {
  const watchers = await db.getData(dbPath);
  let maxId = 0;
  for (const id in watchers) {
    if (parseInt(id) > maxId) {
      maxId = parseInt(id);
    }
  }
  return maxId + 1;
}

app.post('/api/watchers', async (req, res) => {
  if (!login(req.headers.authorization)) {
    return res.status(401).end();
  }
  // Find max id and increment
  const newId = await getNewId('/watchers');
  await db.push(`/watchers/${newId}`, {id: newId, rows: {}, ...req.body});
  // Return the new watcher
  res.json(await db.getData(`/watchers/${newId}`));
  res.status(200).end();
});

app.get('/api/watchers', async (req, res) => {
  if (!login(req.headers.authorization)) {
    return res.status(401).end();
  }
  const username = req.headers.authorization.split(':')[0];
  const ret = {};
  const allWatchers = await db.getData("/watchers");
  for (const watcher of Object.values(allWatchers)) {
    if (!watcher) {continue}
    if (watcher.username == username) {
      ret[watcher.id] = watcher;
    }
  }
  res.json(ret);
  res.status(200).end();
});

app.patch('/api/watchers/:id', async (req, res) => {
  if (!login(req.headers.authorization)) {
    return res.status(401).end();
  }
  const id = req.params.id;
  const watcher = await db.getData(`/watchers/${id}`);
  if (watcher.username != req.headers.authorization.split(':')[0]) {
    return res.status(401).end();
  }
  db.push(`/watchers/${id}`, {...watcher, ...req.body});
  res.json(await db.getData(`/watchers/${id}`));
  res.status(200).end();
});

app.delete('/api/watchers/:id', async (req, res) => {
  if (!login(req.headers.authorization)) {
    return res.status(401).end();
  }
  const id = req.params.id;
  const watcher = await db.getData(`/watchers/${id}`);
  if (watcher.username != req.headers.authorization.split(':')[0]) {
    return res.status(401).end();
  }
  db.delete(`/watchers/${id}`);
  res.status(200).end();
});

app.get('/api/watchers/:id', async (req, res) => {
  if (!login(req.headers.authorization)) {
    return res.status(401).end();
  }
  const id = req.params.id;
  const watcher = await db.getData(`/watchers/${id}`);
  if (watcher.username != req.headers.authorization.split(':')[0]) {
    return res.status(401).end();
  }
  const updatedWatcher = await updateWatcher(watcher);
  await db.push(`/watchers/${id}`, updatedWatcher);
  res.json(watcher);
  res.status(200).end();
});

async function pushNotification(username, payload) {

  const subscriptions = await db.getData("/subscriptions");
  console.log("subscriptions", subscriptions)
  await Promise.all(subscriptions.filter(sub => sub.username == username).map(async (sub) => {
    console.log('Sending notification to user', sub.username, sub.endpoint);
    try {
      await webPush.sendNotification(sub, payload); // throws if not successful
    } catch (err) {
      console.log(sub.endpoint, '->', err.message);
      // TODO: Delete subscription (e.g. from db)
      console.log(err)
    }
  }));
}

function parsePrice(priceText) {
  // Convert 1 500 € -> 1500
  // 180 € -> 180
  // 1 500 000 € -> 1500000
  return parseInt(priceText.replace(/ /g, '').replace('€', ''));
}

async function parseItem(itemUrl) {
  // Get description and location
  const response = await axiosGetPage(itemUrl);
  if (!response) {
    return {description: '', location: ''};
  }
  const html = await response.data;
  const root = parse(html);
  const ret = {
    description: root.querySelector('meta[name="description"]').getAttribute('content'),
  };
  const itemPropDescription = root.querySelector('.about-section .whitespace-pre-wrap');
  if (itemPropDescription) {
    ret['description'] = (itemPropDescription.text || '').trim();
  }
  return ret;
}

function parseRow(rowElement) {
  console.log('Parsing row', rowElement.text);
  const ret = {
    url: rowElement.querySelector('a').getAttribute('href'),
  };
  const id = ret.url.split('/').filter(Boolean).pop()
  Object.assign(ret, {id});
  const imgEl = rowElement.querySelector('img');
  const date = ((rowElement.querySelector('.s-text-subtle span:nth-child(1)') || {}).text || '').trim();
  let parsedDate;
  try {
    if (date.includes('.')) {
      const [day, month, year] = date.split('.');
      parsedDate = new Date(`${year}-${month}-${day}`);
    }
    if (isNaN(parsedDate)) {
      parsedDate = new Date();
    }
  } catch (error) {
    console.log('Error parsing date:', date);
    parsedDate = new Date();
  }
  console.log('Parsed date:', parsedDate)
  Object.assign(ret, {
    thumbnail: imgEl ? imgEl.getAttribute('src') : '',
    title: rowElement.querySelector('h2').text,
    price: parsePrice(rowElement.querySelector('.whitespace-nowrap').text),
    location: (rowElement.querySelector('.s-text-subtle span:nth-child(3)') || {}).text,
    createdAt: parsedDate,
  });
  return ret;
}

async function axiosGetPage(url) {
  
  const agent = new https.Agent({  
    rejectUnauthorized: false
  });
  return await axios.get(url, {
    // httpsAgent: agent,
    referrerPolicy: "strict-origin-when-cross-origin",
    headers: {
      'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.9',
      'accept-encoding': 'gzip, deflate, br',
      'accept-language': 'en-US,en;q=0.9',
      'cache-control': 'no-cache',
      'pragma': 'no-cache',
      'sec-ch-ua': '"Chromium";v="94", "Google Chrome";v="94", ";Not A Brand";v="99"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"macOS"',
      'sec-fetch-dest': 'document',
      'sec-fetch-mode': 'navigate',
      'sec-fetch-site': 'none',
      'sec-fetch-user': '?1',
      'upgrade-insecure-requests': '1',
      'cookie': '_sp_su=false; _cmp_marketing=1; _cmp_advertising=1; _cmp_analytics=1; _cmp_personalisation=1; toricmp_store_data=1; toricmp_marketing=1; toricmp_analytics=1; toricmp_personalisation=1; toricmp_purpose3=1; toricmp_purpose4=1; toricmp_purpose6=1; toricmp_vendor_braze=1; toricmp_vendor_pulse=1; toricmp_vendor_hotjar=1; toricmp_vendor_abtasty=1; toricmp_vendor_facebook=1; toricmp_vendor_gar=1; XPD-DECISION=aurora; _pulse2data=%2Cv%2C%2C1710938335628%2C%2C%2C0%2C%2C%2C; bucket=%5B%7B%22name%22%3A%22searchResultLayout%22%2C%22value%22%3A%22grid%22%7D%2C%7B%22name%22%3A%22locationSearchParams%22%2C%22value%22%3A%7B%7D%7D%5D; _pulsesession=%5B%22sdrn%3Aschibsted%3Asession%3A70558bea-c592-435c-b4a0-9d352f35bc0b%22%2C1710937435644%2C1710937461363%5D',
    }
  }).catch(err => {
    console.log('Error fetching page:', url, err);
    return null;
  });
}

async function updateWatcher(watcher) {
  const url = watcher.url;
  // const response = await fetch(url);
  // Fetch with utf-8 encoding
  if (!url) {
    return watcher;
  }
  if (url.includes('m.tori.fi')) {
    return watcher
  }
  console.log('Fetching:', url);
  const response = await axiosGetPage(url);
  if (!response) {
    return watcher;
  }
  const html = await response.data;
  const root = parse(html);
  let newRows = root.querySelectorAll('article');
  const minPrice = watcher.minPrice || 0;
  const maxPrice = watcher.maxPrice || 1000000;
  const mustMatch = watcher.mustMatch || null;
  const mustNotMatch = watcher.mustNotMatch || null;
  watcher.rows = watcher.rows || {};
  const rowsEmpty = Object.keys(watcher.rows).length == 0;
  for (const row of newRows) {
    try {
      let match = true;
      const {id, url, thumbnail, title, price, location, createdAt} = parseRow(row);
      const oldData = watcher.rows[id] || {};
      const isNew = !rowsEmpty && !oldData.url;
      if (price < minPrice || price > maxPrice) {
        match = false;
      }
      watcher.rows[id] = {...oldData, id, url, thumbnail, title, price, location};
      if (match && !oldData.description) {
        const {description} = await parseItem(url);
        watcher.rows[id].description = description;
      }
      if (match) {
        const fullText = `${title} ${watcher.rows[id].description || ''} ${watcher.rows[id].location || ''}`;
        if (mustMatch && !fullText.match(new RegExp(mustMatch, 'i'))) {
          match = false;
        }
        if (mustNotMatch && fullText.match(new RegExp(mustNotMatch, 'i'))) {
          match = false;
        }
      }
      watcher.rows[id].match = match;
      if (isNew && match) {
        pushNotification(watcher.username, `${title} - ${price}€`);
      }
      if (!watcher.rows[id].createdAt || watcher.rows[id].createdAt > new Date()) {
        watcher.rows[id].createdAt = createdAt;
      }
    } catch (error) {
      console.log('Error parsing row:', error);
    }
  }
  // Remove old rows that have "images.tori" in thumbnail
  for (const id in watcher.rows) {
    if (watcher.rows[id].thumbnail.includes('images.tori')) {
      delete watcher.rows[id];
    }
  }

  // Sort rows by id reversed (newest first) NOTE It's an object
  // Max amount of rows is 100
  const sortedKeys = Object.keys(watcher.rows).sort((a, b) => {
    return parseInt(a) - parseInt(b);
  }).slice(0, 100);
  console.log('Sorted keys:', sortedKeys)
  const newRowsObj = {};
  for (const key of sortedKeys) {
    newRowsObj[key] = watcher.rows[key];
  }
  watcher.rows = newRowsObj;

  console.log('Watcher updated:', watcher.id);
  db.push(`/watchers/${watcher.id}`, watcher);
  return watcher;
}

async function updateAllWatchers() {
  for (const watcher of Object.values(await db.getData("/watchers"))) {
    try {
      updateWatcher(watcher);
    } catch (error) {
      console.log('Error updating watcher:', error); 
    }
  }
}

setInterval(updateAllWatchers, 60 * 1000);

// Send test notification every 10 seconds
// setInterval(() => {
//   pushNotification('This is a test notification!');
// }, 10 * 1000);

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});

process.on('SIGTERM', () => {
  process.exit();
});


updateAllWatchers();
