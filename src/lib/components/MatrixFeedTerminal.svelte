<script lang="ts">
	import { onMount } from 'svelte';
	import MatrixFeedTerminalPanel from '$lib/components/MatrixFeedTerminalPanel.svelte';
	import MatrixRainPanel from '$lib/components/MatrixRainPanel.svelte';
	import type { MatrixTerminalFontId } from '$lib/constants/matrixTerminalFonts';

	export interface MatrixTerminalPost {
		id: string;
		authorHandle: string;
		createdAtLabel: string;
		metaLabel: string;
		body: string;
		permalink: string | null;
	}

	let {
		posts = [],
		handle = '',
		displayName = null,
		loading = false,
		paused = false,
		frameDelayMs = 72,
		preferredColumnCount = 4,
		layoutMode = 'grid',
		renderStyle = 'terminal',
		terminalFontId = 'rain',
		onopenpost = null,
		onpreview = null,
		idlePrimaryText = 'Insert a Bluesky handle to start this panel.',
		idleSecondaryText = 'Each panel types one full post, then moves to the next.',
		loadingText = 'Loading the latest 100 posts_with_replies...'
	}: {
		posts?: MatrixTerminalPost[];
		handle?: string;
		displayName?: string | null;
		loading?: boolean;
		paused?: boolean;
		frameDelayMs?: number;
		preferredColumnCount?: number;
		layoutMode?: 'grid' | 'btree';
		renderStyle?: 'terminal' | 'rain' | 'rain-horizontal';
		terminalFontId?: MatrixTerminalFontId;
		onopenpost?: ((post: MatrixTerminalPost) => void) | null;
		onpreview?: ((post: MatrixTerminalPost) => void) | null;
		idlePrimaryText?: string;
		idleSecondaryText?: string;
		loadingText?: string;
	} = $props();

	const resolvedPanelCount = $derived(Math.max(1, Math.min(100, preferredColumnCount)));
	const panelIndexes = $derived(Array.from({ length: resolvedPanelCount }, (_, index) => index));

	type LayoutSlot = {
		x: number;
		y: number;
		width: number;
		height: number;
	};

	type PanelPostSlice = {
		key: string;
		posts: MatrixTerminalPost[];
	};

	let hostEl: HTMLDivElement;
	let hostWidth = $state(1600);
	let hostHeight = $state(900);
	let resizeObserver: ResizeObserver | null = null;

	const panelGapPx = $derived(
		resolvedPanelCount >= 64 ? 2 : resolvedPanelCount >= 24 ? 4 : resolvedPanelCount >= 9 ? 6 : 8
	);

	function buildGridLayout(panelCount: number, width: number, height: number): LayoutSlot[] {
		if (panelCount <= 0) return [];

		const aspectRatio = Math.max(width, 1) / Math.max(height, 1);
		const estimatedColumns = Math.max(
			1,
			Math.min(panelCount, Math.round(Math.sqrt(panelCount * Math.max(aspectRatio, 0.75))))
		);
		const rowCount = Math.max(1, Math.ceil(panelCount / estimatedColumns));
		const baseItemsPerRow = Math.floor(panelCount / rowCount);
		const extraItems = panelCount % rowCount;
		const slots: LayoutSlot[] = [];
		let nextPanelIndex = 0;

		for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
			const itemsInRow = baseItemsPerRow + (rowIndex < extraItems ? 1 : 0);
			const rowHeight = 100 / rowCount;
			const itemWidth = 100 / itemsInRow;

			for (let columnIndex = 0; columnIndex < itemsInRow; columnIndex += 1) {
				if (nextPanelIndex >= panelCount) {
					break;
				}

				slots.push({
					x: columnIndex * itemWidth,
					y: rowIndex * rowHeight,
					width: itemWidth,
					height: rowHeight
				});
				nextPanelIndex += 1;
			}
		}

		return slots;
	}

	function buildBtreeLayout(panelCount: number): LayoutSlot[] {
		const slots: LayoutSlot[] = [];

		function splitRegion(
			x: number,
			y: number,
			width: number,
			height: number,
			count: number,
			depth: number
		) {
			if (count <= 0) return;
			if (count === 1) {
				slots.push({ x, y, width, height });
				return;
			}

			const primaryCount = Math.ceil(count / 2);
			const secondaryCount = count - primaryCount;
			const splitVertical = depth % 2 === 0;

			if (splitVertical) {
				const primaryWidth = width * (primaryCount / count);
				splitRegion(x, y, primaryWidth, height, primaryCount, depth + 1);
				splitRegion(x + primaryWidth, y, width - primaryWidth, height, secondaryCount, depth + 1);
				return;
			}

			const primaryHeight = height * (primaryCount / count);
			splitRegion(x, y, width, primaryHeight, primaryCount, depth + 1);
			splitRegion(x, y + primaryHeight, width, height - primaryHeight, secondaryCount, depth + 1);
		}

		splitRegion(0, 0, 100, 100, panelCount, 0);
		return slots;
	}

	const layoutSlots = $derived.by(() =>
		layoutMode === 'btree'
			? buildBtreeLayout(resolvedPanelCount)
			: buildGridLayout(resolvedPanelCount, hostWidth, hostHeight)
	);

	const panelPostSlices = $derived.by<PanelPostSlice[]>(() => {
		const slices = Array.from({ length: resolvedPanelCount }, () => [] as MatrixTerminalPost[]);

		for (let index = 0; index < posts.length; index += 1) {
			slices[index % resolvedPanelCount].push(posts[index]);
		}

		return slices.map((slice, index) => ({
			key: slice.map((post) => post.id).join('|') || `panel-${index}-empty`,
			posts: slice
		}));
	});

	function getPanelStyle(slot: LayoutSlot): string {
		return [
			`--slot-x: ${slot.x}%`,
			`--slot-y: ${slot.y}%`,
			`--slot-width: ${slot.width}%`,
			`--slot-height: ${slot.height}%`
		].join('; ');
	}

	onMount(() => {
		resizeObserver = new ResizeObserver((entries) => {
			const entry = entries[0];
			if (!entry) return;
			hostWidth = entry.contentRect.width || 1;
			hostHeight = entry.contentRect.height || 1;
		});
		resizeObserver.observe(hostEl);

		return () => {
			resizeObserver?.disconnect();
			resizeObserver = null;
		};
	});
</script>

<div
	class="matrix-terminal-grid"
	class:btree={layoutMode === 'btree'}
	bind:this={hostEl}
	style={`--matrix-gap: ${panelGapPx}px;`}
>
	{#each panelIndexes as panelIndex, index (panelIndex)}
		<section class="matrix-panel-shell" style={getPanelStyle(layoutSlots[index])}>
			<div class="matrix-panel-badge">panel {panelIndex + 1}</div>
				{#if renderStyle === 'rain' || renderStyle === 'rain-horizontal'}
					<MatrixRainPanel
						posts={panelPostSlices[index]?.posts ?? []}
						feedKey={panelPostSlices[index]?.key ?? `panel-${panelIndex}-empty`}
						{handle}
						{displayName}
						{loading}
						{paused}
						{frameDelayMs}
						{terminalFontId}
						direction={renderStyle === 'rain-horizontal' ? 'horizontal' : 'vertical'}
						{panelIndex}
						panelCount={resolvedPanelCount}
						{onpreview}
						{idlePrimaryText}
						{idleSecondaryText}
						{loadingText}
					/>
			{:else}
				<MatrixFeedTerminalPanel
					posts={panelPostSlices[index]?.posts ?? []}
					feedKey={panelPostSlices[index]?.key ?? `panel-${panelIndex}-empty`}
					{handle}
					{displayName}
					{loading}
					{paused}
					{frameDelayMs}
					{terminalFontId}
					{panelIndex}
					panelCount={resolvedPanelCount}
					{onopenpost}
					{onpreview}
					{idlePrimaryText}
					{idleSecondaryText}
					{loadingText}
				/>
			{/if}
		</section>
	{/each}
</div>

<style>
	.matrix-terminal-grid {
		position: relative;
		width: 100%;
		height: 100%;
		min-height: 0;
		overflow: hidden;
	}

	.matrix-panel-shell {
		position: absolute;
		left: calc(var(--slot-x) + (var(--matrix-gap) / 2));
		top: calc(var(--slot-y) + (var(--matrix-gap) / 2));
		width: calc(var(--slot-width) - var(--matrix-gap));
		height: calc(var(--slot-height) - var(--matrix-gap));
		min-width: 0;
		min-height: 0;
		border-radius: 16px;
		overflow: hidden;
		background:
			radial-gradient(circle at top, rgba(72, 255, 101, 0.09), transparent 36%),
			linear-gradient(180deg, rgba(6, 16, 10, 0.98), rgba(1, 5, 3, 0.995));
		box-shadow:
			inset 0 0 0 1px rgba(110, 255, 129, 0.18),
			0 20px 60px rgba(0, 0, 0, 0.32);
	}

	.matrix-panel-shell::before {
		content: '';
		position: absolute;
		inset: 0;
		background:
			repeating-linear-gradient(
				180deg,
				rgba(123, 255, 146, 0.04) 0,
				rgba(123, 255, 146, 0.04) 1px,
				transparent 1px,
				transparent 4px
			);
		pointer-events: none;
		mix-blend-mode: screen;
	}

	.matrix-panel-badge {
		position: absolute;
		top: 8px;
		right: 10px;
		z-index: 2;
		padding: 3px 7px;
		border: 1px solid rgba(125, 255, 154, 0.16);
		border-radius: 999px;
		background: rgba(2, 8, 4, 0.78);
		color: rgba(198, 255, 173, 0.82);
		font-family: var(--font-matrix-ui);
		font-size: 0.63rem;
		text-transform: uppercase;
		letter-spacing: 0.12em;
		pointer-events: none;
	}

	.matrix-terminal-grid.btree .matrix-panel-shell {
		border-radius: 14px;
	}

	@media (max-width: 640px) {
		.matrix-panel-shell {
			border-radius: 12px;
		}

		.matrix-panel-badge {
			top: 6px;
			right: 8px;
		}
	}
</style>
