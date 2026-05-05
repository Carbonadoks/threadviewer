import type { RequestHandler } from '@sveltejs/kit';
import { readCachedPostPrefix } from '$lib/server/postCache';
import type {
	GlobalDistinctivenessAnalysis,
	RunningNoveltyAnalysis,
	SelfReplyThread,
	ThreadAnalysisPost,
	ThreadAnalysisSegment,
	ThreadAnalysisResult
} from '$lib/types';
import {
	averageEmbeddings,
	buildThreadAnalysisDocument,
	projectEmbeddings,
	clusterCoordinates,
	normalizeVector
} from '$lib/utils/threadAnalysis';
import { buildThreadsFromFeed } from '$lib/utils/threadWalker';

const BLUESKY_API = 'https://public.api.bsky.app';
const MAX_POSTS = 1000;
const MAX_ANALYZED_THREADS = 12;
const MAX_SEGMENTS_PER_THREAD = 2;
const MAX_CLUSTER_SEGMENT_BUDGET = 10;
const MAX_EMBEDDING_CACHE_WRITES = 8;
const EMBEDDING_MODEL = '@cf/baai/bge-small-en-v1.5';
const EMBEDDING_POOLING = 'cls';
const EMBEDDING_CACHE_NAMESPACE = 'cf-bge-small-en-v1.5-cls';
const EMBEDDING_LABEL = `${EMBEDDING_MODEL} (${EMBEDDING_POOLING})`;
const EMBEDDING_BATCH_SIZE = 20;
const EMBEDDING_MAX_RETRIES = 4;
const EMBEDDING_BASE_DELAY_MS = 800;
const FIRST_NOVELTY_VALUE = 0;
const ANALYSIS_CACHE_VERSION = 'v3';
const ANALYSIS_CACHE_INDEX_KEY = `analysis-index/${ANALYSIS_CACHE_VERSION}/${EMBEDDING_CACHE_NAMESPACE}.json`;
const GLOBAL_DISTINCTIVENESS_LABEL = 'Global analyzer centroid';
const GLOBAL_CENTROID_CACHE_KEY = `global-centroid/${ANALYSIS_CACHE_VERSION}/${EMBEDDING_CACHE_NAMESPACE}.json`;

interface AnalysisCacheIndexEntry {
	did: string;
	updatedAt: string;
	maxPosts: number;
}

interface AnalysisCacheIndex {
	accounts: AnalysisCacheIndexEntry[];
}

interface EmbeddingCacheRecord {
	model: string;
	values: number[];
	createdAt: string;
}

interface GlobalCentroidCacheRecord {
	model: string;
	comparedTo: string;
	sampleCount: number;
	centroid: number[];
	updatedAt: string;
}

interface EmbedResult {
	vectors: Array<number[] | null>;
	cacheHits: number;
	cacheMisses: number;
	usedBatchApi: boolean;
	rateLimited: boolean;
	warning?: string;
}

interface ThreadDocument {
	thread: SelfReplyThread;
	posts: ThreadAnalysisPost[];
	text: string;
	title: string;
	preview: string;
	segments: string[];
}

interface NoveltySegment {
	index: number;
	uri: string;
	rootUri: string;
	createdAt: string;
	title: string;
	text: string;
	vector: number[] | null;
}

interface BatchThreadPayload {
	rootUri: string;
	depth: number;
	postCount: number;
	segmentCount: number;
	globalDistinctiveness: number | null;
	title: string;
	preview: string;
	text: string;
	posts: ThreadAnalysisPost[];
	segments: ThreadAnalysisSegment[];
	embedding: number[];
}

interface BatchSegmentPayload {
	uri: string;
	rootUri: string;
	createdAt: string;
	title: string;
	text: string;
	embedding: number[];
}

interface AnalyzerBatchResponse extends ThreadAnalysisResult {
	batch: {
		threadOffset: number;
		nextThreadOffset: number;
		hasMore: boolean;
		totalThreads: number;
		threads: BatchThreadPayload[];
		segments: BatchSegmentPayload[];
		stats: ThreadAnalysisResult['stats'];
	};
}

type GlobalDistinctivenessThread = {
	rootUri: string;
	title: string;
	preview: string;
	embedding: number[];
};

function buildThreadSegments(document: ThreadDocument): ThreadAnalysisSegment[] {
	return document.segments.map((text, index) => ({
		index: index + 1,
		uri: segmentUri(document, index),
		createdAt: segmentTimestamp(document, index),
		text
	}));
}

function analysisCacheKey(
	did: string,
	maxPosts: number,
	threadOffset: number
): string {
	return [
		'analysis',
		ANALYSIS_CACHE_VERSION,
		EMBEDDING_CACHE_NAMESPACE,
		did,
		`posts-${maxPosts}`,
		`offset-${threadOffset}.json`
	].join('/');
}

async function readCachedAnalysisBatch(
	bucket: R2Bucket | undefined,
	key: string
): Promise<AnalyzerBatchResponse | null> {
	if (!bucket) return null;
	const object = await bucket.get(key);
	if (!object) return null;

	try {
		const payload = (await object.json()) as AnalyzerBatchResponse;
		if (
			!payload?.batch ||
			!Array.isArray(payload?.points) ||
			payload.model !== EMBEDDING_LABEL
		) {
			return null;
		}
		return payload;
	} catch {
		return null;
	}
}

async function writeCachedAnalysisBatch(
	bucket: R2Bucket | undefined,
	key: string,
	payload: AnalyzerBatchResponse,
	meta: {
		did: string;
		maxPosts: number;
	}
): Promise<void> {
	if (!bucket) return;

	await bucket.put(key, JSON.stringify(payload), {
		httpMetadata: { contentType: 'application/json' }
	});

	await updateAnalysisCacheIndex(bucket, {
		did: meta.did,
		updatedAt: payload.generatedAt,
		maxPosts: meta.maxPosts
	});
}

async function readAnalysisCacheIndex(bucket: R2Bucket): Promise<AnalysisCacheIndex> {
	const object = await bucket.get(ANALYSIS_CACHE_INDEX_KEY);
	if (!object) {
		return { accounts: [] };
	}

	try {
		const payload = (await object.json()) as AnalysisCacheIndex;
		if (!Array.isArray(payload?.accounts)) {
			return { accounts: [] };
		}
		return payload;
	} catch {
		return { accounts: [] };
	}
}

async function writeAnalysisCacheIndex(
	bucket: R2Bucket,
	index: AnalysisCacheIndex
): Promise<void> {
	await bucket.put(ANALYSIS_CACHE_INDEX_KEY, JSON.stringify(index), {
		httpMetadata: { contentType: 'application/json' }
	});
}

async function updateAnalysisCacheIndex(
	bucket: R2Bucket,
	entry: {
		did: string;
		updatedAt: string;
		maxPosts: number;
	}
): Promise<void> {
	const index = await readAnalysisCacheIndex(bucket);
	const existing = index.accounts.find((account) => account.did === entry.did);

	if (existing) {
		existing.updatedAt = entry.updatedAt;
		existing.maxPosts = Math.max(existing.maxPosts, entry.maxPosts);
	} else {
		index.accounts.push({
			did: entry.did,
			updatedAt: entry.updatedAt,
			maxPosts: entry.maxPosts
		});
	}

	index.accounts.sort(
		(a, b) =>
			new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime() ||
			a.did.localeCompare(b.did)
	);

	await writeAnalysisCacheIndex(bucket, index);
}

async function listAllObjects(bucket: R2Bucket, prefix: string): Promise<R2Object[]> {
	const objects: R2Object[] = [];
	let cursor: string | undefined;

	while (true) {
		const listing = await bucket.list({ prefix, cursor });
		objects.push(...listing.objects);

		if (!listing.truncated || !listing.cursor) {
			break;
		}

		cursor = listing.cursor;
	}

	return objects;
}

async function readGlobalCentroidCache(
	bucket: R2Bucket | undefined
): Promise<GlobalCentroidCacheRecord | null> {
	if (!bucket) return null;

	const object = await bucket.get(GLOBAL_CENTROID_CACHE_KEY);
	if (!object) return null;

	try {
		const payload = (await object.json()) as GlobalCentroidCacheRecord;
		if (
			payload?.model !== EMBEDDING_LABEL ||
			!Array.isArray(payload?.centroid) ||
			!Number.isFinite(payload?.sampleCount) ||
			payload.sampleCount <= 0
		) {
			return null;
		}

		return payload;
	} catch {
		return null;
	}
}

async function writeGlobalCentroidCache(
	bucket: R2Bucket | undefined,
	payload: GlobalCentroidCacheRecord
): Promise<void> {
	if (!bucket) return;

	await bucket.put(GLOBAL_CENTROID_CACHE_KEY, JSON.stringify(payload), {
		httpMetadata: { contentType: 'application/json' }
	});
}

function extendGlobalCentroid(
	current: GlobalCentroidCacheRecord | null,
	vectors: number[][]
): GlobalCentroidCacheRecord | null {
	const normalizedVectors = vectors
		.filter((vector) => Array.isArray(vector) && vector.length > 0)
		.map((vector) => normalizeVector(vector));

	if (normalizedVectors.length === 0) {
		return current;
	}

	let sampleCount = current?.sampleCount ?? 0;
	let centroid = current ? current.centroid.slice() : normalizedVectors[0].slice();
	let startIndex = current ? 0 : 1;

	if (!current) {
		sampleCount = 1;
	}

	for (let index = startIndex; index < normalizedVectors.length; index++) {
		const vector = normalizedVectors[index];
		const nextCount = sampleCount + 1;

		for (let axis = 0; axis < centroid.length; axis++) {
			centroid[axis] = (sampleCount * centroid[axis] + vector[axis]) / nextCount;
		}

		sampleCount = nextCount;
	}

	return {
		model: EMBEDDING_LABEL,
		comparedTo: GLOBAL_DISTINCTIVENESS_LABEL,
		sampleCount,
		centroid,
		updatedAt: new Date().toISOString()
	};
}

async function buildGlobalCentroidCacheFromAnalysisBatches(
	bucket: R2Bucket | undefined
): Promise<GlobalCentroidCacheRecord | null> {
	if (!bucket) return null;

	const objects = await listAllObjects(
		bucket,
		`analysis/${ANALYSIS_CACHE_VERSION}/${EMBEDDING_CACHE_NAMESPACE}/`
	);

	let cache: GlobalCentroidCacheRecord | null = null;

	for (const object of objects) {
		const stored = await bucket.get(object.key);
		if (!stored) continue;

		try {
			const payload = (await stored.json()) as AnalyzerBatchResponse;
			const vectors =
				Array.isArray(payload?.batch?.segments)
					? payload.batch.segments
							.map((segment) => segment?.embedding)
							.filter((vector): vector is number[] => Array.isArray(vector))
					: [];

			cache = extendGlobalCentroid(cache, vectors);
		} catch {
			// Ignore malformed cached batches.
		}
	}

	return cache;
}

async function getGlobalCentroidCache(
	bucket: R2Bucket | undefined
): Promise<GlobalCentroidCacheRecord | null> {
	const cached = await readGlobalCentroidCache(bucket);
	if (cached) {
		return cached;
	}

	const rebuilt = await buildGlobalCentroidCacheFromAnalysisBatches(bucket);
	if (!rebuilt) {
		return null;
	}

	try {
		await writeGlobalCentroidCache(bucket, rebuilt);
	} catch {
		// Best-effort cache write.
	}

	return rebuilt;
}

async function updateGlobalCentroidCacheWithSegments(
	bucket: R2Bucket | undefined,
	segments: BatchSegmentPayload[]
): Promise<void> {
	if (!bucket || segments.length === 0) return;

	const existing = await readGlobalCentroidCache(bucket);
	const next = extendGlobalCentroid(
		existing,
		segments
			.map((segment) => segment.embedding)
			.filter((vector): vector is number[] => Array.isArray(vector))
	);

	if (!next) return;
	await writeGlobalCentroidCache(bucket, next);
}

function isQuotaError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return /\b429\b/.test(message) || /quota/i.test(message) || /rate.?limit/i.test(message);
}

function isRetryableStatus(status: number): boolean {
	return status === 429 || status >= 500;
}

function backoffDelayMs(attempt: number): number {
	const exponential = EMBEDDING_BASE_DELAY_MS * 2 ** attempt;
	const jitter = Math.floor(Math.random() * 250);
	return Math.min(8000, exponential + jitter);
}

async function sleep(ms: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, ms));
}

function jsonResponse(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: {
			'Content-Type': 'application/json; charset=utf-8'
		}
	});
}

function parseMaxPosts(value: unknown): number {
	const parsed = Number.parseInt(String(value ?? MAX_POSTS), 10);
	if (!Number.isFinite(parsed)) return MAX_POSTS;
	return Math.min(Math.max(parsed, 1), MAX_POSTS);
}

function appendWarning(current: string | undefined, next: string | undefined): string | undefined {
	if (!next) return current;
	if (!current) return next;
	if (current.includes(next)) return current;
	return `${current} ${next}`;
}

async function fetchBlueskyFeed(
	did: string,
	cursor?: string
): Promise<{ feed: any[]; cursor?: string }> {
	const params = new URLSearchParams({
		actor: did,
		filter: 'posts_with_replies',
		limit: '100'
	});
	if (cursor) params.set('cursor', cursor);

	const response = await fetch(`${BLUESKY_API}/xrpc/app.bsky.feed.getAuthorFeed?${params}`);
	if (!response.ok) {
		const text = await response.text();
		throw new Error(`Bluesky API error ${response.status}: ${text}`);
	}

	const data: any = await response.json();
	return {
		feed: data.feed || [],
		cursor: data.cursor
	};
}

async function readCachedFeedPosts(
	bucket: R2Bucket | undefined,
	did: string,
	maxPosts: number,
	options: { allowPartial?: boolean } = {}
): Promise<any[] | null> {
	const cached = await readCachedPostPrefix(bucket, did, maxPosts, options);
	return cached?.posts ?? null;
}

async function fetchFirstFeedPosts(
	did: string,
	bucket: R2Bucket | undefined,
	maxPosts: number,
	options: { fetchEnabled?: boolean } = {}
): Promise<any[]> {
	const fetchEnabled = options.fetchEnabled !== false;
	const cached = await readCachedFeedPosts(bucket, did, maxPosts, {
		allowPartial: !fetchEnabled
	});
	if (cached) return cached;
	if (!fetchEnabled) return [];

	const posts: any[] = [];
	let cursor: string | undefined;

	while (posts.length < maxPosts) {
		const result = await fetchBlueskyFeed(did, cursor);
		if (result.feed.length === 0) break;
		posts.push(...result.feed);
		if (!result.cursor) break;
		cursor = result.cursor;
	}

	if (posts.length > maxPosts) {
		posts.length = maxPosts;
	}

	return posts;
}

async function sha256Hex(value: string): Promise<string> {
	const encoded = new TextEncoder().encode(value);
	const digest = await crypto.subtle.digest('SHA-256', encoded);
	return Array.from(new Uint8Array(digest))
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('');
}

async function readCachedEmbedding(
	bucket: R2Bucket | undefined,
	hash: string
): Promise<number[] | null> {
	if (!bucket) return null;
	const object = await bucket.get(`embeddings/${EMBEDDING_CACHE_NAMESPACE}/${hash}.json`);
	if (!object) return null;

	const payload = (await object.json()) as EmbeddingCacheRecord;
	if (!Array.isArray(payload.values) || payload.model !== EMBEDDING_LABEL) {
		return null;
	}

	return payload.values;
}

async function writeCachedEmbedding(
	bucket: R2Bucket | undefined,
	hash: string,
	values: number[]
): Promise<void> {
	if (!bucket) return;

	const payload: EmbeddingCacheRecord = {
		model: EMBEDDING_LABEL,
		values,
		createdAt: new Date().toISOString()
	};

	await bucket.put(
		`embeddings/${EMBEDDING_CACHE_NAMESPACE}/${hash}.json`,
		JSON.stringify(payload),
		{
			httpMetadata: { contentType: 'application/json' }
		}
	);
}

function extractEmbeddingValues(payload: any): number[][] {
	if (!Array.isArray(payload?.data)) {
		throw new Error('Workers AI response did not include embeddings.');
	}

	const vectors = payload.data;
	if (vectors.some((vector: unknown) => !Array.isArray(vector))) {
		throw new Error('Workers AI returned an invalid embedding payload.');
	}

	return vectors;
}

async function requestWorkersAiEmbeddings(
	ai: Ai,
	texts: string[],
	errorPrefix: string
): Promise<any> {
	for (let attempt = 0; attempt <= EMBEDDING_MAX_RETRIES; attempt++) {
		try {
			return await ai.run(EMBEDDING_MODEL, {
				text: texts,
				pooling: EMBEDDING_POOLING
			});
		} catch (error) {
			if (attempt < EMBEDDING_MAX_RETRIES) {
				const message = error instanceof Error ? error.message : String(error);
				if (
					isQuotaError(error) ||
					/fetch/i.test(message) ||
					/network/i.test(message) ||
					/internal/i.test(message) ||
					/temporary/i.test(message)
				) {
					await sleep(backoffDelayMs(attempt));
					continue;
				}
			}

			throw new Error(`${errorPrefix}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	throw new Error(`${errorPrefix}: retries exhausted`);
}

async function requestBatchEmbeddings(ai: Ai, texts: string[]): Promise<number[][]> {
	const payload = await requestWorkersAiEmbeddings(ai, texts, 'Workers AI batch embed failed');

	return extractEmbeddingValues(payload);
}

function dotProduct(a: number[], b: number[]): number {
	let total = 0;
	const length = Math.min(a.length, b.length);
	for (let i = 0; i < length; i++) {
		total += a[i] * b[i];
	}
	return total;
}

function emptyGlobalDistinctivenessAnalysis(): GlobalDistinctivenessAnalysis {
	return {
		model: EMBEDDING_LABEL,
		comparedTo: GLOBAL_DISTINCTIVENESS_LABEL,
		available: false,
		corpusSize: 0,
		threadsCompared: 0,
		averageDistinctiveness: 0,
		maxDistinctiveness: 0,
		points: []
	};
}

function buildGlobalDistinctivenessAnalysis(
	threads: GlobalDistinctivenessThread[],
	centroidCache: GlobalCentroidCacheRecord | null
): {
	analysis: GlobalDistinctivenessAnalysis;
	byRootUri: Map<string, number | null>;
} {
	const byRootUri = new Map<string, number | null>();

	if (
		!centroidCache ||
		!Array.isArray(centroidCache.centroid) ||
		centroidCache.centroid.length === 0 ||
		centroidCache.sampleCount <= 0
	) {
		for (const thread of threads) {
			byRootUri.set(thread.rootUri, null);
		}

		return {
			analysis: emptyGlobalDistinctivenessAnalysis(),
			byRootUri
		};
	}

	const centroidUnit = normalizeVector(centroidCache.centroid);
	let total = 0;
	let maxDistinctiveness = 0;
	const points: GlobalDistinctivenessAnalysis['points'] = [];

	for (const thread of threads) {
		const normalized = normalizeVector(thread.embedding);
		const cosine = Math.max(-1, Math.min(1, dotProduct(normalized, centroidUnit)));
		const score = 1 - cosine;

		byRootUri.set(thread.rootUri, score);
		points.push({
			rootUri: thread.rootUri,
			score,
			title: thread.title,
			preview: thread.preview
		});

		total += score;
		maxDistinctiveness = Math.max(maxDistinctiveness, score);
	}

	return {
		analysis: {
			model: EMBEDDING_LABEL,
			comparedTo: centroidCache.comparedTo || GLOBAL_DISTINCTIVENESS_LABEL,
			available: true,
			corpusSize: centroidCache.sampleCount,
			threadsCompared: threads.length,
			averageDistinctiveness: threads.length > 0 ? total / threads.length : 0,
			maxDistinctiveness,
			points
		},
		byRootUri
	};
}

function payloadHasGlobalDistinctiveness(payload: AnalyzerBatchResponse): boolean {
	const analysis = payload.globalDistinctiveness;
	const threads = payload.batch?.threads;

	return (
		!!analysis &&
		Array.isArray(analysis.points) &&
		Array.isArray(threads) &&
		threads.every(
			(thread) =>
				typeof thread?.globalDistinctiveness === 'number' ||
				thread?.globalDistinctiveness === null
		)
	);
}

function applyGlobalDistinctivenessToPayload(
	payload: AnalyzerBatchResponse,
	centroidCache: GlobalCentroidCacheRecord | null
): AnalyzerBatchResponse {
	const batchThreads = Array.isArray(payload.batch?.threads) ? payload.batch.threads : [];

	const { analysis, byRootUri } = buildGlobalDistinctivenessAnalysis(
		batchThreads.map((thread) => ({
			rootUri: thread.rootUri,
			title: thread.title,
			preview: thread.preview,
			embedding: thread.embedding
		})),
		centroidCache
	);

	return {
		...payload,
		points: payload.points.map((point) => ({
			...point,
			globalDistinctiveness: byRootUri.get(point.rootUri) ?? null
		})),
		globalDistinctiveness: analysis,
		batch: payload.batch
			? {
					...payload.batch,
					threads: batchThreads.map((thread) => ({
						...thread,
						globalDistinctiveness: byRootUri.get(thread.rootUri) ?? null
					}))
				}
			: payload.batch
	};
}

async function embedTexts(
	texts: string[],
	bucket: R2Bucket | undefined,
	ai: Ai | undefined,
	options: { fetchEnabled?: boolean } = {}
): Promise<EmbedResult> {
	const fetchEnabled = options.fetchEnabled !== false;
	const results = new Array<number[] | null>(texts.length).fill(null);
	const entries = await Promise.all(
		texts.map(async (text, index) => ({
			index,
			text,
			hash: await sha256Hex(text)
		}))
	);

	const grouped = new Map<string, { text: string; indices: number[] }>();
	for (const entry of entries) {
		const existing = grouped.get(entry.hash);
		if (existing) {
			existing.indices.push(entry.index);
			continue;
		}
		grouped.set(entry.hash, { text: entry.text, indices: [entry.index] });
	}

	let cacheHits = 0;
	let cacheMisses = 0;
	let usedBatchApi = true;
	let rateLimited = false;
	let warning: string | undefined;
	let cacheWrites = 0;
	const vectorsByHash = new Map<string, number[]>();
	const missing: Array<{ hash: string; text: string }> = [];

	for (const [hash, entry] of grouped) {
		const cached = await readCachedEmbedding(bucket, hash);
		if (cached) {
			cacheHits += entry.indices.length;
			vectorsByHash.set(hash, cached);
			continue;
		}

		cacheMisses += entry.indices.length;
		missing.push({ hash, text: entry.text });
	}

	if (missing.length > 0 && fetchEnabled && !ai) {
		throw new Error('Cloudflare Workers AI binding is missing and the requested embeddings are not cached.');
	}

	if (missing.length > 0 && fetchEnabled) {
		for (let i = 0; i < missing.length; i += EMBEDDING_BATCH_SIZE) {
			const batch = missing.slice(i, i + EMBEDDING_BATCH_SIZE);
			let vectors: number[][] | null = null;
			let batchFailed = false;

			try {
				vectors = await requestBatchEmbeddings(
					ai!,
					batch.map((item) => item.text)
				);
			} catch (error) {
				if (isQuotaError(error)) {
					rateLimited = true;
					warning =
						'Workers AI rate limits persisted after retry backoff. Returning only threads already cached in R2.';
					break;
				}
				warning = appendWarning(
					warning,
					'Workers AI embedding failed, so live embedding was skipped for the remaining uncached segments.'
				);
				batchFailed = true;
			}

			if (rateLimited) {
				break;
			}

			if (!vectors && batchFailed) {
				break;
			}

			if (!vectors) {
				continue;
			}

			for (let j = 0; j < batch.length; j++) {
				const vector = vectors[j];
				if (!Array.isArray(vector)) {
					if (rateLimited) break;
					throw new Error('Workers AI returned fewer embeddings than requested.');
				}

				vectorsByHash.set(batch[j].hash, vector);
				if (cacheWrites < MAX_EMBEDDING_CACHE_WRITES) {
					try {
						await writeCachedEmbedding(bucket, batch[j].hash, vector);
						cacheWrites += 1;
					} catch {
						// Best-effort cache write.
					}
				}
			}
		}
	}

	for (const [hash, entry] of grouped) {
		for (const index of entry.indices) {
			results[index] = vectorsByHash.get(hash) ?? null;
		}
	}

	return {
		vectors: results,
		cacheHits,
		cacheMisses,
		usedBatchApi,
		rateLimited,
		warning
	};
}

function emptyNoveltyAnalysis(): RunningNoveltyAnalysis {
	return {
		model: EMBEDDING_LABEL,
		firstValue: FIRST_NOVELTY_VALUE,
		postsConsidered: 0,
		postsAnalyzed: 0,
		skippedForCache: 0,
		averageNovelty: 0,
		maxNovelty: 0,
		latestNovelty: 0,
		points: []
	};
}

function segmentTimestamp(document: ThreadDocument, index: number): string {
	const post = document.posts[Math.min(index, Math.max(0, document.posts.length - 1))];
	return post?.createdAt || document.thread.rootPost.createdAt || '';
}

function segmentUri(document: ThreadDocument, index: number): string {
	const post = document.posts[Math.min(index, Math.max(0, document.posts.length - 1))];
	return post?.uri || document.thread.rootUri;
}

function buildNoveltySegments(
	documents: ThreadDocument[],
	embeddedVectors: Array<number[] | null>
): NoveltySegment[] {
	const segments: NoveltySegment[] = [];
	let offset = 0;

	for (const document of documents) {
		for (let segmentIndex = 0; segmentIndex < document.segments.length; segmentIndex++) {
			segments.push({
				index: segments.length + 1,
				uri: segmentUri(document, segmentIndex),
				rootUri: document.thread.rootUri,
				createdAt: segmentTimestamp(document, segmentIndex),
				title: document.title,
				text: document.segments[segmentIndex],
				vector: embeddedVectors[offset + segmentIndex] ?? null
			});
		}

		offset += document.segments.length;
	}

	return segments.sort(
		(a, b) =>
			new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime() ||
			a.rootUri.localeCompare(b.rootUri) ||
			a.index - b.index
	);
}

function buildRunningNoveltyAnalysis(segments: NoveltySegment[]): RunningNoveltyAnalysis {
	if (segments.length === 0) {
		return emptyNoveltyAnalysis();
	}

	const points: RunningNoveltyAnalysis['points'] = [];
	let centroid: number[] | null = null;
	let analyzedCount = 0;
	let noveltyTotal = 0;
	let maxNovelty = 0;
	let latestNovelty = 0;
	let skippedForCache = 0;

	for (let i = 0; i < segments.length; i++) {
		const segment = segments[i];
		if (!segment.vector) {
			skippedForCache += 1;
			continue;
		}

		const normalized = normalizeVector(segment.vector);
		let novelty = FIRST_NOVELTY_VALUE;

		if (centroid) {
			const centroidUnit = normalizeVector(centroid);
			const cosine = Math.max(-1, Math.min(1, dotProduct(normalized, centroidUnit)));
			novelty = 1 - cosine;
		}

		points.push({
			index: i + 1,
			uri: segment.uri,
			rootUri: segment.rootUri,
			createdAt: segment.createdAt,
			novelty,
			title: segment.title,
			text: segment.text
		});

		const nextCount = analyzedCount + 1;
		noveltyTotal += novelty;
		maxNovelty = Math.max(maxNovelty, novelty);
		latestNovelty = novelty;

		if (!centroid) {
			centroid = normalized.slice();
		} else {
			for (let j = 0; j < centroid.length; j++) {
				centroid[j] = (analyzedCount * centroid[j] + normalized[j]) / nextCount;
			}
		}

		analyzedCount = nextCount;
	}

	return {
		model: EMBEDDING_LABEL,
		firstValue: FIRST_NOVELTY_VALUE,
		postsConsidered: segments.length,
		postsAnalyzed: analyzedCount,
		skippedForCache,
		averageNovelty: analyzedCount > 0 ? noveltyTotal / analyzedCount : 0,
		maxNovelty,
		latestNovelty,
		points
	};
}

export const POST: RequestHandler = async ({ request, platform }) => {
	try {
		const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
		const did = typeof body?.did === 'string' ? body.did.trim() : '';
		const maxPosts = parseMaxPosts(body?.maxPosts);
		const fetchEnabled = platform?.env?.FETCH !== '0';
		const threadOffset = Math.max(
			0,
			Number.parseInt(String(body?.threadOffset ?? 0), 10) || 0
		);

		if (!did) {
			return jsonResponse({ message: 'A Bluesky DID is required.' }, 400);
		}

		const bucket = platform?.env?.POST_CACHE;
		const ai = platform?.env?.AI;
		const fetchDisabledWarning = fetchEnabled
			? undefined
			: 'FETCH=0 disables live Bluesky and AI fetches. Showing only cached data.';
		const cachedAnalysisKey = analysisCacheKey(did, maxPosts, threadOffset);
		const cachedAnalysis = await readCachedAnalysisBatch(bucket, cachedAnalysisKey);
		if (cachedAnalysis) {
			let responsePayload = cachedAnalysis;

			if (!payloadHasGlobalDistinctiveness(cachedAnalysis)) {
				const centroidCache = await getGlobalCentroidCache(bucket);
				responsePayload = applyGlobalDistinctivenessToPayload(cachedAnalysis, centroidCache);

				try {
					await writeCachedAnalysisBatch(bucket, cachedAnalysisKey, responsePayload, {
						did,
						maxPosts
					});
				} catch {
					// Best-effort cache upgrade.
				}
			}

			if (!fetchEnabled) {
				return jsonResponse({
					...responsePayload,
					warning: appendWarning(fetchDisabledWarning, responsePayload.warning)
				});
			}
			return jsonResponse(responsePayload);
		}

		const feedPosts = await fetchFirstFeedPosts(did, bucket, maxPosts, {
			fetchEnabled
		});

		const { threads: rawThreads } = buildThreadsFromFeed(feedPosts, did);
		const hydratedThreads = rawThreads;
		const replyThreads = hydratedThreads
			.filter((thread) => thread.depth >= 2)
			.sort((a, b) => b.depth - a.depth);

		const documents: ThreadDocument[] = [];
		let remainingSegmentBudget = MAX_CLUSTER_SEGMENT_BUDGET;
		let nextThreadOffset = threadOffset;

		for (let index = threadOffset; index < replyThreads.length; index++) {
			if (documents.length >= MAX_ANALYZED_THREADS || remainingSegmentBudget <= 0) {
				nextThreadOffset = index;
				break;
			}

			const thread = replyThreads[index];
			nextThreadOffset = index + 1;

			const segmentLimit = Math.min(MAX_SEGMENTS_PER_THREAD, remainingSegmentBudget);
			const document: ThreadDocument = {
				thread,
				...buildThreadAnalysisDocument(thread, segmentLimit)
			};

			if (document.posts.length === 0 || document.segments.length === 0) {
				continue;
			}

			documents.push(document);
			remainingSegmentBudget -= document.segments.length;
		}

		const hasMore = nextThreadOffset < replyThreads.length;

		const clusterWarning =
			hasMore
				? 'Thread clustering is loading in batches to stay within Cloudflare worker request limits.'
				: undefined;

		if (documents.length === 0) {
			const emptyResult: ThreadAnalysisResult = {
				model: EMBEDDING_LABEL,
				usedBatchApi: true,
				rateLimited: false,
				warning: appendWarning(fetchDisabledWarning, clusterWarning),
				generatedAt: new Date().toISOString(),
				points: [],
				novelty: emptyNoveltyAnalysis(),
				globalDistinctiveness: emptyGlobalDistinctivenessAnalysis(),
				stats: {
					postsScanned: feedPosts.length,
					chainStarts: hydratedThreads.length,
					threadsWithSelfReplies: replyThreads.length,
					threadsAnalyzed: 0,
					segmentCount: 0,
					cacheHits: 0,
					cacheMisses: 0,
					skippedForCache: 0
				}
			};
			const responsePayload: AnalyzerBatchResponse = {
				...emptyResult,
				batch: {
					threadOffset,
					nextThreadOffset,
					hasMore,
					totalThreads: replyThreads.length,
					threads: [] as BatchThreadPayload[],
					segments: [] as BatchSegmentPayload[],
					stats: emptyResult.stats
				}
			};
			try {
				await writeCachedAnalysisBatch(bucket, cachedAnalysisKey, responsePayload, {
					did,
					maxPosts
				});
			} catch {
				// Best-effort cache write.
			}
			return jsonResponse(responsePayload);
		}

		const segmentTexts = documents.flatMap((document) => document.segments);
		const embedded = await embedTexts(segmentTexts, bucket, ai, { fetchEnabled });

		let offset = 0;
		let skippedForCache = 0;
		const analyzedDocuments: typeof documents = [];
		const threadEmbeddings: number[][] = [];
		const noveltyVectors: Array<number[] | null> = [];

		for (const document of documents) {
			const vectors = embedded.vectors.slice(offset, offset + document.segments.length);
			offset += document.segments.length;
			const resolved = vectors.filter((vector): vector is number[] => Array.isArray(vector));

			if (resolved.length !== document.segments.length) {
				skippedForCache += 1;
				continue;
			}

			analyzedDocuments.push(document);
			threadEmbeddings.push(averageEmbeddings(resolved));
			noveltyVectors.push(...resolved);
		}

		const novelty = buildRunningNoveltyAnalysis(
			buildNoveltySegments(analyzedDocuments, noveltyVectors)
		);
		const globalCentroid =
			analyzedDocuments.length > 0 ? await getGlobalCentroidCache(bucket) : null;
		const globalDistinctiveness = buildGlobalDistinctivenessAnalysis(
			analyzedDocuments.map((document, index) => ({
				rootUri: document.thread.rootUri,
				title: document.title,
				preview: document.preview,
				embedding: threadEmbeddings[index]
			})),
			globalCentroid
		);
		const batchThreads: BatchThreadPayload[] = analyzedDocuments.map((document, index) => ({
			rootUri: document.thread.rootUri,
			depth: document.thread.depth,
			postCount: document.posts.length,
			segmentCount: document.segments.length,
			globalDistinctiveness:
				globalDistinctiveness.byRootUri.get(document.thread.rootUri) ?? null,
			title: document.title,
			preview: document.preview,
			text: document.text,
			posts: document.posts,
			segments: buildThreadSegments(document),
			embedding: threadEmbeddings[index]
		}));
		const batchSegments: BatchSegmentPayload[] = buildNoveltySegments(
			analyzedDocuments,
			noveltyVectors
		)
			.filter((segment): segment is NoveltySegment & { vector: number[] } => Array.isArray(segment.vector))
			.map((segment) => ({
				uri: segment.uri,
				rootUri: segment.rootUri,
				createdAt: segment.createdAt,
				title: segment.title,
				text: segment.text,
				embedding: segment.vector
			}));

		if (analyzedDocuments.length === 0) {
			const emptyResult: ThreadAnalysisResult = {
				model: EMBEDDING_LABEL,
				usedBatchApi: embedded.usedBatchApi,
				rateLimited: embedded.rateLimited,
				warning: appendWarning(
					appendWarning(embedded.warning, fetchDisabledWarning),
					clusterWarning
				),
				generatedAt: new Date().toISOString(),
				points: [],
				novelty,
				globalDistinctiveness: emptyGlobalDistinctivenessAnalysis(),
				stats: {
					postsScanned: feedPosts.length,
					chainStarts: hydratedThreads.length,
					threadsWithSelfReplies: replyThreads.length,
					threadsAnalyzed: 0,
					segmentCount: segmentTexts.length,
					cacheHits: embedded.cacheHits,
					cacheMisses: embedded.cacheMisses,
					skippedForCache
				}
			};
			const responsePayload: AnalyzerBatchResponse = {
				...emptyResult,
				batch: {
					threadOffset,
					nextThreadOffset,
					hasMore,
					totalThreads: replyThreads.length,
					threads: batchThreads,
					segments: batchSegments,
					stats: emptyResult.stats
				}
			};
			let batchCached = false;
			try {
				await writeCachedAnalysisBatch(bucket, cachedAnalysisKey, responsePayload, {
					did,
					maxPosts
				});
				batchCached = true;
			} catch {
				// Best-effort cache write.
			}
			if (batchCached) {
				try {
					await updateGlobalCentroidCacheWithSegments(bucket, batchSegments);
				} catch {
					// Best-effort centroid cache update.
				}
			}
			return jsonResponse(responsePayload);
		}

		const coordinates = projectEmbeddings(threadEmbeddings);
		const clusters = clusterCoordinates(coordinates);

		const result: ThreadAnalysisResult = {
			model: EMBEDDING_LABEL,
			usedBatchApi: embedded.usedBatchApi,
			rateLimited: embedded.rateLimited,
			warning: appendWarning(
				appendWarning(embedded.warning, fetchDisabledWarning),
				clusterWarning
			),
			generatedAt: new Date().toISOString(),
			points: analyzedDocuments.map((document, index) => ({
				rootUri: document.thread.rootUri,
				depth: document.thread.depth,
				postCount: document.posts.length,
				segmentCount: document.segments.length,
				globalDistinctiveness:
					globalDistinctiveness.byRootUri.get(document.thread.rootUri) ?? null,
				x: coordinates[index]?.x ?? 0,
				y: coordinates[index]?.y ?? 0,
				cluster: clusters[index] ?? 0,
				title: document.title,
				preview: document.preview,
				text: document.text,
				posts: document.posts,
				segments: buildThreadSegments(document)
			})),
			novelty,
			globalDistinctiveness: globalDistinctiveness.analysis,
			stats: {
				postsScanned: feedPosts.length,
				chainStarts: hydratedThreads.length,
				threadsWithSelfReplies: replyThreads.length,
				threadsAnalyzed: analyzedDocuments.length,
				segmentCount: segmentTexts.length,
				cacheHits: embedded.cacheHits,
				cacheMisses: embedded.cacheMisses,
				skippedForCache
			}
		};

		const responsePayload: AnalyzerBatchResponse = {
			...result,
			batch: {
				threadOffset,
				nextThreadOffset,
				hasMore,
				totalThreads: replyThreads.length,
				threads: batchThreads,
				segments: batchSegments,
				stats: result.stats
			}
		};
		let batchCached = false;
		try {
			await writeCachedAnalysisBatch(bucket, cachedAnalysisKey, responsePayload, {
				did,
				maxPosts
			});
			batchCached = true;
		} catch {
			// Best-effort cache write.
		}
		if (batchCached) {
			try {
				await updateGlobalCentroidCacheWithSegments(bucket, batchSegments);
			} catch {
				// Best-effort centroid cache update.
			}
		}
		return jsonResponse(responsePayload);
	} catch (error: any) {
		return jsonResponse(
			{ message: error?.message || 'Failed to analyze this account.' },
			500
		);
	}
};
