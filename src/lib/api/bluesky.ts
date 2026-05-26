import { AtpAgent } from '@atproto/api';
import type { ThreadPost } from '../types';
import type { RecordEmbed } from '../utils/recordEmbed';
import {
	buildAtUri,
	extractBskyPostUrlsFromFacets,
	parseBskyPostUrl
} from '../utils/viewerLinks';

const agent = new AtpAgent({ service: 'https://public.api.bsky.app' });
type ThreadApiAgent = typeof agent;
const recordEmbedRequestCache = new Map<string, Promise<RecordEmbed | null>>();
const resolvedRecordEmbedCache = new Map<string, RecordEmbed | null>();
const hydratedPostViewRequestCache = new Map<string, Promise<ThreadPost | null>>();
const resolvedHydratedPostViewCache = new Map<string, ThreadPost>();
const pendingHydratedPostViewResolvers = new Map<
	string,
	Array<(post: ThreadPost | null) => void>
>();
const profileDidRequestCache = new Map<string, Promise<string | null>>();
const MAX_CONCURRENT_RECORD_EMBED_FETCHES = 4;
const CONSTELLATION_HOST = 'https://constellation.microcosm.blue';
const CONSTELLATION_REPLY_PARENT_SOURCE = 'app.bsky.feed.post:reply.parent.uri';
const CONSTELLATION_PAGE_LIMIT = 100;
const MAX_CONSTELLATION_PAGES = 10;
const FULL_THREAD_FLAT_DEPTH = 1000;
const THREAD_ITEM_BLOCKED_TYPE = 'app.bsky.unspecced.defs#threadItemBlocked';
let activeRecordEmbedFetches = 0;
const pendingRecordEmbedFetches: Array<() => void> = [];
let hydratedPostViewFlushScheduled = false;

export interface ProfileInfo {
	did: string;
	handle: string;
	displayName?: string;
	avatar?: string;
	postsCount: number;
}

export interface FollowProfileInfo extends ProfileInfo {
	description?: string;
	followersCount?: number;
	followsCount?: number;
	indexedAt?: string;
}

export interface FollowsPage {
	subject: FollowProfileInfo;
	follows: FollowProfileInfo[];
	cursor?: string;
}

export interface RecordEmbedLookupResult {
	record: RecordEmbed | null;
	unavailable: boolean;
}

export interface PostEngagementCounts {
	uri: string;
	likeCount: number;
	repostCount: number;
	replyCount: number;
	quoteCount: number;
	indexedAt: string;
}

export interface PostEngagementProgress {
	completed: number;
	total: number;
	batchesCompleted: number;
	totalBatches: number;
}

export interface FetchPostsProgress {
	completed: number;
	total: number;
	batchesCompleted: number;
	totalBatches: number;
}

export interface ReplyParentVisibility {
	parentUri: string;
	visibility: 'visible' | 'blocked' | 'unavailable' | 'unknown';
	parentAuthorDid: string | null;
	itemType: string;
	parentText: string | null;
	parentCreatedAt: string | null;
}

export interface TaggedPostSearchPage {
	posts: ThreadPost[];
	cursor?: string;
	hitsTotal?: number;
}

export type PostSearchAgent = {
	app: {
		bsky: {
			feed: {
				searchPosts: (params: Record<string, unknown>, options?: { signal?: AbortSignal }) => Promise<any>;
			};
		};
	};
};

function toFiniteCount(value: unknown): number {
	if (!Number.isFinite(Number(value))) return 0;
	return Math.max(0, Math.round(Number(value)));
}

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) {
		throw new DOMException('Aborted', 'AbortError');
	}
}

async function flushQueuedHydratedPostViews(): Promise<void> {
	hydratedPostViewFlushScheduled = false;
	const queuedUris = [...pendingHydratedPostViewResolvers.keys()];
	if (queuedUris.length === 0) return;

	const batch = queuedUris.slice(0, 25);
	const resolversByUri = new Map<string, Array<(post: ThreadPost | null) => void>>();
	for (const uri of batch) {
		resolversByUri.set(uri, pendingHydratedPostViewResolvers.get(uri) ?? []);
		pendingHydratedPostViewResolvers.delete(uri);
	}

	const postsByUri = new Map<string, ThreadPost>();
	try {
		const res = await agent.getPosts({ uris: batch });
		for (const post of res.data.posts ?? []) {
			postsByUri.set(post.uri, parsePostView(post));
		}
	} catch {
		// Leave this batch unresolved with null and allow later visibility-driven retries if needed.
	}

	for (const uri of batch) {
		const resolved = postsByUri.get(uri) ?? null;
		if (resolved) {
			resolvedHydratedPostViewCache.set(uri, resolved);
		}
		for (const resolve of resolversByUri.get(uri) ?? []) {
			resolve(resolved);
		}
	}

	if (pendingHydratedPostViewResolvers.size > 0) {
		scheduleQueuedHydratedPostViews();
	}
}

function scheduleQueuedHydratedPostViews(): void {
	if (hydratedPostViewFlushScheduled) return;
	hydratedPostViewFlushScheduled = true;
	queueMicrotask(() => {
		void flushQueuedHydratedPostViews();
	});
}

export async function getProfile(handle: string): Promise<ProfileInfo> {
	const cleanHandle = handle.replace(/^@/, '').trim();
	const res = await agent.getProfile({ actor: cleanHandle });
	return {
		did: res.data.did,
		handle: res.data.handle,
		displayName: res.data.displayName,
		avatar: res.data.avatar,
		postsCount: res.data.postsCount ?? 0
	};
}

export async function getProfiles(dids: string[]): Promise<ProfileInfo[]> {
	const batchSize = 25;
	const batches: string[][] = [];
	for (let i = 0; i < dids.length; i += batchSize) {
		batches.push(dids.slice(i, i + batchSize));
	}

	const results = await Promise.allSettled(
		batches.map((batch) => agent.getProfiles({ actors: batch }))
	);

	const profiles: ProfileInfo[] = [];
	for (const result of results) {
		if (result.status === 'fulfilled') {
			for (const p of result.value.data.profiles) {
				profiles.push({
					did: p.did,
					handle: p.handle,
					displayName: p.displayName,
					avatar: p.avatar,
					postsCount: p.postsCount ?? 0
				});
			}
		}
	}
	return profiles;
}

function profileViewToFollowInfo(profile: any): FollowProfileInfo {
	return {
		did: profile.did,
		handle: profile.handle,
		displayName: profile.displayName,
		description: profile.description,
		avatar: profile.avatar,
		postsCount: profile.postsCount ?? 0,
		followersCount: profile.followersCount,
		followsCount: profile.followsCount,
		indexedAt: profile.indexedAt
	};
}

export async function getFollowsPage(
	actor: string,
	options: { cursor?: string; limit?: number; signal?: AbortSignal } = {}
): Promise<FollowsPage> {
	const res = await agent.app.bsky.graph.getFollows(
		{
			actor,
			limit: options.limit ?? 100,
			cursor: options.cursor
		},
		{ signal: options.signal }
	);

	return {
		subject: profileViewToFollowInfo(res.data.subject),
		follows: (res.data.follows ?? []).map(profileViewToFollowInfo),
		cursor: res.data.cursor
	};
}

export async function fetchAuthorFeed(
	actor: string,
	cursor?: string
): Promise<{ posts: any[]; cursor?: string }> {
	const res = await agent.getAuthorFeed({
		actor,
		filter: 'posts_with_replies',
		limit: 100,
		cursor
	});
	return {
		posts: res.data.feed,
		cursor: res.data.cursor
	};
}

export interface ActorSuggestion {
	did: string;
	handle: string;
	displayName?: string;
	avatar?: string;
}

export async function searchActorsTypeahead(query: string): Promise<ActorSuggestion[]> {
	const cleaned = query.replace(/^@/, '').trim();
	if (cleaned.length < 2) return [];

	const res = await agent.searchActorsTypeahead({
		q: cleaned,
		limit: 8
	});

	return (res.data.actors || []).map((a: any) => ({
		did: a.did,
		handle: a.handle,
		displayName: a.displayName,
		avatar: a.avatar
	}));
}

export async function searchPostsByTag(
	tag: string,
	options: {
		cursor?: string;
		limit?: number;
		sort?: 'latest' | 'top';
		signal?: AbortSignal;
		agent?: PostSearchAgent;
	} = {}
): Promise<TaggedPostSearchPage> {
	const cleanTag = tag.replace(/^#/, '').trim();
	if (!cleanTag) {
		return { posts: [] };
	}

	const limit = Math.max(1, Math.min(options.limit ?? 100, 100));
	const searchAgent = options.agent ?? agent;
	const res = await searchAgent.app.bsky.feed.searchPosts(
		{
			q: `#${cleanTag}`,
			tag: [cleanTag],
			sort: options.sort ?? 'latest',
			limit,
			cursor: options.cursor
		},
		{ signal: options.signal }
	);

	return {
		posts: (res.data.posts ?? []).map((post: any) => parsePostView(post)),
		cursor: res.data.cursor,
		hitsTotal: res.data.hitsTotal
	};
}

export async function fetchPostThread(uri: string, apiAgent: ThreadApiAgent = agent): Promise<any> {
	const res = await apiAgent.getPostThread({
		uri,
		depth: 1000,
		parentHeight: 0
	});
	return res.data.thread;
}

function didFromAtUri(uri: string): string | null {
	const match = uri.match(/^at:\/\/([^/]+)\//);
	return match?.[1] ?? null;
}

function flatThreadItemType(item: any): string {
	return typeof item?.value?.$type === 'string' ? item.value.$type : '';
}

function isBlockedFlatThreadItem(itemType: string): boolean {
	return itemType === THREAD_ITEM_BLOCKED_TYPE || /blocked/i.test(itemType);
}

export function getReplyParentVisibilityFromFlatItems(
	items: any[],
	parentUri: string
): ReplyParentVisibility {
	const normalizedParentUri = parentUri.trim();
	const fallbackAuthorDid = didFromAtUri(normalizedParentUri);
	if (!Array.isArray(items) || !normalizedParentUri) {
		return {
			parentUri: normalizedParentUri,
			visibility: 'unknown',
			parentAuthorDid: fallbackAuthorDid,
			itemType: '',
			parentText: null,
			parentCreatedAt: null
		};
	}

	const item = items.find((entry) => {
		if (entry?.uri === normalizedParentUri) return true;
		return entry?.value?.post?.uri === normalizedParentUri;
	});
	if (!item) {
		return {
			parentUri: normalizedParentUri,
			visibility: 'unknown',
			parentAuthorDid: fallbackAuthorDid,
			itemType: '',
			parentText: null,
			parentCreatedAt: null
		};
	}

	const rawPost = item?.value?.post;
	const itemType = flatThreadItemType(item);
	const parentAuthorDid =
		(typeof rawPost?.author?.did === 'string' && rawPost.author.did) ||
		(typeof item?.value?.author?.did === 'string' && item.value.author.did) ||
		fallbackAuthorDid;

	if (rawPost && typeof rawPost.uri === 'string') {
		return {
			parentUri: normalizedParentUri,
			visibility: 'visible',
			parentAuthorDid,
			itemType,
			parentText: typeof rawPost?.record?.text === 'string' ? rawPost.record.text : '',
			parentCreatedAt:
				(typeof rawPost?.record?.createdAt === 'string' && rawPost.record.createdAt) ||
				(typeof rawPost?.indexedAt === 'string' && rawPost.indexedAt) ||
				null
		};
	}

	return {
		parentUri: normalizedParentUri,
		visibility: isBlockedFlatThreadItem(itemType) ? 'blocked' : 'unavailable',
		parentAuthorDid,
		itemType,
		parentText: null,
		parentCreatedAt: null
	};
}

export async function fetchReplyParentVisibility(
	replyUri: string,
	parentUri: string,
	options: { signal?: AbortSignal } = {}
): Promise<ReplyParentVisibility> {
	const normalizedParentUri = parentUri.trim();
	const fallback: ReplyParentVisibility = {
		parentUri: normalizedParentUri,
		visibility: 'unknown',
		parentAuthorDid: didFromAtUri(normalizedParentUri),
		itemType: '',
		parentText: null,
		parentCreatedAt: null
	};
	if (!replyUri.trim() || !normalizedParentUri) {
		return fallback;
	}

	throwIfAborted(options.signal);
	const getPostThreadV2 = (agent as any).app?.bsky?.unspecced?.getPostThreadV2;
	if (typeof getPostThreadV2 !== 'function') {
		return fallback;
	}

	try {
		const res = await getPostThreadV2(
			{
				anchor: replyUri,
				above: true,
				below: 0,
				branchingFactor: 0,
				sort: 'oldest'
			},
			options.signal ? { signal: options.signal } : undefined
		);
		throwIfAborted(options.signal);
		return getReplyParentVisibilityFromFlatItems(res.data.thread ?? [], normalizedParentUri);
	} catch (err: any) {
		if (err?.name === 'AbortError') {
			throw err;
		}
		return fallback;
	}
}

async function runQueuedRecordEmbedFetch<T>(task: () => Promise<T>): Promise<T> {
	if (activeRecordEmbedFetches >= MAX_CONCURRENT_RECORD_EMBED_FETCHES) {
		await new Promise<void>((resolve) => {
			pendingRecordEmbedFetches.push(resolve);
		});
	}

	activeRecordEmbedFetches += 1;
	try {
		return await task();
	} finally {
		activeRecordEmbedFetches -= 1;
		pendingRecordEmbedFetches.shift()?.();
	}
}

function isUnavailableRecordError(error: unknown): boolean {
	if (!error || typeof error !== 'object') return false;
	const status = 'status' in error ? Number(error.status) : undefined;
	const message = 'message' in error ? String(error.message || '') : '';
	const kind = 'error' in error ? String(error.error || '') : '';
	return status === 400 || status === 404 || kind === 'NotFound' || /not found|deleted|blocked/i.test(message);
}

export function peekCachedRecordEmbedByUri(uri: string): RecordEmbed | null | undefined {
	if (!uri || !resolvedRecordEmbedCache.has(uri)) {
		return undefined;
	}
	return resolvedRecordEmbedCache.get(uri) ?? null;
}

async function resolveDidForActor(actor: string): Promise<string | null> {
	const cleanedActor = actor.replace(/^@/, '').trim();
	if (!cleanedActor) return null;
	if (cleanedActor.startsWith('did:')) return cleanedActor;

	const cached = profileDidRequestCache.get(cleanedActor);
	if (cached) {
		return cached;
	}

	const request = getProfile(cleanedActor)
		.then((profile) => profile.did)
		.catch(() => null);

	profileDidRequestCache.set(cleanedActor, request);
	const result = await request;
	if (!result) {
		profileDidRequestCache.delete(cleanedActor);
	}
	return result;
}

function mapImages(images: any[] | undefined): NonNullable<NonNullable<ThreadPost['embed']>['images']> | undefined {
	return images?.map((img: any) => ({
		thumb: img.thumb,
		fullsize: img.fullsize || img.thumb,
		alt: img.alt || ''
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

function extractImageEmbeds(embeds: any[] | undefined): RecordEmbed['images'] {
	const imageView = embeds?.find((entry: any) => entry?.$type === 'app.bsky.embed.images#view');
	return imageView ? mapImages(imageView.images) : undefined;
}

function extractVideoEmbed(embeds: any[] | undefined): RecordEmbed['video'] {
	const videoView = embeds?.find((entry: any) => entry?.$type === 'app.bsky.embed.video#view');
	return videoView ? mapVideo(videoView) : undefined;
}

function parseRecordEmbedPost(post: any): RecordEmbed | undefined {
	if (!post) return undefined;
	const embed = parseEmbed(post.embed);
	return {
		uri: post.uri || '',
		author: {
			handle: post.author?.handle || '',
			displayName: post.author?.displayName,
			avatar: post.author?.avatar
		},
		text: post.record?.text || '',
		createdAt: post.record?.createdAt || post.indexedAt || '',
		images: embed?.images,
		video: embed?.video
	};
}

function parseRecordEmbed(record: any): RecordEmbed | undefined {
	if (!record || record.$type === 'app.bsky.embed.record#viewNotFound' || record.$type === 'app.bsky.embed.record#viewBlocked') {
		return undefined;
	}
	const val = record.value || record.record || {};
	return {
		uri: record.uri || '',
		author: {
			handle: record.author?.handle || '',
			displayName: record.author?.displayName,
			avatar: record.author?.avatar
		},
		text: val.text || '',
		createdAt: val.createdAt || record.indexedAt || '',
		images: extractImageEmbeds(record.embeds),
		video: extractVideoEmbed(record.embeds)
	};
}

function parseEmbed(embed: any): ThreadPost['embed'] | undefined {
	if (!embed) return undefined;
	const type = embed.$type;
	if (type === 'app.bsky.embed.images#view') {
		return {
			type: 'images',
			images: mapImages(embed.images)
		};
	}
	if (type === 'app.bsky.embed.external#view') {
		return {
			type: 'external',
			external: {
				uri: embed.external?.uri,
				title: embed.external?.title || '',
				description: embed.external?.description || '',
				thumb: embed.external?.thumb
			}
		};
	}
	if (type === 'app.bsky.embed.video#view') {
		return {
			type: 'video',
			video: mapVideo(embed)
		};
	}
	if (type === 'app.bsky.embed.record#view') {
		const record = parseRecordEmbed(embed.record);
		if (record) {
			return { type: 'record', record };
		}
	}
	if (type === 'app.bsky.embed.recordWithMedia#view') {
		const result: NonNullable<ThreadPost['embed']> = { type: 'recordWithMedia' };
		// Parse the media part
		const media = embed.media;
		if (media?.$type === 'app.bsky.embed.images#view') {
			result.images = mapImages(media.images);
		} else if (media?.$type === 'app.bsky.embed.video#view') {
			result.video = mapVideo(media);
		} else if (media?.$type === 'app.bsky.embed.external#view') {
			result.external = {
				uri: media.external?.uri,
				title: media.external?.title || '',
				description: media.external?.description || '',
				thumb: media.external?.thumb
			};
		}
		// Parse the record part
		result.record = parseRecordEmbed(embed.record?.record);
		return result;
	}
	return undefined;
}

export async function fetchRecordEmbedByUri(uri: string): Promise<RecordEmbed | null> {
	if (!uri) return null;

	if (resolvedRecordEmbedCache.has(uri)) {
		return resolvedRecordEmbedCache.get(uri) ?? null;
	}

	const cached = recordEmbedRequestCache.get(uri);
	if (cached) {
		return cached;
	}

	const request = runQueuedRecordEmbedFetch(async () => {
		try {
			const raw = await fetchPostThread(uri);
			const result =
				raw && raw.$type === 'app.bsky.feed.defs#threadViewPost'
					? (parseRecordEmbedPost(raw.post) ?? null)
					: null;
			resolvedRecordEmbedCache.set(uri, result);
			return result;
		} catch (error) {
			if (isUnavailableRecordError(error)) {
				resolvedRecordEmbedCache.set(uri, null);
			}
			return null;
		} finally {
			recordEmbedRequestCache.delete(uri);
		}
	});

	recordEmbedRequestCache.set(uri, request);
	return request;
}

export async function fetchHydratedPostViewByUri(uri: string): Promise<ThreadPost | null> {
	const normalizedUri = uri.trim();
	if (!normalizedUri) return null;

	const cached = resolvedHydratedPostViewCache.get(normalizedUri);
	if (cached) {
		return cached;
	}

	const pending = hydratedPostViewRequestCache.get(normalizedUri);
	if (pending) {
		return pending;
	}

	const request = new Promise<ThreadPost | null>((resolve) => {
		const queuedResolvers = pendingHydratedPostViewResolvers.get(normalizedUri);
		if (queuedResolvers) {
			queuedResolvers.push(resolve);
		} else {
			pendingHydratedPostViewResolvers.set(normalizedUri, [resolve]);
		}
		scheduleQueuedHydratedPostViews();
	}).finally(() => {
		hydratedPostViewRequestCache.delete(normalizedUri);
	});

	hydratedPostViewRequestCache.set(normalizedUri, request);
	return request;
}

export async function fetchRecordEmbedStatusByUri(uri: string): Promise<RecordEmbedLookupResult> {
	if (!uri) {
		return { record: null, unavailable: false };
	}

	const record = await fetchRecordEmbedByUri(uri);
	return {
		record,
		unavailable: peekCachedRecordEmbedByUri(uri) === null
	};
}

export async function fetchRecordEmbedByUrl(url: string): Promise<RecordEmbed | null> {
	const result = await fetchRecordEmbedStatusByUrl(url);
	return result.record;
}

export async function fetchRecordEmbedStatusByUrl(url: string): Promise<RecordEmbedLookupResult> {
	const parsed = parseBskyPostUrl(url);
	if (!parsed) {
		return { record: null, unavailable: false };
	}

	const did = await resolveDidForActor(parsed.handle);
	if (!did) {
		return { record: null, unavailable: false };
	}

	const atUri = buildAtUri(did, parsed.rkey);
	if (!atUri) {
		return { record: null, unavailable: false };
	}

	return fetchRecordEmbedStatusByUri(atUri);
}

function parsePostView(post: any): ThreadPost {
	const record = post.record || {};
	return {
		uri: post.uri,
		cid: post.cid,
		author: {
			did: post.author?.did,
			handle: post.author?.handle,
			displayName: post.author?.displayName,
			avatar: post.author?.avatar
		},
		text: record.text || '',
		createdAt: record.createdAt || post.indexedAt || '',
		linkedUrls: extractBskyPostUrlsFromFacets(record.facets),
		likeCount: post.likeCount ?? 0,
		repostCount: post.repostCount ?? 0,
		replyCount: post.replyCount ?? 0,
		quoteCount: post.quoteCount ?? 0,
		embed: parseEmbed(post.embed),
		parentUri: record.reply?.parent?.uri,
		children: []
	};
}

function findNearestVisibleAncestor(
	stack: Array<{
		depth: number;
		node: ThreadPost | null;
	}>
): ThreadPost | null {
	for (let index = stack.length - 1; index >= 0; index -= 1) {
		const ancestor = stack[index]?.node ?? null;
		if (ancestor) {
			return ancestor;
		}
	}
	return null;
}

function compareThreadPostsChronologically(a: ThreadPost, b: ThreadPost): number {
	const aTime = new Date(a.createdAt).getTime();
	const bTime = new Date(b.createdAt).getTime();
	if (Number.isFinite(aTime) && Number.isFinite(bTime) && aTime !== bTime) {
		return aTime - bTime;
	}
	return a.uri.localeCompare(b.uri);
}

function indexThreadByUri(root: ThreadPost): Map<string, ThreadPost> {
	const nodesByUri = new Map<string, ThreadPost>();

	function visit(node: ThreadPost): void {
		nodesByUri.set(node.uri, node);
		for (const child of node.children) {
			visit(child);
		}
	}

	visit(root);
	return nodesByUri;
}

interface VisibleHiddenThreadGap {
	uri: string;
	depth: number;
	attachToUri: string | null;
	parentUri: string | null;
	authorDid: string | null;
}

interface HiddenThreadGap {
	uri: string;
	authorDid: string | null;
}

function buildBlockedGapNode(options: {
	uri: string;
	authorDid: string | null;
	parentUri: string | null;
	createdAt?: string;
}): ThreadPost {
	const fallbackDid =
		options.authorDid || options.uri.match(/^at:\/\/([^/]+)\//)?.[1] || 'did:missing:blocked';

	return {
		uri: options.uri,
		cid: '',
		author: {
			did: fallbackDid,
			handle: fallbackDid,
			displayName: 'Blocked post'
		},
		text: '[Blocked post]',
		createdAt: options.createdAt ?? '',
		linkedUrls: [],
		likeCount: 0,
		repostCount: 0,
		replyCount: 0,
		quoteCount: 0,
		parentUri: options.parentUri ?? undefined,
		children: []
	};
}

/**
 * Build a visible thread tree from the flat v2 thread API.
 * Blocked or unavailable posts are treated as structural gaps so
 * their visible descendants can still be attached to the nearest
 * visible ancestor instead of disappearing with the gap.
 */
function parseVisibleThreadFromFlatItems(items: any[]): {
	rootPost: ThreadPost | null;
	hiddenGaps: VisibleHiddenThreadGap[];
} {
	if (!Array.isArray(items) || items.length === 0) {
		return { rootPost: null, hiddenGaps: [] };
	}

	const stack: Array<{ depth: number; uri: string; node: ThreadPost | null }> = [];
	const visiblePostsByUri = new Map<string, ThreadPost>();
	const roots: ThreadPost[] = [];
	const hiddenGaps: VisibleHiddenThreadGap[] = [];

	for (const item of items) {
		const depth = Number(item?.depth);
		const uri = typeof item?.uri === 'string' ? item.uri : '';
		if (!Number.isFinite(depth) || !uri) {
			continue;
		}

		while (stack.length > 0 && stack[stack.length - 1].depth >= depth) {
			stack.pop();
		}

		const value = item?.value;
		const rawPost = value?.post;
		if (!rawPost || typeof rawPost?.uri !== 'string') {
			const nearestVisibleAncestor = findNearestVisibleAncestor(stack);
			const structuralParent = stack[stack.length - 1] ?? null;
			if (uri) {
				hiddenGaps.push({
					uri,
					depth,
					attachToUri: nearestVisibleAncestor?.uri ?? null,
					parentUri: structuralParent?.uri ?? null,
					authorDid:
						typeof value?.author?.did === 'string' && value.author.did.length > 0
							? value.author.did
							: null
				});
			}
			stack.push({ depth, uri, node: null });
			continue;
		}

		let post = visiblePostsByUri.get(rawPost.uri);
		if (!post) {
			post = parsePostView(rawPost);
			visiblePostsByUri.set(post.uri, post);
		}

		const parent = findNearestVisibleAncestor(stack);
		if (parent) {
			if (!parent.children.some((child) => child.uri === post.uri)) {
				parent.children.push(post);
			}
		} else if (!roots.some((root) => root.uri === post.uri)) {
			roots.push(post);
		}

		stack.push({ depth, uri: post.uri, node: post });
	}

	return {
		rootPost: roots[0] ?? null,
		hiddenGaps
	};
}

function attachThreadChild(parent: ThreadPost | null, child: ThreadPost, roots: ThreadPost[]): void {
	if (!parent) {
		if (!roots.some((root) => root.uri === child.uri)) {
			roots.push(child);
		}
		return;
	}

	if (!parent.children.some((existingChild) => existingChild.uri === child.uri)) {
		parent.children.push(child);
	}
	if (!child.parentUri) {
		child.parentUri = parent.uri;
	}
	if (!child.createdAt && parent.createdAt) {
		child.createdAt = parent.createdAt;
	}
	if (!parent.createdAt && child.createdAt) {
		parent.createdAt = child.createdAt;
	}
}

function parseHydratableThreadFromFlatItems(items: any[]): {
	rootPost: ThreadPost | null;
	hiddenGaps: HiddenThreadGap[];
} {
	if (!Array.isArray(items) || items.length === 0) {
		return { rootPost: null, hiddenGaps: [] };
	}

	const stack: Array<{ depth: number; node: ThreadPost }> = [];
	const nodesByUri = new Map<string, ThreadPost>();
	const roots: ThreadPost[] = [];
	const hiddenGapMap = new Map<string, HiddenThreadGap>();

	for (const item of items) {
		const depth = Number(item?.depth);
		const uri = typeof item?.uri === 'string' ? item.uri : '';
		if (!Number.isFinite(depth) || !uri) {
			continue;
		}

		while (stack.length > 0 && stack[stack.length - 1].depth >= depth) {
			stack.pop();
		}

		const parentNode = stack[stack.length - 1]?.node ?? null;
		const value = item?.value;
		const rawPost = value?.post;

		let node: ThreadPost;
		if (rawPost && typeof rawPost?.uri === 'string') {
			const parsedPost = parsePostView(rawPost);
			const existingNode = nodesByUri.get(parsedPost.uri);
			if (existingNode) {
				const preservedChildren = existingNode.children;
				const preservedParentUri = existingNode.parentUri;
				const preservedCreatedAt = existingNode.createdAt;
				Object.assign(existingNode, parsedPost);
				existingNode.children = preservedChildren;
				if (!existingNode.parentUri) {
					existingNode.parentUri = preservedParentUri;
				}
				if (!existingNode.createdAt) {
					existingNode.createdAt = preservedCreatedAt;
				}
				node = existingNode;
			} else {
				node = parsedPost;
				nodesByUri.set(node.uri, node);
			}
		} else {
			const authorDid =
				typeof value?.author?.did === 'string' && value.author.did.length > 0
					? value.author.did
					: null;
			const existingNode = nodesByUri.get(uri);
			if (existingNode) {
				if (!existingNode.parentUri && parentNode) {
					existingNode.parentUri = parentNode.uri;
				}
				if (!existingNode.createdAt && parentNode?.createdAt) {
					existingNode.createdAt = parentNode.createdAt;
				}
				node = existingNode;
			} else {
				node = buildBlockedGapNode({
					uri,
					authorDid,
					parentUri: parentNode?.uri ?? null,
					createdAt: parentNode?.createdAt ?? ''
				});
				nodesByUri.set(uri, node);
			}

			if (!hiddenGapMap.has(uri)) {
				hiddenGapMap.set(uri, { uri, authorDid });
			}
		}

		attachThreadChild(parentNode, node, roots);
		stack.push({ depth, node });
	}

	return {
		rootPost: roots[0] ?? null,
		hiddenGaps: [...hiddenGapMap.values()]
	};
}

export function buildHydratableThreadFromFlatItems(items: any[]): ThreadPost | null {
	return parseHydratableThreadFromFlatItems(items).rootPost;
}

export function buildVisibleThreadFromFlatItems(items: any[]): ThreadPost | null {
	return parseVisibleThreadFromFlatItems(items).rootPost;
}

function parseThread(node: any): ThreadPost {
	const threadPost = parsePostView(node.post);
	return {
		...threadPost,
		children: (node.replies || [])
			.filter((r: any) => r.$type === 'app.bsky.feed.defs#threadViewPost')
			.map((r: any) => parseThread(r))
	};
}

export async function fetchQuotesForPost(
	uri: string,
	options: { limit?: number; fetchAll?: boolean } = {}
): Promise<{ posts: ThreadPost[]; hasMore: boolean }> {
	const { limit = 12, fetchAll = false } = options;
	const getQuotes =
		typeof (agent as any).getQuotes === 'function'
			? (params: { uri: string; limit?: number; cursor?: string }) => (agent as any).getQuotes(params)
			: typeof (agent as any).app?.bsky?.feed?.getQuotes === 'function'
				? (params: { uri: string; limit?: number; cursor?: string }) =>
						(agent as any).app.bsky.feed.getQuotes(params)
				: null;
	if (!getQuotes) {
		throw new Error('Quote lookup is unavailable in this Bluesky client build.');
	}

	const pageSize = fetchAll ? Math.max(25, Math.min(limit, 100)) : limit;
	const posts: ThreadPost[] = [];
	const seenUris = new Set<string>();
	let cursor: string | undefined;

	do {
		const response = await getQuotes({ uri, limit: pageSize, cursor });
		for (const post of response.data.posts || []) {
			const parsed = parsePostView(post);
			if (seenUris.has(parsed.uri)) continue;
			seenUris.add(parsed.uri);
			posts.push(parsed);
		}
		cursor = response.data.cursor;
		if (!fetchAll) {
			break;
		}
	} while (cursor);

	return {
		posts,
		hasMore: Boolean(cursor)
	};
}

/**
 * Filters a thread tree to only include posts by the given author.
 * If the root is by another author, walks down to find the author's first post.
 */
function filterToAuthor(post: ThreadPost, authorDid: string): ThreadPost | null {
	if (post.author.did === authorDid) {
		const filtered: ThreadPost = { ...post, children: [] };
		for (const child of post.children) {
			const kept = filterToAuthor(child, authorDid);
			if (kept) filtered.children.push(kept);
		}
		return filtered;
	}
	// Not by our author — look for their posts in children
	for (const child of post.children) {
		const result = filterToAuthor(child, authorDid);
		if (result) return result;
	}
	return null;
}

/**
 * Fetch a thread by root URI and extract only the self-reply chain for a given author.
 */
export async function fetchSelfReplyChain(
	rootUri: string,
	authorDid: string
): Promise<{ rootPost: ThreadPost; depth: number; rootUri: string } | null> {
	try {
		const raw = await fetchPostThread(rootUri);
		const tree = parseThread(raw);
		const filtered = filterToAuthor(tree, authorDid);
		if (!filtered || filtered.children.length === 0) return null;
		return {
			rootPost: filtered,
			depth: computeDepth(filtered),
			rootUri: filtered.uri
		};
	} catch {
		return null;
	}
}

async function discoverVisibleRootUriViaFlatThread(
	uri: string,
	apiAgent: ThreadApiAgent = agent
): Promise<string | null> {
	const getPostThreadV2 = (apiAgent as any).app?.bsky?.unspecced?.getPostThreadV2;
	if (typeof getPostThreadV2 !== 'function') {
		return null;
	}

	try {
		const res = await getPostThreadV2({
			anchor: uri,
			above: true,
			below: 0,
			branchingFactor: 0,
			sort: 'oldest'
		});
		return buildVisibleThreadFromFlatItems(res.data.thread ?? [])?.uri ?? null;
	} catch {
		return null;
	}
}

function backlinkRecordToUri(record: any): string | null {
	const did = typeof record?.did === 'string' ? record.did.trim() : '';
	const collection = typeof record?.collection === 'string' ? record.collection.trim() : '';
	const rkey = typeof record?.rkey === 'string' ? record.rkey.trim() : '';
	if (!did || !collection || !rkey) {
		return null;
	}
	if (collection !== 'app.bsky.feed.post') {
		return null;
	}
	return `at://${did}/${collection}/${rkey}`;
}

async function fetchBacklinkedPostUris(
	subjectUri: string
): Promise<{ uris: string[]; total: number }> {
	const uris: string[] = [];
	const seenUris = new Set<string>();
	let total = 0;
	let cursor: string | null = null;

	for (let page = 0; page < MAX_CONSTELLATION_PAGES; page += 1) {
		const params = new URLSearchParams({
			subject: subjectUri,
			source: CONSTELLATION_REPLY_PARENT_SOURCE,
			limit: String(CONSTELLATION_PAGE_LIMIT)
		});
		if (cursor) {
			params.set('cursor', cursor);
		}

		const res = await fetch(`${CONSTELLATION_HOST}/xrpc/blue.microcosm.links.getBacklinks?${params.toString()}`, {
			headers: {
				Accept: 'application/json'
			}
		});
		if (!res.ok) {
			throw new Error(`Constellation backlinks lookup failed (${res.status})`);
		}

		const payload = await res.json().catch(() => null);
		const records = Array.isArray((payload as any)?.records) ? (payload as any).records : [];
		const pageTotal = Number((payload as any)?.total);
		if (Number.isFinite(pageTotal) && pageTotal >= 0) {
			total = Math.max(total, Math.round(pageTotal));
		}
		for (const record of records) {
			const uri = backlinkRecordToUri(record);
			if (!uri || seenUris.has(uri)) continue;
			seenUris.add(uri);
			uris.push(uri);
		}

		const nextCursor = typeof (payload as any)?.cursor === 'string' && (payload as any).cursor.length > 0
			? (payload as any).cursor
			: null;
		if (!nextCursor) {
			break;
		}
		cursor = nextCursor;
	}

	return {
		uris,
		total: Math.max(total, uris.length)
	};
}

function mergeThreadPostIntoExisting(target: ThreadPost, source: ThreadPost): number {
	if (target === source) {
		return 0;
	}
	const existingChildren = target.children;
	const existingParentUri = target.parentUri;
	const replyCount = Math.max(target.replyCount, source.replyCount, existingChildren.length);
	Object.assign(target, source);
	target.children = existingChildren;
	target.parentUri = existingParentUri || source.parentUri;
	target.replyCount = replyCount;

	return mergeDirectReplies(target, source.children);
}

function mergeDirectReplies(target: ThreadPost, replies: ThreadPost[]): number {
	let changed = 0;
	for (const reply of replies) {
		const existingChild = target.children.find((child) => child.uri === reply.uri);
		if (existingChild) {
			if (existingChild === reply) continue;
			changed += mergeThreadPostIntoExisting(existingChild, reply);
			continue;
		}
		target.children.push(reply);
		changed += 1;
	}
	if (changed > 0) {
		target.children.sort(compareThreadPostsChronologically);
	}
	return changed;
}

export function hasMissingDirectReplies(post: Pick<ThreadPost, 'replyCount' | 'children'>): boolean {
	return post.replyCount > post.children.length;
}

async function recoverMissingDirectReplies(
	node: ThreadPost,
	apiAgent: ThreadApiAgent = agent
): Promise<boolean> {
	if (!hasMissingDirectReplies(node)) {
		return false;
	}

	let backlinkedUris: string[] = [];
	try {
		backlinkedUris = (await fetchBacklinkedPostUris(node.uri)).uris;
	} catch {
		return false;
	}
	if (backlinkedUris.length === 0) {
		return false;
	}

	const fetchedPosts = await fetchPostsByUris(backlinkedUris, { agent: apiAgent });
	const directReplies = [...fetchedPosts.values()]
		.filter((post) => post.parentUri === node.uri)
		.sort(compareThreadPostsChronologically);
	if (directReplies.length === 0) {
		return false;
	}

	return mergeDirectReplies(node, directReplies) > 0;
}

async function recoverHiddenGapChildren(
	rootPost: ThreadPost,
	hiddenGaps: HiddenThreadGap[],
	apiAgent: ThreadApiAgent = agent
): Promise<ThreadPost> {
	if (hiddenGaps.length === 0) {
		return rootPost;
	}

	const uniqueGaps = new Map<string, HiddenThreadGap>();
	for (const gap of hiddenGaps) {
		if (!gap.uri || uniqueGaps.has(gap.uri)) continue;
		uniqueGaps.set(gap.uri, gap);
	}

	for (const gap of uniqueGaps.values()) {
		let backlinkResult: { uris: string[]; total: number } | null = null;
		try {
			backlinkResult = await fetchBacklinkedPostUris(gap.uri);
		} catch {
			continue;
		}
		const backlinkedUris = backlinkResult.uris;
		const nodesByUri = indexThreadByUri(rootPost);
		const gapNode = nodesByUri.get(gap.uri) ?? null;
		if (!gapNode) continue;
		gapNode.replyCount = Math.max(gapNode.replyCount, backlinkResult.total, gapNode.children.length);
		if (backlinkedUris.length === 0) continue;

		const fetchedPosts = await fetchPostsByUris(backlinkedUris, { agent: apiAgent });
		const replies = [...fetchedPosts.values()]
			.filter((post) => post.parentUri === gap.uri)
			.map((post) => nodesByUri.get(post.uri) ?? post)
			.sort(compareThreadPostsChronologically);
		if (replies.length === 0) continue;
		mergeDirectReplies(gapNode, replies);
		if (!gapNode.createdAt && replies[0]?.createdAt) {
			gapNode.createdAt = replies[0].createdAt;
		}
	}

	return rootPost;
}

async function fetchThreadViaFlatThreadApi(
	anchorUri: string,
	options: {
		above: boolean;
	},
	apiAgent: ThreadApiAgent = agent
): Promise<{ rootPost: ThreadPost; hasOtherReplies: boolean } | null> {
	const getPostThreadV2 = (apiAgent as any).app?.bsky?.unspecced?.getPostThreadV2;
	if (typeof getPostThreadV2 !== 'function') {
		return null;
	}

	try {
		const res = await getPostThreadV2({
			anchor: anchorUri,
			above: options.above,
			below: FULL_THREAD_FLAT_DEPTH,
			branchingFactor: 100,
			sort: 'oldest'
		});
		const parsed = parseHydratableThreadFromFlatItems(res.data.thread ?? []);
		if (!parsed.rootPost) {
			return null;
		}

		const recoveredRoot = await recoverHiddenGapChildren(parsed.rootPost, parsed.hiddenGaps, apiAgent);

		return {
			rootPost: recoveredRoot,
			hasOtherReplies: Boolean(res.data.hasOtherReplies)
		};
	} catch {
		return null;
	}
}

async function fetchFullThreadViaFlatThreadApi(
	rootUri: string,
	apiAgent: ThreadApiAgent = agent
): Promise<{ rootPost: ThreadPost; hasOtherReplies: boolean } | null> {
	return fetchThreadViaFlatThreadApi(rootUri, { above: true }, apiAgent);
}

interface HydrationResult {
	changed: boolean;
	sawOtherReplies: boolean;
}

async function hydrateNodeChildren(
	node: ThreadPost,
	apiAgent: ThreadApiAgent = agent
): Promise<HydrationResult> {
	let changed = false;
	let sawOtherReplies = false;

	const flatThread = await fetchThreadViaFlatThreadApi(node.uri, { above: false }, apiAgent);
	if (flatThread && flatThread.rootPost.uri === node.uri) {
		node.replyCount = Math.max(node.replyCount, flatThread.rootPost.replyCount);
		changed = mergeDirectReplies(node, flatThread.rootPost.children) > 0;
		sawOtherReplies = flatThread.hasOtherReplies;
	} else {
		const raw = await fetchPostThread(node.uri, apiAgent);
		const parsed = parseThread(raw);
		node.replyCount = Math.max(node.replyCount, parsed.replyCount);
		changed = mergeDirectReplies(node, parsed.children) > 0;
	}

	const recoveredMissingReplies = await recoverMissingDirectReplies(node, apiAgent);
	return {
		changed: changed || recoveredMissingReplies,
		sawOtherReplies
	};
}

function computeDepth(post: ThreadPost): number {
	if (post.children.length === 0) return 1;
	return 1 + Math.max(...post.children.map(computeDepth));
}

function detectTruncation(post: ThreadPost): boolean {
	if (hasMissingDirectReplies(post)) return true;
	return post.children.some(detectTruncation);
}

// Find all nodes whose direct reply count suggests more replies should exist.
function findHydrationCandidates(post: ThreadPost): ThreadPost[] {
	const result: ThreadPost[] = [];
	if (hasMissingDirectReplies(post)) {
		result.push(post);
	}
	for (const child of post.children) {
		result.push(...findHydrationCandidates(child));
	}
	return result;
}

// Recursively fetch and attach missing replies
async function hydrateThread(
	root: ThreadPost,
	maxRounds = 30,
	apiAgent: ThreadApiAgent = agent
): Promise<boolean> {
	let encounteredExtraReplies = false;
	const exhaustedUris = new Set<string>();

	for (let round = 0; round < maxRounds; round++) {
		const candidates = findHydrationCandidates(root).filter((node) => !exhaustedUris.has(node.uri));
		if (candidates.length === 0) break;

		// Fetch all truncated nodes in parallel (batch of 10 at a time to avoid rate limits)
		const batchSize = 10;
		for (let i = 0; i < candidates.length; i += batchSize) {
			const batch = candidates.slice(i, i + batchSize);
			const results = await Promise.allSettled(
				batch.map(async (node) => ({
					node,
					result: await hydrateNodeChildren(node, apiAgent)
				}))
			);
			for (const [resultIndex, result] of results.entries()) {
				if (result.status === 'fulfilled') {
					if (result.value.result.changed || result.value.result.sawOtherReplies) {
						encounteredExtraReplies = true;
					}
					if (!result.value.result.changed) {
						exhaustedUris.add(result.value.node.uri);
					}
				} else {
					const failedNode = batch[resultIndex];
					if (failedNode) {
						exhaustedUris.add(failedNode.uri);
					}
				}
			}
			// Ignore individual failures — they'll show as truncated.
		}
	}

	return encounteredExtraReplies;
}

/**
 * Batch-fetch post views from the Bluesky API and return a map of URI -> parsed embed.
 * Uses app.bsky.feed.getPosts (max 25 URIs per call).
 */
export async function hydratePostEmbeds(uris: string[]): Promise<Map<string, ThreadPost['embed']>> {
	const result = new Map<string, ThreadPost['embed']>();
	if (uris.length === 0) return result;

	const unique = [...new Set(uris)];
	const BATCH_SIZE = 25;

	for (let i = 0; i < unique.length; i += BATCH_SIZE) {
		const batch = unique.slice(i, i + BATCH_SIZE);
		try {
			const res = await agent.getPosts({ uris: batch });
			for (const post of res.data.posts ?? []) {
				const embed = parseEmbed(post.embed);
				if (embed) result.set(post.uri, embed);
			}
		} catch {
			// Skip failed batches
		}
	}

	return result;
}

export async function fetchPostsByUris(
	uris: string[],
	options: {
		signal?: AbortSignal;
		concurrency?: number;
		onProgress?: (progress: FetchPostsProgress) => void;
		agent?: ThreadApiAgent;
	} = {}
): Promise<Map<string, ThreadPost>> {
	const { signal, concurrency = 4, onProgress, agent: apiAgent = agent } = options;
	const result = new Map<string, ThreadPost>();
	const uniqueUris = [...new Set(uris.map((uri) => uri.trim()).filter(Boolean))];
	if (uniqueUris.length === 0) return result;

	const BATCH_SIZE = 25;
	const batches: string[][] = [];
	for (let index = 0; index < uniqueUris.length; index += BATCH_SIZE) {
		batches.push(uniqueUris.slice(index, index + BATCH_SIZE));
	}

	const total = uniqueUris.length;
	const totalBatches = batches.length;
	const workerCount = Math.min(Math.max(1, Math.floor(concurrency)), totalBatches);
	let nextBatchIndex = 0;
	let completed = 0;
	let batchesCompleted = 0;

	async function worker(): Promise<void> {
		while (true) {
			throwIfAborted(signal);
			const batchIndex = nextBatchIndex++;
			if (batchIndex >= totalBatches) return;
			const batch = batches[batchIndex];
			try {
				const res = await apiAgent.getPosts({ uris: batch });
				for (const post of res.data.posts ?? []) {
					result.set(post.uri, parsePostView(post));
				}
			} catch {
				// Skip failed batches so partially resolved pages can still render.
			}

			completed += batch.length;
			batchesCompleted += 1;
			onProgress?.({
				completed: Math.min(completed, total),
				total,
				batchesCompleted,
				totalBatches
			});
		}
	}

	await Promise.all(Array.from({ length: workerCount }, () => worker()));
	return result;
}

/**
 * Batch-fetch engagement counts for post URIs.
 * Uses app.bsky.feed.getPosts (max 25 URIs per call) with bounded concurrency.
 */
export async function fetchPostEngagementCounts(
	uris: string[],
	options: {
		signal?: AbortSignal;
		concurrency?: number;
		onProgress?: (progress: PostEngagementProgress) => void;
	} = {}
): Promise<Map<string, PostEngagementCounts>> {
	const { signal, concurrency = 4, onProgress } = options;
	const result = new Map<string, PostEngagementCounts>();
	const uniqueUris = [...new Set(uris.map((uri) => uri.trim()).filter(Boolean))];
	if (uniqueUris.length === 0) return result;

	const BATCH_SIZE = 25;
	const batches: string[][] = [];
	for (let i = 0; i < uniqueUris.length; i += BATCH_SIZE) {
		batches.push(uniqueUris.slice(i, i + BATCH_SIZE));
	}

	const total = uniqueUris.length;
	const totalBatches = batches.length;
	const workerCount = Math.min(Math.max(1, Math.floor(concurrency)), totalBatches);
	let nextBatchIndex = 0;
	let completed = 0;
	let batchesCompleted = 0;

	async function worker(): Promise<void> {
		while (true) {
			throwIfAborted(signal);
			const batchIndex = nextBatchIndex++;
			if (batchIndex >= totalBatches) return;
			const batch = batches[batchIndex];

			try {
				const res = await agent.getPosts({ uris: batch });
				for (const post of res.data.posts ?? []) {
					result.set(post.uri, {
						uri: post.uri,
						likeCount: toFiniteCount(post.likeCount),
						repostCount: toFiniteCount(post.repostCount),
						replyCount: toFiniteCount(post.replyCount),
						quoteCount: toFiniteCount(post.quoteCount),
						indexedAt: typeof post.indexedAt === 'string' ? post.indexedAt : ''
					});
				}
			} catch {
				// Skip failed batches so partial summaries can still render.
			}

			completed += batch.length;
			batchesCompleted += 1;
			onProgress?.({
				completed: Math.min(completed, total),
				total,
				batchesCompleted,
				totalBatches
			});
		}
	}

	await Promise.all(Array.from({ length: workerCount }, () => worker()));
	return result;
}

export async function getFullThread(
	uri: string,
	options: { agent?: ThreadApiAgent } = {}
): Promise<{ rootPost: ThreadPost; depth: number; rootUri: string; isTruncated: boolean }> {
	const apiAgent = options.agent ?? agent;
	let rootUri = uri;

	try {
		// First fetch with parentHeight to find the true root of the conversation
		const res = await apiAgent.getPostThread({
			uri,
			depth: 0,
			parentHeight: 1000
		});

		// Walk up the parent chain to find the root post URI
		let node = res.data.thread as any;
		while (node.parent && node.parent.$type === 'app.bsky.feed.defs#threadViewPost') {
			node = node.parent;
		}
		rootUri = node.post.uri;
	} catch {
		// Fallback to original URI if root discovery fails
	}

	const flatRootUri = await discoverVisibleRootUriViaFlatThread(uri, apiAgent);
	if (flatRootUri) {
		rootUri = flatRootUri;
	}

	const flatThread = await fetchFullThreadViaFlatThreadApi(rootUri, apiAgent);
	if (flatThread) {
		const encounteredExtraReplies = await hydrateThread(flatThread.rootPost, 30, apiAgent);
		const isTruncated =
			flatThread.hasOtherReplies || encounteredExtraReplies || detectTruncation(flatThread.rootPost);
		return {
			rootPost: flatThread.rootPost,
			depth: computeDepth(flatThread.rootPost),
			rootUri: flatThread.rootPost.uri,
			isTruncated
		};
	}

	// Now fetch the full thread from the root with full depth
	const rootRaw = await fetchPostThread(rootUri, apiAgent);
	const rootPost = parseThread(rootRaw);

	// Recursively hydrate truncated branches
	const encounteredExtraReplies = await hydrateThread(rootPost, 30, apiAgent);

	const isTruncated = encounteredExtraReplies || detectTruncation(rootPost);
	return {
		rootPost,
		depth: computeDepth(rootPost),
		rootUri,
		isTruncated
	};
}
