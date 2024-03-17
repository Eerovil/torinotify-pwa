import bodyParser from 'body-parser';
import express from 'express';
import morgan from 'morgan';
import path from 'path';
import webPush from 'web-push';
import secrets from './secrets.js';
import { JsonDB, Config } from 'node-json-db';
import { parse } from 'node-html-parser';
import axios from 'axios';

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
  const html = await response.data;
  const root = parse(html);
  const beta = !root.querySelector('#beta');
  const ret = {
    description: root.querySelector('meta[name="description"]').getAttribute('content'),
    location: '',
  };
  if (beta) {
    const view = root.querySelector('div.nohistory.private');
    if (view) {
      // Split by newlines
      const lines = view.text.split('\n').filter((line) => line.trim() != '');
      const lastLine = lines[lines.length - 1];
      ret['location'] = lastLine;
    }
    const itemPropDescription = root.querySelector('div[itemprop="description"]');
    if (itemPropDescription) {
      ret['description'] = (itemPropDescription.text || '').trim();
    }
  } else {
    const description = root.querySelector('#body');
    ret['location'] = '';
  }
  return ret;
}

function parseRow(rowElement, beta = false) {
  const ret = {
    url: rowElement.getAttribute('href'),
  };
  // Id is in URL: "xxxxxx.htm" where xxxxxx is the id in digits
  const id = ret.url.match(/(\d+).htm/)[1];
  Object.assign(ret, {id});
  if (beta) {
    Object.assign(ret, {
      thumbnail: rowElement.querySelector('img').getAttribute('src'),
      title: rowElement.querySelector('.li-title').text,
      price: parsePrice(rowElement.querySelector('.list_price').text),
    });
    return ret;
  }
  Object.assign(ret, {
    thumbnail: rowElement.querySelector('img.thumb').getAttribute('src'),
    title: rowElement.querySelector('.listing-row-title').text,
    price: parsePrice(rowElement.querySelector('.row-price').text),
  });
  return ret;
}

async function axiosGetPage(url) {
  return await axios.get(url, {
    responseEncoding: "latin1",
    headers: {
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Accept-Encoding': 'gzip, deflate, br',
      'Accept-Language': 'en-US,en;q=0.5',
      'Cache-Control': 'max-age=0',
      'Connection': 'keep-alive',
      'Host': 'www.tori.fi',
      'Upgrade-Insecure-Requests': '1',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/58.0.3029.110 Safari/537.3'
    }
  });
}

async function updateWatcher(watcher) {
  const url = watcher.url;
  // const response = await fetch(url);
  // Fetch with utf-8 encoding
  if (!url) {
    return watcher;
  }
  console.log('Fetching:', url);
  const response = await axiosGetPage(url);
  const html = await response.data;
  const root = parse(html);
  let newRows = root.querySelectorAll('.row-href');
  let beta = false;
  if (newRows.length == 0) {
    console.debug('No rows found using old, using beta mode');
    beta = true;
    newRows = root.querySelectorAll('.item_row_flex');
  }
  const minPrice = watcher.minPrice || 0;
  const maxPrice = watcher.maxPrice || 1000000;
  const mustMatch = watcher.mustMatch || null;
  const mustNotMatch = watcher.mustNotMatch || null;
  watcher.rows = watcher.rows || {};
  for (const row of newRows) {
    try {
      let match = true;
      const {id, url, thumbnail, title, price} = parseRow(row, beta);
      const oldData = watcher.rows[id] || {};
      const isNew = !oldData.url;
      if (price < minPrice || price > maxPrice) {
        match = false;
      }
      watcher.rows[id] = {...oldData, id, url, thumbnail, title, price};
      if (match && !oldData.description) {
        const {description, location} = await parseItem(url);
        watcher.rows[id].description = description;
        watcher.rows[id].location = location;
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
      if (!watcher.rows[id].createdAt) {
        watcher.rows[id].createdAt = new Date().toISOString();
      }
    } catch (error) {
      console.log('Error parsing row:', error);
    }
  }
  // Sort rows by id reversed (newest first) NOTE It's an object
  // Max amount of rows is 100
  const sortedKeys = Object.keys(watcher.rows).sort((a, b) => parseInt(b) - parseInt(a)).slice(0, 100);
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
