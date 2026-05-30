<script lang="ts">
	import { onMount } from 'svelte';
	import { browser } from '$app/environment';
	import '../../app.css';
	import type { Agent } from '@atproto/api';
	import {
		getProfile,
		getFollowsPage,
		searchPostsFromAuthor,
		type FollowProfileInfo,
		type PostSearchAgent,
		type ProfileInfo
	} from '$lib/api/bluesky';
	import {
		initAuthenticatedBlueskyClient,
		connectBlueskyWithPopup,
		disconnectBluesky,
		type AuthenticatedBlueskyContext
	} from '$lib/api/blueskyAuth';
	import { BLUESKY_FOLLOWSEARCH_SCOPE } from '$lib/constants/blueskyOAuth';
	import type { ThreadPost } from '$lib/types';
	import SearchBar from '$lib/components/SearchBar.svelte';
	import PostNode from '$lib/components/PostNode.svelte';
	import FontPicker from '$lib/components/FontPicker.svelte';
	import RouteNav from '$lib/components/RouteNav.svelte';
	import { toastError, toastInfo, toastWarning } from '$lib/utils/toasts';

	const MAX_FOLLOW_PAGES = 20; // ~2000 follows max
	const SEARCH_CONCURRENCY = 3;
	const PER_AUTHOR_LIMIT = 25;
	const RATE_LIMIT_BACKOFF_MS = 4000;

	const fontFamilies: Record<string, string> = {
		virgil: "'Virgil', cursive",
		caveat: "'Caveat', cursive",
		patrick: "'Patrick Hand', cursive",
		'comic-neue': "'Comic Neue', cursive",
		inter: "'Inter', sans-serif",
		system: 'system-ui, -apple-system, sans-serif'
	};

	let fontKey = $state('patrick');
	let fontFamily = $derived(fontFamilies[fontKey] ?? fontFamilies.virgil);

	function handleFontChange(key: string) {
		fontKey = key;
		try {
			localStorage.setItem('preferred-font', key);
		} catch {}
	}

	// Each visitor authenticates with their own Bluesky account via OAuth; the
	// searchPosts calls run as them, so no shared credentials and per-user limits.
	let authAgent: Agent | null = $state(null);
	let authProfile: ProfileInfo | null = $state(null);
	let sessionSub: string | null = $state(null);
	let hasSearchScope = $state(false);
	let connecting = $state(false);
	let restoringSession = $state(true);

	let handle = $state('');
	let subject: ProfileInfo | null = $state(null);
	let follows: FollowProfileInfo[] = $state([]);
	let loadingFollows = $state(false);
	let error: string | null = $state(null);

	let searchTerm = $state('');
	let searching = $state(false);
	let searchProgress = $state({ done: 0, total: 0 });
	let resultMap = $state(new Map<string, ThreadPost>());
	let abortController: AbortController | null = null;

	// Rate-limit telemetry surfaced in the UI. `backoffWorkers` counts workers
	// currently sleeping after a 429; `rateLimitHits` is the running total.
	let backoffWorkers = $state(0);
	let rateLimitHits = $state(0);
	let skippedCount = $state(0);
	const rateLimited = $derived(backoffWorkers > 0);

	const sortedResults = $derived(
		Array.from(resultMap.values()).sort(
			(a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
		)
	);

	function updateQueryParams() {
		if (!browser) return;
		const current = new URL(window.location.href);
		if (handle) current.searchParams.set('handle', handle);
		else current.searchParams.delete('handle');
		if (searchTerm) current.searchParams.set('q', searchTerm);
		else current.searchParams.delete('q');
		window.history.replaceState({}, '', current.toString());
	}

	function applyAuthContext(context: AuthenticatedBlueskyContext) {
		authAgent = context.agent;
		authProfile = context.profile;
		sessionSub = context.session.sub;
		hasSearchScope = context.hasSearchPostsScope;
		if (!hasSearchScope) {
			toastWarning('Your session is missing the searchPosts permission — try reconnecting.');
		}
	}

	async function restoreSession() {
		restoringSession = true;
		try {
			const { context } = await initAuthenticatedBlueskyClient();
			if (context) applyAuthContext(context);
		} catch (err) {
			const message = String((err as { message?: string })?.message || '');
			if (!message.includes('Redirecting to loopback IP')) {
				// Non-fatal: visitor can connect manually.
			}
		} finally {
			restoringSession = false;
		}
	}

	async function handleConnect() {
		connecting = true;
		error = null;
		try {
			const context = await connectBlueskyWithPopup({ scope: BLUESKY_FOLLOWSEARCH_SCOPE });
			applyAuthContext(context);
		} catch (err) {
			error = err instanceof Error ? err.message : 'Could not connect your Bluesky account.';
			toastError(error);
		} finally {
			connecting = false;
		}
	}

	async function handleDisconnect() {
		const sub = sessionSub;
		if (!sub) return;
		try {
			await disconnectBluesky(sub);
		} catch {}
		authAgent = null;
		authProfile = null;
		sessionSub = null;
		hasSearchScope = false;
	}

	async function loadFollows(rawHandle: string) {
		const cleaned = rawHandle.replace(/^@/, '').trim();
		if (!cleaned) return;

		cancelSearch();
		handle = cleaned;
		loadingFollows = true;
		error = null;
		follows = [];
		subject = null;
		resultMap = new Map();
		updateQueryParams();

		try {
			const profile = await getProfile(cleaned);
			subject = profile;

			const collected: FollowProfileInfo[] = [];
			let cursor: string | undefined;
			for (let page = 0; page < MAX_FOLLOW_PAGES; page++) {
				const res = await getFollowsPage(profile.did, { cursor, limit: 100 });
				collected.push(...res.follows);
				cursor = res.cursor;
				if (!cursor) break;
			}
			follows = collected;

			if (follows.length === 0) {
				toastInfo('This account does not follow anyone.');
			}
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to load follows.';
			toastError(error);
		} finally {
			loadingFollows = false;
		}
	}

	function cancelSearch() {
		if (abortController) {
			abortController.abort();
			abortController = null;
		}
		searching = false;
	}

	async function runSearch() {
		const agent = authAgent;
		if (!agent) {
			toastInfo('Connect your Bluesky account to search.');
			return;
		}
		const term = searchTerm.trim();
		if (!term) {
			toastInfo('Enter a search term.');
			return;
		}
		if (follows.length === 0) {
			toastInfo('Load an account with follows first.');
			return;
		}

		cancelSearch();
		const controller = new AbortController();
		abortController = controller;
		searching = true;
		resultMap = new Map();
		backoffWorkers = 0;
		rateLimitHits = 0;
		skippedCount = 0;
		updateQueryParams();

		const targets = follows; // search every follow
		searchProgress = { done: 0, total: targets.length };

		let index = 0;
		const merged = new Map<string, ThreadPost>();
		const sleep = (ms: number) =>
			new Promise((resolve) => setTimeout(resolve, ms));

		async function worker() {
			while (index < targets.length && !controller.signal.aborted) {
				const follow = targets[index++];
				try {
					const page = await searchPostsFromAuthor(term, follow.handle, {
						agent: agent as unknown as PostSearchAgent,
						limit: PER_AUTHOR_LIMIT,
						sort: 'latest',
						signal: controller.signal
					});
					for (const post of page.posts) {
						merged.set(post.uri, post);
					}
				} catch (e) {
					if (controller.signal.aborted) return;
					if ((e as { status?: number })?.status === 429) {
						// Rate limited on the visitor's own account: back off and retry
						// the same author rather than dropping it.
						rateLimitHits += 1;
						backoffWorkers += 1;
						index--;
						await sleep(RATE_LIMIT_BACKOFF_MS);
						backoffWorkers -= 1;
						continue;
					}
					// Other per-author failures (blocked / network): skip and keep going.
					skippedCount += 1;
				}
				if (!controller.signal.aborted) {
					searchProgress = { done: searchProgress.done + 1, total: targets.length };
					resultMap = new Map(merged);
				}
			}
		}

		const workers = Array.from({ length: Math.min(SEARCH_CONCURRENCY, targets.length) }, () =>
			worker()
		);
		await Promise.all(workers);

		if (controller.signal.aborted) return;
		abortController = null;
		searching = false;
		if (merged.size === 0) {
			toastInfo('No posts from these follows matched your search.');
		}
	}

	function handleHandleSearch(value: string) {
		loadFollows(value);
	}

	function handleProfile(profile: ProfileInfo) {
		subject = profile;
	}

	function handleSearchSubmit(e: Event) {
		e.preventDefault();
		runSearch();
	}

	onMount(() => {
		// atproto loopback OAuth forces redirect_uris onto 127.0.0.1, so the sign-in
		// popup ends up on 127.0.0.1 and can only post back to a same-origin opener.
		// If the page was opened on `localhost`, normalize to 127.0.0.1 first or the
		// popup will never close.
		if (window.location.hostname === 'localhost') {
			window.location.replace(
				window.location.href.replace('//localhost', '//127.0.0.1')
			);
			return;
		}

		try {
			const saved = localStorage.getItem('preferred-font');
			if (saved && saved in fontFamilies) fontKey = saved;
		} catch {}

		restoreSession();

		const params = new URLSearchParams(window.location.search);
		const handleParam = params.get('handle');
		const qParam = params.get('q');
		if (qParam) searchTerm = qParam;
		if (handleParam) {
			handle = handleParam;
			loadFollows(handleParam);
		}
	});
</script>

<svelte:head>
	<title>Follow Search</title>
</svelte:head>

<div class="page" style={`font-family: ${fontFamily}`}>
	<div class="toolbar">
		<RouteNav current="followsearch" {handle} />
		<FontPicker value={fontKey} onchange={handleFontChange} />
	</div>

	<header class="header">
		<h1>Follow Search</h1>
		<p class="subtitle">Search posts from the accounts a handle follows.</p>
	</header>

	<div class="auth-bar wobbly-border-light">
		{#if authProfile}
			<div class="auth-status">
				{#if authProfile.avatar}
					<img class="auth-avatar" src={authProfile.avatar} alt={authProfile.handle} />
				{/if}
				<span>Searching as <strong>@{authProfile.handle}</strong></span>
			</div>
			<button type="button" class="auth-btn" onclick={handleDisconnect}>Disconnect</button>
		{:else}
			<span class="auth-prompt">
				{restoringSession
					? 'Restoring session…'
					: 'Connect your Bluesky account to search posts from follows.'}
			</span>
			<button type="button" class="auth-btn" onclick={handleConnect} disabled={connecting || restoringSession}>
				{connecting ? 'Connecting…' : 'Connect Bluesky'}
			</button>
		{/if}
	</div>

	<div class="handle-search">
		<SearchBar
			onsearch={handleHandleSearch}
			onprofile={handleProfile}
			disabled={loadingFollows}
			initialHandle={handle}
			placeholder="Enter a Bluesky handle…"
			buttonLabel="Load follows"
		/>
	</div>

	{#if error}
		<div class="error wobbly-border-light">{error}</div>
	{/if}

	{#if loadingFollows}
		<div class="status">Loading follows for @{handle}…</div>
	{/if}

	{#if subject && follows.length > 0}
		<div class="follows-summary wobbly-border-light">
			<div class="follows-count">
				<strong>@{subject.handle}</strong> follows <strong>{follows.length}</strong>
				{follows.length === 1 ? 'account' : 'accounts'}
			</div>
			<div class="follows-avatars">
				{#each follows.slice(0, 30) as follow (follow.did)}
					{#if follow.avatar}
						<img class="avatar" src={follow.avatar} alt={follow.handle} title={'@' + follow.handle} />
					{:else}
						<span class="avatar avatar-fallback" title={'@' + follow.handle}>
							{follow.handle.slice(0, 1).toUpperCase()}
						</span>
					{/if}
				{/each}
				{#if follows.length > 30}
					<span class="avatar-more">+{follows.length - 30}</span>
				{/if}
			</div>
		</div>

		<form class="term-search" onsubmit={handleSearchSubmit}>
			<input
				type="text"
				bind:value={searchTerm}
				placeholder="Search term (e.g. rust async)…"
				disabled={searching}
			/>
			{#if searching}
				<button type="button" class="cancel-btn" onclick={cancelSearch}>Cancel</button>
			{:else}
				<button type="submit" class="search-btn" disabled={!authAgent} title={authAgent ? '' : 'Connect your Bluesky account first'}>Search</button>
			{/if}
		</form>
	{/if}

	{#if searching || rateLimitHits > 0 || skippedCount > 0}
		<div class="status">
			{#if searching}
				Searching {searchProgress.done} / {searchProgress.total} follows…
				{#if sortedResults.length > 0}
					<span class="hits">({sortedResults.length} posts so far)</span>
				{/if}
			{:else}
				{sortedResults.length} posts found
			{/if}

			{#if rateLimited}
				<span class="rate-badge rate-badge-active">
					⏳ Rate limited — backing off ({backoffWorkers} waiting)
				</span>
			{:else if rateLimitHits > 0}
				<span class="rate-badge">{rateLimitHits} rate-limit retr{rateLimitHits === 1 ? 'y' : 'ies'}</span>
			{/if}
			{#if skippedCount > 0}
				<span class="rate-badge">{skippedCount} skipped</span>
			{/if}
		</div>
	{:else if sortedResults.length > 0}
		<div class="status">{sortedResults.length} posts found</div>
	{/if}

	<div class="results">
		{#each sortedResults as post (post.uri)}
			<PostNode {post} level={0} highlightedPostUri={null} />
		{/each}
	</div>
</div>

<style>
	.page {
		max-width: 760px;
		margin: 0 auto;
		padding: 20px 16px 80px;
	}

	.toolbar {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 12px;
	}

	.header {
		margin: 8px 0 18px;
	}

	.header h1 {
		margin: 0;
		font-size: 1.8rem;
		color: var(--text-ink);
	}

	.subtitle {
		margin: 4px 0 0;
		color: var(--text-muted, #666);
	}

	.auth-bar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		flex-wrap: wrap;
		padding: 10px 14px;
		margin-bottom: 14px;
		background: var(--card-bg);
		border: 1px solid var(--control-border);
		box-shadow: var(--shadow-soft);
	}

	.auth-status {
		display: flex;
		align-items: center;
		gap: 8px;
		color: var(--text-ink);
	}

	.auth-avatar {
		width: 26px;
		height: 26px;
		border-radius: 999px;
		object-fit: cover;
		border: 1px solid var(--control-border);
	}

	.auth-prompt {
		color: var(--text-muted, #666);
	}

	.auth-btn {
		padding: 8px 14px;
		border-radius: 999px;
		border: 1px solid var(--control-border);
		background: var(--control-bg);
		color: var(--text-ink);
		font: inherit;
		font-weight: 600;
		cursor: pointer;
		transition: background 0.16s ease;
	}

	.auth-btn:hover:not(:disabled) {
		background: color-mix(in srgb, var(--accent) 18%, var(--card-bg));
	}

	.auth-btn:disabled {
		opacity: 0.6;
		cursor: default;
	}

	.search-btn:disabled {
		opacity: 0.6;
		cursor: default;
	}

	.handle-search {
		margin-bottom: 16px;
	}

	.error {
		padding: 10px 14px;
		margin-bottom: 14px;
		background: color-mix(in srgb, crimson 12%, var(--card-bg));
		border: 1px solid color-mix(in srgb, crimson 40%, var(--control-border));
		color: var(--text-ink);
	}

	.status {
		margin: 10px 0;
		color: var(--text-muted, #666);
	}

	.hits {
		color: var(--accent);
	}

	.rate-badge {
		display: inline-block;
		margin-left: 8px;
		padding: 2px 10px;
		border-radius: 999px;
		font-size: 0.8rem;
		background: var(--control-bg);
		border: 1px solid var(--control-border);
		color: var(--text-muted, #666);
	}

	.rate-badge-active {
		background: color-mix(in srgb, orange 18%, var(--card-bg));
		border-color: color-mix(in srgb, orange 50%, var(--control-border));
		color: var(--text-ink);
	}

	.follows-summary {
		padding: 12px 14px;
		margin-bottom: 14px;
		background: var(--card-bg);
		border: 1px solid var(--control-border);
		box-shadow: var(--shadow-soft);
	}

	.follows-count {
		margin-bottom: 8px;
		color: var(--text-ink);
	}

	.follows-avatars {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
		align-items: center;
	}

	.avatar {
		width: 28px;
		height: 28px;
		border-radius: 999px;
		object-fit: cover;
		border: 1px solid var(--control-border);
		display: inline-flex;
		align-items: center;
		justify-content: center;
		font-size: 0.8rem;
	}

	.avatar-fallback {
		background: var(--control-bg);
		color: var(--text-ink);
	}

	.avatar-more {
		font-size: 0.85rem;
		color: var(--text-muted, #666);
		margin-left: 4px;
	}

	.term-search {
		display: flex;
		gap: 8px;
		margin-bottom: 18px;
	}

	.term-search input {
		flex: 1;
		padding: 10px 14px;
		border-radius: 999px;
		border: 1px solid var(--control-border);
		background: var(--control-bg);
		color: var(--text-ink);
		font: inherit;
	}

	.search-btn,
	.cancel-btn {
		padding: 10px 18px;
		border-radius: 999px;
		border: 1px solid var(--control-border);
		background: var(--control-bg);
		color: var(--text-ink);
		font: inherit;
		font-weight: 600;
		cursor: pointer;
		transition: background 0.16s ease;
	}

	.search-btn:hover {
		background: color-mix(in srgb, var(--accent) 18%, var(--card-bg));
	}

	.cancel-btn:hover {
		background: color-mix(in srgb, crimson 18%, var(--card-bg));
	}

	.results {
		display: flex;
		flex-direction: column;
		gap: 12px;
	}
</style>
