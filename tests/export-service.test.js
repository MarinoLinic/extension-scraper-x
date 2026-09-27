import { describe, it, expect } from 'vitest';
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
