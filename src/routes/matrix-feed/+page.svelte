<script lang="ts">
	import { onMount } from 'svelte';
	import { browser } from '$app/environment';
	import type { Agent } from '@atproto/api';
	import type { BrowserOAuthClient } from '@atproto/oauth-client-browser';
	import '../../app.css';
	import RouteNav from '$lib/components/RouteNav.svelte';
	import MatrixFeedTerminal, { type MatrixTerminalPost } from '$lib/components/MatrixFeedTerminal.svelte';
	import MatrixPostPreviewOverlay from '$lib/components/MatrixPostPreviewOverlay.svelte';
	import MatrixControlGrid from '$lib/components/MatrixControlGrid.svelte';
	import type { ProfileInfo } from '$lib/api/bluesky';
	import { createMatrixSettings, LIVE_REFRESH_MS } from '$lib/stores/matrixSettings.svelte';
	import { mapFeedItem } from '$lib/utils/matrixFeedMapper';
	import {
		FOLLOWING_FEED_ID,
		connectBlueskyWithPopup,
		disconnectBluesky,
		fetchPersonalFeedPosts,
		initAuthenticatedBlueskyClient,
		resolvePersonalFeeds,
		type AuthenticatedBlueskyContext,
		type PersonalFeedOption
	} from '$lib/api/blueskyAuth';

	let loading = $state(false);
	let connecting = $state(false);
	let restoringSession = $state(true);
	let loadingFeeds = $state(false);
	let error: string | null = $state(null);
	let profile: ProfileInfo | null = $state(null);
	let posts: MatrixTerminalPost[] = $state([]);
	let feedOptions: PersonalFeedOption[] = $state([]);
	let selectedFeedId = $state(FOLLOWING_FEED_ID);
	let isBackgroundRefreshing = $state(false);
	let lastSyncedAt = $state('');
	let sessionSub = $state<string | null>(null);
	let authClient: BrowserOAuthClient | null = null;
	let authAgent: Agent | null = null;
	let feedRequestToken = 0;
	let liveRefreshEpoch = $state(0);
	let previewPost = $state<MatrixTerminalPost | null>(null);

	const settings = createMatrixSettings('matrix-feed');

	const FEED_STORAGE_KEY_PREFIX = 'matrix-feed-selection';

	let previewOpen = $derived(previewPost !== null);
	let selectedFeed = $derived(feedOptions.find((option) => option.id === selectedFeedId) ?? null);
	let isSessionReady = $derived(Boolean(profile && sessionSub && authAgent));
	let sessionLabel = $derived.by(() => {
		if (profile) return `Connected as @${profile.handle}`;
		if (connecting) return 'Connecting...';
		if (restoringSession) return 'Restoring session...';
		return 'Guest mode';
	});

	const syncFormatter = new Intl.DateTimeFormat('en-US', {
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit',
		hour12: false
	});

	const ERROR_AUTO_CLEAR_MS = 8000;
	let errorClearTimer: ReturnType<typeof setTimeout> | null = null;

	function setError(message: string | null) {
		if (errorClearTimer) {
			clearTimeout(errorClearTimer);
			errorClearTimer = null;
		}
		error = message;
		if (message) {
			errorClearTimer = setTimeout(() => {
				error = null;
				errorClearTimer = null;
			}, ERROR_AUTO_CLEAR_MS);
		}
	}

	function getFeedStorageKey(sub: string): string {
		return `${FEED_STORAGE_KEY_PREFIX}:${sub}`;
	}

	function readRequestedFeedId(): string | null {
		if (!browser) return null;
		return new URL(window.location.href).searchParams.get('feed');
	}

	function readStoredFeedId(sub: string): string | null {
		if (!browser) return null;
		return localStorage.getItem(getFeedStorageKey(sub));
	}

	function persistSelectedFeedId(sub: string, feedId: string) {
		if (browser) localStorage.setItem(getFeedStorageKey(sub), feedId);
	}

	function clearStoredFeedId(sub: string | null) {
		if (!browser || !sub) return;
		localStorage.removeItem(getFeedStorageKey(sub));
	}

	function updateFeedQuery(feedId: string | null) {
		if (!browser) return;
		const url = new URL(window.location.href);
		if (feedId) {
			url.searchParams.set('feed', feedId);
		} else {
			url.searchParams.delete('feed');
		}
		window.history.replaceState({}, '', url.toString());
	}

	function formatAuthError(err: unknown, fallback: string): string {
		const message = String((err as { message?: string } | null | undefined)?.message ?? '');
		if (message.includes('Missing required scope')) {
			return 'Your previous Bluesky grant was missing feed permissions. Connect again to refresh the grant.';
		}
		return message || fallback;
	}

	function stampSyncedNow() {
		lastSyncedAt = syncFormatter.format(new Date());
	}

	function bumpLiveRefreshEpoch() {
		liveRefreshEpoch++;
	}

	function resetGuestState(clearPosts = true) {
		clearStoredFeedId(sessionSub);
		sessionSub = null;
		profile = null;
		feedOptions = [];
		selectedFeedId = FOLLOWING_FEED_ID;
		authAgent = null;
		if (clearPosts) {
			posts = [];
		}
		updateFeedQuery(null);
	}

	function resolveInitialFeedId(options: PersonalFeedOption[], preferredFeedId: string | null): string {
		if (preferredFeedId && options.some((option) => option.id === preferredFeedId)) {
			return preferredFeedId;
		}

		const firstPinnedCustomFeed = options.find(
			(option) => option.kind === 'feed' && option.pinned
		);
		return firstPinnedCustomFeed?.id ?? FOLLOWING_FEED_ID;
	}

	async function refreshFeed(
		feed: PersonalFeedOption,
		options: { background?: boolean } = {}
	) {
		if (!authAgent) return;

		const requestToken = ++feedRequestToken;
		const background = options.background ?? false;

		if (background) {
			isBackgroundRefreshing = true;
		} else {
			loading = true;
			setError(null);
		}

		try {
			const result = await fetchPersonalFeedPosts(authAgent, feed);
			const mappedPosts = result.posts
				.slice(0, 100)
				.map(mapFeedItem)
				.filter((entry): entry is MatrixTerminalPost => Boolean(entry));

			if (requestToken !== feedRequestToken) return;

			posts = mappedPosts;
			selectedFeedId = feed.id;
			if (sessionSub) {
				persistSelectedFeedId(sessionSub, feed.id);
			}
			updateFeedQuery(feed.id);
			stampSyncedNow();
			if (background) setError(null);
		} catch (err: any) {
			if (requestToken !== feedRequestToken) return;

			if (background) {
				setError(err?.message || `Background refresh failed for ${feed.label}.`);
				return;
			}

			setError(err?.message || `Could not load ${feed.label}.`);
			posts = [];
		} finally {
			if (requestToken !== feedRequestToken) return;

			if (background) {
				isBackgroundRefreshing = false;
			} else {
				loading = false;
			}
		}
	}

	async function loadFeedsForContext(
		context: AuthenticatedBlueskyContext,
		preferredFeedId: string | null = null
	) {
		authAgent = context.agent;
		profile = context.profile;
		sessionSub = context.session.sub;
		loadingFeeds = true;

		try {
			const options = await resolvePersonalFeeds(context.agent);
			feedOptions = options;
			const nextFeedId = resolveInitialFeedId(options, preferredFeedId);
			selectedFeedId = nextFeedId;
			const nextFeed = options.find((option) => option.id === nextFeedId) ?? options[0];
			if (nextFeed) {
				await refreshFeed(nextFeed);
			}
		} finally {
			loadingFeeds = false;
		}
	}

	async function applyAuthenticatedContext(context: AuthenticatedBlueskyContext) {
		const requestedFeedId = readRequestedFeedId();
		const storedFeedId = readStoredFeedId(context.session.sub);
		await loadFeedsForContext(context, requestedFeedId ?? storedFeedId);
	}

	async function restoreSession() {
		restoringSession = true;
		setError(null);

		try {
			const { client, context } = await initAuthenticatedBlueskyClient();
			authClient = client;
			if (context) {
				await applyAuthenticatedContext(context);
			} else {
				resetGuestState();
			}
		} catch (err: any) {
			const message = String(err?.message || '');
			if (message.includes('Redirecting to loopback IP')) {
				return;
			}
			setError(formatAuthError(err, 'Could not restore your Bluesky session.'));
			resetGuestState();
		} finally {
			restoringSession = false;
		}
	}

	async function handleConnect() {
		connecting = true;
		setError(null);

		try {
			const context = await connectBlueskyWithPopup();
			authClient = context.client;
			await applyAuthenticatedContext(context);
		} catch (err: any) {
			setError(formatAuthError(err, 'Could not connect your Bluesky account.'));
		} finally {
			connecting = false;
		}
	}

	async function handleDisconnect() {
		const sub = sessionSub;
		if (!sub) return;

		try {
			await disconnectBluesky(sub);
			resetGuestState();
		} catch (err: any) {
			setError(err?.message || 'Could not disconnect your Bluesky session.');
		}
	}

	async function handleRefreshNow() {
		if (!selectedFeed) return;
		bumpLiveRefreshEpoch();
		await refreshFeed(selectedFeed);
	}

	async function handleFeedChange(event: Event) {
		const nextId = (event.currentTarget as HTMLSelectElement).value;
		const nextFeed = feedOptions.find((option) => option.id === nextId);
		if (!nextFeed) return;
		bumpLiveRefreshEpoch();
		await refreshFeed(nextFeed);
	}

	function handleSessionDeleted() {
		setError('Your Bluesky session expired. Connect again when you want your feeds back.');
		resetGuestState();
	}

	function addAuthClientListener(client: BrowserOAuthClient, handler: EventListener) {
		(client as unknown as EventTarget).addEventListener('deleted', handler);
	}

	function removeAuthClientListener(client: BrowserOAuthClient | null, handler: EventListener) {
		(client as unknown as EventTarget | null)?.removeEventListener('deleted', handler);
	}

	function toggleControls() {
		settings.controlsCollapsed = !settings.controlsCollapsed;
	}

	onMount(() => {
		settings.restore();
		void restoreSession();

		return () => {
			removeAuthClientListener(authClient, handleSessionDeleted as EventListener);
		};
	});

	$effect(() => { settings.speed; if (browser) settings.persistSpeed(); });
	$effect(() => { settings.panelCount; if (browser) settings.persistPanels(); });
	$effect(() => { settings.layoutMode; if (browser) settings.persistLayout(); });
	$effect(() => { settings.renderStyle; if (browser) settings.persistRender(); });
	$effect(() => { settings.terminalFontId; if (browser) settings.persistFont(); });
	$effect(() => { settings.liveRefreshEnabled; if (browser) settings.persistLive(); });
	$effect(() => { settings.controlsCollapsed; if (browser) settings.persistCollapsed(); });

	$effect(() => {
		if (!authClient) return;
		addAuthClientListener(authClient, handleSessionDeleted as EventListener);

		return () => {
			removeAuthClientListener(authClient, handleSessionDeleted as EventListener);
		};
	});

	$effect(() => {
		if (!browser) return;
		if (!selectedFeed || !profile || !settings.liveRefreshEnabled || previewOpen) return;

		void liveRefreshEpoch;
		const currentFeed = selectedFeed;

		const interval = window.setInterval(() => {
			if (!currentFeed || !profile || loading || loadingFeeds || isBackgroundRefreshing || previewOpen) {
				return;
			}
			void refreshFeed(currentFeed, { background: true });
		}, LIVE_REFRESH_MS);

		return () => {
			window.clearInterval(interval);
		};
	});
</script>

<svelte:head>
	<title>In Matrix Feed</title>
</svelte:head>

<main class="matrix-shell">
	{#if !settings.controlsCollapsed}
		<div class="matrix-overlay">
			<button type="button" class="matrix-overlay-dismiss" onclick={toggleControls}>
				Close UI
			</button>
			<section class="matrix-chrome">
				<div class="toolbar">
					<div class="toolbar-left">
						<RouteNav current="matrix-feed" compact handle={profile?.handle ?? null} />
						<div class="title-stack">
							<span class="toolbar-title">In Matrix Feed</span>
							<span class="toolbar-subtitle">
								{#if profile}
									{selectedFeed?.label ?? 'Following'} :: authenticated as @{profile.handle}
								{:else}
									Guest mode until you explicitly connect Bluesky
								{/if}
							</span>
						</div>
					</div>

					<div class="toolbar-right">
						<span class="tiny-pill">{posts.length} posts</span>
						<span class="tiny-pill">{selectedFeed?.label ?? 'Guest'}</span>
						<span class="tiny-pill">{settings.panelCount} panels</span>
						<span class="tiny-pill">{lastSyncedAt || '--:--:--'}</span>
						{#if profile}
							<a
								class="profile-link"
								href={`https://bsky.app/profile/${profile.handle}`}
								target="_blank"
								rel="noreferrer"
							>
								Open @{profile.handle}
							</a>
						{/if}
						<button type="button" class="collapse-btn" onclick={toggleControls}>
							Hide UI
						</button>
					</div>
				</div>

				<div class="control-stack">
					<div class="control-top-row">
						<div class="control-card session-card">
						<div class="control-copy">
							<span class="control-label">Connection</span>
							<span class="control-value">{sessionLabel}</span>
						</div>

						{#if profile}
							<div class="session-row">
								<div class="session-identity">
									{#if profile.avatar}
										<img src={profile.avatar} alt="" />
									{:else}
										<div class="avatar-placeholder"></div>
									{/if}
									<div class="session-copy">
										<span>{profile.displayName || profile.handle}</span>
										<span class="session-handle">@{profile.handle}</span>
									</div>
								</div>
								<div class="session-actions">
									<button
										type="button"
										class="session-button"
										onclick={handleRefreshNow}
										disabled={loading || loadingFeeds || !selectedFeed}
									>
										{loading ? 'Syncing...' : 'Refresh now'}
									</button>
									<button type="button" class="session-button ghost" onclick={handleDisconnect}>
										Disconnect
									</button>
								</div>
							</div>
						{:else}
							<div class="guest-copy">
								<span>
									The matrix shell stays visible in guest mode. Connect only when you want your saved
									feeds.
								</span>
								<button type="button" class="session-button" onclick={handleConnect} disabled={connecting || restoringSession}>
									{connecting ? 'Opening Bluesky...' : 'Connect Bluesky'}
								</button>
							</div>
						{/if}
					</div>

					</div>

					<div class="control-inner-grid">
						<div class="control-card feed-card">
							<div class="control-copy">
								<span class="control-label">Feed Source</span>
								<span class="control-value">
									{#if loadingFeeds}
										Loading your feeds...
									{:else if selectedFeed}
										{selectedFeed.label}
									{:else}
										Connect to choose a feed
									{/if}
								</span>
							</div>

							<select
								class="feed-select"
								bind:value={selectedFeedId}
								onchange={handleFeedChange}
								disabled={!isSessionReady || loadingFeeds || connecting}
								aria-label="Choose a Bluesky feed"
							>
								<option value={FOLLOWING_FEED_ID} disabled={!isSessionReady && feedOptions.length === 0}>
									{isSessionReady ? 'Following' : 'Connect Bluesky first'}
								</option>
								{#each feedOptions.filter((option) => option.id !== FOLLOWING_FEED_ID) as option}
									<option value={option.id}>
										{option.pinned ? 'Pinned :: ' : ''}{option.label}
									</option>
								{/each}
							</select>

							<div class="feed-summary">
								{#if selectedFeed}
									<span>{selectedFeed.description}</span>
									{#if selectedFeed.creatorHandle}
										<span class="session-handle">@{selectedFeed.creatorHandle}</span>
									{/if}
								{:else}
									<span>Following plus your pinned and saved custom feeds will appear here.</span>
								{/if}
							</div>
						</div>

						<MatrixControlGrid
							{settings}
							loading={loading || loadingFeeds}
							{isBackgroundRefreshing}
							profileHandle={profile?.handle ?? null}
							feedLabel={selectedFeed?.label ?? null}
							waitingLabel="waiting for explicit connect"
						/>
					</div>
				</div>

				{#if error}
					<div class="status-row">
						<div class="status-pill error-pill">{error}</div>
					</div>
				{/if}
			</section>
		</div>
	{/if}

	<section class="terminal-stage">
		{#if settings.controlsCollapsed}
			<button type="button" class="terminal-ui-trigger" onclick={() => (settings.controlsCollapsed = false)}>
				<span class="terminal-ui-shell">
					<span class="terminal-ui-line">
						<span class="terminal-ui-prefix">$</span>
						<span>show in matrix feed ui</span>
						<span class="terminal-ui-caret" aria-hidden="true"></span>
					</span>
					<span class="terminal-ui-meta">
						click terminal to connect Bluesky, switch feeds, change speed, switch render mode, resize panels, or switch layout
					</span>
				</span>
			</button>
		{/if}
		<MatrixFeedTerminal
			{posts}
			handle={profile?.handle ?? ''}
			displayName={profile ? `${profile.displayName || profile.handle} :: ${selectedFeed?.label ?? 'Following'}` : null}
			loading={loading || loadingFeeds || restoringSession}
			paused={previewOpen}
			frameDelayMs={settings.frameDelayMs}
			preferredColumnCount={settings.panelCount}
			layoutMode={settings.layoutMode}
			idlePrimaryText={profile ? 'Select a feed to start this panel.' : 'Connect Bluesky to start this panel.'}
			idleSecondaryText={profile
				? 'Pinned and saved feeds appear in the selector above.'
				: 'Guest mode keeps the matrix shell visible until you explicitly connect.'}
			loadingText={profile ? `Loading ${selectedFeed?.label ?? 'feed'}...` : 'Restoring Bluesky session...'}
			renderStyle={settings.renderStyle}
			terminalFontId={settings.terminalFontId}
			onpreview={(post) => (previewPost = post)}
		/>
	</section>

	{#if previewPost}
		<MatrixPostPreviewOverlay post={previewPost} onclose={() => (previewPost = null)} />
	{/if}
</main>

<style>
	.matrix-shell {
		--matrix-panel: rgba(6, 18, 10, 0.84);
		--matrix-line: rgba(118, 255, 127, 0.18);
		--matrix-green-strong: #c8ffad;
		--matrix-green-dim: #58a364;
		--matrix-ink: #e8ffe0;
		--matrix-ui-font: var(--font-matrix-ui);
		position: relative;
		height: 100svh;
		min-height: 100svh;
		padding: 8px;
		background:
			radial-gradient(circle at top, rgba(62, 255, 90, 0.12), transparent 30%),
			linear-gradient(180deg, #06110a 0%, #020503 48%, #010201 100%);
		color: var(--matrix-ink);
		overflow: hidden;
	}

	.matrix-shell::before {
		content: '';
		position: absolute;
		inset: 0;
		background:
			linear-gradient(90deg, rgba(79, 255, 116, 0.04), transparent 24%, transparent 76%, rgba(79, 255, 116, 0.04)),
			repeating-linear-gradient(
				180deg,
				rgba(125, 255, 154, 0.022) 0,
				rgba(125, 255, 154, 0.022) 1px,
				transparent 1px,
				transparent 5px
			);
		pointer-events: none;
	}

	.matrix-chrome {
		position: relative;
		width: min(1060px, 100%);
		max-height: calc(100svh - 16px);
		display: grid;
		gap: 8px;
		padding: 40px 12px 12px;
		border: 1px solid var(--matrix-line);
		border-radius: 16px;
		background: var(--matrix-panel);
		backdrop-filter: blur(16px);
		box-shadow:
			inset 0 0 0 1px rgba(125, 255, 154, 0.05),
			0 18px 48px rgba(0, 0, 0, 0.24);
		overflow: auto;
		overscroll-behavior: contain;
		scrollbar-width: thin;
	}

	.matrix-overlay {
		position: absolute;
		inset: 0;
		z-index: 4;
		display: flex;
		align-items: flex-start;
		justify-content: center;
		padding: 8px;
		pointer-events: none;
	}

	.matrix-overlay > * {
		pointer-events: auto;
	}

	.matrix-overlay-dismiss {
		position: absolute;
		top: 16px;
		right: 16px;
		z-index: 5;
	}

	.toolbar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 10px;
		flex-wrap: wrap;
		position: sticky;
		top: 0;
		z-index: 1;
		padding-bottom: 6px;
		background: linear-gradient(180deg, rgba(6, 18, 10, 0.96), rgba(6, 18, 10, 0.82));
		backdrop-filter: blur(12px);
	}

	.toolbar-left,
	.toolbar-right {
		display: flex;
		align-items: center;
		gap: 8px;
		flex-wrap: wrap;
		min-width: 0;
	}

	.title-stack {
		display: grid;
		gap: 1px;
		min-width: 0;
	}

	.toolbar-title,
	.toolbar-subtitle,
	.tiny-pill,
	.profile-link,
	.collapse-btn,
	.control-label,
	.control-value,
	.feed-summary,
	.session-copy,
	.session-handle,
	.feed-select,
	.session-button {
		font-family: var(--matrix-ui-font);
	}

	.toolbar-title {
		font-size: 0.82rem;
		letter-spacing: 0.16em;
		text-transform: uppercase;
		color: var(--matrix-green-strong);
	}

	.toolbar-subtitle {
		font-size: 0.66rem;
		color: rgba(232, 255, 224, 0.7);
	}

	.tiny-pill,
	.profile-link,
	.collapse-btn,
	.matrix-overlay-dismiss,
	.status-pill,
	.session-button {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-height: 30px;
		padding: 0 10px;
		border-radius: 999px;
		border: 1px solid rgba(125, 255, 154, 0.18);
		background: rgba(3, 10, 6, 0.76);
		color: var(--matrix-green-strong);
		font-size: 0.68rem;
		letter-spacing: 0.08em;
		text-transform: uppercase;
	}

	.profile-link:hover {
		text-decoration: none;
		border-color: rgba(125, 255, 154, 0.34);
	}

	.collapse-btn,
	.session-button {
		cursor: pointer;
	}

	.control-stack {
		display: grid;
		gap: 8px;
	}

	.control-top-row {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
	}

	.control-inner-grid {
		display: grid;
		grid-template-columns: minmax(0, 1fr) minmax(0, 2fr);
		gap: 8px;
		align-items: start;
	}

	.control-card {
		min-width: 0;
		position: relative;
		display: grid;
		gap: 6px;
		padding: 10px;
		border-radius: 14px;
		border: 1px solid rgba(125, 255, 154, 0.16);
		background: rgba(2, 8, 4, 0.72);
	}

	.control-label {
		font-size: 0.64rem;
		letter-spacing: 0.16em;
		text-transform: uppercase;
		color: var(--matrix-green-dim);
	}

	.control-copy {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		flex-wrap: wrap;
	}

	.control-copy > * {
		min-width: 0;
	}

	.control-value,
	.feed-summary {
		font-size: 0.72rem;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--matrix-green-strong);
		min-width: 0;
		overflow-wrap: anywhere;
	}

	.session-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		flex-wrap: wrap;
	}

	.session-identity {
		display: flex;
		align-items: center;
		gap: 10px;
		min-width: 0;
	}

	.session-identity img,
	.avatar-placeholder {
		width: 38px;
		height: 38px;
		border-radius: 50%;
		flex: 0 0 auto;
	}

	.avatar-placeholder {
		background: radial-gradient(circle at 30% 30%, rgba(157, 255, 134, 0.26), rgba(157, 255, 134, 0.05));
		border: 1px solid rgba(125, 255, 154, 0.18);
	}

	.session-copy {
		display: grid;
		gap: 2px;
		min-width: 0;
	}

	.session-copy span:first-child {
		font-size: 0.82rem;
		color: var(--matrix-green-strong);
	}

	.session-handle {
		font-size: 0.68rem;
		color: var(--matrix-green-dim);
	}

	.session-actions {
		display: flex;
		align-items: center;
		gap: 8px;
		flex-wrap: wrap;
	}

	.session-button {
		min-height: 36px;
		padding: 0 12px;
		background: rgba(1, 7, 3, 0.9);
	}

	.session-button:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.session-button.ghost {
		background: rgba(3, 10, 6, 0.62);
	}

	.guest-copy {
		display: grid;
		gap: 10px;
		font-family: var(--matrix-ui-font);
		font-size: 0.72rem;
		letter-spacing: 0.06em;
		color: rgba(232, 255, 224, 0.78);
	}

	.feed-select {
		width: 100%;
		min-height: 40px;
		padding: 0 12px;
		font-size: 0.82rem;
		outline: none;
		border-radius: 12px;
		border: 1px solid rgba(125, 255, 154, 0.2);
		background: rgba(1, 7, 3, 0.9);
		color: var(--matrix-green-strong);
	}

	.feed-select:disabled {
		opacity: 0.6;
		cursor: not-allowed;
	}

	.feed-summary {
		display: grid;
		gap: 4px;
		align-content: start;
		min-height: 42px;
		text-transform: none;
		letter-spacing: 0.04em;
	}

	.status-row {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}

	.error-pill {
		color: #ffb8b8;
		border-color: rgba(255, 130, 130, 0.26);
	}

	.terminal-stage {
		position: relative;
		z-index: 1;
		height: 100%;
		min-height: 0;
	}

	.terminal-ui-trigger {
		position: absolute;
		top: 16px;
		left: 16px;
		z-index: 3;
		display: inline-flex;
		align-items: flex-start;
		justify-content: flex-start;
		padding: 0;
		border: 0;
		background: transparent;
		cursor: pointer;
		text-align: left;
	}

	.terminal-ui-shell {
		display: grid;
		gap: 4px;
		padding: 10px 12px;
		border: 1px solid rgba(125, 255, 154, 0.2);
		border-radius: 12px;
		background: rgba(2, 8, 4, 0.74);
		box-shadow:
			inset 0 0 0 1px rgba(125, 255, 154, 0.04),
			0 12px 32px rgba(0, 0, 0, 0.22);
		font-family: var(--matrix-ui-font);
		color: var(--matrix-green-strong);
	}

	.terminal-ui-line {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		font-size: 0.76rem;
		letter-spacing: 0.1em;
		text-transform: uppercase;
	}

	.terminal-ui-prefix {
		color: rgba(102, 255, 130, 0.9);
	}

	.terminal-ui-meta {
		font-size: 0.64rem;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: rgba(200, 255, 173, 0.7);
	}

	.terminal-ui-caret {
		width: 8px;
		height: 1em;
		background: currentColor;
		box-shadow: 0 0 12px rgba(125, 255, 154, 0.3);
		animation: terminal-caret-blink 1s steps(1) infinite;
	}

	@keyframes terminal-caret-blink {
		0%,
		49% {
			opacity: 1;
		}

		50%,
		100% {
			opacity: 0;
		}
	}

	:global(.matrix-shell .route-nav-link) {
		background: rgba(2, 8, 4, 0.86);
		border-color: rgba(125, 255, 154, 0.18);
		box-shadow: none;
		color: var(--matrix-green-strong);
		font-family: var(--matrix-ui-font);
	}

	:global(.matrix-shell .route-nav-link:hover) {
		background: rgba(11, 24, 14, 0.96);
		border-color: rgba(125, 255, 154, 0.36);
	}

	:global(.matrix-shell .route-nav-link.active) {
		background: rgba(18, 48, 24, 0.92);
		border-color: rgba(125, 255, 154, 0.44);
		box-shadow: 0 0 0 1px rgba(125, 255, 154, 0.16);
	}

	@media (max-width: 760px) {
		.control-inner-grid {
			grid-template-columns: 1fr;
		}

		.session-row {
			align-items: flex-start;
		}
	}
</style>
