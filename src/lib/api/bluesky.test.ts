import test from 'node:test';
import assert from 'node:assert/strict';

import {
	buildAuthorSearchQuery,
	buildHydratableThreadFromFlatItems,
	buildVisibleThreadFromFlatItems,
	getFullThread,
	getReplyParentVisibilityFromFlatItems,
	hasMissingDirectReplies,
	searchPostsFromAuthor
} from './bluesky';

function flatPostItem(options: {
	id: string;
	authorDid: string;
	handle: string;
	depth: number;
	parentUri?: string;
	rootUri?: string;
	text?: string;
}): any {
	const uri = `at://${options.authorDid}/app.bsky.feed.post/${options.id}`;
	const parentUri = options.parentUri;
	const rootUri = options.rootUri ?? parentUri ?? uri;

	return {
		uri,
		depth: options.depth,
		value: {
			$type: 'app.bsky.unspecced.defs#threadItemPost',
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
			},
			moreParents: false,
			moreReplies: 0,
			opThread: false,
			hiddenByThreadgate: false,
			mutedByViewer: false
		}
	};
}

function blockedGapItem(options: { uri: string; depth: number; authorDid?: string }): any {
	return {
		uri: options.uri,
		depth: options.depth,
		value: {
			$type: 'app.bsky.unspecced.defs#threadItemBlocked',
			author: options.authorDid
				? {
						did: options.authorDid
					}
				: undefined
		}
	};
}

function searchPostView(options: {
	id: string;
	authorDid: string;
	handle: string;
	text?: string;
}): any {
	return {
		uri: `at://${options.authorDid}/app.bsky.feed.post/${options.id}`,
		cid: `cid-${options.id}`,
		author: {
			did: options.authorDid,
			handle: options.handle,
			displayName: options.handle
		},
		record: {
			text: options.text ?? options.id,
			createdAt: '2026-03-01T12:00:00.000Z'
		},
		indexedAt: '2026-03-01T12:00:00.000Z',
		likeCount: 0,
		repostCount: 0,
		replyCount: 0,
		quoteCount: 0
	};
}

test('searchPostsFromAuthor filters backend leaks by expected author DID', async () => {
	const calls: Array<Record<string, unknown>> = [];
	const fakeAgent = {
		app: {
			bsky: {
				feed: {
					searchPosts: async (params: Record<string, unknown>) => {
						calls.push(params);
						return {
							data: {
								posts: [
									searchPostView({
										id: 'follow-post',
										authorDid: 'did:plc:follow',
										handle: 'follow.test'
									}),
									searchPostView({
										id: 'stray-post',
										authorDid: 'did:plc:stray',
										handle: 'stray.test'
									})
								],
								cursor: 'next',
								hitsTotal: 2
							}
						};
					}
				}
			}
		}
	};

	const page = await searchPostsFromAuthor('needle', 'follow.test', {
		agent: fakeAgent,
		expectedAuthorDid: 'did:plc:follow'
	});

	assert.equal(calls[0].q, 'needle from:follow.test');
	assert.deepEqual(
		page.posts.map((post) => post.author.did),
		['did:plc:follow']
	);
	assert.equal(page.cursor, 'next');
	assert.equal(page.hitsTotal, 2);
});

test('buildAuthorSearchQuery shows the exact from search sent to Bluesky', () => {
	assert.equal(buildAuthorSearchQuery(' needle ', '@follow.test '), 'needle from:follow.test');
});

test('buildVisibleThreadFromFlatItems keeps descendants when a blocked post is in the middle', () => {
	const root = flatPostItem({
		id: 'root',
		authorDid: 'did:plc:root',
		handle: 'root.test',
		depth: 0
	});
	const blockedUri = 'at://did:plc:blocked/app.bsky.feed.post/blocked';
	const blockedGap = blockedGapItem({
		uri: blockedUri,
		depth: 1,
		authorDid: 'did:plc:blocked'
	});
	const recoveredReply = flatPostItem({
		id: 'reply-after-gap',
		authorDid: 'did:plc:reply',
		handle: 'reply.test',
		depth: 2,
		parentUri: blockedUri,
		rootUri: root.uri
	});
	const nestedReply = flatPostItem({
		id: 'nested-reply',
		authorDid: 'did:plc:nested',
		handle: 'nested.test',
		depth: 3,
		parentUri: recoveredReply.uri,
		rootUri: root.uri
	});
	const directSibling = flatPostItem({
		id: 'direct-sibling',
		authorDid: 'did:plc:sibling',
		handle: 'sibling.test',
		depth: 1,
		parentUri: root.uri,
		rootUri: root.uri
	});

	const thread = buildVisibleThreadFromFlatItems([
		root,
		blockedGap,
		recoveredReply,
		nestedReply,
		directSibling
	]);

	assert.ok(thread);
	if (!thread) {
		throw new Error('Expected a visible thread tree');
	}
	assert.equal(thread.uri, root.uri);
	assert.deepEqual(
		thread.children.map((child) => child.uri),
		[recoveredReply.uri, directSibling.uri]
	);
	assert.equal(thread.children[0].parentUri, blockedUri);
	assert.deepEqual(thread.children[0].children.map((child) => child.uri), [nestedReply.uri]);
});

test('buildHydratableThreadFromFlatItems preserves blocked placeholders throughout the tree', () => {
	const root = flatPostItem({
		id: 'root',
		authorDid: 'did:plc:root',
		handle: 'root.test',
		depth: 0
	});
	const directReplyOne = flatPostItem({
		id: 'one',
		authorDid: 'did:plc:one',
		handle: 'one.test',
		depth: 1,
		parentUri: root.uri,
		rootUri: root.uri
	});
	const directReplyTwo = flatPostItem({
		id: 'two',
		authorDid: 'did:plc:two',
		handle: 'two.test',
		depth: 1,
		parentUri: root.uri,
		rootUri: root.uri
	});
	const blockedThreeUri = 'at://did:plc:blocked-three/app.bsky.feed.post/three';
	const blockedThree = blockedGapItem({
		uri: blockedThreeUri,
		depth: 1,
		authorDid: 'did:plc:blocked-three'
	});
	const replySeven = flatPostItem({
		id: 'seven',
		authorDid: 'did:plc:seven',
		handle: 'seven.test',
		depth: 2,
		parentUri: blockedThreeUri,
		rootUri: root.uri
	});
	const replyEight = flatPostItem({
		id: 'eight',
		authorDid: 'did:plc:seven',
		handle: 'seven.test',
		depth: 3,
		parentUri: replySeven.uri,
		rootUri: root.uri
	});
	const blockedNineUri = 'at://did:plc:blocked-nine/app.bsky.feed.post/nine';
	const blockedNine = blockedGapItem({
		uri: blockedNineUri,
		depth: 3,
		authorDid: 'did:plc:blocked-nine'
	});
	const replyTen = flatPostItem({
		id: 'ten',
		authorDid: 'did:plc:ten',
		handle: 'ten.test',
		depth: 4,
		parentUri: blockedNineUri,
		rootUri: root.uri
	});

	const thread = buildHydratableThreadFromFlatItems([
		root,
		directReplyOne,
		directReplyTwo,
		blockedThree,
		replySeven,
		replyEight,
		blockedNine,
		replyTen
	]);

	assert.ok(thread);
	if (!thread) {
		throw new Error('Expected a thread tree with blocked placeholders');
	}

	assert.deepEqual(
		thread.children.map((child) => child.uri),
		[directReplyOne.uri, directReplyTwo.uri, blockedThreeUri]
	);
	assert.equal(thread.children[2].text, '[Blocked post]');
	assert.deepEqual(thread.children[2].children.map((child) => child.uri), [replySeven.uri]);
	assert.deepEqual(
		thread.children[2].children[0].children.map((child) => child.uri),
		[replyEight.uri, blockedNineUri]
	);
	assert.equal(thread.children[2].children[0].children[1].text, '[Blocked post]');
	assert.deepEqual(
		thread.children[2].children[0].children[1].children.map((child) => child.uri),
		[replyTen.uri]
	);
});

test('hasMissingDirectReplies triggers when replyCount exceeds visible direct children', () => {
	assert.equal(
		hasMissingDirectReplies({
			replyCount: 2,
			children: [{} as any]
		}),
		true
	);

	assert.equal(
		hasMissingDirectReplies({
			replyCount: 1,
			children: [{} as any]
		}),
		false
	);
});

test('getReplyParentVisibilityFromFlatItems identifies blocked direct parents', () => {
	const parentUri = 'at://did:plc:blocked/app.bsky.feed.post/parent';
	const status = getReplyParentVisibilityFromFlatItems(
		[
			blockedGapItem({
				uri: parentUri,
				depth: 0,
				authorDid: 'did:plc:blocked'
			})
		],
		parentUri
	);

	assert.equal(status.visibility, 'blocked');
	assert.equal(status.parentAuthorDid, 'did:plc:blocked');
	assert.equal(status.itemType, 'app.bsky.unspecced.defs#threadItemBlocked');
});

test('getReplyParentVisibilityFromFlatItems distinguishes visible parents', () => {
	const parent = flatPostItem({
		id: 'parent',
		authorDid: 'did:plc:visible',
		handle: 'visible.test',
		depth: 0
	});
	const status = getReplyParentVisibilityFromFlatItems([parent], parent.uri);

	assert.equal(status.visibility, 'visible');
	assert.equal(status.parentAuthorDid, 'did:plc:visible');
});

test('getFullThread hydrates truncated branches without waiting for slower siblings', async () => {
	const did = 'did:plc:thread';
	const item = (id: string, depth: number, parent: any, replyCount: number) => {
		const value = flatPostItem({
			id,
			authorDid: did,
			handle: 'thread.test',
			depth,
			parentUri: parent?.uri,
			rootUri: parent ? `at://${did}/app.bsky.feed.post/root` : undefined
		});
		value.value.post.replyCount = replyCount;
		return value;
	};
	const root = item('root', 0, null, 2);
	const fast = item('fast', 1, root, 1);
	const slow = item('slow', 1, root, 1);
	const fastReply = item('fast-reply', 2, fast, 1);
	const fastLeaf = item('fast-leaf', 3, fastReply, 0);
	const slowReply = item('slow-reply', 2, slow, 0);
	const rebase = (value: any, depth: number) => ({ ...value, depth });

	const log: string[] = [];
	const responses: Record<string, any[]> = {
		[root.uri]: [root, fast, slow],
		[fast.uri]: [rebase(fast, 0), rebase(fastReply, 1)],
		[fastReply.uri]: [rebase(fastReply, 0), rebase(fastLeaf, 1)],
		[slow.uri]: [rebase(slow, 0), rebase(slowReply, 1)]
	};
	const fakeAgent: any = {
		app: {
			bsky: {
				unspecced: {
					getPostThreadV2: async (params: { anchor: string; below: number }) => {
						const id = params.anchor.split('/').pop();
						if (params.below === 0) return { data: { thread: [root] } };
						log.push(`start ${id}`);
						if (params.anchor === slow.uri) await new Promise((resolve) => setTimeout(resolve, 40));
						log.push(`end ${id}`);
						return { data: { thread: responses[params.anchor] ?? [], hasOtherReplies: false } };
					}
				}
			}
		}
	};
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (async () => new Response(JSON.stringify({ records: [], total: 0 }))) as typeof fetch;
	try {
		const thread = await getFullThread(fastReply.uri, { agent: fakeAgent });
		assert.equal(thread.rootUri, root.uri);
		assert.equal(thread.isTruncated, true, 'hydration found replies the first fetch was missing');
		const fastNode = thread.rootPost.children.find((child) => child.uri === fast.uri);
		const slowNode = thread.rootPost.children.find((child) => child.uri === slow.uri);
		assert.deepEqual(fastNode?.children.map((child) => child.uri), [fastReply.uri]);
		assert.deepEqual(fastNode?.children[0].children.map((child) => child.uri), [fastLeaf.uri]);
		assert.deepEqual(slowNode?.children.map((child) => child.uri), [slowReply.uri]);
		// The grandchild found under the fast branch starts before the slow branch returns.
		assert.ok(log.indexOf('start fast-reply') < log.indexOf('end slow'), log.join(', '));
	} finally {
		globalThis.fetch = originalFetch;
	}
});
