<script lang="ts">
	import { browser } from '$app/environment';
	import type { FixupXEmbed, XArchivePost } from '$lib/api/x';
	import { extractXArchiveEmbedUrls } from '$lib/api/x';
	import TwitterArchiveTweetEmbedCard from './TwitterArchiveTweetEmbedCard.svelte';

	let { post }: { post: XArchivePost } = $props();

	const embedCache = new Map<string, Promise<FixupXEmbed | null> | FixupXEmbed | null>();

	const candidateUrls = $derived(extractXArchiveEmbedUrls(post));
	const candidateSignature = $derived(candidateUrls.join('\n'));
	let embeds = $state<FixupXEmbed[]>([]);

	async function fetchFixupXEmbed(url: string): Promise<FixupXEmbed | null> {
		const cached = embedCache.get(url);
		if (cached !== undefined) {
			return cached instanceof Promise ? cached : Promise.resolve(cached);
		}

		const request = fetch(`/api/x/embed?url=${encodeURIComponent(url)}&v=2`)
			.then(async (response) => {
				if (!response.ok) return null;
				return (await response.json()) as FixupXEmbed;
			})
			.catch(() => null);

		embedCache.set(url, request);
		const result = await request;
		embedCache.set(url, result);
		return result;
	}

	function displayUrl(url: string): string {
		try {
			const parsed = new URL(url);
			return `${parsed.hostname}${parsed.pathname}`;
		} catch {
			return url;
		}
	}

	$effect(() => {
		const signature = candidateSignature;
		const urls = candidateUrls;
		let cancelled = false;

		embeds = [];
		if (!browser || !signature) return;

		void Promise.all(urls.map(fetchFixupXEmbed)).then((results) => {
			if (cancelled) return;
			const seen = new Set<string>();
			embeds = results.filter((embed): embed is FixupXEmbed => {
				if (!embed || seen.has(embed.canonicalUrl)) return false;
				if (embed.statusId === post.id) return false;
				seen.add(embed.canonicalUrl);
				return true;
			});
		});

		return () => {
			cancelled = true;
		};
	});
</script>

{#if embeds.length > 0}
	<div class="twitter-archive-fixupx-embeds" aria-label="Linked X posts">
		{#each embeds as embed (embed.canonicalUrl)}
			{#if embed.tweet}
				<TwitterArchiveTweetEmbedCard tweet={embed.tweet} nested />
			{:else}
				<a
					class="fixupx-card wobbly-border-light"
					href={embed.fixupxUrl}
					target="_blank"
					rel="noopener noreferrer"
				>
					{#if embed.image}
						<img src={embed.image} alt="" class="fixupx-image" loading="lazy" />
					{/if}
					<span class="fixupx-copy">
						<span class="fixupx-kicker">{embed.provider}</span>
						<strong>{embed.title}</strong>
						{#if embed.description}
							<span class="fixupx-description">{embed.description}</span>
						{/if}
						<span class="fixupx-url">{displayUrl(embed.canonicalUrl)}</span>
					</span>
				</a>
			{/if}
		{/each}
	</div>
{/if}

<style>
	.twitter-archive-fixupx-embeds {
		display: grid;
		gap: 10px;
		margin-top: 14px;
	}

	.fixupx-card {
		display: grid;
		grid-template-columns: auto minmax(0, 1fr);
		gap: 12px;
		align-items: stretch;
		padding: 10px;
		color: inherit;
		text-decoration: none;
		background: color-mix(in srgb, var(--card-bg) 86%, white 14%);
	}

	.fixupx-card:hover {
		text-decoration: none;
		border-color: var(--accent);
	}

	.fixupx-image {
		width: 92px;
		height: 92px;
		border-radius: 8px;
		object-fit: cover;
		background: color-mix(in srgb, var(--card-bg) 80%, #000 20%);
	}

	.fixupx-copy {
		display: grid;
		gap: 4px;
		min-width: 0;
		align-content: start;
	}

	.fixupx-kicker,
	.fixupx-url {
		color: var(--muted);
		font-size: 0.72rem;
		font-weight: 700;
		letter-spacing: 0;
		text-transform: uppercase;
	}

	.fixupx-url {
		text-transform: none;
		overflow-wrap: anywhere;
	}

	.fixupx-copy strong {
		color: var(--text-ink);
		font-size: 0.94rem;
		line-height: 1.25;
	}

	.fixupx-description {
		display: -webkit-box;
		overflow: hidden;
		color: var(--text-ink);
		font-size: 0.86rem;
		line-height: 1.38;
		white-space: pre-line;
		line-clamp: 4;
		-webkit-box-orient: vertical;
		-webkit-line-clamp: 4;
	}

	@media (max-width: 520px) {
		.fixupx-card {
			grid-template-columns: 1fr;
		}

		.fixupx-image {
			width: 100%;
			height: auto;
			aspect-ratio: 16 / 9;
		}
	}
</style>
