import type {
	CachedUserSummary,
	CachedUserSummaryMention,
	CachedUserSummaryPost,
	CachedUserSummaryRepeatedPost,
	CachedUserSummaryThumbnail,
	CachedUserSummaryThread,
	ThreadPost
} from '$lib/types';
import { buildThreadsFromFeed } from '$lib/utils/threadWalker';
import { normalizeBskyPostUrl } from '$lib/utils/viewerLinks';

const DEFAULT_MENTION_LIMIT = 12;
const DEFAULT_POST_LIMIT = 10;
const DEFAULT_THREAD_LIMIT = 10;

type SummaryBuildOptions = {
	did: string;
	feedPosts: any[];
	cachedPostCount?: number;
	updatedAt?: string | null;
	partial?: boolean;
	mentionLimit?: number;
	postLimit?: number;
	threadLimit?: number;
};

function toFiniteCount(value: unknown): number {
	if (!Number.isFinite(Number(value))) return 0;
	return Math.max(0, Math.round(Number(value)));
}

function toText(value: unknown): string {
	return typeof value === 'string' ? value : '';
}

function toThumbnail(url: unknown, alt: unknown): CachedUserSummaryThumbnail | undefined {
	const normalizedUrl = toText(url).trim();
	if (!normalizedUrl) return undefined;
	return {
		url: normalizedUrl,
		alt: toText(alt)
	};
}

function toBlobCid(value: unknown): string {
	if (!value || typeof value !== 'object') return '';

	const directLink = toText((value as { $link?: unknown }).$link);
	if (directLink) return directLink;

	const ref = (value as { ref?: unknown }).ref;
	if (ref && typeof ref === 'object') {
		const refLink = toText((ref as { $link?: unknown }).$link);
		if (refLink) return refLink;
		if (typeof (ref as { toString?: () => string }).toString === 'function') {
			const rendered = (ref as { toString: () => string }).toString();
			if (rendered && rendered !== '[object Object]') return rendered;
		}
	}

	if (typeof (value as { toString?: () => string }).toString === 'function') {
		const rendered = (value as { toString: () => string }).toString();
		if (rendered && rendered !== '[object Object]') return rendered;
	}

	return '';
}

function blobThumbnailUrl(authorDid: string, blob: unknown): string | undefined {
	const did = toText(authorDid).trim();
	const cid = toBlobCid(blob);
	if (!did || !cid) return undefined;
	return `https://cdn.bsky.app/img/feed_thumbnail/plain/${encodeURIComponent(did)}/${encodeURIComponent(cid)}@jpeg`;
}

function thumbnailFromEmbedViewRecord(record: any): CachedUserSummaryThumbnail | undefined {
	const embeds = Array.isArray(record?.embeds) ? record.embeds : [];
	for (const embed of embeds) {
		const thumbnail = thumbnailFromEmbedView(embed);
		if (thumbnail) return thumbnail;
	}
	return undefined;
}

function thumbnailFromEmbedView(embed: any): CachedUserSummaryThumbnail | undefined {
	const type = toText(embed?.$type);
	if (type === 'app.bsky.embed.images#view') {
		const image = Array.isArray(embed?.images) ? embed.images[0] : null;
		return toThumbnail(image?.thumb ?? image?.fullsize, image?.alt);
	}
	if (type === 'app.bsky.embed.video#view') {
		return toThumbnail(embed?.thumbnail, embed?.alt);
	}
	if (type === 'app.bsky.embed.external#view') {
		return toThumbnail(embed?.external?.thumb, embed?.external?.title);
	}
	if (type === 'app.bsky.embed.record#view') {
		return thumbnailFromEmbedViewRecord(embed?.record);
	}
	if (type === 'app.bsky.embed.recordWithMedia#view') {
		return thumbnailFromEmbedView(embed?.media) ?? thumbnailFromEmbedViewRecord(embed?.record?.record ?? embed?.record);
	}
	return undefined;
}

function thumbnailFromRecordEmbed(embed: any, authorDid: string): CachedUserSummaryThumbnail | undefined {
	const type = toText(embed?.$type);
	if (type === 'app.bsky.embed.images') {
		const image = Array.isArray(embed?.images) ? embed.images[0] : null;
		return toThumbnail(blobThumbnailUrl(authorDid, image?.image), image?.alt);
	}
	if (type === 'app.bsky.embed.external') {
		return toThumbnail(blobThumbnailUrl(authorDid, embed?.external?.thumb), embed?.external?.title);
	}
	if (type === 'app.bsky.embed.recordWithMedia') {
		return thumbnailFromRecordEmbed(embed?.media, authorDid);
	}
	return undefined;
}

function extractSummaryThumbnail(item: any): CachedUserSummaryThumbnail | undefined {
	const authorDid = toText(item?.post?.author?.did);
	return thumbnailFromEmbedView(item?.post?.embed) ?? thumbnailFromRecordEmbed(item?.post?.record?.embed, authorDid);
}

function toTimestamp(value: string): number {
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : 0;
}

function compareIsoDesc(a: string, b: string): number {
	return toTimestamp(b) - toTimestamp(a);
}

function postKey(item: any, fallbackIndex: number): string {
	const uri = toText(item?.post?.uri);
	if (uri) return `uri:${uri}`;
	const cid = toText(item?.post?.cid);
	if (cid) return `cid:${cid}`;
	return `fallback:${fallbackIndex}`;
}

function uniqueAuthorPosts(feedPosts: any[], did: string): any[] {
	const posts: any[] = [];
	const seen = new Set<string>();
	let fallbackIndex = 0;

	for (const item of feedPosts) {
		if (toText(item?.post?.author?.did) !== did) continue;
		const key = postKey(item, fallbackIndex++);
		if (seen.has(key)) continue;
		seen.add(key);
		posts.push(item);
	}

	return posts;
}

function toSummaryPost(item: any): CachedUserSummaryPost {
	return {
		uri: toText(item?.post?.uri),
		createdAt: toText(item?.post?.record?.createdAt) || toText(item?.post?.indexedAt),
		text: toText(item?.post?.record?.text),
		likeCount: toFiniteCount(item?.post?.likeCount),
		repostCount: toFiniteCount(item?.post?.repostCount),
		replyCount: toFiniteCount(item?.post?.replyCount),
		quoteCount: toFiniteCount(item?.post?.quoteCount),
		thumbnail: extractSummaryThumbnail(item)
	};
}

function extractMentionDids(item: any, authorDid: string): string[] {
	const mentions: string[] = [];
	const facets = Array.isArray(item?.post?.record?.facets) ? item.post.record.facets : [];

	for (const facet of facets) {
		const features = Array.isArray(facet?.features) ? facet.features : [];
		for (const feature of features) {
			if (toText(feature?.$type) !== 'app.bsky.richtext.facet#mention') continue;
			const did = toText(feature?.did);
			if (!did || did === authorDid) continue;
			mentions.push(did);
		}
	}

	return mentions;
}

function extractCanonicalLinkUris(item: any): string[] {
	const facets = Array.isArray(item?.post?.record?.facets) ? item.post.record.facets : [];
	const urls: string[] = [];

	for (const facet of facets) {
		const features = Array.isArray(facet?.features) ? facet.features : [];
		for (const feature of features) {
			if (toText(feature?.$type) !== 'app.bsky.richtext.facet#link') continue;
			const rawUri = toText(feature?.uri).trim();
			if (!rawUri) continue;
			urls.push(normalizeBskyPostUrl(rawUri) ?? rawUri);
		}
	}

	return urls;
}

function repeatedPostGroupKey(item: any): string | null {
	const text = toText(item?.post?.record?.text);
	if (text.length === 0) return null;

	const linkUris = extractCanonicalLinkUris(item);
	return linkUris.length > 0 ? `${text}\u001f${linkUris.join('\u001f')}` : text;
}

function summarizeMentions(
	posts: any[],
	authorDid: string,
	limit: number
): {
	uniqueMentionedUsers: number;
	mentions: CachedUserSummaryMention[];
} {
	const counts = new Map<string, { count: number; lastMentionedAt: string | null }>();

	for (const item of posts) {
		const createdAt = toText(item?.post?.record?.createdAt) || toText(item?.post?.indexedAt) || null;
		for (const did of extractMentionDids(item, authorDid)) {
			const existing = counts.get(did);
			if (existing) {
				existing.count += 1;
				if (createdAt && compareIsoDesc(existing.lastMentionedAt ?? '', createdAt) > 0) {
					existing.lastMentionedAt = createdAt;
				}
			} else {
				counts.set(did, {
					count: 1,
					lastMentionedAt: createdAt
				});
			}
		}
	}

	const mentions = [...counts.entries()]
		.map(([did, value]) => ({
			did,
			count: value.count,
			lastMentionedAt: value.lastMentionedAt
		}))
		.sort(
			(a, b) =>
				b.count - a.count ||
				compareIsoDesc(a.lastMentionedAt ?? '', b.lastMentionedAt ?? '') ||
				a.did.localeCompare(b.did)
		)
		.slice(0, limit);

	return {
		uniqueMentionedUsers: counts.size,
		mentions
	};
}

function rankPosts(
	posts: CachedUserSummaryPost[],
	limit: number,
	metric: 'likeCount' | 'repostCount'
): CachedUserSummaryPost[] {
	return posts
		.filter((post) => post[metric] > 0)
		.sort(
			(a, b) =>
				b[metric] - a[metric] ||
				b.replyCount - a.replyCount ||
				compareIsoDesc(a.createdAt, b.createdAt) ||
				a.uri.localeCompare(b.uri)
		)
		.slice(0, limit);
}

function summarizeThreadNode(node: ThreadPost): {
	postCount: number;
	totalReplyCount: number;
} {
	let postCount = 1;
	let totalReplyCount = toFiniteCount(node.replyCount);

	for (const child of node.children) {
		const childSummary = summarizeThreadNode(child);
		postCount += childSummary.postCount;
		totalReplyCount += childSummary.totalReplyCount;
	}

	return { postCount, totalReplyCount };
}

function summarizeThreads(posts: any[], did: string, limit: number): CachedUserSummaryThread[] {
	const { threads } = buildThreadsFromFeed(posts, did);
	const itemsByUri = new Map<string, any>();

	for (const item of posts) {
		const uri = toText(item?.post?.uri);
		if (!uri || itemsByUri.has(uri)) continue;
		itemsByUri.set(uri, item);
	}

	return threads
		.map((thread) => {
			const metrics = summarizeThreadNode(thread.rootPost);
			return {
				rootUri: thread.rootUri,
				createdAt: thread.rootPost.createdAt,
				text: thread.rootPost.text,
				depth: thread.depth,
				postCount: metrics.postCount,
				totalReplyCount: metrics.totalReplyCount,
				rootReplyCount: toFiniteCount(thread.rootPost.replyCount),
				thumbnail: extractSummaryThumbnail(itemsByUri.get(thread.rootUri))
			};
		})
		.filter((thread) => thread.totalReplyCount > 0)
		.sort(
			(a, b) =>
				b.totalReplyCount - a.totalReplyCount ||
				b.postCount - a.postCount ||
				b.depth - a.depth ||
				compareIsoDesc(a.createdAt, b.createdAt) ||
				a.rootUri.localeCompare(b.rootUri)
		)
		.slice(0, limit);
}

function summarizeRepeatedPosts(posts: any[], limit: number): CachedUserSummaryRepeatedPost[] {
	const groups = new Map<
		string,
		{
			text: string;
			count: number;
			latestUri: string;
			latestCreatedAt: string;
			firstCreatedAt: string;
			thumbnail?: CachedUserSummaryThumbnail;
		}
	>();

	for (const item of posts) {
		const text = toText(item?.post?.record?.text);
		if (text.length === 0) continue;
		const groupKey = repeatedPostGroupKey(item);
		if (!groupKey) continue;

		const createdAt = toText(item?.post?.record?.createdAt) || toText(item?.post?.indexedAt);
		const uri = toText(item?.post?.uri);
		const thumbnail = extractSummaryThumbnail(item);
		const existing = groups.get(groupKey);
		if (existing) {
			existing.count += 1;
			if (compareIsoDesc(existing.latestCreatedAt, createdAt) > 0) {
				existing.latestCreatedAt = createdAt;
				existing.latestUri = uri;
				existing.thumbnail = thumbnail;
			}
			if (compareIsoDesc(createdAt, existing.firstCreatedAt) > 0) {
				existing.firstCreatedAt = createdAt;
			}
		} else {
			groups.set(groupKey, {
				text,
				count: 1,
				latestUri: uri,
				latestCreatedAt: createdAt,
				firstCreatedAt: createdAt,
				thumbnail
			});
		}
	}

	return [...groups.values()]
		.filter((entry) => entry.count > 1)
		.sort(
			(a, b) =>
				b.count - a.count ||
				compareIsoDesc(a.latestCreatedAt, b.latestCreatedAt) ||
				a.text.localeCompare(b.text)
		)
		.slice(0, limit);
}

export function buildCachedUserSummary(options: SummaryBuildOptions): CachedUserSummary {
	const mentionLimit = Math.max(1, Math.floor(options.mentionLimit ?? DEFAULT_MENTION_LIMIT));
	const postLimit = Math.max(1, Math.floor(options.postLimit ?? DEFAULT_POST_LIMIT));
	const threadLimit = Math.max(1, Math.floor(options.threadLimit ?? DEFAULT_THREAD_LIMIT));
	const posts = uniqueAuthorPosts(options.feedPosts, options.did);
	const summarizedPosts = posts.map(toSummaryPost);
	const mentionSummary = summarizeMentions(posts, options.did, mentionLimit);

	return {
		did: options.did,
		updatedAt: options.updatedAt ?? null,
		cachedPostCount: Math.max(0, Math.floor(options.cachedPostCount ?? posts.length)),
		analyzedPostCount: posts.length,
		partial: Boolean(options.partial),
		uniqueMentionedUsers: mentionSummary.uniqueMentionedUsers,
		mostMentionedUsers: mentionSummary.mentions,
		mostLikedPosts: rankPosts(summarizedPosts, postLimit, 'likeCount'),
		mostRepostedPosts: rankPosts(summarizedPosts, postLimit, 'repostCount'),
		mostRepeatedPosts: summarizeRepeatedPosts(posts, postLimit),
		threadsWithMostReplies: summarizeThreads(posts, options.did, threadLimit)
	};
}
