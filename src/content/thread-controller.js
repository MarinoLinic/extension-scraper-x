(function () {
  'use strict';
  const XA = (globalThis.XArchive = globalThis.XArchive || {});
  XA.content = XA.content || {};
  const M = () => XA.messages.MSG;

  const MAX_PASSES = 12;
  const MAX_QUOTE_PASSES = 6;
  const STABLE_PASSES_TO_STOP = 3;
  const PASS_WAIT_MS = 2200;
  const RENDER_WAIT_MS = 15000;

  function classifyBlockedSurface(root) {
    if (root && root.querySelector('article[data-testid="tweet"]')) return null;
    const body = (root && root.body && XA.util.textOf(root.body) || '').toLowerCase();
    if (/rate limit|too many requests|try again later|temporarily limited|429/.test(body)) return 'rate_limited';
    if (/log in to x|sign in to x|log in|sign in|create your account/.test(body)) return 'login_required';
    if (/something went wrong|problem loading|error loading|unavailable|try reloading/.test(body)) return 'error_surface';
    return null;
  }

  function normalizeQuoteText(value) {
    return String(value || '')
      .replace(/(?:https?:\/\/)?(?:www\.)?x\.com\/\S*$/i, '')
      .replace(/(?:…|\.\.\.)+\s*$/, '')
      .replace(/\s+/g, '').toLowerCase();
  }

  function quoteMismatch(post, job) {
    const expectedHandle = String(job.expectedHandle || job.authorHandle || '').replace(/^@/, '').toLowerCase();
    const actualHandle = String(post && post.handle || '').replace(/^@/, '').toLowerCase();
    if (expectedHandle && expectedHandle !== actualHandle) return 'quoted author did not match the expected handle';
    if (job.expectedTimestamp && (!post || job.expectedTimestamp !== post.timestamp_iso)) {
      return 'quoted timestamp did not match the expected timestamp';
    }
    const expected = normalizeQuoteText(job.expectedText);
    if (expected.length >= 20) {
      const prefix = expected.slice(0, Math.min(100, expected.length));
      if (!normalizeQuoteText(post && post.text).startsWith(prefix)) return 'quoted text did not match the expected text';
    }
    return null;
  }

  class ThreadWorker {
    constructor() {
      this.job = null;
      this.accum = new Map();
      this.cancelled = false;
      this.busy = false;
      this.cancelResolve = null;
    }

    requestCancel() {
      this.cancelled = true;
      if (this.cancelResolve) this.cancelResolve();
    }

    sleep(ms) {
      return Promise.race([
        XA.util.sleep(ms),
        new Promise((resolve) => { this.cancelResolve = resolve; })
      ]);
    }

    send(msg) {
      return new Promise((resolve) => {
        try {
          chrome.runtime.sendMessage(msg, () => resolve());
        } catch (_) { resolve(); }
      });
    }

    expectedStatusId() {
      const m = location.pathname.match(/\/status\/(\d+)/);
      return m ? m[1] : (this.job ? this.job.statusId : null);
    }

    conversationUrl() {
      return location.href.split('?')[0].split('#')[0]
        .replace('https://twitter.com', 'https://x.com')
        .replace(/\/(photo|video|likes|retweets|quotes|analytics)(\/\d+)?$/i, '');
    }

    async waitForArticles(timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (this.cancelled) return false;
        if (document.querySelector('article[data-testid="tweet"]')) return true;
        if (classifyBlockedSurface(document)) return false;
        await this.sleep(400);
      }
      return false;
    }

    loginGateVisible() {
      return classifyBlockedSurface(document) === 'login_required' ||
        classifyBlockedSurface(document) === 'error_surface';
    }

    async processJob(job) {
      this.job = Object.assign({ kind: 'thread' }, job);
      job = this.job;
      this.cancelled = false;
      this.cancelResolve = null;
      this.busy = true;
      this.accum = new Map();
      const kind = job.kind === 'quote' ? 'quote' : 'thread';
      const diag = {
        kind,
        statusId: job.statusId || this.expectedStatusId(),
        passes: 0,
        postsFound: 0,
        droppedThirdParty: 0,
        sawRequestedId: false,
        incompleteCounter: null,
        blockedReason: null,
        error: null,
        warnings: []
      };

      try {
        const rendered = await this.waitForArticles(RENDER_WAIT_MS);
        if (this.cancelled) {
          diag.error = 'cancelled before render completed';
          diag.cancelled = true;
          await this.finish(diag);
          return;
        }
        if (!rendered) {
          diag.blockedReason = classifyBlockedSurface(document);
          diag.error = diag.blockedReason
            ? 'X showed ' + diag.blockedReason + ' before posts rendered'
            : 'no posts rendered within ' + (RENDER_WAIT_MS / 1000) + 's';
          await this.finish(diag);
          return;
        }

        let stablePasses = 0;
        let lastChainCount = -1;
        const maxPasses = kind === 'quote'
          ? Math.min(MAX_QUOTE_PASSES, job.maxPasses || MAX_QUOTE_PASSES)
          : (job.maxPasses || MAX_PASSES);

        for (let pass = 0; pass < maxPasses && !this.cancelled; pass++) {
          const blocked = classifyBlockedSurface(document);
          if (blocked) {
            diag.blockedReason = blocked;
            diag.error = 'X showed ' + blocked + ' before posts rendered';
            break;
          }
          diag.passes = pass + 1;
          const clicked = XA.extractor.expandTruncatedText(document);
          if (clicked > 0) await this.sleep(300);
          const result = XA.extractor.extractVisible(document, {
            captureContext: kind === 'thread' ? 'thread' : 'timeline',
            conversationUrl: this.conversationUrl(),
            allowFocusedRoot: true,
            autoExpandText: false,
            author: job.authorHandle
          });
          for (const p of result.posts) {
            const old = this.accum.get(p.id);
            this.accum.set(p.id, old ? XA.postModel.mergePosts(old, p) : p);
          }
          if (kind === 'quote') {
            const exact = this.accum.get(diag.statusId);
            diag.postsFound = exact ? 1 : 0;
            diag.sawRequestedId = !!exact;
            if (exact) break;
          } else {
            const chain = this.authorChain();
            diag.postsFound = chain.length;
            diag.sawRequestedId = chain.some((p) => p.id === diag.statusId) ||
              this.accum.has(diag.statusId);
            if (chain.length === lastChainCount) stablePasses += 1;
            else { stablePasses = 0; lastChainCount = chain.length; }
            if (diag.sawRequestedId && stablePasses >= STABLE_PASSES_TO_STOP) break;
          }
          const el = document.scrollingElement || document.documentElement;
          if (el && el.scrollBy) el.scrollBy(0, Math.round(900 + Math.random() * 600));
          await this.sleep(PASS_WAIT_MS);
        }

        if (kind === 'quote') {
          const exact = this.accum.get(diag.statusId);
          diag.postsFound = exact ? 1 : 0;
          diag.sawRequestedId = !!exact;
          if (exact) {
            const mismatch = quoteMismatch(exact, job);
            if (mismatch) {
              diag.error = mismatch;
              diag.sawRequestedId = false;
              await this.finish(diag, []);
              return;
            }
          } else if (!this.cancelled) {
            diag.error = 'requested quoted status ' + diag.statusId + ' not observed';
          }
          if (this.cancelled) diag.cancelled = true;
          await this.finish(diag, exact && diag.sawRequestedId ? [exact] : []);
          return;
        }

        const chain = this.authorChain();
        diag.postsFound = chain.length;
        diag.droppedThirdParty = this.accum.size - chain.length;
        diag.sawRequestedId = chain.some((p) => p.id === diag.statusId);
        diag.incompleteCounter = this.counterIncompleteness(chain);
        if (this.cancelled) diag.cancelled = true;
        if (!diag.sawRequestedId) {
          diag.error = 'requested status ' + diag.statusId + ' not observed in rendered conversation';
          diag.warnings.push('The focused post may be deleted, protected, or buried under unloaded replies.');
        } else if (diag.incompleteCounter) {
          diag.warnings.push('Numbered thread counter suggests a missing post (saw max ' +
            diag.incompleteCounter.seen + ' of ' + diag.incompleteCounter.total + ').');
        }
        await this.finish(diag, chain);
      } catch (e) {
        diag.error = String(e && e.message || e);
        await this.finish(diag);
      } finally {
        this.busy = false;
      }
    }

    authorChain() {
      const author = ((this.job && this.job.authorHandle) ||
        XA.util.authorOfStatusUrl(this.conversationUrl()) || '').toLowerCase();
      const all = Array.from(this.accum.values());
      return all.filter((p) => {
        const h = (p.handle || '').replace(/^@/, '').toLowerCase();
        return !author || !h || h === author;
      }).sort((a, b) => (a.timestamp_iso || '').localeCompare(b.timestamp_iso || ''));
    }

    counterIncompleteness(chain) {
      let maxTotal = 0;
      let maxSeen = 0;
      for (const p of chain) {
        const c = XA.extractor.numberedCounter(p.text);
        if (c) {
          maxTotal = Math.max(maxTotal, c.total);
          maxSeen = Math.max(maxSeen, c.n);
        }
      }
      if (maxTotal >= 2 && maxSeen < maxTotal) {
        return { total: maxTotal, seen: maxSeen };
      }
      return null;
    }

    async finish(diag, chain) {
      diag.kind = this.job && this.job.kind === 'quote' ? 'quote' : 'thread';
      const source = chain || this.authorChain();
      const posts = diag.kind === 'quote'
        ? source.map((post) => Object.assign({}, post, {
          is_thread: false, thread_role: 'standalone', thread_id: null,
          is_self_reply: false, thread_scraped: false
        }))
        : source.map((post) => {
          post.thread_id = this.conversationUrl();
          post.thread_scraped = true;
          return post;
        });
      await this.send({
        type: M().XAR_THREAD_RESULT,
        jobId: this.job ? this.job.id : null,
        sessionId: this.job ? this.job.sessionId : null,
        posts,
        diagnostics: diag
      });
    }
  }

  function boot() {
    if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.onMessage) return null;
    const worker = new ThreadWorker();
    XA.content.threadWorker = worker;
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (!msg || !msg.type) return false;
      const m = M();
      if (msg.type === m.XAR_THREAD_JOB) {
        if (msg.action === 'cancel') {
          worker.requestCancel();
          sendResponse({ ok: true });
          return false;
        }
        worker.processJob(msg.job)
          .then(() => sendResponse({ ok: true }))
          .catch((e) => sendResponse({ ok: false, error: String(e && e.message || e) }));
        return true;
      }
      return false;
    });
    worker.send({ type: M().XAR_CONTENT_READY, url: location.href, threadWorker: true });
    return worker;
  }

  if (typeof document !== 'undefined' && /(^|\.)(x|twitter)\.com$/.test(location.hostname || '')) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', boot, { once: true });
    } else {
      boot();
    }
  }

  XA.content.ThreadWorker = ThreadWorker;
  XA.content.threadHelpers = { classifyBlockedSurface, normalizeQuoteText, quoteMismatch, MAX_QUOTE_PASSES };
})();
