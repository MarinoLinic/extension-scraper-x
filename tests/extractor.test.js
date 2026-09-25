import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { XA, mountFixture, unmountFixture } from './helpers/load.js';

const ctx = (extra = {}) => Object.assign({
  captureContext: 'timeline',
  sourceKey: 'timeline:home',
  sourceType: 'timeline'
}, extra);

afterEach(() => unmountFixture());

describe('extractor — standard tweet', () => {
  let posts;
  beforeEach(() => {
    mountFixture('timeline.html');
    posts = XA.extractor.extractVisible(document, ctx()).posts;
  });

  it('extracts all articles', () => {
    expect(posts.length).toBe(5);
  });

  it('captures identity fields', () => {
    const p = posts[0];
    expect(p.id).toBe('1000000000000000001');
    expect(p.tweet_url).toBe('https://x.com/alice/status/1000000000000000001');
    expect(p.name).toBe('Alice Author');
    expect(p.handle).toBe('@alice');
    expect(p.profile_url).toBe('https://x.com/alice');
    expect(p.timestamp_iso).toBe('2024-05-01T10:00:00.000Z');
    expect(p.avatar_url).toContain('_400x400');
  });

  it('captures text and ordered links', () => {
    const p = posts[0];
    expect(p.text).toContain('Hello timeline world');
    expect(p.links.length).toBe(1);
    expect(p.links[0].display).toContain('example.com');
    expect(p.links[0].href).toBe('https://t.co/xyz');
  });

  it('upgrades photo URLs and captures alt text', () => {
    const p = posts[0];
    expect(p.images[0]).toContain('name=large');
    const img = p.media.find((m) => m.type === 'image');
    expect(img.alt).toBe('an attached photo');
  });

  it('parses plain metrics', () => {
    const m = posts[0].metrics;
    expect(m.replies).toBe(12);
    expect(m.reposts).toBe(34);
    expect(m.likes).toBe(56);
    expect(m.bookmarks).toBe(7);
    expect(m.views).toBe(890);
  });

  it('parses abbreviated metrics', () => {
    const m = posts[3].metrics;
    expect(m.replies).toBe(5);
    expect(m.reposts).toBe(1200);
    expect(m.likes).toBe(3400);
    expect(m.bookmarks).toBe(12);
    expect(m.views).toBe(2000000);
  });

  it('represents unavailable metrics as null with a warning', () => {
    const p = posts[4];
    expect(p.metrics.replies).toBeNull();
    expect(p.metrics.views).toBeNull();
    expect(p.warnings.some((w) => w.includes('metrics-unavailable'))).toBe(true);
  });

  it('captures replies and reply targets', () => {
    const p = posts[1];
    expect(p.is_reply).toBe(true);
    expect(p.replying_to.map((r) => r.handle)).toEqual(['@alice', '@carol']);
  });

  it('captures social context', () => {
    expect(posts[2].social_context).toBe('Bob reposted');
  });

  it('separates quote card content from main post', () => {
    const p = posts[2];
    expect(p.quote_context).toBeTruthy();
    expect(p.quote_context.quoted_author_handle).toBe('@dan');
    expect(p.quote_context.quoted_tweet_url).toBe('https://x.com/dan/status/2000000000000000009');
    expect(p.quote_context.quoted_text).toContain('quoted content');
    expect(p.quote_context.quoted_images[0]).toContain('QUOTEDIMG');
    expect(p.images).toHaveLength(1);
    expect(p.images[0]).toContain('MAINIMG2');
    expect(p.images[0]).not.toContain('QUOTEDIMG');
    expect(p.text).toBe('check this out');
  });

  it('captures link cards', () => {
    const p = posts[3];
    expect(p.link_card.url).toBe('https://t.co/cardabc');
    expect(p.link_card.title).toBe('An Example Site Article');
    expect(p.link_card.image).toContain('card_img');
  });

  it('captures video references and flags blob URLs', () => {
    const p = posts[3];
    const video = p.media.find((m) => m.type === 'video');
    expect(video).toBeTruthy();
    expect(video.poster).toContain('ext_tw_video_thumb');
    expect(video.permalink).toBe('https://x.com/erin/status/1000000000000000004/video/1');
    expect(p.warnings.some((w) => w.includes('video-blob-url'))).toBe(true);
  });

  it('flags numbered counters as thread candidates on profiles', () => {
    mountFixture('timeline.html');
    const prof = XA.extractor.extractVisible(document, ctx({
      sourceType: 'profile', sourceKey: 'profile:erin:posts', author: 'erin'
    })).posts;
    const p = prof[3];
    const cand = p.thread_candidates.find((c) => c.reason.includes('numbered-counter'));
    expect(cand).toBeTruthy();
    expect(cand.confidence).toBe('medium');
    expect(XA.util.statusIdFromUrl(cand.url)).toBe('1000000000000000004');
  });
});

describe('extractor — status page', () => {
  it('extracts the focused root via the conversation URL', () => {
    mountFixture('status.html');
    const { posts } = XA.extractor.extractVisible(document, ctx({
      captureContext: 'thread',
      conversationUrl: 'https://x.com/alice/status/3000000000000000001',
      allowFocusedRoot: true,
      author: 'alice'
    }));
    const root = posts.find((p) => p.text.includes('thread part one'));
    expect(root).toBeTruthy();
    expect(root.id).toBe('3000000000000000001');
    expect(root.tweet_url).toBe('https://x.com/alice/status/3000000000000000001');
  });

  it('marks thread capture context and thread_id', () => {
    mountFixture('status.html');
    const conv = 'https://x.com/alice/status/3000000000000000001';
    const { posts } = XA.extractor.extractVisible(document, ctx({
      captureContext: 'thread', conversationUrl: conv, allowFocusedRoot: true
    }));
    for (const p of posts) {
      expect(p.capture_context).toBe('thread');
      expect(p.thread_id).toBe(conv);
      expect(p.thread_scraped).toBe(true);
    }
  });
});

describe('extractor — stitching', () => {
  it('marks adjacent same-author posts inside the gap window', () => {
    mountFixture('status.html');
    const { posts } = XA.extractor.extractVisible(document, ctx({
      author: 'alice',
      allowFocusedRoot: true,
      conversationUrl: 'https://x.com/alice/status/3000000000000000001'
    }));
    const p1 = posts.find((p) => p.text.includes('part one'));
    const p2 = posts.find((p) => p.text.includes('part two'));
    const p3 = posts.find((p) => p.text.includes('part three'));
    const mal = posts.find((p) => p.handle === '@mallory');
    expect(p1.is_thread).toBe(true);
    expect(p1.thread_role).toBe('root');
    expect(p2.is_thread).toBe(true);
    expect(p2.thread_role).toBe('reply');
    expect(p3.is_thread).toBe(true);
    expect(p3.is_self_reply).toBe(true);
    expect(mal.is_thread).toBe(false);
  });
});
