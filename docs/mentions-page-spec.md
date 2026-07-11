# `/mentions` Page Spec

Last updated: 2026-06-23

## Goal

A frontend-only SvelteKit page that:

1. Downloads one public Bluesky user's repo CAR in the browser.
2. Extracts every `app.bsky.richtext.facet#mention` from that user's posts.
3. Lists each distinct mentioned account on the left (with mention counts).
4. When a mentioned account is selected, fetches and renders the full
   threads of the repo owner's posts that mention them.

This mirrors the structure of `/followinteraction` (download repo → parse
records locally → master list on the left → detail pane on the right that
hydrates appview data for the selected entry).

## Data flow

1. `getProfile(handle)` → repo owner `ProfileInfo` (DID + author info).
2. `downloadRepoCar(did)` (`src/lib/utils/repoHydration.ts`) → CAR bytes,
   PDS-first with relay fallback, streaming download progress.
3. `parseCarRecordsWasm(carBytes)` (`src/lib/utils/carParserWasm.ts`) →
   `ParsedRepoRecord[]`.
4. `extractRepoMentions(did, records)` (new util) → `RepoMentionsSummary`.
5. `getProfiles(dids)` batched → hydrate mentioned-account handles/avatars.
6. On selection, fetch threads:
   - Group the selected user's mention posts by thread root URI
     (`record.reply.root.uri`, else the post URI itself) to avoid refetching
     the same conversation.
   - `getFullThread(rootUri)` (`src/lib/api/bluesky.ts`) per unique root,
     bounded concurrency, capped at `MAX_THREADS_PER_USER`.
   - Render each thread with `GroupChat` (`src/lib/components/GroupChat.svelte`),
     which accepts the `{ rootPost, depth, rootUri }` shape `getFullThread`
     returns.

Everything except profile hydration and thread fetches is computed locally
from the downloaded repo, matching the privacy posture of `/followinteraction`.

## New / changed files

- `src/lib/utils/repoMentions.ts` — pure extraction from parsed repo records.
- `src/lib/utils/repoMentions.test.ts` — node:test unit coverage.
- `src/routes/mentions/+page.ts` — `export const ssr = false;`.
- `src/routes/mentions/+page.svelte` — the page UI.
- `src/lib/components/RouteNav.svelte` — add `mentions` nav entry.
- `package.json` — add the new test file to the `test` script.

## `extractRepoMentions` contract

```
extractRepoMentions(ownerDid, records) => {
  ownerDid, scannedPosts, postsWithMentions, totalMentionInstances,
  uniqueMentionedUsers,
  users: Array<{
    did, mentionPostCount, mentionInstanceCount,
    firstMentionedAt, lastMentionedAt,
    posts: Array<{ uri, rootUri, parentUri, text, createdAt, isReply }>
  }>  // sorted by mentionPostCount desc, lastMentionedAt desc, did
}
```

Rules:
- Only `app.bsky.feed.post` records are scanned.
- A mention feature must carry a `did:` value; self-mentions (did === owner)
  are skipped (consistent with `cachedSummary.ts`).
- A post that mentions the same account multiple times counts once toward
  `mentionPostCount` but each occurrence adds to `mentionInstanceCount`.
- Post `uri` is rebuilt as `at://{ownerDid}/app.bsky.feed.post/{rkey}`.

## UI controls

- SearchBar (handle lookup + typeahead), `?handle=` query persistence.
- Left list: searchable + sortable (most mentions / latest / earliest / handle).
- Right detail: selected account header + fetched threads (with
  "showing N of M" when capped).
