<script lang="ts">
	import { onDestroy, onMount, tick } from 'svelte';
	import { browser } from '$app/environment';
	import '../../app.css';
	import { fetchQuotesForPost, getFullThread, getProfile } from '$lib/api/bluesky';
	import FontPicker from '$lib/components/FontPicker.svelte';
	import LoadingSpinner from '$lib/components/LoadingSpinner.svelte';
	import PostEmbedPreview from '$lib/components/PostEmbedPreview.svelte';
	import RouteNav from '$lib/components/RouteNav.svelte';
	import type { SelfReplyThread, ThreadPost } from '$lib/types';
	import { findFirstMatchingPost } from '$lib/utils/boardTree';
	import {
		buildAtUri,
		buildBskyPostUrl,
		extractBskyPostUrls,
		normalizeBskyPostUrl,
		parseBskyPostUrl
	} from '$lib/utils/viewerLinks';

	type BandSide = 'N' | 'E' | 'S' | 'W';
	type BandRoleCode = 'G' | 'S' | 'D' | 'A' | 'H' | 'K' | 'V' | 'N' | 'P' | 'R' | 'Y' | 'M';
	type BandRole = {
		code: BandRoleCode;
		name: string;
		color: string;
	};
	type BandNodeKind = 'reply' | 'quote' | 'quoteReply';
	type BandNode = {
		kind: BandNodeKind;
		post: ThreadPost;
		parentUri: string | null;
		depth: number;
		order: number;
		branchRootUri?: string;
		branchMode?: QuoteBranchMode;
	};
	type BandCell = {
		col: number;
		row: number;
		ring: number;
		side: BandSide;
		sequence: number;
		role: BandRole;
	};
	type BandSlot = BandCell & {
		node: BandNode;
		x: number;
		y: number;
		width: number;
		height: number;
		connectorPath: string;
	};
	type LayoutRect = {
		x: number;
		y: number;
		width: number;
		height: number;
	};
	type BandLayout = {
		width: number;
		height: number;
		center: LayoutRect;
		nucleus: LayoutRect;
		slots: BandSlot[];
		ringCount: number;
	};
	type QuoteBranchMode = 'replies' | 'thread';

	const fontFamilies: Record<string, string> = {
		virgil: "'Virgil', cursive",
		caveat: "'Caveat', cursive",
		patrick: "'Patrick Hand', cursive",
		'comic-neue': "'Comic Neue', cursive",
		inter: "'Inter', sans-serif",
		system: "system-ui, -apple-system, sans-serif"
	};

	const ROLES: Record<BandRoleCode, BandRole> = {
		G: { code: 'G', name: 'direct gloss', color: '#4B9ED0' },
		S: { code: 'S', name: 'direct source', color: '#59B96B' },
		D: { code: 'D', name: 'direct dispute', color: '#E69A38' },
		A: { code: 'A', name: 'direct application', color: '#9D70C8' },
		H: { code: 'H', name: 'supergloss', color: '#86BFE0' },
		K: { code: 'K', name: 'source apparatus', color: '#A7D86F' },
		V: { code: 'V', name: 'variant', color: '#F2B567' },
		N: { code: 'N', name: 'application note', color: '#C08BE2' },
		P: { code: 'P', name: 'provenance', color: '#69C7B7' },
		R: { code: 'R', name: 'parallel ref', color: '#D7BE63' },
		Y: { code: 'Y', name: 'backlink', color: '#C989AD' },
		M: { code: 'M', name: 'editorial meta', color: '#A9B0B2' }
	};

	const QUOTE_CARD_WIDTH = 540;
	const QUOTE_CARD_HEIGHT = 430;
	const NUCLEUS_SCALE = 1.2;
	const BAND_GAP = 24;
	const CELL_WIDTH = QUOTE_CARD_WIDTH + BAND_GAP;
	const CELL_HEIGHT = QUOTE_CARD_HEIGHT + BAND_GAP;
	const CENTER_COLS = 2;
	const CENTER_ROWS = 2;
	const CENTER_WIDTH = CENTER_COLS * CELL_WIDTH - BAND_GAP;
	const CENTER_HEIGHT = CENTER_ROWS * CELL_HEIGHT - BAND_GAP;
	const NUCLEUS_WIDTH = Math.round(QUOTE_CARD_WIDTH * NUCLEUS_SCALE);
	const NUCLEUS_HEIGHT = Math.round(QUOTE_CARD_HEIGHT * NUCLEUS_SCALE);
	const BOARD_PADDING = 140;
	const ZOOM_MIN = 0.12;
	const ZOOM_MAX = 1.2;
	const ZOOM_STEP = 0.1;

	let fontKey = $state('patrick');
	let fontFamily = $derived(fontFamilies[fontKey] ?? fontFamilies.patrick);
	let urlInput = $state('');
	let loading = $state(false);
	let error: string | null = $state(null);
	let thread = $state<(SelfReplyThread & { isTruncated?: boolean }) | null>(null);
	let selectedPost = $state<ThreadPost | null>(null);
	let repliesVisible = $state(true);
	let quotePosts = $state<ThreadPost[]>([]);
	let quoteLoading = $state(false);
	let quoteFetchMode: 'page' | 'all' | null = $state(null);
	let quoteError: string | null = $state(null);
	let quoteHasMore = $state(false);
	let quotesLoadedAll = $state(false);
	let quoteLayerOpened = $state(false);
	let quoteReplyRootsByUri = $state<Record<string, ThreadPost>>({});
	let quoteReplyLoadingByUri = $state<Record<string, boolean>>({});
	let quoteReplyErrorsByUri = $state<Record<string, string>>({});
	let quoteBranchModeByUri = $state<Record<string, QuoteBranchMode>>({});
	let highlightedPostUri = $state<string | null>(null);
	let zoom = $state(0.54);
	let viewportEl: HTMLDivElement | undefined = $state();
	let minimapViewport = $state({ x: 0, y: 0, width: 0, height: 0 });
	let loadRequestId = 0;
	let quoteRequestId = 0;
	let quoteReplyRequestId = 0;
	const quoteReplyRequestIdsByUri = new Map<string, number>();
	let minimapFrame = 0;

	let selectedPostUrl = $derived(
		selectedPost ? buildBskyPostUrl(selectedPost.uri, selectedPost.author.handle) : null
	);
	let allReplyNodes = $derived(collectReplyNodes(selectedPost));
	let replyNodes = $derived(repliesVisible ? allReplyNodes : []);
	let maxReplyDepth = $derived(Math.max(0, ...replyNodes.map((node) => node.depth)));
	let quoteNodes = $derived(
		quoteLayerOpened && selectedPost
			? quotePosts.map(
					(post, index): BandNode => ({
						kind: 'quote',
						post,
						parentUri: selectedPost.uri,
						depth: Math.max(1, maxReplyDepth + 1),
						order: 10_000 + index
					})
				)
				: []
	);
	let quoteReplyNodes = $derived(
		collectQuoteReplyNodes(quotePosts, quoteReplyRootsByUri, quoteBranchModeByUri)
	);
	let quoteReplyCountByRootUri = $derived.by(() => {
		const counts = new Map<string, number>();
		for (const node of quoteReplyNodes) {
			if (!node.branchRootUri) continue;
			counts.set(node.branchRootUri, (counts.get(node.branchRootUri) ?? 0) + 1);
		}
		return counts;
	});
	let growthNodes = $derived([...replyNodes, ...quoteNodes, ...quoteReplyNodes]);
	let bandLayout = $derived(buildBandLayout(growthNodes, selectedPost?.uri ?? null));
	let parentUriByPostUri = $derived.by(() =>
		new Map(growthNodes.map((node) => [node.post.uri, node.parentUri] as const))
	);
	let highlightedPathUris = $derived.by(() =>
		buildHighlightedPath(
			highlightedPostUri,
			selectedPost?.uri ?? null,
			parentUriByPostUri,
			growthNodes.map((node) => node.post.uri)
		)
	);
	let hasHighlightedPath = $derived(highlightedPathUris.size > 0);
	let minimapSlots = $derived(
		bandLayout.slots.map((slot) => ({
			key: `${slot.node.kind}:${slot.node.post.uri}`,
			x: slot.x,
			y: slot.y,
			width: slot.width,
			height: slot.height,
			kind: slot.node.kind,
			isActive: slotIsHighlighted(slot),
			isDimmed: slotIsDimmed(slot)
		}))
	);
	let expectedQuoteCount = $derived(selectedPost?.quoteCount ?? 0);
	let growthStatusLabel = $derived.by(() => {
		if (!selectedPost) return '';
		if (quoteLoading) {
			return quoteFetchMode === 'all' ? 'Loading all quote posts...' : 'Loading quote posts...';
		}
		if (quoteLayerOpened && quoteError) return quoteError;
		const replyLabel = repliesVisible
			? `${formatCount(replyNodes.length)} reply cell${replyNodes.length === 1 ? '' : 's'}`
			: `${formatCount(allReplyNodes.length)} repl${allReplyNodes.length === 1 ? 'y' : 'ies'} hidden`;
		const sideReplyLabel = quoteReplyNodes.length
			? `; ${formatCount(quoteReplyNodes.length)} side repl${quoteReplyNodes.length === 1 ? 'y' : 'ies'} opened`
			: '';
		if (!quoteLayerOpened) {
			return `${replyLabel} around the core.`;
		}
		if (expectedQuoteCount > 0 && quotePosts.length < expectedQuoteCount) {
			return `${replyLabel}; ${formatCount(quotePosts.length)} of ${formatCount(expectedQuoteCount)} quote posts opened${sideReplyLabel}.`;
		}
		return `${replyLabel}; ${formatCount(quotePosts.length)} quote post${quotePosts.length === 1 ? '' : 's'} opened${sideReplyLabel}.`;
	});

	function handleFontChange(key: string) {
		fontKey = key;
		try {
			localStorage.setItem('preferred-font', key);
		} catch {}
	}

	function clamp(value: number, min: number, max: number): number {
		return Math.min(Math.max(value, min), max);
	}

	function formatCount(value: number): string {
		if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, '')}m`;
		if (value >= 1000) return `${(value / 1000).toFixed(1).replace(/\.0$/, '')}k`;
		return String(value);
	}

	function formatDate(value: string): string {
		const date = new Date(value);
		if (Number.isNaN(date.getTime())) return '';
		return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
	}

	function roleForCell(cell: Omit<BandCell, 'role'>): BandRole {
		if (cell.ring === 1) {
			if (cell.side === 'N') return cell.col < CENTER_COLS / 2 ? ROLES.G : ROLES.S;
			if (cell.side === 'E') return cell.row < CENTER_ROWS / 2 ? ROLES.S : ROLES.D;
			if (cell.side === 'S') return cell.col >= CENTER_COLS / 2 ? ROLES.D : ROLES.A;
			return cell.row >= CENTER_ROWS / 2 ? ROLES.A : ROLES.G;
		}

		if (cell.ring === 2) {
			if (cell.side === 'N') return cell.col < CENTER_COLS / 2 ? ROLES.H : ROLES.K;
			if (cell.side === 'E') return cell.row < CENTER_ROWS / 2 ? ROLES.K : ROLES.V;
			if (cell.side === 'S') return cell.col >= CENTER_COLS / 2 ? ROLES.V : ROLES.N;
			return cell.row >= CENTER_ROWS / 2 ? ROLES.N : ROLES.H;
		}

		const outerBySide: Record<BandSide, BandRole[]> = {
			N: [ROLES.P, ROLES.R],
			E: [ROLES.R, ROLES.Y],
			S: [ROLES.Y, ROLES.M],
			W: [ROLES.M, ROLES.P]
		};
		const roles = outerBySide[cell.side];
		return roles[(cell.ring + cell.sequence) % roles.length];
	}

	function roleForQuoteReply(
		node: BandNode,
		cell: Omit<BandCell, 'role' | 'sequence'>,
		cellByUri: Map<string, Omit<BandCell, 'role' | 'sequence'>>
	): BandRole {
		const branchCell = node.branchRootUri ? cellByUri.get(node.branchRootUri) : undefined;
		if (!branchCell) return roleForCell({ ...cell, sequence: node.order });

		const branchSequence = Math.max(0, node.order % 1000);
		const localRing = Math.max(1, localDistance(branchCell, cell));
		if (localRing === 1) return [ROLES.G, ROLES.S, ROLES.D, ROLES.A][branchSequence % 4];
		if (localRing === 2) return [ROLES.H, ROLES.K, ROLES.V, ROLES.N][branchSequence % 4];

		const outerRoles = [ROLES.P, ROLES.R, ROLES.Y, ROLES.M];
		return outerRoles[(localRing + branchSequence) % outerRoles.length];
	}

	function centeredRange(min: number, max: number, center: number): number[] {
		return Array.from({ length: max - min + 1 }, (_, index) => min + index).sort((a, b) => {
			const distanceDelta = Math.abs(a - center) - Math.abs(b - center);
			if (distanceDelta !== 0) return distanceDelta;
			return a - b;
		});
	}

	function pushBandCell(
		cells: BandCell[],
		cell: Omit<BandCell, 'role' | 'sequence'>,
		sequence: number
	) {
		const base = { ...cell, sequence };
		cells.push({
			...base,
			role: roleForCell(base)
		});
	}

	function buildShellCells(count: number): BandCell[] {
		const cells: BandCell[] = [];
		let ring = 1;
		let sequence = 0;

		while (cells.length < count) {
			const colCenter = (CENTER_COLS - 1) / 2;
			const rowCenter = (CENTER_ROWS - 1) / 2;
			const sideCells: Record<BandSide, Array<Omit<BandCell, 'role' | 'sequence'>>> = {
				N: centeredRange(-ring, CENTER_COLS + ring - 1, colCenter).map((col) => ({
					col,
					row: -ring,
					ring,
					side: 'N'
				})),
				E: centeredRange(-ring + 1, CENTER_ROWS + ring - 2, rowCenter).map((row) => ({
					col: CENTER_COLS + ring - 1,
					row,
					ring,
					side: 'E'
				})),
				S: centeredRange(-ring, CENTER_COLS + ring - 1, colCenter).map((col) => ({
					col,
					row: CENTER_ROWS + ring - 1,
					ring,
					side: 'S'
				})),
				W: centeredRange(-ring + 1, CENTER_ROWS + ring - 2, rowCenter).map((row) => ({
					col: -ring,
					row,
					ring,
					side: 'W'
				}))
			};

			const maxSideLength = Math.max(...Object.values(sideCells).map((side) => side.length));
			for (let sideIndex = 0; sideIndex < maxSideLength && cells.length < count; sideIndex += 1) {
				for (const side of ['N', 'E', 'S', 'W'] as const) {
					const cell = sideCells[side][sideIndex];
					if (!cell || cells.length >= count) continue;
					pushBandCell(cells, cell, sequence);
					sequence += 1;
				}
			}
			ring += 1;
		}

		return cells;
	}

	function buildRingCells(ring: number): Array<Omit<BandCell, 'role' | 'sequence'>> {
		const colCenter = (CENTER_COLS - 1) / 2;
		const rowCenter = (CENTER_ROWS - 1) / 2;
		const sideCells: Record<BandSide, Array<Omit<BandCell, 'role' | 'sequence'>>> = {
			N: centeredRange(-ring, CENTER_COLS + ring - 1, colCenter).map((col) => ({
				col,
				row: -ring,
				ring,
				side: 'N'
			})),
			E: centeredRange(-ring + 1, CENTER_ROWS + ring - 2, rowCenter).map((row) => ({
				col: CENTER_COLS + ring - 1,
				row,
				ring,
				side: 'E'
			})),
			S: centeredRange(-ring, CENTER_COLS + ring - 1, colCenter).map((col) => ({
				col,
				row: CENTER_ROWS + ring - 1,
				ring,
				side: 'S'
			})),
			W: centeredRange(-ring + 1, CENTER_ROWS + ring - 2, rowCenter).map((row) => ({
				col: -ring,
				row,
				ring,
				side: 'W'
			}))
		};

		const cells: Array<Omit<BandCell, 'role' | 'sequence'>> = [];
		const maxSideLength = Math.max(...Object.values(sideCells).map((side) => side.length));
		for (let sideIndex = 0; sideIndex < maxSideLength; sideIndex += 1) {
			for (const side of ['N', 'E', 'S', 'W'] as const) {
				const cell = sideCells[side][sideIndex];
				if (cell) cells.push(cell);
			}
		}
		return cells;
	}

	function cellKey(cell: Pick<BandCell, 'col' | 'row'>): string {
		return `${cell.col}:${cell.row}`;
	}

	function axisForCell(cell: Pick<BandCell, 'col' | 'row' | 'side'>): number {
		return cell.side === 'N' || cell.side === 'S' ? cell.col : cell.row;
	}

	function clampAxisForSide(side: BandSide, ring: number, axis: number): number {
		if (side === 'N' || side === 'S') {
			return clamp(axis, -ring, CENTER_COLS + ring - 1);
		}
		return clamp(axis, -ring + 1, CENTER_ROWS + ring - 2);
	}

	function cellOnSide(side: BandSide, ring: number, axis: number): Omit<BandCell, 'role' | 'sequence'> {
		const clampedAxis = clampAxisForSide(side, ring, axis);
		if (side === 'N') return { col: clampedAxis, row: -ring, ring, side };
		if (side === 'E') return { col: CENTER_COLS + ring - 1, row: clampedAxis, ring, side };
		if (side === 'S') return { col: clampedAxis, row: CENTER_ROWS + ring - 1, ring, side };
		return { col: -ring, row: clampedAxis, ring, side };
	}

	function inferBandCell(col: number, row: number): Omit<BandCell, 'role' | 'sequence'> {
		const north = Math.max(0, -row);
		const east = Math.max(0, col - CENTER_COLS + 1);
		const south = Math.max(0, row - CENTER_ROWS + 1);
		const west = Math.max(0, -col);
		const ring = Math.max(1, north, east, south, west);
		if (north === ring) return { col, row, ring, side: 'N' };
		if (east === ring) return { col, row, ring, side: 'E' };
		if (south === ring) return { col, row, ring, side: 'S' };
		return { col, row, ring, side: 'W' };
	}

	function pushCellOutward(
		cell: Omit<BandCell, 'role' | 'sequence'>,
		distance: number
	): Omit<BandCell, 'role' | 'sequence'> {
		if (distance <= 0) return cell;
		if (cell.side === 'N') return inferBandCell(cell.col, cell.row - distance);
		if (cell.side === 'E') return inferBandCell(cell.col + distance, cell.row);
		if (cell.side === 'S') return inferBandCell(cell.col, cell.row + distance);
		return inferBandCell(cell.col - distance, cell.row);
	}

	function cellInsideCore(cell: Pick<BandCell, 'col' | 'row'>): boolean {
		return cell.col >= 0 && cell.col < CENTER_COLS && cell.row >= 0 && cell.row < CENTER_ROWS;
	}

	function localDistance(anchor: Pick<BandCell, 'col' | 'row'>, cell: Pick<BandCell, 'col' | 'row'>): number {
		return Math.max(Math.abs(cell.col - anchor.col), Math.abs(cell.row - anchor.row));
	}

	function buildLocalRingCells(
		anchor: Pick<BandCell, 'col' | 'row'>,
		localRing: number
	): Array<Omit<BandCell, 'role' | 'sequence'>> {
		const cells: Array<Omit<BandCell, 'role' | 'sequence'>> = [];
		for (let dy = -localRing; dy <= localRing; dy += 1) {
			for (let dx = -localRing; dx <= localRing; dx += 1) {
				if (Math.max(Math.abs(dx), Math.abs(dy)) !== localRing) continue;
				const cell = inferBandCell(anchor.col + dx, anchor.row + dy);
				if (!cellInsideCore(cell)) cells.push(cell);
			}
		}
		return cells.sort((a, b) => {
			const cardinalDelta =
				(Math.abs(a.col - anchor.col) + Math.abs(a.row - anchor.row)) -
				(Math.abs(b.col - anchor.col) + Math.abs(b.row - anchor.row));
			if (cardinalDelta !== 0) return cardinalDelta;
			return Math.atan2(a.row - anchor.row, a.col - anchor.col) - Math.atan2(b.row - anchor.row, b.col - anchor.col);
		});
	}

	function findOpenLocalCellAround(
		anchor: Pick<BandCell, 'col' | 'row'>,
		startLocalRing: number,
		occupied: Set<string>,
		sequence = 0
	): Omit<BandCell, 'role' | 'sequence'> {
		for (let localRing = Math.max(1, startLocalRing); localRing < startLocalRing + 16; localRing += 1) {
			const candidates = buildLocalRingCells(anchor, localRing);
			for (let index = 0; index < candidates.length; index += 1) {
				const cell = candidates[(index + sequence) % candidates.length];
				if (!occupied.has(cellKey(cell))) return cell;
			}
		}
		return inferBandCell(anchor.col, anchor.row + startLocalRing + 16);
	}

	function findOpenLocalCellNear(
		anchor: Pick<BandCell, 'col' | 'row'>,
		startLocalRing: number,
		desiredCol: number,
		desiredRow: number,
		occupied: Set<string>
	): Omit<BandCell, 'role' | 'sequence'> {
		for (let localRing = Math.max(1, startLocalRing); localRing < startLocalRing + 16; localRing += 1) {
			const candidates = buildLocalRingCells(anchor, localRing).sort((a, b) => {
				const aDistance = Math.abs(a.col - desiredCol) + Math.abs(a.row - desiredRow);
				const bDistance = Math.abs(b.col - desiredCol) + Math.abs(b.row - desiredRow);
				if (aDistance !== bDistance) return aDistance - bDistance;
				return cellKey(a).localeCompare(cellKey(b));
			});
			for (const cell of candidates) {
				if (!occupied.has(cellKey(cell))) return cell;
			}
		}
		return inferBandCell(desiredCol, desiredRow);
	}

	function centeredOffsets(limit: number): number[] {
		const offsets = [0];
		for (let offset = 1; offset <= limit; offset += 1) {
			offsets.push(-offset, offset);
		}
		return offsets;
	}

	function directionalLineCell(
		anchor: Pick<BandCell, 'col' | 'row'>,
		side: BandSide,
		step: number,
		track: number
	): Omit<BandCell, 'role' | 'sequence'> {
		if (side === 'E') return inferBandCell(anchor.col + step, anchor.row + track);
		if (side === 'W') return inferBandCell(anchor.col - step, anchor.row + track);
		if (side === 'S') return inferBandCell(anchor.col + track, anchor.row + step);
		return inferBandCell(anchor.col + track, anchor.row - step);
	}

	function buildDirectionalLineCells(
		anchor: Pick<BandCell, 'col' | 'row'>,
		side: BandSide,
		lineLength: number,
		trackLimit: number
	): Array<Omit<BandCell, 'role' | 'sequence'>> {
		const cells: Array<Omit<BandCell, 'role' | 'sequence'>> = [];
		for (const track of centeredOffsets(trackLimit)) {
			for (let step = 1; step <= lineLength; step += 1) {
				const cell = directionalLineCell(anchor, side, step, track);
				if (!cellInsideCore(cell)) cells.push(cell);
			}
		}
		return cells;
	}

	function placeDirectionalLineBranch(
		branchCell: Omit<BandCell, 'role' | 'sequence'>,
		branchNodes: BandNode[],
		occupied: Set<string>,
		cellByUri: Map<string, Omit<BandCell, 'role' | 'sequence'>>
	) {
		const lineLength = clamp(Math.ceil(Math.sqrt(branchNodes.length + 1)) * 2, 4, 9);
		let trackLimit = Math.ceil(branchNodes.length / lineLength) + 4;
		let candidates = buildDirectionalLineCells(branchCell, branchCell.side, lineLength, trackLimit);
		let candidateIndex = 0;

		for (const node of branchNodes) {
			let cell: Omit<BandCell, 'role' | 'sequence'> | null = null;
			while (!cell) {
				if (candidateIndex >= candidates.length) {
					trackLimit += 4;
					candidates = buildDirectionalLineCells(branchCell, branchCell.side, lineLength, trackLimit);
				}
				const candidate = candidates[candidateIndex];
				candidateIndex += 1;
				if (!candidate) continue;
				if (!occupied.has(cellKey(candidate))) cell = candidate;
			}
			cellByUri.set(node.post.uri, cell);
			occupied.add(cellKey(cell));
		}
	}

	function findOpenCellOnSide(
		side: BandSide,
		startRing: number,
		desiredAxis: number,
		occupied: Set<string>
	): Omit<BandCell, 'role' | 'sequence'> {
		let ring = Math.max(1, startRing);

		while (ring < startRing + 80) {
			const maxProbe = Math.max(CENTER_COLS, CENTER_ROWS) + ring * 2 + 4;
			for (let offset = 0; offset <= maxProbe; offset += 1) {
				const candidates = offset === 0 ? [desiredAxis] : [desiredAxis - offset, desiredAxis + offset];
				for (const axis of candidates) {
					const cell = cellOnSide(side, ring, axis);
					if (!occupied.has(cellKey(cell))) return cell;
				}
			}
			ring += 1;
		}

		return cellOnSide(side, ring, desiredAxis);
	}

	function buildReplyChainCells(nodes: BandNode[]): Map<string, Omit<BandCell, 'role' | 'sequence'>> {
		const cellByUri = new Map<string, Omit<BandCell, 'role' | 'sequence'>>();
		const occupied = new Set<string>();
		const replies = nodes
			.filter((node) => node.kind === 'reply')
			.sort((a, b) => a.depth - b.depth || a.order - b.order);
		const directReplies = replies.filter((node) => node.depth === 1);
		let directRing = 1;
		let directCells = buildRingCells(directRing);
		let directIndex = 0;

		for (const node of directReplies) {
			while (directIndex >= directCells.length) {
				directRing += 1;
				directCells = buildRingCells(directRing);
				directIndex = 0;
			}
			const baseCell = directCells[directIndex];
			directIndex += 1;
			const cell = findOpenCellOnSide(baseCell.side, baseCell.ring, axisForCell(baseCell), occupied);
			cellByUri.set(node.post.uri, cell);
			occupied.add(cellKey(cell));
		}

		for (const node of replies.filter((candidate) => candidate.depth > 1)) {
			const parentCell = node.parentUri ? cellByUri.get(node.parentUri) : undefined;
			const side = parentCell?.side ?? 'S';
			const desiredAxis = parentCell ? axisForCell(parentCell) : 0;
			const startRing = Math.max(node.depth, (parentCell?.ring ?? 0) + 1);
			const cell = findOpenCellOnSide(side, startRing, desiredAxis, occupied);
			cellByUri.set(node.post.uri, cell);
			occupied.add(cellKey(cell));
		}

		const quotes = nodes
			.filter((node) => node.kind === 'quote')
			.sort((a, b) => a.order - b.order);
		const quoteRepliesByRoot = new Map<string, BandNode[]>();
		for (const node of nodes) {
			if (node.kind !== 'quoteReply' || !node.branchRootUri) continue;
			const branchNodes = quoteRepliesByRoot.get(node.branchRootUri) ?? [];
			branchNodes.push(node);
			quoteRepliesByRoot.set(node.branchRootUri, branchNodes);
		}
		let quoteRing = Math.max(1, ...Array.from(cellByUri.values(), (cell) => cell.ring)) + 1;
		let quoteCells = buildRingCells(quoteRing);
		let quoteIndex = 0;
		for (const node of quotes) {
			while (quoteIndex >= quoteCells.length) {
				quoteRing += 1;
				quoteCells = buildRingCells(quoteRing);
				quoteIndex = 0;
			}
			const baseCell = quoteCells[quoteIndex];
			quoteIndex += 1;
			const branchIsOpen = (quoteRepliesByRoot.get(node.post.uri)?.length ?? 0) > 0;
			const targetCell = branchIsOpen ? pushCellOutward(baseCell, 1) : baseCell;
			const cell = findOpenCellOnSide(
				targetCell.side,
				targetCell.ring,
				axisForCell(targetCell),
				occupied
			);
			cellByUri.set(node.post.uri, cell);
			occupied.add(cellKey(cell));
		}

		const quoteReplies = nodes
			.filter((node) => node.kind === 'quoteReply')
			.sort((a, b) => a.depth - b.depth || a.order - b.order);
		const placedQuoteReplyUris = new Set<string>();
		for (const [branchUri, branchNodes] of quoteRepliesByRoot) {
			if (!branchNodes.some((node) => node.branchMode === 'thread')) continue;
			const branchCell = cellByUri.get(branchUri);
			if (!branchCell) continue;
			const orderedBranchNodes = [...branchNodes].sort((a, b) => a.order - b.order);
			placeDirectionalLineBranch(branchCell, orderedBranchNodes, occupied, cellByUri);
			for (const node of orderedBranchNodes) {
				placedQuoteReplyUris.add(node.post.uri);
			}
		}

		for (const node of quoteReplies) {
			if (placedQuoteReplyUris.has(node.post.uri)) continue;
			const parentCell = node.parentUri ? cellByUri.get(node.parentUri) : undefined;
			const branchCell = node.branchRootUri ? cellByUri.get(node.branchRootUri) : undefined;
			let cell: Omit<BandCell, 'role' | 'sequence'>;

			if (branchCell && (!parentCell || node.parentUri === node.branchRootUri)) {
				cell = findOpenLocalCellAround(branchCell, 1, occupied, Math.max(0, node.order % 1000));
			} else if (branchCell && parentCell) {
				const parentLocalRing = Math.max(1, localDistance(branchCell, parentCell));
				const stepCol = Math.sign(parentCell.col - branchCell.col);
				const stepRow = Math.sign(parentCell.row - branchCell.row);
				const desiredCol = parentCell.col + stepCol;
				const desiredRow = parentCell.row + stepRow;
				cell = findOpenLocalCellNear(
					branchCell,
					parentLocalRing + 1,
					desiredCol,
					desiredRow,
					occupied
				);
			} else {
				const anchorCell = parentCell ?? branchCell;
				const side = anchorCell?.side ?? 'S';
				const desiredAxis = anchorCell ? axisForCell(anchorCell) : 0;
				const startRing = Math.max(1, (anchorCell?.ring ?? 0) + 1);
				cell = findOpenCellOnSide(side, startRing, desiredAxis, occupied);
			}

			cellByUri.set(node.post.uri, cell);
			occupied.add(cellKey(cell));
		}

		return cellByUri;
	}

	function collectReplyNodes(post: ThreadPost | null): BandNode[] {
		const nodes: BandNode[] = [];
		if (!post) return nodes;
		let order = 0;

		function walk(parent: ThreadPost, depth: number) {
			for (const child of parent.children) {
				nodes.push({
					kind: 'reply',
					post: child,
					parentUri: parent.uri,
					depth,
					order
				});
				order += 1;
				walk(child, depth + 1);
			}
		}

		walk(post, 1);
		return nodes;
	}

	function collectQuoteReplyNodes(
		quotes: ThreadPost[],
		rootsByUri: Record<string, ThreadPost>,
		modesByUri: Record<string, QuoteBranchMode>
	): BandNode[] {
		const nodes: BandNode[] = [];
		for (const [quoteIndex, quote] of quotes.entries()) {
			const root = rootsByUri[quote.uri];
			if (!root) continue;
			const branchMode = modesByUri[quote.uri] ?? 'replies';
			let order = 20_000 + quoteIndex * 1_000;

			function walk(parent: ThreadPost, depth: number) {
				for (const child of parent.children) {
					nodes.push({
						kind: 'quoteReply',
						post: child,
						parentUri: parent.uri,
						depth,
						order,
						branchRootUri: quote.uri,
						branchMode
					});
					order += 1;
					walk(child, depth + 1);
				}
			}

			walk(root, 1);
		}
		return nodes;
	}

	function cloneThreadForQuoteAnchor(
		post: ThreadPost,
		anchorUri: string,
		parentUri: string
	): ThreadPost[] {
		if (post.uri === anchorUri) {
			return post.children.flatMap((child) => cloneThreadForQuoteAnchor(child, anchorUri, anchorUri));
		}

		const children = post.children.flatMap((child) => cloneThreadForQuoteAnchor(child, anchorUri, post.uri));
		return [
			{
				...post,
				parentUri,
				children
			}
		];
	}

	function buildWholeThreadQuoteAnchor(anchor: ThreadPost, rootPost: ThreadPost): ThreadPost {
		if (rootPost.uri === anchor.uri) return rootPost;
		return {
			...anchor,
			children: cloneThreadForQuoteAnchor(rootPost, anchor.uri, anchor.uri)
		};
	}

	function buildHighlightedPath(
		uri: string | null,
		centerUri: string | null,
		parentByUri: Map<string, string | null>,
		allPostUris: string[]
	): Set<string> {
		const path = new Set<string>();
		if (!uri || !centerUri) return path;
		if (uri === centerUri) {
			path.add(centerUri);
			for (const postUri of allPostUris) path.add(postUri);
			return path;
		}

		const childrenByParent = new Map<string, string[]>();
		for (const [postUri, parentUri] of parentByUri) {
			if (!parentUri) continue;
			const siblings = childrenByParent.get(parentUri) ?? [];
			siblings.push(postUri);
			childrenByParent.set(parentUri, siblings);
		}

		let current: string | null | undefined = uri;
		let guard = 0;
		while (current && guard < 200) {
			path.add(current);
			if (current === centerUri) break;
			current = parentByUri.get(current);
			guard += 1;
		}

		const descendants = [...(childrenByParent.get(uri) ?? [])];
		let descendantGuard = 0;
		while (descendants.length > 0 && descendantGuard < allPostUris.length + 10) {
			const descendantUri = descendants.pop();
			if (!descendantUri || path.has(descendantUri)) {
				descendantGuard += 1;
				continue;
			}
			path.add(descendantUri);
			descendants.push(...(childrenByParent.get(descendantUri) ?? []));
			descendantGuard += 1;
		}

		path.add(centerUri);
		return path;
	}

	function clearBandHighlight() {
		highlightedPostUri = null;
	}

	function selectBandPost(uri: string | null) {
		highlightedPostUri = highlightedPostUri === uri ? null : uri;
	}

	function isFromInteractiveElement(event: Event): boolean {
		const target = event.target;
		return (
			target instanceof Element &&
			Boolean(target.closest('a, button, input, select, textarea, video, [data-band-interactive]'))
		);
	}

	function handleBandCardClick(event: MouseEvent, uri: string) {
		if (isFromInteractiveElement(event)) return;
		selectBandPost(uri);
	}

	function handleBandCardKeydown(event: KeyboardEvent, uri: string) {
		if (event.target !== event.currentTarget) return;
		if (event.key === 'Enter' || event.key === ' ') {
			event.preventDefault();
			selectBandPost(uri);
		}
	}

	function getLinkedBskyPostUrls(post: ThreadPost): string[] {
		const urls = new Set<string>();
		for (const url of extractBskyPostUrls(post.text)) {
			urls.add(url);
		}
		for (const url of post.linkedUrls ?? []) {
			const normalized = normalizeBskyPostUrl(url);
			if (normalized) urls.add(normalized);
		}
		const externalUrl = post.embed?.external?.uri ? normalizeBskyPostUrl(post.embed.external.uri) : null;
		if (externalUrl) urls.add(externalUrl);
		return [...urls];
	}

	function slotIsHighlighted(slot: BandSlot): boolean {
		return highlightedPathUris.has(slot.node.post.uri);
	}

	function slotIsDimmed(slot: BandSlot): boolean {
		return hasHighlightedPath && !slotIsHighlighted(slot);
	}

	function connectorIsHighlighted(slot: BandSlot): boolean {
		if (!hasHighlightedPath) return false;
		const parentUri = slot.node.parentUri ?? selectedPost?.uri ?? null;
		return highlightedPathUris.has(slot.node.post.uri) && Boolean(parentUri && highlightedPathUris.has(parentUri));
	}

	function connectorIsDimmed(slot: BandSlot): boolean {
		return hasHighlightedPath && !connectorIsHighlighted(slot);
	}

	function isQuoteRepliesLoading(uri: string): boolean {
		return Boolean(quoteReplyLoadingByUri[uri]);
	}

	function getQuoteReplyError(uri: string): string | null {
		return quoteReplyErrorsByUri[uri] ?? null;
	}

	function hasOpenedQuoteReplies(uri: string): boolean {
		return Boolean(quoteReplyRootsByUri[uri]);
	}

	function getQuoteBranchMode(uri: string): QuoteBranchMode | null {
		return quoteBranchModeByUri[uri] ?? null;
	}

	function getOpenedQuoteReplyCount(uri: string): number {
		return quoteReplyCountByRootUri.get(uri) ?? 0;
	}

	function edgePoint(from: LayoutRect, to: LayoutRect) {
		const fromCenterX = from.x + from.width / 2;
		const fromCenterY = from.y + from.height / 2;
		const toCenterX = to.x + to.width / 2;
		const toCenterY = to.y + to.height / 2;
		const dx = toCenterX - fromCenterX;
		const dy = toCenterY - fromCenterY;

		if (Math.abs(dx) >= Math.abs(dy)) {
			return {
				x: dx >= 0 ? from.x + from.width : from.x,
				y: clamp(toCenterY, from.y, from.y + from.height)
			};
		}

		return {
			x: clamp(toCenterX, from.x, from.x + from.width),
			y: dy >= 0 ? from.y + from.height : from.y
		};
	}

	function connectorPathBetween(from: LayoutRect, to: LayoutRect): string {
		const start = edgePoint(from, to);
		const end = edgePoint(to, from);
		const dx = Math.abs(end.x - start.x);
		const dy = Math.abs(end.y - start.y);
		if (dx >= dy) {
			const midX = (start.x + end.x) / 2;
			return `M${start.x},${start.y} L${midX},${start.y} L${midX},${end.y} L${end.x},${end.y}`;
		}
		const midY = (start.y + end.y) / 2;
		return `M${start.x},${start.y} L${start.x},${midY} L${end.x},${midY} L${end.x},${end.y}`;
	}

	function buildBandLayout(nodes: BandNode[], centerUri: string | null): BandLayout {
		const cellByUri = buildReplyChainCells(nodes);
		const cells = nodes
			.map((node) => cellByUri.get(node.post.uri))
			.filter((cell): cell is Omit<BandCell, 'role' | 'sequence'> => Boolean(cell));
		let minCol = 0;
		let maxCol = CENTER_COLS - 1;
		let minRow = 0;
		let maxRow = CENTER_ROWS - 1;

		for (const cell of cells) {
			minCol = Math.min(minCol, cell.col);
			maxCol = Math.max(maxCol, cell.col);
			minRow = Math.min(minRow, cell.row);
			maxRow = Math.max(maxRow, cell.row);
		}

		const originX = BOARD_PADDING - minCol * CELL_WIDTH;
		const originY = BOARD_PADDING - minRow * CELL_HEIGHT;
		const center = {
			x: originX,
			y: originY,
			width: CENTER_WIDTH,
			height: CENTER_HEIGHT
		};
		const nucleus = {
			x: center.x + (center.width - NUCLEUS_WIDTH) / 2,
			y: center.y + (center.height - NUCLEUS_HEIGHT) / 2,
			width: NUCLEUS_WIDTH,
			height: NUCLEUS_HEIGHT
		};
		const slotRectsByUri = new Map<string, LayoutRect>();
		const slots = nodes.map((node, index) => {
			const baseCell =
				cellByUri.get(node.post.uri) ??
				buildShellCells(index + 1)[index] ?? { col: 0, row: 0, ring: 1, side: 'S' as const };
			const cell = {
				...baseCell,
				sequence: index,
				role:
					node.kind === 'quote'
						? ROLES.R
						: node.kind === 'quoteReply'
							? roleForQuoteReply(node, baseCell, cellByUri)
							: roleForCell({ ...baseCell, sequence: index })
			};
			const slot = {
				...cell,
				node,
				x: originX + cell.col * CELL_WIDTH,
				y: originY + cell.row * CELL_HEIGHT,
				width: QUOTE_CARD_WIDTH,
				height: QUOTE_CARD_HEIGHT,
				connectorPath: ''
			};
			slotRectsByUri.set(node.post.uri, slot);
			return slot;
		});

		slots.forEach((slot) => {
			const parentRect =
				slot.node.parentUri && slot.node.parentUri !== centerUri
					? slotRectsByUri.get(slot.node.parentUri) ?? nucleus
					: nucleus;
			slot.connectorPath = connectorPathBetween(parentRect, slot);
		});

		return {
			width: (maxCol - minCol + 1) * CELL_WIDTH - BAND_GAP + BOARD_PADDING * 2,
			height: (maxRow - minRow + 1) * CELL_HEIGHT - BAND_GAP + BOARD_PADDING * 2,
			center,
			nucleus,
			slots,
			ringCount: Math.max(0, ...cells.map((cell) => cell.ring))
		};
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

	function resetQuoteState() {
		quotePosts = [];
		quoteHasMore = false;
		quotesLoadedAll = false;
		quoteLayerOpened = false;
		highlightedPostUri = null;
		quoteReplyRootsByUri = {};
		quoteReplyLoadingByUri = {};
		quoteReplyErrorsByUri = {};
		quoteBranchModeByUri = {};
		quoteReplyRequestIdsByUri.clear();
		quoteError = null;
		quoteLoading = false;
		quoteFetchMode = null;
	}

	async function removeQuoteBranch(uri: string) {
		quoteReplyRequestIdsByUri.delete(uri);

		const nextRoots = { ...quoteReplyRootsByUri };
		delete nextRoots[uri];
		quoteReplyRootsByUri = nextRoots;

		const nextLoading = { ...quoteReplyLoadingByUri };
		delete nextLoading[uri];
		quoteReplyLoadingByUri = nextLoading;

		const nextErrors = { ...quoteReplyErrorsByUri };
		delete nextErrors[uri];
		quoteReplyErrorsByUri = nextErrors;

		const nextModes = { ...quoteBranchModeByUri };
		delete nextModes[uri];
		quoteBranchModeByUri = nextModes;

		if (highlightedPostUri) {
			highlightedPostUri = null;
		}
		await tick();
		scheduleMinimapRefresh();
	}

	async function removeAllQuoteBranches() {
		quoteReplyRequestIdsByUri.clear();
		quoteReplyRootsByUri = {};
		quoteReplyLoadingByUri = {};
		quoteReplyErrorsByUri = {};
		quoteBranchModeByUri = {};
		highlightedPostUri = null;
		await tick();
		scheduleMinimapRefresh();
	}

	async function removeQuotePosts() {
		quoteRequestId += 1;
		resetQuoteState();
		await tick();
		scheduleMinimapRefresh();
	}

	async function toggleCoreReplies() {
		repliesVisible = !repliesVisible;
		highlightedPostUri = null;
		await tick();
		scheduleMinimapRefresh();
	}

	async function centerViewport(behavior: ScrollBehavior = 'auto') {
		await tick();
		if (!viewportEl || !selectedPost) return;
		const centerX = (bandLayout.nucleus.x + bandLayout.nucleus.width / 2) * zoom;
		const centerY = (bandLayout.nucleus.y + bandLayout.nucleus.height / 2) * zoom;
		viewportEl.scrollTo({
			left: Math.max(0, centerX - viewportEl.clientWidth / 2),
			top: Math.max(0, centerY - viewportEl.clientHeight / 2),
			behavior
		});
		scheduleMinimapRefresh();
	}

	function updateMinimapViewport() {
		if (!viewportEl || zoom <= 0) return;
		minimapViewport = {
			x: viewportEl.scrollLeft / zoom,
			y: viewportEl.scrollTop / zoom,
			width: viewportEl.clientWidth / zoom,
			height: viewportEl.clientHeight / zoom
		};
	}

	function scheduleMinimapRefresh() {
		if (typeof window === 'undefined') return;
		if (minimapFrame) cancelAnimationFrame(minimapFrame);
		minimapFrame = requestAnimationFrame(() => {
			minimapFrame = 0;
			updateMinimapViewport();
		});
	}

	function handleViewportScroll() {
		scheduleMinimapRefresh();
	}

	function handleMinimapPointer(event: PointerEvent) {
		if (!viewportEl) return;
		const target = event.currentTarget as SVGSVGElement | null;
		if (!target) return;
		const rect = target.getBoundingClientRect();
		const xRatio = clamp((event.clientX - rect.left) / Math.max(1, rect.width), 0, 1);
		const yRatio = clamp((event.clientY - rect.top) / Math.max(1, rect.height), 0, 1);
		const nextX = xRatio * bandLayout.width;
		const nextY = yRatio * bandLayout.height;
		viewportEl.scrollTo({
			left: Math.max(0, nextX * zoom - viewportEl.clientWidth / 2),
			top: Math.max(0, nextY * zoom - viewportEl.clientHeight / 2),
			behavior: 'smooth'
		});
	}

	async function loadQuotesForCenter(post = selectedPost, fetchAll = false) {
		if (!post) return;
		const requestId = ++quoteRequestId;
		quoteLayerOpened = true;
		quoteLoading = true;
		quoteFetchMode = fetchAll ? 'all' : 'page';
		quoteError = null;

		try {
			const result = await fetchQuotesForPost(
				post.uri,
				fetchAll ? { limit: 100, fetchAll: true } : { limit: 60 }
			);
			if (requestId !== quoteRequestId) return;
			quotePosts = result.posts;
			quoteHasMore = result.hasMore;
			quotesLoadedAll = fetchAll || !result.hasMore;
			await centerViewport('auto');
		} catch (caught) {
			if (requestId !== quoteRequestId) return;
			quoteError = caught instanceof Error ? caught.message : 'Could not load quote posts.';
			quoteHasMore = false;
		} finally {
			if (requestId === quoteRequestId) {
				quoteLoading = false;
				quoteFetchMode = null;
				}
			}
		}

	async function loadRepliesAroundQuote(post: ThreadPost) {
		const uri = post.uri;
		const requestId = ++quoteReplyRequestId;
		quoteReplyRequestIdsByUri.set(uri, requestId);
		quoteReplyLoadingByUri = { ...quoteReplyLoadingByUri, [uri]: true };
		const nextErrors = { ...quoteReplyErrorsByUri };
		delete nextErrors[uri];
		quoteReplyErrorsByUri = nextErrors;

		try {
			const loadedThread = await getFullThread(uri);
			if (quoteReplyRequestIdsByUri.get(uri) !== requestId) return;
			const branchRoot = findFirstMatchingPost(loadedThread.rootPost, (candidate) => candidate.uri === uri);
			if (!branchRoot) {
				throw new Error('Could not find this post in the loaded thread.');
			}

			quoteReplyRootsByUri = {
				...quoteReplyRootsByUri,
				[uri]: branchRoot
			};
			quoteBranchModeByUri = {
				...quoteBranchModeByUri,
				[uri]: 'replies'
			};
			quotePosts = quotePosts.map((quote) => (quote.uri === uri ? branchRoot : quote));
			await tick();
			scheduleMinimapRefresh();
		} catch (caught: any) {
			if (quoteReplyRequestIdsByUri.get(uri) !== requestId) return;
			quoteReplyErrorsByUri = {
				...quoteReplyErrorsByUri,
				[uri]: caught?.message || 'Could not load replies for this post.'
			};
		} finally {
			if (quoteReplyRequestIdsByUri.get(uri) === requestId) {
				quoteReplyLoadingByUri = {
					...quoteReplyLoadingByUri,
					[uri]: false
				};
			}
		}
	}

	async function loadWholeThreadAroundQuote(post: ThreadPost) {
		const uri = post.uri;
		const requestId = ++quoteReplyRequestId;
		quoteReplyRequestIdsByUri.set(uri, requestId);
		quoteReplyLoadingByUri = { ...quoteReplyLoadingByUri, [uri]: true };
		const nextErrors = { ...quoteReplyErrorsByUri };
		delete nextErrors[uri];
		quoteReplyErrorsByUri = nextErrors;

		try {
			const loadedThread = await getFullThread(uri);
			if (quoteReplyRequestIdsByUri.get(uri) !== requestId) return;
			const branchRoot =
				findFirstMatchingPost(loadedThread.rootPost, (candidate) => candidate.uri === uri) ?? post;
			const threadAnchor = buildWholeThreadQuoteAnchor(branchRoot, loadedThread.rootPost);

			quoteReplyRootsByUri = {
				...quoteReplyRootsByUri,
				[uri]: threadAnchor
			};
			quoteBranchModeByUri = {
				...quoteBranchModeByUri,
				[uri]: 'thread'
			};
			quotePosts = quotePosts.map((quote) => (quote.uri === uri ? branchRoot : quote));
			await tick();
			scheduleMinimapRefresh();
		} catch (caught: any) {
			if (quoteReplyRequestIdsByUri.get(uri) !== requestId) return;
			quoteReplyErrorsByUri = {
				...quoteReplyErrorsByUri,
				[uri]: caught?.message || 'Could not load the whole thread for this post.'
			};
		} finally {
			if (quoteReplyRequestIdsByUri.get(uri) === requestId) {
				quoteReplyLoadingByUri = {
					...quoteReplyLoadingByUri,
					[uri]: false
				};
			}
		}
	}

	async function loadBand(bskyUrl: string) {
		const normalizedUrl = normalizeBskyPostUrl(bskyUrl);
		const parsed = normalizedUrl ? parseBskyPostUrl(normalizedUrl) : null;
		if (!normalizedUrl || !parsed) {
			error = 'Invalid URL. Expected format: https://bsky.app/profile/{handle}/post/{rkey}';
			return;
		}

		const requestId = ++loadRequestId;
		loading = true;
		error = null;
		thread = null;
		selectedPost = null;
		repliesVisible = true;
		resetQuoteState();
		urlInput = normalizedUrl;
		updateQueryParam(normalizedUrl);

		try {
			const profile = await getProfile(parsed.handle);
			if (requestId !== loadRequestId) return;
			const atUri = buildAtUri(profile.did, parsed.rkey);
			if (!atUri) {
				error = 'Could not build an AT URI for this post.';
				return;
			}
			const loadedThread = await getFullThread(atUri);
			if (requestId !== loadRequestId) return;
			const centerPost =
				findFirstMatchingPost(loadedThread.rootPost, (post) => post.uri === atUri) ??
				loadedThread.rootPost;

			thread = loadedThread;
			selectedPost = centerPost;
			loading = false;
			await centerViewport('auto');
		} catch (caught: any) {
			if (requestId !== loadRequestId) return;
			if (caught?.message?.includes('resolve')) {
				error = `Could not find handle "${parsed.handle}".`;
			} else {
				error = caught?.message || 'Failed to load this post.';
			}
		} finally {
			if (requestId === loadRequestId) {
				loading = false;
			}
		}
	}

	async function loadBandFromAtUri(atUri: string, fallbackHandle = '') {
		const targetUri = atUri.trim();
		if (!targetUri.startsWith('at://')) {
			error = 'Invalid embedded post URI.';
			return;
		}

		const requestId = ++loadRequestId;
		loading = true;
		error = null;
		thread = null;
		selectedPost = null;
		repliesVisible = true;
		resetQuoteState();
		urlInput = buildBskyPostUrl(targetUri, fallbackHandle) ?? targetUri;
		if (urlInput.startsWith('https://')) {
			updateQueryParam(urlInput);
		}

		try {
			const loadedThread = await getFullThread(targetUri);
			if (requestId !== loadRequestId) return;
			const centerPost =
				findFirstMatchingPost(loadedThread.rootPost, (post) => post.uri === targetUri) ??
				loadedThread.rootPost;

			const canonicalUrl = buildBskyPostUrl(centerPost.uri, centerPost.author.handle);
			if (canonicalUrl) {
				urlInput = canonicalUrl;
				updateQueryParam(canonicalUrl);
			}
			thread = loadedThread;
			selectedPost = centerPost;
			loading = false;
			await centerViewport('auto');
		} catch (caught: any) {
			if (requestId !== loadRequestId) return;
			error = caught?.message || 'Failed to load this embedded post.';
		} finally {
			if (requestId === loadRequestId) {
				loading = false;
			}
		}
	}

	function handleSubmit(event: Event) {
		event.preventDefault();
		if (urlInput.trim()) {
			void loadBand(urlInput.trim());
		}
	}

	function zoomIn() {
		zoom = Math.min(ZOOM_MAX, Number((zoom + ZOOM_STEP).toFixed(2)));
	}

	function zoomOut() {
		zoom = Math.max(ZOOM_MIN, Number((zoom - ZOOM_STEP).toFixed(2)));
	}

	function resetZoom() {
		zoom = 0.54;
		void centerViewport('auto');
	}

	function postUrl(post: ThreadPost): string | null {
		return buildBskyPostUrl(post.uri, post.author.handle);
	}

	function recenterOnPost(post: ThreadPost) {
		const url = postUrl(post);
		if (!url) return;
		void loadBand(url);
	}

	function openRecordEmbed(uri: string, handle: string) {
		void loadBandFromAtUri(uri, handle);
	}

	function handleGlobalKeydown(event: KeyboardEvent) {
		if (event.key !== 'Escape' || !hasHighlightedPath) return;
		clearBandHighlight();
	}

	onMount(() => {
		try {
			const saved = localStorage.getItem('preferred-font');
			if (saved && saved in fontFamilies) fontKey = saved;
		} catch {}

		window.addEventListener('resize', scheduleMinimapRefresh);
		window.addEventListener('keydown', handleGlobalKeydown);
		const params = new URLSearchParams(window.location.search);
			const urlParam = params.get('url');
			if (urlParam) {
				urlInput = urlParam;
				if (urlParam.startsWith('at://')) {
					void loadBandFromAtUri(urlParam);
				} else {
					void loadBand(urlParam);
				}
			}
		});

	onDestroy(() => {
		if (typeof window !== 'undefined') {
			window.removeEventListener('resize', scheduleMinimapRefresh);
			window.removeEventListener('keydown', handleGlobalKeydown);
			if (minimapFrame) cancelAnimationFrame(minimapFrame);
		}
	});

	$effect(() => {
		bandLayout;
		zoom;
		highlightedPostUri;
		if (!viewportEl) return;
		scheduleMinimapRefresh();
	});
</script>

<svelte:head>
	<title>Band</title>
</svelte:head>

{#snippet renderPostEmbed(post: ThreadPost, compact = false)}
	{@const linkedPostUrls = getLinkedBskyPostUrls(post)}
	{#if post.embed || linkedPostUrls.length > 0}
		<div class="post-embed" class:compact data-band-interactive>
			<PostEmbedPreview {post} {compact} />
			{#if post.embed?.record || linkedPostUrls.length > 0}
				<div class="embed-action-row">
					{#if post.embed?.record}
						<button
							type="button"
							class="embed-open-btn"
							onclick={() => {
								openRecordEmbed(post.embed!.record!.uri, post.embed!.record!.author.handle);
							}}
						>
							Open embedded post
						</button>
					{/if}
					{#each linkedPostUrls.slice(0, compact ? 1 : 3) as url, index (url)}
						<button
							type="button"
							class="embed-open-btn"
							onclick={() => {
								void loadBand(url);
							}}
						>
							{linkedPostUrls.length === 1 ? 'Open linked post' : `Open linked post ${index + 1}`}
						</button>
					{/each}
				</div>
			{/if}
		</div>
	{/if}
{/snippet}

<main style="font-family: {fontFamily}">
	<header class="page-header">
		<RouteNav
			current="band"
			align="center"
			threadUrl={urlInput}
			handle={parseBskyPostUrl(urlInput)?.handle ?? null}
		/>
		<h1>Band</h1>
		<p class="subtitle">A Bluesky post in the core, quote posts arranged in clean bands.</p>
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
			Load Band
		</button>
	</form>

	{#if error}
		<div class="error-banner wobbly-border-light">{error}</div>
	{/if}

	{#if loading}
		<LoadingSpinner progress={{ phase: 'Loading post...', current: 0, total: 0 }} />
	{/if}

	{#if selectedPost}
		<section class="band-toolbar wobbly-border-light">
			<div class="band-status" class:error={Boolean(quoteError)}>
				<strong>{growthStatusLabel}</strong>
				{#if bandLayout.ringCount > 0}
					<span>{bandLayout.ringCount} band{bandLayout.ringCount === 1 ? '' : 's'}</span>
				{/if}
			</div>
			<div class="band-actions">
				{#if !quoteLayerOpened}
					<button
						type="button"
						class="tool-btn primary"
						disabled={quoteLoading}
						onclick={() => void loadQuotesForCenter(selectedPost, false)}
					>
						{quoteLoading ? 'Opening quotes...' : 'Open quote posts'}
					</button>
				{:else}
					<button
						type="button"
						class="tool-btn"
						disabled={quoteLoading}
						onclick={() => void loadQuotesForCenter(selectedPost, false)}
					>
						Reload quotes
					</button>
				{/if}
				{#if quoteLayerOpened && (quoteHasMore || (!quotesLoadedAll && expectedQuoteCount > quotePosts.length))}
					<button
						type="button"
						class="tool-btn primary"
						disabled={quoteLoading}
						onclick={() => void loadQuotesForCenter(selectedPost, true)}
					>
						{quoteLoading && quoteFetchMode === 'all' ? 'Loading all...' : 'Load all'}
					</button>
				{/if}
				{#if allReplyNodes.length > 0}
					<button type="button" class="tool-btn" onclick={() => void toggleCoreReplies()}>
						{repliesVisible ? 'Remove replies' : 'Show replies'}
					</button>
				{/if}
				{#if quoteReplyNodes.length > 0}
					<button type="button" class="tool-btn" onclick={() => void removeAllQuoteBranches()}>
						Remove side replies
					</button>
				{/if}
				{#if quoteLayerOpened}
					<button type="button" class="tool-btn" disabled={quoteLoading} onclick={() => void removeQuotePosts()}>
						Remove quote posts
					</button>
				{/if}
				<button type="button" class="icon-btn" aria-label="Zoom out" onclick={zoomOut} disabled={zoom <= ZOOM_MIN}>
					-
				</button>
				<span class="zoom-label">{Math.round(zoom * 100)}%</span>
				<button type="button" class="icon-btn" aria-label="Zoom in" onclick={zoomIn} disabled={zoom >= ZOOM_MAX}>
					+
				</button>
					<button type="button" class="tool-btn" onclick={resetZoom}>Reset</button>
					<button type="button" class="tool-btn" onclick={() => void centerViewport('smooth')}>Center</button>
					{#if hasHighlightedPath}
						<button type="button" class="tool-btn" onclick={clearBandHighlight}>Clear marks</button>
					{/if}
				</div>
			</section>

		{#if thread?.isTruncated}
			<p class="truncation-warning">Some replies may be missing.</p>
		{/if}

		<div class="band-viewport wobbly-border-light" bind:this={viewportEl} onscroll={handleViewportScroll}>
			<div
				class="band-canvas"
				style={`width:${Math.round(bandLayout.width * zoom)}px;height:${Math.round(bandLayout.height * zoom)}px;`}
			>
				<div
					class="band-stage"
					style={`width:${bandLayout.width}px;height:${bandLayout.height}px;transform:scale(${zoom});`}
				>
					<svg
						class="band-connectors"
						viewBox={`0 0 ${bandLayout.width} ${bandLayout.height}`}
						aria-hidden="true"
					>
						{#each bandLayout.slots as slot (`${slot.node.kind}:${slot.node.post.uri}`)}
								<path
									d={slot.connectorPath}
									class="band-connector"
									class:reply-connector={slot.node.kind === 'reply' || slot.node.kind === 'quoteReply'}
									class:quote-connector={slot.node.kind === 'quote'}
									class:path-connector={connectorIsHighlighted(slot)}
								class:dimmed-connector={connectorIsDimmed(slot)}
								style={`--role-color:${slot.role.color};`}
							/>
						{/each}
					</svg>

					<div
						class="core-region"
						style={`left:${bandLayout.center.x}px;top:${bandLayout.center.y}px;width:${bandLayout.center.width}px;height:${bandLayout.center.height}px;`}
						aria-hidden="true"
					></div>

						<div
							class="center-post"
								class:path-active={highlightedPathUris.has(selectedPost.uri)}
								role="button"
								tabindex="0"
								onclick={(event) => handleBandCardClick(event, selectedPost.uri)}
								onkeydown={(event) => handleBandCardKeydown(event, selectedPost.uri)}
							style={`left:${bandLayout.nucleus.x}px;top:${bandLayout.nucleus.y}px;width:${bandLayout.nucleus.width}px;height:${bandLayout.nucleus.height}px;`}
						>
						<div class="center-kicker">Core post</div>
						<header class="post-header">
							{#if selectedPost.author.avatar}
								<img src={selectedPost.author.avatar} alt="" class="avatar large" />
							{:else}
								<span class="avatar placeholder large">{selectedPost.author.handle.slice(0, 1).toUpperCase()}</span>
							{/if}
							<div class="author-block">
								<strong>{selectedPost.author.displayName || selectedPost.author.handle}</strong>
								<span>@{selectedPost.author.handle}</span>
							</div>
							<span class="post-date">{formatDate(selectedPost.createdAt)}</span>
						</header>
						<p class="center-text">{selectedPost.text || 'No text'}</p>
						{@render renderPostEmbed(selectedPost)}
						<footer class="post-footer">
							<span>{formatCount(selectedPost.replyCount)} replies</span>
							<span>{formatCount(selectedPost.repostCount)} reposts</span>
								<span>{formatCount(selectedPost.likeCount)} likes</span>
								<span>{formatCount(selectedPost.quoteCount)} quotes</span>
								{#if selectedPostUrl}
									<a
										href={selectedPostUrl}
										target="_blank"
										rel="noreferrer"
										onclick={(event) => event.stopPropagation()}
									>
										Open
									</a>
								{/if}
							</footer>
					</div>

					{#if growthNodes.length === 0 && !quoteLoading}
						<div
							class="empty-band-note"
							style={`left:${bandLayout.center.x}px;top:${bandLayout.center.y + bandLayout.center.height + BAND_GAP}px;width:${bandLayout.center.width}px;`}
						>
							No replies are loaded around this post yet.
						</div>
					{/if}

					{#each bandLayout.slots as slot, index (`${slot.node.kind}:${slot.node.post.uri}`)}
							<div
									class="quote-card"
									class:inner-ring={slot.ring === 1}
									class:quote-node={slot.node.kind === 'quote'}
									class:quote-reply-node={slot.node.kind === 'quoteReply'}
									class:path-active={slotIsHighlighted(slot)}
									class:path-dimmed={slotIsDimmed(slot)}
									role="button"
									tabindex="0"
									onclick={(event) => handleBandCardClick(event, slot.node.post.uri)}
									onkeydown={(event) => handleBandCardKeydown(event, slot.node.post.uri)}
								style={`left:${slot.x}px;top:${slot.y}px;width:${slot.width}px;height:${slot.height}px;--role-color:${slot.role.color};`}
							>
								<div class="role-strip">
									<span>{slot.node.kind === 'quote' ? 'Q' : slot.role.code}</span>
									<small>
										{slot.node.kind === 'quote'
											? 'quote post'
											: slot.node.kind === 'quoteReply'
												? `quote reply depth ${slot.node.depth}`
												: `reply depth ${slot.node.depth}`}
									</small>
								</div>
							<header class="post-header compact">
								{#if slot.node.post.author.avatar}
									<img src={slot.node.post.author.avatar} alt="" class="avatar" />
								{:else}
									<span class="avatar placeholder">{slot.node.post.author.handle.slice(0, 1).toUpperCase()}</span>
								{/if}
								<div class="author-block">
									<strong>{slot.node.post.author.displayName || slot.node.post.author.handle}</strong>
									<span>@{slot.node.post.author.handle}</span>
								</div>
								<span class="slot-number">#{index + 1}</span>
							</header>
							<p class="quote-text">{slot.node.post.text || 'No text'}</p>
							{@render renderPostEmbed(slot.node.post, true)}
							<footer class="quote-footer">
									<span>{formatDate(slot.node.post.createdAt)}</span>
									<span>{formatCount(slot.node.post.likeCount)} likes</span>
									{#if slot.node.kind === 'quote'}
										<div class="quote-action-group">
											<button
												type="button"
												disabled={isQuoteRepliesLoading(slot.node.post.uri)}
												onclick={(event) => {
													event.stopPropagation();
													void loadRepliesAroundQuote(slot.node.post);
												}}
											>
												{#if isQuoteRepliesLoading(slot.node.post.uri)}
													Loading...
												{:else if getQuoteBranchMode(slot.node.post.uri) === 'replies'}
													{getOpenedQuoteReplyCount(slot.node.post.uri)} replies
												{:else}
													Show replies
												{/if}
											</button>
											<button
												type="button"
												disabled={isQuoteRepliesLoading(slot.node.post.uri)}
												onclick={(event) => {
													event.stopPropagation();
													void loadWholeThreadAroundQuote(slot.node.post);
												}}
											>
												Load whole thread
											</button>
											{#if hasOpenedQuoteReplies(slot.node.post.uri)}
												<button
													type="button"
													onclick={(event) => {
														event.stopPropagation();
														void removeQuoteBranch(slot.node.post.uri);
													}}
												>
													Remove replies
												</button>
											{/if}
										</div>
									{:else}
										<button
											type="button"
											onclick={(event) => {
												event.stopPropagation();
												recenterOnPost(slot.node.post);
											}}
										>
											Center
										</button>
									{/if}
									{#if slot.node.kind === 'quote' && getQuoteReplyError(slot.node.post.uri)}
										<span class="quote-reply-error">{getQuoteReplyError(slot.node.post.uri)}</span>
									{/if}
								{#if postUrl(slot.node.post)}
									<a
										href={postUrl(slot.node.post)}
										target="_blank"
										rel="noreferrer"
										onclick={(event) => event.stopPropagation()}
									>
										Open
									</a>
								{/if}
							</footer>
						</div>
					{/each}
				</div>
			</div>
		</div>

		<svg
			class="band-minimap wobbly-border-light"
			viewBox={`0 0 ${Math.max(1, bandLayout.width)} ${Math.max(1, bandLayout.height)}`}
			role="button"
			tabindex="0"
			aria-label="Band minimap"
			onpointerdown={handleMinimapPointer}
			onkeydown={(event) => {
				if (event.key === 'Enter' || event.key === ' ') {
					event.preventDefault();
					void centerViewport('smooth');
				}
			}}
		>
			<rect x="0" y="0" width={bandLayout.width} height={bandLayout.height} class="minimap-bg" />
			<rect
				x={bandLayout.center.x}
				y={bandLayout.center.y}
				width={bandLayout.center.width}
				height={bandLayout.center.height}
				class="minimap-core"
			/>
			<rect
				x={bandLayout.nucleus.x}
				y={bandLayout.nucleus.y}
				width={bandLayout.nucleus.width}
				height={bandLayout.nucleus.height}
				class="minimap-nucleus"
			/>
			{#each minimapSlots as slot (slot.key)}
				<rect
					x={slot.x}
					y={slot.y}
					width={slot.width}
					height={slot.height}
					class="minimap-card"
					class:minimap-card-quote={slot.kind === 'quote'}
					class:minimap-card-active={slot.isActive}
					class:minimap-card-dimmed={slot.isDimmed}
				/>
			{/each}
			<rect
				x={minimapViewport.x}
				y={minimapViewport.y}
				width={minimapViewport.width}
				height={minimapViewport.height}
				class="minimap-window"
			/>
		</svg>
	{/if}
</main>

<style>
	main {
		max-width: 100%;
		margin: 0 auto;
		padding: 32px 20px 42px;
	}

	.page-header {
		text-align: center;
		margin: 0 auto 24px;
		max-width: 1240px;
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
		max-width: 720px;
		margin: 0 auto 18px;
	}

	.url-input {
		flex: 1;
		min-width: 0;
		padding: 10px 14px;
		font-family: inherit;
		font-size: 0.95rem;
		background: var(--input-bg);
		color: var(--text-ink);
	}

	.url-input::placeholder {
		color: var(--muted);
		opacity: 0.72;
	}

	.load-btn,
	.tool-btn,
	.icon-btn {
		font-family: inherit;
		border: 1.5px solid var(--border-color);
		background: var(--control-bg);
		color: var(--text-ink);
		cursor: pointer;
		transition:
			transform 140ms ease,
			opacity 140ms ease,
			background 140ms ease;
	}

	.load-btn {
		padding: 10px 20px;
		background: var(--accent);
		color: var(--accent-contrast);
		white-space: nowrap;
	}

	.tool-btn {
		padding: 7px 11px;
		border-radius: 8px;
		font-weight: 700;
	}

	.tool-btn.primary {
		background: color-mix(in srgb, var(--accent) 82%, white 18%);
		color: var(--accent-contrast);
	}

	.icon-btn {
		width: 34px;
		height: 34px;
		border-radius: 50%;
		font-size: 1rem;
		font-weight: 850;
	}

	.load-btn:hover:not(:disabled),
	.tool-btn:hover:not(:disabled),
	.icon-btn:hover:not(:disabled) {
		transform: translateY(-1px);
		background: var(--control-bg-hover);
	}

	.load-btn:hover:not(:disabled),
	.tool-btn.primary:hover:not(:disabled) {
		background: color-mix(in srgb, var(--accent) 88%, black 12%);
	}

	button:disabled {
		cursor: not-allowed;
		opacity: 0.52;
	}

	.error-banner {
		max-width: 720px;
		margin: 0 auto 16px;
		padding: 10px 16px;
		background: var(--error-bg);
		color: var(--danger-text);
		text-align: center;
		font-size: 0.95rem;
	}

	.band-toolbar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 16px;
		max-width: 1240px;
		margin: 0 auto 14px;
		padding: 10px 12px;
		background: var(--panel-bg-plain);
	}

	.band-status {
		display: flex;
		flex-wrap: wrap;
		gap: 10px;
		align-items: center;
		color: var(--muted);
		font-size: 0.92rem;
	}

	.band-status strong {
		color: var(--text-ink);
	}

	.band-status.error strong {
		color: var(--danger-text);
	}

	.band-actions {
		display: flex;
		flex-wrap: wrap;
		justify-content: flex-end;
		gap: 8px;
		align-items: center;
	}

	.zoom-label {
		min-width: 46px;
		text-align: center;
		font-weight: 800;
		color: var(--text-ink);
	}

	.truncation-warning {
		max-width: 1240px;
		margin: 0 auto 12px;
		padding: 8px 12px;
		border: 1px solid color-mix(in srgb, #e69a38 60%, var(--border-color));
		border-radius: 8px;
		background: color-mix(in srgb, #e69a38 16%, var(--card-bg));
		color: var(--text-ink);
	}

	.band-viewport {
		position: relative;
		height: clamp(540px, 74vh, 920px);
		max-width: 100%;
		overflow: auto;
		background:
			linear-gradient(rgba(21, 21, 21, 0.035) 1px, transparent 1px),
			linear-gradient(90deg, rgba(21, 21, 21, 0.035) 1px, transparent 1px),
			#ece6d8;
		background-size: 28px 28px;
		box-shadow: var(--shadow-soft);
	}

	.band-canvas {
		position: relative;
		min-width: 100%;
		min-height: 100%;
	}

	.band-stage {
		position: absolute;
		inset: 0 auto auto 0;
		transform-origin: top left;
	}

	.band-connectors {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		pointer-events: none;
		overflow: visible;
	}

	.band-connector {
		fill: none;
		stroke: color-mix(in srgb, var(--role-color) 72%, #151515 28%);
		stroke-width: 5;
		stroke-linecap: square;
		stroke-linejoin: miter;
		opacity: 0.72;
	}

	.band-connector.reply-connector {
		stroke: color-mix(in srgb, var(--role-color) 54%, #151515 46%);
	}

	.band-connector.quote-connector {
		stroke: color-mix(in srgb, #d7be63 68%, #151515 32%);
		stroke-dasharray: 18 12;
		opacity: 0.66;
	}

	.band-connector.path-connector {
		stroke: #151515;
		stroke-width: 9;
		opacity: 0.95;
	}

	.band-connector.dimmed-connector {
		opacity: 0.12;
	}

	.core-region,
	.center-post,
	.quote-card,
	.empty-band-note {
		position: absolute;
	}

	.core-region {
		border: 3px solid #151515;
		border-radius: 6px;
		background:
			linear-gradient(rgba(21, 21, 21, 0.028) 1px, transparent 1px),
			linear-gradient(90deg, rgba(21, 21, 21, 0.028) 1px, transparent 1px),
			#fffef9;
		background-size: 22px 22px;
		box-shadow: inset 0 0 0 10px rgba(255, 255, 255, 0.45);
		z-index: 2;
	}

	.center-post {
		display: flex;
		flex-direction: column;
		gap: 11px;
		padding: 18px;
		border: 3px solid #151515;
		border-radius: 6px;
		background: #fffef9;
		box-shadow: 0 18px 44px rgba(41, 34, 25, 0.16);
		z-index: 20;
		cursor: pointer;
		transition:
			box-shadow 160ms ease,
			opacity 160ms ease,
			transform 160ms ease;
	}

	.center-post.path-active {
		box-shadow:
			0 0 0 7px rgba(21, 21, 21, 0.16),
			0 20px 54px rgba(41, 34, 25, 0.2);
	}

	.center-kicker {
		align-self: flex-start;
		padding: 4px 9px;
		border: 1px solid rgba(21, 21, 21, 0.2);
		border-radius: 999px;
		background: #ffffff;
		color: #3f3a32;
		font-size: 0.76rem;
		font-weight: 850;
		text-transform: uppercase;
		letter-spacing: 0;
	}

	.post-header {
		display: flex;
		align-items: center;
		gap: 10px;
		min-width: 0;
	}

	.post-header.compact {
		gap: 8px;
	}

	.avatar {
		width: 34px;
		height: 34px;
		flex: 0 0 auto;
		border: 1px solid rgba(21, 21, 21, 0.16);
		border-radius: 50%;
		object-fit: cover;
		background: #fff;
	}

	.avatar.large {
		width: 48px;
		height: 48px;
	}

	.avatar.placeholder {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		background: color-mix(in srgb, var(--accent) 20%, white 80%);
		font-weight: 900;
	}

	.author-block {
		display: grid;
		min-width: 0;
		line-height: 1.15;
	}

	.author-block strong,
	.author-block span {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.author-block strong {
		color: #151515;
		font-size: 1rem;
	}

	.author-block span,
	.post-date,
	.slot-number {
		color: #5d584e;
		font-size: 0.8rem;
	}

	.post-date,
	.slot-number {
		margin-left: auto;
		white-space: nowrap;
	}

	.center-text {
		flex: 1;
		min-height: 0;
		overflow: auto;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
		color: #151515;
		font-size: 1.05rem;
		line-height: 1.34;
	}

	.post-embed {
		display: grid;
		gap: 8px;
		max-height: 168px;
		overflow: auto;
		padding: 8px;
		border: 1px solid rgba(21, 21, 21, 0.12);
		border-radius: 6px;
		background: rgba(255, 255, 255, 0.62);
	}

		.post-embed.compact {
			max-height: 128px;
			padding: 7px;
		}

		.post-embed :global(.post-embed-preview) {
			margin-top: 0;
			gap: 8px;
		}

		.post-embed :global(.record-embed) {
			margin: 0;
			border-radius: 6px;
			background: rgba(255, 254, 249, 0.74);
		}

		.post-embed :global(.embed-link) {
			border-radius: 6px;
			background: rgba(255, 254, 249, 0.74);
		}

		.post-embed :global(.embed-video video) {
			border-radius: 6px;
		}

		.embed-action-row {
			display: flex;
			flex-wrap: wrap;
			gap: 6px;
		}

	.embed-open-btn {
		justify-self: start;
		padding: 5px 8px;
		border: 1px solid rgba(21, 21, 21, 0.22);
		border-radius: 7px;
		background: rgba(255, 255, 255, 0.74);
		color: #151515;
		font-family: inherit;
		font-size: 0.74rem;
		font-weight: 850;
		cursor: pointer;
	}

		.post-footer,
	.quote-footer {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		align-items: center;
		color: #5d584e;
		font-size: 0.8rem;
	}

	.post-footer a,
	.quote-footer a,
	.quote-footer button {
		margin-left: auto;
		padding: 4px 7px;
		border: 1px solid rgba(21, 21, 21, 0.18);
		border-radius: 7px;
		background: rgba(255, 255, 255, 0.72);
		color: #151515;
		font-family: inherit;
		font-size: 0.76rem;
		font-weight: 800;
		line-height: 1;
		text-decoration: none;
		cursor: pointer;
	}

	.quote-footer a {
		margin-left: 0;
	}

	.quote-action-group {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
		margin-left: auto;
	}

	.quote-action-group button {
		margin-left: 0;
	}

	.quote-card {
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding: 10px 11px 9px;
		border: 2px solid color-mix(in srgb, var(--role-color) 64%, #151515 36%);
		border-radius: 6px;
		background:
			linear-gradient(90deg, color-mix(in srgb, var(--role-color) 20%, transparent) 0 6px, transparent 6px),
			color-mix(in srgb, var(--role-color) 15%, #fffef9 85%);
		box-shadow: 0 10px 24px rgba(41, 34, 25, 0.13);
		z-index: 10;
		cursor: pointer;
		transition:
			opacity 160ms ease,
			box-shadow 160ms ease,
			transform 160ms ease,
			border-color 160ms ease;
	}

	.quote-card.inner-ring {
		border-width: 2.5px;
		box-shadow: 0 12px 28px rgba(41, 34, 25, 0.17);
	}

	.quote-card.path-active {
		border-color: #151515;
		box-shadow:
			0 0 0 7px rgba(21, 21, 21, 0.15),
			0 18px 38px rgba(41, 34, 25, 0.24);
		transform: translateY(-2px);
		z-index: 18;
	}

	.quote-card.path-dimmed {
		opacity: 0.32;
	}

	.quote-card.quote-node {
		border-color: color-mix(in srgb, #151515 42%, #d7be63 58%);
		background:
			linear-gradient(90deg, rgba(215, 190, 99, 0.32) 0 6px, transparent 6px),
			color-mix(in srgb, #d7be63 22%, #fffef9 78%);
	}

		.quote-card.quote-node .role-strip span {
			background: #d7be63;
		}

		.quote-card.quote-reply-node {
			background:
				linear-gradient(90deg, color-mix(in srgb, var(--role-color) 28%, transparent) 0 6px, transparent 6px),
				color-mix(in srgb, #d7be63 10%, #fffef9 90%);
		}

		.quote-reply-error {
			flex-basis: 100%;
			color: #9b2f24;
			font-size: 0.72rem;
			font-weight: 800;
			overflow-wrap: anywhere;
		}

		.role-strip {
		display: flex;
		align-items: center;
		gap: 7px;
		color: #151515;
		line-height: 1;
	}

	.role-strip span {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 24px;
		height: 24px;
		border: 1.5px solid #151515;
		border-radius: 4px;
		background: var(--role-color);
		font-size: 0.8rem;
		font-weight: 950;
	}

	.role-strip small {
		overflow: hidden;
		color: #3f3a32;
		font-size: 0.72rem;
		font-weight: 850;
		text-overflow: ellipsis;
		text-transform: uppercase;
		white-space: nowrap;
		letter-spacing: 0;
	}

	.quote-card .author-block strong {
		font-size: 0.84rem;
	}

	.quote-card .author-block span {
		font-size: 0.74rem;
	}

	.quote-text {
		flex: 1;
		min-height: 0;
		overflow: auto;
		padding: 8px 9px;
		border: 1px solid rgba(21, 21, 21, 0.1);
		border-radius: 5px;
		background: rgba(255, 255, 255, 0.54);
		color: #151515;
		font-size: 1.02rem;
		line-height: 1.34;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}

	.quote-footer {
		gap: 6px;
		font-size: 0.72rem;
		line-height: 1.1;
	}

	.empty-band-note {
		padding: 12px 14px;
		border: 1.5px dashed rgba(21, 21, 21, 0.24);
		border-radius: 8px;
		background: rgba(255, 254, 249, 0.84);
		color: #5d584e;
		text-align: center;
		z-index: 5;
	}

	.band-minimap {
		position: fixed;
		right: 24px;
		bottom: 24px;
		z-index: 80;
		width: min(260px, calc(100vw - 32px));
		height: 176px;
		padding: 8px;
		background: rgba(255, 254, 249, 0.9);
		box-shadow: 0 18px 46px rgba(41, 34, 25, 0.22);
		cursor: crosshair;
	}

	.minimap-bg {
		fill: #ece6d8;
	}

	.minimap-core {
		fill: #fffef9;
		stroke: rgba(21, 21, 21, 0.54);
		stroke-width: 12;
	}

	.minimap-nucleus {
		fill: #fff6cf;
		stroke: #151515;
		stroke-width: 14;
	}

	.minimap-card {
		fill: rgba(75, 158, 208, 0.58);
		stroke: rgba(21, 21, 21, 0.56);
		stroke-width: 10;
	}

	.minimap-card-quote {
		fill: rgba(215, 190, 99, 0.72);
	}

	.minimap-card-active {
		fill: #151515;
		stroke: #151515;
	}

	.minimap-card-dimmed {
		opacity: 0.18;
	}

	.minimap-window {
		fill: rgba(255, 255, 255, 0.12);
		stroke: #e07a5f;
		stroke-width: 18;
		vector-effect: non-scaling-stroke;
	}

	@media (max-width: 720px) {
		main {
			padding: 24px 12px 32px;
		}

		.url-form,
		.band-toolbar {
			flex-direction: column;
			align-items: stretch;
		}

		.band-actions {
			justify-content: flex-start;
		}

		.load-btn {
			width: 100%;
		}

		.band-minimap {
			right: 12px;
			bottom: 12px;
			width: min(190px, calc(100vw - 24px));
			height: 128px;
		}
	}
</style>
