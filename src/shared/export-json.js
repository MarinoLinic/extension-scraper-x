(function () {
  'use strict';
  const XA = (globalThis.XArchive = globalThis.XArchive || {});

  const ARCHIVE_SCHEMA_VERSION = 1;

  function buildEnvelope(run, posts) {
    const r = run || {};
    return {
      schemaVersion: ARCHIVE_SCHEMA_VERSION,
      archive: {
        id: r.id || null,
        source: r.source || null,
        state: r.state || null,
        createdAt: r.createdAt || null,
        updatedAt: r.updatedAt || null,
        completedAt: r.completedAt || null,
        stopReason: r.stopReason || null,
        settings: r.settings || null,
        stats: r.stats || null,
        warnings: r.warnings || []
      },
      posts: posts || []
    };
  }

  function serializeJson(run, posts, format) {
    if (format === 'legacy') {
      return JSON.stringify(posts || [], null, 2);
    }
    return JSON.stringify(buildEnvelope(run, posts), null, 2);
  }

  XA.exportJson = { ARCHIVE_SCHEMA_VERSION, buildEnvelope, serializeJson };
})();
