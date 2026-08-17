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
  main.innerHTML = '<section class="manga-shell"><div class="manga-empty">' + escapeHtml(text) + '</div></section>';
}

function render() {
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
  const cards = state.library.map((series) => {
    const latest = series.chapters[series.chapters.length - 1];
    const latestText = latest ? latest.title : 'No chapters found';
    return [
      '<article class="manga-card">',
      '<h3>' + escapeHtml(series.name) + '</h3>',
      '<p>' + series.chapters.length + ' chapter(s)</p>',
      '<p>Latest: ' + escapeHtml(latestText) + '</p>',
      '<div class="manga-row">',
      '<button type="button" data-open-series="' + escapeAttr(series.name) + '">Open title page</button>',
      '</div>',
      '</article>',
    ].join('');
  }).join('');

  main.innerHTML = [
    '<section class="manga-shell">',
    '<div class="manga-panel">',
    '<h2 class="manga-title">Manga Home</h2>',
    '<div class="manga-muted">Showing all manga titles</div>',
    '</div>',
    '<div class="manga-grid">' + cards + '</div>',
    '</section>',
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
      '<div class="manga-chapter-item">',
      '<div>',
      '<p class="manga-chapter-title">' + escapeHtml(chapter.title) + '</p>',
      '<div class="manga-muted">' + chapter.pages.length + ' page(s)</div>',
      '</div>',
      '<button type="button" data-open-chapter="' + escapeAttr(chapter.key) + '">Read</button>',
      '</div>'
    ].join('');
  }).join('');

  main.innerHTML = [
    '<section class="manga-shell">',
    '<div class="manga-panel">',
    '<div class="manga-row" style="justify-content:space-between;">',
    '<div>',
    '<button class="subtle" type="button" id="titleBackHome">Back home</button>',
    '<h2 class="manga-title">' + escapeHtml(series.name) + '</h2>',
    '<div class="manga-muted">Title page • no volumes</div>',
    '</div>',
    '<div class="manga-muted">' + chapters.length + ' total chapters</div>',
    '</div>',
    '</div>',
    '<div class="manga-panel">',
    '<div class="manga-chapter-list">' + rows + '</div>',
    '<div class="manga-pagination" style="margin-top:12px;">',
    '<button type="button" id="pagePrev" ' + (state.chapterPage <= 0 ? 'disabled' : '') + '>Previous 10</button>',
    '<div class="manga-muted">Page ' + (state.chapterPage + 1) + ' of ' + totalPages + '</div>',
    '<button type="button" id="pageNext" ' + (state.chapterPage >= totalPages - 1 ? 'disabled' : '') + '>Next 10</button>',
    '</div>',
    '</div>',
    '</section>',
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
    '<section class="manga-shell">',
    chapterPickerMarkup,
    state.settingsOpen ? '<div class="manga-settings-panel"><strong>Settings</strong><div class="manga-muted" style="margin-top:6px;">Under dev</div></div>' : '',
    '<div class="manga-panel">',
    '<div class="manga-row" style="justify-content:space-between;">',
    '<div>',
    '<h2 class="manga-title" style="margin-top:0;">' + escapeHtml(series.name) + ' • ' + escapeHtml(chapter.title) + '</h2>',
    '<div class="manga-muted">' + chapter.pages.length + ' page(s)</div>',
    '</div>',
    '<div class="manga-row">',
    '<button type="button" id="prevChapter" ' + prevDisabled + '>Previous chapter</button>',
    '<button type="button" id="nextChapter" ' + nextDisabled + '>Next chapter</button>',
    '</div>',
    '</div>',
    '</div>',
    '<div class="manga-page-stack">' + pageMarkup + '</div>',
    '</section>',
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
