import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCachedUserSummary } from './cachedSummary';

const DID = 'did:plc:alice';
const BOB_DID = 'did:plc:bob';
const CAROL_DID = 'did:plc:carol';

function feedItem(options: {
	id: string;
	text?: string;
	createdAt?: string;
	likeCount?: number;
	repostCount?: number;
	replyCount?: number;
	quoteCount?: number;
	parentUri?: string;
	rootUri?: string;
	mentionDids?: string[];
	linkUris?: string[];
	authorDid?: string;
	embedThumb?: string;
	embedAlt?: string;
	recordImageCid?: string;
}): any {
	const uri = `at://${options.authorDid ?? DID}/app.bsky.feed.post/${options.id}`;
	const parentUri = options.parentUri;
	const rootUri = options.rootUri ?? options.parentUri ?? uri;

	return {
		post: {
			uri,
			cid: `cid-${options.id}`,
			indexedAt: options.createdAt ?? '2026-03-10T12:00:00.000Z',
			author: {
				did: options.authorDid ?? DID,
				handle: 'alice.test'
			},
			record: {
				text: options.text ?? `post ${options.id}`,
				createdAt: options.createdAt ?? '2026-03-10T12:00:00.000Z',
				reply:
					parentUri && rootUri
						? {
								parent: { uri: parentUri },
								root: { uri: rootUri }
							}
						: undefined,
				facets: [
					...(options.mentionDids ?? []).map((did) => ({
						features: [
							{
								$type: 'app.bsky.richtext.facet#mention',
								did
							}
						]
					})),
					...(options.linkUris ?? []).map((uri) => ({
						features: [
							{
								$type: 'app.bsky.richtext.facet#link',
								uri
							}
						]
					}))
				],
				embed: options.recordImageCid
					? {
							$type: 'app.bsky.embed.images',
							images: [
								{
									alt: options.embedAlt ?? '',
									image: {
										ref: { $link: options.recordImageCid }
									}
								}
							]
						}
					: undefined
			},
			embed: options.embedThumb
				? {
						$type: 'app.bsky.embed.images#view',
						images: [
							{
								thumb: options.embedThumb,
								fullsize: options.embedThumb,
								alt: options.embedAlt ?? ''
							}
						]
					}
				: undefined,
			likeCount: options.likeCount ?? 0,
			repostCount: options.repostCount ?? 0,
			replyCount: options.replyCount ?? 0,
			quoteCount: options.quoteCount ?? 0
		}
	};
}

test('buildCachedUserSummary ranks mentions, posts, and threads from cached feed data', () => {
	const root = feedItem({
		id: 'root',
		text: 'hello @bob and @carol',
		createdAt: '2026-03-10T12:00:00.000Z',
		likeCount: 5,
		repostCount: 2,
		replyCount: 3,
		mentionDids: [BOB_DID, CAROL_DID]
	});
	const child = feedItem({
		id: 'child',
		text: 'follow-up for @bob',
		createdAt: '2026-03-11T12:00:00.000Z',
		likeCount: 9,
		repostCount: 1,
		replyCount: 7,
		parentUri: root.post.uri,
		rootUri: root.post.uri,
		mentionDids: [BOB_DID, DID],
		embedThumb: 'https://cdn.example.com/thumb-child.jpg',
		embedAlt: 'child image'
	});
	const repeated = feedItem({
		id: 'repeated',
		text: 'follow-up for @bob',
		createdAt: '2026-03-12T08:00:00.000Z',
		likeCount: 1,
		repostCount: 0,
		replyCount: 0,
		embedThumb: 'https://cdn.example.com/thumb-repeated.jpg',
		embedAlt: 'repeat image'
	});
	const viral = feedItem({
		id: 'viral',
		text: 'this one spread',
		createdAt: '2026-03-12T12:00:00.000Z',
		likeCount: 2,
		repostCount: 11,
		replyCount: 1
	});

	const summary = buildCachedUserSummary({
		did: DID,
		feedPosts: [root, child, repeated, viral],
		cachedPostCount: 4,
		updatedAt: '2026-03-13T00:00:00.000Z'
	});

	assert.equal(summary.did, DID);
	assert.equal(summary.cachedPostCount, 4);
	assert.equal(summary.analyzedPostCount, 4);
	assert.equal(summary.uniqueMentionedUsers, 2);
	assert.deepEqual(summary.mostMentionedUsers, [
		{
			did: BOB_DID,
			count: 2,
			lastMentionedAt: '2026-03-11T12:00:00.000Z'
		},
		{
			did: CAROL_DID,
			count: 1,
			lastMentionedAt: '2026-03-10T12:00:00.000Z'
		}
	]);
	assert.equal(summary.mostLikedPosts[0]?.uri, child.post.uri);
	assert.equal(summary.mostLikedPosts[0]?.likeCount, 9);
	assert.deepEqual(summary.mostLikedPosts[0]?.thumbnail, {
		url: 'https://cdn.example.com/thumb-child.jpg',
		alt: 'child image'
	});
	assert.equal(summary.mostRepostedPosts[0]?.uri, viral.post.uri);
	assert.equal(summary.mostRepostedPosts[0]?.repostCount, 11);
	assert.deepEqual(summary.mostRepeatedPosts, [
		{
			text: 'follow-up for @bob',
			count: 2,
			latestUri: repeated.post.uri,
			latestCreatedAt: '2026-03-12T08:00:00.000Z',
			firstCreatedAt: '2026-03-11T12:00:00.000Z',
			thumbnail: {
				url: 'https://cdn.example.com/thumb-repeated.jpg',
				alt: 'repeat image'
			}
		}
	]);
	assert.deepEqual(summary.threadsWithMostReplies[0], {
		rootUri: root.post.uri,
		createdAt: '2026-03-10T12:00:00.000Z',
		text: 'hello @bob and @carol',
		depth: 2,
		postCount: 2,
		totalReplyCount: 10,
		rootReplyCount: 3,
		thumbnail: undefined
	});
});

test('buildCachedUserSummary filters out zero-count rankings and non-matching authors', () => {
	const summary = buildCachedUserSummary({
		did: DID,
		feedPosts: [
			feedItem({
				id: 'zero',
				text: 'quiet post',
				authorDid: DID
			}),
			feedItem({
				id: 'other-author',
				text: 'ignore me',
				authorDid: BOB_DID,
				likeCount: 30,
				repostCount: 30,
				replyCount: 30,
				mentionDids: [CAROL_DID]
			})
		]
	});

	assert.equal(summary.analyzedPostCount, 1);
	assert.equal(summary.uniqueMentionedUsers, 0);
	assert.deepEqual(summary.mostMentionedUsers, []);
	assert.deepEqual(summary.mostLikedPosts, []);
	assert.deepEqual(summary.mostRepostedPosts, []);
	assert.deepEqual(summary.mostRepeatedPosts, []);
	assert.deepEqual(summary.threadsWithMostReplies, []);
});

test('buildCachedUserSummary does not merge shortened link posts with different facet URLs', () => {
	const sameVisibleText = 'https://bsky.app/profile/alice.test/post/3ln…';

	const summary = buildCachedUserSummary({
		did: DID,
		feedPosts: [
			feedItem({
				id: 'link-a',
				text: sameVisibleText,
				linkUris: ['https://bsky.app/profile/alice.test/post/3lnabc?utm=1']
			}),
			feedItem({
				id: 'link-b',
				text: sameVisibleText,
				linkUris: ['https://bsky.app/profile/alice.test/post/3lnxyz']
			})
		]
	});

	assert.deepEqual(summary.mostRepeatedPosts, []);
});

test('buildCachedUserSummary derives thumbnails from raw repo image embeds when appview thumbs are absent', () => {
	const summary = buildCachedUserSummary({
		did: DID,
		feedPosts: [
			feedItem({
				id: 'repo-image',
				text: 'repo image',
				likeCount: 4,
				recordImageCid: 'bafkreigh2akiscaildcjexamplecid',
				embedAlt: 'repo image alt'
			})
		]
	});

	assert.deepEqual(summary.mostLikedPosts[0]?.thumbnail, {
		url: 'https://cdn.bsky.app/img/feed_thumbnail/plain/did%3Aplc%3Aalice/bafkreigh2akiscaildcjexamplecid@jpeg',
		alt: 'repo image alt'
	});
});
