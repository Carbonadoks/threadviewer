<script lang="ts">
	import { browser } from '$app/environment';
	import '../../app.css';
	import RouteNav from '$lib/components/RouteNav.svelte';
	import FontPicker from '$lib/components/FontPicker.svelte';
	import ThresholdControl from '$lib/components/ThresholdControl.svelte';
	import SearchOptions from '$lib/components/SearchOptions.svelte';
	import ModePicker from '$lib/components/ModePicker.svelte';
	import LoadingSpinner from '$lib/components/LoadingSpinner.svelte';
	import ErrorBanner from '$lib/components/ErrorBanner.svelte';
	import TwitterArchiveThreadCard from '$lib/components/twitterarchive/TwitterArchiveThreadCard.svelte';
	import TwitterArchiveXBlog from '$lib/components/twitterarchive/TwitterArchiveXBlog.svelte';
	import TwitterArchiveGallery from '$lib/components/twitterarchive/TwitterArchiveGallery.svelte';
	import {
		compareXArchiveThreads,
		collectXThreadPosts,
		isXPostInDateRange,
		parseXArchiveText,
		type XArchiveParseResult,
		type XArchiveThread,
		type XArchiveThreadSortMode,
		xArchiveThreadHasImages
	} from '$lib/api/x';
	import {
		buildFuzzyTextMatcher,
		fuzzyTextMatches,
		type FuzzyTextMatcher
	} from '$lib/utils/fuzzySearch';
	import type { DiscoverProgress } from '$lib/types';

	const fontFamilies: Record<string, string> = {
		virgil: "'Virgil', cursive",
		caveat: "'Caveat', cursive",
		patrick: "'Patrick Hand', cursive",
		'comic-neue': "'Comic Neue', cursive",
		inter: "'Inter', sans-serif",
		system: "system-ui, -apple-system, sans-serif"
	};

	const INITIAL_VISIBLE_LIMIT = 180;
	const LOAD_MORE_COUNT = 180;
	const GALLERY_GRID_ZOOM_MIN = 70;
	const GALLERY_GRID_ZOOM_MAX = 160;

	type RenderMode = 'default' | 'gallery';
	type GalleryContentMode = 'all' | 'images';
	type GalleryGroupMode = 'threads' | 'posts';
	type SearchMode = 'fuzzy' | 'literal';
	type SearchMatcherMode = 'none' | 'literal' | 'fuzzy' | 'regex';
	type ThreadSearchMatcher = {
		mode: SearchMatcherMode;
		literal: string | null;
		fuzzy: FuzzyTextMatcher | null;
		regex: RegExp | null;
		helperText: string | null;
		helperTone: 'info' | 'warning' | null;
	};

	let fontKey = $state('patrick');
	let fontFamily = $derived(fontFamilies[fontKey] ?? fontFamilies.patrick);

	let archive = $state<XArchiveParseResult | null>(null);
	let allThreads = $state<XArchiveThread[]>([]);
	let archiveFileName = $state('');
	let loading = $state(false);
	let error: string | null = $state(null);
	let progress: DiscoverProgress = $state({ phase: '', current: 0, total: 0 });
	let dragActive = $state(false);
	let renderMode = $state<RenderMode>('gallery');
	let galleryContentMode = $state<GalleryContentMode>('all');
	let galleryGroupMode = $state<GalleryGroupMode>('threads');
	let galleryGridZoom = $state(100);
	let threshold = $state(2);
	let threadSortMode = $state<XArchiveThreadSortMode>('length');
	let searchQuery = $state('');
	let searchMode = $state<SearchMode>('fuzzy');
	let dateFrom = $state('');
	let dateTo = $state('');
	let collapsedByRootUri: Record<string, boolean> = $state({});
	let visibleLimit = $state(INITIAL_VISIBLE_LIMIT);
	let xblogThread = $state<XArchiveThread | null>(null);
	let savedGalleryScrollY = $state(0);

	const author = $derived(archive?.author ?? null);
	const stats = $derived(archive?.stats ?? null);
	const maxDepth = $derived(allThreads.length > 0 ? Math.max(...allThreads.map((t) => t.depth)) : 2);
	const searchMatcher = $derived(buildSearchMatcher(searchQuery, searchMode));
	const sortedThreads = $derived.by(() => [...allThreads].sort(compareXArchiveThreads(threadSortMode)));
	const displayedThreads = $derived.by(() =>
		sortedThreads.filter(
			(thread) =>
				thread.depth >= threshold &&
				isXPostInDateRange(thread.rootPost, dateFrom, dateTo) &&
				threadMatchesSearch(thread, searchMatcher) &&
				(renderMode !== 'gallery' ||
					galleryContentMode === 'all' ||
					xArchiveThreadHasImages(thread))
		)
	);
	const visibleThreads = $derived(displayedThreads.slice(0, visibleLimit));
	const hasMoreThreads = $derived(visibleLimit < displayedThreads.length);
	const filterSignature = $derived(
		`${renderMode}|${galleryContentMode}|${galleryGroupMode}|${threadSortMode}|${threshold}|${searchQuery}|${searchMode}|${dateFrom}|${dateTo}|${allThreads.length}`
	);
	let lastFilterSignature = $state('');

	$effect(() => {
		if (filterSignature === lastFilterSignature) return;
		lastFilterSignature = filterSignature;
		visibleLimit = INITIAL_VISIBLE_LIMIT;
	});

	function formatBytes(bytes: number): string {
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
		return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	}

	function setThreadSortMode(mode: XArchiveThreadSortMode) {
		threadSortMode = mode;
	}

	function setSearchMode(mode: SearchMode) {
		searchMode = mode;
	}

	function handleModePickerChange(key: string) {
		if (key === 'default' || key === 'gallery') {
			renderMode = key;
		}
	}

	function setGalleryContentMode(mode: GalleryContentMode) {
		galleryContentMode = mode;
	}

	function setGalleryGroupMode(mode: GalleryGroupMode) {
		galleryGroupMode = mode;
	}

	function setGalleryGridZoom(value: string | number) {
		const numeric = Number(value);
		if (!Number.isFinite(numeric)) return;
		galleryGridZoom = Math.max(
			GALLERY_GRID_ZOOM_MIN,
			Math.min(GALLERY_GRID_ZOOM_MAX, Math.round(numeric))
		);
	}

	function setThreadCollapsed(rootUri: string, collapsed: boolean) {
		collapsedByRootUri = {
			...collapsedByRootUri,
			[rootUri]: collapsed
		};
	}

	function postSearchText(thread: XArchiveThread): string {
		return collectXThreadPosts(thread.rootPost)
			.map((post) => `${post.text}\n${post.linkedUrls.join('\n')}`)
			.join('\n\n');
	}

	function buildSearchMatcher(query: string, mode: SearchMode): ThreadSearchMatcher {
		const trimmed = query.trim();
		if (!trimmed) {
			return { mode: 'none', literal: null, fuzzy: null, regex: null, helperText: null, helperTone: null };
		}

		if (mode === 'literal') {
			return {
				mode: 'literal',
				literal: trimmed.toLowerCase(),
				fuzzy: null,
				regex: null,
				helperText: null,
				helperTone: null
			};
		}

		if (!trimmed.startsWith('/')) {
			return {
				mode: 'fuzzy',
				literal: trimmed.toLowerCase(),
				fuzzy: buildFuzzyTextMatcher(trimmed),
				regex: null,
				helperText: null,
				helperTone: null
			};
		}

		let closingSlash = -1;
		let escapeNext = false;
		for (let i = 1; i < trimmed.length; i += 1) {
			if (trimmed[i] === '\\' && !escapeNext) {
				escapeNext = true;
				continue;
			}
			if (trimmed[i] === '/' && !escapeNext) closingSlash = i;
			escapeNext = false;
		}

		if (closingSlash <= 0) {
			return {
				mode: 'fuzzy',
				literal: trimmed.toLowerCase(),
				fuzzy: buildFuzzyTextMatcher(trimmed),
				regex: null,
				helperText: null,
				helperTone: 'info'
			};
		}

		try {
			const pattern = trimmed.slice(1, closingSlash);
			const rawFlags = trimmed.slice(closingSlash + 1).toLowerCase();
			const flags = rawFlags.includes('i') ? rawFlags : `${rawFlags}i`;
			const regex = new RegExp(pattern, flags);
			return { mode: 'regex', literal: null, fuzzy: null, regex, helperText: null, helperTone: null };
		} catch {
			return {
				mode: 'fuzzy',
				literal: trimmed.toLowerCase(),
				fuzzy: buildFuzzyTextMatcher(trimmed),
				regex: null,
				helperText: 'Invalid regex, using fuzzy search.',
				helperTone: 'warning'
			};
		}
	}

	function threadMatchesSearch(thread: XArchiveThread, matcher: ThreadSearchMatcher): boolean {
		if (matcher.mode === 'none') return true;
		const haystack = postSearchText(thread);
		if (matcher.mode === 'regex' && matcher.regex) {
			matcher.regex.lastIndex = 0;
			return matcher.regex.test(haystack);
		}
		if (!matcher.literal) return true;
		const hasLiteralMatch = haystack.toLowerCase().includes(matcher.literal);
		if (matcher.mode === 'literal') return hasLiteralMatch;
		return hasLiteralMatch || Boolean(matcher.fuzzy && fuzzyTextMatches(haystack, matcher.fuzzy));
	}

	function findThread(rootUri: string): XArchiveThread | null {
		return allThreads.find((thread) => thread.rootUri === rootUri) ?? null;
	}

	function openXBlog(rootUri: string) {
		const thread = findThread(rootUri);
		if (!thread) return;
		if (browser) {
			savedGalleryScrollY = window.scrollY;
		}
		xblogThread = thread;
		if (browser) {
			requestAnimationFrame(() => {
				window.scrollTo({ top: 0, behavior: 'auto' });
			});
		}
	}

	function closeXBlog() {
		xblogThread = null;
		if (browser) {
			requestAnimationFrame(() => {
				window.scrollTo({ top: savedGalleryScrollY, behavior: 'auto' });
			});
		}
	}

	function openOnX(rootUri: string) {
		const thread = findThread(rootUri);
		if (!thread || !browser) return;
		window.open(thread.rootPost.sourceUrl, '_blank', 'noopener,noreferrer');
	}

	function resetArchiveState() {
		archive = null;
		allThreads = [];
		collapsedByRootUri = {};
		xblogThread = null;
		visibleLimit = INITIAL_VISIBLE_LIMIT;
	}

	async function loadArchiveFile(file: File) {
		loading = true;
		error = null;
		xblogThread = null;
		archiveFileName = file.name;
		progress = { phase: `Reading ${file.name}...`, current: 0, total: 1 };

		try {
			const contents = await file.text();
			progress = { phase: 'Parsing archive...', current: 0, total: 1, detail: formatBytes(contents.length) };
			const parsed = parseXArchiveText(contents, {
				onProgress(nextProgress) {
					progress = nextProgress;
				}
			});
			archive = parsed;
			allThreads = parsed.threads;
			threshold = parsed.stats.threadsWithSelfReplies > 0 ? 2 : 1;
			threadSortMode = 'length';
			collapsedByRootUri = {};
			visibleLimit = INITIAL_VISIBLE_LIMIT;
			progress = {
				phase: 'Archive ready',
				current: parsed.stats.postsScanned,
				total: parsed.stats.postsScanned
			};
		} catch (err) {
			resetArchiveState();
			error = err instanceof Error ? err.message : 'Could not parse this Twitter archive JSON.';
		} finally {
			loading = false;
			dragActive = false;
		}
	}

	function handleFileInput(event: Event) {
		const input = event.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		if (file) void loadArchiveFile(file);
		input.value = '';
	}

	function handleDragEnter(event: DragEvent) {
		event.preventDefault();
		dragActive = true;
	}

	function handleDragOver(event: DragEvent) {
		event.preventDefault();
		dragActive = true;
	}

	function handleDragLeave(event: DragEvent) {
		const current = event.currentTarget as HTMLElement;
		const related = event.relatedTarget as Node | null;
		if (related && current.contains(related)) return;
		dragActive = false;
	}

	function handleDrop(event: DragEvent) {
		event.preventDefault();
		dragActive = false;
		const file = event.dataTransfer?.files?.[0];
		if (file) void loadArchiveFile(file);
	}

	function handleFontChange(key: string) {
		fontKey = key;
	}

	function loadMoreThreads() {
		visibleLimit = Math.min(displayedThreads.length, visibleLimit + LOAD_MORE_COUNT);
	}
</script>

<main
	style="font-family: {fontFamily}"
	class:xblog-main={xblogThread}
	class:gallery-main={renderMode === 'gallery' && !xblogThread}
>
	{#if xblogThread}
		<section class="xblog-shell" aria-label="XBlog view">
			<div class="xblog-toolbar">
				<button class="xblog-back-btn wobbly-border" onclick={closeXBlog}>
					&#8592; Back to archive
				</button>
			</div>
			<TwitterArchiveXBlog thread={xblogThread} />
		</section>
	{/if}

	<div class="archive-chrome" class:archive-chrome--parked={xblogThread} aria-hidden={xblogThread ? 'true' : undefined}>
		<header>
			<RouteNav current="twitterarchiveviewer" align="center" />
			<h1>Twitter Archive Viewer</h1>
			<FontPicker value={fontKey} onchange={handleFontChange} />
		</header>

		<div
			class="drop-section wobbly-border-light"
			class:drag-active={dragActive}
			role="region"
			aria-label="Twitter archive file drop zone"
			ondragenter={handleDragEnter}
			ondragover={handleDragOver}
			ondragleave={handleDragLeave}
			ondrop={handleDrop}
		>
			<input
				id="archive-file"
				type="file"
				accept=".json,application/json,text/javascript,.js"
				onchange={handleFileInput}
			/>
			<label for="archive-file">
				<strong>{archiveFileName || 'Drop a Twitter archive JSON here'}</strong>
				<span>
					{#if archiveFileName && stats}
						Loaded {stats.postsScanned.toLocaleString()} posts from {archiveFileName}
					{:else}
						Drag a combined archive JSON, or choose one from disk.
					{/if}
				</span>
			</label>
		</div>

		<section class="archive-explainer wobbly-border-light" aria-label="How to get an archive JSON">
			<strong>Need an archive JSON?</strong>
			<span>
				Use
				<a href="https://www.community-archive.org/" target="_blank" rel="noreferrer">
					Community Archive
				</a>
				to find an account and choose “Download Raw Archive”, or use your own X/Twitter archive export
				JSON and drop it here.
			</span>
		</section>

		{#if error}
			<ErrorBanner message={error} />
		{/if}
	</div>

	<div class="results-layer" class:results-layer--parked={xblogThread} aria-hidden={xblogThread ? 'true' : undefined}>
		{#if loading}
			<LoadingSpinner {progress} />
		{/if}

		{#if archive && !loading}
			<section class="results-section">
				<div class="results-header">
					{#if author}
						<div class="author-info">
							{#if author.avatar}
								<img src={author.avatar} alt="" class="author-avatar" />
							{/if}
							<span>
								{author.displayName || author.handle}
								<span class="author-handle">@{author.handle}</span>
							</span>
						</div>
					{/if}

					{#if stats}
						<div class="stats-bar">
							<span>{stats.postsScanned.toLocaleString()} posts scanned</span>
							<span class="stats-sep">/</span>
							<span>{stats.retweetsSkipped.toLocaleString()} retweets skipped</span>
							<span class="stats-sep">/</span>
							<span>{stats.threadsWithSelfReplies.toLocaleString()} self-reply chains</span>
							<span class="stats-sep">/</span>
							<span>max depth {stats.maxDepth.toLocaleString()}</span>
							<span class="stats-sep">/</span>
							<span>{stats.totalCharacters.toLocaleString()} countable chars</span>
						</div>
						{#if stats.notesSeen > 0}
							<div class="stats-bar">
								<span>{stats.notesMatched.toLocaleString()} note-tweet texts restored</span>
								{#if stats.notesUnmatched > 0}
									<span class="stats-sep">/</span>
									<span>{stats.notesUnmatched.toLocaleString()} unmatched notes</span>
								{/if}
							</div>
						{/if}
					{/if}

					{#if archive.warnings.length > 0}
						<div class="warning-list">
							{#each archive.warnings as warning}
								<p>{warning}</p>
							{/each}
						</div>
					{/if}

					{#if allThreads.length > 0}
						<ThresholdControl bind:value={threshold} min={1} max={Math.max(maxDepth, 2)} />
						<ModePicker value={renderMode} onchange={handleModePickerChange} />

						<div class="thread-sort-row wobbly-border-light">
							<span>Sort</span>
							<div class="thread-sort-toggle" aria-label="Thread sort mode">
								<button
									type="button"
									class:active={threadSortMode === 'length'}
									onclick={() => setThreadSortMode('length')}
								>
									Longest text
								</button>
								<button
									type="button"
									class:active={threadSortMode === 'depth'}
									onclick={() => setThreadSortMode('depth')}
								>
									Highest chain
								</button>
								<button
									type="button"
									class:active={threadSortMode === 'newest'}
									onclick={() => setThreadSortMode('newest')}
								>
									Newest
								</button>
								<button
									type="button"
									class:active={threadSortMode === 'oldest'}
									onclick={() => setThreadSortMode('oldest')}
								>
									Oldest
								</button>
								<button
									type="button"
									class:active={threadSortMode === 'liked'}
									onclick={() => setThreadSortMode('liked')}
								>
									Liked
								</button>
								<button
									type="button"
									class:active={threadSortMode === 'reposted'}
									onclick={() => setThreadSortMode('reposted')}
								>
									Reposted
								</button>
							</div>
						</div>

						{#if renderMode === 'gallery'}
							<div class="gallery-content-row wobbly-border-light">
								<span>Gallery</span>
								<div class="gallery-content-toggle" aria-label="Gallery content mode">
									<button
										type="button"
										class:active={galleryContentMode === 'all'}
										onclick={() => setGalleryContentMode('all')}
									>
										All
									</button>
									<button
										type="button"
										class:active={galleryContentMode === 'images'}
										onclick={() => setGalleryContentMode('images')}
									>
										Images
									</button>
								</div>
							</div>

							<div class="gallery-view-row wobbly-border-light">
								<span>View</span>
								<div class="gallery-view-toggle" aria-label="Gallery grouping mode">
									<button
										type="button"
										class:active={galleryGroupMode === 'threads'}
										onclick={() => setGalleryGroupMode('threads')}
									>
										Threads
									</button>
									<button
										type="button"
										class:active={galleryGroupMode === 'posts'}
										onclick={() => setGalleryGroupMode('posts')}
									>
										Posts
									</button>
								</div>
								<label class="gallery-grid-zoom">
									<span>Grid</span>
									<input
										type="range"
										min={GALLERY_GRID_ZOOM_MIN}
										max={GALLERY_GRID_ZOOM_MAX}
										step="5"
										value={galleryGridZoom}
										oninput={(event) => setGalleryGridZoom(event.currentTarget.value)}
										aria-label="Gallery grid zoom"
									/>
									<span>{galleryGridZoom}%</span>
								</label>
							</div>
						{/if}

						<div class="search-filter wobbly-border-light">
							<label for="archive-thread-search">Search</label>
							<input
								id="archive-thread-search"
								type="text"
								placeholder={searchMode === 'literal' ? 'Exact archive text...' : 'Fuzzy text or /pattern/flags...'}
								bind:value={searchQuery}
							/>
							<div class="search-mode-toggle" aria-label="Search mode">
								<button
									type="button"
									class:active={searchMode === 'fuzzy'}
									onclick={() => setSearchMode('fuzzy')}
								>
									Fuzzy
								</button>
								<button
									type="button"
									class:active={searchMode === 'literal'}
									onclick={() => setSearchMode('literal')}
								>
									Literal
								</button>
							</div>
							{#if searchMatcher.helperText}
								<p class="search-helper" class:warning={searchMatcher.helperTone === 'warning'}>
									{searchMatcher.helperText}
								</p>
							{/if}
						</div>

						<div class="date-filter-row">
							<SearchOptions bind:dateFrom bind:dateTo />
						</div>

						<p class="results-count">
							Showing {visibleThreads.length.toLocaleString()} of {displayedThreads.length.toLocaleString()}
							thread{displayedThreads.length === 1 ? '' : 's'} with depth {threshold}+
						</p>
						<p class="length-note">
							Length sort counts text after removing links and quote-post URLs; self-reply chains are counted as one long post.
						</p>
					{/if}
				</div>

				{#if visibleThreads.length > 0}
					{#if renderMode === 'gallery'}
						<TwitterArchiveGallery
							threads={visibleThreads}
							contentMode={galleryContentMode}
							groupMode={galleryGroupMode}
							gridZoom={galleryGridZoom}
							{searchQuery}
							{searchMode}
							onblog={openXBlog}
							onopenx={openOnX}
						/>
					{:else}
						<div class="threads-list">
							{#each visibleThreads as thread (thread.rootUri)}
								<TwitterArchiveThreadCard
									{thread}
									collapsed={collapsedByRootUri[thread.rootUri] ?? true}
									oncollapsedchange={(collapsed) => setThreadCollapsed(thread.rootUri, collapsed)}
									onblog={openXBlog}
									onopenx={openOnX}
								/>
							{/each}
						</div>
					{/if}

					{#if hasMoreThreads}
						<div class="load-more-row">
							<button type="button" class="load-more-btn wobbly-border" onclick={loadMoreThreads}>
								Load {Math.min(LOAD_MORE_COUNT, displayedThreads.length - visibleLimit).toLocaleString()} more
							</button>
						</div>
					{/if}
				{:else}
					<div class="empty-state">
						<p>No threads match the current filters.</p>
						<p class="empty-hint">Try lowering the minimum depth or adjusting the date range.</p>
					</div>
				{/if}
			</section>
		{/if}

		{#if !loading && !archive}
			<section class="welcome">
				<p>Drop a Twitter/X archive JSON to find long self-reply chains and the longest posts.</p>
				<p class="hint">The file stays in your browser; the viewer normalizes the archive locally.</p>
			</section>
		{/if}
	</div>
</main>

<style>
	main {
		max-width: 800px;
		margin: 0 auto;
		padding: 32px 20px;
	}

	main.xblog-main {
		max-width: none;
		padding: 24px 20px 80px;
	}

	main.gallery-main {
		max-width: 1280px;
	}

	.archive-chrome--parked,
	.results-layer--parked {
		display: none;
	}

	header {
		margin-bottom: 28px;
		text-align: center;
	}

	h1 {
		margin: 0 0 4px;
		color: var(--text-ink);
		font-size: 2.2rem;
	}

	.drop-section {
		position: relative;
		display: grid;
		place-items: center;
		min-height: 160px;
		margin: 0 auto 28px;
		padding: 24px;
		background:
			linear-gradient(135deg, color-mix(in srgb, var(--accent) 9%, transparent), transparent 42%),
			var(--card-bg);
		color: var(--text-ink);
		text-align: center;
		transition:
			transform 0.16s ease,
			border-color 0.16s ease,
			background 0.16s ease;
	}

	.drop-section.drag-active {
		transform: rotate(-0.35deg) scale(1.01);
		border-color: var(--accent);
		background:
			linear-gradient(135deg, color-mix(in srgb, var(--accent) 16%, transparent), transparent 48%),
			var(--card-bg);
	}

	.drop-section input {
		position: absolute;
		width: 1px;
		height: 1px;
		opacity: 0;
		pointer-events: none;
	}

	.drop-section label {
		display: grid;
		gap: 8px;
		cursor: pointer;
	}

	.drop-section strong {
		font-size: 1.2rem;
	}

	.drop-section span {
		color: var(--muted);
		font-size: 0.95rem;
	}

	.archive-explainer {
		display: flex;
		align-items: center;
		justify-content: center;
		flex-wrap: wrap;
		gap: 8px;
		width: min(100%, 680px);
		margin: -12px auto 26px;
		padding: 10px 16px;
		background: color-mix(in srgb, var(--card-bg) 88%, transparent);
		color: var(--muted);
		font-family: Inter, system-ui, sans-serif;
		font-size: 0.9rem;
		line-height: 1.45;
		text-align: center;
	}

	.archive-explainer strong {
		color: var(--text-ink);
		font-weight: 700;
	}

	.archive-explainer a {
		color: var(--accent);
		font-weight: 700;
		text-decoration-thickness: 1.5px;
		text-underline-offset: 3px;
	}

	.results-section {
		margin-top: 24px;
	}

	.results-header {
		margin-bottom: 24px;
		text-align: center;
	}

	.author-info {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 12px;
		margin-bottom: 16px;
		font-size: 1.2rem;
	}

	.author-avatar {
		width: 40px;
		height: 40px;
		border-radius: 50%;
		object-fit: cover;
	}

	.author-handle {
		color: var(--muted);
		font-size: 0.95rem;
	}

	.stats-bar {
		display: flex;
		justify-content: center;
		gap: 6px;
		flex-wrap: wrap;
		margin-bottom: 10px;
		color: var(--muted);
		font-size: 0.85rem;
	}

	.stats-sep {
		opacity: 0.4;
	}

	.warning-list {
		width: min(100%, 620px);
		margin: 10px auto 14px;
		color: #856404;
		font-family: Inter, system-ui, sans-serif;
		font-size: 0.84rem;
	}

	.warning-list p {
		margin: 4px 0;
	}

	.thread-sort-row,
	.gallery-content-row,
	.gallery-view-row {
		display: flex;
		align-items: center;
		justify-content: center;
		flex-wrap: wrap;
		gap: 10px;
		width: fit-content;
		margin: 8px auto 0;
		padding: 5px 8px;
		color: var(--muted);
		font-size: 0.86rem;
	}

	.thread-sort-toggle,
	.gallery-content-toggle,
	.gallery-view-toggle {
		display: inline-flex;
		flex-wrap: wrap;
		border: 1.5px solid var(--control-border);
		border-radius: 8px;
		overflow: hidden;
		background: color-mix(in srgb, var(--card-bg) 88%, white 12%);
	}

	.thread-sort-toggle button,
	.gallery-content-toggle button,
	.gallery-view-toggle button {
		padding: 5px 9px;
		border: 0;
		border-right: 1px solid var(--control-border);
		background: transparent;
		color: var(--muted);
		font-family: inherit;
		font-size: 0.78rem;
		cursor: pointer;
	}

	.thread-sort-toggle button:last-child,
	.gallery-content-toggle button:last-child,
	.gallery-view-toggle button:last-child {
		border-right: 0;
	}

	.thread-sort-toggle button.active,
	.gallery-content-toggle button.active,
	.gallery-view-toggle button.active {
		background: var(--accent);
		color: white;
	}

	.thread-sort-toggle button:hover:not(.active),
	.gallery-content-toggle button:hover:not(.active),
	.gallery-view-toggle button:hover:not(.active) {
		color: var(--accent);
	}

	.gallery-grid-zoom {
		display: inline-flex;
		align-items: center;
		gap: 7px;
		margin-left: 2px;
		color: var(--muted);
		font-size: 0.82rem;
	}

	.gallery-grid-zoom input {
		width: clamp(120px, 18vw, 210px);
		accent-color: var(--accent);
		cursor: pointer;
	}

	.search-filter {
		max-width: 680px;
		margin: 12px auto 0;
		padding: 12px 20px;
		background: var(--card-bg);
		display: flex;
		align-items: center;
		justify-content: center;
		flex-wrap: wrap;
		gap: 12px;
	}

	.search-filter label {
		color: var(--muted);
		font-size: 0.95rem;
		white-space: nowrap;
	}

	.search-filter input[type='text'] {
		flex: 1;
		min-width: 180px;
		padding: 6px 10px;
		border: 1.5px solid var(--muted);
		border-radius: 6px;
		background: var(--card-bg);
		color: var(--text-ink);
		font-family: inherit;
		font-size: 0.95rem;
	}

	.search-filter input[type='text']::placeholder {
		color: var(--muted);
		opacity: 0.7;
	}

	.search-mode-toggle {
		display: inline-flex;
		flex: 0 0 auto;
		border: 1.5px solid var(--control-border);
		border-radius: 8px;
		overflow: hidden;
		background: color-mix(in srgb, var(--card-bg) 88%, white 12%);
	}

	.search-mode-toggle button {
		padding: 5px 9px;
		border: 0;
		border-right: 1px solid var(--control-border);
		background: transparent;
		color: var(--muted);
		font-family: inherit;
		font-size: 0.78rem;
		cursor: pointer;
	}

	.search-mode-toggle button:last-child {
		border-right: 0;
	}

	.search-mode-toggle button.active {
		background: var(--accent);
		color: white;
	}

	.search-mode-toggle button:hover:not(.active) {
		color: var(--accent);
	}

	.search-helper {
		width: 100%;
		margin: -3px 0 0;
		color: var(--muted);
		font-family: Inter, system-ui, sans-serif;
		font-size: 0.82rem;
		line-height: 1.3;
	}

	.search-helper.warning {
		color: var(--accent);
	}

	.date-filter-row {
		max-width: 600px;
		margin: 8px auto 0;
		text-align: center;
	}

	.results-count {
		margin: 14px 0 0;
		color: var(--muted);
	}

	.length-note {
		max-width: 620px;
		margin: 6px auto 0;
		color: var(--muted);
		font-family: Inter, system-ui, sans-serif;
		font-size: 0.82rem;
		line-height: 1.35;
	}

	.threads-list {
		margin-top: 16px;
	}

	.load-more-row {
		display: flex;
		justify-content: center;
		margin: 26px 0 8px;
	}

	.load-more-btn {
		padding: 7px 16px;
		background: var(--card-bg);
		color: var(--text-ink);
		border-color: var(--muted);
		font-family: inherit;
		cursor: pointer;
	}

	.load-more-btn:hover {
		color: var(--accent);
		border-color: var(--accent);
	}

	.empty-state,
	.welcome {
		margin-top: 42px;
		padding: 24px;
		color: var(--muted);
		text-align: center;
	}

	.empty-state p,
	.welcome p {
		margin: 0 0 8px;
	}

	.hint,
	.empty-hint {
		font-size: 0.9rem;
		opacity: 0.8;
	}

	.xblog-shell {
		width: min(100%, 980px);
		min-height: calc(100vh - 104px);
		margin: 0 auto;
	}

	.xblog-toolbar {
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

	.xblog-back-btn {
		display: inline-flex;
		align-items: center;
		width: fit-content;
		margin: 0;
		padding: 6px 14px;
		background: color-mix(in srgb, var(--card-bg) 86%, transparent);
		color: var(--muted);
		border-color: var(--control-border);
		font-size: 0.86rem;
		backdrop-filter: blur(8px);
	}

	.xblog-back-btn:hover {
		color: var(--accent);
		border-color: var(--accent);
	}
</style>
