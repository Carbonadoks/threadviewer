<script lang="ts">
	import type { ThreadPost } from '$lib/types';
	import LinkedPostEmbeds from '$lib/components/LinkedPostEmbeds.svelte';
	import RecordEmbed from '$lib/components/RecordEmbed.svelte';
	import { openLightbox } from '$lib/stores/lightbox';

	type EmbedPreviewPost = Pick<ThreadPost, 'uri' | 'text' | 'linkedUrls' | 'embed'>;

	let {
		post,
		compact = false
	}: {
		post: EmbedPreviewPost;
		compact?: boolean;
	} = $props();

	const showLinkedEmbeds = $derived.by(() => {
		if ((post.linkedUrls?.length ?? 0) > 0) return true;
		if ((post.embed?.external?.uri ?? '').includes('bsky.app/profile/')) return true;
		return /https?:\/\/bsky\.app\/profile\//i.test(post.text);
	});

	const hasEmbeds = $derived.by(() => {
		return Boolean(
			(post.embed?.images?.length ?? 0) > 0 ||
			post.embed?.video ||
			post.embed?.external ||
			post.embed?.record ||
			showLinkedEmbeds
		);
	});
</script>

{#if hasEmbeds}
	<div class="post-embed-preview" class:compact>
		{#if post.embed?.images}
			<div class="embed-images">
				{#each post.embed.images as img}
					<button
						type="button"
						class="image-button"
						onclick={() => {
							openLightbox(img.fullsize);
						}}
					>
						<img src={img.thumb} alt={img.alt} class="embed-image" />
					</button>
				{/each}
			</div>
		{/if}

		{#if post.embed?.video}
			<div class="embed-video">
				<!-- svelte-ignore a11y_media_has_caption -->
				<video
					controls
					preload="none"
					poster={post.embed.video.thumbnail}
					style={post.embed.video.aspectRatio ? `aspect-ratio: ${post.embed.video.aspectRatio.width} / ${post.embed.video.aspectRatio.height}` : ''}
				>
					<source src={post.embed.video.playlist} type="application/x-mpegURL" />
				</video>
				{#if post.embed.video.alt}
					<p class="video-alt">{post.embed.video.alt}</p>
				{/if}
			</div>
		{/if}

		{#if post.embed?.external}
			<a
				href={post.embed.external.uri}
				target="_blank"
				rel="noopener noreferrer"
				class="embed-link wobbly-border-light"
			>
				{#if post.embed.external.thumb}
					<img src={post.embed.external.thumb} alt="" class="embed-link-thumb" />
				{/if}
				<div class="embed-link-copy">
					<strong>{post.embed.external.title}</strong>
					<span>{post.embed.external.description}</span>
				</div>
			</a>
		{/if}

		{#if post.embed?.record}
			<RecordEmbed record={post.embed.record} dense />
		{/if}

		{#if showLinkedEmbeds}
			<LinkedPostEmbeds
				text={post.text}
				externalUri={post.embed?.external?.uri}
				urls={post.linkedUrls ?? []}
				excludeUris={[post.uri, post.embed?.record?.uri ?? '']}
			/>
		{/if}
	</div>
{/if}

<style>
	.post-embed-preview {
		display: grid;
		gap: 10px;
		margin-top: 10px;
	}

	.post-embed-preview.compact {
		gap: 8px;
		margin-top: 8px;
	}

	.embed-images {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}

	.image-button {
		padding: 0;
		border: 0;
		background: transparent;
		cursor: pointer;
	}

	.embed-image {
		width: 112px;
		max-width: 100%;
		max-height: 112px;
		border-radius: 12px;
		object-fit: cover;
		display: block;
		box-shadow: 0 8px 18px rgba(26, 35, 44, 0.12);
	}

	.embed-video video {
		width: 100%;
		border-radius: 14px;
		background: #000;
	}

	.video-alt {
		margin: 6px 0 0;
		font-size: 0.85rem;
		color: var(--muted);
	}

	.embed-link {
		display: grid;
		grid-template-columns: auto minmax(0, 1fr);
		gap: 10px;
		padding: 10px;
		color: inherit;
		text-decoration: none;
		background: rgba(255, 255, 255, 0.76);
	}

	.embed-link:hover {
		text-decoration: none;
	}

	.embed-link-thumb {
		width: 64px;
		height: 64px;
		border-radius: 10px;
		object-fit: cover;
	}

	.embed-link-copy {
		display: grid;
		gap: 4px;
		min-width: 0;
	}

	.embed-link-copy strong,
	.embed-link-copy span {
		overflow: hidden;
		text-overflow: ellipsis;
		word-break: break-word;
	}

	.embed-link-copy strong {
		font-size: 0.95rem;
	}

	.embed-link-copy span {
		font-size: 0.84rem;
		color: var(--muted);
		line-height: 1.4;
	}
</style>
