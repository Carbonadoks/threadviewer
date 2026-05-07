import assert from 'node:assert/strict';
import test from 'node:test';
import {
	buildCorpusCompletionIndex,
	getCorpusSuggestions,
	removeBskyAppUrlsFromText,
	type CorpusPost
} from './corpusCompletions';

test('removeBskyAppUrlsFromText strips Bluesky quote URLs without joining words', () => {
	assert.equal(
		removeBskyAppUrlsFromText('hello https://bsky.app/profile/alice.test/post/3abc world'),
		'hello world'
	);
	assert.equal(removeBskyAppUrlsFromText('bsky.app'), '');
});

test('buildCorpusCompletionIndex can exclude bsky.app URL tokens from the corpus', () => {
	const posts: CorpusPost[] = [
		{
			text: 'hello https://bsky.app/profile/alice.test/post/3abc world',
			uri: 'at://did:plc:alice/app.bsky.feed.post/root'
		}
	];
	const rawIndex = buildCorpusCompletionIndex(posts);
	const filteredIndex = buildCorpusCompletionIndex(posts, { removeBskyAppUrls: true });

	assert.equal(rawIndex.words.has('bsky'), true);
	assert.equal(filteredIndex.words.has('bsky'), false);
	assert.equal(filteredIndex.words.has('app'), false);
	assert.equal(filteredIndex.words.has('profile'), false);

	const suggestion = getCorpusSuggestions(filteredIndex, 'hello ', { limit: 1 })[0];
	assert.equal(suggestion?.display, 'world');
	assert.equal(suggestion?.echoPosts[0]?.text, 'hello world');
});

test('getCorpusSuggestions includes broader context matches after specific matches', () => {
	const posts: CorpusPost[] = [
		{ text: 'red blue alpha' },
		{ text: 'green blue beta' },
		{ text: 'yellow blue gamma' }
	];
	const index = buildCorpusCompletionIndex(posts);
	const suggestions = getCorpusSuggestions(index, 'red blue ', { limit: 8 });

	assert.deepEqual(
		suggestions.map((suggestion) => suggestion.display),
		['alpha', 'beta', 'gamma']
	);
	assert.deepEqual(
		suggestions.map((suggestion) => suggestion.contextTokens.join(' ')),
		['red blue', 'blue', 'blue']
	);
});
