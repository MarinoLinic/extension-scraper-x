import '../shared/util.js';
import '../shared/messages.js';
import '../shared/defaults.js';
import '../shared/settings.js';

const XA = globalThis.XArchive;
const M = XA.messages.MSG;

const $ = (id) => document.getElementById(id);

const SOURCE_LABELS = {
  profile: 'Profile', bookmarks: 'Bookmarks', list: 'List', search: 'Search',
  timeline: 'Timeline', status: 'Thread page', unsupported: 'Unsupported'
};

let ctx = null;
let tabId = null;
let quickSettings = null;
let quickInit = false;

function send(msg) {
  return chrome.runtime.sendMessage(msg);
}

async function activeTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs && tabs[0];
}

function setStatus(text) {
  $('xar-status').textContent = text || '';
}

function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleTimeString();
}

function render() {
  if (!ctx) return;
  const { source, controller, run } = ctx;
  $('xar-src-icon').textContent = '';
  $('xar-src-icon').className = 'xar-dot ' + (source.supported ? 'ok' : 'bad');
  $('xar-src-kind').textContent = SOURCE_LABELS[source.type] || '';
  $('xar-src-label').textContent = source.label || 'Unsupported page';
  $('xar-src-sub').textContent = source.supported
    ? (source.key || '') : (source.reason || '');
  $('xar-unsupported').hidden = source.supported;
  if (!source.supported) $('xar-unsupported').textContent = source.reason || 'This page cannot be archived.';

  const state = (controller && controller.state) || (run && run.state) || 'idle';
  const badge = $('xar-state');
  badge.textContent = state;
  badge.className = 'xar-badge ' + state;

  const hasRun = !!run;
  $('xar-progress').hidden = !hasRun && state === 'idle';
  const posts = controller && controller.posts != null ? controller.posts : (run && run.stats && run.stats.posts) || 0;
  $('xar-count').textContent = String(posts);
  const elapsed = controller && controller.activeElapsedMs != null
    ? controller.activeElapsedMs
    : (run && run.runtime && run.runtime.activeElapsedMs) || 0;
  $('xar-elapsed').textContent = XA.util.formatDuration(elapsed);
  const restMs = controller && controller.restRemainingMs;
  $('xar-rest-row').hidden = !(state === 'resting' && restMs);
  if (restMs) $('xar-rest').textContent = XA.util.formatDuration(restMs);
  $('xar-saved').textContent = run && run.runtime && run.runtime.lastSavedAt
    ? fmtTime(run.runtime.lastSavedAt) : '—';
  $('xar-stopreason').textContent = (run && run.stopReason) || '—';
  const msg = (controller && controller.message) || '';
  $('xar-msg').hidden = !msg;
  if (msg) $('xar-msg').textContent = msg;

  const canStart = source.supported && (state === 'idle' || !hasRun);
  const active = state === 'running' || state === 'resting';
  $('xar-start').disabled = !canStart;
  $('xar-pause').disabled = !active;
  $('xar-resume').disabled = !(hasRun && (state === 'paused' || (run && ['paused', 'running', 'resting'].includes(run.state) && !active)));
  $('xar-stop').disabled = !(hasRun && (active || state === 'paused'));
  $('xar-export').disabled = !hasRun;
  $('xar-mediazip').hidden = !hasRun;
  $('xar-mediazip').disabled = !hasRun;
}

let refreshing = false;
let refreshTimer = null;

async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    const tab = await activeTab();
    if (!tab) { setStatus('No active tab'); return; }
    tabId = tab.id;
    try {
      ctx = await send({ type: M.GET_TAB_CONTEXT, tabId });
    } catch (e) {
      ctx = null;
      setStatus('Could not reach the extension worker: ' + e.message);
      return;
    }
    if (!ctx || !ctx.ok) {
      setStatus((ctx && ctx.error) || 'No context');
      return;
    }
    if (!quickInit) {
      quickInit = true;
      await initQuickSettings();
    }
    render();
  } finally {
    refreshing = false;
  }
}

function startRefreshLoop() {
  if (refreshTimer) return;
  refreshTimer = setInterval(() => { refresh(); }, 1000);
  window.addEventListener('unload', () => {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }, { once: true });
}

function populatePresetSelect() {
  const sel = $('xar-q-preset');
  sel.textContent = '';
  for (const key of Object.keys(XA.defaults.PRESETS)) {
    const opt = document.createElement('option');
    opt.value = key;
    opt.textContent = XA.defaults.PRESETS[key].label || key;
    sel.appendChild(opt);
  }
}

function fillQuickForm(s) {
  quickSettings = Object.assign({}, s, { media: Object.assign({}, (s && s.media) || {}) });
  $('xar-q-preset').value = s.preset || 'balanced';
  $('xar-q-max-minutes').value = s.maxActiveDurationMs == null ? '' : Math.round(s.maxActiveDurationMs / 60000);
  $('xar-q-max-posts').value = s.maxPosts == null ? '' : s.maxPosts;
  $('xar-q-oldest-date').value = s.oldestDate || '';
  $('xar-q-fmt-json').checked = (s.exportFormats || []).includes('json');
  $('xar-q-fmt-html').checked = (s.exportFormats || []).includes('html');
  $('xar-q-snapshot').value = s.snapshotEveryPosts == null ? '' : s.snapshotEveryPosts;
  $('xar-q-filename').value = s.filenameTemplate || '';
  $('xar-q-mediazip').checked = !!s.autoMediaZip;
}

async function initQuickSettings() {
  populatePresetSelect();
  let s = ctx && ctx.settings;
  if (!s) {
    try {
      s = (await send({ type: M.GET_SETTINGS })).settings;
    } catch (_) {
      s = null;
    }
  }
  fillQuickForm(s || XA.defaults.DEFAULT_SETTINGS);
}

function setQuickStatus(text) {
  $('xar-q-status').textContent = text || '';
}

async function saveQuickSettings() {
  const formats = [];
  if ($('xar-q-fmt-json').checked) formats.push('json');
  if ($('xar-q-fmt-html').checked) formats.push('html');
  if (!formats.length) {
    setQuickStatus('Pick at least one export format');
    return;
  }
  let next = Object.assign({}, quickSettings || XA.defaults.DEFAULT_SETTINGS);
  next.media = Object.assign({}, next.media || {});
  next.exportFormats = (next.exportFormats || []).slice();
  const preset = $('xar-q-preset').value;
  if (preset !== next.preset) next = XA.settings.applyPreset(next, preset);

  const minutes = $('xar-q-max-minutes').value;
  next.maxActiveDurationMs = minutes === '' ? null : Math.round(Number(minutes) * 60000);
  const maxPosts = $('xar-q-max-posts').value;
  next.maxPosts = maxPosts === '' ? null : Number(maxPosts);
  next.oldestDate = $('xar-q-oldest-date').value || null;
  next.exportFormats = formats;
  const snap = $('xar-q-snapshot').value;
  next.snapshotEveryPosts = snap === '' ? null : Number(snap);
  next.filenameTemplate = $('xar-q-filename').value;
  next.autoMediaZip = $('xar-q-mediazip').checked;

  let mediaDenied = false;
  if (next.autoMediaZip && !(await ensureMediaPermission())) {
    next.autoMediaZip = false;
    mediaDenied = true;
  }
  const resp = await send({ type: M.SAVE_SETTINGS, settings: next });
  if (resp && resp.ok) {
    fillQuickForm(resp.settings);
    const errs = resp.errors && Object.keys(resp.errors).length
      ? ' — ' + Object.values(resp.errors).join('; ') : '';
    setQuickStatus((mediaDenied
      ? 'Saved — media permission denied, media ZIP stays off' : 'Saved') + errs);
  } else {
    setQuickStatus('Save failed');
  }
  setTimeout(() => setQuickStatus(''), 5000);
}

async function resetQuickSettings() {
  const d = XA.defaults.DEFAULT_SETTINGS;
  const next = Object.assign({}, d, {
    media: Object.assign({}, d.media),
    exportFormats: (d.exportFormats || []).slice()
  });
  const resp = await send({ type: M.SAVE_SETTINGS, settings: next });
  if (resp && resp.ok) {
    fillQuickForm(resp.settings);
    setQuickStatus('Reset to defaults');
  } else {
    setQuickStatus('Reset failed');
  }
  setTimeout(() => setQuickStatus(''), 5000);
}

async function ensureMediaPermission() {
  try {
    const has = await chrome.permissions.contains({ origins: ['https://pbs.twimg.com/*'] });
    if (has) return true;
    return await chrome.permissions.request({ origins: ['https://pbs.twimg.com/*'] });
  } catch (_) {
    return false;
  }
}

function wire() {
  $('xar-start').addEventListener('click', async () => {
    if (!ctx || !ctx.source.supported) return;
    setStatus('Starting…');
    const settings = (await send({ type: M.GET_SETTINGS })).settings;
    const resp = await send({ type: M.START_RUN, tabId, source: ctx.source, settings });
    setStatus(resp && resp.ok ? 'Run started' : (resp && resp.error) || 'Failed to start');
    await refresh();
  });
  $('xar-pause').addEventListener('click', async () => {
    if (!ctx.run) return;
    await send({ type: M.PAUSE_RUN, runId: ctx.run.id });
    await refresh();
  });
  $('xar-resume').addEventListener('click', async () => {
    if (!ctx.run) return;
    const resp = await send({ type: M.RESUME_RUN, runId: ctx.run.id, tabId });
    setStatus(resp && resp.ok ? '' : (resp && resp.error) || 'Resume failed');
    await refresh();
  });
  $('xar-stop').addEventListener('click', async () => {
    if (!ctx.run) return;
    await send({ type: M.STOP_RUN, runId: ctx.run.id });
    await refresh();
  });
  $('xar-export').addEventListener('click', async () => {
    if (!ctx.run) return;
    setStatus('Exporting…');
    const formats = (await send({ type: M.GET_SETTINGS })).settings.exportFormats;
    const resp = await send({ type: M.EXPORT_RUN, runId: ctx.run.id, formats, media: false });
    setStatus(resp && resp.ok ? 'Exported: ' + (resp.files || []).join(', ')
      : (resp && resp.error) || 'Export failed');
    await refresh();
  });
  $('xar-mediazip').addEventListener('click', async () => {
    if (!ctx.run) return;
    setStatus('Checking media permission…');
    if (!(await ensureMediaPermission())) {
      setStatus('Media permission denied — ZIP needs access to pbs.twimg.com images');
      return;
    }
    setStatus('Building media ZIP…');
    const resp = await send({ type: M.EXPORT_RUN, runId: ctx.run.id, formats: ['mediazip'], media: true });
    if (resp && resp.ok) {
      const s = resp.mediaSummary;
      setStatus('Media ZIP saved' + (s ? ' (' + s.downloaded + '/' + s.total + ' images' +
        (s.failed ? ', ' + s.failed + ' failed' : '') + ')' : ''));
    } else {
      setStatus((resp && resp.error) || 'Media ZIP failed');
    }
    await refresh();
  });
  $('xar-archives').addEventListener('click', async () => {
    await send({ type: M.OPEN_ARCHIVE_PAGE, runId: ctx.run ? ctx.run.id : null });
  });
  $('xar-settings').addEventListener('click', () => chrome.runtime.openOptionsPage());
  $('xar-q-save').addEventListener('click', () => { saveQuickSettings().catch(() => setQuickStatus('Save failed')); });
  $('xar-q-reset').addEventListener('click', () => { resetQuickSettings().catch(() => setQuickStatus('Reset failed')); });
}

wire();
populatePresetSelect();
refresh();
startRefreshLoop();
