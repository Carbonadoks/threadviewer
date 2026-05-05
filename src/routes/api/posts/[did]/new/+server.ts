import type { RequestHandler } from './$types';
import { appendNewPostsToCache } from '$lib/server/postCache';

const BLUESKY_API = 'https://public.api.bsky.app';
const MAX_API_CALLS_PER_REQUEST = 5;
const MAX_POSTS_PER_REQUEST = 500;
const DEFAULT_POST_LIMIT = 500;

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

function normalizeLimit(raw: string | null): number {
	const parsed = Number.parseInt(String(raw ?? DEFAULT_POST_LIMIT), 10);
	if (!Number.isFinite(parsed)) return DEFAULT_POST_LIMIT;

	const bounded = Math.min(Math.max(parsed, 100), MAX_POSTS_PER_REQUEST);
	const normalized = Math.floor(bounded / 100) * 100;
	return normalized > 0 ? normalized : 100;
}

export const GET: RequestHandler = async ({ params, platform, url }) => {
	const startedAt = Date.now();
	const did = params.did;
	const sinceUri = url.searchParams.get('sinceUri');
	const cursorParam = url.searchParams.get('cursor');
	const postsCountParam = url.searchParams.get('postsCount');
	const limit = normalizeLimit(url.searchParams.get('limit'));
	const postsCount = Number.parseInt(String(postsCountParam ?? 0), 10);

	let apiCalls = 0;
	let posts: any[] = [];
	let overlapFound = false;
	let hasMore = false;
	let nextCursor: string | null = null;
	let cacheWrites = 0;

	try {
		let cursor = cursorParam && cursorParam.length > 0 ? cursorParam : undefined;
		let latestCursor: string | null = cursor ?? null;

		while (posts.length < limit && apiCalls < MAX_API_CALLS_PER_REQUEST) {
			const result = await fetchBlueskyFeed(did, cursor);
			apiCalls += 1;

			if (result.feed.length === 0) {
				cursor = undefined;
				break;
			}

			for (const item of result.feed) {
				const uri = item?.post?.uri;
				if (sinceUri && typeof uri === 'string' && uri === sinceUri) {
					overlapFound = true;
					break;
				}

				posts.push(item);
				if (posts.length >= limit) break;
			}

			if (overlapFound) {
				hasMore = false;
				nextCursor = null;
				break;
			}

			if (!result.cursor) {
				cursor = undefined;
				latestCursor = null;
				break;
			}

			cursor = result.cursor;
			latestCursor = result.cursor;

			if (posts.length >= limit) {
				hasMore = true;
				nextCursor = cursor;
				break;
			}
		}

		if (overlapFound) {
			hasMore = false;
			nextCursor = null;
		} else {
			const hitLimit = posts.length >= limit;
			const hitCallCap = apiCalls >= MAX_API_CALLS_PER_REQUEST;
			hasMore = Boolean(latestCursor) && (hitLimit || hitCallCap);
			nextCursor = hasMore ? latestCursor : null;
		}

		const cache = await appendNewPostsToCache(platform?.env?.POST_CACHE, did, posts, {
			anchorUri: sinceUri,
			nextCursor,
			hasMore,
			postsCount
		});
		cacheWrites = cache.writes;

		console.log(
			JSON.stringify({
				operation: 'posts.new',
				did,
				apiCalls,
				postsReturned: posts.length,
				cacheWrites,
				elapsedMs: Date.now() - startedAt
			})
		);

		return Response.json({
			posts,
			overlapFound,
			hasMore,
			nextCursor,
			apiCalls,
			cache: {
				written: cache.written,
				postCount: cache.postCount,
				chunkCount: cache.chunkCount,
				reachedEnd: cache.reachedEnd,
				limitReached: cache.limitReached
			}
		});
	} catch (error: any) {
		console.error(
			JSON.stringify({
				operation: 'posts.new',
				did,
				apiCalls,
				postsReturned: posts.length,
				cacheWrites,
				elapsedMs: Date.now() - startedAt,
				error: error?.message || 'Unknown error'
			})
		);

		return Response.json(
			{
				error: 'new_fetch_failed',
				message: error?.message || 'Failed to fetch new posts.'
			},
			{ status: 502 }
		);
	}
};
