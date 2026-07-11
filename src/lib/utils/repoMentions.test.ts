import assert from 'node:assert/strict';
import test from 'node:test';

import type { ParsedRepoRecord } from '$lib/utils/carParser';
import { extractRepoMentions, groupMentionPostsByThread } from '$lib/utils/repoMentions';

function makeRecord(collection: string, rkey: string, record: any): ParsedRepoRecord {
	return {
		collection,
		rkey,
		cid: `${collection}-${rkey}-cid`,
		record
	};
}

function mentionFacet(did: string) {
	return {
		index: { byteStart: 0, byteEnd: 5 },
		features: [{ $type: 'app.bsky.richtext.facet#mention', did }]
	};
}

const OWNER = 'did:plc:owner';
const ALICE = 'did:plc:alice';
const BOB = 'did:plc:bob';

test('extractRepoMentions counts mentions per account and ignores non-posts', () => {
	const records: ParsedRepoRecord[] = [
		makeRecord('app.bsky.feed.post', 'p1', {
			text: 'hey @alice and @bob',
			createdAt: '2026-01-01T00:00:00.000Z',
			facets: [mentionFacet(ALICE), mentionFacet(BOB)]
		}),
		makeRecord('app.bsky.feed.post', 'p2', {
			text: 'thanks @alice',
			createdAt: '2026-01-03T00:00:00.000Z',
			facets: [mentionFacet(ALICE)]
		}),
		// like records carry a #mention-shaped subject elsewhere but must be ignored
		makeRecord('app.bsky.feed.like', 'l1', {
			subject: { uri: 'at://did:plc:alice/app.bsky.feed.post/x', cid: { $link: 'cid' } },
			createdAt: '2026-01-04T00:00:00.000Z'
		}),
		// post with no facets
		makeRecord('app.bsky.feed.post', 'p3', {
			text: 'no mentions here',
			createdAt: '2026-01-05T00:00:00.000Z'
		})
	];

	const summary = extractRepoMentions(OWNER, records);

	assert.equal(summary.scannedPosts, 3);
	assert.equal(summary.postsWithMentions, 2);
	assert.equal(summary.uniqueMentionedUsers, 2);
	assert.equal(summary.totalMentionInstances, 3);

	// Alice mentioned in 2 posts, Bob in 1 → Alice sorts first.
	assert.deepEqual(
		summary.users.map((u) => u.did),
		[ALICE, BOB]
	);

	const alice = summary.users[0];
	assert.equal(alice.mentionPostCount, 2);
	assert.equal(alice.mentionInstanceCount, 2);
	assert.equal(alice.firstMentionedAt, '2026-01-01T00:00:00.000Z');
	assert.equal(alice.lastMentionedAt, '2026-01-03T00:00:00.000Z');
	// posts newest first
	assert.deepEqual(
		alice.posts.map((p) => p.uri),
		[
			`at://${OWNER}/app.bsky.feed.post/p2`,
			`at://${OWNER}/app.bsky.feed.post/p1`
		]
	);
});

test('extractRepoMentions skips self-mentions and dedupes repeats within a post', () => {
	const records: ParsedRepoRecord[] = [
		makeRecord('app.bsky.feed.post', 'p1', {
			text: '@owner @alice @alice',
			createdAt: '2026-02-01T00:00:00.000Z',
			facets: [mentionFacet(OWNER), mentionFacet(ALICE), mentionFacet(ALICE)]
		})
	];

	const summary = extractRepoMentions(OWNER, records);

	assert.equal(summary.uniqueMentionedUsers, 1);
	const alice = summary.users[0];
	assert.equal(alice.did, ALICE);
	// One post, but mentioned twice in it.
	assert.equal(alice.mentionPostCount, 1);
	assert.equal(alice.mentionInstanceCount, 2);
});

test('extractRepoMentions resolves thread root from reply.root', () => {
	const externalRoot = 'at://did:plc:carol/app.bsky.feed.post/root';
	const records: ParsedRepoRecord[] = [
		makeRecord('app.bsky.feed.post', 'reply1', {
			text: 'replying with @alice',
			createdAt: '2026-03-01T00:00:00.000Z',
			facets: [mentionFacet(ALICE)],
			reply: {
				root: { uri: externalRoot, cid: { $link: 'cid-root' } },
				parent: { uri: externalRoot, cid: { $link: 'cid-parent' } }
			}
		}),
		makeRecord('app.bsky.feed.post', 'top1', {
			text: 'top-level @alice',
			createdAt: '2026-03-02T00:00:00.000Z',
			facets: [mentionFacet(ALICE)]
		})
	];

	const summary = extractRepoMentions(OWNER, records);
	const alice = summary.users[0];
	const replyPost = alice.posts.find((p) => p.uri.endsWith('reply1'));
	const topPost = alice.posts.find((p) => p.uri.endsWith('top1'));

	assert.ok(replyPost);
	assert.equal(replyPost?.rootUri, externalRoot);
	assert.equal(replyPost?.parentUri, externalRoot);
	assert.equal(replyPost?.isReply, true);

	assert.ok(topPost);
	// top-level post is its own root
	assert.equal(topPost?.rootUri, `at://${OWNER}/app.bsky.feed.post/top1`);
	assert.equal(topPost?.parentUri, null);
	assert.equal(topPost?.isReply, false);

	// Grouping by thread keeps the two distinct roots, newest mention first.
	const groups = groupMentionPostsByThread(alice.posts);
	assert.equal(groups.length, 2);
	assert.equal(groups[0].rootUri, `at://${OWNER}/app.bsky.feed.post/top1`);
	assert.equal(groups[1].rootUri, externalRoot);
});

test('groupMentionPostsByThread merges posts sharing a root and honours the limit', () => {
	const sharedRoot = 'at://did:plc:carol/app.bsky.feed.post/shared';
	const summary = extractRepoMentions(OWNER, [
		makeRecord('app.bsky.feed.post', 'a', {
			text: '@alice one',
			createdAt: '2026-04-01T00:00:00.000Z',
			facets: [mentionFacet(ALICE)],
			reply: { root: { uri: sharedRoot }, parent: { uri: sharedRoot } }
		}),
		makeRecord('app.bsky.feed.post', 'b', {
			text: '@alice two',
			createdAt: '2026-04-02T00:00:00.000Z',
			facets: [mentionFacet(ALICE)],
			reply: { root: { uri: sharedRoot }, parent: { uri: sharedRoot } }
		}),
		makeRecord('app.bsky.feed.post', 'c', {
			text: '@alice three',
			createdAt: '2026-04-03T00:00:00.000Z',
			facets: [mentionFacet(ALICE)]
		})
	]);

	const alice = summary.users[0];
	const allGroups = groupMentionPostsByThread(alice.posts);
	assert.equal(allGroups.length, 2);
	const shared = allGroups.find((g) => g.rootUri === sharedRoot);
	assert.equal(shared?.mentionPostUris.length, 2);

	const limited = groupMentionPostsByThread(alice.posts, 1);
	assert.equal(limited.length, 1);
});
