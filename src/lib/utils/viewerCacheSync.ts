export type ViewerMergeMode = 'append' | 'prepend';

export function postKey(item: any): string | null {
	const uri = item?.post?.uri;
	if (typeof uri === 'string' && uri.length > 0) return `uri:${uri}`;
	const cid = item?.post?.cid;
	if (typeof cid === 'string' && cid.length > 0) return `cid:${cid}`;
	return null;
}

export function mergeUniquePosts(
	seed: any[],
	incoming: any[],
	mode: ViewerMergeMode = 'append'
): any[] {
	const seen = new Set<string>();
	const merged: any[] = [];
	let fallback = 0;

	const add = (item: any, prefix: string) => {
		const key = postKey(item) ?? `${prefix}:${fallback++}`;
		if (seen.has(key)) return;
		seen.add(key);
		merged.push(item);
	};

	if (mode === 'prepend') {
		for (const item of incoming) add(item, 'incoming');
		for (const item of seed) add(item, 'seed');
	} else {
		for (const item of seed) add(item, 'seed');
		for (const item of incoming) add(item, 'incoming');
	}

	return merged;
}

export function getNewPostsAnchorUri(
	currentFeedPosts: any[],
	currentCursor: string | null,
	currentAnchorUri: string | null
): string | null {
	if (currentCursor && currentAnchorUri) {
		return currentAnchorUri;
	}

	const uri = currentFeedPosts[0]?.post?.uri;
	return typeof uri === 'string' && uri.length > 0 ? uri : null;
}

export function getNextNewPostsSyncState(
	requestAnchorUri: string | null,
	hasMore: boolean,
	nextCursor: string | null
): {
	newPostsCursor: string | null;
	newPostsAnchorUri: string | null;
} {
	return {
		newPostsCursor: hasMore ? nextCursor : null,
		newPostsAnchorUri: hasMore ? requestAnchorUri : null
	};
}

export function hasLoadedCompleteCachedFeed(options: {
	currentFeedPosts: any[];
	cachedPostCount: number;
	cacheReachedEnd: boolean;
	maxPosts: number;
}): boolean {
	if (!options.cacheReachedEnd) return false;

	const normalizedCachedPostCount = Math.max(0, options.cachedPostCount);
	const normalizedMaxPosts = Math.max(0, options.maxPosts);
	const cachedLoadedCount = Math.min(options.currentFeedPosts.length, normalizedCachedPostCount);
	const targetCachedCount = Math.min(normalizedMaxPosts, normalizedCachedPostCount);

	return targetCachedCount > 0 && cachedLoadedCount >= targetCachedCount;
}

export function resolveViewerFeedUpdate(options: {
	currentFeedPosts: any[];
	incomingPosts: any[];
	mode: ViewerMergeMode;
	cacheWritten: boolean;
	reloadedFeedPosts?: any[] | null;
}): {
	feedPosts: any[];
	added: number;
	usedCacheReload: boolean;
} {
	if (options.cacheWritten && Array.isArray(options.reloadedFeedPosts)) {
		return {
			feedPosts: options.reloadedFeedPosts,
			added: Math.max(0, options.reloadedFeedPosts.length - options.currentFeedPosts.length),
			usedCacheReload: true
		};
	}

	const merged = mergeUniquePosts(options.currentFeedPosts, options.incomingPosts, options.mode);
	return {
		feedPosts: merged,
		added: Math.max(0, merged.length - options.currentFeedPosts.length),
		usedCacheReload: false
	};
}
