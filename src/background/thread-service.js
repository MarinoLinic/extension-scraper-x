(function () {
  'use strict';
  const XA = (globalThis.XArchive = globalThis.XArchive || {});
  const M = () => XA.messages.MSG;

  const JOB_TIMEOUT_MS = 90000;
  const queues = new Map();

  function queueFor(runId) {
    if (!queues.has(runId)) {
      queues.set(runId, { workerTabId: null, workerWindowId: null, running: false, paused: false, currentJobId: null });
    }
    return queues.get(runId);
  }

  function jobId(runId, statusId) { return runId + ':' + statusId; }

  async function buildJobs(runId, candidateIds) {
    const run = await XA.db.getRun(runId);
    const runHandle = run && run.source && run.source.handle
      ? String(run.source.handle).replace(/^@/, '') : null;
    const posts = await XA.db.getPosts(runId);
    const byStatus = new Map();
    for (const p of posts) {
      for (const c of p.thread_candidates || []) {
        const sid = XA.util.statusIdFromUrl(c.url);
        if (!sid) continue;
        const prev = byStatus.get(sid);
        if (!prev || rankConfidence(c.confidence) > rankConfidence(prev.confidence)) {
          byStatus.set(sid, { url: XA.util.canonicalStatusUrl(c.url), reason: c.reason, confidence: c.confidence });
        }
      }
      if (p.is_thread && p.thread_id) {
        const sid = XA.util.statusIdFromUrl(p.thread_id);
        if (sid && !byStatus.has(sid)) {
          byStatus.set(sid, { url: XA.util.canonicalStatusUrl(p.thread_id), reason: 'thread-member', confidence: 'medium' });
        }
      }
    }
    const wanted = candidateIds && candidateIds.length
      ? new Set(candidateIds.map(String)) : null;
    const jobs = [];
    for (const [sid, meta] of byStatus.entries()) {
      if (wanted && !wanted.has(sid)) continue;
      jobs.push({
        id: jobId(runId, sid),
        runId,
        statusId: sid,
        url: meta.url,
        authorHandle: authorForUrl(meta.url, runHandle),
        reason: meta.reason,
        confidence: meta.confidence,
        state: 'queued',
        attempts: 0,
        diagnostics: null,
        createdAt: XA.util.nowIso(),
        updatedAt: XA.util.nowIso()
      });
    }
    for (const job of jobs) {
      const existing = await XA.db.getThreadJob(job.id);
      if (existing && (existing.state === 'done' || existing.state === 'running')) continue;
      await XA.db.putThreadJob(existing ? Object.assign(existing, { state: 'queued', updatedAt: XA.util.nowIso() }) : job);
    }
    return jobs;
  }

  function rankConfidence(c) {
    return c === 'high' ? 3 : c === 'medium' ? 2 : c === 'low' ? 1 : 0;
  }

  function authorForUrl(url, fallback) {
    const a = XA.util.authorOfStatusUrl(url);
    if (!a || a.toLowerCase() === 'i') return fallback || a;
    return a;
  }

  async function ensureWorkerTab(q, firstUrl) {
    if (q.workerTabId != null) {
      try {
        const tab = await chrome.tabs.get(q.workerTabId);
        if (tab) return q.workerTabId;
      } catch (_) { /* tab gone */ }
      q.workerTabId = null;
    }
    const win = await chrome.windows.create({ url: firstUrl, focused: true, type: 'normal' });
    q.workerWindowId = win.id;
    q.workerTabId = win.tabs && win.tabs[0] ? win.tabs[0].id : null;
    if (q.workerTabId == null) {
      const tabs = await chrome.tabs.query({ windowId: win.id });
      q.workerTabId = tabs[0] && tabs[0].id;
    }
    return q.workerTabId;
  }

  function waitTabLoaded(tabId, timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(listener);
        reject(new Error('tab load timeout'));
      }, timeoutMs || 45000);
      function listener(updatedTabId, info) {
        if (updatedTabId === tabId && info.status === 'complete') {
          clearTimeout(timer);
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        }
      }
      chrome.tabs.onUpdated.addListener(listener);
      chrome.tabs.get(tabId, (tab) => {
        if (!chrome.runtime.lastError && tab && tab.status === 'complete') {
          clearTimeout(timer);
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        }
      });
    });
  }

  async function navigateWorker(q, url) {
    await chrome.tabs.update(q.workerTabId, { url });
    await waitTabLoaded(q.workerTabId, 45000);
    await XA.util.sleep(1500);
  }

  const pendingResults = new Map();

  function handleThreadResult(msg, _sender) {
    const job = pendingResults.get(msg.jobId);
    if (job) {
      pendingResults.delete(msg.jobId);
      job(msg);
    }
    return { ok: true };
  }

  function sendJobAndAwait(q, job) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pendingResults.delete(job.id);
        resolve({ posts: [], diagnostics: { error: 'job timed out', statusId: job.statusId } });
      }, JOB_TIMEOUT_MS);
      pendingResults.set(job.id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      chrome.tabs.sendMessage(q.workerTabId, {
        type: M().XAR_THREAD_JOB,
        job: { id: job.id, statusId: job.statusId, url: job.url, authorHandle: job.authorHandle }
      }, () => {
        if (chrome.runtime.lastError) {
          clearTimeout(timer);
          pendingResults.delete(job.id);
          resolve({ posts: [], diagnostics: { error: chrome.runtime.lastError.message, statusId: job.statusId } });
        }
      });
    });
  }

  async function persistResult(runId, result) {
    const posts = (result.posts || []).map((p) =>
      XA.postModel.normalizePost(p, { captureContext: 'thread' }));
    if (posts.length) {
      await XA.db.upsertPosts(runId, posts);
    }
    return posts.length;
  }

  async function finishQueue(runId, q) {
    q.running = false;
    q.currentJobId = null;
    const jobs = await XA.db.listThreadJobs(runId);
    const done = jobs.filter((j) => j.state === 'done').length;
    await XA.db.patchRun(runId, (r) => {
      r.threadSummary = { total: jobs.length, done, finishedAt: XA.util.nowIso() };
      return r;
    });
    if (q.workerTabId != null) {
      try {
        await chrome.tabs.update(q.workerTabId, {
          url: chrome.runtime.getURL('src/options/options.html') + '#run/' + runId,
          active: true
        });
      } catch (_) { /* ignore */ }
    }
  }

  async function runQueue(runId) {
    const q = queueFor(runId);
    const jobs = (await XA.db.listThreadJobs(runId))
      .filter((j) => ['queued', 'failed', 'paused', 'running'].includes(j.state));
    if (!jobs.length) { await finishQueue(runId, q); return; }
    try {
      await ensureWorkerTab(q, jobs[0].url);
    } catch (e) {
      q.running = false;
      return;
    }
    let first = true;
    for (const job of jobs) {
      if (q.paused) break;
      q.currentJobId = job.id;
      await XA.db.patchThreadJob(job.id, { state: 'running', attempts: (job.attempts || 0) + 1 });
      try {
        if (!first) await navigateWorker(q, job.url);
        else await waitTabLoaded(q.workerTabId, 45000).catch(() => {});
        first = false;
        await XA.util.sleep(1200);
        const result = await sendJobAndAwait(q, job);
        const diag = result.diagnostics || {};
        const found = await persistResult(runId, result);
        const sawRequested = !!diag.sawRequestedId;
        const state = diag.cancelled ? 'paused'
          : !sawRequested && diag.error ? 'failed'
          : diag.incompleteCounter ? 'incomplete'
          : sawRequested ? 'done' : 'failed';
        await XA.db.patchThreadJob(job.id, {
          state,
          postsFound: found || diag.postsFound || 0,
          diagnostics: diag
        });
      } catch (e) {
        await XA.db.patchThreadJob(job.id, {
          state: 'failed',
          diagnostics: { error: String(e && e.message || e), statusId: job.statusId }
        });
      }
    }
    if (q.paused) {
      const remaining = (await XA.db.listThreadJobs(runId))
        .filter((j) => j.state === 'queued' || j.state === 'running');
      for (const j of remaining) {
        await XA.db.patchThreadJob(j.id, { state: 'paused' });
      }
      q.running = false;
      q.currentJobId = null;
      return;
    }
    await finishQueue(runId, q);
  }

  async function startQueue(msg) {
    const { runId, candidateIds } = msg;
    const run = await XA.db.getRun(runId);
    if (!run) return { ok: false, error: 'run not found' };
    if (!['paused', 'completed', 'limited', 'error'].includes(run.state)) {
      return { ok: false, error: 'Pause or finish the primary run before expanding threads' };
    }
    const q = queueFor(runId);
    if (q.running) return { ok: false, error: 'thread queue already running' };
    const jobs = await buildJobs(runId, candidateIds);
    if (!jobs.length) return { ok: false, error: 'no thread candidates found for this run' };
    q.running = true;
    q.paused = false;
    runQueue(runId).catch(() => { q.running = false; });
    return { ok: true, queued: jobs.length };
  }

  async function pauseQueue(msg) {
    const q = queueFor(msg.runId);
    q.paused = true;
    if (q.workerTabId != null && q.currentJobId) {
      try {
        chrome.tabs.sendMessage(q.workerTabId, { type: M().XAR_THREAD_JOB, action: 'cancel' }, () => void chrome.runtime.lastError);
      } catch (_) { /* ignore */ }
    }
    return { ok: true };
  }

  async function statusFor(runId) {
    const q = queueFor(runId);
    const jobs = await XA.db.listThreadJobs(runId);
    return {
      running: q.running,
      paused: q.paused,
      currentJobId: q.currentJobId,
      jobs
    };
  }

  XA.threadService = { startQueue, pauseQueue, statusFor, buildJobs, handleThreadResult, authorForUrl };
})();
