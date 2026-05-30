<script lang="ts">
	import { browser } from '$app/environment';
	import type { FixupXEmbed, FixupXTweet, XArchivePost, XArchiveThread } from '$lib/api/x';
	import {
		collectXThreadPosts,
		extractXArchiveEmbedUrls,
		isXShortLinkUrl,
		parseXStatusUrl
	} from '$lib/api/x';
	import PostEmbedPreview from '$lib/components/PostEmbedPreview.svelte';
	import { buildBlogTitle, splitPostIntoBlogParagraphs } from '$lib/utils/threadBlog';
	import TwitterArchiveFixupXEmbeds from './TwitterArchiveFixupXEmbeds.svelte';

	let { thread }: { thread: XArchiveThread } = $props();

	type ExportFormat = 'article' | 'markdown' | 'json';
	type ExportPost = {
		index: number;
		id: string;
		uri: string;
		sourceUrl: string;
		createdAt: string;
		text: string;
		paragraphs: string[];
		linkedUrls: string[];
		fixupxEmbeds: FixupXEmbed[];
		images: Array<{
			thumb: string;
			fullsize: string;
			alt: string;
		}>;
		engagement: {
			likes: number;
			reposts: number;
			replies: number;
			quotes: number;
		};
		isNoteTweet: boolean;
	};
	type ArticleExport = {
		version: 1;
		exportedAt: string;
		title: string;
		author: {
			handle: string;
			displayName?: string;
			avatar?: string;
		};
		rootUri: string;
		sourceUrl: string;
		totalPosts: number;
		visiblePosts: number;
		hiddenPosts: number;
		characterLength: number;
		posts: ExportPost[];
	};

	let hiddenUris = $state<Set<string>>(new Set());
	let currentRootUri = $state('');
	let exportingFormat = $state<ExportFormat | null>(null);

	const chainPosts = $derived(collectXThreadPosts(thread.rootPost));
	const visiblePosts = $derived(chainPosts.filter((post) => !hiddenUris.has(post.uri)));
	const hiddenPosts = $derived(chainPosts.filter((post) => hiddenUris.has(post.uri)));
	const articleTitle = $derived(buildBlogTitle(chainPosts[0]?.text ?? thread.rootPost.text));
	const authorName = $derived(
		thread.rootPost.author.displayName?.trim() || `@${thread.rootPost.author.handle}`
	);

	$effect(() => {
		if (currentRootUri === thread.rootUri) return;
		currentRootUri = thread.rootUri;
		hiddenUris = new Set();
	});

	function hidePost(uri: string) {
		if (uri === thread.rootPost.uri) return;
		const next = new Set(hiddenUris);
		next.add(uri);
		hiddenUris = next;
	}

	function restoreAllPosts() {
		hiddenUris = new Set();
	}

	function openPost(url: string) {
		window.open(url, '_blank', 'noopener,noreferrer');
	}

	function formatDate(iso: string): string {
		const d = new Date(iso);
		return d.toLocaleString('en-US', {
			month: 'short',
			day: 'numeric',
			year: 'numeric',
			hour: 'numeric',
			minute: '2-digit'
		});
	}

	function formatCount(value: number): string {
		if (value < 1000) return value.toLocaleString();
		return new Intl.NumberFormat('en-US', {
			notation: 'compact',
			maximumFractionDigits: 1
		}).format(value);
	}

	function slugify(value: string): string {
		const slug = value
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '')
			.slice(0, 72);
		return slug || 'xblog-thread';
	}

	function markdownEscape(value: string): string {
		return value.replace(/\\/g, '\\\\').replace(/\[/g, '\\[').replace(/\]/g, '\\]');
	}

	function markdownLink(label: string, url: string): string {
		return `[${markdownEscape(label)}](${url})`;
	}

	function cleanUrlToken(raw: string): string {
		return raw.trim().replace(/^["'<({\[]+/g, '').replace(/["')\]}>.,;!?]+$/g, '');
	}

	function shouldStripArticleUrl(raw: string): boolean {
		const cleaned = cleanUrlToken(raw);
		return Boolean(cleaned && (parseXStatusUrl(cleaned) || isXShortLinkUrl(cleaned)));
	}

	function stripArticleXLinks(text: string): string {
		return text
			.replace(/https?:\/\/\S+|\b(?:pic\.)?(?:twitter|x)\.com\/\S+/giu, (match) =>
				shouldStripArticleUrl(match) ? '' : match
			)
			.replace(/[ \t]+\n/g, '\n')
			.replace(/\n{3,}/g, '\n\n')
			.replace(/[ \t]{2,}/g, ' ')
			.trim();
	}

	function appendCleanTweetMarkdown(lines: string[], tweet: FixupXTweet, quoteDepth = 0) {
		const quotePrefix = '>'.repeat(quoteDepth + 1);
		const authorLine = `${quotePrefix} ${tweet.author.displayName} (@${tweet.author.handle})`;
		lines.push(authorLine, `${quotePrefix}`);

		const text = stripArticleXLinks(tweet.text);
		if (text) {
			for (const paragraph of splitPostIntoBlogParagraphs(text)) {
				for (const line of paragraph.split('\n')) {
					lines.push(`${quotePrefix} ${line}`);
				}
				lines.push(`${quotePrefix}`);
			}
		}

		for (const media of tweet.media) {
			if (media.type === 'photo') {
				lines.push(`${quotePrefix} ![${media.alt || 'Embedded image'}](${media.url})`);
			} else {
				lines.push(`${quotePrefix} ${media.type}: ${media.url}`);
			}
		}

		if (tweet.media.length > 0) lines.push(`${quotePrefix}`);

		if (tweet.quote) {
			appendCleanTweetMarkdown(lines, tweet.quote, quoteDepth + 1);
		}
	}

	function appendEmbeddedTweetMarkdown(lines: string[], tweet: FixupXTweet, prefix = '') {
		const label = `${tweet.author.displayName} (@${tweet.author.handle})`;
		lines.push(`${prefix}- ${markdownLink(label, tweet.url)}`);
		if (tweet.createdAt) lines.push(`${prefix}  Created: ${formatDate(tweet.createdAt)}`);
		lines.push(
			`${prefix}  Stats: ${formatCount(tweet.stats.likes)} likes · ${formatCount(tweet.stats.reposts)} reposts · ${formatCount(tweet.stats.replies)} replies · ${formatCount(tweet.stats.quotes)} quotes${tweet.stats.views ? ` · ${formatCount(tweet.stats.views)} views` : ''}`
		);
		if (tweet.text) {
			lines.push(`${prefix}  Text:`);
			for (const line of tweet.text.split('\n')) {
				lines.push(`${prefix}  > ${line}`);
			}
		}
		if (tweet.media.length > 0) {
			lines.push(`${prefix}  Media:`);
			for (const media of tweet.media) {
				const dimensions = media.width && media.height ? ` ${media.width}x${media.height}` : '';
				const thumbnail = media.thumbnailUrl ? `, thumbnail: ${media.thumbnailUrl}` : '';
				lines.push(`${prefix}  - ${media.type}${dimensions}: ${media.url}${thumbnail}`);
			}
		}
		if (tweet.quote) {
			lines.push(`${prefix}  Quote:`);
			appendEmbeddedTweetMarkdown(lines, tweet.quote, `${prefix}  `);
		}
	}

	function downloadTextFile(filename: string, mimeType: string, contents: string) {
		if (!browser) return;
		const blob = new Blob([contents], { type: mimeType });
		const href = URL.createObjectURL(blob);
		const anchor = document.createElement('a');
		anchor.href = href;
		anchor.download = filename;
		document.body.appendChild(anchor);
		anchor.click();
		anchor.remove();
		URL.revokeObjectURL(href);
	}

	async function fetchFixupXEmbed(url: string): Promise<FixupXEmbed | null> {
		try {
			const response = await fetch(`/api/x/embed?url=${encodeURIComponent(url)}&v=2`);
			if (!response.ok) return null;
			return (await response.json()) as FixupXEmbed;
		} catch {
			return null;
		}
	}

	async function resolvePostEmbeds(post: XArchivePost): Promise<FixupXEmbed[]> {
		const results = await Promise.all(extractXArchiveEmbedUrls(post).map(fetchFixupXEmbed));
		const seen = new Set<string>();
		return results.filter((embed): embed is FixupXEmbed => {
			if (!embed || embed.statusId === post.id || seen.has(embed.canonicalUrl)) return false;
			seen.add(embed.canonicalUrl);
			return true;
		});
	}

	async function buildArticleExport(): Promise<ArticleExport> {
		const posts = await Promise.all(
			visiblePosts.map(async (post, index): Promise<ExportPost> => ({
				index: index + 1,
				id: post.id,
				uri: post.uri,
				sourceUrl: post.sourceUrl,
				createdAt: post.createdAt,
				text: post.text,
				paragraphs: splitPostIntoBlogParagraphs(post.text),
				linkedUrls: post.linkedUrls,
				fixupxEmbeds: await resolvePostEmbeds(post),
				images:
					post.embed?.images?.map((image) => ({
						thumb: image.thumb,
						fullsize: image.fullsize,
						alt: image.alt
					})) ?? [],
				engagement: {
					likes: post.likeCount,
					reposts: post.repostCount,
					replies: post.replyCount,
					quotes: post.quoteCount
				},
				isNoteTweet: Boolean(post.isNoteTweet)
			}))
		);

		return {
			version: 1,
			exportedAt: new Date().toISOString(),
			title: articleTitle,
			author: {
				handle: thread.rootPost.author.handle,
				displayName: thread.rootPost.author.displayName,
				avatar: thread.rootPost.author.avatar
			},
			rootUri: thread.rootUri,
			sourceUrl: thread.rootPost.sourceUrl,
			totalPosts: chainPosts.length,
			visiblePosts: posts.length,
			hiddenPosts: hiddenPosts.length,
			characterLength: thread.characterLength,
			posts
		};
	}

	function articleExportToMarkdown(payload: ArticleExport): string {
		const lines: string[] = [
			`# ${payload.title}`,
			'',
			`By ${payload.author.displayName || `@${payload.author.handle}`} (@${payload.author.handle})`,
			`Source: ${payload.sourceUrl}`,
			`Posts: ${payload.visiblePosts} of ${payload.totalPosts}`,
			`Exported: ${payload.exportedAt}`,
			''
		];

		for (const post of payload.posts) {
			lines.push(`## Post ${post.index}`, '');
			lines.push(`${markdownLink('Open on X', post.sourceUrl)} · ${formatDate(post.createdAt)}`);
			lines.push(
				`${formatCount(post.engagement.likes)} likes · ${formatCount(post.engagement.reposts)} reposts · ${formatCount(post.engagement.replies)} replies · ${formatCount(post.engagement.quotes)} quotes`
			);
			if (post.isNoteTweet) lines.push('Note text restored from archive.');
			lines.push('');
			lines.push(...(post.paragraphs.length > 0 ? post.paragraphs : [post.text]));

			if (post.linkedUrls.length > 0) {
				lines.push('', 'Links:');
				for (const url of post.linkedUrls) {
					lines.push(`- ${url}`);
				}
			}

			if (post.fixupxEmbeds.length > 0) {
				lines.push('', 'Embedded X posts:');
				for (const embed of post.fixupxEmbeds) {
					if (embed.tweet) {
						appendEmbeddedTweetMarkdown(lines, embed.tweet);
						lines.push(`  Original: ${embed.canonicalUrl}`);
					} else {
						lines.push(`- ${markdownLink(embed.title || embed.canonicalUrl, embed.fixupxUrl)}`);
						if (embed.description) lines.push(`  ${embed.description.replace(/\n/g, ' ')}`);
						lines.push(`  Original: ${embed.canonicalUrl}`);
					}
				}
			}

			if (post.images.length > 0) {
				lines.push('', 'Images:');
				for (const image of post.images) {
					lines.push(`- ${image.fullsize}${image.alt ? ` (${image.alt})` : ''}`);
				}
			}

			lines.push('');
		}

		return `${lines.join('\n').trimEnd()}\n`;
	}

	function articleExportToCleanMarkdown(payload: ArticleExport): string {
		const lines: string[] = [`# ${payload.title}`, ''];

		for (const post of payload.posts) {
			const text = stripArticleXLinks(post.text);
			if (text) {
				lines.push(...splitPostIntoBlogParagraphs(text), '');
			}

			for (const embed of post.fixupxEmbeds) {
				if (embed.tweet) {
					appendCleanTweetMarkdown(lines, embed.tweet);
					lines.push('');
				} else if (embed.description || embed.image) {
					if (embed.description) lines.push(...splitPostIntoBlogParagraphs(stripArticleXLinks(embed.description)), '');
					if (embed.image) lines.push(`![Embedded image](${embed.image})`, '');
				}
			}

			for (const image of post.images) {
				lines.push(`![${image.alt || 'Image'}](${image.fullsize})`, '');
			}
		}

		return `${lines.join('\n').trimEnd()}\n`;
	}

	async function exportArticle(format: ExportFormat) {
		if (exportingFormat) return;
		exportingFormat = format;
		try {
			const payload = await buildArticleExport();
			const baseName = slugify(`${payload.author.handle}-${payload.title}`);
			if (format === 'json') {
				downloadTextFile(
					`${baseName}.json`,
					'application/json;charset=utf-8',
					`${JSON.stringify(payload, null, 2)}\n`
				);
			} else if (format === 'article') {
				downloadTextFile(
					`${baseName}-article.md`,
					'text/markdown;charset=utf-8',
					articleExportToCleanMarkdown(payload)
				);
			} else {
				downloadTextFile(
					`${baseName}-detailed.md`,
					'text/markdown;charset=utf-8',
					articleExportToMarkdown(payload)
				);
			}
		} finally {
			exportingFormat = null;
		}
	}
</script>

<article class="x-article">
	<header class="article-header">
		<h2>{articleTitle}</h2>
		<div class="byline">
			{#if thread.rootPost.author.avatar}
				<img src={thread.rootPost.author.avatar} alt="" class="author-avatar" />
			{/if}
			<span>
				{authorName}
				<span class="meta-detail">
					{visiblePosts.length} of {chainPosts.length} post{chainPosts.length === 1 ? '' : 's'} · {thread.characterLength.toLocaleString()} chars
				</span>
			</span>
		</div>
		<div class="article-export-row" aria-label="Blog export actions">
			<button
				type="button"
				class="export-btn wobbly-border"
				disabled={Boolean(exportingFormat)}
				onclick={() => void exportArticle('markdown')}
			>
				{exportingFormat === 'markdown' ? 'Exporting...' : 'Detailed MD'}
			</button>
			<button
				type="button"
				class="export-btn wobbly-border"
				disabled={Boolean(exportingFormat)}
				onclick={() => void exportArticle('article')}
			>
				{exportingFormat === 'article' ? 'Exporting...' : 'Article MD'}
			</button>
			<button
				type="button"
				class="export-btn wobbly-border"
				disabled={Boolean(exportingFormat)}
				onclick={() => void exportArticle('json')}
			>
				{exportingFormat === 'json' ? 'Exporting...' : 'Export JSON'}
			</button>
		</div>
	</header>

	{#if hiddenPosts.length > 0}
		<div class="restore-row">
			<span>{hiddenPosts.length} hidden</span>
			<button type="button" class="restore-all-btn" onclick={restoreAllPosts}>
				Restore
			</button>
		</div>
	{/if}

	<div class="article-body">
		{#each chainPosts as post, index (post.uri)}
			{@const hidden = hiddenUris.has(post.uri)}
			{#if !hidden}
				<section class="article-post" aria-label={`Thread post ${index + 1}`}>
					<div class="post-actions">
						<button
							type="button"
							class="open-post-btn"
							aria-label="Open this post on X"
							onclick={() => openPost(post.sourceUrl)}
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

					<div class="tweet-card wobbly-border-light" data-post-id={post.id}>
						<div class="tweet-insert-header">
							{#if index > 0}
								<span class="reply-marker" aria-hidden="true">↪</span>
							{/if}
							<div class="tweet-author">
								{#if post.author.avatar}
									<img src={post.author.avatar} alt="" class="tweet-avatar" />
								{/if}
								<span>
									<strong>{post.author.displayName || post.author.handle}</strong>
									<span>@{post.author.handle}</span>
								</span>
							</div>
							<a href={post.sourceUrl} target="_blank" rel="noopener noreferrer">
								{formatDate(post.createdAt)}
							</a>
						</div>

						<div class="tweet-text">
							{#each splitPostIntoBlogParagraphs(post.text) as paragraph}
								<p>{paragraph}</p>
							{/each}
						</div>

						{#if post.linkedUrls.length > 0}
							<div class="article-links">
								{#each post.linkedUrls as url}
									<a href={url} target="_blank" rel="noopener noreferrer">{url}</a>
								{/each}
							</div>
						{/if}

						<TwitterArchiveFixupXEmbeds {post} />

						<PostEmbedPreview post={post} wide eager />

						<div class="article-engagement" aria-label="Post engagement">
							<span>{index + 1} / {chainPosts.length}</span>
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
				</section>
			{/if}
		{/each}
	</div>
</article>

<style>
	.x-article {
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

	.article-export-row {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		margin-top: 16px;
		font-family: Inter, system-ui, sans-serif;
	}

	.export-btn {
		padding: 5px 10px;
		background: color-mix(in srgb, var(--card-bg) 92%, white 8%);
		color: var(--accent);
		border-color: var(--accent);
		font: inherit;
		font-size: 0.78rem;
		font-weight: 800;
		cursor: pointer;
	}

	.export-btn:disabled {
		cursor: wait;
		opacity: 0.58;
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
		padding: 4px 6px;
		border: 0;
		background: transparent;
		color: var(--muted);
		font: inherit;
		font-family: Inter, system-ui, sans-serif;
		font-size: 0.78rem;
		font-weight: 700;
		cursor: pointer;
	}

	.restore-all-btn:hover,
	.open-post-btn:hover,
	.hide-post-btn:hover {
		color: var(--accent);
	}

	.article-body {
		display: flex;
		flex-direction: column;
		gap: 12px;
	}

	.article-post {
		position: relative;
		display: block;
	}

	.article-post + .article-post {
		margin-top: 0;
	}

	.tweet-card {
		display: flex;
		flex-direction: column;
		gap: 12px;
		padding: 14px;
		border: 1.5px solid color-mix(in srgb, var(--control-border) 82%, transparent);
		border-radius: 8px;
		background:
			linear-gradient(135deg, color-mix(in srgb, var(--accent) 5%, transparent), transparent 44%),
			color-mix(in srgb, var(--card-bg) 94%, white 6%);
		box-shadow: var(--shadow-soft);
		font-family: Inter, system-ui, sans-serif;
	}

	.tweet-insert-header,
	.tweet-author {
		display: flex;
		align-items: center;
		gap: 10px;
	}

	.tweet-insert-header {
		justify-content: space-between;
		gap: 14px;
		color: var(--muted);
		font-size: 0.82rem;
		line-height: 1.3;
	}

	.reply-marker {
		color: var(--accent);
		font-weight: 900;
	}

	.tweet-insert-header a {
		flex: 0 0 auto;
		color: var(--muted);
		text-decoration: none;
		font-style: italic;
	}

	.tweet-insert-header a:hover {
		color: var(--accent);
	}

	.tweet-avatar {
		width: 34px;
		height: 34px;
		border-radius: 50%;
		object-fit: cover;
	}

	.tweet-author strong,
	.tweet-author span span {
		display: block;
	}

	.tweet-author strong {
		color: var(--text-ink);
		font-size: 0.9rem;
	}

	.tweet-author span span {
		color: var(--muted);
		font-size: 0.8rem;
	}

	.tweet-text {
		display: grid;
		gap: 0.74em;
		margin: 0;
		color: var(--text-ink);
		font-family: Inter, system-ui, sans-serif;
		font-size: 0.98rem;
		line-height: 1.52;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}

	.tweet-text p {
		margin: 0;
		font: inherit;
		line-height: inherit;
		letter-spacing: 0;
	}

	.article-engagement {
		display: flex;
		flex-wrap: wrap;
		gap: 8px 11px;
		color: var(--muted);
		font-family: Inter, system-ui, sans-serif;
		font-size: 0.82rem;
	}

	.article-links {
		display: grid;
		gap: 5px;
		margin: 0;
		color: var(--muted);
		font-family: Inter, system-ui, sans-serif;
		font-size: 0.85rem;
	}

	.article-links a {
		color: var(--accent);
		overflow-wrap: anywhere;
	}

	.tweet-card :global(.post-embed-preview),
	.tweet-card :global(.twitter-archive-fixupx-embeds) {
		margin-top: 0;
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
		.x-article {
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
