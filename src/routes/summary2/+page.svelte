<script lang="ts">
	import { onMount } from 'svelte';
	import { browser } from '$app/environment';
	import '../../app.css';
	import type { CachedUserSummary, DiscoverProgress } from '$lib/types';
	import { getProfile, getProfiles, type ProfileInfo } from '$lib/api/bluesky';
	import ErrorBanner from '$lib/components/ErrorBanner.svelte';
	import FontPicker from '$lib/components/FontPicker.svelte';
	import LoadingSpinner from '$lib/components/LoadingSpinner.svelte';
	import RouteNav from '$lib/components/RouteNav.svelte';
	import SearchBar from '$lib/components/SearchBar.svelte';
	import SummaryThumbnail from '$lib/components/SummaryThumbnail.svelte';
	import { buildCachedUserSummary } from '$lib/utils/cachedSummary';
	import {
		hydrateFeedItemsEngagement,
		loadRepoFeedItems,
		parseRepoFeedItemsFromCar
	} from '$lib/utils/repoHydration';
	import { buildBskyPostUrl } from '$lib/utils/viewerLinks';

	type MentionProfileMap = Record<string, ProfileInfo>;
	type SummarySectionKey = 'mentions' | 'liked' | 'reposted' | 'repeated' | 'threads';
	type VisibleSummaryCounts = Record<SummarySectionKey, number>;
	type RepoLoadStats = {
		source: 'pds' | 'relay' | null;
		elapsedMs: number;
		downloadedBytes: number;
		hydratedCount: number;
		missingCount: number;
	};

	const fontFamilies: Record<string, string> = {
		virgil: "'Virgil', cursive",
		caveat: "'Caveat', cursive",
		patrick: "'Patrick Hand', cursive",
		'comic-neue': "'Comic Neue', cursive",
		inter: "'Inter', sans-serif",
		system: 'system-ui, -apple-system, sans-serif'
	};

	const countFormatter = new Intl.NumberFormat('en-US', {
		notation: 'compact',
		maximumFractionDigits: 1
	});
	const dateFormatter = new Intl.DateTimeFormat('en-US', {
		dateStyle: 'medium'
	});
	const dateTimeFormatter = new Intl.DateTimeFormat('en-US', {
		dateStyle: 'medium',
		timeStyle: 'short'
	});
	const INITIAL_VISIBLE_ITEMS = 8;
	const VISIBLE_ITEM_INCREMENT = 8;
	const FULL_SUMMARY_LIMIT = Number.MAX_SAFE_INTEGER;

	function createInitialVisibleCounts(): VisibleSummaryCounts {
		return {
			mentions: INITIAL_VISIBLE_ITEMS,
			liked: INITIAL_VISIBLE_ITEMS,
			reposted: INITIAL_VISIBLE_ITEMS,
			repeated: INITIAL_VISIBLE_ITEMS,
			threads: INITIAL_VISIBLE_ITEMS
		};
	}

	function createInitialRepoLoadStats(): RepoLoadStats {
		return {
			source: null,
			elapsedMs: 0,
			downloadedBytes: 0,
			hydratedCount: 0,
			missingCount: 0
		};
	}

	let fontKey = $state('patrick');
	let fontFamily = $derived(fontFamilies[fontKey] ?? fontFamilies.virgil);
	let initialHandle = $state('');
	let profile = $state<ProfileInfo | null>(null);
	let summary = $state<CachedUserSummary | null>(null);
	let mentionProfiles = $state<MentionProfileMap>({});
	let loading = $state(false);
	let progress = $state<DiscoverProgress>({
		phase: 'Loading repo summary…',
		current: 0,
		total: 0
	});
	let resolvingMentions = $state(false);
	let error = $state<string | null>(null);
	let loadToken = 0;
	let mentionToken = 0;
	let loadController: AbortController | null = null;
	let visibleCounts = $state<VisibleSummaryCounts>(createInitialVisibleCounts());
	let repoLoadStats = $state<RepoLoadStats>(createInitialRepoLoadStats());

	function throwIfAborted(signal: AbortSignal) {
		if (signal.aborted) {
			throw new DOMException('Aborted', 'AbortError');
		}
	}

	function formatCount(value: number): string {
		if (value < 1000) return value.toLocaleString();
		return countFormatter.format(value);
	}

	function formatDate(value: string | null | undefined): string {
		if (!value) return 'Unknown date';
		const parsed = new Date(value);
		return Number.isNaN(parsed.getTime()) ? 'Unknown date' : dateFormatter.format(parsed);
	}

	function formatDateTime(value: string | null | undefined): string {
		if (!value) return 'Unknown date';
		const parsed = new Date(value);
		return Number.isNaN(parsed.getTime()) ? 'Unknown date' : dateTimeFormatter.format(parsed);
	}

	function formatDuration(ms: number): string {
		if (ms <= 0) return '0s';
		if (ms < 1000) return `${Math.round(ms)}ms`;
		return `${(ms / 1000).toFixed(1)}s`;
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

	function truncateText(text: string, maxLength = 180): string {
		const normalized = text.replace(/\s+/g, ' ').trim();
		if (normalized.length <= maxLength) return normalized;
		return `${normalized.slice(0, maxLength - 1).trimEnd()}…`;
	}

	function resetVisibleCounts() {
		visibleCounts = createInitialVisibleCounts();
	}

	function visibleItems<T>(items: T[], section: SummarySectionKey): T[] {
		return items.slice(0, visibleCounts[section]);
	}

	function hasMoreItems(section: SummarySectionKey, total: number): boolean {
		return visibleCounts[section] < total;
	}

	function showMore(section: SummarySectionKey, total: number) {
		visibleCounts = {
			...visibleCounts,
			[section]: Math.min(total, visibleCounts[section] + VISIBLE_ITEM_INCREMENT)
		};
	}

	function updateHandleQuery(handle: string | null) {
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

	function profileUrl(actor: string): string {
		return `https://bsky.app/profile/${encodeURIComponent(actor)}`;
	}

	function postUrl(uri: string): string | null {
		return buildBskyPostUrl(uri, profile?.handle ?? null);
	}

	function viewerUrl(uri: string): string | null {
		const url = postUrl(uri);
		if (!url) return null;
		const handle = (profile?.handle ?? initialHandle).replace(/^@/, '').trim();
		const returnTo = handle ? `/summary2?handle=${encodeURIComponent(handle)}` : '/summary2';
		return `/?url=${encodeURIComponent(url)}&view=thread&returnTo=${encodeURIComponent(returnTo)}`;
	}

	async function loadMentionProfiles(dids: string[]) {
		const uniqueDids = [...new Set(dids.filter(Boolean))];
		const token = ++mentionToken;
		mentionProfiles = {};

		if (uniqueDids.length === 0) {
			resolvingMentions = false;
			return;
		}

		resolvingMentions = true;
		try {
			const profiles = await getProfiles(uniqueDids);
			if (token !== mentionToken) return;
			mentionProfiles = Object.fromEntries(profiles.map((entry) => [entry.did, entry]));
		} catch {
			if (token === mentionToken) {
				mentionProfiles = {};
			}
		} finally {
			if (token === mentionToken) {
				resolvingMentions = false;
			}
		}
	}

	async function loadSummaryForProfile(
		nextProfile: ProfileInfo,
		options: { carBytes?: Uint8Array } = {}
	) {
		const token = ++loadToken;
		loadController?.abort();
		loadController = new AbortController();
		loading = true;
		error = null;
		profile = nextProfile;
		summary = null;
		mentionProfiles = {};
		repoLoadStats = createInitialRepoLoadStats();
		resetVisibleCounts();
		initialHandle = nextProfile.handle;
		updateHandleQuery(nextProfile.handle);

		try {
			const savedCarBytes = options.carBytes;
			let latestDownloadedBytes = savedCarBytes?.byteLength ?? 0;
			progress = { phase: 'Preparing repo summary…', current: 0, total: 0 };
			const authorInfo = {
				did: nextProfile.did,
				handle: nextProfile.handle,
				displayName: nextProfile.displayName,
				avatar: nextProfile.avatar
			};
			const repo = savedCarBytes
				? await parseRepoFeedItemsFromCar(nextProfile.did, authorInfo, savedCarBytes, {
						signal: loadController.signal,
						downloadedBytes: savedCarBytes.byteLength,
						totalBytes: savedCarBytes.byteLength,
						source: 'pds',
						onParseProgress: (count) => {
							if (token !== loadToken) return;
							progress = {
								phase: 'Parsing saved CAR posts…',
								current: 0,
								total: 0,
								detail: `${count.toLocaleString()} posts extracted from ${formatBytes(latestDownloadedBytes)}`
							};
						}
					})
				: await loadRepoFeedItems(nextProfile.did, authorInfo, {
						signal: loadController.signal,
						onDownloadProgress: (downloadProgress) => {
							if (token !== loadToken) return;
							latestDownloadedBytes = downloadProgress.receivedBytes;
							const detailParts = [
								`${formatBytes(downloadProgress.receivedBytes)}${downloadProgress.totalBytes > 0 ? ` / ${formatBytes(downloadProgress.totalBytes)}` : ''}`
							];
							if (downloadProgress.bytesPerSecond > 0) {
								detailParts.push(formatSpeed(downloadProgress.bytesPerSecond));
							}
							if (downloadProgress.elapsedMs > 0) {
								detailParts.push(formatDuration(downloadProgress.elapsedMs));
							}
							progress =
								downloadProgress.totalBytes > 0
									? {
											phase: 'Downloading repository…',
											current: Math.round(
												(downloadProgress.receivedBytes / downloadProgress.totalBytes) * 100
											),
											total: 100,
											detail: detailParts.join(' · ')
										}
									: {
											phase: 'Downloading repository…',
											current: 0,
											total: 0,
											detail: detailParts.join(' · ')
										};
						},
						onParseProgress: (count) => {
							if (token !== loadToken) return;
							progress = {
								phase: 'Parsing repository posts…',
								current: 0,
								total: 0,
								detail: `${count.toLocaleString()} posts extracted from ${formatBytes(latestDownloadedBytes)}`
							};
						}
					});

			if (token !== loadToken) return;
			throwIfAborted(loadController.signal);

			if (repo.totalPosts <= 0) {
				error = `No repository posts were found for @${nextProfile.handle}.`;
				return;
			}

			progress = {
				phase: 'Hydrating engagement…',
				current: 0,
				total: repo.totalPosts
			};

			const engagement = await hydrateFeedItemsEngagement(repo.feedItems, {
				signal: loadController.signal,
				concurrency: 4,
				onProgress: ({ completed, total }) => {
					if (token !== loadToken) return;
					progress = {
						phase: 'Hydrating engagement…',
						current: completed,
						total,
						detail: `${completed.toLocaleString()} / ${total.toLocaleString()} repo posts hydrated with like, repost, reply, and quote counts`
					};
				}
			});

			if (token !== loadToken) return;
			throwIfAborted(loadController.signal);

			progress = {
				phase: 'Ranking repo posts…',
				current: repo.feedItems.length,
				total: repo.totalPosts,
				detail: `${repo.totalPosts.toLocaleString()} repo posts ready for summary extraction`
			};

			const updatedAt = new Date().toISOString();
			const nextSummary = buildCachedUserSummary({
				did: nextProfile.did,
				feedPosts: repo.feedItems,
				cachedPostCount: repo.totalPosts,
				updatedAt,
				partial: engagement.missingCount > 0,
				mentionLimit: FULL_SUMMARY_LIMIT,
				postLimit: FULL_SUMMARY_LIMIT,
				threadLimit: FULL_SUMMARY_LIMIT
			});

			if (token !== loadToken) return;

			repoLoadStats = {
				source: repo.source,
				elapsedMs: repo.elapsedMs,
				downloadedBytes: repo.downloadedBytes,
				hydratedCount: engagement.hydratedCount,
				missingCount: engagement.missingCount
			};
			summary = nextSummary;
			void loadMentionProfiles(nextSummary.mostMentionedUsers.map((entry) => entry.did));
		} catch (err: any) {
			if (token !== loadToken || err?.name === 'AbortError') return;
			error = err?.message || `Could not build a repo summary for @${nextProfile.handle}.`;
		} finally {
			if (token === loadToken) {
				loading = false;
			}
		}
	}

	async function loadSummaryFromHandle(rawHandle: string) {
		const nextHandle = rawHandle.replace(/^@/, '').trim();
		if (!nextHandle) return;

		error = null;
		try {
			progress = { phase: 'Resolving profile…', current: 0, total: 0 };
			const nextProfile = await getProfile(nextHandle);
			await loadSummaryForProfile(nextProfile);
		} catch (err: any) {
			error = err?.message || `Could not resolve @${nextHandle}.`;
			profile = null;
			summary = null;
			mentionProfiles = {};
			repoLoadStats = createInitialRepoLoadStats();
			loading = false;
			updateHandleQuery(nextHandle);
		}
	}

	function handleFontChange(key: string) {
		fontKey = key;
		try {
			localStorage.setItem('preferred-font', key);
		} catch {}
	}

	function handleProfileSelected(nextProfile: ProfileInfo) {
		void loadSummaryForProfile(nextProfile);
	}

	async function loadSavedRepoCar(_entry: unknown, carBytes: Uint8Array) {
		if (!profile) return;
		await loadSummaryForProfile(profile, { carBytes });
	}

	onMount(() => {
		try {
			const saved = localStorage.getItem('preferred-font');
			if (saved && saved in fontFamilies) {
				fontKey = saved;
			}
		} catch {}

		const params = new URLSearchParams(window.location.search);
		const handle = params.get('handle')?.trim() ?? '';
		if (handle) {
			initialHandle = handle;
			void loadSummaryFromHandle(handle);
		}
	});
</script>

<svelte:head>
	<title>Repo Summary</title>
</svelte:head>

<main style="font-family: {fontFamily}">
	<header class="page-header">
		<RouteNav current="summary2" align="center" handle={profile?.handle ?? initialHandle ?? null} />
		<h1>Repo Summary</h1>
		<p class="subtitle">
			Download a user&apos;s CAR repo in the browser, then batch-hydrate live likes, reposts, replies,
			and quotes for an ad hoc summary.
		</p>
		<FontPicker value={fontKey} onchange={handleFontChange} />
	</header>

	<section class="lookup-panel wobbly-border-light">
		<SearchBar
			onsearch={loadSummaryFromHandle}
			onprofile={handleProfileSelected}
			disabled={loading}
			{initialHandle}
			placeholder="Search any public Bluesky user..."
			buttonLabel="Load Repo Summary"
		/>
		<p class="lookup-note">
			This page stays frontend-only. It downloads the account&apos;s repo directly, parses posts with the
			WASM CAR reader, then batches live post lookups to fill engagement counts.
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
					<p class="eyebrow">Repo summary for</p>
					<h2>{profile.displayName || profile.handle}</h2>
					<p class="hero-handle">@{profile.handle}</p>
				</div>
			</div>
			<div class="hero-stats">
				<div class="stat-chip">
					<span class="stat-label">Repo posts</span>
					<strong>{summary.cachedPostCount.toLocaleString()}</strong>
				</div>
				<div class="stat-chip">
					<span class="stat-label">Analyzed posts</span>
					<strong>{summary.analyzedPostCount.toLocaleString()}</strong>
				</div>
				<div class="stat-chip">
					<span class="stat-label">Hydrated posts</span>
					<strong>{repoLoadStats.hydratedCount.toLocaleString()}</strong>
				</div>
				<div class="stat-chip">
					<span class="stat-label">Mentioned users</span>
					<strong>{summary.uniqueMentionedUsers.toLocaleString()}</strong>
				</div>
				<div class="stat-chip">
					<span class="stat-label">Top likes</span>
					<strong>{summary.mostLikedPosts[0]?.likeCount?.toLocaleString() ?? '0'}</strong>
				</div>
				<div class="stat-chip">
					<span class="stat-label">Top reposts</span>
					<strong>{summary.mostRepostedPosts[0]?.repostCount?.toLocaleString() ?? '0'}</strong>
				</div>
				<div class="stat-chip">
					<span class="stat-label">Top repeats</span>
					<strong>{summary.mostRepeatedPosts[0]?.count?.toLocaleString() ?? '0'}</strong>
				</div>
				<div class="stat-chip">
					<span class="stat-label">Top thread replies</span>
					<strong>{summary.threadsWithMostReplies[0]?.totalReplyCount?.toLocaleString() ?? '0'}</strong>
				</div>
			</div>
			<div class="hero-meta">
				<span>Hydrated {formatDateTime(summary.updatedAt)}</span>
				{#if repoLoadStats.source}
					<span>
						Loaded via {repoLoadStats.source === 'pds' ? 'PDS' : 'relay'} in {formatDuration(repoLoadStats.elapsedMs)}
						from {formatBytes(repoLoadStats.downloadedBytes)}
					</span>
				{/if}
				{#if summary.partial}
					<span class="partial-pill">
						{repoLoadStats.missingCount.toLocaleString()} posts missing live engagement
					</span>
				{/if}
			</div>
		</section>

		<section class="summary-grid">
			<article class="panel wobbly-border-light">
				<div class="panel-heading">
					<h3>Most Mentioned Users</h3>
					<p>Counted from `@` mention facets in repo posts.</p>
				</div>
				{#if resolvingMentions && summary.mostMentionedUsers.length > 0}
					<p class="loading-note">Resolving handles…</p>
				{/if}
				{#if summary.mostMentionedUsers.length === 0}
					<p class="empty-state">No mention facets were found in the repository posts.</p>
				{:else}
					{@const visibleMentionedUsers = visibleItems(summary.mostMentionedUsers, 'mentions')}
					<ul class="rank-list mention-list">
						{#each visibleMentionedUsers as entry, index (entry.did)}
							{@const mentionProfile = mentionProfiles[entry.did]}
							<li class="rank-item">
								<div class="rank-index">{index + 1}</div>
								{#if mentionProfile?.avatar}
									<img class="mention-avatar" src={mentionProfile.avatar} alt="" />
								{:else}
									<div class="mention-avatar placeholder"></div>
								{/if}
								<div class="rank-copy">
									<a
										class="rank-title"
										href={profileUrl(mentionProfile?.handle ?? entry.did)}
										target="_blank"
										rel="noreferrer"
									>
										@{mentionProfile?.handle ?? entry.did}
									</a>
									<p class="rank-subtitle">
										{mentionProfile?.displayName || 'Handle not resolved'}
									</p>
									<p class="rank-meta">
										<span>{entry.count.toLocaleString()} mentions</span>
										<span>Last seen {formatDate(entry.lastMentionedAt)}</span>
									</p>
								</div>
							</li>
						{/each}
					</ul>
					{#if hasMoreItems('mentions', summary.mostMentionedUsers.length)}
						<div class="show-more-row">
							<button
								type="button"
								class="show-more-button"
								onclick={() => showMore('mentions', summary.mostMentionedUsers.length)}
							>
								Show {Math.min(VISIBLE_ITEM_INCREMENT, summary.mostMentionedUsers.length - visibleMentionedUsers.length)} more
							</button>
							<span class="show-more-note">
								Showing {visibleMentionedUsers.length} of {summary.mostMentionedUsers.length}
							</span>
						</div>
					{/if}
				{/if}
			</article>

			<article class="panel wobbly-border-light">
				<div class="panel-heading">
					<h3>Most Liked Posts</h3>
					<p>Highest-like posts after live engagement hydration.</p>
				</div>
				{#if summary.mostLikedPosts.length === 0}
					<p class="empty-state">No liked posts were found in the hydrated data yet.</p>
				{:else}
					{@const visibleLikedPosts = visibleItems(summary.mostLikedPosts, 'liked')}
					<ul class="rank-list">
						{#each visibleLikedPosts as entry, index (entry.uri)}
							<li class="post-card">
								<div class="post-card-top">
									<div class="rank-index">{index + 1}</div>
									<SummaryThumbnail thumbnail={entry.thumbnail} />
									<p class="post-preview">{truncateText(entry.text || '(No text)')}</p>
								</div>
								<div class="post-metrics">
									<span>{formatCount(entry.likeCount)} likes</span>
									<span>{formatCount(entry.repostCount)} reposts</span>
									<span>{formatCount(entry.replyCount)} replies</span>
									<span>{formatDate(entry.createdAt)}</span>
								</div>
								<div class="post-links">
									{#if viewerUrl(entry.uri)}
										<a href={viewerUrl(entry.uri) ?? '#'} class="text-link">Open thread</a>
									{/if}
									{#if postUrl(entry.uri)}
										<a href={postUrl(entry.uri) ?? '#'} class="text-link" target="_blank" rel="noreferrer">Open on Bluesky</a>
									{/if}
								</div>
							</li>
						{/each}
					</ul>
					{#if hasMoreItems('liked', summary.mostLikedPosts.length)}
						<div class="show-more-row">
							<button
								type="button"
								class="show-more-button"
								onclick={() => showMore('liked', summary.mostLikedPosts.length)}
							>
								Show {Math.min(VISIBLE_ITEM_INCREMENT, summary.mostLikedPosts.length - visibleLikedPosts.length)} more
							</button>
							<span class="show-more-note">
								Showing {visibleLikedPosts.length} of {summary.mostLikedPosts.length}
							</span>
						</div>
					{/if}
				{/if}
			</article>

			<article class="panel wobbly-border-light">
				<div class="panel-heading">
					<h3>Most Reposted Posts</h3>
					<p>Top posts by repost count from live post views.</p>
				</div>
				{#if summary.mostRepostedPosts.length === 0}
					<p class="empty-state">No reposted posts were found in the hydrated data yet.</p>
				{:else}
					{@const visibleRepostedPosts = visibleItems(summary.mostRepostedPosts, 'reposted')}
					<ul class="rank-list">
						{#each visibleRepostedPosts as entry, index (entry.uri)}
							<li class="post-card">
								<div class="post-card-top">
									<div class="rank-index">{index + 1}</div>
									<SummaryThumbnail thumbnail={entry.thumbnail} />
									<p class="post-preview">{truncateText(entry.text || '(No text)')}</p>
								</div>
								<div class="post-metrics">
									<span>{formatCount(entry.repostCount)} reposts</span>
									<span>{formatCount(entry.likeCount)} likes</span>
									<span>{formatCount(entry.replyCount)} replies</span>
									<span>{formatDate(entry.createdAt)}</span>
								</div>
								<div class="post-links">
									{#if viewerUrl(entry.uri)}
										<a href={viewerUrl(entry.uri) ?? '#'} class="text-link">Open thread</a>
									{/if}
									{#if postUrl(entry.uri)}
										<a href={postUrl(entry.uri) ?? '#'} class="text-link" target="_blank" rel="noreferrer">Open on Bluesky</a>
									{/if}
								</div>
							</li>
						{/each}
					</ul>
					{#if hasMoreItems('reposted', summary.mostRepostedPosts.length)}
						<div class="show-more-row">
							<button
								type="button"
								class="show-more-button"
								onclick={() => showMore('reposted', summary.mostRepostedPosts.length)}
							>
								Show {Math.min(VISIBLE_ITEM_INCREMENT, summary.mostRepostedPosts.length - visibleRepostedPosts.length)} more
							</button>
							<span class="show-more-note">
								Showing {visibleRepostedPosts.length} of {summary.mostRepostedPosts.length}
							</span>
						</div>
					{/if}
				{/if}
			</article>

			<article class="panel wobbly-border-light">
				<div class="panel-heading">
					<h3>Most Repeated Posts</h3>
					<p>Exact-text matches across repo posts, with link facets normalized so Bluesky post URLs stay distinct.</p>
				</div>
				{#if summary.mostRepeatedPosts.length === 0}
					<p class="empty-state">No exact repeated posts were found in the repository yet.</p>
				{:else}
					{@const visibleRepeatedPosts = visibleItems(summary.mostRepeatedPosts, 'repeated')}
					<ul class="rank-list">
						{#each visibleRepeatedPosts as entry, index (`${entry.text}:${entry.latestUri}`)}
							<li class="post-card">
								<div class="post-card-top">
									<div class="rank-index">{index + 1}</div>
									<SummaryThumbnail thumbnail={entry.thumbnail} />
									<p class="post-preview">{truncateText(entry.text || '(No text)')}</p>
								</div>
								<div class="post-metrics">
									<span>{entry.count.toLocaleString()} matching posts</span>
									<span>Latest {formatDate(entry.latestCreatedAt)}</span>
									<span>First seen {formatDate(entry.firstCreatedAt)}</span>
								</div>
								<div class="post-links">
									{#if viewerUrl(entry.latestUri)}
										<a href={viewerUrl(entry.latestUri) ?? '#'} class="text-link">Open thread</a>
									{/if}
									{#if postUrl(entry.latestUri)}
										<a href={postUrl(entry.latestUri) ?? '#'} class="text-link" target="_blank" rel="noreferrer">Open latest on Bluesky</a>
									{/if}
								</div>
							</li>
						{/each}
					</ul>
					{#if hasMoreItems('repeated', summary.mostRepeatedPosts.length)}
						<div class="show-more-row">
							<button
								type="button"
								class="show-more-button"
								onclick={() => showMore('repeated', summary.mostRepeatedPosts.length)}
							>
								Show {Math.min(VISIBLE_ITEM_INCREMENT, summary.mostRepeatedPosts.length - visibleRepeatedPosts.length)} more
							</button>
							<span class="show-more-note">
								Showing {visibleRepeatedPosts.length} of {summary.mostRepeatedPosts.length}
							</span>
						</div>
					{/if}
				{/if}
			</article>

			<article class="panel wobbly-border-light">
				<div class="panel-heading">
					<h3>Threads With Most Replies</h3>
					<p>Reply totals are summed across each discovered self-thread using hydrated reply counts.</p>
				</div>
				{#if summary.threadsWithMostReplies.length === 0}
					<p class="empty-state">No reply-heavy threads were found in the hydrated data yet.</p>
				{:else}
					{@const visibleThreads = visibleItems(summary.threadsWithMostReplies, 'threads')}
					<ul class="rank-list">
						{#each visibleThreads as entry, index (entry.rootUri)}
							<li class="post-card">
								<div class="post-card-top">
									<div class="rank-index">{index + 1}</div>
									<SummaryThumbnail thumbnail={entry.thumbnail} />
									<p class="post-preview">{truncateText(entry.text || '(No text)')}</p>
								</div>
								<div class="post-metrics">
									<span>{formatCount(entry.totalReplyCount)} total replies</span>
									<span>{formatCount(entry.rootReplyCount)} root replies</span>
									<span>{entry.postCount.toLocaleString()} posts</span>
									<span>Depth {entry.depth}</span>
								</div>
								<div class="post-links">
									{#if viewerUrl(entry.rootUri)}
										<a href={viewerUrl(entry.rootUri) ?? '#'} class="text-link">Open thread</a>
									{/if}
									{#if postUrl(entry.rootUri)}
										<a href={postUrl(entry.rootUri) ?? '#'} class="text-link" target="_blank" rel="noreferrer">Open on Bluesky</a>
									{/if}
								</div>
							</li>
						{/each}
					</ul>
					{#if hasMoreItems('threads', summary.threadsWithMostReplies.length)}
						<div class="show-more-row">
							<button
								type="button"
								class="show-more-button"
								onclick={() => showMore('threads', summary.threadsWithMostReplies.length)}
							>
								Show {Math.min(VISIBLE_ITEM_INCREMENT, summary.threadsWithMostReplies.length - visibleThreads.length)} more
							</button>
							<span class="show-more-note">
								Showing {visibleThreads.length} of {summary.threadsWithMostReplies.length}
							</span>
						</div>
					{/if}
				{/if}
			</article>
		</section>
	{/if}
</main>

<style>
	main {
		max-width: 1180px;
		margin: 0 auto;
		padding: 32px 20px 56px;
	}

	.page-header {
		text-align: center;
		margin-bottom: 24px;
	}

	h1 {
		margin: 10px 0 6px;
		font-size: clamp(2.1rem, 3vw, 3rem);
		color: var(--text-ink);
	}

	.subtitle {
		max-width: 780px;
		margin: 0 auto;
		color: var(--muted);
		font-size: 1rem;
		line-height: 1.5;
	}

	.lookup-panel {
		padding: 18px;
		margin-bottom: 22px;
		background:
			linear-gradient(145deg, rgba(255, 250, 239, 0.96), rgba(248, 244, 235, 0.88)),
			radial-gradient(circle at top right, rgba(224, 122, 95, 0.12), transparent 42%);
	}

	.lookup-note {
		margin: 12px auto 0;
		max-width: 720px;
		color: var(--muted);
		text-align: center;
		line-height: 1.45;
	}

	.error-wrap,
	.loading-wrap {
		max-width: 720px;
		margin: 0 auto 22px;
	}

	.hero-card {
		padding: 22px;
		margin-bottom: 22px;
		background:
			linear-gradient(160deg, rgba(255, 253, 247, 0.98), rgba(248, 241, 230, 0.9)),
			radial-gradient(circle at top left, rgba(129, 178, 154, 0.18), transparent 36%);
		box-shadow: 0 18px 42px rgba(32, 33, 36, 0.08);
	}

	.hero-profile {
		display: flex;
		align-items: center;
		gap: 18px;
		margin-bottom: 18px;
	}

	.hero-avatar {
		width: 78px;
		height: 78px;
		border-radius: 24px;
		object-fit: cover;
		background: rgba(61, 64, 91, 0.08);
	}

	.hero-avatar.placeholder,
	.mention-avatar.placeholder {
		background:
			linear-gradient(135deg, rgba(61, 64, 91, 0.12), rgba(224, 122, 95, 0.16));
	}

	.eyebrow {
		margin: 0 0 4px;
		font-size: 0.78rem;
		font-weight: 700;
		letter-spacing: 0.12em;
		text-transform: uppercase;
		color: var(--muted);
	}

	h2 {
		margin: 0;
		font-size: clamp(1.5rem, 2vw, 2.1rem);
		color: var(--text-ink);
	}

	.hero-handle {
		margin: 4px 0 0;
		color: var(--muted);
		font-size: 1rem;
	}

	.hero-stats {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
		gap: 12px;
		margin-bottom: 16px;
	}

	.stat-chip {
		display: flex;
		flex-direction: column;
		gap: 6px;
		padding: 14px 16px;
		border-radius: 18px;
		background: rgba(255, 255, 255, 0.72);
		border: 1px solid rgba(61, 64, 91, 0.1);
	}

	.stat-label {
		color: var(--muted);
		font-size: 0.82rem;
	}

	.stat-chip strong {
		font-size: 1.25rem;
		color: var(--text-ink);
	}

	.hero-meta {
		display: flex;
		flex-wrap: wrap;
		gap: 10px 14px;
		color: var(--muted);
		font-size: 0.88rem;
	}

	.partial-pill {
		display: inline-flex;
		align-items: center;
		padding: 4px 10px;
		border-radius: 999px;
		background: rgba(224, 122, 95, 0.12);
		color: color-mix(in srgb, var(--accent) 72%, black);
		font-weight: 700;
	}

	.summary-grid {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 18px;
	}

	.panel {
		padding: 18px;
		background: rgba(255, 252, 246, 0.9);
	}

	.panel-heading {
		margin-bottom: 14px;
	}

	.panel-heading h3 {
		margin: 0 0 4px;
		font-size: 1.18rem;
		color: var(--text-ink);
	}

	.panel-heading p,
	.loading-note,
	.empty-state {
		margin: 0;
		color: var(--muted);
		line-height: 1.45;
	}

	.rank-list {
		list-style: none;
		padding: 0;
		margin: 0;
		display: grid;
		gap: 12px;
		max-height: 33rem;
		overflow-y: auto;
		padding-right: 4px;
	}

	.show-more-row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 10px 14px;
		margin-top: 14px;
	}

	.show-more-button {
		border: 1px solid rgba(61, 64, 91, 0.12);
		border-radius: 999px;
		padding: 9px 14px;
		background: rgba(255, 255, 255, 0.82);
		color: var(--text-ink);
		font: inherit;
		font-size: 0.9rem;
		font-weight: 700;
		cursor: pointer;
		transition:
			transform 120ms ease,
			border-color 120ms ease,
			background 120ms ease;
	}

	.show-more-button:hover {
		transform: translateY(-1px);
		border-color: color-mix(in srgb, var(--accent) 34%, rgba(61, 64, 91, 0.12));
		background: rgba(255, 255, 255, 0.94);
	}

	.show-more-note {
		color: var(--muted);
		font-size: 0.84rem;
	}

	.rank-item,
	.post-card {
		display: flex;
		gap: 14px;
		padding: 14px;
		border-radius: 18px;
		background: rgba(255, 255, 255, 0.7);
		border: 1px solid rgba(61, 64, 91, 0.08);
	}

	.rank-index {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 32px;
		height: 32px;
		border-radius: 999px;
		background: color-mix(in srgb, var(--accent) 16%, white);
		color: var(--text-ink);
		font-size: 0.9rem;
		font-weight: 700;
		flex-shrink: 0;
	}

	.mention-list .rank-item {
		align-items: center;
	}

	.mention-avatar {
		width: 44px;
		height: 44px;
		border-radius: 14px;
		object-fit: cover;
		flex-shrink: 0;
		background: rgba(61, 64, 91, 0.08);
	}

	.rank-copy {
		min-width: 0;
	}

	.rank-title {
		display: inline-block;
		color: var(--text-ink);
		font-weight: 700;
		text-decoration: none;
		word-break: break-word;
	}

	.rank-title:hover,
	.text-link:hover {
		color: var(--accent);
	}

	.rank-subtitle,
	.rank-meta {
		margin: 4px 0 0;
		color: var(--muted);
		font-size: 0.88rem;
	}

	.rank-meta {
		display: flex;
		flex-wrap: wrap;
		gap: 8px 12px;
	}

	.post-card {
		flex-direction: column;
	}

	.post-card-top {
		display: flex;
		gap: 12px;
		align-items: flex-start;
		min-width: 0;
	}

	.post-preview {
		margin: 0;
		min-width: 0;
		color: var(--text-ink);
		font-size: 0.97rem;
		line-height: 1.5;
	}

	.post-metrics {
		display: flex;
		flex-wrap: wrap;
		gap: 8px 12px;
		color: var(--muted);
		font-size: 0.84rem;
	}

	.post-links {
		display: flex;
		flex-wrap: wrap;
		gap: 10px 14px;
	}

	.text-link {
		color: var(--text-ink);
		font-size: 0.9rem;
		font-weight: 700;
		text-decoration: none;
	}

	@media (max-width: 900px) {
		.summary-grid {
			grid-template-columns: 1fr;
		}
	}

	@media (max-width: 640px) {
		main {
			padding: 24px 14px 42px;
		}

		.lookup-panel,
		.hero-card,
		.panel {
			padding: 16px;
		}

		.hero-profile {
			align-items: flex-start;
		}

		.hero-avatar {
			width: 64px;
			height: 64px;
			border-radius: 18px;
		}

		.rank-item,
		.post-card {
			padding: 12px;
		}
	}
</style>
