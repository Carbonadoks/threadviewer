<script lang="ts">
	import { normalizeVector } from '$lib/utils/threadAnalysis';
	import type { RunningNoveltyPoint, ThreadAnalysisPoint } from '$lib/types';
	import type {
		AnalyzerLoadedAccount,
		AnalyzerPaneSelectionRequest,
		BatchSegmentPayload,
		SequenceMetricTab
	} from './types';

	const clusterPalette = ['#e07a5f', '#3d405b', '#81b29a', '#f2cc8f', '#c8553d', '#5f0f40'];
	const PLOT_WIDTH = 720;
	const PLOT_HEIGHT = 520;
	const PLOT_PADDING = 58;
	const NOVELTY_WIDTH = 960;
	const NOVELTY_HEIGHT = 280;
	const NOVELTY_PADDING_X = 48;
	const NOVELTY_PADDING_Y = 30;
	const WEIRDNESS_WIDTH = 920;
	const WEIRDNESS_HEIGHT = 420;
	const WEIRDNESS_PADDING = 56;
	const EMBEDDING_MODEL_LABEL = '@cf/baai/bge-small-en-v1.5 (cls)';
	const FIRST_NOVELTY_FALLBACK = 0;
	const INTERESTINGNESS_EDGE_FALLBACK = 0;

	type PlotPoint = ThreadAnalysisPoint & {
		cx: number;
		cy: number;
		radius: number;
		color: string;
		active: boolean;
		focused: boolean;
		muted: boolean;
		representative: boolean;
		selectedRepresentative: boolean;
	};

	type SequenceMetricPoint = {
		index: number;
		uri: string;
		rootUri: string;
		createdAt: string;
		score: number;
		title: string;
		text: string;
	};

	type NoveltyPlotPoint = SequenceMetricPoint & {
		x: number;
		y: number;
		active: boolean;
	};

	type WeirdnessPoint = ThreadAnalysisPoint & {
		personalWeirdness: number;
		personalPercentile: number;
		corpusWeirdness: number | null;
		corpusPercentile: number | null;
		combinedWeirdness: number;
		rank: number;
		cx: number;
		cy: number;
		active: boolean;
	};

	type SequenceMetricAnalysis = {
		tab: SequenceMetricTab;
		label: string;
		model: string;
		firstValue: number;
		postsConsidered: number;
		postsAnalyzed: number;
		skippedForCache: number;
		averageScore: number;
		maxScore: number;
		latestScore: number;
		points: SequenceMetricPoint[];
	};

	type PlotClusterBadge = {
		cluster: number;
		label: string;
		color: string;
		x: number;
		y: number;
		count: number;
		active: boolean;
	};

	type ClusterClassification = {
		cluster: number;
		color: string;
		label: string;
		keywords: string[];
		summary?: string;
		source: 'heuristic' | 'flash';
		count: number;
		averageDepth: number;
		averageSegments: number;
		representative: ThreadAnalysisPoint;
	};

	type SemanticClassificationOverride = {
		cluster: number;
		label: string;
		keywords: string[];
		summary: string;
	};

	type SemanticClassificationResponse = {
		model: string;
		classifications: SemanticClassificationOverride[];
	};

	type SelectedChunkRef = {
		rootUri: string;
		index: number;
	};

	type ActiveChunk = {
		rootUri: string;
		index: number;
		text: string;
		createdAt: string;
	};

	const CLASSIFICATION_STOPWORDS = new Set([
		'the',
		'and',
		'that',
		'this',
		'with',
		'from',
		'they',
		'them',
		'then',
		'there',
		'their',
		'about',
		'into',
		'because',
		'after',
		'before',
		'while',
		'where',
		'when',
		'what',
		'which',
		'just',
		'than',
		'have',
		'has',
		'will',
		'would',
		'could',
		'should',
		'been',
		'being',
		'were',
		'was',
		'are',
		'you',
		'your',
		'its',
		'our',
		'out',
		'for',
		'not',
		'but',
		'too',
		'can',
		'cant',
		'dont',
		'does',
		'did',
		'why',
		'how',
		'who',
		'all',
		'any',
		'more',
		'most',
		'some',
		'like',
		'thread',
		'threads',
		'post',
		'posts',
		'reply',
		'replies'
	]);

	let {
		analysis,
		metricTab = $bindable<SequenceMetricTab>('novelty'),
		metricListSortOrder = $bindable<'asc' | 'desc'>('desc'),
		compareMode = false,
		paneLabel = '',
		paneId = '',
		selectionRequest = null
	}: {
		analysis: AnalyzerLoadedAccount;
		metricTab: SequenceMetricTab;
		metricListSortOrder: 'asc' | 'desc';
		compareMode?: boolean;
		paneLabel?: string;
		paneId?: string;
		selectionRequest?: AnalyzerPaneSelectionRequest | null;
	} = $props();

	const result = $derived(analysis.result);
	const profile = $derived(analysis.profile);

	let selectedRootUri = $state<string | null>(null);
	let selectedCluster = $state<number | null>(null);
	let detailMode = $state<'thread' | 'class'>('thread');
	let selectedNoveltyIndex = $state<number | null>(null);
	let classificationLoading = $state(false);
	let classificationModel = $state('');
	let classificationError: string | null = $state(null);
	let semanticOverrides = $state<Record<number, SemanticClassificationOverride>>({});
	let classificationRequestId = 0;
	let noveltyBaseSegments = $state<BatchSegmentPayload[]>([]);
	let noveltyOrderMode = $state<'chronological' | 'random'>('chronological');
	let classLock = $state(true);
	let selectedChunk = $state<SelectedChunkRef | null>(null);
	let analysisStateKey = '';
	let previousMetricTab: SequenceMetricTab | null = null;
	let previousCompareMode = false;
	let previousSelectionToken = 0;

	function isActivationKey(event: KeyboardEvent): boolean {
		return event.key === 'Enter' || event.key === ' ';
	}

	function scaleCoordinate(value: number, max: number, padding: number): number {
		const clamped = Math.max(-1, Math.min(1, value));
		const usable = max - padding * 2;
		return padding + ((clamped + 1) / 2) * usable;
	}

	function clusterColor(cluster: number): string {
		return clusterPalette[cluster % clusterPalette.length];
	}

	function buildThreadUrl(rootUri: string): string {
		const rkey = rootUri.split('/').pop() || '';
		return profile?.handle ? `https://bsky.app/profile/${profile.handle}/post/${rkey}` : '';
	}

	function pointByRootUri(rootUri: string): ThreadAnalysisPoint | null {
		return result?.points.find((candidate) => candidate.rootUri === rootUri) ?? null;
	}

	function setSelectedChunk(rootUri: string, index: number | null) {
		selectedChunk = index ? { rootUri, index } : null;
	}

	function selectSegment(rootUri: string, index: number) {
		selectedRootUri = rootUri;
		setSelectedChunk(rootUri, index);
	}

	function focusThread(
		rootUri: string,
		options: {
			source?: 'bubble' | 'novelty' | 'class' | 'weirdness';
		} = {}
	) {
		const point = pointByRootUri(rootUri);
		if (!point) return;

		const source = options.source ?? 'bubble';
		const outsideFocusedCluster =
			selectedCluster !== null && point.cluster !== selectedCluster;

		if (source === 'bubble') {
			if (classLock && outsideFocusedCluster) {
				return;
			}
			if (selectedCluster === null || outsideFocusedCluster) {
				selectedCluster = point.cluster;
			}
			detailMode = 'thread';
		} else if (source === 'novelty' || source === 'weirdness') {
			if (selectedCluster === null || outsideFocusedCluster) {
				selectedCluster = point.cluster;
			}
			detailMode = 'thread';
		} else {
			if (selectedCluster === null) {
				selectedCluster = point.cluster;
			}
			detailMode = 'thread';
		}

		selectedRootUri = rootUri;
		if (source !== 'novelty') {
			selectedNoveltyIndex = null;
			setSelectedChunk(rootUri, null);
		}
	}

	function focusThreadFromCompareOverlay(rootUri: string) {
		const point = pointByRootUri(rootUri);
		if (!point) return;
		selectedCluster = point.cluster;
		detailMode = 'thread';
		selectedRootUri = rootUri;
		selectedNoveltyIndex = null;
		setSelectedChunk(rootUri, null);
	}

	function focusClassification(classification: ClusterClassification) {
		detailMode = 'class';
		selectedCluster = classification.cluster;
		selectedRootUri = classification.representative.rootUri;
		selectedNoveltyIndex = null;
		selectedChunk = null;
	}

	function focusClassificationByCluster(cluster: number) {
		const classification = clusterClassifications.find((candidate) => candidate.cluster === cluster);
		if (classification) {
			focusClassification(classification);
		}
	}

	function formatDateLabel(value: string): string {
		const parsed = new Date(value);
		if (!Number.isFinite(parsed.getTime())) return value;
		return parsed.toLocaleDateString();
	}

	function formatRelativeTime(value: string): string {
		const parsed = new Date(value);
		if (!Number.isFinite(parsed.getTime())) return value;

		const diffMs = parsed.getTime() - Date.now();
		const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
		const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
			['day', 1000 * 60 * 60 * 24],
			['hour', 1000 * 60 * 60],
			['minute', 1000 * 60]
		];

		for (const [unit, step] of units) {
			if (Math.abs(diffMs) >= step || unit === 'minute') {
				return formatter.format(Math.round(diffMs / step), unit);
			}
		}

		return formatter.format(0, 'minute');
	}

	function toggleClassLock() {
		classLock = !classLock;
	}

	function dotProduct(a: number[], b: number[]): number {
		let total = 0;
		const length = Math.min(a.length, b.length);
		for (let i = 0; i < length; i++) {
			total += a[i] * b[i];
		}
		return total;
	}

	function clamp01(value: number): number {
		if (!Number.isFinite(value)) return 0;
		return Math.max(0, Math.min(1, value));
	}

	function parseTimeline(value: string): number {
		const timestamp = Date.parse(value);
		return Number.isFinite(timestamp) ? timestamp : Number.MAX_SAFE_INTEGER;
	}

	function threadCreatedAt(point: ThreadAnalysisPoint): string {
		return point.segments[0]?.createdAt ?? point.posts[0]?.createdAt ?? '';
	}

	function threadTimelineValue(point: ThreadAnalysisPoint): number {
		return parseTimeline(threadCreatedAt(point));
	}

	function cosineDistance(a: number[], b: number[]): number {
		const cosine = Math.max(-1, Math.min(1, dotProduct(normalizeVector(a), normalizeVector(b))));
		return 1 - cosine;
	}

	function buildPercentileLookup(
		entries: Array<{ rootUri: string; score: number | null }>
	): Map<string, number | null> {
		const lookup = new Map<string, number | null>();
		const scored = entries
			.filter((entry): entry is { rootUri: string; score: number } => Number.isFinite(entry.score))
			.sort((a, b) => a.score - b.score || a.rootUri.localeCompare(b.rootUri));

		for (const entry of entries) {
			if (!Number.isFinite(entry.score)) {
				lookup.set(entry.rootUri, null);
			}
		}

		if (scored.length === 0) {
			return lookup;
		}

		if (scored.length === 1) {
			lookup.set(scored[0].rootUri, 0);
			return lookup;
		}

		let start = 0;
		while (start < scored.length) {
			let end = start + 1;
			while (end < scored.length && Math.abs(scored[end].score - scored[start].score) < 1e-9) {
				end += 1;
			}

			const percentile = ((start + end - 1) / 2) / (scored.length - 1);
			for (let index = start; index < end; index++) {
				lookup.set(scored[index].rootUri, percentile);
			}

			start = end;
		}

		return lookup;
	}

	function buildPersonalWeirdnessScores(points: ThreadAnalysisPoint[]): Map<string, number> {
		const scores = new Map<string, number>();
		for (const point of points) {
			scores.set(point.rootUri, 0);
		}

		const embedded = points
			.filter(
				(point): point is ThreadAnalysisPoint & { embedding: number[] } =>
					Array.isArray(point.embedding) && point.embedding.length > 0
			)
			.map((point) => ({
				rootUri: point.rootUri,
				vector: normalizeVector(point.embedding)
			}));

		if (embedded.length < 2) {
			return scores;
		}

		const totals = new Array<number>(embedded[0].vector.length).fill(0);
		for (const entry of embedded) {
			for (let axis = 0; axis < totals.length; axis++) {
				totals[axis] += entry.vector[axis] ?? 0;
			}
		}

		for (const entry of embedded) {
			const reference = totals.map(
				(total, axis) => (total - (entry.vector[axis] ?? 0)) / (embedded.length - 1)
			);
			scores.set(entry.rootUri, cosineDistance(entry.vector, reference));
		}

		return scores;
	}

	function buildWeirdnessPoints(): WeirdnessPoint[] {
		if (result.points.length === 0) return [];

		const personalScores = buildPersonalWeirdnessScores(result.points);
		const personalPercentiles = buildPercentileLookup(
			result.points.map((point) => ({
				rootUri: point.rootUri,
				score: personalScores.get(point.rootUri) ?? 0
			}))
		);
		const corpusPercentiles = buildPercentileLookup(
			result.points.map((point) => ({
				rootUri: point.rootUri,
				score: typeof point.globalDistinctiveness === 'number' ? point.globalDistinctiveness : null
			}))
		);

		const usableWidth = WEIRDNESS_WIDTH - WEIRDNESS_PADDING * 2;
		const usableHeight = WEIRDNESS_HEIGHT - WEIRDNESS_PADDING * 2;
		const activeRoot = selectedRootUri ?? result.points[0]?.rootUri ?? null;

		return [...result.points]
			.map((point) => {
				const personalWeirdness = personalScores.get(point.rootUri) ?? 0;
				const personalPercentile = personalPercentiles.get(point.rootUri) ?? 0;
				const corpusWeirdness =
					typeof point.globalDistinctiveness === 'number' ? point.globalDistinctiveness : null;
				const corpusPercentile = corpusPercentiles.get(point.rootUri) ?? null;
				const combinedWeirdness =
					corpusPercentile === null
						? personalPercentile
						: personalPercentile * 0.55 + corpusPercentile * 0.45;

				return {
					...point,
					personalWeirdness,
					personalPercentile,
					corpusWeirdness,
					corpusPercentile,
					combinedWeirdness,
					rank: 0,
					cx: WEIRDNESS_PADDING + clamp01(personalPercentile) * usableWidth,
					cy:
						WEIRDNESS_HEIGHT -
						WEIRDNESS_PADDING -
						clamp01(corpusPercentile ?? 0) * usableHeight,
					active: point.rootUri === activeRoot
				};
			})
			.sort(
				(a, b) =>
					b.combinedWeirdness - a.combinedWeirdness ||
					b.personalPercentile - a.personalPercentile ||
					(b.corpusPercentile ?? -1) - (a.corpusPercentile ?? -1) ||
					threadTimelineValue(a) - threadTimelineValue(b) ||
					a.rootUri.localeCompare(b.rootUri)
			)
			.map((point, index) => ({
				...point,
				rank: index + 1,
				active: point.rootUri === activeRoot
			}));
	}

	function buildSelectedWeirdnessPoint(): WeirdnessPoint | null {
		if (weirdnessPoints.length === 0) return null;
		if (selectedRootUri) {
			return weirdnessPoints.find((point) => point.rootUri === selectedRootUri) ?? weirdnessPoints[0];
		}
		return weirdnessPoints[0];
	}

	function selectWeirdnessPoint(point: WeirdnessPoint) {
		focusThread(point.rootUri, { source: 'weirdness' });
	}

	function handleWeirdnessSelectionKeydown(event: KeyboardEvent, point: WeirdnessPoint) {
		if (!isActivationKey(event)) return;
		event.preventDefault();
		selectWeirdnessPoint(point);
	}

	function formatPercentScore(value: number | null): string {
		return `${Math.round(clamp01(value ?? 0) * 100)}`;
	}

	function formatOptionalPercentScore(value: number | null): string {
		return value === null ? 'n/a' : formatPercentScore(value);
	}

	function formatRawScore(value: number | null): string {
		return value === null ? 'n/a' : value.toFixed(2);
	}

	function weirdnessQuadrantLabel(point: WeirdnessPoint): string {
		const personalHigh = point.personalPercentile >= 0.66;
		const corpusHigh = (point.corpusPercentile ?? 0) >= 0.66;

		if (personalHigh && corpusHigh) {
			return 'Off-brand and globally odd';
		}
		if (personalHigh) {
			return 'Off-brand for this author';
		}
		if (corpusHigh) {
			return 'Fits the author, odd in the corpus';
		}
		return 'Near the baseline';
	}

	function weirdnessSummary(point: WeirdnessPoint): string {
		const personalHigh = point.personalPercentile >= 0.66;
		const corpusHigh = (point.corpusPercentile ?? 0) >= 0.66;

		if (personalHigh && corpusHigh) {
			return `This thread is far from @${profile.handle}'s usual center and also sits away from the cached corpus default.`;
		}
		if (personalHigh) {
			return `This thread breaks from @${profile.handle}'s usual semantic center more than it breaks from the wider cached corpus.`;
		}
		if (corpusHigh) {
			return `This thread still fits @${profile.handle}, but the topic sits farther from the cached corpus center than most of this account's threads.`;
		}
		return `This thread stays relatively close to both @${profile.handle}'s center and the cached corpus center.`;
	}

	function emptyAggregatedNovelty(): typeof result.novelty {
		return {
			model: EMBEDDING_MODEL_LABEL,
			firstValue: FIRST_NOVELTY_FALLBACK,
			postsConsidered: 0,
			postsAnalyzed: 0,
			skippedForCache: 0,
			averageNovelty: 0,
			maxNovelty: 0,
			latestNovelty: 0,
			points: []
		};
	}

	function emptySequenceMetricAnalysis(
		tab: SequenceMetricTab,
		label: string
	): SequenceMetricAnalysis {
		return {
			tab,
			label,
			model: EMBEDDING_MODEL_LABEL,
			firstValue: tab === 'novelty' ? FIRST_NOVELTY_FALLBACK : INTERESTINGNESS_EDGE_FALLBACK,
			postsConsidered: 0,
			postsAnalyzed: 0,
			skippedForCache: 0,
			averageScore: 0,
			maxScore: 0,
			latestScore: 0,
			points: []
		};
	}

	function sortNoveltySegments(segments: BatchSegmentPayload[]): BatchSegmentPayload[] {
		return [...segments]
			.map((segment, order) => ({ ...segment, order }))
			.sort(
				(a, b) =>
					new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime() ||
					a.rootUri.localeCompare(b.rootUri) ||
					a.order - b.order
			)
			.map(({ order: _order, ...segment }) => segment);
	}

	function shuffleNoveltySegments(segments: BatchSegmentPayload[]): BatchSegmentPayload[] {
		const shuffled = [...segments];
		for (let index = shuffled.length - 1; index > 0; index--) {
			const swapIndex = Math.floor(Math.random() * (index + 1));
			[shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
		}
		return shuffled;
	}

	function resetNoveltyControls(segments: BatchSegmentPayload[]) {
		noveltyBaseSegments = sortNoveltySegments(segments);
		noveltyOrderMode = 'chronological';
		selectedNoveltyIndex = null;
	}

	function setChronologicalNoveltyOrder() {
		resetNoveltyControls(analysis.segments);
	}

	function randomizeNoveltyOrder() {
		if (compareMode || noveltyBaseSegments.length === 0) return;
		noveltyBaseSegments = shuffleNoveltySegments(sortNoveltySegments(noveltyBaseSegments));
		noveltyOrderMode = 'random';
		selectedNoveltyIndex = null;
	}

	function setMetricTab(tab: SequenceMetricTab) {
		if (tab === metricTab) return;
		metricTab = tab;
	}

	function buildOrderedNoveltySegments(): BatchSegmentPayload[] {
		return noveltyBaseSegments;
	}

	function buildAggregatedNovelty(segments: BatchSegmentPayload[]): typeof result.novelty {
		if (segments.length === 0) {
			return emptyAggregatedNovelty();
		}

		const points: RunningNoveltyPoint[] = [];
		let centroid: number[] | null = null;
		let noveltyTotal = 0;
		let maxNovelty = 0;
		let latestNovelty = 0;

		for (let index = 0; index < segments.length; index++) {
			const segment = segments[index];
			const normalized = normalizeVector(segment.embedding);
			let novelty = FIRST_NOVELTY_FALLBACK;

			if (centroid) {
				const centroidUnit = normalizeVector(centroid);
				const cosine = Math.max(-1, Math.min(1, dotProduct(normalized, centroidUnit)));
				novelty = 1 - cosine;
			}

			points.push({
				index: index + 1,
				uri: segment.uri,
				rootUri: segment.rootUri,
				createdAt: segment.createdAt,
				novelty,
				title: segment.title,
				text: segment.text
			});

			const nextCount = index + 1;
			noveltyTotal += novelty;
			maxNovelty = Math.max(maxNovelty, novelty);
			latestNovelty = novelty;

			if (!centroid) {
				centroid = normalized.slice();
			} else {
				for (let i = 0; i < centroid.length; i++) {
					centroid[i] = ((nextCount - 1) * centroid[i] + normalized[i]) / nextCount;
				}
			}
		}

		return {
			model: EMBEDDING_MODEL_LABEL,
			firstValue: FIRST_NOVELTY_FALLBACK,
			postsConsidered: segments.length,
			postsAnalyzed: segments.length,
			skippedForCache: 0,
			averageNovelty: segments.length > 0 ? noveltyTotal / segments.length : 0,
			maxNovelty,
			latestNovelty,
			points
		};
	}

	function buildNoveltyMetricAnalysis(novelty: typeof result.novelty): SequenceMetricAnalysis {
		return {
			tab: 'novelty',
			label: 'Novelty',
			model: novelty.model,
			firstValue: novelty.firstValue,
			postsConsidered: novelty.postsConsidered,
			postsAnalyzed: novelty.postsAnalyzed,
			skippedForCache: novelty.skippedForCache,
			averageScore: novelty.averageNovelty,
			maxScore: novelty.maxNovelty,
			latestScore: novelty.latestNovelty,
			points: novelty.points.map((point) => ({
				index: point.index,
				uri: point.uri,
				rootUri: point.rootUri,
				createdAt: point.createdAt,
				score: point.novelty,
				title: point.title,
				text: point.text
			}))
		};
	}

	function buildInterestingnessAnalysis(segments: BatchSegmentPayload[]): SequenceMetricAnalysis {
		if (segments.length === 0) {
			return emptySequenceMetricAnalysis('interestingness', 'Interestingness');
		}

		const rawPoints: SequenceMetricPoint[] = [];
		let centroid: number[] | null = null;

		for (let index = 0; index < segments.length; index++) {
			const segment = segments[index];
			const currentEmbedding = normalizeVector(segment.embedding);
			const nextSegment = segments[index + 1];
			let rawScore = INTERESTINGNESS_EDGE_FALLBACK;
			let centroidAfter = currentEmbedding.slice();

			if (centroid) {
				const nextCount = index + 1;
				centroidAfter = centroid.map(
					(value, axis) => ((nextCount - 1) * value + currentEmbedding[axis]) / nextCount
				);
			}

			if (centroid && nextSegment) {
				const nextEmbedding = normalizeVector(nextSegment.embedding);
				const cosineBefore = Math.max(-1, Math.min(1, dotProduct(nextEmbedding, normalizeVector(centroid))));
				const cosineAfter = Math.max(
					-1,
					Math.min(1, dotProduct(nextEmbedding, normalizeVector(centroidAfter)))
				);
				rawScore = cosineAfter - cosineBefore;
			}

			centroid = centroidAfter;
			rawPoints.push({
				index: index + 1,
				uri: segment.uri,
				rootUri: segment.rootUri,
				createdAt: segment.createdAt,
				score: rawScore,
				title: segment.title,
				text: segment.text
			});
		}

		const maxAbsRaw = rawPoints.reduce((max, point) => Math.max(max, Math.abs(point.score)), 0);
		const normalizationScale = maxAbsRaw > 0 ? maxAbsRaw : 1;
		const points = rawPoints.map((point) => ({
			...point,
			score: point.score / normalizationScale
		}));
		const total = points.reduce((sum, point) => sum + point.score, 0);
		const maxScore = points.reduce((max, point) => Math.max(max, point.score), 0);
		const latestScore = points[points.length - 1]?.score ?? INTERESTINGNESS_EDGE_FALLBACK;

		return {
			tab: 'interestingness',
			label: 'Interestingness',
			model: EMBEDDING_MODEL_LABEL,
			firstValue: INTERESTINGNESS_EDGE_FALLBACK,
			postsConsidered: segments.length,
			postsAnalyzed: segments.length,
			skippedForCache: 0,
			averageScore: segments.length > 0 ? total / segments.length : 0,
			maxScore,
			latestScore,
			points
		};
	}

	function activePoint(): ThreadAnalysisPoint | null {
		if (result.points.length === 0) return null;
		if (selectedRootUri) {
			return pointByRootUri(selectedRootUri) ?? result.points[0];
		}

		const fallbackRoot = activeClassification?.representative.rootUri ?? result.points[0]?.rootUri ?? null;
		return (fallbackRoot ? pointByRootUri(fallbackRoot) : null) ?? result.points[0];
	}

	function tokenizeForClassification(text: string): string[] {
		return (
			text
				.toLowerCase()
				.replace(/https?:\/\/\S+/g, ' ')
				.match(/[a-z][a-z0-9'-]{2,}/g)
				?.filter((token) => !CLASSIFICATION_STOPWORDS.has(token)) ?? []
		);
	}

	function buildClassificationPayload(points: ThreadAnalysisPoint[]) {
		const groups = new Map<number, ThreadAnalysisPoint[]>();
		for (const point of points) {
			const existing = groups.get(point.cluster);
			if (existing) {
				existing.push(point);
			} else {
				groups.set(point.cluster, [point]);
			}
		}

		return [...groups.entries()]
			.map(([cluster, clusterPoints]) => {
				const selected = [...clusterPoints]
					.sort(
						(a, b) =>
							b.depth - a.depth ||
							b.segmentCount - a.segmentCount ||
							b.postCount - a.postCount ||
							a.title.localeCompare(b.title)
					)
					.slice(0, 4);

				const text = selected
					.map(
						(point, index) =>
							`Thread ${index + 1}: ${point.title}\n${point.text.slice(0, 1400)}`
					)
					.join('\n\n');

				return {
					cluster,
					text: text.slice(0, 5600)
				};
			})
			.filter((cluster) => cluster.text.trim().length > 0)
			.slice(0, 12);
	}

	async function loadSemanticClassifications(target: typeof result, requestId: number) {
		const clusters = buildClassificationPayload(target.points);
		if (clusters.length === 0) {
			if (requestId === classificationRequestId) {
				classificationLoading = false;
				classificationModel = '';
				classificationError = null;
				semanticOverrides = {};
			}
			return;
		}

		classificationLoading = true;
		classificationError = null;

		try {
			const response = await fetch('/api/analyzer/classify', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json'
				},
				body: JSON.stringify({
					did: profile.did,
					clusters
				})
			});

			const payload = (await response.json().catch(() => null)) as SemanticClassificationResponse | null;
			if (!response.ok) {
				throw new Error((payload as any)?.message || `Classification failed: ${response.status}`);
			}

			if (requestId !== classificationRequestId || !payload) {
				return;
			}

			const nextOverrides: Record<number, SemanticClassificationOverride> = {};
			for (const classification of payload.classifications ?? []) {
				if (!Number.isFinite(classification?.cluster)) continue;
				nextOverrides[classification.cluster] = classification;
			}

			semanticOverrides = nextOverrides;
			classificationModel = payload.model || '';
			if (
				(payload.model || '').includes('(fetch-disabled)') &&
				Object.keys(nextOverrides).length === 0
			) {
				classificationError =
					'FETCH=0 disables live Gemini Flash labeling. Showing keyword labels unless a cached label already exists.';
			}
		} catch (error: any) {
			if (requestId !== classificationRequestId) {
				return;
			}
			classificationError = error?.message || 'Flash classification failed.';
			semanticOverrides = {};
			classificationModel = '';
		} finally {
			if (requestId === classificationRequestId) {
				classificationLoading = false;
			}
		}
	}

	function buildClusterClassifications(): ClusterClassification[] {
		const groups = new Map<number, ThreadAnalysisPoint[]>();
		for (const point of result.points) {
			const existing = groups.get(point.cluster);
			if (existing) {
				existing.push(point);
			} else {
				groups.set(point.cluster, [point]);
			}
		}

		return [...groups.entries()]
			.map(([cluster, points]) => {
				const counts = new Map<string, number>();

				for (const point of points) {
					const tokens = tokenizeForClassification(`${point.title} ${point.preview}`);
					for (const token of tokens) {
						counts.set(token, (counts.get(token) ?? 0) + 1);
					}
				}

				const keywords = [...counts.entries()]
					.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
					.slice(0, 3)
					.map(([token]) => token);
				const representative = [...points].sort(
					(a, b) =>
						b.depth - a.depth ||
						b.segmentCount - a.segmentCount ||
						a.title.localeCompare(b.title)
				)[0];
				const override = semanticOverrides[cluster];

				return {
					cluster,
					color: clusterColor(cluster),
					label:
						override?.label ||
						(keywords.length > 0 ? keywords.slice(0, 2).join(' / ') : `Cluster ${cluster + 1}`),
					keywords: override?.keywords?.length ? override.keywords : keywords,
					summary: override?.summary,
					source: (override ? 'flash' : 'heuristic') as 'flash' | 'heuristic',
					count: points.length,
					averageDepth: points.reduce((sum, point) => sum + point.depth, 0) / points.length,
					averageSegments:
						points.reduce((sum, point) => sum + point.segmentCount, 0) / points.length,
					representative
				};
			})
			.sort((a, b) => b.count - a.count || a.cluster - b.cluster);
	}

	function buildActiveClassification(): ClusterClassification | null {
		if (clusterClassifications.length === 0) return null;
		const cluster = selectedCluster ?? clusterClassifications[0]?.cluster ?? null;
		if (cluster === null) {
			return clusterClassifications[0] ?? null;
		}
		return (
			clusterClassifications.find((classification) => classification.cluster === cluster) ??
			clusterClassifications[0] ??
			null
		);
	}

	function buildActiveClusterPoints(): ThreadAnalysisPoint[] {
		const cluster = activeClassification?.cluster;
		if (cluster === undefined) return [];

		return [...result.points]
			.filter((point) => point.cluster === cluster)
			.sort(
				(a, b) =>
					b.depth - a.depth ||
					b.segmentCount - a.segmentCount ||
					b.postCount - a.postCount ||
					a.title.localeCompare(b.title)
			);
	}

	function buildActiveClusterPostTotal(): number {
		return activeClusterPoints.reduce((sum, point) => sum + point.postCount, 0);
	}

	function clusterLabel(cluster: number): string {
		return (
			clusterClassifications.find((classification) => classification.cluster === cluster)?.label ??
			`Class ${cluster + 1}`
		);
	}

	function buildDisplayedNovelty(): typeof result.novelty {
		if (orderedNoveltySegments.length > 0) {
			return buildAggregatedNovelty(orderedNoveltySegments);
		}
		return result.novelty;
	}

	function buildDistinctivenessMetricAnalysis(): SequenceMetricAnalysis {
		if (!result.globalDistinctiveness?.available) {
			return emptySequenceMetricAnalysis('distinctiveness', 'Distinctiveness');
		}

		const parseTimeline = (value: string): number => {
			const timestamp = Date.parse(value);
			return Number.isFinite(timestamp) ? timestamp : Number.MAX_SAFE_INTEGER;
		};

		const scored = [...result.points]
			.filter(
				(point): point is ThreadAnalysisPoint & { globalDistinctiveness: number } =>
					typeof point.globalDistinctiveness === 'number'
			)
			.sort(
				(a, b) =>
					parseTimeline(a.posts[0]?.createdAt ?? a.segments[0]?.createdAt ?? '') -
						parseTimeline(b.posts[0]?.createdAt ?? b.segments[0]?.createdAt ?? '') ||
					a.rootUri.localeCompare(b.rootUri)
			);

		if (scored.length === 0) {
			return {
				...emptySequenceMetricAnalysis('distinctiveness', 'Distinctiveness'),
				model: result.globalDistinctiveness.model,
				postsConsidered: result.globalDistinctiveness.threadsCompared
			};
		}

		const points = scored.map((thread, index) => ({
			index: index + 1,
			uri: thread.rootUri,
			rootUri: thread.rootUri,
			createdAt: thread.segments[0]?.createdAt ?? thread.posts[0]?.createdAt ?? '',
			score: thread.globalDistinctiveness,
			title: thread.title,
			text: thread.preview
		}));

		return {
			tab: 'distinctiveness',
			label: 'Distinctiveness',
			model: result.globalDistinctiveness.model,
			firstValue: 0,
			postsConsidered: result.globalDistinctiveness.threadsCompared,
			postsAnalyzed: scored.length,
			skippedForCache: 0,
			averageScore: result.globalDistinctiveness.averageDistinctiveness,
			maxScore: result.globalDistinctiveness.maxDistinctiveness,
			latestScore: points[points.length - 1]?.score ?? 0,
			points
		};
	}

	function buildActiveMetricAnalysis(): SequenceMetricAnalysis {
		if (metricTab === 'distinctiveness') {
			return distinctivenessAnalysis;
		}

		if (metricTab === 'interestingness') {
			return interestingnessAnalysis;
		}

		return noveltyMetricAnalysis;
	}

	function buildTopMetricPoints(): SequenceMetricPoint[] {
		if (activeMetricAnalysis.points.length === 0) return [];
		return [...activeMetricAnalysis.points].sort((a, b) =>
			metricListSortOrder === 'asc'
				? a.score - b.score || a.index - b.index
				: b.score - a.score || a.index - b.index
		);
	}

	function activeMetricPoint(): SequenceMetricPoint | null {
		if (activeMetricAnalysis.points.length === 0) return null;

		if (selectedNoveltyIndex !== null) {
			return activeMetricAnalysis.points.find((point) => point.index === selectedNoveltyIndex) ?? null;
		}

		return buildTopMetricPoints()[0] ?? activeMetricAnalysis.points[0];
	}

	function setSharedMetricListSortOrder(order: 'asc' | 'desc') {
		if (metricListSortOrder === order) return;
		metricListSortOrder = order;
	}

	function selectMetricPoint(point: SequenceMetricPoint) {
		const thread = pointByRootUri(point.rootUri);
		if (!thread) return;

		selectedNoveltyIndex = point.index;
		selectedRootUri = point.rootUri;

		if (metricTab === 'distinctiveness') {
			selectedChunk = null;
			focusThread(point.rootUri, { source: 'novelty' });
			return;
		}

		const matchedSegment =
			thread.segments.find(
				(segment) => segment.createdAt === point.createdAt && segment.text === point.text
			) ??
			thread.segments.find((segment) => segment.text === point.text) ??
			thread.segments[0];

		if (matchedSegment) {
			setSelectedChunk(point.rootUri, matchedSegment.index);
		}

		focusThread(point.rootUri, { source: 'novelty' });
	}

	function findMetricPointForSelection(
		request: AnalyzerPaneSelectionRequest
	): SequenceMetricPoint | null {
		const metricPoint = request.metricPoint;
		if (!metricPoint) return null;

		return (
			activeMetricAnalysis.points.find(
				(point) =>
					point.rootUri === request.rootUri &&
					point.index === metricPoint.index &&
					point.createdAt === metricPoint.createdAt &&
					point.text === metricPoint.text
			) ??
			activeMetricAnalysis.points.find(
				(point) =>
					point.rootUri === request.rootUri &&
					point.index === metricPoint.index &&
					point.createdAt === metricPoint.createdAt
			) ??
			activeMetricAnalysis.points.find(
				(point) => point.rootUri === request.rootUri && point.index === metricPoint.index
			) ??
			null
		);
	}

	function buildActiveChunk(): ActiveChunk | null {
		const currentChunk = selectedChunk;
		if (!currentChunk) return null;
		const point = pointByRootUri(currentChunk.rootUri);
		const segment = point?.segments.find((candidate) => candidate.index === currentChunk.index);
		if (!segment) return null;
		return {
			rootUri: currentChunk.rootUri,
			index: segment.index,
			text: segment.text,
			createdAt: segment.createdAt
		};
	}

	function showClassOverview() {
		detailMode = 'class';
	}

	function resetInspector() {
		const first = clusterClassifications[0];
		if (!first) return;

		selectedCluster = first.cluster;
		selectedRootUri = first.representative.rootUri;
		selectedNoveltyIndex = null;
		selectedChunk = null;
		detailMode = 'class';
	}

	function stepBack() {
		if (selectedChunk) {
			selectedChunk = null;
			return;
		}

		if (detailMode === 'thread') {
			showClassOverview();
		}
	}

	function canStepBack(): boolean {
		return selectedChunk !== null || detailMode === 'thread';
	}

	function showSelectedMetricThread() {
		if (!selectedMetricPoint) return;
		detailMode = 'thread';
		selectedRootUri = selectedMetricPoint.rootUri;
	}

	function buildPlotPoints(): PlotPoint[] {
		const focusedCluster = activeClassification?.cluster ?? null;
		const activeRoot = selectedRootUri ?? result.points[0]?.rootUri ?? null;
		const representativeByCluster = new Map(
			clusterClassifications.map((classification) => [
				classification.cluster,
				classification.representative.rootUri
			])
		);

		return result.points.map((point) => {
			const representativeRoot = representativeByCluster.get(point.cluster) ?? null;
			const representative = representativeRoot === point.rootUri;

			return {
				...point,
				cx: scaleCoordinate(point.x, PLOT_WIDTH, PLOT_PADDING),
				cy: scaleCoordinate(-point.y, PLOT_HEIGHT, PLOT_PADDING),
				radius: Math.max(
					7,
					Math.min(
						20,
						6 +
							point.depth * 1.2 +
							point.segmentCount * 0.4 +
							(focusedCluster === point.cluster ? 1.5 : 0)
					)
				),
				color: clusterColor(point.cluster),
				active: point.rootUri === activeRoot,
				focused: focusedCluster === point.cluster,
				muted: focusedCluster !== null && focusedCluster !== point.cluster,
				representative,
				selectedRepresentative: representative && focusedCluster === point.cluster
			};
		});
	}

	function buildPlotBadges(): PlotClusterBadge[] {
		if (plotPoints.length === 0 || clusterClassifications.length === 0) return [];

		const grouped = new Map<number, PlotPoint[]>();
		for (const point of plotPoints) {
			const existing = grouped.get(point.cluster);
			if (existing) {
				existing.push(point);
			} else {
				grouped.set(point.cluster, [point]);
			}
		}

		return clusterClassifications
			.map((classification) => {
				const points = grouped.get(classification.cluster) ?? [];
				const averageX =
					points.reduce((sum, point) => sum + point.cx, 0) / Math.max(1, points.length);
				const averageY =
					points.reduce((sum, point) => sum + point.cy, 0) / Math.max(1, points.length);

				return {
					cluster: classification.cluster,
					label: classification.label,
					color: classification.color,
					x: Math.max(96, Math.min(PLOT_WIDTH - 96, averageX)),
					y: Math.max(PLOT_PADDING + 12, Math.min(PLOT_HEIGHT - PLOT_PADDING - 12, averageY - 26)),
					count: classification.count,
					active: activeClassification?.cluster === classification.cluster
				};
			})
			.sort((a, b) => b.count - a.count || a.cluster - b.cluster);
	}

	function buildNoveltyPlot() {
		if (activeMetricAnalysis.points.length === 0) {
			return { path: '', points: [] as NoveltyPlotPoint[], maxNovelty: 1 };
		}

		const maxNovelty = Math.max(1, activeMetricAnalysis.maxScore, activeMetricAnalysis.firstValue);
		const usableWidth = NOVELTY_WIDTH - NOVELTY_PADDING_X * 2;
		const usableHeight = NOVELTY_HEIGHT - NOVELTY_PADDING_Y * 2;
		const denominator = Math.max(1, activeMetricAnalysis.points.length - 1);
		const activeIndex = activeMetricPoint()?.index ?? null;

		const points = activeMetricAnalysis.points.map((point, index) => {
			const x = NOVELTY_PADDING_X + (index / denominator) * usableWidth;
			const y =
				NOVELTY_HEIGHT -
				NOVELTY_PADDING_Y -
				(Math.max(0, Math.min(maxNovelty, point.score)) / maxNovelty) * usableHeight;

			return {
				...point,
				x,
				y,
				active: point.index === activeIndex
			};
		});

		const path = points
			.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x} ${point.y}`)
			.join(' ');

		return { path, points, maxNovelty };
	}

	const selectedPoint = $derived(activePoint());
	const clusterClassifications = $derived(buildClusterClassifications());
	const activeClassification = $derived(buildActiveClassification());
	const activeClusterPoints = $derived(buildActiveClusterPoints());
	const activeClusterPostTotal = $derived(buildActiveClusterPostTotal());
	const plotPoints = $derived(buildPlotPoints());
	const plotBadges = $derived(buildPlotBadges());
	const orderedNoveltySegments = $derived(buildOrderedNoveltySegments());
	const noveltyAnalysis = $derived(buildDisplayedNovelty());
	const noveltyMetricAnalysis = $derived(buildNoveltyMetricAnalysis(noveltyAnalysis));
	const interestingnessAnalysis = $derived(buildInterestingnessAnalysis(orderedNoveltySegments));
	const distinctivenessAnalysis = $derived(buildDistinctivenessMetricAnalysis());
	const activeMetricAnalysis = $derived(buildActiveMetricAnalysis());
	const topMetricPoints = $derived(buildTopMetricPoints());
	const selectedMetricPoint = $derived(activeMetricPoint());
	const activeChunk = $derived(buildActiveChunk());
	const noveltyPlot = $derived(buildNoveltyPlot());
	const weirdnessPoints = $derived(buildWeirdnessPoints());
	const selectedWeirdnessPoint = $derived(buildSelectedWeirdnessPoint());
	const dualWeirdnessCount = $derived(
		weirdnessPoints.filter(
			(point) => point.personalPercentile >= 0.75 && (point.corpusPercentile ?? 0) >= 0.75
		).length
	);

	$effect(() => {
		const nextKey = `${profile.did}:${result.generatedAt}:${result.points.length}`;
		if (nextKey === analysisStateKey) return;
		analysisStateKey = nextKey;

		selectedCluster = result.points[0]?.cluster ?? null;
		selectedRootUri = result.points[0]?.rootUri ?? null;
		detailMode = 'class';
		selectedNoveltyIndex = null;
		selectedChunk = null;
		classLock = true;
		resetNoveltyControls(analysis.segments);
		classificationRequestId += 1;
		classificationLoading = false;
		classificationModel = '';
		classificationError = null;
		semanticOverrides = {};
		const requestId = classificationRequestId;
		void loadSemanticClassifications(result, requestId);
	});

	$effect(() => {
		if (metricTab !== previousMetricTab) {
			selectedNoveltyIndex = null;
			previousMetricTab = metricTab;
		}
	});

	$effect(() => {
		if (compareMode && (!previousCompareMode || noveltyOrderMode !== 'chronological')) {
			resetNoveltyControls(analysis.segments);
		}
		previousCompareMode = compareMode;
	});

	$effect(() => {
		if (!selectionRequest || selectionRequest.token === previousSelectionToken) {
			return;
		}

		previousSelectionToken = selectionRequest.token;

		const metricPoint = findMetricPointForSelection(selectionRequest);
		if (metricPoint) {
			selectMetricPoint(metricPoint);
			return;
		}

		focusThreadFromCompareOverlay(selectionRequest.rootUri);
	});
</script>

<section class="pane-shell" id={paneId || undefined}>
	<section class="pane-head wobbly-border-light">
		<div>
			{#if paneLabel}
				<span class="pane-eyebrow">{paneLabel}</span>
			{/if}
			<h2>{profile.displayName || profile.handle}</h2>
			<p class="pane-subtitle">
				@{profile.handle}
				<span>• Generated {formatRelativeTime(result.generatedAt)}</span>
			</p>
		</div>
		<div class="pane-meta">
			<span>{result.points.length} mapped threads</span>
			<span>{result.model}</span>
		</div>
	</section>

	{#if result.warning}
		<section class="warning-banner wobbly-border-light">
			<p>{result.warning}</p>
		</section>
	{/if}

	{#if weirdnessPoints.length > 0}
		<section class="weirdness-card wobbly-border">
			<div class="weirdness-head">
				<div>
					<h2>Weirdness Radar</h2>
					<p class="weirdness-subtitle">
						Personal weirdness measures how far a thread sits from @{profile.handle}&apos;s own
						thread center. Corpus weirdness currently reuses the cached global-centroid
						distinctiveness proxy.
					</p>
				</div>
				<div class="weirdness-stats">
					<div class="weirdness-stat">
						<span>Ranked</span>
						<strong>{weirdnessPoints.length}</strong>
						<small>threads in this run</small>
					</div>
					<div class="weirdness-stat">
						<span>Dual Outliers</span>
						<strong>{dualWeirdnessCount}</strong>
						<small>75th percentile on both axes</small>
					</div>
					<div class="weirdness-stat">
						<span>Top Combined</span>
						<strong>{formatPercentScore(weirdnessPoints[0]?.combinedWeirdness ?? 0)}</strong>
						<small>weighted weirdness score</small>
					</div>
				</div>
			</div>

			<div class="weirdness-copy">
				<p>
					Upper-right threads are the strongest candidates: off-brand for this author and odd
					relative to the saved analyzer corpus. The shortlist weights personal weirdness a bit
					more heavily than corpus weirdness.
				</p>
			</div>

			<div class="weirdness-grid">
				<div class="weirdness-map-panel wobbly-border-light">
					<svg
						class="weirdness-map"
						viewBox={`0 0 ${WEIRDNESS_WIDTH} ${WEIRDNESS_HEIGHT}`}
						role="img"
						aria-label="Personal versus corpus weirdness map"
					>
						<rect
							x="0"
							y="0"
							width={WEIRDNESS_WIDTH}
							height={WEIRDNESS_HEIGHT}
							rx="24"
							class="weirdness-bg"
						/>
						{#each [0.25, 0.5, 0.75] as tick}
							<line
								x1={WEIRDNESS_PADDING + tick * (WEIRDNESS_WIDTH - WEIRDNESS_PADDING * 2)}
								y1={WEIRDNESS_PADDING}
								x2={WEIRDNESS_PADDING + tick * (WEIRDNESS_WIDTH - WEIRDNESS_PADDING * 2)}
								y2={WEIRDNESS_HEIGHT - WEIRDNESS_PADDING}
								class="weirdness-grid-line"
							/>
							<line
								x1={WEIRDNESS_PADDING}
								y1={WEIRDNESS_HEIGHT - WEIRDNESS_PADDING - tick * (WEIRDNESS_HEIGHT - WEIRDNESS_PADDING * 2)}
								x2={WEIRDNESS_WIDTH - WEIRDNESS_PADDING}
								y2={WEIRDNESS_HEIGHT - WEIRDNESS_PADDING - tick * (WEIRDNESS_HEIGHT - WEIRDNESS_PADDING * 2)}
								class="weirdness-grid-line"
							/>
						{/each}
						<line
							x1={WEIRDNESS_PADDING}
							y1={WEIRDNESS_HEIGHT - WEIRDNESS_PADDING}
							x2={WEIRDNESS_WIDTH - WEIRDNESS_PADDING}
							y2={WEIRDNESS_HEIGHT - WEIRDNESS_PADDING}
							class="weirdness-axis"
						/>
						<line
							x1={WEIRDNESS_PADDING}
							y1={WEIRDNESS_PADDING}
							x2={WEIRDNESS_PADDING}
							y2={WEIRDNESS_HEIGHT - WEIRDNESS_PADDING}
							class="weirdness-axis"
						/>
						<text x={WEIRDNESS_PADDING + 14} y={WEIRDNESS_PADDING + 18} class="weirdness-quadrant-label">
							Corpus odd
						</text>
						<text
							x={WEIRDNESS_WIDTH - WEIRDNESS_PADDING - 150}
							y={WEIRDNESS_PADDING + 18}
							class="weirdness-quadrant-label"
						>
							True outlier
						</text>
						<text
							x={WEIRDNESS_PADDING + 14}
							y={WEIRDNESS_HEIGHT - WEIRDNESS_PADDING - 14}
							class="weirdness-quadrant-label"
						>
							Baseline
						</text>
						<text
							x={WEIRDNESS_WIDTH - WEIRDNESS_PADDING - 132}
							y={WEIRDNESS_HEIGHT - WEIRDNESS_PADDING - 14}
							class="weirdness-quadrant-label"
						>
							Off-brand
						</text>
						<text
							x={WEIRDNESS_WIDTH / 2}
							y={WEIRDNESS_HEIGHT - 16}
							text-anchor="middle"
							class="weirdness-axis-label"
						>
							More weird for this author →
						</text>
						<text x={WEIRDNESS_PADDING} y={24} class="weirdness-axis-label">
							More weird for the corpus ↑
						</text>

						{#each weirdnessPoints as point}
							<g
								class="weirdness-node"
								class:active={point.active}
								role="button"
								tabindex="0"
								aria-label={`Inspect weirdness rank ${point.rank}: ${point.title}`}
								onclick={() => selectWeirdnessPoint(point)}
								onkeydown={(event) => handleWeirdnessSelectionKeydown(event, point)}
							>
								{#if point.active}
									<circle
										cx={point.cx}
										cy={point.cy}
										r={Math.max(10, 7 + point.depth * 0.8)}
										class="weirdness-node-halo"
									/>
								{/if}
								<circle
									cx={point.cx}
									cy={point.cy}
									r={Math.max(5, Math.min(11, 5 + point.depth * 0.55))}
									class="weirdness-node-core"
								/>
								<title>{`#${point.rank} ${point.title}`}</title>
							</g>
						{/each}
					</svg>
					<div class="weirdness-map-footer">
						<span>Personal weirdness uses leave-one-out cosine distance from @{profile.handle}&apos;s own thread centroid.</span>
						<span>Corpus weirdness uses the current global distinctiveness proxy from cached analyzer batches.</span>
					</div>
				</div>

				<div class="weirdness-list wobbly-border-light">
					<div class="weirdness-list-head">
						<h3>Weirdest Threads</h3>
						<span>55% personal + 45% corpus</span>
					</div>
					<div class="weirdness-list-items">
						{#each weirdnessPoints as point}
							<button
								type="button"
								class="weirdness-list-item"
								class:active={selectedWeirdnessPoint?.rootUri === point.rootUri}
								onclick={() => selectWeirdnessPoint(point)}
							>
								<div class="weirdness-list-meta">
									<span class="weirdness-rank">#{point.rank}</span>
									<span class="weirdness-combined">
										Combined {formatPercentScore(point.combinedWeirdness)}
									</span>
								</div>
								<strong>{point.title}</strong>
								<p>{point.preview}</p>
								<div class="weirdness-chip-row">
									<span class="weirdness-chip">Personal {formatPercentScore(point.personalPercentile)}</span>
									<span class="weirdness-chip">Corpus {formatOptionalPercentScore(point.corpusPercentile)}</span>
									<span class="weirdness-chip">{weirdnessQuadrantLabel(point)}</span>
								</div>
							</button>
						{/each}
					</div>
				</div>
			</div>

			{#if selectedWeirdnessPoint}
				<article class="weirdness-detail wobbly-border-light">
					<div class="weirdness-detail-head">
						<span>Rank #{selectedWeirdnessPoint.rank}</span>
						{#if threadCreatedAt(selectedWeirdnessPoint)}
							<span>{formatDateLabel(threadCreatedAt(selectedWeirdnessPoint))}</span>
						{/if}
						<span>{weirdnessQuadrantLabel(selectedWeirdnessPoint)}</span>
					</div>
					<h3>{selectedWeirdnessPoint.title}</h3>
					<p>{selectedWeirdnessPoint.text}</p>
					<div class="weirdness-score-grid">
						<div class="weirdness-score-card">
							<span>Personal</span>
							<strong>{formatPercentScore(selectedWeirdnessPoint.personalPercentile)}</strong>
							<small>{formatRawScore(selectedWeirdnessPoint.personalWeirdness)} raw</small>
						</div>
						<div class="weirdness-score-card">
							<span>Corpus</span>
							<strong>{formatOptionalPercentScore(selectedWeirdnessPoint.corpusPercentile)}</strong>
							<small>{formatRawScore(selectedWeirdnessPoint.corpusWeirdness)} raw</small>
						</div>
						<div class="weirdness-score-card">
							<span>Combined</span>
							<strong>{formatPercentScore(selectedWeirdnessPoint.combinedWeirdness)}</strong>
							<small>55% personal / 45% corpus</small>
						</div>
					</div>
					<p class="weirdness-summary">{weirdnessSummary(selectedWeirdnessPoint)}</p>
					<div class="detail-links">
						<a href={buildThreadUrl(selectedWeirdnessPoint.rootUri)} target="_blank" rel="noreferrer">
							Open thread on Bluesky
						</a>
						<button
							type="button"
							class="mode-btn wobbly-border-light"
							onclick={() => selectWeirdnessPoint(selectedWeirdnessPoint)}
						>
							Open thread details
						</button>
					</div>
				</article>
			{/if}
		</section>
	{/if}

	{#if clusterClassifications.length > 0}
		<section class="classification-card wobbly-border">
			<div class="classification-head">
				<div>
					<h2>Cluster Classifications</h2>
					<p class="classification-subtitle">
						Cached Gemini Flash labels are reused when available. Otherwise, Gemini Flash labels
						clusters live, with keyword fallbacks if the request fails.
					</p>
				</div>
				<div class="classification-status">
					<span>{clusterClassifications.length} inferred classes</span>
					{#if classificationLoading}
						<span>Labeling with Gemini Flash…</span>
					{:else if classificationModel}
						<span>{classificationModel}</span>
					{:else if classificationError}
						<span>Fallback labels</span>
					{/if}
				</div>
			</div>

			{#if classificationError}
				<p class="classification-warning">{classificationError}</p>
			{/if}

			<div class="classification-grid">
				{#each clusterClassifications as classification}
					<button
						type="button"
						class="classification-item wobbly-border-light"
						class:active={activeClassification?.cluster === classification.cluster}
						onclick={() => focusClassification(classification)}
					>
						<div class="classification-topline">
							<span class="classification-badge" style={`--cluster-color: ${classification.color}`}>
								Semantic class
							</span>
							<span>{classification.count} threads</span>
						</div>
						<h3>{classification.label}</h3>
						<p class="classification-keywords">
							{#if classification.keywords.length > 0}
								{classification.keywords.join(' • ')}
							{:else}
								No stable keywords yet
							{/if}
						</p>
						{#if classification.summary}
							<p class="classification-summary">{classification.summary}</p>
						{/if}
						<div class="classification-meta">
							<span>{classification.source === 'flash' ? 'Flash label' : 'Keyword label'}</span>
							<span>Avg depth {classification.averageDepth.toFixed(1)}</span>
							<span>Avg chunks {classification.averageSegments.toFixed(1)}</span>
						</div>
					</button>
				{/each}
			</div>
		</section>
	{/if}

	{#if result.points.length === 0}
		<section class="empty-state wobbly-border">
			<p>
				{#if result.stats.skippedForCache > 0}
					No complete cached thread embeddings were available in this sample.
				{:else}
					No self-reply chains were found in this sample.
				{/if}
			</p>
		</section>
	{:else}
		<section class="analyzer-layout">
			<div class="map-card wobbly-border">
				<div class="map-topline">
					<span>{result.points.length} mapped threads</span>
					<span>
						{#if activeClassification}
							Focused class: {activeClassification.label}
						{:else}
							Nearby dots share similar wording and structure
						{/if}
					</span>
					<button
						type="button"
						class="lock-toggle wobbly-border-light"
						class:active={classLock}
						aria-pressed={classLock}
						onclick={toggleClassLock}
					>
						{classLock ? 'Class lock on' : 'Class lock off'}
					</button>
				</div>

				<svg
					class="cluster-map"
					viewBox={`0 0 ${PLOT_WIDTH} ${PLOT_HEIGHT}`}
					role="img"
					aria-label="Similarity map of self-reply threads"
				>
					<rect x="0" y="0" width={PLOT_WIDTH} height={PLOT_HEIGHT} rx="28" class="map-bg" />

					{#each [1, 2, 3] as ring}
						<circle
							cx={PLOT_WIDTH / 2}
							cy={PLOT_HEIGHT / 2}
							r={ring * 90}
							class="map-ring"
						/>
					{/each}

					<line
						x1={PLOT_WIDTH / 2}
						y1={PLOT_PADDING - 10}
						x2={PLOT_WIDTH / 2}
						y2={PLOT_HEIGHT - PLOT_PADDING + 10}
						class="axis"
					/>
					<line
						x1={PLOT_PADDING - 10}
						y1={PLOT_HEIGHT / 2}
						x2={PLOT_WIDTH - PLOT_PADDING + 10}
						y2={PLOT_HEIGHT / 2}
						class="axis"
					/>

					{#each plotPoints as point}
						<g
							role="button"
							tabindex="0"
							aria-label={`Open ${clusterLabel(point.cluster)}: ${point.title}`}
							onclick={() => focusThread(point.rootUri, { source: 'bubble' })}
							onkeydown={(event) => {
								if (event.key === 'Enter' || event.key === ' ') {
									event.preventDefault();
									focusThread(point.rootUri, { source: 'bubble' });
								}
							}}
						>
							{#if point.focused}
								<circle
									cx={point.cx}
									cy={point.cy}
									r={point.radius + (point.selectedRepresentative ? 14 : 8)}
									fill={point.color}
									opacity={point.selectedRepresentative ? 0.18 : 0.08}
								/>
							{/if}
							{#if point.representative}
								<circle
									cx={point.cx}
									cy={point.cy}
									r={point.radius + (point.selectedRepresentative ? 10 : 5)}
									fill="none"
									stroke={point.color}
									stroke-width={point.selectedRepresentative ? 3 : 2}
									stroke-dasharray={point.selectedRepresentative ? '4 4' : '2 5'}
									opacity={point.selectedRepresentative ? 0.95 : point.muted ? 0.18 : 0.6}
								/>
							{/if}
							{#if point.active}
								<circle
									cx={point.cx}
									cy={point.cy}
									r={point.radius + 8}
									fill="none"
									stroke={point.color}
									stroke-width="2.5"
									stroke-dasharray="5 6"
									opacity="0.65"
								/>
							{/if}
							<circle
								cx={point.cx}
								cy={point.cy}
								r={point.radius}
								fill={point.color}
								fill-opacity={point.muted ? 0.2 : point.active ? 0.96 : point.focused ? 0.88 : 0.72}
								stroke={point.active ? '#111' : point.focused ? point.color : '#fffef9'}
								stroke-width={point.active ? 3 : point.focused ? 2.5 : 1.5}
								class="data-point"
							>
								<title>{`${clusterLabel(point.cluster)}\n${point.title}`}</title>
							</circle>
							{#if point.representative}
								<circle
									cx={point.cx}
									cy={point.cy}
									r={point.selectedRepresentative ? 4.2 : 3}
									class="representative-core"
									opacity={point.muted ? 0.35 : 1}
								/>
							{/if}
						</g>
					{/each}

					{#each plotBadges as badge}
						<g
							role="button"
							tabindex="0"
							aria-label={`Focus semantic class ${badge.label}`}
							onclick={() => focusClassificationByCluster(badge.cluster)}
							onkeydown={(event) => {
								if (event.key === 'Enter' || event.key === ' ') {
									event.preventDefault();
									focusClassificationByCluster(badge.cluster);
								}
							}}
						>
							<rect
								x={badge.x - 58}
								y={badge.y - 13}
								width="116"
								height="26"
								rx="13"
								class="map-badge"
								class:active={badge.active}
								style={`--badge-color: ${badge.color}`}
							/>
							<text x={badge.x} y={badge.y + 4} text-anchor="middle" class="map-badge-text">
								{badge.label.slice(0, 16)}
							</text>
						</g>
					{/each}
				</svg>

				<div class="map-legend">
					{#each clusterClassifications as classification}
						<button
							type="button"
							class="legend-chip wobbly-border-light"
							class:active={activeClassification?.cluster === classification.cluster}
							style={`--cluster-color: ${classification.color}`}
							onclick={() => focusClassification(classification)}
						>
							<span class="legend-dot"></span>
							<span>{classification.label}</span>
							<span>{classification.count}</span>
						</button>
					{/each}
				</div>

				<div class="map-footer">
					<span>Point size tracks thread depth and paragraph count.</span>
					<span>Class focus stays sticky until you explicitly change it.</span>
				</div>
			</div>

			<div class="detail-stack">
				<section class="selection-bar wobbly-border-light">
					<div class="selection-path">
						<span><strong>Class:</strong> {activeClassification?.label ?? 'None'}</span>
						<span><strong>Thread:</strong> {selectedPoint ? selectedPoint.title : 'Overview'}</span>
						<span>
							<strong>Chunk:</strong>
							{#if activeChunk}
								Chunk {activeChunk.index}
							{:else}
								None
							{/if}
						</span>
					</div>
					<div class="selection-actions">
						<button
							type="button"
							class="mode-btn wobbly-border-light"
							onclick={stepBack}
							disabled={!canStepBack()}
						>
							Back
						</button>
						<button
							type="button"
							class="mode-btn wobbly-border-light"
							onclick={showClassOverview}
							disabled={detailMode === 'class'}
						>
							Class overview
						</button>
						<button type="button" class="mode-btn wobbly-border-light" onclick={resetInspector}>
							Reset
						</button>
					</div>
				</section>

				{#if detailMode === 'thread' && selectedPoint}
					<aside class="detail-card wobbly-border">
						<div class="detail-meta">
							<span>{clusterLabel(selectedPoint.cluster)}</span>
							<span>{selectedPoint.postCount} posts</span>
							<span>{selectedPoint.segmentCount} paragraph chunks</span>
						</div>

						<h2>{selectedPoint.title}</h2>
						<p class="detail-preview">
							{selectedPoint.text}
							{#if activeClassification?.representative.rootUri === selectedPoint.rootUri}
								<span> This is the representative thread for the selected class.</span>
							{/if}
						</p>

						<div class="detail-links">
							<a href={buildThreadUrl(selectedPoint.rootUri)} target="_blank" rel="noreferrer"
								>Open on Bluesky</a
							>
							<a href={`/chat?url=${encodeURIComponent(buildThreadUrl(selectedPoint.rootUri))}`}
								>Open in chat view</a
							>
						</div>

						<div class="segment-block">
							<div class="segment-head">
								<h4>Embedding Chunks</h4>
								<span>{selectedPoint.segments.length} individual embeddings</span>
							</div>
							<p class="segment-note">
								These are the exact paragraph chunks that were embedded. Each card below is one separate
								vector input.
							</p>
							<div class="segment-list">
								{#each selectedPoint.segments as segment}
									<button
										type="button"
										class="segment-card"
										class:active={activeChunk?.rootUri === selectedPoint.rootUri && activeChunk?.index === segment.index}
										onclick={() => selectSegment(selectedPoint.rootUri, segment.index)}
									>
										<div class="segment-meta">
											<span>Chunk {segment.index}</span>
											<span>{formatDateLabel(segment.createdAt)}</span>
										</div>
										<p>{segment.text}</p>
									</button>
								{/each}
							</div>
						</div>

						<div class="segment-head source-head">
							<h4>Source Posts</h4>
							<span>{selectedPoint.posts.length} posts in the thread</span>
						</div>

						<div class="post-list">
							{#each selectedPoint.posts as post, index}
								<article class="post-card wobbly-border-light">
									<div class="post-order">#{index + 1}</div>
									<p>{post.text}</p>
								</article>
							{/each}
						</div>
					</aside>
				{:else if activeClassification}
					<aside class="detail-card wobbly-border">
						<div class="detail-meta">
							<span>{activeClassification.label}</span>
							<span>{activeClusterPoints.length} threads</span>
							<span>{activeClusterPostTotal} posts</span>
						</div>

						<h2>Class Overview</h2>
						<p class="detail-preview">
							{#if activeClassification.summary}
								{activeClassification.summary}
							{:else}
								This semantic class groups together threads with similar wording and reply structure.
							{/if}
							{#if activeClassification.keywords.length > 0}
								<span> Keywords: {activeClassification.keywords.join(' • ')}.</span>
							{/if}
						</p>

						<div class="segment-block">
							<div class="segment-head">
								<h4>Representative Thread</h4>
								<span>
									{activeClassification.representative.postCount} posts •
									{activeClassification.representative.segmentCount} paragraph chunks • depth
									{activeClassification.representative.depth}
								</span>
							</div>
							<p class="detail-preview">{activeClassification.representative.preview}</p>
							<p class="segment-note">
								Select any bubble or metric point to inspect one thread in full detail.
							</p>
							<div class="thread-links">
								<a
									href={buildThreadUrl(activeClassification.representative.rootUri)}
									target="_blank"
									rel="noreferrer"
								>
									Open representative on Bluesky
								</a>
								<a
									href={`/chat?url=${encodeURIComponent(buildThreadUrl(activeClassification.representative.rootUri))}`}
								>
									Open representative in chat view
								</a>
								<button
									type="button"
									class="mode-btn wobbly-border-light"
									onclick={() => focusThread(activeClassification.representative.rootUri, { source: 'class' })}
								>
									Open representative thread
								</button>
							</div>
						</div>
					</aside>
				{/if}
			</div>
		</section>
	{/if}

	<section class="novelty-card wobbly-border">
		<div class="novelty-header">
			<div>
				<div class="novelty-title-row">
					<h2>Semantic Metrics</h2>
					<div class="novelty-metric-tabs">
						<button
							type="button"
							class="mode-btn wobbly-border-light"
							class:active={metricTab === 'novelty'}
							onclick={() => setMetricTab('novelty')}
						>
							Novelty
						</button>
						<button
							type="button"
							class="mode-btn wobbly-border-light"
							class:active={metricTab === 'interestingness'}
							onclick={() => setMetricTab('interestingness')}
						>
							Interestingness
						</button>
						<button
							type="button"
							class="mode-btn wobbly-border-light"
							class:active={metricTab === 'distinctiveness'}
							onclick={() => setMetricTab('distinctiveness')}
						>
							Distinctiveness
						</button>
					</div>
				</div>
				<p class="novelty-subtitle">
					{#if metricTab === 'novelty'}
						Measures how much each clustered paragraph chunk deviates from the semantic center of all
						earlier chunks.
					{:else if metricTab === 'interestingness'}
						Measures how much adding each chunk changes the semantic runway for the next chunk.
					{:else}
						Measures how far each analyzed thread embedding sits from the cached cross-account default
						centroid.
					{/if}
				</p>
			</div>
			<div class="novelty-stats">
				<div class="novelty-stat">
					<span>Analyzed</span>
					<strong>{activeMetricAnalysis.postsAnalyzed}</strong>
					<small>
						of {activeMetricAnalysis.postsConsidered}
						{activeMetricAnalysis.tab === 'distinctiveness' ? ' threads' : ' paragraph chunks'}
					</small>
				</div>
				<div class="novelty-stat">
					<span>Average</span>
					<strong>{activeMetricAnalysis.averageScore.toFixed(2)}</strong>
					<small>mean {activeMetricAnalysis.label.toLowerCase()}</small>
				</div>
				<div class="novelty-stat">
					<span>Peak</span>
					<strong>{activeMetricAnalysis.maxScore.toFixed(2)}</strong>
					<small>highest {activeMetricAnalysis.label.toLowerCase()}</small>
				</div>
				<div class="novelty-stat">
					<span>{activeMetricAnalysis.tab === 'distinctiveness' ? 'Lowest' : 'Latest'}</span>
					<strong>{activeMetricAnalysis.latestScore.toFixed(2)}</strong>
					<small>
						{activeMetricAnalysis.tab === 'distinctiveness'
							? 'lowest thread score in this run'
							: 'last chunk in the current run'}
					</small>
				</div>
			</div>
		</div>

		<div class="novelty-copy">
			{#if metricTab === 'novelty'}
				<p>
					Each paragraph chunk in the clustering sample is embedded once with the same
					{activeMetricAnalysis.model} backend, then L2-normalized. Novelty for chunk <em>n</em> is
					<code>1 - cos(e_n, c_1:n-1)</code>, where <code>c_1:n-1</code> is the running centroid of all
					earlier paragraph embeddings.
				</p>
				<p>
					The centroid updates after each step, so the baseline drifts with the selected thread
					sample&apos;s semantic center of gravity. The first analyzed chunk is assigned a novelty of
					<strong> {activeMetricAnalysis.firstValue.toFixed(1)} </strong> by convention.
					{#if !compareMode}
						<span> Use the buttons below to switch between chronological and randomized order.</span>
					{/if}
					{#if activeMetricAnalysis.skippedForCache > 0}
						<span> {activeMetricAnalysis.skippedForCache} chunks were skipped because an embedding was unavailable.</span>
					{/if}
				</p>
			{:else if metricTab === 'interestingness'}
				<p>
					Interestingness uses the same ordered paragraph embeddings, but scores how much each chunk
					changes the semantic runway for the next chunk. For chunk <em>n</em>, the raw delta is
					<code>cos(e_n+1, c_1:n) - cos(e_n+1, c_1:n-1)</code>.
				</p>
				<p>
					To make small movements readable, this tab normalizes each run by dividing all raw deltas by
					the run&apos;s max absolute raw delta, so displayed values stay near [-1, 1]. The first and
					last chunks are assigned <strong> {activeMetricAnalysis.firstValue.toFixed(1)} </strong> by
					convention because the comparison window is incomplete.
				</p>
			{:else if result.globalDistinctiveness.available}
				<p>
					Global distinctiveness compares each thread embedding against the cached corpus centroid built
					from saved analyzer batches. For thread <em>t</em>, the score is
					<code>1 - cos(e_t, c_global)</code>.
				</p>
				<p>
					Higher values mean the thread sits farther from the cross-account default center. The current
					centroid averages <strong> {result.globalDistinctiveness.corpusSize} </strong> cached paragraph
					chunks from prior analyzer runs, and the chart is ordered chronologically by each thread&apos;s
					root post timestamp.
				</p>
			{:else}
				<p>
					The global centroid has not been cached yet, so distinctiveness cannot be ranked until more
					analyzer batches have been saved in R2.
				</p>
				<p>
					Once the corpus baseline exists, this tab will score each analyzed thread against that
					cross-account default center.
				</p>
			{/if}
		</div>

		{#if metricTab !== 'distinctiveness' && noveltyBaseSegments.length > 0 && !compareMode}
			<div class="novelty-controls wobbly-border-light">
				<div class="novelty-control-row">
					<div class="novelty-order-buttons">
						<button
							type="button"
							class="mode-btn wobbly-border-light"
							class:active={noveltyOrderMode === 'chronological'}
							onclick={setChronologicalNoveltyOrder}
						>
							Chronological
						</button>
						<button
							type="button"
							class="mode-btn wobbly-border-light"
							class:active={noveltyOrderMode === 'random'}
							onclick={randomizeNoveltyOrder}
						>
							Randomize
						</button>
					</div>
				</div>
			</div>
		{/if}

		{#if noveltyPlot.points.length > 0}
			<svg
				class="novelty-chart"
				viewBox={`0 0 ${NOVELTY_WIDTH} ${NOVELTY_HEIGHT}`}
				role="img"
				aria-label={
					activeMetricAnalysis.tab === 'distinctiveness'
						? 'Distinctiveness across analyzed threads in timeline order'
						: `Running ${activeMetricAnalysis.label.toLowerCase()} across clustered paragraph chunks`
				}
			>
				<rect x="0" y="0" width={NOVELTY_WIDTH} height={NOVELTY_HEIGHT} rx="24" class="novelty-bg" />

				{#each [0.25, 0.5, 0.75, 1] as mark}
					<line
						x1={NOVELTY_PADDING_X}
						y1={NOVELTY_HEIGHT - NOVELTY_PADDING_Y - mark * (NOVELTY_HEIGHT - NOVELTY_PADDING_Y * 2)}
						x2={NOVELTY_WIDTH - NOVELTY_PADDING_X}
						y2={NOVELTY_HEIGHT - NOVELTY_PADDING_Y - mark * (NOVELTY_HEIGHT - NOVELTY_PADDING_Y * 2)}
						class="novelty-grid"
					/>
				{/each}

				<line
					x1={NOVELTY_PADDING_X}
					y1={NOVELTY_HEIGHT - NOVELTY_PADDING_Y}
					x2={NOVELTY_WIDTH - NOVELTY_PADDING_X}
					y2={NOVELTY_HEIGHT - NOVELTY_PADDING_Y}
					class="novelty-axis"
				/>

				{#if noveltyPlot.path}
					<path d={noveltyPlot.path} class="novelty-line" />
				{/if}

				{#each noveltyPlot.points as point}
					<g
						role="button"
						tabindex="0"
						aria-label={
							activeMetricAnalysis.tab === 'distinctiveness'
								? `Open distinctiveness timeline point ${point.index}: ${point.title}`
								: `Open ${activeMetricAnalysis.label.toLowerCase()} point ${point.index}: ${point.title}`
						}
						onclick={() => selectMetricPoint(point)}
						onkeydown={(event) => {
							if (event.key === 'Enter' || event.key === ' ') {
								event.preventDefault();
								selectMetricPoint(point);
							}
						}}
					>
						{#if point.active}
							<circle cx={point.x} cy={point.y} r="8" class="novelty-dot-halo" />
						{/if}
						<circle cx={point.x} cy={point.y} r={point.active ? 4.8 : 3.5} class="novelty-dot">
							<title>
								{`${
									activeMetricAnalysis.tab === 'distinctiveness' ? 'Thread' : 'Chunk'
								} ${point.index}: ${activeMetricAnalysis.label.toLowerCase()} ${point.score.toFixed(2)}\n${point.title}\n${point.text}`}
							</title>
						</circle>
					</g>
				{/each}
			</svg>

			<div class="novelty-footer">
				{#if activeMetricAnalysis.tab === 'distinctiveness'}
					<span>Chronological timeline order</span>
					<span>List sorted {metricListSortOrder === 'desc' ? 'descending' : 'ascending'}</span>
					<span>{result.globalDistinctiveness.comparedTo}</span>
					<span>
						{#if result.globalDistinctiveness.available}
							{result.globalDistinctiveness.corpusSize} cached chunks in the corpus centroid
						{:else}
							Waiting for a cached corpus baseline
						{/if}
					</span>
					<span>Higher = farther from the cross-account default centroid</span>
				{:else}
					<span>
						{#if noveltyOrderMode === 'chronological'}
							Chronological order
						{:else}
							Randomized order
						{/if}
					</span>
					<span>
						{#if metricTab === 'novelty'}
							First chunk pinned at {FIRST_NOVELTY_FALLBACK.toFixed(2)}
						{:else}
							Edge chunks pinned at {INTERESTINGNESS_EDGE_FALLBACK.toFixed(2)}
						{/if}
					</span>
					<span>Higher = more {activeMetricAnalysis.label.toLowerCase()} in the current run</span>
				{/if}
			</div>

			<div class="novelty-detail-grid">
				{#if selectedMetricPoint}
					<article class="novelty-detail wobbly-border-light">
						<div class="novelty-detail-meta">
							<span>
								{activeMetricAnalysis.tab === 'distinctiveness'
									? `Thread ${selectedMetricPoint.index}`
									: `Chunk ${selectedMetricPoint.index}`}
							</span>
							{#if selectedMetricPoint.createdAt}
								<span>{formatDateLabel(selectedMetricPoint.createdAt)}</span>
							{/if}
							<span>{activeMetricAnalysis.label} {selectedMetricPoint.score.toFixed(2)}</span>
						</div>
						<h3>{selectedMetricPoint.title}</h3>
						<p>{selectedMetricPoint.text}</p>
						<div class="detail-links">
							<a href={buildThreadUrl(selectedMetricPoint.rootUri)} target="_blank" rel="noreferrer"
								>Open thread on Bluesky</a
							>
							<button
								type="button"
								class="mode-btn wobbly-border-light"
								onclick={showSelectedMetricThread}
							>
								Open thread details
							</button>
						</div>
					</article>
				{/if}

				<div class="novelty-list wobbly-border-light">
					<div class="novelty-list-head">
						<h3>
							{activeMetricAnalysis.tab === 'interestingness'
								? metricListSortOrder === 'desc'
									? 'Most Interesting Paragraphs'
									: 'Least Interesting Paragraphs'
								: activeMetricAnalysis.tab === 'distinctiveness'
									? metricListSortOrder === 'desc'
										? 'Most Distinctive Threads (Current View)'
										: 'Least Distinctive Threads (Current View)'
									: metricListSortOrder === 'desc'
										? 'Most Novel Paragraphs'
										: 'Least Novel Paragraphs'}
						</h3>
						<div class="metric-sort">
							<button
								type="button"
								class="mode-btn wobbly-border-light"
								class:active={metricListSortOrder === 'desc'}
								onclick={() => setSharedMetricListSortOrder('desc')}
							>
								Descending
							</button>
							<button
								type="button"
								class="mode-btn wobbly-border-light"
								class:active={metricListSortOrder === 'asc'}
								onclick={() => setSharedMetricListSortOrder('asc')}
							>
								Ascending
							</button>
						</div>
						<span>Click to inspect</span>
					</div>
					<div class="novelty-list-items">
						{#each topMetricPoints as point}
							<button
								type="button"
								class="novelty-list-item"
								class:active={selectedMetricPoint?.index === point.index}
								onclick={() => selectMetricPoint(point)}
							>
								<span class="novelty-rank">#{point.index}</span>
								<span class="novelty-score">{point.score.toFixed(2)}</span>
								<span class="novelty-snippet">{point.text}</span>
							</button>
						{/each}
					</div>
				</div>
			</div>
		{:else}
			<div class="novelty-empty wobbly-border-light">
				{#if activeMetricAnalysis.tab === 'distinctiveness'}
					No cached global centroid is available yet for distinctiveness.
				{:else}
					No clustered paragraph embeddings were available for this metric.
				{/if}
			</div>
		{/if}
	</section>
</section>

<style>
	.pane-shell {
		display: grid;
		gap: 18px;
		align-content: start;
	}

	.pane-head {
		padding: 14px 16px;
		background: rgba(255, 254, 249, 0.9);
		display: flex;
		justify-content: space-between;
		gap: 12px;
		align-items: flex-start;
		flex-wrap: wrap;
	}

	.pane-eyebrow {
		display: inline-flex;
		font-size: 0.74rem;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: var(--muted);
		margin-bottom: 4px;
	}

	.pane-head h2 {
		font-size: 1.35rem;
		line-height: 1.15;
		margin: 0 0 4px;
	}

	.pane-subtitle,
	.pane-meta {
		font-size: 0.84rem;
		color: var(--muted);
	}

	.pane-subtitle {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}

	.pane-meta {
		display: grid;
		gap: 4px;
		text-align: right;
	}

	.mode-btn {
		padding: 8px 14px;
		background: rgba(255, 254, 249, 0.9);
		color: var(--text-ink);
		font-size: 0.92rem;
		border-color: rgba(61, 64, 91, 0.25);
	}

	.mode-btn.active {
		background: color-mix(in srgb, var(--accent) 12%, white);
		border-color: rgba(224, 122, 95, 0.42);
		box-shadow: 0 0 0 2px rgba(224, 122, 95, 0.1);
	}

	.warning-banner {
		padding: 12px 14px;
		background: #fff3cd;
		border-color: #d8a94d;
		color: #6c4b00;
	}

	.weirdness-card {
		padding: 18px;
		background:
			linear-gradient(180deg, rgba(224, 122, 95, 0.07), rgba(255, 254, 249, 0.96)),
			var(--card-bg);
	}

	.weirdness-head {
		display: flex;
		justify-content: space-between;
		gap: 18px;
		align-items: flex-start;
		flex-wrap: wrap;
		margin-bottom: 14px;
	}

	.weirdness-head h2 {
		font-size: 1.4rem;
		line-height: 1.15;
		margin-bottom: 4px;
	}

	.weirdness-subtitle {
		color: var(--muted);
		font-size: 0.92rem;
		max-width: 58ch;
	}

	.weirdness-stats {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 10px;
		flex: 1;
		min-width: min(100%, 360px);
	}

	.weirdness-stat {
		padding: 10px 12px;
		border: 1px solid rgba(61, 64, 91, 0.12);
		border-radius: 14px;
		background: rgba(255, 254, 249, 0.9);
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	.weirdness-stat span {
		font-size: 0.73rem;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: var(--muted);
	}

	.weirdness-stat strong {
		font-size: 1.3rem;
		line-height: 1;
	}

	.weirdness-stat small {
		font-size: 0.78rem;
		color: var(--muted);
	}

	.weirdness-copy {
		display: grid;
		gap: 8px;
		margin-bottom: 14px;
		color: var(--text-ink);
	}

	.weirdness-grid {
		display: grid;
		grid-template-columns: minmax(0, 1.2fr) minmax(320px, 0.8fr);
		gap: 14px;
		margin-bottom: 14px;
		align-items: start;
	}

	.weirdness-map-panel,
	.weirdness-list,
	.weirdness-detail {
		padding: 14px;
		background: rgba(255, 254, 249, 0.92);
	}

	.weirdness-map {
		width: 100%;
		height: auto;
		display: block;
	}

	.weirdness-bg {
		fill: rgba(255, 254, 249, 0.88);
		stroke: rgba(61, 64, 91, 0.12);
		stroke-width: 2;
	}

	.weirdness-grid-line {
		stroke: rgba(61, 64, 91, 0.08);
		stroke-width: 1;
		stroke-dasharray: 5 6;
	}

	.weirdness-axis {
		stroke: rgba(61, 64, 91, 0.18);
		stroke-width: 1.6;
	}

	.weirdness-axis-label,
	.weirdness-quadrant-label {
		font-size: 11px;
		fill: rgba(61, 64, 91, 0.75);
		font-weight: 700;
		pointer-events: none;
	}

	.weirdness-node {
		cursor: pointer;
		outline: none;
	}

	.weirdness-node-core {
		fill: #3d405b;
		stroke: rgba(255, 254, 249, 0.96);
		stroke-width: 1.6;
		transition:
			fill 0.15s ease,
			r 0.15s ease,
			stroke-width 0.15s ease;
	}

	.weirdness-node.active .weirdness-node-core {
		fill: #e07a5f;
		stroke-width: 2;
	}

	.weirdness-node-halo {
		fill: rgba(224, 122, 95, 0.16);
		stroke: rgba(224, 122, 95, 0.42);
		stroke-width: 1.5;
	}

	.weirdness-map-footer {
		margin-top: 10px;
		display: grid;
		gap: 4px;
		font-size: 0.82rem;
		color: var(--muted);
	}

	.weirdness-list-head,
	.weirdness-list-meta,
	.weirdness-detail-head {
		display: flex;
		justify-content: space-between;
		gap: 10px;
		flex-wrap: wrap;
		font-size: 0.82rem;
		color: var(--muted);
	}

	.weirdness-list-items {
		display: grid;
		gap: 8px;
		margin-top: 10px;
		max-height: 24rem;
		overflow-y: auto;
		padding-right: 4px;
		scrollbar-gutter: stable;
	}

	.weirdness-list-item {
		display: grid;
		gap: 8px;
		padding: 12px;
		border-radius: 12px;
		border: 1px solid rgba(61, 64, 91, 0.12);
		background:
			linear-gradient(180deg, rgba(224, 122, 95, 0.04), rgba(255, 254, 249, 0.9)),
			rgba(255, 254, 249, 0.9);
		text-align: left;
		color: var(--text-ink);
	}

	.weirdness-list-item.active {
		border-color: rgba(224, 122, 95, 0.5);
		box-shadow: 0 0 0 2px rgba(224, 122, 95, 0.12);
	}

	.weirdness-list-item strong {
		font-size: 1rem;
		line-height: 1.25;
	}

	.weirdness-list-item p {
		margin: 0;
		font-size: 0.88rem;
		line-height: 1.38;
		color: var(--muted);
	}

	.weirdness-rank,
	.weirdness-combined {
		font-weight: 700;
	}

	.weirdness-combined {
		color: #2f6f63;
	}

	.weirdness-chip-row {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}

	.weirdness-chip {
		display: inline-flex;
		align-items: center;
		padding: 4px 8px;
		border-radius: 999px;
		background: rgba(61, 64, 91, 0.06);
		font-size: 0.78rem;
		color: rgba(61, 64, 91, 0.88);
	}

	.weirdness-detail {
		display: grid;
		gap: 12px;
	}

	.weirdness-detail h3 {
		margin: 0;
		font-size: 1.08rem;
		line-height: 1.25;
	}

	.weirdness-detail p {
		margin: 0;
	}

	.weirdness-score-grid {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 10px;
	}

	.weirdness-score-card {
		padding: 10px 12px;
		border: 1px solid rgba(61, 64, 91, 0.12);
		border-radius: 14px;
		background: rgba(250, 248, 239, 0.86);
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	.weirdness-score-card span {
		font-size: 0.73rem;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: var(--muted);
	}

	.weirdness-score-card strong {
		font-size: 1.22rem;
		line-height: 1;
	}

	.weirdness-score-card small,
	.weirdness-summary {
		font-size: 0.84rem;
		color: var(--muted);
	}

	.classification-card {
		padding: 16px;
		background:
			linear-gradient(180deg, rgba(242, 204, 143, 0.08), rgba(255, 254, 249, 0.96)),
			var(--card-bg);
	}

	.classification-head {
		display: flex;
		justify-content: space-between;
		gap: 14px;
		flex-wrap: wrap;
		align-items: flex-start;
		margin-bottom: 14px;
	}

	.classification-status {
		display: grid;
		gap: 4px;
		font-size: 0.84rem;
		color: var(--muted);
		text-align: right;
	}

	.classification-head h2 {
		font-size: 1.25rem;
		line-height: 1.15;
		margin-bottom: 4px;
	}

	.classification-subtitle {
		color: var(--muted);
		font-size: 0.9rem;
		max-width: 58ch;
	}

	.classification-warning {
		margin-bottom: 12px;
		font-size: 0.88rem;
		color: #8a5a00;
	}

	.classification-grid {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 12px;
	}

	.classification-item {
		padding: 14px;
		background: rgba(255, 254, 249, 0.92);
		text-align: left;
		color: var(--text-ink);
	}

	.classification-item.active {
		border-color: rgba(61, 64, 91, 0.3);
		box-shadow: 0 0 0 2px rgba(61, 64, 91, 0.08);
		background: rgba(255, 250, 238, 0.98);
	}

	.classification-topline,
	.classification-meta {
		display: flex;
		justify-content: space-between;
		gap: 10px;
		flex-wrap: wrap;
		font-size: 0.82rem;
		color: var(--muted);
	}

	.classification-item h3 {
		font-size: 1.02rem;
		line-height: 1.2;
		margin: 10px 0 6px;
		text-transform: capitalize;
	}

	.classification-badge {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font-weight: 700;
		color: var(--cluster-color);
	}

	.classification-badge::before {
		content: '';
		width: 10px;
		height: 10px;
		border-radius: 999px;
		background: var(--cluster-color);
		box-shadow: 0 0 0 3px color-mix(in srgb, var(--cluster-color) 16%, white);
	}

	.classification-keywords {
		font-size: 0.9rem;
		color: var(--text-ink);
		min-height: 1.35em;
		margin-bottom: 8px;
	}

	.classification-summary {
		font-size: 0.88rem;
		color: var(--muted);
		min-height: 2.7em;
		margin-bottom: 10px;
	}

	.empty-state {
		padding: 28px;
		text-align: center;
		background: var(--card-bg);
	}

	.novelty-card {
		padding: 18px;
		background:
			linear-gradient(180deg, rgba(129, 178, 154, 0.08), rgba(255, 254, 249, 0.96)),
			var(--card-bg);
	}

	.novelty-header {
		display: flex;
		justify-content: space-between;
		gap: 18px;
		align-items: flex-start;
		flex-wrap: wrap;
		margin-bottom: 14px;
	}

	.novelty-header h2 {
		font-size: 1.4rem;
		line-height: 1.15;
		margin-bottom: 4px;
	}

	.novelty-title-row {
		display: flex;
		justify-content: space-between;
		gap: 12px;
		flex-wrap: wrap;
		align-items: center;
		margin-bottom: 4px;
	}

	.novelty-metric-tabs {
		display: flex;
		gap: 8px;
		flex-wrap: wrap;
	}

	.novelty-subtitle {
		color: var(--muted);
		font-size: 0.92rem;
		max-width: 56ch;
	}

	.novelty-stats {
		display: grid;
		grid-template-columns: repeat(4, minmax(0, 1fr));
		gap: 10px;
		flex: 1;
		min-width: min(100%, 420px);
	}

	.novelty-stat {
		padding: 10px 12px;
		border: 1px solid rgba(61, 64, 91, 0.12);
		border-radius: 14px;
		background: rgba(255, 254, 249, 0.9);
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	.novelty-stat span {
		font-size: 0.73rem;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: var(--muted);
	}

	.novelty-stat strong {
		font-size: 1.3rem;
		line-height: 1;
	}

	.novelty-stat small {
		font-size: 0.78rem;
		color: var(--muted);
	}

	.novelty-copy {
		display: grid;
		gap: 8px;
		margin-bottom: 14px;
		color: var(--text-ink);
	}

	.novelty-copy p {
		font-size: 0.95rem;
	}

	.novelty-copy code {
		font-size: 0.88em;
		background: rgba(61, 64, 91, 0.07);
		padding: 0.08em 0.34em;
		border-radius: 6px;
	}

	.novelty-controls {
		padding: 14px;
		margin-bottom: 14px;
		background: rgba(255, 254, 249, 0.92);
		display: grid;
		gap: 10px;
	}

	.novelty-control-row {
		display: flex;
		justify-content: space-between;
		gap: 12px;
		flex-wrap: wrap;
		align-items: center;
	}

	.novelty-order-buttons {
		display: flex;
		gap: 8px;
		flex-wrap: wrap;
	}

	.novelty-chart {
		width: 100%;
		height: auto;
		display: block;
	}

	.novelty-bg {
		fill: rgba(255, 254, 249, 0.88);
		stroke: rgba(61, 64, 91, 0.12);
		stroke-width: 2;
	}

	.novelty-grid {
		stroke: rgba(61, 64, 91, 0.09);
		stroke-width: 1;
		stroke-dasharray: 5 6;
	}

	.novelty-axis {
		stroke: rgba(61, 64, 91, 0.18);
		stroke-width: 1.6;
	}

	.novelty-line {
		fill: none;
		stroke: #2f6f63;
		stroke-width: 3;
		stroke-linecap: round;
		stroke-linejoin: round;
	}

	.novelty-dot {
		fill: #e07a5f;
		stroke: rgba(255, 254, 249, 0.95);
		stroke-width: 1.5;
		cursor: pointer;
	}

	.novelty-dot-halo {
		fill: rgba(224, 122, 95, 0.16);
		stroke: rgba(224, 122, 95, 0.42);
		stroke-width: 1.5;
	}

	.novelty-footer {
		margin-top: 10px;
		display: flex;
		justify-content: space-between;
		gap: 12px;
		flex-wrap: wrap;
		font-size: 0.84rem;
		color: var(--muted);
	}

	.novelty-detail-grid {
		margin-top: 14px;
		display: grid;
		grid-template-columns: minmax(0, 1.1fr) minmax(280px, 0.9fr);
		gap: 14px;
	}

	.novelty-detail,
	.novelty-list {
		padding: 14px;
		background: rgba(255, 254, 249, 0.92);
	}

	.novelty-detail h3,
	.novelty-list h3 {
		margin: 0 0 8px;
		font-size: 1.02rem;
		line-height: 1.25;
	}

	.novelty-detail p {
		margin-bottom: 12px;
	}

	.novelty-detail-meta,
	.novelty-list-head {
		display: flex;
		justify-content: space-between;
		gap: 10px;
		flex-wrap: wrap;
		font-size: 0.82rem;
		color: var(--muted);
	}

	.metric-sort {
		display: flex;
		gap: 8px;
		align-items: center;
	}

	.metric-sort .mode-btn {
		padding: 6px 10px;
		font-size: 0.82rem;
	}

	.novelty-list-items {
		display: grid;
		gap: 8px;
		margin-top: 10px;
		max-height: 24rem;
		overflow-y: auto;
		padding-right: 4px;
		scrollbar-gutter: stable;
	}

	.novelty-list-item {
		display: grid;
		grid-template-columns: auto auto minmax(0, 1fr);
		gap: 10px;
		align-items: start;
		padding: 10px 12px;
		border-radius: 12px;
		border: 1px solid rgba(61, 64, 91, 0.12);
		background: rgba(250, 248, 239, 0.86);
		text-align: left;
		color: var(--text-ink);
	}

	.novelty-list-item.active {
		border-color: rgba(224, 122, 95, 0.5);
		box-shadow: 0 0 0 2px rgba(224, 122, 95, 0.12);
	}

	.novelty-rank,
	.novelty-score {
		font-size: 0.82rem;
		font-weight: 700;
		color: var(--muted);
		white-space: nowrap;
	}

	.novelty-score {
		color: #2f6f63;
	}

	.novelty-snippet {
		font-size: 0.9rem;
		line-height: 1.35;
		line-clamp: 3;
		display: -webkit-box;
		-webkit-line-clamp: 3;
		-webkit-box-orient: vertical;
		overflow: hidden;
	}

	.novelty-empty {
		padding: 14px;
		text-align: center;
		background: rgba(255, 254, 249, 0.9);
		color: var(--muted);
	}

	.analyzer-layout {
		display: grid;
		grid-template-columns: minmax(0, 1.2fr) minmax(320px, 0.8fr);
		gap: 18px;
		align-items: start;
	}

	.detail-stack {
		display: grid;
		gap: 12px;
		align-items: start;
	}

	.map-card,
	.detail-card {
		background: var(--card-bg);
		padding: 16px;
	}

	.map-topline,
	.map-footer,
	.detail-meta,
	.detail-links {
		display: flex;
		justify-content: space-between;
		gap: 12px;
		flex-wrap: wrap;
		font-size: 0.9rem;
		color: var(--muted);
	}

	.map-topline {
		margin-bottom: 12px;
	}

	.lock-toggle {
		padding: 6px 10px;
		font-size: 0.8rem;
		background: rgba(255, 254, 249, 0.88);
		color: var(--text-ink);
	}

	.lock-toggle.active {
		border-color: rgba(61, 64, 91, 0.22);
		box-shadow: 0 0 0 2px rgba(61, 64, 91, 0.08);
		background: rgba(255, 250, 238, 0.96);
	}

	.map-footer {
		margin-top: 10px;
		font-size: 0.82rem;
	}

	.selection-bar {
		padding: 12px 14px;
		background: rgba(255, 254, 249, 0.92);
		display: grid;
		gap: 10px;
	}

	.selection-path,
	.selection-actions {
		display: flex;
		justify-content: space-between;
		gap: 10px;
		flex-wrap: wrap;
		align-items: center;
	}

	.selection-path {
		font-size: 0.84rem;
		color: var(--muted);
	}

	.selection-path strong {
		color: var(--text-ink);
	}

	.selection-actions {
		justify-content: flex-end;
	}

	.cluster-map {
		width: 100%;
		height: auto;
		display: block;
	}

	.map-legend {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		margin-top: 12px;
	}

	.legend-chip {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		padding: 7px 10px;
		background: rgba(255, 254, 249, 0.9);
		color: var(--text-ink);
		font-size: 0.84rem;
		border-color: rgba(61, 64, 91, 0.14);
	}

	.legend-chip.active {
		border-color: color-mix(in srgb, var(--cluster-color) 38%, rgba(61, 64, 91, 0.2));
		box-shadow: 0 0 0 2px color-mix(in srgb, var(--cluster-color) 14%, white);
		background: color-mix(in srgb, var(--cluster-color) 10%, white);
	}

	.legend-dot {
		width: 10px;
		height: 10px;
		border-radius: 999px;
		background: var(--cluster-color);
		flex: none;
	}

	.cluster-map .map-bg {
		fill: rgba(242, 198, 184, 0.18);
		stroke: rgba(61, 64, 91, 0.16);
		stroke-width: 2;
	}

	.map-ring {
		fill: none;
		stroke: rgba(61, 64, 91, 0.09);
		stroke-width: 1.5;
	}

	.axis {
		stroke: rgba(61, 64, 91, 0.16);
		stroke-width: 1.5;
		stroke-dasharray: 6 7;
	}

	.map-badge {
		fill: color-mix(in srgb, var(--badge-color) 10%, rgba(255, 254, 249, 0.95));
		fill-opacity: 0.3;
		stroke: color-mix(in srgb, var(--badge-color) 35%, rgba(61, 64, 91, 0.16));
		stroke-width: 1.6;
		cursor: pointer;
	}

	.map-badge.active {
		fill: color-mix(in srgb, var(--badge-color) 18%, rgba(255, 254, 249, 0.98));
		fill-opacity: 0.3;
		stroke-width: 2.4;
	}

	.map-badge-text {
		font-size: 11px;
		font-weight: 700;
		fill: rgba(17, 17, 17, 0.85);
		pointer-events: none;
	}

	.data-point {
		cursor: pointer;
		transition:
			transform 0.15s ease,
			opacity 0.15s ease,
			stroke-width 0.15s ease;
	}

	.representative-core {
		fill: #fffef9;
		stroke: rgba(17, 17, 17, 0.45);
		stroke-width: 1.2;
		pointer-events: none;
	}

	.detail-card h2 {
		font-size: 1.45rem;
		line-height: 1.2;
		margin: 10px 0 8px;
	}

	.detail-preview {
		color: var(--text-ink);
		margin-bottom: 12px;
	}

	.detail-links {
		padding-bottom: 12px;
		border-bottom: 1px solid rgba(61, 64, 91, 0.12);
		margin-bottom: 14px;
	}

	.segment-block {
		margin: 12px 0 14px;
		padding: 12px;
		border: 1px solid rgba(61, 64, 91, 0.1);
		border-radius: 14px;
		background: rgba(250, 248, 239, 0.68);
	}

	.segment-head {
		display: flex;
		justify-content: space-between;
		gap: 10px;
		flex-wrap: wrap;
		align-items: baseline;
		font-size: 0.82rem;
		color: var(--muted);
	}

	.segment-head h4 {
		margin: 0;
		font-size: 0.92rem;
		line-height: 1.2;
		color: var(--text-ink);
	}

	.segment-note {
		margin: 6px 0 10px;
		font-size: 0.84rem;
		color: var(--muted);
	}

	.segment-list {
		display: grid;
		gap: 8px;
	}

	.segment-card {
		width: 100%;
		text-align: left;
		color: var(--text-ink);
		padding: 10px 12px;
		border-radius: 12px;
		border: 1px solid rgba(224, 122, 95, 0.16);
		background:
			linear-gradient(180deg, rgba(224, 122, 95, 0.05), rgba(255, 254, 249, 0.92)),
			rgba(255, 254, 249, 0.92);
	}

	.segment-card.active {
		border-color: rgba(224, 122, 95, 0.5);
		box-shadow: 0 0 0 2px rgba(224, 122, 95, 0.1);
	}

	.segment-meta {
		display: flex;
		justify-content: space-between;
		gap: 10px;
		flex-wrap: wrap;
		margin-bottom: 6px;
		font-size: 0.78rem;
		color: #9a492f;
		font-weight: 700;
	}

	.segment-card p {
		margin: 0;
		font-size: 0.92rem;
		line-height: 1.45;
	}

	.source-head {
		margin-bottom: 10px;
	}

	.thread-links {
		display: flex;
		justify-content: flex-end;
		gap: 10px;
		flex-wrap: wrap;
		font-size: 0.84rem;
		color: var(--muted);
	}

	.post-list {
		display: grid;
		gap: 10px;
		max-height: 720px;
		overflow: auto;
		padding-right: 2px;
	}

	.post-card {
		padding: 12px 14px;
		background: rgba(250, 248, 239, 0.9);
	}

	.post-order {
		font-size: 0.8rem;
		color: var(--muted);
		margin-bottom: 4px;
	}

	@media (max-width: 980px) {
		.weirdness-stats,
		.classification-grid {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}

		.novelty-stats {
			grid-template-columns: repeat(2, minmax(0, 1fr));
			min-width: 100%;
		}

		.weirdness-grid,
		.novelty-detail-grid {
			grid-template-columns: 1fr;
		}

		.weirdness-score-grid {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}

		.analyzer-layout {
			grid-template-columns: 1fr;
		}
	}

	@media (max-width: 720px) {
		.pane-head {
			padding: 12px 14px;
		}

		.weirdness-stats,
		.classification-grid {
			grid-template-columns: 1fr;
		}

		.weirdness-score-grid,
		.novelty-stats {
			grid-template-columns: 1fr;
		}

		.weirdness-card,
		.map-card,
		.detail-card,
		.novelty-card {
			padding: 12px;
		}
	}
</style>
