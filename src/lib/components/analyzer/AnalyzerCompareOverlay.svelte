<script lang="ts">
	import { normalizeVector } from '$lib/utils/threadAnalysis';
	import type {
		AnalyzerCompareThreadSelection,
		AnalyzerLoadedAccount,
		BatchSegmentPayload,
		SequenceMetricTab
	} from './types';
	import type { ThreadAnalysisPoint } from '$lib/types';

	const MAP_WIDTH = 920;
	const MAP_HEIGHT = 520;
	const MAP_PADDING = 58;
	const METRIC_WIDTH = 1080;
	const METRIC_HEIGHT = 300;
	const METRIC_PADDING_X = 48;
	const METRIC_PADDING_Y = 30;
	const PRIMARY_COLOR = '#e07a5f';
	const SECONDARY_COLOR = '#3d405b';
	const EMBEDDING_MODEL_LABEL = '@cf/baai/bge-small-en-v1.5 (cls)';

	type SequenceMetricPoint = {
		index: number;
		uri: string;
		rootUri: string;
		createdAt: string;
		score: number;
		title: string;
		text: string;
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

	type CompareMapPoint = ThreadAnalysisPoint & {
		cx: number;
		cy: number;
		radius: number;
		handle: string;
		series: 'primary' | 'secondary';
		color: string;
	};

	type CompareMetricPoint = SequenceMetricPoint & {
		x: number;
		y: number;
		series: 'primary' | 'secondary';
		color: string;
		handle: string;
	};

	let {
		primary,
		secondary,
		metricTab = $bindable<SequenceMetricTab>('novelty'),
		onSelectThread = (_selection: AnalyzerCompareThreadSelection) => {}
	}: {
		primary: AnalyzerLoadedAccount;
		secondary: AnalyzerLoadedAccount;
		metricTab: SequenceMetricTab;
		onSelectThread?: (selection: AnalyzerCompareThreadSelection) => void;
	} = $props();

	function isActivationKey(event: KeyboardEvent): boolean {
		return event.key === 'Enter' || event.key === ' ';
	}

	function selectThread(selection: AnalyzerCompareThreadSelection) {
		onSelectThread(selection);
	}

	function handleSelectionKeydown(
		event: KeyboardEvent,
		selection: AnalyzerCompareThreadSelection
	) {
		if (!isActivationKey(event)) return;
		event.preventDefault();
		selectThread(selection);
	}

	function scaleCoordinate(value: number, max: number, padding: number): number {
		const clamped = Math.max(-1, Math.min(1, value));
		const usable = max - padding * 2;
		return padding + ((clamped + 1) / 2) * usable;
	}

	function dotProduct(a: number[], b: number[]): number {
		let total = 0;
		const length = Math.min(a.length, b.length);
		for (let i = 0; i < length; i++) {
			total += a[i] * b[i];
		}
		return total;
	}

	function sortSegmentsChronologically(segments: BatchSegmentPayload[]): BatchSegmentPayload[] {
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

	function buildNoveltyMetricAnalysis(
		account: AnalyzerLoadedAccount
	): SequenceMetricAnalysis {
		const novelty = account.result.novelty;
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

	function buildInterestingnessAnalysis(
		account: AnalyzerLoadedAccount
	): SequenceMetricAnalysis {
		const segments = sortSegmentsChronologically(account.segments);
		if (segments.length === 0) {
			return {
				tab: 'interestingness',
				label: 'Interestingness',
				model: EMBEDDING_MODEL_LABEL,
				firstValue: 0,
				postsConsidered: 0,
				postsAnalyzed: 0,
				skippedForCache: 0,
				averageScore: 0,
				maxScore: 0,
				latestScore: 0,
				points: []
			};
		}

		const rawPoints: SequenceMetricPoint[] = [];
		let centroid: number[] | null = null;

		for (let index = 0; index < segments.length; index++) {
			const segment = segments[index];
			const currentEmbedding = normalizeVector(segment.embedding);
			const nextSegment = segments[index + 1];
			let rawScore = 0;
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
		const latestScore = points[points.length - 1]?.score ?? 0;

		return {
			tab: 'interestingness',
			label: 'Interestingness',
			model: EMBEDDING_MODEL_LABEL,
			firstValue: 0,
			postsConsidered: segments.length,
			postsAnalyzed: segments.length,
			skippedForCache: 0,
			averageScore: segments.length > 0 ? total / segments.length : 0,
			maxScore,
			latestScore,
			points
		};
	}

	function buildDistinctivenessAnalysis(
		account: AnalyzerLoadedAccount
	): SequenceMetricAnalysis {
		const result = account.result;
		if (!result.globalDistinctiveness?.available) {
			return {
				tab: 'distinctiveness',
				label: 'Distinctiveness',
				model: result.globalDistinctiveness.model,
				firstValue: 0,
				postsConsidered: result.globalDistinctiveness.threadsCompared,
				postsAnalyzed: 0,
				skippedForCache: 0,
				averageScore: 0,
				maxScore: 0,
				latestScore: 0,
				points: []
			};
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

	function buildMetricAnalysis(account: AnalyzerLoadedAccount): SequenceMetricAnalysis {
		if (metricTab === 'interestingness') return buildInterestingnessAnalysis(account);
		if (metricTab === 'distinctiveness') return buildDistinctivenessAnalysis(account);
		return buildNoveltyMetricAnalysis(account);
	}

	function buildCompareMapPoints(
		account: AnalyzerLoadedAccount,
		series: 'primary' | 'secondary'
	): CompareMapPoint[] {
		const color = series === 'primary' ? PRIMARY_COLOR : SECONDARY_COLOR;
		return account.result.points.map((point) => ({
			...point,
			cx: scaleCoordinate(point.x, MAP_WIDTH, MAP_PADDING),
			cy: scaleCoordinate(-point.y, MAP_HEIGHT, MAP_PADDING),
			radius: Math.max(6, Math.min(16, 5 + point.depth * 1.1 + point.segmentCount * 0.3)),
			handle: account.profile.handle,
			series,
			color
		}));
	}

	function buildCompareMetricSeries(
		account: AnalyzerLoadedAccount,
		analysis: SequenceMetricAnalysis,
		series: 'primary' | 'secondary',
		maxScore: number
	): CompareMetricPoint[] {
		const color = series === 'primary' ? PRIMARY_COLOR : SECONDARY_COLOR;
		const usableWidth = METRIC_WIDTH - METRIC_PADDING_X * 2;
		const usableHeight = METRIC_HEIGHT - METRIC_PADDING_Y * 2;
		const denominator = Math.max(1, analysis.points.length - 1);
		const yMax = Math.max(1, maxScore, analysis.firstValue);

		return analysis.points.map((point, index) => {
			const x = METRIC_PADDING_X + (index / denominator) * usableWidth;
			const y =
				METRIC_HEIGHT -
				METRIC_PADDING_Y -
				(Math.max(0, Math.min(yMax, point.score)) / yMax) * usableHeight;

			return {
				...point,
				x,
				y,
				series,
				color,
				handle: account.profile.handle
			};
		});
	}

	function buildMetricPath(points: CompareMetricPoint[]): string {
		return points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x} ${point.y}`).join(' ');
	}

	function formatMetricLabel(tab: SequenceMetricTab): string {
		if (tab === 'interestingness') return 'Interestingness';
		if (tab === 'distinctiveness') return 'Distinctiveness';
		return 'Novelty';
	}

	function setMetricTab(next: SequenceMetricTab) {
		if (metricTab === next) return;
		metricTab = next;
	}

	function selectMapPoint(point: CompareMapPoint) {
		selectThread({
			series: point.series,
			rootUri: point.rootUri
		});
	}

	function selectMetricPoint(point: CompareMetricPoint) {
		selectThread({
			series: point.series,
			rootUri: point.rootUri,
			metricPoint: {
				index: point.index,
				createdAt: point.createdAt,
				text: point.text
			}
		});
	}

	const primaryMapPoints = $derived(buildCompareMapPoints(primary, 'primary'));
	const secondaryMapPoints = $derived(buildCompareMapPoints(secondary, 'secondary'));
	const primaryMetric = $derived(buildMetricAnalysis(primary));
	const secondaryMetric = $derived(buildMetricAnalysis(secondary));
	const metricMax = $derived(
		Math.max(primaryMetric.maxScore, secondaryMetric.maxScore, primaryMetric.firstValue, secondaryMetric.firstValue, 1)
	);
	const primaryMetricPoints = $derived(
		buildCompareMetricSeries(primary, primaryMetric, 'primary', metricMax)
	);
	const secondaryMetricPoints = $derived(
		buildCompareMetricSeries(secondary, secondaryMetric, 'secondary', metricMax)
	);
	const primaryMetricPath = $derived(buildMetricPath(primaryMetricPoints));
	const secondaryMetricPath = $derived(buildMetricPath(secondaryMetricPoints));
</script>

<section class="compare-overlay-stack">
	<section class="overlay-card compare-map-card wobbly-border">
		<div class="overlay-head">
			<div>
				<h2>Overlap Map</h2>
				<p class="overlay-subtitle">
					Both accounts share the same projection space here so you can see how their clusters sit on top
					of each other.
				</p>
			</div>
			<div class="overlay-legend">
				<span class="overlay-legend-item">
					<span class="overlay-marker overlay-marker-primary"></span>
					@{primary.profile.handle}
				</span>
				<span class="overlay-legend-item">
					<span class="overlay-marker overlay-marker-secondary"></span>
					@{secondary.profile.handle}
				</span>
			</div>
		</div>

		<svg
			class="overlay-map"
			viewBox={`0 0 ${MAP_WIDTH} ${MAP_HEIGHT}`}
			role="img"
			aria-label="Overlapped compare map of both analyzed accounts"
		>
			<rect x="0" y="0" width={MAP_WIDTH} height={MAP_HEIGHT} rx="28" class="map-bg" />

			{#each [1, 2, 3] as ring}
				<circle cx={MAP_WIDTH / 2} cy={MAP_HEIGHT / 2} r={ring * 90} class="map-ring" />
			{/each}

			<line
				x1={MAP_WIDTH / 2}
				y1={MAP_PADDING - 10}
				x2={MAP_WIDTH / 2}
				y2={MAP_HEIGHT - MAP_PADDING + 10}
				class="axis"
			/>
			<line
				x1={MAP_PADDING - 10}
				y1={MAP_HEIGHT / 2}
				x2={MAP_WIDTH - MAP_PADDING + 10}
				y2={MAP_HEIGHT / 2}
				class="axis"
			/>

			{#each primaryMapPoints as point}
				<g
					class="overlay-point-button"
					role="button"
					tabindex="0"
					aria-label={`Focus ${point.title} from @${point.handle}`}
					onclick={() => selectMapPoint(point)}
					onkeydown={(event) =>
						handleSelectionKeydown(event, {
							series: point.series,
							rootUri: point.rootUri
						})}
				>
					<circle
						cx={point.cx}
						cy={point.cy}
						r={point.radius}
						fill={point.color}
						fill-opacity="0.52"
						stroke="rgba(255, 254, 249, 0.92)"
						stroke-width="1.5"
					/>
					<title>{`@${point.handle}\n${point.title}`}</title>
				</g>
			{/each}

			{#each secondaryMapPoints as point}
				<g
					class="overlay-point-button"
					role="button"
					tabindex="0"
					aria-label={`Focus ${point.title} from @${point.handle}`}
					onclick={() => selectMapPoint(point)}
					onkeydown={(event) =>
						handleSelectionKeydown(event, {
							series: point.series,
							rootUri: point.rootUri
						})}
				>
					<rect
						x={point.cx - point.radius}
						y={point.cy - point.radius}
						width={point.radius * 2}
						height={point.radius * 2}
						rx="3"
						fill={point.color}
						fill-opacity="0.2"
						stroke={point.color}
						stroke-width="2"
						transform={`rotate(45 ${point.cx} ${point.cy})`}
					/>
					<title>{`@${point.handle}\n${point.title}`}</title>
				</g>
			{/each}
		</svg>

		<div class="overlay-footer">
			<span>{primary.result.points.length} threads from @{primary.profile.handle}</span>
			<span>{secondary.result.points.length} threads from @{secondary.profile.handle}</span>
			<span>Filled circles = primary, outlined diamonds = comparison</span>
		</div>
	</section>

	<section class="overlay-card compare-metric-card wobbly-border">
		<div class="overlay-head">
			<div>
				<div class="overlay-title-row">
					<h2>Overlap Metrics</h2>
					<div class="metric-tabs">
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
				<p class="overlay-subtitle">
					Both accounts render on the same y-scale for {formatMetricLabel(metricTab).toLowerCase()} so you
					can compare shape and peaks directly.
				</p>
			</div>
		</div>

		<div class="metric-summary-grid">
			<div class="metric-summary-side">
				<span class="summary-handle">@{primary.profile.handle}</span>
				<strong>{primaryMetric.averageScore.toFixed(2)}</strong>
				<small>average {primaryMetric.label.toLowerCase()}</small>
				<span>Peak {primaryMetric.maxScore.toFixed(2)}</span>
			</div>
			<div class="metric-summary-side secondary">
				<span class="summary-handle">@{secondary.profile.handle}</span>
				<strong>{secondaryMetric.averageScore.toFixed(2)}</strong>
				<small>average {secondaryMetric.label.toLowerCase()}</small>
				<span>Peak {secondaryMetric.maxScore.toFixed(2)}</span>
			</div>
		</div>

		{#if primaryMetricPoints.length > 0 || secondaryMetricPoints.length > 0}
			<svg
				class="overlay-metric-chart"
				viewBox={`0 0 ${METRIC_WIDTH} ${METRIC_HEIGHT}`}
				role="img"
				aria-label="Overlapped compare metric chart"
			>
				<rect x="0" y="0" width={METRIC_WIDTH} height={METRIC_HEIGHT} rx="24" class="metric-bg" />

				{#each [0.25, 0.5, 0.75, 1] as mark}
					<line
						x1={METRIC_PADDING_X}
						y1={METRIC_HEIGHT - METRIC_PADDING_Y - mark * (METRIC_HEIGHT - METRIC_PADDING_Y * 2)}
						x2={METRIC_WIDTH - METRIC_PADDING_X}
						y2={METRIC_HEIGHT - METRIC_PADDING_Y - mark * (METRIC_HEIGHT - METRIC_PADDING_Y * 2)}
						class="metric-grid"
					/>
				{/each}

				<line
					x1={METRIC_PADDING_X}
					y1={METRIC_HEIGHT - METRIC_PADDING_Y}
					x2={METRIC_WIDTH - METRIC_PADDING_X}
					y2={METRIC_HEIGHT - METRIC_PADDING_Y}
					class="metric-axis"
				/>

				{#if primaryMetricPath}
					<path d={primaryMetricPath} class="metric-line primary-line" />
				{/if}
				{#if secondaryMetricPath}
					<path d={secondaryMetricPath} class="metric-line secondary-line" />
				{/if}

				{#each primaryMetricPoints as point}
					<g
						class="overlay-point-button"
						role="button"
						tabindex="0"
						aria-label={`Focus ${point.title} from @${point.handle}`}
						onclick={() => selectMetricPoint(point)}
						onkeydown={(event) =>
							handleSelectionKeydown(event, {
								series: point.series,
								rootUri: point.rootUri,
								metricPoint: {
									index: point.index,
									createdAt: point.createdAt,
									text: point.text
								}
							})}
					>
						<circle cx={point.x} cy={point.y} r="3.5" fill={point.color} />
						<title>{`@${point.handle}\n${point.title}\n${point.score.toFixed(2)}`}</title>
					</g>
				{/each}

				{#each secondaryMetricPoints as point}
					<g
						class="overlay-point-button"
						role="button"
						tabindex="0"
						aria-label={`Focus ${point.title} from @${point.handle}`}
						onclick={() => selectMetricPoint(point)}
						onkeydown={(event) =>
							handleSelectionKeydown(event, {
								series: point.series,
								rootUri: point.rootUri,
								metricPoint: {
									index: point.index,
									createdAt: point.createdAt,
									text: point.text
								}
							})}
					>
						<rect
							x={point.x - 3.5}
							y={point.y - 3.5}
							width="7"
							height="7"
							fill={point.color}
							transform={`rotate(45 ${point.x} ${point.y})`}
						/>
						<title>{`@${point.handle}\n${point.title}\n${point.score.toFixed(2)}`}</title>
					</g>
				{/each}
			</svg>

			<div class="overlay-footer">
				<span>@{primary.profile.handle}: {primaryMetric.postsAnalyzed} analyzed points</span>
				<span>@{secondary.profile.handle}: {secondaryMetric.postsAnalyzed} analyzed points</span>
				<span>Both lines use the same vertical scale</span>
			</div>
		{:else}
			<div class="metric-empty wobbly-border-light">
				No overlapping metric data is available for the current tab yet.
			</div>
		{/if}
	</section>
</section>

<style>
	.compare-overlay-stack {
		display: grid;
		gap: 18px;
		margin-bottom: 18px;
	}

	.overlay-card {
		padding: 18px;
		background: var(--card-bg);
	}

	.overlay-point-button {
		cursor: pointer;
		outline: none;
	}

	.overlay-point-button:focus-visible circle,
	.overlay-point-button:focus-visible rect {
		stroke: #f2cc8f;
		stroke-width: 3;
	}

	.compare-map-card {
		background:
			linear-gradient(180deg, rgba(242, 198, 184, 0.08), rgba(255, 254, 249, 0.96)),
			var(--card-bg);
	}

	.compare-metric-card {
		background:
			linear-gradient(180deg, rgba(129, 178, 154, 0.08), rgba(255, 254, 249, 0.96)),
			var(--card-bg);
	}

	.overlay-head {
		display: flex;
		justify-content: space-between;
		gap: 16px;
		flex-wrap: wrap;
		align-items: flex-start;
		margin-bottom: 12px;
	}

	.overlay-head h2 {
		font-size: 1.35rem;
		line-height: 1.15;
		margin-bottom: 4px;
	}

	.overlay-title-row {
		display: flex;
		justify-content: space-between;
		gap: 12px;
		flex-wrap: wrap;
		align-items: center;
		margin-bottom: 4px;
	}

	.overlay-subtitle {
		font-size: 0.92rem;
		color: var(--muted);
		max-width: 58ch;
	}

	.overlay-legend {
		display: flex;
		gap: 12px;
		flex-wrap: wrap;
		align-items: center;
	}

	.overlay-legend-item {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		font-size: 0.84rem;
		color: var(--muted);
	}

	.overlay-marker {
		display: inline-flex;
		width: 12px;
		height: 12px;
	}

	.overlay-marker-primary {
		border-radius: 999px;
		background: rgba(224, 122, 95, 0.85);
	}

	.overlay-marker-secondary {
		background: rgba(61, 64, 91, 0.2);
		border: 2px solid #3d405b;
		transform: rotate(45deg);
	}

	.overlay-map,
	.overlay-metric-chart {
		width: 100%;
		height: auto;
		display: block;
	}

	.map-bg,
	.metric-bg {
		fill: rgba(255, 254, 249, 0.88);
		stroke: rgba(61, 64, 91, 0.12);
		stroke-width: 2;
	}

	.map-ring,
	.metric-grid {
		fill: none;
		stroke: rgba(61, 64, 91, 0.09);
		stroke-width: 1.5;
		stroke-dasharray: 5 6;
	}

	.axis,
	.metric-axis {
		stroke: rgba(61, 64, 91, 0.16);
		stroke-width: 1.5;
		stroke-dasharray: 6 7;
	}

	.metric-tabs {
		display: flex;
		gap: 8px;
		flex-wrap: wrap;
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

	.metric-summary-grid {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 12px;
		margin-bottom: 14px;
	}

	.metric-summary-side {
		padding: 12px 14px;
		border-radius: 14px;
		background: rgba(255, 248, 244, 0.9);
		border: 1px solid rgba(224, 122, 95, 0.18);
		display: grid;
		gap: 4px;
	}

	.metric-summary-side.secondary {
		background: rgba(245, 246, 252, 0.9);
		border-color: rgba(61, 64, 91, 0.18);
	}

	.metric-summary-side strong {
		font-size: 1.6rem;
		line-height: 1;
	}

	.metric-summary-side small,
	.metric-summary-side span {
		color: var(--muted);
		font-size: 0.84rem;
	}

	.summary-handle {
		text-transform: uppercase;
		letter-spacing: 0.08em;
	}

	.metric-line {
		fill: none;
		stroke-width: 3;
		stroke-linecap: round;
		stroke-linejoin: round;
	}

	.primary-line {
		stroke: #e07a5f;
	}

	.secondary-line {
		stroke: #3d405b;
		stroke-dasharray: 7 6;
	}

	.overlay-footer {
		margin-top: 12px;
		display: flex;
		justify-content: space-between;
		gap: 12px;
		flex-wrap: wrap;
		font-size: 0.84rem;
		color: var(--muted);
	}

	.metric-empty {
		padding: 14px;
		text-align: center;
		background: rgba(255, 254, 249, 0.92);
		color: var(--muted);
	}

	@media (max-width: 860px) {
		.metric-summary-grid {
			grid-template-columns: 1fr;
		}
	}

	@media (max-width: 720px) {
		.overlay-card {
			padding: 12px;
		}
	}
</style>
