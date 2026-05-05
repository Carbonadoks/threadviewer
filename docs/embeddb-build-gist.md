# Build your own Bluesky semantic SQLite DB

This repo ships with a local builder that downloads one Bluesky account's post repo, extracts every non-empty text post, embeds each post with Cloudflare Workers AI, and writes the result into one self-contained SQLite file.

The command is:

```bash
npm run embeddb:build -- <handle>
```

Example:

```bash
npm run embeddb:build -- alice.bsky.social
```

## What you need

- A recent Node version with `node:sqlite` available
- `npm install`
- A Cloudflare account with Workers AI enabled
- A Cloudflare API token that can call Workers AI for your account
- Your Cloudflare account ID

## 1. Create the local env file

Copy the example file:

```bash
cp .env.cluster.local.example .env.cluster.local
```

Then fill in the two required values:

```dotenv
CLOUDFLARE_ACCOUNT_ID=your_cloudflare_account_id
CLOUDFLARE_API_TOKEN=your_cloudflare_api_token
```

The builder also accepts these alias names:

```dotenv
CLUSTER_R2_ACCOUNT_ID=your_cloudflare_account_id
CF_API_TOKEN=your_cloudflare_api_token
```

Important: `embeddb:build` does not need R2 credentials, `FETCH`, or `GEMINI_API_KEY`. Those are only for other flows in this repo.

## 2. Build a SQLite DB

Run:

```bash
npm run embeddb:build -- alice.bsky.social
```

By default this writes:

```text
output/embedding-dbs/alice.bsky.social.cf-bge-small-en-v1.5-cls.sqlite
```

What the script does:

1. Resolves the handle to a DID.
2. Downloads the account repo CAR from the PDS or relay.
3. Extracts non-empty text posts.
4. Requests embeddings from Cloudflare Workers AI using `@cf/baai/bge-small-en-v1.5` with `cls` pooling.
5. Normalizes the vectors and stores them in SQLite.

The generated file contains:

- A `meta` table with handle, DID, model, pooling, embedding dimension, timestamps, and build stats
- A `posts` table with post text, reply/thread metadata, token estimates, and the embedding blob

## 3. Useful flags

```bash
npm run embeddb:build -- alice.bsky.social --output output/alice.sqlite
npm run embeddb:build -- alice.bsky.social --concurrency 6
npm run embeddb:build -- alice.bsky.social --batch-size 100
npm run embeddb:build -- alice.bsky.social --limit 500
npm run embeddb:build -- alice.bsky.social --force
npm run embeddb:build -- alice.bsky.social --env-file .env.cluster.local
```

Available options:

- `--output <path>`: custom output SQLite path
- `--env-file <path>`: load a different env file first
- `--batch-size <n>`: Workers AI batch size, max `100`
- `--concurrency <n>`: number of concurrent embedding requests
- `--limit <n>`: only embed the first `n` text posts after sorting
- `--force`: overwrite an existing output file

Tip: use `--limit 250` or `--limit 500` for a quick smoke test before running a full account.

## 4. Use the DB in this app

You have two easy options:

### Option A: open it directly in `/semantic`

Go to the Semantic page and use the local file picker. The page can load a local `.sqlite` file in the browser without uploading it first.

### Option B: upload it to the app's R2 bucket

If you want the file to appear in the `/semantic` sidebar automatically, upload it into the same `POST_CACHE` bucket under:

```text
output/embedding-dbs/<filename>.sqlite
```

That is the prefix the app scans when listing semantic DB files.

## 5. Troubleshooting

### Missing config error

If you see:

```text
Missing required config: CLOUDFLARE_ACCOUNT_ID or CLUSTER_R2_ACCOUNT_ID
```

or

```text
Missing required config: CLOUDFLARE_API_TOKEN or CF_API_TOKEN
```

then your `.env.cluster.local` file is missing one of the two required values.

### Output already exists

Use:

```bash
npm run embeddb:build -- alice.bsky.social --force
```

### No posts found

The builder only keeps non-empty text posts. Accounts with only media, reposts, or empty records may produce no rows.

### Workers AI rate limits

Lower `--concurrency` and retry. The builder already retries transient `408`, `409`, `425`, `429`, `500`, `502`, `503`, and `504` responses with exponential backoff.

## One-line quickstart

```bash
npm install && cp .env.cluster.local.example .env.cluster.local && npm run embeddb:build -- alice.bsky.social
```
