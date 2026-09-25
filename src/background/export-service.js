(function () {
  'use strict';
  const XA = (globalThis.XArchive = globalThis.XArchive || {});
  const M = () => XA.messages.MSG;

  const OFFSCREEN_URL = 'src/offscreen/offscreen.html';
  const pendingDownloads = new Map();

  async function hasOffscreen() {
    try {
      if (chrome.runtime.getContexts) {
        const ctxs = await chrome.runtime.getContexts({
          contextTypes: ['OFFSCREEN_DOCUMENT'],
          documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)]
        });
        return ctxs.length > 0;
      }
      if (chrome.offscreen.hasDocument) return await chrome.offscreen.hasDocument();
    } catch (_) { /* fall through */ }
    return false;
  }

  async function ensureOffscreen() {
    if (await hasOffscreen()) return;
    const create = chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: ['BLOBS'],
      justification: 'Generate archive export files (JSON, HTML, media ZIP) as downloadable Blobs'
    });
    await Promise.race([create, new Promise((_, rej) => setTimeout(() => rej(new Error('offscreen timeout')), 15000))]);
  }

  async function closeOffscreenSoon() {
    try {
      if (await hasOffscreen()) await chrome.offscreen.closeDocument();
    } catch (_) { /* ignore */ }
  }

  function sendToOffscreen(msg, timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('offscreen export timeout')), timeoutMs || 120000);
      try {
        chrome.runtime.sendMessage(msg, (resp) => {
          clearTimeout(timer);
          const err = chrome.runtime.lastError;
          if (err) reject(new Error(err.message));
          else resolve(resp);
        });
      } catch (e) { clearTimeout(timer); reject(e); }
    });
  }

  function trackDownload(downloadId) {
    return new Promise((resolve) => {
      pendingDownloads.set(downloadId, resolve);
    });
  }

  function onDownloadChanged(delta) {
    if (!delta || !delta.id) return;
    if (!pendingDownloads.has(delta.id)) return;
    const state = delta.state && delta.state.current;
    if (state === 'complete' || state === 'interrupted') {
      pendingDownloads.get(delta.id)(state);
      pendingDownloads.delete(delta.id);
      if (!pendingDownloads.size) closeOffscreenSoon();
    }
  }

  if (typeof chrome !== 'undefined' && chrome.downloads && chrome.downloads.onChanged) {
    chrome.downloads.onChanged.addListener(onDownloadChanged);
  }

  function downloadOne(file, saveAs) {
    return new Promise((resolve, reject) => {
      try {
        chrome.downloads.download({
          url: file.url,
          filename: file.filename,
          saveAs: !!saveAs,
          conflictAction: 'uniquify'
        }, (id) => {
          const err = chrome.runtime.lastError;
          if (err) { reject(new Error(err.message)); return; }
          if (id == null) { reject(new Error('download did not start')); return; }
          trackDownload(id).then((state) => resolve({ id, state, filename: file.filename }));
        });
      } catch (e) { reject(e); }
    });
  }

  async function hasMediaPermission() {
    try {
      return await chrome.permissions.contains({ origins: ['https://pbs.twimg.com/*'] });
    } catch (_) {
      return false;
    }
  }

  async function exportRun(runId, formats, opts) {
    const o = opts || {};
    if (o.media && !(await hasMediaPermission())) {
      return { ok: false, error: 'media-permission-required' };
    }
    const run = await XA.db.getRun(runId);
    if (!run) return { ok: false, error: 'run not found' };
    const settings = run.settings || await XA.settings.loadSettings();
    const job = {
      id: XA.util.uid('export'),
      runId,
      kind: o.media ? 'mediazip' : (Array.isArray(formats) ? formats.join('+') : String(formats || 'export')),
      state: 'pending',
      files: [],
      error: null,
      createdAt: XA.util.nowIso(),
      updatedAt: XA.util.nowIso()
    };
    await XA.db.putExportJob(job);
    try {
      await ensureOffscreen();
      const template = (settings.filenameTemplate) || 'x_%type_%handle_%date_%num';
      const resp = await sendToOffscreen({
        type: M().XAR_OFFSCREEN_EXPORT,
        jobId: job.id,
        runId: run.id,
        formats: o.media ? ['mediazip'] : formats,
        template,
        jsonFormat: settings.jsonFormat,
        mediaSettings: settings.media,
        snapshot: !!o.snapshot
      }, o.media ? 300000 : 120000);
      if (!resp || resp.ok === false) {
        throw new Error((resp && resp.error) || 'offscreen export failed');
      }
      const results = [];
      for (const file of resp.files || []) {
        results.push(await downloadOne(file, o.saveAs != null ? o.saveAs : settings.saveAs));
      }
      job.state = 'done';
      job.files = results.map((r) => r.filename);
      job.updatedAt = XA.util.nowIso();
      await XA.db.putExportJob(job);
      return { ok: true, files: job.files, mediaSummary: resp.mediaSummary || null };
    } catch (e) {
      job.state = 'failed';
      job.error = String(e && e.message || e);
      job.updatedAt = XA.util.nowIso();
      await XA.db.putExportJob(job);
      return { ok: false, error: job.error };
    } finally {
      if (!pendingDownloads.size) closeOffscreenSoon();
    }
  }

  function onSuspendCleanup() {
    for (const resolve of pendingDownloads.values()) resolve('interrupted');
    pendingDownloads.clear();
  }

  XA.exportService = {
    ensureOffscreen, hasOffscreen, closeOffscreenSoon, hasMediaPermission,
    exportRun, downloadOne, onDownloadChanged, onSuspendCleanup
  };
})();
