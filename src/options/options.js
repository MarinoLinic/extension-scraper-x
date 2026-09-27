import '../shared/util.js';
import '../shared/messages.js';
import '../shared/defaults.js';
import '../shared/settings.js';
import '../shared/filename.js';
import '../shared/post-model.js';

const XA = globalThis.XArchive;
const M = XA.messages.MSG;
const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

let currentSettings = null;
let selectedRunId = null;
let jobPollTimer = null;

const FIELD_GROUPS = [
  {
    title: 'Pacing preset',
    fields: [
      { key: 'preset', kind: 'select', label: 'Preset', options: ['gentle', 'balanced', 'brisk', 'fast', 'turbo', 'custom'],
        desc: 'Gentle is slowest and safest; Brisk and Fast are quicker; Turbo is very aggressive and may miss posts or hit limits. Editing a timing field switches the preset to Custom.' },
      { key: 'randomize', kind: 'check', label: 'Randomize delays and scroll distance',
        desc: 'Adds jitter so scrolling does not look robotic. Off = fixed midpoints.' }
    ]
  },
  {
    title: 'Timing',
    fields: [
      { key: 'tickDelayMinMs', kind: 'number', label: 'Tick delay min (ms)', range: [250, 120000],
        desc: 'Shortest pause between scrape cycles. Default 1400.' },
      { key: 'tickDelayMaxMs', kind: 'number', label: 'Tick delay max (ms)', range: [250, 120000],
        desc: 'Longest pause between scrape cycles. Default 5200.' },
      { key: 'scrollMinPx', kind: 'number', label: 'Scroll min (px)', range: [50, 5000],
        desc: 'Smallest scroll step per tick. Default 320.' },
      { key: 'scrollMaxPx', kind: 'number', label: 'Scroll max (px)', range: [50, 5000],
        desc: 'Largest scroll step per tick. Default 980.' },
      { key: 'restEveryPosts', kind: 'number', label: 'Rest every N new posts (average)', range: [5, 5000],
        desc: 'Center of the break schedule — with Randomize on, the actual threshold jitters around this value instead of being exactly periodic. Default 65.' },
      { key: 'restCountJitterPercent', kind: 'number', label: 'Rest threshold jitter (%)', range: [0, 75],
        desc: 'How far the per-run rest threshold may wander above or below the average. 0 = exactly every N posts. Default 30.' },
      { key: 'restMinMs', kind: 'number', label: 'Rest min (ms)', range: [1000, 600000],
        desc: 'Shortest scheduled break. Default 18000.' },
      { key: 'restMaxMs', kind: 'number', label: 'Rest max (ms)', range: [1000, 600000],
        desc: 'Longest scheduled break. Default 55000.' },
      { key: 'readingPauseChancePercent', kind: 'number', label: 'Reading pause chance (%)', range: [0, 50],
        desc: 'Chance that a tick adds an extra delay, as if you stopped to read. Default 8.' },
      { key: 'readingPauseMinMs', kind: 'number', label: 'Reading pause min (ms)', range: [1000, 120000],
        desc: 'Shortest extra reading pause when one occurs. Default 7000.' },
      { key: 'readingPauseMaxMs', kind: 'number', label: 'Reading pause max (ms)', range: [1000, 120000],
        desc: 'Longest extra reading pause when one occurs. Default 24000.' },
      { key: 'backtrackChancePercent', kind: 'number', label: 'Backtrack chance (%)', range: [0, 25],
        desc: 'Rare chance a downward scroll instead nudges back up a little, like re-checking a post. Default 4.' },
      { key: 'stallTimeoutMs', kind: 'number', label: 'Stall timeout (ms)', range: [10000, 600000],
        desc: 'How long the timeline may produce nothing new (while the tab is visible) before the run gives up or completes. Default 120000.' },
      { key: 'stallRecoveryAttempts', kind: 'number', label: 'Stall recovery attempts', range: [0, 10],
        desc: 'Scroll nudges tried before declaring the bottom reached. Default 2.' }
    ]
  },
  {
    title: 'Limits (leave empty for no limit)',
    fields: [
      { key: 'maxActiveDurationMs', kind: 'minutes', label: 'Max active duration (minutes)',
        desc: 'Stops after this much active time. Manual pauses do not count; scheduled rests do.' },
      { key: 'maxPosts', kind: 'number', label: 'Max posts', range: [1, 1000000],
        desc: 'Stops after this many unique posts.' },
      { key: 'oldestDate', kind: 'date', label: 'Oldest date',
        desc: 'Stops when a post older than this date is captured.' }
    ]
  },
  {
    title: 'Behavior',
    fields: [
      { key: 'autoScroll', kind: 'check', label: 'Auto-scroll the timeline' },
      { key: 'autoExpandText', kind: 'check', label: 'Expand "Show more" text automatically' },
      { key: 'autoResume', kind: 'check', label: 'Auto-resume after reloading the same source',
        desc: 'If a run was interrupted by a reload or navigation, continue it when the same source is detected again.' },
      { key: 'smoothScroll', kind: 'check', label: 'Smooth scrolling while visible',
        desc: 'Uses native smooth scrolling while the tab is visible; instant jumps while hidden or when off.' },
      { key: 'continueWhenHidden', kind: 'check', label: 'Continue in hidden tabs (best effort)',
        desc: 'Off by default. Chrome throttles hidden timers and X may stop rendering, so capture can be slow or incomplete.' },
      { key: 'showOverlay', kind: 'check', label: 'Show the in-page progress panel' },
      { key: 'showBadge', kind: 'check', label: 'Show the toolbar badge' }
    ]
  },
  {
    title: 'Save & export',
    fields: [
      { key: 'autoExportOnComplete', kind: 'check', label: 'Auto-export when a run completes or is stopped' },
      { key: 'exportFormats', kind: 'formats', label: 'Export formats', desc: 'JSON and/or HTML downloaded after a run or via the Export button.' },
      { key: 'snapshotEveryPosts', kind: 'number', label: 'Snapshot download every N posts', range: [10, 100000],
        desc: 'Optional extra downloaded snapshots mid-run — off by default to avoid file spam. Internal checkpoints are always on regardless.' },
      { key: 'saveAs', kind: 'check', label: 'Ask where to save each download' },
      { key: 'filenameTemplate', kind: 'text', label: 'Filename template',
        desc: 'Tokens: %type %source %handle %title %tab %date %time %datetime %num %run %ext' }
    ]
  },
  {
    title: 'Media downloads',
    fields: [
      { key: 'autoMediaZip', kind: 'check', label: 'Download a media ZIP after the final export',
        desc: 'Off by default. Saving with this on asks for optional access to pbs.twimg.com; if denied it stays off.' },
      { key: 'media.postImages', kind: 'check', label: 'ZIP: post photos' },
      { key: 'media.quotedImages', kind: 'check', label: 'ZIP: quoted post photos' },
      { key: 'media.cardImages', kind: 'check', label: 'ZIP: link-card images' },
      { key: 'media.avatars', kind: 'check', label: 'ZIP: author avatars' }
    ]
  }
];

function send(msg) { return chrome.runtime.sendMessage(msg); }

function fieldValue(f) {
  const input = $('f-' + f.key);
  if (!input) return undefined;
  if (f.kind === 'check') return input.checked;
  if (f.kind === 'minutes') {
    if (input.value === '') return null;
    const v = Number(input.value);
    return Number.isFinite(v) && v > 0 ? Math.round(v * 60000) : null;
  }
  if (f.kind === 'number') {
    if (input.value === '') return null;
    const v = Number(input.value);
    return Number.isFinite(v) ? v : input.value;
  }
  if (f.kind === 'date') return input.value || null;
  return input.value;
}

function collectForm() {
  const out = { media: {} };
  for (const g of FIELD_GROUPS) {
    for (const f of g.fields) {
      if (f.kind === 'formats') {
        const fmts = [];
        if ($('f-fmt-json').checked) fmts.push('json');
        if ($('f-fmt-html').checked) fmts.push('html');
        out.exportFormats = fmts;
        continue;
      }
      if (f.key.startsWith('media.')) {
        out.media[f.key.slice(6)] = fieldValue(f);
        continue;
      }
      const v = fieldValue(f);
      if (v !== undefined) out[f.key] = v;
    }
  }
  return out;
}

function fillForm(s) {
  currentSettings = s;
  for (const g of FIELD_GROUPS) {
    for (const f of g.fields) {
      if (f.kind === 'formats') {
        $('f-fmt-json').checked = (s.exportFormats || []).includes('json');
        $('f-fmt-html').checked = (s.exportFormats || []).includes('html');
        continue;
      }
      const input = $('f-' + f.key);
      if (!input) continue;
      if (f.key.startsWith('media.')) {
        input.checked = !!(s.media && s.media[f.key.slice(6)]);
        continue;
      }
      const v = s[f.key];
      if (f.kind === 'check') input.checked = !!v;
      else if (f.kind === 'minutes') input.value = v == null ? '' : Math.round(v / 60000);
      else input.value = v == null ? '' : v;
    }
  }
  updateFilenamePreview();
}

function updateFilenamePreview() {
  const tpl = ($('f-filenameTemplate') && $('f-filenameTemplate').value) || 'x_%type_%handle_%date_%num';
  const preview = XA.filename.filenameFor({
    template: tpl,
    source: { type: 'profile', label: '@someone posts', handle: 'someone', tab: 'posts', key: 'profile:someone:posts' },
    run: { id: 'run_abc123', stats: { posts: 142 } },
    num: 142, ext: 'json'
  }, true);
  const elx = $('filename-preview');
  if (elx) elx.textContent = 'Preview: ' + preview;
}

function buildSettingsForm() {
  const host = $('settings-form');
  host.textContent = '';
  for (const g of FIELD_GROUPS) {
    host.appendChild(el('h3', null, g.title));
    for (const f of g.fields) {
      const row = el('div', 'field' + (f.kind === 'check' ? ' check' : ''));
      const lab = el('label', null, f.label);
      lab.setAttribute('for', 'f-' + f.key);
      row.appendChild(lab);
      if (f.kind === 'select') {
        const sel = el('select');
        sel.id = 'f-' + f.key;
        for (const opt of f.options) {
          const preset = XA.defaults.PRESETS[opt];
          const label = (f.key === 'preset' && preset && preset.label) || opt;
          sel.appendChild(el('option', null, label)).value = opt;
        }
        row.appendChild(sel);
      } else if (f.kind === 'formats') {
        const wrap = el('span');
        const j = el('input'); j.type = 'checkbox'; j.id = 'f-fmt-json';
        const h = el('input'); h.type = 'checkbox'; h.id = 'f-fmt-html';
        const lj = el('label', null, ' JSON'); lj.prepend(j);
        const lh = el('label', null, ' HTML'); lh.prepend(h);
        wrap.append(lj, ' ', lh);
        row.appendChild(wrap);
      } else {
        const input = el('input');
        input.id = 'f-' + f.key;
        input.type = f.kind === 'check' ? 'checkbox'
          : f.kind === 'date' ? 'date'
          : f.kind === 'text' ? 'text' : 'number';
        if (f.range) { input.min = f.range[0]; input.max = f.range[1]; }
        if (f.kind === 'text') input.style.width = '340px';
        row.appendChild(input);
      }
      const err = el('span', 'err');
      err.id = 'err-' + f.key;
      row.appendChild(err);
      if (f.desc) row.appendChild(el('div', 'desc', f.desc));
      if (f.key === 'filenameTemplate') {
        const pv = el('div', 'desc');
        pv.id = 'filename-preview';
        row.appendChild(pv);
      }
      host.appendChild(row);
    }
  }
  $('f-filenameTemplate').addEventListener('input', updateFilenamePreview);
  $('f-preset').addEventListener('change', (ev) => {
    const presetName = ev.target.value;
    if (presetName !== 'custom' && currentSettings) {
      const formNow = collectForm();
      const base = Object.assign({}, currentSettings, formNow, {
        media: Object.assign({}, currentSettings.media, formNow.media)
      });
      fillForm(XA.settings.applyPreset(base, presetName));
    }
  });
}

function showSettingsErrors(errors) {
  for (const g of FIELD_GROUPS) {
    for (const f of g.fields) {
      const e = $('err-' + f.key);
      if (e) e.textContent = errors[f.key] || '';
    }
  }
}

async function saveSettingsFromForm() {
  const collected = collectForm();
  let mediaDenied = false;
  if (collected.autoMediaZip) {
    try {
      const granted = await chrome.permissions.contains({ origins: ['https://pbs.twimg.com/*'] }) ||
        await chrome.permissions.request({ origins: ['https://pbs.twimg.com/*'] });
      if (!granted) { collected.autoMediaZip = false; mediaDenied = true; }
    } catch (_) {
      collected.autoMediaZip = false;
      mediaDenied = true;
    }
  }
  const resp = await send({ type: M.SAVE_SETTINGS, settings: collected });
  if (resp && resp.ok) {
    currentSettings = resp.settings;
    showSettingsErrors(resp.errors || {});
    fillForm(resp.settings);
    $('settings-status').textContent = (mediaDenied
      ? 'Saved — media permission denied, media ZIP stays off'
      : 'Saved') +
      (resp.errors && Object.keys(resp.errors).length ? ' (see notes on fields)' : '');
  } else {
    $('settings-status').textContent = 'Save failed';
  }
  setTimeout(() => { $('settings-status').textContent = ''; }, 5000);
}

async function loadSettingsIntoForm() {
  const resp = await send({ type: M.GET_SETTINGS });
  fillForm(resp.settings);
}

function switchTab(name) {
  $('view-settings').hidden = name !== 'settings';
  $('view-archives').hidden = name !== 'archives';
  for (const a of document.querySelectorAll('nav a')) {
    a.classList.toggle('active', a.getAttribute('data-tab') === name);
  }
  if (name === 'archives') loadArchives();
}

async function loadArchives() {
  const filters = {};
  const q = $('arch-search').value.trim();
  if (q) filters.search = q;
  if ($('arch-type').value) filters.type = $('arch-type').value;
  if ($('arch-state').value) filters.state = $('arch-state').value;
  const resp = await send({ type: M.LIST_RUNS, filters });
  const runs = (resp && resp.runs) || [];
  const list = $('arch-list');
  list.textContent = '';
  if (!runs.length) {
    list.appendChild(el('p', 'note', 'No archives yet.'));
  }
  for (const run of runs) {
    const item = el('button', 'arch-item' + (run.id === selectedRunId ? ' sel' : ''));
    item.appendChild(el('div', 'lbl', (run.source && run.source.label) || run.id));
    const sub = el('div', 'sub');
    sub.appendChild(el('span', 'state-tag ' + run.state, run.state));
    sub.appendChild(el('span', null, ((run.stats && run.stats.posts) || 0) + ' posts'));
    sub.appendChild(el('span', null, (run.updatedAt || '').slice(0, 16).replace('T', ' ')));
    item.appendChild(sub);
    item.addEventListener('click', () => selectRun(run.id));
    list.appendChild(item);
  }
  const usage = await send({ type: M.GET_STORAGE_USAGE });
  if (usage && usage.estimate && usage.estimate.usage != null) {
    $('arch-usage').textContent =
      'Storage: ' + formatBytes(usage.estimate.usage) +
      (usage.estimate.quota ? ' of ' + formatBytes(usage.estimate.quota) : '');
  } else {
    $('arch-usage').textContent = '';
  }
}

function formatBytes(n) {
  if (n == null) return '?';
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return v.toFixed(v >= 10 || i === 0 ? 0 : 1) + ' ' + units[i];
}

function kv(k, v) {
  const row = el('div', 'kv');
  row.appendChild(el('span', 'k', k));
  row.appendChild(el('span', 'v', v == null || v === '' ? '—' : String(v)));
  return row;
}

async function selectRun(runId) {
  selectedRunId = runId;
  await loadArchives();
  const resp = await send({ type: M.GET_RUN, runId, includePosts: false, includeThreadJobs: false });
  const detail = $('arch-detail');
  detail.textContent = '';
  if (!resp || !resp.ok || !resp.run) {
    detail.appendChild(el('p', 'note', 'Archive not found.'));
    return;
  }
  const run = resp.run;
  detail.appendChild(el('h3', null, (run.source && run.source.label) || run.id));
  detail.appendChild(kv('Run id', run.id));
  detail.appendChild(kv('Source key', run.source && run.source.key));
  detail.appendChild(kv('Source URL', run.source && run.source.sourceUrl));
  detail.appendChild(kv('State', run.state + (run.stopReason ? ' (' + run.stopReason + ')' : '')));
  detail.appendChild(kv('Posts', resp.postCount));
  detail.appendChild(kv('Created', run.createdAt));
  detail.appendChild(kv('Updated', run.updatedAt));
  if (run.completedAt) detail.appendChild(kv('Completed', run.completedAt));
  if (run.imported) detail.appendChild(kv('Imported', 'yes'));
  if ((run.warnings || []).length) {
    const w = el('div', 'warnbox', 'Warnings: ' + run.warnings.join(' · '));
    detail.appendChild(w);
  }

  const settingsDet = el('details', 'run-settings');
  settingsDet.appendChild(el('summary', null, 'Run settings'));
  const settingsPre = el('pre');
  settingsPre.textContent = JSON.stringify(run.settings, null, 2);
  settingsDet.appendChild(settingsPre);
  detail.appendChild(settingsDet);

  const actions = el('div', 'detail-actions');
  const mk = (label, fn, cls) => {
    const b = el('button', cls || '', label);
    b.addEventListener('click', fn);
    actions.appendChild(b);
    return b;
  };
  mk('Export JSON', () => exportRun(run, ['json']));
  mk('Export HTML', () => exportRun(run, ['html']));
  mk('Export both', () => exportRun(run, ['json', 'html']));
  mk('Media ZIP', () => exportMedia(run));
  if (XA.messages.UNFINISHED_STATES.includes(run.state) && run.source && run.source.sourceUrl) {
    mk('Open source to resume', () => chrome.tabs.create({ url: run.source.sourceUrl }));
  }
  mk('Delete', () => deleteRun(run), 'danger');
  detail.appendChild(actions);

  detail.appendChild(el('h3', null, 'Build upon this archive'));
  const jobStatus = await send({ type: M.GET_FULFILLMENT_STATUS, runId, refreshCandidates: true });
  const status = jobStatus || {};
  const jobs = status.jobs || [];
  const card = el('section', 'fulfillment-card');
  card.appendChild(el('p', 'fulfillment-copy',
    'Visit one candidate link at a time in one reused worker window. Changes save locally immediately, and export buttons always download the latest improved version. Cautious pacing lowers request pressure but cannot guarantee against rate limits.'));
  const summary = el('div', 'fulfillment-summary');
  const count = (id, label, value) => {
    const item = el('span', null, label + value);
    item.id = id;
    return item;
  };
  summary.append(
    count('fulfillment-thread-count', 'Thread candidates: ', status.threadCandidates || 0),
    count('fulfillment-quote-count', 'Quoted-post candidates: ', status.quoteCandidates || 0),
    count('fulfillment-missing-count', 'Quote URLs unavailable: ', status.missingQuoteUrls || 0),
    count('fulfillment-done-count', 'Done: ', status.done || 0),
    count('fulfillment-remaining-count', 'Remaining: ', status.remaining || 0),
    count('fulfillment-failure-count', 'Failed / incomplete: ', (status.failed || 0) + ' / ' + (status.incomplete || 0))
  );
  card.appendChild(summary);
  const fulfillment = status.fulfillment;
  const isRunning = !!(fulfillment && fulfillment.state === 'running');
  const isSettling = !!(fulfillment && fulfillment.currentJobId);
  const controls = el('div', 'fulfillment-controls');
  const threadsLabel = el('label', null, 'Threads');
  const threads = el('input'); threads.type = 'checkbox'; threads.checked = true;
  threadsLabel.prepend(threads);
  const quotesLabel = el('label', null, 'Quoted posts');
  const quotes = el('input'); quotes.type = 'checkbox'; quotes.checked = true;
  quotesLabel.prepend(quotes);
  const maxLabel = el('label', null, 'Max links');
  const maxInput = el('input'); maxInput.type = 'number'; maxInput.min = '1'; maxInput.max = '100'; maxInput.value = '10';
  maxLabel.appendChild(maxInput);
  const paceLabel = el('label', null, 'Pace');
  const pace = el('select');
  for (const [value, label] of [['cautious', 'Cautious'], ['balanced', 'Balanced'], ['brisk', 'Brisk']]) {
    const option = el('option', null, label); option.value = value; pace.appendChild(option);
  }
  paceLabel.appendChild(pace);
  controls.append(threadsLabel, quotesLabel, maxLabel, paceLabel);
  threads.disabled = isRunning || isSettling;
  quotes.disabled = isRunning || isSettling;
  maxInput.disabled = isRunning || isSettling;
  pace.disabled = isRunning || isSettling;
  const start = el('button', 'primary');
  start.id = 'fulfillment-start';
  const updateStartLabel = () => {
    const value = Math.min(100, Math.max(1, Math.round(Number(maxInput.value) || 10)));
    start.textContent = 'Build next ' + value + ' links';
  };
  maxInput.addEventListener('input', updateStartLabel);
  updateStartLabel();
  const canStart = ['paused', 'completed', 'limited', 'error'].includes(run.state);
  start.disabled = isRunning || isSettling || !canStart || !status.remaining;
  start.addEventListener('click', async () => {
    const kinds = [];
    if (threads.checked) kinds.push('thread');
    if (quotes.checked) kinds.push('quote');
    if (!kinds.length) { alert('Choose Threads, Quoted posts, or both.'); return; }
    start.disabled = true;
    errorLine.textContent = '';
    const response = await send({
      type: M.START_FULFILL_QUEUE, runId, kinds,
      maxJobs: Number(maxInput.value) || 10, pace: pace.value
    });
    if (!response || !response.ok) {
      errorLine.textContent = (response && response.error) || 'Could not start fulfillment.';
      const currentPageFinishing = response && response.error === 'current page is still finishing';
      start.disabled = !!currentPageFinishing;
      if (currentPageFinishing) pollJobs(runId);
      return;
    }
    pollJobs(runId);
    selectRun(runId);
  });
  const pause = el('button', '', 'Pause after current page');
  pause.disabled = !isRunning;
  pause.addEventListener('click', async () => {
    await send({ type: M.PAUSE_FULFILL_QUEUE, runId });
    clearJobPoll();
    selectRun(runId);
  });
  const download = el('button', '', 'Download updated JSON + HTML');
  download.addEventListener('click', () => exportRun(run, ['json', 'html']));
  controls.append(start, pause, download);
  card.appendChild(controls);
  const errorLine = el('p', 'fulfillment-error');
  card.appendChild(errorLine);
  const pauseReason = el('p', 'note warn');
  pauseReason.id = 'fulfillment-pause-reason';
  card.appendChild(pauseReason);
  const currentJob = jobs.find((job) => job.id === (fulfillment && fulfillment.currentJobId));
  const statusLine = el('p', 'fulfillment-status', currentJob
    ? 'Current: ' + (currentJob.kind || 'thread') + ' ' + currentJob.statusId + ' · '
    : '');
  statusLine.id = 'fulfillment-progress';
  if (fulfillment) {
    statusLine.textContent += 'Processed ' + fulfillment.processed + ' / ' + fulfillment.total;
    if (isRunning && fulfillment.nextAt && !fulfillment.currentJobId) {
      statusLine.textContent += ' · Resting until ' + new Date(fulfillment.nextAt).toLocaleTimeString();
    }
  } else if (!currentJob) {
    statusLine.textContent = 'No fulfillment session started.';
  }
  card.appendChild(statusLine);
  if (!jobs.length) card.appendChild(el('p', 'note',
    'No thread or quoted-post candidates are available in this archive yet.'));
  const jobsDetails = el('details', 'fulfillment-jobs');
  jobsDetails.appendChild(el('summary', null, 'Candidate and job details (' + jobs.length + ')'));
  for (const job of jobs.slice(0, 150)) {
    const row = el('div', 'fulfillment-job');
    const label = job.mode === 'quote_discovery' ? 'quote discovery' : (job.kind || 'thread');
    const link = el('a', null, label + ' · ' + job.statusId);
    link.href = job.url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    row.appendChild(link);
    row.appendChild(el('span', 'jobstate ' + job.state, job.state));
    row.appendChild(el('span', 'note', (job.attempts || 0) + ' attempts · ' + (job.postsFound || 0) + ' posts found'));
    if (job.diagnostics) {
      const diagnostics = el('details', 'job-diagnostics');
      diagnostics.appendChild(el('summary', null, job.diagnostics.error || job.diagnostics.blockedReason || 'Diagnostics'));
      const pre = el('pre'); pre.textContent = JSON.stringify(job.diagnostics, null, 2);
      diagnostics.appendChild(pre);
      row.appendChild(diagnostics);
    }
    jobsDetails.appendChild(row);
  }
  card.appendChild(jobsDetails);
  detail.appendChild(card);
  updateLiveFulfillment(status);
  if (isRunning || (fulfillment && fulfillment.state === 'paused' && fulfillment.currentJobId)) pollJobs(runId);
}

function updateLiveFulfillment(status) {
  const countValues = [
    ['fulfillment-thread-count', 'Thread candidates: ', status.threadCandidates || 0],
    ['fulfillment-quote-count', 'Quoted-post candidates: ', status.quoteCandidates || 0],
    ['fulfillment-missing-count', 'Quote URLs unavailable: ', status.missingQuoteUrls || 0],
    ['fulfillment-done-count', 'Done: ', status.done || 0],
    ['fulfillment-remaining-count', 'Remaining: ', status.remaining || 0],
    ['fulfillment-failure-count', 'Failed / incomplete: ', (status.failed || 0) + ' / ' + (status.incomplete || 0)]
  ];
  for (const [id, label, value] of countValues) {
    const node = $(id);
    if (node) node.textContent = label + value;
  }
  const session = status.fulfillment;
  const jobs = status.jobs || [];
  const current = session && jobs.find((job) => job.id === session.currentJobId);
  const progress = $('fulfillment-progress');
  if (progress) {
    const currentText = current ? 'Current: ' + (current.kind || 'thread') + ' ' + current.statusId + ' · ' : '';
    const counts = session ? 'Processed ' + session.processed + ' / ' + session.total : 'No fulfillment session started.';
    const next = session && session.state === 'running' && session.nextAt && !session.currentJobId
      ? ' · Resting until ' + new Date(session.nextAt).toLocaleTimeString() : '';
    progress.textContent = currentText + counts + next;
  }
  const pause = $('fulfillment-pause-reason');
  if (pause) {
    const reason = session && session.state === 'paused' && session.pauseReason;
    pause.textContent = reason ? 'Paused: ' + reason : '';
    pause.hidden = !reason;
  }
  const start = $('fulfillment-start');
  if (start && session && (session.state === 'running' || session.currentJobId)) start.disabled = true;
}

function clearJobPoll() {
  if (jobPollTimer) clearInterval(jobPollTimer);
  jobPollTimer = null;
}

function pollJobs(runId) {
  clearJobPoll();
  let terminalRefresh = false;
  jobPollTimer = setInterval(async () => {
    if (selectedRunId !== runId || terminalRefresh) { clearJobPoll(); return; }
    const st = await send({ type: M.GET_FULFILLMENT_STATUS, runId });
    if (!st) return;
    updateLiveFulfillment(st);
    const session = st.fulfillment;
    if (!session || (session.state !== 'running' && !session.currentJobId)) {
      terminalRefresh = true;
      clearJobPoll();
      selectRun(runId);
    }
  }, 3000);
}

async function exportRun(run, formats) {
  const resp = await send({ type: M.EXPORT_RUN, runId: run.id, formats, media: false });
  alert(resp && resp.ok
    ? 'Exported: ' + (resp.files || []).join(', ')
    : 'Export failed: ' + ((resp && resp.error) || 'unknown error'));
}

async function exportMedia(run) {
  const has = await chrome.permissions.contains({ origins: ['https://pbs.twimg.com/*'] });
  const granted = has || await chrome.permissions.request({ origins: ['https://pbs.twimg.com/*'] });
  if (!granted) { alert('Media permission denied — the ZIP needs access to pbs.twimg.com images.'); return; }
  const resp = await send({ type: M.EXPORT_RUN, runId: run.id, formats: ['mediazip'], media: true });
  if (resp && resp.ok) {
    const s = resp.mediaSummary;
    alert('Media ZIP saved' + (s ? ': ' + s.downloaded + '/' + s.total + ' images' +
      (s.failed ? ' (' + s.failed + ' failed — see media-manifest.json)' : '') : ''));
  } else {
    alert('Media ZIP failed: ' + ((resp && resp.error) || 'unknown error'));
  }
}

async function deleteRun(run) {
  if (!confirm('Delete archive "' + ((run.source && run.source.label) || run.id) + '" and all its posts?')) return;
  await send({ type: M.DELETE_RUN, runId: run.id });
  selectedRunId = null;
  $('arch-detail').innerHTML = '<p class="note">Select an archive to see details.</p>';
  await loadArchives();
}

async function importFile(file) {
  try {
    const text = await file.text();
    const parsed = JSON.parse(text);
    const resp = await send({ type: M.IMPORT_ARCHIVE, archive: parsed });
    if (resp && resp.ok) {
      alert('Imported ' + resp.imported + ' posts' +
        (resp.warnings && resp.warnings.length ? '\nWarnings: ' + resp.warnings.join('; ') : ''));
      await loadArchives();
    } else {
      alert('Import failed: ' + ((resp && resp.error) || 'unknown error'));
    }
  } catch (e) {
    alert('Could not read JSON: ' + e.message);
  }
}

function wire() {
  for (const a of document.querySelectorAll('nav a')) {
    a.addEventListener('click', (ev) => {
      ev.preventDefault();
      location.hash = a.getAttribute('data-tab');
      switchTab(a.getAttribute('data-tab'));
    });
  }
  $('settings-save').addEventListener('click', saveSettingsFromForm);
  $('settings-reset').addEventListener('click', async () => {
    fillForm(XA.defaults.DEFAULT_SETTINGS);
    await saveSettingsFromForm();
  });
  $('arch-search').addEventListener('input', () => loadArchives());
  $('arch-type').addEventListener('change', () => loadArchives());
  $('arch-state').addEventListener('change', () => loadArchives());
  $('arch-import').addEventListener('change', (ev) => {
    const f = ev.target.files && ev.target.files[0];
    if (f) importFile(f);
    ev.target.value = '';
  });
}

buildSettingsForm();
wire();
loadSettingsIntoForm();
const hash = location.hash || '#settings';
if (hash.startsWith('#run/')) {
  switchTab('archives');
  selectRun(hash.slice(5));
} else if (hash === '#archives') {
  switchTab('archives');
} else {
  switchTab('settings');
}
