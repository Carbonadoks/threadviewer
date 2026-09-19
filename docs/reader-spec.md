# /reader — atproto blog reader

Enter a handle/DID (or `at://`, bsky.app profile, pds.ls URL) and read every
blog-like record in that repo as a simple blog, styled like `/blog`.

URL state: `/reader?handle={handle}` (index) and `&post={collection}/{rkey}` (article).

## Files

- `src/lib/utils/atprotoBlog.ts` — pure mapping: block model, facets, markdown,
  HTML, BlockNote, block unions, per-lexicon adapters, heuristics, dedup.
- `src/lib/utils/atprotoBlogLoader.ts` — identity → PDS → `describeRepo` →
  `listRecords` per collection; resolves GreenGale `contentRef`s.
- `src/lib/components/ReaderBlocks.svelte` — recursive renderer (never `{@html}`).
- `src/routes/reader/+page.svelte` — index + article views.

## Lexicon mapping

| Collection | Adapter | Body |
|---|---|---|
| `site.standard.document` | `standardDocumentToPost` | `content` open union (below), fallback `textContent` |
| `site.standard.publication`, `pub.leaflet.publication` | `recordToPublication` | blog name/description/icon; `url + path` = canonical URL |
| `pub.leaflet.document` | `leafletDocumentToPost` | `pages[].blocks[]` |
| `com.whtwnd.blog.entry` | `whiteWindToPost` | markdown `content`, `visibility` |
| `app.greengale.document` | `greenGaleToPost` | markdown `content`, `url + path` |
| `social.pipup.blog.entry` | `pipupToPost` | markdown `content`, `visibility` |
| anything else | `scoreCollection` + `heuristicRecordToPost` | longest of content/body/markdown/text/… |

`site.standard.document#content` union handled by `contentToBlocks`:
`pub.leaflet.content` (pages), `blog.pckt.content` / `app.offprint.content`
(items), `at.markpub.markdown`, `app.blento.markdown`, `org.wordpress.html`,
`at.unthread.content` (link to root post), `app.greengale.document#contentRef`
(fetched), raw BlockNote arrays, and any unknown object with
`plaintext`/`text`/`markdown`.

Block unions dispatch on the `$type` suffix (`text`, `header|heading`,
`blockquote`, `unorderedList|bulletList|orderedList|taskList`, `image`,
`website`, `iframe`, `bskyPost|blueskyEmbed`, `code|codeBlock|math`,
`horizontalRule`, `button`), so Leaflet, pckt and Offprint share one path.
Facets use byte offsets; features match by `#suffix` (bold, italic, code,
strikethrough, underline, highlight, link, didMention, atMention, tag).

## Heuristics

- Ignored: `app.bsky.*`, `chat.bsky.*`, `com.atproto.*`, `site.standard.*`
  non-documents, `blog.pckt.document` (strongRef pointer), and social-graph-ish
  suffixes (like/follow/profile/…).
- Sample 10 records. A collection is a blog if ≥50% have a body ≥ 400 chars
  (≥ 120 when the NSID contains blog/post/entry/article/document/note/…) and
  most have a title (or bodies are very long). Posts < 80 chars are dropped.
- Title fallback: first line of body. Date fallback: TID rkey timestamp.
- Records with `visibility` in author/private/draft/url/unlisted are hidden.
- Dedup mirrors (Leaflet + standard.site, GreenGale + standard.site) by
  `rkey+title` or `title+day`, keeping the longest/richest copy.
