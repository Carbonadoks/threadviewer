import test from 'node:test';
import assert from 'node:assert/strict';
import { buildThreadsFromFeed } from './threadWalker';

function feedItem(options: {
	id: string;
	authorDid: string;
	handle: string;
	parentUri?: string;
	rootUri?: string;
	text?: string;
}): any {
	const uri = `at://${options.authorDid}/app.bsky.feed.post/${options.id}`;
	const parentUri = options.parentUri;
	const rootUri = options.rootUri ?? parentUri ?? uri;

	return {
		post: {
			uri,
			cid: `cid-${options.id}`,
			author: {
				did: options.authorDid,
				handle: options.handle,
				displayName: options.handle
			},
			record: {
				text: options.text ?? options.id,
				createdAt: '2026-03-01T12:00:00.000Z',
				reply: parentUri
					? {
							parent: { uri: parentUri },
							root: { uri: rootUri }
						}
					: undefined
			},
			indexedAt: '2026-03-01T12:00:00.000Z',
			likeCount: 0,
			repostCount: 0,
			replyCount: 0,
			quoteCount: 0
		}
	};
}

function childUris(node: { children: Array<{ uri: string }> }): string[] {
	return node.children.map((child) => child.uri);
}

test('buildThreadsFromFeed keeps single-author behavior when given one DID', () => {
	const aliceRoot = feedItem({
		id: 'alice-root',
		authorDid: 'did:plc:alice',
		handle: 'alice.test'
	});
	const bobReply = feedItem({
		id: 'bob-reply',
		authorDid: 'did:plc:bob',
		handle: 'bob.test',
		parentUri: aliceRoot.post.uri,
		rootUri: aliceRoot.post.uri
	});
	const aliceReply = feedItem({
		id: 'alice-reply',
		authorDid: 'did:plc:alice',
		handle: 'alice.test',
		parentUri: aliceRoot.post.uri,
		rootUri: aliceRoot.post.uri
	});

	const { threads } = buildThreadsFromFeed([aliceRoot, bobReply, aliceReply], 'did:plc:alice');

	assert.equal(threads.length, 1);
	assert.equal(threads[0].rootUri, aliceRoot.post.uri);
	assert.deepEqual(childUris(threads[0].rootPost), [aliceReply.post.uri]);
});

test('buildThreadsFromFeed links replies across a constrained pair of authors', () => {
	const aliceRoot = feedItem({
		id: 'alice-root',
		authorDid: 'did:plc:alice',
		handle: 'alice.test'
	});
	const bobReply = feedItem({
		id: 'bob-reply',
		authorDid: 'did:plc:bob',
		handle: 'bob.test',
		parentUri: aliceRoot.post.uri,
		rootUri: aliceRoot.post.uri
	});
	const aliceFollowup = feedItem({
		id: 'alice-followup',
		authorDid: 'did:plc:alice',
		handle: 'alice.test',
		parentUri: bobReply.post.uri,
		rootUri: aliceRoot.post.uri
	});

	const { threads } = buildThreadsFromFeed(
		[aliceRoot, bobReply, aliceFollowup],
		['did:plc:alice', 'did:plc:bob']
	);

	assert.equal(threads.length, 1);
	assert.equal(threads[0].rootUri, aliceRoot.post.uri);
	assert.deepEqual(childUris(threads[0].rootPost), [bobReply.post.uri]);
	assert.deepEqual(childUris(threads[0].rootPost.children[0]), [aliceFollowup.post.uri]);
	assert.equal(threads[0].depth, 3);
});

test('buildThreadsFromFeed falls back to the known root when a direct parent is missing', () => {
	const aliceRoot = feedItem({
		id: 'alice-root',
		authorDid: 'did:plc:alice',
		handle: 'alice.test'
	});
	const bobReply = feedItem({
		id: 'bob-reply',
		authorDid: 'did:plc:bob',
		handle: 'bob.test',
		parentUri: 'at://did:plc:missing/app.bsky.feed.post/missing-parent',
		rootUri: aliceRoot.post.uri
	});

	const { threads } = buildThreadsFromFeed([aliceRoot, bobReply], [
		'did:plc:alice',
		'did:plc:bob'
	]);

	assert.equal(threads.length, 1);
	assert.equal(threads[0].rootUri, aliceRoot.post.uri);
	assert.deepEqual(childUris(threads[0].rootPost), [bobReply.post.uri]);
});
