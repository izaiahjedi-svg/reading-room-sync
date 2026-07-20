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

app.use(express.json({ limit: '200mb' }));
app.use(express.static(__dirname));

function slugifyBookName(name) {
  return (name || '')
    .toString()
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function matchesBookSlug(bookName, slug) {
  return !!slug && slugifyBookName(bookName) === slug;
}

function emptyLibrarySlice(baseData) {
  return {
    version: (baseData && baseData.version) || 1,
    exportedAt: (baseData && baseData.exportedAt) || Date.now(),
    index: [],
    chapters: {},
    progress: (baseData && baseData.progress) || { lastChapterId: null, percents: {} },
    settings: (baseData && baseData.settings) || {},
    booksMeta: {},
  };
}

function sliceLibraryByBook(data, slug) {
  if (!data || !slug) return data || null;
  const slice = emptyLibrarySlice(data);
  const index = Array.isArray(data.index) ? data.index : [];
  const matching = index.filter((entry) => matchesBookSlug(entry && entry.book, slug));
  slice.index = matching;
  for (const entry of matching) {
    if (data.chapters && data.chapters[entry.id]) {
      slice.chapters[entry.id] = data.chapters[entry.id];
    }
  }
  const meta = data.booksMeta || {};
  for (const key of Object.keys(meta)) {
    if (matchesBookSlug(key, slug)) slice.booksMeta[key] = meta[key];
  }
  return slice;
}

function mergeBookSlice(existing, incoming, slug) {
  const base = existing && typeof existing === 'object' ? existing : {};
  const next = {
    version: incoming && incoming.version ? incoming.version : (base.version || 1),
    exportedAt: incoming && incoming.exportedAt ? incoming.exportedAt : Date.now(),
    index: Array.isArray(base.index) ? [...base.index] : [],
    chapters: Object.assign({}, base.chapters || {}),
    progress: incoming && incoming.progress ? incoming.progress : (base.progress || { lastChapterId: null, percents: {} }),
    settings: incoming && incoming.settings ? incoming.settings : (base.settings || {}),
    booksMeta: Object.assign({}, base.booksMeta || {}),
  };

  const incomingIndex = Array.isArray(incoming && incoming.index) ? incoming.index : [];
  const incomingIds = new Set(incomingIndex.map((entry) => entry && entry.id).filter(Boolean));

  const existingBookEntries = next.index.filter((entry) => matchesBookSlug(entry && entry.book, slug));
  next.index = next.index.filter((entry) => !matchesBookSlug(entry && entry.book, slug));

  // Only remove chapter blobs that were explicitly removed from the incoming index.
  for (const entry of existingBookEntries) {
    if (entry && entry.id && !incomingIds.has(entry.id)) delete next.chapters[entry.id];
  }

  const incomingMeta = (incoming && incoming.booksMeta) || {};
  const shouldReplaceBookMeta = incomingIndex.length === 0 || Object.keys(incomingMeta).length > 0;
  if (shouldReplaceBookMeta) {
    for (const key of Object.keys(next.booksMeta)) {
      if (matchesBookSlug(key, slug)) delete next.booksMeta[key];
    }
  }

  next.index.push(...incomingIndex);
  // Preserve existing chapter content for incoming index IDs if client omitted some chapter bodies.
  for (const entry of existingBookEntries) {
    if (entry && entry.id && incomingIds.has(entry.id) && !((incoming && incoming.chapters) || {})[entry.id]) {
      const existingChapter = (base.chapters || {})[entry.id];
      if (existingChapter) next.chapters[entry.id] = existingChapter;
    }
  }
  Object.assign(next.chapters, (incoming && incoming.chapters) || {});
  Object.assign(next.booksMeta, (incoming && incoming.booksMeta) || {});
  return next;
}

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
  const bookSlug = (req.query.book || '').trim().toLowerCase();
  if (!key) return res.status(400).json({ error: 'Missing sync key' });

  let data = readKeyData(key);
  if (!data) {
    const legacy = readLegacyValue(key);
    if (legacy) {
      writeKeyData(key, legacy);
      data = legacy;
    }
  }
  if (bookSlug) return res.json({ data: sliceLibraryByBook(data, bookSlug) });
  res.json({ data: data || null });
});

app.post('/api/library', (req, res) => {
  const key = (req.headers['x-sync-key'] || '').toString().trim();
  const bookSlug = (req.headers['x-book-slug'] || '').toString().trim().toLowerCase();
  if (!key) return res.status(400).json({ error: 'Missing sync key' });
  if (bookSlug) {
    const existing = readKeyData(key) || readLegacyValue(key) || {};
    const merged = mergeBookSlice(existing, req.body || {}, bookSlug);
    writeKeyData(key, merged);
    return res.json({ ok: true, scoped: true });
  }
  writeKeyData(key, req.body || {});
  res.json({ ok: true });
});

app.get('/webapp/:bookSlug/reader.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'webapp', 'reader.html'));
});

app.listen(port, () => {
  console.log('Reader server listening on port', port);
});
