import { describe, it, expect } from 'vitest';
import { XA } from './helpers/load.js';

const detect = (pathname, search = '') => XA.sourceDetector.detectSource({ pathname, search });

describe('source detection', () => {
  it('detects bookmarks', () => {
    const s = detect('/i/bookmarks');
    expect(s.supported).toBe(true);
    expect(s.type).toBe('bookmarks');
    expect(s.key).toBe('bookmarks');
    expect(s.label).toBe('Bookmarks');
  });

  it('detects bookmark folders as distinct sources', () => {
    const s = detect('/i/bookmarks/12345');
    expect(s.supported).toBe(true);
    expect(s.key).toBe('bookmarks:12345');
  });

  it('detects profile posts and tabs', () => {
    const posts = detect('/Alice');
    expect(posts.supported).toBe(true);
    expect(posts.type).toBe('profile');
    expect(posts.handle).toBe('Alice');
    expect(posts.tab).toBe('posts');
    expect(posts.key).toBe('profile:alice:posts');

    const replies = detect('/Alice/with_replies');
    expect(replies.tab).toBe('with_replies');
    expect(replies.key).toBe('profile:alice:with_replies');

    for (const tab of ['media', 'likes', 'highlights']) {
      const s = detect('/Alice/' + tab);
      expect(s.supported).toBe(true);
      expect(s.tab).toBe(tab);
      expect(s.key).toBe('profile:alice:' + tab);
    }
  });

  it('detects lists', () => {
    const s = detect('/i/lists/987654');
    expect(s.supported).toBe(true);
    expect(s.type).toBe('list');
    expect(s.key).toBe('list:987654');
  });

  it('detects search with query', () => {
    const s = detect('/search', '?q=cats%20dogs&src=typed_query');
    expect(s.supported).toBe(true);
    expect(s.type).toBe('search');
    expect(s.key).toBe('search:cats dogs');
    expect(s.label).toContain('cats dogs');
  });

  it('detects home and generic timelines', () => {
    expect(detect('/home').key).toBe('timeline:home');
    expect(detect('/').key).toBe('timeline:home');
    expect(detect('/explore').type).toBe('timeline');
    expect(detect('/notifications').type).toBe('timeline');
  });

  it('marks status pages as thread-worker-only', () => {
    const s = detect('/alice/status/1700000000000000001');
    expect(s.supported).toBe(false);
    expect(s.type).toBe('status');
    expect(s.reason).toMatch(/thread/i);
  });

  it('rejects DMs, settings, compose, login', () => {
    for (const path of ['/messages', '/messages/123', '/settings', '/compose/post', '/login', '/i/flow/login']) {
      const s = detect(path);
      expect(s.supported).toBe(false);
      expect(s.reason).toBeTruthy();
    }
  });

  it('rejects non-post profile sections', () => {
    const s = detect('/alice/followers');
    expect(s.supported).toBe(false);
    expect(s.reason).toMatch(/does not list posts/i);
  });

  it('produces stable keys regardless of handle case', () => {
    expect(detect('/ALICE').key).toBe(detect('/alice').key);
  });
});
