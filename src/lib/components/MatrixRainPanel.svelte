<script lang="ts">
	import { onMount } from 'svelte';
	import type { MatrixTerminalPost } from '$lib/components/MatrixFeedTerminal.svelte';
	import {
		getMatrixTerminalFontOption,
		type MatrixTerminalFontId
	} from '$lib/constants/matrixTerminalFonts';

	type RainColumn = {
		id: number;
		postId: string;
		laneIndex: number;
		createdAtMs: number;
		offsetPercent: number;
		travelDistancePx: number;
		travelStartPx: number;
		travelEndPx: number;
		delayMs: number;
		gapMs: number;
		opacity: number;
		sizeRem: number;
		text: string;
	};

	let {
		posts = [],
		feedKey = '',
		handle = '',
		displayName = null,
		loading = false,
		paused = false,
		frameDelayMs = 72,
		terminalFontId = 'rain',
		direction = 'vertical',
		panelIndex = 0,
		panelCount = 1,
		onpreview = null,
		idlePrimaryText = 'Insert a Bluesky handle to start this panel.',
		idleSecondaryText = 'Each panel types one full post, then moves to the next.',
		loadingText = 'Loading the latest 100 posts_with_replies...'
	}: {
		posts?: MatrixTerminalPost[];
		feedKey?: string;
		handle?: string;
		displayName?: string | null;
		loading?: boolean;
		paused?: boolean;
		frameDelayMs?: number;
		terminalFontId?: MatrixTerminalFontId;
		direction?: 'vertical' | 'horizontal';
		panelIndex?: number;
		panelCount?: number;
		onpreview?: ((post: MatrixTerminalPost) => void) | null;
		idlePrimaryText?: string;
		idleSecondaryText?: string;
		loadingText?: string;
	} = $props();

	let hostEl: HTMLDivElement;
	let hostWidth = $state(320);
	let hostHeight = $state(240);
	let columns = $state<RainColumn[]>([]);
	let resizeObserver: ResizeObserver | null = null;
	let nextColumnId = 0;
	let activeFeedKey = '';
	let activeStructureKey = '';
	let hasRenderedFeedContent = $state(false);
	let hasMeasuredViewport = false;
	let pendingPosts = $state<MatrixTerminalPost[]>([]);
	let renderedPostIds = new Set<string>();
	let laneReadyAt: number[] = [];

	const activeFont = $derived(getMatrixTerminalFontOption(terminalFontId));

	function compactWhitespace(text: string): string {
		return text.replace(/\s+/g, ' ').trim();
	}

	function truncate(text: string, maxLength: number): string {
		if (text.length <= maxLength) return text;
		return `${text.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
	}

	function clamp(value: number, min: number, max: number): number {
		return Math.min(max, Math.max(min, value));
	}

	function getStructureKey(): string {
		return `${handle}::${displayName ?? ''}::${panelIndex}::${panelCount}::${direction}`;
	}

	function getSpeedProgress(): number {
		return 1 - clamp((frameDelayMs - 4) / 96, 0, 1);
	}

	function getRainSpeedMultiplier(isHorizontal: boolean): number {
		const speedProgress = getSpeedProgress();
		return isHorizontal
			? 1.7 - speedProgress * 1.05
			: 1.35 - speedProgress * 0.72;
	}

	function getPixelsPerSecond(isHorizontal: boolean): number {
		const speedProgress = getSpeedProgress();
		return isHorizontal
			? 92 + speedProgress * 308
			: 118 + speedProgress * 212;
	}

	function getLaneGapMs(isHorizontal: boolean): number {
		const speedProgress = getSpeedProgress();
		return isHorizontal
			? Math.round(620 - speedProgress * 500)
			: Math.round(380 - speedProgress * 260);
	}

	function resetRainState() {
		activeFeedKey = '';
		columns = [];
		nextColumnId = 0;
		hasRenderedFeedContent = false;
		pendingPosts = [];
		renderedPostIds = new Set<string>();
		laneReadyAt = [];
	}

	function getLaneCountForSize(width: number, height: number, isHorizontal: boolean): number {
		return isHorizontal
			? Math.max(6, Math.min(24, Math.floor(height / 34)))
			: Math.max(8, Math.min(36, Math.floor(width / 23)));
	}

	function getLaneCount(isHorizontal: boolean): number {
		return getLaneCountForSize(hostWidth, hostHeight, isHorizontal);
	}

	function getLaneOffsetPercent(laneIndex: number, laneCount: number): number {
		if (laneCount <= 1) return 50;
		return (laneIndex / (laneCount - 1)) * 100;
	}

	function buildRainText(post: MatrixTerminalPost, isHorizontal: boolean): string {
		const body = truncate(compactWhitespace(post.body || '[no text body]'), isHorizontal ? 180 : 92);
		if (isHorizontal) {
			return `${post.createdAtLabel}  @${post.authorHandle}  ${body}  ${post.metaLabel}`;
		}

		const verticalBody = body.replace(/\s+/g, '/').replace(/\/{2,}/g, '/');
		return `@${post.authorHandle}/${verticalBody}/${post.metaLabel.replace(/\s+/g, '')}`.toUpperCase();
	}

	function estimateTextExtentPx(text: string, sizeRem: number, isHorizontal: boolean): number {
		const fontPx = sizeRem * activeFont.rainScale * 16;
		return isHorizontal
			? Math.max(hostWidth * 0.3, text.length * fontPx * 0.62)
			: Math.max(hostHeight * 0.18, text.length * fontPx * 0.72);
	}

	function buildTravelPlan(text: string, sizeRem: number, isHorizontal: boolean) {
		const overscan = Math.max(isHorizontal ? 72 : 40, Math.round((isHorizontal ? hostWidth : hostHeight) * 0.1));
		const extentPx = estimateTextExtentPx(text, sizeRem, isHorizontal);

		if (isHorizontal) {
			const travelStartPx = extentPx + overscan;
			const travelEndPx = -(hostWidth + overscan);
			return {
				travelStartPx,
				travelEndPx,
				travelDistancePx: travelStartPx - travelEndPx
			};
		}

		const travelStartPx = -(extentPx + overscan);
		const travelEndPx = hostHeight + overscan;
		return {
			travelStartPx,
			travelEndPx,
			travelDistancePx: travelEndPx - travelStartPx
		};
	}

	function getColumnDurationMs(travelDistancePx: number, isHorizontal: boolean): number {
		const pixelsPerSecond = getPixelsPerSecond(isHorizontal);
		const rawDurationMs = Math.round((travelDistancePx / pixelsPerSecond) * 1000);
		return clamp(rawDurationMs, isHorizontal ? 5200 : 2800, isHorizontal ? 32000 : 18000);
	}

	function syncLaneReadyAt(
		now: number,
		laneCount: number,
		isHorizontal: boolean,
		existingColumns: RainColumn[]
	) {
		if (laneReadyAt.length !== laneCount) {
			laneReadyAt = Array.from({ length: laneCount }, () => now);
		} else {
			laneReadyAt = laneReadyAt.map(() => now);
		}

		for (const column of existingColumns) {
			if (column.laneIndex >= laneCount) continue;
			const endAt =
				column.createdAtMs +
				column.delayMs +
				getColumnDurationMs(column.travelDistancePx, isHorizontal) +
				column.gapMs;
			laneReadyAt[column.laneIndex] = Math.max(laneReadyAt[column.laneIndex], endAt);
		}
	}

	function pickNextLane(laneCount: number): number {
		let bestIndex = 0;
		let bestTime = laneReadyAt[0] ?? 0;

		for (let index = 1; index < laneCount; index += 1) {
			const candidate = laneReadyAt[index] ?? 0;
			if (candidate < bestTime) {
				bestTime = candidate;
				bestIndex = index;
			}
		}

		return bestIndex;
	}

	function buildColumnsForPosts(
		batchPosts: MatrixTerminalPost[],
		existingColumns: RainColumn[] = columns
	): RainColumn[] {
		const isHorizontal = direction === 'horizontal';
		const laneCount = getLaneCount(isHorizontal);
		const now = Date.now();
		syncLaneReadyAt(now, laneCount, isHorizontal, existingColumns);
		const sizeRange = isHorizontal ? [0.98, 1.16] : [0.92, 1.08];

		return batchPosts.map((post) => {
			const text = buildRainText(post, isHorizontal);
			const sizeRem = Number((sizeRange[0] + Math.random() * (sizeRange[1] - sizeRange[0])).toFixed(2));
			const travelPlan = buildTravelPlan(text, sizeRem, isHorizontal);
			const laneIndex = pickNextLane(laneCount);
			const gapMs = getLaneGapMs(isHorizontal);
			const delayMs = Math.max(0, Math.round(laneReadyAt[laneIndex] - now));
			laneReadyAt[laneIndex] =
				now + delayMs + getColumnDurationMs(travelPlan.travelDistancePx, isHorizontal) + gapMs;

			return {
				id: nextColumnId++,
				postId: post.id,
				laneIndex,
				createdAtMs: now,
				offsetPercent: getLaneOffsetPercent(laneIndex, laneCount),
				travelDistancePx: travelPlan.travelDistancePx,
				travelStartPx: travelPlan.travelStartPx,
				travelEndPx: travelPlan.travelEndPx,
				delayMs,
				gapMs,
				opacity: Number((isHorizontal ? 0.56 + Math.random() * 0.22 : 0.34 + Math.random() * 0.34).toFixed(2)),
				sizeRem,
				text
			};
		});
	}

	function measureHostSize(): boolean {
		if (!hostEl) return false;
		const rect = hostEl.getBoundingClientRect();
		const nextWidth = rect.width || 0;
		const nextHeight = rect.height || 0;
		if (nextWidth <= 0 || nextHeight <= 0) {
			return false;
		}

		hostWidth = nextWidth;
		hostHeight = nextHeight;
		hasMeasuredViewport = true;
		return true;
	}

	function shouldReflowForResize(
		previousWidth: number,
		previousHeight: number,
		nextWidth: number,
		nextHeight: number
	): boolean {
		if (columns.length === 0) return false;

		const isHorizontal = direction === 'horizontal';
		const previousLaneCount = getLaneCountForSize(previousWidth, previousHeight, isHorizontal);
		const nextLaneCount = getLaneCountForSize(nextWidth, nextHeight, isHorizontal);
		if (previousLaneCount !== nextLaneCount) {
			return true;
		}

		return Math.abs(nextWidth - previousWidth) > 64 || Math.abs(nextHeight - previousHeight) > 64;
	}

	function getMaxVisibleColumnCount(): number {
		return getLaneCount(direction === 'horizontal');
	}

	function flushPendingPostsToColumns() {
		if (paused) return;
		if (!hasMeasuredViewport || pendingPosts.length === 0) return;

		const availableSlots = Math.max(0, getMaxVisibleColumnCount() - columns.length);
		if (availableSlots <= 0) return;

		const nextPosts = pendingPosts.slice(0, availableSlots);
		if (nextPosts.length === 0) return;

		columns = [...columns, ...buildColumnsForPosts(nextPosts)];
		pendingPosts = pendingPosts.slice(nextPosts.length);
		hasRenderedFeedContent = true;
	}

	function reflowQueuedColumns() {
		if (paused) return;
		if (!hasMeasuredViewport || columns.length === 0) return;

		const now = Date.now();
		const queuedPostIds = columns
			.filter((column) => now < column.createdAtMs + column.delayMs)
			.map((column) => column.postId);
		if (queuedPostIds.length === 0) return;

		const activeColumns = columns.filter((column) => now >= column.createdAtMs + column.delayMs);
		const queuedPosts = queuedPostIds
			.map((postId) => posts.find((post) => post.id === postId))
			.filter((post): post is MatrixTerminalPost => Boolean(post));

		if (queuedPosts.length === 0) {
			columns = activeColumns;
			flushPendingPostsToColumns();
			return;
		}

		columns = [...activeColumns, ...buildColumnsForPosts(queuedPosts, activeColumns)];
		flushPendingPostsToColumns();
	}

	function queueColumnsForCurrentFeed() {
		if (paused) return;
		if (!hasMeasuredViewport) return;
		if (feedKey !== activeFeedKey) {
			activeFeedKey = feedKey;

			const unseenPosts = posts.filter((post) => !renderedPostIds.has(post.id));
			if (unseenPosts.length > 0) {
				for (const post of unseenPosts) {
					renderedPostIds.add(post.id);
				}
				pendingPosts = [...pendingPosts, ...unseenPosts];
			}
		}

		flushPendingPostsToColumns();
	}

	function handleColumnPreview(postId: string) {
		const post = posts.find((entry) => entry.id === postId);
		if (!post) return;
		onpreview?.(post);
	}

	function getColumnPreviewLabel(postId: string): string {
		const post = posts.find((entry) => entry.id === postId);
		const authorHandle = post?.authorHandle || handle || 'unknown';
		return `Preview post by @${authorHandle}`;
	}

	function handleColumnEnd(columnId: number) {
		columns = columns.filter((column) => column.id !== columnId);
		flushPendingPostsToColumns();
	}

	onMount(() => {
		activeStructureKey = getStructureKey();
		measureHostSize();
		queueColumnsForCurrentFeed();

		resizeObserver = new ResizeObserver((entries) => {
			const entry = entries[0];
			if (!entry) return;
			const previousWidth = hostWidth;
			const previousHeight = hostHeight;
			hostWidth = entry.contentRect.width || 320;
			hostHeight = entry.contentRect.height || 240;
			hasMeasuredViewport = true;

			if (shouldReflowForResize(previousWidth, previousHeight, hostWidth, hostHeight)) {
				reflowQueuedColumns();
			}

			queueColumnsForCurrentFeed();
		});
		resizeObserver.observe(hostEl);

		return () => {
			resizeObserver?.disconnect();
			resizeObserver = null;
		};
	});

	$effect(() => {
		handle;
		displayName;
		panelIndex;
		panelCount;
		direction;
		const nextStructureKey = getStructureKey();
		if (nextStructureKey !== activeStructureKey) {
			activeStructureKey = nextStructureKey;
			resetRainState();
			queueColumnsForCurrentFeed();
		}
	});

	$effect(() => {
		posts;
		feedKey;
		frameDelayMs;
		queueColumnsForCurrentFeed();
	});

	$effect(() => {
		paused;
		if (paused) return;
		queueColumnsForCurrentFeed();
	});
</script>

<div
	class="matrix-rain-panel"
	class:horizontal={direction === 'horizontal'}
	class:paused
	bind:this={hostEl}
	style={`--matrix-terminal-font-family: ${activeFont.family}; --matrix-rain-font-scale: ${activeFont.rainScale};`}
>
	<div class="rain-streams">
		{#each columns as column (column.id)}
			<button
				type="button"
				class="rain-column"
				class:horizontal={direction === 'horizontal'}
				aria-label={getColumnPreviewLabel(column.postId)}
				style={`${direction === 'horizontal' ? `top: ${column.offsetPercent}%; --rain-overscan: 72px; --rain-host-width: ${hostWidth}px; --rain-start-x: ${column.travelStartPx}px; --rain-end-x: ${column.travelEndPx}px;` : `left: ${column.offsetPercent}%; --rain-host-height: ${hostHeight}px; --rain-start-y: ${column.travelStartPx}px; --rain-end-y: ${column.travelEndPx}px;`}; --rain-duration: ${getColumnDurationMs(column.travelDistancePx, direction === 'horizontal')}ms; --rain-delay: ${column.delayMs}ms; --rain-opacity: ${column.opacity}; --rain-size: ${column.sizeRem}rem;`}
				onclick={() => handleColumnPreview(column.postId)}
				onanimationend={() => handleColumnEnd(column.id)}
			>
				{column.text}
			</button>
		{/each}
	</div>

	<div class="rain-overlay">
		<div class="rain-header">
			<span>@{handle || 'waiting'}</span>
			<span>{displayName || 'matrix rain mode'}</span>
		</div>

		{#if loading}
			<div class="rain-status">
				<span>{hasRenderedFeedContent ? 'Syncing next snapshot' : 'Syncing'}</span>
				<span>{loadingText}</span>
			</div>
		{:else if !hasRenderedFeedContent && posts.length === 0}
			<div class="rain-status">
				<span>{idlePrimaryText}</span>
				<span>{idleSecondaryText}</span>
			</div>
		{:else if columns.length === 0}
			<div class="rain-status compact">
				<span>Awaiting next feed snapshot</span>
				<span>panel queue complete</span>
			</div>
		{:else}
			<div class="rain-status compact">
				<span>{posts.length} posts drifting as {direction === 'horizontal' ? 'horizontal' : 'vertical'} rain</span>
			</div>
		{/if}
	</div>
</div>

<style>
	.matrix-rain-panel {
		position: relative;
		width: 100%;
		height: 100%;
		overflow: hidden;
		background:
			radial-gradient(circle at top, rgba(81, 255, 104, 0.1), transparent 24%),
			linear-gradient(180deg, rgba(4, 11, 7, 0.98), rgba(2, 7, 4, 0.995));
	}

	.matrix-rain-panel::before {
		content: '';
		position: absolute;
		inset: 0;
		background:
			linear-gradient(180deg, rgba(150, 255, 165, 0.06), transparent 18%, transparent 82%, rgba(150, 255, 165, 0.04)),
			repeating-linear-gradient(
				180deg,
				rgba(123, 255, 146, 0.035) 0,
				rgba(123, 255, 146, 0.035) 1px,
				transparent 1px,
				transparent 4px
			);
		pointer-events: none;
		mix-blend-mode: screen;
	}

	.matrix-rain-panel.horizontal::before {
		background:
			linear-gradient(90deg, rgba(150, 255, 165, 0.06), transparent 18%, transparent 82%, rgba(150, 255, 165, 0.04)),
			repeating-linear-gradient(
				90deg,
				rgba(123, 255, 146, 0.03) 0,
				rgba(123, 255, 146, 0.03) 1px,
				transparent 1px,
				transparent 8px
			);
	}

	.rain-streams {
		position: absolute;
		inset: -18% 0 0;
		overflow: hidden;
	}

	.matrix-rain-panel.horizontal .rain-streams {
		inset: 0 -18% 0 0;
	}

	.rain-column {
		position: absolute;
		top: 0;
		padding: 0;
		border: 0;
		background: transparent;
		font-family: var(--matrix-terminal-font-family, var(--font-matrix-terminal));
		font-size: calc(var(--rain-size) * var(--matrix-rain-font-scale, 1) * 1rem);
		line-height: 0.86;
		writing-mode: vertical-rl;
		text-orientation: upright;
		white-space: nowrap;
		color: rgba(145, 255, 158, var(--rain-opacity));
		text-shadow:
			0 0 6px rgba(78, 255, 91, 0.55),
			0 0 18px rgba(78, 255, 91, 0.22);
		animation: matrix-rain-fall var(--rain-duration) linear var(--rain-delay) 1 both;
		transform: translate3d(0, var(--rain-start-y), 0);
		cursor: pointer;
		user-select: none;
	}

	.rain-column.horizontal {
		left: auto;
		right: 0;
		top: auto;
		display: inline-block;
		width: max-content;
		max-width: none;
		line-height: 1.06;
		writing-mode: initial;
		text-orientation: initial;
		letter-spacing: 0.05em;
		word-spacing: 0.16em;
		animation-name: matrix-rain-slide;
		transform: translate3d(calc(100% + var(--rain-overscan)), 0, 0);
	}

	.matrix-rain-panel.paused .rain-column {
		animation-play-state: paused;
	}

	.rain-overlay {
		position: absolute;
		inset: 0;
		display: flex;
		flex-direction: column;
		justify-content: space-between;
		padding: 12px;
		pointer-events: none;
	}

	.rain-header,
	.rain-status {
		display: grid;
		gap: 4px;
		max-width: min(100%, 26rem);
		padding: 8px 10px;
		border: 1px solid rgba(125, 255, 154, 0.12);
		border-radius: 10px;
		background: rgba(2, 8, 4, 0.38);
		backdrop-filter: blur(6px);
		color: rgba(214, 255, 198, 0.9);
		font-family: var(--font-matrix-ui);
		text-transform: uppercase;
		letter-spacing: 0.08em;
	}

	.rain-header {
		font-size: 0.68rem;
		justify-self: start;
	}

	.rain-status {
		align-self: end;
		font-size: 0.64rem;
	}

	.rain-status.compact {
		justify-self: end;
	}

	@keyframes matrix-rain-fall {
		from {
			transform: translate3d(0, var(--rain-start-y), 0);
		}

		to {
			transform: translate3d(0, var(--rain-end-y), 0);
		}
	}

	@keyframes matrix-rain-slide {
		from {
			transform: translate3d(calc(100% + var(--rain-overscan)), 0, 0);
		}

		to {
			transform: translate3d(calc(-1 * (var(--rain-host-width) + var(--rain-overscan))), 0, 0);
		}
	}
</style>
