<script lang="ts">
	import { onMount, tick } from 'svelte';
	import type { Agent } from '@atproto/api';
	import type { BrowserOAuthClient } from '@atproto/oauth-client-browser';
	import '../../app.css';
	import RouteNav from '$lib/components/RouteNav.svelte';
	import FontPicker from '$lib/components/FontPicker.svelte';
	import ErrorBanner from '$lib/components/ErrorBanner.svelte';
	import PostEmbedPreview from '$lib/components/PostEmbedPreview.svelte';
	import {
		FOLLOWING_FEED_ID,
		connectBlueskyWithPopup,
		disconnectBluesky,
		initAuthenticatedBlueskyClient,
		resolvePersonalFeeds,
		type AuthenticatedBlueskyContext,
		type PersonalFeedOption
	} from '$lib/api/blueskyAuth';
	import { fetchTownPopulation, type TownPopulationResult } from '$lib/town/feedPopulation';
	import {
		connectTownFirehose,
		type TownFirehoseController,
		type TownFirehoseStatus
	} from '$lib/town/firehose';
	import type {
		TownConversationState,
		TownGameController,
		TownNpcData,
		TownPlayerIdentity
	} from '$lib/town/types';

	const fontFamilies: Record<string, string> = {
		virgil: "'Virgil', cursive",
		caveat: "'Caveat', cursive",
		patrick: "'Patrick Hand', cursive",
		'comic-neue': "'Comic Neue', cursive",
		inter: "'Inter', sans-serif",
		system: 'system-ui, -apple-system, sans-serif'
	};

	const assetLeads = [
		{
			name: 'Kenney',
			url: 'https://kenney.nl/assets',
			note: 'Best for dropping in a cohesive CC0 town tileset after the prototype.'
		},
		{
			name: 'Liberated Pixel Cup',
			url: 'https://lpc.opengameart.org/',
			note: 'Best for classic open RPG characters, outfits, interiors, and towns.'
		},
		{
			name: 'OpenGameArt',
			url: 'https://opengameart.org/',
			note: 'Best as a selective supplement when we need extra buildings, props, or portraits.'
		},
		{
			name: 'Tiled',
			url: 'https://www.mapeditor.org/',
			note: 'Best editor for adding collision, door markers, interiors, and quest triggers.'
		}
	];

	const FEED_STORAGE_KEY_PREFIX = 'town-feed-selection';
	const MODE_STORAGE_KEY = 'town-population-mode';
	const ERROR_AUTO_CLEAR_MS = 8000;
	const PLAYER_ACCENT = '#3d405b';
	const FIREHOSE_MODE = 'firehose';
	const FEED_MODE = 'feed';

	type TownPopulationMode = typeof FIREHOSE_MODE | typeof FEED_MODE;

	let fontKey = $state('patrick');
	let fontFamily = $derived(fontFamilies[fontKey] ?? fontFamilies.patrick);
	let canvasEl: HTMLCanvasElement | undefined = $state();
	let npcLayerEl: HTMLDivElement | undefined = $state();
	let bootingTown = $state(true);
	let error = $state<string | null>(null);
	let connecting = $state(false);
	let restoringSession = $state(true);
	let loadingFeeds = $state(false);
	let populatingTown = $state(false);
	let profile = $state<AuthenticatedBlueskyContext['profile'] | null>(null);
	let authClient = $state<BrowserOAuthClient | null>(null);
	let authAgent = $state<Agent | null>(null);
	let sessionSub = $state<string | null>(null);
	let feedOptions = $state<PersonalFeedOption[]>([]);
	let selectedFeedId = $state(FOLLOWING_FEED_ID);
	let populationMode = $state<TownPopulationMode>(FIREHOSE_MODE);
	let townController = $state<TownGameController | null>(null);
	let firehoseController = $state<TownFirehoseController | null>(null);
	let firehoseStatus = $state<TownFirehoseStatus>('idle');
	let townPopulation = $state<TownNpcData[]>([]);
	let activeConversation = $state<TownConversationState | null>(null);
	let scannedPosts = $state(0);
	let uniqueAuthorCount = $state(0);
	let bubbleScrollEl: HTMLDivElement | undefined = $state();
	let populationRequestToken = 0;
	let errorClearTimer: ReturnType<typeof setTimeout> | null = null;
	let bubbleAutoScrollDelay: ReturnType<typeof setTimeout> | null = null;
	let bubbleAutoScrollTick: ReturnType<typeof setInterval> | null = null;

	let selectedFeed = $derived(
		feedOptions.find((option) => option.id === selectedFeedId) ?? null
	);
	let activeTalkLineKey = $derived.by(() => {
		if (activeConversation?.mode !== 'talk') return null;
		return `${activeConversation.npc.id}:${activeConversation.line.id}:${activeConversation.lineIndex}`;
	});
	let activeTalkLineLength = $derived.by(() =>
		activeConversation?.mode === 'talk' ? activeConversation.line.text.length : 0
	);
	let activeTalkLineUrlCount = $derived.by(() =>
		activeConversation?.mode === 'talk' ? activeConversation.line.linkedUrls.length : 0
	);
	let activeTalkLineHasEmbed = $derived.by(() =>
		activeConversation?.mode === 'talk' && activeConversation.line.embed ? 1 : 0
	);
	let sessionLabel = $derived.by(() => {
		if (profile) return `Connected as @${profile.handle}`;
		if (populationMode === FIREHOSE_MODE && firehoseStatus === 'live') return 'Firehose guest mode';
		if (connecting) return 'Connecting...';
		if (restoringSession) return 'Restoring session...';
		return 'Guest mode';
	});
	let townStatus = $derived.by(() => {
		if (bootingTown) return 'Booting town scene...';
		if (populationMode === FIREHOSE_MODE) {
			if (firehoseStatus === 'connecting') return 'Connecting to the Bluesky firehose...';
			if (firehoseStatus === 'reconnecting') return 'Reconnecting to the Bluesky firehose...';
			if (firehoseStatus === 'error') return 'The firehose is reconnecting after a live-stream hiccup.';
			if (townPopulation.length === 0) return 'Waiting for live posts from the firehose...';
			return `${townPopulation.length} live authors drifting through ${scannedPosts} streamed posts.`;
		}
		if (populatingTown) return 'Inviting feed authors into the square...';
		if (loadingFeeds) return 'Resolving your feeds...';
		if (!profile) return 'Connect Bluesky to populate the square.';
		if (townPopulation.length === 0) return 'No authors available from the current feed snapshot.';
		return `${townPopulation.length} authors wandering across ${scannedPosts} scanned posts.`;
	});

	function handleFontChange(key: string) {
		fontKey = key;
		try {
			localStorage.setItem('preferred-font', key);
		} catch {}
	}

	function clampNumber(value: number, min: number, max: number) {
		if (max < min) return (min + max) / 2;
		return Math.min(Math.max(value, min), max);
	}

	function readRequestedMode(): TownPopulationMode | null {
		const requested = new URL(window.location.href).searchParams.get('mode');
		if (requested === FIREHOSE_MODE || requested === FEED_MODE) return requested;
		return null;
	}

	function readStoredMode(): TownPopulationMode | null {
		const stored = localStorage.getItem(MODE_STORAGE_KEY);
		if (stored === FIREHOSE_MODE || stored === FEED_MODE) return stored;
		return null;
	}

	function persistPopulationMode(mode: TownPopulationMode) {
		localStorage.setItem(MODE_STORAGE_KEY, mode);
	}

	function clearBubbleAutoScroll() {
		if (bubbleAutoScrollDelay) {
			clearTimeout(bubbleAutoScrollDelay);
			bubbleAutoScrollDelay = null;
		}
		if (bubbleAutoScrollTick) {
			clearInterval(bubbleAutoScrollTick);
			bubbleAutoScrollTick = null;
		}
	}

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

	function formatAuthError(err: unknown, fallback: string): string {
		const message = String((err as { message?: string } | null | undefined)?.message ?? '');
		if (message.includes('Missing required scope')) {
			return 'Your previous Bluesky grant was missing feed permissions. Connect again to refresh it.';
		}
		return message || fallback;
	}

	function buildPlayerIdentity(
		nextProfile: AuthenticatedBlueskyContext['profile'] | null
	): TownPlayerIdentity | null {
		if (!nextProfile) return null;
		return {
			displayName: nextProfile.displayName || nextProfile.handle,
			handle: nextProfile.handle,
			avatar: nextProfile.avatar ?? null,
			colorHex: PLAYER_ACCENT
		};
	}

	function getFeedStorageKey(sub: string): string {
		return `${FEED_STORAGE_KEY_PREFIX}:${sub}`;
	}

	function readRequestedFeedId(): string | null {
		return new URL(window.location.href).searchParams.get('feed');
	}

	function readStoredFeedId(sub: string): string | null {
		return localStorage.getItem(getFeedStorageKey(sub));
	}

	function persistSelectedFeedId(sub: string, feedId: string) {
		localStorage.setItem(getFeedStorageKey(sub), feedId);
	}

	function clearStoredFeedId(sub: string | null) {
		if (!sub) return;
		localStorage.removeItem(getFeedStorageKey(sub));
	}

	function updateTownQuery(options: {
		feedId?: string | null;
		mode?: TownPopulationMode | null;
	}) {
		const url = new URL(window.location.href);
		if (options.feedId) {
			url.searchParams.set('feed', options.feedId);
		} else {
			url.searchParams.delete('feed');
		}
		if (options.mode && options.mode !== FIREHOSE_MODE) {
			url.searchParams.set('mode', options.mode);
		} else {
			url.searchParams.delete('mode');
		}
		window.history.replaceState({}, '', url.toString());
	}

	function applyPopulationSnapshot(result: TownPopulationResult) {
		townPopulation = result.npcs;
		scannedPosts = result.scannedPosts;
		uniqueAuthorCount = result.uniqueAuthors;
	}

	function clearPopulationSnapshot() {
		townPopulation = [];
		activeConversation = null;
		scannedPosts = 0;
		uniqueAuthorCount = 0;
	}

	function stopFirehoseMode() {
		firehoseController?.dispose();
		firehoseController = null;
		firehoseStatus = 'idle';
	}

	function startFirehoseMode() {
		if (firehoseController) return;

		firehoseController = connectTownFirehose({
			onSnapshot: (snapshot) => {
				townPopulation = snapshot.npcs;
				scannedPosts = snapshot.scannedPosts;
				uniqueAuthorCount = snapshot.uniqueAuthors;
			},
			onStatusChange: (status) => {
				firehoseStatus = status;
			},
			onError: (message) => {
				setError(message);
			}
		});
	}

	async function applyPopulationMode(nextMode: TownPopulationMode) {
		populationMode = nextMode;
		populationRequestToken += 1;
		try {
			persistPopulationMode(nextMode);
		} catch {}
		updateTownQuery({
			feedId: nextMode === FEED_MODE && sessionSub ? selectedFeedId : null,
			mode: nextMode
		});

		if (nextMode === FIREHOSE_MODE) {
			setError(null);
			clearPopulationSnapshot();
			startFirehoseMode();
			return;
		}

		stopFirehoseMode();
		if (selectedFeed && authAgent && sessionSub) {
			await populateTown(selectedFeed);
			return;
		}

		clearPopulationSnapshot();
	}

	function resetGuestState() {
		clearStoredFeedId(sessionSub);
		authAgent = null;
		authClient = null;
		profile = null;
		sessionSub = null;
		feedOptions = [];
		selectedFeedId = FOLLOWING_FEED_ID;
		if (populationMode !== FIREHOSE_MODE) {
			clearPopulationSnapshot();
		}
		updateTownQuery({ feedId: null, mode: populationMode });
	}

	function resolveInitialFeedId(
		options: PersonalFeedOption[],
		preferredFeedId: string | null
	): string {
		if (preferredFeedId && options.some((option) => option.id === preferredFeedId)) {
			return preferredFeedId;
		}

		const firstPinnedCustomFeed = options.find(
			(option) => option.kind === 'feed' && option.pinned
		);
		return firstPinnedCustomFeed?.id ?? FOLLOWING_FEED_ID;
	}

	async function populateTown(feed: PersonalFeedOption) {
		if (!authAgent || !sessionSub || populationMode !== FEED_MODE) return;

		const requestToken = ++populationRequestToken;
		populatingTown = true;
		setError(null);

		try {
			const result: TownPopulationResult = await fetchTownPopulation(authAgent, feed);
			if (requestToken !== populationRequestToken || populationMode !== FEED_MODE) return;

			applyPopulationSnapshot(result);
			selectedFeedId = feed.id;
			persistSelectedFeedId(sessionSub, feed.id);
			updateTownQuery({ feedId: feed.id, mode: populationMode });
		} catch (err: any) {
			if (requestToken !== populationRequestToken) return;
			setError(err?.message || `Could not populate the square from ${feed.label}.`);
			clearPopulationSnapshot();
		} finally {
			if (requestToken === populationRequestToken) {
				populatingTown = false;
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
			if (nextFeed && populationMode === FEED_MODE) {
				await populateTown(nextFeed);
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
			if (message.includes('Redirecting to loopback IP')) return;
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

	async function handleRefreshTown() {
		if (populationMode !== FEED_MODE || !selectedFeed) return;
		await populateTown(selectedFeed);
	}

	async function handleFeedChange(event: Event) {
		const nextId = (event.currentTarget as HTMLSelectElement).value;
		const nextFeed = feedOptions.find((option) => option.id === nextId);
		if (!nextFeed) return;
		await populateTown(nextFeed);
	}

	async function handleModeChange(event: Event) {
		const nextMode = (event.currentTarget as HTMLSelectElement).value;
		if (nextMode !== FIREHOSE_MODE && nextMode !== FEED_MODE) return;
		await applyPopulationMode(nextMode);
	}

	function handleSessionDeleted() {
		setError('Your Bluesky session expired. Connect again when you want your feed authors back.');
		resetGuestState();
	}

	function addAuthClientListener(client: BrowserOAuthClient, handler: EventListener) {
		(client as unknown as EventTarget).addEventListener('deleted', handler);
	}

	function removeAuthClientListener(client: BrowserOAuthClient | null, handler: EventListener) {
		(client as unknown as EventTarget | null)?.removeEventListener('deleted', handler);
	}

	onMount(() => {
		let cancelled = false;

		try {
			const saved = localStorage.getItem('preferred-font');
			if (saved && saved in fontFamilies) fontKey = saved;
		} catch {}
		try {
			const requestedMode = readRequestedMode();
			const storedMode = readStoredMode();
			populationMode = requestedMode ?? storedMode ?? FIREHOSE_MODE;
		} catch {
			populationMode = FIREHOSE_MODE;
		}

		void (async () => {
			try {
				await tick();
				if (!canvasEl) throw new Error('Could not find the town canvas.');
				const { mountTownGame } = await import('$lib/town/townGame');
				const controller = await mountTownGame(canvasEl, {
					onConversationChange: (state) => {
						activeConversation = state;
					},
					npcLayer: npcLayerEl,
					playerIdentity: buildPlayerIdentity(profile)
				});
				if (cancelled) {
					controller.dispose();
					return;
				}
				townController = controller;
			} catch (cause: unknown) {
				setError(
					cause instanceof Error ? cause.message : 'Failed to boot the town prototype.'
				);
			} finally {
				if (!cancelled) bootingTown = false;
			}
		})();

		if (populationMode === FIREHOSE_MODE) {
			startFirehoseMode();
		}

		void restoreSession();

		return () => {
			cancelled = true;
			removeAuthClientListener(authClient, handleSessionDeleted as EventListener);
			townController?.dispose();
			stopFirehoseMode();
			clearBubbleAutoScroll();
			if (errorClearTimer) clearTimeout(errorClearTimer);
		};
	});

	$effect(() => {
		if (!authClient) return;
		addAuthClientListener(authClient, handleSessionDeleted as EventListener);

		return () => {
			removeAuthClientListener(authClient, handleSessionDeleted as EventListener);
		};
	});

	$effect(() => {
		if (!townController) return;
		void townController.setPopulation(townPopulation);
	});

	$effect(() => {
		if (!townController) return;
		townController.setPlayerIdentity(buildPlayerIdentity(profile));
	});

	$effect(() => {
		const lineKey = activeTalkLineKey;
		const textLength = activeTalkLineLength;
		const urlCount = activeTalkLineUrlCount;
		const hasEmbed = activeTalkLineHasEmbed;

		clearBubbleAutoScroll();
		if (!lineKey) return;

		let cancelled = false;

		void (async () => {
			await tick();
			if (cancelled || !bubbleScrollEl) return;

			const scroller = bubbleScrollEl;
			scroller.scrollTop = 0;

			const overflow = scroller.scrollHeight - scroller.clientHeight;
			if (overflow <= 8) return;

			const desiredDurationMs = clampNumber(
				2800 + textLength * 14 + urlCount * 520 + hasEmbed * 1400,
				3200,
				11000
			);
			const tickMs = 32;
			const pixelsPerTick = Math.max(0.9, overflow / (desiredDurationMs / tickMs));

			bubbleAutoScrollDelay = setTimeout(() => {
				bubbleAutoScrollDelay = null;
				if (cancelled || !bubbleScrollEl) return;

				bubbleAutoScrollTick = setInterval(() => {
					if (cancelled || !bubbleScrollEl) {
						clearBubbleAutoScroll();
						return;
					}

					const maxScrollTop = bubbleScrollEl.scrollHeight - bubbleScrollEl.clientHeight;
					bubbleScrollEl.scrollTop = Math.min(
						maxScrollTop,
						bubbleScrollEl.scrollTop + pixelsPerTick
					);

					if (bubbleScrollEl.scrollTop >= maxScrollTop - 1) {
						clearBubbleAutoScroll();
					}
				}, tickMs);
			}, 650);
		})();

		return () => {
			cancelled = true;
			clearBubbleAutoScroll();
		};
	});
</script>

<svelte:head>
	<title>Town Square</title>
</svelte:head>

<main style="font-family: {fontFamily}">
	<header class="town-header">
		<RouteNav current="town" align="center" />
		<h1>Town Square</h1>
		<p class="subtitle">Stream the Bluesky firehose straight into an infinite procedural townscape, or switch to your own feed snapshot when you want a more personal crowd. Nearby avatars open their posts automatically as you walk.</p>
		<FontPicker value={fontKey} onchange={handleFontChange} />
	</header>

	<div class="town-layout">
		<section class="town-stage-card wobbly-border">
			<div class="town-stage-frame">
				<canvas bind:this={canvasEl} class="town-canvas" aria-label="Top-down town square"></canvas>
				<div bind:this={npcLayerEl} class="npc-marker-layer" aria-hidden="true"></div>

				{#if activeConversation}
					<div
						class="speech-bubble"
						class:prompt={activeConversation.mode === 'prompt'}
						class:below={activeConversation.placement === 'below'}
						style={`left:${activeConversation.screenX}px; top:${activeConversation.screenY}px;`}
					>
						<div class="bubble-header">
							{#if activeConversation.npc.avatar}
								<img src={activeConversation.npc.avatar} alt="" class="bubble-avatar" />
							{:else}
								<div
									class="bubble-avatar bubble-avatar-fallback"
									style={`background:${activeConversation.npc.colorHex};`}
								></div>
							{/if}
							<div class="bubble-copy">
								<strong>{activeConversation.npc.displayName}</strong>
								<span>@{activeConversation.npc.handle}</span>
							</div>
						</div>

						{#if activeConversation.mode === 'talk'}
							<div class="bubble-body">
								<div class="bubble-scroll" bind:this={bubbleScrollEl}>
									<p class="bubble-line">{activeConversation.line.text}</p>
									{#if activeConversation.line.embed || activeConversation.line.linkedUrls.length > 0}
										<PostEmbedPreview
											compact
											post={{
												uri: activeConversation.line.uri,
												text: activeConversation.line.text,
												linkedUrls: activeConversation.line.linkedUrls,
												embed: activeConversation.line.embed
											}}
										/>
									{/if}
								</div>
								<div class="bubble-meta">
									<span>
										Line {activeConversation.lineIndex + 1} / {activeConversation.lineCount}
										:: {activeConversation.line.createdAtLabel}
									</span>
									{#if activeConversation.line.permalink}
										<a href={activeConversation.line.permalink} target="_blank" rel="noreferrer">
											Open post
										</a>
									{/if}
								</div>
							</div>
						{:else}
							<p class="bubble-line">Press `Space` or `Enter` to talk.</p>
						{/if}

						<div class="bubble-hint">{activeConversation.hint}</div>
					</div>
				{/if}

				{#if bootingTown}
					<div class="town-overlay">
						<strong>Booting town...</strong>
						<span>Loading the local Tiled map and Excalibur scene.</span>
					</div>
				{/if}
			</div>

				<div class="town-meta">
					<p><strong>Controls:</strong> `WASD` or arrow keys to move, hold `Shift` to sprint, walk up to an author to open their posts automatically, press `Space` to skip ahead, and keep heading outward into the generated landscape.</p>
					<p>{townStatus}</p>
				</div>
			</section>

		<aside class="town-sidebar">
			<section class="info-card wobbly-border-light">
				<h2>Connection</h2>
				<p class="control-label">{sessionLabel}</p>

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
								onclick={handleRefreshTown}
								disabled={
									populationMode !== FEED_MODE ||
									populatingTown ||
									loadingFeeds ||
									bootingTown ||
									!selectedFeed
								}
							>
								{populationMode === FIREHOSE_MODE
									? 'Feed mode only'
									: populatingTown
										? 'Refreshing...'
										: 'Refresh town'}
							</button>
							<button type="button" class="session-button ghost" onclick={handleDisconnect}>
								Disconnect
							</button>
						</div>
					</div>
				{:else}
					<div class="guest-copy">
						<span>
							{populationMode === FIREHOSE_MODE
								? 'Firehose mode works in guest mode. Connect if you want your own avatar and a quick switch back to personal feeds.'
								: 'Guest mode keeps the town open. Connect when you want the square populated from your own feed.'}
						</span>
						<button
							type="button"
							class="session-button"
							onclick={handleConnect}
							disabled={connecting || restoringSession}
						>
							{connecting ? 'Opening Bluesky...' : 'Connect Bluesky'}
						</button>
					</div>
				{/if}
			</section>

			<section class="info-card wobbly-border-light">
				<h2>Population Source</h2>
				<select
					class="feed-select"
					bind:value={populationMode}
					onchange={handleModeChange}
					aria-label="Choose a town population mode"
				>
					<option value={FIREHOSE_MODE}>Firehose live stream</option>
					<option value={FEED_MODE}>Personal feed snapshot</option>
				</select>

				<p class="feed-description">
					{#if populationMode === FIREHOSE_MODE}
						Live public posts stream in from Jetstream and become town residents as they arrive.
					{:else}
						Choose the authenticated feed whose authors should appear in the square.
					{/if}
				</p>

				{#if populationMode === FEED_MODE}
				<select
					class="feed-select"
					bind:value={selectedFeedId}
					onchange={handleFeedChange}
					disabled={!profile || loadingFeeds || connecting || restoringSession || populatingTown}
					aria-label="Choose a Bluesky feed"
				>
					<option value={FOLLOWING_FEED_ID} disabled={!profile && feedOptions.length === 0}>
						{profile ? 'Following' : 'Connect Bluesky first'}
					</option>
					{#each feedOptions.filter((option) => option.id !== FOLLOWING_FEED_ID) as option}
						<option value={option.id}>
							{option.pinned ? 'Pinned :: ' : ''}{option.label}
						</option>
					{/each}
				</select>

				<p class="feed-description">
					{#if selectedFeed}
						{selectedFeed.description}
					{:else}
						Choose the authenticated feed whose authors should appear in the square.
					{/if}
				</p>
				{/if}

				<div class="town-stats">
					<div>
						<strong>{townPopulation.length}</strong>
						<span>spawned</span>
					</div>
					<div>
						<strong>{uniqueAuthorCount}</strong>
						<span>authors seen</span>
					</div>
					<div>
						<strong>{scannedPosts}</strong>
						<span>posts scanned</span>
					</div>
				</div>
			</section>

			<section class="info-card wobbly-border-light">
				<h2>Asset Leads</h2>
				<ul class="asset-list">
					{#each assetLeads as asset}
						<li>
							<a href={asset.url} target="_blank" rel="noreferrer">{asset.name}</a>
							<span>{asset.note}</span>
						</li>
					{/each}
				</ul>
			</section>

			<section class="info-card wobbly-border-light">
				<h2>Next Up</h2>
				<ul class="asset-list">
					<li><span>Add collision and warp markers in Tiled so doors and water become meaningful spaces.</span></li>
					<li><span>Swap the placeholder town atlas for Kenney or LPC environment art.</span></li>
					<li><span>Turn chat bubbles into quest prompts, profile cards, or thread previews.</span></li>
				</ul>
			</section>
		</aside>
	</div>

	{#if error}
		<div class="town-error">
			<ErrorBanner message={error} />
		</div>
	{/if}
</main>

<style>
	main {
		max-width: 1260px;
		margin: 0 auto;
		padding: 28px 20px 44px;
	}

	.town-header {
		display: grid;
		gap: 10px;
		justify-items: center;
		margin-bottom: 22px;
		text-align: center;
	}

	h1 {
		margin: 6px 0 0;
		font-size: clamp(2.2rem, 5vw, 3.4rem);
		line-height: 0.95;
		color: var(--text-ink);
	}

	.subtitle {
		max-width: 780px;
		margin: 0;
		color: var(--muted);
		font-size: 1rem;
	}

	.town-layout {
		display: grid;
		grid-template-columns: minmax(0, 1.45fr) minmax(290px, 0.8fr);
		gap: 18px;
		align-items: start;
	}

	.town-stage-card {
		padding: 18px;
		background:
			linear-gradient(145deg, rgba(255, 252, 244, 0.96), rgba(247, 239, 225, 0.92)),
			radial-gradient(circle at top left, rgba(224, 122, 95, 0.12), transparent 42%);
		border-radius: 30px;
		box-shadow: 0 24px 56px rgba(49, 58, 76, 0.14);
	}

	.town-stage-frame {
		position: relative;
		overflow: hidden;
		border-radius: 22px;
		background:
			linear-gradient(180deg, rgba(56, 78, 109, 0.08), rgba(24, 29, 35, 0.1)),
			repeating-linear-gradient(
				135deg,
				rgba(255, 255, 255, 0.06),
				rgba(255, 255, 255, 0.06) 8px,
				transparent 8px,
				transparent 16px
			);
		aspect-ratio: 4 / 3;
		min-height: 340px;
		border: 1px solid rgba(61, 64, 91, 0.15);
	}

		.town-canvas {
			display: block;
			width: 100%;
			height: 100%;
			image-rendering: pixelated;
		}

		.npc-marker-layer {
			position: absolute;
			inset: 0;
			pointer-events: none;
			z-index: 2;
		}

		:global(.town-npc-marker) {
			position: absolute;
			z-index: 1;
			transform: translate(-50%, -50%);
			filter: drop-shadow(0 4px 6px rgba(30, 38, 47, 0.18));
			will-change: left, top, width, height;
			max-width: 42px;
			max-height: 42px;
		}

		:global(.town-player-marker) {
			z-index: 3;
			max-width: 48px;
			max-height: 48px;
			filter:
				drop-shadow(0 6px 8px rgba(30, 38, 47, 0.25))
				drop-shadow(0 0 6px rgba(255, 215, 0, 0.18));
		}

		:global(.town-npc-marker__frame) {
			box-sizing: border-box;
			width: 100%;
			height: 100%;
			padding: 1.5px;
			border-radius: 10px;
			background: rgba(250, 245, 232, 0.98);
			border: 1.5px solid rgba(31, 41, 55, 0.85);
			overflow: hidden;
			box-shadow: 0 0 0 1.5px rgba(255, 255, 255, 0.4) inset;
		}

		:global(.town-player-marker .town-npc-marker__frame) {
			background: rgba(255, 248, 224, 0.98);
			border-color: rgba(173, 130, 0, 0.9);
			box-shadow:
				0 0 0 1.5px rgba(255, 255, 255, 0.45) inset,
				0 0 0 2.5px rgba(236, 201, 75, 0.2);
		}

		:global(.town-npc-marker__image),
		:global(.town-npc-marker__fallback) {
			display: block;
			width: 100%;
			height: 100%;
			border-radius: 7px;
		}

		:global(.town-npc-marker__image) {
			object-fit: cover;
			background: rgba(61, 64, 91, 0.12);
		}

		:global(.town-npc-marker__fallback) {
			box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.15);
		}

		:global(.town-npc-marker__badge) {
			position: absolute;
			left: 50%;
			bottom: calc(100% + 4px);
			transform: translateX(-50%);
			padding: 2px 6px;
			border-radius: 999px;
			background: rgba(255, 248, 224, 0.96);
			border: 1px solid rgba(173, 130, 0, 0.6);
			box-shadow: 0 4px 10px rgba(22, 28, 34, 0.12);
			color: var(--text-ink);
			font-size: 0.66rem;
			font-weight: 700;
			line-height: 1;
			white-space: nowrap;
		}

		:global(.town-npc-marker.active) {
			filter:
				drop-shadow(0 4px 6px rgba(30, 38, 47, 0.18))
				drop-shadow(0 0 5px color-mix(in srgb, var(--town-npc-accent) 60%, white));
		}

		.town-overlay {
			position: absolute;
			inset: 0;
			display: grid;
			place-content: center;
			gap: 6px;
			padding: 20px;
			background: rgba(245, 239, 228, 0.76);
			backdrop-filter: blur(6px);
			text-align: center;
			color: var(--text-ink);
		}

		.town-overlay span {
			color: var(--muted);
			font-size: 0.95rem;
		}

	.speech-bubble {
		position: absolute;
		display: flex;
		flex-direction: column;
		gap: 6px;
		width: min(300px, calc(100% - 20px));
		max-height: min(280px, 55%);
		padding: 10px 12px;
		border-radius: 14px;
		background: rgba(255, 252, 247, 0.97);
		border: 1px solid rgba(61, 64, 91, 0.16);
		box-shadow:
			0 12px 28px rgba(22, 28, 34, 0.16),
			0 2px 6px rgba(22, 28, 34, 0.08);
		transform: translate(-50%, calc(-100% - 16px));
		color: var(--text-ink);
		z-index: 4;
		overflow: hidden;
	}

	.speech-bubble.prompt {
		width: min(200px, calc(100% - 20px));
		max-height: none;
	}

	.speech-bubble.below {
		transform: translate(-50%, 16px);
	}

	.speech-bubble::after {
		content: '';
		position: absolute;
		left: 50%;
		bottom: -7px;
		width: 12px;
		height: 12px;
		background: rgba(255, 252, 247, 0.97);
		border-right: 1px solid rgba(61, 64, 91, 0.16);
		border-bottom: 1px solid rgba(61, 64, 91, 0.16);
		transform: translateX(-50%) rotate(45deg);
	}

	.speech-bubble.below::after {
		top: -7px;
		bottom: auto;
		border-top: 1px solid rgba(61, 64, 91, 0.16);
		border-left: 1px solid rgba(61, 64, 91, 0.16);
		border-right: none;
		border-bottom: none;
	}

	.bubble-header {
		display: flex;
		gap: 8px;
		align-items: center;
	}

	.bubble-avatar {
		width: 28px;
		height: 28px;
		border-radius: 8px;
		object-fit: cover;
		flex: 0 0 auto;
	}

	.bubble-avatar-fallback {
		display: block;
	}

	.bubble-copy {
		display: grid;
		gap: 2px;
	}

	.bubble-copy strong {
		font-size: 0.88rem;
	}

	.bubble-copy span {
		font-size: 0.76rem;
		color: var(--muted);
	}

	.bubble-body {
		display: flex;
		min-height: 0;
		flex: 1 1 auto;
		flex-direction: column;
		gap: 6px;
	}

	.bubble-scroll {
		flex: 1 1 auto;
		min-height: 0;
		overflow-y: auto;
		overflow-x: hidden;
		padding-right: 4px;
		overscroll-behavior: contain;
		touch-action: pan-y;
		scrollbar-gutter: stable;
	}

	.bubble-line {
		margin: 0;
		font-size: 0.88rem;
		line-height: 1.4;
		white-space: pre-wrap;
		word-break: break-word;
	}

	:global(.speech-bubble .post-embed-preview) {
		margin-top: 10px;
		min-width: 0;
	}

	:global(.speech-bubble .embed-image) {
		width: 88px;
		max-height: 88px;
	}

	:global(.speech-bubble .embed-link) {
		background: rgba(255, 255, 255, 0.82);
	}

	.bubble-meta {
		display: flex;
		justify-content: space-between;
		flex-wrap: wrap;
		gap: 12px;
		align-items: center;
		font-size: 0.78rem;
		color: var(--muted);
	}

	.bubble-meta a {
		color: var(--accent);
		text-decoration: none;
		white-space: nowrap;
	}

	.bubble-meta a:hover {
		text-decoration: underline;
	}

	.bubble-hint {
		margin-top: 4px;
		font-size: 0.72rem;
		color: var(--muted);
		line-height: 1.35;
	}

	.town-meta {
		display: grid;
		gap: 10px;
		margin-top: 14px;
		color: var(--text-ink);
	}

	.town-meta p {
		margin: 0;
		font-size: 0.98rem;
		line-height: 1.5;
	}

	.town-sidebar {
		display: grid;
		gap: 14px;
	}

	.info-card {
		display: grid;
		gap: 10px;
		padding: 16px 18px;
		border-radius: 22px;
		background: rgba(255, 252, 245, 0.92);
	}

	.info-card h2 {
		margin: 0;
		font-size: 1.05rem;
		color: var(--text-ink);
	}

	.control-label,
	.feed-description {
		margin: 0;
		line-height: 1.5;
		color: var(--text-ink);
	}

	.session-row {
		display: grid;
		gap: 12px;
	}

	.session-identity {
		display: flex;
		align-items: center;
		gap: 12px;
	}

	.session-identity img,
	.avatar-placeholder {
		width: 46px;
		height: 46px;
		border-radius: 14px;
		object-fit: cover;
		background: rgba(61, 64, 91, 0.12);
	}

	.session-copy {
		display: grid;
		gap: 2px;
	}

	.session-handle {
		color: var(--muted);
		font-size: 0.82rem;
	}

	.session-actions,
	.guest-copy {
		display: grid;
		gap: 10px;
	}

	.session-button,
	.feed-select {
		font: inherit;
	}

	.session-button {
		border: 1px solid rgba(61, 64, 91, 0.16);
		border-radius: 999px;
		padding: 10px 14px;
		background: color-mix(in srgb, var(--accent) 88%, white);
		color: white;
		cursor: pointer;
		transition:
			transform 0.16s ease,
			opacity 0.16s ease,
			box-shadow 0.16s ease;
		box-shadow: 0 10px 22px rgba(26, 35, 44, 0.12);
	}

	.session-button:hover:not(:disabled) {
		transform: translateY(-1px);
	}

	.session-button:disabled {
		cursor: not-allowed;
		opacity: 0.58;
	}

	.session-button.ghost {
		background: rgba(255, 252, 245, 0.92);
		color: var(--text-ink);
	}

	.feed-select {
		width: 100%;
		padding: 10px 12px;
		border-radius: 14px;
		border: 1px solid rgba(61, 64, 91, 0.15);
		background: rgba(255, 255, 255, 0.94);
		color: var(--text-ink);
	}

	.town-stats {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 8px;
	}

	.town-stats div {
		display: grid;
		justify-items: start;
		gap: 2px;
		padding: 10px 12px;
		border-radius: 14px;
		background: rgba(255, 255, 255, 0.72);
	}

	.town-stats strong {
		font-size: 1.12rem;
		color: var(--text-ink);
	}

	.town-stats span {
		font-size: 0.78rem;
		color: var(--muted);
	}

	.asset-list {
		display: grid;
		gap: 12px;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.asset-list li {
		display: grid;
		gap: 3px;
	}

	.asset-list a {
		font-weight: 700;
		color: var(--accent);
		text-decoration: none;
	}

	.asset-list a:hover {
		text-decoration: underline;
	}

	.asset-list span {
		color: var(--muted);
		line-height: 1.45;
	}

	.town-error {
		margin-top: 18px;
	}

	@media (max-width: 980px) {
		.town-layout {
			grid-template-columns: 1fr;
		}
	}

	@media (max-width: 640px) {
		main {
			padding-inline: 14px;
		}

		.town-stage-card {
			padding: 14px;
		}

		.town-stage-frame {
			min-height: 260px;
		}

		.speech-bubble {
			width: min(240px, calc(100% - 16px));
			max-height: min(220px, 50%);
			padding: 8px 10px;
		}
	}
</style>
