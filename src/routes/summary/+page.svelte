	<script lang="ts">
	import { onMount } from 'svelte';
	import { browser } from '$app/environment';
	import '../../app.css';
	import type { CachedUserSummary, DiscoverProgress } from '$lib/types';
	import {
		fetchCachedHeadBatchPage,
		fetchCachedChunkPage,
		fetchPostMeta
	} from '$lib/api/cache';
	import { getProfile, getProfiles, type ProfileInfo } from '$lib/api/bluesky';
	import CachedUsers from '$lib/components/CachedUsers.svelte';
	import ErrorBanner from '$lib/components/ErrorBanner.svelte';
	import FontPicker from '$lib/components/FontPicker.svelte';
	import LoadingSpinner from '$lib/components/LoadingSpinner.svelte';
	import RouteNav from '$lib/components/RouteNav.svelte';
	import SearchBar from '$lib/components/SearchBar.svelte';
	import SummaryThumbnail from '$lib/components/SummaryThumbnail.svelte';
	import { buildCachedUserSummary } from '$lib/utils/cachedSummary';
	import { postKey } from '$lib/utils/viewerCacheSync';
	import { buildBskyPostUrl } from '$lib/utils/viewerLinks';

	type MentionProfileMap = Record<string, ProfileInfo>;
	type SummarySectionKey = 'mentions' | 'liked' | 'reposted' | 'repeated' | 'threads';
	type VisibleSummaryCounts = Record<SummarySectionKey, number>;

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

	let fontKey = $state('patrick');
	let fontFamily = $derived(fontFamilies[fontKey] ?? fontFamilies.virgil);
	let initialHandle = $state('');
	let profile = $state<ProfileInfo | null>(null);
	let summary = $state<CachedUserSummary | null>(null);
	let mentionProfiles = $state<MentionProfileMap>({});
	let loading = $state(false);
	let progress = $state<DiscoverProgress>({
		phase: 'Loading cached summary…',
		current: 0,
		total: 0
	});
	let resolvingMentions = $state(false);
	let error = $state<string | null>(null);
	let loadToken = 0;
	let mentionToken = 0;
	let loadController: AbortController | null = null;
	let visibleCounts = $state<VisibleSummaryCounts>(createInitialVisibleCounts());

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
		const returnTo = handle ? `/summary?handle=${encodeURIComponent(handle)}` : '/summary';
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

	async function loadCachedPostsInChunks(
		did: string,
		signal: AbortSignal
	): Promise<{
		posts: any[];
		cachedPostCount: number;
		updatedAt: string | null;
		partial: boolean;
	}> {
		const status = await fetchPostMeta(did);
		const targetPosts = Math.max(0, status.postCount);
		const mergedFeedPosts: any[] = [];
		const seenKeys = new Set<string>();
		const headGroups = status.head?.groups ?? [];
		const headPostCount = status.head?.postCount ?? 0;
		const tailChunkCount = status.tail?.chunkCount ?? 0;
		let fallbackKey = 0;
		let partial = false;
		let headOffset = 0;

		throwIfAborted(signal);
		progress = {
			phase: targetPosts > 0 ? 'Preparing cached posts…' : 'No cached posts found',
			current: 0,
			total: targetPosts
		};

		for (const group of headGroups) {
			for (let batchIndex = 0; batchIndex < group.batches.length; batchIndex++) {
				const batchCount = group.batches[batchIndex]?.postCount ?? 0;
				if (batchCount <= 0) continue;

				progress = {
					phase: `Loading cached head batch ${batchIndex + 1}/${group.batches.length}…`,
					current: mergedFeedPosts.length,
					total: targetPosts
				};

				const batch = await fetchCachedHeadBatchPage(did, group.id, batchIndex, signal);
				throwIfAborted(signal);
				if (batch.missing) {
					partial = true;
					headOffset += batchCount;
					continue;
				}

				for (const item of batch.posts) {
					const key = postKey(item) ?? `head:${fallbackKey++}`;
					if (seenKeys.has(key)) continue;
					seenKeys.add(key);
					mergedFeedPosts.push(item);
					if (mergedFeedPosts.length >= targetPosts) break;
				}

				headOffset += batchCount;
				if (mergedFeedPosts.length >= targetPosts) {
					break;
				}
			}

			if (mergedFeedPosts.length >= targetPosts) {
				break;
			}
		}

		let chunkIndex = 0;
		while (mergedFeedPosts.length < targetPosts) {
			progress = {
				phase:
					tailChunkCount > 0
						? `Loading cache chunk ${chunkIndex + 1}/${tailChunkCount}…`
						: 'Loading cached posts…',
				current: mergedFeedPosts.length,
				total: targetPosts
			};

			const chunk = await fetchCachedChunkPage(did, chunkIndex, signal);
			throwIfAborted(signal);
			if (chunk.missing) {
				partial = true;
				chunkIndex += 1;
				if (tailChunkCount <= 0 || chunkIndex >= tailChunkCount) break;
				continue;
			}

			if (chunk.posts.length === 0) break;

			for (const item of chunk.posts) {
				const key = postKey(item) ?? `chunk:${fallbackKey++}`;
				if (seenKeys.has(key)) continue;
				seenKeys.add(key);
				mergedFeedPosts.push(item);
			}

			chunkIndex += 1;
			if (tailChunkCount <= 0 || chunkIndex >= tailChunkCount) break;
		}

		if (mergedFeedPosts.length > targetPosts) {
			mergedFeedPosts.length = targetPosts;
		}

		if (headOffset < headPostCount) {
			partial = true;
		}

		return {
			posts: mergedFeedPosts,
			cachedPostCount: targetPosts,
			updatedAt: status.updatedAt,
			partial
		};
	}

	async function loadSummaryForProfile(nextProfile: ProfileInfo) {
		const token = ++loadToken;
		loadController?.abort();
		loadController = new AbortController();
		loading = true;
		error = null;
		profile = nextProfile;
		summary = null;
		mentionProfiles = {};
		resetVisibleCounts();
		initialHandle = nextProfile.handle;
		updateHandleQuery(nextProfile.handle);

		try {
			// Try server-cached summary first
			progress = { phase: 'Checking cached summary…', current: 0, total: 0 };
			let usedCache = false;
			try {
				const res = await fetch(
					`/api/summary/${encodeURIComponent(nextProfile.did)}`,
					{ signal: loadController.signal }
				);
				if (res.ok) {
					const envelope = await res.json();
					if (token !== loadToken) return;
					if (envelope?.summary?.did === nextProfile.did) {
						summary = envelope.summary as CachedUserSummary;
						void loadMentionProfiles(summary.mostMentionedUsers.map((entry) => entry.did));
						usedCache = true;
					}
				}
			} catch (err: any) {
				if (err?.name === 'AbortError') throw err;
				// Fall through to client-side computation
			}

			if (usedCache) return;

			// Fall back to client-side computation
			const cache = await loadCachedPostsInChunks(nextProfile.did, loadController.signal);

			if (token !== loadToken) return;
			if (cache.cachedPostCount <= 0) {
				error = `No cached posts were found for @${nextProfile.handle}. Load that account in the thread viewer first.`;
				return;
			}

			progress = {
				phase: 'Ranking cached posts…',
				current: cache.posts.length,
				total: cache.cachedPostCount
			};

			const nextSummary = buildCachedUserSummary({
				did: nextProfile.did,
				feedPosts: cache.posts,
				cachedPostCount: cache.cachedPostCount,
				updatedAt: cache.updatedAt,
				partial: cache.partial,
				mentionLimit: FULL_SUMMARY_LIMIT,
				postLimit: FULL_SUMMARY_LIMIT,
				threadLimit: FULL_SUMMARY_LIMIT
			});

			if (token !== loadToken) return;

			summary = nextSummary;
			void loadMentionProfiles(nextSummary.mostMentionedUsers.map((entry) => entry.did));

			// Fire-and-forget upload to server cache
			void fetch(`/api/summary/${encodeURIComponent(nextProfile.did)}`, {
				method: 'PUT',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ summary: nextSummary })
			}).catch(() => {});
		} catch (err: any) {
			if (token !== loadToken || err?.name === 'AbortError') return;
			error = err?.message || `Could not load a cached summary for @${nextProfile.handle}.`;
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
			const nextProfile = await getProfile(nextHandle);
			await loadSummaryForProfile(nextProfile);
		} catch (err: any) {
			error = err?.message || `Could not resolve @${nextHandle}.`;
			profile = null;
			summary = null;
			mentionProfiles = {};
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

	function handleCachedUserSelect(nextProfile: ProfileInfo) {
		void loadSummaryForProfile(nextProfile);
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
	<title>Cached Summary</title>
</svelte:head>

<main style="font-family: {fontFamily}">
	<header class="page-header">
		<RouteNav current="summary" align="center" handle={profile?.handle ?? initialHandle ?? null} />
		<h1>Cached Summary</h1>
		<p class="subtitle">
			Pick a cached Bluesky user to see who they @ mention most, which posts drew the most likes
			and reposts, and which threads pulled the most replies.
		</p>
		<FontPicker value={fontKey} onchange={handleFontChange} />
	</header>

	<section class="lookup-panel wobbly-border-light">
		<SearchBar
			onsearch={loadSummaryFromHandle}
			onprofile={handleProfileSelected}
			disabled={loading}
			{initialHandle}
			placeholder="Search for a cached Bluesky user..."
			buttonLabel="Load Summary"
		/>
		<p class="lookup-note">
			This page reads from the local cache. If a handle is missing, load that account in the thread
			viewer first and come back here.
		</p>
		<CachedUsers onselect={handleCachedUserSelect} />
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
					<p class="eyebrow">Summary for</p>
					<h2>{profile.displayName || profile.handle}</h2>
					<p class="hero-handle">@{profile.handle}</p>
				</div>
			</div>
			<div class="hero-stats">
				<div class="stat-chip">
					<span class="stat-label">Cached posts</span>
					<strong>{summary.cachedPostCount.toLocaleString()}</strong>
				</div>
				<div class="stat-chip">
					<span class="stat-label">Analyzed posts</span>
					<strong>{summary.analyzedPostCount.toLocaleString()}</strong>
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
				<span>Cache updated {formatDateTime(summary.updatedAt)}</span>
				{#if summary.partial}
					<span class="partial-pill">Partial cache read</span>
				{/if}
			</div>
		</section>

		<section class="summary-grid">
			<article class="panel wobbly-border-light">
				<div class="panel-heading">
					<h3>Most Mentioned Users</h3>
					<p>Counted from `@` mention facets in cached posts.</p>
				</div>
				{#if resolvingMentions && summary.mostMentionedUsers.length > 0}
					<p class="loading-note">Resolving handles…</p>
				{/if}
				{#if summary.mostMentionedUsers.length === 0}
					<p class="empty-state">No mention facets were found in the cached posts.</p>
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
					<p>Highest-like posts in the cached author feed.</p>
				</div>
				{#if summary.mostLikedPosts.length === 0}
					<p class="empty-state">No liked posts were found in the cached data yet.</p>
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
					<p>Top posts by repost count from the same cache.</p>
				</div>
				{#if summary.mostRepostedPosts.length === 0}
					<p class="empty-state">No reposted posts were found in the cached data yet.</p>
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
						<p>Exact-text matches across cached posts, with link facets resolved so shortened Bluesky URLs do not collapse different posts.</p>
					</div>
					{#if summary.mostRepeatedPosts.length === 0}
						<p class="empty-state">No exact repeated posts were found in the cached data yet.</p>
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
						<p>Reply totals are summed across each discovered self-thread in the cache.</p>
					</div>
				{#if summary.threadsWithMostReplies.length === 0}
					<p class="empty-state">No reply-heavy threads were found in the cached data yet.</p>
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
		margin: 12px auto 18px;
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
