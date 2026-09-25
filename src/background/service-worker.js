import '../shared/util.js';
import '../shared/messages.js';
import '../shared/defaults.js';
import '../shared/settings.js';
import '../shared/post-model.js';
import '../shared/filename.js';
import '../shared/export-json.js';
import '../shared/export-html.js';
import '../shared/media-zip.js';
import './database.js';
import './run-service.js';
import './export-service.js';
import './thread-service.js';

const XA = globalThis.XArchive;
const M = XA.messages.MSG;

function configureStorage() {
  try {
    if (chrome.storage && chrome.storage.local && chrome.storage.local.setAccessLevel) {
      chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }).catch(() => {});
    }
  } catch (_) { /* unsupported */ }
}

chrome.runtime.onInstalled.addListener(configureStorage);
chrome.runtime.onStartup.addListener(configureStorage);
configureStorage();

chrome.tabs.onRemoved.addListener((tabId) => XA.runService.tabRemoved(tabId));

async function handleImport(msg) {
  const archive = msg.archive;
  const { posts, envelope, warnings } = XA.postModel.legacyPostsFromImport(archive);
  if (!posts.length) {
    return { ok: false, error: 'No posts found in imported JSON', warnings };
  }
  const inferred = envelope && envelope.source ? envelope.source : inferSourceFromPosts(posts);
  const now = XA.util.nowIso();
  const run = {
    id: XA.util.uid('run'),
    source: inferred,
    state: 'completed',
    createdAt: (envelope && envelope.createdAt) || now,
    updatedAt: now,
    completedAt: (envelope && envelope.completedAt) || now,
    stopReason: 'imported',
    settings: (envelope && envelope.settings) || XA.defaults.DEFAULT_SETTINGS,
    stats: { posts: 0, seq: 0, batches: 1 },
    warnings: warnings.concat((envelope && envelope.warnings) || []),
    runtime: {},
    imported: true
  };
  await XA.db.createRun(run);
  const normalized = posts.map((p) => XA.postModel.normalizePost(p, {
    captureContext: 'import', sourceKey: inferred.key, sourceType: inferred.type
  }));
  const result = await XA.db.upsertPosts(run.id, normalized);
  await XA.db.patchRun(run.id, (r) => { r.stats.posts = result.count; return r; });
  return { ok: true, runId: run.id, imported: result.count, warnings };
}

function inferSourceFromPosts(posts) {
  const handles = new Map();
  for (const p of posts.slice(0, 200)) {
    const h = p.handle || '';
    if (h) handles.set(h.toLowerCase(), (handles.get(h.toLowerCase()) || 0) + 1);
  }
  let best = null;
  let bestCount = 0;
  for (const [h, n] of handles.entries()) {
    if (n > bestCount) { best = h; bestCount = n; }
  }
  if (best && bestCount >= Math.max(3, posts.length * 0.6)) {
    const handle = best.replace(/^@/, '');
    return {
      key: 'profile:' + handle + ':posts',
      type: 'profile', label: '@' + handle + ' posts (imported)',
      handle, tab: 'posts',
      sourceUrl: 'https://x.com/' + handle,
      supported: true, reason: null
    };
  }
  return {
    key: 'import:' + Date.now().toString(36),
    type: 'bookmarks', label: 'Imported archive',
    handle: null, tab: null,
    sourceUrl: null, supported: true, reason: null
  };
}

function respond(sendResponse, promise) {
  Promise.resolve(promise)
    .then((r) => sendResponse(r == null ? { ok: true } : r))
    .catch((e) => sendResponse({ ok: false, error: String(e && e.message || e) }));
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return false;
  switch (msg.type) {
    case M.GET_TAB_CONTEXT:
      respond(sendResponse, XA.runService.contextForTab(msg.tabId));
      return true;
    case M.START_RUN:
      respond(sendResponse, XA.runService.startRun(msg));
      return true;
    case M.PAUSE_RUN:
      respond(sendResponse, XA.runService.pauseRun(msg));
      return true;
    case M.RESUME_RUN:
      respond(sendResponse, XA.runService.resumeRun(msg));
      return true;
    case M.STOP_RUN:
      respond(sendResponse, XA.runService.stopRun(msg));
      return true;
    case M.UPSERT_POSTS:
      respond(sendResponse, XA.runService.handleUpsert(msg, sender));
      return true;
    case M.EXPORT_RUN:
      respond(sendResponse, XA.exportService.exportRun(msg.runId, msg.formats, {
        media: msg.media, snapshot: msg.snapshot, saveAs: msg.saveAs
      }));
      return true;
    case M.GET_RUN:
      respond(sendResponse, (async () => {
        const run = await XA.db.getRun(msg.runId);
        const posts = run ? await XA.db.getPosts(msg.runId) : [];
        const threadJobs = run ? await XA.db.listThreadJobs(msg.runId) : [];
        return { ok: !!run, run, postCount: posts.length, posts, threadJobs };
      })());
      return true;
    case M.LIST_RUNS:
      respond(sendResponse, (async () => ({ ok: true, runs: await XA.db.listRuns(msg.filters || {}) }))());
      return true;
    case M.DELETE_RUN:
      respond(sendResponse, XA.db.deleteRun(msg.runId).then(() => ({ ok: true })));
      return true;
    case M.IMPORT_ARCHIVE:
      respond(sendResponse, handleImport(msg));
      return true;
    case M.START_THREAD_QUEUE:
      respond(sendResponse, XA.threadService.startQueue(msg));
      return true;
    case M.PAUSE_THREAD_QUEUE:
      respond(sendResponse, XA.threadService.pauseQueue(msg));
      return true;
    case M.XAR_STATE:
      respond(sendResponse, XA.runService.handleState(msg, sender));
      return true;
    case M.XAR_CONTENT_READY:
      if (msg.threadWorker) { sendResponse({ ok: true }); return false; }
      respond(sendResponse, XA.runService.contentReady(msg, sender));
      return true;
    case M.XAR_THREAD_RESULT:
      respond(sendResponse, Promise.resolve(XA.threadService.handleThreadResult(msg, sender)));
      return true;
    case M.GET_SETTINGS:
      respond(sendResponse, XA.settings.loadSettings().then((s) => ({ ok: true, settings: s })));
      return true;
    case M.SAVE_SETTINGS:
      respond(sendResponse, (async () => {
        const { settings, errors } = XA.settings.validateSettings(msg.settings || {});
        await XA.settings.saveSettings(settings);
        return { ok: true, settings, errors };
      })());
      return true;
    case M.GET_STORAGE_USAGE:
      respond(sendResponse, XA.db.storageEstimate().then((e) => ({ ok: true, estimate: e })));
      return true;
    case M.LIST_THREAD_JOBS:
      respond(sendResponse, XA.threadService.statusFor(msg.runId).then((s) => ({ ok: true, ...s })));
      return true;
    case M.REQUEST_MEDIA_PERMISSION:
      respond(sendResponse, XA.exportService.hasMediaPermission().then((has) => ({ ok: true, granted: has })));
      return true;
    case M.OPEN_ARCHIVE_PAGE:
      respond(sendResponse, (async () => {
        const url = chrome.runtime.getURL('src/options/options.html') +
          (msg.runId ? '#run/' + msg.runId : '');
        await chrome.tabs.create({ url });
        return { ok: true };
      })());
      return true;
    default:
      return false;
  }
});
