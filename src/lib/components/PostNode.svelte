<script lang="ts">
	import { browser } from '$app/environment';
	import {
		fetchHydratedPostViewByUri,
		fetchRecordEmbedStatusByUri,
		peekCachedRecordEmbedByUri
	} from '$lib/api/bluesky';
	import { openLightbox } from '$lib/stores/lightbox';
	import { observeElementOnceVisible, scheduleDeferredBrowserTask } from '$lib/utils/browserTasks';
	import {
		hasRenderableRecordEmbedContent,
		mergeRecordEmbed,
		type RecordEmbed as RecordEmbedValue
	} from '$lib/utils/recordEmbed';
	import type { ThreadPost } from '$lib/types';
	import LinkedPostEmbeds from './LinkedPostEmbeds.svelte';
	import PostNode from './PostNode.svelte';

	let {
		post,
		level = 0,
		highlightedPostUri = null
	}: {
		post: ThreadPost;
		level?: number;
		highlightedPostUri?: string | null;
	} = $props();
	const MAX_VISIBLE_DEPTH = 5;
	const POST_HYDRATION_ENABLED = true;
	let hydratedPost = $state<ThreadPost | null>(null);
	let shouldHydratePost = $state(false);
	let postContentEl = $state<HTMLDivElement | null>(null);
	const needsPostHydration = $derived(Boolean(POST_HYDRATION_ENABLED && post.needsHydratedPostView));
	const displayPost = $derived.by(() => {
		if (!hydratedPost) return post;

		return {
			...post,
			...hydratedPost,
			author: {
				did: hydratedPost.author.did || post.author.did,
				handle: hydratedPost.author.handle || post.author.handle,
				displayName: hydratedPost.author.displayName || post.author.displayName,
				avatar: hydratedPost.author.avatar || post.author.avatar
			},
			text: hydratedPost.text || post.text,
			createdAt: hydratedPost.createdAt || post.createdAt,
			linkedUrls:
				hydratedPost.linkedUrls && hydratedPost.linkedUrls.length > 0
					? hydratedPost.linkedUrls
					: post.linkedUrls,
			embed: hydratedPost.embed ?? post.embed,
			parentUri: hydratedPost.parentUri ?? post.parentUri,
			children: post.children,
			needsHydratedPostView: false
		} satisfies ThreadPost;
	});
	const embeddedRecord = $derived(displayPost.embed?.record ?? null);
	const isSimilarityMatch = $derived(highlightedPostUri !== null && post.uri === highlightedPostUri);
	let hydratedRecord = $state<RecordEmbedValue | null>(null);
	let isHydratingRecord = $state(false);
	let isRecordUnavailable = $state(false);
	let shouldHydrateRecord = $state(false);
	let recordContainerEl = $state<HTMLDivElement | null>(null);
	const displayRecord = $derived(hydratedRecord ?? embeddedRecord);

	function formatDate(iso: string): string {
		const d = new Date(iso);
		return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
	}

	function postUrl(uri: string, handle: string): string {
		const rkey = uri.split('/').pop();
		return `https://bsky.app/profile/${handle}/post/${rkey}`;
	}

	const childIndent = $derived(level < MAX_VISIBLE_DEPTH ? 24 : 0);
	const compressChildren = $derived(level >= MAX_VISIBLE_DEPTH);

	$effect(() => {
		post.uri;
		hydratedPost = null;
		shouldHydratePost = false;
	});

	$effect(() => {
		if (!browser || !needsPostHydration || hydratedPost) {
			shouldHydratePost = false;
			return;
		}

		return observeElementOnceVisible(postContentEl, () => {
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
					if (!cancelled && fetched) {
						hydratedPost = fetched;
					}
				})
				.catch(() => {});
		});

		return () => {
			cancelled = true;
			cancelDeferredTask();
		};
	});

	$effect(() => {
		embeddedRecord;
		hydratedRecord = null;
		isRecordUnavailable = false;
		shouldHydrateRecord = false;
	});

	$effect(() => {
		const record = embeddedRecord;

		if (!browser || !record?.uri || hasRenderableRecordEmbedContent(record)) {
			shouldHydrateRecord = false;
			return;
		}

		const cached = peekCachedRecordEmbedByUri(record.uri);
		if (cached !== undefined) {
			shouldHydrateRecord = true;
			return;
		}

		return observeElementOnceVisible(recordContainerEl, () => {
			shouldHydrateRecord = true;
		});
	});

	$effect(() => {
		let cancelled = false;
		const record = embeddedRecord;

		if (
			!browser ||
			!record?.uri ||
			!shouldHydrateRecord ||
			hasRenderableRecordEmbedContent(record)
		) {
			isHydratingRecord = false;
			isRecordUnavailable = false;
			return;
		}

		isHydratingRecord = true;
		const cached = peekCachedRecordEmbedByUri(record.uri);
		if (cached !== undefined) {
			isHydratingRecord = false;
			isRecordUnavailable = cached === null;
			if (cached) {
				hydratedRecord = mergeRecordEmbed(record, cached);
			}
			return;
		}

		const cancelDeferredTask = scheduleDeferredBrowserTask(() => {
			void fetchRecordEmbedStatusByUri(record.uri)
				.then(({ record: fetched, unavailable }) => {
					if (cancelled) return;
					isHydratingRecord = false;
					isRecordUnavailable = unavailable;
					if (fetched) {
						hydratedRecord = mergeRecordEmbed(record, fetched);
					}
				})
				.catch(() => {
					if (!cancelled) {
						isHydratingRecord = false;
					}
				});
		});

		return () => {
			cancelled = true;
			cancelDeferredTask();
		};
	});
</script>

<div class="post-node">
	<div class="post-content" class:similarity-highlight={isSimilarityMatch} bind:this={postContentEl}>
		<div class="post-header">
			{#if displayPost.author.avatar}
				<img src={displayPost.author.avatar} alt="" class="post-avatar" />
			{/if}
			<a href={postUrl(displayPost.uri, displayPost.author.handle)} target="_blank" rel="noopener" class="post-author-link">
				<span class="post-author">{displayPost.author.displayName || displayPost.author.handle}</span>
				<span class="post-handle">@{displayPost.author.handle}</span>
				<span class="post-date">{formatDate(displayPost.createdAt)}</span>
				{#if isSimilarityMatch}
					<span class="similarity-badge">Best match</span>
				{/if}
			</a>
		</div>
		<p class="post-text">{displayPost.text}</p>
		{#if displayPost.embed?.images}
			<div class="post-images">
				{#each displayPost.embed.images as img}
					<img src={img.thumb} alt={img.alt} class="embed-thumb"
					 onclick={(e) => { e.stopPropagation(); openLightbox(img.fullsize); }}
					 onkeydown={(e) => { if (e.key === 'Enter') openLightbox(img.fullsize); }}
					 role="button" tabindex="0" style="cursor: pointer;" />
				{/each}
			</div>
		{/if}
		{#if displayPost.embed?.video}
			<div class="post-video">
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
			<a href={displayPost.embed.external.uri} target="_blank" rel="noopener" class="embed-link wobbly-border-light">
				{#if displayPost.embed.external.thumb}
					<img src={displayPost.embed.external.thumb} alt="" class="embed-link-thumb" />
				{/if}
				<div class="embed-link-text">
					<strong>{displayPost.embed.external.title}</strong>
					<span>{displayPost.embed.external.description}</span>
				</div>
			</a>
		{/if}
		{#if displayRecord}
			<div class="embed-quote" bind:this={recordContainerEl}>
				<div class="embed-quote-header">
					{#if displayRecord.author.avatar}
						<img src={displayRecord.author.avatar} alt="" class="embed-quote-avatar" />
					{/if}
					<span class="embed-quote-author">
						{displayRecord.author.displayName || displayRecord.author.handle}
					</span>
					<span class="embed-quote-handle">@{displayRecord.author.handle}</span>
				</div>
				{#if displayRecord.text}
					<p class="embed-quote-text">{displayRecord.text}</p>
				{:else if isHydratingRecord}
					<p class="embed-quote-placeholder">Loading quoted post...</p>
				{:else if isRecordUnavailable}
					<p class="embed-quote-placeholder">Quoted post not available.</p>
				{/if}
				{#if displayRecord.images}
					<div class="embed-images">
						{#each displayRecord.images as img}
							<img src={img.thumb} alt={img.alt} class="embed-image"
								onclick={(e) => { e.stopPropagation(); openLightbox(img.fullsize); }}
								onkeydown={(e) => { if (e.key === 'Enter') openLightbox(img.fullsize); }}
								role="button" tabindex="0" style="cursor: pointer;" />
						{/each}
					</div>
				{/if}
			</div>
		{/if}
		<LinkedPostEmbeds
			text={displayPost.text}
			externalUri={displayPost.embed?.external?.uri}
			urls={displayPost.linkedUrls ?? []}
			excludeUris={[displayPost.uri, displayPost.embed?.record?.uri ?? '']}
		/>
		<div class="post-stats">
			<span>{displayPost.likeCount} likes</span>
			<span>{displayPost.repostCount} reposts</span>
			<span>{displayPost.replyCount} replies</span>
		</div>
	</div>

	{#if displayPost.children.length > 0}
		<div class="post-children" class:stacked={compressChildren} style={`--child-indent: ${childIndent}px`}>
			{#each displayPost.children as child}
				<div class="post-child" class:stacked={compressChildren}>
					<PostNode post={child} level={level + 1} {highlightedPostUri} />
				</div>
			{/each}
		</div>
	{/if}
</div>

<style>
	.post-node {
		position: relative;
		margin-bottom: 8px;
	}

	.post-children {
		position: relative;
		margin-top: 6px;
		padding-left: var(--child-indent, 24px);
	}

	.post-children::before {
		content: '';
		position: absolute;
		top: 0;
		bottom: 10px;
		left: calc((var(--child-indent, 24px) / 2) - 1px);
		width: 2px;
		background: var(--muted);
		opacity: 0.32;
		z-index: 0;
	}

	.post-child {
		position: relative;
	}

	.post-child::before {
		content: '';
		position: absolute;
		top: 18px;
		left: calc((var(--child-indent, 24px) / 2) - 1px);
		width: calc((var(--child-indent, 24px) / 2) + 1px);
		height: 2px;
		background: var(--muted);
		opacity: 0.5;
		z-index: 0;
	}


	.post-children.stacked {
		padding-left: 0;
	}

	.post-children.stacked::before,
	.post-child.stacked::before {
		display: none;
	}

	.post-content {
		padding: 8px 12px;
		border-left: 2px solid var(--accent-light);
		background: var(--card-bg, #fffcf5);
		position: relative;
		z-index: 1;
	}

	.post-content.similarity-highlight {
		border-left-color: var(--accent);
		background:
			linear-gradient(135deg, rgba(217, 119, 6, 0.15), rgba(217, 119, 6, 0.03) 45%),
			var(--card-bg, #fffcf5);
		box-shadow: inset 0 0 0 1px rgba(217, 119, 6, 0.24);
	}

	.post-header {
		display: flex;
		align-items: center;
		gap: 6px;
		margin-bottom: 4px;
	}

	.post-avatar {
		width: 20px;
		height: 20px;
		border-radius: 50%;
		flex-shrink: 0;
	}

	.post-author-link {
		display: flex;
		align-items: baseline;
		gap: 4px;
		text-decoration: none;
		color: inherit;
		flex-wrap: wrap;
	}

	.post-author {
		font-size: 0.9rem;
		font-weight: 600;
	}

	.post-handle {
		font-size: 0.8rem;
		color: var(--muted);
	}

	.post-date {
		font-size: 0.85rem;
		color: var(--muted);
	}

	.similarity-badge {
		display: inline-flex;
		align-items: center;
		padding: 1px 8px;
		border-radius: 999px;
		background: rgba(217, 119, 6, 0.14);
		color: #9a3412;
		font-size: 0.72rem;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}

	.post-text {
		font-size: 1rem;
		white-space: pre-wrap;
		word-break: break-word;
		margin-bottom: 6px;
	}

	.post-stats {
		display: flex;
		gap: 16px;
		font-size: 0.8rem;
		color: var(--muted);
	}

	.post-images {
		display: flex;
		gap: 8px;
		flex-wrap: wrap;
		margin-bottom: 6px;
	}

	.embed-thumb {
		max-width: 200px;
		max-height: 150px;
		border-radius: 8px;
		object-fit: cover;
	}

	.post-video {
		margin-bottom: 6px;
	}

	.post-video video {
		max-width: 100%;
		max-height: 400px;
		border-radius: 8px;
		background: #000;
	}

	.video-alt {
		font-size: 0.8rem;
		color: var(--muted);
		margin: 2px 0 0;
	}

	.embed-link {
		display: flex;
		gap: 10px;
		padding: 8px;
		margin-bottom: 6px;
		text-decoration: none;
		color: inherit;
		background: var(--bg-paper);
	}

	.embed-link-thumb {
		width: 60px;
		height: 60px;
		object-fit: cover;
		border-radius: 4px;
	}

	.embed-link-text {
		display: flex;
		flex-direction: column;
		gap: 2px;
		font-size: 0.85rem;
	}

	.embed-images {
		display: flex;
		gap: 4px;
		flex-wrap: wrap;
	}

	.embed-image {
		max-width: 200px;
		max-height: 200px;
		border-radius: 6px;
		object-fit: cover;
	}

	.embed-quote {
		background: #f0ede8;
		border: 1px solid #d4d0c8;
		border-radius: 8px;
		padding: 8px 10px;
		margin-top: 4px;
		margin-bottom: 6px;
	}

	.embed-quote-header {
		display: flex;
		align-items: center;
		gap: 6px;
		margin-bottom: 4px;
	}

	.embed-quote-avatar {
		width: 18px;
		height: 18px;
		border-radius: 50%;
	}

	.embed-quote-author {
		font-weight: bold;
		font-size: 0.8rem;
		color: #333;
	}

	.embed-quote-handle {
		font-size: 0.7rem;
		color: #888;
	}

	.embed-quote-text {
		font-size: 0.85rem;
		line-height: 1.35;
		color: #444;
		white-space: pre-wrap;
		margin: 0 0 4px;
	}

	.embed-quote-placeholder {
		font-size: 0.82rem;
		line-height: 1.35;
		color: var(--muted);
		font-style: italic;
		margin: 0 0 4px;
	}

	@media (max-width: 600px) {
		.post-children {
			padding-left: 18px;
		}

		.post-children::before,
		.post-child::before {
			left: 8px;
		}

		.post-child::before {
			width: 10px;
		}

		.post-children.stacked {
			padding-left: 0;
		}

		.post-content {
			padding: 6px 8px;
		}
	}
</style>
