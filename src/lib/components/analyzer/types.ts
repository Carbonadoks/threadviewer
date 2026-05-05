import type { ProfileInfo } from '$lib/api/bluesky';
import type { ThreadAnalysisResult } from '$lib/types';

export type SequenceMetricTab = 'novelty' | 'interestingness' | 'distinctiveness';
export type AnalyzerCompareSeries = 'primary' | 'secondary';

export interface BatchSegmentPayload {
	uri: string;
	rootUri: string;
	createdAt: string;
	title: string;
	text: string;
	embedding: number[];
}

export interface CachedAnalysisIndexAccount {
	did: string;
	updatedAt: string;
	maxPosts: number;
}

export interface CachedAnalysisAccount extends CachedAnalysisIndexAccount {
	handle?: string;
	displayName?: string;
	avatar?: string;
}

export interface CachedAnalysisIndexResponse {
	accounts: CachedAnalysisIndexAccount[];
}

export interface AnalyzerLoadedAccount {
	profile: ProfileInfo;
	result: ThreadAnalysisResult;
	segments: BatchSegmentPayload[];
}

export interface AnalyzerMetricSelectionRef {
	index: number;
	createdAt: string;
	text: string;
}

export interface AnalyzerPaneSelectionRequest {
	token: number;
	rootUri: string;
	metricPoint?: AnalyzerMetricSelectionRef;
}

export interface AnalyzerCompareThreadSelection {
	series: AnalyzerCompareSeries;
	rootUri: string;
	metricPoint?: AnalyzerMetricSelectionRef;
}
