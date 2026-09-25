(function () {
  'use strict';
  const XA = (globalThis.XArchive = globalThis.XArchive || {});

  const DEFAULT_SETTINGS = {
    preset: 'balanced',
    randomize: true,

    tickDelayMinMs: 3000,
    tickDelayMaxMs: 6000,
    scrollMinPx: 650,
    scrollMaxPx: 1150,
    restEveryPosts: 80,
    restMinMs: 20000,
    restMaxMs: 28000,
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
      tickDelayMinMs: 5000, tickDelayMaxMs: 9000,
      scrollMinPx: 400, scrollMaxPx: 800,
      restEveryPosts: 50, restMinMs: 30000, restMaxMs: 45000,
      stallTimeoutMs: 120000, stallRecoveryAttempts: 2
    },
    balanced: {
      label: 'Balanced',
      tickDelayMinMs: 3000, tickDelayMaxMs: 6000,
      scrollMinPx: 650, scrollMaxPx: 1150,
      restEveryPosts: 80, restMinMs: 20000, restMaxMs: 28000,
      stallTimeoutMs: 120000, stallRecoveryAttempts: 2
    },
    fast: {
      label: 'Fast',
      tickDelayMinMs: 1500, tickDelayMaxMs: 3000,
      scrollMinPx: 900, scrollMaxPx: 1500,
      restEveryPosts: 150, restMinMs: 12000, restMaxMs: 18000,
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
