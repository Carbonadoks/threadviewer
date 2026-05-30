<script lang="ts">
	import type { FixupXTweet, FixupXTweetMedia } from '$lib/api/x';
	import { openLightbox } from '$lib/stores/lightbox';

	let { tweet, nested = false }: { tweet: FixupXTweet; nested?: boolean } = $props();

	function formatDate(iso: string | null): string {
		if (!iso) return '';
		const d = new Date(iso);
		return d.toLocaleString('en-US', {
			month: 'short',
			day: 'numeric',
			year: 'numeric',
			hour: 'numeric',
			minute: '2-digit'
		});
	}

	function formatCount(value: number | undefined): string {
		const count = value ?? 0;
		if (count < 1000) return count.toLocaleString();
		return new Intl.NumberFormat('en-US', {
			notation: 'compact',
			maximumFractionDigits: 1
		}).format(count);
	}

	function isVideo(media: FixupXTweetMedia): boolean {
		return media.type === 'video' || media.type === 'gif' || /video/i.test(media.type);
	}
</script>

{#snippet tweetCard(entry: FixupXTweet, isNested: boolean)}
	<article class="fx-tweet-card wobbly-border-light" class:nested={isNested}>
		<header class="fx-tweet-head">
			{#if isNested}
				<span class="reply-marker" aria-hidden="true">↪</span>
			{/if}
			{#if entry.author.avatar}
				<img src={entry.author.avatar} alt="" class="fx-avatar" loading="lazy" />
			{/if}
			<span class="fx-author">
				<strong>{entry.author.displayName}</strong>
				<span>@{entry.author.handle}</span>
			</span>
			<a href={entry.url} target="_blank" rel="noopener noreferrer">
				{formatDate(entry.createdAt) || 'Open on X'}
			</a>
		</header>

		{#if entry.text}
			<p class="fx-text">{entry.text}</p>
		{/if}

		{#if entry.media.length > 0}
			<div class="fx-media-grid">
				{#each entry.media as media}
					{#if isVideo(media)}
						<!-- svelte-ignore a11y_media_has_caption -->
						<video
							src={media.url}
							poster={media.thumbnailUrl}
							controls
							preload="metadata"
							style={media.width && media.height ? `aspect-ratio: ${media.width} / ${media.height}` : ''}
						></video>
					{:else}
						<button
							type="button"
							class="fx-media-button"
							onclick={() => openLightbox(media.url, media.alt ?? '')}
						>
							<img src={media.url} alt={media.alt ?? ''} loading="lazy" />
						</button>
					{/if}
				{/each}
			</div>
		{/if}

		{#if entry.quote}
			<div class="fx-quote">
				{@render tweetCard(entry.quote, true)}
			</div>
		{/if}

		<footer class="fx-stats" aria-label="Embedded post engagement">
			<span>{formatCount(entry.stats.likes)} likes</span>
			<span>{formatCount(entry.stats.reposts)} reposts</span>
			{#if entry.stats.replies > 0}
				<span>{formatCount(entry.stats.replies)} replies</span>
			{/if}
			{#if entry.stats.quotes > 0}
				<span>{formatCount(entry.stats.quotes)} quotes</span>
			{/if}
			{#if entry.stats.views}
				<span>{formatCount(entry.stats.views)} views</span>
			{/if}
		</footer>
	</article>
{/snippet}

{@render tweetCard(tweet, nested)}

<style>
	.fx-tweet-card {
		display: flex;
		flex-direction: column;
		gap: 10px;
		max-width: 100%;
		padding: 12px;
		border-color: color-mix(in srgb, var(--control-border) 84%, transparent);
		background:
			linear-gradient(135deg, color-mix(in srgb, var(--accent) 4%, transparent), transparent 52%),
			color-mix(in srgb, var(--card-bg) 93%, white 7%);
		color: var(--text-ink);
		font-family: Inter, system-ui, sans-serif;
	}

	.fx-tweet-card.nested {
		margin-top: 10px;
		margin-left: 16px;
		background: color-mix(in srgb, var(--card-bg) 88%, white 12%);
	}

	.fx-tweet-head {
		display: flex;
		align-items: center;
		gap: 8px;
		min-width: 0;
		color: var(--muted);
		font-size: 0.78rem;
		line-height: 1.25;
	}

	.reply-marker {
		color: var(--accent);
		font-weight: 900;
	}

	.fx-avatar {
		width: 28px;
		height: 28px;
		border-radius: 50%;
		object-fit: cover;
	}

	.fx-author {
		display: flex;
		flex-wrap: wrap;
		gap: 3px 6px;
		min-width: 0;
		align-items: baseline;
	}

	.fx-author strong {
		color: var(--text-ink);
		font-size: 0.84rem;
	}

	.fx-author span {
		color: var(--muted);
		font-size: 0.76rem;
	}

	.fx-tweet-head a {
		margin-left: auto;
		flex: 0 0 auto;
		color: var(--muted);
		text-decoration: none;
		font-style: italic;
	}

	.fx-tweet-head a:hover {
		color: var(--accent);
	}

	.fx-text {
		margin: 0;
		color: var(--text-ink);
		font-family: Inter, system-ui, sans-serif;
		font-size: 0.94rem;
		line-height: 1.48;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}

	.fx-media-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(min(100%, 180px), 1fr));
		gap: 6px;
		overflow: hidden;
	}

	.fx-media-button {
		min-width: 0;
		padding: 0;
		border: 0;
		background: transparent;
		cursor: pointer;
	}

	.fx-media-grid img,
	.fx-media-grid video {
		display: block;
		width: 100%;
		max-height: min(58vh, 520px);
		border-radius: 8px;
		background: color-mix(in srgb, var(--card-bg) 82%, #000 18%);
		object-fit: contain;
	}

	.fx-quote {
		display: block;
	}

	.fx-stats {
		display: flex;
		flex-wrap: wrap;
		gap: 7px 10px;
		color: var(--muted);
		font-size: 0.76rem;
	}

	@media (max-width: 560px) {
		.fx-tweet-card.nested {
			margin-left: 8px;
		}

		.fx-tweet-head {
			align-items: flex-start;
		}

		.fx-tweet-head a {
			width: 100%;
			margin-left: 36px;
		}
	}
</style>
