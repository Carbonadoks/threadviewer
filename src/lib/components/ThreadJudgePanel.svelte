<script lang="ts">
	import { onMount } from 'svelte';
	import type { SelfReplyThread, ThreadJudgePayload, ThreadJudgePost, ThreadJudgment } from '$lib/types';
	import { serializeThreadForJudging } from '$lib/utils/threadJudge';
	import {
		DEFAULT_THREAD_JUDGE_MODEL,
		THREAD_JUDGE_MODEL_OPTIONS,
		normalizeThreadJudgeModel,
		threadJudgeModelLabel
	} from '$lib/utils/judgeModels';
	import { buildBskyPostUrl } from '$lib/utils/viewerLinks';

	type MetricKey = 'positivity' | 'excitingness' | 'intensity' | 'curiosity' | 'confidence';
	type JudgeSortMode = 'sequence' | 'sentiment' | MetricKey;
	type JudgeRow = {
		post: ThreadJudgePost;
		judgment: ThreadJudgment | null;
		previousPost: ThreadJudgePost | null;
		previousJudgment: ThreadJudgment | null;
	};

	interface Props {
		thread: SelfReplyThread;
		autoloadCache?: boolean;
		initialModel?: string;
		onmodelchange?: ((model: string) => void) | undefined;
	}

	const {
		thread,
		autoloadCache = false,
		initialModel = DEFAULT_THREAD_JUDGE_MODEL,
		onmodelchange
	}: Props = $props();

	const metricDefinitions: Array<{ key: MetricKey; label: string; explainer: string }> = [
		{
			key: 'positivity',
			label: 'Positivity',
			explainer: 'How upbeat, warm, or favorable the post feels.'
		},
		{
			key: 'excitingness',
			label: 'Excitingness',
			explainer: 'How energizing, hype, or stimulating the post feels.'
		},
		{
			key: 'intensity',
			label: 'Intensity',
			explainer: 'How forceful, emotionally strong, or emphatic the post sounds.'
		},
		{
			key: 'curiosity',
			label: 'Curiosity',
			explainer: 'How much the post invites questions, wonder, or exploration.'
		},
		{
			key: 'confidence',
			label: 'Confidence',
			explainer: 'How certain, assertive, or self-assured the post sounds.'
		}
	];
	const sentimentOrder: Record<ThreadJudgment['sentiment'], number> = {
		very_negative: 0,
		negative: 1,
		mixed: 2,
		neutral: 3,
		positive: 4,
		very_positive: 5
	};

	let judging = $state(false);
	let judgeError: string | null = $state(null);
	let judgeResult = $state<ThreadJudgePayload | null>(null);
	let judgeRequestId = 0;
	let judgeSortMode = $state<JudgeSortMode>('sequence');
	let judgeSortOrder = $state<'asc' | 'desc'>('asc');
	let selectedJudgeModel = $state(DEFAULT_THREAD_JUDGE_MODEL);
	let hasSynchronizedInitialModel = $state(false);
	let lastReportedModel = $state<string | null>(null);

	const posts = $derived(serializeThreadForJudging(thread));

	function openingJudgment(): ThreadJudgment | null {
		return judgeResult?.judgments?.['1'] ?? null;
	}

	function buildRows(): JudgeRow[] {
		const rows = posts.map((post, index) => ({
			post,
			judgment: judgeResult?.judgments?.[String(post.index)] ?? null,
			previousPost: index > 0 ? posts[index - 1] : null,
			previousJudgment:
				index > 0 ? (judgeResult?.judgments?.[String(posts[index - 1].index)] ?? null) : null
		}));

		if (judgeSortMode === 'sequence') {
			return rows.sort((left, right) =>
				judgeSortOrder === 'asc'
					? left.post.index - right.post.index
					: right.post.index - left.post.index
			);
		}

		if (judgeSortMode === 'sentiment') {
			return rows.sort((left, right) => {
				const leftRank = left.judgment ? sentimentOrder[left.judgment.sentiment] : Number.MAX_SAFE_INTEGER;
				const rightRank = right.judgment ? sentimentOrder[right.judgment.sentiment] : Number.MAX_SAFE_INTEGER;

				if (leftRank !== rightRank) {
					return judgeSortOrder === 'asc' ? leftRank - rightRank : rightRank - leftRank;
				}

				return left.post.index - right.post.index;
			});
		}

		const sortMetric: MetricKey = judgeSortMode;
		return rows.sort((left, right) => {
			const leftValue = left.judgment?.[sortMetric] ?? null;
			const rightValue = right.judgment?.[sortMetric] ?? null;

			if (leftValue === null && rightValue === null) {
				return left.post.index - right.post.index;
			}
			if (leftValue === null) {
				return 1;
			}
			if (rightValue === null) {
				return -1;
			}

			if (leftValue !== rightValue) {
				return judgeSortOrder === 'asc' ? leftValue - rightValue : rightValue - leftValue;
			}

			return left.post.index - right.post.index;
		});
	}

	function scoreDelta(
		judgment: ThreadJudgment | null,
		previousJudgment: ThreadJudgment | null,
		metric: MetricKey
	): number | null {
		if (!judgment || !previousJudgment) return null;
		return judgment[metric] - previousJudgment[metric];
	}

	function formatDelta(value: number | null): string {
		if (value === null || !Number.isFinite(value)) {
			return '--';
		}

		const rounded = Math.round(value);
		if (rounded > 0) return `+${rounded}`;
		return String(rounded);
	}

	function deltaTone(value: number | null): 'up' | 'down' | 'flat' {
		if (value === null || !Number.isFinite(value) || value === 0) return 'flat';
		return value > 0 ? 'up' : 'down';
	}

	function displaySentiment(value: ThreadJudgment['sentiment'] | null): string {
		if (!value) return 'No score';
		return value.replace(/_/g, ' ');
	}

	function displayPostText(text: string): string {
		const trimmed = text.trim();
		return trimmed || 'No text';
	}

	function metricLabel(metric: MetricKey): string {
		return metricDefinitions.find((candidate) => candidate.key === metric)?.label ?? metric;
	}

	function postBskyUrl(post: ThreadJudgePost): string | null {
		return buildBskyPostUrl(post.uri, post.author.handle);
	}

	function glossaryEntries(judgment: ThreadJudgment | null) {
		return judgment?.glossary ?? [];
	}

	function sortHeadline(): string {
		if (judgeSortMode === 'sentiment') {
			return judgeSortOrder === 'asc'
				? 'Sentiment class from negative to positive'
				: 'Sentiment class from positive to negative';
		}

		if (judgeSortMode !== 'sequence') {
			return judgeSortOrder === 'asc'
				? `${metricLabel(judgeSortMode)} from low to high`
				: `${metricLabel(judgeSortMode)} from high to low`;
		}

		return judgeSortOrder === 'asc'
			? 'Thread order from first post to latest reply'
			: 'Thread order from latest reply to first post';
	}

	async function requestJudge(options: {
		cacheOnly?: boolean;
		suppressCacheMiss?: boolean;
		allowAnyCachedModel?: boolean;
	} = {}): Promise<'loaded' | 'cache-miss' | 'error'> {
		const requestId = ++judgeRequestId;
		const cacheOnly = options.cacheOnly === true;
		if (!cacheOnly) {
			judging = true;
			judgeError = null;
		}

		try {
			const response = await fetch('/api/thread/judge', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json'
				},
				body: JSON.stringify({
					rootUri: thread.rootUri,
					posts,
					cacheOnly,
					model: selectedJudgeModel,
					allowAnyCachedModel: options.allowAnyCachedModel === true
				})
			});

			const payload = (await response.json().catch(() => null)) as
				| ThreadJudgePayload
				| { message?: string }
				| null;

			if (!response.ok) {
				if (cacheOnly && response.status === 404 && options.suppressCacheMiss) {
					return 'cache-miss';
				}
				throw new Error((payload as any)?.message || `Thread judging failed: ${response.status}`);
			}

			if (requestId !== judgeRequestId || !payload || !('judgments' in payload)) {
				return 'error';
			}

			judgeResult = payload;
			const normalizedReturnedModel = normalizeThreadJudgeModel(payload.model);
			if (normalizedReturnedModel) {
				selectedJudgeModel = normalizedReturnedModel;
			}
			if (
				(payload.model || '').includes('(fetch-disabled)') &&
				Object.keys(payload.judgments || {}).length === 0
			) {
				judgeError =
					'FETCH=0 disables live Gemini Flash thread judging unless a cached judgment already exists.';
			}
			return 'loaded';
		} catch (error: any) {
			if (requestId !== judgeRequestId) {
				return 'error';
			}
			if (!cacheOnly) {
				judgeError = error?.message || 'Gemini thread judging failed.';
			}
			return 'error';
		} finally {
			if (!cacheOnly && requestId === judgeRequestId) {
				judging = false;
			}
		}
	}

	async function handleModelChange(event: Event) {
		const nextModel =
			normalizeThreadJudgeModel((event.currentTarget as HTMLSelectElement).value) ??
			DEFAULT_THREAD_JUDGE_MODEL;
		if (nextModel === selectedJudgeModel) return;

		selectedJudgeModel = nextModel;
		judgeError = null;
		judgeResult = null;

		if (posts.length === 0) return;

		const outcome = await requestJudge({ cacheOnly: true, suppressCacheMiss: true });
		if (outcome === 'cache-miss') {
			judgeError = `No cached judgment for ${threadJudgeModelLabel(nextModel)} yet. Click Judge to run it.`;
		}
	}

	async function judgeThread() {
		await requestJudge();
	}

	$effect(() => {
		const normalizedInitialModel = normalizeThreadJudgeModel(initialModel) ?? DEFAULT_THREAD_JUDGE_MODEL;
		if (normalizedInitialModel === selectedJudgeModel) {
			hasSynchronizedInitialModel = true;
			return;
		}

		const shouldReloadCache = hasSynchronizedInitialModel;
		selectedJudgeModel = normalizedInitialModel;
		judgeError = null;
		judgeResult = null;
		hasSynchronizedInitialModel = true;

		if (shouldReloadCache && posts.length > 0) {
			requestJudge({
				cacheOnly: true,
				suppressCacheMiss: true,
				allowAnyCachedModel: true
			});
		}
	});

	$effect(() => {
		if (!onmodelchange || selectedJudgeModel === lastReportedModel) return;
		lastReportedModel = selectedJudgeModel;
		onmodelchange(selectedJudgeModel);
	});

	onMount(() => {
		if (!autoloadCache) return;
		requestJudge({ cacheOnly: true, suppressCacheMiss: true, allowAnyCachedModel: true });
	});
</script>

<section class="judge-card wobbly-border">
	<div class="judge-head">
		<div>
			<h2>Thread Judge</h2>
			<p class="judge-subtitle">
				Gemini scores each post in thread context. Deltas compare each post to the
				immediately previous post.
			</p>
		</div>
		<div class="judge-controls">
			<label class="judge-model-picker">
				<span>Model</span>
				<select
					class="judge-model-select wobbly-border-light"
					value={selectedJudgeModel}
					onchange={handleModelChange}
					disabled={judging}
				>
					{#each THREAD_JUDGE_MODEL_OPTIONS as model}
						<option value={model.id}>{model.label}</option>
					{/each}
				</select>
			</label>
			<button
				type="button"
				class="judge-btn wobbly-border-light"
				onclick={judgeThread}
				disabled={judging || posts.length === 0}
			>
				{judgeResult ? 'Rejudge' : 'Judge'}
			</button>
		</div>
	</div>

	<div class="judge-status">
		<span>{posts.length} posts</span>
		<span>Selected: {threadJudgeModelLabel(selectedJudgeModel)}</span>
		{#if judging}
			<span>Judging with Gemini Flash…</span>
		{:else if judgeResult?.model}
			<span>{judgeResult.model}</span>
		{/if}
	</div>

	{#if judgeError}
		<p class="judge-warning">{judgeError}</p>
	{/if}

	{#if judgeResult}
		{@const opening = openingJudgment()}
		{#if opening}
			<div class="judge-baseline wobbly-border-light">
				<div>
					<span class="judge-kicker">Opening post</span>
					<h3>Post 1</h3>
					<p>{displaySentiment(opening.sentiment)}</p>
				</div>
				<div class="judge-baseline-metrics">
					{#each metricDefinitions as metric}
						<div class="judge-baseline-metric">
							<span>{metric.label}</span>
							<strong>{opening[metric.key]}</strong>
						</div>
					{/each}
				</div>
			</div>

			<details class="judge-explainer wobbly-border-light">
				<summary>What the scores mean</summary>
				<div class="judge-explainer-grid">
					{#each metricDefinitions as metric}
						<div class="judge-explainer-item">
							<strong>{metric.label}</strong>
							<p>{metric.explainer}</p>
						</div>
					{/each}
				</div>
			</details>

			<div class="judge-list-head">
				<h3>{sortHeadline()}</h3>
				<div class="judge-sort">
					<button
						type="button"
						class="mode-btn wobbly-border-light"
						class:active={judgeSortMode === 'sequence'}
						aria-pressed={judgeSortMode === 'sequence'}
						onclick={() => judgeSortMode = 'sequence'}
					>
						Sequence
					</button>
					<button
						type="button"
						class="mode-btn wobbly-border-light"
						class:active={judgeSortMode === 'sentiment'}
						aria-pressed={judgeSortMode === 'sentiment'}
						onclick={() => judgeSortMode = 'sentiment'}
					>
						Sentiment
					</button>
					{#each metricDefinitions as metric}
						<button
							type="button"
							class="mode-btn wobbly-border-light"
							class:active={judgeSortMode === metric.key}
							aria-pressed={judgeSortMode === metric.key}
							onclick={() => judgeSortMode = metric.key}
						>
							{metric.label}
						</button>
					{/each}
					<button
						type="button"
						class="mode-btn wobbly-border-light"
						class:active={judgeSortOrder === 'desc'}
						aria-pressed={judgeSortOrder === 'desc'}
						onclick={() => judgeSortOrder = 'desc'}
					>
						Descending
					</button>
					<button
						type="button"
						class="mode-btn wobbly-border-light"
						class:active={judgeSortOrder === 'asc'}
						aria-pressed={judgeSortOrder === 'asc'}
						onclick={() => judgeSortOrder = 'asc'}
					>
						Ascending
					</button>
				</div>
			</div>

			<div class="judge-grid">
				{#each buildRows() as row}
					<article class="judge-row wobbly-border-light" class:baseline={row.post.index === 1}>
						<div class="judge-row-top">
							<div class="judge-row-title">
								<span class="judge-index">Post {row.post.index}</span>
								{#if row.post.index === 1}
									<span class="judge-badge">Baseline</span>
								{/if}
								<span class="judge-author">@{row.post.author.handle}</span>
							</div>
							<span class="judge-sentiment">{displaySentiment(row.judgment?.sentiment ?? null)}</span>
						</div>

						<p class="judge-snippet">{displayPostText(row.post.text)}</p>

						{#if row.judgment}
							{@const glossary = glossaryEntries(row.judgment)}
							<p class="judge-summary">{row.judgment.summary}</p>
							<details class="judge-glossary wobbly-border-light">
								<summary>Explain words and references</summary>
								{#if glossary.length > 0}
									<ul class="judge-glossary-list">
										{#each glossary as item}
											<li class="judge-glossary-item">
												<strong>{item.term}</strong>
												<span>{item.explanation}</span>
											</li>
										{/each}
									</ul>
								{:else}
									<p class="judge-glossary-empty">
										No unfamiliar words or references were flagged for this post.
									</p>
								{/if}
							</details>
							<div class="judge-links">
								{#if postBskyUrl(row.post)}
									<a href={postBskyUrl(row.post) ?? '#'} target="_blank" rel="noreferrer">Open on Bluesky</a>
								{/if}
							</div>
							<p class="judge-compare-label">
								{#if row.previousPost}
									Delta vs post {row.previousPost.index}
								{:else}
									Start of thread
								{/if}
							</p>
							<div class="judge-metrics">
								{#each metricDefinitions as metric}
									{@const delta = scoreDelta(row.judgment, row.previousJudgment, metric.key)}
									<div class="judge-metric">
										<span>{metric.label}</span>
										<strong>{row.judgment[metric.key]}</strong>
										{#if row.previousPost}
											<em class={`judge-delta ${deltaTone(delta)}`}>{formatDelta(delta)}</em>
										{/if}
									</div>
								{/each}
							</div>
						{:else}
							<p class="judge-missing">No usable score came back for this post.</p>
						{/if}
					</article>
				{/each}
			</div>

			<details class="judge-raw wobbly-border-light">
				<summary>Raw JSON</summary>
				<pre>{JSON.stringify(judgeResult.judgments, null, 2)}</pre>
			</details>
		{:else}
			<p class="judge-missing">Gemini did not return a usable score for the opening post.</p>
		{/if}
	{:else if !judging}
		<p class="judge-empty">
			Run Judge to score sentiment, positivity, excitingness, intensity, curiosity, and
			confidence across the thread.
		</p>
	{/if}
</section>

<style>
	.judge-card {
		background:
			linear-gradient(180deg, rgba(255, 249, 238, 0.96), rgba(250, 242, 223, 0.92));
		margin: 0 auto 18px;
		padding: 18px;
	}

	.judge-head {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 16px;
	}

	.judge-controls {
		display: flex;
		align-items: flex-end;
		gap: 10px;
		flex-wrap: wrap;
		justify-content: flex-end;
	}

	.judge-model-picker {
		display: grid;
		gap: 6px;
		color: #5c5148;
		font-size: 0.8rem;
		font-weight: 700;
	}

	.judge-model-select {
		min-width: 230px;
		padding: 9px 12px;
		font: inherit;
		color: #2c241e;
		background: rgba(255, 255, 255, 0.88);
	}

	.judge-head h2 {
		margin: 0;
		font-size: 1.25rem;
		color: var(--text-ink);
	}

	.judge-subtitle {
		margin: 6px 0 0;
		color: var(--muted);
		max-width: 60ch;
	}

	.judge-btn {
		flex-shrink: 0;
		padding: 10px 16px;
		background: #b85042;
		color: #fff7ec;
		cursor: pointer;
		border-color: rgba(0, 0, 0, 0.16);
	}

	.judge-btn:disabled {
		opacity: 0.6;
		cursor: not-allowed;
	}

	.judge-status {
		display: flex;
		flex-wrap: wrap;
		gap: 8px 14px;
		margin-top: 14px;
		color: #6b6257;
		font-size: 0.85rem;
	}

	.judge-warning,
	.judge-empty,
	.judge-missing {
		margin: 14px 0 0;
		color: #6e3d2d;
	}

	.judge-baseline {
		display: grid;
		grid-template-columns: minmax(180px, 1fr) minmax(0, 2fr);
		gap: 18px;
		margin-top: 14px;
		padding: 14px;
		background: rgba(255, 255, 255, 0.68);
	}

	.judge-kicker {
		display: inline-block;
		font-size: 0.72rem;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: #9b5d39;
	}

	.judge-baseline h3 {
		margin: 4px 0;
		font-size: 1.15rem;
	}

	.judge-baseline p {
		margin: 0;
		text-transform: capitalize;
		color: #564a3f;
	}

	.judge-baseline-metrics,
	.judge-metrics {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(110px, 1fr));
		gap: 10px;
	}

	.judge-explainer {
		margin-top: 14px;
		padding: 12px 14px;
		background: rgba(255, 255, 255, 0.72);
	}

	.judge-explainer summary {
		cursor: pointer;
		font-weight: 700;
		color: #40362f;
	}

	.judge-explainer-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
		gap: 12px;
		margin-top: 12px;
	}

	.judge-explainer-item {
		padding: 10px 12px;
		border-radius: 10px;
		background: rgba(249, 244, 235, 0.92);
	}

	.judge-explainer-item strong {
		display: block;
		color: #201812;
	}

	.judge-explainer-item p {
		margin: 6px 0 0;
		color: #5c5148;
		font-size: 0.88rem;
		line-height: 1.4;
	}

	.judge-list-head {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 12px;
		flex-wrap: wrap;
		margin-top: 16px;
	}

	.judge-list-head h3 {
		margin: 0;
		font-size: 0.96rem;
		color: #5c5148;
	}

	.judge-sort {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		align-items: center;
	}

	.judge-sort .mode-btn {
		padding: 6px 10px;
		font-size: 0.82rem;
		background: rgba(255, 255, 255, 0.72);
		color: #4b3f35;
		border-color: rgba(75, 63, 53, 0.16);
		transition:
			background 0.15s ease,
			color 0.15s ease,
			border-color 0.15s ease,
			box-shadow 0.15s ease;
	}

	.judge-sort .mode-btn:hover {
		background: rgba(255, 255, 255, 0.9);
	}

	.judge-sort .mode-btn.active {
		background: color-mix(in srgb, #b85042 18%, white);
		color: #61261d;
		border-color: rgba(184, 80, 66, 0.5);
		box-shadow: 0 0 0 2px rgba(184, 80, 66, 0.12);
		font-weight: 700;
	}

	.judge-baseline-metric,
	.judge-metric {
		display: flex;
		flex-direction: column;
		gap: 3px;
		padding: 10px 12px;
		border-radius: 10px;
		background: rgba(255, 255, 255, 0.74);
		color: #5c5148;
	}

	.judge-baseline-metric strong,
	.judge-metric strong {
		font-size: 1.1rem;
		color: #201812;
	}

	.judge-grid {
		display: grid;
		gap: 12px;
		margin-top: 16px;
	}

	.judge-row {
		padding: 14px;
		background: rgba(255, 255, 255, 0.76);
	}

	.judge-row.baseline {
		background: rgba(255, 246, 214, 0.88);
	}

	.judge-row-top {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
	}

	.judge-row-title {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px;
	}

	.judge-index {
		font-weight: 700;
		color: #201812;
	}

	.judge-badge {
		padding: 3px 8px;
		border-radius: 999px;
		background: #f0ba52;
		color: #4a2d14;
		font-size: 0.72rem;
		font-weight: 700;
	}

	.judge-author,
	.judge-sentiment {
		color: #6c5f51;
		font-size: 0.86rem;
		text-transform: capitalize;
	}

	.judge-snippet,
	.judge-summary {
		margin: 10px 0 0;
	}

	.judge-snippet {
		color: #2c241e;
		line-height: 1.45;
		white-space: pre-wrap;
		word-break: break-word;
	}

	.judge-summary {
		color: #8f4f2a;
		font-size: 0.9rem;
		font-style: italic;
	}

	.judge-glossary {
		margin-top: 10px;
		padding: 10px 12px;
		background: rgba(255, 251, 245, 0.86);
	}

	.judge-glossary summary {
		cursor: pointer;
		font-size: 0.85rem;
		font-weight: 700;
		color: #5a3b26;
	}

	.judge-glossary-list {
		list-style: none;
		padding: 0;
		margin: 10px 0 0;
		display: grid;
		gap: 8px;
	}

	.judge-glossary-item {
		display: grid;
		gap: 3px;
		padding: 8px 10px;
		border-radius: 10px;
		background: rgba(248, 242, 232, 0.92);
	}

	.judge-glossary-item strong {
		color: #201812;
		font-size: 0.88rem;
	}

	.judge-glossary-item span,
	.judge-glossary-empty {
		color: #5c5148;
		font-size: 0.84rem;
		line-height: 1.4;
	}

	.judge-glossary-empty {
		margin: 10px 0 0;
	}

	.judge-links {
		display: flex;
		flex-wrap: wrap;
		gap: 10px;
		margin-top: 10px;
	}

	.judge-links a {
		color: #7c5032;
		font-size: 0.86rem;
		text-decoration: none;
	}

	.judge-links a:hover {
		text-decoration: underline;
	}

	.judge-compare-label {
		margin: 8px 0 0;
		color: #6c5f51;
		font-size: 0.8rem;
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}

	.judge-delta {
		font-style: normal;
		font-size: 0.82rem;
	}

	.judge-delta.up {
		color: #2c7a3d;
	}

	.judge-delta.down {
		color: #ab3d35;
	}

	.judge-delta.flat {
		color: #6c5f51;
	}

	.judge-raw {
		margin-top: 16px;
		padding: 12px 14px;
		background: rgba(255, 255, 255, 0.72);
	}

	.judge-raw summary {
		cursor: pointer;
		font-weight: 700;
		color: #40362f;
	}

	.judge-raw pre {
		margin: 10px 0 0;
		padding: 12px;
		overflow-x: auto;
		border-radius: 10px;
		background: #f6f0e6;
		font-size: 0.8rem;
		line-height: 1.45;
	}

	@media (max-width: 760px) {
		.judge-head,
		.judge-list-head,
		.judge-row-top {
			flex-direction: column;
			align-items: flex-start;
		}

		.judge-controls {
			width: 100%;
			justify-content: stretch;
		}

		.judge-model-picker,
		.judge-model-select,
		.judge-btn {
			width: 100%;
		}

		.judge-baseline {
			grid-template-columns: 1fr;
		}
	}
</style>
