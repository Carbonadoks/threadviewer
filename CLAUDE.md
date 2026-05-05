# Thread Viewer + Analyzer Engineering Spec

Last updated: 2026-03-05

This file is the canonical project context for agent-driven development (Claude/Codex).
Use this as the first-read doc before implementing changes.

## 1) Product Scope

`thread-viewer` is a SvelteKit app for:
- Discovering Bluesky self-reply chains from an account feed.
- Rendering threads in multiple visual modes (`/`, `/board`, `/chat`).
- Running semantic analysis on self-reply threads (`/analyzer`) using:
  - Cloudflare Workers AI embeddings (`@cf/baai/bge-small-en-v1.5`, `cls` pooling).
  - Cached/global metrics (novelty, interestingness, global distinctiveness).
  - Optional Gemini classification labels.

## 2) Runtime + Deployment Truth

## Runtime bindings (Cloudflare)

From `src/app.d.ts` and `wrangler.jsonc`:
- `POST_CACHE: R2Bucket`
- `AI: Ai`
- `FETCH?: '0' | '1'`
- `GEMINI_API_KEY?: string`

`FETCH` behavior:
- `FETCH='0'`: disable live Bluesky fetch + live Workers AI embedding in analyzer, and disable live Gemini classification.
- Any other value or unset: live fetches allowed.

## Cloudflare config

From `wrangler.jsonc`:
- Project name: `thread-viewer`
- Pages output dir: `.svelte-kit/cloudflare`
- R2 bucket binding: `POST_CACHE -> thread-viewer-cache`
- Workers AI binding: `AI`

## Route rendering mode

- `src/routes/+page.ts`: `ssr = false`
- `src/routes/analyzer/+page.ts`: `ssr = false`
- `src/routes/chat/+page.ts`: `ssr = false`
- `src/routes/board/+page.ts`: `ssr = false`, `prerender = false`
- `src/routes/+layout.js`: `prerender = false`

## Deploy commands

Build:
```bash
npm run check
npm run build
```

Preview/branch deploy:
```bash
npx wrangler pages deploy .svelte-kit/cloudflare --project-name thread-viewer --branch analyze
```

Production deploy (assuming production branch is `main` in Pages settings):
```bash
npx wrangler pages deploy .svelte-kit/cloudflare --project-name thread-viewer --branch main
```

## 3) Current Architecture

## Core pages

- `/` (`src/routes/+page.svelte`): discovery UI + mode-based rendering.
- `/chat` (`src/routes/chat/+page.svelte`): direct thread viewer from a Bluesky URL.
- `/board` (`src/routes/board/+page.svelte`): board-style viewer route.
- `/analyzer` (`src/routes/analyzer/+page.svelte`): embedding-based semantic analyzer UI.

## API routes

- `GET /api/posts/[did]` (`src/routes/api/posts/[did]/+server.ts`): SSE feed stream with cache read + live fetch + background save.
- `GET /api/cache-index` (`src/routes/api/cache-index/+server.ts`): cached account list from R2.
- `POST /api/analyzer` (`src/routes/api/analyzer/+server.ts`): analyzer pipeline (cache + embedding + metrics).
- `GET /api/analyzer/cache-index` (`src/routes/api/analyzer/cache-index/+server.ts`): analyzed account index.
- `POST /api/analyzer/classify` (`src/routes/api/analyzer/classify/+server.ts`): Gemini cluster labels.

## 4) Storage Layout (R2 Keys)

Post cache:
- `cache-index.json`
- `posts/{did}/meta.json`
- `posts/{did}/chunk-{n}.json`

Analyzer cache:
- `analysis/v3/cf-bge-small-en-v1.5-cls/{did}/posts-{maxPosts}/offset-{threadOffset}.json`
- `analysis-index/v3/cf-bge-small-en-v1.5-cls.json`

Embedding cache:
- `embeddings/cf-bge-small-en-v1.5-cls/{sha256(text)}.json`

Global centroid cache:
- `global-centroid/v3/cf-bge-small-en-v1.5-cls.json`

Classification cache:
- `classifications/v1/{did}/{sha256(clusters)}.json`

## 5) Thread Fetching Algorithm (Authoritative)

This section describes the actual algorithm used by the app today.

## 5.1 Feed acquisition (`GET /api/posts/[did]`)

File: `src/routes/api/posts/[did]/+server.ts`

Constants:
- `CHUNK_SIZE = 1000`
- `MAX_CACHED_ACCOUNTS = 50`
- `MAX_API_CALLS = 40`
- `MIN_POSTS_FOR_CACHE = 5000`
- Bluesky endpoint: `app.bsky.feed.getAuthorFeed` with `filter=posts_with_replies`, `limit=100`

Pipeline:
1. Determine cache eligibility from `cache-index.json`.
2. Skip cache enrollment for new small accounts (`postsCount < 5000`).
3. If cached:
   - Read `meta.json`.
   - Run catch-up scan (up to 10 calls) to prepend newly arrived posts until overlap with cached newest post.
   - Stream cached chunks directly as raw JSON through SSE `posts` events.
4. If more posts are needed and end not reached:
   - Continue paginated Bluesky fetch up to target/max calls.
   - Stream each fetched page immediately as `posts` SSE.
   - Periodically persist full chunks while fetching.
5. On completion:
   - Emit `done` SSE.
   - Run final best-effort cache save using `waitUntil` when available.
   - Persist updated `meta.json` and add DID to `cache-index.json` if newly cache-enrolled.

SSE events emitted:
- `posts`, `progress`, `done`, `warning`, `info`, `error`

## 5.2 Feed -> thread graph construction

File: `src/lib/utils/threadWalker.ts`, function `buildThreadsFromFeed`

Algorithm:
1. First pass: index posts by URI for the target author only.
2. Record per-post direct parent URI and declared root URI.
3. Second pass: link child to direct parent when both nodes exist in feed sample.
4. Fallback pass: if direct parent missing but root exists, attach child to root.
5. Roots are all posts not present in `childUris`.
6. Compute `depth = measureDepth(root)` for each root.
7. Mark orphan fragments where true root is outside feed sample (`orphanToTrueRoot`).

Output:
- `threads: SelfReplyThread[]`
- `orphanToTrueRoot: Map<orphanRootUri, trueRootUri>`

## 5.3 Orphan chain hydration

File: `src/lib/utils/threadWalker.ts`, function `discoverThreads`

After local graph build:
1. For up to 10 unique missing true roots:
   - Fetch full self-reply chain via `fetchSelfReplyChain(trueRootUri, did)`.
2. Remove orphan fragments mapped to that true root.
3. Insert hydrated full chain result.

Thread delivery to UI:
- Emit via callback in batches of 200 with `setTimeout(0)` yields to keep UI responsive.

## 6) Analyzer Pipeline (Current Behavior)

File: `src/routes/api/analyzer/+server.ts`

Key limits:
- `MAX_POSTS = 1000`
- `MAX_ANALYZED_THREADS = 12`
- `MAX_SEGMENTS_PER_THREAD = 2`
- `MAX_CLUSTER_SEGMENT_BUDGET = 10`
- `EMBEDDING_BATCH_SIZE = 20`
- `EMBEDDING_MAX_RETRIES = 4`

Embedding model:
- `@cf/baai/bge-small-en-v1.5`
- Pooling: `cls`
- Label: `@cf/baai/bge-small-en-v1.5 (cls)`

Flow:
1. Parse `{ did, maxPosts, threadOffset }`.
2. Read cached analyzer batch for `(did, maxPosts, offset)` first.
3. If cache miss:
   - Get posts from R2 cache if possible; otherwise fetch Bluesky feed (unless `FETCH='0'`).
   - Build self-reply threads from feed.
   - Select reply threads and build bounded thread documents/segments.
4. Embed segment texts:
   - Deduplicate by SHA-256.
   - Read cached embeddings first.
   - Only embed misses live when `FETCH != '0'`.
   - On quota/rate failures, retry with backoff, then return partial cached-only result.
5. Compute metrics:
   - Cluster map coordinates.
   - Running novelty.
   - Running interestingness.
   - Global distinctiveness against cached global centroid.
6. Cache result batch + update analysis index.
7. Incrementally update global centroid with newly cached segment embeddings.

Global centroid:
- Read from `global-centroid/v3/cf-bge-small-en-v1.5-cls.json`.
- If missing, rebuild from all cached analyzer batches under `analysis/v3/cf-bge-small-en-v1.5-cls/`.
- Centroid is incremental running mean over normalized segment embeddings.

## 7) Classification Pipeline (Current Behavior)

File: `src/routes/api/analyzer/classify/+server.ts`

- Model: `gemini-3.1-flash-lite-preview`
- Retry policy: `429` and `>=500` with exponential backoff.
- Cache key version: `v1`.
- If `FETCH='0'`: returns model with `(fetch-disabled)` and no live labels.
- If no `GEMINI_API_KEY`: returns 503 with fallback message.

Important note:
- Cache reuse is model-agnostic at `v1`; changing model may reuse old labels if request signature matches.

## 8) Known Technical Debt

1. Build warnings around nested buttons and interactive `<img>` roles remain unresolved.
2. Large client chunk warning (`>500kB`) remains unresolved.
3. `wrangler` emits `node:async_hooks` warning for Worker bundle (consider `nodejs_compat` audit).
4. Classification cache version does not encode model identity.
5. No automated cleanup policy for old R2 analysis/embedding keys.

## 9) Future Feature Backlog

Prioritized list for next iterations.

## P0 (Reliability / Correctness)

1. Add model-aware classification cache keys (`model + prompt signature`).
2. Add explicit analyzer response field showing exact data sources used (`cache_only`, `live_fetch`, `partial`).
3. Add R2 schema migration helper for cache namespace/version transitions.
4. Add integration tests for `FETCH=0` behavior to prevent regressions.
5. Add end-to-end smoke test for analyzer click interactions and font selection persistence.

## P1 (User Value)

1. Persist analyzer UI controls in URL (metric tab, sort order, selected thread).
2. Add richer thread detail drawer with jump-to-post and permalink copy.
3. Add account compare mode (`did A` vs `did B`) on shared metric chart.
4. Add cache freshness badges per analyzed account.
5. Add explicit "partial due to rate limit" banner with actionable retry guidance.

## P2 (Scale / Cost)

1. Adaptive embedding budget based on account size and cache hit ratio.
2. Queue-based background embedding to smooth Cloudflare AI quota spikes.
3. Periodic global centroid recomputation job to reduce drift and corruption risk.
4. Optional compressed payload storage for large analyzer batches.
5. Data retention rules for stale analysis keys.

## P3 (Quality / DX)

1. Add unit tests for `buildThreadsFromFeed` orphan fallback and hydration replacement.
2. Add snapshot tests for novelty/interestingness/distinctiveness timelines.
3. Add typed API client wrappers for analyzer/classification endpoints.
4. Add repository-level architecture diagram + sequence diagrams.
5. Add CI workflow (`check`, `build`, targeted tests, deploy guardrails).

## 10) Agent Operating Rules for This Repo

When making changes:
1. Read relevant route + utility code first; do not rely on stale docs.
2. Prefer minimal diff and preserve current cache key semantics unless intentionally migrating.
3. Keep analyzer behavior deterministic when `FETCH='0'`.
4. After code changes, run at least:
   - `npm run check`
   - `npm run build`
5. For deploy requests, publish `.svelte-kit/cloudflare` via wrangler pages deploy.
6. Always report deploy URL and any runtime warnings that appeared during deploy.

## 11) Validation Checklist Before Release

1. Home page loads and search works.
2. Analyzer loads and can analyze a known DID.
3. No missing-binding errors for `POST_CACHE` or `AI`.
4. With `FETCH='0'`, analyzer/classifier operate in cached-only mode with clear warning.
5. Novelty/interestingness/distinctiveness timeline interactions work (scroll/sort/click).
6. Cached account list loads and remains scrollable.

