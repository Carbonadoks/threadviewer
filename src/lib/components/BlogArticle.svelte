<script lang="ts">
	import type { SelfReplyThread, ThreadPost } from '$lib/types';
	import PostEmbedPreview from '$lib/components/PostEmbedPreview.svelte';
	import {
		buildBlogTitle,
		collectSelfReplyChainPosts,
		splitPostIntoBlogParagraphs
	} from '$lib/utils/threadBlog';
	import { flattenThreadForChat } from '$lib/utils/threadFlattener';
	import { buildBskyPostUrl } from '$lib/utils/viewerLinks';

	export type BlogArticleMode = 'chain' | 'thread';

	let { thread, mode = 'chain' }: { thread: SelfReplyThread; mode?: BlogArticleMode } = $props();

	type ArticleItem = { post: ThreadPost; showAuthor: boolean };

	let hiddenUris = $state<Set<string>>(new Set());
	let currentArticleKey = $state('');

	const articleItems = $derived<ArticleItem[]>(
		mode === 'thread'
			? flattenThreadForChat(thread.rootPost).map(({ post, showAuthorHeader }) => ({
					post,
					showAuthor: showAuthorHeader
				}))
			: collectSelfReplyChainPosts(thread.rootPost).map((post) => ({ post, showAuthor: false }))
	);
	const chainPosts = $derived(articleItems.map((item) => item.post));
	const visiblePosts = $derived(chainPosts.filter((post) => !hiddenUris.has(post.uri)));
	const hiddenPosts = $derived(chainPosts.filter((post) => hiddenUris.has(post.uri)));
	const articleTitle = $derived(buildBlogTitle(chainPosts[0]?.text ?? thread.rootPost.text));
	const authorName = $derived(
		thread.rootPost.author.displayName?.trim() || `@${thread.rootPost.author.handle}`
	);
	const authorCount = $derived(new Set(chainPosts.map((post) => post.author.did)).size);

	$effect(() => {
		const key = `${thread.rootUri}|${mode}`;
		if (currentArticleKey === key) return;
		currentArticleKey = key;
		hiddenUris = new Set();
	});

	function postAuthorName(post: ThreadPost): string {
		return post.author.displayName?.trim() || `@${post.author.handle}`;
	}

	function hidePost(uri: string) {
		if (uri === thread.rootPost.uri) return;
		const next = new Set(hiddenUris);
		next.add(uri);
		hiddenUris = next;
	}

	function restoreAllPosts() {
		hiddenUris = new Set();
	}

	function openPost(postUri: string, handle: string) {
		const url = buildBskyPostUrl(postUri, handle);
		if (!url) return;
		window.open(url, '_blank', 'noopener,noreferrer');
	}

	function hiddenLabel(count: number): string {
		return `${count} hidden`;
	}
</script>

<article class="blog-article">
	<header class="article-header">
		<h2>{articleTitle}</h2>
		<div class="byline">
			{#if thread.rootPost.author.avatar}
				<img src={thread.rootPost.author.avatar} alt="" class="author-avatar" />
			{/if}
			<span>
				{authorName}
				<span class="meta-detail">
					{visiblePosts.length} of {chainPosts.length} post{chainPosts.length === 1 ? '' : 's'}
					{#if mode === 'thread' && authorCount > 1}
						· {authorCount} authors
					{/if}
				</span>
			</span>
		</div>
	</header>

	{#if hiddenPosts.length > 0}
		<div class="restore-row">
			<span>{hiddenLabel(hiddenPosts.length)}</span>
			<button type="button" class="restore-all-btn" onclick={restoreAllPosts}>
				Restore
			</button>
		</div>
	{/if}

	<div class="article-body">
		{#each articleItems as { post, showAuthor }, index (post.uri)}
			{@const hidden = hiddenUris.has(post.uri)}
			{#if !hidden}
				<section class="article-post" aria-label={`Thread post ${index + 1}`}>
					{#if mode === 'thread' && showAuthor && index > 0}
						<div class="speaker-label">
							{#if post.author.avatar}
								<img src={post.author.avatar} alt="" class="speaker-avatar" />
							{/if}
							{postAuthorName(post)}
						</div>
					{/if}
					<div class="post-actions">
						<button
							type="button"
							class="open-post-btn"
							aria-label="Open this post on Bluesky"
							onclick={() => openPost(post.uri, post.author.handle)}
						>
							Open
						</button>
					{#if post.uri !== thread.rootPost.uri}
						<button
							type="button"
							class="hide-post-btn"
							aria-label="Hide this post from the article"
							onclick={() => hidePost(post.uri)}
						>
							Hide
						</button>
					{/if}
					</div>

					{#each splitPostIntoBlogParagraphs(post.text) as paragraph}
						<p>{paragraph}</p>
					{/each}

					<PostEmbedPreview {post} wide eager />
				</section>
			{/if}
		{/each}
	</div>
</article>

<style>
	.blog-article {
		width: min(100%, 720px);
		margin: 0 auto;
		color: var(--text-ink);
	}

	.article-header {
		margin: 18px 0 42px;
	}

	h2 {
		margin: 0;
		font-family: Inter, ui-serif, Georgia, serif;
		font-size: clamp(2.2rem, 5vw, 4.25rem);
		font-weight: 650;
		line-height: 1.04;
		letter-spacing: 0;
	}

	.byline {
		display: flex;
		align-items: center;
		gap: 10px;
		margin-top: 18px;
		color: var(--muted);
		font-family: Inter, system-ui, sans-serif;
		font-size: 0.9rem;
		line-height: 1.35;
	}

	.author-avatar {
		width: 38px;
		height: 38px;
		border-radius: 50%;
		object-fit: cover;
	}

	.meta-detail {
		display: block;
		margin-top: 2px;
		font-size: 0.82rem;
	}

	.restore-row {
		display: flex;
		justify-content: center;
		align-items: center;
		gap: 8px;
		margin: -20px 0 28px;
		color: var(--muted);
		font-family: Inter, system-ui, sans-serif;
		font-size: 0.78rem;
	}

	.restore-all-btn,
	.open-post-btn,
	.hide-post-btn {
		border: 0;
		background: transparent;
		color: var(--muted);
		font: inherit;
		cursor: pointer;
	}

	.restore-all-btn,
	.open-post-btn,
	.hide-post-btn {
		padding: 4px 6px;
		font-family: Inter, system-ui, sans-serif;
		font-size: 0.78rem;
		font-weight: 700;
	}

	.restore-all-btn:hover,
	.open-post-btn:hover,
	.hide-post-btn:hover {
		color: var(--accent);
	}

	.article-body {
		display: block;
	}

	.article-post {
		position: relative;
		display: block;
	}

	.article-post + .article-post {
		margin-top: 1.78em;
	}

	.speaker-label {
		display: flex;
		align-items: center;
		gap: 8px;
		margin-bottom: 0.6em;
		font-family: Inter, system-ui, sans-serif;
		font-size: 0.82rem;
		font-weight: 700;
		color: var(--muted);
	}

	.speaker-avatar {
		width: 22px;
		height: 22px;
		border-radius: 50%;
		object-fit: cover;
	}

	.article-post p {
		margin: 0;
		font-family: ui-serif, Georgia, Cambria, 'Times New Roman', serif;
		font-size: clamp(1.12rem, 2.3vw, 1.35rem);
		line-height: 1.78;
		letter-spacing: 0;
	}

	.article-post p + p,
	.article-post :global(.post-embed-preview) {
		margin-top: 1.78em;
	}

	.article-post :global(.post-embed-preview) {
		width: 100%;
	}

	.post-actions {
		position: absolute;
		top: 3px;
		right: 0;
		display: flex;
		gap: 2px;
		opacity: 0;
		transform: translateX(calc(100% + 12px));
		transition: opacity 0.16s ease, color 0.16s ease;
	}

	.article-post:hover .post-actions,
	.post-actions:focus-within,
	.hide-post-btn:focus-visible {
		opacity: 0.62;
	}

	@media (max-width: 640px) {
		.blog-article {
			width: 100%;
		}

		.article-header {
			margin-top: 8px;
		}

		.post-actions {
			position: static;
			justify-content: flex-end;
			opacity: 0.58;
			transform: none;
		}
	}
</style>
