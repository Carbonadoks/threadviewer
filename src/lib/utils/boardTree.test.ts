import test from 'node:test';
import assert from 'node:assert/strict';
import type { ThreadPost } from '$lib/types';
import {
	buildParentMap,
	buildVisibleParentMap,
	buildVisiblePostOrder,
	countDescendants,
	findMatchingPosts,
	findFirstMatchingPost,
	getVisibleChildren,
	isBranchCollapsed,
	revealCollapsedPath,
	revealCollapsedPaths
} from './boardTree';

function createPost(uri: string, children: ThreadPost[] = []): ThreadPost {
	return {
		uri,
		cid: `cid:${uri}`,
		author: {
			did: 'did:plc:test',
			handle: 'tester.test'
		},
		text: uri,
		createdAt: '2026-03-09T00:00:00.000Z',
		likeCount: 0,
		repostCount: 0,
		replyCount: children.length,
		quoteCount: 0,
		children
	};
}

const tree = createPost('root', [
	createPost('branch-a', [
		createPost('branch-a-1'),
		createPost('branch-a-2', [createPost('branch-a-2-1')])
	]),
	createPost('branch-b', [createPost('branch-b-1')])
]);

test('visible post order includes the full tree when nothing is collapsed', () => {
	assert.deepEqual(
		buildVisiblePostOrder(tree, {}).map((post) => post.uri),
		['root', 'branch-a', 'branch-a-1', 'branch-a-2', 'branch-a-2-1', 'branch-b', 'branch-b-1']
	);
});

test('collapsing a branch hides the branch root and its descendants', () => {
	assert.deepEqual(
		buildVisiblePostOrder(tree, { 'branch-a': true }).map((post) => post.uri),
		['root', 'branch-b', 'branch-b-1']
	);
	assert.deepEqual(
		getVisibleChildren(tree, { 'branch-a': true }).map((post) => post.uri),
		['branch-b']
	);
});

test('visible parent map excludes collapsed branch roots and their descendants', () => {
	const parentMap = buildVisibleParentMap(tree, { 'branch-a': true });

	assert.equal(parentMap.get('branch-b')?.uri, 'root');
	assert.equal(parentMap.get('branch-b-1')?.uri, 'branch-b');
	assert.equal(parentMap.has('branch-a'), false);
	assert.equal(parentMap.has('branch-a-1'), false);
	assert.equal(parentMap.has('branch-a-2-1'), false);
});

test('single-leaf branch roots are hidden when collapsed', () => {
	assert.deepEqual(
		buildVisiblePostOrder(tree, { 'branch-b': true }).map((post) => post.uri),
		['root', 'branch-a', 'branch-a-1', 'branch-a-2', 'branch-a-2-1']
	);
	assert.deepEqual(
		getVisibleChildren(tree, { 'branch-b': true }).map((post) => post.uri),
		['branch-a']
	);
});

test('full parent map remains available for visible branch-collapse actions', () => {
	const parentMap = buildParentMap(tree);

	assert.equal(parentMap.get('branch-a')?.uri, 'root');
	assert.equal(parentMap.get('branch-b')?.uri, 'root');
	assert.equal(parentMap.get('branch-a-2-1')?.uri, 'branch-a-2');
});

test('findFirstMatchingPost returns the first pre-order match in the full tree', () => {
	const match = findFirstMatchingPost(tree, (post) => post.uri.includes('branch-a-2'));
	assert.equal(match?.uri, 'branch-a-2');
});

test('findMatchingPosts returns every pre-order match in the full tree', () => {
	const matches = findMatchingPosts(tree, (post) => post.uri.includes('branch-a'));
	assert.deepEqual(
		matches.map((post) => post.uri),
		['branch-a', 'branch-a-1', 'branch-a-2', 'branch-a-2-1']
	);
});

test('revealCollapsedPath reopens every collapsed branch along the target path', () => {
	const parentMap = buildParentMap(tree);
	const nextCollapsed = revealCollapsedPath('branch-a-2-1', parentMap, {
		'branch-a': true,
		'branch-a-2': true,
		'branch-b': true
	});

	assert.deepEqual(nextCollapsed, { 'branch-b': true });
});

test('revealCollapsedPaths reopens every collapsed branch for all target paths', () => {
	const parentMap = buildParentMap(tree);
	const nextCollapsed = revealCollapsedPaths(['branch-a-2-1', 'branch-b-1'], parentMap, {
		'branch-a': true,
		'branch-a-2': true,
		'branch-b': true
	});

	assert.deepEqual(nextCollapsed, {});
});

test('collapse helpers expose branch state and descendant counts', () => {
	assert.equal(isBranchCollapsed('branch-a', { 'branch-a': true }), true);
	assert.equal(isBranchCollapsed('branch-b', { 'branch-a': true }), false);
	assert.equal(countDescendants(tree.children[0]), 3);
	assert.equal(countDescendants(tree), 6);
});
