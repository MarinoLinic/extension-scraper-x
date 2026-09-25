(function () {
  'use strict';
  const XA = (globalThis.XArchive = globalThis.XArchive || {});

  const RUN_STATES = [
    'idle', 'running', 'resting', 'paused', 'stopping',
    'completed', 'limited', 'error'
  ];

  const ACTIVE_STATES = ['running', 'resting', 'stopping'];
  const UNFINISHED_STATES = ['running', 'resting', 'paused', 'stopping'];

  const STOP_REASONS = [
    'manual', 'completed', 'max_posts', 'max_duration', 'oldest_date',
    'stalled', 'source_changed', 'replaced', 'error', 'imported'
  ];

  const MSG = {
    GET_TAB_CONTEXT: 'GET_TAB_CONTEXT',
    START_RUN: 'START_RUN',
    PAUSE_RUN: 'PAUSE_RUN',
    RESUME_RUN: 'RESUME_RUN',
    STOP_RUN: 'STOP_RUN',
    UPSERT_POSTS: 'UPSERT_POSTS',
    EXPORT_RUN: 'EXPORT_RUN',
    GET_RUN: 'GET_RUN',
    LIST_RUNS: 'LIST_RUNS',
    DELETE_RUN: 'DELETE_RUN',
    IMPORT_ARCHIVE: 'IMPORT_ARCHIVE',
    START_THREAD_QUEUE: 'START_THREAD_QUEUE',
    PAUSE_THREAD_QUEUE: 'PAUSE_THREAD_QUEUE',

    GET_SETTINGS: 'GET_SETTINGS',
    SAVE_SETTINGS: 'SAVE_SETTINGS',
    GET_STORAGE_USAGE: 'GET_STORAGE_USAGE',
    LIST_THREAD_JOBS: 'LIST_THREAD_JOBS',
    REQUEST_MEDIA_PERMISSION: 'REQUEST_MEDIA_PERMISSION',
    OPEN_ARCHIVE_PAGE: 'OPEN_ARCHIVE_PAGE',

    XAR_GET_CONTEXT: 'XAR_GET_CONTEXT',
    XAR_CONTENT_READY: 'XAR_CONTENT_READY',
    XAR_CONTROL: 'XAR_CONTROL',
    XAR_STATE: 'XAR_STATE',
    XAR_THREAD_JOB: 'XAR_THREAD_JOB',
    XAR_THREAD_RESULT: 'XAR_THREAD_RESULT',
    XAR_OFFSCREEN_EXPORT: 'XAR_OFFSCREEN_EXPORT',
    XAR_EXPORT_PROGRESS: 'XAR_EXPORT_PROGRESS'
  };

  const CAPTURE_CONTEXTS = ['timeline', 'thread', 'import'];

  const THREAD_JOB_STATES = [
    'queued', 'running', 'done', 'incomplete', 'failed', 'skipped', 'paused'
  ];

  const THREAD_CONFIDENCE = { HIGH: 'high', MEDIUM: 'medium', LOW: 'low' };

  XA.messages = {
    RUN_STATES, ACTIVE_STATES, UNFINISHED_STATES, STOP_REASONS, MSG,
    CAPTURE_CONTEXTS, THREAD_JOB_STATES, THREAD_CONFIDENCE
  };
})();
