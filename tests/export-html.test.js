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

  it('marks posts with data attributes for client filtering', () => {
    expect(html).toContain('data-search=');
    expect(html).toContain('data-media="1"');
    expect(html).toContain('data-ts=');
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
