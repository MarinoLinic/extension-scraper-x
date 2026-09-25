import { describe, it, expect } from 'vitest';
import { XA } from './helpers/load.js';

const { validateSettings, applyPreset } = XA.settings;
const { DEFAULT_SETTINGS, PRESETS } = XA.defaults;

describe('settings validation', () => {
  it('matches the documented defaults contract', () => {
    expect(DEFAULT_SETTINGS.preset).toBe('balanced');
    expect(DEFAULT_SETTINGS.randomize).toBe(true);
    expect(DEFAULT_SETTINGS.tickDelayMinMs).toBe(1400);
    expect(DEFAULT_SETTINGS.tickDelayMaxMs).toBe(5200);
    expect(DEFAULT_SETTINGS.scrollMinPx).toBe(320);
    expect(DEFAULT_SETTINGS.scrollMaxPx).toBe(980);
    expect(DEFAULT_SETTINGS.restEveryPosts).toBe(65);
    expect(DEFAULT_SETTINGS.restCountJitterPercent).toBe(30);
    expect(DEFAULT_SETTINGS.restMinMs).toBe(18000);
    expect(DEFAULT_SETTINGS.restMaxMs).toBe(55000);
    expect(DEFAULT_SETTINGS.readingPauseChancePercent).toBe(8);
    expect(DEFAULT_SETTINGS.readingPauseMinMs).toBe(7000);
    expect(DEFAULT_SETTINGS.readingPauseMaxMs).toBe(24000);
    expect(DEFAULT_SETTINGS.backtrackChancePercent).toBe(4);
    expect(DEFAULT_SETTINGS.smoothScroll).toBe(true);
    expect(DEFAULT_SETTINGS.continueWhenHidden).toBe(false);
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
    const { settings: jit } = validateSettings({ restCountJitterPercent: 10 }, { preset: 'balanced' });
    expect(jit.preset).toBe('custom');
  });

  it('presets carry the exact documented pacing values', () => {
    expect(PRESETS.balanced).toMatchObject({
      tickDelayMinMs: 1400, tickDelayMaxMs: 5200,
      scrollMinPx: 320, scrollMaxPx: 980,
      restEveryPosts: 65, restCountJitterPercent: 30,
      restMinMs: 18000, restMaxMs: 55000,
      readingPauseChancePercent: 8, readingPauseMinMs: 7000, readingPauseMaxMs: 24000,
      backtrackChancePercent: 4,
      stallTimeoutMs: 120000, stallRecoveryAttempts: 2
    });
    expect(PRESETS.gentle).toMatchObject({
      tickDelayMinMs: 2500, tickDelayMaxMs: 7500,
      scrollMinPx: 240, scrollMaxPx: 760,
      restEveryPosts: 45, restCountJitterPercent: 35,
      restMinMs: 30000, restMaxMs: 90000,
      readingPauseChancePercent: 12, readingPauseMinMs: 10000, readingPauseMaxMs: 35000,
      backtrackChancePercent: 5,
      stallTimeoutMs: 150000, stallRecoveryAttempts: 2
    });
    expect(PRESETS.fast).toMatchObject({
      tickDelayMinMs: 800, tickDelayMaxMs: 2400,
      scrollMinPx: 650, scrollMaxPx: 1250,
      restEveryPosts: 110, restCountJitterPercent: 20,
      restMinMs: 12000, restMaxMs: 30000,
      readingPauseChancePercent: 3, readingPauseMinMs: 5000, readingPauseMaxMs: 12000,
      backtrackChancePercent: 2,
      stallTimeoutMs: 90000, stallRecoveryAttempts: 1
    });
  });

  it('validates the new pacing ranges and swaps the reading-pause pair', () => {
    const { settings, errors } = validateSettings({
      restCountJitterPercent: 99,
      readingPauseChancePercent: 80,
      backtrackChancePercent: 40,
      readingPauseMinMs: 500,
      readingPauseMaxMs: 999999
    });
    expect(settings.restCountJitterPercent).toBe(75);
    expect(settings.readingPauseChancePercent).toBe(50);
    expect(settings.backtrackChancePercent).toBe(25);
    expect(errors.restCountJitterPercent).toMatch(/clamp/i);
    expect(errors.readingPauseChancePercent).toMatch(/clamp/i);
    expect(errors.backtrackChancePercent).toMatch(/clamp/i);
    expect(settings.readingPauseMinMs).toBe(1000);
    expect(settings.readingPauseMaxMs).toBe(120000);
    const swapped = validateSettings({ readingPauseMinMs: 9000, readingPauseMaxMs: 3000 });
    expect(swapped.settings.readingPauseMinMs).toBe(3000);
    expect(swapped.settings.readingPauseMaxMs).toBe(9000);
    expect(swapped.errors.readingPauseMaxMs).toBeTruthy();
  });

  it('treats smoothScroll and continueWhenHidden as booleans', () => {
    const { settings } = validateSettings({ smoothScroll: '', continueWhenHidden: 1 });
    expect(settings.smoothScroll).toBe(false);
    expect(settings.continueWhenHidden).toBe(true);
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
