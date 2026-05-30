<script lang="ts">
	import { browser } from '$app/environment';
	import { fetchRecordEmbedStatusByUri, peekCachedRecordEmbedByUri } from '$lib/api/bluesky';
	import { openLightbox } from '$lib/stores/lightbox';
	import { observeElementOnceVisible, scheduleDeferredBrowserTask } from '$lib/utils/browserTasks';
	import {
		hasRenderableRecordEmbedContent,
		mergeRecordEmbed,
		type RecordEmbed as RecordEmbedValue
	} from '$lib/utils/recordEmbed';
	import RecordEmbed from '$lib/components/RecordEmbed.svelte';

	let {
		record,
		dense = false,
		eager = false
	}: { record: RecordEmbedValue; dense?: boolean; eager?: boolean } = $props();
	let hydratedRecord = $state<RecordEmbedValue | null>(null);
	let isHydrating = $state(false);
	let isUnavailable = $state(false);
	let shouldHydrate = $state(false);
	let containerEl = $state<HTMLDivElement | null>(null);
	const displayRecord = $derived(hydratedRecord ?? record);

	function recordUrl(uri: string, handle: string): string {
		const rkey = uri.split('/').pop();
		return handle && rkey ? `https://bsky.app/profile/${handle}/post/${rkey}` : uri;
	}

	$effect(() => {
		hydratedRecord = null;
		isUnavailable = false;
		shouldHydrate = false;
	});

	$effect(() => {
		if (!browser || !record.uri || hasRenderableRecordEmbedContent(record)) {
			shouldHydrate = false;
			return;
		}

		const cached = peekCachedRecordEmbedByUri(record.uri);
		if (cached !== undefined || eager) {
			shouldHydrate = true;
			return;
		}

		return observeElementOnceVisible(containerEl, () => {
			shouldHydrate = true;
		});
	});

	$effect(() => {
		let cancelled = false;

		if (!browser || !record.uri || !shouldHydrate || hasRenderableRecordEmbedContent(record)) {
			isHydrating = false;
			isUnavailable = false;
			return;
		}

		isHydrating = true;
		const cached = peekCachedRecordEmbedByUri(record.uri);
		if (cached !== undefined) {
			isHydrating = false;
			isUnavailable = cached === null;
			if (cached) {
				hydratedRecord = mergeRecordEmbed(record, cached);
			}
			return;
		}

		const cancelDeferredTask = scheduleDeferredBrowserTask(() => {
			void fetchRecordEmbedStatusByUri(record.uri)
				.then(({ record: fetched, unavailable }) => {
					if (cancelled) return;
					isHydrating = false;
					isUnavailable = unavailable;
					if (fetched) {
						hydratedRecord = mergeRecordEmbed(record, fetched);
					}
				})
				.catch(() => {
					if (!cancelled) {
						isHydrating = false;
					}
				});
		});

		return () => {
			cancelled = true;
			cancelDeferredTask();
		};
	});
</script>

<div class="record-embed wobbly-border-light" class:dense bind:this={containerEl}>
	<div class="record-header">
		{#if displayRecord.author.avatar}
			<img src={displayRecord.author.avatar} alt="" class="record-avatar" />
		{/if}
		<div class="record-meta">
			<span class="record-name">{displayRecord.author.displayName || displayRecord.author.handle}</span>
			<a
				href={recordUrl(displayRecord.uri, displayRecord.author.handle)}
				target="_blank"
				rel="noopener noreferrer"
				class="record-handle"
			>
				@{displayRecord.author.handle}
			</a>
		</div>
	</div>

	{#if displayRecord.text}
		<p class="record-text">{displayRecord.text}</p>
	{:else if isHydrating}
		<p class="record-placeholder">Loading quoted post...</p>
	{:else if isUnavailable}
		<p class="record-placeholder">Quoted post not available.</p>
	{/if}

	{#if displayRecord.images}
		<div class="record-images">
			{#each displayRecord.images as img}
				<img
					src={img.thumb}
					alt={img.alt}
					class="record-image"
					onclick={(e) => {
						e.stopPropagation();
						openLightbox(img.fullsize, img.alt);
					}}
					onkeydown={(e) => {
						if (e.key === 'Enter') openLightbox(img.fullsize, img.alt);
					}}
					role="button"
					tabindex="0"
					style="cursor: pointer;"
				/>
			{/each}
		</div>
	{/if}

	{#if displayRecord.video}
		<div class="record-video">
			<!-- svelte-ignore a11y_media_has_caption -->
			<video
				controls
				preload="none"
				poster={displayRecord.video.thumbnail}
				style={displayRecord.video.aspectRatio ? `aspect-ratio: ${displayRecord.video.aspectRatio.width} / ${displayRecord.video.aspectRatio.height}` : ''}
			>
				<source src={displayRecord.video.playlist} type="application/x-mpegURL" />
			</video>
		</div>
	{/if}

	{#if displayRecord.external}
		<a
			href={displayRecord.external.uri}
			target="_blank"
			rel="noopener noreferrer"
			class="record-external"
			onclick={(e) => e.stopPropagation()}
		>
			{#if displayRecord.external.thumb}
				<img src={displayRecord.external.thumb} alt="" class="record-external-thumb" />
			{/if}
			<span class="record-external-copy">
				<strong>{displayRecord.external.title}</strong>
				<span>{displayRecord.external.description}</span>
			</span>
		</a>
	{/if}

	{#if displayRecord.record}
		<RecordEmbed record={displayRecord.record} dense {eager} />
	{/if}
</div>

<style>
	.record-embed {
		margin: 8px 0 6px;
		padding: 8px 10px;
		background: color-mix(in srgb, var(--card-bg) 88%, white 12%);
		color: inherit;
	}

	.record-embed.dense {
		padding: 7px 9px;
	}

	.record-header {
		display: flex;
		align-items: center;
		gap: 8px;
		margin-bottom: 6px;
	}

	.record-avatar {
		width: 24px;
		height: 24px;
		border-radius: 50%;
		flex-shrink: 0;
	}

	.record-meta {
		display: flex;
		align-items: baseline;
		gap: 6px;
		flex-wrap: wrap;
		min-width: 0;
	}

	.record-name {
		font-size: 0.84rem;
		font-weight: 700;
	}

	.record-handle {
		font-size: 0.78rem;
		color: var(--muted);
		text-decoration: none;
	}

	.record-handle:hover {
		text-decoration: underline;
	}

	.record-text {
		margin: 0;
		font-size: 0.88rem;
		line-height: 1.4;
		white-space: pre-wrap;
		word-break: break-word;
	}

	.record-placeholder {
		margin: 0;
		font-size: 0.82rem;
		color: var(--muted);
		font-style: italic;
	}

	.record-images {
		display: flex;
		gap: 8px;
		flex-wrap: wrap;
		margin-top: 8px;
	}

	.record-image {
		max-width: 160px;
		max-height: 120px;
		border-radius: 8px;
		object-fit: cover;
	}

	.record-video {
		margin-top: 8px;
	}

	.record-video video {
		display: block;
		width: 100%;
		max-height: 320px;
		border-radius: 8px;
		background: #111;
	}

	.record-external {
		display: flex;
		gap: 8px;
		margin-top: 8px;
		padding: 8px;
		border: 1px solid color-mix(in srgb, var(--control-border) 70%, transparent);
		border-radius: 8px;
		color: inherit;
		text-decoration: none;
		background: color-mix(in srgb, var(--card-bg) 84%, white 16%);
	}

	.record-external:hover {
		border-color: var(--accent);
	}

	.record-external-thumb {
		width: 52px;
		height: 52px;
		flex: 0 0 auto;
		border-radius: 6px;
		object-fit: cover;
	}

	.record-external-copy {
		display: flex;
		min-width: 0;
		flex-direction: column;
		gap: 2px;
		font-size: 0.8rem;
		line-height: 1.3;
	}

	.record-external-copy strong,
	.record-external-copy span {
		overflow-wrap: anywhere;
	}

	.record-external-copy span {
		color: var(--muted);
	}
</style>
