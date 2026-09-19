<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import '../../app.css';
	import FontPicker from '$lib/components/FontPicker.svelte';
	import LoadingSpinner from '$lib/components/LoadingSpinner.svelte';
	import ReaderBlocks from '$lib/components/ReaderBlocks.svelte';
	import RouteNav from '$lib/components/RouteNav.svelte';
	import SearchBar from '$lib/components/SearchBar.svelte';
	import { postExcerpt, readingMinutes, type BlogPost } from '$lib/utils/atprotoBlog';
	import { loadReaderBlog, type ReaderBlog } from '$lib/utils/atprotoBlogLoader';

	const fontFamilies: Record<string, string> = {
		virgil: "'Virgil', cursive",
		caveat: "'Caveat', cursive",
		patrick: "'Patrick Hand', cursive",
		'comic-neue': "'Comic Neue', cursive",
		inter: "'Inter', sans-serif",
		system: 'system-ui, -apple-system, sans-serif'
	};

	let fontKey = $state('patrick');
	let fontFamily = $derived(fontFamilies[fontKey] ?? fontFamilies.virgil);

	const handleParam = $derived(page.url.searchParams.get('handle')?.trim() ?? '');
	const postParam = $derived(page.url.searchParams.get('post') ?? '');

	let loading = $state(false);
	let progress = $state('');
	let error: string | null = $state(null);
	let blog = $state<ReaderBlog | null>(null);
	let loadedFor = '';
	let tagFilter = $state<string | null>(null);
	let showSources = $state(false);

	// Keep loaded repos around so going back and forth between index and post is instant.
	const cache = new Map<string, ReaderBlog>();

	const currentPost = $derived<BlogPost | null>(
		blog && postParam ? (blog.posts.find((p) => `${p.collection}/${p.rkey}` === postParam) ?? null) : null
	);
	const allTags = $derived(
		blog ? [...new Set(blog.posts.flatMap((p) => p.tags))].sort((a, b) => a.localeCompare(b)) : []
	);
	const visiblePosts = $derived(
		blog ? (tagFilter ? blog.posts.filter((p) => p.tags.includes(tagFilter!)) : blog.posts) : []
	);
	const authorName = $derived(
		blog ? blog.identity.displayName || `@${blog.identity.handle ?? blog.identity.did}` : ''
	);
	const blogTitle = $derived(
		blog ? (blog.publications.length === 1 ? blog.publications[0].name : authorName) : ''
	);
	const blogDescription = $derived(
		blog ? (blog.publications.length === 1 ? blog.publications[0].description : blog.identity.bio) : undefined
	);
	const publicationFor = (post: BlogPost) =>
		blog && post.publicationUri ? blog.publications.find((p) => p.uri === post.publicationUri) : undefined;

	function hrefFor(params: Record<string, string | null>): string {
		const url = new URL(page.url);
		for (const [k, v] of Object.entries(params)) {
			if (v) url.searchParams.set(k, v);
			else url.searchParams.delete(k);
		}
		return `${url.pathname}${url.search}`;
	}

	function formatDate(iso?: string): string {
		if (!iso) return '';
		const d = new Date(iso);
		return Number.isNaN(d.getTime())
			? ''
			: d.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
	}

	async function load(handle: string) {
		loadedFor = handle;
		error = null;
		tagFilter = null;
		const cached = cache.get(handle);
		if (cached) {
			blog = cached;
			return;
		}
		blog = null;
		loading = true;
		progress = '';
		try {
			const result = await loadReaderBlog(handle, (msg) => (progress = msg));
			if (loadedFor !== handle) return;
			cache.set(handle, result);
			blog = result;
		} catch (e: any) {
			if (loadedFor === handle) error = e?.message ?? 'Failed to load.';
		} finally {
			if (loadedFor === handle) loading = false;
		}
	}

	$effect(() => {
		const handle = handleParam;
		if (handle && handle !== loadedFor) void load(handle);
		if (!handle) {
			loadedFor = '';
			blog = null;
		}
	});

	$effect(() => {
		// Scroll to the top when switching between index and a post.
		void postParam;
		if (typeof window !== 'undefined') window.scrollTo({ top: 0 });
	});

	function openAuthor(value: string) {
		const handle = value.trim().replace(/^@/, '');
		if (handle) goto(hrefFor({ handle, post: null }));
	}

	function handleFontChange(key: string) {
		fontKey = key;
		try {
			localStorage.setItem('preferred-font', key);
		} catch {}
	}

	onMount(() => {
		try {
			const saved = localStorage.getItem('preferred-font');
			if (saved && saved in fontFamilies) fontKey = saved;
		} catch {}
	});
</script>

<svelte:head>
	<title>{currentPost ? `${currentPost.title} – ` : ''}{blogTitle ? `${blogTitle} – ` : ''}Reader</title>
</svelte:head>

<main style="font-family: {fontFamily}">
	{#if !blog}
		<header>
			<RouteNav current="reader" align="center" handle={handleParam || null} />
			<h1>Reader</h1>
			<p class="subtitle">Read anyone's atproto blog posts — standard.site, Leaflet, WhiteWind, GreenGale, pckt & more</p>
			<FontPicker value={fontKey} onchange={handleFontChange} />
		</header>

		<div class="search-wrap">
			<SearchBar
				onsearch={openAuthor}
				onprofile={(profile) => openAuthor(profile.handle)}
				disabled={loading}
				initialHandle={handleParam}
				placeholder="Author handle or DID…"
				buttonLabel="Read"
			/>
		</div>
	{/if}

	{#if error}
		<div class="error-banner wobbly-border-light">{error}</div>
	{/if}

	{#if loading}
		<LoadingSpinner progress={{ phase: progress || 'Loading…', current: 0, total: 0 }} />
	{/if}

	{#if blog && currentPost}
		{@const post = currentPost}
		{@const pub = publicationFor(post)}
		<div class="reader-topbar">
			<a class="change-btn" href={hrefFor({ post: null })}>← All posts</a>
		</div>
		<article class="post">
			<header class="post-header">
				{#if pub}<a class="pub-name" href={hrefFor({ post: null })}>{pub.name}</a>{/if}
				<h2>{post.title}</h2>
				{#if post.subtitle}<p class="post-subtitle">{post.subtitle}</p>{/if}
				<div class="byline">
					{#if blog.identity.avatar}<img class="author-avatar" src={blog.identity.avatar} alt="" />{/if}
					<span>
						{authorName}
						<span class="meta-detail">
							{formatDate(post.publishedAt)}{post.publishedAt ? ' · ' : ''}{readingMinutes(post)} min read
							· <span class="source" title={post.collection}>{post.source}</span>
						</span>
					</span>
				</div>
			</header>
			{#if post.coverImage}
				<img class="cover" src={post.coverImage} alt="" />
			{/if}
			{#if post.blocks.length}
				<ReaderBlocks blocks={post.blocks} />
			{:else}
				<p class="empty">This record has no readable content.</p>
			{/if}
			<footer class="post-footer">
				{#if post.tags.length}
					<div class="tags">
						{#each post.tags as tag}
							<a class="tag" href={hrefFor({ post: null })} onclick={() => (tagFilter = tag)}>#{tag}</a>
						{/each}
					</div>
				{/if}
				<div class="post-links">
					{#if post.canonicalUrl}
						<a href={post.canonicalUrl} target="_blank" rel="noopener noreferrer">Original ↗</a>
					{/if}
					<a href={`https://pds.ls/${post.uri}`} target="_blank" rel="noopener noreferrer">Record ↗</a>
				</div>
			</footer>
		</article>
	{:else if blog}
		{#if postParam}
			<div class="error-banner wobbly-border-light">That post wasn't found in this repo.</div>
		{/if}
		<div class="reader-topbar">
			<a class="change-btn" href={hrefFor({ handle: null, post: null })}>Change author</a>
		</div>
		<header class="blog-header">
			{#if blog.publications.length === 1 && blog.publications[0].icon}
				<img class="blog-avatar" src={blog.publications[0].icon} alt="" />
			{:else if blog.identity.avatar}
				<img class="blog-avatar" src={blog.identity.avatar} alt="" />
			{/if}
			<h1>{blogTitle}</h1>
			{#if blog.identity.handle}<p class="subtitle">@{blog.identity.handle}</p>{/if}
			{#if blogDescription}<p class="blog-desc">{blogDescription}</p>{/if}
			{#if blog.publications.length > 1}
				<p class="pubs">
					{#each blog.publications as pub, i}
						{#if i > 0}<span> · </span>{/if}
						{#if pub.url}<a href={pub.url} target="_blank" rel="noopener noreferrer">{pub.name}</a>{:else}{pub.name}{/if}
					{/each}
				</p>
			{/if}
		</header>

		{#if allTags.length}
			<div class="tag-filter">
				<button type="button" class:active={!tagFilter} onclick={() => (tagFilter = null)}>All</button>
				{#each allTags as tag}
					<button type="button" class:active={tagFilter === tag} onclick={() => (tagFilter = tag)}>#{tag}</button>
				{/each}
			</div>
		{/if}

		{#if visiblePosts.length === 0}
			<p class="empty">
				No blog-like records found in this repo.
				{blog.collections.length} collection{blog.collections.length === 1 ? '' : 's'} checked.
			</p>
		{:else}
			<ol class="post-list">
				{#each visiblePosts as post (post.uri)}
					<li>
						<a class="post-link" href={hrefFor({ post: `${post.collection}/${post.rkey}` })}>
							<span class="post-date">{formatDate(post.publishedAt)}</span>
							<span class="post-title">{post.title}</span>
							{#if postExcerpt(post)}<span class="post-excerpt">{postExcerpt(post)}</span>{/if}
							<span class="post-meta">
								{readingMinutes(post)} min · {post.source}{post.heuristic ? ' (guessed)' : ''}
							</span>
						</a>
					</li>
				{/each}
			</ol>
		{/if}

		<div class="sources">
			<button type="button" class="sources-toggle" onclick={() => (showSources = !showSources)}>
				{showSources ? 'Hide' : 'Show'} sources ({blog.sources.length})
			</button>
			{#if showSources}
				<ul>
					{#each blog.sources as source}
						<li>
							<code>{source.collection}</code> — {source.count} post{source.count === 1 ? '' : 's'}
							{#if source.heuristic}<em>(heuristic: {source.reason})</em>{/if}
						</li>
					{/each}
					{#each blog.warnings as warning}
						<li class="warning">{warning}</li>
					{/each}
				</ul>
				<p class="all-collections">
					All collections: {blog.collections.join(', ') || 'none'}
				</p>
			{/if}
		</div>
	{/if}
</main>

<style>
	main {
		max-width: 1040px;
		margin: 0 auto;
		padding: 28px 20px 72px;
		color: var(--text-ink);
	}

	header {
		text-align: center;
		margin-bottom: 24px;
	}

	h1 {
		font-size: 2rem;
		color: var(--text-ink);
		margin: 8px 0 4px;
	}

	.subtitle {
		color: var(--muted);
		font-size: 1rem;
		margin: 0;
	}

	.search-wrap {
		max-width: 680px;
		margin: 0 auto 28px;
	}

	.reader-topbar {
		display: flex;
		justify-content: center;
		margin-bottom: 32px;
	}

	.change-btn {
		color: var(--muted);
		font-family: Inter, system-ui, sans-serif;
		font-size: 0.8rem;
		text-decoration: none;
	}

	.change-btn:hover {
		color: var(--accent);
	}

	.error-banner {
		max-width: 680px;
		margin: 0 auto 16px;
		padding: 10px 16px;
		background: var(--error-bg);
		color: #a33;
		text-align: center;
		font-size: 0.95rem;
	}

	/* Index */
	.blog-header {
		max-width: 680px;
		margin: 0 auto 36px;
	}

	.blog-avatar {
		width: 72px;
		height: 72px;
		border-radius: 50%;
		object-fit: cover;
	}

	.blog-desc {
		margin: 14px auto 0;
		color: var(--muted);
		font-family: Inter, system-ui, sans-serif;
		font-size: 0.92rem;
		line-height: 1.5;
		white-space: pre-wrap;
	}

	.pubs {
		margin-top: 10px;
		font-family: Inter, system-ui, sans-serif;
		font-size: 0.85rem;
	}

	.pubs a,
	.post-links a,
	.pub-name {
		color: var(--accent);
	}

	.tag-filter {
		display: flex;
		flex-wrap: wrap;
		justify-content: center;
		gap: 4px;
		max-width: 680px;
		margin: 0 auto 24px;
	}

	.tag-filter button {
		border: 0;
		background: transparent;
		color: var(--muted);
		font-family: Inter, system-ui, sans-serif;
		font-size: 0.78rem;
		padding: 3px 6px;
		cursor: pointer;
	}

	.tag-filter button.active,
	.tag-filter button:hover {
		color: var(--accent);
	}

	.tag-filter button.active {
		font-weight: 700;
	}

	.post-list {
		list-style: none;
		max-width: 680px;
		margin: 0 auto;
		padding: 0;
	}

	.post-list li + li {
		border-top: 1px solid var(--control-border);
	}

	.post-link {
		display: flex;
		flex-direction: column;
		gap: 4px;
		padding: 20px 0;
		color: inherit;
		text-decoration: none;
	}

	.post-date,
	.post-meta {
		color: var(--muted);
		font-family: Inter, system-ui, sans-serif;
		font-size: 0.78rem;
	}

	.post-title {
		font-family: Inter, ui-serif, Georgia, serif;
		font-size: 1.35rem;
		font-weight: 650;
		line-height: 1.25;
	}

	.post-link:hover .post-title {
		color: var(--accent);
	}

	.post-excerpt {
		font-family: ui-serif, Georgia, Cambria, serif;
		font-size: 1rem;
		line-height: 1.55;
		color: color-mix(in srgb, var(--text-ink) 80%, transparent);
	}

	.empty {
		text-align: center;
		color: var(--muted);
	}

	.sources {
		max-width: 680px;
		margin: 48px auto 0;
		font-family: Inter, system-ui, sans-serif;
		font-size: 0.8rem;
		color: var(--muted);
		text-align: center;
	}

	.sources ul {
		text-align: left;
		padding-left: 1.2em;
	}

	.sources .warning {
		color: var(--danger-text);
	}

	.sources-toggle {
		border: 0;
		background: transparent;
		color: var(--muted);
		font: inherit;
		cursor: pointer;
	}

	.sources-toggle:hover {
		color: var(--accent);
	}

	.all-collections {
		text-align: left;
		word-break: break-word;
	}

	/* Article */
	.post {
		max-width: 680px;
		margin: 0 auto;
	}

	.post-header {
		text-align: left;
		margin: 0 0 36px;
	}

	.pub-name {
		font-family: Inter, system-ui, sans-serif;
		font-size: 0.82rem;
		font-weight: 700;
		text-decoration: none;
	}

	.post-header h2 {
		margin: 6px 0 0;
		font-family: Inter, ui-serif, Georgia, serif;
		font-size: clamp(2rem, 5vw, 3.4rem);
		font-weight: 650;
		line-height: 1.06;
	}

	.post-subtitle {
		margin: 12px 0 0;
		color: var(--muted);
		font-family: ui-serif, Georgia, serif;
		font-size: 1.2rem;
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

	.cover {
		display: block;
		width: 100%;
		max-height: 420px;
		object-fit: cover;
		border-radius: 8px;
		margin-bottom: 32px;
	}

	.post-footer {
		margin-top: 48px;
		padding-top: 16px;
		border-top: 1px solid var(--control-border);
		font-family: Inter, system-ui, sans-serif;
		font-size: 0.82rem;
	}

	.tags {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		margin-bottom: 10px;
	}

	.tag {
		color: var(--muted);
		text-decoration: none;
	}

	.tag:hover {
		color: var(--accent);
	}

	.post-links {
		display: flex;
		gap: 16px;
	}

	@media (max-width: 640px) {
		main {
			padding: 24px 16px 48px;
		}
	}
</style>
