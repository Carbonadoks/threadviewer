import type { RequestHandler } from './$types';
import {
	appendOlderPostsToCache,
	readPostCacheMeta
} from '$lib/server/postCache';

const BLUESKY_API = 'https://public.api.bsky.app';

const MAX_API_CALLS_PER_REQUEST = 5;
const MAX_POSTS_PER_REQUEST = 500;
const INITIAL_UNCACHED_MAX_POSTS = 1000;
const INITIAL_UNCACHED_MAX_API_CALLS = 10;

interface OlderRequest {
	cursor?: string | null;
	limitPosts?: number;
	postsCount?: number;
}

interface OlderResponse {
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
		feed: Array.isArray(data.feed) ? data.feed : [],
		cursor: typeof data.cursor === 'string' ? data.cursor : undefined
	};
}

function normalizeLimit(raw: unknown, existingPostCount: number): number {
	const parsed = Number.parseInt(String(raw ?? MAX_POSTS_PER_REQUEST), 10);
	const wantsInitialBatch = parsed >= INITIAL_UNCACHED_MAX_POSTS;
	const canUseInitialBatch = existingPostCount === 0 && wantsInitialBatch;
	return canUseInitialBatch ? INITIAL_UNCACHED_MAX_POSTS : MAX_POSTS_PER_REQUEST;
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === 'string' && value.length > 0;
}

export const POST: RequestHandler = async ({ params, platform, request }) => {
	const startedAt = Date.now();
	const did = params.did;
	const bucket = platform?.env?.POST_CACHE;

	let apiCalls = 0;
	let cacheWrites = 0;
	let postsReturned = 0;

	try {
		const body = (await request.json().catch(() => ({}))) as OlderRequest;
		const postsCount = Number.parseInt(String(body.postsCount ?? 0), 10);
		const meta = await readPostCacheMeta(bucket, did);

		const existingPostCount = Math.max(0, meta?.postCount ?? 0);
		const limitPosts = normalizeLimit(body.limitPosts, existingPostCount);
		const maxApiCalls =
			limitPosts === INITIAL_UNCACHED_MAX_POSTS
				? INITIAL_UNCACHED_MAX_API_CALLS
				: MAX_API_CALLS_PER_REQUEST;

		let cursor = isNonEmptyString(body.cursor)
			? body.cursor
			: isNonEmptyString(meta?.cursor)
				? meta.cursor
				: undefined;

		let reachedEnd = false;
		const posts: any[] = [];

		if (meta?.reachedEnd && !isNonEmptyString(body.cursor)) {
			reachedEnd = true;
			cursor = undefined;
		} else {
			while (posts.length < limitPosts && apiCalls < maxApiCalls) {
				const result = await fetchBlueskyFeed(did, cursor);
				apiCalls += 1;

				if (result.feed.length === 0) {
					reachedEnd = true;
					cursor = undefined;
					break;
				}

				posts.push(...result.feed);
				if (!result.cursor) {
					reachedEnd = true;
					cursor = undefined;
					break;
				}

				cursor = result.cursor;
			}
		}

		if (posts.length > limitPosts) {
			posts.length = limitPosts;
		}

		const nextCursor = reachedEnd ? null : cursor ?? null;
		postsReturned = posts.length;
		const cacheResult = await appendOlderPostsToCache(bucket, did, posts, {
			nextCursor,
			reachedEnd,
			postsCount
		});
		cacheWrites = cacheResult.writes;

		const payload: OlderResponse = {
			posts,
			nextCursor,
			reachedEnd,
			apiCalls,
			cache: {
				written: cacheResult.written,
				postCount: cacheResult.postCount,
				chunkCount: cacheResult.chunkCount,
				reachedEnd: cacheResult.reachedEnd,
				limitReached: cacheResult.limitReached
			}
		};

		console.log(
			JSON.stringify({
				operation: 'posts.older',
				did,
				apiCalls,
				postsReturned,
				cacheWrites,
				elapsedMs: Date.now() - startedAt
			})
		);

		return Response.json(payload);
	} catch (error: any) {
		console.error(
			JSON.stringify({
				operation: 'posts.older',
				did,
				apiCalls,
				postsReturned,
				cacheWrites,
				elapsedMs: Date.now() - startedAt,
				error: error?.message || 'Unknown error'
			})
		);

		return Response.json(
			{
				error: 'older_fetch_failed',
				message: error?.message || 'Failed to fetch older posts.'
			},
			{ status: 502 }
		);
	}
};
