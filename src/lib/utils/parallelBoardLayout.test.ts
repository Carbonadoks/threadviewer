import test from 'node:test';
import assert from 'node:assert/strict';
import type { ThreadPost } from '../types';
import {
	assignLaneColumns,
	clipCubicToRect,
	cullConnectorsToRect,
	LaneCardLayoutCache,
	type CubicCurve,
	type LaneConnector,
	type LanePlacement,
	type LaneRenderModel
} from './parallelBoardLayout';

const mainId = 'main';

// Compatibility oracle: the original column-shifting algorithm.
function legacyColumns(entries: LanePlacement[]) {
	const columns = new Map([[mainId, 0]]);
	const byId = new Map(entries.map((entry) => [entry.id, entry]));
	function assign(id: string) {
		if (columns.has(id)) return;
		const entry = byId.get(id);
		if (!entry) return;
		assign(entry.sourceLaneId);
		const desired = (columns.get(entry.sourceLaneId) ?? 0) + (entry.direction === 'inbound' ? -1 : 1);
		for (const [other, column] of columns) {
			if (entry.direction === 'inbound' && column <= desired) columns.set(other, column - 1);
			if (entry.direction === 'outbound' && column >= desired) columns.set(other, column + 1);
		}
		columns.set(id, desired);
	}
	for (const entry of entries) assign(entry.id);
	return columns;
}

test('preserves adjacent insertion, mixed directions and parents loaded later', () => {
	const entries: LanePlacement[] = [
		{ id: 'child', sourceLaneId: 'a', direction: 'outbound' },
		{ id: 'a', sourceLaneId: mainId, direction: 'inbound' },
		{ id: 'b', sourceLaneId: mainId, direction: 'outbound' },
		{ id: 'c', sourceLaneId: mainId, direction: 'inbound' },
		{ id: 'orphan', sourceLaneId: 'missing', direction: 'outbound' }
	];
	assert.deepEqual(assignLaneColumns(mainId, entries), legacyColumns(entries));
});

test('matches old placement across deterministic branching load orders', () => {
	let seed = 42;
	const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
	for (let run = 0; run < 50; run++) {
		const entries: LanePlacement[] = Array.from({ length: 120 }, (_, index) => ({
			id: `lane-${index}`,
			sourceLaneId: index > 0 && random() % 3 !== 0 ? `lane-${random() % index}` : mainId,
			direction: random() % 2 ? 'inbound' : 'outbound'
		}));
		for (let i = entries.length - 1; i > 0; i--) {
			const j = random() % (i + 1);
			[entries[i], entries[j]] = [entries[j], entries[i]];
		}
		assert.deepEqual(assignLaneColumns(mainId, entries), legacyColumns(entries));
	}
});

test('places 10,000 nested lanes without recursive stack growth', () => {
	const entries: LanePlacement[] = Array.from({ length: 10_000 }, (_, index) => ({
		id: `lane-${index}`, sourceLaneId: index ? `lane-${index - 1}` : mainId, direction: 'outbound'
	}));
	const columns = assignLaneColumns(mainId, entries.reverse());
	assert.equal(columns.size, 10_001);
	assert.equal(columns.get(mainId), 0);
	assert.equal(columns.get('lane-9999'), 10_000);
});

test('invalid cycles terminate with unique columns', () => {
	const columns = assignLaneColumns(mainId, [
		{ id: 'a', sourceLaneId: 'b', direction: 'inbound' },
		{ id: 'b', sourceLaneId: 'a', direction: 'outbound' }
	]);
	assert.equal(columns.size, 3);
	assert.equal(new Set(columns.values()).size, 3);
});

function post(uri: string, children: ThreadPost[] = []): ThreadPost {
	return {
		uri, cid: uri, author: { did: 'did:test', handle: 'test' }, text: uri,
		createdAt: '2026-01-01', likeCount: 0, repostCount: 0, replyCount: children.length, quoteCount: 0, children
	};
}
function fixture() {
	const a = post('a'); const b = post('b'); const root = post('root', [a, b]);
	const lane: LaneRenderModel = {
		id: mainId, kind: 'main', label: 'Present', title: '@test', handle: 'test', anchorUri: root.uri,
		thread: { rootPost: root, rootUri: root.uri, depth: 2 }, loadedAt: 0, column: 9, depthOffset: 7, x: 1234,
		activeChainId: '0.0', chains: [{ id: '0.0', order: 0, posts: [root, a] }, { id: '0.1', order: 1, posts: [root, b] }],
		activeCards: [], maxDepth: 2, cards: []
	};
	return { lane, depths: new Map([['root', 0], ['a', 1], ['b', 1]]) };
}

test('local layouts preserve active and shadow branches independently of board position', () => {
	const { lane, depths } = fixture();
	const layout = new LaneCardLayoutCache().get(lane, false, depths, 398);
	assert.deepEqual(layout.cards.map((card) => [card.post.uri, card.depth, card.visibility, card.x]), [
		['root', 0, 'active', 0], ['b', 1, 'shadow', 0], ['a', 1, 'active', 0]
	]);
	assert.deepEqual(layout.cards.find((card) => card.post.uri === 'a')?.switchGroupChainIds, ['0.0', '0.1']);
});

test('tree fan aligns its anchor and keeps connectors attached to local cards', () => {
	const { lane, depths } = fixture();
	const layout = new LaneCardLayoutCache().get({ ...lane, anchorUri: 'a' }, true, depths, 398);
	assert.deepEqual(layout.cards.map((card) => [card.post.uri, card.x]), [['root', 199], ['a', 0], ['b', 398]]);
	assert.equal(layout.connectors.length, 2);
	for (const edge of layout.connectors) {
		assert.ok(layout.cards.includes(edge.from));
		assert.ok(layout.cards.includes(edge.to));
	}
});

test('cache reuses geometry across board movement and invalidates branch, tree, anchor and content changes', () => {
	const { lane, depths } = fixture();
	const cache = new LaneCardLayoutCache();
	const initial = cache.get(lane, false, depths, 398);
	assert.equal(cache.get({ ...lane, x: 9000, depthOffset: -10 }, false, depths, 398), initial);
	const switched = cache.get({ ...lane, activeChainId: '0.1' }, false, depths, 398);
	assert.notEqual(switched, initial);
	assert.equal(switched.cards.find((card) => card.post.uri === 'b')?.visibility, 'active');
	const expanded = cache.get(lane, true, depths, 398);
	assert.notEqual(expanded, switched);
	const anchored = cache.get({ ...lane, anchorUri: 'b' }, true, depths, 398);
	assert.notEqual(anchored, expanded);
	const replaced = cache.get({ ...lane, thread: { ...lane.thread, rootPost: { ...lane.thread.rootPost } } }, true, depths, 398);
	assert.notEqual(replaced, anchored);
	const relabeled = cache.get({ ...lane, label: 'Q99' }, false, depths, 398);
	assert.ok(relabeled.cards.every((card) => card.laneLabel === 'Q99'));
	cache.retain(new Set());
	assert.notEqual(cache.get({ ...lane, label: 'Q99' }, false, depths, 398), relabeled);
});

test('clipCubicToRect finds the visible part of a curve, not its bounding box', () => {
	const rect = { left: 1000, top: 0, right: 2000, bottom: 1000 };
	// S-curve from (0, 0) to (10000, 5000) bending at x = 5000: its box covers the rect,
	// but at x 1000..2000 the curve has only risen to y ≈ 70..290.
	const sCurve = [0, 0, 5000, 0, 5000, 5000, 10000, 5000] as const;
	const visible = clipCubicToRect(sCurve, rect);
	assert.ok(visible);
	assert.ok(visible.top > 50 && visible.bottom < 350, `unexpected visible part ${JSON.stringify(visible)}`);

	// Same box, but the rect sits where the curve is not.
	assert.equal(clipCubicToRect(sCurve, { left: 1000, top: 3000, right: 2000, bottom: 4000 }), null);

	// A curve entirely inside is returned whole.
	const inside = clipCubicToRect([1100, 100, 1200, 100, 1300, 200, 1400, 200], rect);
	assert.deepEqual(inside, { left: 1100, top: 100, right: 1400, bottom: 200 });
});

test('cullConnectorsToRect collapses overlapping pass-through fans from one source', () => {
	const card = (key: string, x: number) => ({ key, x }) as unknown as LaneConnector['from'];
	const source = card('main:root', 0);
	const connectors: LaneConnector[] = Array.from({ length: 500 }, (_, index) => ({
		key: `c${index}`,
		from: source,
		to: card(`lane${index}:root`, 20000 + index * 400),
		kind: 'spawn'
	}));
	// Each spawn bends halfway to its target and ends at y = 100, like quote lanes whose
	// roots share a row; the view sits between the source and every target.
	const curveOf = (connector: LaneConnector): CubicCurve => {
		const endX = connector.to.x;
		const bendX = endX / 2;
		return [360, 100, bendX, 100, bendX, 100, endX, 100];
	};
	const view = { left: 3000, top: 0, right: 5000, bottom: 1000 };
	const kept = cullConnectorsToRect(connectors, curveOf, view);
	assert.equal(kept.length, 1);

	// A connector that ends inside the view is always kept.
	const ending: LaneConnector = { key: 'end', from: source, to: card('near:root', 4000), kind: 'spawn' };
	const keptWithEnd = cullConnectorsToRect([...connectors, ending], (c) =>
		c === ending ? [360, 100, 2000, 100, 2000, 100, 4000, 100] : curveOf(c), view);
	assert.equal(keptWithEnd.length, 2);
	assert.ok(keptWithEnd.includes(ending));
});

test('cullConnectorsToRect merges a fan leaving a source that is in view', () => {
	const card = (key: string, x: number) => ({ key, x }) as unknown as LaneConnector['from'];
	const source = card('main:root', 0);
	// New quote lanes sit right next to their source, so the source is on screen and
	// thousands of spawns leave it together, bending far to the right.
	const connectors: LaneConnector[] = Array.from({ length: 5000 }, (_, index) => ({
		key: `c${index}`,
		from: source,
		to: card(`lane${index}:root`, 40000 + index * 400),
		kind: 'spawn'
	}));
	const curveOf = (connector: LaneConnector): CubicCurve => {
		const startX = 360;
		const endX = connector.to.x - 8;
		const bendX = startX + (endX - startX) * 0.48;
		return [startX, 300, bendX, 300, bendX, 180, endX, 180];
	};
	const view = { left: -600, top: -600, right: 3000, bottom: 1600 };
	const kept = cullConnectorsToRect(connectors, curveOf, view);
	assert.ok(kept.length <= 3, `expected the fan to collapse, kept ${kept.length}`);
});

test('cullConnectorsToRect caps distinct pass-through lines and keeps lines entirely in view', () => {
	const card = (key: string, x: number) => ({ key, x }) as unknown as LaneConnector['from'];
	// 3,000 lines from different sources, each crossing the view at its own height.
	const connectors: LaneConnector[] = Array.from({ length: 3000 }, (_, index) => ({
		key: `c${index}`,
		from: card(`src${index}:post`, 0),
		to: card(`lane${index}:root`, 50000),
		kind: 'reference'
	}));
	const curveOf = (connector: LaneConnector): CubicCurve => {
		const y = Number(connector.key.slice(1)) * 0.5;
		return [0, y, 10000, y, 40000, y, 50000, y];
	};
	const ending: LaneConnector = { key: 'end', from: card('a:b', 1200), to: card('c:d', 1500), kind: 'spawn' };
	const all = [...connectors, ending];
	const stats = { crossing: 0, local: 0, sources: 0, mergeGrid: 0 };
	const view = { left: 1000, top: -100, right: 3000, bottom: 2000 };
	const kept = cullConnectorsToRect(
		all,
		(c) => (c === ending ? [1200, 50, 1300, 50, 1400, 80, 1500, 80] : curveOf(c)),
		view,
		{ maxPassThrough: 250, stats }
	);
	assert.equal(stats.crossing, 3001);
	assert.equal(stats.local, 1);
	assert.ok(kept.length <= 251, `kept ${kept.length}`);
	assert.ok(kept.includes(ending));
	assert.ok(stats.mergeGrid > 6);
	// Draw order is preserved.
	const order = kept.map((c) => all.indexOf(c));
	assert.deepEqual(order, [...order].sort((a, b) => a - b));
});

test('cullConnectorsToRect merges thousands of lanes pointing at one post in view', () => {
	const card = (key: string, x: number) => ({ key, x }) as unknown as LaneConnector['from'];
	const target = card('main:quoted', 0);
	// Every quote lane points back at the quoted post in the main lane: all arrowheads land
	// on one point in view, and the lines arrive from far to the right.
	const connectors: LaneConnector[] = Array.from({ length: 5885 }, (_, index) => ({
		key: `q${index}`,
		from: card(`lane${index}:root`, 3000 + index * 400),
		to: target,
		kind: 'reference'
	}));
	const curveOf = (connector: LaneConnector): CubicCurve => {
		const startX = connector.from.x + 60;
		const offset = Math.max(64, startX * 0.35);
		return [startX, 120, startX - offset, 120, 60 + offset, 200, 60, 200];
	};
	const stats = { crossing: 0, local: 0, sources: 0, mergeGrid: 0 };
	const kept = cullConnectorsToRect(connectors, curveOf, { left: -600, top: -600, right: 2400, bottom: 1400 }, { stats });
	assert.equal(stats.crossing, 5885);
	assert.equal(stats.sources, 5885);
	assert.ok(kept.length <= 250, `kept ${kept.length}`);
});
