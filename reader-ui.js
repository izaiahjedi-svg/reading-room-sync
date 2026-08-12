async function init(){
  if (routeBookSlug) {
    await migrateScopedLibraryToGlobal(routeBookSlug);
  }
  const [idx, profilesData, profileStateData, booksMetaData] = await dataBridge.loadBootstrapState();
  index = Array.isArray(idx) ? idx.map(normalizeChapterIndexEntry) : [];
  booksMeta = (booksMetaData && typeof booksMetaData === 'object') ? booksMetaData : {};
  const defaults = getDefaultProfiles();
  profiles = (profilesData && typeof profilesData === 'object')
    ? Object.assign({}, defaults, profilesData)
    : defaults;
  if (profileStateData && typeof profileStateData === 'object') {
    profileState = profileStateData;
  }
  Object.keys(profiles).forEach(id => {
    if (!profileState[id]) {
      profileState[id] = {
        progress: { lastChapterId:null, percents:{} },
        settings: getDefaultProfileSettings()
      };
    }
  });
  const storedProfileId = getStoredActiveProfileId();
  activeProfileId = profiles[storedProfileId] ? storedProfileId : 'izaiah';
  storeActiveProfileId(activeProfileId);
  if (routeBookSlug) view.booksCollapsed = true;
  setSyncKey(getSyncKeyFromUrl() || getStoredSyncKey());
  applyTheme();
  renderTopbar();
  render();

  persistProfileState().catch((e) => {
    console.warn('Initial profile state save failed', e);
  });

  if (syncKey) {
    const syncTask = routeBookSlug ? syncBridge.pullLibrary() : syncBridge.pullLibrary({ metaOnly:true });
    syncTask.catch((e) => {
      console.warn('Initial remote sync failed', e);
    });
    const stateTask = syncBridge.pullProfileState(activeProfileId);
    stateTask.catch((e) => {
      console.warn('Initial remote state sync failed', e);
    });
  }

  window.addEventListener('focus', () => {
    if (syncKey) refreshActiveProfileStateFromRemote('focus').catch(() => {});
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && syncKey) {
      refreshActiveProfileStateFromRemote('visible').catch(() => {});
    }
  });

  if (!routeBookSlug) {
    setTimeout(() => {
      cleanupLegacyScopedKeys().catch((e) => {
        console.warn('Initial scoped cleanup failed', e);
        addSyncEvent('cleanup-fail', 'Initial scoped cleanup failed');
      });
    }, 600);
  }
}

fileInput.addEventListener('change', (e) => handleUpload(e.target.files, fileInput));
folderInput.addEventListener('change', (e) => handleUpload(e.target.files, folderInput));
coverInput.addEventListener('change', async (e) => {
  const file = (e.target.files && e.target.files[0]) ? e.target.files[0] : null;
  if (!file) return;
  pendingCoverDataUrl = await readCoverAsDataUrl(file);
  renderBookCoverPreview();
  coverInput.value = '';
});

function getAddModalBookValue(){
  const select = document.getElementById('addBookSelect');
  const input = document.getElementById('addBookNewInput');
  if (!select || !input) return '';
  if (select.value === '__new__') return (input.value || '').trim();
  return (select.value || '').trim();
}

function openAddChapterModal(prefillBook){
  const modal = document.getElementById('addModal');
  const backdrop = document.getElementById('addModalBackdrop');
  const select = document.getElementById('addBookSelect');
  const newBookInput = document.getElementById('addBookNewInput');
  const volumeInput = document.getElementById('addVolumeInput');
  const chooseFilesBtn = document.getElementById('addChooseFilesBtn');
  const chooseFolderBtn = document.getElementById('addChooseFolderBtn');
  const closeBtn = document.getElementById('addModalCloseBtn');
  const books = getAllBookNames();

  select.innerHTML = '';
  const blank = document.createElement('option');
  blank.value = '';
  blank.textContent = 'Unassigned';
  select.appendChild(blank);
  books.forEach((name) => {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = getBookLabel(name);
    select.appendChild(opt);
  });
  const addNew = document.createElement('option');
  addNew.value = '__new__';
  addNew.textContent = '+ New book';
  select.appendChild(addNew);

  if (prefillBook && books.includes(prefillBook)) {
    select.value = prefillBook;
  } else if (prefillBook && !books.includes(prefillBook)) {
    select.value = '__new__';
    newBookInput.value = prefillBook;
  } else {
    select.value = '';
    newBookInput.value = '';
  }
  volumeInput.value = '';
  newBookInput.style.display = select.value === '__new__' ? 'block' : 'none';

  const close = () => {
    modal.classList.remove('open');
    backdrop.classList.remove('open');
    select.onchange = null;
    chooseFilesBtn.onclick = null;
    chooseFolderBtn.onclick = null;
    closeBtn.onclick = null;
    backdrop.onclick = null;
  };

  select.onchange = () => {
    newBookInput.style.display = select.value === '__new__' ? 'block' : 'none';
    if (select.value !== '__new__') newBookInput.value = '';
  };

  const beginUpload = (useFolder) => {
    const chosenBook = getAddModalBookValue();
    const chosenVolume = (volumeInput.value || '').trim();
    if (select.value === '__new__' && !chosenBook) {
      alert('Enter a new book name first.');
      return;
    }
    pendingChapterTitle = '';
    pendingUploadBook = chosenBook;
    pendingUploadVolume = chosenVolume;
    close();
    if (useFolder) folderInput.click();
    else fileInput.click();
  };

  chooseFilesBtn.onclick = () => beginUpload(false);
  chooseFolderBtn.onclick = () => beginUpload(true);
  closeBtn.onclick = close;
  backdrop.onclick = close;
  modal.classList.add('open');
  backdrop.classList.add('open');
}

function startAddChapter(){
  pendingChapterTitle = '';
  pendingUploadBook = '';
  pendingUploadVolume = '';
  openAddChapterModal('');
}

function startAddChapterToBook(bookName){
  pendingChapterTitle = '';
  openAddChapterModal((bookName || '').trim());
}

function returnToLibrary(){
  view.mode = 'library';
  view.mobileChromeCollapsed = false;
  view.chapterId = null;
  view.bookFilter = '';
  view.search = '';
  view.settingsOpen = false;
  view.sidebarOpen = false;
  renderTopbar();
  render();
  window.scrollTo(0, 0);
  if (syncKey) {
    refreshActiveProfileStateFromRemote('return').catch(() => {});
  }
}

async function handleUpload(fileList, inputEl){
  const files = Array.from(fileList || []).filter(f => /\.txt$/i.test(f.name));
  if (!files.length){ inputEl.value = ''; return; }

  const failed = [];
  let addedCount = 0;
  let remoteChapterFailed = 0;
  const progressLabel = view.mode === 'library' ? showUploadProgress(files.length) : null;

  for (let i=0; i<files.length; i++){
    const file = files[i];
    if (progressLabel) progressLabel(i+1, files.length, file.name);
    const text = await file.text();
    const stem = file.name.replace(/\.txt$/i, '');
    const requestedTitle = pendingChapterTitle && files.length === 1 ? pendingChapterTitle : '';
    const title = (requestedTitle || stem).trim() || stem;
    const detectedBook = detectBook(file);
    const book = pendingUploadBook || detectedBook || null;
    const volume = detectVolume(file) || pendingUploadVolume || null;
    const uploadedAtUtc = toUtcIsoNow();
    const id = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()+Math.random()));
    const saveOk = await dataBridge.saveChapter(id, { title, content: text });
    if (!saveOk){
      failed.push(file.name);
      continue;
    }
    if (syncKey) {
      const chapterPushed = await syncBridge.pushChapter(id, { title, content: text });
      if (!chapterPushed) remoteChapterFailed++;
    }
    index.push({ id, title, book, volume, addedAt: Date.now(), updatedAtUtc: uploadedAtUtc });
    addedCount++;
    if (files.length > 10) await new Promise(res => setTimeout(res, 120));
  }

  if (addedCount){
    index.sort(sortChapters);
    const indexOk = await dataBridge.saveIndex(index);
    if (!indexOk){
      alert('Chapters were saved individually, but the library list failed to update. Try refreshing the page — your chapters should still be there — and if the list looks incomplete, add the missing ones again.');
    }
  }
  let librarySyncOk = true;
  if (syncKey) {
    librarySyncOk = await syncBridge.pushLibrary();
    if (!librarySyncOk || remoteChapterFailed > 0) {
      addSyncEvent('upload-retry', 'Upload sync incomplete; running chapter backfill retry');
      await backfillRemoteChapters({ allowScoped:true });
    }
  }
  if (progressLabel) progressLabel(null);
  pendingChapterTitle = '';
  pendingUploadBook = '';
  pendingUploadVolume = '';
  inputEl.value = '';
  render();

  if (failed.length){
    alert('Saved ' + addedCount + ' of ' + files.length + ' chapters.\n\n' +
      'These failed to save (likely a temporary connection issue) — try adding them again:\n' +
      failed.slice(0, 20).join('\n') + (failed.length > 20 ? '\n…and ' + (failed.length-20) + ' more' : ''));
  } else if (syncKey && (!librarySyncOk || remoteChapterFailed > 0)) {
    alert('Chapters were saved locally, but cloud sync needs a retry. The app started a background backfill pass to recover missed chapters.');
  }
}

function readFileAsDataUrl(file){
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

async function readCoverAsDataUrl(file){
  const sourceDataUrl = await readFileAsDataUrl(file);
  let image;
  try {
    image = await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Invalid image file'));
      img.src = sourceDataUrl;
    });
  } catch (e) {
    return sourceDataUrl;
  }

  const maxWidth = 720;
  const maxHeight = 1080;
  const scale = Math.min(1, maxWidth / image.width, maxHeight / image.height);
  const targetWidth = Math.max(1, Math.round(image.width * scale));
  const targetHeight = Math.max(1, Math.round(image.height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = targetWidth;
  canvas.height = targetHeight;
  const ctx = canvas.getContext('2d');
  if (!ctx) return sourceDataUrl;

  ctx.drawImage(image, 0, 0, targetWidth, targetHeight);

  const jpeg = canvas.toDataURL('image/jpeg', 0.82);
  if (typeof jpeg === 'string' && jpeg.length > 1000) return jpeg;
  return sourceDataUrl;
}

function showUploadProgress(total){
  const el = document.createElement('div');
  el.style.cssText = 'position:fixed;bottom:16px;left:50%;transform:translateX(-50%);z-index:40;background:var(--paper-raised);border:1px solid var(--line);border-radius:6px;padding:10px 16px;font-size:13px;box-shadow:var(--shadow);color:var(--ink);';
  document.body.appendChild(el);
  return function(current, tot, name){
    if (current === null){ el.remove(); return; }
    el.textContent = 'Saving chapter ' + current + ' of ' + tot + '… (' + name + ')';
  };
}

function detectVolume(file){
  const rel = file.webkitRelativePath;
  if (!rel) return null;
  const parts = rel.split('/');
  if (parts.length >= 3) return parts[1];
  if (parts.length >= 2 && pendingUploadBook) return parts[0];
  return null;
}

function detectBook(file){
  const rel = file.webkitRelativePath;
  if (!rel) return null;
  const parts = rel.split('/');
  if (parts.length >= 1) return parts[0];
  return null;
}

function volumeSortNum(name){
  const m = (name || '').match(/(\d{1,4})/);
  return m ? parseInt(m[1], 10) : null;
}

function bookSortNum(name){
  const m = (name || '').match(/(\d{1,4})/);
  return m ? parseInt(m[1], 10) : null;
}

function sortChapters(a, b){
  const ab = a.book || '', bb = b.book || '';
  if (ab !== bb){
    const an = bookSortNum(ab), bn = bookSortNum(bb);
    if (an != null && bn != null && an !== bn) return an - bn;
    return ab.localeCompare(bb);
  }
  const av = a.volume || '', bv = b.volume || '';
  if (av !== bv){
    const an = volumeSortNum(av), bn = volumeSortNum(bv);
    if (an != null && bn != null && an !== bn) return an - bn;
    return av.localeCompare(bv);
  }
  return a.addedAt - b.addedAt;
}

async function deleteChapter(id, evt){
  if (evt) evt.stopPropagation();
  if (!confirm('Remove this chapter from your library? This cannot be undone.')) return;
  index = index.filter(c => c.id !== id);
  await dataBridge.saveIndex(index);
  await dataBridge.deleteChapter(id);
  const progress = getProgress();
  if (progress.percents[id] != null) delete progress.percents[id];
  if (progress.lastChapterId === id) progress.lastChapterId = null;
  await persistProfileState();
  if (syncKey) await syncBridge.pushLibrary({ forceReplace:true });
  render();
}

async function renameChapter(id){
  const chapter = index.find(c => c.id === id);
  if (!chapter) return;
  const nextTitle = prompt('Edit chapter title', chapter.title);
  if (nextTitle === null) return;
  const title = (nextTitle || '').trim();
  if (!title) return;
  chapter.title = title;
  await dataBridge.saveIndex(index);
  const data = await dataBridge.getChapter(id);
  if (data) {
    await dataBridge.saveChapter(id, { ...data, title });
    if (syncKey) await syncBridge.pushChapter(id, { ...data, title });
  }
  if (syncKey) await syncBridge.pushLibrary();
  render();
}

async function editChapter(id){
  const chapter = index.find(c => c.id === id);
  if (!chapter) return;
  const modal = document.getElementById('editModal');
  const backdrop = document.getElementById('editModalBackdrop');
  const bookInput = document.getElementById('editBook');
  const volumeInput = document.getElementById('editVolume');
  const titleInput = document.getElementById('editTitle');
  const cancelBtn = document.getElementById('editModalCancelBtn');
  const saveBtn = document.getElementById('editModalSaveBtn');

  bookInput.value = chapter.book || '';
  volumeInput.value = chapter.volume || '';
  titleInput.value = chapter.title || '';

  modal.classList.add('open');
  backdrop.classList.add('open');
  titleInput.focus();

  const closeModal = () => {
    modal.classList.remove('open');
    backdrop.classList.remove('open');
    cancelBtn.onclick = null;
    saveBtn.onclick = null;
    backdrop.onclick = null;
  };

  const handleSave = async () => {
    const book = (bookInput.value || '').trim() || null;
    const volume = (volumeInput.value || '').trim() || null;
    const title = (titleInput.value || '').trim();

    if (!title) {
      alert('Title cannot be empty');
      return;
    }

    chapter.book = book;
    chapter.volume = volume;
    chapter.title = title;

    index.sort(sortChapters);
    await dataBridge.saveIndex(index);

    const data = await dataBridge.getChapter(id);
    if (data) {
      await dataBridge.saveChapter(id, { ...data, title });
      if (syncKey) await syncBridge.pushChapter(id, { ...data, title });
    }

    if (syncKey) await syncBridge.pushLibrary();

    closeModal();
    render();
  };

  cancelBtn.onclick = closeModal;
  saveBtn.onclick = handleSave;
  backdrop.onclick = closeModal;
  titleInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleSave();
    else if (e.key === 'Escape') closeModal();
  });
}

async function exportLibrary(){
  const btn = document.getElementById('exportBtn');
  if (btn){ btn.disabled = true; btn.textContent = 'Preparing…'; }
  try{
    const chapters = {};
    for (const ch of index){
      const data = await dataBridge.getChapter(ch.id);
      if (data) chapters[ch.id] = data;
    }
    const payload = {
      version:1,
      exportedAt: Date.now(),
      index,
      chapters,
      progress: getProgress(),
      settings: getSettings(),
      booksMeta,
    };
    const blob = new Blob([JSON.stringify(payload)], { type:'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'reading-room-library.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }catch(e){
    alert('Export failed: ' + e.message);
  }
  if (btn){ btn.disabled = false; btn.textContent = 'Export library'; }
}

importInput.addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  importInput.value = '';
  if (!file) return;
  let payload;
  try{
    payload = JSON.parse(await file.text());
  }catch(e){
    alert('That file doesn\'t look like a valid library export.');
    return;
  }
  if (!payload || !Array.isArray(payload.index) || !payload.chapters){
    alert('That file doesn\'t look like a valid library export.');
    return;
  }
  const mode = confirm(
    'Import ' + payload.index.length + ' chapter(s).\n\n' +
    'Press OK to MERGE with your current library (existing chapters kept, new ones added).\n' +
    'Press Cancel to REPLACE your current library entirely.'
  ) ? 'merge' : 'replace';

  const progress = getProgress();
  if (mode === 'replace') { index = []; progress.lastChapterId = null; progress.percents = {}; }
  if (mode === 'replace') booksMeta = {};

  const existingKey = (c) => (c.book || '') + '::' + (c.volume || '') + '::' + c.title;
  const existingTitles = new Set(index.map(existingKey));
  let added = 0;
  for (const entry of payload.index){
    const entryKey = (entry.book || '') + '::' + (entry.volume || '') + '::' + entry.title;
    if (mode === 'merge' && existingTitles.has(entryKey)) continue;
    const newId = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()+Math.random()));
    const data = payload.chapters[entry.id];
    if (!data) continue;
    await dataBridge.saveChapter(newId, data);
    index.push({ id:newId, title:entry.title, book:entry.book||null, volume:entry.volume||null, addedAt:Date.now(), updatedAtUtc:toUtcIsoNow() });
    if (payload.progress && payload.progress.percents && payload.progress.percents[entry.id] != null){
      progress.percents[newId] = payload.progress.percents[entry.id];
      if (payload.progress.lastChapterId === entry.id) progress.lastChapterId = newId;
    }
    added++;
  }
  if (payload.booksMeta && typeof payload.booksMeta === 'object') {
    booksMeta = mode === 'merge' ? Object.assign({}, booksMeta, payload.booksMeta) : payload.booksMeta;
    await persistBooksMeta();
  }
  index.sort(sortChapters);
  await dataBridge.saveIndex(index);
  if (payload.settings){
    const settings = getSettings();
    Object.assign(settings, payload.settings);
    applyTheme();
  }
  await persistProfileState();
  if (syncKey) await syncBridge.pushLibrary(mode === 'replace' ? { forceReplace:true } : undefined);
  view.transferOpen = false;
  render();
  alert('Imported ' + added + ' chapter(s).');
});

function renderTopbar(){
  topbarActions.innerHTML = '';
  const profileSwitcher = document.createElement('div');
  profileSwitcher.className = 'profile-switcher';
  const profileLabel = document.createElement('span');
  profileLabel.className = 'visually-hidden';
  profileLabel.textContent = 'Profile';
  const profileSelect = document.createElement('select');
  profileSelect.className = 'profile-select';
  profileSelect.setAttribute('aria-label', 'Profile');
  Object.entries(profiles).forEach(([id, profile]) => {
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = profile.name;
    if (id === activeProfileId) opt.selected = true;
    profileSelect.appendChild(opt);
  });
  profileSelect.onchange = () => switchProfile(profileSelect.value);
  profileSwitcher.append(profileLabel, profileSelect);

  if (view.mode === 'library'){
    if (routeBookSlug) {
      brandTitle.textContent = '← All Books';
      brandTitle.style.cursor = 'pointer';
      brandTitle.onclick = () => { window.location.href = getMainLibraryPath(); };
    } else {
      brandTitle.textContent = 'Reading Room';
      brandTitle.style.cursor = '';
      brandTitle.onclick = null;
    }
    const settings = getSettings();
    const darkBadge = document.createElement('button');
    darkBadge.className = 'subtle';
    darkBadge.textContent = (settings.theme || 'dark') === 'dark' ? 'Dark ✓' : 'Light';
    darkBadge.title = 'Toggle light/dark theme';
    darkBadge.onclick = async () => {
      settings.theme = (settings.theme || 'dark') === 'dark' ? 'light' : 'dark';
      applyTheme();
      await dataBridge.saveProfileState();
      if (syncKey) await syncBridge.pushLibrary();
      renderTopbar();
    };
    const addBtn = document.createElement('button');
    addBtn.className = 'primary';
    addBtn.textContent = '+ Add chapter';
    addBtn.onclick = () => startAddChapter();
    const debugBtn = document.createElement('button');
    debugBtn.className = 'subtle';
    debugBtn.textContent = view.debugOpen ? 'Debug ✓' : 'Debug';
    debugBtn.title = 'Show sync and storage diagnostics';
    debugBtn.onclick = () => {
      view.debugOpen = !view.debugOpen;
      if (view.debugOpen && !routeBookSlug) refreshMainPageDebug();
      render();
    };
    const moreBtn = document.createElement('button');
    moreBtn.className = 'icon-btn subtle';
    moreBtn.title = 'Export or import your library';
    moreBtn.textContent = '⇅';
    moreBtn.onclick = () => { view.transferOpen = !view.transferOpen; render(); };
    const syncBtn = document.createElement('button');
    syncBtn.className = 'subtle';
    syncBtn.textContent = syncKey ? 'Sync ✓' : 'Sync';
    syncBtn.onclick = async () => {
      const ok = await syncBridge.configureKey(true);
      if (ok) {
        alert('Sync key set. Open this same site on your phone with ?sync=' + syncKey + ' to pull the library over.');
      }
    };
    const syncStatusChip = document.createElement('button');
    syncStatusChip.className = 'subtle sync-chip';
    syncStatusChip.id = 'syncStatusChip';
    syncStatusChip.disabled = true;
    syncStatusChip.textContent = getSyncStatusText();
    syncStatusChip.title = syncStatus.message || 'Sync status';
    if (routeBookSlug) topbarActions.append(profileSwitcher, darkBadge, syncStatusChip, moreBtn, syncBtn, addBtn);
    else topbarActions.append(profileSwitcher, darkBadge, syncStatusChip, debugBtn, moreBtn, syncBtn, addBtn);
  } else {
    brandTitle.textContent = routeBookSlug ? '← Book Page' : '← Library';
    brandTitle.style.cursor = 'pointer';
    brandTitle.onclick = returnToLibrary;
    if (routeBookSlug){
      const booksBtn = document.createElement('button');
      booksBtn.className = 'subtle';
      booksBtn.textContent = 'All Books';
      booksBtn.onclick = () => { window.location.href = getMainLibraryPath(); };
      topbarActions.appendChild(booksBtn);
    }
    const listBtn = document.createElement('button');
    listBtn.className = 'icon-btn subtle';
    listBtn.title = 'Chapter list';
    listBtn.textContent = '☰';
    listBtn.onclick = () => { view.sidebarOpen = !view.sidebarOpen; renderSidebar(); };
    const settingsBtn = document.createElement('button');
    settingsBtn.className = 'icon-btn subtle';
    settingsBtn.title = 'Reading settings';
    settingsBtn.textContent = 'Aa';
    settingsBtn.onclick = () => { view.settingsOpen = !view.settingsOpen; render(); };
    const syncStatusChip = document.createElement('button');
    syncStatusChip.className = 'subtle sync-chip';
    syncStatusChip.id = 'syncStatusChip';
    syncStatusChip.disabled = true;
    syncStatusChip.textContent = getSyncStatusText();
    syncStatusChip.title = syncStatus.message || 'Sync status';
    topbarActions.append(profileSwitcher, syncStatusChip, listBtn, settingsBtn);
  }
}

function render(){
  document.body.classList.toggle('reader-mode-v2', view.mode === 'reader');
  if (view.mode !== 'reader' && typeof view._cleanupScroll === 'function'){
    view._cleanupScroll();
    view._cleanupScroll = null;
  }
  renderTopbar();
  if (view.mode === 'library') renderLibrary();
  else renderReader();
  applyReaderChromeState();
}

function getDisplaySortedChapters(items){
  const list = [...items];
  const mode = view.chapterSort || 'book-volume-added';
  if (mode === 'title'){
    list.sort((a, b) => (a.title || '').localeCompare(b.title || ''));
    return list;
  }
  if (mode === 'recent'){
    list.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
    return list;
  }
  if (mode === 'book-volume-title'){
    list.sort((a, b) => {
      const byBook = sortChapters(a, b);
      if ((a.book || '') !== (b.book || '') || (a.volume || '') !== (b.volume || '')) return byBook;
      return (a.title || '').localeCompare(b.title || '');
    });
    return list;
  }
  list.sort(sortChapters);
  return list;
}

function renderBookGrid(host, allItems){
  const books = getAllBookNames(allItems);
  if (!books.length) return;
  const grid = document.createElement('div');
  grid.className = 'book-grid';

  books.forEach((bookName) => {
    const chaptersInBook = allItems.filter(c => (c.book || '').trim() === bookName);
    const lastUpdated = getBookLastUpdatedLabel(chaptersInBook);
    const meta = booksMeta[bookName] || {};
    const card = document.createElement('div');
    card.className = 'book-card';

    const coverSrc = resolveCoverSrc(bookName, meta);
    if (coverSrc){
      const img = document.createElement('img');
      img.className = 'book-cover';
      img.src = coverSrc;
      img.alt = getBookLabel(bookName) + ' cover';
      card.appendChild(img);
    } else {
      const fb = document.createElement('div');
      fb.className = 'book-cover-fallback';
      fb.textContent = 'BOOK';
      card.appendChild(fb);
    }

    const metaWrap = document.createElement('div');
    metaWrap.className = 'book-meta';
    const bookPath = buildBookReaderPath(bookName);
    const isCurrentBookRoute = !!routeBookSlug && routeBookSlug === slugifyBookName(bookName);
    metaWrap.innerHTML = `
      <div class="book-title">${esc(getBookLabel(bookName))}</div>
      <div class="book-sub">${chaptersInBook.length} chapter${chaptersInBook.length === 1 ? '' : 's'} • Updated ${esc(lastUpdated)}</div>
      <div class="book-actions">
        <button type="button" class="book-open-btn">${isCurrentBookRoute ? 'Showing' : 'Open'}</button>
        <button type="button" class="book-manage-btn">Edit</button>
      </div>`;
    card.appendChild(metaWrap);

    const openBtn = metaWrap.querySelector('.book-open-btn');
    const manageBtn = metaWrap.querySelector('.book-manage-btn');
    openBtn.onclick = () => {
      if (!isCurrentBookRoute) window.location.href = bookPath;
    };
    if (isCurrentBookRoute) openBtn.disabled = true;
    manageBtn.onclick = () => openBookManager(bookName);
    grid.appendChild(card);
  });
  host.appendChild(grid);
}

function renderBookCoverPreview(){
  const wrap = document.getElementById('bookCoverPreviewWrap');
  const picker = document.getElementById('bookPicker');
  if (!wrap || !picker) return;
  const key = (picker.value || '').trim();
  const meta = booksMeta[key] || {};
  const cover = pendingCoverDataUrl || resolveCoverSrc(key, meta);
  if (cover){
    wrap.innerHTML = `<img class="cover-preview" src="${cover}" alt="Book cover preview" />`;
  } else {
    wrap.innerHTML = '<div class="cover-placeholder">No cover yet</div>';
  }
}

function openBookManager(prefillBook){
  const modal = document.getElementById('bookModal');
  const backdrop = document.getElementById('bookModalBackdrop');
  const picker = document.getElementById('bookPicker');
  const titleInput = document.getElementById('bookTitleInput');
  const sortSelect = document.getElementById('bookSortSelect');
  const volumeFromSelect = document.getElementById('volumeRenameFromSelect');
  const volumeToInput = document.getElementById('volumeRenameToInput');
  const renameVolumeBtn = document.getElementById('renameVolumeBtn');
  const saveBtn = document.getElementById('bookModalSaveBtn');
  const cancelBtn = document.getElementById('bookModalCancelBtn');
  const deleteBtn = document.getElementById('bookDeleteBtn');
  const pickCoverBtn = document.getElementById('bookPickCoverBtn');
  const clearCoverBtn = document.getElementById('bookClearCoverBtn');
  const uploadBtn = document.getElementById('bookUploadChaptersBtn');
  const books = getAllBookNames();
  let deleteArm = false;
  let deleteArmTimer = null;
  pendingCoverDataUrl = null;

  picker.innerHTML = '';
  books.forEach((name) => {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = getBookLabel(name);
    picker.appendChild(opt);
  });
  const newOpt = document.createElement('option');
  newOpt.value = '__new__';
  newOpt.textContent = '+ New book';
  picker.appendChild(newOpt);

  picker.value = books.includes(prefillBook || '') ? (prefillBook || '') : '__new__';
  sortSelect.value = view.chapterSort || 'book-volume-added';

  function getVolumesForBook(bookKey){
    return [...new Set(index
      .filter(ch => (ch.book || '').trim() === (bookKey || '').trim())
      .map(ch => (ch.volume || '').trim()))]
      .sort((a, b) => a.localeCompare(b));
  }

  function refreshVolumeRenameOptions(){
    const key = (picker.value || '').trim();
    volumeFromSelect.innerHTML = '';
    volumeToInput.value = '';
    if (!key || key === '__new__'){
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = 'Select an existing book first';
      volumeFromSelect.appendChild(opt);
      volumeFromSelect.disabled = true;
      volumeToInput.disabled = true;
      renameVolumeBtn.disabled = true;
      return;
    }

    const volumes = getVolumesForBook(key);
    if (!volumes.length){
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = 'No volumes in this book yet';
      volumeFromSelect.appendChild(opt);
      volumeFromSelect.disabled = true;
      volumeToInput.disabled = true;
      renameVolumeBtn.disabled = true;
      return;
    }

    const blank = document.createElement('option');
    blank.value = '';
    blank.textContent = 'Pick a volume';
    volumeFromSelect.appendChild(blank);
    volumes.forEach((vol) => {
      const opt = document.createElement('option');
      opt.value = vol;
      opt.textContent = vol || 'Unassigned';
      volumeFromSelect.appendChild(opt);
    });
    volumeFromSelect.disabled = false;
    volumeToInput.disabled = false;
    renameVolumeBtn.disabled = false;
  }

  function syncFormWithSelection(){
    const key = (picker.value || '').trim();
    if (key === '__new__'){
      titleInput.value = '';
    } else {
      titleInput.value = getBookLabel(key);
    }
    deleteArm = false;
    if (deleteArmTimer) {
      clearTimeout(deleteArmTimer);
      deleteArmTimer = null;
    }
    deleteBtn.textContent = 'Delete book';
    deleteBtn.disabled = key === '__new__' || !key;
    renderBookCoverPreview();
    refreshVolumeRenameOptions();
  }

  function close(){
    modal.classList.remove('open');
    backdrop.classList.remove('open');
    picker.onchange = null;
    saveBtn.onclick = null;
    cancelBtn.onclick = null;
    deleteBtn.onclick = null;
    pickCoverBtn.onclick = null;
    clearCoverBtn.onclick = null;
    uploadBtn.onclick = null;
    renameVolumeBtn.onclick = null;
    backdrop.onclick = null;
    if (deleteArmTimer) {
      clearTimeout(deleteArmTimer);
      deleteArmTimer = null;
    }
    pendingCoverDataUrl = null;
  }

  picker.onchange = syncFormWithSelection;
  pickCoverBtn.onclick = () => coverInput.click();
  clearCoverBtn.onclick = () => { pendingCoverDataUrl = ''; renderBookCoverPreview(); };
  uploadBtn.onclick = () => {
    const key = picker.value === '__new__' ? (titleInput.value || '').trim() : picker.value;
    if (!key) { alert('Pick a book title first.'); return; }
    startAddChapterToBook(key);
    close();
  };

  deleteBtn.onclick = async () => {
    const bookKey = (picker.value || '').trim();
    if (!bookKey || bookKey === '__new__') return;

    if (!deleteArm) {
      deleteArm = true;
      deleteBtn.textContent = 'Click again to delete';
      deleteArmTimer = setTimeout(() => {
        deleteArm = false;
        deleteBtn.textContent = 'Delete book';
        deleteArmTimer = null;
      }, 6000);
      return;
    }

    if (deleteArmTimer) {
      clearTimeout(deleteArmTimer);
      deleteArmTimer = null;
    }
    deleteArm = false;
    deleteBtn.textContent = 'Delete book';

    const doomed = index.filter(ch => (ch.book || '').trim() === bookKey);
    if (!doomed.length && !booksMeta[bookKey]) {
      alert('Nothing to delete for this book.');
      return;
    }

    if (!confirm('Delete book "' + getBookLabel(bookKey) + '" and all its chapters? This cannot be undone.')) {
      return;
    }

    const doomedIds = new Set(doomed.map(ch => ch.id));
    index = index.filter(ch => !doomedIds.has(ch.id));
    for (const id of doomedIds) {
      await dataBridge.deleteChapter(id);
    }
    delete booksMeta[bookKey];

    const progress = getProgress();
    for (const id of doomedIds) {
      if (progress.percents[id] != null) delete progress.percents[id];
    }
    if (progress.lastChapterId && doomedIds.has(progress.lastChapterId)) {
      progress.lastChapterId = null;
    }

    await dataBridge.saveIndex(index);
    await dataBridge.saveBooksMeta(booksMeta);
    await dataBridge.saveProfileState();
    if (syncKey) await syncBridge.pushLibrary({ forceReplace:true });
    close();
    render();
  };

  renameVolumeBtn.onclick = async () => {
    const bookKey = (picker.value || '').trim();
    const fromVolume = (volumeFromSelect.value || '').trim();
    const toVolume = (volumeToInput.value || '').trim();
    if (!bookKey || bookKey === '__new__'){
      alert('Select an existing book first.');
      return;
    }
    if (!fromVolume){
      alert('Pick a volume to rename.');
      return;
    }
    if (!toVolume){
      alert('Enter the new volume name.');
      return;
    }
    if (fromVolume === toVolume){
      alert('New volume name is the same as the current one.');
      return;
    }

    let changed = 0;
    index.forEach((ch) => {
      if ((ch.book || '').trim() === bookKey && (ch.volume || '').trim() === fromVolume){
        ch.volume = toVolume;
        changed++;
      }
    });
    if (!changed){
      alert('No chapters found in that volume.');
      return;
    }

    index.sort(sortChapters);
    await dataBridge.saveIndex(index);
    if (syncKey) await syncBridge.pushLibrary();
    volumeToInput.value = '';
    refreshVolumeRenameOptions();
    render();
    alert('Renamed volume for ' + changed + ' chapter(s).');
  };

  saveBtn.onclick = async () => {
    const selected = (picker.value || '').trim();
    const nextTitle = (titleInput.value || '').trim();
    if (!nextTitle) {
      alert('Book title cannot be empty.');
      return;
    }

    let targetKey = selected;
    if (selected === '__new__'){
      targetKey = nextTitle;
    }

    if (selected === '__new__' && booksMeta[nextTitle]) {
      alert('A book with that name already exists. Pick it from the list to edit it.');
      return;
    }

    if (selected && selected !== '__new__' && selected !== nextTitle){
      const currentLabel = getBookLabel(selected);
      const ok = confirm('Rename book "' + currentLabel + '" to "' + nextTitle + '"?');
      if (!ok) return;
      index.forEach(ch => {
        if ((ch.book || '').trim() === selected) ch.book = nextTitle;
      });
      if (booksMeta[selected]) {
        booksMeta[nextTitle] = booksMeta[selected];
        delete booksMeta[selected];
      }
      targetKey = nextTitle;
    }

    if (!booksMeta[targetKey]) booksMeta[targetKey] = { title: targetKey, coverDataUrl: '', coverPath: '' };
    booksMeta[targetKey].title = nextTitle;
    if (pendingCoverDataUrl !== null) {
      if (pendingCoverDataUrl === '') {
        booksMeta[targetKey].coverDataUrl = '';
        booksMeta[targetKey].coverPath = '';
      } else if (syncKey) {
        const uploaded = await uploadCoverToServer(targetKey, pendingCoverDataUrl);
        if (uploaded.ok && uploaded.coverPath) {
          booksMeta[targetKey].coverPath = uploaded.coverPath;
          booksMeta[targetKey].coverDataUrl = '';
        } else {
          booksMeta[targetKey].coverDataUrl = pendingCoverDataUrl;
          booksMeta[targetKey].coverPath = '';
        }
      } else {
        booksMeta[targetKey].coverDataUrl = pendingCoverDataUrl;
        booksMeta[targetKey].coverPath = '';
      }
    }

    view.chapterSort = sortSelect.value || 'book-volume-added';
    index.sort(sortChapters);
    await dataBridge.saveIndex(index);
    await dataBridge.saveBooksMeta(booksMeta);
    if (syncKey) await syncBridge.pushLibrary();
    close();
    render();
  };

  cancelBtn.onclick = close;
  backdrop.onclick = close;
  syncFormWithSelection();
  modal.classList.add('open');
  backdrop.classList.add('open');
}

function renderLibrary(){
  main.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'library-wrap';

  const isBookPage = !!routeBookSlug;
  const routeBookName = getRouteBookName();

  if (!index.length){
    wrap.innerHTML = `
      <div class="empty-state">
        <div class="big">${isBookPage ? 'This book has no chapters yet' : 'Your library is empty'}</div>
        <div>${isBookPage ? 'Add chapters to this book, or return to the books page to create/manage other books.' : 'Add the .txt chapter files from your computer to get started — pick individual files or a whole folder at once. They stay saved here — open this same page on your phone and they\'ll be waiting for you.'}</div>
        <div style="margin-top:18px; display:flex; gap:10px; justify-content:center; flex-wrap:wrap;">
          <button class="primary" id="emptyAddBtn">+ Add chapter</button>
          <button id="emptyBookBtn">${isBookPage ? 'Book settings' : '+ Create book'}</button>
          ${isBookPage ? '<button id="emptyBackBtn">All books</button>' : ''}
        </div>
      </div>`;
    main.appendChild(wrap);
    document.getElementById('emptyAddBtn').onclick = () => {
      if (isBookPage) startAddChapterToBook(routeBookName || '');
      else startAddChapter();
    };
    document.getElementById('emptyBookBtn').onclick = () => openBookManager(routeBookName || '__new__');
    if (isBookPage) {
      const backBtn = document.getElementById('emptyBackBtn');
      if (backBtn) backBtn.onclick = () => { window.location.href = getMainLibraryPath(); };
    }
    return;
  }

  if (!isBookPage){
    const toolrow = document.createElement('div');
    toolrow.className = 'toolrow';
    toolrow.innerHTML = `
      <div class="inline-actions">
        <button type="button" id="manageBooksRootBtn">Manage books</button>
      </div>`;
    toolrow.querySelector('#manageBooksRootBtn').onclick = () => openBookManager('');
    wrap.appendChild(toolrow);

    if (view.debugOpen) {
      const panel = document.createElement('div');
      panel.className = 'continue-card';
      const d = mainPageDebug.data;
      const b = (d && d.backfill) ? d.backfill : backfillDebug;
      const c = (d && d.scopedCleanup) ? d.scopedCleanup : scopedCleanupDebug;
      const eventRows = (d && d.events && d.events.length)
        ? d.events.map((e) => {
          const t = new Date(e.at || Date.now()).toLocaleTimeString();
          return '<div>[' + esc(t) + '] ' + esc(e.kind || 'info') + ': ' + esc(e.message || '') + '</div>';
        }).join('')
        : '<div>No sync events yet.</div>';
      const statusLine = mainPageDebug.loading
        ? 'Collecting diagnostics...'
        : (mainPageDebug.error ? ('Diagnostics error: ' + esc(mainPageDebug.error)) : 'Diagnostics snapshot');
      panel.innerHTML = `
        <div style="min-width:260px;">
          <div class="label">Debug: Sync & Storage</div>
          <div style="font-size:13px;color:var(--ink-soft);margin-top:4px;">${statusLine}</div>
          <div style="font-size:12px;color:var(--ink-soft);margin-top:10px;line-height:1.6;">
            <div>Sync attempts: ${syncDebug.attempts} | success: ${syncDebug.successes} | fail: ${syncDebug.failures}</div>
            <div>Last reason: ${esc(syncDebug.lastReason || 'n/a')}</div>
            <div>Last payload: ${formatBytes(syncDebug.lastPayloadBytes)} | last sync time: ${syncDebug.lastDurationMs} ms</div>
            <div>Recovery pulls: ${syncDebug.recoveryAttempts}</div>
            <div>Books: ${d ? d.books : '-'} | Chapters: ${d ? d.chapters : '-'}</div>
            <div>Browser role: ${d ? esc(d.browserRole || 'n/a') : '-'}</div>
            <div>Chapter coverage: ${d ? (d.backfillPercent + '%') : '-'}</div>
            <div>Payload size now: ${d ? formatBytes(d.payloadBytes) : '-'}</div>
            <div>Stored keys: ${d ? d.keysTotal : '-'} (global ${d ? d.keysGlobal : '-'}, scoped ${d ? d.keysScoped : '-'})</div>
            <div>Global logical keys: ${d ? d.keysGlobalLogical : '-'} | chunk fragment keys: ${d ? d.keysChunk : '-'}</div>
            <div>Missing local chapter blobs: ${d ? d.missingChapterCount : '-'}</div>
            <div>Backfill run: ${b.active ? 'active' : 'idle'} | scanned ${b.scanned || 0}/${b.total || 0} | checked ${b.checked || 0} | uploaded ${b.uploaded || 0} | failed ${b.failed || 0}</div>
            <div>Backfill state: ${b.complete ? 'complete' : 'incomplete'} | cursor ${b.cursor || 0} | runs ${b.runs || 0}</div>
            <div>Backfill note: ${esc(b.message || 'n/a')}</div>
            <div>Scoped cleanup: ${c.active ? 'active' : 'idle'} | deleted ${c.deleted || 0} | remaining ~${c.remaining || 0} | runs ${c.runs || 0}</div>
            <div>Scoped cleanup note: ${esc(c.message || 'n/a')}</div>
            <div style="margin-top:8px;font-weight:600;">Recent sync events</div>
            ${eventRows}
          </div>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;align-self:flex-start;">
          <button id="refreshDebugBtn">Refresh diagnostics</button>
          <button id="runBackfillBtn">Run backfill now</button>
          <button id="runCleanupBtn">Run scoped cleanup</button>
          <button id="copyDebugBtn">Copy debug report</button>
        </div>`;
      wrap.appendChild(panel);
      const refreshBtn = panel.querySelector('#refreshDebugBtn');
      if (refreshBtn) refreshBtn.onclick = () => refreshMainPageDebug();
      const runBackfillBtn = panel.querySelector('#runBackfillBtn');
      if (runBackfillBtn) runBackfillBtn.onclick = async () => {
        runBackfillBtn.disabled = true;
        runBackfillBtn.textContent = 'Running...';
        try {
          await runBackfillNow();
        } finally {
          runBackfillBtn.disabled = false;
          runBackfillBtn.textContent = 'Run backfill now';
        }
      };
      const runCleanupBtn = panel.querySelector('#runCleanupBtn');
      if (runCleanupBtn) runCleanupBtn.onclick = async () => {
        runCleanupBtn.disabled = true;
        runCleanupBtn.textContent = 'Running...';
        try {
          await runScopedCleanupNow();
        } finally {
          runCleanupBtn.disabled = false;
          runCleanupBtn.textContent = 'Run scoped cleanup';
        }
      };
      const copyDebugBtn = panel.querySelector('#copyDebugBtn');
      if (copyDebugBtn) copyDebugBtn.onclick = async () => {
        copyDebugBtn.disabled = true;
        const prev = copyDebugBtn.textContent;
        try {
          await copyDebugReport();
          copyDebugBtn.textContent = 'Copied';
        } catch (e) {
          copyDebugBtn.textContent = 'Copy failed';
        }
        setTimeout(() => {
          copyDebugBtn.disabled = false;
          copyDebugBtn.textContent = prev;
        }, 1200);
      };
    }

    renderBookGrid(wrap, index);
    if (view.transferOpen){
      const panel = document.createElement('div');
      panel.className = 'continue-card';
      panel.innerHTML = `
        <div>
          <div class="label">Move library to another device</div>
          <div style="font-size:13px;color:var(--ink-soft);max-width:46ch;">
            Export everything to one file here, then open this same reader on your other device and import it there.
          </div>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <button id="exportBtn">Export library</button>
          <button id="importBtn" class="primary">Import library</button>
        </div>`;
      wrap.appendChild(panel);
      panel.querySelector('#exportBtn').onclick = exportLibrary;
      panel.querySelector('#importBtn').onclick = () => importInput.click();
    }
    main.appendChild(wrap);
    return;
  }

  view.bookFilter = routeBookName || '';
  view.chapterSort = 'book-volume-added';

  const currentBook = routeBookName || (index[0] && index[0].book) || '';
  const currentMeta = booksMeta[currentBook] || {};
  const currentItems = index.filter(c => (c.book || '').trim() === currentBook);
  const progress = getProgress();
  const lastReadInBook = progress.lastChapterId
    ? currentItems.find(c => c.id === progress.lastChapterId)
    : null;
  const header = document.createElement('div');
  header.className = 'book-page-header';
  const currentCoverSrc = resolveCoverSrc(currentBook, currentMeta);
  const coverHtml = currentCoverSrc
    ? `<img class="book-page-cover" src="${currentCoverSrc}" alt="${esc(getBookLabel(currentBook))} cover" />`
    : '<div class="book-page-cover-fallback">BOOK</div>';
  header.innerHTML = `
    ${coverHtml}
    <div class="book-page-meta">
      <div class="book-page-title">${esc(getBookLabel(currentBook))}</div>
      <div class="book-page-sub">${currentItems.length} chapter${currentItems.length === 1 ? '' : 's'} • sorted by volume</div>
      <div class="book-page-actions">
        <button type="button" id="bookPageSettingsBtn">Book settings</button>
        <button type="button" id="bookPageAddBtn" class="primary">+ Add chapters</button>
        <button type="button" id="bookPageBackBtn">All books</button>
      </div>
    </div>`;
  wrap.appendChild(header);
  header.querySelector('#bookPageSettingsBtn').onclick = () => openBookManager(currentBook || '__new__');
  header.querySelector('#bookPageAddBtn').onclick = () => startAddChapterToBook(currentBook || '');
  header.querySelector('#bookPageBackBtn').onclick = () => { window.location.href = getMainLibraryPath(); };

  if (lastReadInBook){
    const pct = Math.round(progress.percents[lastReadInBook.id] || 0);
    const card = document.createElement('div');
    card.className = 'continue-card';
    card.innerHTML = `
      <div>
        <div class="label">Continue reading</div>
        <div class="title">${esc(lastReadInBook.title)}</div>
        <div class="pct">${pct}% through this chapter</div>
      </div>
      <button class="primary">Resume →</button>`;
    card.querySelector('button').onclick = () => openChapter(lastReadInBook.id, true);
    wrap.appendChild(card);
  }

  const toolrow = document.createElement('div');
  toolrow.className = 'toolrow';
  toolrow.innerHTML = `<input class="search-input" placeholder="Filter chapters in this book…" value="${esc(view.search||'')}" />`;
  wrap.appendChild(toolrow);

  const list = document.createElement('div');
  list.id = 'chapterListContainer';
  wrap.appendChild(list);
  const searchInput = toolrow.querySelector('input');
  searchInput.oninput = (e) => { view.search = e.target.value; renderChapterList(list); };
  renderChapterList(list);

  main.appendChild(wrap);
}

function buildChapterRow(ch, opts){
  opts = opts || {};
  const progress = getProgress();
  const pct = Math.round(progress.percents[ch.id] || 0);
  const li = document.createElement('li');
  li.className = 'chapter-row' + (opts.current ? ' current' : '');
  li.innerHTML = `
    <div class="chapter-main">
      <div class="chapter-title ${pct>=98?'chapter-done':''}">${esc(ch.title)}</div>
      <div class="chapter-progress-track"><div class="chapter-progress-fill" style="width:${pct}%"></div></div>
    </div>
    <div style="display:flex;gap:4px;">
      <button class="chapter-del icon-btn subtle" title="Edit chapter (book, volume, title)">⚙</button>
      ${opts.deletable !== false ? '<button class="chapter-del icon-btn subtle" title="Remove">✕</button>' : ''}
    </div>`;
  li.onclick = () => { if (opts.onClick) opts.onClick(ch); else openChapter(ch.id, false); };
  const editBtn = li.querySelectorAll('.chapter-del')[0];
  const delBtn = li.querySelectorAll('.chapter-del')[1];
  if (editBtn) editBtn.onclick = (e) => { e.stopPropagation(); editChapter(ch.id); };
  if (delBtn) delBtn.onclick = (e) => deleteChapter(ch.id, e);
  return li;
}

function renderChapterList(list){
  const q = (view.search || '').toLowerCase().trim();
  const filtered = index.filter(c => {
    if (view.bookFilter && (c.book || '').trim() !== view.bookFilter) return false;
    return !q || c.title.toLowerCase().includes(q);
  });
  const items = getDisplaySortedChapters(filtered);
  list.innerHTML = '';
  if (!items.length){
    const label = view.bookFilter ? (' in ' + getBookLabel(view.bookFilter)) : '';
    list.innerHTML = `<div style="padding:24px 4px;color:var(--ink-soft);">No chapters match "${esc(view.search)}"${esc(label)}.</div>`;
    return;
  }

  if (routeBookSlug){
    const progress = getProgress();
    const activeChapterId = progress.lastChapterId && items.some((ch) => ch.id === progress.lastChapterId)
      ? progress.lastChapterId
      : null;
    const volumes = [...new Set(items.map(c => c.volume || ''))];
    if (volumes.length <= 1){
      const ul = document.createElement('ul');
      ul.className = 'chapter-list two-col';
      items.forEach(ch => ul.appendChild(buildChapterRow(ch)));
      list.appendChild(ul);
      return;
    }
    volumes.forEach((vol) => {
      const groupItems = items.filter(c => (c.volume || '') === vol);
      const chapterProgresses = groupItems.map((ch) => Math.max(0, Math.min(100, Math.round(getProgress().percents[ch.id] || 0))));
      const volumePct = chapterProgresses.length
        ? Math.round(chapterProgresses.reduce((sum, pct) => sum + pct, 0) / chapterProgresses.length)
        : 0;
      const volDetails = document.createElement('details');
      volDetails.className = 'volume-group';
      volDetails.open = !!(activeChapterId && groupItems.some((ch) => ch.id === activeChapterId));
      const volSummary = document.createElement('summary');
      volSummary.innerHTML = `
        <span class="volume-summary-text">${esc(vol || 'Chapters')}</span>
        <span class="volume-progress-wrap" aria-hidden="true">
          <span class="volume-progress"><span class="volume-progress-fill" style="width:${volumePct}%"></span></span>
          <span class="volume-progress-label">${volumePct}%</span>
        </span>`;
      volDetails.appendChild(volSummary);
      const ul = document.createElement('ul');
      ul.className = 'chapter-list nested two-col';
      groupItems.forEach(ch => ul.appendChild(buildChapterRow(ch)));
      volDetails.appendChild(ul);
      list.appendChild(volDetails);
    });
    return;
  }

  const books = [...new Set(items.map(c => c.book || ''))];

  books.forEach(book => {
    const bookItems = items.filter(c => (c.book || '') === book);
    const bookDetails = document.createElement('details');
    bookDetails.className = 'volume-group book-group';
    bookDetails.open = true;
    const bookSummary = document.createElement('summary');
    bookSummary.textContent = getBookLabel(book);
    bookDetails.appendChild(bookSummary);

    const volumes = [...new Set(bookItems.map(c => c.volume || ''))];

    if (volumes.length <= 1){
      const ul = document.createElement('ul');
      ul.className = 'chapter-list nested two-col';
      bookItems.forEach(ch => ul.appendChild(buildChapterRow(ch)));
      bookDetails.appendChild(ul);
    } else {
      volumes.forEach(vol => {
        const groupItems = bookItems.filter(c => (c.volume || '') === vol);
        const volDetails = document.createElement('details');
        volDetails.className = 'volume-group';
        volDetails.open = false;
        const volSummary = document.createElement('summary');
        volSummary.textContent = vol || 'Chapters';
        volDetails.appendChild(volSummary);
        const ul = document.createElement('ul');
        ul.className = 'chapter-list nested two-col';
        groupItems.forEach(ch => ul.appendChild(buildChapterRow(ch)));
        volDetails.appendChild(ul);
        bookDetails.appendChild(volDetails);
      });
    }
    list.appendChild(bookDetails);
  });
}

function renderSidebar(){
  const bd = document.querySelector('.side-drawer-backdrop');
  const dr = document.getElementById('sideDrawer');
  if (!bd || !dr) return;
  bd.classList.toggle('open', !!view.sidebarOpen);
  dr.classList.toggle('open', !!view.sidebarOpen);
  dr.innerHTML = '<h2>Chapters</h2>';
  const currentId = view.chapterId;

  const wrapList = (items) => {
    const ul = document.createElement('ul');
    ul.className = 'chapter-list';
    items.forEach(ch => ul.appendChild(buildChapterRow(ch, {
      current: ch.id === currentId,
      deletable: false,
      onClick: (c) => { view.sidebarOpen = false; openChapter(c.id, false); }
    })));
    return ul;
  };

  const books = [...new Set(index.map(c => c.book || ''))];

  books.forEach(book => {
    const bookItems = index.filter(c => (c.book || '') === book);
    const bookDetails = document.createElement('details');
    bookDetails.className = 'volume-group book-group';
    bookDetails.open = bookItems.some(c => c.id === currentId);
    const bookSummary = document.createElement('summary');
    bookSummary.textContent = getBookLabel(book);
    bookDetails.appendChild(bookSummary);

    const volumes = [...new Set(bookItems.map(c => c.volume || ''))];

    if (volumes.length <= 1){
      bookDetails.appendChild(wrapList(bookItems));
    } else {
      volumes.forEach(vol => {
        const groupItems = bookItems.filter(c => (c.volume || '') === vol);
        const volDetails = document.createElement('details');
        volDetails.className = 'volume-group';
        volDetails.open = groupItems.some(c => c.id === currentId) || volumes.length < 4;
        const volSummary = document.createElement('summary');
        volSummary.textContent = vol || 'Chapters';
        volDetails.appendChild(volSummary);
        volDetails.appendChild(wrapList(groupItems));
        bookDetails.appendChild(volDetails);
      });
    }
    dr.appendChild(bookDetails);
  });
}

async function openChapter(id, resume){
  view.mode = 'reader';
  view.chapterId = id;
  view.resume = !!resume;
  if (!isMobileViewport()) view.mobileChromeCollapsed = false;
  view.sidebarOpen = false;
  render();
}

async function renderReader(){
  if (typeof view._cleanupScroll === 'function'){
    view._cleanupScroll();
    view._cleanupScroll = null;
  }
  const meta = index.find(c => c.id === view.chapterId);
  main.innerHTML = '<div style="padding:40px;color:var(--ink-soft);">Loading…</div>';
  if (!meta) { view.mode='library'; render(); return; }

  let data = await dataBridge.getChapter(meta.id);
  if (!data && syncKey) {
    const remoteChapter = await syncBridge.pullChapter(meta.id);
    if (remoteChapter) {
      await dataBridge.saveChapter(meta.id, remoteChapter);
      data = remoteChapter;
    }
  }
  data = data || { title: meta.title, content: '(missing content)' };
  const progress = getProgress();

  const idx = index.findIndex(c => c.id === meta.id);
  const readerItems = index.filter((entry) => {
    if (routeBookSlug) return slugifyBookName(entry.book) === routeBookSlug;
    if (meta.book) return (entry.book || '') === (meta.book || '');
    return true;
  });
  const scopedItems = readerItems.length ? readerItems : index;
  const scopedIndex = scopedItems.findIndex((entry) => entry.id === meta.id);
  const prevMeta = scopedItems[scopedIndex - 1] || null;
  const nextMeta = scopedItems[scopedIndex + 1] || null;
  const pct = Math.round(progress.percents[meta.id] || 0);
  const titlePath = meta.book ? buildBookReaderPath(meta.book) : getMainLibraryPath();
  const chapterLabel = 'Chapter ' + (meta.num != null ? meta.num : (idx + 1));

  const wrap = document.createElement('div');
  wrap.className = 'reader-v2';
  wrap.id = 'readerTapZone';

  const shell = document.createElement('div');
  shell.className = 'reader-v2-shell';

  const content = document.createElement('article');
  content.className = 'reader-content reader-content-v2';
  applyReaderStyles(content);
  content.innerHTML = `<div class="reader-content-head"><div class="reader-kicker">${esc(chapterLabel)}</div><h1>${esc(data.title)}</h1></div>`;
  const paras = (data.content || '').split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
  (paras.length ? paras : [data.content || '']).forEach(p => {
    const pEl = document.createElement('p');
    pEl.textContent = p;
    content.appendChild(pEl);
  });

  const rail = document.createElement('aside');
  rail.className = 'reader-v2-rail mobile-control';
  rail.innerHTML = `
    <div class="reader-chapter-inline" aria-label="Chapter controls">
      <button class="reader-icon-btn reader-icon-btn-mini" id="readerPrevInline" type="button" aria-label="Previous chapter">&lt;</button>
      <select id="readerChapterSelect" class="reader-chapter-select" aria-label="Choose chapter"></select>
      <button class="reader-icon-btn reader-icon-btn-mini" id="readerNextInline" type="button" aria-label="Next chapter">&gt;</button>
    </div>
    <nav class="reader-v2-icons" aria-label="Quick actions">
      <button class="reader-icon-btn" id="readerHomeBtn" type="button" aria-label="Home" title="Home">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l9 8h-3v9h-5v-6H11v6H6v-9H3z"/></svg>
      </button>
      <button class="reader-icon-btn" id="readerTitleBtn" type="button" aria-label="Title page" title="Title page">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5a2 2 0 0 1 2-2h13v17H6a2 2 0 0 0-2 2V5zm3 1v11h10V6H7z"/></svg>
      </button>
      <button class="reader-icon-btn" id="readerSettingsBtn" type="button" aria-label="Settings" title="Settings">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19.14 12.94a7.77 7.77 0 0 0 .05-.94 7.77 7.77 0 0 0-.05-.94l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.6-.22l-2.39.96a7.5 7.5 0 0 0-1.63-.94l-.36-2.54a.5.5 0 0 0-.5-.42h-3.84a.5.5 0 0 0-.5.42l-.36 2.54a7.5 7.5 0 0 0-1.63.94l-2.39-.96a.5.5 0 0 0-.6.22L2.71 8.84a.5.5 0 0 0 .12.64l2.03 1.58a7.77 7.77 0 0 0-.05.94c0 .32.02.63.05.94L2.83 14.52a.5.5 0 0 0-.12.64l1.92 3.32a.5.5 0 0 0 .6.22l2.39-.96c.5.39 1.05.71 1.63.94l.36 2.54a.5.5 0 0 0 .5.42h3.84a.5.5 0 0 0 .5-.42l.36-2.54c.58-.23 1.13-.55 1.63-.94l2.39.96a.5.5 0 0 0 .6-.22l1.92-3.32a.5.5 0 0 0-.12-.64l-2.03-1.58zM12 15.5A3.5 3.5 0 1 1 12 8a3.5 3.5 0 0 1 0 7.5z"/></svg>
      </button>
    </nav>
    <section class="reader-settings-popup collapsed" id="readerSettingsPopup"></section>
  `;

  const footer = document.createElement('footer');
  footer.className = 'reader-v2-bottom mobile-control';
  footer.innerHTML = `
    <div class="reader-v2-meta">
      <button type="button" class="reader-link-btn" id="readerFooterTitle">${esc(getBookLabel(meta.book || 'Library'))}</button>
      <span>${esc(chapterLabel)}</span>
      <button type="button" class="reader-link-btn" id="readerFooterHome">Home</button>
    </div>
    <div class="reader-v2-nav">
      <button class="primary" id="readerPrevFooter" type="button">Previous Chapter</button>
      <button class="primary" id="readerNextFooter" type="button">Next Chapter</button>
    </div>
  `;

  const hint = document.createElement('button');
  hint.id = 'readerMobileHint';
  hint.className = 'reader-v2-hint';
  hint.type = 'button';
  hint.textContent = 'Double tap anywhere to show or hide controls';

  shell.append(content, rail);
  wrap.append(shell, footer, hint);
  main.innerHTML = '';
  main.appendChild(wrap);

  const chapterSelect = document.getElementById('readerChapterSelect');
  scopedItems.forEach((entry, position) => {
    const option = document.createElement('option');
    option.value = entry.id;
    option.textContent = 'Chapter ' + (position + 1);
    if (entry.id === meta.id) option.selected = true;
    chapterSelect.appendChild(option);
  });

  const settingsPanel = document.getElementById('readerSettingsPopup');
  settingsPanel.innerHTML = buildReaderSettingsPanel();
  const fontSelect = settingsPanel.querySelector('#readerFontSelect');
  const fontSizeInput = settingsPanel.querySelector('#readerFontSize');
  const lineHeightInput = settingsPanel.querySelector('#readerLineHeight');
  const themeSelect = settingsPanel.querySelector('#readerThemeSelect');
  const fontSizeValue = settingsPanel.querySelector('#readerFontSizeValue');
  const lineHeightValue = settingsPanel.querySelector('#readerLineHeightValue');
  const resetBtn = settingsPanel.querySelector('#readerResetProgress');

  const settings = getSettings();
  fontSelect.value = settings.font;
  fontSizeInput.value = String(settings.fontSize || 19);
  lineHeightInput.value = String(settings.lineHeight || 1.7);
  themeSelect.value = settings.theme || 'dark';

  function syncSettingsUi(){
    fontSizeValue.textContent = fontSizeInput.value + 'px';
    lineHeightValue.textContent = lineHeightInput.value;
    settings.font = fontSelect.value;
    settings.fontSize = Number(fontSizeInput.value || settings.fontSize || 19);
    settings.lineHeight = Number(lineHeightInput.value || settings.lineHeight || 1.7);
    settings.theme = themeSelect.value || settings.theme || 'dark';
    applyTheme();
    applyReaderStyles(content);
    scheduleSettingsPersist();
  }

  [fontSelect, fontSizeInput, lineHeightInput, themeSelect].forEach((control) => {
    control.addEventListener('input', syncSettingsUi);
    control.addEventListener('change', syncSettingsUi);
  });
  syncSettingsUi();

  resetBtn.disabled = pct <= 0;
  resetBtn.onclick = async () => {
    if (!confirm('Reset progress for this chapter?')) return;
    delete progress.percents[meta.id];
    if (progress.lastChapterId === meta.id) progress.lastChapterId = null;
    await persistProfileState();
    if (syncKey) await syncProgressStateThrottled('reset');
    window.scrollTo(0, 0);
    render();
  };

  function goToMeta(targetMeta){
    if (targetMeta && targetMeta.id) openChapter(targetMeta.id, false);
  }

  document.getElementById('readerHomeBtn').onclick = returnToLibrary;
  document.getElementById('readerFooterHome').onclick = returnToLibrary;
  document.getElementById('readerTitleBtn').onclick = () => { window.location.href = titlePath; };
  document.getElementById('readerFooterTitle').onclick = () => { window.location.href = titlePath; };
  document.getElementById('readerPrevInline').onclick = () => goToMeta(prevMeta);
  document.getElementById('readerNextInline').onclick = () => goToMeta(nextMeta);
  document.getElementById('readerPrevFooter').onclick = () => goToMeta(prevMeta);
  document.getElementById('readerNextFooter').onclick = () => goToMeta(nextMeta);
  document.getElementById('readerPrevInline').disabled = !prevMeta;
  document.getElementById('readerNextInline').disabled = !nextMeta;
  document.getElementById('readerPrevFooter').disabled = !prevMeta;
  document.getElementById('readerNextFooter').disabled = !nextMeta;
  chapterSelect.onchange = () => openChapter(chapterSelect.value, false);

  const settingsToggle = document.getElementById('readerSettingsBtn');
  settingsToggle.onclick = () => {
    settingsPanel.classList.toggle('collapsed');
  };

  function syncMobileChrome(){
    const collapsed = isMobileViewport() && !!view.mobileChromeCollapsed;
    wrap.classList.toggle('reader-mobile-controls-hidden', collapsed);
    if (!collapsed) hint.classList.add('is-hidden');
  }
  syncMobileChrome();

  let lastTapAt = 0;
  function onPointerDown(event){
    if (!isMobileViewport()) return;
    if (event.target.closest('.reader-v2-rail') || event.target.closest('.reader-v2-bottom') || event.target.closest('.reader-settings-popup')) {
      return;
    }
    const now = Date.now();
    const delta = now - lastTapAt;
    lastTapAt = now;
    if (delta > 45 && delta < 360) {
      view.mobileChromeCollapsed = !view.mobileChromeCollapsed;
      if (view.mobileChromeCollapsed) settingsPanel.classList.add('collapsed');
      hint.classList.add('is-hidden');
      syncMobileChrome();
    }
  }

  function onDocumentPointerDown(event){
    if (settingsPanel.classList.contains('collapsed')) return;
    if (event.target.closest('#readerSettingsPopup') || event.target.closest('#readerSettingsBtn')) return;
    settingsPanel.classList.add('collapsed');
  }

  wrap.addEventListener('pointerdown', onPointerDown);
  document.addEventListener('pointerdown', onDocumentPointerDown);

  function onKeydown(e){
    const tag = (document.activeElement && document.activeElement.tagName) || '';
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    if (e.key === 'ArrowRight' && nextMeta) goToMeta(nextMeta);
    else if (e.key === 'ArrowLeft' && prevMeta) goToMeta(prevMeta);
    else if (e.key === 'Escape') settingsPanel.classList.add('collapsed');
  }
  document.addEventListener('keydown', onKeydown);

  let pendingScrollPct = null;
  let pendingScrollTimer = null;
  async function flushProgress(){
    if (pendingScrollTimer) {
      clearTimeout(pendingScrollTimer);
      pendingScrollTimer = null;
    }
    if (pendingScrollPct === null || pendingScrollPct === undefined) return;
    progress.lastChapterId = meta.id;
    progress.percents[meta.id] = pendingScrollPct;
    pendingScrollPct = null;
    await persistProfileState();
    if (syncKey) await syncProgressStateThrottled('scroll');
  }
  function computePct(){
    const docHeight = document.documentElement.scrollHeight - window.innerHeight;
    if (docHeight <= 0) return 100;
    return Math.min(100, Math.max(0, (window.scrollY / docHeight) * 100));
  }
  function onScroll(){
    const p = computePct();
    ribbon.textContent = Math.round(p) + '%';
    pendingScrollPct = p;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      pendingScrollTimer = null;
      flushProgress().catch((e) => console.warn('Progress flush failed', e));
    }, 700);
    pendingScrollTimer = saveTimer;
  }
  window.addEventListener('scroll', onScroll, { passive:true });
  window.addEventListener('pagehide', flushProgress);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushProgress().catch(() => {});
  });
  view._cleanupScroll = () => {
    document.body.classList.remove('reader-mode-v2');
    window.removeEventListener('scroll', onScroll);
    window.removeEventListener('pagehide', flushProgress);
    document.removeEventListener('keydown', onKeydown);
    document.removeEventListener('pointerdown', onDocumentPointerDown);
    wrap.removeEventListener('pointerdown', onPointerDown);
    if (pendingScrollTimer) clearTimeout(pendingScrollTimer);
    flushProgress().catch(() => {});
  };

  requestAnimationFrame(() => {
    const savedPct = progress.percents[meta.id];
    if (savedPct){
      const docHeight = document.documentElement.scrollHeight - window.innerHeight;
      window.scrollTo(0, (savedPct/100) * docHeight);
    } else {
      window.scrollTo(0,0);
    }
  });
}

function applyReaderStyles(el){
  const settings = getSettings();
  el.style.fontFamily = settings.font;
  el.style.fontSize = settings.fontSize + 'px';
  el.style.lineHeight = settings.lineHeight;
  el.style.maxWidth = '66ch';
  el.style.margin = '0 auto';
}

function buildReaderSettingsPanel(){
  const fontOptions = FONT_OPTIONS.map((option) => {
    return `<option value="${esc(option.value)}">${esc(option.label)}</option>`;
  }).join('');
  return `
    <div class="reader-settings-card">
      <h3>Reader Settings</h3>
      <div class="reader-control">
        <label for="readerFontSize" class="reader-control-head"><span>Font Size</span><span id="readerFontSizeValue"></span></label>
        <input id="readerFontSize" type="range" min="14" max="30" step="1" />
      </div>
      <div class="reader-control">
        <label for="readerLineHeight" class="reader-control-head"><span>Line Height</span><span id="readerLineHeightValue"></span></label>
        <input id="readerLineHeight" type="range" min="1.2" max="2.4" step="0.1" />
      </div>
      <div class="reader-control">
        <label for="readerFontSelect">Font Family</label>
        <select id="readerFontSelect">${fontOptions}</select>
      </div>
      <div class="reader-control">
        <label for="readerThemeSelect">Theme</label>
        <select id="readerThemeSelect">
          <option value="dark">Ink Contrast</option>
          <option value="light">Paper Light</option>
          <option value="sepia">Paper Amber</option>
        </select>
      </div>
      <div class="reader-settings-actions">
        <button type="button" id="readerResetProgress">Reset chapter</button>
      </div>
    </div>`;
}

window.addEventListener('resize', () => {
  if (!isMobileViewport() && view.mobileChromeCollapsed) {
    view.mobileChromeCollapsed = false;
  }
  applyReaderChromeState();
});

init();
