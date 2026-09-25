(function () {
  'use strict';
  const XA = (globalThis.XArchive = globalThis.XArchive || {});

  const DB_NAME = 'x-archive';
  const DB_VERSION = 1;

  let dbPromise = null;

  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (ev) => {
        const db = ev.target.result;
        if (!db.objectStoreNames.contains('runs')) {
          const runs = db.createObjectStore('runs', { keyPath: 'id' });
          runs.createIndex('by-sourceKey', 'source.key', { unique: false });
          runs.createIndex('by-state', 'state', { unique: false });
          runs.createIndex('by-updatedAt', 'updatedAt', { unique: false });
        }
        if (!db.objectStoreNames.contains('posts')) {
          const posts = db.createObjectStore('posts', { keyPath: ['runId', 'id'] });
          posts.createIndex('by-run', 'runId', { unique: false });
          posts.createIndex('by-run-ts', ['runId', 'timestamp_iso'], { unique: false });
        }
        if (!db.objectStoreNames.contains('threadJobs')) {
          const jobs = db.createObjectStore('threadJobs', { keyPath: 'id' });
          jobs.createIndex('by-run', 'runId', { unique: false });
        }
        if (!db.objectStoreNames.contains('exportJobs')) {
          const jobs = db.createObjectStore('exportJobs', { keyPath: 'id' });
          jobs.createIndex('by-run', 'runId', { unique: false });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('IndexedDB open failed'));
    });
    return dbPromise;
  }

  function reqAsPromise(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('IndexedDB request failed'));
    });
  }

  function txDone(tx) {
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed'));
      tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
    });
  }

  async function store(name, mode, fn) {
    const db = await openDB();
    const tx = db.transaction(name, mode);
    const result = await fn(tx.objectStore(name), tx);
    await txDone(tx);
    return result;
  }

  async function createRun(run) {
    return store('runs', 'readwrite', (s) => reqAsPromise(s.put(run))).then(() => run);
  }

  const getRun = (id) => store('runs', 'readonly', (s) => reqAsPromise(s.get(id)));

  async function patchRun(id, patch) {
    return store('runs', 'readwrite', async (s) => {
      const run = await reqAsPromise(s.get(id));
      if (!run) return null;
      const next = typeof patch === 'function' ? patch(run) : Object.assign({}, run, patch);
      next.updatedAt = XA.util.nowIso();
      await reqAsPromise(s.put(next));
      return next;
    });
  }

  async function listRuns(filters) {
    const f = filters || {};
    let runs = await store('runs', 'readonly', (s) => reqAsPromise(s.getAll()));
    if (f.state) runs = runs.filter((r) => r.state === f.state);
    if (f.states) runs = runs.filter((r) => f.states.includes(r.state));
    if (f.type) runs = runs.filter((r) => r.source && r.source.type === f.type);
    if (f.handle) {
      const h = String(f.handle).replace(/^@/, '').toLowerCase();
      runs = runs.filter((r) => r.source && String(r.source.handle || '').toLowerCase() === h);
    }
    if (f.sourceKey) runs = runs.filter((r) => r.source && r.source.key === f.sourceKey);
    if (f.search) {
      const q = String(f.search).toLowerCase();
      runs = runs.filter((r) => r.source &&
        ((r.source.label || '').toLowerCase().includes(q) ||
         (r.source.key || '').toLowerCase().includes(q)));
    }
    runs.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
    return runs;
  }

  async function findUnfinishedRun(sourceKey) {
    const runs = await listRuns({ sourceKey });
    return runs.find((r) => XA.messages.UNFINISHED_STATES.includes(r.state)) || null;
  }

  async function deleteRun(runId) {
    const db = await openDB();
    const tx = db.transaction(['runs', 'posts', 'threadJobs', 'exportJobs'], 'readwrite');
    const done = txDone(tx);
    tx.objectStore('runs').delete(runId);
    const postIdx = tx.objectStore('posts').index('by-run');
    const postKeys = await reqAsPromise(postIdx.getAllKeys(runId));
    for (const k of postKeys) tx.objectStore('posts').delete(k);
    const jobIdx = tx.objectStore('threadJobs').index('by-run');
    const jobKeys = await reqAsPromise(jobIdx.getAllKeys(runId));
    for (const k of jobKeys) tx.objectStore('threadJobs').delete(k);
    const exIdx = tx.objectStore('exportJobs').index('by-run');
    const exKeys = await reqAsPromise(exIdx.getAllKeys(runId));
    for (const k of exKeys) tx.objectStore('exportJobs').delete(k);
    await done;
  }

  async function upsertPosts(runId, posts) {
    const db = await openDB();
    const tx = db.transaction(['posts', 'runs'], 'readwrite');
    const done = txDone(tx);
    const postStore = tx.objectStore('posts');
    const runStore = tx.objectStore('runs');
    const run = await reqAsPromise(runStore.get(runId));
    let seq = run && run.stats && run.stats.seq ? run.stats.seq : 0;
    let added = 0;
    let changed = 0;
    for (const incoming of posts || []) {
      if (!incoming || !incoming.id) continue;
      const key = [runId, incoming.id];
      const existing = await reqAsPromise(postStore.get(key));
      const merged = existing
        ? XA.postModel.mergePosts(existing, incoming)
        : XA.postModel.normalizePost(incoming, {});
      if (existing && merged === existing) continue;
      if (existing && JSON.stringify(merged) === JSON.stringify(existing)) continue;
      if (!existing) { merged.seq = ++seq; merged.runId = runId; added++; }
      else { merged.seq = existing.seq; merged.runId = runId; }
      await reqAsPromise(postStore.put(merged));
      changed++;
    }
    if (run) {
      run.stats = Object.assign({}, run.stats, { seq });
      run.stats.posts = await reqAsPromise(postStore.index('by-run').count(runId));
      run.updatedAt = XA.util.nowIso();
      await reqAsPromise(runStore.put(run));
    }
    await done;
    const count = await store('posts', 'readonly', (s) => reqAsPromise(s.index('by-run').count(runId)));
    return { added, changed, count };
  }

  async function getPosts(runId) {
    const posts = await store('posts', 'readonly', (s) => reqAsPromise(s.index('by-run').getAll(runId)));
    posts.sort((a, b) => (a.seq || 0) - (b.seq || 0));
    return posts;
  }

  const countPosts = (runId) =>
    store('posts', 'readonly', (s) => reqAsPromise(s.index('by-run').count(runId)));

  const putThreadJob = (job) =>
    store('threadJobs', 'readwrite', (s) => reqAsPromise(s.put(job))).then(() => job);
  const getThreadJob = (id) =>
    store('threadJobs', 'readonly', (s) => reqAsPromise(s.get(id)));
  const listThreadJobs = (runId) =>
    store('threadJobs', 'readonly', (s) => reqAsPromise(s.index('by-run').getAll(runId)));

  async function patchThreadJob(id, patch) {
    return store('threadJobs', 'readwrite', async (s) => {
      const job = await reqAsPromise(s.get(id));
      if (!job) return null;
      const next = typeof patch === 'function' ? patch(job) : Object.assign({}, job, patch);
      next.updatedAt = XA.util.nowIso();
      await reqAsPromise(s.put(next));
      return next;
    });
  }

  const putExportJob = (job) =>
    store('exportJobs', 'readwrite', (s) => reqAsPromise(s.put(job))).then(() => job);
  const listExportJobs = (runId) =>
    store('exportJobs', 'readonly', (s) => reqAsPromise(s.index('by-run').getAll(runId)));

  async function storageEstimate() {
    try {
      if (navigator.storage && navigator.storage.estimate) {
        return await navigator.storage.estimate();
      }
    } catch (_) { /* not available */ }
    return { usage: null, quota: null };
  }

  function resetForTests() {
    if (dbPromise) {
      dbPromise.then((db) => db.close()).catch(() => {});
      dbPromise = null;
    }
  }

  XA.db = {
    DB_NAME, openDB, createRun, getRun, patchRun, listRuns, findUnfinishedRun,
    deleteRun, upsertPosts, getPosts, countPosts,
    putThreadJob, getThreadJob, listThreadJobs, patchThreadJob,
    putExportJob, listExportJobs, storageEstimate, resetForTests
  };
})();
