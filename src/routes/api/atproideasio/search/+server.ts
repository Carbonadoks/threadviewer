import type { RequestHandler } from './$types';
import type { ThreadPost } from '$lib/types';

const BLUESKY_SEARCH_HOSTS = ['https://api.bsky.app', 'https://public.api.bsky.app'];
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 100;

interface SearchPostsResponse {
	cursor?: string;
	hitsTotal?: number;
	posts?: any[];
}

interface SearchAttempt {
	label: string;
	params: URLSearchParams;
}

interface SearchFailure {
	label: string;
	status?: number;
	detail: string;
}

function normalizeLimit(raw: string | null): number {
	const parsed = Number.parseInt(String(raw ?? DEFAULT_LIMIT), 10);
	if (!Number.isFinite(parsed)) return DEFAULT_LIMIT;
	return Math.max(1, Math.min(parsed, MAX_LIMIT));
}

function tagRegex(tag: string): RegExp {
	return new RegExp(`(^|[^\\p{L}\\p{N}_])#${tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'iu');
}

function postHasTag(post: any, tag: string): boolean {
	const cleanTag = tag.toLowerCase();
	const record = post?.record || {};
	if (Array.isArray(record.tags) && record.tags.some((entry: unknown) => String(entry).toLowerCase() === cleanTag)) {
		return true;
	}
	return tagRegex(tag).test(String(record.text || ''));
}

function summarizeFailureDetail(detail: string): string {
	const cleaned = detail
		.replace(/<style[\s\S]*?<\/style>/gi, ' ')
		.replace(/<script[\s\S]*?<\/script>/gi, ' ')
		.replace(/<[^>]+>/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
	return cleaned.slice(0, 300) || detail.slice(0, 300);
}

function mapImages(images: any[] | undefined): NonNullable<NonNullable<ThreadPost['embed']>['images']> | undefined {
	return images?.map((image) => ({
		thumb: image.thumb,
		fullsize: image.fullsize || image.thumb,
		alt: image.alt || ''
	}));
}

function mapVideo(video: any | undefined): NonNullable<NonNullable<ThreadPost['embed']>['video']> | undefined {
	if (!video?.playlist) return undefined;
	return {
		cid: video.cid || '',
		playlist: video.playlist,
		thumbnail: video.thumbnail,
		alt: video.alt || '',
		aspectRatio: video.aspectRatio
			? {
					width: Number(video.aspectRatio.width) || 1,
					height: Number(video.aspectRatio.height) || 1
				}
			: undefined,
		presentation: video.presentation
	};
}

function parseRecordEmbed(record: any): NonNullable<ThreadPost['embed']>['record'] | undefined {
	if (
		!record ||
		record.$type === 'app.bsky.embed.record#viewNotFound' ||
		record.$type === 'app.bsky.embed.record#viewBlocked'
	) {
		return undefined;
	}

	const value = record.value || {};
	return {
		uri: record.uri || '',
		author: {
			handle: record.author?.handle || '',
			displayName: record.author?.displayName,
			avatar: record.author?.avatar
		},
		text: value.text || '',
		createdAt: value.createdAt || record.indexedAt || ''
	};
}

function parseEmbed(embed: any): ThreadPost['embed'] | undefined {
	if (!embed) return undefined;

	if (embed.$type === 'app.bsky.embed.images#view') {
		return {
			type: 'images',
			images: mapImages(embed.images)
		};
	}

	if (embed.$type === 'app.bsky.embed.video#view') {
		return {
			type: 'video',
			video: mapVideo(embed)
		};
	}

	if (embed.$type === 'app.bsky.embed.external#view') {
		return {
			type: 'external',
			external: {
				uri: embed.external?.uri || '',
				title: embed.external?.title || '',
				description: embed.external?.description || '',
				thumb: embed.external?.thumb
			}
		};
	}

	if (embed.$type === 'app.bsky.embed.record#view') {
		const record = parseRecordEmbed(embed.record);
		return record ? { type: 'record', record } : undefined;
	}

	if (embed.$type === 'app.bsky.embed.recordWithMedia#view') {
		const result: NonNullable<ThreadPost['embed']> = { type: 'recordWithMedia' };
		if (embed.media?.$type === 'app.bsky.embed.images#view') {
			result.images = mapImages(embed.media.images);
		} else if (embed.media?.$type === 'app.bsky.embed.video#view') {
			result.video = mapVideo(embed.media);
		} else if (embed.media?.$type === 'app.bsky.embed.external#view') {
			result.external = {
				uri: embed.media.external?.uri || '',
				title: embed.media.external?.title || '',
				description: embed.media.external?.description || '',
				thumb: embed.media.external?.thumb
			};
		}
		result.record = parseRecordEmbed(embed.record?.record);
		return result;
	}

	return undefined;
}

function parsePostView(post: any): ThreadPost {
	const record = post.record || {};
	return {
		uri: post.uri || '',
		cid: post.cid || '',
		author: {
			did: post.author?.did || '',
			handle: post.author?.handle || '',
			displayName: post.author?.displayName,
			avatar: post.author?.avatar
		},
		text: record.text || '',
		createdAt: record.createdAt || post.indexedAt || '',
		likeCount: post.likeCount ?? 0,
		repostCount: post.repostCount ?? 0,
		replyCount: post.replyCount ?? 0,
		quoteCount: post.quoteCount ?? 0,
		embed: parseEmbed(post.embed),
		parentUri: record.reply?.parent?.uri,
		children: []
	};
}

export const GET: RequestHandler = async ({ request, url }) => {
	const tag = (url.searchParams.get('tag') ?? '').replace(/^#/, '').trim();
	if (!tag) {
		return Response.json({ message: 'Missing tag parameter.' }, { status: 400 });
	}

	const sort = url.searchParams.get('sort') === 'top' ? 'top' : 'latest';
	const limit = String(normalizeLimit(url.searchParams.get('limit')));
	const cursor = url.searchParams.get('cursor');

	if (cursor) {
		return Response.json({
			posts: [],
			cursor: undefined,
			warnings: [
				{
					label: 'search-pagination-disabled',
					status: 403,
					detail:
						'Bluesky public AppView search rejects cursor-based pagination, so only the first search page is fetched.'
				}
			]
		});
	}

	const queryAttempts: SearchAttempt[] = [
		{ label: 'tag-filter', params: new URLSearchParams({ q: tag, tag, sort, limit }) },
		{ label: 'hashtag-query', params: new URLSearchParams({ q: `#${tag}`, sort, limit }) },
		{ label: 'plain-query', params: new URLSearchParams({ q: tag, sort, limit }) }
	];

	try {
		const failures: SearchFailure[] = [];

		for (const host of BLUESKY_SEARCH_HOSTS) {
			for (const attempt of queryAttempts) {
				const response = await fetch(`${host}/xrpc/app.bsky.feed.searchPosts?${attempt.params}`, {
					headers: {
						Accept: 'application/json',
						'User-Agent': 'atprotocodex-threadviewer/1.0'
					},
					signal: request.signal
				});

				if (!response.ok) {
					failures.push({
						label: `${new URL(host).hostname}:${attempt.label}`,
						status: response.status,
						detail: summarizeFailureDetail(await response.text())
					});
					continue;
				}

				const data = (await response.json()) as SearchPostsResponse;
				const rawPosts =
					attempt.label === 'tag-filter'
						? (data.posts ?? [])
						: (data.posts ?? []).filter((post) => postHasTag(post, tag));
				return Response.json({
					posts: rawPosts.map(parsePostView),
					cursor: data.cursor,
					hitsTotal: data.hitsTotal,
					searchMode: `${new URL(host).hostname}:${attempt.label}`,
					warnings: failures
				});
			}
		}

		return Response.json(
			{
				message: 'Bluesky search failed.',
				failures
			},
			{ status: 502 }
		);
	} catch (error: any) {
		return Response.json(
			{
				message: error?.message || 'Failed to fetch tagged posts.'
			},
			{ status: 502 }
		);
	}
};
