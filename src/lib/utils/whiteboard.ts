import type { ThreadPost } from '$lib/types';

export const WHITEBOARD_CARD_WIDTH = 320;
export const WHITEBOARD_CARD_HEIGHT = 300;
export const WHITEBOARD_STEP_X = WHITEBOARD_CARD_WIDTH + 42;
export const WHITEBOARD_STEP_Y = WHITEBOARD_CARD_HEIGHT + 46;
export const WHITEBOARD_GROUP_PADDING_X = 26;
export const WHITEBOARD_GROUP_PADDING_Y = 24;
export const WHITEBOARD_GROUP_HEADER_HEIGHT = 46;

export type WhiteboardCardLayout = {
	post: ThreadPost;
	depth: number;
	x: number;
	y: number;
};

export type WhiteboardConnectorLayout = {
	key: string;
	fromUri: string;
	toUri: string;
	x1: number;
	y1: number;
	x2: number;
	y2: number;
};

export type WhiteboardBranchBadge = {
	/** Post the hidden branches fork off from. */
	uri: string;
	depth: number;
	hiddenCount: number;
	/** Chain index of the next sibling branch at this fork (wraps). */
	nextChainIndex: number;
	x: number;
	y: number;
};

export type WhiteboardGroupLayout = {
	cards: WhiteboardCardLayout[];
	cardByUri: Map<string, WhiteboardCardLayout>;
	connectors: WhiteboardConnectorLayout[];
	width: number;
	height: number;
	postCount: number;
	/** Stack-mode only: forks along the visible chain with hidden branches. */
	branchBadges?: WhiteboardBranchBadge[];
	/** Stack-mode only: number of root→leaf reply paths in the thread. */
	chainCount?: number;
	/** Stack-mode only: which chain is shown (clamped/wrapped). */
	activeChainIndex?: number;
};

/**
 * Prune deleted posts from a thread tree. Children of a deleted post are
 * promoted to the deleted post's parent so the rest of the thread stays on
 * the board. Returns null when every post (including the root) is deleted.
 */
export function pruneDeletedPosts(
	root: ThreadPost,
	deletedUris: ReadonlySet<string>
): ThreadPost | null {
	function keptChildren(post: ThreadPost): ThreadPost[] {
		const kept: ThreadPost[] = [];
		for (const child of post.children) {
			if (deletedUris.has(child.uri)) {
				kept.push(...keptChildren(child));
			} else {
				kept.push({ ...child, children: keptChildren(child) });
			}
		}
		return kept;
	}

	if (deletedUris.has(root.uri)) {
		// Root deleted: promote the first surviving child chain to root.
		const survivors = keptChildren(root);
		if (survivors.length === 0) return null;
		const [first, ...rest] = survivors;
		return { ...first, children: [...first.children, ...rest] };
	}

	return { ...root, children: keptChildren(root) };
}

/**
 * Lay out a thread tree in the parallel-board tree-fan style: depth maps to
 * rows, and each subtree is centered over the horizontal span of its leaves.
 */
export function layoutThreadGroup(
	root: ThreadPost,
	deletedUris: ReadonlySet<string> = new Set()
): WhiteboardGroupLayout {
	const pruned = pruneDeletedPosts(root, deletedUris);
	if (!pruned) {
		return {
			cards: [],
			cardByUri: new Map(),
			connectors: [],
			width: WHITEBOARD_CARD_WIDTH + WHITEBOARD_GROUP_PADDING_X * 2,
			height: WHITEBOARD_GROUP_HEADER_HEIGHT + WHITEBOARD_GROUP_PADDING_Y * 2,
			postCount: 0
		};
	}

	const leafSlots = new Map<string, number>();
	function measure(post: ThreadPost): number {
		if (post.children.length === 0) {
			leafSlots.set(post.uri, 1);
			return 1;
		}
		let slots = 0;
		for (const child of post.children) {
			slots += measure(child);
		}
		leafSlots.set(post.uri, slots);
		return slots;
	}
	measure(pruned);

	const cards: WhiteboardCardLayout[] = [];
	const cardByUri = new Map<string, WhiteboardCardLayout>();
	const connectors: WhiteboardConnectorLayout[] = [];
	let maxDepth = 0;

	function place(post: ThreadPost, depth: number, startSlot: number): number {
		maxDepth = Math.max(maxDepth, depth);
		let center: number;

		if (post.children.length === 0) {
			center = startSlot + 0.5;
		} else {
			let childSlot = startSlot;
			const childCenters: number[] = [];
			for (const child of post.children) {
				childCenters.push(place(child, depth + 1, childSlot));
				childSlot += leafSlots.get(child.uri) ?? 1;
			}
			center = (childCenters[0] + childCenters[childCenters.length - 1]) / 2;
		}

		const card: WhiteboardCardLayout = {
			post,
			depth,
			x: WHITEBOARD_GROUP_PADDING_X + (center - 0.5) * WHITEBOARD_STEP_X,
			y:
				WHITEBOARD_GROUP_HEADER_HEIGHT +
				WHITEBOARD_GROUP_PADDING_Y +
				depth * WHITEBOARD_STEP_Y
		};
		cards.push(card);
		cardByUri.set(post.uri, card);
		return center;
	}
	place(pruned, 0, 0);

	function collectConnectors(post: ThreadPost) {
		const parentCard = cardByUri.get(post.uri);
		for (const child of post.children) {
			const childCard = cardByUri.get(child.uri);
			if (parentCard && childCard) {
				connectors.push({
					key: `${post.uri}->${child.uri}`,
					fromUri: post.uri,
					toUri: child.uri,
					x1: parentCard.x + WHITEBOARD_CARD_WIDTH / 2,
					y1: parentCard.y + WHITEBOARD_CARD_HEIGHT,
					x2: childCard.x + WHITEBOARD_CARD_WIDTH / 2,
					y2: childCard.y
				});
			}
			collectConnectors(child);
		}
	}
	collectConnectors(pruned);

	const totalSlots = leafSlots.get(pruned.uri) ?? 1;
	return {
		cards,
		cardByUri,
		connectors,
		width:
			WHITEBOARD_GROUP_PADDING_X * 2 +
			(totalSlots - 1) * WHITEBOARD_STEP_X +
			WHITEBOARD_CARD_WIDTH,
		height:
			WHITEBOARD_GROUP_HEADER_HEIGHT +
			WHITEBOARD_GROUP_PADDING_Y * 2 +
			maxDepth * WHITEBOARD_STEP_Y +
			WHITEBOARD_CARD_HEIGHT,
		postCount: cards.length
	};
}

/** Extra horizontal room reserved for branch badges in stack mode. */
export const WHITEBOARD_STACK_BADGE_LANE = 78;

function emptyGroupLayout(): WhiteboardGroupLayout {
	return {
		cards: [],
		cardByUri: new Map(),
		connectors: [],
		width: WHITEBOARD_CARD_WIDTH + WHITEBOARD_GROUP_PADDING_X * 2,
		height: WHITEBOARD_GROUP_HEADER_HEIGHT + WHITEBOARD_GROUP_PADDING_Y * 2,
		postCount: 0,
		branchBadges: [],
		chainCount: 0,
		activeChainIndex: 0
	};
}

function measureLeafSlots(root: ThreadPost): Map<string, number> {
	const slots = new Map<string, number>();
	function measure(post: ThreadPost): number {
		if (post.children.length === 0) {
			slots.set(post.uri, 1);
			return 1;
		}
		let total = 0;
		for (const child of post.children) total += measure(child);
		slots.set(post.uri, total);
		return total;
	}
	measure(root);
	return slots;
}

/**
 * Lay out one root→leaf reply path as a single vertical lane (the
 * parallel-board "stacked" style). Forks along the path get branch badges
 * that report how many sibling branches are hidden and which chain index to
 * switch to next. `chainIndex` wraps, so cycling with +1/-1 always works.
 */
export function layoutThreadStack(
	root: ThreadPost,
	deletedUris: ReadonlySet<string> = new Set(),
	chainIndex = 0
): WhiteboardGroupLayout {
	const pruned = pruneDeletedPosts(root, deletedUris);
	if (!pruned) return emptyGroupLayout();

	const leafSlots = measureLeafSlots(pruned);
	const chainCount = leafSlots.get(pruned.uri) ?? 1;
	const active = ((Math.trunc(chainIndex) % chainCount) + chainCount) % chainCount;

	const path: ThreadPost[] = [];
	const branchBadges: WhiteboardBranchBadge[] = [];
	let node = pruned;
	// Global leaf index of the first leaf under `node`.
	let nodeStart = 0;
	for (;;) {
		path.push(node);
		if (node.children.length === 0) break;
		let acc = nodeStart;
		let chosen = node.children[0];
		let chosenStart = nodeStart;
		let chosenSpan = leafSlots.get(chosen.uri) ?? 1;
		for (const child of node.children) {
			const span = leafSlots.get(child.uri) ?? 1;
			if (active < acc + span) {
				chosen = child;
				chosenStart = acc;
				chosenSpan = span;
				break;
			}
			acc += span;
		}
		if (node.children.length > 1) {
			const nodeSpan = leafSlots.get(node.uri) ?? 1;
			branchBadges.push({
				uri: node.uri,
				depth: path.length - 1,
				hiddenCount: node.children.length - 1,
				nextChainIndex: nodeStart + ((chosenStart - nodeStart + chosenSpan) % nodeSpan),
				x: WHITEBOARD_GROUP_PADDING_X + WHITEBOARD_CARD_WIDTH + 10,
				y:
					WHITEBOARD_GROUP_HEADER_HEIGHT +
					WHITEBOARD_GROUP_PADDING_Y +
					(path.length - 1) * WHITEBOARD_STEP_Y +
					WHITEBOARD_CARD_HEIGHT / 2
			});
		}
		nodeStart = chosenStart;
		node = chosen;
	}

	const cards: WhiteboardCardLayout[] = [];
	const cardByUri = new Map<string, WhiteboardCardLayout>();
	const connectors: WhiteboardConnectorLayout[] = [];
	for (let depth = 0; depth < path.length; depth++) {
		const post = path[depth];
		const card: WhiteboardCardLayout = {
			post,
			depth,
			x: WHITEBOARD_GROUP_PADDING_X,
			y: WHITEBOARD_GROUP_HEADER_HEIGHT + WHITEBOARD_GROUP_PADDING_Y + depth * WHITEBOARD_STEP_Y
		};
		cards.push(card);
		cardByUri.set(post.uri, card);
		if (depth > 0) {
			const parent = cards[depth - 1];
			connectors.push({
				key: `${path[depth - 1].uri}->${post.uri}`,
				fromUri: path[depth - 1].uri,
				toUri: post.uri,
				x1: parent.x + WHITEBOARD_CARD_WIDTH / 2,
				y1: parent.y + WHITEBOARD_CARD_HEIGHT,
				x2: card.x + WHITEBOARD_CARD_WIDTH / 2,
				y2: card.y
			});
		}
	}

	return {
		cards,
		cardByUri,
		connectors,
		width:
			WHITEBOARD_GROUP_PADDING_X * 2 +
			WHITEBOARD_CARD_WIDTH +
			(branchBadges.length > 0 ? WHITEBOARD_STACK_BADGE_LANE : 0),
		height:
			WHITEBOARD_GROUP_HEADER_HEIGHT +
			WHITEBOARD_GROUP_PADDING_Y * 2 +
			(path.length - 1) * WHITEBOARD_STEP_Y +
			WHITEBOARD_CARD_HEIGHT,
		postCount: cards.length,
		branchBadges,
		chainCount,
		activeChainIndex: active
	};
}

/**
 * First chain index whose root→leaf path passes through `uri`, or null when
 * the post is missing (or pruned away). Used to reveal a hidden post inside
 * a stacked group without expanding the whole tree.
 */
export function chainIndexForUri(
	root: ThreadPost,
	uri: string,
	deletedUris: ReadonlySet<string> = new Set()
): number | null {
	const pruned = pruneDeletedPosts(root, deletedUris);
	if (!pruned) return null;
	let found: number | null = null;
	function walk(post: ThreadPost, leafStart: number): number {
		if (found !== null) return 0;
		if (post.uri === uri) {
			found = leafStart;
			return 0;
		}
		if (post.children.length === 0) return 1;
		let acc = 0;
		for (const child of post.children) {
			acc += walk(child, leafStart + acc);
			if (found !== null) return 0;
		}
		return acc;
	}
	walk(pruned, 0);
	return found;
}

export type WhiteboardRect = { x: number; y: number; width: number; height: number };

/** Minimum clearance kept between thread groups on the board. */
export const WHITEBOARD_GROUP_MARGIN = 48;

export function rectsOverlap(a: WhiteboardRect, b: WhiteboardRect, margin = 0): boolean {
	return (
		a.x < b.x + b.width + margin &&
		a.x + a.width + margin > b.x &&
		a.y < b.y + b.height + margin &&
		a.y + a.height + margin > b.y
	);
}

function collidesAny(rect: WhiteboardRect, obstacles: WhiteboardRect[], margin: number): boolean {
	return obstacles.some((obstacle) => rectsOverlap(rect, obstacle, margin));
}

/**
 * Find the placement closest to (preferredX, preferredY) for a width×height
 * rect that keeps at least `margin` clearance from every obstacle. Candidate
 * spots are the preferred position plus positions snapped just outside each
 * obstacle's edges, so results hug existing groups instead of drifting away.
 * A free spot always exists (space is unbounded to the right/bottom).
 */
export function findFreeSpot(
	width: number,
	height: number,
	preferredX: number,
	preferredY: number,
	obstacles: WhiteboardRect[],
	margin = WHITEBOARD_GROUP_MARGIN
): { x: number; y: number } {
	if (!collidesAny({ x: preferredX, y: preferredY, width, height }, obstacles, margin)) {
		return { x: preferredX, y: preferredY };
	}

	let best: { x: number; y: number } | null = null;
	let bestDist = Infinity;
	for (const obstacle of obstacles) {
		const right = obstacle.x + obstacle.width + margin;
		const below = obstacle.y + obstacle.height + margin;
		const left = obstacle.x - width - margin;
		const above = obstacle.y - height - margin;
		const candidates = [
			{ x: right, y: preferredY },
			{ x: right, y: obstacle.y },
			{ x: preferredX, y: below },
			{ x: obstacle.x, y: below },
			{ x: left, y: preferredY },
			{ x: left, y: obstacle.y },
			{ x: preferredX, y: above },
			{ x: obstacle.x, y: above }
		];
		for (const candidate of candidates) {
			const dist = (candidate.x - preferredX) ** 2 + (candidate.y - preferredY) ** 2;
			if (dist >= bestDist) continue;
			if (collidesAny({ ...candidate, width, height }, obstacles, margin)) continue;
			best = candidate;
			bestDist = dist;
		}
	}
	if (best) return best;

	// Unreachable in practice (the spot right of the rightmost obstacle is
	// always free), but stay safe: drop below everything.
	let maxBottom = -Infinity;
	for (const obstacle of obstacles) {
		maxBottom = Math.max(maxBottom, obstacle.y + obstacle.height);
	}
	return { x: preferredX, y: maxBottom + margin };
}

export function collectThreadPosts(root: ThreadPost): ThreadPost[] {
	const posts: ThreadPost[] = [];
	const stack: ThreadPost[] = [root];
	while (stack.length > 0) {
		const post = stack.pop()!;
		posts.push(post);
		for (let i = post.children.length - 1; i >= 0; i--) {
			stack.push(post.children[i]);
		}
	}
	return posts;
}

/** Stable pastel-ish accent per author DID for group headers and the minimap. */
export function authorColor(did: string): string {
	let hash = 0;
	for (let i = 0; i < did.length; i++) {
		hash = (hash * 31 + did.charCodeAt(i)) | 0;
	}
	const hue = ((hash % 360) + 360) % 360;
	return `hsl(${hue}, 62%, 58%)`;
}
