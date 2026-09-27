(function () {
  'use strict';
  const XA = (globalThis.XArchive = globalThis.XArchive || {});
  const M = () => XA.messages.MSG;

  const JOB_TIMEOUT_MS = 120000;
  const LOAD_TIMEOUT_MS = 45000;
  const PACES = {
    cautious: { delayMinMs: 12000, delayMaxMs: 25000, restEvery: 5, restMinMs: 60000, restMaxMs: 120000 },
    balanced: { delayMinMs: 6000, delayMaxMs: 14000, restEvery: 8, restMinMs: 30000, restMaxMs: 60000 },
    brisk: { delayMinMs: 3000, delayMaxMs: 8000, restEvery: 10, restMinMs: 15000, restMaxMs: 30000 }
  };
  const NEXT_PREFIX = 'xar-fulfill-next:';
  const TIMEOUT_PREFIX = 'xar-fulfill-timeout:';
  const dispatching = new Set();
  const missingQuoteUrlCounts = new Map();
  let starting = false;

  function jobId(runId, statusId, kind) {
    return kind === 'quote'
      ? runId + ':quote:' + statusId
      : runId + ':' + statusId;
  }

  function rankConfidence(c) {
    return c === 'high' ? 3 : c === 'medium' ? 2 : c === 'low' ? 1 : 0;
  }

  function authorForUrl(url, fallback) {
    const a = XA.util.authorOfStatusUrl(url);
    if (!a || a.toLowerCase() === 'i') return fallback || null;
    return a;
  }

  function makeCandidate(runId, kind, statusId, url, meta, order) {
    return {
      id: jobId(runId, statusId, kind), runId, kind, statusId,
      url: XA.util.canonicalStatusUrl(url),
      authorHandle: meta.authorHandle || authorForUrl(url, meta.fallbackHandle || null),
      parentPostIds: meta.parentPostIds || [],
      expectedTimestamp: meta.expectedTimestamp || null,
      expectedText: meta.expectedText || '',
      reasons: meta.reasons || [],
      confidence: meta.confidence || null,
      alreadyFulfilled: !!meta.alreadyFulfilled,
      _order: order
    };
  }

  function countMissingQuoteUrls(posts) {
    let count = 0;
    for (const post of posts || []) {
      if (post.quote_context && !XA.util.statusIdFromUrl(post.quote_context.quoted_tweet_url)) count++;
    }
    return count;
  }

  async function buildJobs(runId, candidateIds) {
    const run = await XA.db.getRun(runId);
    const runHandle = run && run.source && run.source.handle
      ? String(run.source.handle).replace(/^@/, '') : null;
    const posts = await XA.db.getPosts(runId);
    missingQuoteUrlCounts.set(runId, countMissingQuoteUrls(posts));
    const candidates = new Map();
    let order = 0;
    const add = (kind, statusId, url, meta) => {
      const key = kind + ':' + statusId;
      const prev = candidates.get(key);
      if (!prev) {
        candidates.set(key, makeCandidate(runId, kind, statusId, url, Object.assign({ fallbackHandle: runHandle }, meta), order));
        return;
      }
      if (kind === 'thread') {
        prev.alreadyFulfilled = prev.alreadyFulfilled || !!meta.alreadyFulfilled;
        if (!prev.url && url) prev.url = XA.util.canonicalStatusUrl(url);
        prev.reasons = XA.util.dedupe([...(prev.reasons || []), ...(meta.reasons || [])]);
        if (rankConfidence(meta.confidence) > rankConfidence(prev.confidence)) prev.confidence = meta.confidence;
        if (!prev.authorHandle) prev.authorHandle = authorForUrl(url, runHandle);
      } else {
        prev.alreadyFulfilled = prev.alreadyFulfilled && !!meta.alreadyFulfilled;
        prev.parentPostIds = XA.util.dedupe([...(prev.parentPostIds || []), ...(meta.parentPostIds || [])]);
        for (const keyName of ['expectedTimestamp', 'expectedText', 'authorHandle']) {
          if (!prev[keyName] && meta[keyName]) prev[keyName] = meta[keyName];
        }
      }
    };

    for (const post of posts) {
      for (const candidate of post.thread_candidates || []) {
        const sid = XA.util.statusIdFromUrl(candidate.url);
        if (!sid) continue;
        add('thread', sid, candidate.url, {
          reasons: [candidate.reason].filter(Boolean), confidence: candidate.confidence,
          alreadyFulfilled: !!post.thread_scraped
        });
      }
      if (post.is_thread && post.thread_id) {
        const sid = XA.util.statusIdFromUrl(post.thread_id);
        if (sid) add('thread', sid, post.thread_id, {
          reasons: ['thread-member'], confidence: 'medium', alreadyFulfilled: !!post.thread_scraped
        });
      }
      const quote = post.quote_context;
      if (quote) {
        const sid = XA.util.statusIdFromUrl(quote.quoted_tweet_url);
        if (sid) {
          add('quote', sid, quote.quoted_tweet_url, {
            parentPostIds: [post.id],
            fallbackHandle: null,
            authorHandle: String(quote.quoted_author_handle || '').replace(/^@/, '') || null,
            expectedTimestamp: quote.quoted_timestamp_iso || null,
            expectedText: quote.quoted_text || '',
            alreadyFulfilled: !!(quote.quoted_fetched || quote.quoted_text_backfilled)
          });
        }
      }
      order++;
    }

    const wanted = candidateIds && candidateIds.length ? new Set(candidateIds.map(String)) : null;
    const jobs = Array.from(candidates.values())
      .filter((candidate) => !wanted || candidate.kind !== 'thread' || wanted.has(candidate.statusId))
      .sort((a, b) => a._order - b._order || (a.kind === b.kind ? 0 : a.kind === 'thread' ? -1 : 1));
    const now = XA.util.nowIso();
    const result = [];
    for (const candidate of jobs) {
      const { _order, alreadyFulfilled, ...data } = candidate;
      const existing = await XA.db.getThreadJob(data.id);
      if (existing) {
        const existingState = existing.state || 'queued';
        const state = ['done', 'skipped'].includes(existingState)
          ? existingState : alreadyFulfilled ? 'done' : existingState;
        const normalized = Object.assign({}, existing, data, {
          kind: existing.kind || data.kind,
          state,
          attempts: existing.attempts || 0,
          postsFound: existing.postsFound || 0,
          diagnostics: existing.diagnostics || null,
          sessionId: existing.sessionId || null,
          createdAt: existing.createdAt || now,
          updatedAt: now,
          completedAt: existing.completedAt || (state === 'done' ? now : null)
        });
        await XA.db.putThreadJob(normalized);
        result.push(normalized);
      } else {
        const job = Object.assign(data, {
          state: alreadyFulfilled ? 'done' : 'queued', attempts: 0, postsFound: 0, diagnostics: null,
          sessionId: null, createdAt: now, updatedAt: now,
          completedAt: alreadyFulfilled ? now : null
        });
        await XA.db.putThreadJob(job);
        result.push(job);
      }
    }
    return result;
  }

  function randomInclusive(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  function delayFor(pace, processed) {
    const preset = PACES[pace] || PACES.cautious;
    if (processed > 0 && processed % preset.restEvery === 0) {
      return randomInclusive(preset.restMinMs, preset.restMaxMs);
    }
    return randomInclusive(preset.delayMinMs, preset.delayMaxMs);
  }

  function alarmName(prefix, runId, sessionId) {
    return prefix + encodeURIComponent(runId) + ':' + encodeURIComponent(sessionId);
  }

  function parseAlarmName(name, prefix) {
    if (!name || !name.startsWith(prefix)) return null;
    const value = name.slice(prefix.length);
    const at = value.lastIndexOf(':');
    if (at < 0) return null;
    try {
      return { runId: decodeURIComponent(value.slice(0, at)), sessionId: decodeURIComponent(value.slice(at + 1)) };
    } catch (_) { return null; }
  }

  async function createAlarm(name, when) {
    if (chrome.alarms && chrome.alarms.create) await chrome.alarms.create(name, { when });
  }

  async function clearAlarm(name) {
    if (chrome.alarms && chrome.alarms.clear) {
      try { await chrome.alarms.clear(name); } catch (_) { /* alarm may already be gone */ }
    }
  }

  async function ensureTimeoutAlarm(runId, sessionId) {
    const name = alarmName(TIMEOUT_PREFIX, runId, sessionId);
    let alarm = null;
    if (chrome.alarms && chrome.alarms.get) {
      try { alarm = await chrome.alarms.get(name); } catch (_) { /* recreate below */ }
    }
    if (!alarm || !Number.isFinite(alarm.scheduledTime) || alarm.scheduledTime <= Date.now()) {
      await createAlarm(name, Date.now() + JOB_TIMEOUT_MS);
    }
  }

  async function clearSessionAlarms(runId, sessionId) {
    await Promise.all([
      clearAlarm(alarmName(NEXT_PREFIX, runId, sessionId)),
      clearAlarm(alarmName(TIMEOUT_PREFIX, runId, sessionId))
    ]);
  }

  async function updateFulfillment(runId, sessionId, fn) {
    return XA.db.patchRun(runId, (run) => {
      const session = run.fulfillment;
      if (!session || session.sessionId !== sessionId) return run;
      const next = Object.assign({}, session);
      fn(next, run);
      next.updatedAt = XA.util.nowIso();
      run.fulfillment = next;
      return run;
    });
  }

  async function selectedJobs(run, jobs) {
    const session = run && run.fulfillment;
    if (!session) return [];
    const byId = new Map(jobs.map((job) => [job.id, job]));
    return (session.selectedJobIds || []).map((id) => byId.get(id)).filter(Boolean);
  }

  async function refreshCounters(runId, sessionId) {
    const run = await XA.db.getRun(runId);
    if (!run || !run.fulfillment || run.fulfillment.sessionId !== sessionId) return null;
    const all = await XA.db.listThreadJobs(runId);
    const jobs = await selectedJobs(run, all);
    const done = jobs.filter((j) => j.state === 'done').length;
    const incomplete = jobs.filter((j) => j.state === 'incomplete').length;
    const failed = jobs.filter((j) => j.state === 'failed').length;
    const processed = done + incomplete + failed;
    return updateFulfillment(runId, sessionId, (session) => {
      session.total = session.selectedJobIds.length;
      session.done = done;
      session.incomplete = incomplete;
      session.failed = failed;
      session.processed = processed;
    });
  }

  async function advanceOrComplete(runId, sessionId, delayMs) {
    const run = await XA.db.getRun(runId);
    if (!run || !run.fulfillment || run.fulfillment.sessionId !== sessionId || run.fulfillment.state !== 'running') return;
    const selected = await selectedJobs(run, await XA.db.listThreadJobs(runId));
    if (selected.some((job) => job.state === 'queued')) await scheduleNext(runId, sessionId, delayMs);
    else await completeSession(runId, sessionId);
  }

  async function scheduleNext(runId, sessionId, delayMs) {
    const when = Date.now() + Math.max(0, delayMs || 0);
    const run = await updateFulfillment(runId, sessionId, (session) => {
      if (session.state === 'running' && !session.currentJobId) session.nextAt = new Date(when).toISOString();
    });
    if (run && run.fulfillment && run.fulfillment.state === 'running' && !run.fulfillment.currentJobId) {
      await createAlarm(alarmName(NEXT_PREFIX, runId, sessionId), when);
    }
  }

  function sendTabMessage(tabId, message) {
    return new Promise((resolve, reject) => {
      try {
        const result = chrome.tabs.sendMessage(tabId, message, (response) => {
          const error = chrome.runtime && chrome.runtime.lastError;
          if (error) reject(new Error(error.message));
          else resolve(response);
        });
        if (result && typeof result.then === 'function') result.then(resolve, reject);
      } catch (error) { reject(error); }
    });
  }

  function getTab(tabId) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn, value) => { if (!settled) { settled = true; fn(value); } };
      try {
        const result = chrome.tabs.get(tabId, (tab) => {
          const error = chrome.runtime && chrome.runtime.lastError;
          if (error) finish(reject, new Error(error.message));
          else finish(resolve, tab);
        });
        if (result && typeof result.then === 'function') result.then((tab) => finish(resolve, tab), (e) => finish(reject, e));
      } catch (error) { finish(reject, error); }
    });
  }

  function updateTab(tabId, props) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn, value) => { if (!settled) { settled = true; fn(value); } };
      try {
        const result = chrome.tabs.update(tabId, props, (tab) => {
          const error = chrome.runtime && chrome.runtime.lastError;
          if (error) finish(reject, new Error(error.message));
          else finish(resolve, tab);
        });
        if (result && typeof result.then === 'function') result.then((tab) => finish(resolve, tab), (e) => finish(reject, e));
      } catch (error) { finish(reject, error); }
    });
  }

  function waitTabLoaded(tabId, timeoutMs) {
    return new Promise((resolve, reject) => {
      let finished = false;
      const done = (err) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        if (chrome.tabs.onUpdated) chrome.tabs.onUpdated.removeListener(listener);
        if (err) reject(err); else resolve();
      };
      const listener = (updatedTabId, info) => {
        if (updatedTabId === tabId && info.status === 'complete') done();
      };
      const timer = setTimeout(() => done(new Error('tab load timeout')), timeoutMs || LOAD_TIMEOUT_MS);
      if (chrome.tabs.onUpdated) chrome.tabs.onUpdated.addListener(listener);
      getTab(tabId).then((tab) => { if (tab && tab.status === 'complete') done(); }).catch(() => {});
    });
  }

  async function workerTabFor(run, firstUrl) {
    const fulfillment = run.fulfillment || {};
    if (fulfillment.workerTabId != null) {
      try {
        const tab = await getTab(fulfillment.workerTabId);
        if (tab) return { tabId: fulfillment.workerTabId, windowId: fulfillment.workerWindowId };
      } catch (_) { /* tab was closed; create only while session remains active */ }
    }
    const win = await chrome.windows.create({ url: firstUrl, focused: true, type: 'normal' });
    let tabId = win.tabs && win.tabs[0] && win.tabs[0].id;
    if (tabId == null) {
      const tabs = await chrome.tabs.query({ windowId: win.id });
      tabId = tabs[0] && tabs[0].id;
    }
    if (tabId == null) throw new Error('worker window did not create a tab');
    await updateFulfillment(run.id, fulfillment.sessionId, (session) => {
      session.workerTabId = tabId;
      session.workerWindowId = win.id;
    });
    return { tabId, windowId: win.id };
  }

  async function navigateWorker(tabId, url) {
    await updateTab(tabId, { url, active: true });
    await waitTabLoaded(tabId, LOAD_TIMEOUT_MS);
    await XA.util.sleep(1500);
  }

  function dispatchStillActive(run, sessionId, jobIdValue, tabId) {
    const session = run && run.fulfillment;
    return !!(session && session.sessionId === sessionId && session.state === 'running' &&
      session.currentJobId === jobIdValue && session.workerTabId === tabId);
  }

  async function restoreUndispatched(runId, sessionId, jobIdValue) {
    const run = await XA.db.getRun(runId);
    const session = run && run.fulfillment;
    const sameSession = session && session.sessionId === sessionId;
    const job = await XA.db.getThreadJob(jobIdValue);
    if (job && job.sessionId === sessionId && job.state === 'running') {
      await XA.db.patchThreadJob(jobIdValue, {
        state: sameSession && session.state === 'paused' ? 'paused' : 'queued',
        completedAt: null
      });
    }
    if (sameSession && session.currentJobId === jobIdValue) {
      await updateFulfillment(runId, sessionId, (active) => {
        active.currentJobId = null;
        active.nextAt = null;
      });
    }
    await clearAlarm(alarmName(TIMEOUT_PREFIX, runId, sessionId));
    const latest = await XA.db.getRun(runId);
    if (latest && latest.fulfillment && latest.fulfillment.sessionId === sessionId &&
        latest.fulfillment.state === 'running' && !latest.fulfillment.currentJobId) {
      await advanceOrComplete(runId, sessionId, 0);
    }
  }

  async function completeSession(runId, sessionId) {
    await clearSessionAlarms(runId, sessionId);
    const run = await XA.db.getRun(runId);
    if (!run || !run.fulfillment || run.fulfillment.sessionId !== sessionId) return;
    const completedAt = XA.util.nowIso();
    const finished = await XA.db.patchRun(runId, (r) => {
      if (!r.fulfillment || r.fulfillment.sessionId !== sessionId) return r;
      r.fulfillment = Object.assign({}, r.fulfillment, {
        state: 'completed', currentJobId: null, nextAt: null,
        pauseReason: null, completedAt, updatedAt: completedAt
      });
      r.threadSummary = {
        total: r.fulfillment.total,
        done: r.fulfillment.done,
        incomplete: r.fulfillment.incomplete,
        failed: r.fulfillment.failed,
        finishedAt: completedAt
      };
      return r;
    });
    const f = finished && finished.fulfillment;
    if (f && f.workerTabId != null) {
      try {
        await updateTab(f.workerTabId, {
          url: chrome.runtime.getURL('src/options/options.html') + '#run/' + runId,
          active: true
        });
      } catch (_) { /* worker tab may have been closed */ }
    }
  }

  async function dispatchNext(runId, sessionId) {
    if (dispatching.has(sessionId)) return;
    dispatching.add(sessionId);
    try {
      let run = await XA.db.getRun(runId);
      if (!run || !run.fulfillment || run.fulfillment.sessionId !== sessionId || run.fulfillment.state !== 'running') return;
      if (run.fulfillment.currentJobId) return;
      let jobs = await XA.db.listThreadJobs(runId);
      let selected = await selectedJobs(run, jobs);
      const orphaned = selected.find((job) => job.state === 'running' && job.sessionId === sessionId);
      if (orphaned) {
        await XA.db.patchThreadJob(orphaned.id, { state: 'queued' });
        jobs = await XA.db.listThreadJobs(runId);
        selected = await selectedJobs(run, jobs);
      }
      const eligible = selected.find((job) => job.state === 'queued');
      if (!eligible) { await completeSession(runId, sessionId); return; }
      let worker;
      try {
        worker = await workerTabFor(run, eligible.url);
        run = await XA.db.getRun(runId);
        if (!run || run.fulfillment.state !== 'running' || run.fulfillment.sessionId !== sessionId) return;
        if (run.fulfillment.currentJobId) return;
        if (run.fulfillment.workerTabId !== worker.tabId) return;
        const tab = await getTab(worker.tabId);
        if (!tab || tab.url !== eligible.url) await navigateWorker(worker.tabId, eligible.url);
        else await waitTabLoaded(worker.tabId, LOAD_TIMEOUT_MS).catch(() => {});
        run = await XA.db.getRun(runId);
        if (!run || !run.fulfillment || run.fulfillment.sessionId !== sessionId ||
            run.fulfillment.state !== 'running' || run.fulfillment.currentJobId ||
            run.fulfillment.workerTabId !== worker.tabId) return;
        let markedRunning = false;
        await XA.db.patchThreadJob(eligible.id, (job) => {
          if (job.sessionId !== sessionId || job.state !== 'queued') return job;
          markedRunning = true;
          return Object.assign(job, {
            kind: job.kind || eligible.kind,
            state: 'running', attempts: (job.attempts || 0) + 1,
            completedAt: null,
            diagnostics: job.diagnostics || null
          });
        });
        if (!markedRunning) return;
        let claimed = false;
        await XA.db.patchRun(runId, (stored) => {
          const session = stored.fulfillment;
          if (session && session.sessionId === sessionId && session.state === 'running' &&
              !session.currentJobId && session.workerTabId === worker.tabId) {
            stored.fulfillment = Object.assign({}, session, {
              currentJobId: eligible.id,
              workerWindowId: worker.windowId,
              nextAt: null
            });
            claimed = true;
          }
          return stored;
        });
        if (!claimed) {
          await restoreUndispatched(runId, sessionId, eligible.id);
          return;
        }
        await createAlarm(alarmName(TIMEOUT_PREFIX, runId, sessionId), Date.now() + JOB_TIMEOUT_MS);
        const ready = await XA.db.getRun(runId);
        if (!dispatchStillActive(ready, sessionId, eligible.id, worker.tabId)) {
          await restoreUndispatched(runId, sessionId, eligible.id);
          return;
        }
        try {
          await sendTabMessage(worker.tabId, {
            type: M().XAR_THREAD_JOB,
            job: {
              id: eligible.id, sessionId, kind: eligible.kind || 'thread', statusId: eligible.statusId,
              url: eligible.url, authorHandle: eligible.authorHandle,
              expectedTimestamp: eligible.expectedTimestamp || null,
              expectedText: eligible.expectedText || ''
            }
          });
        } catch (error) {
          await resolveFailure(runId, sessionId, eligible, error);
        }
      } catch (error) {
        await resolveFailure(runId, sessionId, eligible, error);
      }
    } finally {
      dispatching.delete(sessionId);
    }
  }

  async function resolveFailure(runId, sessionId, job, error) {
    const run = await XA.db.getRun(runId);
    if (!run || !run.fulfillment || run.fulfillment.sessionId !== sessionId ||
        run.fulfillment.state !== 'running' ||
        (run.fulfillment.currentJobId && run.fulfillment.currentJobId !== job.id)) return;
    const storedJob = await XA.db.getThreadJob(job.id);
    if (!storedJob || storedJob.sessionId !== sessionId ||
        (run.fulfillment.currentJobId === job.id && storedJob.state !== 'running') ||
        (!run.fulfillment.currentJobId && storedJob.state !== 'queued')) return;
    const diagnostics = Object.assign({}, job.diagnostics, { error: String(error && error.message || error), statusId: job.statusId });
    await XA.db.patchThreadJob(job.id, { state: 'failed', diagnostics, completedAt: XA.util.nowIso() });
    await updateFulfillment(runId, sessionId, (session) => { session.currentJobId = null; });
    await clearAlarm(alarmName(TIMEOUT_PREFIX, runId, sessionId));
    const refreshed = await refreshCounters(runId, sessionId);
    if (refreshed && refreshed.fulfillment.state === 'running') {
      await advanceOrComplete(runId, sessionId, delayFor(refreshed.fulfillment.pace, refreshed.fulfillment.processed));
    }
  }

  async function persistThreadResult(runId, job, result, diag) {
    const posts = (result.posts || []).map((post) => XA.postModel.normalizePost(post, { captureContext: 'thread' }));
    if (posts.length) {
      await XA.db.upsertPosts(runId, posts);
      missingQuoteUrlCounts.delete(runId);
    }
    const found = posts.length || diag.postsFound || 0;
    const saw = !!diag.sawRequestedId && posts.some((post) => post.id === job.statusId);
    const state = diag.cancelled ? 'paused'
      : diag.incompleteCounter ? 'incomplete'
      : saw ? 'done'
      : diag.error ? 'failed' : 'incomplete';
    return { state, found, diagnostics: diag };
  }

  function fetchedQuoteContext(post) {
    return {
      quoted_tweet_url: post.tweet_url,
      quoted_author_name: post.name,
      quoted_author_handle: post.handle,
      quoted_profile_url: post.profile_url,
      quoted_avatar_url: post.avatar_url,
      quoted_timestamp_iso: post.timestamp_iso,
      quoted_date_displayed: post.date_displayed,
      quoted_text: post.text,
      quoted_images: post.images || [],
      quoted_videos: post.videos || [],
      quoted_fetched: true,
      quoted_fetched_at: XA.util.nowIso()
    };
  }

  async function persistQuoteResult(runId, job, result, diag) {
    const exact = (result.posts || []).map((post) => XA.postModel.normalizePost(post, {}))
      .find((post) => post.id === job.statusId &&
        XA.util.statusIdFromUrl(post.tweet_url) === job.statusId);
    const safelyIdentified = !!(exact && diag.sawRequestedId);
    if (!safelyIdentified) {
      return { state: diag.cancelled ? 'paused' : 'failed', found: 0, diagnostics: Object.assign({}, diag, {
        error: diag.error || 'requested quoted post was not safely identified'
      }) };
    }
    const fetched = fetchedQuoteContext(exact);
    const existingPosts = await XA.db.getPosts(runId);
    const byId = new Map(existingPosts.map((post) => [post.id, post]));
    const parentUpdates = [];
    for (const parentId of job.parentPostIds || []) {
      const parent = byId.get(parentId);
      if (!parent || !parent.tweet_url) continue;
      const sparse = XA.postModel.normalizePost({
        tweet_url: parent.tweet_url,
        quote_context: fetched
      }, {
        captureContext: parent.capture_context,
        sourceKey: parent.source_key,
        sourceType: parent.source_type
      });
      parentUpdates.push(sparse);
    }
    if (parentUpdates.length) await XA.db.upsertPosts(runId, parentUpdates);
    const diagnostics = Object.assign({}, diag);
    if (!parentUpdates.length) diagnostics.warning = 'No referring parent posts were available to enrich';
    return { state: 'done', found: 1, diagnostics };
  }

  async function pauseBlocked(runId, sessionId, reason) {
    await updateFulfillment(runId, sessionId, (session) => {
      session.state = 'paused';
      session.pauseReason = reason || 'X showed a blocked surface';
      session.currentJobId = null;
      session.nextAt = null;
    });
    await clearSessionAlarms(runId, sessionId);
  }

  async function handleThreadResult(msg, sender) {
    const runId = msg && msg.runId;
    let jobIdValue = msg && msg.jobId;
    if (!jobIdValue) return { ok: false, error: 'missing job id' };
    const job = await XA.db.getThreadJob(jobIdValue);
    if (!job) return { ok: true, ignored: true };
    const run = await XA.db.getRun(runId || job.runId);
    if (!run || !run.fulfillment || !run.fulfillment.sessionId ||
        msg.sessionId !== run.fulfillment.sessionId ||
        run.fulfillment.currentJobId !== job.id || job.sessionId !== run.fulfillment.sessionId ||
        !['running', 'paused'].includes(run.fulfillment.state)) {
      return { ok: true, ignored: true };
    }
    if (sender && sender.tab && run.fulfillment.workerTabId != null && sender.tab.id !== run.fulfillment.workerTabId) {
      return { ok: true, ignored: true };
    }
    const diag = Object.assign({ kind: job.kind || 'thread', statusId: job.statusId }, msg.diagnostics || {});
    const result = (job.kind || 'thread') === 'quote'
      ? await persistQuoteResult(job.runId, job, msg, diag)
      : await persistThreadResult(job.runId, job, msg, diag);
    const completedAt = XA.util.nowIso();
    await XA.db.patchThreadJob(job.id, {
      kind: job.kind || 'thread', state: result.state, postsFound: result.found,
      diagnostics: result.diagnostics, completedAt: result.state === 'done' ? completedAt : null
    });
    await clearAlarm(alarmName(TIMEOUT_PREFIX, job.runId, run.fulfillment.sessionId));

    if (diag.cancelled && run.fulfillment.state === 'paused') {
      await XA.db.patchThreadJob(job.id, { state: 'paused', completedAt: null });
      await updateFulfillment(job.runId, run.fulfillment.sessionId, (session) => {
        session.currentJobId = null;
        session.nextAt = null;
      });
      await refreshCounters(job.runId, run.fulfillment.sessionId);
      return { ok: true, paused: true };
    }

    await updateFulfillment(job.runId, run.fulfillment.sessionId, (session) => { session.currentJobId = null; });
    const refreshed = await refreshCounters(job.runId, run.fulfillment.sessionId);
    if (diag.blockedReason) {
      await pauseBlocked(job.runId, run.fulfillment.sessionId, diag.blockedReason);
      return { ok: true, paused: true, reason: diag.blockedReason };
    }
    if (refreshed && refreshed.fulfillment.state === 'running') {
      const next = delayFor(refreshed.fulfillment.pace, refreshed.fulfillment.processed);
      await advanceOrComplete(job.runId, run.fulfillment.sessionId, next);
    }
    return { ok: true, state: result.state };
  }

  async function handleAlarm(alarm) {
    if (!alarm || !alarm.name) return;
    const next = parseAlarmName(alarm.name, NEXT_PREFIX);
    if (next) {
      await dispatchNext(next.runId, next.sessionId);
      return;
    }
    const timeout = parseAlarmName(alarm.name, TIMEOUT_PREFIX);
    if (!timeout) return;
    const run = await XA.db.getRun(timeout.runId);
    if (!run || !run.fulfillment || run.fulfillment.sessionId !== timeout.sessionId || !run.fulfillment.currentJobId) return;
    const job = await XA.db.getThreadJob(run.fulfillment.currentJobId);
    if (!job || job.state !== 'running' || job.sessionId !== timeout.sessionId) {
      await updateFulfillment(timeout.runId, timeout.sessionId, (session) => { session.currentJobId = null; });
      await clearAlarm(alarmName(TIMEOUT_PREFIX, timeout.runId, timeout.sessionId));
      const recovered = await refreshCounters(timeout.runId, timeout.sessionId);
      if (recovered && recovered.fulfillment.state === 'running') {
        await scheduleNext(timeout.runId, timeout.sessionId, 0);
      }
      return;
    }
    await XA.db.patchThreadJob(job.id, {
      state: run.fulfillment.state === 'paused' ? 'paused' : 'failed',
      diagnostics: Object.assign({}, job.diagnostics, { error: 'job timed out after 120 seconds', statusId: job.statusId }),
      completedAt: null
    });
    await updateFulfillment(timeout.runId, timeout.sessionId, (session) => { session.currentJobId = null; });
    const refreshed = await refreshCounters(timeout.runId, timeout.sessionId);
    if (refreshed && refreshed.fulfillment.state === 'running') {
      await advanceOrComplete(timeout.runId, timeout.sessionId,
        delayFor(refreshed.fulfillment.pace, refreshed.fulfillment.processed));
    }
  }

  async function startQueue(msg) {
    if (starting) return { ok: false, error: 'another fulfillment session is starting' };
    starting = true;
    try {
      const runId = msg.runId;
      const run = await XA.db.getRun(runId);
      if (!run) return { ok: false, error: 'run not found' };
      if (run.fulfillment && run.fulfillment.state === 'paused' && run.fulfillment.currentJobId) {
        return { ok: false, error: 'current page is still finishing' };
      }
      if (!['paused', 'completed', 'limited', 'error'].includes(run.state)) {
        return { ok: false, error: 'Pause or finish the primary archive run before building upon it' };
      }
      const allRuns = await XA.db.listRuns({});
      const active = allRuns.find((candidate) => candidate.fulfillment && (
        candidate.fulfillment.state === 'running' || !!candidate.fulfillment.currentJobId
      ));
      if (active) return { ok: false, error: active.id === runId
        ? 'this archive already has an active fulfillment session'
        : active.fulfillment.currentJobId
          ? 'another archive is still finishing its current page'
          : 'another archive has an active fulfillment session' };

      const legacyIds = msg.candidateIds && msg.candidateIds.length ? msg.candidateIds : null;
      const kinds = Array.isArray(msg.kinds) && msg.kinds.length
        ? XA.util.dedupe(msg.kinds.filter((kind) => ['thread', 'quote'].includes(kind)))
        : (legacyIds ? ['thread'] : ['thread', 'quote']);
      const maxJobs = XA.util.clamp(Number.isFinite(Number(msg.maxJobs)) ? Math.round(Number(msg.maxJobs)) : 10, 1, 100);
      const pace = Object.prototype.hasOwnProperty.call(PACES, msg.pace) ? msg.pace : 'cautious';
      const built = await buildJobs(runId, legacyIds);
      const scoped = built.filter((job) => kinds.includes(job.kind));
      if (!scoped.length) return { ok: false, error: 'no candidates' };
      const eligible = scoped.filter((job) => !['done', 'skipped'].includes(job.state));
      const selected = eligible.slice(0, maxJobs);
      if (!selected.length) return { ok: false, error: 'all selected candidates already fulfilled' };
      const sessionId = XA.util.uid('fulfill');
      const now = XA.util.nowIso();
      for (const job of selected) {
        await XA.db.patchThreadJob(job.id, {
          kind: job.kind || 'thread', state: 'queued', sessionId,
          diagnostics: job.diagnostics || null, completedAt: null
        });
      }
      const session = {
        state: 'running', sessionId, kinds, pace, maxJobs,
        selectedJobIds: selected.map((job) => job.id), total: selected.length,
        processed: 0, done: 0, incomplete: 0, failed: 0,
        currentJobId: null,
        workerTabId: run.fulfillment && run.fulfillment.workerTabId || null,
        workerWindowId: run.fulfillment && run.fulfillment.workerWindowId || null,
        nextAt: null, pauseReason: null, startedAt: now, updatedAt: now, completedAt: null
      };
      await XA.db.patchRun(runId, (r) => { r.fulfillment = session; return r; });
      await scheduleNext(runId, sessionId, 0);
      return { ok: true, queued: selected.length, session };
    } finally {
      starting = false;
    }
  }

  async function pauseQueue(msg) {
    const run = await XA.db.getRun(msg.runId);
    const session = run && run.fulfillment;
    if (!session || session.state !== 'running') return { ok: true, paused: false };
    await updateFulfillment(msg.runId, session.sessionId, (next) => {
      next.state = 'paused';
      next.pauseReason = 'Paused after current page';
      next.nextAt = null;
    });
    await clearAlarm(alarmName(NEXT_PREFIX, msg.runId, session.sessionId));
    const pausedRun = await XA.db.getRun(msg.runId);
    const paused = pausedRun && pausedRun.fulfillment;
    if (paused && paused.sessionId === session.sessionId && paused.currentJobId) {
      await ensureTimeoutAlarm(msg.runId, session.sessionId);
    } else {
      await clearAlarm(alarmName(TIMEOUT_PREFIX, msg.runId, session.sessionId));
    }
    return { ok: true, paused: true };
  }

  async function statusFor(runId, refreshCandidates) {
    const run = await XA.db.getRun(runId);
    if (run && refreshCandidates) await buildJobs(runId);
    const jobs = await XA.db.listThreadJobs(runId);
    let missingQuoteUrls = missingQuoteUrlCounts.get(runId);
    if (missingQuoteUrls === undefined) {
      missingQuoteUrls = countMissingQuoteUrls(await XA.db.getPosts(runId));
      missingQuoteUrlCounts.set(runId, missingQuoteUrls);
    }
    const fulfillment = run && run.fulfillment || null;
    const enrichedJobs = jobs.map((job) => Object.assign({}, job, { kind: job.kind || 'thread' }));
    const threadCandidates = enrichedJobs.filter((job) => job.kind === 'thread').length;
    const quoteCandidates = enrichedJobs.filter((job) => job.kind === 'quote').length;
    const done = enrichedJobs.filter((job) => job.state === 'done').length;
    const failed = enrichedJobs.filter((job) => job.state === 'failed').length;
    const incomplete = enrichedJobs.filter((job) => job.state === 'incomplete').length;
    const remaining = enrichedJobs.filter((job) => !['done', 'skipped'].includes(job.state)).length;
    return {
      running: !!(fulfillment && fulfillment.state === 'running'),
      paused: !!(fulfillment && fulfillment.state === 'paused'),
      currentJobId: fulfillment && fulfillment.currentJobId || null,
      fulfillment,
      threadCandidates, quoteCandidates,
      missingQuoteUrls,
      done, remaining, failed, incomplete,
      jobs: enrichedJobs
    };
  }

  async function tabRemoved(tabId) {
    const runs = await XA.db.listRuns({});
    for (const run of runs) {
      const session = run.fulfillment;
      if (!session || !['running', 'paused'].includes(session.state) || session.workerTabId !== tabId ||
          (session.state === 'paused' && !session.currentJobId)) continue;
      await clearSessionAlarms(run.id, session.sessionId);
      if (session.currentJobId) {
        await XA.db.patchThreadJob(session.currentJobId, {
          state: 'paused', diagnostics: Object.assign({},
            (await XA.db.getThreadJob(session.currentJobId) || {}).diagnostics,
            { error: 'worker tab closed' }), completedAt: null
        });
      }
      await updateFulfillment(run.id, session.sessionId, (next) => {
        next.state = 'paused';
        next.pauseReason = 'worker tab closed';
        next.currentJobId = null;
        next.workerTabId = null;
        next.workerWindowId = null;
        next.nextAt = null;
      });
    }
  }

  async function recoverQueues() {
    const runs = await XA.db.listRuns({});
    for (const run of runs) {
      const session = run.fulfillment;
      if (!session || session.state !== 'running') continue;
      if (!session.currentJobId) {
        const jobs = await XA.db.listThreadJobs(run.id);
        for (const job of jobs) {
          if ((session.selectedJobIds || []).includes(job.id) && job.sessionId === session.sessionId && job.state === 'running') {
            await XA.db.patchThreadJob(job.id, { state: 'queued' });
          }
        }
        const nextName = alarmName(NEXT_PREFIX, run.id, session.sessionId);
        let nextAlarm = null;
        if (chrome.alarms && chrome.alarms.get) {
          try { nextAlarm = await chrome.alarms.get(nextName); } catch (_) { /* recreate below */ }
        }
        if (!nextAlarm || !Number.isFinite(nextAlarm.scheduledTime) || nextAlarm.scheduledTime <= Date.now()) {
          const scheduledAt = Date.parse(session.nextAt || '');
          await scheduleNext(run.id, session.sessionId,
            Number.isFinite(scheduledAt) ? Math.max(0, scheduledAt - Date.now()) : 0);
        }
        continue;
      }
      const current = await XA.db.getThreadJob(session.currentJobId);
      if (!current || current.state !== 'running' || current.sessionId !== session.sessionId) {
        await updateFulfillment(run.id, session.sessionId, (active) => { active.currentJobId = null; });
        await scheduleNext(run.id, session.sessionId, 0);
        continue;
      }
      const name = alarmName(TIMEOUT_PREFIX, run.id, session.sessionId);
      let timeout = null;
      if (chrome.alarms && chrome.alarms.get) {
        try { timeout = await chrome.alarms.get(name); } catch (_) { /* recreate below */ }
      }
      if (!timeout || !Number.isFinite(timeout.scheduledTime) || timeout.scheduledTime <= Date.now()) {
        await createAlarm(name, Date.now() + JOB_TIMEOUT_MS);
      }
    }
  }

  const service = {
    buildJobs, startQueue, pauseQueue, statusFor, handleThreadResult,
    handleAlarm, tabRemoved, recoverQueues, authorForUrl,
    countMissingQuoteUrls, delayFor, randomInclusive, PACES,
    persistQuoteResult, fetchedQuoteContext, resolveFailure, alarmName
  };
  XA.fulfillmentService = service;
  XA.threadService = service;
})();
