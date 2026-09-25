(function () {
  'use strict';
  const XA = (globalThis.XArchive = globalThis.XArchive || {});

  const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
  const ILLEGAL_CHARS = new RegExp('[<>:"/\\\\|?*\\x00-\\x1f]', 'g');

  function sanitizePart(value, fallback) {
    let s = value == null ? '' : String(value);
    s = s.replace(ILLEGAL_CHARS, ' ')
        .replace(/[. ]+$/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    if (!s) s = fallback || 'x';
    if (WINDOWS_RESERVED.test(s)) s = '_' + s;
    return s.slice(0, 80);
  }

  function pad(n, w) { return String(n).padStart(w || 2, '0'); }

  function tokenValues(ctx) {
    const c = ctx || {};
    const src = c.source || {};
    const run = c.run || {};
    const d = c.date instanceof Date ? c.date : new Date(c.date || Date.now());
    const date = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
    const time = pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
    const posts = c.num != null ? c.num : (run.stats && run.stats.posts) || 0;
    return {
      '%type': src.type || 'archive',
      '%source': src.key || src.type || 'archive',
      '%handle': src.handle ? String(src.handle).replace(/^@/, '') : 'x',
      '%title': src.label || src.type || 'archive',
      '%tab': src.tab || 'posts',
      '%date': date,
      '%time': time,
      '%datetime': date + '_' + time,
      '%num': String(posts),
      '%run': run.id || 'run',
      '%ext': c.ext || 'json'
    };
  }

  const TOKEN_RE = /%(datetime|source|handle|title|type|date|time|tab|num|run|ext)/g;

  function expandTemplate(template, ctx) {
    const t = template || 'x_%type_%handle_%date_%num';
    const values = tokenValues(ctx);
    const out = t.replace(TOKEN_RE, (token) => sanitizePart(values[token]));
    return sanitizeFilename(out);
  }

  function sanitizeFilename(name) {
    let s = String(name == null ? '' : name);
    s = s.replace(ILLEGAL_CHARS, ' ').replace(/\s+/g, ' ').trim();
    s = s.replace(/\.{2,}/g, '.').replace(/^[. ]+/, '').replace(/[. ]+$/g, '');
    if (!s) s = 'x-archive';
    if (WINDOWS_RESERVED.test(s)) s = '_' + s;
    if (s.length > 150) s = s.slice(0, 150).replace(/[. ]+$/g, '');
    return s;
  }

  function filenameFor(ctx) {
    const base = expandTemplate((ctx && ctx.template) || 'x_%type_%handle_%date_%num', ctx);
    const ext = (ctx && ctx.ext) || '';
    return ext ? base + '.' + ext.replace(/^\./, '') : base;
  }

  XA.filename = { sanitizePart, sanitizeFilename, tokenValues, expandTemplate, filenameFor };
})();
