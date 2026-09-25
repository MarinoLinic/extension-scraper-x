# X Archive

A local-only **Manifest V3 Chrome extension** that archives X (Twitter) timelines to durable
on-device storage and exports them as clean JSON and self-contained HTML reports, with an
optional media ZIP and an assisted, best-effort thread-expansion phase.

X Archive is a **DOM-based JavaScript extension**: it reads the visible rendered page of your
own logged-in X session. It contains **no Python**, uses **no copied cookies, tokens, or
credentials**, calls **no private GraphQL/internal APIs**, and talks to **no external service**.
Everything it captures is stored locally in the extension's own IndexedDB until you export
or delete it.

It unifies and replaces the older `bookmarks.js` and `profile.js` console scripts.

---

## Features

- **One archiver for every timeline** — profiles (Posts, Replies, Media, Likes, Highlights),
  Bookmarks and bookmark folders, Lists, Search results, Home and other generic timelines.
  Automatic source detection; no mode selector.
- **Durable capture** — every batch of posts is written to extension IndexedDB *before* the
  page scrolls again. Runs survive popup closure, service-worker suspension, and tab reloads.
- **Full state machine** — `idle → running → resting → paused → stopping → completed /
  limited / error`, driven from the toolbar popup, the in-page panel, or the options page.
- **Human pacing** — jittered delays and scroll distances, scheduled rests, stall detection
  with recovery nudges, and reliable bottom-of-timeline detection (page must be visible,
  online, and unchanged before "completed" is declared).
- **Configurable limits** — max active duration, max posts, oldest date, idle timeout.
- **Polished exports** — archive-envelope JSON (with optional legacy array mode) and a
  self-contained, searchable/filterable HTML report; tokenized filenames.
- **Optional media ZIP** — explicit opt-in; downloads post/quote/card/avatar images with a
  manifest that records every file or failure, plus an offline HTML report.
- **Assisted thread expansion** — a separate, reviewable, user-triggered phase that visits
  candidate threads in one dedicated worker window and merges the findings.
- **Legacy import** — imports both the old raw-array JSON exports and new envelopes,
  deduplicating with the same merge rules used while scraping.
- **Privacy by construction** — no telemetry, no servers, no remote code, minimal
  permissions (see below).

---

## Installation

1. Clone or download this repository — no build step is required.
2. Open `chrome://extensions`, enable **Developer mode**.
3. Click **Load unpacked** and select the repository folder
   (the one containing `manifest.json`).
4. Pin "X Archive" to the toolbar.

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
| Status page | only visited by the **thread worker**, never a primary source |

Pages that cannot be archived (DMs, settings, compose, login, followers lists, status
pages, other `/i/*` sections) are rejected in the popup with an explicit reason.

Then:

1. Click the toolbar icon. The popup shows the detected source (type, handle/tab, source key).
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

---

## Settings

Settings are global, stored in `chrome.storage.local` (restricted to trusted extension
contexts), snapshotted into each run at start time, and editable on the Settings tab of the
options page. Every field shows inline descriptions and validation.

### Presets

| Preset | tick delay | scroll | rest every | rest length | stall timeout | recovery |
|---|---|---|---|---|---|---|
| Gentle | 5–9 s | 400–800 px | 50 | 30–45 s | 120 s | 2 |
| **Balanced (default)** | 3–6 s | 650–1150 px | 80 | 20–28 s | 120 s | 2 |
| Fast (use with care) | 1.5–3 s | 900–1500 px | 150 | 12–18 s | 90 s | 1 |
| Custom | your values | | | | | |

Editing any preset-managed field switches the preset to *Custom*. *Fast* carries a warning
because aggressive pacing risks rate limits and missed posts.

### Timing fields (defaults are Balanced)

| Field | Default | Range | Meaning |
|---|---|---|---|
| `tickDelayMinMs`/`MaxMs` | 3000/6000 | 250–120000 | pause between scrape cycles |
| `scrollMinPx`/`MaxPx` | 650/1150 | 50–5000 | scroll step per tick |
| `restEveryPosts` | 80 | 5–5000 | take a break after N new posts |
| `restMinMs`/`MaxMs` | 20000/28000 | 1000–600000 | scheduled break length |
| `stallTimeoutMs` | 120000 | 10000–600000 | idle budget while visible before finishing |
| `stallRecoveryAttempts` | 2 | 0–10 | scroll nudges before declaring the bottom |
| `randomize` | on | — | jitter delays/distances (off = fixed midpoints) |

### Limits (all default to "no limit")

| Field | Meaning |
|---|---|
| `maxActiveDurationMs` | stop after N minutes of active time (UI enters minutes) |
| `maxPosts` | stop after N unique posts |
| `oldestDate` | stop when a post older than this date is captured |

### Behavior

`autoScroll` (on), `autoExpandText` (on), `autoResume` (on — resume a run after reloading the
same source), `showOverlay` (on — in-page progress panel), `showBadge` (on — toolbar badge:
post count while running, color-coded state: blue running, amber resting, violet paused,
green done, red error).

### Save & export

- **Internal checkpoints are always on** — every batch persists before scrolling; this is
  not user-disableable.
- `autoExportOnComplete` (on) — download final exports when a run finishes or is stopped.
- `exportFormats` — JSON and/or HTML (both on by default).
- `snapshotEveryPosts` (off) — optional *downloaded* snapshots mid-run every N posts.
  This is a convenience copy, not the reliability mechanism (the DB is).
- `jsonFormat` — `envelope` (default) or `legacy` (bare posts array).
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
timestamps, warnings, and a settings snapshot. Actions: **Export JSON / HTML / both**,
**Media ZIP**, **Open source to resume** (unfinished runs), **Delete** (confirmed),
**Import JSON**, and the assisted-thread review queue (below).

Storage usage is displayed; uninstalling the extension deletes all local archives.

## JSON schema & import compatibility

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
    "warnings": []
  },
  "posts": [ ]
}
```

Each post keeps the familiar legacy keys (`tweet_url`, `name`, `handle`, `timestamp_iso`,
`text`, `images`, `videos`, `quote_context`, `link_card`, `metrics`) plus stable metadata:
`schema_version`, `id` (status id), `links` (ordered `{display, href}`), `media`
(`{url, type, alt, poster, permalink}`), `capture_context` (`timeline | thread | import`),
`source_key`, `captured_at`/`updated_at`, thread fields (`is_thread`, `thread_role`,
`thread_id`, `is_self_reply`, `show_thread_link`, `thread_candidates`, `thread_scraped`),
and `warnings`. Unavailable metrics are `null`, not `0`.

**Legacy mode** exports the raw posts array — the exact shape the old scripts produced.

**Import** accepts both the envelope and raw arrays from `bookmarks.js`/`profile.js`.
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

## Assisted thread expansion (best effort)

Thread expansion is a **separate, explicitly started** phase — never part of the primary
loop and it can only run while the primary run is paused or finished.

1. During profile capture, candidates are recorded with confidence:
   explicit **"Show this thread"** links (high), visible **self-replies** (high),
   **numbered counters** like `3/10` (medium), and adjacent same-author posts within a
   0–30 minute gap (low heuristic).
2. The archive detail page shows the reviewable candidate list — deselect anything you
   don't want visited. Nothing is auto-visited.
3. **Expand selected threads** opens one dedicated worker window that processes one status
   URL at a time. It never touches or navigates your source tab.
4. For each candidate the worker waits for render, accumulates articles across bounded
   scroll passes (DOM virtualization-safe), falls back to the page URL for the focused
   root (which has no `<a>` around its `<time>`), keeps only the conversation author's
   posts, and **requires the requested status id to be observed before reporting success**.
   Numbered counters that never complete (e.g. saw `7/10` but never `10/10`) are flagged.
5. Results are upserted with `capture_context: "thread"` — thread data can enrich but
   **never erases** richer primary fields. Each job's state and diagnostics persist after
   every page, so pauses/crashes don't lose progress.
6. When the queue finishes, the worker tab lands on the archive's summary page instead of
   silently closing.

**Best effort**: X defers or hides replies, DOM structures change, and protected/deleted
posts can't be recovered. Failed candidates carry explicit diagnostics (timeout, missing
status id, login surface) in the job list — nothing silently pretends to succeed.

---

## Permissions & privacy

| Permission | Why |
|---|---|
| `storage` | settings and UI preferences in `chrome.storage.local` (locked to trusted extension contexts) |
| `unlimitedStorage` | large archives exceed normal IndexedDB quotas and must not be evicted |
| `downloads` | named JSON/HTML/ZIP downloads |
| `offscreen` | create Blob URLs and run long exports outside the short-lived service worker |
| `x.com`, `twitter.com` (host) | content scripts that read the visible DOM |
| `pbs.twimg.com` (**optional**) | only requested, via a user gesture, when you enable auto media ZIP or download media |

There is **no** all-sites access, history, cookies, debugger, or web-request interception.
No telemetry, analytics, servers, or remote code — the extension is fully inspectable and
loads unpacked. All data stays in extension-origin storage until you export or delete it.
Uninstalling the extension removes everything it stored.

---

## Known X/Chrome constraints

- **Active tab**: Chrome throttles hidden tabs heavily; keep the scraping tab visible (or in
  its own window) for reliable capture. Stall time only accrues while visible.
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
  keep it visible and online.
- *Media ZIP disabled* — the first download asks for `pbs.twimg.com` access; granting it is
  required to fetch images.
- *Export produced fewer posts* — check the run's `stopReason` and warnings; `limited` and
  `error` states mean capture is incomplete.
- *Thread job failed* — read the diagnostic: `missing status id`, `timeout`, or
  `login surface`; retrying from the review list is safe (dedupe by status id).

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
browser: load unpacked with no manifest errors; detect each source type; Start → Rest →
Pause → Resume → Stop across popup/badge/overlay; close popup mid-run; reload recovery and
route-change pause; each limit/stop reason; JSON/HTML export filenames; HTML
search/filter/sort; legacy import round-trip; media permission grant + ZIP + offline links
+ a failed image; thread queue review/run/cancel; overlay and media-ZIP defaults off.
