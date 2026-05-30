# viewer2 — Engagement Hydration & Gallery Media Fixes

## Context

Four concrete defects reported in `/viewer2` gallery + engagement flows. This plan is
scoped to fixing these specific bugs (not the broader perf refactor in
`viewer2-performance-refactor.md`). Verified by reading the code; root causes and exact
locations are below.

Files: `src/routes/viewer2/+page.svelte`, `src/lib/utils/repoHydration.ts`,
`src/lib/components/modes/GalleryThreads.svelte`, `src/lib/components/Lightbox.svelte`.

---

## Issue 1 — Engagement hydration algorithm + background mode is unreliable

### Root cause
`runEngagementHydration` (`+page.svelte:1040-1153`) drives hydration in arbitrary 250-post
chunks (`ENGAGEMENT_HYDRATION_CHUNK_SIZE`, `:1064`):

- Each chunk calls `hydrateFeedItemsEngagement(chunk)` → internally
  `buildThreadFetchCandidates(feedItems)` → `buildThreadsFromFeed(chunk)`
  (`repoHydration.ts:593,244`). Because the chunk is a **slice** of `hydrationFeedItems`, a
  thread whose posts straddle two chunks is never grouped into one
  `fetchPostThread` call — the efficient whole-thread count path
  (`fetchThreadCandidateCounts`, `repoHydration.ts:288`) is largely defeated, so most posts
  fall through to the per-post fallback batch (`fetchPostEngagementCounts`).
- After **every** chunk it calls `applyThreadsFromFeed(context.sourceFeedItems, did)`
  (`:1113`), which re-runs `buildThreadsFromFeed` over the **entire** source feed (not the
  chunk) — O(total feed) rebuild per chunk — then `saveViewer2MemoryCache()` (`:1114`)
  serializes the whole state. With thousands of posts this is the visible "background
  hydration makes everything sluggish / not working well."
- `hydrateFeedItemsEngagement` mutates `item.post.*` in place (`repoHydration.ts:642-650`)
  while the page also keeps `engagementCountsByUri` — two sources of truth.

### Fix
1. Build thread-fetch candidates **once** over the full `hydrationFeedItems` set, not per
   chunk. Either:
   - Call `hydrateFeedItemsEngagement` once over the whole set and let *it* page internally
     (preferred — it already has `threadConcurrency`/`concurrency` workers and progress), or
   - Add a `buildThreadFetchCandidates` call at the page level and chunk by **whole threads**
     (group → candidate) instead of by 250 flat posts.
2. Stop rebuilding all threads from the full feed every chunk. Apply engagement counts
   incrementally to existing thread objects via the existing copy-on-write helpers
   (`applyEngagementCountsToThreadList`, `+page.svelte:540`) keyed on `engagementCountsByUri`,
   and only do a full `applyThreadsFromFeed` once at completion if needed.
3. Throttle `saveViewer2MemoryCache()` during hydration (save on pause/complete, not per
   chunk). (Overlaps P2a of the perf plan.)
4. Make background vs. foreground explicit: lower `concurrency`/`threadConcurrency` when the
   tab is hidden or when the embed sweep is active (see Issue 4), so engagement and thumbnail
   sweeps don't both saturate the network.

### Verify
Run "Hydrate engagement" on a large account; confirm counts fill in, progress advances
smoothly, sort-by-liked reorders once at the end, and the page stays responsive. Compare
network panel: thread-count requests should dominate over per-post fallback requests.

---

## Issue 2 — Switching All → Media removes the card's white background (small images look broken)

### Root cause
In media modes the card chrome is intentionally stripped:
`.gallery-card.media-card { background: transparent; border-color: transparent; box-shadow:
none }` (`GalleryThreads.svelte:1572-1578`) and `.media-fit` also transparent (`:1580-1582`).
The media tile itself only has a faint fill in non-fit grid mode
(`.media-only-tile { background: color-mix(... 82% ...) }`, `:1618`) which goes transparent in
`media-fit` (`:1637`). When images are small (grid columns `minmax(90px, 1fr)`, `:1589`) the
tile area exceeds the image and the page background shows through, reading as "the white card
background was removed."

### Fix (decided: tile backing only — keep media cards frameless)
Give media tiles a consistent surface so small/portrait images sit on a card-colored
backdrop instead of the page background, without restoring the full card chrome:
- Add/keep a subtle card-colored background + border-radius on `.media-only-tile` for **both**
  fill and fit, including the `media-fit` / `media-fit.media-masonry` overrides that currently
  set it transparent (`:1637-1646`). In fit mode the `<img>`/`<video>` use `object-fit:
  contain` (`:1656-1658`), so the backing letterboxes small/portrait media against card color.
- Leave `.gallery-card.media-card` frameless (`:1572-1582`) — do **not** restore the card
  background/border/shadow. The fix lives on the tile, not the card.

### Verify
All → Media/Images with a feed containing small + portrait images; tiles should show a
consistent card-colored surface in both Grid/Masonry and Fill/Fit, no page background bleed.

---

## Issue 3 — In media view the "Open post" popup is too big on small tiles

### Root cause
`.media-post-overlay` (`GalleryThreads.svelte:1665-1723`) is absolutely positioned with fixed
padding (`8px 9px`), a meta line, a 2-line clamped text block, and an action line. On a small
tile (90px-ish) this overlay dominates or overflows the tile despite
`max-height: calc(100% - 16px)` (`:1672`). The text/padding don't scale with tile size.

### Fix
- Scale the overlay down on small tiles: reduce padding/font and/or hide the text body when
  the tile is below a threshold, keeping just the meta + action (or an icon-only affordance).
  Use a container query on `.media-only-tile` (or a `small-tile` class derived from estimated
  width) so the overlay shrinks with the tile.
- Alternatively make the overlay a compact bottom bar (single line) in `media`/`images` grid
  mode and only show the rich 2-line variant in masonry/larger tiles.

### Verify
Media grid with tiny images: hover/focus shows a proportionate overlay that does not overflow
the tile; larger masonry tiles keep the richer overlay.

---

## Issue 4 — Background thumbnail sweep breaks video loading

Decision: native HLS playback works in the browsers the user tested, so **do not add
hls.js**. The defect is the background sweep contending with video buffering — fix that only.

### Root cause
The embed sweep (`pumpEmbedHydrationQueue`, `GalleryThreads.svelte:279-324`) runs
`EMBED_SWEEP_CONCURRENCY = 5` workers (`:165`) loading **all** thumbnails, and
`applyHydrationResult` bumps `embedResolutionTick` after every batch (`:243`), driving
continuous re-render/relayout while a user-initiated `<video preload="none">` (`:1310`) is
trying to buffer. Network saturation + relayout churn stalls/aborts playback.

### Fix
1. Don't let the background sweep starve video playback:
   - In `movies`/`media` modes, keep `preload="none"` and do **not** eagerly sweep video
     posters — limit the eager sweep to image embeds (videos hydrate on demand / when visible).
   - Pause or relax the sweep (drop `EMBED_SWEEP_CONCURRENCY`, or halt new batches) once a
     `<video>` enters `play`/`waiting`/`loadstart`, resuming after `pause`/`ended`.
2. Throttle `embedResolutionTick` bumps (batch per `requestAnimationFrame`) so relayout
   doesn't thrash during playback (overlaps perf-plan 1c).
3. Coordinate with Issue 1: when engagement hydration is running in the background, cap total
   concurrent network work so thumbnails + counts + video segments don't contend.

### Verify
Start a video while the background thumbnail sweep is active on a large media account:
playback starts and continues without stalling, and the grid does not visibly reflow during
buffering. (No browser-compat regression — native HLS playback unchanged.)

---

## Suggested order
1. Issues 2 & 3 (CSS-only media tile backing + overlay scaling) — quick, low risk, isolated.
2. Issue 4 (sweep coordination: skip video posters in sweep, pause on play, batch ticks).
3. Issue 1 (engagement algorithm) — biggest correctness/perf win, page + util.

## Decisions locked in
- Issue 2: media cards stay **frameless**; fix the tile backing only (no full card background).
- Issue 4: **no `hls.js`** — native HLS works in tested browsers; fix sweep contention only.

## Cross-cutting verification
`npm run check` and `npm run build` must pass (CLAUDE.md §10). Manual pass in `/viewer2` on a
large, media-heavy account covering all four scenarios above. No change to thread/post counts
or search behavior.
