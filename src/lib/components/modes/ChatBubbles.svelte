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

	function formatTime(iso: string): string {
		const d = new Date(iso);
		return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
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

<div class="chat-card">
	<div
		class="chat-toggle"
		role="button"
		tabindex="0"
		onclick={() => oncollapsedchange(!collapsed)}
		onkeydown={handleToggleKeydown}
	>
		<div class="chat-header">
			<span class="depth-badge wobbly-border">{thread.depth} deep</span>
			<span class="chat-date">{formatDate(thread.rootPost.createdAt)}</span>
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
			<p class="chat-preview">{preview(thread.rootPost.text)}</p>
		{/if}
	</div>

	{#if !collapsed}
		<div class="chat-messages">
			{#each flat as { post, depth }, i}
				{@const isSent = depth % 2 === 0}
				<div class="bubble-row" class:sent={isSent} class:received={!isSent}>
					<div class="bubble" class:bubble-sent={isSent} class:bubble-received={!isSent}>
						<p class="bubble-text">{post.text}</p>
						{#if post.embed?.type === 'images' && post.embed.images}
							<div class="bubble-images">
								{#each post.embed.images as img}
									<img src={img.thumb} alt={img.alt} class="bubble-img"
									 onclick={(e) => { e.stopPropagation(); openLightbox(img.fullsize, img.alt); }}
									 onkeydown={(e) => { if (e.key === 'Enter') openLightbox(img.fullsize, img.alt); }}
									 role="button" tabindex="0" style="cursor: pointer;" />
								{/each}
							</div>
						{/if}
						{#if post.embed?.type === 'external' && post.embed.external}
							<a href={post.embed.external.uri} target="_blank" rel="noopener" class="bubble-link">
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
						<span class="bubble-time">{formatTime(post.createdAt)}</span>
					</div>
				</div>
				{#if i === flat.length - 1}
					<div class="read-receipt">Read</div>
				{/if}
			{/each}

			<div class="typing-indicator">
				<span class="dot"></span>
				<span class="dot"></span>
				<span class="dot"></span>
			</div>
		</div>
	{/if}
</div>

<style>
	.chat-card {
		margin-bottom: 24px;
		background: var(--card-bg);
		border: 1.5px solid var(--muted);
		border-radius: 16px;
		overflow: hidden;
	}

	.chat-toggle {
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

	.chat-header {
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

	.chat-date {
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

	.chat-preview {
		font-size: 0.9rem;
		color: var(--muted);
		margin: 0;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.chat-messages {
		padding: 8px 16px 16px;
		background: #e5ddd5;
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.bubble-row {
		display: flex;
	}

	.bubble-row.sent {
		justify-content: flex-end;
	}

	.bubble-row.received {
		justify-content: flex-start;
	}

	.bubble {
		max-width: 75%;
		padding: 8px 12px;
		border-radius: 12px;
		position: relative;
		word-break: break-word;
	}

	.bubble-sent {
		background: #dcf8c6;
		border-bottom-right-radius: 2px;
	}

	.bubble-sent::after {
		content: '';
		position: absolute;
		right: -6px;
		bottom: 0;
		width: 0;
		height: 0;
		border: 6px solid transparent;
		border-left-color: #dcf8c6;
		border-bottom-color: #dcf8c6;
	}

	.bubble-received {
		background: white;
		border-bottom-left-radius: 2px;
	}

	.bubble-received::after {
		content: '';
		position: absolute;
		left: -6px;
		bottom: 0;
		width: 0;
		height: 0;
		border: 6px solid transparent;
		border-right-color: white;
		border-bottom-color: white;
	}

	.bubble-text {
		font-size: 0.95rem;
		white-space: pre-wrap;
		margin-bottom: 4px;
		color: #111;
		font-family: system-ui, -apple-system, sans-serif;
	}

	.bubble-time {
		font-size: 0.7rem;
		color: #999;
		float: right;
		margin-top: 2px;
		font-family: system-ui, sans-serif;
	}

	.bubble-images {
		display: flex;
		gap: 4px;
		flex-wrap: wrap;
		margin-bottom: 4px;
	}

	.bubble-img {
		max-width: 150px;
		border-radius: 6px;
	}

	.bubble-link {
		font-size: 0.85rem;
		color: #0645ad;
		display: block;
		margin-bottom: 4px;
	}

	.read-receipt {
		text-align: right;
		font-size: 0.7rem;
		color: #53bdeb;
		font-family: system-ui, sans-serif;
		padding-right: 8px;
	}

	.typing-indicator {
		display: flex;
		gap: 4px;
		padding: 10px 14px;
		background: white;
		border-radius: 12px;
		border-bottom-left-radius: 2px;
		width: fit-content;
	}

	.dot {
		width: 8px;
		height: 8px;
		background: #999;
		border-radius: 50%;
		animation: bounce 1.4s infinite ease-in-out both;
	}

	.dot:nth-child(2) {
		animation-delay: 0.16s;
	}

	.dot:nth-child(3) {
		animation-delay: 0.32s;
	}

	@keyframes bounce {
		0%, 80%, 100% { transform: scale(0); }
		40% { transform: scale(1); }
	}
</style>
