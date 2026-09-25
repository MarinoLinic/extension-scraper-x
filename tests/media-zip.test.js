import { describe, it, expect } from 'vitest';
import { XA } from './helpers/load.js';
import * as fflate from 'fflate';

const mz = XA.mediaZip;
const pm = XA.postModel;

function post(id, over = {}) {
  return pm.normalizePost(Object.assign({
    tweet_url: 'https://x.com/a/status/' + id,
    images: ['https://pbs.twimg.com/media/IMG' + id + '?name=large'],
    videos: ['blob:https://x.com/abcd-' + id],
    avatar_url: 'https://pbs.twimg.com/profile_images/' + id + '_400x400.png'
  }, over));
}

const posts = [
  post(1, {
    quote_context: {
      quoted_tweet_url: 'https://x.com/b/status/2',
      quoted_images: ['https://pbs.twimg.com/media/QIMG1?name=large']
    },
    link_card: { url: 'https://t.co/x', title: 'Card', image: 'https://pbs.twimg.com/card_img/1' }
  }),
  post(2, { images: ['https://pbs.twimg.com/media/IMG1?name=large'] })
];

describe('media target collection', () => {
  it('collects enabled kinds and dedupes URLs', () => {
    const t = mz.collectMediaTargets(posts, {
      postImages: true, quotedImages: true, cardImages: true, avatars: false
    });
    const urls = t.map((x) => x.url);
    expect(urls).toContain('https://pbs.twimg.com/media/IMG1?name=large');
    expect(urls).toContain('https://pbs.twimg.com/media/QIMG1?name=large');
    expect(urls).toContain('https://pbs.twimg.com/card_img/1');
    expect(urls.filter((u) => u === 'https://pbs.twimg.com/media/IMG1?name=large')).toHaveLength(1);
    expect(urls.some((u) => u.startsWith('blob:'))).toBe(false);
    expect(urls.some((u) => u.includes('profile_images'))).toBe(false);
  });

  it('respects media kind toggles', () => {
    const t = mz.collectMediaTargets(posts, {
      postImages: true, quotedImages: false, cardImages: false, avatars: false
    });
    expect(t.some((x) => x.kind === 'quote')).toBe(false);
    expect(t.some((x) => x.kind === 'card')).toBe(false);
    expect(t.length).toBe(1);
  });
});

describe('paths and extensions', () => {
  it('generates safe media paths', () => {
    expect(mz.mediaPathFor({ tweetId: '1', kind: 'post', index: 0 }, 'jpg'))
      .toBe('media/1_post_0.jpg');
    expect(mz.mediaPathFor({ tweetId: 'x:y/z', kind: 'quote', index: 2 }, 'png'))
      .toBe('media/x_y_z_quote_2.png');
  });

  it('prefers content type, falls back to URL extension', () => {
    expect(mz.extFor('https://x/img.png', 'image/webp')).toBe('webp');
    expect(mz.extFor('https://x/img.png', null)).toBe('png');
    expect(mz.extFor('https://x/img?format=jpg', 'image/jpeg')).toBe('jpg');
    expect(mz.extFor('https://x/img', 'text/html')).toBe('img');
  });
});

describe('ZIP build and manifest', () => {
  it('builds a readable zip with manifest recording failures', () => {
    const results = new Map([
      ['https://pbs.twimg.com/media/IMG1?name=large', { bytes: new Uint8Array([137, 80, 78, 71]), contentType: 'image/png' }],
      ['https://pbs.twimg.com/media/QIMG1?name=large', { bytes: new Uint8Array([1, 2, 3]), contentType: 'image/jpeg' }]
    ]);
    const failures = [{ url: 'https://pbs.twimg.com/card_img/1', error: 'HTTP 404' }];
    const { zipBytes, manifest, mediaMap } = mz.buildMediaZip({
      run: { id: 'r1', source: { label: 'test' }, state: 'completed' },
      posts,
      results,
      failures,
      mediaSettings: { postImages: true, quotedImages: true, cardImages: true, avatars: false }
    });

    const unzipped = fflate.unzipSync(zipBytes);
    const names = Object.keys(unzipped).sort();
    expect(names).toContain('archive.json');
    expect(names).toContain('index.html');
    expect(names).toContain('media-manifest.json');
    expect(names).toContain('media/1_post_0.png');
    expect(names).toContain('media/1_quote_0.jpg');
    expect(names.some((n) => n.includes('card_img'))).toBe(false);

    const entries = manifest.entries;
    const ok = entries.find((e) => e.url === 'https://pbs.twimg.com/media/IMG1?name=large');
    expect(ok.local_path).toBe('media/1_post_0.png');
    expect(ok.bytes).toBe(4);
    const bad = entries.find((e) => e.url === 'https://pbs.twimg.com/card_img/1');
    expect(bad.error).toBe('HTTP 404');
    expect(bad.local_path).toBeNull();

    const html = new TextDecoder().decode(unzipped['index.html']);
    expect(html).toContain('media/1_post_0.png');

    expect(mediaMap['https://pbs.twimg.com/media/IMG1?name=large']).toBe('media/1_post_0.png');
  });
});
