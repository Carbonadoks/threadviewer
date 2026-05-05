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
	import type { SelfReplyThread, AuthorInfo, DiscoverProgress, ThreadPost } from '$lib/types';
	import type { ProfileInfo } from '$lib/api/bluesky';
	import { getProfile, getFullThread } from '$lib/api/bluesky';
	import CachedUsers from '$lib/components/CachedUsers.svelte';
	import { discoverThreads } from '$lib/utils/threadWalker';
		import {
			CACHE_CHUNK_SIZE,
			fetchCachedHeadBatchPage,
			fetchCachedChunkPage,
			fetchNewPosts,
			fetchOlderPosts,
		fetchPostMeta
	} from '$lib/api/cache';
	import { toastError, toastWarning, toastSuccess, toastInfo } from '$lib/utils/toasts';
	import GroupChat from '$lib/components/GroupChat.svelte';
	import BoardView from '$lib/components/BoardView.svelte';
	import ParallelBoardView from '$lib/components/ParallelBoardView.svelte';
	import FontPicker from '$lib/components/FontPicker.svelte';
	import ThreadJudgePanel from '$lib/components/ThreadJudgePanel.svelte';
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
	const INITIAL_SEARCH_TARGET = 1000;
	const INITIAL_UNCACHED_FETCH = 1000;
	const LOAD_OLDER_BATCH = 500;
	const LOAD_NEW_BATCH = 500;
	const CACHE_BUCKET_LIMIT_GB = 9;

	let fontKey = $state('patrick');
	let fontFamily = $derived(fontFamilies[fontKey] ?? fontFamilies.virgil);

	let renderMode = $state<RenderMode>('default');
	let shattering = $state(false);
	let appearing = $state(false);
	let pendingMode: RenderMode | null = $state(null);

	let allThreads: SelfReplyThread[] = $state([]);
	let author: AuthorInfo | null = $state(null);
	let threshold = $state(2);
	let loading = $state(false);
	let error: string | null = $state(null);
	let progress: DiscoverProgress = $state({ phase: '', current: 0, total: 0 });
	let hasSearched = $state(false);
	let initialHandle = $state('');

	// Profile from typeahead selection
	let selectedProfile: ProfileInfo | null = $state(null);
	let maxPosts = $state(100000);

	// Cache status
		let cachedPostCount = $state(0);
		let cacheReachedEnd = $state(false);
		let cacheLimitReached = $state(false);

	// Text search
	let searchQuery = $state('');

	// Date filters (client-side only)
	let dateFrom = $state('');
	let dateTo = $state('');

	// Stats from last search
	let stats = $state({ postsScanned: 0, chainStarts: 0, threadsWithSelfReplies: 0 });
	let lastFeedPosts: any[] = $state([]);
	let newPostsCursor: string | null = $state(null);
	let newPostsAnchorUri: string | null = $state(null);

	// Abort controller for cancel
	let abortController: AbortController | null = $state(null);

	// Full thread expansion state
	let expandedThread: (SelfReplyThread & { isTruncated?: boolean }) | null = $state(null);
	let expandedLoading = $state(false);
	let showExpanded = $state(false);
	let savedScrollY = 0;

	// Highlight state for shared thread links
	let highlightedThread: string | null = $state(null);
	let pendingScrollToRootUri: string | null = $state(null);
	let collapsedByRootUri = $state<Record<string, boolean>>({});
	let activeThreadUrl: string | null = $state(null);
	let threadOnlyMode = $state(false);
	let threadOnlyReturnTo: string | null = $state(null);

	// Expanded panel view mode
	let expandedViewMode: 'chat' | 'board' | 'parallel' | 'judge' = $state('chat');

	type SearchMatcherMode = 'none' | 'literal' | 'regex';
	type SearchMatcherTone = 'info' | 'warning';

	type ThreadSearchMatcher = {
		mode: SearchMatcherMode;
		literal: string | null;
		regex: RegExp | null;
		helperText: string | null;
		helperTone: SearchMatcherTone | null;
	};

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
		const pattern = query.slice(1, closingSlash);
		const flags = query.slice(closingSlash + 1);

		return { pattern, flags };
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

	function currentCachedLoadedCount(): number {
		return Math.min(lastFeedPosts.length, cachedPostCount);
	}

	async function reloadCachedPrefix(did: string, targetPosts: number, signal: AbortSignal): Promise<any[]> {
		const boundedTarget = Math.max(0, Math.min(maxPosts, targetPosts));
		if (boundedTarget <= 0) return [];
		return loadCachedPostsInChunks(did, boundedTarget, signal);
	}

	async function refreshCacheStatus(did: string) {
		const status = await fetchPostMeta(did);
		if (selectedProfile?.did !== did) return status;
		cachedPostCount = status.postCount;
		cacheReachedEnd = status.reachedEnd;
		return status;
	}

	async function rebuildThreadsFromFeed(did: string, feedPosts: any[], signal: AbortSignal) {
		const rebuiltThreads: SelfReplyThread[] = [];
		const result = await discoverThreads(
			did,
			maxPosts,
			{
				onProgress(p) {
					progress = p;
				},
				onThread(thread) {
					rebuiltThreads.push(thread);
				}
			},
			signal,
			feedPosts
		);
		allThreads = rebuiltThreads;
		stats = result.stats;
		lastFeedPosts = result.feedPosts;
		return result;
	}

	const searchMatcher = $derived(buildSearchMatcher(searchQuery));

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

	const sortedThreads = $derived([...allThreads].sort((a, b) => b.depth - a.depth));

	const displayedThreads = $derived(
		sortedThreads.filter(
			(t) => t.depth >= threshold && isInDateRange(t.rootPost.createdAt) && matchesSearch(t, searchMatcher)
		)
	);

	const olderCacheFullyLoaded = $derived(
		hasLoadedCompleteCachedFeed({
			currentFeedPosts: lastFeedPosts,
			cachedPostCount,
			cacheReachedEnd,
			maxPosts
		})
	);

	const cacheStatusExplainer = $derived.by(() => {
		if (!selectedProfile) return null;

		if (cachedPostCount > 0) {
			if (cacheReachedEnd) {
				if (cacheLimitReached) {
					return `This account is cached through its oldest available post, but the shared R2 bucket is already at its ${CACHE_BUCKET_LIMIT_GB} GB cap. Reads still work, but new cache writes are paused.`;
				}

				return `This account is cached through its oldest available post. New syncs still cache newer posts at the head.`;
			}

			if (cacheLimitReached) {
				return `${cachedPostCount.toLocaleString()} posts are cached so far, but the shared R2 bucket is already at its ${CACHE_BUCKET_LIMIT_GB} GB cap. Older fetches continue live, but they will not be written back into cache until space is freed.`;
			}

			return `${cachedPostCount.toLocaleString()} posts are cached so far. Older fetches resume from the current cache cursor until the first post.`;
		}

		if (cacheLimitReached) {
			return `Caching is paused because the shared R2 bucket has reached its ${CACHE_BUCKET_LIMIT_GB} GB cap. Live fetches still work, but this account will stay uncached until space is freed.`;
		}

		return `This account is not cached yet. The first older or new fetch that writes data will create the cache and enroll the account, unless the shared R2 bucket has already reached its ${CACHE_BUCKET_LIMIT_GB} GB cap.`;
	});

	const maxDepth = $derived(
		allThreads.length > 0 ? Math.max(...allThreads.map((t) => t.depth)) : 2
	);

	function normalizeHandle(handle: string | null | undefined): string {
		return (handle ?? '').replace(/^@/, '').trim();
	}

	function normalizeReturnTo(target: string | null | undefined): string | null {
		const trimmed = (target ?? '').trim();
		if (!trimmed) return null;

		if (trimmed.startsWith('/') && !trimmed.startsWith('//')) {
			return trimmed;
		}

		if (!browser) return null;

		try {
			const parsed = new URL(trimmed, window.location.origin);
			if (parsed.origin !== window.location.origin) return null;
			return `${parsed.pathname}${parsed.search}${parsed.hash}`;
		} catch {
			return null;
		}
	}

	function threadOnlyBackLabel(): string {
		if (threadOnlyReturnTo?.startsWith('/summary2')) return 'Back to repo summary';
		if (threadOnlyReturnTo?.startsWith('/summary')) return 'Back to summary';
		return 'Back';
	}

	function updateRouteState(
		options: {
			handle?: string | null;
			threadUrl?: string | null;
			threadOnly?: boolean;
			returnTo?: string | null;
		} = {}
	) {
		if (!browser) return;

		const url = new URL(window.location.href);

		const nextThreadUrl = options.threadUrl ? normalizeBskyPostUrl(options.threadUrl) : null;
		const nextThreadOnly = Boolean(nextThreadUrl && options.threadOnly);
		const nextReturnTo = nextThreadOnly
			? normalizeReturnTo(options.returnTo ?? threadOnlyReturnTo)
			: null;
		if (nextThreadUrl) {
			url.searchParams.set('url', nextThreadUrl);
			url.searchParams.delete('handle');
			url.searchParams.delete('thread');
			if (nextThreadOnly) {
				url.searchParams.set('view', 'thread');
				if (nextReturnTo) {
					url.searchParams.set('returnTo', nextReturnTo);
				} else {
					url.searchParams.delete('returnTo');
				}
			} else {
				url.searchParams.delete('view');
				url.searchParams.delete('returnTo');
			}
		} else {
			const nextHandle = normalizeHandle(options.handle);
			url.searchParams.delete('url');
			url.searchParams.delete('thread');
			url.searchParams.delete('view');
			url.searchParams.delete('returnTo');
			if (nextHandle) {
				url.searchParams.set('handle', nextHandle);
			} else {
				url.searchParams.delete('handle');
			}
		}

		url.searchParams.delete('from');
		url.searchParams.delete('to');
		window.history.replaceState({}, '', url.toString());
		activeThreadUrl = nextThreadUrl;
	}

	function applyCacheLimitState(limitReached: boolean) {
		if (!limitReached) return;
		if (!cacheLimitReached) {
			toastWarning(
				`The shared R2 cache bucket is full at ${CACHE_BUCKET_LIMIT_GB} GB. Live fetches still work, but new cache writes are paused.`
			);
		}
		cacheLimitReached = true;
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

	async function handleProfileSelected(profile: ProfileInfo) {
		const isNewProfile = selectedProfile?.did !== profile.did;
		selectedProfile = profile;
		initialHandle = profile.handle;
		maxPosts = 100000;
		author = {
			did: profile.did,
			handle: profile.handle,
			displayName: profile.displayName,
			avatar: profile.avatar
		};
		// Reset cache status only when switching to a different profile
			if (isNewProfile) {
				cachedPostCount = 0;
				cacheReachedEnd = false;
				cacheLimitReached = false;
				lastFeedPosts = [];
				newPostsCursor = null;
				newPostsAnchorUri = null;
		}
		try {
			const status = await fetchPostMeta(profile.did);
			// Only update if this profile is still selected (avoid stale updates)
			if (selectedProfile?.did === profile.did) {
				cachedPostCount = status.postCount;
				cacheReachedEnd = status.reachedEnd;
			}
		} catch {
			toastWarning('Could not check cache status');
			if (selectedProfile?.did === profile.did) {
				cachedPostCount = 0;
				cacheReachedEnd = false;
			}
		}
	}

	async function handleSearch(
		handle: string,
		options: {
			profile?: ProfileInfo | null;
			threadUrl?: string | null;
		} = {}
	): Promise<boolean> {
		const cleaned = normalizeHandle(handle);
		if (!cleaned || loading) return false;

		loading = true;
		error = null;
		allThreads = [];
		collapsedByRootUri = {};
		pendingScrollToRootUri = null;
		highlightedThread = null;
		showExpanded = false;
		expandedThread = null;
		expandedLoading = false;
		expandedViewMode = 'chat';
		hasSearched = true;
		stats = { postsScanned: 0, chainStarts: 0, threadsWithSelfReplies: 0 };
			lastFeedPosts = [];
			newPostsCursor = null;
			newPostsAnchorUri = null;
			cacheLimitReached = false;
			let success = false;

		const controller = new AbortController();
		abortController = controller;

		const requestedThreadUrl = options.threadUrl ? normalizeBskyPostUrl(options.threadUrl) : null;
		updateRouteState({
			handle: cleaned,
			threadUrl: requestedThreadUrl
		});

		try {
			let profile = options.profile;
			if (!profile || (normalizeHandle(profile.handle) !== cleaned && profile.did !== cleaned)) {
				profile = await getProfile(cleaned);
			}

			await handleProfileSelected(profile);
			if (!profile) {
				throw new Error('Profile is not available.');
			}

			updateRouteState({
				handle: profile.handle,
				threadUrl: requestedThreadUrl
			});

			const did = profile.did;
			const boundedTarget = Math.min(maxPosts, profile.postsCount || maxPosts);
			const initialTarget = Math.min(INITIAL_SEARCH_TARGET, boundedTarget);
			const status = await refreshCacheStatus(did).catch(() => ({
				postCount: 0,
				reachedEnd: false,
				updatedAt: null,
				chunkCount: 0,
				cursor: null
			}));

			let feedPosts: any[] = [];
			if (status.postCount > 0) {
				feedPosts = await loadCachedPostsInChunks(did, initialTarget, controller.signal);
			} else {
				progress = {
					phase: 'Fetching initial posts...',
					current: 0,
					total: INITIAL_UNCACHED_FETCH
				};
				const older = await fetchOlderPosts(
					did,
					{
						cursor: null,
						limitPosts: INITIAL_UNCACHED_FETCH,
						postsCount: profile.postsCount
					},
					controller.signal
				);
				applyCacheLimitState(older.cache.limitReached);
				feedPosts = older.posts;
				await refreshCacheStatus(did).catch(() => {});
			}

			const rebuilt = await rebuildThreadsFromFeed(did, feedPosts, controller.signal);
			if (rebuilt.stats.threadsWithSelfReplies > 0) {
				toastSuccess(
					`Found ${rebuilt.stats.threadsWithSelfReplies} thread${rebuilt.stats.threadsWithSelfReplies !== 1 ? 's' : ''}`
				);
			} else {
				toastInfo('No self-reply threads found');
			}
			success = true;
		} catch (e: any) {
			if (e?.message?.includes('Unable to resolve handle') || e?.message?.includes('Profile not found')) {
				error = `Could not find handle "${cleaned}". Make sure it's a valid Bluesky handle.`;
			} else if (e?.message?.includes('fetch')) {
				error = 'Network error. Please check your connection and try again.';
			} else {
				error = e?.message || 'An unexpected error occurred.';
			}
		} finally {
			loading = false;
			abortController = null;
			// Refresh cache status after search (R2 was updated)
			if (selectedProfile) {
				const did = selectedProfile.did;
				refreshCacheStatus(did).catch(() => {});
			}
		}

		return success;
	}

	async function handleCheckNewPosts() {
		if (loading || !selectedProfile) return;
		if (lastFeedPosts.length === 0) {
			await handleSearch(selectedProfile.handle);
			return;
		}

		loading = true;
		error = null;
		hasSearched = true;
		progress = {
			phase: 'Checking for new posts...',
			current: 0,
			total: LOAD_NEW_BATCH
		};

		const controller = new AbortController();
		abortController = controller;
		const did = selectedProfile.did;
		const requestAnchorUri = getNewPostsAnchorUri(lastFeedPosts, newPostsCursor, newPostsAnchorUri);

		try {
			const result = await fetchNewPosts(
				did,
				{
					sinceUri: requestAnchorUri,
					cursor: newPostsCursor,
					limit: LOAD_NEW_BATCH,
					postsCount: selectedProfile.postsCount
				},
				controller.signal
			);
			applyCacheLimitState(result.cache.limitReached);

			const nextSyncState = getNextNewPostsSyncState(
				requestAnchorUri,
				result.hasMore,
				result.nextCursor
			);
			newPostsCursor = nextSyncState.newPostsCursor;
			newPostsAnchorUri = nextSyncState.newPostsAnchorUri;

			const reloadedFeedPosts = result.cache.written
				? await reloadCachedPrefix(
						did,
						Math.min(maxPosts, lastFeedPosts.length + result.posts.length),
						controller.signal
					)
				: null;
			const resolved = resolveViewerFeedUpdate({
				currentFeedPosts: lastFeedPosts,
				incomingPosts: result.posts,
				mode: 'prepend',
				cacheWritten: result.cache.written,
				reloadedFeedPosts
			});
			if (result.cache.written) {
				cachedPostCount = result.cache.postCount;
				cacheReachedEnd = result.cache.reachedEnd;
			}
			if (resolved.added > 0) {
				await rebuildThreadsFromFeed(did, resolved.feedPosts, controller.signal);
				toastSuccess(`Loaded ${resolved.added.toLocaleString()} new posts`);
				if (result.hasMore) {
					toastInfo('More new posts are available. Click "Check new posts" again.');
				}
			} else {
				toastInfo(result.hasMore ? 'No overlap yet. Click again to continue.' : 'No new posts found');
			}
		} catch (e: any) {
			if (e?.message?.includes('fetch')) {
				error = 'Network error while checking new posts. Please try again.';
			} else {
				error = e?.message || 'Checking new posts failed.';
			}
		} finally {
			loading = false;
			abortController = null;
			refreshCacheStatus(did).catch(() => {});
		}
	}

	async function handleLoadOlderPosts() {
		if (loading || !selectedProfile) return;
		if (lastFeedPosts.length === 0) {
			await handleSearch(selectedProfile.handle);
			return;
		}
		if (olderCacheFullyLoaded) return;

		loading = true;
		error = null;
		hasSearched = true;
		progress = {
			phase: 'Loading older posts...',
			current: currentCachedLoadedCount(),
			total: Math.max(cachedPostCount, currentCachedLoadedCount() + LOAD_OLDER_BATCH)
		};

		const controller = new AbortController();
		abortController = controller;
		const did = selectedProfile.did;
		const initialCount = lastFeedPosts.length;

		try {
			const status = await refreshCacheStatus(did).catch(() => ({
				postCount: cachedPostCount,
				reachedEnd: cacheReachedEnd,
				updatedAt: null,
				chunkCount: 0,
				cursor: null
			}));
			if (
				hasLoadedCompleteCachedFeed({
					currentFeedPosts: lastFeedPosts,
					cachedPostCount: status.postCount,
					cacheReachedEnd: status.reachedEnd,
					maxPosts
				})
			) {
				return;
			}

			const cachedLoaded = currentCachedLoadedCount();
			const targetCachedPosts = Math.min(maxPosts, status.postCount);
			const overlayCount = Math.max(0, lastFeedPosts.length - cachedLoaded);
			const targetFeedPosts = targetCachedPosts + overlayCount;

			if (targetCachedPosts > cachedLoaded) {
				const mergedCached = await loadCachedPostsInChunks(
					did,
					targetFeedPosts,
					controller.signal,
					lastFeedPosts,
					cachedLoaded
				);
				if (mergedCached.length > lastFeedPosts.length) {
					await rebuildThreadsFromFeed(did, mergedCached, controller.signal);
					const addedCached = mergedCached.length - initialCount;
					toastSuccess(`Loaded ${addedCached.toLocaleString()} more cached posts`);
					return;
				}
			}

			if (status.reachedEnd) {
				toastInfo('No additional older posts available.');
				return;
			}

			const older = await fetchOlderPosts(
				did,
				{
					cursor: status.cursor,
					limitPosts: LOAD_OLDER_BATCH,
					postsCount: selectedProfile.postsCount
				},
				controller.signal
			);
			applyCacheLimitState(older.cache.limitReached);

			if (older.posts.length === 0) {
				await refreshCacheStatus(did).catch(() => {});
				toastInfo('No additional older posts available.');
				return;
			}

			const reloadedFeedPosts = older.cache.written
				? await reloadCachedPrefix(
						did,
						Math.min(maxPosts, lastFeedPosts.length + older.posts.length),
						controller.signal
					)
				: null;
			const resolved = resolveViewerFeedUpdate({
				currentFeedPosts: lastFeedPosts,
				incomingPosts: older.posts,
				mode: 'append',
				cacheWritten: older.cache.written,
				reloadedFeedPosts
			});
			if (resolved.added <= 0) {
				toastInfo('No additional older posts available.');
				return;
			}
			await rebuildThreadsFromFeed(did, resolved.feedPosts, controller.signal);
			if (older.cache.written) {
				cachedPostCount = older.cache.postCount;
				cacheReachedEnd = older.cache.reachedEnd;
			}
			toastSuccess(`Loaded ${resolved.added.toLocaleString()} older posts`);
			await refreshCacheStatus(did).catch(() => {});
			if (older.reachedEnd) {
				toastInfo('Reached the end of the available feed.');
			}
		} catch (e: any) {
			if (e?.message?.includes('fetch')) {
				error = 'Network error while loading older posts. Please try again.';
			} else {
				error = e?.message || 'Loading older posts failed.';
			}
		} finally {
			loading = false;
			abortController = null;
			refreshCacheStatus(did).catch(() => {});
		}
	}

	async function handleFetchAllOlderPosts() {
		if (loading || !selectedProfile) return;
		if (lastFeedPosts.length === 0) {
			await handleSearch(selectedProfile.handle);
			return;
		}
		if (olderCacheFullyLoaded) return;

		loading = true;
		error = null;
		hasSearched = true;

		const controller = new AbortController();
		abortController = controller;
		const did = selectedProfile.did;
		let totalFetched = 0;

		try {
			const status = await refreshCacheStatus(did).catch(() => ({
				postCount: cachedPostCount,
				reachedEnd: cacheReachedEnd,
				updatedAt: null,
				chunkCount: 0,
				cursor: null
			}));
			if (
				hasLoadedCompleteCachedFeed({
					currentFeedPosts: lastFeedPosts,
					cachedPostCount: status.postCount,
					cacheReachedEnd: status.reachedEnd,
					maxPosts
				})
			) {
				return;
			}
			const cachedLoaded = Math.min(lastFeedPosts.length, status.postCount);
			const overlayPosts = lastFeedPosts.slice(0, Math.max(0, lastFeedPosts.length - cachedLoaded));
			const targetCachedDisplayCount = Math.min(maxPosts, status.postCount);

			if (status.postCount <= 0) {
				toastInfo(
					cacheLimitReached
						? `Cache creation is paused because the shared R2 bucket has reached its ${CACHE_BUCKET_LIMIT_GB} GB cap.`
						: 'No cached cursor is available for this account yet.'
				);
				return;
			}

			if (status.reachedEnd && cachedLoaded >= targetCachedDisplayCount) {
				toastInfo('Cached feed already reaches the oldest available post.');
				return;
			}

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
							? 'Fetching all older posts into cache...'
							: `Fetching all older posts into cache... (${totalFetched.toLocaleString()} fetched)`,
					current: latestCachedCount,
					total: Math.max(selectedProfile.postsCount || 0, latestCachedCount + LOAD_OLDER_BATCH)
				};

				const older = await fetchOlderPosts(
					did,
					{
						cursor,
						limitPosts: LOAD_OLDER_BATCH,
						postsCount: selectedProfile.postsCount
					},
					controller.signal
				);
				applyCacheLimitState(older.cache.limitReached);

				requestCount += 1;
				totalFetched += older.posts.length;
				latestReachedEnd = older.reachedEnd;
				if (older.cache.written) {
					latestCachedCount = older.cache.postCount;
					cachedPostCount = older.cache.postCount;
					cacheReachedEnd = older.cache.reachedEnd;
				} else if (older.posts.length > 0) {
					latestCachedCount += older.posts.length;
					fallbackOlderPosts = mergeUniquePosts(fallbackOlderPosts, older.posts, 'append');
				}

				if (latestReachedEnd) {
					break;
				}

				if (!older.nextCursor || older.nextCursor === cursor) {
					throw new Error('Older cursor was missing before the end of the feed.');
				}
				cursor = older.nextCursor;

				if (older.posts.length === 0) {
					break;
				}
			}

			progress = {
				phase: 'Reloading full cached feed...',
				current: latestCachedCount,
				total: Math.max(selectedProfile.postsCount || 0, latestCachedCount)
			};

			const finalStatus = await refreshCacheStatus(did).catch(() => ({
				postCount: latestCachedCount,
				reachedEnd: latestReachedEnd,
				updatedAt: null,
				chunkCount: 0,
				cursor
			}));
			const reloadedCachedFeed =
				finalStatus.postCount > 0
					? await reloadCachedPrefix(did, Math.min(maxPosts, finalStatus.postCount), controller.signal)
					: [];
			let mergedFeedPosts = mergeUniquePosts(overlayPosts, reloadedCachedFeed, 'append');
			if (fallbackOlderPosts.length > 0) {
				mergedFeedPosts = mergeUniquePosts(mergedFeedPosts, fallbackOlderPosts, 'append');
			}
			if (mergedFeedPosts.length > maxPosts) {
				mergedFeedPosts.length = maxPosts;
			}

			await rebuildThreadsFromFeed(did, mergedFeedPosts, controller.signal);

			if (totalFetched > 0) {
				toastSuccess(`Fetched ${totalFetched.toLocaleString()} older posts`);
			} else if (mergedFeedPosts.length > lastFeedPosts.length) {
				toastSuccess(`Loaded ${(mergedFeedPosts.length - lastFeedPosts.length).toLocaleString()} cached posts`);
			} else {
				toastInfo('No additional older posts available.');
			}

			if (finalStatus.reachedEnd) {
				toastInfo('Reached the end of the available feed.');
			}
		} catch (e: any) {
			if (e?.message?.includes('fetch')) {
				error = 'Network error while fetching older posts. Please try again.';
			} else {
				error = e?.message || 'Fetching all older posts failed.';
			}
		} finally {
			loading = false;
			abortController = null;
			refreshCacheStatus(did).catch(() => {});
		}
	}

	async function handleCachedUserSelect(profile: ProfileInfo) {
		await handleProfileSelected(profile);
		await handleSearch(profile.handle);
	}

	function handleFontChange(key: string) {
		fontKey = key;
		try { localStorage.setItem('preferred-font', key); } catch {}
	}

	function handleModeChange(key: RenderMode) {
		if (key === renderMode || shattering) return;
		pendingMode = key;
		shattering = true;
	}

	function handleShatterEnd() {
		if (shattering && pendingMode !== null) {
			renderMode = pendingMode;
			try { localStorage.setItem('preferred-render-mode', renderMode); } catch {}
			pendingMode = null;
			shattering = false;
			appearing = true;
		}
	}

	function handleAppearEnd() {
		appearing = false;
	}

	function isRenderMode(value: string): value is RenderMode {
		return value === 'default' || value === 'chat' || value === 'conspiracy' || value === 'ransom';
	}

	async function openExpandedThread(
		uri: string,
		options: { preserveScroll?: boolean; threadOnly?: boolean; returnTo?: string | null } = {}
	): Promise<boolean> {
		if (options.preserveScroll) {
			savedScrollY = window.scrollY;
		}

		const nextThreadOnly = options.threadOnly ?? threadOnlyMode;
		const nextReturnTo = nextThreadOnly
			? normalizeReturnTo(options.returnTo ?? threadOnlyReturnTo)
			: null;

		expandedLoading = true;
		showExpanded = true;

		try {
			expandedThread = await getFullThread(uri);
			const canonicalThreadUrl =
				buildBskyPostUrl(expandedThread.rootUri, expandedThread.rootPost.author.handle) ??
				buildBskyPostUrl(uri);
			updateRouteState({
				handle: selectedProfile?.handle || initialHandle,
				threadUrl: canonicalThreadUrl,
				threadOnly: nextThreadOnly,
				returnTo: nextReturnTo
			});
			return true;
		} catch (e: any) {
			toastError(e?.message || 'Failed to load full thread.');
			showExpanded = false;
			expandedThread = null;
			updateRouteState({
				handle: selectedProfile?.handle || initialHandle,
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
		if (threadOnlyMode && threadOnlyReturnTo && browser) {
			window.location.assign(threadOnlyReturnTo);
			return;
		}

		showExpanded = false;
		expandedThread = null;
		expandedViewMode = 'chat';
		if (threadOnlyMode) {
			threadOnlyMode = false;
			threadOnlyReturnTo = null;
		}
		updateRouteState({
			handle: selectedProfile?.handle || initialHandle,
			threadUrl: null
		});
		// Restore scroll position after DOM updates
		requestAnimationFrame(() => {
			window.scrollTo(0, savedScrollY);
		});
	}

	async function copyThreadLink() {
		try {
			if (!expandedThread) return;
			const bskyUrl = buildBskyPostUrl(
				expandedThread.rootUri,
				expandedThread.rootPost.author.handle
			);
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
			if (!bskyUrl) {
				toastError('Could not build a share link for this thread.');
				return;
			}
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
		if (!bskyUrl) {
			toastError('Could not build Bluesky link for this thread.');
			return;
		}

		const opened = window.open(bskyUrl, '_blank', 'noopener,noreferrer');
		if (!opened) {
			toastInfo('Allow popups to open this thread in a new tab.');
		}
	}

	async function restoreSharedThread(
		threadUrl: string,
		fallbackHandle?: string | null,
		options: { threadOnly?: boolean; returnTo?: string | null } = {}
	) {
		const normalizedThreadUrl = normalizeBskyPostUrl(threadUrl);
		const parsed = normalizedThreadUrl ? parseBskyPostUrl(normalizedThreadUrl) : null;
		if (!normalizedThreadUrl || !parsed) {
			toastInfo('Could not parse thread details from the shared URL.');
			return;
		}

		const actor = normalizeHandle(fallbackHandle ?? parsed.handle);
		initialHandle = actor;

		let profile: ProfileInfo;
		try {
			profile = await getProfile(actor);
		} catch {
			toastInfo('Could not load profile from URL');
			return;
		}

		if (options.threadOnly) {
			threadOnlyMode = true;
			threadOnlyReturnTo = normalizeReturnTo(options.returnTo);
			selectedProfile = profile;
			initialHandle = profile.handle;
			showExpanded = false;
			expandedThread = null;
			expandedLoading = false;
			hasSearched = false;
			loading = false;
			error = null;
			allThreads = [];
			highlightedThread = null;
			pendingScrollToRootUri = null;
			collapsedByRootUri = {};
		} else {
			threadOnlyMode = false;
			threadOnlyReturnTo = null;
			await handleProfileSelected(profile);
		}

		const targetUri = buildAtUri(profile.did, parsed.rkey);
		if (!targetUri) {
			toastInfo('Could not derive a valid thread URI from the shared URL.');
			return;
		}

		if (options.threadOnly) {
			updateRouteState({
				handle: profile.handle,
				threadUrl: normalizedThreadUrl,
				threadOnly: true,
				returnTo: threadOnlyReturnTo
			});
			await openExpandedThread(targetUri, {
				threadOnly: true,
				returnTo: threadOnlyReturnTo
			});
			return;
		}

		const loaded = await handleSearch(profile.handle, {
			profile,
			threadUrl: normalizedThreadUrl
		});
		if (!loaded) return;

		const matchedThread = findThreadForUri(targetUri);
		if (matchedThread) {
			const canonicalThreadUrl = threadToBlueskyUrl(matchedThread.rootUri) ?? normalizedThreadUrl;
			updateRouteState({
				handle: profile.handle,
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
			const savedMode = localStorage.getItem('preferred-render-mode');
			if (savedMode && isRenderMode(savedMode)) renderMode = savedMode;
		} catch {}

		const params = new URLSearchParams(window.location.search);
		const urlParam = params.get('url');
		const handleParam = params.get('handle');
		const viewParam = params.get('view');
		const returnToParam = params.get('returnTo');
		const threadParam = params.get('thread');
		const fromParam = params.get('from');
		const toParam = params.get('to');
		if (fromParam) dateFrom = fromParam;
		if (toParam) dateTo = toParam;

		if (urlParam) {
			if (viewParam === 'thread') {
				await restoreSharedThread(urlParam, null, {
					threadOnly: true,
					returnTo: returnToParam
				});
				return;
			}
			await restoreSharedThread(urlParam);
			return;
		}

		if (handleParam && threadParam) {
			const legacyUrl = buildBskyPostUrl(threadParam, handleParam);
			if (legacyUrl) {
				await restoreSharedThread(legacyUrl, handleParam);
				return;
			}
		}

		if (handleParam) {
			const normalizedHandle = normalizeHandle(handleParam);
			initialHandle = normalizedHandle;
			try {
				const profile = await getProfile(normalizedHandle);
				await handleProfileSelected(profile);
				await handleSearch(profile.handle, { profile });
			} catch {
				toastInfo('Could not load profile from URL');
			}
		}
	});
</script>

<svelte:head>
	<title>Bluesky Thread Viewer</title>
</svelte:head>

<main style="font-family: {fontFamily}">
	<header>
		<RouteNav
			current="threadviewer"
			align="center"
			threadUrl={activeThreadUrl}
			handle={selectedProfile?.handle || initialHandle}
		/>
		<h1>Bluesky Thread Viewer</h1>
		<p class="subtitle">
			{threadOnlyMode
				? 'Viewing one hydrated thread without loading the full account feed.'
				: 'Discover long self-reply threads'}
		</p>
		<FontPicker value={fontKey} onchange={handleFontChange} />
	</header>

	{#if !threadOnlyMode}
	<section class="search-section">
		<SearchBar onsearch={handleSearch} onprofile={handleProfileSelected} disabled={loading} {initialHandle} />

		{#if selectedProfile}
			<div class="post-slider wobbly-border-light">
				<label for="max-posts">
					{#if cacheReachedEnd}
						All <strong>{cachedPostCount.toLocaleString()}</strong> posts cached
					{:else}
						{selectedProfile.postsCount.toLocaleString()} posts{#if cachedPostCount > 0} ({cachedPostCount.toLocaleString()} cached){/if}
					{/if}
				</label>
			</div>
		{/if}

		<div class="options-row">
			<CachedUsers onselect={handleCachedUserSelect} />
			<SearchOptions bind:dateFrom bind:dateTo />
		</div>
	</section>
	{/if}

	{#if error}
		<ErrorBanner message={error} />
	{/if}

	{#if showExpanded}
		<div class="panel-detail">
			{#if expandedLoading}
				<LoadingSpinner progress={{ phase: 'Loading full thread...', current: 0, total: 0 }} />
			{:else if expandedThread}
				<div class="expanded-actions">
					<button class="back-btn wobbly-border" onclick={handleBack}>
						&#8592; {threadOnlyMode ? threadOnlyBackLabel() : 'Back to threads'}
					</button>
					<button class="copy-link-btn wobbly-border" onclick={copyThreadLink}>Copy link</button>
					<div class="view-toggle">
						<button class="view-toggle-btn wobbly-border" class:active={expandedViewMode === 'chat'} onclick={() => expandedViewMode = 'chat'}>Chat</button>
						<button class="view-toggle-btn wobbly-border" class:active={expandedViewMode === 'board'} onclick={() => expandedViewMode = 'board'}>Board</button>
						<button class="view-toggle-btn wobbly-border" class:active={expandedViewMode === 'parallel'} onclick={() => expandedViewMode = 'parallel'}>Parallel</button>
						{#if !threadOnlyMode}
							<button class="view-toggle-btn wobbly-border" class:active={expandedViewMode === 'judge'} onclick={() => expandedViewMode = 'judge'}>Judge</button>
						{/if}
					</div>
				</div>
				{#if expandedThread.isTruncated}
					<p class="truncation-warning">Some replies may be missing</p>
				{/if}
				<div class="expanded-thread" class:expanded-thread--wide={expandedViewMode === 'board' || expandedViewMode === 'parallel'}>
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

					{#if !loading && stats.postsScanned > 0}
						<div class="stats-bar">
							<span>{stats.postsScanned} posts scanned</span>
							<span class="stats-sep">/</span>
							<span>{stats.chainStarts} chains found</span>
							<span class="stats-sep">/</span>
							<span>{stats.threadsWithSelfReplies} with self-replies</span>
						</div>
					{/if}

					{#if selectedProfile}
						<div class="refetch-row">
							<button class="refetch-btn wobbly-border" onclick={handleCheckNewPosts} disabled={loading}>
								{loading ? 'Working...' : 'Check new posts'}
							</button>
							<button
								class="refetch-btn wobbly-border"
								onclick={handleLoadOlderPosts}
								disabled={loading || olderCacheFullyLoaded}
							>
								{loading ? 'Working...' : 'Load older posts'}
							</button>
								<button
									class="refetch-btn wobbly-border"
									onclick={handleFetchAllOlderPosts}
									disabled={loading || olderCacheFullyLoaded}
								>
									{loading ? 'Working...' : 'Fetch all older posts'}
								</button>
							</div>
							<div class="cache-explainer wobbly-border-light">
								<p class="cache-explainer-title">How caching works</p>
								<p>{cacheStatusExplainer}</p>
								<p><strong>Check new posts</strong> syncs newer posts since the current loaded head.</p>
								<p><strong>Load older posts</strong> loads older cached posts first, then fetches one older batch.</p>
								<p><strong>Fetch all older posts</strong> keeps walking from the current cache cursor until the first post.</p>
						</div>
					{/if}

					{#if allThreads.length > 0}
						<ThresholdControl bind:value={threshold} min={1} max={Math.max(maxDepth, 2)} />
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
							{displayedThreads.length} thread{displayedThreads.length !== 1 ? 's' : ''} with depth {threshold}+
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
						{shattering}
						{appearing}
						{collapsedByRootUri}
						oncollapsedchange={setThreadCollapsed}
						onexpand={handleExpand}
						onshare={handleShare}
						onopenbluesky={handleOpenOnBluesky}
						scrollToRootUri={pendingScrollToRootUri}
						onscrolltorooturicomplete={handleScrollToRootUriComplete}
						onshatterend={handleShatterEnd}
						onappearend={handleAppearEnd}
					/>
				{:else if !loading}
					<div class="empty-state">
						{#if allThreads.length === 0}
							<p>No self-reply threads found.</p>
							<p class="empty-hint">Try increasing the number of posts to scan.</p>
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
				<p>Enter a Bluesky handle above to find their longest self-reply threads.</p>
				<p class="hint">A self-reply thread is when someone replies to their own posts in a chain.</p>
			</section>
		{/if}
	{/if}
</main>

<style>
	main {
		max-width: 800px;
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

	.options-row {
		margin-top: 8px;
		text-align: center;
	}

	.post-slider {
		max-width: 600px;
		margin: 12px auto 0;
		padding: 12px 20px;
		background: var(--card-bg);
		display: flex;
		align-items: center;
		gap: 12px;
		flex-wrap: wrap;
	}

	.post-slider label {
		min-width: 160px;
		font-size: 0.95rem;
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

	.view-toggle {
		display: flex;
		gap: 4px;
		margin-left: auto;
	}

	.view-toggle-btn {
		padding: 6px 14px;
		font-size: 0.9rem;
		background: var(--card-bg);
		color: var(--muted);
		border-color: var(--muted);
		cursor: pointer;
		transition: background 0.2s, color 0.2s;
	}

	.view-toggle-btn.active {
		background: var(--accent);
		color: white;
		border-color: var(--accent);
	}

	.view-toggle-btn:hover:not(.active) {
		opacity: 0.7;
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

	.refetch-row {
		display: flex;
		justify-content: center;
		gap: 10px;
		flex-wrap: wrap;
		margin-bottom: 12px;
	}

	.cache-explainer {
		max-width: 640px;
		margin: 0 auto 14px;
		padding: 12px 18px;
		background: var(--card-bg);
		text-align: left;
		color: var(--muted);
		font-size: 0.86rem;
		line-height: 1.45;
	}

	.cache-explainer p {
		margin: 0;
	}

	.cache-explainer p + p {
		margin-top: 6px;
	}

	.cache-explainer strong {
		color: var(--text-ink);
	}

	.cache-explainer-title {
		font-size: 0.9rem;
		font-weight: 700;
		color: var(--text-ink);
	}

	.refetch-btn {
		padding: 6px 16px;
		font-size: 0.9rem;
		background: var(--card-bg);
		color: var(--text-ink);
		border-color: var(--muted);
		cursor: pointer;
	}

	.refetch-btn:hover:not(:disabled) {
		opacity: 0.75;
	}

	.refetch-btn:disabled {
		opacity: 0.55;
		cursor: not-allowed;
	}

	.stats-sep {
		opacity: 0.4;
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
