(function () {
  'use strict';
  const XA = (globalThis.XArchive = globalThis.XArchive || {});
  const esc = (v) => XA.util.escapeHtml(v);

  function safeUrl(url) {
    if (!url) return null;
    const s = String(url);
    if (/^(https?:|blob:|data:image\/)/i.test(s)) return s;
    if (s.startsWith('media/')) return s;
    return null;
  }

  function linkifyText(text) {
    const raw = String(text || '');
    const out = [];
    const re = /(https?:\/\/[^\s<>"']+)/g;
    let last = 0;
    let m;
    while ((m = re.exec(raw)) !== null) {
      if (m.index > last) out.push(esc(raw.slice(last, m.index)));
      const url = m[1].replace(/[.,;:!?)]+$/, '');
      const tail = m[1].slice(url.length);
      out.push('<a href="' + esc(url) + '" target="_blank" rel="noopener noreferrer">' + esc(url) + '</a>' + esc(tail));
      last = m.index + m[1].length;
    }
    out.push(esc(raw.slice(last)));
    return out.join('');
  }

  function mediaUrl(url, mediaMap, offline) {
    if (!url) return null;
    if (offline && mediaMap && mediaMap[url]) return mediaMap[url];
    return url;
  }

  function imgTag(url, alt, mediaMap, offline) {
    const local = mediaUrl(url, mediaMap, offline);
    if (!local) return '';
    const remote = (offline && local !== url) ? ' data-remote="' + esc(url) + '"' : '';
    return '<a href="' + esc(url) + '" target="_blank" rel="noopener noreferrer">' +
      '<img src="' + esc(local) + '" alt="' + esc(alt || '') + '" loading="lazy"' + remote + '></a>';
  }

  function renderMedia(post, mediaMap, offline) {
    const imgs = post.images || [];
    const mediaImgs = (post.media || []).filter((m) => m.type === 'image' && m.url);
    const seen = new Set(imgs);
    const extra = mediaImgs.filter((m) => !seen.has(m.url));
    let html = '';
    if (imgs.length || extra.length) {
      html += '<div class="xa-media">';
      for (const u of imgs) html += imgTag(u, '', mediaMap, offline);
      for (const m of extra) html += imgTag(m.url, m.alt, mediaMap, offline);
      html += '</div>';
    }
    const vids = (post.media || []).filter((m) => m.type === 'video');
    const plainVidUrls = post.videos || [];
    if (vids.length || plainVidUrls.length) {
      html += '<div class="xa-videos"><strong>Video:</strong> ';
      let n = 0;
      for (const v of vids) {
        n++;
        const link = safeUrl(v.permalink || v.url);
        const isBlob = /^blob:/i.test(String(v.url || ''));
        if (v.poster && /^https?:/i.test(v.poster)) {
          html += imgTag(v.poster, 'video poster', mediaMap, offline) + ' ';
        }
        html += link
          ? '<a href="' + esc(link) + '" target="_blank" rel="noopener noreferrer">Clip ' + n + (isBlob ? ' (temporary blob reference)' : '') + '</a> '
          : '<span class="xa-muted">Clip ' + n + ' (no durable URL)</span> ';
      }
      for (const u of plainVidUrls) {
        n++;
        const isBlob = /^blob:/i.test(String(u));
        html += '<a href="' + esc(u) + '" target="_blank" rel="noopener noreferrer">Clip ' + n +
          (isBlob ? ' (temporary blob reference)' : '') + '</a> ';
      }
      html += '</div>';
    }
    return html;
  }

  function renderQuote(q, mediaMap, offline) {
    if (!q) return '';
    const link = safeUrl(q.quoted_tweet_url)
      ? '<a class="xa-qtime" href="' + esc(q.quoted_tweet_url) + '" target="_blank" rel="noopener noreferrer">' +
        esc(q.quoted_date_displayed || 'Quoted post') + '</a>' : '';
    const avatar = q.quoted_avatar_url ? imgTag(q.quoted_avatar_url, '', mediaMap, offline) : '';
    let inner = '<div class="xa-quote"><div class="xa-quote-author">' + avatar +
      esc(q.quoted_author_name || 'Quoted user') +
      (q.quoted_author_handle ? ' <span class="xa-handle">' + esc(q.quoted_author_handle) + '</span>' : '') +
      '</div>' + link +
      '<div class="xa-quote-text">' + linkifyText(q.quoted_text || '') + '</div>';
    const qImgs = q.quoted_images || [];
    if (qImgs.length) {
      inner += '<div class="xa-media">' + qImgs.map((u) => imgTag(u, '', mediaMap, offline)).join('') + '</div>';
    }
    for (const v of (q.quoted_videos || [])) {
      const link2 = safeUrl(v);
      if (link2) inner += '<div class="xa-videos"><a href="' + esc(link2) + '" target="_blank" rel="noopener noreferrer">Quoted video</a></div>';
    }
    inner += '</div>';
    return inner;
  }

  function renderCard(post, mediaMap, offline) {
    const replyTargets = (post.replying_to || []).map((r) => {
      const url = safeUrl(r.profile_url);
      const h = esc(r.handle);
      return url ? '<a href="' + esc(url) + '" target="_blank" rel="noopener noreferrer">' + h + '</a>' : h;
    }).join(', ');
    const banners = [];
    if (post.social_context) banners.push('<span class="xa-banner">' + esc(post.social_context) + '</span>');
    if (post.is_reply && replyTargets) banners.push('<span class="xa-banner">Replying to ' + replyTargets + '</span>');
    if (post.is_thread) {
      const role = post.thread_role && post.thread_role !== 'standalone' ? post.thread_role : 'thread';
      const root = post.thread_id ? ' · <a href="' + esc(post.thread_id) + '" target="_blank" rel="noopener noreferrer">root</a>' : '';
      banners.push('<span class="xa-banner xa-banner-thread">Thread: ' + esc(role) + root + '</span>');
    }
    if (post.thread_scraped) banners.push('<span class="xa-banner xa-banner-ok">Thread expanded</span>');
    for (const w of (post.warnings || [])) {
      banners.push('<span class="xa-banner xa-banner-warn">' + esc(w) + '</span>');
    }

    const card = post.link_card;
    const cardHtml = card && (card.url || card.title)
      ? '<div class="xa-linkcard">' +
        (card.url ? '<a href="' + esc(safeUrl(card.url) || '#') + '" target="_blank" rel="noopener noreferrer">' +
          esc(card.title || card.url) + '</a>' : esc(card.title || '')) +
        (card.image ? imgTag(card.image, 'link card image', mediaMap, offline) : '') +
        '</div>' : '';

    const m = post.metrics || {};
    const metricParts = [];
    if (m.replies != null) metricParts.push('Replies ' + m.replies);
    if (m.reposts != null) metricParts.push('Reposts ' + m.reposts);
    if (m.likes != null) metricParts.push('Likes ' + m.likes);
    if (m.bookmarks != null) metricParts.push('Bookmarks ' + m.bookmarks);
    if (m.views != null) metricParts.push('Views ' + m.views);

    const avatar = post.avatar_url ? imgTag(post.avatar_url, 'avatar', mediaMap, offline) : '';
    const ts = post.date_displayed || post.timestamp_iso || '';
    const tsLink = post.tweet_url
      ? '<a class="xa-time" href="' + esc(post.tweet_url) + '" target="_blank" rel="noopener noreferrer">' + esc(ts) + '</a>'
      : '<span class="xa-time">' + esc(ts) + '</span>';
    const searchText = [post.text, post.name, post.handle,
      post.quote_context && post.quote_context.quoted_text,
      post.link_card && post.link_card.title].filter(Boolean).join(' ').toLowerCase();

    return '<article class="xa-card' + (post.is_thread ? ' xa-thread' : '') + '"' +
      ' data-search="' + esc(searchText) + '"' +
      ' data-author="' + esc((post.handle || '').toLowerCase()) + '"' +
      ' data-ts="' + esc(post.timestamp_iso || '') + '"' +
      ' data-media="' + ((post.images && post.images.length) || (post.media && post.media.length) || (post.videos && post.videos.length) ? '1' : '0') + '"' +
      ' data-reply="' + (post.is_reply ? '1' : '0') + '"' +
      ' data-quote="' + (post.quote_context ? '1' : '0') + '">' +
      '<div class="xa-author-row">' + avatar +
      '<div class="xa-author">' + esc(post.name || '') +
      (post.handle ? ' <span class="xa-handle">' + esc(post.handle) + '</span>' : '') + '</div></div>' +
      tsLink +
      (banners.length ? '<div class="xa-banners">' + banners.join(' ') + '</div>' : '') +
      '<div class="xa-text">' + linkifyText(post.text || '') + '</div>' +
      cardHtml +
      renderQuote(post.quote_context, mediaMap, offline) +
      renderMedia(post, mediaMap, offline) +
      (metricParts.length ? '<div class="xa-metrics">' + metricParts.map(esc).join(' · ') + '</div>' : '') +
      '</article>';
  }

  function pageWarnings(run, posts) {
    const out = [];
    if (run && run.state && run.state !== 'completed') {
      out.push('Archive state: ' + run.state + (run.stopReason ? ' (' + run.stopReason + ')' : '') + ' — capture may be incomplete.');
    } else if (run && run.stopReason && run.stopReason !== 'completed' && run.stopReason !== 'manual') {
      out.push('Stopped because: ' + run.stopReason + ' — capture may be incomplete.');
    }
    for (const w of (run && run.warnings) || []) out.push(w);
    const warned = (posts || []).filter((p) => (p.warnings || []).length).length;
    if (warned) out.push(warned + ' post(s) carry extraction warnings.');
    return out;
  }

  const CSS = `
:root{color-scheme:light dark}
*{box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;max-width:760px;margin:0 auto;padding:24px;background:#f7f9fa;color:#0f1419}
h1{font-size:22px;border-bottom:2px solid #e6ecf0;padding-bottom:12px}
.xa-meta{font-size:13px;color:#536471;margin-bottom:14px;line-height:1.7}
.xa-warnbox{background:#fff8e6;border:1px solid #f0d48a;color:#6b5600;border-radius:10px;padding:10px 14px;font-size:13px;margin-bottom:16px}
.xa-controls{position:sticky;top:0;background:inherit;padding:10px 0;display:flex;flex-wrap:wrap;gap:8px;align-items:center;border-bottom:1px solid #e6ecf0;margin-bottom:14px;z-index:5}
.xa-controls input[type=search]{flex:1;min-width:160px;padding:7px 10px;border:1px solid #cfd9de;border-radius:8px;font-size:14px;background:#fff;color:#0f1419}
.xa-controls label{font-size:13px;color:#536471;display:flex;gap:4px;align-items:center;cursor:pointer}
.xa-controls select{padding:6px;border:1px solid #cfd9de;border-radius:8px;background:#fff;color:#0f1419}
.xa-card{background:#fff;border:1px solid #e6ecf0;border-radius:14px;padding:16px 18px;margin-bottom:14px;overflow-wrap:anywhere}
.xa-card.xa-thread{border-left:4px solid #1d9bf0}
.xa-author-row{display:flex;align-items:center;gap:10px}
.xa-author-row img{width:40px;height:40px;border-radius:50%;object-fit:cover}
.xa-author{font-weight:700;font-size:15px}
.xa-handle{color:#536471;font-weight:400}
.xa-time{font-size:13px;color:#536471;text-decoration:none;display:inline-block;margin:4px 0 8px}
.xa-banners{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px}
.xa-banner{font-size:12.5px;color:#536471;background:#f0f3f4;padding:3px 9px;border-radius:6px}
.xa-banner a{color:inherit}
.xa-banner-thread{background:#1d9bf0;color:#fff}
.xa-banner-ok{background:#dcf5e3;color:#0f7a3d}
.xa-banner-warn{background:#fde8e8;color:#b3261e}
.xa-text{font-size:15.5px;line-height:1.55;white-space:pre-wrap;margin-bottom:10px}
.xa-text a,.xa-videos a,.xa-linkcard a{color:#1d9bf0;text-decoration:none}
.xa-quote{border:1px solid #cfd9de;border-radius:12px;padding:12px;margin:10px 0;background:#fafbfc}
.xa-quote-author{font-weight:700;font-size:14px;margin-bottom:4px;display:flex;align-items:center;gap:6px}
.xa-quote-author img{width:22px;height:22px;border-radius:50%;object-fit:cover}
.xa-qtime{font-size:12.5px;color:#536471;text-decoration:none;display:block;margin-bottom:6px}
.xa-quote-text{font-size:14px;line-height:1.45;white-space:pre-wrap}
.xa-linkcard{border:1px solid #cfd9de;border-radius:12px;padding:10px 12px;margin:10px 0;font-size:14px}
.xa-linkcard img{max-width:100%;border-radius:8px;margin-top:8px;display:block}
.xa-media{margin-top:10px;display:flex;flex-wrap:wrap;gap:8px}
.xa-media img{max-width:100%;max-height:340px;border-radius:10px;display:block}
.xa-quote .xa-media img{max-height:200px}
.xa-videos{margin-top:10px;font-size:13.5px}
.xa-videos img{max-width:220px;border-radius:8px;display:inline-block;vertical-align:middle}
.xa-muted{color:#8899a6}
.xa-metrics{font-size:13px;color:#536471;border-top:1px solid #e6ecf0;padding-top:10px;margin-top:10px}
.xa-hidden{display:none!important}
.xa-count{font-size:13px;color:#536471}
@media (prefers-color-scheme:dark){
body{background:#101418;color:#e7e9ea}
h1{border-color:#2f3336}
.xa-card{background:#16181c;border-color:#2f3336}
.xa-handle,.xa-time,.xa-metrics,.xa-muted{color:#8b98a5}
.xa-banner{background:#2f3336;color:#aab8c2}
.xa-quote{background:#1c1f23;border-color:#38444d}
.xa-linkcard{border-color:#38444d}
.xa-controls input[type=search],.xa-controls select{background:#16181c;color:#e7e9ea;border-color:#38444d}
.xa-controls label{color:#8b98a5}
.xa-warnbox{background:#332d1a;border-color:#6b5a2a;color:#e8d9a0}
}
@media print{
.xa-controls{display:none}
.xa-card{break-inside:avoid;border:1px solid #ccc}
body{background:#fff;color:#000}
}`;

  const CLIENT_JS = `
(function(){
var q=document.getElementById('xaq'),cards=Array.prototype.slice.call(document.querySelectorAll('.xa-card'));
var fm=document.getElementById('xafmedia'),fr=document.getElementById('xafreply'),fq=document.getElementById('xafquote');
var sort=document.getElementById('xafsort'),count=document.getElementById('xafcount');
function apply(){var needle=(q.value||'').toLowerCase();var shown=0;
cards.forEach(function(c){var ok=true;
if(needle&&c.getAttribute('data-search').indexOf(needle)<0)ok=false;
if(fm.checked&&c.getAttribute('data-media')!=='1')ok=false;
if(fr.checked&&c.getAttribute('data-reply')!=='1')ok=false;
if(fq.checked&&c.getAttribute('data-quote')!=='1')ok=false;
c.classList.toggle('xa-hidden',!ok);if(ok)shown++;});
count.textContent=shown+' of '+cards.length+' posts';}
function resort(){var mode=sort.value;var parent=cards[0]&&cards[0].parentNode;if(!parent)return;
cards.sort(function(a,b){var ta=a.getAttribute('data-ts')||'',tb=b.getAttribute('data-ts')||'';
if(mode==='oldest')return ta<tb?-1:ta>tb?1:0;
if(mode==='newest')return ta<tb?1:ta>tb?-1:0;return 0;});
if(mode==='captured'){location.reload();return;}
cards.forEach(function(c){parent.appendChild(c);});}
[q,fm,fr,fq].forEach(function(el){el&&el.addEventListener('input',apply);el&&el.addEventListener('change',apply);});
sort&&sort.addEventListener('change',resort);
document.addEventListener('error',function(e){var t=e.target;
if(t&&t.tagName==='IMG'&&t.getAttribute('data-remote')){t.src=t.getAttribute('data-remote');t.removeAttribute('data-remote');}},true);
apply();})();`;

  function renderHtmlReport(run, posts, opts) {
    const o = opts || {};
    const mediaMap = o.mediaMap || null;
    const offline = !!o.offline;
    const list = (posts || []).slice();
    const src = (run && run.source) || {};
    const title = o.title || ((src.label || src.type || 'X') + ' archive');
    const warnings = pageWarnings(run, list);
    const stats = (run && run.stats) || {};
    const meta = [];
    if (src.sourceUrl) meta.push('Source: ' + src.sourceUrl);
    if (run && run.createdAt) meta.push('Started: ' + run.createdAt);
    if (run && run.completedAt) meta.push('Completed: ' + run.completedAt);
    if (run && run.stopReason) meta.push('Stop reason: ' + run.stopReason);
    if (stats.posts != null) meta.push('Unique posts: ' + stats.posts);
    if (offline) meta.push('Offline copy — media bundled where downloaded.');

    let html = '<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n' +
      '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
      '<title>' + esc(title) + ' — X Archive</title>\n<style>' + CSS + '</style>\n</head>\n<body>\n' +
      '<h1>' + esc(title) + ' (' + list.length + ' posts)</h1>\n' +
      '<div class="xa-meta">' + meta.map(esc).join('<br>') + '</div>\n';
    if (warnings.length) {
      html += '<div class="xa-warnbox"><strong>Completeness notes</strong><br>' +
        warnings.map(esc).join('<br>') + '</div>\n';
    }
    html += '<div class="xa-controls">' +
      '<input type="search" id="xaq" placeholder="Search text, author, cards…" aria-label="Search posts">' +
      '<label><input type="checkbox" id="xafmedia"> media</label>' +
      '<label><input type="checkbox" id="xafreply"> replies</label>' +
      '<label><input type="checkbox" id="xafquote"> quotes</label>' +
      '<select id="xafsort" aria-label="Sort order">' +
      '<option value="captured">Captured order</option>' +
      '<option value="newest">Newest first</option>' +
      '<option value="oldest">Oldest first</option>' +
      '</select>' +
      '<span class="xa-count" id="xafcount"></span>' +
      '</div>\n<main>\n';
    for (const post of list) html += renderCard(post, mediaMap, offline) + '\n';
    html += '</main>\n<script>' + CLIENT_JS + '</scr' + 'ipt>\n</body>\n</html>';
    return html;
  }

  XA.exportHtml = { renderHtmlReport, linkifyText, pageWarnings };
})();
