import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { indexedDB } from 'fake-indexeddb';
import { XA } from './helpers/load.js';
import '../src/background/thread-service.js';

const quote = (id, child = null) => ({
  quoted_tweet_url: 'https://x.com/author/status/' + id,
  quoted_author_name: 'Author ' + id, quoted_author_handle: '@author' + id,
  quoted_text: 'Quote ' + id,
  quoted_images: ['https://pbs.twimg.com/media/QUOTE' + id + '?name=large'],
  ...(child ? { quote_context: child } : {})
});
const post = (q) => XA.postModel.normalizePost({ tweet_url: 'https://x.com/main/status/1', quote_context: q });
const quoteDom = (id, child = '') => `<div role="link">
  <div data-testid="User-Name"><a href="/author${id}">Author ${id}</a><span>@author${id}</span></div>
  <div data-testid="tweetText">Quote ${id}</div>${child}
  <a href="/author${id}/status/${id}"><time datetime="2026-01-01T00:00:00Z">January ${id}</time></a>
  <div data-testid="tweetPhoto"><img src="https://pbs.twimg.com/media/QUOTE${id}?name=small"></div>
</div>`;

afterEach(() => { document.body.innerHTML = ''; });

describe('two visible quote levels', () => {
  it('keeps each author, timestamp, URL, text and image with its owner', () => {
    document.body.innerHTML = `<article data-testid="tweet">
      <div data-testid="User-Name"><a href="/main">Main</a></div>
      <a href="/main/status/1"><time datetime="2026-01-03T00:00:00Z">January 3</time></a>
      <div data-testid="tweetText">Main text</div>${quoteDom('2', quoteDom('3'))}
    </article>`;
    const original = document.body.innerHTML;
    const p = XA.extractor.extractVisible(document, { autoExpandText: false }).posts[0];
    expect(p.text).toBe('Main text');
    expect(p.images).toEqual([]);
    const chain = XA.postModel.quoteChain(p.quote_context);
    expect(chain).toHaveLength(2);
    for (const [i, q] of chain.entries()) {
      const id = String(i + 2);
      expect(q.quoted_tweet_url).toBe('https://x.com/author' + id + '/status/' + id);
      expect(q.quoted_author_handle).toBe('@author' + id);
      expect(q.quoted_date_displayed).toBe('January ' + id);
      expect(q.quoted_text).toBe('Quote ' + id);
      expect(q.quoted_images).toEqual(['https://pbs.twimg.com/media/QUOTE' + id + '?name=large']);
    }
    expect(document.body.innerHTML).toBe(original);
  });

  it('does not borrow a missing outer quote field from a nested quote', () => {
    document.body.innerHTML = quoteDom('2', quoteDom('3'));
    const root = document.body.firstElementChild;
    root.querySelector('[data-testid="tweetText"]').remove();
    Array.from(root.children).find(node => node.tagName === 'A').remove();
    const q = XA.extractor.extractQuote(root);
    expect(q.quoted_text).toBe('');
    expect(q.quoted_tweet_url).toBeNull();
    expect(q.quote_context.quoted_tweet_url).toContain('/status/3');
  });

  it('merges a longer nested quote without losing its other fields or mutating the original', () => {
    const old = post(quote('2', quote('3')));
    const next = post({ quoted_tweet_url: old.quote_context.quoted_tweet_url,
      quote_context: { quoted_text: 'Quote 3 with the whole text', quoted_images: ['https://img.example/new.jpg'] } });
    const merged = XA.postModel.mergePosts(old, next);
    expect(merged.quote_context.quote_context.quoted_text).toBe('Quote 3 with the whole text');
    expect(merged.quote_context.quote_context.quoted_images).toHaveLength(2);
    expect(old.quote_context.quote_context.quoted_text).toBe('Quote 3');
  });

  it('keeps quote-only video links out of the main post and retains shared images in both owners', () => {
    document.body.innerHTML = `<article data-testid="tweet">
      <div data-testid="User-Name"><a href="/main">Main</a></div>
      <a href="/main/status/1"><time datetime="2026-01-03T00:00:00Z">January 3</time></a>
      <div data-testid="tweetPhoto"><img src="https://pbs.twimg.com/media/QUOTE2?name=small"></div>
      ${quoteDom('2', quoteDom('3'))}</article>`;
    const boxes = document.querySelectorAll('div[role="link"]');
    boxes[0].insertAdjacentHTML('afterbegin', '<a href="/author2/status/2/video/1">Video</a>');
    boxes[1].insertAdjacentHTML('afterbegin', '<video src="blob:https://x.com/inner"></video><a href="/author3/status/3/video/1">Video</a>');
    const p = XA.extractor.extractVisible(document, { autoExpandText: false }).posts[0];
    expect(p.videos).toEqual([]);
    expect(p.images).toEqual(['https://pbs.twimg.com/media/QUOTE2?name=large']);
    expect(p.quote_context.quoted_images).toEqual(p.images);
    expect(p.quote_context.quoted_videos).toEqual(['https://x.com/author2/status/2/video/1']);
    expect(p.quote_context.quote_context.quoted_videos).toEqual(['https://x.com/author3/status/3/video/1']);
  });

  it('renders, searches and collects offline media from both levels with escaped content', () => {
    const p = post(quote('2', quote('3')));
    p.quote_context.quote_context.quoted_text = '<script>nested only</script>';
    const html = XA.exportHtml.renderHtmlReport({}, [p]);
    const template = document.createElement('template');
    template.innerHTML = html;
    const parsed = template.content;
    expect(parsed.querySelectorAll('.xa-quote')).toHaveLength(2);
    expect(parsed.querySelector('.xa-card').dataset.search).toContain('nested only');
    expect(html).not.toContain('<script>nested only</script>');
    expect(XA.mediaZip.collectMediaTargets([p], {}).map(t => t.url)).toEqual([
      ...p.quote_context.quoted_images, ...p.quote_context.quote_context.quoted_images
    ]);
    expect(XA.mediaZip.collectMediaTargets([p], { quotedImages: false })).toEqual([]);
    expect(JSON.parse(XA.exportJson.serializeJson({}, [p])).posts[0].quote_context.quote_context.quoted_text)
      .toBe('<script>nested only</script>');
  });

  it('bounds traversal even for a cyclic quote reference', () => {
    const q = quote('2'); q.quote_context = q;
    expect(XA.postModel.quoteChain(q)).toHaveLength(1);
    expect(XA.exportHtml.renderHtmlReport({}, [post(q)]).length).toBeLessThan(40000);
  });
});

describe('nested quote expansion', () => {
  const service = XA.fulfillmentService;
  beforeEach(async () => {
    XA.db.resetForTests();
    await new Promise((resolve, reject) => {
      const request = indexedDB.deleteDatabase(XA.db.DB_NAME);
      request.onsuccess = resolve; request.onerror = () => reject(request.error);
    });
    await XA.db.createRun({ id: 'nested', source: {}, state: 'completed', stats: {} });
  });

  it('queues both quotes and enriches the nested reference without replacing its parent', async () => {
    await XA.db.upsertPosts('nested', [post(quote('2', quote('3')))]);
    const jobs = await service.buildJobs('nested');
    expect(jobs.map(j => j.statusId)).toEqual(['2', '3']);
    const result = await service.persistQuoteResult('nested', jobs[1], {
      posts: [XA.postModel.normalizePost({ tweet_url: 'https://x.com/author/status/3', text: 'Quote 3 completed from its page' })]
    }, { sawRequestedId: true });
    expect(result.state).toBe('done');
    const [stored] = await XA.db.getPosts('nested');
    expect(stored.quote_context.quoted_text).toBe('Quote 2');
    expect(stored.quote_context.quote_context.quoted_text).toBe('Quote 3 completed from its page');
    expect(stored.quote_context.quote_context.quoted_fetched).toBe(true);
  });

  it('discovers a missing nested URL by visiting its immediate parent', async () => {
    const q = quote('2', { quoted_tweet_url: null, quoted_text: 'Quote 3' });
    await XA.db.upsertPosts('nested', [post(q)]);
    const jobs = await service.buildJobs('nested');
    const job = jobs.find(j => j.mode === 'quote_discovery');
    expect(job.url).toBe('https://x.com/author/status/2');
    const result = await service.persistQuoteDiscoveryResult('nested', job, {
      posts: [XA.postModel.normalizePost({ tweet_url: job.url, quote_context: quote('3') })]
    }, { sawRequestedId: true });
    expect(result.state).toBe('done');
    const [stored] = await XA.db.getPosts('nested');
    expect(stored.quote_context.quoted_tweet_url).toContain('/status/2');
    expect(stored.quote_context.quote_context.quoted_tweet_url).toContain('/status/3');
  });
});
