<script lang="ts">
	import { onMount } from 'svelte';
	import { browser } from '$app/environment';
	import '../../app.css';
	import type { DiscoverProgress, ThreadPost } from '$lib/types';
	import {
		fetchPostsByUris,
		getProfile,
		getProfiles,
		type ProfileInfo
	} from '$lib/api/bluesky';
	import ErrorBanner from '$lib/components/ErrorBanner.svelte';
	import FontPicker from '$lib/components/FontPicker.svelte';
	import LoadingSpinner from '$lib/components/LoadingSpinner.svelte';
	import PostEmbedPreview from '$lib/components/PostEmbedPreview.svelte';
	import RouteNav from '$lib/components/RouteNav.svelte';
	import SearchBar from '$lib/components/SearchBar.svelte';
	import { parseCarRecordsWasm } from '$lib/utils/carParserWasm';
	import {
		FOLLOW_INTERACTION_KINDS,
		resolveFirstFollowInteractions,
		type FollowInteractionFollowSummary,
		type FollowInteractionKind,
		type FollowInteractionResolveProgress,
		type FollowInteractionSummary,
		type ResolvedFollowInteraction
	} from '$lib/utils/followInteraction';
	import { downloadRepoCar } from '$lib/utils/repoHydration';
	import { buildBskyPostUrl } from '$lib/utils/viewerLinks';

	const TARGET_COLLECTIONS = [
		'app.bsky.feed.post',
		'app.bsky.feed.like',
		'app.bsky.feed.repost',
		'app.bsky.graph.follow'
	];
	const FOLLOW_PROFILE_BATCH_SIZE = 100;

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

	type RepoLoadStats = {
		source: 'pds' | 'relay' | null;
		elapsedMs: number;
		downloadedBytes: number;
		totalRecords: number;
	};

	type FollowSortKey =
		| 'most-interactions'
		| 'most-kinds'
		| 'latest-interaction'
		| 'earliest-interaction'
		| 'newest-follow'
		| 'oldest-follow'
		| 'handle';

	type FollowListEntry = {
		follow: FollowInteractionFollowSummary;
		profile: ProfileInfo | null;
	};

	type FollowListKind = 'all' | FollowInteractionKind;

	type HydratedFollowInteraction = ResolvedFollowInteraction & {
		targetPost: ThreadPost | null;
		sourcePost: ThreadPost | null;
	};

	type FollowDetailCacheEntry = {
		loading: boolean;
		loaded: boolean;
		error: string | null;
		progressLabel: string | null;
		interactions: Record<FollowInteractionKind, HydratedFollowInteraction | null>;
	};

	function createInitialRepoLoadStats(): RepoLoadStats {
		return {
			source: null,
			elapsedMs: 0,
			downloadedBytes: 0,
			totalRecords: 0
		};
	}

	function throwIfAborted(signal: AbortSignal): void {
		if (signal.aborted) {
			throw new DOMException('Aborted', 'AbortError');
		}
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

	function truncateText(text: string, maxLength = 320): string {
		const normalized = text.replace(/\s+/g, ' ').trim();
		if (normalized.length <= maxLength) return normalized;
		return `${normalized.slice(0, maxLength - 1).trimEnd()}…`;
	}

	function createKindMap<T>(factory: () => T): Record<FollowInteractionKind, T> {
		return {
			quote: factory(),
			repost: factory(),
			like: factory(),
			reply: factory()
		};
	}

	function createEmptyFollowDetailEntry(): FollowDetailCacheEntry {
		return {
			loading: false,
			loaded: false,
			error: null,
			progressLabel: null,
			interactions: createKindMap<HydratedFollowInteraction | null>(() => null)
		};
	}

	function formatResolveProgress(progress: FollowInteractionResolveProgress): string {
		const kindLabel = interactionLabel(progress.kind).toLowerCase();
		const currentKind = progress.currentKind.toLocaleString();
		const totalKind = progress.totalKind.toLocaleString();
		const resolvedFollows = progress.resolvedFollows.toLocaleString();
		const totalFollows = progress.totalFollows.toLocaleString();
		return `${currentKind} / ${totalKind} ${kindLabel} candidates scanned, ${resolvedFollows} / ${totalFollows} follows matched`;
	}

	function shortenDid(did: string): string {
		if (did.length <= 22) return did;
		return `${did.slice(0, 16)}…${did.slice(-6)}`;
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

	function interactionTargetUrl(
		interaction: ResolvedFollowInteraction,
		targetPost?: ThreadPost | null
	): string | null {
		if (targetPost) {
			return buildBskyPostUrl(targetPost.uri, targetPost.author.handle);
		}
		return buildBskyPostUrl(interaction.targetUri);
	}

	function interactionSourceUrl(
		interaction: ResolvedFollowInteraction,
		sourcePost?: ThreadPost | null
	): string | null {
		if (!interaction.sourceUri) return null;
		return sourcePost
			? buildBskyPostUrl(sourcePost.uri, sourcePost.author.handle)
			: buildBskyPostUrl(interaction.sourceUri, profile?.handle ?? null);
	}

	function interactionLabel(kind: FollowInteractionKind): string {
		if (kind === 'quote') return 'Quote';
		if (kind === 'repost') return 'Repost';
		if (kind === 'like') return 'Like';
		return 'Reply';
	}

	function interactionHint(kind: FollowInteractionKind): string {
		if (kind === 'quote') return 'Quote-post stats from repo records that target this followed account.';
		if (kind === 'repost') return 'Repost stats from repo records that point at this followed account.';
		if (kind === 'like') return 'Like stats from repo records that point at this followed account.';
		return 'Reply stats where the parent post belongs to this followed account.';
	}

	function emptyHint(kind: FollowInteractionKind): string {
		if (kind === 'quote') return 'No current quote-post of this followed account was found in the repo snapshot.';
		if (kind === 'repost') return 'No current repost of this followed account was found in the repo snapshot.';
		if (kind === 'like') return 'No current like of this followed account was found in the repo snapshot.';
		return 'No reply to this followed account was found in the repo snapshot.';
	}

	function interactionListOptionLabel(kind: FollowListKind): string {
		if (kind === 'all') return 'All follows';
		if (kind === 'like') return 'Oldest like';
		if (kind === 'reply') return 'Oldest reply';
		if (kind === 'quote') return 'Oldest quote';
		return 'Oldest repost';
	}

	function followPrimaryLabel(profile: ProfileInfo | null, did: string): string {
		return profile?.handle ? `@${profile.handle}` : shortenDid(did);
	}

	function followSecondaryLabel(profile: ProfileInfo | null, did: string): string {
		if (profile?.displayName?.trim()) return profile.displayName;
		return did;
	}

	function normalizeSearchText(value: string): string {
		return value.trim().toLowerCase();
	}

	function normalizeHandleSearchText(value: string): string {
		return normalizeSearchText(value).replace(/^@+/, '');
	}

	function compareFollowEntries(
		a: FollowListEntry,
		b: FollowListEntry,
		sortKey: FollowSortKey
	): number {
		const labelA = normalizeHandleSearchText(a.profile?.handle ?? a.follow.did);
		const labelB = normalizeHandleSearchText(b.profile?.handle ?? b.follow.did);

		if (sortKey === 'most-interactions') {
			return (
				b.follow.totalInteractionCount - a.follow.totalInteractionCount ||
				b.follow.matchedKindCount - a.follow.matchedKindCount ||
				labelA.localeCompare(labelB)
			);
		}

		if (sortKey === 'most-kinds') {
			return (
				b.follow.matchedKindCount - a.follow.matchedKindCount ||
				b.follow.totalInteractionCount - a.follow.totalInteractionCount ||
				labelA.localeCompare(labelB)
			);
		}

		if (sortKey === 'latest-interaction') {
			return (
				compareNullableDate(a.follow.latestInteractionAt, b.follow.latestInteractionAt, 'desc') ||
				b.follow.totalInteractionCount - a.follow.totalInteractionCount ||
				labelA.localeCompare(labelB)
			);
		}

		if (sortKey === 'earliest-interaction') {
			return (
				compareNullableDate(a.follow.firstInteractionAt, b.follow.firstInteractionAt, 'asc') ||
				b.follow.totalInteractionCount - a.follow.totalInteractionCount ||
				labelA.localeCompare(labelB)
			);
		}

		if (sortKey === 'newest-follow') {
			return (
				compareNullableDate(a.follow.followedAt, b.follow.followedAt, 'desc') ||
				labelA.localeCompare(labelB)
			);
		}

		if (sortKey === 'oldest-follow') {
			return (
				compareNullableDate(a.follow.followedAt, b.follow.followedAt, 'asc') ||
				labelA.localeCompare(labelB)
			);
		}

		return labelA.localeCompare(labelB);
	}

	function compareFollowEntriesByKind(
		a: FollowListEntry,
		b: FollowListEntry,
		kind: FollowInteractionKind
	): number {
		const labelA = normalizeHandleSearchText(a.profile?.handle ?? a.follow.did);
		const labelB = normalizeHandleSearchText(b.profile?.handle ?? b.follow.did);
		return (
			compareNullableDate(
				a.follow.interactions[kind]?.createdAt,
				b.follow.interactions[kind]?.createdAt,
				'asc'
			) ||
			b.follow.totalInteractionCount - a.follow.totalInteractionCount ||
			labelA.localeCompare(labelB)
		);
	}

	let fontKey = $state('patrick');
	let fontFamily = $derived(fontFamilies[fontKey] ?? fontFamilies.virgil);
	let initialHandle = $state('');
	let profile = $state<ProfileInfo | null>(null);
	let summary = $state<FollowInteractionSummary | null>(null);
	let loading = $state(false);
	let loadingFollowProfiles = $state(false);
	let error = $state<string | null>(null);
	let followProfilesError = $state<string | null>(null);
	let progress = $state<DiscoverProgress>({
		phase: 'Resolving profile…',
		current: 0,
		total: 0
	});
	let repoLoadStats = $state<RepoLoadStats>(createInitialRepoLoadStats());
	let followProfiles = $state<Record<string, ProfileInfo>>({});
	let followSearchQuery = $state('');
	let followListKind = $state<FollowListKind>('all');
	let followSortKey = $state<FollowSortKey>('most-interactions');
	let selectedFollowDid = $state<string | null>(null);
	let loadController: AbortController | null = null;
	let loadToken = 0;
	let followDetailCache = $state<Record<string, FollowDetailCacheEntry>>({});

	let followEntries = $derived.by<FollowListEntry[]>(() => {
		const currentSummary = summary;
		if (!currentSummary) return [];
		return currentSummary.follows.map((follow) => ({
			follow,
			profile: followProfiles[follow.did] ?? null
		}));
	});

	let filteredFollowEntries = $derived.by<FollowListEntry[]>(() => {
		const query = normalizeHandleSearchText(followSearchQuery);
		if (!query) return followEntries;

		return followEntries.filter((entry) => {
			const handle = normalizeHandleSearchText(entry.profile?.handle ?? '');
			const displayName = normalizeSearchText(entry.profile?.displayName ?? '');
			const did = normalizeSearchText(entry.follow.did);
			return handle.includes(query) || displayName.includes(query) || did.includes(query);
		});
	});

	let listedFollowEntries = $derived.by<FollowListEntry[]>(() => {
		if (followListKind === 'all') return filteredFollowEntries;
		return filteredFollowEntries.filter((entry) => Boolean(entry.follow.interactions[followListKind]));
	});

	let sortedFollowEntries = $derived.by<FollowListEntry[]>(() => {
		const entries = [...listedFollowEntries];
		if (followListKind !== 'all') {
			return entries.sort((a, b) => compareFollowEntriesByKind(a, b, followListKind));
		}
		return entries.sort((a, b) => compareFollowEntries(a, b, followSortKey));
	});

	let selectedFollow = $derived.by<FollowInteractionFollowSummary | null>(() => {
		if (sortedFollowEntries.length === 0) return null;
		return (
			sortedFollowEntries.find((entry) => entry.follow.did === selectedFollowDid)?.follow ??
			sortedFollowEntries[0]?.follow ??
			null
		);
	});

	let selectedFollowProfile = $derived.by<ProfileInfo | null>(() => {
		const follow = selectedFollow;
		return follow ? followProfiles[follow.did] ?? null : null;
	});

	let selectedFollowDetail = $derived.by<FollowDetailCacheEntry | null>(() => {
		const follow = selectedFollow;
		if (!follow) return null;
		return followDetailCache[follow.did] ?? null;
	});

	let matchedFollowCount = $derived.by(() => {
		const currentSummary = summary;
		if (!currentSummary) return 0;
		return currentSummary.follows.filter((follow) => follow.matchedKindCount > 0).length;
	});

	let completeFollowCount = $derived.by(() => {
		const currentSummary = summary;
		if (!currentSummary) return 0;
		return currentSummary.follows.filter(
			(follow) => follow.matchedKindCount === FOLLOW_INTERACTION_KINDS.length
		).length;
	});

	let selectedResolvedCount = $derived.by(() => selectedFollow?.matchedKindCount ?? 0);
	let resolvedHandleCount = $derived.by(() => Object.keys(followProfiles).length);
	let filteredFollowCount = $derived.by(() => sortedFollowEntries.length);

	async function hydrateFollowProfiles(
		follows: FollowInteractionFollowSummary[],
		token: number
	): Promise<void> {
		if (follows.length === 0) {
			followProfiles = {};
			followProfilesError = null;
			loadingFollowProfiles = false;
			return;
		}

		loadingFollowProfiles = true;
		followProfilesError = null;
		const nextProfiles: Record<string, ProfileInfo> = {};
		const dids = follows.map((follow) => follow.did);

		try {
			for (let index = 0; index < dids.length; index += FOLLOW_PROFILE_BATCH_SIZE) {
				const batch = dids.slice(index, index + FOLLOW_PROFILE_BATCH_SIZE);
				const profiles = await getProfiles(batch);
				if (token !== loadToken) return;

				for (const followProfile of profiles) {
					nextProfiles[followProfile.did] = followProfile;
				}

				followProfiles = { ...nextProfiles };
			}
		} catch (err: any) {
			if (token !== loadToken) return;
			followProfilesError =
				err?.message || 'Could not resolve every follow handle from the public API.';
			followProfiles = { ...nextProfiles };
		} finally {
			if (token === loadToken) {
				loadingFollowProfiles = false;
			}
		}
	}

	async function ensureFollowDetailHydrated(follow: FollowInteractionFollowSummary): Promise<void> {
		const token = loadToken;
		const existing = followDetailCache[follow.did];
		if (existing?.loading || existing?.loaded) return;

		const updateEntry = (updates: Partial<FollowDetailCacheEntry>) => {
			if (token !== loadToken) return;
			const current = followDetailCache[follow.did] ?? createEmptyFollowDetailEntry();
			followDetailCache = {
				...followDetailCache,
				[follow.did]: {
					...current,
					...updates
				}
			};
		};

		updateEntry({
			loading: true,
			loaded: false,
			error: null,
			progressLabel: 'Loading first source and target posts from appview…',
			interactions: createKindMap<HydratedFollowInteraction | null>(() => null)
		});

		const uris = [
			...new Set(
				FOLLOW_INTERACTION_KINDS.flatMap((kind) => {
					const interaction = follow.interactions[kind];
					if (!interaction) return [];
					return interaction.sourceUri
						? [interaction.targetUri, interaction.sourceUri]
						: [interaction.targetUri];
				})
			)
		];

		if (uris.length === 0) {
			updateEntry({
				loading: false,
				loaded: true,
				progressLabel: null
			});
			return;
		}

		try {
			const postsByUri = await fetchPostsByUris(uris, {
				onProgress: (hydrateProgress) => {
					updateEntry({
						progressLabel: `${hydrateProgress.completed.toLocaleString()} / ${hydrateProgress.total.toLocaleString()} posts loaded from appview`
					});
				}
			});
			if (token !== loadToken) return;

			const hydratedInteractions = createKindMap<HydratedFollowInteraction | null>(() => null);
			for (const kind of FOLLOW_INTERACTION_KINDS) {
				const interaction = follow.interactions[kind];
				if (!interaction) continue;
				hydratedInteractions[kind] = {
					...interaction,
					targetPost: postsByUri.get(interaction.targetUri) ?? null,
					sourcePost: interaction.sourceUri ? postsByUri.get(interaction.sourceUri) ?? null : null
				};
			}

			updateEntry({
				loading: false,
				loaded: true,
				error: null,
				progressLabel: null,
				interactions: hydratedInteractions
			});
		} catch (err: any) {
			updateEntry({
				loading: false,
				loaded: false,
				error: err?.message || 'Could not load the first interaction posts from appview.',
				progressLabel: null
			});
		}
	}

	async function loadInteractionSummary(nextProfile: ProfileInfo): Promise<void> {
		const token = ++loadToken;
		loadController?.abort();
		loadController = new AbortController();
		const signal = loadController.signal;

		loading = true;
		error = null;
		followProfilesError = null;
		loadingFollowProfiles = false;
		followProfiles = {};
		followDetailCache = {};
		followSearchQuery = '';
		followListKind = 'all';
		selectedFollowDid = null;
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
					if (downloadProgress.totalBytes > 0) {
						progress = {
							phase: 'Downloading repository…',
							current: Math.round((downloadProgress.receivedBytes / downloadProgress.totalBytes) * 100),
							total: 100,
							detail: detailParts.join(' · ')
						};
						return;
					}

					progress = {
						phase: 'Downloading repository…',
						current: 0,
						total: 0,
						detail: detailParts.join(' · ')
					};
				}
			});
			if (token !== loadToken) return;
			throwIfAborted(signal);

			progress = {
				phase: 'Parsing follows and interactions…',
				current: 0,
				total: 0,
				detail: 'Decoding the CAR in WASM and extracting follow, like, repost, and post records.'
			};
			const allRecords = await parseCarRecordsWasm(download.carBytes, (count) => {
				if (token !== loadToken) return;
				progress = {
					phase: 'Parsing follows and interactions…',
					current: count,
					total: 0,
					detail: `${count.toLocaleString()} repo records extracted from the CAR snapshot`
				};
			});
			const records = allRecords.filter((record) => TARGET_COLLECTIONS.includes(record.collection));
			if (token !== loadToken) return;
			throwIfAborted(signal);

			progress = {
				phase: 'Resolving first follow interactions…',
				current: 0,
				total: 0,
				detail: 'Scanning the repo locally to count likes, reposts, quotes, and replies for each followed account.'
			};
			const nextSummary = await resolveFirstFollowInteractions(nextProfile.did, records, {
				onProgress: (resolveProgress) => {
					if (token !== loadToken) return;
					progress = {
						phase: `Scanning ${interactionLabel(resolveProgress.kind).toLowerCase()} targets…`,
						current: resolveProgress.current,
						total: resolveProgress.total,
						detail: formatResolveProgress(resolveProgress)
					};
				}
			});
			if (token !== loadToken) return;

			summary = nextSummary;
			selectedFollowDid = null;
			repoLoadStats = {
				source: download.source,
				elapsedMs: download.elapsedMs,
				downloadedBytes: download.downloadedBytes,
				totalRecords: records.length
			};

			void hydrateFollowProfiles(nextSummary.follows, token);
		} catch (err: any) {
			if (token !== loadToken || err?.name === 'AbortError') return;
			error = err?.message || `Could not build follow interactions for @${nextProfile.handle}.`;
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
			await loadInteractionSummary(nextProfile);
		} catch (err: any) {
			error = err?.message || `Could not resolve @${nextHandle}.`;
			profile = null;
			summary = null;
			followProfiles = {};
			followDetailCache = {};
			followSearchQuery = '';
			followListKind = 'all';
			selectedFollowDid = null;
			followProfilesError = null;
			loadingFollowProfiles = false;
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
		void loadInteractionSummary(nextProfile);
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
		const follow = selectedFollow;
		if (!follow) return;
		void ensureFollowDetailHydrated(follow);
	});
</script>

<svelte:head>
	<title>Follow Interaction</title>
</svelte:head>

<main style="font-family: {fontFamily}">
	<header class="page-header">
		<RouteNav current="followinteraction" align="center" handle={profile?.handle ?? initialHandle ?? null} />
		<h1>Follow Interaction</h1>
		<p class="subtitle">
			Download one public Bluesky repo, list every followed account on the left, and inspect
			stats for likes, reposts, quotes, and replies that point at each follow.
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
			buttonLabel="Find Follow Interactions"
		/>
		<p class="lookup-note">
			This page stays frontend-only. It downloads the repo CAR in the browser, parses follows plus
			interaction records, and calculates per-follow interaction stats locally. The extra appview
			lookups only hydrate follow handles plus the first source and target posts for the follow you
			select.
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
					<p class="eyebrow">Current follow snapshot for</p>
					<h2>{profile.displayName || profile.handle}</h2>
					<p class="hero-handle">@{profile.handle}</p>
				</div>
			</div>
			<div class="hero-stats">
				<div class="stat-chip">
					<span class="stat-label">Active follows</span>
					<strong>{summary.followsCount.toLocaleString()}</strong>
				</div>
				<div class="stat-chip">
					<span class="stat-label">Follows with matches</span>
					<strong>{matchedFollowCount.toLocaleString()}</strong>
				</div>
				<div class="stat-chip">
					<span class="stat-label">Full 4-kind matches</span>
					<strong>{completeFollowCount.toLocaleString()}</strong>
				</div>
				<div class="stat-chip">
					<span class="stat-label">Resolved handles</span>
					<strong>{resolvedHandleCount.toLocaleString()}</strong>
				</div>
				<div class="stat-chip">
					<span class="stat-label">Repo records</span>
					<strong>{repoLoadStats.totalRecords.toLocaleString()}</strong>
				</div>
				{#each FOLLOW_INTERACTION_KINDS as kind}
					<div class="stat-chip">
						<span class="stat-label">{interactionLabel(kind)} candidates</span>
						<strong>{summary.candidateCounts[kind].toLocaleString()}</strong>
					</div>
				{/each}
			</div>
			<div class="hero-meta">
				{#if repoLoadStats.source}
					<span>
						Loaded via {repoLoadStats.source === 'pds' ? 'PDS' : 'relay'} in {formatDuration(repoLoadStats.elapsedMs)}
						from {formatBytes(repoLoadStats.downloadedBytes)}
					</span>
				{/if}
				{#if loadingFollowProfiles}
					<span>Resolving followed handles from the public Bluesky API…</span>
				{/if}
				{#if followProfilesError}
					<span>{followProfilesError}</span>
				{/if}
				<span>Interaction stats are repo-snapshot based, so undone likes, reposts, or follows are not visible here.</span>
			</div>
		</section>

		{#if summary.followsCount === 0}
			<section class="note-card wobbly-border-light">
				<h3>No Active Follows In Repo</h3>
				<p>
					This account&apos;s current repo snapshot does not contain any active
					<code>app.bsky.graph.follow</code> records, so the interaction lookup has nothing to match
					against.
				</p>
			</section>
		{:else}
			<section class="follow-workspace">
				<aside class="follow-list-card wobbly-border-light">
					<div class="panel-head">
						<div>
							<p class="card-kicker">Follow Handles</p>
							<h3>Choose a followed account</h3>
						</div>
						<span class="candidate-pill">{matchedFollowCount.toLocaleString()} with matches</span>
					</div>
					<p class="card-hint">
						Click any follow to inspect that person&apos;s interaction counts and first-hit stats from
						the selected repo snapshot.
					</p>

					<div class="follow-controls">
						<div class="follow-search-block">
							<input
								class="follow-search-input"
								type="search"
								bind:value={followSearchQuery}
								placeholder="Search followed handles, names, or DIDs…"
								aria-label="Search follows"
							/>
							<p class="follow-search-meta">
								Showing {filteredFollowCount.toLocaleString()} of {summary.followsCount.toLocaleString()} follows{#if followListKind !== 'all'} with a {interactionLabel(followListKind).toLowerCase()}{/if}. Handles work with or without `@`.
							</p>
						</div>
						<label class="follow-sort-block">
							<span>List by first interaction</span>
							<select class="follow-sort-select" bind:value={followListKind}>
								<option value="all">All follows</option>
								{#each FOLLOW_INTERACTION_KINDS as kind}
									<option value={kind}>{interactionListOptionLabel(kind)}</option>
								{/each}
							</select>
						</label>
						<label class="follow-sort-block">
							<span>Sort follows</span>
							<select class="follow-sort-select" bind:value={followSortKey}>
								<option value="most-interactions">Most interactions</option>
								<option value="most-kinds">Most kinds matched</option>
								<option value="latest-interaction">Latest interaction</option>
								<option value="earliest-interaction">Earliest interaction</option>
								<option value="newest-follow">Newest follow</option>
								<option value="oldest-follow">Oldest follow</option>
								<option value="handle">Handle A-Z</option>
							</select>
						</label>
					</div>

					<div class="follow-list">
						{#if sortedFollowEntries.length > 0}
							{#each sortedFollowEntries as entry}
								{@const active = selectedFollow?.did === entry.follow.did}
								<button
									type="button"
									class="follow-row"
									class:active
									aria-pressed={active}
									onclick={() => {
										selectedFollowDid = entry.follow.did;
									}}
								>
									<div class="follow-row-main">
										{#if entry.profile?.avatar}
											<img class="follow-avatar" src={entry.profile.avatar} alt="" />
										{:else}
											<div class="follow-avatar placeholder"></div>
										{/if}
											<div class="follow-row-copy">
												<strong>{followPrimaryLabel(entry.profile, entry.follow.did)}</strong>
												<span>{followSecondaryLabel(entry.profile, entry.follow.did)}</span>
												<span class="follow-row-meta">
													{#if followListKind !== 'all' && entry.follow.interactions[followListKind]}
														First {interactionLabel(followListKind).toLowerCase()} {formatDateTime(entry.follow.interactions[followListKind]?.createdAt)}
													{:else if entry.follow.firstInteractionAt}
														First interaction {formatDateTime(entry.follow.firstInteractionAt)}
													{:else}
														No matched interactions yet
													{/if}
												</span>
											</div>
										</div>
									<div class="follow-row-side">
										<span class="match-pill">{entry.follow.totalInteractionCount.toLocaleString()}</span>
										<span class="follow-row-kind-count">{entry.follow.matchedKindCount}/4 kinds</span>
									</div>
								</button>
							{/each}
						{:else}
							<p class="empty-list-state">
								{#if followListKind === 'all'}
									No followed accounts match that search yet.
								{:else}
									No followed accounts with a recorded {interactionLabel(followListKind).toLowerCase()} match that search yet.
								{/if}
							</p>
						{/if}
					</div>
				</aside>

				<section class="detail-column">
					{#if sortedFollowEntries.length === 0}
						<article class="selected-follow-card wobbly-border-light">
							<div class="panel-head">
								<div>
									<p class="card-kicker">No Matching Follows</p>
									<h3>Try a different search or list mode</h3>
								</div>
							</div>
							<p class="selected-follow-meta">
								Search checks followed handles, display names, and DIDs. If you selected a specific
								interaction list, only follows with that first interaction stay visible.
							</p>
						</article>
					{:else if selectedFollow}
						<article class="selected-follow-card wobbly-border-light">
							<div class="selected-follow-head">
								<div class="selected-follow-profile">
									{#if selectedFollowProfile?.avatar}
										<img class="hero-avatar" src={selectedFollowProfile.avatar} alt="" />
									{:else}
										<div class="hero-avatar placeholder"></div>
									{/if}
									<div class="hero-copy">
										<p class="eyebrow">Showing earliest interactions with</p>
										<h2>{selectedFollowProfile?.displayName || followPrimaryLabel(selectedFollowProfile, selectedFollow.did)}</h2>
										<p class="hero-handle">{followPrimaryLabel(selectedFollowProfile, selectedFollow.did)}</p>
									</div>
								</div>
								<div class="selected-follow-side">
									<span class="candidate-pill">
										{selectedFollow.totalInteractionCount.toLocaleString()} interactions
									</span>
								</div>
							</div>
							<p class="selected-follow-meta">
								The cards below still count every surviving repo record that points at this followed
								account, and they also hydrate the first source and target posts from appview for the
								selected follow.
							</p>
							{#if selectedFollowDetail?.loading}
								<p class="selected-follow-hydration">{selectedFollowDetail.progressLabel}</p>
							{/if}
							{#if selectedFollowDetail?.error}
								<p class="selected-follow-hydration error">{selectedFollowDetail.error}</p>
							{/if}
							<div class="selected-follow-stats">
								<div class="stat-chip compact">
									<span class="stat-label">Matched kinds</span>
									<strong>{selectedResolvedCount}/4</strong>
								</div>
								<div class="stat-chip compact">
									<span class="stat-label">Total interactions</span>
									<strong>{selectedFollow.totalInteractionCount.toLocaleString()}</strong>
								</div>
								<div class="stat-chip compact">
									<span class="stat-label">Followed since</span>
									<strong>{formatDateTime(selectedFollow.followedAt)}</strong>
								</div>
								<div class="stat-chip compact">
									<span class="stat-label">First interaction</span>
									<strong>{formatDateTime(selectedFollow.firstInteractionAt)}</strong>
								</div>
								<div class="stat-chip compact">
									<span class="stat-label">Latest interaction</span>
									<strong>{formatDateTime(selectedFollow.latestInteractionAt)}</strong>
								</div>
							</div>
						</article>

						<section class="interaction-grid">
							{#each FOLLOW_INTERACTION_KINDS as kind}
								{@const hydratedInteraction = selectedFollowDetail?.interactions[kind] ?? null}
								{@const interaction = hydratedInteraction ?? selectedFollow.interactions[kind]}
								{@const interactionCount = selectedFollow.interactionCounts[kind]}
								{@const targetPost = hydratedInteraction?.targetPost ?? null}
								{@const sourcePost = hydratedInteraction?.sourcePost ?? null}
								<article class="interaction-card wobbly-border-light">
									<div class="card-head">
										<div>
											<p class="card-kicker">{interactionLabel(kind)}</p>
											<h3>{interactionCount.toLocaleString()} recorded</h3>
										</div>
										<span class="candidate-pill">
											{interaction ? 'Has first match' : 'No match'}
										</span>
									</div>

									<p class="card-hint">{interactionHint(kind)}</p>

									{#if interaction}
										<div class="interaction-actions">
											{#if interactionTargetUrl(interaction, targetPost)}
												<a
													class="action-link"
													href={interactionTargetUrl(interaction, targetPost) ?? undefined}
													target="_blank"
													rel="noreferrer"
												>
													Open target
												</a>
											{/if}
											{#if interactionSourceUrl(interaction, sourcePost)}
												<a
													class="action-link"
													href={interactionSourceUrl(interaction, sourcePost) ?? undefined}
													target="_blank"
													rel="noreferrer"
												>
													Open source
												</a>
											{/if}
										</div>
										{#if targetPost}
											<section class="post-preview-card">
												<div class="post-preview-head">
													<p class="post-preview-label">Target post</p>
													{#if interactionTargetUrl(interaction, targetPost)}
														<a
															class="action-link"
															href={interactionTargetUrl(interaction, targetPost) ?? undefined}
															target="_blank"
															rel="noreferrer"
														>
															Open target
														</a>
													{/if}
												</div>
												<div class="post-preview-author">
													{#if targetPost.author.avatar}
														<img class="post-preview-avatar" src={targetPost.author.avatar} alt="" />
													{:else}
														<div class="post-preview-avatar placeholder"></div>
													{/if}
													<div class="post-preview-copy">
														<strong>{targetPost.author.displayName || `@${targetPost.author.handle}`}</strong>
														<span>@{targetPost.author.handle} · {formatDateTime(targetPost.createdAt)}</span>
													</div>
												</div>
												<p class="post-preview-text">
													{targetPost.text ? truncateText(targetPost.text) : 'No text in this post.'}
												</p>
												<PostEmbedPreview post={targetPost} compact />
											</section>
										{:else if selectedFollowDetail?.loaded}
											<p class="post-preview-missing">
												Appview did not return the target post for this first interaction.
											</p>
										{/if}
										{#if sourcePost}
											<section class="post-preview-card">
												<div class="post-preview-head">
													<p class="post-preview-label">Source post</p>
													{#if interactionSourceUrl(interaction, sourcePost)}
														<a
															class="action-link"
															href={interactionSourceUrl(interaction, sourcePost) ?? undefined}
															target="_blank"
															rel="noreferrer"
														>
															Open source
														</a>
													{/if}
												</div>
												<div class="post-preview-author">
													{#if sourcePost.author.avatar}
														<img class="post-preview-avatar" src={sourcePost.author.avatar} alt="" />
													{:else}
														<div class="post-preview-avatar placeholder"></div>
													{/if}
													<div class="post-preview-copy">
														<strong>{sourcePost.author.displayName || `@${sourcePost.author.handle}`}</strong>
														<span>@{sourcePost.author.handle} · {formatDateTime(sourcePost.createdAt)}</span>
													</div>
												</div>
												<p class="post-preview-text">
													{sourcePost.text ? truncateText(sourcePost.text) : 'No text in this post.'}
												</p>
												<PostEmbedPreview post={sourcePost} compact />
											</section>
										{:else if interaction.sourceUri && selectedFollowDetail?.loaded}
											<p class="post-preview-missing">
												Appview did not return the source post for this first interaction.
											</p>
										{/if}
									{:else}
										<p class="empty-state">{emptyHint(kind)}</p>
									{/if}
								</article>
							{/each}
						</section>
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
	.follow-list-card,
	.selected-follow-card {
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
	.selected-follow-profile {
		display: flex;
		align-items: center;
		gap: 16px;
	}

	.hero-avatar,
	.follow-avatar {
		background: var(--input-bg);
		object-fit: cover;
	}

	.hero-avatar {
		width: 76px;
		height: 76px;
		border-radius: 22px;
	}

	.follow-avatar {
		width: 44px;
		height: 44px;
		border-radius: 14px;
		flex: 0 0 auto;
	}

	.hero-avatar.placeholder,
	.follow-avatar.placeholder {
		background: linear-gradient(135deg, rgba(244, 216, 132, 0.55), rgba(233, 126, 77, 0.28));
	}

	.hero-copy {
		display: grid;
		gap: 6px;
		text-align: left;
		min-width: 0;
	}

	.eyebrow,
	.hero-handle,
	.selected-follow-meta {
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

	.follow-workspace {
		display: grid;
		grid-template-columns: minmax(280px, 340px) minmax(0, 1fr);
		gap: 18px;
		align-items: start;
	}

	.follow-list-card,
	.selected-follow-card {
		display: grid;
		gap: 16px;
		padding: 20px;
	}

	.follow-list-card {
		position: sticky;
		top: 18px;
	}

	.panel-head,
	.selected-follow-head,
	.card-head {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 10px;
	}

	.panel-head h3,
	.card-head h3 {
		margin: 0;
	}

	.detail-column {
		display: grid;
		gap: 18px;
		min-width: 0;
	}

	.selected-follow-side {
		display: grid;
		gap: 10px;
		justify-items: end;
	}

	.selected-follow-meta {
		line-height: 1.55;
	}

	.selected-follow-hydration {
		margin: 0;
		padding: 12px 14px;
		border-radius: 16px;
		background: var(--panel-bg-muted);
		border: 1px solid var(--warm-border);
		color: var(--muted);
		line-height: 1.5;
	}

	.selected-follow-hydration.error {
		border-color: rgba(189, 72, 55, 0.22);
		color: var(--danger-text);
		background: var(--error-bg);
	}

	.selected-follow-stats {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
		gap: 12px;
	}

	.follow-search-block {
		display: grid;
		gap: 8px;
	}

	.follow-controls {
		display: grid;
		gap: 12px;
	}

	.follow-sort-block {
		display: grid;
		gap: 6px;
		font-size: 0.88rem;
		color: var(--muted);
	}

	.follow-sort-select {
		width: 100%;
		padding: 11px 13px;
		border-radius: 14px;
		border: 1px solid var(--warm-border);
		background: var(--input-bg);
		color: var(--text-ink);
		font: inherit;
		box-shadow: inset 0 1px 0 color-mix(in srgb, var(--card-bg) 70%, transparent);
	}

	.follow-sort-select:focus {
		outline: 2px solid rgba(224, 122, 95, 0.22);
		outline-offset: 2px;
		border-color: rgba(224, 122, 95, 0.4);
	}

	.follow-search-input {
		width: 100%;
		padding: 11px 13px;
		border-radius: 14px;
		border: 1px solid var(--warm-border);
		background: var(--input-bg);
		color: var(--text-ink);
		font: inherit;
		box-shadow: inset 0 1px 0 color-mix(in srgb, var(--card-bg) 70%, transparent);
	}

	.follow-search-input:focus {
		outline: 2px solid rgba(224, 122, 95, 0.22);
		outline-offset: 2px;
		border-color: rgba(224, 122, 95, 0.4);
	}

	.follow-search-meta {
		margin: 0;
		font-size: 0.88rem;
		color: var(--muted);
	}

	.follow-list {
		display: grid;
		gap: 10px;
		max-height: 72vh;
		overflow: auto;
		padding-right: 4px;
	}

	.follow-row {
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

	.follow-row:hover {
		transform: translateY(-1px);
		border-color: rgba(224, 122, 95, 0.3);
		box-shadow: 0 10px 24px rgba(26, 35, 44, 0.08);
	}

	.follow-row.active {
		background: var(--active-bg);
		border-color: rgba(224, 122, 95, 0.38);
		box-shadow: 0 0 0 2px rgba(224, 122, 95, 0.08);
	}

	.follow-row-main {
		display: flex;
		align-items: center;
		gap: 12px;
		min-width: 0;
	}

	.follow-row-copy {
		display: grid;
		gap: 4px;
		min-width: 0;
	}

	.follow-row-side {
		display: grid;
		gap: 5px;
		justify-items: end;
		flex: 0 0 auto;
	}

	.follow-row-copy strong,
	.follow-row-copy span {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.follow-row-copy strong {
		font-size: 1rem;
	}

	.follow-row-copy span {
		font-size: 0.85rem;
		color: var(--muted);
	}

	.follow-row-meta {
		font-size: 0.78rem;
		color: var(--muted);
	}

	.follow-row-kind-count {
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

	.interaction-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
		gap: 18px;
	}

	.interaction-card {
		display: grid;
		gap: 16px;
		padding: 20px;
		background: var(--panel-bg);
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

	.card-head h3 {
		font-size: 1.5rem;
	}

	.card-hint,
	.empty-state,
	.note-card p {
		margin: 0;
		line-height: 1.55;
		color: var(--muted);
	}

	.interaction-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 12px;
	}

	.post-preview-card {
		display: grid;
		gap: 12px;
		padding: 14px;
		border-radius: 18px;
		background: var(--panel-bg-muted);
		border: 1px solid var(--warm-border);
	}

	.post-preview-head,
	.post-preview-author {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 10px;
	}

	.post-preview-label {
		margin: 0;
		font-size: 0.78rem;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: var(--warm-text);
	}

	.post-preview-author {
		justify-content: flex-start;
	}

	.post-preview-avatar {
		width: 40px;
		height: 40px;
		border-radius: 12px;
		object-fit: cover;
		background: var(--input-bg);
		flex: 0 0 auto;
	}

	.post-preview-avatar.placeholder {
		background: linear-gradient(135deg, rgba(244, 216, 132, 0.55), rgba(233, 126, 77, 0.28));
	}

	.post-preview-copy {
		display: grid;
		gap: 4px;
		min-width: 0;
	}

	.post-preview-copy strong,
	.post-preview-copy span {
		word-break: break-word;
	}

	.post-preview-copy span {
		font-size: 0.84rem;
		color: var(--muted);
	}

	.post-preview-text,
	.post-preview-missing {
		margin: 0;
		line-height: 1.55;
		color: var(--text-ink);
		white-space: pre-wrap;
		word-break: break-word;
	}

	.post-preview-missing {
		color: var(--muted);
	}

	.action-link {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font-size: 0.88rem;
		font-weight: 700;
		color: var(--warm-text);
		text-decoration: none;
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
		.follow-workspace {
			grid-template-columns: minmax(0, 1fr);
		}

		.follow-list-card {
			position: static;
		}

		.selected-follow-head {
			flex-direction: column;
		}

		.selected-follow-side {
			width: 100%;
			justify-items: start;
		}

		.follow-row-side {
			justify-items: start;
		}

		.post-preview-head {
			flex-direction: column;
		}
	}

	@media (max-width: 640px) {
		main {
			padding: 22px 14px 44px;
		}

		.hero-profile,
		.selected-follow-profile {
			align-items: flex-start;
		}

		.hero-avatar {
			width: 64px;
			height: 64px;
			border-radius: 18px;
		}

		.hero-stats,
		.interaction-grid {
			grid-template-columns: minmax(0, 1fr);
		}

		.panel-head,
		.card-head {
			flex-direction: column;
		}

		.follow-row {
			padding: 11px 12px;
			align-items: flex-start;
		}
	}
</style>
