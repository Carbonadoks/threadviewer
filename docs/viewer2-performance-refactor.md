# viewer2 Performance Refactor

## Context

`/viewer2` (`src/routes/viewer2/+page.svelte`, ~2500 lines) downloads an entire AT-proto
repo, builds self-reply threads, and renders them through `VirtualThreadList` →
`GalleryThreads`. For large accounts (hundreds of threads, thousands of media posts) the
page janks during search/scroll and especially during embed hydration in gallery mode.

The full import chain was traced and the hotspots verified directly. Several initially
suspected items turned out to be non-issues (noted below). The cost is concentrated in three
places: **GalleryThreads reactive rebuilds keyed on embed hydration**, **page-level reactivity
(cache save + dead sort map)**, and a few smaller **virtual-list / data-util** items. Goal: cut
redundant whole-list recomputation so hydration/search/scroll stay smooth, with no behavior
change.

Scope: full refactor across gallery rendering, page reactivity, virtual list, and data utils.

## Non-issues found (do NOT "fix" these)

- `threadWalker.measureDepth` is called **once** per root at build time (`threadWalker.ts:227`)
  and cached in `thread.depth`. Page code sorts/filters on the cached `thread.depth`
  (`+page.svelte:464,475`), so it is **not** recomputed per interaction. Leave it.
- `VirtualThreadList` virtualization is correct. Per-row `ResizeObserver` is acceptable
  (only visible rows are observed). Low priority.
- `bluesky.ts` `getFullThread` only runs on expand/blog-open (one-off), not in hot paths.
  Treat any rework there as opportunistic and verify claims before touching.

---

## Priority 1 — GalleryThreads (`src/lib/components/modes/GalleryThreads.svelte`)

This is the dominant cost. `embedResolutionTick` bumps on every embed that hydrates; several
derivations that span the **entire** list re-run on each bump.

### 1a. Decouple structure from embed hydration (`:924-934`)
`galleryEntries` lists `embedResolutionTick` as a dependency. In `groupMode === 'threads'` the
result (`threads.map(...)`) does not depend on embeds at all — the tick forces a full array
rebuild for nothing. In `posts` mode it depends on embeds via `buildPostEntries`.
- Split: in thread mode, derive `galleryEntries` from `threads` only (drop the tick).
- In posts mode, keep the embed dependency but see 1b.

### 1b. Stop rebuilding ALL tiles on every tick (`:937-940`, `:997-1002`)
`allMasonryTiles` runs `galleryEntries.map(buildTile).filter(...)` over the **whole** list on
each `embedResolutionTick`; `tiles` does the same for visible entries. `buildTile` runs
`buildGalleryPost` (segments + `highlightRanges` regex/fuzzy) per post.
- Memoize per-tile build keyed by `(post.uri, embed-resolved?, matcher identity)` so an embed
  resolving for one tile doesn't rebuild every other tile. A `Map<rootUri, GalleryTile>` cache
  invalidated only for changed URIs is enough.
- `allMasonryTiles` is only needed for layout geometry — feed it cached tiles.

### 1c. Masonry layout recompute (`:942-946`, `buildMasonryLayout :734-769`)
`masonryLayout` depends on `mediaAspectRatios`; one image `onload` (`updateMediaAspectRatio`)
re-runs `buildMasonryLayout` over all tiles. The algorithm itself is O(tiles·columns) which is
fine — the problem is frequency.
- Batch aspect-ratio updates: accumulate into `mediaAspectRatios` and flush once per
  `requestAnimationFrame` instead of per `onload`, so a burst of image loads triggers one
  relayout. (`updateMediaAspectRatio` currently writes state synchronously per image.)

### 1d. Unify the two hydration effects (`:1089-1101` visible-first, `:1106-1113` sweep)
Both fire on `embedResolutionTick` and can request the same URIs in the same tick (visible set
is a subset of the sweep). `requestedEmbedUris` dedups network calls but both effects still run
their full `collectHydratablePostUris` traversals each tick.
- Merge into one effect with a priority queue: visible URIs first, then background sweep, with a
  single guard so a tick doesn't re-scan the whole list when only one URI resolved.

---

## Priority 2 — Page reactivity (`src/routes/viewer2/+page.svelte`)

### 2a. Throttle/guard `saveViewer2MemoryCache` (`:819-821`)
A bare `$effect(() => saveViewer2MemoryCache())` re-serializes the entire state object
(`allThreads`, `displayedThreads`, `engagementCountsByUri`, expanded thread, etc.) on **every**
reactive change — each keystroke, each scroll-driven derivation, each hydration tick.
- Debounce to ~400-500ms, and/or only save on meaningful transitions (search complete, expand,
  mode change, hydration batch complete — most of which already call `saveViewer2MemoryCache()`
  explicitly). Since explicit calls already exist throughout (e.g. `:1114,1134,1410,1498`),
  the blanket effect is largely redundant and the main offender.

### 2b. Remove the dead engagement map used only as a reactive trigger (`:443-470`)
`threadEngagementByRootUri` (`:443-449`) builds a full `Map` over `allThreads`, but
`compareThreadValues` reads engagement from `rootPostEngagement(a)` directly — the map's values
are never consumed. `compareThreads` (`:467-470`) only references it to force re-sort when
engagement updates.
- Drop the map; trigger re-sort off a cheaper signal (e.g. read `allThreads` identity, which
  already changes when `applyThreadsFromFeed` reassigns it during hydration at `:931`).

### 2c. Memoize `sortedThreads` (`:472`)
`[...allThreads].sort(compareThreads)` copies + sorts on every `allThreads` change including
each engagement-hydration batch (`applyThreadsFromFeed` reassigns `allThreads` per chunk,
`:1113`). Combined with 2b, ensure the sort only re-runs when the thread set or sort mode
actually changes, not on unrelated reactivity.

### 2d. Avoid full-tree clone churn during hydration (`applyEngagementCountsToPost :508-546`)
Each hydration batch reassigns `allThreads` via `applyThreadsFromFeed` → re-runs
`buildThreadsFromFeed` over the **entire** feed (`:915`, `:1113`) every
`ENGAGEMENT_HYDRATION_CHUNK_SIZE` posts. For a large repo this rebuilds all threads many times.
- Apply engagement counts incrementally to existing thread objects (the
  `applyEngagementCountsTo*` helpers already do copy-on-write and return the same reference when
  unchanged) instead of rebuilding threads from feed each batch. Rebuild from feed only once
  after hydration completes if needed.

---

## Priority 3 — VirtualThreadList (`src/lib/components/VirtualThreadList.svelte`)

Lower impact; do after 1–2.

### 3a. `threadIndexByRootUri` (`:148-154`)
Full `Map` rebuilt on every `threads` change but only consumed in the scroll-to-target effect
(`:274`). Build it lazily inside that effect (or memoize) rather than as an always-on derivation.

### 3b. `prefixOffsets` (`:93-101`)
O(n) recompute whenever `rowHeights` changes (each row measurement). Acceptable for a virtual
list; optional improvement is an incremental prefix-sum update keyed by the single changed row.
Only pursue if profiling shows it matters.

---

## Priority 4 — Data utils (small, opportunistic)

### 4a. `threadBlog.collectSelfReplyChainPosts` double sort (`threadBlog.ts:24,33`)
Children are sorted inside `walk` (`:24`) and then the whole array is sorted again (`:33`). The
inner sort is redundant given the final global sort. Drop the inner `[...].sort(...)` (still
iterate children; order there doesn't affect the final sorted output). Blog-only path, minor.

### 4b. `findSelfReplyChainRoot` full index (`threadBlog.ts:36-60`)
Builds `postsByUri` + `parentByUri` over the whole subtree but only walks the parent chain of
one node. Could build only an ancestor path. Minor (blog open only) — optional.

---

## Implementation order

1. P2a + P2b + P2c (page reactivity) — small, high-value, low-risk, isolated to one file.
2. P2d (incremental engagement apply) — verify hydration UI still updates correctly.
3. P1a–P1d (GalleryThreads) — the big one; do tile-cache (1b) first, then hydration unify (1d),
   then aspect-ratio batching (1c), then galleryEntries decouple (1a).
4. P3 + P4 — cleanup if time/profiling warrants.

Keep each as a separate commit so regressions are bisectable.

## Verification

- `npm run check` and `npm run build` must pass after each priority block (per CLAUDE.md §10).
- Manual, in `/viewer2` with a large account (e.g. a prolific poster handle):
  1. Search a handle → repo downloads, threads render, stats bar correct.
  2. Switch to gallery → Media/Images/Movies + Masonry; confirm tiles fill in as embeds hydrate
     and the grid doesn't visibly re-flow/flicker the whole list on each image load.
  3. Type in the thread search box rapidly — confirm no per-keystroke hang; results count and
     `updating...` note behave as before.
  4. Sort by Liked/Reposted/Quoted, then run "Hydrate engagement" — counts update, sort
     reorders once hydration completes, no jank.
  5. Expand a thread, open blog reader, navigate back — state restores; reload page with
     `?handle=` and confirm memory cache restore still works (the throttled save must have
     flushed; ensure `onDestroy` still calls `saveViewer2MemoryCache()` at `:1663`).
- Compare before/after with DevTools Performance: record while scrolling a media gallery and
  while one image batch hydrates; the long-task time on `embedResolutionTick` rebuilds should
  drop substantially.
- Sanity: thread/post counts, depths, and search matches must be identical to current behavior
  (pure performance refactor — no functional change).
