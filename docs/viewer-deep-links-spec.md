# Viewer Deep Links Spec

Last updated: 2026-03-08

## Summary

This document defines the v1 deep-link contract for the viewer pages:

- `/`
- `/chat`
- `/board`

The feature standardizes thread-specific links on a canonical Bluesky web URL carried in `url=...`. No new server API is required.

## Goals

- make thread links portable across the three viewer pages
- let the home viewer restore and focus a specific thread without introducing a new server contract
- keep URLs human-readable
- preserve backward compatibility for existing home links

## Non-Goals

- no analyzer route changes
- no cluster route deep-link contract
- no preservation of threshold, date filter, render mode, scroll position, compare mode, or cluster camera state
- no change to `/api/posts/[did]/meta|chunk|new|older`

## Canonical URL Contract

### Thread-Specific Links

Canonical thread links use:

```text
url=https://bsky.app/profile/{handle-or-did}/post/{rkey}
```

Examples:

- `/?url=https%3A%2F%2Fbsky.app%2Fprofile%2Ffoo.bsky.social%2Fpost%2F3lxyz`
- `/chat?url=https%3A%2F%2Fbsky.app%2Fprofile%2Ffoo.bsky.social%2Fpost%2F3lxyz`
- `/board?url=https%3A%2F%2Fbsky.app%2Fprofile%2Ffoo.bsky.social%2Fpost%2F3lxyz`

### Account-Only Home Links

Home may still use:

```text
handle={handle}
```

Example:

- `/?handle=foo.bsky.social`

### Backward Compatibility

The home route must continue to read existing links shaped like:

```text
/?handle={handle}&thread={at://did/app.bsky.feed.post/rkey}
```

Behavior:

- legacy links remain readable
- newly emitted thread-specific viewer links use `url`
- new emitted account-only home links use `handle`

## Shared Utility Contract

Add one shared utility module for viewer routes.

Suggested location:

- [src/lib/utils/viewerLinks.ts](src/lib/utils/viewerLinks.ts)

Required helpers:

### `parseBskyPostUrl(url: string)`

Returns:

- `{ handle, rkey }` for valid Bluesky post URLs
- `null` for invalid inputs

Rules:

- only accept `https://bsky.app/profile/{actor}/post/{rkey}`
- ignore query strings and fragments
- trim whitespace

### `normalizeBskyPostUrl(url: string)`

Returns:

- canonical `https://bsky.app/profile/{actor}/post/{rkey}`
- `null` if invalid

Rules:

- always strip query strings and fragments
- preserve the actor segment as supplied in the valid source URL

### `buildBskyPostUrl(rootUri: string, actor?: string | null)`

Returns:

- canonical Bluesky web URL for a root AT URI
- `null` if the root URI is invalid

Rules:

- `actor` wins when present
- otherwise use the DID embedded in `rootUri`

### `buildAtUri(did: string, rkey: string)`

Returns:

- `at://{did}/app.bsky.feed.post/{rkey}`
- `null` for invalid inputs

### `buildViewerHref(page, options)`

Supported pages:

- `home`
- `chat`
- `board`

Rules:

- if `options.url` is valid, return `/{page}?url=...`
- for `home`, if no valid `url` exists but `handle` exists, return `/?handle=...`
- otherwise return the bare route

## Page Behavior

### Home `/`

#### Incoming Route Restore

Priority order:

1. `url`
2. legacy `handle + thread`
3. `handle`

#### `url` Restore Flow

1. Parse `url`.
2. Resolve the handle through `getProfile`.
3. Trigger the existing home search flow for that account.
4. Keep the canonical `url` in the address bar while loading.
5. After discovery completes:
   - if the requested root thread exists in `allThreads`, set highlight/scroll focus
   - if it does not exist in discovered results, fetch the full thread directly with `getFullThread` and open the expanded panel

#### Legacy `handle + thread` Restore Flow

1. Resolve the `handle`.
2. Convert the legacy `thread` AT URI into a canonical Bluesky web URL when possible.
3. Reuse the same logic as the `url` restore path.

#### Account-Only Restore Flow

1. Resolve `handle`
2. Run the existing account search
3. Keep `?handle=...` in the address bar

#### Home URL Emission

New emitted URLs:

- manual account search: `/?handle=...`
- thread share from list or expanded view: `/?url=...`

New emitted URLs must not include:

- `thread`
- `from`
- `to`
- render mode
- threshold

### Chat `/chat`

Behavior:

1. Continue to accept `url`
2. Use shared helper parsing instead of page-local parsing
3. Resolve handle with `getProfile`
4. Build AT URI from resolved DID + parsed `rkey`
5. Fetch `getFullThread`
6. Keep normalized `url` in the address bar

### Board `/board`

Behavior is identical to `/chat` except for the final renderer.

## Route Navigation Rules

`RouteNav` must preserve viewer context as follows:

- if an active thread `url` exists:
  - home link uses `/?url=...`
  - chat link uses `/chat?url=...`
  - board link uses `/board?url=...`
- if no thread `url` exists and a home handle exists:
  - home link uses `/?handle=...`
- analyzer link may continue to preserve `handle`
- cluster link remains plain `/cluster`

## Home Header Navigation

Replace hard-coded viewer links in the home header with navigation that uses the same shared URL builder as `RouteNav`.

Expected result:

- navigating from home to chat/board while a thread is active keeps the same `url`
- navigating back to home from chat/board keeps the same `url`

## Data And API Impact

No new endpoint is added.

The feature deliberately reuses the existing split:

- home list data comes from `/api/posts/[did]/meta|chunk|new|older`
- full-thread detail uses `getFullThread`
- chat/board continue to use direct Bluesky full-thread fetches

## Acceptance Criteria

- opening `/chat?url=...` loads the expected thread
- opening `/board?url=...` loads the expected thread
- opening `/?url=...` resolves the account and focuses the same thread automatically
- if the thread is outside the discovered feed slice, the home route opens the expanded full-thread view instead of failing silently
- switching between home/chat/board preserves the same selected thread when one is active
- new home share/copy actions emit `/?url=...`
- existing legacy `/?handle=...&thread=...` links still restore

## Manual Smoke Checklist

1. Open `/?handle=<valid handle>` and verify account-only search still works.
2. Open `/chat?url=<valid bsky post url>` and verify full-thread render.
3. Open `/board?url=<valid bsky post url>` and verify full-thread render.
4. Open `/?url=<valid bsky post url>` for a thread within the current discovered feed slice and verify scroll/highlight.
5. Open `/?url=<valid bsky post url>` for a thread outside the discovered feed slice and verify direct expanded fallback.
6. From home with an active thread, use the top navigation to open chat and board and verify the same thread remains selected.
7. Copy/share a thread from the home route and verify the copied link is `/?url=...`.
8. Open one existing legacy `/?handle=...&thread=...` link and verify it still restores.

## Testing

Add unit tests for:

- valid Bluesky post URL parsing
- invalid Bluesky post URL rejection
- root URI to Bluesky web URL generation
- AT URI generation from DID + rkey
- consistent `buildViewerHref` behavior for home/chat/board
