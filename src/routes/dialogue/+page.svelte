<script lang="ts">
	import { onMount } from 'svelte';
	import { browser } from '$app/environment';
	import '../../app.css';
	import SearchBar from '$lib/components/SearchBar.svelte';
	import SearchOptions from '$lib/components/SearchOptions.svelte';
	import ThresholdControl from '$lib/components/ThresholdControl.svelte';
	import VirtualThreadList from '$lib/components/VirtualThreadList.svelte';
	import LoadingSpinner from '$lib/components/LoadingSpinner.svelte';
	import ErrorBanner from '$lib/components/ErrorBanner.svelte';
	import RouteNav from '$lib/components/RouteNav.svelte';
	import GroupChat from '$lib/components/GroupChat.svelte';
	import BoardView from '$lib/components/BoardView.svelte';
	import ParallelBoardView from '$lib/components/ParallelBoardView.svelte';
	import FontPicker from '$lib/components/FontPicker.svelte';
	import ThreadJudgePanel from '$lib/components/ThreadJudgePanel.svelte';
	import type { DiscoverProgress, SelfReplyThread, ThreadPost } from '$lib/types';
	import type { ProfileInfo } from '$lib/api/bluesky';
	import { getFullThread, getProfile } from '$lib/api/bluesky';
	import { buildThreadsFromFeed } from '$lib/utils/threadWalker';
	import {
		CACHE_CHUNK_SIZE,
		fetchCachedHeadBatchPage,
		fetchCachedChunkPage,
		fetchNewPosts,
		fetchOlderPosts,
		fetchPostMeta
	} from '$lib/api/cache';
	import { toastError, toastInfo, toastSuccess, toastWarning } from '$lib/utils/toasts';
	import {
		buildAtUri,
		buildBskyPostUrl,
		buildViewerHref,
		normalizeBskyPostUrl,
		parseBskyPostUrl
	} from '$lib/utils/viewerLinks';
	import {
		getNewPostsAnchorUri,
		getNextNewPostsSyncState,
		hasLoadedCompleteCachedFeed,
		mergeUniquePosts,
		postKey,
		resolveViewerFeedUpdate
	} from '$lib/utils/viewerCacheSync';

	const fontFamilies: Record<string, string> = {
		virgil: "'Virgil', cursive",
		caveat: "'Caveat', cursive",
		patrick: "'Patrick Hand', cursive",
		'comic-neue': "'Comic Neue', cursive",
		inter: "'Inter', sans-serif",
		system: "system-ui, -apple-system, sans-serif"
	};

	type RenderMode = 'default' | 'chat' | 'conspiracy' | 'ransom';
	type FeedSlot = 'a' | 'b';
	type SearchMatcherMode = 'none' | 'literal' | 'regex';
	type SearchMatcherTone = 'info' | 'warning';

	type ThreadSearchMatcher = {
		mode: SearchMatcherMode;
		literal: string | null;
		regex: RegExp | null;
		helperText: string | null;
		helperTone: SearchMatcherTone | null;
	};

	type DialogueFeedState = {
		profile: ProfileInfo | null;
		cachedPostCount: number;
		cacheReachedEnd: boolean;
		cacheLimitReached: boolean;
		lastFeedPosts: any[];
		newPostsCursor: string | null;
		newPostsAnchorUri: string | null;
	};

	type DialogueStats = {
		postsScanned: number;
		chainStarts: number;
		sharedDialogues: number;
	};

	type FeedActionResult = {
		added: number;
		hasMore?: boolean;
		totalFetched?: number;
	};

	const INITIAL_SEARCH_TARGET = 1000;
	const INITIAL_UNCACHED_FETCH = 1000;
	const LOAD_OLDER_BATCH = 500;
	const LOAD_NEW_BATCH = 500;
	const CACHE_BUCKET_LIMIT_GB = 9;
	const DEFAULT_PROGRESS: DiscoverProgress = { phase: '', current: 0, total: 0 };
	const EMPTY_STATS: DialogueStats = { postsScanned: 0, chainStarts: 0, sharedDialogues: 0 };

	function createFeedState(): DialogueFeedState {
		return {
			profile: null,
			cachedPostCount: 0,
			cacheReachedEnd: false,
			cacheLimitReached: false,
			lastFeedPosts: [],
			newPostsCursor: null,
			newPostsAnchorUri: null
		};
	}

	function emptyMeta() {
		return {
			postCount: 0,
			reachedEnd: false,
			updatedAt: null,
			chunkCount: 0,
			cursor: null
		};
	}

	let fontKey = $state('patrick');
	let fontFamily = $derived(fontFamilies[fontKey] ?? fontFamilies.virgil);

	const renderMode: RenderMode = 'default';

	let allThreads: SelfReplyThread[] = $state([]);
	let threshold = $state(2);
	let loading = $state(false);
	let resolvingSlot: FeedSlot | null = $state(null);
	let error: string | null = $state(null);
	let progress: DiscoverProgress = $state(DEFAULT_PROGRESS);
	let hasSearched = $state(false);
	let handleAInput = $state('');
	let handleBInput = $state('');
	let maxPosts = $state(100000);

	let feedA = $state<DialogueFeedState>(createFeedState());
	let feedB = $state<DialogueFeedState>(createFeedState());

	let searchQuery = $state('');
	let dateFrom = $state('');
	let dateTo = $state('');
	let stats = $state<DialogueStats>(EMPTY_STATS);

	let abortController: AbortController | null = $state(null);
	let expandedThread: (SelfReplyThread & { isTruncated?: boolean }) | null = $state(null);
	let expandedLoading = $state(false);
	let showExpanded = $state(false);
	let savedScrollY = 0;

	let highlightedThread: string | null = $state(null);
	let pendingScrollToRootUri: string | null = $state(null);
	let collapsedByRootUri = $state<Record<string, boolean>>({});
	let activeThreadUrl: string | null = $state(null);
	let expandedViewMode: 'chat' | 'board' | 'parallel' | 'judge' = $state('chat');

	function getFeedState(slot: FeedSlot): DialogueFeedState {
		return slot === 'a' ? feedA : feedB;
	}

	function slotLabel(slot: FeedSlot): string {
		return slot === 'a' ? 'First user' : 'Second user';
	}

	function normalizeHandle(handle: string | null | undefined): string {
		return (handle ?? '').replace(/^@/, '').trim();
	}

	function activeHandleA(): string {
		return feedA.profile?.handle || handleAInput;
	}

	function activeHandleB(): string {
		return feedB.profile?.handle || handleBInput;
	}

	function selectedParticipantDids(): string[] {
		return Array.from(
			new Set(
				[feedA.profile?.did, feedB.profile?.did].filter(
					(did): did is string => typeof did === 'string' && did.length > 0
				)
			)
		);
	}

	function handlesMatchProfile(value: string, profile: ProfileInfo | null): boolean {
		if (!profile) return false;
		const cleaned = normalizeHandle(value);
		return cleaned === normalizeHandle(profile.handle) || cleaned === profile.did;
	}

	function resetFeedState(feed: DialogueFeedState, preserveProfile = true) {
		if (!preserveProfile) {
			feed.profile = null;
		}
		feed.cachedPostCount = 0;
		feed.cacheReachedEnd = false;
		feed.cacheLimitReached = false;
		feed.lastFeedPosts = [];
		feed.newPostsCursor = null;
		feed.newPostsAnchorUri = null;
	}

	function currentCachedLoadedCount(feed: DialogueFeedState): number {
		return Math.min(feed.lastFeedPosts.length, feed.cachedPostCount);
	}

	function isFeedOlderFullyLoaded(feed: DialogueFeedState): boolean {
		return hasLoadedCompleteCachedFeed({
			currentFeedPosts: feed.lastFeedPosts,
			cachedPostCount: feed.cachedPostCount,
			cacheReachedEnd: feed.cacheReachedEnd,
			maxPosts
		});
	}

	function applyCacheLimitState(slot: FeedSlot, limitReached: boolean) {
		if (!limitReached) return;
		const feed = getFeedState(slot);
		if (!feed.cacheLimitReached) {
			toastWarning(
				`${slotLabel(slot)} hit the shared R2 cache cap at ${CACHE_BUCKET_LIMIT_GB} GB. Live fetches still work, but new cache writes are paused.`
			);
		}
		feed.cacheLimitReached = true;
	}

	function formatRouteError(err: any, fallback: string): string {
		if (
			err?.message?.includes('Unable to resolve handle') ||
			err?.message?.includes('Profile not found')
		) {
			return fallback;
		}
		if (err?.message?.includes('fetch')) {
			return 'Network error. Please check your connection and try again.';
		}
		return err?.message || fallback;
	}

	function setHandleInput(slot: FeedSlot, value: string) {
		const normalized = value;
		if (slot === 'a') {
			handleAInput = normalized;
		} else {
			handleBInput = normalized;
		}

		const feed = getFeedState(slot);
		if (feed.profile && !handlesMatchProfile(normalized, feed.profile)) {
			resetFeedState(feed, false);
		}
	}

	async function handleSlotSearch(slot: FeedSlot, handle: string) {
		const cleaned = normalizeHandle(handle);
		if (!cleaned || loading || resolvingSlot) return;

		resolvingSlot = slot;
		error = null;

		try {
			const profile = await getProfile(cleaned);
			await applyFeedProfile(slot, profile);
			setHandleInput(slot, profile.handle);
		} catch (err: any) {
			error = formatRouteError(err, `Could not find handle "${cleaned}".`);
		} finally {
			resolvingSlot = null;
		}
	}

	async function handleSlotProfileSelected(slot: FeedSlot, profile: ProfileInfo) {
		setHandleInput(slot, profile.handle);
		await applyFeedProfile(slot, profile);
	}

	async function applyFeedProfile(slot: FeedSlot, profile: ProfileInfo) {
		const feed = getFeedState(slot);
		const isNewProfile = feed.profile?.did !== profile.did;
		feed.profile = profile;

		if (isNewProfile) {
			resetFeedState(feed);
		}

		try {
			const status = await fetchPostMeta(profile.did);
			if (feed.profile?.did !== profile.did) return;
			feed.cachedPostCount = status.postCount;
			feed.cacheReachedEnd = status.reachedEnd;
		} catch {
			toastWarning(`Could not check cache status for @${profile.handle}`);
			if (feed.profile?.did === profile.did) {
				feed.cachedPostCount = 0;
				feed.cacheReachedEnd = false;
			}
		}
	}

	function feedCacheExplainer(feed: DialogueFeedState): string {
		if (!feed.profile) {
			return 'Pick a user to inspect this cache state.';
		}

		if (feed.cachedPostCount > 0) {
			if (feed.cacheReachedEnd) {
				if (feed.cacheLimitReached) {
					return `Cached through the oldest available post, but the shared R2 bucket is already at its ${CACHE_BUCKET_LIMIT_GB} GB cap. Reads still work, but new cache writes are paused.`;
				}

				return 'Cached through the oldest available post. New syncs still cache newer posts at the head.';
			}

			if (feed.cacheLimitReached) {
				return `${feed.cachedPostCount.toLocaleString()} posts are cached so far, but the shared R2 bucket is already at its ${CACHE_BUCKET_LIMIT_GB} GB cap. Older fetches continue live, but they will not be written back into cache until space is freed.`;
			}

			return `${feed.cachedPostCount.toLocaleString()} posts are cached so far. Older fetches resume from the current cache cursor until the first post.`;
		}

		if (feed.cacheLimitReached) {
			return `Caching is paused because the shared R2 bucket has reached its ${CACHE_BUCKET_LIMIT_GB} GB cap. Live fetches still work, but this account will stay uncached until space is freed.`;
		}

		return `This account is not cached yet. The first older or new fetch that writes data will create the cache, unless the shared R2 bucket has already reached its ${CACHE_BUCKET_LIMIT_GB} GB cap.`;
	}

	function parseRegexQuery(query: string): { pattern: string; flags: string } | null {
		if (!query.startsWith('/')) return null;

		let escapeNext = false;
		let closingSlash = -1;

		for (let i = 1; i < query.length; i++) {
			const char = query[i];
			if (char === '\\' && !escapeNext) {
				escapeNext = true;
				continue;
			}
			if (char === '/' && !escapeNext) {
				closingSlash = i;
			}
			escapeNext = false;
		}

		if (closingSlash <= 0) return null;
		return {
			pattern: query.slice(1, closingSlash),
			flags: query.slice(closingSlash + 1)
		};
	}

	function buildSearchMatcher(query: string): ThreadSearchMatcher {
		const trimmed = query.trim();
		if (!trimmed) {
			return {
				mode: 'none',
				literal: null,
				regex: null,
				helperText: null,
				helperTone: null
			};
		}

		if (!trimmed.startsWith('/')) {
			return {
				mode: 'literal',
				literal: trimmed.toLowerCase(),
				regex: null,
				helperText: null,
				helperTone: null
			};
		}

		const parsed = parseRegexQuery(trimmed);
		if (!parsed) {
			return {
				mode: 'literal',
				literal: trimmed.toLowerCase(),
				regex: null,
				helperText: null,
				helperTone: 'info'
			};
		}

		try {
			const normalizedFlags = parsed.flags.toLowerCase();
			const flags = normalizedFlags.includes('i') ? normalizedFlags : `${normalizedFlags}i`;
			const regex = new RegExp(parsed.pattern, flags);

			return {
				mode: 'regex',
				literal: null,
				regex,
				helperText: null,
				helperTone: null
			};
		} catch {
			return {
				mode: 'literal',
				literal: trimmed.toLowerCase(),
				regex: null,
				helperText: 'Invalid regex, using literal search.',
				helperTone: 'warning'
			};
		}
	}

	function matchesSearch(thread: SelfReplyThread, matcher: ThreadSearchMatcher): boolean {
		if (matcher.mode === 'none') return true;

		const regex = matcher.mode === 'regex' ? matcher.regex : null;
		const literal = matcher.mode === 'literal' ? matcher.literal : null;

		function check(post: ThreadPost): boolean {
			if (regex) {
				regex.lastIndex = 0;
				if (regex.test(post.text)) return true;
			} else if (literal && post.text.toLowerCase().includes(literal)) {
				return true;
			}
			return post.children.some(check);
		}

		return check(thread.rootPost);
	}

	function isInDateRange(createdAt: string): boolean {
		if (!dateFrom && !dateTo) return true;
		const postDate = new Date(createdAt);
		if (isNaN(postDate.getTime())) return true;
		if (dateFrom && postDate < new Date(dateFrom)) return false;
		if (dateTo) {
			const to = new Date(dateTo);
			to.setHours(23, 59, 59, 999);
			if (postDate > to) return false;
		}
		return true;
	}

	function threadContainsUri(post: ThreadPost, uri: string): boolean {
		if (post.uri === uri) return true;
		return post.children.some((child) => threadContainsUri(child, uri));
	}

	function findThreadForUri(uri: string): SelfReplyThread | null {
		return (
			allThreads.find((thread) => thread.rootUri === uri || threadContainsUri(thread.rootPost, uri)) ??
			null
		);
	}

	function threadToBlueskyUrl(rootUri: string): string | null {
		const thread = allThreads.find((candidate) => candidate.rootUri === rootUri);
		if (thread) {
			return buildBskyPostUrl(thread.rootPost.uri, thread.rootPost.author.handle);
		}
		return buildBskyPostUrl(rootUri);
	}

	function collectParticipantDids(post: ThreadPost, set = new Set<string>()): Set<string> {
		set.add(post.author.did);
		for (const child of post.children) {
			collectParticipantDids(child, set);
		}
		return set;
	}

	function isSharedDialogue(thread: SelfReplyThread, participantDids: string[]): boolean {
		if (participantDids.length < 2) return false;
		const seen = collectParticipantDids(thread.rootPost);
		return participantDids.every((did) => seen.has(did));
	}

	function feedPostTimestamp(item: any): number {
		const raw = item?.post?.record?.createdAt || item?.post?.indexedAt || '';
		const parsed = Date.parse(raw);
		return Number.isFinite(parsed) ? parsed : 0;
	}

	function buildCombinedFeedPosts(): any[] {
		const merged = mergeUniquePosts(feedA.lastFeedPosts, feedB.lastFeedPosts, 'append');
		return [...merged].sort((a, b) => feedPostTimestamp(b) - feedPostTimestamp(a));
	}

	async function loadCachedPostsInChunks(
		did: string,
		targetPosts: number,
		signal: AbortSignal,
		seedFeedPosts: any[] = [],
		startOffset = 0
	): Promise<any[]> {
		let mergedFeedPosts = [...seedFeedPosts];
		const seenKeys = new Set<string>();
		let fallbackKey = 0;
		const status = await fetchPostMeta(did);
		const effectiveTotal = Math.min(targetPosts, status.postCount > 0 ? status.postCount : targetPosts);

		for (const item of mergedFeedPosts) {
			const key = postKey(item) ?? `seed:${fallbackKey++}`;
			seenKeys.add(key);
		}

		const logicalStartOffset = Math.max(0, startOffset);
		const headGroups = status.head?.groups ?? [];
		const headPostCount = status.head?.postCount ?? 0;
		let headOffset = 0;

		for (let groupIndex = 0; groupIndex < headGroups.length; groupIndex++) {
			const group = headGroups[groupIndex];
			for (let batchIndex = 0; batchIndex < group.batches.length; batchIndex++) {
				const batchMeta = group.batches[batchIndex];
				const batchCount = batchMeta.postCount;
				if (batchCount <= 0) continue;

				if (logicalStartOffset >= headOffset + batchCount) {
					headOffset += batchCount;
					continue;
				}

				progress = {
					phase: `Loading cached head batch ${batchIndex + 1}/${group.batches.length}...`,
					current: mergedFeedPosts.length,
					total: effectiveTotal
				};

				const batch = await fetchCachedHeadBatchPage(did, group.id, batchIndex, signal);
				if (batch.missing) {
					headOffset += batchCount;
					continue;
				}

				let batchPosts = batch.posts;
				if (logicalStartOffset > headOffset) {
					batchPosts = batch.posts.slice(logicalStartOffset - headOffset);
				}

				for (const item of batchPosts) {
					const key = postKey(item) ?? `head:${fallbackKey++}`;
					if (seenKeys.has(key)) continue;
					seenKeys.add(key);
					mergedFeedPosts.push(item);
					if (mergedFeedPosts.length >= targetPosts) break;
				}

				headOffset += batchCount;
				if (mergedFeedPosts.length >= targetPosts) {
					break;
				}
			}

			if (mergedFeedPosts.length >= targetPosts) {
				break;
			}
		}

		let chunkIndex = Math.floor(Math.max(0, logicalStartOffset - headPostCount) / CACHE_CHUNK_SIZE);
		const skipInFirstChunk = Math.max(0, logicalStartOffset - headPostCount) % CACHE_CHUNK_SIZE;
		let isFirstChunk = true;
		const tailChunkCount = status.tail?.chunkCount ?? 0;

		while (mergedFeedPosts.length < targetPosts) {
			const chunk = await fetchCachedChunkPage(did, chunkIndex, signal);
			progress = {
				phase:
					tailChunkCount > 0
						? `Loading cache chunk ${chunkIndex + 1}/${tailChunkCount}...`
						: 'Loading cached posts...',
				current: mergedFeedPosts.length,
				total: effectiveTotal
			};

			if (chunk.posts.length === 0) break;

			let chunkPosts = chunk.posts;
			if (isFirstChunk && skipInFirstChunk > 0) {
				chunkPosts = chunk.posts.slice(skipInFirstChunk);
			}
			isFirstChunk = false;

			for (const item of chunkPosts) {
				const key = postKey(item) ?? `chunk:${fallbackKey++}`;
				if (seenKeys.has(key)) continue;
				seenKeys.add(key);
				mergedFeedPosts.push(item);
			}

			chunkIndex++;
			if (tailChunkCount > 0 && chunkIndex >= tailChunkCount) break;
		}

		if (mergedFeedPosts.length > targetPosts) {
			mergedFeedPosts.length = targetPosts;
		}

		return mergedFeedPosts;
	}

	async function reloadCachedPrefix(did: string, targetPosts: number, signal: AbortSignal): Promise<any[]> {
		const boundedTarget = Math.max(0, Math.min(maxPosts, targetPosts));
		if (boundedTarget <= 0) return [];
		return loadCachedPostsInChunks(did, boundedTarget, signal);
	}

	async function refreshFeedCacheStatus(slot: FeedSlot, did: string) {
		const status = await fetchPostMeta(did);
		const feed = getFeedState(slot);
		if (feed.profile?.did !== did) return status;
		feed.cachedPostCount = status.postCount;
		feed.cacheReachedEnd = status.reachedEnd;
		return status;
	}

	async function refreshAllCacheStatuses() {
		const tasks: Array<Promise<unknown>> = [];
		if (feedA.profile) tasks.push(refreshFeedCacheStatus('a', feedA.profile.did).catch(() => {}));
		if (feedB.profile) tasks.push(refreshFeedCacheStatus('b', feedB.profile.did).catch(() => {}));
		await Promise.all(tasks);
	}

	async function loadInitialFeedForSlot(slot: FeedSlot, signal: AbortSignal): Promise<void> {
		const feed = getFeedState(slot);
		const profile = feed.profile;
		if (!profile) return;

		progress = {
			phase: `Preparing @${profile.handle}...`,
			current: 0,
			total: INITIAL_SEARCH_TARGET
		};

		const boundedTarget = Math.min(maxPosts, profile.postsCount || maxPosts);
		const initialTarget = Math.min(INITIAL_SEARCH_TARGET, boundedTarget);
		const status = await refreshFeedCacheStatus(slot, profile.did).catch(emptyMeta);

		if (status.postCount > 0) {
			feed.lastFeedPosts = await loadCachedPostsInChunks(profile.did, initialTarget, signal);
			return;
		}

		progress = {
			phase: `Fetching initial posts for @${profile.handle}...`,
			current: 0,
			total: INITIAL_UNCACHED_FETCH
		};

		const older = await fetchOlderPosts(
			profile.did,
			{
				cursor: null,
				limitPosts: INITIAL_UNCACHED_FETCH,
				postsCount: profile.postsCount
			},
			signal
		);
		applyCacheLimitState(slot, older.cache.limitReached);
		feed.lastFeedPosts = older.posts;
		await refreshFeedCacheStatus(slot, profile.did).catch(() => {});
	}

	async function rebuildThreadsFromFeeds(signal: AbortSignal) {
		const participantDids = selectedParticipantDids();
		const combinedFeedPosts = buildCombinedFeedPosts();
		progress = {
			phase: 'Building dialogue threads...',
			current: 0,
			total: combinedFeedPosts.length
		};

		const { threads } = buildThreadsFromFeed(combinedFeedPosts, participantDids, (next) => {
			progress = next;
		});

		if (signal.aborted) {
			throw new DOMException('Aborted', 'AbortError');
		}

		const sharedThreads = threads.filter((thread) => isSharedDialogue(thread, participantDids));
		allThreads = sharedThreads;
		stats = {
			postsScanned: combinedFeedPosts.length,
			chainStarts: threads.length,
			sharedDialogues: sharedThreads.length
		};

		return stats;
	}

	const searchMatcher = $derived(buildSearchMatcher(searchQuery));

	const sortedThreads = $derived(
		[...allThreads].sort((a, b) => {
			const depthDiff = b.depth - a.depth;
			if (depthDiff !== 0) return depthDiff;
			return Date.parse(b.rootPost.createdAt) - Date.parse(a.rootPost.createdAt);
		})
	);

	const displayedThreads = $derived(
		sortedThreads.filter(
			(thread) =>
				thread.depth >= threshold &&
				isInDateRange(thread.rootPost.createdAt) &&
				matchesSearch(thread, searchMatcher)
		)
	);

	const maxDepth = $derived(allThreads.length > 0 ? Math.max(...allThreads.map((t) => t.depth)) : 2);
	const bothFeedsOlderFullyLoaded = $derived(
		isFeedOlderFullyLoaded(feedA) && isFeedOlderFullyLoaded(feedB)
	);

	function updateRouteState(options: {
		handleA?: string | null;
		handleB?: string | null;
		threadUrl?: string | null;
	} = {}) {
		if (!browser) return;

		const url = new URL(window.location.href);
		const nextHandleA = normalizeHandle(options.handleA ?? activeHandleA());
		const nextHandleB = normalizeHandle(options.handleB ?? activeHandleB());
		const nextThreadUrl = options.threadUrl ? normalizeBskyPostUrl(options.threadUrl) : null;

		if (nextHandleA) {
			url.searchParams.set('handleA', nextHandleA);
		} else {
			url.searchParams.delete('handleA');
		}

		if (nextHandleB) {
			url.searchParams.set('handleB', nextHandleB);
		} else {
			url.searchParams.delete('handleB');
		}

		if (nextThreadUrl) {
			url.searchParams.set('url', nextThreadUrl);
		} else {
			url.searchParams.delete('url');
		}

		window.history.replaceState({}, '', url.toString());
		activeThreadUrl = nextThreadUrl;
	}

	function flashHighlightedThread(rootUri: string) {
		highlightedThread = rootUri;
		pendingScrollToRootUri = rootUri;
		window.setTimeout(() => {
			if (highlightedThread === rootUri) {
				highlightedThread = null;
			}
		}, 3000);
	}

	function cancelFetch() {
		abortController?.abort();
	}

	function isThreadCollapsed(rootUri: string): boolean {
		return collapsedByRootUri[rootUri] ?? true;
	}

	function setThreadCollapsed(rootUri: string, collapsed: boolean) {
		if (isThreadCollapsed(rootUri) === collapsed) return;
		collapsedByRootUri = {
			...collapsedByRootUri,
			[rootUri]: collapsed
		};
	}

	function handleScrollToRootUriComplete(rootUri: string, _found: boolean) {
		if (pendingScrollToRootUri !== rootUri) return;
		pendingScrollToRootUri = null;
	}

	async function handleBuildDialogue(options: {
		profileA?: ProfileInfo | null;
		profileB?: ProfileInfo | null;
		threadUrl?: string | null;
	} = {}): Promise<boolean> {
		const cleanedA = normalizeHandle(handleAInput);
		const cleanedB = normalizeHandle(handleBInput);

		if (!cleanedA || !cleanedB) {
			error = 'Choose two Bluesky handles to build a dialogue.';
			return false;
		}

		if (cleanedA === cleanedB) {
			error = 'Choose two different Bluesky handles.';
			return false;
		}

		if (loading || resolvingSlot) return false;

		loading = true;
		error = null;
		hasSearched = true;
		allThreads = [];
		collapsedByRootUri = {};
		pendingScrollToRootUri = null;
		highlightedThread = null;
		showExpanded = false;
		expandedThread = null;
		expandedLoading = false;
		expandedViewMode = 'chat';
		stats = { ...EMPTY_STATS };

		const controller = new AbortController();
		abortController = controller;
		const requestedThreadUrl = options.threadUrl ? normalizeBskyPostUrl(options.threadUrl) : null;
		updateRouteState({
			handleA: cleanedA,
			handleB: cleanedB,
			threadUrl: requestedThreadUrl
		});

		try {
			let profileA = options.profileA;
			if (!profileA || !handlesMatchProfile(cleanedA, profileA)) {
				profileA = await getProfile(cleanedA);
			}

			let profileB = options.profileB;
			if (!profileB || !handlesMatchProfile(cleanedB, profileB)) {
				profileB = await getProfile(cleanedB);
			}

			const shouldLoadA = feedA.profile?.did !== profileA.did || feedA.lastFeedPosts.length === 0;
			const shouldLoadB = feedB.profile?.did !== profileB.did || feedB.lastFeedPosts.length === 0;

			await applyFeedProfile('a', profileA);
			await applyFeedProfile('b', profileB);
			handleAInput = profileA.handle;
			handleBInput = profileB.handle;

			updateRouteState({
				handleA: profileA.handle,
				handleB: profileB.handle,
				threadUrl: requestedThreadUrl
			});

			if (shouldLoadA) {
				await loadInitialFeedForSlot('a', controller.signal);
			}

			if (shouldLoadB) {
				await loadInitialFeedForSlot('b', controller.signal);
			}

			const rebuilt = await rebuildThreadsFromFeeds(controller.signal);
			if (rebuilt.sharedDialogues > 0) {
				toastSuccess(
					`Found ${rebuilt.sharedDialogues} shared dialogue thread${rebuilt.sharedDialogues !== 1 ? 's' : ''}`
				);
			} else {
				toastInfo('No shared dialogue chains found in the loaded feed slices.');
			}
			return true;
		} catch (err: any) {
			error = formatRouteError(err, 'Building the dialogue failed.');
			return false;
		} finally {
			loading = false;
			abortController = null;
			await refreshAllCacheStatuses();
		}
	}

	async function checkNewPostsForSlot(slot: FeedSlot, signal: AbortSignal): Promise<FeedActionResult> {
		const feed = getFeedState(slot);
		const profile = feed.profile;
		if (!profile) return { added: 0, hasMore: false };

		progress = {
			phase: `Checking for new posts for @${profile.handle}...`,
			current: 0,
			total: LOAD_NEW_BATCH
		};

		const requestAnchorUri = getNewPostsAnchorUri(
			feed.lastFeedPosts,
			feed.newPostsCursor,
			feed.newPostsAnchorUri
		);

		const result = await fetchNewPosts(
			profile.did,
			{
				sinceUri: requestAnchorUri,
				cursor: feed.newPostsCursor,
				limit: LOAD_NEW_BATCH,
				postsCount: profile.postsCount
			},
			signal
		);

		applyCacheLimitState(slot, result.cache.limitReached);

		const nextSyncState = getNextNewPostsSyncState(requestAnchorUri, result.hasMore, result.nextCursor);
		feed.newPostsCursor = nextSyncState.newPostsCursor;
		feed.newPostsAnchorUri = nextSyncState.newPostsAnchorUri;

		const reloadedFeedPosts = result.cache.written
			? await reloadCachedPrefix(
					profile.did,
					Math.min(maxPosts, feed.lastFeedPosts.length + result.posts.length),
					signal
				)
			: null;

		const resolved = resolveViewerFeedUpdate({
			currentFeedPosts: feed.lastFeedPosts,
			incomingPosts: result.posts,
			mode: 'prepend',
			cacheWritten: result.cache.written,
			reloadedFeedPosts
		});

		feed.lastFeedPosts = resolved.feedPosts;
		if (result.cache.written) {
			feed.cachedPostCount = result.cache.postCount;
			feed.cacheReachedEnd = result.cache.reachedEnd;
		}

		return {
			added: resolved.added,
			hasMore: result.hasMore
		};
	}

	async function handleCheckNewPosts() {
		if (loading || !feedA.profile || !feedB.profile) return;
		if (feedA.lastFeedPosts.length === 0 || feedB.lastFeedPosts.length === 0) {
			await handleBuildDialogue();
			return;
		}

		loading = true;
		error = null;
		hasSearched = true;

		const controller = new AbortController();
		abortController = controller;

		try {
			const results = [
				await checkNewPostsForSlot('a', controller.signal),
				await checkNewPostsForSlot('b', controller.signal)
			];
			const totalAdded = results.reduce((sum, result) => sum + result.added, 0);

			if (totalAdded > 0) {
				await rebuildThreadsFromFeeds(controller.signal);
				toastSuccess(`Loaded ${totalAdded.toLocaleString()} new posts across both feeds`);
			} else if (results.some((result) => result.hasMore)) {
				toastInfo('No overlap yet. Click "Check new posts" again to keep walking the head.');
			} else {
				toastInfo('No new posts found.');
			}

			if (results.some((result) => result.hasMore)) {
				toastInfo('More new posts are available. Click "Check new posts" again.');
			}
		} catch (err: any) {
			error = formatRouteError(err, 'Checking new posts failed.');
		} finally {
			loading = false;
			abortController = null;
			await refreshAllCacheStatuses();
		}
	}

	async function loadOlderPostsForSlot(slot: FeedSlot, signal: AbortSignal): Promise<FeedActionResult> {
		const feed = getFeedState(slot);
		const profile = feed.profile;
		if (!profile || isFeedOlderFullyLoaded(feed)) {
			return { added: 0 };
		}

		progress = {
			phase: `Loading older posts for @${profile.handle}...`,
			current: currentCachedLoadedCount(feed),
			total: Math.max(feed.cachedPostCount, currentCachedLoadedCount(feed) + LOAD_OLDER_BATCH)
		};

		const status = await refreshFeedCacheStatus(slot, profile.did).catch(() => ({
			...emptyMeta(),
			postCount: feed.cachedPostCount,
			reachedEnd: feed.cacheReachedEnd
		}));

		if (
			hasLoadedCompleteCachedFeed({
				currentFeedPosts: feed.lastFeedPosts,
				cachedPostCount: status.postCount,
				cacheReachedEnd: status.reachedEnd,
				maxPosts
			})
		) {
			return { added: 0 };
		}

		const cachedLoaded = currentCachedLoadedCount(feed);
		const targetCachedPosts = Math.min(maxPosts, status.postCount);
		const overlayCount = Math.max(0, feed.lastFeedPosts.length - cachedLoaded);
		const targetFeedPosts = targetCachedPosts + overlayCount;

		if (targetCachedPosts > cachedLoaded) {
			const mergedCached = await loadCachedPostsInChunks(
				profile.did,
				targetFeedPosts,
				signal,
				feed.lastFeedPosts,
				cachedLoaded
			);
			if (mergedCached.length > feed.lastFeedPosts.length) {
				const added = mergedCached.length - feed.lastFeedPosts.length;
				feed.lastFeedPosts = mergedCached;
				return { added };
			}
		}

		if (status.reachedEnd) {
			return { added: 0 };
		}

		const older = await fetchOlderPosts(
			profile.did,
			{
				cursor: status.cursor,
				limitPosts: LOAD_OLDER_BATCH,
				postsCount: profile.postsCount
			},
			signal
		);

		applyCacheLimitState(slot, older.cache.limitReached);

		if (older.posts.length === 0) {
			await refreshFeedCacheStatus(slot, profile.did).catch(() => {});
			return { added: 0 };
		}

		const reloadedFeedPosts = older.cache.written
			? await reloadCachedPrefix(
					profile.did,
					Math.min(maxPosts, feed.lastFeedPosts.length + older.posts.length),
					signal
				)
			: null;

		const resolved = resolveViewerFeedUpdate({
			currentFeedPosts: feed.lastFeedPosts,
			incomingPosts: older.posts,
			mode: 'append',
			cacheWritten: older.cache.written,
			reloadedFeedPosts
		});

		feed.lastFeedPosts = resolved.feedPosts;
		if (older.cache.written) {
			feed.cachedPostCount = older.cache.postCount;
			feed.cacheReachedEnd = older.cache.reachedEnd;
		}

		return {
			added: resolved.added
		};
	}

	async function handleLoadOlderPosts() {
		if (loading || !feedA.profile || !feedB.profile) return;
		if (feedA.lastFeedPosts.length === 0 || feedB.lastFeedPosts.length === 0) {
			await handleBuildDialogue();
			return;
		}
		if (bothFeedsOlderFullyLoaded) return;

		loading = true;
		error = null;
		hasSearched = true;

		const controller = new AbortController();
		abortController = controller;

		try {
			const results = [
				await loadOlderPostsForSlot('a', controller.signal),
				await loadOlderPostsForSlot('b', controller.signal)
			];
			const totalAdded = results.reduce((sum, result) => sum + result.added, 0);

			if (totalAdded > 0) {
				await rebuildThreadsFromFeeds(controller.signal);
				toastSuccess(`Loaded ${totalAdded.toLocaleString()} older posts across both feeds`);
			} else {
				toastInfo('No additional older posts available.');
			}
		} catch (err: any) {
			error = formatRouteError(err, 'Loading older posts failed.');
		} finally {
			loading = false;
			abortController = null;
			await refreshAllCacheStatuses();
		}
	}

	async function fetchAllOlderPostsForSlot(slot: FeedSlot, signal: AbortSignal): Promise<FeedActionResult> {
		const feed = getFeedState(slot);
		const profile = feed.profile;
		if (!profile || isFeedOlderFullyLoaded(feed)) {
			return { added: 0, totalFetched: 0 };
		}

		const status = await refreshFeedCacheStatus(slot, profile.did).catch(() => ({
			...emptyMeta(),
			postCount: feed.cachedPostCount,
			reachedEnd: feed.cacheReachedEnd
		}));

		if (
			hasLoadedCompleteCachedFeed({
				currentFeedPosts: feed.lastFeedPosts,
				cachedPostCount: status.postCount,
				cacheReachedEnd: status.reachedEnd,
				maxPosts
			})
		) {
			return { added: 0, totalFetched: 0 };
		}

		const cachedLoaded = Math.min(feed.lastFeedPosts.length, status.postCount);
		const overlayPosts = feed.lastFeedPosts.slice(0, Math.max(0, feed.lastFeedPosts.length - cachedLoaded));
		const targetCachedDisplayCount = Math.min(maxPosts, status.postCount);

		if (status.postCount <= 0) {
			return { added: 0, totalFetched: 0 };
		}

		if (status.reachedEnd && cachedLoaded >= targetCachedDisplayCount) {
			return { added: 0, totalFetched: 0 };
		}

		let totalFetched = 0;
		let latestCachedCount = status.postCount;
		let latestReachedEnd = status.reachedEnd;
		let cursor = status.cursor;
		let requestCount = 0;
		const seenCursorKeys = new Set<string>();
		let fallbackOlderPosts: any[] = [];

		while (!latestReachedEnd) {
			const cursorKey = cursor ?? '__cached__';
			if (seenCursorKeys.has(cursorKey)) {
				throw new Error('Older cursor did not advance during full cache fetch.');
			}
			seenCursorKeys.add(cursorKey);

			progress = {
				phase:
					requestCount === 0
						? `Fetching all older posts for @${profile.handle}...`
						: `Fetching all older posts for @${profile.handle}... (${totalFetched.toLocaleString()} fetched)`,
				current: latestCachedCount,
				total: Math.max(profile.postsCount || 0, latestCachedCount + LOAD_OLDER_BATCH)
			};

			const older = await fetchOlderPosts(
				profile.did,
				{
					cursor,
					limitPosts: LOAD_OLDER_BATCH,
					postsCount: profile.postsCount
				},
				signal
			);

			applyCacheLimitState(slot, older.cache.limitReached);

			requestCount += 1;
			totalFetched += older.posts.length;
			latestReachedEnd = older.reachedEnd;

			if (older.cache.written) {
				latestCachedCount = older.cache.postCount;
				feed.cachedPostCount = older.cache.postCount;
				feed.cacheReachedEnd = older.cache.reachedEnd;
			} else if (older.posts.length > 0) {
				latestCachedCount += older.posts.length;
				fallbackOlderPosts = mergeUniquePosts(fallbackOlderPosts, older.posts, 'append');
			}

			if (latestReachedEnd) break;

			if (!older.nextCursor || older.nextCursor === cursor) {
				throw new Error('Older cursor was missing before the end of the feed.');
			}
			cursor = older.nextCursor;

			if (older.posts.length === 0) {
				break;
			}
		}

		progress = {
			phase: `Reloading full cached feed for @${profile.handle}...`,
			current: latestCachedCount,
			total: Math.max(profile.postsCount || 0, latestCachedCount)
		};

		const finalStatus = await refreshFeedCacheStatus(slot, profile.did).catch(() => ({
			...emptyMeta(),
			postCount: latestCachedCount,
			reachedEnd: latestReachedEnd,
			cursor
		}));

		const reloadedCachedFeed =
			finalStatus.postCount > 0
				? await reloadCachedPrefix(profile.did, Math.min(maxPosts, finalStatus.postCount), signal)
				: [];

		let mergedFeedPosts = mergeUniquePosts(overlayPosts, reloadedCachedFeed, 'append');
		if (fallbackOlderPosts.length > 0) {
			mergedFeedPosts = mergeUniquePosts(mergedFeedPosts, fallbackOlderPosts, 'append');
		}
		if (mergedFeedPosts.length > maxPosts) {
			mergedFeedPosts.length = maxPosts;
		}

		const added = Math.max(0, mergedFeedPosts.length - feed.lastFeedPosts.length);
		feed.lastFeedPosts = mergedFeedPosts;

		return {
			added,
			totalFetched
		};
	}

	async function handleFetchAllOlderPosts() {
		if (loading || !feedA.profile || !feedB.profile) return;
		if (feedA.lastFeedPosts.length === 0 || feedB.lastFeedPosts.length === 0) {
			await handleBuildDialogue();
			return;
		}
		if (bothFeedsOlderFullyLoaded) return;

		loading = true;
		error = null;
		hasSearched = true;

		const controller = new AbortController();
		abortController = controller;

		try {
			const results = [
				await fetchAllOlderPostsForSlot('a', controller.signal),
				await fetchAllOlderPostsForSlot('b', controller.signal)
			];
			const totalFetched = results.reduce((sum, result) => sum + (result.totalFetched ?? 0), 0);
			const totalAdded = results.reduce((sum, result) => sum + result.added, 0);

			if (totalAdded > 0) {
				await rebuildThreadsFromFeeds(controller.signal);
			}

			if (totalFetched > 0) {
				toastSuccess(`Fetched ${totalFetched.toLocaleString()} older posts across both feeds`);
			} else if (totalAdded > 0) {
				toastSuccess(`Loaded ${totalAdded.toLocaleString()} cached posts across both feeds`);
			} else {
				toastInfo('No additional older posts available.');
			}
		} catch (err: any) {
			error = formatRouteError(err, 'Fetching all older posts failed.');
		} finally {
			loading = false;
			abortController = null;
			await refreshAllCacheStatuses();
		}
	}

	function handleFontChange(key: string) {
		fontKey = key;
		try {
			localStorage.setItem('preferred-font', key);
		} catch {}
	}

	async function openExpandedThread(
		uri: string,
		options: { preserveScroll?: boolean } = {}
	): Promise<boolean> {
		if (options.preserveScroll) {
			savedScrollY = window.scrollY;
		}

		expandedLoading = true;
		showExpanded = true;

		try {
			expandedThread = await getFullThread(uri);
			const canonicalThreadUrl =
				buildBskyPostUrl(expandedThread.rootUri, expandedThread.rootPost.author.handle) ??
				buildBskyPostUrl(uri);
			updateRouteState({
				handleA: activeHandleA(),
				handleB: activeHandleB(),
				threadUrl: canonicalThreadUrl
			});
			return true;
		} catch (err: any) {
			toastError(err?.message || 'Failed to load full thread.');
			showExpanded = false;
			expandedThread = null;
			updateRouteState({
				handleA: activeHandleA(),
				handleB: activeHandleB(),
				threadUrl: null
			});
			return false;
		} finally {
			expandedLoading = false;
		}
	}

	async function handleExpand(rootUri: string) {
		await openExpandedThread(rootUri, { preserveScroll: true });
	}

	function handleBack() {
		showExpanded = false;
		expandedThread = null;
		expandedViewMode = 'chat';
		updateRouteState({
			handleA: activeHandleA(),
			handleB: activeHandleB(),
			threadUrl: null
		});
		requestAnimationFrame(() => {
			window.scrollTo(0, savedScrollY);
		});
	}

	async function copyThreadLink() {
		try {
			if (!expandedThread) return;
			const bskyUrl = buildBskyPostUrl(expandedThread.rootUri, expandedThread.rootPost.author.handle);
			if (!bskyUrl) return;
			const shareUrl = new URL(
				buildViewerHref('dialogue', {
					url: bskyUrl,
					handleA: activeHandleA(),
					handleB: activeHandleB()
				}),
				window.location.origin
			);
			await navigator.clipboard.writeText(shareUrl.toString());
			toastSuccess('Link copied to clipboard');
		} catch {
			toastError('Failed to copy link');
		}
	}

	async function handleShare(rootUri: string) {
		try {
			const bskyUrl = threadToBlueskyUrl(rootUri);
			if (!bskyUrl) {
				toastError('Could not build a share link for this thread.');
				return;
			}
			const shareUrl = new URL(
				buildViewerHref('dialogue', {
					url: bskyUrl,
					handleA: activeHandleA(),
					handleB: activeHandleB()
				}),
				window.location.origin
			);
			await navigator.clipboard.writeText(shareUrl.toString());
			toastSuccess('Link copied to clipboard');
		} catch {
			toastError('Failed to copy link');
		}
	}

	function handleOpenOnBluesky(rootUri: string) {
		if (!browser) return;
		const bskyUrl = threadToBlueskyUrl(rootUri);
		if (!bskyUrl) {
			toastError('Could not build Bluesky link for this thread.');
			return;
		}

		const opened = window.open(bskyUrl, '_blank', 'noopener,noreferrer');
		if (!opened) {
			toastInfo('Allow popups to open this thread in a new tab.');
		}
	}

	async function restoreSharedThread(threadUrl: string, rawHandleA: string, rawHandleB: string) {
		const normalizedThreadUrl = normalizeBskyPostUrl(threadUrl);
		const parsed = normalizedThreadUrl ? parseBskyPostUrl(normalizedThreadUrl) : null;
		if (!normalizedThreadUrl || !parsed) {
			toastInfo('Could not parse thread details from the shared URL.');
			return;
		}

		handleAInput = normalizeHandle(rawHandleA);
		handleBInput = normalizeHandle(rawHandleB);

		const loaded = await handleBuildDialogue({ threadUrl: normalizedThreadUrl });
		if (!loaded) return;

		let actorProfile =
			[feedA.profile, feedB.profile].find(
				(profile) => normalizeHandle(profile?.handle) === normalizeHandle(parsed.handle)
			) ?? null;

		if (!actorProfile) {
			try {
				actorProfile = await getProfile(parsed.handle);
			} catch {
				toastInfo('Could not load profile from the shared thread URL.');
				return;
			}
		}

		const targetUri = buildAtUri(actorProfile.did, parsed.rkey);
		if (!targetUri) {
			toastInfo('Could not derive a valid thread URI from the shared URL.');
			return;
		}

		const matchedThread = findThreadForUri(targetUri);
		if (matchedThread) {
			const canonicalThreadUrl = threadToBlueskyUrl(matchedThread.rootUri) ?? normalizedThreadUrl;
			updateRouteState({
				handleA: activeHandleA(),
				handleB: activeHandleB(),
				threadUrl: canonicalThreadUrl
			});
			flashHighlightedThread(matchedThread.rootUri);
			return;
		}

		await openExpandedThread(targetUri);
	}

	onMount(async () => {
		try {
			const saved = localStorage.getItem('preferred-font');
			if (saved && saved in fontFamilies) fontKey = saved;
		} catch {}

		const params = new URLSearchParams(window.location.search);
		const urlParam = params.get('url');
		const handleAParam = params.get('handleA');
		const handleBParam = params.get('handleB');
		const fromParam = params.get('from');
		const toParam = params.get('to');

		if (fromParam) dateFrom = fromParam;
		if (toParam) dateTo = toParam;
		if (handleAParam) handleAInput = normalizeHandle(handleAParam);
		if (handleBParam) handleBInput = normalizeHandle(handleBParam);

		if (urlParam && handleAParam && handleBParam) {
			await restoreSharedThread(urlParam, handleAParam, handleBParam);
			return;
		}

		if (handleAParam && handleBParam) {
			await handleBuildDialogue();
		}
	});
</script>

<svelte:head>
	<title>Bluesky Dialogue Viewer</title>
</svelte:head>

<main style="font-family: {fontFamily}">
	<header>
		<RouteNav
			current="dialogue"
			align="center"
			threadUrl={activeThreadUrl}
			handle={feedA.profile?.handle || handleAInput}
			dialogueHandleA={activeHandleA()}
			dialogueHandleB={activeHandleB()}
		/>
		<h1>Bluesky Dialogue Viewer</h1>
		<p class="subtitle">Combine two author feeds into shared reply chains</p>
		<FontPicker value={fontKey} onchange={handleFontChange} />
	</header>

	<section class="search-section">
		<div class="dialogue-search-grid">
			<div class="search-slot">
				<div class="search-slot-label">First user</div>
				<SearchBar
					onsearch={(handle) => void handleSlotSearch('a', handle)}
					onprofile={(profile) => void handleSlotProfileSelected('a', profile)}
					onchange={(value) => setHandleInput('a', value)}
					disabled={loading || resolvingSlot !== null}
					initialHandle={handleAInput}
					placeholder="Search for the first Bluesky user..."
					buttonLabel="Pick"
				/>
			</div>
			<div class="search-slot">
				<div class="search-slot-label">Second user</div>
				<SearchBar
					onsearch={(handle) => void handleSlotSearch('b', handle)}
					onprofile={(profile) => void handleSlotProfileSelected('b', profile)}
					onchange={(value) => setHandleInput('b', value)}
					disabled={loading || resolvingSlot !== null}
					initialHandle={handleBInput}
					placeholder="Search for the second Bluesky user..."
					buttonLabel="Pick"
				/>
			</div>
		</div>

		<div class="build-row">
			<button
				class="build-btn wobbly-border"
				onclick={() => void handleBuildDialogue()}
				disabled={loading || resolvingSlot !== null || !normalizeHandle(handleAInput) || !normalizeHandle(handleBInput)}
			>
				{loading ? 'Building...' : 'Build dialogue'}
			</button>
		</div>

		<div class="options-row">
			<SearchOptions bind:dateFrom bind:dateTo />
		</div>
	</section>

	{#if error}
		<ErrorBanner message={error} />
	{/if}

	{#if showExpanded}
		<div class="panel-detail">
			{#if expandedLoading}
				<LoadingSpinner progress={{ phase: 'Loading full thread...', current: 0, total: 0 }} />
			{:else if expandedThread}
				<div class="expanded-actions">
					<button class="back-btn wobbly-border" onclick={handleBack}>&#8592; Back to threads</button>
					<button class="copy-link-btn wobbly-border" onclick={copyThreadLink}>Copy link</button>
					<div class="view-toggle">
						<button class="view-toggle-btn wobbly-border" class:active={expandedViewMode === 'chat'} onclick={() => expandedViewMode = 'chat'}>Chat</button>
						<button class="view-toggle-btn wobbly-border" class:active={expandedViewMode === 'board'} onclick={() => expandedViewMode = 'board'}>Board</button>
						<button class="view-toggle-btn wobbly-border" class:active={expandedViewMode === 'parallel'} onclick={() => expandedViewMode = 'parallel'}>Parallel</button>
						<button class="view-toggle-btn wobbly-border" class:active={expandedViewMode === 'judge'} onclick={() => expandedViewMode = 'judge'}>Judge</button>
					</div>
				</div>
				{#if expandedThread.isTruncated}
					<p class="truncation-warning">Some replies may be missing</p>
				{/if}
				<div class="expanded-thread" class:expanded-wide={expandedViewMode === 'board' || expandedViewMode === 'parallel'}>
					{#if expandedViewMode === 'chat'}
						<GroupChat thread={expandedThread} />
					{:else if expandedViewMode === 'board'}
						<BoardView thread={expandedThread} />
					{:else if expandedViewMode === 'parallel'}
						<ParallelBoardView thread={expandedThread} />
					{:else}
						{#key expandedThread.rootUri}
							<ThreadJudgePanel thread={expandedThread} autoloadCache />
						{/key}
					{/if}
				</div>
			{/if}
		</div>
	{:else}
		{#if hasSearched}
			<section class="results-section">
				<div class="results-header">
					<div class="dialogue-author-row">
						{#each [feedA.profile, feedB.profile] as profile}
							{#if profile}
								<div class="author-info">
									{#if profile.avatar}
										<img src={profile.avatar} alt="" class="author-avatar" />
									{/if}
									<span>
										{profile.displayName || profile.handle}
										<span class="author-handle">@{profile.handle}</span>
									</span>
								</div>
							{/if}
						{/each}
					</div>

					{#if !loading && stats.postsScanned > 0}
						<div class="stats-bar">
							<span>{stats.postsScanned.toLocaleString()} posts scanned</span>
							<span class="stats-sep">/</span>
							<span>{stats.chainStarts.toLocaleString()} combined chains</span>
							<span class="stats-sep">/</span>
							<span>{stats.sharedDialogues.toLocaleString()} shared dialogues</span>
						</div>
					{/if}

					{#if feedA.profile && feedB.profile}
						<div class="refetch-row">
							<button class="refetch-btn wobbly-border" onclick={handleCheckNewPosts} disabled={loading}>
								{loading ? 'Working...' : 'Check new posts'}
							</button>
							<button
								class="refetch-btn wobbly-border"
								onclick={handleLoadOlderPosts}
								disabled={loading || bothFeedsOlderFullyLoaded}
							>
								{loading ? 'Working...' : 'Load older posts'}
							</button>
							<button
								class="refetch-btn wobbly-border"
								onclick={handleFetchAllOlderPosts}
								disabled={loading || bothFeedsOlderFullyLoaded}
							>
								{loading ? 'Working...' : 'Fetch all older posts'}
							</button>
						</div>

						<div class="cache-grid">
							{#each [
								{ slot: 'a' as FeedSlot, feed: feedA },
								{ slot: 'b' as FeedSlot, feed: feedB }
							] as item}
								{#if item.feed.profile}
									<div class="cache-card wobbly-border-light">
										<p class="cache-card-title">
											{item.feed.profile.displayName || item.feed.profile.handle}
											<span class="author-handle">@{item.feed.profile.handle}</span>
										</p>
										<p class="cache-card-count">
											{#if item.feed.cacheReachedEnd}
												All <strong>{item.feed.cachedPostCount.toLocaleString()}</strong> posts cached
											{:else}
												{item.feed.profile.postsCount.toLocaleString()} posts
												{#if item.feed.cachedPostCount > 0}
													(<strong>{item.feed.cachedPostCount.toLocaleString()}</strong> cached)
												{/if}
											{/if}
										</p>
										<p>{feedCacheExplainer(item.feed)}</p>
									</div>
								{/if}
							{/each}
						</div>
					{/if}

					{#if allThreads.length > 0}
						<ThresholdControl bind:value={threshold} min={2} max={Math.max(maxDepth, 2)} />
						<div class="search-filter wobbly-border-light">
							<label for="thread-search">Search threads:</label>
							<input
								id="thread-search"
								type="text"
								placeholder="Filter by text or /pattern/flags…"
								bind:value={searchQuery}
							/>
							{#if searchMatcher.helperText}
								<p class="search-helper" class:warning={searchMatcher.helperTone === 'warning'}>
									{searchMatcher.helperText}
								</p>
							{/if}
						</div>
						<p class="results-count">
							{displayedThreads.length} shared dialogue
							thread{displayedThreads.length !== 1 ? 's' : ''} with depth {threshold}+
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
						{highlightedThread}
						{collapsedByRootUri}
						oncollapsedchange={setThreadCollapsed}
						onexpand={handleExpand}
						onshare={handleShare}
						onopenbluesky={handleOpenOnBluesky}
						scrollToRootUri={pendingScrollToRootUri}
						onscrolltorooturicomplete={handleScrollToRootUriComplete}
					/>
				{:else if !loading}
					<div class="empty-state">
						{#if allThreads.length === 0}
							<p>No shared dialogue chains found.</p>
							<p class="empty-hint">Try loading more of each feed or picking a different pair.</p>
						{:else}
							<p>No threads match the current filters.</p>
							<p class="empty-hint">Try lowering the minimum depth or adjusting the date range.</p>
						{/if}
					</div>
				{/if}
			</section>
		{/if}

		{#if !loading && !hasSearched}
			<section class="welcome">
				<p>Pick two Bluesky users above to stitch their author feeds into shared reply chains.</p>
				<p class="hint">This view only keeps combined threads that include both selected people.</p>
			</section>
		{/if}
	{/if}
</main>

<style>
	main {
		max-width: 880px;
		margin: 0 auto;
		padding: 32px 20px;
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

	.subtitle {
		color: var(--muted);
		font-size: 1.1rem;
	}

	.search-section {
		margin-bottom: 32px;
	}

	.dialogue-search-grid {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 16px;
		align-items: start;
	}

	.search-slot {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.search-slot-label {
		font-size: 0.9rem;
		font-weight: 700;
		color: var(--muted);
		padding-left: 4px;
	}

	.build-row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 10px;
		margin-top: 14px;
		justify-content: center;
	}

	.build-btn {
		padding: 10px 18px;
		background: var(--accent);
		color: white;
		border-color: var(--text-ink);
		font-size: 1rem;
	}

	.options-row {
		margin-top: 10px;
		text-align: center;
	}

	.panel-detail {
		margin-top: 8px;
	}

	.expanded-wide {
		width: 100vw;
		margin-left: calc(-50vw + 50%);
	}

	.expanded-actions {
		display: flex;
		gap: 8px;
		margin-bottom: 16px;
	}

	.view-toggle {
		display: flex;
		gap: 4px;
		margin-left: auto;
	}

	.view-toggle-btn,
	.back-btn,
	.copy-link-btn,
	.refetch-btn,
	.cancel-btn {
		padding: 6px 14px;
		font-size: 0.9rem;
		background: var(--card-bg);
		color: var(--accent);
		border-color: var(--accent);
		cursor: pointer;
	}

	.view-toggle-btn.active {
		background: var(--accent);
		color: white;
	}

	.truncation-warning {
		margin: 0 0 12px;
		color: var(--accent);
		font-size: 0.92rem;
	}

	.results-header {
		display: flex;
		flex-direction: column;
		gap: 14px;
		margin-bottom: 16px;
	}

	.dialogue-author-row {
		display: flex;
		flex-wrap: wrap;
		gap: 12px;
	}

	.author-info {
		display: inline-flex;
		align-items: center;
		gap: 10px;
		padding: 10px 14px;
		background: rgba(255, 252, 245, 0.86);
		border: 1px solid rgba(61, 64, 91, 0.14);
		border-radius: 999px;
		box-shadow: 0 10px 24px rgba(26, 35, 44, 0.06);
	}

	.author-avatar {
		width: 38px;
		height: 38px;
		border-radius: 50%;
		object-fit: cover;
	}

	.author-handle {
		color: var(--muted);
		margin-left: 6px;
		font-size: 0.85rem;
	}

	.stats-bar {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		color: var(--muted);
		font-size: 0.95rem;
	}

	.stats-sep {
		opacity: 0.5;
	}

	.refetch-row {
		display: flex;
		flex-wrap: wrap;
		gap: 10px;
	}

	.cache-grid {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 14px;
	}

	.cache-card {
		padding: 14px 16px;
		background: var(--card-bg);
	}

	.cache-card-title {
		margin: 0 0 6px;
		font-weight: 700;
	}

	.cache-card-count {
		margin: 0 0 8px;
		color: var(--muted);
		font-size: 0.95rem;
	}

	.search-filter {
		max-width: 640px;
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

	.results-count,
	.date-filter-info {
		margin: 0;
		color: var(--muted);
	}

	.cancel-row {
		margin: 10px 0 16px;
	}

	.empty-state,
	.welcome {
		padding: 26px 22px;
		border-radius: 18px;
		background: rgba(255, 252, 245, 0.88);
		border: 1px solid rgba(61, 64, 91, 0.12);
		text-align: center;
	}

	.empty-hint,
	.hint {
		margin: 8px 0 0;
		color: var(--muted);
	}

	@media (max-width: 760px) {
		main {
			padding: 24px 16px;
		}

		.dialogue-search-grid,
		.cache-grid {
			grid-template-columns: 1fr;
		}

		.expanded-actions {
			flex-wrap: wrap;
		}

		.view-toggle {
			margin-left: 0;
		}
	}
</style>
