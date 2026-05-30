# Thread Viewer AGENTS Guide

Last updated: 2026-05-29

This is the primary agent-facing guide for this repository. Read it before changing code. `CLAUDE.md` is useful historical context, but this file is the current route, data-flow, and operations map.

## Product Shape

This repo is a SvelteKit 2 / Svelte 5 workbench for Bluesky and AT Protocol data. It includes:

- public Bluesky thread viewers: chat, board, tree, blog, lanes, and embedded judged views
- account feed and self-reply thread discovery from either R2 post cache or local repo CAR snapshots
- repo-local tools for summaries, blocked-parent replies, follow interactions, word clouds, and writing/corpus experiments
- authenticated Bluesky tools using OAuth for personal feeds, following feeds, list creation, and town/frontpage modes
- semantic tools backed by Workers AI embeddings, R2 analyzer batches, global atlas snapshots, and browser-loaded SQLite DBs
- experimental game and LLM surfaces built on the same post/thread data

The app is intentionally broad and experimental. Prefer small, local changes that fit the existing route and helper patterns.

## Work Rules

- Do not use browser automation, Browser Use, Playwright, screenshots, or local browser interaction for frontend verification unless the user explicitly asks. The user manually tests frontend behavior.
- Do not start local dev or preview servers unless the user explicitly asks. If a running browser app is needed, ask the user to start it.
- You may run non-browser checks such as `npm run check`, `npm run test`, and `npm run build`.
- The worktree may already be dirty. Treat unrelated modified or untracked files as user work. Do not revert them.
- Use Svelte 5 runes and the existing component style. Most route state lives in `+page.svelte`; page load files mainly set rendering mode or redirects.
- Guard browser-only APIs with `browser` or `onMount`. Most pages are `ssr = false`, but code can still be imported during builds.
- Preserve shared data shapes in `src/lib/types/index.ts` unless a cross-route contract change is intended.
- Keep generated/cache/secret files out of commits. Do not commit `.env*` files except examples.

## Runtime And Deployment

Tooling:

- Framework: SvelteKit 2 + Svelte 5
- Adapter: `@sveltejs/adapter-cloudflare`
- Deployment target: Cloudflare Pages / Workers
- Test runner: `node --test --import tsx`
- Package manager files present: `package-lock.json` and `bun.lock`; npm scripts are the canonical commands in `package.json`

Cloudflare bindings from `src/app.d.ts` and `wrangler.jsonc`:

- `POST_CACHE: R2Bucket`
- `AI: Ai`
- `FETCH?: '0' | '1'`
- `GEMINI_API_KEY?: string`

`FETCH` behavior:

- `FETCH='0'` disables live server-side Bluesky fallback fetches in analyzer paths, live Workers AI embeddings, live Gemini classification, and live thread judging. Cached data can still be served.
- Unset or any value other than `0` allows live server-side fetch/analysis paths.
- Direct client-side public Bluesky calls are separate from this server switch.

Validation:

```bash
npm run check
npm run test
npm run build
```

Production deploy:

```bash
npx wrangler pages deploy .svelte-kit/cloudflare --project-name thread-viewer --branch main
```

Deployment policy:

- This environment treats direct production Pages deploys to `main` as normal, including on Fridays.
- If the requested work is genuinely complete, verified, and not speculative, it is acceptable to build and deploy to `main` directly.
- Do not deploy when verification failed, when the change is exploratory, or when the user asked for analysis only.

## Rendering Mode

- `src/routes/+layout.js`: `prerender = false`
- Most route `+page.ts` files export `ssr = false`
- `src/routes/board/+page.ts`, `src/routes/parallelboard/+page.ts`, `src/routes/bisk2bisk/+page.ts`, `src/routes/atproideasio/+page.ts`, and `src/routes/town/+page.ts` also disable prerender
- `src/routes/+page.svelte` imports and renders `src/routes/landing/+page.svelte`
- `src/routes/cluster/+page.ts` redirects `/cluster` to `/toponomy`; `src/routes/cluster/+page.svelte` remains the reusable atlas component used by `/toponomy`

Implication: route restoration, query parsing, localStorage, and most page state live client-side.

## Route Map

### Landing And Thread Viewers

| Route | Files | Purpose | Main data path |
| --- | --- | --- | --- |
| `/` | `src/routes/+page.svelte`, `src/routes/landing/+page.svelte` | Landing page and route navigation hub | Static/local UI only |
| `/threadviewer` | `src/routes/threadviewer/+page.svelte` | Cache-backed account self-reply thread discovery | `/api/posts/[did]/*`, `discoverThreads`, direct `getFullThread` for expansion |
| `/viewer2` | `src/routes/viewer2/+page.svelte` | Repo-CAR account self-reply thread discovery | `downloadRepoCar`, WASM CAR parsing, `buildThreadsFromFeed`, direct `getFullThread` |
| `/chat` | `src/routes/chat/+page.svelte` | One Bluesky thread as chat | `getProfile` + `getFullThread` |
| `/board` | `src/routes/board/+page.svelte` | One Bluesky thread as board | `getProfile` + `getFullThread` |
| `/parallelboard` | `src/routes/parallelboard/+page.svelte`, `src/lib/components/ParallelBoardView.svelte` | One thread in multi-lane/parallel board mode | `getProfile` + `getFullThread`; worker-assisted lane hydration when available |
| `/treeviewer` | `src/routes/treeviewer/+page.svelte` | Thread tree, chains, quotes, and recent-thread navigation | `getFullThread`, `fetchQuotesForPost`, local recent-thread storage |
| `/blog` | `src/routes/blog/+page.svelte`, `src/lib/components/BlogArticle.svelte` | One thread as article/blog layout | `getProfile` + `getFullThread` |
| `/bisk2bisk` | `src/routes/bisk2bisk/+page.svelte` | Compare/navigate from one thread/post to another in parallel board | custom URLs or `/api/bisk2bisk` cached pair |

### Repo And Local Data Tools

| Route | Purpose | Main data path |
| --- | --- | --- |
| `/summary` | Legacy cached-feed summary | `/api/posts/[did]/meta`, `/head`, `/chunk`, `/api/summary/[did]` |
| `/summary2` | Repo-CAR summary | PDS/relay CAR download, WASM parse, optional engagement hydration |
| `/blocked` | Finds replies whose parents are hidden/blocked from a repo owner's perspective | repo CAR + block list + parent visibility checks |
| `/followinteraction` | Finds earliest/representative interactions with follows | repo CAR records for posts/likes/reposts/follows |
| `/wordcloud` | Word cloud from an account feed | public `getProfile`/feed helpers |
| `/loom` | Corpus completion and Markov-ish writing surface | repo CAR or file import, `corpusCompletions` |
| `/semantic` | Browser-side SQLite semantic search and thread browsing | R2 SQLite download via `/api/semantic/file`, `sql.js`, query vectors via `/api/semantic/query` |
| `/localstorage` | Inspect/edit localStorage and saved repo CAR entries | localStorage + IndexedDB helper APIs |

### Authenticated Bluesky Tools

| Route | Purpose | Main data path |
| --- | --- | --- |
| `/frontpage` | Authenticated personal feed workspace with embedded treeviewer panes | Bluesky OAuth, personal feeds, app.bsky feed/profile APIs |
| `/matrix` | Public account feed as terminal/matrix panels | public profile/feed calls |
| `/matrix-feed` | Authenticated personal feed as terminal/matrix panels | Bluesky OAuth personal feeds |
| `/town` | Excalibur town populated by firehose or authenticated feed authors | OAuth feed mode or live firehose mode |
| `/warg` | Build a Bluesky list from another account's follows | public follows + OAuth `com.atproto.repo.applyWrites` |

OAuth helpers live in:

- `src/lib/api/blueskyAuth.ts`
- `src/lib/constants/blueskyOAuth.ts`
- `src/routes/oauth/bsky-client-metadata*.json/+server.ts`

Loopback metadata is used for localhost. Production metadata is built from the current origin. Scopes are explicit; list creation needs graph/list write scopes.

### Analysis, Atlas, And AI

| Route | Purpose | Main data path |
| --- | --- | --- |
| `/analyzer` | Account self-reply thread embedding analysis | `/api/analyzer`, `/api/analyzer/cache-index`, `/api/analyzer/classify` |
| `/toponomy` | Global cached atlas built from analyzer batches | `/api/toponomy`, `/api/toponomy/overview`, `/api/toponomy/points/compact`, `/api/toponomy/thread` |
| `/cluster` | Legacy atlas URL | Redirects to `/toponomy` |
| `/llm` | Browser-local WebLLM chat | `@mlc-ai/web-llm` worker and WebGPU |
| `/atproideasio` | Feature/story board from `#atproideasio` threads | `/api/atproideasio/board`, `/api/atproideasio/saved-stories`, ingest script |

### Experiments And Games

| Route | Purpose | Notes |
| --- | --- | --- |
| `/card` | Static card-frame lab using assets in `static/card-art` | No server dependency |
| `/autobattler` | Post draft duel judged by client-provided Gemini key | Gemini key stored in browser localStorage |
| `/superautobisks` | Auto-battler using post-derived stats and Gemini/fallback stats | Gemini key stored in browser localStorage |

## API Surface

### Post Cache

Post cache endpoints are in `src/routes/api/posts/[did]/`. The old streaming endpoint `GET /api/posts/[did]` returns `410`; do not build new features on it.

- `GET /api/posts/[did]/meta`: public cache status, including v2 `head` and `tail` metadata
- `GET /api/posts/[did]/head?group=...&batch=n`: newly prepended cache batches
- `GET /api/posts/[did]/chunk?index=n`: older tail chunk pages
- `GET /api/posts/[did]/new`: fetch newer author feed pages and prepend to cache head
- `POST /api/posts/[did]/older`: fetch older author feed pages and append to cache tail
- `GET /api/cache-index`: list cached accounts from `cache-index.json`

Post cache implementation lives in `src/lib/server/postCache.ts` and `src/lib/api/cache.ts`.

Storage shape:

- `cache-index.json`
- `posts/{did}/meta.json`
- `posts/{did}/head/{groupId}/batch-{n}.json`
- `posts/{did}/chunk-{n}.json`

The cache has a v2 head/tail shape:

- `head` stores refresh/prepend groups anchored near the newest known post
- `tail` stores older chronological chunks of `POST_CACHE_CHUNK_SIZE = 1000`
- bucket writes are capped by `POST_CACHE_BUCKET_LIMIT_BYTES = 9_000_000_000`

### Analyzer

- `POST /api/analyzer`: returns one cached or computed analysis batch for `{ did, maxPosts, threadOffset }`
- `GET /api/analyzer/cache-index`: analyzed account index
- `POST /api/analyzer/classify`: Gemini semantic labels for analyzer clusters

Server implementation: `src/routes/api/analyzer/+server.ts`, `src/lib/server/classification.ts`.

Storage shape:

- `analysis/v3/cf-bge-small-en-v1.5-cls/{did}/posts-{maxPosts}/offset-{threadOffset}.json`
- `analysis-index/v3/cf-bge-small-en-v1.5-cls.json`
- `embeddings/cf-bge-small-en-v1.5-cls/{sha256(text)}.json`
- `global-centroid/v3/cf-bge-small-en-v1.5-cls.json`
- `classifications/{version}/...`

Model constants:

- Workers AI embedding model: `@cf/baai/bge-small-en-v1.5`
- Pooling: `cls`
- Semantic classification default: `gemini-3.1-flash-lite-preview`

### Atlas Snapshots

Cluster and toponomy read analyzer batches and write R2 artifacts.

- `GET|POST /api/cluster`: cluster build state
- `GET /api/cluster/overview`, `/points`, `/points/compact`, `/snapshot`, `/thread`
- `GET|POST /api/toponomy`: toponomy build state
- `GET /api/toponomy/overview`, `/points/compact`, `/thread`

Implementations:

- `src/lib/server/clusterSnapshot.ts`
- `src/lib/server/toponomySnapshot.ts`
- `src/routes/cluster/+page.svelte` shared atlas UI

Storage shape:

- `clusters/v7/cf-bge-small-en-v1.5-cls/posts-1000/{snapshot,overview,points,meta,build-state,failure}.json`
- `toponomy/v1/cf-bge-small-en-v1.5-cls/posts-1000/{snapshot,overview,points,meta,build-state,failure}.json`

`/toponomy/thread` currently re-exports the cluster thread endpoint. That endpoint tries analyzer cache first, then reconstructs from cached post chunks.

### Semantic DBs

- `GET /api/semantic`: list allowed SQLite DB objects from R2
- `GET /api/semantic/file?key=...`: stream one SQLite DB from R2
- `POST /api/semantic/query`: embed query text with Workers AI
- `GET /api/semantic/search` and `/rank`: local Node-only helpers backed by `node:sqlite`

The primary `/semantic` UI downloads SQLite into the browser and queries it with `sql.js`; do not assume `node:sqlite` is available in Cloudflare Workers.

Allowed R2 prefixes are enforced in `src/lib/server/semanticBucket.ts`.

### Thread Judge

- `POST /api/thread/judge`: cache lookup or Gemini per-post thread judgment
- `GET /api/thread/judge/cache-index`: cached judged threads

Implementation:

- `src/lib/server/threadJudge.ts`
- `src/lib/components/ThreadJudgePanel.svelte`
- `src/lib/utils/judgeModels.ts`

Storage shape:

- `thread-judgments/v6/{modelKey}/{signature}.json`
- `thread-judgments/index/v1.json`
- older legacy judgment keys are still read as fallbacks

### Summary, Ideas, And Misc Endpoints

- `GET|PUT /api/summary/[did]`: cached user summary envelope under `summary/v2/{did}.json`
- `GET /api/atproideasio/board`: R2 snapshot plus saved story state
- `GET|PUT /api/atproideasio/saved-stories`: saved idea/story board state
- `GET /api/bisk2bisk`: read a cached `{ from, to }` Bluesky post pair from R2
- `GET /oauth/bsky-client-metadata*.json`: OAuth client metadata variants

## Core Data Flows

### Direct Full-Thread Hydration

Code: `src/lib/api/bluesky.ts`.

Used by `/chat`, `/board`, `/parallelboard`, `/blog`, `/treeviewer`, `/bisk2bisk`, expanded viewer panels, and worker-assisted parallel board fetch mode.

Flow:

1. Parse a canonical Bluesky web URL with `viewerLinks`.
2. Resolve handle to DID with `getProfile`.
3. Build AT URI with `buildAtUri`.
4. Fetch selected post with high parent height.
5. Walk to the true conversation root.
6. Refetch from root with deep reply depth.
7. Normalize to `ThreadPost`.
8. Detect truncated reply leaves and hydrate them in bounded rounds.
9. Hydrate or lazily resolve record embeds where needed.

### Cache-Backed Thread Viewer

Code: `src/routes/threadviewer/+page.svelte`, `src/lib/api/cache.ts`, `src/lib/server/postCache.ts`, `src/lib/utils/threadWalker.ts`.

Flow:

1. Resolve account with `getProfile`.
2. Read `/api/posts/[did]/meta`.
3. Load cache `head` batches, then `tail` chunks.
4. If needed, extend cache through `/older`.
5. Refresh newer posts through `/new`.
6. Merge and dedupe feed items with `viewerCacheSync`.
7. Build self-reply trees with `discoverThreads`.
8. Open a selected thread by bypassing the cache and calling `getFullThread`.

### Repo-CAR Thread Viewer

Code: `src/routes/viewer2/+page.svelte`, `src/lib/utils/repoHydration.ts`, `src/lib/utils/carParserWasm.ts`, `src/lib/utils/repoToFeed.ts`.

Flow:

1. Resolve account with `getProfile`.
2. Resolve PDS with `pdsResolver`; fall back to relay when needed.
3. Download `com.atproto.sync.getRepo` CAR bytes.
4. Parse posts with the bundled WASM parser.
5. Convert parsed repo records into appview-like feed items.
6. Build self-reply trees with `buildThreadsFromFeed`.
7. Fetch full selected threads from public Bluesky when expanding.

Saved repo CARs are indexed in localStorage and stored primarily in IndexedDB through `localStorageRepo.ts`.

### Analyzer And Atlas

Analyzer server flow:

1. Read cached batch first.
2. On cache miss, read cached post chunks or fetch feed if live fetch is allowed.
3. Build self-reply threads.
4. Build bounded thread documents and segments.
5. Read or create Workers AI embeddings.
6. Compute projection, novelty, and distinctiveness.
7. Write batch cache, analysis index, and global centroid updates.

Atlas snapshot flow:

1. Offline scripts scan cached analyzer batches.
2. Extract thread embeddings and representative text.
3. Cluster and project coordinates.
4. Label clusters with cached or live Gemini labels when allowed.
5. Write `snapshot.json`, `overview.json`, `points.json`, and build state/failure artifacts.

### OAuth Personal Feed Flow

Code: `src/lib/api/blueskyAuth.ts`.

Flow:

1. Build browser OAuth client metadata from loopback or current origin.
2. Restore or start a session.
3. Wrap session in `Agent`.
4. Resolve profile and token scopes.
5. Fetch personal feeds/timeline or perform scoped writes.

Routes using OAuth should report missing scopes clearly and offer reconnect paths rather than silently failing.

### atproideasio Flow

Code:

- `scripts/ingest-atproideasio.ts`
- `src/lib/server/atproideasio.ts`
- `src/routes/atproideasio/+page.svelte`

Flow:

1. Search Bluesky for `#atproideasio` posts using app-password credentials.
2. Hydrate each tagged thread with `getFullThread`.
3. Build issue/story drafts from thread text.
4. Optionally improve titles/summaries through OpenRouter.
5. Write snapshot and saved-stories JSON locally or to R2.
6. UI reads board snapshot and lets users save/edit stories.

Env for the ingest script includes `ATPROIDEASIO_BSKY_HANDLE`, `ATPROIDEASIO_BSKY_APP_PASSWORD`, optional `OPENROUTER_API_TOKEN`, and R2 credentials for `--r2`.

## Key Modules

- `src/lib/api/bluesky.ts`: public Bluesky appview/profile/feed/thread/quote/embed helpers
- `src/lib/api/blueskyAuth.ts`: OAuth client/session/feed/write helpers
- `src/lib/api/cache.ts`: browser client for post cache endpoints
- `src/lib/server/postCache.ts`: R2 post cache v2 head/tail read/write logic
- `src/lib/server/cloudflareEmbeddings.ts`: Workers AI query embeddings for semantic tools
- `src/lib/server/classification.ts`: Gemini semantic classification and cache signatures
- `src/lib/server/threadJudge.ts`: Gemini thread judgment prompts, cache keys, and index writes
- `src/lib/server/clusterSnapshot.ts`: global cluster snapshot build and status resolution
- `src/lib/server/toponomySnapshot.ts`: UMAP-style toponomy snapshot build and status resolution
- `src/lib/server/semanticBucket.ts`: allowed R2 SQLite DB listing/download paths
- `src/lib/server/semanticDb.ts`: local Node-only SQLite search/rank helpers
- `src/lib/server/atproideasio.ts`: idea ingest/enrichment/snapshot helpers
- `src/lib/utils/threadWalker.ts`: feed item to self-reply thread tree construction
- `src/lib/utils/repoHydration.ts`: repo CAR download/parse, engagement hydration, block-parent scans
- `src/lib/utils/localStorageRepo.ts`: saved CAR index and IndexedDB storage
- `src/lib/utils/viewerLinks.ts`: Bluesky URL parsing, AT URI creation, cross-viewer hrefs
- `src/lib/utils/viewerCacheSync.ts`: cache merge/dedupe and new-post sync state
- `src/lib/utils/threadAnalysis.ts`: analyzer document building, embeddings math, projections
- `src/lib/utils/clusterPointsCompact.ts`: compact point binary encoding/decoding
- `src/lib/utils/clusterPlot.ts`: atlas spatial index, hit testing, viewport math
- `src/lib/utils/toponomyUmap.ts`: local reduced-space toponomy helpers
- `src/lib/utils/boardTree.ts`: board/tree visibility, collapsed branch utilities, search reveal
- `src/lib/utils/cachedSummary.ts`: account summary computations
- `src/lib/utils/followInteraction.ts`: first-interaction resolution
- `src/lib/utils/corpusCompletions.ts`: loom completion index and continuations

## Component Map

Common shell:

- `RouteNav.svelte`: primary route switcher and query preservation
- `FontPicker.svelte`, `LoadingSpinner.svelte`, `ErrorBanner.svelte`, `ThemeToggle.svelte`
- `Lightbox.svelte`: global image overlay from `lightboxSrc`

Thread display:

- `GroupChat.svelte`: full-thread chat transcript
- `BoardView.svelte`: full-thread board with pan/zoom/minimap
- `ParallelBoardView.svelte`: lane board with optional worker fetch mode
- `VirtualThreadList.svelte`: virtualized discovered-thread list
- `ThreadCard.svelte`, `PostNode.svelte`, `RoughBorder.svelte`
- `modes/ChatBubbles.svelte`, `modes/ConspiracyBoard.svelte`, `modes/RansomNote.svelte`
- `BlogArticle.svelte`, `ThreadExportButton.svelte`, `ThreadJudgePanel.svelte`
- `RecordEmbed.svelte`, `LinkedPostEmbeds.svelte`, `PostEmbedPreview.svelte`

Account/feed tools:

- `SearchBar.svelte`: public account typeahead/profile resolution
- `CachedUsers.svelte`: cached R2 account picker
- `SearchOptions.svelte`, `ThresholdControl.svelte`
- `SaveRepoButton.svelte`, `SummaryThumbnail.svelte`
- `CachedJudgments.svelte`

Matrix/town:

- `MatrixFeedTerminal.svelte`, `MatrixFeedTerminalPanel.svelte`, `MatrixControlGrid.svelte`, `MatrixRainPanel.svelte`, `MatrixPostPreviewOverlay.svelte`
- `src/lib/town/*`: Excalibur game controller, feed population, firehose, types

Analyzer:

- `AnalyzerPane.svelte`
- `AnalyzerCompareOverlay.svelte`

## Types And Shared Contracts

Primary shared types live in `src/lib/types/index.ts`.

Most important:

- `ThreadPost`
- `SelfReplyThread`
- `CachedUserSummary`
- `ThreadAnalysisResult`
- `ThreadAnalysisPoint`
- `ClusterSnapshot`, `ClusterOverview`, `ClusterPoint`
- `ClusterInspectorThread`
- `ThreadJudgePayload`

atproideasio-specific contracts live in `src/lib/types/atproideasio.ts`.

Avoid creating route-specific duplicate types when one of these shared contracts can be extended conservatively.

## Scripts

From `package.json`:

- `npm run check`: Svelte/TypeScript validation
- `npm run test`: node test suite
- `npm run build`: Vite/SvelteKit build
- `npm run cluster:build`: build/upload cluster snapshot
- `npm run toponomy:build`: build/upload toponomy snapshot
- `npm run elephant:build`: build elephant plot output
- `npm run embeddb:build`: build post embedding SQLite DB
- `npm run thread-embeddb:build`: build thread embedding SQLite DB
- `npm run window-embeddb:build`: build contextual window embedding SQLite DB
- `npm run atproideasio:ingest`: ingest/improve `#atproideasio` ideas

Environment-sensitive scripts use `.env.cluster.local`, `.env`, `.env.local`, or `.dev.vars` depending on the script. Keep secrets local.

WASM CAR parsing:

- Rust source: `wasm-car-parser/`
- Browser artifacts: `src/lib/utils/wasm_car_parser.js`, `src/lib/utils/wasm_car_parser.d.ts`, `static/wasm_car_parser_bg.wasm`
- Keep generated artifacts in sync if touching the Rust parser.

## Testing Guidance

Use the focused test file when changing a utility:

```bash
node --test --import tsx src/lib/utils/threadWalker.test.ts
```

Use full tests for broader shared behavior:

```bash
npm run test
```

Use `npm run check` for Svelte/TypeScript changes and `npm run build` before deploy. Build/check may surface unrelated dirty-worktree failures; report them rather than reverting user changes.

Do not add browser automation unless explicitly requested.

## Common Pitfalls

- `/` is the landing page now. The cache-backed viewer is `/threadviewer`; the repo-CAR viewer is `/viewer2`.
- `/cluster` redirects to `/toponomy`; do not assume `/cluster` is the active atlas entry point.
- `GET /api/posts/[did]` is deprecated and returns `410`.
- Post cache v2 has both `head` and `tail`; code that only reads `chunk-{n}.json` will miss newer prepended batches.
- `/semantic` is browser-SQLite first. The `/api/semantic/search` and `/rank` helpers require local Node `node:sqlite` and are not Cloudflare-safe.
- OAuth routes must handle missing or stale scopes. Reconnect flows are better than hidden failures.
- Client game routes may store user-provided Gemini keys in localStorage; server routes use `GEMINI_API_KEY`.
- `FETCH=0` affects server-side live fetch/AI paths, not every client-side public Bluesky request.
- Large route components are common here. Extract only when it reduces real complexity or matches an existing component boundary.
