<script lang="ts">
	import { lightboxSrc, closeLightbox } from '$lib/stores/lightbox';
	import { onMount } from 'svelte';

	let src: string | null = $state(null);

	onMount(() => {
		const unsub = lightboxSrc.subscribe((value) => {
			src = value;
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

{#if src}
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
		<img src={src} alt="" class="lightbox-image" />
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

	.lightbox-image {
		max-width: 90vw;
		max-height: 90vh;
		object-fit: contain;
		border-radius: 4px;
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
