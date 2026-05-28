import assert from 'node:assert/strict';
import test from 'node:test';
import {
	buildFuzzyTextMatcher,
	fuzzyTextMatches,
	fuzzyTextMatchRanges,
	normalizeFuzzyText
} from './fuzzySearch';

test('normalizes punctuation and accents for fuzzy text search', () => {
	assert.equal(normalizeFuzzyText('Café-thread / Bluesky!'), 'cafe thread bluesky');
});

test('matches exact normalized phrases across punctuation', () => {
	const matcher = buildFuzzyTextMatcher('repo viewer');
	assert.equal(fuzzyTextMatches('The repo-viewer is loaded.', matcher), true);
});

test('returns highlight ranges for exact normalized phrases across punctuation', () => {
	const matcher = buildFuzzyTextMatcher('repo viewer');
	assert.deepEqual(fuzzyTextMatchRanges('The repo-viewer is loaded.', matcher), [
		{ start: 4, end: 8 },
		{ start: 9, end: 15 }
	]);
});

test('matches typo-tolerant and compact terms', () => {
	const matcher = buildFuzzyTextMatcher('bsky thred');
	assert.equal(fuzzyTextMatches('A long Bluesky thread about cached repos.', matcher), true);
});

test('returns whole-token ranges for fuzzy typo and compact matches', () => {
	const matcher = buildFuzzyTextMatcher('bsky thred');
	assert.deepEqual(fuzzyTextMatchRanges('A long Bluesky thread about cached repos.', matcher), [
		{ start: 7, end: 14 },
		{ start: 15, end: 21 }
	]);
});

test('requires every fuzzy term to match', () => {
	const matcher = buildFuzzyTextMatcher('bsky watercolor');
	assert.equal(fuzzyTextMatches('A long Bluesky thread about cached repos.', matcher), false);
});

test('keeps very short typo terms exact to avoid broad matches', () => {
	const matcher = buildFuzzyTextMatcher('ui');
	assert.equal(fuzzyTextMatches('A unit test for thread search.', matcher), false);
});
