import { describe, it, expect } from 'vitest';
import { XA } from './helpers/load.js';

const pm = XA.postModel;

describe('canonical identity', () => {
  it('parses status ids from URLs', () => {
    expect(XA.util.statusIdFromUrl('https://x.com/a/status/123')).toBe('123');
    expect(XA.util.statusIdFromUrl('https://twitter.com/a/status/456')).toBe('456');
    expect(XA.util.statusIdFromUrl('https://x.com/a')).toBeNull();
  });

  it('canonicalizes twitter.com to x.com and strips query/suffixes', () => {
    const p = pm.normalizePost({ tweet_url: 'https://twitter.com/a/status/123?ref=1' });
    expect(p.tweet_url).toBe('https://x.com/a/status/123');
    expect(p.id).toBe('123');
    const photo = pm.normalizePost({ tweet_url: 'https://x.com/a/status/9/photo/1' });
    expect(photo.tweet_url).toBe('https://x.com/a/status/9');
  });

  it('falls back to canonical URL when no status id exists', () => {
    const p = pm.normalizePost({ tweet_url: 'https://x.com/i/bookmarks' });
    expect(p.id).toBe('https://x.com/i/bookmarks');
  });
});

describe('merge richness policy', () => {
  const base = pm.normalizePost({
    tweet_url: 'https://x.com/a/status/1',
    name: 'A', handle: '@a',
    text: 'short',
    images: ['https://img/1'],
    links: [{ display: 'x', href: 'https://t.co/1' }],
    metrics: { replies: 5, reposts: null, likes: 10, bookmarks: null, views: null },
    capture_context: 'timeline',
    timestamp_iso: '2024-01-01T00:00:00.000Z'
  });

  it('longer text wins; non-null beats null', () => {
    const merged = pm.mergePosts(base, pm.normalizePost({
      tweet_url: 'https://x.com/a/status/1', text: 'a much longer full text', name: null
    }));
    expect(merged.text).toBe('a much longer full text');
    expect(merged.name).toBe('A');
  });

  it('shorter text does not overwrite', () => {
    const merged = pm.mergePosts(base, pm.normalizePost({ tweet_url: 'https://x.com/a/status/1', text: 'x' }));
    expect(merged.text).toBe('short');
  });

  it('unions links, media and reply targets', () => {
    const merged = pm.mergePosts(base, pm.normalizePost({
      tweet_url: 'https://x.com/a/status/1',
      images: ['https://img/2'],
      links: [{ display: 'x', href: 'https://t.co/1' }, { display: 'y', href: 'https://t.co/2' }],
      replying_to: [{ handle: '@b', profile_url: null }]
    }));
    expect(merged.images).toEqual(['https://img/1', 'https://img/2']);
    expect(merged.links.map((l) => l.href)).toEqual(['https://t.co/1', 'https://t.co/2']);
    expect(merged.replying_to).toHaveLength(1);
  });

  it('newest metrics win only when non-null', () => {
    const merged = pm.mergePosts(base, pm.normalizePost({
      tweet_url: 'https://x.com/a/status/1',
      metrics: { replies: 7, reposts: 3 }
    }));
    expect(merged.metrics.replies).toBe(7);
    expect(merged.metrics.reposts).toBe(3);
    expect(merged.metrics.likes).toBe(10);
  });

  it('thread capture enriches but does not erase timeline metadata', () => {
    const thread = pm.normalizePost({
      tweet_url: 'https://x.com/a/status/1',
      capture_context: 'thread',
      thread_id: 'https://x.com/a/status/1',
      links: [{ display: 'z', href: 'https://t.co/9' }]
    });
    const merged = pm.mergePosts(base, thread);
    expect(merged.capture_context).toBe('timeline');
    expect(merged.text).toBe('short');
    expect(merged.links.map((l) => l.href)).toContain('https://t.co/9');
    expect(merged.thread_id).toBe('https://x.com/a/status/1');
    expect(merged.thread_scraped).toBe(true);
  });

  it('returns the existing record unchanged for a semantically identical extraction', () => {
    const incoming = pm.normalizePost({
      tweet_url: 'https://x.com/a/status/1',
      name: 'A', handle: '@a',
      text: 'short',
      images: ['https://img/1'],
      links: [{ display: 'x', href: 'https://t.co/1' }],
      metrics: { replies: 5, reposts: null, likes: 10, bookmarks: null, views: null },
      capture_context: 'timeline',
      timestamp_iso: '2024-01-01T00:00:00.000Z'
    });
    const merged = pm.mergePosts(base, incoming);
    expect(merged).toEqual(base);
    expect(merged.updated_at).toBe(base.updated_at);
    expect(merged).toBe(base);
  });

  it('only bumps updated_at when another field actually changed', () => {
    const richer = pm.normalizePost({
      tweet_url: 'https://x.com/a/status/1',
      text: 'a longer text than before',
      timestamp_iso: '2024-01-01T00:00:00.000Z'
    });
    const merged = pm.mergePosts(base, richer);
    expect(merged).not.toBe(base);
    expect(merged.updated_at).not.toBe(base.updated_at);
    const mergedAgain = pm.mergePosts(merged, richer);
    expect(mergedAgain).toBe(merged);
  });
});

describe('import compatibility', () => {
  it('accepts raw legacy arrays', () => {
    const { posts, envelope } = pm.legacyPostsFromImport([{ tweet_url: 'https://x.com/a/status/1', text: 'hi' }]);
    expect(posts).toHaveLength(1);
    expect(envelope).toBeNull();
  });

  it('accepts the archive envelope', () => {
    const env = XA.exportJson.buildEnvelope(
      { id: 'r1', source: { key: 'profile:a:posts' }, state: 'completed' },
      [{ tweet_url: 'https://x.com/a/status/2' }]
    );
    const { posts, envelope } = pm.legacyPostsFromImport(env);
    expect(posts).toHaveLength(1);
    expect(envelope.id).toBe('r1');
    expect(env.schemaVersion).toBe(1);
  });

  it('serializes legacy mode as a bare array', () => {
    const out = XA.exportJson.serializeJson({ id: 'r' }, [{ tweet_url: 'x' }], 'legacy');
    const parsed = JSON.parse(out);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0].tweet_url).toBe('x');
    expect(parsed[0].archive).toBeUndefined();
  });

  it('reports unreadable shapes', () => {
    const { posts, warnings } = pm.legacyPostsFromImport({ nope: 1 });
    expect(posts).toHaveLength(0);
    expect(warnings.length).toBeGreaterThan(0);
  });
});
