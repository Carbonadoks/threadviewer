import { AtpAgent } from '@atproto/api';
import { CarReader } from '@ipld/car';
import * as dagCbor from '@ipld/dag-cbor';
import { createHash } from 'node:crypto';
import { access, mkdir, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { createInterface } from 'node:readline/promises';
import { DatabaseSync } from 'node:sqlite';
import { parseCarPosts, type ParsedPost } from '../src/lib/utils/carParser';
import { resolvePds } from '../src/lib/utils/pdsResolver';

const PROFILE_API = 'https://public.api.bsky.app';
const EMBEDDING_MODEL = '@cf/baai/bge-small-en-v1.5';
const EMBEDDING_POOLING = 'cls';
const EMBEDDING_NAMESPACE = 'cf-bge-small-en-v1.5-cls';
const EMBEDDING_MAX_BATCH_SIZE = 100;
const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_CONCURRENCY = 4;
const DEFAULT_ENV_PATH = path.resolve(process.cwd(), '.env.cluster.local');
const DEFAULT_OUTPUT_DIR = path.resolve(process.cwd(), 'output', 'embedding-dbs');
const SCHEMA_VERSION = 1;
const RUN_ENDPOINT_BASE = 'https://api.cloudflare.com/client/v4/accounts';
const RETRYABLE_STATUSES = new Set([408, 409, 425, 429, 500, 502, 503, 504]);
const MAX_EMBED_RETRIES = 5;
const RETRY_BASE_DELAY_MS = 800;

type EnvMap = Record<string, string>;

type CliOptions = {
	handle: string | null;
	outputPath: string | null;
	envPath: string;
	batchSize: number;
	concurrency: number;
	limit: number | null;
	force: boolean;
};

type ProfileInfo = {
	did: string;
	handle: string;
	displayName?: string;
	avatar?: string;
	postsCount: number;
};

type RepoDownloadResult = {
	carBytes: Uint8Array;
	downloadedBytes: number;
	totalBytes: number;
	elapsedMs: number;
	source: 'pds' | 'relay';
};

type TextPostRecord = {
	uri: string;
	rkey: string;
	cid: string;
	text: string;
	createdAt: string;
	parentUri: string | null;
	threadRootUri: string;
	isReply: boolean;
	charLength: number;
	byteLength: number;
	tokenEstimate: number;
};

type EmbedBatchResult = {
	vectors: number[][];
	shape?: number[];
	pooling?: string;
};

function usage(): string {
	return [
		'Build a self-contained SQLite DB of Bluesky post text + Cloudflare BGE embeddings.',
		'',
		'Quick start:',
		'  cp .env.cluster.local.example .env.cluster.local',
		'  npm run embeddb:build -- alice.bsky.social',
		'',
		'Usage:',
		'  node --import tsx scripts/build-post-embedding-db.ts <handle> [options]',
		'  npm run embeddb:build -- <handle> [options]',
		'',
		'Options:',
		'  --output <path>         Output SQLite path',
		'  --env-file <path>       Optional env file to load first',
		'  --batch-size <n>        Cloudflare batch size (default: 100, max: 100)',
		'  --concurrency <n>       Concurrent embedding requests (default: 4)',
		'  --limit <n>             Embed only the first n text posts after sorting',
		'  --force                 Overwrite an existing output file',
		'  --help                  Show this help',
		'',
		'Required env:',
		'  CLOUDFLARE_API_TOKEN or CF_API_TOKEN',
		'  CLOUDFLARE_ACCOUNT_ID or CLUSTER_R2_ACCOUNT_ID',
		'',
		'Example:',
		'  npm run embeddb:build -- alice.bsky.social --output output/alice.sqlite --concurrency 6'
	].join('\n');
}

function parseEnvFile(text: string): EnvMap {
	const env: EnvMap = {};
	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith('#')) continue;
		const separatorIndex = line.indexOf('=');
		if (separatorIndex <= 0) continue;
		const key = line.slice(0, separatorIndex).trim();
		let value = line.slice(separatorIndex + 1).trim();
		if (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		) {
			value = value.slice(1, -1);
		}
		env[key] = value;
	}
	return env;
}

async function loadLocalEnv(envPath: string): Promise<EnvMap> {
	try {
		return parseEnvFile(await readFile(envPath, 'utf8'));
	} catch (error: any) {
		if (error?.code === 'ENOENT') {
			return {};
		}
		throw error;
	}
}

function readConfigValue(localEnv: EnvMap, keys: string[], fallback = ''): string {
	for (const key of keys) {
		const processValue = process.env[key]?.trim();
		if (processValue) return processValue;
		const localValue = localEnv[key]?.trim();
		if (localValue) return localValue;
	}
	return fallback;
}

function requireConfig(localEnv: EnvMap, keys: string[]): string {
	const value = readConfigValue(localEnv, keys);
	if (!value) {
		throw new Error(`Missing required config: ${keys.join(' or ')}`);
	}
	return value;
}

function parsePositiveInteger(value: string, flagName: string): number {
	const parsed = Number.parseInt(value, 10);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		throw new Error(`${flagName} must be a positive integer.`);
	}
	return parsed;
}

function parseCliArgs(argv: string[]): CliOptions {
	let handle: string | null = null;
	let outputPath: string | null = null;
	let envPath = DEFAULT_ENV_PATH;
	let batchSize = DEFAULT_BATCH_SIZE;
	let concurrency = DEFAULT_CONCURRENCY;
	let limit: number | null = null;
	let force = false;

	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		if (arg === '--help' || arg === '-h') {
			console.log(usage());
			process.exit(0);
		}
		if (arg === '--output') {
			outputPath = argv[++index] ?? '';
			if (!outputPath) throw new Error('--output requires a value.');
			continue;
		}
		if (arg === '--env-file') {
			envPath = argv[++index] ?? '';
			if (!envPath) throw new Error('--env-file requires a value.');
			continue;
		}
		if (arg === '--batch-size') {
			batchSize = parsePositiveInteger(argv[++index] ?? '', '--batch-size');
			continue;
		}
		if (arg === '--concurrency') {
			concurrency = parsePositiveInteger(argv[++index] ?? '', '--concurrency');
			continue;
		}
		if (arg === '--limit') {
			limit = parsePositiveInteger(argv[++index] ?? '', '--limit');
			continue;
		}
		if (arg === '--force') {
			force = true;
			continue;
		}
		if (arg.startsWith('-')) {
			throw new Error(`Unknown flag: ${arg}`);
		}
		if (!handle) {
			handle = arg;
			continue;
		}
		throw new Error(`Unexpected argument: ${arg}`);
	}

	return {
		handle,
		outputPath,
		envPath: path.resolve(process.cwd(), envPath),
		batchSize: Math.min(batchSize, EMBEDDING_MAX_BATCH_SIZE),
		concurrency,
		limit,
		force
	};
}

function normalizeHandle(handle: string): string {
	return handle.replace(/^@/, '').trim();
}

async function promptForHandle(): Promise<string> {
	const rl = createInterface({
		input: process.stdin,
		output: process.stdout
	});
	try {
		return normalizeHandle(await rl.question('Bluesky handle: '));
	} finally {
		rl.close();
	}
}

function sanitizeHandleForFilename(handle: string): string {
	return handle.replace(/[^a-z0-9._-]+/gi, '_');
}

function defaultOutputPath(handle: string): string {
	return path.join(
		DEFAULT_OUTPUT_DIR,
		`${sanitizeHandleForFilename(handle)}.${EMBEDDING_NAMESPACE}.sqlite`
	);
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatDuration(ms: number): string {
	if (ms < 1000) return `${Math.round(ms)}ms`;
	return `${(ms / 1000).toFixed(1)}s`;
}

function formatRate(count: number, elapsedMs: number, unitLabel: string): string {
	if (elapsedMs <= 0) return `0 ${unitLabel}/s`;
	return `${(count / (elapsedMs / 1000)).toFixed(1)} ${unitLabel}/s`;
}

function normalizePostText(text: string): string {
	return text.replace(/\r\n/g, '\n').trim();
}

function estimateTokens(text: string): number {
	return Math.max(1, Math.ceil(Buffer.byteLength(text, 'utf8') / 4));
}

function safeIsoDate(value: unknown): string {
	if (typeof value === 'string' && value.trim()) {
		return value.trim();
	}
	return new Date().toISOString();
}

function comparePosts(a: TextPostRecord, b: TextPostRecord): number {
	const aTime = new Date(a.createdAt).getTime();
	const bTime = new Date(b.createdAt).getTime();
	if (Number.isFinite(aTime) && Number.isFinite(bTime) && aTime !== bTime) {
		return aTime - bTime;
	}
	return a.uri.localeCompare(b.uri);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeVector(values: number[]): number[] {
	const magnitude = Math.hypot(...values);
	if (!Number.isFinite(magnitude) || magnitude === 0) {
		return values.map(() => 0);
	}
	return values.map((value) => value / magnitude);
}

function vectorToBlob(values: number[]): Buffer {
	const normalized = Float32Array.from(normalizeVector(values));
	return Buffer.from(normalized.buffer.slice(0));
}

function sha256Hex(bytes: Uint8Array): string {
	return createHash('sha256').update(bytes).digest('hex');
}

async function resolveProfile(handle: string): Promise<ProfileInfo> {
	const agent = new AtpAgent({ service: PROFILE_API });
	const response = await agent.getProfile({ actor: handle });
	return {
		did: response.data.did,
		handle: response.data.handle,
		displayName: response.data.displayName,
		avatar: response.data.avatar,
		postsCount: response.data.postsCount ?? 0
	};
}

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) {
		throw new DOMException('Aborted', 'AbortError');
	}
}

async function downloadRepoCar(
	did: string,
	signal?: AbortSignal
): Promise<RepoDownloadResult> {
	const query = new URLSearchParams({
		did,
		collection: 'app.bsky.feed.post'
	});
	const headers = {
		Accept: 'application/vnd.ipld.car'
	};
	const startTime = performance.now();
	const pdsEndpoint = await resolvePds(did);
	let response: Response | null = null;
	let source: 'pds' | 'relay' = 'relay';

	throwIfAborted(signal);

	if (pdsEndpoint) {
		try {
			const pdsResponse = await fetch(
				`${pdsEndpoint}/xrpc/com.atproto.sync.getRepo?${query.toString()}`,
				{
					headers,
					signal
				}
			);
			if (pdsResponse.ok) {
				response = pdsResponse;
				source = 'pds';
			}
		} catch {
			// Fall back to relay.
		}
	}

	if (!response) {
		response = await fetch(
			`https://bsky.network/xrpc/com.atproto.sync.getRepo?${query.toString()}`,
			{
				headers,
				signal
			}
		);
		source = 'relay';
	}

	if (!response.ok) {
		const errorText = await response.text().catch(() => 'Unknown error');
		throw new Error(`Repository download failed (${response.status}): ${errorText}`);
	}

	const totalBytes = Number.parseInt(response.headers.get('content-length') || '0', 10);
	const reader = response.body?.getReader();
	if (!reader) {
		throw new Error('Repository response body is not readable.');
	}

	const chunks: Uint8Array[] = [];
	let downloadedBytes = 0;
	let lastLogAt = performance.now();

	while (true) {
		throwIfAborted(signal);
		const { done, value } = await reader.read();
		if (done) break;
		chunks.push(value);
		downloadedBytes += value.length;

		const now = performance.now();
		if (now - lastLogAt >= 500) {
			const totalText = totalBytes > 0 ? ` / ${formatBytes(totalBytes)}` : '';
			console.log(
				`Downloaded ${formatBytes(downloadedBytes)}${totalText} from ${source.toUpperCase()}...`
			);
			lastLogAt = now;
		}
	}

	const carBytes = new Uint8Array(downloadedBytes);
	let offset = 0;
	for (const chunk of chunks) {
		carBytes.set(chunk, offset);
		offset += chunk.length;
	}

	return {
		carBytes,
		downloadedBytes,
		totalBytes,
		elapsedMs: Math.round(performance.now() - startTime),
		source
	};
}

async function parseTextPostsFromCar(
	did: string,
	carBytes: Uint8Array
): Promise<TextPostRecord[]> {
	console.log('Parsing CAR and extracting text posts...');
	const parsedPosts = await parseCarPosts(
		carBytes,
		{
			CarReader,
			dagCbor
		},
		(count) => {
			if (count > 0 && count % 5000 === 0) {
				console.log(`Parsed ${count.toLocaleString()} repo posts...`);
			}
		}
	);

	return normalizeTextPosts(did, parsedPosts);
}

function normalizeTextPosts(did: string, posts: ParsedPost[]): TextPostRecord[] {
	const recordsByUri = new Map<string, TextPostRecord>();

	for (const post of posts) {
		const record = post.record;
		const text = normalizePostText(typeof record?.text === 'string' ? record.text : '');
		if (!text) continue;

		const uri = `at://${did}/app.bsky.feed.post/${post.rkey}`;
		const parentUri =
			typeof record?.reply?.parent?.uri === 'string' ? record.reply.parent.uri : null;
		const explicitRootUri =
			typeof record?.reply?.root?.uri === 'string' ? record.reply.root.uri : null;
		const threadRootUri = explicitRootUri || uri;
		const byteLength = Buffer.byteLength(text, 'utf8');
		recordsByUri.set(uri, {
			uri,
			rkey: post.rkey,
			cid: post.cid,
			text,
			createdAt: safeIsoDate(record?.createdAt),
			parentUri,
			threadRootUri,
			isReply: Boolean(parentUri),
			charLength: text.length,
			byteLength,
			tokenEstimate: estimateTokens(text)
		});
	}

	return [...recordsByUri.values()].sort(comparePosts);
}

function chunk<T>(items: T[], size: number): T[][] {
	if (size <= 0) return [items];
	const chunks: T[][] = [];
	for (let index = 0; index < items.length; index += size) {
		chunks.push(items.slice(index, index + size));
	}
	return chunks;
}

function summarizeApiError(payload: any, status: number): string {
	const candidate =
		typeof payload?.errors?.[0]?.message === 'string'
			? payload.errors[0].message
			: typeof payload?.result?.error === 'string'
				? payload.result.error
				: typeof payload?.error === 'string'
					? payload.error
					: typeof payload?.message === 'string'
						? payload.message
						: '';
	return candidate ? `Cloudflare AI error (${status}): ${candidate}` : `Cloudflare AI error (${status}).`;
}

async function requestEmbeddings(
	accountId: string,
	apiToken: string,
	texts: string[],
	signal?: AbortSignal
): Promise<EmbedBatchResult> {
	const response = await fetch(
		`${RUN_ENDPOINT_BASE}/${accountId}/ai/run/${EMBEDDING_MODEL}`,
		{
			method: 'POST',
			headers: {
				Authorization: `Bearer ${apiToken}`,
				'Content-Type': 'application/json'
			},
			body: JSON.stringify({
				text: texts,
				pooling: EMBEDDING_POOLING
			}),
			signal
		}
	);

	const payload = await response.json().catch(() => null);
	if (!response.ok) {
		throw Object.assign(new Error(summarizeApiError(payload, response.status)), {
			status: response.status
		});
	}

	const result = payload?.result ?? payload;
	const vectors = Array.isArray(result?.data) ? result.data : null;
	if (!vectors || vectors.some((vector: unknown) => !Array.isArray(vector))) {
		throw new Error('Workers AI did not return a valid embedding payload.');
	}

	return {
		vectors: vectors as number[][],
		shape: Array.isArray(result?.shape) ? result.shape : undefined,
		pooling: typeof result?.pooling === 'string' ? result.pooling : undefined
	};
}

async function requestEmbeddingsWithRetry(
	accountId: string,
	apiToken: string,
	texts: string[],
	signal?: AbortSignal
): Promise<EmbedBatchResult> {
	for (let attempt = 0; attempt <= MAX_EMBED_RETRIES; attempt++) {
		try {
			return await requestEmbeddings(accountId, apiToken, texts, signal);
		} catch (error: any) {
			throwIfAborted(signal);
			const status = Number(error?.status);
			const retryable =
				RETRYABLE_STATUSES.has(status) ||
				/network|fetch|timeout|temporary/i.test(error?.message || '');
			if (!retryable || attempt >= MAX_EMBED_RETRIES) {
				throw error;
			}
			const delayMs = RETRY_BASE_DELAY_MS * 2 ** attempt;
			console.warn(
				`Embedding batch retry ${attempt + 1}/${MAX_EMBED_RETRIES} after ${delayMs}ms (${error?.message || 'unknown error'}).`
			);
			await sleep(delayMs);
		}
	}

	throw new Error('Workers AI embedding retries exhausted.');
}

function ensureOutputDoesNotExist(outputPath: string, force: boolean): Promise<void> {
	if (force) {
		return rm(outputPath, { force: true });
	}
	return access(outputPath)
		.then(() => {
			throw new Error(`Output already exists: ${outputPath} (pass --force to overwrite)`);
		})
		.catch((error: any) => {
			if (error?.code === 'ENOENT') return;
			throw error;
		});
}

function upsertMeta(db: DatabaseSync, key: string, value: string): void {
	db.prepare(
		`
			INSERT INTO meta (key, value)
			VALUES (?, ?)
			ON CONFLICT(key) DO UPDATE SET value = excluded.value
		`
	).run(key, value);
}

function initializeDatabase(db: DatabaseSync): void {
	db.exec(`
		PRAGMA journal_mode = DELETE;
		PRAGMA synchronous = OFF;
		PRAGMA temp_store = MEMORY;

		CREATE TABLE IF NOT EXISTS meta (
			key TEXT PRIMARY KEY,
			value TEXT NOT NULL
		);

		CREATE TABLE IF NOT EXISTS posts (
			id INTEGER PRIMARY KEY,
			uri TEXT NOT NULL UNIQUE,
			did TEXT NOT NULL,
			handle TEXT NOT NULL,
			rkey TEXT NOT NULL,
			cid TEXT NOT NULL,
			created_at TEXT NOT NULL,
			parent_uri TEXT,
			thread_root_uri TEXT NOT NULL,
			is_reply INTEGER NOT NULL,
			text TEXT NOT NULL,
			char_length INTEGER NOT NULL,
			byte_length INTEGER NOT NULL,
			token_estimate INTEGER NOT NULL,
			embedding_dim INTEGER NOT NULL,
			embedding_f32 BLOB NOT NULL
		);
	`);
}

function finalizeDatabase(db: DatabaseSync): void {
	db.exec(`
		CREATE INDEX IF NOT EXISTS posts_created_at_idx ON posts (created_at);
		CREATE INDEX IF NOT EXISTS posts_thread_root_uri_idx ON posts (thread_root_uri);
		CREATE INDEX IF NOT EXISTS posts_parent_uri_idx ON posts (parent_uri);
		ANALYZE;
	`);
}

async function buildEmbeddingDb(
	profile: ProfileInfo,
	outputPath: string,
	options: {
		accountId: string;
		apiToken: string;
		batchSize: number;
		concurrency: number;
		limit: number | null;
		force: boolean;
		signal?: AbortSignal;
	}
): Promise<void> {
	const { accountId, apiToken, batchSize, concurrency, limit, force, signal } = options;

	console.log(`Resolving repo for ${profile.handle} (${profile.did})...`);
	const repoDownload = await downloadRepoCar(profile.did, signal);
	console.log(
		`Repo download complete via ${repoDownload.source.toUpperCase()} in ${formatDuration(repoDownload.elapsedMs)} (${formatBytes(repoDownload.downloadedBytes)}).`
	);

	const carHash = sha256Hex(repoDownload.carBytes);
	let textPosts = await parseTextPostsFromCar(profile.did, repoDownload.carBytes);
	if (limit) {
		textPosts = textPosts.slice(0, limit);
	}
	if (textPosts.length === 0) {
		throw new Error(`No non-empty text posts were found in ${profile.handle}'s repo.`);
	}

	const approxTokens = textPosts.reduce((sum, post) => sum + post.tokenEstimate, 0);
	console.log(
		`Prepared ${textPosts.length.toLocaleString()} text posts (${formatBytes(textPosts.reduce((sum, post) => sum + post.byteLength, 0))}, ~${approxTokens.toLocaleString()} estimated tokens).`
	);

	const resolvedOutputPath = path.resolve(process.cwd(), outputPath);
	const tempOutputPath = `${resolvedOutputPath}.tmp`;
	await mkdir(path.dirname(resolvedOutputPath), { recursive: true });
	await ensureOutputDoesNotExist(resolvedOutputPath, force);
	await rm(tempOutputPath, { force: true });

	const db = new DatabaseSync(tempOutputPath);
	let committed = false;

	try {
		initializeDatabase(db);

		upsertMeta(db, 'schema_version', String(SCHEMA_VERSION));
		upsertMeta(db, 'kind', 'bsky-post-embedding-db');
		upsertMeta(db, 'did', profile.did);
		upsertMeta(db, 'handle', profile.handle);
		upsertMeta(db, 'display_name', profile.displayName ?? '');
		upsertMeta(db, 'avatar', profile.avatar ?? '');
		upsertMeta(db, 'posts_count_from_profile', String(profile.postsCount));
		upsertMeta(db, 'repo_download_source', repoDownload.source);
		upsertMeta(db, 'repo_downloaded_bytes', String(repoDownload.downloadedBytes));
		upsertMeta(db, 'repo_total_bytes', String(repoDownload.totalBytes));
		upsertMeta(db, 'repo_download_elapsed_ms', String(repoDownload.elapsedMs));
		upsertMeta(db, 'repo_car_sha256', carHash);
		upsertMeta(db, 'embedding_model', EMBEDDING_MODEL);
		upsertMeta(db, 'embedding_pooling', EMBEDDING_POOLING);
		upsertMeta(db, 'embedding_namespace', EMBEDDING_NAMESPACE);
		upsertMeta(db, 'generated_at', new Date().toISOString());
		upsertMeta(db, 'approx_input_tokens', String(approxTokens));
		upsertMeta(db, 'batch_size', String(batchSize));
		upsertMeta(db, 'concurrency', String(concurrency));

		const insertPost = db.prepare(`
			INSERT INTO posts (
				uri,
				did,
				handle,
				rkey,
				cid,
				created_at,
				parent_uri,
				thread_root_uri,
				is_reply,
				text,
				char_length,
				byte_length,
				token_estimate,
				embedding_dim,
				embedding_f32
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`);

		const batches = chunk(textPosts, batchSize);
		const startedAt = performance.now();
		let nextBatchIndex = 0;
		let embeddedCount = 0;
		let vectorDim = 0;

		async function worker(): Promise<void> {
			while (true) {
				throwIfAborted(signal);
				const batchIndex = nextBatchIndex++;
				if (batchIndex >= batches.length) return;

				const posts = batches[batchIndex];
				const result = await requestEmbeddingsWithRetry(
					accountId,
					apiToken,
					posts.map((post) => post.text),
					signal
				);

				if (result.pooling && result.pooling !== EMBEDDING_POOLING) {
					throw new Error(
						`Workers AI returned pooling=${result.pooling}, expected ${EMBEDDING_POOLING}.`
					);
				}

				if (result.vectors.length !== posts.length) {
					throw new Error(
						`Workers AI returned ${result.vectors.length} embeddings for a batch of ${posts.length} posts.`
					);
				}

				db.exec('BEGIN');
				try {
					for (let index = 0; index < posts.length; index++) {
						const vector = result.vectors[index];
						if (!Array.isArray(vector) || vector.length === 0) {
							throw new Error(`Invalid embedding vector returned for batch ${batchIndex + 1}.`);
						}
						if (vectorDim === 0) {
							vectorDim = vector.length;
							upsertMeta(db, 'embedding_dim', String(vectorDim));
						} else if (vector.length !== vectorDim) {
							throw new Error(
								`Embedding dimension changed from ${vectorDim} to ${vector.length}.`
							);
						}

						const post = posts[index];
						insertPost.run(
							post.uri,
							profile.did,
							profile.handle,
							post.rkey,
							post.cid,
							post.createdAt,
							post.parentUri,
							post.threadRootUri,
							post.isReply ? 1 : 0,
							post.text,
							post.charLength,
							post.byteLength,
							post.tokenEstimate,
							vector.length,
							vectorToBlob(vector)
						);
					}
					db.exec('COMMIT');
				} catch (error) {
					db.exec('ROLLBACK');
					throw error;
				}

				embeddedCount += posts.length;
				const elapsedMs = performance.now() - startedAt;
				console.log(
					`Embedded ${embeddedCount.toLocaleString()} / ${textPosts.length.toLocaleString()} posts (${formatRate(embeddedCount, elapsedMs, 'posts')})`
				);
			}
		}

		await Promise.all(
			Array.from({ length: Math.max(1, Math.min(concurrency, batches.length)) }, () => worker())
		);

		finalizeDatabase(db);
		upsertMeta(db, 'embedded_posts', String(textPosts.length));
		upsertMeta(db, 'output_filename', path.basename(resolvedOutputPath));
		upsertMeta(db, 'generated_at', new Date().toISOString());

		db.close();
		committed = true;

		await ensureOutputDoesNotExist(resolvedOutputPath, true);
		await rename(tempOutputPath, resolvedOutputPath);
		const totalElapsedMs = performance.now() - startedAt;
		console.log(
			`SQLite DB written to ${resolvedOutputPath} in ${formatDuration(totalElapsedMs)}.`
		);
	} finally {
		if (!committed) {
			try {
				db.close();
			} catch {
				// Best effort.
			}
			await rm(tempOutputPath, { force: true }).catch(() => {});
		}
	}
}

async function main(): Promise<void> {
	const cli = parseCliArgs(process.argv.slice(2));
	const localEnv = await loadLocalEnv(cli.envPath);
	if (Object.keys(localEnv).length > 0) {
		console.log(`Loaded local config from ${cli.envPath}`);
	}

	let handle = cli.handle ? normalizeHandle(cli.handle) : '';
	if (!handle) {
		handle = await promptForHandle();
	}
	if (!handle) {
		throw new Error('A Bluesky handle is required.');
	}

	const accountId = requireConfig(localEnv, ['CLOUDFLARE_ACCOUNT_ID', 'CLUSTER_R2_ACCOUNT_ID']);
	const apiToken = requireConfig(localEnv, ['CLOUDFLARE_API_TOKEN', 'CF_API_TOKEN']);
	const controller = new AbortController();
	const onSignal = (signal: 'SIGINT' | 'SIGTERM') => {
		console.error(`Interrupted by ${signal}; aborting...`);
		controller.abort();
	};
	const onSigint = () => onSignal('SIGINT');
	const onSigterm = () => onSignal('SIGTERM');
	process.on('SIGINT', onSigint);
	process.on('SIGTERM', onSigterm);

	try {
		console.log(`Resolving profile for ${handle}...`);
		const profile = await resolveProfile(handle);
		const outputPath = cli.outputPath
			? path.resolve(process.cwd(), cli.outputPath)
			: defaultOutputPath(profile.handle);
		console.log(
			`Found ${profile.handle} (${profile.did}) with ${profile.postsCount.toLocaleString()} reported posts.`
		);
		await buildEmbeddingDb(profile, outputPath, {
			accountId,
			apiToken,
			batchSize: cli.batchSize,
			concurrency: cli.concurrency,
			limit: cli.limit,
			force: cli.force,
			signal: controller.signal
		});
		console.log('Done.');
	} finally {
		process.off('SIGINT', onSigint);
		process.off('SIGTERM', onSigterm);
	}
}

void main().catch((error: any) => {
	if (error?.name === 'AbortError') {
		process.exitCode = 130;
		return;
	}
	console.error(error?.message || 'Embedding DB build failed.');
	if (error?.stack) {
		console.error(error.stack);
	}
	process.exitCode = 1;
});
