<script lang="ts">
	import { onMount } from 'svelte';
	import { browser } from '$app/environment';
	import '../../app.css';
	import type { DiscoverProgress, SelfReplyThread } from '$lib/types';
	import { getProfile, getProfiles, getFullThread, type ProfileInfo } from '$lib/api/bluesky';
	import ErrorBanner from '$lib/components/ErrorBanner.svelte';
	import FontPicker from '$lib/components/FontPicker.svelte';
	import LoadingSpinner from '$lib/components/LoadingSpinner.svelte';
	import RouteNav from '$lib/components/RouteNav.svelte';
	import SearchBar from '$lib/components/SearchBar.svelte';
	import GroupChat from '$lib/components/GroupChat.svelte';
	import { parseCarRecordsWasm } from '$lib/utils/carParserWasm';
	import { downloadRepoCar } from '$lib/utils/repoHydration';
	import {
		extractRepoMentions,
		groupMentionPostsByThread,
		type MentionedUser,
		type RepoMentionsSummary
	} from '$lib/utils/repoMentions';
	import { buildBskyPostUrl } from '$lib/utils/viewerLinks';

	const POST_COLLECTION = 'app.bsky.feed.post';
	const MAX_THREADS_PER_USER = 24;
	const PROFILE_BATCH_SIZE = 100;
	const THREAD_FETCH_CONCURRENCY = 3;

	const fontFamilies: Record<string, string> = {
		virgil: "'Virgil', cursive",
		caveat: "'Caveat', cursive",
		patrick: "'Patrick Hand', cursive",
		'comic-neue': "'Comic Neue', cursive",
		inter: "'Inter', sans-serif",
		system: 'system-ui, -apple-system, sans-serif'
	};

	const dateFormatter = new Intl.DateTimeFormat('en-US', {
		dateStyle: 'medium',
		timeStyle: 'short'
	});

	type LoadedThread = SelfReplyThread & { isTruncated?: boolean };

	type MentionThreadEntry = {
		rootUri: string;
		latestMentionAt: string | null;
		mentionPostUris: string[];
		thread: LoadedThread;
	};

	type UserThreadCacheEntry = {
		loading: boolean;
		loaded: boolean;
		error: string | null;
		progressLabel: string | null;
		totalThreadCount: number;
		threads: MentionThreadEntry[];
	};

	type MentionSortKey = 'most-mentions' | 'latest-mention' | 'earliest-mention' | 'handle';
	type MentionListEntry = { user: MentionedUser; profile: ProfileInfo | null };
	type RepoLoadStats = {
		source: 'pds' | 'relay' | null;
		elapsedMs: number;
		downloadedBytes: number;
		totalRecords: number;
	};

	function createInitialRepoLoadStats(): RepoLoadStats {
		return { source: null, elapsedMs: 0, downloadedBytes: 0, totalRecords: 0 };
	}

	function createEmptyThreadEntry(): UserThreadCacheEntry {
		return {
			loading: false,
			loaded: false,
			error: null,
			progressLabel: null,
			totalThreadCount: 0,
			threads: []
		};
	}

	function throwIfAborted(signal: AbortSignal): void {
		if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
	}

	function formatBytes(bytes: number): string {
		if (bytes <= 0) return '0 B';
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
		return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	}

	function formatSpeed(bytesPerSecond: number): string {
		if (bytesPerSecond <= 0) return '0 B/s';
		if (bytesPerSecond < 1024) return `${bytesPerSecond.toFixed(0)} B/s`;
		if (bytesPerSecond < 1024 * 1024) return `${(bytesPerSecond / 1024).toFixed(0)} KB/s`;
		return `${(bytesPerSecond / (1024 * 1024)).toFixed(1)} MB/s`;
	}

	function formatDuration(ms: number): string {
		if (ms <= 0) return '0s';
		if (ms < 1000) return `${Math.round(ms)}ms`;
		return `${(ms / 1000).toFixed(1)}s`;
	}

	function formatDateTime(value: string | null | undefined): string {
		if (!value) return 'Unknown date';
		const parsed = new Date(value);
		return Number.isNaN(parsed.getTime()) ? 'Unknown date' : dateFormatter.format(parsed);
	}

	function truncateText(text: string, maxLength = 240): string {
		const normalized = text.replace(/\s+/g, ' ').trim();
		if (normalized.length <= maxLength) return normalized;
		return `${normalized.slice(0, maxLength - 1).trimEnd()}…`;
	}

	function shortenDid(did: string): string {
		if (did.length <= 22) return did;
		return `${did.slice(0, 16)}…${did.slice(-6)}`;
	}

	function normalizeSearchText(value: string): string {
		return value.trim().toLowerCase();
	}

	function normalizeHandleSearchText(value: string): string {
		return normalizeSearchText(value).replace(/^@+/, '');
	}

	function compareNullableDate(
		a: string | null | undefined,
		b: string | null | undefined,
		direction: 'asc' | 'desc'
	): number {
		const aTime = a ? Date.parse(a) : Number.NaN;
		const bTime = b ? Date.parse(b) : Number.NaN;
		const aValid = Number.isFinite(aTime);
		const bValid = Number.isFinite(bTime);
		if (!aValid && !bValid) return 0;
		if (!aValid) return 1;
		if (!bValid) return -1;
		return direction === 'asc' ? aTime - bTime : bTime - aTime;
	}

	function userPrimaryLabel(profile: ProfileInfo | null, did: string): string {
		return profile?.handle ? `@${profile.handle}` : shortenDid(did);
	}

	function userSecondaryLabel(profile: ProfileInfo | null, did: string): string {
		if (profile?.displayName?.trim()) return profile.displayName;
		return did;
	}

	function updateHandleQuery(handle: string | null): void {
		if (!browser) return;
		const url = new URL(window.location.href);
		const nextHandle = handle?.replace(/^@/, '').trim() ?? '';
		if (nextHandle) {
			url.searchParams.set('handle', nextHandle);
		} else {
			url.searchParams.delete('handle');
		}
		window.history.replaceState({}, '', url.toString());
	}

	let fontKey = $state('patrick');
	let fontFamily = $derived(fontFamilies[fontKey] ?? fontFamilies.virgil);
	let initialHandle = $state('');
	let profile = $state<ProfileInfo | null>(null);
	let summary = $state<RepoMentionsSummary | null>(null);
	let loading = $state(false);
	let loadingProfiles = $state(false);
	let error = $state<string | null>(null);
	let profilesError = $state<string | null>(null);
	let progress = $state<DiscoverProgress>({ phase: 'Resolving profile…', current: 0, total: 0 });
	let repoLoadStats = $state<RepoLoadStats>(createInitialRepoLoadStats());
	let mentionedProfiles = $state<Record<string, ProfileInfo>>({});
	let searchQuery = $state('');
	let sortKey = $state<MentionSortKey>('most-mentions');
	let selectedDid = $state<string | null>(null);
	let threadCache = $state<Record<string, UserThreadCacheEntry>>({});
	let loadController: AbortController | null = null;
	let loadToken = 0;

	let mentionEntries = $derived.by<MentionListEntry[]>(() => {
		const current = summary;
		if (!current) return [];
		return current.users.map((user) => ({
			user,
			profile: mentionedProfiles[user.did] ?? null
		}));
	});

	let filteredEntries = $derived.by<MentionListEntry[]>(() => {
		const query = normalizeHandleSearchText(searchQuery);
		if (!query) return mentionEntries;
		return mentionEntries.filter((entry) => {
			const handle = normalizeHandleSearchText(entry.profile?.handle ?? '');
			const displayName = normalizeSearchText(entry.profile?.displayName ?? '');
			const did = normalizeSearchText(entry.user.did);
			return handle.includes(query) || displayName.includes(query) || did.includes(query);
		});
	});

	let sortedEntries = $derived.by<MentionListEntry[]>(() => {
		const entries = [...filteredEntries];
		return entries.sort((a, b) => {
			const labelA = normalizeHandleSearchText(a.profile?.handle ?? a.user.did);
			const labelB = normalizeHandleSearchText(b.profile?.handle ?? b.user.did);
			if (sortKey === 'most-mentions') {
				return (
					b.user.mentionPostCount - a.user.mentionPostCount ||
					b.user.mentionInstanceCount - a.user.mentionInstanceCount ||
					compareNullableDate(a.user.lastMentionedAt, b.user.lastMentionedAt, 'desc') ||
					labelA.localeCompare(labelB)
				);
			}
			if (sortKey === 'latest-mention') {
				return (
					compareNullableDate(a.user.lastMentionedAt, b.user.lastMentionedAt, 'desc') ||
					b.user.mentionPostCount - a.user.mentionPostCount ||
					labelA.localeCompare(labelB)
				);
			}
			if (sortKey === 'earliest-mention') {
				return (
					compareNullableDate(a.user.firstMentionedAt, b.user.firstMentionedAt, 'asc') ||
					b.user.mentionPostCount - a.user.mentionPostCount ||
					labelA.localeCompare(labelB)
				);
			}
			return labelA.localeCompare(labelB);
		});
	});

	let selectedUser = $derived.by<MentionedUser | null>(() => {
		if (sortedEntries.length === 0) return null;
		return (
			sortedEntries.find((entry) => entry.user.did === selectedDid)?.user ??
			sortedEntries[0]?.user ??
			null
		);
	});

	let selectedProfile = $derived.by<ProfileInfo | null>(() => {
		const user = selectedUser;
		return user ? mentionedProfiles[user.did] ?? null : null;
	});

	let selectedThreadState = $derived.by<UserThreadCacheEntry | null>(() => {
		const user = selectedUser;
		if (!user) return null;
		return threadCache[user.did] ?? null;
	});

	let resolvedHandleCount = $derived(Object.keys(mentionedProfiles).length);
	let filteredUserCount = $derived(sortedEntries.length);

	async function hydrateMentionedProfiles(users: MentionedUser[], token: number): Promise<void> {
		if (users.length === 0) {
			mentionedProfiles = {};
			profilesError = null;
			loadingProfiles = false;
			return;
		}

		loadingProfiles = true;
		profilesError = null;
		const nextProfiles: Record<string, ProfileInfo> = {};
		const dids = users.map((user) => user.did);

		try {
			for (let index = 0; index < dids.length; index += PROFILE_BATCH_SIZE) {
				const batch = dids.slice(index, index + PROFILE_BATCH_SIZE);
				const profiles = await getProfiles(batch);
				if (token !== loadToken) return;
				for (const item of profiles) {
					nextProfiles[item.did] = item;
				}
				mentionedProfiles = { ...nextProfiles };
			}
		} catch (err: any) {
			if (token !== loadToken) return;
			profilesError = err?.message || 'Could not resolve every mentioned handle from the public API.';
			mentionedProfiles = { ...nextProfiles };
		} finally {
			if (token === loadToken) {
				loadingProfiles = false;
			}
		}
	}

	async function ensureThreadsHydrated(user: MentionedUser): Promise<void> {
		const token = loadToken;
		const existing = threadCache[user.did];
		if (existing?.loading || existing?.loaded) return;

		const groups = groupMentionPostsByThread(user.posts, MAX_THREADS_PER_USER);
		const totalThreadCount = new Set(user.posts.map((post) => post.rootUri)).size;

		const updateEntry = (updates: Partial<UserThreadCacheEntry>) => {
			if (token !== loadToken) return;
			const current = threadCache[user.did] ?? createEmptyThreadEntry();
			threadCache = { ...threadCache, [user.did]: { ...current, ...updates } };
		};

		updateEntry({
			loading: true,
			loaded: false,
			error: null,
			progressLabel: `Loading ${groups.length.toLocaleString()} thread${groups.length === 1 ? '' : 's'} from appview…`,
			totalThreadCount,
			threads: []
		});

		if (groups.length === 0) {
			updateEntry({ loading: false, loaded: true, progressLabel: null });
			return;
		}

		const results: (MentionThreadEntry | null)[] = new Array(groups.length).fill(null);
		let nextIndex = 0;
		let completed = 0;
		const workerCount = Math.min(THREAD_FETCH_CONCURRENCY, groups.length);

		async function worker(): Promise<void> {
			while (true) {
				if (token !== loadToken) return;
				const index = nextIndex++;
				if (index >= groups.length) return;
				const group = groups[index];
				try {
					const thread = await getFullThread(group.rootUri);
					results[index] = {
						rootUri: group.rootUri,
						latestMentionAt: group.latestMentionAt,
						mentionPostUris: group.mentionPostUris,
						thread
					};
				} catch {
					results[index] = null;
				}
				completed += 1;
				updateEntry({
					progressLabel: `${completed.toLocaleString()} / ${groups.length.toLocaleString()} threads loaded`
				});
			}
		}

		try {
			await Promise.all(Array.from({ length: workerCount }, () => worker()));
			if (token !== loadToken) return;
			const threads = results.filter((entry): entry is MentionThreadEntry => entry !== null);
			updateEntry({
				loading: false,
				loaded: true,
				error:
					threads.length === 0 ? 'Could not load any threads for this account from appview.' : null,
				progressLabel: null,
				threads
			});
		} catch (err: any) {
			updateEntry({
				loading: false,
				loaded: false,
				error: err?.message || 'Could not load threads for this account.',
				progressLabel: null
			});
		}
	}

	async function loadMentions(nextProfile: ProfileInfo): Promise<void> {
		const token = ++loadToken;
		loadController?.abort();
		loadController = new AbortController();
		const signal = loadController.signal;

		loading = true;
		error = null;
		profilesError = null;
		loadingProfiles = false;
		mentionedProfiles = {};
		threadCache = {};
		searchQuery = '';
		sortKey = 'most-mentions';
		selectedDid = null;
		profile = nextProfile;
		summary = null;
		repoLoadStats = createInitialRepoLoadStats();
		initialHandle = nextProfile.handle;
		updateHandleQuery(nextProfile.handle);

		try {
			progress = { phase: 'Downloading repository…', current: 0, total: 0 };
			const download = await downloadRepoCar(nextProfile.did, {
				signal,
				onDownloadProgress: (downloadProgress) => {
					if (token !== loadToken) return;
					const detailParts = [
						`${formatBytes(downloadProgress.receivedBytes)}${downloadProgress.totalBytes > 0 ? ` / ${formatBytes(downloadProgress.totalBytes)}` : ''}`
					];
					if (downloadProgress.bytesPerSecond > 0) {
						detailParts.push(formatSpeed(downloadProgress.bytesPerSecond));
					}
					if (downloadProgress.elapsedMs > 0) {
						detailParts.push(`${formatDuration(downloadProgress.elapsedMs)} elapsed`);
					}
					progress = {
						phase: 'Downloading repository…',
						current: downloadProgress.totalBytes > 0
							? Math.round((downloadProgress.receivedBytes / downloadProgress.totalBytes) * 100)
							: 0,
						total: downloadProgress.totalBytes > 0 ? 100 : 0,
						detail: detailParts.join(' · ')
					};
				}
			});
			if (token !== loadToken) return;
			throwIfAborted(signal);

			progress = {
				phase: 'Parsing posts and mentions…',
				current: 0,
				total: 0,
				detail: 'Decoding the CAR in WASM and scanning post records for mention facets.'
			};
			const allRecords = await parseCarRecordsWasm(download.carBytes, (count) => {
				if (token !== loadToken) return;
				progress = {
					phase: 'Parsing posts and mentions…',
					current: count,
					total: 0,
					detail: `${count.toLocaleString()} repo records extracted from the CAR snapshot`
				};
			});
			if (token !== loadToken) return;
			throwIfAborted(signal);

			const postRecords = allRecords.filter((record) => record.collection === POST_COLLECTION);
			const nextSummary = extractRepoMentions(nextProfile.did, postRecords);
			if (token !== loadToken) return;

			summary = nextSummary;
			selectedDid = null;
			repoLoadStats = {
				source: download.source,
				elapsedMs: download.elapsedMs,
				downloadedBytes: download.downloadedBytes,
				totalRecords: allRecords.length
			};

			void hydrateMentionedProfiles(nextSummary.users, token);
		} catch (err: any) {
			if (token !== loadToken || err?.name === 'AbortError') return;
			error = err?.message || `Could not build mentions for @${nextProfile.handle}.`;
		} finally {
			if (token === loadToken) {
				loading = false;
			}
		}
	}

	async function loadFromHandle(rawHandle: string): Promise<void> {
		const nextHandle = rawHandle.replace(/^@/, '').trim();
		if (!nextHandle) return;

		error = null;
		try {
			progress = { phase: 'Resolving profile…', current: 0, total: 0 };
			const nextProfile = await getProfile(nextHandle);
			await loadMentions(nextProfile);
		} catch (err: any) {
			error = err?.message || `Could not resolve @${nextHandle}.`;
			profile = null;
			summary = null;
			mentionedProfiles = {};
			threadCache = {};
			searchQuery = '';
			selectedDid = null;
			profilesError = null;
			loadingProfiles = false;
			repoLoadStats = createInitialRepoLoadStats();
			loading = false;
			updateHandleQuery(nextHandle);
		}
	}

	function handleFontChange(key: string): void {
		fontKey = key;
		try {
			localStorage.setItem('preferred-font', key);
		} catch {
			// Ignore local storage failures.
		}
	}

	function handleProfileSelected(nextProfile: ProfileInfo): void {
		void loadMentions(nextProfile);
	}

	function rootThreadUrl(entry: MentionThreadEntry): string | null {
		return buildBskyPostUrl(entry.thread.rootUri, entry.thread.rootPost.author.handle);
	}

	onMount(() => {
		try {
			const saved = localStorage.getItem('preferred-font');
			if (saved && saved in fontFamilies) {
				fontKey = saved;
			}
		} catch {
			// Ignore local storage failures.
		}

		const params = new URLSearchParams(window.location.search);
		const handle = params.get('handle')?.trim() ?? '';
		if (handle) {
			initialHandle = handle;
			void loadFromHandle(handle);
		}
	});

	$effect(() => {
		if (!browser) return;
		const user = selectedUser;
		if (!user) return;
		void ensureThreadsHydrated(user);
	});
</script>

<svelte:head>
	<title>Mentions</title>
</svelte:head>

<main style="font-family: {fontFamily}">
	<header class="page-header">
		<RouteNav current="mentions" align="center" handle={profile?.handle ?? initialHandle ?? null} />
		<h1>Mentions</h1>
		<p class="subtitle">
			Download one public Bluesky repo, list every account this user has mentioned, and open the
			full threads where each mention happened.
		</p>
		<FontPicker value={fontKey} onchange={handleFontChange} />
	</header>

	<section class="lookup-panel wobbly-border-light">
		<SearchBar
			onsearch={loadFromHandle}
			onprofile={handleProfileSelected}
			disabled={loading}
			{initialHandle}
			placeholder="Search any public Bluesky user..."
			buttonLabel="Find Mentions"
		/>
		<p class="lookup-note">
			This page stays frontend-only. It downloads the repo CAR in the browser, scans every post for
			mention facets, and groups them by mentioned account locally. Appview lookups only hydrate the
			mentioned handles and the threads of the account you select.
		</p>
	</section>

	{#if error}
		<div class="error-wrap">
			<ErrorBanner message={error} />
		</div>
	{/if}

	{#if loading}
		<div class="loading-wrap">
			<LoadingSpinner {progress} />
		</div>
	{/if}

	{#if profile && summary}
		<section class="hero-card wobbly-border-light">
			<div class="hero-profile">
				{#if profile.avatar}
					<img class="hero-avatar" src={profile.avatar} alt="" />
				{:else}
					<div class="hero-avatar placeholder"></div>
				{/if}
				<div class="hero-copy">
					<p class="eyebrow">Mention snapshot for</p>
					<h2>{profile.displayName || profile.handle}</h2>
					<p class="hero-handle">@{profile.handle}</p>
				</div>
			</div>
			<div class="hero-stats">
				<div class="stat-chip">
					<span class="stat-label">Accounts mentioned</span>
					<strong>{summary.uniqueMentionedUsers.toLocaleString()}</strong>
				</div>
				<div class="stat-chip">
					<span class="stat-label">Posts with mentions</span>
					<strong>{summary.postsWithMentions.toLocaleString()}</strong>
				</div>
				<div class="stat-chip">
					<span class="stat-label">Total mentions</span>
					<strong>{summary.totalMentionInstances.toLocaleString()}</strong>
				</div>
				<div class="stat-chip">
					<span class="stat-label">Posts scanned</span>
					<strong>{summary.scannedPosts.toLocaleString()}</strong>
				</div>
				<div class="stat-chip">
					<span class="stat-label">Resolved handles</span>
					<strong>{resolvedHandleCount.toLocaleString()}</strong>
				</div>
				<div class="stat-chip">
					<span class="stat-label">Repo records</span>
					<strong>{repoLoadStats.totalRecords.toLocaleString()}</strong>
				</div>
			</div>
			<div class="hero-meta">
				{#if repoLoadStats.source}
					<span>
						Loaded via {repoLoadStats.source === 'pds' ? 'PDS' : 'relay'} in {formatDuration(repoLoadStats.elapsedMs)}
						from {formatBytes(repoLoadStats.downloadedBytes)}
					</span>
				{/if}
				{#if loadingProfiles}
					<span>Resolving mentioned handles from the public Bluesky API…</span>
				{/if}
				{#if profilesError}
					<span>{profilesError}</span>
				{/if}
				<span>Mentions come from the current repo snapshot, so deleted posts are not counted here.</span>
			</div>
		</section>

		{#if summary.uniqueMentionedUsers === 0}
			<section class="note-card wobbly-border-light">
				<h3>No Mentions In Repo</h3>
				<p>
					This account&apos;s current repo snapshot has no posts with
					<code>app.bsky.richtext.facet#mention</code> facets, so there is nothing to list.
				</p>
			</section>
		{:else}
			<section class="mention-workspace">
				<aside class="mention-list-card wobbly-border-light">
					<div class="panel-head">
						<div>
							<p class="card-kicker">Mentioned Accounts</p>
							<h3>Choose an account</h3>
						</div>
						<span class="candidate-pill">{summary.uniqueMentionedUsers.toLocaleString()} total</span>
					</div>
					<p class="card-hint">
						Click any account to load the threads where {profile.displayName || `@${profile.handle}`}
						mentioned them.
					</p>

					<div class="mention-controls">
						<input
							class="mention-search-input"
							type="search"
							bind:value={searchQuery}
							placeholder="Search mentioned handles, names, or DIDs…"
							aria-label="Search mentioned accounts"
						/>
						<label class="mention-sort-block">
							<span>Sort accounts</span>
							<select class="mention-sort-select" bind:value={sortKey}>
								<option value="most-mentions">Most mentions</option>
								<option value="latest-mention">Latest mention</option>
								<option value="earliest-mention">Earliest mention</option>
								<option value="handle">Handle A-Z</option>
							</select>
						</label>
						<p class="mention-search-meta">
							Showing {filteredUserCount.toLocaleString()} of {summary.uniqueMentionedUsers.toLocaleString()} accounts. Handles work with or without `@`.
						</p>
					</div>

					<div class="mention-list">
						{#if sortedEntries.length > 0}
							{#each sortedEntries as entry (entry.user.did)}
								{@const active = selectedUser?.did === entry.user.did}
								<button
									type="button"
									class="mention-row"
									class:active
									aria-pressed={active}
									onclick={() => {
										selectedDid = entry.user.did;
									}}
								>
									<div class="mention-row-main">
										{#if entry.profile?.avatar}
											<img class="mention-avatar" src={entry.profile.avatar} alt="" />
										{:else}
											<div class="mention-avatar placeholder"></div>
										{/if}
										<div class="mention-row-copy">
											<strong>{userPrimaryLabel(entry.profile, entry.user.did)}</strong>
											<span>{userSecondaryLabel(entry.profile, entry.user.did)}</span>
											<span class="mention-row-meta">
												Last mentioned {formatDateTime(entry.user.lastMentionedAt)}
											</span>
										</div>
									</div>
									<div class="mention-row-side">
										<span class="match-pill">{entry.user.mentionPostCount.toLocaleString()}</span>
										<span class="mention-row-kind-count">
											{entry.user.mentionPostCount === 1 ? 'post' : 'posts'}
										</span>
									</div>
								</button>
							{/each}
						{:else}
							<p class="empty-list-state">No mentioned accounts match that search yet.</p>
						{/if}
					</div>
				</aside>

				<section class="detail-column">
					{#if selectedUser}
						<article class="selected-user-card wobbly-border-light">
							<div class="selected-user-head">
								<div class="selected-user-profile">
									{#if selectedProfile?.avatar}
										<img class="hero-avatar" src={selectedProfile.avatar} alt="" />
									{:else}
										<div class="hero-avatar placeholder"></div>
									{/if}
									<div class="hero-copy">
										<p class="eyebrow">Threads where they were mentioned</p>
										<h2>
											{selectedProfile?.displayName ||
												userPrimaryLabel(selectedProfile, selectedUser.did)}
										</h2>
										<p class="hero-handle">{userPrimaryLabel(selectedProfile, selectedUser.did)}</p>
									</div>
								</div>
								<div class="selected-user-side">
									<span class="candidate-pill">
										{selectedUser.mentionPostCount.toLocaleString()} mentioning posts
									</span>
									{#if selectedProfile?.handle}
										<a
											class="action-link"
											href={`https://bsky.app/profile/${encodeURIComponent(selectedProfile.handle)}`}
											target="_blank"
											rel="noreferrer"
										>
											Open profile
										</a>
									{/if}
								</div>
							</div>
							<div class="selected-user-stats">
								<div class="stat-chip compact">
									<span class="stat-label">Mentioning posts</span>
									<strong>{selectedUser.mentionPostCount.toLocaleString()}</strong>
								</div>
								<div class="stat-chip compact">
									<span class="stat-label">Total mentions</span>
									<strong>{selectedUser.mentionInstanceCount.toLocaleString()}</strong>
								</div>
								<div class="stat-chip compact">
									<span class="stat-label">First mention</span>
									<strong>{formatDateTime(selectedUser.firstMentionedAt)}</strong>
								</div>
								<div class="stat-chip compact">
									<span class="stat-label">Latest mention</span>
									<strong>{formatDateTime(selectedUser.lastMentionedAt)}</strong>
								</div>
							</div>
							{#if selectedThreadState?.loading}
								<p class="selected-user-hydration">{selectedThreadState.progressLabel}</p>
							{/if}
							{#if selectedThreadState?.error}
								<p class="selected-user-hydration error">{selectedThreadState.error}</p>
							{/if}
							{#if selectedThreadState?.loaded && selectedThreadState.totalThreadCount > selectedThreadState.threads.length}
								<p class="selected-user-hydration">
									Showing {selectedThreadState.threads.length.toLocaleString()} of
									{selectedThreadState.totalThreadCount.toLocaleString()} threads (newest mentions first).
								</p>
							{/if}
						</article>

						{#if selectedThreadState?.loaded && selectedThreadState.threads.length > 0}
							<section class="thread-list">
								{#each selectedThreadState.threads as entry (entry.rootUri)}
									<article class="thread-card wobbly-border-light">
										<div class="thread-card-head">
											<div>
												<p class="card-kicker">Thread</p>
												<span class="thread-card-meta">
													{entry.mentionPostUris.length.toLocaleString()} mentioning
													{entry.mentionPostUris.length === 1 ? 'post' : 'posts'} · latest
													{formatDateTime(entry.latestMentionAt)}
												</span>
											</div>
											{#if rootThreadUrl(entry)}
												<a
													class="action-link"
													href={rootThreadUrl(entry) ?? undefined}
													target="_blank"
													rel="noreferrer"
												>
													Open on Bluesky
												</a>
											{/if}
										</div>
										{#if entry.thread.isTruncated}
											<p class="thread-truncation">Some replies in this thread may be missing.</p>
										{/if}
										<div class="thread-chat">
											<GroupChat thread={entry.thread} />
										</div>
									</article>
								{/each}
							</section>
						{:else if selectedThreadState?.loaded && !selectedThreadState.error}
							<section class="note-card wobbly-border-light">
								<h3>No Threads Loaded</h3>
								<p>
									The mentioning posts could not be resolved into threads from the appview. They may
									have been deleted or are not publicly visible.
								</p>
							</section>
						{/if}
					{/if}
				</section>
			</section>
		{/if}
	{/if}
</main>

<style>
	main {
		max-width: 1240px;
		margin: 0 auto;
		padding: 28px 18px 56px;
	}

	.page-header {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 14px;
		text-align: center;
		margin-bottom: 26px;
	}

	h1 {
		margin: 0;
		font-size: clamp(2.1rem, 5vw, 3.6rem);
	}

	.subtitle {
		max-width: 760px;
		margin: 0;
		color: var(--muted);
		line-height: 1.55;
	}

	.lookup-panel,
	.hero-card,
	.note-card,
	.mention-list-card,
	.selected-user-card,
	.thread-card {
		background: var(--panel-bg);
	}

	.lookup-panel {
		display: grid;
		gap: 14px;
		padding: 22px;
		margin-bottom: 22px;
	}

	.lookup-note {
		margin: 0;
		color: var(--muted);
		line-height: 1.5;
	}

	.error-wrap,
	.loading-wrap {
		margin-bottom: 22px;
	}

	.hero-card {
		display: grid;
		gap: 20px;
		padding: 24px;
		margin-bottom: 24px;
	}

	.hero-profile,
	.selected-user-profile {
		display: flex;
		align-items: center;
		gap: 16px;
	}

	.hero-avatar,
	.mention-avatar {
		background: var(--input-bg);
		object-fit: cover;
	}

	.hero-avatar {
		width: 76px;
		height: 76px;
		border-radius: 22px;
	}

	.mention-avatar {
		width: 44px;
		height: 44px;
		border-radius: 14px;
		flex: 0 0 auto;
	}

	.hero-avatar.placeholder,
	.mention-avatar.placeholder {
		background: linear-gradient(135deg, rgba(244, 216, 132, 0.55), rgba(233, 126, 77, 0.28));
	}

	.hero-copy {
		display: grid;
		gap: 6px;
		text-align: left;
		min-width: 0;
	}

	.eyebrow,
	.hero-handle {
		margin: 0;
		color: var(--muted);
	}

	.hero-copy h2 {
		margin: 0;
		font-size: clamp(1.6rem, 4vw, 2.4rem);
		word-break: break-word;
	}

	.hero-stats {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
		gap: 12px;
	}

	.stat-chip {
		display: grid;
		gap: 6px;
		padding: 14px 16px;
		border-radius: 18px;
		background: var(--panel-bg-muted);
		border: 1px solid var(--warm-border);
		box-shadow: inset 0 1px 0 color-mix(in srgb, var(--card-bg) 70%, transparent);
	}

	.stat-chip.compact {
		min-width: 132px;
		padding: 12px 14px;
	}

	.stat-label {
		font-size: 0.8rem;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: var(--muted);
	}

	.stat-chip strong {
		font-size: 1.35rem;
	}

	.hero-meta {
		display: flex;
		flex-wrap: wrap;
		gap: 10px 18px;
		color: var(--muted);
		font-size: 0.95rem;
	}

	.mention-workspace {
		display: grid;
		grid-template-columns: minmax(280px, 340px) minmax(0, 1fr);
		gap: 18px;
		align-items: start;
	}

	.mention-list-card,
	.selected-user-card {
		display: grid;
		gap: 16px;
		padding: 20px;
	}

	.mention-list-card {
		position: sticky;
		top: 18px;
	}

	.panel-head,
	.selected-user-head,
	.thread-card-head {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 10px;
	}

	.panel-head h3 {
		margin: 0;
	}

	.detail-column {
		display: grid;
		gap: 18px;
		min-width: 0;
	}

	.selected-user-side {
		display: grid;
		gap: 10px;
		justify-items: end;
	}

	.selected-user-hydration {
		margin: 0;
		padding: 12px 14px;
		border-radius: 16px;
		background: var(--panel-bg-muted);
		border: 1px solid var(--warm-border);
		color: var(--muted);
		line-height: 1.5;
	}

	.selected-user-hydration.error {
		border-color: rgba(189, 72, 55, 0.22);
		color: var(--danger-text);
		background: var(--error-bg);
	}

	.selected-user-stats {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
		gap: 12px;
	}

	.mention-controls {
		display: grid;
		gap: 12px;
	}

	.mention-sort-block {
		display: grid;
		gap: 6px;
		font-size: 0.88rem;
		color: var(--muted);
	}

	.mention-sort-select,
	.mention-search-input {
		width: 100%;
		padding: 11px 13px;
		border-radius: 14px;
		border: 1px solid var(--warm-border);
		background: var(--input-bg);
		color: var(--text-ink);
		font: inherit;
		box-shadow: inset 0 1px 0 color-mix(in srgb, var(--card-bg) 70%, transparent);
	}

	.mention-sort-select:focus,
	.mention-search-input:focus {
		outline: 2px solid rgba(224, 122, 95, 0.22);
		outline-offset: 2px;
		border-color: rgba(224, 122, 95, 0.4);
	}

	.mention-search-meta {
		margin: 0;
		font-size: 0.88rem;
		color: var(--muted);
	}

	.mention-list {
		display: grid;
		gap: 10px;
		max-height: 72vh;
		overflow: auto;
		padding-right: 4px;
	}

	.mention-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		width: 100%;
		padding: 12px 14px;
		border-radius: 18px;
		border: 1px solid var(--warm-border);
		background: var(--panel-bg-plain);
		color: inherit;
		cursor: pointer;
		text-align: left;
		transition:
			transform 0.16s ease,
			border-color 0.16s ease,
			background 0.16s ease,
			box-shadow 0.16s ease;
	}

	.mention-row:hover {
		transform: translateY(-1px);
		border-color: rgba(224, 122, 95, 0.3);
		box-shadow: 0 10px 24px rgba(26, 35, 44, 0.08);
	}

	.mention-row.active {
		background: var(--active-bg);
		border-color: rgba(224, 122, 95, 0.38);
		box-shadow: 0 0 0 2px rgba(224, 122, 95, 0.08);
	}

	.mention-row-main {
		display: flex;
		align-items: center;
		gap: 12px;
		min-width: 0;
	}

	.mention-row-copy {
		display: grid;
		gap: 4px;
		min-width: 0;
	}

	.mention-row-side {
		display: grid;
		gap: 5px;
		justify-items: end;
		flex: 0 0 auto;
	}

	.mention-row-copy strong,
	.mention-row-copy span {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.mention-row-copy strong {
		font-size: 1rem;
	}

	.mention-row-copy span {
		font-size: 0.85rem;
		color: var(--muted);
	}

	.mention-row-meta {
		font-size: 0.78rem;
		color: var(--muted);
	}

	.mention-row-kind-count {
		font-size: 0.76rem;
		color: var(--muted);
	}

	.empty-list-state {
		margin: 0;
		padding: 14px;
		border-radius: 16px;
		background: var(--panel-bg-muted);
		border: 1px dashed var(--warm-border);
		color: var(--muted);
		line-height: 1.5;
		text-align: center;
	}

	.match-pill,
	.candidate-pill {
		display: inline-flex;
		align-items: center;
		padding: 7px 10px;
		border-radius: 999px;
		background: color-mix(in srgb, var(--accent) 14%, var(--card-bg));
		color: var(--warm-text);
		font-size: 0.82rem;
		font-weight: 700;
		white-space: nowrap;
	}

	.selected-user-card {
		gap: 16px;
	}

	.card-kicker {
		display: inline-flex;
		margin: 0 0 6px;
		font-size: 0.78rem;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: var(--warm-text);
	}

	.card-hint,
	.note-card p {
		margin: 0;
		line-height: 1.55;
		color: var(--muted);
	}

	.thread-list {
		display: grid;
		gap: 18px;
	}

	.thread-card {
		display: grid;
		gap: 14px;
		padding: 18px;
	}

	.thread-card-meta {
		font-size: 0.85rem;
		color: var(--muted);
	}

	.thread-truncation {
		margin: 0;
		padding: 8px 12px;
		border-radius: 12px;
		background: var(--panel-bg-muted);
		border: 1px dashed var(--warm-border);
		color: var(--muted);
		font-size: 0.85rem;
	}

	.thread-chat {
		min-width: 0;
	}

	.action-link {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font-size: 0.88rem;
		font-weight: 700;
		color: var(--warm-text);
		text-decoration: none;
		white-space: nowrap;
	}

	.action-link:hover {
		text-decoration: underline;
	}

	.note-card {
		padding: 22px;
	}

	.note-card h3 {
		margin: 0 0 10px;
	}

	code {
		font-family: 'IBM Plex Mono', 'SFMono-Regular', ui-monospace, monospace;
		font-size: 0.92em;
	}

	@media (max-width: 920px) {
		.mention-workspace {
			grid-template-columns: minmax(0, 1fr);
		}

		.mention-list-card {
			position: static;
		}

		.selected-user-head {
			flex-direction: column;
		}

		.selected-user-side {
			width: 100%;
			justify-items: start;
		}

		.mention-row-side {
			justify-items: start;
		}
	}

	@media (max-width: 640px) {
		main {
			padding: 22px 14px 44px;
		}

		.hero-profile,
		.selected-user-profile {
			align-items: flex-start;
		}

		.hero-avatar {
			width: 64px;
			height: 64px;
			border-radius: 18px;
		}

		.hero-stats,
		.selected-user-stats {
			grid-template-columns: minmax(0, 1fr);
		}

		.panel-head,
		.thread-card-head {
			flex-direction: column;
		}

		.mention-row {
			padding: 11px 12px;
			align-items: flex-start;
		}
	}
</style>
