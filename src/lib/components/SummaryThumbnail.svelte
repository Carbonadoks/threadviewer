<script lang="ts">
	import type { CachedUserSummaryThumbnail } from '$lib/types';

	export let thumbnail: CachedUserSummaryThumbnail | null | undefined = null;
</script>

{#if thumbnail?.url}
	<div class="summary-thumbnail">
		<img src={thumbnail.url} alt={thumbnail.alt || ''} loading="lazy" />
	</div>
{/if}

<style>
	.summary-thumbnail {
		width: 68px;
		height: 68px;
		border-radius: 14px;
		overflow: hidden;
		flex-shrink: 0;
		background:
			linear-gradient(145deg, rgba(255, 255, 255, 0.86), rgba(242, 236, 225, 0.82));
		border: 1px solid rgba(61, 64, 91, 0.08);
		box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.55);
	}

	.summary-thumbnail img {
		display: block;
		width: 100%;
		height: 100%;
		object-fit: cover;
	}
</style>
