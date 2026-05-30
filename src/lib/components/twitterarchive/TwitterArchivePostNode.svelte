<script lang="ts">
	import type { XArchivePost } from '$lib/api/x';
	import PostEmbedPreview from '$lib/components/PostEmbedPreview.svelte';
	import TwitterArchivePostNode from './TwitterArchivePostNode.svelte';

	let {
		post,
		level = 0
	}: {
		post: XArchivePost;
		level?: number;
	} = $props();

	const MAX_VISIBLE_DEPTH = 5;
	const childIndent = $derived(level < MAX_VISIBLE_DEPTH ? 24 : 0);
	const compressChildren = $derived(level >= MAX_VISIBLE_DEPTH);

	function formatDate(iso: string): string {
		const d = new Date(iso);
		return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
	}

	function formatCount(value: number): string {
		if (value < 1000) return value.toLocaleString();
		return new Intl.NumberFormat('en-US', {
			notation: 'compact',
			maximumFractionDigits: 1
		}).format(value);
	}
</script>

<div class="x-post-node">
	<div class="x-post-content">
		<div class="x-post-header">
			{#if post.author.avatar}
				<img src={post.author.avatar} alt="" class="x-post-avatar" />
			{/if}
			<a href={post.sourceUrl} target="_blank" rel="noopener noreferrer" class="x-post-author-link">
				<span class="x-post-author">{post.author.displayName || post.author.handle}</span>
				<span class="x-post-handle">@{post.author.handle}</span>
				<span class="x-post-date">{formatDate(post.createdAt)}</span>
			</a>
		</div>

		<p class="x-post-text">{post.text}</p>

		{#if post.linkedUrls.length > 0}
			<div class="x-post-links">
				{#each post.linkedUrls as url}
					<a href={url} target="_blank" rel="noopener noreferrer">{url}</a>
				{/each}
			</div>
		{/if}

		<PostEmbedPreview post={post} compact />

		<div class="x-post-meta" aria-label="Post statistics">
			<span>{post.characterLength.toLocaleString()} chars</span>
			<span>{formatCount(post.likeCount)} likes</span>
			<span>{formatCount(post.repostCount)} reposts</span>
			{#if post.replyCount > 0}
				<span>{formatCount(post.replyCount)} replies</span>
			{/if}
			{#if post.quoteCount > 0}
				<span>{formatCount(post.quoteCount)} quotes</span>
			{/if}
			{#if post.isNoteTweet}
				<span>note text restored</span>
			{/if}
		</div>
	</div>

	{#if post.children.length > 0}
		<div class="x-post-children" class:compressed={compressChildren} style={`margin-left: ${childIndent}px;`}>
			{#each post.children as child (child.uri)}
				<TwitterArchivePostNode post={child} level={level + 1} />
			{/each}
		</div>
	{/if}
</div>

<style>
	.x-post-node {
		position: relative;
	}

	.x-post-content {
		margin: 8px 0;
		padding: 12px;
		background: color-mix(in srgb, var(--card-bg) 88%, transparent);
		border-left: 3px solid var(--accent);
		border-radius: 8px;
	}

	.x-post-header {
		display: flex;
		align-items: center;
		gap: 8px;
		margin-bottom: 8px;
	}

	.x-post-avatar {
		width: 28px;
		height: 28px;
		border-radius: 50%;
		object-fit: cover;
	}

	.x-post-author-link {
		display: inline-flex;
		align-items: baseline;
		gap: 7px;
		flex-wrap: wrap;
		color: inherit;
		text-decoration: none;
	}

	.x-post-author {
		font-weight: 700;
		color: var(--text-ink);
	}

	.x-post-handle,
	.x-post-date,
	.x-post-meta,
	.x-post-links {
		color: var(--muted);
		font-size: 0.82rem;
	}

	.x-post-text {
		margin: 0;
		white-space: pre-wrap;
		line-height: 1.45;
		color: var(--text-ink);
	}

	.x-post-links {
		display: grid;
		gap: 4px;
		margin-top: 8px;
		font-family: Inter, system-ui, sans-serif;
	}

	.x-post-links a {
		color: var(--accent);
		overflow-wrap: anywhere;
	}

	.x-post-meta {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		margin-top: 8px;
		font-family: Inter, system-ui, sans-serif;
	}

	.x-post-children {
		border-left: 1.5px dashed color-mix(in srgb, var(--muted) 40%, transparent);
		padding-left: 8px;
	}

	.x-post-children.compressed {
		margin-left: 0 !important;
	}
</style>
