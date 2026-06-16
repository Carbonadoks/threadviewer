<script lang="ts">
	import { onDestroy, onMount, tick } from 'svelte';
	import { browser } from '$app/environment';
	import '../../app.css';
	import SearchBar from '$lib/components/SearchBar.svelte';
	import SearchOptions from '$lib/components/SearchOptions.svelte';
	import VirtualThreadList from '$lib/components/VirtualThreadList.svelte';
	import LoadingSpinner from '$lib/components/LoadingSpinner.svelte';
	import ErrorBanner from '$lib/components/ErrorBanner.svelte';
	import RouteNav from '$lib/components/RouteNav.svelte';
	import FontPicker from '$lib/components/FontPicker.svelte';
	import BlogArticle from '$lib/components/BlogArticle.svelte';
	import type { AuthorInfo, DiscoverProgress, SelfReplyThread, ThreadPost } from '$lib/types';
	import type { FollowProfileInfo, ProfileInfo } from '$lib/api/bluesky';
	import { getFollowsPage, getFullThread, getProfile } from '$lib/api/bluesky';
	import {
		Viewer2DuckDbClient,
		isViewer2DuckDbFatalError,
		type Viewer2DbAccount,
		type Viewer2DbGalleryContentMode,
		type Viewer2DbGalleryGroupMode,
		type Viewer2DbIngestCallbacks,
		type Viewer2DbIngestResult,
		type Viewer2DbOverview,
		type Viewer2DbSearchMode,
		type Viewer2DbThreadSortMode
	} from '$lib/utils/viewer2DuckDb';
	import type { RepoDownloadProgress } from '$lib/utils/repoHydration';
	import { toastError, toastInfo, toastSuccess } from '$lib/utils/toasts';
	import { buildBskyPostUrl, buildViewerHref } from '$lib/utils/viewerLinks';

	type BatchRepoStatus = 'pending' | 'waiting' | 'downloading' | 'parsing' | 'indexing' | 'done' | 'failed';
	type BatchRepoItem = FollowProfileInfo & {
		status: BatchRepoStatus;
		detail: string;
		error: string | null;
		retries: number;
		downloadedBytes: number;
		threadCount: number;
	};
	type BatchProgress = {
		done: number;
		total: number;
		active: number;
		failed: number;
		skipped: number;
		rateLimitHits: number;
	};

	const MAX_FOLLOW_PAGES = 20;
	const BATCH_CONCURRENCY_MIN = 1;
	const BATCH_CONCURRENCY_MAX = 6;
	const BATCH_START_DELAY_MIN_MS = 0;
	const BATCH_START_DELAY_MAX_MS = 30_000;
	const BATCH_RATE_LIMIT_BACKOFF_MS = 12_000;
	const BATCH_RATE_LIMIT_RETRIES = 3;
	const GALLERY_GRID_ZOOM_MIN = 55;
	const GALLERY_GRID_ZOOM_MAX = 160;
	const fontFamilies: Record<string, string> = {
		virgil: "'Virgil', cursive",
		caveat: "'Caveat', cursive",
		patrick: "'Patrick Hand', cursive",
		'comic-neue': "'Comic Neue', cursive",
		inter: "'Inter', sans-serif",
		system: "system-ui, -apple-system, sans-serif"
	};

	let dbClient: Viewer2DuckDbClient | null = null;
	let dbRecovery: Promise<Viewer2DuckDbClient | null> | null = null;
	let dbInitializing = $state(false);
	let dbReady = $state(false);
	let dbError: string | null = $state(null);
	let accounts: Viewer2DbAccount[] = $state([]);
	let overview: Viewer2DbOverview = $state({
		accountCount: 0,
		postCount: 0,
		threadCount: 0,
		selfReplyThreadCount: 0,
		downloadedBytes: 0
	});

	let selectedProfile: ProfileInfo | null = $state(null);
	let initialHandle = $state('');
	let loading = $state(false);
	let queryLoading = $state(false);
	let error: string | null = $state(null);
	let progress: DiscoverProgress = $state({ phase: '', current: 0, total: 0 });
	let abortController: AbortController | null = null;
	let resultsLayerEl: HTMLElement | undefined = $state();
	let fontKey = $state('patrick');
	let fontFamily = $derived(fontFamilies[fontKey] ?? fontFamilies.virgil);

	let searchQuery = $state('');
	let searchMode = $state<Viewer2DbSearchMode>('literal');
	let dateFrom = $state('');
	let dateTo = $state('');
	let minDepth = $state(1);
	let galleryContentMode = $state<Viewer2DbGalleryContentMode>('all');
	let galleryGroupMode = $state<Viewer2DbGalleryGroupMode>('threads');
	let threadSortMode = $state<Viewer2DbThreadSortMode>('depth');
	let pageSize = $state(100);
	let pageIndex = $state(0);
	let totalResults = $state(0);
	let displayedThreads: SelfReplyThread[] = $state([]);
	let hasQueried = $state(false);
	let collapsedByRootUri = $state<Record<string, boolean>>({});
	let highlightedThread: string | null = $state(null);

	let galleryMediaLayout = $state<'grid' | 'masonry'>('grid');
	let galleryMediaFit = $state<'fill' | 'fit'>('fill');
	let galleryGridZoom = $state(100);

	let followsSubject: ProfileInfo | null = $state(null);
	let follows: FollowProfileInfo[] = $state([]);
	let loadingFollows = $state(false);
	let showFollowEditor = $state(false);
	let followFilter = $state('');
	let excludedFollowDids = $state(new Set<string>());
	let batchDownloading = $state(false);
	let batchConcurrency = $state(2);
	let batchStartDelayMs = $state(1000);
	let batchItems: BatchRepoItem[] = $state([]);
	let batchProgress: BatchProgress = $state({
		done: 0,
		total: 0,
		active: 0,
		failed: 0,
		skipped: 0,
		rateLimitHits: 0
	});
	let followLoadController: AbortController | null = null;
	let activeBatchJob = 0;

	let expandedThread: (SelfReplyThread & { isTruncated?: boolean }) | null = $state(null);
	let expandedLoading = $state(false);
	let showExpanded = $state(false);
	let blogThread: SelfReplyThread | null = $state(null);
	let blogLoadingFullThread = $state(false);
	let showBlogReader = $state(false);
	let activeBlogJob = 0;
	let savedScrollY = 0;
	const expandedThreadCache = new Map<string, SelfReplyThread & { isTruncated?: boolean }>();
	const detailIsOpen = $derived(showExpanded || showBlogReader);
	const loadedRepoDids = $derived.by(() => new Set(accounts.map((account) => account.did)));
	const activeFollows = $derived.by(() => follows.filter((follow) => !excludedFollowDids.has(follow.did)));
	const downloadableActiveFollows = $derived.by(() =>
		activeFollows.filter((follow) => !loadedRepoDids.has(follow.did))
	);
	const filteredFollows = $derived.by(() => {
		const query = followFilter.trim().toLowerCase();
		if (!query) return follows;
		return follows.filter(
			(follow) =>
				follow.handle.toLowerCase().includes(query) ||
				(follow.displayName ?? '').toLowerCase().includes(query)
		);
	});
	const totalPages = $derived(Math.max(1, Math.ceil(totalResults / Math.max(1, pageSize))));
	const gallerySearchQuery = $derived(
		searchMode === 'regex' && searchQuery.trim()
			? `/${searchQuery.replace(/\//g, '\\/')}/i`
			: searchQuery
	);
	const gallerySearchMode = $derived(searchMode === 'regex' ? 'fuzzy' : 'literal');

	function formatBytes(bytes: number): string {
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
		return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	}

	function handleFontChange(key: string) {
		fontKey = key;
		try {
			localStorage.setItem('preferred-font', key);
		} catch {}
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

	function buildRepoDownloadDetail(downloadProgress: RepoDownloadProgress): string {
		const parts = [
			`${formatBytes(downloadProgress.receivedBytes)}${downloadProgress.totalBytes > 0 ? ` / ${formatBytes(downloadProgress.totalBytes)}` : ''}`
		];
		if (downloadProgress.bytesPerSecond > 0) parts.push(formatSpeed(downloadProgress.bytesPerSecond));
		if (downloadProgress.elapsedMs > 0) parts.push(`${formatDuration(downloadProgress.elapsedMs)} elapsed`);
		return parts.join(' · ');
	}

	function buildRepoParseDetail(parsedPosts: number, downloadedBytes: number): string {
		return `${parsedPosts.toLocaleString()} posts extracted from ${formatBytes(downloadedBytes)}`;
	}

	function normalizeHandle(handle: string | null | undefined): string {
		return (handle ?? '').replace(/^@/, '').trim();
	}

	function normalizeBatchConcurrency(value: unknown): number {
		const numeric = Number(value);
		if (!Number.isFinite(numeric)) return 2;
		return Math.max(BATCH_CONCURRENCY_MIN, Math.min(BATCH_CONCURRENCY_MAX, Math.round(numeric)));
	}

	function normalizeBatchStartDelayMs(value: unknown): number {
		const numeric = Number(value);
		if (!Number.isFinite(numeric)) return 1000;
		return Math.max(BATCH_START_DELAY_MIN_MS, Math.min(BATCH_START_DELAY_MAX_MS, Math.round(numeric)));
	}

	function normalizeGalleryGridZoom(value: unknown): number {
		const numeric = Number(value);
		if (!Number.isFinite(numeric)) return 100;
		return Math.max(GALLERY_GRID_ZOOM_MIN, Math.min(GALLERY_GRID_ZOOM_MAX, Math.round(numeric)));
	}

	function setBatchConcurrency(value: unknown) {
		batchConcurrency = normalizeBatchConcurrency(value);
	}

	function setBatchStartDelayMs(value: unknown) {
		batchStartDelayMs = normalizeBatchStartDelayMs(value);
	}

	function setGalleryGridZoom(value: unknown) {
		galleryGridZoom = normalizeGalleryGridZoom(value);
	}

	function isThreadCollapsed(rootUri: string): boolean {
		return collapsedByRootUri[rootUri] ?? true;
	}

	function setThreadCollapsed(rootUri: string, collapsed: boolean) {
		collapsedByRootUri = { ...collapsedByRootUri, [rootUri]: collapsed };
	}

	function cancelFetch() {
		abortController?.abort();
		followLoadController?.abort();
		blogLoadingFullThread = false;
		activeBlogJob += 1;
	}

	function messageFromError(err: unknown, fallback: string): string {
		return err instanceof Error ? err.message : fallback;
	}

	async function loadDbState(client: Viewer2DuckDbClient) {
		const [nextAccounts, nextOverview] = await Promise.all([client.listAccounts(), client.overview()]);
		accounts = nextAccounts;
		overview = nextOverview;
	}

	async function openDbClient(): Promise<Viewer2DuckDbClient | null> {
		if (dbInitializing) return null;
		dbInitializing = true;
		dbError = null;
		try {
			dbClient = await Viewer2DuckDbClient.create();
			dbReady = true;
			await loadDbState(dbClient);
			return dbClient;
		} catch (err) {
			dbError = messageFromError(err, 'Could not initialize DuckDB.');
			dbReady = false;
			return null;
		} finally {
			dbInitializing = false;
		}
	}

	async function ensureDb(): Promise<Viewer2DuckDbClient | null> {
		if (dbRecovery) return dbRecovery;
		if (dbClient) return dbClient;
		return openDbClient();
	}

	async function recoverDuckDbAfterFatal(err: unknown): Promise<Viewer2DuckDbClient | null> {
		if (!isViewer2DuckDbFatalError(err)) return null;
		if (dbRecovery) return dbRecovery;

		dbRecovery = (async () => {
			const staleClient = dbClient;
			dbClient = null;
			dbReady = false;
			dbError = 'Restarting DuckDB after a fatal database error...';
			await staleClient?.close().catch(() => {});
			const reopened = await openDbClient();
			if (reopened) {
				toastInfo('DuckDB restarted after a fatal database error.');
			} else if (!dbError) {
				dbError = 'DuckDB could not restart. Reload the page to create a fresh browser database session.';
			}
			return reopened;
		})();

		try {
			return await dbRecovery;
		} finally {
			dbRecovery = null;
		}
	}

	async function refreshDbState() {
		const client = dbClient;
		if (!client) return;
		try {
			await loadDbState(client);
		} catch (err) {
			const recovered = await recoverDuckDbAfterFatal(err);
			if (!recovered) throw err;
			await loadDbState(recovered);
		}
	}

	function queryOptions(offset = pageIndex * pageSize) {
		return {
			query: searchQuery,
			searchMode,
			dateFrom,
			dateTo,
			minDepth,
			contentMode: galleryContentMode,
			groupMode: galleryGroupMode,
			sortMode: threadSortMode,
			limit: pageSize,
			offset
		};
	}

	async function runGalleryQuery(options: { resetPage?: boolean } = {}) {
		const client = await ensureDb();
		if (!client) return;
		const nextPage = options.resetPage ? 0 : pageIndex;
		pageIndex = nextPage;
		queryLoading = true;
		error = null;
		try {
			const result = await client.queryGalleryThreads(queryOptions(nextPage * pageSize));
			displayedThreads = result.threads;
			totalResults = result.total;
			hasQueried = true;
		} catch (err) {
			const recovered = await recoverDuckDbAfterFatal(err);
			if (recovered) {
				try {
					const result = await recovered.queryGalleryThreads(queryOptions(nextPage * pageSize));
					displayedThreads = result.threads;
					totalResults = result.total;
					hasQueried = true;
				} catch (retryErr) {
					error = messageFromError(retryErr, 'DuckDB query failed.');
				}
			} else {
				error = messageFromError(err, 'DuckDB query failed.');
			}
		} finally {
			queryLoading = false;
		}
	}

	function scrollToResultsTop() {
		if (!browser) return;
		requestAnimationFrame(() => {
			const top =
				resultsLayerEl
					? Math.max(0, window.scrollY + resultsLayerEl.getBoundingClientRect().top - 12)
					: 0;
			window.scrollTo({ top, behavior: 'smooth' });
		});
	}

	async function setPage(nextPage: number) {
		pageIndex = Math.max(0, Math.min(totalPages - 1, nextPage));
		await runGalleryQuery();
		await tick();
		scrollToResultsTop();
	}

	async function handleProfileSelected(profile: ProfileInfo) {
		selectedProfile = profile;
		initialHandle = profile.handle;
	}

	function authorFromProfile(profile: ProfileInfo): AuthorInfo {
		return {
			did: profile.did,
			handle: profile.handle,
			displayName: profile.displayName,
			avatar: profile.avatar
		};
	}

	async function downloadAndIngestProfileRepo(
		profile: ProfileInfo,
		callbacks: Viewer2DbIngestCallbacks,
		signal: AbortSignal
	): Promise<Viewer2DbIngestResult> {
		const run = async (client: Viewer2DuckDbClient) =>
			client.downloadAndIngestRepo(authorFromProfile(profile), callbacks, signal);
		const client = await ensureDb();
		if (!client) throw new Error(dbError ?? 'DuckDB is not ready.');

		try {
			return await run(client);
		} catch (err) {
			const recovered = await recoverDuckDbAfterFatal(err);
			if (!recovered || signal.aborted) throw err;
			callbacks.onPhase?.('index', 'DuckDB restarted; retrying repo indexing');
			return run(recovered);
		}
	}

	async function downloadProfileRepo(profile: ProfileInfo, signal: AbortSignal): Promise<Viewer2DbAccount> {
		let latestDownloadedBytes = 0;
		const result = await downloadAndIngestProfileRepo(
			profile,
			{
				onDownloadProgress: (downloadProgress) => {
					latestDownloadedBytes = downloadProgress.receivedBytes;
					progress =
						downloadProgress.totalBytes > 0
							? {
									phase: `Downloading @${profile.handle} repo...`,
									current: Math.round((downloadProgress.receivedBytes / downloadProgress.totalBytes) * 100),
									total: 100,
									detail: buildRepoDownloadDetail(downloadProgress)
								}
							: {
									phase: `Downloading @${profile.handle} repo...`,
									current: 0,
									total: 0,
									detail: buildRepoDownloadDetail(downloadProgress)
								};
				},
				onParseProgress: (count) => {
					progress = {
						phase: `Parsing @${profile.handle} repo...`,
						current: 0,
						total: 0,
						detail: buildRepoParseDetail(count, latestDownloadedBytes)
					};
				},
				onPhase: (phase, detail) => {
					if (phase === 'index') {
						progress = {
							phase: `Indexing @${profile.handle} in DuckDB...`,
							current: 0,
							total: 0,
							detail
						};
					}
				}
			},
			signal
		);
		return result.account;
	}

	async function handleSearch(handle: string): Promise<void> {
		const cleaned = normalizeHandle(handle);
		if (!cleaned || loading || batchDownloading) return;
		const controller = new AbortController();
		abortController?.abort();
		abortController = controller;
		loading = true;
		error = null;
		progress = { phase: 'Resolving profile...', current: 0, total: 0 };

		try {
			const profile = selectedProfile && normalizeHandle(selectedProfile.handle) === cleaned
				? selectedProfile
				: await getProfile(cleaned);
			await handleProfileSelected(profile);
			const account = await downloadProfileRepo(profile, controller.signal);
			await refreshDbState();
			await runGalleryQuery({ resetPage: true });
			toastSuccess(
				`Indexed @${profile.handle}: ${account.self_reply_thread_count.toLocaleString()} self-reply thread${account.self_reply_thread_count === 1 ? '' : 's'}`
			);
		} catch (err: any) {
			if (err?.name !== 'AbortError') {
				const message = err?.message || 'Could not download this repo.';
				error = message;
				toastError(message);
			}
		} finally {
			if (abortController === controller) abortController = null;
			loading = false;
		}
	}

	function resetBatchProgress() {
		batchProgress = {
			done: 0,
			total: 0,
			active: 0,
			failed: 0,
			skipped: 0,
			rateLimitHits: 0
		};
	}

	function toggleFollow(did: string) {
		const next = new Set(excludedFollowDids);
		if (next.has(did)) next.delete(did);
		else next.add(did);
		excludedFollowDids = next;
	}

	function selectAllFollows() {
		excludedFollowDids = new Set();
	}

	function clearAllFollows() {
		excludedFollowDids = new Set(follows.map((follow) => follow.did));
	}

	function batchProcessedCount(value: BatchProgress = batchProgress): number {
		return value.done + value.failed + value.skipped;
	}

	function buildBatchProgressDetail(value: BatchProgress = batchProgress): string {
		const parts = [`${value.active.toLocaleString()} active`];
		if (value.done > 0) parts.push(`${value.done.toLocaleString()} done`);
		if (value.skipped > 0) parts.push(`${value.skipped.toLocaleString()} already indexed`);
		if (value.failed > 0) parts.push(`${value.failed.toLocaleString()} failed`);
		if (value.rateLimitHits > 0) parts.push(`${value.rateLimitHits.toLocaleString()} rate-limit backoff${value.rateLimitHits === 1 ? '' : 's'}`);
		return parts.join(' · ');
	}

	function updateBatchProgress(patch: Partial<BatchProgress>) {
		const next = { ...batchProgress, ...patch };
		batchProgress = next;
		if (batchDownloading) {
			progress = {
				phase: 'Batch downloading follow repos...',
				current: batchProcessedCount(next),
				total: next.total,
				detail: buildBatchProgressDetail(next)
			};
		}
	}

	function updateBatchItem(did: string, patch: Partial<BatchRepoItem>) {
		batchItems = batchItems.map((item) => (item.did === did ? { ...item, ...patch } : item));
	}

	function buildBatchItem(follow: FollowProfileInfo): BatchRepoItem {
		const existingAccount = accounts.find((account) => account.did === follow.did);
		return {
			...follow,
			status: existingAccount ? 'done' : 'pending',
			detail: existingAccount ? 'Already indexed' : '',
			error: null,
			retries: 0,
			downloadedBytes: existingAccount?.downloaded_bytes ?? 0,
			threadCount: existingAccount?.self_reply_thread_count ?? 0
		};
	}

	function batchItemStatusLabel(status: BatchRepoStatus): string {
		if (status === 'done') return 'Done';
		if (status === 'failed') return 'Failed';
		if (status === 'downloading') return 'Downloading';
		if (status === 'parsing') return 'Parsing';
		if (status === 'indexing') return 'Indexing';
		if (status === 'waiting') return 'Waiting';
		return 'Pending';
	}

	function isRateLimitError(value: unknown): boolean {
		const status = Number((value as { status?: number })?.status);
		const message = value instanceof Error ? value.message : String(value ?? '');
		return status === 429 || /\b429\b|rate.?limit|too many requests/i.test(message);
	}

	function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
		if (ms <= 0) return Promise.resolve();
		if (signal.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));

		return new Promise((resolve, reject) => {
			const timeout = window.setTimeout(() => {
				signal.removeEventListener('abort', abort);
				resolve();
			}, ms);
			const abort = () => {
				window.clearTimeout(timeout);
				reject(new DOMException('Aborted', 'AbortError'));
			};
			signal.addEventListener('abort', abort, { once: true });
		});
	}

	async function loadFollowsForBatch() {
		if (loadingFollows || batchDownloading) return;
		let profile = selectedProfile;
		try {
			if (!profile) {
				const handle = normalizeHandle(initialHandle);
				if (!handle) {
					toastInfo('Choose a Bluesky account first.');
					return;
				}
				profile = await getProfile(handle);
				await handleProfileSelected(profile);
			}
		} catch (err) {
			error = err instanceof Error ? err.message : 'Could not load the selected profile.';
			toastError(error);
			return;
		}

		followLoadController?.abort();
		const controller = new AbortController();
		followLoadController = controller;
		loadingFollows = true;
		error = null;
		follows = [];
		excludedFollowDids = new Set();
		followFilter = '';
		batchItems = [];
		resetBatchProgress();
		followsSubject = profile;

		try {
			const collected: FollowProfileInfo[] = [];
			let cursor: string | undefined;
			for (let page = 0; page < MAX_FOLLOW_PAGES; page += 1) {
				const res = await getFollowsPage(profile.did, {
					cursor,
					limit: 100,
					signal: controller.signal
				});
				collected.push(...res.follows);
				cursor = res.cursor;
				if (!cursor) break;
			}
			follows = collected;
			showFollowEditor = true;
			if (collected.length === 0) toastInfo(`@${profile.handle} does not follow anyone.`);
		} catch (err: any) {
			if (err?.name !== 'AbortError') {
				const message = err?.message || 'Failed to load follows.';
				error = message;
				toastError(message);
			}
		} finally {
			if (followLoadController === controller) followLoadController = null;
			loadingFollows = false;
		}
	}

	async function loadFollowRepoForBatch(
		follow: FollowProfileInfo,
		job: number,
		signal: AbortSignal,
		waitForDownloadSlot: () => Promise<void>
	) {
		const profile: ProfileInfo = follow;
		let latestDownloadedBytes = 0;
		let dbRestartRetries = 0;

		for (let attempt = 0; attempt <= BATCH_RATE_LIMIT_RETRIES; attempt += 1) {
			updateBatchItem(follow.did, {
				status: 'waiting',
				detail: attempt > 0 ? `Retry ${attempt} queued` : 'Queued',
				retries: attempt
			});
			await waitForDownloadSlot();
			if (signal.aborted || job !== activeBatchJob) throw new DOMException('Aborted', 'AbortError');

			try {
				updateBatchItem(follow.did, {
					status: 'downloading',
					detail: attempt > 0 ? `Retry ${attempt}` : 'Starting download'
				});
				const result = await downloadAndIngestProfileRepo(
					profile,
					{
						onDownloadProgress: (downloadProgress) => {
							latestDownloadedBytes = downloadProgress.receivedBytes;
							updateBatchItem(follow.did, {
								status: 'downloading',
								detail: buildRepoDownloadDetail(downloadProgress),
								downloadedBytes: downloadProgress.receivedBytes
							});
						},
						onParseProgress: (count) => {
							updateBatchItem(follow.did, {
								status: 'parsing',
								detail: buildRepoParseDetail(count, latestDownloadedBytes)
							});
						},
						onPhase: (phase, detail) => {
							if (phase === 'index') {
								updateBatchItem(follow.did, {
									status: 'indexing',
									detail: detail ?? 'Writing rows'
								});
							}
						}
					},
					signal
				);
				updateBatchItem(follow.did, {
					status: 'done',
					detail: `${result.account.self_reply_thread_count.toLocaleString()} self-reply thread${result.account.self_reply_thread_count === 1 ? '' : 's'}`,
					error: null,
					downloadedBytes: result.account.downloaded_bytes,
					threadCount: result.account.self_reply_thread_count
				});
				return;
			} catch (err: any) {
				if (err?.name === 'AbortError' || signal.aborted || job !== activeBatchJob) throw err;
				if (isViewer2DuckDbFatalError(err) && dbRestartRetries < 1) {
					dbRestartRetries += 1;
					const recovered = await recoverDuckDbAfterFatal(err);
					if (recovered) {
						updateBatchItem(follow.did, {
							status: 'waiting',
							detail: 'DuckDB restarted; retrying'
						});
						continue;
					}
				}
				if (isRateLimitError(err) && attempt < BATCH_RATE_LIMIT_RETRIES) {
					updateBatchProgress({ rateLimitHits: batchProgress.rateLimitHits + 1 });
					const backoffMs = BATCH_RATE_LIMIT_BACKOFF_MS * (attempt + 1);
					updateBatchItem(follow.did, {
						status: 'waiting',
						detail: `Rate limited; retrying in ${formatDuration(backoffMs)}`,
						retries: attempt + 1
					});
					await abortableSleep(backoffMs, signal);
					continue;
				}
				throw err;
			}
		}
	}

	async function runFollowBatchDownload() {
		if (batchDownloading || loadingFollows) return;
		const client = await ensureDb();
		if (!client) return;
		if (activeFollows.length === 0) {
			toastInfo('Select at least one follow to download.');
			return;
		}

		const loaded = new Set(accounts.map((account) => account.did));
		const targets = activeFollows.filter((follow) => !loaded.has(follow.did));
		const skipped = activeFollows.length - targets.length;
		if (targets.length === 0) {
			batchItems = activeFollows.map(buildBatchItem);
			batchProgress = {
				done: 0,
				total: activeFollows.length,
				active: 0,
				failed: 0,
				skipped,
				rateLimitHits: 0
			};
			toastInfo('Selected follow repos are already indexed.');
			return;
		}

		const job = ++activeBatchJob;
		const controller = new AbortController();
		abortController?.abort();
		abortController = controller;
		loading = true;
		batchDownloading = true;
		error = null;
		batchItems = activeFollows.map(buildBatchItem);
		updateBatchProgress({
			done: 0,
			total: activeFollows.length,
			active: 0,
			failed: 0,
			skipped,
			rateLimitHits: 0
		});

		let nextTargetIndex = 0;
		let nextStartAt = 0;
		const workerCount = Math.min(normalizeBatchConcurrency(batchConcurrency), targets.length);
		const waitForDownloadSlot = async () => {
			const delayMs = normalizeBatchStartDelayMs(batchStartDelayMs);
			const now = Date.now();
			const startAt = Math.max(now, nextStartAt);
			nextStartAt = startAt + delayMs;
			await abortableSleep(Math.max(0, startAt - now), controller.signal);
		};

		const worker = async () => {
			while (nextTargetIndex < targets.length && !controller.signal.aborted) {
				const follow = targets[nextTargetIndex];
				nextTargetIndex += 1;
				updateBatchProgress({ active: batchProgress.active + 1 });
				try {
					await loadFollowRepoForBatch(follow, job, controller.signal, waitForDownloadSlot);
					updateBatchProgress({ done: batchProgress.done + 1 });
				} catch (err: any) {
					if (err?.name === 'AbortError' || controller.signal.aborted || job !== activeBatchJob) {
						updateBatchItem(follow.did, {
							status: 'pending',
							detail: 'Canceled',
							error: null
						});
						return;
					}
					updateBatchItem(follow.did, {
						status: 'failed',
						detail: '',
						error: err?.message || 'Download failed.'
					});
					updateBatchProgress({ failed: batchProgress.failed + 1 });
				} finally {
					updateBatchProgress({ active: Math.max(0, batchProgress.active - 1) });
				}
			}
		};

		try {
			await Promise.all(Array.from({ length: workerCount }, () => worker()));
			if (!controller.signal.aborted && job === activeBatchJob) {
				await refreshDbState();
				await runGalleryQuery({ resetPage: true });
				if (batchProgress.failed > 0) {
					toastInfo(
						`Indexed ${batchProgress.done.toLocaleString()} follow repo${batchProgress.done === 1 ? '' : 's'}; ${batchProgress.failed.toLocaleString()} failed.`
					);
				} else {
					toastSuccess(`Indexed ${batchProgress.done.toLocaleString()} follow repo${batchProgress.done === 1 ? '' : 's'}.`);
				}
			}
		} finally {
			if (abortController === controller) abortController = null;
			if (job === activeBatchJob) {
				loading = false;
				batchDownloading = false;
				progress = {
					phase: 'Batch download complete',
					current: batchProcessedCount(),
					total: batchProgress.total,
					detail: buildBatchProgressDetail()
				};
			}
		}
	}

	function findThreadForUri(uri: string): SelfReplyThread | null {
		function contains(post: ThreadPost): boolean {
			if (post.uri === uri) return true;
			return post.children.some(contains);
		}
		return displayedThreads.find((thread) => thread.rootUri === uri || contains(thread.rootPost)) ?? null;
	}

	function threadToBlueskyUrl(rootUri: string): string | null {
		const thread = findThreadForUri(rootUri);
		return buildBskyPostUrl(rootUri, thread?.rootPost.author.handle);
	}

	async function openExpandedThread(rootUri: string) {
		savedScrollY = window.scrollY;
		showExpanded = true;
		showBlogReader = false;
		blogThread = null;
		const cached = expandedThreadCache.get(rootUri);
		if (cached) {
			expandedThread = cached;
			expandedLoading = false;
			return;
		}
		expandedLoading = true;
		try {
			const thread = await getFullThread(rootUri);
			expandedThread = thread;
			expandedThreadCache.set(rootUri, thread);
		} catch (err: any) {
			toastError(err?.message || 'Failed to load full thread.');
			showExpanded = false;
			expandedThread = null;
		} finally {
			expandedLoading = false;
		}
	}

	function openBlogThread(rootUri: string) {
		const localThread = findThreadForUri(rootUri);
		if (!localThread) {
			toastError('Could not find this thread in the current results.');
			return;
		}
		const job = ++activeBlogJob;
		savedScrollY = window.scrollY;
		blogThread = localThread;
		blogLoadingFullThread = true;
		showBlogReader = true;
		showExpanded = false;
		expandedThread = null;
		requestAnimationFrame(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
		void (async () => {
			try {
				const cached = expandedThreadCache.get(rootUri);
				const thread = cached ?? (await getFullThread(rootUri));
				if (job !== activeBlogJob || !showBlogReader) return;
				expandedThreadCache.set(rootUri, thread);
				blogThread = thread;
			} catch {
				if (job === activeBlogJob && showBlogReader) {
					toastInfo('Showing the DuckDB copy; full thread could not be completed.');
				}
			} finally {
				if (job === activeBlogJob) blogLoadingFullThread = false;
			}
		})();
	}

	function handleBlogBack() {
		activeBlogJob += 1;
		showBlogReader = false;
		blogThread = null;
		blogLoadingFullThread = false;
		requestAnimationFrame(() => window.scrollTo(0, savedScrollY));
	}

	function handleBack() {
		showExpanded = false;
		requestAnimationFrame(() => window.scrollTo(0, savedScrollY));
	}

	async function handleShare(rootUri: string) {
		try {
			const bskyUrl = threadToBlueskyUrl(rootUri);
			if (!bskyUrl) {
				toastError('Could not build a share link for this thread.');
				return;
			}
			const shareUrl = new URL(buildViewerHref('threadviewer', { url: bskyUrl }), window.location.origin);
			await navigator.clipboard.writeText(shareUrl.toString());
			toastSuccess('Link copied to clipboard');
		} catch {
			toastError('Failed to copy link');
		}
	}

	function handleOpenOnBluesky(rootUri: string) {
		const bskyUrl = threadToBlueskyUrl(rootUri);
		if (!bskyUrl) {
			toastError('Could not build Bluesky link for this thread.');
			return;
		}
		const opened = window.open(bskyUrl, '_blank', 'noopener,noreferrer');
		if (!opened) toastInfo('Allow popups to open this thread in a new tab.');
	}

	function buildTreeviewerEmbedSrc(thread: SelfReplyThread): string | null {
		const threadUrl =
			buildBskyPostUrl(thread.rootUri, thread.rootPost.author.handle) ??
			buildBskyPostUrl(thread.rootUri);
		if (!threadUrl) return null;
		const href = buildViewerHref('treeviewer', { url: threadUrl });
		return `${href}${href.includes('?') ? '&' : '?'}embed=thread-section`;
	}

	onMount(async () => {
		try {
			const savedFont = localStorage.getItem('preferred-font');
			if (savedFont && savedFont in fontFamilies) fontKey = savedFont;
			const savedContent = localStorage.getItem('viewer2db-gallery-content');
			if (savedContent === 'all' || savedContent === 'media' || savedContent === 'images' || savedContent === 'movies') {
				galleryContentMode = savedContent;
			}
			const savedGroup = localStorage.getItem('viewer2db-gallery-group');
			if (savedGroup === 'threads' || savedGroup === 'posts') galleryGroupMode = savedGroup;
			const savedSort = localStorage.getItem('viewer2db-sort');
			if (savedSort === 'depth' || savedSort === 'newest' || savedSort === 'oldest' || savedSort === 'liked' || savedSort === 'reposted' || savedSort === 'quoted') {
				threadSortMode = savedSort;
			}
			const savedPageSize = Number(localStorage.getItem('viewer2db-page-size'));
			if (Number.isFinite(savedPageSize) && savedPageSize > 0) pageSize = Math.max(25, Math.min(500, Math.round(savedPageSize)));
			const savedZoom = localStorage.getItem('viewer2db-grid-zoom');
			if (savedZoom) galleryGridZoom = normalizeGalleryGridZoom(savedZoom);
		} catch {}

		const params = new URLSearchParams(window.location.search);
		const handleParam = normalizeHandle(params.get('handle'));
		if (handleParam) initialHandle = handleParam;
		await ensureDb();
		if (handleParam) {
			try {
				const profile = await getProfile(handleParam);
				await handleProfileSelected(profile);
			} catch {
				toastInfo('Could not load profile from URL');
			}
		}
		if (accounts.length > 0) await runGalleryQuery({ resetPage: true });
	});

	$effect(() => {
		if (!browser) return;
		try {
			localStorage.setItem('viewer2db-gallery-content', galleryContentMode);
			localStorage.setItem('viewer2db-gallery-group', galleryGroupMode);
			localStorage.setItem('viewer2db-sort', threadSortMode);
			localStorage.setItem('viewer2db-page-size', String(pageSize));
			localStorage.setItem('viewer2db-grid-zoom', String(galleryGridZoom));
		} catch {}
	});

	onDestroy(() => {
		abortController?.abort();
		followLoadController?.abort();
		void dbClient?.close();
		dbClient = null;
	});
</script>

<svelte:head>
	<title>Repo DB - Bluesky Thread Viewer</title>
</svelte:head>

<main style="font-family: {fontFamily}" class:detail-main={detailIsOpen}>
	{#if showBlogReader && blogThread}
		<section class="blog-reader-shell" aria-label="Blog reader">
			<div class="blog-reader-toolbar">
				<button class="blog-back-btn wobbly-border" onclick={handleBlogBack}>&#8592; Back to results</button>
				{#if blogLoadingFullThread}
					<span class="blog-status">Completing thread...</span>
				{/if}
			</div>
			<BlogArticle thread={blogThread} />
		</section>
	{/if}

	<div class="viewer-chrome" class:parked={showBlogReader} aria-hidden={showBlogReader}>
		<header>
			<RouteNav current="viewer2db" align="center" handle={selectedProfile?.handle || initialHandle} />
			<h1>Repo DB</h1>
			<FontPicker value={fontKey} onchange={handleFontChange} />
		</header>

		<section class="workbench wobbly-border-light">
			<div class="db-status">
				{#if dbInitializing}
					<span>Opening DuckDB...</span>
				{:else if dbError}
					<span class="status-error">{dbError}</span>
				{:else if dbReady}
					<span>{overview.accountCount.toLocaleString()} repos</span>
					<span>{overview.postCount.toLocaleString()} posts</span>
					<span>{overview.selfReplyThreadCount.toLocaleString()} self-reply threads</span>
					<span>{formatBytes(overview.downloadedBytes)}</span>
				{:else}
					<span>DuckDB not open</span>
				{/if}
			</div>

			<div class="search-row">
				<SearchBar
					onsearch={(handle) => void handleSearch(handle)}
					onprofile={handleProfileSelected}
					disabled={loading || batchDownloading || dbInitializing}
					{initialHandle}
					placeholder="Download a Bluesky repo into DuckDB..."
					buttonLabel="Download Repo"
				/>
			</div>

			{#if accounts.length > 0}
				<div class="account-strip">
					{#each accounts.slice(0, 16) as account (account.did)}
						<div class="account-chip" class:error={Boolean(account.last_error)}>
							{#if account.avatar}
								<img src={account.avatar} alt="" />
							{:else}
								<span class="avatar-fallback">{account.handle.slice(0, 1).toUpperCase()}</span>
							{/if}
							<span>
								<strong>@{account.handle}</strong>
								<small>{account.self_reply_thread_count.toLocaleString()} threads</small>
							</span>
						</div>
					{/each}
					{#if accounts.length > 16}
						<span class="account-more">+{(accounts.length - 16).toLocaleString()}</span>
					{/if}
				</div>
			{/if}

			{#if selectedProfile}
				<div class="follow-batch-panel">
					<div class="follow-batch-head">
						<div class="follow-batch-title">
							<strong>Follow repos</strong>
							<span>@{(followsSubject ?? selectedProfile).handle}</span>
						</div>
						<div class="follow-batch-actions">
							<button
								type="button"
								class="mini-action-btn"
								disabled={loadingFollows || batchDownloading || loading}
								onclick={loadFollowsForBatch}
							>
								{loadingFollows ? 'Loading...' : follows.length > 0 ? 'Refresh' : 'Load follows'}
							</button>
							{#if follows.length > 0}
								<button
									type="button"
									class="mini-action-btn"
									disabled={batchDownloading}
									onclick={() => (showFollowEditor = !showFollowEditor)}
								>
									{showFollowEditor ? 'Done' : 'Edit list'}
								</button>
							{/if}
						</div>
					</div>

					{#if follows.length > 0}
						<div class="follow-batch-summary">
							<span>{follows.length.toLocaleString()} follows</span>
							<span>{activeFollows.length.toLocaleString()} selected</span>
							<span>{downloadableActiveFollows.length.toLocaleString()} not indexed</span>
						</div>

						{#if showFollowEditor}
							<div class="follow-editor">
								<div class="follow-editor-toolbar">
									<input class="follow-filter" type="text" bind:value={followFilter} placeholder="Filter accounts..." />
									<button type="button" class="mini-action-btn" disabled={batchDownloading} onclick={selectAllFollows}>All</button>
									<button type="button" class="mini-action-btn" disabled={batchDownloading} onclick={clearAllFollows}>None</button>
								</div>
								<ul class="follow-list">
									{#each filteredFollows as follow (follow.did)}
										{@const selected = !excludedFollowDids.has(follow.did)}
										{@const loaded = loadedRepoDids.has(follow.did)}
										<li class:deselected={!selected}>
											<label>
												<input type="checkbox" checked={selected} disabled={batchDownloading} onchange={() => toggleFollow(follow.did)} />
												{#if follow.avatar}
													<img class="follow-avatar" src={follow.avatar} alt="" />
												{:else}
													<span class="follow-avatar follow-avatar-fallback">{follow.handle.slice(0, 1).toUpperCase()}</span>
												{/if}
												<span class="follow-names">
													<strong>{follow.displayName || follow.handle}</strong>
													<small>@{follow.handle}</small>
												</span>
												{#if loaded}
													<span class="loaded-badge">Indexed</span>
												{/if}
											</label>
										</li>
									{/each}
								</ul>
							</div>
						{/if}

						<div class="batch-controls">
							<label>
								<span>Concurrent</span>
								<input
									type="number"
									min={BATCH_CONCURRENCY_MIN}
									max={BATCH_CONCURRENCY_MAX}
									step="1"
									value={batchConcurrency}
									disabled={batchDownloading}
									oninput={(event) => setBatchConcurrency(event.currentTarget.value)}
								/>
							</label>
							<label>
								<span>Start delay</span>
								<input
									type="number"
									min={BATCH_START_DELAY_MIN_MS}
									max={BATCH_START_DELAY_MAX_MS}
									step="250"
									value={batchStartDelayMs}
									disabled={batchDownloading}
									oninput={(event) => setBatchStartDelayMs(event.currentTarget.value)}
								/>
								<small>ms</small>
							</label>
							{#if batchDownloading}
								<button type="button" class="batch-download-btn" onclick={cancelFetch}>Cancel batch</button>
							{:else}
								<button
									type="button"
									class="batch-download-btn"
									disabled={loading || downloadableActiveFollows.length === 0}
									onclick={runFollowBatchDownload}
								>
									Download {downloadableActiveFollows.length.toLocaleString()} repo{downloadableActiveFollows.length === 1 ? '' : 's'}
								</button>
							{/if}
						</div>

						{#if batchProgress.total > 0}
							<div class="batch-status">
								<span>{batchProcessedCount().toLocaleString()} / {batchProgress.total.toLocaleString()} processed</span>
								{#if batchProgress.active > 0}<span>{batchProgress.active.toLocaleString()} active</span>{/if}
								{#if batchProgress.failed > 0}<span>{batchProgress.failed.toLocaleString()} failed</span>{/if}
								{#if batchProgress.rateLimitHits > 0}<span>{batchProgress.rateLimitHits.toLocaleString()} rate-limit backoffs</span>{/if}
							</div>
						{/if}

						{#if batchItems.length > 0}
							<ul class="batch-item-list">
								{#each batchItems as item (item.did)}
									<li class:failed={item.status === 'failed'} class:done={item.status === 'done'}>
										<span class="batch-item-name">@{item.handle}</span>
										<span class="batch-item-status">{batchItemStatusLabel(item.status)}</span>
										{#if item.detail}<span class="batch-item-detail">{item.detail}</span>{/if}
										{#if item.error}<span class="batch-item-error">{item.error}</span>{/if}
									</li>
								{/each}
							</ul>
						{/if}
					{/if}
				</div>
			{/if}
		</section>

		{#if error}
			<ErrorBanner message={error} />
		{/if}
	</div>

	{#if showExpanded}
		<section class="panel-detail">
			{#if expandedLoading}
				<LoadingSpinner progress={{ phase: 'Loading full thread...', current: 0, total: 0 }} />
			{:else if expandedThread}
				<div class="expanded-actions">
					<button class="back-btn wobbly-border" onclick={handleBack}>&#8592; Back to results</button>
				</div>
				{#if expandedThread.isTruncated}
					<p class="truncation-warning">Some replies may be missing</p>
				{/if}
				{#if buildTreeviewerEmbedSrc(expandedThread)}
					<iframe class="treeviewer-frame" src={buildTreeviewerEmbedSrc(expandedThread) ?? undefined} title="Treeviewer"></iframe>
				{/if}
			{/if}
		</section>
	{/if}

	<section class="results-layer" class:parked={detailIsOpen} aria-hidden={detailIsOpen} bind:this={resultsLayerEl}>
		<div class="query-panel wobbly-border-light">
			<div class="query-grid">
				<label class="query-text">
					<span>Query</span>
					<input type="text" bind:value={searchQuery} placeholder={searchMode === 'regex' ? 'DuckDB regex...' : 'Exact text...'} />
				</label>
				<label>
					<span>Mode</span>
					<select bind:value={searchMode}>
						<option value="literal">Literal</option>
						<option value="regex">Regex</option>
					</select>
				</label>
				<label>
					<span>Min depth</span>
					<input type="number" min="1" max="200" bind:value={minDepth} />
				</label>
				<label>
					<span>Gallery</span>
					<select bind:value={galleryContentMode}>
						<option value="all">All</option>
						<option value="media">Media</option>
						<option value="images">Images</option>
						<option value="movies">Movies</option>
					</select>
				</label>
				<label>
					<span>Group</span>
					<select bind:value={galleryGroupMode}>
						<option value="threads">Threads</option>
						<option value="posts">Posts</option>
					</select>
				</label>
				<label>
					<span>Sort</span>
					<select bind:value={threadSortMode}>
						<option value="depth">Depth</option>
						<option value="newest">Newest</option>
						<option value="oldest">Oldest</option>
						<option value="liked">Liked</option>
						<option value="reposted">Reposted</option>
						<option value="quoted">Quoted</option>
					</select>
				</label>
				<label>
					<span>Limit</span>
					<input type="number" min="25" max="500" step="25" bind:value={pageSize} />
				</label>
				<label>
					<span>Grid</span>
					<input
						type="range"
						min={GALLERY_GRID_ZOOM_MIN}
						max={GALLERY_GRID_ZOOM_MAX}
						step="5"
						value={galleryGridZoom}
						oninput={(event) => setGalleryGridZoom(event.currentTarget.value)}
					/>
				</label>
			</div>
			<div class="date-row">
				<SearchOptions bind:dateFrom bind:dateTo />
			</div>
			<div class="query-actions">
				<button type="button" class="run-query-btn wobbly-border" disabled={!dbReady || queryLoading} onclick={() => runGalleryQuery({ resetPage: true })}>
					{queryLoading ? 'Querying...' : 'Run query'}
				</button>
				{#if totalResults > 0}
					<div class="pager">
						<button type="button" disabled={pageIndex <= 0 || queryLoading} onclick={() => setPage(pageIndex - 1)}>Prev</button>
						<span>Page {pageIndex + 1} / {totalPages}</span>
						<button type="button" disabled={pageIndex + 1 >= totalPages || queryLoading} onclick={() => setPage(pageIndex + 1)}>Next</button>
					</div>
				{/if}
			</div>
		</div>

		{#if loading}
			<LoadingSpinner {progress} />
			<div class="cancel-row">
				<button class="cancel-btn wobbly-border" onclick={cancelFetch}>Cancel</button>
			</div>
		{/if}

		{#if queryLoading && !loading}
			<LoadingSpinner progress={{ phase: 'Querying DuckDB...', current: 0, total: 0 }} />
		{/if}

		{#if hasQueried}
			<p class="results-count">
				{totalResults.toLocaleString()} matching thread{totalResults === 1 ? '' : 's'}
				{#if totalResults > 0}
					<span>showing {(pageIndex * pageSize + 1).toLocaleString()}-{Math.min(totalResults, (pageIndex + 1) * pageSize).toLocaleString()}</span>
				{/if}
			</p>
		{/if}

		{#if displayedThreads.length > 0}
			<VirtualThreadList
				threads={displayedThreads}
				renderMode="gallery"
				{galleryContentMode}
				{galleryGroupMode}
				{galleryMediaLayout}
				{galleryMediaFit}
				{galleryGridZoom}
				searchQuery={gallerySearchQuery}
				searchMode={gallerySearchMode}
				{highlightedThread}
				{collapsedByRootUri}
				oncollapsedchange={setThreadCollapsed}
				onexpand={openExpandedThread}
				onblog={openBlogThread}
				onshare={handleShare}
				onopenbluesky={handleOpenOnBluesky}
			/>
		{:else if hasQueried && !queryLoading && !loading}
			<div class="empty-state">
				<p>No DuckDB rows match the current query.</p>
			</div>
		{:else if !loading && !queryLoading && accounts.length === 0}
			<div class="empty-state">
				<p>Download one or more repos to build the local DuckDB gallery.</p>
			</div>
		{/if}
	</section>
</main>

<style>
	main {
		max-width: 1280px;
		margin: 0 auto;
		padding: 32px 20px 80px;
	}

	main.detail-main {
		max-width: none;
	}

	header {
		text-align: center;
		margin-bottom: 24px;
	}

	h1 {
		margin: 0;
		color: var(--text-ink);
		font-size: 2.1rem;
	}

	.parked {
		display: none;
	}

	.workbench,
	.query-panel {
		margin: 0 auto 18px;
		padding: 14px;
		background: var(--card-bg);
		border-color: var(--control-border);
		box-shadow: var(--shadow-soft);
	}

	.workbench {
		max-width: 900px;
	}

	.db-status,
	.account-strip,
	.follow-batch-head,
	.follow-batch-actions,
	.follow-batch-summary,
	.follow-editor-toolbar,
	.batch-controls,
	.batch-status,
	.query-actions,
	.pager {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 8px;
	}

	.db-status {
		justify-content: center;
		margin-bottom: 12px;
		color: var(--muted);
		font-size: 0.88rem;
	}

	.db-status span,
	.follow-batch-summary span,
	.batch-status span {
		padding: 2px 8px;
		border: 1px solid var(--control-border);
		border-radius: 999px;
		background: color-mix(in srgb, var(--control-bg) 70%, transparent);
	}

	.status-error,
	.batch-item-error,
	.batch-item-list li.failed {
		color: var(--danger-text);
	}

	.search-row :global(.search-bar) {
		max-width: 680px;
	}

	.account-strip {
		justify-content: center;
		margin-top: 12px;
	}

	.account-chip {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		max-width: 260px;
		padding: 6px 10px;
		border: 1px solid var(--control-border);
		border-radius: 999px;
		background: color-mix(in srgb, var(--control-bg) 72%, transparent);
	}

	.account-chip.error {
		border-color: var(--danger-text);
	}

	.account-chip img,
	.avatar-fallback,
	.follow-avatar {
		width: 28px;
		height: 28px;
		border-radius: 999px;
		object-fit: cover;
	}

	.avatar-fallback,
	.follow-avatar-fallback {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		background: var(--control-bg);
		color: var(--text-ink);
		font-size: 0.78rem;
	}

	.account-chip span {
		display: flex;
		flex-direction: column;
		min-width: 0;
		line-height: 1.15;
	}

	.account-chip strong,
	.batch-item-name {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.account-chip small,
	.account-more,
	.follow-batch-title span,
	.follow-batch-summary,
	.batch-status,
	.follow-names small {
		color: var(--muted);
		font-size: 0.78rem;
	}

	.follow-batch-panel {
		margin-top: 14px;
		padding-top: 12px;
		border-top: 1px solid var(--control-border);
	}

	.follow-batch-head {
		justify-content: space-between;
	}

	.follow-batch-title {
		display: flex;
		align-items: baseline;
		gap: 8px;
	}

	button,
	input,
	select {
		font: inherit;
	}

	.mini-action-btn,
	.batch-download-btn,
	.run-query-btn,
	.pager button {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-height: 31px;
		padding: 6px 11px;
		border: 1px solid var(--control-border);
		border-radius: 8px;
		background: var(--control-bg);
		color: var(--text-ink);
		font-size: 0.82rem;
		font-weight: 700;
		cursor: pointer;
	}

	.mini-action-btn:hover:not(:disabled),
	.batch-download-btn:hover:not(:disabled),
	.run-query-btn:hover:not(:disabled),
	.pager button:hover:not(:disabled) {
		color: var(--accent);
		border-color: var(--accent);
	}

	button:disabled {
		cursor: not-allowed;
		opacity: 0.55;
	}

	.follow-editor {
		margin-top: 10px;
		padding-top: 10px;
		border-top: 1px solid var(--control-border);
	}

	.follow-filter,
	.query-grid input,
	.query-grid select {
		min-width: 0;
		padding: 7px 9px;
		border: 1px solid var(--control-border);
		border-radius: 8px;
		background: var(--control-bg);
		color: var(--text-ink);
	}

	.follow-filter {
		flex: 1 1 240px;
	}

	.follow-list,
	.batch-item-list {
		list-style: none;
		margin: 8px 0 0;
		padding: 0;
		overflow-y: auto;
	}

	.follow-list {
		max-height: 280px;
	}

	.follow-list li {
		border-top: 1px solid color-mix(in srgb, var(--control-border) 55%, transparent);
	}

	.follow-list li.deselected {
		opacity: 0.52;
	}

	.follow-list label {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 6px 2px;
		cursor: pointer;
	}

	.follow-names {
		display: flex;
		flex: 1;
		flex-direction: column;
		min-width: 0;
		line-height: 1.15;
	}

	.loaded-badge {
		margin-left: auto;
		padding: 1px 7px;
		border: 1px solid color-mix(in srgb, var(--accent) 35%, var(--control-border));
		border-radius: 999px;
		color: var(--accent);
		font-size: 0.72rem;
		font-weight: 700;
	}

	.batch-controls {
		margin-top: 10px;
		padding-top: 10px;
		border-top: 1px solid var(--control-border);
	}

	.batch-controls label {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		color: var(--muted);
		font-size: 0.82rem;
	}

	.batch-controls input {
		width: 78px;
		padding: 5px 7px;
	}

	.batch-download-btn {
		margin-left: auto;
		background: color-mix(in srgb, var(--accent) 14%, var(--control-bg));
	}

	.batch-item-list {
		max-height: 190px;
		border-top: 1px solid var(--control-border);
	}

	.batch-item-list li {
		display: grid;
		grid-template-columns: minmax(120px, 1fr) auto minmax(0, 1.4fr);
		gap: 8px;
		align-items: center;
		padding: 6px 2px;
		border-bottom: 1px solid color-mix(in srgb, var(--control-border) 55%, transparent);
		color: var(--muted);
		font-size: 0.8rem;
	}

	.batch-item-list li.done {
		color: var(--text-ink);
	}

	.batch-item-status {
		padding: 1px 7px;
		border: 1px solid var(--control-border);
		border-radius: 999px;
		background: color-mix(in srgb, var(--control-bg) 70%, transparent);
		font-size: 0.72rem;
		font-weight: 700;
	}

	.batch-item-detail,
	.batch-item-error {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.query-panel {
		max-width: 1180px;
	}

	.query-grid {
		display: grid;
		grid-template-columns: minmax(220px, 1.5fr) repeat(7, minmax(92px, 1fr));
		gap: 10px;
		align-items: end;
	}

	.query-grid label {
		display: flex;
		flex-direction: column;
		gap: 4px;
		color: var(--muted);
		font-size: 0.8rem;
		font-weight: 700;
	}

	.query-text input {
		width: 100%;
	}

	.date-row {
		margin-top: 10px;
	}

	.query-actions {
		justify-content: center;
		margin-top: 12px;
	}

	.run-query-btn {
		border-color: var(--accent);
		background: color-mix(in srgb, var(--accent) 18%, var(--control-bg));
	}

	.pager {
		color: var(--muted);
		font-size: 0.86rem;
	}

	.results-count {
		margin: 12px 0;
		text-align: center;
		color: var(--muted);
		font-size: 0.95rem;
	}

	.results-count span {
		margin-left: 8px;
	}

	.cancel-row,
	.empty-state {
		text-align: center;
	}

	.cancel-btn,
	.back-btn,
	.blog-back-btn {
		display: inline-block;
		padding: 6px 16px;
		background: var(--card-bg);
		color: var(--text-ink);
		border-color: var(--muted);
		cursor: pointer;
	}

	.panel-detail {
		width: 100vw;
		position: relative;
		left: 50%;
		transform: translateX(-50%);
		box-sizing: border-box;
		padding: 0 20px;
	}

	.expanded-actions {
		display: flex;
		gap: 8px;
		margin-bottom: 16px;
	}

	.treeviewer-frame {
		display: block;
		width: 100%;
		height: min(82vh, 900px);
		min-height: 620px;
		border: 1.5px solid var(--control-border);
		border-radius: 8px;
		background: var(--card-bg);
	}

	.truncation-warning {
		margin: 0 0 8px;
		padding: 6px 12px;
		border: 1px solid #ffc107;
		border-radius: 6px;
		background: #fff3cd;
		color: #856404;
		text-align: center;
		font-size: 0.85rem;
	}

	.blog-reader-shell {
		width: min(100%, 980px);
		min-height: calc(100vh - 104px);
		margin: 0 auto;
	}

	.blog-reader-toolbar {
		position: sticky;
		top: 0;
		z-index: 20;
		display: flex;
		align-items: center;
		gap: 10px;
		margin-bottom: 18px;
		padding: 0 0 18px;
		background: linear-gradient(
			to bottom,
			var(--bg-paper) 0%,
			var(--bg-paper) calc(100% - 10px),
			color-mix(in srgb, var(--bg-paper) 0%, transparent) 100%
		);
	}

	.blog-status {
		padding: 4px 8px;
		border-radius: 999px;
		background: color-mix(in srgb, var(--card-bg) 78%, transparent);
		color: var(--muted);
		font-size: 0.84rem;
	}

	.empty-state {
		padding: 48px 24px;
		color: var(--muted);
	}

	@media (max-width: 980px) {
		.query-grid {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}

		.query-text {
			grid-column: 1 / -1;
		}
	}

	@media (max-width: 640px) {
		main {
			padding-inline: 14px;
		}

		.query-grid {
			grid-template-columns: minmax(0, 1fr);
		}

		.follow-batch-head,
		.batch-controls {
			align-items: stretch;
			flex-direction: column;
		}

		.batch-download-btn {
			width: 100%;
			margin-left: 0;
		}

		.batch-item-list li {
			grid-template-columns: minmax(0, 1fr) auto;
		}

		.batch-item-detail,
		.batch-item-error {
			grid-column: 1 / -1;
		}
	}
</style>
