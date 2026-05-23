import test from 'node:test';
import assert from 'node:assert/strict';
import type { ThreadPost } from '$lib/types';
import {
	buildBlogTitle,
	collectSelfReplyChainPosts,
	countThreadPosts,
	findSelfReplyChainRoot,
	measureSelfReplyChainDepth,
	splitPostIntoBlogParagraphs
} from './threadBlog';

function makePost(overrides: Partial<ThreadPost> & { uri: string }): ThreadPost {
	return {
		uri: overrides.uri,
		cid: overrides.cid ?? `cid:${overrides.uri}`,
		author: overrides.author ?? {
			did: 'did:plc:author',
			handle: 'author.test'
		},
		text: overrides.text ?? overrides.uri,
		createdAt: overrides.createdAt ?? '2026-01-01T00:00:00.000Z',
		likeCount: overrides.likeCount ?? 0,
		repostCount: overrides.repostCount ?? 0,
		replyCount: overrides.replyCount ?? 0,
		quoteCount: overrides.quoteCount ?? 0,
		parentUri: overrides.parentUri,
		children: overrides.children ?? []
	};
}

test('collectSelfReplyChainPosts keeps only posts connected through same-author parents', () => {
	const root = makePost({
		uri: 'root',
		createdAt: '2026-01-01T00:00:00.000Z',
		children: [
			makePost({
				uri: 'author-reply',
				parentUri: 'root',
				createdAt: '2026-01-01T00:01:00.000Z',
				children: [
					makePost({
						uri: 'author-grandchild',
						parentUri: 'author-reply',
						createdAt: '2026-01-01T00:03:00.000Z'
					})
				]
			}),
			makePost({
				uri: 'other-reply',
				parentUri: 'root',
				author: { did: 'did:plc:other', handle: 'other.test' },
				createdAt: '2026-01-01T00:02:00.000Z',
				children: [
					makePost({
						uri: 'author-under-other',
						parentUri: 'other-reply',
						createdAt: '2026-01-01T00:04:00.000Z'
					})
				]
			})
		]
	});

	assert.deepEqual(
		collectSelfReplyChainPosts(root).map((post) => post.uri),
		['root', 'author-reply', 'author-grandchild']
	);
});

test('collectSelfReplyChainPosts trusts tree structure when parentUri is absent', () => {
	const root = makePost({
		uri: 'root',
		children: [
			makePost({
				uri: 'author-reply-without-parent-uri',
				createdAt: '2026-01-01T00:01:00.000Z'
			})
		]
	});

	assert.deepEqual(
		collectSelfReplyChainPosts(root).map((post) => post.uri),
		['root', 'author-reply-without-parent-uri']
	);
});

test('findSelfReplyChainRoot anchors a selected self-reply chain inside a larger conversation', () => {
	const author = { did: 'did:plc:author', handle: 'author.test' };
	const other = { did: 'did:plc:other', handle: 'other.test' };
	const chainStart = makePost({
		uri: 'chain-start',
		author,
		parentUri: 'conversation-root',
		createdAt: '2026-01-01T00:01:00.000Z',
		children: [
			makePost({
				uri: 'chain-middle',
				author,
				parentUri: 'chain-start',
				createdAt: '2026-01-01T00:02:00.000Z',
				children: [
					makePost({
						uri: 'chain-leaf',
						author,
						parentUri: 'chain-middle',
						createdAt: '2026-01-01T00:03:00.000Z'
					})
				]
			})
		]
	});
	const root = makePost({
		uri: 'conversation-root',
		author: other,
		children: [chainStart]
	});

	assert.equal(findSelfReplyChainRoot(root, 'chain-leaf').uri, 'chain-start');
	assert.deepEqual(
		collectSelfReplyChainPosts(findSelfReplyChainRoot(root, 'chain-leaf')).map((post) => post.uri),
		['chain-start', 'chain-middle', 'chain-leaf']
	);
});

test('measureSelfReplyChainDepth ignores replies outside the same-author chain', () => {
	const root = makePost({
		uri: 'root',
		children: [
			makePost({
				uri: 'author-reply',
				parentUri: 'root',
				children: [makePost({ uri: 'author-leaf', parentUri: 'author-reply' })]
			}),
			makePost({
				uri: 'other-reply',
				author: { did: 'did:plc:other', handle: 'other.test' },
				parentUri: 'root',
				children: [makePost({ uri: 'author-under-other', parentUri: 'other-reply' })]
			})
		]
	});

	assert.equal(measureSelfReplyChainDepth(root), 3);
});

test('countThreadPosts counts the whole conversation tree', () => {
	const root = makePost({
		uri: 'root',
		children: [
			makePost({ uri: 'one' }),
			makePost({ uri: 'two', children: [makePost({ uri: 'three' })] })
		]
	});

	assert.equal(countThreadPosts(root), 4);
});

test('splitPostIntoBlogParagraphs turns post text into article paragraphs', () => {
	assert.deepEqual(splitPostIntoBlogParagraphs('First line\nstill first\n\nSecond'), [
		'First line still first',
		'Second'
	]);
});

test('buildBlogTitle derives a compact title from the opening text', () => {
	assert.equal(buildBlogTitle('This is the first idea. This is body text.'), 'This is the first idea.');
	assert.equal(buildBlogTitle(''), 'Untitled thread');
});
