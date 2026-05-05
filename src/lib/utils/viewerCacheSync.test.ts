import test from 'node:test';
import assert from 'node:assert/strict';
import {
	getNewPostsAnchorUri,
	getNextNewPostsSyncState,
	hasLoadedCompleteCachedFeed,
	mergeUniquePosts,
	postKey,
	resolveViewerFeedUpdate
} from './viewerCacheSync';

function feedItem(id: string): any {
	return {
		post: {
			uri: `at://did:plc:test/app.bsky.feed.post/${id}`,
			cid: `cid-${id}`
		}
	};
}

function uris(posts: any[]): string[] {
	return posts.map((item) => item.post.uri);
}

test('viewer cache sync keeps stable anchor and authoritative feed order across new and older reloads', () => {
	const cachedFeed = [feedItem('c'), feedItem('b'), feedItem('a')];
	const firstAnchor = getNewPostsAnchorUri(cachedFeed, null, null);
	assert.equal(firstAnchor, cachedFeed[0].post.uri);

	const firstNewReload = [feedItem('f'), feedItem('e'), ...cachedFeed];
	const firstNew = resolveViewerFeedUpdate({
		currentFeedPosts: cachedFeed,
		incomingPosts: [feedItem('f'), feedItem('e')],
		mode: 'prepend',
		cacheWritten: true,
		reloadedFeedPosts: firstNewReload
	});
	assert.equal(firstNew.usedCacheReload, true);
	assert.equal(firstNew.added, 2);
	assert.deepEqual(uris(firstNew.feedPosts), uris(firstNewReload));

	const continuedState = getNextNewPostsSyncState(firstAnchor, true, 'cursor-1');
	assert.equal(continuedState.newPostsCursor, 'cursor-1');
	assert.equal(continuedState.newPostsAnchorUri, firstAnchor);
	assert.equal(
		getNewPostsAnchorUri(firstNew.feedPosts, continuedState.newPostsCursor, continuedState.newPostsAnchorUri),
		firstAnchor
	);

	const secondNewReload = [feedItem('f'), feedItem('e'), feedItem('d'), ...cachedFeed];
	const secondNew = resolveViewerFeedUpdate({
		currentFeedPosts: firstNew.feedPosts,
		incomingPosts: [feedItem('d')],
		mode: 'prepend',
		cacheWritten: true,
		reloadedFeedPosts: secondNewReload
	});
	assert.equal(secondNew.usedCacheReload, true);
	assert.equal(secondNew.added, 1);
	assert.deepEqual(uris(secondNew.feedPosts), uris(secondNewReload));

	const completedState = getNextNewPostsSyncState(firstAnchor, false, null);
	assert.equal(completedState.newPostsCursor, null);
	assert.equal(completedState.newPostsAnchorUri, null);

	const olderReload = [...secondNewReload, feedItem('older-1'), feedItem('older-2')];
	const older = resolveViewerFeedUpdate({
		currentFeedPosts: secondNew.feedPosts,
		incomingPosts: [feedItem('older-1'), feedItem('older-2')],
		mode: 'append',
		cacheWritten: true,
		reloadedFeedPosts: olderReload
	});
	assert.equal(older.usedCacheReload, true);
	assert.equal(older.added, 2);
	assert.deepEqual(uris(older.feedPosts), uris(olderReload));
	assert.equal(new Set(older.feedPosts.map((item) => postKey(item))).size, older.feedPosts.length);
});

test('mergeUniquePosts keeps local overlay posts ahead of a reloaded cached feed', () => {
	const overlayPosts = [feedItem('overlay-new'), feedItem('overlay-shared')];
	const reloadedCachedFeed = [feedItem('overlay-shared'), feedItem('cached-1'), feedItem('cached-2')];

	const merged = mergeUniquePosts(overlayPosts, reloadedCachedFeed, 'append');

	assert.deepEqual(uris(merged), [
		overlayPosts[0].post.uri,
		overlayPosts[1].post.uri,
		reloadedCachedFeed[1].post.uri,
		reloadedCachedFeed[2].post.uri
	]);
});

test('hasLoadedCompleteCachedFeed only returns true when the full oldest-reached cache is already in memory', () => {
	assert.equal(
		hasLoadedCompleteCachedFeed({
			currentFeedPosts: [feedItem('a'), feedItem('b'), feedItem('c')],
			cachedPostCount: 3,
			cacheReachedEnd: true,
			maxPosts: 100
		}),
		true
	);

	assert.equal(
		hasLoadedCompleteCachedFeed({
			currentFeedPosts: [feedItem('overlay'), feedItem('a'), feedItem('b'), feedItem('c')],
			cachedPostCount: 3,
			cacheReachedEnd: true,
			maxPosts: 100
		}),
		true
	);

	assert.equal(
		hasLoadedCompleteCachedFeed({
			currentFeedPosts: [feedItem('a'), feedItem('b')],
			cachedPostCount: 3,
			cacheReachedEnd: true,
			maxPosts: 100
		}),
		false
	);

	assert.equal(
		hasLoadedCompleteCachedFeed({
			currentFeedPosts: [feedItem('a'), feedItem('b'), feedItem('c')],
			cachedPostCount: 3,
			cacheReachedEnd: false,
			maxPosts: 100
		}),
		false
	);
});
