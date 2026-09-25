(function () {
  'use strict';
  const XA = (globalThis.XArchive = globalThis.XArchive || {});
  XA.content = XA.content || {};
  const M = () => XA.messages.MSG;

  const MAX_PASSES = 12;
  const STABLE_PASSES_TO_STOP = 3;
  const PASS_WAIT_MS = 2200;
  const RENDER_WAIT_MS = 15000;

  class ThreadWorker {
    constructor() {
      this.job = null;
      this.accum = new Map();
      this.cancelled = false;
      this.busy = false;
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
        if (this.loginGateVisible()) return false;
        await XA.util.sleep(400);
      }
      return false;
    }

    loginGateVisible() {
      const body = (document.body && XA.util.textOf(document.body) || '').toLowerCase();
      return /something went wrong|log in to x|sign in/.test(body) &&
        !document.querySelector('article[data-testid="tweet"]');
    }

    async processJob(job) {
      this.job = job;
      this.cancelled = false;
      this.busy = true;
      this.accum = new Map();
      const diag = {
        statusId: job.statusId || this.expectedStatusId(),
        passes: 0,
        postsFound: 0,
        droppedThirdParty: 0,
        sawRequestedId: false,
        incompleteCounter: null,
        error: null,
        warnings: []
      };

      try {
        const rendered = await this.waitForArticles(RENDER_WAIT_MS);
        if (this.cancelled) return;
        if (!rendered) {
          diag.error = this.loginGateVisible()
            ? 'login-or-error surface shown — X did not render the conversation'
            : 'no posts rendered within ' + (RENDER_WAIT_MS / 1000) + 's';
          await this.finish(diag);
          return;
        }

        let stablePasses = 0;
        let lastChainCount = -1;
        const maxPasses = job.maxPasses || MAX_PASSES;

        for (let pass = 0; pass < maxPasses && !this.cancelled; pass++) {
          diag.passes = pass + 1;
          const result = XA.extractor.extractVisible(document, {
            captureContext: 'thread',
            conversationUrl: this.conversationUrl(),
            allowFocusedRoot: true,
            autoExpandText: true,
            author: job.authorHandle
          });
          for (const p of result.posts) {
            const old = this.accum.get(p.id);
            this.accum.set(p.id, old ? XA.postModel.mergePosts(old, p) : p);
          }
          const chain = this.authorChain();
          diag.postsFound = chain.length;
          diag.sawRequestedId = chain.some((p) => p.id === diag.statusId) ||
            this.accum.has(diag.statusId);
          if (chain.length === lastChainCount) stablePasses += 1;
          else { stablePasses = 0; lastChainCount = chain.length; }
          if (diag.sawRequestedId && stablePasses >= STABLE_PASSES_TO_STOP) break;
          const el = document.scrollingElement || document.documentElement;
          if (el && el.scrollBy) el.scrollBy(0, Math.round(900 + Math.random() * 600));
          await XA.util.sleep(PASS_WAIT_MS);
        }

        const chain = this.authorChain();
        diag.postsFound = chain.length;
        diag.droppedThirdParty = this.accum.size - chain.length;
        diag.sawRequestedId = chain.some((p) => p.id === diag.statusId);
        diag.incompleteCounter = this.counterIncompleteness(chain);
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
      const posts = (chain || this.authorChain()).map((p) => {
        p.thread_id = this.conversationUrl();
        p.thread_scraped = true;
        return p;
      });
      await this.send({
        type: M().XAR_THREAD_RESULT,
        jobId: this.job ? this.job.id : null,
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
          worker.cancelled = true;
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
})();
