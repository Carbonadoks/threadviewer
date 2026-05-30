	<script lang="ts">
		import { onMount, tick, untrack } from 'svelte';
		import {
			fetchQuotesForPost as fetchBlueskyQuotesForPost,
			getFullThread as getBlueskyFullThread
		} from '$lib/api/bluesky';
		import BoardView from '$lib/components/BoardView.svelte';
		import ThreadExportButton from '$lib/components/ThreadExportButton.svelte';
		import type { ThreadPost } from '$lib/types';
		import type { BoardPlatformConfig, BoardThread } from '$lib/types/boardPlatform';
		import LinkedPostEmbeds from '$lib/components/LinkedPostEmbeds.svelte';
		import { buildParentMap, findFirstMatchingPost, findMatchingPosts } from '$lib/utils/boardTree';
		import { openLightbox } from '$lib/stores/lightbox';
	type LaneKind = 'main' | 'quoted';
	type QuoteLaneDirection = 'outbound' | 'inbound';
		type QuoteLaneStatus = 'loading' | 'ready' | 'linked' | 'error';
		type QuoteLaneEntryBase = {
			quotedUri: string;
			quotedHandle: string;
			sourceUri: string;
			sourceLaneId: string;
			loadedAt: number;
			direction: QuoteLaneDirection;
		};
		type LoadingQuoteLaneEntry = QuoteLaneEntryBase & {
			status: 'loading';
		};
		type ReadyQuoteLaneEntry = QuoteLaneEntryBase & {
			status: 'ready';
			thread: BoardThread;
			targetLaneId: string;
			targetPostUri: string;
		};
		type LinkedQuoteLaneEntry = QuoteLaneEntryBase & {
			status: 'linked';
			targetLaneId: string;
			targetPostUri: string;
		};
		type ErrorQuoteLaneEntry = QuoteLaneEntryBase & {
			status: 'error';
			error?: string;
		};
	type QuoteLaneEntry =
		| LoadingQuoteLaneEntry
		| ReadyQuoteLaneEntry
		| LinkedQuoteLaneEntry
		| ErrorQuoteLaneEntry;
	type ResolvedQuoteLaneEntry = ReadyQuoteLaneEntry | LinkedQuoteLaneEntry;
	type SeedQuoteLane = {
		quotedUri: string;
		quotedHandle: string;
		sourceUri: string;
		sourceLaneId?: string;
		loadedAt?: number;
		direction?: QuoteLaneDirection;
		thread: BoardThread;
		targetPostUri?: string;
	};
	type QuotePostFeedState = {
		status: 'idle' | 'loading' | 'ready' | 'error';
		posts: ThreadPost[];
		hasMore?: boolean;
		loadedAll?: boolean;
		loadingMode?: 'page' | 'all';
		error?: string;
	};
	type LaneChain = {
		id: string;
		order: number;
		posts: ThreadPost[];
	};
	type LaneCardVisibility = 'active' | 'shadow';
	type LaneCard = {
		key: string;
		laneId: string;
		laneLabel: string;
		laneTitle: string;
		laneKind: LaneKind;
		laneIsTruncated: boolean;
		post: ThreadPost;
		chainId: string;
		chainOrder: number;
		depth: number;
		x: number;
		y: number;
		visibility: LaneCardVisibility;
		divergenceDepth: number;
		stackIndex: number;
		switchGroupChainIds: string[];
		isLaneRoot: boolean;
	};
	type LaneRenderModel = {
		id: string;
		kind: LaneKind;
		label: string;
		title: string;
		handle: string;
		anchorUri: string;
		thread: BoardThread;
		loadedAt: number;
		sourceUri?: string;
		sourceLaneId?: string;
		column: number;
		depthOffset: number;
		x: number;
		activeChainId: string;
		chains: LaneChain[];
		activeCards: LaneCard[];
		maxDepth: number;
		cards: LaneCard[];
	};
	type LaneConnector = {
		key: string;
		from: LaneCard;
		to: LaneCard;
		kind: 'spawn' | 'reference' | 'tree';
	};
	type NavigationDirection = 'left' | 'right' | 'up' | 'down';
	type HighlightSegment = {
		text: string;
		match: boolean;
	};
	type LaneTreeNavigation = {
		order: ThreadPost[];
		indexByUri: Map<string, number>;
		parentByUri: Map<string, ThreadPost>;
	};
	type BoardModel = {
		lanes: LaneRenderModel[];
		laneById: Map<string, LaneRenderModel>;
		cardsByKey: Map<string, LaneCard>;
		cardsByPostUri: Map<string, LaneCard>;
		connectors: LaneConnector[];
		boardWidth: number;
		boardHeight: number;
		canvasOffsetY: number;
	};
	type ActivePostChangeHandler = (post: ThreadPost | null) => void;
	type WinningMoveKind = 'initial-thread' | 'fetched-lane' | 'linked-lane' | 'existing-lane';
	type WinningMoveDetails = {
		kind: WinningMoveKind;
		laneId: string;
		targetUri: string;
		sourceUri?: string | null;
		sourceLaneId?: string | null;
		quotedUri?: string | null;
		summaryPosts?: ThreadPost[];
	};
	type WinningMoveHandler = (details: WinningMoveDetails) => void;
	type FetchModeTaskKind = 'scan-post' | 'open-lane';
	type FetchModeTaskStatus = 'pending' | 'running' | 'done' | 'skipped' | 'error';
	type FetchModeQueueItem = {
		id: string;
		kind: FetchModeTaskKind;
		status: FetchModeTaskStatus;
		sourceUri: string;
		sourceLaneId: string;
		targetUri?: string;
		targetHandle?: string;
		direction?: QuoteLaneDirection;
		label: string;
		detail: string;
		error?: string;
	};
		type ParallelBoardViewProps = {
			thread: BoardThread;
			mainLaneAnchorUri?: string | null;
			sourceUri?: string | null;
			targetUri?: string | null;
			seedQuoteLanes?: SeedQuoteLane[];
			requestedFocusUri?: string | null;
			winningFocusUri?: string | null;
			onActivePostChange?: ActivePostChangeHandler;
			onWinningMove?: WinningMoveHandler;
			platform?: BoardPlatformConfig;
			showExport?: boolean;
		};
	type CelebrationBurst = {
		key: number;
		x: number;
		y: number;
	};

	const MAIN_LANE_ID = '__main__';
	const CARD_WIDTH = 360;
	const CARD_HEIGHT = 360;
	const CARD_GAP = 30;
	const STEP_X = CARD_WIDTH + 72;
	const STEP_Y = CARD_HEIGHT + CARD_GAP;
	const DEPTH_HEADROOM_ROWS = 3;
	const TREE_FAN_STEP_X = CARD_WIDTH + 38;
	const LANE_MARKER_WIDTH = 86;
	const LANE_MARKER_HEIGHT = 192;
	const LANE_MARKER_GAP = 24;
	const PADDING_X = 52;
	const PADDING_Y = 44;
		const CARD_SCROLL_STEP = 144;
			const ZOOM_MIN = 0.1;
			const ZOOM_MAX = 1.5;
			const ZOOM_STEP = 0.1;
		const FETCH_MODE_DELAY_MS = 700;
		const FETCH_MODE_MAX_TASKS = 250;
		const FETCH_MODE_VISIBLE_ITEMS = 9;
			function buildBlueskyPostUrl(uri: string, handle: string): string {
				const rkey = uri.split('/').pop();
				return `https://bsky.app/profile/${handle}/post/${rkey}`;
			}

		const defaultBoardPlatform: BoardPlatformConfig = {
			name: 'Bluesky',
			postLabel: 'post',
			buildPostUrl: buildBlueskyPostUrl,
			loadThread: getBlueskyFullThread,
			fetchQuotePosts: fetchBlueskyQuotesForPost
		};

		function buildKeyboardShortcuts(platformName: string) {
			return [
				{ keys: ['h', 'j', 'k', 'l'], description: 'Move the selected card left, down, up, and right' },
				{ keys: ['Arrow keys'], description: 'Move the selected card with the arrow keys' },
				{ keys: ['Shift + h/j/k/l', 'Shift + arrows'], description: 'Scroll the selected post card without changing selection' },
				{ keys: ['a', 's'], description: 'Switch backward or forward through stacked reply branches on the selected lane' },
				{ keys: ['t'], description: 'Expand or collapse the selected lane into a fan-shaped tree view' },
				{ keys: ['/', 'u'], description: 'Focus lane text search or author search' },
				{ keys: ['1-9'], description: 'Pick quote posts, or jump to numbered child branches in tree view' },
				{ keys: ['r', 'Backspace'], description: 'Jump to the current fork point or the root while in tree view' },
				{ keys: ['m'], description: 'Toggle big mode so cards grow with their content' },
				{ keys: ['g'], description: 'Open or close the selected post details modal' },
				{ keys: ['Enter'], description: 'Open the selected card in the tree board' },
				{ keys: ['o'], description: `Open the selected post on ${platformName}` },
				{ keys: ['q'], description: 'Fetch, link, or jump to the selected card’s quoted thread' },
				{ keys: ['w'], description: 'Open quote posts for the selected card' },
				{ keys: ['x'], description: 'Close the active quoted lane' },
				{ keys: ['+', '-', '0'], description: 'Zoom in, zoom out, or reset zoom' },
				{ keys: ['f'], description: 'Toggle fullscreen for the board' },
				{ keys: ['?', 'Esc'], description: 'Show shortcuts, or close the open picker or modal' }
			] as const;
		}

		let {
			thread,
			mainLaneAnchorUri = null,
			sourceUri = null,
		targetUri = null,
			seedQuoteLanes = [],
			requestedFocusUri = null,
			winningFocusUri = null,
			onActivePostChange,
			onWinningMove,
			platform = defaultBoardPlatform,
			showExport = true
		}: ParallelBoardViewProps = $props();

		let keyboardShortcuts = $derived(buildKeyboardShortcuts(platform.name));

	let parallelBoardLayoutEl: HTMLDivElement | undefined = $state();
	let boardEl: HTMLDivElement | undefined = $state();
	let shortcutsHelpEl: HTMLDivElement | undefined = $state();
	let detailModalDialogEl: HTMLDialogElement | undefined = $state();
	let treeBoardDialogEl: HTMLDialogElement | undefined = $state();
	let treeAuthorSearchInputEl: HTMLInputElement | undefined = $state();
	let treeTextSearchInputEl: HTMLInputElement | undefined = $state();
		let quoteLanes = $state<Record<string, QuoteLaneEntry>>({});
		let postQuotes = $state<Record<string, QuotePostFeedState>>({});
		let bulkQuoteLaneLoads = $state<Record<string, boolean>>({});
		let openQuotePickerCardKey = $state<string | null>(null);
		let fetchModeQueue = $state<FetchModeQueueItem[]>([]);
		let fetchModeRunning = $state(false);
		let fetchModePaused = $state(false);
		let showFetchModePanel = $state(true);
		let fetchModeRunId = $state(0);
		let nextFetchModeRunId = 1;
		let fetchModeStatusMessage = $state('');
		let fetchModeProcessedCount = $state(0);
		let fetchModeWorker: Worker | null = null;
		let nextFetchModeHydrationRequestId = 1;
		const fetchModeHydrationRequests = new Map<
			number,
			{ resolve: (thread: BoardThread) => void; reject: (error: Error) => void }
		>();
		let fetchModeQueuedTaskIds = new Set<string>();
		let fetchModeQueuedScanUris = new Set<string>();
		let fetchModeQueuedLaneTargets = new Set<string>();
		let fetchModeReachedTaskLimit = false;
		let laneActiveChainIds = $state<Record<string, string>>({});
	let expandedLaneId = $state<string | null>(null);
	let activeLaneId = $state(MAIN_LANE_ID);
	let activeCardKey = $state('');
	let detailModalTarget = $state<{ laneId: string; postUri: string } | null>(null);
		let treeBoardTarget = $state<{ laneId: string; postUri: string } | null>(null);
		let isParallelBoardFullscreen = $state(false);
		let isTreeBoardFullscreen = $state(false);
		let showShortcutsHelp = $state(false);
	let isBigMode = $state(false);
	let showTreeSearchPanel = $state(true);
	let treeAuthorSearch = $state('');
	let treeTextSearch = $state('');
	let treeSearchMessage = $state('');
	let treeSearchStatus = $state<'success' | 'error' | ''>('');
	let treeAuthorMatchLookup = $state<Record<string, boolean>>({});
	let treeTextMatchLookup = $state<Record<string, boolean>>({});
	let treeAuthorMatchQuery = $state('');
	let treeTextMatchQuery = $state('');
	let treeAuthorMatchIndex = $state(-1);
	let treeTextMatchIndex = $state(-1);
	let lastSearchLaneId = $state<string | null>(null);
	let cardHeights = $state<Record<string, number>>({});
		let zoom = $state(1);
		let zoomInput = $state('100');
		let isPanning = $state(false);
		let panStart = { x: 0, y: 0, scrollLeft: 0, scrollTop: 0 };
		let minimapEl: HTMLDivElement | undefined = $state();
		let minimapCanvas: HTMLCanvasElement | undefined = $state();
		let minimapScale = $state(0.05);
		let minimapW = $state(132);
		let minimapH = $state(92);
		let minimapDragging = $state(false);
		let minimapViewport = $state({ x: 0, y: 0, w: 0, h: 0 });
		let minimapFrame = 0;
	let lastCanvasOffsetY = $state(0);
	let lastHandledRequestedFocusUri = $state<string | null>(null);
	let lastHandledWinningFocusUri = $state<string | null>(null);
	let celebrationBurst = $state<CelebrationBurst | null>(null);
	let celebrationFrame = 0;
	let celebrationTimeout = 0;

	function collectLaneChains(rootPost: ThreadPost): LaneChain[] {
		const chains: LaneChain[] = [];

		function visit(post: ThreadPost, path: ThreadPost[], pathId: string) {
			const nextPath = [...path, post];
			if (post.children.length === 0) {
				chains.push({
					id: pathId,
					order: chains.length,
					posts: nextPath
				});
				return;
			}

			post.children.forEach((child, index) => {
				visit(child, nextPath, `${pathId}.${index}`);
			});
		}

		visit(rootPost, [], '0');
		return chains;
	}

	function findChainDivergenceDepth(activePosts: ThreadPost[], candidatePosts: ThreadPost[]): number {
		const limit = Math.min(activePosts.length, candidatePosts.length);
		for (let index = 0; index < limit; index += 1) {
			if (activePosts[index]?.uri !== candidatePosts[index]?.uri) {
				return index;
			}
		}
		return limit;
	}

	function getLaneDefaultActiveChainId(chains: LaneChain[], anchorUri: string): string {
		const preferredChain = [...chains].sort((a, b) => {
			const lengthDelta = b.posts.length - a.posts.length;
			if (lengthDelta !== 0) return lengthDelta;
			const aContainsAnchor = a.posts.some((post) => post.uri === anchorUri) ? 1 : 0;
			const bContainsAnchor = b.posts.some((post) => post.uri === anchorUri) ? 1 : 0;
			if (aContainsAnchor !== bContainsAnchor) return bContainsAnchor - aContainsAnchor;
			return a.order - b.order;
		})[0];
		return preferredChain?.id ?? '';
	}

	function getLaneAnchorActiveChainId(chains: LaneChain[], anchorUri: string): string {
		const anchorChains = chains.filter((chain) => chain.posts.some((post) => post.uri === anchorUri));
		if (anchorChains.length === 0) {
			return getLaneDefaultActiveChainId(chains, anchorUri);
		}

		const preferredChain = [...anchorChains].sort((a, b) => {
			const lengthDelta = b.posts.length - a.posts.length;
			if (lengthDelta !== 0) return lengthDelta;
			return a.order - b.order;
		})[0];
		return preferredChain?.id ?? '';
	}

	function mergeUniqueChainIds(...groups: string[][]): string[] {
		return Array.from(
			new Set(
				groups.flatMap((group) => group).filter((value): value is string => Boolean(value))
			)
		);
	}

	function buildPostDepthMap(rootPost: ThreadPost): Map<string, number> {
		const depthByPostUri = new Map<string, number>();

		function visit(post: ThreadPost, depth: number) {
			depthByPostUri.set(post.uri, depth);
			for (const child of post.children) {
				visit(child, depth + 1);
			}
		}

		visit(rootPost, 0);
		return depthByPostUri;
	}

	function buildTreeFanXMap(rootPost: ThreadPost): Map<string, number> {
		const widthByPostUri = new Map<string, number>();
		const xByPostUri = new Map<string, number>();

		function measure(post: ThreadPost): number {
			if (post.children.length === 0) {
				widthByPostUri.set(post.uri, 1);
				return 1;
			}

			const width = Math.max(
				post.children.reduce((sum, child) => sum + measure(child), 0),
				1
			);
			widthByPostUri.set(post.uri, width);
			return width;
		}

		function place(post: ThreadPost, startSlot: number): number {
			if (post.children.length === 0) {
				xByPostUri.set(post.uri, startSlot);
				return startSlot;
			}

			let cursor = startSlot;
			const childCenters: number[] = [];
			for (const child of post.children) {
				const childWidth = widthByPostUri.get(child.uri) ?? 1;
				childCenters.push(place(child, cursor));
				cursor += childWidth;
			}

			const center = (childCenters[0] + childCenters[childCenters.length - 1]) / 2;
			xByPostUri.set(post.uri, center);
			return center;
		}

		measure(rootPost);
		place(rootPost, 0);
		return xByPostUri;
	}

	function buildLaneTreeNavigation(rootPost: ThreadPost): LaneTreeNavigation {
		const order: ThreadPost[] = [];
		const indexByUri = new Map<string, number>();
		const parentByUri = new Map<string, ThreadPost>();

		function visit(post: ThreadPost, parent: ThreadPost | null) {
			if (parent) {
				parentByUri.set(post.uri, parent);
			}
			indexByUri.set(post.uri, order.length);
			order.push(post);
			for (const child of post.children) {
				visit(child, post);
			}
		}

		visit(rootPost, null);
		return { order, indexByUri, parentByUri };
	}

	function formatDate(iso: string): string {
		const d = new Date(iso);
		return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
	}

			function formatCount(n: number): string {
				if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
				return n.toString();
			}

			function clamp(value: number, min: number, max: number): number {
				return Math.min(Math.max(value, min), max);
			}

		function previewText(text: string | undefined, maxLength = 92): string {
			const normalized = text?.trim().replace(/\s+/g, ' ') || 'No text';
			return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 3)}...` : normalized;
		}

	function resolveLaneAnchorUri(laneThread: BoardThread, preferredUri: string | null | undefined): string {
		const candidateUri = preferredUri?.trim();
		if (!candidateUri) {
			return laneThread.rootPost.uri;
		}

		return (
			findFirstMatchingPost(laneThread.rootPost, (post) => post.uri === candidateUri)?.uri ??
			laneThread.rootPost.uri
		);
	}

	function buildThreadPathFromAnchor(
		rootPost: ThreadPost,
		anchorUri: string | null | undefined,
		targetUri: string
	): ThreadPost[] {
		const targetPost = findFirstMatchingPost(rootPost, (post) => post.uri === targetUri);
		if (!targetPost) return [];

		const parentMap = buildParentMap(rootPost);
		const lineage: ThreadPost[] = [];
		let current: ThreadPost | undefined = targetPost;

		while (current) {
			lineage.unshift(current);
			current = parentMap.get(current.uri);
		}

		const resolvedAnchorUri = anchorUri?.trim() ?? null;
		if (!resolvedAnchorUri) {
			return lineage;
		}

		const anchorIndex = lineage.findIndex((post) => post.uri === resolvedAnchorUri);
		return anchorIndex >= 0 ? lineage.slice(anchorIndex) : lineage;
	}

	function findBoardPostByUri(uri: string | null | undefined): ThreadPost | null {
		const normalizedUri = uri?.trim() ?? '';
		if (!normalizedUri) return null;

		const preferredCardPost = boardModel.cardsByPostUri.get(normalizedUri)?.post;
		if (preferredCardPost) {
			return preferredCardPost;
		}

		for (const lane of boardModel.lanes) {
			const match = findFirstMatchingPost(lane.thread.rootPost, (post) => post.uri === normalizedUri);
			if (match) {
				return match;
			}
		}

		return null;
	}

	function buildWinningMoveSummaryPosts(details: WinningMoveDetails): ThreadPost[] {
		const posts: ThreadPost[] = [];
		const seenUris = new Set<string>();

		function append(post: ThreadPost | null | undefined) {
			if (!post || seenUris.has(post.uri)) return;
			seenUris.add(post.uri);
			posts.push(post);
		}

		// Walk backwards through the chain of lanes to collect path segments
		// from root anchor → ... → sourceUri → winning lane anchor → ... → target
		const segments: ThreadPost[][] = [];

		// 1. Build path within the winning lane (anchor → target)
		const winningLane = boardModel.laneById.get(details.laneId);
		if (winningLane) {
			const winPath = buildThreadPathFromAnchor(
				winningLane.thread.rootPost,
				winningLane.anchorUri,
				details.targetUri
			);
			segments.unshift(winPath);
		}

		// 2. Walk back through source lanes to the root
		let currentSourceUri = details.sourceUri?.trim() ?? null;
		let currentSourceLaneId = details.sourceLaneId?.trim() ?? null;

		while (currentSourceUri && currentSourceLaneId) {
			const srcLane = boardModel.laneById.get(currentSourceLaneId);
			if (!srcLane) break;

			const pathInSrcLane = buildThreadPathFromAnchor(
				srcLane.thread.rootPost,
				srcLane.anchorUri,
				currentSourceUri
			);
			segments.unshift(pathInSrcLane);

			// If this lane is itself a quoted lane, continue tracing back
			if (srcLane.kind === 'quoted' && srcLane.sourceUri && srcLane.sourceLaneId) {
				currentSourceUri = srcLane.sourceUri;
				currentSourceLaneId = srcLane.sourceLaneId;
			} else {
				break;
			}
		}

		// Flatten all segments in order
		for (const segment of segments) {
			segment.forEach((post) => append(post));
		}

		return posts;
	}

	function buildSeedQuoteLaneMap(seedLanes: SeedQuoteLane[]): Record<string, QuoteLaneEntry> {
		const entries: Record<string, QuoteLaneEntry> = {};

		seedLanes.forEach((seedLane, index) => {
			const laneId = seedLane.quotedUri.trim();
			if (!laneId) return;

			entries[laneId] = {
				quotedUri: laneId,
				quotedHandle: seedLane.quotedHandle,
				sourceUri: seedLane.sourceUri,
				sourceLaneId: seedLane.sourceLaneId ?? MAIN_LANE_ID,
				loadedAt: seedLane.loadedAt ?? index + 1,
				direction: seedLane.direction ?? 'outbound',
				status: 'ready',
				thread: seedLane.thread,
				targetLaneId: laneId,
				targetPostUri: resolveLaneAnchorUri(
					seedLane.thread,
					seedLane.targetPostUri ?? seedLane.quotedUri
				)
			};
		});

		return entries;
	}

	function buildSeedLaneActiveChainIds(seedLanes: SeedQuoteLane[]): Record<string, string> {
		const activeChains: Record<string, string> = {};

		seedLanes.forEach((seedLane) => {
			const laneId = seedLane.quotedUri.trim();
			if (!laneId) return;

			const anchorUri = resolveLaneAnchorUri(
				seedLane.thread,
				seedLane.targetPostUri ?? seedLane.quotedUri
			);
			const preferredChainId = getLaneAnchorActiveChainId(
				collectLaneChains(seedLane.thread.rootPost),
				anchorUri
			);
			if (preferredChainId) {
				activeChains[laneId] = preferredChainId;
			}
		});

		return activeChains;
	}

	function postUrl(uri: string, handle: string): string {
		return platform.buildPostUrl(uri, handle);
	}

		function isReadyQuoteLaneEntry(entry: QuoteLaneEntry): entry is ReadyQuoteLaneEntry {
			return entry.status === 'ready' && Boolean(entry.thread);
		}

		function isResolvedQuoteLaneEntry(entry: QuoteLaneEntry | undefined): entry is ResolvedQuoteLaneEntry {
			return entry?.status === 'ready' || entry?.status === 'linked';
		}

		function buildBoardModel(
			mainThread: BoardThread,
			mainAnchorUri: string | null,
			readyQuoteEntries: ReadyQuoteLaneEntry[],
			quoteEntries: QuoteLaneEntry[],
			activeChainByLane: Record<string, string>,
			expandedLane: string | null,
			cardHeightLookup: Record<string, number>,
			bigMode: boolean
		): BoardModel {
			const laneById = new Map<string, LaneRenderModel>();
			const depthByLanePostUri = new Map<string, Map<string, number>>();
			const childrenByParent = new Map<string, LaneRenderModel[]>();
			const cardHeightForKey = (cardKey: string) =>
				bigMode ? Math.max(CARD_HEIGHT, cardHeightLookup[cardKey] ?? CARD_HEIGHT) : CARD_HEIGHT;

			function createLaneModel(
				id: string,
				kind: LaneKind,
				label: string,
				title: string,
				handle: string,
				anchorUri: string,
				laneThread: BoardThread,
				loadedAt: number,
				sourceUri?: string,
				sourceLaneId?: string
			): LaneRenderModel {
				const chains = collectLaneChains(laneThread.rootPost);
				const activeChainId =
					chains.some((chain) => chain.id === activeChainByLane[id])
						? activeChainByLane[id]
						: kind === 'quoted'
							? getLaneAnchorActiveChainId(chains, anchorUri)
							: getLaneDefaultActiveChainId(chains, anchorUri);
				const lane: LaneRenderModel = {
					id,
					kind,
					label,
					title,
					handle,
					anchorUri,
					thread: laneThread,
					loadedAt,
					sourceUri,
					sourceLaneId,
					column: 0,
					depthOffset: 0,
					x: PADDING_X,
					activeChainId,
					chains,
					activeCards: [],
					maxDepth: Math.max(...chains.map((chain) => chain.posts.length), 1),
					cards: []
				};
				laneById.set(id, lane);
				depthByLanePostUri.set(id, buildPostDepthMap(laneThread.rootPost));
				return lane;
			}

			const resolvedMainAnchorUri = resolveLaneAnchorUri(mainThread, mainAnchorUri);

			createLaneModel(
				MAIN_LANE_ID,
				'main',
				'Present',
				`@${mainThread.rootPost.author.handle}`,
				mainThread.rootPost.author.handle,
				resolvedMainAnchorUri,
				mainThread,
				0
			);

			readyQuoteEntries.forEach((entry, index) => {
				const handle = entry.thread.rootPost.author.handle || entry.quotedHandle || 'unknown';
				const lane = createLaneModel(
					entry.quotedUri,
					'quoted',
					`Q${index + 1}`,
					`@${handle}`,
					handle,
					resolveLaneAnchorUri(entry.thread, entry.targetPostUri ?? entry.quotedUri),
					entry.thread,
					entry.loadedAt,
					entry.sourceUri,
					entry.sourceLaneId
				);
				const siblings = childrenByParent.get(entry.sourceLaneId) ?? [];
				siblings.push(lane);
				childrenByParent.set(entry.sourceLaneId, siblings);
			});

			for (const siblings of childrenByParent.values()) {
				siblings.sort((a, b) => a.loadedAt - b.loadedAt);
			}

			const orderedLanes: LaneRenderModel[] = [
				laneById.get(MAIN_LANE_ID)!,
				...readyQuoteEntries
					.map((entry) => laneById.get(entry.quotedUri))
					.filter((lane): lane is LaneRenderModel => Boolean(lane))
			];

			const depthAssignedLaneIds = new Set<string>();
			function assignDepthOffsets(laneId: string, depthOffset: number) {
				const lane = laneById.get(laneId);
				if (!lane || depthAssignedLaneIds.has(laneId)) return;
				depthAssignedLaneIds.add(laneId);
				lane.depthOffset = depthOffset;
				const depthByPost = depthByLanePostUri.get(laneId) ?? new Map<string, number>();
				for (const child of childrenByParent.get(laneId) ?? []) {
					const childDepthByPost = depthByLanePostUri.get(child.id) ?? new Map<string, number>();
					const sourceDepth = depthByPost.get(child.sourceUri ?? '') ?? 0;
					const anchorDepth = childDepthByPost.get(child.anchorUri) ?? 0;
					assignDepthOffsets(child.id, depthOffset + sourceDepth - anchorDepth);
				}
			}

			const readyEntryByLaneId = new Map<string, ReadyQuoteLaneEntry>(
				readyQuoteEntries.map((entry) => [entry.quotedUri, entry])
			);
			const columnAssignedLaneIds = new Set<string>([MAIN_LANE_ID]);

			function assignLaneColumn(laneId: string) {
				if (columnAssignedLaneIds.has(laneId)) return;
				const entry = readyEntryByLaneId.get(laneId);
				const lane = laneById.get(laneId);
				if (!entry || !lane) return;

				assignLaneColumn(entry.sourceLaneId);
				const sourceLane = laneById.get(entry.sourceLaneId);
				const sourceColumn = sourceLane?.column ?? 0;
				const desiredColumn = sourceColumn + (entry.direction === 'inbound' ? -1 : 1);

				for (const existingLane of orderedLanes) {
					if (!columnAssignedLaneIds.has(existingLane.id)) continue;
					if (entry.direction === 'inbound') {
						if (existingLane.column <= desiredColumn) {
							existingLane.column -= 1;
						}
					} else if (existingLane.column >= desiredColumn) {
						existingLane.column += 1;
					}
				}

				lane.column = desiredColumn;
				columnAssignedLaneIds.add(laneId);
			}

			readyQuoteEntries.forEach((entry) => {
				assignLaneColumn(entry.quotedUri);
			});

			assignDepthOffsets(MAIN_LANE_ID, 0);
			for (const lane of orderedLanes) {
				if (!depthAssignedLaneIds.has(lane.id)) {
					assignDepthOffsets(lane.id, 0);
				}
			}

			const minColumn = Math.min(0, ...orderedLanes.map((lane) => lane.column));
			const maxColumn = Math.max(0, ...orderedLanes.map((lane) => lane.column));

			const cardsByKey = new Map<string, LaneCard>();
			const cardsByLanePost = new Map<string, LaneCard>();
			const cardsByPostUri = new Map<string, LaneCard>();
			const absoluteDepthByCardKey = new Map<string, number>();
			let minDepth = 0;
			let maxDepth = 0;

			function setPreferredPostCard(card: LaneCard) {
				const existing = cardsByPostUri.get(card.post.uri);
				if (!existing) {
					cardsByPostUri.set(card.post.uri, card);
					return;
				}

				const score = (candidate: LaneCard) =>
					(candidate.laneKind === 'main' ? 4 : 0) +
					(candidate.visibility === 'active' ? 2 : 0) +
					(candidate.isLaneRoot ? 1 : 0);
				if (score(card) > score(existing)) {
					cardsByPostUri.set(card.post.uri, card);
				}
			}

			function registerLaneCard(card: LaneCard) {
				laneById.get(card.laneId)?.cards.push(card);
				if (card.visibility === 'active') {
					laneById.get(card.laneId)?.activeCards.push(card);
				}
				cardsByKey.set(card.key, card);
				cardsByLanePost.set(`${card.laneId}:${card.post.uri}`, card);
				setPreferredPostCard(card);
			}

			const connectors: LaneConnector[] = [];

			for (const lane of orderedLanes) {
				lane.x = PADDING_X + (lane.column - minColumn) * STEP_X;
				const isExpandedTreeLane = expandedLane === lane.id;
				if (isExpandedTreeLane) {
					const depthByPost = depthByLanePostUri.get(lane.id) ?? new Map<string, number>();
					const xByPost = buildTreeFanXMap(lane.thread.rootPost);
					const anchorX = xByPost.get(lane.anchorUri) ?? xByPost.get(lane.thread.rootPost.uri) ?? 0;
					const fanCards: LaneCard[] = [];

					function collectFanCards(post: ThreadPost) {
						const depth = depthByPost.get(post.uri) ?? 0;
						const card: LaneCard = {
							key: `${lane.id}:${post.uri}`,
							laneId: lane.id,
							laneLabel: lane.label,
							laneTitle: lane.title,
							laneKind: lane.kind,
							laneIsTruncated: Boolean(lane.thread.isTruncated),
							post,
							chainId: lane.activeChainId,
							chainOrder: 0,
							depth,
							x: lane.x + ((xByPost.get(post.uri) ?? anchorX) - anchorX) * TREE_FAN_STEP_X,
							y: 0,
							visibility: 'active',
							divergenceDepth: depth,
							stackIndex: 0,
							switchGroupChainIds: [],
							isLaneRoot: depth === 0
						};
						const absoluteDepth = lane.depthOffset + depth;
						absoluteDepthByCardKey.set(card.key, absoluteDepth);
						minDepth = Math.min(minDepth, absoluteDepth);
						maxDepth = Math.max(maxDepth, absoluteDepth);
						fanCards.push(card);
						for (const child of post.children) {
							collectFanCards(child);
						}
					}

					collectFanCards(lane.thread.rootPost);
					fanCards.sort((a, b) => {
						const depthDelta =
							(absoluteDepthByCardKey.get(a.key) ?? 0) - (absoluteDepthByCardKey.get(b.key) ?? 0);
						if (depthDelta !== 0) return depthDelta;
						return a.x - b.x;
					});

					for (const card of fanCards) {
						registerLaneCard(card);
					}

					function collectTreeConnectors(post: ThreadPost) {
						const fromCard = cardsByLanePost.get(`${lane.id}:${post.uri}`);
						if (!fromCard) return;
						for (const child of post.children) {
							const toCard = cardsByLanePost.get(`${lane.id}:${child.uri}`);
							if (toCard) {
								connectors.push({
									key: `tree:${fromCard.key}->${toCard.key}`,
									from: fromCard,
									to: toCard,
									kind: 'tree'
								});
							}
							collectTreeConnectors(child);
						}
					}

					collectTreeConnectors(lane.thread.rootPost);
					continue;
				}

				const activeChain = lane.chains.find((chain) => chain.id === lane.activeChainId) ?? lane.chains[0];
				if (!activeChain) continue;
				const activePosts = activeChain.posts;
				const switchGroupByDepth = new Map<number, string[]>();

				for (const chain of lane.chains) {
					if (chain.id === activeChain.id) continue;
					const divergenceDepth = findChainDivergenceDepth(activePosts, chain.posts);
					if (divergenceDepth >= chain.posts.length || divergenceDepth >= activePosts.length) continue;
					const group = switchGroupByDepth.get(divergenceDepth) ?? [activeChain.id];
					group.push(chain.id);
					group.sort((a, b) => {
						const chainA = lane.chains.find((candidate) => candidate.id === a);
						const chainB = lane.chains.find((candidate) => candidate.id === b);
						return (chainA?.order ?? 0) - (chainB?.order ?? 0);
					});
					switchGroupByDepth.set(divergenceDepth, group);
				}

				const visibleCardByPostUri = new Map<string, LaneCard>();
				for (const chain of lane.chains) {
					const isActiveChain = chain.id === activeChain.id;
					const divergenceDepth = isActiveChain
						? 0
						: findChainDivergenceDepth(activePosts, chain.posts);
					const startDepth = isActiveChain ? 0 : divergenceDepth;
					if (!isActiveChain && startDepth >= chain.posts.length) continue;

					for (let depth = startDepth; depth < chain.posts.length; depth += 1) {
						const post = chain.posts[depth];
						const card: LaneCard = {
							key: `${lane.id}:${post.uri}`,
							laneId: lane.id,
							laneLabel: lane.label,
							laneTitle: lane.title,
							laneKind: lane.kind,
							laneIsTruncated: Boolean(lane.thread.isTruncated),
							post,
							chainId: chain.id,
							chainOrder: chain.order,
							depth,
							x: lane.x,
							y: 0,
							visibility: isActiveChain ? 'active' : 'shadow',
							divergenceDepth,
							stackIndex: 0,
							switchGroupChainIds: isActiveChain ? switchGroupByDepth.get(depth) ?? [] : [],
							isLaneRoot: depth === 0
						};
						const absoluteDepth = lane.depthOffset + depth;
						absoluteDepthByCardKey.set(card.key, absoluteDepth);
						minDepth = Math.min(minDepth, absoluteDepth);
						maxDepth = Math.max(maxDepth, absoluteDepth);
						const existing = visibleCardByPostUri.get(post.uri);
						if (!existing) {
							visibleCardByPostUri.set(post.uri, card);
							continue;
						}

						existing.switchGroupChainIds = mergeUniqueChainIds(
							existing.switchGroupChainIds,
							card.switchGroupChainIds
						);
						if (existing.visibility === 'active' && card.visibility === 'shadow') {
							continue;
						}
						if (existing.visibility === 'shadow' && card.visibility === 'active') {
							card.switchGroupChainIds = existing.switchGroupChainIds;
							visibleCardByPostUri.set(post.uri, card);
							continue;
						}
						if (
							card.divergenceDepth < existing.divergenceDepth ||
							(card.divergenceDepth === existing.divergenceDepth && card.chainOrder < existing.chainOrder)
						) {
							existing.chainId = card.chainId;
							existing.chainOrder = card.chainOrder;
							existing.divergenceDepth = card.divergenceDepth;
						}
					}
				}

				const visibleCards = Array.from(visibleCardByPostUri.values());

				const shadowGroups = new Map<number, LaneCard[]>();
				for (const card of visibleCards) {
					if (card.visibility !== 'shadow') continue;
					const absoluteDepth = absoluteDepthByCardKey.get(card.key) ?? 0;
					const group = shadowGroups.get(absoluteDepth) ?? [];
					group.push(card);
					shadowGroups.set(absoluteDepth, group);
				}

				for (const group of shadowGroups.values()) {
					group
						.sort((a, b) => {
							if (a.divergenceDepth !== b.divergenceDepth) {
								return b.divergenceDepth - a.divergenceDepth;
							}
							return a.chainOrder - b.chainOrder;
						})
						.forEach((card, index) => {
							card.stackIndex = index;
						});
				}

				visibleCards.sort((a, b) => {
					const depthDelta =
						(absoluteDepthByCardKey.get(a.key) ?? 0) - (absoluteDepthByCardKey.get(b.key) ?? 0);
					if (depthDelta !== 0) return depthDelta;
					if (a.visibility !== b.visibility) return a.visibility === 'shadow' ? -1 : 1;
					return a.chainOrder - b.chainOrder;
				});

				for (const card of visibleCards) {
					card.x = lane.x;
					registerLaneCard(card);
				}
			}

			for (const entry of quoteEntries) {
				if (!isResolvedQuoteLaneEntry(entry)) continue;

				if (entry.direction === 'inbound') {
					const sourceCard =
						cardsByLanePost.get(`${entry.sourceLaneId}:${entry.sourceUri}`) ??
						cardsByPostUri.get(entry.sourceUri);
					const quoteCard =
						cardsByLanePost.get(`${entry.targetLaneId}:${entry.targetPostUri}`) ??
						cardsByPostUri.get(entry.targetPostUri);
					if (!sourceCard || !quoteCard) continue;
					connectors.push({
						key: `spawn:${quoteCard.key}->${sourceCard.key}`,
						from: quoteCard,
						to: sourceCard,
						kind: 'spawn'
					});
					continue;
				}

				const targetCard =
					cardsByLanePost.get(`${entry.targetLaneId}:${entry.targetPostUri}`) ??
					cardsByPostUri.get(entry.targetPostUri);
				if (!targetCard) continue;

				for (const lane of orderedLanes) {
					for (const card of lane.cards) {
						if (card.post.embed?.record?.uri !== entry.quotedUri) continue;
						const isPrimarySpawn =
							entry.status === 'ready' &&
							card.laneId === entry.sourceLaneId &&
							card.post.uri === entry.sourceUri &&
							targetCard.laneId === entry.quotedUri &&
							targetCard.post.uri === entry.quotedUri;
						connectors.push({
							key: `${isPrimarySpawn ? 'spawn' : 'reference'}:${card.key}->${targetCard.key}`,
							from: card,
							to: targetCard,
							kind: isPrimarySpawn ? 'spawn' : 'reference'
						});
					}
				}
			}

			const contentMinX = Math.min(
				...orderedLanes.map((lane) => lane.x + (CARD_WIDTH - LANE_MARKER_WIDTH) / 2),
				...Array.from(cardsByKey.values(), (card) => card.x)
			);
			const xShift = PADDING_X - contentMinX;
			if (Number.isFinite(xShift) && xShift !== 0) {
				for (const lane of orderedLanes) {
					lane.x += xShift;
				}
				for (const card of cardsByKey.values()) {
					card.x += xShift;
				}
			}

			const baseCardTop = PADDING_Y + LANE_MARKER_HEIGHT + LANE_MARKER_GAP;
			const rowTopByDepth = new Map<number, number>([[0, baseCardTop]]);
			const rowHeightByDepth = new Map<number, number>();

			for (const card of cardsByKey.values()) {
				const absoluteDepth = absoluteDepthByCardKey.get(card.key) ?? 0;
				rowHeightByDepth.set(
					absoluteDepth,
					Math.max(rowHeightByDepth.get(absoluteDepth) ?? CARD_HEIGHT, cardHeightForKey(card.key))
				);
			}

			for (let depth = 1; depth <= maxDepth; depth += 1) {
				const previousTop = rowTopByDepth.get(depth - 1) ?? baseCardTop;
				const previousHeight = rowHeightByDepth.get(depth - 1) ?? CARD_HEIGHT;
				rowTopByDepth.set(depth, previousTop + previousHeight + CARD_GAP);
			}

			for (let depth = -1; depth >= minDepth; depth -= 1) {
				const nextTop = rowTopByDepth.get(depth + 1) ?? baseCardTop;
				const depthHeight = rowHeightByDepth.get(depth) ?? CARD_HEIGHT;
				rowTopByDepth.set(depth, nextTop - depthHeight - CARD_GAP);
			}

			let minRawY = baseCardTop;
			let maxRawBottom = baseCardTop + CARD_HEIGHT;
			for (const card of cardsByKey.values()) {
				const absoluteDepth = absoluteDepthByCardKey.get(card.key) ?? 0;
				card.y = rowTopByDepth.get(absoluteDepth) ?? baseCardTop;
				minRawY = Math.min(minRawY, card.y);
				maxRawBottom = Math.max(maxRawBottom, card.y + cardHeightForKey(card.key));
			}

			let boardRightEdge = PADDING_X + CARD_WIDTH;
			for (const lane of orderedLanes) {
				const markerLeft = lane.x + (CARD_WIDTH - LANE_MARKER_WIDTH) / 2;
				boardRightEdge = Math.max(boardRightEdge, markerLeft + LANE_MARKER_WIDTH);
			}
			for (const card of cardsByKey.values()) {
				boardRightEdge = Math.max(boardRightEdge, card.x + CARD_WIDTH);
			}

			const boardWidth = boardRightEdge + PADDING_X;
			const negativeExtent = minDepth < 0 ? Math.max(0, baseCardTop - minRawY) : 0;
			const canvasOffsetY =
				negativeExtent > 0 ? negativeExtent + DEPTH_HEADROOM_ROWS * STEP_Y : 0;
			const boardHeight = Math.max(
				maxRawBottom + PADDING_Y,
				PADDING_Y * 2 + LANE_MARKER_HEIGHT + LANE_MARKER_GAP + CARD_HEIGHT
			);

			return {
				lanes: orderedLanes,
				laneById,
				cardsByKey,
				cardsByPostUri,
				connectors,
				boardWidth,
				boardHeight,
				canvasOffsetY
			};
		}

		let allQuoteEntries = $derived.by(() =>
			Object.values(quoteLanes).sort((a, b) => a.loadedAt - b.loadedAt)
		);

		let readyQuoteLanes = $derived.by(() =>
			allQuoteEntries.filter(isReadyQuoteLaneEntry)
		);

		let fetchModePendingCount = $derived.by(() =>
			fetchModeQueue.filter((item) => item.status === 'pending').length
		);
		let fetchModeActiveCount = $derived.by(() =>
			fetchModeQueue.filter((item) => item.status === 'running').length
		);
		let fetchModeErrorCount = $derived.by(() =>
			fetchModeQueue.filter((item) => item.status === 'error').length
		);
		let visibleFetchModeQueue = $derived.by(() => {
			const activeItems = fetchModeQueue.filter((item) => item.status === 'running');
			const isProcessed = (item: FetchModeQueueItem) =>
				item.status === 'done' || item.status === 'skipped' || item.status === 'error';
			const processedLaneItems = fetchModeQueue
				.filter((item) => item.kind === 'open-lane' && isProcessed(item))
				.slice(-FETCH_MODE_VISIBLE_ITEMS)
				.reverse();
			const processedScanItems = fetchModeQueue
				.filter((item) => item.kind === 'scan-post' && isProcessed(item))
				.slice(-FETCH_MODE_VISIBLE_ITEMS)
				.reverse();
			const remainingProcessedSlots = Math.max(
				0,
				FETCH_MODE_VISIBLE_ITEMS - activeItems.length - processedLaneItems.length
			);
			const processedItems = [
				...processedLaneItems,
				...processedScanItems.slice(0, remainingProcessedSlots)
			];
			const remainingSlots = Math.max(0, FETCH_MODE_VISIBLE_ITEMS - activeItems.length - processedItems.length);
			const nextItems = fetchModeQueue
				.filter((item) => item.status === 'pending')
				.slice(0, remainingSlots);
			return [...activeItems, ...processedItems, ...nextItems].slice(0, FETCH_MODE_VISIBLE_ITEMS);
		});

		let boardModel = $derived.by(() =>
			buildBoardModel(
				thread,
				mainLaneAnchorUri,
				readyQuoteLanes,
				allQuoteEntries,
				laneActiveChainIds,
				expandedLaneId,
				cardHeights,
				isBigMode
			)
		);
	let activeCard = $derived.by(
		() =>
			boardModel.cardsByKey.get(activeCardKey) ??
			boardModel.lanes[0]?.activeCards[0] ??
			boardModel.lanes[0]?.cards[0] ??
			null
	);
	let activeLane = $derived.by(() => (activeCard ? boardModel.laneById.get(activeCard.laneId) ?? null : null));
	let exportAllPosts = $derived.by(() => collectUniqueLanePosts(boardModel.lanes));
	let expandedSearchLane = $derived.by(() =>
		expandedLaneId ? boardModel.laneById.get(expandedLaneId) ?? null : null
	);
	let searchLane = $derived.by(() => expandedSearchLane ?? activeLane);
	let detailModalLane = $derived.by(() =>
		detailModalTarget ? boardModel.laneById.get(detailModalTarget.laneId) ?? null : null
	);
	let detailModalCard = $derived.by(() =>
		detailModalTarget
			? boardModel.cardsByKey.get(`${detailModalTarget.laneId}:${detailModalTarget.postUri}`) ?? null
			: null
	);
	let treeBoardLane = $derived.by(() =>
		treeBoardTarget ? boardModel.laneById.get(treeBoardTarget.laneId) ?? null : null
	);
	let treeBoardCard = $derived.by(() =>
		treeBoardTarget
			? boardModel.cardsByKey.get(`${treeBoardTarget.laneId}:${treeBoardTarget.postUri}`) ?? null
			: null
	);
	let expandedLaneTreeNavigation = $derived.by(() => {
		const navigationByLaneId = new Map<string, LaneTreeNavigation>();
		for (const lane of boardModel.lanes) {
			if (!laneIsExpanded(lane.id)) continue;
			navigationByLaneId.set(lane.id, buildLaneTreeNavigation(lane.thread.rootPost));
		}
		return navigationByLaneId;
	});

	function laneIsExpanded(laneId: string): boolean {
		return expandedLaneId === laneId;
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

	function resetTreeSearchState() {
		treeSearchMessage = '';
		treeSearchStatus = '';
		treeAuthorMatchLookup = {};
		treeTextMatchLookup = {};
		treeAuthorMatchQuery = '';
		treeTextMatchQuery = '';
		treeAuthorMatchIndex = -1;
		treeTextMatchIndex = -1;
	}

	function isTreeAuthorSearchMatch(post: ThreadPost): boolean {
		return treeAuthorMatchLookup[post.uri] ?? false;
	}

	function isTreeTextSearchMatch(post: ThreadPost): boolean {
		return treeTextMatchLookup[post.uri] ?? false;
	}

	function getCardTextValue(post: ThreadPost): string {
		return post.text?.trim() || 'No text';
	}

	function getTreeTextHighlightSegments(post: ThreadPost): HighlightSegment[] {
		const text = getCardTextValue(post);
		if (!isTreeTextSearchMatch(post)) {
			return [{ text, match: false }];
		}

		return splitHighlightedText(text, treeTextMatchQuery);
	}

	function cardMatchesSearchLane(card: LaneCard): boolean {
		return Boolean(searchLane && card.laneId === searchLane.id);
	}

	function cardMatchesPinnedUri(card: LaneCard, uri: string | null): boolean {
		return Boolean(uri && card.post.uri === uri);
	}

	function cardIsSourcePin(card: LaneCard): boolean {
		return cardMatchesPinnedUri(card, sourceUri);
	}

	function cardIsTargetPin(card: LaneCard): boolean {
		return cardMatchesPinnedUri(card, targetUri);
	}

	function getRenderedCardHeight(card: LaneCard): number {
		return isBigMode ? Math.max(CARD_HEIGHT, cardHeights[card.key] ?? CARD_HEIGHT) : CARD_HEIGHT;
	}

	function setMeasuredCardHeight(cardKey: string, height: number) {
		const nextHeight = Math.max(CARD_HEIGHT, Math.round(height));
		if ((cardHeights[cardKey] ?? CARD_HEIGHT) === nextHeight) return;
		cardHeights = {
			...cardHeights,
			[cardKey]: nextHeight
		};
	}

	function clearMeasuredCardHeight(cardKey: string) {
		if (!(cardKey in cardHeights)) return;
		const nextHeights = { ...cardHeights };
		delete nextHeights[cardKey];
		cardHeights = nextHeights;
	}

	function measureCardHeight(node: HTMLElement, cardKey: string) {
		let currentKey = cardKey;
		let frame = 0;

		const updateHeight = () => {
			if (frame) cancelAnimationFrame(frame);
			frame = requestAnimationFrame(() => {
				frame = 0;
				setMeasuredCardHeight(currentKey, node.offsetHeight);
			});
		};

		updateHeight();
		const observer = new ResizeObserver(updateHeight);
		observer.observe(node);

		return {
			update(nextKey: string) {
				if (nextKey === currentKey) {
					updateHeight();
					return;
				}
				clearMeasuredCardHeight(currentKey);
				currentKey = nextKey;
				updateHeight();
			},
			destroy() {
				observer.disconnect();
				if (frame) cancelAnimationFrame(frame);
				clearMeasuredCardHeight(currentKey);
			}
		};
	}

	function cardIsGhosted(card: LaneCard): boolean {
		return Boolean(expandedLaneId && card.laneId !== expandedLaneId);
	}

	function connectorIsMuted(connector: LaneConnector): boolean {
		if (!expandedLaneId) return false;
		if (connector.kind === 'tree') return connector.from.laneId !== expandedLaneId;
		return connector.from.laneId !== expandedLaneId && connector.to.laneId !== expandedLaneId;
	}

	async function toggleLaneTree(
		laneId: string,
		preferredPostUri?: string,
		scrollBehavior: ScrollBehavior = 'smooth'
	) {
		const nextExpandedLaneId = expandedLaneId === laneId ? null : laneId;
		if (nextExpandedLaneId !== expandedLaneId) {
			resetTreeSearchState();
		}
		expandedLaneId = nextExpandedLaneId;
		await tick();
		const targetPostUri =
			preferredPostUri && boardModel.cardsByKey.has(`${laneId}:${preferredPostUri}`)
				? preferredPostUri
				: boardModel.laneById.get(laneId)?.anchorUri;
		if (targetPostUri) {
			await focusCard(`${laneId}:${targetPostUri}`, scrollBehavior);
			return;
		}
		await focusLane(laneId, scrollBehavior);
	}

	function getExpandedLaneTreeNavigation(laneId: string): LaneTreeNavigation | null {
		return expandedLaneTreeNavigation.get(laneId) ?? null;
	}

	function getExpandedTreeIndex(card: LaneCard): number {
		const navigation = getExpandedLaneTreeNavigation(card.laneId);
		return navigation?.indexByUri.get(card.post.uri) ?? -1;
	}

	function getExpandedTreeCount(card: LaneCard): number {
		return getExpandedLaneTreeNavigation(card.laneId)?.order.length ?? 0;
	}

	function getExpandedTreeChildPosts(card: LaneCard): ThreadPost[] {
		return laneIsExpanded(card.laneId) ? card.post.children : [];
	}

	async function focusTreeSearchMatch(
		post: ThreadPost,
		message: string,
		scrollBehavior: ScrollBehavior = 'auto'
	) {
		if (!searchLane) return;
		treeSearchMessage = message;
		treeSearchStatus = 'success';
		await tick();
		await focusCard(`${searchLane.id}:${post.uri}`, scrollBehavior);
	}

	function setTreeSearchError(message: string) {
		treeSearchMessage = message;
		treeSearchStatus = 'error';
	}

	async function focusTreeSearchInput(mode: 'author' | 'text') {
		if (!searchLane) return;
		showTreeSearchPanel = true;
		await tick();
		const input = mode === 'author' ? treeAuthorSearchInputEl : treeTextSearchInputEl;
		input?.focus();
		input?.select();
	}

	async function searchTreeAuthor() {
		const lane = searchLane;
		const rawQuery = treeAuthorSearch.trim();
		const query = normalizeSearchQuery(treeAuthorSearch);
		if (!lane) {
			setTreeSearchError('Select a lane to search.');
			return;
		}
		if (!query) {
			setTreeSearchError('Enter an author to search.');
			return;
		}

		const matches = findMatchingPosts(lane.thread.rootPost, (post) => {
			const handle = post.author.handle.toLowerCase();
			const displayName = post.author.displayName?.toLowerCase() ?? '';
			return handle.includes(query) || displayName.includes(query);
		});

		if (!matches.length) {
			treeAuthorMatchLookup = {};
			treeAuthorMatchQuery = query;
			treeAuthorMatchIndex = -1;
			setTreeSearchError(`Author "${rawQuery}" not found in this lane.`);
			return;
		}

		const nextIndex = nextSearchIndex(treeAuthorMatchQuery, query, treeAuthorMatchIndex, matches.length);
		const match = matches[nextIndex];

		treeAuthorMatchLookup = buildMatchLookup(matches);
		treeAuthorMatchQuery = query;
		treeAuthorMatchIndex = nextIndex;

		await focusTreeSearchMatch(match, `Found ${matches.length} author matches (${nextIndex + 1}/${matches.length}).`);
	}

	async function searchTreeText() {
		const lane = searchLane;
		const rawQuery = treeTextSearch.trim();
		const query = normalizeSearchQuery(treeTextSearch);
		if (!lane) {
			setTreeSearchError('Select a lane to search.');
			return;
		}
		if (!query) {
			setTreeSearchError('Enter text to search.');
			return;
		}

		const matches = findMatchingPosts(
			lane.thread.rootPost,
			(post) => post.text.toLowerCase().includes(query)
		);

		if (!matches.length) {
			treeTextMatchLookup = {};
			treeTextMatchQuery = query;
			treeTextMatchIndex = -1;
			setTreeSearchError(`Text "${rawQuery}" not found in this lane.`);
			return;
		}

		const nextIndex = nextSearchIndex(treeTextMatchQuery, query, treeTextMatchIndex, matches.length);
		const match = matches[nextIndex];

		treeTextMatchLookup = buildMatchLookup(matches);
		treeTextMatchQuery = query;
		treeTextMatchIndex = nextIndex;

		await focusTreeSearchMatch(match, `Found ${matches.length} text matches (${nextIndex + 1}/${matches.length}).`);
	}

	function handleTreeSearchKey(event: KeyboardEvent, mode: 'author' | 'text') {
		if (event.key !== 'Enter') return;
		event.preventDefault();
		event.stopPropagation();
		if (mode === 'author') {
			void searchTreeAuthor();
			return;
		}
		void searchTreeText();
	}

	async function jumpToExpandedTreeChild(
		card: LaneCard,
		childIndex: number,
		scrollBehavior: ScrollBehavior = 'smooth'
	) {
		const child = getExpandedTreeChildPosts(card)[childIndex];
		if (!child) return;
		await focusExpandedTreePost(card.laneId, child.uri, scrollBehavior);
	}

	async function focusExpandedTreePost(
		laneId: string,
		postUri: string,
		scrollBehavior: ScrollBehavior = 'smooth'
	) {
		if (!boardModel.cardsByKey.has(`${laneId}:${postUri}`)) return;
		await focusCard(`${laneId}:${postUri}`, scrollBehavior);
	}

	async function navigateExpandedTreePrev(card: LaneCard, scrollBehavior: ScrollBehavior = 'smooth') {
		const navigation = getExpandedLaneTreeNavigation(card.laneId);
		if (!navigation) return;
		const currentIndex = navigation.indexByUri.get(card.post.uri) ?? -1;
		if (currentIndex <= 0) return;
		await focusExpandedTreePost(card.laneId, navigation.order[currentIndex - 1].uri, scrollBehavior);
	}

	async function navigateExpandedTreeNext(card: LaneCard, scrollBehavior: ScrollBehavior = 'smooth') {
		const navigation = getExpandedLaneTreeNavigation(card.laneId);
		if (!navigation) return;
		const currentIndex = navigation.indexByUri.get(card.post.uri) ?? -1;
		if (currentIndex < 0 || currentIndex >= navigation.order.length - 1) return;
		await focusExpandedTreePost(card.laneId, navigation.order[currentIndex + 1].uri, scrollBehavior);
	}

	async function navigateExpandedTreeRoot(card: LaneCard, scrollBehavior: ScrollBehavior = 'smooth') {
		const lane = boardModel.laneById.get(card.laneId);
		if (!lane) return;
		await focusExpandedTreePost(card.laneId, lane.thread.rootPost.uri, scrollBehavior);
	}

	async function navigateExpandedTreeFork(card: LaneCard, scrollBehavior: ScrollBehavior = 'smooth') {
		const navigation = getExpandedLaneTreeNavigation(card.laneId);
		const lane = boardModel.laneById.get(card.laneId);
		if (!navigation || !lane) return;

		let currentUri = card.post.uri;
		while (currentUri) {
			const parent = navigation.parentByUri.get(currentUri);
			if (!parent) break;
			if (parent.children.length > 1) {
				await focusExpandedTreePost(card.laneId, parent.uri, scrollBehavior);
				return;
			}
			currentUri = parent.uri;
		}

		await focusExpandedTreePost(card.laneId, lane.thread.rootPost.uri, scrollBehavior);
	}

	function getCardCenter(card: LaneCard) {
		return {
			x: card.x + CARD_WIDTH / 2,
			y: card.y + getRenderedCardHeight(card) / 2
		};
	}

	function cardIsKeyboardNavigable(card: LaneCard): boolean {
		return card.visibility === 'active';
	}

	async function moveActiveCard(
		direction: NavigationDirection,
		scrollBehavior: ScrollBehavior = 'smooth'
	) {
		if (!activeCard) return;

		const currentCenter = getCardCenter(activeCard);
		let nextCard: LaneCard | null = null;
		let nextScore = Number.POSITIVE_INFINITY;

		for (const lane of boardModel.lanes) {
			for (const candidate of lane.cards) {
				if (candidate.key === activeCard.key) continue;
				if (!cardIsKeyboardNavigable(candidate)) continue;

				const candidateCenter = getCardCenter(candidate);
				const dx = candidateCenter.x - currentCenter.x;
				const dy = candidateCenter.y - currentCenter.y;

				let majorDistance = 0;
				let minorDistance = 0;

				if (direction === 'left') {
					if (dx >= -12) continue;
					majorDistance = -dx;
					minorDistance = Math.abs(dy);
				} else if (direction === 'right') {
					if (dx <= 12) continue;
					majorDistance = dx;
					minorDistance = Math.abs(dy);
				} else if (direction === 'up') {
					if (dy >= -12) continue;
					majorDistance = -dy;
					minorDistance = Math.abs(dx);
				} else {
					if (dy <= 12) continue;
					majorDistance = dy;
					minorDistance = Math.abs(dx);
				}

				const score = majorDistance * 1.2 + minorDistance * 0.45;
				if (score < nextScore) {
					nextScore = score;
					nextCard = candidate;
				}
			}
		}

		if (nextCard) {
			await focusCard(nextCard.key, scrollBehavior);
		}
	}

	function getCardScrollElement(cardKey: string): HTMLElement | null {
		return (
			boardEl?.querySelector<HTMLElement>(
				`.dimension-card[data-card-key="${CSS.escape(cardKey)}"] .dimension-card-scroll`
			) ?? null
		);
	}

	function scrollSelectedCardContent(direction: NavigationDirection) {
		if (!activeCard) return;
		const scrollEl = getCardScrollElement(activeCard.key);
		if (!scrollEl) return;

		let left = 0;
		let top = 0;
		if (direction === 'left') left = -CARD_SCROLL_STEP;
		if (direction === 'right') left = CARD_SCROLL_STEP;
		if (direction === 'up') top = -CARD_SCROLL_STEP;
		if (direction === 'down') top = CARD_SCROLL_STEP;

		scrollEl.scrollBy({
			left,
			top,
			behavior: 'auto'
		});
	}

	function toggleShortcutsHelp() {
		showShortcutsHelp = !showShortcutsHelp;
	}

	function closeShortcutsHelp() {
		showShortcutsHelp = false;
	}

	function isEditableTarget(target: EventTarget | null) {
		if (!(target instanceof HTMLElement)) return false;
		if (target.isContentEditable) return true;
		return Boolean(target.closest('input, textarea, select, [contenteditable="true"]'));
	}

	function openPostExternally(post: ThreadPost) {
		if (typeof window === 'undefined') return;
		window.open(postUrl(post.uri, post.author.handle), '_blank', 'noopener,noreferrer');
	}

	async function handleBoardShortcutKeydown(event: KeyboardEvent) {
		if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
		if (isEditableTarget(event.target)) return;

		const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;

		if (key === 'Escape') {
			event.preventDefault();
			if (treeBoardTarget) {
				closeTreeBoard();
				return;
			}
			if (detailModalTarget) {
				closeDetailModal();
				return;
			}
			if (openQuotePickerCardKey) {
				openQuotePickerCardKey = null;
				return;
			}
			if (showShortcutsHelp) {
				closeShortcutsHelp();
			}
			return;
		}

		if (key === 'g' && detailModalTarget) {
			event.preventDefault();
			closeShortcutsHelp();
			closeDetailModal();
			return;
		}

		if (treeBoardTarget || detailModalTarget) return;

		if (key === '?') {
			event.preventDefault();
			toggleShortcutsHelp();
			return;
		}

		if (event.shiftKey && activeCard) {
			if (key === 'h' || key === 'ArrowLeft') {
				event.preventDefault();
				closeShortcutsHelp();
				scrollSelectedCardContent('left');
				return;
			}

			if (key === 'j' || key === 'ArrowDown') {
				event.preventDefault();
				closeShortcutsHelp();
				scrollSelectedCardContent('down');
				return;
			}

			if (key === 'k' || key === 'ArrowUp') {
				event.preventDefault();
				closeShortcutsHelp();
				scrollSelectedCardContent('up');
				return;
			}

			if (key === 'l' || key === 'ArrowRight') {
				event.preventDefault();
				closeShortcutsHelp();
				scrollSelectedCardContent('right');
				return;
			}
		}

		if (key === 'h' || key === 'ArrowLeft') {
			event.preventDefault();
			closeShortcutsHelp();
			await moveActiveCard('left', 'auto');
			return;
		}

		if (key === 'j' || key === 'ArrowDown') {
			event.preventDefault();
			closeShortcutsHelp();
			await moveActiveCard('down', 'auto');
			return;
		}

		if (key === 'k' || key === 'ArrowUp') {
			event.preventDefault();
			closeShortcutsHelp();
			await moveActiveCard('up', 'auto');
			return;
		}

		if (key === 'l' || key === 'ArrowRight') {
			event.preventDefault();
			closeShortcutsHelp();
			await moveActiveCard('right', 'auto');
			return;
		}

		if (key === 't' && activeLane) {
			event.preventDefault();
			closeShortcutsHelp();
			await toggleLaneTree(
				activeLane.id,
				activeCard?.laneId === activeLane.id ? activeCard.post.uri : undefined,
				'auto'
			);
			return;
		}

		if (key === '/' && searchLane) {
			event.preventDefault();
			closeShortcutsHelp();
			await focusTreeSearchInput('text');
			return;
		}

		if (key === 'u' && searchLane) {
			event.preventDefault();
			closeShortcutsHelp();
			await focusTreeSearchInput('author');
			return;
		}

		if (key === 'm') {
			event.preventDefault();
			closeShortcutsHelp();
			isBigMode = !isBigMode;
			return;
		}

		if (key === 'Enter' && activeCard) {
			event.preventDefault();
			closeShortcutsHelp();
			await openTreeBoard(activeCard);
			return;
		}

		if (key === 'g' && activeCard) {
			event.preventDefault();
			closeShortcutsHelp();
			await openDetailModal(activeCard);
			return;
		}

		if (key === 'o' && activeCard) {
			event.preventDefault();
			closeShortcutsHelp();
			openPostExternally(activeCard.post);
			return;
		}

		if (key === 'a' && activeCard && hasLaneBranchSwitch(activeCard)) {
			event.preventDefault();
			closeShortcutsHelp();
			await stepLaneBranch(activeCard, -1, 'auto');
			return;
		}

		if (key === 'q' && activeCard?.post.embed?.record) {
			event.preventDefault();
			closeShortcutsHelp();
			await handleQuoteThreadAction(activeCard);
			return;
		}

		if (key === 'w' && activeCard && hasQuotePicker(activeCard.post)) {
			event.preventDefault();
			closeShortcutsHelp();
			await toggleQuotePicker(activeCard);
			return;
		}

		if (/^[1-9]$/.test(key) && activeCard && openQuotePickerCardKey === activeCard.key) {
			event.preventDefault();
			closeShortcutsHelp();
			const quotePost = getQuoteFeedState(activeCard.post).posts[Number(key) - 1];
			if (quotePost) {
				await handleQuotePostLaneAction(activeCard, quotePost);
			}
			return;
		}

		if (/^[1-9]$/.test(key) && activeCard && laneIsExpanded(activeCard.laneId)) {
			event.preventDefault();
			closeShortcutsHelp();
			await jumpToExpandedTreeChild(activeCard, Number(key) - 1, 'auto');
			return;
		}

		if (key === 'r' && activeCard && laneIsExpanded(activeCard.laneId)) {
			event.preventDefault();
			closeShortcutsHelp();
			await navigateExpandedTreeFork(activeCard, 'auto');
			return;
		}

		if (key === 'Backspace' && activeCard && laneIsExpanded(activeCard.laneId)) {
			event.preventDefault();
			closeShortcutsHelp();
			await navigateExpandedTreeRoot(activeCard, 'auto');
			return;
		}

		if (key === 's' && activeCard && hasLaneBranchSwitch(activeCard)) {
			event.preventDefault();
			closeShortcutsHelp();
			await stepLaneBranch(activeCard, 1, 'auto');
			return;
		}

		if (key === 'x' && activeLane?.kind === 'quoted') {
			event.preventDefault();
			closeShortcutsHelp();
			closeLane(activeLane.id);
			return;
		}

		if (key === 'f') {
			event.preventDefault();
			closeShortcutsHelp();
			void toggleParallelBoardFullscreen();
			return;
		}

		if (key === '+' || key === '=') {
			event.preventDefault();
			closeShortcutsHelp();
			zoomIn();
			return;
		}

		if (key === '-' || key === '_') {
			event.preventDefault();
			closeShortcutsHelp();
			zoomOut();
			return;
		}

		if (key === '0') {
			event.preventDefault();
			closeShortcutsHelp();
			zoomReset();
		}
	}

	function syncZoomInput() {
		zoomInput = String(Math.round(zoom * 100));
	}

	function zoomIn() {
		zoom = Math.min(ZOOM_MAX, zoom + ZOOM_STEP);
	}

	function zoomOut() {
		zoom = Math.max(ZOOM_MIN, zoom - ZOOM_STEP);
	}

	function zoomReset() {
		zoom = 1;
	}

	function getScaledCanvasSize(size: number, scale: number): number {
		return Math.round(size * scale);
	}

	function getGhostLaneDriftX(card: LaneCard): number {
		if (!expandedLaneId || card.laneId === expandedLaneId) return 0;
		const expandedLane = boardModel.laneById.get(expandedLaneId);
		const lane = boardModel.laneById.get(card.laneId);
		if (!expandedLane || !lane) return 0;
		return lane.x < expandedLane.x ? -34 : 34;
	}

	function getCardShiftX(card: LaneCard): number {
		if (cardIsGhosted(card)) {
			const drift = getGhostLaneDriftX(card);
			return drift + (card.visibility === 'shadow' ? -22 - card.stackIndex * 10 : -12);
		}
		if (card.visibility === 'active') return 0;
		return -16 - card.stackIndex * 12;
	}

	function getCardShiftY(card: LaneCard): number {
		if (cardIsGhosted(card)) {
			return card.visibility === 'shadow' ? -18 - card.stackIndex * 8 : -10;
		}
		if (card.visibility === 'active') return 0;
		return -12 - card.stackIndex * 9;
	}

	function getCardScale(card: LaneCard): number {
		if (cardIsGhosted(card)) {
			return card.visibility === 'shadow'
				? Math.max(0.76, 0.84 - card.stackIndex * 0.03)
				: 0.88;
		}
		if (card.visibility === 'active') return 1;
		return Math.max(0.88, 0.96 - card.stackIndex * 0.04);
	}

	function getCardOpacity(card: LaneCard): number {
		if (cardIsGhosted(card)) {
			return card.visibility === 'shadow'
				? Math.max(0.08, 0.18 - card.stackIndex * 0.03)
				: 0.22;
		}
		if (card.visibility === 'active') return 1;
		return Math.max(0.44, 0.84 - card.stackIndex * 0.11);
	}

	function getCardZIndex(card: LaneCard): number {
		if (expandedLaneId === card.laneId) {
			return 440 + card.depth;
		}
		if (cardIsGhosted(card)) {
			return 80 + card.depth - card.stackIndex;
		}
		if (card.visibility === 'active') return 320 + card.depth;
		return 160 + card.depth - card.stackIndex;
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

	function buildLaneRailPath(cards: LaneCard[]): string {
		if (cards.length === 0) return '';
		const x = cards[0].x + CARD_WIDTH / 2;
		const startY = cards[0].y - 22;
		const endY = cards[cards.length - 1].y + getRenderedCardHeight(cards[cards.length - 1]) + 18;
		return `M${x},${startY} L${x},${endY}`;
	}

	function buildConnectorPath(connector: LaneConnector): string {
		const fromHeight = getRenderedCardHeight(connector.from);
		const toHeight = getRenderedCardHeight(connector.to);

		if (connector.kind === 'tree') {
			const startX = connector.from.x + CARD_WIDTH / 2;
			const startY = connector.from.y + fromHeight - 12;
			const endX = connector.to.x + CARD_WIDTH / 2;
			const endY = connector.to.y + 12;
			const middleY = startY + (endY - startY) * 0.5;
			return `M${startX},${startY} C${startX},${middleY} ${endX},${middleY} ${endX},${endY}`;
		}

		if (connector.kind === 'spawn') {
			const flowsLeft = connector.to.x < connector.from.x;
			const startX = flowsLeft ? connector.from.x : connector.from.x + CARD_WIDTH;
			const startY = connector.from.y + fromHeight * 0.56;
			const endX = flowsLeft ? connector.to.x + CARD_WIDTH + 8 : connector.to.x - 8;
			const endY = connector.to.y + toHeight * 0.48;
			const bendX = startX + (endX - startX) * 0.48;
			return `M${startX},${startY} C${bendX},${startY} ${bendX},${endY} ${endX},${endY}`;
		}

		const startX = connector.from.x + CARD_WIDTH * 0.84;
		const startY = connector.from.y + fromHeight * 0.18;
		const endX = connector.to.x + CARD_WIDTH * 0.18;
		const endY = connector.to.y + toHeight * 0.18;
		const direction = endX >= startX ? 1 : -1;
		const controlOffset = Math.max(64, Math.abs(endX - startX) * 0.35);
		const controlX1 = startX + controlOffset * direction;
		const controlX2 = endX - controlOffset * direction;
		return `M${startX},${startY} C${controlX1},${startY} ${controlX2},${endY} ${endX},${endY}`;
	}

	function countPosts(post: ThreadPost): number {
		let count = 1;
		for (const child of post.children) {
			count += countPosts(child);
		}
		return count;
	}

	function collectUniqueLanePosts(lanes: LaneRenderModel[]): ThreadPost[] {
		const posts: ThreadPost[] = [];
		const seen = new Set<string>();

		function visit(post: ThreadPost) {
			if (!seen.has(post.uri)) {
				seen.add(post.uri);
				posts.push(post);
			}
			for (const child of post.children) {
				visit(child);
			}
		}

		for (const lane of lanes) {
			visit(lane.thread.rootPost);
		}

		return posts;
	}

	function getLaneBranchAlternatives(card: LaneCard): string[] {
		if (laneIsExpanded(card.laneId)) return [];
		if (card.visibility !== 'active') return [];
		return card.switchGroupChainIds.filter((chainId) => chainId !== card.chainId);
	}

	function hasLaneBranchSwitch(card: LaneCard): boolean {
		return getLaneBranchAlternatives(card).length > 0;
	}

	function getLaneBranchButtonLabel(card: LaneCard): string {
		const alternatives = getLaneBranchAlternatives(card);
		if (alternatives.length <= 1) return 'Switch';
		return `Switch ${alternatives.length}`;
	}

	function getLaneBranchButtonTitle(card: LaneCard): string {
		const alternatives = getLaneBranchAlternatives(card);
		if (alternatives.length === 0) return 'No alternate reply chain here';
		if (alternatives.length === 1) return 'Bring the stacked reply chain to the foreground';
		return `Cycle through ${alternatives.length} stacked reply chains`;
	}

	function scrollBoardCardIntoView(cardKey: string, behavior: ScrollBehavior = 'smooth') {
		const node =
			boardEl?.querySelector<HTMLElement>(
				`.dimension-card[data-card-key="${CSS.escape(cardKey)}"]`
			) ?? null;
		node?.scrollIntoView({ behavior, block: 'nearest', inline: 'center' });
	}

	function clearCelebrationVisuals() {
		if (typeof window !== 'undefined' && celebrationFrame) {
			cancelAnimationFrame(celebrationFrame);
			celebrationFrame = 0;
		}
		if (typeof window !== 'undefined' && celebrationTimeout) {
			window.clearTimeout(celebrationTimeout);
			celebrationTimeout = 0;
		}
	}

	function triggerCelebration(cardKey: string) {
		if (!targetUri || typeof window === 'undefined') return;

		clearCelebrationVisuals();
		celebrationFrame = requestAnimationFrame(() => {
			celebrationFrame = 0;
			const layoutRect = parallelBoardLayoutEl?.getBoundingClientRect();
			const cardRect =
				boardEl?.querySelector<HTMLElement>(
					`.dimension-card[data-card-key="${CSS.escape(cardKey)}"]`
				)?.getBoundingClientRect() ?? null;
			if (!layoutRect || !cardRect) return;

			celebrationBurst = {
				key: Date.now(),
				x: cardRect.left - layoutRect.left + cardRect.width / 2,
				y: cardRect.top - layoutRect.top + Math.min(cardRect.height * 0.32, 110)
			};

			celebrationTimeout = window.setTimeout(() => {
				celebrationBurst = null;
				celebrationTimeout = 0;
			}, 1350);
		});
	}

	async function completeLaneDiscoveryWin(details: WinningMoveDetails): Promise<boolean> {
		if (!targetUri) return false;

		await tick();
		const targetCard = boardModel.cardsByKey.get(`${details.laneId}:${targetUri}`);
		if (!targetCard) return false;

		await focusCard(targetCard.key, 'auto');
		await tick();
		triggerCelebration(targetCard.key);
		onWinningMove?.({
			...details,
			summaryPosts: buildWinningMoveSummaryPosts(details)
		});
		return true;
	}

	async function setLaneActiveChain(
		laneId: string,
		chainId: string,
		preferredPostUri?: string,
		scrollBehavior: ScrollBehavior = 'smooth'
	) {
		laneActiveChainIds = {
			...laneActiveChainIds,
			[laneId]: chainId
		};
		activeLaneId = laneId;
		await tick();

		const lane = boardModel.laneById.get(laneId);
		if (!lane) return;
		const nextCard =
			lane.activeCards.find((card) => card.post.uri === preferredPostUri) ??
			(preferredPostUri
				? boardModel.cardsByKey.get(`${laneId}:${preferredPostUri}`)
				: null) ??
			lane.activeCards[0] ??
			lane.cards[0];
		if (!nextCard) return;

		activeCardKey = nextCard.key;
		await tick();
		scrollBoardCardIntoView(nextCard.key, scrollBehavior);
	}

	async function stepLaneBranch(
		card: LaneCard,
		step: -1 | 1,
		scrollBehavior: ScrollBehavior = 'smooth'
	) {
		const lane = boardModel.laneById.get(card.laneId);
		if (!lane || card.visibility !== 'active' || card.switchGroupChainIds.length < 2) return;
		const currentIndex = Math.max(card.switchGroupChainIds.indexOf(lane.activeChainId), 0);
		const nextIndex =
			(currentIndex + step + card.switchGroupChainIds.length) % card.switchGroupChainIds.length;
		const nextChainId = card.switchGroupChainIds[nextIndex];
		const targetChain = lane.chains.find((chain) => chain.id === nextChainId);
		await setLaneActiveChain(
			card.laneId,
			nextChainId,
			targetChain?.posts[card.depth]?.uri ?? card.post.uri,
			scrollBehavior
		);
	}

	async function cycleLaneBranch(card: LaneCard) {
		await stepLaneBranch(card, 1);
	}

		function getLaneEntryByUri(uri: string | null | undefined): QuoteLaneEntry | undefined {
			return uri ? quoteLanes[uri] : undefined;
		}

		function getOpenLaneCard(uri: string | null | undefined): LaneCard | undefined {
			return uri ? boardModel.cardsByPostUri.get(uri) : undefined;
		}

		function getLaneActionLabelForUri(uri: string): string {
			const openTarget = getOpenLaneCard(uri);
			const entry = getLaneEntryByUri(uri);
			if (!entry) return openTarget ? 'Jump to lane' : 'Open lane';
			if (entry.status === 'loading') return 'Loading...';
			if (isResolvedQuoteLaneEntry(entry) && getResolvedQuoteTargetCard(entry)) {
				return 'Jump to lane';
			}
			if (openTarget) return 'Jump to lane';
			return 'Retry';
		}

		function getLaneActionTitleForUri(uri: string): string {
			const openTarget = getOpenLaneCard(uri);
			const entry = getLaneEntryByUri(uri);
			if (!entry) {
				return openTarget ? 'Jump to the lane already on the board' : 'Open this thread as a new lane';
			}
			if (entry.status === 'loading') return 'Fetching thread';
			if (isResolvedQuoteLaneEntry(entry) && getResolvedQuoteTargetCard(entry)) {
				return 'Jump to the linked thread lane';
			}
			if (openTarget) return 'Jump to the lane already on the board';
			return 'Retry fetching this thread';
		}

		function getQuoteLaneEntry(post: ThreadPost): QuoteLaneEntry | undefined {
			const quotedUri = post.embed?.record?.uri;
			return getLaneEntryByUri(quotedUri);
		}

		function getOpenQuoteTargetCard(post: ThreadPost): LaneCard | undefined {
			const quotedUri = post.embed?.record?.uri;
			return getOpenLaneCard(quotedUri);
		}

		function getResolvedQuoteTargetCard(entry: ResolvedQuoteLaneEntry): LaneCard | undefined {
			return (
				boardModel.cardsByKey.get(`${entry.targetLaneId}:${entry.targetPostUri}`) ??
				boardModel.cardsByPostUri.get(entry.targetPostUri)
			);
		}

		async function focusQuoteEntry(entry: ResolvedQuoteLaneEntry) {
			const targetCard = getResolvedQuoteTargetCard(entry);
			if (!targetCard) return;
			await focusCard(targetCard.key);
		}

		function getQuoteActionLabel(post: ThreadPost): string {
			const openTarget = getOpenQuoteTargetCard(post);
			const entry = getQuoteLaneEntry(post);
			if (!entry) return openTarget ? 'Link post' : 'Fetch thread';
			if (entry.status === 'loading') return 'Loading...';
			if (isResolvedQuoteLaneEntry(entry) && getResolvedQuoteTargetCard(entry)) {
				return entry.status === 'linked' || (openTarget && entry.targetPostUri !== entry.quotedUri)
					? 'Jump to post'
					: 'Jump';
			}
			if (openTarget) return 'Link post';
			return 'Retry';
		}

		function getQuoteActionTitle(post: ThreadPost): string {
			const openTarget = getOpenQuoteTargetCard(post);
			const entry = getQuoteLaneEntry(post);
			if (!entry) {
				return openTarget
					? 'Link this quote to the post already on the board'
					: 'Open this quoted thread as a new parallel lane';
			}
			if (entry.status === 'loading') return 'Fetching quoted thread';
			if (isResolvedQuoteLaneEntry(entry) && getResolvedQuoteTargetCard(entry)) {
				return entry.status === 'linked' || entry.targetPostUri !== entry.quotedUri
					? 'Jump to the linked post'
					: 'Jump to the linked thread lane';
			}
			if (openTarget) return 'Link this quote to the post already on the board';
			return 'Retry fetching this quoted thread';
		}

		function getQuoteStatusMessage(post: ThreadPost): string {
			const entry = getQuoteLaneEntry(post);
			if (!entry) return '';
			if (entry.status === 'error') {
				return entry.error || 'Could not load this quote.';
			}
			if (isResolvedQuoteLaneEntry(entry) && getResolvedQuoteTargetCard(entry)) {
				const lane = boardModel.laneById.get(entry.targetLaneId);
				if (entry.status === 'linked' || entry.targetPostUri !== entry.quotedUri) {
					return lane ? `Linked to ${lane.label}` : 'Linked to an opened post';
				}
				return lane ? `${lane.label} linked` : 'Linked';
			}
			return '';
		}

		function isQuoteResolved(post: ThreadPost): boolean {
			return isResolvedQuoteLaneEntry(getQuoteLaneEntry(post));
		}

		function getQuoteFeedState(post: ThreadPost): QuotePostFeedState {
			return postQuotes[post.uri] ?? { status: 'idle', posts: [] };
		}

		function getQuoteFeedCountLabel(post: ThreadPost): string {
			const state = getQuoteFeedState(post);
			const loadedCount = state.posts.length;
			if (post.quoteCount > 0) {
				if (loadedCount > 0 && loadedCount < post.quoteCount) {
					return `${formatCount(loadedCount)} of ${formatCount(post.quoteCount)} loaded`;
				}
				return `${formatCount(post.quoteCount)} post${post.quoteCount === 1 ? '' : 's'}`;
			}
			return loadedCount > 0
				? `${formatCount(loadedCount)} loaded`
				: 'No quote posts available';
		}

		function hasQuotePicker(post: ThreadPost): boolean {
			const state = getQuoteFeedState(post);
			return post.quoteCount > 0 || state.status !== 'idle';
		}

		function isQuotePickerOpen(card: LaneCard): boolean {
			return openQuotePickerCardKey === card.key;
		}

		async function toggleQuotePicker(card: LaneCard) {
			if (openQuotePickerCardKey === card.key) {
				openQuotePickerCardKey = null;
				return;
			}
			openQuotePickerCardKey = card.key;
			const state = getQuoteFeedState(card.post);
			if (state.status === 'idle' && card.post.quoteCount > 0) {
				await loadQuotesForPost(card.post);
			}
		}

		async function loadQuotesForPost(
			post: ThreadPost,
			options: { fetchAll?: boolean } = {}
		): Promise<ThreadPost[] | null> {
			const { fetchAll = false } = options;
			const existing = postQuotes[post.uri];
			if (existing?.status === 'loading') return existing.posts ?? null;

			postQuotes = {
				...postQuotes,
				[post.uri]: {
					status: 'loading',
					posts: existing?.posts ?? [],
					hasMore: existing?.hasMore,
					loadedAll: existing?.loadedAll,
					loadingMode: fetchAll ? 'all' : 'page'
				}
			};

			try {
				const fetchQuotePosts = platform.fetchQuotePosts;
				if (!fetchQuotePosts) {
					throw new Error(`Quote lookup is unavailable for ${platform.name}.`);
				}
				const result = await fetchQuotePosts(
					post.uri,
					fetchAll ? { limit: 100, fetchAll: true } : { limit: 12 }
				);
				postQuotes = {
					...postQuotes,
					[post.uri]: {
						status: 'ready',
						posts: result.posts,
						hasMore: result.hasMore,
						loadedAll: fetchAll || !result.hasMore
					}
				};
				return result.posts;
			} catch (error) {
				postQuotes = {
					...postQuotes,
					[post.uri]: {
						status: 'error',
						posts: existing?.posts ?? [],
						hasMore: existing?.hasMore,
						loadedAll: existing?.loadedAll,
						error: error instanceof Error ? error.message : 'Could not load quote posts.'
					}
				};
				return null;
			}
		}

	async function openQuoteLane(options: {
		quotedUri: string;
			quotedHandle: string;
				sourceUri: string;
				sourceLaneId: string;
				direction: QuoteLaneDirection;
				suppressFocus?: boolean;
				loadThread?: (uri: string) => Promise<BoardThread>;
			}) {
			const existing = quoteLanes[options.quotedUri];
			if (existing?.status === 'loading') {
				return;
			}

			if (isResolvedQuoteLaneEntry(existing) && getResolvedQuoteTargetCard(existing)) {
				if (!options.suppressFocus) {
					const won = await completeLaneDiscoveryWin({
						kind: 'existing-lane',
						laneId: existing.targetLaneId,
						targetUri: targetUri ?? existing.targetPostUri,
						sourceUri: existing.sourceUri,
						sourceLaneId: existing.sourceLaneId,
						quotedUri: existing.quotedUri
					});
					if (!won) {
						await focusQuoteEntry(existing);
					}
				}
			return;
		}

			const existingTarget = boardModel.cardsByPostUri.get(options.quotedUri);
			if (existingTarget) {
				const linkedEntry: LinkedQuoteLaneEntry = {
					quotedUri: options.quotedUri,
					quotedHandle: options.quotedHandle,
					sourceUri: options.sourceUri,
					sourceLaneId: options.sourceLaneId,
					loadedAt: existing?.loadedAt ?? Date.now(),
					direction: options.direction,
					status: 'linked',
					targetLaneId: existingTarget.laneId,
					targetPostUri: existingTarget.post.uri
				};
				quoteLanes = {
					...quoteLanes,
					[options.quotedUri]: linkedEntry
				};
				if (!options.suppressFocus) {
					const won = await completeLaneDiscoveryWin({
						kind: 'linked-lane',
						laneId: linkedEntry.targetLaneId,
						targetUri: targetUri ?? linkedEntry.targetPostUri,
						sourceUri: linkedEntry.sourceUri,
						sourceLaneId: linkedEntry.sourceLaneId,
						quotedUri: linkedEntry.quotedUri
					});
					if (!won) {
						await focusQuoteEntry(linkedEntry);
					}
				}
			return;
		}

			const baseEntry: LoadingQuoteLaneEntry = {
				quotedUri: options.quotedUri,
				quotedHandle: options.quotedHandle,
				sourceUri: options.sourceUri,
				sourceLaneId: options.sourceLaneId,
				loadedAt: existing?.loadedAt ?? Date.now(),
				direction: options.direction,
				status: 'loading'
			};

			quoteLanes = {
				...quoteLanes,
				[options.quotedUri]: baseEntry
			};

		try {
				const loadThread = options.loadThread ?? platform.loadThread;
			if (!loadThread) {
				throw new Error(`Quoted thread loading is unavailable for ${platform.name}.`);
			}
			const quotedThread = await loadThread(options.quotedUri);
			const didReachTargetThread = Boolean(
				targetUri && findFirstMatchingPost(quotedThread.rootPost, (post) => post.uri === targetUri)
			);
			const preferredChainId = getLaneAnchorActiveChainId(
				collectLaneChains(quotedThread.rootPost),
				options.quotedUri
				);
				if (preferredChainId) {
					laneActiveChainIds = {
						...laneActiveChainIds,
						[options.quotedUri]: preferredChainId
					};
				}
				quoteLanes = {
					...quoteLanes,
					[options.quotedUri]: {
						...baseEntry,
						status: 'ready',
						thread: quotedThread,
						targetLaneId: options.quotedUri,
						targetPostUri: options.quotedUri
					}
				};
				if (!options.suppressFocus) {
					if (didReachTargetThread) {
						const won = await completeLaneDiscoveryWin({
							kind: 'fetched-lane',
							laneId: options.quotedUri,
							targetUri: targetUri ?? options.quotedUri,
							sourceUri: options.sourceUri,
							sourceLaneId: options.sourceLaneId,
							quotedUri: options.quotedUri
						});
						if (won) {
							return;
						}
					}
				await tick();
				await focusCard(`${options.quotedUri}:${options.quotedUri}`);
			}
		} catch (error) {
				quoteLanes = {
					...quoteLanes,
					[options.quotedUri]: {
						...baseEntry,
						status: 'error',
						error: error instanceof Error ? error.message : 'Could not load this quoted thread.'
					}
				};
			}
		}

	async function focusCard(cardKey: string, scrollBehavior: ScrollBehavior = 'smooth') {
		let card = boardModel.cardsByKey.get(cardKey);
		if (!card) return;
		openQuotePickerCardKey = null;
		if (card.visibility === 'shadow') {
			await setLaneActiveChain(card.laneId, card.chainId, card.post.uri, scrollBehavior);
			card = boardModel.cardsByKey.get(cardKey) ?? card;
		}
		activeCardKey = card.key;
		activeLaneId = card.laneId;
		await tick();
		scrollBoardCardIntoView(cardKey, scrollBehavior);
	}

	async function focusLane(laneId: string, scrollBehavior: ScrollBehavior = 'smooth') {
		const lane = boardModel.laneById.get(laneId);
		if (!lane?.cards.length) return;
		const anchorCard =
			lane.cards.find((card) => card.post.uri === lane.anchorUri) ??
			lane.activeCards[0] ??
			lane.cards[0];
		await focusCard(anchorCard.key, scrollBehavior);
	}

	function selectCard(card: LaneCard) {
		void focusCard(card.key);
	}

	async function openDetailModal(card: LaneCard) {
		await focusCard(card.key);
		detailModalTarget = {
			laneId: card.laneId,
			postUri: card.post.uri
		};
	}

	function closeDetailModal() {
		detailModalTarget = null;
	}

	async function openTreeBoardFromDetailModal(card: LaneCard) {
		closeDetailModal();
		await openTreeBoard(card);
	}

	async function openTreeBoard(card: LaneCard) {
		await focusCard(card.key);
		treeBoardTarget = {
			laneId: card.laneId,
			postUri: card.post.uri
		};
	}

	function closeTreeBoard() {
		if (typeof document !== 'undefined' && document.fullscreenElement === treeBoardDialogEl) {
			void document.exitFullscreen().catch(() => {});
		}
		treeBoardTarget = null;
	}

	async function toggleParallelBoardFullscreen() {
		if (!parallelBoardLayoutEl || typeof document === 'undefined') return;
		try {
			if (document.fullscreenElement === parallelBoardLayoutEl) {
				await document.exitFullscreen();
			} else {
				await parallelBoardLayoutEl.requestFullscreen();
			}
		} catch {
			// Ignore fullscreen API failures so the board keeps working normally.
		}
	}

	async function toggleTreeBoardFullscreen() {
		if (!treeBoardDialogEl || typeof document === 'undefined') return;
		try {
			if (document.fullscreenElement === treeBoardDialogEl) {
				await document.exitFullscreen();
			} else {
				await treeBoardDialogEl.requestFullscreen();
			}
		} catch {
			// Ignore fullscreen API failures so the modal keeps working normally.
		}
	}

		async function handleQuoteThreadAction(card: LaneCard) {
			const record = card.post.embed?.record;
			if (!record?.uri) return;

			await openQuoteLane({
				quotedUri: record.uri,
				quotedHandle: record.author.handle || '',
				sourceUri: card.post.uri,
				sourceLaneId: card.laneId,
				direction: 'outbound'
			});
		}

			async function loadAllQuotePostLanes(sourceCard: LaneCard) {
				if (bulkQuoteLaneLoads[sourceCard.post.uri]) return;

				bulkQuoteLaneLoads = {
				...bulkQuoteLaneLoads,
				[sourceCard.post.uri]: true
			};

			try {
				const quoteState = getQuoteFeedState(sourceCard.post);
				const quotePosts =
					quoteState.loadedAll && quoteState.posts.length > 0
						? quoteState.posts
						: await loadQuotesForPost(sourceCard.post, { fetchAll: true });

				if (!quotePosts?.length) {
					return;
				}

				for (const quotePost of quotePosts) {
					await openQuoteLane({
						quotedUri: quotePost.uri,
						quotedHandle: quotePost.author.handle || '',
						sourceUri: sourceCard.post.uri,
						sourceLaneId: sourceCard.laneId,
						direction: 'inbound',
						suppressFocus: true
					});
				}
			} finally {
				bulkQuoteLaneLoads = {
					...bulkQuoteLaneLoads,
					[sourceCard.post.uri]: false
					};
				}
			}

			function yieldToBrowser(): Promise<void> {
				if (typeof window === 'undefined') return Promise.resolve();
				return new Promise((resolve) => {
					window.requestAnimationFrame(() => resolve());
				});
		}

		function isFetchModeRunActive(runId: number): boolean {
			return fetchModeRunning && fetchModeRunId === runId;
		}

			function advanceFetchModeRunId(): number {
				const runId = nextFetchModeRunId;
				nextFetchModeRunId += 1;
				fetchModeRunId = runId;
				return runId;
			}

			function initializeFetchModeTracking() {
				fetchModeQueuedTaskIds = new Set<string>();
				fetchModeQueuedScanUris = new Set<string>();
				fetchModeQueuedLaneTargets = new Set<string>(
					Object.entries(quoteLanes)
						.filter(([, entry]) => entry.status !== 'error')
						.map(([quotedUri]) => quotedUri)
				);
				fetchModeReachedTaskLimit = false;
			}

			function ensureFetchModeWorker(): Worker | null {
				if (typeof Worker === 'undefined') return null;
				if (fetchModeWorker) return fetchModeWorker;
				const worker = new Worker(new URL('../workers/parallelBoardFetchMode.worker.ts', import.meta.url), {
					type: 'module'
				});
				worker.onmessage = handleFetchModeWorkerMessage;
				worker.onerror = () => {
					fetchModeStatusMessage = 'Fetch mode worker failed.';
					fetchModeRunning = false;
					fetchModePaused = false;
				};
				fetchModeWorker = worker;
				return worker;
			}

			function teardownFetchModeWorker() {
				fetchModeWorker?.terminate();
				fetchModeWorker = null;
				for (const request of fetchModeHydrationRequests.values()) {
					request.reject(new Error('Fetch mode worker stopped.'));
				}
				fetchModeHydrationRequests.clear();
			}

			function postFetchModeWorkerMessage(message: Record<string, unknown>) {
				fetchModeWorker?.postMessage(message);
			}

			function canHydrateThreadsInFetchModeWorker(): boolean {
				return platform.name === defaultBoardPlatform.name && platform.loadThread === getBlueskyFullThread;
			}

			function hydrateThreadInFetchModeWorker(uri: string): Promise<BoardThread> {
				const worker = ensureFetchModeWorker();
				if (!worker) {
					return Promise.reject(new Error('Fetch mode worker is unavailable.'));
				}
				const requestId = nextFetchModeHydrationRequestId;
				nextFetchModeHydrationRequestId += 1;
				return new Promise((resolve, reject) => {
					fetchModeHydrationRequests.set(requestId, { resolve, reject });
					worker.postMessage({ type: 'hydrate-thread', requestId, uri });
				});
			}

			async function loadThreadForFetchMode(uri: string): Promise<BoardThread> {
				if (canHydrateThreadsInFetchModeWorker()) {
					try {
						return await hydrateThreadInFetchModeWorker(uri);
					} catch {
						// Fall through to the platform loader if the worker cannot hydrate this thread.
					}
				}

				const loadThread = platform.loadThread;
				if (!loadThread) {
					throw new Error(`Quoted thread loading is unavailable for ${platform.name}.`);
				}
				return loadThread(uri);
			}

			function handleFetchModeWorkerMessage(event: MessageEvent) {
				const message = event.data as {
					type?: string;
					runId?: number;
					taskId?: string;
					requestId?: number;
					thread?: BoardThread;
					error?: string;
				};
				if (message.type === 'thread-hydrated' && message.requestId && message.thread) {
					fetchModeHydrationRequests.get(message.requestId)?.resolve(message.thread);
					fetchModeHydrationRequests.delete(message.requestId);
					return;
				}
				if (message.type === 'thread-error' && message.requestId) {
					fetchModeHydrationRequests
						.get(message.requestId)
						?.reject(new Error(message.error || 'Could not hydrate thread.'));
					fetchModeHydrationRequests.delete(message.requestId);
					return;
				}
				if (message.runId !== fetchModeRunId) return;

				if (message.type === 'run-task' && message.taskId) {
					void processFetchModeTask(message.taskId, message.runId);
					return;
				}

				if (message.type === 'idle') {
					fetchModeRunning = false;
					fetchModePaused = false;
					fetchModeStatusMessage = fetchModeReachedTaskLimit
						? `Fetch mode stopped at ${FETCH_MODE_MAX_TASKS} queue items.`
						: fetchModeQueue.some((item) => item.status === 'error')
							? 'Fetch mode finished with errors.'
							: 'Fetch mode complete.';
					return;
				}

				if (message.type === 'paused') {
					fetchModeStatusMessage = 'Fetch mode paused.';
					return;
				}

				if (message.type === 'resumed') {
					fetchModeStatusMessage = 'Fetch mode resumed.';
				}
			}

			function updateFetchModeQueueItem(id: string, patch: Partial<FetchModeQueueItem>) {
				fetchModeQueue = fetchModeQueue.map((item) => (item.id === id ? { ...item, ...patch } : item));
			}

			function stopFetchMode() {
				if (!fetchModeRunning) return;
				const runId = fetchModeRunId;
				postFetchModeWorkerMessage({ type: 'stop', runId });
				advanceFetchModeRunId();
				teardownFetchModeWorker();
				fetchModeRunning = false;
				fetchModePaused = false;
				fetchModeStatusMessage = 'Fetch mode stopped.';
			fetchModeQueue = fetchModeQueue.map((item) =>
				item.status === 'pending' || item.status === 'running'
					? { ...item, status: 'skipped', detail: 'Stopped before this item ran.' }
					: item
			);
		}

		function resetFetchModeState() {
			postFetchModeWorkerMessage({ type: 'stop', runId: fetchModeRunId });
			advanceFetchModeRunId();
			fetchModeRunning = false;
			fetchModePaused = false;
			showFetchModePanel = true;
			fetchModeQueue = [];
			fetchModeStatusMessage = '';
			fetchModeProcessedCount = 0;
			initializeFetchModeTracking();
		}

		function pauseFetchMode() {
			if (!fetchModeRunning || fetchModePaused) return;
			fetchModePaused = true;
			fetchModeStatusMessage = 'Fetch mode paused.';
			postFetchModeWorkerMessage({ type: 'pause', runId: fetchModeRunId });
		}

		function resumeFetchMode() {
			if (!fetchModeRunning || !fetchModePaused) return;
			fetchModePaused = false;
			fetchModeStatusMessage = 'Fetch mode resumed.';
			postFetchModeWorkerMessage({ type: 'resume', runId: fetchModeRunId });
		}

		function closeFetchModePanel() {
			showFetchModePanel = false;
		}

		function reopenFetchModePanel() {
			showFetchModePanel = true;
		}

		function getFetchModeTaskStatusLabel(status: FetchModeTaskStatus): string {
			if (status === 'running') return 'Now';
			if (status === 'done') return 'Done';
			if (status === 'skipped') return 'Skip';
			if (status === 'error') return 'Error';
			return 'Next';
		}

		function enqueueFetchModeWorkerTasks(taskIds: string[], placement: 'front' | 'back' = 'back') {
			if (!taskIds.length) return;
			postFetchModeWorkerMessage({ type: 'enqueue', runId: fetchModeRunId, taskIds, placement });
		}

		function enqueueFetchModeTask(
			task: FetchModeQueueItem,
			notifyWorker = true,
			placement: 'front' | 'back' = 'back'
		): boolean {
			if (fetchModeQueuedTaskIds.has(task.id)) return false;
			if (fetchModeQueuedTaskIds.size >= FETCH_MODE_MAX_TASKS) {
				if (!fetchModeReachedTaskLimit) {
					fetchModeReachedTaskLimit = true;
					fetchModeStatusMessage = `Fetch mode paused at ${FETCH_MODE_MAX_TASKS} queue items.`;
				}
				return false;
			}
			fetchModeQueuedTaskIds.add(task.id);
			fetchModeQueue = [...fetchModeQueue, task];
			if (notifyWorker) {
				enqueueFetchModeWorkerTasks([task.id], placement);
			}
			return true;
		}

		function enqueueScanCard(
			card: LaneCard,
			reason: string,
			notifyWorker = true,
			placement: 'front' | 'back' = 'back'
		): boolean {
			if (fetchModeQueuedScanUris.has(card.post.uri)) return false;
			fetchModeQueuedScanUris.add(card.post.uri);
			return enqueueFetchModeTask(
				{
					id: `scan:${card.post.uri}`,
					kind: 'scan-post',
					status: 'pending',
					sourceUri: card.post.uri,
					sourceLaneId: card.laneId,
					label: `Scan @${card.post.author.handle}`,
					detail: `${reason}: ${previewText(card.post.text)}`
				},
				notifyWorker,
				placement
			);
		}

		function enqueueLaneTask(
			options: {
				sourceCard: LaneCard;
				quotedUri: string;
				quotedHandle: string;
				direction: QuoteLaneDirection;
				label: string;
				detail: string;
			},
			notifyWorker = true,
			placement: 'front' | 'back' = 'front'
		): boolean {
			if (!options.quotedUri || options.quotedUri === options.sourceCard.post.uri) return false;
			if (fetchModeQueuedLaneTargets.has(options.quotedUri)) return false;
			fetchModeQueuedLaneTargets.add(options.quotedUri);
			return enqueueFetchModeTask(
				{
					id: `open:${options.quotedUri}`,
					kind: 'open-lane',
					status: 'pending',
					sourceUri: options.sourceCard.post.uri,
					sourceLaneId: options.sourceCard.laneId,
					targetUri: options.quotedUri,
					targetHandle: options.quotedHandle,
					direction: options.direction,
					label: options.label,
					detail: options.detail
				},
				notifyWorker,
				placement
			);
		}

		function getFetchModeStartCards(): LaneCard[] {
			const seenUris = new Set<string>();
			const cards: LaneCard[] = [];
			for (const lane of boardModel.lanes) {
				for (const card of lane.cards) {
					if (seenUris.has(card.post.uri)) continue;
					seenUris.add(card.post.uri);
					cards.push(card);
				}
			}

			if (!activeCard) return cards;
			return cards.sort((a, b) => {
				if (a.key === activeCard.key) return -1;
				if (b.key === activeCard.key) return 1;
				return 0;
			});
		}

		function startFetchModeForBoard() {
			const startCards = getFetchModeStartCards();
			if (startCards.length === 0) {
				showFetchModePanel = true;
				fetchModeStatusMessage = 'No board posts available.';
				return;
			}
			if (fetchModeRunning) {
				stopFetchMode();
				return;
			}

			const worker = ensureFetchModeWorker();
			if (!worker) {
				showFetchModePanel = true;
				fetchModeStatusMessage = 'Fetch mode worker is unavailable in this browser.';
				return;
			}

			const runId = advanceFetchModeRunId();
			fetchModeRunning = true;
			fetchModePaused = false;
			showFetchModePanel = true;
			fetchModeQueue = [];
			fetchModeProcessedCount = 0;
			initializeFetchModeTracking();
			fetchModeStatusMessage = `Fetch mode started across ${startCards.length} board post${startCards.length === 1 ? '' : 's'}.`;

			for (const card of startCards) {
				enqueueScanCard(card, card.key === activeCard?.key ? 'Selected post' : 'Board post', false);
			}
			worker.postMessage({
				type: 'start',
				runId,
				delayMs: FETCH_MODE_DELAY_MS,
				taskIds: fetchModeQueue.map((item) => item.id)
			});
		}

		async function processFetchModeTask(taskId: string, runId: number) {
			const task = fetchModeQueue.find((item) => item.id === taskId);
			if (!task) {
				postFetchModeWorkerMessage({ type: 'complete', runId, taskId });
				return;
			}

			updateFetchModeQueueItem(task.id, { status: 'running' });
			fetchModeStatusMessage = task.label;

			try {
				if (task.kind === 'scan-post') {
					const sourceCard =
						boardModel.cardsByKey.get(`${task.sourceLaneId}:${task.sourceUri}`) ??
						boardModel.cardsByPostUri.get(task.sourceUri);
					if (!sourceCard) {
						updateFetchModeQueueItem(task.id, {
							status: 'skipped',
							detail: 'This post is no longer visible on the board.'
						});
					} else {
						let queuedCount = 0;
						const record = sourceCard.post.embed?.record;
						if (record?.uri) {
							queuedCount += enqueueLaneTask({
									sourceCard,
									quotedUri: record.uri,
									quotedHandle: record.author.handle || '',
									direction: 'outbound',
									label: `Open quoted @${record.author.handle || 'unknown'}`,
									detail: previewText(record.text)
								})
									? 1
									: 0;
						}

						const quoteState = getQuoteFeedState(sourceCard.post);
						if (sourceCard.post.quoteCount > 0 || quoteState.posts.length > 0) {
							const quotePosts =
								quoteState.loadedAll && quoteState.posts.length > 0
									? quoteState.posts
									: await loadQuotesForPost(sourceCard.post, { fetchAll: true });
							if (!isFetchModeRunActive(runId)) return;
							if (!quotePosts && sourceCard.post.quoteCount > 0) {
								throw new Error(getQuoteFeedState(sourceCard.post).error || 'Could not load quote posts.');
							}
							for (const quotePost of quotePosts ?? []) {
								queuedCount += enqueueLaneTask({
										sourceCard,
										quotedUri: quotePost.uri,
										quotedHandle: quotePost.author.handle || '',
										direction: 'inbound',
										label: `Open quote post @${quotePost.author.handle || 'unknown'}`,
										detail: previewText(quotePost.text)
									})
										? 1
										: 0;
							}
						}

						updateFetchModeQueueItem(task.id, {
							status: 'done',
							detail:
								queuedCount > 0
									? `${queuedCount} quote lane${queuedCount === 1 ? '' : 's'} queued.`
									: 'No new quote lanes found.'
						});
					}
				} else if (task.targetUri) {
					await openQuoteLane({
						quotedUri: task.targetUri,
						quotedHandle: task.targetHandle ?? '',
						sourceUri: task.sourceUri,
						sourceLaneId: task.sourceLaneId,
						direction: task.direction ?? 'outbound',
						suppressFocus: true,
						loadThread: loadThreadForFetchMode
					});
					if (!isFetchModeRunActive(runId)) return;
					await tick();
					const entry = quoteLanes[task.targetUri];
					if (entry?.status === 'error') {
						throw new Error(entry.error || 'Could not load this quote.');
					}
					const resolvedTargetCard = isResolvedQuoteLaneEntry(entry)
						? getResolvedQuoteTargetCard(entry)
						: undefined;
					const targetCard = resolvedTargetCard ?? boardModel.cardsByPostUri.get(task.targetUri);
					if (targetCard) {
						enqueueScanCard(targetCard, 'Opened lane', true, 'front');
					}
					updateFetchModeQueueItem(task.id, {
						status: 'done',
						detail: targetCard ? 'Lane opened and queued for scan.' : 'Lane request finished.'
					});
				}
			} catch (error) {
				if (isFetchModeRunActive(runId)) {
					updateFetchModeQueueItem(task.id, {
						status: 'error',
						error: error instanceof Error ? error.message : 'Fetch mode task failed.'
					});
				}
			} finally {
				if (isFetchModeRunActive(runId)) {
					fetchModeProcessedCount += 1;
					await tick();
					await yieldToBrowser();
					postFetchModeWorkerMessage({ type: 'complete', runId, taskId });
				}
			}
		}

		async function handleQuotePostLaneAction(sourceCard: LaneCard, quotePost: ThreadPost) {
			openQuotePickerCardKey = null;
			await openQuoteLane({
				quotedUri: quotePost.uri,
				quotedHandle: quotePost.author.handle || '',
				sourceUri: sourceCard.post.uri,
				sourceLaneId: sourceCard.laneId,
				direction: 'inbound'
			});
		}

		function collectQuoteLaneFamily(rootQuotedUri: string): Set<string> {
			const family = new Set<string>([rootQuotedUri]);
			let foundDescendant = true;
			while (foundDescendant) {
				foundDescendant = false;
				for (const entry of Object.values(quoteLanes)) {
					if (
						isReadyQuoteLaneEntry(entry) &&
						entry.sourceLaneId &&
						family.has(entry.sourceLaneId) &&
						!family.has(entry.quotedUri)
					) {
					family.add(entry.quotedUri);
					foundDescendant = true;
				}
			}
		}
		return family;
	}

		function closeLane(quotedUri: string) {
			const family = collectQuoteLaneFamily(quotedUri);
			const nextQuoteLanes = { ...quoteLanes };
			const nextLaneActiveChainIds = { ...laneActiveChainIds };
			for (const [quoteUri, entry] of Object.entries(quoteLanes)) {
				if (
					family.has(quoteUri) ||
					family.has(entry.sourceLaneId) ||
					(isResolvedQuoteLaneEntry(entry) && family.has(entry.targetLaneId))
				) {
					delete nextQuoteLanes[quoteUri];
					delete nextLaneActiveChainIds[quoteUri];
				}
			}
			quoteLanes = nextQuoteLanes;
			laneActiveChainIds = nextLaneActiveChainIds;
			if (detailModalTarget && family.has(detailModalTarget.laneId)) {
				detailModalTarget = null;
			}
			if (treeBoardTarget && family.has(treeBoardTarget.laneId)) {
			treeBoardTarget = null;
		}
		if (family.has(activeLaneId)) {
			activeLaneId = MAIN_LANE_ID;
			activeCardKey = `${MAIN_LANE_ID}:${thread.rootPost.uri}`;
		}
	}

	async function jumpToLaneSource(quotedUri: string) {
		const entry = quoteLanes[quotedUri];
		if (!entry) return;
		await focusCard(`${entry.sourceLaneId}:${entry.sourceUri}`);
	}

	function handleBoardPointerDown(event: PointerEvent) {
		const target = event.target as HTMLElement;
		if (event.button !== 0 || target.closest('.dimension-card, button, a, input, textarea, label, .detail-panel')) {
			return;
		}
		event.preventDefault();
		isPanning = true;
		panStart = {
			x: event.clientX,
			y: event.clientY,
			scrollLeft: boardEl?.scrollLeft ?? 0,
			scrollTop: boardEl?.scrollTop ?? 0
		};
		boardEl?.setPointerCapture(event.pointerId);
	}

	function handleBoardPointerMove(event: PointerEvent) {
		if (!isPanning || !boardEl) return;
		boardEl.scrollLeft = panStart.scrollLeft - (event.clientX - panStart.x);
		boardEl.scrollTop = panStart.scrollTop - (event.clientY - panStart.y);
	}

		function handleBoardPointerUp(event: PointerEvent) {
			if (!isPanning) return;
			isPanning = false;
			boardEl?.releasePointerCapture(event.pointerId);
		}

		function scheduleMinimapRefresh() {
			if (typeof window === 'undefined') return;
			if (minimapFrame) {
				cancelAnimationFrame(minimapFrame);
			}
			minimapFrame = requestAnimationFrame(async () => {
				minimapFrame = 0;
				await tick();
				updateMinimap();
			});
		}

		function updateMinimap() {
			if (typeof window === 'undefined' || !boardEl || !minimapCanvas) return;
			const board = boardEl;

			const scrollWidth = Math.max(board.scrollWidth, 1);
			const scrollHeight = Math.max(board.scrollHeight, 1);
			const clientWidth = board.clientWidth;
			const clientHeight = board.clientHeight;

			const maxWidth = 280;
			const maxHeight = 210;
			minimapScale = Math.min(maxWidth / scrollWidth, maxHeight / scrollHeight, 0.18);
			if (!Number.isFinite(minimapScale) || minimapScale <= 0) {
				minimapScale = 0.05;
			}
			minimapW = Math.max(Math.round(scrollWidth * minimapScale), 132);
			minimapH = Math.max(Math.round(scrollHeight * minimapScale), 92);
			minimapViewport = {
				x: board.scrollLeft * minimapScale,
				y: board.scrollTop * minimapScale,
				w: clientWidth * minimapScale,
				h: clientHeight * minimapScale
			};

			const dpr = window.devicePixelRatio || 1;
			minimapCanvas.width = Math.round(minimapW * dpr);
			minimapCanvas.height = Math.round(minimapH * dpr);
			minimapCanvas.style.width = `${minimapW}px`;
			minimapCanvas.style.height = `${minimapH}px`;

			const ctx = minimapCanvas.getContext('2d');
			if (!ctx) return;
			ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
			ctx.clearRect(0, 0, minimapW, minimapH);

			const boardRect = board.getBoundingClientRect();
			const cardRects = new Map<
				string,
				{ x: number; y: number; w: number; h: number; card: LaneCard }
			>();
			const cardNodes = board.querySelectorAll<HTMLElement>('.dimension-card[data-card-key]');
			cardNodes.forEach((node) => {
				const cardKey = node.dataset.cardKey;
				if (!cardKey) return;
				const card = boardModel.cardsByKey.get(cardKey);
				if (!card) return;
				const rect = node.getBoundingClientRect();
				cardRects.set(cardKey, {
					x: (rect.left - boardRect.left + board.scrollLeft) * minimapScale,
					y: (rect.top - boardRect.top + board.scrollTop) * minimapScale,
					w: rect.width * minimapScale,
					h: rect.height * minimapScale,
					card
				});
			});

			ctx.lineCap = 'round';
			ctx.lineJoin = 'round';

			for (const lane of boardModel.lanes) {
				if (laneIsExpanded(lane.id)) continue;
				const firstCard = lane.activeCards[0];
				const lastCard = lane.activeCards[lane.activeCards.length - 1];
				if (!firstCard || !lastCard) continue;
				const firstRect = cardRects.get(firstCard.key);
				const lastRect = cardRects.get(lastCard.key);
				if (!firstRect || !lastRect) continue;
				ctx.strokeStyle =
					lane.kind === 'main' ? 'rgba(124, 85, 158, 0.74)' : 'rgba(149, 108, 182, 0.6)';
				ctx.lineWidth = Math.max(3, firstRect.w * 0.14);
				ctx.beginPath();
				ctx.moveTo(firstRect.x + firstRect.w / 2, Math.max(2, firstRect.y - firstRect.h * 0.08));
				ctx.lineTo(lastRect.x + lastRect.w / 2, lastRect.y + lastRect.h + firstRect.h * 0.08);
				ctx.stroke();
			}

			ctx.globalAlpha = 0.82;
			for (const connector of boardModel.connectors) {
				const fromRect = cardRects.get(connector.from.key);
				const toRect = cardRects.get(connector.to.key);
				if (!fromRect || !toRect) continue;
				ctx.beginPath();
				ctx.strokeStyle =
					connector.kind === 'spawn'
						? 'rgba(61, 49, 76, 0.72)'
						: connector.kind === 'tree'
							? 'rgba(123, 93, 177, 0.72)'
							: 'rgba(198, 214, 255, 0.78)';
				ctx.lineWidth = connector.kind === 'spawn' ? 1.8 : connector.kind === 'tree' ? 1.6 : 1.2;
				ctx.globalAlpha = connectorIsMuted(connector) ? 0.24 : connector.kind === 'tree' ? 0.68 : 0.82;
				if (connector.kind === 'spawn') {
					const flowsLeft = toRect.x < fromRect.x;
					const startX = flowsLeft ? fromRect.x : fromRect.x + fromRect.w;
					const startY = fromRect.y + fromRect.h * 0.56;
					const endX = flowsLeft ? toRect.x + toRect.w : toRect.x;
					const endY = toRect.y + toRect.h * 0.48;
					const bendX = startX + (endX - startX) * 0.48;
					ctx.moveTo(startX, startY);
					ctx.bezierCurveTo(bendX, startY, bendX, endY, endX, endY);
				} else if (connector.kind === 'tree') {
					const startX = fromRect.x + fromRect.w / 2;
					const startY = fromRect.y + fromRect.h;
					const endX = toRect.x + toRect.w / 2;
					const endY = toRect.y;
					const middleY = startY + (endY - startY) * 0.5;
					ctx.moveTo(startX, startY);
					ctx.bezierCurveTo(startX, middleY, endX, middleY, endX, endY);
				} else {
					const startX = fromRect.x + fromRect.w * 0.84;
					const startY = fromRect.y + fromRect.h * 0.18;
					const endX = toRect.x + toRect.w * 0.18;
					const endY = toRect.y + toRect.h * 0.18;
					const direction = endX >= startX ? 1 : -1;
					const controlOffset = Math.max(10, Math.abs(endX - startX) * 0.35);
					const controlX1 = startX + controlOffset * direction;
					const controlX2 = endX - controlOffset * direction;
					ctx.moveTo(startX, startY);
					ctx.bezierCurveTo(controlX1, startY, controlX2, endY, endX, endY);
				}
				ctx.stroke();
			}
			ctx.globalAlpha = 1;

				for (const lane of boardModel.lanes) {
				for (const card of lane.cards) {
					const rect = cardRects.get(card.key);
					if (!rect) continue;
					const isActive = card.key === activeCardKey;
					if (isActive) {
						ctx.fillStyle = '#6f61ff';
						ctx.strokeStyle = '#3223c6';
					} else if (cardIsGhosted(card)) {
						ctx.fillStyle = 'rgba(222, 214, 234, 0.54)';
						ctx.strokeStyle = 'rgba(111, 97, 139, 0.34)';
					} else if (card.visibility === 'shadow') {
						ctx.fillStyle = 'rgba(218, 207, 236, 0.88)';
						ctx.strokeStyle = 'rgba(128, 112, 162, 0.68)';
					} else if (card.isLaneRoot && card.laneKind === 'quoted') {
						ctx.fillStyle = '#e9d38e';
						ctx.strokeStyle = '#9a7a2f';
					} else {
						ctx.fillStyle = '#f7eedb';
						ctx.strokeStyle =
							card.laneKind === 'main' ? 'rgba(60, 49, 78, 0.72)' : 'rgba(130, 96, 169, 0.72)';
					}
					ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
					ctx.lineWidth = isActive ? 1.8 : 0.85;
					ctx.strokeRect(rect.x, rect.y, rect.w, rect.h);
				}
			}
		}

		function minimapClickAt(clientX: number, clientY: number) {
			if (!boardEl || !minimapEl || minimapScale <= 0) return;
			const rect = minimapEl.getBoundingClientRect();
			const mx = clamp(clientX - rect.left, 0, minimapW);
			const my = clamp(clientY - rect.top, 0, minimapH);
			const nextLeft = clamp(
				(mx - minimapViewport.w / 2) / minimapScale,
				0,
				Math.max(0, boardEl.scrollWidth - boardEl.clientWidth)
			);
			const nextTop = clamp(
				(my - minimapViewport.h / 2) / minimapScale,
				0,
				Math.max(0, boardEl.scrollHeight - boardEl.clientHeight)
			);
			boardEl.scrollTo({
				left: nextLeft,
				top: nextTop,
				behavior: minimapDragging ? 'auto' : 'smooth'
			});
		}

		function handleMinimapClick(event: MouseEvent) {
			minimapClickAt(event.clientX, event.clientY);
		}

		function handleMinimapDragStart(event: MouseEvent) {
			event.preventDefault();
			minimapDragging = true;
			minimapClickAt(event.clientX, event.clientY);
		}

		function handleMinimapDrag(event: MouseEvent) {
			if (!minimapDragging) return;
			minimapClickAt(event.clientX, event.clientY);
		}

		function handleBoardScroll() {
			scheduleMinimapRefresh();
		}

		$effect(() => {
			const rootUri = thread?.rootPost?.uri;
			if (!rootUri) return;
			const initialQuoteLanes = buildSeedQuoteLaneMap(seedQuoteLanes);
			const initialMainAnchorUri = resolveLaneAnchorUri(thread, mainLaneAnchorUri ?? rootUri);
			quoteLanes = initialQuoteLanes;
			postQuotes = {};
			openQuotePickerCardKey = null;
			untrack(resetFetchModeState);
			laneActiveChainIds = buildSeedLaneActiveChainIds(seedQuoteLanes);
			expandedLaneId = null;
			activeLaneId = MAIN_LANE_ID;
			activeCardKey = `${MAIN_LANE_ID}:${initialMainAnchorUri}`;
			lastHandledRequestedFocusUri = null;
			lastHandledWinningFocusUri = null;
			celebrationBurst = null;
			resetTreeSearchState();
			cardHeights = {};
			detailModalTarget = null;
			treeBoardTarget = null;
		});

		$effect(() => {
			if (!expandedLaneId) return;
			if (!boardModel.laneById.has(expandedLaneId)) {
				expandedLaneId = null;
			}
		});

		$effect(() => {
			const laneId = searchLane?.id ?? null;
			if (laneId === lastSearchLaneId) return;
			lastSearchLaneId = laneId;
			resetTreeSearchState();
		});

		$effect(() => {
			zoom;
			syncZoomInput();
		});

		$effect(() => {
			const offsetY = boardModel.canvasOffsetY;
			if (!boardEl) {
				lastCanvasOffsetY = offsetY;
				return;
			}

			const delta = offsetY - lastCanvasOffsetY;
			lastCanvasOffsetY = offsetY;
			if (delta === 0) return;

			boardEl.scrollTop += delta * zoom;
			scheduleMinimapRefresh();
		});

			$effect(() => {
				boardModel;
				zoom;
				activeCardKey;
				if (!boardEl) return;
				scheduleMinimapRefresh();
			});

	$effect(() => {
		const availableKeys = boardModel.lanes.flatMap((lane) => lane.cards.map((card) => card.key));
		if (availableKeys.length === 0) {
			activeCardKey = '';
			return;
		}
		if (!availableKeys.includes(activeCardKey)) {
			activeCardKey = availableKeys[0];
			activeLaneId = boardModel.lanes[0]?.id ?? MAIN_LANE_ID;
		}
	});

	$effect(() => {
		onActivePostChange?.(activeCard?.post ?? null);
	});

	$effect(() => {
		const focusUri = requestedFocusUri?.trim() ?? null;
		if (!focusUri) {
			lastHandledRequestedFocusUri = null;
			return;
		}
		if (focusUri === lastHandledRequestedFocusUri) return;

		const targetCard = boardModel.cardsByPostUri.get(focusUri);
		if (!targetCard) return;

		lastHandledRequestedFocusUri = focusUri;
		void focusCard(targetCard.key);
	});

	$effect(() => {
		const focusUri = winningFocusUri?.trim() ?? null;
		if (!focusUri) {
			lastHandledWinningFocusUri = null;
			return;
		}
		if (focusUri === lastHandledWinningFocusUri) return;

		const targetCard = boardModel.cardsByPostUri.get(focusUri);
		if (!targetCard) return;

		lastHandledWinningFocusUri = focusUri;
		void (async () => {
			const initialSourceUri = sourceUri?.trim() ?? mainLaneAnchorUri?.trim() ?? focusUri;
			const winningDetails: WinningMoveDetails = {
				kind: 'initial-thread',
				laneId: targetCard.laneId,
				targetUri: focusUri,
				sourceUri: initialSourceUri
			};

			await focusCard(targetCard.key, 'auto');
			await tick();
			triggerCelebration(targetCard.key);
			onWinningMove?.({
				...winningDetails,
				summaryPosts: buildWinningMoveSummaryPosts(winningDetails)
			});
		})();
	});

	$effect(() => {
		if (!openQuotePickerCardKey) return;
		if (!boardModel.cardsByKey.has(openQuotePickerCardKey)) {
			openQuotePickerCardKey = null;
		}
	});

	$effect(() => {
		if (!detailModalTarget) return;
		if (!detailModalLane || !detailModalCard) {
			detailModalTarget = null;
		}
	});

	$effect(() => {
		if (!treeBoardTarget) return;
		if (!treeBoardLane || !treeBoardCard) {
			treeBoardTarget = null;
		}
	});

	$effect(() => {
		if (typeof document === 'undefined') return;
		isParallelBoardFullscreen = document.fullscreenElement === parallelBoardLayoutEl;
		if (!treeBoardTarget) {
			isTreeBoardFullscreen = false;
			return;
		}
		isTreeBoardFullscreen = document.fullscreenElement === treeBoardDialogEl;
	});

	onMount(() => {
		if (typeof document === 'undefined') return;
		const handleFullscreenChange = () => {
			isParallelBoardFullscreen = document.fullscreenElement === parallelBoardLayoutEl;
			isTreeBoardFullscreen = document.fullscreenElement === treeBoardDialogEl;
		};
		const handleDocumentPointerDown = (event: PointerEvent) => {
			if (
				showShortcutsHelp &&
				shortcutsHelpEl &&
				event.target instanceof Node &&
				!shortcutsHelpEl.contains(event.target)
			) {
				closeShortcutsHelp();
			}
			if (
				openQuotePickerCardKey &&
				event.target instanceof HTMLElement &&
				!event.target.closest('.card-quote-picker-wrap')
			) {
				openQuotePickerCardKey = null;
			}
		};
			const handleWindowMouseUp = () => {
				minimapDragging = false;
			};
			const handleWindowMouseMove = (event: MouseEvent) => {
				if (minimapDragging) {
					handleMinimapDrag(event);
				}
		};
		const resizeObserver = new ResizeObserver(() => {
			scheduleMinimapRefresh();
		});
		document.addEventListener('pointerdown', handleDocumentPointerDown);
		document.addEventListener('fullscreenchange', handleFullscreenChange);
		window.addEventListener('keydown', handleBoardShortcutKeydown);
		window.addEventListener('mouseup', handleWindowMouseUp);
		window.addEventListener('mousemove', handleWindowMouseMove);
			if (boardEl) {
				resizeObserver.observe(boardEl);
			}
			handleFullscreenChange();
			scheduleMinimapRefresh();
			return () => {
				advanceFetchModeRunId();
				fetchModeRunning = false;
				fetchModePaused = false;
				teardownFetchModeWorker();
				document.removeEventListener('pointerdown', handleDocumentPointerDown);
				document.removeEventListener('fullscreenchange', handleFullscreenChange);
			window.removeEventListener('keydown', handleBoardShortcutKeydown);
			window.removeEventListener('mouseup', handleWindowMouseUp);
			window.removeEventListener('mousemove', handleWindowMouseMove);
			resizeObserver.disconnect();
			clearCelebrationVisuals();
			if (minimapFrame) {
				cancelAnimationFrame(minimapFrame);
				minimapFrame = 0;
			}
		};
		});
	</script>

<div class="parallel-board-layout" bind:this={parallelBoardLayoutEl}>
	<div class="parallel-board-info">
		<span class="dimension-pill">1 present lane</span>
		<span class="dimension-meta">{countPosts(thread.rootPost)} posts on the board</span>
		<span class="dimension-meta">click a card to inspect it below</span>
		{#if readyQuoteLanes.length > 0}
			<span class="dimension-meta">{readyQuoteLanes.length} parallel lane{readyQuoteLanes.length === 1 ? '' : 's'}</span>
		{/if}
		{#if showExport}
			<ThreadExportButton
				{thread}
				selectedPost={activeCard?.post ?? null}
				allPosts={exportAllPosts}
				compact
			/>
		{/if}
		<button
			type="button"
			class="board-mode-btn"
			class:board-mode-btn-active={isBigMode}
			onclick={() => {
				isBigMode = !isBigMode;
			}}
			>
				{isBigMode ? 'Square mode (`m`)' : 'Big mode (`m`)'}
			</button>
			<button
					type="button"
					class="board-mode-btn"
					class:board-mode-btn-active={fetchModeRunning}
					title="Queue quote lanes from every board post"
					onclick={startFetchModeForBoard}
				>
				{fetchModeRunning ? 'Stop fetch mode' : 'Fetch mode'}
			</button>
		</div>

	{#if celebrationBurst}
		<div class="celebration-layer" aria-hidden="true">
			<div
				class="celebration-burst"
				style="left: {celebrationBurst.x}px; top: {celebrationBurst.y}px;"
			>
				<div class="celebration-core"></div>
				<div class="celebration-ring"></div>
				{#each Array.from({ length: 16 }) as _, index}
					<span
						class="celebration-piece"
						style={`--piece-angle: ${index * 22.5}deg; --piece-distance: ${84 + (index % 4) * 18}px; --piece-delay: ${(index % 5) * 18}ms; --piece-hue: ${18 + (index % 6) * 44};`}
					></span>
				{/each}
			</div>
		</div>
	{/if}

	<div class="parallel-board-shell">
		<div class="board-controls">
			<button type="button" class="board-control-btn" onclick={zoomIn} title="Zoom in">+</button>
			<label class="board-zoom-wrap" for="parallel-board-zoom">
				<input
					id="parallel-board-zoom"
					class="board-zoom-input"
					type="number"
					min={Math.round(ZOOM_MIN * 100)}
					max={Math.round(ZOOM_MAX * 100)}
					step="5"
					bind:value={zoomInput}
					onblur={applyZoomInput}
					onkeydown={handleZoomInputKeydown}
					aria-label="Zoom percentage"
				/>
				<span class="board-zoom-unit">%</span>
			</label>
			<button type="button" class="board-control-btn" onclick={zoomOut} title="Zoom out">-</button>
			<button type="button" class="board-control-btn board-reset-btn" onclick={zoomReset} title="Reset zoom">100</button>
			<button
				type="button"
				class="board-control-btn board-fullscreen-btn"
				onclick={() => void toggleParallelBoardFullscreen()}
				title={isParallelBoardFullscreen ? 'Exit fullscreen' : 'Open fullscreen'}
			>
				{isParallelBoardFullscreen ? 'Exit' : 'Full'}
				</button>
			</div>

			<div class="board-overlay-panels">
				{#if fetchModeQueue.length > 0 || fetchModeStatusMessage}
					{#if showFetchModePanel}
						<section class="fetch-mode-panel wobbly-border-light" aria-live="polite">
							<div class="fetch-mode-panel-head">
								<div>
									<strong class="fetch-mode-panel-title">Fetch mode</strong>
									<p class="fetch-mode-panel-status">{fetchModeStatusMessage || 'Idle'}</p>
								</div>
								<div class="fetch-mode-panel-actions">
									{#if fetchModeRunning}
										<button
											type="button"
											class="fetch-mode-pause-btn"
											onclick={fetchModePaused ? resumeFetchMode : pauseFetchMode}
										>
											{fetchModePaused ? 'Resume' : 'Pause'}
										</button>
										<button type="button" class="fetch-mode-stop-btn" onclick={stopFetchMode}>Stop</button>
									{/if}
									<button
										type="button"
										class="fetch-mode-close-btn"
										aria-label="Hide fetch mode"
										onclick={closeFetchModePanel}
									>
										×
									</button>
								</div>
							</div>
							<div class="fetch-mode-counts">
								<span>{fetchModeActiveCount} active</span>
								<span>{fetchModePendingCount} queued</span>
								<span>{fetchModeProcessedCount} processed</span>
								{#if fetchModeErrorCount > 0}
									<span class="fetch-mode-error-count">{fetchModeErrorCount} errors</span>
								{/if}
							</div>
							{#if visibleFetchModeQueue.length > 0}
								<ol class="fetch-mode-queue">
									{#each visibleFetchModeQueue as item, itemIndex (item.id + ':' + itemIndex)}
										<li
											class="fetch-mode-task"
											class:fetch-mode-task-running={item.status === 'running'}
											class:fetch-mode-task-done={item.status === 'done'}
											class:fetch-mode-task-skipped={item.status === 'skipped'}
											class:fetch-mode-task-error={item.status === 'error'}
										>
											<span class="fetch-mode-task-state">{getFetchModeTaskStatusLabel(item.status)}</span>
											<span class="fetch-mode-task-copy">
												<strong>{item.label}</strong>
												<span>{item.error || item.detail}</span>
											</span>
										</li>
									{/each}
								</ol>
							{/if}
						</section>
					{:else}
						<button
							type="button"
							class="fetch-mode-reopen-btn wobbly-border-light"
							onclick={reopenFetchModePanel}
						>
							Fetch mode
						</button>
					{/if}
				{/if}

				{#if searchLane}
					<div class="tree-search-wrap">
				{#if !showTreeSearchPanel}
					<div class="tree-search-mini-stack">
						<button
							type="button"
							class="panel-reopen-btn wobbly-border-light"
							onclick={() => (showTreeSearchPanel = true)}
						>
							Search
						</button>
					</div>
				{:else}
					<section class="tree-search-panel wobbly-border-light" aria-label="Lane search">
						<div class="panel-topline">
							<div>
								<strong class="panel-heading">Lane search</strong>
								<p class="tree-search-subtitle">Searching inside {searchLane.title}</p>
							</div>
							<button
								type="button"
								class="panel-close-btn"
								aria-label="Hide tree search"
								onclick={() => (showTreeSearchPanel = false)}
							>
								×
							</button>
						</div>

						<div class="tree-search-grid">
							<div class="tree-search-group">
								<label class="tree-search-label" for="parallel-tree-author-search">Author</label>
								<div class="tree-search-row">
									<input
										id="parallel-tree-author-search"
										bind:this={treeAuthorSearchInputEl}
										class="tree-search-input"
										type="text"
										placeholder="Find by handle or display name"
										bind:value={treeAuthorSearch}
										onkeydown={(event) => handleTreeSearchKey(event, 'author')}
									/>
									<button type="button" class="tree-search-btn" onclick={searchTreeAuthor}>Search</button>
								</div>
							</div>

							<div class="tree-search-group">
								<label class="tree-search-label" for="parallel-tree-text-search">Text</label>
								<div class="tree-search-row">
									<input
										id="parallel-tree-text-search"
										bind:this={treeTextSearchInputEl}
										class="tree-search-input"
										type="text"
										placeholder="Find words in the selected lane"
										bind:value={treeTextSearch}
										onkeydown={(event) => handleTreeSearchKey(event, 'text')}
									/>
									<button type="button" class="tree-search-btn" onclick={searchTreeText}>Search</button>
								</div>
							</div>
						</div>
						<p class="tree-search-shortcut-note">Use `u` for author, `/` for text, and press Enter again to step through matches.</p>
						<p class="tree-search-shortcut-note">
							In tree view, `1-9` jumps to numbered child branches, `r` jumps to the fork, and Backspace jumps to the root.
						</p>

						{#if treeSearchMessage}
							<p
								class="tree-search-status wobbly-border-light"
								class:tree-search-status-success={treeSearchStatus === 'success'}
								class:tree-search-status-error={treeSearchStatus === 'error'}
							>
								{treeSearchMessage}
							</p>
						{/if}
					</section>
				{/if}
				</div>
			{/if}
		</div>

		<div class="parallel-board-stage">
				<div
					class="parallel-board"
					class:panning={isPanning}
					bind:this={boardEl}
					role="application"
					aria-label="Parallel thread board"
					onpointerdown={handleBoardPointerDown}
					onpointermove={handleBoardPointerMove}
					onpointerup={handleBoardPointerUp}
					onscroll={handleBoardScroll}
				>
					<div
						class="parallel-board-canvas-stage"
						style="width: {getScaledCanvasSize(boardModel.boardWidth, zoom)}px; height: {getScaledCanvasSize(boardModel.boardHeight + boardModel.canvasOffsetY, zoom)}px;"
					>
						<div
							class="parallel-board-canvas"
							style="width: {boardModel.boardWidth}px; height: {boardModel.boardHeight}px; top: {boardModel.canvasOffsetY}px; transform: scale({zoom});"
						>
							<svg
								class="parallel-board-svg"
								width={boardModel.boardWidth}
								height={boardModel.boardHeight}
								aria-hidden="true"
							>
								<defs>
									<marker id="parallel-board-arrow" markerWidth="10" markerHeight="10" refX="6" refY="3" orient="auto">
										<path d="M0,0 L0,6 L6,3 z" fill="currentColor"></path>
									</marker>
								</defs>

								{#each boardModel.lanes as lane, laneIndex (lane.id + ':' + laneIndex)}
									{#if lane.activeCards.length > 0 && !laneIsExpanded(lane.id)}
										<path
											d={buildLaneRailPath(lane.activeCards)}
											class="lane-rail"
											class:lane-rail-main={lane.kind === 'main'}
											class:lane-rail-muted={expandedLaneId && lane.id !== expandedLaneId}
										></path>
									{/if}
								{/each}

								{#each boardModel.connectors as connector, connectorIndex (connector.key + ':' + connectorIndex)}
									<path
										d={buildConnectorPath(connector)}
										class="lane-connector"
										class:lane-connector-spawn={connector.kind === 'spawn'}
										class:lane-connector-tree={connector.kind === 'tree'}
										class:lane-connector-reference={connector.kind === 'reference'}
										class:lane-connector-muted={connectorIsMuted(connector)}
										marker-end={connector.kind === 'tree' ? undefined : 'url(#parallel-board-arrow)'}
									></path>
								{/each}
							</svg>

							{#each boardModel.lanes as lane, laneIndex (lane.id + ':' + laneIndex)}
								<div
									class="lane-marker"
									class:lane-marker-main={lane.kind === 'main'}
									class:lane-marker-muted={expandedLaneId && lane.id !== expandedLaneId}
									class:lane-marker-expanded={laneIsExpanded(lane.id)}
									style="left: {lane.x + (CARD_WIDTH - LANE_MARKER_WIDTH) / 2}px; top: {PADDING_Y}px;"
								>
									<span class="lane-marker-label">{lane.label}</span>
									<span class="lane-marker-title">{lane.title}</span>
									<button
										type="button"
										class="lane-marker-tree-btn"
										title={laneIsExpanded(lane.id) ? 'Collapse this lane back into a single chain' : 'Expand this lane into a tree fan'}
										onclick={(event) => {
											event.stopPropagation();
											void toggleLaneTree(
												lane.id,
												activeCard?.laneId === lane.id ? activeCard.post.uri : undefined
											);
										}}
									>
										{laneIsExpanded(lane.id) ? 'Fold' : 'Tree'}
									</button>
								</div>

								{#each lane.cards as card, cardIndex (card.key + ':' + cardIndex)}
									<article
										use:measureCardHeight={card.key}
										class="dimension-card"
										class:big-dimension-card={isBigMode}
										class:active-dimension-card={card.key === activeCardKey}
										class:source-pinned-card={cardIsSourcePin(card)}
										class:shadow-dimension-card={card.visibility === 'shadow'}
										class:active-chain-card={card.visibility === 'active'}
										class:muted-dimension-card={cardIsGhosted(card)}
										class:target-pinned-card={cardIsTargetPin(card)}
										class:tree-dimension-card={laneIsExpanded(card.laneId)}
										class:tree-author-match-card={cardMatchesSearchLane(card) && isTreeAuthorSearchMatch(card.post)}
										class:tree-text-match-card={cardMatchesSearchLane(card) && isTreeTextSearchMatch(card.post)}
										class:quoted-root-card={card.isLaneRoot && card.laneKind === 'quoted'}
										data-card-key={card.key}
										data-lane-id={card.laneId}
										style="left: {card.x}px; top: {card.y}px; --card-shift-x: {getCardShiftX(card)}px; --card-shift-y: {getCardShiftY(card)}px; --card-scale: {getCardScale(card)}; --card-opacity: {getCardOpacity(card)}; z-index: {getCardZIndex(card)};"
									>
										<div
											class="dimension-card-inner"
											role="button"
											tabindex="0"
											aria-label={`Select post by @${card.post.author.handle}`}
											title="Select this post"
											onclick={(event) => {
												if ((event.target as HTMLElement).closest('button, a, video')) return;
												selectCard(card);
											}}
											onkeydown={(event) => {
												if ((event.target as HTMLElement).closest('button, a, video')) return;
												if (event.key === 'Enter' || event.key === ' ') {
													event.preventDefault();
													selectCard(card);
												}
											}}
										>
											<div class="dimension-card-topline">
												<div class="dimension-card-topline-copy">
													<span class="card-lane-token">{card.laneLabel}</span>
													{#if cardIsSourcePin(card)}
														<span class="card-focus-token card-focus-token-source">From</span>
													{/if}
													{#if cardIsTargetPin(card)}
														<span class="card-focus-token card-focus-token-target">To</span>
													{/if}
													{#if card.isLaneRoot}
														<span class="card-root-token">{card.laneKind === 'main' ? 'Root' : 'Branch'}</span>
													{/if}
												</div>
												{#if hasLaneBranchSwitch(card)}
													<button
														type="button"
														class="card-branch-btn"
														title={getLaneBranchButtonTitle(card)}
														onclick={(event) => {
															event.stopPropagation();
															void cycleLaneBranch(card);
														}}
													>
														{getLaneBranchButtonLabel(card)}
													</button>
												{/if}
											</div>

											<div class="card-author-row">
												{#if card.post.author.avatar}
													<img src={card.post.author.avatar} alt="" class="card-avatar" />
												{/if}
												<div class="card-author-copy">
													<strong
														class="card-handle"
														class:card-handle-match={cardMatchesSearchLane(card) && isTreeAuthorSearchMatch(card.post)}
													>
														@{card.post.author.handle}
													</strong>
													<span class="card-date">{formatDate(card.post.createdAt)}</span>
												</div>
											</div>

												<div class="card-badges">
													<span>{formatCount(card.post.replyCount)} replies</span>
													{#if card.post.quoteCount > 0}
														<span>{formatCount(card.post.quoteCount)} quotes</span>
													{/if}
													<span>{formatCount(card.post.likeCount)} likes</span>
												{#if card.post.children.length > 1}
													<span>{card.post.children.length} branches</span>
												{/if}
												{#if card.post.embed?.images}
													<span>{card.post.embed.images.length} image{card.post.embed.images.length === 1 ? '' : 's'}</span>
												{/if}
												{#if card.post.embed?.video}
													<span>video</span>
												{/if}
											</div>

											<div class="dimension-card-scroll">
												<p class="card-snippet">
													{#each getTreeTextHighlightSegments(card.post) as segment}
														{#if segment.match && cardMatchesSearchLane(card)}
															<mark class="card-snippet-mark">{segment.text}</mark>
														{:else}
															{segment.text}
														{/if}
													{/each}
												</p>

												{#if card.post.embed?.images}
													<div class="card-media-grid">
														{#each card.post.embed.images as img}
															<button
																type="button"
																class="card-media-btn"
																onclick={(event) => {
																	event.stopPropagation();
																	openLightbox(img.fullsize, img.alt);
																}}
															>
																<img src={img.thumb} alt={img.alt} class="card-media-thumb" />
															</button>
														{/each}
													</div>
												{/if}

												{#if card.post.embed?.video}
													<video
														class="card-video-player"
														controls
														playsinline
														preload="metadata"
														poster={card.post.embed.video.thumbnail}
														aria-label={card.post.embed.video.alt || `Video by @${card.post.author.handle}`}
														onclick={(event) => event.stopPropagation()}
														onpointerdown={(event) => event.stopPropagation()}
													>
														<source src={card.post.embed.video.playlist} type="application/x-mpegURL" />
													</video>
												{/if}

												{#if card.post.embed?.external}
													<div class="card-inline-link">
														{#if card.post.embed.external.thumb}
															<img src={card.post.embed.external.thumb} alt="" class="card-inline-link-thumb" />
														{/if}
														<div class="card-inline-link-copy">
															<strong>{card.post.embed.external.title}</strong>
															<span>{card.post.embed.external.description}</span>
														</div>
													</div>
												{/if}

												{#if card.post.embed?.record}
													<div class="card-inline-quote">
														<div class="card-inline-quote-head">
															{#if card.post.embed.record.author.avatar}
																<img
																	src={card.post.embed.record.author.avatar}
																	alt=""
																	class="card-inline-quote-avatar"
																/>
															{/if}
															<div class="card-inline-quote-copy">
																<span class="card-inline-quote-kicker">Quoted post</span>
																<strong class="card-inline-quote-handle">
																	@{card.post.embed.record.author.handle}
																</strong>
															</div>
														</div>

														<p class="card-inline-quote-text">
															{card.post.embed.record.text?.trim() || 'Quoted post preview is sparse.'}
														</p>

														{#if card.post.embed.record.video}
															<video
																class="card-video-player card-video-player-quote"
																controls
																playsinline
																preload="metadata"
																poster={card.post.embed.record.video.thumbnail}
																aria-label={
																	card.post.embed.record.video.alt ||
																	`Video by @${card.post.embed.record.author.handle}`
																}
																onclick={(event) => event.stopPropagation()}
																onpointerdown={(event) => event.stopPropagation()}
															>
																<source src={card.post.embed.record.video.playlist} type="application/x-mpegURL" />
															</video>
														{/if}

														{#if card.post.embed.record.images}
															<div class="card-media-grid card-media-grid-quote">
																{#each card.post.embed.record.images as img}
																	<button
																		type="button"
																		class="card-media-btn"
																		onclick={(event) => {
																			event.stopPropagation();
																			openLightbox(img.fullsize, img.alt);
																		}}
																	>
																		<img src={img.thumb} alt={img.alt} class="card-media-thumb" />
																	</button>
																{/each}
															</div>
														{/if}
													</div>
												{/if}
												{#if card.post.embed?.record || hasQuotePicker(card.post)}
													<div class="card-quote-panel">
														<div class="card-quote-row">
															<div class="card-quote-copy">
																{#if card.post.embed?.record}
																	<span class="card-quote-label">Quotes</span>
																	<span class="card-quote-handle">@{card.post.embed.record.author.handle}</span>
																{:else}
																	<span class="card-quote-label">Quote posts</span>
																	<span class="card-quote-handle">
																		{formatCount(card.post.quoteCount)} available
																	</span>
																{/if}
															</div>
															<div class="card-quote-actions">
																{#if card.post.embed?.record}
																	<button
																		type="button"
																		class="card-quote-btn"
																		class:card-quote-btn-ready={isQuoteResolved(card.post)}
																		class:card-quote-btn-error={getQuoteLaneEntry(card.post)?.status === 'error'}
																		disabled={getQuoteLaneEntry(card.post)?.status === 'loading'}
																		title={getQuoteActionTitle(card.post)}
																		onclick={(event) => {
																			event.stopPropagation();
																			void handleQuoteThreadAction(card);
																		}}
																	>
																		{getQuoteActionLabel(card.post)}
																	</button>
																{/if}
																{#if hasQuotePicker(card.post)}
																	<div class="card-quote-picker-wrap">
																		<button
																			type="button"
																			class="card-quote-btn card-quote-btn-secondary"
																			aria-expanded={isQuotePickerOpen(card)}
																			title="Open quote post picker"
																			onclick={(event) => {
																				event.stopPropagation();
																				void toggleQuotePicker(card);
																			}}
																		>
																			{isQuotePickerOpen(card) ? 'Hide' : 'Pick quote'}
																		</button>
																	</div>
																{/if}
															</div>
														</div>
														{#if getQuoteStatusMessage(card.post)}
															<p
																class="card-quote-status"
																class:card-quote-status-error={getQuoteLaneEntry(card.post)?.status === 'error'}
															>
																{getQuoteStatusMessage(card.post)}
															</p>
														{/if}
														{#if isQuotePickerOpen(card)}
															<div class="card-quote-picker card-quote-picker-wrap">
																<div class="card-quote-picker-head">
																	<div class="card-quote-picker-copy">
																		<span class="card-quote-label">Quote posts</span>
																		<span class="card-quote-handle">
																			{getQuoteFeedCountLabel(card.post)}
																		</span>
																	</div>
																	<div class="card-quote-picker-actions">
																		<button
																			type="button"
																			class="card-quote-btn card-quote-btn-secondary"
																			disabled={
																				getQuoteFeedState(card.post).status === 'loading' ||
																				bulkQuoteLaneLoads[card.post.uri]
																			}
																			title="Refresh quote posts"
																			onclick={(event) => {
																				event.stopPropagation();
																				void loadQuotesForPost(card.post);
																			}}
																		>
																			{getQuoteFeedState(card.post).status === 'loading' &&
																			getQuoteFeedState(card.post).loadingMode !== 'all'
																				? 'Loading...'
																				: getQuoteFeedState(card.post).status === 'ready'
																					? 'Refresh'
																					: 'Load'}
																		</button>
																		{#if card.post.quoteCount > 0 && !getQuoteFeedState(card.post).loadedAll}
																			<button
																				type="button"
																				class="card-quote-btn card-quote-btn-secondary"
																				disabled={
																					getQuoteFeedState(card.post).status === 'loading' ||
																					bulkQuoteLaneLoads[card.post.uri]
																				}
																				title="Load every available quote post into this picker without opening lanes"
																				onclick={(event) => {
																					event.stopPropagation();
																					void loadQuotesForPost(card.post, { fetchAll: true });
																				}}
																			>
																				{getQuoteFeedState(card.post).status === 'loading' &&
																				getQuoteFeedState(card.post).loadingMode === 'all'
																					? 'Loading all...'
																					: 'Load all quote posts'}
																			</button>
																		{/if}
																		{#if card.post.quoteCount > 0}
																			<button
																				type="button"
																				class="card-quote-btn"
																				disabled={
																					getQuoteFeedState(card.post).status === 'loading' ||
																					bulkQuoteLaneLoads[card.post.uri]
																				}
																				title="Load every available quote post and create a lane for each one"
																				onclick={(event) => {
																					event.stopPropagation();
																					void loadAllQuotePostLanes(card);
																				}}
																			>
																				{bulkQuoteLaneLoads[card.post.uri]
																					? 'Creating lanes...'
																					: 'Create all quote lanes'}
																			</button>
																		{/if}
																	</div>
																</div>
																<p class="card-quote-picker-shortcut-note">
																	Press 1-9 while this card is selected.
																</p>
																{#if getQuoteFeedState(card.post).status === 'error'}
																	<p class="card-quote-status card-quote-status-error">
																		{getQuoteFeedState(card.post).error || 'Could not load quote posts.'}
																	</p>
																{:else if getQuoteFeedState(card.post).posts.length > 0}
																	<div class="card-quote-picker-posts">
																		{#each getQuoteFeedState(card.post).posts as quotePost, quoteIndex (quotePost.uri + ':' + quoteIndex)}
																			<button
																				type="button"
																				class="card-quote-picker-post"
																				title={`${getLaneActionTitleForUri(quotePost.uri)}${quoteIndex < 9 ? ` (Press ${quoteIndex + 1})` : ''}`}
																				onclick={(event) => {
																					event.stopPropagation();
																					void handleQuotePostLaneAction(card, quotePost);
																				}}
																			>
																				<span class="card-quote-picker-post-header">
																					<span class="card-quote-picker-post-author">
																						{#if quoteIndex < 9}
																							<span class="card-quote-picker-post-hotkey">{quoteIndex + 1}</span>
																						{/if}
																						<strong>@{quotePost.author.handle}</strong>
																					</span>
																					<span>{formatDate(quotePost.createdAt)}</span>
																				</span>
																				<span class="card-quote-picker-post-text">
																					{quotePost.text || 'No text'}
																				</span>
																				<span class="card-quote-picker-post-action">
																					{getLaneActionLabelForUri(quotePost.uri)}
																				</span>
																			</button>
																		{/each}
																	</div>
																{:else}
																	<p class="card-quote-picker-empty">
																		Load quote posts to choose which one becomes a lane.
																	</p>
																{/if}
															</div>
														{/if}
													</div>
												{/if}
												{#if laneIsExpanded(card.laneId)}
													<div
														class="tree-mode-nav"
														role="toolbar"
														tabindex="-1"
														onclick={(event) => event.stopPropagation()}
														onkeydown={(event) => event.stopPropagation()}
													>
														<button
															type="button"
															class="tree-mode-nav-btn"
															disabled={getExpandedTreeIndex(card) <= 0}
															title="Previous post"
															onclick={() => void navigateExpandedTreePrev(card)}
														>
															&larr;
														</button>
														<span class="tree-mode-nav-counter">
															{Math.max(1, getExpandedTreeIndex(card) + 1)}/{getExpandedTreeCount(card)}
														</span>
														<button
															type="button"
															class="tree-mode-nav-btn tree-mode-nav-btn-root"
															disabled={card.isLaneRoot}
															title="Return to root post"
															onclick={() => void navigateExpandedTreeRoot(card)}
														>
															Root
														</button>
														<button
															type="button"
															class="tree-mode-nav-btn tree-mode-nav-btn-fork"
															title="Jump to parent fork point"
															onclick={() => void navigateExpandedTreeFork(card)}
														>
															Fork
														</button>
														<button
															type="button"
															class="tree-mode-nav-btn"
															disabled={getExpandedTreeIndex(card) >= getExpandedTreeCount(card) - 1}
															title="Next post"
															onclick={() => void navigateExpandedTreeNext(card)}
														>
															&rarr;
														</button>
													</div>
													{#if getExpandedTreeChildPosts(card).length > 1}
														<div
															class="tree-mode-children-nav"
															role="toolbar"
															tabindex="-1"
															onclick={(event) => event.stopPropagation()}
															onkeydown={(event) => event.stopPropagation()}
														>
															<span class="tree-mode-children-label">Branches:</span>
															{#each getExpandedTreeChildPosts(card) as child, childIndex (child.uri + ':' + childIndex)}
																<button
																	type="button"
																	class="tree-mode-nav-btn tree-mode-child-btn"
																	class:tree-mode-child-btn-active={child.uri === activeCard?.post.uri && activeCard?.laneId === card.laneId}
																	title={child.text?.slice(0, 60) || `Branch ${childIndex + 1}`}
																	onclick={() => void focusExpandedTreePost(card.laneId, child.uri)}
																>
																	{childIndex + 1}
																</button>
															{/each}
														</div>
													{/if}
												{/if}
											</div>
										</div>
									</article>
								{/each}
							{/each}
							</div>
						</div>
					</div>

					<div class="board-aux-controls">
						<div class="board-shortcuts-help" bind:this={shortcutsHelpEl}>
							<button
								type="button"
								class="board-control-btn board-help-btn"
								aria-expanded={showShortcutsHelp}
								aria-controls="parallel-board-shortcuts"
								title="Keyboard shortcuts"
								onclick={(event) => {
									event.stopPropagation();
									toggleShortcutsHelp();
								}}
							>
								?
							</button>
							{#if showShortcutsHelp}
								<div id="parallel-board-shortcuts" class="board-shortcuts-tooltip" role="tooltip">
									<p class="board-shortcuts-title">Keyboard shortcuts</p>
									<ul class="board-shortcuts-list">
										{#each keyboardShortcuts as shortcut}
											<li class="board-shortcuts-item">
												<span class="board-shortcuts-keys">
													{#each shortcut.keys as keyLabel}
														<kbd>{keyLabel}</kbd>
													{/each}
												</span>
												<span class="board-shortcuts-description">{shortcut.description}</span>
											</li>
										{/each}
									</ul>
								</div>
							{/if}
						</div>

						<div
							class="minimap"
							bind:this={minimapEl}
							style="width: {minimapW}px; height: {minimapH}px;"
							role="button"
							tabindex="-1"
							aria-label="Board minimap"
							onmousedown={handleMinimapDragStart}
							onclick={handleMinimapClick}
							onkeydown={(event) => {
								if (event.key === 'Enter') {
									void focusCard(activeCardKey);
								}
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

			{#if detailModalTarget && detailModalLane && detailModalCard}
				<div class="detail-modal-layer">
					<button
						type="button"
						class="detail-modal-dismiss"
						aria-label="Close post details"
						onclick={closeDetailModal}
					></button>
					<dialog
						class="detail-modal"
						open
						aria-labelledby="detail-modal-title"
						bind:this={detailModalDialogEl}
					>
						<aside class="detail-panel detail-panel-modal wobbly-border-light">
							<div class="detail-panel-header">
								<div class="detail-panel-copy">
									<p class="detail-kicker">{detailModalLane.label}</p>
									<h2 id="detail-modal-title" class="detail-title">@{detailModalCard.post.author.handle}</h2>
									<p class="detail-subtitle">{detailModalLane.title}</p>
								</div>

								<div class="detail-panel-actions">
									<button
										type="button"
										class="detail-action-btn"
										onclick={() => void openTreeBoardFromDetailModal(detailModalCard)}
									>
										Open board
									</button>
									<a
										href={postUrl(detailModalCard.post.uri, detailModalCard.post.author.handle)}
										target="_blank"
										rel="noopener"
										class="detail-action-link"
									>
										Open post
									</a>
									{#if detailModalLane.kind === 'quoted'}
										<button
											type="button"
											class="detail-action-btn"
											onclick={() => void jumpToLaneSource(detailModalLane.id)}
										>
											Source
										</button>
										<a
											href={postUrl(detailModalLane.thread.rootPost.uri, detailModalLane.handle)}
											target="_blank"
											rel="noopener"
											class="detail-action-link"
										>
											Open lane
										</a>
										<button
											type="button"
											class="detail-action-btn detail-action-btn-danger"
											onclick={() => closeLane(detailModalLane.id)}
										>
											Close lane
										</button>
									{/if}
									<button type="button" class="detail-action-btn" onclick={closeDetailModal}>
										Close
									</button>
								</div>
							</div>

							<div class="detail-metadata">
								<span>{formatDate(detailModalCard.post.createdAt)}</span>
								<span>{formatCount(detailModalCard.post.replyCount)} replies</span>
								<span>{formatCount(detailModalCard.post.quoteCount)} quotes</span>
								<span>{formatCount(detailModalCard.post.repostCount)} reposts</span>
								<span>{formatCount(detailModalCard.post.likeCount)} likes</span>
								{#if detailModalCard.isLaneRoot && detailModalCard.laneIsTruncated}
									<span class="detail-warning">Some replies are missing</span>
								{/if}
							</div>

							<p class="detail-text">{detailModalCard.post.text || 'No text'}</p>

							{#if detailModalCard.post.embed?.images}
								<div class="detail-images">
									{#each detailModalCard.post.embed.images as img}
										<button type="button" class="detail-image-btn" onclick={() => openLightbox(img.fullsize, img.alt)}>
											<img src={img.thumb} alt={img.alt} class="detail-image" />
										</button>
									{/each}
								</div>
							{/if}

							{#if detailModalCard.post.embed?.video}
								<video
									class="detail-video-player"
									controls
									playsinline
									preload="metadata"
									poster={detailModalCard.post.embed.video.thumbnail}
									aria-label={detailModalCard.post.embed.video.alt || `Video by @${detailModalCard.post.author.handle}`}
								>
									<source src={detailModalCard.post.embed.video.playlist} type="application/x-mpegURL" />
								</video>
							{/if}

							{#if detailModalCard.post.embed?.external}
								<div class="detail-link-card">
									{#if detailModalCard.post.embed.external.thumb}
										<img src={detailModalCard.post.embed.external.thumb} alt="" class="detail-link-thumb" />
									{/if}
									<div class="detail-link-copy">
										<strong>{detailModalCard.post.embed.external.title}</strong>
										<span>{detailModalCard.post.embed.external.description}</span>
									</div>
								</div>
							{/if}

							{#if detailModalCard.post.embed?.record}
								<div class="detail-quote-card">
									<div class="detail-quote-head">
										<div>
											<span class="detail-quote-label">Quoted post</span>
											<strong class="detail-quote-handle">@{detailModalCard.post.embed.record.author.handle}</strong>
										</div>
										<button
											type="button"
											class="card-quote-btn"
											class:card-quote-btn-ready={isQuoteResolved(detailModalCard.post)}
											class:card-quote-btn-error={getQuoteLaneEntry(detailModalCard.post)?.status === 'error'}
											disabled={getQuoteLaneEntry(detailModalCard.post)?.status === 'loading'}
											onclick={() => void handleQuoteThreadAction(detailModalCard)}
										>
											{getQuoteActionLabel(detailModalCard.post)}
										</button>
									</div>
									<p class="detail-quote-text">
										{detailModalCard.post.embed.record.text || 'Quoted post preview is sparse.'}
									</p>
									{#if detailModalCard.post.embed.record.video}
										<video
											class="detail-video-player detail-video-player-quote"
											controls
											playsinline
											preload="metadata"
											poster={detailModalCard.post.embed.record.video.thumbnail}
											aria-label={
												detailModalCard.post.embed.record.video.alt ||
												`Video by @${detailModalCard.post.embed.record.author.handle}`
											}
										>
											<source
												src={detailModalCard.post.embed.record.video.playlist}
												type="application/x-mpegURL"
											/>
										</video>
									{/if}
									{#if getQuoteStatusMessage(detailModalCard.post)}
										<p
											class="card-quote-status"
											class:card-quote-status-error={getQuoteLaneEntry(detailModalCard.post)?.status === 'error'}
										>
											{getQuoteStatusMessage(detailModalCard.post)}
										</p>
									{/if}
								</div>
							{/if}

							<LinkedPostEmbeds
								text={detailModalCard.post.text}
								externalUri={detailModalCard.post.embed?.external?.uri}
								urls={detailModalCard.post.linkedUrls ?? []}
								excludeUris={[detailModalCard.post.uri, detailModalCard.post.embed?.record?.uri ?? '']}
							/>
						</aside>
					</dialog>
				</div>
			{/if}
		</div>
	</div>

		{#if treeBoardTarget && treeBoardLane && treeBoardCard}
			<div class="tree-board-modal-layer">
			<button
				type="button"
				class="tree-board-modal-dismiss"
				aria-label="Close tree board"
				onclick={closeTreeBoard}
			></button>
			<dialog
				class="tree-board-modal"
				open
				aria-labelledby="tree-board-modal-title"
				bind:this={treeBoardDialogEl}
			>
				<div class="tree-board-modal-header">
					<div class="tree-board-modal-copy">
						<p class="tree-board-modal-kicker">{treeBoardLane.label}</p>
						<h2 id="tree-board-modal-title" class="tree-board-modal-title">
							Tree board for @{treeBoardCard.post.author.handle}
						</h2>
						<p class="tree-board-modal-subtitle">
							Focused on the post you clicked inside {treeBoardLane.title}
						</p>
					</div>

					<div class="tree-board-modal-actions">
						<button
							type="button"
							class="detail-action-btn"
							onclick={() => void toggleTreeBoardFullscreen()}
						>
							{isTreeBoardFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
						</button>
						<a
							href={postUrl(treeBoardCard.post.uri, treeBoardCard.post.author.handle)}
							target="_blank"
							rel="noopener"
							class="detail-action-link"
						>
							Open post
						</a>
						<button type="button" class="detail-action-btn" onclick={closeTreeBoard}>
							Close
						</button>
					</div>
				</div>

				<div class="tree-board-modal-body">
					<BoardView
						thread={treeBoardLane.thread}
						initialActiveUri={treeBoardCard.post.uri}
						{platform}
					/>
				</div>
		</dialog>
	</div>
{/if}

<style>
	.parallel-board-layout {
		position: relative;
		display: flex;
		flex-direction: column;
		gap: 18px;
		width: min(1820px, calc(100vw - 24px));
		margin: 0 auto;
	}

	.parallel-board-layout:fullscreen {
		width: 100%;
		max-width: none;
		height: 100%;
		padding: 18px;
		background:
			radial-gradient(circle at top left, rgba(255, 255, 255, 0.52), transparent 32%),
			linear-gradient(180deg, #ece7dc, #ddd7ca);
		overflow: auto;
	}

	.parallel-board-layout:fullscreen .parallel-board-shell {
		gap: 0;
	}

	.parallel-board-info {
		display: flex;
		align-items: center;
		justify-content: center;
		flex-wrap: wrap;
		gap: 12px;
	}

	.celebration-layer {
		position: absolute;
		inset: 0;
		pointer-events: none;
		overflow: hidden;
		z-index: 80;
	}

	.celebration-burst {
		position: absolute;
		width: 0;
		height: 0;
	}

	.celebration-core,
	.celebration-ring,
	.celebration-piece {
		position: absolute;
		left: 0;
		top: 0;
		transform: translate(-50%, -50%);
	}

	.celebration-core {
		width: 26px;
		height: 26px;
		border-radius: 999px;
		background: radial-gradient(circle, rgba(255, 251, 219, 0.98), rgba(255, 192, 71, 0.2) 72%);
		animation: celebration-core-pop 820ms ease-out forwards;
	}

	.celebration-ring {
		width: 22px;
		height: 22px;
		border-radius: 999px;
		border: 3px solid rgba(255, 181, 71, 0.8);
		animation: celebration-ring-bloom 1000ms ease-out forwards;
	}

	.celebration-piece {
		width: 10px;
		height: 18px;
		border-radius: 999px;
		background: hsl(var(--piece-hue, 32) 92% 58%);
		box-shadow: 0 0 12px rgba(255, 195, 83, 0.24);
		opacity: 0;
		animation: celebration-piece-burst 980ms cubic-bezier(0.2, 0.8, 0.22, 1) forwards;
		animation-delay: var(--piece-delay, 0ms);
	}

	.dimension-pill,
	.dimension-meta {
		font-family: 'Courier New', monospace;
		font-size: 0.82rem;
	}

	.dimension-pill {
		padding: 4px 12px;
		border-radius: 999px;
		background: #2d2d3a;
		color: #f7f3e9;
	}

	.dimension-meta {
		color: var(--muted);
	}

	.board-mode-btn {
		padding: 8px 14px;
		border-radius: 999px;
		border: 1px solid rgba(61, 64, 91, 0.16);
		background: rgba(255, 252, 245, 0.96);
		color: #3f354a;
		font-family: 'Courier New', monospace;
		font-size: 0.78rem;
		font-weight: 700;
		cursor: pointer;
	}

	.board-mode-btn-active {
		background: rgba(111, 97, 255, 0.12);
		border-color: rgba(111, 97, 255, 0.38);
		color: #5b47d0;
	}

	.parallel-board-shell {
		position: relative;
		display: flex;
		flex-direction: column;
		gap: 18px;
	}

	.board-controls {
		position: absolute;
		top: 14px;
		left: 14px;
		z-index: 20;
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	.board-control-btn {
		width: 38px;
		height: 30px;
		border: 1px solid rgba(63, 56, 78, 0.22);
		background: rgba(246, 241, 228, 0.96);
		color: #44354f;
		font-family: 'Courier New', monospace;
		font-size: 0.9rem;
		font-weight: 700;
		cursor: pointer;
	}

	.board-control-btn:first-child {
		border-radius: 8px 8px 0 0;
	}

	.board-control-btn:last-child {
		border-radius: 0 0 8px 8px;
	}

		.board-control-btn:hover {
			background: #8260a9;
			color: white;
		}

	.board-overlay-panels {
		position: absolute;
		top: 14px;
		right: 14px;
		z-index: 22;
		display: flex;
		align-items: flex-start;
		justify-content: flex-end;
		gap: 10px;
		pointer-events: none;
	}

		.fetch-mode-panel {
			position: static;
			width: 340px;
			max-width: min(340px, calc(100vw - 500px));
			min-width: 300px;
			display: flex;
			flex-direction: column;
			gap: 8px;
			padding: 10px;
			background: rgba(255, 252, 245, 0.96);
			border: 1px solid rgba(61, 64, 91, 0.14);
			box-shadow: 0 18px 42px rgba(26, 35, 44, 0.12);
			pointer-events: auto;
		}

		.fetch-mode-reopen-btn {
			flex-shrink: 0;
			padding: 8px 11px;
			border: 1px solid rgba(61, 64, 91, 0.14);
			background: rgba(255, 252, 245, 0.96);
			box-shadow: 0 18px 42px rgba(26, 35, 44, 0.12);
			font-family: 'Courier New', monospace;
			font-size: 0.72rem;
			font-weight: 700;
			color: #554b67;
			cursor: pointer;
			pointer-events: auto;
		}

		.fetch-mode-panel-head {
			display: flex;
			align-items: flex-start;
			justify-content: space-between;
			gap: 10px;
		}

		.fetch-mode-panel-title {
			font-size: 0.72rem;
			letter-spacing: 0.08em;
			text-transform: uppercase;
			color: #655678;
		}

		.fetch-mode-panel-status {
			margin: 3px 0 0;
			font-family: 'Courier New', monospace;
			font-size: 0.74rem;
			line-height: 1.35;
			color: #433b4e;
		}

		.fetch-mode-panel-actions {
			display: flex;
			flex-shrink: 0;
			gap: 6px;
		}

		.fetch-mode-pause-btn,
		.fetch-mode-stop-btn,
		.fetch-mode-close-btn {
			flex-shrink: 0;
			padding: 6px 10px;
			border-radius: 999px;
			font-family: 'Courier New', monospace;
			font-size: 0.68rem;
			font-weight: 700;
			cursor: pointer;
		}

		.fetch-mode-pause-btn {
			border: 1px solid rgba(70, 92, 180, 0.24);
			background: rgba(244, 247, 255, 0.96);
			color: #4651a8;
		}

		.fetch-mode-stop-btn {
			border: 1px solid rgba(180, 35, 24, 0.22);
			background: rgba(255, 248, 242, 0.96);
			color: #a33226;
		}

		.fetch-mode-close-btn {
			width: 28px;
			padding: 6px 0;
			border: 1px solid rgba(68, 53, 79, 0.16);
			background: rgba(255, 255, 255, 0.86);
			color: #554b67;
		}

		.fetch-mode-counts {
			display: flex;
			flex-wrap: wrap;
			gap: 6px;
			font-family: 'Courier New', monospace;
			font-size: 0.66rem;
			color: #6d647a;
		}

		.fetch-mode-counts span {
			padding: 3px 7px;
			border-radius: 999px;
			background: rgba(68, 53, 79, 0.08);
		}

		.fetch-mode-counts .fetch-mode-error-count {
			background: rgba(180, 35, 24, 0.1);
			color: #a33226;
		}

		.fetch-mode-queue {
			display: grid;
			gap: 6px;
			max-height: 260px;
			margin: 0;
			padding: 0;
			list-style: none;
			overflow: auto;
		}

		.fetch-mode-task {
			display: grid;
			grid-template-columns: 44px minmax(0, 1fr);
			gap: 8px;
			align-items: start;
			padding: 8px;
			border-radius: 8px;
			background: rgba(247, 242, 231, 0.92);
			border: 1px solid rgba(77, 66, 96, 0.1);
		}

		.fetch-mode-task-running {
			background: rgba(235, 245, 255, 0.96);
			border-color: rgba(58, 117, 196, 0.2);
		}

		.fetch-mode-task-done {
			background: rgba(240, 255, 246, 0.9);
		}

		.fetch-mode-task-skipped {
			opacity: 0.72;
		}

		.fetch-mode-task-error {
			background: rgba(255, 248, 242, 0.96);
			border-color: rgba(180, 35, 24, 0.18);
		}

		.fetch-mode-task-state {
			display: inline-flex;
			justify-content: center;
			padding: 3px 5px;
			border-radius: 999px;
			background: rgba(61, 64, 91, 0.1);
			font-family: 'Courier New', monospace;
			font-size: 0.58rem;
			font-weight: 700;
			text-transform: uppercase;
			color: #554b67;
		}

		.fetch-mode-task-copy {
			min-width: 0;
			display: grid;
			gap: 2px;
		}

		.fetch-mode-task-copy strong {
			font-family: 'Courier New', monospace;
			font-size: 0.68rem;
			color: #342d3d;
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
		}

		.fetch-mode-task-copy span {
			font-size: 0.68rem;
			line-height: 1.32;
			color: #6d647a;
			word-break: break-word;
		}

		.tree-search-wrap {
		width: min(360px, calc(100vw - 110px));
		display: flex;
		flex-direction: column;
		gap: 6px;
		align-items: flex-end;
		pointer-events: none;
	}

	.tree-search-mini-stack {
		display: flex;
		flex-wrap: wrap;
		justify-content: flex-end;
		gap: 6px;
		pointer-events: auto;
	}

	.tree-search-panel {
		width: 100%;
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding: 9px;
		background: rgba(255, 252, 245, 0.94);
		backdrop-filter: blur(14px);
		box-shadow: 0 18px 42px rgba(26, 35, 44, 0.1);
		pointer-events: auto;
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

	.tree-search-subtitle {
		margin: 4px 0 0;
		font-size: 0.78rem;
		font-family: 'Courier New', monospace;
		color: #6b6175;
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

	.tree-search-grid {
		display: flex;
		flex-direction: column;
		gap: 10px;
	}

	.tree-search-group {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.tree-search-label {
		font-size: 0.72rem;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: #8a5f00;
	}

	.tree-search-row {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		gap: 8px;
	}

	.tree-search-input {
		width: 100%;
		padding: 10px 12px;
		background: #fffdf6;
		border: 1px solid rgba(61, 64, 91, 0.12);
		border-radius: 14px;
		color: #24313d;
		font-size: 0.9rem;
	}

	.tree-search-input:focus {
		border-color: #6f61ff;
		outline: none;
	}

	.tree-search-btn {
		min-width: 74px;
		border-radius: 14px;
		border: 1px solid rgba(61, 64, 91, 0.12);
		padding: 0 14px;
		background: #fffdf6;
		font-size: 0.82rem;
		font-weight: 700;
		color: #24313d;
	}

	.tree-search-shortcut-note {
		margin: 0;
		font-size: 0.72rem;
		line-height: 1.4;
		font-family: 'Courier New', monospace;
		color: #6f6480;
	}

	.tree-search-status {
		margin: 0;
		padding: 9px 11px;
		font-size: 0.82rem;
		font-family: 'Courier New', monospace;
		pointer-events: auto;
	}

	.tree-search-status-success {
		background: rgba(240, 255, 246, 0.96);
		color: #2d6a4f;
	}

	.tree-search-status-error {
		background: rgba(255, 248, 242, 0.96);
		color: #b42318;
	}

	.board-zoom-wrap {
		width: 60px;
		height: 34px;
		padding: 0 6px;
		border: 1px solid rgba(63, 56, 78, 0.22);
		background: rgba(246, 241, 228, 0.96);
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 2px;
		font-family: 'Courier New', monospace;
	}

	.board-zoom-input {
		width: 100%;
		border: none;
		background: transparent;
		text-align: right;
		font-size: 0.72rem;
		font-weight: 700;
		color: #44354f;
		padding: 0;
		appearance: textfield;
		-moz-appearance: textfield;
	}

	.board-zoom-input::-webkit-outer-spin-button,
	.board-zoom-input::-webkit-inner-spin-button {
		-webkit-appearance: none;
		margin: 0;
	}

	.board-zoom-input:focus {
		outline: none;
	}

	.board-zoom-unit {
		font-size: 0.68rem;
		color: #6e6585;
	}

	.board-reset-btn {
		width: 60px;
		font-size: 0.64rem;
	}

	.board-fullscreen-btn {
		width: 60px;
		font-size: 0.62rem;
		text-transform: uppercase;
		letter-spacing: 0.05em;
	}

	.board-help-btn {
		font-size: 1rem;
		line-height: 1;
		width: 34px;
		height: 34px;
		border-radius: 999px;
	}

	.board-help-btn.board-control-btn:first-child,
	.board-help-btn.board-control-btn:last-child {
		border-radius: 999px;
	}

	.board-aux-controls {
		position: absolute;
		right: 16px;
		bottom: 16px;
		z-index: 25;
		display: flex;
		flex-direction: column;
		align-items: flex-end;
		gap: 10px;
	}

	.board-shortcuts-help {
		position: relative;
	}

	.board-shortcuts-tooltip {
		position: absolute;
		right: 0;
		bottom: calc(100% + 8px);
		display: flex;
		flex-direction: column;
		gap: 10px;
		width: min(300px, calc(100vw - 120px));
		padding: 12px 14px;
		border-radius: 16px;
		background: rgba(41, 34, 52, 0.96);
		color: #f7f1e5;
		box-shadow: 0 18px 38px rgba(16, 13, 20, 0.34);
		z-index: 30;
	}

	.board-shortcuts-title {
		margin: 0;
		font-family: 'Courier New', monospace;
		font-size: 0.76rem;
		font-weight: 700;
		letter-spacing: 0.08em;
		text-transform: uppercase;
	}

	.board-shortcuts-list {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 10px;
		max-height: min(320px, calc(100vh - 240px));
		overflow: auto;
		padding-right: 4px;
		scrollbar-width: thin;
		scrollbar-color: rgba(255, 255, 255, 0.35) rgba(255, 255, 255, 0.08);
	}

	.board-shortcuts-list::-webkit-scrollbar {
		width: 8px;
	}

	.board-shortcuts-list::-webkit-scrollbar-track {
		background: rgba(255, 255, 255, 0.08);
		border-radius: 999px;
	}

	.board-shortcuts-list::-webkit-scrollbar-thumb {
		background: rgba(255, 255, 255, 0.35);
		border-radius: 999px;
	}

	.board-shortcuts-item {
		display: grid;
		gap: 5px;
	}

	.board-shortcuts-keys {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
	}

	.board-shortcuts-keys kbd {
		padding: 3px 7px;
		border-radius: 999px;
		background: rgba(255, 255, 255, 0.14);
		border: 1px solid rgba(255, 255, 255, 0.18);
		font-family: 'Courier New', monospace;
		font-size: 0.7rem;
		font-weight: 700;
	}

	.board-shortcuts-description {
		font-size: 0.78rem;
		line-height: 1.35;
		color: rgba(247, 241, 229, 0.84);
	}

	.parallel-board-stage {
		position: relative;
	}

		.parallel-board {
			position: relative;
			overflow: auto;
			max-height: 78vh;
		min-height: 520px;
		padding: 34px 34px 42px;
		border-radius: 20px;
		background:
			linear-gradient(90deg, rgba(255, 255, 255, 0.12) 1px, transparent 1px),
			linear-gradient(rgba(255, 255, 255, 0.12) 1px, transparent 1px),
			linear-gradient(135deg, #d7d3ca, #c6c1b7);
		background-size: 160px 160px, 160px 160px, 100% 100%;
		box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.4), 0 22px 44px rgba(35, 30, 44, 0.16);
		cursor: grab;
	}

	.parallel-board-layout:fullscreen .parallel-board {
		max-height: calc(100vh - 132px);
		min-height: calc(100vh - 132px);
	}

	.parallel-board.panning {
		cursor: grabbing;
		user-select: none;
	}

	.parallel-board-canvas {
		position: relative;
		transform-origin: top left;
	}

	.parallel-board-canvas-stage {
		position: relative;
	}

		.parallel-board-svg {
			position: absolute;
			inset: 0;
			overflow: visible;
			pointer-events: none;
		}

	.minimap {
		position: relative;
		background: rgba(246, 241, 228, 0.94);
		border: 1px solid rgba(97, 83, 122, 0.3);
		border-radius: 10px;
		box-shadow: 0 10px 22px rgba(33, 30, 41, 0.18);
		overflow: hidden;
		cursor: crosshair;
	}

		.minimap canvas {
			display: block;
		}

		.minimap-viewport {
			position: absolute;
			border: 2px solid rgba(111, 97, 255, 0.92);
			background: rgba(111, 97, 255, 0.12);
			border-radius: 4px;
			pointer-events: none;
			box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.32);
		}

		.lane-rail {
			fill: none;
			stroke: rgba(140, 95, 173, 0.78);
		stroke-width: 42px;
		stroke-linecap: round;
		filter: drop-shadow(0 6px 10px rgba(87, 60, 110, 0.18));
	}

	.lane-rail-main {
		stroke: rgba(124, 85, 158, 0.9);
	}

	.lane-rail-muted {
		opacity: 0.12;
	}

	.lane-connector {
		fill: none;
		stroke-linecap: round;
		color: rgba(145, 114, 187, 0.86);
	}

	.lane-connector-spawn {
		stroke: rgba(85, 68, 106, 0.92);
		stroke-width: 8px;
	}

	.lane-connector-tree {
		stroke: rgba(103, 79, 201, 0.94);
		stroke-width: 7px;
		filter: drop-shadow(0 4px 8px rgba(94, 72, 187, 0.18));
	}

	.lane-connector-reference {
		stroke: rgba(186, 176, 233, 0.92);
		stroke-width: 4px;
	}

	.lane-connector-muted {
		opacity: 0.1;
	}

	.lane-marker {
		position: absolute;
		width: 86px;
		height: 192px;
		padding: 14px 10px;
		border-radius: 18px;
		background: linear-gradient(180deg, #4a4955, #353441);
		color: #f4f0e4;
		box-shadow: 0 18px 28px rgba(33, 30, 41, 0.18);
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: space-between;
	}

	.lane-marker-main {
		background: linear-gradient(180deg, #393846, #24232d);
	}

	.lane-marker-muted {
		opacity: 0.24;
		transform: translateY(10px) scale(0.94);
	}

	.lane-marker-expanded {
		box-shadow:
			0 0 0 4px rgba(111, 97, 255, 0.12),
			0 24px 38px rgba(57, 45, 79, 0.24);
	}

	.lane-marker-label {
		writing-mode: vertical-lr;
		text-orientation: upright;
		font-size: 1.6rem;
		font-family: 'Times New Roman', serif;
		font-style: italic;
		letter-spacing: 0.04em;
	}

	.lane-marker-title {
		font-family: 'Courier New', monospace;
		font-size: 0.72rem;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: rgba(255, 255, 255, 0.7);
	}

	.lane-marker-tree-btn {
		padding: 6px 10px;
		border: 1px solid rgba(255, 255, 255, 0.22);
		border-radius: 999px;
		background: rgba(255, 255, 255, 0.14);
		color: #f7f1e5;
		font-family: 'Courier New', monospace;
		font-size: 0.64rem;
		font-weight: 700;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		cursor: pointer;
	}

	.lane-marker-tree-btn:hover {
		background: rgba(255, 255, 255, 0.24);
	}

	.dimension-card {
		position: absolute;
		width: 360px;
		height: 360px;
		transform: translate(var(--card-shift-x, 0px), var(--card-shift-y, 0px)) scale(var(--card-scale, 1));
		transform-origin: center center;
		opacity: var(--card-opacity, 1);
		transition:
			left 0.34s cubic-bezier(0.22, 1, 0.36, 1),
			top 0.34s cubic-bezier(0.22, 1, 0.36, 1),
			transform 0.26s cubic-bezier(0.22, 1, 0.36, 1),
			filter 0.2s ease,
			opacity 0.2s ease,
			z-index 0.2s ease;
	}

	.big-dimension-card {
		height: auto;
	}

	.dimension-card:hover {
		transform:
			translate(var(--card-shift-x, 0px), calc(var(--card-shift-y, 0px) - 4px))
			scale(var(--card-scale, 1));
		filter: drop-shadow(0 12px 16px rgba(30, 25, 35, 0.18));
	}

	.shadow-dimension-card {
		filter: drop-shadow(0 10px 16px rgba(28, 24, 37, 0.16));
	}

	.muted-dimension-card {
		filter: blur(0.2px) grayscale(0.18) drop-shadow(0 6px 10px rgba(28, 24, 37, 0.06));
	}

	.tree-dimension-card .dimension-card-inner {
		border-color: rgba(102, 82, 214, 0.96);
		background:
			linear-gradient(180deg, rgba(255, 249, 236, 0.995), rgba(249, 242, 227, 0.995));
		box-shadow:
			0 0 0 5px rgba(111, 97, 255, 0.12),
			0 22px 34px rgba(58, 47, 87, 0.18);
	}

	.tree-dimension-card.active-dimension-card .dimension-card-inner {
		box-shadow:
			0 0 0 6px rgba(111, 97, 255, 0.2),
			0 24px 38px rgba(58, 47, 87, 0.22);
	}

	.tree-author-match-card .dimension-card-inner {
		border-color: rgba(101, 76, 198, 0.96);
		box-shadow:
			0 0 0 5px rgba(111, 97, 255, 0.18),
			0 20px 32px rgba(58, 47, 87, 0.2);
	}

	.tree-text-match-card .dimension-card-inner {
		border-color: rgba(180, 113, 33, 0.92);
		box-shadow:
			0 0 0 5px rgba(246, 187, 82, 0.18),
			0 20px 32px rgba(91, 63, 24, 0.16);
	}

	.dimension-card-inner {
		position: relative;
		width: 100%;
		height: 100%;
		padding: 14px 14px 12px;
		border-radius: 18px;
		background: linear-gradient(180deg, rgba(252, 244, 226, 0.98), rgba(244, 236, 218, 0.98));
		border: 4px solid rgba(45, 41, 55, 0.92);
		box-shadow: 0 16px 20px rgba(36, 32, 44, 0.16);
		display: flex;
		flex-direction: column;
		gap: 10px;
		cursor: pointer;
		overflow: hidden;
	}

	.big-dimension-card .dimension-card-inner {
		height: auto;
		min-height: 360px;
		overflow: visible;
	}

	.dimension-card-inner:focus-visible {
		outline: 3px solid rgba(111, 97, 255, 0.88);
		outline-offset: 4px;
	}

	.active-dimension-card .dimension-card-inner {
		border-color: #6f61ff;
		box-shadow: 0 0 0 4px rgba(111, 97, 255, 0.16), 0 18px 22px rgba(36, 32, 44, 0.18);
	}

	.shadow-dimension-card .dimension-card-inner {
		border-color: rgba(103, 95, 124, 0.52);
		background: linear-gradient(180deg, rgba(244, 238, 228, 0.95), rgba(235, 229, 218, 0.94));
		box-shadow: 0 12px 16px rgba(36, 32, 44, 0.12);
	}

	.quoted-root-card .dimension-card-inner {
		border-color: rgba(105, 89, 225, 0.86);
	}

	.source-pinned-card .dimension-card-inner {
		border-color: rgba(59, 121, 109, 0.92);
		box-shadow:
			0 0 0 4px rgba(88, 171, 155, 0.13),
			0 18px 22px rgba(34, 77, 70, 0.12);
	}

	.target-pinned-card .dimension-card-inner {
		border-color: rgba(224, 122, 95, 0.94);
		box-shadow:
			0 0 0 4px rgba(224, 122, 95, 0.14),
			0 18px 24px rgba(132, 57, 40, 0.12);
	}

	.source-pinned-card.active-dimension-card .dimension-card-inner {
		box-shadow:
			0 0 0 6px rgba(88, 171, 155, 0.2),
			0 20px 26px rgba(34, 77, 70, 0.18);
	}

	.target-pinned-card.active-dimension-card .dimension-card-inner {
		box-shadow:
			0 0 0 6px rgba(224, 122, 95, 0.22),
			0 22px 28px rgba(132, 57, 40, 0.2);
	}

	.dimension-card-topline {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
	}

	.dimension-card-topline-copy {
		display: flex;
		align-items: center;
		gap: 8px;
		flex-wrap: wrap;
		min-width: 0;
	}

	.card-lane-token,
	.card-root-token,
	.card-focus-token {
		padding: 4px 8px;
		border-radius: 999px;
		font-family: 'Courier New', monospace;
		font-size: 0.64rem;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.06em;
	}

	.card-lane-token {
		background: rgba(124, 85, 158, 0.12);
		color: #6c498d;
	}

	.card-root-token {
		background: rgba(36, 33, 45, 0.08);
		color: #47414f;
	}

	.card-focus-token-source {
		background: rgba(88, 171, 155, 0.16);
		color: #22685f;
	}

	.card-focus-token-target {
		background: rgba(224, 122, 95, 0.16);
		color: #a6462f;
	}

	.card-branch-btn {
		flex-shrink: 0;
		padding: 5px 10px;
		border-radius: 999px;
		border: 1px solid rgba(82, 72, 106, 0.18);
		background: rgba(59, 53, 71, 0.08);
		color: #514866;
		font-size: 0.64rem;
		font-family: 'Courier New', monospace;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		cursor: pointer;
	}

	.card-branch-btn:hover {
		background: #6f61ff;
		border-color: #6f61ff;
		color: white;
	}

	.card-author-row {
		display: flex;
		align-items: center;
		gap: 10px;
		min-width: 0;
	}

	.card-avatar {
		width: 34px;
		height: 34px;
		border-radius: 50%;
		object-fit: cover;
		flex-shrink: 0;
	}

	.card-author-copy {
		display: flex;
		flex-direction: column;
		min-width: 0;
	}

	.card-handle {
		font-size: 0.83rem;
		font-family: 'Courier New', monospace;
		color: #40394a;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.card-handle-match {
		color: #6f61ff;
	}

	.card-date {
		font-size: 0.68rem;
		font-family: 'Courier New', monospace;
		color: #8d8477;
	}

	.card-snippet {
		margin: 0;
		font-size: 0.84rem;
		line-height: 1.48;
		color: #342f39;
		font-family: 'Courier New', monospace;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
		word-break: break-word;
	}

	.card-snippet-mark {
		padding: 0 2px;
		border-radius: 4px;
		background: rgba(255, 220, 125, 0.7);
		color: #433114;
	}

	.dimension-card-scroll {
		flex: 1 1 auto;
		min-height: 0;
		overflow: auto;
		padding-right: 6px;
		display: flex;
		flex-direction: column;
		gap: 10px;
		overscroll-behavior: contain;
		scrollbar-width: thin;
		scrollbar-color: rgba(104, 95, 120, 0.55) rgba(104, 95, 120, 0.12);
	}

	.big-dimension-card .dimension-card-scroll {
		flex: 0 1 auto;
		min-height: auto;
		overflow: visible;
		padding-right: 0;
	}

	.dimension-card-scroll::-webkit-scrollbar {
		width: 8px;
	}

	.dimension-card-scroll::-webkit-scrollbar-track {
		background: rgba(104, 95, 120, 0.12);
		border-radius: 999px;
	}

	.dimension-card-scroll::-webkit-scrollbar-thumb {
		background: rgba(104, 95, 120, 0.55);
		border-radius: 999px;
	}

	.card-badges {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
	}

	.card-badges span {
		padding: 3px 7px;
		border-radius: 999px;
		background: rgba(57, 55, 68, 0.08);
		font-size: 0.65rem;
		font-family: 'Courier New', monospace;
		color: #5b5566;
	}

	.card-media-grid {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 8px;
	}

	.card-media-grid-quote {
		grid-template-columns: repeat(2, minmax(0, 1fr));
	}

	.card-media-btn {
		padding: 0;
		border: none;
		background: transparent;
		border-radius: 10px;
		cursor: pointer;
		overflow: hidden;
	}

	.card-media-thumb {
		display: block;
		width: 100%;
		height: 88px;
		object-fit: cover;
		border-radius: 10px;
		border: 1px solid rgba(63, 56, 78, 0.12);
		background: rgba(255, 255, 255, 0.7);
	}

	.card-video-player {
		display: block;
		width: 100%;
		max-height: 180px;
		border-radius: 12px;
		border: 1px solid rgba(63, 56, 78, 0.12);
		background: #15131b;
	}

	.card-video-player-quote {
		max-height: 148px;
	}

	.card-inline-link,
	.card-inline-quote {
		padding: 10px;
		border-radius: 12px;
		border: 1px solid rgba(63, 56, 78, 0.1);
		background: rgba(250, 247, 239, 0.82);
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.card-inline-link {
		flex-direction: row;
		align-items: flex-start;
	}

	.card-inline-link-thumb {
		width: 72px;
		height: 72px;
		border-radius: 8px;
		object-fit: cover;
		flex-shrink: 0;
	}

	.card-inline-link-copy {
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.card-inline-link-copy strong,
	.card-inline-link-copy span,
	.card-inline-quote-copy,
	.card-inline-quote-text {
		font-family: 'Courier New', monospace;
	}

	.card-inline-link-copy strong {
		font-size: 0.74rem;
		color: #372f42;
	}

	.card-inline-link-copy span {
		font-size: 0.68rem;
		line-height: 1.4;
		color: #6b6378;
		display: -webkit-box;
		display: box;
		line-clamp: 3;
		-webkit-line-clamp: 3;
		-webkit-box-orient: vertical;
		overflow: hidden;
	}

	.card-inline-quote-head {
		display: flex;
		align-items: center;
		gap: 8px;
		min-width: 0;
	}

	.card-inline-quote-avatar {
		width: 28px;
		height: 28px;
		border-radius: 50%;
		object-fit: cover;
		flex-shrink: 0;
	}

	.card-inline-quote-copy {
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-width: 0;
	}

	.card-inline-quote-kicker {
		font-size: 0.6rem;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: #7e7791;
	}

	.card-inline-quote-handle {
		font-size: 0.72rem;
		color: #40394a;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.card-inline-quote-text {
		margin: 0;
		font-size: 0.76rem;
		line-height: 1.45;
		color: #544c5f;
		white-space: pre-wrap;
		word-break: break-word;
	}

	.card-quote-panel {
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding-top: 10px;
		border-top: 1px dashed rgba(84, 77, 94, 0.2);
		pointer-events: auto;
	}

	.card-quote-row {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 8px;
	}

	.card-quote-copy {
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-width: 0;
	}

	.card-quote-actions {
		display: flex;
		align-items: flex-start;
		justify-content: flex-end;
		gap: 6px;
		flex-wrap: wrap;
	}

	.card-quote-label {
		font-size: 0.62rem;
		font-family: 'Courier New', monospace;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: #7e7791;
	}

	.card-quote-handle {
		font-size: 0.74rem;
		font-family: 'Courier New', monospace;
		color: #4b4257;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.card-quote-btn {
		padding: 6px 10px;
		border-radius: 999px;
		border: 1px solid rgba(124, 85, 158, 0.28);
		background: rgba(124, 85, 158, 0.1);
		color: #6f4e91;
		font-size: 0.7rem;
		font-family: 'Courier New', monospace;
		font-weight: 700;
		cursor: pointer;
	}

	.card-quote-btn:hover:not(:disabled) {
		background: #6f61ff;
		border-color: #6f61ff;
		color: white;
	}

	.card-quote-btn:disabled {
		opacity: 0.65;
		cursor: wait;
	}

	.card-quote-btn-ready {
		background: rgba(111, 97, 255, 0.1);
		border-color: rgba(111, 97, 255, 0.35);
		color: #5d51de;
	}

	.card-quote-btn-error {
		background: rgba(217, 45, 32, 0.08);
		border-color: rgba(217, 45, 32, 0.24);
		color: #b42318;
	}

	.card-quote-btn-secondary {
		background: rgba(62, 54, 80, 0.08);
		border-color: rgba(62, 54, 80, 0.16);
		color: #554b67;
	}

	.card-quote-picker-wrap {
		position: relative;
	}

	.card-quote-status {
		margin: 0;
		font-size: 0.64rem;
		font-family: 'Courier New', monospace;
		color: #675f75;
	}

	.card-quote-status-error {
		color: #b42318;
	}

	.card-quote-picker {
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding: 10px;
		border-radius: 12px;
		background: rgba(255, 251, 244, 0.92);
		border: 1px solid rgba(77, 66, 96, 0.12);
	}

	.card-quote-picker-head {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 8px;
	}

	.card-quote-picker-copy {
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-width: 0;
	}

	.card-quote-picker-actions {
		display: flex;
		flex-wrap: wrap;
		justify-content: flex-end;
		gap: 8px;
	}

	.card-quote-picker-shortcut-note {
		margin: 0;
		font-size: 0.64rem;
		font-family: 'Courier New', monospace;
		color: #766d86;
	}

	.card-quote-picker-posts {
		display: grid;
		gap: 8px;
	}

	.card-quote-picker-post {
		display: grid;
		gap: 5px;
		padding: 10px;
		border-radius: 10px;
		border: 1px solid rgba(77, 66, 96, 0.14);
		background: rgba(250, 246, 237, 0.96);
		text-align: left;
		cursor: pointer;
	}

	.card-quote-picker-post:hover {
		background: rgba(255, 255, 255, 0.98);
		border-color: rgba(115, 90, 150, 0.28);
	}

	.card-quote-picker-post-header,
	.card-quote-picker-post-action {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		font-family: 'Courier New', monospace;
	}

	.card-quote-picker-post-header {
		font-size: 0.68rem;
		color: #675f75;
	}

	.card-quote-picker-post-author {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		min-width: 0;
	}

	.card-quote-picker-post-hotkey {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-width: 20px;
		height: 20px;
		padding: 0 6px;
		border-radius: 999px;
		background: rgba(111, 97, 255, 0.12);
		border: 1px solid rgba(111, 97, 255, 0.28);
		color: #5d51de;
		font-size: 0.62rem;
		font-weight: 700;
	}

	.card-quote-picker-post-text {
		font-size: 0.74rem;
		line-height: 1.4;
		color: #322d38;
		white-space: pre-wrap;
		word-break: break-word;
	}

	.card-quote-picker-post-action {
		font-size: 0.63rem;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: #7d5aa3;
	}

	.card-quote-picker-empty {
		margin: 0;
		font-size: 0.7rem;
		line-height: 1.35;
		font-family: 'Courier New', monospace;
		color: #6a6276;
	}

	.tree-mode-nav {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 6px;
		margin-top: 10px;
		padding-top: 8px;
		border-top: 1px dashed #e0d5b8;
	}

	.tree-mode-nav-btn {
		padding: 2px 8px;
		font-size: 0.75rem;
		font-family: 'Courier New', monospace;
		background: #f5edd8;
		border: 1px solid #d4c5a0;
		border-radius: 3px;
		cursor: pointer;
		color: #555;
		transition: background 0.15s, color 0.15s, border-color 0.15s;
	}

	.tree-mode-nav-btn:hover:not(:disabled) {
		background: #cc0000;
		color: white;
		border-color: #cc0000;
	}

	.tree-mode-nav-btn:disabled {
		opacity: 0.3;
		cursor: not-allowed;
	}

	.tree-mode-nav-btn-root {
		background: #f0ecff;
		border-color: rgba(111, 97, 255, 0.35);
		color: #5d51de;
	}

	.tree-mode-nav-btn-fork {
		background: #ffeaea;
		border-color: #cc0000;
		color: #cc0000;
	}

	.tree-mode-nav-counter {
		font-size: 0.7rem;
		color: #999;
		font-family: 'Courier New', monospace;
		min-width: 40px;
		text-align: center;
	}

	.tree-mode-children-nav {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 4px;
		margin-top: 6px;
		padding-top: 6px;
		border-top: 1px dashed #e0d5b8;
		flex-wrap: wrap;
	}

	.tree-mode-children-label {
		font-size: 0.65rem;
		color: #999;
		font-family: 'Courier New', monospace;
	}

	.tree-mode-child-btn {
		min-width: 24px;
		padding: 2px 6px;
		font-size: 0.7rem;
		background: #ffeaea;
		border-color: #cc0000;
		color: #cc0000;
	}

	.tree-mode-child-btn-active {
		background: #cc0000;
		border-color: #cc0000;
		color: white;
	}

	.detail-panel {
		padding: 18px;
		background: rgba(255, 250, 241, 0.96);
		backdrop-filter: blur(14px);
		box-shadow: 0 18px 34px rgba(36, 32, 44, 0.1);
		display: flex;
		flex-direction: column;
		gap: 16px;
	}

	.detail-modal-layer {
		position: fixed;
		inset: 0;
		z-index: 85;
		padding: 18px;
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.detail-modal-dismiss {
		position: absolute;
		inset: 0;
		border: none;
		padding: 0;
		margin: 0;
		background: rgba(20, 16, 25, 0.34);
		backdrop-filter: blur(6px);
		cursor: pointer;
	}

	.detail-modal {
		position: relative;
		z-index: 1;
		width: min(920px, calc(100vw - 36px));
		max-height: calc(100vh - 36px);
		padding: 0;
		border: none;
		background: transparent;
	}

	.detail-panel-modal {
		max-height: calc(100vh - 36px);
		overflow: auto;
	}

	.detail-panel-header {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 16px;
		flex-wrap: wrap;
	}

	.detail-panel-copy {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.detail-kicker,
	.detail-subtitle,
	.detail-warning,
	.detail-quote-label,
	.detail-quote-text {
		margin: 0;
		font-family: 'Courier New', monospace;
	}

	.detail-kicker {
		font-size: 0.7rem;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: #7d7190;
	}

	.detail-title {
		margin: 0;
		font-size: 1.4rem;
		color: #322d38;
	}

	.detail-subtitle {
		font-size: 0.86rem;
		color: #726a7f;
	}

	.detail-panel-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}

	.detail-action-btn,
	.detail-action-link {
		padding: 7px 11px;
		border-radius: 999px;
		border: 1px solid rgba(63, 56, 78, 0.16);
		background: #fffdf7;
		color: #44354f;
		font-size: 0.72rem;
		font-family: 'Courier New', monospace;
		font-weight: 700;
		text-decoration: none;
		cursor: pointer;
	}

	.detail-action-btn:hover,
	.detail-action-link:hover {
		background: #6f61ff;
		border-color: #6f61ff;
		color: white;
	}

	.detail-action-btn-danger {
		color: #b42318;
		border-color: rgba(180, 35, 24, 0.18);
	}

	.detail-metadata {
		display: flex;
		flex-wrap: wrap;
		gap: 10px;
		font-size: 0.72rem;
		font-family: 'Courier New', monospace;
		color: #6e667c;
	}

	.detail-warning {
		color: #b42318;
	}

	.detail-text {
		margin: 0;
		font-size: 1rem;
		line-height: 1.55;
		color: #2f2935;
		white-space: pre-wrap;
		word-break: break-word;
	}

	.detail-images {
		display: flex;
		flex-wrap: wrap;
		gap: 10px;
	}

	.detail-image-btn {
		padding: 0;
		border: none;
		background: transparent;
		cursor: pointer;
	}

	.detail-image {
		width: min(240px, 100%);
		border-radius: 10px;
		border: 1px solid rgba(63, 56, 78, 0.12);
	}

	.detail-video-player {
		display: block;
		width: min(520px, 100%);
		max-width: 100%;
		border-radius: 12px;
		border: 1px solid rgba(63, 56, 78, 0.12);
		background: #15131b;
	}

	.detail-video-player-quote {
		width: min(420px, 100%);
	}

	.detail-link-card,
	.detail-quote-card {
		padding: 12px;
		border-radius: 12px;
		background: rgba(241, 233, 217, 0.78);
		border: 1px solid rgba(63, 56, 78, 0.1);
		display: flex;
		gap: 12px;
	}

	.detail-link-thumb {
		width: 96px;
		height: 72px;
		border-radius: 8px;
		object-fit: cover;
		flex-shrink: 0;
	}

	.detail-link-copy {
		display: flex;
		flex-direction: column;
		gap: 4px;
		min-width: 0;
	}

	.detail-link-copy strong,
	.detail-link-copy span {
		font-family: 'Courier New', monospace;
	}

	.detail-link-copy strong {
		font-size: 0.86rem;
		color: #2d2733;
	}

	.detail-link-copy span {
		font-size: 0.74rem;
		color: #655e73;
		display: -webkit-box;
		display: box;
		line-clamp: 3;
		-webkit-line-clamp: 3;
		-webkit-box-orient: vertical;
		overflow: hidden;
	}

	.detail-quote-card {
		flex-direction: column;
	}

	.detail-quote-head {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 12px;
		flex-wrap: wrap;
	}

	.detail-quote-label {
		display: block;
		font-size: 0.66rem;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: #7a7189;
	}

	.detail-quote-handle {
		font-size: 0.84rem;
		font-family: 'Courier New', monospace;
		color: #3d3646;
	}

	.detail-quote-text {
		font-size: 0.86rem;
		line-height: 1.45;
		color: #544c5f;
		white-space: pre-wrap;
		word-break: break-word;
	}

	.tree-board-modal-layer {
		position: fixed;
		inset: 0;
		z-index: 90;
		padding: 18px;
		display: flex;
		align-items: stretch;
		justify-content: center;
	}

	.tree-board-modal-dismiss {
		position: absolute;
		inset: 0;
		border: none;
		padding: 0;
		margin: 0;
		background: rgba(20, 16, 25, 0.44);
		backdrop-filter: blur(8px);
		cursor: pointer;
	}

	.tree-board-modal {
		position: relative;
		z-index: 1;
		width: min(100%, 1880px);
		height: 100%;
		display: flex;
		flex-direction: column;
		min-height: 0;
		border-radius: 28px;
		border: 1px solid rgba(53, 46, 67, 0.14);
		background: rgba(249, 245, 236, 0.98);
		box-shadow: 0 28px 80px rgba(18, 15, 24, 0.28);
		overflow: hidden;
		padding: 0;
	}

	.tree-board-modal:fullscreen {
		width: 100%;
		height: 100%;
		max-width: none;
		border-radius: 0;
		border: none;
		box-shadow: none;
	}

	.tree-board-modal-header {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 16px;
		padding: 18px 20px 14px;
		border-bottom: 1px solid rgba(53, 46, 67, 0.08);
		background: linear-gradient(180deg, rgba(255, 252, 246, 0.98), rgba(248, 241, 230, 0.94));
	}

	.tree-board-modal-copy {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.tree-board-modal-kicker,
	.tree-board-modal-subtitle {
		margin: 0;
		font-family: 'Courier New', monospace;
	}

	.tree-board-modal-kicker {
		font-size: 0.7rem;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: #7d7190;
	}

	.tree-board-modal-title {
		margin: 0;
		font-size: 1.45rem;
		color: #2f2935;
	}

	.tree-board-modal-subtitle {
		font-size: 0.84rem;
		color: #6f677d;
	}

	.tree-board-modal-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}

	.tree-board-modal-body {
		flex: 1 1 auto;
		min-height: 0;
		overflow: auto;
		padding: 14px;
		background:
			linear-gradient(90deg, rgba(128, 116, 148, 0.08) 1px, transparent 1px),
			linear-gradient(rgba(128, 116, 148, 0.08) 1px, transparent 1px),
		#ece7dc;
		background-size: 160px 160px;
	}

	@keyframes celebration-core-pop {
		0% {
			opacity: 0;
			transform: translate(-50%, -50%) scale(0.2);
		}
		24% {
			opacity: 1;
			transform: translate(-50%, -50%) scale(1);
		}
		100% {
			opacity: 0;
			transform: translate(-50%, -50%) scale(1.8);
		}
	}

	@keyframes celebration-ring-bloom {
		0% {
			opacity: 0;
			transform: translate(-50%, -50%) scale(0.2);
		}
		18% {
			opacity: 1;
		}
		100% {
			opacity: 0;
			transform: translate(-50%, -50%) scale(5.2);
		}
	}

	@keyframes celebration-piece-burst {
		0% {
			opacity: 0;
			transform: translate(-50%, -50%) rotate(var(--piece-angle)) translateY(-6px) scale(0.4);
		}
		16% {
			opacity: 1;
		}
		100% {
			opacity: 0;
			transform:
				translate(-50%, -50%)
				rotate(var(--piece-angle))
				translateY(calc(var(--piece-distance) * -1))
				scale(1.05);
		}
	}

	@media (max-width: 900px) {
		.parallel-board-layout {
			width: min(100vw, calc(100vw - 16px));
			gap: 14px;
		}

		.parallel-board {
			padding: 78px 18px 28px;
			min-height: 460px;
		}

			.board-controls {
				top: 10px;
				left: 10px;
			}

			.board-overlay-panels {
				top: 10px;
				right: 10px;
				left: 58px;
				flex-direction: column-reverse;
				align-items: flex-end;
			}

			.fetch-mode-panel {
				width: min(360px, 100%);
				max-width: 100%;
				min-width: 0;
			}

			.tree-search-wrap {
				width: min(360px, 100%);
			}

			.board-shortcuts-tooltip {
			left: auto;
			right: 0;
			top: calc(100% + 8px);
			width: min(280px, calc(100vw - 40px));
		}

		.lane-marker {
			width: 72px;
			height: 170px;
		}

		.lane-marker-label {
			font-size: 1.25rem;
		}

		.tree-board-modal-layer {
			padding: 8px;
		}

		.tree-board-modal-header {
			padding: 14px;
			flex-direction: column;
		}

		.tree-board-modal-body {
			padding: 8px;
		}
	}
</style>
