// manga-routes.js
//
// Manga API routes, backed by r2-storage.js instead of GitHub. Add near the
// other /api/* routes in server.js:
//
//   const r2 = require('./r2-storage');
//   registerMangaRoutes(app, r2, safeAsync);
//
// (safeAsync is the same error-wrapping helper already defined in server.js
// - reuse it rather than duplicating error handling.)
//
// Until R2_* env vars are set in Render, every route below returns a clean
// 503 instead of crashing, so this is safe to deploy ahead of time.

function requireR2(r2, res) {
  if (!r2.isR2Configured()) {
    res.status(503).json({ error: 'Manga storage (R2) is not configured yet' });
    return false;
  }
  return true;
}

function mangaPageKey(series, chapter, pageIndex) {
  const s = String(series).trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-');
  const c = String(chapter).trim().toLowerCase().replace(/[^a-z0-9.-]+/g, '-');
  const p = String(pageIndex).padStart(3, '0');
  return `manga/${s}/${c}/${p}.webp`;
}

function mangaCoverKey(series) {
  const s = String(series).trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-');
  return `manga/${s}/cover.webp`;
}

function mangaLibraryKey() {
  return 'manga/library-index.json';
}

function parseDataUrlImage(dataUrl) {
  const m = /^data:([^;,]+);base64,([a-z0-9+/=]+)$/i.exec((dataUrl || '').trim());
  if (!m) return null;
  const mime = (m[1] || '').toLowerCase();
  if (!/^image\//.test(mime)) return null;
  try {
    const buffer = Buffer.from(m[2], 'base64');
    if (!buffer.length) return null;
    return { mime, buffer };
  } catch (e) {
    return null;
  }
}

function registerMangaRoutes(app, r2, safeAsync) {
  // --- Pages ---

  app.get('/api/manga/page', safeAsync(async (req, res) => {
    if (!requireR2(r2, res)) return;
    const series = (req.query.series || '').toString().trim();
    const chapter = (req.query.chapter || '').toString().trim();
    const pageIndex = (req.query.page || '').toString().trim();
    if (!series || !chapter || !pageIndex) {
      return res.status(400).json({ error: 'Missing series, chapter, or page' });
    }
    const obj = await r2.getObject(mangaPageKey(series, chapter, pageIndex));
    if (!obj) return res.status(404).json({ error: 'Page not found' });
    res.setHeader('Content-Type', obj.contentType);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    return res.send(obj.buffer);
  }));

  app.post('/api/manga/page', safeAsync(async (req, res) => {
    if (!requireR2(r2, res)) return;
    const { series, chapter, page, dataUrl } = req.body || {};
    if (!series || !chapter || page === undefined || page === null) {
      return res.status(400).json({ error: 'Missing series, chapter, or page' });
    }
    const parsed = parseDataUrlImage(dataUrl);
    if (!parsed) return res.status(400).json({ error: 'Invalid image payload' });
    await r2.putObject(mangaPageKey(series, chapter, page), parsed.buffer, parsed.mime);
    return res.json({ ok: true });
  }));

  // --- Cover ---

  app.get('/api/manga/cover', safeAsync(async (req, res) => {
    if (!requireR2(r2, res)) return;
    const series = (req.query.series || '').toString().trim();
    if (!series) return res.status(400).json({ error: 'Missing series' });
    const obj = await r2.getObject(mangaCoverKey(series));
    if (!obj) return res.status(404).json({ error: 'Cover not found' });
    res.setHeader('Content-Type', obj.contentType);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    return res.send(obj.buffer);
  }));

  app.post('/api/manga/cover', safeAsync(async (req, res) => {
    if (!requireR2(r2, res)) return;
    const { series, dataUrl } = req.body || {};
    if (!series) return res.status(400).json({ error: 'Missing series' });
    const parsed = parseDataUrlImage(dataUrl);
    if (!parsed) return res.status(400).json({ error: 'Invalid image payload' });
    await r2.putObject(mangaCoverKey(series), parsed.buffer, parsed.mime);
    return res.json({ ok: true });
  }));

  // --- Library index (series -> chapters -> page counts, titles, etc.) ---
  // Kept as one JSON object for now, same mental model as the novel side's
  // library index. Fine at manga-library scale; revisit only if this file
  // itself starts getting large.

  app.get('/api/manga/library', safeAsync(async (req, res) => {
    if (!requireR2(r2, res)) return;
    const data = await r2.getJson(mangaLibraryKey());
    return res.json({ data: data || { series: {} } });
  }));

  app.post('/api/manga/library', safeAsync(async (req, res) => {
    if (!requireR2(r2, res)) return;
    const value = req.body || {};
    await r2.putJson(mangaLibraryKey(), value);
    return res.json({ ok: true });
  }));
}

module.exports = { registerMangaRoutes };
