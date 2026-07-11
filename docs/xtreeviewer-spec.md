# xtreeviewer — X.com thread capture + tree viewing

Status: PLAN (not implemented)
Last updated: 2026-07-08

Goal: a `/xtreeviewer` page that lets the user load a full X.com (Twitter) thread —
using their existing logged-in X session in the same browser — and view it with the
existing `/treeviewer` tree/forum/chat UI.

## 1) Why the iframe / hidden-window idea does not work

The original idea was: open the X thread in an iframe or hidden window and scrape it
from our page. Three browser-level walls make this impossible:

1. **Framing is blocked.** x.com responds with CSP `frame-ancestors 'self'`
   (plus `X-Frame-Options`), so the browser refuses to render x.com inside an iframe
   on our origin at all.
2. **Cross-origin windows are opaque.** Even with `window.open('https://x.com/...')`,
   the same-origin policy means we cannot read the popup's DOM, intercept its network
   traffic, or execute script in it. All we can do is navigate/close it.
3. **Cookies don't travel.** A `fetch('https://x.com/i/api/...')` from our origin is
   blocked by CORS, and X's session cookies are not attached to cross-site requests
   anyway (SameSite). Being "logged in to X" in the browser is invisible to our origin.

Conclusion: the only way to use the existing session is to run code **on x.com's own
origin**. Without shipping a browser extension, that means a user-executed snippet
(DevTools console paste, or bookmarklet where CSP allows it).

## 2) Options considered for data acquisition

| Option | Auth | Completeness | Effort | Verdict |
|---|---|---|---|---|
| A. Grabber snippet run in the X tab (console/bookmarklet), calls X internal GraphQL | user's own session | full thread incl. cursors | medium | **chosen** |
| B. Browser extension (MV3 content script) | user's own session | full | high (separate artifact, store install) | later, if A proves out |
| C. Server-side fetch with user-pasted `auth_token`+`ct0` cookies | pasted creds | full | medium | rejected: storing session creds server-side is a bad trade |
| D. FixupX / fxtwitter public API (`api.fxtwitter.com`) | none | single tweet only, no reply tree | low | useful as enrichment only |
| E. Official X API v2 | paid app token | thread via search/conversation_id | low code, $$$ | rejected: paid, rate-capped |
| F. Paste raw HAR / copied DOM | none | fragile | low | fallback of last resort |

## 3) Chosen design: grabber snippet + handoff to /xtreeviewer

### 3.1 Flow

1. User opens `/xtreeviewer`, pastes an X thread URL (or is told to just navigate to
   the thread on x.com).
2. Page offers **"Copy grabber script"** and instructions:
   open the thread on x.com → open DevTools console → paste → Enter.
3. The snippet (running on x.com, same-origin, fully authenticated) collects the whole
   thread (see 3.2) and hands it back (see 3.3).
4. `/xtreeviewer` validates the payload, converts it to the existing
   `ThreadPost`/`SelfReplyThread` shape, writes it into the existing IndexedDB
   `threadContentCache` keyed by the canonical `https://x.com/{handle}/status/{id}`
   URL, then navigates to `/treeviewer?url=<that url>`.
5. `/treeviewer` gets a small change: URLs recognized by the existing
   `parseXStatusUrl` (`src/lib/api/x.ts`) are loaded **cache-only** (skip the
   Bluesky handle-resolution + `getFullThread` revalidation path). If no cached
   entry exists, show an error linking to `/xtreeviewer`.

### 3.2 What the snippet does on x.com

The X web app itself loads threads through
`GET /i/api/graphql/{queryId}/TweetDetail?variables=...&features=...`.
Both `queryId` and the required `features` flag set change with X deployments —
hardcoding them is the usual failure mode of scrapers. We avoid that:

1. **Capture the app's own request instead of forging one.**
   Since the user is standing on the thread page, the page has already issued a
   `TweetDetail` request. `performance.getEntriesByType('resource')` exposes its full
   URL including the query string. The snippet takes the most recent
   `/graphql/*/TweetDetail` entry and reuses its `queryId` and exact `features`
   object verbatim, swapping only `variables` (focal tweet id + cursor).
   Fallbacks, in order: regex-scan already-loaded JS bundles for
   `queryId:"...",operationName:"TweetDetail"`; finally a hardcoded last-known id.
2. **Auth headers** (standard for X web internal API, same-origin request with
   `credentials: 'include'`):
   - `authorization: Bearer <public web-app bearer token>` (the constant token every
     x.com visitor uses; not a secret)
   - `x-csrf-token: <ct0 cookie value>`
   - `content-type: application/json`
3. **Walk the conversation.**
   - Determine the focal status id from `location.pathname` (or the id embedded in
     the copied script).
   - Fetch `TweetDetail`, parse `threaded_conversation_with_injections_v2`
     instructions → entries → tweet results. Handle both `Tweet` and
     `TweetWithVisibilityResults` shapes, and both legacy (`legacy.screen_name`) and
     2025+ (`core.screen_name`) user layouts.
   - Follow cursors breadth-first: bottom cursor ("Show more replies") and
     per-conversation-module "Show more" cursors are all just `TweetDetail` calls
     with `variables.cursor` set.
   - Also fetch `TweetDetail` for the true root if the focal tweet is mid-thread
     (the first page includes ancestors, so usually free).
   - Bounds: max ~60 requests, 350ms spacing, stop early on HTTP 429 and report
     partial capture (rate limit budget for TweetDetail is roughly 150/15min).
4. **Extract per tweet:** `id`, `parentId` (`in_reply_to_status_id_str`), author
   (`userId`, `handle`, `displayName`, `avatar`), full text with `t.co` links
   expanded from `entities.urls`, `createdAt` (ISO), counts (likes, retweets,
   replies, quotes, views), media (`photo`/`video`/`animated_gif` with
   `pbs.twimg.com` thumb + fullsize + alt), and quoted-status id if present.

### 3.3 Handoff back to our page

Payload (versioned):

```json
{
  "type": "xtreeviewer:thread",
  "version": 1,
  "capturedAt": "2026-07-08T...Z",
  "focusId": "1234567890",
  "partial": false,
  "tweets": [ { "id", "parentId", "userId", "handle", "name", "avatar",
                "text", "createdAt", "likes", "retweets", "replies", "quotes",
                "views", "media": [{ "type", "url", "thumb", "alt" }],
                "quotedId" } ]
}
```

Delivery, tried in order by the snippet:

1. **`window.opener.postMessage(payload, <our origin>)`** — works when the user
   opened the X tab via the "Open on X" button on `/xtreeviewer` **and** x.com's
   COOP header hasn't severed the opener link (X has shipped
   `Cross-Origin-Opener-Policy` intermittently; cannot be relied on).
   `/xtreeviewer` listens for `message` events and accepts only
   `event.origin ∈ {https://x.com, https://twitter.com, https://mobile.twitter.com}`
   with a well-formed v1 payload.
2. **Clipboard fallback (always available):** `copy(JSON)` / `navigator.clipboard`,
   then the user pastes into a textarea on `/xtreeviewer`. This path always works,
   so it is the documented default; postMessage is a nice-to-have accelerator.

The snippet is generated per-session by `buildXGrabberScript(targetOrigin)` so the
postMessage target origin is baked in (no wildcard).

### 3.4 Conversion to viewer model (`src/lib/utils/xTreeThread.ts`)

- `ThreadPost.uri` = canonical `https://x.com/{handle}/status/{id}` (unique, clickable).
- `author.did` = `x:{userId}`, `handle`/`displayName`/`avatar` direct.
- `embed.images` from photo media (pbs.twimg.com hotlinks fine); video → external link.
- Build tree by `parentId`; tweets whose parent wasn't captured attach under the
  nearest captured ancestor is NOT attempted — they become the root only if nothing
  else qualifies; otherwise dropped with a count reported in the UI.
- Output `SelfReplyThread { rootPost, rootUri, depth }` → `writeCachedThread`.

### 3.5 Treeviewer integration cost (kept minimal)

- `loadThread` gains an early branch: `parseXStatusUrl` hit → cache-only load.
- Bluesky-only affordances (quote lanes, profile fetch) will simply no-op/error
  gracefully for `x.com` URIs; v1 does not port them.
- New RouteNav entry: `{ id: 'xtreeviewer', href: '/xtreeviewer', label: 'X Treeviewer', compactLabel: 'X Tree' }`.

## 4) Risks / open questions

1. **GraphQL schema drift** — mitigated by replaying the app's own captured request;
   parser handles the two known user-object layouts; payload versioning lets us
   iterate.
2. **Rate limiting on huge threads** — bounded request budget, partial-capture flag,
   UI banner ("captured N of ~M replies").
3. **Bookmarklet CSP** — x.com CSP may block `javascript:` bookmarklets in some
   browsers; console paste (with Chrome's one-time "allow pasting") is the
   documented path.
4. **ToS note** — this reads only content the logged-in user can already see, at
   human scale, for personal viewing. No credentials ever leave the user's browser;
   nothing is sent to our server (capture → IndexedDB only).
5. **COOP severing `window.opener`** — clipboard path is the guaranteed fallback.

## 5) Implementation checklist (next step)

1. `docs/xtreeviewer-spec.md` (this file).
2. `src/lib/utils/xTreeThread.ts` — payload schema/validation + conversion; unit tests
   in `src/lib/utils/xTreeThread.test.ts` (add to `npm test` list).
3. `src/lib/utils/xGrabberScript.ts` — `buildXGrabberScript(targetOrigin)`.
4. `src/routes/xtreeviewer/+page.ts` (`ssr = false`) + `+page.svelte` — URL input,
   copy-script button, instructions, postMessage listener, paste box, recent X threads.
5. `src/routes/treeviewer/+page.svelte` — X-URL cache-only branch in `loadThread`.
6. `RouteNav.svelte` entry.
7. Validate: `npm run check`, `npm run build`, `npm test`.
