<script module lang="ts">
	import type { AuthorInfo as CachedAuthorInfo, SelfReplyThread as CachedSelfReplyThread } from '$lib/types';
	import type { ProfileInfo as CachedProfileInfo } from '$lib/api/bluesky';

	type CachedRenderMode = 'default' | 'gallery';
	type CachedSearchMode = 'fuzzy' | 'literal';
	type CachedGalleryContentMode = 'all' | 'media' | 'images' | 'movies';
	type CachedGalleryGroupMode = 'threads' | 'posts';
	type CachedGalleryMediaLayout = 'grid' | 'masonry';
	type CachedGalleryMediaFit = 'fill' | 'fit';
	type CachedThreadSortMode = 'depth' | 'newest' | 'oldest' | 'liked' | 'reposted' | 'quoted';
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
	type CachedLoadedRepoAccount = CachedAuthorInfo & {
		totalPosts: number;
		elapsedMs: number;
		downloadedBytes: number;
		source: 'pds' | 'relay' | null;
		stats: CachedThreadStats;
	};
	type Viewer2MemoryCache = {
		cacheVersion: number;
		initialHandle: string;
		selectedProfile: CachedProfileInfo | null;
		author: CachedAuthorInfo | null;
		repoAccounts?: CachedLoadedRepoAccount[];
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
	import ThresholdControl from '$lib/components/ThresholdControl.svelte';
	import ModePicker from '$lib/components/ModePicker.svelte';
	import VirtualThreadList from '$lib/components/VirtualThreadList.svelte';
	import TimelineViewer from '$lib/components/TimelineViewer.svelte';
	import { getGalleryHydratedEmbed } from '$lib/components/modes/GalleryThreads.svelte';
	import WholeThreadReader, {
		type WholeThreadReaderItem
	} from '$lib/components/WholeThreadReader.svelte';
	import LoadingSpinner from '$lib/components/LoadingSpinner.svelte';
	import ErrorBanner from '$lib/components/ErrorBanner.svelte';
	import RouteNav from '$lib/components/RouteNav.svelte';
	import type { SelfReplyThread, AuthorInfo, DiscoverProgress, ThreadPost } from '$lib/types';
	import type { FollowProfileInfo, ProfileInfo } from '$lib/api/bluesky';
	import { getFollowsPage, getProfile, getFullThread } from '$lib/api/bluesky';
	import {
		hydrateFeedItemsEngagement,
		hydrateFeedItemsThreadEngagement,
		loadRepoFeedItems,
		type RepoDownloadProgress,
		type RepoFeedLoadResult
	} from '$lib/utils/repoHydration';
	import { loadRepoReposts } from '$lib/utils/repoReposts';
	import { buildThreadsFromFeed } from '$lib/utils/threadWalker';
	import {
		fetchParentPosts,
		collectParentUris,
		resetParentPosts,
		parentPostsByUri
	} from '$lib/stores/parentPosts';
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

	const ENGAGEMENT_HYDRATION_CHUNK_SIZE = 500;
	const ENGAGEMENT_HYDRATION_CONCURRENCY = 16;
	const ENGAGEMENT_THREAD_CONCURRENCY = 8;
	const POST_HYDRATION_ENABLED = true;
	// Hidden for now — the "Fetch parents / whole threads" controls aren't behaving as
	// wanted. Flip to true to bring the row back.
	const SHOW_FETCH_BUTTONS = false;
	const GALLERY_GRID_ZOOM_MIN = 55;
	const GALLERY_GRID_ZOOM_MAX = 160;
	const VIEWER2_MEMORY_CACHE_SAVE_DELAY_MS = 450;
	const MAX_FOLLOW_PAGES = 20;
	const BATCH_CONCURRENCY_MIN = 1;
	const BATCH_CONCURRENCY_MAX = 6;
	const BATCH_START_DELAY_MIN_MS = 0;
	const BATCH_START_DELAY_MAX_MS = 30_000;
	const BATCH_RATE_LIMIT_BACKOFF_MS = 12_000;
	const BATCH_RATE_LIMIT_RETRIES = 3;

	type RenderMode = 'default' | 'gallery';
	type SearchMode = 'fuzzy' | 'literal';
	type GalleryContentMode = 'all' | 'media' | 'images' | 'movies';
	type GalleryGroupMode = 'threads' | 'posts';
	type GalleryMediaLayout = 'grid' | 'masonry';
	type GalleryMediaFit = 'fill' | 'fit';
	type ThreadSortMode = 'depth' | 'newest' | 'oldest' | 'liked' | 'reposted' | 'quoted';
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
	type LoadedRepoAccount = AuthorInfo & {
		totalPosts: number;
		elapsedMs: number;
		downloadedBytes: number;
		source: 'pds' | 'relay' | null;
		stats: ThreadStats;
	};
	type BatchRepoStatus = 'pending' | 'waiting' | 'downloading' | 'parsing' | 'building' | 'done' | 'failed';
	type BatchRepoItem = FollowProfileInfo & {
		status: BatchRepoStatus;
		detail: string;
		error: string | null;
		retries: number;
		downloadedBytes: number;
		threadCount: number;
	};
	type BatchProgress = {
		done: number;
		total: number;
		active: number;
		failed: number;
		skipped: number;
		rateLimitHits: number;
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
	let repoAccounts: LoadedRepoAccount[] = $state([]);
	let threshold = $state(1);
	let loading = $state(false);
	let error: string | null = $state(null);
	let progress: DiscoverProgress = $state({ phase: '', current: 0, total: 0 });
	let hasSearched = $state(false);
	let initialHandle = $state('');
	let activeSearchJob = 0;

	let selectedProfile: ProfileInfo | null = $state(null);
	let showAddAccount = $state(false);
	let additionalHandle = $state('');
	let additionalProfile: ProfileInfo | null = $state(null);
	let followsSubject: ProfileInfo | null = $state(null);
	let follows: FollowProfileInfo[] = $state([]);
	let loadingFollows = $state(false);
	let showFollowEditor = $state(false);
	let followFilter = $state('');
	let excludedFollowDids = $state(new Set<string>());
	let batchDownloading = $state(false);
	let batchConcurrency = $state(2);
	let batchStartDelayMs = $state(1000);
	let batchItems: BatchRepoItem[] = $state([]);
	let batchProgress: BatchProgress = $state({
		done: 0,
		total: 0,
		active: 0,
		failed: 0,
		skipped: 0,
		rateLimitHits: 0
	});
	let followLoadController: AbortController | null = null;

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

	type BlastMedia = {
		src: string;
		aspectRatio: string;
	};

	type BlastItem = {
		text: string;
		media: BlastMedia[];
	};

	type BlastCard = BlastItem & {
		id: number;
		style: string;
	};

	let blastMode = $state(false);
	let blastCards = $state<BlastCard[]>([]);
	let blastCardId = 0;
	let blastItems: BlastItem[] = [];
	let blastRate = $state(3); // bursts per second
	let blastBurstSize = $state(4);
	let blastFlyMs = $state(1500);
	let blastSizePct = $state(100);
	const blastIntervalMs = $derived(Math.round(1000 / blastRate));
	const maxBlastCards = $derived(Math.max(60, blastBurstSize * 15));

	function blastRatioOf(aspectRatio?: { width: number; height: number }): string {
		return aspectRatio && aspectRatio.width > 0 && aspectRatio.height > 0
			? `${aspectRatio.width} / ${aspectRatio.height}`
			: '4 / 3';
	}

	function blastMediaFor(post: ThreadPost, mode: GalleryContentMode): BlastMedia[] {
		const media: BlastMedia[] = [];
		// Repo-loaded posts keep hydrated embeds in the gallery's cache, not on the post itself.
		const embed = post.embed ?? getGalleryHydratedEmbed(post.uri);
		if (mode !== 'movies') {
			for (const image of [...(embed?.images ?? []), ...(embed?.record?.images ?? [])]) {
				const src = image.thumb || image.fullsize;
				if (src) media.push({ src, aspectRatio: blastRatioOf(image.aspectRatio) });
			}
		}
		if (mode !== 'images') {
			for (const video of [embed?.video, embed?.record?.video]) {
				if (video?.thumbnail) {
					media.push({ src: video.thumbnail, aspectRatio: blastRatioOf(video.aspectRatio) });
				}
			}
		}
		return media.slice(0, 2);
	}

	function collectBlastItems(): BlastItem[] {
		const mode = renderMode === 'gallery' ? galleryContentMode : 'all';
		const mediaOnly = mode !== 'all';
		const items: BlastItem[] = [];
		const walk = (post: ThreadPost) => {
			const media = blastMediaFor(post, mode);
			if (mediaOnly) {
				// Media tabs blast pure media cards, like the hashtag gallery blast mode.
				if (media.length > 0) items.push({ text: '', media });
			} else {
				const text = post.text.trim();
				if (text.length > 0 || media.length > 0) items.push({ text, media });
			}
			for (const child of post.children) walk(child);
		};
		for (const thread of displayedThreads) walk(thread.rootPost);
		return items;
	}

	// Keep the blast pool in sync with the active tab/filters while blasting.
	$effect(() => {
		if (!blastMode) return;
		blastItems = collectBlastItems();
	});

	function blastCardStyle(stagger: number): string {
		const vw = window.innerWidth;
		const vh = window.innerHeight;
		// Spawn near the middle of the screen with some spray
		const ox = vw / 2 + (Math.random() - 0.5) * vw * 0.3;
		const oy = vh / 2 + (Math.random() - 0.5) * vh * 0.3;
		// Blast outward in a random direction, well past the screen edge
		const angle = Math.random() * Math.PI * 2;
		const dist = Math.hypot(vw, vh) * (0.6 + Math.random() * 0.6);
		const tx = Math.cos(angle) * dist;
		const ty = Math.sin(angle) * dist;
		const scale = (1.6 + Math.random() * 2.2) * (blastSizePct / 100);
		const rot = (Math.random() - 0.5) * 90;
		const dur = blastFlyMs * (0.75 + Math.random() * 0.5);
		const delay = stagger * 90 + Math.random() * 80;
		return (
			`left: ${ox.toFixed(0)}px; top: ${oy.toFixed(0)}px; ` +
			`--tx: ${tx.toFixed(0)}px; --ty: ${ty.toFixed(0)}px; ` +
			`--sc: ${scale.toFixed(2)}; --rot: ${rot.toFixed(1)}deg; ` +
			`--dur: ${dur.toFixed(0)}ms; --delay: ${delay.toFixed(0)}ms;`
		);
	}

	function spawnBlastBurst() {
		if (!browser) return;
		// The hydrated embed cache fills in over time, so keep retrying until media shows up.
		if (blastItems.length === 0) blastItems = collectBlastItems();
		if (blastItems.length === 0) return;
		const fresh: BlastCard[] = [];
		for (let i = 0; i < blastBurstSize; i++) {
			const item = blastItems[Math.floor(Math.random() * blastItems.length)];
			fresh.push({ ...item, id: blastCardId++, style: blastCardStyle(i) });
		}
		const next = [...blastCards, ...fresh];
		blastCards = next.length > maxBlastCards ? next.slice(next.length - maxBlastCards) : next;
	}

	// The interval restarts automatically when the rate slider changes.
	$effect(() => {
		if (!blastMode) return;
		const timer = setInterval(spawnBlastBurst, blastIntervalMs);
		return () => clearInterval(timer);
	});

	function stopBlastMode() {
		blastMode = false;
		blastCards = [];
		blastItems = [];
	}

	function toggleBlastMode() {
		if (blastMode) {
			stopBlastMode();
			return;
		}
		if (!browser || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
		blastItems = collectBlastItems();
		blastMode = true;
		spawnBlastBurst();
	}

	function removeBlastCard(id: number) {
		blastCards = blastCards.filter((card) => card.id !== id);
	}

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

	function normalizeBatchConcurrency(value: unknown): number {
		const numeric = Number(value);
		if (!Number.isFinite(numeric)) return 2;
		return Math.max(
			BATCH_CONCURRENCY_MIN,
			Math.min(BATCH_CONCURRENCY_MAX, Math.round(numeric))
		);
	}

	function normalizeBatchStartDelayMs(value: unknown): number {
		const numeric = Number(value);
		if (!Number.isFinite(numeric)) return 1000;
		return Math.max(
			BATCH_START_DELAY_MIN_MS,
			Math.min(BATCH_START_DELAY_MAX_MS, Math.round(numeric))
		);
	}

	function setBatchConcurrency(value: unknown) {
		batchConcurrency = normalizeBatchConcurrency(value);
	}

	function setBatchStartDelayMs(value: unknown) {
		batchStartDelayMs = normalizeBatchStartDelayMs(value);
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
	let cachedRepoFeedItems: any[] | null = $state(null);
	let cachedHydrationFeedItems: any[] | null = null;
	let cachedEngagementDid: string | null = null;
	let viewer2MemoryCacheSaveTimer: ReturnType<typeof setTimeout> | null = null;

	// Expanded thread state
	let expandedThread: (SelfReplyThread & { isTruncated?: boolean }) | null = $state(null);
	let expandedLoading = $state(false);
	let showExpanded = $state(false);
	let savedScrollY = 0;
	let blogThread: SelfReplyThread | null = $state(null);
	let blogLoadingFullThread = $state(false);
	let activeBlogJob = 0;
	let showBlogReader = $state(false);

	// Whole-thread reader: a flat, scrollable feed of every post (all participants)
	// across the fetched conversations of the filtered/all thread list.
	let wholeThreadFetching = $state(false);
	let wholeThreadProgress = $state({ current: 0, total: 0 });
	let wholeThreadController: AbortController | null = null;
	let wholeThreadItems = $state<WholeThreadReaderItem[]>([]);
	let wholeThreadTruncated = $state(false);
	let wholeThreadSourceLabel = $state('');
	let showWholeThreadReader = $state(false);
	let wholeThreadSavedScrollY = 0;

	// Reposts as a gallery source: reposts are first-class records in the repo CAR.
	// We parse app.bsky.feed.repost records locally, hydrate the referenced posts, and
	// present each reposted post as a single-post thread so the gallery's content-mode
	// (all/media/images/movies), search, and date filters all apply unchanged.
	type ViewSource = 'threads' | 'reposts' | 'both';
	let viewSource = $state<ViewSource>('threads');
	let repostThreads = $state<SelfReplyThread[]>([]);
	let repostsLoaded = $state(false);
	let repostsMissingCount = $state(0);
	let repostsFetching = $state(false);
	let repostsPhase = $state<'idle' | 'downloading' | 'parsing' | 'hydrating'>('idle');
	let repostsProgress = $state({ current: 0, total: 0 });
	let repostsController: AbortController | null = null;

	const detailIsOpen = $derived(showExpanded || showBlogReader || showWholeThreadReader);

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

	// Peak engagement = the single highest-engagement post in the thread (NOT a sum).
	// Used for sorting so a thread containing a viral reply surfaces to the top.
	function accumulateMaxEngagement(post: ThreadPost, acc: ThreadEngagementTotals) {
		acc.likeCount = Math.max(acc.likeCount, post.likeCount ?? 0);
		acc.repostCount = Math.max(acc.repostCount, post.repostCount ?? 0);
		acc.quoteCount = Math.max(acc.quoteCount, post.quoteCount ?? 0);
		for (const child of post.children) accumulateMaxEngagement(child, acc);
	}

	function peakThreadEngagement(thread: SelfReplyThread): ThreadEngagementTotals {
		const acc: ThreadEngagementTotals = { likeCount: 0, repostCount: 0, quoteCount: 0 };
		accumulateMaxEngagement(thread.rootPost, acc);
		return acc;
	}

	function timestamp(value: string): number {
		const parsed = Date.parse(value);
		return Number.isFinite(parsed) ? parsed : 0;
	}

	function compareThreadValues(a: SelfReplyThread, b: SelfReplyThread): number {
		if (threadSortMode === 'newest') {
			return timestamp(b.rootPost.createdAt) - timestamp(a.rootPost.createdAt) || b.depth - a.depth;
		}
		if (threadSortMode === 'oldest') {
			return timestamp(a.rootPost.createdAt) - timestamp(b.rootPost.createdAt) || b.depth - a.depth;
		}
		if (threadSortMode === 'liked' || threadSortMode === 'reposted' || threadSortMode === 'quoted') {
			const metric =
				threadSortMode === 'liked'
					? 'likeCount'
					: threadSortMode === 'reposted'
						? 'repostCount'
						: 'quoteCount';
			const aTotal = peakThreadEngagement(a)[metric] ?? 0;
			const bTotal = peakThreadEngagement(b)[metric] ?? 0;
			if (aTotal !== bTotal) return bTotal - aTotal;
		}

		return b.depth - a.depth || timestamp(b.rootPost.createdAt) - timestamp(a.rootPost.createdAt);
	}

	// The active gallery source. Reposts are flat single-post threads, so the depth
	// threshold is meaningless for them and is pinned to 1 so every repost shows; the
	// threshold only applies to the pure Threads view.
	const activeThreads = $derived.by(() => {
		if (viewSource === 'reposts') return repostThreads;
		if (viewSource !== 'both') return allThreads;
		// Dedupe by rootUri so a self-repost doesn't collide with an owned thread.
		const threadUris = new Set(allThreads.map((thread) => thread.rootUri));
		return [...allThreads, ...repostThreads.filter((thread) => !threadUris.has(thread.rootUri))];
	});
	const effectiveThreshold = $derived(viewSource === 'threads' ? threshold : 1);
	const contentNoun = $derived(
		viewSource === 'reposts' ? 'repost' : viewSource === 'both' ? 'post' : 'thread'
	);
	const sortedThreads = $derived([...activeThreads].sort(compareThreadValues));

	const maxDepth = $derived(
		activeThreads.length > 0 ? Math.max(...activeThreads.map((t) => t.depth)) : 2
	);
	const loadedRepoDids = $derived.by(() => new Set(repoAccounts.map((account) => account.did)));
	const activeFollows = $derived.by(() => follows.filter((follow) => !excludedFollowDids.has(follow.did)));
	const downloadableActiveFollows = $derived.by(() =>
		activeFollows.filter((follow) => !loadedRepoDids.has(follow.did))
	);
	const filteredFollows = $derived.by(() => {
		const query = followFilter.trim().toLowerCase();
		if (!query) return follows;
		return follows.filter(
			(follow) =>
				follow.handle.toLowerCase().includes(query) ||
				(follow.displayName ?? '').toLowerCase().includes(query)
		);
	});

	function normalizeHandle(handle: string | null | undefined): string {
		return (handle ?? '').replace(/^@/, '').trim();
	}

	function profileMatchesHandle(profile: ProfileInfo | null, handle: string): boolean {
		if (!profile) return false;
		const normalized = normalizeHandle(handle);
		return normalized === normalizeHandle(profile.handle) || normalized === profile.did;
	}

	function aggregateThreadStats(accounts: LoadedRepoAccount[]): ThreadStats {
		return accounts.reduce<ThreadStats>(
			(total, account) => ({
				postsScanned: total.postsScanned + account.stats.postsScanned,
				chainStarts: total.chainStarts + account.stats.chainStarts,
				threadsWithSelfReplies:
					total.threadsWithSelfReplies + account.stats.threadsWithSelfReplies
			}),
			{ postsScanned: 0, chainStarts: 0, threadsWithSelfReplies: 0 }
		);
	}

	function aggregateRepoStats(
		accounts: LoadedRepoAccount[],
		engagement: { hydratedCount: number; missingCount: number } = {
			hydratedCount: repoStats.hydratedCount,
			missingCount: repoStats.missingCount
		}
	): RepoStats {
		const sourceValues = accounts
			.map((account) => account.source)
			.filter((source): source is 'pds' | 'relay' => source !== null);
		const uniqueSources = new Set(sourceValues);

		return {
			totalPosts: accounts.reduce((total, account) => total + account.totalPosts, 0),
			elapsedMs: accounts.reduce((total, account) => total + account.elapsedMs, 0),
			downloadedBytes: accounts.reduce((total, account) => total + account.downloadedBytes, 0),
			source: uniqueSources.size === 1 ? (sourceValues[0] ?? null) : null,
			hydratedCount: engagement.hydratedCount,
			missingCount: engagement.missingCount
		};
	}

	function applyRepoAccounts(
		accounts: LoadedRepoAccount[],
		engagement: { hydratedCount: number; missingCount: number } = {
			hydratedCount: repoStats.hydratedCount,
			missingCount: repoStats.missingCount
		}
	) {
		repoAccounts = accounts;
		stats = aggregateThreadStats(accounts);
		repoStats = aggregateRepoStats(accounts, engagement);
	}

	function upsertRepoAccount(account: LoadedRepoAccount): LoadedRepoAccount[] {
		const existingIndex = repoAccounts.findIndex((candidate) => candidate.did === account.did);
		if (existingIndex === -1) return [...repoAccounts, account];
		return repoAccounts.map((candidate, index) => (index === existingIndex ? account : candidate));
	}

	function createLoadedRepoAccount(
		authorInfo: AuthorInfo,
		repo: RepoFeedLoadResult,
		threadStats: ThreadStats
	): LoadedRepoAccount {
		return {
			...authorInfo,
			totalPosts: repo.totalPosts,
			elapsedMs: repo.elapsedMs,
			downloadedBytes: repo.downloadedBytes,
			source: repo.source,
			stats: threadStats
		};
	}

	function replaceThreadsForAccount(
		existingThreads: SelfReplyThread[],
		did: string,
		nextThreads: SelfReplyThread[]
	): SelfReplyThread[] {
		const withoutAccountThreads = existingThreads.filter(
			(thread) => thread.rootPost.author.did !== did
		);
		return [...withoutAccountThreads, ...nextThreads].sort(compareThreadValues);
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
		let changed = false;
		const nextThreads = threads.map((thread) => {
			const nextThread = applyEngagementCountsToThread(thread, countsByUri);
			if (nextThread !== thread) changed = true;
			return nextThread;
		});
		return changed ? nextThreads : threads;
	}

	function applyEngagementCountsToActiveViews(
		countsByUri: Record<string, CachedPostEngagementCounts>
	) {
		if (Object.keys(countsByUri).length === 0) return;
		displayedThreads = applyEngagementCountsToThreadList(displayedThreads, countsByUri);
		if (expandedThread) {
			expandedThread = applyEngagementCountsToThread(expandedThread, countsByUri);
		}
		if (blogThread) {
			blogThread = applyEngagementCountsToThread(blogThread, countsByUri);
		}
		for (const [key, cachedThread] of expandedThreadMemoryCache) {
			const patchedThread = applyEngagementCountsToThread(cachedThread, countsByUri);
			if (patchedThread !== cachedThread) expandedThreadMemoryCache.set(key, patchedThread);
		}
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
			cache.author?.handle,
			...(cache.repoAccounts ?? []).map((account) => account.handle)
		];
		const dids = [
			cache.selectedProfile?.did,
			cache.author?.did,
			...(cache.repoAccounts ?? []).map((account) => account.did)
		];
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
		repoAccounts =
			cache.repoAccounts ??
			(cache.author
				? [
						{
							...cache.author,
							totalPosts: cache.repoStats.totalPosts,
							elapsedMs: cache.repoStats.elapsedMs,
							downloadedBytes: cache.repoStats.downloadedBytes,
							source: cache.repoStats.source,
							stats: cache.stats
						}
					]
				: []);
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
		stats = repoAccounts.length > 0 ? aggregateThreadStats(repoAccounts) : cache.stats;
		repoStats = repoAccounts.length > 0 ? aggregateRepoStats(repoAccounts, {
			hydratedCount: cache.repoStats.hydratedCount ?? 0,
			missingCount: cache.repoStats.missingCount ?? 0
		}) : {
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
			engagementHydrationState = restoredEngagementAttempts ? 'paused' : 'idle';
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
			repoAccounts,
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

	function scheduleViewer2MemoryCacheSave() {
		if (!browser) return;
		if (viewer2MemoryCacheSaveTimer !== null) {
			clearTimeout(viewer2MemoryCacheSaveTimer);
		}
		viewer2MemoryCacheSaveTimer = setTimeout(() => {
			viewer2MemoryCacheSaveTimer = null;
			saveViewer2MemoryCache();
		}, VIEWER2_MEMORY_CACHE_SAVE_DELAY_MS);
	}

	function flushViewer2MemoryCacheSave() {
		if (viewer2MemoryCacheSaveTimer !== null) {
			clearTimeout(viewer2MemoryCacheSaveTimer);
			viewer2MemoryCacheSaveTimer = null;
		}
		saveViewer2MemoryCache();
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
			displayedThreads = applyEngagementCountsToThreadList(
				displayedThreads,
				engagementCountsByUri
			);
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
					thread.depth >= effectiveThreshold &&
					isInDateRange(thread.rootPost.createdAt, dateFrom, dateTo) &&
					threadMatchesGalleryContentCandidate(thread, galleryMode) &&
					matchesSearch(thread, matcher, { galleryContentMode: galleryMode })
			);
		displayedThreads = applyEngagementCountsToThreadList(displayedThreads, engagementCountsByUri);
		displayedSearchQuery = searchQuery;
		displayedSearchMode = searchMode;
		isFilteringThreads = false;
	}

	$effect(() => {
		scheduleThreadFilter(sortedThreads, searchMatcher, {
			threshold: effectiveThreshold,
			dateFrom,
			dateTo,
			query: searchQuery,
			mode: searchMode,
			galleryContentMode: renderMode === 'gallery' ? galleryContentMode : 'all'
		});

		return clearScheduledFilter;
	});

	$effect(() => {
		initialHandle;
		selectedProfile;
		author;
		repoAccounts;
		allThreads;
		displayedThreads;
		displayedSearchQuery;
		displayedSearchMode;
		threshold;
		renderMode;
		galleryContentMode;
		galleryGroupMode;
		galleryMediaLayout;
		galleryMediaFit;
		galleryGridZoom;
		threadSortMode;
		searchQuery;
		searchMode;
		dateFrom;
		dateTo;
		stats;
		repoStats;
		collapsedByRootUri;
		hasSearched;
		expandedThread;
		cachedRepoFeedItems;
		cachedHydrationFeedItems;
		cachedEngagementDid;
		engagementCountsByUri;
		engagementTargetPostCount;
		engagementHydrationProgress;
		scheduleViewer2MemoryCacheSave();
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
		timelineHydrationController?.abort();
		timelineHydrationController = null;
		timelineHydrating = false;
		wholeThreadController?.abort();
		wholeThreadController = null;
		wholeThreadFetching = false;
		repostsController?.abort();
		repostsController = null;
		repostsFetching = false;
		repostsPhase = 'idle';
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
		if (batchDownloading) {
			progress = {
				phase: 'Canceling batch download...',
				current: batchProcessedCount(),
				total: batchProgress.total,
				detail: buildBatchProgressDetail()
			};
		}
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

	function handleAdditionalHandleChange(value: string) {
		additionalHandle = value;
		if (additionalProfile && !profileMatchesHandle(additionalProfile, value)) {
			additionalProfile = null;
		}
	}

	function handleAdditionalProfileSelected(profile: ProfileInfo) {
		additionalProfile = profile;
		additionalHandle = profile.handle;
	}

	async function handleAddAccountSearch(handle: string): Promise<void> {
		const cleaned = normalizeHandle(handle);
		if (!cleaned || loading) return;
		const existingAccount = repoAccounts.find(
			(account) => normalizeHandle(account.handle) === cleaned || account.did === cleaned
		);
		if (existingAccount) {
			toastInfo(`@${existingAccount.handle} is already loaded.`);
			return;
		}
		if (additionalProfile && profileMatchesHandle(additionalProfile, cleaned)) {
			const existingProfileAccount = repoAccounts.find(
				(account) => account.did === additionalProfile?.did
			);
			if (existingProfileAccount) {
				toastInfo(`@${existingProfileAccount.handle} is already loaded.`);
				return;
			}
		}
		const success = await handleSearch(cleaned, {
			profile: profileMatchesHandle(additionalProfile, cleaned) ? additionalProfile : null,
			append: true
		});
		if (success) {
			additionalHandle = '';
			additionalProfile = null;
			showAddAccount = false;
		}
	}

	function resetBatchProgress() {
		batchProgress = {
			done: 0,
			total: 0,
			active: 0,
			failed: 0,
			skipped: 0,
			rateLimitHits: 0
		};
	}

	function resetFollowBatchState() {
		followLoadController?.abort();
		followLoadController = null;
		followsSubject = null;
		follows = [];
		excludedFollowDids = new Set();
		followFilter = '';
		showFollowEditor = false;
		batchItems = [];
		batchDownloading = false;
		resetBatchProgress();
	}

	function toggleFollow(did: string) {
		const next = new Set(excludedFollowDids);
		if (next.has(did)) next.delete(did);
		else next.add(did);
		excludedFollowDids = next;
	}

	function selectAllFollows() {
		excludedFollowDids = new Set();
	}

	function clearAllFollows() {
		excludedFollowDids = new Set(follows.map((follow) => follow.did));
	}

	function batchProcessedCount(value: BatchProgress = batchProgress): number {
		return value.done + value.failed + value.skipped;
	}

	function buildBatchProgressDetail(value: BatchProgress = batchProgress): string {
		const parts = [`${value.active.toLocaleString()} active`];
		if (value.done > 0) parts.push(`${value.done.toLocaleString()} done`);
		if (value.skipped > 0) parts.push(`${value.skipped.toLocaleString()} already loaded`);
		if (value.failed > 0) parts.push(`${value.failed.toLocaleString()} failed`);
		if (value.rateLimitHits > 0) {
			parts.push(`${value.rateLimitHits.toLocaleString()} rate-limit backoff${value.rateLimitHits === 1 ? '' : 's'}`);
		}
		return parts.join(' · ');
	}

	function updateBatchProgress(patch: Partial<BatchProgress>) {
		const next = { ...batchProgress, ...patch };
		batchProgress = next;
		if (batchDownloading) {
			progress = {
				phase: 'Batch downloading follow repos...',
				current: batchProcessedCount(next),
				total: next.total,
				detail: buildBatchProgressDetail(next)
			};
		}
	}

	function updateBatchItem(did: string, patch: Partial<BatchRepoItem>) {
		batchItems = batchItems.map((item) => (item.did === did ? { ...item, ...patch } : item));
	}

	function buildBatchItem(follow: FollowProfileInfo): BatchRepoItem {
		const existingAccount = repoAccounts.find((account) => account.did === follow.did);
		return {
			...follow,
			status: existingAccount ? 'done' : 'pending',
			detail: existingAccount ? 'Already loaded' : '',
			error: null,
			retries: 0,
			downloadedBytes: existingAccount?.downloadedBytes ?? 0,
			threadCount: existingAccount?.stats.threadsWithSelfReplies ?? 0
		};
	}

	function batchItemStatusLabel(status: BatchRepoStatus): string {
		if (status === 'done') return 'Done';
		if (status === 'failed') return 'Failed';
		if (status === 'downloading') return 'Downloading';
		if (status === 'parsing') return 'Parsing';
		if (status === 'building') return 'Building';
		if (status === 'waiting') return 'Waiting';
		return 'Pending';
	}

	function isRateLimitError(value: unknown): boolean {
		const status = Number((value as { status?: number })?.status);
		const message = value instanceof Error ? value.message : String(value ?? '');
		return status === 429 || /\b429\b|rate.?limit|too many requests/i.test(message);
	}

	function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
		if (ms <= 0) return Promise.resolve();
		if (signal.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));

		return new Promise((resolve, reject) => {
			const timeout = window.setTimeout(() => {
				signal.removeEventListener('abort', abort);
				resolve();
			}, ms);
			const abort = () => {
				window.clearTimeout(timeout);
				reject(new DOMException('Aborted', 'AbortError'));
			};
			signal.addEventListener('abort', abort, { once: true });
		});
	}

	async function loadFollowsForBatch() {
		if (loadingFollows || batchDownloading) return;
		let profile = selectedProfile;
		try {
			if (!profile) {
				const handle = normalizeHandle(initialHandle);
				if (!handle) {
					toastInfo('Load a Bluesky account first.');
					return;
				}
				profile = await getProfile(handle);
				await handleProfileSelected(profile);
			}
		} catch (err) {
			const message = err instanceof Error ? err.message : 'Could not load the selected profile.';
			error = message;
			toastError(message);
			return;
		}

		followLoadController?.abort();
		const controller = new AbortController();
		followLoadController = controller;
		loadingFollows = true;
		error = null;
		follows = [];
		excludedFollowDids = new Set();
		followFilter = '';
		batchItems = [];
		resetBatchProgress();
		followsSubject = profile;

		try {
			const collected: FollowProfileInfo[] = [];
			let cursor: string | undefined;
			for (let page = 0; page < MAX_FOLLOW_PAGES; page += 1) {
				const res = await getFollowsPage(profile.did, {
					cursor,
					limit: 100,
					signal: controller.signal
				});
				collected.push(...res.follows);
				cursor = res.cursor;
				if (!cursor) break;
			}
			follows = collected;
			showFollowEditor = true;
			if (collected.length === 0) {
				toastInfo(`@${profile.handle} does not follow anyone.`);
			}
		} catch (err: any) {
			if (err?.name !== 'AbortError') {
				const message = err?.message || 'Failed to load follows.';
				error = message;
				toastError(message);
			}
		} finally {
			if (followLoadController === controller) {
				followLoadController = null;
			}
			loadingFollows = false;
		}
	}

	function buildCurrentEngagementSummary(): { hydratedCount: number; missingCount: number } {
		const hydratedCount = Object.keys(engagementCountsByUri).length;
		if (hydratedCount === 0) return { hydratedCount: 0, missingCount: 0 };
		return {
			hydratedCount,
			missingCount: Math.max(0, countUniqueThreadPostUris(allThreads) - hydratedCount)
		};
	}

	async function loadFollowRepoForBatch(
		follow: FollowProfileInfo,
		searchJob: number,
		signal: AbortSignal,
		waitForDownloadSlot: () => Promise<void>
	) {
		const authorInfo: AuthorInfo = {
			did: follow.did,
			handle: follow.handle,
			displayName: follow.displayName,
			avatar: follow.avatar
		};
		let latestDownloadedBytes = 0;
		let repo: RepoFeedLoadResult | null = null;

		for (let attempt = 0; attempt <= BATCH_RATE_LIMIT_RETRIES; attempt += 1) {
			updateBatchItem(follow.did, {
				status: 'waiting',
				detail: attempt > 0 ? `Retry ${attempt} queued` : 'Queued',
				retries: attempt
			});
			await waitForDownloadSlot();
			if (signal.aborted || searchJob !== activeSearchJob) {
				throw new DOMException('Aborted', 'AbortError');
			}

			try {
				updateBatchItem(follow.did, {
					status: 'downloading',
					detail: attempt > 0 ? `Retry ${attempt}` : 'Starting download'
				});
				repo = await loadRepoFeedItems(follow.did, authorInfo, {
					signal,
					onDownloadProgress: (downloadProgress) => {
						latestDownloadedBytes = downloadProgress.receivedBytes;
						updateBatchItem(follow.did, {
							status: 'downloading',
							detail: buildRepoDownloadDetail(downloadProgress),
							downloadedBytes: downloadProgress.receivedBytes
						});
					},
					onParseProgress: (count) => {
						updateBatchItem(follow.did, {
							status: 'parsing',
							detail: buildRepoParseDetail(count, latestDownloadedBytes)
						});
					}
				});
				break;
			} catch (err: any) {
				if (err?.name === 'AbortError' || signal.aborted || searchJob !== activeSearchJob) {
					throw err;
				}
				if (isRateLimitError(err) && attempt < BATCH_RATE_LIMIT_RETRIES) {
					updateBatchProgress({ rateLimitHits: batchProgress.rateLimitHits + 1 });
					const backoffMs = BATCH_RATE_LIMIT_BACKOFF_MS * (attempt + 1);
					updateBatchItem(follow.did, {
						status: 'waiting',
						detail: `Rate limited; retrying in ${formatDuration(backoffMs)}`,
						retries: attempt + 1
					});
					await abortableSleep(backoffMs, signal);
					continue;
				}
				throw err;
			}
		}

		if (!repo) {
			throw new Error('Repository download did not complete.');
		}

		updateBatchItem(follow.did, {
			status: 'building',
			detail: `${repo.totalPosts.toLocaleString()} posts ready`
		});

		const { stats: accountThreadStats } = applyThreadsFromFeed(repo.feedItems, follow.did, {
			reportProgress: false,
			announce: false,
			applyMode: 'replace-account',
			updateStats: false
		});
		const account = createLoadedRepoAccount(authorInfo, repo, accountThreadStats);
		applyRepoAccounts(upsertRepoAccount(account), buildCurrentEngagementSummary());
		updateBatchItem(follow.did, {
			status: 'done',
			detail: `${accountThreadStats.threadsWithSelfReplies.toLocaleString()} self-reply thread${accountThreadStats.threadsWithSelfReplies !== 1 ? 's' : ''}`,
			error: null,
			downloadedBytes: repo.downloadedBytes,
			threadCount: accountThreadStats.threadsWithSelfReplies
		});
	}

	async function runFollowBatchDownload() {
		if (batchDownloading || loadingFollows) return;
		if (activeFollows.length === 0) {
			toastInfo('Select at least one follow to download.');
			return;
		}

		const targets = activeFollows.filter((follow) => !loadedRepoDids.has(follow.did));
		const skipped = activeFollows.length - targets.length;
		if (targets.length === 0) {
			batchItems = activeFollows.map(buildBatchItem);
			batchProgress = {
				done: 0,
				total: activeFollows.length,
				active: 0,
				failed: 0,
				skipped,
				rateLimitHits: 0
			};
			toastInfo('Selected follow repos are already loaded.');
			return;
		}

		const searchJob = ++activeSearchJob;
		const controller = new AbortController();
		abortController?.abort();
		abortController = controller;
		engagementHydrationController?.abort();
		engagementHydrationController = null;
		engagementHydrationContext = null;
		cachedRepoFeedItems = null;
		cachedHydrationFeedItems = null;
		cachedEngagementDid = null;
		engagementTargetPostCount = countUniqueThreadPostUris(allThreads);
		engagementHydrationProgress = {
			current: Object.keys(engagementCountsByUri).length,
			total: engagementTargetPostCount
		};
		engagementHydrationState = Object.keys(engagementCountsByUri).length > 0 ? 'partial' : 'idle';
		loading = true;
		batchDownloading = true;
		error = null;
		hasSearched = true;
		showExpanded = false;
		expandedThread = null;
		showBlogReader = false;
		blogThread = null;
		blogLoadingFullThread = false;
		activeBlogJob += 1;
		expandedLoading = false;
		batchItems = activeFollows.map(buildBatchItem);
		updateBatchProgress({
			done: 0,
			total: activeFollows.length,
			active: 0,
			failed: 0,
			skipped,
			rateLimitHits: 0
		});

		let nextTargetIndex = 0;
		let nextStartAt = 0;
		const workerCount = Math.min(normalizeBatchConcurrency(batchConcurrency), targets.length);
		const waitForDownloadSlot = async () => {
			const delayMs = normalizeBatchStartDelayMs(batchStartDelayMs);
			const now = Date.now();
			const startAt = Math.max(now, nextStartAt);
			nextStartAt = startAt + delayMs;
			await abortableSleep(Math.max(0, startAt - now), controller.signal);
		};

		const worker = async () => {
			while (nextTargetIndex < targets.length && !controller.signal.aborted) {
				const follow = targets[nextTargetIndex];
				nextTargetIndex += 1;
				updateBatchProgress({ active: batchProgress.active + 1 });
				try {
					await loadFollowRepoForBatch(follow, searchJob, controller.signal, waitForDownloadSlot);
					updateBatchProgress({ done: batchProgress.done + 1 });
				} catch (err: any) {
					if (err?.name === 'AbortError' || controller.signal.aborted || searchJob !== activeSearchJob) {
						updateBatchItem(follow.did, {
							status: 'pending',
							detail: 'Canceled',
							error: null
						});
						return;
					}
					updateBatchItem(follow.did, {
						status: 'failed',
						detail: '',
						error: err?.message || 'Download failed.'
					});
					updateBatchProgress({ failed: batchProgress.failed + 1 });
				} finally {
					updateBatchProgress({ active: Math.max(0, batchProgress.active - 1) });
				}
			}
		};

		try {
			await Promise.all(Array.from({ length: workerCount }, () => worker()));
			if (!controller.signal.aborted && searchJob === activeSearchJob) {
				refreshDisplayedThreadsNow(allThreads);
				if (batchProgress.failed > 0) {
					toastInfo(
						`Loaded ${batchProgress.done.toLocaleString()} follow repo${batchProgress.done === 1 ? '' : 's'}; ${batchProgress.failed.toLocaleString()} failed.`
					);
				} else {
					toastSuccess(
						`Loaded ${batchProgress.done.toLocaleString()} follow repo${batchProgress.done === 1 ? '' : 's'}.`
					);
				}
			}
		} finally {
			if (abortController === controller) {
				abortController = null;
			}
			if (searchJob === activeSearchJob) {
				loading = false;
				batchDownloading = false;
				progress = {
					phase: 'Batch download complete',
					current: batchProcessedCount(),
					total: batchProgress.total,
					detail: buildBatchProgressDetail()
				};
				saveViewer2MemoryCache();
			}
		}
	}

	function applyThreadsFromFeed(
		feedItems: any[],
		did: string,
		options: {
			reportProgress?: boolean;
			announce?: boolean;
			applyMode?: 'replace' | 'replace-account' | 'none';
			updateStats?: boolean;
		} = {}
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

		const applyMode = options.applyMode ?? 'replace';
		if (applyMode === 'replace') {
			allThreads = threads;
		} else if (applyMode === 'replace-account') {
			allThreads = replaceThreadsForAccount(allThreads, did, threads);
		}
		if (options.updateStats ?? true) {
			stats = nextStats;
		}

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

	function prepareEngagementHydration(
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

		engagementHydrationState = engagementAttemptedPostUris.size > 0 ? 'paused' : 'idle';
	}

	function startEngagementHydration() {
		if (!engagementHydrationContext || engagementHydrationState === 'running') return;
		void runEngagementHydration();
	}

	// --- Parent post fetching (replies/mentions to other users) ---
	// The loaded repo only contains the account's own posts. When a thread root is a
	// reply to *someone else* (e.g. a mention), its parent isn't in the repo. These
	// helpers fetch those parents on demand so they render inline in the reader.
	let parentFetchState = $state<'idle' | 'running'>('idle');
	let parentFetchProgress = $state({ current: 0, total: 0 });
	let parentFetchController: AbortController | null = null;

	const fetchedParentCount = $derived(Object.keys($parentPostsByUri).length);

	// Parent URIs that point to posts NOT in the loaded repo (i.e. by other users).
	function externalParentUris(threads: SelfReplyThread[]): string[] {
		const ownUris = new Set<string>();
		for (const thread of threads) collectThreadPostUris(thread.rootPost, ownUris);
		// Also exclude posts owned by any loaded account so self-replies aren't refetched.
		return collectParentUris(threads.map((thread) => thread.rootPost)).filter(
			(uri) => !ownUris.has(uri)
		);
	}

	const filteredParentCandidateCount = $derived(externalParentUris(displayedThreads).length);

	async function runParentFetch(threads: SelfReplyThread[], label: string) {
		if (parentFetchState === 'running') return;
		const uris = externalParentUris(threads);
		if (uris.length === 0) {
			toastInfo('No external parent posts to fetch here.');
			return;
		}

		parentFetchController?.abort();
		const controller = new AbortController();
		parentFetchController = controller;
		parentFetchState = 'running';
		parentFetchProgress = { current: 0, total: uris.length };

		try {
			const resolved = await fetchParentPosts(uris, {
				signal: controller.signal,
				onProgress: (completed, total) => {
					if (controller.signal.aborted) return;
					parentFetchProgress = { current: completed, total: total || uris.length };
				}
			});
			if (!controller.signal.aborted) {
				toastSuccess(
					`Fetched ${resolved.toLocaleString()} parent post${resolved === 1 ? '' : 's'} (${label}).`
				);
			}
		} catch (err: any) {
			if (err?.name !== 'AbortError' && !controller.signal.aborted) {
				toastError(err?.message || 'Failed to fetch parent posts.');
			}
		} finally {
			if (parentFetchController === controller) parentFetchController = null;
			parentFetchState = 'idle';
		}
	}

	function fetchParentsForFiltered() {
		void runParentFetch(displayedThreads, 'filtered');
	}

	function fetchParentsForAll() {
		void runParentFetch(allThreads, 'all');
	}

	// Flatten a fetched conversation tree (all participants) into pre-order reading order.
	function flattenConversation(root: ThreadPost): ThreadPost[] {
		const out: ThreadPost[] = [];
		const walk = (post: ThreadPost) => {
			out.push(post);
			for (const child of post.children) walk(child);
		};
		walk(root);
		return out;
	}

	// Short label shown as a divider above each source thread's posts in the reader.
	function threadGroupLabel(thread: SelfReplyThread): string {
		const handle = thread.rootPost.author.handle;
		const text = (thread.rootPost.text || '').replace(/\s+/g, ' ').trim();
		const snippet = text.length > 80 ? `${text.slice(0, 80)}…` : text;
		return snippet ? `@${handle} · ${snippet}` : `@${handle}`;
	}

	function openWholeThreadReader() {
		if (browser) wholeThreadSavedScrollY = window.scrollY;
		showWholeThreadReader = true;
		showExpanded = false;
		showBlogReader = false;
		if (browser) requestAnimationFrame(() => window.scrollTo(0, 0));
	}

	function closeWholeThreadReader() {
		showWholeThreadReader = false;
		if (browser) requestAnimationFrame(() => window.scrollTo(0, wholeThreadSavedScrollY));
	}

	// Fetch the complete conversation for every thread in the list, then present every
	// post (all participants) as a flat, scrollable feed in the whole-thread reader.
	async function runWholeThreadFetch(threads: SelfReplyThread[], label: string) {
		if (wholeThreadFetching) return;
		if (threads.length === 0) {
			toastInfo('No threads to fetch here.');
			return;
		}

		wholeThreadController?.abort();
		const controller = new AbortController();
		wholeThreadController = controller;
		wholeThreadFetching = true;
		wholeThreadProgress = { current: 0, total: threads.length };

		const results: ({ root: ThreadPost; truncated: boolean } | null)[] = new Array(
			threads.length
		).fill(null);
		let completed = 0;
		let cursor = 0;
		const CONCURRENCY = 3;

		const worker = async () => {
			while (cursor < threads.length && !controller.signal.aborted) {
				const index = cursor++;
				try {
					const full = await getFullThread(threads[index].rootPost.uri);
					if (controller.signal.aborted) return;
					results[index] = { root: full.rootPost, truncated: full.isTruncated };
				} catch (err: any) {
					if (err?.name === 'AbortError' || controller.signal.aborted) return;
				} finally {
					completed += 1;
					if (!controller.signal.aborted) {
						wholeThreadProgress = { current: completed, total: threads.length };
					}
				}
			}
		};

		try {
			await Promise.all(Array.from({ length: Math.min(CONCURRENCY, threads.length) }, worker));
			if (controller.signal.aborted) return;

			// Assemble a flat, deduped list grouped by source thread (display order),
			// each thread's posts in conversation reading order.
			const items: WholeThreadReaderItem[] = [];
			const seen = new Set<string>();
			let truncatedAny = false;
			for (let i = 0; i < threads.length; i++) {
				const result = results[i];
				if (!result) continue;
				if (result.truncated) truncatedAny = true;
				let firstOfGroup = true;
				for (const post of flattenConversation(result.root)) {
					if (seen.has(post.uri)) continue;
					seen.add(post.uri);
					items.push({
						post,
						threadStart: firstOfGroup,
						threadLabel: firstOfGroup ? threadGroupLabel(threads[i]) : undefined
					});
					firstOfGroup = false;
				}
			}

			if (items.length === 0) {
				toastInfo('Could not fetch any posts for these threads.');
				return;
			}

			wholeThreadItems = items;
			wholeThreadTruncated = truncatedAny;
			wholeThreadSourceLabel = label;
			openWholeThreadReader();
			toastSuccess(
				`Loaded ${items.length.toLocaleString()} post${items.length === 1 ? '' : 's'} from ${threads.length.toLocaleString()} thread${threads.length === 1 ? '' : 's'} (${label}).`
			);
		} catch (err: any) {
			if (err?.name !== 'AbortError' && !controller.signal.aborted) {
				toastError(err?.message || 'Failed to fetch whole threads.');
			}
		} finally {
			if (wholeThreadController === controller) wholeThreadController = null;
			wholeThreadFetching = false;
		}
	}

	function fetchWholeThreadsForFiltered() {
		void runWholeThreadFetch(displayedThreads, 'filtered');
	}

	function fetchWholeThreadsForAll() {
		void runWholeThreadFetch(sortedThreads, 'all');
	}

	// Switch the gallery source. The first time reposts (or Both) are requested we fetch
	// them; once loaded, toggling is instant.
	function setViewSource(next: ViewSource) {
		if (next === viewSource) return;
		if ((next === 'reposts' || next === 'both') && !repostsLoaded) {
			void fetchReposts(next);
			return;
		}
		viewSource = next;
	}

	// Download each loaded account's repo CAR, extract its reposts, hydrate the reposted
	// posts, and turn each into a single-post thread so the gallery can render them.
	async function fetchReposts(target: ViewSource = 'reposts') {
		if (repostsFetching) return;
		const accounts =
			repoAccounts.length > 0
				? repoAccounts.map((account) => ({ did: account.did, handle: account.handle }))
				: author
					? [{ did: author.did, handle: author.handle }]
					: [];
		if (accounts.length === 0) {
			toastInfo('Load an account first.');
			return;
		}

		repostsController?.abort();
		const controller = new AbortController();
		repostsController = controller;
		repostsFetching = true;
		repostsPhase = 'downloading';
		repostsProgress = { current: 0, total: 0 };

		const threads: SelfReplyThread[] = [];
		const seen = new Set<string>();
		let missingCount = 0;

		try {
			for (const account of accounts) {
				if (controller.signal.aborted) return;
				const result = await loadRepoReposts(account.did, {
					signal: controller.signal,
					onDownloadProgress: () => {
						repostsPhase = 'downloading';
					},
					onParseProgress: (count) => {
						repostsPhase = 'parsing';
						repostsProgress = { current: 0, total: count };
					},
					onHydrateProgress: ({ completed, total }) => {
						repostsPhase = 'hydrating';
						repostsProgress = { current: completed, total };
					}
				});
				if (controller.signal.aborted) return;

				for (const repost of result.reposts) {
					const post = result.posts.get(repost.subjectUri);
					if (!post) {
						missingCount += 1;
						continue;
					}
					if (seen.has(post.uri)) continue;
					seen.add(post.uri);
					threads.push({ rootPost: post, depth: 1, rootUri: post.uri });
				}
			}

			if (controller.signal.aborted) return;

			repostThreads = threads;
			repostsMissingCount = missingCount;
			repostsLoaded = true;

			if (threads.length === 0) {
				toastInfo(
					missingCount > 0
						? 'Found reposts, but none of the reposted posts could be loaded.'
						: 'No reposts found in this repo.'
				);
				// "Both" can still show the thread list even with no reposts.
				if (target === 'both') viewSource = 'both';
				return;
			}

			viewSource = target;
			toastSuccess(
				`Loaded ${threads.length.toLocaleString()} repost${threads.length === 1 ? '' : 's'}${missingCount > 0 ? ` (${missingCount.toLocaleString()} unavailable)` : ''}.`
			);
		} catch (err: any) {
			if (err?.name !== 'AbortError' && !controller.signal.aborted) {
				toastError(err?.message || 'Failed to fetch reposts.');
			}
		} finally {
			if (repostsController === controller) repostsController = null;
			repostsFetching = false;
			repostsPhase = 'idle';
			repostsProgress = { current: 0, total: 0 };
		}
	}

	const repostsProgressLabel = $derived.by(() => {
		if (repostsPhase === 'downloading') return 'Downloading repo…';
		if (repostsPhase === 'parsing') return 'Reading reposts…';
		if (repostsProgress.total > 0) {
			return `Hydrating reposts ${repostsProgress.current.toLocaleString()}/${repostsProgress.total.toLocaleString()}…`;
		}
		return 'Fetching reposts…';
	});

	// --- Timeline viewer (date-range selector + selective hydration) ---
	let timelineHydrating = $state(false);
	let timelineHydrationProgress = $state({ current: 0, total: 0 });
	let timelineHydrationController: AbortController | null = null;
	let showTimeline = $state(true);

	function msToDateInput(ms: number): string {
		const d = new Date(ms);
		const y = d.getFullYear();
		const m = String(d.getMonth() + 1).padStart(2, '0');
		const day = String(d.getDate()).padStart(2, '0');
		return `${y}-${m}-${day}`;
	}

	// Clicking a point on the timeline opens that post: expand its thread in-app if we
	// have it, otherwise open it on Bluesky.
	function handleTimelineOpenPost(uri: string, handle: string) {
		const thread = findThreadForUri(uri);
		if (thread) {
			flashHighlightedThread(thread.rootUri);
			void handleExpand(thread.rootUri);
			return;
		}
		const url = buildBskyPostUrl(uri, handle);
		if (browser && url) window.open(url, '_blank', 'noopener');
	}

	// Selecting a range on the timeline drives the existing date filter.
	function handleTimelineSelect(fromMs: number | null, toMs: number | null) {
		if (fromMs == null || toMs == null) {
			dateFrom = '';
			dateTo = '';
			return;
		}
		dateFrom = msToDateInput(fromMs);
		dateTo = msToDateInput(toMs);
	}

	function feedItemCreatedMs(item: any): number {
		const raw = item?.post?.record?.createdAt ?? item?.post?.indexedAt ?? '';
		const parsed = Date.parse(raw);
		return Number.isFinite(parsed) ? parsed : NaN;
	}

	async function hydrateTimelineRange(fromMs: number, toMs: number) {
		if (timelineHydrating) return;
		const source = cachedRepoFeedItems ?? [];
		if (source.length === 0) {
			toastInfo('No posts available to hydrate yet.');
			return;
		}
		const items = source.filter((item) => {
			const uri = feedItemUri(item);
			if (!uri || engagementCountsByUri[uri]) return false;
			const created = feedItemCreatedMs(item);
			return Number.isFinite(created) && created >= fromMs && created <= toMs;
		});
		if (items.length === 0) {
			toastInfo('No un-hydrated posts in the selected range.');
			return;
		}

		timelineHydrationController?.abort();
		const controller = new AbortController();
		timelineHydrationController = controller;
		timelineHydrating = true;
		timelineHydrationProgress = { current: 0, total: items.length };

		try {
			await hydrateFeedItemsEngagement(items, {
				signal: controller.signal,
				concurrency: ENGAGEMENT_HYDRATION_CONCURRENCY,
				onProgress: ({ completed, total }) => {
					if (controller.signal.aborted) return;
					timelineHydrationProgress = { current: completed, total: total || items.length };
				}
			});
			if (controller.signal.aborted) return;

			const counts = collectEngagementCountsFromFeedItems(items);
			for (const uri of Object.keys(counts)) {
				engagementAttemptedPostUris.add(uri);
			}
			engagementCountsByUri = { ...engagementCountsByUri, ...counts };
			engagementHydratedCount = Object.keys(engagementCountsByUri).length;
			repoStats = {
				...repoStats,
				hydratedCount: engagementHydratedCount,
				missingCount: Math.max(0, engagementAttemptedPostUris.size - engagementHydratedCount)
			};
			// Apply to the master thread list so sorting (which derives from allThreads) sees the counts.
			allThreads = applyEngagementCountsToThreadList(allThreads, counts);
			applyEngagementCountsToActiveViews(counts);
			flushViewer2MemoryCacheSave();
			toastSuccess(
				`Hydrated ${Object.keys(counts).length.toLocaleString()} post${Object.keys(counts).length !== 1 ? 's' : ''}`
			);
		} catch (err: any) {
			if (err?.name !== 'AbortError' && !controller.signal.aborted) {
				toastError(err?.message || 'Failed to hydrate the selected range.');
			}
		} finally {
			if (timelineHydrationController === controller) {
				timelineHydrationController = null;
			}
			timelineHydrating = false;
		}
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

	async function runEngagementHydration() {
		const context = engagementHydrationContext;
		if (!context || context.searchJob !== activeSearchJob || engagementHydrationController) return;

		const controller = new AbortController();
		engagementHydrationController = controller;
		engagementHydrationState = 'running';

		const isStale = () =>
			context.searchJob !== activeSearchJob ||
			engagementHydrationContext !== context ||
			controller.signal.aborted;

		try {
			// Thread-first pass over the full pending feed: one getPostThread call
			// covers a whole thread, versus 25 posts per getPosts call. Running it
			// per-chunk barely ever triggers because threads get split across chunks.
			const pendingAll = context.hydrationFeedItems.filter((item) => {
				const uri = feedItemUri(item);
				return uri !== null && !engagementAttemptedPostUris.has(uri);
			});
			if (pendingAll.length > 0) {
				const attemptedBeforeThreads = engagementAttemptedPostUris.size;
				const { hydratedUris } = await hydrateFeedItemsThreadEngagement(pendingAll, {
					signal: controller.signal,
					threadConcurrency: ENGAGEMENT_THREAD_CONCURRENCY,
					onProgress: ({ completed }) => {
						if (isStale()) return;
						engagementHydrationProgress = {
							current: Math.min(context.total, attemptedBeforeThreads + completed),
							total: context.total
						};
					}
				});
				if (isStale()) return;

				if (hydratedUris.size > 0) {
					const hydratedItems = pendingAll.filter((item) => {
						const uri = feedItemUri(item);
						return uri !== null && hydratedUris.has(uri);
					});
					for (const uri of hydratedUris) {
						engagementAttemptedPostUris.add(uri);
					}
					const threadCounts = collectEngagementCountsFromFeedItems(hydratedItems);
					Object.assign(engagementCountsByUri, threadCounts);
					engagementHydratedCount += hydratedUris.size;
					repoStats = {
						...repoStats,
						hydratedCount: engagementHydratedCount,
						missingCount: Math.max(0, engagementAttemptedPostUris.size - engagementHydratedCount)
					};
					engagementHydrationProgress = {
						current: engagementAttemptedPostUris.size,
						total: context.total
					};
					applyEngagementCountsToActiveViews(threadCounts);
					scheduleViewer2MemoryCacheSave();
				}
			}

			while (true) {
				if (isStale()) {
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
					concurrency: ENGAGEMENT_HYDRATION_CONCURRENCY,
					// Thread candidates were already fetched in the full-feed pass above.
					minThreadFetchPosts: Number.POSITIVE_INFINITY,
					onProgress: ({ completed }) => {
						if (isStale()) return;
						engagementHydrationProgress = {
							current: Math.min(context.total, alreadyAttempted + completed),
							total: context.total
						};
					}
				});

				if (isStale()) {
					return;
				}

				for (const uri of chunkUris) {
					engagementAttemptedPostUris.add(uri);
				}
				const chunkCounts = collectEngagementCountsFromFeedItems(chunk);
				Object.assign(engagementCountsByUri, chunkCounts);
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
				applyEngagementCountsToActiveViews(chunkCounts);
				scheduleViewer2MemoryCacheSave();

				await new Promise<void>((resolve) => setTimeout(resolve, 0));
			}

			if (isStale()) {
				return;
			}

			applyThreadsFromFeed(context.sourceFeedItems, context.did, {
				applyMode: repoAccounts.length > 1 ? 'replace-account' : 'replace',
				updateStats: false
			});
			refreshDisplayedThreadsNow(allThreads);
			engagementHydrationState = repoStats.missingCount > 0 ? 'partial' : 'done';
			engagementHydrationProgress = { current: context.total, total: context.total };
			if (threadSortMode === 'liked' || threadSortMode === 'reposted' || threadSortMode === 'quoted') {
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
		options: { profile?: ProfileInfo | null; threadUrl?: string | null; append?: boolean } = {}
	): Promise<boolean> {
		const cleaned = normalizeHandle(handle);
		if (!cleaned || loading) return false;
		const appendMode = options.append === true && repoAccounts.length > 0;

		const searchJob = ++activeSearchJob;
		engagementHydrationController?.abort();
		engagementHydrationController = null;
		engagementHydrationContext = null;
		engagementAttemptedPostUris = new Set();
		engagementHydratedCount = appendMode ? Object.keys(engagementCountsByUri).length : 0;
		if (!appendMode) {
			engagementCountsByUri = {};
		}
		engagementTargetPostCount = appendMode ? countUniqueThreadPostUris(allThreads) : 0;
		cachedRepoFeedItems = null;
		cachedHydrationFeedItems = null;
		cachedEngagementDid = null;
		engagementHydrationState = appendMode && engagementHydratedCount > 0 ? 'partial' : 'idle';
		engagementHydrationProgress = appendMode
			? { current: engagementHydratedCount, total: engagementTargetPostCount }
			: { current: 0, total: 0 };
		loading = true;
		error = null;
		if (!appendMode) {
			allThreads = [];
			repoAccounts = [];
			resetFollowBatchState();
			resetParentPosts();
			parentFetchController?.abort();
			parentFetchController = null;
			parentFetchState = 'idle';
			parentFetchProgress = { current: 0, total: 0 };
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
			showAddAccount = false;
			additionalHandle = '';
			additionalProfile = null;
			wholeThreadController?.abort();
			wholeThreadController = null;
			wholeThreadFetching = false;
			wholeThreadItems = [];
			wholeThreadTruncated = false;
			wholeThreadSourceLabel = '';
			showWholeThreadReader = false;
			repostsController?.abort();
			repostsController = null;
			repostsFetching = false;
			repostsPhase = 'idle';
			repostThreads = [];
			repostsLoaded = false;
			repostsMissingCount = 0;
			viewSource = 'threads';
		}
		hasSearched = true;
		if (!appendMode) {
			stats = { postsScanned: 0, chainStarts: 0, threadsWithSelfReplies: 0 };
			repoStats = {
				totalPosts: 0,
				elapsedMs: 0,
				downloadedBytes: 0,
				source: null,
				hydratedCount: 0,
				missingCount: 0
			};
		}

		const controller = new AbortController();
		abortController = controller;

		const requestedThreadUrl = options.threadUrl ? normalizeBskyPostUrl(options.threadUrl) : null;
		if (!appendMode) {
			updateRouteState({ handle: cleaned, threadUrl: requestedThreadUrl });
		}

		let success = false;

		try {
			let profile = options.profile;
			if (!profile || (normalizeHandle(profile.handle) !== cleaned && profile.did !== cleaned)) {
				profile = await getProfile(cleaned);
			}

			if (!profile) throw new Error('Profile is not available.');
			if (appendMode && repoAccounts.some((account) => account.did === profile.did)) {
				toastInfo(`@${profile.handle} is already loaded.`);
				return false;
			}

			if (!appendMode || !selectedProfile) {
				await handleProfileSelected(profile);
			}

			if (!appendMode) {
				updateRouteState({ handle: profile.handle, threadUrl: requestedThreadUrl });
			}

			const did = profile.did;
			const authorInfo: AuthorInfo = {
				did: profile.did,
				handle: profile.handle,
				displayName: profile.displayName,
				avatar: profile.avatar
			};
			let latestDownloadedBytes = 0;
			const downloadPhase = appendMode
				? `Downloading repository for @${profile.handle}...`
				: 'Downloading repository...';
			const parsePhase = appendMode
				? `Parsing repository for @${profile.handle}...`
				: 'Parsing repository posts...';
			progress = { phase: downloadPhase, current: 0, total: 0 };
			const repo = await loadRepoFeedItems(did, authorInfo, {
				signal: controller.signal,
				onDownloadProgress: (downloadProgress) => {
					latestDownloadedBytes = downloadProgress.receivedBytes;
					progress =
						downloadProgress.totalBytes > 0
							? {
									phase: downloadPhase,
									current: Math.round(
										(downloadProgress.receivedBytes / downloadProgress.totalBytes) * 100
									),
									total: 100,
									detail: buildRepoDownloadDetail(downloadProgress)
								}
							: {
									phase: downloadPhase,
									current: 0,
									total: 0,
									detail: buildRepoDownloadDetail(downloadProgress)
								};
				},
				onParseProgress: (count) => {
					progress = {
						phase: parsePhase,
						current: 0,
						total: 0,
						detail: buildRepoParseDetail(count, latestDownloadedBytes)
					};
				}
			});

			progress = {
				phase: appendMode ? `Adding @${profile.handle} threads...` : 'Building threads...',
				current: 0,
				total: repo.feedItems.length,
				detail: `${repo.totalPosts.toLocaleString()} repository posts ready for thread discovery`
			};

			const { threads, stats: accountThreadStats } = applyThreadsFromFeed(repo.feedItems, did, {
				reportProgress: true,
				announce: true,
				applyMode: appendMode ? 'replace-account' : 'replace',
				updateStats: false
			});
			const account = createLoadedRepoAccount(authorInfo, repo, accountThreadStats);
			const nextAccounts = appendMode ? upsertRepoAccount(account) : [account];
			const hydratedUriCount = Object.keys(engagementCountsByUri).length;
			const engagement = appendMode && hydratedUriCount > 0
				? {
						hydratedCount: hydratedUriCount,
						missingCount: Math.max(0, countUniqueThreadPostUris(allThreads) - hydratedUriCount)
					}
				: { hydratedCount: 0, missingCount: 0 };
			applyRepoAccounts(nextAccounts, engagement);
			const hydrationFeedItems = selectThreadFeedItems(repo.feedItems, threads);
			if (appendMode) {
				engagementTargetPostCount = countUniqueThreadPostUris(allThreads);
				engagementHydrationProgress = {
					current: engagement.hydratedCount,
					total: engagementTargetPostCount
				};
				engagementHydrationState = engagement.hydratedCount > 0 ? 'partial' : 'idle';
			} else {
				prepareEngagementHydration(repo.feedItems, hydrationFeedItems, did, searchJob, { reset: true });
			}
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
		const wasMedia = galleryContentMode !== 'all';
		const isMedia = mode !== 'all';
		galleryContentMode = mode;
		try { localStorage.setItem('preferred-gallery-content-mode', mode); } catch {}

		// Media tabs (media/photos/movies) default to Fit + Masonry + Posts; All stays
		// on Threads grouping. Only apply on crossing the all↔media boundary so manual
		// tweaks are preserved when switching between media sub-modes.
		if (isMedia && !wasMedia) {
			setGalleryMediaFit('fit');
			setGalleryMediaLayout('masonry');
			setGalleryGroupMode('posts');
		} else if (!isMedia && wasMedia) {
			setGalleryGroupMode('threads');
		}
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
		return (
			value === 'depth' ||
			value === 'newest' ||
			value === 'oldest' ||
			value === 'liked' ||
			value === 'reposted' ||
			value === 'quoted'
		);
	}

	// Engagement-based sorts (liked/reposted/quoted) are only meaningful once engagement
	// counts have been hydrated. Until then only Highest chain / Newest / Oldest apply.
	// Reposts are hydrated with full engagement counts on fetch, so the sorts are always ready.
	const engagementSortReady = $derived(
		viewSource !== 'threads'
			? true
			: engagementHydrationState === 'done' ||
				engagementHydrationState === 'partial' ||
				Object.keys(engagementCountsByUri).length > 0
	);

	$effect(() => {
		if (
			!engagementSortReady &&
			(threadSortMode === 'liked' || threadSortMode === 'reposted' || threadSortMode === 'quoted')
		) {
			// Fall back to Highest chain without clobbering the saved preference.
			threadSortMode = 'depth';
		}
	});

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
		stopBlastMode();
		abortController?.abort();
		followLoadController?.abort();
		engagementHydrationController?.abort();
		wholeThreadController?.abort();
		repostsController?.abort();
		flushViewer2MemoryCacheSave();
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
				{#if hasSearched}
					<div class="add-account-panel">
						{#if showAddAccount}
							<SearchBar
							onsearch={(handle) => void handleAddAccountSearch(handle)}
							onprofile={handleAdditionalProfileSelected}
							onchange={handleAdditionalHandleChange}
							disabled={loading}
							initialHandle={additionalHandle}
							placeholder="Add another Bluesky user..."
							buttonLabel="Download Repo"
						/>
						<button
							type="button"
							class="add-account-cancel"
							disabled={loading}
							onclick={() => {
								showAddAccount = false;
								additionalHandle = '';
								additionalProfile = null;
							}}
						>
							Cancel
						</button>
					{:else}
						<button
							type="button"
							class="add-account-btn wobbly-border-light"
							disabled={loading}
							onclick={() => (showAddAccount = true)}
						>
							+ Add account repo
						</button>
						{/if}
					</div>
				{/if}
				{#if hasSearched && selectedProfile}
					<div class="follow-batch-panel wobbly-border-light">
						<div class="follow-batch-head">
							<div class="follow-batch-title">
								<strong>Follow repos</strong>
								<span>@{(followsSubject ?? selectedProfile).handle}</span>
							</div>
							<div class="follow-batch-actions">
								<button
									type="button"
									class="mini-action-btn"
									disabled={loadingFollows || batchDownloading || loading}
									onclick={loadFollowsForBatch}
								>
									{#if loadingFollows}
										Loading...
									{:else if follows.length > 0}
										Refresh
									{:else}
										Load follows
									{/if}
								</button>
								{#if follows.length > 0}
									<button
										type="button"
										class="mini-action-btn"
										disabled={batchDownloading}
										onclick={() => (showFollowEditor = !showFollowEditor)}
									>
										{showFollowEditor ? 'Done' : 'Edit list'}
									</button>
								{/if}
							</div>
						</div>

						{#if loadingFollows}
							<div class="follow-batch-status">Loading follows...</div>
						{/if}

						{#if follows.length > 0}
							<div class="follow-batch-summary">
								<span>{follows.length.toLocaleString()} follows</span>
								<span>{activeFollows.length.toLocaleString()} selected</span>
								<span>{downloadableActiveFollows.length.toLocaleString()} not loaded</span>
							</div>

							{#if showFollowEditor}
								<div class="follow-editor">
									<div class="follow-editor-toolbar">
										<input
											type="text"
											class="follow-filter"
											bind:value={followFilter}
											placeholder="Filter accounts..."
										/>
										<button type="button" class="mini-action-btn" disabled={batchDownloading} onclick={selectAllFollows}>All</button>
										<button type="button" class="mini-action-btn" disabled={batchDownloading} onclick={clearAllFollows}>None</button>
									</div>
									<ul class="follow-list">
										{#each filteredFollows as follow (follow.did)}
											{@const selected = !excludedFollowDids.has(follow.did)}
											{@const loaded = loadedRepoDids.has(follow.did)}
											<li class="follow-item" class:deselected={!selected}>
												<label class="follow-label">
													<input
														type="checkbox"
														checked={selected}
														disabled={batchDownloading}
														onchange={() => toggleFollow(follow.did)}
													/>
													{#if follow.avatar}
														<img class="follow-avatar" src={follow.avatar} alt={follow.handle} />
													{:else}
														<span class="follow-avatar follow-avatar-fallback">{follow.handle.slice(0, 1).toUpperCase()}</span>
													{/if}
													<span class="follow-names">
														{#if follow.displayName}
															<span class="follow-name">{follow.displayName}</span>
														{/if}
														<span class="follow-handle">@{follow.handle}</span>
													</span>
													{#if loaded}
														<span class="loaded-badge">Loaded</span>
													{/if}
												</label>
											</li>
										{/each}
										{#if filteredFollows.length === 0}
											<li class="follow-empty">No follows match "{followFilter}".</li>
										{/if}
									</ul>
								</div>
							{:else}
								<div class="follow-avatar-strip">
									{#each activeFollows.slice(0, 36) as follow (follow.did)}
										{#if follow.avatar}
											<img class="follow-avatar" src={follow.avatar} alt={follow.handle} title={'@' + follow.handle} />
										{:else}
											<span class="follow-avatar follow-avatar-fallback" title={'@' + follow.handle}>
												{follow.handle.slice(0, 1).toUpperCase()}
											</span>
										{/if}
									{/each}
									{#if activeFollows.length > 36}
										<span class="follow-avatar-more">+{(activeFollows.length - 36).toLocaleString()}</span>
									{/if}
								</div>
							{/if}

							<div class="batch-controls">
								<label>
									<span>Concurrent</span>
									<input
										type="number"
										min={BATCH_CONCURRENCY_MIN}
										max={BATCH_CONCURRENCY_MAX}
										step="1"
										value={batchConcurrency}
										disabled={batchDownloading}
										oninput={(event) => setBatchConcurrency(event.currentTarget.value)}
									/>
								</label>
								<label>
									<span>Start delay</span>
									<input
										type="number"
										min={BATCH_START_DELAY_MIN_MS}
										max={BATCH_START_DELAY_MAX_MS}
										step="250"
										value={batchStartDelayMs}
										disabled={batchDownloading}
										oninput={(event) => setBatchStartDelayMs(event.currentTarget.value)}
									/>
									<small>ms</small>
								</label>
								{#if batchDownloading}
									<button type="button" class="batch-download-btn" onclick={cancelFetch}>Cancel batch</button>
								{:else}
									<button
										type="button"
										class="batch-download-btn"
										disabled={loading || downloadableActiveFollows.length === 0}
										onclick={runFollowBatchDownload}
									>
										Download {downloadableActiveFollows.length.toLocaleString()} repo{downloadableActiveFollows.length === 1 ? '' : 's'}
									</button>
								{/if}
							</div>

							{#if batchProgress.total > 0}
								<div class="batch-status">
									<span>
										{batchProcessedCount().toLocaleString()} / {batchProgress.total.toLocaleString()} processed
									</span>
									{#if batchProgress.active > 0}
										<span>{batchProgress.active.toLocaleString()} active</span>
									{/if}
									{#if batchProgress.rateLimitHits > 0}
										<span>{batchProgress.rateLimitHits.toLocaleString()} rate-limit backoff{batchProgress.rateLimitHits === 1 ? '' : 's'}</span>
									{/if}
									{#if batchProgress.failed > 0}
										<span>{batchProgress.failed.toLocaleString()} failed</span>
									{/if}
								</div>
							{/if}

							{#if batchItems.length > 0}
								<ul class="batch-item-list">
									{#each batchItems as item (item.did)}
										<li class:failed={item.status === 'failed'} class:done={item.status === 'done'}>
											<span class="batch-item-name">@{item.handle}</span>
											<span class="batch-item-status">{batchItemStatusLabel(item.status)}</span>
											{#if item.detail}
												<span class="batch-item-detail">{item.detail}</span>
											{/if}
											{#if item.error}
												<span class="batch-item-error">{item.error}</span>
											{/if}
										</li>
									{/each}
								</ul>
							{/if}
						{/if}
					</div>
				{/if}
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

	{#if showWholeThreadReader}
		<WholeThreadReader
			items={wholeThreadItems}
			truncated={wholeThreadTruncated}
			sourceLabel={wholeThreadSourceLabel}
			onclose={closeWholeThreadReader}
		/>
	{/if}

	<div class="results-layer" class:results-layer--parked={detailIsOpen} aria-hidden={detailIsOpen}>
		{#if hasSearched}
			<section class="results-section">
				<div class="results-header">
					{#if repoAccounts.length > 0}
						<div class="author-list" class:author-list--multiple={repoAccounts.length > 1}>
							{#each repoAccounts as account (account.did)}
								<div class="author-chip">
									{#if account.avatar}
										<img src={account.avatar} alt="" class="author-avatar" />
									{:else}
										<div class="author-avatar placeholder"></div>
									{/if}
									<span>
										{account.displayName || account.handle}
										<span class="author-handle">@{account.handle}</span>
										{#if repoAccounts.length > 1}
											<span class="author-repo-count">
												{account.stats.threadsWithSelfReplies.toLocaleString()} thread{account.stats.threadsWithSelfReplies !== 1 ? 's' : ''}
											</span>
										{/if}
									</span>
								</div>
							{/each}
						</div>
					{:else if author}
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
								Downloaded {repoStats.totalPosts.toLocaleString()} posts{#if repoAccounts.length > 1}
									from {repoAccounts.length.toLocaleString()} repos
								{/if}
								in {(repoStats.elapsedMs / 1000).toFixed(1)}s
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
									{:else if engagementHydrationState === 'idle'}
										Engagement not hydrated
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
									<button type="button" class="engagement-control-btn" onclick={startEngagementHydration}>
										{engagementHydrationState === 'idle' ? 'Hydrate engagement' : 'Resume engagement'}
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

					{#if !loading}
						<div class="source-toggle-row wobbly-border-light">
							<span>Show</span>
							<div class="source-toggle" aria-label="Content source">
								<button
									type="button"
									class:active={viewSource === 'threads'}
									onclick={() => setViewSource('threads')}
								>
									Threads{allThreads.length > 0 ? ` (${allThreads.length.toLocaleString()})` : ''}
								</button>
								<button
									type="button"
									class:active={viewSource === 'reposts'}
									disabled={repostsFetching}
									onclick={() => setViewSource('reposts')}
									title="Every post this account has reposted"
								>
									🔁 Reposts{repostsLoaded ? ` (${repostThreads.length.toLocaleString()})` : ''}
								</button>
								<button
									type="button"
									class:active={viewSource === 'both'}
									disabled={repostsFetching}
									onclick={() => setViewSource('both')}
									title="Threads and reposts together"
								>
									Both{repostsLoaded ? ` (${(allThreads.length + repostThreads.length).toLocaleString()})` : ''}
								</button>
							</div>
							{#if repostsFetching}
								<span class="source-toggle-note">{repostsProgressLabel}</span>
							{:else if viewSource !== 'threads' && repostsMissingCount > 0}
								<span class="source-toggle-note" title="Deleted, blocked, or hidden reposted posts">
									{repostsMissingCount.toLocaleString()} unavailable
								</span>
							{/if}
						</div>
					{/if}

					{#if activeThreads.length > 0}
						{#if viewSource === 'threads'}
							<ThresholdControl bind:value={threshold} min={1} max={Math.max(maxDepth, 2)} />
						{/if}
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
									class:active={threadSortMode === 'newest'}
									onclick={() => setThreadSortMode('newest')}
								>
									Newest
								</button>
								<button
									type="button"
									class:active={threadSortMode === 'oldest'}
									onclick={() => setThreadSortMode('oldest')}
								>
									Oldest
								</button>
								{#if engagementSortReady}
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
								{/if}
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
						<div class="timeline-filter-row">
							<button
								type="button"
								class="timeline-toggle-btn"
								onclick={() => (showTimeline = !showTimeline)}
								aria-expanded={showTimeline}
							>
								{showTimeline ? '▾ Hide timeline' : '▸ Show timeline'}
							</button>
							<button
								type="button"
								class="timeline-toggle-btn blast-toggle"
								class:active={blastMode}
								disabled={!blastMode && displayedThreads.length === 0}
								onclick={toggleBlastMode}
								title="Blast the displayed posts across the screen"
							>
								🔥 Blast mode {blastMode ? 'on' : 'off'}
							</button>
							{#if blastMode}
								<div class="blast-controls">
									<label class="blast-slider">
										<span>Rate</span>
										<input type="range" min="0.5" max="8" step="0.5" bind:value={blastRate} />
										<strong>{blastRate}/s</strong>
									</label>
									<label class="blast-slider">
										<span>Burst</span>
										<input type="range" min="1" max="12" step="1" bind:value={blastBurstSize} />
										<strong>{blastBurstSize}</strong>
									</label>
									<label class="blast-slider">
										<span>Fly time</span>
										<input type="range" min="600" max="4000" step="100" bind:value={blastFlyMs} />
										<strong>{(blastFlyMs / 1000).toFixed(1)}s</strong>
									</label>
									<label class="blast-slider">
										<span>Size</span>
										<input type="range" min="30" max="300" step="10" bind:value={blastSizePct} />
										<strong>{blastSizePct}%</strong>
									</label>
								</div>
							{/if}
							{#if showTimeline}
								<TimelineViewer
									feedItems={cachedRepoFeedItems ?? []}
									{engagementCountsByUri}
									hydrating={timelineHydrating}
									hydrationProgress={timelineHydrationProgress}
									onhydrate={hydrateTimelineRange}
									onselect={handleTimelineSelect}
									onopenpost={handleTimelineOpenPost}
								/>
							{/if}
						</div>
						<p class="results-count">
							{displayedThreads.length}
							{#if renderMode === 'gallery' && galleryContentMode === 'images'}
								image {contentNoun}{displayedThreads.length !== 1 ? 's' : ''}
							{:else if renderMode === 'gallery' && galleryContentMode === 'media'}
								media {contentNoun}{displayedThreads.length !== 1 ? 's' : ''}
							{:else if renderMode === 'gallery' && galleryContentMode === 'movies'}
								movie {contentNoun}{displayedThreads.length !== 1 ? 's' : ''}
							{:else}
								{contentNoun}{displayedThreads.length !== 1 ? 's' : ''}
							{/if}
							{#if viewSource === 'threads'}with depth {threshold}+{/if}
							{#if isFilteringThreads}
								<span class="filtering-note">updating...</span>
							{/if}
						</p>
						{#if SHOW_FETCH_BUTTONS}
						<div class="parent-fetch-row">
							<span class="parent-fetch-label">
								Parent posts (replies/mentions to others):
								{#if fetchedParentCount > 0}
									<strong>{fetchedParentCount.toLocaleString()}</strong> fetched
								{/if}
							</span>
							<div class="parent-fetch-actions">
								<button
									type="button"
									class="parent-fetch-action"
									disabled={parentFetchState === 'running' || filteredParentCandidateCount === 0}
									onclick={fetchParentsForFiltered}
								>
									{#if parentFetchState === 'running'}
										Fetching {parentFetchProgress.current.toLocaleString()}/{parentFetchProgress.total.toLocaleString()}...
									{:else}
										Fetch parents (filtered{filteredParentCandidateCount > 0 ? ` · ${filteredParentCandidateCount.toLocaleString()}` : ''})
									{/if}
								</button>
								<button
									type="button"
									class="parent-fetch-action"
									disabled={parentFetchState === 'running'}
									onclick={fetchParentsForAll}
								>
									Fetch parents (all)
								</button>
								<button
									type="button"
									class="parent-fetch-action"
									disabled={wholeThreadFetching || displayedThreads.length === 0}
									onclick={fetchWholeThreadsForFiltered}
								>
									{#if wholeThreadFetching}
										Fetching threads {wholeThreadProgress.current.toLocaleString()}/{wholeThreadProgress.total.toLocaleString()}...
									{:else}
										Fetch whole threads (filtered{displayedThreads.length > 0 ? ` · ${displayedThreads.length.toLocaleString()}` : ''})
									{/if}
								</button>
								<button
									type="button"
									class="parent-fetch-action"
									disabled={wholeThreadFetching || allThreads.length === 0}
									onclick={fetchWholeThreadsForAll}
								>
									Fetch whole threads (all)
								</button>
								{#if wholeThreadItems.length > 0 && !showWholeThreadReader}
									<button
										type="button"
										class="parent-fetch-action"
										onclick={openWholeThreadReader}
									>
										Open reader ({wholeThreadItems.length.toLocaleString()})
									</button>
								{/if}
							</div>
						</div>
						{/if}
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
						showAuthor={viewSource !== 'threads' || repoAccounts.length > 1}
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
						{#if viewSource !== 'threads'}
							{#if activeThreads.length === 0}
								<p>No {viewSource === 'both' ? 'posts' : 'reposts'} found for this account.</p>
							{:else}
								<p>No {viewSource === 'both' ? 'posts' : 'reposts'} match the current filters.</p>
								<p class="empty-hint">
									{#if renderMode === 'gallery' && galleryContentMode !== 'all'}
										Try switching Gallery back to All or adjusting the date range.
									{:else}
										Try adjusting the search or date range.
									{/if}
								</p>
							{/if}
						{:else if activeThreads.length === 0}
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

{#if blastMode && blastCards.length > 0}
	<div class="blast-layer" aria-hidden="true" style="font-family: {fontFamily}">
		{#each blastCards as card (card.id)}
			<article
				class="blast-card"
				style={card.style}
				onanimationend={() => removeBlastCard(card.id)}
			>
				{#if card.media.length > 0}
					<div class="blast-media" class:pair={card.media.length > 1}>
						{#each card.media as media}
							<img src={media.src} alt="" style={`aspect-ratio: ${media.aspectRatio}`} />
						{/each}
					</div>
				{/if}
				{#if card.text}
					<p class="blast-text">{card.text}</p>
				{/if}
			</article>
		{/each}
	</div>
{/if}

<style>
	main {
		max-width: 800px;
		margin: 0 auto;
		padding: 32px 20px;
	}

	.timeline-filter-row {
		margin: 8px 0;
	}

	.blast-toggle.active {
		border-radius: 999px;
		background: color-mix(in srgb, #e25822 22%, transparent);
		opacity: 1;
	}

	.blast-toggle:disabled {
		cursor: not-allowed;
		opacity: 0.4;
	}

	.blast-controls {
		display: flex;
		flex-wrap: wrap;
		gap: 6px 14px;
		margin: 6px 0 2px;
	}

	.blast-slider {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font-size: 0.78rem;
		color: var(--muted, #888);
	}

	.blast-slider span {
		font-weight: 700;
	}

	.blast-slider input[type='range'] {
		width: 110px;
		accent-color: #e25822;
	}

	.blast-slider strong {
		min-width: 34px;
		color: var(--text-ink);
		font-size: 0.78rem;
	}

	.blast-layer {
		position: fixed;
		inset: 0;
		z-index: 950;
		overflow: hidden;
		pointer-events: none;
	}

	.blast-card {
		position: absolute;
		width: min(300px, 70vw);
		padding: 10px 14px;
		background: rgba(255, 252, 246, 0.97);
		border-radius: 10px;
		box-shadow: 0 8px 32px rgba(0, 0, 0, 0.45);
		transform: translate(-50%, -50%) scale(0.05);
		animation: blast-out var(--dur, 1800ms) cubic-bezier(0.3, 0.6, 0.6, 1) both;
		animation-delay: var(--delay, 0ms);
		will-change: transform, opacity;
	}

	@keyframes blast-out {
		0% {
			transform: translate(-50%, -50%) scale(0.05) rotate(0deg);
			opacity: 0;
		}
		12% {
			opacity: 1;
		}
		75% {
			opacity: 1;
		}
		100% {
			transform: translate(calc(-50% + var(--tx, 0px)), calc(-50% + var(--ty, 0px)))
				scale(var(--sc, 2.5)) rotate(var(--rot, 0deg));
			opacity: 0;
		}
	}

	.blast-media {
		display: grid;
		gap: 4px;
		margin-bottom: 6px;
	}

	.blast-media.pair {
		grid-template-columns: repeat(2, minmax(0, 1fr));
	}

	.blast-media img {
		display: block;
		width: 100%;
		max-height: 40vh;
		object-fit: cover;
		border-radius: 6px;
	}

	.blast-media:last-child {
		margin-bottom: 0;
	}

	.blast-text {
		margin: 0;
		font-size: 0.85rem;
		line-height: 1.45;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
		display: -webkit-box;
		-webkit-line-clamp: 6;
		line-clamp: 6;
		-webkit-box-orient: vertical;
		overflow: hidden;
	}

	.parent-fetch-row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px 12px;
		margin: 4px 0 10px;
		font-size: 0.82rem;
	}

	.parent-fetch-label {
		color: var(--muted, #888);
	}

	.parent-fetch-actions {
		display: flex;
		gap: 8px;
		flex-wrap: wrap;
	}

	.parent-fetch-action {
		padding: 4px 12px;
		font-size: 0.8rem;
		font-family: inherit;
		background: transparent;
		color: var(--accent);
		border: 1px solid var(--accent);
		border-radius: 999px;
		cursor: pointer;
	}

	.parent-fetch-action:hover:not(:disabled) {
		background: color-mix(in srgb, var(--accent) 12%, transparent);
	}

	.parent-fetch-action:disabled {
		opacity: 0.45;
		cursor: not-allowed;
	}

	.timeline-toggle-btn {
		padding: 3px 10px;
		font-size: 0.82rem;
		font-family: var(--font-hand);
		background: transparent;
		color: var(--text-ink);
		border: none;
		cursor: pointer;
		opacity: 0.8;
	}

	.timeline-toggle-btn:hover {
		opacity: 1;
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

	.add-account-panel {
		display: flex;
		justify-content: center;
		align-items: center;
		flex-wrap: wrap;
		gap: 10px;
		max-width: 680px;
		margin: 12px auto 0;
	}

	.add-account-panel :global(.search-bar) {
		flex: 1 1 520px;
		margin: 0;
	}

	.add-account-btn,
	.add-account-cancel {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-height: 34px;
		padding: 7px 13px;
		border-radius: 999px;
		background: var(--card-bg);
		color: var(--muted);
		border-color: var(--control-border);
		font: inherit;
		font-size: 0.86rem;
		font-weight: 700;
		cursor: pointer;
	}

	.add-account-btn:hover:not(:disabled),
	.add-account-cancel:hover:not(:disabled) {
		color: var(--accent);
		border-color: var(--accent);
	}

	.add-account-btn:disabled,
	.add-account-cancel:disabled {
		cursor: not-allowed;
		opacity: 0.55;
	}

	.follow-batch-panel {
		max-width: 760px;
		margin: 14px auto 0;
		padding: 12px 14px;
		background: var(--card-bg);
		color: var(--text-ink);
		border-color: var(--control-border);
		box-shadow: var(--shadow-soft);
		text-align: left;
	}

	.follow-batch-head,
	.follow-editor-toolbar,
	.batch-controls,
	.batch-status {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 8px;
	}

	.follow-batch-head {
		justify-content: space-between;
	}

	.follow-batch-title {
		display: flex;
		align-items: baseline;
		gap: 8px;
		min-width: 0;
	}

	.follow-batch-title span,
	.follow-batch-summary,
	.follow-batch-status {
		color: var(--muted);
		font-size: 0.86rem;
	}

	.follow-batch-actions {
		display: flex;
		align-items: center;
		gap: 8px;
		flex-wrap: wrap;
	}

	.mini-action-btn,
	.batch-download-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-height: 31px;
		padding: 6px 11px;
		border: 1px solid var(--control-border);
		border-radius: 999px;
		background: var(--control-bg);
		color: var(--text-ink);
		font: inherit;
		font-size: 0.8rem;
		font-weight: 700;
		line-height: 1.1;
		cursor: pointer;
	}

	.mini-action-btn:hover:not(:disabled),
	.batch-download-btn:hover:not(:disabled) {
		color: var(--accent);
		border-color: var(--accent);
	}

	.mini-action-btn:disabled,
	.batch-download-btn:disabled {
		cursor: not-allowed;
		opacity: 0.55;
	}

	.follow-batch-summary {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 8px;
		margin-top: 8px;
	}

	.follow-batch-summary span,
	.batch-status span {
		padding: 2px 8px;
		border: 1px solid var(--control-border);
		border-radius: 999px;
		background: color-mix(in srgb, var(--control-bg) 70%, transparent);
	}

	.follow-editor {
		margin-top: 10px;
		padding-top: 10px;
		border-top: 1px solid var(--control-border);
	}

	.follow-editor-toolbar {
		margin-bottom: 8px;
	}

	.follow-filter {
		flex: 1 1 220px;
		min-width: 0;
		padding: 7px 11px;
		border: 1px solid var(--control-border);
		border-radius: 999px;
		background: var(--control-bg);
		color: var(--text-ink);
		font: inherit;
		font-size: 0.86rem;
	}

	.follow-list,
	.batch-item-list {
		list-style: none;
		margin: 0;
		padding: 0;
		overflow-y: auto;
	}

	.follow-list {
		max-height: 280px;
	}

	.follow-item {
		border-top: 1px solid color-mix(in srgb, var(--control-border) 55%, transparent);
	}

	.follow-item:first-child {
		border-top: 0;
	}

	.follow-item.deselected {
		opacity: 0.52;
	}

	.follow-label {
		display: flex;
		align-items: center;
		gap: 8px;
		min-width: 0;
		padding: 6px 2px;
		cursor: pointer;
	}

	.follow-avatar-strip {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 4px;
		margin-top: 10px;
	}

	.follow-avatar {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 28px;
		height: 28px;
		border: 1px solid var(--control-border);
		border-radius: 999px;
		object-fit: cover;
		flex: 0 0 auto;
		font-size: 0.78rem;
	}

	.follow-avatar-fallback {
		background: var(--control-bg);
		color: var(--text-ink);
	}

	.follow-avatar-more {
		margin-left: 4px;
		color: var(--muted);
		font-size: 0.82rem;
	}

	.follow-names {
		display: flex;
		align-items: baseline;
		gap: 6px;
		min-width: 0;
		flex: 1;
	}

	.follow-name {
		overflow: hidden;
		color: var(--text-ink);
		font-weight: 700;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.follow-handle {
		color: var(--muted);
		font-size: 0.84rem;
		white-space: nowrap;
	}

	.loaded-badge {
		margin-left: auto;
		padding: 1px 7px;
		border: 1px solid color-mix(in srgb, var(--accent) 35%, var(--control-border));
		border-radius: 999px;
		color: var(--accent);
		font-size: 0.72rem;
		font-weight: 700;
	}

	.follow-empty {
		padding: 10px 2px;
		color: var(--muted);
		font-size: 0.86rem;
	}

	.batch-controls {
		margin-top: 10px;
		padding-top: 10px;
		border-top: 1px solid var(--control-border);
	}

	.batch-controls label {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		color: var(--muted);
		font-size: 0.82rem;
	}

	.batch-controls input {
		width: 76px;
		padding: 5px 7px;
		border: 1px solid var(--control-border);
		border-radius: 6px;
		background: var(--control-bg);
		color: var(--text-ink);
		font: inherit;
		font-size: 0.82rem;
	}

	.batch-controls small {
		color: var(--muted);
		font-size: 0.78rem;
	}

	.batch-download-btn {
		margin-left: auto;
		background: color-mix(in srgb, var(--accent) 14%, var(--control-bg));
	}

	.batch-status {
		margin-top: 8px;
		color: var(--muted);
		font-size: 0.8rem;
	}

	.batch-item-list {
		max-height: 190px;
		margin-top: 8px;
		border-top: 1px solid var(--control-border);
	}

	.batch-item-list li {
		display: grid;
		grid-template-columns: minmax(120px, 1fr) auto minmax(0, 1.4fr);
		gap: 8px;
		align-items: center;
		padding: 6px 2px;
		border-bottom: 1px solid color-mix(in srgb, var(--control-border) 55%, transparent);
		color: var(--muted);
		font-size: 0.8rem;
	}

	.batch-item-list li.done {
		color: var(--text-ink);
	}

	.batch-item-list li.failed {
		color: var(--danger-text);
	}

	.batch-item-name {
		min-width: 0;
		overflow: hidden;
		color: var(--text-ink);
		font-weight: 700;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.batch-item-status {
		padding: 1px 7px;
		border: 1px solid var(--control-border);
		border-radius: 999px;
		background: color-mix(in srgb, var(--control-bg) 70%, transparent);
		font-size: 0.72rem;
		font-weight: 700;
	}

	.batch-item-detail,
	.batch-item-error {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
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

	.source-toggle-row,
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

	.source-toggle-note {
		font-size: 0.76rem;
		color: #b4690e;
	}

	.source-toggle,
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

	.source-toggle button,
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

	.source-toggle button:disabled {
		cursor: default;
		opacity: 0.85;
	}

	.thread-sort-toggle button {
		padding-inline: 9px;
	}

	.source-toggle button:last-child,
	.thread-sort-toggle button:last-child,
	.gallery-content-toggle button:last-child,
	.gallery-view-toggle button:last-child,
	.gallery-layout-toggle button:last-child,
	.gallery-fit-toggle button:last-child {
		border-right: 0;
	}

	.source-toggle button.active,
	.thread-sort-toggle button.active,
	.gallery-content-toggle button.active,
	.gallery-view-toggle button.active,
	.gallery-layout-toggle button.active,
	.gallery-fit-toggle button.active {
		background: var(--accent);
		color: white;
	}

	.source-toggle button:hover:not(.active):not(:disabled),
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

	.author-info,
	.author-chip {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 12px;
	}

	.author-info {
		margin-bottom: 16px;
		font-size: 1.2rem;
	}

	.author-list {
		display: flex;
		align-items: center;
		justify-content: center;
		flex-wrap: wrap;
		gap: 10px;
		margin-bottom: 16px;
	}

	.author-chip {
		max-width: min(100%, 320px);
		padding: 8px 12px;
		border: 1.5px solid var(--control-border);
		border-radius: 999px;
		background: color-mix(in srgb, var(--card-bg) 88%, transparent);
		font-size: 0.95rem;
		box-shadow: var(--shadow-soft);
	}

	.author-chip > span {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		min-width: 0;
		line-height: 1.18;
		text-align: left;
	}

	.author-avatar {
		width: 40px;
		height: 40px;
		border-radius: 50%;
		object-fit: cover;
		flex: 0 0 auto;
	}

	.author-avatar.placeholder {
		background: var(--muted);
		opacity: 0.3;
	}

	.author-handle {
		color: var(--muted);
		font-size: 0.95rem;
	}

	.author-repo-count {
		color: var(--muted);
		font-size: 0.75rem;
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

	@media (max-width: 640px) {
		.follow-batch-head,
		.batch-controls {
			align-items: stretch;
			flex-direction: column;
		}

		.follow-batch-actions,
		.batch-controls label,
		.batch-download-btn {
			width: 100%;
		}

		.batch-download-btn {
			margin-left: 0;
		}

		.follow-names {
			align-items: flex-start;
			flex-direction: column;
			gap: 1px;
		}

		.batch-item-list li {
			grid-template-columns: minmax(0, 1fr) auto;
		}

		.batch-item-detail,
		.batch-item-error {
			grid-column: 1 / -1;
		}
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
