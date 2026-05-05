<script lang="ts">
	import { onMount } from 'svelte';
	import type { MatrixTerminalPost } from '$lib/components/MatrixFeedTerminal.svelte';

	let {
		post,
		onclose
	}: {
		post: MatrixTerminalPost;
		onclose: () => void;
	} = $props();

	function handleKeydown(event: KeyboardEvent) {
		if (event.key === 'Escape') {
			event.preventDefault();
			onclose();
		}
	}

	onMount(() => {
		window.addEventListener('keydown', handleKeydown);
		return () => {
			window.removeEventListener('keydown', handleKeydown);
		};
	});
</script>

<div
	class="matrix-post-preview"
	role="dialog"
	aria-modal="true"
	aria-label={`Preview of post by @${post.authorHandle}`}
	tabindex="-1"
>
	<button
		type="button"
		class="matrix-post-preview-backdrop"
		onclick={onclose}
		aria-label="Close post preview"
	></button>

	<article class="matrix-post-preview-card">
		<div class="matrix-post-preview-topline">
			<span class="preview-pill">Render Paused</span>
			<button type="button" class="preview-close" onclick={onclose} aria-label="Close post preview">
				Close
			</button>
		</div>

		<div class="matrix-post-preview-header">
			<div class="preview-identity">
				<span class="preview-handle">@{post.authorHandle}</span>
				<span class="preview-timestamp">{post.createdAtLabel}</span>
			</div>
			<span class="preview-meta">{post.metaLabel}</span>
		</div>

		<div class="matrix-post-preview-body">
			{post.body}
		</div>

		<div class="matrix-post-preview-actions">
			{#if post.permalink}
				<a href={post.permalink} target="_blank" rel="noreferrer">Open on Bluesky</a>
			{/if}
			<button type="button" class="preview-resume" onclick={onclose}>Resume stream</button>
		</div>
	</article>
</div>

<style>
	.matrix-post-preview {
		position: absolute;
		inset: 0;
		z-index: 16;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 20px;
		background:
			radial-gradient(circle at top, rgba(88, 255, 116, 0.1), transparent 30%),
			rgba(0, 0, 0, 0.72);
		backdrop-filter: blur(12px);
	}

	.matrix-post-preview-backdrop {
		position: absolute;
		inset: 0;
		border: 0;
		background: transparent;
		cursor: pointer;
	}

	.matrix-post-preview-card {
		position: relative;
		z-index: 1;
		display: grid;
		gap: 16px;
		width: min(760px, 100%);
		max-height: min(calc(100svh - 40px), 760px);
		overflow: auto;
		padding: 18px;
		border: 1px solid rgba(135, 255, 157, 0.22);
		border-radius: 20px;
		background:
			radial-gradient(circle at top, rgba(96, 255, 124, 0.08), transparent 34%),
			linear-gradient(180deg, rgba(5, 16, 9, 0.98), rgba(2, 7, 4, 0.995));
		box-shadow:
			inset 0 0 0 1px rgba(153, 255, 171, 0.08),
			0 24px 80px rgba(0, 0, 0, 0.52);
		color: #efffe5;
	}

	.matrix-post-preview-topline,
	.matrix-post-preview-header,
	.matrix-post-preview-actions {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		flex-wrap: wrap;
	}

	.preview-pill,
	.preview-meta,
	.preview-identity,
	.matrix-post-preview-actions a,
	.preview-close,
	.preview-resume {
		font-family: var(--font-matrix-ui);
		text-transform: uppercase;
		letter-spacing: 0.12em;
	}

	.preview-pill,
	.preview-meta {
		padding: 6px 9px;
		border: 1px solid rgba(138, 255, 161, 0.16);
		border-radius: 999px;
		background: rgba(4, 12, 6, 0.56);
		color: rgba(216, 255, 202, 0.82);
		font-size: 0.64rem;
	}

	.preview-close,
	.preview-resume,
	.matrix-post-preview-actions a {
		padding: 9px 12px;
		border: 1px solid rgba(138, 255, 161, 0.22);
		border-radius: 999px;
		background: rgba(7, 18, 10, 0.92);
		color: #eaffdf;
		font-size: 0.68rem;
		text-decoration: none;
		cursor: pointer;
	}

	.preview-close:hover,
	.preview-close:focus-visible,
	.preview-resume:hover,
	.preview-resume:focus-visible,
	.matrix-post-preview-actions a:hover,
	.matrix-post-preview-actions a:focus-visible {
		border-color: rgba(167, 255, 184, 0.44);
		background: rgba(10, 28, 14, 0.98);
	}

	.matrix-post-preview-header {
		align-items: flex-start;
	}

	.preview-identity {
		display: grid;
		gap: 4px;
	}

	.preview-handle {
		font-size: 1.02rem;
		color: #f4ffe6;
	}

	.preview-timestamp {
		font-size: 0.68rem;
		color: rgba(216, 255, 202, 0.72);
	}

	.matrix-post-preview-body {
		padding: 18px;
		border: 1px solid rgba(138, 255, 161, 0.12);
		border-radius: 16px;
		background: rgba(3, 10, 5, 0.58);
		color: #e8ffe0;
		font-family: var(--font-matrix-terminal);
		font-size: clamp(1rem, 1.1vw + 0.78rem, 1.3rem);
		line-height: 1.55;
		white-space: pre-wrap;
		word-break: break-word;
	}

	.matrix-post-preview-actions {
		justify-content: flex-end;
	}

	@media (max-width: 640px) {
		.matrix-post-preview {
			padding: 12px;
		}

		.matrix-post-preview-card {
			padding: 14px;
			border-radius: 16px;
		}

		.matrix-post-preview-body {
			padding: 14px;
		}
	}
</style>
