<script lang="ts">
	import { onMount } from 'svelte';
	import { browser } from '$app/environment';
	import '../../app.css';
	import ErrorBanner from '$lib/components/ErrorBanner.svelte';
	import FontPicker from '$lib/components/FontPicker.svelte';
	import LoadingSpinner from '$lib/components/LoadingSpinner.svelte';
	import RouteNav from '$lib/components/RouteNav.svelte';
	import SearchBar from '$lib/components/SearchBar.svelte';
	import type { AuthorInfo, DiscoverProgress, SelfReplyThread, ThreadPost } from '$lib/types';
	import { getProfile, type ProfileInfo } from '$lib/api/bluesky';
	import {
		loadRepoFeedItems,
		type RepoDownloadProgress
	} from '$lib/utils/repoHydration';
	import { buildThreadsFromFeed } from '$lib/utils/threadWalker';
	import { buildBskyPostUrl } from '$lib/utils/viewerLinks';

	type Period = 'am' | 'pm';
	type RepoStats = {
		totalPosts: number;
		elapsedMs: number;
		downloadedBytes: number;
		source: 'pds' | 'relay' | null;
	};
	type ClockSlot = {
		key: string;
		index: number;
		hour24: number;
		label: string;
		rangeLabel: string;
		threads: SelfReplyThread[];
		totalPosts: number;
		style: string;
	};
	type ThreadDetail = {
		post: ThreadPost;
		level: number;
		index: number;
	};

	const fontFamilies: Record<string, string> = {
		virgil: "'Virgil', cursive",
		caveat: "'Caveat', cursive",
		patrick: "'Patrick Hand', cursive",
		'comic-neue': "'Comic Neue', cursive",
		inter: "'Inter', sans-serif",
		system: 'system-ui, -apple-system, sans-serif'
	};

	const dateLabelFormatter = new Intl.DateTimeFormat('en-US', {
		weekday: 'short',
		month: 'short',
		day: 'numeric',
		year: 'numeric'
	});
	const timeFormatter = new Intl.DateTimeFormat('en-US', {
		hour: 'numeric',
		minute: '2-digit'
	});
	let fontKey = $state('patrick');
	let fontFamily = $derived(fontFamilies[fontKey] ?? fontFamilies.patrick);
	let initialHandle = $state('');
	let selectedProfile = $state<ProfileInfo | null>(null);
	let author = $state<AuthorInfo | null>(null);
	let allThreads = $state<SelfReplyThread[]>([]);
	let loading = $state(false);
	let error = $state<string | null>(null);
	let hasSearched = $state(false);
	let progress = $state<DiscoverProgress>({
		phase: 'Downloading repository...',
		current: 0,
		total: 0
	});
	let repoStats = $state<RepoStats>({
		totalPosts: 0,
		elapsedMs: 0,
		downloadedBytes: 0,
		source: null
	});
	let stats = $state({
		postsScanned: 0,
		chainStarts: 0,
		threadsWithSelfReplies: 0
	});
	let period = $state<Period>('am');
	let selectedDate = $state('');
	let selectedHour = $state<number | null>(null);
	let selectedPostUri = $state<string | null>(null);
	let pageByHour = $state<Record<number, number>>({});
	let abortController = $state<AbortController | null>(null);
	let clockZoom = $state(0.55);

	const MIN_CLOCK_ZOOM = 0.3;
	const MAX_CLOCK_ZOOM = 1.2;
	const CLOCK_ZOOM_STEP = 0.1;

	const sortedThreads = $derived([...allThreads].sort(compareThreadsByTime));
	const dateFilteredThreads = $derived(
		sortedThreads.filter((thread) => !selectedDate || threadDateKey(thread) === selectedDate)
	);
	const availableDates = $derived.by(() => {
		const counts = new Map<string, number>();
		for (const thread of sortedThreads) {
			const key = threadDateKey(thread);
			if (!key) continue;
			counts.set(key, (counts.get(key) ?? 0) + 1);
		}
		return [...counts.entries()]
			.sort((a, b) => b[0].localeCompare(a[0]))
			.map(([value, count]) => ({ value, count }));
	});
	const newestDate = $derived(availableDates[0]?.value ?? '');
	const oldestDate = $derived(availableDates[availableDates.length - 1]?.value ?? '');
	const selectedDateCount = $derived(
		selectedDate ? (availableDates.find((entry) => entry.value === selectedDate)?.count ?? 0) : sortedThreads.length
	);
	const clockSlots = $derived.by(() => buildClockSlots(dateFilteredThreads, period));
	const visibleThreadCount = $derived(
		clockSlots.reduce((total, slot) => total + slot.threads.length, 0)
	);
	const visiblePostCount = $derived(
		clockSlots.reduce((total, slot) => total + slot.totalPosts, 0)
	);
	const maxSlotCount = $derived(
		clockSlots.reduce((max, slot) => Math.max(max, slot.threads.length), 0)
	);
	const selectedSlot = $derived.by(() => {
		if (clockSlots.length === 0) return null;
		if (selectedHour !== null) {
			const matchingSlot = clockSlots.find((slot) => slot.hour24 === selectedHour);
			if (matchingSlot && matchingSlot.threads.length > 0) return matchingSlot;
		}
		return clockSlots.find((slot) => slot.threads.length > 0) ?? clockSlots[0] ?? null;
	});
	const selectedThread = $derived(selectedSlot ? getActiveThread(selectedSlot) : null);
	const selectedThreadDetails = $derived(selectedThread ? threadDetails(selectedThread.rootPost) : []);
	const foregroundPostDetail = $derived.by(() => {
		if (selectedThreadDetails.length === 0) return null;
		if (!selectedPostUri) return selectedThreadDetails[0];
		return selectedThreadDetails.find((detail) => detail.post.uri === selectedPostUri) ?? selectedThreadDetails[0];
	});
	function normalizeHandle(handle: string | null | undefined): string {
		return (handle ?? '').replace(/^@/, '').trim();
	}

	function pad2(value: number): string {
		return String(value).padStart(2, '0');
	}

	function threadTime(thread: SelfReplyThread): number {
		const parsed = Date.parse(thread.rootPost.createdAt);
		return Number.isFinite(parsed) ? parsed : 0;
	}

	function compareThreadsByTime(a: SelfReplyThread, b: SelfReplyThread): number {
		return threadTime(a) - threadTime(b) || b.depth - a.depth;
	}

	function dateInputValue(value: string | null | undefined): string {
		if (!value) return '';
		const date = new Date(value);
		if (Number.isNaN(date.getTime())) return '';
		return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
	}

	function threadDateKey(thread: SelfReplyThread): string {
		return dateInputValue(thread.rootPost.createdAt);
	}

	function hourForThread(thread: SelfReplyThread): number | null {
		const date = new Date(thread.rootPost.createdAt);
		if (Number.isNaN(date.getTime())) return null;
		return date.getHours();
	}

	function hourLabel(hour24: number): string {
		const hour12 = hour24 % 12 || 12;
		const suffix = hour24 < 12 ? 'AM' : 'PM';
		return `${hour12} ${suffix}`;
	}

	function hourRangeLabel(hour24: number): string {
		return `${hourLabel(hour24)} to ${hourLabel((hour24 + 1) % 24)}`;
	}

	function defaultSlotPosition(index: number): { x: number; y: number } {
		const angle = (index * 30 - 90) * (Math.PI / 180);
		return {
			x: 50 + Math.cos(angle) * 37.5,
			y: 50 + Math.sin(angle) * 37.5
		};
	}

	function slotPositionStyle(index: number): string {
		const { x, y } = defaultSlotPosition(index);
		return `--slot-x: ${x.toFixed(3)}%; --slot-y: ${y.toFixed(3)}%;`;
	}

	function buildClockSlots(threads: SelfReplyThread[], nextPeriod: Period): ClockSlot[] {
		const threadsByHour = new Map<number, SelfReplyThread[]>();
		for (const thread of threads) {
			const hour = hourForThread(thread);
			if (hour === null) continue;
			if (nextPeriod === 'am' && hour >= 12) continue;
			if (nextPeriod === 'pm' && hour < 12) continue;
			const bucket = threadsByHour.get(hour) ?? [];
			bucket.push(thread);
			threadsByHour.set(hour, bucket);
		}

		return Array.from({ length: 12 }, (_, index) => {
			const hour24 = nextPeriod === 'am' ? index : index + 12;
			const threadsForHour = threadsByHour.get(hour24) ?? [];
			return {
				key: `${nextPeriod}-${hour24}`,
				index,
				hour24,
				label: String(index === 0 ? 12 : index),
				rangeLabel: hourRangeLabel(hour24),
				threads: threadsForHour,
				totalPosts: threadsForHour.reduce((total, thread) => total + countThreadPosts(thread.rootPost), 0),
				style: slotPositionStyle(index)
			};
		});
	}

	function countThreadPosts(post: ThreadPost): number {
		return 1 + post.children.reduce((total, child) => total + countThreadPosts(child), 0);
	}

	function postTime(post: ThreadPost): number {
		const parsed = Date.parse(post.createdAt);
		return Number.isFinite(parsed) ? parsed : 0;
	}

	function threadDetails(post: ThreadPost): ThreadDetail[] {
		const details: ThreadDetail[] = [];

		function visit(current: ThreadPost, level: number) {
			details.push({ post: current, level, index: details.length + 1 });
			for (const child of [...current.children].sort((a, b) => postTime(a) - postTime(b))) {
				visit(child, level + 1);
			}
		}

		visit(post, 0);
		return details;
	}

	function getPageIndex(hour24: number, total: number): number {
		if (total <= 0) return 0;
		const requested = pageByHour[hour24] ?? 0;
		if (!Number.isFinite(requested)) return 0;
		return Math.min(Math.max(Math.floor(requested), 0), total - 1);
	}

	function getActiveThread(slot: ClockSlot): SelfReplyThread | null {
		return slot.threads[getPageIndex(slot.hour24, slot.threads.length)] ?? null;
	}

	function setPage(hour24: number, total: number, index: number) {
		if (total <= 0) return;
		const nextIndex = ((Math.floor(index) % total) + total) % total;
		pageByHour = { ...pageByHour, [hour24]: nextIndex };
		selectedHour = hour24;
		selectedPostUri = null;
	}

	function turnPage(slot: ClockSlot, delta: number) {
		setPage(slot.hour24, slot.threads.length, getPageIndex(slot.hour24, slot.threads.length) + delta);
	}

	function selectHour(slot: ClockSlot) {
		selectedHour = slot.hour24;
		selectedPostUri = null;
	}

	function focusThreadPost(slot: ClockSlot, pageIndex: number, postUri: string) {
		if (slot.threads.length === 0) return;
		pageByHour = { ...pageByHour, [slot.hour24]: pageIndex };
		selectedHour = slot.hour24;
		selectedPostUri = postUri;
	}

	function adjustClockZoom(delta: number) {
		const next = Math.round((clockZoom + delta) * 100) / 100;
		clockZoom = Math.min(Math.max(next, MIN_CLOCK_ZOOM), MAX_CLOCK_ZOOM);
	}

	function cleanText(text: string): string {
		return text.replace(/\s+/g, ' ').trim() || '(no text)';
	}

	function formatThreadTime(thread: SelfReplyThread): string {
		const date = new Date(thread.rootPost.createdAt);
		return Number.isNaN(date.getTime()) ? 'Unknown time' : timeFormatter.format(date);
	}

	function formatPostTime(post: ThreadPost): string {
		const date = new Date(post.createdAt);
		return Number.isNaN(date.getTime()) ? 'Unknown time' : timeFormatter.format(date);
	}

	function formatSelectedDate(value: string): string {
		if (!value) return 'All dates';
		const date = new Date(`${value}T12:00:00`);
		return Number.isNaN(date.getTime()) ? value : dateLabelFormatter.format(date);
	}

	function formatBytes(bytes: number): string {
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
		return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	}

	function formatDuration(ms: number): string {
		if (ms <= 0) return '0s';
		if (ms < 1000) return `${Math.round(ms)}ms`;
		return `${(ms / 1000).toFixed(1)}s`;
	}

	function formatSpeed(bytesPerSecond: number): string {
		if (bytesPerSecond < 1024) return `${bytesPerSecond.toFixed(0)} B/s`;
		if (bytesPerSecond < 1024 * 1024) return `${(bytesPerSecond / 1024).toFixed(0)} KB/s`;
		return `${(bytesPerSecond / (1024 * 1024)).toFixed(1)} MB/s`;
	}

	function buildRepoDownloadDetail(downloadProgress: RepoDownloadProgress): string {
		const parts = [
			`${formatBytes(downloadProgress.receivedBytes)}${downloadProgress.totalBytes > 0 ? ` / ${formatBytes(downloadProgress.totalBytes)}` : ''}`
		];
		if (downloadProgress.bytesPerSecond > 0) {
			parts.push(formatSpeed(downloadProgress.bytesPerSecond));
		}
		if (downloadProgress.elapsedMs > 0) {
			parts.push(`${formatDuration(downloadProgress.elapsedMs)} elapsed`);
		}
		return parts.join(' / ');
	}

	function buildRepoParseDetail(parsedPosts: number, downloadedBytes: number): string {
		return `${parsedPosts.toLocaleString()} posts extracted from ${formatBytes(downloadedBytes)}`;
	}

	function buildThreadUrl(thread: SelfReplyThread | null): string | null {
		if (!thread) return null;
		return buildBskyPostUrl(thread.rootPost.uri, thread.rootPost.author.handle);
	}

	function updateRouteState(handle = selectedProfile?.handle ?? initialHandle) {
		if (!browser) return;
		const url = new URL(window.location.href);
		const nextHandle = normalizeHandle(handle);
		if (nextHandle) {
			url.searchParams.set('handle', nextHandle);
		} else {
			url.searchParams.delete('handle');
		}
		if (selectedDate) {
			url.searchParams.set('date', selectedDate);
		} else {
			url.searchParams.delete('date');
		}
		url.searchParams.set('period', period);
		window.history.replaceState({}, '', url.toString());
	}

	async function handleProfileSelected(profile: ProfileInfo) {
		selectedProfile = profile;
		initialHandle = profile.handle;
		author = {
			did: profile.did,
			handle: profile.handle,
			displayName: profile.displayName,
			avatar: profile.avatar
		};
	}

	function resetLoadedState() {
		allThreads = [];
		pageByHour = {};
		selectedHour = null;
		selectedPostUri = null;
		stats = { postsScanned: 0, chainStarts: 0, threadsWithSelfReplies: 0 };
		repoStats = { totalPosts: 0, elapsedMs: 0, downloadedBytes: 0, source: null };
		error = null;
	}

	function chooseInitialDate(threads: SelfReplyThread[]) {
		if (selectedDate || threads.length === 0) return;
		const newest = [...threads]
			.sort((a, b) => threadTime(b) - threadTime(a))
			.map(threadDateKey)
			.find(Boolean);
		if (newest) selectedDate = newest;
	}

	function chooseInitialHour(threads: SelfReplyThread[]) {
		const thread = threads.find((candidate) => {
			if (selectedDate && threadDateKey(candidate) !== selectedDate) return false;
			const hour = hourForThread(candidate);
			if (hour === null) return false;
			return period === 'am' ? hour < 12 : hour >= 12;
		});
		selectedHour = thread ? hourForThread(thread) : null;
		selectedPostUri = null;
	}

	async function handleSearch(handle: string, options: { profile?: ProfileInfo | null } = {}): Promise<boolean> {
		const cleaned = normalizeHandle(handle);
		if (!cleaned || loading) return false;

		abortController?.abort();
		const controller = new AbortController();
		abortController = controller;
		loading = true;
		hasSearched = true;
		resetLoadedState();
		updateRouteState(cleaned);

		let success = false;
		let latestDownloadedBytes = 0;

		try {
			let profile =
				options.profile ??
				(selectedProfile &&
				(normalizeHandle(selectedProfile.handle) === cleaned || selectedProfile.did === cleaned)
					? selectedProfile
					: null);
			if (!profile) {
				profile = await getProfile(cleaned);
			}

			await handleProfileSelected(profile);
			updateRouteState(profile.handle);

			const authorInfo: AuthorInfo = {
				did: profile.did,
				handle: profile.handle,
				displayName: profile.displayName,
				avatar: profile.avatar
			};

			progress = { phase: 'Downloading repository...', current: 0, total: 0 };
			const repo = await loadRepoFeedItems(profile.did, authorInfo, {
				signal: controller.signal,
				onDownloadProgress: (downloadProgress) => {
					latestDownloadedBytes = downloadProgress.receivedBytes;
					progress =
						downloadProgress.totalBytes > 0
							? {
									phase: 'Downloading repository...',
									current: Math.round(
										(downloadProgress.receivedBytes / downloadProgress.totalBytes) * 100
									),
									total: 100,
									detail: buildRepoDownloadDetail(downloadProgress)
								}
							: {
									phase: 'Downloading repository...',
									current: 0,
									total: 0,
									detail: buildRepoDownloadDetail(downloadProgress)
								};
				},
				onParseProgress: (count) => {
					progress = {
						phase: 'Parsing repository posts...',
						current: 0,
						total: 0,
						detail: buildRepoParseDetail(count, latestDownloadedBytes)
					};
				}
			});

			progress = {
				phase: 'Building clock threads...',
				current: 0,
				total: repo.feedItems.length,
				detail: `${repo.totalPosts.toLocaleString()} repository posts ready`
			};

			const { threads } = buildThreadsFromFeed(repo.feedItems, profile.did, (nextProgress) => {
				progress = nextProgress;
			});

			allThreads = threads;
			chooseInitialDate(threads);
			chooseInitialHour(threads);
			repoStats = {
				totalPosts: repo.totalPosts,
				elapsedMs: repo.elapsedMs,
				downloadedBytes: repo.downloadedBytes,
				source: repo.source
			};
			stats = {
				postsScanned: repo.feedItems.length,
				chainStarts: threads.length,
				threadsWithSelfReplies: threads.filter((thread) => thread.depth >= 2).length
			};
			updateRouteState(profile.handle);
			success = true;
		} catch (e: any) {
			if (e?.name === 'AbortError') {
				error = null;
			} else if (e?.message?.includes('Unable to resolve handle') || e?.message?.includes('Profile not found')) {
				error = `Could not find handle "${cleaned}". Make sure it is a valid Bluesky handle.`;
			} else if (e?.message?.includes('fetch')) {
				error = 'Network error while downloading the repository.';
			} else {
				error = e?.message || 'An unexpected error occurred.';
			}
		} finally {
			loading = false;
			abortController = null;
		}

		return success;
	}

	function cancelFetch() {
		abortController?.abort();
	}

	function handleFontChange(key: string) {
		fontKey = key;
		try {
			localStorage.setItem('preferred-font', key);
		} catch {}
	}

	function handlePeriodInput(event: Event) {
		const target = event.target as HTMLInputElement;
		const nextPeriod: Period = target.value === '1' ? 'pm' : 'am';
		if (period === nextPeriod) return;
		period = nextPeriod;
		pageByHour = {};
		selectedPostUri = null;
		chooseInitialHour(allThreads);
		updateRouteState();
	}

	function handleDateInput(event: Event) {
		const target = event.target as HTMLInputElement;
		selectedDate = target.value;
		pageByHour = {};
		selectedPostUri = null;
		chooseInitialHour(allThreads);
		updateRouteState();
	}

	function clearDateFilter() {
		selectedDate = '';
		pageByHour = {};
		selectedPostUri = null;
		chooseInitialHour(allThreads);
		updateRouteState();
	}

	function jumpToNewestDate() {
		if (!newestDate) return;
		selectedDate = newestDate;
		pageByHour = {};
		selectedPostUri = null;
		chooseInitialHour(allThreads);
		updateRouteState();
	}

	onMount(async () => {
		try {
			const saved = localStorage.getItem('preferred-font');
			if (saved && saved in fontFamilies) fontKey = saved;
		} catch {}

		const params = new URLSearchParams(window.location.search);
		const dateParam = params.get('date');
		const periodParam = params.get('period');
		const handleParam = params.get('handle');
		if (dateParam && /^\d{4}-\d{2}-\d{2}$/.test(dateParam)) {
			selectedDate = dateParam;
		}
		if (periodParam === 'pm' || periodParam === 'am') {
			period = periodParam;
		}
		if (handleParam) {
			const cleaned = normalizeHandle(handleParam);
			initialHandle = cleaned;
			try {
				const profile = await getProfile(cleaned);
				await handleProfileSelected(profile);
				await handleSearch(profile.handle, { profile });
			} catch {
				error = `Could not load handle "${cleaned}".`;
			}
		}
	});
</script>

<svelte:head>
	<title>Clock - Bluesky Thread Viewer</title>
	<meta
		name="description"
		content="A clock-shaped Bluesky thread viewer that stacks repository posts and self-reply threads by hour."
	/>
</svelte:head>

<main class="clock-page" style="font-family: {fontFamily}">
	<header class="clock-header">
		<RouteNav
			current="clock"
			align="center"
			handle={selectedProfile?.handle || initialHandle}
		/>
		<div class="title-row">
			<div>
				<p class="eyebrow">Repo clock</p>
				<h1>Clock</h1>
				<p class="subtitle">Download a repo, build thread roots, and stack them onto a 12-hour face.</p>
			</div>
			<FontPicker value={fontKey} onchange={handleFontChange} />
		</div>
	</header>

	<section class="search-panel">
		<SearchBar
			onsearch={handleSearch}
			onprofile={handleProfileSelected}
			disabled={loading}
			{initialHandle}
			buttonLabel="Build clock"
		/>

		<div class="control-deck" aria-label="Clock filters">
			<div class="period-control">
				<div class="control-label-row">
					<label for="period-slider">Half day</label>
					<strong>{period.toUpperCase()}</strong>
				</div>
				<div class="period-slider-shell" style={`--period-step: ${period === 'pm' ? 1 : 0}`}>
					<span>AM</span>
					<input
						id="period-slider"
						type="range"
						min="0"
						max="1"
						step="1"
						value={period === 'pm' ? 1 : 0}
						oninput={handlePeriodInput}
						aria-label="Choose AM or PM"
					/>
					<span>PM</span>
				</div>
			</div>

			<div class="date-control">
				<div class="control-label-row">
					<label for="date-filter">Date</label>
					<strong>{formatSelectedDate(selectedDate)}</strong>
				</div>
				<div class="date-input-row">
					<input
						id="date-filter"
						type="date"
						value={selectedDate}
						min={oldestDate || undefined}
						max={newestDate || undefined}
						list="clock-date-options"
						onchange={handleDateInput}
					/>
					<datalist id="clock-date-options">
						{#each availableDates as entry (entry.value)}
							<option value={entry.value}>{formatSelectedDate(entry.value)} ({entry.count})</option>
						{/each}
					</datalist>
					<button type="button" class="mini-action" onclick={jumpToNewestDate} disabled={!newestDate}>
						Latest
					</button>
					<button type="button" class="mini-action" onclick={clearDateFilter} disabled={!selectedDate}>
						All
					</button>
				</div>
			</div>
		</div>
	</section>

	{#if error}
		<ErrorBanner message={error} />
	{/if}

	{#if loading}
		<section class="loading-panel">
			<LoadingSpinner {progress} />
			<button type="button" class="cancel-btn wobbly-border" onclick={cancelFetch}>Cancel</button>
		</section>
	{/if}

	{#if hasSearched && !loading}
		<section class="summary-strip" aria-label="Loaded repository summary">
			{#if author}
				<div class="author-card">
					{#if author.avatar}
						<img src={author.avatar} alt="" class="author-avatar" />
					{/if}
					<div>
						<strong>{author.displayName || author.handle}</strong>
						<span>@{author.handle}</span>
					</div>
				</div>
			{/if}
			<div class="summary-stat">
				<strong>{repoStats.totalPosts.toLocaleString()}</strong>
				<span>downloaded posts</span>
			</div>
			<div class="summary-stat">
				<strong>{stats.chainStarts.toLocaleString()}</strong>
				<span>thread roots</span>
			</div>
			<div class="summary-stat">
				<strong>{visibleThreadCount.toLocaleString()}</strong>
				<span>{period.toUpperCase()} shown</span>
			</div>
			<div class="summary-stat">
				<strong>{selectedDateCount.toLocaleString()}</strong>
				<span>{selectedDate ? 'on this date' : 'all dates'}</span>
			</div>
			{#if repoStats.downloadedBytes > 0}
				<div class="summary-stat wide">
					<strong>{formatBytes(repoStats.downloadedBytes)}</strong>
					<span>{formatDuration(repoStats.elapsedMs)}{#if repoStats.source} via {repoStats.source}{/if}</span>
				</div>
			{/if}
		</section>

		<section class="clock-section" aria-label="Thread clock">
			<div class="clock-topline">
				<div>
					<p class="eyebrow">Showing {formatSelectedDate(selectedDate)}</p>
					<h2>{period.toUpperCase()} clock</h2>
				</div>
				<p>
					{visibleThreadCount.toLocaleString()} thread root{visibleThreadCount !== 1 ? 's' : ''}
					/ {visiblePostCount.toLocaleString()} post{visiblePostCount !== 1 ? 's' : ''}
				</p>
				<div class="zoom-control" aria-label="Clock zoom">
					<button
						type="button"
						class="mini-action"
						onclick={() => adjustClockZoom(-CLOCK_ZOOM_STEP)}
						disabled={clockZoom <= MIN_CLOCK_ZOOM}
						aria-label="Zoom out"
					>
						&minus;
					</button>
					<span class="zoom-value">{Math.round(clockZoom * 100)}%</span>
					<button
						type="button"
						class="mini-action"
						onclick={() => adjustClockZoom(CLOCK_ZOOM_STEP)}
						disabled={clockZoom >= MAX_CLOCK_ZOOM}
						aria-label="Zoom in"
					>
						+
					</button>
				</div>
			</div>

			<div class="clock-scroll">
				<div
					class="clock-face"
					style={`--max-slot-count: ${Math.max(maxSlotCount, 1)}; zoom: ${clockZoom}`}
				>
					<div class="clock-ring one"></div>
					<div class="clock-ring two"></div>
					<div class="clock-pin"></div>

					<section class="clock-core" aria-live="polite">
						{#if selectedSlot && selectedThread && foregroundPostDetail}
							{@const selectedIndex = getPageIndex(selectedSlot.hour24, selectedSlot.threads.length)}
							{@const selectedUrl = buildThreadUrl(selectedThread)}
							<p class="core-kicker">
								{selectedSlot.rangeLabel} / page {selectedIndex + 1} of {selectedSlot.threads.length}
								/ post {foregroundPostDetail.index} of {selectedThreadDetails.length}
							</p>
							<h3>{formatPostTime(foregroundPostDetail.post)}</h3>
							<p class="core-text">{cleanText(foregroundPostDetail.post.text)}</p>
							<div class="core-meta">
								<span>{foregroundPostDetail.level === 0 ? 'root post' : `reply level ${foregroundPostDetail.level}`}</span>
								<span>@{foregroundPostDetail.post.author.handle}</span>
								<span>{foregroundPostDetail.post.replyCount} replies</span>
								<span>{foregroundPostDetail.post.likeCount} likes</span>
								<span>{foregroundPostDetail.post.repostCount} reposts</span>
								<span>{selectedThread.depth} deep</span>
								<span>{countThreadPosts(selectedThread.rootPost)} posts</span>
							</div>
							<div class="core-actions">
								<button
									type="button"
									class="page-btn"
									onclick={() => turnPage(selectedSlot, -1)}
									disabled={selectedSlot.threads.length < 2}
									aria-label="Previous thread page"
								>
									Prev
								</button>
								<button
									type="button"
									class="page-btn"
									onclick={() => turnPage(selectedSlot, 1)}
									disabled={selectedSlot.threads.length < 2}
									aria-label="Next thread page"
								>
									Next
								</button>
								{#if selectedUrl}
									<a class="open-link" href={selectedUrl} target="_blank" rel="noreferrer">Open</a>
								{/if}
							</div>
						{:else}
							<p class="core-kicker">No posts</p>
							<h3>{period.toUpperCase()}</h3>
							<p class="core-text">
								No thread roots match this date. Try clearing the date filter.
							</p>
						{/if}
					</section>

					{#each clockSlots as slot (slot.key)}
						{@const activeThread = getActiveThread(slot)}
						{@const pageIndex = getPageIndex(slot.hour24, slot.threads.length)}
						{@const activeUrl = buildThreadUrl(activeThread)}
						{@const activeDetails = activeThread ? threadDetails(activeThread.rootPost) : []}
						<article
							class="hour-stack"
							class:empty={slot.threads.length === 0}
							class:selected={selectedSlot?.hour24 === slot.hour24}
							style={slot.style}
						>
							<div class="digit-handle" aria-hidden="true">
								<span class="clock-number">{slot.label}</span>
							</div>

							<div class="slot-heading">
								<button class="slot-copy" type="button" onclick={() => selectHour(slot)}>
									<span class="slot-range">{slot.rangeLabel}</span>
									<span class="slot-count">
										{slot.threads.length} thread{slot.threads.length !== 1 ? 's' : ''}
									</span>
								</button>
							</div>

							{#if activeThread}
								<div class="stack-shadow shadow-one" aria-hidden="true"></div>
								<div class="stack-shadow shadow-two" aria-hidden="true"></div>
								<div class="post-page">
									<div class="post-page-top">
										<span>{formatThreadTime(activeThread)}</span>
										<span>{pageIndex + 1}/{slot.threads.length}</span>
									</div>
									<div class="thread-chain-preview" aria-label="Full self-reply thread">
										{#each activeDetails as detail (detail.post.uri)}
											<button
												type="button"
												class="chain-node"
												class:root-node={detail.level === 0}
												class:foreground-node={selectedThread?.rootUri === activeThread.rootUri &&
													foregroundPostDetail?.post.uri === detail.post.uri}
												style={`--chain-level: ${Math.min(detail.level, 8)}`}
												onclick={(event) => {
													event.stopPropagation();
													focusThreadPost(slot, pageIndex, detail.post.uri);
												}}
											>
												<span class="chain-dot" aria-hidden="true"></span>
												<span class="chain-node-meta">
													<span>#{detail.index}</span>
													<span>{formatPostTime(detail.post)}</span>
													<span>@{detail.post.author.handle}</span>
												</span>
												<span class="chain-text">{cleanText(detail.post.text)}</span>
												<span class="chain-node-stats" aria-label="Post engagement">
													<span>{detail.post.replyCount} replies</span>
													<span>{detail.post.likeCount} likes</span>
													<span>{detail.post.repostCount} reposts</span>
												</span>
											</button>
										{/each}
									</div>
									<div class="post-page-meta">
										<span>{activeThread.depth} deep</span>
										<span>{countThreadPosts(activeThread.rootPost)} posts</span>
									</div>
								</div>
								<div class="slot-actions">
									<button
										type="button"
										class="page-btn small"
										onclick={() => turnPage(slot, -1)}
										disabled={slot.threads.length < 2}
										aria-label={`Previous thread in ${slot.rangeLabel}`}
									>
										Prev
									</button>
									<button
										type="button"
										class="page-btn small"
										onclick={() => turnPage(slot, 1)}
										disabled={slot.threads.length < 2}
										aria-label={`Next thread in ${slot.rangeLabel}`}
									>
										Next
									</button>
									{#if activeUrl}
										<a class="open-link small" href={activeUrl} target="_blank" rel="noreferrer">Open</a>
									{/if}
								</div>
							{:else}
								<div class="empty-page">
									<span>No posts</span>
								</div>
							{/if}
						</article>
					{/each}
				</div>
			</div>
		</section>
	{:else if !loading}
		<section class="welcome-panel">
			<h2>Build a post clock from a Bluesky repo.</h2>
			<p>
				Search a handle, download the account repository, then flip each hour's stack like pages in a
				book.
			</p>
		</section>
	{/if}
</main>

<style>
	.clock-page {
		min-height: 100vh;
		padding: 24px max(16px, calc((100vw - 1520px) / 2)) 72px;
		background:
			radial-gradient(circle at 16% 14%, color-mix(in srgb, #d9f0f2 58%, transparent), transparent 30%),
			radial-gradient(circle at 84% 22%, color-mix(in srgb, #f7d4ba 52%, transparent), transparent 28%),
			linear-gradient(180deg, color-mix(in srgb, var(--bg-paper) 92%, #dce8f5), var(--bg-paper));
		color: var(--text-ink);
	}

	.clock-header {
		width: min(1280px, 100%);
		margin: 0 auto 18px;
	}

	.title-row {
		display: flex;
		align-items: end;
		justify-content: space-between;
		gap: 18px;
		margin-top: 18px;
	}

	.eyebrow {
		margin: 0 0 6px;
		color: var(--warm-text);
		font-size: 0.82rem;
		font-weight: 900;
		letter-spacing: 0;
		text-transform: uppercase;
	}

	h1,
	h2,
	h3,
	p {
		margin: 0;
	}

	h1 {
		font-size: clamp(3rem, 7vw, 6.8rem);
		line-height: 0.9;
		letter-spacing: 0;
	}

	.subtitle {
		max-width: 620px;
		margin-top: 10px;
		color: var(--muted);
		font-size: 1.02rem;
	}

	.search-panel,
	.summary-strip,
	.loading-panel,
	.welcome-panel {
		width: min(1280px, 100%);
		margin: 0 auto;
	}

	.search-panel {
		display: grid;
		gap: 18px;
		padding: 18px;
		border: 1px solid var(--control-border);
		border-radius: 8px;
		background: color-mix(in srgb, var(--card-bg) 86%, transparent);
		box-shadow: var(--shadow-soft);
		backdrop-filter: blur(8px);
	}

	.control-deck {
		display: grid;
		grid-template-columns: minmax(260px, 0.9fr) minmax(320px, 1.1fr);
		gap: 14px;
	}

	.period-control,
	.date-control {
		display: grid;
		gap: 10px;
		padding: 14px;
		border: 1px solid var(--control-border);
		border-radius: 8px;
		background: color-mix(in srgb, var(--muted-surface) 52%, var(--card-bg));
	}

	.control-label-row {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 10px;
	}

	.control-label-row label,
	.control-label-row strong {
		font-size: 0.92rem;
	}

	.control-label-row label {
		color: var(--muted);
		font-weight: 800;
	}

	.period-slider-shell,
	.date-input-row {
		display: flex;
		align-items: center;
		gap: 10px;
	}

	.period-slider-shell {
		position: relative;
		min-height: 44px;
		padding: 0 4px;
	}

	.period-slider-shell span {
		width: 34px;
		font-weight: 900;
		text-align: center;
		color: var(--muted);
	}

	.period-slider-shell input {
		flex: 1;
		accent-color: var(--accent);
	}

	.date-input-row {
		flex-wrap: wrap;
	}

	.date-input-row input {
		min-width: 180px;
		flex: 1;
		padding: 9px 10px;
		border: 1px solid var(--control-border);
		border-radius: 6px;
		background: var(--input-bg);
		color: var(--text-ink);
	}

	.mini-action,
	.cancel-btn,
	.page-btn,
	.open-link {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-height: 34px;
		padding: 7px 12px;
		border: 1px solid var(--control-border);
		border-radius: 6px;
		background: var(--control-bg);
		color: var(--text-ink);
		font-size: 0.86rem;
		font-weight: 900;
		line-height: 1;
		text-decoration: none;
	}

	.mini-action:hover:not(:disabled),
	.cancel-btn:hover,
	.page-btn:hover:not(:disabled),
	.open-link:hover {
		border-color: var(--accent);
		background: var(--control-bg-hover);
		text-decoration: none;
	}

	.mini-action:disabled,
	.page-btn:disabled {
		cursor: not-allowed;
		opacity: 0.45;
	}

	.loading-panel {
		display: grid;
		justify-items: center;
		gap: 12px;
		margin-top: 18px;
	}

	.summary-strip {
		display: grid;
		grid-template-columns: minmax(220px, 1.3fr) repeat(4, minmax(140px, 0.8fr)) minmax(160px, 0.9fr);
		gap: 10px;
		margin-top: 18px;
	}

	.author-card,
	.summary-stat {
		display: flex;
		align-items: center;
		gap: 10px;
		min-width: 0;
		padding: 12px;
		border: 1px solid var(--control-border);
		border-radius: 8px;
		background: color-mix(in srgb, var(--card-bg) 82%, transparent);
		box-shadow: var(--shadow-soft);
	}

	.author-avatar {
		width: 42px;
		height: 42px;
		border-radius: 50%;
		object-fit: cover;
	}

	.author-card div,
	.summary-stat {
		min-width: 0;
	}

	.author-card strong,
	.author-card span,
	.summary-stat strong,
	.summary-stat span {
		display: block;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.author-card span,
	.summary-stat span {
		color: var(--muted);
		font-size: 0.82rem;
	}

	.summary-stat {
		flex-direction: column;
		align-items: flex-start;
		justify-content: center;
	}

	.summary-stat strong {
		font-size: 1.15rem;
	}

	.clock-section {
		width: min(2100px, 100%);
		margin: 24px auto 0;
	}

	.clock-topline {
		display: flex;
		align-items: end;
		justify-content: space-between;
		gap: 18px;
		margin-bottom: 14px;
		padding: 0 8px;
	}

	.clock-topline h2 {
		font-size: clamp(2rem, 4vw, 4rem);
		line-height: 1;
	}

	.clock-topline > p {
		color: var(--muted);
		font-weight: 800;
		text-align: right;
	}

	.zoom-control {
		display: flex;
		align-items: center;
		gap: 6px;
		flex: 0 0 auto;
	}

	.zoom-value {
		min-width: 46px;
		color: var(--muted);
		font-size: 0.86rem;
		font-weight: 900;
		text-align: center;
	}

	.clock-scroll {
		overflow-x: auto;
		padding: 72px 0 110px;
	}

	.clock-face {
		position: relative;
		isolation: isolate;
		width: clamp(1520px, 126vw, 2100px);
		aspect-ratio: 1;
		margin: 0 auto;
		border: 3px solid color-mix(in srgb, var(--border-color) 72%, transparent);
		border-radius: 50%;
		background:
			linear-gradient(90deg, transparent 49.8%, color-mix(in srgb, var(--border-color) 14%, transparent) 50%, transparent 50.2%),
			linear-gradient(0deg, transparent 49.8%, color-mix(in srgb, var(--border-color) 14%, transparent) 50%, transparent 50.2%),
			radial-gradient(circle, color-mix(in srgb, var(--card-bg) 92%, #dce8f5) 0 41%, transparent 41.4%),
			radial-gradient(circle, color-mix(in srgb, var(--accent) 10%, transparent), transparent 64%),
			color-mix(in srgb, var(--card-bg) 88%, #d9f0f2);
		box-shadow:
			0 26px 72px rgba(26, 35, 44, 0.16),
			inset 0 0 0 14px color-mix(in srgb, var(--card-bg) 72%, transparent);
	}

	.clock-face::before,
	.clock-face::after {
		content: "";
		position: absolute;
		border-radius: 50%;
		pointer-events: none;
	}

	.clock-face::before {
		inset: 3.5%;
		z-index: 8;
		border: 5px double color-mix(in srgb, var(--border-color) 48%, transparent);
		box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--card-bg) 66%, transparent);
	}

	.clock-face::after {
		inset: 18.2%;
		z-index: 8;
		border: 2px solid color-mix(in srgb, var(--accent) 38%, transparent);
	}

	.clock-ring {
		position: absolute;
		z-index: 1;
		inset: 8.6%;
		border: 1px dashed color-mix(in srgb, var(--border-color) 28%, transparent);
		border-radius: 50%;
		pointer-events: none;
	}

	.clock-ring.two {
		inset: 28.8%;
		border-style: solid;
		border-color: color-mix(in srgb, var(--accent) 20%, transparent);
	}

	.clock-pin {
		position: absolute;
		z-index: 7;
		left: 50%;
		top: 50%;
		width: 28px;
		height: 28px;
		border: 3px solid var(--card-bg);
		border-radius: 50%;
		background: var(--accent);
		box-shadow: var(--shadow-soft);
		transform: translate(-50%, -50%);
		pointer-events: none;
	}

	.clock-core {
		position: absolute;
		left: 50%;
		top: 50%;
		z-index: 10;
		display: grid;
		gap: 10px;
		width: min(31%, 420px);
		min-height: 270px;
		max-height: 56%;
		padding: 20px;
		overflow-y: auto;
		overscroll-behavior: contain;
		border: 2px solid color-mix(in srgb, var(--border-color) 70%, transparent);
		border-radius: 8px;
		background: color-mix(in srgb, var(--card-bg) 91%, transparent);
		box-shadow: 12px 14px 0 color-mix(in srgb, #245e91 12%, transparent), var(--shadow-medium);
		transform: translate(-50%, -50%) rotate(-0.4deg);
	}

	.core-kicker {
		color: var(--warm-text);
		font-size: 0.78rem;
		font-weight: 900;
		text-transform: uppercase;
	}

	.clock-core h3 {
		font-size: clamp(2.1rem, 3.2vw, 3.6rem);
		line-height: 1;
	}

	.core-text {
		color: var(--text-ink);
		font-size: clamp(0.98rem, 1.35vw, 1.18rem);
		line-height: 1.35;
		overflow-wrap: anywhere;
	}

	.core-meta,
	.core-actions,
	.post-page-meta,
	.post-page-top,
	.slot-actions {
		display: flex;
		align-items: center;
		gap: 8px;
		flex-wrap: wrap;
	}

	.core-meta span,
	.post-page-meta span {
		padding: 3px 7px;
		border-radius: 6px;
		background: color-mix(in srgb, var(--accent-light) 42%, transparent);
		color: var(--text-ink);
		font-size: 0.76rem;
		font-weight: 900;
	}

	.hour-stack {
		position: absolute;
		left: var(--slot-x);
		top: var(--slot-y);
		z-index: 9;
		width: 340px;
		min-height: 420px;
		padding: 0;
		transform: translate(-50%, -50%);
	}

	.hour-stack.selected {
		z-index: 13;
	}

	.slot-heading {
		position: relative;
		z-index: 5;
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		align-items: center;
		gap: 8px;
		width: 100%;
		margin: 24px 0 10px;
		padding: 12px 14px 11px;
		border: 1px solid color-mix(in srgb, var(--border-color) 45%, transparent);
		border-radius: 8px;
		background: color-mix(in srgb, var(--card-bg) 82%, transparent);
		box-shadow: 0 13px 28px rgba(26, 35, 44, 0.14);
		color: var(--text-ink);
		text-align: left;
	}

	.hour-stack.selected .slot-heading {
		border-color: var(--accent);
		box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 18%, transparent), var(--shadow-soft);
	}

	.digit-handle {
		position: absolute;
		left: 50%;
		top: 58px;
		z-index: 0;
		display: grid;
		place-items: center;
		width: 76px;
		height: 76px;
		border: 2px solid color-mix(in srgb, var(--border-color) 38%, transparent);
		border-radius: 50%;
		background:
			radial-gradient(circle at 32% 28%, color-mix(in srgb, white 46%, transparent), transparent 30%),
			color-mix(in srgb, var(--accent-light) 46%, var(--card-bg));
		box-shadow:
			inset 0 0 0 5px color-mix(in srgb, var(--card-bg) 44%, transparent),
			0 10px 24px rgba(26, 35, 44, 0.12);
		color: color-mix(in srgb, var(--text-ink) 66%, transparent);
		opacity: 0.54;
		pointer-events: none;
		transform: translate(-50%, -50%);
	}

	.clock-number {
		font-size: 2.6rem;
		font-weight: 950;
		line-height: 0.88;
	}

	.slot-copy {
		display: grid;
		gap: 2px;
		min-width: 0;
		padding: 4px 0;
		border: 0;
		background: transparent;
		color: inherit;
		text-align: left;
	}

	.slot-copy:hover .slot-range,
	.slot-copy:focus-visible .slot-range {
		color: var(--accent);
	}

	.slot-range,
	.slot-count {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.slot-range {
		color: var(--muted);
		font-size: 0.86rem;
		font-weight: 800;
	}

	.slot-count {
		color: var(--warm-text);
		font-size: 0.8rem;
		font-weight: 900;
	}

	.stack-shadow,
	.post-page,
	.empty-page {
		border: 1px solid color-mix(in srgb, var(--border-color) 42%, transparent);
		border-radius: 8px;
	}

	.stack-shadow {
		position: absolute;
		left: 14px;
		right: 12px;
		top: 104px;
		height: 236px;
		background: color-mix(in srgb, #d9f0f2 65%, var(--card-bg));
		box-shadow: var(--shadow-soft);
		transform: rotate(3deg);
	}

	.shadow-two {
		left: 24px;
		right: 4px;
		top: 116px;
		background: color-mix(in srgb, #f7d4ba 62%, var(--card-bg));
		transform: rotate(-3deg);
	}

	.post-page {
		position: relative;
		z-index: 1;
		display: grid;
		gap: 12px;
		min-height: 252px;
		max-height: 620px;
		padding: 17px;
		overflow-y: auto;
		overscroll-behavior: contain;
		background: color-mix(in srgb, var(--card-bg) 95%, transparent);
		box-shadow: var(--shadow-soft);
		transform: rotate(-0.8deg);
	}

	.hour-stack:nth-of-type(2n) .post-page {
		transform: rotate(0.9deg);
	}

	.post-page-top {
		justify-content: space-between;
		color: var(--muted);
		font-size: 0.82rem;
		font-weight: 900;
	}

	.thread-chain-preview {
		position: relative;
		display: grid;
		gap: 10px;
		padding-left: 20px;
		padding-right: 6px;
	}

	.thread-chain-preview::before {
		content: "";
		position: absolute;
		left: 6px;
		top: 12px;
		bottom: 12px;
		width: 2px;
		border-radius: 999px;
		background: color-mix(in srgb, var(--accent) 42%, transparent);
	}

	.chain-node {
		position: relative;
		display: block;
		width: 100%;
		min-width: 0;
		margin-left: calc(var(--chain-level, 0) * 12px);
		padding: 8px 0 10px;
		border: 0;
		border-radius: 6px;
		background: transparent;
		color: inherit;
		font: inherit;
		text-align: left;
		cursor: pointer;
	}

	.chain-node:hover,
	.chain-node:focus-visible,
	.chain-node.foreground-node {
		background: color-mix(in srgb, var(--accent-light) 30%, transparent);
		outline: none;
	}

	.chain-node.foreground-node {
		box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 36%, transparent);
	}

	.chain-dot {
		position: absolute;
		left: -20px;
		top: 0.42em;
		width: 13px;
		height: 13px;
		border: 2px solid var(--card-bg);
		border-radius: 50%;
		background: color-mix(in srgb, #245e91 70%, var(--accent));
		box-shadow: 0 0 0 1px color-mix(in srgb, var(--border-color) 28%, transparent);
	}

	.chain-node.root-node .chain-dot {
		background: var(--accent);
	}

	.chain-node-meta,
	.chain-node-stats {
		display: flex;
		align-items: center;
		gap: 6px;
		flex-wrap: wrap;
		color: var(--muted);
		font-size: 0.74rem;
		font-weight: 900;
	}

	.chain-node-meta span,
	.chain-node-stats span {
		min-width: 0;
		overflow-wrap: anywhere;
	}

	.chain-node-stats {
		margin-top: 6px;
		color: var(--warm-text);
	}

	.chain-text {
		display: block;
		margin-top: 4px;
		font-size: 0.98rem;
		line-height: 1.34;
		overflow-wrap: anywhere;
	}

	.chain-node.root-node .chain-text {
		font-weight: 800;
	}

	.slot-actions {
		position: relative;
		z-index: 2;
		margin-top: 10px;
	}

	.page-btn.small,
	.open-link.small {
		min-height: 32px;
		padding: 7px 10px;
		font-size: 0.78rem;
	}

	.empty-page {
		display: grid;
		place-items: center;
		min-height: 220px;
		border-style: dashed;
		background: color-mix(in srgb, var(--card-bg) 58%, transparent);
		color: var(--muted);
		font-size: 0.86rem;
		font-weight: 900;
	}

	.hour-stack.empty {
		opacity: 0.72;
	}

	.hour-stack.empty .slot-heading {
		box-shadow: none;
	}

	.welcome-panel {
		display: grid;
		gap: 10px;
		margin-top: 30px;
		padding: 22px;
		border: 1px solid var(--control-border);
		border-radius: 8px;
		background: color-mix(in srgb, var(--card-bg) 82%, transparent);
		box-shadow: var(--shadow-soft);
	}

	.welcome-panel h2 {
		font-size: clamp(1.8rem, 4vw, 3rem);
		line-height: 1.05;
	}

	.welcome-panel p {
		max-width: 660px;
		color: var(--muted);
	}

	@media (max-width: 1180px) {
		.control-deck,
		.summary-strip {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}

		.author-card,
		.summary-stat.wide {
			grid-column: span 2;
		}
	}

	@media (max-width: 760px) {
		.clock-page {
			padding-inline: 12px;
		}

		.title-row,
		.clock-topline {
			align-items: flex-start;
			flex-direction: column;
		}

		.control-deck,
		.summary-strip {
			grid-template-columns: 1fr;
		}

		.author-card,
		.summary-stat.wide {
			grid-column: auto;
		}

		.clock-topline > p {
			text-align: left;
		}

		.clock-face {
			width: 1520px;
		}
	}
</style>
