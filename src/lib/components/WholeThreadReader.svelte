<script module lang="ts">
	import type { ThreadPost } from '$lib/types';

	export type WholeThreadReaderItem = {
		post: ThreadPost;
		threadStart?: boolean;
		threadLabel?: string;
	};
</script>

<script lang="ts">
	import PostEmbedPreview from '$lib/components/PostEmbedPreview.svelte';
	import { buildBskyPostUrl } from '$lib/utils/viewerLinks';

	interface Props {
		items: WholeThreadReaderItem[];
		truncated?: boolean;
		sourceLabel?: string;
		onclose: () => void;
	}

	let { items, truncated = false, sourceLabel = '', onclose }: Props = $props();

	const threadCount = $derived(items.reduce((n, item) => (item.threadStart ? n + 1 : n), 0));

	function postUrl(post: ThreadPost): string {
		return buildBskyPostUrl(post.uri, post.author.handle) ?? '#';
	}

	function fmtDate(value: string): string {
		const ms = Date.parse(value);
		if (!Number.isFinite(ms)) return '';
		return new Date(ms).toLocaleString(undefined, {
			year: 'numeric',
			month: 'short',
			day: 'numeric',
			hour: '2-digit',
			minute: '2-digit'
		});
	}

	function handleKeydown(event: KeyboardEvent) {
		if (event.key === 'Escape') onclose();
	}
</script>

<svelte:window onkeydown={handleKeydown} />

<div class="whole-thread-reader" role="dialog" aria-modal="true" aria-label="Whole thread reader">
	<div class="wtr-toolbar">
		<button type="button" class="wtr-back wobbly-border" onclick={onclose}>&#8592; Back</button>
		<div class="wtr-summary">
			<strong>{items.length.toLocaleString()}</strong> post{items.length === 1 ? '' : 's'}
			across <strong>{threadCount.toLocaleString()}</strong> thread{threadCount === 1 ? '' : 's'}
			{#if sourceLabel}<span class="wtr-source">· {sourceLabel}</span>{/if}
		</div>
		{#if truncated}
			<span class="wtr-truncation" title="Some replies may be missing from one or more conversations">
				⚠ partial
			</span>
		{/if}
	</div>

	<div class="wtr-scroll">
		<div class="wtr-list">
			{#each items as item (item.post.uri)}
				{#if item.threadStart && item.threadLabel}
					<div class="wtr-divider">
						<span class="wtr-divider-label">{item.threadLabel}</span>
					</div>
				{/if}
				<article class="wtr-post">
					<div class="wtr-post-head">
						{#if item.post.author.avatar}
							<img class="wtr-avatar" src={item.post.author.avatar} alt="" />
						{:else}
							<div class="wtr-avatar wtr-avatar--empty" aria-hidden="true"></div>
						{/if}
						<div class="wtr-author">
							<span class="wtr-name">{item.post.author.displayName || item.post.author.handle}</span>
							<span class="wtr-handle">@{item.post.author.handle}</span>
						</div>
						<a
							class="wtr-date"
							href={postUrl(item.post)}
							target="_blank"
							rel="noopener noreferrer"
							title="Open on Bluesky"
						>
							{fmtDate(item.post.createdAt)} ↗
						</a>
					</div>

					{#if item.post.text}
						<p class="wtr-text">{item.post.text}</p>
					{/if}

					<div class="wtr-embed">
						<PostEmbedPreview post={item.post} compact />
					</div>

					<div class="wtr-stats">
						<span>♥ {(item.post.likeCount ?? 0).toLocaleString()}</span>
						<span>🔁 {(item.post.repostCount ?? 0).toLocaleString()}</span>
						<span>💬 {(item.post.replyCount ?? 0).toLocaleString()}</span>
						{#if (item.post.quoteCount ?? 0) > 0}
							<span>❝ {(item.post.quoteCount ?? 0).toLocaleString()}</span>
						{/if}
					</div>
				</article>
			{/each}
		</div>
	</div>
</div>

<style>
	.whole-thread-reader {
		position: fixed;
		inset: 0;
		z-index: 200;
		display: flex;
		flex-direction: column;
		background: var(--bg-paper, #faf8ef);
		color: var(--text-ink);
	}

	.wtr-toolbar {
		position: sticky;
		top: 0;
		z-index: 2;
		display: flex;
		align-items: center;
		gap: 12px;
		flex-wrap: wrap;
		padding: 12px 18px;
		background: var(--bg-paper, #faf8ef);
		border-bottom: 1px solid var(--border-ink, #d9d2c2);
	}

	.wtr-back {
		padding: 6px 16px;
		font-size: 0.9rem;
		font-family: inherit;
		background: var(--card-bg, #fff);
		color: var(--text-ink);
		cursor: pointer;
	}

	.wtr-summary {
		font-size: 0.9rem;
		opacity: 0.9;
	}

	.wtr-source {
		opacity: 0.7;
	}

	.wtr-truncation {
		font-size: 0.8rem;
		color: #b4690e;
		margin-left: auto;
	}

	.wtr-scroll {
		flex: 1;
		overflow-y: auto;
		-webkit-overflow-scrolling: touch;
	}

	.wtr-list {
		width: min(100%, 720px);
		margin: 0 auto;
		padding: 16px 16px 96px;
		display: flex;
		flex-direction: column;
		gap: 12px;
	}

	.wtr-divider {
		display: flex;
		align-items: center;
		gap: 8px;
		margin: 18px 0 2px;
	}

	.wtr-divider::before,
	.wtr-divider::after {
		content: '';
		flex: 1;
		height: 1px;
		background: var(--border-ink, #d9d2c2);
		opacity: 0.7;
	}

	.wtr-divider-label {
		font-size: 0.78rem;
		font-weight: 600;
		color: var(--muted, #8a8474);
		max-width: 70%;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.wtr-post {
		background: var(--card-bg, #fff);
		border: 1px solid var(--border-ink, #e3ddcd);
		border-radius: 12px;
		padding: 12px 14px;
	}

	.wtr-post-head {
		display: flex;
		align-items: center;
		gap: 9px;
	}

	.wtr-avatar {
		width: 36px;
		height: 36px;
		border-radius: 50%;
		object-fit: cover;
		flex-shrink: 0;
	}

	.wtr-avatar--empty {
		background: var(--border-ink, #e3ddcd);
	}

	.wtr-author {
		display: flex;
		flex-direction: column;
		min-width: 0;
	}

	.wtr-name {
		font-weight: 600;
		font-size: 0.92rem;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.wtr-handle {
		font-size: 0.78rem;
		opacity: 0.7;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.wtr-date {
		margin-left: auto;
		flex-shrink: 0;
		font-size: 0.76rem;
		opacity: 0.7;
		color: inherit;
		text-decoration: none;
		white-space: nowrap;
	}

	.wtr-date:hover {
		opacity: 1;
		color: var(--accent);
	}

	.wtr-text {
		margin: 9px 0 0;
		font-size: 0.95rem;
		line-height: 1.5;
		white-space: pre-wrap;
		word-break: break-word;
	}

	.wtr-embed:not(:empty) {
		margin-top: 10px;
	}

	.wtr-stats {
		display: flex;
		gap: 14px;
		margin-top: 10px;
		font-size: 0.78rem;
		opacity: 0.75;
	}
</style>
