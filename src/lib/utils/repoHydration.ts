import type { AuthorInfo } from '$lib/types';
import {
	fetchReplyParentVisibility,
	fetchPostThread,
	fetchPostEngagementCounts,
	type PostEngagementProgress,
	type ReplyParentVisibility
} from '$lib/api/bluesky';
import type { ParsedPost } from '$lib/utils/carParser';
import { parseCarPostsWasm } from '$lib/utils/carParserWasm';
import { resolvePds } from '$lib/utils/pdsResolver';
import { repoPostsToFeedItems } from '$lib/utils/repoToFeed';
import { buildThreadsFromFeed } from '$lib/utils/threadWalker';

const ENGAGEMENT_BATCH_SIZE = 25;
const MIN_THREAD_FETCH_POSTS = 26;
const BLOCK_COLLECTION = 'app.bsky.graph.block';
const BLOCK_LIST_PAGE_LIMIT = 100;

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

export interface RepoBlockListLoadResult {
	blockedDids: Set<string>;
	totalBlocks: number;
	elapsedMs: number;
	downloadedBytes: number;
	totalBytes: number;
	source: 'pds' | 'appview';
	pages: number;
}

export interface RepoRecordListProgress {
	pages: number;
	records: number;
	downloadedBytes: number;
	source: 'pds' | 'appview';
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

type ReplyParentCandidate = {
	uri: string;
	parentUri: string;
	rootUri: string;
	text: string;
	createdAt: string;
	likeCount: number;
	repostCount: number;
	replyCount: number;
	quoteCount: number;
};

export interface BlockedParentReply {
	uri: string;
	parentUri: string;
	rootUri: string;
	text: string;
	createdAt: string;
	likeCount: number;
	repostCount: number;
	replyCount: number;
	quoteCount: number;
	parentVisibility: ReplyParentVisibility['visibility'];
	parentAuthorDid: string | null;
	parentItemType: string;
	parentText: string;
	parentCreatedAt: string;
	parentInRepo: boolean;
	parentBlockedByRepoOwner: boolean;
}

export interface BlockedParentReplyScanStats {
	scannedReplyCount: number;
	candidateParentCount: number;
	visibleParentCount: number;
	hiddenParentCount: number;
	checkedThreadCount: number;
	blockedParentCount: number;
	unresolvedParentCount: number;
}

export interface BlockedParentReplyScanResult extends BlockedParentReplyScanStats {
	allReplies: BlockedParentReply[];
	replies: BlockedParentReply[];
	hiddenReplies: BlockedParentReply[];
}

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) {
		throw new DOMException('Aborted', 'AbortError');
	}
}

function toFiniteCount(value: unknown): number {
	if (!Number.isFinite(Number(value))) return 0;
	return Math.max(0, Math.round(Number(value)));
}

function toText(value: unknown): string {
	return typeof value === 'string' ? value : '';
}

function encodedJsonByteLength(value: string): number {
	return new TextEncoder().encode(value).byteLength;
}

function compareIsoDesc(a: string, b: string): number {
	const aTime = Date.parse(a);
	const bTime = Date.parse(b);
	return (Number.isFinite(bTime) ? bTime : 0) - (Number.isFinite(aTime) ? aTime : 0);
}

function readReplyParentCandidate(item: any): ReplyParentCandidate | null {
	const uri = toText(item?.post?.uri);
	const parentUri = toText(item?.post?.record?.reply?.parent?.uri);
	if (!uri || !parentUri) return null;

	return {
		uri,
		parentUri,
		rootUri: toText(item?.post?.record?.reply?.root?.uri) || parentUri,
		text: toText(item?.post?.record?.text),
		createdAt: toText(item?.post?.record?.createdAt) || toText(item?.post?.indexedAt),
		likeCount: toFiniteCount(item?.post?.likeCount),
		repostCount: toFiniteCount(item?.post?.repostCount),
		replyCount: toFiniteCount(item?.post?.replyCount),
		quoteCount: toFiniteCount(item?.post?.quoteCount)
	};
}

function didFromAtUri(uri: string): string | null {
	const match = uri.match(/^at:\/\/([^/]+)\//);
	return match?.[1] ?? null;
}

function fallbackParentVisibility(parentUri: string): ReplyParentVisibility {
	return {
		parentUri,
		visibility: 'unknown',
		parentAuthorDid: didFromAtUri(parentUri),
		itemType: '',
		parentText: null,
		parentCreatedAt: null
	};
}

function repoParentVisibility(parentUri: string, parentItem: any | null): ReplyParentVisibility {
	return {
		parentUri,
		visibility: 'visible',
		parentAuthorDid: didFromAtUri(parentUri),
		itemType: 'repo-parent',
		parentText: toText(parentItem?.post?.record?.text),
		parentCreatedAt:
			toText(parentItem?.post?.record?.createdAt) || toText(parentItem?.post?.indexedAt) || null
	};
}

function toBlockedParentReply(
	candidate: ReplyParentCandidate,
	status: ReplyParentVisibility,
	parentInRepo = false,
	blockedDids: ReadonlySet<string> = new Set()
): BlockedParentReply {
	const parentAuthorDid = status.parentAuthorDid ?? didFromAtUri(candidate.parentUri);
	return {
		...candidate,
		parentVisibility: status.visibility,
		parentAuthorDid,
		parentItemType: status.itemType,
		parentText: status.parentText ?? '',
		parentCreatedAt: status.parentCreatedAt ?? '',
		parentInRepo,
		parentBlockedByRepoOwner: parentAuthorDid ? blockedDids.has(parentAuthorDid) : false
	};
}

function emptyBlockedParentReplyScanResult(): BlockedParentReplyScanResult {
	return {
		allReplies: [],
		replies: [],
		hiddenReplies: [],
		scannedReplyCount: 0,
		candidateParentCount: 0,
		visibleParentCount: 0,
		hiddenParentCount: 0,
		checkedThreadCount: 0,
		blockedParentCount: 0,
		unresolvedParentCount: 0
	};
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
		signal?: AbortSignal;
		onDownloadProgress?: (progress: RepoDownloadProgress) => void;
	} = {}
): Promise<RepoCarDownloadResult> {
	const { signal, onDownloadProgress } = options;
	const repoParams = new URLSearchParams({ did });
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
		signal,
		onDownloadProgress
	});

	return parseRepoFeedItemsFromCar(did, author, download.carBytes, {
		signal,
		onParseProgress,
		elapsedMs: download.elapsedMs,
		downloadedBytes: download.downloadedBytes,
		totalBytes: download.totalBytes,
		source: download.source
	});
}

export async function loadRepoBlockList(
	did: string,
	options: {
		signal?: AbortSignal;
		onPageProgress?: (progress: RepoRecordListProgress) => void;
	} = {}
): Promise<RepoBlockListLoadResult> {
	const { signal, onPageProgress } = options;
	const startTime = performance.now();
	const endpoints: Array<{ source: 'pds' | 'appview'; baseUrl: string }> = [];
	const pdsEndpoint = await resolvePds(did);
	if (pdsEndpoint) {
		endpoints.push({ source: 'pds', baseUrl: pdsEndpoint });
	}
	endpoints.push({ source: 'appview', baseUrl: 'https://public.api.bsky.app' });

	let lastError: Error | null = null;
	for (const endpoint of endpoints) {
		throwIfAborted(signal);
		const blockedDids = new Set<string>();
		let cursor = '';
		let pages = 0;
		let downloadedBytes = 0;

		try {
			do {
				throwIfAborted(signal);
				const params = new URLSearchParams({
					repo: did,
					collection: BLOCK_COLLECTION,
					limit: String(BLOCK_LIST_PAGE_LIMIT)
				});
				if (cursor) {
					params.set('cursor', cursor);
				}

				const res = await fetch(`${endpoint.baseUrl}/xrpc/com.atproto.repo.listRecords?${params.toString()}`, {
					signal
				});
				if (!res.ok) {
					const errorText = await res.text().catch(() => 'Unknown error');
					throw new Error(`Block record list failed (${res.status}): ${errorText}`);
				}

				const rawJson = await res.text();
				downloadedBytes += encodedJsonByteLength(rawJson);
				const payload = JSON.parse(rawJson) as {
					cursor?: string;
					records?: Array<{ value?: { subject?: unknown } }>;
				};

				for (const record of payload.records ?? []) {
					const subject = toText(record.value?.subject);
					if (subject) {
						blockedDids.add(subject);
					}
				}

				pages += 1;
				onPageProgress?.({
					pages,
					records: blockedDids.size,
					downloadedBytes,
					source: endpoint.source
				});
				cursor = toText(payload.cursor);
			} while (cursor);

			return {
				blockedDids,
				totalBlocks: blockedDids.size,
				elapsedMs: Math.round(performance.now() - startTime),
				downloadedBytes,
				totalBytes: downloadedBytes,
				source: endpoint.source,
				pages
			};
		} catch (err: any) {
			if (err?.name === 'AbortError') {
				throw err;
			}
			lastError = err instanceof Error ? err : new Error('Could not list block records.');
		}
	}

	throw lastError ?? new Error('Could not list app.bsky.graph.block records.');
}

export async function parseRepoFeedItemsFromCar(
	did: string,
	author: AuthorInfo,
	carBytes: Uint8Array,
	options: {
		signal?: AbortSignal;
		onParseProgress?: (parsedPosts: number) => void;
		elapsedMs?: number;
		downloadedBytes?: number;
		totalBytes?: number;
		source?: 'pds' | 'relay';
	} = {}
): Promise<RepoFeedLoadResult> {
	const { signal, onParseProgress } = options;
	const parsedPosts = await parseCarPostsWasm(carBytes, (count) => {
		onParseProgress?.(count);
	});
	throwIfAborted(signal);

	return {
		feedItems: repoPostsToFeedItems(did, parsedPosts, author),
		parsedPosts,
		totalPosts: parsedPosts.length,
		elapsedMs: options.elapsedMs ?? 0,
		downloadedBytes: options.downloadedBytes ?? carBytes.byteLength,
		totalBytes: options.totalBytes ?? carBytes.byteLength,
		source: options.source ?? 'pds'
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

export async function findRepliesToBlockedParents(
	feedItems: any[],
	options: {
		signal?: AbortSignal;
		concurrency?: number;
		blockedDids?: ReadonlySet<string>;
		onProgress?: (progress: {
			phase: string;
			current: number;
			total: number;
			detail?: string;
		}) => void;
	} = {}
): Promise<BlockedParentReplyScanResult> {
	const { signal, concurrency = 4, blockedDids = new Set<string>(), onProgress } = options;
	const repoPostUris = new Set<string>();
	const repoItemsByUri = new Map<string, any>();
	const candidates: ReplyParentCandidate[] = [];
	const candidatesByParentUri = new Map<string, ReplyParentCandidate[]>();

	for (const item of feedItems) {
		const uri = toText(item?.post?.uri);
		if (uri) {
			repoPostUris.add(uri);
			repoItemsByUri.set(uri, item);
		}
	}

	for (let index = 0; index < feedItems.length; index += 1) {
		throwIfAborted(signal);
		const candidate = readReplyParentCandidate(feedItems[index]);
		if (!candidate) continue;
		candidates.push(candidate);

		if (repoPostUris.has(candidate.parentUri)) continue;
		const existing = candidatesByParentUri.get(candidate.parentUri);
		if (existing) {
			existing.push(candidate);
		} else {
			candidatesByParentUri.set(candidate.parentUri, [candidate]);
		}
	}

	if (candidates.length === 0) {
		return {
			...emptyBlockedParentReplyScanResult(),
			scannedReplyCount: candidates.length,
			candidateParentCount: candidatesByParentUri.size
		};
	}

	const parentUris = [...candidatesByParentUri.keys()];
	const statusesByParentUri = new Map<string, ReplyParentVisibility>();
	let checkedThreadCount = 0;

	if (parentUris.length > 0) {
		onProgress?.({
			phase: 'Checking reply parents…',
			current: 0,
			total: parentUris.length,
			detail: `${parentUris.length.toLocaleString()} unique external reply parents`
		});

		let nextIndex = 0;
		const workerCount = Math.min(Math.max(1, Math.floor(concurrency)), parentUris.length);

		async function worker(): Promise<void> {
			while (true) {
				throwIfAborted(signal);
				const index = nextIndex++;
				if (index >= parentUris.length) return;

				const parentUri = parentUris[index];
				const reply = candidatesByParentUri.get(parentUri)?.[0];
				if (!reply) continue;

				const status = await fetchReplyParentVisibility(reply.uri, parentUri, { signal });
				statusesByParentUri.set(parentUri, status);
				checkedThreadCount += 1;

				const unknownSoFar = [...statusesByParentUri.values()].filter(
					(entry) => entry.visibility === 'unknown'
				).length;
				const blockedSoFar = [...statusesByParentUri.values()].filter(
					(entry) => entry.visibility === 'blocked'
				).length;
				onProgress?.({
					phase: 'Checking reply parents…',
					current: checkedThreadCount,
					total: parentUris.length,
					detail: `${unknownSoFar.toLocaleString()} unknown · ${blockedSoFar.toLocaleString()} blocked`
				});
			}
		}

		await Promise.all(Array.from({ length: workerCount }, () => worker()));
	}

	const hiddenParentUris = parentUris.filter(
		(parentUri) => (statusesByParentUri.get(parentUri)?.visibility ?? 'unknown') !== 'visible'
	);
	const hiddenParentUriSet = new Set(hiddenParentUris);
	const blockedParentUris = new Set(
		[...statusesByParentUri.entries()]
			.filter(([, status]) => status.visibility === 'blocked')
			.map(([parentUri]) => parentUri)
	);
	const visibleParentCount = [...statusesByParentUri.values()].filter(
		(status) => status.visibility === 'visible'
	).length;

	const allReplies = candidates
		.map((candidate) => {
			const parentInRepo = repoPostUris.has(candidate.parentUri);
			const status = parentInRepo
				? repoParentVisibility(candidate.parentUri, repoItemsByUri.get(candidate.parentUri) ?? null)
				: statusesByParentUri.get(candidate.parentUri) ?? fallbackParentVisibility(candidate.parentUri);
			return toBlockedParentReply(candidate, status, parentInRepo, blockedDids);
		})
		.sort(
			(a, b) =>
				compareIsoDesc(a.createdAt, b.createdAt) ||
				a.parentUri.localeCompare(b.parentUri) ||
				a.uri.localeCompare(b.uri)
		);

	const hiddenReplies = candidates
		.filter((candidate) => hiddenParentUriSet.has(candidate.parentUri))
		.map((candidate) =>
			toBlockedParentReply(
				candidate,
				statusesByParentUri.get(candidate.parentUri) ?? fallbackParentVisibility(candidate.parentUri),
				false,
				blockedDids
			)
		)
		.sort(
			(a, b) =>
				compareIsoDesc(a.createdAt, b.createdAt) ||
				a.parentUri.localeCompare(b.parentUri) ||
				a.uri.localeCompare(b.uri)
		);

	const replies = hiddenReplies
		.filter((candidate) => blockedParentUris.has(candidate.parentUri))
		.sort(
			(a, b) =>
				compareIsoDesc(a.createdAt, b.createdAt) ||
				a.parentUri.localeCompare(b.parentUri) ||
				a.uri.localeCompare(b.uri)
		);

	const unresolvedParentCount = [...statusesByParentUri.values()].filter(
		(status) => status.visibility === 'unknown'
	).length;

	return {
		allReplies,
		replies,
		hiddenReplies,
		scannedReplyCount: candidates.length,
		candidateParentCount: parentUris.length,
		visibleParentCount,
		hiddenParentCount: hiddenParentUris.length,
		checkedThreadCount,
		blockedParentCount: blockedParentUris.size,
		unresolvedParentCount
	};
}
