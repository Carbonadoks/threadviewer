import type { SelfReplyThread, ThreadPost } from '$lib/types';

export type BoardThread = SelfReplyThread & { isTruncated?: boolean };

export type BoardPostUrlBuilder = (uri: string, handle: string) => string;

export type BoardThreadLoader = (uri: string, options?: { signal?: AbortSignal }) => Promise<BoardThread>;

export type BoardQuotePostLoader = (
	uri: string,
	options?: { limit?: number; fetchAll?: boolean }
) => Promise<{ posts: ThreadPost[]; hasMore: boolean }>;

/** One page of quote posts; lets the board stream large quote sets with progress. */
export type BoardQuotePostPageLoader = (
	uri: string,
	options?: { cursor?: string; limit?: number; signal?: AbortSignal }
) => Promise<{ posts: ThreadPost[]; cursor?: string }>;

export type BoardPlatformConfig = {
	name: string;
	postLabel: string;
	buildPostUrl: BoardPostUrlBuilder;
	/** Full conversation, loaded on demand ("Full thread"). */
	loadThread?: BoardThreadLoader;
	/** Cheap default for new lanes: the post, its parents and its replies. Falls back to `loadThread`. */
	loadPostContext?: BoardThreadLoader;
	fetchQuotePosts?: BoardQuotePostLoader;
	fetchQuotePostsPage?: BoardQuotePostPageLoader;
};
