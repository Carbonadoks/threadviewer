<script lang="ts">
	import { onMount, type Snippet } from 'svelte';
	import rough from 'roughjs';

	let { children }: { children: Snippet } = $props();

	let container: HTMLDivElement;
	let canvas: HTMLCanvasElement;

	function draw() {
		if (!canvas || !container) return;

		const rect = container.getBoundingClientRect();
		const dpr = window.devicePixelRatio || 1;

		canvas.width = rect.width * dpr;
		canvas.height = rect.height * dpr;
		canvas.style.width = rect.width + 'px';
		canvas.style.height = rect.height + 'px';

		const ctx = canvas.getContext('2d');
		if (!ctx) return;

		ctx.scale(dpr, dpr);
		ctx.clearRect(0, 0, rect.width, rect.height);

		const rc = rough.canvas(canvas);
		rc.rectangle(4, 4, rect.width - 8, rect.height - 8, {
			roughness: 1.5,
			bowing: 2,
			stroke: '#333',
			strokeWidth: 1.5
		});
	}

	onMount(() => {
		draw();

		const observer = new ResizeObserver(() => draw());
		observer.observe(container);

		return () => observer.disconnect();
	});
</script>

<div class="rough-border-wrapper" bind:this={container}>
	<canvas bind:this={canvas} class="rough-canvas"></canvas>
	<div class="rough-content">
		{@render children()}
	</div>
</div>

<style>
	.rough-border-wrapper {
		position: relative;
		background: var(--card-bg);
	}

	.rough-canvas {
		position: absolute;
		top: 0;
		left: 0;
		pointer-events: none;
	}

	.rough-content {
		position: relative;
		padding: 20px;
	}
</style>
