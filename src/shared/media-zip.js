(function () {
  'use strict';
  const XA = (globalThis.XArchive = globalThis.XArchive || {});

  const KIND_BY_SETTING = {
    post: 'postImages',
    quote: 'quotedImages',
    card: 'cardImages',
    avatar: 'avatars'
  };

  function isFetchableImage(url) {
    return typeof url === 'string' && /^https?:\/\//i.test(url);
  }

  function collectMediaTargets(posts, mediaSettings) {
    const ms = mediaSettings || {};
    const targets = [];
    const seenUrls = new Set();
    const push = (post, url, kind) => {
      if (!isFetchableImage(url)) return;
      const setting = KIND_BY_SETTING[kind];
      if (setting && ms[setting] === false) return;
      if (seenUrls.has(url)) return;
      seenUrls.add(url);
      const perPost = targets.filter((t) => t.tweetId === post.id && t.kind === kind).length;
      targets.push({ tweetId: post.id || 'post', kind, index: perPost, url });
    };
    for (const post of posts || []) {
      for (const url of post.images || []) push(post, url, 'post');
      for (const m of post.media || []) {
        if (m.type === 'image') push(post, m.url, 'post');
        if (m.type === 'video' && m.poster) push(post, m.poster, 'post');
      }
      const q = post.quote_context;
      if (q) for (const url of q.quoted_images || []) push(post, url, 'quote');
      if (post.link_card && post.link_card.image) push(post, post.link_card.image, 'card');
      if (post.avatar_url) push(post, post.avatar_url, 'avatar');
    }
    return targets;
  }

  function extFromContentType(ct) {
    const c = String(ct || '').split(';')[0].trim().toLowerCase();
    const map = {
      'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png',
      'image/gif': 'gif', 'image/webp': 'webp', 'image/avif': 'avif',
      'image/svg+xml': 'svg', 'image/bmp': 'bmp'
    };
    return map[c] || null;
  }

  function extFromUrl(url) {
    const m = String(url || '').split('?')[0].match(/\.([a-zA-Z0-9]{2,5})$/);
    if (m && /^(jpe?g|png|gif|webp|avif|svg|bmp)$/i.test(m[1])) {
      return m[1].toLowerCase().replace('jpeg', 'jpg');
    }
    return null;
  }

  function extFor(url, contentType) {
    return extFromContentType(contentType) || extFromUrl(url) || 'img';
  }

  function mediaPathFor(target, ext) {
    const e = (ext || 'img').replace(/[^a-z0-9]/gi, '') || 'img';
    const id = String(target.tweetId || 'post').replace(/[^a-zA-Z0-9_-]/g, '_') || 'post';
    return 'media/' + id + '_' + target.kind + '_' + target.index + '.' + e;
  }

  function sanitizeZipDir(name) {
    return XA.filename.sanitizeFilename(name || 'x_archive').replace(/\./g, '_');
  }

  function buildManifest(targets, results, failures) {
    const entries = [];
    for (const t of targets) {
      const r = results && results.get(t.url);
      const fail = (failures || []).find((f) => f.url === t.url);
      entries.push({
        url: t.url,
        tweet_id: t.tweetId,
        kind: t.kind,
        index: t.index,
        local_path: r ? r.path : null,
        bytes: r ? r.bytes.length : null,
        error: r ? null : (fail ? String(fail.error) : 'not downloaded')
      });
    }
    return { generated_at: XA.util.nowIso(), entries };
  }

  function buildMediaZip(opts) {
    const o = opts || {};
    const fflate = o.fflate || globalThis.fflate;
    if (!fflate || !fflate.zipSync) throw new Error('fflate is not loaded');
    const posts = o.posts || [];
    const run = o.run || {};
    const results = o.results || new Map();
    const failures = o.failures || [];
    const targets = collectMediaTargets(posts, o.mediaSettings);

    const mediaMap = {};
    for (const t of targets) {
      const r = results.get(t.url);
      if (!r) continue;
      const path = mediaPathFor(t, extFor(t.url, r.contentType));
      r.path = path;
      mediaMap[t.url] = path;
    }

    const manifest = buildManifest(targets, results, failures);
    const envelope = XA.exportJson.buildEnvelope(run, posts);
    const offlineHtml = XA.exportHtml.renderHtmlReport(run, posts, {
      offline: true, mediaMap
    });

    const enc = new TextEncoder();
    const files = {};
    files['archive.json'] = enc.encode(JSON.stringify(envelope, null, 2));
    files['index.html'] = enc.encode(offlineHtml);
    files['media-manifest.json'] = enc.encode(JSON.stringify(manifest, null, 2));
    for (const t of targets) {
      const r = results.get(t.url);
      if (r && r.path) files[r.path] = r.bytes;
    }
    const zipBytes = fflate.zipSync(files, { level: 6 });
    return { zipBytes, manifest, mediaMap, targetCount: targets.length };
  }

  XA.mediaZip = {
    isFetchableImage, collectMediaTargets, extFromContentType, extFromUrl, extFor,
    mediaPathFor, sanitizeZipDir, buildManifest, buildMediaZip
  };
})();
