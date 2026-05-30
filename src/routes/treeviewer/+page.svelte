<script lang="ts">
	import { onDestroy, onMount, tick } from 'svelte';
	import { browser } from '$app/environment';
	import '../../app.css';
	import { fetchQuotesForPost, getFullThread, getProfile } from '$lib/api/bluesky';
	import FontPicker from '$lib/components/FontPicker.svelte';
	import GroupChat from '$lib/components/GroupChat.svelte';
	import LoadingSpinner from '$lib/components/LoadingSpinner.svelte';
	import RouteNav from '$lib/components/RouteNav.svelte';
	import ThreadExportButton from '$lib/components/ThreadExportButton.svelte';
	import { openLightbox } from '$lib/stores/lightbox';
	import type { SelfReplyThread, ThreadPost } from '$lib/types';
	import { flattenThreadForChat, type ChatFlatPost } from '$lib/utils/threadFlattener';
	import {
		getAdjacentRecentThreads,
		readRecentThreads,
		rememberRecentThread,
		type RecentThreadEntry
	} from '$lib/utils/recentThreads';
	import { buildAtUri, buildBskyPostUrl, normalizeBskyPostUrl, parseBskyPostUrl } from '$lib/utils/viewerLinks';

	const fontFamilies: Record<string, string> = {
		virgil: "'Virgil', cursive",
		caveat: "'Caveat', cursive",
		patrick: "'Patrick Hand', cursive",
		'comic-neue': "'Comic Neue', cursive",
		inter: "'Inter', sans-serif",
		system: "system-ui, -apple-system, sans-serif"
	};

	type TreeNodeView = {
		post: ThreadPost;
		depth: number;
		isLeaf: boolean;
		hasChildren: boolean;
		isCollapsed: boolean;
		isSelected: boolean;
		isFocused: boolean;
		isInSelectedPath: boolean;
		x: number;
		y: number;
		width?: number;
		height?: number;
	};

	type TreeConnectorView = {
		key: string;
		from: TreeNodeView;
		to: TreeNodeView;
	};

	type TreeLayoutMode = 'vertical' | 'horizontal' | 'radial';
	type TreeViewMode = 'chains' | 'nodes';

	type TreeRenderModel = {
		nodes: TreeNodeView[];
		connectors: TreeConnectorView[];
		width: number;
		height: number;
	};

	type ViewerLane = {
		id: string;
		label: string;
		title: string;
		thread: SelfReplyThread & { isTruncated?: boolean };
		selectedUri: string | null;
		focusedUri: string | null;
		expandedTree: boolean;
		sourceUri?: string;
		sourceLaneId?: string;
		loadedAt: number;
	};

	type TreeLaneRenderModel = {
		lane: ViewerLane;
		model: TreeRenderModel;
		x: number;
		y: number;
		width: number;
		height: number;
		selectedPath: ThreadPost[];
	};

	type QuoteLaneConnectorView = {
		key: string;
		fromLane: TreeLaneRenderModel;
		toLane: TreeLaneRenderModel;
		from: TreeNodeView;
		to: TreeNodeView;
	};

	type MultiLaneTreeModel = {
		lanes: TreeLaneRenderModel[];
		quoteConnectors: QuoteLaneConnectorView[];
		width: number;
		height: number;
	};

	type SelfReplyChainNode = {
		key: string;
		startUri: string;
		targetUri: string;
		postUris: string[];
		authorName: string;
		authorHandle: string;
		count: number;
		depth: number;
		createdAt: string;
		isSelected: boolean;
		isFocused: boolean;
		isInSelectedPath: boolean;
		children: SelfReplyChainNode[];
	};

	type ChainLaneModel = {
		lane: ViewerLane;
		rows: SelfReplyChainNode[];
	};

	type ChatBranchOption = {
		branchUri: string;
		leafUri: string;
		authorName: string;
		authorHandle: string;
		avatar?: string;
		text: string;
		postCount: number;
		longestChainLength: number;
	};

	type ChatScrollRequest = {
		uri: string;
		nonce: number;
	};

	type ChatQuoteOption = {
		uri: string;
		authorName: string;
		authorHandle: string;
		avatar?: string;
		text: string;
		createdAt: string;
		images?: Array<{
			thumb: string;
			fullsize: string;
			alt: string;
		}>;
		isOpen?: boolean;
	};

	type ChatQuoteState = {
		quoteCount: number;
		status: 'idle' | 'loading' | 'ready' | 'error';
		options: ChatQuoteOption[];
		hasMore?: boolean;
		loadedAll?: boolean;
		loadingMode?: 'page' | 'all';
		error?: string;
		quotedRecord?: ChatQuoteOption;
	};

	type QuoteFeedState = {
		status: 'idle' | 'loading' | 'ready' | 'error';
		posts: ThreadPost[];
		hasMore?: boolean;
		loadedAll?: boolean;
		loadingMode?: 'page' | 'all';
		error?: string;
	};

	type TextPanelMode = 'chat' | 'forum';

	type ForumPostGroup = {
		key: string;
		items: ChatFlatPost[];
	};

	const MAIN_LANE_ID = '__main__';
	const TREE_NODE_SIZE = 26;
	const TREE_NODE_WIDTH = TREE_NODE_SIZE;
	const TREE_NODE_HEIGHT = 30;
	const TREE_SLOT_GAP = 44;
	const TREE_DEPTH_GAP = 30;
	const TREE_PADDING = 12;
	const TREE_LANE_GAP = 56;
	const TREE_LANE_HEADER_HEIGHT = 34;
	const TREEVIEWER_PANEL_STATE_MESSAGE = 'atprotocodex:treeviewer:panel-state';

	let fontKey = $state('patrick');
	let fontFamily = $derived(fontFamilies[fontKey] ?? fontFamilies.virgil);
	let urlInput = $state('');
	let loading = $state(false);
	let error: string | null = $state(null);
	let thread = $state<(SelfReplyThread & { isTruncated?: boolean }) | null>(null);
	let selectedUri = $state<string | null>(null);
	let treeViewMode = $state<TreeViewMode>('nodes');
	let treeLayout = $state<TreeLayoutMode>('vertical');
	let radialMinRadius = $state(360);
	let radialMaxRadius = $state(2800);
	let radialDepthGap = $state(128);
	let radialLeafGap = $state(26);
	let radialNodeSize = $state(30);
	let radialStartAngle = $state(270);
	let radialArcSpan = $state(360);
	let radialControlsOpen = $state(false);
	let treeZoom = $state(1);
	let treeCollapsed = $state(false);
	let chatCollapsed = $state(false);
	let splitPercent = $state(72);
	let splitDragging = $state(false);
	let viewerShellElement = $state<HTMLElement | null>(null);
	let treeCanvasElement = $state<HTMLDivElement | null>(null);
	let focusedTreeUri = $state<string | null>(null);
	let chatFontScale = $state(1);
	let textPanelMode = $state<TextPanelMode>('forum');
	let chatScrollNonce = 0;
	let chatScrollRequest = $state<ChatScrollRequest | null>(null);
	let forumScrollElement = $state<HTMLDivElement | null>(null);
	let openForumBranchMenus = $state<Set<string>>(new Set());
	let openForumQuoteMenus = $state<Set<string>>(new Set());
	let activeForumPostUri: string | null = null;
	let activeLaneId = $state(MAIN_LANE_ID);
	let quoteLanes = $state<ViewerLane[]>([]);
	let expandedLaneIds = $state<Set<string>>(new Set([MAIN_LANE_ID]));
	let allReplyLaneIds = $state<Set<string>>(new Set());
	let quoteFeeds = $state<Record<string, QuoteFeedState>>({});
	let quoteLaneLoads = $state<Record<string, boolean>>({});
	let recentThreads = $state<RecentThreadEntry[]>([]);
	let embeddedSection = $state(readEmbeddedSectionParam());
	let embeddedUiCollapsed = $state(false);

	let treeLaneHeaderHeight = $derived(embeddedUiCollapsed ? 0 : TREE_LANE_HEADER_HEIGHT);
	let allLanes = $derived(thread ? buildViewerLanes(thread) : []);
	let activeLane = $derived(allLanes.find((lane) => lane.id === activeLaneId) ?? allLanes[0] ?? null);
	let allRepliesMode = $derived(allReplyLaneIds.has(activeLaneId));
	let selectedPath = $derived(
		activeLane && activeLane.selectedUri ? findPathToUri(activeLane.thread.rootPost, activeLane.selectedUri) : []
	);
	let selectedPathSet = $derived(new Set(selectedPath.map((post) => post.uri)));
	let treeModel = $derived(allLanes.length > 0 ? buildMultiLaneTreeModel(allLanes) : null);
	let chainLaneModels = $derived(allLanes.map(buildChainLaneModel));
	let pathThread = $derived(
		activeLane && selectedPath.length > 0 ? buildPathThread(activeLane.thread, selectedPath) : null
	);
	let allReplyPosts = $derived(activeLane ? collectThreadPosts(activeLane.thread.rootPost) : []);
	let chatThread = $derived(allRepliesMode && activeLane ? activeLane.thread : pathThread);
	let chatBranchOptionsByUri = $derived(buildChatBranchOptionsByUri(selectedPath));
	let chatQuoteStateByUri = $derived(buildChatQuoteStateByUri(selectedPath));
	let visibleChatBranchOptionsByUri = $derived(
		allRepliesMode ? new Map<string, ChatBranchOption[]>() : chatBranchOptionsByUri
	);
	let visibleChatQuoteStateByUri = $derived(
		allRepliesMode ? buildChatQuoteStateByUri(allReplyPosts) : chatQuoteStateByUri
	);
	let forumFlatPosts = $derived(
		allRepliesMode && activeLane
			? flattenThreadForChat(activeLane.thread.rootPost)
			: selectedPath.map(pathPostToChatFlatPost)
	);
	let forumPostGroups = $derived(buildForumPostGroups(forumFlatPosts));
	let selectedSummary = $derived(
		allRepliesMode && allReplyPosts.length > 0
			? `${allReplyPosts.length} post${allReplyPosts.length === 1 ? '' : 's'}`
			: selectedPath.length > 0
			? `${selectedPath.length} post${selectedPath.length === 1 ? '' : 's'}`
			: 'No path selected'
	);
	let treeZoomPercent = $derived(Math.round(treeZoom * 100));
	let chatFontPercent = $derived(Math.round(chatFontScale * 100));
	let recentNavigation = $derived(getAdjacentRecentThreads(recentThreads, urlInput));
	let chatFontStyle = $derived(
		`--chat-author-name-size: ${(0.78 * chatFontScale).toFixed(3)}rem; ` +
			`--chat-author-handle-size: ${(0.66 * chatFontScale).toFixed(3)}rem; ` +
			`--chat-bubble-text-size: ${(0.78 * chatFontScale).toFixed(3)}rem; ` +
			`--chat-timestamp-size: ${(0.58 * chatFontScale).toFixed(3)}rem; ` +
			`--chat-reply-quote-size: ${(0.68 * chatFontScale).toFixed(3)}rem; ` +
			`--chat-branch-toggle-size: ${(0.72 * chatFontScale).toFixed(3)}rem; ` +
			`--chat-branch-header-size: ${(0.74 * chatFontScale).toFixed(3)}rem; ` +
			`--chat-branch-text-size: ${(0.76 * chatFontScale).toFixed(3)}rem; ` +
			`--chat-branch-meta-size: ${(0.68 * chatFontScale).toFixed(3)}rem; ` +
			`--chat-embed-quote-text-size: ${(0.74 * chatFontScale).toFixed(3)}rem;`
	);

	function handleFontChange(key: string) {
		fontKey = key;
		try {
			localStorage.setItem('preferred-font', key);
		} catch {}
	}

	function refreshRecentThreads() {
		if (!browser) return;
		recentThreads = readRecentThreads(localStorage);
	}

	function readEmbeddedSectionParam(): boolean {
		if (!browser || typeof window === 'undefined') return false;
		return new URLSearchParams(window.location.search).get('embed') === 'thread-section';
	}

	function rememberLoadedThread(url: string, loadedThread: SelfReplyThread & { isTruncated?: boolean }) {
		if (!browser) return;
		recentThreads = rememberRecentThread(localStorage, {
			url,
			title: loadedThread.rootPost.text,
			authorHandle: loadedThread.rootPost.author.handle
		});
	}

	function updateQueryParam(url: string) {
		if (!browser) return;
		const current = new URL(window.location.href);
		if (url) {
			current.searchParams.set('url', url);
		} else {
			current.searchParams.delete('url');
		}
		window.history.replaceState({}, '', current.toString());
	}

	function buildViewerLanes(mainThread: SelfReplyThread & { isTruncated?: boolean }): ViewerLane[] {
		return [
			{
				id: MAIN_LANE_ID,
				label: 'Main',
				title: `@${mainThread.rootPost.author.handle}`,
				thread: mainThread,
				selectedUri,
				focusedUri: focusedTreeUri,
				expandedTree: expandedLaneIds.has(MAIN_LANE_ID),
				loadedAt: 0
			},
			...quoteLanes.map((lane, index) => ({
				...lane,
				label: `Q${index + 1}`,
				expandedTree: expandedLaneIds.has(lane.id)
			}))
		];
	}

	function visibleChildren(post: ThreadPost, collapsedUris: Set<string>): ThreadPost[] {
		return collapsedUris.has(post.uri) ? [] : post.children;
	}

	function collectLeafPaths(root: ThreadPost, collapsedUris: Set<string> = new Set()): ThreadPost[][] {
		const paths: ThreadPost[][] = [];
		const longestChainByUri = buildLongestChainLengthMap(root, collapsedUris);

		function walk(node: ThreadPost, path: ThreadPost[]) {
			const nextPath = [...path, node];
			const children = visibleChildren(node, collapsedUris);
			if (children.length === 0) {
				paths.push(nextPath);
				return;
			}

			for (const child of orderedChildren({ ...node, children }, longestChainByUri)) {
				walk(child, nextPath);
			}
		}

		walk(root, []);
		return paths.sort(compareLeafPaths);
	}

	function compareLeafPaths(a: ThreadPost[], b: ThreadPost[]): number {
		const lengthDelta = b.length - a.length;
		if (lengthDelta !== 0) return lengthDelta;

		const aLeafTime = new Date(a[a.length - 1]?.createdAt ?? 0).getTime();
		const bLeafTime = new Date(b[b.length - 1]?.createdAt ?? 0).getTime();
		return aLeafTime - bLeafTime;
	}

	function findPathToUri(root: ThreadPost, uri: string): ThreadPost[] {
		const path: ThreadPost[] = [];

		function walk(node: ThreadPost): boolean {
			path.push(node);
			if (node.uri === uri) return true;

			for (const child of node.children) {
				if (walk(child)) return true;
			}

			path.pop();
			return false;
		}

		return walk(root) ? [...path] : [];
	}

	function findPostByUri(root: ThreadPost, uri: string): ThreadPost | null {
		if (root.uri === uri) return root;

		for (const child of root.children) {
			const found = findPostByUri(child, uri);
			if (found) return found;
		}

		return null;
	}

	function longestLeafUriFrom(post: ThreadPost): string {
		const paths = collectLeafPaths(post);
		const longestPath = paths[0] ?? [post];
		return longestPath[longestPath.length - 1]?.uri ?? post.uri;
	}

	function expandAncestorsForUri(uri: string) {
		void uri;
	}

	function buildLongestChainLengthMap(root: ThreadPost, collapsedUris: Set<string> = new Set()): Map<string, number> {
		const longestChainByUri = new Map<string, number>();

		function measure(post: ThreadPost): number {
			const children = visibleChildren(post, collapsedUris);
			if (children.length === 0) {
				longestChainByUri.set(post.uri, 1);
				return 1;
			}

			const length = 1 + Math.max(...children.map((child) => measure(child)));
			longestChainByUri.set(post.uri, length);
			return length;
		}

		measure(root);
		return longestChainByUri;
	}

	function orderedChildren(post: ThreadPost, longestChainByUri: Map<string, number>): ThreadPost[] {
		return [...post.children].sort((a, b) => {
			const lengthDelta = (longestChainByUri.get(b.uri) ?? 1) - (longestChainByUri.get(a.uri) ?? 1);
			if (lengthDelta !== 0) return lengthDelta;
			return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
		});
	}

	function buildCompactBranchSlotMap(root: ThreadPost, collapsedUris: Set<string>): Map<string, number> {
		const slotByPostUri = new Map<string, number>();
		const leafPaths = collectLeafPaths(root, collapsedUris);
		const bestLeafSlotByPostUri = new Map<string, number>();
		const longestChainByUri = buildLongestChainLengthMap(root, collapsedUris);

		leafPaths.forEach((path, leafSlot) => {
			for (const post of path) {
				const existingSlot = bestLeafSlotByPostUri.get(post.uri);
				if (existingSlot === undefined || leafSlot < existingSlot) {
					bestLeafSlotByPostUri.set(post.uri, leafSlot);
				}
			}
		});

		function assign(post: ThreadPost) {
			slotByPostUri.set(post.uri, bestLeafSlotByPostUri.get(post.uri) ?? 0);

			const children = [...visibleChildren(post, collapsedUris)].sort((a, b) => {
				const slotDelta = (bestLeafSlotByPostUri.get(a.uri) ?? 0) - (bestLeafSlotByPostUri.get(b.uri) ?? 0);
				if (slotDelta !== 0) return slotDelta;

				const lengthDelta =
					(longestChainByUri.get(b.uri) ?? 1) - (longestChainByUri.get(a.uri) ?? 1);
				if (lengthDelta !== 0) return lengthDelta;

				return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
			});

			children.forEach(assign);
		}

		assign(root);
		return slotByPostUri;
	}

	function buildTreeRenderModel(
		root: ThreadPost,
		activeUris: Set<string>,
		activeUri: string | null,
		focusedUri: string | null,
		layout: TreeLayoutMode,
		collapsedUris: Set<string>
	): TreeRenderModel {
		const nodes: TreeNodeView[] = [];
		const nodesByUri = new Map<string, TreeNodeView>();
		const connectors: TreeConnectorView[] = [];
		const slotByPost = buildCompactBranchSlotMap(root, collapsedUris);
		const longestChainByUri = buildLongestChainLengthMap(root, collapsedUris);
		let maxX = 0;
		let maxY = 0;

		if (layout === 'radial') {
			type RadialEntry = {
				post: ThreadPost;
				depth: number;
				parentUri?: string;
				angle: number;
			};

			const subtreeWeightByUri = new Map<string, number>();
			const entries: RadialEntry[] = [];

			function measureVisibleWeight(node: ThreadPost): number {
				const children = orderedChildren(node, longestChainByUri);
				if (children.length === 0) {
					subtreeWeightByUri.set(node.uri, 1);
					return 1;
				}

				const weight = children.reduce((sum, child) => sum + measureVisibleWeight(child), 0);
				subtreeWeightByUri.set(node.uri, Math.max(1, weight));
				return Math.max(1, weight);
			}

			function assignAngles(
				node: ThreadPost,
				depth: number,
				startAngle: number,
				endAngle: number,
				parentUri?: string
			) {
				entries.push({
					post: node,
					depth,
					parentUri,
					angle: startAngle + (endAngle - startAngle) / 2
				});

				const children = orderedChildren(node, longestChainByUri);
				const totalWeight = children.reduce(
					(sum, child) => sum + (subtreeWeightByUri.get(child.uri) ?? 1),
					0
				);
				let cursorAngle = startAngle;

				for (const child of children) {
					const childWeight = subtreeWeightByUri.get(child.uri) ?? 1;
					const span = totalWeight > 0 ? ((endAngle - startAngle) * childWeight) / totalWeight : 0;
					assignAngles(child, depth + 1, cursorAngle, cursorAngle + span, node.uri);
					cursorAngle += span;
				}
			}

			measureVisibleWeight(root);
			const startAngle = (radialStartAngle * Math.PI) / 180;
			const endAngle = startAngle + (radialArcSpan * Math.PI) / 180;
			assignAngles(root, 0, startAngle, endAngle);

			const maxDepth = Math.max(1, ...entries.map((entry) => entry.depth));
			const leafWeight = subtreeWeightByUri.get(root.uri) ?? entries.length;
			const nodeSize = radialNodeSize;
			const diskRadius = Math.max(
				radialMinRadius,
				Math.min(
					radialMaxRadius,
					Math.max(
						maxDepth * radialDepthGap,
						160 + leafWeight * radialLeafGap,
						220 + Math.sqrt(entries.length) * radialDepthGap * 0.72
					)
				)
			);
			const center = TREE_PADDING + diskRadius + nodeSize / 2;
			const canvasSize = TREE_PADDING * 2 + diskRadius * 2 + nodeSize;
			const radialRingGap = Math.max(radialDepthGap, (diskRadius * 0.92) / maxDepth);

			for (const entry of entries) {
				const radius = entry.depth === 0 ? 0 : Math.min(diskRadius * 0.94, radialRingGap * entry.depth);
				const treeX = center + Math.cos(entry.angle) * radius - nodeSize / 2;
				const treeY = center + Math.sin(entry.angle) * radius - nodeSize / 2;
				const viewNode = {
					post: entry.post,
					depth: entry.depth,
					isLeaf: entry.post.children.length === 0,
					hasChildren: entry.post.children.length > 0,
					isCollapsed: false,
					isSelected: entry.post.uri === activeUri,
					isFocused: entry.post.uri === focusedUri,
					isInSelectedPath: activeUris.has(entry.post.uri),
					x: treeX,
					y: treeY,
					width: nodeSize,
					height: nodeSize
				};
				nodes.push(viewNode);
				nodesByUri.set(entry.post.uri, viewNode);
			}

			for (const entry of entries) {
				if (!entry.parentUri) continue;
				const parentView = nodesByUri.get(entry.parentUri);
				const childView = nodesByUri.get(entry.post.uri);
				if (!parentView || !childView) continue;
				connectors.push({
					key: `${entry.parentUri}->${entry.post.uri}`,
					from: parentView,
					to: childView
				});
			}

			return {
				nodes,
				connectors,
				width: canvasSize,
				height: canvasSize
			};
		}

		function walk(node: ThreadPost, depth: number) {
			const isCollapsed = collapsedUris.has(node.uri);
			const children = isCollapsed ? [] : orderedChildren(node, longestChainByUri);
			const slot = slotByPost.get(node.uri) ?? 0;
			const treeX = layout === 'vertical'
				? TREE_PADDING + slot * TREE_SLOT_GAP
				: TREE_PADDING + depth * TREE_DEPTH_GAP;
			const treeY = layout === 'vertical'
				? TREE_PADDING + depth * TREE_DEPTH_GAP
				: TREE_PADDING + slot * TREE_SLOT_GAP;
			const viewNode = {
				post: node,
				depth,
				isLeaf: node.children.length === 0,
				hasChildren: node.children.length > 0,
				isCollapsed,
				isSelected: node.uri === activeUri,
				isFocused: node.uri === focusedUri,
				isInSelectedPath: activeUris.has(node.uri),
				x: treeX,
				y: treeY
			};
			nodes.push(viewNode);
			nodesByUri.set(node.uri, viewNode);
			maxX = Math.max(maxX, treeX + TREE_NODE_WIDTH);
			maxY = Math.max(maxY, treeY + TREE_NODE_HEIGHT);

			for (const child of children) {
				walk(child, depth + 1);
				const childView = nodesByUri.get(child.uri);
				if (childView) {
					connectors.push({
						key: `${node.uri}->${child.uri}`,
						from: viewNode,
						to: childView
					});
				}
			}
		}

		walk(root, 0);
		return {
			nodes,
			connectors,
			width: maxX + TREE_PADDING,
			height: maxY + TREE_PADDING
		};
	}

	function buildMultiLaneTreeModel(lanes: ViewerLane[]): MultiLaneTreeModel {
		const renderedLanes: TreeLaneRenderModel[] = [];
		let nextX = TREE_PADDING;

		for (const lane of lanes) {
			const selectedLanePath = lane.selectedUri ? findPathToUri(lane.thread.rootPost, lane.selectedUri) : [];
			const fallbackPath = selectedLanePath.length > 0 ? selectedLanePath : [lane.thread.rootPost];
			const renderPathSet = new Set(fallbackPath.map((post) => post.uri));
			const model = buildTreeRenderModel(
				lane.thread.rootPost,
				renderPathSet,
				lane.selectedUri,
				lane.focusedUri,
				treeLayout === 'horizontal' ? 'horizontal' : treeLayout,
				new Set()
			);
			const laneWidth = Math.max(model.width, 124);
			const laneHeight = model.height + treeLaneHeaderHeight;

			renderedLanes.push({
				lane,
				model,
				x: nextX,
				y: TREE_PADDING,
				width: laneWidth,
				height: laneHeight,
				selectedPath: fallbackPath
			});

			nextX += laneWidth + TREE_LANE_GAP;
		}

		const laneById = new Map(renderedLanes.map((lane) => [lane.lane.id, lane]));
		const childLanesBySourceId = new Map<string, TreeLaneRenderModel[]>();
		for (const lane of renderedLanes) {
			if (!lane.lane.sourceLaneId) continue;
			const siblings = childLanesBySourceId.get(lane.lane.sourceLaneId) ?? [];
			siblings.push(lane);
			childLanesBySourceId.set(lane.lane.sourceLaneId, siblings);
		}

		function targetNodeForLane(lane: TreeLaneRenderModel): TreeNodeView | undefined {
			return (
				lane.model.nodes.find((node) => node.post.uri === lane.lane.id) ??
				lane.model.nodes.find((node) => node.post.uri === lane.lane.focusedUri) ??
				lane.model.nodes[0]
			);
		}

		const positionedLaneIds = new Set<string>();
		function positionLane(lane: TreeLaneRenderModel) {
			if (positionedLaneIds.has(lane.lane.id)) return;

			if (lane.lane.sourceLaneId && lane.lane.sourceUri) {
				const sourceLane = laneById.get(lane.lane.sourceLaneId);
				if (sourceLane) {
					positionLane(sourceLane);
					const sourceNode = sourceLane.model.nodes.find((node) => node.post.uri === lane.lane.sourceUri);
					const targetNode = targetNodeForLane(lane);
					if (sourceNode && targetNode) {
						const sourceCenterY =
							sourceLane.y + treeLaneHeaderHeight + sourceNode.y + TREE_NODE_SIZE / 2;
						const targetCenterY = treeLaneHeaderHeight + targetNode.y + TREE_NODE_SIZE / 2;
						lane.y = sourceCenterY - targetCenterY;
					}
				}
			}

			positionedLaneIds.add(lane.lane.id);
			for (const childLane of childLanesBySourceId.get(lane.lane.id) ?? []) {
				positionLane(childLane);
			}
		}

		for (const lane of renderedLanes) {
			positionLane(lane);
		}

		const minLaneTop = Math.min(TREE_PADDING, ...renderedLanes.map((lane) => lane.y));
		if (minLaneTop < TREE_PADDING) {
			const yShift = TREE_PADDING - minLaneTop;
			for (const lane of renderedLanes) {
				lane.y += yShift;
			}
		}

		let maxHeight = TREE_PADDING;
		for (const lane of renderedLanes) {
			maxHeight = Math.max(maxHeight, lane.y + lane.height);
		}

		const quoteConnectors: QuoteLaneConnectorView[] = [];

		for (const lane of renderedLanes) {
			if (!lane.lane.sourceUri || !lane.lane.sourceLaneId) continue;
			const sourceLane = laneById.get(lane.lane.sourceLaneId);
			if (!sourceLane) continue;

			const sourceNode = sourceLane.model.nodes.find((node) => node.post.uri === lane.lane.sourceUri);
			const targetNode = targetNodeForLane(lane);
			if (!sourceNode || !targetNode) continue;

			quoteConnectors.push({
				key: `quote:${sourceLane.lane.id}:${sourceNode.post.uri}->${lane.lane.id}`,
				fromLane: sourceLane,
				toLane: lane,
				from: sourceNode,
				to: targetNode
			});
		}

		return {
			lanes: renderedLanes,
			quoteConnectors,
			width: Math.max(TREE_PADDING * 2, nextX - TREE_LANE_GAP + TREE_PADDING),
			height: maxHeight + TREE_PADDING
		};
	}

	function buildSelfReplyLengthMap(root: ThreadPost): Map<string, number> {
		const lengthByUri = new Map<string, number>();

		function measure(post: ThreadPost): number {
			let bestSelfChildLength = 0;
			for (const child of post.children) {
				const childLength = measure(child);
				if (child.author.did === post.author.did) {
					bestSelfChildLength = Math.max(bestSelfChildLength, childLength);
				}
			}

			const length = 1 + bestSelfChildLength;
			lengthByUri.set(post.uri, length);
			return length;
		}

		measure(root);
		return lengthByUri;
	}

	function chooseSelfReplyContinuation(
		post: ThreadPost,
		selfReplyLengthByUri: Map<string, number>
	): ThreadPost | null {
		const candidates = post.children.filter((child) => child.author.did === post.author.did);
		if (candidates.length === 0) return null;

		return [...candidates].sort((a, b) => {
			const lengthDelta = (selfReplyLengthByUri.get(b.uri) ?? 1) - (selfReplyLengthByUri.get(a.uri) ?? 1);
			if (lengthDelta !== 0) return lengthDelta;
			return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
		})[0] ?? null;
	}

	function buildSelfReplyChainNode(
		start: ThreadPost,
		depth: number,
		selectedPathUris: Set<string>,
		selectedUri: string | null,
		focusedUri: string | null,
		selfReplyLengthByUri: Map<string, number>
	): SelfReplyChainNode {
		const posts: ThreadPost[] = [];
		const continuationByParentUri = new Map<string, string>();
		let cursor: ThreadPost | null = start;

		while (cursor) {
			posts.push(cursor);
			const continuation = chooseSelfReplyContinuation(cursor, selfReplyLengthByUri);
			if (!continuation) break;
			continuationByParentUri.set(cursor.uri, continuation.uri);
			cursor = continuation;
		}

		const childStarts: Array<{ post: ThreadPost; parentIndex: number }> = [];
		for (let parentIndex = 0; parentIndex < posts.length; parentIndex += 1) {
			const post = posts[parentIndex];
			const continuationUri = continuationByParentUri.get(post.uri);
			for (const child of post.children) {
				if (child.uri === continuationUri) continue;
				childStarts.push({ post: child, parentIndex });
			}
		}

		childStarts.sort((a, b) => {
			if (a.parentIndex !== b.parentIndex) return a.parentIndex - b.parentIndex;
			const lengthDelta =
				(selfReplyLengthByUri.get(b.post.uri) ?? 1) - (selfReplyLengthByUri.get(a.post.uri) ?? 1);
			if (lengthDelta !== 0) return lengthDelta;
			return new Date(a.post.createdAt).getTime() - new Date(b.post.createdAt).getTime();
		});

		const postUris = posts.map((post) => post.uri);
		const targetUri = postUris[postUris.length - 1] ?? start.uri;
		return {
			key: `${start.uri}->${targetUri}`,
			startUri: start.uri,
			targetUri,
			postUris,
			authorName: authorLabel(start),
			authorHandle: start.author.handle,
			count: posts.length,
			depth,
			createdAt: start.createdAt,
			isSelected: selectedUri ? postUris.includes(selectedUri) : false,
			isFocused: focusedUri ? postUris.includes(focusedUri) : false,
			isInSelectedPath: postUris.some((uri) => selectedPathUris.has(uri)),
			children: childStarts.map((child) =>
				buildSelfReplyChainNode(
					child.post,
					depth + 1,
					selectedPathUris,
					selectedUri,
					focusedUri,
					selfReplyLengthByUri
				)
			)
		};
	}

	function flattenSelfReplyChain(node: SelfReplyChainNode, rows: SelfReplyChainNode[] = []): SelfReplyChainNode[] {
		rows.push(node);
		for (const child of node.children) {
			flattenSelfReplyChain(child, rows);
		}
		return rows;
	}

	function buildChainLaneModel(lane: ViewerLane): ChainLaneModel {
		const selectedLanePath = lane.selectedUri ? findPathToUri(lane.thread.rootPost, lane.selectedUri) : [];
		const fallbackPath = selectedLanePath.length > 0 ? selectedLanePath : [lane.thread.rootPost];
		const selectedPathUris = new Set(fallbackPath.map((post) => post.uri));
		const selfReplyLengthByUri = buildSelfReplyLengthMap(lane.thread.rootPost);
		const root = buildSelfReplyChainNode(
			lane.thread.rootPost,
			0,
			selectedPathUris,
			lane.selectedUri,
			lane.focusedUri,
			selfReplyLengthByUri
		);

		return {
			lane,
			rows: flattenSelfReplyChain(root)
		};
	}

	function buildQuoteConnectorPath(connector: QuoteLaneConnectorView): string {
		const startX = connector.fromLane.x + connector.from.x + (connector.from.width ?? TREE_NODE_SIZE);
		const startY =
			connector.fromLane.y + treeLaneHeaderHeight + connector.from.y + (connector.from.height ?? TREE_NODE_SIZE) / 2;
		const endX = connector.toLane.x + connector.to.x;
		const endY = connector.toLane.y + treeLaneHeaderHeight + connector.to.y + (connector.to.height ?? TREE_NODE_SIZE) / 2;
		const distance = Math.max(32, Math.abs(endX - startX));
		const controlOffset = Math.min(140, distance * 0.55);

		return `M${startX},${startY} C${startX + controlOffset},${startY} ${endX - controlOffset},${endY} ${endX},${endY}`;
	}

	function buildTreeConnectorPath(
		connector: TreeConnectorView,
		layout: TreeLayoutMode = treeLayout
	): string {
		const fromWidth = connector.from.width ?? TREE_NODE_SIZE;
		const fromHeight = connector.from.height ?? TREE_NODE_SIZE;
		const toWidth = connector.to.width ?? TREE_NODE_SIZE;
		const toHeight = connector.to.height ?? TREE_NODE_SIZE;
		const fromX = connector.from.x + fromWidth / 2;
		const fromY = connector.from.y + fromHeight;
		const toX = connector.to.x + toWidth / 2;
		const toY = connector.to.y;

		if (layout === 'radial') {
			const startX = connector.from.x + fromWidth / 2;
			const startY = connector.from.y + fromHeight / 2;
			const endX = connector.to.x + toWidth / 2;
			const endY = connector.to.y + toHeight / 2;
			return `M${startX},${startY} L${endX},${endY}`;
		}

		if (layout === 'horizontal') {
			const startX = connector.from.x + fromWidth;
			const startY = connector.from.y + fromHeight / 2;
			const endX = connector.to.x;
			const endY = connector.to.y + toHeight / 2;
			const middleX = startX + (endX - startX) * 0.5;
			return `M${startX},${startY} C${middleX},${startY} ${middleX},${endY} ${endX},${endY}`;
		}

		const middleY = fromY + (toY - fromY) * 0.5;
		return `M${fromX},${fromY} C${fromX},${middleY} ${toX},${middleY} ${toX},${toY}`;
	}

	function clonePostForPath(post: ThreadPost, parentUri?: string): ThreadPost {
		return {
			...post,
			parentUri,
			children: []
		};
	}

	function buildPathThread(sourceThread: SelfReplyThread, path: ThreadPost[]): SelfReplyThread {
		const root = clonePostForPath(path[0]);
		let cursor = root;

		for (let i = 1; i < path.length; i++) {
			const child = clonePostForPath(path[i], cursor.uri);
			cursor.children = [child];
			cursor = child;
		}

		return {
			rootPost: root,
			rootUri: sourceThread.rootUri,
			depth: Math.max(1, path.length)
		};
	}

	function collectThreadPosts(root: ThreadPost): ThreadPost[] {
		const posts: ThreadPost[] = [];
		function walk(post: ThreadPost) {
			posts.push(post);
			for (const child of post.children) {
				walk(child);
			}
		}
		walk(root);
		return posts;
	}

	function countSubtreePosts(post: ThreadPost): number {
		return 1 + post.children.reduce((total, child) => total + countSubtreePosts(child), 0);
	}

	function buildChatBranchOptionsByUri(path: ThreadPost[]): Map<string, ChatBranchOption[]> {
		const optionsByUri = new Map<string, ChatBranchOption[]>();
		if (path.length === 0) return optionsByUri;

		for (let index = 0; index < path.length; index += 1) {
			const post = path[index];
			const nextPathUri = path[index + 1]?.uri ?? null;
			const alternateReplies = post.children.filter((child) => child.uri !== nextPathUri);
			if (alternateReplies.length === 0) continue;

			const longestChainByUri = buildLongestChainLengthMap(post);
			const options = orderedChildren({ ...post, children: alternateReplies }, longestChainByUri).map((child) => {
				const branchPaths = collectLeafPaths(child);
				const longestBranchPath = branchPaths[0] ?? [child];
				const leaf = longestBranchPath[longestBranchPath.length - 1] ?? child;
				return {
					branchUri: child.uri,
					leafUri: leaf.uri,
					authorName: authorLabel(child),
					authorHandle: child.author.handle,
					avatar: child.author.avatar,
					text: child.text,
					postCount: countSubtreePosts(child),
					longestChainLength: longestBranchPath.length
				};
			});

			optionsByUri.set(post.uri, options);
		}

		return optionsByUri;
	}

	function quoteOptionFromPost(post: ThreadPost): ChatQuoteOption {
		return {
			uri: post.uri,
			authorName: authorLabel(post),
			authorHandle: post.author.handle,
			avatar: post.author.avatar,
			text: post.text,
			createdAt: post.createdAt,
			images: post.embed?.images,
			isOpen: quoteLanes.some((lane) => lane.id === post.uri)
		};
	}

	function buildChatQuoteStateByUri(path: ThreadPost[]): Map<string, ChatQuoteState> {
		const stateByUri = new Map<string, ChatQuoteState>();

		for (const post of path) {
			const feedState = quoteFeeds[post.uri] ?? { status: 'idle', posts: [] };
			const quotedRecord = post.embed?.record
				? {
						uri: post.embed.record.uri,
						authorName: post.embed.record.author.displayName || post.embed.record.author.handle,
						authorHandle: post.embed.record.author.handle,
						avatar: post.embed.record.author.avatar,
						text: post.embed.record.text,
						createdAt: post.embed.record.createdAt,
						images: post.embed.record.images,
						isOpen: quoteLanes.some((lane) => lane.id === post.embed?.record?.uri)
					}
				: undefined;

			if (post.quoteCount <= 0 && feedState.status === 'idle' && !quotedRecord) continue;

			stateByUri.set(post.uri, {
				quoteCount: post.quoteCount,
				status: feedState.status,
				options: feedState.posts.map(quoteOptionFromPost),
				hasMore: feedState.hasMore,
				loadedAll: feedState.loadedAll,
				loadingMode: feedState.loadingMode,
				error: feedState.error,
				quotedRecord
			});
		}

		return stateByUri;
	}

	function updateLaneSelection(laneId: string, nextSelectedUri: string | null, nextFocusedUri = nextSelectedUri) {
		activeLaneId = laneId;
		if (laneId === MAIN_LANE_ID) {
			selectedUri = nextSelectedUri;
			focusedTreeUri = nextFocusedUri;
			return;
		}

		quoteLanes = quoteLanes.map((lane) =>
			lane.id === laneId
				? {
						...lane,
						selectedUri: nextSelectedUri,
						focusedUri: nextFocusedUri
					}
				: lane
		);
	}

	function updateLaneFocus(laneId: string, nextFocusedUri: string | null) {
		if (laneId === MAIN_LANE_ID) {
			focusedTreeUri = nextFocusedUri;
			return;
		}

		quoteLanes = quoteLanes.map((lane) =>
			lane.id === laneId
				? {
						...lane,
						focusedUri: nextFocusedUri
					}
				: lane
		);
	}

	function setActiveLane(laneId: string) {
		activeLaneId = laneId;
		const lane = allLanes.find((candidate) => candidate.id === laneId);
		if (lane?.focusedUri) {
			void tick().then(() => centerTreeNode(lane.focusedUri!, laneId));
		}
	}

	function toggleActiveLaneTree() {
		setAllRepliesForLane(activeLaneId, !allRepliesMode);
	}

	function showAllRepliesForActiveLane() {
		setAllRepliesForLane(activeLaneId, true);
	}

	function setTextPanelMode(mode: TextPanelMode) {
		textPanelMode = mode;
		void tick().then(() => {
			if (mode === 'forum') {
				updateActiveForumPostFromScroll();
			}
		});
	}

	function toggleLaneTree(laneId: string) {
		setLaneTreeExpanded(laneId, !expandedLaneIds.has(laneId));
	}

	function setAllRepliesForLane(laneId: string, enabled: boolean) {
		const lane = allLanes.find((candidate) => candidate.id === laneId);
		const nextAllReplyLaneIds = new Set(allReplyLaneIds);
		if (enabled) {
			nextAllReplyLaneIds.add(laneId);
			setChatCollapsed(false);
		} else {
			nextAllReplyLaneIds.delete(laneId);
			const pathTargetUri = lane?.focusedUri ?? lane?.selectedUri ?? null;
			if (lane && pathTargetUri && findPostByUri(lane.thread.rootPost, pathTargetUri)) {
				updateLaneSelection(laneId, pathTargetUri, pathTargetUri);
			}
		}
		allReplyLaneIds = nextAllReplyLaneIds;
		activeLaneId = laneId;
		void tick().then(() => {
			const updatedLane = allLanes.find((candidate) => candidate.id === laneId);
			if (updatedLane?.focusedUri) centerTreeNode(updatedLane.focusedUri, laneId);
		});
		reportAllRepliesState(enabled);
	}

	function ensurePathOnlyForLane(laneId: string) {
		if (!allReplyLaneIds.has(laneId)) {
			activeLaneId = laneId;
			return;
		}

		const nextAllReplyLaneIds = new Set(allReplyLaneIds);
		nextAllReplyLaneIds.delete(laneId);
		allReplyLaneIds = nextAllReplyLaneIds;
		activeLaneId = laneId;
		reportAllRepliesState(false);
	}

	function reportAllRepliesState(enabled: boolean) {
		if (!browser || !embeddedSection || window.parent === window) return;
		window.parent.postMessage(
			{
				type: TREEVIEWER_PANEL_STATE_MESSAGE,
				allRepliesState: enabled
			},
			window.location.origin
		);
	}

	function reportEmbeddedReady() {
		if (!browser || !embeddedSection || window.parent === window) return;
		window.parent.postMessage(
			{
				type: TREEVIEWER_PANEL_STATE_MESSAGE,
				ready: true
			},
			window.location.origin
		);
	}

	function setLaneTreeExpanded(laneId: string, expanded: boolean) {
		const nextExpanded = new Set(expandedLaneIds);
		if (expanded) {
			nextExpanded.add(laneId);
		} else {
			nextExpanded.delete(laneId);
		}
		expandedLaneIds = nextExpanded;
		activeLaneId = laneId;
		void tick().then(() => {
			const lane = allLanes.find((candidate) => candidate.id === laneId);
			if (lane?.focusedUri) centerTreeNode(lane.focusedUri, laneId);
		});
	}

	function collectQuoteLaneFamily(laneId: string): Set<string> {
		const family = new Set<string>();
		const queue = [laneId];

		for (let index = 0; index < queue.length; index += 1) {
			const currentLaneId = queue[index];
			if (family.has(currentLaneId)) continue;
			family.add(currentLaneId);

			for (const lane of quoteLanes) {
				if (lane.sourceLaneId === currentLaneId) {
					queue.push(lane.id);
				}
			}
		}

		return family;
	}

	function removeQuoteLane(laneId: string) {
		if (laneId === MAIN_LANE_ID) return;
		const lane = quoteLanes.find((candidate) => candidate.id === laneId);
		if (!lane) return;

		const family = collectQuoteLaneFamily(laneId);
		quoteLanes = quoteLanes.filter((candidate) => !family.has(candidate.id));

		const nextExpandedLaneIds = new Set(expandedLaneIds);
		for (const removedLaneId of family) {
			nextExpandedLaneIds.delete(removedLaneId);
		}
		expandedLaneIds = nextExpandedLaneIds;

		const nextAllReplyLaneIds = new Set(allReplyLaneIds);
		for (const removedLaneId of family) {
			nextAllReplyLaneIds.delete(removedLaneId);
		}
		allReplyLaneIds = nextAllReplyLaneIds;

		const nextQuoteLaneLoads = { ...quoteLaneLoads };
		for (const removedLaneId of family) {
			delete nextQuoteLaneLoads[removedLaneId];
		}
		quoteLaneLoads = nextQuoteLaneLoads;

		if (family.has(activeLaneId)) {
			const nextActiveLaneId =
				lane.sourceLaneId && !family.has(lane.sourceLaneId) ? lane.sourceLaneId : MAIN_LANE_ID;
			activeLaneId = nextActiveLaneId;
			void tick().then(() => {
				const nextLane = allLanes.find((candidate) => candidate.id === nextActiveLaneId);
				if (nextLane?.focusedUri) centerTreeNode(nextLane.focusedUri, nextActiveLaneId);
			});
		}
	}

	function pathPostToChatFlatPost(post: ThreadPost): ChatFlatPost {
		return {
			post,
			showAuthorHeader: false,
			replyQuote: null
		};
	}

	function buildForumPostGroups(items: ChatFlatPost[]): ForumPostGroup[] {
		const groups: ForumPostGroup[] = [];

		for (const item of items) {
			const post = item.post;
			const previous = groups[groups.length - 1];
			if (previous && previous.items[0]?.post.author.did === post.author.did) {
				previous.items.push(item);
				continue;
			}

			groups.push({
				key: `${post.uri}:${groups.length}`,
				items: [item]
			});
		}

		return groups;
	}

	function forumBranchOptionsFor(uri: string): ChatBranchOption[] {
		return visibleChatBranchOptionsByUri.get(uri) ?? [];
	}

	function forumQuoteStateFor(uri: string): ChatQuoteState | null {
		return visibleChatQuoteStateByUri.get(uri) ?? null;
	}

	function forumQuoteOptionsFor(uri: string): ChatQuoteOption[] {
		return forumQuoteStateFor(uri)?.options ?? [];
	}

	function toggleForumBranchMenu(uri: string) {
		const next = new Set(openForumBranchMenus);
		if (next.has(uri)) {
			next.delete(uri);
		} else {
			next.add(uri);
		}
		openForumBranchMenus = next;
	}

	function selectForumBranch(parentUri: string, leafUri: string) {
		const next = new Set(openForumBranchMenus);
		next.delete(parentUri);
		openForumBranchMenus = next;
		selectBranchLeaf(leafUri);
	}

	function toggleForumQuoteMenu(uri: string) {
		const next = new Set(openForumQuoteMenus);
		if (next.has(uri)) {
			next.delete(uri);
		} else {
			next.add(uri);
			const state = forumQuoteStateFor(uri);
			if (state && state.status === 'idle' && state.quoteCount > 0) {
				void loadQuotesForChatPost(uri, false);
			}
		}
		openForumQuoteMenus = next;
	}

	function compactPostText(text: string): string {
		const trimmed = text.replace(/\s+/g, ' ').trim();
		return trimmed || 'No text';
	}

	function previewText(text: string, limit = 150): string {
		const trimmed = compactPostText(text);
		return trimmed.length > limit ? `${trimmed.slice(0, limit)}...` : trimmed;
	}

	function formatForumTime(dateStr: string): string {
		const date = new Date(dateStr);
		return date.toLocaleString([], {
			month: 'short',
			day: 'numeric',
			hour: '2-digit',
			minute: '2-digit'
		});
	}

	function forumPostUrl(post: ThreadPost): string | null {
		return buildBskyPostUrl(post.uri, post.author.handle);
	}

	function handleForumRowClick(event: MouseEvent, uri: string) {
		const target = event.target;
		if (
			target instanceof Element &&
			target.closest('a, button, input, textarea, select, details, summary')
		) {
			return;
		}
		focusTreePostFromChat(uri);
	}

	function handleForumRowKeydown(event: KeyboardEvent, uri: string) {
		if (event.currentTarget !== event.target) return;
		if (event.key !== 'Enter' && event.key !== ' ') return;
		event.preventDefault();
		focusTreePostFromChat(uri);
	}

	function handleForumReplyQuoteClick(event: MouseEvent, uri: string) {
		event.stopPropagation();
		focusTreePostFromChat(uri);
		scrollForumPostIntoView(uri);
	}

	function scrollForumPostIntoView(uri: string) {
		if (!forumScrollElement) return;
		const entry = Array.from(
			forumScrollElement.querySelectorAll<HTMLElement>('[data-forum-post-uri]')
		).find((candidate) => candidate.dataset.forumPostUri === uri);

		entry?.scrollIntoView({
			behavior: 'smooth',
			block: 'center'
		});
	}

	function updateActiveForumPostFromScroll() {
		if (!forumScrollElement || textPanelMode !== 'forum') return;

		const containerRect = forumScrollElement.getBoundingClientRect();
		const entries = Array.from(
			forumScrollElement.querySelectorAll<HTMLElement>('[data-forum-post-uri]')
		);
		let bestUri = '';
		let bestDistance = Number.POSITIVE_INFINITY;

		for (const entry of entries) {
			const rect = entry.getBoundingClientRect();
			if (rect.bottom < containerRect.top + 6 || rect.top > containerRect.bottom) continue;
			const distance = Math.abs(rect.top - containerRect.top);
			if (distance < bestDistance) {
				bestDistance = distance;
				bestUri = entry.dataset.forumPostUri ?? '';
			}
		}

		if (bestUri && bestUri !== activeForumPostUri) {
			activeForumPostUri = bestUri;
			focusTreePostFromChat(bestUri);
		}
	}

	function selectPost(uri: string, laneId = activeLaneId) {
		const lane = allLanes.find((candidate) => candidate.id === laneId);
		if (!lane) return;
		if (!findPostByUri(lane.thread.rootPost, uri)) return;
		ensurePathOnlyForLane(laneId);
		expandAncestorsForUri(uri);
		updateLaneSelection(laneId, uri, uri);
		chatScrollRequest = { uri, nonce: ++chatScrollNonce };
		void tick().then(() => {
			centerTreeNode(uri, laneId);
			chatScrollRequest = { uri, nonce: ++chatScrollNonce };
		});
	}

	function selectBranchLeaf(leafUri: string) {
		ensurePathOnlyForLane(activeLaneId);
		expandAncestorsForUri(leafUri);
		updateLaneSelection(activeLaneId, leafUri, leafUri);
		void tick().then(() => centerTreeNode(leafUri, activeLaneId));
	}

	function focusTreePostFromChat(uri: string) {
		expandAncestorsForUri(uri);
		updateLaneFocus(activeLaneId, uri);
		void tick().then(() => centerTreeNode(uri, activeLaneId));
	}

	async function loadQuotesForChatPost(postUri: string, fetchAll = false): Promise<ThreadPost[] | null> {
		const existing = quoteFeeds[postUri];
		if (existing?.status === 'loading') return existing.posts;

		quoteFeeds = {
			...quoteFeeds,
			[postUri]: {
				status: 'loading',
				posts: existing?.posts ?? [],
				hasMore: existing?.hasMore,
				loadedAll: existing?.loadedAll,
				loadingMode: fetchAll ? 'all' : 'page'
			}
		};

		try {
			const result = await fetchQuotesForPost(
				postUri,
				fetchAll ? { limit: 100, fetchAll: true } : { limit: 12 }
			);
			quoteFeeds = {
				...quoteFeeds,
				[postUri]: {
					status: 'ready',
					posts: result.posts,
					hasMore: result.hasMore,
					loadedAll: fetchAll || !result.hasMore
				}
			};
			return result.posts;
		} catch (e: any) {
			quoteFeeds = {
				...quoteFeeds,
				[postUri]: {
					status: 'error',
					posts: existing?.posts ?? [],
					hasMore: existing?.hasMore,
					loadedAll: existing?.loadedAll,
					error: e?.message || 'Could not load quote posts.'
				}
			};
			return null;
		}
	}

	async function openQuoteLane(sourceUri: string, quoteUri: string, quotedHandle: string, options: { focus?: boolean } = {}) {
		const { focus = true } = options;
		const existingLane = quoteLanes.find((lane) => lane.id === quoteUri);
		if (existingLane) {
			if (focus) {
				activeLaneId = existingLane.id;
				void tick().then(() => centerTreeNode(existingLane.focusedUri ?? existingLane.thread.rootPost.uri, existingLane.id));
			}
			return;
		}

		quoteLaneLoads = {
			...quoteLaneLoads,
			[quoteUri]: true
		};

		try {
			const quotedThread = await getFullThread(quoteUri);
			const paths = collectLeafPaths(quotedThread.rootPost);
			const targetPost = findPostByUri(quotedThread.rootPost, quoteUri);
			const defaultLeafUri = targetPost
				? longestLeafUriFrom(targetPost)
				: paths[0]?.[paths[0].length - 1]?.uri ?? quotedThread.rootPost.uri;
			const nextLane: ViewerLane = {
				id: quoteUri,
				label: `Q${quoteLanes.length + 1}`,
				title: `@${quotedThread.rootPost.author.handle || quotedHandle}`,
				thread: quotedThread,
				selectedUri: defaultLeafUri,
				focusedUri: targetPost?.uri ?? quotedThread.rootPost.uri,
				expandedTree: false,
				sourceUri,
				sourceLaneId: activeLaneId,
				loadedAt: Date.now()
			};

			quoteLanes = [...quoteLanes, nextLane];
			if (focus) {
				activeLaneId = nextLane.id;
				chatScrollRequest = { uri: nextLane.focusedUri ?? quotedThread.rootPost.uri, nonce: ++chatScrollNonce };
				await tick();
				centerTreeNode(nextLane.focusedUri ?? quotedThread.rootPost.uri, nextLane.id);
			}
		} catch (e: any) {
			error = e?.message || 'Could not open quoted thread.';
		} finally {
			const nextLoads = { ...quoteLaneLoads };
			delete nextLoads[quoteUri];
			quoteLaneLoads = nextLoads;
		}
	}

	async function selectQuoteFromChat(sourceUri: string, quoteUri: string, quotedHandle: string) {
		await openQuoteLane(sourceUri, quoteUri, quotedHandle);
	}

	async function showAllQuotePosts(sourceUri: string) {
		const posts = await loadQuotesForChatPost(sourceUri, true);
		if (!posts?.length) return;

		for (const post of posts) {
			await openQuoteLane(sourceUri, post.uri, post.author.handle, { focus: false });
		}

		const firstLane = posts.find((post) => quoteLanes.some((lane) => lane.id === post.uri));
		if (firstLane) {
			activeLaneId = firstLane.uri;
			void tick().then(() => centerTreeNode(firstLane.uri, firstLane.uri));
		}
	}

	function centerTreeNode(uri: string, laneId = activeLaneId) {
		if (!treeCanvasElement) return;

		if (treeViewMode === 'chains') {
			const laneModel = chainLaneModels.find((candidate) => candidate.lane.id === laneId);
			const row = laneModel?.rows.find((candidate) => candidate.postUris.includes(uri));
			if (row) {
				const rowElement = Array.from(
					treeCanvasElement.querySelectorAll<HTMLElement>('[data-chain-row-key]')
				).find((candidate) => candidate.dataset.chainRowKey === row.key);
				if (rowElement) {
					rowElement.scrollIntoView({
						behavior: 'smooth',
						block: 'center',
						inline: 'nearest'
					});
					return;
				}
			}
		}

		if (!treeModel) return;
		const laneModel = treeModel.lanes.find((candidate) => candidate.lane.id === laneId);
		const node = laneModel?.model.nodes.find((candidate) => candidate.post.uri === uri);
		if (!node) return;

		const nodeCenterX = ((laneModel?.x ?? 0) + node.x + (node.width ?? TREE_NODE_SIZE) / 2) * treeZoom;
		const nodeCenterY =
			((laneModel?.y ?? 0) + treeLaneHeaderHeight + node.y + (node.height ?? TREE_NODE_SIZE) / 2) * treeZoom;
		treeCanvasElement.scrollTo({
			left: Math.max(0, nodeCenterX - treeCanvasElement.clientWidth / 2),
			top: Math.max(0, nodeCenterY - treeCanvasElement.clientHeight / 2),
			behavior: 'smooth'
		});
	}

	function authorLabel(post: ThreadPost): string {
		return post.author.displayName || post.author.handle;
	}

	function authorInitial(post: ThreadPost): string {
		return authorLabel(post).charAt(0).toUpperCase();
	}

	function avatarColor(did: string): string {
		let hash = 0;
		for (let i = 0; i < did.length; i++) {
			hash = ((hash << 5) - hash + did.charCodeAt(i)) | 0;
		}
		const hue = Math.abs(hash) % 360;
		return `hsl(${hue} 48% 46%)`;
	}

	async function loadThread(bskyUrl: string) {
		const normalizedUrl = normalizeBskyPostUrl(bskyUrl);
		const parsed = normalizedUrl ? parseBskyPostUrl(normalizedUrl) : null;
		if (!normalizedUrl || !parsed) {
			error = 'Invalid URL. Expected format: https://bsky.app/profile/{handle}/post/{rkey}';
			return;
		}

		loading = true;
		error = null;
		thread = null;
		selectedUri = null;
		focusedTreeUri = null;
		activeLaneId = MAIN_LANE_ID;
		quoteLanes = [];
		expandedLaneIds = new Set([MAIN_LANE_ID]);
		allReplyLaneIds = new Set();
		quoteFeeds = {};
		quoteLaneLoads = {};
		urlInput = normalizedUrl;
		updateQueryParam(normalizedUrl);

		try {
			const profile = await getProfile(parsed.handle);
			const atUri = buildAtUri(profile.did, parsed.rkey);
			if (!atUri) {
				error = 'Could not build an AT URI for this thread.';
				return;
			}

			const loadedThread = await getFullThread(atUri);
			thread = loadedThread;
			rememberLoadedThread(normalizedUrl, loadedThread);
			const paths = collectLeafPaths(loadedThread.rootPost);
			const defaultLeafUri = paths[0]?.[paths[0].length - 1]?.uri ?? loadedThread.rootPost.uri;
			selectedUri = defaultLeafUri;
			focusedTreeUri = loadedThread.rootPost.uri;
		} catch (e: any) {
			if (e?.message?.includes('resolve')) {
				error = `Could not find handle "${parsed.handle}".`;
			} else {
				error = e?.message || 'Failed to load thread.';
			}
		} finally {
			loading = false;
		}
	}

	function handleSubmit(e: Event) {
		e.preventDefault();
		if (urlInput.trim()) loadThread(urlInput.trim());
	}

	function setTreeZoom(nextZoom: number) {
		treeZoom = Math.min(1.5, Math.max(0.35, Math.round(nextZoom * 20) / 20));
	}

	function setChatFontScale(nextScale: number) {
		chatFontScale = Math.min(1.45, Math.max(0.75, Math.round(nextScale * 20) / 20));
	}

	function resetRadialControls() {
		radialMinRadius = 360;
		radialMaxRadius = 2800;
		radialDepthGap = 128;
		radialLeafGap = 26;
		radialNodeSize = 30;
		radialStartAngle = 270;
		radialArcSpan = 360;
	}

	function setTreeCollapsed(nextCollapsed: boolean) {
		if (nextCollapsed && chatCollapsed) chatCollapsed = false;
		treeCollapsed = nextCollapsed;
	}

	function setChatCollapsed(nextCollapsed: boolean) {
		if (nextCollapsed && treeCollapsed) treeCollapsed = false;
		chatCollapsed = nextCollapsed;
	}

	function handleEmbeddedPanelStateMessage(event: MessageEvent) {
		if (!embeddedSection || !browser || event.origin !== window.location.origin) return;
		const data = event.data as {
			type?: unknown;
			textPanelMode?: unknown;
			treeCollapsed?: unknown;
			chatCollapsed?: unknown;
			uiCollapsed?: unknown;
			showAllReplies?: unknown;
			allReplies?: unknown;
		};
		if (!data || data.type !== TREEVIEWER_PANEL_STATE_MESSAGE) return;

		const nextTreeCollapsed =
			typeof data.treeCollapsed === 'boolean' ? data.treeCollapsed : treeCollapsed;
		const nextChatCollapsed =
			typeof data.chatCollapsed === 'boolean' ? data.chatCollapsed : chatCollapsed;

		if (nextTreeCollapsed && nextChatCollapsed) {
			setTreeCollapsed(true);
			return;
		}

		setTreeCollapsed(nextTreeCollapsed);
		setChatCollapsed(nextChatCollapsed);
		if (data.textPanelMode === 'chat' || data.textPanelMode === 'forum') {
			setTextPanelMode(data.textPanelMode);
		}
		if (typeof data.uiCollapsed === 'boolean') {
			embeddedUiCollapsed = data.uiCollapsed;
			if (embeddedUiCollapsed) radialControlsOpen = false;
		}

		if (typeof data.allReplies === 'boolean') {
			setAllRepliesForLane(activeLaneId, data.allReplies);
		} else if (data.showAllReplies === true) {
			showAllRepliesForActiveLane();
		}
	}

	function setSplitPercent(nextPercent: number) {
		splitPercent = Math.min(86, Math.max(35, Math.round(nextPercent)));
	}

	function updateSplitFromClientX(clientX: number) {
		if (!viewerShellElement) return;
		const bounds = viewerShellElement.getBoundingClientRect();
		if (bounds.width <= 0) return;
		setSplitPercent(((clientX - bounds.left) / bounds.width) * 100);
	}

	function stopSplitDrag() {
		if (!browser) return;
		splitDragging = false;
		window.removeEventListener('pointermove', handleSplitPointerMove);
		window.removeEventListener('pointerup', stopSplitDrag);
		window.removeEventListener('pointercancel', stopSplitDrag);
		document.body.style.cursor = '';
		document.body.style.userSelect = '';
	}

	function handleSplitPointerMove(event: PointerEvent) {
		updateSplitFromClientX(event.clientX);
	}

	function startSplitDrag(event: PointerEvent) {
		if (treeCollapsed || chatCollapsed) return;
		event.preventDefault();
		splitDragging = true;
		updateSplitFromClientX(event.clientX);
		window.addEventListener('pointermove', handleSplitPointerMove);
		window.addEventListener('pointerup', stopSplitDrag);
		window.addEventListener('pointercancel', stopSplitDrag);
		document.body.style.cursor = 'col-resize';
		document.body.style.userSelect = 'none';
	}

	function handleSplitKeydown(event: KeyboardEvent) {
		if (treeCollapsed || chatCollapsed) return;

		if (event.key === 'ArrowLeft') {
			setSplitPercent(splitPercent - 4);
		} else if (event.key === 'ArrowRight') {
			setSplitPercent(splitPercent + 4);
		} else if (event.key === 'Home') {
			setSplitPercent(35);
		} else if (event.key === 'End') {
			setSplitPercent(86);
		} else {
			return;
		}

		event.preventDefault();
	}

	function handleGlobalKeydown(event: KeyboardEvent) {
		const target = event.target;
		if (
			target instanceof Element &&
			target.closest('input, textarea, select, button, a, [contenteditable="true"]')
		) {
			return;
		}

		if (event.key.toLowerCase() === 't') {
			event.preventDefault();
			toggleActiveLaneTree();
		} else if (event.key.toLowerCase() === 'x' && activeLaneId !== MAIN_LANE_ID) {
			event.preventDefault();
			removeQuoteLane(activeLaneId);
		}
	}

	onMount(() => {
		try {
			refreshRecentThreads();
			const savedFont = localStorage.getItem('preferred-font');
			if (savedFont && savedFont in fontFamilies) fontKey = savedFont;

			const savedLayout = localStorage.getItem('treeviewer-layout');
			if (savedLayout === 'horizontal' || savedLayout === 'vertical' || savedLayout === 'radial') {
				treeLayout = savedLayout;
			}

			const restoreNumber = (key: string, fallback: number, min: number, max: number) => {
				const value = Number(localStorage.getItem(key));
				if (!Number.isFinite(value)) return fallback;
				return Math.min(max, Math.max(min, value));
			};
			radialMinRadius = restoreNumber('treeviewer-radial-min-radius', radialMinRadius, 0, 1600);
			radialMaxRadius = restoreNumber('treeviewer-radial-max-radius', radialMaxRadius, 0, 4200);
			radialDepthGap = restoreNumber('treeviewer-radial-depth-gap', radialDepthGap, 0, 240);
			radialLeafGap = restoreNumber('treeviewer-radial-leaf-gap', radialLeafGap, 0, 80);
			radialNodeSize = restoreNumber('treeviewer-radial-node-size', radialNodeSize, 0, 48);
			const savedStartAngle = Number(localStorage.getItem('treeviewer-radial-start-angle'));
			if (Number.isFinite(savedStartAngle)) {
				radialStartAngle = Math.min(360, Math.max(0, ((savedStartAngle % 360) + 360) % 360));
			}
			radialArcSpan = restoreNumber('treeviewer-radial-arc-span', radialArcSpan, 0, 360);

			const savedTreeZoom = Number(localStorage.getItem('treeviewer-zoom'));
			if (Number.isFinite(savedTreeZoom)) setTreeZoom(savedTreeZoom);

			const savedChatFontScale = Number(localStorage.getItem('treeviewer-chat-font-scale'));
			if (Number.isFinite(savedChatFontScale)) setChatFontScale(savedChatFontScale);

			const savedTextPanelMode = localStorage.getItem('treeviewer-text-panel-mode');
			if (savedTextPanelMode === 'chat' || savedTextPanelMode === 'forum') {
				textPanelMode = savedTextPanelMode;
			}

			const savedSplitPercent = Number(localStorage.getItem('treeviewer-split'));
			if (Number.isFinite(savedSplitPercent)) setSplitPercent(savedSplitPercent);

			const savedTreeCollapsed = localStorage.getItem('treeviewer-tree-collapsed') === '1';
			const savedChatCollapsed = localStorage.getItem('treeviewer-chat-collapsed') === '1';
			if (savedTreeCollapsed !== savedChatCollapsed) {
				treeCollapsed = savedTreeCollapsed;
				chatCollapsed = savedChatCollapsed;
			}
		} catch {}

		const params = new URLSearchParams(window.location.search);
		embeddedSection = params.get('embed') === 'thread-section';
		const viewParam = params.get('view');
		if (viewParam === 'chat' || viewParam === 'forum') {
			textPanelMode = viewParam;
		}
		if (embeddedSection) {
			treeCollapsed = false;
			chatCollapsed = false;
		}
		const urlParam = params.get('url');
		if (urlParam) {
			urlInput = urlParam;
			loadThread(urlParam);
		}

		window.addEventListener('keydown', handleGlobalKeydown);
		window.addEventListener('message', handleEmbeddedPanelStateMessage);
		void tick().then(reportEmbeddedReady);
	});

	$effect(() => {
		if (!browser) return;
		try {
			localStorage.setItem('treeviewer-layout', treeLayout);
			localStorage.setItem('treeviewer-zoom', String(treeZoom));
			localStorage.setItem('treeviewer-chat-font-scale', String(chatFontScale));
			localStorage.setItem('treeviewer-text-panel-mode', textPanelMode);
			localStorage.setItem('treeviewer-split', String(splitPercent));
			localStorage.setItem('treeviewer-tree-collapsed', treeCollapsed ? '1' : '0');
			localStorage.setItem('treeviewer-chat-collapsed', chatCollapsed ? '1' : '0');
			localStorage.setItem('treeviewer-radial-min-radius', String(radialMinRadius));
			localStorage.setItem('treeviewer-radial-max-radius', String(radialMaxRadius));
			localStorage.setItem('treeviewer-radial-depth-gap', String(radialDepthGap));
			localStorage.setItem('treeviewer-radial-leaf-gap', String(radialLeafGap));
			localStorage.setItem('treeviewer-radial-node-size', String(radialNodeSize));
			localStorage.setItem('treeviewer-radial-start-angle', String(radialStartAngle));
			localStorage.setItem('treeviewer-radial-arc-span', String(radialArcSpan));
		} catch {}
	});

	$effect(() => {
		const request = chatScrollRequest;
		if (textPanelMode !== 'forum' || !request?.uri) return;
		void tick().then(() => scrollForumPostIntoView(request.uri));
	});

	$effect(() => {
		selectedPath;
		textPanelMode;
		void tick().then(updateActiveForumPostFromScroll);
	});

	onDestroy(() => {
		stopSplitDrag();
		if (browser) {
			window.removeEventListener('keydown', handleGlobalKeydown);
			window.removeEventListener('message', handleEmbeddedPanelStateMessage);
		}
	});
</script>

<svelte:head>
	<title>Treeviewer</title>
</svelte:head>

<main class:embedded={embeddedSection} style="font-family: {fontFamily}">
	{#if !embeddedSection}
		<header>
			<RouteNav
				current="treeviewer"
				align="center"
				threadUrl={urlInput}
				handle={parseBskyPostUrl(urlInput)?.handle ?? null}
			/>
			<h1>Treeviewer</h1>
			<p class="subtitle">Pick a root-to-leaf path and read it as chat.</p>
			<FontPicker value={fontKey} onchange={handleFontChange} />
		</header>

		<form class="url-form" onsubmit={handleSubmit}>
			<input
				type="text"
				class="url-input wobbly-border-light"
				placeholder="https://bsky.app/profile/handle.bsky.social/post/..."
				bind:value={urlInput}
				disabled={loading}
			/>
			<button type="submit" class="load-btn wobbly-border" disabled={loading || !urlInput.trim()}>
				Load Thread
			</button>
		</form>

		{#if recentThreads.length > 0}
			<nav class="recent-thread-nav" aria-label="Recent Treeviewer threads">
				<a
					class:disabled={!recentNavigation.previous}
					href={recentNavigation.previous ? `?url=${encodeURIComponent(recentNavigation.previous.url)}` : undefined}
					onclick={(event) => {
						if (!recentNavigation.previous) {
							event.preventDefault();
							return;
						}
						event.preventDefault();
						void loadThread(recentNavigation.previous.url);
					}}
				>
					Previous
				</a>
				<span>
					{#if recentNavigation.index >= 0}
						{recentNavigation.index + 1} / {recentThreads.length}
					{:else}
						{recentThreads.length} cached
					{/if}
				</span>
				<a
					class:disabled={!recentNavigation.next}
					href={recentNavigation.next ? `?url=${encodeURIComponent(recentNavigation.next.url)}` : undefined}
					onclick={(event) => {
						if (!recentNavigation.next) {
							event.preventDefault();
							return;
						}
						event.preventDefault();
						void loadThread(recentNavigation.next.url);
					}}
				>
					Next
				</a>
			</nav>
		{/if}
	{/if}

	{#if error && !embeddedSection}
		<div class="error-banner wobbly-border-light">{error}</div>
	{/if}

	{#if loading && !embeddedSection}
		<LoadingSpinner progress={{ phase: 'Loading thread...', current: 0, total: 0 }} />
	{:else if loading && embeddedSection && !thread}
		<section class="viewer-shell embedded-status-shell" aria-label="Thread tree and selected path chat">
			<LoadingSpinner progress={{ phase: 'Loading thread...', current: 0, total: 0 }} />
		</section>
	{:else if error && embeddedSection && !thread}
		<section class="viewer-shell embedded-status-shell" aria-label="Thread tree and selected path chat">
			<div class="error-banner wobbly-border-light">{error}</div>
		</section>
	{/if}

	{#if thread}
		{#if thread.isTruncated && !embeddedSection}
			<p class="truncation-warning">Some replies may be missing</p>
		{/if}

		{#if !embeddedSection}
			<div class="panel-controls" aria-label="Panel visibility controls">
				<button
					type="button"
					class:active={!treeCollapsed}
					aria-pressed={!treeCollapsed}
					onclick={() => setTreeCollapsed(!treeCollapsed)}
				>
					{treeCollapsed ? 'Show tree' : 'Hide tree'}
				</button>
				<button
					type="button"
					class:active={!chatCollapsed}
					aria-pressed={!chatCollapsed}
					onclick={() => setChatCollapsed(!chatCollapsed)}
				>
					{chatCollapsed ? 'Show chat' : 'Hide chat'}
				</button>
				<ThreadExportButton {thread} compact />
			</div>
		{/if}

		<section
			bind:this={viewerShellElement}
			class={`viewer-shell${treeCollapsed ? ' tree-collapsed' : ''}${chatCollapsed ? ' chat-collapsed' : ''}${embeddedUiCollapsed ? ' ui-collapsed' : ''}`}
			style={`--tree-fr: ${splitPercent}fr; --chat-fr: ${100 - splitPercent}fr;`}
			aria-label="Thread tree and selected path chat"
		>
			{#if !treeCollapsed}
				<aside class="tree-panel wobbly-border-light">
					{#if !embeddedUiCollapsed}
						<div class="tree-toolbar">
							<div>
								<h2>Quote lanes</h2>
								<p>{allLanes.length} lane{allLanes.length === 1 ? '' : 's'} · press T for tree</p>
							</div>
							<button
								type="button"
								class="show-replies-btn"
								onclick={() => setAllRepliesForLane(activeLaneId, !allRepliesMode)}
							>
								{allRepliesMode ? 'Path only' : 'Show all replies'}
							</button>
						</div>

						<div class="layout-toggle" aria-label="Tree layout mode">
							<button
								type="button"
								class:active={treeViewMode === 'nodes' && treeLayout === 'vertical'}
								aria-pressed={treeViewMode === 'nodes' && treeLayout === 'vertical'}
								onclick={() => {
									treeViewMode = 'nodes';
									treeLayout = 'vertical';
								}}
							>
								Vertical
							</button>
							<button
								type="button"
								class:active={treeViewMode === 'nodes' && treeLayout === 'horizontal'}
								aria-pressed={treeViewMode === 'nodes' && treeLayout === 'horizontal'}
								onclick={() => {
									treeViewMode = 'nodes';
									treeLayout = 'horizontal';
								}}
							>
								Horizontal
							</button>
							<button
								type="button"
								class:active={treeViewMode === 'nodes' && treeLayout === 'radial'}
								aria-pressed={treeViewMode === 'nodes' && treeLayout === 'radial'}
								onclick={() => {
									treeViewMode = 'nodes';
									treeLayout = 'radial';
								}}
							>
								Radial
							</button>
							<button
								type="button"
								class:active={treeViewMode === 'chains'}
								aria-pressed={treeViewMode === 'chains'}
								onclick={() => {
									treeViewMode = 'chains';
									radialControlsOpen = false;
								}}
							>
								Chains
							</button>
						</div>

						{#if treeViewMode === 'nodes'}
							<div class="zoom-controls" aria-label="Tree zoom controls">
								<button type="button" class="zoom-btn" onclick={() => setTreeZoom(treeZoom - 0.1)} disabled={treeZoom <= 0.35}>
									-
								</button>
								<input
									type="range"
									min="35"
									max="150"
									step="5"
									value={treeZoomPercent}
									aria-label="Tree zoom"
									oninput={(event) => setTreeZoom(Number(event.currentTarget.value) / 100)}
								/>
								<button type="button" class="zoom-btn" onclick={() => setTreeZoom(treeZoom + 0.1)} disabled={treeZoom >= 1.5}>
									+
								</button>
								<button type="button" class="zoom-reset" onclick={() => setTreeZoom(1)}>
									{treeZoomPercent}%
								</button>
							</div>
						{/if}
					{/if}

					<div class="tree-canvas-wrap">
						{#if treeViewMode === 'nodes' && treeLayout === 'radial' && !embeddedUiCollapsed}
							<div class="radial-control-dock" class:open={radialControlsOpen}>
								<button
									type="button"
									class="radial-control-toggle"
									aria-expanded={radialControlsOpen}
									onclick={() => (radialControlsOpen = !radialControlsOpen)}
								>
									{radialControlsOpen ? 'Close knobs' : 'Radial knobs'}
								</button>
								{#if radialControlsOpen}
									<div class="radial-controls" aria-label="Radial layout controls">
										<label>
											<span>Min radius <strong>{radialMinRadius}px</strong></span>
											<input
												type="range"
												min="0"
												max="1600"
												step="20"
												value={radialMinRadius}
												oninput={(event) => (radialMinRadius = Number(event.currentTarget.value))}
											/>
										</label>
										<label>
											<span>Max radius <strong>{radialMaxRadius}px</strong></span>
											<input
												type="range"
												min="0"
												max="4200"
												step="50"
												value={radialMaxRadius}
												oninput={(event) => (radialMaxRadius = Number(event.currentTarget.value))}
											/>
										</label>
										<label>
											<span>Depth gap <strong>{radialDepthGap}px</strong></span>
											<input
												type="range"
												min="0"
												max="240"
												step="4"
												value={radialDepthGap}
												oninput={(event) => (radialDepthGap = Number(event.currentTarget.value))}
											/>
										</label>
										<label>
											<span>Leaf spread <strong>{radialLeafGap}px</strong></span>
											<input
												type="range"
												min="0"
												max="80"
												step="2"
												value={radialLeafGap}
												oninput={(event) => (radialLeafGap = Number(event.currentTarget.value))}
											/>
										</label>
										<label>
											<span>Node size <strong>{radialNodeSize}px</strong></span>
											<input
												type="range"
												min="0"
												max="48"
												step="1"
												value={radialNodeSize}
												oninput={(event) => (radialNodeSize = Number(event.currentTarget.value))}
											/>
										</label>
										<label>
											<span>Start angle <strong>{radialStartAngle}°</strong></span>
											<input
												type="range"
												min="0"
												max="360"
												step="5"
												value={radialStartAngle}
												oninput={(event) => (radialStartAngle = Number(event.currentTarget.value))}
											/>
										</label>
										<label>
											<span>Arc span <strong>{radialArcSpan}°</strong></span>
											<input
												type="range"
												min="0"
												max="360"
												step="5"
												value={radialArcSpan}
												oninput={(event) => (radialArcSpan = Number(event.currentTarget.value))}
											/>
										</label>
										<button type="button" class="radial-reset" onclick={resetRadialControls}>
											Reset radial
										</button>
									</div>
								{/if}
							</div>
						{/if}
						<div
							bind:this={treeCanvasElement}
							class="tree-canvas"
							class:horizontal={treeViewMode === 'nodes' && treeLayout === 'horizontal'}
							class:vertical={treeViewMode === 'nodes' && treeLayout === 'vertical'}
							class:radial={treeViewMode === 'nodes' && treeLayout === 'radial'}
							class:chains={treeViewMode === 'chains'}
						>
							{#if treeViewMode === 'chains'}
								<div class="chain-outline-stage">
									{#each chainLaneModels as laneModel (laneModel.lane.id)}
										<section
											class="chain-lane-outline"
											class:active-lane={laneModel.lane.id === activeLaneId}
											aria-label={`${laneModel.lane.label} self-reply chains`}
										>
											{#if !embeddedUiCollapsed}
												<div class="chain-lane-header">
													<button
														type="button"
														class="tree-lane-title"
														onclick={() => setActiveLane(laneModel.lane.id)}
													>
														<span>{laneModel.lane.label}</span>
														<strong>{laneModel.lane.title}</strong>
													</button>
													<button
														type="button"
														class="tree-lane-tree-toggle"
														title={allReplyLaneIds.has(laneModel.lane.id) ? 'Return this lane to the selected path' : 'Show all replies in this lane'}
														onclick={(event) => {
															event.stopPropagation();
															setAllRepliesForLane(laneModel.lane.id, !allReplyLaneIds.has(laneModel.lane.id));
														}}
													>
														{allReplyLaneIds.has(laneModel.lane.id) ? 'Path' : 'All replies'}
													</button>
													{#if laneModel.lane.id !== MAIN_LANE_ID}
														<button
															type="button"
															class="tree-lane-close"
															title="Remove quoted lane"
															aria-label={`Remove ${laneModel.lane.label} quoted lane`}
															onclick={(event) => {
																event.stopPropagation();
																removeQuoteLane(laneModel.lane.id);
															}}
														>
															x
														</button>
													{/if}
												</div>
											{/if}
											<div class="chain-outline-list">
												{#each laneModel.rows as row (row.key)}
													<button
														type="button"
														class="chain-row"
														class:active={row.isSelected}
														class:focused={row.isFocused}
														class:on-path={row.isInSelectedPath}
														style={`--chain-depth: ${row.depth};`}
														data-chain-row-key={row.key}
														aria-label={`${row.count} post${row.count === 1 ? '' : 's'} by ${row.authorName}`}
														aria-current={row.isSelected ? 'true' : undefined}
														title={`${row.count} post${row.count === 1 ? '' : 's'} by @${row.authorHandle}`}
														onclick={() => selectPost(row.targetUri, laneModel.lane.id)}
													>
														<span class="chain-count">{row.count}</span>
														<span class="chain-author">{row.authorName}</span>
													</button>
												{/each}
											</div>
										</section>
									{/each}
								</div>
							{:else if treeModel}
								<div
									class="tree-stage"
									style={`width: ${treeModel.width * treeZoom}px; height: ${treeModel.height * treeZoom}px;`}
								>
									<div
										class="tree-scale-layer"
										style={`width: ${treeModel.width}px; height: ${treeModel.height}px; transform: scale(${treeZoom});`}
									>
										<svg
											class="tree-quote-connectors"
											viewBox={`0 0 ${treeModel.width} ${treeModel.height}`}
											aria-hidden="true"
										>
											{#each treeModel.quoteConnectors as connector (connector.key)}
												<path
													d={buildQuoteConnectorPath(connector)}
													class:active={connector.toLane.lane.id === activeLaneId || connector.fromLane.lane.id === activeLaneId}
												></path>
											{/each}
										</svg>

										{#each treeModel.lanes as laneRender (laneRender.lane.id)}
											<div
												class="tree-lane"
												class:active-lane={laneRender.lane.id === activeLaneId}
												style={`left: ${laneRender.x}px; top: ${laneRender.y}px; width: ${laneRender.width}px; height: ${laneRender.height}px;`}
											>
												{#if !embeddedUiCollapsed}
													<div class="tree-lane-marker">
														<button
															type="button"
															class="tree-lane-title"
															onclick={() => setActiveLane(laneRender.lane.id)}
														>
															<span>{laneRender.lane.label}</span>
															<strong>{laneRender.lane.title}</strong>
														</button>
														<button
															type="button"
										class="tree-lane-tree-toggle"
										title={allReplyLaneIds.has(laneRender.lane.id) ? 'Return this lane to the selected path' : 'Show all replies in this lane'}
										onclick={(event) => {
											event.stopPropagation();
											setAllRepliesForLane(laneRender.lane.id, !allReplyLaneIds.has(laneRender.lane.id));
										}}
									>
										{allReplyLaneIds.has(laneRender.lane.id) ? 'Path' : 'All replies'}
									</button>
														{#if laneRender.lane.id !== MAIN_LANE_ID}
															<button
																type="button"
																class="tree-lane-close"
																title="Remove quoted lane"
																aria-label={`Remove ${laneRender.lane.label} quoted lane`}
																onclick={(event) => {
																	event.stopPropagation();
																	removeQuoteLane(laneRender.lane.id);
																}}
															>
																x
															</button>
														{/if}
													</div>
												{/if}
												<div
													class="tree-lane-body"
													style={`top: ${treeLaneHeaderHeight}px; width: ${laneRender.model.width}px; height: ${laneRender.model.height}px;`}
												>
													<svg
														class="tree-connectors"
														viewBox={`0 0 ${laneRender.model.width} ${laneRender.model.height}`}
														aria-hidden="true"
													>
														{#each laneRender.model.connectors as connector (connector.key)}
															<path
																d={buildTreeConnectorPath(connector, treeLayout)}
																class:on-path={connector.from.isInSelectedPath && connector.to.isInSelectedPath}
															></path>
														{/each}
													</svg>

													{#each laneRender.model.nodes as node (node.post.uri)}
														<button
															type="button"
															class="tree-node"
															class:active={node.isSelected}
															class:on-path={node.isInSelectedPath}
															class:leaf={node.isLeaf}
															class:focused={node.isFocused}
															class:radial-node={treeLayout === 'radial'}
															style={`--node-size: ${node.width ?? TREE_NODE_SIZE}px; left: ${node.x}px; top: ${node.y}px; width: ${node.width ?? TREE_NODE_SIZE}px; height: ${node.height ?? TREE_NODE_SIZE}px;`}
															aria-label={`${authorLabel(node.post)}${node.isLeaf ? ', leaf' : ''}`}
															aria-current={node.isSelected ? 'true' : undefined}
															onclick={() => selectPost(node.post.uri, laneRender.lane.id)}
														>
															{#if node.post.author.avatar}
																<img src={node.post.author.avatar} alt="" class="node-avatar" />
															{:else}
																<span class="node-avatar placeholder" style={`background: ${avatarColor(node.post.author.did)}`}>
																	{authorInitial(node.post)}
																</span>
															{/if}
															{#if node.isLeaf}
																<span class="leaf-dot" aria-hidden="true"></span>
															{/if}
														</button>
													{/each}
												</div>
											</div>
										{/each}
									</div>
								</div>
							{/if}
						</div>
					</div>
				</aside>
			{/if}

			{#if !treeCollapsed && !chatCollapsed && !embeddedUiCollapsed}
				<button
					type="button"
					class="splitter"
					class:dragging={splitDragging}
					aria-label={`Resize tree and chat panels, tree ${splitPercent}%`}
					onpointerdown={startSplitDrag}
					onkeydown={handleSplitKeydown}
				>
					<span aria-hidden="true"></span>
				</button>
			{/if}

			{#if !chatCollapsed}
				<div class="chat-panel">
					{#if !embeddedUiCollapsed}
						<div class="chat-panel-title">
							<span>{activeLane?.label ?? 'Lane'} · {allRepliesMode ? 'all replies' : 'selected path'}</span>
							<span>{selectedSummary}</span>
						</div>
						<div class="chat-font-controls" aria-label="Chat font size controls">
							<div class="text-mode-toggle" aria-label="Text view mode">
								<button
									type="button"
									class:active={textPanelMode === 'chat'}
									aria-pressed={textPanelMode === 'chat'}
									onclick={() => setTextPanelMode('chat')}
								>
									Chat
								</button>
								<button
									type="button"
									class:active={textPanelMode === 'forum'}
									aria-pressed={textPanelMode === 'forum'}
									onclick={() => setTextPanelMode('forum')}
								>
									Forum
								</button>
							</div>
							<button type="button" class="chat-tree-btn" onclick={toggleActiveLaneTree}>
								{allRepliesMode ? 'Path only' : 'Show all replies'} T
							</button>
							<span>Text</span>
							<button
								type="button"
								class="chat-font-btn"
								onclick={() => setChatFontScale(chatFontScale - 0.1)}
								disabled={chatFontScale <= 0.75}
							>
								-
							</button>
							<input
								type="range"
								min="75"
								max="145"
								step="5"
								value={chatFontPercent}
								aria-label="Chat font size"
								oninput={(event) => setChatFontScale(Number(event.currentTarget.value) / 100)}
							/>
							<button
								type="button"
								class="chat-font-btn"
								onclick={() => setChatFontScale(chatFontScale + 0.1)}
								disabled={chatFontScale >= 1.45}
							>
								+
							</button>
							<button type="button" class="chat-font-reset" onclick={() => setChatFontScale(1)}>
								{chatFontPercent}%
							</button>
						</div>
					{/if}
					{#if chatThread && textPanelMode === 'chat'}
						<div class="chat-font-scope" style={chatFontStyle}>
							<GroupChat
								thread={chatThread}
								fullHeight
								showExport={false}
								branchOptionsByUri={visibleChatBranchOptionsByUri}
								quoteStateByUri={visibleChatQuoteStateByUri}
								scrollToPostRequest={chatScrollRequest}
								onbranchselect={selectBranchLeaf}
								onquoteload={loadQuotesForChatPost}
								onquoteselect={selectQuoteFromChat}
								onquoteall={showAllQuotePosts}
								onpostselect={focusTreePostFromChat}
								onactivepostchange={focusTreePostFromChat}
							/>
						</div>
					{/if}
					{#if textPanelMode === 'forum'}
						<div
							bind:this={forumScrollElement}
							class="forum-thread"
							style={chatFontStyle}
							onscroll={updateActiveForumPostFromScroll}
						>
							{#each forumPostGroups as group (group.key)}
								{@const firstItem = group.items[0]}
								{@const firstPost = firstItem.post}
								<div
									class="forum-post"
									class:focused={group.items.some((item) => activeLane?.focusedUri === item.post.uri)}
								>
									<div class="forum-main">
										<div class="forum-meta">
											{#if firstPost.author.avatar}
												<img src={firstPost.author.avatar} alt="" class="forum-avatar" />
											{:else}
												<span class="forum-avatar placeholder" style={`background: ${avatarColor(firstPost.author.did)}`}>
													{authorInitial(firstPost)}
												</span>
											{/if}
											<strong>{authorLabel(firstPost)}</strong>
											<span>@{firstPost.author.handle}</span>
											<span>{formatForumTime(firstPost.createdAt)}</span>
										</div>
										<div class="forum-chain">
											{#each group.items as item (item.post.uri)}
												{@const post = item.post}
												{@const branchOptions = forumBranchOptionsFor(post.uri)}
												{@const quoteState = forumQuoteStateFor(post.uri)}
												{@const quoteOptions = forumQuoteOptionsFor(post.uri)}
												{@const bskyPostUrl = forumPostUrl(post)}
												<div
													class="forum-subpost"
													class:focused={activeLane?.focusedUri === post.uri}
													data-forum-post-uri={post.uri}
													role="button"
													tabindex="0"
													aria-label="Center this post in the tree"
													onclick={(event) => handleForumRowClick(event, post.uri)}
													onkeydown={(event) => handleForumRowKeydown(event, post.uri)}
												>
													{#if item.replyQuote}
														{@const replyQuote = item.replyQuote}
														{@const replyQuoteColor = avatarColor(replyQuote.author.did)}
														<button
															type="button"
															class="forum-reply-quote"
															style={`border-left-color: ${replyQuoteColor}`}
															onclick={(event) => handleForumReplyQuoteClick(event, replyQuote.uri)}
														>
															<span class="forum-reply-quote-author" style={`color: ${replyQuoteColor}`}>
																{replyQuote.author.displayName || replyQuote.author.handle}
															</span>
															<span>{previewText(replyQuote.text, 120)}</span>
														</button>
													{/if}
													<p class="forum-text">{compactPostText(post.text)}</p>
													{#if post.embed?.images?.length}
														<div class="forum-media-grid">
															{#each post.embed.images as image (image.fullsize)}
																<button
																	type="button"
																	class="forum-media-button"
																	onclick={(event) => {
																		event.stopPropagation();
																		openLightbox(image.fullsize, image.alt);
																	}}
																>
																	<img src={image.thumb} alt={image.alt} />
																</button>
															{/each}
														</div>
													{/if}
													{#if post.embed?.record}
														<div class="forum-inline-quote">
															<span>Quoted @{post.embed.record.author.handle}</span>
															<p>{compactPostText(post.embed.record.text)}</p>
															{#if post.embed.record.images?.length}
																<div class="forum-media-grid quote-media">
																	{#each post.embed.record.images as image (image.fullsize)}
																		<button
																			type="button"
																			class="forum-media-button"
																			onclick={(event) => {
																				event.stopPropagation();
																				openLightbox(image.fullsize, image.alt);
																			}}
																		>
																			<img src={image.thumb} alt={image.alt} />
																		</button>
																	{/each}
																</div>
															{/if}
														</div>
													{/if}
													<div class="forum-actions">
														{#if branchOptions.length > 0}
															<button
																type="button"
																class="forum-action-btn"
																aria-expanded={openForumBranchMenus.has(post.uri)}
																onclick={(event) => {
																	event.stopPropagation();
																	toggleForumBranchMenu(post.uri);
																}}
															>
																<span aria-hidden="true">{openForumBranchMenus.has(post.uri) ? '-' : '+'}</span>
																{branchOptions.length} repl{branchOptions.length === 1 ? 'y' : 'ies'}
															</button>
														{/if}
														{#if quoteState}
															<button
																type="button"
																class="forum-action-btn quote"
																aria-expanded={openForumQuoteMenus.has(post.uri)}
																onclick={(event) => {
																	event.stopPropagation();
																	toggleForumQuoteMenu(post.uri);
																}}
															>
																Q {quoteState.quoteCount > 0 ? quoteState.quoteCount : ''}
															</button>
														{/if}
														{#if bskyPostUrl}
															<a
																href={bskyPostUrl}
																target="_blank"
																rel="noopener noreferrer"
																class="forum-open-link"
																onclick={(event) => event.stopPropagation()}
															>
																Open
															</a>
														{/if}
													</div>

													{#if openForumBranchMenus.has(post.uri) && branchOptions.length > 0}
														<div class="forum-branch-list">
															{#each branchOptions as option (option.branchUri)}
																<button
																	type="button"
																	class="forum-branch-row"
																	onclick={(event) => {
																		event.stopPropagation();
																		selectForumBranch(post.uri, option.leafUri);
																	}}
																>
																	<strong>@{option.authorHandle}</strong>
																	<span>{option.postCount} posts · longest {option.longestChainLength}</span>
																	<p>{previewText(option.text, 130)}</p>
																</button>
															{/each}
														</div>
													{/if}

													{#if openForumQuoteMenus.has(post.uri) && quoteState}
														<div class="forum-quote-box">
															<div class="forum-quote-actions">
																{#if quoteState.quotedRecord}
																	<button
																		type="button"
																		class="forum-action-btn"
																		onclick={(event) => {
																			event.stopPropagation();
																			const quotedRecord = quoteState.quotedRecord;
																			if (!quotedRecord) return;
																			selectQuoteFromChat(
																				post.uri,
																				quotedRecord.uri,
																				quotedRecord.authorHandle
																			);
																		}}
																	>
																		Open quoted post
																	</button>
																{/if}
																{#if quoteState.quoteCount > 0}
																	<button
																		type="button"
																		class="forum-action-btn"
																		disabled={quoteState.status === 'loading'}
																		onclick={(event) => {
																			event.stopPropagation();
																			void loadQuotesForChatPost(post.uri, false);
																		}}
																	>
																		{quoteState.status === 'loading' && quoteState.loadingMode !== 'all'
																			? 'Loading...'
																			: quoteState.status === 'ready'
																				? 'Refresh'
																				: 'Load quotes'}
																	</button>
																	<button
																		type="button"
																		class="forum-action-btn primary"
																		disabled={quoteState.status === 'loading'}
																		onclick={(event) => {
																			event.stopPropagation();
																			void showAllQuotePosts(post.uri);
																		}}
																	>
																		{quoteState.status === 'loading' && quoteState.loadingMode === 'all'
																			? 'Showing...'
																			: 'Show all'}
																	</button>
																{/if}
															</div>
															{#if quoteState.status === 'error'}
																<p class="forum-status error">{quoteState.error || 'Could not load quote posts.'}</p>
															{:else if quoteOptions.length > 0}
																<div class="forum-quote-list">
																	{#each quoteOptions as option (option.uri)}
																		<button
																			type="button"
																			class="forum-quote-row"
																			class:open={option.isOpen}
																			onclick={(event) => {
																				event.stopPropagation();
																				selectQuoteFromChat(post.uri, option.uri, option.authorHandle);
																			}}
																		>
																			<strong>@{option.authorHandle}</strong>
																			<span>{option.isOpen ? 'Jump to lane' : 'Create lane'}</span>
																			<p>{compactPostText(option.text)}</p>
																			{#if option.images?.length}
																				<div class="forum-media-grid quote-media">
																					{#each option.images as image (image.fullsize)}
																						<span class="forum-media-thumb">
																							<img src={image.thumb} alt={image.alt} />
																						</span>
																					{/each}
																				</div>
																			{/if}
																		</button>
																	{/each}
																</div>
															{:else if quoteState.status === 'loading'}
																<p class="forum-status">Loading quote posts...</p>
															{:else}
																<p class="forum-status">Load quote posts to choose lanes.</p>
															{/if}
														</div>
													{/if}
												</div>
											{/each}
										</div>
									</div>
								</div>
							{/each}
						</div>
					{/if}
				</div>
			{/if}
		</section>
	{/if}
</main>

<style>
	main {
		--tv-border: var(--control-border);
		--tv-border-strong: var(--control-border-hover);
		--tv-panel-bg: color-mix(in srgb, var(--card-bg) 94%, transparent);
		--tv-surface: color-mix(in srgb, var(--card-bg) 88%, var(--muted-surface));
		--tv-surface-muted: color-mix(in srgb, var(--muted-surface) 76%, var(--card-bg));
		--tv-surface-hover: var(--control-bg-hover);
		--tv-active-bg: var(--active-bg);
		--tv-info-bg: color-mix(in srgb, var(--accent) 15%, var(--card-bg));
		--tv-info-text: var(--accent);
		--tv-shadow: var(--shadow-soft);
		--tv-outline-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 18%, transparent);
		--tv-muted-line: color-mix(in srgb, var(--text-ink) 12%, transparent);
		--tv-line: color-mix(in srgb, var(--text-ink) 18%, transparent);
		--tv-strong-line: color-mix(in srgb, var(--text-ink) 28%, transparent);
		--tv-on-accent: var(--accent-contrast);
		width: min(1480px, 100%);
		margin: 0 auto;
		padding: 32px 20px;
	}

	main.embedded {
		width: 100%;
		height: 100vh;
		margin: 0;
		padding: 0;
		overflow: hidden;
	}

	main button,
	main input,
	main a {
		font-family: inherit;
		letter-spacing: 0;
	}

	header {
		text-align: center;
		margin: 0 auto 24px;
		max-width: 1200px;
	}

	h1 {
		font-size: 2rem;
		color: var(--text-ink);
		margin: 8px 0 4px;
	}

	.subtitle {
		color: var(--muted);
		font-size: 1rem;
	}

	.url-form {
		display: flex;
		gap: 10px;
		max-width: 680px;
		margin: 0 auto 24px;
	}

	.url-input {
		flex: 1;
		min-width: 0;
		padding: 10px 14px;
		font-size: 0.95rem;
		font-family: inherit;
		background: var(--card-bg);
		color: var(--text-ink);
	}

	.url-input::placeholder {
		color: var(--muted);
		opacity: 0.7;
	}

	.load-btn {
		padding: 10px 20px;
		font-size: 0.95rem;
		background: var(--accent);
		color: var(--tv-on-accent);
		border-color: var(--border-color);
		cursor: pointer;
		white-space: nowrap;
		transition: opacity 0.2s;
	}

	.load-btn:hover:not(:disabled) {
		opacity: 0.85;
	}

	.load-btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.recent-thread-nav {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 10px;
		max-width: 680px;
		margin: -10px auto 24px;
		color: var(--muted);
		font-size: 0.9rem;
	}

	.recent-thread-nav a {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-width: 88px;
		padding: 7px 12px;
		border: 1px solid var(--control-border);
		border-radius: 6px;
		background: var(--control-bg);
		color: var(--text-ink);
		font-weight: 750;
		text-decoration: none;
	}

	.recent-thread-nav a:hover:not(.disabled) {
		background: var(--control-bg-hover);
	}

	.recent-thread-nav a.disabled {
		opacity: 0.45;
		pointer-events: none;
	}

	.error-banner {
		max-width: 680px;
		margin: 0 auto 16px;
		padding: 10px 16px;
		background: var(--error-bg);
		color: var(--danger-text);
		text-align: center;
		font-size: 0.95rem;
	}

	.truncation-warning {
		background: var(--warning-bg);
		color: var(--text-ink);
		border: 1px solid color-mix(in srgb, var(--accent) 36%, var(--control-border));
		border-radius: 6px;
		padding: 6px 12px;
		font-size: 0.85rem;
		margin: 0 auto 12px;
		text-align: center;
		max-width: 680px;
	}

	.panel-controls {
		display: flex;
		justify-content: flex-end;
		gap: 6px;
		margin: 0 0 10px;
	}

	.panel-controls button {
		min-height: 28px;
		border: 1px solid var(--tv-border);
		border-radius: 6px;
		background: var(--control-bg);
		color: var(--muted);
		font-size: 0.74rem;
		font-weight: 800;
		padding: 0 10px;
	}

	.panel-controls button.active {
		background: var(--card-bg);
		color: var(--text-ink);
		box-shadow: var(--shadow-soft);
	}

	.viewer-shell {
		--panel-height: calc(100vh - 32px);
		display: grid;
		grid-template-columns: minmax(220px, var(--tree-fr, 72fr)) 12px minmax(250px, var(--chat-fr, 28fr));
		gap: 8px;
		align-items: stretch;
	}

	.viewer-shell.tree-collapsed {
		grid-template-columns: minmax(0, 1fr);
		justify-content: stretch;
	}

	.viewer-shell.chat-collapsed {
		grid-template-columns: minmax(0, 1fr);
	}

	main.embedded .viewer-shell {
		--panel-height: 100vh;
		height: 100vh;
		gap: 6px;
	}

	main.embedded .viewer-shell.ui-collapsed:not(.tree-collapsed):not(.chat-collapsed) {
		grid-template-columns: minmax(220px, var(--tree-fr, 72fr)) minmax(250px, var(--chat-fr, 28fr));
		gap: 4px;
	}

	main.embedded .embedded-status-shell {
		display: grid;
		place-items: center;
		padding: 12px;
		box-sizing: border-box;
	}

	main.embedded .tree-panel,
	main.embedded .chat-panel {
		position: sticky;
		top: 0;
		border-radius: 0;
		box-shadow: none;
	}

	main.embedded .viewer-shell.ui-collapsed .tree-panel {
		padding: 0;
	}

	main.embedded .viewer-shell.ui-collapsed .tree-canvas {
		border-radius: 0;
		background: var(--tv-surface-muted);
	}

	main.embedded .tree-toolbar {
		flex-wrap: wrap;
	}

	main.embedded .tree-toolbar > div {
		flex: 1 1 180px;
		min-width: 0;
	}

	main.embedded .show-replies-btn {
		flex: 1 1 120px;
		white-space: normal;
	}

	main.embedded .chat-font-controls {
		grid-template-columns: auto auto minmax(64px, 1fr) auto auto;
	}

	main.embedded .text-mode-toggle {
		grid-column: 1 / span 2;
	}

	main.embedded .chat-tree-btn {
		grid-column: 3 / -1;
		width: 100%;
	}

	.splitter {
		align-self: stretch;
		width: 12px;
		min-height: var(--panel-height);
		display: grid;
		place-items: center;
		border: 0;
		border-radius: 999px;
		background: transparent;
		cursor: col-resize;
		padding: 0;
		touch-action: none;
	}

	.splitter span {
		width: 4px;
		height: 68px;
		border-radius: 999px;
		background: var(--tv-strong-line);
		box-shadow:
			0 0 0 1px color-mix(in srgb, var(--card-bg) 82%, transparent),
			var(--tv-shadow);
		transition:
			background 0.16s ease,
			height 0.16s ease,
			width 0.16s ease;
	}

	.splitter:hover span,
	.splitter:focus-visible span,
	.splitter.dragging span {
		width: 5px;
		height: 104px;
		background: var(--accent);
	}

	.splitter:focus-visible {
		outline: 2px solid color-mix(in srgb, var(--accent) 34%, transparent);
		outline-offset: 3px;
	}

	.tree-panel {
		position: sticky;
		top: 16px;
		height: var(--panel-height);
		min-height: 0;
		display: flex;
		flex-direction: column;
		overflow: hidden;
		background: var(--tv-panel-bg);
		padding: 10px;
		box-sizing: border-box;
		box-shadow: var(--tv-shadow);
	}

	.tree-toolbar {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 8px;
		margin-bottom: 8px;
	}

	h2 {
		font-size: 0.84rem;
		font-weight: 600;
		line-height: 1.1;
		margin: 0 0 2px;
	}

	.tree-toolbar p {
		color: var(--muted);
		font-size: 0.7rem;
		line-height: 1.25;
	}

	.show-replies-btn {
		flex: 0 0 auto;
		min-height: 28px;
		border: 1px solid color-mix(in srgb, var(--accent) 28%, var(--tv-border));
		border-radius: 6px;
		background: var(--tv-info-bg);
		color: var(--tv-info-text);
		padding: 0 9px;
		font-size: 0.66rem;
		font-weight: 900;
		white-space: nowrap;
	}

	.layout-toggle {
		display: grid;
		grid-template-columns: repeat(4, minmax(0, 1fr));
		gap: 4px;
		margin-bottom: 8px;
		padding: 2px;
		border: 1px solid var(--tv-border);
		border-radius: 8px;
		background: var(--tv-surface-muted);
	}

	.layout-toggle button {
		min-height: 26px;
		border: 0;
		border-radius: 5px;
		background: transparent;
		color: var(--muted);
		font-size: 0.64rem;
		font-weight: 800;
		padding: 0 3px;
	}

	.layout-toggle button.active {
		background: var(--card-bg);
		color: var(--text-ink);
		box-shadow: var(--shadow-soft);
	}

	.radial-controls {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 7px;
		margin: 7px 0 0;
		padding: 8px;
		border: 1px solid var(--tv-border);
		border-radius: 8px;
		background: var(--tv-panel-bg);
	}

	.radial-controls label {
		display: grid;
		gap: 3px;
		min-width: 0;
		color: var(--muted);
		font-size: 0.62rem;
		font-weight: 800;
	}

	.radial-controls label span {
		display: flex;
		justify-content: space-between;
		gap: 6px;
		line-height: 1.1;
	}

	.radial-controls strong {
		color: var(--text-ink);
		font-size: 0.6rem;
		white-space: nowrap;
	}

	.radial-controls input[type='range'] {
		width: 100%;
		accent-color: var(--accent);
	}

	.radial-reset {
		grid-column: 1 / -1;
		min-height: 24px;
		border: 1px solid var(--tv-border);
		border-radius: 5px;
		background: var(--control-bg);
		color: var(--text-ink);
		font-size: 0.64rem;
		font-weight: 900;
	}

	.radial-control-dock {
		position: absolute;
		top: 8px;
		right: 8px;
		z-index: 12;
		width: max-content;
		max-width: min(340px, calc(100% - 16px));
		padding: 3px;
		border: 1px solid var(--tv-border);
		border-radius: 9px;
		background: color-mix(in srgb, var(--card-bg) 88%, transparent);
		box-shadow: var(--shadow-medium);
		backdrop-filter: blur(8px);
	}

	.radial-control-dock.open {
		width: min(340px, calc(100% - 16px));
		max-height: calc(100% - 16px);
		overflow: auto;
	}

	.radial-control-toggle {
		width: 100%;
		min-height: 26px;
		border: 0;
		border-radius: 6px;
		background: var(--tv-surface-muted);
		color: var(--text-ink);
		font-size: 0.66rem;
		font-weight: 900;
		padding: 0 9px;
		white-space: nowrap;
	}

	.radial-control-toggle:hover {
		background: var(--control-bg-hover);
	}

	.zoom-controls {
		display: grid;
		grid-template-columns: auto minmax(0, 1fr) auto auto;
		align-items: center;
		gap: 5px;
		margin-bottom: 8px;
	}

	.zoom-controls input[type='range'] {
		width: 100%;
		accent-color: var(--accent);
	}

	.zoom-btn,
	.zoom-reset {
		min-height: 26px;
		border: 1px solid var(--tv-border);
		border-radius: 5px;
		background: var(--control-bg);
		color: var(--text-ink);
		font-size: 0.68rem;
		font-weight: 800;
	}

	.zoom-btn {
		width: 28px;
	}

	.zoom-reset {
		min-width: 44px;
		padding: 0 6px;
	}

	.tree-canvas-wrap {
		flex: 1 1 auto;
		min-height: 0;
		position: relative;
		display: flex;
	}

	.tree-canvas {
		flex: 1 1 auto;
		min-width: 0;
		min-height: 0;
		overflow: auto;
		border-radius: 7px;
		background: var(--tv-surface-muted);
	}

	.tree-canvas.radial {
		background: var(--tv-surface-muted);
	}

	.tree-canvas.chains {
		padding: 10px;
		box-sizing: border-box;
		background: var(--card-bg);
	}

	.chain-outline-stage {
		min-width: max-content;
		display: flex;
		align-items: flex-start;
		gap: 28px;
	}

	.chain-lane-outline {
		min-width: 220px;
		padding: 2px 0 14px;
		border-radius: 8px;
	}

	.chain-lane-outline.active-lane {
		background: color-mix(in srgb, var(--accent) 8%, transparent);
		box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 16%, transparent);
	}

	.chain-lane-header {
		display: flex;
		align-items: center;
		gap: 5px;
		margin-bottom: 8px;
		padding: 0 2px;
	}

	.chain-outline-list {
		display: grid;
		gap: 0;
		padding: 0 2px;
	}

	.chain-row {
		--chain-depth: 0;
		width: max-content;
		min-width: 132px;
		display: flex;
		align-items: baseline;
		gap: 7px;
		margin-left: calc(var(--chain-depth) * 22px);
		padding: 1px 8px 1px 0;
		border: 0;
		border-radius: 5px;
		background: transparent;
		color: var(--muted);
		font-size: 1.05rem;
		font-weight: 650;
		line-height: 1.3;
		text-align: left;
		cursor: pointer;
	}

	.chain-row:hover,
	.chain-row:focus-visible {
		background: var(--tv-surface-hover);
		color: var(--text-ink);
		outline: none;
	}

	.chain-row.on-path {
		color: color-mix(in srgb, var(--text-ink) 72%, var(--muted));
	}

	.chain-row.focused {
		color: var(--text-ink);
		box-shadow: inset 3px 0 0 color-mix(in srgb, var(--accent) 58%, var(--tv-border));
	}

	.chain-row.active {
		color: var(--text-ink);
		font-weight: 900;
	}

	.chain-count {
		min-width: 2.2ch;
		text-align: right;
		font-variant-numeric: tabular-nums;
		font-weight: 850;
	}

	.chain-author {
		white-space: nowrap;
	}

	.tree-stage {
		position: relative;
		min-width: 100%;
		min-height: 0;
	}

	.tree-scale-layer {
		position: absolute;
		left: 0;
		top: 0;
		transform-origin: top left;
	}

	.tree-lane {
		position: absolute;
		z-index: 2;
		border-radius: 9px;
		background: color-mix(in srgb, var(--card-bg) 56%, transparent);
	}

	.tree-lane.active-lane {
		background: color-mix(in srgb, var(--accent) 12%, var(--card-bg));
		box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 22%, transparent);
	}

	.tree-lane-marker {
		position: absolute;
		left: 0;
		top: 0;
		width: 100%;
		height: 28px;
		display: flex;
		align-items: center;
		gap: 5px;
	}

	.tree-lane-title {
		min-width: 0;
		flex: 1 1 auto;
		height: 28px;
		display: flex;
		align-items: center;
		gap: 5px;
		border: 1px solid var(--tv-border);
		border-radius: 999px;
		background: var(--control-bg);
		color: var(--text-ink);
		padding: 2px 8px;
		box-shadow: var(--shadow-soft);
	}

	.tree-lane-title span {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-width: 28px;
		height: 18px;
		border-radius: 999px;
		background: var(--accent);
		color: var(--tv-on-accent);
		font-size: 0.62rem;
		font-weight: 900;
		line-height: 1;
	}

	.tree-lane-title strong {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 0.68rem;
	}

	.tree-lane-tree-toggle {
		flex: 0 0 auto;
		height: 26px;
		border: 1px solid var(--tv-border);
		border-radius: 999px;
		background: var(--control-bg);
		color: var(--text-ink);
		font-size: 0.62rem;
		font-weight: 900;
		padding: 0 8px;
	}

	.tree-lane-close {
		flex: 0 0 auto;
		width: 26px;
		height: 26px;
		display: grid;
		place-items: center;
		border: 1px solid var(--tv-border);
		border-radius: 999px;
		background: var(--control-bg);
		color: var(--muted);
		padding: 0;
		font-size: 0.72rem;
		font-weight: 900;
		line-height: 1;
	}

	.tree-lane-tree-toggle:hover,
	.tree-lane-title:hover,
	.tree-lane-close:hover {
		border-color: var(--tv-border-strong);
	}

	.tree-lane-close:hover {
		background: var(--active-bg);
		color: var(--text-ink);
	}

	.tree-lane-body {
		position: absolute;
		left: 0;
	}

	.tree-canvas.radial .tree-lane {
		background: transparent;
	}

	.tree-canvas.radial .tree-lane-body::before {
		content: '';
		position: absolute;
		inset: 12px;
		z-index: 0;
		border-radius: 50%;
		border: 1px solid var(--tv-border);
		background:
			repeating-radial-gradient(
				circle,
				transparent 0,
				transparent 72px,
				var(--tv-muted-line) 73px,
				var(--tv-muted-line) 74px
			);
		pointer-events: none;
	}

	.tree-quote-connectors {
		position: absolute;
		inset: 0;
		z-index: 1;
		width: 100%;
		height: 100%;
		overflow: visible;
		pointer-events: none;
	}

	.tree-quote-connectors path {
		fill: none;
		stroke: var(--accent);
		stroke-width: 2.1;
		stroke-linecap: round;
		stroke-dasharray: 5 5;
		opacity: 0.72;
		filter: drop-shadow(0 2px 2px color-mix(in srgb, var(--card-bg) 68%, transparent));
	}

	.tree-quote-connectors path.active {
		stroke: color-mix(in srgb, var(--accent) 72%, #c28cff);
		stroke-width: 2.7;
		opacity: 0.92;
		stroke-dasharray: none;
	}

	.tree-connectors {
		position: absolute;
		inset: 0;
		z-index: 1;
		width: 100%;
		height: 100%;
		overflow: visible;
		color: var(--tv-strong-line);
		pointer-events: none;
	}

	.tree-connectors path {
		fill: none;
		stroke: currentColor;
		stroke-width: 1.4;
		stroke-linecap: round;
	}

	.tree-connectors path.on-path {
		color: var(--accent);
		stroke-width: 2;
	}

	.tree-canvas.radial .tree-connectors path {
		stroke-width: 1.45;
		opacity: 0.84;
	}

	.tree-canvas.radial .tree-connectors path.on-path {
		opacity: 1;
		stroke-width: 2.4;
	}

	.tree-node {
		--node-size: 26px;
		position: absolute;
		z-index: 2;
		min-width: 0;
		width: var(--node-size);
		height: var(--node-size);
		display: grid;
		place-items: center;
		border: 1px solid var(--tv-border);
		border-radius: 999px;
		background: var(--control-bg);
		color: var(--text-ink);
		padding: 0;
		text-align: left;
		box-shadow: var(--shadow-soft);
		transition:
			background 0.16s ease,
			border-color 0.16s ease,
			box-shadow 0.16s ease;
	}

	.tree-node:hover {
		background: var(--control-bg-hover);
		border-color: var(--tv-border-strong);
	}

	.tree-node.on-path {
		background: var(--active-bg);
		border-color: var(--tv-border-strong);
	}

	.tree-node.active {
		background: var(--active-bg);
		border-color: var(--tv-border-strong);
		box-shadow: var(--tv-outline-shadow), var(--shadow-soft);
	}

	.tree-node.focused {
		border-color: var(--tv-strong-line);
		box-shadow: 0 0 0 3px color-mix(in srgb, var(--text-ink) 12%, transparent), var(--shadow-soft);
	}

	.tree-node.radial-node {
		min-width: 0;
		border-color: var(--tv-border);
		box-shadow: var(--shadow-soft);
	}

	.node-avatar {
		display: block;
		width: calc(var(--node-size) - 2px);
		height: calc(var(--node-size) - 2px);
		border-radius: 50%;
		object-fit: cover;
		border: 2px solid color-mix(in srgb, var(--card-bg) 88%, transparent);
		box-shadow: var(--shadow-soft);
	}

	.node-avatar.placeholder {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		color: var(--tv-on-accent);
		font-size: 0.66rem;
		font-weight: 800;
	}

	.leaf-dot {
		position: absolute;
		right: -2px;
		bottom: -2px;
		width: 5px;
		height: 5px;
		border-radius: 50%;
		background: var(--accent);
		opacity: 0.76;
	}

	.tree-node:not(.leaf) .leaf-dot {
		opacity: 0;
	}

	.chat-panel {
		min-width: 0;
		position: sticky;
		top: 16px;
		height: var(--panel-height);
		min-height: 0;
		display: flex;
		flex-direction: column;
		overflow: hidden;
		box-sizing: border-box;
	}

	.chat-panel-title {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		margin-bottom: 6px;
		color: var(--muted);
		font-size: 0.68rem;
		font-weight: 800;
		text-transform: uppercase;
	}

	.chat-panel-title span:last-child {
		text-transform: none;
		white-space: nowrap;
	}

	.chat-font-controls {
		display: grid;
		grid-template-columns: auto auto auto auto minmax(0, 1fr) auto auto;
		align-items: center;
		gap: 5px;
		margin-bottom: 8px;
		color: var(--muted);
		font-size: 0.68rem;
		font-weight: 800;
	}

	.chat-font-controls input[type='range'] {
		width: 100%;
		accent-color: var(--accent);
	}

	.text-mode-toggle {
		display: inline-grid;
		grid-template-columns: 1fr 1fr;
		gap: 2px;
		padding: 2px;
		border: 1px solid var(--tv-border);
		border-radius: 7px;
		background: var(--tv-surface-muted);
	}

	.text-mode-toggle button {
		min-height: 22px;
		border: 0;
		border-radius: 5px;
		background: transparent;
		color: var(--muted);
		font-size: 0.64rem;
		font-weight: 900;
		padding: 0 7px;
	}

	.text-mode-toggle button.active {
		background: var(--card-bg);
		color: var(--text-ink);
		box-shadow: var(--shadow-soft);
	}

	.text-mode-toggle button:disabled {
		opacity: 0.42;
		cursor: not-allowed;
	}

	.chat-font-btn,
	.chat-font-reset,
	.chat-tree-btn {
		min-height: 24px;
		border: 1px solid var(--tv-border);
		border-radius: 5px;
		background: var(--control-bg);
		color: var(--text-ink);
		font-size: 0.66rem;
		font-weight: 800;
	}

	.chat-tree-btn {
		padding: 0 8px;
		background: var(--tv-info-bg);
		color: var(--tv-info-text);
		border-color: color-mix(in srgb, var(--accent) 28%, var(--tv-border));
	}

	.chat-font-btn {
		width: 26px;
	}

	.chat-font-reset {
		min-width: 44px;
		padding: 0 6px;
	}

	.chat-font-scope {
		flex: 1 1 auto;
		min-height: 0;
		display: flex;
	}

	.forum-thread {
		flex: 1 1 auto;
		min-height: 0;
		overflow: auto;
		border: 1px solid var(--tv-border);
		border-radius: 8px;
		background: var(--tv-panel-bg);
		padding: 6px;
		box-sizing: border-box;
	}

	.forum-post {
		border-bottom: 1px solid var(--tv-muted-line);
		padding: 4px 3px;
	}

	.forum-post:last-child {
		border-bottom: 0;
	}

	.forum-post.focused {
		background: var(--tv-active-bg);
	}

	.forum-main {
		min-width: 0;
	}

	.forum-meta {
		display: flex;
		align-items: center;
		gap: 5px;
		min-width: 0;
		color: var(--muted);
		font-size: calc(var(--chat-author-handle-size, 0.66rem) * 0.95);
		line-height: 1.15;
	}

	.forum-avatar {
		width: 18px;
		height: 18px;
		flex: 0 0 auto;
		border-radius: 50%;
		object-fit: cover;
		border: 1px solid color-mix(in srgb, var(--card-bg) 86%, transparent);
		box-shadow: var(--shadow-soft);
	}

	.forum-avatar.placeholder {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		color: var(--tv-on-accent);
		font-size: 0.58rem;
		font-weight: 900;
	}

	.forum-meta strong {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: var(--text-ink);
		font-size: calc(var(--chat-author-name-size, 0.78rem) * 0.96);
	}

	.forum-meta span {
		white-space: nowrap;
	}

	.forum-chain {
		margin-top: 2px;
	}

	.forum-subpost {
		position: relative;
		padding: 2px 3px 2px 0;
		border-top: 1px solid var(--tv-muted-line);
		cursor: pointer;
	}

	.forum-subpost:first-child {
		border-top: 0;
	}

	.forum-subpost:hover,
	.forum-subpost:focus-visible {
		background: var(--tv-surface);
		outline: none;
	}

	.forum-subpost.focused {
		background: var(--tv-active-bg);
	}

	.forum-text {
		margin: 0;
		color: var(--text-ink);
		font-size: calc(var(--chat-bubble-text-size, 0.78rem) * 0.9);
		line-height: 1.18;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}

	.forum-reply-quote {
		display: block;
		width: 100%;
		margin: 2px 0 4px;
		padding: 4px 6px;
		border: 1px solid var(--tv-border);
		border-left: 3px solid var(--tv-strong-line);
		border-radius: 5px;
		background: var(--control-bg);
		color: var(--muted);
		font: inherit;
		font-size: calc(var(--chat-reply-quote-size, 0.68rem) * 0.95);
		line-height: 1.18;
		text-align: left;
		cursor: pointer;
	}

	.forum-reply-quote:hover,
	.forum-reply-quote:focus-visible {
		background: var(--tv-info-bg);
		outline: none;
	}

	.forum-reply-quote-author {
		display: block;
		margin-bottom: 1px;
		font-weight: 850;
	}

	.forum-inline-quote {
		margin-top: 3px;
		border-left: 2px solid color-mix(in srgb, var(--accent) 55%, var(--tv-border));
		background: var(--tv-info-bg);
		padding: 2px 5px;
	}

	.forum-inline-quote span {
		display: block;
		color: var(--tv-info-text);
		font-size: calc(var(--chat-timestamp-size, 0.58rem) * 1.02);
		font-weight: 900;
	}

	.forum-inline-quote p {
		margin: 1px 0 0;
		color: var(--muted);
		font-size: calc(var(--chat-reply-quote-size, 0.68rem) * 0.92);
		line-height: 1.2;
	}

	.forum-media-grid {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
		margin-top: 4px;
	}

	.forum-media-grid.quote-media {
		margin-top: 3px;
	}

	.forum-media-button,
	.forum-media-thumb {
		width: 82px;
		height: 82px;
		display: block;
		overflow: hidden;
		border: 1px solid var(--tv-border);
		border-radius: 5px;
		background: var(--control-bg);
		padding: 0;
	}

	.forum-media-button img,
	.forum-media-thumb img {
		width: 100%;
		height: 100%;
		display: block;
		object-fit: cover;
	}

	.forum-quote-row .forum-media-grid {
		grid-column: 1 / -1;
	}

	.forum-actions,
	.forum-quote-actions {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 4px;
		margin-top: 3px;
	}

	.forum-action-btn,
	.forum-open-link {
		min-height: 21px;
		border: 1px solid var(--tv-border);
		border-radius: 5px;
		background: var(--control-bg);
		color: var(--text-ink);
		padding: 0 6px;
		font-size: calc(var(--chat-branch-toggle-size, 0.72rem) * 0.82);
		font-weight: 900;
		line-height: 19px;
		text-decoration: none;
	}

	.forum-open-link {
		margin-left: auto;
	}

	.forum-action-btn.quote {
		background: var(--tv-info-bg);
		color: var(--tv-info-text);
		border-color: color-mix(in srgb, var(--accent) 28%, var(--tv-border));
	}

	.forum-action-btn.primary {
		background: var(--accent);
		color: var(--tv-on-accent);
		border-color: color-mix(in srgb, var(--accent) 54%, var(--tv-border));
	}

	.forum-action-btn:disabled {
		opacity: 0.58;
		cursor: not-allowed;
	}

	.forum-branch-list,
	.forum-quote-box {
		margin-top: 5px;
		border: 1px solid var(--tv-border);
		border-radius: 6px;
		background: var(--tv-surface-muted);
		padding: 4px;
	}

	.forum-branch-row,
	.forum-quote-row {
		width: 100%;
		display: grid;
		grid-template-columns: minmax(0, auto) auto;
		gap: 2px 6px;
		border: 0;
		border-bottom: 1px solid var(--tv-muted-line);
		background: transparent;
		color: var(--text-ink);
		padding: 4px;
		text-align: left;
	}

	.forum-branch-row:last-child,
	.forum-quote-row:last-child {
		border-bottom: 0;
	}

	.forum-branch-row:hover,
	.forum-quote-row:hover,
	.forum-quote-row.open {
		background: var(--control-bg-hover);
	}

	.forum-branch-row strong,
	.forum-quote-row strong {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: calc(var(--chat-branch-header-size, 0.74rem) * 0.9);
	}

	.forum-branch-row span,
	.forum-quote-row span {
		justify-self: end;
		color: var(--muted);
		font-size: calc(var(--chat-branch-meta-size, 0.68rem) * 0.86);
		font-weight: 800;
		white-space: nowrap;
	}

	.forum-branch-row p,
	.forum-quote-row p {
		grid-column: 1 / -1;
		margin: 0;
		color: var(--muted);
		font-size: calc(var(--chat-branch-text-size, 0.76rem) * 0.86);
		line-height: 1.18;
	}

	.forum-quote-list {
		max-height: 220px;
		overflow: auto;
		margin-top: 4px;
	}

	.forum-status {
		margin: 5px 2px 2px;
		color: var(--muted);
		font-size: calc(var(--chat-branch-meta-size, 0.68rem) * 0.9);
		font-weight: 800;
	}

	.forum-status.error {
		color: var(--danger-text);
	}

	.chat-panel :global(.group-chat) {
		flex: 1 1 auto;
		height: 100%;
		min-height: 0;
		max-height: none;
		padding: 10px 8px;
		border-radius: 8px;
		box-sizing: border-box;
	}

	.chat-panel :global(.group-chat.full-height) {
		max-height: none;
	}

	.chat-panel :global(.chat-message) {
		padding-left: 36px;
		margin-bottom: 1px;
	}

	.chat-panel :global(.author-header) {
		gap: 6px;
		margin-left: -36px;
		margin-bottom: 1px;
	}

	.chat-panel :global(.author-avatar),
	.chat-panel :global(.author-avatar-placeholder) {
		width: 25px;
		height: 25px;
	}

	.chat-panel :global(.author-name) {
		font-size: var(--chat-author-name-size, 0.78rem);
	}

	.chat-panel :global(.author-handle) {
		font-size: var(--chat-author-handle-size, 0.66rem);
	}

	.chat-panel :global(.bubble) {
		max-width: 100%;
		padding: 0 8px;
		border-radius: 0 7px 7px 7px;
	}

	.chat-panel :global(.bubble-entry) {
		padding: 5px 0;
	}

	.chat-panel :global(.bubble-text) {
		font-size: var(--chat-bubble-text-size, 0.78rem);
		line-height: 1.32;
	}

	.chat-panel :global(.timestamp) {
		font-size: var(--chat-timestamp-size, 0.58rem);
	}

	.chat-panel :global(.reply-quote) {
		max-width: 100%;
		font-size: var(--chat-reply-quote-size, 0.68rem);
	}

	.chat-panel :global(.branch-picker-toggle) {
		font-size: var(--chat-branch-toggle-size, 0.72rem);
	}

	.chat-panel :global(.branch-option-header) {
		font-size: var(--chat-branch-header-size, 0.74rem);
	}

	.chat-panel :global(.branch-option-text) {
		font-size: var(--chat-branch-text-size, 0.76rem);
	}

	.chat-panel :global(.branch-option-meta) {
		font-size: var(--chat-branch-meta-size, 0.68rem);
	}

	.chat-panel :global(.embed-image) {
		width: min(100%, 330px);
		max-width: 330px;
		max-height: 330px;
	}

	.chat-panel :global(.embed-video video) {
		width: 100%;
		max-height: 330px;
	}

	.chat-panel :global(.embed-link) {
		align-items: stretch;
	}

	.chat-panel :global(.embed-link-thumb) {
		width: 86px;
		height: 86px;
	}

	.chat-panel :global(.embed-quote) {
		padding: 7px 8px;
	}

	.chat-panel :global(.embed-quote-text) {
		font-size: var(--chat-embed-quote-text-size, 0.74rem);
	}

	@media (max-width: 820px) {
		main {
			padding: 22px 12px;
		}

		.url-form {
			flex-direction: column;
		}

		.load-btn {
			width: 100%;
		}

		.viewer-shell {
			grid-template-columns: 1fr;
		}

		.viewer-shell.tree-collapsed {
			grid-template-columns: 1fr;
			justify-content: stretch;
		}

		.splitter {
			display: none;
		}

		.tree-panel,
		.chat-panel {
			position: static;
			height: auto;
			max-height: none;
		}

		.tree-toolbar {
			flex-wrap: wrap;
		}

		.tree-toolbar > div {
			flex: 1 1 180px;
			min-width: 0;
		}

		.show-replies-btn {
			flex: 1 1 120px;
			white-space: normal;
		}

		.chat-font-controls {
			grid-template-columns: auto auto minmax(64px, 1fr) auto auto;
		}

		.text-mode-toggle {
			grid-column: 1 / span 2;
		}

		.chat-tree-btn {
			grid-column: 3 / -1;
			width: 100%;
		}

		.chat-font-scope {
			display: block;
		}

		.chat-panel :global(.group-chat) {
			max-height: none;
		}

		.chat-panel :global(.group-chat.full-height) {
			max-height: none;
		}

		.tree-canvas {
			max-height: 42vh;
		}
	}
</style>
