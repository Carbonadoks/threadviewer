<script lang="ts">
	import type { DiscoverProgress } from '$lib/types';

	let { progress }: { progress: DiscoverProgress } = $props();
	const progressPercent = $derived.by(() => {
		if (progress.total <= 0) return 0;
		return Math.max(0, Math.min(100, (progress.current / progress.total) * 100));
	});
</script>

<div class="loading">
	<div class="spinner"></div>
	<p class="phase">{progress.phase}</p>
	{#if progress.total > 0}
		<div class="progress-track" aria-hidden="true">
			<div class="progress-fill" style={`width: ${progressPercent}%`}></div>
		</div>
		<p class="count">{progress.current.toLocaleString()} / {progress.total.toLocaleString()}</p>
	{:else if progress.current > 0 && !progress.detail}
		<p class="count">{progress.current.toLocaleString()} posts found</p>
	{/if}
	{#if progress.detail}
		<p class="detail">{progress.detail}</p>
	{/if}
</div>

<style>
	.loading {
		text-align: center;
		padding: 48px 24px;
	}

	.spinner {
		width: 48px;
		height: 48px;
		border: 3px solid var(--accent-light);
		border-top-color: var(--accent);
		border-radius: 50%;
		animation: spin 0.8s linear infinite;
		margin: 0 auto 16px;
	}

	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}

	.phase {
		font-size: 1.2rem;
		margin-bottom: 4px;
	}

	.progress-track {
		width: min(360px, 100%);
		height: 10px;
		margin: 14px auto 10px;
		border-radius: 999px;
		background: var(--muted-surface);
		overflow: hidden;
	}

	.progress-fill {
		height: 100%;
		border-radius: 999px;
		background: linear-gradient(
			90deg,
			var(--accent),
			color-mix(in srgb, var(--accent) 56%, var(--card-bg))
		);
		transition: width 0.2s ease;
	}

	.count {
		font-size: 1rem;
		color: var(--muted);
	}

	.detail {
		max-width: 560px;
		margin: 8px auto 0;
		font-size: 0.95rem;
		line-height: 1.45;
		color: var(--muted);
	}
</style>
