export interface CacheStatus {
	postCount: number;
	reachedEnd: boolean;
	updatedAt: string | null;
	chunkCount: number;
	cursor: string | null;
	head?: {
		postCount: number;
		groups: Array<{
			id: string;
			anchorUri: string;
			postCount: number;
			updatedAt: string | null;
			nextCursor: string | null;
			complete: boolean;
			batches: Array<{
				postCount: number;
			}>;
		}>;
	};
	tail?: {
		postCount: number;
		chunkCount: number;
		cursor: string | null;
		reachedEnd: boolean;
	};
}

export interface PostMetaResponse extends CacheStatus {}

export const CACHE_CHUNK_SIZE = 1000;

export interface CachedChunkPage {
	index: number;
	posts: any[];
	chunkCount: number;
	postCount: number;
	reachedEnd: boolean;
	nextIndex: number | null;
	missing: boolean;
}

export interface CachedHeadBatchPage {
	groupId: string;
	batchIndex: number;
	postCount: number;
	posts: any[];
	missing: boolean;
}

export interface NewPostsResponse {
	posts: any[];
	overlapFound: boolean;
	hasMore: boolean;
	nextCursor: string | null;
	apiCalls: number;
	cache: {
		written: boolean;
		postCount: number;
		chunkCount: number;
		reachedEnd: boolean;
		limitReached: boolean;
	};
}

export interface OlderPostsRequest {
	cursor?: string | null;
	limitPosts?: number;
	postsCount?: number;
}

export interface OlderPostsResponse {
	posts: any[];
	nextCursor: string | null;
	reachedEnd: boolean;
	apiCalls: number;
	cache: {
		written: boolean;
		postCount: number;
		chunkCount: number;
		reachedEnd: boolean;
		limitReached: boolean;
	};
}

export async function fetchPostMeta(did: string): Promise<PostMetaResponse> {
	const res = await fetch(`/api/posts/${encodeURIComponent(did)}/meta`);
	if (!res.ok) {
		return {
			postCount: 0,
			reachedEnd: false,
			updatedAt: null,
			chunkCount: 0,
			cursor: null
		};
	}

	const parsed = (await res.json()) as any;
	return {
		postCount:
			typeof parsed?.postCount === 'number' && Number.isFinite(parsed.postCount)
				? Math.max(0, parsed.postCount)
				: 0,
		reachedEnd: Boolean(parsed?.reachedEnd),
		updatedAt: typeof parsed?.updatedAt === 'string' ? parsed.updatedAt : null,
		chunkCount:
			typeof parsed?.chunkCount === 'number' && Number.isFinite(parsed.chunkCount)
				? Math.max(0, parsed.chunkCount)
				: 0,
		cursor: typeof parsed?.cursor === 'string' ? parsed.cursor : null,
		head: {
			postCount:
				typeof parsed?.head?.postCount === 'number' && Number.isFinite(parsed.head.postCount)
					? Math.max(0, parsed.head.postCount)
					: 0,
			groups: Array.isArray(parsed?.head?.groups)
				? parsed.head.groups
						.map((group: any) => ({
							id: typeof group?.id === 'string' ? group.id : '',
							anchorUri: typeof group?.anchorUri === 'string' ? group.anchorUri : '',
							postCount:
								typeof group?.postCount === 'number' && Number.isFinite(group.postCount)
									? Math.max(0, group.postCount)
									: 0,
							updatedAt: typeof group?.updatedAt === 'string' ? group.updatedAt : null,
							nextCursor: typeof group?.nextCursor === 'string' ? group.nextCursor : null,
							complete: Boolean(group?.complete),
							batches: Array.isArray(group?.batches)
								? group.batches
										.map((batch: any) => ({
											postCount:
												typeof batch?.postCount === 'number' && Number.isFinite(batch.postCount)
													? Math.max(0, batch.postCount)
													: 0
										}))
										.filter((batch: { postCount: number }) => batch.postCount > 0)
								: []
						}))
						.filter((group: { id: string; anchorUri: string; postCount: number }) => group.id && group.anchorUri)
				: []
		},
		tail: {
			postCount:
				typeof parsed?.tail?.postCount === 'number' && Number.isFinite(parsed.tail.postCount)
					? Math.max(0, parsed.tail.postCount)
					: 0,
			chunkCount:
				typeof parsed?.tail?.chunkCount === 'number' && Number.isFinite(parsed.tail.chunkCount)
					? Math.max(0, parsed.tail.chunkCount)
					: 0,
			cursor: typeof parsed?.tail?.cursor === 'string' ? parsed.tail.cursor : null,
			reachedEnd: Boolean(parsed?.tail?.reachedEnd)
		}
	};
}

export async function fetchCacheStatus(did: string): Promise<CacheStatus> {
	return fetchPostMeta(did);
}

export async function fetchCachedChunkPage(
	did: string,
	index: number,
	signal?: AbortSignal
): Promise<CachedChunkPage> {
	const pageIndex = Math.max(0, Math.floor(index));
	const params = new URLSearchParams({ index: String(pageIndex) });
	const res = await fetch(`/api/posts/${encodeURIComponent(did)}/chunk?${params.toString()}`, {
		signal
	});
	if (!res.ok) {
		throw new Error(`Failed to load cache chunk ${pageIndex} (${res.status})`);
	}

	const readHeaderNumber = (name: string): number | null => {
		const raw = res.headers.get(name);
		if (raw == null || raw === '') return null;
		const parsed = Number.parseInt(raw, 10);
		return Number.isFinite(parsed) ? parsed : null;
	};

	const readHeaderBool = (name: string): boolean | null => {
		const raw = res.headers.get(name);
		if (raw == null || raw === '') return null;
		if (raw === '1' || raw.toLowerCase() === 'true') return true;
		if (raw === '0' || raw.toLowerCase() === 'false') return false;
		return null;
	};

	const parsed = (await res.json()) as any;
	const posts = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.posts) ? parsed.posts : [];
	const headerIndex = readHeaderNumber('X-Chunk-Index');
	const headerChunkCount = readHeaderNumber('X-Chunk-Count');
	const headerPostCount = readHeaderNumber('X-Post-Count');
	const headerNextIndex = readHeaderNumber('X-Next-Index');
	const headerReachedEnd = readHeaderBool('X-Reached-End');
	const headerMissing = readHeaderBool('X-Chunk-Missing');

	return {
		index:
			typeof headerIndex === 'number'
				? Math.max(0, headerIndex)
				: typeof parsed?.index === 'number'
					? Math.max(0, parsed.index)
					: pageIndex,
		posts,
		chunkCount:
			typeof headerChunkCount === 'number'
				? Math.max(0, headerChunkCount)
				: typeof parsed?.chunkCount === 'number' && Number.isFinite(parsed.chunkCount)
				? Math.max(0, parsed.chunkCount)
				: 0,
		postCount:
			typeof headerPostCount === 'number'
				? Math.max(0, headerPostCount)
				: typeof parsed?.postCount === 'number' && Number.isFinite(parsed.postCount)
				? Math.max(0, parsed.postCount)
				: 0,
		reachedEnd:
			typeof headerReachedEnd === 'boolean' ? headerReachedEnd : Boolean(parsed?.reachedEnd),
		nextIndex:
			typeof headerNextIndex === 'number'
				? Math.max(0, headerNextIndex)
				: typeof parsed?.nextIndex === 'number' && Number.isFinite(parsed.nextIndex)
				? Math.max(0, parsed.nextIndex)
				: null,
		missing: typeof headerMissing === 'boolean' ? headerMissing : Boolean(parsed?.missing)
	};
}

export async function fetchCachedHeadBatchPage(
	did: string,
	groupId: string,
	batchIndex: number,
	signal?: AbortSignal
): Promise<CachedHeadBatchPage> {
	const params = new URLSearchParams({
		group: groupId,
		batch: String(Math.max(0, Math.floor(batchIndex)))
	});
	const res = await fetch(`/api/posts/${encodeURIComponent(did)}/head?${params.toString()}`, {
		signal
	});
	if (!res.ok) {
		throw new Error(`Failed to load cache head batch ${groupId}:${batchIndex} (${res.status})`);
	}

	const parsed = (await res.json()) as any;
	const posts = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.posts) ? parsed.posts : [];
	const headerPostCount = res.headers.get('X-Head-Post-Count');
	const headerMissing = res.headers.get('X-Head-Missing');
	const normalizedPostCount = Number.parseInt(headerPostCount ?? '', 10);

	return {
		groupId,
		batchIndex: Math.max(0, Math.floor(batchIndex)),
		postCount: Number.isFinite(normalizedPostCount) ? Math.max(0, normalizedPostCount) : posts.length,
		posts,
		missing: headerMissing === '1' || headerMissing?.toLowerCase() === 'true'
	};
}

export async function fetchNewPosts(
	did: string,
	options: { sinceUri?: string | null; cursor?: string | null; limit?: number; postsCount?: number | null },
	signal?: AbortSignal
): Promise<NewPostsResponse> {
	const params = new URLSearchParams();
	if (options.sinceUri) params.set('sinceUri', options.sinceUri);
	if (options.cursor) params.set('cursor', options.cursor);
	if (typeof options.limit === 'number' && Number.isFinite(options.limit) && options.limit > 0) {
		params.set('limit', String(Math.floor(options.limit)));
	}
	if (
		typeof options.postsCount === 'number' &&
		Number.isFinite(options.postsCount) &&
		options.postsCount >= 0
	) {
		params.set('postsCount', String(Math.floor(options.postsCount)));
	}

	const res = await fetch(`/api/posts/${encodeURIComponent(did)}/new?${params.toString()}`, {
		signal
	});
	if (!res.ok) {
		throw new Error(`Failed to fetch new posts (${res.status})`);
	}

	const parsed = (await res.json()) as any;
	return {
		posts: Array.isArray(parsed?.posts) ? parsed.posts : [],
		overlapFound: Boolean(parsed?.overlapFound),
		hasMore: Boolean(parsed?.hasMore),
		nextCursor: typeof parsed?.nextCursor === 'string' ? parsed.nextCursor : null,
		apiCalls:
			typeof parsed?.apiCalls === 'number' && Number.isFinite(parsed.apiCalls)
				? Math.max(0, parsed.apiCalls)
				: 0,
		cache: {
			written: Boolean(parsed?.cache?.written),
			postCount:
				typeof parsed?.cache?.postCount === 'number' && Number.isFinite(parsed.cache.postCount)
					? Math.max(0, parsed.cache.postCount)
					: 0,
			chunkCount:
				typeof parsed?.cache?.chunkCount === 'number' && Number.isFinite(parsed.cache.chunkCount)
					? Math.max(0, parsed.cache.chunkCount)
					: 0,
			reachedEnd: Boolean(parsed?.cache?.reachedEnd),
			limitReached: Boolean(parsed?.cache?.limitReached)
		}
	};
}

export async function fetchOlderPosts(
	did: string,
	body: OlderPostsRequest,
	signal?: AbortSignal
): Promise<OlderPostsResponse> {
	const res = await fetch(`/api/posts/${encodeURIComponent(did)}/older`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json'
		},
		body: JSON.stringify(body),
		signal
	});

	if (!res.ok) {
		throw new Error(`Failed to fetch older posts (${res.status})`);
	}

	const parsed = (await res.json()) as any;
	const cache = parsed?.cache ?? {};
	return {
		posts: Array.isArray(parsed?.posts) ? parsed.posts : [],
		nextCursor: typeof parsed?.nextCursor === 'string' ? parsed.nextCursor : null,
		reachedEnd: Boolean(parsed?.reachedEnd),
		apiCalls:
			typeof parsed?.apiCalls === 'number' && Number.isFinite(parsed.apiCalls)
				? Math.max(0, parsed.apiCalls)
				: 0,
		cache: {
			written: Boolean(cache?.written),
			postCount:
				typeof cache?.postCount === 'number' && Number.isFinite(cache.postCount)
					? Math.max(0, cache.postCount)
					: 0,
			chunkCount:
				typeof cache?.chunkCount === 'number' && Number.isFinite(cache.chunkCount)
					? Math.max(0, cache.chunkCount)
					: 0,
			reachedEnd: Boolean(cache?.reachedEnd),
			limitReached: Boolean(cache?.limitReached)
		}
	};
}
