const CHAPTERS_PER_PAGE = 10;
const MANGA_THEME_KEY = 'reading-room:manga-theme';
const MANGA_WIDTH_KEY = 'reading-room:manga-page-width';
const THEME_OPTIONS = ['dark', 'light', 'sepia', 'graphite', 'forest'];

const state = {
  view: 'home',
  library: [],
  activeSeries: '',
  activeChapterKey: '',
  chapterPage: 0,
  importing: false,
  pageWidth: readStoredPageWidth(),
};

const main = document.getElementById('main');
const topbarActions = document.getElementById('topbarActions');
const folderInput = document.getElementById('folderInput');

async function mangaApi(path, options) {
  const response = await fetch(path, Object.assign({ headers: { 'Content-Type': 'application/json' } }, options || {}));
  if (!response.ok) {
    let message = 'Manga storage request failed (' + response.status + ')';
    try {
      const payload = await response.json();
      if (payload && payload.error) message = payload.error;
    } catch (e) {}
    throw new Error(message);
  }
  return response;
}

applyTheme(readStoredTheme());
applyPageWidth();

folderInput.addEventListener('change', async (event) => {
  const files = Array.from(event.target.files || []).filter((file) => isImage(file.name));
  if (!files.length) {
    renderMessage('No image files found in selected folder.');
    return;
  }

  state.importing = true;
  renderTopbar();
  renderMessage('Building manga library from folder...');
  try {
    state.library = await buildLibraryFromFiles(files);
    await saveMangaLibrary();
    state.view = 'home';
    state.activeSeries = '';
    state.activeChapterKey = '';
    state.chapterPage = 0;
    render();
  } catch (error) {
    renderMessage(error.message || 'Manga upload failed.');
  } finally {
    state.importing = false;
    renderTopbar();
  }
});

function isImage(name) {
  return /\.(jpg|jpeg|png|webp)$/i.test(name || '');
}

function naturalCompare(a, b) {
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
}

function parseChapterSort(chapterName) {
  const num = (chapterName.match(/(\d+(?:\.\d+)?)/) || [])[1];
  return num ? Number(num) : Number.POSITIVE_INFINITY;
}

function readStoredTheme() {
  try {
    const saved = (window.localStorage.getItem(MANGA_THEME_KEY) || '').trim();
    if (THEME_OPTIONS.includes(saved)) return saved;
  } catch (e) {}
  return 'light';
}

function storeTheme(theme) {
  try { window.localStorage.setItem(MANGA_THEME_KEY, theme); } catch (e) {}
}

function applyTheme(theme) {
  const nextTheme = THEME_OPTIONS.includes(theme) ? theme : 'light';
  document.body.setAttribute('data-theme', nextTheme);
  storeTheme(nextTheme);
}

function readStoredPageWidth() {
  try {
    const raw = Number(window.localStorage.getItem(MANGA_WIDTH_KEY) || '980');
    if (Number.isFinite(raw)) return Math.max(620, Math.min(1200, Math.round(raw)));
  } catch (e) {}
  return 980;
}

function storePageWidth(width) {
  try { window.localStorage.setItem(MANGA_WIDTH_KEY, String(width)); } catch (e) {}
}

function applyPageWidth() {
  document.documentElement.style.setProperty('--manga-page-max-width', state.pageWidth + 'px');
}

async function buildLibraryFromFiles(files) {
  const seriesMap = new Map();

  for (const file of files) {
    const rel = String(file.webkitRelativePath || '').replaceAll('\\', '/');
    const parts = rel.split('/').filter(Boolean);
    if (parts.length < 3) continue;

    const seriesName = parts[0].trim();
    const chapterName = parts[1].trim();
    if (!seriesName || !chapterName) continue;

    if (!seriesMap.has(seriesName)) {
      seriesMap.set(seriesName, { name: seriesName, chapters: [] });
    }

    const series = seriesMap.get(seriesName);
    let chapter = series.chapters.find((item) => item.key === chapterName);
    if (!chapter) {
      chapter = {
        key: chapterName,
        title: chapterName,
        chapterNumber: parseChapterSort(chapterName),
        pages: [],
      };
      series.chapters.push(chapter);
    }

    const pageIndex = chapter.pages.length + 1;
    const dataUrl = await readFileAsDataUrl(file);
    await mangaApi('/api/manga/page', {
      method: 'POST',
      body: JSON.stringify({ series: seriesName, chapter: chapterName, page: pageIndex, dataUrl }),
    });
    if (pageIndex === 1) {
      await mangaApi('/api/manga/cover', {
        method: 'POST',
        body: JSON.stringify({ series: seriesName, dataUrl }),
      });
    }
    chapter.pages.push({ name: parts[parts.length - 1], page: pageIndex });
  }

  const library = Array.from(seriesMap.values());
  library.forEach((series) => {
    series.chapters.forEach((chapter) => {
      chapter.pages.sort((a, b) => naturalCompare(a.name, b.name));
    });
    series.chapters.sort((a, b) => {
      if (Number.isFinite(a.chapterNumber) && Number.isFinite(b.chapterNumber) && a.chapterNumber !== b.chapterNumber) {
        return a.chapterNumber - b.chapterNumber;
      }
      return naturalCompare(a.key, b.key);
    });
  });

  library.sort((a, b) => naturalCompare(a.name, b.name));
  return library;
}

async function saveMangaLibrary() {
  const series = {};
  state.library.forEach((entry) => {
    series[entry.name] = {
      name: entry.name,
      chapters: entry.chapters.map((chapter) => ({
        key: chapter.key,
        title: chapter.title,
        chapterNumber: chapter.chapterNumber,
        pages: chapter.pages.map((page) => ({ name: page.name, page: page.page })),
      })),
    };
  });
  await mangaApi('/api/manga/library', {
    method: 'POST',
    body: JSON.stringify({ version: 1, updatedAt: Date.now(), series }),
  });
}

async function loadMangaLibrary() {
  const response = await mangaApi('/api/manga/library');
  const payload = await response.json();
  const seriesMap = payload && payload.data && payload.data.series ? payload.data.series : {};
  state.library = Object.values(seriesMap).map((series) => ({
    name: series.name,
    chapters: (series.chapters || []).map((chapter) => ({
      key: chapter.key,
      title: chapter.title || chapter.key,
      chapterNumber: Number.isFinite(Number(chapter.chapterNumber)) ? Number(chapter.chapterNumber) : parseChapterSort(chapter.key),
      pages: (chapter.pages || []).map((page) => ({
        name: page.name || String(page.page).padStart(3, '0') + '.webp',
        page: page.page,
      })),
    })),
  }));
  state.library.sort((a, b) => naturalCompare(a.name, b.name));
}

function pageUrl(series, chapter, page) {
  const params = new URLSearchParams({ series, chapter, page: String(page) });
  return '/api/manga/page?' + params.toString();
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error('Image read failed'));
    reader.readAsDataURL(file);
  });
}

function getSeries(name) {
  return state.library.find((series) => series.name === name) || null;
}

function getActiveSeriesChapters() {
  const series = getSeries(state.activeSeries);
  return series ? series.chapters : [];
}

function getActiveChapter() {
  const chapters = getActiveSeriesChapters();
  return chapters.find((chapter) => chapter.key === state.activeChapterKey) || null;
}

function openFolderPicker() {
  folderInput.value = '';
  folderInput.click();
}

function openSeries(seriesName) {
  state.view = 'title';
  state.activeSeries = seriesName;
  state.activeChapterKey = '';
  state.chapterPage = 0;
  render();
}

function openChapter(seriesName, chapterKey) {
  state.view = 'reader';
  state.activeSeries = seriesName;
  state.activeChapterKey = chapterKey;
  render();
  window.scrollTo(0, 0);
}

function moveChapter(direction) {
  const chapters = getActiveSeriesChapters();
  const idx = chapters.findIndex((chapter) => chapter.key === state.activeChapterKey);
  const nextIdx = idx + direction;
  if (nextIdx < 0 || nextIdx >= chapters.length) return;
  state.activeChapterKey = chapters[nextIdx].key;
  render();
  window.scrollTo(0, 0);
}

function renderTopbar() {
  topbarActions.innerHTML = '';

  const themeBtn = document.createElement('button');
  themeBtn.type = 'button';
  themeBtn.className = 'subtle';
  themeBtn.textContent = 'Theme';
  themeBtn.onclick = () => {
    const current = document.body.getAttribute('data-theme') || 'light';
    const currentIdx = Math.max(0, THEME_OPTIONS.indexOf(current));
    const next = THEME_OPTIONS[(currentIdx + 1) % THEME_OPTIONS.length];
    applyTheme(next);
  };

  const importBtn = document.createElement('button');
  importBtn.type = 'button';
  importBtn.className = 'primary';
  importBtn.textContent = state.importing ? 'Importing...' : 'Import Manga Folder';
  importBtn.disabled = state.importing;
  importBtn.onclick = openFolderPicker;

  topbarActions.append(themeBtn, importBtn);
}

function renderMessage(text) {
  main.innerHTML = '<div class="library-wrap"><div class="empty-state"><div class="big">Manga Library</div><div>' + escapeHtml(text) + '</div></div></div>';
}

function render() {
  document.body.classList.toggle('reader-mode-v2', state.view === 'reader');
  renderTopbar();
  if (!state.library.length) {
    renderMessage('Import a manga folder to start. Expected format: series/chapter-0001/001.jpg');
    return;
  }

  if (state.view === 'home') {
    renderHome();
    return;
  }

  if (state.view === 'title') {
    renderTitlePage();
    return;
  }

  renderReader();
}

function renderHome() {
  const allSeriesCards = state.library.map((series) => {
    const latest = series.chapters[series.chapters.length - 1] || null;
    return [
      '<article class="book-card">',
      '<div class="book-cover"></div>',
      '<div class="book-meta">',
      '<div class="book-title">' + escapeHtml(series.name) + '</div>',
      '<div class="book-sub">' + series.chapters.length + ' chapters' + (latest ? (' • Latest: ' + escapeHtml(latest.title)) : '') + '</div>',
      '<div class="book-actions"><button type="button" data-open-series="' + escapeAttr(series.name) + '">Open title</button></div>',
      '</div>',
      '</article>'
    ].join('');
  }).join('');

  main.innerHTML = [
    '<div class="library-wrap">',
    '<section class="home-section">',
    '<div class="home-section-head"><h2>All Manga</h2><span class="home-subtle">No volumes • chapter-based pages</span></div>',
    '<div class="book-grid">' + allSeriesCards + '</div>',
    '</section>',
    '</div>'
  ].join('');

  main.querySelectorAll('[data-open-series]').forEach((btn) => {
    btn.addEventListener('click', () => openSeries(btn.getAttribute('data-open-series') || ''));
  });
}

function renderTitlePage() {
  const series = getSeries(state.activeSeries);
  if (!series) {
    state.view = 'home';
    render();
    return;
  }

  const chapters = series.chapters;
  const totalPages = Math.max(1, Math.ceil(chapters.length / CHAPTERS_PER_PAGE));
  state.chapterPage = Math.max(0, Math.min(state.chapterPage, totalPages - 1));
  const start = state.chapterPage * CHAPTERS_PER_PAGE;
  const visible = chapters.slice(start, start + CHAPTERS_PER_PAGE);

  const rows = visible.map((chapter) => {
    return [
      '<li class="title-chapter-row">',
      '<button type="button" class="title-chapter-btn" data-open-chapter="' + escapeAttr(chapter.key) + '">',
      '<span class="title-chapter-name">' + escapeHtml(chapter.title) + '</span>',
      '<span class="title-chapter-meta">' + chapter.pages.length + ' pages</span>',
      '</button>',
      '</li>'
    ].join('');
  }).join('');

  main.innerHTML = [
    '<div class="library-wrap">',
    '<div class="title-layout">',
    '<aside class="title-sidebar">',
    '<div class="title-sidebar-cover-fallback">MANGA</div>',
    '<div class="title-sidebar-body">',
    '<h2>' + escapeHtml(series.name) + '</h2>',
    '<div class="title-tag-row"><span class="title-tag">Manga</span><span class="title-tag">No Volumes</span></div>',
    '<ul class="title-meta-list">',
    '<li>Total chapters: <strong>' + chapters.length + '</strong></li>',
    '<li>Pages in this view: <strong>' + visible.reduce((sum, ch) => sum + ch.pages.length, 0) + '</strong></li>',
    '<li>Pagination: <strong>10 chapters per page</strong></li>',
    '</ul>',
    '</div>',
    '</aside>',
    '<section class="title-main">',
    '<h1>About</h1>',
    '<p class="title-description">Manga title page for ' + escapeHtml(series.name) + '. Chapter list is paged in sets of 10.</p>',
    '<div class="title-action-row"><button class="primary" type="button" id="titleBackHome">Back home</button></div>',
    '<div class="title-chapter-head">',
    '<h2>Chapters</h2>',
    '<div class="title-volume-controls"><span class="title-empty-row" style="padding:0;border:none;background:transparent;">Page ' + (state.chapterPage + 1) + ' of ' + totalPages + '</span></div>',
    '</div>',
    '<ul class="title-chapter-list">' + rows + '</ul>',
    '<div class="manga-title-pagination">',
    '<button type="button" id="pagePrev" ' + (state.chapterPage <= 0 ? 'disabled' : '') + '>Previous 10</button>',
    '<button type="button" id="pageNext" ' + (state.chapterPage >= totalPages - 1 ? 'disabled' : '') + '>Next 10</button>',
    '</div>',
    '</section>',
    '</div>',
    '</div>'
  ].join('');

  const back = document.getElementById('titleBackHome');
  if (back) {
    back.addEventListener('click', () => {
      state.view = 'home';
      state.activeSeries = '';
      state.chapterPage = 0;
      render();
    });
  }

  const prev = document.getElementById('pagePrev');
  const next = document.getElementById('pageNext');
  if (prev) {
    prev.addEventListener('click', () => {
      state.chapterPage = Math.max(0, state.chapterPage - 1);
      renderTitlePage();
    });
  }
  if (next) {
    next.addEventListener('click', () => {
      state.chapterPage = Math.min(totalPages - 1, state.chapterPage + 1);
      renderTitlePage();
    });
  }

  main.querySelectorAll('[data-open-chapter]').forEach((btn) => {
    btn.addEventListener('click', () => openChapter(series.name, btn.getAttribute('data-open-chapter') || ''));
  });
}

function buildMangaSettingsPanel() {
  const currentTheme = document.body.getAttribute('data-theme') || 'light';
  const themeOptions = THEME_OPTIONS
    .map((theme) => '<option value="' + theme + '"' + (theme === currentTheme ? ' selected' : '') + '>' + theme + '</option>')
    .join('');

  return [
    '<div class="reader-settings-card">',
    '<h3>Reader Settings</h3>',
    '<div class="reader-control">',
    '<div class="reader-control-head"><label for="mangaThemeSelect">Theme</label></div>',
    '<select id="mangaThemeSelect">' + themeOptions + '</select>',
    '</div>',
    '<div class="reader-control">',
    '<div class="reader-control-head"><label for="mangaPageWidth">Page Width</label><span id="mangaPageWidthValue">' + state.pageWidth + 'px</span></div>',
    '<input id="mangaPageWidth" type="range" min="620" max="1200" step="10" value="' + state.pageWidth + '" />',
    '</div>',
    '<div class="reader-control">',
    '<div class="manga-muted">More settings are under dev.</div>',
    '</div>',
    '</div>'
  ].join('');
}

function renderReader() {
  const series = getSeries(state.activeSeries);
  const chapter = getActiveChapter();
  if (!series || !chapter) {
    state.view = 'title';
    render();
    return;
  }

  const chapters = getActiveSeriesChapters();
  const idx = chapters.findIndex((item) => item.key === chapter.key);
  const prevMeta = idx > 0 ? chapters[idx - 1] : null;
  const nextMeta = idx < chapters.length - 1 ? chapters[idx + 1] : null;
  const pageMarkup = chapter.pages
    .map((page) => '<img loading="lazy" decoding="async" alt="' + escapeAttr(chapter.title + ' page ' + page.name) + '" src="' + pageUrl(series.name, chapter.key, page.page) + '" />')
    .join('');

  main.innerHTML = [
    '<div class="reader-v2">',
    '<div class="reader-v2-shell">',
    '<article class="reader-content reader-content-v2">',
    '<div class="reader-content-head"><div class="reader-kicker">Manga Chapter</div><h1>' + escapeHtml(series.name) + ' • ' + escapeHtml(chapter.title) + '</h1></div>',
    '<div class="manga-page-stack">' + pageMarkup + '</div>',
    '</article>',
    '<aside class="reader-v2-rail mobile-control">',
    '<div class="reader-chapter-inline" aria-label="Chapter controls">',
    '<button class="reader-icon-btn reader-icon-btn-mini" id="readerPrevInline" type="button" aria-label="Previous chapter">&lt;</button>',
    '<select id="readerChapterSelect" class="reader-chapter-select" aria-label="Choose chapter"></select>',
    '<button class="reader-icon-btn reader-icon-btn-mini" id="readerNextInline" type="button" aria-label="Next chapter">&gt;</button>',
    '</div>',
    '<nav class="reader-v2-icons" aria-label="Quick actions">',
    '<button class="reader-icon-btn" id="readerHomeBtn" type="button" aria-label="Home" title="Home"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l9 8h-3v9h-5v-6H11v6H6v-9H3z"/></svg></button>',
    '<button class="reader-icon-btn" id="readerTitleBtn" type="button" aria-label="Title page" title="Title page"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5a2 2 0 0 1 2-2h13v17H6a2 2 0 0 0-2 2V5zm3 1v11h10V6H7z"/></svg></button>',
    '<button class="reader-icon-btn" id="readerSettingsBtn" type="button" aria-label="Settings" title="Settings"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19.14 12.94a7.77 7.77 0 0 0 .05-.94 7.77 7.77 0 0 0-.05-.94l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.6-.22l-2.39.96a7.5 7.5 0 0 0-1.63-.94l-.36-2.54a.5.5 0 0 0-.5-.42h-3.84a.5.5 0 0 0-.5.42l-.36 2.54a7.5 7.5 0 0 0-1.63.94l-2.39-.96a.5.5 0 0 0-.6.22L2.71 8.84a.5.5 0 0 0 .12.64l2.03 1.58a7.77 7.77 0 0 0-.05.94c0 .32.02.63.05.94L2.83 14.52a.5.5 0 0 0-.12.64l1.92 3.32a.5.5 0 0 0 .6.22l2.39-.96c.5.39 1.05.71 1.63.94l.36 2.54a.5.5 0 0 0 .5.42h3.84a.5.5 0 0 0 .5-.42l.36-2.54c.58-.23 1.13-.55 1.63-.94l2.39.96a.5.5 0 0 0 .6-.22l1.92-3.32a.5.5 0 0 0-.12-.64l-2.03-1.58zM12 15.5A3.5 3.5 0 1 1 12 8a3.5 3.5 0 0 1 0 7.5z"/></svg></button>',
    '</nav>',
    '<section class="reader-settings-popup collapsed" id="readerSettingsPopup"></section>',
    '</aside>',
    '</div>',
    '<footer class="reader-v2-bottom mobile-control">',
    '<div class="reader-v2-meta"><button type="button" class="reader-link-btn" id="readerFooterTitle">' + escapeHtml(series.name) + '</button><span>' + escapeHtml(chapter.title) + '</span><button type="button" class="reader-link-btn" id="readerFooterHome">Home</button></div>',
    '<div class="reader-v2-nav"><button class="primary" id="readerPrevFooter" type="button">Previous Chapter</button><button class="primary" id="readerNextFooter" type="button">Next Chapter</button></div>',
    '</footer>',
    '</div>'
  ].join('');

  const chapterSelect = document.getElementById('readerChapterSelect');
  chapters.forEach((entry, position) => {
    const option = document.createElement('option');
    option.value = entry.key;
    option.textContent = 'Chapter ' + (position + 1);
    if (entry.key === chapter.key) option.selected = true;
    chapterSelect.appendChild(option);
  });

  const settingsPanel = document.getElementById('readerSettingsPopup');
  settingsPanel.innerHTML = buildMangaSettingsPanel();

  const themeSelect = settingsPanel.querySelector('#mangaThemeSelect');
  const pageWidthInput = settingsPanel.querySelector('#mangaPageWidth');
  const pageWidthValue = settingsPanel.querySelector('#mangaPageWidthValue');

  themeSelect.onchange = () => applyTheme(themeSelect.value || 'light');
  pageWidthInput.oninput = () => {
    state.pageWidth = Math.max(620, Math.min(1200, Number(pageWidthInput.value || state.pageWidth)));
    pageWidthValue.textContent = state.pageWidth + 'px';
    applyPageWidth();
    storePageWidth(state.pageWidth);
  };

  function goToChapter(targetChapter) {
    if (!targetChapter || !targetChapter.key) return;
    openChapter(series.name, targetChapter.key);
  }

  document.getElementById('readerHomeBtn').onclick = () => {
    state.view = 'home';
    state.activeSeries = '';
    render();
  };
  document.getElementById('readerFooterHome').onclick = () => {
    state.view = 'home';
    state.activeSeries = '';
    render();
  };
  document.getElementById('readerTitleBtn').onclick = () => {
    state.view = 'title';
    render();
  };
  document.getElementById('readerFooterTitle').onclick = () => {
    state.view = 'title';
    render();
  };
  document.getElementById('readerPrevInline').onclick = () => goToChapter(prevMeta);
  document.getElementById('readerNextInline').onclick = () => goToChapter(nextMeta);
  document.getElementById('readerPrevFooter').onclick = () => goToChapter(prevMeta);
  document.getElementById('readerNextFooter').onclick = () => goToChapter(nextMeta);
  document.getElementById('readerPrevInline').disabled = !prevMeta;
  document.getElementById('readerNextInline').disabled = !nextMeta;
  document.getElementById('readerPrevFooter').disabled = !prevMeta;
  document.getElementById('readerNextFooter').disabled = !nextMeta;
  chapterSelect.onchange = () => openChapter(series.name, chapterSelect.value);

  const settingsToggle = document.getElementById('readerSettingsBtn');
  settingsToggle.onclick = () => {
    settingsPanel.classList.toggle('collapsed');
  };
}

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeAttr(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

async function initialize() {
  renderMessage('Loading manga library...');
  try {
    await loadMangaLibrary();
    render();
  } catch (error) {
    renderMessage(error.message || 'Manga storage is unavailable.');
  }
}

initialize();
