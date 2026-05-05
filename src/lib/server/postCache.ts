export const POST_CACHE_CHUNK_SIZE = 1000;
export const POST_CACHE_BUCKET_LIMIT_BYTES = 9_000_000_000;

interface CacheIndex {
	dids: string[];
}

interface LegacyPostCacheMeta {
	postCount?: unknown;
	cursor?: unknown;
	updatedAt?: unknown;
	reachedEnd?: unknown;
	chunkCount?: unknown;
}

interface StoredHeadBatchMeta {
	postCount?: unknown;
}

interface StoredHeadGroupMeta {
	id?: unknown;
	anchorUri?: unknown;
	postCount?: unknown;
	updatedAt?: unknown;
	nextCursor?: unknown;
	complete?: unknown;
	batches?: unknown;
}

interface StoredHeadMeta {
	postCount?: unknown;
	groups?: unknown;
}

interface StoredTailMeta {
	postCount?: unknown;
	chunkCount?: unknown;
	cursor?: unknown;
	reachedEnd?: unknown;
}

interface StoredPostCacheMetaV2 extends LegacyPostCacheMeta {
	version?: unknown;
	head?: StoredHeadMeta;
	tail?: StoredTailMeta;
}

export interface PostCacheHeadBatchMeta {
	postCount: number;
}

export interface PostCacheHeadGroupMeta {
	id: string;
	anchorUri: string;
	postCount: number;
	updatedAt: string;
	nextCursor: string | null;
	complete: boolean;
	batches: PostCacheHeadBatchMeta[];
}

export interface PostCacheMeta {
	version: 2;
	postCount: number;
	chunkCount: number;
	cursor: string | null;
	updatedAt: string;
	reachedEnd: boolean;
	head: {
		postCount: number;
		groups: PostCacheHeadGroupMeta[];
	};
	tail: {
		postCount: number;
		chunkCount: number;
		cursor: string | null;
		reachedEnd: boolean;
	};
}

export interface PublicPostCacheStatus {
	postCount: number;
	reachedEnd: boolean;
	updatedAt: string | null;
	chunkCount: number;
	cursor: string | null;
}

export interface PostCacheSliceResult {
	posts: any[];
	meta: PostCacheMeta | null;
	missing: boolean;
}

export interface PostCachePrefixResult {
	posts: any[];
	reachedEnd: boolean;
	missing: boolean;
	meta: PostCacheMeta;
}

export interface PostCacheWriteResult {
	written: boolean;
	postCount: number;
	chunkCount: number;
	reachedEnd: boolean;
	cacheEnabled: boolean;
	limitReached: boolean;
	writes: number;
}

export interface PostCacheHeadBatchResult {
	posts: any[];
	meta: PostCacheMeta | null;
	missing: boolean;
	postCount: number;
}

type CacheWritePolicy = {
	cacheEnabled: boolean;
	canEnroll: boolean;
	limitReached: boolean;
	index: CacheIndex;
};

function parseCount(value: unknown): number {
	if (!Number.isFinite(Number(value))) return 0;
	return Math.max(0, Math.round(Number(value)));
}

function parseString(value: unknown): string | null {
	return typeof value === 'string' && value.length > 0 ? value : null;
}

function createEmptyMeta(updatedAt = ''): PostCacheMeta {
	return {
		version: 2,
		postCount: 0,
		chunkCount: 0,
		cursor: null,
		updatedAt,
		reachedEnd: false,
		head: {
			postCount: 0,
			groups: []
		},
		tail: {
			postCount: 0,
			chunkCount: 0,
			cursor: null,
			reachedEnd: false
		}
	};
}

function headBatchKey(did: string, groupId: string, batchIndex: number): string {
	return `posts/${did}/head/${groupId}/batch-${batchIndex}.json`;
}

function tailChunkKey(did: string, index: number): string {
	return `posts/${did}/chunk-${index}.json`;
}

function metaKey(did: string): string {
	return `posts/${did}/meta.json`;
}

function normalizeHeadGroup(raw: unknown, index: number): PostCacheHeadGroupMeta | null {
	if (!raw || typeof raw !== 'object') return null;

	const id = parseString((raw as StoredHeadGroupMeta).id) ?? `legacy-${index}`;
	const anchorUri = parseString((raw as StoredHeadGroupMeta).anchorUri) ?? '';
	const updatedAt = parseString((raw as StoredHeadGroupMeta).updatedAt) ?? '';
	const nextCursor = parseString((raw as StoredHeadGroupMeta).nextCursor);
	const batchesRaw = Array.isArray((raw as StoredHeadGroupMeta).batches)
		? ((raw as StoredHeadGroupMeta).batches as unknown[])
		: [];
	const batches = batchesRaw
		.map((batch) => ({
			postCount: parseCount((batch as StoredHeadBatchMeta)?.postCount)
		}))
		.filter((batch) => batch.postCount > 0);
	const postCountFromBatches = batches.reduce((sum, batch) => sum + batch.postCount, 0);
	const postCount = Math.max(parseCount((raw as StoredHeadGroupMeta).postCount), postCountFromBatches);

	if (!anchorUri || postCount <= 0) return null;

	return {
		id,
		anchorUri,
		postCount: postCountFromBatches > 0 ? postCountFromBatches : postCount,
		updatedAt,
		nextCursor,
		complete:
			typeof (raw as StoredHeadGroupMeta).complete === 'boolean'
				? Boolean((raw as StoredHeadGroupMeta).complete)
				: nextCursor == null,
		batches:
			batches.length > 0
				? batches
				: [
						{
							postCount
						}
					]
	};
}

function syncMeta(meta: PostCacheMeta): PostCacheMeta {
	const headGroups = meta.head.groups
		.map((group) => ({
			...group,
			batches: group.batches.filter((batch) => batch.postCount > 0)
		}))
		.filter((group) => group.anchorUri.length > 0 && group.batches.length > 0)
		.map((group) => ({
			...group,
			postCount: group.batches.reduce((sum, batch) => sum + batch.postCount, 0)
		}));
	const headPostCount = headGroups.reduce((sum, group) => sum + group.postCount, 0);
	const tailPostCount = Math.max(0, meta.tail.postCount);
	const totalPostCount = headPostCount + tailPostCount;

	return {
		version: 2,
		postCount: totalPostCount,
		chunkCount: Math.ceil(totalPostCount / POST_CACHE_CHUNK_SIZE),
		cursor: meta.tail.cursor,
		updatedAt: meta.updatedAt,
		reachedEnd: meta.tail.reachedEnd,
		head: {
			postCount: headPostCount,
			groups: headGroups
		},
		tail: {
			postCount: tailPostCount,
			chunkCount: Math.ceil(tailPostCount / POST_CACHE_CHUNK_SIZE),
			cursor: meta.tail.cursor,
			reachedEnd: meta.tail.reachedEnd
		}
	};
}

async function readJson<T>(bucket: R2Bucket, key: string): Promise<T | null> {
	const object = await bucket.get(key);
	if (!object) return null;

	try {
		return await object.json<T>();
	} catch {
		return null;
	}
}

async function writeJson(bucket: R2Bucket, key: string, value: unknown): Promise<void> {
	await bucket.put(key, JSON.stringify(value), {
		httpMetadata: { contentType: 'application/json' }
	});
}

async function readCacheIndex(bucket: R2Bucket): Promise<CacheIndex> {
	const index = await readJson<CacheIndex>(bucket, 'cache-index.json');
	return {
		dids: Array.isArray(index?.dids) ? index.dids.filter((did) => typeof did === 'string') : []
	};
}

async function writeCacheIndex(bucket: R2Bucket, index: CacheIndex): Promise<void> {
	await writeJson(bucket, 'cache-index.json', index);
}

async function readBucketUsageBytes(bucket: R2Bucket): Promise<number> {
	let totalBytes = 0;
	let cursor: string | undefined;

	do {
		const listing = await bucket.list({ cursor });
		for (const object of listing.objects) {
			const size = Number(object.size);
			totalBytes += Number.isFinite(size) ? Math.max(0, size) : 0;
		}
		cursor = listing.truncated ? listing.cursor : undefined;
	} while (cursor);

	return totalBytes;
}

export async function readPostCacheBucketUsage(
	bucket: R2Bucket | undefined
): Promise<{
	bytes: number;
	limitBytes: number;
	limitReached: boolean;
} | null> {
	if (!bucket) return null;

	const bytes = await readBucketUsageBytes(bucket);
	return {
		bytes,
		limitBytes: POST_CACHE_BUCKET_LIMIT_BYTES,
		limitReached: bytes >= POST_CACHE_BUCKET_LIMIT_BYTES
	};
}

async function resolveCacheWritePolicy(
	bucket: R2Bucket,
	did: string,
	meta: PostCacheMeta | null
): Promise<CacheWritePolicy> {
	const index = await readCacheIndex(bucket);
	const isIndexed = index.dids.includes(did);
	const usage = await readPostCacheBucketUsage(bucket);
	const limitReached = usage?.limitReached ?? false;
	const canEnroll = !isIndexed && !limitReached;

	return {
		cacheEnabled: !limitReached && (Boolean(meta) || isIndexed || canEnroll),
		canEnroll,
		limitReached,
		index
	};
}

async function maybeEnrollDid(
	bucket: R2Bucket,
	policy: CacheWritePolicy,
	did: string
): Promise<boolean> {
	if (!policy.canEnroll || policy.index.dids.includes(did)) {
		return false;
	}

	policy.index.dids.push(did);
	await writeCacheIndex(bucket, policy.index);
	return true;
}

async function hashText(value: string): Promise<string> {
	const encoded = new TextEncoder().encode(value);
	const digest = await crypto.subtle.digest('SHA-256', encoded);
	return Array.from(new Uint8Array(digest))
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('');
}

function postKey(item: any): string | null {
	const uri = item?.post?.uri;
	if (typeof uri === 'string' && uri.length > 0) return `uri:${uri}`;
	const cid = item?.post?.cid;
	if (typeof cid === 'string' && cid.length > 0) return `cid:${cid}`;
	return null;
}

async function readHeadBatchPosts(
	bucket: R2Bucket,
	did: string,
	groupId: string,
	batchIndex: number
): Promise<any[] | null> {
	const object = await bucket.get(headBatchKey(did, groupId, batchIndex));
	if (!object) return null;

	try {
		const parsed = await object.json<any[]>();
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return null;
	}
}

export async function readPostCacheHeadBatch(
	bucket: R2Bucket | undefined,
	did: string,
	groupId: string,
	batchIndex: number
): Promise<PostCacheHeadBatchResult> {
	const meta = await readPostCacheMeta(bucket, did);
	if (!bucket || !meta) {
		return {
			posts: [],
			meta,
			missing: false,
			postCount: 0
		};
	}

	const group = meta.head.groups.find((candidate) => candidate.id === groupId);
	const batchMeta =
		group && batchIndex >= 0 && batchIndex < group.batches.length ? group.batches[batchIndex] : null;
	if (!group || !batchMeta) {
		return {
			posts: [],
			meta,
			missing: false,
			postCount: 0
		};
	}

	const posts = await readHeadBatchPosts(bucket, did, groupId, batchIndex);
	return {
		posts: posts ?? [],
		meta,
		missing: posts == null,
		postCount: batchMeta.postCount
	};
}

async function readTailChunkPosts(bucket: R2Bucket, did: string, index: number): Promise<any[] | null> {
	const object = await bucket.get(tailChunkKey(did, index));
	if (!object) return null;

	try {
		const parsed = await object.json<any[]>();
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return null;
	}
}

async function collectHeadGroupKeys(
	bucket: R2Bucket,
	did: string,
	group: PostCacheHeadGroupMeta
): Promise<Set<string>> {
	const keys = new Set<string>();

	for (let batchIndex = 0; batchIndex < group.batches.length; batchIndex++) {
		const posts = await readHeadBatchPosts(bucket, did, group.id, batchIndex);
		if (!posts) continue;

		let fallback = 0;
		for (const item of posts) {
			const key = postKey(item) ?? `fallback:${batchIndex}:${fallback++}`;
			keys.add(key);
		}
	}

	return keys;
}

function summaryFromMeta(meta: PostCacheMeta | null, overrides: Partial<PostCacheWriteResult> = {}): PostCacheWriteResult {
	return {
		written: false,
		postCount: meta?.postCount ?? 0,
		chunkCount: meta?.chunkCount ?? 0,
		reachedEnd: meta?.reachedEnd ?? false,
		cacheEnabled: false,
		limitReached: false,
		writes: 0,
		...overrides
	};
}

export function toPublicPostCacheStatus(meta: PostCacheMeta | null): PublicPostCacheStatus {
	return {
		postCount: meta?.postCount ?? 0,
		reachedEnd: meta?.reachedEnd ?? false,
		updatedAt: meta?.updatedAt || null,
		chunkCount: meta?.chunkCount ?? 0,
		cursor: meta?.cursor ?? null
	};
}

export async function readPostCacheMeta(
	bucket: R2Bucket | undefined,
	did: string
): Promise<PostCacheMeta | null> {
	if (!bucket) return null;

	const stored = await readJson<StoredPostCacheMetaV2 | LegacyPostCacheMeta>(bucket, metaKey(did));
	if (!stored || typeof stored !== 'object') return null;

	const legacy = stored as LegacyPostCacheMeta;
	const storedV2 = stored as StoredPostCacheMetaV2;
	const headGroupsRaw = Array.isArray(storedV2.head?.groups) ? storedV2.head?.groups : [];
	const groups = headGroupsRaw
		.map((group, index) => normalizeHeadGroup(group, index))
		.filter((group): group is PostCacheHeadGroupMeta => group != null);
	const headPostCount = groups.reduce((sum, group) => sum + group.postCount, 0);
	const tailPostCount = Math.max(
		parseCount(storedV2.tail?.postCount),
		Math.max(0, parseCount(legacy.postCount) - headPostCount)
	);

	const meta = syncMeta({
		version: 2,
		postCount: 0,
		chunkCount: 0,
		cursor: null,
		updatedAt: parseString(legacy.updatedAt) ?? '',
		reachedEnd: Boolean(storedV2.tail?.reachedEnd ?? legacy.reachedEnd),
		head: {
			postCount: parseCount(storedV2.head?.postCount),
			groups
		},
		tail: {
			postCount: tailPostCount,
			chunkCount: Math.max(parseCount(storedV2.tail?.chunkCount), parseCount(legacy.chunkCount)),
			cursor: parseString(storedV2.tail?.cursor) ?? parseString(legacy.cursor),
			reachedEnd: Boolean(storedV2.tail?.reachedEnd ?? legacy.reachedEnd)
		}
	});

	return meta;
}

export async function writePostCacheMeta(
	bucket: R2Bucket,
	did: string,
	meta: PostCacheMeta
): Promise<void> {
	await writeJson(bucket, metaKey(did), syncMeta(meta));
}

async function readHeadSlice(
	bucket: R2Bucket,
	did: string,
	meta: PostCacheMeta,
	offset: number,
	limit: number
): Promise<{ posts: any[]; missing: boolean }> {
	const posts: any[] = [];
	let skipped = 0;
	let missing = false;

	for (const group of meta.head.groups) {
		for (let batchIndex = 0; batchIndex < group.batches.length; batchIndex++) {
			const batchMeta = group.batches[batchIndex];
			const batchCount = batchMeta.postCount;
			if (batchCount <= 0) continue;

			if (offset >= skipped + batchCount) {
				skipped += batchCount;
				continue;
			}

			const batchPosts = await readHeadBatchPosts(bucket, did, group.id, batchIndex);
			if (!batchPosts) {
				missing = true;
				skipped += batchCount;
				continue;
			}

			const start = Math.max(0, offset - skipped);
			const remaining = limit - posts.length;
			const end = Math.min(batchPosts.length, start + remaining);
			if (end > start) {
				posts.push(...batchPosts.slice(start, end));
			}
			skipped += batchCount;

			if (posts.length >= limit) {
				return { posts, missing };
			}
		}
	}

	return { posts, missing };
}

async function readTailSlice(
	bucket: R2Bucket,
	did: string,
	offset: number,
	limit: number
): Promise<{ posts: any[]; missing: boolean }> {
	const posts: any[] = [];
	let missing = false;
	const startChunk = Math.floor(offset / POST_CACHE_CHUNK_SIZE);
	const endExclusive = offset + limit;
	const endChunk = Math.floor(Math.max(0, endExclusive - 1) / POST_CACHE_CHUNK_SIZE);

	for (let chunkIndex = startChunk; chunkIndex <= endChunk; chunkIndex++) {
		const chunkPosts = await readTailChunkPosts(bucket, did, chunkIndex);
		if (!chunkPosts) {
			missing = true;
			continue;
		}

		const chunkStartOffset = chunkIndex * POST_CACHE_CHUNK_SIZE;
		const sliceStart = Math.max(0, offset - chunkStartOffset);
		const remaining = limit - posts.length;
		const sliceEnd = Math.min(chunkPosts.length, sliceStart + remaining);
		if (sliceEnd > sliceStart) {
			posts.push(...chunkPosts.slice(sliceStart, sliceEnd));
		}

		if (posts.length >= limit) {
			break;
		}
	}

	return { posts, missing };
}

export async function readPostCacheSlice(
	bucket: R2Bucket | undefined,
	did: string,
	options: {
		offset?: number;
		limit?: number;
	} = {}
): Promise<PostCacheSliceResult> {
	const meta = await readPostCacheMeta(bucket, did);
	const offset = Math.max(0, Math.floor(options.offset ?? 0));
	const limit = Math.max(0, Math.floor(options.limit ?? POST_CACHE_CHUNK_SIZE));

	if (!bucket || !meta || limit <= 0 || offset >= meta.postCount) {
		return {
			posts: [],
			meta,
			missing: false
		};
	}

	const headLimit = Math.min(limit, Math.max(0, meta.head.postCount - offset));
	const headResult =
		headLimit > 0
			? await readHeadSlice(bucket, did, meta, offset, headLimit)
			: { posts: [], missing: false };
	const headCovered = headLimit;
	const tailOffset = Math.max(0, offset - meta.head.postCount);
	const tailLimit = Math.max(0, limit - headCovered);
	const tailResult =
		tailLimit > 0
			? await readTailSlice(bucket, did, tailOffset, tailLimit)
			: { posts: [], missing: false };

	return {
		posts: [...headResult.posts, ...tailResult.posts],
		meta,
		missing: headResult.missing || tailResult.missing
	};
}

export async function readCachedPostPrefix(
	bucket: R2Bucket | undefined,
	did: string,
	maxPosts: number,
	options: {
		allowPartial?: boolean;
	} = {}
): Promise<PostCachePrefixResult | null> {
	if (!bucket) return null;

	const meta = await readPostCacheMeta(bucket, did);
	if (!meta || meta.postCount <= 0) {
		return null;
	}

	const targetPostCount = Math.min(Math.max(0, Math.floor(maxPosts)), meta.postCount);
	if (targetPostCount <= 0 || (!options.allowPartial && targetPostCount < maxPosts)) {
		return null;
	}

	const slice = await readPostCacheSlice(bucket, did, {
		offset: 0,
		limit: targetPostCount
	});
	if (slice.meta == null) {
		return null;
	}
	if (slice.missing && !options.allowPartial) {
		return null;
	}

	return {
		posts: slice.posts,
		reachedEnd: slice.meta.reachedEnd,
		missing: slice.missing,
		meta: slice.meta
	};
}

export async function appendOlderPostsToCache(
	bucket: R2Bucket | undefined,
	did: string,
	posts: any[],
	options: {
		nextCursor: string | null;
		reachedEnd: boolean;
		postsCount?: number;
	}
): Promise<PostCacheWriteResult> {
	const meta = await readPostCacheMeta(bucket, did);
	if (!bucket) {
		return summaryFromMeta(meta);
	}

	const policy = await resolveCacheWritePolicy(bucket, did, meta);
	if (!policy.cacheEnabled) {
		return summaryFromMeta(meta, { cacheEnabled: false, limitReached: policy.limitReached });
	}

	let nextMeta = meta ?? createEmptyMeta();
	let writes = 0;
	const now = new Date().toISOString();

	if (posts.length > 0) {
		let remaining = [...posts];
		const tailUsed = nextMeta.tail.postCount % POST_CACHE_CHUNK_SIZE;
		if (tailUsed > 0 && nextMeta.tail.chunkCount > 0) {
			const tailIndex = nextMeta.tail.chunkCount - 1;
			const tailPosts = (await readTailChunkPosts(bucket, did, tailIndex)) ?? [];
			const safeTail = Array.isArray(tailPosts) ? tailPosts.slice(0, tailUsed) : [];
			const fillCount = Math.min(POST_CACHE_CHUNK_SIZE - tailUsed, remaining.length);
			await writeJson(bucket, tailChunkKey(did, tailIndex), [
				...safeTail,
				...remaining.slice(0, fillCount)
			]);
			writes += 1;
			remaining = remaining.slice(fillCount);
		}

		let chunkIndex = nextMeta.tail.chunkCount;
		while (remaining.length > 0) {
			const chunk = remaining.slice(0, POST_CACHE_CHUNK_SIZE);
			await writeJson(bucket, tailChunkKey(did, chunkIndex), chunk);
			writes += 1;
			chunkIndex += 1;
			remaining = remaining.slice(POST_CACHE_CHUNK_SIZE);
		}

		nextMeta = syncMeta({
			...nextMeta,
			updatedAt: now,
			head: nextMeta.head,
			tail: {
				postCount: nextMeta.tail.postCount + posts.length,
				chunkCount: 0,
				cursor: options.nextCursor,
				reachedEnd: options.reachedEnd
			}
		});
	} else if (options.reachedEnd !== nextMeta.reachedEnd || options.nextCursor !== nextMeta.cursor) {
		nextMeta = syncMeta({
			...nextMeta,
			updatedAt: now,
			tail: {
				...nextMeta.tail,
				cursor: options.nextCursor,
				reachedEnd: options.reachedEnd
			}
		});
	} else {
		return summaryFromMeta(nextMeta, { cacheEnabled: true });
	}

	await writePostCacheMeta(bucket, did, nextMeta);
	writes += 1;
	await maybeEnrollDid(bucket, policy, did);

	return summaryFromMeta(nextMeta, {
		written: true,
		cacheEnabled: true,
		writes
	});
}

export async function appendNewPostsToCache(
	bucket: R2Bucket | undefined,
	did: string,
	posts: any[],
	options: {
		anchorUri: string | null;
		nextCursor: string | null;
		hasMore: boolean;
		postsCount?: number;
	}
): Promise<PostCacheWriteResult> {
	const meta = await readPostCacheMeta(bucket, did);
	if (!bucket) {
		return summaryFromMeta(meta);
	}

	const anchorUri = parseString(options.anchorUri);
	const policy = await resolveCacheWritePolicy(bucket, did, meta);
	if (!policy.cacheEnabled || !anchorUri) {
		return summaryFromMeta(meta, { cacheEnabled: false, limitReached: policy.limitReached });
	}

	let nextMeta = meta ?? createEmptyMeta();
	const now = new Date().toISOString();
	let writes = 0;
	const groups = nextMeta.head.groups.slice();
	let groupIndex = groups.findIndex((group) => group.anchorUri === anchorUri);

	if (groupIndex === -1) {
		groups.unshift({
			id: await hashText(anchorUri),
			anchorUri,
			postCount: 0,
			updatedAt: now,
			nextCursor: null,
			complete: false,
			batches: []
		});
		groupIndex = 0;
	}

	const group = { ...groups[groupIndex], batches: groups[groupIndex].batches.slice() };
	const existingKeys = await collectHeadGroupKeys(bucket, did, group);
	let fallback = 0;
	const uniquePosts = posts.filter((item) => {
		const key = postKey(item) ?? `incoming:${fallback++}`;
		if (existingKeys.has(key)) return false;
		existingKeys.add(key);
		return true;
	});

	if (uniquePosts.length > 0) {
		const batchIndex = group.batches.length;
		await writeJson(bucket, headBatchKey(did, group.id, batchIndex), uniquePosts);
		group.batches.push({ postCount: uniquePosts.length });
		group.postCount += uniquePosts.length;
		writes += 1;
	}

	const nextCursor = options.hasMore ? options.nextCursor : null;
	const nextComplete = !options.hasMore;
	const statusChanged = group.nextCursor !== nextCursor || group.complete !== nextComplete;
	group.nextCursor = nextCursor;
	group.complete = nextComplete;
	group.updatedAt = now;
	groups[groupIndex] = group;

	if (uniquePosts.length === 0 && !statusChanged) {
		return summaryFromMeta(nextMeta, { cacheEnabled: true });
	}

	nextMeta = syncMeta({
		...nextMeta,
		updatedAt: now,
		head: {
			postCount: 0,
			groups
		},
		tail: nextMeta.tail
	});

	await writePostCacheMeta(bucket, did, nextMeta);
	writes += 1;
	await maybeEnrollDid(bucket, policy, did);

	return summaryFromMeta(nextMeta, {
		written: true,
		cacheEnabled: true,
		writes
	});
}
