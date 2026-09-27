import { describe, it, expect } from 'vitest';
import { XA } from './helpers/load.js';

const { renderHtmlReport, linkifyText } = XA.exportHtml;
const pm = XA.postModel;

const run = {
  id: 'run_1',
  source: { type: 'profile', label: '@alice posts', handle: 'alice', sourceUrl: 'https://x.com/alice', key: 'profile:alice:posts' },
  state: 'completed',
  stopReason: 'completed',
  createdAt: '2024-05-01T00:00:00.000Z',
  stats: { posts: 1 }
};

const hostile = pm.normalizePost({
  tweet_url: 'https://x.com/a/status/1',
  name: '<script>alert(1)</script>',
  handle: '@a',
  text: 'check <img src=x onerror=alert(1)> and https://example.com/?a=1&b=2</script>',
  timestamp_iso: '2024-01-01T00:00:00.000Z',
  images: ['https://pbs.twimg.com/media/IMG1?name=large'],
  metrics: { replies: 1 }
});

describe('HTML report safety', () => {
  const html = renderHtmlReport(run, [hostile]);

  it('escapes untrusted author/text content', () => {
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<img src=x onerror=alert(1)>');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('linkifies URLs without breaking the document', () => {
    const out = linkifyText('see https://example.com/x?y=1&z=2 ok');
    expect(out).toContain('href="https://example.com/x?y=1&amp;z=2"');
    expect(out).toContain('>https://example.com/x?y=1&amp;z=2</a>');
    expect(out).not.toContain('<script');
  });

  it('strips trailing punctuation from literal URLs', () => {
    const out = linkifyText('see https://example.com/a.');
    expect(out).toContain('href="https://example.com/a"');
    expect(out).toContain('</a>.');
  });

  it('anchors captured display text to its resolved href', () => {
    const out = linkifyText('watch youtube.com/watch?v=j3fWQ… now', [
      { display: 'youtube.com/watch?v=j3fWQ…', href: 'https://youtube.com/watch?v=j3fWQwd_p_4' }
    ]);
    expect(out).toContain('href="https://youtube.com/watch?v=j3fWQwd_p_4"');
    expect(out).toContain('>youtube.com/watch?v=j3fWQ…</a>');
  });

  it('captured display links win over literal URLs at the same position', () => {
    const out = linkifyText('https://example.com/x', [
      { display: 'https://example.com/x', href: 'https://resolved.example.com/y' }
    ]);
    expect(out).toContain('href="https://resolved.example.com/y"');
    expect(out.match(/<a /g)).toHaveLength(1);
  });

  it('never anchors captured displays whose href fails the allowlist', () => {
    const out = linkifyText('click here', [
      { display: 'click here', href: 'javascript:alert(1)' }
    ]);
    expect(out).not.toContain('<a ');
    expect(out).toContain('click here');
  });

  it('keeps media-only hrefs (data:, blob:, media/ paths) as plain text', () => {
    const out = linkifyText('one two three', [
      { display: 'one', href: 'data:image/png;base64,AAAA' },
      { display: 'two', href: 'blob:https://x.com/abcd' },
      { display: 'three', href: 'media/1_post_0.jpg' }
    ]);
    expect(out).toBe('one two three');
  });

  it('normalizes protocol-relative captured hrefs to https', () => {
    const out = linkifyText('go to example.com/x', [
      { display: 'example.com/x', href: '//example.com/x' }
    ]);
    expect(out).toContain('href="https://example.com/x"');
  });

  it('chooses the leftmost overlapping captured display regardless of link order', () => {
    const out = linkifyText('see first part ends now', [
      { display: 'part ends now', href: 'https://b.example.com/right' },
      { display: 'first part ends', href: 'https://a.example.com/left' }
    ]);
    expect(out).toContain('href="https://a.example.com/left"');
    expect(out).toContain('>first part ends</a> now');
    expect(out).not.toContain('b.example.com');
  });

  it('contains no remote scripts or styles', () => {
    expect(html).not.toMatch(/<script[^>]+src=/i);
    expect(html).not.toMatch(/<link[^>]+href=/i);
    expect(html).not.toContain('http-equiv');
  });

  it('renders metadata header and warning box', () => {
    const pending = renderHtmlReport(Object.assign({}, run, { state: 'paused' }), [hostile]);
    expect(pending).toContain('may be incomplete');
    expect(html).toContain('@alice posts');
    expect(html).toContain('1 posts');
  });

  it('shows quote completion and fulfillment completion counts', () => {
    const p = pm.normalizePost({
      tweet_url: 'https://x.com/a/status/3',
      quote_context: { quoted_tweet_url: 'https://x.com/b/status/4', quoted_fetched: true, quoted_text: 'full quote' }
    });
    const legacy = pm.normalizePost({
      tweet_url: 'https://x.com/a/status/5',
      quote_context: { quoted_tweet_url: 'https://x.com/b/status/6', quoted_text_backfilled: true, quoted_text: 'legacy quote' }
    });
    const out = renderHtmlReport(Object.assign({}, run, {
      fulfillment: { done: 2, incomplete: 1, failed: 1 }
    }), [p, legacy]);
    expect(out.match(/Quote completed/g)).toHaveLength(2);
    expect(out).toContain('Build upon: 2 done, 1 incomplete, 1 failed');
  });

  it('linkifies URLs in meta lines and run warnings', () => {
    const out = renderHtmlReport(Object.assign({}, run, {
      warnings: ['capture stopped early — see https://status.example.com/x']
    }), [hostile]);
    expect(out).toContain('Source: <a href="https://x.com/alice"');
    expect(out).toContain('<a href="https://status.example.com/x"');
  });

  it('uses captured links for main text and linkifies a card title without a URL', () => {
    const p = pm.normalizePost({
      tweet_url: 'https://x.com/a/status/42',
      text: 'watch youtube.com/watch?v=j3fWQ… for details',
      links: [{ display: 'youtube.com/watch?v=j3fWQ…', href: 'https://youtube.com/watch?v=j3fWQwd_p_4' }],
      link_card: { url: null, title: 'episode at https://example.com/ep9', image: null },
      warnings: ['see https://warn.example.com/x'],
      social_context: 'From https://context.example.com/y'
    });
    const out = renderHtmlReport(run, [p]);
    expect(out).toContain('href="https://youtube.com/watch?v=j3fWQwd_p_4"');
    expect(out).toContain('>youtube.com/watch?v=j3fWQ…</a>');
    expect(out).toContain('href="https://example.com/ep9"');
    expect(out).toContain('href="https://warn.example.com/x"');
    expect(out).toContain('href="https://context.example.com/y"');
  });

  it('marks posts with data attributes for client filtering', () => {
    expect(html).toContain('data-search=');
    expect(html).toContain('data-media="1"');
    expect(html).toContain('data-ts=');
  });
});

describe('URL protocol allowlisting', () => {
  const evil = pm.normalizePost({
    tweet_url: 'https://x.com/a/status/1',
    name: 'Eve', handle: '@eve',
    avatar_url: 'data:text/html;base64,PHNjcmlwdD4=',
    text: 'payloads',
    is_thread: true,
    thread_id: 'javascript:alert(1)',
    images: ['javascript:alert(2)', 'https://pbs.twimg.com/media/OK.jpg'],
    videos: ['javascript:alert(3)'],
    link_card: { url: 'javascript:alert(4)', title: 'evil card', image: 'data:text/html;base64,AAAA' },
    quote_context: {
      quoted_author_name: 'q',
      quoted_tweet_url: 'javascript:alert(5)',
      quoted_text: 'quoted',
      quoted_images: ['javascript:alert(6)'],
      quoted_videos: ['data:text/html;base64,BBBB']
    },
    media: [
      { url: 'javascript:alert(7)', type: 'image' },
      { url: 'javascript:alert(8)', type: 'video', poster: 'javascript:alert(9)', permalink: 'javascript:alert(10)' }
    ],
    replying_to: [{ handle: '@mallory', profile_url: 'javascript:alert(11)' }],
    timestamp_iso: '2024-01-01T00:00:00.000Z'
  });
  const html = renderHtmlReport(run, [evil]);

  it('emits no executable javascript/data URLs in href, src or fallback attributes', () => {
    expect(html).not.toMatch(/href="javascript:/i);
    expect(html).not.toMatch(/src="javascript:/i);
    expect(html).not.toMatch(/href="data:/i);
    expect(html).not.toMatch(/src="data:(?!image\/)/i);
    expect(html).not.toMatch(/data-remote="javascript:/i);
  });

  it('never falls back to "#" for a rejected card URL', () => {
    expect(html).not.toContain('href="#"');
    expect(html).toContain('evil card');
  });

  it('keeps safe https media and images intact', () => {
    expect(html).toContain('src="https://pbs.twimg.com/media/OK.jpg"');
    expect(html).toContain('href="https://pbs.twimg.com/media/OK.jpg"');
  });

  it('renders rejected video/image URLs as non-clickable text or omits them', () => {
    expect(html).not.toContain('data:text/html');
    expect(html).toContain('no durable URL');
  });

  it('uses the normalized allowlisted value in quote hrefs', () => {
    const p = pm.normalizePost({
      tweet_url: 'https://x.com/a/status/9',
      quote_context: {
        quoted_tweet_url: '//x.com/b/status/55',
        quoted_author_name: 'b',
        quoted_text: 'q'
      }
    });
    const out = renderHtmlReport(run, [p]);
    expect(out).toContain('href="https://x.com/b/status/55"');
    expect(out).not.toContain('href="//x.com/b/status/55"');
  });
});

describe('offline media rewriting', () => {
  it('rewrites downloaded images to local paths and keeps remote fallback', () => {
    const html = renderHtmlReport(run, [hostile], {
      offline: true,
      mediaMap: { 'https://pbs.twimg.com/media/IMG1?name=large': 'media/1_post_0.jpg' }
    });
    expect(html).toContain('src="media/1_post_0.jpg"');
    expect(html).toContain('data-remote="https://pbs.twimg.com/media/IMG1?name=large"');
  });

  it('keeps remote URLs for images not in the map', () => {
    const html = renderHtmlReport(run, [hostile], { offline: true, mediaMap: {} });
    expect(html).toContain('src="https://pbs.twimg.com/media/IMG1?name=large"');
  });
});
