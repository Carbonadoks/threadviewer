<script module lang="ts">
	import type { ThreadPost as CachedThreadPost } from '$lib/types';

	type CachedGalleryEmbed = NonNullable<CachedThreadPost['embed']>;

	const galleryHydratedEmbedCache: Record<string, CachedGalleryEmbed> = {};
	const galleryRequestedEmbedUris = new Set<string>();
	const galleryResolvedEmbedUris = new Set<string>();
	const galleryEmbedRetryAfterByUri: Record<string, number> = {};
	type MediaPreloadPriority = 'high' | 'low';
	type MediaPreloadQueueItem = {
		url: string;
		priority: MediaPreloadPriority;
	};

	const galleryPreloadedMediaUrls = new Set<string>();
	const galleryPreloadingMediaUrls = new Set<string>();
	const galleryQueuedMediaPreloadUrls = new Map<string, MediaPreloadPriority>();
	const galleryMediaPreloadQueue: MediaPreloadQueueItem[] = [];
	const galleryActiveMediaPreloadImages = new Map<string, HTMLImageElement>();
	let galleryActiveMediaPreloads = 0;
</script>

<script lang="ts">
	import { browser } from '$app/environment';
	import { onDestroy } from 'svelte';
	import { hydratePostEmbedsDetailed } from '$lib/api/bluesky';
	import type { SelfReplyThread, ThreadPost } from '$lib/types';
	import { openLightbox } from '$lib/stores/lightbox';
	import { flattenThread, type FlatPost } from '$lib/utils/threadFlattener';
	import {
		buildFuzzyTextMatcher,
		fuzzyTextMatchRanges,
		fuzzyTextMatches,
		type FuzzyTextMatcher
	} from '$lib/utils/fuzzySearch';
	import { buildBskyPostUrl } from '$lib/utils/viewerLinks';
	import LinkedPostEmbeds from '$lib/components/LinkedPostEmbeds.svelte';
	import RecordEmbed from '$lib/components/RecordEmbed.svelte';

	type HighlightRange = {
		start: number;
		end: number;
	};

	type HighlightSegment = {
		text: string;
		hit: boolean;
	};

	type SearchMode = 'fuzzy' | 'literal';
	type GalleryContentMode = 'all' | 'media' | 'images' | 'movies';
	type GalleryGroupMode = 'threads' | 'posts';
	type GalleryMediaLayout = 'grid' | 'masonry';
	type GalleryMediaFit = 'fill' | 'fit';
	type GalleryImage = NonNullable<NonNullable<ThreadPost['embed']>['images']>[number];
	type GalleryVideo = NonNullable<NonNullable<ThreadPost['embed']>['video']>;

	type GalleryMatcher =
		| {
				mode: 'none';
		  }
		| {
				mode: 'literal';
				literal: string;
		  }
		| {
				mode: 'fuzzy';
				literal: string;
				fuzzy: FuzzyTextMatcher;
		  }
		| {
				mode: 'regex';
				regex: RegExp;
		  };

	type GalleryPostItem = {
		post: ThreadPost;
		postNumber: number;
		segments: HighlightSegment[];
		matched: boolean;
		hasImages: boolean;
		hasMovies: boolean;
		hasMedia: boolean;
		pendingMedia: boolean;
	};

	type GalleryEntry =
		| {
				kind: 'thread';
				key: string;
				thread: SelfReplyThread;
		  }
		| {
				kind: 'post';
				key: string;
				thread: SelfReplyThread;
				totalPosts: number;
				post: GalleryPostItem;
		  };

	type GalleryTile = {
		key: string;
		displayMode: GalleryGroupMode;
		thread: SelfReplyThread;
		totalPosts: number;
		engagement: {
			likeCount: number;
			repostCount: number;
			quoteCount: number;
		};
		firstMatchPostUri: string | null;
		matchPostUris: string[];
		matchCount: number;
		posts: GalleryPostItem[];
	};

	type GalleryPostCacheEntry = {
		signature: string;
		item: GalleryPostItem;
	};

	type GalleryTileCacheEntry = {
		signature: string;
		tile: GalleryTile;
	};

	type PositionedGalleryTile = {
		tile: GalleryTile;
		top: number;
		left: number;
		width: number;
		height: number;
	};

	let {
		threads,
		contentMode = 'all',
		groupMode = 'threads',
		mediaLayout = 'grid',
		mediaFit = 'fill',
		gridZoom = 100,
		searchQuery = '',
		searchMode = 'fuzzy',
		highlightedThread = null,
		onexpand,
		onblog,
		onshare,
		onopenbluesky,
		scrollToRootUri = null,
		onscrolltorooturicomplete
	}: {
		threads: SelfReplyThread[];
		contentMode?: GalleryContentMode;
		groupMode?: GalleryGroupMode;
		mediaLayout?: GalleryMediaLayout;
		mediaFit?: GalleryMediaFit;
		gridZoom?: number;
		searchQuery?: string;
		searchMode?: SearchMode;
		highlightedThread?: string | null;
		onexpand?: (rootUri: string) => void;
		onblog?: (rootUri: string) => void;
		onshare?: (rootUri: string) => void;
		onopenbluesky?: (rootUri: string) => void;
		scrollToRootUri?: string | null;
		onscrolltorooturicomplete?: (rootUri: string, found: boolean) => void;
	} = $props();

	const GRID_GAP = 14;
	const MIN_CARD_HEIGHT = 360;
	const MAX_CARD_HEIGHT = 560;
	const CARD_VIEWPORT_RATIO = 0.48;
	const DEFAULT_OVERSCAN_ROWS = 2;
	const MEDIA_RENDER_OVERSCAN_ROWS = 8;
	const MEDIA_MASONRY_RENDER_OVERSCAN_VIEWPORTS = 4;
	const MEDIA_PRELOAD_AHEAD_TILES = 240;
	const MEDIA_PRELOAD_BEHIND_TILES = 40;
	const MEDIA_PRELOAD_INITIAL_TILES = 180;
	const MEDIA_PRELOAD_AHEAD_VIEWPORTS = 7;
	const MEDIA_PRELOAD_BEHIND_VIEWPORTS = 2;
	const MEDIA_THUMBNAIL_PRELOAD_CONCURRENCY = 16;
	const MEDIA_THUMBNAIL_PRELOAD_URL_LIMIT = 320;
	const MEDIA_VISIBLE_THUMBNAIL_PRELOAD_URL_LIMIT = 96;
	const POST_HYDRATION_ENABLED = true;
	const EMBED_HYDRATION_RETRY_DELAY_MS = 5000;
	const EMBED_SWEEP_CONCURRENCY = 5;
	const EMBED_SWEEP_BATCH_SIZE = 25;

	let hydratedEmbeds = $state<Record<string, NonNullable<ThreadPost['embed']>>>({
		...galleryHydratedEmbedCache
	});
	let matchCursorByRootUri = $state<Record<string, number>>({});
	const requestedEmbedUris = galleryRequestedEmbedUris;
	let gridEl: HTMLDivElement | undefined = $state();
	let viewportHeight = $state(0);
	let windowScrollY = $state(0);
	let gridPageTop = $state(0);
	let gridWidth = $state(0);
	let metricsRafId: number | null = null;
	let handledScrollTarget: string | null = $state(null);
	let embedResolutionTick = $state(0);
	let activatedVideos = $state<Set<string>>(new Set());
	let mediaAspectRatios = $state<Record<string, number>>({});
	let pendingMediaAspectRatios: Record<string, number> = {};
	let embedRetryTimerId: number | null = null;
	let mediaAspectRatioRafId: number | null = null;
	let destroyed = false;
	const flatThreadCache = new WeakMap<ThreadPost, FlatPost[]>();
	const galleryPostItemCache = new Map<string, GalleryPostCacheEntry>();
	const galleryTileCache = new Map<string, GalleryTileCacheEntry>();

	onDestroy(() => {
		destroyed = true;
		if (browser && embedRetryTimerId !== null) {
			window.clearTimeout(embedRetryTimerId);
			embedRetryTimerId = null;
		}
		if (browser && mediaAspectRatioRafId !== null) {
			window.cancelAnimationFrame(mediaAspectRatioRafId);
			mediaAspectRatioRafId = null;
		}
	});

	function scheduleEmbedHydrationRetry() {
		if (!browser || destroyed || embedRetryTimerId !== null) return;
		embedRetryTimerId = window.setTimeout(() => {
			embedRetryTimerId = null;
			if (!destroyed) embedResolutionTick += 1;
		}, EMBED_HYDRATION_RETRY_DELAY_MS);
	}

	function promoteQueuedMediaPreload(url: string) {
		const queuedPriority = galleryQueuedMediaPreloadUrls.get(url);
		if (queuedPriority !== 'low') return;
		const queuedItem = galleryMediaPreloadQueue.find((item) => item.url === url);
		if (!queuedItem) return;
		queuedItem.priority = 'high';
		galleryQueuedMediaPreloadUrls.set(url, 'high');
		galleryMediaPreloadQueue.sort((a, b) => {
			if (a.priority === b.priority) return 0;
			return a.priority === 'high' ? -1 : 1;
		});
	}

	function pumpMediaThumbnailPreloadQueue() {
		if (!browser) return;
		while (
			galleryActiveMediaPreloads < MEDIA_THUMBNAIL_PRELOAD_CONCURRENCY &&
			galleryMediaPreloadQueue.length > 0
		) {
			const item = galleryMediaPreloadQueue.shift();
			if (!item) return;
			const { url, priority } = item;
			galleryQueuedMediaPreloadUrls.delete(url);
			if (galleryPreloadedMediaUrls.has(url) || galleryPreloadingMediaUrls.has(url)) continue;

			galleryPreloadingMediaUrls.add(url);
			galleryActiveMediaPreloads += 1;

			const image = new Image();
			image.decoding = 'async';
			if ('fetchPriority' in image) {
				(image as HTMLImageElement & { fetchPriority: 'high' | 'low' | 'auto' }).fetchPriority =
					priority === 'high' ? 'high' : 'low';
			}
			galleryActiveMediaPreloadImages.set(url, image);

			const finish = () => {
				image.onload = null;
				image.onerror = null;
				galleryActiveMediaPreloadImages.delete(url);
				galleryPreloadingMediaUrls.delete(url);
				galleryPreloadedMediaUrls.add(url);
				galleryActiveMediaPreloads = Math.max(0, galleryActiveMediaPreloads - 1);
				pumpMediaThumbnailPreloadQueue();
			};

			image.onload = finish;
			image.onerror = finish;
			image.src = url;
		}
	}

	function queueMediaThumbnailPreloads(urls: string[], priority: MediaPreloadPriority) {
		if (!browser || urls.length === 0) return;
		for (const url of urls) {
			if (
				!url ||
				galleryPreloadedMediaUrls.has(url) ||
				galleryPreloadingMediaUrls.has(url)
			) {
				continue;
			}
			if (galleryQueuedMediaPreloadUrls.has(url)) {
				if (priority === 'high') promoteQueuedMediaPreload(url);
				continue;
			}

			const item: MediaPreloadQueueItem = { url, priority };
			if (priority === 'high') {
				const firstLowIndex = galleryMediaPreloadQueue.findIndex(
					(queued) => queued.priority === 'low'
				);
				if (firstLowIndex === -1) galleryMediaPreloadQueue.push(item);
				else galleryMediaPreloadQueue.splice(firstLowIndex, 0, item);
			} else {
				galleryMediaPreloadQueue.push(item);
			}
			galleryQueuedMediaPreloadUrls.set(url, priority);
		}
		pumpMediaThumbnailPreloadQueue();
	}

	let embedSweepRunning = false;

	function applyHydrationResult(
		pendingUris: string[],
		result: {
			embeds: Map<string, NonNullable<ThreadPost['embed']> | undefined>;
			resolvedUris: Set<string>;
			failedUris: Set<string>;
		}
	) {
		const { embeds, resolvedUris, failedUris } = result;
		for (const uri of pendingUris) requestedEmbedUris.delete(uri);
		for (const uri of resolvedUris) {
			galleryResolvedEmbedUris.add(uri);
			delete galleryEmbedRetryAfterByUri[uri];
		}
		for (const uri of failedUris) {
			galleryEmbedRetryAfterByUri[uri] = Date.now() + EMBED_HYDRATION_RETRY_DELAY_MS;
		}
		if (failedUris.size > 0) scheduleEmbedHydrationRetry();

		const nextEmbeds = destroyed ? null : { ...hydratedEmbeds };
		let changed = false;
		for (const [uri, embed] of embeds) {
			if (!embed) continue;
			galleryHydratedEmbedCache[uri] = embed;
			galleryResolvedEmbedUris.add(uri);
			delete galleryEmbedRetryAfterByUri[uri];
			if (!nextEmbeds || nextEmbeds[uri]) continue;
			nextEmbeds[uri] = embed;
			changed = true;
		}
		if (nextEmbeds && changed) hydratedEmbeds = nextEmbeds;
		if (!destroyed) embedResolutionTick += 1;
	}

	async function hydrateUriBatch(pendingUris: string[]) {
		try {
			const result = await hydratePostEmbedsDetailed(pendingUris);
			applyHydrationResult(pendingUris, result);
		} catch {
			for (const uri of pendingUris) {
				requestedEmbedUris.delete(uri);
				galleryEmbedRetryAfterByUri[uri] = Date.now() + EMBED_HYDRATION_RETRY_DELAY_MS;
			}
			scheduleEmbedHydrationRetry();
			if (!destroyed) embedResolutionTick += 1;
		}
	}

	function collectHydrationQueue(includeBackground: boolean): string[] {
		const visibleSet = new Set<string>();
		for (const thread of visibleThreads) collectHydratablePostUris(thread, visibleSet);

		if (!includeBackground) return [...visibleSet];

		const all = new Set<string>();
		for (const thread of threads) collectHydratablePostUris(thread, all);
		if (all.size === 0) return [...visibleSet];

		const visibleFirst: string[] = [];
		const rest: string[] = [];
		for (const uri of all) {
			if (visibleSet.has(uri)) visibleFirst.push(uri);
			else rest.push(uri);
		}
		return [...visibleFirst, ...rest];
	}

	async function pumpEmbedHydrationQueue() {
		if (embedSweepRunning || !browser || destroyed || !POST_HYDRATION_ENABLED) {
			return;
		}
		const backgroundQueue = collectHydrationQueue(mediaTileMode);
		if (backgroundQueue.length === 0) return;

		embedSweepRunning = true;
		let backgroundCursor = 0;

		const claimUri = (uri: string, batch: string[], now: number) => {
			if (
				requestedEmbedUris.has(uri) ||
				galleryHydratedEmbedCache[uri] ||
				galleryResolvedEmbedUris.has(uri) ||
				(galleryEmbedRetryAfterByUri[uri] ?? 0) > now
			) {
				return;
			}
			requestedEmbedUris.add(uri);
			batch.push(uri);
		};

		const claimBatch = (): string[] => {
			const batch: string[] = [];
			const now = Date.now();
			for (const uri of collectHydrationQueue(false)) {
				claimUri(uri, batch, now);
				if (batch.length >= EMBED_SWEEP_BATCH_SIZE) return batch;
			}
			while (backgroundCursor < backgroundQueue.length && batch.length < EMBED_SWEEP_BATCH_SIZE) {
				const uri = backgroundQueue[backgroundCursor];
				backgroundCursor += 1;
				claimUri(uri, batch, now);
			}
			return batch;
		};

		const worker = async () => {
			while (!destroyed) {
				const batch = claimBatch();
				if (batch.length === 0) return;
				await hydrateUriBatch(batch);
			}
		};

		try {
			await Promise.all(
				Array.from({ length: EMBED_SWEEP_CONCURRENCY }, () => worker())
			);
		} finally {
			embedSweepRunning = false;
		}
	}

	function parseMatcher(query: string, mode: SearchMode): GalleryMatcher {
		const trimmed = query.trim();
		if (!trimmed) return { mode: 'none' };

		if (mode === 'literal') {
			return {
				mode: 'literal',
				literal: trimmed
			};
		}

		if (!trimmed.startsWith('/')) {
			return {
				mode: 'fuzzy',
				literal: trimmed,
				fuzzy: buildFuzzyTextMatcher(trimmed)
			};
		}

		let closingSlash = -1;
		let escapeNext = false;
		for (let i = 1; i < trimmed.length; i += 1) {
			if (trimmed[i] === '\\' && !escapeNext) {
				escapeNext = true;
				continue;
			}
			if (trimmed[i] === '/' && !escapeNext) closingSlash = i;
			escapeNext = false;
		}

		if (closingSlash <= 0) {
			return {
				mode: 'fuzzy',
				literal: trimmed,
				fuzzy: buildFuzzyTextMatcher(trimmed)
			};
		}

		try {
			const pattern = trimmed.slice(1, closingSlash);
			const rawFlags = trimmed.slice(closingSlash + 1).toLowerCase();
			const flags = rawFlags.includes('i') ? rawFlags : `${rawFlags}i`;
			return { mode: 'regex', regex: new RegExp(pattern, flags) };
		} catch {
			return {
				mode: 'fuzzy',
				literal: trimmed,
				fuzzy: buildFuzzyTextMatcher(trimmed)
			};
		}
	}

	function formatDate(iso: string): string {
		const date = new Date(iso);
		return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
	}

	function formatCount(value: number): string {
		if (value < 1000) return value.toLocaleString();
		return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
	}

	function openPost(post: ThreadPost) {
		const url = buildBskyPostUrl(post.uri, post.author.handle);
		if (!url) return;
		window.open(url, '_blank', 'noopener,noreferrer');
	}

	function mediaPostMeta(item: GalleryPostItem, totalPosts: number): string {
		return `${formatDate(item.post.createdAt)} | ${formatCount(item.post.likeCount ?? 0)} likes | ${item.postNumber}/${totalPosts}`;
	}

	function mediaPostSummary(item: GalleryPostItem, fallback = 'Media post'): string {
		const text = item.post.text.trim();
		return text || fallback;
	}

	function literalRanges(text: string, literal: string): HighlightRange[] {
		const needle = literal.toLowerCase();
		if (!needle) return [];

		const haystack = text.toLowerCase();
		const ranges: HighlightRange[] = [];
		let start = haystack.indexOf(needle);
		while (start !== -1) {
			ranges.push({ start, end: start + literal.length });
			start = haystack.indexOf(needle, start + Math.max(1, literal.length));
		}
		return ranges;
	}

	function regexRanges(text: string, regex: RegExp): HighlightRange[] {
		const flags = regex.flags.includes('g') ? regex.flags : `${regex.flags}g`;
		const globalRegex = new RegExp(regex.source, flags);
		const ranges: HighlightRange[] = [];
		let match: RegExpExecArray | null;

		while ((match = globalRegex.exec(text)) !== null) {
			const value = match[0];
			if (!value) {
				globalRegex.lastIndex += 1;
				continue;
			}
			ranges.push({ start: match.index, end: match.index + value.length });
		}

		return ranges;
	}

	function highlightRanges(text: string, matcher: GalleryMatcher): HighlightRange[] {
		if (matcher.mode === 'literal') return literalRanges(text, matcher.literal);
		if (matcher.mode === 'fuzzy') {
			const ranges = literalRanges(text, matcher.literal);
			return ranges.length > 0 ? ranges : fuzzyTextMatchRanges(text, matcher.fuzzy);
		}
		if (matcher.mode === 'regex') return regexRanges(text, matcher.regex);
		return [];
	}

	function fuzzyMatches(text: string, matcher: GalleryMatcher): boolean {
		return matcher.mode === 'fuzzy' && fuzzyTextMatches(text, matcher.fuzzy);
	}

	function mergeRanges(ranges: HighlightRange[]): HighlightRange[] {
		const sorted = [...ranges]
			.filter((range) => range.end > range.start)
			.sort((a, b) => a.start - b.start || a.end - b.end);
		const merged: HighlightRange[] = [];

		for (const range of sorted) {
			const previous = merged[merged.length - 1];
			if (!previous || range.start > previous.end) {
				merged.push({ ...range });
			} else {
				previous.end = Math.max(previous.end, range.end);
			}
		}

		return merged;
	}

	function clamp(value: number, min: number, max: number): number {
		return Math.max(min, Math.min(max, value));
	}

	function buildSegments(text: string, ranges: HighlightRange[]): HighlightSegment[] {
		const merged = mergeRanges(ranges);
		if (merged.length === 0) return [{ text, hit: false }];

		const segments: HighlightSegment[] = [];
		let cursor = 0;
		for (const range of merged) {
			const start = clamp(range.start, 0, text.length);
			const end = clamp(range.end, 0, text.length);
			if (end <= cursor) continue;
			if (start > cursor) {
				segments.push({ text: text.slice(cursor, start), hit: false });
			}
			segments.push({ text: text.slice(Math.max(cursor, start), end), hit: true });
			cursor = end;
		}
		if (cursor < text.length) {
			segments.push({ text: text.slice(cursor), hit: false });
		}

		return segments.filter((segment) => segment.text.length > 0);
	}

	function getFlatThread(thread: SelfReplyThread): FlatPost[] {
		const cached = flatThreadCache.get(thread.rootPost);
		if (cached) return cached;
		const flat = flattenThread(thread.rootPost);
		flatThreadCache.set(thread.rootPost, flat);
		return flat;
	}

	function postHasGalleryImages(post: ThreadPost): boolean {
		const embed = post.embed;
		return Boolean(embed?.images?.length || embed?.record?.images?.length);
	}

	function galleryImagesForPost(post: ThreadPost): GalleryImage[] {
		const seen = new Set<string>();
		const images: GalleryImage[] = [];
		for (const image of [...(post.embed?.images ?? []), ...(post.embed?.record?.images ?? [])]) {
			const key = image.fullsize || image.thumb;
			if (key && seen.has(key)) continue;
			if (key) seen.add(key);
			images.push(image);
		}
		return images;
	}

	function galleryVideosForPost(post: ThreadPost): GalleryVideo[] {
		const seen = new Set<string>();
		const videos: GalleryVideo[] = [];
		for (const video of [post.embed?.video, post.embed?.record?.video]) {
			if (!video) continue;
			const key = video.playlist || video.cid;
			if (key && seen.has(key)) continue;
			if (key) seen.add(key);
			videos.push(video);
		}
		return videos;
	}

	function addMediaThumbnailUrlsForPost(
		post: ThreadPost,
		target: string[],
		seen: Set<string>,
		limit: number
	) {
		if (contentMode === 'media' || contentMode === 'images') {
			for (const image of galleryImagesForPost(post)) {
				const url = image.thumb || image.fullsize;
				if (!url || seen.has(url)) continue;
				seen.add(url);
				target.push(url);
				if (target.length >= limit) return;
			}
		}

		if (contentMode === 'media' || contentMode === 'movies') {
			for (const video of galleryVideosForPost(post)) {
				const url = video.thumbnail;
				if (!url || seen.has(url)) continue;
				seen.add(url);
				target.push(url);
				if (target.length >= limit) return;
			}
		}
	}

	function mediaThumbnailUrlsForTiles(tiles: GalleryTile[], limit: number): string[] {
		const urls: string[] = [];
		const seen = new Set<string>();
		for (const tile of tiles) {
			for (const item of tile.posts) {
				addMediaThumbnailUrlsForPost(item.post, urls, seen, limit);
				if (urls.length >= limit) return urls;
			}
		}
		return urls;
	}

	function isMediaTileMode(mode: GalleryContentMode): boolean {
		return mode === 'media' || mode === 'images' || mode === 'movies';
	}

	function postHasGalleryMovies(post: ThreadPost): boolean {
		const embed = post.embed;
		return Boolean(embed?.video || embed?.record?.video);
	}

	function postHasLoadedEmbed(post: ThreadPost): boolean {
		const embed = post.embed;
		return Boolean(
			embed?.images?.length ||
			embed?.video ||
			embed?.external ||
			embed?.record ||
			embed?.type
		);
	}

	function postHasPendingMedia(post: ThreadPost): boolean {
		return Boolean(
			POST_HYDRATION_ENABLED &&
			post.needsHydratedPostView &&
			!post.embed &&
			!galleryHydratedEmbedCache[post.uri] &&
			!galleryResolvedEmbedUris.has(post.uri)
		);
	}

	function buildGalleryPost(
		flatPost: FlatPost,
		postNumber: number,
		matcher: GalleryMatcher,
		embedMap: Record<string, NonNullable<ThreadPost['embed']>>
	): GalleryPostItem {
		const cachedEmbed = embedMap[flatPost.post.uri] ?? galleryHydratedEmbedCache[flatPost.post.uri];
		const displayPost = cachedEmbed
			? {
					...flatPost.post,
					embed: cachedEmbed,
					needsHydratedPostView: false
				}
			: flatPost.post;
		const text = displayPost.text || '';
		const ranges = highlightRanges(text, matcher);
		const matched = ranges.length > 0 || fuzzyMatches(text, matcher);
		const hasImages = postHasGalleryImages(displayPost);
		const hasMovies = postHasGalleryMovies(displayPost);
		const hasMedia = hasImages || hasMovies;
		const pendingMedia = !hasImages && !hasMovies && postHasPendingMedia(flatPost.post);

		return {
			post: displayPost,
			postNumber,
			segments: buildSegments(text, ranges),
			matched,
			hasImages,
			hasMovies,
			hasMedia,
			pendingMedia
		};
	}

	function matcherCacheKey(value: GalleryMatcher): string {
		if (value.mode === 'none') return 'none';
		if (value.mode === 'literal') return `literal:${value.literal}`;
		if (value.mode === 'fuzzy') return `fuzzy:${value.literal}`;
		return `regex:${value.regex.source}/${value.regex.flags}`;
	}

	function postCacheSignature(
		post: ThreadPost,
		postNumber: number,
		matcherKey: string,
		embedMap: Record<string, NonNullable<ThreadPost['embed']>>
	): string {
		const hasHydratedEmbed = Boolean(embedMap[post.uri] ?? galleryHydratedEmbedCache[post.uri]);
		const hasOwnEmbed = Boolean(post.embed);
		const resolved = galleryResolvedEmbedUris.has(post.uri);
		return [
			post.uri,
			postNumber,
			matcherKey,
			post.text,
			post.likeCount ?? 0,
			post.repostCount ?? 0,
			post.replyCount ?? 0,
			post.quoteCount ?? 0,
			post.needsHydratedPostView ? 1 : 0,
			hasOwnEmbed ? 1 : 0,
			hasHydratedEmbed ? 1 : 0,
			resolved ? 1 : 0
		].join('\u001f');
	}

	function buildGalleryPostCached(
		flatPost: FlatPost,
		postNumber: number,
		matcher: GalleryMatcher,
		matcherKey: string,
		embedMap: Record<string, NonNullable<ThreadPost['embed']>>
	): GalleryPostItem {
		const cacheKey = `${flatPost.post.uri}:${postNumber}`;
		const signature = postCacheSignature(flatPost.post, postNumber, matcherKey, embedMap);
		const cached = galleryPostItemCache.get(cacheKey);
		if (cached?.signature === signature) return cached.item;
		const item = buildGalleryPost(flatPost, postNumber, matcher, embedMap);
		galleryPostItemCache.set(cacheKey, { signature, item });
		return item;
	}

	function postMatchesContentMode(
		post: GalleryPostItem,
		mode: GalleryContentMode
	): boolean {
		if (mode === 'all') return true;
		if (post.pendingMedia) return true;
		if (mode === 'media') return post.hasMedia;
		return mode === 'images' ? post.hasImages : post.hasMovies;
	}

	function threadEngagement(thread: SelfReplyThread) {
		return {
			likeCount: thread.rootPost.likeCount ?? 0,
			repostCount: thread.rootPost.repostCount ?? 0,
			quoteCount: thread.rootPost.quoteCount ?? 0
		};
	}

	function buildThreadTile(
		thread: SelfReplyThread,
		matcher: GalleryMatcher,
		matcherKey: string,
		embedMap: Record<string, NonNullable<ThreadPost['embed']>>
	): GalleryTile {
		const flat = getFlatThread(thread);
		const allPosts = flat.map((flatPost, index) =>
			buildGalleryPostCached(flatPost, index + 1, matcher, matcherKey, embedMap)
		);
		const posts =
			contentMode !== 'all'
				? allPosts.filter((post) => postMatchesContentMode(post, contentMode))
				: allPosts;
		const matchPostUris = posts.filter((post) => post.matched).map((post) => post.post.uri);
		const firstMatchPostUri = matchPostUris[0] ?? null;

		return {
			key: thread.rootUri,
			displayMode: 'threads',
			thread,
			totalPosts: flat.length,
			engagement: threadEngagement(thread),
			firstMatchPostUri,
			matchPostUris,
			matchCount: matchPostUris.length,
			posts
		};
	}

	function buildPostTile(entry: Extract<GalleryEntry, { kind: 'post' }>): GalleryTile {
		const matchPostUris = entry.post.matched ? [entry.post.post.uri] : [];
		return {
			key: entry.key,
			displayMode: 'posts',
			thread: entry.thread,
			totalPosts: entry.totalPosts,
			engagement: threadEngagement(entry.thread),
			firstMatchPostUri: matchPostUris[0] ?? null,
			matchPostUris,
			matchCount: matchPostUris.length,
			posts: [entry.post]
		};
	}

	function buildTile(entry: GalleryEntry): GalleryTile {
		return entry.kind === 'post'
			? buildPostTile(entry)
			: buildThreadTile(entry.thread, matcher, activeMatcherCacheKey, hydratedEmbeds);
	}

	function threadTileSignature(
		thread: SelfReplyThread,
		matcherKey: string,
		embedMap: Record<string, NonNullable<ThreadPost['embed']>>
	): string {
		const flat = getFlatThread(thread);
		return [
			'thread',
			contentMode,
			matcherKey,
			thread.depth,
			thread.rootPost.likeCount ?? 0,
			thread.rootPost.repostCount ?? 0,
			thread.rootPost.quoteCount ?? 0,
			...flat.map((flatPost, index) =>
				postCacheSignature(flatPost.post, index + 1, matcherKey, embedMap)
			)
		].join('\u001e');
	}

	function postTileSignature(entry: Extract<GalleryEntry, { kind: 'post' }>): string {
		const post = entry.post.post;
		return [
			'post',
			contentMode,
			activeMatcherCacheKey,
			entry.key,
			entry.totalPosts,
			entry.post.matched ? 1 : 0,
			entry.post.pendingMedia ? 1 : 0,
			entry.post.hasImages ? 1 : 0,
			entry.post.hasMovies ? 1 : 0,
			post.likeCount ?? 0,
			post.repostCount ?? 0,
			post.quoteCount ?? 0,
			entry.thread.rootPost.likeCount ?? 0,
			entry.thread.rootPost.repostCount ?? 0,
			entry.thread.rootPost.quoteCount ?? 0
		].join('\u001f');
	}

	function buildCachedTile(entry: GalleryEntry): GalleryTile {
		const cacheKey = entry.kind === 'post' ? `post:${entry.key}` : `thread:${entry.thread.rootUri}`;
		const signature =
			entry.kind === 'post'
				? postTileSignature(entry)
				: threadTileSignature(entry.thread, activeMatcherCacheKey, hydratedEmbeds);
		const cached = galleryTileCache.get(cacheKey);
		if (cached?.signature === signature) return cached.tile;
		const tile = buildTile(entry);
		galleryTileCache.set(cacheKey, { signature, tile });
		return tile;
	}

	function tileHasVisibleContent(tile: GalleryTile): boolean {
		return contentMode === 'all' || tile.posts.length > 0;
	}

	function hashString(value: string): number {
		let hash = 2166136261;
		for (let i = 0; i < value.length; i += 1) {
			hash ^= value.charCodeAt(i);
			hash = Math.imul(hash, 16777619);
		}
		return hash >>> 0;
	}

	function mediaImageKey(image: GalleryImage, fallbackKey: string): string {
		return image.fullsize || image.thumb || image.alt || fallbackKey;
	}

	function updateMediaAspectRatio(key: string, event: Event) {
		const image = event.currentTarget as HTMLImageElement | null;
		if (!image?.naturalWidth || !image.naturalHeight) return;
		const ratio = clamp(image.naturalHeight / image.naturalWidth, 0.42, 2.8);
		if (Math.abs((mediaAspectRatios[key] ?? 0) - ratio) < 0.01) return;
		if (Math.abs((pendingMediaAspectRatios[key] ?? 0) - ratio) < 0.01) return;
		pendingMediaAspectRatios[key] = ratio;
		if (!browser) {
			flushMediaAspectRatioUpdates();
			return;
		}
		if (mediaAspectRatioRafId !== null) return;
		mediaAspectRatioRafId = requestAnimationFrame(flushMediaAspectRatioUpdates);
	}

	function flushMediaAspectRatioUpdates() {
		mediaAspectRatioRafId = null;
		const entries = Object.entries(pendingMediaAspectRatios);
		if (entries.length === 0) return;
		pendingMediaAspectRatios = {};
		const nextRatios = { ...mediaAspectRatios };
		let changed = false;
		for (const [key, ratio] of entries) {
			if (Math.abs((nextRatios[key] ?? 0) - ratio) < 0.01) continue;
			nextRatios[key] = ratio;
			changed = true;
		}
		if (changed) mediaAspectRatios = nextRatios;
	}

	function estimatedImageHeightRatio(image: GalleryImage, fallbackKey: string): number {
		const key = mediaImageKey(image, fallbackKey);
		const measuredRatio = mediaAspectRatios[key];
		if (Number.isFinite(measuredRatio) && measuredRatio > 0) return measuredRatio;
		const width = image.aspectRatio?.width ?? 0;
		const height = image.aspectRatio?.height ?? 0;
		if (width > 0 && height > 0) return clamp(height / width, 0.42, 2.8);
		const seed = hashString(key) % 1000;
		return 0.72 + (seed / 1000) * 0.86;
	}

	function estimatedVideoHeightRatio(video: GalleryVideo): number {
		const width = video.aspectRatio?.width ?? 16;
		const height = video.aspectRatio?.height ?? 9;
		if (width <= 0 || height <= 0) return 0.7;
		return clamp(height / width, 0.54, 1.65);
	}

	function aspectRatioStyleFromHeightRatio(heightRatio: number): string {
		if (mediaFit !== 'fit') return '';
		return `aspect-ratio: 1 / ${clamp(heightRatio, 0.36, 3).toFixed(4)};`;
	}

	function imageTileStyle(image: GalleryImage, fallbackKey: string): string {
		return aspectRatioStyleFromHeightRatio(estimatedImageHeightRatio(image, fallbackKey));
	}

	function videoTileStyle(video: GalleryVideo): string {
		return aspectRatioStyleFromHeightRatio(estimatedVideoHeightRatio(video));
	}

	function activateVideo(key: string) {
		if (activatedVideos.has(key)) return;
		const next = new Set(activatedVideos);
		next.add(key);
		activatedVideos = next;
	}

	function mediaHeightRatiosForPost(item: GalleryPostItem): number[] {
		const ratios: number[] = [];
		for (const [index, image] of galleryImagesForPost(item.post).entries()) {
			ratios.push(estimatedImageHeightRatio(image, `${item.post.uri}:image:${index}`));
		}
		for (const video of galleryVideosForPost(item.post)) {
			ratios.push(estimatedVideoHeightRatio(video));
		}
		if (ratios.length === 0 && item.pendingMedia) ratios.push(0.96);
		return ratios;
	}

	function estimateMasonryTileHeight(tile: GalleryTile, width: number): number {
		const ratios = tile.posts.flatMap(mediaHeightRatiosForPost);
		const minimumHeight =
			mediaFit === 'fit' ? Math.round(clamp(88 * gridZoomFactor, 58, 160)) : cardMinHeight;
		if (ratios.length === 0) return minimumHeight;
		const averageRatio = ratios.reduce((total, ratio) => total + ratio, 0) / ratios.length;
		const mediaCount = ratios.length;
		if (mediaFit === 'fit') {
			// Match the rendered CSS exactly: each `.media-only-tile` is height:auto with
			// `aspect-ratio: 1 / clamp(ratio, 0.36, 3)` (see aspectRatioStyleFromHeightRatio),
			// stacked in a flex column with `gap: 6px`. Reserve precisely that height so the
			// masonry packs with no blank space below short images.
			const MEDIA_FIT_INNER_GAP = 6;
			const stackedHeight =
				ratios.reduce((total, ratio) => total + width * clamp(ratio, 0.36, 3), 0) +
				Math.max(0, mediaCount - 1) * MEDIA_FIT_INNER_GAP;
			const maximumHeight = Math.round(clamp(width * 2.85, 420, 1600));
			return Math.round(clamp(stackedHeight, minimumHeight, maximumHeight));
		}
		const heightRatio =
			mediaCount === 1
				? clamp(averageRatio * 0.92, 0.5, 2.15)
				: mediaCount === 2
					? clamp(averageRatio * 0.72, 0.58, 1.2)
					: clamp(averageRatio * 0.6 + Math.min(mediaCount, 8) * 0.08, 1.02, 1.85);
		return Math.round(clamp(width * heightRatio, minimumHeight, cardMaxHeight));
	}

	function buildMasonryLayout(
		sourceTiles: GalleryTile[],
		width: number,
		minWidth: number,
		minHeight: number
	): { tiles: PositionedGalleryTile[]; height: number; columnCount: number } {
		const availableWidth = Math.max(width, minWidth);
		const nextColumnCount = Math.max(
			1,
			Math.floor((availableWidth + GRID_GAP) / (minWidth + GRID_GAP))
		);
		const columnWidth = Math.max(
			minWidth,
			Math.floor((availableWidth - GRID_GAP * (nextColumnCount - 1)) / nextColumnCount)
		);
		const columnHeights = Array.from({ length: nextColumnCount }, () => 0);
		const positioned: PositionedGalleryTile[] = [];

		for (const tile of sourceTiles) {
			let columnIndex = 0;
			for (let index = 1; index < columnHeights.length; index += 1) {
				if (columnHeights[index] < columnHeights[columnIndex]) columnIndex = index;
			}
			const height = Math.max(minHeight, estimateMasonryTileHeight(tile, columnWidth));
			const top = columnHeights[columnIndex];
			const left = columnIndex * (columnWidth + GRID_GAP);
			positioned.push({ tile, top, left, width: columnWidth, height });
			columnHeights[columnIndex] = top + height + GRID_GAP;
		}

		return {
			tiles: positioned,
			height: Math.max(0, Math.max(...columnHeights, 0) - GRID_GAP),
			columnCount: nextColumnCount
		};
	}

	function buildPostEntries(
		sourceThreads: SelfReplyThread[],
		matcher: GalleryMatcher,
		matcherKey: string,
		embedMap: Record<string, NonNullable<ThreadPost['embed']>>
	): GalleryEntry[] {
		const entries: GalleryEntry[] = [];
		for (const thread of sourceThreads) {
			const flat = getFlatThread(thread);
			const allPosts = flat.map((flatPost, index) =>
				buildGalleryPostCached(flatPost, index + 1, matcher, matcherKey, embedMap)
			);
			const posts =
				contentMode !== 'all'
					? allPosts.filter((post) => postMatchesContentMode(post, contentMode))
					: allPosts;
			const visiblePosts = searchQuery.trim()
				? posts.filter((post) => post.matched)
				: posts;
			for (const post of visiblePosts) {
				entries.push({
					kind: 'post',
					key: `${thread.rootUri}:${post.post.uri}`,
					thread,
					totalPosts: flat.length,
					post
				});
			}
		}
		return entries;
	}

	function getMatchCursor(tile: GalleryTile): number {
		if (tile.matchCount <= 0) return 0;
		return clamp(matchCursorByRootUri[tile.thread.rootUri] ?? 0, 0, tile.matchCount - 1);
	}

	function getActiveMatchPostUri(tile: GalleryTile): string | null {
		if (!searchQuery.trim() || tile.matchCount <= 0) return null;
		return tile.matchPostUris[getMatchCursor(tile)] ?? tile.firstMatchPostUri;
	}

	function stepThreadMatch(tile: GalleryTile, direction: -1 | 1) {
		if (tile.matchCount <= 0) return;
		const current = getMatchCursor(tile);
		const next = (current + direction + tile.matchCount) % tile.matchCount;
		matchCursorByRootUri = {
			...matchCursorByRootUri,
			[tile.thread.rootUri]: next
		};
	}

	function collectHydratablePostUris(thread: SelfReplyThread, target: Set<string>) {
		const now = Date.now();
		for (const { post } of flattenThread(thread.rootPost)) {
			if (
				!post.needsHydratedPostView ||
				post.embed ||
				hydratedEmbeds[post.uri] ||
				galleryHydratedEmbedCache[post.uri] ||
				requestedEmbedUris.has(post.uri) ||
				(galleryEmbedRetryAfterByUri[post.uri] ?? 0) > now
			) {
				continue;
			}
			target.add(post.uri);
		}
	}

	function scrollToMatch(
		node: HTMLElement,
		params: { matchUri: string | null; searchQuery: string }
	) {
		let frame: number | null = null;

		const sync = (nextParams: { matchUri: string | null; searchQuery: string }) => {
			if (frame !== null) cancelAnimationFrame(frame);
			frame = requestAnimationFrame(() => {
				frame = null;
				if (!nextParams.searchQuery.trim() || !nextParams.matchUri) {
					node.scrollTop = 0;
					return;
				}

				const target = node.querySelector<HTMLElement>(
					`[data-post-uri="${CSS.escape(nextParams.matchUri)}"]`
				);
				if (!target) return;
				node.scrollTo({
					top: Math.max(0, target.offsetTop - 14),
					behavior: 'smooth'
				});
			});
		};

		sync(params);

		return {
			update(nextParams: { matchUri: string | null; searchQuery: string }) {
				sync(nextParams);
			},
			destroy() {
				if (frame !== null) cancelAnimationFrame(frame);
			}
		};
	}

	function syncGalleryMetrics() {
		if (!browser) return;
		viewportHeight = window.innerHeight;
		windowScrollY = window.scrollY || window.pageYOffset || 0;
		if (!gridEl) return;
		const rect = gridEl.getBoundingClientRect();
		gridPageTop = windowScrollY + rect.top;
		if (rect.width > 0) gridWidth = rect.width;
	}

	function scheduleGalleryMetricsSync() {
		if (!browser || metricsRafId !== null) return;
		metricsRafId = requestAnimationFrame(() => {
			metricsRafId = null;
			syncGalleryMetrics();
		});
	}

	function indexForThread(rootUri: string): number {
		return galleryEntries.findIndex((entry) => entry.thread.rootUri === rootUri);
	}

	function positionedTileForThread(rootUri: string): PositionedGalleryTile | null {
		return masonryLayout.tiles.find((item) => item.tile.thread.rootUri === rootUri) ?? null;
	}

	const matcher = $derived(parseMatcher(searchQuery, searchMode));
	const activeMatcherCacheKey = $derived(matcherCacheKey(matcher));
	const gridZoomFactor = $derived(clamp(gridZoom, 55, 160) / 100);
	const mediaTileMode = $derived(isMediaTileMode(contentMode));
	const masonryEnabled = $derived(mediaTileMode && mediaLayout === 'masonry');
	const activeOverscanRows = $derived(
		mediaTileMode ? MEDIA_RENDER_OVERSCAN_ROWS : DEFAULT_OVERSCAN_ROWS
	);
	const cardMinWidth = $derived(
		Math.round((mediaTileMode ? 220 : 260) * gridZoomFactor)
	);
	const cardMinHeight = $derived(
		Math.round(clamp((mediaTileMode ? 300 : MIN_CARD_HEIGHT) * gridZoomFactor, 150, 760))
	);
	const cardMaxHeight = $derived(
		Math.round(clamp((mediaTileMode ? 520 : MAX_CARD_HEIGHT) * gridZoomFactor, 220, 900))
	);
	const cardViewportRatio = $derived(
		clamp((mediaTileMode ? 0.42 : CARD_VIEWPORT_RATIO) * gridZoomFactor, 0.22, 0.82)
	);
	const estimatedCardHeight = $derived(
		clamp(viewportHeight * cardViewportRatio, cardMinHeight, cardMaxHeight)
	);
	const estimatedRowHeight = $derived(estimatedCardHeight + GRID_GAP);
	const columnCount = $derived(
		Math.max(1, Math.floor(((gridWidth || cardMinWidth) + GRID_GAP) / (cardMinWidth + GRID_GAP)))
	);
	const threadGalleryEntries = $derived(
		threads.map((thread) => ({
			kind: 'thread' as const,
			key: thread.rootUri,
			thread
		}))
	);
	const postGalleryEntries = $derived.by(() => {
		embedResolutionTick;
		return buildPostEntries(threads, matcher, activeMatcherCacheKey, hydratedEmbeds);
	});
	const galleryEntries = $derived.by(() => {
		if (groupMode === 'posts') {
			return postGalleryEntries;
		}
		return threadGalleryEntries;
	});
	const visibleTop = $derived(Math.max(0, windowScrollY - gridPageTop));
	const visibleBottom = $derived(Math.max(0, windowScrollY + viewportHeight - gridPageTop));
	const allMasonryTiles = $derived.by(() => {
		if (!masonryEnabled) return [];
		embedResolutionTick;
		return galleryEntries.map(buildCachedTile).filter(tileHasVisibleContent);
	});
	const masonryLayout = $derived.by(() => {
		if (!masonryEnabled) return { tiles: [], height: 0, columnCount };
		mediaAspectRatios;
		// In fit mode the card body renders at its true aspect-ratio height, so flooring at
		// cardMinHeight (~300px) would over-reserve space and create gaps. estimateMasonryTileHeight
		// already applies the small fit-mode minimum; only cover mode wants the cardMinHeight floor.
		const masonryMinHeight =
			mediaFit === 'fit' ? Math.round(clamp(88 * gridZoomFactor, 58, 160)) : cardMinHeight;
		return buildMasonryLayout(allMasonryTiles, gridWidth, cardMinWidth, masonryMinHeight);
	});
	const masonryVisibleTiles = $derived.by(() => {
		if (!masonryEnabled) return [];
		const overscan = Math.max(
			estimatedCardHeight,
			viewportHeight * MEDIA_MASONRY_RENDER_OVERSCAN_VIEWPORTS
		);
		const top = Math.max(0, visibleTop - overscan);
		const bottom = visibleBottom + overscan;
		return masonryLayout.tiles.filter(
			(item) => item.top + item.height >= top && item.top <= bottom
		);
	});
	const rowCount = $derived(Math.ceil(galleryEntries.length / columnCount));
	const maxRow = $derived(Math.max(0, rowCount - 1));
	const startRow = $derived(
		rowCount === 0
			? 0
			: Math.min(
					maxRow,
					Math.max(0, Math.floor(visibleTop / estimatedRowHeight) - activeOverscanRows)
			  )
	);
	const endRow = $derived(
		rowCount === 0
			? 0
			: Math.max(
					startRow,
					Math.min(maxRow, Math.ceil(visibleBottom / estimatedRowHeight) + activeOverscanRows)
			  )
	);
	const startIndex = $derived(Math.min(galleryEntries.length, startRow * columnCount));
	const endIndex = $derived(Math.min(galleryEntries.length, (endRow + 1) * columnCount));
	const visibleEntries = $derived(galleryEntries.slice(startIndex, endIndex));
	const visibleThreads = $derived.by(() => {
		const seen = new Set<string>();
		const visible: SelfReplyThread[] = [];
		if (masonryEnabled) {
			for (const item of masonryVisibleTiles) {
				if (seen.has(item.tile.thread.rootUri)) continue;
				seen.add(item.tile.thread.rootUri);
				visible.push(item.tile.thread);
			}
			return visible;
		}
		for (const entry of visibleEntries) {
			if (seen.has(entry.thread.rootUri)) continue;
			seen.add(entry.thread.rootUri);
			visible.push(entry.thread);
		}
		return visible;
	});
	const topSpacerHeight = $derived(startRow * estimatedRowHeight);
	const bottomSpacerHeight = $derived(Math.max(0, (rowCount - endRow - 1) * estimatedRowHeight));
	const tiles = $derived.by(() => {
		embedResolutionTick;
		return visibleEntries
			.map(buildCachedTile)
			.filter(tileHasVisibleContent);
	});
	const renderedMediaTiles = $derived.by(() => {
		if (!mediaTileMode) return [];
		return masonryEnabled ? masonryVisibleTiles.map((item) => item.tile) : tiles;
	});
	const mediaPreloadTiles = $derived.by(() => {
		if (!mediaTileMode) return [];
		embedResolutionTick;
		if (masonryEnabled) {
			const behind = viewportHeight * MEDIA_PRELOAD_BEHIND_VIEWPORTS;
			const ahead = viewportHeight * MEDIA_PRELOAD_AHEAD_VIEWPORTS;
			const top = Math.max(0, visibleTop - behind);
			const bottom = Math.max(visibleBottom + ahead, viewportHeight * MEDIA_PRELOAD_AHEAD_VIEWPORTS);
			return masonryLayout.tiles
				.filter((item) => item.top + item.height >= top && item.top <= bottom)
				.map((item) => item.tile);
		}

		const preloadStart = Math.max(0, startIndex - MEDIA_PRELOAD_BEHIND_TILES);
		const preloadEnd = Math.min(
			galleryEntries.length,
			Math.max(endIndex + MEDIA_PRELOAD_AHEAD_TILES, MEDIA_PRELOAD_INITIAL_TILES)
		);
		return galleryEntries
			.slice(preloadStart, preloadEnd)
			.map(buildCachedTile)
			.filter(tileHasVisibleContent);
	});

	$effect(() => {
		if (!browser) return;

		syncGalleryMetrics();
		const onScroll = () => scheduleGalleryMetricsSync();
		const onResize = () => scheduleGalleryMetricsSync();
		window.addEventListener('scroll', onScroll, { passive: true });
		window.addEventListener('resize', onResize, { passive: true });

		let observer: ResizeObserver | null = null;
		if (gridEl) {
			observer = new ResizeObserver(() => scheduleGalleryMetricsSync());
			observer.observe(gridEl);
		}

		return () => {
			window.removeEventListener('scroll', onScroll);
			window.removeEventListener('resize', onResize);
			observer?.disconnect();
			if (metricsRafId !== null) {
				cancelAnimationFrame(metricsRafId);
				metricsRafId = null;
			}
		};
	});

	$effect(() => {
		galleryEntries.length;
		columnCount;
		masonryLayout.height;
		scheduleGalleryMetricsSync();
	});

	$effect(() => {
		if (!scrollToRootUri) {
			handledScrollTarget = null;
		}
	});

	$effect(() => {
		const target = scrollToRootUri;
		if (!target || handledScrollTarget === target) return;

		if (!browser) {
			handledScrollTarget = target;
			onscrolltorooturicomplete?.(target, false);
			return;
		}

		let cancelled = false;
		const frame = requestAnimationFrame(() => {
			if (cancelled) return;

			syncGalleryMetrics();
			handledScrollTarget = target;

			const masonryTarget = masonryEnabled ? positionedTileForThread(target) : null;
			const index = masonryTarget ? -1 : indexForThread(target);
			if (!masonryTarget && index < 0) {
				onscrolltorooturicomplete?.(target, false);
				return;
			}

			const targetOffset = masonryTarget
				? masonryTarget.top
				: Math.floor(index / columnCount) * estimatedRowHeight;
			const targetScrollTop = Math.max(
				0,
				gridPageTop + targetOffset - Math.max(64, Math.floor(viewportHeight * 0.32))
			);
			window.scrollTo({
				top: targetScrollTop,
				behavior: 'smooth'
			});
			onscrolltorooturicomplete?.(target, true);
		});

		return () => {
			cancelled = true;
			cancelAnimationFrame(frame);
		};
	});

	// One visible-first queue handles both the immediate viewport fill and the
	// media-mode background sweep, avoiding duplicate full-list scans per tick.
	$effect(() => {
		threads;
		mediaTileMode;
		visibleThreads;
		embedResolutionTick;
		if (!POST_HYDRATION_ENABLED || !browser) return;
		void pumpEmbedHydrationQueue();
	});

	$effect(() => {
		if (!browser || !mediaTileMode) return;

		const visibleUrls = mediaThumbnailUrlsForTiles(
			renderedMediaTiles,
			MEDIA_VISIBLE_THUMBNAIL_PRELOAD_URL_LIMIT
		);
		queueMediaThumbnailPreloads(visibleUrls, 'high');

		const preloadUrls = mediaThumbnailUrlsForTiles(
			mediaPreloadTiles,
			MEDIA_THUMBNAIL_PRELOAD_URL_LIMIT
		);
		const priority = visibleTop <= viewportHeight * 0.5 ? 'high' : 'low';
		queueMediaThumbnailPreloads(preloadUrls, priority);
	});
</script>

{#snippet renderGalleryCard(tile: GalleryTile, cardStyle: string)}
	{@const activeMatchPostUri = getActiveMatchPostUri(tile)}
	<article
		class="gallery-card"
		class:post-card={tile.displayMode === 'posts'}
		class:media-card={mediaTileMode}
		class:media-fit={mediaTileMode && mediaFit === 'fit'}
		class:media-masonry={masonryEnabled}
		class:thread-highlight={highlightedThread === tile.thread.rootUri}
		data-thread-uri={tile.thread.rootUri}
		style={cardStyle}
	>
		{#if mediaTileMode}
			<div class="media-only-grid">
				{#each tile.posts as item (item.post.uri)}
					{#if item.pendingMedia}
						<div class="media-placeholder media-only-placeholder">Loading media...</div>
					{/if}
					{#if contentMode === 'media' || contentMode === 'images'}
						{#each galleryImagesForPost(item.post) as img, imageIndex (`${item.post.uri}:image:${imageIndex}:${img.fullsize || img.thumb}`)}
							{@const imageKey = mediaImageKey(img, `${item.post.uri}:image:${imageIndex}`)}
							{@const imageFallbackKey = `${item.post.uri}:image:${imageIndex}`}
							<div class="media-only-tile" style={imageTileStyle(img, imageFallbackKey)}>
								<button
									type="button"
									class="media-preview-button"
									onclick={(event) => {
										event.stopPropagation();
										openLightbox(img.fullsize, img.alt);
									}}
								>
									<img
										src={img.thumb}
										alt={img.alt}
										loading="eager"
										decoding="async"
										fetchpriority="high"
										onload={(event) => updateMediaAspectRatio(imageKey, event)}
									/>
								</button>
								<button
									type="button"
									class="media-post-overlay"
									onclick={(event) => {
										event.stopPropagation();
										openPost(item.post);
									}}
									aria-label={`Open post from ${formatDate(item.post.createdAt)}`}
								>
									<span class="media-overlay-meta">{mediaPostMeta(item, tile.totalPosts)}</span>
									<span class="media-overlay-text">{mediaPostSummary(item, img.alt || 'Image post')}</span>
									<span class="media-overlay-action">Open post</span>
								</button>
							</div>
						{/each}
					{/if}
					{#if contentMode === 'media' || contentMode === 'movies'}
						{#each galleryVideosForPost(item.post) as video, videoIndex (`${item.post.uri}:video:${videoIndex}:${video.playlist || video.cid}`)}
							{@const videoKey = `${item.post.uri}:video:${videoIndex}:${video.playlist || video.cid}`}
							<div class="media-only-tile media-only-video" style={videoTileStyle(video)}>
								{#if activatedVideos.has(videoKey)}
									<!-- svelte-ignore a11y_media_has_caption -->
									<video
										controls
										autoplay
										preload="auto"
										poster={video.thumbnail}
										style={video.aspectRatio ? `aspect-ratio: ${video.aspectRatio.width} / ${video.aspectRatio.height}` : ''}
									>
										<source src={video.playlist} type="application/x-mpegURL" />
									</video>
								{:else}
									<button
										type="button"
										class="media-video-poster"
										style={video.aspectRatio ? `aspect-ratio: ${video.aspectRatio.width} / ${video.aspectRatio.height}` : ''}
										onclick={(event) => {
											event.stopPropagation();
											activateVideo(videoKey);
										}}
										aria-label={`Play video${video.alt ? `: ${video.alt}` : ''}`}
									>
										{#if video.thumbnail}
											<img
												src={video.thumbnail}
												alt={video.alt || ''}
												loading="eager"
												decoding="async"
												fetchpriority="high"
												onload={(event) => updateMediaAspectRatio(videoKey, event)}
											/>
										{/if}
										<span class="media-play-glyph" aria-hidden="true">▶</span>
									</button>
								{/if}
								<button
									type="button"
									class="media-post-overlay"
									onclick={(event) => {
										event.stopPropagation();
										openPost(item.post);
									}}
									aria-label={`Open post from ${formatDate(item.post.createdAt)}`}
								>
									<span class="media-overlay-meta">{mediaPostMeta(item, tile.totalPosts)}</span>
									<span class="media-overlay-text">{mediaPostSummary(item, video.alt || 'Video post')}</span>
									<span class="media-overlay-action">Open post</span>
								</button>
							</div>
						{/each}
					{/if}
				{/each}
			</div>
		{:else}
			<div class="gallery-card-header">
				<div class="thread-metrics">
					{#if tile.displayMode === 'posts'}
						<span class="depth-badge wobbly-border">Post</span>
						<span>{tile.posts[0]?.postNumber ?? 1} / {tile.totalPosts}</span>
					{:else}
						<span class="depth-badge wobbly-border">{tile.thread.depth} deep</span>
					{/if}
					{#if contentMode === 'images'}
						<span>{tile.posts.length} image post{tile.posts.length !== 1 ? 's' : ''}</span>
					{:else if contentMode === 'movies'}
						<span>{tile.posts.length} movie post{tile.posts.length !== 1 ? 's' : ''}</span>
					{:else}
						<span>{tile.totalPosts} post{tile.totalPosts !== 1 ? 's' : ''}</span>
					{/if}
					{#if searchQuery.trim() && tile.firstMatchPostUri}
						<span class="match-label">{tile.matchCount} hit{tile.matchCount !== 1 ? 's' : ''}</span>
					{/if}
					<span class="engagement-label">{formatCount(tile.engagement.likeCount)} likes</span>
					<span class="engagement-label">{formatCount(tile.engagement.repostCount)} reposts</span>
					<span class="engagement-label">{formatCount(tile.engagement.quoteCount)} quotes</span>
				</div>
				<span class="thread-date">{formatDate(tile.thread.rootPost.createdAt)}</span>
			</div>

			{#if searchQuery.trim() && tile.matchCount > 0}
				<div class="match-nav" aria-label="Thread search matches">
					<span>{getMatchCursor(tile) + 1} / {tile.matchCount}</span>
					<button
						type="button"
						class="match-nav-btn"
						disabled={tile.matchCount <= 1}
						onclick={() => stepThreadMatch(tile, -1)}
					>
						Prev
					</button>
					<button
						type="button"
						class="match-nav-btn"
						disabled={tile.matchCount <= 1}
						onclick={() => stepThreadMatch(tile, 1)}
					>
						Next
					</button>
				</div>
			{/if}

			<div
				class="thread-scroll"
				use:scrollToMatch={{ matchUri: activeMatchPostUri, searchQuery }}
			>
				{#each tile.posts as item (item.post.uri)}
					<section
						class="gallery-post"
						class:matched-post={item.matched}
						class:first-match={activeMatchPostUri === item.post.uri}
						class:current-match={activeMatchPostUri === item.post.uri}
						data-post-uri={item.post.uri}
					>
						<div class="post-meta">
							<button type="button" class="post-open" onclick={() => openPost(item.post)}>Open</button>
						</div>
						{#if item.pendingMedia}
							<div class="media-placeholder">Loading media...</div>
						{/if}
						{#if contentMode === 'all' || item.matched}
							{#if item.post.text}
								<p class="post-text">
									{#each item.segments as segment}
										<span class:search-hit={segment.hit}>{segment.text}</span>
									{/each}
								</p>
							{:else if !postHasLoadedEmbed(item.post)}
								<p class="post-text empty">
									No text in this post.
								</p>
							{/if}
						{/if}
						<div class="post-engagement">
							<span>{formatCount(item.post.likeCount ?? 0)} likes</span>
							<span>{formatCount(item.post.repostCount ?? 0)} reposts</span>
							<span>{formatCount(item.post.quoteCount ?? 0)} quotes</span>
						</div>
						{#if item.post.embed?.images}
							<div class="post-images">
								{#each item.post.embed.images as img}
									<button
										type="button"
										class="post-image"
										onclick={(event) => {
											event.stopPropagation();
											openLightbox(img.fullsize, img.alt);
										}}
									>
										<img src={img.thumb} alt={img.alt} />
									</button>
								{/each}
							</div>
						{/if}
						{#if item.post.embed?.video}
							{@const postVideoKey = `${item.post.uri}:postvideo:${item.post.embed.video.playlist || item.post.embed.video.cid}`}
							<div class="post-video">
								{#if activatedVideos.has(postVideoKey)}
									<!-- svelte-ignore a11y_media_has_caption -->
									<video
										controls
										autoplay
										preload="auto"
										poster={item.post.embed.video.thumbnail}
										style={item.post.embed.video.aspectRatio ? `aspect-ratio: ${item.post.embed.video.aspectRatio.width} / ${item.post.embed.video.aspectRatio.height}` : ''}
									>
										<source src={item.post.embed.video.playlist} type="application/x-mpegURL" />
									</video>
								{:else}
									<button
										type="button"
										class="post-video-poster"
										onclick={(event) => {
											event.stopPropagation();
											activateVideo(postVideoKey);
										}}
										aria-label={`Play video${item.post.embed.video.alt ? `: ${item.post.embed.video.alt}` : ''}`}
									>
										{#if item.post.embed.video.thumbnail}
											<img
												src={item.post.embed.video.thumbnail}
												alt={item.post.embed.video.alt || ''}
												loading="lazy"
												decoding="async"
											/>
										{/if}
										<span class="media-play-glyph" aria-hidden="true">▶</span>
									</button>
								{/if}
								{#if item.post.embed.video.alt}
									<p class="video-alt">{item.post.embed.video.alt}</p>
								{/if}
							</div>
						{/if}
						{#if item.post.embed?.external}
							<a
								href={item.post.embed.external.uri}
								target="_blank"
								rel="noopener noreferrer"
								class="external-embed"
							>
								{#if item.post.embed.external.thumb}
									<img src={item.post.embed.external.thumb} alt="" class="external-thumb" />
								{/if}
								<span class="external-copy">
									<strong>{item.post.embed.external.title}</strong>
									<span>{item.post.embed.external.description}</span>
								</span>
							</a>
						{/if}
						{#if item.post.embed?.record}
							<div>
								<RecordEmbed record={item.post.embed.record} dense />
							</div>
						{/if}
						{#if contentMode === 'all'}
							<div>
								<LinkedPostEmbeds
									text={item.post.text}
									externalUri={item.post.embed?.external?.uri}
									urls={item.post.linkedUrls ?? []}
									excludeUris={[item.post.uri, item.post.embed?.record?.uri ?? '']}
								/>
							</div>
						{/if}
					</section>
				{/each}
			</div>

			<div class="gallery-actions">
				{#if onexpand}
					<button class="gallery-action wobbly-border-light" onclick={() => onexpand?.(tile.thread.rootUri)}>Full</button>
				{/if}
				{#if onblog}
					<button class="gallery-action wobbly-border-light" onclick={() => onblog?.(tile.thread.rootUri)}>Blog</button>
				{/if}
				{#if onshare}
					<button class="gallery-action wobbly-border-light" onclick={() => onshare?.(tile.thread.rootUri)}>Share</button>
				{/if}
				{#if onopenbluesky}
					<button class="gallery-action wobbly-border-light" onclick={() => onopenbluesky?.(tile.thread.rootUri)}>Bluesky</button>
				{/if}
			</div>
			{/if}
	</article>
{/snippet}

<div
	class="gallery-virtual"
	style={`--gallery-card-min-width: ${cardMinWidth}px; --gallery-card-height: clamp(${cardMinHeight}px, ${(cardViewportRatio * 100).toFixed(0)}vh, ${cardMaxHeight}px);`}
	bind:this={gridEl}
>
	{#if masonryEnabled}
		<div class="gallery-masonry" style={`height: ${masonryLayout.height}px;`}>
			{#each masonryVisibleTiles as item (item.tile.key)}
				{@render renderGalleryCard(
					item.tile,
					`transform: translate(${item.left}px, ${item.top}px); width: ${item.width}px; height: ${item.height}px;`
				)}
			{/each}
		</div>
	{:else}
		<div class="gallery-spacer" style={`height: ${topSpacerHeight}px;`}></div>
		<div class="gallery-grid">
			{#each tiles as tile (tile.key)}
				{@render renderGalleryCard(tile, '')}
			{/each}
		</div>
		<div class="gallery-spacer" style={`height: ${bottomSpacerHeight}px;`}></div>
	{/if}
</div>

<style>
	.gallery-virtual {
		width: 100%;
	}

	.gallery-spacer {
		width: 100%;
		pointer-events: none;
	}

	.gallery-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(var(--gallery-card-min-width, 260px), 1fr));
		gap: 14px;
		align-items: stretch;
	}

	.gallery-masonry {
		position: relative;
		width: 100%;
		min-height: 1px;
	}

	.gallery-masonry .gallery-card {
		position: absolute;
		/* Bound repaints per card without promoting every (virtualized) card to its own
		   compositor layer. Blanket `will-change: transform` here exceeded Chrome's layer
		   budget over the tall scroll area, leaving offscreen tiles unpainted until a hover
		   repaint — the "hover empty space to reveal the image" bug. */
		contain: layout paint;
	}

	.gallery-card {
		display: flex;
		flex-direction: column;
		height: var(--gallery-card-height, clamp(360px, 48vh, 560px));
		min-height: 0;
		padding: 14px;
		background: var(--card-bg);
		border: 1px solid color-mix(in srgb, var(--control-border) 72%, transparent);
		border-radius: 8px;
		box-shadow: 0 2px 0 color-mix(in srgb, var(--text-ink) 18%, transparent);
	}

	.gallery-card.post-card {
		padding: 12px;
	}

	.gallery-card.media-card {
		padding: 0;
		background: transparent;
		border-color: transparent;
		box-shadow: none;
		overflow: hidden;
	}

	.gallery-card.media-fit {
		background: transparent;
	}

	.media-only-grid {
		display: grid;
		flex: 1 1 auto;
		height: 100%;
		min-height: 0;
		grid-template-columns: repeat(auto-fit, minmax(90px, 1fr));
		grid-auto-rows: minmax(0, 1fr);
		gap: 6px;
		overflow: hidden;
		border-radius: 8px;
	}

	.gallery-card.media-fit.media-masonry {
		overflow: hidden;
	}

	.gallery-card.media-fit.media-masonry .media-only-grid {
		display: flex;
		flex-direction: column;
		height: auto;
		min-height: 0;
		overflow: visible;
		border-radius: 0;
	}

	.media-only-tile {
		position: relative;
		display: block;
		width: 100%;
		height: 100%;
		min-height: 0;
		padding: 0;
		border: 0;
		border-radius: 8px;
		background: color-mix(in srgb, var(--card-bg) 82%, #000 18%);
		overflow: hidden;
		cursor: default;
	}

	.media-preview-button {
		display: block;
		width: 100%;
		height: 100%;
		padding: 0;
		border: 0;
		border-radius: inherit;
		background: transparent;
		color: inherit;
		font: inherit;
		overflow: hidden;
		cursor: pointer;
	}

	.gallery-card.media-fit .media-only-tile {
		background: transparent;
	}

	.gallery-card.media-fit.media-masonry .media-only-tile {
		flex: 0 0 auto;
		height: auto;
		min-height: 0;
		background: transparent;
	}

	.media-preview-button img,
	.media-video-poster img,
	.media-only-tile video {
		display: block;
		width: 100%;
		height: 100%;
		object-fit: cover;
	}

	.gallery-card.media-fit .media-preview-button img,
	.gallery-card.media-fit .media-video-poster img,
	.gallery-card.media-fit .media-only-tile video {
		object-fit: contain;
	}

	.media-video-poster {
		position: relative;
		display: block;
		width: 100%;
		height: 100%;
		padding: 0;
		border: 0;
		background: #111;
		cursor: pointer;
	}

	.media-play-glyph {
		position: absolute;
		top: 50%;
		left: 50%;
		z-index: 1;
		display: grid;
		width: 48px;
		height: 48px;
		transform: translate(-50%, -50%);
		place-items: center;
		border-radius: 50%;
		background: color-mix(in srgb, #111 64%, transparent);
		color: white;
		font-size: 1.1rem;
		padding-left: 3px;
		box-shadow: 0 6px 16px color-mix(in srgb, #000 40%, transparent);
		pointer-events: none;
	}

	.gallery-card.media-fit.media-masonry .media-only-tile video {
		border-radius: 8px;
	}

	.media-post-overlay {
		position: absolute;
		right: 8px;
		bottom: 8px;
		left: 8px;
		z-index: 2;
		display: flex;
		max-height: calc(100% - 16px);
		flex-direction: column;
		align-items: flex-start;
		gap: 1px;
		padding: 5px 7px;
		border: 1px solid color-mix(in srgb, white 24%, transparent);
		border-radius: 7px;
		background: color-mix(in srgb, #111 82%, transparent);
		color: white;
		font: inherit;
		text-align: left;
		box-shadow: 0 10px 22px color-mix(in srgb, #000 34%, transparent);
		opacity: 0;
		transform: translateY(6px);
		transition: opacity 140ms ease, transform 140ms ease;
		cursor: pointer;
	}

	.media-only-tile:hover .media-post-overlay,
	.media-only-tile:focus-within .media-post-overlay {
		opacity: 1;
		transform: translateY(0);
	}

	.media-only-video .media-post-overlay {
		top: 8px;
		bottom: auto;
	}

	.media-overlay-meta {
		font-size: 0.6rem;
		line-height: 1.15;
		opacity: 0.82;
	}

	.media-overlay-text {
		display: -webkit-box;
		overflow: hidden;
		max-width: 100%;
		-webkit-box-orient: vertical;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		font-size: 0.66rem;
		line-height: 1.2;
	}

	.media-overlay-action {
		margin-top: 1px;
		font-size: 0.6rem;
		font-weight: 700;
		line-height: 1.1;
	}

	@media (hover: none) {
		.media-post-overlay {
			opacity: 1;
			transform: translateY(0);
		}
	}

	.media-only-video {
		cursor: default;
	}

	.media-only-video video {
		background: #111;
	}

	.gallery-card.media-fit .media-only-video video {
		background: transparent;
	}

	.media-only-placeholder {
		display: grid;
		min-height: 120px;
		place-items: center;
		margin: 0;
	}

	.gallery-card-header {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 10px;
		margin-bottom: 10px;
	}

	.thread-metrics {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 8px;
		color: var(--muted);
		font-size: 0.82rem;
	}

	.depth-badge {
		display: inline-block;
		padding: 2px 10px;
		font-size: 0.82rem;
		background: var(--accent);
		color: white;
		border-color: var(--text-ink);
	}

	.thread-date {
		flex: 0 0 auto;
		color: var(--muted);
		font-size: 0.8rem;
		white-space: nowrap;
	}

	.thread-scroll {
		position: relative;
		flex: 1 1 auto;
		min-height: 0;
		overflow: auto;
		overscroll-behavior: contain;
		-webkit-overflow-scrolling: touch;
		padding: 2px 5px 2px 0;
		scrollbar-gutter: stable;
	}

	.gallery-post {
		margin: 0 0 14px;
		padding: 0;
		border-radius: 6px;
	}

	.gallery-post:last-child {
		margin-bottom: 0;
	}

	.post-meta {
		display: flex;
		align-items: center;
		justify-content: flex-end;
		gap: 6px;
		margin-bottom: 3px;
		color: var(--muted);
		font-size: 0.78rem;
	}

	.post-open {
		flex: 0 0 auto;
		padding: 2px 7px;
		border: 1px solid color-mix(in srgb, var(--accent) 65%, transparent);
		border-radius: 999px;
		background: color-mix(in srgb, var(--card-bg) 88%, white 12%);
		color: var(--accent);
		font-family: inherit;
		font-size: 0.72rem;
		line-height: 1.2;
		cursor: pointer;
	}

	.post-open:hover,
	.post-open:focus-visible {
		border-color: var(--accent);
		background: color-mix(in srgb, var(--accent) 10%, var(--card-bg));
	}

	.match-label {
		color: var(--accent);
		font-weight: 700;
	}

	.engagement-label {
		color: var(--muted);
	}

	.match-nav {
		display: flex;
		align-items: center;
		justify-content: flex-end;
		gap: 6px;
		margin: -2px 0 8px;
		color: var(--muted);
		font-size: 0.76rem;
	}

	.match-nav-btn {
		padding: 2px 7px;
		border: 1px solid color-mix(in srgb, var(--accent) 58%, transparent);
		border-radius: 999px;
		background: color-mix(in srgb, var(--card-bg) 90%, white 10%);
		color: var(--accent);
		font-family: inherit;
		font-size: 0.72rem;
		line-height: 1.2;
		cursor: pointer;
	}

	.match-nav-btn:hover:not(:disabled),
	.match-nav-btn:focus-visible {
		border-color: var(--accent);
		background: color-mix(in srgb, var(--accent) 10%, var(--card-bg));
	}

	.match-nav-btn:disabled {
		cursor: default;
		opacity: 0.45;
	}

	.current-match {
		padding-left: 8px;
		border-left: 3px solid var(--accent);
		background: color-mix(in srgb, var(--accent) 7%, transparent);
	}

	.post-text {
		margin: 0 0 8px;
		color: var(--text-ink);
		font-size: 0.9rem;
		line-height: 1.45;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}

	.post-text.empty {
		color: var(--muted);
		font-style: italic;
	}

	.post-engagement {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		margin: -2px 0 8px;
		color: var(--muted);
		font-size: 0.76rem;
		line-height: 1.2;
	}

	.media-placeholder {
		margin: 6px 0 8px;
		padding: 18px 10px;
		border: 1px dashed color-mix(in srgb, var(--control-border) 70%, transparent);
		border-radius: 8px;
		color: var(--muted);
		font-size: 0.82rem;
		text-align: center;
		background: color-mix(in srgb, var(--card-bg) 88%, white 12%);
	}

	.post-images {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(96px, 1fr));
		gap: 7px;
		margin: 8px 0;
	}

	.post-image {
		display: block;
		width: 100%;
		padding: 0;
		border: 1px solid color-mix(in srgb, var(--control-border) 60%, transparent);
		border-radius: 8px;
		background: none;
		overflow: hidden;
		cursor: pointer;
	}

	.post-image img {
		display: block;
		width: 100%;
		max-height: 170px;
		object-fit: cover;
	}

	.post-video {
		margin: 8px 0;
	}

	.post-video video {
		display: block;
		width: 100%;
		max-height: 220px;
		border-radius: 8px;
		background: #111;
	}

	.post-video-poster {
		position: relative;
		display: block;
		width: 100%;
		max-height: 220px;
		padding: 0;
		border: 0;
		border-radius: 8px;
		background: #111;
		overflow: hidden;
		cursor: pointer;
	}

	.post-video-poster img {
		display: block;
		width: 100%;
		max-height: 220px;
		object-fit: cover;
	}

	.video-alt {
		margin: 5px 0 0;
		color: var(--muted);
		font-size: 0.78rem;
	}

	.external-embed {
		display: flex;
		gap: 9px;
		margin: 8px 0;
		padding: 8px;
		border: 1px solid color-mix(in srgb, var(--control-border) 70%, transparent);
		border-radius: 8px;
		color: inherit;
		text-decoration: none;
		background: color-mix(in srgb, var(--card-bg) 84%, white 16%);
	}

	.external-embed:hover {
		border-color: var(--accent);
	}

	.external-thumb {
		width: 58px;
		height: 58px;
		object-fit: cover;
		border-radius: 6px;
		flex: 0 0 auto;
	}

	.external-copy {
		display: flex;
		min-width: 0;
		flex-direction: column;
		gap: 2px;
		font-size: 0.78rem;
		line-height: 1.3;
	}

	.external-copy strong,
	.external-copy span {
		overflow-wrap: anywhere;
	}

	.external-copy span {
		color: var(--muted);
	}

	.search-hit {
		background: color-mix(in srgb, var(--accent) 24%, #fff58a);
		color: var(--text-ink);
		border-radius: 3px;
		padding: 0 2px;
		box-decoration-break: clone;
		-webkit-box-decoration-break: clone;
	}

	.gallery-actions {
		display: flex;
		flex: 0 0 auto;
		flex-wrap: wrap;
		gap: 6px;
		margin-top: 14px;
	}

	.gallery-action {
		padding: 4px 9px;
		background: var(--card-bg);
		color: var(--accent);
		border-color: var(--accent);
		font-family: inherit;
		font-size: 0.78rem;
		cursor: pointer;
	}

	.gallery-action:hover {
		opacity: 0.72;
	}

	.thread-highlight {
		animation: thread-glow 3s ease-in-out forwards;
	}

	@keyframes thread-glow {
		0%, 100% { box-shadow: 0 2px 0 color-mix(in srgb, var(--text-ink) 18%, transparent); }
		20%, 80% { box-shadow: 0 0 12px 3px var(--accent); }
	}
</style>
