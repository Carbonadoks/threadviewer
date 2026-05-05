import { AtpAgent } from '@atproto/api';
import { CarReader } from '@ipld/car';
import * as dagCbor from '@ipld/dag-cbor';
import { createHash } from 'node:crypto';
import { appendFile, access, mkdir, readFile, rm } from 'node:fs/promises';
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
const REMOTE_POST_BATCH_SIZE = 25;
const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_CONCURRENCY = 4;
const DEFAULT_QUOTE_CONCURRENCY = 8;
const DEFAULT_ENV_PATH = path.resolve(process.cwd(), '.env.cluster.local');
const DEFAULT_OUTPUT_DIR = path.resolve(process.cwd(), 'output', 'window-embedding-dbs');
const SCHEMA_VERSION = 1;
const WINDOW_STRATEGY = 'focal+quote+parent+root+children+remote-context';
const RUN_ENDPOINT_BASE = 'https://api.cloudflare.com/client/v4/accounts';
const RETRYABLE_STATUSES = new Set([408, 409, 425, 429, 500, 502, 503, 504]);
const MAX_EMBED_RETRIES = 5;
const MAX_QUOTE_RETRIES = 4;
const RETRY_BASE_DELAY_MS = 800;
const WINDOW_MAX_CHARS = 1800;
const MAX_CHILD_CONTEXTS = 2;
const FOCAL_SECTION_MAX_CHARS = 520;
const QUOTE_SECTION_MAX_CHARS = 460;
const PARENT_SECTION_MAX_CHARS = 280;
const ROOT_SECTION_MAX_CHARS = 280;
const CHILD_SECTION_MAX_CHARS = 180;

type EnvMap = Record<string, string>;

type CliOptions = {
	handle: string | null;
	outputPath: string | null;
	envPath: string;
	batchSize: number;
	concurrency: number;
	quoteConcurrency: number;
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

type NormalizedEmbedContext = {
	quoteTargetUri: string | null;
	externalUri: string | null;
	externalTitle: string | null;
	externalDescription: string | null;
	imageAltTexts: string[];
	videoAlt: string | null;
};

type LocalPostRecord = {
	uri: string;
	rkey: string;
	cid: string;
	text: string;
	surfaceText: string;
	createdAt: string;
	parentUri: string | null;
	threadRootUri: string;
	isReply: boolean;
	quoteTargetUri: string | null;
	externalUri: string | null;
	externalTitle: string | null;
	externalDescription: string | null;
	imageAltText: string;
	videoAlt: string | null;
	charLength: number;
	byteLength: number;
	tokenEstimate: number;
};

type ContextPostRecord = {
	uri: string;
	source: 'local' | 'remote' | 'unavailable';
	authorDid: string | null;
	authorHandle: string | null;
	authorDisplayName: string | null;
	createdAt: string | null;
	text: string;
	surfaceText: string;
	externalUri: string | null;
	externalTitle: string | null;
	externalDescription: string | null;
	imageAltText: string;
	videoAlt: string | null;
	unavailable: boolean;
};

type WindowRecord = {
	windowUri: string;
	focalPostUri: string;
	threadRootUri: string;
	createdAt: string;
	parentUri: string | null;
	quoteTargetUri: string | null;
	title: string;
	preview: string;
	text: string;
	charLength: number;
	byteLength: number;
	tokenEstimate: number;
};

type WindowBundle = {
	posts: LocalPostRecord[];
	windows: WindowRecord[];
	approxInputTokens: number;
	localQuoteHits: number;
	remoteQuoteTargets: number;
	remoteParentTargets: number;
	remoteRootTargets: number;
	reusedRemoteContexts: number;
	fetchedRemoteContexts: number;
	unavailableRemoteContexts: number;
	contextPosts: ContextPostRecord[];
};

type EmbedBatchResult = {
	vectors: number[][];
	shape?: number[];
	pooling?: string;
};

type PendingWindowRow = WindowRecord & {
	focalText: string;
	focalSurfaceText: string;
	embeddingDim: number | null;
};

function usage(): string {
	return [
		'Build a self-contained SQLite DB of contextual post windows + Cloudflare BGE embeddings.',
		'',
		'Quick start:',
		'  cp .env.cluster.local.example .env.cluster.local',
		'  npm run window-embeddb:build -- alice.bsky.social',
		'',
		'Usage:',
		'  node --import tsx scripts/build-window-embedding-db.ts <handle> [options]',
		'  npm run window-embeddb:build -- <handle> [options]',
		'',
		'Window strategy:',
		'  One embedding per focal post, using a contextual window built from:',
		'  - the focal post',
		'  - a quoted post when available',
		'  - parent / root context from the repo CAR when local',
		'  - fetched remote parent / root posts when they are outside the repo',
		'  - up to two direct local replies',
		'  - resumable writes: posts/context/windows are checkpointed before embedding',
		'',
		'Options:',
		'  --output <path>            Output SQLite path',
		'  --env-file <path>          Optional env file to load first',
		'  --batch-size <n>           Cloudflare batch size (default: 100, max: 100)',
		'  --concurrency <n>          Concurrent embedding requests (default: 4)',
		'  --quote-concurrency <n>    Concurrent getPosts context batches (default: 8)',
		'  --limit <n>                Embed only the first n posts after sorting',
		'  --force                    Overwrite an existing output file',
		'  --help                     Show this help',
		'',
		'Required env:',
		'  CLOUDFLARE_API_TOKEN or CF_API_TOKEN',
		'  CLOUDFLARE_ACCOUNT_ID or CLUSTER_R2_ACCOUNT_ID',
		'',
		'Example:',
		'  npm run window-embeddb:build -- alice.bsky.social --quote-concurrency 12 --concurrency 6'
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
	let quoteConcurrency = DEFAULT_QUOTE_CONCURRENCY;
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
		if (arg === '--quote-concurrency') {
			quoteConcurrency = parsePositiveInteger(argv[++index] ?? '', '--quote-concurrency');
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
		quoteConcurrency,
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
		`${sanitizeHandleForFilename(handle)}.${EMBEDDING_NAMESPACE}.windows.sqlite`
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

function normalizeWhitespace(text: string): string {
	return text
		.replace(/\r\n/g, '\n')
		.replace(/[ \t]+\n/g, '\n')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}

function normalizePostText(text: string): string {
	return normalizeWhitespace(text);
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

function comparePosts(a: LocalPostRecord, b: LocalPostRecord): number {
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

function trimPreview(text: string, maxLength: number): string {
	const normalized = normalizeWhitespace(text);
	if (normalized.length <= maxLength) return normalized;
	return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function toMaybeString(value: unknown): string | null {
	return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function isPostUri(value: unknown): value is string {
	return typeof value === 'string' && /^at:\/\/[^/]+\/app\.bsky\.feed\.post\/[^/]+$/i.test(value);
}

function mergeEmbedContexts(
	base: NormalizedEmbedContext,
	extra: Partial<NormalizedEmbedContext>
): NormalizedEmbedContext {
	return {
		quoteTargetUri: extra.quoteTargetUri ?? base.quoteTargetUri,
		externalUri: extra.externalUri ?? base.externalUri,
		externalTitle: extra.externalTitle ?? base.externalTitle,
		externalDescription: extra.externalDescription ?? base.externalDescription,
		imageAltTexts: [...base.imageAltTexts, ...(extra.imageAltTexts ?? [])],
		videoAlt: extra.videoAlt ?? base.videoAlt
	};
}

function extractEmbedContext(embed: any): NormalizedEmbedContext {
	const empty: NormalizedEmbedContext = {
		quoteTargetUri: null,
		externalUri: null,
		externalTitle: null,
		externalDescription: null,
		imageAltTexts: [],
		videoAlt: null
	};
	if (!embed || typeof embed !== 'object') return empty;

	const type = toMaybeString(embed.$type);
	if (type === 'app.bsky.embed.record') {
		return {
			...empty,
			quoteTargetUri: isPostUri(embed.record?.uri) ? embed.record.uri : null
		};
	}

	if (type === 'app.bsky.embed.recordWithMedia') {
		const mediaContext = extractEmbedContext(embed.media);
		return mergeEmbedContexts(mediaContext, {
			quoteTargetUri: isPostUri(embed.record?.uri) ? embed.record.uri : null
		});
	}

	if (type === 'app.bsky.embed.external') {
		return {
			...empty,
			externalUri: toMaybeString(embed.external?.uri),
			externalTitle: toMaybeString(embed.external?.title),
			externalDescription: toMaybeString(embed.external?.description)
		};
	}

	if (type === 'app.bsky.embed.images') {
		const imageAltTexts = Array.isArray(embed.images)
			? embed.images.map((image: any) => toMaybeString(image?.alt)).filter(Boolean)
			: [];
		return {
			...empty,
			imageAltTexts: imageAltTexts as string[]
		};
	}

	if (type === 'app.bsky.embed.video') {
		return {
			...empty,
			videoAlt: toMaybeString(embed.alt)
		};
	}

	return empty;
}

function buildSurfaceText(input: {
	text: string;
	externalTitle?: string | null;
	externalDescription?: string | null;
	imageAltTexts?: string[];
	videoAlt?: string | null;
}): string {
	const parts: string[] = [];
	const text = normalizePostText(input.text);
	if (text) {
		parts.push(text);
	}

	const externalBits = [
		toMaybeString(input.externalTitle),
		toMaybeString(input.externalDescription)
	].filter(Boolean);
	if (externalBits.length > 0) {
		parts.push(`Linked page: ${externalBits.join(' — ')}`);
	}

	const imageAltTexts = (input.imageAltTexts ?? [])
		.map((value) => normalizePostText(value))
		.filter(Boolean)
		.slice(0, 2);
	if (imageAltTexts.length > 0) {
		parts.push(`Image alt: ${imageAltTexts.join(' | ')}`);
	}

	const videoAlt = normalizePostText(input.videoAlt ?? '');
	if (videoAlt) {
		parts.push(`Video alt: ${videoAlt}`);
	}

	return normalizePostText(parts.join('\n\n'));
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
	console.log('Parsing CAR and extracting post records...');
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

function normalizeLocalPosts(did: string, posts: ParsedPost[]): LocalPostRecord[] {
	const recordsByUri = new Map<string, LocalPostRecord>();

	for (const post of posts) {
		const record = post.record;
		const uri = `at://${did}/app.bsky.feed.post/${post.rkey}`;
		const parentUri = isPostUri(record?.reply?.parent?.uri) ? record.reply.parent.uri : null;
		const explicitRootUri = isPostUri(record?.reply?.root?.uri) ? record.reply.root.uri : null;
		const threadRootUri = explicitRootUri || uri;
		const embedContext = extractEmbedContext(record?.embed);
		const text = normalizePostText(typeof record?.text === 'string' ? record.text : '');
		const surfaceText = buildSurfaceText({
			text,
			externalTitle: embedContext.externalTitle,
			externalDescription: embedContext.externalDescription,
			imageAltTexts: embedContext.imageAltTexts,
			videoAlt: embedContext.videoAlt
		});

		recordsByUri.set(uri, {
			uri,
			rkey: post.rkey,
			cid: post.cid,
			text,
			surfaceText,
			createdAt: safeIsoDate(record?.createdAt),
			parentUri,
			threadRootUri,
			isReply: Boolean(parentUri),
			quoteTargetUri: embedContext.quoteTargetUri,
			externalUri: embedContext.externalUri,
			externalTitle: embedContext.externalTitle,
			externalDescription: embedContext.externalDescription,
			imageAltText: embedContext.imageAltTexts.join(' | '),
			videoAlt: embedContext.videoAlt,
			charLength: text.length,
			byteLength: Buffer.byteLength(text, 'utf8'),
			tokenEstimate: estimateTokens(text || surfaceText || uri)
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

function createUnavailableContextRecord(uri: string): ContextPostRecord {
	return {
		uri,
		source: 'unavailable',
		authorDid: null,
		authorHandle: null,
		authorDisplayName: null,
		createdAt: null,
		text: '',
		surfaceText: '',
		externalUri: null,
		externalTitle: null,
		externalDescription: null,
		imageAltText: '',
		videoAlt: null,
		unavailable: true
	};
}

function normalizeRemoteContextRecord(postView: any): ContextPostRecord | null {
	const uri = toMaybeString(postView?.uri);
	if (!uri) return null;

	const record = postView?.record && typeof postView.record === 'object' ? postView.record : {};
	const embedContext = extractEmbedContext(record?.embed);
	const text = normalizePostText(
		typeof record?.text === 'string' ? record.text : typeof postView?.text === 'string' ? postView.text : ''
	);
	const surfaceText = buildSurfaceText({
		text,
		externalTitle: embedContext.externalTitle,
		externalDescription: embedContext.externalDescription,
		imageAltTexts: embedContext.imageAltTexts,
		videoAlt: embedContext.videoAlt
	});

	return {
		uri,
		source: 'remote',
		authorDid: toMaybeString(postView?.author?.did),
		authorHandle: toMaybeString(postView?.author?.handle),
		authorDisplayName: toMaybeString(postView?.author?.displayName),
		createdAt: toMaybeString(record?.createdAt) || toMaybeString(postView?.indexedAt),
		text,
		surfaceText,
		externalUri: embedContext.externalUri,
		externalTitle: embedContext.externalTitle,
		externalDescription: embedContext.externalDescription,
		imageAltText: embedContext.imageAltTexts.join(' | '),
		videoAlt: embedContext.videoAlt,
		unavailable: false
	};
}

async function fetchRemoteQuoteContexts(
	uris: string[],
	options: {
		concurrency: number;
		signal?: AbortSignal;
	}
): Promise<Map<string, ContextPostRecord>> {
	const { concurrency, signal } = options;
	const uniqueUris = [...new Set(uris.map((uri) => uri.trim()).filter(Boolean))];
	const result = new Map<string, ContextPostRecord>();
	if (uniqueUris.length === 0) return result;

	const agent = new AtpAgent({ service: PROFILE_API });
	const batches = chunk(uniqueUris, REMOTE_POST_BATCH_SIZE);
	const total = uniqueUris.length;
	const totalBatches = batches.length;
	const workerCount = Math.min(Math.max(1, Math.floor(concurrency)), totalBatches);
	let nextBatchIndex = 0;
	let completed = 0;
	const startedAt = performance.now();

	async function requestBatch(batch: string[]): Promise<Map<string, ContextPostRecord>> {
		for (let attempt = 0; attempt <= MAX_QUOTE_RETRIES; attempt++) {
			try {
				const batchResult = new Map<string, ContextPostRecord>();
				const res = await agent.getPosts({ uris: batch });
				for (const postView of res.data.posts ?? []) {
					const normalized = normalizeRemoteContextRecord(postView);
					if (normalized) {
						batchResult.set(normalized.uri, normalized);
					}
				}
				return batchResult;
			} catch (error: any) {
				throwIfAborted(signal);
				if (attempt >= MAX_QUOTE_RETRIES) {
						console.warn(
							`Context batch failed after ${MAX_QUOTE_RETRIES + 1} attempts (${error?.message || 'unknown error'}).`
						);
						return new Map<string, ContextPostRecord>();
					}
					const delayMs = RETRY_BASE_DELAY_MS * 2 ** attempt;
					await sleep(delayMs);
				}
			}

			return new Map<string, ContextPostRecord>();
		}

	async function worker(): Promise<void> {
		while (true) {
			throwIfAborted(signal);
			const batchIndex = nextBatchIndex++;
			if (batchIndex >= totalBatches) return;
			const batch = batches[batchIndex];
			const batchResult = await requestBatch(batch);

			for (const uri of batch) {
				result.set(uri, batchResult.get(uri) ?? createUnavailableContextRecord(uri));
			}

				completed += batch.length;
				const elapsedMs = performance.now() - startedAt;
				console.log(
					`Fetched remote context ${Math.min(completed, total).toLocaleString()} / ${total.toLocaleString()} (${formatRate(Math.min(completed, total), elapsedMs, 'posts')})`
				);
			}
		}

	await Promise.all(Array.from({ length: workerCount }, () => worker()));
	return result;
}

function contextRecordFromLocalPost(post: LocalPostRecord): ContextPostRecord {
	return {
		uri: post.uri,
		source: 'local',
		authorDid: null,
		authorHandle: null,
		authorDisplayName: null,
		createdAt: post.createdAt,
		text: post.text,
		surfaceText: post.surfaceText,
		externalUri: post.externalUri,
		externalTitle: post.externalTitle,
		externalDescription: post.externalDescription,
		imageAltText: post.imageAltText,
		videoAlt: post.videoAlt,
		unavailable: false
	};
}

function addSection(
	sections: string[],
	label: string,
	content: string,
	maxSectionChars: number,
	totalLimit = WINDOW_MAX_CHARS
): void {
	const normalized = normalizePostText(content);
	if (!normalized) return;

	const section = `${label}:\n${trimPreview(normalized, maxSectionChars)}`;
	const candidate = sections.length > 0 ? `${sections.join('\n\n')}\n\n${section}` : section;
	if (candidate.length > totalLimit) return;
	sections.push(section);
}

function windowTitleForPost(post: LocalPostRecord, quoteContext: ContextPostRecord | null): string {
	const source =
		post.text ||
		post.externalTitle ||
		quoteContext?.text ||
		quoteContext?.externalTitle ||
		post.surfaceText ||
		'Context window';
	return trimPreview(source, 84);
}

function quoteSectionLabel(quoteContext: ContextPostRecord): string {
	const handle = quoteContext.authorHandle ? ` by @${quoteContext.authorHandle}` : '';
	if (quoteContext.source === 'unavailable') {
		return `Quoted post${handle} (unavailable)`;
	}
	return `Quoted post${handle}`;
}

function resolveContextRecord(
	uri: string | null | undefined,
	postsByUri: Map<string, LocalPostRecord>,
	contextPostsByUri: Map<string, ContextPostRecord>
): ContextPostRecord | null {
	if (!uri) return null;
	const localPost = postsByUri.get(uri);
	if (localPost) {
		return contextRecordFromLocalPost(localPost);
	}
	return contextPostsByUri.get(uri) ?? null;
}

function buildWindowRecord(
	post: LocalPostRecord,
	postsByUri: Map<string, LocalPostRecord>,
	childrenByParentUri: Map<string, LocalPostRecord[]>,
	contextPostsByUri: Map<string, ContextPostRecord>
): WindowRecord | null {
	const sections: string[] = [];
	const quoteContext = resolveContextRecord(post.quoteTargetUri, postsByUri, contextPostsByUri);

	addSection(sections, 'Focal post', post.surfaceText || post.text, FOCAL_SECTION_MAX_CHARS);

	if (quoteContext && !quoteContext.unavailable) {
		addSection(
			sections,
			quoteSectionLabel(quoteContext),
			quoteContext.surfaceText || quoteContext.text,
			QUOTE_SECTION_MAX_CHARS
		);
	}

	const parent = resolveContextRecord(post.parentUri, postsByUri, contextPostsByUri);
	if (parent && parent.uri !== post.uri) {
		addSection(sections, 'Parent context', parent.surfaceText || parent.text, PARENT_SECTION_MAX_CHARS);
	}

	const root =
		post.threadRootUri && post.threadRootUri !== post.uri
			? resolveContextRecord(post.threadRootUri, postsByUri, contextPostsByUri)
			: null;
	if (root && root.uri !== parent?.uri && root.uri !== post.uri) {
		addSection(sections, 'Thread root', root.surfaceText || root.text, ROOT_SECTION_MAX_CHARS);
	}

	const children = (childrenByParentUri.get(post.uri) ?? []).slice(0, MAX_CHILD_CONTEXTS);
	for (let index = 0; index < children.length; index++) {
		const child = children[index];
		addSection(
			sections,
			`Direct reply ${index + 1}`,
			child.surfaceText || child.text,
			CHILD_SECTION_MAX_CHARS
		);
	}

	const text = normalizePostText(sections.join('\n\n'));
	if (!text) return null;

	return {
		windowUri: `${post.uri}#window`,
		focalPostUri: post.uri,
		threadRootUri: post.threadRootUri || post.uri,
		createdAt: post.createdAt,
		parentUri: post.parentUri,
		quoteTargetUri: post.quoteTargetUri,
		title: windowTitleForPost(post, quoteContext),
		preview: trimPreview(text, 220),
		text,
		charLength: text.length,
		byteLength: Buffer.byteLength(text, 'utf8'),
		tokenEstimate: estimateTokens(text)
	};
}

async function prepareWindowBundle(
	profile: ProfileInfo,
	parsedPosts: ParsedPost[],
	options: {
		limit: number | null;
		quoteConcurrency: number;
		existingContextPosts?: Map<string, ContextPostRecord>;
		signal?: AbortSignal;
	}
): Promise<WindowBundle> {
	const { limit, quoteConcurrency, existingContextPosts, signal } = options;
	let posts = normalizeLocalPosts(profile.did, parsedPosts);
	if (limit) {
		posts = posts.slice(0, limit);
	}

	if (posts.length === 0) {
		throw new Error(`No posts were found in ${profile.handle}'s repo.`);
	}

	const postsByUri = new Map(posts.map((post) => [post.uri, post]));
	const childrenByParentUri = new Map<string, LocalPostRecord[]>();
	for (const post of posts) {
		if (!post.parentUri) continue;
		const children = childrenByParentUri.get(post.parentUri);
		if (children) {
			children.push(post);
		} else {
			childrenByParentUri.set(post.parentUri, [post]);
		}
	}
	for (const children of childrenByParentUri.values()) {
		children.sort(comparePosts);
	}

	const quoteTargetUris = new Set<string>();
	const remoteParentTargetUris = new Set<string>();
	const remoteRootTargetUris = new Set<string>();
	for (const post of posts) {
		if (post.quoteTargetUri) {
			quoteTargetUris.add(post.quoteTargetUri);
		}
		if (post.parentUri && !postsByUri.has(post.parentUri)) {
			remoteParentTargetUris.add(post.parentUri);
		}
		if (post.threadRootUri && post.threadRootUri !== post.uri && !postsByUri.has(post.threadRootUri)) {
			remoteRootTargetUris.add(post.threadRootUri);
		}
	}

	const contextPostsByUri = new Map<string, ContextPostRecord>();
	let localQuoteHits = 0;
	const remoteQuoteTargetUris = new Set<string>();
	for (const uri of quoteTargetUris) {
		if (postsByUri.has(uri)) {
			localQuoteHits += 1;
			continue;
		}
		remoteQuoteTargetUris.add(uri);
	}

	const remoteContextUris = new Set<string>([
		...remoteQuoteTargetUris,
		...remoteParentTargetUris,
		...remoteRootTargetUris
	]);

	let reusedRemoteContexts = 0;
	if (existingContextPosts) {
		for (const uri of remoteContextUris) {
			const existingContext = existingContextPosts.get(uri);
			if (!existingContext) continue;
			contextPostsByUri.set(uri, existingContext);
			reusedRemoteContexts += 1;
		}
	}

	const missingRemoteContextUris = [...remoteContextUris].filter(
		(uri) => !contextPostsByUri.has(uri)
	);
	let fetchedRemoteContexts = 0;
	let unavailableRemoteContexts = 0;
	if (missingRemoteContextUris.length > 0) {
		console.log(
			`Resolved ${localQuoteHits.toLocaleString()} quote targets locally. Reusing ${reusedRemoteContexts.toLocaleString()} saved remote context posts and fetching ${missingRemoteContextUris.length.toLocaleString()} more (${remoteQuoteTargetUris.size.toLocaleString()} quotes, ${remoteParentTargetUris.size.toLocaleString()} parents, ${remoteRootTargetUris.size.toLocaleString()} roots) in batches of ${REMOTE_POST_BATCH_SIZE}...`
		);
		const remoteContexts = await fetchRemoteQuoteContexts(missingRemoteContextUris, {
			concurrency: quoteConcurrency,
			signal
		});
		for (const [uri, contextPost] of remoteContexts.entries()) {
			contextPostsByUri.set(uri, contextPost);
			if (contextPost.unavailable) {
				unavailableRemoteContexts += 1;
			} else {
				fetchedRemoteContexts += 1;
			}
		}
	}

	const windows = posts
		.map((post) => buildWindowRecord(post, postsByUri, childrenByParentUri, contextPostsByUri))
		.filter((window): window is WindowRecord => window !== null);

	if (windows.length === 0) {
		throw new Error(`No non-empty contextual windows were produced for ${profile.handle}.`);
	}

	return {
		posts,
		windows,
		approxInputTokens: windows.reduce((sum, window) => sum + window.tokenEstimate, 0),
		localQuoteHits,
		remoteQuoteTargets: remoteQuoteTargetUris.size,
		remoteParentTargets: remoteParentTargetUris.size,
		remoteRootTargets: remoteRootTargetUris.size,
		reusedRemoteContexts,
		fetchedRemoteContexts,
		unavailableRemoteContexts,
		contextPosts: [...contextPostsByUri.values()].sort((a, b) => a.uri.localeCompare(b.uri))
	};
}

async function pathExists(targetPath: string): Promise<boolean> {
	try {
		await access(targetPath);
		return true;
	} catch (error: any) {
		if (error?.code === 'ENOENT') {
			return false;
		}
		throw error;
	}
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

function readMeta(db: DatabaseSync, key: string): string | null {
	const row = db
		.prepare(
			`
				SELECT value
				FROM meta
				WHERE key = ?
			`
		)
		.get(key) as { value?: unknown } | undefined;
	return typeof row?.value === 'string' ? row.value : null;
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
			quote_target_uri TEXT,
			text TEXT NOT NULL,
			surface_text TEXT NOT NULL,
			external_uri TEXT,
			external_title TEXT,
			external_description TEXT,
			image_alt_text TEXT NOT NULL,
			video_alt TEXT,
			char_length INTEGER NOT NULL,
			byte_length INTEGER NOT NULL,
			token_estimate INTEGER NOT NULL
		);

		CREATE TABLE IF NOT EXISTS context_posts (
			id INTEGER PRIMARY KEY,
			uri TEXT NOT NULL UNIQUE,
			source TEXT NOT NULL,
			author_did TEXT,
			author_handle TEXT,
			author_display_name TEXT,
			created_at TEXT,
			text TEXT NOT NULL,
			surface_text TEXT NOT NULL,
			external_uri TEXT,
			external_title TEXT,
			external_description TEXT,
			image_alt_text TEXT NOT NULL,
			video_alt TEXT,
			unavailable INTEGER NOT NULL,
			fetched_at TEXT NOT NULL
		);

		CREATE TABLE IF NOT EXISTS windows (
			id INTEGER PRIMARY KEY,
			window_uri TEXT NOT NULL UNIQUE,
			focal_post_uri TEXT NOT NULL UNIQUE,
			thread_root_uri TEXT NOT NULL,
			created_at TEXT NOT NULL,
			parent_uri TEXT,
			quote_target_uri TEXT,
			title TEXT NOT NULL,
			preview TEXT NOT NULL,
			text TEXT NOT NULL,
			char_length INTEGER NOT NULL,
			byte_length INTEGER NOT NULL,
			token_estimate INTEGER NOT NULL,
			embedding_dim INTEGER,
			embedding_f32 BLOB
		);
	`);
}

function finalizeDatabase(db: DatabaseSync): void {
	db.exec(`
		CREATE INDEX IF NOT EXISTS posts_created_at_idx ON posts (created_at);
		CREATE INDEX IF NOT EXISTS posts_thread_root_uri_idx ON posts (thread_root_uri);
		CREATE INDEX IF NOT EXISTS posts_parent_uri_idx ON posts (parent_uri);
		CREATE INDEX IF NOT EXISTS posts_quote_target_uri_idx ON posts (quote_target_uri);
		CREATE INDEX IF NOT EXISTS context_posts_source_idx ON context_posts (source, unavailable);
		CREATE INDEX IF NOT EXISTS windows_created_at_idx ON windows (created_at);
		CREATE INDEX IF NOT EXISTS windows_thread_root_uri_idx ON windows (thread_root_uri);
		CREATE INDEX IF NOT EXISTS windows_quote_target_uri_idx ON windows (quote_target_uri);
		ANALYZE;
	`);
}

function hasLegacyWindowSchema(db: DatabaseSync): boolean {
	const columns = db.prepare(`PRAGMA table_info(windows)`).all() as Array<{
		name?: unknown;
		notnull?: unknown;
	}>;
	const embeddingDimColumn = columns.find((column) => column.name === 'embedding_dim');
	const embeddingBlobColumn = columns.find((column) => column.name === 'embedding_f32');
	return (
		Number(embeddingDimColumn?.notnull ?? 0) === 1 ||
		Number(embeddingBlobColumn?.notnull ?? 0) === 1
	);
}

function assertResumeCompatibility(
	db: DatabaseSync,
	profile: ProfileInfo,
	options: {
		limit: number | null;
		repoCarHash: string;
	}
): void {
	const kind = readMeta(db, 'kind');
	if (kind && kind !== 'bsky-window-embedding-db') {
		throw new Error(`Existing DB has kind=${kind}; rerun with --force to replace it.`);
	}

	const existingDid = readMeta(db, 'did');
	if (existingDid && existingDid !== profile.did) {
		throw new Error(
			`Existing DB belongs to ${existingDid}, not ${profile.did}; rerun with --force to replace it.`
		);
	}

	const existingHandle = readMeta(db, 'handle');
	if (existingHandle && existingHandle !== profile.handle) {
		throw new Error(
			`Existing DB belongs to @${existingHandle}, not @${profile.handle}; rerun with --force to replace it.`
		);
	}

	const existingNamespace = readMeta(db, 'embedding_namespace');
	if (existingNamespace && existingNamespace !== EMBEDDING_NAMESPACE) {
		throw new Error(
			`Existing DB uses embedding namespace ${existingNamespace}; rerun with --force to replace it.`
		);
	}

	const existingPooling = readMeta(db, 'embedding_pooling');
	if (existingPooling && existingPooling !== EMBEDDING_POOLING) {
		throw new Error(
			`Existing DB uses pooling=${existingPooling}; rerun with --force to replace it.`
		);
	}

	const existingStrategy = readMeta(db, 'window_strategy');
	if (existingStrategy && existingStrategy !== WINDOW_STRATEGY) {
		throw new Error(
			`Existing DB uses window strategy ${existingStrategy}; rerun with --force to replace it.`
		);
	}

	const existingLimit = readMeta(db, 'limit');
	const requestedLimit = options.limit === null ? 'all' : String(options.limit);
	if (existingLimit && existingLimit !== requestedLimit) {
		throw new Error(
			`Existing DB was built with limit=${existingLimit}, not ${requestedLimit}; rerun with --force to replace it.`
		);
	}

	const existingRepoHash = readMeta(db, 'repo_car_sha256');
	if (existingRepoHash && existingRepoHash !== options.repoCarHash) {
		throw new Error(
			'Existing DB was built from a different repo snapshot; rerun with --force to replace it.'
		);
	}

	if (hasLegacyWindowSchema(db)) {
		throw new Error(
			'Existing DB uses the old non-resumable windows schema; rerun with --force to rebuild it.'
		);
	}
}

function loadStoredContextPosts(db: DatabaseSync): Map<string, ContextPostRecord> {
	const rows = db.prepare(
		`
			SELECT
				uri,
				source,
				author_did,
				author_handle,
				author_display_name,
				created_at,
				text,
				surface_text,
				external_uri,
				external_title,
				external_description,
				image_alt_text,
				video_alt,
				unavailable
			FROM context_posts
		`
	).all() as Array<Record<string, unknown>>;

	return new Map(
		rows.map((row) => [
			String(row.uri),
			{
				uri: String(row.uri),
				source:
					row.source === 'local' || row.source === 'remote' || row.source === 'unavailable'
						? row.source
						: 'remote',
				authorDid: toMaybeString(row.author_did),
				authorHandle: toMaybeString(row.author_handle),
				authorDisplayName: toMaybeString(row.author_display_name),
				createdAt: toMaybeString(row.created_at),
				text: typeof row.text === 'string' ? row.text : '',
				surfaceText: typeof row.surface_text === 'string' ? row.surface_text : '',
				externalUri: toMaybeString(row.external_uri),
				externalTitle: toMaybeString(row.external_title),
				externalDescription: toMaybeString(row.external_description),
				imageAltText: typeof row.image_alt_text === 'string' ? row.image_alt_text : '',
				videoAlt: toMaybeString(row.video_alt),
				unavailable: Number(row.unavailable ?? 0) === 1
			} satisfies ContextPostRecord
		])
	);
}

function countWindowProgress(db: DatabaseSync): {
	total: number;
	embedded: number;
	pending: number;
} {
	const row = db
		.prepare(
			`
				SELECT
					COUNT(*) AS total,
					COALESCE(SUM(CASE WHEN embedding_f32 IS NOT NULL THEN 1 ELSE 0 END), 0) AS embedded
				FROM windows
			`
		)
		.get() as { total?: unknown; embedded?: unknown };
	const total = Number(row.total ?? 0);
	const embedded = Number(row.embedded ?? 0);
	return {
		total,
		embedded,
		pending: Math.max(0, total - embedded)
	};
}

function countTableRows(db: DatabaseSync, tableName: 'posts' | 'context_posts' | 'windows'): number {
	const row = db
		.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`)
		.get() as { count?: unknown };
	return Number(row.count ?? 0);
}

function insertPosts(db: DatabaseSync, profile: ProfileInfo, posts: LocalPostRecord[]): void {
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
			quote_target_uri,
			text,
			surface_text,
			external_uri,
			external_title,
			external_description,
			image_alt_text,
			video_alt,
			char_length,
			byte_length,
			token_estimate
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(uri) DO UPDATE SET
			did = excluded.did,
			handle = excluded.handle,
			rkey = excluded.rkey,
			cid = excluded.cid,
			created_at = excluded.created_at,
			parent_uri = excluded.parent_uri,
			thread_root_uri = excluded.thread_root_uri,
			is_reply = excluded.is_reply,
			quote_target_uri = excluded.quote_target_uri,
			text = excluded.text,
			surface_text = excluded.surface_text,
			external_uri = excluded.external_uri,
			external_title = excluded.external_title,
			external_description = excluded.external_description,
			image_alt_text = excluded.image_alt_text,
			video_alt = excluded.video_alt,
			char_length = excluded.char_length,
			byte_length = excluded.byte_length,
			token_estimate = excluded.token_estimate
	`);

	db.exec('BEGIN');
	try {
		for (const post of posts) {
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
				post.quoteTargetUri,
				post.text,
				post.surfaceText,
				post.externalUri,
				post.externalTitle,
				post.externalDescription,
				post.imageAltText,
				post.videoAlt,
				post.charLength,
				post.byteLength,
				post.tokenEstimate
			);
		}
		db.exec('COMMIT');
	} catch (error) {
		db.exec('ROLLBACK');
		throw error;
	}
}

function insertContextPosts(db: DatabaseSync, contextPosts: ContextPostRecord[]): void {
	const now = new Date().toISOString();
	const insertContextPost = db.prepare(`
		INSERT INTO context_posts (
			uri,
			source,
			author_did,
			author_handle,
			author_display_name,
			created_at,
			text,
			surface_text,
			external_uri,
			external_title,
			external_description,
			image_alt_text,
			video_alt,
			unavailable,
			fetched_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(uri) DO UPDATE SET
			source = excluded.source,
			author_did = excluded.author_did,
			author_handle = excluded.author_handle,
			author_display_name = excluded.author_display_name,
			created_at = excluded.created_at,
			text = excluded.text,
			surface_text = excluded.surface_text,
			external_uri = excluded.external_uri,
			external_title = excluded.external_title,
			external_description = excluded.external_description,
			image_alt_text = excluded.image_alt_text,
			video_alt = excluded.video_alt,
			unavailable = excluded.unavailable,
			fetched_at = excluded.fetched_at
	`);

	db.exec('BEGIN');
	try {
		for (const contextPost of contextPosts) {
			insertContextPost.run(
				contextPost.uri,
				contextPost.source,
				contextPost.authorDid,
				contextPost.authorHandle,
				contextPost.authorDisplayName,
				contextPost.createdAt,
				contextPost.text,
				contextPost.surfaceText,
				contextPost.externalUri,
				contextPost.externalTitle,
				contextPost.externalDescription,
				contextPost.imageAltText,
				contextPost.videoAlt,
				contextPost.unavailable ? 1 : 0,
				now
			);
		}
		db.exec('COMMIT');
	} catch (error) {
		db.exec('ROLLBACK');
		throw error;
	}
}

function insertWindowShells(db: DatabaseSync, windows: WindowRecord[]): void {
	const insertWindow = db.prepare(`
		INSERT INTO windows (
			window_uri,
			focal_post_uri,
			thread_root_uri,
			created_at,
			parent_uri,
			quote_target_uri,
			title,
			preview,
			text,
			char_length,
			byte_length,
			token_estimate,
			embedding_dim,
			embedding_f32
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
		ON CONFLICT(focal_post_uri) DO UPDATE SET
			window_uri = excluded.window_uri,
			thread_root_uri = excluded.thread_root_uri,
			created_at = excluded.created_at,
			parent_uri = excluded.parent_uri,
			quote_target_uri = excluded.quote_target_uri,
			title = excluded.title,
			preview = excluded.preview,
			text = excluded.text,
			char_length = excluded.char_length,
			byte_length = excluded.byte_length,
			token_estimate = excluded.token_estimate,
			embedding_dim = CASE
				WHEN windows.text = excluded.text AND windows.embedding_f32 IS NOT NULL THEN windows.embedding_dim
				ELSE NULL
			END,
			embedding_f32 = CASE
				WHEN windows.text = excluded.text AND windows.embedding_f32 IS NOT NULL THEN windows.embedding_f32
				ELSE NULL
			END
	`);

	db.exec('BEGIN');
	try {
		for (const window of windows) {
			insertWindow.run(
				window.windowUri,
				window.focalPostUri,
				window.threadRootUri,
				window.createdAt,
				window.parentUri,
				window.quoteTargetUri,
				window.title,
				window.preview,
				window.text,
				window.charLength,
				window.byteLength,
				window.tokenEstimate
			);
		}
		db.exec('COMMIT');
	} catch (error) {
		db.exec('ROLLBACK');
		throw error;
	}
}

function selectPendingWindows(db: DatabaseSync): PendingWindowRow[] {
	const rows = db.prepare(
		`
			SELECT
				w.window_uri,
				w.focal_post_uri,
				w.thread_root_uri,
				w.created_at,
				w.parent_uri,
				w.quote_target_uri,
				w.title,
				w.preview,
				w.text,
				w.char_length,
				w.byte_length,
				w.token_estimate,
				w.embedding_dim,
				p.text AS focal_text,
				p.surface_text AS focal_surface_text
			FROM windows w
			JOIN posts p
				ON p.uri = w.focal_post_uri
			WHERE w.embedding_f32 IS NULL
			ORDER BY w.created_at ASC, w.focal_post_uri ASC
		`
	).all() as Array<Record<string, unknown>>;

	return rows.map((row) => ({
		windowUri: String(row.window_uri),
		focalPostUri: String(row.focal_post_uri),
		threadRootUri: String(row.thread_root_uri),
		createdAt: String(row.created_at),
		parentUri: toMaybeString(row.parent_uri),
		quoteTargetUri: toMaybeString(row.quote_target_uri),
		title: typeof row.title === 'string' ? row.title : '',
		preview: typeof row.preview === 'string' ? row.preview : '',
		text: typeof row.text === 'string' ? row.text : '',
		charLength: Number(row.char_length ?? 0),
		byteLength: Number(row.byte_length ?? 0),
		tokenEstimate: Number(row.token_estimate ?? 0),
		embeddingDim: row.embedding_dim == null ? null : Number(row.embedding_dim),
		focalText: typeof row.focal_text === 'string' ? row.focal_text : '',
		focalSurfaceText: typeof row.focal_surface_text === 'string' ? row.focal_surface_text : ''
	}));
}

async function logFailedWindowBatch(
	logPath: string,
	batchIndex: number,
	windows: PendingWindowRow[],
	error: unknown
): Promise<void> {
	const errorMessage = error instanceof Error ? error.message : String(error);
	const timestamp = new Date().toISOString();
	const parts: string[] = [
		`=== ${timestamp} batch ${batchIndex + 1} failure ===`,
		`error: ${errorMessage}`,
		`windows: ${windows.length}`
	];

	for (const window of windows) {
		parts.push(
			[
				'---',
				`focal_post_uri: ${window.focalPostUri}`,
				`thread_root_uri: ${window.threadRootUri}`,
				`parent_uri: ${window.parentUri ?? ''}`,
				`quote_target_uri: ${window.quoteTargetUri ?? ''}`,
				`title: ${window.title}`,
				`char_length: ${window.charLength}`,
				`byte_length: ${window.byteLength}`,
				`token_estimate: ${window.tokenEstimate}`,
				'focal_post:',
				window.focalSurfaceText || window.focalText || '(empty)',
				'window_text:',
				window.text || '(empty)'
			].join('\n')
		);
	}

	parts.push('');
	await appendFile(logPath, `${parts.join('\n')}\n`, 'utf8');
}

async function buildWindowEmbeddingDb(
	profile: ProfileInfo,
	outputPath: string,
	options: {
		accountId: string;
		apiToken: string;
		batchSize: number;
		concurrency: number;
		quoteConcurrency: number;
		limit: number | null;
		force: boolean;
		signal?: AbortSignal;
	}
): Promise<void> {
	const { accountId, apiToken, batchSize, concurrency, quoteConcurrency, limit, force, signal } = options;

	console.log(`Resolving repo for ${profile.handle} (${profile.did})...`);
	const repoDownload = await downloadRepoCar(profile.did, signal);
	console.log(
		`Repo download complete via ${repoDownload.source.toUpperCase()} in ${formatDuration(repoDownload.elapsedMs)} (${formatBytes(repoDownload.downloadedBytes)}).`
	);

	const carHash = sha256Hex(repoDownload.carBytes);
	const parsedPosts = await parseRepoPostsFromCar(repoDownload.carBytes);

	const resolvedOutputPath = path.resolve(process.cwd(), outputPath);
	const failureLogPath = `${resolvedOutputPath}.failures.log`;
	await mkdir(path.dirname(resolvedOutputPath), { recursive: true });
	if (force) {
		await rm(resolvedOutputPath, { force: true });
		await rm(failureLogPath, { force: true });
	}
	const dbAlreadyExists = await pathExists(resolvedOutputPath);
	const db = new DatabaseSync(resolvedOutputPath);
	const startedAt = performance.now();

	try {
		initializeDatabase(db);
		if (dbAlreadyExists) {
			console.log(`Resuming existing DB at ${resolvedOutputPath}...`);
			assertResumeCompatibility(db, profile, {
				limit,
				repoCarHash: carHash
			});
		}

		const existingContextPosts = loadStoredContextPosts(db);
		const bundle = await prepareWindowBundle(profile, parsedPosts, {
			limit,
			quoteConcurrency,
			existingContextPosts,
			signal
		});

		console.log(
			`Prepared ${bundle.windows.length.toLocaleString()} contextual windows from ${bundle.posts.length.toLocaleString()} posts (~${bundle.approxInputTokens.toLocaleString()} estimated tokens).`
		);
		console.log(
			`Context fetch: ${bundle.localQuoteHits.toLocaleString()} quotes resolved locally, ${bundle.reusedRemoteContexts.toLocaleString()} remote context posts reused, ${bundle.fetchedRemoteContexts.toLocaleString()} fetched, ${bundle.unavailableRemoteContexts.toLocaleString()} unavailable.`
		);

		upsertMeta(db, 'schema_version', String(SCHEMA_VERSION));
		upsertMeta(db, 'kind', 'bsky-window-embedding-db');
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
		upsertMeta(db, 'window_strategy', WINDOW_STRATEGY);
		upsertMeta(db, 'window_max_chars', String(WINDOW_MAX_CHARS));
		upsertMeta(db, 'max_child_contexts', String(MAX_CHILD_CONTEXTS));
		upsertMeta(db, 'approx_input_tokens', String(bundle.approxInputTokens));
		upsertMeta(db, 'batch_size', String(batchSize));
		upsertMeta(db, 'concurrency', String(concurrency));
		upsertMeta(db, 'quote_concurrency', String(quoteConcurrency));
		upsertMeta(db, 'limit', limit === null ? 'all' : String(limit));
		upsertMeta(db, 'posts_scanned', String(parsedPosts.length));
		upsertMeta(db, 'posts_selected', String(bundle.posts.length));
		upsertMeta(db, 'window_count', String(bundle.windows.length));
		upsertMeta(db, 'quote_target_count', String(bundle.localQuoteHits + bundle.remoteQuoteTargets));
		upsertMeta(db, 'quote_local_hit_count', String(bundle.localQuoteHits));
		upsertMeta(db, 'quote_remote_target_count', String(bundle.remoteQuoteTargets));
		upsertMeta(db, 'remote_parent_target_count', String(bundle.remoteParentTargets));
		upsertMeta(db, 'remote_root_target_count', String(bundle.remoteRootTargets));
		upsertMeta(db, 'remote_context_reused_count', String(bundle.reusedRemoteContexts));
		upsertMeta(
			db,
			'remote_context_target_count',
			String(bundle.reusedRemoteContexts + bundle.fetchedRemoteContexts + bundle.unavailableRemoteContexts)
		);
		upsertMeta(db, 'remote_context_fetched_count', String(bundle.fetchedRemoteContexts));
		upsertMeta(db, 'remote_context_unavailable_count', String(bundle.unavailableRemoteContexts));
		upsertMeta(db, 'output_filename', path.basename(resolvedOutputPath));
		upsertMeta(db, 'failure_log_path', failureLogPath);
		upsertMeta(db, 'build_status', 'running');
		upsertMeta(db, 'build_started_at', new Date().toISOString());
		upsertMeta(db, 'last_error_message', '');

		insertPosts(db, profile, bundle.posts);
		insertContextPosts(db, bundle.contextPosts);
		insertWindowShells(db, bundle.windows);

		const progressBefore = countWindowProgress(db);
		console.log(
			`Checkpointed ${countTableRows(db, 'posts').toLocaleString()} posts, ${countTableRows(db, 'context_posts').toLocaleString()} context posts, and ${progressBefore.total.toLocaleString()} windows. ${progressBefore.embedded.toLocaleString()} embeddings already present; ${progressBefore.pending.toLocaleString()} pending.`
		);

		const pendingWindows = selectPendingWindows(db);
		const batches = chunk(pendingWindows, batchSize);
		let nextBatchIndex = 0;
		let embeddedThisRun = 0;
		let vectorDim = Number(readMeta(db, 'embedding_dim') ?? 0) || 0;
		const updateWindowEmbedding = db.prepare(`
			UPDATE windows
			SET embedding_dim = ?, embedding_f32 = ?
			WHERE focal_post_uri = ?
		`);

		if (pendingWindows.length === 0) {
			console.log('All contextual windows already have embeddings; skipping Workers AI requests.');
		}

		async function worker(): Promise<void> {
			while (true) {
				throwIfAborted(signal);
				const batchIndex = nextBatchIndex++;
				if (batchIndex >= batches.length) return;

				const windowBatch = batches[batchIndex];
				try {
					const result = await requestEmbeddingsWithRetry(
						accountId,
						apiToken,
						windowBatch.map((window) => window.text),
						signal
					);

					if (result.pooling && result.pooling !== EMBEDDING_POOLING) {
						throw new Error(
							`Workers AI returned pooling=${result.pooling}, expected ${EMBEDDING_POOLING}.`
						);
					}

					if (result.vectors.length !== windowBatch.length) {
						throw new Error(
							`Workers AI returned ${result.vectors.length} embeddings for a batch of ${windowBatch.length} windows.`
						);
					}

					db.exec('BEGIN');
					try {
						for (let index = 0; index < windowBatch.length; index++) {
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

							const window = windowBatch[index];
							updateWindowEmbedding.run(vector.length, vectorToBlob(vector), window.focalPostUri);
						}
						db.exec('COMMIT');
					} catch (error) {
						db.exec('ROLLBACK');
						throw error;
					}
				} catch (error) {
					await logFailedWindowBatch(failureLogPath, batchIndex, windowBatch, error);
					try {
						upsertMeta(db, 'build_status', 'failed');
						upsertMeta(db, 'last_error_at', new Date().toISOString());
						upsertMeta(
							db,
							'last_error_message',
							error instanceof Error ? error.message : String(error)
						);
					} catch {
						// Best effort while unwinding after a failed batch.
					}
					throw error;
				}

				embeddedThisRun += windowBatch.length;
				const currentProgress = countWindowProgress(db);
				upsertMeta(db, 'embedded_windows', String(currentProgress.embedded));
				const elapsedMs = performance.now() - startedAt;
				console.log(
					`Embedded ${currentProgress.embedded.toLocaleString()} / ${currentProgress.total.toLocaleString()} windows (${formatRate(embeddedThisRun, elapsedMs, 'windows')})`
				);
			}
		}

		if (batches.length > 0) {
			await Promise.all(
				Array.from({ length: Math.max(1, Math.min(concurrency, batches.length)) }, () => worker())
			);
		}

		finalizeDatabase(db);
		const finalProgress = countWindowProgress(db);
		upsertMeta(db, 'embedded_windows', String(finalProgress.embedded));
		upsertMeta(db, 'embedded_posts', String(countTableRows(db, 'posts')));
		upsertMeta(db, 'embedded_context_posts', String(countTableRows(db, 'context_posts')));
		upsertMeta(db, 'build_status', 'complete');
		upsertMeta(db, 'last_completed_at', new Date().toISOString());
		upsertMeta(db, 'generated_at', new Date().toISOString());
		upsertMeta(db, 'last_error_message', '');

		const totalElapsedMs = performance.now() - startedAt;
		console.log(
			`SQLite DB updated at ${resolvedOutputPath} with ${finalProgress.embedded.toLocaleString()} / ${finalProgress.total.toLocaleString()} embedded windows in ${formatDuration(totalElapsedMs)}.`
		);
	} catch (error) {
		try {
			upsertMeta(db, 'build_status', 'failed');
			upsertMeta(db, 'last_error_at', new Date().toISOString());
			upsertMeta(db, 'last_error_message', error instanceof Error ? error.message : String(error));
		} catch {
			// Best effort while unwinding.
		}
		throw error;
	} finally {
		try {
			db.close();
		} catch {
			// Best effort.
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
		await buildWindowEmbeddingDb(profile, outputPath, {
			accountId,
			apiToken,
			batchSize: cli.batchSize,
			concurrency: cli.concurrency,
			quoteConcurrency: cli.quoteConcurrency,
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
	console.error(error?.message || 'Window embedding DB build failed.');
	if (error?.stack) {
		console.error(error.stack);
	}
	process.exitCode = 1;
});
