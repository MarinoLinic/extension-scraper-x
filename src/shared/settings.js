(function () {
  'use strict';
  const XA = (globalThis.XArchive = globalThis.XArchive || {});

  const { DEFAULT_SETTINGS, PRESETS, STORAGE_KEY_SETTINGS } = XA.defaults;

  const NUMERIC_RANGES = {
    tickDelayMinMs: [250, 120000],
    tickDelayMaxMs: [250, 120000],
    scrollMinPx: [50, 5000],
    scrollMaxPx: [50, 5000],
    restEveryPosts: [5, 5000],
    restMinMs: [1000, 600000],
    restMaxMs: [1000, 600000],
    stallTimeoutMs: [10000, 600000],
    stallRecoveryAttempts: [0, 10],
    maxPosts: [1, 1000000],
    snapshotEveryPosts: [10, 100000]
  };

  const PAIRS = [
    ['tickDelayMinMs', 'tickDelayMaxMs'],
    ['scrollMinPx', 'scrollMaxPx'],
    ['restMinMs', 'restMaxMs']
  ];

  const BOOL_KEYS = [
    'randomize', 'autoScroll', 'autoExpandText', 'autoResume',
    'showOverlay', 'showBadge', 'autoExportOnComplete', 'saveAs', 'autoMediaZip'
  ];

  const PRESET_FIELDS = [
    'tickDelayMinMs', 'tickDelayMaxMs', 'scrollMinPx', 'scrollMaxPx',
    'restEveryPosts', 'restMinMs', 'restMaxMs',
    'stallTimeoutMs', 'stallRecoveryAttempts'
  ];

  function isNum(v) { return typeof v === 'number' && Number.isFinite(v); }

  function validateSettings(input, base) {
    const errors = {};
    const settings = Object.assign({}, DEFAULT_SETTINGS, base || {});
    const src = input || {};

    if (src.preset != null) {
      if (PRESETS[src.preset]) settings.preset = src.preset;
      else { errors.preset = 'Unknown preset "' + src.preset + '"'; }
    }

    for (const [key, [lo, hi]] of Object.entries(NUMERIC_RANGES)) {
      if (src[key] === undefined) continue;
      const v = src[key];
      if (v === null || v === '') {
        if (key === 'maxPosts' || key === 'snapshotEveryPosts') {
          settings[key] = null;
        } else {
          errors[key] = 'A number between ' + lo + ' and ' + hi + ' is required';
        }
        continue;
      }
      const n = Number(v);
      if (!isNum(n)) { errors[key] = 'Must be a number'; continue; }
      const clamped = Math.min(hi, Math.max(lo, Math.round(n)));
      if (clamped !== n) errors[key] = 'Clamped to ' + clamped + ' (allowed ' + lo + '–' + hi + ')';
      settings[key] = clamped;
    }

    if (src.maxActiveDurationMs !== undefined) {
      const v = src.maxActiveDurationMs;
      if (v === null || v === '' || v === 0) settings.maxActiveDurationMs = null;
      else if (isNum(Number(v)) && Number(v) >= 60000) settings.maxActiveDurationMs = Math.round(Number(v));
      else errors.maxActiveDurationMs = 'Use at least 60000 ms (1 minute) or leave empty for no limit';
    }

    if (src.oldestDate !== undefined) {
      const v = src.oldestDate;
      if (v === null || v === '') settings.oldestDate = null;
      else if (/^\d{4}-\d{2}-\d{2}$/.test(String(v)) && !Number.isNaN(Date.parse(v + 'T00:00:00Z'))) {
        settings.oldestDate = String(v);
      } else errors.oldestDate = 'Use YYYY-MM-DD or leave empty for no limit';
    }

    for (const key of BOOL_KEYS) {
      if (src[key] !== undefined) settings[key] = !!src[key];
    }

    if (src.exportFormats !== undefined) {
      const fmts = (Array.isArray(src.exportFormats) ? src.exportFormats : [])
        .filter((f) => f === 'json' || f === 'html');
      if (fmts.length === 0) errors.exportFormats = 'Pick at least one export format';
      else settings.exportFormats = fmts;
    }

    if (src.jsonFormat !== undefined) {
      if (src.jsonFormat === 'envelope' || src.jsonFormat === 'legacy') settings.jsonFormat = src.jsonFormat;
      else errors.jsonFormat = 'Must be "envelope" or "legacy"';
    }

    if (src.filenameTemplate !== undefined) {
      const t = String(src.filenameTemplate).trim();
      if (!t) errors.filenameTemplate = 'Template may not be empty';
      else if (t.length > 200) errors.filenameTemplate = 'Template is too long (200 chars max)';
      else settings.filenameTemplate = t;
    }

    if (src.media !== undefined) {
      const m = src.media || {};
      settings.media = {
        postImages: m.postImages !== undefined ? !!m.postImages : settings.media.postImages,
        quotedImages: m.quotedImages !== undefined ? !!m.quotedImages : settings.media.quotedImages,
        cardImages: m.cardImages !== undefined ? !!m.cardImages : settings.media.cardImages,
        avatars: m.avatars !== undefined ? !!m.avatars : settings.media.avatars
      };
    }

    for (const [loKey, hiKey] of PAIRS) {
      if (settings[loKey] > settings[hiKey]) {
        const tmp = settings[loKey];
        settings[loKey] = settings[hiKey];
        settings[hiKey] = tmp;
        errors[hiKey] = 'Min was greater than max — values were swapped';
      }
    }

    const activePreset = PRESETS[settings.preset];
    if (settings.preset !== 'custom' && activePreset) {
      const differs = PRESET_FIELDS.some((f) => settings[f] !== activePreset[f]);
      if (differs) settings.preset = 'custom';
    }

    return { settings, errors, valid: Object.keys(errors).length === 0 };
  }

  function applyPreset(settings, presetName) {
    const p = PRESETS[presetName];
    const out = Object.assign({}, settings);
    if (!p) return out;
    out.preset = presetName;
    if (presetName === 'custom') return out;
    for (const f of PRESET_FIELDS) {
      if (p[f] !== undefined) out[f] = p[f];
    }
    return out;
  }

  function presetWarning(settings) {
    const p = PRESETS[settings.preset];
    return (p && p.warning) || null;
  }

  function storageArea() {
    return (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) || null;
  }

  async function loadSettings() {
    const area = storageArea();
    if (!area) return Object.assign({}, DEFAULT_SETTINGS);
    const got = await area.get(STORAGE_KEY_SETTINGS);
    const saved = got[STORAGE_KEY_SETTINGS];
    if (!saved || typeof saved !== 'object') return Object.assign({}, DEFAULT_SETTINGS);
    const merged = Object.assign({}, DEFAULT_SETTINGS, saved);
    merged.media = Object.assign({}, DEFAULT_SETTINGS.media, saved.media || {});
    return merged;
  }

  async function saveSettings(settings) {
    const area = storageArea();
    if (!area) return false;
    await area.set({ [STORAGE_KEY_SETTINGS]: settings });
    return true;
  }

  async function loadUiPrefs() {
    const area = storageArea();
    if (!area) return {};
    const got = await area.get(XA.defaults.STORAGE_KEY_UI);
    return got[XA.defaults.STORAGE_KEY_UI] || {};
  }

  async function saveUiPrefs(prefs) {
    const area = storageArea();
    if (!area) return false;
    const cur = await loadUiPrefs();
    await area.set({ [XA.defaults.STORAGE_KEY_UI]: Object.assign({}, cur, prefs) });
    return true;
  }

  XA.settings = {
    NUMERIC_RANGES, PRESET_FIELDS, BOOL_KEYS,
    validateSettings, applyPreset, presetWarning,
    loadSettings, saveSettings, loadUiPrefs, saveUiPrefs
  };
})();
