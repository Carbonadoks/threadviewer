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

	let { record, dense = false }: { record: RecordEmbedValue; dense?: boolean } = $props();
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
		if (cached !== undefined) {
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
						openLightbox(img.fullsize);
					}}
					onkeydown={(e) => {
						if (e.key === 'Enter') openLightbox(img.fullsize);
					}}
					role="button"
					tabindex="0"
					style="cursor: pointer;"
				/>
			{/each}
		</div>
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
</style>
