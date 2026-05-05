<script lang="ts">
	import { browser } from '$app/environment';
	import { onMount, tick } from 'svelte';
	import '../../app.css';
	import SearchBar from '$lib/components/SearchBar.svelte';
	import LoadingSpinner from '$lib/components/LoadingSpinner.svelte';
	import ErrorBanner from '$lib/components/ErrorBanner.svelte';
	import RouteNav from '$lib/components/RouteNav.svelte';
	import FontPicker from '$lib/components/FontPicker.svelte';
	import { getProfile, type ProfileInfo } from '$lib/api/bluesky';
	import { downloadRepoCar, type RepoDownloadProgress } from '$lib/utils/repoHydration';
	import { parseCarPostsWasm } from '$lib/utils/carParserWasm';
	import type { DiscoverProgress } from '$lib/types';

	const STOPWORDS = new Set([
		'the', 'and', 'that', 'this', 'with', 'from', 'they', 'them', 'then',
		'there', 'their', 'about', 'into', 'because', 'after', 'before', 'while',
		'where', 'when', 'what', 'which', 'just', 'than', 'have', 'has', 'will',
		'would', 'could', 'should', 'been', 'being', 'were', 'was', 'are', 'you',
		'your', 'its', 'our', 'out', 'for', 'not', 'but', 'too', 'can', 'cant',
		'dont', 'does', 'did', 'why', 'how', 'who', 'all', 'any', 'more', 'most',
		'some', 'like', 'also', 'very', 'much', 'really', 'still', 'even', 'well',
		'way', 'get', 'got', 'going', 'goes', 'gone', 'come', 'came', 'make',
		'made', 'know', 'knew', 'think', 'thought', 'see', 'saw', 'want', 'take',
		'took', 'tell', 'told', 'said', 'say', 'let', 'thing', 'things', 'something',
		'someone', 'every', 'each', 'other', 'another', 'such', 'only', 'own',
		'same', 'over', 'now', 'here', 'back', 'time', 'good', 'new', 'first',
		'last', 'long', 'great', 'little', 'right', 'high', 'old', 'big',
		'need', 'one', 'two', 'yes', 'had', 'his', 'her', 'she', 'him',
		'may', 'use', 'many', 'those', 'these', 'through', 'between',
		'down', 'been', 'part', 'upon', 'keep', 'kept', 'put', 'give', 'gave',
		'look', 'looked', 'feel', 'felt', 'seem', 'seemed', 'lot', 'actually',
		'gonna', 'though', 'always', 'never', 'already', 'sure', 'yeah',
		'okay', 'maybe', 'probably', 'pretty', 'quite', 'isn', 'doesn', 'didn',
		'won', 'wouldn', 'couldn', 'shouldn', 'haven', 'hasn', 'aren', 'weren',
		'bsky', 'social', 'app', 'profile', 'post', 'posts', 'thread', 'threads',
		'reply', 'replies', 'bluesky', 'atproto'
	]);

	interface WordEntry {
		word: string;
		count: number;
		rank: number;
		percentage: number;
	}

	interface PlacedWord {
		entry: WordEntry;
		x: number;
		y: number;
		width: number;
		height: number;
		fontSize: number;
		rotated: boolean;
	}

	let initialHandle = $state('');
	let profile = $state<ProfileInfo | null>(null);
	let loading = $state(false);
	let error = $state<string | null>(null);
	let progress = $state<DiscoverProgress>({ phase: '', current: 0, total: 0 });
	let words = $state<WordEntry[]>([]);
	let totalWords = $state(0);
	let totalPosts = $state(0);
	let uniqueWords = $state(0);
	let loadController: AbortController | null = null;
	let loadToken = 0;
	let sortBy = $state<'count' | 'alpha'>('count');
	let maxDisplay = $state(200);
	let hoveredWord = $state<WordEntry | null>(null);
	let selectedWord = $state<WordEntry | null>(null);
	let mouseX = $state(0);
	let mouseY = $state(0);

	let canvasEl: HTMLCanvasElement | undefined = $state();
	let canvasWrapper: HTMLDivElement | undefined = $state();
	let placedWords: PlacedWord[] = [];
	let cloudRendered = $state(false);

	const fontFamilies: Record<string, string> = {
		virgil: "'Virgil', cursive",
		caveat: "'Caveat', cursive",
		patrick: "'Patrick Hand', cursive",
		'comic-neue': "'Comic Neue', cursive",
		inter: "'Inter', sans-serif",
		system: 'system-ui, -apple-system, sans-serif'
	};

	let fontKey = $state('virgil');
	let cloudFont = $derived(fontFamilies[fontKey] ?? fontFamilies.virgil);
	const MIN_FONT = 12;
	const MAX_FONT = 80;
	const PADDING = 3;

	const sortedWords = $derived.by(() => {
		const slice = words.slice(0, maxDisplay);
		if (sortBy === 'alpha') return [...slice].sort((a, b) => a.word.localeCompare(b.word));
		return slice;
	});

	function tokenize(text: string): string[] {
		const lower = text.toLowerCase();
		const urls: string[] = [];
		const withoutUrls = lower.replace(/https?:\/\/\S+/g, (match) => {
			const clean = match.replace(/[).,;:!?"']+$/, '');
			urls.push(clean);
			return ' ';
		});
		const w = withoutUrls
			.replace(/['']/g, "'")
			.match(/[a-z][a-z0-9'-]{2,}/g)
			?.filter((t) => !STOPWORDS.has(t) && t.length <= 30) ?? [];
		return [...urls, ...w];
	}

	function computeWordFrequencies(posts: { record: any }[]): {
		entries: WordEntry[];
		totalTokens: number;
		postCount: number;
		uniqueCount: number;
	} {
		const counts = new Map<string, number>();
		let totalTokens = 0;

		for (const post of posts) {
			const text = post.record?.text;
			if (typeof text !== 'string') continue;
			const tokens = tokenize(text);
			totalTokens += tokens.length;
			for (const token of tokens) {
				counts.set(token, (counts.get(token) ?? 0) + 1);
			}
		}

		const sorted = [...counts.entries()]
			.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

		const entries = sorted.map(([word, count], i) => ({
			word,
			count,
			rank: i + 1,
			percentage: totalTokens > 0 ? (count / totalTokens) * 100 : 0
		}));

		return { entries, totalTokens, postCount: posts.length, uniqueCount: counts.size };
	}

	function formatBytes(bytes: number): string {
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
		return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	}

	function formatSpeed(bps: number): string {
		if (bps < 1024) return `${bps.toFixed(0)} B/s`;
		if (bps < 1024 * 1024) return `${(bps / 1024).toFixed(0)} KB/s`;
		return `${(bps / (1024 * 1024)).toFixed(1)} MB/s`;
	}

	function handleWordClick(w: WordEntry) {
		selectedWord = selectedWord?.word === w.word ? null : w;
	}

	// --- Canvas word cloud layout ---

	function buildCloud(slice: WordEntry[]) {
		if (!canvasEl || !canvasWrapper || slice.length === 0) return;
		const dpr = window.devicePixelRatio || 1;
		const wrapperW = canvasWrapper.clientWidth;
		const canvasW = wrapperW;
		const canvasH = Math.max(400, Math.round(canvasW * 0.6));

		canvasEl.width = canvasW * dpr;
		canvasEl.height = canvasH * dpr;
		canvasEl.style.width = `${canvasW}px`;
		canvasEl.style.height = `${canvasH}px`;

		const ctx = canvasEl.getContext('2d')!;
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

		const maxCount = slice[0].count;
		const minCount = slice[slice.length - 1].count;
		const range = Math.max(1, maxCount - minCount);

		// Occupancy grid for collision detection (4px cells)
		const CELL = 4;
		const gridW = Math.ceil(canvasW / CELL);
		const gridH = Math.ceil(canvasH / CELL);
		const grid = new Uint8Array(gridW * gridH);

		function isOccupied(x: number, y: number, w: number, h: number): boolean {
			const x0 = Math.floor(x / CELL);
			const y0 = Math.floor(y / CELL);
			const x1 = Math.ceil((x + w) / CELL);
			const y1 = Math.ceil((y + h) / CELL);
			if (x0 < 0 || y0 < 0 || x1 > gridW || y1 > gridH) return true;
			for (let gy = y0; gy < y1; gy++) {
				for (let gx = x0; gx < x1; gx++) {
					if (grid[gy * gridW + gx]) return true;
				}
			}
			return false;
		}

		function occupy(x: number, y: number, w: number, h: number) {
			const x0 = Math.max(0, Math.floor(x / CELL));
			const y0 = Math.max(0, Math.floor(y / CELL));
			const x1 = Math.min(gridW, Math.ceil((x + w) / CELL));
			const y1 = Math.min(gridH, Math.ceil((y + h) / CELL));
			for (let gy = y0; gy < y1; gy++) {
				for (let gx = x0; gx < x1; gx++) {
					grid[gy * gridW + gx] = 1;
				}
			}
		}

		const cx = canvasW / 2;
		const cy = canvasH / 2;
		const placed: PlacedWord[] = [];

		ctx.clearRect(0, 0, canvasW, canvasH);
		ctx.textBaseline = 'top';

		for (let i = 0; i < slice.length; i++) {
			const entry = slice[i];
			const t = (entry.count - minCount) / range;
			const fontSize = Math.round(MIN_FONT + t * (MAX_FONT - MIN_FONT));
			const rotated = i > 0 && i % 5 === 0;

			ctx.font = `${fontSize}px ${cloudFont}`;
			const metrics = ctx.measureText(entry.word);
			const textW = metrics.width;
			const textH = fontSize * 1.15;

			const boxW = (rotated ? textH : textW) + PADDING * 2;
			const boxH = (rotated ? textW : textH) + PADDING * 2;

			// Archimedean spiral search
			let found = false;
			let px = 0, py = 0;
			for (let step = 0; step < 10000; step++) {
				const angle = step * 0.1;
				const radius = 2 + step * 0.12;
				const sx = cx + radius * Math.cos(angle) - boxW / 2;
				const sy = cy + radius * Math.sin(angle) - boxH / 2;

				if (!isOccupied(sx, sy, boxW, boxH)) {
					px = sx;
					py = sy;
					found = true;
					break;
				}
			}

			if (!found) continue;

			occupy(px, py, boxW, boxH);

			const opacity = 0.5 + t * 0.5;
			const hue = 10 + (1 - t) * 30; // warm range
			ctx.fillStyle = `hsla(${hue}, 55%, ${30 + (1 - t) * 25}%, ${opacity})`;

			if (rotated) {
				ctx.save();
				ctx.translate(px + boxW / 2, py + boxH / 2);
				ctx.rotate(-Math.PI / 2);
				ctx.font = `${fontSize}px ${cloudFont}`;
				ctx.fillText(entry.word, -textW / 2, -textH / 2);
				ctx.restore();
			} else {
				ctx.font = `${fontSize}px ${cloudFont}`;
				ctx.fillText(entry.word, px + PADDING, py + PADDING);
			}

			placed.push({
				entry,
				x: px,
				y: py,
				width: boxW,
				height: boxH,
				fontSize,
				rotated
			});
		}

		placedWords = placed;
		cloudRendered = true;
	}

	function hitTest(clientX: number, clientY: number): PlacedWord | null {
		if (!canvasEl) return null;
		const rect = canvasEl.getBoundingClientRect();
		const x = clientX - rect.left;
		const y = clientY - rect.top;
		// Check in reverse (topmost first — last drawn)
		for (let i = placedWords.length - 1; i >= 0; i--) {
			const pw = placedWords[i];
			if (x >= pw.x && x <= pw.x + pw.width && y >= pw.y && y <= pw.y + pw.height) {
				return pw;
			}
		}
		return null;
	}

	function handleCanvasMouseMove(e: MouseEvent) {
		mouseX = e.clientX;
		mouseY = e.clientY;
		const hit = hitTest(e.clientX, e.clientY);
		hoveredWord = hit?.entry ?? null;
		if (canvasEl) {
			canvasEl.style.cursor = hit ? 'pointer' : 'default';
		}
	}

	function handleCanvasClick(e: MouseEvent) {
		const hit = hitTest(e.clientX, e.clientY);
		if (hit) {
			handleWordClick(hit.entry);
		} else {
			selectedWord = null;
		}
	}

	function handlePageMouseMove(e: MouseEvent) {
		mouseX = e.clientX;
		mouseY = e.clientY;
	}

	async function renderCloud() {
		await tick();
		const slice = words.slice(0, maxDisplay);
		if (slice.length > 0 && canvasEl && canvasWrapper) {
			buildCloud(slice);
		}
	}

	$effect(() => {
		if (!loading && words.length > 0 && canvasEl && canvasWrapper) {
			// Re-render when maxDisplay or font changes
			const _ = maxDisplay;
			const __ = cloudFont;
			renderCloud();
		}
	});

	async function analyze(handle: string) {
		const token = ++loadToken;
		loadController?.abort();
		const controller = new AbortController();
		loadController = controller;

		loading = true;
		error = null;
		words = [];
		totalWords = 0;
		totalPosts = 0;
		uniqueWords = 0;
		selectedWord = null;
		hoveredWord = null;
		cloudRendered = false;
		placedWords = [];

		try {
			progress = { phase: 'Resolving profile…', current: 0, total: 0 };
			const prof = await getProfile(handle);
			if (token !== loadToken) return;
			profile = prof;

			updateHandleQuery(prof.handle);

			progress = { phase: 'Downloading repository…', current: 0, total: 0 };
			const download = await downloadRepoCar(prof.did, {
				collection: 'app.bsky.feed.post',
				signal: controller.signal,
				onDownloadProgress: (p: RepoDownloadProgress) => {
					if (token !== loadToken) return;
					const detail = p.totalBytes > 0
						? `${formatBytes(p.receivedBytes)} / ${formatBytes(p.totalBytes)} (${formatSpeed(p.bytesPerSecond)})`
						: `${formatBytes(p.receivedBytes)} (${formatSpeed(p.bytesPerSecond)})`;
					progress = {
						phase: 'Downloading repository…',
						current: p.receivedBytes,
						total: p.totalBytes,
						detail
					};
				}
			});
			if (token !== loadToken) return;

			progress = { phase: 'Parsing posts (WASM)…', current: 0, total: 0 };
			const parsedPosts = await parseCarPostsWasm(download.carBytes, (count) => {
				if (token !== loadToken) return;
				progress = { phase: 'Parsing posts (WASM)…', current: count, total: 0 };
			});
			if (token !== loadToken) return;

			progress = { phase: 'Computing word frequencies…', current: 0, total: 0 };
			await new Promise((r) => setTimeout(r, 0));

			const result = computeWordFrequencies(parsedPosts);
			if (token !== loadToken) return;

			words = result.entries;
			totalWords = result.totalTokens;
			totalPosts = result.postCount;
			uniqueWords = result.uniqueCount;
		} catch (err: any) {
			if (err?.name === 'AbortError') return;
			if (token !== loadToken) return;
			error = err?.message ?? 'An unexpected error occurred';
		} finally {
			if (token === loadToken) {
				loading = false;
			}
		}
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

	onMount(() => {
		const params = new URL(window.location.href).searchParams;
		const h = params.get('handle')?.trim();
		if (h) {
			initialHandle = h;
			analyze(h);
		}
	});
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="page" onmousemove={handlePageMouseMove}>
	<RouteNav current="wordcloud" handle={profile?.handle ?? initialHandle} compact />

	<header class="header">
		<h1>Word Cloud</h1>
		<p class="subtitle">Download a person's repo, parse with WASM, visualize word frequencies</p>
	</header>

	<div class="search-area">
		<SearchBar
			{initialHandle}
			onsearch={(h) => analyze(h)}
			onprofile={(p) => { profile = p; analyze(p.handle); }}
			disabled={loading}
			placeholder="Enter a Bluesky handle…"
			buttonLabel="Analyze"
		/>
	</div>

	{#if loading}
		<LoadingSpinner {progress} />
	{/if}

	{#if error}
		<ErrorBanner message={error} />
	{/if}

	{#if !loading && words.length > 0}
		<div class="stats-bar">
			{#if profile}
				<div class="profile-badge">
					{#if profile.avatar}
						<img src={profile.avatar} alt="" class="profile-avatar" />
					{/if}
					<span class="profile-name">{profile.displayName ?? profile.handle}</span>
					<span class="profile-handle">@{profile.handle}</span>
				</div>
			{/if}
			<div class="stats">
				<span class="stat"><strong>{totalPosts.toLocaleString()}</strong> posts</span>
				<span class="stat"><strong>{totalWords.toLocaleString()}</strong> words</span>
				<span class="stat"><strong>{uniqueWords.toLocaleString()}</strong> unique</span>
			</div>
		</div>

		<div class="controls">
			<div class="sort-controls">
				<button
					class="control-btn"
					class:active={sortBy === 'count'}
					onclick={() => (sortBy = 'count')}
				>
					By frequency
				</button>
				<button
					class="control-btn"
					class:active={sortBy === 'alpha'}
					onclick={() => (sortBy = 'alpha')}
				>
					Alphabetical
				</button>
			</div>
			<div class="display-controls">
				<label class="display-label">
					Show:
					<select bind:value={maxDisplay} class="display-select">
						<option value={50}>50</option>
						<option value={100}>100</option>
						<option value={200}>200</option>
						<option value={500}>500</option>
					</select>
					words
				</label>
				<FontPicker value={fontKey} onchange={(key) => { fontKey = key; }} />
			</div>
		</div>

		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<!-- svelte-ignore a11y_click_events_have_key_events -->
		<div class="cloud-wrapper wobbly-border" bind:this={canvasWrapper}>
			<canvas
				bind:this={canvasEl}
				onmousemove={handleCanvasMouseMove}
				onmouseleave={() => { hoveredWord = null; }}
				onclick={handleCanvasClick}
			></canvas>
		</div>

		{#if selectedWord}
			<div class="word-detail wobbly-border-light">
				<span class="detail-word">{selectedWord.word}</span>
				<span class="detail-stat">Used <strong>{selectedWord.count.toLocaleString()}</strong> times</span>
				<span class="detail-stat">Rank <strong>#{selectedWord.rank}</strong> of {uniqueWords.toLocaleString()}</span>
				<span class="detail-stat"><strong>{selectedWord.percentage.toFixed(2)}%</strong> of all words</span>
				<span class="detail-stat">~<strong>{(selectedWord.count / totalPosts).toFixed(2)}</strong> per post</span>
			</div>
		{/if}

		<div class="table-section">
			<h2>Top Words</h2>
			<div class="table-wrapper">
				<table class="word-table">
					<thead>
						<tr>
							<th>Rank</th>
							<th>Word</th>
							<th>Count</th>
							<th>% of total</th>
							<th>Per post</th>
						</tr>
					</thead>
					<tbody>
						{#each sortedWords as w (w.word)}
							<tr
								class:highlight={selectedWord?.word === w.word || hoveredWord?.word === w.word}
								onmouseenter={() => (hoveredWord = w)}
								onmouseleave={() => (hoveredWord = null)}
								onclick={() => handleWordClick(w)}
							>
								<td class="rank">#{w.rank}</td>
								<td class="word-cell">{w.word}</td>
								<td class="count">{w.count.toLocaleString()}</td>
								<td class="pct">{w.percentage.toFixed(2)}%</td>
								<td class="per-post">{(w.count / totalPosts).toFixed(2)}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		</div>
	{/if}
</div>

{#if hoveredWord && !selectedWord}
	<div class="tooltip" style="left: {mouseX + 14}px; top: {mouseY + 14}px;">
		<span class="tooltip-word">{hoveredWord.word}</span>
		<span class="tooltip-line">Used <strong>{hoveredWord.count.toLocaleString()}</strong> times</span>
		<span class="tooltip-line">Rank <strong>#{hoveredWord.rank}</strong> of {uniqueWords.toLocaleString()}</span>
		<span class="tooltip-line"><strong>{hoveredWord.percentage.toFixed(2)}%</strong> of all words</span>
		<span class="tooltip-line">~<strong>{(hoveredWord.count / totalPosts).toFixed(2)}</strong> per post</span>
	</div>
{/if}

<style>
	.page {
		max-width: 960px;
		margin: 0 auto;
		padding: 24px 16px 64px;
	}

	.header {
		text-align: center;
		margin-bottom: 16px;
	}

	.header h1 {
		font-size: 2rem;
		margin-bottom: 4px;
	}

	.subtitle {
		color: var(--muted);
		font-size: 1rem;
	}

	.search-area {
		max-width: 520px;
		margin: 0 auto 24px;
	}

	.stats-bar {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 16px;
		margin-bottom: 16px;
		padding: 12px 16px;
		background: var(--card-bg);
		border-radius: 12px;
		border: 1px solid rgba(0, 0, 0, 0.08);
	}

	.profile-badge {
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.profile-avatar {
		width: 32px;
		height: 32px;
		border-radius: 50%;
		object-fit: cover;
	}

	.profile-name {
		font-weight: 700;
		font-size: 1rem;
	}

	.profile-handle {
		color: var(--muted);
		font-size: 0.9rem;
	}

	.stats {
		display: flex;
		gap: 16px;
		margin-left: auto;
	}

	.stat {
		font-size: 0.9rem;
		color: var(--muted);
	}

	.stat strong {
		color: var(--text-ink);
	}

	.controls {
		display: flex;
		flex-wrap: wrap;
		justify-content: space-between;
		align-items: center;
		gap: 12px;
		margin-bottom: 16px;
	}

	.sort-controls {
		display: flex;
		gap: 6px;
	}

	.control-btn {
		padding: 6px 14px;
		border: 1.5px solid var(--muted);
		border-radius: 999px;
		background: var(--card-bg);
		font-family: inherit;
		font-size: 0.85rem;
		cursor: pointer;
		transition: all 0.15s ease;
	}

	.control-btn:hover {
		border-color: var(--accent);
	}

	.control-btn.active {
		background: color-mix(in srgb, var(--accent) 16%, white);
		border-color: var(--accent);
		font-weight: 600;
	}

	.display-label {
		font-size: 0.85rem;
		color: var(--muted);
		display: flex;
		align-items: center;
		gap: 6px;
	}

	.display-select {
		font-family: inherit;
		font-size: 0.85rem;
		padding: 4px 8px;
		border: 1px solid rgba(0, 0, 0, 0.15);
		border-radius: 6px;
		background: white;
	}

	.cloud-wrapper {
		margin-bottom: 24px;
		background: var(--card-bg);
		overflow: hidden;
	}

	.cloud-wrapper canvas {
		display: block;
		width: 100%;
	}

	.word-detail {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 12px;
		padding: 10px 16px;
		margin-bottom: 12px;
		background: rgba(255, 255, 255, 0.9);
		font-size: 0.9rem;
	}

	.detail-word {
		font-weight: 700;
		font-size: 1.2rem;
		color: var(--accent);
	}

	.detail-stat {
		color: var(--muted);
	}

	.detail-stat strong {
		color: var(--text-ink);
	}

	.tooltip {
		position: fixed;
		z-index: 1000;
		pointer-events: none;
		background: rgba(30, 30, 30, 0.92);
		color: #fff;
		padding: 10px 14px;
		border-radius: 8px;
		font-size: 0.85rem;
		line-height: 1.6;
		display: flex;
		flex-direction: column;
		gap: 1px;
		box-shadow: 0 4px 16px rgba(0, 0, 0, 0.2);
		max-width: 260px;
	}

	.tooltip-word {
		font-weight: 700;
		font-size: 1.05rem;
		color: var(--accent-light);
		margin-bottom: 2px;
	}

	.tooltip-line {
		color: rgba(255, 255, 255, 0.8);
	}

	.tooltip-line strong {
		color: #fff;
	}

	.table-section {
		margin-top: 8px;
	}

	.table-section h2 {
		font-size: 1.3rem;
		margin-bottom: 12px;
	}

	.table-wrapper {
		overflow-x: auto;
	}

	.word-table {
		width: 100%;
		border-collapse: collapse;
		font-size: 0.9rem;
	}

	.word-table th {
		text-align: left;
		padding: 8px 12px;
		border-bottom: 2px solid var(--border-color);
		font-weight: 700;
		font-size: 0.85rem;
		color: var(--muted);
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}

	.word-table td {
		padding: 6px 12px;
		border-bottom: 1px solid rgba(0, 0, 0, 0.06);
	}

	.word-table tr {
		cursor: pointer;
		transition: background 0.1s ease;
	}

	.word-table tbody tr:hover,
	.word-table tr.highlight {
		background: rgba(224, 122, 95, 0.06);
	}

	.rank {
		color: var(--muted);
		font-size: 0.85rem;
	}

	.word-cell {
		font-weight: 600;
	}

	.count {
		font-variant-numeric: tabular-nums;
	}

	.pct, .per-post {
		font-variant-numeric: tabular-nums;
		color: var(--muted);
	}

	@media (max-width: 640px) {
		.page {
			padding: 16px 12px 48px;
		}

		.header h1 {
			font-size: 1.5rem;
		}

		.stats-bar {
			flex-direction: column;
			align-items: flex-start;
		}

		.stats {
			margin-left: 0;
		}

		.controls {
			flex-direction: column;
			align-items: flex-start;
		}
	}
</style>
