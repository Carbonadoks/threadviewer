import test from 'node:test';
import assert from 'node:assert/strict';
import type { ThreadPost } from '../types';
import { assignLaneColumns, LaneCardLayoutCache, type LanePlacement, type LaneRenderModel } from './parallelBoardLayout';

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
