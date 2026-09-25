(function () {
  'use strict';
  const XA = (globalThis.XArchive = globalThis.XArchive || {});

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const rand = (min, max) => min + Math.random() * (max - min);
  const randInt = (min, max) => Math.round(rand(min, max));
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const nowIso = () => new Date().toISOString();

  const uid = (prefix) =>
    (prefix || 'id') + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);

  function normalizeHost(url) {
    if (!url) return url;
    return String(url).replace(/^https?:\/\/(www\.)?twitter\.com/i, 'https://x.com')
      .replace(/^https?:\/\/(www\.)?x\.com/i, 'https://x.com');
  }

  function absUrl(href) {
    if (!href) return null;
    let h = String(href).split('#')[0].split('?')[0];
    if (h.startsWith('//')) h = 'https:' + h;
    if (!/^https?:\/\//i.test(h)) {
      if (!h.startsWith('/')) h = '/' + h;
      h = 'https://x.com' + h;
    }
    return normalizeHost(h);
  }

  function canonicalStatusUrl(url) {
    const abs = absUrl(url);
    if (!abs) return null;
    return abs.replace(/\/(photo|video|likes|retweets|quotes|analytics)(\/\d+)?$/i, '');
  }

  function statusIdFromUrl(url) {
    if (!url) return null;
    const m = String(url).match(/\/status(?:es)?\/(\d+)/);
    return m ? m[1] : null;
  }

  function authorOfStatusUrl(url) {
    const m = String(url || '').match(/^https?:\/\/[^/]+\/([^/?#]+)\/status\//);
    return m ? decodeURIComponent(m[1]) : null;
  }

  function escapeHtml(str) {
    if (str == null) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  const METRIC_KINDS = {
    replies: /repl(?:y|ies)/i,
    reposts: /reposts?/i,
    likes: /likes?/i,
    bookmarks: /bookmarks?/i,
    views: /views?/i
  };

  function parseCount(aria, kindPattern) {
    if (!aria) return null;
    const pat = kindPattern instanceof RegExp ? kindPattern.source : String(kindPattern);
    const m = String(aria).match(
      new RegExp('(\\d[\\d,.]*)\\s*([KkMmBb])?\\s*' + pat, 'i')
    );
    if (!m) return null;
    const num = parseFloat(m[1].replace(/,/g, ''));
    if (Number.isNaN(num)) return null;
    const suffix = (m[2] || '').toUpperCase();
    const mult = suffix === 'K' ? 1e3 : suffix === 'M' ? 1e6 : suffix === 'B' ? 1e9 : 1;
    return Math.round(num * mult);
  }

  function parseMetricsFromAria(aria) {
    const out = {};
    for (const [key, pat] of Object.entries(METRIC_KINDS)) {
      out[key] = parseCount(aria, pat);
    }
    return out;
  }

  function formatDuration(ms) {
    if (ms == null || !Number.isFinite(ms)) return '—';
    const s = Math.max(0, Math.round(ms / 1000));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (h > 0) return h + 'h ' + String(m).padStart(2, '0') + 'm';
    if (m > 0) return m + 'm ' + String(sec).padStart(2, '0') + 's';
    return sec + 's';
  }

  function safeJsonParse(text, fallback) {
    try { return JSON.parse(text); } catch (_) { return fallback; }
  }

  function textOf(el) {
    if (!el) return '';
    const it = el.innerText;
    if (typeof it === 'string' && it.length) return it;
    return el.textContent || '';
  }

  function dedupe(arr) {
    return Array.from(new Set((arr || []).filter((x) => x != null)));
  }

  XA.util = {
    sleep, rand, randInt, clamp, nowIso, uid,
    normalizeHost, absUrl, canonicalStatusUrl, statusIdFromUrl, authorOfStatusUrl,
    escapeHtml, parseCount, parseMetricsFromAria, METRIC_KINDS,
    formatDuration, safeJsonParse, dedupe, textOf
  };
})();
