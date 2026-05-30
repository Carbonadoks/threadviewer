import type { ThreadPost, SelfReplyThread, DiscoverProgress, DiscoverResult, DiscoverCallbacks } from '$lib/types';
import { extractBskyPostUrlsFromFacets } from '$lib/utils/viewerLinks';

function mapImages(images: any[]): NonNullable<NonNullable<ThreadPost['embed']>['images']> {
	return (images ?? []).map((img: any) => ({
		thumb: img.thumb,
		fullsize: img.fullsize || img.thumb,
		alt: img.alt || '',
		aspectRatio: img.aspectRatio
			? {
					width: Number(img.aspectRatio.width) || 1,
					height: Number(img.aspectRatio.height) || 1
				}
			: undefined
	}));
}

function mapVideo(video: any): NonNullable<ThreadPost['embed']>['video'] {
	if (!video?.playlist) return undefined;
	return {
		cid: video.cid || '',
		playlist: video.playlist,
		thumbnail: video.thumbnail,
		alt: video.alt || '',
		aspectRatio: video.aspectRatio
			? { width: Number(video.aspectRatio.width) || 1, height: Number(video.aspectRatio.height) || 1 }
			: undefined,
		presentation: video.presentation
	};
}

function mapExternal(ext: any): NonNullable<ThreadPost['embed']>['external'] {
	if (!ext) return undefined;
	return {
		uri: ext.uri,
		title: ext.title || '',
		description: ext.description || '',
		thumb: ext.thumb
	};
}

const MAX_NESTED_RECORD_DEPTH = 2;

function extractNestedRecord(embeds: any[] | undefined, depth: number): NonNullable<ThreadPost['embed']>['record'] {
	if (depth >= MAX_NESTED_RECORD_DEPTH) return undefined;
	const recordView = embeds?.find((e: any) => e?.$type === 'app.bsky.embed.record#view');
	if (recordView) return parseRecordEmbed(recordView.record, depth + 1);
	const recordWithMedia = embeds?.find((e: any) => e?.$type === 'app.bsky.embed.recordWithMedia#view');
	if (recordWithMedia) return parseRecordEmbed(recordWithMedia.record?.record, depth + 1);
	return undefined;
}

function parseRecordEmbed(record: any, depth = 0): NonNullable<ThreadPost['embed']>['record'] {
	if (!record || record.$type === 'app.bsky.embed.record#viewNotFound' || record.$type === 'app.bsky.embed.record#viewBlocked') {
		return undefined;
	}
	const val = record.value || record.record || {};
	const imageView = record.embeds?.find((e: any) => e?.$type === 'app.bsky.embed.images#view');
	const videoView = record.embeds?.find((e: any) => e?.$type === 'app.bsky.embed.video#view');
	const externalView = record.embeds?.find((e: any) => e?.$type === 'app.bsky.embed.external#view');
	return {
		uri: record.uri || '',
		author: {
			handle: record.author?.handle || '',
			displayName: record.author?.displayName,
			avatar: record.author?.avatar
		},
		text: val.text || '',
		createdAt: val.createdAt || record.indexedAt || '',
		images: imageView ? mapImages(imageView.images) : undefined,
		video: videoView ? mapVideo(videoView) : undefined,
		external: externalView ? mapExternal(externalView.external) : undefined,
		record: extractNestedRecord(record.embeds, depth)
	};
}

export function parsePostViewEmbed(embed: any): ThreadPost['embed'] | undefined {
	if (!embed) return undefined;
	const type = embed.$type;

	if (type === 'app.bsky.embed.images#view') {
		return { type: 'images', images: mapImages(embed.images) };
	}
	if (type === 'app.bsky.embed.external#view') {
		return { type: 'external', external: mapExternal(embed.external) };
	}
	if (type === 'app.bsky.embed.video#view') {
		return { type: 'video', video: mapVideo(embed) };
	}
	if (type === 'app.bsky.embed.record#view') {
		const record = parseRecordEmbed(embed.record);
		if (record) return { type: 'record', record };
	}
	if (type === 'app.bsky.embed.recordWithMedia#view') {
		const result: NonNullable<ThreadPost['embed']> = { type: 'recordWithMedia' };
		const media = embed.media;
		if (media?.$type === 'app.bsky.embed.images#view') {
			result.images = mapImages(media.images);
		} else if (media?.$type === 'app.bsky.embed.video#view') {
			result.video = mapVideo(media);
		} else if (media?.$type === 'app.bsky.embed.external#view') {
			result.external = mapExternal(media.external);
		}
		result.record = parseRecordEmbed(embed.record?.record);
		return result;
	}
	return undefined;
}

function feedItemToPost(item: any): ThreadPost | null {
	const post = item.post;
	if (!post) return null;

	return {
		uri: post.uri,
		cid: post.cid,
		author: {
			did: post.author.did,
			handle: post.author.handle,
			displayName: post.author.displayName,
			avatar: post.author.avatar
		},
		text: post.record?.text || '',
		createdAt: post.record?.createdAt || post.indexedAt,
		linkedUrls: extractBskyPostUrlsFromFacets(post.record?.facets),
		needsHydratedPostView: Boolean(post.record?.embed) && !post.embed,
		likeCount: post.likeCount || 0,
		repostCount: post.repostCount || 0,
		replyCount: post.replyCount || 0,
		quoteCount: post.quoteCount || 0,
		embed: parsePostViewEmbed(post.embed),
		children: []
	};
}

export function measureDepth(node: ThreadPost): number {
	if (node.children.length === 0) return 1;
	return 1 + Math.max(...node.children.map(measureDepth));
}

/**
 * Build reply threads entirely from feed data for one author or a constrained
 * set of authors — no extra API calls.
 *
 * 1. Convert all matching posts to ThreadPost objects, keyed by URI
 * 2. Link children to parents when both posts exist in the constrained set
 * 3. Identify chain starts (posts with no in-feed parent in that set)
 * 4. Return the assembled trees
 */
export interface ThreadBuildResult {
	threads: SelfReplyThread[];
	/** Map from orphan thread rootUri → true root URI (needs fetching) */
	orphanToTrueRoot: Map<string, string>;
}

export function buildThreadsFromFeed(
	feedPosts: any[],
	authorDid: string | string[],
	onProgress?: (p: DiscoverProgress) => void
): ThreadBuildResult {
	const authorSet = new Set(
		(Array.isArray(authorDid) ? authorDid : [authorDid]).filter(
			(did): did is string => typeof did === 'string' && did.length > 0
		)
	);
	const postsByUri = new Map<string, ThreadPost>();
	const parentUriOf = new Map<string, string>(); // child uri -> parent uri
	const rootUriOf = new Map<string, string>(); // child uri -> thread root uri

	// First pass: create ThreadPost for each matching post
	for (let i = 0; i < feedPosts.length; i++) {
		const item = feedPosts[i];
		const post = item.post;
		if (!post || !authorSet.has(post.author.did)) continue;

		const threadPost = feedItemToPost(item);
		if (!threadPost) continue;

		postsByUri.set(post.uri, threadPost);

		const replyRef = post.record?.reply;
		if (replyRef?.parent?.uri) {
			parentUriOf.set(post.uri, replyRef.parent.uri);
		}
		if (replyRef?.root?.uri) {
			rootUriOf.set(post.uri, replyRef.root.uri);
		}

		if (i % 5000 === 0) {
			onProgress?.({ phase: 'Indexing posts...', current: i, total: feedPosts.length });
		}
	}

	onProgress?.({ phase: 'Linking threads...', current: 0, total: postsByUri.size });

	// Second pass: link children to parents
	const childUris = new Set<string>();
	for (const [childUri, parentUri] of parentUriOf) {
		const parent = postsByUri.get(parentUri);
		const child = postsByUri.get(childUri);
		if (parent && child) {
			parent.children.push(child);
			childUris.add(childUri);
		}
	}

	// Pass 2.5: fallback — if a post's direct parent is missing from the feed
	// (API deduplication), attach it to the thread root instead
	for (const [uri, rootUri] of rootUriOf) {
		if (childUris.has(uri)) continue; // already linked via direct parent
		if (uri === rootUri) continue; // this IS the root
		const root = postsByUri.get(rootUri);
		const orphan = postsByUri.get(uri);
		if (root && orphan) {
			root.children.push(orphan);
			childUris.add(uri);
		}
	}

	// Chain starts = user posts that aren't a child of another in-feed user post
	const threads: SelfReplyThread[] = [];
	const orphanToTrueRoot = new Map<string, string>();
	let processed = 0;
	for (const [uri, post] of postsByUri) {
		if (childUris.has(uri)) continue;

		const depth = measureDepth(post);
		threads.push({ rootPost: post, depth, rootUri: uri });

		// If this "root" is actually a reply whose true root isn't in our data,
		// mark it for hydration via the API
		const trueRootUri = rootUriOf.get(uri);
		if (trueRootUri && trueRootUri !== uri && !postsByUri.has(trueRootUri)) {
			orphanToTrueRoot.set(uri, trueRootUri);
		}

		processed++;
		if (processed % 5000 === 0) {
			onProgress?.({ phase: 'Finding roots...', current: processed, total: postsByUri.size });
		}
	}

	return { threads, orphanToTrueRoot };
}

export async function discoverThreads(
	did: string,
	maxPosts: number,
	callbacks: DiscoverCallbacks = {},
	signal?: AbortSignal,
	seedFeedPosts: any[] = []
): Promise<DiscoverResult> {
	const { onProgress, onThread } = callbacks;

	if (signal?.aborted) {
		throw new DOMException('Aborted', 'AbortError');
	}

	onProgress?.({ phase: 'Preparing posts...', current: 0, total: maxPosts });

	const allFeedPosts: any[] = [];
	const seenUris = new Set<string>();
	let fallbackKey = 0;

	function addUniquePosts(posts: any[]) {
		if (!Array.isArray(posts) || posts.length === 0) return;
		for (const item of posts) {
			const uri = item?.post?.uri;
			const key =
				typeof uri === 'string' && uri.length > 0
					? `uri:${uri}`
					: `fallback:${fallbackKey++}`;
			if (seenUris.has(key)) continue;
			seenUris.add(key);
			allFeedPosts.push(item);
		}
	}

	addUniquePosts(seedFeedPosts);

	// Trim if we overshot
	if (allFeedPosts.length > maxPosts) allFeedPosts.length = maxPosts;

	// Build threads from feed data (synchronous but with progress callbacks)
	onProgress?.({ phase: 'Building threads...', current: 0, total: allFeedPosts.length });
	const { threads } = buildThreadsFromFeed(allFeedPosts, did, onProgress);

	// Deliver threads in batches, yielding to browser between batches
	let threadsWithSelfReplies = 0;
	const BATCH_SIZE = 200;

	for (let i = 0; i < threads.length; i += BATCH_SIZE) {
		const end = Math.min(i + BATCH_SIZE, threads.length);
		for (let j = i; j < end; j++) {
			const thread = threads[j];
			if (thread.depth >= 2) threadsWithSelfReplies++;
			onThread?.(thread);
		}
		onProgress?.({
			phase: 'Building threads...',
			current: end,
			total: threads.length
		});
		if (signal?.aborted) {
			throw new DOMException('Aborted', 'AbortError');
		}
		// Yield to browser so UI stays responsive
		await new Promise(r => setTimeout(r, 0));
	}

	return {
		stats: {
			postsScanned: allFeedPosts.length,
			chainStarts: threads.length,
			threadsWithSelfReplies
		},
		feedPosts: allFeedPosts
	};
}
