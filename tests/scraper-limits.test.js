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
