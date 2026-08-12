  // ---------------------------------------------------------------
  // Storage backend: use IndexedDB for larger payloads and chunk big
  // values so chapter uploads don't hit localStorage quota limits.
  // ---------------------------------------------------------------
  const PREFIX = 'reading-room:';
  const DB_NAME = 'reading-room-db';
  const STORE_NAME = 'items';
  const CHUNK_SIZE = 256 * 1024;
  let dbPromise = null;
  const memoryCache = {};

  function openDatabase(){
    if (!window.indexedDB) return Promise.reject(new Error('IndexedDB unavailable'));
    if (dbPromise) return dbPromise;

    dbPromise = new Promise((resolve, reject) => {
      const request = window.indexedDB.open(DB_NAME, 2);
      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: 'key' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('IndexedDB unavailable'));
    });

    return dbPromise;
  }

  async function getFromDb(key){
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      tx.onabort = () => reject(tx.error || new Error('Read aborted'));
      tx.onerror = () => reject(tx.error || new Error('Read failed'));
      const store = tx.objectStore(STORE_NAME);
      const request = store.get(key);
      request.onsuccess = () => resolve(request.result ? request.result.value : null);
      request.onerror = () => reject(request.error || new Error('Read failed'));
    });
  }

  async function setInDb(key, value){
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.onabort = () => reject(tx.error || new Error('Write aborted'));
      tx.onerror = () => reject(tx.error || new Error('Write failed'));
      const store = tx.objectStore(STORE_NAME);
      const request = store.put({ key, value });
      request.onsuccess = () => resolve({ key, value, shared:false });
      request.onerror = () => reject(request.error || new Error('Write failed'));
    });
  }

  async function deleteFromDb(key){
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.onabort = () => reject(tx.error || new Error('Delete aborted'));
      tx.onerror = () => reject(tx.error || new Error('Delete failed'));
      const store = tx.objectStore(STORE_NAME);
      const request = store.delete(key);
      request.onsuccess = () => resolve({ key, deleted:true, shared:false });
      request.onerror = () => reject(request.error || new Error('Delete failed'));
    });
  }

  async function listFromDb(prefix){
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      tx.onabort = () => reject(tx.error || new Error('List aborted'));
      tx.onerror = () => reject(tx.error || new Error('List failed'));
      const store = tx.objectStore(STORE_NAME);
      const request = store.openCursor();
      const keys = [];
      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor) {
          const key = cursor.key;
          if (!prefix || key.startsWith(prefix)) keys.push(key.slice(PREFIX.length));
          cursor.continue();
        } else {
          resolve({ keys, prefix, shared:false });
        }
      };
      request.onerror = () => reject(request.error || new Error('List failed'));
    });
  }

  async function setChunkedValue(fullKey, value){
    const previousMetaRaw = await getFromDb(fullKey);
    let previousChunkKeys = [];
    if (previousMetaRaw) {
      try {
        const previousMeta = JSON.parse(previousMetaRaw);
        if (previousMeta && previousMeta.kind === 'chunked' && Array.isArray(previousMeta.chunkKeys)) {
          previousChunkKeys = previousMeta.chunkKeys;
        }
      } catch (e) {}
    }

    const chunks = [];
    for (let offset = 0; offset < value.length; offset += CHUNK_SIZE) {
      chunks.push(value.slice(offset, offset + CHUNK_SIZE));
    }

    const meta = { kind: 'chunked', chunkCount: chunks.length, chunkKeys: chunks.map((_, index) => fullKey + ':chunk:' + index) };
    await setInDb(fullKey, JSON.stringify(meta));
    for (let i = 0; i < chunks.length; i++) {
      await setInDb(meta.chunkKeys[i], chunks[i]);
    }

    const nextChunkKeySet = new Set(meta.chunkKeys);
    for (const oldKey of previousChunkKeys) {
      if (!nextChunkKeySet.has(oldKey)) {
        await deleteFromDb(oldKey);
      }
    }

    memoryCache[fullKey] = value;
    return { key: fullKey, value, shared:false };
  }

  async function getChunkedValue(fullKey){
    const metaRaw = await getFromDb(fullKey);
    if (!metaRaw) return null;
    try {
      const meta = JSON.parse(metaRaw);
      if (!meta || meta.kind !== 'chunked') return metaRaw;
      const chunks = [];
      for (const chunkKey of meta.chunkKeys || []) {
        const chunk = await getFromDb(chunkKey);
        if (chunk === null || chunk === undefined) return null;
        chunks.push(chunk);
      }
      const value = chunks.join('');
      memoryCache[fullKey] = value;
      return value;
    } catch (e) {
      return metaRaw;
    }
  }

  async function deleteChunkedValue(fullKey){
    const metaRaw = await getFromDb(fullKey);
    if (metaRaw) {
      try {
        const meta = JSON.parse(metaRaw);
        if (meta && meta.kind === 'chunked') {
          for (const chunkKey of meta.chunkKeys || []) {
            await deleteFromDb(chunkKey);
          }
        }
      } catch (e) {}
    }
    await deleteFromDb(fullKey);
    delete memoryCache[fullKey];
    return { key: fullKey, deleted:true, shared:false };
  }

  async function migrateLegacyStorage(){
    if (!window.localStorage) return;
    const legacyKeys = [];
    for (let i = 0; i < window.localStorage.length; i++) {
      const fullKey = window.localStorage.key(i);
      if (fullKey && fullKey.startsWith(PREFIX)) legacyKeys.push(fullKey);
    }
    for (const fullKey of legacyKeys) {
      try {
        const raw = window.localStorage.getItem(fullKey);
        if (raw != null) await setInDb(fullKey, raw);
      } catch (e) {
        console.warn('Could not migrate legacy storage entry', fullKey, e);
      }
    }
  }

  window.storage = {
    async get(key){
      const fullKey = PREFIX + key;
      if (memoryCache[fullKey] !== undefined) return { key, value: memoryCache[fullKey], shared:false };
      try {
        const raw = await getChunkedValue(fullKey);
        if (raw !== null) return { key, value: raw, shared:false };
      } catch (e) {
        console.warn('IndexedDB read failed, falling back to localStorage', e);
      }
      if (window.localStorage) {
        const raw = window.localStorage.getItem(fullKey);
        return raw === null ? null : { key, value: raw, shared:false };
      }
      return null;
    },
    async set(key, value){
      const fullKey = PREFIX + key;
      try {
        if (typeof value === 'string' && value.length > CHUNK_SIZE) {
          return await setChunkedValue(fullKey, value);
        }

        await deleteChunkedValue(fullKey);
        await setInDb(fullKey, value);
        memoryCache[fullKey] = value;
        return { key, value, shared:false };
      } catch (e) {
        console.warn('IndexedDB write failed, falling back to localStorage', e);
        if (window.localStorage && typeof value === 'string' && value.length < 5 * 1024 * 1024) {
          window.localStorage.setItem(fullKey, value);
          memoryCache[fullKey] = value;
          return { key, value, shared:false };
        }
        throw e;
      }
    },
    async delete(key){
      const fullKey = PREFIX + key;
      try {
        return await deleteChunkedValue(fullKey);
      } catch (e) {
        console.warn('IndexedDB delete failed, falling back to localStorage', e);
        if (window.localStorage) {
          window.localStorage.removeItem(fullKey);
          delete memoryCache[fullKey];
          return { key, deleted:true, shared:false };
        }
        throw e;
      }
    },
    async list(prefix){
      try {
        return await listFromDb(PREFIX + (prefix || ''));
      } catch (e) {
        console.warn('IndexedDB list failed, falling back to localStorage', e);
        const keys = [];
        if (window.localStorage) {
          for (let i = 0; i < window.localStorage.length; i++) {
            const k = window.localStorage.key(i);
            if (k && k.startsWith(PREFIX)) {
              const bare = k.slice(PREFIX.length);
              if (!prefix || bare.startsWith(prefix)) keys.push(bare);
            }
          }
        }
        return { keys, prefix, shared:false };
      }
    }
  };

  migrateLegacyStorage().catch(() => {});

  async function storageGet(key){
    try{
      const r = await window.storage.get(scopeLibraryKey(key), false);
      return r ? JSON.parse(r.value) : null;
    }catch(e){ return null; }
  }
  async function storageSet(key, value, attempts=3){
    for (let i=0; i<attempts; i++){
      try{
        const r = await window.storage.set(scopeLibraryKey(key), JSON.stringify(value), false);
        if (r) return true;
      }catch(e){
        console.error('storage set failed (attempt ' + (i+1) + ')', key, e);
      }
      if (i < attempts-1) await new Promise(res => setTimeout(res, 500 * (i+1)));
    }
    return false;
  }
  async function storageDelete(key){
    try{ await window.storage.delete(scopeLibraryKey(key), false); }catch(e){}
  }

  let index = [];
  let booksMeta = {};
  let activeProfileId = 'izaiah';
  let profiles = getDefaultProfiles();
  let profileState = {
    izaiah: {
      progress: { lastChapterId:null, percents:{} },
      settings: { font:'Georgia, "Iowan Old Style", serif', fontSize:19, lineHeight:1.7, theme:'dark' }
    },
    andrew: {
      progress: { lastChapterId:null, percents:{} },
      settings: { font:'Georgia, "Iowan Old Style", serif', fontSize:19, lineHeight:1.7, theme:'dark' }
    },
    david: {
      progress: { lastChapterId:null, percents:{} },
      settings: { font:'Georgia, "Iowan Old Style", serif', fontSize:19, lineHeight:1.7, theme:'dark' }
    }
  };
  let view = { mode:'library', chapterId:null, search:'', bookFilter:'', chapterSort:'book-volume-added', booksCollapsed:false, debugOpen:false, mobileChromeCollapsed:false };
  let saveTimer = null;
  let settingsSaveTimer = null;
  let pendingChapterTitle = '';
  let pendingUploadBook = '';
  let pendingUploadVolume = '';
  let remoteSyncPrimed = false;
  let attemptedRemoteBootstrap = false;
  let chapterBackfillInFlight = false;
  let chapterBackfillTimer = null;
  let scopedCleanupInFlight = false;
  let scopedCleanupTimer = null;
  let syncInFlight = false;
  let syncPending = false;
  let syncPendingReplace = false;
  let syncRecoveryTimer = null;
  let syncRecoveryInFlight = false;
  let syncRecoveryFailures = 0;
  let lastSyncedPayloadSig = '';
  let syncDebug = {
    attempts: 0,
    successes: 0,
    failures: 0,
    lastReason: '',
    lastError: '',
    lastPayloadBytes: 0,
    lastDurationMs: 0,
    lastAt: 0,
    recoveryAttempts: 0,
  };
  let backfillDebug = {
    runs: 0,
    total: 0,
    checked: 0,
    uploaded: 0,
    failed: 0,
    scanned: 0,
    cursor: 0,
    complete: false,
    active: false,
    lastRunAt: 0,
    message: '',
  };
  let scopedCleanupDebug = {
    runs: 0,
    total: 0,
    deleted: 0,
    remaining: 0,
    active: false,
    complete: false,
    lastRunAt: 0,
    message: '',
  };
  let syncEvents = [];
  let mainPageDebug = { loading:false, data:null, error:'' };
  let pendingCoverDataUrl = null;
  let syncStatus = { state:'idle', at:0, message:'' };
  let lastRemoteLibraryErrorStatus = 0;
  let lastRemoteLibraryRetryAfterSec = 0;
  let progressSyncTimer = null;
  const progressSyncState = {};
  const PROGRESS_SYNC_MIN_INTERVAL_MS = 15000;
  const CHAPTER_UPDATED_CUTOVER_UTC = '2026-07-31T00:00:00.000Z';
  const CHAPTER_UPDATED_CUTOVER_MS = Date.parse(CHAPTER_UPDATED_CUTOVER_UTC) || 0;

  function addSyncEvent(kind, message){
    syncEvents.unshift({ at: Date.now(), kind: kind || 'info', message: message || '' });
    if (syncEvents.length > 40) syncEvents = syncEvents.slice(0, 40);
  }

  function createBridgeEvents(){
    const listeners = new Map();
    return {
      on(eventName, handler){
        if (!eventName || typeof handler !== 'function') return () => {};
        const bucket = listeners.get(eventName) || [];
        bucket.push(handler);
        listeners.set(eventName, bucket);
        return () => {
          const next = (listeners.get(eventName) || []).filter((fn) => fn !== handler);
          listeners.set(eventName, next);
        };
      },
      emit(eventName, payload){
        const bucket = listeners.get(eventName) || [];
        bucket.forEach((fn) => {
          try { fn(payload); } catch (e) {}
        });
      }
    };
  }

  const bridgeEvents = createBridgeEvents();

  const FONT_OPTIONS = [
    { label:'Literata', value:'"Literata", Georgia, serif' },
    { label:'Sora', value:'"Sora", "Segoe UI", sans-serif' },
    { label:'Georgia', value:'Georgia, "Times New Roman", serif' },
    { label:'Palatino', value:'"Palatino Linotype", "Book Antiqua", Palatino, serif' },
    { label:'Charter', value:'"Charter", "Bitstream Charter", Georgia, serif' },
    { label:'Verdana Sans', value:'Verdana, "Segoe UI", sans-serif' },
    { label:'System Sans', value:'"Segoe UI", Tahoma, Verdana, sans-serif' },
    { label:'Monospace', value:'"SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace' },
    { label:'Patrick Hand', value:'"Patrick Hand", "Comic Sans MS", cursive' },
  ];

  const app = document.getElementById('app');
  const main = document.getElementById('main');
  const topbarActions = document.getElementById('topbarActions');
  const brandTitle = document.getElementById('brandTitle');
  const fileInput = document.getElementById('fileInput');
  const folderInput = document.getElementById('folderInput');
  const importInput = document.getElementById('importInput');
  const coverInput = document.getElementById('coverInput');
  let syncKey = '';
  const SYNC_KEY_STORAGE_KEY = 'reading-room:sync-key';
  const ACTIVE_PROFILE_STORAGE_KEY = 'reading-room:active-profile-id';
  const SYNC_ENDPOINT = '/api/library';
  const STATE_ENDPOINT = '/api/state';
  const COVER_ENDPOINT = '/api/cover';
  const CHAPTER_ENDPOINT = '/api/chapter';
  let profileStateRefreshTimer = null;
  let profileStateRefreshInFlight = false;

  function getRouteBookSlug(){
    const parts = window.location.pathname.split('/').filter(Boolean);
    if (!parts.length || parts[parts.length - 1] !== 'reader.html') return '';
    if (parts.length === 2) {
      return decodeURIComponent(parts[0] || '').trim().toLowerCase();
    }
    return '';
  }

  const routeBookSlug = getRouteBookSlug();

  function isSharedLibraryKey(key){
    return key === 'chapters-index' || key === 'books-meta' || key.startsWith('chapter:');
  }

  function scopeLibraryKey(key){
    return key;
  }

  async function getScopedStorageValue(key, scopeSlug){
    if (!scopeSlug || !isSharedLibraryKey(key)) return null;
    try {
      const raw = await window.storage.get('book:' + scopeSlug + ':' + key, false);
      return raw ? JSON.parse(raw.value) : null;
    } catch (e) {
      return null;
    }
  }

  async function migrateScopedLibraryToGlobal(scopeSlug){
    if (!scopeSlug) return;
    const existingGlobalIndex = await storageGet('chapters-index');
    if (Array.isArray(existingGlobalIndex) && existingGlobalIndex.length) return;

    const scopedIndex = await getScopedStorageValue('chapters-index', scopeSlug);
    if (!Array.isArray(scopedIndex) || !scopedIndex.length) return;

    const scopedBooksMeta = await getScopedStorageValue('books-meta', scopeSlug);
    const scopedProfiles = await getScopedStorageValue('profiles-data', scopeSlug);
    const scopedProfileState = await getScopedStorageValue('profile-state', scopeSlug);
    const scopedProgress = await getScopedStorageValue('progress', scopeSlug);
    const scopedSettings = await getScopedStorageValue('settings', scopeSlug);

    await storageSet('chapters-index', scopedIndex);
    if (scopedBooksMeta && typeof scopedBooksMeta === 'object') await storageSet('books-meta', scopedBooksMeta);
    if (scopedProfiles && typeof scopedProfiles === 'object') await storageSet('profiles-data', scopedProfiles);
    if (scopedProfileState && typeof scopedProfileState === 'object') await storageSet('profile-state', scopedProfileState);
    if (scopedProgress && typeof scopedProgress === 'object') await storageSet('progress', scopedProgress);
    if (scopedSettings && typeof scopedSettings === 'object') await storageSet('settings', scopedSettings);

    for (const entry of scopedIndex) {
      if (!entry || !entry.id) continue;
      const chapter = await getScopedStorageValue('chapter:' + entry.id, scopeSlug);
      if (chapter) await storageSet('chapter:' + entry.id, chapter);
    }
  }

  function slugifyBookName(name){
    return (name || '')
      .toString()
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  function buildBookReaderPath(bookName){
    const slug = slugifyBookName(bookName);
    const search = window.location.search || '';
    return '/' + slug + '/reader.html' + search;
  }

  function getMainLibraryPath(){
    const search = window.location.search || '';
    return '/reader.html' + search;
  }

  function getRouteBookName(){
    if (!routeBookSlug) return '';
    const books = getAllBookNames();
    const matched = books.find((name) => slugifyBookName(name) === routeBookSlug);
    if (matched) return matched;
    return routeBookSlug
      .split('-')
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' ');
  }

  function esc(s){
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  function formatSyncTime(ts){
    if (!ts) return '';
    try {
      return new Date(ts).toLocaleTimeString([], { hour:'numeric', minute:'2-digit' });
    } catch (e) {
      return '';
    }
  }

  function formatBytes(bytes){
    const n = Number(bytes) || 0;
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / (1024 * 1024)).toFixed(2) + ' MB';
  }

  function toUtcIsoNow(){
    return new Date().toISOString();
  }

  function getValidUtcMs(value){
    if (!value || typeof value !== 'string') return 0;
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : 0;
  }

  function isPostCutoverTimestamp(value){
    const ms = getValidUtcMs(value);
    return ms >= CHAPTER_UPDATED_CUTOVER_MS;
  }

  function normalizeChapterIndexEntry(entry){
    if (!entry || typeof entry !== 'object') return entry;
    const normalized = {
      id: entry.id,
      title: entry.title,
      book: entry.book || null,
      volume: entry.volume || null,
      addedAt: entry.addedAt || Date.now(),
    };
    if (isPostCutoverTimestamp(entry.updatedAtUtc)) {
      normalized.updatedAtUtc = entry.updatedAtUtc;
    }
    return normalized;
  }

  function formatRelativeTime(ms){
    const diff = Date.now() - ms;
    if (!Number.isFinite(diff) || diff < 0) return 'just now';
    const minute = 60 * 1000;
    const hour = 60 * minute;
    const day = 24 * hour;
    if (diff < minute) return 'just now';
    if (diff < hour) return Math.floor(diff / minute) + 'm ago';
    if (diff < day) return Math.floor(diff / hour) + 'h ago';
    return Math.floor(diff / day) + 'd ago';
  }

  function getBookLastUpdatedLabel(chaptersInBook){
    let latest = 0;
    for (const chapter of chaptersInBook) {
      const ms = getValidUtcMs(chapter && chapter.updatedAtUtc);
      if (ms >= CHAPTER_UPDATED_CUTOVER_MS && ms > latest) latest = ms;
    }
    if (!latest) return 'N/A';
    return formatRelativeTime(latest);
  }

  function getSyncStatusText(){
    if (!syncKey) return 'Local only';
    if (syncStatus.state === 'syncing') return 'Syncing...';
    if (syncStatus.state === 'failed') return syncStatus.message || 'Sync failed';
    if (syncStatus.state === 'synced') {
      const at = formatSyncTime(syncStatus.at);
      return at ? ('Synced ' + at) : 'Synced';
    }
    return 'Sync ready';
  }

  function isMobileViewport(){
    return !!(window.matchMedia && window.matchMedia('(max-width: 760px)').matches);
  }

  function applyReaderChromeState(){
    const collapse = view.mode === 'reader' && isMobileViewport() && !!view.mobileChromeCollapsed;
    document.body.classList.toggle('reader-mobile-chrome-collapsed', collapse);
  }

  function updateSyncStatusChip(){
    const chip = document.getElementById('syncStatusChip');
    if (!chip) return;
    chip.className = 'subtle sync-chip ' + (syncStatus.state || 'idle');
    chip.textContent = getSyncStatusText();
    chip.title = syncStatus.message || 'Sync status';
  }

  function getDefaultProfileSettings(){
    return { font:'Georgia, "Iowan Old Style", serif', fontSize:19, lineHeight:1.7, theme:'dark' };
  }

  function getDefaultProfiles(){
    return {
      izaiah: { name:'Izaiah', settings:getDefaultProfileSettings() },
      andrew: { name:'Andrew', settings:getDefaultProfileSettings() },
      david: { name:'David', settings:getDefaultProfileSettings() }
    };
  }

  function getActiveProfile(){
    return profiles[activeProfileId] || profiles.izaiah || { name:'Profile' };
  }

  function getActiveProfileState(){
    if (!profileState[activeProfileId]) {
      profileState[activeProfileId] = {
        progress: { lastChapterId:null, percents:{} },
        settings: getDefaultProfileSettings()
      };
    }
    return profileState[activeProfileId];
  }

  function getProgress(){
    return getActiveProfileState().progress;
  }

  function getSettings(){
    return getActiveProfileState().settings;
  }

  function applyTheme(){
    const settings = getSettings();
    const theme = settings.theme || 'dark';
    document.body.setAttribute('data-theme', theme);
    document.documentElement.style.colorScheme = theme === 'dark' ? 'dark' : 'light';
  }

  async function persistProfileState(){
    await storageSet('profiles-data', profiles);
    await storageSet('profile-state', profileState);
  }

  async function persistBooksMeta(){
    await storageSet('books-meta', booksMeta);
  }

  function scheduleSettingsPersist(){
    clearTimeout(settingsSaveTimer);
    settingsSaveTimer = setTimeout(async () => {
      await persistProfileState();
      if (syncKey) await pushRemoteState(activeProfileId);
    }, 250);
  }

  function getBookLabel(bookName){
    const key = (bookName || '').trim();
    if (!key) return 'Unassigned';
    const meta = booksMeta[key];
    return (meta && meta.title) ? meta.title : key;
  }

  function getAllBookNames(source){
    const fromIndex = [...new Set((source || index).map(c => (c.book || '').trim()))];
    const fromMeta = Object.keys(booksMeta || {});
    const merged = new Set(fromIndex.concat(fromMeta));
    return [...merged].sort((a, b) => getBookLabel(a).localeCompare(getBookLabel(b)));
  }

  async function switchProfile(profileId){
    if (!profiles[profileId]) return;
    activeProfileId = profileId;
    storeActiveProfileId(activeProfileId);
    if (!profileState[profileId]) {
      profileState[profileId] = {
        progress: { lastChapterId:null, percents:{} },
        settings: getDefaultProfileSettings()
      };
    }
    if (syncKey) {
      await syncBridge.pullProfileState(profileId);
    }
    applyTheme();
    await dataBridge.saveProfileState();
    renderTopbar();
    render();
  }

  function getSyncKeyFromUrl(){
    const params = new URLSearchParams(window.location.search);
    return (params.get('sync') || '').trim();
  }

  function getStoredSyncKey(){
    try { return (window.localStorage.getItem(SYNC_KEY_STORAGE_KEY) || '').trim(); }
    catch (e) { return ''; }
  }

  function getStoredActiveProfileId(){
    try { return (window.localStorage.getItem(ACTIVE_PROFILE_STORAGE_KEY) || '').trim().toLowerCase(); }
    catch (e) { return ''; }
  }

  function storeActiveProfileId(profileId){
    try {
      if (profileId) window.localStorage.setItem(ACTIVE_PROFILE_STORAGE_KEY, profileId);
      else window.localStorage.removeItem(ACTIVE_PROFILE_STORAGE_KEY);
    } catch (e) {}
  }

  function stopProfileStateAutoRefresh(){
    if (profileStateRefreshTimer) {
      clearInterval(profileStateRefreshTimer);
      profileStateRefreshTimer = null;
    }
  }

  function startProfileStateAutoRefresh(){
    stopProfileStateAutoRefresh();
    if (!syncKey) return;
    profileStateRefreshTimer = setInterval(() => {
      if (document.visibilityState === 'visible') {
        refreshActiveProfileStateFromRemote('timer').catch(() => {});
      }
    }, 25000);
  }

  function setSyncKey(key){
    syncKey = (key || '').trim();
    remoteSyncPrimed = !syncKey;
    try {
      if (syncKey) window.localStorage.setItem(SYNC_KEY_STORAGE_KEY, syncKey);
      else window.localStorage.removeItem(SYNC_KEY_STORAGE_KEY);
    } catch (e) {}
    if (syncKey) startProfileStateAutoRefresh();
    else stopProfileStateAutoRefresh();
    if (!syncKey && syncRecoveryTimer) {
      clearTimeout(syncRecoveryTimer);
      syncRecoveryTimer = null;
      syncRecoveryFailures = 0;
    }
    return syncKey;
  }

  function scheduleSyncRecovery(reason, delayMs){
    if (!syncKey || routeBookSlug) return;
    if (syncRecoveryTimer) return;
    if (syncRecoveryFailures >= 5) {
      addSyncEvent('recovery-stop', 'Paused recovery after repeated failures');
      return;
    }
    syncRecoveryTimer = setTimeout(() => {
      syncRecoveryTimer = null;
      runSyncRecovery(reason).catch(() => {});
    }, Math.max(1200, delayMs || 4000));
  }

  async function runSyncRecovery(reason){
    if (!syncKey || routeBookSlug || syncRecoveryInFlight || syncInFlight) return false;
    syncRecoveryInFlight = true;
    try {
      syncDebug.recoveryAttempts++;
      addSyncEvent('recovery-try', 'Recovery sync attempt (' + (reason || 'pull-fail') + ')');
      const ok = await pushRemoteLibrary();
      if (ok) {
        syncRecoveryFailures = 0;
        addSyncEvent('recovery-ok', 'Recovery sync succeeded');
        return true;
      }
      syncRecoveryFailures++;
      addSyncEvent('recovery-fail', 'Recovery sync failed (attempt ' + syncRecoveryFailures + ')');
      const retryMs = Math.min(30000, 3000 * Math.max(1, syncRecoveryFailures));
      scheduleSyncRecovery('retry', retryMs);
      return false;
    } finally {
      syncRecoveryInFlight = false;
    }
  }

  async function buildLibraryPayload(options){
    const progressOnly = !!(options && options.progressOnly);
    const progress = getProgress();
    const settings = getSettings();
    if (progressOnly) {
      return { version:1, exportedAt:Date.now(), progress, settings };
    }
    return {
      version:1,
      exportedAt:Date.now(),
      index,
      progress,
      settings,
      booksMeta: compactBooksMetaForSync(booksMeta),
    };
  }

  async function collectMainPageDebugData(){
    const payload = await buildLibraryPayload();
    const payloadJson = JSON.stringify(payload);
    const keysRes = await window.storage.list('');
    const keys = (keysRes && keysRes.keys) ? keysRes.keys : [];
    const scopedKeys = keys.filter((k) => /^book:[^:]+:/.test(k));
    const globalKeys = keys.filter((k) => !/^book:[^:]+:/.test(k));
    const chunkKeys = keys.filter((k) => k.includes(':chunk:'));
    const globalLogicalKeys = globalKeys.filter((k) => !k.includes(':chunk:'));
    let missingChapterCount = 0;
    for (const ch of (payload.index || [])) {
      if (!ch || !ch.id) continue;
      const local = await storageGet('chapter:' + ch.id);
      if (!local) missingChapterCount++;
    }
    return {
      books: getAllBookNames(index).length,
      chapters: index.length,
      payloadBytes: payloadJson.length,
      chapterBodies: index.length - missingChapterCount,
      missingChapterCount,
      browserRole: missingChapterCount === 0 && index.length > 0
        ? 'source browser'
        : (missingChapterCount >= index.length && index.length > 0 ? 'receiver browser' : 'mixed browser'),
      backfillPercent: index.length ? Math.round(((index.length - missingChapterCount) / index.length) * 100) : 0,
      keysTotal: keys.length,
      keysScoped: scopedKeys.length,
      keysGlobal: globalKeys.length,
      keysChunk: chunkKeys.length,
      keysGlobalLogical: globalLogicalKeys.length,
      backfill: Object.assign({}, backfillDebug),
      scopedCleanup: Object.assign({}, scopedCleanupDebug),
      events: syncEvents.slice(0, 12),
    };
  }

  async function runBackfillNow(){
    await backfillRemoteChapters();
    if (view.debugOpen && !routeBookSlug) await refreshMainPageDebug();
  }

  async function runScopedCleanupNow(){
    await cleanupLegacyScopedKeys();
    if (view.debugOpen && !routeBookSlug) await refreshMainPageDebug();
  }

  async function copyDebugReport(){
    const d = await collectMainPageDebugData();
    const backfill = d.backfill || {};
    const cleanup = d.scopedCleanup || {};
    const events = (d.events || []).map((e) => {
      const t = new Date(e.at || Date.now()).toLocaleTimeString();
      return '[' + t + '] ' + (e.kind || 'info') + ': ' + (e.message || '');
    });
    const report = [
      'Reading Room Debug Report',
      'Time: ' + new Date().toISOString(),
      'Sync status: ' + (syncStatus.state || 'idle') + ' - ' + (syncStatus.message || ''),
      'Sync attempts/success/fail: ' + syncDebug.attempts + '/' + syncDebug.successes + '/' + syncDebug.failures,
      'Last reason: ' + (syncDebug.lastReason || 'n/a'),
      'Last payload bytes: ' + syncDebug.lastPayloadBytes,
      'Last sync duration ms: ' + syncDebug.lastDurationMs,
      'Books/chapters: ' + d.books + '/' + d.chapters,
      'Browser role: ' + (d.browserRole || 'n/a'),
      'Chapter coverage: ' + (d.backfillPercent != null ? d.backfillPercent : 0) + '%',
      'Missing local chapter blobs: ' + d.missingChapterCount,
      'Global logical keys: ' + (d.keysGlobalLogical || 0),
      'Chunk fragment keys: ' + (d.keysChunk || 0),
      'Backfill active: ' + (!!backfill.active),
      'Backfill scanned/total: ' + (backfill.scanned || 0) + '/' + (backfill.total || 0),
      'Backfill checked this run: ' + (backfill.checked || 0),
      'Backfill uploaded/failed: ' + (backfill.uploaded || 0) + '/' + (backfill.failed || 0),
      'Backfill complete: ' + (!!backfill.complete),
      'Backfill message: ' + (backfill.message || 'n/a'),
      'Scoped cleanup deleted/remaining: ' + (cleanup.deleted || 0) + '/' + (cleanup.remaining || 0),
      'Scoped cleanup runs: ' + (cleanup.runs || 0),
      'Scoped cleanup active: ' + (!!cleanup.active),
      'Scoped cleanup message: ' + (cleanup.message || 'n/a'),
      'Events:',
      events.join('\n') || 'none'
    ].join('\n');

    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(report);
      return true;
    }
    window.prompt('Copy debug report', report);
    return true;
  }

  async function refreshMainPageDebug(){
    if (routeBookSlug) return;
    mainPageDebug.loading = true;
    mainPageDebug.error = '';
    render();
    try {
      mainPageDebug.data = await collectMainPageDebugData();
    } catch (e) {
      mainPageDebug.error = e && e.message ? e.message : 'Unable to collect debug info';
    } finally {
      mainPageDebug.loading = false;
      render();
    }
  }

  function hashString(str){
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h += (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24);
    }
    return (h >>> 0).toString(16);
  }

  function payloadSignatureFromJson(jsonText){
    return String(jsonText.length) + ':' + hashString(jsonText);
  }

  function payloadSignatureFromPayload(payload){
    const stable = Object.assign({}, payload, { exportedAt: 0 });
    return payloadSignatureFromJson(JSON.stringify(stable));
  }

  function compactBooksMetaForSync(source){
    const input = (source && typeof source === 'object') ? source : {};
    const out = {};
    for (const key of Object.keys(input)) {
      const meta = input[key] && typeof input[key] === 'object' ? input[key] : {};
      out[key] = {
        title: meta.title || key,
        coverPath: meta.coverPath || '',
        author: meta.author || '',
        status: meta.status || '',
        description: meta.description || '',
        tags: Array.isArray(meta.tags) ? meta.tags.filter(Boolean) : [],
      };
    }
    return out;
  }

  function getBookMeta(bookName){
    const key = (bookName || '').trim();
    const meta = (key && booksMeta && booksMeta[key] && typeof booksMeta[key] === 'object')
      ? booksMeta[key]
      : {};
    return {
      title: meta.title || key || 'Untitled',
      coverPath: meta.coverPath || '',
      coverDataUrl: meta.coverDataUrl || '',
      author: meta.author || '',
      status: meta.status || '',
      description: meta.description || '',
      tags: Array.isArray(meta.tags) ? meta.tags.filter(Boolean) : [],
    };
  }

  function resolveCoverSrc(bookName, meta){
    const m = (meta && typeof meta === 'object') ? meta : {};
    if (m.coverPath) return m.coverPath;
    if (m.coverDataUrl) return m.coverDataUrl;
    return '';
  }

  async function backfillCoverPathsToRemote(){
    if (!syncKey) return false;
    const source = (booksMeta && typeof booksMeta === 'object') ? booksMeta : {};
    let changed = false;
    for (const bookName of Object.keys(source)) {
      const meta = source[bookName] && typeof source[bookName] === 'object' ? source[bookName] : null;
      if (!meta || meta.coverPath || !meta.coverDataUrl) continue;
      const uploaded = await uploadCoverToServer(bookName, meta.coverDataUrl);
      if (uploaded.ok && uploaded.coverPath) {
        meta.coverPath = uploaded.coverPath;
        meta.coverDataUrl = '';
        changed = true;
      }
    }
    if (changed) {
      await persistBooksMeta();
      addSyncEvent('cover-backfill', 'Uploaded local-only covers for cross-device access');
    }
    return changed;
  }

  async function uploadCoverToServer(bookName, dataUrl){
    if (!syncKey) return { ok:false, coverPath:'' };
    try {
      const res = await fetch(COVER_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-sync-key': syncKey,
        },
        body: JSON.stringify({ book: bookName, dataUrl }),
      });
      if (!res.ok) return { ok:false, coverPath:'' };
      const payload = await res.json();
      return { ok:true, coverPath: (payload && payload.coverPath) ? payload.coverPath : '' };
    } catch (e) {
      return { ok:false, coverPath:'' };
    }
  }

  async function pushChapterToRemote(chapterId, data){
    if (!syncKey || !chapterId || !data) return false;
    try {
      const res = await fetch(CHAPTER_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-sync-key': syncKey,
        },
        body: JSON.stringify({ id: chapterId, data }),
      });
      return !!res.ok;
    } catch (e) {
      return false;
    }
  }

  async function loadChapterFromRemote(chapterId){
    if (!syncKey || !chapterId) return null;
    try {
      const url = new URL(CHAPTER_ENDPOINT, window.location.origin);
      url.searchParams.set('key', syncKey);
      url.searchParams.set('id', chapterId);
      const res = await fetch(url.toString());
      if (!res.ok) return null;
      const payload = await res.json();
      return payload && payload.data ? payload.data : null;
    } catch (e) {
      return null;
    }
  }

  function getChapterBackfillStateKey(){
    return 'reading-room:chapter-backfill:' + (syncKey || '');
  }

  function readChapterBackfillState(){
    if (!syncKey) return null;
    try {
      const raw = window.localStorage.getItem(getChapterBackfillStateKey());
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      return (parsed && typeof parsed === 'object') ? parsed : null;
    } catch (e) {
      return null;
    }
  }

  function writeChapterBackfillState(state){
    if (!syncKey) return;
    try {
      window.localStorage.setItem(getChapterBackfillStateKey(), JSON.stringify(state || {}));
    } catch (e) {}
  }

  function scheduleBackfillContinuation(delayMs){
    if (routeBookSlug || !syncKey) return;
    if (chapterBackfillTimer) return;
    chapterBackfillTimer = setTimeout(() => {
      chapterBackfillTimer = null;
      backfillRemoteChapters().catch((e) => {
        console.warn('Scheduled chapter backfill failed', e);
        addSyncEvent('backfill-fail', 'Scheduled chapter backfill failed');
      });
    }, Math.max(250, delayMs || 1000));
  }

  function scheduleScopedCleanupContinuation(delayMs){
    if (routeBookSlug) return;
    if (scopedCleanupTimer) return;
    scopedCleanupTimer = setTimeout(() => {
      scopedCleanupTimer = null;
      cleanupLegacyScopedKeys().catch((e) => {
        console.warn('Scheduled scoped cleanup failed', e);
        addSyncEvent('cleanup-fail', 'Scheduled scoped cleanup failed');
      });
    }, Math.max(400, delayMs || 1200));
  }

  async function cleanupLegacyScopedKeys(){
    if (routeBookSlug || scopedCleanupInFlight) return;
    scopedCleanupInFlight = true;
    scopedCleanupDebug.active = true;
    scopedCleanupDebug.message = 'Scoped key cleanup running';
    try {
      const keysRes = await window.storage.list('');
      const keys = (keysRes && keysRes.keys) ? keysRes.keys : [];
      const scopedKeys = keys.filter((k) => /^book:[^:]+:/.test(k));
      scopedCleanupDebug.total = scopedKeys.length;
      scopedCleanupDebug.remaining = scopedKeys.length;

      if (!scopedKeys.length) {
        scopedCleanupDebug.complete = true;
        scopedCleanupDebug.lastRunAt = Date.now();
        scopedCleanupDebug.message = 'No legacy scoped keys found';
        return;
      }

      const maxDeletesPerRun = 800;
      let deletedNow = 0;
      for (let i = 0; i < scopedKeys.length && deletedNow < maxDeletesPerRun; i++) {
        const key = scopedKeys[i];
        try {
          await window.storage.delete(key, false);
          deletedNow++;
        } catch (e) {
        }
      }

      scopedCleanupDebug.runs += 1;
      scopedCleanupDebug.deleted += deletedNow;
      scopedCleanupDebug.remaining = Math.max(0, scopedKeys.length - deletedNow);
      scopedCleanupDebug.complete = scopedCleanupDebug.remaining === 0;
      scopedCleanupDebug.lastRunAt = Date.now();
      scopedCleanupDebug.message = scopedCleanupDebug.complete
        ? 'Scoped key cleanup complete'
        : ('Scoped key cleanup partial (' + deletedNow + '/' + scopedKeys.length + ' this run)');
      addSyncEvent('cleanup', 'Deleted ' + deletedNow + ' scoped key(s), remaining ~' + scopedCleanupDebug.remaining);

      if (!scopedCleanupDebug.complete) {
        scheduleScopedCleanupContinuation(900);
      }
    } finally {
      scopedCleanupDebug.active = false;
      scopedCleanupInFlight = false;
    }
  }

  async function backfillRemoteChapters(options){
    const allowScoped = !!(options && options.allowScoped);
    if (!syncKey || (!allowScoped && routeBookSlug) || chapterBackfillInFlight) return;
    const ids = (Array.isArray(index) ? index : []).map((ch) => ch && ch.id).filter(Boolean);
    if (!ids.length) return;

    let hasAnyLocalChapter = false;
    for (const id of ids) {
      const local = await storageGet('chapter:' + id);
      if (local && typeof local.content === 'string' && local.content.length) {
        hasAnyLocalChapter = true;
        break;
      }
    }
    if (!hasAnyLocalChapter) {
      backfillDebug.message = 'No local chapter bodies to seed remote';
      addSyncEvent('backfill-skip', backfillDebug.message);
      return;
    }

    const signature = hashString(ids.join('|'));
    const prev = readChapterBackfillState();
    const sameSig = !!(prev && prev.sig === signature);
    if (sameSig && prev.complete) {
      backfillDebug.complete = true;
      backfillDebug.message = 'Backfill already complete';
      return;
    }

    chapterBackfillInFlight = true;
    backfillDebug.active = true;
    backfillDebug.total = ids.length;
    backfillDebug.message = 'Backfill running';
    try {
      const start = (sameSig && Number.isInteger(prev.cursor)) ? Math.max(0, prev.cursor) : 0;
      const scannedSoFar = (sameSig && Number.isInteger(prev.scanned)) ? Math.max(0, prev.scanned) : 0;
      const maxChecksPerRun = 220;
      let checks = 0;
      let uploaded = 0;
      let failed = 0;

      for (let offset = 0; offset < ids.length && checks < maxChecksPerRun; offset++) {
        const idxPos = (start + offset) % ids.length;
        const chapterId = ids[idxPos];
        checks++;

        const local = await storageGet('chapter:' + chapterId);
        if (!local || typeof local.content !== 'string' || !local.content.length) continue;

        const remote = await loadChapterFromRemote(chapterId);
        if (remote && typeof remote.content === 'string' && remote.content.length) continue;

        const ok = await pushChapterToRemote(chapterId, {
          title: local.title || '',
          content: local.content,
        });
        if (ok) uploaded++;
        else failed++;
      }

      const nextCursor = (start + checks) % ids.length;
      const scanned = Math.min(ids.length, scannedSoFar + checks);
      const complete = scanned >= ids.length;
      backfillDebug.runs += 1;
      backfillDebug.checked = checks;
      backfillDebug.uploaded = uploaded;
      backfillDebug.failed = failed;
      backfillDebug.scanned = scanned;
      backfillDebug.cursor = nextCursor;
      backfillDebug.complete = complete;
      backfillDebug.lastRunAt = Date.now();
      backfillDebug.message = complete
        ? (uploaded > 0 ? 'Backfill complete' : 'Backfill complete (nothing new to upload)')
        : ('Backfill partial (' + scanned + '/' + ids.length + ' scanned)');
      writeChapterBackfillState({
        sig: signature,
        cursor: nextCursor,
        scanned,
        complete,
        updatedAt: Date.now(),
      });

      addSyncEvent('backfill', 'Scanned ' + scanned + '/' + ids.length + ', uploaded ' + uploaded + ', failed ' + failed);
      if (uploaded > 0 && syncStatus.state !== 'syncing') {
        syncStatus = {
          state: 'synced',
          at: Date.now(),
          message: 'Backfilled ' + uploaded + ' chapter(s) to server',
        };
        updateSyncStatusChip();
      }

      if (!complete) {
        const waitMs = failed > 0 ? 3000 : 700;
        scheduleBackfillContinuation(waitMs);
      } else {
        addSyncEvent('backfill-done', backfillDebug.message);
      }
    } finally {
      backfillDebug.active = false;
      chapterBackfillInFlight = false;
    }
  }

  function normalizeProgressState(raw){
    const src = (raw && typeof raw === 'object') ? raw : {};
    const percents = {};
    const srcPercents = (src.percents && typeof src.percents === 'object') ? src.percents : {};
    for (const chapterId of Object.keys(srcPercents)) {
      const n = Number(srcPercents[chapterId]);
      if (!Number.isFinite(n)) continue;
      percents[chapterId] = Math.max(0, Math.min(100, n));
    }
    const lastChapterId = (typeof src.lastChapterId === 'string' && src.lastChapterId)
      ? src.lastChapterId
      : null;
    return { lastChapterId, percents };
  }

  function progressEntryCount(progress){
    if (!progress || typeof progress !== 'object' || !progress.percents || typeof progress.percents !== 'object') return 0;
    return Object.keys(progress.percents).length;
  }

  function hasMeaningfulProgress(progress){
    if (!progress || typeof progress !== 'object') return false;
    if (progress.lastChapterId) return true;
    return progressEntryCount(progress) > 0;
  }

  function mergeProgressState(localProgressRaw, remoteProgressRaw){
    const localProgress = normalizeProgressState(localProgressRaw);
    const remoteProgress = normalizeProgressState(remoteProgressRaw);
    const mergedPercents = Object.assign({}, localProgress.percents);
    for (const chapterId of Object.keys(remoteProgress.percents)) {
      const remotePct = Number(remoteProgress.percents[chapterId]);
      const localPct = Number(mergedPercents[chapterId] || 0);
      mergedPercents[chapterId] = Math.max(localPct, remotePct);
    }

    let lastChapterId = localProgress.lastChapterId || null;
    if (!lastChapterId && remoteProgress.lastChapterId) {
      lastChapterId = remoteProgress.lastChapterId;
    } else if (remoteProgress.lastChapterId) {
      const localLastPct = Number(mergedPercents[localProgress.lastChapterId] || 0);
      const remoteLastPct = Number(mergedPercents[remoteProgress.lastChapterId] || 0);
      if (remoteLastPct > localLastPct) lastChapterId = remoteProgress.lastChapterId;
    }

    return { lastChapterId, percents: mergedPercents };
  }

  async function loadRemoteState(profileId){
    if (!syncKey) return null;
    try {
      const pid = (profileId || activeProfileId || 'izaiah').toString().trim().toLowerCase();
      const url = new URL(STATE_ENDPOINT, window.location.origin);
      url.searchParams.set('key', syncKey);
      url.searchParams.set('profile', pid);
      const res = await fetch(url.toString());
      if (!res.ok) return null;
      const payload = await res.json();
      if (!payload || typeof payload !== 'object' || !payload.data || typeof payload.data !== 'object') return null;
      const exportedAt = Number(payload.exportedAt || payload.data.exportedAt || 0) || 0;
      return { data: payload.data, exportedAt };
    } catch (e) {
      console.warn('Remote state load failed', e);
      return null;
    }
  }

  async function pushRemoteState(profileId){
    if (!syncKey) return false;
    try {
      const pid = (profileId || activeProfileId || 'izaiah').toString().trim().toLowerCase();
      const state = profileState[pid] || getActiveProfileState();
      const body = {
        version: 1,
        exportedAt: Date.now(),
        progress: normalizeProgressState(state.progress),
        settings: state.settings || {},
      };
      const res = await fetch(STATE_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-sync-key': syncKey,
          'x-profile-id': pid,
        },
        body: JSON.stringify(body),
      });
      return !!res.ok;
    } catch (e) {
      console.warn('Remote state save failed', e);
      return false;
    }
  }

  function getProgressSyncEntry(profileId){
    const pid = (profileId || activeProfileId || 'izaiah').toString().trim().toLowerCase();
    if (!progressSyncState[pid]) {
      progressSyncState[pid] = { sig:'', lastAttemptAt:0 };
    }
    return progressSyncState[pid];
  }

  function progressSignatureForProfile(profileId){
    const pid = (profileId || activeProfileId || 'izaiah').toString().trim().toLowerCase();
    const state = profileState[pid] || { progress:{ lastChapterId:null, percents:{} } };
    return JSON.stringify(normalizeProgressState(state.progress));
  }

  async function syncProgressStateThrottled(reason){
    if (!syncKey) return false;
    const pid = (activeProfileId || 'izaiah').toString().trim().toLowerCase();
    const entry = getProgressSyncEntry(pid);
    const nextSig = progressSignatureForProfile(pid);
    const elapsed = Date.now() - Number(entry.lastAttemptAt || 0);
    if (entry.sig === nextSig && elapsed < PROGRESS_SYNC_MIN_INTERVAL_MS) {
      return true;
    }

    if (progressSyncTimer) return true;
    const waitMs = Math.max(0, PROGRESS_SYNC_MIN_INTERVAL_MS - elapsed);
    progressSyncTimer = setTimeout(async () => {
      progressSyncTimer = null;
      entry.lastAttemptAt = Date.now();
      const ok = await pushRemoteLibrary({ progressOnly:true });
      if (ok) {
        entry.sig = progressSignatureForProfile(pid);
      } else {
        addSyncEvent('state-push-throttled', 'Deferred profile state push failed (' + (reason || 'progress') + ')');
      }
    }, waitMs);
    return true;
  }

  async function syncStateFromRemote(profileId){
    const pid = (profileId || activeProfileId || 'izaiah').toString().trim().toLowerCase();
    const remoteEnvelope = await loadRemoteState(pid);
    if (!remoteEnvelope || typeof remoteEnvelope !== 'object') return false;
    const remoteState = remoteEnvelope.data;
    if (!remoteState || typeof remoteState !== 'object') return false;
    if (!profileState[pid]) {
      profileState[pid] = {
        progress: { lastChapterId:null, percents:{} },
        settings: getDefaultProfileSettings()
      };
    }

    const localProgress = normalizeProgressState(profileState[pid].progress);
    const remoteProgress = normalizeProgressState(remoteState.progress);
    const localHasProgress = hasMeaningfulProgress(localProgress);
    const remoteHasProgress = hasMeaningfulProgress(remoteProgress);

    if (remoteHasProgress && !localHasProgress) {
      profileState[pid].progress = remoteProgress;
      addSyncEvent('state-pull', 'Profile ' + pid + ': loaded remote progress');
    } else if (remoteHasProgress && localHasProgress) {
      profileState[pid].progress = mergeProgressState(localProgress, remoteProgress);
      addSyncEvent('state-merge', 'Profile ' + pid + ': merged local/remote progress');
    } else if (!remoteHasProgress && localHasProgress) {
      profileState[pid].progress = localProgress;
      addSyncEvent('state-keep', 'Profile ' + pid + ': kept local progress (remote empty)');
      const repaired = await pushRemoteState(pid);
      addSyncEvent(repaired ? 'state-repair' : 'state-repair-fail', repaired
        ? ('Profile ' + pid + ': repaired remote progress from local')
        : ('Profile ' + pid + ': remote progress repair failed'));
    } else {
      profileState[pid].progress = localProgress;
    }

    if (remoteState.settings) Object.assign(profileState[pid].settings, remoteState.settings);
    await storageSet('profile-state', profileState);
    return true;
  }

  async function refreshActiveProfileStateFromRemote(reason){
    if (!syncKey || profileStateRefreshInFlight) return false;
    profileStateRefreshInFlight = true;
    try {
      const before = JSON.stringify(normalizeProgressState(getProgress()));
      const ok = await syncStateFromRemote(activeProfileId);
      if (!ok) return false;
      const after = JSON.stringify(normalizeProgressState(getProgress()));
      if (before !== after) {
        addSyncEvent('state-refresh', 'Profile ' + activeProfileId + ': refreshed progress from remote (' + (reason || 'sync') + ')');
        render();
      }
      return true;
    } finally {
      profileStateRefreshInFlight = false;
    }
  }

  async function loadRemoteLibrary(options){
    if (!syncKey) return null;
    const url = new URL(SYNC_ENDPOINT, window.location.origin);
    url.searchParams.set('key', syncKey);
    if (options && options.metaOnly) url.searchParams.set('meta', '1');
    if (routeBookSlug) url.searchParams.set('book', routeBookSlug);

    async function fetchOnce(timeoutMs){
      let timeoutId = null;
      try {
        const controller = new AbortController();
        timeoutId = setTimeout(() => controller.abort(), timeoutMs);
        const res = await fetch(url.toString(), { signal: controller.signal });
        if (!res.ok) {
          lastRemoteLibraryErrorStatus = res.status || 0;
          const retryAfter = Number.parseInt(res.headers.get('Retry-After') || '', 10);
          lastRemoteLibraryRetryAfterSec = Number.isFinite(retryAfter) ? Math.max(0, retryAfter) : 0;
          return null;
        }
        lastRemoteLibraryErrorStatus = 0;
        lastRemoteLibraryRetryAfterSec = 0;
        const payload = await res.json();
        return payload && payload.data ? payload.data : null;
      } finally {
        if (timeoutId) clearTimeout(timeoutId);
      }
    }

    try {
      const first = await fetchOnce(45000);
      if (first) return first;
      await new Promise((res) => setTimeout(res, 1200));
      return await fetchOnce(45000);
    } catch (e) {
      console.warn('Remote sync load failed', e);
      lastRemoteLibraryErrorStatus = 0;
      lastRemoteLibraryRetryAfterSec = 0;
      return null;
    }
  }

  async function canPrimeScopedSyncFromRemote(){
    if (!syncKey || !routeBookSlug) return false;
    try {
      const url = new URL(SYNC_ENDPOINT, window.location.origin);
      url.searchParams.set('key', syncKey);
      url.searchParams.set('book', routeBookSlug);
      const res = await fetch(url.toString());
      if (!res.ok) return false;
      const payload = await res.json();
      const data = payload && Object.prototype.hasOwnProperty.call(payload, 'data') ? payload.data : null;
      if (data && !Array.isArray(data.index)) return false;
      remoteSyncPrimed = true;
      return true;
    } catch (e) {
      return false;
    }
  }

  async function pushRemoteLibrary(options){
    const forceReplace = !!(options && options.forceReplace);
    const progressOnly = !!(options && options.progressOnly);
    if (progressOnly) {
      const ok = await pushRemoteState(activeProfileId);
      syncStatus = {
        state: ok ? 'synced' : 'failed',
        at: Date.now(),
        message: ok ? 'Profile state synced' : 'Profile state sync failed',
      };
      updateSyncStatusChip();
      return ok;
    }
    if (!syncKey) return false;
    if (syncInFlight) {
      syncPending = true;
      if (forceReplace) syncPendingReplace = true;
      return true;
    }

    syncInFlight = true;
    if (forceReplace) syncPendingReplace = true;
    let overallOk = true;
    try {
      if (!progressOnly) {
        await backfillCoverPathsToRemote();
      }
      do {
        syncPending = false;
        const replaceThisCycle = !!syncPendingReplace;
        syncPendingReplace = false;

        if (!progressOnly && routeBookSlug && !remoteSyncPrimed) {
          const pulled = await syncFromRemote();
          if (!pulled) {
            const primed = await canPrimeScopedSyncFromRemote();
            if (!primed) {
              if (replaceThisCycle) {
                syncDebug.failures++;
                syncDebug.lastReason = 'Scoped replace blocked until remote data loads';
                syncDebug.lastAt = Date.now();
                syncStatus = { state:'failed', at:Date.now(), message:'Scoped replace blocked until remote data loads' };
                updateSyncStatusChip();
                return false;
              }
              addSyncEvent('scoped-sync-degraded', 'Remote pull unavailable; continuing safe scoped merge push');
            }
          }
        }

        const payload = await buildLibraryPayload({ progressOnly });
        const payloadJson = JSON.stringify(payload);
        const payloadSig = payloadSignatureFromPayload(payload);
        syncDebug.lastPayloadBytes = payloadJson.length;

        if (payloadSig === lastSyncedPayloadSig) {
          syncDebug.lastReason = 'Already synced';
          syncDebug.lastAt = Date.now();
          syncStatus = { state:'synced', at:Date.now(), message:'Already synced' };
          updateSyncStatusChip();
          continue;
        }

        syncStatus = { state:'syncing', at:Date.now(), message:'Sync in progress' };
        updateSyncStatusChip();

        const startedAt = Date.now();
        syncDebug.attempts++;
        const res = await fetch(SYNC_ENDPOINT, {
          method:'POST',
          headers:{
            'Content-Type':'application/json',
            'x-sync-key': syncKey,
            ...(progressOnly ? { 'x-sync-partial': 'progress' } : {}),
            ...(!progressOnly && routeBookSlug ? { 'x-book-slug': routeBookSlug } : {}),
            ...(replaceThisCycle ? { 'x-sync-replace': '1' } : {}),
          },
          body: payloadJson
        });
        syncDebug.lastDurationMs = Date.now() - startedAt;

        const ok = !!res.ok;
        overallOk = overallOk && ok;
        if (ok) {
          lastSyncedPayloadSig = payloadSig;
          syncDebug.successes++;
          syncDebug.lastReason = 'Last sync saved to server';
        } else {
          syncDebug.failures++;
          syncDebug.lastReason = 'Server rejected sync (' + res.status + ')';
        }
        syncDebug.lastAt = Date.now();
        syncStatus = {
          state: ok ? 'synced' : 'failed',
          at: Date.now(),
          message: ok ? 'Last sync saved to server' : 'Server rejected sync',
        };
        updateSyncStatusChip();
        addSyncEvent(ok ? 'push-ok' : 'push-fail', ok
          ? ('Saved metadata (' + (payload.index || []).length + ' chapters)')
          : ('Server rejected sync (' + res.status + ')'));
      } while (syncPending);

      return overallOk;
    } catch (e) {
      console.warn('Remote sync save failed', e);
      syncDebug.failures++;
      syncDebug.lastReason = 'Sync failed: ' + e.message;
      syncDebug.lastError = e && e.stack ? e.stack : String(e);
      syncDebug.lastAt = Date.now();
      syncStatus = { state:'failed', at:Date.now(), message:'Sync failed: ' + e.message };
      updateSyncStatusChip();
      addSyncEvent('push-fail', 'Sync failed: ' + e.message);
      return false;
    } finally {
      syncInFlight = false;
    }
  }

  async function syncFromRemote(options){
    if (!syncKey) {
      syncStatus = { state:'failed', at:Date.now(), message:'Missing sync key' };
      updateSyncStatusChip();
      addSyncEvent('pull-fail', 'Missing sync key');
      return false;
    }
    syncStatus = { state:'syncing', at:Date.now(), message:'Loading latest data from server' };
    updateSyncStatusChip();
    addSyncEvent('pull-start', 'Loading latest data from server');
    const remote = await loadRemoteLibrary(options);
    if (!remote || !Array.isArray(remote.index)) {
      const status = lastRemoteLibraryErrorStatus;
      const retryAfter = lastRemoteLibraryRetryAfterSec;
      const message = status === 429
        ? ('Remote rate limited' + (retryAfter > 0 ? ' (retry in ~' + retryAfter + 's)' : ''))
        : (status ? ('Remote library unavailable (' + status + ')') : 'Remote library unavailable');
      syncStatus = { state:'failed', at:Date.now(), message };
      updateSyncStatusChip();
      addSyncEvent('pull-fail', message);
      if (!routeBookSlug && Array.isArray(index) && index.length) {
        scheduleSyncRecovery('pull-fail', retryAfter > 0 ? (retryAfter * 1000) : 3500);
      }
      return false;
    }
    const isMetaOnly = !!(options && options.metaOnly);
    if (routeBookSlug) {
      const currentIndex = Array.isArray(index) ? index : [];
      const currentBooksMeta = (booksMeta && typeof booksMeta === 'object') ? booksMeta : {};
      const remoteIds = new Set(remote.index.map((ch) => ch && ch.id).filter(Boolean));
      const mergedIndex = currentIndex.filter((ch) => !ch || !slugifyBookName(ch.book) || slugifyBookName(ch.book) !== routeBookSlug);
      remote.index.forEach((entry) => {
        if (entry && entry.id) {
          const existingPos = mergedIndex.findIndex((ch) => ch && ch.id === entry.id);
          if (existingPos >= 0) mergedIndex[existingPos] = entry;
          else mergedIndex.push(entry);
        }
      });
      index = mergedIndex;
      booksMeta = Object.assign({}, currentBooksMeta, remote.booksMeta || {});
      for (const ch of remote.index) {
        if (!ch || !ch.id) continue;
        const local = await storageGet('chapter:' + ch.id);
        if (!local) {
          const data = await loadChapterFromRemote(ch.id);
          if (data) await storageSet('chapter:' + ch.id, data);
        }
      }
      await storageSet('chapters-index', index);
      await storageSet('books-meta', booksMeta);
    } else {
      const localIndex = Array.isArray(index) ? index : [];
      const shouldBlockEmptyMetaOverwrite = isMetaOnly && localIndex.length > 0 && remote.index.length === 0;
      if (shouldBlockEmptyMetaOverwrite) {
        if (!attemptedRemoteBootstrap) {
          attemptedRemoteBootstrap = true;
          syncStatus = { state:'syncing', at:Date.now(), message:'Remote empty, uploading local library' };
          updateSyncStatusChip();
          const seeded = await pushRemoteLibrary();
          syncStatus = {
            state: seeded ? 'synced' : 'failed',
            at: Date.now(),
            message: seeded ? 'Remote repaired from local library' : 'Remote metadata empty, kept local library',
          };
          updateSyncStatusChip();
          addSyncEvent(seeded ? 'repair-ok' : 'repair-fail', syncStatus.message);
          return seeded;
        }
        syncStatus = { state:'failed', at:Date.now(), message:'Remote metadata empty, kept local library' };
        updateSyncStatusChip();
        addSyncEvent('pull-fail', 'Remote metadata empty, kept local library');
        return false;
      }
      attemptedRemoteBootstrap = false;
      const remoteIndex = Array.isArray(remote.index) ? remote.index : [];
      const localById = new Map();
      for (const entry of localIndex) {
        if (entry && entry.id) localById.set(entry.id, entry);
      }
      const remoteIds = new Set(remoteIndex.map((entry) => entry && entry.id).filter(Boolean));
      const merged = [];
      const seen = new Set();
      for (const entry of remoteIndex) {
        const id = entry && entry.id;
        if (!id || seen.has(id)) continue;
        const localEntry = localById.get(id);
        const nextEntry = normalizeChapterIndexEntry(entry);
        if (!nextEntry.updatedAtUtc && localEntry && isPostCutoverTimestamp(localEntry.updatedAtUtc)) {
          nextEntry.updatedAtUtc = localEntry.updatedAtUtc;
        }
        seen.add(id);
        merged.push(nextEntry);
      }

      const keepLocalOnlyAgeMs = 6 * 60 * 60 * 1000;
      const keepLocalOnlyLimit = 250;
      let keptLocalOnly = 0;
      let prunedLocalOnly = 0;
      const now = Date.now();

      for (const entry of localIndex) {
        const id = entry && entry.id;
        if (!id || remoteIds.has(id) || seen.has(id)) continue;

        const localChapter = await storageGet('chapter:' + id);
        const hasLocalBody = !!(localChapter && typeof localChapter.content === 'string' && localChapter.content.length);
        const addedAt = Number(entry && entry.addedAt ? entry.addedAt : 0);
        const isRecent = addedAt > 0 && (now - addedAt) <= keepLocalOnlyAgeMs;

        if (hasLocalBody && isRecent && keptLocalOnly < keepLocalOnlyLimit) {
          seen.add(id);
          merged.push(normalizeChapterIndexEntry(entry));
          keptLocalOnly++;
        } else {
          prunedLocalOnly++;
        }
      }

      index = merged;
      if (prunedLocalOnly > 0) {
        addSyncEvent('pull-prune', 'Pruned ' + prunedLocalOnly + ' stale local-only chapter reference(s)');
      }
      if (keptLocalOnly > 0) {
        addSyncEvent('pull-keep-local', 'Kept ' + keptLocalOnly + ' recent local-only chapter(s) for later upload');
      }
      booksMeta = (remote.booksMeta && typeof remote.booksMeta === 'object')
        ? Object.assign({}, booksMeta || {}, remote.booksMeta)
        : (booksMeta || {});
      await storageSet('chapters-index', index);
      await storageSet('books-meta', booksMeta);
    }
    await storageSet('profile-state', profileState);
    syncStatus = { state:'synced', at:Date.now(), message:'Pulled latest library from server' };
    remoteSyncPrimed = true;
    lastSyncedPayloadSig = '';
    updateSyncStatusChip();
    addSyncEvent('pull-ok', 'Pulled latest library from server (' + (remote.index || []).length + ' chapters)');
    syncRecoveryFailures = 0;
    if (syncRecoveryTimer) {
      clearTimeout(syncRecoveryTimer);
      syncRecoveryTimer = null;
    }
    if (!routeBookSlug) {
      setTimeout(() => {
        backfillRemoteChapters().catch((e) => {
          console.warn('Background chapter backfill failed', e);
          addSyncEvent('backfill-fail', 'Background chapter backfill failed');
        });
      }, 0);
      setTimeout(() => {
        cleanupLegacyScopedKeys().catch((e) => {
          console.warn('Background scoped cleanup failed', e);
          addSyncEvent('cleanup-fail', 'Background scoped cleanup failed');
        });
      }, 120);
    }
    applyTheme();
    render();
    return true;
  }

  function createDataBridge(){
    return {
      async loadBootstrapState(){
        return Promise.all([
          storageGet('chapters-index'),
          storageGet('profiles-data'),
          storageGet('profile-state'),
          storageGet('books-meta'),
        ]);
      },
      async getChapter(chapterId){
        return storageGet('chapter:' + chapterId);
      },
      async saveChapter(chapterId, payload){
        return storageSet('chapter:' + chapterId, payload);
      },
      async deleteChapter(chapterId){
        return storageDelete('chapter:' + chapterId);
      },
      async saveIndex(nextIndex){
        index = Array.isArray(nextIndex) ? nextIndex : [];
        return storageSet('chapters-index', index);
      },
      async saveBooksMeta(nextBooksMeta){
        booksMeta = (nextBooksMeta && typeof nextBooksMeta === 'object') ? nextBooksMeta : {};
        return persistBooksMeta();
      },
      async saveProfileState(){
        return persistProfileState();
      }
    };
  }

  function createSyncBridge(){
    return {
      hasSyncKey(){
        return !!syncKey;
      },
      async pullLibrary(options){
        bridgeEvents.emit('sync:pull:start', { options: options || null });
        const ok = await syncFromRemote(options);
        bridgeEvents.emit(ok ? 'sync:pull:ok' : 'sync:pull:fail', { options: options || null });
        return ok;
      },
      async pushLibrary(options){
        bridgeEvents.emit('sync:push:start', { options: options || null });
        const ok = await pushRemoteLibrary(options);
        bridgeEvents.emit(ok ? 'sync:push:ok' : 'sync:push:fail', { options: options || null });
        return ok;
      },
      async pullProfileState(profileId){
        return syncStateFromRemote(profileId);
      },
      async pushChapter(chapterId, payload){
        return pushChapterToRemote(chapterId, payload);
      },
      async pullChapter(chapterId){
        return loadChapterFromRemote(chapterId);
      },
      async configureKey(forcePrompt){
        return configureSyncKey(forcePrompt);
      }
    };
  }

  const dataBridge = createDataBridge();
  const syncBridge = createSyncBridge();
  window.readerBridge = {
    data: dataBridge,
    sync: syncBridge,
    events: bridgeEvents,
  };

  async function configureSyncKey(forcePrompt){
    const nextKey = forcePrompt
      ? prompt('Enter a sync key for this library', syncKey || 'my-library')
      : (getSyncKeyFromUrl() || getStoredSyncKey());
    if (nextKey === null) return false;
    setSyncKey(nextKey || '');
    if (syncKey) {
      if (routeBookSlug) {
        await syncBridge.pullLibrary();
        await syncBridge.pushLibrary();
      } else {
        await syncBridge.pullLibrary({ metaOnly:true });
      }
      await syncBridge.pullProfileState(activeProfileId);
    }
    renderTopbar();
    return !!syncKey;
  }

  // UI/bootstrap moved to reader-ui.js.
