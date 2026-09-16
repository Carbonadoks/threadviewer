<script lang="ts">
	import { onMount } from 'svelte';
	import '../../app.css';
	import type { Agent } from '@atproto/api';
	import {
		getFullThread,
		fetchQuotesForPost,
		getProfile,
		searchPostsGeneral,
		type PostSearchAgent,
		type ProfileInfo
	} from '$lib/api/bluesky';
	import {
		initAuthenticatedBlueskyClient,
		connectBlueskyWithPopup,
		disconnectBluesky,
		type AuthenticatedBlueskyContext
	} from '$lib/api/blueskyAuth';
	import { BLUESKY_FOLLOWSEARCH_SCOPE } from '$lib/constants/blueskyOAuth';
	import FontPicker from '$lib/components/FontPicker.svelte';
	import RouteNav from '$lib/components/RouteNav.svelte';
	import { openLightbox } from '$lib/stores/lightbox';
	import type { EmbedImage, ThreadPost } from '$lib/types';
	import {
		buildAtUri,
		buildBskyPostUrl,
		normalizeBskyPostUrl,
		parseBskyPostUrl
	} from '$lib/utils/viewerLinks';
	import { toastError, toastInfo, toastWarning } from '$lib/utils/toasts';
	import {
		WHITEBOARD_CARD_WIDTH,
		WHITEBOARD_CARD_HEIGHT,
		WHITEBOARD_GROUP_HEADER_HEIGHT,
		WHITEBOARD_GROUP_MARGIN,
		authorColor,
		chainIndexForUri,
		collectThreadPosts,
		findFreeSpot,
		layoutThreadGroup,
		layoutThreadStack,
		pruneDeletedPosts,
		type WhiteboardGroupLayout,
		type WhiteboardRect
	} from '$lib/utils/whiteboard';

	// ---------- constants ----------
	const SEARCH_PAGE_LIMIT = 100;
	const SEARCH_MAX_PAGES = 40;
	const QUEUE_CONCURRENCY = 3;
	const API_MIN_INTERVAL_MS = 350;
	const RATE_LIMIT_BACKOFF_MS = 4000;
	const RATE_LIMIT_MAX_RETRIES = 4;
	const COLUMN_GAP = 140;
	const GROUP_GAP_Y = 120;
	const ZOOM_MIN = 0.08;
	const ZOOM_MAX = 1.6;
	const MINIMAP_W = 208;
	const MINIMAP_H = 140;

	const fontFamilies: Record<string, string> = {
		virgil: "'Virgil', cursive",
		caveat: "'Caveat', cursive",
		patrick: "'Patrick Hand', cursive",
		'comic-neue': "'Comic Neue', cursive",
		inter: "'Inter', sans-serif",
		system: 'system-ui, -apple-system, sans-serif'
	};
	let fontKey = $state('patrick');
	let fontFamily = $derived(fontFamilies[fontKey] ?? fontFamilies.virgil);
	function handleFontChange(key: string) {
		fontKey = key;
		try {
			localStorage.setItem('preferred-font', key);
		} catch {}
	}

	const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

	// ---------- auth ----------
	let authAgent: Agent | null = $state(null);
	let authProfile: ProfileInfo | null = $state(null);
	let sessionSub: string | null = $state(null);
	let hasSearchScope = $state(false);
	let connecting = $state(false);
	let restoringSession = $state(true);

	function applyAuthContext(context: AuthenticatedBlueskyContext) {
		authAgent = context.agent;
		authProfile = context.profile;
		sessionSub = context.session.sub;
		hasSearchScope = context.hasSearchPostsScope;
		if (!hasSearchScope) {
			toastWarning('Your session is missing the searchPosts permission — try reconnecting.');
		}
	}

	async function restoreSession() {
		restoringSession = true;
		try {
			const { context } = await initAuthenticatedBlueskyClient();
			if (context) applyAuthContext(context);
		} catch {
			// Non-fatal: visitor can connect manually.
		} finally {
			restoringSession = false;
		}
	}

	async function handleConnect() {
		connecting = true;
		try {
			const context = await connectBlueskyWithPopup({ scope: BLUESKY_FOLLOWSEARCH_SCOPE });
			applyAuthContext(context);
		} catch (err) {
			toastError(err instanceof Error ? err.message : 'Could not connect your Bluesky account.');
		} finally {
			connecting = false;
		}
	}

	async function handleDisconnect() {
		const sub = sessionSub;
		if (!sub) return;
		try {
			await disconnectBluesky(sub);
		} catch {}
		authAgent = null;
		authProfile = null;
		sessionSub = null;
		hasSearchScope = false;
	}

	// ---------- shared API pacing + rate-limit telemetry ----------
	let lastApiCallAt = 0;
	let backoffWorkers = $state(0);
	let rateLimitHits = $state(0);

	async function paceApiCall() {
		const now = Date.now();
		const wait = Math.max(0, lastApiCallAt + API_MIN_INTERVAL_MS - now);
		lastApiCallAt = now + wait;
		if (wait > 0) await sleep(wait);
	}

	function statusOf(err: unknown): number | undefined {
		const e = err as { status?: number; response?: { status?: number } };
		return e?.status ?? e?.response?.status;
	}

	// ---------- search dialog ----------
	let searchDialogEl: HTMLDialogElement | undefined = $state();
	let searchTerm = $state('');
	let onlyFollows = $state(true);
	let searchSort = $state<'latest' | 'top'>('latest');
	let searching = $state(false);
	let searchPagesDone = $state(0);
	let searchAbort: AbortController | null = null;
	let searchResults = $state(new Map<string, ThreadPost>());
	let collapsedResultAuthors = $state(new Set<string>());
	let resultFilter = $state('');
	let resultFilterExact = $state(false);

	// Loose normalization for "the post IS this phrase" matching: collapse
	// whitespace, drop case and trailing punctuation.
	function normalizePhrase(text: string): string {
		return text
			.toLowerCase()
			.replace(/\s+/g, ' ')
			.trim()
			.replace(/[.!?…,;:]+$/, '');
	}

	const filteredSearchPosts = $derived.by(() => {
		const all = Array.from(searchResults.values());
		const phrase = resultFilter.trim().toLowerCase();
		if (!phrase) return all;
		if (resultFilterExact) {
			const norm = normalizePhrase(resultFilter);
			return all.filter((post) => normalizePhrase(post.text ?? '') === norm);
		}
		return all.filter((post) => (post.text ?? '').toLowerCase().includes(phrase));
	});

	type ResultAuthorGroup = {
		did: string;
		author: ThreadPost['author'];
		posts: ThreadPost[];
	};
	const resultAuthorGroups = $derived.by(() => {
		const groupsByDid = new Map<string, ResultAuthorGroup>();
		for (const post of filteredSearchPosts) {
			let group = groupsByDid.get(post.author.did);
			if (!group) {
				group = { did: post.author.did, author: post.author, posts: [] };
				groupsByDid.set(post.author.did, group);
			}
			group.posts.push(post);
		}
		for (const group of groupsByDid.values()) {
			group.posts.sort(
				(a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
			);
		}
		return Array.from(groupsByDid.values()).sort((a, b) => {
			if (b.posts.length !== a.posts.length) return b.posts.length - a.posts.length;
			return a.author.handle.localeCompare(b.author.handle);
		});
	});

	function openSearchDialog() {
		searchDialogEl?.showModal();
	}
	function closeSearchDialog() {
		searchDialogEl?.close();
	}

	function cancelSearch() {
		searchAbort?.abort();
		searchAbort = null;
		searching = false;
	}

	async function runSearch() {
		const agent = authAgent;
		if (!agent) {
			toastInfo('Connect your Bluesky account to search.');
			return;
		}
		const term = searchTerm.trim();
		if (!term) {
			toastInfo('Enter a search term.');
			return;
		}

		cancelSearch();
		const controller = new AbortController();
		searchAbort = controller;
		searching = true;
		searchPagesDone = 0;
		searchResults = new Map();
		collapsedResultAuthors = new Set();
		resultFilter = '';

		const searchAgent = agent as unknown as PostSearchAgent;
		const merged = new Map<string, ThreadPost>();
		let cursor: string | undefined;
		const seenCursors = new Set<string>();

		try {
			for (let page = 0; page < SEARCH_MAX_PAGES; page++) {
				if (controller.signal.aborted) break;
				await paceApiCall();
				let result;
				try {
					result = await searchPostsGeneral(term, {
						sort: searchSort,
						limit: SEARCH_PAGE_LIMIT,
						cursor,
						following: onlyFollows,
						signal: controller.signal,
						agent: searchAgent
					});
				} catch (err) {
					if (controller.signal.aborted) break;
					if (statusOf(err) === 429) {
						rateLimitHits += 1;
						backoffWorkers += 1;
						await sleep(RATE_LIMIT_BACKOFF_MS);
						backoffWorkers -= 1;
						page -= 1;
						continue;
					}
					throw err;
				}

				for (const post of result.posts) {
					merged.set(post.uri, post);
				}
				searchResults = new Map(merged);
				searchPagesDone = page + 1;

				if (!result.cursor || seenCursors.has(result.cursor)) break;
				seenCursors.add(result.cursor);
				cursor = result.cursor;
			}
			if (!controller.signal.aborted && merged.size === 0) {
				toastInfo('No posts matched your search.');
			}
		} catch (err) {
			if (!controller.signal.aborted) {
				toastError(err instanceof Error ? err.message : 'Search failed.');
			}
		} finally {
			if (searchAbort === controller) {
				searchAbort = null;
				searching = false;
			}
		}
	}

	// ---------- fetch queue ----------
	type QueueItemKind = 'search-post' | 'manual' | 'quoted-thread' | 'quote-post';
	type QueueStatus = 'pending' | 'running' | 'done' | 'skipped' | 'error';
	type CrossLinkRequest = { fromUri: string; toUri: string };
	type QueueItem = {
		id: string;
		kind: QueueItemKind;
		uri: string;
		label: string;
		detail: string;
		status: QueueStatus;
		error?: string;
		columnAuthor?: ThreadPost['author'];
		nearGroupId?: string;
		linkRequest?: CrossLinkRequest;
	};

	let queue = $state<QueueItem[]>([]);
	let queueRunning = $state(false);
	let queuePaused = $state(false);
	let showQueuePanel = $state(true);
	let nextQueueId = 1;
	const queuedUris = new Set<string>();

	const queueCounts = $derived.by(() => {
		const counts = { pending: 0, running: 0, done: 0, skipped: 0, error: 0 };
		for (const item of queue) counts[item.status] += 1;
		return counts;
	});

	function previewText(text: string | undefined, maxLength = 72): string {
		const value = (text ?? '').replace(/\s+/g, ' ').trim();
		if (!value) return '(no text)';
		return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
	}

	function updateQueueItem(id: string, patch: Partial<QueueItem>) {
		queue = queue.map((item) => (item.id === id ? { ...item, ...patch } : item));
	}

	function enqueue(item: Omit<QueueItem, 'id' | 'status'>): boolean {
		if (queuedUris.has(item.uri) || boardHasPost(item.uri)) {
			return false;
		}
		queuedUris.add(item.uri);
		queue = [
			...queue,
			{
				...item,
				id: `task-${nextQueueId++}`,
				status: 'pending'
			}
		];
		void processQueue();
		return true;
	}

	function clearFinishedQueueItems() {
		queue = queue.filter(
			(item) => item.status === 'pending' || item.status === 'running'
		);
	}

	async function processQueue() {
		if (queueRunning) return;
		queueRunning = true;
		try {
			await Promise.all(
				Array.from({ length: QUEUE_CONCURRENCY }, () => queueWorker())
			);
		} finally {
			queueRunning = false;
		}
	}

	async function queueWorker() {
		while (true) {
			if (queuePaused) {
				if (!queue.some((item) => item.status === 'pending')) break;
				await sleep(400);
				continue;
			}
			const item = queue.find((candidate) => candidate.status === 'pending');
			if (!item) break;
			updateQueueItem(item.id, { status: 'running' });
			try {
				await runQueueItem(item);
			} catch (err) {
				// Free the URI so the user can queue it again after a failure.
				queuedUris.delete(item.uri);
				updateQueueItem(item.id, {
					status: 'error',
					error: err instanceof Error ? err.message : 'Fetch failed.'
				});
			}
		}
	}

	async function runQueueItem(item: QueueItem) {
		if (boardHasPost(item.uri)) {
			if (item.linkRequest) addCrossLink(item.linkRequest);
			updateQueueItem(item.id, { status: 'skipped', error: 'Already on the whiteboard.' });
			return;
		}

		let thread: Awaited<ReturnType<typeof getFullThread>> | null = null;
		for (let attempt = 0; attempt <= RATE_LIMIT_MAX_RETRIES; attempt++) {
			await paceApiCall();
			try {
				thread = await getFullThread(item.uri);
				break;
			} catch (err) {
				if (statusOf(err) === 429 && attempt < RATE_LIMIT_MAX_RETRIES) {
					rateLimitHits += 1;
					backoffWorkers += 1;
					await sleep(RATE_LIMIT_BACKOFF_MS * (attempt + 1));
					backoffWorkers -= 1;
					continue;
				}
				throw err;
			}
		}
		if (!thread) throw new Error('Thread fetch gave up after rate limiting.');

		if (groups.some((group) => group.rootUri === thread!.rootUri)) {
			if (item.linkRequest) addCrossLink(item.linkRequest);
			updateQueueItem(item.id, {
				status: 'skipped',
				error: 'Thread already on the whiteboard.'
			});
			return;
		}

		addGroupToBoard(thread, item);
		if (item.linkRequest) addCrossLink(item.linkRequest);
		updateQueueItem(item.id, { status: 'done' });
	}

	// ---------- whiteboard state ----------
	type BoardGroup = {
		id: string;
		rootUri: string;
		thread: ThreadPost;
		isTruncated: boolean;
		author: ThreadPost['author'];
		columnAuthor: ThreadPost['author'];
		focusUri: string | null;
		x: number;
		y: number;
		deletedUris: ReadonlySet<string>;
		/** false = stacked single reply lane, true = full tree fan. */
		expanded: boolean;
		/** Which root→leaf path is shown while stacked. */
		chainIndex: number;
		addedAt: number;
	};
	type CrossLink = { id: string; fromUri: string; toUri: string };
	type BinPostEntry = {
		id: string;
		groupId: string;
		groupLabel: string;
		post: ThreadPost;
		deletedAt: number;
	};

	let groups = $state<BoardGroup[]>([]);
	let crossLinks = $state<CrossLink[]>([]);
	let binPosts = $state<BinPostEntry[]>([]);
	let binGroups = $state<BoardGroup[]>([]);
	let showBinPanel = $state(false);
	let nextGroupId = 1;
	let nextLinkId = 1;
	let nextBinId = 1;

	// Layouts only depend on each group's thread + deletedUris, not its
	// position, so memoize per group and return the same Map instance when
	// nothing structural changed. That way pointer-move drags (which rebuild
	// the groups array) don't re-lay-out every thread or invalidate the
	// derived values downstream of `layouts`.
	const layoutCache = new Map<
		string,
		{
			thread: ThreadPost;
			deletedUris: ReadonlySet<string>;
			expanded: boolean;
			chainIndex: number;
			layout: WhiteboardGroupLayout;
		}
	>();
	let lastLayouts = new Map<string, WhiteboardGroupLayout>();
	const layouts = $derived.by(() => {
		let changed = false;
		const map = new Map<string, WhiteboardGroupLayout>();
		for (const group of groups) {
			const cached = layoutCache.get(group.id);
			if (
				cached &&
				cached.thread === group.thread &&
				cached.deletedUris === group.deletedUris &&
				cached.expanded === group.expanded &&
				cached.chainIndex === group.chainIndex
			) {
				map.set(group.id, cached.layout);
			} else {
				const layout = group.expanded
					? layoutThreadGroup(group.thread, group.deletedUris)
					: layoutThreadStack(group.thread, group.deletedUris, group.chainIndex);
				layoutCache.set(group.id, {
					thread: group.thread,
					deletedUris: group.deletedUris,
					expanded: group.expanded,
					chainIndex: group.chainIndex,
					layout
				});
				map.set(group.id, layout);
				changed = true;
			}
		}
		if (layoutCache.size > map.size) {
			for (const id of layoutCache.keys()) {
				if (!map.has(id)) layoutCache.delete(id);
			}
		}
		if (!changed && map.size === lastLayouts.size) {
			let sameIds = true;
			for (const id of map.keys()) {
				if (!lastLayouts.has(id)) {
					sameIds = false;
					break;
				}
			}
			if (sameIds) return lastLayouts;
		}
		lastLayouts = map;
		return map;
	});

	const groupById = $derived.by(() => {
		const map = new Map<string, BoardGroup>();
		for (const group of groups) map.set(group.id, group);
		return map;
	});

	// uri -> groupId for every visible card on the board
	const postIndex = $derived.by(() => {
		const map = new Map<string, string>();
		for (const [groupId, layout] of layouts) {
			for (const uri of layout.cardByUri.keys()) {
				map.set(uri, groupId);
			}
		}
		return map;
	});

	// Every surviving post per group, hidden stack branches included. Memoized
	// like `layouts` so drags (which rebuild `groups`) don't recompute it or
	// invalidate the filter/match deriveds downstream.
	const groupPostsCache = new Map<
		string,
		{ thread: ThreadPost; deletedUris: ReadonlySet<string>; posts: ThreadPost[] }
	>();
	let lastGroupPosts = new Map<string, ThreadPost[]>();
	const groupPosts = $derived.by(() => {
		let changed = false;
		const map = new Map<string, ThreadPost[]>();
		for (const group of groups) {
			const cached = groupPostsCache.get(group.id);
			if (cached && cached.thread === group.thread && cached.deletedUris === group.deletedUris) {
				map.set(group.id, cached.posts);
			} else {
				const pruned = pruneDeletedPosts(group.thread, group.deletedUris);
				const posts = pruned ? collectThreadPosts(pruned) : [];
				groupPostsCache.set(group.id, {
					thread: group.thread,
					deletedUris: group.deletedUris,
					posts
				});
				map.set(group.id, posts);
				changed = true;
			}
		}
		if (groupPostsCache.size > map.size) {
			for (const id of groupPostsCache.keys()) {
				if (!map.has(id)) groupPostsCache.delete(id);
			}
		}
		if (!changed && map.size === lastGroupPosts.size) {
			let sameIds = true;
			for (const id of map.keys()) {
				if (!lastGroupPosts.has(id)) {
					sameIds = false;
					break;
				}
			}
			if (sameIds) return lastGroupPosts;
		}
		lastGroupPosts = map;
		return map;
	});

	// uri -> groupId for every post on the board, even ones hidden by stacking.
	const fullPostIndex = $derived.by(() => {
		const map = new Map<string, string>();
		for (const [groupId, posts] of groupPosts) {
			for (const post of posts) map.set(post.uri, groupId);
		}
		return map;
	});

	function boardHasPost(uri: string): boolean {
		return fullPostIndex.has(uri);
	}

	function addCrossLink(request: CrossLinkRequest) {
		if (
			crossLinks.some(
				(link) => link.fromUri === request.fromUri && link.toUri === request.toUri
			)
		) {
			return;
		}
		crossLinks = [...crossLinks, { id: `link-${nextLinkId++}`, ...request }];
	}

	const visibleCrossLinks = $derived.by(() => {
		const lines: Array<{ id: string; x1: number; y1: number; x2: number; y2: number }> = [];
		for (const link of crossLinks) {
			const from = worldCardAnchor(link.fromUri);
			const to = worldCardAnchor(link.toUri);
			if (!from || !to) continue;
			if (hiddenGroupIds.has(from.groupId) || hiddenGroupIds.has(to.groupId)) continue;
			lines.push({ id: link.id, x1: from.x, y1: from.y, x2: to.x, y2: to.y });
		}
		return lines;
	});

	function worldCardAnchor(uri: string): { x: number; y: number; groupId: string } | null {
		const groupId = fullPostIndex.get(uri);
		if (!groupId) return null;
		const group = groupById.get(groupId);
		if (!group) return null;
		const card = layouts.get(groupId)?.cardByUri.get(uri);
		if (card) {
			return {
				groupId,
				x: group.x + card.x + WHITEBOARD_CARD_WIDTH / 2,
				y: group.y + card.y + WHITEBOARD_CARD_HEIGHT / 2
			};
		}
		// Post exists but is on a hidden stack branch — anchor the link to the
		// group header so it still points somewhere sensible.
		const layout = layouts.get(groupId);
		return {
			groupId,
			x: group.x + (layout?.width ?? WHITEBOARD_CARD_WIDTH) / 2,
			y: group.y + WHITEBOARD_GROUP_HEADER_HEIGHT / 2
		};
	}

	// ---------- placement: collision-free spots seeded by per-author columns ----------
	const authorColumns = new Map<string, { x: number; nextY: number }>();
	let nextColumnX = 0;

	function groupRects(excludeId?: string): WhiteboardRect[] {
		const rects: WhiteboardRect[] = [];
		for (const group of groups) {
			if (group.id === excludeId) continue;
			const layout = layouts.get(group.id);
			rects.push({
				x: group.x,
				y: group.y,
				width: layout?.width ?? WHITEBOARD_CARD_WIDTH,
				height: layout?.height ?? WHITEBOARD_CARD_HEIGHT
			});
		}
		return rects;
	}

	function authorColumnFor(did: string, width: number) {
		let column = authorColumns.get(did);
		if (!column) {
			column = { x: nextColumnX, nextY: 0 };
			authorColumns.set(did, column);
			nextColumnX += Math.max(width, WHITEBOARD_CARD_WIDTH * 1.6) + COLUMN_GAP;
		}
		return column;
	}

	function addGroupToBoard(
		thread: { rootPost: ThreadPost; rootUri: string; isTruncated: boolean },
		item: QueueItem
	) {
		const focusUri = item.kind === 'search-post' || item.kind === 'manual' ? item.uri : null;
		// New groups land stacked (single reply lane). Pick the lane that
		// contains the post the user actually asked for, so it's visible.
		const chainIndex = focusUri ? (chainIndexForUri(thread.rootPost, focusUri) ?? 0) : 0;
		const layout = layoutThreadStack(thread.rootPost, new Set(), chainIndex);
		const columnAuthor = item.columnAuthor ?? thread.rootPost.author;
		let preferredX: number;
		let preferredY: number;
		let column: { x: number; nextY: number } | null = null;

		const nearGroup = item.nearGroupId ? groupById.get(item.nearGroupId) : undefined;
		if (nearGroup) {
			// Quoted / quote-post threads land next to the group that spawned them.
			const nearLayout = layouts.get(nearGroup.id);
			preferredX = nearGroup.x + (nearLayout?.width ?? WHITEBOARD_CARD_WIDTH) + COLUMN_GAP;
			preferredY = nearGroup.y;
		} else {
			column = authorColumnFor(columnAuthor.did, layout.width);
			preferredX = column.x;
			preferredY = column.nextY;
		}

		// Never let groups overlap: snap to the nearest free spot.
		const { x, y } = findFreeSpot(
			layout.width,
			layout.height,
			preferredX,
			preferredY,
			groupRects(),
			WHITEBOARD_GROUP_MARGIN
		);
		if (column) {
			column.nextY = Math.max(column.nextY, y + layout.height + GROUP_GAP_Y);
		}

		groups = [
			...groups,
			{
				id: `group-${nextGroupId++}`,
				rootUri: thread.rootUri,
				thread: thread.rootPost,
				isTruncated: thread.isTruncated,
				author: thread.rootPost.author,
				columnAuthor,
				focusUri,
				x,
				y,
				deletedUris: new Set(),
				expanded: false,
				chainIndex,
				addedAt: Date.now()
			}
		];
	}

	// ---------- group layout mode (stack ⇄ tree) ----------
	function replaceGroupResized(id: string, patch: Partial<BoardGroup>) {
		const group = groupById.get(id);
		if (!group) return;
		const next = { ...group, ...patch };
		const layout = next.expanded
			? layoutThreadGroup(next.thread, next.deletedUris)
			: layoutThreadStack(next.thread, next.deletedUris, next.chainIndex);
		// The group's footprint changed — nudge it to the nearest free spot so
		// it never lands on a neighbor.
		const spot = findFreeSpot(
			layout.width,
			layout.height,
			next.x,
			next.y,
			groupRects(id),
			WHITEBOARD_GROUP_MARGIN
		);
		groups = groups.map((candidate) =>
			candidate.id === id ? { ...next, x: spot.x, y: spot.y } : candidate
		);
	}

	function toggleGroupExpanded(group: BoardGroup) {
		replaceGroupResized(group.id, { expanded: !group.expanded });
	}

	function cycleChain(group: BoardGroup, delta: number) {
		const layout = layouts.get(group.id);
		const chainCount = layout?.chainCount ?? 1;
		if (group.expanded || chainCount <= 1) return;
		const current = layout?.activeChainIndex ?? group.chainIndex;
		replaceGroupResized(group.id, {
			chainIndex: (((current + delta) % chainCount) + chainCount) % chainCount
		});
	}

	function jumpChain(group: BoardGroup, chainIndex: number) {
		replaceGroupResized(group.id, { chainIndex });
	}

	function setAllExpanded(expanded: boolean) {
		// Re-place sequentially so the resized groups never overlap each other.
		const placed: WhiteboardRect[] = [];
		const next: BoardGroup[] = [];
		for (const group of groups) {
			const layout = expanded
				? layoutThreadGroup(group.thread, group.deletedUris)
				: layoutThreadStack(group.thread, group.deletedUris, group.chainIndex);
			const spot = findFreeSpot(
				layout.width,
				layout.height,
				group.x,
				group.y,
				placed,
				WHITEBOARD_GROUP_MARGIN
			);
			placed.push({ ...spot, width: layout.width, height: layout.height });
			next.push({ ...group, expanded, x: spot.x, y: spot.y });
		}
		groups = next;
	}

	function tidyBoard() {
		// Rebuild per-author columns from scratch, keeping insertion order.
		authorColumns.clear();
		nextColumnX = 0;
		const placed: WhiteboardRect[] = [];
		const next: BoardGroup[] = [];
		const ordered = [...groups].sort((a, b) => {
			if (a.columnAuthor.did !== b.columnAuthor.did) {
				return a.columnAuthor.did < b.columnAuthor.did ? -1 : 1;
			}
			return a.addedAt - b.addedAt;
		});
		for (const group of ordered) {
			const layout = layouts.get(group.id);
			const width = layout?.width ?? WHITEBOARD_CARD_WIDTH;
			const height = layout?.height ?? WHITEBOARD_CARD_HEIGHT;
			const column = authorColumnFor(group.columnAuthor.did, width);
			const spot = findFreeSpot(width, height, column.x, column.nextY, placed, WHITEBOARD_GROUP_MARGIN);
			column.nextY = Math.max(column.nextY, spot.y + height + GROUP_GAP_Y);
			placed.push({ ...spot, width, height });
			next.push({ ...group, x: spot.x, y: spot.y });
		}
		groups = next;
		requestAnimationFrame(() => fitBoard());
	}

	// ---------- insert a pasted Bluesky post URL ----------
	let insertUrlInput = $state('');
	let insertingUrl = $state(false);

	async function insertPostUrl() {
		const raw = insertUrlInput.trim();
		if (!raw || insertingUrl) return;

		let atUri: string | null = null;
		let columnAuthor: ThreadPost['author'] | undefined;

		if (raw.startsWith('at://')) {
			atUri = raw;
		} else {
			const normalized = normalizeBskyPostUrl(raw);
			const parsed = normalized ? parseBskyPostUrl(normalized) : null;
			if (!parsed) {
				toastError(
					'Invalid post URL. Expected https://bsky.app/profile/{handle}/post/{rkey} or an at:// URI.'
				);
				return;
			}
			insertingUrl = true;
			try {
				const profile = await getProfile(parsed.handle);
				atUri = buildAtUri(profile.did, parsed.rkey);
				columnAuthor = {
					did: profile.did,
					handle: profile.handle,
					displayName: profile.displayName,
					avatar: profile.avatar
				};
			} catch {
				toastError(`Could not resolve handle "${parsed.handle}".`);
				return;
			} finally {
				insertingUrl = false;
			}
		}

		if (!atUri) {
			toastError('Could not build an AT URI for this post.');
			return;
		}

		const added = enqueue({
			kind: 'manual',
			uri: atUri,
			label: columnAuthor ? `@${columnAuthor.handle}` : atUri,
			detail: 'Pasted post URL',
			columnAuthor
		});
		if (added) {
			insertUrlInput = '';
		} else {
			toastInfo('That post is already queued or on the whiteboard.');
		}
	}

	// ---------- put posts on whiteboard ----------
	function boardSearchPost(post: ThreadPost) {
		const added = enqueue({
			kind: 'search-post',
			uri: post.uri,
			label: `@${post.author.handle}`,
			detail: previewText(post.text),
			columnAuthor: post.author
		});
		if (!added) toastInfo('That post is already queued or on the whiteboard.');
	}

	function boardAuthorGroup(group: ResultAuthorGroup) {
		let added = 0;
		for (const post of group.posts) {
			if (
				enqueue({
					kind: 'search-post',
					uri: post.uri,
					label: `@${post.author.handle}`,
					detail: previewText(post.text),
					columnAuthor: post.author
				})
			) {
				added += 1;
			}
		}
		toastInfo(`Queued ${added} thread${added === 1 ? '' : 's'} from @${group.author.handle}.`);
	}

	function boardAllResults() {
		let added = 0;
		for (const group of resultAuthorGroups) {
			for (const post of group.posts) {
				if (
					enqueue({
						kind: 'search-post',
						uri: post.uri,
						label: `@${post.author.handle}`,
						detail: previewText(post.text),
						columnAuthor: post.author
					})
				) {
					added += 1;
				}
			}
		}
		closeSearchDialog();
		toastInfo(`Queued ${added} thread${added === 1 ? '' : 's'}.`);
	}

	// ---------- card actions: quoted thread + quote posts ----------
	function fetchQuotedThread(group: BoardGroup, post: ThreadPost) {
		const record = post.embed?.record;
		if (!record) return;
		const added = enqueue({
			kind: 'quoted-thread',
			uri: record.uri,
			label: `@${record.author.handle}`,
			detail: `Quoted by @${post.author.handle}: ${previewText(record.text, 48)}`,
			nearGroupId: group.id,
			linkRequest: { fromUri: post.uri, toUri: record.uri }
		});
		if (!added) {
			addCrossLink({ fromUri: post.uri, toUri: record.uri });
			toastInfo('Quoted thread is already queued or on the whiteboard — linked it.');
		}
	}

	type QuoteFeedState = {
		status: 'idle' | 'loading' | 'ready' | 'error';
		posts: ThreadPost[];
		error?: string;
	};
	let quoteFeeds = $state<Record<string, QuoteFeedState>>({});
	let openQuotePickerUri = $state<string | null>(null);

	async function toggleQuotePicker(post: ThreadPost) {
		if (openQuotePickerUri === post.uri) {
			openQuotePickerUri = null;
			return;
		}
		openQuotePickerUri = post.uri;
		const existing = quoteFeeds[post.uri];
		if (existing && existing.status !== 'error') return;
		quoteFeeds = { ...quoteFeeds, [post.uri]: { status: 'loading', posts: [] } };
		try {
			await paceApiCall();
			const res = await fetchQuotesForPost(post.uri, { limit: 50 });
			quoteFeeds = { ...quoteFeeds, [post.uri]: { status: 'ready', posts: res.posts } };
		} catch (err) {
			quoteFeeds = {
				...quoteFeeds,
				[post.uri]: {
					status: 'error',
					posts: [],
					error: err instanceof Error ? err.message : 'Could not load quote posts.'
				}
			};
		}
	}

	function boardQuotePost(group: BoardGroup, quotedPost: ThreadPost, quotePost: ThreadPost) {
		const added = enqueue({
			kind: 'quote-post',
			uri: quotePost.uri,
			label: `@${quotePost.author.handle}`,
			detail: `Quotes @${quotedPost.author.handle}: ${previewText(quotePost.text, 48)}`,
			nearGroupId: group.id,
			linkRequest: { fromUri: quotePost.uri, toUri: quotedPost.uri }
		});
		if (!added) {
			addCrossLink({ fromUri: quotePost.uri, toUri: quotedPost.uri });
		}
	}

	// ---------- delete / recycle bin ----------
	function groupLabel(group: BoardGroup): string {
		return `@${group.author.handle} · ${previewText(group.thread.text, 40)}`;
	}

	function deletePost(group: BoardGroup, post: ThreadPost) {
		const layout = layouts.get(group.id);
		if (layout && layout.postCount <= 1) {
			deleteGroup(group);
			return;
		}
		binPosts = [
			{
				id: `bin-${nextBinId++}`,
				groupId: group.id,
				groupLabel: groupLabel(group),
				post,
				deletedAt: Date.now()
			},
			...binPosts
		];
		groups = groups.map((candidate) =>
			candidate.id === group.id
				? { ...candidate, deletedUris: new Set([...candidate.deletedUris, post.uri]) }
				: candidate
		);
	}

	function restoreBinPost(entry: BinPostEntry) {
		const group = groups.find((candidate) => candidate.id === entry.groupId);
		if (!group) {
			toastWarning('The thread this post belonged to is no longer on the whiteboard.');
			return;
		}
		groups = groups.map((candidate) => {
			if (candidate.id !== entry.groupId) return candidate;
			const next = new Set(candidate.deletedUris);
			next.delete(entry.post.uri);
			return { ...candidate, deletedUris: next };
		});
		binPosts = binPosts.filter((candidate) => candidate.id !== entry.id);
	}

	function deleteGroup(group: BoardGroup) {
		binGroups = [group, ...binGroups];
		groups = groups.filter((candidate) => candidate.id !== group.id);
		binPosts = binPosts.filter((candidate) => candidate.groupId !== group.id);
	}

	function restoreBinGroup(group: BoardGroup) {
		binGroups = binGroups.filter((candidate) => candidate.id !== group.id);
		// Its old spot may be occupied by now — restore to the nearest free one.
		const layout = group.expanded
			? layoutThreadGroup(group.thread, group.deletedUris)
			: layoutThreadStack(group.thread, group.deletedUris, group.chainIndex);
		const spot = findFreeSpot(
			layout.width,
			layout.height,
			group.x,
			group.y,
			groupRects(group.id),
			WHITEBOARD_GROUP_MARGIN
		);
		groups = [...groups, { ...group, x: spot.x, y: spot.y }];
	}

	// ---------- board-wide search / filters ----------
	let sidebarOpen = $state(true);
	let sidebarTab = $state<'filter' | 'threads'>('filter');
	let boardQuery = $state('');
	let boardSearchInputEl: HTMLInputElement | undefined = $state();
	let authorFilterDids = $state(new Set<string>());
	let filterHasMedia = $state(false);
	let filterHasQuote = $state(false);
	let filterHasLink = $state(false);
	let minLikes = $state(0);
	let hideNonMatching = $state(false);
	let threadSort = $state<'added' | 'author' | 'size'>('added');
	let showHelp = $state(false);

	type ParsedQuery = { terms: string[]; fromTerms: string[] };
	const parsedQuery = $derived.by((): ParsedQuery => {
		const terms: string[] = [];
		const fromTerms: string[] = [];
		for (const raw of boardQuery.toLowerCase().split(/\s+/)) {
			const token = raw.trim();
			if (!token) continue;
			if (token.startsWith('from:')) {
				const value = token.slice(5).replace(/^@/, '');
				if (value) fromTerms.push(value);
			} else {
				terms.push(token);
			}
		}
		return { terms, fromTerms };
	});

	const filtersActive = $derived(
		parsedQuery.terms.length > 0 ||
			parsedQuery.fromTerms.length > 0 ||
			authorFilterDids.size > 0 ||
			filterHasMedia ||
			filterHasQuote ||
			filterHasLink ||
			minLikes > 0
	);

	function postMatchesFilters(post: ThreadPost): boolean {
		if (authorFilterDids.size > 0 && !authorFilterDids.has(post.author.did)) return false;
		if (filterHasMedia && !(post.embed?.images?.length || post.embed?.video)) return false;
		if (filterHasQuote && !post.embed?.record) return false;
		if (filterHasLink && !post.embed?.external) return false;
		if (minLikes > 0 && post.likeCount < minLikes) return false;
		if (parsedQuery.fromTerms.length > 0) {
			const handle = post.author.handle.toLowerCase();
			const name = (post.author.displayName ?? '').toLowerCase();
			if (!parsedQuery.fromTerms.some((term) => handle.includes(term) || name.includes(term))) {
				return false;
			}
		}
		if (parsedQuery.terms.length > 0) {
			const haystack = `${post.text ?? ''}\n${post.author.handle}\n${post.author.displayName ?? ''}\n${post.embed?.record?.text ?? ''}\n${post.embed?.external?.title ?? ''}`.toLowerCase();
			if (!parsedQuery.terms.every((term) => haystack.includes(term))) return false;
		}
		return true;
	}

	type BoardMatch = { groupId: string; uri: string; post: ThreadPost };
	const matchInfo = $derived.by(() => {
		if (!filtersActive) {
			return {
				matchedUris: null as Set<string> | null,
				groupCounts: null as Map<string, number> | null,
				ordered: [] as BoardMatch[]
			};
		}
		const matchedUris = new Set<string>();
		const groupCounts = new Map<string, number>();
		const ordered: BoardMatch[] = [];
		for (const group of groups) {
			const posts = groupPosts.get(group.id) ?? [];
			let count = 0;
			for (const post of posts) {
				if (postMatchesFilters(post)) {
					matchedUris.add(post.uri);
					ordered.push({ groupId: group.id, uri: post.uri, post });
					count += 1;
				}
			}
			groupCounts.set(group.id, count);
		}
		return { matchedUris, groupCounts, ordered };
	});

	// Groups removed from the canvas entirely when "hide non-matching" is on.
	const hiddenGroupIds = $derived.by(() => {
		const hidden = new Set<string>();
		if (!filtersActive || !hideNonMatching || !matchInfo.groupCounts) return hidden;
		for (const [groupId, count] of matchInfo.groupCounts) {
			if (count === 0) hidden.add(groupId);
		}
		return hidden;
	});

	// ---------- match navigation ----------
	let matchCursor = $state(-1);
	let flashUri = $state<string | null>(null);
	let flashTimer: ReturnType<typeof setTimeout> | undefined;

	// Any filter change invalidates the cursor.
	$effect(() => {
		void matchInfo;
		matchCursor = -1;
	});

	function flashCard(uri: string) {
		flashUri = uri;
		clearTimeout(flashTimer);
		flashTimer = setTimeout(() => (flashUri = null), 1600);
	}

	function centerViewportOn(worldX: number, worldY: number, minZoom = 0.5) {
		if (!viewportEl) return;
		const rect = viewportEl.getBoundingClientRect();
		if (zoom < minZoom) zoom = minZoom;
		panX = rect.width / 2 - worldX * zoom;
		panY = rect.height / 2 - worldY * zoom;
	}

	function jumpToCard(groupId: string, uri: string) {
		let group = groupById.get(groupId);
		if (!group) return;
		let card = layouts.get(groupId)?.cardByUri.get(uri);
		if (!card && !group.expanded) {
			// The post lives on a hidden stack branch — switch the group's lane
			// to the one that contains it.
			const idx = chainIndexForUri(group.thread, uri, group.deletedUris);
			if (idx !== null) {
				replaceGroupResized(groupId, { chainIndex: idx });
				group = groupById.get(groupId);
				card = layouts.get(groupId)?.cardByUri.get(uri);
			}
		}
		if (!group || !card) return;
		centerViewportOn(
			group.x + card.x + WHITEBOARD_CARD_WIDTH / 2,
			group.y + card.y + WHITEBOARD_CARD_HEIGHT / 2
		);
		flashCard(uri);
	}

	function stepMatch(delta: number) {
		const matches = matchInfo.ordered;
		if (matches.length === 0) return;
		matchCursor = ((matchCursor + delta) % matches.length + matches.length) % matches.length;
		const match = matches[matchCursor];
		jumpToCard(match.groupId, match.uri);
	}

	function clearAllFilters() {
		boardQuery = '';
		authorFilterDids = new Set();
		filterHasMedia = false;
		filterHasQuote = false;
		filterHasLink = false;
		minLikes = 0;
	}

	// ---------- author roster + board stats ----------
	type BoardAuthor = { did: string; author: ThreadPost['author']; count: number };
	const boardAuthors = $derived.by(() => {
		const byDid = new Map<string, BoardAuthor>();
		for (const posts of groupPosts.values()) {
			for (const post of posts) {
				const entry = byDid.get(post.author.did);
				if (entry) entry.count += 1;
				else byDid.set(post.author.did, { did: post.author.did, author: post.author, count: 1 });
			}
		}
		return Array.from(byDid.values()).sort((a, b) => {
			if (b.count !== a.count) return b.count - a.count;
			return a.author.handle.localeCompare(b.author.handle);
		});
	});

	const boardStats = $derived.by(() => {
		let posts = 0;
		for (const list of groupPosts.values()) posts += list.length;
		return { threads: groups.length, posts, authors: boardAuthors.length };
	});

	function toggleAuthorFilter(did: string) {
		const next = new Set(authorFilterDids);
		if (next.has(did)) next.delete(did);
		else next.add(did);
		authorFilterDids = next;
	}

	function soloAuthorFilter(did: string) {
		authorFilterDids = authorFilterDids.size === 1 && authorFilterDids.has(did)
			? new Set()
			: new Set([did]);
	}

	const sortedThreadGroups = $derived.by(() => {
		const list = [...groups];
		if (threadSort === 'author') {
			list.sort((a, b) => a.author.handle.localeCompare(b.author.handle) || a.addedAt - b.addedAt);
		} else if (threadSort === 'size') {
			list.sort(
				(a, b) =>
					(groupPosts.get(b.id)?.length ?? 0) - (groupPosts.get(a.id)?.length ?? 0) ||
					a.addedAt - b.addedAt
			);
		} else {
			list.sort((a, b) => b.addedAt - a.addedAt);
		}
		return list;
	});

	// ---------- hotkeys ----------
	let hoveredGroupId = $state<string | null>(null);
	const hotkeyTargetGroup = $derived(hoveredGroupId ? groupById.get(hoveredGroupId) : undefined);

	function handleKeydown(event: KeyboardEvent) {
		const target = event.target as HTMLElement | null;
		if (target?.closest('input, textarea, select, [contenteditable="true"]')) {
			if (event.key === 'Escape') (target as HTMLElement).blur();
			return;
		}
		if (searchDialogEl?.open || event.metaKey || event.ctrlKey || event.altKey) return;
		switch (event.key) {
			case '/':
				event.preventDefault();
				sidebarOpen = true;
				sidebarTab = 'filter';
				requestAnimationFrame(() => boardSearchInputEl?.focus());
				break;
			case 'n':
				stepMatch(1);
				break;
			case 'N':
			case 'p':
				stepMatch(-1);
				break;
			case 'e':
				if (hotkeyTargetGroup) toggleGroupExpanded(hotkeyTargetGroup);
				break;
			case 'E':
				setAllExpanded(true);
				break;
			case 'C':
				setAllExpanded(false);
				break;
			case ']':
				if (hotkeyTargetGroup) cycleChain(hotkeyTargetGroup, 1);
				break;
			case '[':
				if (hotkeyTargetGroup) cycleChain(hotkeyTargetGroup, -1);
				break;
			case 'f':
				fitBoard();
				break;
			case 't':
				tidyBoard();
				break;
			case 'b':
				sidebarOpen = !sidebarOpen;
				break;
			case '+':
			case '=':
				zoomBy(1.2);
				break;
			case '-':
				zoomBy(1 / 1.2);
				break;
			case '?':
				showHelp = !showHelp;
				break;
			case 'Escape':
				if (showHelp) showHelp = false;
				else if (filtersActive) clearAllFilters();
				break;
		}
	}

	// ---------- canvas pan / zoom / drag ----------
	let viewportEl: HTMLDivElement | undefined = $state();
	let panX = $state(80);
	let panY = $state(80);
	let zoom = $state(0.55);
	let isPanning = $state(false);
	let draggingGroupId: string | null = $state(null);
	let dragPointer = { x: 0, y: 0 };
	let dragOrigin = { x: 0, y: 0 };
	let viewportSize = $state({ w: 1200, h: 700 });

	function handleViewportPointerDown(event: PointerEvent) {
		const target = event.target as HTMLElement;
		if (target.closest('.board-overlay')) return;
		if (event.button === 1) {
			// Middle (wheel) click pans from anywhere, even over thread groups.
			event.preventDefault();
		} else if (event.button !== 0 || target.closest('[data-board-group]')) {
			return;
		}
		isPanning = true;
		dragPointer = { x: event.clientX, y: event.clientY };
		dragOrigin = { x: panX, y: panY };
		(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
	}

	function handleGroupPointerDown(event: PointerEvent, group: BoardGroup) {
		if (event.button !== 0) return;
		const target = event.target as HTMLElement;
		// A plain click-drag anywhere on the group moves it; only interactive
		// elements and the scrollable/selectable text area are exempt.
		if (target.closest('button, a, input, select, textarea, video, .wb-card-scroll')) return;
		event.stopPropagation();
		draggingGroupId = group.id;
		dragPointer = { x: event.clientX, y: event.clientY };
		dragOrigin = { x: group.x, y: group.y };
		(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
	}

	function handlePointerMove(event: PointerEvent) {
		if (isPanning) {
			panX = dragOrigin.x + (event.clientX - dragPointer.x);
			panY = dragOrigin.y + (event.clientY - dragPointer.y);
		} else if (draggingGroupId) {
			const dx = (event.clientX - dragPointer.x) / zoom;
			const dy = (event.clientY - dragPointer.y) / zoom;
			groups = groups.map((candidate) =>
				candidate.id === draggingGroupId
					? { ...candidate, x: dragOrigin.x + dx, y: dragOrigin.y + dy }
					: candidate
			);
		}
	}

	function handlePointerUp() {
		if (draggingGroupId) {
			// Overlaps are never allowed: nudge the dropped group to the
			// nearest free spot if it landed on another group.
			const id = draggingGroupId;
			const group = groupById.get(id);
			const layout = layouts.get(id);
			if (group && layout) {
				const spot = findFreeSpot(
					layout.width,
					layout.height,
					group.x,
					group.y,
					groupRects(id),
					WHITEBOARD_GROUP_MARGIN
				);
				if (spot.x !== group.x || spot.y !== group.y) {
					groups = groups.map((candidate) =>
						candidate.id === id ? { ...candidate, x: spot.x, y: spot.y } : candidate
					);
				}
			}
		}
		isPanning = false;
		draggingGroupId = null;
	}

	function zoomAt(clientX: number, clientY: number, nextZoom: number) {
		const clamped = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, nextZoom));
		if (!viewportEl) {
			zoom = clamped;
			return;
		}
		const rect = viewportEl.getBoundingClientRect();
		const sx = clientX - rect.left;
		const sy = clientY - rect.top;
		const worldX = (sx - panX) / zoom;
		const worldY = (sy - panY) / zoom;
		zoom = clamped;
		panX = sx - worldX * zoom;
		panY = sy - worldY * zoom;
	}

	function handleWheel(event: WheelEvent) {
		event.preventDefault();
		if (event.ctrlKey || event.metaKey) {
			const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12;
			zoomAt(event.clientX, event.clientY, zoom * factor);
		} else {
			panX -= event.deltaX;
			panY -= event.deltaY;
		}
	}

	function zoomBy(factor: number) {
		if (!viewportEl) return;
		const rect = viewportEl.getBoundingClientRect();
		zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, zoom * factor);
	}

	const worldBounds = $derived.by(() => {
		if (groups.length === 0) {
			return { minX: 0, minY: 0, maxX: 1600, maxY: 1000 };
		}
		let minX = Infinity;
		let minY = Infinity;
		let maxX = -Infinity;
		let maxY = -Infinity;
		for (const group of groups) {
			const layout = layouts.get(group.id);
			minX = Math.min(minX, group.x);
			minY = Math.min(minY, group.y);
			maxX = Math.max(maxX, group.x + (layout?.width ?? WHITEBOARD_CARD_WIDTH));
			maxY = Math.max(maxY, group.y + (layout?.height ?? WHITEBOARD_CARD_HEIGHT));
		}
		return { minX, minY, maxX, maxY };
	});

	// ---------- render culling ----------
	// Only mount DOM for groups that intersect the viewport (plus a margin).
	const CULL_PAD = 300;
	const renderGroups = $derived.by(() => {
		const minX = -panX / zoom - CULL_PAD;
		const minY = -panY / zoom - CULL_PAD;
		const maxX = (viewportSize.w - panX) / zoom + CULL_PAD;
		const maxY = (viewportSize.h - panY) / zoom + CULL_PAD;
		return groups.filter((group) => {
			if (hiddenGroupIds.has(group.id)) return false;
			const layout = layouts.get(group.id);
			const w = layout?.width ?? WHITEBOARD_CARD_WIDTH;
			const h = layout?.height ?? WHITEBOARD_CARD_HEIGHT;
			return group.x < maxX && group.x + w > minX && group.y < maxY && group.y + h > minY;
		});
	});

	function fitBoard() {
		if (!viewportEl || groups.length === 0) return;
		const bounds = worldBounds;
		const rect = viewportEl.getBoundingClientRect();
		const pad = 80;
		const w = bounds.maxX - bounds.minX + pad * 2;
		const h = bounds.maxY - bounds.minY + pad * 2;
		zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.min(rect.width / w, rect.height / h)));
		panX = -((bounds.minX - pad) * zoom) + (rect.width - w * zoom) / 2;
		panY = -((bounds.minY - pad) * zoom) + (rect.height - h * zoom) / 2;
	}

	function jumpToGroup(group: BoardGroup) {
		if (!viewportEl) return;
		const rect = viewportEl.getBoundingClientRect();
		const layout = layouts.get(group.id);
		const cx = group.x + (layout?.width ?? WHITEBOARD_CARD_WIDTH) / 2;
		const cy = group.y + Math.min(layout?.height ?? WHITEBOARD_CARD_HEIGHT, rect.height / zoom) / 2;
		panX = rect.width / 2 - cx * zoom;
		panY = rect.height / 2 - cy * zoom;
	}

	// ---------- minimap ----------
	let minimapCanvas: HTMLCanvasElement | undefined = $state();
	let minimapDragging = false;

	const minimapModel = $derived.by(() => {
		const bounds = worldBounds;
		const pad = 300;
		const minX = bounds.minX - pad;
		const minY = bounds.minY - pad;
		const w = bounds.maxX - bounds.minX + pad * 2;
		const h = bounds.maxY - bounds.minY + pad * 2;
		const scale = Math.min(MINIMAP_W / w, MINIMAP_H / h);
		return { minX, minY, scale };
	});

	let minimapRaf = 0;
	$effect(() => {
		const canvas = minimapCanvas;
		if (!canvas) return;
		// Track reactive deps explicitly so the minimap redraws on every change.
		const model = minimapModel;
		const currentGroups = groups;
		const currentLayouts = layouts;
		const counts = matchInfo.groupCounts;
		const hidden = hiddenGroupIds;
		const vp = viewportSize;
		const px = panX;
		const py = panY;
		const z = zoom;

		// Coalesce redraws to one per frame — pans/drags fire many state
		// updates per frame and the minimap repaint is the expensive part.
		cancelAnimationFrame(minimapRaf);
		minimapRaf = requestAnimationFrame(() => {
			const ctx = canvas.getContext('2d');
			if (!ctx) return;
			const dpr = window.devicePixelRatio || 1;
			canvas.width = MINIMAP_W * dpr;
			canvas.height = MINIMAP_H * dpr;
			ctx.scale(dpr, dpr);
			ctx.clearRect(0, 0, MINIMAP_W, MINIMAP_H);

			for (const group of currentGroups) {
				if (hidden.has(group.id)) continue;
				const layout = currentLayouts.get(group.id);
				ctx.fillStyle = authorColor(group.columnAuthor.did);
				ctx.globalAlpha = counts && (counts.get(group.id) ?? 0) === 0 ? 0.18 : 0.85;
				ctx.fillRect(
					(group.x - model.minX) * model.scale,
					(group.y - model.minY) * model.scale,
					Math.max(3, (layout?.width ?? WHITEBOARD_CARD_WIDTH) * model.scale),
					Math.max(3, (layout?.height ?? WHITEBOARD_CARD_HEIGHT) * model.scale)
				);
			}
			ctx.globalAlpha = 1;

			// viewport rectangle
			const viewX = (-px / z - model.minX) * model.scale;
			const viewY = (-py / z - model.minY) * model.scale;
			const viewW = (vp.w / z) * model.scale;
			const viewH = (vp.h / z) * model.scale;
			ctx.strokeStyle = 'rgba(80, 80, 90, 0.95)';
			ctx.lineWidth = 1.5;
			ctx.strokeRect(viewX, viewY, viewW, viewH);
		});
		return () => cancelAnimationFrame(minimapRaf);
	});

	function minimapJump(event: PointerEvent) {
		if (!viewportEl || !minimapCanvas) return;
		const rect = minimapCanvas.getBoundingClientRect();
		const model = minimapModel;
		const worldX = (event.clientX - rect.left) / model.scale + model.minX;
		const worldY = (event.clientY - rect.top) / model.scale + model.minY;
		const view = viewportEl.getBoundingClientRect();
		panX = view.width / 2 - worldX * zoom;
		panY = view.height / 2 - worldY * zoom;
	}

	function handleMinimapPointerDown(event: PointerEvent) {
		event.stopPropagation();
		minimapDragging = true;
		(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
		minimapJump(event);
	}
	function handleMinimapPointerMove(event: PointerEvent) {
		if (minimapDragging) minimapJump(event);
	}
	function handleMinimapPointerUp() {
		minimapDragging = false;
	}

	// ---------- misc helpers ----------
	function formatDate(iso: string): string {
		const date = new Date(iso);
		if (Number.isNaN(date.getTime())) return '';
		return date.toLocaleDateString(undefined, {
			year: 'numeric',
			month: 'short',
			day: 'numeric'
		});
	}

	function formatCount(n: number): string {
		if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`;
		return String(n);
	}

	function openImage(image: EmbedImage) {
		openLightbox(image.fullsize || image.thumb, image.alt);
	}

	function connectorPath(x1: number, y1: number, x2: number, y2: number): string {
		const midY = (y1 + y2) / 2;
		return `M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}`;
	}

	function crossLinkPath(line: { x1: number; y1: number; x2: number; y2: number }): string {
		const dx = (line.x2 - line.x1) / 2;
		return `M ${line.x1} ${line.y1} C ${line.x1 + dx} ${line.y1}, ${line.x2 - dx} ${line.y2}, ${line.x2} ${line.y2}`;
	}

	onMount(() => {
		// atproto loopback OAuth normalizes redirect URIs onto 127.0.0.1; the sign-in
		// popup can only post back to a same-origin opener, so leave `localhost` first.
		if (window.location.hostname === 'localhost') {
			window.location.replace(window.location.href.replace('//localhost', '//127.0.0.1'));
			return;
		}

		try {
			const saved = localStorage.getItem('preferred-font');
			if (saved && saved in fontFamilies) fontKey = saved;
		} catch {}

		restoreSession();

		const observer = new ResizeObserver(() => {
			if (!viewportEl) return;
			const rect = viewportEl.getBoundingClientRect();
			viewportSize = { w: rect.width, h: rect.height };
		});
		if (viewportEl) observer.observe(viewportEl);
		return () => observer.disconnect();
	});
</script>

<svelte:head>
	<title>Whiteboard</title>
</svelte:head>

<svelte:window
	onpointermove={handlePointerMove}
	onpointerup={handlePointerUp}
	onkeydown={handleKeydown}
/>

<div class="page" style={`font-family: ${fontFamily}`}>
	<header class="topbar">
		<RouteNav current="whiteboard" compact />
		<div class="topbar-row">
			<h1>Whiteboard</h1>
			<div class="topbar-actions">
				<FontPicker value={fontKey} onchange={handleFontChange} />
				{#if authProfile}
					<span class="auth-chip wobbly-border-light">
						{#if authProfile.avatar}
							<img class="auth-avatar" src={authProfile.avatar} alt={authProfile.handle} />
						{/if}
						@{authProfile.handle}
						<button type="button" class="mini-btn" onclick={handleDisconnect}>Disconnect</button>
					</span>
				{:else}
					<button
						type="button"
						class="action-btn wobbly-border"
						onclick={handleConnect}
						disabled={connecting || restoringSession}
					>
						{connecting
							? 'Connecting…'
							: restoringSession
								? 'Restoring session…'
								: 'Connect Bluesky'}
					</button>
				{/if}
				<button type="button" class="action-btn wobbly-border" onclick={openSearchDialog}>
					🔍 Search posts
				</button>
				<form
					class="insert-form"
					onsubmit={(event) => {
						event.preventDefault();
						void insertPostUrl();
					}}
				>
					<input
						type="text"
						class="insert-input wobbly-border-light"
						bind:value={insertUrlInput}
						placeholder="Paste a bsky.app post URL…"
						disabled={insertingUrl}
					/>
					<button
						type="submit"
						class="action-btn wobbly-border"
						disabled={insertingUrl || !insertUrlInput.trim()}
					>
						{insertingUrl ? 'Adding…' : 'Add'}
					</button>
				</form>
				<button
					type="button"
					class="action-btn wobbly-border-light"
					onclick={() => (showBinPanel = !showBinPanel)}
				>
					🗑 Bin ({binPosts.length + binGroups.length})
				</button>
				<button
					type="button"
					class="action-btn wobbly-border-light"
					title="Toggle the board panel (b)"
					onclick={() => (sidebarOpen = !sidebarOpen)}
				>
					{sidebarOpen ? '◧ Panel' : '□ Panel'}
				</button>
				<button
					type="button"
					class="action-btn wobbly-border-light"
					title="Keyboard shortcuts (?)"
					onclick={() => (showHelp = !showHelp)}
				>
					⌨ Keys
				</button>
			</div>
		</div>
	</header>

	<div class="main-row">
	{#if sidebarOpen}
		<aside class="side-panel">
			<nav class="side-tabs">
				<button
					type="button"
					class="side-tab"
					class:active={sidebarTab === 'filter'}
					onclick={() => (sidebarTab = 'filter')}
				>
					Filter
				</button>
				<button
					type="button"
					class="side-tab"
					class:active={sidebarTab === 'threads'}
					onclick={() => (sidebarTab = 'threads')}
				>
					Threads ({groups.length})
				</button>
				<button
					type="button"
					class="side-tab side-tab-hide"
					title="Hide the side panel (b)"
					onclick={() => (sidebarOpen = false)}
				>
					✕
				</button>
			</nav>

			<p class="side-stats">
				{boardStats.threads} thread{boardStats.threads === 1 ? '' : 's'} ·
				{boardStats.posts} post{boardStats.posts === 1 ? '' : 's'} ·
				{boardStats.authors} author{boardStats.authors === 1 ? '' : 's'}
			</p>

			{#if sidebarTab === 'filter'}
				<div class="side-section">
					<input
						type="search"
						class="side-search wobbly-border-light"
						bind:this={boardSearchInputEl}
						bind:value={boardQuery}
						placeholder="Filter board… (text, from:handle)"
						onkeydown={(event) => {
							if (event.key === 'Enter') {
								event.preventDefault();
								stepMatch(event.shiftKey ? -1 : 1);
							}
						}}
					/>
					{#if filtersActive}
						<div class="match-bar">
							<span class="match-count">
								{matchInfo.ordered.length} match{matchInfo.ordered.length === 1 ? '' : 'es'}
								{#if matchCursor >= 0}· {matchCursor + 1}/{matchInfo.ordered.length}{/if}
							</span>
							<button type="button" class="mini-btn" title="Previous match (p)" onclick={() => stepMatch(-1)}>‹</button>
							<button type="button" class="mini-btn" title="Next match (n)" onclick={() => stepMatch(1)}>›</button>
							<button type="button" class="mini-btn" onclick={clearAllFilters}>Clear</button>
						</div>
					{/if}
					<div class="side-options">
						<label class="side-option">
							<input type="checkbox" bind:checked={hideNonMatching} />
							Hide non-matching threads
						</label>
						<label class="side-option">
							<input type="checkbox" bind:checked={filterHasMedia} />
							Has image / video
						</label>
						<label class="side-option">
							<input type="checkbox" bind:checked={filterHasQuote} />
							Has quote
						</label>
						<label class="side-option">
							<input type="checkbox" bind:checked={filterHasLink} />
							Has link card
						</label>
						<label class="side-option side-option-inline">
							Min likes
							<input type="number" class="side-number" min="0" bind:value={minLikes} />
						</label>
					</div>
				</div>

				<div class="side-section">
					<header class="side-section-head">
						<strong>Authors on board</strong>
						{#if authorFilterDids.size > 0}
							<button type="button" class="mini-btn" onclick={() => (authorFilterDids = new Set())}>
								Show all
							</button>
						{/if}
					</header>
					<ul class="author-list">
						{#each boardAuthors as entry (entry.did)}
							{@const selected = authorFilterDids.has(entry.did)}
							<li class="author-row" class:selected>
								<button
									type="button"
									class="author-toggle"
									title="Toggle this author in the filter"
									onclick={() => toggleAuthorFilter(entry.did)}
								>
									<span class="author-dot" style={`background: ${authorColor(entry.did)}`}></span>
									{#if entry.author.avatar}
										<img class="author-avatar" src={entry.author.avatar} alt="" loading="lazy" />
									{/if}
									<span class="author-copy">
										@{entry.author.handle}
										<small>{entry.count} post{entry.count === 1 ? '' : 's'}</small>
									</span>
								</button>
								<button
									type="button"
									class="mini-btn"
									title="Only this author"
									onclick={() => soloAuthorFilter(entry.did)}
								>
									solo
								</button>
							</li>
						{/each}
						{#if boardAuthors.length === 0}
							<li class="side-empty">Nothing on the board yet.</li>
						{/if}
					</ul>
				</div>
			{:else}
				<div class="side-section">
					<header class="side-section-head">
						<label class="side-option side-option-inline">
							Sort
							<select bind:value={threadSort}>
								<option value="added">newest first</option>
								<option value="author">author</option>
								<option value="size">size</option>
							</select>
						</label>
						<span class="side-head-actions">
							<button type="button" class="mini-btn" title="Expand all (Shift+E)" onclick={() => setAllExpanded(true)}>⤢ all</button>
							<button type="button" class="mini-btn" title="Collapse all (Shift+C)" onclick={() => setAllExpanded(false)}>⤡ all</button>
							<button type="button" class="mini-btn" title="Tidy into author columns (t)" onclick={tidyBoard}>Tidy</button>
						</span>
					</header>
					<ul class="thread-list">
						{#each sortedThreadGroups as group (group.id)}
							{@const layout = layouts.get(group.id)}
							{@const matchCount = matchInfo.groupCounts?.get(group.id)}
							<li
								class="thread-row"
								class:thread-row-dim={filtersActive && matchCount === 0}
								style={`--group-accent: ${authorColor(group.columnAuthor.did)}`}
							>
								<button type="button" class="thread-jump" onclick={() => jumpToGroup(group)}>
									<span class="thread-accent"></span>
									{#if group.author.avatar}
										<img class="author-avatar" src={group.author.avatar} alt="" loading="lazy" />
									{/if}
									<span class="thread-copy">
										<strong>@{group.author.handle}</strong>
										<span class="thread-preview">{previewText(group.thread.text, 64)}</span>
										{#if group.thread.embed?.images?.length}
											<span class="thread-embed">
												{#each group.thread.embed.images.slice(0, 3) as img (img.thumb)}
													<img class="thread-embed-thumb" src={img.thumb} alt={img.alt} loading="lazy" decoding="async" />
												{/each}
											</span>
										{:else if group.thread.embed?.video}
											<span class="thread-embed">
												{#if group.thread.embed.video.thumbnail}
													<span class="thread-embed-video">
														<img class="thread-embed-thumb" src={group.thread.embed.video.thumbnail} alt="" loading="lazy" decoding="async" />
														<span class="thread-embed-play">▶</span>
													</span>
												{:else}
													<span class="thread-embed-note">▶ video</span>
												{/if}
											</span>
										{:else if group.thread.embed?.external}
											<span class="thread-embed thread-embed-external">
												{#if group.thread.embed.external.thumb}
													<img class="thread-embed-thumb" src={group.thread.embed.external.thumb} alt="" loading="lazy" decoding="async" />
												{/if}
												<span class="thread-embed-note">🔗 {previewText(group.thread.embed.external.title, 44)}</span>
											</span>
										{:else if group.thread.embed?.record}
											<span class="thread-embed">
												<span class="thread-embed-note">
													↩ quotes @{group.thread.embed.record.author.handle}: {previewText(group.thread.embed.record.text, 36)}
												</span>
											</span>
										{/if}
										<small>
											{groupPosts.get(group.id)?.length ?? 0} posts
											{#if !group.expanded && (layout?.chainCount ?? 1) > 1}
												· path {(layout?.activeChainIndex ?? 0) + 1}/{layout?.chainCount}
											{/if}
											{#if filtersActive && (matchCount ?? 0) > 0}
												· <mark>{matchCount} match{matchCount === 1 ? '' : 'es'}</mark>
											{/if}
										</small>
									</span>
								</button>
								<span class="thread-row-actions">
									<button
										type="button"
										class="mini-btn"
										title={group.expanded ? 'Collapse to one lane (e)' : 'Expand tree (e)'}
										onclick={() => toggleGroupExpanded(group)}
									>
										{group.expanded ? '⤡' : '⤢'}
									</button>
									<button type="button" class="mini-btn" title="Delete thread" onclick={() => deleteGroup(group)}>🗑</button>
								</span>
							</li>
						{/each}
						{#if groups.length === 0}
							<li class="side-empty">No threads on the board yet.</li>
						{/if}
					</ul>
				</div>
			{/if}
		</aside>
	{/if}

	<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
	<div
		class="board-viewport"
		bind:this={viewportEl}
		role="application"
		aria-label="Whiteboard canvas — drag or middle-click-drag to pan, scroll to pan, ctrl+scroll to zoom"
		onpointerdown={handleViewportPointerDown}
		onmousedown={(event) => {
			if (event.button === 1) event.preventDefault();
		}}
		onwheel={handleWheel}
		class:panning={isPanning}
		style={`background-position: ${panX}px ${panY}px; background-size: ${28 * zoom}px ${28 * zoom}px;`}
	>
		<div class="board-world" style={`transform: translate(${panX}px, ${panY}px) scale(${zoom});`}>
			<svg class="cross-links" aria-hidden="true">
				{#each visibleCrossLinks as line (line.id)}
					<path d={crossLinkPath(line)} class="cross-link-path"></path>
				{/each}
			</svg>

			{#each renderGroups as group (group.id)}
				{@const layout = layouts.get(group.id)}
				{#if layout}
					{@const totalPosts = groupPosts.get(group.id)?.length ?? layout.postCount}
					{@const groupMatches = matchInfo.groupCounts?.get(group.id)}
					<section
						class="board-group"
						data-board-group
						role="group"
						aria-label={`Thread by @${group.author.handle}`}
						class:dragging={draggingGroupId === group.id}
						class:group-dim={filtersActive && groupMatches === 0}
						style={`left: ${group.x}px; top: ${group.y}px; width: ${layout.width}px; height: ${layout.height}px; --group-accent: ${authorColor(group.columnAuthor.did)};`}
						onpointerdown={(event) => handleGroupPointerDown(event, group)}
						onpointerenter={() => (hoveredGroupId = group.id)}
						onpointerleave={() => {
							if (hoveredGroupId === group.id) hoveredGroupId = null;
						}}
					>
						<header class="group-head">
							<span class="group-grip" title="Drag to move this thread">⠿</span>
							{#if group.author.avatar}
								<img class="group-avatar" src={group.author.avatar} alt="" />
							{/if}
							<span class="group-title">
								@{group.author.handle}
								<small>
									{#if !group.expanded && layout.postCount !== totalPosts}
										{layout.postCount}/{totalPosts} posts
									{:else}
										{totalPosts} post{totalPosts === 1 ? '' : 's'}
									{/if}
									{#if group.isTruncated}· partial{/if}
								</small>
							</span>
							{#if filtersActive && (groupMatches ?? 0) > 0}
								<span class="group-match-chip">{groupMatches}✓</span>
							{/if}
							{#if !group.expanded && (layout.chainCount ?? 1) > 1}
								<span class="group-chain-pager" title="Cycle reply paths ( [ and ] )">
									<button type="button" class="group-btn" onclick={() => cycleChain(group, -1)}>‹</button>
									<span class="group-chain-info">
										{(layout.activeChainIndex ?? 0) + 1}/{layout.chainCount}
									</span>
									<button type="button" class="group-btn" onclick={() => cycleChain(group, 1)}>›</button>
								</span>
							{/if}
							<button
								type="button"
								class="group-btn"
								title={group.expanded
									? 'Collapse to a single reply lane (e)'
									: 'Expand the full reply tree (e)'}
								onclick={() => toggleGroupExpanded(group)}
							>
								{group.expanded ? '⤡' : '⤢'}
							</button>
							<button
								type="button"
								class="group-btn"
								title="Delete this thread (goes to the recycle bin)"
								onclick={() => deleteGroup(group)}
							>
								🗑
							</button>
						</header>

						{#if !group.expanded}
							{#each layout.branchBadges ?? [] as badge (badge.uri)}
								<button
									type="button"
									class="branch-badge"
									style={`left: ${badge.x}px; top: ${badge.y - 16}px;`}
									title={`${badge.hiddenCount} hidden repl${badge.hiddenCount === 1 ? 'y branch' : 'y branches'} — click to show the next one ( ] )`}
									onclick={() => jumpChain(group, badge.nextChainIndex)}
								>
									⑂ +{badge.hiddenCount}
								</button>
							{/each}
						{/if}

						<svg class="group-connectors" width={layout.width} height={layout.height} aria-hidden="true">
							{#each layout.connectors as connector (connector.key)}
								<path d={connectorPath(connector.x1, connector.y1, connector.x2, connector.y2)} class="group-connector-path"></path>
							{/each}
						</svg>

						{#each layout.cards as card (card.post.uri)}
							{@const post = card.post}
							{@const bskyUrl = buildBskyPostUrl(post.uri, post.author.handle)}
							<article
								class="wb-card wobbly-border-light"
								class:focus-card={group.focusUri === post.uri}
								class:card-match={matchInfo.matchedUris?.has(post.uri)}
								class:card-dim={filtersActive && !matchInfo.matchedUris?.has(post.uri)}
								class:card-flash={flashUri === post.uri}
								style={`left: ${card.x}px; top: ${card.y}px;`}
							>
								<div class="wb-card-author">
									{#if post.author.avatar}
										<img class="wb-avatar" src={post.author.avatar} alt="" loading="lazy" decoding="async" />
									{/if}
									<div class="wb-author-copy">
										<strong class="wb-handle">@{post.author.handle}</strong>
										<span class="wb-date">{formatDate(post.createdAt)}</span>
									</div>
									<button
										type="button"
										class="wb-icon-btn"
										title="Delete this post (goes to the recycle bin)"
										onclick={() => deletePost(group, post)}
									>
										✕
									</button>
								</div>

								<div class="wb-badges">
									<span>{formatCount(post.replyCount)} replies</span>
									{#if post.quoteCount > 0}<span>{formatCount(post.quoteCount)} quotes</span>{/if}
									<span>{formatCount(post.likeCount)} likes</span>
								</div>

								<div class="wb-card-scroll">
									<p class="wb-text">{post.text}</p>

									{#if post.embed?.images}
										<div class="wb-media-grid">
											{#each post.embed.images as img}
												<button type="button" class="wb-media-btn" onclick={() => openImage(img)}>
													<img src={img.thumb} alt={img.alt} class="wb-media-thumb" loading="lazy" decoding="async" />
												</button>
											{/each}
										</div>
									{/if}

									{#if post.embed?.video}
										<video
											class="wb-video"
											controls
											playsinline
											preload="metadata"
											poster={post.embed.video.thumbnail}
											onpointerdown={(event) => event.stopPropagation()}
										>
											<source src={post.embed.video.playlist} type="application/x-mpegURL" />
										</video>
									{/if}

									{#if post.embed?.external}
										<div class="wb-external">
											{#if post.embed.external.thumb}
												<img src={post.embed.external.thumb} alt="" class="wb-external-thumb" />
											{/if}
											<div class="wb-external-copy">
												<strong>{post.embed.external.title}</strong>
												<span>{post.embed.external.description}</span>
											</div>
										</div>
									{/if}

									{#if post.embed?.record}
										<div class="wb-quote">
											<div class="wb-quote-head">
												{#if post.embed.record.author.avatar}
													<img class="wb-quote-avatar" src={post.embed.record.author.avatar} alt="" />
												{/if}
												<span class="wb-quote-kicker">Quotes @{post.embed.record.author.handle}</span>
											</div>
											<p class="wb-quote-text">
												{post.embed.record.text?.trim() || 'Quoted post preview is sparse.'}
											</p>
											{#if post.embed.record.images}
												<div class="wb-media-grid">
													{#each post.embed.record.images as img}
														<button type="button" class="wb-media-btn" onclick={() => openImage(img)}>
															<img src={img.thumb} alt={img.alt} class="wb-media-thumb" loading="lazy" decoding="async" />
														</button>
													{/each}
												</div>
											{/if}
										</div>
									{/if}

									{#if openQuotePickerUri === post.uri}
										{@const feed = quoteFeeds[post.uri]}
										<div class="wb-quote-picker">
											{#if !feed || feed.status === 'loading'}
												<p class="wb-picker-note">Loading quote posts…</p>
											{:else if feed.status === 'error'}
												<p class="wb-picker-note wb-picker-error">{feed.error}</p>
											{:else if feed.posts.length === 0}
												<p class="wb-picker-note">No quote posts found.</p>
											{:else}
												{#each feed.posts as quotePost (quotePost.uri)}
													<div class="wb-picker-row">
														<span class="wb-picker-copy">
															<strong>@{quotePost.author.handle}</strong>
															{previewText(quotePost.text, 56)}
														</span>
														<button
															type="button"
															class="wb-action-btn"
															disabled={boardHasPost(quotePost.uri)}
															onclick={() => boardQuotePost(group, post, quotePost)}
														>
															{boardHasPost(quotePost.uri) ? 'On board' : 'Board'}
														</button>
													</div>
												{/each}
											{/if}
										</div>
									{/if}
								</div>

								<div class="wb-card-actions">
									{#if post.embed?.record}
										<button
											type="button"
											class="wb-action-btn"
											title="Fetch the quoted post's whole thread onto the whiteboard"
											onclick={() => fetchQuotedThread(group, post)}
										>
											{boardHasPost(post.embed.record.uri) ? 'Link quoted' : 'Quoted thread'}
										</button>
									{/if}
									{#if post.quoteCount > 0}
										<button
											type="button"
											class="wb-action-btn"
											title="List posts that quote this one"
											onclick={() => toggleQuotePicker(post)}
										>
											{openQuotePickerUri === post.uri ? 'Hide quotes' : 'Quote posts'}
										</button>
									{/if}
									{#if bskyUrl}
										<a class="wb-action-btn wb-action-link" href={bskyUrl} target="_blank" rel="noreferrer noopener">
											Open ↗
										</a>
									{/if}
								</div>
							</article>
						{/each}
					</section>
				{/if}
			{/each}
		</div>

		{#if groups.length === 0}
			<div class="board-empty board-overlay">
				<p>The whiteboard is empty.</p>
				<p>
					Connect your Bluesky account and search posts (optionally only from your follows), or
					paste a bsky.app post URL up top — whole threads land on the board. Drag thread groups
					anywhere, delete posts into the recycle bin, and pull in quoted threads and quote posts.
				</p>
				<button type="button" class="action-btn wobbly-border" onclick={openSearchDialog}>
					🔍 Search posts
				</button>
			</div>
		{/if}

		<div class="zoom-controls board-overlay wobbly-border-light">
			<button type="button" class="mini-btn" onclick={() => zoomBy(1.2)} title="Zoom in">+</button>
			<span class="zoom-value">{Math.round(zoom * 100)}%</span>
			<button type="button" class="mini-btn" onclick={() => zoomBy(1 / 1.2)} title="Zoom out">−</button>
			<button type="button" class="mini-btn" onclick={fitBoard} title="Fit all threads">Fit</button>
		</div>

		<div class="minimap board-overlay wobbly-border-light">
			<canvas
				bind:this={minimapCanvas}
				style={`width: ${MINIMAP_W}px; height: ${MINIMAP_H}px;`}
				onpointerdown={handleMinimapPointerDown}
				onpointermove={handleMinimapPointerMove}
				onpointerup={handleMinimapPointerUp}
			></canvas>
		</div>

		{#if queue.length > 0}
			<aside class="queue-panel board-overlay wobbly-border-light">
				<header class="queue-head">
					<button type="button" class="queue-toggle" onclick={() => (showQueuePanel = !showQueuePanel)}>
						{showQueuePanel ? '▾' : '▸'} Fetch queue
					</button>
					<span class="queue-counts">
						{queueCounts.pending + queueCounts.running} active · {queueCounts.done} done
						{#if queueCounts.skipped > 0}· {queueCounts.skipped} skipped{/if}
						{#if queueCounts.error > 0}· <span class="queue-error-count">{queueCounts.error} failed</span>{/if}
					</span>
				</header>
				{#if backoffWorkers > 0}
					<p class="queue-rate">⏳ Rate limited — backing off ({backoffWorkers} waiting)</p>
				{:else if rateLimitHits > 0}
					<p class="queue-rate queue-rate-quiet">{rateLimitHits} rate-limit retr{rateLimitHits === 1 ? 'y' : 'ies'} so far</p>
				{/if}
				{#if showQueuePanel}
					<div class="queue-actions">
						<button type="button" class="mini-btn" onclick={() => (queuePaused = !queuePaused)}>
							{queuePaused ? 'Resume' : 'Pause'}
						</button>
						<button type="button" class="mini-btn" onclick={clearFinishedQueueItems}>Clear finished</button>
					</div>
					<ul class="queue-list">
						{#each [...queue].reverse().slice(0, 40) as item (item.id)}
							<li class={`queue-item queue-item-${item.status}`}>
								<span class="queue-status-dot" title={item.status}></span>
								<span class="queue-copy">
									<strong>{item.label}</strong>
									<span class="queue-detail">{item.detail}</span>
									{#if item.error}<span class="queue-item-error">{item.error}</span>{/if}
								</span>
								<span class="queue-kind">
									{item.kind === 'search-post'
										? 'search'
										: item.kind === 'manual'
											? 'url'
											: item.kind === 'quoted-thread'
												? 'quoted'
												: 'quote'}
								</span>
							</li>
						{/each}
					</ul>
				{/if}
			</aside>
		{/if}

		{#if showBinPanel}
			<aside class="bin-panel board-overlay wobbly-border-light">
				<header class="bin-head">
					<strong>🗑 Recycle bin</strong>
					<button type="button" class="mini-btn" onclick={() => (showBinPanel = false)}>Close</button>
				</header>
				{#if binGroups.length === 0 && binPosts.length === 0}
					<p class="bin-empty">Nothing deleted yet.</p>
				{/if}
				{#if binGroups.length > 0}
					<h3 class="bin-section">Threads</h3>
					<ul class="bin-list">
						{#each binGroups as group (group.id)}
							<li class="bin-row">
								<span class="bin-copy">{groupLabel(group)}</span>
								<button type="button" class="mini-btn" onclick={() => restoreBinGroup(group)}>Restore</button>
							</li>
						{/each}
					</ul>
				{/if}
				{#if binPosts.length > 0}
					<h3 class="bin-section">Posts</h3>
					<ul class="bin-list">
						{#each binPosts as entry (entry.id)}
							{@const gone = !groups.some((candidate) => candidate.id === entry.groupId)}
							<li class="bin-row" class:bin-row-gone={gone}>
								<span class="bin-copy">
									<strong>@{entry.post.author.handle}</strong>
									{previewText(entry.post.text, 56)}
									{#if gone}<em>(thread deleted)</em>{/if}
								</span>
								<button type="button" class="mini-btn" disabled={gone} onclick={() => restoreBinPost(entry)}>
									Restore
								</button>
							</li>
						{/each}
					</ul>
				{/if}
			</aside>
		{/if}
	</div>
	</div>

	{#if showHelp}
		<div class="help-overlay" role="dialog" aria-label="Keyboard shortcuts">
			<div class="help-card wobbly-border">
				<header class="dialog-head">
					<h2>Keyboard shortcuts</h2>
					<button type="button" class="mini-btn" onclick={() => (showHelp = false)}>Close</button>
				</header>
				<dl class="help-grid">
					<dt><kbd>/</kbd></dt><dd>Focus board filter</dd>
					<dt><kbd>n</kbd> / <kbd>p</kbd></dt><dd>Next / previous match (Enter / Shift+Enter in the filter box too)</dd>
					<dt><kbd>e</kbd></dt><dd>Expand / collapse the hovered thread (tree ⇄ single lane)</dd>
					<dt><kbd>Shift+E</kbd> / <kbd>Shift+C</kbd></dt><dd>Expand / collapse all threads</dd>
					<dt><kbd>]</kbd> / <kbd>[</kbd></dt><dd>Next / previous reply path of the hovered thread</dd>
					<dt><kbd>f</kbd></dt><dd>Fit all threads in view</dd>
					<dt><kbd>t</kbd></dt><dd>Tidy board into author columns</dd>
					<dt><kbd>b</kbd></dt><dd>Toggle the side panel</dd>
					<dt><kbd>+</kbd> / <kbd>-</kbd></dt><dd>Zoom in / out</dd>
					<dt><kbd>Esc</kbd></dt><dd>Close help, then clear filters</dd>
					<dt><kbd>?</kbd></dt><dd>Toggle this help</dd>
				</dl>
			</div>
		</div>
	{/if}
</div>

<dialog
	class="search-dialog wobbly-border"
	bind:this={searchDialogEl}
	style={`font-family: ${fontFamily}`}
>
	<header class="dialog-head">
		<h2>Search posts</h2>
		<button type="button" class="mini-btn" onclick={closeSearchDialog}>Close</button>
	</header>

	{#if !authProfile}
		<p class="dialog-note">
			Connect your Bluesky account first — the follows-only search runs authenticated as you.
		</p>
		<button type="button" class="action-btn wobbly-border" onclick={handleConnect} disabled={connecting}>
			{connecting ? 'Connecting…' : 'Connect Bluesky'}
		</button>
	{:else}
		<form
			class="dialog-search-form"
			onsubmit={(event) => {
				event.preventDefault();
				void runSearch();
			}}
		>
			<input
				type="text"
				class="dialog-search-input"
				bind:value={searchTerm}
				placeholder="Search term (e.g. rust async)…"
				disabled={searching}
			/>
			{#if searching}
				<button type="button" class="action-btn wobbly-border-light" onclick={cancelSearch}>Cancel</button>
			{:else}
				<button type="submit" class="action-btn wobbly-border" disabled={!searchTerm.trim()}>Search</button>
			{/if}
		</form>
		<div class="dialog-options">
			<label class="dialog-option">
				<input type="checkbox" bind:checked={onlyFollows} disabled={searching} />
				Only posts from accounts I follow (<code>following:true</code>)
			</label>
			<label class="dialog-option">
				Sort
				<select bind:value={searchSort} disabled={searching}>
					<option value="latest">latest</option>
					<option value="top">top</option>
				</select>
			</label>
		</div>

		{#if searching}
			<p class="dialog-note">
				Fetching page {searchPagesDone + 1}… {searchResults.size} posts so far
				{#if backoffWorkers > 0}· ⏳ rate limited, backing off{/if}
			</p>
		{/if}

		{#if searchResults.size > 0}
			<div class="dialog-filter-row">
				<input
					type="search"
					class="dialog-search-input dialog-filter-input"
					bind:value={resultFilter}
					placeholder="Filter these results by phrase…"
				/>
				<label class="dialog-option" title="Only posts whose whole text is this phrase (ignoring case and trailing punctuation)">
					<input type="checkbox" bind:checked={resultFilterExact} />
					post is exactly this
				</label>
			</div>
		{/if}

		{#if !searching && searchResults.size > 0}
			<div class="dialog-results-head">
				<span>
					{#if resultFilter.trim()}
						{filteredSearchPosts.length} of {searchResults.size} posts match
						· {resultAuthorGroups.length} account{resultAuthorGroups.length === 1 ? '' : 's'}
					{:else}
						{searchResults.size} posts from {resultAuthorGroups.length} accounts
					{/if}
				</span>
				<button
					type="button"
					class="action-btn wobbly-border"
					disabled={filteredSearchPosts.length === 0}
					onclick={boardAllResults}
				>
					{resultFilter.trim() ? 'Put matching on whiteboard' : 'Put all on whiteboard'}
				</button>
			</div>
		{/if}

		<div class="dialog-results">
			{#each resultAuthorGroups as authorGroup (authorGroup.did)}
				{@const collapsed = collapsedResultAuthors.has(authorGroup.did)}
				<section class="result-group wobbly-border-light">
					<header class="result-group-head">
						<button
							type="button"
							class="result-collapse"
							onclick={() => {
								const next = new Set(collapsedResultAuthors);
								if (next.has(authorGroup.did)) next.delete(authorGroup.did);
								else next.add(authorGroup.did);
								collapsedResultAuthors = next;
							}}
						>
							<span class="caret" class:collapsed>▾</span>
							{#if authorGroup.author.avatar}
								<img class="result-avatar" src={authorGroup.author.avatar} alt="" />
							{/if}
							<span class="result-author">
								{authorGroup.author.displayName || authorGroup.author.handle}
								<small>@{authorGroup.author.handle} · {authorGroup.posts.length}</small>
							</span>
						</button>
						<button type="button" class="mini-btn" onclick={() => boardAuthorGroup(authorGroup)}>
							Board all
						</button>
					</header>
					{#if !collapsed}
						<ul class="result-list">
							{#each authorGroup.posts as post (post.uri)}
								<li class="result-row">
									<span class="result-copy">
										<span class="result-text">{post.text || '(no text)'}</span>
										<span class="result-meta">
											{formatDate(post.createdAt)} · ♥ {post.likeCount} · 💬 {post.replyCount}
											{#if post.embed?.record}· quotes @{post.embed.record.author.handle}{/if}
										</span>
									</span>
									<button
										type="button"
										class="wb-action-btn"
										disabled={boardHasPost(post.uri)}
										onclick={() => boardSearchPost(post)}
									>
										{boardHasPost(post.uri) ? 'On board' : 'Put on whiteboard'}
									</button>
								</li>
							{/each}
						</ul>
					{/if}
				</section>
			{/each}
		</div>
	{/if}
</dialog>

<style>
	.page {
		display: flex;
		flex-direction: column;
		height: 100vh;
		overflow: hidden;
	}

	.topbar {
		padding: 10px 16px 8px;
		border-bottom: 1px solid var(--control-border);
		background: var(--card-bg);
	}

	.topbar-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		flex-wrap: wrap;
		margin-top: 6px;
	}

	.topbar h1 {
		margin: 0;
		font-size: 1.4rem;
		color: var(--text-ink);
	}

	.topbar-actions {
		display: flex;
		align-items: center;
		gap: 10px;
		flex-wrap: wrap;
	}

	.auth-chip {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		padding: 4px 10px;
		background: var(--control-bg);
		color: var(--text-ink);
		font-size: 0.9rem;
	}

	.auth-avatar {
		width: 22px;
		height: 22px;
		border-radius: 999px;
		object-fit: cover;
	}

	.action-btn {
		padding: 7px 14px;
		background: var(--control-bg);
		color: var(--text-ink);
		font: inherit;
		font-weight: 600;
		cursor: pointer;
	}

	.action-btn:hover:not(:disabled) {
		background: color-mix(in srgb, var(--accent) 18%, var(--card-bg));
	}

	.action-btn:disabled {
		opacity: 0.55;
		cursor: default;
	}

	.insert-form {
		display: flex;
		gap: 6px;
	}

	.insert-input {
		width: min(280px, 40vw);
		padding: 7px 12px;
		background: var(--control-bg);
		color: var(--text-ink);
		font: inherit;
		font-size: 0.85rem;
	}

	.insert-input::placeholder {
		color: var(--muted, #888);
		opacity: 0.8;
	}

	.mini-btn {
		padding: 3px 10px;
		border-radius: 999px;
		border: 1px solid var(--control-border);
		background: var(--control-bg);
		color: var(--text-ink);
		font: inherit;
		font-size: 0.78rem;
		font-weight: 600;
		cursor: pointer;
	}

	.mini-btn:hover:not(:disabled) {
		background: color-mix(in srgb, var(--accent) 16%, var(--card-bg));
	}

	.mini-btn:disabled {
		opacity: 0.5;
		cursor: default;
	}

	/* ---------- board ---------- */
	.board-viewport {
		position: relative;
		flex: 1;
		overflow: hidden;
		touch-action: none;
		cursor: grab;
		background-color: var(--page-bg, #faf8f4);
		background-image: radial-gradient(
			color-mix(in srgb, var(--text-ink) 14%, transparent) 1px,
			transparent 1px
		);
	}

	.board-viewport.panning {
		cursor: grabbing;
	}

	.board-world {
		position: absolute;
		left: 0;
		top: 0;
		transform-origin: 0 0;
		will-change: transform;
	}

	.cross-links {
		position: absolute;
		left: 0;
		top: 0;
		width: 1px;
		height: 1px;
		overflow: visible;
		pointer-events: none;
	}

	.cross-link-path {
		fill: none;
		stroke: color-mix(in srgb, var(--accent) 65%, var(--text-ink));
		stroke-width: 3;
		stroke-dasharray: 10 8;
		opacity: 0.75;
	}

	.board-group {
		position: absolute;
		border: 2px dashed color-mix(in srgb, var(--group-accent) 55%, var(--control-border));
		border-radius: 18px;
		background: color-mix(in srgb, var(--group-accent) 5%, transparent);
		cursor: grab;
		/* Animates the snap-to-free-spot nudge after a drop. */
		transition:
			left 0.18s ease,
			top 0.18s ease;
	}

	.board-group.dragging {
		border-style: solid;
		box-shadow: 0 10px 30px rgba(0, 0, 0, 0.18);
		z-index: 5;
		cursor: grabbing;
		transition: none;
	}

	.group-head {
		position: absolute;
		left: 10px;
		top: 6px;
		right: 10px;
		height: 34px;
		display: flex;
		align-items: center;
		gap: 8px;
		cursor: grab;
		color: var(--text-ink);
		user-select: none;
	}

	.group-grip {
		font-size: 1rem;
		color: color-mix(in srgb, var(--group-accent) 80%, var(--text-ink));
	}

	.group-avatar {
		width: 24px;
		height: 24px;
		border-radius: 999px;
		object-fit: cover;
	}

	.group-title {
		flex: 1;
		min-width: 0;
		font-weight: 700;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.group-title small {
		font-weight: 400;
		color: var(--muted, #777);
		margin-left: 6px;
	}

	.group-btn {
		border: none;
		background: none;
		font: inherit;
		font-size: 0.95rem;
		color: inherit;
		cursor: pointer;
		opacity: 0.7;
	}

	.group-btn:hover {
		opacity: 1;
	}

	.group-connectors {
		position: absolute;
		left: 0;
		top: 0;
		pointer-events: none;
	}

	.group-connector-path {
		fill: none;
		stroke: color-mix(in srgb, var(--text-ink) 45%, transparent);
		stroke-width: 2.5;
	}

	/* ---------- cards ---------- */
	.wb-card {
		position: absolute;
		width: 320px;
		height: 300px;
		display: flex;
		flex-direction: column;
		padding: 10px 12px;
		background: var(--card-bg);
		box-shadow: var(--shadow-soft, 2px 3px 0 rgba(0, 0, 0, 0.08));
		color: var(--text-ink);
	}

	.wb-card.focus-card {
		outline: 3px solid color-mix(in srgb, var(--accent) 75%, transparent);
		outline-offset: 2px;
	}

	.wb-card-author {
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.wb-avatar {
		width: 28px;
		height: 28px;
		border-radius: 999px;
		object-fit: cover;
	}

	.wb-author-copy {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
	}

	.wb-handle {
		font-size: 0.9rem;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.wb-date {
		font-size: 0.72rem;
		color: var(--muted, #888);
	}

	.wb-icon-btn {
		border: none;
		background: none;
		color: var(--muted, #888);
		font: inherit;
		font-size: 0.85rem;
		cursor: pointer;
		padding: 2px 6px;
	}

	.wb-icon-btn:hover {
		color: crimson;
	}

	.wb-badges {
		display: flex;
		gap: 8px;
		flex-wrap: wrap;
		margin: 4px 0 6px;
		font-size: 0.7rem;
		color: var(--muted, #888);
	}

	.wb-card-scroll {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		padding-right: 4px;
	}

	.wb-text {
		margin: 0;
		font-size: 0.9rem;
		line-height: 1.35;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}

	.wb-media-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(88px, 1fr));
		gap: 6px;
		margin-top: 8px;
	}

	.wb-media-btn {
		border: 1px solid var(--control-border);
		border-radius: 8px;
		padding: 0;
		background: none;
		cursor: zoom-in;
		overflow: hidden;
	}

	.wb-media-thumb {
		display: block;
		width: 100%;
		height: 88px;
		object-fit: cover;
	}

	.wb-video {
		width: 100%;
		margin-top: 8px;
		border-radius: 8px;
		background: #000;
	}

	.wb-external {
		display: flex;
		gap: 8px;
		margin-top: 8px;
		padding: 8px;
		border: 1px solid var(--control-border);
		border-radius: 10px;
		background: color-mix(in srgb, var(--control-bg) 60%, var(--card-bg));
	}

	.wb-external-thumb {
		width: 52px;
		height: 52px;
		object-fit: cover;
		border-radius: 6px;
		flex-shrink: 0;
	}

	.wb-external-copy {
		display: flex;
		flex-direction: column;
		gap: 2px;
		font-size: 0.75rem;
		min-width: 0;
	}

	.wb-external-copy strong {
		font-size: 0.8rem;
	}

	.wb-external-copy span {
		color: var(--muted, #777);
		display: -webkit-box;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		-webkit-box-orient: vertical;
		overflow: hidden;
	}

	.wb-quote {
		margin-top: 8px;
		padding: 8px 10px;
		border: 1px solid var(--control-border);
		border-radius: 10px;
		background: color-mix(in srgb, var(--accent) 6%, var(--card-bg));
	}

	.wb-quote-head {
		display: flex;
		align-items: center;
		gap: 6px;
	}

	.wb-quote-avatar {
		width: 18px;
		height: 18px;
		border-radius: 999px;
		object-fit: cover;
	}

	.wb-quote-kicker {
		font-size: 0.74rem;
		font-weight: 700;
	}

	.wb-quote-text {
		margin: 4px 0 0;
		font-size: 0.8rem;
		line-height: 1.3;
		color: var(--muted, #555);
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}

	.wb-quote-picker {
		margin-top: 8px;
		border: 1px dashed var(--control-border);
		border-radius: 10px;
		padding: 6px 8px;
	}

	.wb-picker-note {
		margin: 4px 0;
		font-size: 0.78rem;
		color: var(--muted, #777);
	}

	.wb-picker-error {
		color: crimson;
	}

	.wb-picker-row {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 4px 0;
		border-top: 1px solid color-mix(in srgb, var(--control-border) 50%, transparent);
	}

	.wb-picker-row:first-child {
		border-top: none;
	}

	.wb-picker-copy {
		flex: 1;
		min-width: 0;
		font-size: 0.78rem;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.wb-card-actions {
		display: flex;
		gap: 6px;
		flex-wrap: wrap;
		padding-top: 6px;
	}

	.wb-action-btn {
		padding: 3px 10px;
		border-radius: 999px;
		border: 1px solid var(--control-border);
		background: var(--control-bg);
		color: var(--text-ink);
		font: inherit;
		font-size: 0.74rem;
		font-weight: 600;
		cursor: pointer;
		text-decoration: none;
		flex-shrink: 0;
	}

	.wb-action-btn:hover:not(:disabled) {
		background: color-mix(in srgb, var(--accent) 18%, var(--card-bg));
	}

	.wb-action-btn:disabled {
		opacity: 0.5;
		cursor: default;
	}

	.wb-action-link {
		display: inline-flex;
		align-items: center;
	}

	/* ---------- overlays ---------- */
	.board-overlay {
		position: absolute;
		z-index: 10;
	}

	.board-empty {
		left: 50%;
		top: 40%;
		transform: translate(-50%, -50%);
		max-width: 460px;
		text-align: center;
		color: var(--muted, #777);
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 8px;
	}

	.board-empty p {
		margin: 0;
	}

	.zoom-controls {
		right: 14px;
		top: 14px;
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 6px 8px;
		background: var(--card-bg);
	}

	.zoom-value {
		font-size: 0.78rem;
		color: var(--muted, #777);
		min-width: 40px;
		text-align: center;
	}

	.minimap {
		right: 14px;
		bottom: 14px;
		padding: 6px;
		background: var(--card-bg);
	}

	.minimap canvas {
		display: block;
		cursor: crosshair;
	}

	/* ---------- queue panel ---------- */
	.queue-panel {
		left: 14px;
		bottom: 14px;
		width: 330px;
		max-height: 46vh;
		display: flex;
		flex-direction: column;
		padding: 10px 12px;
		background: var(--card-bg);
		color: var(--text-ink);
	}

	.queue-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
	}

	.queue-toggle {
		border: none;
		background: none;
		font: inherit;
		font-weight: 700;
		color: var(--text-ink);
		cursor: pointer;
		padding: 0;
	}

	.queue-counts {
		font-size: 0.74rem;
		color: var(--muted, #777);
	}

	.queue-error-count {
		color: crimson;
	}

	.queue-rate {
		margin: 6px 0 0;
		font-size: 0.78rem;
		color: var(--text-ink);
		background: color-mix(in srgb, orange 18%, var(--card-bg));
		border-radius: 8px;
		padding: 3px 8px;
	}

	.queue-rate-quiet {
		background: none;
		color: var(--muted, #888);
		padding: 0;
	}

	.queue-actions {
		display: flex;
		gap: 6px;
		margin: 8px 0 6px;
	}

	.queue-list {
		list-style: none;
		margin: 0;
		padding: 0;
		overflow-y: auto;
	}

	.queue-item {
		display: flex;
		align-items: flex-start;
		gap: 8px;
		padding: 5px 0;
		border-top: 1px solid color-mix(in srgb, var(--control-border) 50%, transparent);
		font-size: 0.78rem;
	}

	.queue-status-dot {
		width: 9px;
		height: 9px;
		border-radius: 999px;
		margin-top: 4px;
		flex-shrink: 0;
		background: var(--muted, #999);
	}

	.queue-item-pending .queue-status-dot {
		background: #b8b8b8;
	}

	.queue-item-running .queue-status-dot {
		background: #f0a500;
		animation: queue-pulse 1s ease-in-out infinite;
	}

	.queue-item-done .queue-status-dot {
		background: #3fa34d;
	}

	.queue-item-skipped .queue-status-dot {
		background: #7aa7d9;
	}

	.queue-item-error .queue-status-dot {
		background: crimson;
	}

	@keyframes queue-pulse {
		50% {
			opacity: 0.35;
		}
	}

	.queue-copy {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
	}

	.queue-detail {
		color: var(--muted, #888);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.queue-item-error .queue-item-error,
	.queue-item-skipped .queue-item-error {
		color: var(--muted, #888);
		font-style: italic;
	}

	.queue-kind {
		flex-shrink: 0;
		font-size: 0.68rem;
		color: var(--muted, #999);
		border: 1px solid var(--control-border);
		border-radius: 999px;
		padding: 0 6px;
		margin-top: 2px;
	}

	/* ---------- bin panel ---------- */
	.bin-panel {
		right: 14px;
		top: 64px;
		width: 330px;
		max-height: 60vh;
		overflow-y: auto;
		padding: 10px 12px;
		background: var(--card-bg);
		color: var(--text-ink);
	}

	.bin-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 6px;
	}

	.bin-empty {
		color: var(--muted, #888);
		font-size: 0.85rem;
	}

	.bin-section {
		margin: 10px 0 4px;
		font-size: 0.78rem;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--muted, #888);
	}

	.bin-list {
		list-style: none;
		margin: 0;
		padding: 0;
	}

	.bin-row {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 5px 0;
		border-top: 1px solid color-mix(in srgb, var(--control-border) 50%, transparent);
		font-size: 0.8rem;
	}

	.bin-row-gone {
		opacity: 0.55;
	}

	.bin-copy {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	/* ---------- search dialog ---------- */
	.search-dialog {
		width: min(720px, calc(100vw - 40px));
		max-height: min(82vh, 900px);
		border: 2px solid var(--control-border);
		background: var(--card-bg);
		color: var(--text-ink);
		padding: 18px 20px;
		font-family: inherit;
	}

	.search-dialog::backdrop {
		background: rgba(20, 20, 25, 0.45);
	}

	.dialog-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 10px;
	}

	.dialog-head h2 {
		margin: 0;
		font-size: 1.2rem;
	}

	.dialog-note {
		color: var(--muted, #777);
		margin: 8px 0;
	}

	.dialog-search-form {
		display: flex;
		gap: 8px;
	}

	.dialog-search-input {
		flex: 1;
		min-width: 0;
		padding: 9px 14px;
		border-radius: 999px;
		border: 1px solid var(--control-border);
		background: var(--control-bg);
		color: var(--text-ink);
		font: inherit;
	}

	.dialog-options {
		display: flex;
		align-items: center;
		gap: 18px;
		flex-wrap: wrap;
		margin: 10px 0;
		font-size: 0.85rem;
		color: var(--text-ink);
	}

	.dialog-option {
		display: inline-flex;
		align-items: center;
		gap: 6px;
	}

	.dialog-option code {
		font-size: 0.75rem;
		background: var(--control-bg);
		padding: 1px 5px;
		border-radius: 5px;
	}

	.dialog-option select {
		font: inherit;
		background: var(--control-bg);
		color: var(--text-ink);
		border: 1px solid var(--control-border);
		border-radius: 8px;
		padding: 2px 6px;
	}

	.dialog-filter-row {
		display: flex;
		align-items: center;
		gap: 12px;
		margin: 10px 0 4px;
		flex-wrap: wrap;
	}

	.dialog-filter-input {
		flex: 1;
		min-width: 200px;
	}

	.dialog-results-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 10px;
		margin: 10px 0;
		color: var(--muted, #666);
		font-size: 0.9rem;
	}

	.dialog-results {
		overflow-y: auto;
		max-height: 50vh;
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.result-group {
		background: var(--card-bg);
	}

	.result-group-head {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 7px 10px;
		border-bottom: 1px solid var(--control-border);
		background: color-mix(in srgb, var(--accent) 6%, var(--card-bg));
	}

	.result-collapse {
		flex: 1;
		min-width: 0;
		display: flex;
		align-items: center;
		gap: 8px;
		border: none;
		background: none;
		font: inherit;
		color: inherit;
		text-align: left;
		cursor: pointer;
		padding: 0;
	}

	.caret {
		font-size: 0.75rem;
		color: var(--muted, #888);
		transition: transform 0.15s ease;
	}

	.caret.collapsed {
		transform: rotate(-90deg);
	}

	.result-avatar {
		width: 26px;
		height: 26px;
		border-radius: 999px;
		object-fit: cover;
	}

	.result-author {
		font-weight: 700;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.result-author small {
		font-weight: 400;
		color: var(--muted, #888);
		margin-left: 6px;
	}

	.result-list {
		list-style: none;
		margin: 0;
		padding: 0;
	}

	.result-row {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 7px 10px;
		border-top: 1px solid color-mix(in srgb, var(--control-border) 50%, transparent);
	}

	.result-row:first-child {
		border-top: none;
	}

	.result-copy {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	.result-text {
		font-size: 0.86rem;
		line-height: 1.3;
		display: -webkit-box;
		-webkit-line-clamp: 3;
		line-clamp: 3;
		-webkit-box-orient: vertical;
		overflow: hidden;
	}

	.result-meta {
		font-size: 0.72rem;
		color: var(--muted, #888);
	}

	/* ---------- layout row: side panel + board ---------- */
	.main-row {
		display: flex;
		flex: 1;
		min-height: 0;
	}

	.side-panel {
		width: 312px;
		flex-shrink: 0;
		display: flex;
		flex-direction: column;
		border-right: 1px solid var(--control-border);
		background: var(--card-bg);
		color: var(--text-ink);
		overflow-y: auto;
		padding: 10px 12px;
		gap: 10px;
	}

	.side-tabs {
		display: flex;
		gap: 6px;
	}

	.side-tab {
		flex: 1;
		padding: 6px 10px;
		border: 1px solid var(--control-border);
		border-radius: 10px;
		background: var(--control-bg);
		color: var(--text-ink);
		font: inherit;
		font-weight: 700;
		font-size: 0.85rem;
		cursor: pointer;
	}

	.side-tab.active {
		background: color-mix(in srgb, var(--accent) 22%, var(--card-bg));
	}

	.side-tab-hide {
		flex: 0 0 auto;
		padding: 6px 9px;
		font-weight: 400;
	}

	.thread-embed {
		display: flex;
		align-items: center;
		gap: 4px;
		margin-top: 3px;
		min-width: 0;
	}

	.thread-embed-thumb {
		width: 34px;
		height: 34px;
		border-radius: 6px;
		object-fit: cover;
		border: 1px solid var(--control-border);
		flex-shrink: 0;
	}

	.thread-embed-video {
		position: relative;
		display: inline-flex;
		flex-shrink: 0;
	}

	.thread-embed-play {
		position: absolute;
		inset: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		font-size: 0.7rem;
		color: #fff;
		text-shadow: 0 0 4px rgba(0, 0, 0, 0.8);
	}

	.thread-embed-note {
		font-size: 0.7rem;
		color: var(--muted, #888);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.side-stats {
		margin: 0;
		font-size: 0.76rem;
		color: var(--muted, #888);
	}

	.side-section {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.side-section-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		font-size: 0.85rem;
	}

	.side-head-actions {
		display: inline-flex;
		gap: 4px;
	}

	.side-search {
		width: 100%;
		padding: 8px 12px;
		background: var(--control-bg);
		color: var(--text-ink);
		font: inherit;
		font-size: 0.88rem;
		box-sizing: border-box;
	}

	.match-bar {
		display: flex;
		align-items: center;
		gap: 6px;
	}

	.match-count {
		flex: 1;
		font-size: 0.78rem;
		color: var(--muted, #777);
	}

	.side-options {
		display: flex;
		flex-direction: column;
		gap: 5px;
		font-size: 0.82rem;
	}

	.side-option {
		display: flex;
		align-items: center;
		gap: 7px;
	}

	.side-option-inline {
		justify-content: flex-start;
	}

	.side-option select {
		font: inherit;
		font-size: 0.8rem;
		background: var(--control-bg);
		color: var(--text-ink);
		border: 1px solid var(--control-border);
		border-radius: 8px;
		padding: 2px 6px;
	}

	.side-number {
		width: 70px;
		padding: 3px 8px;
		border: 1px solid var(--control-border);
		border-radius: 8px;
		background: var(--control-bg);
		color: var(--text-ink);
		font: inherit;
		font-size: 0.8rem;
	}

	.side-empty {
		list-style: none;
		color: var(--muted, #888);
		font-size: 0.82rem;
		padding: 6px 0;
	}

	/* ---------- author roster ---------- */
	.author-list {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
	}

	.author-row {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 3px 4px;
		border-radius: 10px;
	}

	.author-row.selected {
		background: color-mix(in srgb, var(--accent) 16%, var(--card-bg));
	}

	.author-toggle {
		flex: 1;
		min-width: 0;
		display: flex;
		align-items: center;
		gap: 8px;
		border: none;
		background: none;
		font: inherit;
		color: inherit;
		text-align: left;
		cursor: pointer;
		padding: 2px 0;
	}

	.author-dot {
		width: 10px;
		height: 10px;
		border-radius: 999px;
		flex-shrink: 0;
	}

	.author-avatar {
		width: 22px;
		height: 22px;
		border-radius: 999px;
		object-fit: cover;
		flex-shrink: 0;
	}

	.author-copy {
		min-width: 0;
		font-size: 0.82rem;
		font-weight: 600;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.author-copy small {
		font-weight: 400;
		color: var(--muted, #888);
		margin-left: 5px;
	}

	/* ---------- thread navigator ---------- */
	.thread-list {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.thread-row {
		display: flex;
		align-items: center;
		gap: 4px;
		border: 1px solid color-mix(in srgb, var(--control-border) 70%, transparent);
		border-radius: 10px;
		padding: 4px 6px;
	}

	.thread-row-dim {
		opacity: 0.45;
	}

	.thread-jump {
		flex: 1;
		min-width: 0;
		display: flex;
		align-items: center;
		gap: 8px;
		border: none;
		background: none;
		font: inherit;
		color: inherit;
		text-align: left;
		cursor: pointer;
		padding: 0;
	}

	.thread-accent {
		width: 4px;
		align-self: stretch;
		border-radius: 4px;
		background: var(--group-accent);
		flex-shrink: 0;
	}

	.thread-copy {
		min-width: 0;
		display: flex;
		flex-direction: column;
		font-size: 0.8rem;
	}

	.thread-preview {
		color: var(--muted, #777);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.thread-copy small {
		color: var(--muted, #999);
		font-size: 0.7rem;
	}

	.thread-copy mark {
		background: color-mix(in srgb, var(--accent) 35%, transparent);
		border-radius: 4px;
		padding: 0 3px;
	}

	.thread-row-actions {
		display: inline-flex;
		gap: 3px;
		flex-shrink: 0;
	}

	/* ---------- group extras ---------- */
	.board-group.group-dim {
		opacity: 0.32;
	}

	.group-match-chip {
		flex-shrink: 0;
		font-size: 0.72rem;
		font-weight: 700;
		padding: 1px 8px;
		border-radius: 999px;
		background: color-mix(in srgb, var(--accent) 30%, var(--card-bg));
	}

	.group-chain-pager {
		display: inline-flex;
		align-items: center;
		gap: 2px;
		flex-shrink: 0;
	}

	.group-chain-info {
		font-size: 0.74rem;
		color: var(--muted, #777);
		min-width: 34px;
		text-align: center;
	}

	.branch-badge {
		position: absolute;
		z-index: 3;
		padding: 4px 10px;
		border-radius: 999px;
		border: 2px dashed color-mix(in srgb, var(--group-accent) 70%, var(--control-border));
		background: var(--card-bg);
		color: var(--text-ink);
		font: inherit;
		font-size: 0.78rem;
		font-weight: 700;
		cursor: pointer;
		white-space: nowrap;
	}

	.branch-badge:hover {
		background: color-mix(in srgb, var(--group-accent) 20%, var(--card-bg));
	}

	/* ---------- card filter states ---------- */
	.wb-card.card-dim {
		opacity: 0.35;
	}

	.wb-card.card-match {
		outline: 3px solid color-mix(in srgb, var(--group-accent) 85%, var(--text-ink));
		outline-offset: 2px;
	}

	.wb-card.card-flash {
		animation: card-flash 1.6s ease;
	}

	@keyframes card-flash {
		0%,
		45% {
			box-shadow: 0 0 0 8px color-mix(in srgb, var(--accent) 60%, transparent);
		}
		100% {
			box-shadow: var(--shadow-soft, 2px 3px 0 rgba(0, 0, 0, 0.08));
		}
	}

	/* ---------- help overlay ---------- */
	.help-overlay {
		position: fixed;
		inset: 0;
		z-index: 40;
		display: flex;
		align-items: center;
		justify-content: center;
		background: rgba(20, 20, 25, 0.4);
	}

	.help-card {
		width: min(560px, calc(100vw - 40px));
		max-height: 80vh;
		overflow-y: auto;
		background: var(--card-bg);
		color: var(--text-ink);
		padding: 16px 20px;
	}

	.help-grid {
		display: grid;
		grid-template-columns: auto 1fr;
		gap: 8px 16px;
		margin: 10px 0 0;
		font-size: 0.88rem;
	}

	.help-grid dt {
		white-space: nowrap;
	}

	.help-grid dd {
		margin: 0;
		color: var(--muted, #666);
	}

	.help-grid kbd {
		display: inline-block;
		padding: 1px 7px;
		border: 1px solid var(--control-border);
		border-bottom-width: 2px;
		border-radius: 6px;
		background: var(--control-bg);
		font-size: 0.8rem;
	}
</style>
