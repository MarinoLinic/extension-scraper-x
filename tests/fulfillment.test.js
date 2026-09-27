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
    expect(jobs.map((job) => job.kind)).toEqual(['thread', 'quote']);
    const quote = jobs.find((job) => job.kind === 'quote');
    expect(quote.id).toBe(run.id + ':quote:90');
    expect(quote.parentPostIds).toEqual(['1', '2']);
    expect(quote.authorHandle).toBe('bob');
    expect(service.countMissingQuoteUrls(await db.getPosts(run.id))).toBe(1);
  });
});

describe('session selection and retry', () => {
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
    expect(retry.session.selectedJobIds).toEqual([quoteOne.id, quoteTwo.id]);
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

