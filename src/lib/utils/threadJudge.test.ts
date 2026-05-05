import test from 'node:test';
import assert from 'node:assert/strict';
import type { SelfReplyThread } from '$lib/types';
import { serializeThreadForJudging } from './threadJudge';

const sampleThread: SelfReplyThread = {
	rootUri: 'at://did:plc:root/app.bsky.feed.post/root',
	depth: 3,
	rootPost: {
		uri: 'at://did:plc:root/app.bsky.feed.post/root',
		cid: 'root-cid',
		author: {
			did: 'did:plc:root',
			handle: 'root.test',
			displayName: 'Root'
		},
		text: 'Opening thought',
		createdAt: '2026-03-10T10:00:00.000Z',
		likeCount: 0,
		repostCount: 0,
		replyCount: 2,
		quoteCount: 0,
		children: [
			{
				uri: 'at://did:plc:root/app.bsky.feed.post/reply-b',
				cid: 'reply-b-cid',
				author: {
					did: 'did:plc:reply',
					handle: 'reply.test',
					displayName: 'Reply B'
				},
				text: 'Later reply',
				createdAt: '2026-03-10T10:02:00.000Z',
				likeCount: 0,
				repostCount: 0,
				replyCount: 0,
				quoteCount: 0,
				parentUri: 'at://did:plc:root/app.bsky.feed.post/root',
				children: []
			},
			{
				uri: 'at://did:plc:root/app.bsky.feed.post/reply-a',
				cid: 'reply-a-cid',
				author: {
					did: 'did:plc:reply',
					handle: 'reply.test',
					displayName: 'Reply A'
				},
				text: 'Earlier reply',
				createdAt: '2026-03-10T10:01:00.000Z',
				likeCount: 0,
				repostCount: 0,
				replyCount: 1,
				quoteCount: 0,
				parentUri: 'at://did:plc:root/app.bsky.feed.post/root',
				children: [
					{
						uri: 'at://did:plc:root/app.bsky.feed.post/reply-a-child',
						cid: 'reply-a-child-cid',
						author: {
							did: 'did:plc:reply-child',
							handle: 'reply-child.test',
							displayName: 'Reply Child'
						},
						text: 'Nested reply',
						createdAt: '2026-03-10T10:03:00.000Z',
						likeCount: 0,
						repostCount: 0,
						replyCount: 0,
						quoteCount: 0,
						parentUri: 'at://did:plc:root/app.bsky.feed.post/reply-a',
						children: []
					}
				]
			}
		]
	}
};

test('serializeThreadForJudging keeps the root first and orders replies chronologically', () => {
	const serialized = serializeThreadForJudging(sampleThread);

	assert.deepEqual(
		serialized.map((post) => post.uri),
		[
			'at://did:plc:root/app.bsky.feed.post/root',
			'at://did:plc:root/app.bsky.feed.post/reply-a',
			'at://did:plc:root/app.bsky.feed.post/reply-b',
			'at://did:plc:root/app.bsky.feed.post/reply-a-child'
		]
	);
	assert.deepEqual(
		serialized.map((post) => post.index),
		[1, 2, 3, 4]
	);
});

test('serializeThreadForJudging maps replyToIndex against the final ordered sequence', () => {
	const serialized = serializeThreadForJudging(sampleThread);

	assert.equal(serialized[0].replyToIndex, null);
	assert.equal(serialized[1].replyToIndex, 1);
	assert.equal(serialized[2].replyToIndex, 1);
	assert.equal(serialized[3].replyToIndex, 2);
});
