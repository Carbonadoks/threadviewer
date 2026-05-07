<script lang="ts">
	import { browser } from '$app/environment';
	import { onMount } from 'svelte';
	import type { Agent, ComAtprotoRepoApplyWrites } from '@atproto/api';
	import type { BrowserOAuthClient } from '@atproto/oauth-client-browser';
	import '../../app.css';
	import ErrorBanner from '$lib/components/ErrorBanner.svelte';
	import LoadingSpinner from '$lib/components/LoadingSpinner.svelte';
	import RouteNav from '$lib/components/RouteNav.svelte';
	import SearchBar from '$lib/components/SearchBar.svelte';
	import {
		getFollowsPage,
		getProfile,
		type FollowProfileInfo,
		type ProfileInfo
	} from '$lib/api/bluesky';
	import {
		connectBlueskyWithPopup,
		disconnectBluesky,
		initAuthenticatedBlueskyClient,
		type AuthenticatedBlueskyContext
	} from '$lib/api/blueskyAuth';
	import { BLUESKY_GRAPH_LIST_CREATE_SCOPES } from '$lib/constants/blueskyOAuth';
	import type { DiscoverProgress } from '$lib/types';

	const FOLLOW_PAGE_SIZE = 100;
	const INITIAL_VISIBLE_FOLLOWS = 120;
	const VISIBLE_FOLLOW_INCREMENT = 120;
	const MAX_LIST_NAME_LENGTH = 64;
	const LIST_ITEM_WRITE_BATCH_SIZE = 50;
	const LIST_PURPOSE = 'app.bsky.graph.defs#curatelist';

	type CreateProgress = {
		phase: string;
		current: number;
		total: number;
		failed: number;
	};

	let initialHandle = $state('');
	let targetProfile = $state<ProfileInfo | null>(null);
	let follows: FollowProfileInfo[] = $state([]);
	let followCursor = $state<string | null>(null);
	let visibleFollowCount = $state(INITIAL_VISIBLE_FOLLOWS);
	let loadingFollows = $state(false);
	let restoringSession = $state(true);
	let connecting = $state(false);
	let creatingList = $state(false);
	let error = $state<string | null>(null);
	let successMessage = $state<string | null>(null);
	let progress: DiscoverProgress = $state({ phase: '', current: 0, total: 0 });
	let createProgress: CreateProgress = $state({ phase: '', current: 0, total: 0, failed: 0 });
	let authProfile: ProfileInfo | null = $state(null);
	let sessionSub: string | null = $state(null);
	let hasListWriteScopes = $state(false);
	let createdListUri = $state<string | null>(null);
	let createdListUrl = $state<string | null>(null);
	let failedListItems: Array<{ handle: string; message: string }> = $state([]);
	let authClient: BrowserOAuthClient | null = $state(null);
	let authAgent: Agent | null = $state(null);
	let loadController: AbortController | null = $state(null);
	let loadToken = 0;
	let createToken = 0;
	let createCancelled = false;

	const visibleFollows = $derived(follows.slice(0, visibleFollowCount));
	const hiddenFollowCount = $derived(Math.max(0, follows.length - visibleFollows.length));
	const listName = $derived(targetProfile ? buildListName(targetProfile.handle) : 'Follows');
	const createDisabledReason = $derived.by(() => {
		if (loadingFollows) return 'Still loading all follows. The list can be created once loading finishes.';
		if (!targetProfile) return 'Load a Bluesky handle first.';
		if (follows.length === 0) return 'No follows loaded for this account yet.';
		if (!authProfile || !authAgent) return 'Connect your Bluesky account.';
		if (!hasListWriteScopes) return 'Reconnect to approve list-write scopes.';
		return null;
	});
	const canCreateList = $derived(createDisabledReason === null);
	const sessionLabel = $derived.by(() => {
		if (authProfile) return `@${authProfile.handle}`;
		if (restoringSession) return 'Restoring';
		if (connecting) return 'Connecting';
		return 'Disconnected';
	});

	function buildListName(handle: string): string {
		const cleanHandle = handle.replace(/^@/, '').trim();
		const fullName = `Follows of @${cleanHandle}`;
		if (fullName.length <= MAX_LIST_NAME_LENGTH) return fullName;
		return `${fullName.slice(0, MAX_LIST_NAME_LENGTH - 3).trimEnd()}...`;
	}

	function buildListDescription(handle: string, count: number): string {
		const date = new Date().toISOString().slice(0, 10);
		return `Copied from @${handle}'s public follow graph on ${date}. ${count.toLocaleString()} accounts.`;
	}

	function buildListUrl(uri: string, ownerHandle: string): string | null {
		const rkey = uri.split('/').pop()?.trim();
		if (!rkey) return null;
		return `https://bsky.app/profile/${ownerHandle}/lists/${rkey}`;
	}

	function updateHandleQuery(handle: string | null) {
		if (!browser) return;
		const url = new URL(window.location.href);
		const next = handle?.replace(/^@/, '').trim() ?? '';
		if (next) {
			url.searchParams.set('handle', next);
		} else {
			url.searchParams.delete('handle');
		}
		window.history.replaceState({}, '', url.toString());
	}

	function formatAuthError(err: unknown, fallback: string): string {
		const message = String((err as { message?: string } | null | undefined)?.message ?? '');
		if (message.includes('Missing required scope')) {
			return 'Your Bluesky grant cannot create lists yet. Disconnect and connect again to approve the Warg list scopes.';
		}
		return message || fallback;
	}

	function getErrorMessage(err: unknown, fallback: string): string {
		return String((err as { message?: string } | null | undefined)?.message ?? '') || fallback;
	}

	function hasRepoCreateScope(scopes: Set<string>, collection: string): boolean {
		return (
			scopes.has(`repo:${collection}?action=create`) ||
			scopes.has(`repo:${collection}`) ||
			scopes.has('repo:*?action=create') ||
			scopes.has('repo:*') ||
			scopes.has('transition:generic')
		);
	}

	function hasRequiredListScopes(scope: string): boolean {
		const scopes = new Set(scope.split(/\s+/).filter(Boolean));
		if (scopes.has('transition:generic')) return true;
		return (
			hasRepoCreateScope(scopes, 'app.bsky.graph.list') &&
			hasRepoCreateScope(scopes, 'app.bsky.graph.listitem')
		);
	}

	async function applyAuthenticatedContext(context: AuthenticatedBlueskyContext) {
		authClient = context.client;
		authAgent = context.agent;
		authProfile = context.profile;
		sessionSub = context.session.sub;

		const tokenInfo = await context.session.getTokenInfo('auto');
		hasListWriteScopes = hasRequiredListScopes(tokenInfo.scope);
	}

	async function restoreSession() {
		restoringSession = true;
		error = null;

		try {
			const { client, context } = await initAuthenticatedBlueskyClient();
			authClient = client;
			if (context) {
				await applyAuthenticatedContext(context);
			} else {
				authAgent = null;
				authProfile = null;
				sessionSub = null;
				hasListWriteScopes = false;
			}
		} catch (err) {
			const message = String((err as { message?: string })?.message || '');
			if (message.includes('Redirecting to loopback IP')) return;
			error = formatAuthError(err, 'Could not restore your Bluesky session.');
			authAgent = null;
			authProfile = null;
			sessionSub = null;
			hasListWriteScopes = false;
		} finally {
			restoringSession = false;
		}
	}

	async function handleConnect() {
		connecting = true;
		error = null;

		try {
			const context = await connectBlueskyWithPopup();
			await applyAuthenticatedContext(context);
		} catch (err) {
			error = formatAuthError(err, 'Could not connect your Bluesky account.');
		} finally {
			connecting = false;
		}
	}

	async function handleDisconnect() {
		const sub = sessionSub;
		if (!sub) return;

		try {
			await disconnectBluesky(sub);
			authAgent = null;
			authProfile = null;
			sessionSub = null;
			hasListWriteScopes = false;
		} catch (err) {
			error =
				String((err as { message?: string } | null | undefined)?.message ?? '') ||
				'Could not disconnect your Bluesky session.';
		}
	}

	function cancelFollowLoad() {
		loadController?.abort();
		loadController = null;
		loadingFollows = false;
	}

	async function loadFollows(handle: string) {
		const token = ++loadToken;
		loadController?.abort();
		const controller = new AbortController();
		loadController = controller;

		loadingFollows = true;
		error = null;
		successMessage = null;
		createdListUri = null;
		createdListUrl = null;
		failedListItems = [];
		follows = [];
		followCursor = null;
		visibleFollowCount = INITIAL_VISIBLE_FOLLOWS;

		try {
			progress = { phase: 'Resolving profile...', current: 0, total: 0 };
			const profile = await getProfile(handle);
			if (token !== loadToken) return;
			targetProfile = profile;
			updateHandleQuery(profile.handle);

			const byDid = new Map<string, FollowProfileInfo>();
			let cursor: string | undefined;
			let pageCount = 0;

			do {
				progress = {
					phase: 'Loading follows...',
					current: byDid.size,
					total: profile.postsCount,
					detail: pageCount > 0 ? `${pageCount.toLocaleString()} pages scanned` : undefined
				};
				const page = await getFollowsPage(profile.did, {
					cursor,
					limit: FOLLOW_PAGE_SIZE,
					signal: controller.signal
				});
				if (token !== loadToken) return;
				pageCount += 1;
				for (const follow of page.follows) {
					byDid.set(follow.did, follow);
				}
				follows = [...byDid.values()];
				followCursor = page.cursor ?? null;
				cursor = page.cursor;
			} while (cursor);

			progress = {
				phase: 'Follows loaded',
				current: follows.length,
				total: follows.length
			};
		} catch (err) {
			if ((err as { name?: string })?.name === 'AbortError') return;
			if (token !== loadToken) return;
			error =
				String((err as { message?: string } | null | undefined)?.message ?? '') ||
				'Could not load follows for this account.';
		} finally {
			if (token === loadToken) {
				loadingFollows = false;
				loadController = null;
			}
		}
	}

	function cancelCreate() {
		createCancelled = true;
	}

	async function createWargList() {
		if (!authAgent || !authProfile || !targetProfile || follows.length === 0) return;

		if (!hasListWriteScopes) {
			error = `This Bluesky grant is missing ${BLUESKY_GRAPH_LIST_CREATE_SCOPES.join(' and ')}. Disconnect and connect again.`;
			return;
		}

		const token = ++createToken;
		createCancelled = false;
		creatingList = true;
		error = null;
		successMessage = null;
		createdListUri = null;
		createdListUrl = null;
		failedListItems = [];
		createProgress = { phase: 'Creating list...', current: 0, total: follows.length, failed: 0 };

		try {
			const createdAt = new Date().toISOString();
			const list = await authAgent.app.bsky.graph.list.create(
				{ repo: authProfile.did },
				{
					purpose: LIST_PURPOSE,
					name: listName,
					description: buildListDescription(targetProfile.handle, follows.length),
					createdAt
				}
			);
			if (token !== createToken) return;

			createdListUri = list.uri;
			createdListUrl = buildListUrl(list.uri, authProfile.handle);

			let createdItems = 0;
			let failedItems = 0;
			const itemFailures: Array<{ handle: string; message: string }> = [];

			for (let index = 0; index < follows.length; index += LIST_ITEM_WRITE_BATCH_SIZE) {
				if (token !== createToken) return;
				if (createCancelled) break;

				const batch = follows.slice(index, index + LIST_ITEM_WRITE_BATCH_SIZE);
				const batchCreatedAt = new Date().toISOString();
				const writes: ComAtprotoRepoApplyWrites.InputSchema['writes'] = batch.map((follow) => ({
					$type: 'com.atproto.repo.applyWrites#create',
					collection: 'app.bsky.graph.listitem',
					value: {
						$type: 'app.bsky.graph.listitem',
						subject: follow.did,
						list: list.uri,
						createdAt: batchCreatedAt
					}
				}));

				try {
					await authAgent.com.atproto.repo.applyWrites({
						repo: authProfile.did,
						validate: true,
						writes
					});
					createdItems += batch.length;
				} catch (itemErr) {
					const message = getErrorMessage(itemErr, 'Could not add this batch.');
					if (message.includes('Missing required scope')) throw itemErr;

					failedItems += batch.length;
					for (const follow of batch) {
						if (itemFailures.length < 8) {
							itemFailures.push({
								handle: follow.handle,
								message
							});
						}
					}
				}

				if (createCancelled) {
					createProgress = {
						phase: 'Stopping...',
						current: createdItems + failedItems,
						total: follows.length,
						failed: failedItems
					};
					break;
				}

				createProgress = {
					phase: 'Bulk importing follows...',
					current: createdItems + failedItems,
					total: follows.length,
					failed: failedItems
				};
			}

			failedListItems = itemFailures;
			successMessage = createCancelled
				? `Created ${listName} with ${createdItems.toLocaleString()} accounts before stopping.`
				: `Created ${listName} with ${createdItems.toLocaleString()} accounts. Bluesky may need time to index the list feed.`;
		} catch (err) {
			if (token !== createToken) return;
			error = formatAuthError(err, 'Could not create the Warg list.');
		} finally {
			if (token === createToken) {
				creatingList = false;
			}
		}
	}

	function showMoreFollows() {
		visibleFollowCount += VISIBLE_FOLLOW_INCREMENT;
	}

	function handleSessionDeleted() {
		error = 'Your Bluesky session expired. Connect again before creating a list.';
		authAgent = null;
		authProfile = null;
		sessionSub = null;
		hasListWriteScopes = false;
	}

	function addAuthClientListener(client: BrowserOAuthClient, handler: EventListener) {
		(client as unknown as EventTarget).addEventListener('deleted', handler);
	}

	function removeAuthClientListener(client: BrowserOAuthClient | null, handler: EventListener) {
		(client as unknown as EventTarget | null)?.removeEventListener('deleted', handler);
	}

	onMount(() => {
		void restoreSession();

		const params = new URL(window.location.href).searchParams;
		const handle = params.get('handle')?.trim();
		if (handle) {
			initialHandle = handle;
			void loadFollows(handle);
		}

		return () => {
			loadController?.abort();
			removeAuthClientListener(authClient, handleSessionDeleted as EventListener);
		};
	});

	$effect(() => {
		if (!authClient) return;
		addAuthClientListener(authClient, handleSessionDeleted as EventListener);

		return () => {
			removeAuthClientListener(authClient, handleSessionDeleted as EventListener);
		};
	});
</script>

<svelte:head>
	<title>Warg</title>
</svelte:head>

<main class="warg-page">
	<RouteNav current="warg" handle={targetProfile?.handle ?? initialHandle} compact />

	<header class="warg-header">
		<div class="title-stack">
			<p class="eyebrow">Warg mode</p>
			<h1>Warg</h1>
		</div>

		<section class="session-panel" aria-label="Bluesky session">
			<div>
				<span class="session-label">Session</span>
				<strong>{sessionLabel}</strong>
				{#if authProfile && !hasListWriteScopes}
					<small>List scopes missing</small>
				{:else if authProfile}
					<small>Ready for list writes</small>
				{:else}
					<small>Sign in to create the list</small>
				{/if}
			</div>
			{#if authProfile}
				<button type="button" class="secondary-btn" onclick={handleDisconnect}>Disconnect</button>
			{:else}
				<button type="button" class="primary-btn" onclick={handleConnect} disabled={connecting || restoringSession}>
					{connecting ? 'Connecting...' : 'Connect'}
				</button>
			{/if}
		</section>
	</header>

	<section class="search-panel">
		<SearchBar
			{initialHandle}
			onsearch={(handle) => loadFollows(handle)}
			onprofile={(profile) => {
				targetProfile = profile;
				void loadFollows(profile.handle);
			}}
			disabled={loadingFollows || creatingList}
			placeholder="Search a Bluesky handle..."
			buttonLabel="Load follows"
		/>
		{#if loadingFollows}
			<button type="button" class="secondary-btn cancel-load" onclick={cancelFollowLoad}>Cancel</button>
		{/if}
	</section>

	<section class="explainer-panel" aria-label="Warg list notes">
		<h2>Bulk import and feed indexing</h2>
		<p>
			Warg creates one Bluesky list, then one list-item record for every followed account. Bluesky
			does not currently expose a single create-list call where an app can send the list plus all
			of the DIDs.
		</p>
		<p>
			Warg imports those records in bulk batches, so the member count can appear before the native
			Bluesky list feed has finished indexing and backfilling posts. If the list page looks sparse
			right after creation, give the feed some time and refresh it later.
		</p>
	</section>

	{#if loadingFollows}
		<LoadingSpinner {progress} />
	{/if}

	{#if error}
		<ErrorBanner message={error} />
	{/if}

	{#if successMessage}
		<section class="success-panel">
			<strong>{successMessage}</strong>
			{#if createdListUrl}
				<a href={createdListUrl} target="_blank" rel="noopener">Open on Bluesky</a>
			{/if}
		</section>
	{/if}

	<section class="warg-grid">
		<section class="control-panel">
			<h2>Target</h2>
			{#if targetProfile}
				<div class="profile-row">
					{#if targetProfile.avatar}
						<img class="avatar" src={targetProfile.avatar} alt="" />
					{/if}
					<div class="profile-copy">
						<strong>{targetProfile.displayName || targetProfile.handle}</strong>
						<span>@{targetProfile.handle}</span>
					</div>
				</div>
				<div class="stat-row">
					<span><strong>{follows.length.toLocaleString()}</strong> follows loaded</span>
					<span>{followCursor ? 'More available' : follows.length > 0 ? 'Complete' : 'No follows'}</span>
				</div>
			{:else}
				<div class="empty-state">No target loaded</div>
			{/if}
		</section>

		<section class="control-panel">
			<h2>Create</h2>
			<div class="list-preview">
				<span>List name</span>
				<strong>{listName}</strong>
			</div>
			<div class="stat-row">
				<span><strong>{follows.length.toLocaleString()}</strong> list items</span>
				<span>{authProfile ? `Owner @${authProfile.handle}` : 'No owner'}</span>
			</div>
			<div class="action-row">
				<button
					type="button"
					class="primary-btn create-btn"
					onclick={createWargList}
					disabled={!canCreateList || creatingList || loadingFollows}
				>
					{creatingList ? 'Creating...' : 'Create List'}
				</button>
				{#if creatingList}
					<button type="button" class="secondary-btn" onclick={cancelCreate}>Stop</button>
				{/if}
			</div>
			{#if createDisabledReason && !creatingList}
				<p class="disabled-reason">{createDisabledReason}</p>
			{/if}

			{#if creatingList || createProgress.current > 0}
				<div class="create-meter" aria-label="Create progress">
					<div class="meter-track">
						<span
							style={`width: ${
								createProgress.total > 0
									? Math.min(100, (createProgress.current / createProgress.total) * 100)
									: 0
							}%`}
						></span>
					</div>
					<small>
						{createProgress.phase} {createProgress.current.toLocaleString()} /
						{createProgress.total.toLocaleString()}
						{createProgress.failed > 0 ? `, ${createProgress.failed.toLocaleString()} failed` : ''}
					</small>
				</div>
			{/if}
		</section>
	</section>

	{#if failedListItems.length > 0}
		<section class="failure-panel">
			<h2>Skipped</h2>
			<ul>
				{#each failedListItems as item}
					<li><strong>@{item.handle}</strong> {item.message}</li>
				{/each}
			</ul>
		</section>
	{/if}

	{#if follows.length > 0}
		<section class="follows-panel">
			<div class="panel-head">
				<h2>Follows</h2>
				<span>{follows.length.toLocaleString()} accounts</span>
			</div>
			<ul class="follow-list">
				{#each visibleFollows as follow (follow.did)}
					<li class="follow-row">
						{#if follow.avatar}
							<img class="follow-avatar" src={follow.avatar} alt="" />
						{:else}
							<span class="follow-avatar placeholder"></span>
						{/if}
						<div class="follow-copy">
							<strong>{follow.displayName || follow.handle}</strong>
							<span>@{follow.handle}</span>
						</div>
					</li>
				{/each}
			</ul>
			{#if hiddenFollowCount > 0}
				<button type="button" class="secondary-btn show-more" onclick={showMoreFollows}>
					Show {Math.min(VISIBLE_FOLLOW_INCREMENT, hiddenFollowCount).toLocaleString()} more
				</button>
			{/if}
		</section>
	{/if}
</main>

<style>
	.warg-page {
		min-height: 100vh;
		padding: 24px;
		background:
			linear-gradient(135deg, color-mix(in srgb, var(--bg-paper) 92%, #d8f3eb 8%), var(--bg-paper)),
			var(--bg-paper);
		color: var(--text-ink);
		font-family: var(--font-hand);
	}

	.warg-header {
		display: flex;
		align-items: stretch;
		justify-content: space-between;
		gap: 18px;
		max-width: 1120px;
		margin: 0 auto 20px;
	}

	.title-stack {
		display: grid;
		align-content: center;
		gap: 4px;
	}

	.eyebrow,
	.session-label {
		margin: 0;
		color: var(--muted);
		font-size: 0.78rem;
		font-weight: 800;
		letter-spacing: 0;
		text-transform: uppercase;
	}

	h1,
	h2 {
		margin: 0;
		letter-spacing: 0;
	}

	h1 {
		font-size: clamp(2.4rem, 6vw, 4.8rem);
		line-height: 0.92;
	}

	h2 {
		font-size: 1.2rem;
	}

	.session-panel,
	.search-panel,
	.explainer-panel,
	.control-panel,
	.success-panel,
	.failure-panel,
	.follows-panel {
		border: 1px solid var(--control-border);
		background: var(--panel-bg);
		box-shadow: var(--shadow-soft);
	}

	.session-panel {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 18px;
		min-width: min(100%, 360px);
		padding: 14px;
		border-radius: 8px;
	}

	.session-panel div {
		display: grid;
		gap: 2px;
		min-width: 0;
	}

	.session-panel strong {
		font-size: 1.05rem;
		word-break: break-word;
	}

	.session-panel small,
	.create-meter small {
		color: var(--muted);
	}

	.search-panel {
		display: flex;
		align-items: center;
		gap: 12px;
		max-width: 1120px;
		margin: 0 auto 18px;
		padding: 18px;
		border-radius: 8px;
	}

	.search-panel :global(.search-bar) {
		width: 100%;
		max-width: none;
		margin: 0;
	}

	.explainer-panel {
		max-width: 1120px;
		margin: 0 auto 18px;
		padding: 18px;
		border-radius: 8px;
	}

	.explainer-panel p {
		max-width: 74ch;
		margin: 10px 0 0;
		color: var(--muted);
		line-height: 1.45;
	}

	.cancel-load {
		flex: 0 0 auto;
	}

	.warg-grid {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 18px;
		max-width: 1120px;
		margin: 0 auto 18px;
	}

	.control-panel,
	.success-panel,
	.failure-panel,
	.follows-panel {
		border-radius: 8px;
		padding: 18px;
	}

	.profile-row,
	.follow-row {
		display: flex;
		align-items: center;
		gap: 12px;
		min-width: 0;
	}

	.profile-row {
		margin-top: 14px;
	}

	.avatar,
	.follow-avatar {
		flex: 0 0 auto;
		object-fit: cover;
		background: var(--muted-surface);
		border: 1px solid var(--control-border);
	}

	.avatar {
		width: 56px;
		height: 56px;
		border-radius: 8px;
	}

	.follow-avatar {
		width: 42px;
		height: 42px;
		border-radius: 6px;
	}

	.follow-avatar.placeholder {
		display: block;
	}

	.profile-copy,
	.follow-copy {
		display: grid;
		gap: 2px;
		min-width: 0;
	}

	.profile-copy strong,
	.follow-copy strong,
	.profile-copy span,
	.follow-copy span {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.profile-copy span,
	.follow-copy span,
	.stat-row span,
	.list-preview span {
		color: var(--muted);
	}

	.stat-row {
		display: flex;
		flex-wrap: wrap;
		gap: 10px;
		margin-top: 16px;
	}

	.stat-row span {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		padding: 8px 10px;
		border-radius: 6px;
		background: var(--panel-bg-muted);
	}

	.list-preview {
		display: grid;
		gap: 4px;
		margin-top: 14px;
		padding: 12px;
		border-radius: 6px;
		background: var(--panel-bg-muted);
	}

	.list-preview strong {
		overflow-wrap: anywhere;
	}

	.action-row {
		display: flex;
		flex-wrap: wrap;
		gap: 10px;
		margin-top: 16px;
	}

	button,
	a {
		font: inherit;
	}

	button {
		border: 1px solid var(--control-border);
		border-radius: 6px;
		cursor: pointer;
		transition:
			transform 0.15s ease,
			background 0.15s ease,
			border-color 0.15s ease;
	}

	button:hover:not(:disabled) {
		transform: translateY(-1px);
		border-color: var(--control-border-hover);
	}

	button:disabled {
		cursor: not-allowed;
		opacity: 0.55;
	}

	.primary-btn,
	.secondary-btn {
		min-height: 40px;
		padding: 9px 13px;
		font-weight: 800;
	}

	.primary-btn {
		background: var(--accent);
		color: var(--accent-contrast);
	}

	.secondary-btn {
		background: var(--control-bg);
		color: var(--text-ink);
	}

	.create-btn {
		min-width: 132px;
	}

	.create-meter {
		display: grid;
		gap: 8px;
		margin-top: 14px;
	}

	.disabled-reason {
		margin: 10px 0 0;
		color: var(--muted);
		font-size: 0.92rem;
	}

	.meter-track {
		height: 10px;
		overflow: hidden;
		border-radius: 999px;
		background: var(--muted-surface);
	}

	.meter-track span {
		display: block;
		height: 100%;
		border-radius: inherit;
		background: var(--accent);
		transition: width 0.2s ease;
	}

	.success-panel,
	.failure-panel,
	.follows-panel {
		max-width: 1120px;
		margin: 0 auto 18px;
	}

	.success-panel {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		border-color: color-mix(in srgb, #1d7f6e 48%, var(--control-border));
	}

	.success-panel a {
		color: var(--accent);
		font-weight: 800;
	}

	.failure-panel ul,
	.follow-list {
		list-style: none;
		margin: 14px 0 0;
		padding: 0;
	}

	.failure-panel li {
		padding: 8px 0;
		border-top: 1px solid var(--control-border);
	}

	.panel-head {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 12px;
	}

	.panel-head span {
		color: var(--muted);
	}

	.follow-list {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(230px, 1fr));
		gap: 10px;
	}

	.follow-row {
		min-height: 58px;
		padding: 8px;
		border: 1px solid var(--control-border);
		border-radius: 8px;
		background: color-mix(in srgb, var(--card-bg) 84%, transparent);
	}

	.show-more {
		margin-top: 14px;
	}

	.empty-state {
		margin-top: 14px;
		padding: 14px;
		border-radius: 6px;
		background: var(--panel-bg-muted);
		color: var(--muted);
	}

	@media (max-width: 760px) {
		.warg-page {
			padding: 16px;
		}

		.warg-header,
		.search-panel,
		.success-panel {
			flex-direction: column;
			align-items: stretch;
		}

		.warg-grid {
			grid-template-columns: 1fr;
		}

		.session-panel {
			min-width: 0;
		}

		.follow-list {
			grid-template-columns: 1fr;
		}
	}
</style>
