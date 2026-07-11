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
	import type { ParsedPost } from '$lib/utils/carParser';
	import type { DiscoverProgress } from '$lib/types';

	const DEFAULT_STOPWORDS = [
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
	];

	const STOPWORDS_STORAGE_KEY = 'wordcloud-stopwords';

	function parseStopwords(text: string): Set<string> {
		return new Set(
			text
				.toLowerCase()
				.split(/[\s,]+/)
				.map((w) => w.trim())
				.filter((w) => w.length > 0)
		);
	}

	let stopwords = new Set(DEFAULT_STOPWORDS);
	let stopwordsText = $state(DEFAULT_STOPWORDS.join(', '));
	let appliedStopwordCount = $state(DEFAULT_STOPWORDS.length);
	let showStopwords = $state(false);
	let stopwordsDirty = $state(false);

	function applyStopwords() {
		stopwords = parseStopwords(stopwordsText);
		appliedStopwordCount = stopwords.size;
		stopwordsDirty = false;
		if (browser) {
			try {
				const isDefault =
					stopwords.size === DEFAULT_STOPWORDS.length &&
					DEFAULT_STOPWORDS.every((w) => stopwords.has(w));
				if (isDefault) {
					localStorage.removeItem(STOPWORDS_STORAGE_KEY);
				} else {
					localStorage.setItem(STOPWORDS_STORAGE_KEY, [...stopwords].join(', '));
				}
			} catch {
				// storage unavailable — keep in-memory only
			}
		}
		recomputeFromPosts();
	}

	function resetStopwords() {
		stopwordsText = DEFAULT_STOPWORDS.join(', ');
		applyStopwords();
	}

	function recomputeFromPosts() {
		if (allPosts.length === 0) return;
		const result = computeWordFrequencies(allPosts);
		selectedWord = null;
		hoveredWord = null;
		closeOverlay();
		words = result.entries;
		totalWords = result.totalTokens;
		totalPosts = result.postCount;
		uniqueWords = result.uniqueCount;
	}

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

	interface MatchedPost {
		rkey: string;
		text: string;
		createdAt: string;
	}

	const POSTS_PAGE_SIZE = 100;
	const MAX_FLYING_CARDS = 30;
	const FIREHOSE_MAX_POSTS = 400;
	const FIREHOSE_MAX_ACTIVE = 60;

	let allPosts: ParsedPost[] = [];
	let overlayWord = $state<WordEntry | null>(null);
	let matchedPosts = $state<MatchedPost[]>([]);
	let visibleCount = $state(POSTS_PAGE_SIZE);
	let flyOrigin = { x: 0, y: 0 };

	const visiblePosts = $derived(matchedPosts.slice(0, visibleCount));

	interface FirehoseCard {
		id: number;
		post: MatchedPost;
		style: string;
	}

	let firehoseMode = $state(false);
	let firehoseActive = $state(false);
	let firehoseCards = $state<FirehoseCard[]>([]);
	let firehoseTimer: ReturnType<typeof setInterval> | null = null;
	let firehoseEndTimer: ReturnType<typeof setTimeout> | null = null;
	let firehoseCardId = 0;

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
			?.filter((t) => !stopwords.has(t) && t.length <= 30) ?? [];
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

	function handleWordClick(w: WordEntry, e?: MouseEvent) {
		selectedWord = w;
		flyOrigin = e
			? { x: e.clientX, y: e.clientY }
			: { x: window.innerWidth / 2, y: window.innerHeight / 2 };
		openWordPosts(w);
	}

	function openWordPosts(w: WordEntry) {
		const matches: MatchedPost[] = [];
		for (const post of allPosts) {
			const text = post.record?.text;
			if (typeof text !== 'string') continue;
			if (!tokenize(text).includes(w.word)) continue;
			matches.push({
				rkey: post.rkey,
				text,
				createdAt: typeof post.record?.createdAt === 'string' ? post.record.createdAt : ''
			});
		}
		matches.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
		matchedPosts = matches;
		visibleCount = POSTS_PAGE_SIZE;
		overlayWord = w;

		const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
		if (firehoseMode && !reducedMotion && matches.length > 0) {
			startFirehose(matches.slice(0, FIREHOSE_MAX_POSTS));
		}
	}

	function startFirehose(posts: MatchedPost[]) {
		stopFirehose();
		firehoseActive = true;

		// Shuffle so the blast isn't chronological
		const queue = [...posts];
		for (let i = queue.length - 1; i > 0; i--) {
			const j = Math.floor(Math.random() * (i + 1));
			[queue[i], queue[j]] = [queue[j], queue[i]];
		}

		// Pace the blast to finish in ~8s regardless of post count
		const interval = Math.max(30, Math.min(150, Math.round(8000 / queue.length)));
		const MAX_DUR = 2600;
		let index = 0;

		firehoseTimer = setInterval(() => {
			if (index >= queue.length) {
				if (firehoseTimer) clearInterval(firehoseTimer);
				firehoseTimer = null;
				firehoseEndTimer = setTimeout(() => finishFirehose(), MAX_DUR);
				return;
			}
			const card: FirehoseCard = {
				id: firehoseCardId++,
				post: queue[index++],
				style: firehoseCardStyle()
			};
			const next = [...firehoseCards, card];
			// Drop oldest cards if the DOM is getting crowded
			firehoseCards = next.length > FIREHOSE_MAX_ACTIVE ? next.slice(next.length - FIREHOSE_MAX_ACTIVE) : next;
		}, interval);
	}

	function firehoseCardStyle(): string {
		const vw = window.innerWidth;
		const vh = window.innerHeight;
		// Spawn near the clicked word with some spray
		const ox = flyOrigin.x + (Math.random() - 0.5) * 120;
		const oy = flyOrigin.y + (Math.random() - 0.5) * 120;
		// Blast outward in a random direction, well past the screen edge
		const angle = Math.random() * Math.PI * 2;
		const dist = Math.hypot(vw, vh) * (0.6 + Math.random() * 0.6);
		const tx = Math.cos(angle) * dist;
		const ty = Math.sin(angle) * dist;
		const scale = 1.6 + Math.random() * 2.2;
		const rot = (Math.random() - 0.5) * 90;
		const dur = 1400 + Math.random() * 1200;
		return (
			`left: ${ox.toFixed(0)}px; top: ${oy.toFixed(0)}px; ` +
			`--tx: ${tx.toFixed(0)}px; --ty: ${ty.toFixed(0)}px; ` +
			`--sc: ${scale.toFixed(2)}; --rot: ${rot.toFixed(1)}deg; --dur: ${dur.toFixed(0)}ms;`
		);
	}

	function removeFirehoseCard(id: number) {
		firehoseCards = firehoseCards.filter((c) => c.id !== id);
	}

	function finishFirehose() {
		stopFirehose();
	}

	function stopFirehose() {
		if (firehoseTimer) clearInterval(firehoseTimer);
		if (firehoseEndTimer) clearTimeout(firehoseEndTimer);
		firehoseTimer = null;
		firehoseEndTimer = null;
		firehoseActive = false;
		firehoseCards = [];
	}

	function closeOverlay() {
		stopFirehose();
		overlayWord = null;
		matchedPosts = [];
		visibleCount = POSTS_PAGE_SIZE;
	}

	function handlePostsScroll(e: Event) {
		const el = e.currentTarget as HTMLElement;
		if (el.scrollTop + el.clientHeight >= el.scrollHeight - 400 && visibleCount < matchedPosts.length) {
			visibleCount = Math.min(matchedPosts.length, visibleCount + POSTS_PAGE_SIZE);
		}
	}

	function flyStyle(i: number): string {
		if (i >= MAX_FLYING_CARDS) return '';
		// Cards start near the clicked word (tiny, "far away") and fly out to
		// their resting spot in the overlay, scaling up toward the viewer.
		const cx = window.innerWidth / 2;
		const jitterX = (Math.random() - 0.5) * 160;
		const jitterY = (Math.random() - 0.5) * 120;
		const fx = flyOrigin.x - cx + jitterX;
		const fy = flyOrigin.y - Math.min(window.innerHeight * 0.4, 120 + i * 40) + jitterY;
		const rot = (Math.random() - 0.5) * 24;
		const delay = i * 55;
		return `--fx: ${fx.toFixed(0)}px; --fy: ${fy.toFixed(0)}px; --rot: ${rot.toFixed(1)}deg; --delay: ${delay}ms;`;
	}

	function formatDate(iso: string): string {
		if (!iso) return '';
		const d = new Date(iso);
		if (isNaN(d.getTime())) return '';
		return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
	}

	function highlightParts(text: string, word: string): { part: string; hit: boolean }[] {
		const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		const re = new RegExp(`(${escaped})`, 'gi');
		return text.split(re).map((part) => ({ part, hit: part.toLowerCase() === word.toLowerCase() }));
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
			handleWordClick(hit.entry, e);
		} else {
			selectedWord = null;
		}
	}

	function handleOverlayKeydown(e: KeyboardEvent) {
		if (e.key !== 'Escape') return;
		if (firehoseActive) {
			// First Escape skips the blast and drops into the list
			stopFirehose();
		} else if (overlayWord) {
			closeOverlay();
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
		allPosts = [];
		closeOverlay();

		try {
			progress = { phase: 'Resolving profile…', current: 0, total: 0 };
			const prof = await getProfile(handle);
			if (token !== loadToken) return;
			profile = prof;

			updateHandleQuery(prof.handle);

			progress = { phase: 'Downloading repository…', current: 0, total: 0 };
			const download = await downloadRepoCar(prof.did, {
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

			allPosts = parsedPosts;
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

	async function analyzeSavedRepoCar(_entry: unknown, carBytes: Uint8Array) {
		const prof = profile;
		if (!prof) return;
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
		allPosts = [];
		closeOverlay();

		try {
			updateHandleQuery(prof.handle);
			progress = { phase: 'Parsing saved CAR posts (WASM)…', current: 0, total: 0 };
			const parsedPosts = await parseCarPostsWasm(carBytes, (count) => {
				if (token !== loadToken) return;
				progress = { phase: 'Parsing saved CAR posts (WASM)…', current: count, total: 0 };
			});
			if (token !== loadToken || controller.signal.aborted) return;

			progress = { phase: 'Computing word frequencies…', current: 0, total: 0 };
			await new Promise((r) => setTimeout(r, 0));
			const result = computeWordFrequencies(parsedPosts);
			if (token !== loadToken) return;

			allPosts = parsedPosts;
			words = result.entries;
			totalWords = result.totalTokens;
			totalPosts = result.postCount;
			uniqueWords = result.uniqueCount;
		} catch (err: any) {
			if (err?.name === 'AbortError') return;
			if (token !== loadToken) return;
			error = err?.message ?? 'Could not load the saved CAR.';
		} finally {
			if (token === loadToken) loading = false;
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
		try {
			const saved = localStorage.getItem(STOPWORDS_STORAGE_KEY);
			if (saved !== null) {
				stopwordsText = saved;
				stopwords = parseStopwords(saved);
				appliedStopwordCount = stopwords.size;
			}
		} catch {
			// storage unavailable — use defaults
		}

		const params = new URL(window.location.href).searchParams;
		const h = params.get('handle')?.trim();
		if (h) {
			initialHandle = h;
			analyze(h);
		}
		return () => stopFirehose();
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
				<button
					class="control-btn firehose-toggle"
					class:active={firehoseMode}
					onclick={() => (firehoseMode = !firehoseMode)}
					title="When on, clicking a word blasts every matching post across the screen"
				>
					🔥 Firehose
				</button>
				<button
					class="control-btn"
					class:active={showStopwords}
					onclick={() => (showStopwords = !showStopwords)}
					title="Edit the list of words excluded from the cloud"
				>
					Stop words ({appliedStopwordCount})
				</button>
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

		{#if showStopwords}
			<div class="stopwords-panel wobbly-border-light">
				<label class="stopwords-label" for="stopwords-input">
					Words to exclude (separated by spaces, commas, or newlines)
				</label>
				<textarea
					id="stopwords-input"
					class="stopwords-input"
					rows="5"
					bind:value={stopwordsText}
					oninput={() => (stopwordsDirty = true)}
					spellcheck="false"
				></textarea>
				<div class="stopwords-actions">
					<button class="control-btn" onclick={applyStopwords} disabled={!stopwordsDirty}>
						Apply
					</button>
					<button class="control-btn" onclick={resetStopwords}>Reset to defaults</button>
					{#if stopwordsDirty}
						<span class="stopwords-hint">Unapplied changes</span>
					{/if}
				</div>
			</div>
		{/if}

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
								onclick={(e) => handleWordClick(w, e)}
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

<svelte:window onkeydown={handleOverlayKeydown} />

{#if firehoseActive && overlayWord}
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<div class="firehose-layer" onclick={stopFirehose}>
		{#each firehoseCards as card (card.id)}
			<article
				class="firehose-card"
				style={card.style}
				onanimationend={() => removeFirehoseCard(card.id)}
			>
				<p class="firehose-text">
					{#each highlightParts(card.post.text, overlayWord.word) as seg}
						{#if seg.hit}<mark class="post-hit">{seg.part}</mark>{:else}{seg.part}{/if}
					{/each}
				</p>
			</article>
		{/each}
		<div class="firehose-hint">🔥 {overlayWord.word} — click or press Esc to stop</div>
	</div>
{:else if overlayWord}
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<div class="posts-overlay" onclick={(e) => { if (e.target === e.currentTarget) closeOverlay(); }}>
		<div class="posts-panel">
			<div class="posts-header">
				<div class="posts-title">
					<span class="posts-word">{overlayWord.word}</span>
					<span class="posts-count">
						{matchedPosts.length.toLocaleString()} post{matchedPosts.length === 1 ? '' : 's'}
					</span>
				</div>
				<button class="posts-close" onclick={closeOverlay} aria-label="Close">✕</button>
			</div>
			<div class="posts-list" onscroll={handlePostsScroll}>
				{#each visiblePosts as post, i (post.rkey)}
					<article
						class="post-card wobbly-border-light"
						class:static={i >= MAX_FLYING_CARDS}
						style={flyStyle(i)}
					>
						<p class="post-text">
							{#each highlightParts(post.text, overlayWord.word) as seg}
								{#if seg.hit}<mark class="post-hit">{seg.part}</mark>{:else}{seg.part}{/if}
							{/each}
						</p>
						<div class="post-meta">
							<span class="post-date">{formatDate(post.createdAt)}</span>
							{#if profile}
								<a
									class="post-link"
									href={`https://bsky.app/profile/${profile.handle}/post/${post.rkey}`}
									target="_blank"
									rel="noopener noreferrer"
								>
									View on Bluesky ↗
								</a>
							{/if}
						</div>
					</article>
				{/each}
				{#if matchedPosts.length === 0}
					<p class="posts-empty">No posts found containing this word.</p>
				{/if}
			</div>
		</div>
	</div>
{/if}

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
		display: grid;
		gap: 10px;
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

	.stopwords-panel {
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding: 12px 16px;
		margin-bottom: 16px;
		background: var(--card-bg);
	}

	.stopwords-label {
		font-size: 0.85rem;
		color: var(--muted);
	}

	.stopwords-input {
		width: 100%;
		box-sizing: border-box;
		font-family: inherit;
		font-size: 0.85rem;
		line-height: 1.5;
		padding: 8px 10px;
		border: 1px solid rgba(0, 0, 0, 0.15);
		border-radius: 8px;
		background: white;
		resize: vertical;
	}

	.stopwords-actions {
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.stopwords-actions .control-btn:disabled {
		opacity: 0.5;
		cursor: default;
	}

	.stopwords-hint {
		font-size: 0.8rem;
		color: var(--accent);
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

	.firehose-toggle.active {
		background: color-mix(in srgb, #e25822 22%, white);
		border-color: #e25822;
	}

	.firehose-layer {
		position: fixed;
		inset: 0;
		z-index: 950;
		background: rgba(12, 8, 6, 0.72);
		overflow: hidden;
		cursor: pointer;
		animation: overlay-fade 0.2s ease both;
	}

	.firehose-card {
		position: absolute;
		width: min(300px, 70vw);
		padding: 10px 14px;
		background: rgba(255, 252, 246, 0.97);
		border-radius: 10px;
		box-shadow: 0 8px 32px rgba(0, 0, 0, 0.45);
		pointer-events: none;
		transform: translate(-50%, -50%) scale(0.05);
		animation: firehose-blast var(--dur, 1800ms) cubic-bezier(0.3, 0.6, 0.6, 1) both;
		will-change: transform, opacity;
	}

	@keyframes firehose-blast {
		0% {
			transform: translate(-50%, -50%) scale(0.05) rotate(0deg);
			opacity: 0;
		}
		12% {
			opacity: 1;
		}
		75% {
			opacity: 1;
		}
		100% {
			transform: translate(calc(-50% + var(--tx, 0px)), calc(-50% + var(--ty, 0px)))
				scale(var(--sc, 2.5)) rotate(var(--rot, 0deg));
			opacity: 0;
		}
	}

	.firehose-text {
		margin: 0;
		font-size: 0.85rem;
		line-height: 1.45;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
		display: -webkit-box;
		-webkit-line-clamp: 6;
		line-clamp: 6;
		-webkit-box-orient: vertical;
		overflow: hidden;
	}

	.firehose-hint {
		position: absolute;
		bottom: 24px;
		left: 50%;
		transform: translateX(-50%);
		color: rgba(255, 255, 255, 0.85);
		font-size: 0.9rem;
		background: rgba(0, 0, 0, 0.4);
		padding: 8px 16px;
		border-radius: 999px;
		pointer-events: none;
		white-space: nowrap;
	}

	.posts-overlay {
		position: fixed;
		inset: 0;
		z-index: 900;
		background: rgba(20, 15, 12, 0.45);
		backdrop-filter: blur(3px);
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 24px 16px;
		animation: overlay-fade 0.25s ease both;
	}

	@keyframes overlay-fade {
		from { opacity: 0; }
		to { opacity: 1; }
	}

	.posts-panel {
		width: min(680px, 100%);
		max-height: 86vh;
		display: flex;
		flex-direction: column;
		background: var(--card-bg, #fdf9f4);
		border-radius: 16px;
		box-shadow: 0 24px 64px rgba(0, 0, 0, 0.35);
		overflow: hidden;
	}

	.posts-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		padding: 14px 20px;
		border-bottom: 1px solid rgba(0, 0, 0, 0.08);
	}

	.posts-title {
		display: flex;
		align-items: baseline;
		gap: 12px;
		min-width: 0;
	}

	.posts-word {
		font-weight: 700;
		font-size: 1.4rem;
		color: var(--accent);
		overflow-wrap: anywhere;
	}

	.posts-count {
		color: var(--muted);
		font-size: 0.9rem;
		white-space: nowrap;
	}

	.posts-close {
		border: none;
		background: none;
		font-size: 1.1rem;
		cursor: pointer;
		color: var(--muted);
		padding: 6px 10px;
		border-radius: 8px;
		transition: background 0.15s ease;
	}

	.posts-close:hover {
		background: rgba(0, 0, 0, 0.06);
		color: var(--text-ink);
	}

	.posts-list {
		overflow-y: auto;
		padding: 16px 20px 24px;
		display: flex;
		flex-direction: column;
		gap: 12px;
	}

	.post-card {
		background: rgba(255, 255, 255, 0.95);
		padding: 12px 16px;
		animation: fly-in 0.65s cubic-bezier(0.22, 1, 0.36, 1) both;
		animation-delay: var(--delay, 0ms);
		will-change: transform, opacity;
	}

	@keyframes fly-in {
		0% {
			transform: translate(var(--fx, 0px), var(--fy, -60px)) scale(0.05) rotate(var(--rot, 0deg));
			opacity: 0;
		}
		55% {
			opacity: 1;
		}
		100% {
			transform: none;
			opacity: 1;
		}
	}

	.post-card.static {
		animation: none;
	}

	@media (prefers-reduced-motion: reduce) {
		.post-card {
			animation: none;
		}
	}

	.post-text {
		font-size: 0.95rem;
		line-height: 1.5;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
		margin: 0 0 8px;
	}

	.post-hit {
		background: color-mix(in srgb, var(--accent) 30%, transparent);
		color: inherit;
		border-radius: 3px;
		padding: 0 2px;
		font-weight: 700;
	}

	.post-meta {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		font-size: 0.8rem;
		color: var(--muted);
	}

	.post-link {
		color: var(--accent);
		text-decoration: none;
		white-space: nowrap;
	}

	.post-link:hover {
		text-decoration: underline;
	}

	.posts-empty {
		text-align: center;
		color: var(--muted);
		padding: 24px 0;
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
