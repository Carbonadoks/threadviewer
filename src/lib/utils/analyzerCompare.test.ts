import test from 'node:test';
import assert from 'node:assert/strict';
import {
	REQUIRED_COMPARE_MAX_POSTS,
	buildAnalyzerSummaryCards,
	buildCompareCandidates,
	findCachedAnalysisAccount,
	getEmbeddingStatus,
	isCompareEligible,
	shouldResetCompareState
} from './analyzerCompare';
import type { CachedAnalysisAccount } from '$lib/components/analyzer/types';
import type { ThreadAnalysisResult } from '$lib/types';

const cachedAccounts: CachedAnalysisAccount[] = [
	{
		did: 'did:plc:primary',
		handle: 'primary.test',
		updatedAt: '2026-03-06T10:00:00.000Z',
		maxPosts: 1000
	},
	{
		did: 'did:plc:secondary',
		handle: 'secondary.test',
		updatedAt: '2026-03-06T11:00:00.000Z',
		maxPosts: 1500
	},
	{
		did: 'did:plc:too-small',
		handle: 'toosmall.test',
		updatedAt: '2026-03-06T12:00:00.000Z',
		maxPosts: 999
	}
];

function createResult(overrides: Partial<ThreadAnalysisResult> = {}): ThreadAnalysisResult {
	return {
		model: '@cf/baai/bge-small-en-v1.5 (cls)',
		usedBatchApi: true,
		rateLimited: false,
		generatedAt: '2026-03-06T12:00:00.000Z',
		points: [],
		novelty: {
			model: '@cf/baai/bge-small-en-v1.5 (cls)',
			firstValue: 0,
			postsConsidered: 0,
			postsAnalyzed: 0,
			skippedForCache: 0,
			averageNovelty: 0,
			maxNovelty: 0,
			latestNovelty: 0,
			points: []
		},
		globalDistinctiveness: {
			model: '@cf/baai/bge-small-en-v1.5 (cls)',
			comparedTo: 'Global analyzer centroid',
			available: false,
			corpusSize: 0,
			threadsCompared: 0,
			averageDistinctiveness: 0,
			maxDistinctiveness: 0,
			points: []
		},
		stats: {
			postsScanned: 1000,
			chainStarts: 30,
			threadsWithSelfReplies: 12,
			threadsAnalyzed: 9,
			segmentCount: 44,
			cacheHits: 31,
			cacheMisses: 13,
			skippedForCache: 0
		},
		...overrides
	};
}

test('compare eligibility requires a cached account with at least the required maxPosts', () => {
	assert.equal(isCompareEligible(cachedAccounts[0]), true);
	assert.equal(isCompareEligible(cachedAccounts[2]), false);
	assert.equal(isCompareEligible(null), false);
	assert.equal(isCompareEligible({ maxPosts: REQUIRED_COMPARE_MAX_POSTS - 1 }), false);
});

test('compare candidates exclude the primary account and any ineligible cached accounts', () => {
	assert.deepEqual(
		buildCompareCandidates(cachedAccounts, 'did:plc:primary').map((account) => account.did),
		['did:plc:secondary']
	);
});

test('primary-change reset behavior only triggers when the loaded primary did actually changes', () => {
	assert.equal(shouldResetCompareState('did:plc:primary', 'did:plc:primary'), false);
	assert.equal(shouldResetCompareState('did:plc:primary', 'did:plc:secondary'), true);
	assert.equal(shouldResetCompareState(null, 'did:plc:secondary'), false);
});

test('summary formatting returns the expected compare-ready card content', () => {
	const cards = buildAnalyzerSummaryCards(createResult());
	assert.deepEqual(cards, [
		{
			label: 'Threads',
			value: '9',
			detail: 'of 12 self-reply chains'
		},
		{
			label: 'Paragraphs',
			value: '44',
			detail: 'embedded for clustering'
		},
		{
			label: 'Embedding Cache',
			value: '31',
			detail: '13 misses before this run'
		},
		{
			label: 'Embedding Status',
			value: 'Complete',
			detail: '@cf/baai/bge-small-en-v1.5 (cls)'
		}
	]);
});

test('embedding status formatting prioritizes rate limits before partial cache state', () => {
	assert.equal(getEmbeddingStatus(createResult()), 'Complete');
	assert.equal(
		getEmbeddingStatus(
			createResult({
				stats: {
					postsScanned: 1000,
					chainStarts: 30,
					threadsWithSelfReplies: 12,
					threadsAnalyzed: 9,
					segmentCount: 44,
					cacheHits: 31,
					cacheMisses: 13,
					skippedForCache: 4
				}
			})
		),
		'Partial'
	);
	assert.equal(
		getEmbeddingStatus(
			createResult({
				rateLimited: true,
				stats: {
					postsScanned: 1000,
					chainStarts: 30,
					threadsWithSelfReplies: 12,
					threadsAnalyzed: 9,
					segmentCount: 44,
					cacheHits: 31,
					cacheMisses: 13,
					skippedForCache: 4
				}
			})
		),
		'Rate limited'
	);
});

test('cached account lookup resolves matching dids and returns null for misses', () => {
	assert.equal(findCachedAnalysisAccount(cachedAccounts, 'did:plc:secondary')?.handle, 'secondary.test');
	assert.equal(findCachedAnalysisAccount(cachedAccounts, 'did:plc:missing'), null);
});
