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
      { key: 'preset', kind: 'select', label: 'Preset', options: ['gentle', 'balanced', 'fast', 'custom'],
        desc: 'Gentle is slowest and safest; Fast is aggressive and may miss posts or hit limits. Editing a timing field switches the preset to Custom.' },
      { key: 'randomize', kind: 'check', label: 'Randomize delays and scroll distance',
        desc: 'Adds jitter so scrolling does not look robotic. Off = fixed midpoints.' }
    ]
  },
  {
    title: 'Timing',
    fields: [
      { key: 'tickDelayMinMs', kind: 'number', label: 'Tick delay min (ms)', range: [250, 120000],
        desc: 'Shortest pause between scrape cycles. Default 3000.' },
      { key: 'tickDelayMaxMs', kind: 'number', label: 'Tick delay max (ms)', range: [250, 120000],
        desc: 'Longest pause between scrape cycles. Default 6000.' },
      { key: 'scrollMinPx', kind: 'number', label: 'Scroll min (px)', range: [50, 5000],
        desc: 'Smallest scroll step per tick. Default 650.' },
      { key: 'scrollMaxPx', kind: 'number', label: 'Scroll max (px)', range: [50, 5000],
        desc: 'Largest scroll step per tick. Default 1150.' },
      { key: 'restEveryPosts', kind: 'number', label: 'Rest every N new posts', range: [5, 5000],
        desc: 'Takes a break after this many newly captured posts. Default 80.' },
      { key: 'restMinMs', kind: 'number', label: 'Rest min (ms)', range: [1000, 600000],
        desc: 'Shortest scheduled break. Default 20000.' },
      { key: 'restMaxMs', kind: 'number', label: 'Rest max (ms)', range: [1000, 600000],
        desc: 'Longest scheduled break. Default 28000.' },
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
      { key: 'jsonFormat', kind: 'select', label: 'JSON format', options: ['envelope', 'legacy'],
        desc: 'Envelope = metadata + posts (default). Legacy = raw posts array like the old scripts produced.' },
      { key: 'saveAs', kind: 'check', label: 'Ask where to save each download' },
      { key: 'filenameTemplate', kind: 'text', label: 'Filename template',
        desc: 'Tokens: %type %source %handle %title %tab %date %time %datetime %num %run %ext' }
    ]
  },
  {
    title: 'Media downloads',
    fields: [
      { key: 'autoMediaZip', kind: 'check', label: 'Download a media ZIP after the final export',
        desc: 'Off by default. Requests optional access to pbs.twimg.com the first time it runs.' },
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
        for (const opt of f.options) sel.appendChild(el('option', null, opt)).value = opt;
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
  const resp = await send({ type: M.SAVE_SETTINGS, settings: collected });
  if (resp && resp.ok) {
    currentSettings = resp.settings;
    showSettingsErrors(resp.errors || {});
    fillForm(resp.settings);
    $('settings-status').textContent = 'Saved' +
      (resp.errors && Object.keys(resp.errors).length ? ' (see notes on fields)' : '');
  } else {
    $('settings-status').textContent = 'Save failed';
  }
  setTimeout(() => { $('settings-status').textContent = ''; }, 4000);
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

function collectCandidates(posts) {
  const map = new Map();
  for (const p of posts || []) {
    for (const c of p.thread_candidates || []) {
      const sid = XA.util.statusIdFromUrl(c.url);
      if (!sid) continue;
      if (!map.has(sid)) map.set(sid, { statusId: sid, url: c.url, reasons: new Set(), confidence: c.confidence });
      const e = map.get(sid);
      e.reasons.add(c.reason);
      if (c.confidence === 'high' || (c.confidence === 'medium' && e.confidence !== 'high')) {
        e.confidence = c.confidence;
      }
    }
    if (p.is_thread && p.thread_id) {
      const sid = XA.util.statusIdFromUrl(p.thread_id);
      if (sid && !map.has(sid)) {
        map.set(sid, { statusId: sid, url: p.thread_id, reasons: new Set(['thread-member']), confidence: 'medium' });
      }
    }
  }
  return Array.from(map.values());
}

async function selectRun(runId) {
  selectedRunId = runId;
  await loadArchives();
  const resp = await send({ type: M.GET_RUN, runId });
  const detail = $('arch-detail');
  detail.textContent = '';
  if (!resp || !resp.ok || !resp.run) {
    detail.appendChild(el('p', 'note', 'Archive not found.'));
    return;
  }
  const run = resp.run;
  const posts = resp.posts || [];
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

  const cand = collectCandidates(posts);
  detail.appendChild(el('h3', null, 'Assisted thread expansion (best effort)'));
  const jobStatus = await send({ type: M.LIST_THREAD_JOBS, runId });
  const jobs = (jobStatus && jobStatus.jobs) || [];
  if (jobStatus && jobStatus.running) {
    detail.appendChild(el('p', 'note', 'Thread queue is running in a dedicated window…'));
  }
  if (!cand.length && !jobs.length) {
    detail.appendChild(el('p', 'note',
      'No thread candidates were recorded during this run. Candidates appear when posts show "Show this thread", self-replies, numbered counters, or stitched chains.'));
  } else {
    const list = el('div', 'thread-list');
    const boxes = [];
    const jobsByStatus = new Map(jobs.map((j) => [j.statusId, j]));
    for (const c of cand) {
      const row = el('div', 'thread-row');
      const cb = el('input');
      cb.type = 'checkbox';
      cb.value = c.statusId;
      const job = jobsByStatus.get(c.statusId);
      cb.checked = !job || (job.state !== 'done' && job.state !== 'skipped');
      cb.dataset.candidate = '1';
      row.appendChild(cb);
      const a = el('a', null, c.statusId);
      a.href = c.url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.style.color = '#1d9bf0';
      row.appendChild(a);
      row.appendChild(el('span', 'conf ' + c.confidence, c.confidence + ' · ' + Array.from(c.reasons).join(', ')));
      if (job) {
        const tag = el('span', 'jobstate ' + job.state, job.state);
        if (job.diagnostics && job.diagnostics.error) tag.title = job.diagnostics.error;
        row.appendChild(tag);
      }
      list.appendChild(row);
      boxes.push(cb);
    }
    detail.appendChild(list);
    const qbtns = el('div', 'detail-actions');
    const startB = el('button', 'primary', 'Expand selected threads');
    startB.addEventListener('click', async () => {
      const ids = boxes.filter((b) => b.checked).map((b) => b.value);
      if (!ids.length) return;
      startB.disabled = true;
      const r = await send({ type: M.START_THREAD_QUEUE, runId, candidateIds: ids });
      if (!r || !r.ok) {
        alert((r && r.error) || 'Could not start thread queue');
        startB.disabled = false;
      } else {
        pollJobs(runId);
      }
    });
    const pauseB = el('button', '', 'Pause queue');
    pauseB.addEventListener('click', async () => {
      await send({ type: M.PAUSE_THREAD_QUEUE, runId });
      selectRun(runId);
    });
    qbtns.append(startB, pauseB);
    detail.appendChild(qbtns);
  }
  if (jobs.length) {
    detail.appendChild(el('h3', null, 'Thread job results'));
    for (const j of jobs.slice(0, 60)) {
      const row = el('div', 'kv');
      row.appendChild(el('span', 'k', j.statusId));
      const diag = j.diagnostics || {};
      row.appendChild(el('span', 'v',
        j.state + ' — ' + (j.postsFound != null ? j.postsFound : '?') + ' posts' +
        (diag.error ? ' — ' + diag.error : '') +
        (diag.incompleteCounter ? ' — counter incomplete (' + diag.incompleteCounter.seen + '/' + diag.incompleteCounter.total + ')' : '')));
      detail.appendChild(row);
    }
  }
}

function pollJobs(runId) {
  if (jobPollTimer) clearInterval(jobPollTimer);
  jobPollTimer = setInterval(async () => {
    if (selectedRunId !== runId) { clearInterval(jobPollTimer); return; }
    const st = await send({ type: M.LIST_THREAD_JOBS, runId });
    if (st && !st.running) {
      clearInterval(jobPollTimer);
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
