import '../shared/util.js';
import '../shared/messages.js';
import '../shared/defaults.js';

const XA = globalThis.XArchive;
const M = XA.messages.MSG;

const $ = (id) => document.getElementById(id);

const SOURCE_LABELS = {
  profile: 'Profile', bookmarks: 'Bookmarks', list: 'List', search: 'Search',
  timeline: 'Timeline', status: 'Thread page', unsupported: 'Unsupported'
};

let ctx = null;
let tabId = null;

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

async function refresh() {
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
  render();
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
}

wire();
refresh();
