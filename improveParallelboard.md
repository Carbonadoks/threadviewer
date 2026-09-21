# Parallelboard scaling improvements

Goal: retain thousands of quote posts and their large conversation trees while keeping loading, navigation, and rendering responsive.

This backlog comes from a static review of `ParallelBoardView.svelte`, `parallelBoardFetchMode.worker.ts`, and `bluesky.ts`. Runtime bottlenecks still need measurement. No browser automation or local server is needed for the initial algorithm work; frontend behavior is manually tested.

## Implemented: lane placement and local layout reuse

- Replaced the per-lane scan/column-shift algorithm with constant-time linked-list insertion and one final column traversal. Placement is linear in lane count and preserves the old ordering and column coordinates, including parents appearing later in load order and missing source lanes.
- Cached each lane's local card geometry, shadow stacks, branch-switch groups, and tree connectors separately from board coordinates. Adding other lanes and changing row heights reuse this geometry. Changing the root, active chain, anchor, expansion, or display metadata invalidates the affected cache entry.
- Cache entries are removed when lanes close. Global positioning uses copies so it cannot mutate cached geometry.
- Depth-offset assignment uses an iterative traversal, avoiding recursive stack growth across deeply nested lanes. Board bounds no longer spread all card coordinates into `Math.min`.
- Global card indexes, connectors, and row placement still rebuild. This is not a fully incremental board model. Consider caching default-chain selection, avoiding layout invalidation for loading/error-only changes, and batching fetch-mode publications just as bulk loading already does.

## Implemented: render path (scroll smoothness)

Goal: no scroll/pan lag with hundreds of quote lanes and very large threads. Decisions: big mode is the only mode; low-zoom cards are simplified; drop-shadow filters became box-shadows; measured heights persist after a card unmounts.

- Board state is split in two: `boardModel` (structure: lanes, x positions, absolute `row` per card, connectors, spatial indexes) and `rowLayout` (row tops from measured heights). A height change costs O(measured cards + rows), not a full board rebuild. `card.y` is gone; use `cardTop(card)`.
- Card heights come from one shared `ResizeObserver`, batched to one state write per frame, and are kept after unmount so rows never collapse and re-grow while scrolling. A scroll-anchor effect keeps the content under the viewport still when rows above it grow.
- Viewport culling is a query, not a scan: lanes are sorted by x (binary search), and each lane's depth-sorted cards are binary-searched by row. Connectors go in an (x, row) grid; long spans (one source fanning out to many lanes) sit in a separate linear list. The expanded tree fan is filtered by x individually. Shadow stacks render at most 8 deep.
- Below 35% zoom, cards render as lightweight previews at their measured size (no media, embeds or controls, and not measured).
- Minimap: the background redraws only when the board changes (throttled to 120 ms, one `Path2D` per style), scrolling only moves the viewport box, and the selected card is a DOM overlay.
- Lane-set-dependent work (`exportAllPosts`, gallery, image discovery) is keyed on the lane root posts, not on layout or heights. Selection validity is an O(1) lookup.
- Hot state (`quoteLanes`, `postQuotes`, `cardHeights`, `laneActiveChainIds`, fetch queue, …) is `$state.raw`, so thread trees are no longer wrapped in deep proxies.
- Lane layout: iterative tree walks everywhere (no recursion depth limit). `collectLaneChains` uses one shared path (O(depth) for a deep chain, previously O(depth²)). Non-expanded lane cards are generated in one tree pass instead of per chain, and switch groups are sorted once (previously `.find` inside a sort, per chain). Preferred-chain selection is linear and cached per root/anchor.
- CSS: no `filter` on cards, rails or tree connectors (the rail shadow is a second path), no `top` transition, `contain: layout style` on cards. Images use `loading="lazy"` and `decoding="async"`. The quote picker and gallery render in pages via an intersection sentinel.
- The lane queue panel shows each "Create all quote lanes" run: discovery, a progress bar, loading/next/recent items, failures, and Stop (lanes that have not started are removed on stop).

- Moving to a card (click, keyboard, focus requests, minimap click) uses its own rAF scroll animation (`animateBoardScroll`, ease-out cubic, 140–420 ms depending on distance), not native `scrollIntoView`/`scrollTo` smooth scrolling. With native smooth scrolling, the row-anchor effect's `scrollTop` writes (when newly mounted cards are measured) cancelled the scroll partway, so it stopped and restarted. The target comes from the model each frame, the anchor correction shifts the animation's start point, and a wheel or pointer-down cancels the animation.

- Card heights are saved per post URI in localStorage (`parallelboard:card-heights:v1`, newest 20,000 posts) and seeded into `cardHeights` whenever the board model changes, so a revisited board opens with its rows already sized. Heights from cards with an open quote picker or an expanded tree fan are not saved.
- Progressive mounting (`renderedCards`): cards within ~200 px of the screen and pinned cards mount at once. The rest of the 600 px cull margin mounts 6 cards per frame (48 at low zoom), nearest first.
- Background measuring: when the board is idle (no scroll for 350 ms, no pan or scroll animation, tab visible, `requestIdleCallback` time left), cards with unknown heights mount 8 at a time at their real offscreen position, get measured, and are dropped. The queue is nearest-first and rebuilds at most once per second as lanes arrive. Once it finishes, rows no longer resize while scrolling. Row-anchor `scrollTop` corrections do not count as user scrolling. Cost: video posters of measured cards load.

- Stacked shadow cards (the alternative replies at each depth behind a lane's active chain, outside an expanded tree fan) render as lite shells (handle + text) sized to their row. They are not measured, saved or background-measured, and they no longer set row heights; only active cards do. Deep in large threads these made up most of the DOM: up to 24 full cards behind every visible card. A shell costs 1/8 of a full card in the per-frame mount budget.

- Connector culling tests each curve's actual shape, not just its bounding box (`clipCubicToRect` / `cullConnectorsToRect`). With ~1,600 quote lanes, the bounding-box query returned ~1,470 connectors for almost any view, because a fan from one source crosses the whole board. Console profiling (since removed) showed the JavaScript for a click at ~5–15 ms, but frames of 23–86 ms went to painting these SVG paths. Now only curves that pass through the cull rect are drawn. Curves with both ends in the rect are always drawn. All others are merged, whatever their source, when their visible parts and in-view endpoints coincide on a 6 px grid. This covers fans crossing the view and thousands of quote lanes pointing back at one post in the main lane. If more than 250 remain, the grid doubles until they fit, so the number drawn stays bounded however many lanes there are. `getConnectorCurve` is shared by drawing and culling.
- Scroll animations read board geometry (stage offset, view size, horizontal scroll limit, bottom padding) once at the start. The vertical scroll limit comes from `rowLayout`. Reading them every frame forced a synchronous layout whenever cards had mounted earlier in that frame.

Still open for rendering: `moveActiveCard` scans every card per keypress; a canvas-rendered tier for extremely low zoom.

## Implemented: loading (queue, streaming, sharing, cancellation)

- `src/lib/utils/requestScheduler.ts`: one request queue per board shared by the picker, bulk lane creation and fetch mode.
  - Priorities: user 0 > bulk 1 > fetch mode 2.
  - Slots refill as soon as any request finishes.
  - Requests with the same key share one in-flight task. It is only cancelled once every caller has aborted.
  - Concurrency adapts: a 429 halves it and pauses the queue for retry-after; successes grow it back.
  - Retries are bounded (3) for 429, 5xx and network errors.
- Quote discovery is paged: `fetchQuotePostsPage` in `bluesky.ts`, and the optional `fetchQuotePostsPage` in `BoardPlatformConfig`, which falls back to `fetchQuotePosts`.
  - The feed state keeps `cursor`, `pages` and `expected`, so a failed or stopped "load all" resumes from its cursor.
  - A repeated cursor ends paging.
  - Concurrent loads share one request; a page load upgraded to load-all continues from its cursor.
- Bulk "Create all quote lanes" streams. Each quote page immediately creates standalone lanes and queues thread loads while discovery continues. Discovery pauses once 150 thread loads of that job are outstanding.
- Conversation sharing:
  - Every loaded thread is indexed by all of its post URIs (`loadedThreadByPostUri`), so a queued request for any post in it resolves without a fetch.
  - A loaded thread whose conversation root is already on the board (or pending in the same job) becomes a `linked` entry instead of a duplicate lane.
- Cancellation:
  - Stopping fetch mode aborts its requests through an `AbortController` and no longer terminates the shared worker.
  - Worker hydrations can be cancelled (`cancel-hydrate`), and `getFullThread` takes a `signal`.
  - Only a missing or crashed worker (`WorkerUnavailableError`) falls back to the main thread; aborts and network errors do not.
  - A worker crash rejects every outstanding hydration.
  - Fetch-mode tasks mark a URI as queued only after the queue accepts them.
- Entries that are only loading or failing no longer rebuild the board (`readyQuoteLanes`/`resolvedQuoteEntries` are stable lists).
- The Loading panel shows:
  - Requests finished out of the total, how many are loading and waiting (threads vs quote pages), failures, retries and a rate-limit countdown.
  - The requests running now.
  - Each "load all" quote scan (found / ~expected, current page).
  - Fetch mode progress (done / to go).
  - For each lane job: discovery progress, lanes created out of the total found, threads outstanding, failures, recent results and Stop.

- Lanes no longer call `getFullThread` by default. `getPostContext` (one `getPostThread` call with `depth: 1000, parentHeight: 1000`) loads the post, its chain of parents and its replies; `BoardPlatformConfig.loadPostContext` selects it, and `/parallelboard` loads its main thread the same way. Side branches off the parents are not loaded; `isTruncated` is set when any node has more replies than were returned.
- The whole conversation loads on request: a "Full thread" button on a lane's root card (or `e`) calls `loadThread` (`getFullThread`, in the worker) at priority 0 and swaps the lane's tree in place, keeping its anchor. The main lane uses `mainThreadOverride`. Full trees are cached (`fullThreads`) and never replaced by partial ones. Conversation linking only happens when the existing lane actually contains the post.

- Quote loads that are already running can be promoted. Fetch mode scans every board post's quotes with `fetchAll` at priority 2, behind thousands of queued thread loads. Opening that post's picker, or asking for the same quotes, used to join that scan, so "Load all quote posts" sat on "Loading all..." indefinitely. Now opening the picker or joining a load calls `promoteQuoteLoad`: later pages use the new priority, and the queued page moves via `RequestScheduler.promote(key, priority)`. Quote pages time out after 20 s as a retryable network error, so a hung request cannot hold a slot forever. Refresh after a full load puts new quotes in front and keeps the loaded list and its cursor, instead of dropping back to the first 12.

- The Loading panel has a **Quote posts** section: every quote load in progress (picker, lane jobs, fetch mode) with progress, a Pause/Resume button on each "load all", and Pause all / Resume all. The list scrolls (max 240 px). Pausing lets the page in flight finish, then holds the load and its cursor open (`pausedQuoteUris`, `waitWhileQuoteLoadPaused`); callers sharing the load wait with it, and aborting still cancels. The picker's load-all button reads "Resume loading" while paused.

Still open: `getFullThread` fans out internally (up to 10 hydration requests), so one queued "thread" request can be several HTTP calls. Fetch mode keeps its fixed 1,000-task ceiling (#7). Lanes of one conversation are linked rather than drawn as separate anchored lanes.

## 1. Stream quote discovery into hydration

Current: `fetchQuotesForPost` follows every cursor page before returning. Bulk lane loading and fetch mode wait for all results. The board already requests 100 quotes per page in load-all mode.

- Expose pages through an async iterator or callback.
- Publish standalone quote lanes immediately and hydrate larger threads while subsequent pages arrive.
- Retain cursor and partial results; resume after errors instead of restarting from page one.
- Cursor-dependent pages remain sequential. Overlap discovery with hydration and discovery for other source posts.
- Add backpressure when pending hydration or UI updates exceed a bounded budget.

Verify: early pages become usable before pagination ends; retry does not duplicate or lose quotes; repeated cursors cannot loop forever.

## 2. Share request scheduling across loading paths

Current: fetch mode permits 3 tasks, bulk loading permits 5 thread loaders per operation, and each thread hydrates up to 10 branches per batch. Nested post lookups and simultaneous bulk operations multiply actual concurrency. Worker dispatch adds 300 ms delays; branch batches wait for their slowest request.

- Introduce one bounded request scheduler per service across bulk, automatic, and manual loading.
- Refill slots as individual requests finish instead of using batch barriers.
- Prioritize selected/visible posts; keep background discovery progressing fairly.
- Adapt concurrency to request latency and throttling; support bounded retries and service-provided retry delays.
- Bound UI commit backlog separately from network concurrency.
- Measure effective request concurrency before raising outer task limits.

Verify: overlapping operations honor the shared budget; a slow branch does not idle other available slots; failures cannot cause an uncontrolled retry burst.

## 3. Deduplicate conversation hydration and storage

Current: board-visible posts can be linked instead of fetched. However, different quote URIs in the same conversation can independently discover the root and hydrate/store the same tree. `getFullThread` has no shared full-thread cache or in-flight promise registry.

- Map known post URIs to conversation roots.
- Share requests by URI during discovery and by root once resolved.
- Let separate lane anchors reference a shared conversation tree.
- Consider storing posts once by URI, with separate parent/child and quote-edge indexes.
- Define refresh/eviction semantics and include platform/session identity where necessary in cache keys.

Verify: two simultaneous anchors in one conversation reuse hydration; each lane still focuses its requested anchor; closing one lane does not invalidate another.

## 4. Index viewport queries and cache the minimap

Current: offscreen card DOM is culled, but viewport filtering scans every lane's cards and every connector. The minimap redraws every card and connector on scroll.

- Index lane bounds and rows; skip entire offscreen regions. Expanded tree fans need their actual horizontal bounds, not just their lane's base column.
- Use a spatial index for expanded cards and long connectors where appropriate.
- Cache the minimap background separately from its viewport/selection overlay.
- Window the quote picker and image gallery. Lazy image loading does not bound DOM size.
- Update gallery indexes incrementally instead of collecting all lane posts after each layout change.

Verify: panning work scales with visible content; selected/offscreen focus targets stay navigable; expanded fan cards and cross-board connectors are not incorrectly culled.

## 5. Reduce tree-path duplication

Current: `collectLaneChains` copies a path at every node and retains one complete root-to-leaf path per leaf. Shared prefixes occupy repeated array slots. First-time local layout still walks paths, creates candidate cards, then deduplicates them.

- Store parent/depth/branch indexes once per immutable tree.
- Reconstruct the selected path on demand.
- Generate cards by unique post URI.
- Replace repeated chain `.find()` calls inside sorting with indexed lookups and sort each switch group once.
- Use iterative traversal for very deep post trees where recursion remains.

Verify deep chains, wide roots, shared long prefixes, branch switching, shadow-stack ordering, and tree fan expansion. Compare both retained memory and first-layout time.

## 6. Correct cancellation and concurrent loading semantics

Current problems:

- Stopping fetch mode terminates the worker and rejects hydration promises. `loadThreadForFetchMode` catches all worker failures and falls back to the main-thread loader, so stopping can start replacement requests.
- Lane loaders can publish results before their caller checks the run ID.
- A concurrent `loadQuotesForPost` call returns existing posts immediately instead of awaiting the active request; a load-all action may use partial results.
- Worker errors do not reject all outstanding hydration promises.

Actions:

- Propagate abort signals through quote discovery, root discovery, and branch hydration.
- Check run/board identity before every commit, including bulk loads and lane closure.
- Distinguish cancellation, worker infrastructure failure, and ordinary network/data errors; only appropriate infrastructure failures should trigger fallback.
- Share in-flight promises and explicitly handle upgrading a single-page request to load-all.
- Reject/clear outstanding requests on worker failure; add timeouts where appropriate.

Verify stop, navigation, unmount, lane closure during loading, worker crashes, and simultaneous picker/bulk/fetch-mode requests.

## 7. Replace the fixed task ceiling with resumable budgets

Current: `FETCH_MODE_MAX_TASKS = 1000` counts scans and opens together. Initial scans can exhaust the budget before opening tasks are accepted. Standalone lanes bypass opening tasks, making this an inconsistent memory limit. Queue updates repeatedly copy/scan arrays; the worker also uses linear membership checks and shifts.

- Separate pending work from a bounded completed-history buffer.
- Use indexed task lookup, sets for membership, and an efficient deque.
- Add configurable request/post/memory budgets with resumable pause behavior.
- Only mark a URI queued after its task is accepted.
- Decide discovery scope explicitly: newly hydrated lanes currently scan their target card, not every newly discovered post in their tree. To explore all quotes, enqueue those other posts with URI deduplication and fair scheduling.

Verify large initial boards, budget exhaustion/resume, rejection/retry, and quote discovery on non-anchor branches.

## Validation and sequencing

Rendering, streaming (#1), shared scheduling (#2), conversation sharing (#3) and cancellation (#6) are implemented (see above). Remaining: resumable fetch-mode budgets (#7), tree-path storage (#5), and routing `getFullThread`'s internal requests through the shared queue. Broader tree representation changes can follow measurement.

Use synthetic workloads with 1,000 / 5,000 / 10,000 lanes, standalone quotes, deep chains, wide trees, and many anchors in overlapping conversations. Record first usable quote latency, request counts, effective concurrency, layout/commit duration, cache hits, retained heap, and scroll long tasks. Keep algorithm correctness tests deterministic; avoid flaky wall-clock thresholds in the test suite.

Manual frontend checks should cover inbound/outbound placement, opening and closing nested lanes, switching chains, expanding tree fans, big-mode row heights, focus/navigation, and quote connectors. Do not start a local server or use browser automation unless explicitly requested.
