<script module lang="ts">
	import type { AuthorInfo as CachedAuthorInfo, SelfReplyThread as CachedSelfReplyThread } from '$lib/types';
	import type { ProfileInfo as CachedProfileInfo } from '$lib/api/bluesky';

	type CachedRenderMode = 'default' | 'gallery';
	type CachedSearchMode = 'fuzzy' | 'literal';
	type CachedGalleryContentMode = 'all' | 'media' | 'images' | 'movies';
	type CachedGalleryGroupMode = 'threads' | 'posts';
	type CachedGalleryMediaLayout = 'grid' | 'masonry';
	type CachedGalleryMediaFit = 'fill' | 'fit';
	type CachedThreadSortMode = 'depth' | 'liked' | 'reposted' | 'quoted';
	type CachedExpandedThread = CachedSelfReplyThread & { isTruncated?: boolean };
	type CachedPostEngagementCounts = {
		likeCount: number;
		repostCount: number;
		replyCount: number;
		quoteCount: number;
	};
	type CachedRepoStats = {
		totalPosts: number;
		elapsedMs: number;
		downloadedBytes: number;
		source: 'pds' | 'relay' | null;
		hydratedCount?: number;
		missingCount?: number;
	};
	type CachedThreadStats = {
		postsScanned: number;
		chainStarts: number;
		threadsWithSelfReplies: number;
	};
	type Viewer2MemoryCache = {
		cacheVersion: number;
		initialHandle: string;
		selectedProfile: CachedProfileInfo | null;
		author: CachedAuthorInfo | null;
		allThreads: CachedSelfReplyThread[];
		displayedThreads: CachedSelfReplyThread[];
		displayedSearchQuery: string;
		displayedSearchMode: CachedSearchMode;
		threshold: number;
		renderMode: CachedRenderMode;
		galleryContentMode?: CachedGalleryContentMode;
		galleryGroupMode?: CachedGalleryGroupMode;
		galleryMediaLayout?: CachedGalleryMediaLayout;
		galleryMediaFit?: CachedGalleryMediaFit;
		galleryGridZoom?: number;
		threadSortMode?: CachedThreadSortMode;
		searchQuery: string;
		searchMode: CachedSearchMode;
		dateFrom: string;
		dateTo: string;
		stats: CachedThreadStats;
		repoStats: CachedRepoStats;
		collapsedByRootUri: Record<string, boolean>;
		hasSearched: boolean;
		expandedThread: CachedExpandedThread | null;
		repoFeedItems?: any[];
		hydrationFeedItems?: any[];
		engagementDid?: string | null;
		engagementAttemptedPostUris?: string[];
		engagementCountsByUri?: Record<string, CachedPostEngagementCounts>;
		engagementTargetPostCount?: number;
	};

	const VIEWER2_MEMORY_CACHE_VERSION = 2;
	let viewer2MemoryCache: Viewer2MemoryCache | null = null;
	const expandedThreadMemoryCache = new Map<string, CachedExpandedThread>();
</script>

<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { browser } from '$app/environment';
	import '../../app.css';
	import SearchBar from '$lib/components/SearchBar.svelte';
	import SearchOptions from '$lib/components/SearchOptions.svelte';
	import ThresholdControl from '$lib/components/ThresholdControl.svelte';
	import ModePicker from '$lib/components/ModePicker.svelte';
	import VirtualThreadList from '$lib/components/VirtualThreadList.svelte';
	import LoadingSpinner from '$lib/components/LoadingSpinner.svelte';
	import ErrorBanner from '$lib/components/ErrorBanner.svelte';
	import RouteNav from '$lib/components/RouteNav.svelte';
	import type { SelfReplyThread, AuthorInfo, DiscoverProgress, ThreadPost } from '$lib/types';
	import type { ProfileInfo } from '$lib/api/bluesky';
	import { getProfile, getFullThread } from '$lib/api/bluesky';
	import {
		hydrateFeedItemsEngagement,
		loadRepoFeedItems,
		type RepoDownloadProgress
	} from '$lib/utils/repoHydration';
	import { buildThreadsFromFeed } from '$lib/utils/threadWalker';
	import { toastError, toastSuccess, toastInfo } from '$lib/utils/toasts';
	import {
		buildFuzzyTextMatcher,
		fuzzyTextMatches,
		type FuzzyTextMatcher
	} from '$lib/utils/fuzzySearch';
	import BlogArticle from '$lib/components/BlogArticle.svelte';
	import {
		collectSelfReplyChainPosts,
		findSelfReplyChainRoot,
		measureSelfReplyChainDepth
	} from '$lib/utils/threadBlog';
	import FontPicker from '$lib/components/FontPicker.svelte';
	import {
		buildAtUri,
		buildBskyPostUrl,
		buildViewerHref,
		normalizeBskyPostUrl,
		parseBskyPostUrl
	} from '$lib/utils/viewerLinks';

	const fontFamilies: Record<string, string> = {
		virgil: "'Virgil', cursive",
		caveat: "'Caveat', cursive",
		patrick: "'Patrick Hand', cursive",
		'comic-neue': "'Comic Neue', cursive",
		inter: "'Inter', sans-serif",
		system: "system-ui, -apple-system, sans-serif"
	};

	const ENGAGEMENT_HYDRATION_CHUNK_SIZE = 250;
	const POST_HYDRATION_ENABLED = true;
	const GALLERY_GRID_ZOOM_MIN = 55;
	const GALLERY_GRID_ZOOM_MAX = 160;

	type RenderMode = 'default' | 'gallery';
	type SearchMode = 'fuzzy' | 'literal';
	type GalleryContentMode = 'all' | 'media' | 'images' | 'movies';
	type GalleryGroupMode = 'threads' | 'posts';
	type GalleryMediaLayout = 'grid' | 'masonry';
	type GalleryMediaFit = 'fill' | 'fit';
	type ThreadSortMode = 'depth' | 'liked' | 'reposted' | 'quoted';
	type EngagementHydrationState = 'idle' | 'running' | 'paused' | 'done' | 'partial' | 'failed';
	type ThreadEngagementTotals = {
		likeCount: number;
		repostCount: number;
		quoteCount: number;
	};
	type ThreadStats = {
		postsScanned: number;
		chainStarts: number;
		threadsWithSelfReplies: number;
	};
	type RepoStats = {
		totalPosts: number;
		elapsedMs: number;
		downloadedBytes: number;
		source: 'pds' | 'relay' | null;
		hydratedCount: number;
		missingCount: number;
	};
	type EngagementHydrationContext = {
		sourceFeedItems: any[];
		hydrationFeedItems: any[];
		did: string;
		searchJob: number;
		total: number;
	};

	let fontKey = $state('patrick');
	let fontFamily = $derived(fontFamilies[fontKey] ?? fontFamilies.virgil);

	let renderMode = $state<RenderMode>('gallery');
	let galleryContentMode = $state<GalleryContentMode>('all');
	let galleryGroupMode = $state<GalleryGroupMode>('threads');
	let galleryMediaLayout = $state<GalleryMediaLayout>('grid');
	let galleryMediaFit = $state<GalleryMediaFit>('fill');
	let galleryGridZoom = $state(100);
	let threadSortMode = $state<ThreadSortMode>('depth');

	let allThreads: SelfReplyThread[] = $state([]);
	let author: AuthorInfo | null = $state(null);
	let threshold = $state(1);
	let loading = $state(false);
	let error: string | null = $state(null);
	let progress: DiscoverProgress = $state({ phase: '', current: 0, total: 0 });
	let hasSearched = $state(false);
	let initialHandle = $state('');
	let activeSearchJob = 0;

	let selectedProfile: ProfileInfo | null = $state(null);

	// Text search
	let searchQuery = $state('');
	let searchMode = $state<SearchMode>('fuzzy');

	// Date filters
	let dateFrom = $state('');
	let dateTo = $state('');
	let displayedThreads: SelfReplyThread[] = $state([]);
	let displayedSearchQuery = $state('');
	let displayedSearchMode = $state<SearchMode>('fuzzy');
	let isFilteringThreads = $state(false);
	let activeFilterJob = 0;
	let filterTimer: ReturnType<typeof setTimeout> | null = null;

	// Stats
	let stats = $state<ThreadStats>({ postsScanned: 0, chainStarts: 0, threadsWithSelfReplies: 0 });
	let repoStats = $state<RepoStats>({
		totalPosts: 0,
		elapsedMs: 0,
		downloadedBytes: 0,
		source: null,
		hydratedCount: 0,
		missingCount: 0
	});
	let engagementHydrationState = $state<EngagementHydrationState>('idle');
	let engagementHydrationProgress = $state({ current: 0, total: 0 });

	function formatBytes(bytes: number): string {
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
		return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	}

	function formatSpeed(bytesPerSec: number): string {
		if (bytesPerSec < 1024) return `${bytesPerSec.toFixed(0)} B/s`;
		if (bytesPerSec < 1024 * 1024) return `${(bytesPerSec / 1024).toFixed(0)} KB/s`;
		return `${(bytesPerSec / (1024 * 1024)).toFixed(1)} MB/s`;
	}

	function formatDuration(ms: number): string {
		if (ms <= 0) return '0s';
		if (ms < 1000) return `${Math.round(ms)}ms`;
		return `${(ms / 1000).toFixed(1)}s`;
	}

	function normalizeGalleryGridZoom(value: unknown): number {
		const numeric = Number(value);
		if (!Number.isFinite(numeric)) return 100;
		return Math.max(GALLERY_GRID_ZOOM_MIN, Math.min(GALLERY_GRID_ZOOM_MAX, Math.round(numeric)));
	}

	function buildRepoDownloadDetail(downloadProgress: RepoDownloadProgress): string {
		const detailParts = [
			`${formatBytes(downloadProgress.receivedBytes)}${downloadProgress.totalBytes > 0 ? ` / ${formatBytes(downloadProgress.totalBytes)}` : ''}`
		];
		if (downloadProgress.bytesPerSecond > 0) {
			detailParts.push(formatSpeed(downloadProgress.bytesPerSecond));
		}
		if (downloadProgress.elapsedMs > 0) {
			detailParts.push(`${formatDuration(downloadProgress.elapsedMs)} elapsed`);
		}
		return detailParts.join(' · ');
	}

	function buildRepoParseDetail(parsedPosts: number, downloadedBytes: number): string {
		return `${parsedPosts.toLocaleString()} posts extracted from ${formatBytes(downloadedBytes)}`;
	}

	// Abort controller
	let abortController: AbortController | null = $state(null);
	let engagementHydrationController: AbortController | null = null;
	let engagementHydrationContext: EngagementHydrationContext | null = $state(null);
	let engagementAttemptedPostUris = new Set<string>();
	let engagementHydratedCount = 0;
	let engagementCountsByUri = $state<Record<string, CachedPostEngagementCounts>>({});
	let engagementTargetPostCount = 0;
	let cachedRepoFeedItems: any[] | null = null;
	let cachedHydrationFeedItems: any[] | null = null;
	let cachedEngagementDid: string | null = null;

	// Expanded thread state
	let expandedThread: (SelfReplyThread & { isTruncated?: boolean }) | null = $state(null);
	let expandedLoading = $state(false);
	let showExpanded = $state(false);
	let savedScrollY = 0;
	let blogThread: SelfReplyThread | null = $state(null);
	let blogLoadingFullThread = $state(false);
	let activeBlogJob = 0;
	let showBlogReader = $state(false);
	const detailIsOpen = $derived(showExpanded || showBlogReader);

	// Highlight state
	let highlightedThread: string | null = $state(null);
	let pendingScrollToRootUri: string | null = $state(null);
	let collapsedByRootUri = $state<Record<string, boolean>>({});
	let activeThreadUrl: string | null = $state(null);

	type SearchMatcherMode = 'none' | 'literal' | 'fuzzy' | 'regex';

	type ThreadSearchMatcher = {
		mode: SearchMatcherMode;
		literal: string | null;
		fuzzy: FuzzyTextMatcher | null;
		regex: RegExp | null;
		helperText: string | null;
		helperTone: 'info' | 'warning' | null;
	};

	function buildSearchMatcher(query: string, mode: SearchMode): ThreadSearchMatcher {
		const trimmed = query.trim();
		if (!trimmed) {
			return { mode: 'none', literal: null, fuzzy: null, regex: null, helperText: null, helperTone: null };
		}

		if (mode === 'literal') {
			return {
				mode: 'literal',
				literal: trimmed.toLowerCase(),
				fuzzy: null,
				regex: null,
				helperText: null,
				helperTone: null
			};
		}

		if (!trimmed.startsWith('/')) {
			return {
				mode: 'fuzzy',
				literal: trimmed.toLowerCase(),
				fuzzy: buildFuzzyTextMatcher(trimmed),
				regex: null,
				helperText: null,
				helperTone: null
			};
		}

		// Try to parse as regex /pattern/flags
		let closingSlash = -1;
		let escapeNext = false;
		for (let i = 1; i < trimmed.length; i++) {
			if (trimmed[i] === '\\' && !escapeNext) { escapeNext = true; continue; }
			if (trimmed[i] === '/' && !escapeNext) closingSlash = i;
			escapeNext = false;
		}

		if (closingSlash <= 0) {
			return {
				mode: 'fuzzy',
				literal: trimmed.toLowerCase(),
				fuzzy: buildFuzzyTextMatcher(trimmed),
				regex: null,
				helperText: null,
				helperTone: 'info'
			};
		}

		try {
			const pattern = trimmed.slice(1, closingSlash);
			const rawFlags = trimmed.slice(closingSlash + 1).toLowerCase();
			const flags = rawFlags.includes('i') ? rawFlags : `${rawFlags}i`;
			const regex = new RegExp(pattern, flags);
			return { mode: 'regex', literal: null, fuzzy: null, regex, helperText: null, helperTone: null };
		} catch {
			return {
				mode: 'fuzzy',
				literal: trimmed.toLowerCase(),
				fuzzy: buildFuzzyTextMatcher(trimmed),
				regex: null,
				helperText: 'Invalid regex, using fuzzy search.',
				helperTone: 'warning'
			};
		}
	}

	function matchesSearch(
		thread: SelfReplyThread,
		matcher: ThreadSearchMatcher,
		options: { galleryContentMode?: GalleryContentMode } = {}
	): boolean {
		if (matcher.mode === 'none') return true;
		const regex = matcher.mode === 'regex' ? matcher.regex : null;
		const literal = matcher.mode === 'literal' || matcher.mode === 'fuzzy' ? matcher.literal : null;
		const fuzzy = matcher.mode === 'fuzzy' ? matcher.fuzzy : null;

		function check(post: ThreadPost): boolean {
			const canSearchPost =
				!options.galleryContentMode ||
				options.galleryContentMode === 'all' ||
				postMatchesGalleryContentCandidate(post, options.galleryContentMode);
			if (canSearchPost && regex) {
				regex.lastIndex = 0;
				if (regex.test(post.text)) return true;
			} else if (canSearchPost && literal) {
				const hasLiteralMatch = post.text.toLowerCase().includes(literal);
				if (matcher.mode === 'literal' && hasLiteralMatch) return true;
				if (hasLiteralMatch || (fuzzy && fuzzyTextMatches(post.text, fuzzy))) return true;
			}
			return post.children.some(check);
		}
		return check(thread.rootPost);
	}

	function postMatchesGalleryContentCandidate(post: ThreadPost, mode: GalleryContentMode): boolean {
		if (mode === 'all') return true;
		const embed = post.embed;
		const hasPendingMedia = POST_HYDRATION_ENABLED && post.needsHydratedPostView && !embed;
		const hasImages = Boolean(embed?.images?.length || embed?.record?.images?.length);
		const hasMovies = Boolean(embed?.video || embed?.record?.video);
		const hasMedia = hasImages || hasMovies;
		if (hasPendingMedia) return true;
		if (mode === 'media') return hasMedia;
		if (mode === 'images') {
			return hasImages;
		}
		return hasMovies;
	}

	function threadMatchesGalleryContentCandidate(thread: SelfReplyThread, mode: GalleryContentMode): boolean {
		if (mode === 'all') return true;
		const seen = new Set<string>();

		function check(post: ThreadPost): boolean {
			if (seen.has(post.uri)) return false;
			seen.add(post.uri);
			if (postMatchesGalleryContentCandidate(post, mode)) return true;
			return post.children.some(check);
		}

		return check(thread.rootPost);
	}

	const searchMatcher = $derived(buildSearchMatcher(searchQuery, searchMode));

	function isInDateRange(createdAt: string, from: string, toDate: string): boolean {
		if (!from && !toDate) return true;
		const postDate = new Date(createdAt);
		if (isNaN(postDate.getTime())) return true;
		if (from && postDate < new Date(from)) return false;
		if (toDate) {
			const to = new Date(toDate);
			to.setHours(23, 59, 59, 999);
			if (postDate > to) return false;
		}
		return true;
	}

	function rootPostEngagement(thread: SelfReplyThread): ThreadEngagementTotals {
		return {
			likeCount: thread.rootPost.likeCount ?? 0,
			repostCount: thread.rootPost.repostCount ?? 0,
			quoteCount: thread.rootPost.quoteCount ?? 0
		};
	}

	function timestamp(value: string): number {
		const parsed = Date.parse(value);
		return Number.isFinite(parsed) ? parsed : 0;
	}

	const threadEngagementByRootUri = $derived.by(() => {
		const totals = new Map<string, ThreadEngagementTotals>();
		for (const thread of allThreads) {
			totals.set(thread.rootUri, rootPostEngagement(thread));
		}
		return totals;
	});

	function compareThreadValues(a: SelfReplyThread, b: SelfReplyThread): number {
		if (threadSortMode !== 'depth') {
			const metric =
				threadSortMode === 'liked'
					? 'likeCount'
					: threadSortMode === 'reposted'
						? 'repostCount'
						: 'quoteCount';
			const aTotal = rootPostEngagement(a)[metric] ?? 0;
			const bTotal = rootPostEngagement(b)[metric] ?? 0;
			if (aTotal !== bTotal) return bTotal - aTotal;
		}

		return b.depth - a.depth || timestamp(b.rootPost.createdAt) - timestamp(a.rootPost.createdAt);
	}

	function compareThreads(a: SelfReplyThread, b: SelfReplyThread): number {
		threadEngagementByRootUri;
		return compareThreadValues(a, b);
	}

	const sortedThreads = $derived([...allThreads].sort(compareThreads));

	const maxDepth = $derived(
		allThreads.length > 0 ? Math.max(...allThreads.map((t) => t.depth)) : 2
	);

	function normalizeHandle(handle: string | null | undefined): string {
		return (handle ?? '').replace(/^@/, '').trim();
	}

	function toEngagementCount(value: unknown): number {
		const numeric = Number(value);
		return Number.isFinite(numeric) ? Math.max(0, Math.round(numeric)) : 0;
	}

	function readPostEngagementCounts(post: any): CachedPostEngagementCounts {
		return {
			likeCount: toEngagementCount(post?.likeCount),
			repostCount: toEngagementCount(post?.repostCount),
			replyCount: toEngagementCount(post?.replyCount),
			quoteCount: toEngagementCount(post?.quoteCount)
		};
	}

	function collectEngagementCountsFromFeedItems(
		feedItems: any[]
	): Record<string, CachedPostEngagementCounts> {
		const countsByUri: Record<string, CachedPostEngagementCounts> = {};
		for (const item of feedItems) {
			const uri = feedItemUri(item);
			if (!uri) continue;
			countsByUri[uri] = readPostEngagementCounts(item?.post);
		}
		return countsByUri;
	}

	function applyEngagementCountsToPost(
		post: ThreadPost,
		countsByUri: Record<string, CachedPostEngagementCounts>
	): ThreadPost {
		const counts = countsByUri[post.uri];
		let changed = false;
		const children = post.children.map((child) => {
			const nextChild = applyEngagementCountsToPost(child, countsByUri);
			if (nextChild !== child) changed = true;
			return nextChild;
		});

		if (!counts && !changed) return post;

		return {
			...post,
			likeCount: counts?.likeCount ?? post.likeCount,
			repostCount: counts?.repostCount ?? post.repostCount,
			replyCount: counts?.replyCount ?? post.replyCount,
			quoteCount: counts?.quoteCount ?? post.quoteCount,
			children: changed ? children : post.children
		};
	}

	function applyEngagementCountsToThread<T extends SelfReplyThread>(
		thread: T,
		countsByUri: Record<string, CachedPostEngagementCounts>
	): T {
		const rootPost = applyEngagementCountsToPost(thread.rootPost, countsByUri);
		return rootPost === thread.rootPost ? thread : ({ ...thread, rootPost } as T);
	}

	function applyEngagementCountsToThreadList<T extends SelfReplyThread>(
		threads: T[],
		countsByUri: Record<string, CachedPostEngagementCounts>
	): T[] {
		if (Object.keys(countsByUri).length === 0) return threads;
		return threads.map((thread) => applyEngagementCountsToThread(thread, countsByUri));
	}

	function countUniqueThreadPostUris(threads: SelfReplyThread[]): number {
		const uris = new Set<string>();
		for (const thread of threads) {
			collectThreadPostUris(thread.rootPost, uris);
		}
		return uris.size;
	}

	function memoryCacheMatchesHandle(cache: Viewer2MemoryCache, handle: string): boolean {
		const normalized = normalizeHandle(handle);
		if (!normalized) return true;
		const handles = [
			cache.initialHandle,
			cache.selectedProfile?.handle,
			cache.author?.handle
		];
		const dids = [cache.selectedProfile?.did, cache.author?.did];
		return (
			handles.some((value) => normalizeHandle(value) === normalized) ||
			dids.some((value) => value === normalized)
		);
	}

	function restoreViewer2MemoryCache(cache: Viewer2MemoryCache): boolean {
		if (cache.cacheVersion !== VIEWER2_MEMORY_CACHE_VERSION) return false;

		const cachedEngagementCounts = cache.engagementCountsByUri ?? {};
		const patchedAllThreads = applyEngagementCountsToThreadList(cache.allThreads, cachedEngagementCounts);
		const patchedDisplayedThreads = applyEngagementCountsToThreadList(
			cache.displayedThreads,
			cachedEngagementCounts
		);
		const patchedExpandedThread = cache.expandedThread
			? applyEngagementCountsToThread(cache.expandedThread, cachedEngagementCounts)
			: null;
		const restoredAttemptedUris = cache.engagementAttemptedPostUris ?? [];
		const restoredEngagementAttempts =
			restoredAttemptedUris.length ||
			(cache.repoStats.hydratedCount ?? 0) + (cache.repoStats.missingCount ?? 0);
		const restoredEngagementTarget =
			cache.engagementTargetPostCount ?? countUniqueThreadPostUris(patchedAllThreads);
		const restoredDid =
			cache.engagementDid ?? cache.selectedProfile?.did ?? cache.author?.did ?? null;

		initialHandle = cache.initialHandle;
		selectedProfile = cache.selectedProfile;
		author = cache.author;
		allThreads = patchedAllThreads;
		displayedThreads = patchedDisplayedThreads;
		displayedSearchQuery = cache.displayedSearchQuery;
		displayedSearchMode = cache.displayedSearchMode;
		threshold = cache.threshold;
		renderMode = cache.renderMode;
		galleryContentMode = cache.galleryContentMode ?? 'all';
		galleryGroupMode = cache.galleryGroupMode ?? 'threads';
		galleryMediaLayout = cache.galleryMediaLayout ?? 'grid';
		galleryMediaFit = cache.galleryMediaFit ?? 'fill';
		galleryGridZoom = normalizeGalleryGridZoom(cache.galleryGridZoom ?? 100);
		threadSortMode = cache.threadSortMode ?? 'depth';
		searchQuery = cache.searchQuery;
		searchMode = cache.searchMode;
		dateFrom = cache.dateFrom;
		dateTo = cache.dateTo;
		stats = cache.stats;
		repoStats = {
			totalPosts: cache.repoStats.totalPosts,
			elapsedMs: cache.repoStats.elapsedMs,
			downloadedBytes: cache.repoStats.downloadedBytes,
			source: cache.repoStats.source,
			hydratedCount: cache.repoStats.hydratedCount ?? 0,
			missingCount: cache.repoStats.missingCount ?? 0
		};
		collapsedByRootUri = cache.collapsedByRootUri;
		hasSearched = cache.hasSearched;
		expandedThread = patchedExpandedThread;
		loading = false;
		error = null;
		progress = { phase: '', current: 0, total: 0 };
		abortController = null;
		engagementHydrationController = null;
		engagementCountsByUri = cachedEngagementCounts;
		engagementTargetPostCount = restoredEngagementTarget;
		cachedRepoFeedItems = cache.repoFeedItems ?? null;
		cachedHydrationFeedItems = cache.hydrationFeedItems ?? null;
		cachedEngagementDid = restoredDid;
		engagementAttemptedPostUris = new Set(restoredAttemptedUris);
		engagementHydratedCount = cache.repoStats.hydratedCount ?? 0;
		engagementHydrationContext =
			cachedRepoFeedItems &&
			cachedHydrationFeedItems &&
			cachedEngagementDid &&
			restoredEngagementAttempts < restoredEngagementTarget
				? {
						sourceFeedItems: cachedRepoFeedItems,
						hydrationFeedItems: cachedHydrationFeedItems,
						did: cachedEngagementDid,
						searchJob: activeSearchJob,
						total: restoredEngagementTarget
					}
				: null;
		if (restoredEngagementTarget === 0) {
			engagementHydrationState = 'idle';
		} else if (restoredEngagementAttempts >= restoredEngagementTarget) {
			engagementHydrationState = cache.repoStats.missingCount ? 'partial' : 'done';
		} else if (engagementHydrationContext) {
			engagementHydrationState = 'paused';
		} else {
			engagementHydrationState = restoredEngagementAttempts ? 'partial' : 'idle';
		}
		engagementHydrationProgress = {
			current: restoredEngagementAttempts,
			total: restoredEngagementTarget || restoredEngagementAttempts
		};
		showExpanded = false;
		showBlogReader = false;
		expandedLoading = false;
		blogThread = null;
		blogLoadingFullThread = false;
		activeBlogJob += 1;
		activeThreadUrl = null;
		highlightedThread = null;
		pendingScrollToRootUri = null;
		if (patchedExpandedThread) {
			expandedThreadMemoryCache.set(patchedExpandedThread.rootUri, patchedExpandedThread);
		}
		return true;
	}

	function saveViewer2MemoryCache() {
		if (!hasSearched && allThreads.length === 0) return;
		viewer2MemoryCache = {
			cacheVersion: VIEWER2_MEMORY_CACHE_VERSION,
			initialHandle,
			selectedProfile,
			author,
			allThreads,
			displayedThreads,
			displayedSearchQuery,
			displayedSearchMode,
			threshold,
			renderMode,
			galleryContentMode,
			galleryGroupMode,
			galleryMediaLayout,
			galleryMediaFit,
			galleryGridZoom,
			threadSortMode,
			searchQuery,
			searchMode,
			dateFrom,
			dateTo,
			stats,
			repoStats,
			collapsedByRootUri,
			hasSearched,
			expandedThread,
			repoFeedItems: cachedRepoFeedItems ?? undefined,
			hydrationFeedItems: cachedHydrationFeedItems ?? undefined,
			engagementDid: cachedEngagementDid,
			engagementAttemptedPostUris: [...engagementAttemptedPostUris],
			engagementCountsByUri: { ...engagementCountsByUri },
			engagementTargetPostCount:
				engagementTargetPostCount || engagementHydrationProgress.total || engagementAttemptedPostUris.size
		};
		if (expandedThread) {
			expandedThreadMemoryCache.set(expandedThread.rootUri, expandedThread);
		}
	}

	function clearScheduledFilter() {
		activeFilterJob += 1;
		if (filterTimer !== null) {
			clearTimeout(filterTimer);
			filterTimer = null;
		}
	}

	function scheduleThreadFilter(
		threads: SelfReplyThread[],
		matcher: ThreadSearchMatcher,
		options: {
			threshold: number;
			dateFrom: string;
			dateTo: string;
			query: string;
			mode: SearchMode;
			galleryContentMode: GalleryContentMode;
		}
	) {
		clearScheduledFilter();

		const job = activeFilterJob;
		const result: SelfReplyThread[] = [];
		let index = 0;

		if (threads.length === 0) {
			displayedThreads = [];
			displayedSearchQuery = options.query;
			displayedSearchMode = options.mode;
			isFilteringThreads = false;
			return;
		}

		isFilteringThreads = true;

		const threadPassesFilters = (thread: SelfReplyThread) =>
			thread.depth >= options.threshold &&
			isInDateRange(thread.rootPost.createdAt, options.dateFrom, options.dateTo) &&
			threadMatchesGalleryContentCandidate(thread, options.galleryContentMode) &&
			matchesSearch(thread, matcher, { galleryContentMode: options.galleryContentMode });

		const runBatch = () => {
			if (job !== activeFilterJob) return;

			const batchStartedAt = performance.now();
			let processed = 0;
			while (index < threads.length && processed < 80 && performance.now() - batchStartedAt < 8) {
				const thread = threads[index];
				if (threadPassesFilters(thread)) {
					result.push(thread);
				}
				index += 1;
				processed += 1;
			}

			if (index < threads.length) {
				filterTimer = setTimeout(runBatch, 0);
				return;
			}

			filterTimer = null;
			displayedThreads = result;
			displayedSearchQuery = options.query;
			displayedSearchMode = options.mode;
			isFilteringThreads = false;
		};

		filterTimer = setTimeout(runBatch, 0);
	}

	function refreshDisplayedThreadsNow(threads: SelfReplyThread[]) {
		clearScheduledFilter();
		const galleryMode = renderMode === 'gallery' ? galleryContentMode : 'all';
		const matcher = buildSearchMatcher(searchQuery, searchMode);
		displayedThreads = [...threads]
			.sort(compareThreadValues)
			.filter(
				(thread) =>
					thread.depth >= threshold &&
					isInDateRange(thread.rootPost.createdAt, dateFrom, dateTo) &&
					threadMatchesGalleryContentCandidate(thread, galleryMode) &&
					matchesSearch(thread, matcher, { galleryContentMode: galleryMode })
			);
		displayedSearchQuery = searchQuery;
		displayedSearchMode = searchMode;
		isFilteringThreads = false;
	}

	$effect(() => {
		scheduleThreadFilter(sortedThreads, searchMatcher, {
			threshold,
			dateFrom,
			dateTo,
			query: searchQuery,
			mode: searchMode,
			galleryContentMode: renderMode === 'gallery' ? galleryContentMode : 'all'
		});

		return clearScheduledFilter;
	});

	$effect(() => {
		saveViewer2MemoryCache();
	});

	function updateRouteState(options: { handle?: string | null; threadUrl?: string | null } = {}) {
		if (!browser) return;
		const url = new URL(window.location.href);

		const nextThreadUrl = options.threadUrl ? normalizeBskyPostUrl(options.threadUrl) : null;
		if (nextThreadUrl) {
			url.searchParams.set('url', nextThreadUrl);
			url.searchParams.delete('handle');
		} else {
			const nextHandle = normalizeHandle(options.handle);
			url.searchParams.delete('url');
			if (nextHandle) {
				url.searchParams.set('handle', nextHandle);
			} else {
				url.searchParams.delete('handle');
			}
		}
		window.history.replaceState({}, '', url.toString());
		activeThreadUrl = nextThreadUrl;
	}

	function threadContainsUri(post: ThreadPost, uri: string): boolean {
		if (post.uri === uri) return true;
		return post.children.some((child) => threadContainsUri(child, uri));
	}

	function findThreadForUri(uri: string): SelfReplyThread | null {
		return allThreads.find((thread) => thread.rootUri === uri || threadContainsUri(thread.rootPost, uri)) ?? null;
	}

	function threadToBlueskyUrl(rootUri: string): string | null {
		const thread = allThreads.find((c) => c.rootUri === rootUri);
		if (thread) return buildBskyPostUrl(thread.rootPost.uri, thread.rootPost.author.handle);
		return buildBskyPostUrl(rootUri);
	}

	function flashHighlightedThread(rootUri: string) {
		highlightedThread = rootUri;
		pendingScrollToRootUri = rootUri;
		window.setTimeout(() => {
			if (highlightedThread === rootUri) highlightedThread = null;
		}, 3000);
	}

	function cancelFetch() {
		abortController?.abort();
		engagementHydrationController?.abort();
		engagementHydrationController = null;
		engagementHydrationContext = null;
		engagementAttemptedPostUris = new Set();
		engagementHydratedCount = 0;
		engagementCountsByUri = {};
		engagementTargetPostCount = 0;
		cachedRepoFeedItems = null;
		cachedHydrationFeedItems = null;
		cachedEngagementDid = null;
		engagementHydrationState = 'idle';
		engagementHydrationProgress = { current: 0, total: 0 };
		blogLoadingFullThread = false;
		activeBlogJob += 1;
	}

	function isThreadCollapsed(rootUri: string): boolean {
		return collapsedByRootUri[rootUri] ?? true;
	}

	function setThreadCollapsed(rootUri: string, collapsed: boolean) {
		if (isThreadCollapsed(rootUri) === collapsed) return;
		collapsedByRootUri = { ...collapsedByRootUri, [rootUri]: collapsed };
	}

	function handleScrollToRootUriComplete(rootUri: string, _found: boolean) {
		if (pendingScrollToRootUri !== rootUri) return;
		pendingScrollToRootUri = null;
	}

	async function handleProfileSelected(profile: ProfileInfo) {
		selectedProfile = profile;
		initialHandle = profile.handle;
		author = {
			did: profile.did,
			handle: profile.handle,
			displayName: profile.displayName,
			avatar: profile.avatar
		};
	}

	function applyThreadsFromFeed(
		feedItems: any[],
		did: string,
		options: { reportProgress?: boolean; announce?: boolean } = {}
	): { threads: SelfReplyThread[]; stats: ThreadStats } {
		const built = buildThreadsFromFeed(
			feedItems,
			did,
			options.reportProgress
				? (nextProgress) => {
						progress = nextProgress;
					}
				: undefined
		);
		const threads = applyEngagementCountsToThreadList(built.threads, engagementCountsByUri);
		const nextStats = {
			postsScanned: feedItems.length,
			chainStarts: threads.length,
			threadsWithSelfReplies: threads.filter((t) => t.depth >= 2).length
		};

		allThreads = threads;
		stats = nextStats;

		if (options.announce) {
			if (nextStats.threadsWithSelfReplies > 0) {
				toastSuccess(
					`Found ${nextStats.threadsWithSelfReplies} thread${nextStats.threadsWithSelfReplies !== 1 ? 's' : ''}`
				);
			} else {
				toastInfo('No self-reply threads found');
			}
		}

		return { threads, stats: nextStats };
	}

	function feedItemUri(item: any): string | null {
		const uri = item?.post?.uri;
		return typeof uri === 'string' && uri.length > 0 ? uri : null;
	}

	function countUniqueFeedItems(feedItems: any[]): number {
		return new Set(feedItems.map(feedItemUri).filter((uri): uri is string => Boolean(uri))).size;
	}

	function collectThreadPostUris(post: ThreadPost, target: Set<string>) {
		if (target.has(post.uri)) return;
		target.add(post.uri);
		for (const child of post.children) {
			collectThreadPostUris(child, target);
		}
	}

	function selectThreadFeedItems(feedItems: any[], threads: SelfReplyThread[]): any[] {
		const itemsByUri = new Map<string, any>();
		for (const item of feedItems) {
			const uri = feedItemUri(item);
			if (uri && !itemsByUri.has(uri)) {
				itemsByUri.set(uri, item);
			}
		}

		const threadUris = new Set<string>();
		for (const thread of threads) {
			collectThreadPostUris(thread.rootPost, threadUris);
		}

		const selected: any[] = [];
		const seen = new Set<string>();
		for (const uri of threadUris) {
			if (seen.has(uri)) continue;
			const item = itemsByUri.get(uri);
			if (!item) continue;
			selected.push(item);
			seen.add(uri);
		}
		return selected;
	}

	function startEngagementHydration(
		sourceFeedItems: any[],
		hydrationFeedItems: any[],
		did: string,
		searchJob: number,
		options: { reset?: boolean } = {}
	) {
		const total = countUniqueFeedItems(hydrationFeedItems);
		engagementHydrationController?.abort();
		engagementHydrationController = null;
		engagementHydrationContext = { sourceFeedItems, hydrationFeedItems, did, searchJob, total };
		cachedRepoFeedItems = sourceFeedItems;
		cachedHydrationFeedItems = hydrationFeedItems;
		cachedEngagementDid = did;
		engagementTargetPostCount = total;

		if (options.reset ?? true) {
			engagementAttemptedPostUris = new Set();
			engagementHydratedCount = 0;
			engagementCountsByUri = {};
			engagementHydrationProgress = { current: 0, total };
			repoStats = { ...repoStats, hydratedCount: 0, missingCount: 0 };
		}

		if (total === 0) {
			engagementHydrationState = 'done';
			engagementHydrationProgress = { current: 0, total: 0 };
			return;
		}

		void runEngagementHydration();
	}

	function stopEngagementHydration() {
		if (engagementHydrationState !== 'running') return;
		engagementHydrationState = 'paused';
		engagementHydrationProgress = {
			current: engagementAttemptedPostUris.size,
			total: engagementHydrationProgress.total
		};
		engagementHydrationController?.abort();
		engagementHydrationController = null;
		saveViewer2MemoryCache();
	}

	function resumeEngagementHydration() {
		if (!engagementHydrationContext || engagementHydrationState === 'running') return;
		void runEngagementHydration();
	}

	async function runEngagementHydration() {
		const context = engagementHydrationContext;
		if (!context || context.searchJob !== activeSearchJob || engagementHydrationController) return;

		const controller = new AbortController();
		engagementHydrationController = controller;
		engagementHydrationState = 'running';

		try {
			while (true) {
				if (
					context.searchJob !== activeSearchJob ||
					engagementHydrationContext !== context ||
					controller.signal.aborted
				) {
					return;
				}

				const pending = context.hydrationFeedItems.filter((item) => {
					const uri = feedItemUri(item);
					return uri !== null && !engagementAttemptedPostUris.has(uri);
				});
				if (pending.length === 0) break;

				const chunk = pending.slice(0, ENGAGEMENT_HYDRATION_CHUNK_SIZE);
				const chunkUris = [
					...new Set(chunk.map(feedItemUri).filter((uri): uri is string => Boolean(uri)))
				];
				const alreadyAttempted = engagementAttemptedPostUris.size;

				const engagement = await hydrateFeedItemsEngagement(chunk, {
					signal: controller.signal,
					concurrency: 4,
					onProgress: ({ completed }) => {
						if (
							context.searchJob !== activeSearchJob ||
							engagementHydrationContext !== context ||
							controller.signal.aborted
						) {
							return;
						}
						engagementHydrationProgress = {
							current: Math.min(context.total, alreadyAttempted + completed),
							total: context.total
						};
					}
				});

				if (
					context.searchJob !== activeSearchJob ||
					engagementHydrationContext !== context ||
					controller.signal.aborted
				) {
					return;
				}

				for (const uri of chunkUris) {
					engagementAttemptedPostUris.add(uri);
				}
				engagementCountsByUri = {
					...engagementCountsByUri,
					...collectEngagementCountsFromFeedItems(chunk)
				};
				engagementHydratedCount += engagement.hydratedCount;
				repoStats = {
					...repoStats,
					hydratedCount: engagementHydratedCount,
					missingCount: Math.max(0, engagementAttemptedPostUris.size - engagementHydratedCount)
				};
				engagementHydrationProgress = {
					current: engagementAttemptedPostUris.size,
					total: context.total
				};
				applyThreadsFromFeed(context.sourceFeedItems, context.did);
				saveViewer2MemoryCache();

				await new Promise<void>((resolve) => setTimeout(resolve, 0));
			}

			if (
				context.searchJob !== activeSearchJob ||
				engagementHydrationContext !== context ||
				controller.signal.aborted
			) {
				return;
			}

			const { threads } = applyThreadsFromFeed(context.sourceFeedItems, context.did);
			refreshDisplayedThreadsNow(threads);
			engagementHydrationState = repoStats.missingCount > 0 ? 'partial' : 'done';
			engagementHydrationProgress = { current: context.total, total: context.total };
			if (threadSortMode !== 'depth') {
				toastInfo('Engagement counts updated.');
			}
			saveViewer2MemoryCache();
		} catch (err: any) {
			if (context.searchJob !== activeSearchJob || engagementHydrationContext !== context) return;
			if (err?.name === 'AbortError' || controller.signal.aborted) {
				if (engagementHydrationController === controller && engagementHydrationState === 'running') {
					engagementHydrationState = 'paused';
					engagementHydrationProgress = {
						current: engagementAttemptedPostUris.size,
						total: context.total
					};
				}
				return;
			}
			engagementHydrationState = 'failed';
		} finally {
			if (engagementHydrationController === controller) {
				engagementHydrationController = null;
			}
		}
	}

	async function handleSearch(
		handle: string,
		options: { profile?: ProfileInfo | null; threadUrl?: string | null } = {}
	): Promise<boolean> {
		const cleaned = normalizeHandle(handle);
		if (!cleaned || loading) return false;

		const searchJob = ++activeSearchJob;
		engagementHydrationController?.abort();
		engagementHydrationController = null;
		engagementHydrationContext = null;
		engagementAttemptedPostUris = new Set();
		engagementHydratedCount = 0;
		engagementCountsByUri = {};
		engagementTargetPostCount = 0;
		cachedRepoFeedItems = null;
		cachedHydrationFeedItems = null;
		cachedEngagementDid = null;
		engagementHydrationState = 'idle';
		engagementHydrationProgress = { current: 0, total: 0 };
		loading = true;
		error = null;
		allThreads = [];
		collapsedByRootUri = {};
		pendingScrollToRootUri = null;
		highlightedThread = null;
		showExpanded = false;
		expandedThread = null;
		showBlogReader = false;
		blogThread = null;
		blogLoadingFullThread = false;
		activeBlogJob += 1;
		expandedLoading = false;
		hasSearched = true;
		stats = { postsScanned: 0, chainStarts: 0, threadsWithSelfReplies: 0 };
		repoStats = {
			totalPosts: 0,
			elapsedMs: 0,
			downloadedBytes: 0,
			source: null,
			hydratedCount: 0,
			missingCount: 0
		};

		const controller = new AbortController();
		abortController = controller;

		const requestedThreadUrl = options.threadUrl ? normalizeBskyPostUrl(options.threadUrl) : null;
		updateRouteState({ handle: cleaned, threadUrl: requestedThreadUrl });

		let success = false;

		try {
			let profile = options.profile;
			if (!profile || (normalizeHandle(profile.handle) !== cleaned && profile.did !== cleaned)) {
				profile = await getProfile(cleaned);
			}

			await handleProfileSelected(profile);
			if (!profile) throw new Error('Profile is not available.');

			updateRouteState({ handle: profile.handle, threadUrl: requestedThreadUrl });

			const did = profile.did;
			const authorInfo: AuthorInfo = {
				did: profile.did,
				handle: profile.handle,
				displayName: profile.displayName,
				avatar: profile.avatar
			};
			let latestDownloadedBytes = 0;
			progress = { phase: 'Downloading repository...', current: 0, total: 0 };
			const repo = await loadRepoFeedItems(did, authorInfo, {
				signal: controller.signal,
				onDownloadProgress: (downloadProgress) => {
					latestDownloadedBytes = downloadProgress.receivedBytes;
					progress =
						downloadProgress.totalBytes > 0
							? {
									phase: 'Downloading repository...',
									current: Math.round(
										(downloadProgress.receivedBytes / downloadProgress.totalBytes) * 100
									),
									total: 100,
									detail: buildRepoDownloadDetail(downloadProgress)
								}
							: {
									phase: 'Downloading repository...',
									current: 0,
									total: 0,
									detail: buildRepoDownloadDetail(downloadProgress)
								};
				},
				onParseProgress: (count) => {
					progress = {
						phase: 'Parsing repository posts...',
						current: 0,
						total: 0,
						detail: buildRepoParseDetail(count, latestDownloadedBytes)
					};
				}
			});

			progress = {
				phase: 'Building threads...',
				current: 0,
				total: repo.feedItems.length,
				detail: `${repo.totalPosts.toLocaleString()} repository posts ready for thread discovery`
			};

			repoStats = {
				totalPosts: repo.totalPosts,
				elapsedMs: repo.elapsedMs,
				downloadedBytes: repo.downloadedBytes,
				source: repo.source,
				hydratedCount: 0,
				missingCount: 0
			};

			const { threads } = applyThreadsFromFeed(repo.feedItems, did, {
				reportProgress: true,
				announce: true
			});
			const hydrationFeedItems = selectThreadFeedItems(repo.feedItems, threads);
			startEngagementHydration(repo.feedItems, hydrationFeedItems, did, searchJob, { reset: true });
			success = true;
		} catch (e: any) {
			if (e?.name === 'AbortError') {
				error = null;
			} else if (e?.message?.includes('Unable to resolve handle') || e?.message?.includes('Profile not found')) {
				error = `Could not find handle "${cleaned}". Make sure it's a valid Bluesky handle.`;
			} else if (e?.message?.includes('fetch')) {
				error = 'Network error. Please check your connection and try again.';
			} else {
				error = e?.message || 'An unexpected error occurred.';
			}
		} finally {
			loading = false;
			abortController = null;
		}

		return success;
	}

	function handleFontChange(key: string) {
		fontKey = key;
		try { localStorage.setItem('preferred-font', key); } catch {}
	}

	function handleModeChange(key: RenderMode) {
		if (key === renderMode) return;
		renderMode = key;
		try { localStorage.setItem('preferred-render-mode', renderMode); } catch {}
	}

	function handleModePickerChange(key: string) {
		if (isRenderMode(key)) handleModeChange(key);
	}

	function isRenderMode(value: string): value is RenderMode {
		return value === 'default' || value === 'gallery';
	}

	function setGalleryContentMode(mode: GalleryContentMode) {
		if (mode === galleryContentMode) return;
		galleryContentMode = mode;
		try { localStorage.setItem('preferred-gallery-content-mode', mode); } catch {}
	}

	function isGalleryContentMode(value: string): value is GalleryContentMode {
		return value === 'all' || value === 'media' || value === 'images' || value === 'movies';
	}

	function setGalleryGroupMode(mode: GalleryGroupMode) {
		if (mode === galleryGroupMode) return;
		galleryGroupMode = mode;
		try { localStorage.setItem('preferred-gallery-group-mode', mode); } catch {}
	}

	function isGalleryGroupMode(value: string): value is GalleryGroupMode {
		return value === 'threads' || value === 'posts';
	}

	function setGalleryMediaLayout(layout: GalleryMediaLayout) {
		if (layout === galleryMediaLayout) return;
		galleryMediaLayout = layout;
		try { localStorage.setItem('preferred-gallery-media-layout', layout); } catch {}
	}

	function isGalleryMediaLayout(value: string): value is GalleryMediaLayout {
		return value === 'grid' || value === 'masonry';
	}

	function setGalleryMediaFit(fit: GalleryMediaFit) {
		if (fit === galleryMediaFit) return;
		galleryMediaFit = fit;
		try { localStorage.setItem('preferred-gallery-media-fit', fit); } catch {}
	}

	function isGalleryMediaFit(value: string): value is GalleryMediaFit {
		return value === 'fill' || value === 'fit';
	}

	function setGalleryGridZoom(value: unknown) {
		const nextZoom = normalizeGalleryGridZoom(value);
		if (nextZoom === galleryGridZoom) return;
		galleryGridZoom = nextZoom;
		try { localStorage.setItem('preferred-gallery-grid-zoom', String(nextZoom)); } catch {}
	}

	function setThreadSortMode(mode: ThreadSortMode) {
		if (mode === threadSortMode) return;
		threadSortMode = mode;
		try { localStorage.setItem('preferred-thread-sort-mode', mode); } catch {}
	}

	function isThreadSortMode(value: string): value is ThreadSortMode {
		return value === 'depth' || value === 'liked' || value === 'reposted' || value === 'quoted';
	}

	function setSearchMode(mode: SearchMode) {
		if (mode === searchMode) return;
		searchMode = mode;
		try { localStorage.setItem('preferred-search-mode', mode); } catch {}
	}

	function isSearchMode(value: string): value is SearchMode {
		return value === 'fuzzy' || value === 'literal';
	}

	async function openExpandedThread(
		uri: string,
		options: { preserveScroll?: boolean } = {}
	): Promise<boolean> {
		if (options.preserveScroll) savedScrollY = window.scrollY;
		const localThread = findThreadForUri(uri);
		const cacheKey = localThread?.rootUri ?? uri;
		const cachedThread = expandedThreadMemoryCache.get(uri) ?? expandedThreadMemoryCache.get(cacheKey);
		if (cachedThread) {
			const patchedThread = applyEngagementCountsToThread(cachedThread, engagementCountsByUri);
			expandedThread = patchedThread;
			expandedThreadMemoryCache.set(patchedThread.rootUri, patchedThread);
			expandedLoading = false;
			showExpanded = true;
			showBlogReader = false;
			blogThread = null;
			blogLoadingFullThread = false;
			activeBlogJob += 1;
			const canonicalThreadUrl =
				buildBskyPostUrl(patchedThread.rootUri, patchedThread.rootPost.author.handle) ??
				buildBskyPostUrl(uri);
			updateRouteState({
				handle: selectedProfile?.handle || initialHandle,
				threadUrl: canonicalThreadUrl
			});
			saveViewer2MemoryCache();
			return true;
		}

		expandedLoading = true;
		showExpanded = true;
		showBlogReader = false;
		blogThread = null;
		blogLoadingFullThread = false;
		activeBlogJob += 1;

		try {
			expandedThread = await getFullThread(uri);
			expandedThreadMemoryCache.set(uri, expandedThread);
			expandedThreadMemoryCache.set(cacheKey, expandedThread);
			expandedThreadMemoryCache.set(expandedThread.rootUri, expandedThread);
			const canonicalThreadUrl =
				buildBskyPostUrl(expandedThread.rootUri, expandedThread.rootPost.author.handle) ??
				buildBskyPostUrl(uri);
			updateRouteState({
				handle: selectedProfile?.handle || initialHandle,
				threadUrl: canonicalThreadUrl
			});
			return true;
		} catch (e: any) {
			toastError(e?.message || 'Failed to load full thread.');
			showExpanded = false;
			expandedThread = null;
			updateRouteState({ handle: selectedProfile?.handle || initialHandle, threadUrl: null });
			return false;
		} finally {
			expandedLoading = false;
		}
	}

	async function handleExpand(rootUri: string) {
		await openExpandedThread(rootUri, { preserveScroll: true });
	}

	function countBlogChainPosts(thread: SelfReplyThread): number {
		return collectSelfReplyChainPosts(thread.rootPost).length;
	}

	function buildBlogThreadFromFullThread(
		fullThread: SelfReplyThread & { isTruncated?: boolean },
		selectedUri: string,
		fallbackThread: SelfReplyThread
	): SelfReplyThread {
		if (!threadContainsUri(fullThread.rootPost, selectedUri)) return fallbackThread;
		const chainRoot = findSelfReplyChainRoot(fullThread.rootPost, selectedUri);
		return {
			rootPost: chainRoot,
			depth: measureSelfReplyChainDepth(chainRoot),
			rootUri: chainRoot.uri
		};
	}

	function chooseMostCompleteBlogThread(
		localThread: SelfReplyThread,
		fullThread: SelfReplyThread
	): SelfReplyThread {
		return countBlogChainPosts(fullThread) >= countBlogChainPosts(localThread)
			? fullThread
			: localThread;
	}

	async function hydrateBlogThread(rootUri: string, localThread: SelfReplyThread, blogJob: number) {
		const cachedThread =
			expandedThreadMemoryCache.get(rootUri) ??
			expandedThreadMemoryCache.get(localThread.rootUri);
		if (cachedThread) {
			if (blogJob !== activeBlogJob || !showBlogReader) return;
			const fullBlogThread = buildBlogThreadFromFullThread(cachedThread, rootUri, localThread);
			blogThread = chooseMostCompleteBlogThread(localThread, fullBlogThread);
			blogLoadingFullThread = false;
			return;
		}

		try {
			const fullThread = await getFullThread(rootUri);
			if (blogJob !== activeBlogJob || !showBlogReader) return;

			expandedThreadMemoryCache.set(rootUri, fullThread);
			expandedThreadMemoryCache.set(localThread.rootUri, fullThread);
			expandedThreadMemoryCache.set(fullThread.rootUri, fullThread);

			const fullBlogThread = buildBlogThreadFromFullThread(fullThread, rootUri, localThread);
			blogThread = chooseMostCompleteBlogThread(localThread, fullBlogThread);
			saveViewer2MemoryCache();
		} catch {
			if (blogJob === activeBlogJob && showBlogReader) {
				toastInfo('Showing repository copy; full thread could not be completed.');
			}
		} finally {
			if (blogJob === activeBlogJob) {
				blogLoadingFullThread = false;
			}
		}
	}

	function openBlogThread(rootUri: string) {
		const thread = findThreadForUri(rootUri);
		if (!thread) {
			toastError('Could not find this thread in the loaded repository data.');
			return;
		}
		const blogJob = ++activeBlogJob;
		savedScrollY = window.scrollY;
		blogThread = thread;
		blogLoadingFullThread = true;
		showBlogReader = true;
		showExpanded = false;
		expandedThread = null;
		const bskyUrl = threadToBlueskyUrl(rootUri);
		updateRouteState({
			handle: selectedProfile?.handle || initialHandle,
			threadUrl: bskyUrl
		});
		requestAnimationFrame(() => {
			window.scrollTo({ top: 0, behavior: 'smooth' });
		});
		void hydrateBlogThread(rootUri, thread, blogJob);
	}

	function handleBlogBack() {
		activeBlogJob += 1;
		showBlogReader = false;
		blogThread = null;
		blogLoadingFullThread = false;
		updateRouteState({ handle: selectedProfile?.handle || initialHandle, threadUrl: null });
		saveViewer2MemoryCache();
		requestAnimationFrame(() => { window.scrollTo(0, savedScrollY); });
	}

	function handleBack() {
		showExpanded = false;
		updateRouteState({ handle: selectedProfile?.handle || initialHandle, threadUrl: null });
		saveViewer2MemoryCache();
		requestAnimationFrame(() => { window.scrollTo(0, savedScrollY); });
	}

	async function copyThreadLink() {
		try {
			if (!expandedThread) return;
			const bskyUrl = buildBskyPostUrl(expandedThread.rootUri, expandedThread.rootPost.author.handle);
			if (!bskyUrl) return;
			const shareUrl = new URL(buildViewerHref('threadviewer', { url: bskyUrl }), window.location.origin);
			await navigator.clipboard.writeText(shareUrl.toString());
			toastSuccess('Link copied to clipboard');
		} catch {
			toastError('Failed to copy link');
		}
	}

	async function handleShare(rootUri: string) {
		try {
			const bskyUrl = threadToBlueskyUrl(rootUri);
			if (!bskyUrl) { toastError('Could not build a share link for this thread.'); return; }
			const shareUrl = new URL(buildViewerHref('threadviewer', { url: bskyUrl }), window.location.origin);
			await navigator.clipboard.writeText(shareUrl.toString());
			toastSuccess('Link copied to clipboard');
		} catch {
			toastError('Failed to copy link');
		}
	}

	function handleOpenOnBluesky(rootUri: string) {
		if (!browser) return;
		const bskyUrl = threadToBlueskyUrl(rootUri);
		if (!bskyUrl) { toastError('Could not build Bluesky link for this thread.'); return; }
		const opened = window.open(bskyUrl, '_blank', 'noopener,noreferrer');
		if (!opened) toastInfo('Allow popups to open this thread in a new tab.');
	}

	function buildTreeviewerEmbedSrc(thread: SelfReplyThread): string | null {
		const threadUrl =
			activeThreadUrl ??
			buildBskyPostUrl(thread.rootUri, thread.rootPost.author.handle) ??
			buildBskyPostUrl(thread.rootUri);
		if (!threadUrl) return null;
		const href = buildViewerHref('treeviewer', { url: threadUrl });
		return `${href}${href.includes('?') ? '&' : '?'}embed=thread-section`;
	}

	onMount(async () => {
		try {
			const saved = localStorage.getItem('preferred-font');
			if (saved && saved in fontFamilies) fontKey = saved;
			const savedMode = localStorage.getItem('preferred-render-mode');
			if (savedMode && isRenderMode(savedMode)) renderMode = savedMode;
			const savedGalleryContentMode = localStorage.getItem('preferred-gallery-content-mode');
			if (savedGalleryContentMode && isGalleryContentMode(savedGalleryContentMode)) {
				galleryContentMode = savedGalleryContentMode;
			}
			const savedGalleryGroupMode = localStorage.getItem('preferred-gallery-group-mode');
			if (savedGalleryGroupMode && isGalleryGroupMode(savedGalleryGroupMode)) {
				galleryGroupMode = savedGalleryGroupMode;
			}
			const savedGalleryMediaLayout = localStorage.getItem('preferred-gallery-media-layout');
			if (savedGalleryMediaLayout && isGalleryMediaLayout(savedGalleryMediaLayout)) {
				galleryMediaLayout = savedGalleryMediaLayout;
			}
			const savedGalleryMediaFit = localStorage.getItem('preferred-gallery-media-fit');
			if (savedGalleryMediaFit && isGalleryMediaFit(savedGalleryMediaFit)) {
				galleryMediaFit = savedGalleryMediaFit;
			}
			const savedGalleryGridZoom = localStorage.getItem('preferred-gallery-grid-zoom');
			if (savedGalleryGridZoom) {
				galleryGridZoom = normalizeGalleryGridZoom(savedGalleryGridZoom);
			}
			const savedThreadSortMode = localStorage.getItem('preferred-thread-sort-mode');
			if (savedThreadSortMode && isThreadSortMode(savedThreadSortMode)) {
				threadSortMode = savedThreadSortMode;
			}
			const savedSearchMode = localStorage.getItem('preferred-search-mode');
			if (savedSearchMode && isSearchMode(savedSearchMode)) searchMode = savedSearchMode;
		} catch {}

		const params = new URLSearchParams(window.location.search);
		const handleParam = params.get('handle');
		const fromParam = params.get('from');
		const toParam = params.get('to');
		const normalizedHandleParam = normalizeHandle(handleParam);
		const cachedState = viewer2MemoryCache;
		const cacheCanRestore =
			cachedState !== null &&
			(!normalizedHandleParam || memoryCacheMatchesHandle(cachedState, normalizedHandleParam));
		let restoredFromCache = false;
		if (cacheCanRestore) {
			restoredFromCache = restoreViewer2MemoryCache(cachedState);
		}
		if (fromParam) dateFrom = fromParam;
		if (toParam) dateTo = toParam;

		if (handleParam) {
			const h = normalizedHandleParam;
			initialHandle = h;
			if (restoredFromCache) {
				updateRouteState({ handle: selectedProfile?.handle || initialHandle, threadUrl: null });
				return;
			}
			try {
				const profile = await getProfile(h);
				await handleProfileSelected(profile);
				await handleSearch(profile.handle, { profile });
			} catch {
				toastInfo('Could not load profile from URL');
			}
		}
	});

	onDestroy(() => {
		engagementHydrationController?.abort();
		saveViewer2MemoryCache();
	});
</script>

<svelte:head>
	<title>Repo Viewer - Bluesky Thread Viewer</title>
</svelte:head>

<main
	style="font-family: {fontFamily}"
	class:blog-reader-main={showBlogReader}
	class:gallery-main={renderMode === 'gallery' && !detailIsOpen}
>
	{#if showBlogReader && blogThread}
		<section class="blog-reader-shell" aria-label="Blog reader">
			<div class="blog-reader-toolbar">
				<button class="blog-back-btn wobbly-border" onclick={handleBlogBack}>
					&#8592; Back to threads
				</button>
				{#if blogLoadingFullThread}
					<span class="blog-status">Completing thread...</span>
				{/if}
			</div>
			<BlogArticle thread={blogThread} />
		</section>
	{/if}

	<div class="viewer-chrome" class:viewer-chrome--parked={showBlogReader} aria-hidden={showBlogReader}>
		<header>
			<RouteNav
				current="viewer2"
				align="center"
				threadUrl={activeThreadUrl}
				handle={selectedProfile?.handle || initialHandle}
			/>
			<h1>Repo Viewer</h1>
			<FontPicker value={fontKey} onchange={handleFontChange} />
		</header>

		<section class="search-section">
			<SearchBar onsearch={handleSearch} onprofile={handleProfileSelected} disabled={loading} {initialHandle} />
		</section>

		{#if error}
			<ErrorBanner message={error} />
		{/if}
	</div>

	{#if showExpanded}
		<div class="panel-detail">
			{#if expandedLoading}
				<LoadingSpinner progress={{ phase: 'Loading full thread...', current: 0, total: 0 }} />
			{:else if expandedThread}
				<div class="expanded-actions">
					<button class="back-btn wobbly-border" onclick={handleBack}>&#8592; Back to threads</button>
					<button class="copy-link-btn wobbly-border" onclick={copyThreadLink}>Copy link</button>
				</div>
				{#if expandedThread.isTruncated}
					<p class="truncation-warning">Some replies may be missing</p>
				{/if}
				<div class="expanded-thread expanded-thread--wide">
					{#if buildTreeviewerEmbedSrc(expandedThread)}
						<iframe
							class="treeviewer-frame"
							src={buildTreeviewerEmbedSrc(expandedThread) ?? undefined}
							title="Treeviewer"
						></iframe>
					{/if}
				</div>
			{/if}
		</div>
	{/if}

	<div class="results-layer" class:results-layer--parked={detailIsOpen} aria-hidden={detailIsOpen}>
		{#if hasSearched}
			<section class="results-section">
				<div class="results-header">
					{#if author}
						<div class="author-info">
							{#if author.avatar}
								<img src={author.avatar} alt="" class="author-avatar" />
							{/if}
							<span>
								{author.displayName || author.handle}
								<span class="author-handle">@{author.handle}</span>
							</span>
						</div>
					{/if}

					{#if !loading && repoStats.totalPosts > 0}
						<div class="stats-bar">
							<span>
								Downloaded {repoStats.totalPosts.toLocaleString()} posts in {(repoStats.elapsedMs / 1000).toFixed(1)}s
								from {formatBytes(repoStats.downloadedBytes)}{#if repoStats.source}
									via {repoStats.source === 'pds' ? 'PDS' : 'relay'}
								{/if}
							</span>
							{#if engagementHydrationProgress.total > 0 || repoStats.hydratedCount > 0 || engagementHydrationState === 'failed'}
								<span class="stats-sep">/</span>
								<span>
									{#if engagementHydrationState === 'running'}
										Hydrating engagement
										{#if engagementHydrationProgress.total > 0}
											{engagementHydrationProgress.current.toLocaleString()} / {engagementHydrationProgress.total.toLocaleString()}
										{/if}
									{:else if engagementHydrationState === 'paused'}
										Engagement paused
										{#if engagementHydrationProgress.total > 0}
											{engagementHydrationProgress.current.toLocaleString()} / {engagementHydrationProgress.total.toLocaleString()}
										{/if}
									{:else if engagementHydrationState === 'failed'}
										Engagement hydration failed
									{:else}
										Hydrated {repoStats.hydratedCount.toLocaleString()} engagement count{repoStats.hydratedCount !== 1 ? 's' : ''}
										{#if repoStats.missingCount > 0}
											({repoStats.missingCount.toLocaleString()} missing)
										{/if}
									{/if}
								</span>
								{#if engagementHydrationState === 'running'}
									<button type="button" class="engagement-control-btn" onclick={stopEngagementHydration}>
										Stop engagement
									</button>
								{:else if engagementHydrationContext && engagementHydrationProgress.current < engagementHydrationProgress.total}
									<button type="button" class="engagement-control-btn" onclick={resumeEngagementHydration}>
										Resume engagement
									</button>
								{/if}
							{/if}
						</div>
					{/if}

					{#if !loading && stats.postsScanned > 0}
						<div class="stats-bar">
							<span>{stats.postsScanned} posts scanned</span>
							<span class="stats-sep">/</span>
							<span>{stats.chainStarts} chains found</span>
							<span class="stats-sep">/</span>
							<span>{stats.threadsWithSelfReplies} with self-replies</span>
						</div>
					{/if}

					{#if allThreads.length > 0}
						<ThresholdControl bind:value={threshold} min={1} max={Math.max(maxDepth, 2)} />
						<ModePicker value={renderMode} onchange={handleModePickerChange} />
						<div class="thread-sort-row wobbly-border-light">
							<span>Sort</span>
							<div class="thread-sort-toggle" aria-label="Thread sort mode">
								<button
									type="button"
									class:active={threadSortMode === 'depth'}
									onclick={() => setThreadSortMode('depth')}
								>
									Highest chain
								</button>
								<button
									type="button"
									class:active={threadSortMode === 'liked'}
									onclick={() => setThreadSortMode('liked')}
								>
									Liked
								</button>
								<button
									type="button"
									class:active={threadSortMode === 'reposted'}
									onclick={() => setThreadSortMode('reposted')}
								>
									Reposted
								</button>
								<button
									type="button"
									class:active={threadSortMode === 'quoted'}
									onclick={() => setThreadSortMode('quoted')}
								>
									Quoted
								</button>
							</div>
						</div>
						{#if renderMode === 'gallery'}
							<div class="gallery-content-row wobbly-border-light">
								<span>Gallery</span>
								<div class="gallery-content-toggle" aria-label="Gallery content mode">
									<button
										type="button"
										class:active={galleryContentMode === 'all'}
										onclick={() => setGalleryContentMode('all')}
									>
										All
									</button>
									<button
										type="button"
										class:active={galleryContentMode === 'media'}
										onclick={() => setGalleryContentMode('media')}
									>
										Media
									</button>
									<button
										type="button"
										class:active={galleryContentMode === 'images'}
										onclick={() => setGalleryContentMode('images')}
									>
										Images
									</button>
									<button
										type="button"
										class:active={galleryContentMode === 'movies'}
										onclick={() => setGalleryContentMode('movies')}
									>
										Movies
									</button>
								</div>
							</div>
						{/if}
						{#if renderMode === 'gallery'}
							<div class="gallery-view-row wobbly-border-light">
								<span>View</span>
								<div class="gallery-view-toggle" aria-label="Gallery grouping mode">
									<button
										type="button"
										class:active={galleryGroupMode === 'threads'}
										onclick={() => setGalleryGroupMode('threads')}
									>
										Threads
									</button>
									<button
										type="button"
										class:active={galleryGroupMode === 'posts'}
										onclick={() => setGalleryGroupMode('posts')}
									>
										Posts
									</button>
								</div>
								{#if galleryContentMode !== 'all'}
									<span>Layout</span>
									<div class="gallery-layout-toggle" aria-label="Media layout mode">
										<button
											type="button"
											class:active={galleryMediaLayout === 'grid'}
											onclick={() => setGalleryMediaLayout('grid')}
										>
											Grid
										</button>
										<button
											type="button"
											class:active={galleryMediaLayout === 'masonry'}
											onclick={() => setGalleryMediaLayout('masonry')}
										>
											Masonry
										</button>
									</div>
									<span>Image</span>
									<div class="gallery-fit-toggle" aria-label="Media fit mode">
										<button
											type="button"
											class:active={galleryMediaFit === 'fill'}
											onclick={() => setGalleryMediaFit('fill')}
										>
											Fill
										</button>
										<button
											type="button"
											class:active={galleryMediaFit === 'fit'}
											onclick={() => setGalleryMediaFit('fit')}
										>
											Fit
										</button>
									</div>
								{/if}
								<label class="gallery-grid-zoom">
									<span>Grid</span>
									<input
										type="range"
										min={GALLERY_GRID_ZOOM_MIN}
										max={GALLERY_GRID_ZOOM_MAX}
										step="5"
										value={galleryGridZoom}
										oninput={(event) => setGalleryGridZoom(event.currentTarget.value)}
										aria-label="Gallery grid zoom"
									/>
									<span>{galleryGridZoom}%</span>
								</label>
							</div>
						{/if}
						<div class="search-filter wobbly-border-light">
							<label for="thread-search">Search threads:</label>
							<input
								id="thread-search"
								type="text"
								placeholder={searchMode === 'literal' ? 'Exact text...' : 'Fuzzy text or /pattern/flags...'}
								bind:value={searchQuery}
							/>
							<div class="search-mode-toggle" aria-label="Search mode">
								<button
									type="button"
									class:active={searchMode === 'fuzzy'}
									onclick={() => setSearchMode('fuzzy')}
								>
									Fuzzy
								</button>
								<button
									type="button"
									class:active={searchMode === 'literal'}
									onclick={() => setSearchMode('literal')}
								>
									Literal
								</button>
							</div>
							{#if searchMatcher.helperText}
								<p class="search-helper" class:warning={searchMatcher.helperTone === 'warning'}>
									{searchMatcher.helperText}
								</p>
							{/if}
						</div>
						<div class="date-filter-row">
							<SearchOptions bind:dateFrom bind:dateTo />
						</div>
						<p class="results-count">
							{displayedThreads.length}
							{#if renderMode === 'gallery' && galleryContentMode === 'images'}
								image thread{displayedThreads.length !== 1 ? 's' : ''}
							{:else if renderMode === 'gallery' && galleryContentMode === 'media'}
								media thread{displayedThreads.length !== 1 ? 's' : ''}
							{:else if renderMode === 'gallery' && galleryContentMode === 'movies'}
								movie thread{displayedThreads.length !== 1 ? 's' : ''}
							{:else}
								thread{displayedThreads.length !== 1 ? 's' : ''}
							{/if}
							with depth {threshold}+
							{#if isFilteringThreads}
								<span class="filtering-note">updating...</span>
							{/if}
						</p>
					{/if}

					{#if dateFrom || dateTo}
						<p class="date-filter-info">
							Filtered by date: {dateFrom || 'any'} to {dateTo || 'now'}
						</p>
					{/if}
				</div>

				{#if loading}
					<LoadingSpinner {progress} />
					<div class="cancel-row">
						<button class="cancel-btn wobbly-border" onclick={cancelFetch}>Cancel</button>
					</div>
				{/if}

				{#if displayedThreads.length > 0}
					<VirtualThreadList
						threads={displayedThreads}
						{renderMode}
						{galleryContentMode}
						{galleryGroupMode}
						{galleryMediaLayout}
						{galleryMediaFit}
						{galleryGridZoom}
						searchQuery={displayedSearchQuery}
						searchMode={displayedSearchMode}
						{highlightedThread}
						{collapsedByRootUri}
						oncollapsedchange={setThreadCollapsed}
						onexpand={handleExpand}
						onblog={openBlogThread}
						onshare={handleShare}
						onopenbluesky={handleOpenOnBluesky}
						scrollToRootUri={pendingScrollToRootUri}
						onscrolltorooturicomplete={handleScrollToRootUriComplete}
					/>
				{:else if !loading && !isFilteringThreads}
					<div class="empty-state">
						{#if allThreads.length === 0}
							<p>No self-reply threads found.</p>
						{:else}
							<p>No threads match the current filters.</p>
							<p class="empty-hint">
								{#if renderMode === 'gallery' && galleryContentMode !== 'all'}
									Try switching Gallery back to All, lowering the minimum depth, or adjusting the date range.
								{:else}
									Try lowering the minimum depth or adjusting the date range.
								{/if}
							</p>
						{/if}
					</div>
				{/if}
			</section>
		{/if}

		{#if !loading && !hasSearched}
			<section class="welcome">
				<p>Enter a Bluesky handle to download their full repository and find self-reply threads.</p>
				<p class="hint">Downloads the entire AT Protocol repo as a single request — no pagination or rate limits.</p>
			</section>
		{/if}
	</div>
</main>

<style>
	main {
		max-width: 800px;
		margin: 0 auto;
		padding: 32px 20px;
	}

	main.blog-reader-main {
		max-width: none;
		padding: 24px 20px 80px;
	}

	main.gallery-main {
		max-width: 1280px;
	}

	.viewer-chrome--parked,
	.results-layer--parked {
		display: none;
	}

	.blog-reader-shell {
		width: min(100%, 980px);
		min-height: calc(100vh - 104px);
		margin: 0 auto;
	}

	.blog-reader-toolbar {
		position: sticky;
		top: 0;
		z-index: 20;
		display: flex;
		align-items: center;
		gap: 10px;
		margin-bottom: 18px;
		padding: 0 0 18px;
		background: linear-gradient(
			to bottom,
			var(--bg-paper) 0%,
			var(--bg-paper) calc(100% - 10px),
			color-mix(in srgb, var(--bg-paper) 0%, transparent) 100%
		);
	}

	.blog-back-btn {
		display: inline-flex;
		align-items: center;
		width: fit-content;
		margin: 0;
		padding: 6px 14px;
		background: color-mix(in srgb, var(--card-bg) 86%, transparent);
		color: var(--muted);
		border-color: var(--control-border);
		backdrop-filter: blur(8px);
		font-size: 0.86rem;
	}

	.blog-back-btn:hover {
		color: var(--accent);
		border-color: var(--accent);
	}

	.blog-status {
		margin: 0;
		padding: 4px 8px;
		border-radius: 999px;
		color: var(--muted);
		font-size: 0.84rem;
		background: color-mix(in srgb, var(--card-bg) 78%, transparent);
		backdrop-filter: blur(8px);
	}

	header {
		text-align: center;
		margin-bottom: 32px;
	}

	h1 {
		font-size: 2.2rem;
		color: var(--text-ink);
		margin-bottom: 4px;
	}

	.search-section {
		margin-bottom: 32px;
	}

	.search-filter {
		max-width: 600px;
		margin: 12px auto 0;
		padding: 12px 20px;
		background: var(--card-bg);
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 12px;
	}

	.search-filter label {
		font-size: 0.95rem;
		white-space: nowrap;
	}

	.search-filter input[type='text'] {
		flex: 1;
		min-width: 120px;
		padding: 6px 10px;
		font-size: 0.95rem;
		font-family: inherit;
		border: 1.5px solid var(--muted);
		border-radius: 6px;
		background: var(--card-bg);
		color: var(--text-ink);
	}

	.search-filter input[type='text']::placeholder {
		color: var(--muted);
		opacity: 0.7;
	}

	.search-mode-toggle {
		display: inline-flex;
		flex: 0 0 auto;
		border: 1.5px solid var(--control-border);
		border-radius: 8px;
		overflow: hidden;
		background: color-mix(in srgb, var(--card-bg) 88%, white 12%);
	}

	.search-mode-toggle button {
		padding: 5px 9px;
		border: 0;
		border-right: 1px solid var(--control-border);
		background: transparent;
		color: var(--muted);
		font-family: inherit;
		font-size: 0.78rem;
		cursor: pointer;
	}

	.search-mode-toggle button:last-child {
		border-right: 0;
	}

	.search-mode-toggle button.active {
		background: var(--accent);
		color: white;
	}

	.search-mode-toggle button:hover:not(.active) {
		color: var(--accent);
	}

	.thread-sort-row,
	.gallery-content-row,
	.gallery-view-row {
		display: flex;
		align-items: center;
		justify-content: center;
		flex-wrap: wrap;
		gap: 10px;
		width: fit-content;
		margin: 8px auto 0;
		padding: 5px 8px;
		color: var(--muted);
		font-size: 0.86rem;
	}

	.thread-sort-toggle,
	.gallery-content-toggle,
	.gallery-view-toggle,
	.gallery-layout-toggle,
	.gallery-fit-toggle {
		display: inline-flex;
		flex-wrap: wrap;
		border: 1.5px solid var(--control-border);
		border-radius: 8px;
		overflow: hidden;
		background: color-mix(in srgb, var(--card-bg) 88%, white 12%);
	}

	.thread-sort-toggle button,
	.gallery-content-toggle button,
	.gallery-view-toggle button,
	.gallery-layout-toggle button,
	.gallery-fit-toggle button {
		padding: 5px 10px;
		border: 0;
		border-right: 1px solid var(--control-border);
		background: transparent;
		color: var(--muted);
		font-family: inherit;
		font-size: 0.78rem;
		cursor: pointer;
	}

	.thread-sort-toggle button {
		padding-inline: 9px;
	}

	.thread-sort-toggle button:last-child,
	.gallery-content-toggle button:last-child,
	.gallery-view-toggle button:last-child,
	.gallery-layout-toggle button:last-child,
	.gallery-fit-toggle button:last-child {
		border-right: 0;
	}

	.thread-sort-toggle button.active,
	.gallery-content-toggle button.active,
	.gallery-view-toggle button.active,
	.gallery-layout-toggle button.active,
	.gallery-fit-toggle button.active {
		background: var(--accent);
		color: white;
	}

	.thread-sort-toggle button:hover:not(.active),
	.gallery-content-toggle button:hover:not(.active),
	.gallery-view-toggle button:hover:not(.active),
	.gallery-layout-toggle button:hover:not(.active),
	.gallery-fit-toggle button:hover:not(.active) {
		color: var(--accent);
	}

	.gallery-grid-zoom {
		display: inline-flex;
		align-items: center;
		gap: 7px;
		margin-left: 2px;
		color: var(--muted);
		font-size: 0.82rem;
	}

	.gallery-grid-zoom input {
		width: clamp(120px, 18vw, 210px);
		accent-color: var(--accent);
		cursor: pointer;
	}

	.search-helper {
		width: 100%;
		margin: -2px 0 0;
		font-size: 0.82rem;
		line-height: 1.3;
		color: var(--muted);
	}

	.search-helper.warning {
		color: var(--accent);
	}

	.date-filter-row {
		max-width: 600px;
		margin: 8px auto 0;
		text-align: center;
	}

	.panel-detail {
		margin-top: 8px;
	}

	.panel-detail:has(.expanded-thread--wide) {
		width: 100vw;
		position: relative;
		left: 50%;
		transform: translateX(-50%);
		padding: 0 20px;
		box-sizing: border-box;
	}

	.expanded-actions {
		display: flex;
		gap: 8px;
		margin-bottom: 16px;
	}

	.back-btn, .copy-link-btn {
		display: inline-block;
		padding: 6px 16px;
		font-size: 0.95rem;
		background: var(--card-bg);
		color: var(--text-ink);
		border-color: var(--muted);
		cursor: pointer;
		transition: opacity 0.2s;
	}

	.back-btn:hover, .copy-link-btn:hover {
		opacity: 0.7;
	}

	.truncation-warning {
		background: #fff3cd;
		color: #856404;
		border: 1px solid #ffc107;
		border-radius: 6px;
		padding: 6px 12px;
		font-size: 0.85rem;
		margin-bottom: 8px;
		text-align: center;
	}

	.expanded-thread {
		margin-top: 8px;
		max-width: 100vw;
	}

	.treeviewer-frame {
		display: block;
		width: 100%;
		height: min(82vh, 900px);
		min-height: 620px;
		border: 1.5px solid var(--control-border);
		border-radius: 8px;
		background: var(--card-bg);
	}

	.results-section {
		margin-top: 24px;
	}

	.results-header {
		text-align: center;
		margin-bottom: 24px;
	}

	.author-info {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 12px;
		margin-bottom: 16px;
		font-size: 1.2rem;
	}

	.author-avatar {
		width: 40px;
		height: 40px;
		border-radius: 50%;
	}

	.author-handle {
		color: var(--muted);
		font-size: 0.95rem;
	}

	.stats-bar {
		display: flex;
		justify-content: center;
		gap: 6px;
		flex-wrap: wrap;
		font-size: 0.85rem;
		color: var(--muted);
		margin-bottom: 12px;
	}

	.stats-sep {
		opacity: 0.4;
	}

	.engagement-control-btn {
		padding: 2px 8px;
		border: 1px solid var(--control-border);
		border-radius: 6px;
		background: var(--card-bg);
		color: var(--muted);
		font: inherit;
		font-size: 0.78rem;
		line-height: 1.2;
		cursor: pointer;
	}

	.engagement-control-btn:hover {
		color: var(--accent);
		border-color: var(--accent);
	}

	.cancel-row {
		text-align: center;
		margin-top: 12px;
	}

	.cancel-btn {
		padding: 6px 20px;
		font-size: 0.95rem;
		background: var(--card-bg);
		color: var(--text-ink);
		border-color: var(--muted);
		cursor: pointer;
		transition: opacity 0.2s;
	}

	.cancel-btn:hover {
		opacity: 0.7;
	}

	.results-count {
		margin-top: 8px;
		color: var(--muted);
		font-size: 0.95rem;
	}

	.filtering-note {
		margin-left: 8px;
		color: var(--accent);
		font-size: 0.82rem;
	}

	.date-filter-info {
		margin-top: 4px;
		color: var(--muted);
		font-size: 0.85rem;
		font-style: italic;
	}

	.empty-state {
		text-align: center;
		padding: 48px 24px;
	}

	.empty-state p {
		font-size: 1.1rem;
		margin-bottom: 6px;
	}

	.empty-hint {
		color: var(--muted);
		font-size: 0.95rem !important;
	}

	.welcome {
		text-align: center;
		padding: 64px 24px;
	}

	.welcome p {
		font-size: 1.1rem;
		margin-bottom: 8px;
	}

	.hint {
		color: var(--muted);
		font-size: 0.95rem !important;
	}
</style>
