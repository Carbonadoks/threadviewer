# Thread Viewer

Thread Viewer is a completely vibecoded SvelteKit app for exploring Bluesky posts, threads, cached account feeds, and embedding-backed thread analysis.

It started as an experimental Bluesky thread toy and grew into a small pile of visual surfaces:

- discover long self-reply chains from an account feed
- render a Bluesky thread as chat
- render a Bluesky thread as a board
- inspect cached thread-analysis clusters
- browse cached global cluster/toponomy snapshots
- play with a few extra visual experiments that may or may not behave like respectable software

This is not a polished product. It is a vibecoded research/workbench app, so expect sharp edges, odd routes, and features that assume the author's cache/deployment setup.

## Stack

- SvelteKit 2 and Svelte 5
- Vite
- Cloudflare Pages / Workers
- Cloudflare R2 for cached posts and generated artifacts
- Cloudflare Workers AI for embeddings
- Optional Gemini API key for semantic labels
- Bluesky public APIs for profile and thread fetches

## Local Setup

Install dependencies:

```sh
npm install
```

Run the dev server:

```sh
npm run dev
```

Then open the local URL Vite prints, usually:

```text
http://localhost:5173
```

Useful checks:

```sh
npm run check
npm run test
npm run build
```

## Environment

Most basic Bluesky thread viewing works without private keys because the app can call public Bluesky APIs from the browser.

The cache, analyzer, cluster, and embedding tools need Cloudflare bindings or local credentials.

For local embedding/database build scripts, copy the example env file:

```sh
cp .env.cluster.local.example .env.cluster.local
```

Then fill in:

```text
CLOUDFLARE_ACCOUNT_ID=...
CLOUDFLARE_API_TOKEN=...
```

Optional values used by other scripts:

```text
CLUSTER_R2_ACCESS_KEY_ID=...
CLUSTER_R2_SECRET_ACCESS_KEY=...
CLUSTER_R2_BUCKET=thread-viewer-cache
FETCH=1
GEMINI_API_KEY=...
```

Set `FETCH=0` when you want server-side fallback paths to avoid live network fetches and live AI/classification calls. Cached data can still be served when present.

Do not commit `.env.cluster.local`.

## Cloudflare Setup

The app is configured for Cloudflare Pages with `@sveltejs/adapter-cloudflare`.

`wrangler.jsonc` expects:

- an R2 bucket binding named `POST_CACHE`
- an R2 bucket named `thread-viewer-cache`
- a Workers AI binding named `AI`

The important binding shape is:

```jsonc
{
  "r2_buckets": [
    {
      "binding": "POST_CACHE",
      "bucket_name": "thread-viewer-cache"
    }
  ],
  "ai": {
    "binding": "AI"
  }
}
```

## Scripts

Development and validation:

```sh
npm run dev
npm run check
npm run test
npm run build
```

Snapshot and embedding helpers:

```sh
npm run cluster:build
npm run toponomy:build
npm run elephant:build
npm run embeddb:build -- <handle>
npm run thread-embeddb:build -- <handle>
npm run window-embeddb:build -- <handle>
```

The build scripts are more environment-sensitive than the viewer routes. If something fails there, check `.env.cluster.local`, Cloudflare access, and whether `FETCH` is set.

## Routes

Common entry points:

- `/` - account self-reply thread discovery
- `/chat?url=<bsky-post-url>` - full thread as chat
- `/board?url=<bsky-post-url>` - full thread as board
- `/analyzer?handle=<handle>` - cached embedding analysis for one account
- `/cluster` - cached global cluster atlas
- `/toponomy` - cached toponomy view

There are also experimental routes in `src/routes`. Some are half workbench, half fever dream. That is part of the deal.

## Notes For Contributors

- This repo intentionally ignores local caches, generated output, build folders, R2 dumps, and secrets.
- Keep `.env*` files private unless they are examples with placeholder values.
- The app has a mix of serious tools and experiments. Prefer small, focused changes.
- If you are making open-source cleanup changes, run a secret scan before pushing.

## License

The package currently declares `ISC` in `package.json`.
