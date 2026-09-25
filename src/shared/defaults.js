(function () {
  'use strict';
  const XA = (globalThis.XArchive = globalThis.XArchive || {});

  const DEFAULT_SETTINGS = {
    preset: 'balanced',
    randomize: true,

    tickDelayMinMs: 1400,
    tickDelayMaxMs: 5200,
    scrollMinPx: 320,
    scrollMaxPx: 980,
    restEveryPosts: 65,
    restCountJitterPercent: 30,
    restMinMs: 18000,
    restMaxMs: 55000,
    readingPauseChancePercent: 8,
    readingPauseMinMs: 7000,
    readingPauseMaxMs: 24000,
    backtrackChancePercent: 4,
    smoothScroll: true,
    continueWhenHidden: false,
    stallTimeoutMs: 120000,
    stallRecoveryAttempts: 2,

    maxActiveDurationMs: null,
    maxPosts: null,
    oldestDate: null,

    autoScroll: true,
    autoExpandText: true,
    autoResume: true,
    showOverlay: true,
    showBadge: true,

    autoExportOnComplete: true,
    exportFormats: ['json', 'html'],
    snapshotEveryPosts: null,
    jsonFormat: 'envelope',
    saveAs: false,
    filenameTemplate: 'x_%type_%handle_%date_%num',

    autoMediaZip: false,
    media: {
      postImages: true,
      quotedImages: true,
      cardImages: false,
      avatars: false
    }
  };

  const PRESETS = {
    gentle: {
      label: 'Gentle',
      tickDelayMinMs: 2500, tickDelayMaxMs: 7500,
      scrollMinPx: 240, scrollMaxPx: 760,
      restEveryPosts: 45, restCountJitterPercent: 35,
      restMinMs: 30000, restMaxMs: 90000,
      readingPauseChancePercent: 12, readingPauseMinMs: 10000, readingPauseMaxMs: 35000,
      backtrackChancePercent: 5,
      stallTimeoutMs: 150000, stallRecoveryAttempts: 2
    },
    balanced: {
      label: 'Balanced',
      tickDelayMinMs: 1400, tickDelayMaxMs: 5200,
      scrollMinPx: 320, scrollMaxPx: 980,
      restEveryPosts: 65, restCountJitterPercent: 30,
      restMinMs: 18000, restMaxMs: 55000,
      readingPauseChancePercent: 8, readingPauseMinMs: 7000, readingPauseMaxMs: 24000,
      backtrackChancePercent: 4,
      stallTimeoutMs: 120000, stallRecoveryAttempts: 2
    },
    fast: {
      label: 'Fast',
      tickDelayMinMs: 800, tickDelayMaxMs: 2400,
      scrollMinPx: 650, scrollMaxPx: 1250,
      restEveryPosts: 110, restCountJitterPercent: 20,
      restMinMs: 12000, restMaxMs: 30000,
      readingPauseChancePercent: 3, readingPauseMinMs: 5000, readingPauseMaxMs: 12000,
      backtrackChancePercent: 2,
      stallTimeoutMs: 90000, stallRecoveryAttempts: 1,
      warning: 'Aggressive timing increases the chance of rate limiting and missed posts.'
    },
    custom: { label: 'Custom' }
  };

  const STORAGE_KEY_SETTINGS = 'xarchive.settings';
  const STORAGE_KEY_UI = 'xarchive.ui';

  const FILENAME_TOKENS = [
    '%type', '%source', '%handle', '%title', '%tab',
    '%date', '%time', '%datetime', '%num', '%run', '%ext'
  ];

  XA.defaults = {
    DEFAULT_SETTINGS, PRESETS, STORAGE_KEY_SETTINGS, STORAGE_KEY_UI, FILENAME_TOKENS
  };
})();
