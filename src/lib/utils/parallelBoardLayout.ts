import type { ThreadPost } from '../types';
import type { BoardThread } from '../types/boardPlatform';

type LaneKind = 'main' | 'quoted';
export type LaneChain = {
	id: string;
	order: number;
	posts: ThreadPost[];
};
export type LaneCardVisibility = 'active' | 'shadow';
export type LaneCard = {
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
	/** Absolute board row; set when the lane is placed on the board. */
	row: number;
	visibility: LaneCardVisibility;
	divergenceDepth: number;
	stackIndex: number;
	switchGroupChainIds: string[];
	isLaneRoot: boolean;
};
export type LaneRenderModel = {
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
export type LaneConnector = {
	key: string;
	from: LaneCard;
	to: LaneCard;
	kind: 'spawn' | 'reference' | 'tree';
};

/** Root-to-leaf chains in DFS leaf order. Iterative with one shared path, so a
 * deep chain costs O(depth) instead of copying the path at every node. */
export function collectLaneChains(rootPost: ThreadPost): LaneChain[] {
	const chains: LaneChain[] = [];
	const path: ThreadPost[] = [];
	const stack: Array<{ post: ThreadPost; depth: number; id: string }> = [
		{ post: rootPost, depth: 0, id: '0' }
	];
	while (stack.length) {
		const { post, depth, id } = stack.pop()!;
		path.length = depth;
		path.push(post);
		if (post.children.length === 0) {
			chains.push({ id, order: chains.length, posts: path.slice() });
			continue;
		}
		for (let index = post.children.length - 1; index >= 0; index--) {
			stack.push({ post: post.children[index], depth: depth + 1, id: `${id}.${index}` });
		}
	}
	return chains;
}

export function buildPostDepthMap(rootPost: ThreadPost): Map<string, number> {
	const depthByPostUri = new Map<string, number>();
	const stack: Array<[ThreadPost, number]> = [[rootPost, 0]];
	while (stack.length) {
		const [post, depth] = stack.pop()!;
		depthByPostUri.set(post.uri, depth);
		for (let index = post.children.length - 1; index >= 0; index--) {
			stack.push([post.children[index], depth + 1]);
		}
	}
	return depthByPostUri;
}

/** Longest chain wins, then (default mode) chains through the anchor, then load order.
 * `anchorOnly` first restricts to chains through the anchor when any exist. */
export function pickLaneChainId(
	chains: LaneChain[], depths: Map<string, number>, anchorUri: string, anchorOnly: boolean
): string {
	const anchorDepth = depths.get(anchorUri);
	const hasAnchor = (chain: LaneChain) =>
		anchorDepth !== undefined && chain.posts[anchorDepth]?.uri === anchorUri;
	const pool = anchorOnly && chains.some(hasAnchor) ? chains.filter(hasAnchor) : chains;
	let best: LaneChain | undefined;
	for (const chain of pool) {
		if (!best) { best = chain; continue; }
		const lengthDelta = chain.posts.length - best.posts.length;
		if (lengthDelta > 0) { best = chain; continue; }
		if (lengthDelta < 0 || anchorOnly) continue;
		if (hasAnchor(chain) && !hasAnchor(best)) best = chain;
	}
	return best?.id ?? '';
}

/** Pre-order nodes of a tree, iterative so very deep threads cannot overflow the stack. */
function preorder(rootPost: ThreadPost): Array<{ post: ThreadPost; parent: number; depth: number }> {
	const nodes: Array<{ post: ThreadPost; parent: number; depth: number }> = [];
	const stack: Array<{ post: ThreadPost; parent: number; depth: number }> = [
		{ post: rootPost, parent: -1, depth: 0 }
	];
	while (stack.length) {
		const node = stack.pop()!;
		const index = nodes.length;
		nodes.push(node);
		const { children } = node.post;
		for (let child = children.length - 1; child >= 0; child--) {
			stack.push({ post: children[child], parent: index, depth: node.depth + 1 });
		}
	}
	return nodes;
}

function buildTreeFanXMap(nodes: ReturnType<typeof preorder>): Map<string, number> {
	const width = new Float64Array(nodes.length);
	for (let index = nodes.length - 1; index >= 0; index--) {
		if (nodes[index].post.children.length === 0) width[index] = 1;
		const parent = nodes[index].parent;
		if (parent >= 0) width[parent] += width[index];
	}
	// A child's slot starts where its previous sibling's subtree ended.
	const start = new Float64Array(nodes.length);
	const cursor = new Float64Array(nodes.length);
	for (let index = 1; index < nodes.length; index++) {
		const parent = nodes[index].parent;
		start[index] = start[parent] + cursor[parent];
		cursor[parent] += width[index];
	}
	const center = new Float64Array(nodes.length);
	const firstChild = new Float64Array(nodes.length).fill(NaN);
	const lastChild = new Float64Array(nodes.length);
	for (let index = nodes.length - 1; index >= 0; index--) {
		center[index] = nodes[index].post.children.length === 0
			? start[index]
			: (firstChild[index] + lastChild[index]) / 2;
		const parent = nodes[index].parent;
		if (parent < 0) continue;
		// Reverse pre-order meets the last child first and the first child last.
		if (Number.isNaN(firstChild[parent])) lastChild[parent] = center[index];
		firstChild[parent] = center[index];
	}
	const xByPostUri = new Map<string, number>();
	nodes.forEach((node, index) => xByPostUri.set(node.post.uri, center[index]));
	return xByPostUri;
}

export type LaneCardLayout = { cards: LaneCard[]; connectors: LaneConnector[]; };

function buildLaneCardLayout(
	lane: LaneRenderModel, expanded: boolean, depthByPost: Map<string, number>, treeFanStepX: number
): LaneCardLayout {
	const cards: LaneCard[] = [];
	const connectors: LaneConnector[] = [];
	const nodes = preorder(lane.thread.rootPost);
	const makeCard = (post: ThreadPost, depth: number, x: number): LaneCard => ({
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
		x,
		row: 0,
		visibility: 'active',
		divergenceDepth: depth,
		stackIndex: 0,
		switchGroupChainIds: [],
		isLaneRoot: depth === 0
	});

	if (expanded) {
		const xByPost = buildTreeFanXMap(nodes);
		const anchorX = xByPost.get(lane.anchorUri) ?? xByPost.get(lane.thread.rootPost.uri) ?? 0;
		const nodeCards = nodes.map(({ post }) =>
			makeCard(post, depthByPost.get(post.uri) ?? 0,
				lane.x + ((xByPost.get(post.uri) ?? anchorX) - anchorX) * treeFanStepX));
		cards.push(...nodeCards);
		cards.sort((a, b) => a.depth - b.depth || a.x - b.x);
		// Visiting in pre-order and linking from the parent keeps the recursive edge order.
		nodes.forEach((node, index) => {
			if (node.parent < 0) return;
			const from = nodeCards[node.parent];
			const to = nodeCards[index];
			connectors.push({ key: `tree:${from.key}->${to.key}`, from, to, kind: 'tree' });
		});
		return { cards, connectors };
	}

	const activeChain = lane.chains.find((chain) => chain.id === lane.activeChainId) ?? lane.chains[0];
	if (!activeChain) return { cards, connectors };
	const activePosts = activeChain.posts;

	// Every tree node is one card: active on the active path, otherwise a shadow owned by
	// its first leaf chain. `divergence` is the depth where its path leaves the active path.
	const divergence = new Int32Array(nodes.length);
	const leafOrder = new Int32Array(nodes.length).fill(-1);
	let leafCount = 0;
	nodes.forEach((node, index) => {
		if (node.parent < 0) {
			divergence[index] = activePosts[0]?.uri === node.post.uri ? -1 : 0;
		} else if (divergence[node.parent] === -1) {
			divergence[index] = activePosts[node.depth]?.uri === node.post.uri ? -1 : node.depth;
		} else {
			divergence[index] = divergence[node.parent];
		}
		if (node.post.children.length === 0) leafOrder[index] = leafCount++;
	});
	const firstLeaf = new Int32Array(nodes.length);
	for (let index = nodes.length - 1; index >= 0; index--) {
		firstLeaf[index] = leafOrder[index] >= 0 ? leafOrder[index] : firstLeaf[index + 1];
	}

	const switchChainsByDepth = new Map<number, LaneChain[]>();
	nodes.forEach((_, index) => {
		const depth = divergence[index];
		const chain = lane.chains[leafOrder[index]];
		if (leafOrder[index] < 0 || depth < 0 || !chain || chain.id === activeChain.id) return;
		if (depth >= activePosts.length) return;
		const group = switchChainsByDepth.get(depth) ?? [activeChain];
		group.push(chain);
		switchChainsByDepth.set(depth, group);
	});
	const switchGroupByDepth = new Map<number, string[]>();
	for (const [depth, group] of switchChainsByDepth) {
		switchGroupByDepth.set(depth, group.sort((a, b) => a.order - b.order).map((chain) => chain.id));
	}

	const shadowGroups = new Map<number, LaneCard[]>();
	nodes.forEach((node, index) => {
		const card = makeCard(node.post, node.depth, lane.x);
		if (divergence[index] === -1) {
			card.chainId = activeChain.id;
			card.chainOrder = activeChain.order;
			card.divergenceDepth = 0;
			card.switchGroupChainIds = switchGroupByDepth.get(node.depth) ?? [];
		} else {
			const owner = lane.chains[firstLeaf[index]];
			card.visibility = 'shadow';
			card.chainId = owner?.id ?? activeChain.id;
			card.chainOrder = owner?.order ?? firstLeaf[index];
			card.divergenceDepth = divergence[index];
			const group = shadowGroups.get(card.depth) ?? [];
			group.push(card);
			shadowGroups.set(card.depth, group);
		}
		cards.push(card);
	});

	for (const group of shadowGroups.values()) {
		group
			.sort((a, b) => b.divergenceDepth - a.divergenceDepth || a.chainOrder - b.chainOrder)
			.forEach((card, index) => {
				card.stackIndex = index;
			});
	}

	cards.sort((a, b) => {
		const depthDelta = a.depth - b.depth;
		if (depthDelta !== 0) return depthDelta;
		if (a.visibility !== b.visibility) return a.visibility === 'shadow' ? -1 : 1;
		return a.chainOrder - b.chainOrder;
	});
	return { cards, connectors };
}

/** Keeps only the latest local layout for each live lane. Board positioning must
 * copy these cards so subsequent rebuilds cannot shift the cached geometry. */
export class LaneCardLayoutCache {
	private entries = new Map<string, { signature: unknown[]; layout: LaneCardLayout; }>();

	get(lane: LaneRenderModel, expanded: boolean, depths: Map<string, number>, treeFanStepX: number): LaneCardLayout {
		const signature = [
			lane.thread.rootPost, lane.activeChainId, lane.anchorUri,
			lane.label, lane.title, lane.kind, Boolean(lane.thread.isTruncated), expanded, treeFanStepX
		];
		const existing = this.entries.get(lane.id);
		if (existing && signature.every((value, index) => value === existing.signature[index])) {
			return existing.layout;
		}
		const layout = buildLaneCardLayout({ ...lane, x: 0, depthOffset: 0 }, expanded, depths, treeFanStepX);
		this.entries.set(lane.id, { signature, layout });
		return layout;
	}

	retain(laneIds: ReadonlySet<string>) {
		for (const id of this.entries.keys()) {
			if (!laneIds.has(id)) this.entries.delete(id);
		}
	}
}

export type LanePlacement = {
	id: string;
	sourceLaneId: string;
	direction: 'inbound' | 'outbound';
};

/** Insert beside the source in O(1), then number columns in one pass.
 * Input order is load order. Resolve parents first, including later input entries.
 * Missing sources (and invalid cycles) use column zero, as in the original layout. */
export function assignLaneColumns(mainId: string, entries: readonly LanePlacement[]): Map<string, number> {
	type Link = { id: string; side: number; previous?: Link; next?: Link; };
	const main: Link = { id: mainId, side: 0 };
	// Column zero can move away from main when a nested insertion shifts it.
	// Track each node's side of zero; only one node crosses zero per insertion.
	// This also preserves the old column-zero fallback for missing parents.
	let zero = main;
	let inboundCount = 0;
	const links = new Map<string, Link>([[mainId, main]]);
	const byId = new Map(entries.map((entry) => [entry.id, entry]));
	let first = main;
	for (const entry of entries) {
		const pending: LanePlacement[] = [];
		const visiting = new Set<string>();
		let current: LanePlacement | undefined = entry;
		while (current && !links.has(current.id) && !visiting.has(current.id)) {
			visiting.add(current.id);
			pending.push(current);
			current = byId.get(current.sourceLaneId);
		}
		while (pending.length) {
			const next = pending.pop()!;
			const source = links.get(next.sourceLaneId) ?? zero;
			const link: Link = { id: next.id, side: source.side };
			if (next.direction === 'inbound') {
				inboundCount++;
				link.side = source.side <= 0 ? -1 : 1;
				link.previous = source.previous;
				link.next = source;
				if (source.previous) source.previous.next = link;
				else first = link;
				source.previous = link;
				if (source.side > 0) {
					zero.side = -1;
					zero = zero.next!;
					zero.side = 0;
				}
			} else {
				link.side = source.side >= 0 ? 1 : -1;
				link.next = source.next;
				link.previous = source;
				if (source.next) source.next.previous = link;
				source.next = link;
				if (source.side < 0) {
					zero.side = 1;
					zero = zero.previous!;
					zero.side = 0;
				}
			}
			links.set(next.id, link);
		}
	}
	const columns = new Map<string, number>();
	let index = 0 - inboundCount;
	let link: Link | undefined = first;
	while (link) {
		columns.set(link.id, index++);
		link = link.next;
	}
	return columns;
}

/** Last index whose value is <= target (sorted ascending), or -1. */
export function lastIndexAtOrBelow(sorted: ArrayLike<number>, target: number): number {
	let low = 0;
	let high = sorted.length - 1;
	let found = -1;
	while (low <= high) {
		const mid = (low + high) >> 1;
		if (sorted[mid] <= target) {
			found = mid;
			low = mid + 1;
		} else {
			high = mid - 1;
		}
	}
	return found;
}

/** First index whose key is >= target in an array sorted by that key. */
export function firstIndexAtOrAbove<T>(items: readonly T[], target: number, key: (item: T) => number): number {
	let low = 0;
	let high = items.length;
	while (low < high) {
		const mid = (low + high) >> 1;
		if (key(items[mid]) < target) low = mid + 1;
		else high = mid;
	}
	return low;
}

const CONNECTOR_CELL_X = 2048;
const CONNECTOR_CELL_ROWS = 8;
const CONNECTOR_MAX_CELLS = 16;

/** Uniform grid over (x, row) for short connectors; long spans (e.g. a source fanning
 * out to hundreds of quote lanes) would fill too many cells, so they are scanned linearly. */
export type ConnectorIndex = {
	connectors: LaneConnector[];
	minX: Float64Array;
	maxX: Float64Array;
	minRow: Int32Array;
	maxRow: Int32Array;
	cells: Map<string, number[]>;
	long: number[];
	seen: Uint32Array;
	stamp: number;
};

export function buildConnectorIndex(connectors: LaneConnector[], cardWidth: number): ConnectorIndex {
	const count = connectors.length;
	const index: ConnectorIndex = {
		connectors,
		minX: new Float64Array(count),
		maxX: new Float64Array(count),
		minRow: new Int32Array(count),
		maxRow: new Int32Array(count),
		cells: new Map(),
		long: [],
		seen: new Uint32Array(count),
		stamp: 0
	};
	connectors.forEach((connector, i) => {
		const minX = Math.min(connector.from.x, connector.to.x);
		const maxX = Math.max(connector.from.x, connector.to.x) + cardWidth;
		const minRow = Math.min(connector.from.row, connector.to.row);
		const maxRow = Math.max(connector.from.row, connector.to.row);
		index.minX[i] = minX;
		index.maxX[i] = maxX;
		index.minRow[i] = minRow;
		index.maxRow[i] = maxRow;
		const cx0 = Math.floor(minX / CONNECTOR_CELL_X);
		const cx1 = Math.floor(maxX / CONNECTOR_CELL_X);
		const cy0 = Math.floor(minRow / CONNECTOR_CELL_ROWS);
		const cy1 = Math.floor(maxRow / CONNECTOR_CELL_ROWS);
		if ((cx1 - cx0 + 1) * (cy1 - cy0 + 1) > CONNECTOR_MAX_CELLS) {
			index.long.push(i);
			return;
		}
		for (let cx = cx0; cx <= cx1; cx++) {
			for (let cy = cy0; cy <= cy1; cy++) {
				const key = `${cx}:${cy}`;
				const cell = index.cells.get(key);
				if (cell) cell.push(i);
				else index.cells.set(key, [i]);
			}
		}
	});
	return index;
}

/** Connectors whose bounds touch [minX, maxX] × [minRow, maxRow], in original draw order. */
export function queryConnectorIndex(
	index: ConnectorIndex, minX: number, maxX: number, minRow: number, maxRow: number
): LaneConnector[] {
	index.stamp = (index.stamp + 1) >>> 0 || 1;
	const stamp = index.stamp;
	const hits: number[] = [];
	const consider = (i: number) => {
		if (index.seen[i] === stamp) return;
		index.seen[i] = stamp;
		if (index.maxX[i] < minX || index.minX[i] > maxX) return;
		if (index.maxRow[i] < minRow || index.minRow[i] > maxRow) return;
		hits.push(i);
	};
	const cx0 = Math.floor(minX / CONNECTOR_CELL_X);
	const cx1 = Math.floor(maxX / CONNECTOR_CELL_X);
	const cy0 = Math.floor(minRow / CONNECTOR_CELL_ROWS);
	const cy1 = Math.floor(maxRow / CONNECTOR_CELL_ROWS);
	if ((cx1 - cx0 + 1) * (cy1 - cy0 + 1) > index.cells.size) {
		for (const cell of index.cells.values()) cell.forEach(consider);
	} else {
		for (let cx = cx0; cx <= cx1; cx++) {
			for (let cy = cy0; cy <= cy1; cy++) {
				index.cells.get(`${cx}:${cy}`)?.forEach(consider);
			}
		}
	}
	index.long.forEach(consider);
	hits.sort((a, b) => a - b);
	return hits.map((i) => index.connectors[i]);
}

/** Cubic Bézier as [x0, y0, x1, y1, x2, y2, x3, y3]. */
export type CubicCurve = readonly [number, number, number, number, number, number, number, number];
export type BoardRect = { left: number; top: number; right: number; bottom: number };

const CLIP_MAX_DEPTH = 24;

/**
 * Bounds of the part of `curve` inside `rect`, or null when the curve misses it.
 * Subdivides with de Casteljau and rejects pieces whose control-point box misses the
 * rect (a Bézier stays inside its control hull). A piece thinner than `tolerance` in
 * either direction is effectively a line, so its box clipped to the rect is accepted:
 * this keeps long near-straight spans to a logarithmic number of splits.
 */
export function clipCubicToRect(curve: CubicCurve, rect: BoardRect, tolerance = 4): BoardRect | null {
	let result: BoardRect | null = null;
	const stack: { c: CubicCurve; depth: number }[] = [{ c: curve, depth: 0 }];
	while (stack.length) {
		const { c, depth } = stack.pop()!;
		const minX = Math.min(c[0], c[2], c[4], c[6]);
		const maxX = Math.max(c[0], c[2], c[4], c[6]);
		const minY = Math.min(c[1], c[3], c[5], c[7]);
		const maxY = Math.max(c[1], c[3], c[5], c[7]);
		if (maxX < rect.left || minX > rect.right || maxY < rect.top || minY > rect.bottom) continue;
		const inside = minX >= rect.left && maxX <= rect.right && minY >= rect.top && maxY <= rect.bottom;
		if (inside || maxX - minX <= tolerance || maxY - minY <= tolerance || depth >= CLIP_MAX_DEPTH) {
			const piece = {
				left: Math.max(minX, rect.left),
				right: Math.min(maxX, rect.right),
				top: Math.max(minY, rect.top),
				bottom: Math.min(maxY, rect.bottom)
			};
			result = result
				? {
						left: Math.min(result.left, piece.left),
						right: Math.max(result.right, piece.right),
						top: Math.min(result.top, piece.top),
						bottom: Math.max(result.bottom, piece.bottom)
					}
				: piece;
			continue;
		}
		// Split at t = 0.5.
		const [x0, y0, x1, y1, x2, y2, x3, y3] = c;
		const ax = (x0 + x1) / 2, ay = (y0 + y1) / 2;
		const bx = (x1 + x2) / 2, by = (y1 + y2) / 2;
		const cx = (x2 + x3) / 2, cy = (y2 + y3) / 2;
		const dx = (ax + bx) / 2, dy = (ay + by) / 2;
		const ex = (bx + cx) / 2, ey = (by + cy) / 2;
		const mx = (dx + ex) / 2, my = (dy + ey) / 2;
		stack.push({ c: [x0, y0, ax, ay, dx, dy, mx, my], depth: depth + 1 });
		stack.push({ c: [mx, my, ex, ey, cx, cy, x3, y3], depth: depth + 1 });
	}
	return result;
}

export type ConnectorCullStats = {
	/** Curves that really cross the rect. */
	crossing: number;
	/** Of those, curves with both ends inside the rect; always drawn. */
	local: number;
	/** Distinct source cards among the crossing curves. */
	sources: number;
	/** Merge grid (px) needed to fit the pass-through budget. */
	mergeGrid: number;
};

/**
 * Connectors worth drawing inside `rect`: curves that actually pass through it (not just
 * their bounding box). Curves with both ends inside are short and distinct, so they are
 * always kept. The rest (a fan crossing the view, or thousands of quote lanes all pointing
 * at one post in view) are merged when their visible parts and in-view endpoints coincide
 * on a `mergeGrid` px grid, whatever their source. If more than `maxPassThrough` remain,
 * the grid doubles until they fit: lines closer than a few px read as one band, and drawing
 * them all is what made large quote fans slow to paint.
 */
export function cullConnectorsToRect(
	connectors: LaneConnector[],
	getCurve: (connector: LaneConnector) => CubicCurve,
	rect: BoardRect,
	options: { mergeGrid?: number; maxPassThrough?: number; stats?: ConnectorCullStats } = {}
): LaneConnector[] {
	const maxPassThrough = options.maxPassThrough ?? 250;
	const keptIndexes: number[] = [];
	const passThrough: { index: number; visible: BoardRect; start: [number, number] | null; end: [number, number] | null }[] = [];
	const sources = new Set<string>();
	const contains = (x: number, y: number) =>
		x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
	connectors.forEach((connector, index) => {
		const curve = getCurve(connector);
		const visible = clipCubicToRect(curve, rect);
		if (!visible) return;
		sources.add(connector.from.key);
		const startInside = contains(curve[0], curve[1]);
		const endInside = contains(curve[6], curve[7]);
		if (startInside && endInside) keptIndexes.push(index);
		else
			passThrough.push({
				index,
				visible,
				start: startInside ? [curve[0], curve[1]] : null,
				end: endInside ? [curve[6], curve[7]] : null
			});
	});

	let grid = options.mergeGrid ?? 6;
	let merged: number[] = [];
	for (;;) {
		const keys = new Set<string>();
		merged = [];
		const q = (value: number) => Math.round(value / grid);
		const point = (p: [number, number] | null) => (p ? `${q(p[0])},${q(p[1])}` : '-');
		for (const { index, visible, start, end } of passThrough) {
			const key = `${q(visible.left)}:${q(visible.right)}:${q(visible.top)}:${q(visible.bottom)}:${point(start)}:${point(end)}`;
			if (keys.has(key)) continue;
			keys.add(key);
			merged.push(index);
		}
		if (merged.length <= maxPassThrough || grid >= 4096) break;
		grid *= 2;
	}

	if (options.stats) {
		options.stats.crossing = keptIndexes.length + passThrough.length;
		options.stats.local = keptIndexes.length;
		options.stats.sources = sources.size;
		options.stats.mergeGrid = grid;
	}
	return [...keptIndexes, ...merged].sort((a, b) => a - b).map((index) => connectors[index]);
}
