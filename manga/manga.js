const state = {
  view: 'home',
  library: [],
  activeSeries: '',
  activeChapterKey: '',
};

const main = document.getElementById('main');
const importBtn = document.getElementById('importBtn');
const folderInput = document.getElementById('folderInput');

importBtn.addEventListener('click', () => {
  folderInput.value = '';
  folderInput.click();
});

folderInput.addEventListener('change', async (event) => {
  const files = Array.from(event.target.files || []).filter((file) => isImage(file.name));
  if (!files.length) {
    renderMessage('No image files found in selected folder.');
    return;
  }

  importBtn.disabled = true;
  importBtn.textContent = 'Importing...';
  renderMessage('Building manga library from folder...');

  try {
    state.library = await buildLibraryFromFiles(files);
    state.view = 'home';
    state.activeSeries = '';
    state.activeChapterKey = '';
    render();
  } finally {
    importBtn.disabled = false;
    importBtn.textContent = 'Import Manga Folder';
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
    chapter.pages.push({
      name: parts[parts.length - 1],
      src: dataUrl,
    });
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

function renderMessage(text) {
  main.innerHTML = '<div class="empty">' + escapeHtml(text) + '</div>';
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

function openSeries(seriesName) {
  state.view = 'chapters';
  state.activeSeries = seriesName;
  state.activeChapterKey = '';
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

function render() {
  if (!state.library.length) {
    renderMessage('Import a manga folder to start. Expected format: series/chapter-0001/001.jpg');
    return;
  }

  if (state.view === 'home') {
    renderHome();
    return;
  }
  if (state.view === 'chapters') {
    renderChapters();
    return;
  }
  renderReader();
}

function renderHome() {
  const cards = state.library.map((series) => {
    const latest = series.chapters[series.chapters.length - 1];
    const latestText = latest ? latest.title : 'No chapters found';
    return [
      '<article class="card">',
      '<h3>' + escapeHtml(series.name) + '</h3>',
      '<p>' + series.chapters.length + ' chapter(s)</p>',
      '<p>Latest: ' + escapeHtml(latestText) + '</p>',
      '<div class="row" style="margin-top:10px;">',
      '<button type="button" data-open-series="' + escapeAttr(series.name) + '">Open series</button>',
      '</div>',
      '</article>',
    ].join('');
  }).join('');

  main.innerHTML = [
    '<section>',
    '<div class="row" style="justify-content:space-between;">',
    '<h2 style="margin:0;">Manga Library</h2>',
    '<span class="meta">' + state.library.length + ' series</span>',
    '</div>',
    '<div class="grid">' + cards + '</div>',
    '</section>',
  ].join('');

  main.querySelectorAll('[data-open-series]').forEach((btn) => {
    btn.addEventListener('click', () => openSeries(btn.getAttribute('data-open-series') || ''));
  });
}

function renderChapters() {
  const series = getSeries(state.activeSeries);
  if (!series) {
    state.view = 'home';
    render();
    return;
  }

  const chapterButtons = series.chapters.map((chapter) => {
    return '<button class="chapter-btn" type="button" data-open-chapter="' + escapeAttr(chapter.key) + '">' + escapeHtml(chapter.title) + ' (' + chapter.pages.length + ' pages)</button>';
  }).join('');

  main.innerHTML = [
    '<section>',
    '<div class="row" style="justify-content:space-between;">',
    '<div>',
    '<button class="ghost" type="button" id="backHome">Back</button>',
    '<h2 style="margin:10px 0 0;">' + escapeHtml(series.name) + '</h2>',
    '</div>',
    '<span class="meta">No volumes</span>',
    '</div>',
    '<div class="chapter-list">' + chapterButtons + '</div>',
    '</section>',
  ].join('');

  const backHome = document.getElementById('backHome');
  if (backHome) backHome.addEventListener('click', () => {
    state.view = 'home';
    state.activeSeries = '';
    render();
  });

  main.querySelectorAll('[data-open-chapter]').forEach((btn) => {
    btn.addEventListener('click', () => openChapter(series.name, btn.getAttribute('data-open-chapter') || ''));
  });
}

function renderReader() {
  const series = getSeries(state.activeSeries);
  const chapter = getActiveChapter();
  if (!series || !chapter) {
    state.view = 'chapters';
    render();
    return;
  }

  const chapters = getActiveSeriesChapters();
  const idx = chapters.findIndex((item) => item.key === chapter.key);
  const prevDisabled = idx <= 0 ? 'disabled' : '';
  const nextDisabled = idx >= chapters.length - 1 ? 'disabled' : '';

  const pageMarkup = chapter.pages.map((page) => {
    return '<img loading="lazy" decoding="async" alt="' + escapeAttr(chapter.title + ' page ' + page.name) + '" src="' + page.src + '" />';
  }).join('');

  main.innerHTML = [
    '<section>',
    '<div class="reader-head">',
    '<div>',
    '<button class="ghost" type="button" id="backChapters">Back to chapters</button>',
    '<h2 style="margin:10px 0 0;">' + escapeHtml(series.name) + ' • ' + escapeHtml(chapter.title) + '</h2>',
    '<div class="meta">' + chapter.pages.length + ' page(s)</div>',
    '</div>',
    '<div class="row">',
    '<button type="button" id="prevChapter" ' + prevDisabled + '>Previous chapter</button>',
    '<button type="button" id="nextChapter" ' + nextDisabled + '>Next chapter</button>',
    '</div>',
    '</div>',
    '<div class="page-stack">' + pageMarkup + '</div>',
    '</section>',
  ].join('');

  const backChapters = document.getElementById('backChapters');
  if (backChapters) backChapters.addEventListener('click', () => {
    state.view = 'chapters';
    state.activeChapterKey = '';
    render();
  });

  const prev = document.getElementById('prevChapter');
  const next = document.getElementById('nextChapter');
  if (prev) prev.addEventListener('click', () => moveChapter(-1));
  if (next) next.addEventListener('click', () => moveChapter(1));
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
