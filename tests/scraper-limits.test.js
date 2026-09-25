import { describe, it, expect, vi, afterEach } from 'vitest';
import { XA } from './helpers/load.js';

const { ScraperController } = XA.content;

function controller(settings = {}) {
  const c = new ScraperController();
  c.settings = Object.assign({}, XA.defaults.DEFAULT_SETTINGS, settings);
  return c;
}

describe('randomized bounds', () => {
  it('tick delay stays within configured range', () => {
    const c = controller({ tickDelayMinMs: 1000, tickDelayMaxMs: 2000, readingPauseChancePercent: 0 });
    for (let i = 0; i < 200; i++) {
      const d = c.tickDelay();
      expect(d).toBeGreaterThanOrEqual(1000);
      expect(d).toBeLessThanOrEqual(2000);
    }
  });

  it('scroll amount stays within configured range (aside from micro-scrolls)', () => {
    const c = controller({ scrollMinPx: 100, scrollMaxPx: 300 });
    for (let i = 0; i < 200; i++) {
      const d = c.scrollAmount();
      expect(d).toBeGreaterThanOrEqual(35);
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

describe('humanized pacing', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('humanUnit averages three draws — center-weighted', () => {
    const c = controller();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    expect(c.humanUnit()).toBe(0.5);
    vi.spyOn(Math, 'random').mockReturnValue(0.9);
    expect(c.humanUnit()).toBe(0.9);
  });

  it('sampleRange uses center-weighted sampling, midpoint when randomize off', () => {
    const c = controller({ randomize: true });
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    expect(c.sampleRange(100, 300)).toBe(200);
    vi.spyOn(Math, 'random').mockReturnValue(0.9);
    expect(c.sampleRange(100, 300)).toBe(280);
    const fixed = controller({ randomize: false });
    vi.spyOn(Math, 'random').mockReturnValue(0.01);
    expect(fixed.sampleRange(100, 300)).toBe(200);
  });

  it('a reading pause can push a tick delay beyond the base max', () => {
    const c = controller({
      tickDelayMinMs: 1000, tickDelayMaxMs: 2000,
      readingPauseChancePercent: 100, readingPauseMinMs: 7000, readingPauseMaxMs: 8000
    });
    vi.spyOn(Math, 'random').mockReturnValue(0);
    expect(c.tickDelay()).toBe(8000);
  });

  it('restThreshold jitters within the configured spread and floors at 5', () => {
    const c = controller({ restEveryPosts: 100, restCountJitterPercent: 30 });
    for (let i = 0; i < 200; i++) {
      const t = c.restThreshold();
      expect(t).toBeGreaterThanOrEqual(70);
      expect(t).toBeLessThanOrEqual(130);
    }
    vi.spyOn(Math, 'random').mockReturnValue(0);
    expect(c.restThreshold()).toBe(70);
    vi.spyOn(Math, 'random').mockReturnValue(0.999);
    expect(c.restThreshold()).toBe(130);
    const tiny = controller({ restEveryPosts: 5, restCountJitterPercent: 75 });
    vi.spyOn(Math, 'random').mockReturnValue(0);
    expect(tiny.restThreshold()).toBe(5);
    const fixed = controller({ randomize: false, restEveryPosts: 100, restCountJitterPercent: 30 });
    expect(fixed.restThreshold()).toBe(100);
  });

  it('micro-scrolls shrink about a 12% slice of randomized scrolls', () => {
    const c = controller({ scrollMinPx: 100, scrollMaxPx: 300 });
    vi.spyOn(Math, 'random').mockReturnValue(0);
    expect(c.scrollAmount()).toBe(35);
    vi.spyOn(Math, 'random').mockReturnValue(0.99);
    expect(c.scrollAmount()).toBe(298); // no micro-scroll at the top of the range
  });

  it('doScroll backtracks upward by 12–32% when the chance fires', () => {
    const c = controller({ backtrackChancePercent: 100 });
    const spy = vi.fn();
    (document.scrollingElement || document.documentElement).scrollBy = spy;
    vi.spyOn(Math, 'random').mockReturnValue(0);
    c.doScroll(1000);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0].top).toBe(-120);
    vi.spyOn(Math, 'random').mockReturnValue(0.999);
    c.doScroll(1000);
    expect(spy.mock.calls[1][0].top).toBe(-320);
  });

  it('doScroll never backtracks or randomizes when humanize=false', () => {
    const c = controller({ backtrackChancePercent: 100 });
    const spy = vi.fn();
    (document.scrollingElement || document.documentElement).scrollBy = spy;
    vi.spyOn(Math, 'random').mockReturnValue(0);
    c.doScroll(1000, false);
    expect(spy.mock.calls[0][0].top).toBe(1000);
  });

  it('scrolls smoothly while visible and instantly while hidden', () => {
    const c = controller({ backtrackChancePercent: 0, smoothScroll: true });
    const spy = vi.fn();
    (document.scrollingElement || document.documentElement).scrollBy = spy;
    Object.defineProperty(document, 'hidden', { value: false, configurable: true });
    c.doScroll(500, false);
    expect(spy.mock.calls[0][0]).toMatchObject({ top: 500, left: 0, behavior: 'smooth' });
    Object.defineProperty(document, 'hidden', { value: true, configurable: true });
    c.doScroll(500, false);
    expect(spy.mock.calls[1][0]).toMatchObject({ top: 500, left: 0, behavior: 'auto' });
    Object.defineProperty(document, 'hidden', { value: false, configurable: true });
    c.settings.smoothScroll = false;
    c.doScroll(500, false);
    expect(spy.mock.calls[2][0]).toMatchObject({ top: 500, left: 0, behavior: 'auto' });
  });
});

describe('hidden-tab behavior', () => {
  afterEach(() => {
    Object.defineProperty(document, 'hidden', { value: false, configurable: true });
    vi.restoreAllMocks();
  });

  function hiddenRunnable(c) {
    c.run = { id: 'run_h', source: { key: 'profile:a:posts', type: 'profile' }, runtime: {}, stats: { posts: 0 } };
    c.state = 'running';
    c.sourceMatches = () => true;
    c.reportState = () => {};
    XA.extractor.extractVisible = () => ({ posts: [], tail: null });
    c.scrollHeight = () => 1000;
    c.lastScrollHeight = 1000;
    return c;
  }

  it('waits while hidden by default', async () => {
    const c = hiddenRunnable(controller({ continueWhenHidden: false }));
    const spy = vi.fn();
    (document.scrollingElement || document.documentElement).scrollBy = spy;
    Object.defineProperty(document, 'hidden', { value: true, configurable: true });
    await c.tick();
    expect(c.state).toBe('running');
    expect(c.message).toMatch(/hidden/i);
    expect(spy).not.toHaveBeenCalled();
  });

  it('continues best-effort while hidden but never claims the bottom or recovers', async () => {
    const c = hiddenRunnable(controller({
      continueWhenHidden: true,
      stallTimeoutMs: 1000,
      stallRecoveryAttempts: 0
    }));
    const spy = vi.fn();
    (document.scrollingElement || document.documentElement).scrollBy = spy;
    Object.defineProperty(document, 'hidden', { value: true, configurable: true });
    c.stallMs = 99999999;
    c.stallWindowStart = c.now() - 99999999;
    const finishSpy = vi.spyOn(c, 'finish');
    for (let i = 0; i < 5; i++) await c.tick();
    expect(c.state).toBe('running');
    expect(finishSpy).not.toHaveBeenCalled();
    expect(c.recoveryAttempts).toBe(0);
    expect(c.stallMs).toBe(0);
    expect(c.stallWindowStart).toBeNull();
    expect(c.message).toMatch(/best effort/i);
    expect(c.runtimeSnapshot().hidden).toBe(true);
    expect(spy).toHaveBeenCalled();
    expect(spy.mock.calls[0][0].behavior).toBe('auto');

    Object.defineProperty(document, 'hidden', { value: false, configurable: true });
    await c.tick();
    expect(c.state).toBe('running');
    expect(finishSpy).not.toHaveBeenCalled();
    expect(c.recoveryAttempts).toBe(0);
    expect(c.currentStallMs()).toBeLessThan(1000);
    expect(c.message).not.toMatch(/best effort/i);
  });
});
