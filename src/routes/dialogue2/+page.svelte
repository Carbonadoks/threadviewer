<script lang="ts">
	import { onMount } from 'svelte';
	import { browser } from '$app/environment';
	import '../../app.css';
	import SearchBar from '$lib/components/SearchBar.svelte';
	import SearchOptions from '$lib/components/SearchOptions.svelte';
	import ThresholdControl from '$lib/components/ThresholdControl.svelte';
	import VirtualThreadList from '$lib/components/VirtualThreadList.svelte';
	import LoadingSpinner from '$lib/components/LoadingSpinner.svelte';
	import ErrorBanner from '$lib/components/ErrorBanner.svelte';
	import RouteNav from '$lib/components/RouteNav.svelte';
	import GroupChat from '$lib/components/GroupChat.svelte';
	import BoardView from '$lib/components/BoardView.svelte';
	import ParallelBoardView from '$lib/components/ParallelBoardView.svelte';
	import FontPicker from '$lib/components/FontPicker.svelte';
	import ThreadJudgePanel from '$lib/components/ThreadJudgePanel.svelte';
	import type { AuthorInfo, DiscoverProgress, SelfReplyThread, ThreadPost } from '$lib/types';
	import type { ProfileInfo } from '$lib/api/bluesky';
	import { getFullThread, getProfile, hydratePostEmbeds } from '$lib/api/bluesky';
	import { loadRepoFeedItems, type RepoDownloadProgress } from '$lib/utils/repoHydration';
	import { buildThreadsFromFeed } from '$lib/utils/threadWalker';
	import { toastError, toastInfo, toastSuccess } from '$lib/utils/toasts';
	import {
		buildBskyPostUrl,
		buildViewerHref,
		normalizeBskyPostUrl,
		parseBskyPostUrl,
		buildAtUri
	} from '$lib/utils/viewerLinks';
	import { mergeUniquePosts } from '$lib/utils/viewerCacheSync';

	const fontFamilies: Record<string, string> = {
		virgil: "'Virgil', cursive",
		caveat: "'Caveat', cursive",
		patrick: "'Patrick Hand', cursive",
		'comic-neue': "'Comic Neue', cursive",
		inter: "'Inter', sans-serif",
		system: "system-ui, -apple-system, sans-serif"
	};

	type RenderMode = 'default' | 'chat' | 'conspiracy' | 'ransom';
	type FeedSlot = 'a' | 'b';
	type SearchMatcherMode = 'none' | 'literal' | 'regex';

	type ThreadSearchMatcher = {
		mode: SearchMatcherMode;
		literal: string | null;
		regex: RegExp | null;
		helperText: string | null;
		helperTone: 'info' | 'warning' | null;
	};

	type SlotState = {
		profile: ProfileInfo | null;
		feedPosts: any[];
		postCount: number;
		downloadedBytes: number;
		downloadTotalBytes: number;
	};

	type DialogueStats = {
		postsScanned: number;
		chainStarts: number;
		sharedDialogues: number;
	};

	const DEFAULT_PROGRESS: DiscoverProgress = { phase: '', current: 0, total: 0 };
	const EMPTY_STATS: DialogueStats = { postsScanned: 0, chainStarts: 0, sharedDialogues: 0 };

	function createSlotState(): SlotState {
		return { profile: null, feedPosts: [], postCount: 0, downloadedBytes: 0, downloadTotalBytes: 0 };
	}

	let fontKey = $state('patrick');
	let fontFamily = $derived(fontFamilies[fontKey] ?? fontFamilies.virgil);

	const renderMode: RenderMode = 'default';

	let allThreads: SelfReplyThread[] = $state([]);
	let threshold = $state(2);
	let loading = $state(false);
	let resolvingSlot: FeedSlot | null = $state(null);
	let error: string | null = $state(null);
	let progress: DiscoverProgress = $state(DEFAULT_PROGRESS);
	let hasSearched = $state(false);
	let handleAInput = $state('');
	let handleBInput = $state('');

	let slotA = $state<SlotState>(createSlotState());
	let slotB = $state<SlotState>(createSlotState());

	let searchQuery = $state('');
	let dateFrom = $state('');
	let dateTo = $state('');
	let stats = $state<DialogueStats>(EMPTY_STATS);
	let repoElapsedMs = $state(0);

	let abortController: AbortController | null = $state(null);
	let expandedThread: (SelfReplyThread & { isTruncated?: boolean }) | null = $state(null);
	let expandedLoading = $state(false);
	let showExpanded = $state(false);
	let savedScrollY = 0;

	let highlightedThread: string | null = $state(null);
	let pendingScrollToRootUri: string | null = $state(null);
	let collapsedByRootUri = $state<Record<string, boolean>>({});
	let activeThreadUrl: string | null = $state(null);
	let expandedViewMode: 'chat' | 'board' | 'parallel' | 'judge' = $state('chat');

	function getSlot(s: FeedSlot): SlotState { return s === 'a' ? slotA : slotB; }
	function normalizeHandle(handle: string | null | undefined): string {
		return (handle ?? '').replace(/^@/, '').trim();
	}
	function activeHandleA(): string { return slotA.profile?.handle || handleAInput; }
	function activeHandleB(): string { return slotB.profile?.handle || handleBInput; }

	function selectedParticipantDids(): string[] {
		return Array.from(new Set(
			[slotA.profile?.did, slotB.profile?.did].filter((d): d is string => typeof d === 'string' && d.length > 0)
		));
	}

	function handlesMatchProfile(value: string, profile: ProfileInfo | null): boolean {
		if (!profile) return false;
		const cleaned = normalizeHandle(value);
		return cleaned === normalizeHandle(profile.handle) || cleaned === profile.did;
	}

	function setHandleInput(slot: FeedSlot, value: string) {
		if (slot === 'a') handleAInput = value;
		else handleBInput = value;
		const s = getSlot(slot);
		if (s.profile && !handlesMatchProfile(value, s.profile)) {
			s.profile = null;
			s.feedPosts = [];
			s.postCount = 0;
		}
	}

	function formatBytes(bytes: number): string {
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
		return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	}

	function formatSpeed(bytesPerSec: number): string {
		if (bytesPerSec < 1024) return `${bytesPerSec.toFixed(0)} B/s`;
		if (bytesPerSec < 1024 * 1024) return `${(bytesPerSec / 1024).toFixed(0)} KB/s`;
		return `${(bytesPerSec / (1024 * 1024)).toFixed(1)} MB/s`;
	}

	function formatDuration(ms: number): string {
		if (ms <= 0) return '0s';
		if (ms < 1000) return `${Math.round(ms)}ms`;
		return `${(ms / 1000).toFixed(1)}s`;
	}

	function slotNumber(slot: FeedSlot): number {
		return slot === 'a' ? 1 : 2;
	}

	function buildSlotDownloadDetail(
		slot: FeedSlot,
		handle: string,
		downloadProgress: RepoDownloadProgress
	): string {
		const detailParts = [
			`User ${slotNumber(slot)} of 2`,
			`@${handle}`,
			`${formatBytes(downloadProgress.receivedBytes)}${downloadProgress.totalBytes > 0 ? ` / ${formatBytes(downloadProgress.totalBytes)}` : ''}`
		];
		if (downloadProgress.bytesPerSecond > 0) {
			detailParts.push(formatSpeed(downloadProgress.bytesPerSecond));
		}
		if (downloadProgress.elapsedMs > 0) {
			detailParts.push(`${formatDuration(downloadProgress.elapsedMs)} elapsed`);
		}
		return detailParts.join(' · ');
	}

	function buildSlotParseDetail(
		slot: FeedSlot,
		handle: string,
		postCount: number,
		downloadedBytes: number
	): string {
		return `User ${slotNumber(slot)} of 2 · @${handle} · ${postCount.toLocaleString()} posts extracted from ${formatBytes(downloadedBytes)}`;
	}

	function formatRouteError(err: any, fallback: string): string {
		if (err?.message?.includes('Unable to resolve handle') || err?.message?.includes('Profile not found')) return fallback;
		if (err?.message?.includes('fetch')) return 'Network error. Please check your connection and try again.';
		return err?.message || fallback;
	}

	async function handleSlotSearch(slot: FeedSlot, handle: string) {
		const cleaned = normalizeHandle(handle);
		if (!cleaned || loading || resolvingSlot) return;
		resolvingSlot = slot;
		error = null;
		try {
			const profile = await getProfile(cleaned);
			const s = getSlot(slot);
			s.profile = profile;
			setHandleInput(slot, profile.handle);
		} catch (err: any) {
			error = formatRouteError(err, `Could not find handle "${cleaned}".`);
		} finally {
			resolvingSlot = null;
		}
	}

	async function handleSlotProfileSelected(slot: FeedSlot, profile: ProfileInfo) {
		setHandleInput(slot, profile.handle);
		const s = getSlot(slot);
		s.profile = profile;
	}

	async function downloadRepoForSlot(slot: FeedSlot, signal: AbortSignal): Promise<any[]> {
		const s = getSlot(slot);
		const profile = s.profile;
		if (!profile) return [];

		const authorInfo: AuthorInfo = {
			did: profile.did,
			handle: profile.handle,
			displayName: profile.displayName,
			avatar: profile.avatar
		};
		let latestDownloadedBytes = 0;
		progress = { phase: `Downloading repository for @${profile.handle}...`, current: 0, total: 0 };

		const repo = await loadRepoFeedItems(profile.did, authorInfo, {
			signal,
			onDownloadProgress: (downloadProgress) => {
				latestDownloadedBytes = downloadProgress.receivedBytes;
				s.downloadedBytes = downloadProgress.receivedBytes;
				s.downloadTotalBytes = downloadProgress.totalBytes;
				progress =
					downloadProgress.totalBytes > 0
						? {
								phase: `Downloading repository for @${profile.handle}...`,
								current: Math.round(
									(downloadProgress.receivedBytes / downloadProgress.totalBytes) * 100
								),
								total: 100,
								detail: buildSlotDownloadDetail(slot, profile.handle, downloadProgress)
							}
						: {
								phase: `Downloading repository for @${profile.handle}...`,
								current: 0,
								total: 0,
								detail: buildSlotDownloadDetail(slot, profile.handle, downloadProgress)
							};
			},
			onParseProgress: (count) => {
				progress = {
					phase: `Parsing repository for @${profile.handle}...`,
					current: 0,
					total: 0,
					detail: buildSlotParseDetail(slot, profile.handle, count, latestDownloadedBytes)
				};
			}
		});

		s.feedPosts = repo.feedItems;
		s.postCount = repo.totalPosts;
		s.downloadedBytes = repo.downloadedBytes;
		s.downloadTotalBytes = repo.totalBytes;

		return repo.feedItems;
	}

	function collectParticipantDids(post: ThreadPost, set = new Set<string>()): Set<string> {
		set.add(post.author.did);
		for (const child of post.children) collectParticipantDids(child, set);
		return set;
	}

	function isSharedDialogue(thread: SelfReplyThread, participantDids: string[]): boolean {
		if (participantDids.length < 2) return false;
		const seen = collectParticipantDids(thread.rootPost);
		return participantDids.every((did) => seen.has(did));
	}

	function feedPostTimestamp(item: any): number {
		const raw = item?.post?.record?.createdAt || item?.post?.indexedAt || '';
		const parsed = Date.parse(raw);
		return Number.isFinite(parsed) ? parsed : 0;
	}

	async function handleBuildDialogue(): Promise<boolean> {
		const cleanedA = normalizeHandle(handleAInput);
		const cleanedB = normalizeHandle(handleBInput);

		if (!cleanedA || !cleanedB) { error = 'Choose two Bluesky handles to build a dialogue.'; return false; }
		if (cleanedA === cleanedB) { error = 'Choose two different Bluesky handles.'; return false; }
		if (loading || resolvingSlot) return false;

		loading = true;
		error = null;
		hasSearched = true;
		allThreads = [];
		collapsedByRootUri = {};
		pendingScrollToRootUri = null;
		highlightedThread = null;
		showExpanded = false;
		expandedThread = null;
		expandedLoading = false;
		expandedViewMode = 'chat';
		stats = { ...EMPTY_STATS };
		repoElapsedMs = 0;

		const controller = new AbortController();
		abortController = controller;
		updateRouteState({ handleA: cleanedA, handleB: cleanedB });

		const overallStart = performance.now();

		try {
			// Resolve profiles if needed
			if (!slotA.profile || !handlesMatchProfile(cleanedA, slotA.profile)) {
				const p = await getProfile(cleanedA);
				slotA.profile = p;
				handleAInput = p.handle;
			}
			if (!slotB.profile || !handlesMatchProfile(cleanedB, slotB.profile)) {
				const p = await getProfile(cleanedB);
				slotB.profile = p;
				handleBInput = p.handle;
			}

			updateRouteState({ handleA: slotA.profile!.handle, handleB: slotB.profile!.handle });

			// Download both repos sequentially (showing progress for each)
			await downloadRepoForSlot('a', controller.signal);
			await downloadRepoForSlot('b', controller.signal);

			// Combine feeds and build threads
			const combined = mergeUniquePosts(slotA.feedPosts, slotB.feedPosts, 'append');
			const sorted = [...combined].sort((a, b) => feedPostTimestamp(b) - feedPostTimestamp(a));

			const participantDids = selectedParticipantDids();

			progress = {
				phase: 'Building dialogue threads...',
				current: 0,
				total: sorted.length,
				detail: `${sorted.length.toLocaleString()} combined repository posts ready for thread stitching`
			};
			const { threads } = buildThreadsFromFeed(sorted, participantDids, (p) => { progress = p; });

			const sharedThreads = threads.filter((t) => isSharedDialogue(t, participantDids));
			allThreads = sharedThreads;

			repoElapsedMs = Math.round(performance.now() - overallStart);
			stats = {
				postsScanned: sorted.length,
				chainStarts: threads.length,
				sharedDialogues: sharedThreads.length
			};

			if (sharedThreads.length > 0) {
				toastSuccess(`Found ${sharedThreads.length} shared dialogue thread${sharedThreads.length !== 1 ? 's' : ''}`);
			} else {
				toastInfo('No shared dialogue chains found.');
			}
			return true;
		} catch (err: any) {
			if (err?.name !== 'AbortError') {
				error = formatRouteError(err, 'Building the dialogue failed.');
			}
			return false;
		} finally {
			loading = false;
			abortController = null;
		}
	}

	// Search / filter
	function buildSearchMatcher(query: string): ThreadSearchMatcher {
		const trimmed = query.trim();
		if (!trimmed) return { mode: 'none', literal: null, regex: null, helperText: null, helperTone: null };
		if (!trimmed.startsWith('/')) return { mode: 'literal', literal: trimmed.toLowerCase(), regex: null, helperText: null, helperTone: null };
		let closingSlash = -1, escapeNext = false;
		for (let i = 1; i < trimmed.length; i++) {
			if (trimmed[i] === '\\' && !escapeNext) { escapeNext = true; continue; }
			if (trimmed[i] === '/' && !escapeNext) closingSlash = i;
			escapeNext = false;
		}
		if (closingSlash <= 0) return { mode: 'literal', literal: trimmed.toLowerCase(), regex: null, helperText: null, helperTone: 'info' };
		try {
			const pattern = trimmed.slice(1, closingSlash);
			const rawFlags = trimmed.slice(closingSlash + 1).toLowerCase();
			const flags = rawFlags.includes('i') ? rawFlags : `${rawFlags}i`;
			return { mode: 'regex', literal: null, regex: new RegExp(pattern, flags), helperText: null, helperTone: null };
		} catch {
			return { mode: 'literal', literal: trimmed.toLowerCase(), regex: null, helperText: 'Invalid regex, using literal search.', helperTone: 'warning' };
		}
	}

	function matchesSearch(thread: SelfReplyThread, matcher: ThreadSearchMatcher): boolean {
		if (matcher.mode === 'none') return true;
		const regex = matcher.mode === 'regex' ? matcher.regex : null;
		const literal = matcher.mode === 'literal' ? matcher.literal : null;
		function check(post: ThreadPost): boolean {
			if (regex) { regex.lastIndex = 0; if (regex.test(post.text)) return true; }
			else if (literal && post.text.toLowerCase().includes(literal)) return true;
			return post.children.some(check);
		}
		return check(thread.rootPost);
	}

	function isInDateRange(createdAt: string): boolean {
		if (!dateFrom && !dateTo) return true;
		const postDate = new Date(createdAt);
		if (isNaN(postDate.getTime())) return true;
		if (dateFrom && postDate < new Date(dateFrom)) return false;
		if (dateTo) { const to = new Date(dateTo); to.setHours(23, 59, 59, 999); if (postDate > to) return false; }
		return true;
	}

	const searchMatcher = $derived(buildSearchMatcher(searchQuery));
	const sortedThreads = $derived([...allThreads].sort((a, b) => {
		const d = b.depth - a.depth;
		if (d !== 0) return d;
		return Date.parse(b.rootPost.createdAt) - Date.parse(a.rootPost.createdAt);
	}));
	const displayedThreads = $derived(sortedThreads.filter(
		(t) => t.depth >= threshold && isInDateRange(t.rootPost.createdAt) && matchesSearch(t, searchMatcher)
	));
	const maxDepth = $derived(allThreads.length > 0 ? Math.max(...allThreads.map((t) => t.depth)) : 2);

	function updateRouteState(options: { handleA?: string | null; handleB?: string | null; threadUrl?: string | null } = {}) {
		if (!browser) return;
		const url = new URL(window.location.href);
		const a = normalizeHandle(options.handleA ?? activeHandleA());
		const b = normalizeHandle(options.handleB ?? activeHandleB());
		const t = options.threadUrl ? normalizeBskyPostUrl(options.threadUrl) : null;
		if (a) url.searchParams.set('handleA', a); else url.searchParams.delete('handleA');
		if (b) url.searchParams.set('handleB', b); else url.searchParams.delete('handleB');
		if (t) url.searchParams.set('url', t); else url.searchParams.delete('url');
		window.history.replaceState({}, '', url.toString());
		activeThreadUrl = t;
	}

	function threadContainsUri(post: ThreadPost, uri: string): boolean {
		if (post.uri === uri) return true;
		return post.children.some((c) => threadContainsUri(c, uri));
	}
	function findThreadForUri(uri: string): SelfReplyThread | null {
		return allThreads.find((t) => t.rootUri === uri || threadContainsUri(t.rootPost, uri)) ?? null;
	}
	function threadToBlueskyUrl(rootUri: string): string | null {
		const t = allThreads.find((c) => c.rootUri === rootUri);
		if (t) return buildBskyPostUrl(t.rootPost.uri, t.rootPost.author.handle);
		return buildBskyPostUrl(rootUri);
	}

	function cancelFetch() { abortController?.abort(); }

	function collectPostUris(post: ThreadPost): string[] {
		const uris = [post.uri];
		for (const child of post.children) uris.push(...collectPostUris(child));
		return uris;
	}

	function applyEmbeds(post: ThreadPost, embedMap: Map<string, ThreadPost['embed']>): void {
		const embed = embedMap.get(post.uri);
		if (embed && !post.embed) post.embed = embed;
		for (const child of post.children) applyEmbeds(child, embedMap);
	}

	const hydratedRootUris = new Set<string>();

	async function hydrateThreadEmbeds(rootUri: string) {
		if (hydratedRootUris.has(rootUri)) return;
		hydratedRootUris.add(rootUri);

		const thread = allThreads.find((t) => t.rootUri === rootUri);
		if (!thread) return;

		const uris = collectPostUris(thread.rootPost);
		const embedMap = await hydratePostEmbeds(uris);
		if (embedMap.size > 0) {
			applyEmbeds(thread.rootPost, embedMap);
			allThreads = [...allThreads]; // trigger reactivity
		}
	}

	function isThreadCollapsed(rootUri: string): boolean { return collapsedByRootUri[rootUri] ?? true; }
	function setThreadCollapsed(rootUri: string, collapsed: boolean) {
		if (isThreadCollapsed(rootUri) === collapsed) return;
		collapsedByRootUri = { ...collapsedByRootUri, [rootUri]: collapsed };
		if (!collapsed) void hydrateThreadEmbeds(rootUri);
	}
	function handleScrollToRootUriComplete(rootUri: string, _found: boolean) {
		if (pendingScrollToRootUri !== rootUri) return;
		pendingScrollToRootUri = null;
	}

	function handleFontChange(key: string) {
		fontKey = key;
		try { localStorage.setItem('preferred-font', key); } catch {}
	}

	async function openExpandedThread(uri: string, options: { preserveScroll?: boolean } = {}): Promise<boolean> {
		if (options.preserveScroll) savedScrollY = window.scrollY;
		expandedLoading = true;
		showExpanded = true;
		try {
			expandedThread = await getFullThread(uri);
			const canonicalThreadUrl = buildBskyPostUrl(expandedThread.rootUri, expandedThread.rootPost.author.handle) ?? buildBskyPostUrl(uri);
			updateRouteState({ handleA: activeHandleA(), handleB: activeHandleB(), threadUrl: canonicalThreadUrl });
			return true;
		} catch (e: any) {
			toastError(e?.message || 'Failed to load full thread.');
			showExpanded = false;
			expandedThread = null;
			updateRouteState({ handleA: activeHandleA(), handleB: activeHandleB(), threadUrl: null });
			return false;
		} finally {
			expandedLoading = false;
		}
	}

	async function handleExpand(rootUri: string) { await openExpandedThread(rootUri, { preserveScroll: true }); }
	function handleBack() {
		showExpanded = false;
		expandedThread = null;
		expandedViewMode = 'chat';
		updateRouteState({ handleA: activeHandleA(), handleB: activeHandleB(), threadUrl: null });
		requestAnimationFrame(() => { window.scrollTo(0, savedScrollY); });
	}

	async function copyThreadLink() {
		try {
			if (!expandedThread) return;
			const bskyUrl = buildBskyPostUrl(expandedThread.rootUri, expandedThread.rootPost.author.handle);
			if (!bskyUrl) return;
			const shareUrl = new URL(buildViewerHref('dialogue', { url: bskyUrl, handleA: activeHandleA(), handleB: activeHandleB() }), window.location.origin);
			await navigator.clipboard.writeText(shareUrl.toString());
			toastSuccess('Link copied to clipboard');
		} catch { toastError('Failed to copy link'); }
	}

	async function handleShare(rootUri: string) {
		try {
			const bskyUrl = threadToBlueskyUrl(rootUri);
			if (!bskyUrl) { toastError('Could not build a share link.'); return; }
			const shareUrl = new URL(buildViewerHref('dialogue', { url: bskyUrl, handleA: activeHandleA(), handleB: activeHandleB() }), window.location.origin);
			await navigator.clipboard.writeText(shareUrl.toString());
			toastSuccess('Link copied to clipboard');
		} catch { toastError('Failed to copy link'); }
	}

	function handleOpenOnBluesky(rootUri: string) {
		if (!browser) return;
		const bskyUrl = threadToBlueskyUrl(rootUri);
		if (!bskyUrl) { toastError('Could not build Bluesky link.'); return; }
		const opened = window.open(bskyUrl, '_blank', 'noopener,noreferrer');
		if (!opened) toastInfo('Allow popups to open this thread in a new tab.');
	}

	onMount(async () => {
		try {
			const saved = localStorage.getItem('preferred-font');
			if (saved && saved in fontFamilies) fontKey = saved;
		} catch {}

		const params = new URLSearchParams(window.location.search);
		const handleAParam = params.get('handleA');
		const handleBParam = params.get('handleB');
		const fromParam = params.get('from');
		const toParam = params.get('to');

		if (fromParam) dateFrom = fromParam;
		if (toParam) dateTo = toParam;
		if (handleAParam) handleAInput = normalizeHandle(handleAParam);
		if (handleBParam) handleBInput = normalizeHandle(handleBParam);

		if (handleAParam && handleBParam) {
			await handleBuildDialogue();
		}
	});
</script>

<svelte:head>
	<title>Dialogue Viewer</title>
</svelte:head>

<main style="font-family: {fontFamily}">
	<header>
		<RouteNav
			current="dialogue2"
			align="center"
			threadUrl={activeThreadUrl}
			handle={slotA.profile?.handle || handleAInput}
			dialogueHandleA={activeHandleA()}
			dialogueHandleB={activeHandleB()}
		/>
		<h1>Dialogue</h1>
		<p class="subtitle">Download two repos and stitch shared reply chains</p>
		<FontPicker value={fontKey} onchange={handleFontChange} />
	</header>

	<section class="search-section">
		<div class="dialogue-search-grid">
			<div class="search-slot">
				<div class="search-slot-label">First user</div>
				<SearchBar
					onsearch={(handle) => void handleSlotSearch('a', handle)}
					onprofile={(profile) => void handleSlotProfileSelected('a', profile)}
					onchange={(value) => setHandleInput('a', value)}
					disabled={loading || resolvingSlot !== null}
					initialHandle={handleAInput}
					placeholder="Search for the first Bluesky user..."
					buttonLabel="Pick"
				/>
			</div>
			<div class="search-slot">
				<div class="search-slot-label">Second user</div>
				<SearchBar
					onsearch={(handle) => void handleSlotSearch('b', handle)}
					onprofile={(profile) => void handleSlotProfileSelected('b', profile)}
					onchange={(value) => setHandleInput('b', value)}
					disabled={loading || resolvingSlot !== null}
					initialHandle={handleBInput}
					placeholder="Search for the second Bluesky user..."
					buttonLabel="Pick"
				/>
			</div>
		</div>

		<div class="build-row">
			<button
				class="build-btn wobbly-border"
				onclick={() => void handleBuildDialogue()}
				disabled={loading || resolvingSlot !== null || !normalizeHandle(handleAInput) || !normalizeHandle(handleBInput)}
			>
				{loading ? 'Building...' : 'Build dialogue'}
			</button>
		</div>

		<div class="info-banner wobbly-border-light">
			Repository view &mdash; engagement counts unavailable, embeds load when thread is opened
		</div>

		<div class="options-row">
			<SearchOptions bind:dateFrom bind:dateTo />
		</div>
	</section>

	{#if error}
		<ErrorBanner message={error} />
	{/if}

	{#if showExpanded}
		<div class="panel-detail">
			{#if expandedLoading}
				<LoadingSpinner progress={{ phase: 'Loading full thread...', current: 0, total: 0 }} />
			{:else if expandedThread}
				<div class="expanded-actions">
					<button class="back-btn wobbly-border" onclick={handleBack}>&#8592; Back to threads</button>
					<button class="copy-link-btn wobbly-border" onclick={copyThreadLink}>Copy link</button>
					<div class="view-toggle">
						<button class="view-toggle-btn wobbly-border" class:active={expandedViewMode === 'chat'} onclick={() => expandedViewMode = 'chat'}>Chat</button>
						<button class="view-toggle-btn wobbly-border" class:active={expandedViewMode === 'board'} onclick={() => expandedViewMode = 'board'}>Board</button>
						<button class="view-toggle-btn wobbly-border" class:active={expandedViewMode === 'parallel'} onclick={() => expandedViewMode = 'parallel'}>Parallel</button>
						<button class="view-toggle-btn wobbly-border" class:active={expandedViewMode === 'judge'} onclick={() => expandedViewMode = 'judge'}>Judge</button>
					</div>
				</div>
				{#if expandedThread.isTruncated}
					<p class="truncation-warning">Some replies may be missing</p>
				{/if}
				<div class="expanded-thread" class:expanded-wide={expandedViewMode === 'board' || expandedViewMode === 'parallel'}>
					{#if expandedViewMode === 'chat'}
						<GroupChat thread={expandedThread} />
					{:else if expandedViewMode === 'board'}
						<BoardView thread={expandedThread} />
					{:else if expandedViewMode === 'parallel'}
						<ParallelBoardView thread={expandedThread} />
					{:else}
						{#key expandedThread.rootUri}
							<ThreadJudgePanel thread={expandedThread} autoloadCache />
						{/key}
					{/if}
				</div>
			{/if}
		</div>
	{:else}
		{#if hasSearched}
			<section class="results-section">
				<div class="results-header">
					<div class="dialogue-author-row">
						{#each [slotA.profile, slotB.profile] as profile}
							{#if profile}
								<div class="author-info">
									{#if profile.avatar}
										<img src={profile.avatar} alt="" class="author-avatar" />
									{/if}
									<span>
										{profile.displayName || profile.handle}
										<span class="author-handle">@{profile.handle}</span>
									</span>
								</div>
							{/if}
						{/each}
					</div>

					{#if !loading && repoElapsedMs > 0}
						<div class="stats-bar">
							<span>
								{slotA.postCount.toLocaleString()} + {slotB.postCount.toLocaleString()} posts downloaded
								({formatBytes(slotA.downloadedBytes + slotB.downloadedBytes)})
								in {(repoElapsedMs / 1000).toFixed(1)}s
							</span>
						</div>
					{/if}

					{#if !loading && stats.postsScanned > 0}
						<div class="stats-bar">
							<span>{stats.postsScanned.toLocaleString()} posts scanned</span>
							<span class="stats-sep">/</span>
							<span>{stats.chainStarts.toLocaleString()} combined chains</span>
							<span class="stats-sep">/</span>
							<span>{stats.sharedDialogues.toLocaleString()} shared dialogues</span>
						</div>
					{/if}

					{#if allThreads.length > 0}
						<ThresholdControl bind:value={threshold} min={2} max={Math.max(maxDepth, 2)} />
						<div class="search-filter wobbly-border-light">
							<label for="thread-search">Search threads:</label>
							<input id="thread-search" type="text" placeholder="Filter by text or /pattern/flags…" bind:value={searchQuery} />
							{#if searchMatcher.helperText}
								<p class="search-helper" class:warning={searchMatcher.helperTone === 'warning'}>{searchMatcher.helperText}</p>
							{/if}
						</div>
						<p class="results-count">
							{displayedThreads.length} shared dialogue thread{displayedThreads.length !== 1 ? 's' : ''} with depth {threshold}+
						</p>
					{/if}

					{#if dateFrom || dateTo}
						<p class="date-filter-info">Filtered by date: {dateFrom || 'any'} to {dateTo || 'now'}</p>
					{/if}
				</div>

				{#if loading}
					<LoadingSpinner {progress} />
					<div class="cancel-row">
						<button class="cancel-btn wobbly-border" onclick={cancelFetch}>Cancel</button>
					</div>
				{/if}

				{#if displayedThreads.length > 0}
					<VirtualThreadList
						threads={displayedThreads}
						{renderMode}
						{highlightedThread}
						{collapsedByRootUri}
						oncollapsedchange={setThreadCollapsed}
						onexpand={handleExpand}
						onshare={handleShare}
						onopenbluesky={handleOpenOnBluesky}
						scrollToRootUri={pendingScrollToRootUri}
						onscrolltorooturicomplete={handleScrollToRootUriComplete}
					/>
				{:else if !loading}
					<div class="empty-state">
						{#if allThreads.length === 0}
							<p>No shared dialogue chains found.</p>
							<p class="empty-hint">Make sure both users have interacted in reply chains.</p>
						{:else}
							<p>No threads match the current filters.</p>
							<p class="empty-hint">Try lowering the minimum depth or adjusting the date range.</p>
						{/if}
					</div>
				{/if}
			</section>
		{/if}

		{#if !loading && !hasSearched}
			<section class="welcome">
				<p>Pick two Bluesky users to download their repos and find shared reply chains.</p>
				<p class="hint">Downloads both AT Protocol repos in full — no pagination or rate limits.</p>
			</section>
		{/if}
	{/if}
</main>

<style>
	main {
		max-width: 880px;
		margin: 0 auto;
		padding: 32px 20px;
	}

	header {
		text-align: center;
		margin-bottom: 32px;
	}

	h1 {
		font-size: 2.2rem;
		color: var(--text-ink);
		margin-bottom: 4px;
	}

	.subtitle {
		color: var(--muted);
		font-size: 1.1rem;
	}

	.search-section {
		margin-bottom: 32px;
	}

	.info-banner {
		max-width: 600px;
		margin: 12px auto 0;
		padding: 10px 16px;
		background: #fff3cd;
		color: #856404;
		font-size: 0.88rem;
		text-align: center;
	}

	.dialogue-search-grid {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 16px;
		align-items: start;
	}

	.search-slot {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.search-slot-label {
		font-size: 0.9rem;
		font-weight: 700;
		color: var(--muted);
		padding-left: 4px;
	}

	.build-row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 10px;
		margin-top: 14px;
		justify-content: center;
	}

	.build-btn {
		padding: 10px 18px;
		background: var(--accent);
		color: white;
		border-color: var(--text-ink);
		font-size: 1rem;
	}

	.options-row {
		margin-top: 10px;
		text-align: center;
	}

	.panel-detail {
		margin-top: 8px;
	}

	.expanded-wide {
		width: 100vw;
		margin-left: calc(-50vw + 50%);
	}

	.expanded-actions {
		display: flex;
		gap: 8px;
		margin-bottom: 16px;
	}

	.view-toggle {
		display: flex;
		gap: 4px;
		margin-left: auto;
	}

	.view-toggle-btn,
	.back-btn,
	.copy-link-btn,
	.cancel-btn {
		padding: 6px 14px;
		font-size: 0.9rem;
		background: var(--card-bg);
		color: var(--accent);
		border-color: var(--accent);
		cursor: pointer;
	}

	.view-toggle-btn.active {
		background: var(--accent);
		color: white;
	}

	.truncation-warning {
		margin: 0 0 12px;
		color: var(--accent);
		font-size: 0.92rem;
	}

	.results-header {
		display: flex;
		flex-direction: column;
		gap: 14px;
		margin-bottom: 16px;
	}

	.dialogue-author-row {
		display: flex;
		flex-wrap: wrap;
		gap: 12px;
	}

	.author-info {
		display: inline-flex;
		align-items: center;
		gap: 10px;
		padding: 10px 14px;
		background: rgba(255, 252, 245, 0.86);
		border: 1px solid rgba(61, 64, 91, 0.14);
		border-radius: 999px;
		box-shadow: 0 10px 24px rgba(26, 35, 44, 0.06);
	}

	.author-avatar {
		width: 38px;
		height: 38px;
		border-radius: 50%;
		object-fit: cover;
	}

	.author-handle {
		color: var(--muted);
		margin-left: 6px;
		font-size: 0.85rem;
	}

	.stats-bar {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		color: var(--muted);
		font-size: 0.95rem;
	}

	.stats-sep {
		opacity: 0.5;
	}


	.search-filter {
		max-width: 640px;
		padding: 12px 20px;
		background: var(--card-bg);
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 12px;
	}

	.search-filter label {
		font-size: 0.95rem;
		white-space: nowrap;
	}

	.search-filter input[type='text'] {
		flex: 1;
		min-width: 120px;
		padding: 6px 10px;
		font-size: 0.95rem;
		font-family: inherit;
		border: 1.5px solid var(--muted);
		border-radius: 6px;
		background: var(--card-bg);
		color: var(--text-ink);
	}

	.search-helper {
		width: 100%;
		margin: -2px 0 0;
		font-size: 0.82rem;
		line-height: 1.3;
		color: var(--muted);
	}

	.search-helper.warning {
		color: var(--accent);
	}

	.results-count,
	.date-filter-info {
		margin: 0;
		color: var(--muted);
	}

	.cancel-row {
		margin: 10px 0 16px;
		text-align: center;
	}

	.empty-state,
	.welcome {
		padding: 26px 22px;
		border-radius: 18px;
		background: rgba(255, 252, 245, 0.88);
		border: 1px solid rgba(61, 64, 91, 0.12);
		text-align: center;
	}

	.empty-hint,
	.hint {
		margin: 8px 0 0;
		color: var(--muted);
	}

	@media (max-width: 760px) {
		main {
			padding: 24px 16px;
		}

		.dialogue-search-grid {
			grid-template-columns: 1fr;
		}

		.expanded-actions {
			flex-wrap: wrap;
		}

		.view-toggle {
			margin-left: 0;
		}
	}
</style>
