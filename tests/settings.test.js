import { describe, it, expect } from 'vitest';
import { XA } from './helpers/load.js';

const { validateSettings, applyPreset } = XA.settings;
const { DEFAULT_SETTINGS, PRESETS } = XA.defaults;

describe('settings validation', () => {
  it('matches the documented defaults contract', () => {
    expect(DEFAULT_SETTINGS.preset).toBe('balanced');
    expect(DEFAULT_SETTINGS.randomize).toBe(true);
    expect(DEFAULT_SETTINGS.tickDelayMinMs).toBe(3000);
    expect(DEFAULT_SETTINGS.tickDelayMaxMs).toBe(6000);
    expect(DEFAULT_SETTINGS.scrollMinPx).toBe(650);
    expect(DEFAULT_SETTINGS.scrollMaxPx).toBe(1150);
    expect(DEFAULT_SETTINGS.restEveryPosts).toBe(80);
    expect(DEFAULT_SETTINGS.restMinMs).toBe(20000);
    expect(DEFAULT_SETTINGS.restMaxMs).toBe(28000);
    expect(DEFAULT_SETTINGS.stallTimeoutMs).toBe(120000);
    expect(DEFAULT_SETTINGS.stallRecoveryAttempts).toBe(2);
    expect(DEFAULT_SETTINGS.maxActiveDurationMs).toBeNull();
    expect(DEFAULT_SETTINGS.maxPosts).toBeNull();
    expect(DEFAULT_SETTINGS.oldestDate).toBeNull();
    expect(DEFAULT_SETTINGS.autoScroll).toBe(true);
    expect(DEFAULT_SETTINGS.autoExpandText).toBe(true);
    expect(DEFAULT_SETTINGS.autoResume).toBe(true);
    expect(DEFAULT_SETTINGS.showOverlay).toBe(true);
    expect(DEFAULT_SETTINGS.showBadge).toBe(true);
    expect(DEFAULT_SETTINGS.autoExportOnComplete).toBe(true);
    expect(DEFAULT_SETTINGS.exportFormats).toEqual(['json', 'html']);
    expect(DEFAULT_SETTINGS.snapshotEveryPosts).toBeNull();
    expect(DEFAULT_SETTINGS.jsonFormat).toBe('envelope');
    expect(DEFAULT_SETTINGS.saveAs).toBe(false);
    expect(DEFAULT_SETTINGS.filenameTemplate).toBe('x_%type_%handle_%date_%num');
    expect(DEFAULT_SETTINGS.autoMediaZip).toBe(false);
    expect(DEFAULT_SETTINGS.media).toEqual({
      postImages: true, quotedImages: true, cardImages: false, avatars: false
    });
  });

  it('clamps numeric ranges and reports it', () => {
    const { settings, errors } = validateSettings({ tickDelayMinMs: 5 });
    expect(settings.tickDelayMinMs).toBe(250);
    expect(errors.tickDelayMinMs).toMatch(/clamp/i);
  });

  it('swaps inverted min/max pairs', () => {
    const { settings, errors } = validateSettings({ tickDelayMinMs: 8000, tickDelayMaxMs: 1000 });
    expect(settings.tickDelayMinMs).toBe(1000);
    expect(settings.tickDelayMaxMs).toBe(8000);
    expect(errors.tickDelayMaxMs).toBeTruthy();
  });

  it('allows null limits', () => {
    const { settings } = validateSettings({ maxPosts: null, oldestDate: '', maxActiveDurationMs: '' });
    expect(settings.maxPosts).toBeNull();
    expect(settings.oldestDate).toBeNull();
    expect(settings.maxActiveDurationMs).toBeNull();
  });

  it('rejects bad oldest dates and tiny durations', () => {
    const { errors } = validateSettings({ oldestDate: '05/01/2024', maxActiveDurationMs: 5000 });
    expect(errors.oldestDate).toBeTruthy();
    expect(errors.maxActiveDurationMs).toBeTruthy();
    const ok = validateSettings({ oldestDate: '2024-01-15', maxActiveDurationMs: 60000 });
    expect(ok.settings.oldestDate).toBe('2024-01-15');
    expect(ok.settings.maxActiveDurationMs).toBe(60000);
  });

  it('requires at least one export format', () => {
    const { errors } = validateSettings({ exportFormats: [] });
    expect(errors.exportFormats).toBeTruthy();
    const { settings } = validateSettings({ exportFormats: ['json'] });
    expect(settings.exportFormats).toEqual(['json']);
  });

  it('editing a preset field switches preset to custom', () => {
    const { settings } = validateSettings({ tickDelayMinMs: 4000 }, { preset: 'balanced' });
    expect(settings.preset).toBe('custom');
  });

  it('applying a preset overrides its fields', () => {
    const gentle = applyPreset(DEFAULT_SETTINGS, 'gentle');
    expect(gentle.tickDelayMinMs).toBe(PRESETS.gentle.tickDelayMinMs);
    expect(gentle.preset).toBe('gentle');
    const custom = applyPreset(gentle, 'custom');
    expect(custom.preset).toBe('custom');
    expect(custom.tickDelayMinMs).toBe(PRESETS.gentle.tickDelayMinMs);
  });

  it('rejects unknown presets and empty filename templates', () => {
    const { errors } = validateSettings({ preset: 'turbo', filenameTemplate: '  ' });
    expect(errors.preset).toBeTruthy();
    expect(errors.filenameTemplate).toBeTruthy();
  });
});
