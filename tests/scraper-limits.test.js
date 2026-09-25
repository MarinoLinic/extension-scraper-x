import { describe, it, expect } from 'vitest';
import { XA } from './helpers/load.js';

const { ScraperController } = XA.content;

function controller(settings = {}) {
  const c = new ScraperController();
  c.settings = Object.assign({}, XA.defaults.DEFAULT_SETTINGS, settings);
  return c;
}

describe('randomized bounds', () => {
  it('tick delay stays within configured range', () => {
    const c = controller({ tickDelayMinMs: 1000, tickDelayMaxMs: 2000 });
    for (let i = 0; i < 200; i++) {
      const d = c.tickDelay();
      expect(d).toBeGreaterThanOrEqual(1000);
      expect(d).toBeLessThanOrEqual(2000);
    }
  });

  it('scroll amount stays within configured range', () => {
    const c = controller({ scrollMinPx: 100, scrollMaxPx: 300 });
    for (let i = 0; i < 200; i++) {
      const d = c.scrollAmount();
      expect(d).toBeGreaterThanOrEqual(100);
      expect(d).toBeLessThanOrEqual(300);
    }
  });

  it('rest duration stays within configured range', () => {
    const c = controller({ restMinMs: 5000, restMaxMs: 9000 });
    for (let i = 0; i < 200; i++) {
      const d = c.restDuration();
      expect(d).toBeGreaterThanOrEqual(5000);
      expect(d).toBeLessThanOrEqual(9000);
    }
  });

  it('non-randomized mode returns midpoints', () => {
    const c = controller({ randomize: false, tickDelayMinMs: 1000, tickDelayMaxMs: 3000, scrollMinPx: 100, scrollMaxPx: 500 });
    expect(c.tickDelay()).toBe(2000);
    expect(c.scrollAmount()).toBe(300);
  });
});

describe('limit checks', () => {
  it('reachedOldestDate only trips on posts before the cutoff', () => {
    const c = controller({ oldestDate: '2024-06-01' });
    c.collected.set('a', { timestamp_iso: '2024-06-05T00:00:00Z' });
    expect(c.reachedOldestDate()).toBe(false);
    c.collected.set('b', { timestamp_iso: '2024-05-30T00:00:00Z' });
    expect(c.reachedOldestDate()).toBe(true);
  });

  it('reachedOldestDate ignores missing timestamps', () => {
    const c = controller({ oldestDate: '2024-06-01' });
    c.collected.set('a', { timestamp_iso: null });
    expect(c.reachedOldestDate()).toBe(false);
  });

  it('active elapsed freezes while paused', () => {
    const c = controller();
    c.state = 'running';
    c.activeSegmentStart = Date.now() - 5000;
    const running = c.elapsed();
    expect(running).toBeGreaterThanOrEqual(4900);
    c.state = 'paused';
    c.activeElapsedMs = running;
    c.activeSegmentStart = null;
    expect(c.elapsed()).toBe(running);
  });

  it('scheduled rests still consume active duration', () => {
    const c = controller();
    c.state = 'resting';
    c.activeSegmentStart = Date.now() - 2000;
    expect(c.elapsed()).toBeGreaterThanOrEqual(1900);
  });
});

describe('new-post accounting', () => {
  const pm = XA.postModel;

  function post(id, over = {}) {
    return pm.normalizePost(Object.assign({
      tweet_url: 'https://x.com/a/status/' + id,
      text: 'hello ' + id,
      timestamp_iso: '2024-01-01T00:00:00.000Z'
    }, over));
  }

  function runnable(c) {
    c.run = { id: 'run_t', source: { key: 'profile:a:posts', type: 'profile' }, runtime: {}, stats: { posts: 0 } };
    return c;
  }

  it('re-extracting identical visible posts produces no batch', () => {
    const c = controller();
    expect(c.absorbBatch([post(1), post(2)])).toHaveLength(2);
    expect(c.absorbBatch([post(1), post(2)])).toHaveLength(0);
    expect(c.pendingPosts).toHaveLength(2);
  });

  it('a richer rewrite is persisted but does not count as a new post', async () => {
    const c = runnable(controller());
    let sent = 0;
    c.sendToBackground = async () => {
      sent++;
      return { ok: true, added: 0, changed: 1, count: 1 };
    };
    c.absorbBatch([post(1)]);
    c.lastAdded = 0;
    await c.flushBatch();
    c.absorbBatch([post(1, { text: 'a much longer text than before' })]);
    expect(c.pendingPosts).toHaveLength(1);
    await c.flushBatch();
    expect(sent).toBe(2);
    expect(c.lastAdded).toBe(0);
    expect(c.postsSinceRest).toBe(0);
  });

  it('flush acknowledgement counts genuinely new posts', async () => {
    const c = runnable(controller());
    c.sendToBackground = async () => ({ ok: true, added: 2, changed: 2, count: 2 });
    c.absorbBatch([post(1), post(2)]);
    c.lastAdded = 0;
    await c.flushBatch();
    expect(c.lastAdded).toBe(2);
    expect(c.persistedCount).toBe(2);
  });

  it('no flush means zero added for the tick', async () => {
    const c = runnable(controller());
    c.sendToBackground = async () => ({ ok: true, added: 9, changed: 9, count: 9 });
    c.lastAdded = 0;
    await c.flushBatch();
    expect(c.lastAdded).toBe(0);
  });

  it('snapshot threshold starts from persisted count after reload', async () => {
    const c = runnable(controller({ snapshotEveryPosts: 100 }));
    let exported = 0;
    c.sendToBackground = async () => { exported++; return { ok: true }; };
    c.persistedCount = 80;
    c.snapshotCount = c.persistedCount;
    c.maybeSnapshot();
    expect(exported).toBe(0);
    c.persistedCount = 181;
    c.maybeSnapshot();
    expect(exported).toBe(1);
    c.persistedCount = 200;
    c.maybeSnapshot();
    expect(exported).toBe(1);
  });
});
