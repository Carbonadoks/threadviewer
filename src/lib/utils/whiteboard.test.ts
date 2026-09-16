import test from 'node:test';
import assert from 'node:assert/strict';
import type { ThreadPost } from '$lib/types';
import {
	WHITEBOARD_CARD_WIDTH,
	WHITEBOARD_GROUP_PADDING_X,
	WHITEBOARD_STACK_BADGE_LANE,
	WHITEBOARD_STEP_X,
	chainIndexForUri,
	findFreeSpot,
	layoutThreadGroup,
	layoutThreadStack,
	pruneDeletedPosts,
	rectsOverlap,
	type WhiteboardRect
} from './whiteboard';

function makePost(uri: string, children: ThreadPost[] = []): ThreadPost {
	return {
		uri,
		cid: `cid:${uri}`,
		author: { did: 'did:plc:test', handle: 'tester.test' },
		text: `post ${uri}`,
		createdAt: '2026-01-01T00:00:00.000Z',
		likeCount: 0,
		repostCount: 0,
		replyCount: children.length,
		quoteCount: 0,
		children
	};
}

test('layoutThreadGroup lays out a linear chain in a single column', () => {
	const root = makePost('a', [makePost('b', [makePost('c')])]);
	const layout = layoutThreadGroup(root);

	assert.equal(layout.postCount, 3);
	assert.equal(layout.width, WHITEBOARD_CARD_WIDTH + 2 * WHITEBOARD_GROUP_PADDING_X);
	const xs = new Set(layout.cards.map((card) => card.x));
	assert.equal(xs.size, 1);
	assert.deepEqual(
		layout.cards.map((card) => card.depth).sort(),
		[0, 1, 2]
	);
	assert.equal(layout.connectors.length, 2);
});

test('layoutThreadGroup fans branches out and centers the parent', () => {
	const root = makePost('a', [makePost('b'), makePost('c')]);
	const layout = layoutThreadGroup(root);

	const rootCard = layout.cardByUri.get('a');
	const left = layout.cardByUri.get('b');
	const right = layout.cardByUri.get('c');
	assert.ok(rootCard && left && right);
	assert.equal(right.x - left.x, WHITEBOARD_STEP_X);
	assert.equal(rootCard.x, (left.x + right.x) / 2);
});

test('layoutThreadGroup skips deleted posts and promotes their children', () => {
	const root = makePost('a', [makePost('b', [makePost('c')])]);
	const layout = layoutThreadGroup(root, new Set(['b']));

	assert.equal(layout.postCount, 2);
	assert.equal(layout.cardByUri.has('b'), false);
	assert.equal(layout.cardByUri.get('c')?.depth, 1);
	assert.equal(layout.connectors.length, 1);
	assert.equal(layout.connectors[0].fromUri, 'a');
	assert.equal(layout.connectors[0].toUri, 'c');
});

test('pruneDeletedPosts returns null when everything is deleted', () => {
	const root = makePost('a', [makePost('b')]);
	assert.equal(pruneDeletedPosts(root, new Set(['a', 'b'])), null);
});

test('rectsOverlap detects overlap, clearance, and margin violations', () => {
	const a: WhiteboardRect = { x: 0, y: 0, width: 100, height: 100 };
	assert.equal(rectsOverlap(a, { x: 50, y: 50, width: 100, height: 100 }), true);
	assert.equal(rectsOverlap(a, { x: 200, y: 0, width: 100, height: 100 }), false);
	// Within margin distance counts as overlapping…
	assert.equal(rectsOverlap(a, { x: 120, y: 0, width: 100, height: 100 }, 40), true);
	// …but exactly at margin distance does not.
	assert.equal(rectsOverlap(a, { x: 140, y: 0, width: 100, height: 100 }, 40), false);
});

test('findFreeSpot returns the preferred spot when it is free', () => {
	const obstacles: WhiteboardRect[] = [{ x: 1000, y: 1000, width: 200, height: 200 }];
	assert.deepEqual(findFreeSpot(300, 200, 10, 20, obstacles, 40), { x: 10, y: 20 });
});

test('findFreeSpot never returns an overlapping spot', () => {
	const obstacles: WhiteboardRect[] = [
		{ x: 0, y: 0, width: 400, height: 300 },
		{ x: 500, y: 0, width: 400, height: 300 },
		{ x: 0, y: 400, width: 400, height: 300 },
		{ x: 500, y: 400, width: 400, height: 300 }
	];
	const margin = 48;
	const spot = findFreeSpot(350, 250, 100, 100, obstacles, margin);
	const placed: WhiteboardRect = { ...spot, width: 350, height: 250 };
	for (const obstacle of obstacles) {
		assert.equal(rectsOverlap(placed, obstacle, margin), false);
	}
});

test('findFreeSpot hugs the nearest obstacle instead of drifting away', () => {
	const obstacles: WhiteboardRect[] = [{ x: 0, y: 0, width: 400, height: 300 }];
	const spot = findFreeSpot(300, 200, 50, 50, obstacles, 40);
	// Closest free candidate for a preferred spot inside the obstacle is just
	// below it (shortest exit), at margin clearance.
	assert.deepEqual(spot, { x: 50, y: 340 });
	const placed: WhiteboardRect = { ...spot, width: 300, height: 200 };
	assert.equal(rectsOverlap(placed, obstacles[0], 40), false);
	// Distance from preferred stays within one obstacle-size hop.
	assert.ok(Math.hypot(spot.x - 50, spot.y - 50) < 600);
});

test('layoutThreadStack shows one root→leaf lane with branch badges', () => {
	// a → b → (c, d); a → e   ⇒ chains: [a,b,c], [a,b,d], [a,e]
	const root = makePost('a', [makePost('b', [makePost('c'), makePost('d')]), makePost('e')]);
	const layout = layoutThreadStack(root, new Set(), 0);

	assert.equal(layout.chainCount, 3);
	assert.equal(layout.activeChainIndex, 0);
	assert.deepEqual(
		layout.cards.map((card) => card.post.uri),
		['a', 'b', 'c']
	);
	// Single lane: every card shares one x.
	assert.equal(new Set(layout.cards.map((card) => card.x)).size, 1);
	assert.equal(layout.connectors.length, 2);
	// Badges at both forks, counting hidden siblings.
	assert.deepEqual(
		layout.branchBadges?.map((badge) => [badge.uri, badge.hiddenCount]),
		[
			['a', 1],
			['b', 1]
		]
	);
	assert.equal(
		layout.width,
		WHITEBOARD_CARD_WIDTH + 2 * WHITEBOARD_GROUP_PADDING_X + WHITEBOARD_STACK_BADGE_LANE
	);
});

test('layoutThreadStack badge nextChainIndex cycles through sibling branches', () => {
	const root = makePost('a', [makePost('b', [makePost('c'), makePost('d')]), makePost('e')]);
	const chain0 = layoutThreadStack(root, new Set(), 0);
	// Fork at `a`: next branch after [a,b,*] is the `e` subtree (chain 2).
	assert.equal(chain0.branchBadges?.find((badge) => badge.uri === 'a')?.nextChainIndex, 2);
	// Fork at `b`: next branch after `c` is `d` (chain 1).
	assert.equal(chain0.branchBadges?.find((badge) => badge.uri === 'b')?.nextChainIndex, 1);

	const chain2 = layoutThreadStack(root, new Set(), 2);
	assert.deepEqual(
		chain2.cards.map((card) => card.post.uri),
		['a', 'e']
	);
	// From the `e` lane, the fork at `a` wraps back to chain 0.
	assert.equal(chain2.branchBadges?.find((badge) => badge.uri === 'a')?.nextChainIndex, 0);
});

test('layoutThreadStack wraps out-of-range chain indexes', () => {
	const root = makePost('a', [makePost('b'), makePost('c')]);
	assert.equal(layoutThreadStack(root, new Set(), 5).activeChainIndex, 1);
	assert.equal(layoutThreadStack(root, new Set(), -1).activeChainIndex, 1);
});

test('layoutThreadStack respects deleted posts', () => {
	const root = makePost('a', [makePost('b', [makePost('c'), makePost('d')])]);
	const layout = layoutThreadStack(root, new Set(['c']), 0);
	assert.equal(layout.chainCount, 1);
	assert.deepEqual(
		layout.cards.map((card) => card.post.uri),
		['a', 'b', 'd']
	);
	assert.equal(layout.branchBadges?.length, 0);
});

test('chainIndexForUri finds the lane containing a post', () => {
	const root = makePost('a', [makePost('b', [makePost('c'), makePost('d')]), makePost('e')]);
	assert.equal(chainIndexForUri(root, 'a'), 0);
	assert.equal(chainIndexForUri(root, 'd'), 1);
	assert.equal(chainIndexForUri(root, 'e'), 2);
	assert.equal(chainIndexForUri(root, 'missing'), null);
	// Deleting `d` collapses that fork; `e` becomes chain 1.
	assert.equal(chainIndexForUri(root, 'e', new Set(['d'])), 1);
});

test('pruneDeletedPosts promotes a surviving child when the root is deleted', () => {
	const root = makePost('a', [makePost('b', [makePost('c')])]);
	const pruned = pruneDeletedPosts(root, new Set(['a']));
	assert.equal(pruned?.uri, 'b');
	assert.deepEqual(
		pruned?.children.map((child) => child.uri),
		['c']
	);
});
