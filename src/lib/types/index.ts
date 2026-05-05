export interface ThreadPost {
	uri: string;
	cid: string;
	author: {
		did: string;
		handle: string;
		displayName?: string;
		avatar?: string;
	};
	text: string;
	createdAt: string;
	linkedUrls?: string[];
	needsHydratedPostView?: boolean;
	likeCount: number;
	repostCount: number;
	replyCount: number;
	quoteCount: number;
	embed?: {
		type: string;
		images?: Array<{
			thumb: string;
			fullsize: string;
			alt: string;
		}>;
		video?: {
			cid: string;
			playlist: string;
			thumbnail?: string;
			alt?: string;
			aspectRatio?: {
				width: number;
				height: number;
			};
			presentation?: string;
		};
		external?: {
			uri: string;
			title: string;
			description: string;
			thumb?: string;
		};
		record?: {
			uri: string;
			author: {
				handle: string;
				displayName?: string;
				avatar?: string;
			};
			text: string;
			createdAt: string;
			images?: Array<{
				thumb: string;
				fullsize: string;
				alt: string;
			}>;
			video?: {
				cid: string;
				playlist: string;
				thumbnail?: string;
				alt?: string;
				aspectRatio?: {
					width: number;
					height: number;
				};
				presentation?: string;
			};
		};
	};
	parentUri?: string;
	children: ThreadPost[];
}

export interface SelfReplyThread {
	rootPost: ThreadPost;
	depth: number;
	rootUri: string;
}

export interface ThreadJudgePost {
	index: number;
	uri: string;
	author: {
		did: string;
		handle: string;
		displayName?: string;
	};
	createdAt: string;
	text: string;
	depth: number;
	replyToIndex: number | null;
}

export type ThreadJudgeSentiment =
	| 'very_negative'
	| 'negative'
	| 'neutral'
	| 'positive'
	| 'very_positive'
	| 'mixed';

export interface ThreadJudgeGlossaryItem {
	term: string;
	explanation: string;
}

export interface ThreadJudgment {
	sentiment: ThreadJudgeSentiment;
	positivity: number;
	excitingness: number;
	intensity: number;
	curiosity: number;
	confidence: number;
	summary: string;
	glossary?: ThreadJudgeGlossaryItem[];
}

export interface ThreadJudgePayload {
	model: string;
	postCount: number;
	judgments: Record<string, ThreadJudgment>;
}

export interface ThreadJudgeCacheEntry {
	rootUri: string;
	threadUrl: string;
	handle: string;
	title: string;
	postCount: number;
	model: string;
	updatedAt: string;
}

export interface AuthorInfo {
	did: string;
	handle: string;
	displayName?: string;
	avatar?: string;
}

export interface DiscoverProgress {
	phase: string;
	current: number;
	total: number;
	detail?: string;
}


export interface DiscoverCallbacks {
	onProgress?: (progress: DiscoverProgress) => void;
	onThread?: (thread: SelfReplyThread) => void;
	onWarning?: (message: string) => void;
	onInfo?: (message: string) => void;
}

export interface DiscoverResult {
	stats: {
		postsScanned: number;
		chainStarts: number;
		threadsWithSelfReplies: number;
	};
	feedPosts: any[];
}

export interface CachedUserSummaryMention {
	did: string;
	count: number;
	lastMentionedAt: string | null;
}

export interface CachedUserSummaryThumbnail {
	url: string;
	alt: string;
}

export interface CachedUserSummaryPost {
	uri: string;
	createdAt: string;
	text: string;
	likeCount: number;
	repostCount: number;
	replyCount: number;
	quoteCount: number;
	thumbnail?: CachedUserSummaryThumbnail;
}

export interface CachedUserSummaryThread {
	rootUri: string;
	createdAt: string;
	text: string;
	depth: number;
	postCount: number;
	totalReplyCount: number;
	rootReplyCount: number;
	thumbnail?: CachedUserSummaryThumbnail;
}

export interface CachedUserSummaryRepeatedPost {
	text: string;
	count: number;
	latestUri: string;
	latestCreatedAt: string;
	firstCreatedAt: string;
	thumbnail?: CachedUserSummaryThumbnail;
}

export interface CachedUserSummary {
	did: string;
	updatedAt: string | null;
	cachedPostCount: number;
	analyzedPostCount: number;
	partial: boolean;
	uniqueMentionedUsers: number;
	mostMentionedUsers: CachedUserSummaryMention[];
	mostLikedPosts: CachedUserSummaryPost[];
	mostRepostedPosts: CachedUserSummaryPost[];
	mostRepeatedPosts: CachedUserSummaryRepeatedPost[];
	threadsWithMostReplies: CachedUserSummaryThread[];
}

export interface ThreadAnalysisPost {
	uri: string;
	text: string;
	createdAt: string;
}

export interface ThreadAnalysisSegment {
	index: number;
	uri: string;
	createdAt: string;
	text: string;
}

export interface ThreadAnalysisPoint {
	rootUri: string;
	depth: number;
	postCount: number;
	segmentCount: number;
	globalDistinctiveness: number | null;
	embedding?: number[];
	x: number;
	y: number;
	cluster: number;
	title: string;
	preview: string;
	text: string;
	posts: ThreadAnalysisPost[];
	segments: ThreadAnalysisSegment[];
}

export interface RunningNoveltyPoint {
	index: number;
	uri: string;
	rootUri: string;
	createdAt: string;
	novelty: number;
	title: string;
	text: string;
}

export interface RunningNoveltyAnalysis {
	model: string;
	firstValue: number;
	postsConsidered: number;
	postsAnalyzed: number;
	skippedForCache: number;
	averageNovelty: number;
	maxNovelty: number;
	latestNovelty: number;
	points: RunningNoveltyPoint[];
}

export interface GlobalDistinctivenessPoint {
	rootUri: string;
	score: number;
	title: string;
	preview: string;
}

export interface GlobalDistinctivenessAnalysis {
	model: string;
	comparedTo: string;
	available: boolean;
	corpusSize: number;
	threadsCompared: number;
	averageDistinctiveness: number;
	maxDistinctiveness: number;
	points: GlobalDistinctivenessPoint[];
}

export interface ThreadAnalysisStats {
	postsScanned: number;
	chainStarts: number;
	threadsWithSelfReplies: number;
	threadsAnalyzed: number;
	segmentCount: number;
	cacheHits: number;
	cacheMisses: number;
	skippedForCache: number;
}

export interface ThreadAnalysisResult {
	model: string;
	usedBatchApi: boolean;
	rateLimited: boolean;
	warning?: string;
	generatedAt: string;
	points: ThreadAnalysisPoint[];
	novelty: RunningNoveltyAnalysis;
	globalDistinctiveness: GlobalDistinctivenessAnalysis;
	stats: ThreadAnalysisStats;
}

export interface ClusterPoint {
	did: string;
	rootUri: string;
	cluster: number;
	x: number;
	y: number;
}

export interface ClusterRepresentative extends ClusterPoint {
	createdAt: string;
	title: string;
	preview: string;
	depth: number;
	postCount: number;
	segmentCount: number;
	score: number;
}

export interface ClusterSummary {
	cluster: number;
	label: string;
	keywords: string[];
	summary: string;
	labelSource: 'flash' | 'heuristic';
	threadCount: number;
	peopleCount: number;
	region: ClusterRegion;
	representatives: ClusterRepresentative[];
}

export interface ClusterRegion {
	x: number;
	y: number;
	radiusX: number;
	radiusY: number;
	angle: number;
	labelRank: number;
}

export interface ClusterSnapshotMeta {
	generatedAt: string;
	model: string;
	analysisVersion: string;
	embeddingNamespace: string;
	snapshotMaxPosts: number;
	totalThreads: number;
	totalPeople: number;
	clusterCount: number;
	representativesPerCluster: number;
	classificationModel: string;
	projectionMethod:
		| 'mds-cosine'
		| 'mds-cosine-refined'
		| 'atlas-cluster-relaxed'
		| 'toponomy-umap-atlas';
	projectionNeighborRecall: number;
	buildMode: 'build-once';
}

export interface ClusterSnapshot {
	meta: ClusterSnapshotMeta;
	points: ClusterPoint[];
	clusters: ClusterSummary[];
}

export interface ClusterOverview {
	meta: ClusterSnapshotMeta;
	clusters: ClusterSummary[];
}

export type ClusterBuildPhase = 'scan' | 'cluster' | 'project' | 'classify' | 'upload';

export interface ClusterBuildProgress {
	phase: ClusterBuildPhase;
	startedAt: string;
	updatedAt: string;
	objectsProcessed: number;
	threadsProcessed: number;
	uniquePeopleSoFar: number;
	pageIndex: number;
	hasMore: boolean;
	clusterCount?: number;
	totalThreads?: number;
	projectionBlocksProcessed?: number;
	projectionBlocksTotal?: number;
}

export interface ClusterBuildFailure {
	phase: ClusterBuildPhase;
	message: string;
	updatedAt: string;
	details?: string;
}

export type ClusterApiResponse =
	| { status: 'ready' }
	| { status: 'building'; progress: ClusterBuildProgress }
	| { status: 'failed'; failure: ClusterBuildFailure }
	| { status: 'missing' };

export interface ClusterInspectorThread {
	did: string;
	rootUri: string;
	title: string;
	preview: string;
	depth: number;
	postCount: number;
	segmentCount: number;
	posts: ThreadAnalysisPost[];
	segments: ThreadAnalysisSegment[];
	source: 'analysis-cache' | 'post-cache';
	cacheLimited: boolean;
}

export type ClusterThreadApiResponse =
	| { status: 'ready'; thread: ClusterInspectorThread }
	| { status: 'missing'; message: string };
