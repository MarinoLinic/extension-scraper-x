import { describe, it, expect, beforeEach, vi } from 'vitest';
import { XA } from './helpers/load.js';
import '../src/background/run-service.js';
import '../src/background/thread-service.js';
import { indexedDB } from 'fake-indexeddb';

const db = XA.db;
const rs = XA.runService;

let sent;
let aliveTabs;

function chromeStub() {
  sent = [];
  aliveTabs = new Set();
  globalThis.chrome = {
    runtime: {
      lastError: null,
      getURL: (p) => 'chrome-extension://test/' + p
    },
    tabs: {
      sendMessage: (tabId, msg, cb) => {
        sent.push({ tabId, msg });
        if (cb) cb({ ok: true });
      },
      get: (tabId, cb) => {
        cb(aliveTabs.has(tabId) ? { id: tabId } : undefined);
      },
      create: async () => ({ id: 99 }),
      update: async () => ({}),
      query: async () => []
    },
    windows: { create: async () => ({ id: 1, tabs: [{ id: 55 }] }) },
    action: {
      setBadgeText: async () => {},
      setBadgeBackgroundColor: async () => {}
    },
    permissions: {
      contains: async () => false,
      request: async () => false
    },
    storage: {
      local: {
        get: async () => ({}),
        set: async () => {},
        setAccessLevel: () => Promise.resolve()
      }
    }
  };
}

function makeRun(over = {}) {
  return Object.assign({
    id: XA.util.uid('run'),
    source: { key: 'profile:alice:posts', type: 'profile', label: '@alice posts', handle: 'alice', tab: 'posts', sourceUrl: 'https://x.com/alice', supported: true },
    state: 'running',
    createdAt: XA.util.nowIso(),
    updatedAt: XA.util.nowIso(),
    completedAt: null,
    stopReason: null,
    settings: XA.defaults.DEFAULT_SETTINGS,
    stats: { posts: 0, seq: 0, batches: 0 },
    warnings: [],
    runtime: {},
    tabId: 10
  }, over);
}

function makePost(id, over = {}) {
  return XA.postModel.normalizePost(Object.assign({
    tweet_url: 'https://x.com/a/status/' + id,
    text: 'post ' + id
  }, over));
}

async function freshDb() {
  db.resetForTests();
  await new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(db.DB_NAME);
    req.onsuccess = resolve;
    req.onerror = () => reject(req.error);
    req.onblocked = resolve;
  });
}

beforeEach(async () => {
  chromeStub();
  await freshDb();
  XA.exportService = { exportRun: vi.fn(async () => ({ ok: true, files: ['x.json'] })) };
});

const sender = (tabId) => ({ tab: { id: tabId } });

describe('run ownership', () => {
  it('rejects a second unfinished run for the same source', async () => {
    const run = makeRun();
    await db.createRun(run);
    const resp = await rs.startRun({ tabId: 20, source: run.source, settings: {} });
    expect(resp.ok).toBe(false);
    expect(resp.code).toBe('existing-run');
    expect(resp.runId).toBe(run.id);
  });

  it('rejects invalid settings instead of starting', async () => {
    const resp = await rs.startRun({
      tabId: 10,
      source: makeRun().source,
      settings: { tickDelayMinMs: 'banana' }
    });
    expect(resp.ok).toBe(false);
    expect(resp.error).toBe('Invalid settings');
    expect(resp.errors).toBeTruthy();
    expect(await db.listRuns({})).toHaveLength(0);
  });

  it('starts a clean run with validated settings', async () => {
    const resp = await rs.startRun({ tabId: 10, source: makeRun().source, settings: {} });
    expect(resp.ok).toBe(true);
    expect(resp.run.tabId).toBe(10);
    expect(sent.some((m) => m.msg.action === 'start')).toBe(true);
  });
});

describe('content-ready auto-resume ownership', () => {
  const source = makeRun().source;

  it('resumes on the recorded owner tab', async () => {
    const run = makeRun({ state: 'paused', tabId: 10 });
    await db.createRun(run);
    const resp = await rs.contentReady({ source }, sender(10));
    expect(resp.resumeRun && resp.resumeRun.id).toBe(run.id);
  });

  it('does not auto-resume in another tab while the owner tab is alive', async () => {
    const run = makeRun({ state: 'paused', tabId: 10 });
    await db.createRun(run);
    aliveTabs.add(10);
    const resp = await rs.contentReady({ source }, sender(20));
    expect(resp.resumeRun).toBeUndefined();
    expect(resp.ownedElsewhere).toBe(true);
    expect((await db.getRun(run.id)).tabId).toBe(10);
  });

  it('adopts a new tab when the recorded owner is gone, then resumes', async () => {
    const run = makeRun({ state: 'paused', tabId: 10 });
    await db.createRun(run);
    const resp = await rs.contentReady({ source }, sender(20));
    expect(resp.resumeRun && resp.resumeRun.id).toBe(run.id);
    expect(resp.resumeRun.tabId).toBe(20);
    expect((await db.getRun(run.id)).tabId).toBe(20);
  });
});

describe('explicit resume moves ownership', () => {
  it('pauses the old tab, reassigns, then resumes the new tab', async () => {
    const run = makeRun({ state: 'paused', tabId: 10 });
    await db.createRun(run);
    const resp = await rs.resumeRun({ runId: run.id, tabId: 20 });
    expect(resp.ok).toBe(true);
    const pauseToOld = sent.find((m) => m.tabId === 10 && m.msg.action === 'pause');
    const resumeToNew = sent.find((m) => m.tabId === 20 && m.msg.action === 'resume');
    expect(pauseToOld).toBeTruthy();
    expect(resumeToNew).toBeTruthy();
    const stored = await db.getRun(run.id);
    expect(stored.tabId).toBe(20);
    expect(stored.state).toBe('running');
  });
});

describe('stale-tab and missing-run rejection', () => {
  it('rejects upserts from a tab that no longer owns the run', async () => {
    const run = makeRun({ tabId: 10 });
    await db.createRun(run);
    const resp = await rs.handleUpsert(
      { runId: run.id, posts: [makePost(1)], runtime: { state: 'running' } },
      sender(20)
    );
    expect(resp.ok).toBe(false);
    expect(await db.getPosts(run.id)).toHaveLength(0);
  });

  it('rejects state reports from a stale tab', async () => {
    const run = makeRun({ tabId: 10 });
    await db.createRun(run);
    const resp = await rs.handleState({ runId: run.id, state: 'completed' }, sender(20));
    expect(resp.ok).toBe(false);
    expect((await db.getRun(run.id)).state).toBe('running');
  });

  it('accepts upserts from the owner tab and reports added', async () => {
    const run = makeRun({ tabId: 10 });
    await db.createRun(run);
    const resp = await rs.handleUpsert(
      { runId: run.id, posts: [makePost(1), makePost(2)], runtime: { state: 'running' } },
      sender(10)
    );
    expect(resp.ok).toBe(true);
    expect(resp.added).toBe(2);
    expect(resp.count).toBe(2);
  });

  it('never creates orphan posts for a missing run', async () => {
    const resp = await rs.handleUpsert(
      { runId: 'run_missing', posts: [makePost(1)], runtime: {} },
      sender(10)
    );
    expect(resp.ok).toBe(false);
    expect(resp.error).toBe('run not found');
  });
});

describe('delete of an unfinished run', () => {
  it('stops the owner controller before deleting records', async () => {
    const run = makeRun({ tabId: 10 });
    await db.createRun(run);
    await db.upsertPosts(run.id, [makePost(1)]);
    const resp = await rs.deleteRun({ runId: run.id });
    expect(resp.ok).toBe(true);
    const stop = sent.find((m) => m.tabId === 10 && m.msg.action === 'stop');
    expect(stop).toBeTruthy();
    expect(await db.getRun(run.id)).toBeUndefined();
    expect(await db.getPosts(run.id)).toHaveLength(0);
    const stale = await rs.handleUpsert(
      { runId: run.id, posts: [makePost(2)], runtime: {} }, sender(10));
    expect(stale.ok).toBe(false);
  });

  it('deleting a finished run does not message any tab', async () => {
    const run = makeRun({ state: 'completed', tabId: 10 });
    await db.createRun(run);
    await rs.deleteRun({ runId: run.id });
    expect(sent).toHaveLength(0);
    expect(await db.getRun(run.id)).toBeUndefined();
  });
});

describe('auto-export claiming', () => {
  const autoRun = () => makeRun({
    tabId: 10,
    settings: Object.assign({}, XA.defaults.DEFAULT_SETTINGS, { autoExportOnComplete: true })
  });

  it('exports exactly once across concurrent stop and state reports', async () => {
    const run = autoRun();
    await db.createRun(run);
    await Promise.all([
      rs.stopRun({ runId: run.id }),
      rs.handleState({ runId: run.id, state: 'completed' }, sender(10))
    ]);
    expect(XA.exportService.exportRun).toHaveBeenCalledTimes(1);
  });

  it('a completed state report triggers one export', async () => {
    const run = autoRun();
    await db.createRun(run);
    await rs.handleState({ runId: run.id, state: 'completed' }, sender(10));
    await rs.handleState({ runId: run.id, state: 'completed' }, sender(10));
    expect(XA.exportService.exportRun).toHaveBeenCalledTimes(1);
  });

  it('does not auto-export on error', async () => {
    const run = autoRun();
    await db.createRun(run);
    await rs.handleState({ runId: run.id, state: 'error' }, sender(10));
    expect(XA.exportService.exportRun).not.toHaveBeenCalled();
  });

  it('suppresses auto-export when the user deletes an active run', async () => {
    const run = autoRun();
    await db.createRun(run);
    globalThis.chrome.tabs.sendMessage = (tabId, msg, cb) => {
      sent.push({ tabId, msg });
      if (msg.action === 'stop') {
        rs.handleState({ runId: run.id, state: 'completed' }, sender(tabId))
          .then(() => cb({ ok: true }));
      } else if (cb) {
        cb({ ok: true });
      }
    };
    const resp = await rs.deleteRun({ runId: run.id });
    expect(resp.ok).toBe(true);
    expect(XA.exportService.exportRun).not.toHaveBeenCalled();
    expect(await db.getRun(run.id)).toBeUndefined();
  });
});

describe('thread job building', () => {
  it('falls back to the run source handle for /i/status/ candidate URLs', async () => {
    const run = makeRun({ state: 'completed' });
    await db.createRun(run);
    await db.upsertPosts(run.id, [makePost(1, {
      thread_candidates: [
        { url: 'https://x.com/i/status/777', reason: 'show-thread', confidence: 'high' },
        { url: 'https://x.com/bob/status/888', reason: 'show-thread', confidence: 'high' }
      ]
    })]);
    const jobs = await XA.threadService.buildJobs(run.id, null);
    const iJob = jobs.find((j) => j.statusId === '777');
    const namedJob = jobs.find((j) => j.statusId === '888');
    expect(iJob.authorHandle).toBe('alice');
    expect(namedJob.authorHandle).toBe('bob');
  });
});
