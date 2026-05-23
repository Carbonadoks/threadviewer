import assert from 'node:assert/strict';
import test from 'node:test';
import { buildFuzzyTextMatcher, fuzzyTextMatches, normalizeFuzzyText } from './fuzzySearch';

test('normalizes punctuation and accents for fuzzy text search', () => {
	assert.equal(normalizeFuzzyText('Café-thread / Bluesky!'), 'cafe thread bluesky');
});

test('matches exact normalized phrases across punctuation', () => {
	const matcher = buildFuzzyTextMatcher('repo viewer');
	assert.equal(fuzzyTextMatches('The repo-viewer is loaded.', matcher), true);
});

test('matches typo-tolerant and compact terms', () => {
	const matcher = buildFuzzyTextMatcher('bsky thred');
	assert.equal(fuzzyTextMatches('A long Bluesky thread about cached repos.', matcher), true);
});

test('requires every fuzzy term to match', () => {
	const matcher = buildFuzzyTextMatcher('bsky watercolor');
	assert.equal(fuzzyTextMatches('A long Bluesky thread about cached repos.', matcher), false);
});

test('keeps very short typo terms exact to avoid broad matches', () => {
	const matcher = buildFuzzyTextMatcher('ui');
	assert.equal(fuzzyTextMatches('A unit test for thread search.', matcher), false);
});
