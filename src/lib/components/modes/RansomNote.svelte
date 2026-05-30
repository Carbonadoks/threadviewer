<script lang="ts">
	import type { SelfReplyThread } from '$lib/types';
	import { flattenThread } from '$lib/utils/threadFlattener';
	import { openLightbox } from '$lib/stores/lightbox';
	import LinkedPostEmbeds from '$lib/components/LinkedPostEmbeds.svelte';
	import RecordEmbed from '$lib/components/RecordEmbed.svelte';

	let {
		thread,
		collapsed,
		oncollapsedchange,
		onexpand,
		onblog,
		onshare,
		onopenbluesky
	}: {
		thread: SelfReplyThread;
		collapsed: boolean;
		oncollapsedchange: (collapsed: boolean) => void;
		onexpand?: (rootUri: string) => void;
		onblog?: (rootUri: string) => void;
		onshare?: (rootUri: string) => void;
		onopenbluesky?: (rootUri: string) => void;
	} = $props();

	const flat = $derived(collapsed ? [] : flattenThread(thread.rootPost));

	const fonts = ['Georgia', 'Arial', 'Courier New', 'Times New Roman', 'Impact', 'Comic Sans MS'];
	const bgs = ['#ffeb3b', 'white', '#ccc', '#ffb6c1', '#90ee90', 'transparent'];
	const colors = ['black', '#8b0000', '#00008b'];

	function seededRandom(seed: number): number {
		const x = Math.sin(seed * 9301 + 49297) * 49297;
		return x - Math.floor(x);
	}

	function wordStyle(wordIndex: number): string {
		const r = (n: number) => seededRandom(wordIndex * 7 + n);
		const font = fonts[Math.floor(r(1) * fonts.length)];
		const size = 0.8 + r(2) * 0.8;
		const rot = (r(3) - 0.5) * 10;
		const bg = bgs[Math.floor(r(4) * bgs.length)];
		const color = colors[Math.floor(r(5) * colors.length)];

		return `font-family: '${font}', sans-serif; font-size: ${size.toFixed(2)}rem; transform: rotate(${rot.toFixed(1)}deg); background: ${bg}; color: ${color};`;
	}

	function formatDate(iso: string): string {
		const d = new Date(iso);
		return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
	}

	function preview(text: string): string {
		if (text.length <= 120) return text;
		return text.slice(0, 120) + '...';
	}

	function handleToggleKeydown(event: KeyboardEvent) {
		if (event.key !== 'Enter' && event.key !== ' ') return;
		event.preventDefault();
		oncollapsedchange(!collapsed);
	}
</script>

<div class="ransom-card">
	<div
		class="ransom-toggle"
		role="button"
		tabindex="0"
		onclick={() => oncollapsedchange(!collapsed)}
		onkeydown={handleToggleKeydown}
	>
		<div class="ransom-header">
			<span class="depth-badge wobbly-border">{thread.depth} deep</span>
			<span class="ransom-date">{formatDate(thread.rootPost.createdAt)}</span>
			{#if onexpand}
				<button class="expand-btn wobbly-border" onclick={(e) => { e.stopPropagation(); onexpand(thread.rootUri); }}>Full thread</button>
			{/if}
			{#if onblog}
				<button class="blog-btn wobbly-border" onclick={(e) => { e.stopPropagation(); onblog(thread.rootUri); }}>Blog</button>
			{/if}
			{#if onshare}
				<button class="share-btn wobbly-border" onclick={(e) => { e.stopPropagation(); onshare(thread.rootUri); }}>Share</button>
			{/if}
			{#if onopenbluesky}
				<button class="open-btn wobbly-border" onclick={(e) => { e.stopPropagation(); onopenbluesky(thread.rootUri); }}>Open on Bluesky</button>
			{/if}
			<span class="toggle-icon">{collapsed ? '+' : '-'}</span>
		</div>
		{#if collapsed}
			<p class="ransom-preview">{preview(thread.rootPost.text)}</p>
		{/if}
	</div>

	{#if !collapsed}
		<div class="ransom-body">
			{#each flat as { post }, postIndex}
				{@const globalOffset = flat.slice(0, postIndex).reduce((sum, f) => sum + f.post.text.split(/\s+/).length, 0)}
				<div class="ransom-post">
					{#each post.text.split(/\s+/).filter(Boolean) as word, wi}
						<span class="ransom-word" style={wordStyle(globalOffset + wi)}>{word}</span>
					{/each}
				</div>

				{#if post.embed?.type === 'images' && post.embed.images}
					<div class="ransom-images">
						{#each post.embed.images as img}
							<img src={img.thumb} alt={img.alt} class="ransom-img"
							 onclick={(e) => { e.stopPropagation(); openLightbox(img.fullsize, img.alt); }}
							 onkeydown={(e) => { if (e.key === 'Enter') openLightbox(img.fullsize, img.alt); }}
							 role="button" tabindex="0" style="cursor: pointer;" />
						{/each}
					</div>
				{/if}
				{#if post.embed?.type === 'external' && post.embed.external}
					<a href={post.embed.external.uri} target="_blank" rel="noopener" class="ransom-link">
						{post.embed.external.title}
					</a>
				{/if}
				{#if post.embed?.record}
					<RecordEmbed record={post.embed.record} dense />
				{/if}
				<LinkedPostEmbeds
					text={post.text}
					externalUri={post.embed?.external?.uri}
					urls={post.linkedUrls ?? []}
					excludeUris={[post.uri, post.embed?.record?.uri ?? '']}
				/>
			{/each}
		</div>
	{/if}
</div>

<style>
	.ransom-card {
		margin-bottom: 24px;
		background: var(--card-bg);
		border: 1.5px solid var(--muted);
		border-radius: 8px;
		overflow: hidden;
	}

	.ransom-toggle {
		display: block;
		width: 100%;
		background: none;
		border: none;
		padding: 12px 16px;
		cursor: pointer;
		text-align: left;
		color: inherit;
		font: inherit;
	}

	.ransom-header {
		display: flex;
		align-items: center;
		gap: 12px;
		margin-bottom: 4px;
	}

	.depth-badge {
		display: inline-block;
		padding: 2px 12px;
		font-size: 0.9rem;
		background: var(--accent);
		color: white;
		border-color: var(--text-ink);
	}

	.ransom-date {
		font-size: 0.85rem;
		color: var(--muted);
	}

	.expand-btn, .blog-btn, .share-btn, .open-btn {
		padding: 2px 10px;
		font-size: 0.8rem;
		background: var(--card-bg);
		color: var(--accent);
		border-color: var(--accent);
		cursor: pointer;
		transition: opacity 0.2s;
	}

	.expand-btn:hover, .blog-btn:hover, .share-btn:hover, .open-btn:hover {
		opacity: 0.7;
	}

	.toggle-icon {
		margin-left: auto;
		font-size: 1.2rem;
		color: var(--muted);
		font-weight: bold;
	}

	.ransom-preview {
		font-size: 0.9rem;
		color: var(--muted);
		margin: 0;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.ransom-body {
		padding: 16px;
		background: #f5f0e1;
	}

	.ransom-post {
		display: flex;
		flex-wrap: wrap;
		gap: 4px 6px;
		margin-bottom: 16px;
		align-items: baseline;
	}

	.ransom-word {
		display: inline-block;
		padding: 2px 6px;
		border: 1px solid rgba(0,0,0,0.15);
		box-shadow: 1px 1px 2px rgba(0,0,0,0.1);
		line-height: 1.4;
	}

	.ransom-images {
		display: flex;
		gap: 8px;
		flex-wrap: wrap;
		margin-bottom: 12px;
	}

	.ransom-img {
		max-width: 200px;
		border-radius: 4px;
	}

	.ransom-link {
		display: block;
		margin-bottom: 12px;
		font-size: 0.9rem;
		color: var(--accent);
	}
</style>
