import type { AuthorInfo } from '$lib/types';
import type { ParsedPost } from './carParser';
import { extractBskyPostUrlsFromFacets } from '$lib/utils/viewerLinks';

/**
 * Convert a single parsed repo post record into the feed item shape
 * that buildThreadsFromFeed() expects.
 */
function repoPostToFeedItem(
	did: string,
	post: ParsedPost,
	author: AuthorInfo
): any {
	const record = post.record;
	return {
		post: {
			uri: `at://${did}/app.bsky.feed.post/${post.rkey}`,
			cid: post.cid,
			author: {
				did: author.did,
				handle: author.handle,
				displayName: author.displayName,
				avatar: author.avatar
			},
			record: {
				text: record?.text ?? '',
				createdAt: record?.createdAt ?? new Date().toISOString(),
				reply: record?.reply,
				facets: record?.facets,
				embed: record?.embed,
				$type: 'app.bsky.feed.post'
			},
			embed: undefined,
			likeCount: 0,
			repostCount: 0,
			replyCount: 0,
			quoteCount: 0,
			indexedAt: record?.createdAt ?? new Date().toISOString()
		}
	};
}

/**
 * Convert an array of parsed repo posts into feed items compatible
 * with buildThreadsFromFeed().
 */
export function repoPostsToFeedItems(
	did: string,
	posts: ParsedPost[],
	author: AuthorInfo
): any[] {
	return posts.map((post) => repoPostToFeedItem(did, post, author));
}
