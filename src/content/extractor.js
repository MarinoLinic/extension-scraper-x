(function () {
  'use strict';
  const XA = (globalThis.XArchive = globalThis.XArchive || {});
  const u = () => XA.util;

  const CHAIN_MAX_GAP_MIN = 30;

  function expandTruncatedText(root) {
    root.querySelectorAll('[data-testid="tweet-text-show-more-link"]').forEach((btn) => {
      try { btn.click(); } catch (_) { /* expand is best effort */ }
    });
  }

  function findQuoteBox(tweet) {
    for (const el of tweet.querySelectorAll('div[role="link"]')) {
      const href = el.getAttribute('href') || '';
      if (href.includes('/photo/')) continue;
      if (el.querySelector('[data-testid="User-Name"]') &&
          (el.querySelector('[data-testid="tweetText"]') ||
           el.querySelector('[data-testid="testCondensedMedia"]') ||
           el.querySelector('[data-testid="tweetPhoto"]'))) {
        return el;
      }
    }
    return null;
  }

  function upgradeMediaUrl(src) {
    try {
      const url = new URL(src);
      if (url.hostname.includes('pbs.twimg.com') && url.searchParams.has('name')) {
        url.searchParams.set('name', 'large');
      }
      return url.href;
    } catch (_) {
      return src;
    }
  }

  function isSkippedImage(src) {
    return !src || src.includes('profile_images') ||
      src.includes('emoji') || src.includes('hashflags');
  }

  function collectLinkCard(tweet, quoteBox) {
    const card = tweet.querySelector('[data-testid="card.wrapper"]');
    if (!card || (quoteBox && quoteBox.contains(card))) return null;
    const a = card.querySelector('a[href]');
    const img = card.querySelector('img');
    return {
      url: a ? a.href : null,
      title: (a && a.getAttribute('aria-label')) || XA.util.textOf(card).split('\n')[0] || '',
      image: img ? img.src : null
    };
  }

  function collectPhotoEntries(root) {
    const entries = [];
    const seen = new Set();
    const add = (img) => {
      if (!img) return;
      const src = img.getAttribute('src');
      if (isSkippedImage(src)) return;
      const upgraded = upgradeMediaUrl(src);
      if (seen.has(upgraded)) return;
      seen.add(upgraded);
      entries.push({ url: upgraded, type: 'image', alt: img.getAttribute('alt') || null });
    };
    root.querySelectorAll('[data-testid="tweetPhoto"] img, img[src*="pbs.twimg.com/media/"]')
      .forEach(add);
    root.querySelectorAll('a[href*="/photo/"]').forEach((a) => add(a.querySelector('img')));
    return entries;
  }

  function collectVideoEntries(root) {
    const entries = [];
    const seen = new Set();
    const permalinks = [];
    root.querySelectorAll('a[href*="/video/"]').forEach((a) => {
      const p = u().absUrl(a.getAttribute('href'));
      if (p && !permalinks.includes(p)) permalinks.push(p);
    });
    const add = (src, poster) => {
      if (!src || seen.has(src)) return;
      seen.add(src);
      entries.push({
        url: src, type: 'video', poster: poster || null,
        permalink: permalinks[0] || null
      });
    };
    root.querySelectorAll('video').forEach((v) => {
      const poster = v.getAttribute('poster');
      const src = v.currentSrc || v.getAttribute('src');
      add(src, poster);
      if (poster && !src) {
        if (!seen.has(poster)) {
          seen.add(poster);
          entries.push({ url: poster, type: 'video', poster, permalink: permalinks[0] || null, posterOnly: true });
        }
      }
      v.querySelectorAll('source').forEach((s) => add(s.getAttribute('src'), poster));
    });
    if (!entries.length && permalinks.length) {
      for (const p of permalinks) {
        entries.push({ url: p, type: 'video', poster: null, permalink: p });
      }
    }
    return entries;
  }

  function insideQuote(quoteBox, node) {
    return !!(quoteBox && node && quoteBox.contains(node));
  }

  function quoteTweetUrl(quoteBox, fallback) {
    const photo = quoteBox.querySelector(
      'a[href*="/status/"][href*="/photo/"], a[href*="/status/"][href*="/video/"]');
    if (photo) {
      const h = photo.getAttribute('href').split('?')[0].replace(/\/(photo|video)\/\d+$/, '');
      return u().absUrl(h);
    }
    const time = quoteBox.querySelector('time');
    const timeA = time && time.closest('a');
    if (timeA && (timeA.getAttribute('href') || '').includes('/status/')) {
      return u().absUrl(timeA.getAttribute('href'));
    }
    const statusA = quoteBox.querySelector('a[href*="/status/"]');
    if (statusA) {
      const h = statusA.getAttribute('href').split('?')[0].replace(/\/(photo|video)\/\d+$/, '');
      return u().absUrl(h);
    }
    const reactUrl = quoteUrlFromReactProps(quoteBox);
    if (reactUrl) return reactUrl;
    return fallback || null;
  }

  function quoteUrlFromReactProps(quoteBox) {
    try {
      const fk = Object.keys(quoteBox).find((k) => k.startsWith('__reactFiber'));
      if (!fk) return null;
      const seen = new Set();
      const scan = (n, depth) => {
        if (!n || depth > 40 || seen.has(n)) return null;
        seen.add(n);
        const mp = n.memoizedProps || n.pendingProps;
        if (mp) {
          if (mp.quotedTweetId && mp.quotedTweetPermalink && mp.quotedTweetPermalink.expanded) {
            return String(mp.quotedTweetPermalink.expanded)
              .replace('https://twitter.com/', 'https://x.com/').split('?')[0];
          }
          if (mp.quotedTweetId) return 'https://x.com/i/status/' + mp.quotedTweetId;
        }
        return scan(n.child, depth + 1) || scan(n.sibling, depth + 1);
      };
      return scan(quoteBox[fk], 0);
    } catch (_) {
      return null;
    }
  }

  function extractQuote(quoteBox) {
    const quoteUserDiv = quoteBox.querySelector('[data-testid="User-Name"]');
    const quoteTextEl = quoteBox.querySelector('[data-testid="tweetText"]');
    const quoteTime = quoteBox.querySelector('time');
    let qName = null;
    let qHandle = null;
    let qProfile = null;
    const qAvatarImg = quoteBox.querySelector('[data-testid^="UserAvatar-Container"] img');
    const qAvatar = qAvatarImg && qAvatarImg.src
      ? qAvatarImg.src.replace('_normal.', '_400x400.').replace('_x96.', '_400x400.') : null;
    if (quoteUserDiv) {
      const lines = XA.util.textOf(quoteUserDiv).split('\n').map((s) => s.trim()).filter(Boolean);
      qName = lines[0] || null;
      qHandle = lines.find((l) => l.startsWith('@')) || null;
      const qLink = quoteUserDiv.querySelector('a[href^="/"]');
      if (qLink) qProfile = u().absUrl(qLink.getAttribute('href'));
      if (!qHandle && qLink) {
        qHandle = '@' + qLink.getAttribute('href').split('?')[0].replace(/^\//, '');
      }
    }
    const photos = collectPhotoEntries(quoteBox);
    const videos = collectVideoEntries(quoteBox);
    return {
      quoted_tweet_url: quoteTweetUrl(quoteBox, null),
      quoted_author_name: qName,
      quoted_author_handle: qHandle,
      quoted_profile_url: qProfile || (qHandle ? 'https://x.com/' + qHandle.replace(/^@/, '') : null),
      quoted_avatar_url: qAvatar,
      quoted_timestamp_iso: quoteTime ? quoteTime.getAttribute('datetime') : null,
      quoted_date_displayed: quoteTime ? (XA.util.textOf(quoteTime) || quoteTime.textContent) : null,
      quoted_text: quoteTextEl ? XA.util.textOf(quoteTextEl) : '',
      quoted_images: photos.map((p) => p.url),
      quoted_videos: videos.map((v) => v.permalink || v.url)
    };
  }

  function findReplyBanner(tweet) {
    return Array.from(tweet.querySelectorAll('span')).find((span) =>
      /^\s*Replying to\b/.test(XA.util.textOf(span))) || null;
  }

  function extractReplyingTo(replySpan) {
    const out = [];
    if (!replySpan) return out;
    const parentRow = replySpan.closest('div');
    if (!parentRow) return out;
    parentRow.querySelectorAll('a').forEach((link) => {
      const text = (XA.util.textOf(link) || '').trim();
      if (text.startsWith('@')) {
        out.push({
          handle: text,
          profile_url: u().absUrl((link.getAttribute('href') || '').split('?')[0])
        });
      }
    });
    return out;
  }

  const METRIC_TESTIDS = [
    [/^reply$/, 'replies'],
    [/retweet|unretweet/, 'reposts'],
    [/^like$|^unlike$/, 'likes'],
    [/bookmark/i, 'bookmarks']
  ];

  function extractMetrics(tweet) {
    const metrics = { replies: null, reposts: null, likes: null, bookmarks: null, views: null };
    const groupDiv = tweet.querySelector('div[role="group"][aria-label]');
    if (groupDiv) {
      const aria = groupDiv.getAttribute('aria-label') || '';
      const parsed = u().parseMetricsFromAria(aria);
      for (const k of Object.keys(metrics)) {
        if (parsed[k] != null) metrics[k] = parsed[k];
      }
    }
    for (const el of tweet.querySelectorAll('[data-testid][aria-label]')) {
      const tid = el.getAttribute('data-testid') || '';
      const aria = el.getAttribute('aria-label') || '';
      for (const [pat, key] of METRIC_TESTIDS) {
        if (metrics[key] == null && pat.test(tid)) {
          const m = aria.match(/(\d[\d,.]*)\s*([KkMmBb])?/);
          if (m) {
            const n = parseFloat(m[1].replace(/,/g, ''));
            const mult = { K: 1e3, M: 1e6, B: 1e9 }[(m[2] || '').toUpperCase()] || 1;
            metrics[key] = Math.round(n * mult);
          } else if (/^0\b/.test(aria)) metrics[key] = 0;
        }
      }
    }
    if (metrics.views == null) {
      const viewEl = tweet.querySelector('a[href*="/analytics"], a[aria-label*="View"]');
      if (viewEl) {
        const m = (viewEl.getAttribute('aria-label') || XA.util.textOf(viewEl) || '')
          .match(/(\d[\d,.]*)\s*([KkMmBb])?/);
        if (m) {
          const n = parseFloat(m[1].replace(/,/g, ''));
          const mult = { K: 1e3, M: 1e6, B: 1e9 }[(m[2] || '').toUpperCase()] || 1;
          metrics.views = Math.round(n * mult);
        }
      }
    }
    return metrics;
  }

  function findShowThreadLink(tweet, quoteBox) {
    for (const a of tweet.querySelectorAll('a')) {
      if (insideQuote(quoteBox, a)) continue;
      const t = (XA.util.textOf(a) || '').trim().toLowerCase();
      if (t === 'show this thread' || t === 'this thread') {
        return u().absUrl(a.getAttribute('href'));
      }
    }
    return null;
  }

  function numberedCounter(text) {
    if (!text) return null;
    const m = String(text).match(/(?:^|[\s(])(\d{1,2})\s*\/\s*(\d{1,3})(?![\d/])/);
    if (!m) return null;
    const n = parseInt(m[1], 10);
    const total = parseInt(m[2], 10);
    if (n < 1 || total < 2 || n > total) return null;
    return { n, total };
  }

  function articleHandle(tweet) {
    const link = tweet.querySelector('[data-testid="User-Name"] a[href^="/"]');
    if (!link) return null;
    return link.getAttribute('href').split('?')[0].replace(/^\//, '') || null;
  }

  function articleTimestamp(tweet) {
    const t = tweet.querySelector('time');
    const dt = t && t.getAttribute('datetime');
    const ms = dt ? Date.parse(dt) : NaN;
    return Number.isNaN(ms) ? null : ms;
  }

  function extractArticle(article, ctx) {
    const c = ctx || {};
    const warnings = [];

    const timeElement = article.querySelector('time');
    const timeAnchor = timeElement ? timeElement.closest('a') : null;
    let href = timeAnchor && timeAnchor.getAttribute('href');
    if ((!href || !href.includes('/status/')) && timeElement && c.allowFocusedRoot && c.conversationUrl) {
      href = c.conversationUrl;
    }
    if (!href || !href.includes('/status/')) {
      const anyStatus = article.querySelector('a[href*="/status/"]');
      if (anyStatus && timeElement) href = anyStatus.getAttribute('href');
    }
    if (!href || !href.includes('/status/')) return null;
    const tweetUrl = u().canonicalStatusUrl(href);

    const quoteBox = findQuoteBox(article);
    const post = XA.postModel.normalizePost({ tweet_url: tweetUrl }, {
      captureContext: c.captureContext || 'timeline',
      sourceKey: c.sourceKey,
      sourceType: c.sourceType
    });

    const userNameDiv = article.querySelector('[data-testid="User-Name"]');
    if (userNameDiv) {
      const userLink = userNameDiv.querySelector('a[href^="/"]');
      post.name = (userLink && XA.util.textOf(userLink).trim()) ||
        XA.util.textOf(userNameDiv).split('\n').map((s) => s.trim()).filter(Boolean)[0] || null;
      if (userLink) {
        const rawHref = userLink.getAttribute('href').split('?')[0];
        post.handle = '@' + rawHref.replace(/^\//, '');
        post.profile_url = 'https://x.com' + rawHref;
      }
    }
    const avatarImg = article.querySelector('[data-testid="Tweet-User-Avatar"] img');
    if (avatarImg && avatarImg.src && !avatarImg.src.includes('emoji')) {
      post.avatar_url = avatarImg.src.replace('_normal.', '_400x400.').replace('_x96.', '_400x400.');
    }
    const social = article.querySelector('[data-testid="socialContext"]');
    post.social_context = social ? XA.util.textOf(social).trim() : null;
    post.link_card = collectLinkCard(article, quoteBox);

    if (timeElement) {
      post.timestamp_iso = timeElement.getAttribute('datetime');
      post.date_displayed = XA.util.textOf(timeElement) || timeElement.textContent;
    }

    const replySpan = findReplyBanner(article);
    post.replying_to = extractReplyingTo(replySpan);
    post.is_reply = post.replying_to.length > 0 || !!replySpan;

    const selfHandle = (post.handle || (c.author ? '@' + String(c.author).replace(/^@/, '') : ''))
      .toLowerCase();
    post.is_self_reply = post.replying_to.some(
      (r) => selfHandle && r.handle.toLowerCase() === selfHandle);
    if (post.is_self_reply) {
      post.is_thread = true;
      if (post.thread_role === 'standalone') post.thread_role = 'reply';
      const parentAnchor = replySpan &&
        replySpan.closest('div') &&
        replySpan.closest('div').querySelector('a[href*="/status/"]');
      if (parentAnchor) post.thread_id = u().absUrl(parentAnchor.getAttribute('href'));
    }

    const mainTextEl = Array.from(article.querySelectorAll('[data-testid="tweetText"]'))
      .find((el) => !insideQuote(quoteBox, el));
    post.text = mainTextEl ? XA.util.textOf(mainTextEl) : '';
    if (mainTextEl) {
      post.links = Array.from(mainTextEl.querySelectorAll('a[href]')).map((a) => ({
        display: XA.util.textOf(a),
        href: a.href
      }));
    }

    const quoteImgUrls = quoteBox
      ? new Set(collectPhotoEntries(quoteBox).map((p) => p.url)) : new Set();
    const photos = collectPhotoEntries(article).filter((p) => !quoteImgUrls.has(p.url));
    post.images = photos.map((p) => p.url);

    const videos = collectVideoEntries(article).filter((v) =>
      !quoteBox || !quoteBox.querySelector('video, a[href*="/video/"]') ||
      !insideQuote(quoteBox, findVideoNode(article, v)));
    post.videos = videos.map((v) => v.permalink || v.url);
    post.media = [
      ...photos.map((p) => ({ url: p.url, type: 'image', alt: p.alt })),
      ...videos
    ];
    for (const v of videos) {
      if (v.url && /^blob:/i.test(v.url)) {
        warnings.push('video-blob-url: video data is a temporary blob reference, not a durable file');
      }
    }

    if (quoteBox) {
      post.quote_context = extractQuote(quoteBox);
      if (post.quote_context && !post.quote_context.quoted_tweet_url) {
        warnings.push('quote-url-missing: quoted post URL not found in DOM');
      }
    }

    post.metrics = extractMetrics(article);
    if (!article.querySelector('div[role="group"][aria-label]')) {
      warnings.push('metrics-unavailable: engagement counters not rendered');
    }

    post.show_thread_link = findShowThreadLink(article, quoteBox);
    const counter = numberedCounter(post.text);
    post.thread_candidates = threadCandidatesFor(post, c, counter);

    if (c.captureContext === 'thread') {
      post.is_thread = true;
      post.thread_role = 'thread';
      post.thread_id = u().canonicalStatusUrl(c.conversationUrl);
      post.thread_scraped = true;
    }

    post.warnings = warnings;
    return post;
  }

  function findVideoNode(article, v) {
    for (const video of article.querySelectorAll('video')) {
      if (video.currentSrc === v.url || video.getAttribute('src') === v.url) return video;
    }
    return null;
  }

  function threadCandidatesFor(post, ctx, counter) {
    const c = ctx || {};
    if (c.sourceType !== 'profile' && !c.allowCandidates) return [];
    const out = [];
    const selfUrl = post.tweet_url;
    if (post.show_thread_link) {
      out.push({ url: post.show_thread_link, reason: 'show-thread-link', confidence: 'high' });
    }
    if (post.is_self_reply) {
      out.push({ url: post.thread_id || selfUrl, reason: 'self-reply', confidence: 'high' });
    }
    if (counter) {
      out.push({ url: selfUrl, reason: 'numbered-counter ' + counter.n + '/' + counter.total, confidence: 'medium' });
    }
    return out;
  }

  function stitchPairs(ordered, prevTail) {
    const roles = new Map();
    for (let i = 0; i < ordered.length - 1; i++) {
      const a = ordered[i];
      const b = ordered[i + 1];
      if (!a.handle || !b.handle || a.handle.toLowerCase() !== b.handle.toLowerCase()) continue;
      if (a.ts == null || b.ts == null) continue;
      const gapMin = (b.ts - a.ts) / 60000;
      if (gapMin < 0 || gapMin > CHAIN_MAX_GAP_MIN) continue;
      const roleA = roles.get(a.el);
      roles.set(a.el, roleA === 'last' || roleA === 'middle' ? 'middle' : 'first');
      roles.set(b.el, roles.has(b.el) && roles.get(b.el) !== 'last' ? 'middle' : 'last');
    }
    if (prevTail && ordered.length && ordered[0].handle && prevTail.handle &&
        ordered[0].handle.toLowerCase() === prevTail.handle.toLowerCase()) {
      const t0 = ordered[0].ts;
      if (t0 != null && prevTail.ts != null) {
        const gapMin = (t0 - prevTail.ts) / 60000;
        if (gapMin >= 0 && gapMin <= CHAIN_MAX_GAP_MIN) {
          const roleA = roles.get(ordered[0].el);
          roles.set(ordered[0].el, roleA ? (roleA === 'first' ? 'middle' : roleA) : 'first');
          return { roles, continuedFrom: prevTail.url };
        }
      }
    }
    return { roles, continuedFrom: null };
  }

  function extractVisible(root, ctx) {
    const c = ctx || {};
    const scope = root || document;
    const articles = Array.from(scope.querySelectorAll('article[data-testid="tweet"]'));

    const ordered = articles.map((el) => ({
      el, handle: articleHandle(el), ts: articleTimestamp(el)
    }));
    const { roles, continuedFrom } = stitchPairs(ordered, c.prevTail);

    const posts = [];
    const seen = new Set();
    for (const el of articles) {
      if (c.autoExpandText !== false) expandTruncatedText(el);
      const post = extractArticle(el, c);
      if (!post || seen.has(post.id)) continue;
      seen.add(post.id);
      const stitchRole = roles.get(el);
      if (stitchRole) {
        post.is_thread = true;
        post.thread_role = stitchRole === 'first' ? 'root' : 'reply';
        post.is_self_reply = post.is_self_reply || stitchRole !== 'first';
        if (!post.thread_candidates.some((t) => t.reason === 'stitched-chain')) {
          post.thread_candidates.push({
            url: post.tweet_url, reason: 'stitched-chain', confidence: 'low'
          });
        }
      }
      posts.push(post);
    }

    const tail = ordered[ordered.length - 1];
    const newTail = tail ? {
      handle: tail.handle,
      ts: tail.ts,
      url: postUrlFor(tail.el)
    } : null;

    return { posts, tail: newTail, continuedFrom };
  }

  function postUrlFor(el) {
    const t = el.querySelector('time');
    const a = t && t.closest('a');
    const href = a && a.getAttribute('href');
    return href && href.includes('/status/') ? u().canonicalStatusUrl(href) : null;
  }

  XA.extractor = {
    CHAIN_MAX_GAP_MIN,
    expandTruncatedText, findQuoteBox, upgradeMediaUrl,
    collectLinkCard, collectPhotoEntries, collectVideoEntries,
    extractQuote, extractMetrics, numberedCounter,
    extractArticle, extractVisible, findShowThreadLink, stitchPairs
  };
})();
