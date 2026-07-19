const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const port = process.env.PORT || 3000;
const dataDir = path.join(__dirname, '.data');
const keyDir = path.join(dataDir, 'keys');
const legacyDataFile = path.join(dataDir, 'library.json');

if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
if (!fs.existsSync(keyDir)) fs.mkdirSync(keyDir, { recursive: true });

app.use(express.json({ limit: '40mb' }));
app.use(express.static(__dirname));

function keyFilePath(key) {
  const digest = crypto.createHash('sha256').update(key).digest('hex');
  return path.join(keyDir, digest + '.json');
}

function readKeyData(key) {
  const p = keyFilePath(key);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    console.warn('Failed to parse key store', e.message);
    return null;
  }
}

function writeKeyData(key, value) {
  const p = keyFilePath(key);
  fs.writeFileSync(p, JSON.stringify(value || {}), 'utf8');
}

function readLegacyValue(key) {
  if (!fs.existsSync(legacyDataFile)) return null;
  try {
    const stat = fs.statSync(legacyDataFile);
    // Skip legacy migration if old monolithic store is too large for safe parse.
    if (stat.size > 32 * 1024 * 1024) {
      console.warn('Skipping legacy store migration due to file size > 32MB');
      return null;
    }
    const oldStore = JSON.parse(fs.readFileSync(legacyDataFile, 'utf8'));
    return oldStore[key] || null;
  } catch (e) {
    console.warn('Legacy store read failed', e.message);
    return null;
  }
}

app.get('/api/library', (req, res) => {
  const key = (req.query.key || '').trim();
  if (!key) return res.status(400).json({ error: 'Missing sync key' });

  let data = readKeyData(key);
  if (!data) {
    const legacy = readLegacyValue(key);
    if (legacy) {
      writeKeyData(key, legacy);
      data = legacy;
    }
  }
  res.json({ data: data || null });
});

app.post('/api/library', (req, res) => {
  const key = (req.headers['x-sync-key'] || '').toString().trim();
  if (!key) return res.status(400).json({ error: 'Missing sync key' });
  writeKeyData(key, req.body || {});
  res.json({ ok: true });
});

app.listen(port, () => {
  console.log('Reader server listening on port', port);
});
