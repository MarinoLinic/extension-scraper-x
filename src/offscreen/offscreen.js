import '../shared/util.js';
import '../shared/messages.js';
import '../shared/defaults.js';
import '../shared/post-model.js';
import '../shared/filename.js';
import '../shared/export-json.js';
import '../shared/export-html.js';
import '../shared/media-zip.js';
import '../background/database.js';
import '../vendor/fflate.min.js';

const XA = globalThis.XArchive;
const M = XA.messages.MSG;
const blobUrls = [];

function makeFile(filename, content, mime) {
  const blob = content instanceof Blob ? content : new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  blobUrls.push(url);
  return { filename, url, mime };
}

function exportFilename(msg, ext, extraSuffix) {
  const base = XA.filename.expandTemplate(msg.template, {
    source: msg.run.source,
    run: msg.run,
    num: msg.postCount,
    ext,
    date: new Date()
  });
  return base + (extraSuffix || '') + '.' + ext;
}

async function fetchOne(url, retries) {
  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { credentials: 'omit', redirect: 'follow' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const buf = await res.arrayBuffer();
      return { bytes: new Uint8Array(buf), contentType: res.headers.get('content-type') || null };
    } catch (e) {
      lastErr = e;
      if (attempt < retries) await XA.util.sleep(400 * (attempt + 1));
    }
  }
  throw lastErr || new Error('fetch failed');
}

async function fetchMedia(targets, concurrency, retries) {
  const results = new Map();
  const failures = [];
  let idx = 0;
  const workers = Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (idx < targets.length) {
      const t = targets[idx++];
      try {
        const r = await fetchOne(t.url, retries);
        results.set(t.url, r);
      } catch (e) {
        failures.push({ url: t.url, error: String(e && e.message || e) });
      }
    }
  });
  await Promise.all(workers);
  return { results, failures };
}

async function handleExport(msg) {
  const run = msg.runId ? await XA.db.getRun(msg.runId) : msg.run;
  if (!run) return { ok: false, error: 'run not found in archive storage' };
  const posts = await XA.db.getPosts(run.id);
  const files = [];
  let mediaSummary = null;
  const postCount = posts.length;
  const ctx = Object.assign({}, msg, { run, postCount });
  const formats = msg.formats || [];
  for (const fmt of formats) {
    if (fmt === 'json') {
      const json = XA.exportJson.serializeJson(run, posts, msg.jsonFormat || 'envelope');
      files.push(makeFile(exportFilename(ctx, 'json', msg.snapshot ? '_snapshot' : ''), json, 'application/json'));
    } else if (fmt === 'html') {
      const html = XA.exportHtml.renderHtmlReport(run, posts, {});
      files.push(makeFile(exportFilename(ctx, 'html', msg.snapshot ? '_snapshot' : ''), html, 'text/html'));
    } else if (fmt === 'mediazip') {
      const targets = XA.mediaZip.collectMediaTargets(posts, msg.mediaSettings || {});
      const { results, failures } = await fetchMedia(targets, 4, 1);
      const { zipBytes, manifest } = XA.mediaZip.buildMediaZip({
        run, posts, results, failures,
        mediaSettings: msg.mediaSettings || {}
      });
      files.push(makeFile(exportFilename(ctx, 'zip'), new Blob([zipBytes], { type: 'application/zip' }), 'application/zip'));
      mediaSummary = {
        total: targets.length,
        downloaded: manifest.entries.filter((e) => !e.error).length,
        failed: failures.length
      };
    }
  }
  return { ok: true, files, mediaSummary };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== M.XAR_OFFSCREEN_EXPORT) return false;
  handleExport(msg)
    .then((r) => sendResponse(r))
    .catch((e) => sendResponse({ ok: false, error: String(e && e.message || e) }));
  return true;
});
