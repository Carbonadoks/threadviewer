import assert from 'node:assert/strict';
import test from 'node:test';

import type { ParsedRepoRecord } from '$lib/utils/carParser';
import { resolveFirstFollowInteractions } from '$lib/utils/followInteraction';

function makeRecord(collection: string, rkey: string, record: any): ParsedRepoRecord {
	return {
		collection,
		rkey,
		cid: `${collection}-${rkey}-cid`,
		record
	};
}

test('resolveFirstFollowInteractions finds first interactions and counts for each followed account', async () => {
	const did = 'did:plc:author';
	const followedBob = 'did:plc:bob';
	const followedCarol = 'did:plc:carol';

	const bobPostUri = 'at://did:plc:bob/app.bsky.feed.post/bob-post';
	const bobReplyUri = 'at://did:plc:bob/app.bsky.feed.post/bob-reply';
	const bobSecondReplyUri = 'at://did:plc:bob/app.bsky.feed.post/bob-reply-2';
	const carolPostUri = 'at://did:plc:carol/app.bsky.feed.post/carol-post';
	const outsiderPostUri = 'at://did:plc:outsider/app.bsky.feed.post/outsider-post';

	const records: ParsedRepoRecord[] = [
		makeRecord('app.bsky.graph.follow', '1', {
			subject: followedBob,
			createdAt: '2026-01-01T00:00:00.000Z'
		}),
		makeRecord('app.bsky.graph.follow', '2', {
			subject: followedCarol,
			createdAt: '2026-01-02T00:00:00.000Z'
		}),
		makeRecord('app.bsky.feed.like', '3', {
			subject: { uri: outsiderPostUri, cid: { $link: 'cid-outsider' } },
			createdAt: '2026-01-03T00:00:00.000Z'
		}),
		makeRecord('app.bsky.feed.like', '4', {
			subject: { uri: bobPostUri, cid: { $link: 'cid-bob' } },
			createdAt: '2026-01-04T00:00:00.000Z'
		}),
		makeRecord('app.bsky.feed.like', '4b', {
			subject: { uri: bobReplyUri, cid: { $link: 'cid-bob-reply' } },
			createdAt: '2026-01-04T12:00:00.000Z'
		}),
		makeRecord('app.bsky.feed.repost', '5', {
			subject: { uri: carolPostUri, cid: { $link: 'cid-carol' } },
			createdAt: '2026-01-05T00:00:00.000Z'
		}),
		makeRecord('app.bsky.feed.post', '6', {
			text: 'replying to outsider first',
			createdAt: '2026-01-06T00:00:00.000Z',
			reply: {
				parent: { uri: outsiderPostUri, cid: { $link: 'cid-reply-outsider' } },
				root: { uri: outsiderPostUri, cid: { $link: 'cid-reply-outsider' } }
			}
		}),
		makeRecord('app.bsky.feed.post', '7', {
			text: 'replying to bob next',
			createdAt: '2026-01-07T00:00:00.000Z',
			reply: {
				parent: { uri: bobReplyUri, cid: { $link: 'cid-reply-bob' } },
				root: { uri: bobReplyUri, cid: { $link: 'cid-reply-bob' } }
			}
		}),
		makeRecord('app.bsky.feed.post', '7b', {
			text: 'replying to bob again',
			createdAt: '2026-01-07T12:00:00.000Z',
			reply: {
				parent: { uri: bobSecondReplyUri, cid: { $link: 'cid-reply-bob-2' } },
				root: { uri: bobSecondReplyUri, cid: { $link: 'cid-reply-bob-2' } }
			}
		}),
		makeRecord('app.bsky.feed.post', '8', {
			text: 'quoting bob',
			createdAt: '2026-01-08T00:00:00.000Z',
			embed: {
				$type: 'app.bsky.embed.record',
				record: { uri: bobPostUri, cid: { $link: 'cid-bob' } }
			}
		})
	];

	const summary = await resolveFirstFollowInteractions(did, records);

	assert.equal(summary.followsCount, 2);
	assert.deepEqual(summary.candidateCounts, {
		quote: 1,
		repost: 1,
		like: 3,
		reply: 3
	});
	assert.equal(summary.follows.length, 2);

	const bobSummary = summary.follows.find((follow) => follow.did === followedBob);
	const carolSummary = summary.follows.find((follow) => follow.did === followedCarol);

	assert.ok(bobSummary);
	assert.ok(carolSummary);

	assert.equal(bobSummary.matchedKindCount, 3);
	assert.equal(bobSummary.totalInteractionCount, 5);
	assert.equal(bobSummary.firstInteractionAt, '2026-01-04T00:00:00.000Z');
	assert.equal(bobSummary.latestInteractionAt, '2026-01-08T00:00:00.000Z');
	assert.equal(bobSummary.interactionCounts.like, 2);
	assert.equal(bobSummary.interactionCounts.reply, 2);
	assert.equal(bobSummary.interactionCounts.quote, 1);
	assert.equal(bobSummary.interactionCounts.repost, 0);
	assert.equal(bobSummary.interactions.like?.targetUri, bobPostUri);
	assert.equal(bobSummary.interactions.like?.sourceUri, null);
	assert.equal(bobSummary.interactions.reply?.targetUri, bobReplyUri);
	assert.equal(
		bobSummary.interactions.reply?.sourceUri,
		'at://did:plc:author/app.bsky.feed.post/7'
	);
	assert.equal(bobSummary.interactions.quote?.targetUri, bobPostUri);
	assert.equal(
		bobSummary.interactions.quote?.sourceUri,
		'at://did:plc:author/app.bsky.feed.post/8'
	);
	assert.equal(bobSummary.interactions.repost, null);

	assert.equal(carolSummary.matchedKindCount, 1);
	assert.equal(carolSummary.totalInteractionCount, 1);
	assert.equal(carolSummary.firstInteractionAt, '2026-01-05T00:00:00.000Z');
	assert.equal(carolSummary.latestInteractionAt, '2026-01-05T00:00:00.000Z');
	assert.equal(carolSummary.interactionCounts.repost, 1);
	assert.equal(carolSummary.interactions.repost?.targetUri, carolPostUri);
	assert.equal(carolSummary.interactions.repost?.sourceUri, null);
	assert.equal(carolSummary.interactions.like, null);
	assert.equal(carolSummary.interactions.reply, null);
	assert.equal(carolSummary.interactions.quote, null);
});

test('resolveFirstFollowInteractions returns empty matches when there are no active follows', async () => {
	const summary = await resolveFirstFollowInteractions('did:plc:author', [
		makeRecord('app.bsky.feed.like', '1', {
			subject: {
				uri: 'at://did:plc:bob/app.bsky.feed.post/post-1',
				cid: { $link: 'cid-post-1' }
			},
			createdAt: '2026-01-01T00:00:00.000Z'
		})
	]);

	assert.equal(summary.followsCount, 0);
	assert.deepEqual(summary.follows, []);
});
