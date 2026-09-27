import { describe, it, expect, vi } from 'vitest';
import { XA } from './helpers/load.js';
import '../src/background/export-service.js';

const { normalizeFormats, planFormats } = XA.exportService;

describe('export format normalization', () => {
  it('keeps only valid unique formats in order', () => {
    expect(normalizeFormats(['json', 'html', 'json', 'bogus', 'mediazip', 'html']))
      .toEqual(['json', 'html', 'mediazip']);
    expect(normalizeFormats('json')).toEqual([]);
    expect(normalizeFormats(null)).toEqual([]);
  });

  it('appends mediazip to requested formats when permission exists', () => {
    const plan = planFormats(['json', 'html'], true, true);
    expect(plan.error).toBeUndefined();
    expect(plan.mediaWarning).toBeNull();
    expect(plan.formats).toEqual(['json', 'html', 'mediazip']);
  });

  it('keeps manual mediazip requests ZIP-only', () => {
    const plan = planFormats(['mediazip'], true, true);
    expect(plan.formats).toEqual(['mediazip']);
  });

  it('warns but keeps regular formats when media permission is missing', () => {
    const plan = planFormats(['json', 'html'], true, false);
    expect(plan.error).toBeUndefined();
    expect(plan.formats).toEqual(['json', 'html']);
    expect(plan.mediaWarning).toBe('media-permission-required');
  });

  it('drops a requested mediazip without permission but keeps other formats', () => {
    const plan = planFormats(['mediazip', 'json'], true, false);
    expect(plan.formats).toEqual(['json']);
    expect(plan.mediaWarning).toBe('media-permission-required');
  });

  it('fails when mediazip is the only requested output without permission', () => {
    const plan = planFormats(['mediazip'], true, false);
    expect(plan.error).toBe('media-permission-required');
    const empty = planFormats([], true, false);
    expect(empty.error).toBe('media-permission-required');
  });

  it('leaves non-media requests untouched', () => {
    const plan = planFormats(['json'], false, false);
    expect(plan.formats).toEqual(['json']);
    expect(plan.mediaWarning).toBeNull();
  });
});

describe('offscreen and download lifecycle', () => {
  it('creates the offscreen document once for concurrent ensureOffscreen calls', async () => {
    const prev = globalThis.chrome;
    let resolveCreate;
    const createDocument = vi.fn(
      () => new Promise((resolve) => { resolveCreate = resolve; }));
    globalThis.chrome = {
      runtime: {
        lastError: null,
        getURL: (p) => 'chrome-extension://test/' + p,
        getContexts: async () => []
      },
      offscreen: { createDocument }
    };
    try {
      const first = XA.exportService.ensureOffscreen();
      const second = XA.exportService.ensureOffscreen();
      await new Promise((resolve) => setTimeout(resolve, 0));
      resolveCreate();
      await Promise.all([first, second]);
      expect(createDocument).toHaveBeenCalledTimes(1);
    } finally {
      globalThis.chrome = prev;
    }
  });

  it('rejects downloadOne when the download is interrupted', async () => {
    const prev = globalThis.chrome;
    globalThis.chrome = {
      runtime: {
        lastError: null,
        getURL: (p) => 'chrome-extension://test/' + p
      },
      downloads: {
        download: (opts, cb) => cb(123)
      }
    };
    try {
      const pending = XA.exportService.downloadOne(
        { url: 'blob:test/abc', filename: 'x.json' }, false);
      const assertion = expect(pending).rejects.toThrow(/interrupted/);
      XA.exportService.onDownloadChanged({ id: 123, state: { current: 'interrupted' } });
      await assertion;
    } finally {
      globalThis.chrome = prev;
    }
  });
});
