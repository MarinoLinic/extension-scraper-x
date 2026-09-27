import { beforeEach, describe, expect, it, vi } from 'vitest';
import { indexedDB } from 'fake-indexeddb';
import { XA } from './helpers/load.js';
import '../src/background/thread-service.js';
import '../src/content/thread-controller.js';

const db = XA.db;
const service = XA.fulfillmentService;
let contentMessages;

function makeRun(id, over = {}) {
  return Object.assign({
    id,
    source: { key: 'profile:alice:posts', type: 'profile', handle: 'alice' },
    state: 'completed',
    createdAt: XA.util.nowIso(),
    updatedAt: XA.util.nowIso(),
    stats: { posts: 0, seq: 0, batches: 0 }
  }, over);
}

function post(id, over = {}) {
  return XA.postModel.normalizePost(Object.assign({
    tweet_url: 'https://x.com/alice/status/' + id,
    text: 'parent ' + id
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

async function startDiscoverySession(runId, quoteContext) {
  const run = makeRun(runId);
  await db.createRun(run);
  const parent = post('1', { quote_context: quoteContext });
  await db.upsertPosts(runId, [parent]);
  const [job] = await service.buildJobs(runId);
  const sessionId = 'session_' + runId;
  await db.patchThreadJob(job.id, { state: 'running', sessionId });
  await db.patchRun(runId, (stored) => {
    stored.fulfillment = {
      state: 'running', sessionId, kinds: ['quote'], pace: 'cautious', maxJobs: 1,
      selectedJobIds: [job.id], total: 1, processed: 0, done: 0, incomplete: 0, failed: 0,
      currentJobId: job.id, workerTabId: null, workerWindowId: null, nextAt: null,
      pauseReason: null, startedAt: XA.util.nowIso(), updatedAt: XA.util.nowIso(), completedAt: null
    };
    return stored;
  });
  return { run, parent, job, sessionId };
}

beforeEach(async () => {
  await freshDb();
  contentMessages = [];
  globalThis.chrome = {
    runtime: {
      lastError: null,
      getURL: (path) => 'chrome-extension://test/' + path,
      sendMessage: (message, callback) => { contentMessages.push(message); if (callback) callback(); }
    },
    alarms: {
      create: vi.fn(),
      clear: vi.fn(async () => true),
      get: vi.fn(async () => null)
    }
  };
});

describe('fulfillment candidate building', () => {
  it('creates a quote-discovery job for a missing URL when its parent status is safe', async () => {
    const run = makeRun('run_discovery_candidate');
    await db.createRun(run);
    await db.upsertPosts(run.id, [post('1', { quote_context: {
      quoted_tweet_url: null, quoted_text_backfilled: true, quoted_text: 'legacy text'
    } })]);
    const jobs = await service.buildJobs(run.id);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].kind).toBe('quote');
    expect(jobs[0].mode).toBe('quote_discovery');
    expect(jobs[0].id).toBe(run.id + ':quote-source:1');
    expect(jobs[0].url).toBe('https://x.com/alice/status/1');
    expect(jobs[0].alreadyFulfilled).toBeUndefined();
    expect(jobs[0].state).toBe('queued');
  });

  it('recognizes thread and legacy quote backfill markers as already fulfilled', async () => {
    const run = makeRun('run_imported');
    await db.createRun(run);
    await db.upsertPosts(run.id, [
      post('1', {
        thread_candidates: [{ url: 'https://x.com/alice/status/11', reason: 'show-thread' }],
        quote_context: { quoted_tweet_url: 'https://x.com/bob/status/90', quoted_fetched: true }
      }),
      post('2', {
        thread_scraped: true,
        thread_candidates: [{ url: 'https://x.com/alice/status/11', reason: 'show-thread' }],
        quote_context: {
          quoted_tweet_url: 'https://x.com/bob/status/90', quoted_text_backfilled: true
        }
      })
    ]);

    const jobs = await service.buildJobs(run.id);
    expect(jobs).toHaveLength(2);
    expect(jobs.every((job) => job.state === 'done' && job.completedAt)).toBe(true);
    expect(jobs.every((job) => !Object.hasOwn(job, 'alreadyFulfilled'))).toBe(true);
    const response = await service.startQueue({ runId: run.id });
    expect(response.ok).toBe(false);
    expect(response.error).toBe('all selected candidates already fulfilled');
  });

  it('queues one quote when duplicate parent references have mixed completion markers', async () => {
    const run = makeRun('run_mixed_quotes');
    await db.createRun(run);
    await db.upsertPosts(run.id, [
      post('1', { quote_context: {
        quoted_tweet_url: 'https://x.com/bob/status/91', quoted_fetched: true
      } }),
      post('2', { quote_context: { quoted_tweet_url: 'https://x.com/bob/status/91', quoted_text: 'teaser' } })
    ]);

    const jobs = await service.buildJobs(run.id);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].kind).toBe('quote');
    expect(jobs[0].parentPostIds).toEqual(['1', '2']);
    expect(jobs[0].state).toBe('queued');
    const response = await service.startQueue({ runId: run.id, kinds: ['quote'] });
    expect(response.ok).toBe(true);
    expect(response.session.selectedJobIds).toEqual([jobs[0].id]);
  });

  it('rejects non-X status hosts and canonicalizes valid X/Twitter candidate URLs', async () => {
    expect(service.safeStatusUrl('https://evil.example/alice/status/123')).toBeNull();
    expect(service.safeStatusUrl('https://twitter.com/alice/status/123?ref=1'))
      .toBe('https://x.com/alice/status/123');
    const run = makeRun('run_unsafe_candidates');
    await db.createRun(run);
    await db.upsertPosts(run.id, [
      post('1', {
        thread_candidates: [{ url: 'https://evil.example/alice/status/12', reason: 'imported' }],
        quote_context: { quoted_tweet_url: 'https://evil.example/bob/status/13' }
      }),
      post('2', {
        tweet_url: 'https://evil.example/alice/status/2',
        quote_context: { quoted_tweet_url: null }
      })
    ]);
    const jobs = await service.buildJobs(run.id);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].mode).toBe('quote_discovery');
    expect(jobs[0].url).toBe('https://x.com/alice/status/1');
    expect(service.countMissingQuoteUrls(await db.getPosts(run.id))).toBe(2);
  });

  it('infers one imported thread job from root/reply markers without thread IDs or candidates', async () => {
    const run = makeRun('run_legacy_thread');
    await db.createRun(run);
    await db.upsertPosts(run.id, [
      post('10', {
        is_thread: true, thread_role: 'root', handle: '@alice',
        timestamp_iso: '2024-01-01T10:00:00.000Z'
      }),
      post('11', {
        is_thread: true, thread_role: 'reply', handle: '@alice', stitched: 'last', thread_scraped: true,
        timestamp_iso: '2024-01-01T10:02:00.000Z'
      })
    ]);

    const jobs = await service.buildJobs(run.id);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].url).toBe('https://x.com/alice/status/10');
    expect(jobs[0].reasons).toContain('imported-thread-marker');
    expect(jobs[0].state).toBe('done');
  });

  it('discovers an unavailable quote URL, then creates the actual quote job for a later session', async () => {
    const { run, job, sessionId } = await startDiscoverySession('run_quote_discovery', {
      quoted_tweet_url: 'https://evil.example/bob/status/90',
      quoted_text_backfilled: true, quoted_text: 'legacy quote text'
    });
    expect(job.id).toBe(run.id + ':quote-source:1');
    expect(job.mode).toBe('quote_discovery');

    const response = await service.handleThreadResult({
      jobId: job.id, sessionId,
      diagnostics: { kind: 'quote', mode: 'quote_discovery', statusId: '1', sawRequestedId: true },
      posts: [post('1', { quote_context: {
        quoted_tweet_url: 'https://twitter.com/bob/status/90',
        quoted_author_handle: '@bob', quoted_text: 'newly discovered teaser'
      } })]
    });
    expect(response.state).toBe('done');
    let stored = await db.getPosts(run.id);
    expect(stored.map((item) => item.id)).toEqual(['1']);
    expect(stored[0].quote_context.quoted_tweet_url).toBe('https://x.com/bob/status/90');
    expect(stored[0].quote_context.quoted_tweet_url_verified).toBe(true);
    expect(stored[0].quote_context.quoted_fetched).not.toBe(true);
    expect(stored[0].quote_context.quoted_text_backfilled).toBe(false);

    const jobs = await service.buildJobs(run.id);
    const actualQuote = jobs.find((candidate) => candidate.mode === 'quote');
    expect(actualQuote.id).toBe(run.id + ':quote:90');
    expect(actualQuote.state).toBe('queued');
    stored = await db.listThreadJobs(run.id);
    expect(stored.find((candidate) => candidate.id === job.id).state).toBe('skipped');
  });

  it('keeps a completed selected job intact while its session is still running', async () => {
    const run = makeRun('run_active_reconcile');
    await db.createRun(run);
    await db.upsertPosts(run.id, [post('1', {
      quote_context: { quoted_tweet_url: null, quoted_text: 'quote teaser' }
    })]);
    const [discovery] = await service.buildJobs(run.id);
    const sessionId = 'session_active_reconcile';
    await db.patchThreadJob(discovery.id, { state: 'done', sessionId });
    await db.patchRun(run.id, (stored) => {
      stored.fulfillment = {
        state: 'running', sessionId, selectedJobIds: [discovery.id],
        currentJobId: null, pace: 'cautious', total: 1,
        processed: 1, done: 1, incomplete: 0, failed: 0
      };
      return stored;
    });
    await db.upsertPosts(run.id, [post('1', {
      quote_context: {
        quoted_tweet_url: 'https://x.com/bob/status/90',
        quoted_tweet_url_verified: true,
        quoted_text: 'quote teaser'
      }
    })]);

    const jobs = await service.buildJobs(run.id);
    expect(jobs.some((candidate) => candidate.id === run.id + ':quote:90')).toBe(true);
    expect((await db.getThreadJob(discovery.id)).state).toBe('done');
  });

  it('marks quote discovery incomplete when the parent still has no safe quoted URL', async () => {
    const { run, job, sessionId } = await startDiscoverySession('run_quote_discovery_missing', {
      quoted_tweet_url: null, quoted_text: 'existing quote text'
    });
    await service.handleThreadResult({
      jobId: job.id, sessionId,
      diagnostics: { kind: 'quote', mode: 'quote_discovery', statusId: '1', sawRequestedId: true },
      posts: [post('1', { quote_context: { quoted_text: 'still no permalink' } })]
    });
    const updated = await db.getThreadJob(job.id);
    expect(updated.state).toBe('incomplete');
    expect(updated.diagnostics.error).toMatch(/URL remained unavailable/);
    expect((await db.getPosts(run.id)).map((item) => item.id)).toEqual(['1']);
  });

  it('refuses an unsafe persisted job URL before creating or navigating the worker tab', async () => {
    const run = makeRun('run_unsafe_dispatch');
    const sessionId = 'session_unsafe_dispatch';
    const id = run.id + ':123';
    await db.createRun(Object.assign(run, { fulfillment: {
      state: 'running', sessionId, selectedJobIds: [id], currentJobId: null,
      pace: 'cautious', total: 1, processed: 0, done: 0, incomplete: 0, failed: 0
    } }));
    await db.putThreadJob({
      id, runId: run.id, kind: 'thread', mode: 'thread', statusId: '123',
      url: 'https://evil.example/alice/status/123', state: 'queued', attempts: 0, sessionId
    });
    globalThis.chrome.windows = { create: vi.fn() };

    await service.dispatchNext(run.id, sessionId);
    expect(globalThis.chrome.windows.create).not.toHaveBeenCalled();
    const stored = await db.getRun(run.id);
    expect(stored.fulfillment.state).toBe('paused');
    expect(stored.fulfillment.pauseReason).toBe('worker error: unsafe status URL refused');
    expect((await db.getThreadJob(id)).state).toBe('failed');
  });

  it('skips obsolete non-running jobs and excludes them from summary counts', async () => {
    const run = makeRun('run_obsolete_job');
    await db.createRun(run);
    const id = run.id + ':777';
    await db.putThreadJob({
      id, runId: run.id, kind: 'thread', mode: 'thread', statusId: '777',
      url: 'https://x.com/alice/status/777', state: 'done', attempts: 1,
      createdAt: XA.util.nowIso(), updatedAt: XA.util.nowIso()
    });
    await service.buildJobs(run.id);
    const status = await service.statusFor(run.id);
    expect(status.jobs[0].state).toBe('skipped');
    expect(status.threadCandidates).toBe(0);
    expect(status.done).toBe(0);
  });

  it('loads prior jobs once and leaves unchanged job timestamps untouched', async () => {
    const run = makeRun('run_stable_jobs');
    await db.createRun(run);
    await db.upsertPosts(run.id, [post('1', {
      thread_candidates: [{ url: 'https://x.com/alice/status/11', reason: 'counter' }]
    })]);
    const listJobs = vi.spyOn(db, 'listThreadJobs');
    const getJob = vi.spyOn(db, 'getThreadJob');
    const putJob = vi.spyOn(db, 'putThreadJob');
    try {
      const [first] = await service.buildJobs(run.id);
      const stored = await db.getThreadJob(first.id);
      const updatedAt = stored.updatedAt;
      listJobs.mockClear();
      getJob.mockClear();
      putJob.mockClear();
      await service.buildJobs(run.id);
      expect(listJobs).toHaveBeenCalledTimes(1);
      expect(getJob).not.toHaveBeenCalled();
      expect(putJob).not.toHaveBeenCalled();
      expect((await db.getThreadJob(first.id)).updatedAt).toBe(updatedAt);
    } finally {
      listJobs.mockRestore();
      getJob.mockRestore();
      putJob.mockRestore();
    }
  });

  it('builds thread and quote jobs, deduplicates quotes across parents and counts missing URLs', async () => {
    const run = makeRun('run_build');
    await db.createRun(run);
    await db.upsertPosts(run.id, [
      post('1', {
        thread_candidates: [{ url: 'https://x.com/alice/status/11', reason: 'show-thread', confidence: 'high' }],
        quote_context: {
          quoted_tweet_url: 'https://x.com/bob/status/90', quoted_author_handle: '@bob',
          quoted_timestamp_iso: '2024-01-01T00:00:00.000Z', quoted_text: 'Quoted text'
        }
      }),
      post('2', { quote_context: { quoted_tweet_url: 'https://twitter.com/bob/status/90', quoted_text: 'Quoted' } }),
      post('3', { quote_context: { quoted_author_handle: '@nobody', quoted_text: 'no URL here' } })
    ]);

    const jobs = await service.buildJobs(run.id);
    expect(jobs.map((job) => job.kind)).toEqual(['thread', 'quote', 'quote']);
    const quote = jobs.find((job) => job.mode === 'quote');
    const discovery = jobs.find((job) => job.mode === 'quote_discovery');
    expect(quote.id).toBe(run.id + ':quote:90');
    expect(quote.parentPostIds).toEqual(['1', '2']);
    expect(quote.authorHandle).toBe('bob');
    expect(discovery.id).toBe(run.id + ':quote-source:3');
    expect(service.countMissingQuoteUrls(await db.getPosts(run.id))).toBe(1);
  });
});

describe('session selection and retry', () => {
  it('selects a fresh queued link before an earlier failed link at max one', async () => {
    const run = makeRun('run_fresh_first');
    await db.createRun(run);
    await db.upsertPosts(run.id, [
      post('1', { thread_candidates: [{ url: 'https://x.com/alice/status/11', reason: 'counter' }] }),
      post('2', { thread_candidates: [{ url: 'https://x.com/alice/status/12', reason: 'counter' }] })
    ]);
    const jobs = await service.buildJobs(run.id);
    await db.patchThreadJob(jobs[0].id, { state: 'failed', attempts: 1 });
    const response = await service.startQueue({ runId: run.id, kinds: ['thread'], maxJobs: 1 });
    expect(response.ok).toBe(true);
    expect(response.session.selectedJobIds).toEqual([jobs[1].id]);
  });

  it('reports when all selected candidates are already fulfilled', async () => {
    const run = makeRun('run_all_done');
    await db.createRun(run);
    await db.upsertPosts(run.id, [post('1', {
      thread_candidates: [{ url: 'https://x.com/alice/status/11', reason: 'counter' }]
    })]);
    const [job] = await service.buildJobs(run.id);
    await db.patchThreadJob(job.id, { state: 'done' });
    const response = await service.startQueue({ runId: run.id, kinds: ['thread'] });
    expect(response.ok).toBe(false);
    expect(response.error).toBe('all selected candidates already fulfilled');
  });

  it('scopes and caps a session, skips done jobs, and retries failed/incomplete jobs later', async () => {
    const run = makeRun('run_select');
    await db.createRun(run);
    await db.upsertPosts(run.id, [
      post('1', {
        thread_candidates: [{ url: 'https://x.com/alice/status/11', reason: 'counter' }],
        quote_context: { quoted_tweet_url: 'https://x.com/bob/status/91', quoted_text: 'quote one' }
      }),
      post('2', { quote_context: { quoted_tweet_url: 'https://x.com/cara/status/92', quoted_text: 'quote two' } }),
      post('3', { quote_context: { quoted_tweet_url: 'https://x.com/dana/status/93', quoted_text: 'quote three' } })
    ]);
    const jobs = await service.buildJobs(run.id);
    const thread = jobs.find((job) => job.kind === 'thread');
    const quoteOne = jobs.find((job) => job.statusId === '91');
    const quoteTwo = jobs.find((job) => job.statusId === '92');
    const quoteSkipped = jobs.find((job) => job.statusId === '93');
    await db.patchThreadJob(thread.id, { state: 'done' });
    await db.patchThreadJob(quoteSkipped.id, { state: 'skipped' });

    const first = await service.startQueue({ runId: run.id, kinds: ['thread', 'quote'], maxJobs: 1, pace: 'balanced' });
    expect(first.ok).toBe(true);
    expect(first.queued).toBe(1);
    expect(first.session.selectedJobIds).toEqual([quoteOne.id]);
    expect((await db.getThreadJob(thread.id)).state).toBe('done');
    expect((await db.getThreadJob(quoteTwo.id)).sessionId).toBeNull();

    await db.patchRun(run.id, (stored) => {
      stored.fulfillment.state = 'paused';
      stored.fulfillment.currentJobId = null;
      return stored;
    });
    await db.patchThreadJob(quoteOne.id, { state: 'failed' });
    await db.patchThreadJob(quoteTwo.id, { state: 'incomplete' });
    const retry = await service.startQueue({ runId: run.id, kinds: ['quote'], maxJobs: 100 });
    expect(retry.ok).toBe(true);
    expect(retry.session.selectedJobIds).toEqual([quoteTwo.id, quoteOne.id]);
    expect((await db.getThreadJob(quoteSkipped.id)).state).toBe('skipped');
    expect(retry.session.maxJobs).toBe(100);
    expect(retry.session.pace).toBe('cautious');
    const otherRun = makeRun('run_other');
    await db.createRun(otherRun);
    const conflict = await service.startQueue({ runId: otherRun.id });
    expect(conflict.ok).toBe(false);
    expect(conflict.error).toMatch(/another archive/);
  });
});

describe('quote result persistence and pause behavior', () => {
  it('keeps an in-flight page attached during pause and rejects another start until it settles', async () => {
    const run = makeRun('run_graceful_pause');
    const sessionId = 'session_graceful_pause';
    const id = run.id + ':123';
    await db.createRun(Object.assign(run, { fulfillment: {
      state: 'running', sessionId, kinds: ['thread'], pace: 'cautious', maxJobs: 1,
      selectedJobIds: [id], total: 1, processed: 0, done: 0, incomplete: 0, failed: 0,
      currentJobId: id, workerTabId: 77, workerWindowId: 17, nextAt: null,
      pauseReason: null, startedAt: XA.util.nowIso(), updatedAt: XA.util.nowIso(), completedAt: null
    } }));
    await db.putThreadJob({
      id, runId: run.id, kind: 'thread', statusId: '123', url: 'https://x.com/alice/status/123',
      state: 'running', attempts: 1, sessionId, createdAt: XA.util.nowIso(), updatedAt: XA.util.nowIso()
    });
    globalThis.chrome.tabs = { sendMessage: vi.fn() };

    const paused = await service.pauseQueue({ runId: run.id });
    const stored = await db.getRun(run.id);
    const nextName = service.alarmName('xar-fulfill-next:', run.id, sessionId);
    const timeoutName = service.alarmName('xar-fulfill-timeout:', run.id, sessionId);
    expect(paused.paused).toBe(true);
    expect(stored.fulfillment.state).toBe('paused');
    expect(stored.fulfillment.currentJobId).toBe(id);
    expect((await db.getThreadJob(id)).state).toBe('running');
    expect(globalThis.chrome.tabs.sendMessage).not.toHaveBeenCalled();
    expect(globalThis.chrome.alarms.clear).toHaveBeenCalledWith(nextName);
    expect(globalThis.chrome.alarms.clear).not.toHaveBeenCalledWith(timeoutName);
    expect(globalThis.chrome.alarms.create).toHaveBeenCalledWith(timeoutName, expect.objectContaining({ when: expect.any(Number) }));

    const rejected = await service.startQueue({ runId: run.id });
    expect(rejected.ok).toBe(false);
    expect(rejected.error).toBe('current page is still finishing');
    const otherRun = makeRun('run_settling_conflict');
    await db.createRun(otherRun);
    const globalConflict = await service.startQueue({ runId: otherRun.id });
    expect(globalConflict.ok).toBe(false);
    expect(globalConflict.error).toBe('another archive is still finishing its current page');
    await service.handleThreadResult({
      jobId: id, sessionId,
      diagnostics: { kind: 'thread', statusId: '123', sawRequestedId: true },
      posts: [post('123', { text: 'finished page result' })]
    });
    const settled = await db.getRun(run.id);
    expect(settled.fulfillment.state).toBe('paused');
    expect(settled.fulfillment.currentJobId).toBeNull();
    expect((await db.getThreadJob(id)).state).toBe('done');
    expect((await db.getPosts(run.id))[0].text).toBe('finished page result');
  });

  it('adds run source provenance to newly inserted thread posts', async () => {
    const run = makeRun('run_thread_provenance');
    const sessionId = 'session_thread_provenance';
    const id = run.id + ':123';
    await db.createRun(Object.assign(run, { fulfillment: {
      state: 'running', sessionId, kinds: ['thread'], pace: 'cautious', maxJobs: 1,
      selectedJobIds: [id], total: 1, processed: 0, done: 0, incomplete: 0, failed: 0,
      currentJobId: id, workerTabId: null, workerWindowId: null, nextAt: null,
      pauseReason: null, startedAt: XA.util.nowIso(), updatedAt: XA.util.nowIso(), completedAt: null
    } }));
    await db.putThreadJob({
      id, runId: run.id, kind: 'thread', statusId: '123',
      url: 'https://x.com/alice/status/123', state: 'running', attempts: 1, sessionId
    });

    await service.handleThreadResult({
      jobId: id, sessionId,
      diagnostics: { kind: 'thread', statusId: '123', sawRequestedId: true },
      posts: [post('123', { text: 'newly captured thread post' })]
    });
    const [stored] = await db.getPosts(run.id);
    expect(stored.capture_context).toBe('thread');
    expect(stored.source_key).toBe(run.source.key);
    expect(stored.source_type).toBe(run.source.type);
  });

  it('enriches each parent quote_context without adding the fetched post at top level', async () => {
    const run = makeRun('run_quote');
    const sessionId = 'session_quote';
    const quoteJobId = run.id + ':quote:900';
    const parents = [
      post('1', { capture_context: 'import', source_key: 'import:one', source_type: 'import' }),
      post('2', { capture_context: 'import', source_key: 'import:two', source_type: 'import' })
    ].map((parent) => Object.assign(parent, {
      quote_context: { quoted_tweet_url: 'https://x.com/bob/status/900', quoted_text: 'short' }
    }));
    await db.createRun(Object.assign(run, { fulfillment: {
      state: 'running', sessionId, kinds: ['quote'], pace: 'cautious', maxJobs: 10,
      selectedJobIds: [quoteJobId], total: 1, processed: 0, done: 0, incomplete: 0, failed: 0,
      currentJobId: quoteJobId, workerTabId: 7, workerWindowId: 3, nextAt: null,
      pauseReason: null, startedAt: XA.util.nowIso(), updatedAt: XA.util.nowIso(), completedAt: null
    } }));
    await db.upsertPosts(run.id, parents);
    await db.putThreadJob({
      id: quoteJobId, runId: run.id, kind: 'quote', statusId: '900',
      url: 'https://x.com/bob/status/900', parentPostIds: ['1', '2'],
      state: 'running', attempts: 1, sessionId, createdAt: XA.util.nowIso(), updatedAt: XA.util.nowIso()
    });

    const result = await service.handleThreadResult({
      jobId: quoteJobId, sessionId,
      diagnostics: { kind: 'quote', statusId: '900', sawRequestedId: true },
      posts: [post('900', {
        tweet_url: 'https://x.com/bob/status/900', name: 'Bob', handle: '@bob',
        timestamp_iso: '2024-01-01T00:00:00.000Z', text: 'the exact fetched quote',
        images: ['https://img.example/q.jpg'], videos: ['https://x.com/bob/status/900/video/1']
      })]
    });

    expect(result.state).toBe('done');
    const stored = await db.getPosts(run.id);
    expect(stored.map((item) => item.id)).toEqual(['1', '2']);
    for (const parent of stored) {
      expect(parent.capture_context).toBe('import');
      expect(parent.source_key).toBe('import:' + (parent.id === '1' ? 'one' : 'two'));
      expect(parent.source_type).toBe('import');
      expect(parent.quote_context.quoted_fetched).toBe(true);
      expect(parent.quote_context.quoted_fetched_at).toBeTruthy();
      expect(parent.quote_context.quoted_author_handle).toBe('@bob');
      expect(parent.quote_context.quoted_text).toBe('the exact fetched quote');
      expect(parent.quote_context.quoted_images).toEqual(['https://img.example/q.jpg']);
      expect(parent.quote_context.quoted_videos).toHaveLength(1);
    }
  });

  it('pauses the batch after a worker infrastructure failure instead of advancing', async () => {
    const run = makeRun('run_worker_failure');
    const sessionId = 'session_worker_failure';
    const id = run.id + ':123';
    const nextId = run.id + ':124';
    await db.createRun(Object.assign(run, { fulfillment: {
      state: 'running', sessionId, kinds: ['thread'], pace: 'cautious', maxJobs: 2,
      selectedJobIds: [id, nextId], total: 2, processed: 0, done: 0, incomplete: 0, failed: 0,
      currentJobId: id, workerTabId: 50, workerWindowId: 5, nextAt: null,
      pauseReason: null, startedAt: XA.util.nowIso(), updatedAt: XA.util.nowIso(), completedAt: null
    } }));
    for (const statusId of ['123', '124']) {
      await db.putThreadJob({
        id: run.id + ':' + statusId, runId: run.id, kind: 'thread', statusId,
        url: 'https://x.com/alice/status/' + statusId,
        state: statusId === '123' ? 'running' : 'queued', attempts: statusId === '123' ? 1 : 0,
        sessionId, createdAt: XA.util.nowIso(), updatedAt: XA.util.nowIso()
      });
    }

    await service.resolveFailure(run.id, sessionId, { id, statusId: '123' }, new Error('tab load timeout'));
    const stored = await db.getRun(run.id);
    expect(stored.fulfillment.state).toBe('paused');
    expect(stored.fulfillment.currentJobId).toBeNull();
    expect(stored.fulfillment.pauseReason).toBe('worker error: tab load timeout');
    expect((await db.getThreadJob(id)).state).toBe('failed');
    expect((await db.getThreadJob(nextId)).state).toBe('queued');
    expect(globalThis.chrome.alarms.create).not.toHaveBeenCalled();
  });

  it('treats a negative content response as a send failure', async () => {
    globalThis.chrome.tabs = { sendMessage: vi.fn((_tabId, _message, callback) => {
      callback({ ok: false, error: 'fulfillment worker is already busy' });
    }) };
    const result = await service.sendJobWithRetry(52, 'run_send_rejected', 'session_send_rejected', {
      id: 'run_send_rejected:123', kind: 'thread', statusId: '123',
      url: 'https://x.com/alice/status/123'
    });
    expect(result.error.message).toBe('fulfillment worker is already busy');
    expect(globalThis.chrome.tabs.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('pauses on a job watchdog timeout without advancing the next selected job', async () => {
    const run = makeRun('run_watchdog_timeout');
    const sessionId = 'session_watchdog_timeout';
    const id = run.id + ':123';
    const nextId = run.id + ':124';
    await db.createRun(Object.assign(run, { fulfillment: {
      state: 'running', sessionId, selectedJobIds: [id, nextId], currentJobId: id,
      workerTabId: 52, workerWindowId: 7, nextAt: null,
      pace: 'cautious', total: 2, processed: 0, done: 0, incomplete: 0, failed: 0,
      pauseReason: null
    } }));
    await db.putThreadJob({ id, runId: run.id, kind: 'thread', statusId: '123',
      url: 'https://x.com/alice/status/123', state: 'running', sessionId });
    await db.putThreadJob({ id: nextId, runId: run.id, kind: 'thread', statusId: '124',
      url: 'https://x.com/alice/status/124', state: 'queued', sessionId });

    await service.handleAlarm({ name: service.alarmName('xar-fulfill-timeout:', run.id, sessionId) });
    const stored = await db.getRun(run.id);
    expect(stored.fulfillment.state).toBe('paused');
    expect(stored.fulfillment.currentJobId).toBeNull();
    expect(stored.fulfillment.pauseReason).toBe('worker error: job timed out after 120 seconds');
    expect((await db.getThreadJob(id)).state).toBe('failed');
    expect((await db.getThreadJob(nextId)).state).toBe('queued');
    expect(globalThis.chrome.alarms.create).not.toHaveBeenCalled();
  });

  it('settles a paused watchdog timeout without replacing the user pause reason', async () => {
    const run = makeRun('run_paused_timeout');
    const sessionId = 'session_paused_timeout';
    const id = run.id + ':123';
    await db.createRun(Object.assign(run, { fulfillment: {
      state: 'paused', sessionId, selectedJobIds: [id], currentJobId: id,
      workerTabId: 52, workerWindowId: 7, nextAt: null,
      pace: 'cautious', total: 1, processed: 0, done: 0, incomplete: 0, failed: 0,
      pauseReason: 'Paused after current page'
    } }));
    await db.putThreadJob({ id, runId: run.id, kind: 'thread', statusId: '123',
      url: 'https://x.com/alice/status/123', state: 'running', sessionId });

    await service.handleAlarm({ name: service.alarmName('xar-fulfill-timeout:', run.id, sessionId) });
    const stored = await db.getRun(run.id);
    expect(stored.fulfillment.state).toBe('paused');
    expect(stored.fulfillment.currentJobId).toBeNull();
    expect(stored.fulfillment.pauseReason).toBe('Paused after current page');
    expect((await db.getThreadJob(id)).state).toBe('paused');
  });

  it('retries one missing content-script receiver after 750ms when the session remains current', async () => {
    const run = makeRun('run_send_retry');
    const sessionId = 'session_send_retry';
    const id = run.id + ':123';
    await db.createRun(Object.assign(run, { fulfillment: {
      state: 'running', sessionId, selectedJobIds: [id], currentJobId: id,
      workerTabId: 51, workerWindowId: 6
    } }));
    await db.putThreadJob({
      id, runId: run.id, kind: 'thread', statusId: '123',
      url: 'https://x.com/alice/status/123', state: 'running', sessionId
    });
    let attempts = 0;
    globalThis.chrome.tabs = { sendMessage: vi.fn((_tabId, _message, callback) => {
      attempts++;
      globalThis.chrome.runtime.lastError = attempts === 1
        ? { message: 'Could not establish connection. Receiving end does not exist.' } : null;
      callback({ ok: true });
    }) };
    const sleep = vi.spyOn(XA.util, 'sleep').mockResolvedValue();
    try {
      const response = await service.sendJobWithRetry(51, run.id, sessionId, {
        id, kind: 'thread', statusId: '123', url: 'https://x.com/alice/status/123'
      });
      expect(response).toEqual({ sent: true, retried: true });
      expect(globalThis.chrome.tabs.sendMessage).toHaveBeenCalledTimes(2);
      expect(sleep).toHaveBeenCalledWith(750);
    } finally {
      sleep.mockRestore();
    }
  });

  it('cancels fulfillment alarms and worker navigation before archive deletion', async () => {
    const run = makeRun('run_delete_cleanup');
    const sessionId = 'session_delete_cleanup';
    const id = run.id + ':123';
    await db.createRun(Object.assign(run, { fulfillment: {
      state: 'running', sessionId, selectedJobIds: [id], currentJobId: null,
      workerTabId: 91, workerWindowId: 9, nextAt: null
    } }));
    await db.putThreadJob({
      id, runId: run.id, kind: 'thread', statusId: '123',
      url: 'https://x.com/alice/status/123', state: 'running', sessionId
    });
    globalThis.chrome.tabs = {
      sendMessage: vi.fn((_tabId, _message, callback) => callback({ ok: true })),
      update: vi.fn(async () => ({ id: 91 }))
    };
    await service.scheduleNext(run.id, sessionId, 15000);
    await db.patchRun(run.id, (stored) => {
      stored.fulfillment.currentJobId = id;
      return stored;
    });
    await service.cancelForDelete(run.id);
    const stored = await db.getRun(run.id);
    expect(service.hasLocalNextTimer(run.id, sessionId)).toBe(false);
    expect(stored.fulfillment.currentJobId).toBeNull();
    expect((await db.getThreadJob(id)).state).toBe('paused');
    expect(globalThis.chrome.tabs.sendMessage).toHaveBeenCalledWith(91,
      expect.objectContaining({ action: 'cancel' }), expect.any(Function));
    expect(globalThis.chrome.tabs.update).toHaveBeenCalledWith(91, expect.objectContaining({
      url: 'chrome-extension://test/src/options/options.html#archives', active: true
    }), expect.any(Function));
  });

  it('does not let a stale dispatch failure overwrite the tab-closed pause', async () => {
    const run = makeRun('run_tab_closed');
    const sessionId = 'session_tab_closed';
    const id = run.id + ':123';
    await db.createRun(Object.assign(run, { fulfillment: {
      state: 'running', sessionId, kinds: ['thread'], pace: 'cautious', maxJobs: 1,
      selectedJobIds: [id], total: 1, processed: 0, done: 0, incomplete: 0, failed: 0,
      currentJobId: id, workerTabId: 88, workerWindowId: 18, nextAt: null,
      pauseReason: null, startedAt: XA.util.nowIso(), updatedAt: XA.util.nowIso(), completedAt: null
    } }));
    await db.putThreadJob({
      id, runId: run.id, kind: 'thread', statusId: '123', url: 'https://x.com/alice/status/123',
      state: 'running', attempts: 1, sessionId, createdAt: XA.util.nowIso(), updatedAt: XA.util.nowIso()
    });
    await service.tabRemoved(88);
    await service.resolveFailure(run.id, sessionId, { id, statusId: '123' }, new Error('late send failure'));

    const stored = await db.getRun(run.id);
    const job = await db.getThreadJob(id);
    expect(stored.fulfillment.state).toBe('paused');
    expect(stored.fulfillment.pauseReason).toBe('worker tab closed');
    expect(stored.fulfillment.currentJobId).toBeNull();
    expect(job.state).toBe('paused');
    expect(job.diagnostics.error).toBe('worker tab closed');
  });

  it('pauses automatically when a result reports a blocked surface', async () => {
    const run = makeRun('run_blocked');
    const sessionId = 'session_blocked';
    const id = run.id + ':123';
    await db.createRun(Object.assign(run, { fulfillment: {
      state: 'running', sessionId, kinds: ['thread'], pace: 'cautious', maxJobs: 1,
      selectedJobIds: [id], total: 1, processed: 0, done: 0, incomplete: 0, failed: 0,
      currentJobId: id, workerTabId: 8, workerWindowId: 4, nextAt: null,
      pauseReason: null, startedAt: XA.util.nowIso(), updatedAt: XA.util.nowIso(), completedAt: null
    } }));
    await db.putThreadJob({
      id, runId: run.id, kind: 'thread', statusId: '123', url: 'https://x.com/alice/status/123',
      state: 'running', attempts: 1, sessionId, createdAt: XA.util.nowIso(), updatedAt: XA.util.nowIso()
    });
    await service.handleThreadResult({
      jobId: id, sessionId, posts: [],
      diagnostics: { kind: 'thread', statusId: '123', blockedReason: 'rate_limited', error: 'X rate limit' }
    });
    const stored = await db.getRun(run.id);
    expect(stored.fulfillment.state).toBe('paused');
    expect(stored.fulfillment.pauseReason).toBe('rate_limited');
    expect((await db.getThreadJob(id)).diagnostics.blockedReason).toBe('rate_limited');
  });
});

describe('pacing and content quote checks', () => {
  it('uses a local wake for immediate and sub-30s schedules and clears it on pause', async () => {
    const runId = 'run_local_wake';
    const sessionId = 'session_local_wake';
    await db.createRun(makeRun(runId, { fulfillment: {
      state: 'running', sessionId, selectedJobIds: [], currentJobId: null,
      workerTabId: null, workerWindowId: null, nextAt: null
    } }));
    let timerId = 0;
    const pendingTimers = new Map();
    const fakeTimers = {
      setTimeout(callback, delay) {
        const id = ++timerId;
        pendingTimers.set(id, { callback, delay });
        return id;
      },
      clearTimeout(id) { pendingTimers.delete(id); }
    };
    const startedAt = Date.now();
    await service.scheduleNext(runId, sessionId, 0, fakeTimers);
    const name = service.alarmName('xar-fulfill-next:', runId, sessionId);
    expect(service.hasLocalNextTimer(runId, sessionId)).toBe(true);
    expect(Array.from(pendingTimers.values()).map((timer) => timer.delay)).toEqual([0]);
    expect(globalThis.chrome.alarms.create).toHaveBeenLastCalledWith(name,
      expect.objectContaining({ when: expect.any(Number) }));
    expect(globalThis.chrome.alarms.create.mock.calls.at(-1)[1].when).toBeGreaterThanOrEqual(
      startedAt + service.MIN_ALARM_DELAY_MS);

    await service.scheduleNext(runId, sessionId, 12000, fakeTimers);
    expect(service.hasLocalNextTimer(runId, sessionId)).toBe(true);
    const localDelays = Array.from(pendingTimers.values()).map((timer) => timer.delay);
    expect(localDelays).toHaveLength(1);
    expect(localDelays[0]).toBeGreaterThanOrEqual(0);
    expect(localDelays[0]).toBeLessThanOrEqual(12000);
    await service.pauseQueue({ runId });
    expect(service.hasLocalNextTimer(runId, sessionId)).toBe(false);
    expect(pendingTimers.size).toBe(0);
    expect(globalThis.chrome.alarms.clear).toHaveBeenCalledWith(name);
  });

  it('recreates a sub-30s local wake from persisted nextAt during recovery', async () => {
    const runId = 'run_recover_local_wake';
    const sessionId = 'session_recover_local_wake';
    const nextAt = Date.now() + 12000;
    await db.createRun(makeRun(runId, { fulfillment: {
      state: 'running', sessionId, selectedJobIds: [], currentJobId: null,
      workerTabId: null, workerWindowId: null, nextAt: new Date(nextAt).toISOString()
    } }));
    const name = service.alarmName('xar-fulfill-next:', runId, sessionId);
    await globalThis.chrome.alarms.create(name, { when: nextAt + 60000 });
    const previousAlarmCalls = globalThis.chrome.alarms.create.mock.calls.length;
    const recoveryStart = Date.now();
    await service.recoverQueues();
    expect(service.hasLocalNextTimer(runId, sessionId)).toBe(true);
    expect(globalThis.chrome.alarms.create.mock.calls.length).toBeGreaterThan(previousAlarmCalls);
    expect(globalThis.chrome.alarms.create).toHaveBeenLastCalledWith(name,
      expect.objectContaining({ when: expect.any(Number) }));
    expect(globalThis.chrome.alarms.create.mock.calls.at(-1)[1].when)
      .toBeGreaterThanOrEqual(recoveryStart + service.MIN_ALARM_DELAY_MS);
    await service.pauseQueue({ runId });
    expect(service.hasLocalNextTimer(runId, sessionId)).toBe(false);
  });

  it('uses only a durable alarm for a 60-second rest', async () => {
    const runId = 'run_long_wake';
    const sessionId = 'session_long_wake';
    await db.createRun(makeRun(runId, { fulfillment: {
      state: 'running', sessionId, selectedJobIds: [], currentJobId: null,
      workerTabId: null, workerWindowId: null, nextAt: null
    } }));
    const timers = { setTimeout: vi.fn(), clearTimeout: vi.fn() };
    const startedAt = Date.now();
    await service.scheduleNext(runId, sessionId, 60000, timers);
    expect(service.hasLocalNextTimer(runId, sessionId)).toBe(false);
    expect(timers.setTimeout).not.toHaveBeenCalled();
    expect(globalThis.chrome.alarms.create.mock.calls.at(-1)[1].when).toBe(startedAt + 60000);
  });

  it('reports all missing numbered-thread parts, including gaps before a seen tail', () => {
    const worker = new XA.content.ThreadWorker();
    expect(worker.counterIncompleteness([{ text: '1/5' }, { text: '5/5' }])).toEqual({
      total: 5, seen: 2, missing: [2, 3, 4]
    });
    expect(worker.counterIncompleteness([{ text: '1/3' }, { text: '2/3' }, { text: '3/3' }])).toBeNull();
  });

  it('uses inclusive bounds and rest ranges at the configured interval', () => {
    const random = vi.spyOn(Math, 'random');
    random.mockReturnValue(0);
    expect(service.delayFor('cautious', 1)).toBe(12000);
    random.mockReturnValue(0.999999);
    expect(service.delayFor('cautious', 5)).toBe(120000);
    random.mockRestore();
  });

  it('classifies blocked surfaces and validates quote identity, timestamp, and meaningful text', () => {
    document.body.innerHTML = '<div>Rate limit exceeded. Try again later.</div>';
    expect(XA.content.threadHelpers.classifyBlockedSurface(document)).toBe('rate_limited');
    document.body.textContent = 'Log in to X to see more';
    expect(XA.content.threadHelpers.classifyBlockedSurface(document)).toBe('login_required');
    document.body.textContent = 'Something went wrong. Try reloading.';
    expect(XA.content.threadHelpers.classifyBlockedSurface(document)).toBe('error_surface');
    const quote = {
      id: '901', handle: '@bob', timestamp_iso: '2024-01-01T00:00:00.000Z',
      text: 'A sufficiently long quoted post prefix that is exact.'
    };
    expect(XA.content.threadHelpers.quoteMismatch(quote, {
      statusId: '901', authorHandle: 'bob', expectedTimestamp: quote.timestamp_iso,
      expectedText: 'A sufficiently long quoted post prefix that is exact... https://x.com/bob/status/901'
    })).toBeNull();
    expect(XA.content.threadHelpers.quoteMismatch(quote, {
      authorHandle: 'cara', expectedTimestamp: quote.timestamp_iso, expectedText: quote.text
    })).toMatch(/handle/);
    expect(XA.content.threadHelpers.quoteMismatch(quote, {
      authorHandle: 'bob', expectedTimestamp: '2024-02-01T00:00:00.000Z', expectedText: quote.text
    })).toMatch(/timestamp/);
    expect(XA.content.threadHelpers.quoteMismatch(Object.assign({}, quote, { text: 'Different long text that does not match.' }), {
      authorHandle: 'bob', expectedTimestamp: quote.timestamp_iso, expectedText: quote.text
    })).toMatch(/text/);
  });

  it('returns only the exact requested quote post', async () => {
    document.body.innerHTML = '';
    const worker = new XA.content.ThreadWorker();
    worker.waitForArticles = async () => true;
    worker.sleep = async () => {};
    worker.conversationUrl = () => 'https://x.com/bob/status/902';
    const originalExpand = XA.extractor.expandTruncatedText;
    const originalExtract = XA.extractor.extractVisible;
    XA.extractor.expandTruncatedText = () => 0;
    XA.extractor.extractVisible = () => ({ posts: [
      post('901', { handle: '@bob', text: 'unrelated quote' }),
      post('902', { handle: '@bob', text: 'the exact requested quote' })
    ] });
    try {
      await worker.processJob({
        id: 'run:quote:902', sessionId: 's', kind: 'quote', statusId: '902',
        authorHandle: 'bob', expectedText: 'the exact requested quote'
      });
      const result = contentMessages.find((message) => message.type === XA.messages.MSG.XAR_THREAD_RESULT);
      expect(result.posts.map((item) => item.id)).toEqual(['902']);
      expect(result.posts[0].thread_id).toBeNull();
      expect(result.posts[0].thread_scraped).toBe(false);
    } finally {
      XA.extractor.expandTruncatedText = originalExpand;
      XA.extractor.extractVisible = originalExtract;
    }
  });
});
