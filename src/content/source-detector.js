(function () {
  'use strict';
  const XA = (globalThis.XArchive = globalThis.XArchive || {});

  const REJECT_PREFIXES = [
    ['/messages', 'Direct messages are not archived'],
    ['/settings', 'Settings pages do not contain posts'],
    ['/compose', 'Compose pages do not contain posts'],
    ['/login', 'Log in to X before archiving'],
    ['/logout', 'This page has no posts'],
    ['/signup', 'Log in to X before archiving'],
    ['/i/flow', 'Log in to X before archiving'],
    ['/i/connect_people', 'This page does not list posts'],
    ['/account', 'Account pages do not contain posts'],
    ['/help', 'Help pages do not contain posts'],
    ['/privacy', 'This page does not list posts'],
    ['/tos', 'This page does not list posts']
  ];

  const TIMELINE_ROUTES = {
    '': ['home', 'Home'],
    home: ['home', 'Home'],
    explore: ['explore', 'Explore'],
    notifications: ['notifications', 'Notifications']
  };

  const PROFILE_TABS = {
    with_replies: 'Replies',
    media: 'Media',
    likes: 'Likes',
    highlights: 'Highlights'
  };

  function makeSource(fields) {
    return Object.assign({
      key: 'unsupported',
      type: 'unsupported',
      label: 'Unsupported page',
      handle: null,
      tab: null,
      sourceUrl: null,
      supported: false,
      reason: 'This page is not supported for archiving'
    }, fields);
  }

  function detectSource(input) {
    const i = input || {};
    const path = String(i.pathname || '/').replace(/\/+$/, '') || '/';
    const search = String(i.search || '');
    const segs = path.split('/').filter(Boolean).map(decodeURIComponent);
    const sourceUrl = 'https://x.com' + path + (i.includeSearch === false ? '' : search);

    for (const [prefix, reason] of REJECT_PREFIXES) {
      if (path === prefix || path.startsWith(prefix + '/')) {
        return makeSource({ sourceUrl, reason });
      }
    }

    if (segs[0] === 'i') {
      if (segs[1] === 'bookmarks') {
        const folder = segs[2] || null;
        const key = folder ? 'bookmarks:' + folder.toLowerCase() : 'bookmarks';
        return makeSource({
          key, type: 'bookmarks',
          label: folder ? 'Bookmarks folder' : 'Bookmarks',
          sourceUrl, supported: true, reason: null
        });
      }
      if (segs[1] === 'lists' && segs[2]) {
        return makeSource({
          key: 'list:' + segs[2].toLowerCase(), type: 'list',
          label: 'List ' + segs[2],
          sourceUrl, supported: true, reason: null
        });
      }
      return makeSource({ sourceUrl, reason: 'This section of X is not a post timeline' });
    }

    if (segs[0] === 'search') {
      let q = '';
      try { q = new URLSearchParams(search).get('q') || ''; } catch (_) { /* ignore */ }
      return makeSource({
        key: 'search:' + q.trim().toLowerCase(),
        type: 'search',
        label: q ? 'Search "' + q + '"' : 'Search results',
        sourceUrl, supported: true, reason: null
      });
    }

    if (segs.length <= 1 && Object.prototype.hasOwnProperty.call(TIMELINE_ROUTES, segs[0] || '')) {
      const [which, label] = TIMELINE_ROUTES[segs[0] || ''];
      return makeSource({
        key: 'timeline:' + which, type: 'timeline', label,
        sourceUrl, supported: true, reason: null
      });
    }

    const handle = segs[0];
    if (segs.length === 1 && handle) {
      return makeSource({
        key: 'profile:' + handle.toLowerCase() + ':posts',
        type: 'profile', label: '@' + handle + ' posts',
        handle, tab: 'posts',
        sourceUrl, supported: true, reason: null
      });
    }

    if (segs.length === 2 && handle) {
      const second = segs[1].toLowerCase();
      if (Object.prototype.hasOwnProperty.call(PROFILE_TABS, second)) {
        return makeSource({
          key: 'profile:' + handle.toLowerCase() + ':' + second,
          type: 'profile', label: '@' + handle + ' ' + PROFILE_TABS[second],
          handle, tab: second,
          sourceUrl, supported: true, reason: null
        });
      }
      return makeSource({
        sourceUrl,
        reason: 'This section of @' + handle + ' does not list posts'
      });
    }

    if (segs.length === 3 && handle && segs[1].toLowerCase() === 'lists' && segs[2]) {
      return makeSource({
        key: 'list:' + segs[2].toLowerCase(), type: 'list',
        label: 'List ' + segs[2],
        sourceUrl, supported: true, reason: null
      });
    }

    if (segs.length >= 3 && handle && segs[1].toLowerCase() === 'status') {
      const id = segs[2].replace(/\D.*$/, '');
      return makeSource({
        key: 'status:' + id, type: 'status',
        label: 'Status ' + id,
        handle, tab: 'status',
        sourceUrl, supported: false,
        reason: 'Status pages are visited by assisted thread expansion, not archived directly'
      });
    }

    return makeSource({ sourceUrl });
  }

  XA.sourceDetector = { detectSource, makeSource, PROFILE_TABS, TIMELINE_ROUTES };
})();
