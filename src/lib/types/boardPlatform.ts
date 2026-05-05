import type { SelfReplyThread, ThreadPost } from '$lib/types';

export type BoardThread = SelfReplyThread & { isTruncated?: boolean };

export type BoardPostUrlBuilder = (uri: string, handle: string) => string;

export type BoardThreadLoader = (uri: string) => Promise<BoardThread>;

export type BoardQuotePostLoader = (
	uri: string,
	options?: { limit?: number; fetchAll?: boolean }
) => Promise<{ posts: ThreadPost[]; hasMore: boolean }>;

export type BoardPlatformConfig = {
	name: string;
	postLabel: string;
	buildPostUrl: BoardPostUrlBuilder;
	loadThread?: BoardThreadLoader;
	fetchQuotePosts?: BoardQuotePostLoader;
};
