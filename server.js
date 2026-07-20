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

function mergeBookSlice(existing, incoming, slug, replaceMode) {
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

  const incomingMeta = (incoming && incoming.booksMeta) || {};
  if (replaceMode) {
    // Replace mode is opt-in and intended for explicit delete operations.
    for (const entry of existingBookEntries) {
      if (entry && entry.id && !incomingIds.has(entry.id)) delete next.chapters[entry.id];
    }
    for (const key of Object.keys(next.booksMeta)) {
      if (matchesBookSlug(key, slug)) delete next.booksMeta[key];
    }
  }

  const mergedBookEntries = replaceMode
    ? incomingIndex
    : (() => {
      const byId = new Map();
      const out = [];
      for (const entry of existingBookEntries) {
        const id = entry && entry.id;
        if (id && !byId.has(id)) {
          byId.set(id, out.length);
          out.push(entry);
        } else if (!id) {
          out.push(entry);
        }
      }
      for (const entry of incomingIndex) {
        const id = entry && entry.id;
        if (id && byId.has(id)) out[byId.get(id)] = entry;
        else {
          if (id) byId.set(id, out.length);
          out.push(entry);
        }
      }
      return out;
    })();

  next.index.push(...mergedBookEntries);
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

function mergeRootLibrary(existing, incoming, replaceMode) {
  const base = existing && typeof existing === 'object' ? existing : {};
  if (replaceMode) return incoming || {};

  const next = {
    version: incoming && incoming.version ? incoming.version : (base.version || 1),
    exportedAt: incoming && incoming.exportedAt ? incoming.exportedAt : Date.now(),
    index: Array.isArray(base.index) ? [...base.index] : [],
    chapters: Object.assign({}, base.chapters || {}),
    progress: incoming && incoming.progress ? incoming.progress : (base.progress || { lastChapterId: null, percents: {} }),
    settings: incoming && incoming.settings ? Object.assign({}, base.settings || {}, incoming.settings) : (base.settings || {}),
    booksMeta: Object.assign({}, base.booksMeta || {}),
  };

  const incomingIndex = Array.isArray(incoming && incoming.index) ? incoming.index : [];
  const incomingChapters = (incoming && incoming.chapters) || {};

  const byId = new Map();
  const mergedIndex = [];
  for (const entry of next.index) {
    const id = entry && entry.id;
    if (id && !byId.has(id)) {
      byId.set(id, mergedIndex.length);
      mergedIndex.push(entry);
    } else if (!id) {
      mergedIndex.push(entry);
    }
  }

  for (const entry of incomingIndex) {
    const id = entry && entry.id;
    if (id && byId.has(id)) mergedIndex[byId.get(id)] = entry;
    else {
      if (id) byId.set(id, mergedIndex.length);
      mergedIndex.push(entry);
    }
  }

  next.index = mergedIndex;
  Object.assign(next.chapters, incomingChapters);
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

function normalizeProfileId(value) {
  const id = (value || '').toString().trim().toLowerCase();
  return id || 'izaiah';
}

function readUnifiedData(key) {
  return readKeyData(key) || readLegacyValue(key) || {};
}

function getProfileState(data, profileId) {
  const pid = normalizeProfileId(profileId);
  const stateProfiles = (data && typeof data.stateProfiles === 'object' && data.stateProfiles) || {};
  const existing = (stateProfiles[pid] && typeof stateProfiles[pid] === 'object') ? stateProfiles[pid] : null;
  const progress = (existing && existing.progress) || data.progress || { lastChapterId: null, percents: {} };
  const settings = (existing && existing.settings) || data.settings || {};
  const updatedAt = (existing && existing.updatedAt) || 0;
  return { profileId: pid, progress, settings, updatedAt };
}

function mergeProfileState(data, profileId, incoming) {
  const base = (data && typeof data === 'object') ? data : {};
  const pid = normalizeProfileId(profileId);
  const stateProfiles = Object.assign({}, (base && base.stateProfiles) || {});
  const prev = (stateProfiles[pid] && typeof stateProfiles[pid] === 'object') ? stateProfiles[pid] : {};
  const next = {
    progress: (incoming && incoming.progress) || prev.progress || { lastChapterId: null, percents: {} },
    settings: (incoming && incoming.settings)
      ? Object.assign({}, prev.settings || {}, incoming.settings)
      : (prev.settings || {}),
    updatedAt: Date.now(),
  };
  stateProfiles[pid] = next;
  return Object.assign({}, base, {
    version: (incoming && incoming.version) || base.version || 1,
    exportedAt: (incoming && incoming.exportedAt) || Date.now(),
    stateProfiles,
  });
}

app.get('/api/library', (req, res) => {
  const key = (req.query.key || '').trim();
  const bookSlug = (req.query.book || '').trim().toLowerCase();
  const metaOnly = (req.query.meta || '').trim() === '1';
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
  if (metaOnly && data) {
    const meta = emptyLibrarySlice(data);
    meta.index = Array.isArray(data.index) ? data.index : [];
    meta.progress = (data && data.progress) || meta.progress;
    meta.settings = (data && data.settings) || meta.settings;
    meta.booksMeta = (data && data.booksMeta) || {};
    return res.json({ data: meta });
  }
  res.json({ data: data || null });
});

app.get('/api/state', (req, res) => {
  const key = (req.query.key || '').toString().trim();
  const profileId = normalizeProfileId(req.query.profile || 'izaiah');
  if (!key) return res.status(400).json({ error: 'Missing sync key' });
  const data = readUnifiedData(key);
  return res.json({ data: getProfileState(data, profileId) });
});

app.post('/api/state', (req, res) => {
  const key = (req.headers['x-sync-key'] || '').toString().trim();
  const profileId = normalizeProfileId(req.headers['x-profile-id'] || 'izaiah');
  if (!key) return res.status(400).json({ error: 'Missing sync key' });
  const data = readUnifiedData(key);
  const next = mergeProfileState(data, profileId, req.body || {});
  writeKeyData(key, next);
  return res.json({ ok: true, profileId });
});

app.post('/api/library', (req, res) => {
  const key = (req.headers['x-sync-key'] || '').toString().trim();
  const bookSlug = (req.headers['x-book-slug'] || '').toString().trim().toLowerCase();
  const replaceMode = (req.headers['x-sync-replace'] || '').toString().trim() === '1';
  const partialMode = (req.headers['x-sync-partial'] || '').toString().trim();
  if (!key) return res.status(400).json({ error: 'Missing sync key' });
  if (partialMode === 'progress') {
    const existing = readKeyData(key) || readLegacyValue(key) || {};
    const incoming = req.body || {};
    const next = Object.assign({}, existing, {
      version: incoming.version || existing.version || 1,
      exportedAt: incoming.exportedAt || Date.now(),
      progress: incoming.progress || existing.progress || { lastChapterId: null, percents: {} },
      settings: incoming.settings ? Object.assign({}, existing.settings || {}, incoming.settings) : (existing.settings || {}),
    });
    writeKeyData(key, next);
    return res.json({ ok: true, partialMode: 'progress' });
  }
  if (bookSlug) {
    const existing = readKeyData(key) || readLegacyValue(key) || {};
    const merged = mergeBookSlice(existing, req.body || {}, bookSlug, replaceMode);
    writeKeyData(key, merged);
    return res.json({ ok: true, scoped: true, replaceMode });
  }
  const existing = readKeyData(key) || readLegacyValue(key) || {};
  const merged = mergeRootLibrary(existing, req.body || {}, replaceMode);
  writeKeyData(key, merged);
  res.json({ ok: true });
});

app.get('/webapp/:bookSlug/reader.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'webapp', 'reader.html'));
});

app.listen(port, () => {
  console.log('Reader server listening on port', port);
});
