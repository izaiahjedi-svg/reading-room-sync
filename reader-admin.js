async function initAdminPage(){
  const [idx, profilesData, profileStateData, booksMetaData] = await dataBridge.loadBootstrapState();
  index = Array.isArray(idx) ? idx.map(normalizeChapterIndexEntry) : [];
  booksMeta = (booksMetaData && typeof booksMetaData === 'object') ? booksMetaData : {};
  profiles = (profilesData && typeof profilesData === 'object') ? Object.assign({}, getDefaultProfiles(), profilesData) : getDefaultProfiles();
  if (profileStateData && typeof profileStateData === 'object') profileState = profileStateData;
  Object.keys(profiles).forEach((id) => {
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
  setSyncKey(getSyncKeyFromUrl() || getStoredSyncKey());
  applyTheme();
  if (syncKey) {
    await syncBridge.pullLibrary({ metaOnly:true }).catch(() => {});
    await syncBridge.pullProfileState(activeProfileId).catch(() => {});
  }
  renderAdminPage();
}

function normalizeChapterId(value){
  return (value == null ? '' : String(value)).trim();
}

function findChapterById(id){
  const wanted = normalizeChapterId(id);
  if (!wanted) return null;
  return index.find((entry) => normalizeChapterId(entry && entry.id) === wanted) || null;
}

function sortAdminChapters(a, b){
  const ab = a.book || '', bb = b.book || '';
  if (ab !== bb){
    const an = (ab.match(/(\d{1,4})/) || [])[1];
    const bn = (bb.match(/(\d{1,4})/) || [])[1];
    if (an && bn && an !== bn) return Number(an) - Number(bn);
    return ab.localeCompare(bb);
  }
  const av = a.volume || '', bv = b.volume || '';
  if (av !== bv){
    const an = (av.match(/(\d{1,4})/) || [])[1];
    const bn = (bv.match(/(\d{1,4})/) || [])[1];
    if (an && bn && an !== bn) return Number(an) - Number(bn);
    return av.localeCompare(bv);
  }
  return (a.addedAt || 0) - (b.addedAt || 0);
}

function getDisplaySortedChapters(items){
  const list = [...items];
  list.sort(sortAdminChapters);
  return list;
}

let pendingAdminCoverDataUrl = null;
let pendingAdminMangaCoverDataUrl = null;
let adminMangaUploadActive = false;
let adminDebugTimer = null;

async function mangaAdminApi(path, options) {
  const response = await fetch(path, Object.assign({ headers: { 'Content-Type': 'application/json' } }, options || {}));
  if (!response.ok) throw new Error('Manga request failed (' + response.status + ')');
  return response;
}

async function handleAdminMangaFolder(files) {
  const imageFiles = Array.from(files || []).filter((file) => /\.(jpg|jpeg|png|webp)$/i.test(file.name || ''));
  const seriesName = (document.getElementById('adminMangaTitle') && document.getElementById('adminMangaTitle').value || '').trim();
  const status = document.getElementById('adminUploadStatus');
  if (!seriesName) {
    if (status) status.textContent = 'Enter a manga series title first';
    return;
  }
  if (!imageFiles.length) {
    if (status) status.textContent = 'No manga image files found';
    return;
  }

  const sortedFiles = imageFiles.sort((a, b) => String(a.webkitRelativePath || a.name).localeCompare(String(b.webkitRelativePath || b.name), undefined, { numeric:true }));
  const chapterGroups = new Map();
  const pageVersions = new Map();
  sortedFiles.forEach((file) => {
    const parts = String(file.webkitRelativePath || file.name).replaceAll('\\', '/').split('/').filter(Boolean);
    const chapter = parts.length >= 3 ? parts[parts.length - 2] : 'chapter-0001';
    const group = chapterGroups.get(chapter) || [];
    group.push(file);
    chapterGroups.set(chapter, group);
  });

  adminMangaUploadActive = true;
  try {
    let completed = 0;
    for (const [chapter, filesForChapter] of chapterGroups) {
      for (let i = 0; i < filesForChapter.length; i++) {
        if (status) status.textContent = 'Uploading manga ' + (completed + 1) + ' of ' + sortedFiles.length + ': ' + filesForChapter[i].name;
        const dataUrl = await readAdminFileAsDataUrl(filesForChapter[i]);
        const pageResponse = await mangaAdminApi('/api/manga/page', {
          method: 'POST',
          body: JSON.stringify({ series: seriesName, chapter, page: i + 1, dataUrl }),
        });
        const pageResult = await pageResponse.json();
        const versions = pageVersions.get(chapter) || [];
        versions[i] = pageResult.v || '';
        pageVersions.set(chapter, versions);
        completed++;
      }
    }

    const response = await mangaAdminApi('/api/manga/library');
    const payload = await response.json();
    const library = payload && payload.data && payload.data.series ? payload.data : { version:1, series:{} };
    library.series = library.series || {};
    const existing = library.series[seriesName] || { name:seriesName, chapters:[] };
    existing.name = seriesName;
    existing.author = (document.getElementById('adminMangaAuthor').value || '').trim();
    existing.tags = (document.getElementById('adminMangaTags').value || '').split(',').map((value) => value.trim()).filter(Boolean);
    existing.description = (document.getElementById('adminMangaDescription').value || '').trim();
    existing.chapters = Array.isArray(existing.chapters) ? existing.chapters : [];
    chapterGroups.forEach((filesForChapter, chapter) => {
      const entry = existing.chapters.find((item) => item.key === chapter) || { key:chapter, title:chapter, pages:[] };
      const versions = pageVersions.get(chapter) || [];
      entry.pages = filesForChapter.map((file, index) => ({ name:file.name, page:index + 1, v:versions[index] || '' }));
      if (!existing.chapters.includes(entry)) existing.chapters.push(entry);
    });
    library.series[seriesName] = existing;
    await mangaAdminApi('/api/manga/library', { method:'POST', body:JSON.stringify(library) });
    if (status) status.textContent = 'Finished: ' + completed + ' manga page(s) uploaded';
  } catch (error) {
    if (status) status.textContent = 'Manga upload failed: ' + error.message;
  } finally {
    adminMangaUploadActive = false;
  }
}

function adminSetStatus(message) {
  const status = document.getElementById('adminSaveState');
  if (status) status.textContent = message;
}

function readAdminFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error('File read failed'));
    reader.readAsDataURL(file);
  });
}

function renderAdminCoverPreview(bookName) {
  const wrap = document.getElementById('adminCoverPreviewWrap');
  if (!wrap) return;
  const meta = getBookMeta(bookName);
  const cover = pendingAdminCoverDataUrl !== null ? pendingAdminCoverDataUrl : resolveCoverSrc(bookName, meta);
  if (cover) {
    wrap.innerHTML = `<img class="cover-preview" src="${cover}" alt="Book cover preview" />`;
  } else {
    wrap.innerHTML = '<div class="cover-placeholder">No cover yet</div>';
  }
}

function parseAdminChapterLines(text) {
  return String(text || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split('|').map((part) => part.trim()).filter(Boolean);
      if (parts.length >= 4) return { volume: parts[0], title: parts[2] };
      if (parts.length >= 2) return { volume: parts[0], title: parts[1] };
      return { volume: 'Chapters', title: parts[0] || '' };
    })
    .filter((entry) => entry.title);
}

function escAttr(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function formatAdminChapterLines(bookName) {
  const rows = getDisplaySortedChapters(index.filter((entry) => (entry.book || '').trim() === (bookName || '').trim()));
  return rows.map((entry) => `${entry.volume || 'Chapters'} | ${entry.title}`).join('\n');
}

function collectAdminStats(){
  const books = getAllBookNames(index);
  const profileRows = Object.entries(profiles).map(([profileId, profile]) => {
    const state = profileState && profileState[profileId] ? profileState[profileId] : { progress:{ lastChapterId:null, percents:{} }, settings:getDefaultProfileSettings() };
    const progress = state.progress || { lastChapterId:null, percents:{} };
    const chaptersRead = Object.keys(progress.percents || {}).length;
    const percentTracked = index.length ? Math.round((chaptersRead / index.length) * 100) : 0;
    const lastChapterId = progress.lastChapterId || null;
    const lastChapter = lastChapterId ? findChapterById(lastChapterId) : null;
    const settings = state.settings || getDefaultProfileSettings();
    const lastActiveMs = Number(progress.lastActiveAt || 0);
    return {
      id: profileId,
      name: profile && profile.name ? profile.name : profileId,
      lastChapter: lastChapter ? getBookLabel(lastChapter.book || '') + ' — ' + lastChapter.title : 'No recent chapter',
      lastActiveAt: lastActiveMs ? new Date(lastActiveMs).toLocaleString() : 'Never',
      chaptersRead,
      percentTracked,
      synced: !!(settings && settings.theme),
      theme: settings.theme || 'dark',
      font: settings.font || 'Georgia, "Iowan Old Style", serif'
    };
  });

  const totalTracked = Object.values(profileState || {}).reduce((sum, state) => {
    const progress = state && state.progress ? state.progress : { percents:{} };
    return sum + Object.keys(progress.percents || {}).length;
  }, 0);

  return {
    totalBooks: books.length,
    totalChapters: index.length,
    totalTracked,
    activeProfileId: activeProfileId || 'izaiah',
    profileRows,
    syncEvents: syncEvents.slice(0, 6),
    syncAttempts: syncDebug.attempts,
    syncSuccesses: syncDebug.successes,
    syncFailures: syncDebug.failures,
    lastReason: syncDebug.lastReason || 'n/a',
    lastSyncAt: syncDebug.lastAt ? new Date(syncDebug.lastAt).toLocaleString() : 'n/a'
  };
}

function renderAdminPage() {
  const stats = collectAdminStats();
  const profileRows = stats.profileRows.map((profile) => `
    <tr>
      <td>${esc(profile.name)}</td>
      <td>${esc(profile.lastActiveAt)}</td>
      <td>${esc(profile.lastChapter)}</td>
      <td>${profile.chaptersRead}</td>
      <td>${esc(profile.theme)}</td>
      <td>${esc(profile.font.split(',')[0].replace(/['"]/g, ''))}</td>
    </tr>
  `).join('') || '<tr><td colspan="6">No profile activity yet.</td></tr>';

  const syncRows = stats.syncEvents.map((event) => `
    <tr>
      <td>${esc(event.kind || 'info')}</td>
      <td>${esc(event.message || '')}</td>
      <td>${new Date(event.at || Date.now()).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' })}</td>
    </tr>
  `).join('') || '<tr><td colspan="3">No sync events yet.</td></tr>';

  main.innerHTML = `
    <div class="admin-wrap">
      <section class="admin-intro">
        <div class="home-section-head">
          <h2>Secret Admin Path</h2>
          <a class="home-subtle-link" href="/reader.html${window.location.search || ''}">Back to library</a>
        </div>
        <p class="admin-intro-copy">This page edits real Reading Room metadata and chapter labels. It also exposes the activity and diagnostics needed to monitor the local-first sync setup.</p>
      </section>

      <section class="admin-stats-grid">
        <div class="admin-stat-card">
          <div class="admin-stat-label">Books</div>
          <div class="admin-stat-value">${stats.totalBooks}</div>
        </div>
        <div class="admin-stat-card">
          <div class="admin-stat-label">Chapters</div>
          <div class="admin-stat-value">${stats.totalChapters}</div>
        </div>
        <div class="admin-stat-card">
          <div class="admin-stat-label">Tracked Reads</div>
          <div class="admin-stat-value">${stats.totalTracked}</div>
        </div>
        <div class="admin-stat-card">
          <div class="admin-stat-label">Sync State</div>
          <div class="admin-stat-value">${syncKey ? 'Live' : 'Local'}</div>
        </div>
      </section>

      <div class="admin-layout">
        <aside class="admin-panel">
          <h3>Quick Add Book</h3>
          <div class="admin-field"><label for="adminQuickTitle">Title</label><input id="adminQuickTitle" /></div>
          <div class="admin-field"><label for="adminQuickAuthor">Author</label><input id="adminQuickAuthor" /></div>
          <div class="admin-field"><label for="adminQuickStatus">Status</label><input id="adminQuickStatus" value="Ongoing" /></div>
          <div class="admin-field"><label for="adminQuickTags">Tags</label><input id="adminQuickTags" placeholder="Action, Fantasy" /></div>
          <div class="admin-field"><label for="adminQuickDescription">Description</label><textarea id="adminQuickDescription" class="admin-textarea"></textarea></div>
          <button class="primary" id="adminCreateBookBtn" type="button">Add Book</button>
        </aside>

        <section class="admin-panel admin-panel-wide">
          <div class="home-section-head">
            <h2>Edit Book</h2>
            <span id="adminSaveState" class="home-subtle">Ready</span>
          </div>
          <div class="admin-grid-live">
            <div class="admin-field"><label for="adminBookSelect">Select Book</label><select id="adminBookSelect"></select></div>
            <div class="admin-field"><label for="adminBookTitle">Title</label><input id="adminBookTitle" /></div>
            <div class="admin-field"><label for="adminBookAuthor">Author</label><input id="adminBookAuthor" /></div>
            <div class="admin-field"><label for="adminBookStatus">Status</label><input id="adminBookStatus" /></div>
            <div class="admin-field admin-wide"><label>Cover</label><div id="adminCoverPreviewWrap"></div><div class="admin-cover-actions"><button id="adminUploadCoverBtn" type="button">Upload cover</button><button id="adminRemoveCoverBtn" type="button">Remove cover</button></div></div>
            <div class="admin-field admin-wide"><label for="adminBookTags">Tags</label><input id="adminBookTags" placeholder="Action, Fantasy" /></div>
            <div class="admin-field admin-wide"><label for="adminBookDescription">Description</label><textarea id="adminBookDescription" class="admin-textarea"></textarea></div>
            <div class="admin-field admin-wide"><label for="adminUploadVolumeSelect">Upload to Volume</label><select id="adminUploadVolumeSelect"></select></div>
            <div class="admin-field admin-wide"><label for="adminUploadVolumeInput">Or custom volume</label><input id="adminUploadVolumeInput" placeholder="e.g., Volume 3" /></div>
            <div class="admin-field admin-wide"><label>Selected book</label><div class="admin-inline-value">${esc((() => {
              const select = document.getElementById('adminBookSelect');
              return select ? (select.value || 'No book selected') : 'No book selected';
            })())}</div></div>
            <div class="admin-field admin-wide"><label for="adminBookChapters">Volumes + Chapter Titles</label><textarea id="adminBookChapters" class="admin-textarea admin-textarea-tall"></textarea><p class="admin-help">Use one line per chapter. Format: Volume | Chapter Title</p></div>
            <div class="admin-field admin-wide">
              <label>Upload chapters</label>
              <div class="admin-action-row">
                <button id="adminAddFilesBtn" type="button">Choose files</button>
                <button id="adminAddFolderBtn" type="button">Choose folder</button>
              </div>
              <div id="adminUploadStatus" class="admin-upload-status">Idle</div>
            </div>
          </div>
          <div class="admin-action-row">
            <button class="primary" id="adminSaveBookBtn" type="button">Save Changes</button>
            <button id="adminDeleteBookBtn" type="button">Delete Book</button>
            <button id="adminOpenTitleBtn" type="button">Open Title</button>
            <button id="adminSyncBtn" type="button">Sync Now</button>
          </div>
        </section>
      </div>

      <section class="admin-panel admin-panel-wide">
        <div class="home-section-head"><h2>Manga Series</h2><span class="home-subtle">R2-backed manga management</span></div>
        <div class="admin-grid-live">
          <div class="admin-field"><label for="adminMangaTitle">Title</label><input id="adminMangaTitle" /></div>
          <div class="admin-field"><label for="adminMangaAuthor">Author</label><input id="adminMangaAuthor" /></div>
          <div class="admin-field admin-wide"><label for="adminMangaTags">Tags</label><input id="adminMangaTags" placeholder="Action, Fantasy" /></div>
          <div class="admin-field admin-wide"><label for="adminMangaDescription">Description</label><textarea id="adminMangaDescription" class="admin-textarea"></textarea></div>
          <div class="admin-field admin-wide"><label>Cover</label><div id="adminMangaCoverPreviewWrap"><div class="cover-placeholder">No cover yet</div></div><div class="admin-cover-actions"><button id="adminMangaUploadCoverBtn" type="button">Upload cover</button><button id="adminMangaSaveBtn" class="primary" type="button">Save series</button></div></div>
          <div class="admin-field admin-wide"><label>Chapter pages</label><div class="admin-action-row"><button id="adminMangaAddFolderBtn" type="button">Choose manga folder</button></div><div class="admin-help">Upload status appears in the existing admin upload status indicator.</div></div>
        </div>
      </section>

      <section class="admin-panel admin-panel-wide admin-lower-panel">
        <div class="home-section-head">
          <h2>Profile Activity</h2>
          <span class="home-subtle">Active profile: ${esc(stats.activeProfileId)}</span>
        </div>
        <table class="admin-table">
          <thead>
            <tr>
              <th>Profile</th>
              <th>Last Active</th>
              <th>Last Reading</th>
              <th>Chapters Read</th>
              <th>Theme</th>
              <th>Font</th>
            </tr>
          </thead>
          <tbody>${profileRows}</tbody>
        </table>
      </section>

      <section class="admin-panel admin-panel-wide admin-lower-panel">
        <div class="home-section-head">
          <h2>Debug Stats</h2>
          <span class="home-subtle">${esc(stats.lastReason)}</span>
        </div>
        <div class="admin-debug-grid" id="adminDebugGrid">
          <div class="admin-debug-box"><span>Sync attempts</span><strong>${stats.syncAttempts}</strong></div>
          <div class="admin-debug-box"><span>Sync successes</span><strong>${stats.syncSuccesses}</strong></div>
          <div class="admin-debug-box"><span>Sync failures</span><strong>${stats.syncFailures}</strong></div>
          <div class="admin-debug-box"><span>Last sync</span><strong>${esc(stats.lastSyncAt)}</strong></div>
        </div>
        <div class="admin-action-row" style="margin:12px 0;"><button id="adminCopyDebugBtn" type="button">Copy debug report</button></div>
        <table class="admin-table">
          <thead>
            <tr>
              <th>Kind</th>
              <th>Message</th>
              <th>Time</th>
            </tr>
          </thead>
          <tbody>${syncRows}</tbody>
        </table>
      </section>
    </div>`;

  const bookSelect = document.getElementById('adminBookSelect');
  const bookTitle = document.getElementById('adminBookTitle');
  const bookAuthor = document.getElementById('adminBookAuthor');
  const bookStatus = document.getElementById('adminBookStatus');
  const bookTags = document.getElementById('adminBookTags');
  const bookDescription = document.getElementById('adminBookDescription');
  const bookChapters = document.getElementById('adminBookChapters');
  const coverInput = document.getElementById('adminCoverInput');
  const uploadCoverBtn = document.getElementById('adminUploadCoverBtn');
  const removeCoverBtn = document.getElementById('adminRemoveCoverBtn');
  const adminUploadVolumeInput = document.getElementById('adminUploadVolumeInput');
  const adminUploadVolumeSelect = document.getElementById('adminUploadVolumeSelect');
  const adminUploadStatus = document.getElementById('adminUploadStatus');
  const mangaCoverInput = document.getElementById('mangaCoverInput');
  const mangaUploadCoverBtn = document.getElementById('adminMangaUploadCoverBtn');
  const mangaSaveBtn = document.getElementById('adminMangaSaveBtn');
  const mangaFolderBtn = document.getElementById('adminMangaAddFolderBtn');

  async function saveMangaSeries() {
    const title = (document.getElementById('adminMangaTitle').value || '').trim();
    if (!title) {
      adminSetStatus('Manga title required');
      return;
    }
    try {
      const response = await mangaAdminApi('/api/manga/library');
      const payload = await response.json();
      const library = payload && payload.data && payload.data.series ? payload.data : { version:1, series:{} };
      library.series = library.series || {};
      const existing = library.series[title] || { name:title, chapters:[] };
      existing.name = title;
      existing.author = (document.getElementById('adminMangaAuthor').value || '').trim();
      existing.tags = (document.getElementById('adminMangaTags').value || '').split(',').map((value) => value.trim()).filter(Boolean);
      existing.description = (document.getElementById('adminMangaDescription').value || '').trim();
      if (pendingAdminMangaCoverDataUrl) {
        const coverResponse = await mangaAdminApi('/api/manga/cover', { method:'POST', body:JSON.stringify({ series:title, dataUrl:pendingAdminMangaCoverDataUrl }) });
        const coverResult = await coverResponse.json();
        existing.coverV = coverResult.v || existing.coverV || '';
      }
      library.series[title] = existing;
      await mangaAdminApi('/api/manga/library', { method:'POST', body:JSON.stringify(library) });
      pendingAdminMangaCoverDataUrl = null;
      adminSetStatus('Manga series saved');
      const preview = document.getElementById('adminMangaCoverPreviewWrap');
      if (preview) preview.innerHTML = '<div class="cover-placeholder">Saved</div>';
    } catch (error) {
      adminSetStatus('Manga save failed: ' + error.message);
    }
  }

  if (mangaUploadCoverBtn && mangaCoverInput) mangaUploadCoverBtn.onclick = () => mangaCoverInput.click();
  if (mangaCoverInput) mangaCoverInput.onchange = async (event) => {
    const file = event.target.files && event.target.files[0];
    if (!file) return;
    pendingAdminMangaCoverDataUrl = await readAdminFileAsDataUrl(file);
    const preview = document.getElementById('adminMangaCoverPreviewWrap');
    if (preview) preview.innerHTML = '<div class="cover-placeholder">Cover ready to save</div>';
    mangaCoverInput.value = '';
  };
  if (mangaSaveBtn) mangaSaveBtn.onclick = saveMangaSeries;
  if (mangaFolderBtn) mangaFolderBtn.onclick = () => {
    const title = (document.getElementById('adminMangaTitle').value || '').trim();
    if (!title) {
      adminSetStatus('Enter a manga series title first');
      return;
    }
    adminMangaUploadActive = true;
    folderInput.value = '';
    folderInput.click();
  };
  if (folderInput) folderInput.addEventListener('change', (event) => {
    if (!adminMangaUploadActive) return;
    handleAdminMangaFolder(event.target.files).finally(() => { folderInput.value = ''; });
  });

  function updateAdminVolumeOptions(bookName) {
    if (!adminUploadVolumeSelect) return;
    const selectedVolume = (adminUploadVolumeInput && adminUploadVolumeInput.value ? adminUploadVolumeInput.value : adminUploadVolumeSelect.value || '').trim();
    const existingVolumeNames = [...new Set(index
      .filter((entry) => (entry.book || '').trim() === (bookName || '').trim())
      .map((entry) => (entry.volume || '').trim() || 'Chapters'))]
      .sort((a, b) => {
        const an = volumeSortNum(a), bn = volumeSortNum(b);
        if (an != null && bn != null) return an - bn;
        return a.localeCompare(b);
      });

    adminUploadVolumeSelect.innerHTML = '<option value="">Custom volume</option>' + existingVolumeNames.map((vol) => `<option value="${escAttr(vol)}">${esc(vol)}</option>`).join('');
    if (selectedVolume && existingVolumeNames.includes(selectedVolume)) {
      adminUploadVolumeSelect.value = selectedVolume;
    } else {
      adminUploadVolumeSelect.value = '';
    }
    if (adminUploadVolumeInput && !adminUploadVolumeInput.value) {
      adminUploadVolumeInput.value = selectedVolume || '';
    }
  }

  function loadBookOptions() {
    const books = getAllBookNames();
    bookSelect.innerHTML = '';
    books.forEach((bookName) => {
      const option = document.createElement('option');
      option.value = bookName;
      option.textContent = getBookLabel(bookName);
      bookSelect.appendChild(option);
    });
    if (books.length && !bookSelect.value) bookSelect.value = books[0];
  }

  function loadBookForm(bookName) {
    pendingAdminCoverDataUrl = null;
    const meta = getBookMeta(bookName);
    bookTitle.value = meta.title || '';
    bookAuthor.value = meta.author || '';
    bookStatus.value = meta.status || '';
    bookTags.value = (meta.tags || []).join(', ');
    bookDescription.value = meta.description || '';
    bookChapters.value = formatAdminChapterLines(bookName);
    updateAdminVolumeOptions(bookName);
    renderAdminCoverPreview(bookName);
  }

  async function saveBookChanges() {
    const selected = (bookSelect.value || '').trim();
    if (!selected) return;
    const nextTitle = (bookTitle.value || '').trim();
    if (!nextTitle) {
      adminSetStatus('Title required');
      return;
    }

    let targetKey = selected;
    if (selected !== nextTitle) {
      index.forEach((entry) => {
        if ((entry.book || '').trim() === selected) entry.book = nextTitle;
      });
      if (booksMeta[selected]) {
        booksMeta[nextTitle] = booksMeta[selected];
        delete booksMeta[selected];
      }
      targetKey = nextTitle;
    }

    const meta = Object.assign({}, getBookMeta(targetKey), {
      title: nextTitle,
      author: (bookAuthor.value || '').trim(),
      status: (bookStatus.value || '').trim() || 'Ongoing',
      description: (bookDescription.value || '').trim(),
      tags: (bookTags.value || '').split(',').map((value) => value.trim()).filter(Boolean)
    });
    if (pendingAdminCoverDataUrl !== null) {
      if (pendingAdminCoverDataUrl === '') {
        meta.coverDataUrl = '';
        meta.coverPath = '';
      } else if (syncKey) {
        const uploaded = await uploadCoverToServer(targetKey, pendingAdminCoverDataUrl);
        if (uploaded.ok && uploaded.coverPath) {
          meta.coverPath = uploaded.coverPath;
          meta.coverDataUrl = '';
        } else {
          meta.coverDataUrl = pendingAdminCoverDataUrl;
          meta.coverPath = '';
        }
      } else {
        meta.coverDataUrl = pendingAdminCoverDataUrl;
        meta.coverPath = '';
      }
    }
    booksMeta[targetKey] = meta;

    const currentBookRows = getDisplaySortedChapters(index.filter((entry) => (entry.book || '').trim() === targetKey));
    const parsedLines = parseAdminChapterLines(bookChapters.value);
    const count = Math.min(currentBookRows.length, parsedLines.length);
    for (let i = 0; i < count; i++) {
      currentBookRows[i].volume = parsedLines[i].volume || currentBookRows[i].volume || 'Chapters';
      currentBookRows[i].title = parsedLines[i].title || currentBookRows[i].title;
      const chapterData = await dataBridge.getChapter(currentBookRows[i].id);
      if (chapterData) {
        await dataBridge.saveChapter(currentBookRows[i].id, Object.assign({}, chapterData, { title: currentBookRows[i].title }));
        if (syncKey) await syncBridge.pushChapter(currentBookRows[i].id, Object.assign({}, chapterData, { title: currentBookRows[i].title }));
      }
    }

    index.sort(sortChapters);
    await dataBridge.saveIndex(index);
    await dataBridge.saveBooksMeta(booksMeta);
    if (syncKey) await syncBridge.pushLibrary();
    loadBookOptions();
    bookSelect.value = targetKey;
    loadBookForm(targetKey);
    adminSetStatus(parsedLines.length !== currentBookRows.length ? 'Saved metadata. Chapter line count differed, so only overlapping chapters were updated.' : 'Saved');
  }

  async function createBook() {
    const title = (document.getElementById('adminQuickTitle').value || '').trim();
    if (!title) {
      adminSetStatus('Quick add needs a title');
      return;
    }
    if (!booksMeta[title]) {
      booksMeta[title] = {
        title,
        author: (document.getElementById('adminQuickAuthor').value || '').trim(),
        status: (document.getElementById('adminQuickStatus').value || '').trim() || 'Ongoing',
        description: (document.getElementById('adminQuickDescription').value || '').trim(),
        tags: (document.getElementById('adminQuickTags').value || '').split(',').map((value) => value.trim()).filter(Boolean),
        coverPath: '',
        coverDataUrl: ''
      };
      await dataBridge.saveBooksMeta(booksMeta);
      if (syncKey) await syncBridge.pushLibrary();
    }
    loadBookOptions();
    bookSelect.value = title;
    loadBookForm(title);
    adminSetStatus('Book created');
  }

  async function deleteBook() {
    const selected = (bookSelect.value || '').trim();
    if (!selected) return;
    if (!confirm('Delete this book and all chapters?')) return;
    const doomedIds = index.filter((entry) => (entry.book || '').trim() === selected).map((entry) => entry.id);
    index = index.filter((entry) => (entry.book || '').trim() !== selected);
    delete booksMeta[selected];
    for (const id of doomedIds) {
      await dataBridge.deleteChapter(id);
    }
    await dataBridge.saveIndex(index);
    await dataBridge.saveBooksMeta(booksMeta);
    if (syncKey) await syncBridge.pushLibrary({ forceReplace:true });
    loadBookOptions();
    if (bookSelect.value) loadBookForm(bookSelect.value);
    adminSetStatus('Book deleted');
  }

  function beginAdminChapterUpload(useFolder) {
    const selectedBook = (bookSelect.value || '').trim();
    if (!selectedBook) {
      adminSetStatus('Select a book first');
      if (adminUploadStatus) adminUploadStatus.textContent = 'Select a book first';
      return;
    }
    if (!fileInput || !folderInput) {
      adminSetStatus('Upload inputs are missing from this admin page');
      if (adminUploadStatus) adminUploadStatus.textContent = 'Upload inputs missing';
      return;
    }
    const selectedVolume = (adminUploadVolumeInput && adminUploadVolumeInput.value ? adminUploadVolumeInput.value : adminUploadVolumeSelect && adminUploadVolumeSelect.value ? adminUploadVolumeSelect.value : '').trim();
    pendingUploadBook = selectedBook;
    pendingUploadVolume = selectedVolume || null;
    if (adminUploadStatus) adminUploadStatus.textContent = 'Preparing upload… folder/file picker is opening';
    const picker = useFolder ? folderInput : fileInput;
    if (picker) {
      picker.value = '';
      picker.click();
    }
  }

  const createBookBtn = document.getElementById('adminCreateBookBtn');
  const saveBookBtn = document.getElementById('adminSaveBookBtn');
  const deleteBookBtn = document.getElementById('adminDeleteBookBtn');
  const openTitleBtn = document.getElementById('adminOpenTitleBtn');
  const addFilesBtn = document.getElementById('adminAddFilesBtn');
  const addFolderBtn = document.getElementById('adminAddFolderBtn');
  const syncBtn = document.getElementById('adminSyncBtn');

  if (createBookBtn) createBookBtn.onclick = createBook;
  if (saveBookBtn) saveBookBtn.onclick = saveBookChanges;
  if (deleteBookBtn) deleteBookBtn.onclick = deleteBook;
  if (uploadCoverBtn && coverInput) uploadCoverBtn.onclick = () => coverInput.click();
  if (removeCoverBtn) removeCoverBtn.onclick = () => {
    pendingAdminCoverDataUrl = '';
    if (bookSelect) renderAdminCoverPreview(bookSelect.value);
  };
  if (coverInput) coverInput.onchange = async (event) => {
    const file = event.target.files && event.target.files[0];
    if (!file) return;
    try {
      pendingAdminCoverDataUrl = await readAdminFileAsDataUrl(file);
      if (bookSelect) renderAdminCoverPreview(bookSelect.value);
      adminSetStatus('Cover ready to save');
    } catch (error) {
      adminSetStatus('Cover read failed');
    } finally {
      coverInput.value = '';
    }
  };
  if (openTitleBtn && bookSelect) openTitleBtn.onclick = () => {
    if (bookSelect.value) window.location.href = buildBookReaderPath(bookSelect.value);
  };
  if (addFilesBtn) addFilesBtn.onclick = () => beginAdminChapterUpload(false);
  if (addFolderBtn) addFolderBtn.onclick = () => beginAdminChapterUpload(true);
  if (adminUploadVolumeSelect && adminUploadVolumeInput) {
    adminUploadVolumeSelect.onchange = () => {
      adminUploadVolumeInput.value = adminUploadVolumeSelect.value || '';
    };
  }
  if (syncBtn) syncBtn.onclick = async () => {
    if (!syncKey) {
      adminSetStatus('No sync key configured');
      return;
    }
    const ok = await syncBridge.pushLibrary();
    adminSetStatus(ok ? 'Synced' : 'Sync failed');
  };
  const debugGrid = document.getElementById('adminDebugGrid');
  const copyDebugBtn = document.getElementById('adminCopyDebugBtn');
  async function refreshAdminDebug() {
    if (!debugGrid || typeof collectMainPageDebugData !== 'function') return;
    try {
      const debug = await collectMainPageDebugData();
      const backfill = debug.backfill || {};
      const cleanup = debug.scopedCleanup || {};
      debugGrid.innerHTML = [
        ['Sync attempts', syncDebug.attempts],
        ['Sync successes', syncDebug.successes],
        ['Sync failures', syncDebug.failures],
        ['Sync duration', (syncDebug.lastDurationMs || 0) + ' ms'],
        ['Payload size', formatBytes(debug.payloadBytes || 0)],
        ['Missing local bodies', debug.missingChapterCount || 0],
        ['Chapter coverage', (debug.backfillPercent || 0) + '%'],
        ['Backfill scanned', (backfill.scanned || 0) + '/' + (backfill.total || 0)],
        ['Backfill checked', backfill.checked || 0],
        ['Backfill uploaded', backfill.uploaded || 0],
        ['Backfill failed', backfill.failed || 0],
        ['Backfill state', backfill.active ? 'Active' : (backfill.complete ? 'Complete' : 'Idle')],
        ['Cleanup deleted', cleanup.deleted || 0],
        ['Cleanup remaining', cleanup.remaining || 0],
      ].map(([label, value]) => '<div class="admin-debug-box"><span>' + esc(label) + '</span><strong>' + esc(String(value)) + '</strong></div>').join('');
    } catch (error) {
      debugGrid.innerHTML = '<div class="admin-debug-box"><span>Diagnostics</span><strong>Failed</strong></div>';
    }
  }
  if (copyDebugBtn && typeof copyDebugReport === 'function') copyDebugBtn.onclick = () => copyDebugReport();
  if (adminDebugTimer) clearInterval(adminDebugTimer);
  refreshAdminDebug();
  adminDebugTimer = setInterval(refreshAdminDebug, 2000);
  if (bookSelect) bookSelect.onchange = () => loadBookForm(bookSelect.value);

  loadBookOptions();
  if (bookSelect.value) loadBookForm(bookSelect.value);
}

initAdminPage();
