import { describe, it, expect, beforeEach } from 'vitest';
import { XA } from './helpers/load.js';
import { indexedDB } from 'fake-indexeddb';

const db = XA.db;
const pm = XA.postModel;

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
    runtime: {}
  }, over);
}

function makePost(id, over = {}) {
  return pm.normalizePost(Object.assign({
    tweet_url: 'https://x.com/a/status/' + id,
    name: 'A', text: 'post ' + id,
    timestamp_iso: '2024-01-01T00:00:' + String(id % 60).padStart(2, '0') + '.000Z'
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

beforeEach(freshDb);

describe('run persistence', () => {
  it('creates, reads, patches and lists runs', async () => {
    const run = makeRun();
    await db.createRun(run);
    const got = await db.getRun(run.id);
    expect(got.source.key).toBe('profile:alice:posts');
    const patched = await db.patchRun(run.id, { state: 'paused' });
    expect(patched.state).toBe('paused');
    expect((await db.listRuns({ state: 'paused' }))).toHaveLength(1);
    expect((await db.listRuns({ type: 'profile' }))).toHaveLength(1);
    expect((await db.listRuns({ search: 'alice' }))).toHaveLength(1);
  });

  it('finds unfinished runs by source for reload recovery', async () => {
    const run = makeRun();
    await db.createRun(run);
    expect((await db.findUnfinishedRun('profile:alice:posts')).id).toBe(run.id);
    await db.patchRun(run.id, { state: 'completed' });
    expect(await db.findUnfinishedRun('profile:alice:posts')).toBeNull();
  });

  it('survives reopening the database', async () => {
    const run = makeRun();
    await db.createRun(run);
    await db.upsertPosts(run.id, [makePost(1), makePost(2)]);
    db.resetForTests();
    const posts = await db.getPosts(run.id);
    expect(posts).toHaveLength(2);
    expect(posts[0].id).toBe('1');
  });
});

describe('post upserts', () => {
  it('persists new posts and dedupes by run+id', async () => {
    const run = makeRun();
    await db.createRun(run);
    const r1 = await db.upsertPosts(run.id, [makePost(1), makePost(2), makePost(3)]);
    expect(r1.count).toBe(3);
    const r2 = await db.upsertPosts(run.id, [makePost(2), makePost(4)]);
    expect(r2.count).toBe(4);
    const posts = await db.getPosts(run.id);
    expect(posts.map((p) => p.id)).toEqual(['1', '2', '3', '4']);
  });

  it('merges richer duplicates instead of overwriting', async () => {
    const run = makeRun();
    await db.createRun(run);
    await db.upsertPosts(run.id, [makePost(1, { text: 'short', metrics: { replies: 5 } })]);
    await db.upsertPosts(run.id, [makePost(1, {
      text: 'a much longer version of the text',
      metrics: { replies: 9 },
      capture_context: 'thread',
      thread_id: 'https://x.com/a/status/1'
    })]);
    const [p] = await db.getPosts(run.id);
    expect(p.text).toBe('a much longer version of the text');
    expect(p.metrics.replies).toBe(9);
    expect(p.capture_context).toBe('timeline');
    expect(p.thread_scraped).toBe(true);
  });

  it('keeps capture order via seq', async () => {
    const run = makeRun();
    await db.createRun(run);
    await db.upsertPosts(run.id, [makePost(9), makePost(1)]);
    const posts = await db.getPosts(run.id);
    expect(posts.map((p) => p.id)).toEqual(['9', '1']);
  });
});

describe('thread jobs and deletion', () => {
  it('stores and patches thread jobs', async () => {
    const run = makeRun();
    await db.createRun(run);
    await db.putThreadJob({
      id: run.id + ':123', runId: run.id, statusId: '123',
      url: 'https://x.com/a/status/123', state: 'queued', attempts: 0,
      createdAt: XA.util.nowIso(), updatedAt: XA.util.nowIso()
    });
    const patched = await db.patchThreadJob(run.id + ':123', { state: 'done', postsFound: 7 });
    expect(patched.state).toBe('done');
    expect(await db.listThreadJobs(run.id)).toHaveLength(1);
  });

  it('deleteRun cascades posts, thread jobs and export jobs', async () => {
    const run = makeRun();
    await db.createRun(run);
    await db.upsertPosts(run.id, [makePost(1)]);
    await db.putThreadJob({ id: run.id + ':9', runId: run.id, statusId: '9', state: 'queued', createdAt: 'x', updatedAt: 'x' });
    await db.putExportJob({ id: 'e1', runId: run.id, kind: 'json', state: 'done', createdAt: 'x', updatedAt: 'x' });
    await db.deleteRun(run.id);
    expect(await db.getRun(run.id)).toBeUndefined();
    expect(await db.getPosts(run.id)).toHaveLength(0);
    expect(await db.listThreadJobs(run.id)).toHaveLength(0);
    expect(await db.listExportJobs(run.id)).toHaveLength(0);
  });
});
