<script lang="ts">
	import { lightbox, closeLightbox, type LightboxState } from '$lib/stores/lightbox';
	import { onMount } from 'svelte';

	let lightboxState = $state<LightboxState | null>(null);
	let showAlt = $state(false);
	let viewMode = $state<'original' | 'mirror' | 'side-by-side'>('original');

	const hasAlt = $derived(Boolean(lightboxState?.alt?.trim()));
	const hasMirror = $derived(Boolean(lightboxState?.variants?.mirrorSrc));
	const displaySrc = $derived(
		viewMode === 'mirror' && lightboxState?.variants
			? lightboxState.variants.mirrorSrc
			: lightboxState?.variants?.originalSrc || lightboxState?.src || ''
	);

	onMount(() => {
		const unsub = lightbox.subscribe((value) => {
			lightboxState = value;
			showAlt = false;
			viewMode = value?.variants?.initialView === 'mirror' ? 'mirror' : 'original';
		});
		return unsub;
	});

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') closeLightbox();
	}

	function handleBackdropClick(e: MouseEvent) {
		if ((e.target as HTMLElement).classList.contains('lightbox-backdrop')) {
			closeLightbox();
		}
	}
</script>

<svelte:window onkeydown={handleKeydown} />

{#if lightboxState}
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<!-- svelte-ignore a11y_interactive_supports_focus -->
	<div
		class="lightbox-backdrop"
		onclick={handleBackdropClick}
		role="dialog"
		aria-modal="true"
		aria-label="Image lightbox"
	>
		<button class="lightbox-close" onclick={closeLightbox} aria-label="Close lightbox">&times;</button>

		<figure class="lightbox-figure" class:alt-open={showAlt}>
			<div class="lightbox-image-shell" class:side-by-side={viewMode === 'side-by-side'}>
				{#if viewMode === 'side-by-side' && lightboxState.variants}
					<div class="lightbox-side-pane">
						<span>Original</span>
						<img src={lightboxState.variants.originalSrc} alt={lightboxState.alt} class="lightbox-image" />
					</div>
					<div class="lightbox-side-pane">
						<span>Mirror</span>
						<img src={lightboxState.variants.mirrorSrc} alt={lightboxState.alt} class="lightbox-image" />
					</div>
				{:else}
					<img src={displaySrc} alt={lightboxState.alt} class="lightbox-image" />
				{/if}

				{#if hasMirror}
					<div class="lightbox-view-controls" aria-label="Image version">
						{#each ['original', 'mirror', 'side-by-side'] as mode}
							<button
								type="button"
								class:active={viewMode === mode}
								onclick={(event) => {
									event.stopPropagation();
									viewMode = mode as typeof viewMode;
								}}
							>
								{mode === 'side-by-side' ? 'Side by side' : mode === 'original' ? 'Original' : 'Mirror'}
							</button>
						{/each}
					</div>
				{/if}

				{#if hasAlt}
					<button
						type="button"
						class="lightbox-alt-toggle"
						aria-expanded={showAlt}
						onclick={(e) => {
							e.stopPropagation();
							showAlt = !showAlt;
						}}
					>
						ALT
					</button>
				{/if}
			</div>

			{#if hasAlt && showAlt}
				<figcaption class="lightbox-alt-text">{lightboxState.alt}</figcaption>
			{/if}
		</figure>
	</div>
{/if}

<style>
	.lightbox-backdrop {
		position: fixed;
		inset: 0;
		background: rgba(0, 0, 0, 0.85);
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: 9999;
		animation: lightbox-fade-in 0.2s ease-out;
	}

	@keyframes lightbox-fade-in {
		from { opacity: 0; }
		to { opacity: 1; }
	}

	.lightbox-figure {
		position: relative;
		margin: 0;
		display: flex;
		flex-direction: column;
		align-items: center;
		max-width: 90vw;
		max-height: 90vh;
	}

	.lightbox-image {
		display: block;
		max-width: 90vw;
		max-height: 90vh;
		object-fit: contain;
		border-radius: 4px;
	}

	.lightbox-image-shell {
		position: relative;
		display: flex;
		max-width: 90vw;
		max-height: 90vh;
	}

	.lightbox-image-shell.side-by-side {
		width: min(94vw, 1500px);
		gap: 12px;
		align-items: stretch;
		justify-content: center;
	}

	.lightbox-side-pane {
		position: relative;
		display: flex;
		flex: 1 1 0;
		align-items: center;
		justify-content: center;
		min-width: 0;
		max-height: 90vh;
		padding-top: 28px;
	}

	.lightbox-side-pane > span {
		position: absolute;
		top: 4px;
		left: 50%;
		transform: translateX(-50%);
		color: #fff;
		font-size: 0.78rem;
		font-weight: 800;
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}

	.lightbox-image-shell.side-by-side .lightbox-image {
		max-width: 100%;
		max-height: calc(90vh - 28px);
	}

	.lightbox-figure.alt-open .lightbox-image {
		max-height: 58vh;
	}

	.lightbox-alt-toggle {
		position: absolute;
		bottom: 12px;
		left: 12px;
		background: rgba(0, 0, 0, 0.7);
		color: white;
		border: 1px solid rgba(255, 255, 255, 0.5);
		border-radius: 6px;
		font-size: 0.72rem;
		font-weight: 700;
		letter-spacing: 0.04em;
		padding: 3px 8px;
		cursor: pointer;
		opacity: 0.85;
		transition: opacity 0.15s;
	}

	.lightbox-alt-toggle:hover,
	.lightbox-alt-toggle[aria-expanded='true'] {
		opacity: 1;
	}

	.lightbox-view-controls {
		position: absolute;
		top: 12px;
		left: 12px;
		z-index: 2;
		display: flex;
		overflow: hidden;
		border: 1px solid rgba(255, 255, 255, 0.6);
		border-radius: 999px;
		background: rgba(0, 0, 0, 0.72);
	}

	.lightbox-view-controls button {
		padding: 5px 10px;
		border: none;
		border-right: 1px solid rgba(255, 255, 255, 0.25);
		background: transparent;
		color: white;
		font: inherit;
		font-size: 0.75rem;
		font-weight: 800;
		cursor: pointer;
	}

	.lightbox-view-controls button:last-child {
		border-right: none;
	}

	.lightbox-view-controls button:hover,
	.lightbox-view-controls button:focus-visible,
	.lightbox-view-controls button.active {
		background: var(--accent, #6553c7);
	}

	@media (max-width: 700px) {
		.lightbox-image-shell.side-by-side {
			flex-direction: column;
			max-height: 82vh;
		}

		.lightbox-side-pane {
			max-height: 40vh;
		}

		.lightbox-image-shell.side-by-side .lightbox-image {
			max-height: calc(40vh - 28px);
		}
	}

	.lightbox-alt-text {
		margin: 10px 0 0;
		width: min(90vw, 820px);
		max-width: min(90vw, 720px);
		max-height: 30vh;
		min-height: 0;
		overflow: auto;
		box-sizing: border-box;
		overscroll-behavior: contain;
		scrollbar-gutter: stable;
		background: rgba(0, 0, 0, 0.7);
		color: #f2f2f2;
		font-family: var(--app-font, inherit);
		font-size: 0.9rem;
		line-height: 1.45;
		padding: 10px 14px;
		border-radius: 8px;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
		text-align: left;
	}

	@media (min-width: 900px) {
		.lightbox-alt-text {
			width: min(72vw, 820px);
			max-width: none;
			padding: 16px 20px;
			font-size: 1rem;
			line-height: 1.55;
		}
	}

	.lightbox-close {
		position: absolute;
		top: 16px;
		right: 16px;
		background: none;
		border: none;
		color: white;
		font-size: 2rem;
		cursor: pointer;
		line-height: 1;
		padding: 4px 12px;
		opacity: 0.8;
		transition: opacity 0.15s;
	}

	.lightbox-close:hover {
		opacity: 1;
	}
</style>
