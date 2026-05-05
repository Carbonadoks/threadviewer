import type { ThreadAnalysisResult } from '$lib/types';
import type { CachedAnalysisAccount } from '$lib/components/analyzer/types';

export const REQUIRED_COMPARE_MAX_POSTS = 1000;

export interface AnalyzerSummaryCard {
	label: string;
	value: string;
	detail: string;
}

export function findCachedAnalysisAccount(
	accounts: CachedAnalysisAccount[],
	did: string | null | undefined
): CachedAnalysisAccount | null {
	if (!did) return null;
	return accounts.find((account) => account.did === did) ?? null;
}

export function isCompareEligible(
	account: Pick<CachedAnalysisAccount, 'maxPosts'> | null | undefined,
	requiredMaxPosts = REQUIRED_COMPARE_MAX_POSTS
): boolean {
	return Boolean(account && Number.isFinite(account.maxPosts) && account.maxPosts >= requiredMaxPosts);
}

export function buildCompareCandidates(
	accounts: CachedAnalysisAccount[],
	primaryDid: string | null | undefined,
	requiredMaxPosts = REQUIRED_COMPARE_MAX_POSTS
): CachedAnalysisAccount[] {
	return accounts.filter(
		(account) => account.did !== primaryDid && isCompareEligible(account, requiredMaxPosts)
	);
}

export function shouldResetCompareState(
	previousPrimaryDid: string | null | undefined,
	nextPrimaryDid: string | null | undefined
): boolean {
	if (!previousPrimaryDid || !nextPrimaryDid) return false;
	return previousPrimaryDid !== nextPrimaryDid;
}

export function getEmbeddingStatus(result: ThreadAnalysisResult): string {
	if (result.rateLimited) return 'Rate limited';
	if (result.stats.skippedForCache > 0) return 'Partial';
	return 'Complete';
}

export function buildAnalyzerSummaryCards(result: ThreadAnalysisResult): AnalyzerSummaryCard[] {
	return [
		{
			label: 'Threads',
			value: String(result.stats.threadsAnalyzed),
			detail: `of ${result.stats.threadsWithSelfReplies} self-reply chains`
		},
		{
			label: 'Paragraphs',
			value: String(result.stats.segmentCount),
			detail: 'embedded for clustering'
		},
		{
			label: 'Embedding Cache',
			value: String(result.stats.cacheHits),
			detail: `${result.stats.cacheMisses} misses before this run`
		},
		{
			label: 'Embedding Status',
			value: getEmbeddingStatus(result),
			detail: result.model
		}
	];
}
