const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;
const dataDir = path.join(__dirname, '.data');
const dataFile = path.join(dataDir, 'library.json');

if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
if (!fs.existsSync(dataFile)) fs.writeFileSync(dataFile, JSON.stringify({}), 'utf8');

app.use(express.json({ limit: '50mb' }));
app.use(express.static(__dirname));

function readStore() {
  return JSON.parse(fs.readFileSync(dataFile, 'utf8'));
}

function writeStore(store) {
  fs.writeFileSync(dataFile, JSON.stringify(store, null, 2), 'utf8');
}

app.get('/api/library', (req, res) => {
  const key = (req.query.key || '').trim();
  if (!key) return res.status(400).json({ error: 'Missing sync key' });
  const store = readStore();
  res.json({ data: store[key] || null });
});

app.post('/api/library', (req, res) => {
  const key = (req.headers['x-sync-key'] || '').toString().trim();
  if (!key) return res.status(400).json({ error: 'Missing sync key' });
  const store = readStore();
  store[key] = req.body || {};
  writeStore(store);
  res.json({ ok: true });
});

app.listen(port, () => {
  console.log('Reader server listening on port', port);
});
