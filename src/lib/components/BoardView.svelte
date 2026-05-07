	<script lang="ts">
		import { onMount, tick } from 'svelte';
		import { getFullThread as getBlueskyFullThread } from '$lib/api/bluesky';
		import type { ThreadPost } from '$lib/types';
		import type { BoardPlatformConfig, BoardThread } from '$lib/types/boardPlatform';
		import LinkedPostEmbeds from '$lib/components/LinkedPostEmbeds.svelte';
		import ThreadExportButton from '$lib/components/ThreadExportButton.svelte';
	import { openLightbox } from '$lib/stores/lightbox';
	import {
		buildParentMap,
		buildVisiblePostOrder,
		findMatchingPosts,
		getVisibleChildren,
		isBranchCollapsed,
		revealCollapsedPaths
	} from '$lib/utils/boardTree';

	type QuoteThreadStatus = 'loading' | 'ready' | 'error';
	type QuoteThreadEntry = {
		quotedUri: string;
		quotedHandle: string;
		sourceUri: string;
		sourcePanelUri?: string;
		loadedAt: number;
		status: QuoteThreadStatus;
		thread?: BoardThread;
		error?: string;
	};
	type ReadyQuoteThreadEntry = QuoteThreadEntry & { status: 'ready'; thread: BoardThread };
	type TreeRegistration = {
		update: (panelId: string) => void;
		destroy: () => void;
	};

	function buildBlueskyPostUrl(uri: string, handle: string): string {
		const rkey = uri.split('/').pop();
		return `https://bsky.app/profile/${handle}/post/${rkey}`;
	}

	const defaultBoardPlatform: BoardPlatformConfig = {
		name: 'Bluesky',
		postLabel: 'post',
		buildPostUrl: buildBlueskyPostUrl,
		loadThread: getBlueskyFullThread
	};

	let {
		thread,
		initialActiveUri = null,
		platform = defaultBoardPlatform,
		showExport = true
	}: {
		thread: BoardThread;
		initialActiveUri?: string | null;
		platform?: BoardPlatformConfig;
		showExport?: boolean;
	} = $props();

	type HighlightSegment = {
		text: string;
		match: boolean;
	};
	const MAIN_TREE_PANEL_ID = '__main__';

	let boardEl: HTMLDivElement | undefined = $state();
	let collapsedBranches = $state<Record<string, boolean>>({});
	let authorSearch = $state('');
	let textSearch = $state('');
	let searchMessage = $state('');
	let searchStatus = $state<'success' | 'error' | ''>('');
	let authorMatchLookup = $state<Record<string, boolean>>({});
	let authorMatchQuery = $state('');
	let authorMatchIndex = $state(-1);
	let textMatchLookup = $state<Record<string, boolean>>({});
	let textMatchQuery = $state('');
	let textMatchIndex = $state(-1);
	let showSearchPanel = $state(true);
	let quoteThreads = $state<Record<string, QuoteThreadEntry>>({});
	let activeQuoteUri = $state('');
	let treeLinePaths = $state<Record<string, string>>({});
	const treeContainerEls = new Map<string, HTMLDivElement>();
	const treeSvgEls = new Map<string, SVGSVGElement>();

	function scheduleTreeLineRefresh() {
		requestAnimationFrame(() => computeTreeLines());
	}

	function registerTreeContainer(node: HTMLDivElement, panelId: string): TreeRegistration {
		treeContainerEls.set(panelId, node);
		scheduleTreeLineRefresh();
		return {
			update(nextPanelId: string) {
				if (nextPanelId === panelId) return;
				treeContainerEls.delete(panelId);
				panelId = nextPanelId;
				treeContainerEls.set(panelId, node);
				scheduleTreeLineRefresh();
			},
			destroy() {
				treeContainerEls.delete(panelId);
				scheduleTreeLineRefresh();
			}
		};
	}

	function registerTreeSvg(node: SVGSVGElement, panelId: string): TreeRegistration {
		treeSvgEls.set(panelId, node);
		scheduleTreeLineRefresh();
		return {
			update(nextPanelId: string) {
				if (nextPanelId === panelId) return;
				treeSvgEls.delete(panelId);
				panelId = nextPanelId;
				treeSvgEls.set(panelId, node);
				scheduleTreeLineRefresh();
			},
			destroy() {
				treeSvgEls.delete(panelId);
				scheduleTreeLineRefresh();
			}
		};
	}

	// Layout
	let horizontal = $state(false);
	function toggleLayout() {
		horizontal = !horizontal;
		requestAnimationFrame(() => {
			computeTreeLines();
			scrollToCard(activeUri || thread.rootPost.uri);
		});
	}

	// Zoom
	let zoom = $state(1);
	let zoomInput = $state('100');
	const ZOOM_MIN = 0.2;
	const ZOOM_MAX = 1.5;
	const ZOOM_STEP = 0.15;

	function zoomIn() { zoom = Math.min(ZOOM_MAX, zoom + ZOOM_STEP); }
	function zoomOut() { zoom = Math.max(ZOOM_MIN, zoom - ZOOM_STEP); }
	function zoomReset() { zoom = 1; }

	function syncZoomInput() {
		zoomInput = String(Math.round(zoom * 100));
	}

	function applyZoomInput() {
		const parsed = Number.parseFloat(zoomInput.trim());
		if (!Number.isFinite(parsed)) {
			syncZoomInput();
			return;
		}

		zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, parsed / 100));
		syncZoomInput();
	}

	function handleZoomInputKeydown(event: KeyboardEvent) {
		if (event.key === 'Enter') {
			event.preventDefault();
			applyZoomInput();
			(event.currentTarget as HTMLInputElement | null)?.blur();
			return;
		}

		if (event.key === 'Escape') {
			event.preventDefault();
			syncZoomInput();
			(event.currentTarget as HTMLInputElement | null)?.blur();
		}
	}

	// Panning
	let isPanning = $state(false);
	let panStart = { x: 0, y: 0, scrollLeft: 0, scrollTop: 0 };
	const boardInteractiveSelector = [
		'.index-card',
		'button',
		'a',
		'input',
		'label',
		'textarea',
		'.board-controls-left',
		'.board-controls-right',
		'.board-search-panel',
		'.atlas-mini-stack',
		'.minimap',
		'.tree-toolbar'
	].join(', ');

	function handleBoardPointerDown(e: PointerEvent) {
		const target = e.target as HTMLElement;
		if (e.button === 1 || (e.button === 0 && !target.closest(boardInteractiveSelector))) {
			e.preventDefault();
			isPanning = true;
			panStart = { x: e.clientX, y: e.clientY, scrollLeft: boardEl!.scrollLeft, scrollTop: boardEl!.scrollTop };
			boardEl!.setPointerCapture(e.pointerId);
		}
	}

	function handleBoardPointerMove(e: PointerEvent) {
		if (!isPanning || !boardEl) return;
		boardEl.scrollLeft = panStart.scrollLeft - (e.clientX - panStart.x);
		boardEl.scrollTop = panStart.scrollTop - (e.clientY - panStart.y);
	}

	function handleBoardPointerUp(e: PointerEvent) {
		if (isPanning) {
			isPanning = false;
			boardEl?.releasePointerCapture(e.pointerId);
		}
	}

	// Minimap
	let minimapEl: HTMLDivElement | undefined = $state();
	let minimapCanvas: HTMLCanvasElement | undefined = $state();
	let minimapScale = $state(0.05);
	let minimapW = $state(120);
	let minimapH = $state(80);
	let minimapDragging = $state(false);
	let minimapViewport = $state({ x: 0, y: 0, w: 0, h: 0 });

		function updateMinimap() {
			if (!boardEl || !minimapCanvas) return;
		const sw = boardEl.scrollWidth;
		const sh = boardEl.scrollHeight;
		const cw = boardEl.clientWidth;
		const ch = boardEl.clientHeight;

		const maxW = 320;
		const maxH = 240;
		minimapScale = Math.min(maxW / sw, maxH / sh, 0.15);
		minimapW = Math.max(sw * minimapScale, 120);
		minimapH = Math.max(sh * minimapScale, 80);

		minimapViewport = {
			x: boardEl.scrollLeft * minimapScale,
			y: boardEl.scrollTop * minimapScale,
			w: cw * minimapScale,
			h: ch * minimapScale
		};

		const dpr = window.devicePixelRatio || 1;
		minimapCanvas.width = minimapW * dpr;
		minimapCanvas.height = minimapH * dpr;
		minimapCanvas.style.width = minimapW + 'px';
		minimapCanvas.style.height = minimapH + 'px';

		const ctx = minimapCanvas.getContext('2d');
		if (!ctx) return;
		const canvasCtx = ctx;
		canvasCtx.scale(dpr, dpr);
		canvasCtx.clearRect(0, 0, minimapW, minimapH);

		const boardRect = boardEl.getBoundingClientRect();
		const cards = boardEl.querySelectorAll<HTMLElement>('.index-card[data-uri]');

		const cardRects = new Map<string, { x: number; y: number; w: number; h: number }>();
		cards.forEach(card => {
			const r = card.getBoundingClientRect();
			const x = (r.left - boardRect.left + boardEl!.scrollLeft) * minimapScale;
			const y = (r.top - boardRect.top + boardEl!.scrollTop) * minimapScale;
			const w = r.width * minimapScale;
			const h = r.height * minimapScale;
			const uri = card.getAttribute('data-uri');
			if (uri) cardRects.set(uri, { x, y, w, h });
		});

		// Draw lines
		canvasCtx.strokeStyle = '#cc0000';
		canvasCtx.lineWidth = 1;
		canvasCtx.globalAlpha = 0.5;
		function drawLines(post: ThreadPost, panelId: string) {
			const pR = cardRects.get(post.uri);
			if (!pR) return;
			for (const child of getTreeChildren(panelId, post)) {
				const cR = cardRects.get(child.uri);
				if (!cR) continue;
				canvasCtx.beginPath();
				if (horizontal) {
					canvasCtx.moveTo(pR.x + pR.w, pR.y + pR.h / 2);
					canvasCtx.lineTo(cR.x, cR.y + cR.h / 2);
				} else {
					canvasCtx.moveTo(pR.x + pR.w / 2, pR.y + pR.h);
					canvasCtx.lineTo(cR.x + cR.w / 2, cR.y);
				}
				canvasCtx.stroke();
				drawLines(child, panelId);
			}
		}
		for (const { panelId, rootPost } of getRenderableTrees()) {
			drawLines(rootPost, panelId);
		}
		canvasCtx.globalAlpha = 1;

		// Draw card rectangles
		cards.forEach(card => {
			const uri = card.getAttribute('data-uri');
			const cr = uri ? cardRects.get(uri) : null;
			if (!cr) return;

			const isActive = uri === activeUri;
			const isBranch = postOrder.find(p => p.uri === uri)?.children.length! > 1;

			if (isActive) {
				canvasCtx.fillStyle = '#cc0000';
				canvasCtx.globalAlpha = 0.9;
			} else if (isBranch) {
				canvasCtx.fillStyle = '#e07a5f';
				canvasCtx.globalAlpha = 0.8;
			} else {
				canvasCtx.fillStyle = '#fdf5e6';
				canvasCtx.globalAlpha = 0.85;
			}
			canvasCtx.fillRect(cr.x, cr.y, cr.w, cr.h);

			canvasCtx.globalAlpha = 0.6;
			canvasCtx.strokeStyle = isActive ? '#cc0000' : '#a09070';
			canvasCtx.lineWidth = isActive ? 1.5 : 0.5;
			canvasCtx.strokeRect(cr.x, cr.y, cr.w, cr.h);
			canvasCtx.globalAlpha = 1;
		});
	}

	function minimapClickAt(clientX: number, clientY: number) {
		if (!boardEl || !minimapEl) return;
		const rect = minimapEl.getBoundingClientRect();
		const mx = clientX - rect.left;
		const my = clientY - rect.top;
		boardEl.scrollTo({
			left: (mx - minimapViewport.w / 2) / minimapScale,
			top: (my - minimapViewport.h / 2) / minimapScale,
			behavior: minimapDragging ? 'auto' : 'smooth'
		});
	}

	function handleMinimapClick(e: MouseEvent) {
		minimapClickAt(e.clientX, e.clientY);
	}

	function handleMinimapDragStart(e: MouseEvent) {
		minimapDragging = true;
		minimapClickAt(e.clientX, e.clientY);
	}

	function handleMinimapDrag(e: MouseEvent) {
		if (!minimapDragging) return;
		minimapClickAt(e.clientX, e.clientY);
	}

		// Navigation state
		let postOrder = $derived.by(() => {
			if (!thread?.rootPost) return [];
			return buildVisiblePostOrder(thread.rootPost, collapsedBranches);
		});

	let branchPoints = $derived.by(() => {
		return buildBranchPoints(postOrder);
	});
	let parentMap = $derived.by(() => {
		if (!thread?.rootPost) return new Map<string, ThreadPost>();
		return buildParentMap(thread.rootPost);
	});
	let selectedUri = $state('');
	let activeUri = $derived.by(() => {
		if (!postOrder.length) return '';
		return postOrder.some((post) => post.uri === selectedUri) ? selectedUri : postOrder[0].uri;
	});

		function buildBranchPoints(posts: ThreadPost[]): number[] {
			const indices: number[] = [];
		for (let i = 0; i < posts.length; i++) {
			if (posts[i].children.length > 1) indices.push(i);
		}
		return indices;
	}

	const SCROLL_DURATION = 250; // ms — adjust to taste

	function smoothScrollTo(el: HTMLElement, targetLeft: number, targetTop: number, duration: number) {
		const startLeft = el.scrollLeft;
		const startTop = el.scrollTop;
		const dx = targetLeft - startLeft;
		const dy = targetTop - startTop;
		const start = performance.now();

		function step(now: number) {
			const t = Math.min((now - start) / duration, 1);
			const ease = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2; // easeInOutQuad
			el.scrollLeft = startLeft + dx * ease;
			el.scrollTop = startTop + dy * ease;
			if (t < 1) requestAnimationFrame(step);
		}
		requestAnimationFrame(step);
	}

	function scrollToCard(uri: string) {
		if (!boardEl) return;
		const card = boardEl.querySelector<HTMLElement>(`.index-card[data-uri="${CSS.escape(uri)}"]`);
		if (!card) return;

		const boardRect = boardEl.getBoundingClientRect();
		const cardRect = card.getBoundingClientRect();

		const scrollLeft = boardEl.scrollLeft + (cardRect.left + cardRect.width / 2) - (boardRect.left + boardRect.width / 2);
		const scrollTop = boardEl.scrollTop + (cardRect.top + cardRect.height / 2) - (boardRect.top + boardRect.height / 2);

		smoothScrollTo(boardEl, scrollLeft, scrollTop, SCROLL_DURATION);
	}

		function navigateTo(index: number) {
			if (index >= 0 && index < postOrder.length) {
				selectedUri = postOrder[index].uri;
				scrollToCard(postOrder[index].uri);
			}
		}

	function navigatePrev(postUri: string) {
		const idx = postOrder.findIndex(p => p.uri === postUri);
		if (idx > 0) navigateTo(idx - 1);
	}

	function navigateNext(postUri: string) {
		const idx = postOrder.findIndex(p => p.uri === postUri);
		if (idx >= 0 && idx < postOrder.length - 1) navigateTo(idx + 1);
	}

	function navigateToBranch(postUri: string) {
		let current = postUri;
		while (current) {
			const parent = parentMap.get(current);
			if (!parent) break;
			if (parent.children.length > 1) {
				navigateTo(getPostIndex(parent.uri));
				return;
			}
			current = parent.uri;
		}
		navigateTo(0);
	}

	function hasBranches(): boolean {
		return branchPoints.length > 0;
	}

	function getPostIndex(uri: string): number {
		return postOrder.findIndex(p => p.uri === uri);
	}

	function formatDate(iso: string): string {
		const d = new Date(iso);
		return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
	}

	function formatCount(n: number): string {
		if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
		return n.toString();
	}

	function normalizeSearchQuery(value: string): string {
		return value.trim().toLowerCase();
	}

	function buildMatchLookup(posts: ThreadPost[]): Record<string, boolean> {
		return Object.fromEntries(posts.map((post) => [post.uri, true]));
	}

	function nextSearchIndex(previousQuery: string, nextQuery: string, previousIndex: number, matchCount: number): number {
		if (previousQuery !== nextQuery) {
			return 0;
		}

		return (previousIndex + 1) % matchCount;
	}

	function splitHighlightedText(text: string, query: string): HighlightSegment[] {
		if (!query) {
			return [{ text, match: false }];
		}

		const lowerText = text.toLowerCase();
		const segments: HighlightSegment[] = [];
		let start = 0;

		while (start < text.length) {
			const matchIndex = lowerText.indexOf(query, start);
			if (matchIndex === -1) {
				segments.push({ text: text.slice(start), match: false });
				break;
			}

			if (matchIndex > start) {
				segments.push({ text: text.slice(start, matchIndex), match: false });
			}

			segments.push({
				text: text.slice(matchIndex, matchIndex + query.length),
				match: true
			});
			start = matchIndex + query.length;
		}

		return segments.length ? segments : [{ text, match: false }];
	}

	function isAuthorSearchMatch(post: ThreadPost): boolean {
		return authorMatchLookup[post.uri] ?? false;
	}

	function isTextSearchMatch(post: ThreadPost): boolean {
		return textMatchLookup[post.uri] ?? false;
	}

	function getTextHighlightSegments(post: ThreadPost): HighlightSegment[] {
		if (!isTextSearchMatch(post)) {
			return [{ text: post.text, match: false }];
		}

		return splitHighlightedText(post.text, textMatchQuery);
	}

	async function focusSearchMatch(post: ThreadPost, message: string, postUrisToReveal: string[] = [post.uri]) {
		collapsedBranches = revealCollapsedPaths(postUrisToReveal, parentMap, collapsedBranches);
		selectedUri = post.uri;
		searchMessage = message;
		searchStatus = 'success';
		await tick();
		computeTreeLines();
		scrollToCard(post.uri);
	}

	function setSearchError(message: string) {
		searchMessage = message;
		searchStatus = 'error';
	}

	async function searchAuthor() {
		const rawQuery = authorSearch.trim();
		const query = normalizeSearchQuery(authorSearch);
		if (!query) {
			setSearchError('Enter an author to search.');
			return;
		}

		const matches = findMatchingPosts(thread.rootPost, (post) => {
			const handle = post.author.handle.toLowerCase();
			const displayName = post.author.displayName?.toLowerCase() ?? '';
			return handle.includes(query) || displayName.includes(query);
		});

		if (!matches.length) {
			authorMatchLookup = {};
			authorMatchQuery = query;
			authorMatchIndex = -1;
			setSearchError(`Author "${rawQuery}" not found.`);
			return;
		}

		const nextIndex = nextSearchIndex(authorMatchQuery, query, authorMatchIndex, matches.length);
		const match = matches[nextIndex];
		const matchedUris = matches.map((post) => post.uri);

		authorMatchLookup = buildMatchLookup(matches);
		authorMatchQuery = query;
		authorMatchIndex = nextIndex;

		await focusSearchMatch(
			match,
			`Found ${matches.length} author matches (${nextIndex + 1}/${matches.length}).`,
			matchedUris
		);
	}

	async function searchText() {
		const rawQuery = textSearch.trim();
		const query = normalizeSearchQuery(textSearch);
		if (!query) {
			setSearchError('Enter text to search.');
			return;
		}

		const matches = findMatchingPosts(
			thread.rootPost,
			(post) => post.text.toLowerCase().includes(query)
		);

		if (!matches.length) {
			textMatchLookup = {};
			textMatchQuery = query;
			textMatchIndex = -1;
			setSearchError(`Text "${rawQuery}" not found.`);
			return;
		}

		const nextIndex = nextSearchIndex(textMatchQuery, query, textMatchIndex, matches.length);
		const match = matches[nextIndex];

		textMatchLookup = buildMatchLookup(matches);
		textMatchQuery = query;
		textMatchIndex = nextIndex;

		await focusSearchMatch(match, `Found ${matches.length} text matches (${nextIndex + 1}/${matches.length}).`);
	}

	function handleSearchKey(event: KeyboardEvent, mode: 'author' | 'text') {
		if (event.key !== 'Enter') return;
		event.preventDefault();
		if (mode === 'author') {
			void searchAuthor();
			return;
		}
		void searchText();
	}

	function getRenderedChildren(post: ThreadPost): ThreadPost[] {
		return getVisibleChildren(post, collapsedBranches);
	}

	function branchCollapsed(post: ThreadPost): boolean {
		return isBranchCollapsed(post.uri, collapsedBranches);
	}

	function canCollapseBranch(post: ThreadPost): boolean {
		if (post.uri === thread.rootPost.uri) return false;
		return (parentMap.get(post.uri)?.children.length ?? 0) > 1;
	}

	async function setBranchCollapsed(postUri: string, collapsed: boolean) {
		if (isBranchCollapsed(postUri, collapsedBranches) === collapsed) return;

			const nextCollapsedBranches = { ...collapsedBranches };
			if (collapsed) {
				nextCollapsedBranches[postUri] = true;
			} else {
				delete nextCollapsedBranches[postUri];
			}

			collapsedBranches = nextCollapsedBranches;
			const focusUri = collapsed ? (parentMap.get(postUri)?.uri ?? thread.rootPost.uri) : postUri;
			selectedUri = focusUri;
			await tick();
			computeTreeLines();
			scrollToCard(focusUri);
		}

		async function toggleBranch(post: ThreadPost) {
			await setBranchCollapsed(post.uri, !branchCollapsed(post));
		}

		async function handleChildBranchClick(child: ThreadPost) {
			if (isBranchCollapsed(child.uri, collapsedBranches)) {
				await setBranchCollapsed(child.uri, false);
			}
			navigateTo(getPostIndex(child.uri));
		}

		function postUrl(uri: string, handle: string): string {
			return platform.buildPostUrl(uri, handle);
		}

	function countPosts(post: ThreadPost): number {
		let count = 1;
		for (const child of post.children) {
			count += countPosts(child);
		}
		return count;
	}

	function isReadyQuoteThreadEntry(
		entry: QuoteThreadEntry
	): entry is ReadyQuoteThreadEntry {
		return entry.status === 'ready' && Boolean(entry.thread);
	}

	let loadedQuoteThreads = $derived.by(() => {
		return Object.values(quoteThreads)
			.filter(isReadyQuoteThreadEntry)
			.sort((a, b) => a.loadedAt - b.loadedAt);
	});

	let quoteTreeChildrenBySource = $derived.by(() => {
		const grouped: Record<string, ReadyQuoteThreadEntry[]> = {};
		for (const entry of loadedQuoteThreads) {
			const key = entry.sourcePanelUri ?? MAIN_TREE_PANEL_ID;
			(grouped[key] ??= []).push(entry);
		}
		return grouped;
	});

	function getSpawnedTreeChildren(panelId: string): ReadyQuoteThreadEntry[] {
		return quoteTreeChildrenBySource[panelId] ?? [];
	}

	function hasSpawnedTreeChildren(panelId: string): boolean {
		return getSpawnedTreeChildren(panelId).length > 0;
	}

	function getRenderableTrees(): Array<{ panelId: string; rootPost: ThreadPost }> {
		return [
			{ panelId: MAIN_TREE_PANEL_ID, rootPost: thread.rootPost },
			...loadedQuoteThreads.map((entry) => ({
				panelId: entry.quotedUri,
				rootPost: entry.thread.rootPost
			}))
		];
	}

	function getTreeChildren(panelId: string, post: ThreadPost): ThreadPost[] {
		return panelId === MAIN_TREE_PANEL_ID ? getRenderedChildren(post) : post.children;
	}

	function getTreeLinePath(panelId: string): string {
		return treeLinePaths[panelId] ?? '';
	}

	function getQuoteThreadEntry(post: ThreadPost): QuoteThreadEntry | undefined {
		const quotedUri = post.embed?.record?.uri;
		return quotedUri ? quoteThreads[quotedUri] : undefined;
	}

	function getQuoteActionLabel(post: ThreadPost): string {
		const entry = getQuoteThreadEntry(post);
		if (!entry) return 'Fetch thread';
		if (entry.status === 'loading') return 'Loading...';
		if (entry.status === 'ready') return 'Teleport';
		return 'Retry';
	}

	function getQuoteActionTitle(post: ThreadPost): string {
		const entry = getQuoteThreadEntry(post);
		if (!entry) return 'Fetch the quoted post thread into the board as another tree';
		if (entry.status === 'loading') return 'Fetching the quoted thread';
		if (entry.status === 'ready') return 'Jump to the spawned quoted tree';
		return 'Retry fetching the quoted thread';
	}

	function getQuoteStatusMessage(post: ThreadPost): string {
		const entry = getQuoteThreadEntry(post);
		if (!entry) return '';
		if (entry.status === 'error') {
			return entry.error || 'Could not load this quoted thread.';
		}
		if (entry.status === 'ready') {
			return 'Spawned on the board.';
		}
		return '';
	}

	function getQuotedHandle(entry: QuoteThreadEntry): string {
		return entry.quotedHandle || entry.thread?.rootPost.author.handle || 'unknown';
	}

	function collectQuoteThreadFamily(rootQuotedUri: string): Set<string> {
		const family = new Set<string>([rootQuotedUri]);
		let foundDescendant = true;
		while (foundDescendant) {
			foundDescendant = false;
			for (const entry of Object.values(quoteThreads)) {
				if (
					entry.sourcePanelUri &&
					family.has(entry.sourcePanelUri) &&
					!family.has(entry.quotedUri)
				) {
					family.add(entry.quotedUri);
					foundDescendant = true;
				}
			}
		}
		return family;
	}

	async function focusQuoteThreadTree(quotedUri: string) {
		activeQuoteUri = quotedUri;
		await tick();
		const panel =
			boardEl?.querySelector<HTMLElement>(
				`.spawned-tree-cluster[data-tree-panel="${CSS.escape(quotedUri)}"]`
			) ?? null;
		computeTreeLines();
		panel?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
	}

	async function handleQuoteThreadAction(post: ThreadPost, sourcePanelUri: string | null = null) {
		const record = post.embed?.record;
		if (!record?.uri) return;

		const baseEntry: QuoteThreadEntry = {
			quotedUri: record.uri,
			quotedHandle: record.author.handle || '',
			sourceUri: post.uri,
			sourcePanelUri: sourcePanelUri ?? undefined,
			loadedAt: quoteThreads[record.uri]?.loadedAt ?? Date.now(),
			status: 'loading'
		};

		const existing = quoteThreads[record.uri];
		if (existing?.status === 'loading') {
			return;
		}

		if (existing?.status === 'ready') {
			await focusQuoteThreadTree(record.uri);
			return;
		}

		quoteThreads = {
			...quoteThreads,
			[record.uri]: baseEntry
		};

		try {
			const loadThread = platform.loadThread;
			if (!loadThread) {
				throw new Error(`Quoted thread loading is unavailable for ${platform.name}.`);
			}
			const quotedThread = await loadThread(record.uri);
			quoteThreads = {
				...quoteThreads,
				[record.uri]: {
					...baseEntry,
					status: 'ready',
					thread: quotedThread,
					error: undefined
				}
			};
			await focusQuoteThreadTree(record.uri);
		} catch (error) {
			quoteThreads = {
				...quoteThreads,
				[record.uri]: {
					...baseEntry,
					status: 'error',
					error: error instanceof Error ? error.message : 'Could not load this quoted thread.'
				}
			};
		}
	}

	function jumpToQuoteSource(quotedUri: string) {
		const entry = quoteThreads[quotedUri];
		if (!entry) return;
		if (entry.sourcePanelUri) {
			void focusQuoteThreadTree(entry.sourcePanelUri);
			return;
		}
		if (!entry.sourceUri) return;
		activeQuoteUri = quotedUri;
		selectedUri = entry.sourceUri;
		scrollToCard(entry.sourceUri);
	}

	function closeQuoteThread(quotedUri: string) {
		const quoteThreadFamily = collectQuoteThreadFamily(quotedUri);
		const nextQuoteThreads = { ...quoteThreads };
		for (const uri of quoteThreadFamily) {
			delete nextQuoteThreads[uri];
		}
		quoteThreads = nextQuoteThreads;
		if (quoteThreadFamily.has(activeQuoteUri)) {
			activeQuoteUri = '';
		}
		scheduleTreeLineRefresh();
	}

	function computeTreeLines() {
		const renderableTrees = getRenderableTrees();
		const renderablePanelIds = new Set(renderableTrees.map(({ panelId }) => panelId));
		const nextTreeLinePaths: Record<string, string> = Object.fromEntries(
			Object.entries(treeLinePaths).filter(([panelId]) => renderablePanelIds.has(panelId))
		);

		for (const { panelId, rootPost } of renderableTrees) {
			const treeContainerEl = treeContainerEls.get(panelId);
			const svgEl = treeSvgEls.get(panelId);
			if (!treeContainerEl || !svgEl) {
				nextTreeLinePaths[panelId] ??= '';
				continue;
			}

			const sw = treeContainerEl.scrollWidth;
			const sh = treeContainerEl.scrollHeight;
			svgEl.setAttribute('width', String(sw));
			svgEl.setAttribute('height', String(sh));
			svgEl.style.width = sw + 'px';
			svgEl.style.height = sh + 'px';

			const cards = treeContainerEl.querySelectorAll<HTMLElement>('.index-card[data-uri]');
			if (cards.length < 2) {
				nextTreeLinePaths[panelId] = '';
				continue;
			}

			const treeRect = treeContainerEl.getBoundingClientRect();
			let path = '';
			const uriToEl = new Map<string, HTMLElement>();
			cards.forEach((card) => {
				const uri = card.getAttribute('data-uri');
				if (uri) uriToEl.set(uri, card);
			});

			function walkTree(post: ThreadPost) {
				const parentEl = uriToEl.get(post.uri);
				if (!parentEl) return;

				for (const child of getTreeChildren(panelId, post)) {
					const childEl = uriToEl.get(child.uri);
					if (!childEl) continue;

					const pRect = parentEl.getBoundingClientRect();
					const cRect = childEl.getBoundingClientRect();

					let x1: number;
					let y1: number;
					let x2: number;
					let y2: number;
					if (horizontal) {
						x1 = (pRect.right - treeRect.left) / zoom;
						y1 = (pRect.top + pRect.height / 2 - treeRect.top) / zoom;
						x2 = (cRect.left + 2 - treeRect.left) / zoom;
						y2 = (cRect.top + cRect.height / 2 - treeRect.top) / zoom;
					} else {
						x1 = (pRect.left + pRect.width / 2 - treeRect.left) / zoom;
						y1 = (pRect.bottom - treeRect.top) / zoom;
						x2 = (cRect.left + cRect.width / 2 - treeRect.left) / zoom;
						y2 = (cRect.top + 2 - treeRect.top) / zoom;
					}

					const mx = (x1 + x2) / 2;
					const my = (y1 + y2) / 2;
					path += `M${x1},${y1} Q${mx},${my} ${x2},${y2} `;

					walkTree(child);
				}
			}

			walkTree(rootPost);
			nextTreeLinePaths[panelId] = path;
		}

		treeLinePaths = nextTreeLinePaths;
		updateMinimap();
	}

	function handleBoardScroll() {
		scheduleTreeLineRefresh();
	}

		function handleCardClick(e: Event, post: ThreadPost) {
			e.preventDefault();
			selectedUri = post.uri;
			scrollToCard(post.uri);
		}

	$effect(() => {
		const rootUri = thread?.rootPost?.uri;
		if (!rootUri) return;
		collapsedBranches = {};
		selectedUri = initialActiveUri || rootUri;
		activeQuoteUri = '';
		quoteThreads = {};
		treeLinePaths = {};
		searchMessage = '';
		searchStatus = '';
		authorMatchLookup = {};
		authorMatchQuery = '';
		authorMatchIndex = -1;
		textMatchLookup = {};
		textMatchQuery = '';
		textMatchIndex = -1;
	});

	$effect(() => {
		zoom;
		syncZoomInput();
	});

	$effect(() => {
		loadedQuoteThreads;
		if (!boardEl) return;
		let cancelled = false;
		const frame = requestAnimationFrame(async () => {
			await tick();
			if (!cancelled) {
				computeTreeLines();
			}
		});
		return () => {
			cancelled = true;
			cancelAnimationFrame(frame);
		};
	});

	$effect(() => {
		if (thread && boardEl) {
			const focusUri = initialActiveUri || thread.rootPost.uri;
			const frame = requestAnimationFrame(() => {
				computeTreeLines();
				scrollToCard(focusUri);
			});
			const observer = new ResizeObserver(() => {
				requestAnimationFrame(() => computeTreeLines());
			});
				observer.observe(boardEl);

				return () => {
					cancelAnimationFrame(frame);
					observer.disconnect();
				};
			}
		});

	onMount(() => {
		function onMouseUp() { minimapDragging = false; }
		function onMouseMove(e: MouseEvent) { if (minimapDragging) handleMinimapDrag(e); }
		window.addEventListener('mouseup', onMouseUp);
		window.addEventListener('mousemove', onMouseMove);
		return () => {
			window.removeEventListener('mouseup', onMouseUp);
			window.removeEventListener('mousemove', onMouseMove);
		};
	});
</script>

	{#snippet renderQuoteEmbed(post: ThreadPost, sourcePanelUri: string | null)}
		{#if post.embed?.record}
			{@const quoteState = getQuoteThreadEntry(post)}
			<div class="card-quote-embed">
				<div class="quote-author">
					{#if post.embed.record.author.avatar}
						<img src={post.embed.record.author.avatar} alt="" class="quote-avatar" />
					{/if}
					<span class="quote-handle">@{post.embed.record.author.handle}</span>
				</div>
				{#if post.embed.record.text}
					<p class="quote-text">{post.embed.record.text}</p>
				{:else}
					<p class="quote-text quote-text-muted">Quoted post preview is still sparse.</p>
				{/if}
				{#if post.embed.record.images}
					<div class="card-images">
						{#each post.embed.record.images as img}
							<button
								type="button"
								class="image-lightbox-btn"
								onclick={(event) => {
									event.stopPropagation();
									openLightbox(img.fullsize);
								}}
							>
								<img src={img.thumb} alt={img.alt} class="card-img" />
							</button>
						{/each}
					</div>
				{/if}
				{#if post.embed.record.video}
					<video
						class="card-video quote-video"
						controls
						playsinline
						preload="metadata"
						poster={post.embed.record.video.thumbnail}
						aria-label={post.embed.record.video.alt || `Video by @${post.embed.record.author.handle}`}
						onclick={(event) => event.stopPropagation()}
						onpointerdown={(event) => event.stopPropagation()}
					>
						<source src={post.embed.record.video.playlist} type="application/x-mpegURL" />
					</video>
				{/if}
				{#if post.embed.record.uri}
					<div class="quote-actions">
						<button
							type="button"
							class="quote-thread-btn"
							class:quote-thread-btn-ready={quoteState?.status === 'ready'}
							class:quote-thread-btn-error={quoteState?.status === 'error'}
							disabled={quoteState?.status === 'loading'}
							title={getQuoteActionTitle(post)}
							onclick={(event) => {
								event.stopPropagation();
								void handleQuoteThreadAction(post, sourcePanelUri);
							}}
						>
							{getQuoteActionLabel(post)}
						</button>
						{#if getQuoteStatusMessage(post)}
							<span
								class="quote-thread-status"
								class:quote-thread-status-error={quoteState?.status === 'error'}
							>
								{getQuoteStatusMessage(post)}
							</span>
						{/if}
					</div>
				{/if}
			</div>
		{/if}
	{/snippet}

	{#snippet renderSpawnTreeNode(post: ThreadPost, sourcePanelUri: string)}
		<div class="tree-node spawn-tree-node">
			<article class="index-card spawn-tree-card" data-uri={post.uri}>
				<div class="card-author">
					{#if post.author.avatar}
						<img src={post.author.avatar} alt="" class="card-avatar" />
					{/if}
					<span class="card-handle">@{post.author.handle}</span>
				</div>
				<p class="card-text spawn-tree-text">{post.text}</p>
				{#if post.embed?.images}
					<div class="card-images">
						{#each post.embed.images as img}
							<button type="button" class="image-lightbox-btn" onclick={() => openLightbox(img.fullsize)}>
								<img src={img.thumb} alt={img.alt} class="card-img" />
							</button>
						{/each}
					</div>
				{/if}
				{#if post.embed?.video}
					<video
						class="card-video"
						controls
						playsinline
						preload="metadata"
						poster={post.embed.video.thumbnail}
						aria-label={post.embed.video.alt || `Video by @${post.author.handle}`}
						onclick={(event) => event.stopPropagation()}
						onpointerdown={(event) => event.stopPropagation()}
					>
						<source src={post.embed.video.playlist} type="application/x-mpegURL" />
					</video>
				{/if}
				{#if post.embed?.external}
					<div class="card-link-embed">
						{#if post.embed.external.thumb}
							<img src={post.embed.external.thumb} alt="" class="link-thumb" />
						{/if}
						<div class="link-info">
							<span class="link-title">{post.embed.external.title}</span>
							<span class="link-desc">{post.embed.external.description}</span>
						</div>
					</div>
				{/if}
				{@render renderQuoteEmbed(post, sourcePanelUri)}
				<LinkedPostEmbeds
					text={post.text}
					externalUri={post.embed?.external?.uri}
					urls={post.linkedUrls ?? []}
					excludeUris={[post.uri, post.embed?.record?.uri ?? '']}
				/>
				<div class="card-footer quote-thread-footer">
					<span class="card-date">{formatDate(post.createdAt)}</span>
					<div class="card-stats">
						<span title="Replies">{formatCount(post.replyCount)}</span>
						<span title="Reposts">{formatCount(post.repostCount)}</span>
						<span title="Likes">{formatCount(post.likeCount)}</span>
					</div>
					<a href={postUrl(post.uri, post.author.handle)} target="_blank" rel="noopener" class="bsky-link">Open</a>
				</div>
			</article>
			{#if post.children.length > 0}
				<div class="tree-children spawn-tree-children">
					{#each post.children as child}
						{@render renderSpawnTreeNode(child, sourcePanelUri)}
					{/each}
				</div>
			{/if}
		</div>
	{/snippet}

	{#snippet renderNode(post: ThreadPost, depth: number)}
		<div class="tree-node">
			<div
				class="index-card"
				class:active-card={post.uri === activeUri}
				class:author-match-card={isAuthorSearchMatch(post)}
				class:text-match-card={isTextSearchMatch(post)}
				data-uri={post.uri}
				role="button"
				tabindex="0"
				onclick={(e) => {
					if (!(e.target as HTMLElement).closest('.card-nav, button, a, video')) handleCardClick(e, post);
				}}
				onkeydown={(e) => {
					if (e.key === 'Enter' && !(e.target as HTMLElement).closest('.card-nav, button, a, video')) {
						handleCardClick(e, post);
					}
				}}
		>
			<div class="pushpin"></div>
			<div class="card-author">
				{#if post.author.avatar}
					<img src={post.author.avatar} alt="" class="card-avatar" />
				{/if}
				<span class="card-handle" class:card-handle-match={isAuthorSearchMatch(post)}>
					@{post.author.handle}
				</span>
			</div>
			<p class="card-text">
				{#each getTextHighlightSegments(post) as segment}
					{#if segment.match}
						<mark class="card-text-highlight">{segment.text}</mark>
					{:else}
						{segment.text}
					{/if}
				{/each}
			</p>
			{#if post.embed?.images}
				<div class="card-images">
					{#each post.embed.images as img}
						<button
							type="button"
							class="image-lightbox-btn"
							onclick={(event) => {
								event.stopPropagation();
								openLightbox(img.fullsize);
							}}
						>
							<img src={img.thumb} alt={img.alt} class="card-img" />
						</button>
					{/each}
				</div>
			{/if}
			{#if post.embed?.video}
				<video
					class="card-video"
					controls
					playsinline
					preload="metadata"
					poster={post.embed.video.thumbnail}
					aria-label={post.embed.video.alt || `Video by @${post.author.handle}`}
					onclick={(event) => event.stopPropagation()}
					onpointerdown={(event) => event.stopPropagation()}
				>
					<source src={post.embed.video.playlist} type="application/x-mpegURL" />
				</video>
			{/if}
			{#if post.embed?.external}
				<div class="card-link-embed">
					{#if post.embed.external.thumb}
						<img src={post.embed.external.thumb} alt="" class="link-thumb" />
					{/if}
					<div class="link-info">
						<span class="link-title">{post.embed.external.title}</span>
						<span class="link-desc">{post.embed.external.description}</span>
					</div>
				</div>
			{/if}
			{@render renderQuoteEmbed(post, null)}
			<LinkedPostEmbeds
				text={post.text}
				externalUri={post.embed?.external?.uri}
				urls={post.linkedUrls ?? []}
				excludeUris={[post.uri, post.embed?.record?.uri ?? '']}
			/>
			<div class="card-footer">
				<span class="card-date">{formatDate(post.createdAt)}</span>
				<div class="card-stats">
					<span title="Replies">{formatCount(post.replyCount)}</span>
					<span title="Reposts">{formatCount(post.repostCount)}</span>
					<span title="Likes">{formatCount(post.likeCount)}</span>
				</div>
				<a href={postUrl(post.uri, post.author.handle)} target="_blank" rel="noopener"
				   class="bsky-link" onclick={(e) => e.stopPropagation()}>Open</a>
			</div>
				<div class="card-nav" role="toolbar" tabindex="-1" onclick={(e) => e.stopPropagation()} onkeydown={(e) => e.stopPropagation()}>
					<button
						class="card-nav-btn"
						disabled={getPostIndex(post.uri) <= 0}
						onclick={() => navigatePrev(post.uri)}
						title="Previous post"
					>&larr;</button>
					<span class="card-nav-counter">{getPostIndex(post.uri) + 1}/{postOrder.length}</span>
					{#if canCollapseBranch(post)}
						<button
							class="card-nav-btn collapse-btn"
							onclick={() => toggleBranch(post)}
							title="Collapse this branch"
						>Collapse</button>
					{/if}
					{#if hasBranches()}
						<button
							class="card-nav-btn branch-btn"
							onclick={() => navigateToBranch(post.uri)}
							title="Jump to parent fork point"
					>Fork</button>
				{/if}
					<button
						class="card-nav-btn"
						disabled={getPostIndex(post.uri) >= postOrder.length - 1}
						onclick={() => navigateNext(post.uri)}
						title="Next post"
					>&rarr;</button>
				</div>
				{#if post.children.length > 1}
					<div class="card-children-nav" role="toolbar" tabindex="-1" onclick={(e) => e.stopPropagation()} onkeydown={(e) => e.stopPropagation()}>
						<span class="children-label">Branches:</span>
						{#each post.children as child, i}
							<button
								class="card-nav-btn child-btn"
								class:active-child={child.uri === activeUri}
								class:collapsed-child={isBranchCollapsed(child.uri, collapsedBranches)}
								onclick={() => handleChildBranchClick(child)}
								title={
									isBranchCollapsed(child.uri, collapsedBranches)
										? `Expand ${child.text?.slice(0, 60) || `Branch ${i + 1}`}`
										: child.text?.slice(0, 60) || `Branch ${i + 1}`
								}
							>{isBranchCollapsed(child.uri, collapsedBranches) ? '+' : i + 1}</button>
						{/each}
					</div>
				{/if}
			</div>
			{#if getRenderedChildren(post).length > 0}
				<div class="tree-children">
					{#each getRenderedChildren(post) as child}
						{@render renderNode(child, depth + 1)}
					{/each}
				</div>
			{/if}
		</div>
{/snippet}

	{#snippet renderTreePanel(
		panelId: string,
		rootPost: ThreadPost,
		quoteEntry: ReadyQuoteThreadEntry | null
	)}
		<div
			class="tree-stage"
			class:tree-stage-offset={hasSpawnedTreeChildren(panelId)}
			class:spawned-tree-stage={Boolean(quoteEntry)}
			class:active-tree-stage={quoteEntry?.quotedUri === activeQuoteUri}
		>
			{#if quoteEntry}
				<div class="tree-toolbar">
					{#if quoteEntry.thread.isTruncated}
						<span class="tree-chip tree-chip-muted">Truncated</span>
					{/if}
					<button
						type="button"
						class="tree-action-chip"
						onclick={() => jumpToQuoteSource(quoteEntry.quotedUri)}
					>
						Source
					</button>
					<a
						href={postUrl(quoteEntry.quotedUri, getQuotedHandle(quoteEntry))}
						target="_blank"
						rel="noopener"
						class="tree-action-chip"
					>
						Open
					</a>
					<button
						type="button"
						class="tree-action-chip tree-action-chip-close"
						onclick={() => closeQuoteThread(quoteEntry.quotedUri)}
					>
						Close
					</button>
				</div>
			{/if}
			<div
				class="tree-container"
				class:horizontal
				use:registerTreeContainer={panelId}
				style="transform: scale({zoom}); transform-origin: top left;"
			>
				<svg class="string-overlay" use:registerTreeSvg={panelId} aria-hidden="true">
					{#if getTreeLinePath(panelId)}
						<path d={getTreeLinePath(panelId)} fill="none" stroke="#cc0000" stroke-width={2 / zoom} opacity="0.7" />
					{/if}
				</svg>
				{#if quoteEntry}
					{@render renderSpawnTreeNode(rootPost, panelId)}
				{:else}
					{@render renderNode(rootPost, 0)}
				{/if}
			</div>
		</div>
	{/snippet}

	{#snippet renderSpawnedTreeCluster(entry: ReadyQuoteThreadEntry)}
		<section
			class="tree-cluster spawned-tree-cluster"
			class:active-spawned-tree-cluster={entry.quotedUri === activeQuoteUri}
			data-quote-uri={entry.quotedUri}
			data-tree-panel={entry.quotedUri}
		>
			{@render renderTreePanel(entry.quotedUri, entry.thread.rootPost, entry)}
			{#if hasSpawnedTreeChildren(entry.quotedUri)}
				<div class="spawn-children-row">
					{#each getSpawnedTreeChildren(entry.quotedUri) as child (child.quotedUri)}
						{@render renderSpawnedTreeCluster(child)}
					{/each}
				</div>
			{/if}
		</section>
	{/snippet}

<div class="board-layout">
	<div class="board-info">
		<span class="depth-badge wobbly-border">{thread.depth} deep</span>
		<span class="post-count">{countPosts(thread.rootPost)} posts</span>
		{#if loadedQuoteThreads.length > 0}
			<span class="post-count">{loadedQuoteThreads.length} spawned tree{loadedQuoteThreads.length === 1 ? '' : 's'}</span>
		{/if}
		{#if showExport}
			<ThreadExportButton {thread} compact />
		{/if}
	</div>
	<div class="board-wrapper">
		<div
			class="corkboard"
			class:panning={isPanning}
			bind:this={boardEl}
			role="application"
			aria-label="Thread board"
			onscroll={handleBoardScroll}
			onpointerdown={handleBoardPointerDown}
			onpointermove={handleBoardPointerMove}
			onpointerup={handleBoardPointerUp}
		>
			<div class="board-forest">
				<section class="tree-cluster main-tree-cluster" data-tree-panel={MAIN_TREE_PANEL_ID}>
					{@render renderTreePanel(MAIN_TREE_PANEL_ID, thread.rootPost, null)}
					{#if hasSpawnedTreeChildren(MAIN_TREE_PANEL_ID)}
						<div class="spawn-children-row">
							{#each getSpawnedTreeChildren(MAIN_TREE_PANEL_ID) as entry (entry.quotedUri)}
								{@render renderSpawnedTreeCluster(entry)}
							{/each}
						</div>
					{/if}
				</section>
			</div>
		</div>

		<div class="board-controls-left">
			<button type="button" class="zoom-btn" onclick={zoomIn} title="Zoom in">+</button>
			<label class="zoom-input-wrap" for="board-zoom-input">
				<input
					id="board-zoom-input"
					class="zoom-input"
					type="number"
					min={Math.round(ZOOM_MIN * 100)}
					max={Math.round(ZOOM_MAX * 100)}
					step="5"
					bind:value={zoomInput}
					onblur={applyZoomInput}
					onkeydown={handleZoomInputKeydown}
					aria-label="Zoom percentage"
				/>
				<span class="zoom-unit">%</span>
			</label>
			<button type="button" class="zoom-btn" onclick={zoomOut} title="Zoom out">&minus;</button>
			<button type="button" class="zoom-btn zoom-reset-btn" onclick={zoomReset} title="Reset zoom">100</button>
		</div>
		<div class="board-overlay-right">
			<div class="atlas-search-wrap">
				{#if !showSearchPanel}
					<div class="atlas-mini-stack">
						<button
							type="button"
							class="panel-reopen-btn wobbly-border-light"
							onclick={() => (showSearchPanel = true)}
						>
							Search
						</button>
					</div>
				{/if}
				{#if showSearchPanel}
					<section class="author-search board-search-panel wobbly-border-light" aria-label="Board search">
						<div class="panel-topline">
							<strong class="panel-heading">Board search</strong>
							<button
								type="button"
								class="panel-close-btn"
								aria-label="Hide board search"
								onclick={() => (showSearchPanel = false)}
							>
								&times;
							</button>
						</div>
						<div class="board-search-grid">
							<div class="board-search-group">
								<label class="board-search-label" for="board-author-search">Author</label>
								<div class="author-search-row">
									<input
										id="board-author-search"
										class="author-search-input"
										type="text"
										placeholder="Handle or display name"
										bind:value={authorSearch}
										onkeydown={(event) => handleSearchKey(event, 'author')}
									/>
									<button type="button" class="author-search-btn" onclick={searchAuthor}>Search</button>
								</div>
							</div>
							<div class="board-search-group">
								<label class="board-search-label" for="board-text-search">Text</label>
								<div class="author-search-row">
									<input
										id="board-text-search"
										class="author-search-input"
										type="text"
										placeholder="Find text in a post"
										bind:value={textSearch}
										onkeydown={(event) => handleSearchKey(event, 'text')}
									/>
									<button type="button" class="author-search-btn" onclick={searchText}>Search</button>
								</div>
							</div>
						</div>
						{#if searchMessage}
							<p
								class="atlas-search-error board-search-status wobbly-border-light"
								class:search-status-success={searchStatus === 'success'}
								class:search-status-error={searchStatus === 'error'}
							>
								{searchMessage}
							</p>
						{/if}
					</section>
				{/if}
			</div>
			<div class="board-controls-right">
				<button type="button" class="root-btn" onclick={toggleLayout} title="Toggle horizontal/vertical layout">
					{horizontal ? 'Vertical' : 'Horizontal'}
				</button>
				<button type="button" class="root-btn" onclick={() => navigateTo(0)} title="Return to root post">Root</button>
			</div>
		</div>

		<div
			class="minimap"
			bind:this={minimapEl}
			style="width: {minimapW}px; height: {minimapH}px;"
			role="button"
			tabindex="-1"
			onmousedown={handleMinimapDragStart}
			onclick={handleMinimapClick}
			onkeydown={(e) => {
				if (e.key === 'Enter') handleMinimapClick(e as any);
			}}
		>
			<canvas bind:this={minimapCanvas}></canvas>
			<div
				class="minimap-viewport"
				style="left: {minimapViewport.x}px; top: {minimapViewport.y}px; width: {minimapViewport.w}px; height: {minimapViewport.h}px;"
			></div>
		</div>
	</div>
</div>

<style>
	.board-info {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 12px;
		justify-content: center;
		margin-bottom: 16px;
	}

	.board-layout {
		width: min(1820px, calc(100vw - 24px));
		margin: 0 auto;
		display: flex;
		flex-direction: column;
		gap: 18px;
	}

	.depth-badge {
		display: inline-block;
		padding: 2px 12px;
		font-size: 0.9rem;
		background: var(--accent);
		color: white;
		border-color: var(--text-ink);
	}

	.post-count {
		font-size: 0.9rem;
		color: var(--muted);
	}

	.board-wrapper {
		position: relative;
		width: 100%;
	}

	.corkboard {
		position: relative;
		background: #e8e0cc;
		padding: 32px;
		min-height: 300px;
		border-radius: 8px;
		overflow: auto;
		max-height: 80vh;
		cursor: grab;
	}

	.corkboard.panning {
		cursor: grabbing;
		user-select: none;
	}

	.board-forest {
		--spawn-gap: 30px;
		--spawn-shift: 170px;
		display: flex;
		justify-content: center;
		width: max-content;
		min-width: 100%;
		padding-left: 48px;
		padding-right: 140px;
		padding-bottom: 120px;
	}

	.tree-cluster {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 28px;
		width: max-content;
		position: relative;
	}

	.main-tree-cluster {
		align-items: center;
	}

	.spawned-tree-cluster {
		align-items: flex-start;
	}

	.spawn-children-row {
		display: flex;
		align-items: flex-start;
		gap: var(--spawn-gap);
		width: max-content;
	}

	.tree-stage {
		position: relative;
		width: max-content;
		padding-top: 34px;
	}

	.tree-stage-offset {
		margin-left: var(--spawn-shift);
	}

	.spawned-tree-stage {
		padding-bottom: 8px;
	}

	.active-tree-stage {
		filter: drop-shadow(0 0 10px rgba(204, 0, 0, 0.18));
	}

	.tree-toolbar {
		position: absolute;
		top: 0;
		right: 0;
		z-index: 5;
		display: flex;
		flex-wrap: wrap;
		justify-content: flex-end;
		gap: 8px;
		max-width: min(100%, 320px);
	}

	.tree-chip,
	.tree-action-chip {
		padding: 5px 10px;
		border-radius: 999px;
		font-size: 0.72rem;
		font-family: 'Courier New', monospace;
		font-weight: 700;
		line-height: 1;
	}

	.tree-chip {
		border: 1px dashed rgba(185, 35, 24, 0.28);
		background: rgba(255, 244, 240, 0.88);
		color: #b42318;
	}

	.tree-chip-muted {
		backdrop-filter: blur(10px);
	}

	.tree-action-chip {
		border: 1px solid rgba(212, 197, 160, 0.96);
		background: rgba(255, 253, 246, 0.96);
		color: #24313d;
		text-decoration: none;
		cursor: pointer;
		box-shadow: 0 10px 24px rgba(26, 35, 44, 0.08);
		transition: background 0.15s, color 0.15s, border-color 0.15s;
	}

	.tree-action-chip:hover {
		background: #cc0000;
		border-color: #cc0000;
		color: white;
	}

	.tree-action-chip-close {
		border-color: rgba(185, 35, 24, 0.25);
		color: #b42318;
	}

	.string-overlay {
		position: absolute;
		top: 0;
		left: 0;
		pointer-events: none;
		z-index: 0;
		overflow: visible;
	}

	.tree-container {
		position: relative;
		width: max-content;
		display: flex;
		justify-content: flex-start;
	}

	.tree-node {
		display: flex;
		flex-direction: column;
		align-items: center;
	}

	.tree-children {
		display: flex;
		flex-direction: row;
		gap: 24px;
		margin-top: 40px;
	}

	.tree-container.horizontal {
		justify-content: flex-start;
		align-items: center;
	}

	.tree-container.horizontal .tree-node {
		flex-direction: row;
		align-items: center;
	}

	.tree-container.horizontal .tree-children {
		flex-direction: column;
		margin-top: 0;
		margin-left: 40px;
	}

	.spawn-tree-node {
		align-items: center;
	}

	.spawn-tree-children {
		gap: 20px;
	}

	.tree-container.horizontal .spawn-tree-node {
		flex-direction: row;
		align-items: center;
	}

	.tree-container.horizontal .spawn-tree-children {
		flex-direction: column;
		margin-top: 0;
		margin-left: 40px;
	}

	/* Board controls */
	.board-controls-left {
		position: absolute;
		top: 12px;
		left: 12px;
		display: flex;
		flex-direction: column;
		gap: 2px;
		z-index: 20;
	}

	.board-overlay-right {
		position: absolute;
		top: 12px;
		right: 12px;
		z-index: 20;
		display: flex;
		flex-direction: column;
		gap: 8px;
		align-items: flex-end;
		pointer-events: none;
	}

	.atlas-search-wrap {
		width: min(360px, calc(100vw - 92px));
		display: flex;
		flex-direction: column;
		gap: 6px;
		align-items: flex-end;
		pointer-events: none;
	}

	.atlas-mini-stack {
		display: flex;
		flex-wrap: wrap;
		justify-content: flex-end;
		gap: 6px;
		pointer-events: auto;
	}

	.author-search {
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding: 9px;
		background: rgba(255, 252, 245, 0.94);
		backdrop-filter: blur(14px);
		box-shadow: 0 18px 42px rgba(26, 35, 44, 0.1);
		pointer-events: auto;
	}

	.board-search-panel {
		width: 100%;
	}

	.panel-topline {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 10px;
		margin-bottom: 2px;
	}

	.panel-heading {
		font-size: 0.82rem;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: var(--muted);
	}

	.panel-close-btn,
	.panel-reopen-btn {
		pointer-events: auto;
		border: 1px solid rgba(61, 64, 91, 0.12);
		background: #fffdf6;
		color: #24313d;
		box-shadow: 0 10px 24px rgba(26, 35, 44, 0.08);
	}

	.panel-close-btn {
		width: 28px;
		height: 28px;
		border-radius: 999px;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		font-size: 1rem;
		line-height: 1;
		flex-shrink: 0;
	}

	.panel-reopen-btn {
		padding: 8px 11px;
		border-radius: 999px;
		font-size: 0.78rem;
		font-weight: 700;
	}

	.board-search-grid {
		display: flex;
		flex-direction: column;
		gap: 10px;
	}

	.board-search-group {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.board-search-label {
		font-size: 0.72rem;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: #8a5f00;
	}

	.author-search-row {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		gap: 8px;
	}

	.author-search-input {
		width: 100%;
		padding: 10px 12px;
		background: #fffdf6;
		border: 1px solid rgba(61, 64, 91, 0.12);
		border-radius: 14px;
		color: #24313d;
		font-size: 0.9rem;
	}

	.author-search-input:focus {
		border-color: var(--accent);
		outline: none;
	}

	.author-search-btn {
		min-width: 74px;
		border-radius: 14px;
		border: 1px solid rgba(61, 64, 91, 0.12);
		padding: 0 14px;
		background: #fffdf6;
		font-size: 0.82rem;
		font-weight: 700;
		color: #24313d;
	}

	.board-search-status {
		margin: 0;
		padding: 9px 11px;
		font-size: 0.82rem;
		font-family: 'Courier New', monospace;
		pointer-events: auto;
	}

	.atlas-search-error {
		background: rgba(255, 248, 242, 0.96);
	}

	.search-status-success {
		background: rgba(240, 255, 246, 0.96);
		color: #2d6a4f;
	}

	.search-status-error {
		color: #b42318;
	}

	.board-controls-right {
		display: flex;
		flex-direction: column;
		gap: 4px;
		align-items: stretch;
		pointer-events: auto;
	}

	.root-btn {
		padding: 6px 14px;
		font-size: 0.8rem;
		font-family: 'Courier New', monospace;
		background: rgba(253, 245, 230, 0.95);
		border: 1px solid #cc0000;
		border-radius: 4px;
		cursor: pointer;
		color: #cc0000;
		font-weight: bold;
		transition: background 0.15s, color 0.15s;
	}

	.root-btn:hover {
		background: #cc0000;
		color: white;
	}

	@media (max-width: 760px) {
		.atlas-search-wrap {
			width: min(320px, calc(100vw - 88px));
		}

		.atlas-mini-stack {
			justify-content: flex-end;
		}

		.author-search-row {
			grid-template-columns: 1fr;
		}

		.author-search-btn {
			min-height: 40px;
		}

		.board-controls-right {
			flex-direction: row;
			justify-content: flex-end;
		}
	}

	.zoom-btn {
		width: 36px;
		height: 28px;
		background: rgba(253, 245, 230, 0.95);
		border: 1px solid #d4c5a0;
		cursor: pointer;
		font-size: 1rem;
		font-family: 'Courier New', monospace;
		color: #555;
		display: flex;
		align-items: center;
		justify-content: center;
		transition: background 0.15s;
	}

	.zoom-btn:first-child {
		border-radius: 4px 4px 0 0;
	}

	.zoom-btn:last-child {
		border-radius: 0 0 4px 4px;
	}

	.zoom-btn:hover {
		background: #f0e0c0;
	}

	.zoom-input-wrap {
		width: 54px;
		height: 32px;
		padding: 0 6px;
		background: rgba(253, 245, 230, 0.95);
		border: 1px solid #d4c5a0;
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 1px;
	}

	.zoom-input {
		width: 100%;
		border: none;
		background: transparent;
		color: #555;
		font-size: 0.72rem;
		font-family: 'Courier New', monospace;
		font-weight: 700;
		text-align: right;
		padding: 0;
		appearance: textfield;
		-moz-appearance: textfield;
	}

	.zoom-input::-webkit-outer-spin-button,
	.zoom-input::-webkit-inner-spin-button {
		margin: 0;
		-webkit-appearance: none;
	}

	.zoom-input:focus {
		outline: none;
	}

	.zoom-unit {
		font-size: 0.68rem;
		font-family: 'Courier New', monospace;
		color: #777;
	}

	.zoom-reset-btn {
		width: 54px;
		font-size: 0.62rem;
		letter-spacing: 0.02em;
	}

	/* Minimap */
	.minimap {
		position: absolute;
		bottom: 12px;
		right: 12px;
		background: rgba(253, 245, 230, 0.9);
		border: 1px solid #d4c5a0;
		border-radius: 4px;
		z-index: 20;
		cursor: crosshair;
		overflow: hidden;
		box-shadow: 2px 2px 6px rgba(0,0,0,0.2);
		min-width: 120px;
		min-height: 80px;
	}

	.minimap canvas {
		display: block;
	}

	.minimap-viewport {
		position: absolute;
		border: 2px solid #cc0000;
		background: rgba(204, 0, 0, 0.08);
		border-radius: 2px;
		pointer-events: none;
	}

	/* Cards */
	.index-card {
		background: #fdf5e6;
		padding: 20px;
		width: 320px;
		min-width: 320px;
		min-height: 120px;
		box-shadow: 3px 3px 8px rgba(0,0,0,0.3);
		position: relative;
		border: 1px solid #d4c5a0;
		cursor: pointer;
		transition: transform 0.1s ease, box-shadow 0.1s ease;
		text-align: left;
		font: inherit;
		color: inherit;
	}

	.index-card:hover {
		box-shadow: 5px 5px 14px rgba(0,0,0,0.4);
		z-index: 10;
	}

	.active-card {
		outline: 3px solid #cc0000;
		outline-offset: 2px;
		box-shadow: 0 0 12px rgba(204, 0, 0, 0.4);
	}

	.author-match-card {
		background: #fff7cf;
		border-color: #d4a72c;
		box-shadow: 0 0 0 2px rgba(212, 167, 44, 0.18), 3px 3px 8px rgba(0,0,0,0.3);
	}

	.text-match-card {
		border-color: #cc0000;
		box-shadow: 0 0 0 2px rgba(204, 0, 0, 0.12), 3px 3px 8px rgba(0,0,0,0.3);
	}

	.pushpin {
		position: absolute;
		top: -6px;
		left: 50%;
		transform: translateX(-50%);
		width: 16px;
		height: 16px;
		border-radius: 50%;
		background: radial-gradient(circle at 40% 40%, #ff4444, #cc0000);
		box-shadow: 0 2px 4px rgba(0,0,0,0.3);
	}

	.pushpin::after {
		content: '';
		position: absolute;
		bottom: -4px;
		left: 50%;
		transform: translateX(-50%);
		width: 2px;
		height: 6px;
		background: #888;
	}

	.card-author {
		display: flex;
		align-items: center;
		gap: 8px;
		margin-bottom: 8px;
	}

	.card-avatar {
		width: 28px;
		height: 28px;
		border-radius: 50%;
		object-fit: cover;
	}

	.card-handle {
		font-size: 0.8rem;
		color: #666;
		font-family: 'Courier New', monospace;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.card-handle-match {
		color: #7a5200;
		font-weight: bold;
	}

	.card-text {
		font-size: 1rem;
		white-space: pre-wrap;
		word-break: break-word;
		margin: 0 0 8px;
		color: #333;
		font-family: 'Courier New', monospace;
		line-height: 1.4;
	}

	.card-text-highlight {
		background: #ffd76a;
		color: inherit;
		padding: 0 1px;
		border-radius: 2px;
	}

	.card-images {
		display: flex;
		gap: 6px;
		flex-wrap: wrap;
		margin-bottom: 8px;
	}

	.image-lightbox-btn {
		padding: 0;
		border: none;
		background: transparent;
		cursor: pointer;
	}

	.card-img {
		max-width: 100%;
		width: 280px;
		border-radius: 4px;
		border: 1px solid #d4c5a0;
	}

	.card-video {
		display: block;
		width: min(320px, 100%);
		max-width: 100%;
		margin-bottom: 8px;
		border-radius: 6px;
		border: 1px solid #d4c5a0;
		background: #15131b;
	}

	.quote-video {
		width: min(260px, 100%);
	}

	.card-link-embed {
		background: #f5edd8;
		border: 1px solid #d4c5a0;
		border-radius: 4px;
		padding: 10px;
		margin-bottom: 8px;
		display: flex;
		gap: 10px;
		align-items: flex-start;
	}

	.link-thumb {
		width: 80px;
		height: 60px;
		object-fit: cover;
		border-radius: 3px;
		flex-shrink: 0;
	}

	.link-info {
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-width: 0;
	}

	.link-title {
		font-size: 0.85rem;
		font-weight: bold;
		color: #333;
		font-family: 'Courier New', monospace;
	}

	.link-desc {
		font-size: 0.75rem;
		color: #666;
		font-family: 'Courier New', monospace;
		display: -webkit-box;
		-webkit-line-clamp: 2;
		-webkit-box-orient: vertical;
		overflow: hidden;
	}

	.card-quote-embed {
		background: #f0e8d0;
		border: 1px dashed #b8a070;
		border-radius: 4px;
		padding: 10px;
		margin-bottom: 8px;
	}

	.quote-author {
		display: flex;
		align-items: center;
		gap: 6px;
		margin-bottom: 6px;
	}

	.quote-avatar {
		width: 20px;
		height: 20px;
		border-radius: 50%;
		object-fit: cover;
	}

	.quote-handle {
		font-size: 0.75rem;
		color: #666;
		font-family: 'Courier New', monospace;
	}

	.quote-text {
		font-size: 0.85rem;
		color: #444;
		font-family: 'Courier New', monospace;
		white-space: pre-wrap;
		word-break: break-word;
		margin: 0;
		line-height: 1.3;
	}

	.quote-text-muted {
		color: #8a7b5f;
		font-style: italic;
	}

	.quote-actions {
		display: flex;
		align-items: center;
		gap: 8px;
		flex-wrap: wrap;
		margin-top: 10px;
		padding-top: 8px;
		border-top: 1px dashed rgba(138, 122, 91, 0.35);
	}

	.quote-thread-btn {
		padding: 4px 9px;
		border-radius: 999px;
		border: 1px solid #c79a2b;
		background: #fff4cf;
		color: #8a5f00;
		font-size: 0.72rem;
		font-family: 'Courier New', monospace;
		font-weight: 700;
		cursor: pointer;
		transition: background 0.15s, color 0.15s, border-color 0.15s;
	}

	.quote-thread-btn:hover:not(:disabled) {
		background: #c79a2b;
		border-color: #c79a2b;
		color: white;
	}

	.quote-thread-btn:disabled {
		opacity: 0.65;
		cursor: wait;
	}

	.quote-thread-btn-ready {
		background: #ffeaea;
		border-color: #cc0000;
		color: #cc0000;
	}

	.quote-thread-btn-ready:hover:not(:disabled) {
		background: #cc0000;
		border-color: #cc0000;
	}

	.quote-thread-btn-error {
		background: #fff1ef;
		border-color: #d92d20;
		color: #b42318;
	}

	.quote-thread-btn-error:hover:not(:disabled) {
		background: #d92d20;
		border-color: #d92d20;
	}

	.quote-thread-status {
		font-size: 0.7rem;
		font-family: 'Courier New', monospace;
		color: #6b5a3d;
	}

	.quote-thread-status-error {
		color: #b42318;
	}

	.card-footer {
		display: flex;
		justify-content: space-between;
		align-items: center;
		margin-top: 8px;
		padding-top: 6px;
		border-top: 1px solid #e0d5b8;
	}

	.card-date {
		font-size: 0.75rem;
		color: #888;
		font-family: 'Courier New', monospace;
	}

	.card-stats {
		display: flex;
		gap: 10px;
		font-size: 0.7rem;
		color: #999;
		font-family: 'Courier New', monospace;
	}

	.bsky-link {
		font-size: 0.7rem;
		font-family: 'Courier New', monospace;
		color: var(--accent, #e07a5f);
		text-decoration: none;
		cursor: pointer;
	}

	.bsky-link:hover {
		text-decoration: underline;
	}

	.card-nav {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 6px;
		margin-top: 8px;
		padding-top: 6px;
		border-top: 1px dashed #e0d5b8;
	}

	.card-nav-btn {
		padding: 2px 8px;
		font-size: 0.75rem;
		font-family: 'Courier New', monospace;
		background: #f5edd8;
		border: 1px solid #d4c5a0;
		border-radius: 3px;
		cursor: pointer;
		color: #555;
		transition: background 0.15s, color 0.15s;
	}

	.card-nav-btn:hover:not(:disabled) {
		background: #cc0000;
		color: white;
		border-color: #cc0000;
	}

	.card-nav-btn:disabled {
		opacity: 0.3;
		cursor: not-allowed;
	}

	.card-nav-btn.branch-btn {
		background: #ffeaea;
		border-color: #cc0000;
		color: #cc0000;
	}

	.card-nav-btn.branch-btn:hover {
		background: #cc0000;
		color: white;
	}

	.card-nav-btn.collapse-btn {
		background: #fff4cf;
		border-color: #c79a2b;
		color: #8a5f00;
	}

	.card-nav-btn.collapse-btn:hover {
		background: #c79a2b;
		border-color: #c79a2b;
		color: white;
	}

	.card-nav-counter {
		font-size: 0.7rem;
		color: #999;
		font-family: 'Courier New', monospace;
		min-width: 36px;
		text-align: center;
	}

	.card-children-nav {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 4px;
		margin-top: 4px;
		padding-top: 4px;
		border-top: 1px dashed #e0d5b8;
		flex-wrap: wrap;
	}

	.children-label {
		font-size: 0.65rem;
		color: #999;
		font-family: 'Courier New', monospace;
	}

	.card-nav-btn.child-btn {
		min-width: 24px;
		padding: 2px 6px;
		font-size: 0.7rem;
		background: #ffeaea;
		border-color: #cc0000;
		color: #cc0000;
	}

	.card-nav-btn.child-btn:hover {
		background: #cc0000;
		color: white;
	}

	.card-nav-btn.child-btn.active-child {
		background: #cc0000;
		color: white;
	}

	.card-nav-btn.child-btn.collapsed-child {
		background: #fff4cf;
		border-color: #c79a2b;
		color: #8a5f00;
		font-weight: bold;
	}

	.card-nav-btn.child-btn.collapsed-child:hover {
		background: #c79a2b;
		border-color: #c79a2b;
		color: white;
	}

	.quote-thread-footer {
		margin-top: 10px;
	}

	.spawn-tree-card {
		cursor: default;
		min-height: 0;
	}

	.spawn-tree-text {
		font-size: 0.92rem;
		margin-bottom: 10px;
	}

	.spawn-tree-card .card-img {
		width: min(100%, 220px);
	}

	@media (max-width: 1180px) {
		.board-forest {
			--spawn-gap: 22px;
			--spawn-shift: 136px;
			padding-left: 24px;
			padding-right: 0;
		}
	}

	@media (max-width: 760px) {
		.board-layout {
			width: min(100vw, calc(100vw - 16px));
			gap: 14px;
		}

		.board-forest {
			--spawn-gap: 18px;
			--spawn-shift: 84px;
			padding-left: 12px;
			padding-bottom: 88px;
		}

		.tree-stage {
			padding-top: 70px;
		}

		.tree-toolbar {
			left: 0;
			right: auto;
			justify-content: flex-start;
			max-width: 100%;
		}

		.tree-stage-offset {
			margin-left: 44px;
		}
	}
</style>
