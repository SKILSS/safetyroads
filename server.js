// server.js
// UrbanRoads proxy + aggregator
// npm i express axios multer dotenv cors express-rate-limit fs-extra

require('dotenv').config();
const express = require('express');
const axios = require('axios');
const multer = require('multer');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const fs = require('fs-extra');
const path = require('path');

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
fs.ensureDirSync(DATA_DIR);

const LOCAL_DB = path.join(DATA_DIR, 'local_reports.json');
const REMOTE_DB = path.join(DATA_DIR, 'remote_reports.json');

// Config from env
const DEEPSEEK_API_URL = process.env.DEEPSEEK_API_URL || ''; // base url e.g. https://api.deepseek.example
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || '';
const FEED_URLS = (process.env.FEEDS || 'public/mock_feed.json').split(',').map(s => s.trim()).filter(Boolean);
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS) || 30_000;
const REMOVE_ON_RESOLVED = (process.env.REMOVE_ON_RESOLVED || 'true') === 'true';
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '*').split(',');

// Basic middlewares
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cors({
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);
    if (ALLOWED_ORIGINS.includes('*') || ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
    return callback(new Error('Not allowed by CORS'));
  }
}));
app.use(rateLimit({ windowMs: 60 * 1000, max: 120 }));

// serve frontend
app.use('/', express.static(PUBLIC_DIR));

// helpers: read/write JSON DB
async function readJson(filePath, fallback = {}) {
  try { return await fs.readJson(filePath); } catch (e) { return fallback; }
}
async function writeJson(filePath, data) {
  await fs.writeJson(filePath, data, { spaces: 2 });
}

// initialize DB files if absent
(async () => {
  if (!await fs.pathExists(LOCAL_DB)) await writeJson(LOCAL_DB, {});
  if (!await fs.pathExists(REMOTE_DB)) await writeJson(REMOTE_DB, {});
})();

// Merge local + remote reports for client
app.get('/api/reports', async (req, res) => {
  try {
    const local = await readJson(LOCAL_DB, {});
    const remote = await readJson(REMOTE_DB, {});
    // simple merge: local then remote, avoid duplicate sourceId
    const merged = {};
    Object.values(remote).forEach(r => { if (r && r.sourceId) merged[r.sourceId] = r; });
    Object.values(local).forEach(r => { if (r && r.id) merged[r.id] = r; });
    // filter out resolved
    const items = Object.values(merged).filter(r => !r.status || r.status.toLowerCase() !== 'resolved');
    res.json({ ok: true, count: items.length, results: items });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: String(err) });
  }
});

// Add a new local report (client posts JSON; photo not stored on server in this MVP)
app.post('/api/reports', async (req, res) => {
  try {
    const payload = req.body;
    if (!payload) return res.status(400).json({ ok:false, error: 'No payload' });
    // create id
    const id = 'local_' + Date.now() + '_' + Math.floor(Math.random()*1000);
    const record = Object.assign({}, payload, { id, createdAt: new Date().toISOString(), source: 'local' });
    const db = await readJson(LOCAL_DB, {});
    db[id] = record;
    await writeJson(LOCAL_DB, db);
    return res.json({ ok: true, report: record });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok:false, error: String(err) });
  }
});

// Delete local report
app.delete('/api/reports/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const db = await readJson(LOCAL_DB, {});
    if (db[id]) delete db[id];
    await writeJson(LOCAL_DB, db);
    return res.json({ ok: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok:false, error: String(err) });
  }
});

// Proxy search to Deepseek (text search) — adapt pathSuffix to real Deepseek API
app.post('/api/deepseek/search', async (req, res) => {
  if (!DEEPSEEK_API_URL || !DEEPSEEK_API_KEY) return res.status(501).json({ ok:false, error: 'Deepseek not configured on server' });
  try {
    const body = req.body || {};
    // Example: POST to /search on Deepseek — adapt to real docs
    const resp = await axios.post(`${DEEPSEEK_API_URL.replace(/\/$/, '')}/search`, body, {
      headers: { Authorization: `Bearer ${DEEPSEEK_API_KEY}`, 'Content-Type': 'application/json' },
      timeout: 30000
    });
    return res.json({ ok: true, data: resp.data });
  } catch (err) {
    console.error('Deepseek search error', err?.response?.data || err.message);
    return res.status(502).json({ ok:false, error: err?.response?.data || err.message });
  }
});

// Accept image verification (proxy) — if Deepseek supports binary images
app.post('/api/deepseek/verify-photo', upload.single('photo'), async (req, res) => {
  if (!DEEPSEEK_API_URL || !DEEPSEEK_API_KEY) return res.status(501).json({ ok:false, error: 'Deepseek not configured' });
  if (!req.file || !req.file.buffer) return res.status(400).json({ ok:false, error: 'photo required' });

  try {
    // Placeholder: many APIs accept binary upload; adapt this to Deepseek's image endpoint
    const url = `${DEEPSEEK_API_URL.replace(/\/$/, '')}/image/analyze`;
    const resp = await axios.post(url, req.file.buffer, {
      headers: { Authorization: `Bearer ${DEEPSEEK_API_KEY}`, 'Content-Type': 'application/octet-stream' },
      timeout: 60000
    });
    return res.json({ ok:true, data: resp.data });
  } catch (err) {
    console.error('Deepseek image error', err?.response?.data || err.message);
    return res.status(502).json({ ok:false, error: err?.response?.data || err.message });
  }
});

// manual trigger for feeds fetch
app.get('/api/feeds/fetch', async (req, res) => {
  try {
    await fetchAllFeeds();
    return res.json({ ok:true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok:false, error: String(err) });
  }
});

// fetch feeds, normalize, and store to REMOTE_DB
async function fetchAllFeeds() {
  const remoteDb = await readJson(REMOTE_DB, {});
  for (const url of FEED_URLS) {
    try {
      let fetchUrl = url;
      // If feed refers to relative public/mock_feed.json — serve static
      if (fetchUrl.startsWith('public/')) {
        fetchUrl = 'http://localhost:' + PORT + '/' + fetchUrl.replace(/^public\//,'');
      }
      const resp = await axios.get(fetchUrl, { timeout: 20000 });
      const data = resp.data;
      // Expect data.reports = []
      if (!Array.isArray(data.reports)) continue;
      for (const r of data.reports) {
        const key = r.sourceId || ('remote_' + (r.id || Date.now() + Math.floor(Math.random()*1000)));
        // if resolved and configured to remove -> delete
        if (REMOVE_ON_RESOLVED && r.status && String(r.status).toLowerCase() === 'resolved') {
          if (remoteDb[key]) delete remoteDb[key];
          continue;
        }
        // normalize record
        const rec = Object.assign({}, r, { _fetchedAt: new Date().toISOString() });
        remoteDb[key] = rec;
      }
    } catch (err) {
      console.warn('Feed fetch failed', url, err?.message || err);
    }
  }
  await writeJson(REMOTE_DB, remoteDb);
}

// initial fetch
fetchAllFeeds().catch(e => console.warn('initial fetch failed', e));

// schedule periodic polling
setInterval(() => {
  fetchAllFeeds().catch(e => console.warn('scheduled fetch failed', e));
}, POLL_INTERVAL_MS);

// start server
app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
  console.log(`Public files served from ./public — open http://localhost:${PORT}`);
});