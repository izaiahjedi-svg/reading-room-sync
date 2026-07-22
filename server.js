const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const port = process.env.PORT || 3000;
const dataDir = path.join(__dirname, '.data');
const keyDir = path.join(dataDir, 'keys');
const stateDir = path.join(dataDir, 'state');
const coverDir = path.join(dataDir, 'covers');
const chapterDir = path.join(dataDir, 'chapters');
const legacyDataFile = path.join(dataDir, 'library.json');

if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
if (!fs.existsSync(keyDir)) fs.mkdirSync(keyDir, { recursive: true });
if (!fs.existsSync(stateDir)) fs.mkdirSync(stateDir, { recursive: true });
if (!fs.existsSync(coverDir)) fs.mkdirSync(coverDir, { recursive: true });
if (!fs.existsSync(chapterDir)) fs.mkdirSync(chapterDir, { recursive: true });

app.use(express.json({ limit: '200mb' }));
app.use(express.static(__dirname));

function parseGitHubRepoSpec(value) {
  const raw = (value || '').toString().trim();
  if (!raw) return null;
  const parts = raw.split('/').filter(Boolean);
  if (parts.length < 2) return null;
  return { owner: parts[0], repo: parts.slice(1).join('/') };
}

function getGitHubStorageConfig() {
  const token = (process.env.GITHUB_TOKEN || '').toString().trim();
  const branch = (process.env.GITHUB_BRANCH || 'data').toString().trim() || 'data';
  const prefix = (process.env.GITHUB_DB_PREFIX || 'sync-db').toString().trim().replace(/^\/+|\/+$/g, '') || 'sync-db';
  const repoSpec = parseGitHubRepoSpec(process.env.GITHUB_REPOSITORY || process.env.GITHUB_REPO || '');
  const owner = (process.env.GITHUB_OWNER || (repoSpec && repoSpec.owner) || '').toString().trim();
  const repo = (process.env.GITHUB_REPO_NAME || (repoSpec && repoSpec.repo) || '').toString().trim();
  if (!token || !owner || !repo) return null;
  return { token, owner, repo, branch, prefix };
}

const githubStorageConfig = getGitHubStorageConfig();
const githubWriteQueues = new Map();

function safeAsync(handler) {
  return (req, res) => {
    Promise.resolve(handler(req, res)).catch((err) => {
      console.error('Request failed:', err && err.stack ? err.stack : err);
      if (!res.headersSent) {
        res.status(502).json({ error: 'Sync backend unavailable' });
      }
    });
  };
}

if (githubStorageConfig) {
  console.log('GitHub-backed sync storage enabled for ' + githubStorageConfig.owner + '/' + githubStorageConfig.repo + ' @ ' + githubStorageConfig.branch);
  if (githubStorageConfig.owner === 'owner' && githubStorageConfig.repo === 'repo') {
    console.warn('GITHUB_REPOSITORY is set to placeholder value owner/repo; update Render env vars to your real repository.');
  }
}

function githubRootPathForKey(key) {
  return githubStorageConfig ? (githubStorageConfig.prefix + '/' + keyDigest(key)) : '';
}

function githubPathForKey(key, leafPath) {
  return githubStorageConfig ? (githubRootPathForKey(key) + '/' + leafPath.replace(/^\/+/, '')) : '';
}

function githubFileUrl(filePath) {
  return 'https://api.github.com/repos/' + encodeURIComponent(githubStorageConfig.owner) + '/' + encodeURIComponent(githubStorageConfig.repo) + '/contents/' + filePath.split('/').map((part) => encodeURIComponent(part)).join('/');
}

function githubHeaders() {
  return {
    'Authorization': 'Bearer ' + githubStorageConfig.token,
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

function isRetryableGithubStatus(status) {
  return status === 403 || status === 408 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

function retryDelayMsFromHeaders(res, attempt) {
  const retryAfter = (res && res.headers && res.headers.get('retry-after')) || '';
  const retryAfterSec = Number.parseInt(retryAfter, 10);
  if (Number.isFinite(retryAfterSec) && retryAfterSec > 0) {
    return Math.min(15000, retryAfterSec * 1000);
  }

  const rateRemaining = (res && res.headers && res.headers.get('x-ratelimit-remaining')) || '';
  const rateReset = (res && res.headers && res.headers.get('x-ratelimit-reset')) || '';
  const remaining = Number.parseInt(rateRemaining, 10);
  const resetEpochSec = Number.parseInt(rateReset, 10);
  if (Number.isFinite(remaining) && remaining <= 0 && Number.isFinite(resetEpochSec)) {
    const msUntilReset = (resetEpochSec * 1000) - Date.now();
    if (msUntilReset > 0) return Math.min(15000, msUntilReset + 200);
  }

  return Math.min(5000, 250 * attempt);
}

async function githubFetchWithRetry(url, options, settings) {
  const maxAttempts = (settings && settings.maxAttempts) || 4;
  const allow404 = !!(settings && settings.allow404);
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(url, options);
      if (res.ok) return res;
      if (allow404 && res.status === 404) return res;
      if (isRetryableGithubStatus(res.status) && attempt < maxAttempts) {
        const delayMs = retryDelayMsFromHeaders(res, attempt);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        continue;
      }
      return res;
    } catch (e) {
      if (attempt >= maxAttempts) throw e;
      await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
    }
  }
  return null;
}

function enqueueGitHubWrite(queueKey, task) {
  const existing = githubWriteQueues.get(queueKey) || Promise.resolve();
  const next = existing.catch(() => {}).then(task);
  const tracked = next.catch(() => {}).finally(() => {
    if (githubWriteQueues.get(queueKey) === tracked) githubWriteQueues.delete(queueKey);
  });
  githubWriteQueues.set(queueKey, tracked);
  return next;
}

async function githubReadJson(filePath) {
  if (!githubStorageConfig) return null;
  try {
    const res = await githubFetchWithRetry(githubFileUrl(filePath) + '?ref=' + encodeURIComponent(githubStorageConfig.branch), {
      headers: githubHeaders(),
    }, { maxAttempts: 4, allow404: true });
    if (!res) return null;
    if (res.status === 404) return null;
    if (!res.ok) return null;
    const payload = await res.json();
    const content = payload && payload.content ? payload.content.replace(/\n/g, '') : '';
    if (!content) return null;
    const text = Buffer.from(content, 'base64').toString('utf8');
    return JSON.parse(text);
  } catch (e) {
    console.warn('GitHub read failed for', filePath, e.message);
    return null;
  }
}

async function githubWriteJson(filePath, value, message) {
  if (!githubStorageConfig) return false;
  const payload = Buffer.from(JSON.stringify(value || {}), 'utf8').toString('base64');
  return enqueueGitHubWrite(filePath, async () => {
    const maxAttempts = 4;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const existing = await githubFetchWithRetry(githubFileUrl(filePath) + '?ref=' + encodeURIComponent(githubStorageConfig.branch), {
        headers: githubHeaders(),
      }, { maxAttempts: 3, allow404: true });
      let sha = null;
      if (existing && existing.ok) {
        try {
          const current = await existing.json();
          sha = current && current.sha ? current.sha : null;
        } catch (e) {}
      }

      const res = await githubFetchWithRetry(githubFileUrl(filePath), {
        method: 'PUT',
        headers: Object.assign({ 'Content-Type': 'application/json' }, githubHeaders()),
        body: JSON.stringify({
          message: message || ('Update ' + filePath),
          content: payload,
          branch: githubStorageConfig.branch,
          ...(sha ? { sha } : {}),
        }),
      }, { maxAttempts: 3, allow404: false });

      if (!res) {
        throw new Error('GitHub write failed for ' + filePath + ': no response');
      }

      if (res.ok) {
        return true;
      }

      const text = await res.text().catch(() => '');
      if (res.status === 409 && attempt < maxAttempts) {
        // Another client updated the file between read and write; retry with latest sha.
        await new Promise((resolve) => setTimeout(resolve, 80 * attempt));
        continue;
      }
      throw new Error('GitHub write failed for ' + filePath + ' (' + res.status + '): ' + text.slice(0, 200));
    }
    return false;
  });
}

async function githubDeleteJson(filePath, message) {
  if (!githubStorageConfig) return false;
  return enqueueGitHubWrite(filePath, async () => {
    const existing = await githubFetchWithRetry(githubFileUrl(filePath) + '?ref=' + encodeURIComponent(githubStorageConfig.branch), {
      headers: githubHeaders(),
    }, { maxAttempts: 4, allow404: true });
    if (!existing || !existing.ok) return true;
    const current = await existing.json();
    if (!current || !current.sha) return true;
    const res = await githubFetchWithRetry(githubFileUrl(filePath), {
      method: 'DELETE',
      headers: Object.assign({ 'Content-Type': 'application/json' }, githubHeaders()),
      body: JSON.stringify({
        message: message || ('Delete ' + filePath),
        sha: current.sha,
        branch: githubStorageConfig.branch,
      }),
    }, { maxAttempts: 3, allow404: true });
    if (!res) {
      throw new Error('GitHub delete failed for ' + filePath + ': no response');
    }
    if (!res.ok && res.status !== 404) {
      const text = await res.text().catch(() => '');
      throw new Error('GitHub delete failed for ' + filePath + ' (' + res.status + '): ' + text.slice(0, 200));
    }
    return true;
  });
}

function githubKeyFilePath(key) {
  return githubPathForKey(key, 'library.json');
}

function githubStateFilePath(key) {
  return githubPathForKey(key, 'state.json');
}

function githubChapterFilePath(key, chapterId) {
  return githubPathForKey(key, 'chapters/' + (chapterId || '').toString().trim() + '.json');
}

function githubCoverFilePath(key, bookName) {
  return githubPathForKey(key, 'covers/' + safeBookSlugForCover(bookName) + '.json');
}

function stripChaptersForMetadata(value) {
  const src = (value && typeof value === 'object') ? value : {};
  const next = Object.assign({}, src);
  delete next.chapters;
  return next;
}

function getLibraryChapterEntries(value) {
  const chapters = (value && typeof value === 'object' && value.chapters && typeof value.chapters === 'object') ? value.chapters : {};
  return Object.entries(chapters).filter(([id, chapter]) => !!id && chapter && typeof chapter === 'object');
}

async function saveLibraryToGithub(key, value) {
  const metadata = stripChaptersForMetadata(value);
  const chapterEntries = getLibraryChapterEntries(value);
  await githubWriteJson(githubKeyFilePath(key), metadata, 'Update library metadata for ' + keyDigest(key));
  for (const [chapterId, chapterData] of chapterEntries) {
    await githubWriteJson(githubChapterFilePath(key, chapterId), chapterData, 'Update chapter ' + chapterId + ' for ' + keyDigest(key));
  }
  return true;
}

async function readStateData(key) {
  if (githubStorageConfig) {
    const remote = await githubReadJson(githubStateFilePath(key));
    if (remote) return remote;
    const legacyRemote = await githubReadJson(githubKeyFilePath(key));
    if (legacyRemote && legacyRemote.stateProfiles && typeof legacyRemote.stateProfiles === 'object') {
      return { version: legacyRemote.version || 1, exportedAt: legacyRemote.exportedAt || Date.now(), stateProfiles: legacyRemote.stateProfiles };
    }
    return null;
  }
  const p = stateFilePath(key);
  if (!fs.existsSync(p)) {
    const legacy = await readKeyData(key);
    if (legacy && legacy.stateProfiles && typeof legacy.stateProfiles === 'object') {
      return { version: legacy.version || 1, exportedAt: legacy.exportedAt || Date.now(), stateProfiles: legacy.stateProfiles };
    }
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    console.warn('Failed to parse state store', e.message);
    return null;
  }
}

async function writeStateData(key, value) {
  if (githubStorageConfig) {
    return githubWriteJson(githubStateFilePath(key), value, 'Update profile state for ' + keyDigest(key));
  }
  const p = stateFilePath(key);
  fs.writeFileSync(p, JSON.stringify(value || {}), 'utf8');
  return true;
}

async function readCoverData(key, bookName) {
  if (githubStorageConfig) {
    return githubReadJson(githubCoverFilePath(key, bookName));
  }
  const p = coverFilePath(key, bookName);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    return null;
  }
}

async function writeCoverData(key, bookName, value) {
  if (githubStorageConfig) {
    return githubWriteJson(githubCoverFilePath(key, bookName), value, 'Update cover for ' + safeBookSlugForCover(bookName) + ' (' + keyDigest(key) + ')');
  }
  const p = coverFilePath(key, bookName);
  fs.writeFileSync(p, JSON.stringify(value || {}), 'utf8');
  return true;
}

async function readChapterDataRemoteAware(key, chapterId) {
  if (githubStorageConfig) {
    const remote = await githubReadJson(githubChapterFilePath(key, chapterId));
    if (remote) return remote;
  }
  const p = chapterFilePath(key, chapterId);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    return null;
  }
}

async function writeChapterDataRemoteAware(key, chapterId, value) {
  if (githubStorageConfig) {
    return githubWriteJson(githubChapterFilePath(key, chapterId), value, 'Update chapter ' + chapterId + ' (' + keyDigest(key) + ')');
  }
  const p = chapterFilePath(key, chapterId);
  fs.writeFileSync(p, JSON.stringify(value || {}), 'utf8');
  return true;
}

async function deleteChapterDataRemoteAware(key, chapterId) {
  if (githubStorageConfig) {
    return githubDeleteJson(githubChapterFilePath(key, chapterId), 'Delete chapter ' + chapterId + ' (' + keyDigest(key) + ')');
  }
  const p = chapterFilePath(key, chapterId);
  try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch (e) {}
  return true;
}

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

function stateFilePath(key) {
  const digest = crypto.createHash('sha256').update(key).digest('hex');
  return path.join(stateDir, digest + '.json');
}

function keyDigest(key) {
  return crypto.createHash('sha256').update(key || '').digest('hex');
}

function safeBookSlugForCover(bookName) {
  const slug = slugifyBookName(bookName);
  return slug || 'book';
}

function coverFilePath(key, bookName) {
  const kd = keyDigest(key);
  const dir = path.join(coverDir, kd);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, safeBookSlugForCover(bookName) + '.json');
}

function chapterFilePath(key, chapterId) {
  const kd = keyDigest(key);
  const dir = path.join(chapterDir, kd);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const id = (chapterId || '').toString().trim();
  return path.join(dir, id + '.json');
}

async function readChapterData(key, chapterId) {
  return readChapterDataRemoteAware(key, chapterId);
}

async function writeChapterData(key, chapterId, value) {
  return writeChapterDataRemoteAware(key, chapterId, value);
}

async function readChapterWithLegacyFallback(key, chapterId) {
  const chapter = await readChapterData(key, chapterId);
  if (chapter) return chapter;
  const data = await readUnifiedData(key);
  return (data && data.chapters && data.chapters[chapterId]) ? data.chapters[chapterId] : null;
}

function parseDataUrlImage(dataUrl) {
  const m = /^data:([^;,]+);base64,([a-z0-9+/=]+)$/i.exec((dataUrl || '').trim());
  if (!m) return null;
  const mime = (m[1] || '').toLowerCase();
  if (!/^image\//.test(mime)) return null;
  try {
    const buffer = Buffer.from(m[2], 'base64');
    if (!buffer.length) return null;
    return { mime, base64: m[2], bytes: buffer.length };
  } catch (e) {
    return null;
  }
}

function coverPublicPath(key, bookName) {
  return '/api/cover?key=' + encodeURIComponent(key) + '&book=' + encodeURIComponent(bookName) + '&v=' + Date.now();
}

async function readKeyData(key) {
  if (githubStorageConfig) {
    return githubReadJson(githubKeyFilePath(key));
  }
  const p = keyFilePath(key);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    console.warn('Failed to parse key store', e.message);
    return null;
  }
}

async function writeKeyData(key, value) {
  if (githubStorageConfig) {
    return saveLibraryToGithub(key, value);
  }
  const p = keyFilePath(key);
  fs.writeFileSync(p, JSON.stringify(value || {}), 'utf8');
  return true;
}

async function readLegacyValue(key) {
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

async function readUnifiedData(key) {
  return (await readKeyData(key)) || (await readLegacyValue(key)) || {};
}

function getProfileState(data, profileId) {
  const src = (data && typeof data === 'object') ? data : {};
  const pid = normalizeProfileId(profileId);
  const stateProfiles = (src && typeof src.stateProfiles === 'object' && src.stateProfiles) || {};
  const existing = (stateProfiles[pid] && typeof stateProfiles[pid] === 'object') ? stateProfiles[pid] : null;
  const progress = (existing && existing.progress) || src.progress || { lastChapterId: null, percents: {} };
  const settings = (existing && existing.settings) || src.settings || {};
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

app.get('/api/library', safeAsync(async (req, res) => {
  const key = (req.query.key || '').trim();
  const bookSlug = (req.query.book || '').trim().toLowerCase();
  const metaOnly = (req.query.meta || '').trim() === '1';
  if (!key) return res.status(400).json({ error: 'Missing sync key' });

  let data = await readKeyData(key);
  if (!data) {
    const legacy = await readLegacyValue(key);
    if (legacy) {
      await writeKeyData(key, legacy);
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
}));

app.get('/api/cover', safeAsync(async (req, res) => {
  const key = (req.query.key || '').toString().trim();
  const book = (req.query.book || '').toString().trim();
  if (!key || !book) return res.status(400).json({ error: 'Missing key or book' });
  const payload = await readCoverData(key, book);
  if (!payload) return res.status(404).json({ error: 'Cover not found' });
  try {
    const mime = (payload && payload.mime) || 'image/jpeg';
    const base64 = (payload && payload.base64) || '';
    const buffer = Buffer.from(base64, 'base64');
    res.setHeader('Content-Type', mime);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    return res.send(buffer);
  } catch (e) {
    return res.status(500).json({ error: 'Failed to load cover' });
  }
}));

app.post('/api/cover', safeAsync(async (req, res) => {
  const key = (req.headers['x-sync-key'] || '').toString().trim();
  const book = (req.body && req.body.book ? req.body.book : '').toString().trim();
  const dataUrl = (req.body && req.body.dataUrl ? req.body.dataUrl : '').toString();
  if (!key) return res.status(400).json({ error: 'Missing sync key' });
  if (!book) return res.status(400).json({ error: 'Missing book' });
  const parsed = parseDataUrlImage(dataUrl);
  if (!parsed) return res.status(400).json({ error: 'Invalid image payload' });
  if (parsed.bytes > 2 * 1024 * 1024) return res.status(413).json({ error: 'Cover exceeds 2MB limit' });
  try {
    await writeCoverData(key, book, { mime: parsed.mime, base64: parsed.base64 });
    return res.json({ ok: true, coverPath: coverPublicPath(key, book) });
  } catch (e) {
    return res.status(500).json({ error: 'Failed to save cover' });
  }
}));

app.get('/api/chapter', safeAsync(async (req, res) => {
  const key = (req.query.key || '').toString().trim();
  const chapterId = (req.query.id || '').toString().trim();
  if (!key || !chapterId) return res.status(400).json({ error: 'Missing key or chapter id' });
  const data = await readChapterWithLegacyFallback(key, chapterId);
  if (!data) return res.status(404).json({ error: 'Chapter not found' });
  return res.json({ data });
}));

app.post('/api/chapter', safeAsync(async (req, res) => {
  const key = (req.headers['x-sync-key'] || '').toString().trim();
  const chapterId = (req.body && req.body.id ? req.body.id : '').toString().trim();
  const chapter = req.body && req.body.data;
  if (!key) return res.status(400).json({ error: 'Missing sync key' });
  if (!chapterId) return res.status(400).json({ error: 'Missing chapter id' });
  if (!chapter || typeof chapter !== 'object') return res.status(400).json({ error: 'Missing chapter data' });
  await writeChapterData(key, chapterId, chapter);
  return res.json({ ok: true, id: chapterId });
}));

app.get('/api/state', safeAsync(async (req, res) => {
  const key = (req.query.key || '').toString().trim();
  const profileId = normalizeProfileId(req.query.profile || 'izaiah');
  if (!key) return res.status(400).json({ error: 'Missing sync key' });
  const data = await readStateData(key);
  return res.json({ data: getProfileState(data, profileId) });
}));

app.post('/api/state', safeAsync(async (req, res) => {
  const key = (req.headers['x-sync-key'] || '').toString().trim();
  const profileId = normalizeProfileId(req.headers['x-profile-id'] || 'izaiah');
  if (!key) return res.status(400).json({ error: 'Missing sync key' });
  const data = await readStateData(key);
  const next = mergeProfileState(data, profileId, req.body || {});
  await writeStateData(key, next);
  return res.json({ ok: true, profileId });
}));

app.post('/api/library', safeAsync(async (req, res) => {
  const key = (req.headers['x-sync-key'] || '').toString().trim();
  const bookSlug = (req.headers['x-book-slug'] || '').toString().trim().toLowerCase();
  const replaceMode = (req.headers['x-sync-replace'] || '').toString().trim() === '1';
  const partialMode = (req.headers['x-sync-partial'] || '').toString().trim();
  if (!key) return res.status(400).json({ error: 'Missing sync key' });
  if (partialMode === 'progress') {
    const existing = (await readKeyData(key)) || (await readLegacyValue(key)) || {};
    const incoming = req.body || {};
    const next = Object.assign({}, existing, {
      version: incoming.version || existing.version || 1,
      exportedAt: incoming.exportedAt || Date.now(),
      progress: incoming.progress || existing.progress || { lastChapterId: null, percents: {} },
      settings: incoming.settings ? Object.assign({}, existing.settings || {}, incoming.settings) : (existing.settings || {}),
    });
    await writeKeyData(key, next);
    return res.json({ ok: true, partialMode: 'progress' });
  }
  if (bookSlug) {
    const existing = (await readKeyData(key)) || (await readLegacyValue(key)) || {};
    const removedIds = replaceMode
      ? (Array.isArray(existing.index) ? existing.index : [])
        .filter((entry) => matchesBookSlug(entry && entry.book, bookSlug))
        .map((entry) => entry && entry.id)
        .filter(Boolean)
      : [];
    const merged = mergeBookSlice(existing, req.body || {}, bookSlug, replaceMode);
    await writeKeyData(key, merged);
    for (const chapterId of removedIds) {
      if (!merged.index.some((entry) => entry && entry.id === chapterId)) {
        await deleteChapterData(key, chapterId);
      }
    }
    return res.json({ ok: true, scoped: true, replaceMode });
  }
  const existing = (await readKeyData(key)) || (await readLegacyValue(key)) || {};
  const removedIds = replaceMode
    ? (Array.isArray(existing.index) ? existing.index : [])
      .map((entry) => entry && entry.id)
      .filter(Boolean)
    : [];
  const merged = mergeRootLibrary(existing, req.body || {}, replaceMode);
  await writeKeyData(key, merged);
  for (const chapterId of removedIds) {
    if (!merged.index.some((entry) => entry && entry.id === chapterId)) {
      await deleteChapterData(key, chapterId);
    }
  }
  res.json({ ok: true });
}));

app.get('/webapp/reader.html', (req, res) => {
  const query = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
  res.redirect(302, '/reader.html' + query);
});

app.get('/webapp/reader.htm', (req, res) => {
  const query = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
  res.redirect(302, '/reader.html' + query);
});

app.get('/webapp/:bookSlug/reader.html', (req, res) => {
  const slug = encodeURIComponent((req.params.bookSlug || '').trim());
  const query = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
  res.redirect(302, '/' + slug + '/reader.html' + query);
});

app.get('/webapp/:bookSlug/reader.htm', (req, res) => {
  const slug = encodeURIComponent((req.params.bookSlug || '').trim());
  const query = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
  res.redirect(302, '/' + slug + '/reader.html' + query);
});

app.get('/:bookSlug/reader.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'reader.html'));
});

app.get('/:bookSlug/reader.htm', (req, res) => {
  const slug = encodeURIComponent((req.params.bookSlug || '').trim());
  const query = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
  res.redirect(302, '/' + slug + '/reader.html' + query);
});

app.listen(port, () => {
  console.log('Reader server listening on port', port);
});
