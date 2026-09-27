# X Archive

A local-only **Manifest V3 Chrome extension** that archives X (Twitter) timelines to durable
on-device storage and exports them as clean JSON and self-contained HTML reports, with an
optional media ZIP and a user-controlled incremental archive-fulfillment phase for threads and quoted posts.

X Archive is a **DOM-based JavaScript extension**: it reads the visible rendered page of your
own logged-in X session. It contains **no Python**, uses **no copied cookies, tokens, or
credentials**, calls **no private GraphQL/internal APIs**, and talks to **no external service**.
Everything it captures is stored locally in the extension's own IndexedDB until you export
or delete it.

---

## Features

- **One archiver for every timeline** — profiles (Posts, Replies, Media, Likes, Highlights),
  Bookmarks and bookmark folders, Lists, Search results, Home and other generic timelines.
  Automatic source detection; no mode selector.
- **Durable capture** — every batch of posts is written to extension IndexedDB *before* the
  page scrolls again. Runs survive popup closure, service-worker suspension, and tab reloads.
- **Full state machine** — `idle → running → resting → paused → stopping → completed /
  limited / error`, driven from the toolbar popup, the in-page panel, or the options page.
- **Human pacing** — center-weighted jittered delays and scroll distances, occasional
  reading pauses, rare backtracks and micro-scrolls, scheduled rests with jittered
  thresholds, stall detection with recovery nudges, and reliable bottom-of-timeline
  detection (page must be visible, online, and unchanged before "completed" is declared).
- **Configurable limits** — max active duration, max posts, oldest date, idle timeout.
- **Polished exports** — archive-envelope JSON and a
  self-contained, searchable/filterable HTML report; tokenized filenames.
- **Optional media ZIP** — explicit opt-in; downloads post/quote/card/avatar images with a
  manifest that records every file or failure, plus an offline HTML report.
- **Build upon an archive** — a separate, user-triggered phase that serially visits selected
  thread and quoted-post links in one reused worker window, saving enrichments locally as they arrive.
- **Flexible import** — accepts archive envelopes and raw post arrays, normalizing and
  deduplicating them with the same merge rules used during capture.
- **Privacy by construction** — no telemetry, no servers, no remote code, minimal
  permissions (see below).

---

## Installation

The extension runs straight from the repo — **no build step and no `node_modules` are
needed to use it**. Everything it loads (including the ZIP library, vendored in
`src/vendor`) is already in the tree.

1. Clone the repository, or download the repo as a ZIP and **extract it** — a ZIP is just
   a transport artifact, Chrome cannot install it directly.
2. Open `chrome://extensions`, enable **Developer mode**.
3. Click **Load unpacked** and select the extracted repository folder
   (the one containing `manifest.json`).
4. Pin "X Archive" to the toolbar.

`npm install` is only for development (tests, lint, icon regeneration) — see
[Development](#development). Load unpacked remains the supported local install path;
one-click distribution for other users would require publishing to the Chrome Web Store.
No CRX files or release binaries are provided.

To update: pull/copy the new files and press the reload (⟳) button on the extension card.
Your archives are preserved — they live in extension IndexedDB, not in the repo.

---

## First-run workflow

Open the page you want to archive while logged in to X:

| Source | URL pattern |
|---|---|
| Bookmarks / folders | `x.com/i/bookmarks[/<folder>]` |
| Profile posts | `x.com/<handle>` |
| Profile tabs | `x.com/<handle>/with_replies · /media · /likes · /highlights` |
| List | `x.com/i/lists/<id>` |
| Search | `x.com/search?q=…` |
| Home / Explore / other tweet timelines | `x.com/home`, `x.com/explore`, … |
| Status page | visited by the **fulfillment worker**, never a primary source |

Pages that cannot be archived (DMs, settings, compose, login, followers lists, status
pages, other `/i/*` sections) are rejected in the popup with an explicit reason.

Then:

1. Click the toolbar icon. The popup shows the detected source (type, handle/tab, source key)
   plus a quick-settings section for the preset, limits, export formats, snapshots, filename
   template, and media ZIP toggle — the full field set lives on the options page.
2. Press **Start**. An optional in-page panel appears (bottom-right) mirroring state, count,
   elapsed time, and rest countdown.
3. The scraper expands "Show more" text, extracts the viewport, persists the batch to
   IndexedDB, scrolls a jittered distance, and repeats — resting every N new posts.
4. **Pause** freezes the run (flushes pending posts, stops active-time accounting).
   **Resume** continues. **Stop** does a final extract/flush and marks the run
   `completed` with stop reason `manual`.
5. Reaching a limit, a verified bottom, or the oldest configured date finishes the run
   automatically (state `limited` or `completed`, with a precise `stopReason`), then —
   if enabled — the final export downloads automatically.

### Pause / resume / stop / recovery behavior

- Closing the popup never stops a run — the loop lives in the page, not the popup.
- If you **reload the source tab**, the content script re-detects the source and offers the
  unfinished run back to the service worker; with *Auto-resume* on (default) it continues
  without losing persisted posts.
- If the SPA route changes so the source key no longer matches (e.g. you navigate from a
  profile to Home), the run **pauses with `source_changed`** rather than mixing sources.
  Returning to the original route allows a resume.
- Manual pauses do not consume the *max active duration*; scheduled rests do.

### Background / hidden-tab operation

Content scripts are subject to Chrome's hidden-page throttling. When the scraping tab is
hidden, covered, or its window is minimized, timers may be checked only about once per
second and can degrade to roughly once per minute under intensive throttling — and X may
suspend rendering new content entirely while the page is not visible.

**Reliable recommendation:** drag the scraping tab into its own non-minimized window, keep
that tab selected and at least partially visible on screen, then do other work in a
different browser window. Capture in minimized, covered, or hidden tabs is **not
guaranteed**.

By default the scraper simply waits while the tab is hidden (the stall timer stays frozen)
and resumes when it becomes visible again. A **best-effort** setting,
`continueWhenHidden` (off by default), keeps extracting, persisting, and scrolling while
hidden. Even with it on, stall detection never runs while hidden — throttled rendering can
never be mistaken for the bottom of the timeline — but progress may be slow or incomplete.

---



## Settings

Settings are global, stored in `chrome.storage.local` (restricted to trusted extension
contexts), snapshotted into each run at start time, and editable on the Settings tab of the
options page. Every field shows inline descriptions and validation.

### Presets

| Preset | tick delay | scroll | rest every | rest length | stall timeout | recovery |
|---|---|---|---|---|---|---|
| Gentle | 2.5–7.5 s | 240–760 px | ~45 (±35%) | 30–90 s | 150 s | 2 |
| **Balanced (default)** | 1.4–5.2 s | 320–980 px | ~65 (±30%) | 18–55 s | 120 s | 2 |
| Brisk | 1.05–3.4 s | 480–1100 px | ~85 (±25%) | 15–40 s | 105 s | 2 |
| Fast (use with care) | 0.8–2.4 s | 650–1250 px | ~110 (±20%) | 12–30 s | 90 s | 1 |
| Turbo (use with care) | 0.4–1.2 s | 900–1800 px | ~160 (±15%) | 8–20 s | 60 s | 1 |
| Custom | your values | | | | | |

Presets also tune the reading-pause and backtrack chances (see below).

Editing any preset-managed field switches the preset to *Custom*. *Fast* and *Turbo* carry
warnings because aggressive pacing risks rate limits and missed posts.

### Timing fields (defaults are Balanced)

| Field | Default | Range | Meaning |
|---|---|---|---|
| `tickDelayMinMs`/`MaxMs` | 1400/5200 | 250–120000 | pause between scrape cycles |
| `scrollMinPx`/`MaxPx` | 320/980 | 50–5000 | scroll step per tick |
| `restEveryPosts` | 65 | 5–5000 | average/center of the rest schedule — a break after roughly N new posts |
| `restCountJitterPercent` | 30 | 0–75 | how far the actual rest threshold jitters around `restEveryPosts` (0 = exactly periodic) |
| `restMinMs`/`MaxMs` | 18000/55000 | 1000–600000 | scheduled break length |
| `readingPauseChancePercent` | 8 | 0–50 | chance a tick adds an extra pause, as if you stopped to read |
| `readingPauseMinMs`/`MaxMs` | 7000/24000 | 1000–120000 | length of an occasional extra reading pause |
| `backtrackChancePercent` | 4 | 0–25 | rare chance a downward scroll instead nudges back up a little |
| `smoothScroll` | on | — | native smooth scrolling while visible (instant while hidden) |
| `stallTimeoutMs` | 120000 | 10000–600000 | idle budget while visible before finishing |
| `stallRecoveryAttempts` | 2 | 0–10 | scroll nudges before declaring the bottom |
| `randomize` | on | — | center-weighted sampling inside all ranges (off = fixed midpoints) |

With `randomize` on, every sampled value uses a center-weighted distribution (average of
three uniform draws), so values cluster near the middle of each range. Reading pauses are
added on top of the normal tick delay. A fixed ~12% of randomized downward scrolls are
additionally scaled down to a 35–70% micro-scroll, and a rare backtrack (per
`backtrackChancePercent`) scrolls up by 12–32% of the proposed step — both are internal,
non-configurable humanization. None of this is meant to evade detection; it exists to
make pacing non-periodic and to help X keep rendering reliably.

### Limits (all default to "no limit")

| Field | Meaning |
|---|---|
| `maxActiveDurationMs` | stop after N minutes of active time (UI enters minutes) |
| `maxPosts` | stop after N unique posts |
| `oldestDate` | stop when a post older than this date is captured |

### Behavior

`autoScroll` (on), `autoExpandText` (on), `autoResume` (on — resume a run after reloading the
same source), `smoothScroll` (on — smooth native scrolling while visible; instant while
hidden), `continueWhenHidden` (off — keep scraping a hidden tab on a best-effort basis;
Chrome throttles hidden timers and X may stop rendering, so it can be slow or incomplete),
`showOverlay` (on — in-page progress panel), `showBadge` (on — toolbar badge:
post count while running, color-coded state: blue running, amber resting, violet paused,
green done, red error).

### Save & export

- **Internal checkpoints are always on** — every batch persists before scrolling; this is
  not user-disableable.
- `autoExportOnComplete` (on) — download final exports when a run finishes or is stopped.
- `exportFormats` — JSON and/or HTML (both on by default).
- `snapshotEveryPosts` (off) — optional *downloaded* snapshots mid-run every N posts.
  This is a convenience copy, not the reliability mechanism (the DB is).
- `saveAs` (off) — show a save dialog per download.
- `filenameTemplate` — tokenized, with a live preview.

### Filename tokens

`%type` (profile/bookmarks/list/search/timeline), `%source` (source key), `%handle`
(without `@`), `%title` (source label), `%tab`, `%date` (YYYY-MM-DD), `%time` (HHMMSS),
`%datetime`, `%num` (post count), `%run` (run id), `%ext`.

Default template: `x_%type_%handle_%date_%num` → `x_profile_alice_2025-01-31_142.json`.

Filenames are sanitized: Windows-illegal characters removed, reserved device names escaped,
traversal stripped, whitespace collapsed, missing tokens get deterministic fallbacks.

### Media

`autoMediaZip` (off) downloads a media ZIP after the final export. Turning it on in
settings asks for `pbs.twimg.com` access at save time; if denied it stays off.
Content toggles:
post photos (on), quoted photos (on), link-card images (off), avatars (off).
Videos are kept as references/posters — temporary `blob:` URLs are never presented as
archived files. A manual **Media ZIP** button exists per archive regardless of the toggle.

---

## Archives page

The options page **Archives** tab lists every run with search/filter by text, type and
state. Per-archive detail shows source key/URL, state and stop reason, post count,
timestamps, warnings, and a settings snapshot. Actions include **Export JSON / HTML / both**,
**Media ZIP**, **Open source to resume** (unfinished runs), **Delete** (confirmed),
**Import JSON**, and **Build upon this archive**. The build card summarizes thread and quote
candidates, unavailable quote URLs, completed work, remaining work and failures. It also
provides a latest-version JSON + HTML download.

Storage usage is displayed; uninstalling the extension deletes all local archives.

## JSON schema & import

Default export is an **archive envelope**:

```json
{
  "schemaVersion": 1,
  "archive": {
    "id": "run_…",
    "source": { "key": "profile:alice:posts", "type": "profile", "label": "@alice posts",
                "handle": "alice", "tab": "posts", "sourceUrl": "https://x.com/alice" },
    "state": "completed",
    "createdAt": "…", "updatedAt": "…", "completedAt": "…",
    "stopReason": "completed",
    "settings": { },
    "stats": { "posts": 142, "seq": 142, "batches": 21 },
    "fulfillment": null,
    "threadSummary": null,
    "warnings": []
  },
  "posts": [ ]
}
```

Each post contains core fields (`tweet_url`, `name`, `handle`, `timestamp_iso`,
`text`, `images`, `videos`, `quote_context`, `link_card`, `metrics`) plus stable metadata:
`schema_version`, `id` (status id), `links` (ordered `{display, href}`), `media`
(`{url, type, alt, poster, permalink}`), `capture_context` (`timeline | thread | import`),
`source_key`, `captured_at`/`updated_at`, thread fields (`is_thread`, `thread_role`,
`thread_id`, `is_self_reply`, `show_thread_link`, `thread_candidates`, `thread_scraped`),
and `warnings`. Unavailable metrics are `null`, not `0`. Quote contexts retain their
captured `quoted_*` fields; a fulfilled quote adds `quoted_fetched: true` and
`quoted_fetched_at` after the exact quoted post is identified. The fetched quote is merged
into each referring parent post's `quote_context`, not added as a top-level archive post.
Archive metadata includes the persisted `fulfillment` session and `threadSummary` when present;
`schemaVersion` remains 1.

**Import** accepts both archive envelopes and raw post arrays.
Imports create a new run (`stopReason: imported`), inferring the profile source when one
author dominates; unknown fields are preserved and normalizations are reported as warnings.
Dedup uses the same richness merge as live scraping.

## HTML report

Fully self-contained — inline CSS and JS, no remote libraries or trackers, safe to keep
offline. Light/dark (`prefers-color-scheme`), printable, archive metadata header with
completeness/stop warnings and totals. Client-side search, media/reply/quote filters, and
chronological sorting. Untrusted content is escaped everywhere; text URLs are linkified.
Image `src`s default to the remote pbs.twimg.com URLs; in a media ZIP they are rewritten
to bundled `media/` files with remote fallback on error.

## Media ZIP contents

```
x_<source>_<count>.zip
├─ archive.json            # the same JSON envelope
├─ index.html              # offline report w/ media/ paths + remote fallback
├─ media/
│  └─ <tweet-id>_<kind>_<index>.<ext>   # kinds: post, quote, card, avatar
└─ media-manifest.json     # url, local path, byte count, per-file error
```

Fetches run with bounded concurrency and one retry. A failed image is recorded in
`media-manifest.json` and does not fail the archive; the offline HTML keeps the remote
URL for anything not downloaded. Extension is inferred from `Content-Type`, then URL.

---

## Build upon this archive

Archive fulfillment is a separate, explicitly started phase. The primary archive must be
paused or finished first. In the archive detail's **Build upon this archive** card, choose
Threads, Quoted posts, or both (both are checked by default), a per-session limit from 1 to
100 (default 10), and Cautious, Balanced, or Brisk pacing (Cautious by default).

Thread candidates come from recorded `thread_candidates` and the `is_thread` / `thread_id`
relationship. Quote candidates come from every captured
`quote_context.quoted_tweet_url` with a recoverable status ID; identical quoted status IDs
are deduplicated, and all referring parent posts are retained. Quote contexts without a usable
status URL are counted and shown, but are not visited. Existing/imported thread posts marked
`thread_scraped` and quote contexts marked `quoted_fetched` or legacy
`quoted_text_backfilled` are recognized as completed, so they are not redundantly fetched.

Starting a session opens at most **one dedicated worker window/tab** and navigates it serially
through the selected links; it never opens one tab per candidate and never navigates the
primary source tab. The order is deterministic by archive capture order and then candidate
kind. The selected job IDs belong to that session only. A later user-started session skips
completed/skipped jobs and retries pending, failed, incomplete, paused, or stale work. Only
one fulfillment session can run extension-wide at once.

Every page result is saved to the local IndexedDB archive immediately. Thread results enrich
posts with `capture_context: "thread"` while preserving richer existing values. Quote
fulfillment verifies the requested post's ID and supplied author, timestamp, and meaningful
text prefix; the exact fetched quote is merged into each referring parent's `quote_context`
(including media and `quoted_fetched` / `quoted_fetched_at`) and is not inserted as a new
archive post. Numbered thread counters that indicate missing posts remain marked incomplete.
Job state, attempts, result counts, and diagnostics are persisted and shown in the card.

Use **Pause after current page** to let the current page finish and save its result, then
stop before the next link. Primary capture cannot resume while fulfillment is active or while
its paused current page is still settling. If X shows a login, rate-limit, or error surface, the worker pauses
automatically and records the reason rather
than continuing to request more links. This pacing lowers request pressure but cannot
prevent rate limits. The persisted session can resume after service-worker restarts; a user
closed worker tab pauses the session instead of silently opening a replacement. When a session
finishes, its worker tab returns to the archive page. Export buttons, including **Download
updated JSON + HTML**, always read the latest locally saved archive.

X can defer or hide replies, DOM structures can change, and protected or deleted posts may
be unreachable. Failed or incomplete candidates carry diagnostics (for example timeout,
missing status ID, metadata mismatch, or blocked surface); review them before retrying.

---

## Permissions & privacy

| Permission | Why |
|---|---|
| `storage` | settings and UI preferences in `chrome.storage.local` (locked to trusted extension contexts) |
| `unlimitedStorage` | large archives exceed normal IndexedDB quotas and must not be evicted |
| `downloads` | named JSON/HTML/ZIP downloads |
| `offscreen` | create Blob URLs and run long exports outside the short-lived service worker |
| `alarms` | persist one-time fulfillment dispatch and watchdog scheduling across worker suspension |
| `x.com`, `twitter.com` (host) | content scripts that read the visible DOM |
| `pbs.twimg.com` (**optional**) | only requested, via a user gesture, when you enable auto media ZIP or download media |

There is **no** all-sites access, history, cookies, debugger, or web-request interception.
No telemetry, analytics, servers, or remote code — the extension is fully inspectable and
loads unpacked. All data stays in extension-origin storage until you export or delete it.
Uninstalling the extension removes everything it stored.

---

## Known X/Chrome constraints

- **Active tab**: Chrome throttles hidden tabs heavily; keep the scraping tab visible (or in
  its own window) for reliable capture — see *Background / hidden-tab operation*. Stall
  time only accrues while visible.
- **X DOM changes**: selectors (`data-testid`s) drift — fixtures + tests make updating easy.
- **Protected/deleted posts and deferred replies** may be unreachable; thread diagnostics
  record rather than hide this.
- **Media/video**: only durable HTTP image URLs are fetched; `blob:` video sources are
  temporary and are kept as references/posters, never claimed as archived files.
- **Status pages**: the focused root may render the thread root's text even when the URL is
  a reply — the worker verifies the requested id before reporting success.

## Troubleshooting

- *"Content script unreachable"* on Start — reload the X tab once so the content script is
  injected, then start again.
- *Run paused `source_changed`* — you navigated; go back to the source URL and Resume.
- *No new posts / stall warnings* — the tab was hidden or X showed an error surface;
  keep it visible and online. With `continueWhenHidden` on, throttled capture is best
  effort only and may be slow or incomplete.
- *Media ZIP disabled* — the first download asks for `pbs.twimg.com` access; granting it is
  required to fetch images.
- *Export produced fewer posts* — check the run's `stopReason` and warnings; `limited` and
  `error` states mean capture is incomplete.
- *Fulfillment paused or failed* — open the Build upon job details and inspect its persisted
  diagnostic (for example blocked surface, timeout, missing status ID, or quote metadata mismatch).
  After addressing login/rate-limit/error conditions, start another bounded session to retry eligible jobs.

## Development

JavaScript only; no build step. Dev dependencies (`npm install`) are for tests/lint/icons:

```bash
npm test          # Vitest unit + DOM-fixture tests (happy-dom, fake-indexeddb)
npm run lint      # ESLint
npm run check     # static gate: manifest refs, no Python, no remote code
npm run icons     # regenerate PNG icons from assets/icons/icon.svg (sharp)
```

### Project structure

```
manifest.json            MV3 manifest (the load-unpacked root)
assets/icons/            original SVG + PNG icons
src/
  shared/                util, messages, defaults, settings, post-model,
                         filename, export-json, export-html, media-zip
  content/               namespace, source-detector, extractor, scraper-controller,
                         thread-controller, overlay(.css)
  background/            service-worker, database, run-service, export-service,
                         thread-service
  offscreen/             Blob/export worker (reads IndexedDB, builds downloads)
  popup/                 toolbar popup
  options/               settings + archive manager
  vendor/fflate.min.js   vendored ZIP library (MIT — see LICENSES/)
tests/                   Vitest suites + sanitized DOM fixtures
scripts/                 check.mjs (static gate), make-icons.mjs
```

Shared/content files attach to a single `globalThis.XArchive` namespace so the same files
run as classic content scripts, module imports in the service worker/extension pages, and
Vitest modules.

### Updating DOM fixtures/selectors

Extraction selectors live in `src/content/extractor.js`; route logic in
`src/content/source-detector.js`. When X changes its DOM: update the sanitized fixtures in
`tests/fixtures/*.html` to match the new markup, watch which assertions fail, adjust the
selectors, and re-run `npm test`.

### Manual Chrome checklist

Automated tests cover pure logic and DOM fixtures; the following remain manual in a real
browser: load unpacked with no manifest errors (including the `alarms` permission); detect each
source type; Start → Rest → Pause → Resume → Stop across popup/badge/overlay; close popup
mid-run; reload recovery and route-change pause; each limit/stop reason; JSON/HTML export
filenames; HTML search/filter/sort; raw-array and envelope import round-trip; media permission
grant + ZIP + offline links + a failed image; Build upon threads, quotes, mixed scope, max and
pacing controls; verify only one worker tab is reused serially; pause/cancel, blocked-surface
auto-pause, service-worker restart recovery, and updated JSON/HTML downloads; overlay default
on, media auto-ZIP default off.
