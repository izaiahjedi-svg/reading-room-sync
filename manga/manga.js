const CHAPTERS_PER_PAGE = 10;

const state = {
  view: 'home',
  library: [],
  activeSeries: '',
  activeChapterKey: '',
  chapterPage: 0,
  settingsOpen: false,
  chapterPickerOpen: false,
  importing: false,
};

const main = document.getElementById('main');
const topbarActions = document.getElementById('topbarActions');
const folderInput = document.getElementById('folderInput');

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
    state.view = 'home';
    state.activeSeries = '';
    state.activeChapterKey = '';
    state.chapterPage = 0;
    state.settingsOpen = false;
    render();
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

    const dataUrl = await readFileAsDataUrl(file);
    chapter.pages.push({ name: parts[parts.length - 1], src: dataUrl });
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
  state.settingsOpen = false;
  state.chapterPickerOpen = false;
  render();
}

function openChapter(seriesName, chapterKey) {
  state.view = 'reader';
  state.activeSeries = seriesName;
  state.activeChapterKey = chapterKey;
  state.settingsOpen = false;
  state.chapterPickerOpen = false;
  render();
  window.scrollTo(0, 0);
}

function moveChapter(direction) {
  const chapters = getActiveSeriesChapters();
  const idx = chapters.findIndex((chapter) => chapter.key === state.activeChapterKey);
  const nextIdx = idx + direction;
  if (nextIdx < 0 || nextIdx >= chapters.length) return;
  state.activeChapterKey = chapters[nextIdx].key;
  state.settingsOpen = false;
  state.chapterPickerOpen = false;
  render();
  window.scrollTo(0, 0);
}

function renderTopbar() {
  topbarActions.innerHTML = '';

  const importBtn = document.createElement('button');
  importBtn.type = 'button';
  importBtn.className = 'primary';
  importBtn.textContent = state.importing ? 'Importing...' : 'Import Manga Folder';
  importBtn.disabled = state.importing;
  importBtn.onclick = openFolderPicker;

  if (state.view === 'reader') {
    const chapterTag = document.createElement('button');
    chapterTag.type = 'button';
    chapterTag.className = 'subtle';
    chapterTag.disabled = false;
    const chapter = getActiveChapter();
    chapterTag.textContent = chapter ? chapter.title : 'Chapter';
    chapterTag.onclick = () => {
      state.chapterPickerOpen = !state.chapterPickerOpen;
      render();
    };

    const homeBtn = document.createElement('button');
    homeBtn.type = 'button';
    homeBtn.className = 'subtle';
    homeBtn.textContent = 'Home';
    homeBtn.onclick = () => {
      state.view = 'home';
      state.settingsOpen = false;
      state.chapterPickerOpen = false;
      render();
    };

    const titleBtn = document.createElement('button');
    titleBtn.type = 'button';
    titleBtn.className = 'subtle';
    titleBtn.textContent = 'Title';
    titleBtn.onclick = () => {
      state.view = 'title';
      state.settingsOpen = false;
      state.chapterPickerOpen = false;
      render();
    };

    const settingsBtn = document.createElement('button');
    settingsBtn.type = 'button';
    settingsBtn.className = 'subtle';
    settingsBtn.textContent = 'Settings';
    settingsBtn.onclick = () => {
      state.settingsOpen = !state.settingsOpen;
      state.chapterPickerOpen = false;
      render();
    };

    topbarActions.append(chapterTag, homeBtn, titleBtn, settingsBtn, importBtn);
    return;
  }

  topbarActions.append(importBtn);
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
  const latestBySeries = state.library
    .map((series) => {
      const latest = series.chapters[series.chapters.length - 1] || null;
      return { name: series.name, count: series.chapters.length, latest };
    })
    .sort((a, b) => naturalCompare(a.name, b.name));

  const latestCards = latestBySeries.slice(0, 6).map((entry) => {
    const latestText = entry.latest ? entry.latest.title : 'No chapters found';
    return [
      '<button type="button" class="home-title-card" data-open-series="' + escapeAttr(entry.name) + '">',
      '<div class="home-cover"></div>',
      '<div class="home-card-body">',
      '<p class="home-card-title">' + escapeHtml(entry.name) + '</p>',
      '<div class="home-card-meta"><span>' + entry.count + ' chapters</span><span>Latest ' + escapeHtml(latestText) + '</span></div>',
      '</div>',
      '</button>'
    ].join('');
  }).join('');

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
    '<section class="home-hero">',
    '<div class="home-section-head"><h2>Manga Reading Room</h2><span class="home-subtle">Showing all manga titles</span></div>',
    '<div class="home-status-grid">',
    '<div class="home-status-card"><span class="k">Library</span><span class="v">' + state.library.length + ' titles</span></div>',
    '<div class="home-status-card"><span class="k">Chapters</span><span class="v">' + latestBySeries.reduce((sum, row) => sum + row.count, 0) + ' total</span></div>',
    '<div class="home-status-card"><span class="k">Format</span><span class="v">No volumes</span></div>',
    '</div>',
    '</section>',
    '<section class="home-section">',
    '<div class="home-section-head"><h2>Latest Updates</h2><span class="home-subtle">Recent title activity</span></div>',
    '<div class="home-card-grid">' + latestCards + '</div>',
    '</section>',
    '<section class="home-section">',
    '<div class="home-section-head"><h2>All Manga</h2></div>',
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
  const prevDisabled = idx <= 0 ? 'disabled' : '';
  const nextDisabled = idx >= chapters.length - 1 ? 'disabled' : '';
  const pageMarkup = chapter.pages
    .map((page) => '<img loading="lazy" decoding="async" alt="' + escapeAttr(chapter.title + ' page ' + page.name) + '" src="' + page.src + '" />')
    .join('');

  const chapterPickerMarkup = (() => {
    if (!state.chapterPickerOpen) return '';
    const chapterOptions = chapters.map((item) => {
      const selected = item.key === chapter.key ? ' selected' : '';
      return '<option value="' + escapeAttr(item.key) + '"' + selected + '>' + escapeHtml(item.title) + '</option>';
    }).join('');
    return [
      '<div class="manga-settings-panel" id="chapterPickerPanel">',
      '<strong>Chapter Picker</strong>',
      '<div class="manga-row" style="margin-top:8px;">',
      '<select id="chapterPickerSelect">' + chapterOptions + '</select>',
      '<button type="button" id="chapterPickerGo">Go</button>',
      '</div>',
      '</div>'
    ].join('');
  })();

  main.innerHTML = [
    '<div class="reader-v2">',
    '<div class="reader-v2-shell">',
    chapterPickerMarkup,
    state.settingsOpen ? '<div class="manga-settings-panel"><strong>Settings</strong><div class="manga-muted" style="margin-top:6px;">Under dev</div></div>' : '',
    '<article class="reader-content reader-content-v2">',
    '<div class="reader-content-head"><div class="reader-kicker">Manga Chapter</div><h1>' + escapeHtml(series.name) + ' • ' + escapeHtml(chapter.title) + '</h1></div>',
    '<div class="manga-page-stack">' + pageMarkup + '</div>',
    '</article>',
    '<div class="reader-v2-bottom">',
    '<div class="reader-v2-meta"><span>' + chapter.pages.length + ' page(s)</span></div>',
    '<div class="reader-v2-nav">',
    '<button type="button" id="prevChapter" ' + prevDisabled + '>Previous Chapter</button>',
    '<button type="button" id="nextChapter" ' + nextDisabled + '>Next Chapter</button>',
    '</div>',
    '</div>',
    '</div>',
    '</div>'
  ].join('');

  const prev = document.getElementById('prevChapter');
  const next = document.getElementById('nextChapter');
  if (prev) prev.addEventListener('click', () => moveChapter(-1));
  if (next) next.addEventListener('click', () => moveChapter(1));

  const chapterPickerGo = document.getElementById('chapterPickerGo');
  const chapterPickerSelect = document.getElementById('chapterPickerSelect');
  if (chapterPickerGo && chapterPickerSelect) {
    chapterPickerGo.addEventListener('click', () => {
      const nextKey = (chapterPickerSelect.value || '').trim();
      if (!nextKey || nextKey === chapter.key) {
        state.chapterPickerOpen = false;
        render();
        return;
      }
      openChapter(series.name, nextKey);
    });
  }
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

render();
