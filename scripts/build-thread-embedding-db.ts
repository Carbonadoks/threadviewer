import { AtpAgent } from '@atproto/api';
import { CarReader } from '@ipld/car';
import * as dagCbor from '@ipld/dag-cbor';
import { createHash } from 'node:crypto';
import { access, mkdir, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { createInterface } from 'node:readline/promises';
import { DatabaseSync } from 'node:sqlite';
import type { AuthorInfo, SelfReplyThread, ThreadAnalysisPost } from '../src/lib/types';
import { parseCarPosts, type ParsedPost } from '../src/lib/utils/carParser';
import { resolvePds } from '../src/lib/utils/pdsResolver';
import { repoPostsToFeedItems } from '../src/lib/utils/repoToFeed';
import { averageEmbeddings, buildThreadAnalysisDocument } from '../src/lib/utils/threadAnalysis';
import { buildThreadsFromFeed } from '../src/lib/utils/threadWalker';

const PROFILE_API = 'https://public.api.bsky.app';
const EMBEDDING_MODEL = '@cf/baai/bge-small-en-v1.5';
const EMBEDDING_POOLING = 'cls';
const EMBEDDING_NAMESPACE = 'cf-bge-small-en-v1.5-cls';
const EMBEDDING_MAX_BATCH_SIZE = 100;
const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_CONCURRENCY = 4;
const DEFAULT_MAX_SEGMENTS = 8;
const DEFAULT_MIN_DEPTH = 2;
const DEFAULT_ENV_PATH = path.resolve(process.cwd(), '.env.cluster.local');
const DEFAULT_OUTPUT_DIR = path.resolve(process.cwd(), 'output', 'thread-embedding-dbs');
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
	minDepth: number;
	maxSegments: number;
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

type ThreadSegmentRecord = {
	segmentUri: string;
	rootUri: string;
	segmentIndex: number;
	sourcePostUri: string;
	createdAt: string;
	text: string;
	charLength: number;
	byteLength: number;
	tokenEstimate: number;
};

type ThreadDocumentRecord = {
	thread: SelfReplyThread;
	rootUri: string;
	depth: number;
	title: string;
	preview: string;
	text: string;
	posts: ThreadAnalysisPost[];
	segments: ThreadSegmentRecord[];
	firstCreatedAt: string;
	lastCreatedAt: string;
};

type ParsedThreadBundle = {
	parsedPostCount: number;
	chainStarts: number;
	replyThreads: number;
	documents: ThreadDocumentRecord[];
	threadPostCount: number;
	segmentCount: number;
	approxInputTokens: number;
};

type EmbedBatchResult = {
	vectors: number[][];
	shape?: number[];
	pooling?: string;
};

function usage(): string {
	return [
		'Build a self-contained SQLite DB of self-reply threads + analyzer-style chunked embeddings.',
		'',
		'Quick start:',
		'  cp .env.cluster.local.example .env.cluster.local',
		'  npm run thread-embeddb:build -- alice.bsky.social',
		'',
		'Usage:',
		'  node --import tsx scripts/build-thread-embedding-db.ts <handle> [options]',
		'  npm run thread-embeddb:build -- <handle> [options]',
		'',
		'Options:',
		'  --output <path>         Output SQLite path',
		'  --env-file <path>       Optional env file to load first',
		'  --batch-size <n>        Cloudflare batch size (default: 100, max: 100)',
		'  --concurrency <n>       Concurrent embedding requests (default: 4)',
		'  --limit <n>             Embed only the first n reply threads after sorting',
		'  --min-depth <n>         Minimum reply-thread depth to include (default: 2)',
		'  --max-segments <n>      Max analyzer-style chunks per thread (default: 8)',
		'  --force                 Overwrite an existing output file',
		'  --help                  Show this help',
		'',
		'Required env:',
		'  CLOUDFLARE_API_TOKEN or CF_API_TOKEN',
		'  CLOUDFLARE_ACCOUNT_ID or CLUSTER_R2_ACCOUNT_ID',
		'',
		'Example:',
		'  npm run thread-embeddb:build -- alice.bsky.social --max-segments 6 --concurrency 6'
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
	let minDepth = DEFAULT_MIN_DEPTH;
	let maxSegments = DEFAULT_MAX_SEGMENTS;
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
		if (arg === '--min-depth') {
			minDepth = parsePositiveInteger(argv[++index] ?? '', '--min-depth');
			continue;
		}
		if (arg === '--max-segments') {
			maxSegments = parsePositiveInteger(argv[++index] ?? '', '--max-segments');
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
		minDepth,
		maxSegments,
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
		`${sanitizeHandleForFilename(handle)}.${EMBEDDING_NAMESPACE}.threads.sqlite`
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

function compareIsoDateDesc(a: string, b: string): number {
	const aTime = new Date(a).getTime();
	const bTime = new Date(b).getTime();
	if (Number.isFinite(aTime) && Number.isFinite(bTime) && aTime !== bTime) {
		return bTime - aTime;
	}
	return a.localeCompare(b);
}

function compareThreadsByDepth(a: SelfReplyThread, b: SelfReplyThread): number {
	return (
		b.depth - a.depth ||
		compareIsoDateDesc(a.rootPost.createdAt, b.rootPost.createdAt) ||
		a.rootUri.localeCompare(b.rootUri)
	);
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

async function downloadRepoCar(did: string, signal?: AbortSignal): Promise<RepoDownloadResult> {
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

async function parseRepoPostsFromCar(carBytes: Uint8Array): Promise<ParsedPost[]> {
	console.log('Parsing CAR and rebuilding self-reply threads...');
	return parseCarPosts(
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
}

function segmentSourcePost(
	posts: ThreadAnalysisPost[],
	thread: SelfReplyThread,
	index: number
): ThreadAnalysisPost {
	const fallbackPost = posts[Math.min(index, Math.max(0, posts.length - 1))];
	if (fallbackPost) return fallbackPost;
	return {
		uri: thread.rootUri,
		text: normalizePostText(thread.rootPost.text),
		createdAt: safeIsoDate(thread.rootPost.createdAt)
	};
}

function buildSegmentUri(rootUri: string, segmentIndex: number): string {
	return `${rootUri}#segment-${String(segmentIndex).padStart(2, '0')}`;
}

function buildThreadDocumentRecord(
	thread: SelfReplyThread,
	maxSegments: number
): ThreadDocumentRecord | null {
	const document = buildThreadAnalysisDocument(thread, maxSegments);
	if (document.posts.length === 0 || document.segments.length === 0) {
		return null;
	}

	const segments = document.segments.map((text, index) => {
		const segmentIndex = index + 1;
		const sourcePost = segmentSourcePost(document.posts, thread, index);
		return {
			segmentUri: buildSegmentUri(thread.rootUri, segmentIndex),
			rootUri: thread.rootUri,
			segmentIndex,
			sourcePostUri: sourcePost.uri,
			createdAt: safeIsoDate(sourcePost.createdAt),
			text,
			charLength: text.length,
			byteLength: Buffer.byteLength(text, 'utf8'),
			tokenEstimate: estimateTokens(text)
		};
	});

	const firstCreatedAt = safeIsoDate(document.posts[0]?.createdAt || thread.rootPost.createdAt);
	const lastCreatedAt = safeIsoDate(
		document.posts[document.posts.length - 1]?.createdAt || thread.rootPost.createdAt
	);

	return {
		thread,
		rootUri: thread.rootUri,
		depth: thread.depth,
		title: document.title,
		preview: document.preview,
		text: document.text,
		posts: document.posts,
		segments,
		firstCreatedAt,
		lastCreatedAt
	};
}

function buildThreadDocumentsFromParsedPosts(
	profile: ProfileInfo,
	parsedPosts: ParsedPost[],
	options: {
		minDepth: number;
		maxSegments: number;
		limit: number | null;
	}
): ParsedThreadBundle {
	const author: AuthorInfo = {
		did: profile.did,
		handle: profile.handle,
		displayName: profile.displayName,
		avatar: profile.avatar
	};
	const feedItems = repoPostsToFeedItems(profile.did, parsedPosts, author);
	const { threads } = buildThreadsFromFeed(feedItems, profile.did);
	const replyThreads = threads
		.filter((thread) => thread.depth >= options.minDepth)
		.sort(compareThreadsByDepth);
	const selectedThreads = options.limit ? replyThreads.slice(0, options.limit) : replyThreads;

	const documents = selectedThreads
		.map((thread) => buildThreadDocumentRecord(thread, options.maxSegments))
		.filter((document): document is ThreadDocumentRecord => document !== null);

	const threadPostCount = documents.reduce((sum, document) => sum + document.posts.length, 0);
	const segmentCount = documents.reduce((sum, document) => sum + document.segments.length, 0);
	const approxInputTokens = documents.reduce(
		(sum, document) =>
			sum +
			document.segments.reduce((segmentSum, segment) => segmentSum + segment.tokenEstimate, 0),
		0
	);

	return {
		parsedPostCount: parsedPosts.length,
		chainStarts: threads.length,
		replyThreads: replyThreads.length,
		documents,
		threadPostCount,
		segmentCount,
		approxInputTokens
	};
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
	const response = await fetch(`${RUN_ENDPOINT_BASE}/${accountId}/ai/run/${EMBEDDING_MODEL}`, {
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
	});

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

		CREATE TABLE IF NOT EXISTS threads (
			id INTEGER PRIMARY KEY,
			root_uri TEXT NOT NULL UNIQUE,
			did TEXT NOT NULL,
			handle TEXT NOT NULL,
			depth INTEGER NOT NULL,
			post_count INTEGER NOT NULL,
			segment_count INTEGER NOT NULL,
			first_post_created_at TEXT NOT NULL,
			last_post_created_at TEXT NOT NULL,
			title TEXT NOT NULL,
			preview TEXT NOT NULL,
			text TEXT NOT NULL,
			embedding_dim INTEGER NOT NULL,
			embedding_f32 BLOB NOT NULL
		);

		CREATE TABLE IF NOT EXISTS thread_posts (
			id INTEGER PRIMARY KEY,
			root_uri TEXT NOT NULL,
			post_index INTEGER NOT NULL,
			uri TEXT NOT NULL UNIQUE,
			created_at TEXT NOT NULL,
			text TEXT NOT NULL,
			char_length INTEGER NOT NULL,
			byte_length INTEGER NOT NULL,
			token_estimate INTEGER NOT NULL
		);

		CREATE TABLE IF NOT EXISTS segments (
			id INTEGER PRIMARY KEY,
			segment_uri TEXT NOT NULL UNIQUE,
			root_uri TEXT NOT NULL,
			segment_index INTEGER NOT NULL,
			source_post_uri TEXT NOT NULL,
			created_at TEXT NOT NULL,
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
		CREATE INDEX IF NOT EXISTS threads_depth_idx ON threads (depth);
		CREATE INDEX IF NOT EXISTS threads_created_at_idx ON threads (first_post_created_at);
		CREATE INDEX IF NOT EXISTS thread_posts_root_uri_idx ON thread_posts (root_uri, post_index);
		CREATE INDEX IF NOT EXISTS segments_root_uri_idx ON segments (root_uri, segment_index);
		CREATE INDEX IF NOT EXISTS segments_source_post_uri_idx ON segments (source_post_uri);
		ANALYZE;
	`);
}

function insertThreadPosts(db: DatabaseSync, documents: ThreadDocumentRecord[]): void {
	const insertThreadPost = db.prepare(`
		INSERT INTO thread_posts (
			root_uri,
			post_index,
			uri,
			created_at,
			text,
			char_length,
			byte_length,
			token_estimate
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
	`);

	db.exec('BEGIN');
	try {
		for (const document of documents) {
			for (let index = 0; index < document.posts.length; index++) {
				const post = document.posts[index];
				const text = normalizePostText(post.text);
				insertThreadPost.run(
					document.rootUri,
					index + 1,
					post.uri,
					safeIsoDate(post.createdAt),
					text,
					text.length,
					Buffer.byteLength(text, 'utf8'),
					estimateTokens(text)
				);
			}
		}
		db.exec('COMMIT');
	} catch (error) {
		db.exec('ROLLBACK');
		throw error;
	}
}

async function buildThreadEmbeddingDb(
	profile: ProfileInfo,
	outputPath: string,
	options: {
		accountId: string;
		apiToken: string;
		batchSize: number;
		concurrency: number;
		limit: number | null;
		minDepth: number;
		maxSegments: number;
		force: boolean;
		signal?: AbortSignal;
	}
): Promise<void> {
	const {
		accountId,
		apiToken,
		batchSize,
		concurrency,
		limit,
		minDepth,
		maxSegments,
		force,
		signal
	} = options;

	console.log(`Resolving repo for ${profile.handle} (${profile.did})...`);
	const repoDownload = await downloadRepoCar(profile.did, signal);
	console.log(
		`Repo download complete via ${repoDownload.source.toUpperCase()} in ${formatDuration(repoDownload.elapsedMs)} (${formatBytes(repoDownload.downloadedBytes)}).`
	);

	const carHash = sha256Hex(repoDownload.carBytes);
	const parsedPosts = await parseRepoPostsFromCar(repoDownload.carBytes);
	const bundle = buildThreadDocumentsFromParsedPosts(profile, parsedPosts, {
		minDepth,
		maxSegments,
		limit
	});

	if (bundle.documents.length === 0) {
		throw new Error(
			`No reply threads with text were found for ${profile.handle} at min depth ${minDepth}.`
		);
	}

	console.log(
		`Prepared ${bundle.documents.length.toLocaleString()} threads with ${bundle.segmentCount.toLocaleString()} segments and ${bundle.threadPostCount.toLocaleString()} thread posts (~${bundle.approxInputTokens.toLocaleString()} estimated input tokens).`
	);

	const resolvedOutputPath = path.resolve(process.cwd(), outputPath);
	const tempOutputPath = `${resolvedOutputPath}.tmp`;
	await mkdir(path.dirname(resolvedOutputPath), { recursive: true });
	await ensureOutputDoesNotExist(resolvedOutputPath, force);
	await rm(tempOutputPath, { force: true });

	const db = new DatabaseSync(tempOutputPath);
	let committed = false;
	const startedAt = performance.now();

	try {
		initializeDatabase(db);

		upsertMeta(db, 'schema_version', String(SCHEMA_VERSION));
		upsertMeta(db, 'kind', 'bsky-thread-embedding-db');
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
		upsertMeta(db, 'batch_size', String(batchSize));
		upsertMeta(db, 'concurrency', String(concurrency));
		upsertMeta(db, 'min_depth', String(minDepth));
		upsertMeta(db, 'max_segments_per_thread', String(maxSegments));
		upsertMeta(db, 'thread_limit', limit === null ? 'all' : String(limit));
		upsertMeta(db, 'posts_scanned', String(bundle.parsedPostCount));
		upsertMeta(db, 'chain_starts', String(bundle.chainStarts));
		upsertMeta(db, 'threads_with_self_replies', String(bundle.replyThreads));
		upsertMeta(db, 'threads_selected', String(bundle.documents.length));
		upsertMeta(db, 'segment_count', String(bundle.segmentCount));
		upsertMeta(db, 'thread_post_count', String(bundle.threadPostCount));
		upsertMeta(db, 'approx_input_tokens', String(bundle.approxInputTokens));

		insertThreadPosts(db, bundle.documents);

		const insertSegment = db.prepare(`
			INSERT INTO segments (
				segment_uri,
				root_uri,
				segment_index,
				source_post_uri,
				created_at,
				text,
				char_length,
				byte_length,
				token_estimate,
				embedding_dim,
				embedding_f32
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`);
		const insertThread = db.prepare(`
			INSERT INTO threads (
				root_uri,
				did,
				handle,
				depth,
				post_count,
				segment_count,
				first_post_created_at,
				last_post_created_at,
				title,
				preview,
				text,
				embedding_dim,
				embedding_f32
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`);

		const segmentRows = bundle.documents.flatMap((document) => document.segments);
		const batches = chunk(segmentRows, batchSize);
		const vectorsByRootUri = new Map<string, number[][]>();
		let nextBatchIndex = 0;
		let embeddedSegments = 0;
		let vectorDim = 0;

		async function worker(): Promise<void> {
			while (true) {
				throwIfAborted(signal);
				const batchIndex = nextBatchIndex++;
				if (batchIndex >= batches.length) return;

				const segmentBatch = batches[batchIndex];
				const result = await requestEmbeddingsWithRetry(
					accountId,
					apiToken,
					segmentBatch.map((segment) => segment.text),
					signal
				);

				if (result.pooling && result.pooling !== EMBEDDING_POOLING) {
					throw new Error(
						`Workers AI returned pooling=${result.pooling}, expected ${EMBEDDING_POOLING}.`
					);
				}

				if (result.vectors.length !== segmentBatch.length) {
					throw new Error(
						`Workers AI returned ${result.vectors.length} embeddings for a batch of ${segmentBatch.length} segments.`
					);
				}

				db.exec('BEGIN');
				try {
					for (let index = 0; index < segmentBatch.length; index++) {
						const vector = result.vectors[index];
						if (!Array.isArray(vector) || vector.length === 0) {
							throw new Error(
								`Invalid embedding vector returned for batch ${batchIndex + 1}.`
							);
						}
						if (vectorDim === 0) {
							vectorDim = vector.length;
							upsertMeta(db, 'segment_embedding_dim', String(vectorDim));
							upsertMeta(db, 'thread_embedding_dim', String(vectorDim));
						} else if (vector.length !== vectorDim) {
							throw new Error(
								`Embedding dimension changed from ${vectorDim} to ${vector.length}.`
							);
						}

						const segment = segmentBatch[index];
						insertSegment.run(
							segment.segmentUri,
							segment.rootUri,
							segment.segmentIndex,
							segment.sourcePostUri,
							segment.createdAt,
							segment.text,
							segment.charLength,
							segment.byteLength,
							segment.tokenEstimate,
							vector.length,
							vectorToBlob(vector)
						);

						const existing = vectorsByRootUri.get(segment.rootUri);
						if (existing) {
							existing.push(vector);
						} else {
							vectorsByRootUri.set(segment.rootUri, [vector]);
						}
					}
					db.exec('COMMIT');
				} catch (error) {
					db.exec('ROLLBACK');
					throw error;
				}

				embeddedSegments += segmentBatch.length;
				const elapsedMs = performance.now() - startedAt;
				console.log(
					`Embedded ${embeddedSegments.toLocaleString()} / ${segmentRows.length.toLocaleString()} segments (${formatRate(embeddedSegments, elapsedMs, 'segments')})`
				);
			}
		}

		await Promise.all(
			Array.from({ length: Math.max(1, Math.min(concurrency, batches.length)) }, () => worker())
		);

		db.exec('BEGIN');
		try {
			for (const document of bundle.documents) {
				const vectors = vectorsByRootUri.get(document.rootUri) ?? [];
				if (vectors.length !== document.segments.length) {
					throw new Error(
						`Thread ${document.rootUri} resolved ${vectors.length} segment embeddings for ${document.segments.length} segments.`
					);
				}

				const threadEmbedding = averageEmbeddings(vectors);
				if (threadEmbedding.length === 0) {
					throw new Error(`Thread ${document.rootUri} did not produce a valid thread embedding.`);
				}

				insertThread.run(
					document.rootUri,
					profile.did,
					profile.handle,
					document.depth,
					document.posts.length,
					document.segments.length,
					document.firstCreatedAt,
					document.lastCreatedAt,
					document.title,
					document.preview,
					document.text,
					threadEmbedding.length,
					vectorToBlob(threadEmbedding)
				);
			}
			db.exec('COMMIT');
		} catch (error) {
			db.exec('ROLLBACK');
			throw error;
		}

		finalizeDatabase(db);
		upsertMeta(db, 'embedded_threads', String(bundle.documents.length));
		upsertMeta(db, 'embedded_segments', String(segmentRows.length));
		upsertMeta(db, 'embedded_thread_posts', String(bundle.threadPostCount));
		upsertMeta(db, 'output_filename', path.basename(resolvedOutputPath));
		upsertMeta(db, 'generated_at', new Date().toISOString());

		db.close();
		committed = true;

		await ensureOutputDoesNotExist(resolvedOutputPath, true);
		await rename(tempOutputPath, resolvedOutputPath);
		const totalElapsedMs = performance.now() - startedAt;
		console.log(
			`SQLite DB written to ${resolvedOutputPath} with ${bundle.documents.length.toLocaleString()} threads in ${formatDuration(totalElapsedMs)}.`
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
	const onSignal = (signalName: 'SIGINT' | 'SIGTERM') => {
		console.error(`Interrupted by ${signalName}; aborting...`);
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
		await buildThreadEmbeddingDb(profile, outputPath, {
			accountId,
			apiToken,
			batchSize: cli.batchSize,
			concurrency: cli.concurrency,
			limit: cli.limit,
			minDepth: cli.minDepth,
			maxSegments: cli.maxSegments,
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
	console.error(error?.message || 'Thread embedding DB build failed.');
	if (error?.stack) {
		console.error(error.stack);
	}
	process.exitCode = 1;
});
