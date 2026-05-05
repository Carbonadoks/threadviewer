<script lang="ts">
	import { onMount } from 'svelte';
	import type { ThreadJudgeCacheEntry } from '$lib/types';
	import { threadJudgeModelLabel } from '$lib/utils/judgeModels';

	let { onselect }: { onselect: (threadUrl: string, model: string) => void } = $props();

	let loading = $state(true);
	let loaded = $state(false);
	let threads: ThreadJudgeCacheEntry[] = $state([]);

	function formatUpdatedAt(value: string): string {
		const parsed = new Date(value);
		if (Number.isNaN(parsed.getTime())) {
			return 'Unknown update';
		}

		return parsed.toLocaleString([], {
			year: 'numeric',
			month: 'short',
			day: 'numeric',
			hour: '2-digit',
			minute: '2-digit'
		});
	}

	async function load() {
		loading = true;
		try {
			const response = await fetch('/api/thread/judge/cache-index');
			if (!response.ok) return;
			const payload = (await response.json().catch(() => null)) as
				| { threads?: ThreadJudgeCacheEntry[] }
				| null;
			threads = Array.isArray(payload?.threads) ? payload.threads : [];
		} catch {
			threads = [];
		} finally {
			loading = false;
			loaded = true;
		}
	}

	onMount(() => {
		load();
	});
</script>

<section class="cached-judgments wobbly-border-light">
	<div class="cached-head">
		<div>
			<h2>Cached Judges</h2>
			<p>Previously judged threads saved in R2.</p>
		</div>
		<button type="button" class="refresh-btn" onclick={load} disabled={loading}>
			Refresh
		</button>
	</div>

	{#if loading && !loaded}
		<p class="cached-empty">Loading cached judgments…</p>
	{:else if threads.length === 0}
		<p class="cached-empty">No cached judgments yet.</p>
	{:else}
		<div class="cached-grid">
				{#each threads as thread (`${thread.rootUri}:${thread.model}`)}
					<button
						type="button"
						class="cached-card"
						onclick={() => onselect(thread.threadUrl, thread.model)}
					>
					<div class="cached-card-top">
						<span class="cached-handle">@{thread.handle}</span>
						<span>{thread.postCount} posts</span>
					</div>
						<h3>{thread.title}</h3>
						<div class="cached-card-meta">
							<span>{threadJudgeModelLabel(thread.model)}</span>
							<span>{formatUpdatedAt(thread.updatedAt)}</span>
						</div>
					</button>
			{/each}
		</div>
	{/if}
</section>

<style>
	.cached-judgments {
		padding: 16px;
		background: rgba(255, 252, 245, 0.82);
		margin-bottom: 18px;
	}

	.cached-head {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 12px;
		margin-bottom: 12px;
	}

	.cached-head h2 {
		margin: 0;
		font-size: 1.1rem;
		color: var(--text-ink);
	}

	.cached-head p {
		margin: 4px 0 0;
		color: var(--muted);
		font-size: 0.9rem;
	}

	.refresh-btn {
		background: none;
		border: none;
		color: var(--accent);
		font-size: 0.9rem;
		font-family: inherit;
		cursor: pointer;
	}

	.refresh-btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.cached-empty {
		margin: 0;
		color: var(--muted);
	}

	.cached-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(230px, 1fr));
		gap: 10px;
	}

	.cached-card {
		display: grid;
		gap: 8px;
		padding: 12px 14px;
		background: rgba(255, 255, 255, 0.88);
		border: 1px solid rgba(61, 64, 91, 0.14);
		border-radius: 14px;
		text-align: left;
		font-family: inherit;
		cursor: pointer;
		color: var(--text-ink);
		transition:
			transform 0.16s ease,
			border-color 0.16s ease,
			box-shadow 0.16s ease;
	}

	.cached-card:hover {
		transform: translateY(-1px);
		border-color: rgba(224, 122, 95, 0.28);
		box-shadow: 0 12px 24px rgba(26, 35, 44, 0.08);
	}

	.cached-card-top,
	.cached-card-meta {
		display: flex;
		justify-content: space-between;
		gap: 8px;
		flex-wrap: wrap;
		font-size: 0.78rem;
		color: var(--muted);
	}

	.cached-handle {
		font-weight: 700;
		color: #7c5032;
	}

	.cached-card h3 {
		margin: 0;
		font-size: 0.96rem;
		line-height: 1.35;
	}

	@media (max-width: 640px) {
		.cached-head {
			flex-direction: column;
			align-items: flex-start;
		}
	}
</style>
