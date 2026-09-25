(function () {
  'use strict';
  const XA = (globalThis.XArchive = globalThis.XArchive || {});
  const u = () => XA.util;

  const POST_SCHEMA_VERSION = 1;

  function emptyPost() {
    return {
      schema_version: POST_SCHEMA_VERSION,
      id: null,
      tweet_url: null,
      name: null,
      handle: null,
      profile_url: null,
      avatar_url: null,
      timestamp_iso: null,
      date_displayed: null,
      is_reply: false,
      replying_to: [],
      social_context: null,
      text: '',
      links: [],
      images: [],
      videos: [],
      media: [],
      link_card: null,
      quote_context: null,
      metrics: { replies: null, reposts: null, likes: null, bookmarks: null, views: null },
      is_thread: false,
      thread_role: 'standalone',
      thread_id: null,
      is_self_reply: false,
      show_thread_link: null,
      thread_candidates: [],
      thread_scraped: false,
      capture_context: 'timeline',
      source_key: null,
      source_type: null,
      captured_at: null,
      updated_at: null,
      warnings: []
    };
  }

  function canonicalPostId(post) {
    if (!post) return null;
    const id = u().statusIdFromUrl(post.tweet_url || post.url || '');
    if (id) return id;
    const url = u().canonicalStatusUrl(post.tweet_url || post.url);
    return url || null;
  }

  function normalizePost(raw, ctx) {
    const c = ctx || {};
    const p = Object.assign(emptyPost(), raw && typeof raw === 'object' ? raw : {});
    p.tweet_url = u().canonicalStatusUrl(p.tweet_url || p.url);
    p.id = canonicalPostId(p);
    if (p.profile_url) p.profile_url = u().absUrl(p.profile_url);
    if (p.handle && !String(p.handle).startsWith('@')) p.handle = '@' + String(p.handle);
    p.replying_to = (Array.isArray(p.replying_to) ? p.replying_to : []).map((r) => ({
      handle: r && r.handle ? String(r.handle) : '',
      profile_url: r && r.profile_url ? u().absUrl(r.profile_url) : null
    })).filter((r) => r.handle);
    p.links = (Array.isArray(p.links) ? p.links : []).map((l) => ({
      display: l && l.display != null ? String(l.display) : '',
      href: l && l.href ? String(l.href) : null
    })).filter((l) => l.href);
    p.images = u().dedupe(p.images);
    p.videos = u().dedupe(p.videos);
    p.media = (Array.isArray(p.media) ? p.media : []).map((m) => ({
      url: m && m.url ? String(m.url) : null,
      type: m && m.type === 'video' ? 'video' : 'image',
      alt: m && m.alt ? String(m.alt) : null,
      poster: m && m.poster ? String(m.poster) : null,
      permalink: m && m.permalink ? u().absUrl(m.permalink) : null
    })).filter((m) => m.url || m.permalink);
    p.metrics = Object.assign({ replies: null, reposts: null, likes: null, bookmarks: null, views: null },
      typeof p.metrics === 'object' && p.metrics ? p.metrics : {});
    p.warnings = Array.isArray(p.warnings) ? p.warnings.filter(Boolean) : [];
    p.thread_candidates = Array.isArray(p.thread_candidates) ? p.thread_candidates : [];
    if (c.captureContext) p.capture_context = c.captureContext;
    if (p.capture_context === 'thread') p.thread_scraped = true;
    if (c.sourceKey && !p.source_key) p.source_key = c.sourceKey;
    if (c.sourceType && !p.source_type) p.source_type = c.sourceType;
    const now = u().nowIso();
    if (!p.captured_at) p.captured_at = now;
    p.updated_at = now;
    p.schema_version = POST_SCHEMA_VERSION;
    return p;
  }

  function unionBy(arrA, arrB, keyFn) {
    const seen = new Set();
    const out = [];
    for (const item of [...(arrA || []), ...(arrB || [])]) {
      const k = keyFn(item);
      if (k == null || seen.has(k)) continue;
      seen.add(k);
      out.push(item);
    }
    return out;
  }

  function pickScalar(a, b) {
    if (b == null || b === '') return a == null ? null : a;
    if (a == null || a === '') return b;
    return a;
  }

  function postsSemanticallyEqual(a, b) {
    if (a === b) return true;
    if (a == null || b == null) return false;
    if (typeof a !== 'object' || typeof b !== 'object') return a === b;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    if (Array.isArray(a)) {
      if (a.length !== b.length) return false;
      for (let i = 0; i < a.length; i++) {
        if (!postsSemanticallyEqual(a[i], b[i])) return false;
      }
      return true;
    }
    const keysA = Object.keys(a).filter((k) => k !== 'updated_at');
    const keysB = Object.keys(b).filter((k) => k !== 'updated_at');
    if (keysA.length !== keysB.length) return false;
    for (const k of keysA) {
      if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
      if (!postsSemanticallyEqual(a[k], b[k])) return false;
    }
    return true;
  }

  function mergeQuote(a, b) {
    if (!b) return a || null;
    if (!a) return b;
    const out = Object.assign({}, a);
    for (const [k, v] of Object.entries(b)) {
      if (Array.isArray(v)) {
        out[k] = u().dedupe([...(a[k] || []), ...v]);
      } else if (k === 'quoted_text') {
        out[k] = String(v || '').length > String(a[k] || '').length ? v : a[k];
      } else if (v != null && v !== '' && (a[k] == null || a[k] === '')) {
        out[k] = v;
      }
    }
    return out;
  }

  function mergePosts(existing, incoming) {
    if (!existing) return incoming;
    if (!incoming) return existing;
    const a = existing;
    const b = incoming;
    const out = Object.assign({}, a);

    for (const k of ['name', 'handle', 'profile_url', 'avatar_url', 'timestamp_iso',
      'date_displayed', 'social_context', 'tweet_url', 'source_key', 'source_type',
      'thread_id', 'show_thread_link']) {
      out[k] = pickScalar(a[k], b[k]);
    }

    const aText = a.text || '';
    const bText = b.text || '';
    out.text = bText.length > aText.length ? bText : aText;

    out.links = unionBy(a.links, b.links, (l) => l && l.href);
    out.replying_to = unionBy(a.replying_to, b.replying_to, (r) => r && r.handle);
    out.images = u().dedupe([...(a.images || []), ...(b.images || [])]);
    out.videos = u().dedupe([...(a.videos || []), ...(b.videos || [])]);
    out.media = unionBy(a.media, b.media, (m) => m && (m.url || m.permalink));
    out.warnings = u().dedupe([...(a.warnings || []), ...(b.warnings || [])]);
    out.thread_candidates = unionBy(a.thread_candidates, b.thread_candidates,
      (c) => c && (c.url + '|' + c.reason));

    const metrics = Object.assign({}, a.metrics);
    for (const k of ['replies', 'reposts', 'likes', 'bookmarks', 'views']) {
      if (b.metrics && b.metrics[k] != null) metrics[k] = b.metrics[k];
    }
    out.metrics = metrics;

    out.link_card = (function () {
      if (!b.link_card) return a.link_card || null;
      if (!a.link_card) return b.link_card;
      return {
        url: pickScalar(a.link_card.url, b.link_card.url),
        title: pickScalar(a.link_card.title, b.link_card.title),
        image: pickScalar(a.link_card.image, b.link_card.image)
      };
    })();
    out.quote_context = mergeQuote(a.quote_context, b.quote_context);

    out.is_reply = !!(a.is_reply || b.is_reply);
    out.is_thread = !!(a.is_thread || b.is_thread);
    out.is_self_reply = !!(a.is_self_reply || b.is_self_reply);
    out.thread_scraped = !!(a.thread_scraped || b.thread_scraped);
    if (a.thread_role && a.thread_role !== 'standalone') out.thread_role = a.thread_role;
    else if (b.thread_role) out.thread_role = b.thread_role;
    else out.thread_role = a.thread_role;

    out.capture_context = a.capture_context === 'timeline' ? 'timeline' : (b.capture_context || a.capture_context);
    out.captured_at = a.captured_at || b.captured_at;
    out.id = a.id || b.id;
    out.schema_version = POST_SCHEMA_VERSION;
    if (postsSemanticallyEqual(out, a)) return a;
    out.updated_at = u().nowIso();
    return out;
  }

  function legacyPostsFromImport(parsed) {
    if (!parsed) return { posts: [], envelope: null, warnings: ['Empty or unreadable archive'] };
    const warnings = [];
    if (Array.isArray(parsed)) {
      return { posts: parsed, envelope: null, warnings };
    }
    if (Array.isArray(parsed.posts)) {
      return { posts: parsed.posts, envelope: parsed.archive || null, warnings };
    }
    warnings.push('Unrecognized JSON shape — expected an array or an object with a "posts" array');
    return { posts: [], envelope: null, warnings };
  }

  XA.postModel = {
    POST_SCHEMA_VERSION, emptyPost, canonicalPostId, normalizePost, mergePosts,
    postsSemanticallyEqual, legacyPostsFromImport
  };
})();
