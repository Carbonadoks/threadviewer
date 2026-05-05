import type { RequestHandler } from '@sveltejs/kit';
import { readCachedPostPrefix } from '$lib/server/postCache';
import type {
	ClusterInspectorThread,
	ClusterThreadApiResponse,
	ThreadAnalysisPost,
	ThreadAnalysisSegment
} from '$lib/types';
import { buildThreadAnalysisDocument } from '$lib/utils/threadAnalysis';
import { buildThreadsFromFeed } from '$lib/utils/threadWalker';

const ANALYSIS_CACHE_VERSION = 'v3';
const EMBEDDING_CACHE_NAMESPACE = 'cf-bge-small-en-v1.5-cls';
const SNAPSHOT_MAX_POSTS = 1000;
const ANALYSIS_POSTS_KEY = `posts-${SNAPSHOT_MAX_POSTS}`;
const ANALYSIS_PREFIX = `analysis/${ANALYSIS_CACHE_VERSION}/${EMBEDDING_CACHE_NAMESPACE}/`;
const FALLBACK_SEGMENT_LIMIT = 2;

interface CachedAnalysisThread {
	rootUri?: unknown;
	title?: unknown;
	preview?: unknown;
	depth?: unknown;
	postCount?: unknown;
	segmentCount?: unknown;
	posts?: unknown;
	segments?: unknown;
}

function jsonResponse(data: ClusterThreadApiResponse, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: {
			'Content-Type': 'application/json; charset=utf-8'
		}
	});
}

function toText(value: unknown, fallback = ''): string {
	return typeof value === 'string' ? value : fallback;
}

function toCount(value: unknown): number {
	return Number.isFinite(Number(value)) ? Math.max(0, Math.round(Number(value))) : 0;
}

function normalizePosts(value: unknown): ThreadAnalysisPost[] {
	if (!Array.isArray(value)) return [];
	return value
		.map((item) => ({
			uri: toText(item?.uri),
			text: toText(item?.text),
			createdAt: toText(item?.createdAt)
		}))
		.filter((item) => item.uri.length > 0 || item.text.length > 0);
}

function normalizeSegments(value: unknown): ThreadAnalysisSegment[] {
	if (!Array.isArray(value)) return [];
	return value
		.map((item, index) => ({
			index: Number.isFinite(Number(item?.index)) ? Math.max(1, Math.round(Number(item.index))) : index + 1,
			uri: toText(item?.uri),
			createdAt: toText(item?.createdAt),
			text: toText(item?.text)
		}))
		.filter((item) => item.text.length > 0);
}

async function listAllObjects(bucket: R2Bucket, prefix: string): Promise<R2Object[]> {
	const objects: R2Object[] = [];
	let cursor: string | undefined;

	while (true) {
		const listing = await bucket.list({ prefix, cursor });
		objects.push(...listing.objects);
		if (!listing.truncated || !listing.cursor) break;
		cursor = listing.cursor;
	}

	return objects;
}

async function readThreadFromAnalysisCache(
	bucket: R2Bucket,
	did: string,
	rootUri: string
): Promise<ClusterInspectorThread | null> {
	const prefix = `${ANALYSIS_PREFIX}${did}/${ANALYSIS_POSTS_KEY}/`;
	const objects = await listAllObjects(bucket, prefix);
	objects.sort((a, b) => a.key.localeCompare(b.key));

	for (const object of objects) {
		const stored = await bucket.get(object.key);
		if (!stored) continue;

		try {
			const payload = await stored.json<any>();
			const threads = Array.isArray(payload?.batch?.threads) ? payload.batch.threads : [];
			const match = threads.find(
				(thread: CachedAnalysisThread) =>
					typeof thread?.rootUri === 'string' && thread.rootUri === rootUri
			);
			if (!match) continue;

			const posts = normalizePosts(match.posts);
			const segments = normalizeSegments(match.segments);
			return {
				did,
				rootUri,
				title: toText(match.title, toText(match.preview, 'Untitled thread')),
				preview: toText(match.preview),
				depth: toCount(match.depth),
				postCount: toCount(match.postCount),
				segmentCount: toCount(match.segmentCount),
				posts,
				segments,
				source: 'analysis-cache',
				cacheLimited: false
			};
		} catch {
			// Ignore malformed cached analysis batches.
		}
	}

	return null;
}

async function readCachedFeedPosts(
	bucket: R2Bucket,
	did: string,
	maxPosts: number
): Promise<{ posts: any[]; reachedEnd: boolean } | null> {
	const cached = await readCachedPostPrefix(bucket, did, maxPosts, {
		allowPartial: true
	});
	if (!cached) return null;

	return {
		posts: cached.posts,
		reachedEnd: cached.reachedEnd
	};
}

function buildFallbackSegments(
	rootUri: string,
	posts: ThreadAnalysisPost[],
	segments: string[]
): ThreadAnalysisSegment[] {
	return segments.map((text, index) => {
		const sourcePost = posts[Math.min(index, Math.max(0, posts.length - 1))];
		return {
			index: index + 1,
			uri: sourcePost?.uri || rootUri,
			createdAt: sourcePost?.createdAt || '',
			text
		};
	});
}

async function readThreadFromPostCache(
	bucket: R2Bucket,
	did: string,
	rootUri: string
): Promise<ClusterInspectorThread | null> {
	const cached = await readCachedFeedPosts(bucket, did, SNAPSHOT_MAX_POSTS);
	if (!cached || cached.posts.length === 0) return null;

	const { threads, orphanToTrueRoot } = buildThreadsFromFeed(cached.posts, did);
	const thread = threads.find((candidate) => candidate.rootUri === rootUri && candidate.depth >= 2);
	if (!thread) return null;

	const document = buildThreadAnalysisDocument(thread, FALLBACK_SEGMENT_LIMIT);
	if (document.posts.length === 0 || document.segments.length === 0) return null;

	const cacheLimited =
		orphanToTrueRoot.has(rootUri) ||
		(!cached.reachedEnd && cached.posts.length < SNAPSHOT_MAX_POSTS);

	return {
		did,
		rootUri,
		title: document.title,
		preview: document.preview,
		depth: thread.depth,
		postCount: document.posts.length,
		segmentCount: document.segments.length,
		posts: document.posts,
		segments: buildFallbackSegments(rootUri, document.posts, document.segments),
		source: 'post-cache',
		cacheLimited
	};
}

export const GET: RequestHandler = async ({ platform, url }) => {
	const bucket = platform?.env?.POST_CACHE;
	if (!bucket) {
		return jsonResponse(
			{
				status: 'missing',
				message: 'The cluster cache bucket is unavailable.'
			},
			503
		);
	}

	const did = url.searchParams.get('did')?.trim() || '';
	const rootUri = url.searchParams.get('rootUri')?.trim() || '';
	if (!did || !rootUri) {
		return jsonResponse(
			{
				status: 'missing',
				message: 'Both did and rootUri are required.'
			},
			400
		);
	}

	const fromAnalysis = await readThreadFromAnalysisCache(bucket, did, rootUri);
	if (fromAnalysis) {
		return jsonResponse({
			status: 'ready',
			thread: fromAnalysis
		});
	}

	const fromPosts = await readThreadFromPostCache(bucket, did, rootUri);
	if (fromPosts) {
		return jsonResponse({
			status: 'ready',
			thread: fromPosts
		});
	}

	return jsonResponse(
		{
			status: 'missing',
			message:
				'This self-reply thread is not available in the cached analyzer batches or cached post snapshot.'
		},
		404
	);
};
