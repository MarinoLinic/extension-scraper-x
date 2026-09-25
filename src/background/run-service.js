(function () {
  'use strict';
  const XA = (globalThis.XArchive = globalThis.XArchive || {});
  const M = () => XA.messages.MSG;

  const BADGE_COLORS = {
    running: '#1d9bf0',
    resting: '#f4a41c',
    paused: '#7856ff',
    completed: '#17bf63',
    limited: '#17bf63',
    error: '#e0245e',
    stopping: '#f4a41c'
  };

  const tabRunMap = new Map();

  function sendToTab(tabId, msg) {
    return new Promise((resolve, reject) => {
      if (tabId == null) { reject(new Error('no tab')); return; }
      try {
        chrome.tabs.sendMessage(tabId, msg, (resp) => {
          const err = chrome.runtime.lastError;
          if (err) reject(new Error(err.message));
          else resolve(resp);
        });
      } catch (e) { reject(e); }
    });
  }

  async function setBadge(tabId, run, runtime) {
    try {
      if (!chrome.action) return;
      const settings = run && run.settings;
      if (settings && settings.showBadge === false) {
        await chrome.action.setBadgeText({ tabId, text: '' });
        return;
      }
      if (!run) {
        await chrome.action.setBadgeText({ tabId, text: '' });
        return;
      }
      const state = runtime && runtime.state ? runtime.state : run.state;
      const count = runtime && runtime.posts != null ? runtime.posts
        : (run.stats && run.stats.posts) || 0;
      const text = state === 'running' || state === 'resting'
        ? (count > 999 ? '999+' : String(count))
        : state === 'paused' ? 'psd'
        : state === 'completed' || state === 'limited' ? 'done'
        : state === 'error' ? '!' : '';
      await chrome.action.setBadgeText({ tabId, text });
      const color = BADGE_COLORS[state];
      if (color) await chrome.action.setBadgeBackgroundColor({ tabId, color });
    } catch (_) { /* badge is cosmetic */ }
  }

  async function clearBadge(tabId) {
    try { await chrome.action.setBadgeText({ tabId, text: '' }); } catch (_) { /* ignore */ }
  }

  async function startRun(msg) {
    const { tabId, source, settings } = msg;
    if (!source || !source.supported) {
      return { ok: false, error: (source && source.reason) || 'Unsupported page' };
    }
    const existing = await XA.db.findUnfinishedRun(source.key);
    if (existing && existing.tabId === tabId) {
      return { ok: false, error: 'A run for this source is already active on this tab', runId: existing.id };
    }
    const { settings: validated, errors } = XA.settings.validateSettings(settings || {});
    if (!validated) return { ok: false, error: 'Invalid settings' };
    const merged = Object.assign({}, XA.defaults.DEFAULT_SETTINGS, settings || {});
    const now = XA.util.nowIso();
    const run = {
      id: XA.util.uid('run'),
      source,
      state: 'running',
      createdAt: now,
      updatedAt: now,
      completedAt: null,
      stopReason: null,
      settings: merged,
      stats: { posts: 0, seq: 0, batches: 0 },
      warnings: errors ? Object.values(errors) : [],
      runtime: { activeElapsedMs: 0 },
      tabId
    };
    await XA.db.createRun(run);
    try {
      await sendToTab(tabId, { type: M().XAR_CONTROL, action: 'start', run, settings: merged });
    } catch (e) {
      await XA.db.patchRun(run.id, { state: 'error', stopReason: 'error' });
      return { ok: false, error: 'Content script unreachable: ' + e.message };
    }
    tabRunMap.set(tabId, run.id);
    await setBadge(tabId, run);
    return { ok: true, run };
  }

  async function pauseRun(msg) {
    const run = await XA.db.getRun(msg.runId);
    if (!run) return { ok: false, error: 'run not found' };
    if (run.tabId != null) {
      await sendToTab(run.tabId, { type: M().XAR_CONTROL, action: 'pause' }).catch(() => {});
    }
    await XA.db.patchRun(run.id, { state: 'paused' });
    await setBadge(run.tabId, Object.assign({}, run, { state: 'paused' }));
    return { ok: true };
  }

  async function resumeRun(msg) {
    const run = await XA.db.getRun(msg.runId);
    if (!run) return { ok: false, error: 'run not found' };
    if (!XA.messages.UNFINISHED_STATES.includes(run.state)) {
      return { ok: false, error: 'run is already finished' };
    }
    const tabId = msg.tabId != null ? msg.tabId : run.tabId;
    try {
      await sendToTab(tabId, {
        type: M().XAR_CONTROL, action: 'resume', run, settings: run.settings
      });
    } catch (e) {
      return { ok: false, error: 'Content script unreachable: ' + e.message };
    }
    await XA.db.patchRun(run.id, { state: 'running', tabId });
    tabRunMap.set(tabId, run.id);
    await setBadge(tabId, Object.assign({}, run, { state: 'running' }));
    return { ok: true };
  }

  async function stopRun(msg) {
    const run = await XA.db.getRun(msg.runId);
    if (!run) return { ok: false, error: 'run not found' };
    if (XA.messages.UNFINISHED_STATES.includes(run.state) && run.tabId != null) {
      await sendToTab(run.tabId, { type: M().XAR_CONTROL, action: 'stop', reason: 'manual' }).catch(() => {});
    }
    const shouldAutoExport = !!(run.settings && run.settings.autoExportOnComplete && !run.autoExported);
    const patched = await XA.db.patchRun(run.id, (r) => {
      r.state = 'completed';
      r.stopReason = r.stopReason || 'manual';
      r.completedAt = XA.util.nowIso();
      if (shouldAutoExport) r.autoExported = true;
      return r;
    });
    await setBadge(run.tabId, patched);
    if (shouldAutoExport && patched) {
      XA.exportService.exportRun(run.id, patched.settings.exportFormats, {
        media: patched.settings.autoMediaZip
      }).catch(() => {});
    }
    return { ok: true };
  }

  async function handleUpsert(msg, sender) {
    const runId = msg.runId;
    if (!runId) return { ok: false, error: 'missing runId' };
    const result = await XA.db.upsertPosts(runId, msg.posts || []);
    const run = await XA.db.patchRun(runId, (r) => {
      r.stats.batches = (r.stats.batches || 0) + 1;
      r.runtime = Object.assign({}, r.runtime, msg.runtime || {});
      r.runtime.lastSavedAt = XA.util.nowIso();
      const incoming = msg.runtime && msg.runtime.state;
      const runFinished = !XA.messages.UNFINISHED_STATES.includes(r.state);
      const staleRunning = r.state === 'paused' && incoming === 'running';
      const resurrecting = runFinished && XA.messages.UNFINISHED_STATES.includes(incoming);
      if (incoming && !staleRunning && !resurrecting) r.state = incoming;
      return r;
    });
    const tabId = (sender && sender.tab && sender.tab.id) || (run && run.tabId);
    if (tabId != null) {
      await setBadge(tabId, run, msg.runtime);
    }
    return { ok: true, count: result.count, changed: result.changed };
  }

  async function handleState(msg, sender) {
    const runId = msg.runId;
    if (!runId) return { ok: false };
    const run = await XA.db.patchRun(runId, (r) => {
      r.state = msg.state || r.state;
      if (msg.stopReason) r.stopReason = msg.stopReason;
      if (['completed', 'limited', 'error'].includes(msg.state)) r.completedAt = XA.util.nowIso();
      r.runtime = Object.assign({}, r.runtime, msg.runtime || {});
      return r;
    });
    const tabId = (sender && sender.tab && sender.tab.id) || (run && run.tabId);
    if (tabId != null) {
      if (run && ['completed', 'limited', 'error'].includes(run.state)) {
        tabRunMap.delete(tabId);
      }
      await setBadge(tabId, run, msg.runtime);
    }
    if (run && ['completed', 'limited'].includes(run.state) &&
        run.settings && run.settings.autoExportOnComplete && !run.autoExported) {
      await XA.db.patchRun(runId, { autoExported: true });
      XA.exportService.exportRun(runId, run.settings.exportFormats, {
        media: run.settings.autoMediaZip
      }).catch(() => {});
    }
    return { ok: true };
  }

  async function contextForTab(tabId) {
    let content = null;
    try {
      content = await sendToTab(tabId, { type: M().XAR_GET_CONTEXT });
    } catch (_) {
      content = null;
    }
    const source = content && content.source
      ? content.source
      : { key: 'unsupported', type: 'unsupported', label: 'Not an X page', handle: null, tab: null, sourceUrl: null, supported: false, reason: 'Open an X timeline to archive' };
    let run = null;
    const mappedRunId = tabRunMap.get(tabId);
    if (mappedRunId) run = await XA.db.getRun(mappedRunId);
    if (!run && source.supported) {
      run = await XA.db.findUnfinishedRun(source.key);
    }
    return { ok: true, source, controller: content ? content.controller : null, run, settings: await XA.settings.loadSettings() };
  }

  async function contentReady(msg, sender) {
    const source = msg.source;
    if (!source || !source.supported) return { ok: true };
    const run = await XA.db.findUnfinishedRun(source.key);
    const tabId = sender && sender.tab && sender.tab.id;
    if (run && tabId != null && run.state !== 'error') {
      tabRunMap.set(tabId, run.id);
      if (run.state === 'paused' || run.state === 'running' || run.state === 'resting') {
        return { ok: true, resumeRun: run, resumeSettings: run.settings };
      }
    }
    return { ok: true };
  }

  function tabRemoved(tabId) {
    tabRunMap.delete(tabId);
  }

  XA.runService = {
    BADGE_COLORS, setBadge, clearBadge, sendToTab,
    startRun, pauseRun, resumeRun, stopRun,
    handleUpsert, handleState, contextForTab, contentReady, tabRemoved
  };
})();
