<script lang="ts">
	import { onMount } from 'svelte';
	import { browser } from '$app/environment';
	import '../../app.css';
	import type { Agent } from '@atproto/api';
	import {
		getProfile,
		getFollowsPage,
		buildAuthorSearchQuery,
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
	import { buildBskyPostUrl } from '$lib/utils/viewerLinks';
	import SearchBar from '$lib/components/SearchBar.svelte';
	import FontPicker from '$lib/components/FontPicker.svelte';
	import RouteNav from '$lib/components/RouteNav.svelte';
	import { toastError, toastInfo, toastWarning } from '$lib/utils/toasts';

	const MAX_FOLLOW_PAGES = 20; // ~2000 follows max
	const SEARCH_CONCURRENCY = 3;
	const SEARCH_PAGE_LIMIT = 100;
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
	let resultFilter = $state('');
	let searching = $state(false);
	let searchProgress = $state({ done: 0, total: 0 });
	type SearchResult = {
		post: ThreadPost;
		queryTerm: string;
		searchQuery: string;
		searchedHandle: string;
		searchedDid: string;
	};
	let resultMap = $state(new Map<string, SearchResult>());
	let abortController: AbortController | null = null;

	// Rate-limit telemetry surfaced in the UI. `backoffWorkers` counts workers
	// currently sleeping after a 429; `rateLimitHits` is the running total.
	let backoffWorkers = $state(0);
	let rateLimitHits = $state(0);
	let skippedCount = $state(0);
	const rateLimited = $derived(backoffWorkers > 0);

	const sortedResults = $derived(
		Array.from(resultMap.values()).sort(
			(a, b) => new Date(b.post.createdAt).getTime() - new Date(a.post.createdAt).getTime()
		)
	);

	type HighlightKind = 'query' | 'filter';
	type HighlightSegment = {
		text: string;
		kind: HighlightKind | null;
	};

	function uniqueSearchTerms(value: string): string[] {
		const seen = new Set<string>();
		const terms: string[] = [];
		for (const term of value.trim().split(/\s+/)) {
			const normalized = term.toLocaleLowerCase();
			if (!normalized || seen.has(normalized)) continue;
			seen.add(normalized);
			terms.push(term);
		}
		return terms;
	}

	function resultMatchesFilter(result: SearchResult, terms: string[]): boolean {
		if (terms.length === 0) return true;
		const post = result.post;
		const quote = post.embed?.record;
		const haystack = [
			post.text,
			post.author.handle,
			post.author.displayName ?? '',
			quote?.text ?? '',
			quote?.author.handle ?? '',
			quote?.author.displayName ?? ''
		]
			.join('\n')
			.toLocaleLowerCase();
		return terms.every((term) => haystack.includes(term.toLocaleLowerCase()));
	}

	const resultFilterTerms = $derived(uniqueSearchTerms(resultFilter));
	const displayedResults = $derived.by(() =>
		sortedResults.filter((result) => resultMatchesFilter(result, resultFilterTerms))
	);

	function buildHighlightSegments(
		text: string,
		queryTerm: string,
		filterTerms: string[]
	): HighlightSegment[] {
		const entries = [
			...uniqueSearchTerms(queryTerm).map((term) => ({
				term,
				kind: 'query' as HighlightKind
			})),
			...filterTerms.map((term) => ({ term, kind: 'filter' as HighlightKind }))
		]
			.filter(({ term }) => term.length > 0)
			.sort((a, b) => b.term.length - a.term.length);

		if (!text || entries.length === 0) return [{ text, kind: null }];

		const lowerText = text.toLocaleLowerCase();
		const lowerEntries = entries.map((entry) => ({
			...entry,
			lowerTerm: entry.term.toLocaleLowerCase()
		}));
		const segments: HighlightSegment[] = [];
		let plainStart = 0;
		let index = 0;

		while (index < text.length) {
			const match = lowerEntries.find(({ lowerTerm }) => lowerText.startsWith(lowerTerm, index));
			if (!match) {
				index += 1;
				continue;
			}
			if (plainStart < index) {
				segments.push({ text: text.slice(plainStart, index), kind: null });
			}
			const end = index + match.term.length;
			segments.push({ text: text.slice(index, end), kind: match.kind });
			index = end;
			plainStart = index;
		}

		if (plainStart < text.length) {
			segments.push({ text: text.slice(plainStart), kind: null });
		}

		return segments;
	}

	type AuthorGroup = {
		did: string;
		author: ThreadPost['author'];
		posts: SearchResult[];
	};

	// Aggregate matches by the account that posted them, busiest accounts first.
	// Posts within each group stay in the recency order of displayedResults.
	const resultsByAuthor = $derived.by(() => {
		const groups = new Map<string, AuthorGroup>();
		for (const result of displayedResults) {
			const post = result.post;
			const did = post.author.did;
			let group = groups.get(did);
			if (!group) {
				group = { did, author: post.author, posts: [] };
				groups.set(did, group);
			}
			group.posts.push(result);
		}
		return Array.from(groups.values()).sort((a, b) => {
			if (b.posts.length !== a.posts.length) return b.posts.length - a.posts.length;
			return a.author.handle.localeCompare(b.author.handle);
		});
	});

	function formatDate(iso: string): string {
		const d = new Date(iso);
		if (Number.isNaN(d.getTime())) return '';
		return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
	}

	// Collapsed author groups (by did). Click an author header to fold its posts.
	let collapsedAuthors = $state(new Set<string>());
	function toggleAuthor(did: string) {
		const next = new Set(collapsedAuthors);
		if (next.has(did)) next.delete(did);
		else next.add(did);
		collapsedAuthors = next;
	}

	// Editable follow list. Deselected (excluded) accounts are skipped when searching.
	let excludedDids = $state(new Set<string>());
	let showFollowEditor = $state(false);
	let followFilter = $state('');
	const activeFollows = $derived(follows.filter((f) => !excludedDids.has(f.did)));
	const filteredFollows = $derived.by(() => {
		const q = followFilter.trim().toLowerCase();
		if (!q) return follows;
		return follows.filter(
			(f) =>
				f.handle.toLowerCase().includes(q) ||
				(f.displayName ?? '').toLowerCase().includes(q)
		);
	});
	function toggleFollow(did: string) {
		const next = new Set(excludedDids);
		if (next.has(did)) next.delete(did);
		else next.add(did);
		excludedDids = next;
	}
	function selectAllFollows() {
		excludedDids = new Set();
	}
	function clearAllFollows() {
		excludedDids = new Set(follows.map((f) => f.did));
	}

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
		excludedDids = new Set();
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
		if (activeFollows.length === 0) {
			toastInfo('Select at least one account to search.');
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
		resultFilter = '';
		updateQueryParams();

		const targets = activeFollows; // search only the selected follows
		searchProgress = { done: 0, total: targets.length };

		let index = 0;
		const merged = new Map<string, SearchResult>();
		const sleep = (ms: number) =>
			new Promise((resolve) => setTimeout(resolve, ms));

		async function worker() {
			while (index < targets.length && !controller.signal.aborted) {
				const follow = targets[index++];
				const searchQuery = buildAuthorSearchQuery(term, follow.handle);
				let cursor: string | undefined;
				let authorSkipped = false;
				const seenCursors = new Set<string>();
				while (!controller.signal.aborted) {
					try {
						const page = await searchPostsFromAuthor(term, follow.handle, {
							agent: agent as unknown as PostSearchAgent,
							limit: SEARCH_PAGE_LIMIT,
							cursor,
							sort: 'latest',
							signal: controller.signal,
							expectedAuthorDid: follow.did
						});
						for (const post of page.posts) {
							merged.set(post.uri, {
								post,
								queryTerm: term,
								searchQuery,
								searchedHandle: follow.handle,
								searchedDid: follow.did
							});
						}
						if (!controller.signal.aborted) {
							resultMap = new Map(merged);
						}
						if (!page.cursor || seenCursors.has(page.cursor)) break;
						seenCursors.add(page.cursor);
						cursor = page.cursor;
					} catch (e) {
						if (controller.signal.aborted) return;
						if ((e as { status?: number })?.status === 429) {
							// Rate limited on the visitor's own account: back off and retry
							// the same author page rather than dropping it.
							rateLimitHits += 1;
							backoffWorkers += 1;
							await sleep(RATE_LIMIT_BACKOFF_MS);
							backoffWorkers -= 1;
							continue;
						}
						// Other per-author failures (blocked / network): skip and keep going.
						authorSkipped = true;
						break;
					}
				}
				if (authorSkipped) {
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
	<RouteNav current="followsearch" {handle} />
	<div class="toolbar">
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
			<div class="follows-summary-row">
				<div class="follows-count">
					<strong>@{subject.handle}</strong> follows <strong>{follows.length}</strong>
					{follows.length === 1 ? 'account' : 'accounts'}
					{#if activeFollows.length !== follows.length}
						· <strong>{activeFollows.length}</strong> selected
					{/if}
				</div>
				<button type="button" class="edit-follows-btn" onclick={() => (showFollowEditor = !showFollowEditor)}>
					{showFollowEditor ? 'Done' : 'Edit list'}
				</button>
			</div>

			{#if showFollowEditor}
				<div class="follow-editor">
					<div class="follow-editor-toolbar">
						<input
							type="text"
							class="follow-filter"
							bind:value={followFilter}
							placeholder="Filter accounts…"
						/>
						<button type="button" class="mini-btn" onclick={selectAllFollows}>All</button>
						<button type="button" class="mini-btn" onclick={clearAllFollows}>None</button>
					</div>
					<ul class="follow-list">
						{#each filteredFollows as follow (follow.did)}
							{@const selected = !excludedDids.has(follow.did)}
							<li class="follow-item" class:deselected={!selected}>
								<label class="follow-label">
									<input
										type="checkbox"
										checked={selected}
										onchange={() => toggleFollow(follow.did)}
									/>
									{#if follow.avatar}
										<img class="avatar" src={follow.avatar} alt={follow.handle} />
									{:else}
										<span class="avatar avatar-fallback">{follow.handle.slice(0, 1).toUpperCase()}</span>
									{/if}
									<span class="follow-names">
										{#if follow.displayName}
											<span class="follow-name">{follow.displayName}</span>
										{/if}
										<span class="follow-handle">@{follow.handle}</span>
									</span>
								</label>
							</li>
						{/each}
						{#if filteredFollows.length === 0}
							<li class="follow-empty">No accounts match “{followFilter}”.</li>
						{/if}
					</ul>
				</div>
			{:else}
				<div class="follows-avatars">
					{#each activeFollows.slice(0, 30) as follow (follow.did)}
						{#if follow.avatar}
							<img class="avatar" src={follow.avatar} alt={follow.handle} title={'@' + follow.handle} />
						{:else}
							<span class="avatar avatar-fallback" title={'@' + follow.handle}>
								{follow.handle.slice(0, 1).toUpperCase()}
							</span>
						{/if}
					{/each}
					{#if activeFollows.length > 30}
						<span class="avatar-more">+{activeFollows.length - 30}</span>
					{/if}
				</div>
			{/if}
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

	{#if sortedResults.length > 0}
		<div class="result-filter">
			<input
				type="search"
				bind:value={resultFilter}
				placeholder="Search within results…"
				aria-label="Search within results"
			/>
			{#if resultFilter}
				<button type="button" class="mini-btn" onclick={() => (resultFilter = '')}>Clear</button>
			{/if}
		</div>
		{#if resultFilter}
			<div class="status">
				Showing {displayedResults.length} / {sortedResults.length} posts
			</div>
		{/if}
	{/if}

	<div class="results">
		{#each resultsByAuthor as group (group.did)}
			{@const collapsed = collapsedAuthors.has(group.did)}
			<section class="author-group wobbly-border-light">
				<header class="author-head">
					<button
						type="button"
						class="collapse-btn"
						aria-expanded={!collapsed}
						title={collapsed ? 'Expand' : 'Collapse'}
						onclick={() => toggleAuthor(group.did)}
					>
						<span class="caret" class:collapsed>▾</span>
						{#if group.author.avatar}
							<img class="author-avatar" src={group.author.avatar} alt={group.author.handle} />
						{:else}
							<span class="author-avatar author-avatar-fallback">
								{group.author.handle.slice(0, 1).toUpperCase()}
							</span>
						{/if}
						<span class="author-meta">
							{#if group.author.displayName}
								<span class="author-name">{group.author.displayName}</span>
							{/if}
							<span class="author-handle">@{group.author.handle}</span>
						</span>
					</button>
					<span class="author-count" title="matching posts">{group.posts.length}</span>
				</header>
				{#if !collapsed}
					<ul class="post-list">
						{#each group.posts as result (result.post.uri)}
							{@const post = result.post}
							{@const link = buildBskyPostUrl(post.uri, post.author.handle)}
							<li class="post-row">
								<a
									class="post-text"
									href={link ?? '#'}
									target="_blank"
									rel="noreferrer noopener"
									title="Open on Bluesky"
								>
									{#each buildHighlightSegments(post.text, result.queryTerm, resultFilterTerms) as segment}
										{#if segment.kind}
											<span class={segment.kind === 'query' ? 'highlight-query' : 'highlight-filter'}>
												{segment.text}
											</span>
										{:else}
											{segment.text}
										{/if}
									{/each}
								</a>
								{#if post.embed?.record}
									{@const quote = post.embed.record}
									{@const quoteLink = buildBskyPostUrl(quote.uri, quote.author.handle)}
									<a
										class="quote-embed"
										href={quoteLink ?? '#'}
										target="_blank"
										rel="noreferrer noopener"
										title="Open quoted post on Bluesky"
									>
										<span class="quote-head">
											{#if quote.author.avatar}
												<img class="quote-avatar" src={quote.author.avatar} alt={quote.author.handle} />
											{/if}
											<span class="quote-author">{quote.author.displayName || quote.author.handle}</span>
											<span class="quote-handle">@{quote.author.handle}</span>
										</span>
										{#if quote.text}
											<span class="quote-text">
												{#each buildHighlightSegments(quote.text, result.queryTerm, resultFilterTerms) as segment}
													{#if segment.kind}
														<span class={segment.kind === 'query' ? 'highlight-query' : 'highlight-filter'}>
															{segment.text}
														</span>
													{:else}
														{segment.text}
													{/if}
												{/each}
											</span>
										{/if}
									</a>
								{/if}
								<div class="post-meta">
									<time>{formatDate(post.createdAt)}</time>
									<span
										class="search-tag"
										title={`Search request: ${result.searchQuery}; searched @${result.searchedHandle}; expected DID: ${result.searchedDid}`}
									>
										{result.searchQuery}
									</span>
									<span class="post-counts">♥ {post.likeCount} · ↺ {post.repostCount} · 💬 {post.replyCount}</span>
								</div>
							</li>
						{/each}
					</ul>
				{/if}
			</section>
		{/each}
		{#if sortedResults.length > 0 && displayedResults.length === 0}
			<div class="empty-results wobbly-border-light">No results match “{resultFilter}”.</div>
		{/if}
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
		justify-content: flex-end;
		margin-bottom: 8px;
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

	.follows-summary-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 10px;
		margin-bottom: 8px;
	}

	.follows-count {
		color: var(--text-ink);
	}

	.edit-follows-btn,
	.mini-btn {
		padding: 5px 12px;
		border-radius: 999px;
		border: 1px solid var(--control-border);
		background: var(--control-bg);
		color: var(--text-ink);
		font: inherit;
		font-weight: 600;
		font-size: 0.82rem;
		cursor: pointer;
		flex-shrink: 0;
	}

	.edit-follows-btn:hover,
	.mini-btn:hover {
		background: color-mix(in srgb, var(--accent) 16%, var(--card-bg));
	}

	.follow-editor {
		border-top: 1px solid var(--control-border);
		padding-top: 10px;
	}

	.follow-editor-toolbar {
		display: flex;
		gap: 8px;
		margin-bottom: 8px;
	}

	.follow-filter {
		flex: 1;
		min-width: 0;
		padding: 6px 12px;
		border-radius: 999px;
		border: 1px solid var(--control-border);
		background: var(--control-bg);
		color: var(--text-ink);
		font: inherit;
		font-size: 0.85rem;
	}

	.follow-list {
		list-style: none;
		margin: 0;
		padding: 0;
		max-height: 260px;
		overflow-y: auto;
	}

	.follow-item {
		border-top: 1px solid color-mix(in srgb, var(--control-border) 50%, transparent);
	}

	.follow-item:first-child {
		border-top: none;
	}

	.follow-item.deselected {
		opacity: 0.5;
	}

	.follow-label {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 5px 2px;
		cursor: pointer;
	}

	.follow-names {
		display: flex;
		align-items: baseline;
		gap: 6px;
		min-width: 0;
	}

	.follow-name {
		font-weight: 700;
		color: var(--text-ink);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.follow-handle {
		color: var(--text-muted, #666);
		font-size: 0.85rem;
		white-space: nowrap;
	}

	.follow-empty {
		padding: 10px 2px;
		color: var(--text-muted, #666);
		font-size: 0.88rem;
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

	.result-filter {
		display: flex;
		gap: 8px;
		margin: 0 0 12px;
	}

	.result-filter input {
		flex: 1;
		min-width: 0;
		padding: 8px 14px;
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
		gap: 10px;
	}

	.author-group {
		background: var(--card-bg);
		border: 1px solid var(--control-border);
		box-shadow: var(--shadow-soft);
		overflow: hidden;
	}

	.author-head {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 8px 12px;
		border-bottom: 1px solid var(--control-border);
		background: color-mix(in srgb, var(--accent) 6%, var(--card-bg));
	}

	.collapse-btn {
		display: flex;
		align-items: center;
		gap: 8px;
		flex: 1;
		min-width: 0;
		padding: 0;
		border: none;
		background: none;
		color: inherit;
		font: inherit;
		text-align: left;
		cursor: pointer;
	}

	.caret {
		flex-shrink: 0;
		color: var(--text-muted, #888);
		font-size: 0.8rem;
		transition: transform 0.15s ease;
	}

	.caret.collapsed {
		transform: rotate(-90deg);
	}

	.author-avatar {
		width: 28px;
		height: 28px;
		border-radius: 999px;
		object-fit: cover;
		border: 1px solid var(--control-border);
		flex-shrink: 0;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		font-size: 0.85rem;
	}

	.author-avatar-fallback {
		background: var(--control-bg);
		color: var(--text-ink);
	}

	.author-meta {
		display: flex;
		align-items: baseline;
		gap: 6px;
		min-width: 0;
		flex: 1;
	}

	.author-name {
		font-weight: 700;
		color: var(--text-ink);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.author-handle {
		color: var(--text-muted, #666);
		text-decoration: none;
		font-size: 0.85rem;
		white-space: nowrap;
	}

	.author-handle:hover {
		text-decoration: underline;
	}

	.author-count {
		flex-shrink: 0;
		min-width: 22px;
		padding: 1px 8px;
		border-radius: 999px;
		text-align: center;
		font-size: 0.8rem;
		font-weight: 700;
		background: color-mix(in srgb, var(--accent) 22%, var(--card-bg));
		color: var(--text-ink);
	}

	.post-list {
		list-style: none;
		margin: 0;
		padding: 0;
	}

	.post-row {
		padding: 7px 12px;
		border-top: 1px solid color-mix(in srgb, var(--control-border) 55%, transparent);
	}

	.post-row:first-child {
		border-top: none;
	}

	.post-text {
		display: block;
		color: var(--text-ink);
		text-decoration: none;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
		line-height: 1.35;
		font-size: 0.92rem;
	}

	.post-text:hover {
		color: var(--accent);
	}

	.highlight-query,
	.highlight-filter {
		border-radius: 4px;
		padding: 0 2px;
		color: var(--text-ink);
	}

	.highlight-query {
		background: color-mix(in srgb, #facc15 48%, transparent);
	}

	.highlight-filter {
		background: color-mix(in srgb, #38bdf8 42%, transparent);
	}

	.quote-embed {
		display: block;
		margin-top: 6px;
		padding: 6px 10px;
		border: 1px solid var(--control-border);
		border-radius: 10px;
		background: color-mix(in srgb, var(--control-bg) 60%, var(--card-bg));
		text-decoration: none;
		color: var(--text-ink);
	}

	.quote-embed:hover {
		border-color: color-mix(in srgb, var(--accent) 45%, var(--control-border));
	}

	.quote-head {
		display: flex;
		align-items: center;
		gap: 6px;
		margin-bottom: 2px;
	}

	.quote-avatar {
		width: 18px;
		height: 18px;
		border-radius: 999px;
		object-fit: cover;
		flex-shrink: 0;
	}

	.quote-author {
		font-weight: 700;
		font-size: 0.82rem;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.quote-handle {
		color: var(--text-muted, #888);
		font-size: 0.78rem;
		white-space: nowrap;
	}

	.quote-text {
		display: block;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
		line-height: 1.3;
		font-size: 0.86rem;
		color: var(--text-muted, #555);
	}

	.post-meta {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 10px;
		margin-top: 2px;
		font-size: 0.75rem;
		color: var(--text-muted, #888);
	}

	.search-tag {
		max-width: 100%;
		padding: 1px 7px;
		border-radius: 999px;
		border: 1px solid color-mix(in srgb, var(--accent) 28%, var(--control-border));
		background: color-mix(in srgb, var(--accent) 9%, var(--card-bg));
		color: var(--text-ink);
		font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
		font-size: 0.72rem;
		overflow-wrap: anywhere;
	}

	.empty-results {
		padding: 12px 14px;
		background: var(--card-bg);
		border: 1px solid var(--control-border);
		color: var(--text-muted, #666);
	}
</style>
