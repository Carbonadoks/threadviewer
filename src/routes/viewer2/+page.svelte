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
	import { loadRepoFeedItems, type RepoDownloadProgress } from '$lib/utils/repoHydration';
	import { buildThreadsFromFeed } from '$lib/utils/threadWalker';
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

	const fontFamilies: Record<string, string> = {
		virgil: "'Virgil', cursive",
		caveat: "'Caveat', cursive",
		patrick: "'Patrick Hand', cursive",
		'comic-neue': "'Comic Neue', cursive",
		inter: "'Inter', sans-serif",
		system: "system-ui, -apple-system, sans-serif"
	};

	type RenderMode = 'default' | 'chat' | 'conspiracy' | 'ransom';
	type RepoStats = {
		totalPosts: number;
		elapsedMs: number;
		downloadedBytes: number;
		source: 'pds' | 'relay' | null;
	};

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

	let selectedProfile: ProfileInfo | null = $state(null);

	// Text search
	let searchQuery = $state('');

	// Date filters
	let dateFrom = $state('');
	let dateTo = $state('');

	// Stats
	let stats = $state({ postsScanned: 0, chainStarts: 0, threadsWithSelfReplies: 0 });
	let repoStats = $state<RepoStats>({
		totalPosts: 0,
		elapsedMs: 0,
		downloadedBytes: 0,
		source: null
	});

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

	// Expanded thread state
	let expandedThread: (SelfReplyThread & { isTruncated?: boolean }) | null = $state(null);
	let expandedLoading = $state(false);
	let showExpanded = $state(false);
	let savedScrollY = 0;

	// Highlight state
	let highlightedThread: string | null = $state(null);
	let pendingScrollToRootUri: string | null = $state(null);
	let collapsedByRootUri = $state<Record<string, boolean>>({});
	let activeThreadUrl: string | null = $state(null);

	// Expanded panel view mode
	let expandedViewMode: 'chat' | 'board' | 'parallel' | 'judge' = $state('chat');

	type SearchMatcherMode = 'none' | 'literal' | 'regex';

	type ThreadSearchMatcher = {
		mode: SearchMatcherMode;
		literal: string | null;
		regex: RegExp | null;
		helperText: string | null;
		helperTone: 'info' | 'warning' | null;
	};

	function buildSearchMatcher(query: string): ThreadSearchMatcher {
		const trimmed = query.trim();
		if (!trimmed) {
			return { mode: 'none', literal: null, regex: null, helperText: null, helperTone: null };
		}

		if (!trimmed.startsWith('/')) {
			return { mode: 'literal', literal: trimmed.toLowerCase(), regex: null, helperText: null, helperTone: null };
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
			return { mode: 'literal', literal: trimmed.toLowerCase(), regex: null, helperText: null, helperTone: 'info' };
		}

		try {
			const pattern = trimmed.slice(1, closingSlash);
			const rawFlags = trimmed.slice(closingSlash + 1).toLowerCase();
			const flags = rawFlags.includes('i') ? rawFlags : `${rawFlags}i`;
			const regex = new RegExp(pattern, flags);
			return { mode: 'regex', literal: null, regex, helperText: null, helperTone: null };
		} catch {
			return { mode: 'literal', literal: trimmed.toLowerCase(), regex: null, helperText: 'Invalid regex, using literal search.', helperTone: 'warning' };
		}
	}

	function matchesSearch(thread: SelfReplyThread, matcher: ThreadSearchMatcher): boolean {
		if (matcher.mode === 'none') return true;
		const regex = matcher.mode === 'regex' ? matcher.regex : null;
		const literal = matcher.mode === 'literal' ? matcher.literal : null;

		function check(post: ThreadPost): boolean {
			if (regex) { regex.lastIndex = 0; if (regex.test(post.text)) return true; }
			else if (literal && post.text.toLowerCase().includes(literal)) return true;
			return post.children.some(check);
		}
		return check(thread.rootPost);
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

	const maxDepth = $derived(
		allThreads.length > 0 ? Math.max(...allThreads.map((t) => t.depth)) : 2
	);

	function normalizeHandle(handle: string | null | undefined): string {
		return (handle ?? '').replace(/^@/, '').trim();
	}

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

	async function handleSearch(
		handle: string,
		options: { profile?: ProfileInfo | null; threadUrl?: string | null } = {}
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
		repoStats = { totalPosts: 0, elapsedMs: 0, downloadedBytes: 0, source: null };

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
				source: repo.source
			};

			const { threads } = buildThreadsFromFeed(repo.feedItems, did, (p) => {
				progress = p;
			});

			allThreads = threads;
			stats = {
				postsScanned: repo.feedItems.length,
				chainStarts: threads.length,
				threadsWithSelfReplies: threads.filter((t) => t.depth >= 2).length
			};

			if (stats.threadsWithSelfReplies > 0) {
				toastSuccess(`Found ${stats.threadsWithSelfReplies} thread${stats.threadsWithSelfReplies !== 1 ? 's' : ''}`);
			} else {
				toastInfo('No self-reply threads found');
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
		options: { preserveScroll?: boolean } = {}
	): Promise<boolean> {
		if (options.preserveScroll) savedScrollY = window.scrollY;
		expandedLoading = true;
		showExpanded = true;

		try {
			expandedThread = await getFullThread(uri);
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

	function handleBack() {
		showExpanded = false;
		expandedThread = null;
		expandedViewMode = 'chat';
		updateRouteState({ handle: selectedProfile?.handle || initialHandle, threadUrl: null });
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

	onMount(async () => {
		try {
			const saved = localStorage.getItem('preferred-font');
			if (saved && saved in fontFamilies) fontKey = saved;
			const savedMode = localStorage.getItem('preferred-render-mode');
			if (savedMode && isRenderMode(savedMode)) renderMode = savedMode;
		} catch {}

		const params = new URLSearchParams(window.location.search);
		const handleParam = params.get('handle');
		const fromParam = params.get('from');
		const toParam = params.get('to');
		if (fromParam) dateFrom = fromParam;
		if (toParam) dateTo = toParam;

		if (handleParam) {
			const h = normalizeHandle(handleParam);
			initialHandle = h;
			try {
				const profile = await getProfile(h);
				await handleProfileSelected(profile);
				await handleSearch(profile.handle, { profile });
			} catch {
				toastInfo('Could not load profile from URL');
			}
		}
	});
</script>

<svelte:head>
	<title>Repo Viewer - Bluesky Thread Viewer</title>
</svelte:head>

<main style="font-family: {fontFamily}">
	<header>
		<RouteNav
			current="viewer2"
			align="center"
			threadUrl={activeThreadUrl}
			handle={selectedProfile?.handle || initialHandle}
		/>
		<h1>Repo Viewer</h1>
		<p class="subtitle">Download full repository &mdash; no pagination, no rate limits</p>
		<FontPicker value={fontKey} onchange={handleFontChange} />
	</header>

	<section class="search-section">
		<SearchBar onsearch={handleSearch} onprofile={handleProfileSelected} disabled={loading} {initialHandle} />

		<div class="info-banner wobbly-border-light">
			Repository view &mdash; engagement counts unavailable, embeds may not display
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

					{#if !loading && repoStats.totalPosts > 0}
						<div class="stats-bar">
							<span>
								Downloaded {repoStats.totalPosts.toLocaleString()} posts in {(repoStats.elapsedMs / 1000).toFixed(1)}s
								from {formatBytes(repoStats.downloadedBytes)}{#if repoStats.source}
									via {repoStats.source === 'pds' ? 'PDS' : 'relay'}
								{/if}
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
				<p>Enter a Bluesky handle to download their full repository and find self-reply threads.</p>
				<p class="hint">Downloads the entire AT Protocol repo as a single request — no pagination or rate limits.</p>
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

	.info-banner {
		max-width: 600px;
		margin: 12px auto 0;
		padding: 10px 16px;
		background: #fff3cd;
		color: #856404;
		font-size: 0.88rem;
		text-align: center;
	}

	.options-row {
		margin-top: 8px;
		text-align: center;
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
