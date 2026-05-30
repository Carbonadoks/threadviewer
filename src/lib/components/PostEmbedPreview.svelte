<script lang="ts">
	import { browser } from '$app/environment';
	import { fetchHydratedPostViewByUri } from '$lib/api/bluesky';
	import type { ThreadPost } from '$lib/types';
	import LinkedPostEmbeds from '$lib/components/LinkedPostEmbeds.svelte';
	import RecordEmbed from '$lib/components/RecordEmbed.svelte';
	import { openLightbox } from '$lib/stores/lightbox';
	import { observeElementOnceVisible, scheduleDeferredBrowserTask } from '$lib/utils/browserTasks';

	type EmbedPreviewPost = Pick<
		ThreadPost,
		'uri' | 'text' | 'linkedUrls' | 'embed' | 'needsHydratedPostView'
	>;

	let {
		post,
		compact = false,
		wide = false,
		eager = false
	}: {
		post: EmbedPreviewPost;
		compact?: boolean;
		wide?: boolean;
		eager?: boolean;
	} = $props();

	let hydratedPost = $state<ThreadPost | null>(null);
	let shouldHydratePost = $state(false);
	let postHydrationDone = $state(false);
	let previewEl = $state<HTMLDivElement | null>(null);

	const displayPost = $derived.by(() => {
		if (!hydratedPost) return post;
		return {
			...post,
			...hydratedPost,
			text: hydratedPost.text || post.text,
			linkedUrls:
				hydratedPost.linkedUrls && hydratedPost.linkedUrls.length > 0
					? hydratedPost.linkedUrls
					: post.linkedUrls,
			embed: hydratedPost.embed ?? post.embed,
			needsHydratedPostView: false
		};
	});
	const needsPostHydration = $derived(
		Boolean(post.needsHydratedPostView && !post.embed && !postHydrationDone)
	);

	const showLinkedEmbeds = $derived.by(() => {
		if ((displayPost.linkedUrls?.length ?? 0) > 0) return true;
		if ((displayPost.embed?.external?.uri ?? '').includes('bsky.app/profile/')) return true;
		return /https?:\/\/bsky\.app\/profile\//i.test(displayPost.text);
	});

	const hasRenderableEmbeds = $derived.by(() => {
		return Boolean(
			(displayPost.embed?.images?.length ?? 0) > 0 ||
			displayPost.embed?.video ||
			displayPost.embed?.external ||
			displayPost.embed?.record ||
			showLinkedEmbeds
		);
	});
	const hasEmbeds = $derived(hasRenderableEmbeds || needsPostHydration);

	$effect(() => {
		post.uri;
		hydratedPost = null;
		shouldHydratePost = false;
		postHydrationDone = false;
	});

	$effect(() => {
		if (!browser || !needsPostHydration || hydratedPost) {
			shouldHydratePost = false;
			return;
		}

		if (eager) {
			shouldHydratePost = true;
			return;
		}

		return observeElementOnceVisible(previewEl, () => {
			shouldHydratePost = true;
		});
	});

	$effect(() => {
		let cancelled = false;

		if (!browser || !needsPostHydration || !shouldHydratePost || hydratedPost) {
			return;
		}

		const cancelDeferredTask = scheduleDeferredBrowserTask(() => {
			void fetchHydratedPostViewByUri(post.uri)
				.then((fetched) => {
					if (cancelled) return;
					if (fetched) {
						hydratedPost = fetched;
					}
					postHydrationDone = true;
				})
				.catch(() => {
					if (!cancelled) {
						postHydrationDone = true;
					}
				});
		});

		return () => {
			cancelled = true;
			cancelDeferredTask();
		};
	});
</script>

{#if hasEmbeds}
	<div class="post-embed-preview" class:compact class:wide bind:this={previewEl}>
		{#if needsPostHydration && !displayPost.embed}
			<p class="embed-loading">Loading media...</p>
		{/if}

		{#if displayPost.embed?.images}
			<div class="embed-images">
				{#each displayPost.embed.images as img}
					<button
						type="button"
						class="image-button"
						onclick={() => {
							openLightbox(img.fullsize, img.alt);
						}}
					>
						<img src={wide ? img.fullsize : img.thumb} alt={img.alt} class="embed-image" />
					</button>
				{/each}
			</div>
		{/if}

		{#if displayPost.embed?.video}
			<div class="embed-video">
				<!-- svelte-ignore a11y_media_has_caption -->
				<video
					controls
					preload="none"
					poster={displayPost.embed.video.thumbnail}
					style={displayPost.embed.video.aspectRatio ? `aspect-ratio: ${displayPost.embed.video.aspectRatio.width} / ${displayPost.embed.video.aspectRatio.height}` : ''}
				>
					<source src={displayPost.embed.video.playlist} type="application/x-mpegURL" />
				</video>
				{#if displayPost.embed.video.alt}
					<p class="video-alt">{displayPost.embed.video.alt}</p>
				{/if}
			</div>
		{/if}

		{#if displayPost.embed?.external}
			<a
				href={displayPost.embed.external.uri}
				target="_blank"
				rel="noopener noreferrer"
				class="embed-link wobbly-border-light"
			>
				{#if displayPost.embed.external.thumb}
					<img src={displayPost.embed.external.thumb} alt="" class="embed-link-thumb" />
				{/if}
				<div class="embed-link-copy">
					<strong>{displayPost.embed.external.title}</strong>
					<span>{displayPost.embed.external.description}</span>
				</div>
			</a>
		{/if}

		{#if displayPost.embed?.record}
			<RecordEmbed record={displayPost.embed.record} dense {eager} />
		{/if}

		{#if showLinkedEmbeds}
			<LinkedPostEmbeds
				text={displayPost.text}
				externalUri={displayPost.embed?.external?.uri}
				urls={displayPost.linkedUrls ?? []}
				excludeUris={[displayPost.uri, displayPost.embed?.record?.uri ?? '']}
				{eager}
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

	.post-embed-preview.wide {
		gap: 14px;
		width: 100%;
		margin-top: 1.25em;
	}

	.embed-loading {
		margin: 0;
		color: var(--muted);
		font-size: 0.84rem;
	}

	.embed-images {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}

	.post-embed-preview.wide .embed-images {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(min(100%, 240px), 1fr));
		gap: 12px;
		width: 100%;
	}

	.image-button {
		padding: 0;
		border: 0;
		background: transparent;
		cursor: pointer;
	}

	.post-embed-preview.wide .image-button {
		width: 100%;
		min-width: 0;
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

	.post-embed-preview.wide .embed-image {
		width: 100%;
		max-width: none;
		max-height: min(72vh, 680px);
		border-radius: 14px;
		object-fit: contain;
		background: color-mix(in srgb, var(--card-bg) 86%, #000 14%);
	}

	.embed-video video {
		width: 100%;
		border-radius: 14px;
		background: #000;
	}

	.post-embed-preview.wide .embed-video video {
		max-height: min(72vh, 680px);
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

	.post-embed-preview.wide .embed-link {
		grid-template-columns: minmax(112px, 32%) minmax(0, 1fr);
		gap: 14px;
		padding: 14px;
	}

	.post-embed-preview.wide .embed-link-thumb {
		width: 100%;
		height: auto;
		aspect-ratio: 16 / 10;
		border-radius: 12px;
	}

	.post-embed-preview.wide :global(.record-embed) {
		padding: 12px 14px;
	}

	.post-embed-preview.wide :global(.record-images) {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(min(100%, 220px), 1fr));
		gap: 10px;
	}

	.post-embed-preview.wide :global(.record-image) {
		width: 100%;
		max-width: none;
		max-height: min(56vh, 520px);
		object-fit: contain;
		background: color-mix(in srgb, var(--card-bg) 86%, #000 14%);
	}

	@media (max-width: 560px) {
		.post-embed-preview.wide .embed-link {
			grid-template-columns: 1fr;
		}
	}
</style>
