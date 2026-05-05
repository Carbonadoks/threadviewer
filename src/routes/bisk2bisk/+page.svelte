<script lang="ts">
	import { browser } from '$app/environment';
	import { onMount, tick } from 'svelte';
	import '../../app.css';
	import { getFullThread, getProfile } from '$lib/api/bluesky';
	import ErrorBanner from '$lib/components/ErrorBanner.svelte';
	import FontPicker from '$lib/components/FontPicker.svelte';
	import LoadingSpinner from '$lib/components/LoadingSpinner.svelte';
	import ParallelBoardView from '$lib/components/ParallelBoardView.svelte';
	import RouteNav from '$lib/components/RouteNav.svelte';
	import { findFirstMatchingPost } from '$lib/utils/boardTree';
	import type { SelfReplyThread, ThreadPost } from '$lib/types';
	import { buildAtUri, normalizeBskyPostUrl, parseBskyPostUrl } from '$lib/utils/viewerLinks';

	type BoardThread = SelfReplyThread & { isTruncated?: boolean };
	type BiskLoadMode = 'cache' | 'custom';
	type CachedPair = {
		key: string;
		from: string;
		to: string;
	};
	type LoadedSelection = {
		normalizedUrl: string;
		atUri: string;
		thread: BoardThread;
		post: ThreadPost;
	};
	type WinningMoveKind = 'initial-thread' | 'fetched-lane' | 'linked-lane' | 'existing-lane';
	type WinningMoveDetails = {
		kind: WinningMoveKind;
		laneId: string;
		targetUri: string;
		sourceUri?: string | null;
		quotedUri?: string | null;
		summaryPosts?: ThreadPost[];
	};
	type WinningMoveSummary = {
		status: 'waiting' | 'won';
		title: string;
		detail: string;
		note: string;
		trailPosts: ThreadPost[];
		sourceUri?: string | null;
	};

	const DEFAULT_CACHE_KEY = 'bisk2bisk.json';
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
	let inputMode = $state<BiskLoadMode>('custom');
	let loadedMode = $state<BiskLoadMode>('custom');
	let loading = $state(false);
	let loadingLabel = $state('Loading custom pair...');
	let error = $state<string | null>(null);
	let cacheKey = $state(DEFAULT_CACHE_KEY);
	let customFromUrl = $state('');
	let customToUrl = $state('');
	let pair = $state<CachedPair | null>(null);
	let fromSelection = $state<LoadedSelection | null>(null);
	let toSelection = $state<LoadedSelection | null>(null);
	let mainThread = $state<BoardThread | null>(null);
	let targetStartsOnMainThread = $state(false);
	let requestedFocusUri = $state<string | null>(null);
	let winningFocusUri = $state<string | null>(null);
	let activeBoardPost = $state<ThreadPost | null>(null);
	let winningMoveSummary = $state<WinningMoveSummary | null>(null);

	function handleFontChange(key: string) {
		fontKey = key;
		try {
			localStorage.setItem('preferred-font', key);
		} catch {}
	}

	function normalizeCacheKey(value: string | null | undefined): string {
		const trimmed = value?.trim() ?? '';
		if (!trimmed) {
			return DEFAULT_CACHE_KEY;
		}

		return trimmed.replace(/^\/+/, '');
	}

	function normalizeLoadMode(value: string | null | undefined): BiskLoadMode {
		return value?.trim() === 'cache' ? 'cache' : 'custom';
	}

	function updateRouteQueryParams(options: {
		mode: BiskLoadMode;
		key?: string | null;
		from?: string | null;
		to?: string | null;
	}) {
		if (!browser) return;
		const current = new URL(window.location.href);
		if (options.mode === 'custom') {
			current.searchParams.set('mode', 'custom');
			const from = options.from?.trim() ?? '';
			const to = options.to?.trim() ?? '';
			if (from) {
				current.searchParams.set('from', from);
			} else {
				current.searchParams.delete('from');
			}
			if (to) {
				current.searchParams.set('to', to);
			} else {
				current.searchParams.delete('to');
			}
			current.searchParams.delete('key');
		} else {
			const nextKey = normalizeCacheKey(options.key);
			current.searchParams.set('mode', 'cache');
			current.searchParams.delete('from');
			current.searchParams.delete('to');
			if (nextKey && nextKey !== DEFAULT_CACHE_KEY) {
				current.searchParams.set('key', nextKey);
			} else {
				current.searchParams.delete('key');
			}
		}
		window.history.replaceState({}, '', current.toString());
	}

	function formatDate(iso: string): string {
		return new Date(iso).toLocaleDateString('en-US', {
			month: 'short',
			day: 'numeric',
			year: 'numeric'
		});
	}

	function formatCount(value: number): string {
		if (value >= 1000) {
			return `${(value / 1000).toFixed(1).replace(/\.0$/, '')}k`;
		}
		return value.toString();
	}

	function threadContainsPost(thread: BoardThread, uri: string): boolean {
		return Boolean(findFirstMatchingPost(thread.rootPost, (post) => post.uri === uri));
	}

	function isFeaturedActive(selection: LoadedSelection | null): boolean {
		return Boolean(selection && activeBoardPost?.uri === selection.atUri);
	}

	function buildPendingWinningMoveSummary(
		from: LoadedSelection,
		to: LoadedSelection,
		targetIsOnMainThread: boolean
	): WinningMoveSummary {
		if (targetIsOnMainThread) {
			return {
				status: 'waiting',
				title: 'Winning move summary',
				detail: `The target post by @${to.post.author.handle} is already inside the first fetched thread from @${from.post.author.handle}. As soon as the board finishes mounting, that initial fetch should count as the win.`,
				note: 'Status: waiting for the board to snap to the target post.',
				trailPosts: [],
				sourceUri: from.atUri
			};
		}

		return {
			status: 'waiting',
			title: 'Winning move summary',
			detail: `Start from the root lane anchored on @${from.post.author.handle}. Use quote actions to open or fetch lanes until one resolves into the target post by @${to.post.author.handle}.`,
			note: 'Status: no winning lane found yet.',
			trailPosts: [],
			sourceUri: from.atUri
		};
	}

	function getWinningTrailLabel(
		post: ThreadPost,
		index: number,
		total: number,
		sourceUri: string | null | undefined,
		targetUri: string | null | undefined
	): string {
		const normalizedSourceUri = sourceUri?.trim() ?? null;
		const normalizedTargetUri = targetUri?.trim() ?? null;

		if (normalizedSourceUri && post.uri === normalizedSourceUri && normalizedTargetUri === normalizedSourceUri) {
			return 'Source / Target';
		}
		if (normalizedSourceUri && post.uri === normalizedSourceUri) {
			return 'Source';
		}
		if (normalizedTargetUri && post.uri === normalizedTargetUri) {
			return 'Target';
		}
		if (index === 0) {
			return 'Source';
		}
		if (index === total - 1) {
			return 'Target';
		}
		return 'Post';
	}

	function handleWinningMove(details: WinningMoveDetails) {
		const fromHandle = fromSelection?.post.author.handle ?? 'the source post';
		const toHandle = toSelection?.post.author.handle ?? 'the target post';
		const sourceContext =
			details.sourceUri && fromSelection && details.sourceUri !== fromSelection.atUri
				? 'from a discovered side lane'
				: 'from the root lane';

		let detail = `The board locked onto the target post by @${toHandle}.`;
		if (details.kind === 'initial-thread') {
			detail = `The first fetched thread from @${fromHandle} already contained the target post by @${toHandle}, so the board jumped straight to it.`;
		} else if (details.kind === 'fetched-lane') {
			detail = `You fetched a new quoted lane ${sourceContext}, and that fetched thread contained the target post by @${toHandle}.`;
		} else if (details.kind === 'linked-lane') {
			detail = `You opened a lane ${sourceContext}, and it linked directly into the already-open target thread for @${toHandle}.`;
		} else if (details.kind === 'existing-lane') {
			detail = `The lane you opened was already on the board and already connected to the target post by @${toHandle}, so the board jumped back to the win.`;
		}

		const trailPosts = details.summaryPosts ?? [];
		winningMoveSummary = {
			status: 'won',
			title: 'Winning move summary',
			detail,
			note: 'Status: win confirmed. The winning line is shown below.',
			trailPosts,
			sourceUri: trailPosts[0]?.uri ?? fromSelection?.atUri ?? null
		};
	}

	async function loadSelection(bskyUrl: string): Promise<LoadedSelection> {
		const normalizedUrl = normalizeBskyPostUrl(bskyUrl);
		const parsed = normalizedUrl ? parseBskyPostUrl(normalizedUrl) : null;
		if (!normalizedUrl || !parsed) {
			throw new Error('Cached pair contains an invalid Bluesky post URL.');
		}

		const profile = await getProfile(parsed.handle);
		const atUri = buildAtUri(profile.did, parsed.rkey);
		if (!atUri) {
			throw new Error('Could not build an AT URI for a cached post.');
		}

		const thread = await getFullThread(atUri);
		const post =
			findFirstMatchingPost(thread.rootPost, (candidate) => candidate.uri === atUri) ?? thread.rootPost;

		return {
			normalizedUrl,
			atUri,
			thread,
			post
		};
	}

	async function focusFeaturedPost(uri: string) {
		requestedFocusUri = null;
		await tick();
		requestedFocusUri = uri;
	}

	function handleActivePostChange(post: ThreadPost | null) {
		activeBoardPost = post;
	}

	function resetLoadedPairState() {
		pair = null;
		fromSelection = null;
		toSelection = null;
		mainThread = null;
		targetStartsOnMainThread = false;
		activeBoardPost = null;
		requestedFocusUri = null;
		winningFocusUri = null;
		winningMoveSummary = null;
	}

	async function resolvePairSelections(nextPair: { from: string; to: string }) {
		const fromPromise = loadSelection(nextPair.from);
		const toPromise = nextPair.to === nextPair.from ? fromPromise : loadSelection(nextPair.to);
		const [resolvedFrom, resolvedTo] = await Promise.all([fromPromise, toPromise]);
		const targetIsOnMainThread = threadContainsPost(resolvedFrom.thread, resolvedTo.atUri);

		return {
			resolvedFrom,
			resolvedTo,
			targetIsOnMainThread
		};
	}

	async function applyResolvedPair(
		resolvedFrom: LoadedSelection,
		resolvedTo: LoadedSelection,
		targetIsOnMainThread: boolean
	) {
		fromSelection = resolvedFrom;
		toSelection = resolvedTo;
		mainThread = resolvedFrom.thread;
		targetStartsOnMainThread = targetIsOnMainThread;
		winningFocusUri = targetIsOnMainThread ? resolvedTo.atUri : null;
		winningMoveSummary = buildPendingWinningMoveSummary(
			resolvedFrom,
			resolvedTo,
			targetIsOnMainThread
		);

		await focusFeaturedPost(targetIsOnMainThread ? resolvedTo.atUri : resolvedFrom.atUri);
	}

	async function loadCachedPair(requestedKey: string) {
		const nextKey = normalizeCacheKey(requestedKey);
		inputMode = 'cache';
		cacheKey = nextKey;
		loading = true;
		loadingLabel = `Loading Today's Bisk2Bisk...`;
		error = null;
		resetLoadedPairState();

		try {
			const params = new URLSearchParams();
			if (nextKey !== DEFAULT_CACHE_KEY) {
				params.set('key', nextKey);
			}
			const endpoint = params.size ? `/api/bisk2bisk?${params.toString()}` : '/api/bisk2bisk';
			const response = await fetch(endpoint);
			if (!response.ok) {
				throw new Error((await response.text()) || 'Could not load the cached Bisk2Bisk pair.');
			}

			const cachedPair = (await response.json()) as CachedPair;
			const { resolvedFrom, resolvedTo, targetIsOnMainThread } = await resolvePairSelections(cachedPair);
			pair = cachedPair;
			loadedMode = 'cache';
			updateRouteQueryParams({ mode: 'cache', key: nextKey });
			await applyResolvedPair(resolvedFrom, resolvedTo, targetIsOnMainThread);
		} catch (err: unknown) {
			error = err instanceof Error ? err.message : 'Could not load the cached Bisk2Bisk pair.';
		} finally {
			loading = false;
		}
	}

	async function loadCustomPair(requestedFromUrl: string, requestedToUrl: string) {
		inputMode = 'custom';
		customFromUrl = requestedFromUrl.trim();
		customToUrl = requestedToUrl.trim();
		loading = true;
		loadingLabel = 'Loading custom pair...';
		error = null;
		resetLoadedPairState();

		try {
			const normalizedFrom = normalizeBskyPostUrl(requestedFromUrl);
			const normalizedTo = normalizeBskyPostUrl(requestedToUrl);
			if (!normalizedFrom || !normalizedTo) {
				throw new Error('Custom mode needs valid Bluesky post URLs for both "from" and "to".');
			}

			const { resolvedFrom, resolvedTo, targetIsOnMainThread } = await resolvePairSelections({
				from: normalizedFrom,
				to: normalizedTo
			});

			customFromUrl = normalizedFrom;
			customToUrl = normalizedTo;
			loadedMode = 'custom';
			updateRouteQueryParams({
				mode: 'custom',
				from: normalizedFrom,
				to: normalizedTo
			});
			await applyResolvedPair(resolvedFrom, resolvedTo, targetIsOnMainThread);
		} catch (err: unknown) {
			error = err instanceof Error ? err.message : 'Could not load the custom Bisk2Bisk pair.';
		} finally {
			loading = false;
		}
	}

	onMount(() => {
		try {
			const saved = localStorage.getItem('preferred-font');
			if (saved && saved in fontFamilies) {
				fontKey = saved;
			}
		} catch {}

		const params = new URLSearchParams(window.location.search);
		const initialMode = normalizeLoadMode(params.get('mode'));
		const initialKey = normalizeCacheKey(params.get('key'));
		const initialFrom = params.get('from')?.trim() ?? '';
		const initialTo = params.get('to')?.trim() ?? '';
		const hasExplicitCacheRequest = params.get('mode')?.trim() === 'cache' || params.has('key');

		inputMode = initialMode;
		cacheKey = initialKey;
		customFromUrl = initialFrom;
		customToUrl = initialTo;

		if (initialMode === 'custom') {
			const normalizedFrom = normalizeBskyPostUrl(initialFrom);
			const normalizedTo = normalizeBskyPostUrl(initialTo);
			if (normalizedFrom && normalizedTo) {
				customFromUrl = normalizedFrom;
				customToUrl = normalizedTo;
				void loadCustomPair(normalizedFrom, normalizedTo);
				return;
			}
		}

		if (hasExplicitCacheRequest) {
			void loadCachedPair(initialKey);
		}
	});
</script>

<svelte:head>
	<title>Bisk2Bisk</title>
</svelte:head>

<main style="font-family: {fontFamily}">
	<header>
		<RouteNav
			current="bisk2bisk"
			align="center"
			threadUrl={fromSelection?.normalizedUrl ?? null}
			handle={fromSelection?.post.author.handle ?? null}
		/>
		<h1>Bisk2Bisk</h1>
		<p class="subtitle">
			Start in custom mode, or load Today's Bisk2Bisk from R2 and drop it onto the board.
			You can also paste your own
			<code>{`from`}</code> and <code>{`to`}</code> Bluesky post URLs.
		</p>
		<div class="header-meta">
			<span class="meta-pill">
				Loaded mode: {loadedMode === 'custom' ? 'Custom' : "Today's Bisk2Bisk"}
			</span>
			{#if loadedMode !== 'cache'}
				<span class="meta-pill">URL pair: live</span>
			{/if}
			{#if fromSelection && toSelection}
				<span class="meta-note">
					{targetStartsOnMainThread
						? 'The target post is already somewhere inside the fetched root thread.'
						: 'Open quoted lanes until one resolves into the target thread.'}
				</span>
			{/if}
		</div>

		<section class="load-controls wobbly-border-light" aria-label="Bisk2Bisk source mode">
			<div class="load-mode-toggle" role="tablist" aria-label="Bisk2Bisk mode">
				<button
					type="button"
					class="load-mode-btn"
					class:load-mode-btn-active={inputMode === 'cache'}
					role="tab"
					aria-selected={inputMode === 'cache'}
					onclick={() => {
						inputMode = 'cache';
					}}
				>
					Today's Bisk2Bisk
				</button>
				<button
					type="button"
					class="load-mode-btn"
					class:load-mode-btn-active={inputMode === 'custom'}
					role="tab"
					aria-selected={inputMode === 'custom'}
					onclick={() => {
						inputMode = 'custom';
					}}
				>
					Custom
				</button>
			</div>

			{#if inputMode === 'cache'}
				<form
					class="load-form load-form-preset"
					onsubmit={(event) => {
						event.preventDefault();
						void loadCachedPair(cacheKey);
					}}
				>
					<button type="submit" class="load-submit-btn">Load Today's Bisk2Bisk</button>
				</form>
				<p class="load-mode-note">
					Load the cached daily pair from R2 with the named preset button.
				</p>
			{:else}
				<form
					class="load-form load-form-custom"
					onsubmit={(event) => {
						event.preventDefault();
						void loadCustomPair(customFromUrl, customToUrl);
					}}
				>
					<label class="load-field">
						<span class="load-field-label">From URL</span>
						<input
							class="load-field-input"
							type="url"
							bind:value={customFromUrl}
							placeholder="https://bsky.app/profile/.../post/..."
							spellcheck="false"
						/>
					</label>
					<label class="load-field">
						<span class="load-field-label">To URL</span>
						<input
							class="load-field-input"
							type="url"
							bind:value={customToUrl}
							placeholder="https://bsky.app/profile/.../post/..."
							spellcheck="false"
						/>
					</label>
					<button type="submit" class="load-submit-btn">Load custom pair</button>
				</form>
				<p class="load-mode-note">
					After a successful custom load, the page URL is updated with <code>mode=custom</code>,
					<code>from</code>, and <code>to</code> so you can share that exact pair.
				</p>
			{/if}
		</section>
		<FontPicker value={fontKey} onchange={handleFontChange} />
	</header>

	{#if error}
		<ErrorBanner message={error} />
	{/if}

	{#if loading}
		<LoadingSpinner progress={{ phase: loadingLabel, current: 0, total: 0 }} />
	{/if}

	{#if fromSelection && toSelection && mainThread}
		{@const fromPost = fromSelection}
		{@const toPost = toSelection}
		<section class="featured-posts" aria-label="Cached post pair">
			<article
				class="featured-post-card featured-post-card-from wobbly-border-light"
				class:featured-post-card-active={isFeaturedActive(fromPost)}
			>
				<div class="featured-card-topline">
					<div class="featured-card-tags">
						<span class="featured-card-label">From</span>
						<span class="featured-card-tag">Root lane anchor</span>
					</div>
					<div class="featured-card-actions">
						<button
							type="button"
							class="featured-card-focus-btn"
							onclick={() => void focusFeaturedPost(fromPost.atUri)}
						>
							Focus
						</button>
						<a
							class="featured-card-link"
							href={fromPost.normalizedUrl}
							target="_blank"
							rel="noopener noreferrer"
						>
							Open post
						</a>
					</div>
				</div>

				<div class="featured-card-author">
					{#if fromPost.post.author.avatar}
						<img src={fromPost.post.author.avatar} alt="" class="featured-card-avatar" />
					{:else}
						<div class="featured-card-avatar featured-card-avatar-placeholder"></div>
					{/if}
					<div class="featured-card-author-copy">
						<strong>@{fromPost.post.author.handle}</strong>
						<span>{formatDate(fromPost.post.createdAt)}</span>
					</div>
				</div>

				<p class="featured-card-text">{fromPost.post.text || 'No text'}</p>

				<div class="featured-card-stats">
					<span>{formatCount(fromPost.post.replyCount)} replies</span>
					<span>{formatCount(fromPost.post.quoteCount)} quotes</span>
					<span>{formatCount(fromPost.post.likeCount)} likes</span>
				</div>
			</article>

			<article
				class="featured-post-card featured-post-card-to wobbly-border-light"
				class:featured-post-card-active={isFeaturedActive(toPost)}
			>
				<div class="featured-card-topline">
					<div class="featured-card-tags">
						<span class="featured-card-label">To</span>
						<span class="featured-card-tag">Celebration target</span>
					</div>
					<div class="featured-card-actions">
						<button
							type="button"
							class="featured-card-focus-btn"
							onclick={() => void focusFeaturedPost(toPost.atUri)}
						>
							Focus
						</button>
						<a
							class="featured-card-link"
							href={toPost.normalizedUrl}
							target="_blank"
							rel="noopener noreferrer"
						>
							Open post
						</a>
					</div>
				</div>

				<div class="featured-card-author">
					{#if toPost.post.author.avatar}
						<img src={toPost.post.author.avatar} alt="" class="featured-card-avatar" />
					{:else}
						<div class="featured-card-avatar featured-card-avatar-placeholder"></div>
					{/if}
					<div class="featured-card-author-copy">
						<strong>@{toPost.post.author.handle}</strong>
						<span>{formatDate(toPost.post.createdAt)}</span>
					</div>
				</div>

				<p class="featured-card-text">{toPost.post.text || 'No text'}</p>

				<div class="featured-card-stats">
					<span>{formatCount(toPost.post.replyCount)} replies</span>
					<span>{formatCount(toPost.post.quoteCount)} quotes</span>
					<span>{formatCount(toPost.post.likeCount)} likes</span>
				</div>
			</article>
		</section>

		{#if winningMoveSummary}
			<section
				class="winning-move-summary wobbly-border-light"
				class:winning-move-summary-won={winningMoveSummary.status === 'won'}
				aria-label="Winning move summary"
			>
				<div class="winning-move-topline">
					<div>
						<p class="winning-move-kicker">{winningMoveSummary.title}</p>
						<h2 class="winning-move-heading">
							{winningMoveSummary.status === 'won' ? 'You found the winning move' : 'How to win this board'}
						</h2>
					</div>
					<span class="winning-move-status">
						{winningMoveSummary.status === 'won' ? 'Win confirmed' : 'Waiting'}
					</span>
				</div>

				<p class="winning-move-detail">{winningMoveSummary.detail}</p>
				{#if winningMoveSummary.status === 'won' && winningMoveSummary.trailPosts.length > 0}
					<div class="winning-move-trail" aria-label="Winning move trail">
						{#each winningMoveSummary.trailPosts as post, index (post.uri)}
							{#if index > 0}
								<span class="winning-move-trail-connector" aria-hidden="true">-</span>
							{/if}

								{@const trailLabel = getWinningTrailLabel(
									post,
									index,
									winningMoveSummary.trailPosts.length,
									winningMoveSummary.sourceUri,
									toSelection?.atUri
								)}
							<article
								class="winning-trail-card"
								class:winning-trail-card-source={trailLabel === 'Source'}
								class:winning-trail-card-target={trailLabel === 'Target'}
								class:winning-trail-card-endpoint={trailLabel === 'Source / Target'}
							>
								<div class="winning-trail-card-topline">
									<span class="winning-trail-card-label">{trailLabel}</span>
									<span class="winning-trail-card-handle">@{post.author.handle}</span>
								</div>
								<p class="winning-trail-card-text">{post.text || 'No text'}</p>
							</article>
						{/each}
					</div>
				{/if}
				<p class="winning-move-note">{winningMoveSummary.note}</p>
			</section>
		{/if}

		{#if mainThread.isTruncated}
			<p class="truncation-warning">Some replies may still be missing from the loaded thread.</p>
		{/if}

		<ParallelBoardView
			thread={mainThread}
			mainLaneAnchorUri={fromSelection.atUri}
			sourceUri={fromSelection.atUri}
			targetUri={toSelection.atUri}
			{requestedFocusUri}
			{winningFocusUri}
			onActivePostChange={handleActivePostChange}
			onWinningMove={handleWinningMove}
		/>
	{/if}
</main>

<style>
	main {
		max-width: 100%;
		margin: 0 auto;
		padding: 32px 20px 48px;
	}

	header {
		max-width: 1240px;
		margin: 0 auto 26px;
		text-align: center;
	}

	h1 {
		margin: 8px 0 4px;
		font-size: clamp(2.1rem, 5vw, 3.1rem);
		color: var(--text-ink);
	}

	.subtitle {
		max-width: 760px;
		margin: 0 auto;
		color: var(--muted);
		font-size: 1rem;
		line-height: 1.55;
	}

	.subtitle code {
		font-family: 'Courier New', monospace;
		font-size: 0.9em;
	}

	.header-meta {
		display: flex;
		align-items: center;
		justify-content: center;
		flex-wrap: wrap;
		gap: 10px;
		margin: 14px 0 18px;
	}

	.meta-pill,
	.meta-note {
		font-family: 'Courier New', monospace;
		font-size: 0.78rem;
	}

	.meta-pill {
		padding: 7px 12px;
		border-radius: 999px;
		background: rgba(255, 252, 245, 0.9);
		border: 1px solid rgba(61, 64, 91, 0.14);
		color: #3e3746;
		box-shadow: 0 10px 22px rgba(26, 35, 44, 0.08);
	}

	.meta-note {
		color: #6b6375;
	}

	.load-controls {
		max-width: 920px;
		margin: 0 auto 18px;
		padding: 16px 18px;
		background:
			radial-gradient(circle at top left, rgba(255, 255, 255, 0.58), transparent 40%),
			linear-gradient(180deg, rgba(255, 251, 243, 0.98), rgba(244, 236, 219, 0.98));
		box-shadow: 0 18px 34px rgba(27, 35, 44, 0.08);
	}

	.load-mode-toggle {
		display: inline-flex;
		padding: 4px;
		border-radius: 999px;
		background: rgba(255, 255, 255, 0.78);
		border: 1px solid rgba(61, 64, 91, 0.14);
		box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.7);
	}

	.load-mode-btn {
		padding: 9px 14px;
		border: 0;
		border-radius: 999px;
		background: transparent;
		color: #635b6d;
		font-family: 'Courier New', monospace;
		font-size: 0.78rem;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		cursor: pointer;
		transition:
			background 0.18s ease,
			color 0.18s ease,
			transform 0.18s ease;
	}

	.load-mode-btn:hover {
		color: #3f3748;
	}

	.load-mode-btn-active {
		background: rgba(111, 97, 255, 0.12);
		color: #433a9a;
		transform: translateY(-1px);
	}

	.load-form {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		gap: 12px;
		align-items: end;
		margin-top: 14px;
	}

	.load-form-preset {
		grid-template-columns: auto;
		justify-content: start;
	}

	.load-form-custom {
		grid-template-columns: repeat(2, minmax(0, 1fr)) auto;
	}

	.load-field {
		display: flex;
		flex-direction: column;
		gap: 6px;
		text-align: left;
	}

	.load-field-label {
		font-family: 'Courier New', monospace;
		font-size: 0.74rem;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: #6f6679;
	}

	.load-field-input {
		width: 100%;
		padding: 11px 13px;
		border-radius: 14px;
		border: 1px solid rgba(61, 64, 91, 0.16);
		background: rgba(255, 255, 255, 0.84);
		color: #312b38;
		font-size: 0.95rem;
		box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.72);
	}

	.load-field-input:focus {
		outline: 3px solid rgba(111, 97, 255, 0.18);
		outline-offset: 2px;
		border-color: rgba(111, 97, 255, 0.4);
	}

	.load-submit-btn {
		padding: 11px 15px;
		border: 1px solid rgba(61, 64, 91, 0.14);
		border-radius: 14px;
		background: linear-gradient(180deg, rgba(255, 255, 255, 0.92), rgba(241, 231, 211, 0.94));
		color: #3f3748;
		font-size: 0.84rem;
		font-weight: 700;
		cursor: pointer;
		box-shadow: 0 12px 20px rgba(27, 35, 44, 0.08);
	}

	.load-submit-btn:hover {
		background: linear-gradient(180deg, rgba(255, 255, 255, 0.96), rgba(234, 221, 193, 0.96));
	}

	.load-mode-note {
		margin: 12px 0 0;
		color: #6b6375;
		font-size: 0.84rem;
		line-height: 1.55;
		text-align: left;
	}

	.load-mode-note code {
		font-family: 'Courier New', monospace;
		font-size: 0.9em;
	}

	.featured-posts {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 18px;
		max-width: 1240px;
		margin: 0 auto 22px;
	}

	.featured-post-card {
		display: flex;
		flex-direction: column;
		gap: 14px;
		padding: 18px;
		background:
			radial-gradient(circle at top left, rgba(255, 255, 255, 0.58), transparent 42%),
			linear-gradient(180deg, rgba(255, 250, 240, 0.98), rgba(247, 239, 223, 0.98));
		box-shadow: 0 18px 34px rgba(27, 35, 44, 0.09);
		cursor: pointer;
		transition:
			transform 0.18s ease,
			box-shadow 0.18s ease,
			border-color 0.18s ease;
	}

	.featured-post-card:hover,
	.featured-post-card:focus-visible {
		transform: translateY(-2px);
		box-shadow: 0 22px 40px rgba(27, 35, 44, 0.12);
	}

	.featured-post-card:focus-visible {
		outline: 3px solid rgba(111, 97, 255, 0.28);
		outline-offset: 3px;
	}

	.featured-post-card-from {
		border-color: rgba(78, 150, 134, 0.34);
	}

	.featured-post-card-to {
		border-color: rgba(224, 122, 95, 0.34);
	}

	.featured-post-card-active {
		box-shadow:
			0 0 0 4px rgba(111, 97, 255, 0.12),
			0 22px 40px rgba(27, 35, 44, 0.14);
	}

	.featured-post-card-from.featured-post-card-active {
		box-shadow:
			0 0 0 4px rgba(78, 150, 134, 0.16),
			0 22px 40px rgba(27, 35, 44, 0.14);
	}

	.featured-post-card-to.featured-post-card-active {
		box-shadow:
			0 0 0 4px rgba(224, 122, 95, 0.16),
			0 22px 40px rgba(27, 35, 44, 0.16);
	}

	.featured-card-topline {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 12px;
	}

	.featured-card-actions {
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.featured-card-tags {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}

	.featured-card-label,
	.featured-card-tag {
		padding: 5px 9px;
		border-radius: 999px;
		font-family: 'Courier New', monospace;
		font-size: 0.66rem;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.06em;
	}

	.featured-card-label {
		background: rgba(59, 53, 71, 0.08);
		color: #3f3748;
	}

	.featured-post-card-from .featured-card-tag {
		background: rgba(78, 150, 134, 0.12);
		color: #27685d;
	}

	.featured-post-card-to .featured-card-tag {
		background: rgba(224, 122, 95, 0.12);
		color: #a6462f;
	}

	.featured-card-link {
		flex-shrink: 0;
		color: var(--accent);
		font-size: 0.85rem;
		font-weight: 700;
		text-decoration: none;
	}

	.featured-card-focus-btn {
		padding: 7px 12px;
		border-radius: 999px;
		border: 1px solid rgba(61, 64, 91, 0.14);
		background: rgba(255, 255, 255, 0.78);
		color: #3f3748;
		font-size: 0.78rem;
		font-weight: 700;
		cursor: pointer;
	}

	.featured-card-focus-btn:hover {
		background: rgba(111, 97, 255, 0.1);
	}

	.featured-card-link:hover {
		text-decoration: underline;
	}

	.featured-card-author {
		display: flex;
		align-items: center;
		gap: 12px;
	}

	.featured-card-avatar {
		width: 46px;
		height: 46px;
		border-radius: 999px;
		object-fit: cover;
		border: 2px solid rgba(255, 255, 255, 0.85);
		box-shadow: 0 10px 18px rgba(32, 39, 48, 0.12);
		background: rgba(255, 255, 255, 0.9);
	}

	.featured-card-avatar-placeholder {
		background:
			linear-gradient(135deg, rgba(248, 237, 221, 0.96), rgba(230, 216, 199, 0.96));
	}

	.featured-card-author-copy {
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-width: 0;
	}

	.featured-card-author-copy strong {
		font-size: 1rem;
		color: #2d2934;
	}

	.featured-card-author-copy span {
		color: #776f81;
		font-size: 0.82rem;
	}

	.featured-card-text {
		margin: 0;
		font-size: 0.98rem;
		line-height: 1.58;
		color: #3b3542;
		display: -webkit-box;
		line-clamp: 6;
		-webkit-box-orient: vertical;
		-webkit-line-clamp: 6;
		overflow: hidden;
	}

	.featured-card-stats {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}

	.featured-card-stats span {
		padding: 6px 10px;
		border-radius: 999px;
		background: rgba(255, 255, 255, 0.78);
		color: #5f5869;
		font-family: 'Courier New', monospace;
		font-size: 0.72rem;
	}

	.winning-move-summary {
		max-width: 1240px;
		margin: 0 auto 22px;
		padding: 18px 20px;
		background:
			radial-gradient(circle at top right, rgba(255, 255, 255, 0.58), transparent 38%),
			linear-gradient(180deg, rgba(255, 252, 244, 0.98), rgba(245, 238, 222, 0.98));
		box-shadow: 0 18px 34px rgba(27, 35, 44, 0.08);
	}

	.winning-move-summary-won {
		border-color: rgba(236, 178, 64, 0.54);
		background:
			radial-gradient(circle at top right, rgba(255, 251, 219, 0.68), transparent 40%),
			linear-gradient(180deg, rgba(255, 249, 233, 0.99), rgba(246, 235, 201, 0.99));
		box-shadow:
			0 0 0 4px rgba(236, 178, 64, 0.1),
			0 20px 38px rgba(27, 35, 44, 0.1);
	}

	.winning-move-topline {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 16px;
		margin-bottom: 10px;
	}

	.winning-move-kicker,
	.winning-move-note {
		margin: 0;
		font-family: 'Courier New', monospace;
	}

	.winning-move-kicker {
		font-size: 0.72rem;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: #7a7284;
	}

	.winning-move-heading {
		margin: 4px 0 0;
		font-size: 1.28rem;
		color: #2f2935;
	}

	.winning-move-status {
		padding: 7px 12px;
		border-radius: 999px;
		background: rgba(255, 255, 255, 0.76);
		color: #5d5767;
		font-family: 'Courier New', monospace;
		font-size: 0.75rem;
		font-weight: 700;
		white-space: nowrap;
	}

	.winning-move-summary-won .winning-move-status {
		background: rgba(236, 178, 64, 0.18);
		color: #8c5f00;
	}

	.winning-move-detail {
		margin: 0 0 10px;
		font-size: 0.98rem;
		line-height: 1.62;
		color: #3b3542;
	}

	.winning-move-note {
		font-size: 0.8rem;
		color: #6d6579;
	}

	.winning-move-trail {
		display: flex;
		align-items: stretch;
		gap: 10px;
		margin-bottom: 12px;
		padding-bottom: 4px;
		overflow-x: auto;
		scrollbar-width: thin;
	}

	.winning-move-trail-connector {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		flex: 0 0 auto;
		align-self: center;
		color: #8a6f2f;
		font-family: 'Courier New', monospace;
		font-size: 1.2rem;
		font-weight: 700;
	}

	.winning-trail-card {
		flex: 0 0 168px;
		display: flex;
		flex-direction: column;
		gap: 10px;
		padding: 12px 13px;
		border-radius: 18px;
		border: 1px solid rgba(61, 64, 91, 0.14);
		background:
			radial-gradient(circle at top left, rgba(255, 255, 255, 0.62), transparent 44%),
			linear-gradient(180deg, rgba(255, 255, 249, 0.98), rgba(245, 238, 220, 0.98));
		box-shadow: 0 12px 22px rgba(27, 35, 44, 0.08);
	}

	.winning-trail-card-source {
		border-color: rgba(78, 150, 134, 0.36);
		background:
			radial-gradient(circle at top left, rgba(255, 255, 255, 0.62), transparent 44%),
			linear-gradient(180deg, rgba(243, 251, 247, 0.99), rgba(223, 241, 234, 0.99));
	}

	.winning-trail-card-target {
		border-color: rgba(224, 122, 95, 0.36);
		background:
			radial-gradient(circle at top left, rgba(255, 255, 255, 0.62), transparent 44%),
			linear-gradient(180deg, rgba(255, 246, 242, 0.99), rgba(249, 226, 216, 0.99));
	}

	.winning-trail-card-endpoint {
		border-color: rgba(176, 126, 20, 0.42);
		background:
			radial-gradient(circle at top left, rgba(255, 255, 255, 0.62), transparent 44%),
			linear-gradient(180deg, rgba(255, 250, 236, 0.99), rgba(247, 235, 199, 0.99));
	}

	.winning-trail-card-topline {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.winning-trail-card-label,
	.winning-trail-card-handle {
		font-family: 'Courier New', monospace;
	}

	.winning-trail-card-label {
		width: fit-content;
		padding: 4px 8px;
		border-radius: 999px;
		background: rgba(59, 53, 71, 0.08);
		color: #3f3748;
		font-size: 0.62rem;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.08em;
	}

	.winning-trail-card-handle {
		color: #6d6579;
		font-size: 0.72rem;
	}

	.winning-trail-card-text {
		margin: 0;
		font-size: 0.82rem;
		line-height: 1.48;
		color: #332d3a;
		display: -webkit-box;
		line-clamp: 4;
		-webkit-box-orient: vertical;
		-webkit-line-clamp: 4;
		overflow: hidden;
	}

	.truncation-warning {
		max-width: 1240px;
		margin: 0 auto 18px;
		padding: 11px 14px;
		border-radius: 14px;
		background: rgba(255, 233, 184, 0.62);
		color: #6e4a00;
		font-family: 'Courier New', monospace;
		font-size: 0.82rem;
		text-align: center;
	}

	@media (max-width: 860px) {
		main {
			padding: 28px 14px 40px;
		}

		.load-form,
		.load-form-custom {
			grid-template-columns: 1fr;
		}

		.featured-posts {
			grid-template-columns: 1fr;
		}

		.winning-move-topline {
			flex-direction: column;
			align-items: flex-start;
		}
	}
</style>
