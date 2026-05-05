import type { AuthorInfo } from '$lib/types';
import {
	fetchPostThread,
	fetchPostEngagementCounts,
	type PostEngagementProgress
} from '$lib/api/bluesky';
import type { ParsedPost } from '$lib/utils/carParser';
import { parseCarPostsWasm } from '$lib/utils/carParserWasm';
import { resolvePds } from '$lib/utils/pdsResolver';
import { repoPostsToFeedItems } from '$lib/utils/repoToFeed';
import { buildThreadsFromFeed } from '$lib/utils/threadWalker';

const ENGAGEMENT_BATCH_SIZE = 25;
const MIN_THREAD_FETCH_POSTS = 26;

export interface RepoDownloadProgress {
	receivedBytes: number;
	totalBytes: number;
	elapsedMs: number;
	bytesPerSecond: number;
}

export interface RepoCarDownloadResult {
	carBytes: Uint8Array;
	elapsedMs: number;
	downloadedBytes: number;
	totalBytes: number;
	source: 'pds' | 'relay';
}

export interface RepoFeedLoadResult {
	feedItems: any[];
	parsedPosts: ParsedPost[];
	totalPosts: number;
	elapsedMs: number;
	downloadedBytes: number;
	totalBytes: number;
	source: 'pds' | 'relay';
}

type EngagementCounts = {
	uri: string;
	likeCount: number;
	repostCount: number;
	replyCount: number;
	quoteCount: number;
	indexedAt: string;
};

type ThreadFetchCandidate = {
	fetchUri: string;
	targetUris: Set<string>;
};

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) {
		throw new DOMException('Aborted', 'AbortError');
	}
}

function collectThreadUris(node: { uri: string; children: any[] }, target: Set<string>): void {
	target.add(node.uri);
	for (const child of node.children) {
		collectThreadUris(child, target);
	}
}

function buildThreadFetchCandidates(
	feedItems: any[],
	minThreadFetchPosts: number
): ThreadFetchCandidate[] {
	const authorDid = feedItems.find((item) => typeof item?.post?.author?.did === 'string')?.post?.author?.did;
	if (typeof authorDid !== 'string' || authorDid.length === 0) {
		return [];
	}

	const { threads, orphanToTrueRoot } = buildThreadsFromFeed(feedItems, authorDid);
	const groupedTargets = new Map<string, Set<string>>();

	for (const thread of threads) {
		const fetchUri = orphanToTrueRoot.get(thread.rootUri) ?? thread.rootUri;
		let targetUris = groupedTargets.get(fetchUri);
		if (!targetUris) {
			targetUris = new Set<string>();
			groupedTargets.set(fetchUri, targetUris);
		}
		collectThreadUris(thread.rootPost, targetUris);
	}

	return [...groupedTargets.entries()]
		.filter(([, targetUris]) => targetUris.size >= minThreadFetchPosts)
		.sort((a, b) => b[1].size - a[1].size)
		.map(([fetchUri, targetUris]) => ({ fetchUri, targetUris }));
}

function harvestThreadCounts(
	node: any,
	targetUris: Set<string>,
	result: Map<string, EngagementCounts>
): void {
	if (!node || node.$type !== 'app.bsky.feed.defs#threadViewPost' || !node.post) return;

	const post = node.post;
	if (typeof post.uri === 'string' && targetUris.has(post.uri) && !result.has(post.uri)) {
		result.set(post.uri, {
			uri: post.uri,
			likeCount: Number.isFinite(Number(post.likeCount)) ? Math.max(0, Math.round(Number(post.likeCount))) : 0,
			repostCount:
				Number.isFinite(Number(post.repostCount)) ? Math.max(0, Math.round(Number(post.repostCount))) : 0,
			replyCount: Number.isFinite(Number(post.replyCount)) ? Math.max(0, Math.round(Number(post.replyCount))) : 0,
			quoteCount: Number.isFinite(Number(post.quoteCount)) ? Math.max(0, Math.round(Number(post.quoteCount))) : 0,
			indexedAt: typeof post.indexedAt === 'string' ? post.indexedAt : ''
		});
	}

	for (const reply of node.replies ?? []) {
		harvestThreadCounts(reply, targetUris, result);
	}
}

async function fetchThreadCandidateCounts(
	candidates: ThreadFetchCandidate[],
	options: {
		signal?: AbortSignal;
		threadConcurrency?: number;
		onProgress?: (progress: PostEngagementProgress) => void;
		totalUris?: number;
	}
): Promise<Map<string, EngagementCounts>> {
	const { signal, threadConcurrency = 2, onProgress, totalUris = 0 } = options;
	const result = new Map<string, EngagementCounts>();
	if (candidates.length === 0) return result;

	const totalBatches = candidates.length;
	const workerCount = Math.min(Math.max(1, Math.floor(threadConcurrency)), candidates.length);
	let nextIndex = 0;
	let batchesCompleted = 0;

	async function worker(): Promise<void> {
		while (true) {
			throwIfAborted(signal);
			const candidateIndex = nextIndex++;
			if (candidateIndex >= candidates.length) return;
			const candidate = candidates[candidateIndex];

			try {
				const rawThread = await fetchPostThread(candidate.fetchUri);
				harvestThreadCounts(rawThread, candidate.targetUris, result);
			} catch {
				// Ignore failed thread fetches and let the fallback batch path fill any misses.
			}

			batchesCompleted += 1;
			onProgress?.({
				completed: Math.min(result.size, totalUris || result.size),
				total: totalUris || result.size,
				batchesCompleted,
				totalBatches
			});
		}
	}

	await Promise.all(Array.from({ length: workerCount }, () => worker()));
	return result;
}

export async function downloadRepoCar(
	did: string,
	options: {
		collection?: string | null;
		signal?: AbortSignal;
		onDownloadProgress?: (progress: RepoDownloadProgress) => void;
	} = {}
): Promise<RepoCarDownloadResult> {
	const { collection, signal, onDownloadProgress } = options;
	const repoParams = new URLSearchParams({ did });
	if (collection) {
		repoParams.set('collection', collection);
	}
	const repoHeaders = { Accept: 'application/vnd.ipld.car' };
	const startTime = performance.now();

	throwIfAborted(signal);

	let res: Response | null = null;
	let source: 'pds' | 'relay' = 'relay';
	const pdsEndpoint = await resolvePds(did);
	if (pdsEndpoint) {
		try {
			const pdsRes = await fetch(`${pdsEndpoint}/xrpc/com.atproto.sync.getRepo?${repoParams.toString()}`, {
				headers: repoHeaders,
				signal
			});
			if (pdsRes.ok) {
				res = pdsRes;
				source = 'pds';
			}
		} catch {
			// Fall through to relay.
		}
	}

	if (!res) {
		res = await fetch(`https://bsky.network/xrpc/com.atproto.sync.getRepo?${repoParams.toString()}`, {
			headers: repoHeaders,
			signal
		});
		source = 'relay';
	}

	if (!res.ok) {
		const errorText = await res.text().catch(() => 'Unknown error');
		throw new Error(`Repository download failed (${res.status}): ${errorText}`);
	}

	const totalBytes = parseInt(res.headers.get('content-length') || '0', 10);
	const reader = res.body?.getReader();
	if (!reader) {
		throw new Error('Response body is not readable');
	}

	const chunks: Uint8Array[] = [];
	let downloadedBytes = 0;
	let lastSpeedUpdate = startTime;
	let lastSpeedBytes = 0;

	while (true) {
		throwIfAborted(signal);
		const { done, value } = await reader.read();
		if (done) break;
		chunks.push(value);
		downloadedBytes += value.length;

		const now = performance.now();
		if (!onDownloadProgress) continue;
		if (now - lastSpeedUpdate < 250 && totalBytes > 0 && downloadedBytes < totalBytes) continue;

		const elapsedMs = now - startTime;
		const deltaMs = Math.max(1, now - lastSpeedUpdate);
		onDownloadProgress({
			receivedBytes: downloadedBytes,
			totalBytes,
			elapsedMs,
			bytesPerSecond: ((downloadedBytes - lastSpeedBytes) / deltaMs) * 1000
		});
		lastSpeedUpdate = now;
		lastSpeedBytes = downloadedBytes;
	}

	onDownloadProgress?.({
		receivedBytes: downloadedBytes,
		totalBytes,
		elapsedMs: performance.now() - startTime,
		bytesPerSecond: 0
	});

	const carBytes = new Uint8Array(downloadedBytes);
	let offset = 0;
	for (const chunk of chunks) {
		carBytes.set(chunk, offset);
		offset += chunk.length;
	}

	return {
		carBytes,
		elapsedMs: Math.round(performance.now() - startTime),
		downloadedBytes,
		totalBytes,
		source
	};
}

export async function loadRepoFeedItems(
	did: string,
	author: AuthorInfo,
	options: {
		signal?: AbortSignal;
		onDownloadProgress?: (progress: RepoDownloadProgress) => void;
		onParseProgress?: (parsedPosts: number) => void;
	} = {}
): Promise<RepoFeedLoadResult> {
	const { signal, onDownloadProgress, onParseProgress } = options;
	const download = await downloadRepoCar(did, {
		collection: 'app.bsky.feed.post',
		signal,
		onDownloadProgress
	});

	const parsedPosts = await parseCarPostsWasm(download.carBytes, (count) => {
		onParseProgress?.(count);
	});
	throwIfAborted(signal);

	return {
		feedItems: repoPostsToFeedItems(did, parsedPosts, author),
		parsedPosts,
		totalPosts: parsedPosts.length,
		elapsedMs: download.elapsedMs,
		downloadedBytes: download.downloadedBytes,
		totalBytes: download.totalBytes,
		source: download.source
	};
}

export async function hydrateFeedItemsEngagement(
	feedItems: any[],
	options: {
		signal?: AbortSignal;
		concurrency?: number;
		threadConcurrency?: number;
		minThreadFetchPosts?: number;
		onProgress?: (progress: PostEngagementProgress) => void;
	} = {}
): Promise<{ hydratedCount: number; missingCount: number }> {
	const { signal, concurrency, threadConcurrency, minThreadFetchPosts = MIN_THREAD_FETCH_POSTS, onProgress } = options;
	const uris = [...new Set(feedItems.map((item) => item?.post?.uri).filter((uri): uri is string => typeof uri === 'string' && uri.length > 0))];
	const totalUris = uris.length;
	const countsByUri = new Map<string, EngagementCounts>();
	const threadCandidates = buildThreadFetchCandidates(feedItems, minThreadFetchPosts);

	const threadCountsByUri = await fetchThreadCandidateCounts(threadCandidates, {
		signal,
		threadConcurrency,
		onProgress,
		totalUris
	});
	for (const [uri, counts] of threadCountsByUri) {
		countsByUri.set(uri, counts);
	}

	const fallbackUris = uris.filter((uri) => !countsByUri.has(uri));
	const threadBatchCount = threadCandidates.length;
	const fallbackBatchCount = Math.ceil(fallbackUris.length / ENGAGEMENT_BATCH_SIZE);

	if (fallbackUris.length > 0) {
		const fallbackCountsByUri = await fetchPostEngagementCounts(fallbackUris, {
			signal,
			concurrency,
			onProgress: ({ completed, total, batchesCompleted }) => {
				onProgress?.({
					completed: Math.min(countsByUri.size + completed, totalUris),
					total: totalUris,
					batchesCompleted: threadBatchCount + batchesCompleted,
					totalBatches: threadBatchCount + Math.max(fallbackBatchCount, Math.ceil(total / ENGAGEMENT_BATCH_SIZE))
				});
			}
		});
		for (const [uri, counts] of fallbackCountsByUri) {
			countsByUri.set(uri, counts);
		}
	} else {
		onProgress?.({
			completed: totalUris,
			total: totalUris,
			batchesCompleted: threadBatchCount,
			totalBatches: threadBatchCount
		});
	}
	throwIfAborted(signal);

	let hydratedCount = 0;
	for (const item of feedItems) {
		const uri = item?.post?.uri;
		if (typeof uri !== 'string') continue;
		const counts = countsByUri.get(uri);
		if (!counts) continue;

		if (item.post) {
			item.post.likeCount = counts.likeCount;
			item.post.repostCount = counts.repostCount;
			item.post.replyCount = counts.replyCount;
			item.post.quoteCount = counts.quoteCount;
			if (counts.indexedAt) {
				item.post.indexedAt = counts.indexedAt;
			}
		}

		hydratedCount += 1;
	}

	return {
		hydratedCount,
		missingCount: Math.max(0, uris.length - countsByUri.size)
	};
}
