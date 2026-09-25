(function () {
  'use strict';
  const XA = (globalThis.XArchive = globalThis.XArchive || {});
  XA.content = XA.content || {};
  const M = () => XA.messages.MSG;

  const TERMINAL_STATES = ['completed', 'limited', 'error'];

  class ScraperController {
    constructor() {
      this.run = null;
      this.settings = null;
      this.state = 'idle';
      this.stopReason = null;
      this.message = '';
      this.timer = null;
      this.restTimer = null;
      this.collected = new Map();
      this.pendingPosts = [];
      this.prevTail = null;
      this.activeSegmentStart = null;
      this.activeElapsedMs = 0;
      this.stallMs = 0;
      this.stallWindowStart = null;
      this.recoveryAttempts = 0;
      this.lastScrollHeight = 0;
      this.postsSinceRest = 0;
      this.restUntil = null;
      this.snapshotCount = 0;
      this.persistedCount = 0;
      this.pendingRun = null;
      this.overlay = null;
      this.countTick = 0;
    }

    currentSource() {
      return XA.sourceDetector.detectSource({
        pathname: location.pathname,
        search: location.search
      });
    }

    sourceMatches() {
      if (!this.run) return false;
      const src = this.currentSource();
      return src.key === this.run.source.key;
    }

    now() { return Date.now(); }

    tickDelay() {
      const s = this.settings;
      if (!s.randomize) return Math.round((s.tickDelayMinMs + s.tickDelayMaxMs) / 2);
      return XA.util.randInt(s.tickDelayMinMs, s.tickDelayMaxMs);
    }

    scrollAmount() {
      const s = this.settings;
      if (!s.randomize) return Math.round((s.scrollMinPx + s.scrollMaxPx) / 2);
      return XA.util.randInt(s.scrollMinPx, s.scrollMaxPx);
    }

    restDuration() {
      const s = this.settings;
      if (!s.randomize) return Math.round((s.restMinMs + s.restMaxMs) / 2);
      return XA.util.randInt(s.restMinMs, s.restMaxMs);
    }

    sendToBackground(msg) {
      return new Promise((resolve, reject) => {
        try {
          chrome.runtime.sendMessage(msg, (resp) => {
            const err = chrome.runtime.lastError;
            if (err) reject(new Error(err.message));
            else resolve(resp);
          });
        } catch (e) { reject(e); }
      });
    }

    reportState() {
      const runtime = this.runtimeSnapshot();
      this.sendToBackground({
        type: M().XAR_STATE,
        runId: this.run ? this.run.id : null,
        state: this.state,
        stopReason: this.stopReason,
        runtime
      }).catch(() => {});
      this.updateOverlay(runtime);
    }

    runtimeSnapshot() {
      return {
        state: this.state,
        stopReason: this.stopReason,
        posts: Math.max(this.persistedCount, this.collected.size),
        activeElapsedMs: this.elapsed(),
        restRemainingMs: this.state === 'resting' && this.restUntil
          ? Math.max(0, this.restUntil - this.now()) : null,
        stallMs: this.currentStallMs(),
        message: this.message,
        source: this.run ? this.run.source : this.currentSource()
      };
    }

    elapsed() {
      let ms = this.activeElapsedMs;
      if (this.activeSegmentStart != null && this.state !== 'paused' && this.state !== 'idle') {
        ms += this.now() - this.activeSegmentStart;
      }
      return ms;
    }

    updateOverlay(runtime) {
      if (!this.settings || !this.settings.showOverlay) {
        if (this.overlay) this.overlay.remove();
        return;
      }
      if (!this.overlay) {
        this.overlay = new XA.content.Overlay({
          onPause: () => this.pause('manual'),
          onResume: () => this.resumeFromOverlay(),
          onStop: () => this.stop('manual'),
          onExport: () => this.exportNow()
        });
      }
      if (!this.overlay.visible) this.overlay.show();
      this.overlay.update(runtime || this.runtimeSnapshot());
    }

    resumeFromOverlay() {
      if (!this.run) return;
      this.sendToBackground({ type: M().RESUME_RUN, runId: this.run.id, tabId: null }).catch(() => {});
    }

    exportNow() {
      if (!this.run) return;
      const formats = (this.settings && this.settings.exportFormats) || ['json', 'html'];
      this.sendToBackground({ type: M().EXPORT_RUN, runId: this.run.id, formats, media: false }).catch(() => {});
    }

    async start(run, settings) {
      this.run = run;
      this.settings = settings;
      this.state = 'running';
      this.stopReason = null;
      this.message = '';
      this.activeSegmentStart = this.now();
      this.activeElapsedMs = run.runtime && run.runtime.activeElapsedMs ? run.runtime.activeElapsedMs : 0;
      this.persistedCount = run.stats && run.stats.posts ? run.stats.posts : 0;
      this.lastScrollHeight = this.scrollHeight();
      this.stallMs = 0;
      this.recoveryAttempts = 0;
      this.reportState();
      await this.tick();
      this.schedule();
    }

    schedule() {
      if (this.state !== 'running') return;
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(() => {
        this.timer = null;
        if (this.state === 'running') {
          this.tick().finally(() => this.schedule());
        }
      }, this.tickDelay());
    }

    scrollHeight() {
      const el = document.scrollingElement || document.documentElement;
      return el ? el.scrollHeight : 0;
    }

    doScroll(px) {
      const el = document.scrollingElement || document.documentElement;
      if (el && el.scrollBy) el.scrollBy(0, px);
      else window.scrollBy(0, px);
    }

    async tick() {
      if (!this.run) return;
      if (this.state === 'resting') return;

      if (!this.sourceMatches()) {
        await this.pauseWithReason('source_changed', 'Page route changed — run paused');
        return;
      }

      if (document.hidden || (typeof navigator !== 'undefined' && navigator.onLine === false)) {
        this.stallWindowStart = this.now();
        this.message = document.hidden ? 'Tab hidden — waiting (stall timer frozen)' : 'Offline — waiting';
        this.reportState();
        return;
      }
      this.message = '';

      const duration = this.settings.maxActiveDurationMs;
      if (duration && this.elapsed() >= duration) {
        await this.finish('limited', 'max_duration', 'Active time limit reached');
        return;
      }

      const extraction = XA.extractor.extractVisible(document, {
        author: this.run.source.handle,
        captureContext: 'timeline',
        sourceKey: this.run.source.key,
        sourceType: this.run.source.type,
        autoExpandText: this.settings.autoExpandText,
        prevTail: this.prevTail
      });
      this.prevTail = extraction.tail || this.prevTail;

      const batch = this.absorbBatch(extraction.posts);
      if (batch.length) {
        const ok = await this.flushBatch();
        if (!ok) return;
      }

      if (this.reachedOldestDate()) {
        await this.finish('limited', 'oldest_date', 'Oldest date reached');
        return;
      }
      const maxPosts = this.settings.maxPosts;
      if (maxPosts && Math.max(this.persistedCount, this.collected.size) >= maxPosts) {
        await this.finish('limited', 'max_posts', 'Post limit reached');
        return;
      }

      this.maybeSnapshot();

      const newCount = batch.length;
      this.postsSinceRest += newCount;
      const height = this.scrollHeight();
      const progressed = newCount > 0 || height !== this.lastScrollHeight;
      this.lastScrollHeight = height;
      if (progressed) {
        this.stallMs = 0;
        this.stallWindowStart = null;
        this.recoveryAttempts = 0;
      }

      if (this.postsSinceRest >= this.settings.restEveryPosts) {
        this.postsSinceRest = 0;
        await this.enterRest();
        return;
      }

      if (!progressed) {
        if (this.stallWindowStart == null) this.stallWindowStart = this.now();
        const stalled = this.currentStallMs();
        if (stalled >= this.settings.stallTimeoutMs) {
          if (this.recoveryAttempts < this.settings.stallRecoveryAttempts) {
            this.recoveryAttempts += 1;
            this.stallWindowStart = this.now();
            this.message = 'No new posts — recovery nudge ' + this.recoveryAttempts;
            this.reportState();
            this.doScroll(-Math.round(this.scrollAmount() / 2));
            this.doScroll(this.scrollAmount());
            return;
          }
          if (this.errorSurfaceVisible()) {
            await this.finish('error', 'error', 'X is showing an error/retry surface');
            return;
          }
          await this.finish('completed', 'completed', 'Bottom of timeline reached');
          return;
        }
      }

      if (this.settings.autoScroll) this.doScroll(this.scrollAmount());
      this.reportState();
    }

    currentStallMs() {
      let ms = this.stallMs;
      if (this.stallWindowStart != null && this.state === 'running') {
        ms += this.now() - this.stallWindowStart;
      }
      return ms;
    }

    freezeStall() {
      if (this.stallWindowStart != null) {
        this.stallMs += this.now() - this.stallWindowStart;
        this.stallWindowStart = null;
      }
    }

    errorSurfaceVisible() {
      const probe = document.querySelector('[data-testid="error-detail"], [data-testid="emptyState"]');
      if (!probe) return false;
      const txt = (XA.util.textOf(probe) || '').toLowerCase();
      return /something went wrong|try again|error/i.test(txt);
    }

    absorbBatch(posts) {
      const batch = [];
      for (const p of posts) {
        if (!p || !p.id) continue;
        const old = this.collected.get(p.id);
        const merged = old ? XA.postModel.mergePosts(old, p) : p;
        if (!old || JSON.stringify(merged) !== JSON.stringify(old)) {
          this.collected.set(p.id, merged);
          batch.push(merged);
        }
      }
      this.pendingPosts.push(...batch);
      return batch;
    }

    async flushBatch() {
      if (!this.pendingPosts.length) return true;
      const posts = this.pendingPosts;
      this.pendingPosts = [];
      try {
        const resp = await this.sendToBackground({
          type: M().UPSERT_POSTS,
          runId: this.run.id,
          posts,
          runtime: this.runtimeSnapshot()
        });
        if (!resp || resp.ok === false) throw new Error((resp && resp.error) || 'upsert rejected');
        if (resp.count != null) this.persistedCount = resp.count;
        return true;
      } catch (e) {
        this.pendingPosts.unshift(...posts);
        this.state = 'error';
        this.stopReason = 'error';
        this.message = 'Could not persist posts: ' + e.message;
        this.clearTimers();
        this.reportState();
        return false;
      }
    }

    reachedOldestDate() {
      const oldest = this.settings.oldestDate;
      if (!oldest) return false;
      const cutoff = Date.parse(oldest + 'T00:00:00Z');
      for (const p of this.collected.values()) {
        if (p.timestamp_iso && Date.parse(p.timestamp_iso) < cutoff) return true;
      }
      return false;
    }

    maybeSnapshot() {
      const every = this.settings.snapshotEveryPosts;
      if (!every) return;
      const count = this.collected.size;
      if (count - this.snapshotCount >= every) {
        this.snapshotCount = count;
        const formats = this.settings.exportFormats || ['json'];
        this.sendToBackground({
          type: M().EXPORT_RUN, runId: this.run.id, formats, media: false, snapshot: true
        }).catch(() => {});
      }
    }

    async enterRest() {
      this.state = 'resting';
      const dur = this.restDuration();
      this.restUntil = this.now() + dur;
      this.message = 'Resting — keeps X happy';
      this.reportState();
      if (this.restTimer) clearTimeout(this.restTimer);
      this.restTimer = setTimeout(() => {
        this.restTimer = null;
        if (this.state === 'resting') {
          this.restUntil = null;
          this.state = 'running';
          this.message = '';
          this.reportState();
          this.tick().finally(() => this.schedule());
        }
      }, dur);
    }

    clearTimers() {
      if (this.timer) { clearTimeout(this.timer); this.timer = null; }
      if (this.restTimer) { clearTimeout(this.restTimer); this.restTimer = null; }
    }

    async pause(reason) {
      if (!this.run || this.state === 'paused' || TERMINAL_STATES.includes(this.state)) return;
      this.freezeStall();
      await this.pauseWithReason(reason || 'manual');
    }

    async pauseWithReason(reason, message) {
      this.clearTimers();
      if (this.activeSegmentStart != null && this.state !== 'paused') {
        this.activeElapsedMs += this.now() - this.activeSegmentStart;
        this.activeSegmentStart = null;
      }
      this.state = 'paused';
      this.stopReason = reason === 'manual' ? null : reason;
      this.message = message || (reason === 'source_changed' ? 'Route changed — paused' : '');
      await this.flushBatch();
      this.reportState();
    }

    async resume() {
      if (!this.run || this.state !== 'paused') return;
      if (!this.sourceMatches()) {
        this.message = 'Cannot resume here — the page shows a different source';
        this.reportState();
        return;
      }
      this.state = 'running';
      this.stopReason = null;
      this.activeSegmentStart = this.now();
      this.stallWindowStart = null;
      this.message = '';
      this.reportState();
      await this.tick();
      this.schedule();
    }

    async stop(reason) {
      if (!this.run || TERMINAL_STATES.includes(this.state)) return;
      this.state = 'stopping';
      this.stopReason = reason || 'manual';
      this.clearTimers();
      this.reportState();
      try {
        if (this.sourceMatches()) {
          const extraction = XA.extractor.extractVisible(document, {
            author: this.run.source.handle,
            captureContext: 'timeline',
            sourceKey: this.run.source.key,
            sourceType: this.run.source.type,
            autoExpandText: this.settings.autoExpandText,
            prevTail: this.prevTail
          });
          this.absorbBatch(extraction.posts);
        }
      } catch (_) { /* final extract is best effort */ }
      if (this.activeSegmentStart != null) {
        this.activeElapsedMs += this.now() - this.activeSegmentStart;
        this.activeSegmentStart = null;
      }
      await this.finishFlush('completed', this.stopReason, 'Stopped');
    }

    async finish(state, reason, message) {
      this.clearTimers();
      this.state = state;
      this.stopReason = reason;
      this.message = message || '';
      try {
        if (this.sourceMatches()) {
          const extraction = XA.extractor.extractVisible(document, {
            author: this.run.source.handle,
            captureContext: 'timeline',
            sourceKey: this.run.source.key,
            sourceType: this.run.source.type,
            autoExpandText: this.settings.autoExpandText,
            prevTail: this.prevTail
          });
          this.absorbBatch(extraction.posts);
        }
      } catch (_) { /* ignore */ }
      if (this.activeSegmentStart != null) {
        this.activeElapsedMs += this.now() - this.activeSegmentStart;
        this.activeSegmentStart = null;
      }
      await this.finishFlush(state, reason, message);
    }

    async finishFlush(state, reason, message) {
      this.state = state;
      this.stopReason = reason;
      this.message = message || '';
      this.freezeStall();
      await this.flushBatch();
      this.reportState();
      this.clearTimers();
    }
  }

  function boot() {
    if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.onMessage) return null;
    const controller = new ScraperController();
    XA.content.controller = controller;

    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (!msg || !msg.type) return false;
      const m = M();
      if (msg.type === m.XAR_GET_CONTEXT) {
        sendResponse({
          ok: true,
          source: controller.currentSource(),
          controller: controller.runtimeSnapshot(),
          runId: controller.run ? controller.run.id : null
        });
        return false;
      }
      if (msg.type === m.XAR_CONTROL) {
        const respond = (p) => Promise.resolve(p)
          .then(() => sendResponse({ ok: true }))
          .catch((e) => sendResponse({ ok: false, error: String(e && e.message || e) }));
        if (msg.action === 'start') { respond(controller.start(msg.run, msg.settings)); return true; }
        if (msg.action === 'pause') { respond(controller.pause('manual')); return true; }
        if (msg.action === 'resume') {
          respond(controller.run ? controller.resume() : controller.start(msg.run, msg.settings));
          return true;
        }
        if (msg.action === 'stop') { respond(controller.stop(msg.reason || 'manual')); return true; }
        return false;
      }
      return false;
    });

    controller.sendToBackground({
      type: M().XAR_CONTENT_READY,
      source: controller.currentSource(),
      url: location.href
    }).then((resp) => {
      if (resp && resp.resumeRun && resp.resumeSettings) {
        const s = resp.resumeSettings;
        if (s.autoResume !== false) {
          controller.start(resp.resumeRun, s).catch(() => {});
        }
      }
    }).catch(() => {});

    return controller;
  }

  if (typeof document !== 'undefined' && /(^|\.)(x|twitter)\.com$/.test(location.hostname || '')) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', boot, { once: true });
    } else {
      boot();
    }
  }

  XA.content.ScraperController = ScraperController;
})();
