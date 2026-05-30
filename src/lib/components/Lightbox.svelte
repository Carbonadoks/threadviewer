<script lang="ts">
	import { lightbox, closeLightbox, type LightboxState } from '$lib/stores/lightbox';
	import { onMount } from 'svelte';

	let state: LightboxState | null = $state(null);
	let showAlt = $state(false);

	const hasAlt = $derived(Boolean(state?.alt?.trim()));

	onMount(() => {
		const unsub = lightbox.subscribe((value) => {
			state = value;
			showAlt = false;
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

{#if state}
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

		<figure class="lightbox-figure">
			<img src={state.src} alt={state.alt} class="lightbox-image" />

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

				{#if showAlt}
					<figcaption class="lightbox-alt-text">{state.alt}</figcaption>
				{/if}
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
		max-width: 90vw;
		max-height: 90vh;
		object-fit: contain;
		border-radius: 4px;
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

	.lightbox-alt-text {
		margin: 10px 0 0;
		max-width: min(90vw, 720px);
		max-height: 28vh;
		overflow-y: auto;
		background: rgba(0, 0, 0, 0.7);
		color: #f2f2f2;
		font-family: var(--app-font, inherit);
		font-size: 0.9rem;
		line-height: 1.45;
		padding: 10px 14px;
		border-radius: 8px;
		white-space: pre-wrap;
		text-align: left;
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
