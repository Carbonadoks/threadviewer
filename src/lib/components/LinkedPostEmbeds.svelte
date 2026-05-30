<script lang="ts">
	import { browser } from '$app/environment';
	import { fetchRecordEmbedStatusByUrl } from '$lib/api/bluesky';
	import RecordEmbed from '$lib/components/RecordEmbed.svelte';
	import { observeElementOnceVisible, scheduleDeferredBrowserTask } from '$lib/utils/browserTasks';
	import type { RecordEmbed as RecordEmbedValue } from '$lib/utils/recordEmbed';
	import { extractBskyPostUrls, normalizeBskyPostUrl } from '$lib/utils/viewerLinks';

	let {
		text,
		externalUri = null,
		urls = [],
		excludeUris = [],
		eager = false
	}: {
		text: string;
		externalUri?: string | null;
		urls?: string[];
		excludeUris?: string[];
		eager?: boolean;
	} = $props();

	const candidateUrls = $derived.by(() => {
		const mergedUrls = [...extractBskyPostUrls(text)];
		for (const url of urls) {
			const normalized = normalizeBskyPostUrl(url);
			if (normalized && !mergedUrls.includes(normalized)) {
				mergedUrls.push(normalized);
			}
		}
		const normalizedExternalUri = externalUri ? normalizeBskyPostUrl(externalUri) : null;
		if (normalizedExternalUri && !mergedUrls.includes(normalizedExternalUri)) {
			mergedUrls.push(normalizedExternalUri);
		}
		return mergedUrls;
	});

	type LinkedRecordState = {
		key: string;
		record: RecordEmbedValue | null;
		unavailable: boolean;
	};

	let linkedRecords = $state<LinkedRecordState[]>([]);
	let shouldFetch = $state(false);
	let containerEl = $state<HTMLDivElement | null>(null);

	$effect(() => {
		candidateUrls;
		linkedRecords = [];
		shouldFetch = false;
	});

	$effect(() => {
		if (!browser || candidateUrls.length === 0) {
			shouldFetch = false;
			return;
		}

		if (eager) {
			shouldFetch = true;
			return;
		}

		return observeElementOnceVisible(containerEl, () => {
			shouldFetch = true;
		});
	});

	$effect(() => {
		let cancelled = false;

		if (!browser || candidateUrls.length === 0 || !shouldFetch) {
			return;
		}

		const cancelDeferredTask = scheduleDeferredBrowserTask(() => {
			void Promise.all(
				candidateUrls.map(async (url) => ({
					url,
					...(await fetchRecordEmbedStatusByUrl(url))
				}))
			)
				.then((results) => {
					if (cancelled) return;

					const seenUris = new Set(excludeUris.filter(Boolean));
					const nextRecords: LinkedRecordState[] = [];
					for (const { url, record, unavailable } of results) {
						if (!record || !record.uri) {
							if (unavailable) {
								nextRecords.push({
									key: `unavailable:${url}`,
									record: null,
									unavailable: true
								});
							}
							continue;
						}
						if (seenUris.has(record.uri)) {
							continue;
						}
						seenUris.add(record.uri);
						nextRecords.push({
							key: record.uri,
							record,
							unavailable: false
						});
					}
					linkedRecords = nextRecords;
				})
				.catch(() => {
					if (!cancelled) {
						linkedRecords = [];
					}
				});
			});

		return () => {
			cancelled = true;
			cancelDeferredTask();
		};
	});
</script>

{#if candidateUrls.length > 0}
	<div class="linked-post-embeds" class:is-empty={linkedRecords.length === 0} bind:this={containerEl}>
		{#each linkedRecords as entry (entry.key)}
			{#if entry.record}
				<RecordEmbed record={entry.record} dense {eager} />
			{:else if entry.unavailable}
				<div class="linked-post-unavailable wobbly-border-light">
					<p class="linked-post-unavailable-text">Linked post not available.</p>
				</div>
			{/if}
		{/each}
	</div>
{/if}

<style>
	.linked-post-embeds {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.linked-post-embeds.is-empty {
		display: block;
		min-height: 1px;
	}

	.linked-post-unavailable {
		padding: 8px 10px;
		background: color-mix(in srgb, var(--card-bg) 84%, white 16%);
	}

	.linked-post-unavailable-text {
		margin: 0;
		font-size: 0.82rem;
		color: var(--muted);
		font-style: italic;
	}
</style>
