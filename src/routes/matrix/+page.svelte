<script lang="ts">
	import { onMount } from 'svelte';
	import { browser } from '$app/environment';
	import '../../app.css';
	import RouteNav from '$lib/components/RouteNav.svelte';
	import MatrixFeedTerminal, { type MatrixTerminalPost } from '$lib/components/MatrixFeedTerminal.svelte';
	import MatrixPostPreviewOverlay from '$lib/components/MatrixPostPreviewOverlay.svelte';
	import MatrixControlGrid from '$lib/components/MatrixControlGrid.svelte';
	import { createMatrixSettings, LIVE_REFRESH_MS } from '$lib/stores/matrixSettings.svelte';
	import { mapFeedItem } from '$lib/utils/matrixFeedMapper';
	import {
		fetchAuthorFeed,
		getProfile,
		searchActorsTypeahead,
		type ActorSuggestion,
		type ProfileInfo
	} from '$lib/api/bluesky';

	let handleInput = $state('');
	let loading = $state(false);
	let error: string | null = $state(null);
	let profile: ProfileInfo | null = $state(null);
	let posts: MatrixTerminalPost[] = $state([]);
	let suggestions: ActorSuggestion[] = $state([]);
	let showSuggestions = $state(false);
	let activeSuggestionIndex = $state(-1);
	let typeaheadTimer: ReturnType<typeof setTimeout> | null = null;
	let typeaheadToken = 0;
	let isBackgroundRefreshing = $state(false);
	let lastSyncedAt = $state('');
	let feedRequestToken = 0;
	let liveRefreshEpoch = $state(0);
	let previewPost = $state<MatrixTerminalPost | null>(null);

	const settings = createMatrixSettings('matrix');

	let previewOpen = $derived(previewPost !== null);

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

	function updateHandleQuery(handle: string | null) {
		if (!browser) return;
		const url = new URL(window.location.href);
		if (handle) {
			url.searchParams.set('handle', handle);
		} else {
			url.searchParams.delete('handle');
		}
		window.history.replaceState({}, '', url.toString());
	}

	function closeSuggestions() {
		showSuggestions = false;
		activeSuggestionIndex = -1;
		suggestions = [];
	}

	async function fetchSuggestions() {
		const token = ++typeaheadToken;
		const query = handleInput.replace(/^@/, '').trim();
		if (query.length < 2 || loading) {
			closeSuggestions();
			return;
		}

		try {
			const results = await searchActorsTypeahead(query);
			if (token !== typeaheadToken) return;
			suggestions = results;
			showSuggestions = results.length > 0;
			activeSuggestionIndex = -1;
		} catch {
			if (token === typeaheadToken) closeSuggestions();
		}
	}

	function handleInputChange() {
		if (typeaheadTimer) clearTimeout(typeaheadTimer);
		typeaheadTimer = setTimeout(fetchSuggestions, 180);
	}

	function stampSyncedNow() {
		lastSyncedAt = syncFormatter.format(new Date());
	}

	function bumpLiveRefreshEpoch() {
		liveRefreshEpoch++;
	}

	async function refreshFeedForProfile(
		nextProfile: ProfileInfo,
		options: { background?: boolean; preserveInput?: boolean } = {}
	) {
		const requestToken = ++feedRequestToken;
		const background = options.background ?? false;

		if (background) {
			isBackgroundRefreshing = true;
		} else {
			loading = true;
			setError(null);
		}

		try {
			const feed = await fetchAuthorFeed(nextProfile.did);
			const mappedPosts = feed.posts
				.slice(0, 100)
				.map(mapFeedItem)
				.filter((entry): entry is MatrixTerminalPost => Boolean(entry));

			if (requestToken !== feedRequestToken) return;

			profile = nextProfile;
			posts = mappedPosts;
			if (!options.preserveInput) {
				handleInput = nextProfile.handle;
			}
			updateHandleQuery(nextProfile.handle);
			stampSyncedNow();
			if (background) setError(null);
		} catch (err: any) {
			if (requestToken !== feedRequestToken) return;

			if (background) {
				setError(err?.message || `Background refresh failed for @${nextProfile.handle}.`);
				return;
			}

			setError(err?.message || `Could not load posts for @${nextProfile.handle}.`);
			posts = [];
			profile = null;
			updateHandleQuery(nextProfile.handle);
		} finally {
			if (requestToken !== feedRequestToken) return;

			if (background) {
				isBackgroundRefreshing = false;
			} else {
				loading = false;
			}
		}
	}

	async function loadFeed(rawHandle: string) {
		const nextHandle = rawHandle.replace(/^@/, '').trim();
		if (!nextHandle) return;

		closeSuggestions();
		handleInput = nextHandle;
		bumpLiveRefreshEpoch();

		try {
			const nextProfile = await getProfile(nextHandle);
			await refreshFeedForProfile(nextProfile);
		} catch (err: any) {
			setError(err?.message || `Could not load posts for @${nextHandle}.`);
			posts = [];
			profile = null;
			updateHandleQuery(nextHandle);
			loading = false;
		}
	}

	async function selectSuggestion(actor: ActorSuggestion) {
		handleInput = actor.handle;
		await loadFeed(actor.handle);
	}

	function handleSubmit(event: Event) {
		event.preventDefault();
		if (!handleInput.trim()) return;
		void loadFeed(handleInput);
	}

	function handleKeydown(event: KeyboardEvent) {
		if (!showSuggestions || suggestions.length === 0) {
			if (event.key === 'Enter') {
				event.preventDefault();
				void loadFeed(handleInput);
			}
			return;
		}

		if (event.key === 'ArrowDown') {
			event.preventDefault();
			activeSuggestionIndex = (activeSuggestionIndex + 1) % suggestions.length;
			return;
		}

		if (event.key === 'ArrowUp') {
			event.preventDefault();
			activeSuggestionIndex =
				activeSuggestionIndex <= 0 ? suggestions.length - 1 : activeSuggestionIndex - 1;
			return;
		}

		if (event.key === 'Enter') {
			event.preventDefault();
			if (activeSuggestionIndex >= 0) {
				void selectSuggestion(suggestions[activeSuggestionIndex]);
			} else {
				void loadFeed(handleInput);
			}
			return;
		}

		if (event.key === 'Escape') {
			closeSuggestions();
		}
	}

	function handleBlur() {
		setTimeout(closeSuggestions, 140);
	}

	function toggleControls() {
		if (!settings.controlsCollapsed) {
			closeSuggestions();
		}
		settings.controlsCollapsed = !settings.controlsCollapsed;
	}

	onMount(() => {
		settings.restore();
		const url = new URL(window.location.href);
		const handle = url.searchParams.get('handle');
		if (handle) {
			handleInput = handle;
			void loadFeed(handle);
		}
	});

	$effect(() => { settings.speed; if (browser) settings.persistSpeed(); });
	$effect(() => { settings.panelCount; if (browser) settings.persistPanels(); });
	$effect(() => { settings.layoutMode; if (browser) settings.persistLayout(); });
	$effect(() => { settings.renderStyle; if (browser) settings.persistRender(); });
	$effect(() => { settings.terminalFontId; if (browser) settings.persistFont(); });
	$effect(() => { settings.liveRefreshEnabled; if (browser) settings.persistLive(); });
	$effect(() => { settings.controlsCollapsed; if (browser) settings.persistCollapsed(); });

	$effect(() => {
		if (!browser) return;
		if (!profile || !settings.liveRefreshEnabled || previewOpen) return;

		// Track epoch so manual refreshes reset the interval
		void liveRefreshEpoch;
		const currentProfile = profile;

		const interval = window.setInterval(() => {
			if (!currentProfile || loading || isBackgroundRefreshing || previewOpen) return;
			void refreshFeedForProfile(currentProfile, {
				background: true,
				preserveInput: true
			});
		}, LIVE_REFRESH_MS);

		return () => {
			window.clearInterval(interval);
		};
	});
</script>

<svelte:head>
	<title>Matrix Feed</title>
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
							<RouteNav current="matrix" compact handle={(profile?.handle ?? handleInput.trim()) || null} />
							<div class="title-stack">
								<span class="toolbar-title">Matrix Feed</span>
								<span class="toolbar-subtitle">
									{profile ? `Streaming @${profile.handle}` : 'Bluesky multi-terminal stream'}
								</span>
							</div>
						</div>

						<div class="toolbar-right">
							<span class="tiny-pill">{posts.length} posts</span>
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
							<form class="handle-form handle-form-wide" onsubmit={handleSubmit}>
								<div class="control-copy">
									<label class="handle-label" for="matrix-handle">Handle Search</label>
									<span class="control-value">
										{profile ? `Tracking @${profile.handle}` : 'Load any Bluesky author feed'}
									</span>
								</div>
							<div class="handle-input-shell">
								<input
									id="matrix-handle"
									type="text"
									bind:value={handleInput}
									oninput={handleInputChange}
									onkeydown={handleKeydown}
									onfocus={handleInputChange}
									onblur={handleBlur}
									placeholder="alice.bsky.social"
									autocomplete="off"
									spellcheck="false"
									disabled={loading}
									role="combobox"
									aria-expanded={showSuggestions}
									aria-autocomplete="list"
									aria-controls="matrix-suggestions"
									aria-activedescendant={activeSuggestionIndex >= 0 ? `matrix-suggestion-${activeSuggestionIndex}` : undefined}
								/>
								<button type="submit" disabled={loading || !handleInput.trim()}>
									{loading ? 'Syncing...' : 'Load'}
								</button>
							</div>

							{#if showSuggestions && suggestions.length > 0}
								<ul class="suggestions" id="matrix-suggestions" role="listbox">
									{#each suggestions as actor, index}
										<li
											id={`matrix-suggestion-${index}`}
											role="option"
											class:active={index === activeSuggestionIndex}
											aria-selected={index === activeSuggestionIndex}
											onmousedown={() => selectSuggestion(actor)}
											onmouseenter={() => (activeSuggestionIndex = index)}
										>
											{#if actor.avatar}
												<img src={actor.avatar} alt="" />
											{:else}
												<div class="avatar-placeholder"></div>
											{/if}
											<div class="suggestion-copy">
												<span>{actor.displayName || actor.handle}</span>
												<span class="suggestion-handle">@{actor.handle}</span>
											</div>
										</li>
									{/each}
								</ul>
							{/if}
							</form>
						</div>

						<MatrixControlGrid
							{settings}
							{loading}
							{isBackgroundRefreshing}
							profileHandle={profile?.handle ?? null}
						/>
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
						<span>show matrix ui</span>
						<span class="terminal-ui-caret" aria-hidden="true"></span>
					</span>
					<span class="terminal-ui-meta">
						click terminal to search handles, change speed, switch render mode, resize panels, or switch layout
					</span>
				</span>
			</button>
		{/if}
		<MatrixFeedTerminal
			{posts}
			handle={profile?.handle ?? handleInput.trim()}
			displayName={profile?.displayName ?? null}
			{loading}
			paused={previewOpen}
			frameDelayMs={settings.frameDelayMs}
			preferredColumnCount={settings.panelCount}
			layoutMode={settings.layoutMode}
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
	.handle-label,
	.control-value,
	.suggestions li,
	.suggestion-handle {
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
	.status-pill {
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

	.collapse-btn {
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

	.handle-form {
		min-width: 0;
		position: relative;
		display: grid;
		gap: 6px;
		padding: 10px;
		border-radius: 14px;
		border: 1px solid rgba(125, 255, 154, 0.16);
		background: rgba(2, 8, 4, 0.72);
	}

	.handle-label {
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

	.control-value {
		font-size: 0.72rem;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--matrix-green-strong);
		min-width: 0;
		overflow-wrap: anywhere;
	}

	.handle-input-shell {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		gap: 8px;
	}

	.handle-input-shell input,
	.handle-input-shell button {
		border-radius: 12px;
		border: 1px solid rgba(125, 255, 154, 0.2);
		background: rgba(1, 7, 3, 0.9);
		color: var(--matrix-green-strong);
		font-family: var(--matrix-ui-font);
	}

	.handle-input-shell input {
		padding: 11px 13px;
		font-size: 0.9rem;
		outline: none;
	}

	.handle-input-shell input:focus {
		border-color: rgba(125, 255, 154, 0.42);
		box-shadow: 0 0 0 1px rgba(125, 255, 154, 0.16);
	}

	.handle-input-shell button {
		padding: 0 12px;
		min-height: 42px;
		font-size: 0.68rem;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		cursor: pointer;
		line-height: 1.15;
		text-align: center;
		white-space: normal;
		word-break: break-word;
	}

	.handle-input-shell button:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.suggestions {
		position: absolute;
		top: calc(100% - 2px);
		left: 10px;
		right: 10px;
		list-style: none;
		border: 1px solid rgba(125, 255, 154, 0.22);
		border-radius: 14px;
		background: rgba(2, 8, 4, 0.96);
		box-shadow: 0 20px 60px rgba(0, 0, 0, 0.42);
		overflow: hidden;
		z-index: 4;
	}

	.suggestions li {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 10px 12px;
		cursor: pointer;
		font-size: 0.78rem;
		color: var(--matrix-green-strong);
		border-top: 1px solid rgba(125, 255, 154, 0.08);
	}

	.suggestions li:first-child {
		border-top: 0;
	}

	.suggestions li.active,
	.suggestions li:hover {
		background: rgba(15, 36, 18, 0.94);
	}

	.suggestions img,
	.avatar-placeholder {
		width: 34px;
		height: 34px;
		border-radius: 50%;
		flex: 0 0 auto;
	}

	.avatar-placeholder {
		background: radial-gradient(circle at 30% 30%, rgba(157, 255, 134, 0.26), rgba(157, 255, 134, 0.05));
		border: 1px solid rgba(125, 255, 154, 0.18);
	}

	.suggestion-copy {
		display: grid;
		gap: 2px;
	}

	.suggestion-handle {
		font-size: 0.68rem;
		color: var(--matrix-green-dim);
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

	@media (max-width: 640px) {
		.handle-input-shell {
			grid-template-columns: 1fr;
		}
	}
</style>
