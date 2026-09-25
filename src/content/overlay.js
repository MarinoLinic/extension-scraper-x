(function () {
  'use strict';
  const XA = (globalThis.XArchive = globalThis.XArchive || {});
  XA.content = XA.content || {};

  const FALLBACK_CSS = `
:host{all:initial}
.panel{position:fixed;bottom:16px;right:16px;z-index:2147483646;width:250px;font:13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:#e7e9ea;background:#16181cf2;border:1px solid #38444d;border-radius:12px;box-shadow:0 4px 18px #0008}
.head{display:flex;align-items:center;justify-content:space-between;padding:8px 10px;border-bottom:1px solid #38444d;font-weight:700}
.head .btns button{margin-left:4px}
.body{padding:8px 10px}
.row{display:flex;justify-content:space-between;margin:2px 0}
.label{color:#8b98a5}
.controls{display:flex;gap:6px;padding:0 10px 10px}
button{font:inherit;font-size:12px;color:#e7e9ea;background:#2f3336;border:1px solid #536471;border-radius:8px;padding:3px 10px;cursor:pointer}
button:hover{background:#38444d}
.state{font-weight:700}
.state.running{color:#1d9bf0}.state.resting{color:#f4a41c}.state.paused{color:#ffd400}
.state.completed{color:#17bf63}.state.error,.state.limited{color:#e0245e}
.msg{color:#f4a41c;margin-top:4px;max-height:60px;overflow:hidden}
.collapsed .body,.collapsed .controls{display:none}`;

  class Overlay {
    constructor(handlers) {
      this.handlers = handlers || {};
      this.host = null;
      this.shadow = null;
      this.collapsed = false;
      this.visible = false;
      this.els = {};
    }

    async mount() {
      if (this.host) return;
      const host = document.createElement('div');
      host.id = 'x-archive-overlay-host';
      host.style.cssText = 'position:fixed;bottom:16px;right:16px;z-index:2147483646;';
      this.shadow = host.attachShadow({ mode: 'open' });
      const style = document.createElement('style');
      style.textContent = await this.loadCss();
      const panel = document.createElement('div');
      panel.className = 'panel';
      panel.innerHTML =
        '<div class="head"><span>X Archive</span><span class="btns">' +
        '<button data-act="collapse" title="Collapse">–</button>' +
        '<button data-act="close" title="Hide panel">×</button></span></div>' +
        '<div class="body">' +
        '<div class="row"><span class="label">State</span><span class="state" data-el="state">idle</span></div>' +
        '<div class="row"><span class="label">Posts</span><span data-el="count">0</span></div>' +
        '<div class="row"><span class="label">Active</span><span data-el="elapsed">0s</span></div>' +
        '<div class="row" data-el="restrow" style="display:none"><span class="label">Rest</span><span data-el="rest"></span></div>' +
        '<div class="msg" data-el="msg"></div></div>' +
        '<div class="controls">' +
        '<button data-act="pause">Pause</button>' +
        '<button data-act="resume" style="display:none">Resume</button>' +
        '<button data-act="stop">Stop</button>' +
        '<button data-act="export">Export</button></div>';
      this.shadow.appendChild(style);
      this.shadow.appendChild(panel);
      this.panel = panel;
      for (const el of panel.querySelectorAll('[data-el]')) {
        this.els[el.getAttribute('data-el')] = el;
      }
      panel.addEventListener('click', (ev) => {
        const act = ev.target && ev.target.getAttribute('data-act');
        if (!act) return;
        if (act === 'collapse') this.toggleCollapsed();
        else if (act === 'close') this.hide();
        else if (this.handlers['on' + act[0].toUpperCase() + act.slice(1)]) {
          this.handlers['on' + act[0].toUpperCase() + act.slice(1)]();
        }
      });
      (document.body || document.documentElement).appendChild(host);
      this.host = host;
      this.visible = true;
    }

    async loadCss() {
      try {
        if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL) {
          const res = await fetch(chrome.runtime.getURL('src/content/overlay.css'));
          if (res.ok) return await res.text();
        }
      } catch (_) { /* fall through */ }
      return FALLBACK_CSS;
    }

    toggleCollapsed() {
      this.collapsed = !this.collapsed;
      if (this.panel) this.panel.classList.toggle('collapsed', this.collapsed);
    }

    show() {
      this.mount().then(() => {
        if (this.host) this.host.style.display = '';
        this.visible = true;
      }).catch(() => {});
    }

    hide() {
      if (this.host) this.host.style.display = 'none';
      this.visible = false;
    }

    remove() {
      if (this.host) this.host.remove();
      this.host = null;
      this.shadow = null;
      this.visible = false;
    }

    update(s) {
      if (!s) return;
      if (!this.host) {
        this.mount().then(() => this.update(s)).catch(() => {});
        return;
      }
      const state = s.state || 'idle';
      this.els.state.textContent = state;
      this.els.state.className = 'state ' + state;
      this.els.count.textContent = String(s.posts == null ? 0 : s.posts);
      this.els.elapsed.textContent = XA.util.formatDuration(s.activeElapsedMs || 0);
      const resting = state === 'resting' && s.restRemainingMs != null;
      this.els.restrow.style.display = resting ? '' : 'none';
      if (resting) this.els.rest.textContent = XA.util.formatDuration(s.restRemainingMs);
      this.els.msg.textContent = s.message || '';
      const pauseBtn = this.panel.querySelector('[data-act="pause"]');
      const resumeBtn = this.panel.querySelector('[data-act="resume"]');
      if (pauseBtn && resumeBtn) {
        pauseBtn.style.display = (state === 'running' || state === 'resting') ? '' : 'none';
        resumeBtn.style.display = state === 'paused' ? '' : 'none';
      }
    }
  }

  XA.content.Overlay = Overlay;
})();
