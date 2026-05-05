<script lang="ts">
	import { browser } from '$app/environment';
	import { onMount } from 'svelte';
	import '../../app.css';
	import SearchBar from '$lib/components/SearchBar.svelte';
	import LoadingSpinner from '$lib/components/LoadingSpinner.svelte';
	import ErrorBanner from '$lib/components/ErrorBanner.svelte';
	import FontPicker from '$lib/components/FontPicker.svelte';
	import RouteNav from '$lib/components/RouteNav.svelte';
	import AnalyzerPane from '$lib/components/analyzer/AnalyzerPane.svelte';
	import AnalyzerCompareOverlay from '$lib/components/analyzer/AnalyzerCompareOverlay.svelte';
	import { getProfile, getProfiles, type ProfileInfo } from '$lib/api/bluesky';
	import { toastInfo } from '$lib/utils/toasts';
	import { clusterCoordinates, normalizeVector, projectEmbeddings } from '$lib/utils/threadAnalysis';
	import type { ThreadAnalysisPoint, ThreadAnalysisResult } from '$lib/types';
	import type {
		AnalyzerCompareThreadSelection,
		AnalyzerLoadedAccount,
		AnalyzerPaneSelectionRequest,
		BatchSegmentPayload,
		CachedAnalysisAccount,
		CachedAnalysisIndexResponse,
		SequenceMetricTab
	} from '$lib/components/analyzer/types';
	import {
		REQUIRED_COMPARE_MAX_POSTS,
		buildAnalyzerSummaryCards,
		buildCompareCandidates,
		findCachedAnalysisAccount,
		isCompareEligible,
		shouldResetCompareState
	} from '$lib/utils/analyzerCompare';

	const fontFamilies: Record<string, string> = {
		virgil: "'Virgil', cursive",
		caveat: "'Caveat', cursive",
		patrick: "'Patrick Hand', cursive",
		'comic-neue': "'Comic Neue', cursive",
		inter: "'Inter', sans-serif",
		system: 'system-ui, -apple-system, sans-serif'
	};

	const EMBEDDING_MODEL_LABEL = '@cf/baai/bge-small-en-v1.5 (cls)';
	const ANALYZER_POST_LIMIT = REQUIRED_COMPARE_MAX_POSTS;

	type BatchThreadPayload = Omit<ThreadAnalysisPoint, 'x' | 'y' | 'cluster'> & {
		embedding: number[];
	};

	type AnalyzerBatchPayload = ThreadAnalysisResult & {
		batch?: {
			threadOffset: number;
			nextThreadOffset: number;
			hasMore: boolean;
			totalThreads: number;
			threads: BatchThreadPayload[];
			segments: BatchSegmentPayload[];
			stats: ThreadAnalysisResult['stats'];
		};
	};

	let fontKey = $state('patrick');
	let fontFamily = $derived(fontFamilies[fontKey] ?? fontFamilies.virgil);
	let initialHandle = $state('');
	let pendingPrimaryProfile: ProfileInfo | null = $state(null);
	let primary = $state<AnalyzerLoadedAccount | null>(null);
	let secondary = $state<AnalyzerLoadedAccount | null>(null);
	let loading = $state(false);
	let secondaryLoading = $state(false);
	let secondaryLoadingLabel = $state('');
	let error: string | null = $state(null);
	let compareError: string | null = $state(null);
	let cachedAnalyses = $state<CachedAnalysisAccount[]>([]);
	let cachedAnalysesLoading = $state(false);
	let cachedAnalysesError: string | null = $state(null);
	let cachedAnalysesOpen = $state(true);
	let viewMode = $state<'single' | 'compare'>('single');
	let comparePickerOpen = $state(false);
	let metricTab = $state<SequenceMetricTab>('novelty');
	let metricListSortOrder = $state<'asc' | 'desc'>('desc');
	let primaryRequestId = 0;
	let secondaryRequestId = 0;
	let compareSelectionToken = 0;
	let primarySelectionRequest = $state<AnalyzerPaneSelectionRequest | null>(null);
	let secondarySelectionRequest = $state<AnalyzerPaneSelectionRequest | null>(null);

	function handleFontChange(key: string) {
		fontKey = key;
		try {
			localStorage.setItem('preferred-font', key);
		} catch {}
	}

	function updateUrl(handle: string) {
		if (!browser) return;
		const url = new URL(window.location.href);
		if (handle) {
			url.searchParams.set('handle', handle.replace(/^@/, '').trim());
		} else {
			url.searchParams.delete('handle');
		}
		url.searchParams.delete('mode');
		window.history.replaceState({}, '', url.toString());
	}

	function appendWarning(current: string | undefined, next: string | undefined): string | undefined {
		if (!next) return current;
		if (!current) return next;
		if (current.includes(next)) return current;
		return `${current} ${next}`;
	}

	function emptyGlobalDistinctivenessAnalysis(): ThreadAnalysisResult['globalDistinctiveness'] {
		return {
			model: EMBEDDING_MODEL_LABEL,
			comparedTo: 'Global analyzer centroid',
			available: false,
			corpusSize: 0,
			threadsCompared: 0,
			averageDistinctiveness: 0,
			maxDistinctiveness: 0,
			points: []
		};
	}

	function buildAggregatedGlobalDistinctiveness(
		source: ThreadAnalysisResult['globalDistinctiveness'],
		threads: BatchThreadPayload[]
	): ThreadAnalysisResult['globalDistinctiveness'] {
		const scored = threads.filter(
			(thread): thread is BatchThreadPayload & { globalDistinctiveness: number } =>
				typeof thread.globalDistinctiveness === 'number'
		);

		if (scored.length === 0) {
			return source?.available
				? {
						...source,
						threadsCompared: 0,
						averageDistinctiveness: 0,
						maxDistinctiveness: 0,
						points: []
					}
				: emptyGlobalDistinctivenessAnalysis();
		}

		const total = scored.reduce((sum, thread) => sum + thread.globalDistinctiveness, 0);
		const maxDistinctiveness = scored.reduce(
			(max, thread) => Math.max(max, thread.globalDistinctiveness),
			0
		);

		return {
			model: source?.model ?? EMBEDDING_MODEL_LABEL,
			comparedTo: source?.comparedTo ?? 'Global analyzer centroid',
			available: true,
			corpusSize: source?.corpusSize ?? 0,
			threadsCompared: scored.length,
			averageDistinctiveness: total / scored.length,
			maxDistinctiveness,
			points: scored.map((thread) => ({
				rootUri: thread.rootUri,
				score: thread.globalDistinctiveness,
				title: thread.title,
				preview: thread.preview
			}))
		};
	}

	function buildAggregatedResult(
		payload: AnalyzerBatchPayload,
		threads: BatchThreadPayload[],
		segments: BatchSegmentPayload[],
		stats: ThreadAnalysisResult['stats'],
		warning: string | undefined,
		rateLimited: boolean,
		usedBatchApi: boolean
	): ThreadAnalysisResult {
		const coordinates = projectEmbeddings(threads.map((thread) => thread.embedding));
		const clusters = clusterCoordinates(coordinates);
		const globalDistinctiveness = buildAggregatedGlobalDistinctiveness(
			payload.globalDistinctiveness,
			threads
		);

		return {
			model: payload.model,
			usedBatchApi,
			rateLimited,
			warning,
			generatedAt: payload.generatedAt,
			points: threads.map((thread, index) => ({
				rootUri: thread.rootUri,
				depth: thread.depth,
				postCount: thread.postCount,
				segmentCount: thread.segmentCount,
				globalDistinctiveness: thread.globalDistinctiveness ?? null,
				embedding: thread.embedding,
				x: coordinates[index]?.x ?? 0,
				y: coordinates[index]?.y ?? 0,
				cluster: clusters[index] ?? 0,
				title: thread.title,
				preview: thread.preview,
				text: thread.text,
				posts: thread.posts,
				segments: thread.segments
			})),
			novelty: buildAggregatedNovelty(segments),
			globalDistinctiveness,
			stats: {
				...stats,
				threadsAnalyzed: threads.length
			}
		};
	}

	function dotProduct(a: number[], b: number[]): number {
		let total = 0;
		const length = Math.min(a.length, b.length);
		for (let i = 0; i < length; i++) {
			total += a[i] * b[i];
		}
		return total;
	}

	function buildAggregatedNovelty(segments: BatchSegmentPayload[]): ThreadAnalysisResult['novelty'] {
		if (segments.length === 0) {
			return {
				model: EMBEDDING_MODEL_LABEL,
				firstValue: 0,
				postsConsidered: 0,
				postsAnalyzed: 0,
				skippedForCache: 0,
				averageNovelty: 0,
				maxNovelty: 0,
				latestNovelty: 0,
				points: []
			};
		}

		const points: ThreadAnalysisResult['novelty']['points'] = [];
		let centroid: number[] | null = null;
		let noveltyTotal = 0;
		let maxNovelty = 0;
		let latestNovelty = 0;

		for (let index = 0; index < segments.length; index++) {
			const segment = segments[index];
			const normalized = normalizeVector(segment.embedding);
			let novelty = 0;

			if (centroid) {
				const centroidUnit = normalizeVector(centroid);
				const cosine = Math.max(-1, Math.min(1, dotProduct(normalized, centroidUnit)));
				novelty = 1 - cosine;
			}

			points.push({
				index: index + 1,
				uri: segment.uri,
				rootUri: segment.rootUri,
				createdAt: segment.createdAt,
				novelty,
				title: segment.title,
				text: segment.text
			});

			const nextCount = index + 1;
			noveltyTotal += novelty;
			maxNovelty = Math.max(maxNovelty, novelty);
			latestNovelty = novelty;

			if (!centroid) {
				centroid = normalized.slice();
			} else {
				for (let axis = 0; axis < centroid.length; axis++) {
					centroid[axis] = ((nextCount - 1) * centroid[axis] + normalized[axis]) / nextCount;
				}
			}
		}

		return {
			model: EMBEDDING_MODEL_LABEL,
			firstValue: 0,
			postsConsidered: segments.length,
			postsAnalyzed: segments.length,
			skippedForCache: 0,
			averageNovelty: noveltyTotal / segments.length,
			maxNovelty,
			latestNovelty,
			points
		};
	}

	function resetSharedMetricControls() {
		metricTab = 'novelty';
		metricListSortOrder = 'desc';
	}

	function resetCompareSelections() {
		primarySelectionRequest = null;
		secondarySelectionRequest = null;
	}

	function resetCompareState() {
		secondaryRequestId += 1;
		secondary = null;
		secondaryLoading = false;
		secondaryLoadingLabel = '';
		viewMode = 'single';
		comparePickerOpen = false;
		compareError = null;
		resetCompareSelections();
	}

	function formatRelativeTime(value: string): string {
		const parsed = new Date(value);
		if (!Number.isFinite(parsed.getTime())) return value;

		const diffMs = parsed.getTime() - Date.now();
		const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
		const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
			['day', 1000 * 60 * 60 * 24],
			['hour', 1000 * 60 * 60],
			['minute', 1000 * 60]
		];

		for (const [unit, step] of units) {
			if (Math.abs(diffMs) >= step || unit === 'minute') {
				return formatter.format(Math.round(diffMs / step), unit);
			}
		}

		return formatter.format(0, 'minute');
	}

	function buildCachedProfile(account: CachedAnalysisAccount): ProfileInfo | null {
		if (!account.handle) return null;
		return {
			did: account.did,
			handle: account.handle,
			displayName: account.displayName,
			avatar: account.avatar,
			postsCount: 0
		};
	}

	function matchesActor(profile: ProfileInfo | null | undefined, actor: string): boolean {
		if (!profile) return false;
		const cleaned = actor.replace(/^@/, '').trim();
		return profile.did === cleaned || profile.handle === cleaned;
	}

	function accountLabel(
		account?: {
			displayName?: string;
			handle?: string;
			did?: string;
		} | null
	): string {
		if (!account) return 'Unknown account';
		if (account.displayName) return account.displayName;
		if (account.handle) return `@${account.handle}`;
		return account.did || 'Unknown account';
	}

	async function loadCachedAnalyses() {
		cachedAnalysesLoading = true;
		cachedAnalysesError = null;

		try {
			const response = await fetch('/api/analyzer/cache-index');
			const payload = (await response.json().catch(() => null)) as CachedAnalysisIndexResponse | null;

			if (!response.ok) {
				throw new Error((payload as any)?.message || `Cache index failed: ${response.status}`);
			}

			const accounts = Array.isArray(payload?.accounts) ? payload.accounts : [];
			if (accounts.length === 0) {
				cachedAnalyses = [];
				return;
			}

			const profiles = await getProfiles(accounts.map((account) => account.did));
			const profilesByDid = new Map(profiles.map((profile) => [profile.did, profile]));

			cachedAnalyses = accounts.map((account) => {
				const profile = profilesByDid.get(account.did);
				return {
					...account,
					handle: profile?.handle,
					displayName: profile?.displayName,
					avatar: profile?.avatar
				};
			});
		} catch (error: any) {
			cachedAnalysesError = error?.message || 'Failed to load cached analyses.';
			cachedAnalyses = [];
		} finally {
			cachedAnalysesLoading = false;
		}
	}

	async function fetchAnalysisForProfile(profile: ProfileInfo): Promise<AnalyzerLoadedAccount> {
		let threadOffset = 0;
		let guard = 0;
		let aggregatePayload: AnalyzerBatchPayload | null = null;
		let aggregateWarning: string | undefined;
		let aggregateRateLimited = false;
		let aggregateUsedBatchApi = true;
		const aggregateThreads: BatchThreadPayload[] = [];
		const aggregateSegments: BatchSegmentPayload[] = [];
		const aggregateStats: ThreadAnalysisResult['stats'] = {
			postsScanned: 0,
			chainStarts: 0,
			threadsWithSelfReplies: 0,
			threadsAnalyzed: 0,
			segmentCount: 0,
			cacheHits: 0,
			cacheMisses: 0,
			skippedForCache: 0
		};
		let finalResult: ThreadAnalysisResult | null = null;

		while (guard < 100) {
			const response = await fetch('/api/analyzer', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json'
				},
				body: JSON.stringify({
					did: profile.did,
					maxPosts: ANALYZER_POST_LIMIT,
					threadOffset
				})
			});

			const payload = (await response.json().catch(() => null)) as AnalyzerBatchPayload | null;
			if (!response.ok) {
				throw new Error((payload as any)?.message || `Server error: ${response.status}`);
			}
			if (!payload) {
				throw new Error('Analyzer returned an empty response.');
			}

			aggregatePayload = payload;
			aggregateWarning = appendWarning(aggregateWarning, payload.warning);
			aggregateRateLimited = aggregateRateLimited || payload.rateLimited;
			aggregateUsedBatchApi = aggregateUsedBatchApi && payload.usedBatchApi;

			const batch = payload.batch;
			if (!batch) {
				finalResult = payload;
				break;
			}

			aggregateStats.postsScanned = batch.stats.postsScanned;
			aggregateStats.chainStarts = batch.stats.chainStarts;
			aggregateStats.threadsWithSelfReplies = batch.totalThreads;
			aggregateStats.segmentCount += batch.stats.segmentCount;
			aggregateStats.cacheHits += batch.stats.cacheHits;
			aggregateStats.cacheMisses += batch.stats.cacheMisses;
			aggregateStats.skippedForCache += batch.stats.skippedForCache;
			aggregateThreads.push(...batch.threads);
			aggregateSegments.push(...batch.segments);

			if (!batch.hasMore || batch.nextThreadOffset <= threadOffset) {
				finalResult = buildAggregatedResult(
					payload,
					aggregateThreads,
					aggregateSegments,
					aggregateStats,
					aggregateWarning,
					aggregateRateLimited,
					aggregateUsedBatchApi
				);
				break;
			}

			threadOffset = batch.nextThreadOffset;
			guard += 1;
		}

		if (!finalResult && aggregatePayload) {
			finalResult = buildAggregatedResult(
				aggregatePayload,
				aggregateThreads,
				aggregateSegments,
				aggregateStats,
				aggregateWarning,
				aggregateRateLimited,
				aggregateUsedBatchApi
			);
		}

		if (!finalResult) {
			throw new Error('Analyzer did not return a usable result.');
		}

		return {
			profile,
			result: finalResult,
			segments: aggregateSegments
		};
	}

	async function handlePrimarySearch(
		handle: string,
		options: {
			profile?: ProfileInfo | null;
		} = {}
	) {
		const cleaned = handle.replace(/^@/, '').trim();
		if (!cleaned || loading) return;

		const requestId = ++primaryRequestId;
		const previousPrimaryDid = primary?.profile.did ?? null;
		loading = true;
		error = null;
		compareError = null;
		primary = null;

		try {
			let profile = options.profile;
			if (!matchesActor(profile, cleaned)) {
				if (matchesActor(pendingPrimaryProfile, cleaned)) {
					profile = pendingPrimaryProfile;
				} else {
					profile = await getProfile(cleaned);
				}
			}

			if (requestId !== primaryRequestId || !profile) {
				return;
			}

			if (shouldResetCompareState(previousPrimaryDid, profile.did)) {
				resetCompareState();
			}

			const loaded = await fetchAnalysisForProfile(profile);
			if (requestId !== primaryRequestId) {
				return;
			}

			primary = loaded;
			initialHandle = profile.handle;
			pendingPrimaryProfile = profile;
			updateUrl(profile.handle);
			resetSharedMetricControls();
			await loadCachedAnalyses();

			if (loaded.result.points.length === 0) {
				toastInfo('No self-reply threads were found in the first 1,000 feed items.');
			}
		} catch (e: any) {
			if (requestId !== primaryRequestId) {
				return;
			}

			if (e?.message?.includes('Unable to resolve handle') || e?.message?.includes('Profile not found')) {
				error = `Could not find handle "${cleaned}".`;
			} else {
				error = e?.message || 'Failed to analyze this account.';
			}
		} finally {
			if (requestId === primaryRequestId) {
				loading = false;
			}
		}
	}

	async function loadSecondaryComparison(account: CachedAnalysisAccount) {
		if (!primary || secondaryLoading) return;

		const requestId = ++secondaryRequestId;
		secondaryLoading = true;
		secondaryLoadingLabel = accountLabel(account);
		compareError = null;

		try {
			const profile = buildCachedProfile(account) ?? (await getProfile(account.did));
			const loaded = await fetchAnalysisForProfile(profile);
			if (requestId !== secondaryRequestId) {
				return;
			}

			secondary = loaded;
			viewMode = 'compare';
			comparePickerOpen = false;
			resetSharedMetricControls();
			await loadCachedAnalyses();
		} catch (e: any) {
			if (requestId !== secondaryRequestId) {
				return;
			}
			compareError = e?.message || 'Failed to load the comparison account.';
		} finally {
			if (requestId === secondaryRequestId) {
				secondaryLoading = false;
				secondaryLoadingLabel = '';
			}
		}
	}

	function handleProfileSelected(profile: ProfileInfo) {
		pendingPrimaryProfile = profile;
	}

	function startComparePicker() {
		if (!primaryCompareEligible || loading) return;
		comparePickerOpen = true;
		compareError = null;
		cachedAnalysesOpen = true;
	}

	function closeCompareMode() {
		resetCompareState();
	}

	function focusCompareThread(selection: AnalyzerCompareThreadSelection) {
		compareSelectionToken += 1;
		const request: AnalyzerPaneSelectionRequest = {
			token: compareSelectionToken,
			rootUri: selection.rootUri,
			metricPoint: selection.metricPoint
		};

		if (selection.series === 'primary') {
			primarySelectionRequest = request;
		} else {
			secondarySelectionRequest = request;
		}

		if (!browser) return;
		const paneId =
			selection.series === 'primary' ? 'primary-compare-pane' : 'secondary-compare-pane';
		window.requestAnimationFrame(() => {
			document.getElementById(paneId)?.scrollIntoView({
				behavior: 'smooth',
				block: 'start'
			});
		});
	}

	function toggleCachedAnalyses() {
		cachedAnalysesOpen = !cachedAnalysesOpen;
	}

	function openCachedAnalysis(account: CachedAnalysisAccount) {
		if (loading) return;
		if (comparePickerOpen) {
			void loadSecondaryComparison(account);
			return;
		}

		void handlePrimarySearch(account.handle || account.did, {
			profile: buildCachedProfile(account)
		});
	}

	onMount(() => {
		try {
			const saved = localStorage.getItem('preferred-font');
			if (saved && saved in fontFamilies) {
				fontKey = saved;
			}
		} catch {}

		void loadCachedAnalyses();

		const params = new URLSearchParams(window.location.search);
		const handle = params.get('handle');
		if (handle) {
			initialHandle = handle;
			void handlePrimarySearch(handle);
		}
	});

	const primaryCacheEntry = $derived(
		primary ? findCachedAnalysisAccount(cachedAnalyses, primary.profile.did) : null
	);
	const secondaryCacheEntry = $derived(
		secondary ? findCachedAnalysisAccount(cachedAnalyses, secondary.profile.did) : null
	);
	const primaryCompareEligible = $derived(isCompareEligible(primaryCacheEntry, ANALYZER_POST_LIMIT));
	const compareCandidates = $derived(
		buildCompareCandidates(cachedAnalyses, primary?.profile.did, ANALYZER_POST_LIMIT)
	);
	const displayedCachedAnalyses = $derived(comparePickerOpen ? compareCandidates : cachedAnalyses);
	const primarySummaryCards = $derived(primary ? buildAnalyzerSummaryCards(primary.result) : []);
	const secondarySummaryCards = $derived(secondary ? buildAnalyzerSummaryCards(secondary.result) : []);
	const compareReady = $derived(viewMode === 'compare' && secondary !== null);
</script>

<svelte:head>
	<title>Thread Analyzer</title>
</svelte:head>

<main style="font-family: {fontFamily}; --font-hand: {fontFamily};">
	<header class="hero">
		<div class="hero-copy">
			<RouteNav current="analyzer" />
			<h1>Thread Analyzer</h1>
			<p class="subtitle">
				Pull the newest 1,000 feed items, compress self-reply chains into paragraph chunks, and map
				them by embedding similarity.
			</p>
		</div>
		<FontPicker value={fontKey} onchange={handleFontChange} />
	</header>

	<section class="search-panel wobbly-border">
		<SearchBar
			onsearch={handlePrimarySearch}
			onprofile={handleProfileSelected}
			disabled={loading}
			{initialHandle}
		/>
		<p class="search-note">
			Reuses a saved analyzer batch when one already exists. Otherwise it fetches the latest feed,
			embeds uncached paragraph chunks with Cloudflare Workers AI, and saves the batch in R2.
		</p>
	</section>

	{#if primary}
		<section class="account-bar wobbly-border-light">
			<div>
				<span class="account-eyebrow">{compareReady ? 'Compare Mode' : 'Loaded Account'}</span>
				<h2>
					{#if compareReady && secondary}
						{accountLabel(primary.profile)} vs {accountLabel(secondary.profile)}
					{:else}
						{accountLabel(primary.profile)}
					{/if}
				</h2>
				<p class="account-subtitle">
					<span>@{primary.profile.handle}</span>
					{#if primaryCacheEntry}
						<span>• cached {formatRelativeTime(primaryCacheEntry.updatedAt)}</span>
						<span>• up to {primaryCacheEntry.maxPosts} posts</span>
					{:else}
						<span>• compare requires a cached 1,000-post analysis</span>
					{/if}
					{#if compareReady && secondary && secondaryCacheEntry}
						<span>• @{secondary.profile.handle}</span>
						<span>• cached {formatRelativeTime(secondaryCacheEntry.updatedAt)}</span>
						<span>• up to {secondaryCacheEntry.maxPosts} posts</span>
					{/if}
				</p>
				{#if comparePickerOpen}
					<p class="account-status">
						Pick another cached account below. Compare only works for saved 1,000-post analyzer runs.
					</p>
				{:else if secondaryLoading}
					<p class="account-status">Loading comparison for {secondaryLoadingLabel}…</p>
				{:else if !compareReady && !primaryCompareEligible}
					<p class="account-status">
						Compare stays disabled until this account appears in the analyzer cache index with up to
						1,000 posts.
					</p>
				{/if}
				{#if compareError}
					<p class="compare-error">{compareError}</p>
				{/if}
			</div>
			<div class="account-actions">
				{#if compareReady}
					<button type="button" class="mode-btn wobbly-border-light" onclick={startComparePicker}>
						Replace
					</button>
					<button type="button" class="mode-btn wobbly-border-light" onclick={closeCompareMode}>
						Close compare
					</button>
				{:else}
					<button
						type="button"
						class="mode-btn wobbly-border-light"
						onclick={startComparePicker}
						disabled={!primaryCompareEligible || loading}
					>
						Compare
					</button>
				{/if}
			</div>
		</section>
	{/if}

	<section class="cached-panel wobbly-border-light">
		<div class="cached-head">
			<div>
				<h2>{comparePickerOpen ? 'Choose Comparison Account' : 'Cached Analyses'}</h2>
				<p class="cached-subtitle">
					{#if comparePickerOpen}
						Only cached accounts with a saved 1,000-post analyzer batch can be selected for compare.
					{:else}
						Previously analyzed accounts already have cluster batches in R2. Clicking one reloads the
						latest saved batch directly.
					{/if}
				</p>
			</div>
			<div class="cached-controls">
				{#if displayedCachedAnalyses.length > 0}
					<span class="cached-count">{displayedCachedAnalyses.length} accounts</span>
				{/if}
				<button
					type="button"
					class="mode-btn wobbly-border-light cached-toggle"
					aria-expanded={cachedAnalysesOpen}
					onclick={toggleCachedAnalyses}
				>
					{cachedAnalysesOpen ? 'Collapse' : 'Expand'}
				</button>
			</div>
		</div>

		{#if cachedAnalysesOpen}
			{#if cachedAnalysesLoading}
				<p class="cached-empty">Loading cached analyzer runs…</p>
			{:else if cachedAnalysesError}
				<p class="cached-error">{cachedAnalysesError}</p>
			{:else if displayedCachedAnalyses.length === 0}
				<p class="cached-empty">
					{#if comparePickerOpen}
						No other cached 1,000-post analyzer runs are available to compare yet.
					{:else}
						No analyzer cache has been saved to R2 yet.
					{/if}
				</p>
			{:else}
				<div class="cached-scroll">
					<div class="cached-grid">
						{#each displayedCachedAnalyses as account}
							<button
								type="button"
								class="cached-account wobbly-border-light"
								class:active={!comparePickerOpen && primary?.profile.did === account.did}
								class:compare-selected={secondary?.profile.did === account.did}
								onclick={() => openCachedAnalysis(account)}
							>
								<div class="cached-account-topline">
									<strong>{account.displayName || account.handle || account.did}</strong>
									<span>{formatRelativeTime(account.updatedAt)}</span>
								</div>
								<div class="cached-account-meta">
									<span>{account.handle ? `@${account.handle}` : account.did}</span>
									<span>up to {account.maxPosts} posts</span>
								</div>
								{#if secondary?.profile.did === account.did}
									<span class="cached-account-tag">Current comparison</span>
								{:else if comparePickerOpen}
									<span class="cached-account-tag">Select for compare</span>
								{/if}
							</button>
						{/each}
					</div>
				</div>
			{/if}
		{/if}
	</section>

	{#if error}
		<ErrorBanner message={error} />
	{/if}

	{#if loading}
		<LoadingSpinner progress={{ phase: 'Analyzing the first 1,000 posts...', current: 0, total: 0 }} />
	{/if}

	{#if primary && !loading}
			{#if compareReady && secondary}
				<section class="summary-grid compare-summary-grid">
				{#each primarySummaryCards as card, index}
					<div class="summary-card summary-card-compare wobbly-border-light">
						<span class="summary-label">{card.label}</span>
						<div class="summary-compare-columns">
							<div class="summary-side">
								<span class="summary-side-label">{accountLabel(primary.profile)}</span>
								<strong>{card.value}</strong>
								<small>{card.detail}</small>
							</div>
							<div class="summary-side">
								<span class="summary-side-label">{accountLabel(secondary.profile)}</span>
								<strong>{secondarySummaryCards[index]?.value}</strong>
								<small>{secondarySummaryCards[index]?.detail}</small>
							</div>
						</div>
					</div>
				{/each}
				</section>

				<AnalyzerCompareOverlay
					primary={primary}
					secondary={secondary}
					bind:metricTab
					onSelectThread={focusCompareThread}
				/>

				<section class="compare-pane-grid">
				<AnalyzerPane
					analysis={primary}
					bind:metricTab
					bind:metricListSortOrder
					compareMode={true}
					paneLabel="Primary"
					paneId="primary-compare-pane"
					selectionRequest={primarySelectionRequest}
				/>
				<AnalyzerPane
					analysis={secondary}
					bind:metricTab
					bind:metricListSortOrder
					compareMode={true}
					paneLabel="Comparison"
					paneId="secondary-compare-pane"
					selectionRequest={secondarySelectionRequest}
				/>
			</section>
		{:else}
			<section class="summary-grid">
				{#each primarySummaryCards as card}
					<div class="summary-card wobbly-border-light">
						<span class="summary-label">{card.label}</span>
						<strong>{card.value}</strong>
						<small>{card.detail}</small>
					</div>
				{/each}
			</section>

			<AnalyzerPane
				analysis={primary}
				bind:metricTab
				bind:metricListSortOrder
				compareMode={false}
				paneLabel="Primary"
			/>
		{/if}
	{/if}
</main>

<style>
	main {
		max-width: 1440px;
		margin: 0 auto;
		padding: 28px 18px 42px;
	}

	.hero {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 18px;
		margin-bottom: 18px;
	}

	.hero-copy {
		max-width: 760px;
	}

	h1 {
		font-size: clamp(2.25rem, 4vw, 3.5rem);
		line-height: 1.04;
		margin: 6px 0 10px;
	}

	.subtitle {
		max-width: 62ch;
		font-size: 1.05rem;
		color: var(--muted);
	}

	.search-panel {
		padding: 18px 20px 14px;
		background:
			linear-gradient(135deg, rgba(242, 198, 184, 0.45), rgba(255, 254, 249, 0.95)),
			var(--card-bg);
		margin-bottom: 24px;
	}

	.mode-btn {
		padding: 8px 14px;
		background: rgba(255, 254, 249, 0.9);
		color: var(--text-ink);
		font-size: 0.92rem;
		border-color: rgba(61, 64, 91, 0.25);
	}

	.search-note {
		margin-top: 10px;
		font-size: 0.9rem;
		color: var(--muted);
		text-align: center;
	}

	.account-bar {
		padding: 16px 18px;
		margin-bottom: 18px;
		background:
			linear-gradient(180deg, rgba(129, 178, 154, 0.08), rgba(255, 254, 249, 0.96)),
			var(--card-bg);
		display: flex;
		justify-content: space-between;
		gap: 16px;
		align-items: flex-start;
		flex-wrap: wrap;
	}

	.account-eyebrow {
		display: inline-flex;
		font-size: 0.74rem;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: var(--muted);
		margin-bottom: 4px;
	}

	.account-bar h2 {
		font-size: 1.3rem;
		line-height: 1.18;
		margin: 0 0 4px;
	}

	.account-subtitle,
	.account-status,
	.compare-error {
		font-size: 0.88rem;
		color: var(--muted);
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}

	.account-status,
	.compare-error {
		margin-top: 8px;
	}

	.compare-error {
		color: #8a5a00;
	}

	.account-actions {
		display: flex;
		gap: 10px;
		flex-wrap: wrap;
		align-items: flex-start;
	}

	.cached-panel {
		padding: 16px 18px;
		margin-bottom: 24px;
		background:
			linear-gradient(180deg, rgba(61, 64, 91, 0.03), rgba(255, 254, 249, 0.92)),
			var(--card-bg);
	}

	.cached-head {
		display: flex;
		justify-content: space-between;
		gap: 14px;
		align-items: flex-start;
		flex-wrap: wrap;
		margin-bottom: 12px;
	}

	.cached-head h2 {
		font-size: 1.1rem;
		line-height: 1.15;
		margin-bottom: 4px;
	}

	.cached-subtitle {
		color: var(--muted);
		font-size: 0.88rem;
		max-width: 58ch;
	}

	.cached-count {
		font-size: 0.84rem;
		color: var(--muted);
	}

	.cached-controls {
		display: flex;
		align-items: center;
		gap: 10px;
		flex-wrap: wrap;
	}

	.cached-toggle {
		padding-inline: 12px;
		font-size: 0.84rem;
	}

	.cached-scroll {
		max-height: 18rem;
		overflow-y: auto;
		padding-right: 4px;
		scrollbar-gutter: stable;
	}

	.cached-grid {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 10px;
	}

	.cached-account {
		padding: 12px 13px;
		background: rgba(255, 254, 249, 0.9);
		text-align: left;
		color: var(--text-ink);
	}

	.cached-account.active {
		border-color: rgba(61, 64, 91, 0.28);
		box-shadow: 0 0 0 2px rgba(61, 64, 91, 0.08);
		background: rgba(255, 250, 238, 0.96);
	}

	.cached-account.compare-selected {
		border-color: rgba(47, 111, 99, 0.32);
		box-shadow: 0 0 0 2px rgba(47, 111, 99, 0.1);
		background: rgba(243, 252, 248, 0.96);
	}

	.cached-account-topline,
	.cached-account-meta {
		display: flex;
		justify-content: space-between;
		gap: 8px;
		flex-wrap: wrap;
	}

	.cached-account-topline {
		align-items: baseline;
		margin-bottom: 6px;
	}

	.cached-account-topline strong {
		font-size: 0.96rem;
		line-height: 1.2;
	}

	.cached-account-meta {
		font-size: 0.82rem;
		color: var(--muted);
		margin-bottom: 8px;
	}

	.cached-account-tag {
		display: inline-flex;
		font-size: 0.76rem;
		color: #2f6f63;
		font-weight: 700;
	}

	.cached-empty,
	.cached-error {
		font-size: 0.9rem;
		color: var(--muted);
	}

	.cached-error {
		color: #8a5a00;
	}

	.summary-grid {
		display: grid;
		grid-template-columns: repeat(4, minmax(0, 1fr));
		gap: 12px;
		margin-bottom: 20px;
	}

	.summary-card {
		padding: 14px 16px;
		background: var(--card-bg);
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	.summary-label {
		font-size: 0.78rem;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: var(--muted);
	}

	.summary-card strong {
		font-size: 1.7rem;
		line-height: 1;
	}

	.summary-card small {
		color: var(--muted);
		font-size: 0.84rem;
	}

	.compare-summary-grid {
		grid-template-columns: repeat(2, minmax(0, 1fr));
	}

	.summary-card-compare {
		gap: 12px;
	}

	.summary-compare-columns {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 12px;
	}

	.summary-side {
		display: flex;
		flex-direction: column;
		gap: 2px;
		padding: 10px 12px;
		border-radius: 14px;
		background: rgba(255, 254, 249, 0.9);
		border: 1px solid rgba(61, 64, 91, 0.1);
	}

	.summary-side-label {
		font-size: 0.76rem;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: var(--muted);
	}

	.compare-pane-grid {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 18px;
		align-items: start;
	}

	@media (max-width: 1080px) {
		.compare-pane-grid {
			grid-template-columns: 1fr;
		}
	}

	@media (max-width: 980px) {
		.hero {
			flex-direction: column;
			align-items: stretch;
		}

		.cached-grid,
		.summary-grid {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}

		.compare-summary-grid {
			grid-template-columns: 1fr;
		}
	}

	@media (max-width: 720px) {
		main {
			padding-inline: 14px;
		}

		.account-bar,
		.cached-panel,
		.search-panel {
			padding-inline: 14px;
		}

		.cached-grid,
		.summary-grid,
		.summary-compare-columns {
			grid-template-columns: 1fr;
		}
	}
</style>
