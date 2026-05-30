<script lang="ts">
	import type { XArchiveThread } from '$lib/api/x';
	import RoughBorder from '$lib/components/RoughBorder.svelte';
	import TwitterArchivePostNode from './TwitterArchivePostNode.svelte';

	let {
		thread,
		collapsed,
		oncollapsedchange,
		onblog,
		onopenx
	}: {
		thread: XArchiveThread;
		collapsed: boolean;
		oncollapsedchange: (collapsed: boolean) => void;
		onblog?: (rootUri: string) => void;
		onopenx?: (rootUri: string) => void;
	} = $props();

	function stableRotation(rootUri: string): number {
		let hash = 0;
		for (let i = 0; i < rootUri.length; i++) {
			hash = (hash * 31 + rootUri.charCodeAt(i)) >>> 0;
		}
		return ((hash % 21) - 10) * 0.08;
	}

	const rotation = $derived(stableRotation(thread.rootUri));

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

	function preview(text: string): string {
		const compact = text.replace(/\s+/g, ' ').trim();
		if (compact.length <= 150) return compact;
		return `${compact.slice(0, 150).trimEnd()}...`;
	}

	function handleToggleKeydown(event: KeyboardEvent) {
		if (event.key !== 'Enter' && event.key !== ' ') return;
		event.preventDefault();
		oncollapsedchange(!collapsed);
	}
</script>

<div class="x-thread-card" style="transform: rotate({rotation}deg)">
	<RoughBorder>
		<div
			class="x-thread-toggle"
			role="button"
			tabindex="0"
			onclick={() => oncollapsedchange(!collapsed)}
			onkeydown={handleToggleKeydown}
		>
			<div class="x-thread-header">
				<span class="depth-badge wobbly-border">{thread.depth} deep</span>
				<span class="posts-badge">{thread.postCount} posts</span>
				<span class="length-badge">{thread.characterLength.toLocaleString()} chars</span>
				<span class="engagement-badges">
					<span>{formatCount(thread.rootPost.likeCount)} likes</span>
					<span>{formatCount(thread.rootPost.repostCount)} reposts</span>
				</span>
				<span class="thread-date">{formatDate(thread.rootPost.createdAt)}</span>
				{#if onblog}
					<button
						class="blog-btn wobbly-border"
						onclick={(event) => {
							event.stopPropagation();
							onblog(thread.rootUri);
						}}
					>
						XBlog
					</button>
				{/if}
				{#if onopenx}
					<button
						class="open-btn wobbly-border"
						onclick={(event) => {
							event.stopPropagation();
							onopenx(thread.rootUri);
						}}
					>
						Open on X
					</button>
				{/if}
				<span class="toggle-icon">{collapsed ? '+' : '-'}</span>
			</div>
			{#if collapsed}
				<p class="thread-preview">{preview(thread.rootPost.text)}</p>
			{/if}
		</div>

		{#if !collapsed}
			<TwitterArchivePostNode post={thread.rootPost} />
		{/if}
	</RoughBorder>
</div>

<style>
	.x-thread-card {
		margin-bottom: 24px;
		transition: transform 0.2s;
	}

	.x-thread-card:hover {
		transform: rotate(0deg) !important;
	}

	.x-thread-toggle {
		display: block;
		width: 100%;
		padding: 0;
		margin: 0;
		border: 0;
		background: none;
		color: inherit;
		font: inherit;
		text-align: left;
		cursor: pointer;
	}

	.x-thread-header {
		display: flex;
		align-items: center;
		gap: 12px;
		margin-bottom: 8px;
		flex-wrap: wrap;
	}

	.depth-badge {
		display: inline-block;
		padding: 2px 12px;
		background: var(--accent);
		color: white;
		border-color: var(--text-ink);
		font-size: 0.9rem;
	}

	.posts-badge,
	.length-badge {
		color: var(--text-ink);
		font-size: 0.85rem;
		font-weight: 700;
	}

	.engagement-badges {
		display: flex;
		gap: 7px;
		flex-wrap: wrap;
		color: var(--muted);
		font-size: 0.8rem;
	}

	.thread-date {
		color: var(--muted);
		font-size: 0.85rem;
	}

	.blog-btn,
	.open-btn {
		padding: 2px 10px;
		background: var(--card-bg);
		color: var(--accent);
		border-color: var(--accent);
		font-size: 0.8rem;
		cursor: pointer;
		transition: opacity 0.2s;
	}

	.blog-btn:hover,
	.open-btn:hover {
		opacity: 0.7;
	}

	.toggle-icon {
		margin-left: auto;
		color: var(--muted);
		font-size: 1.2rem;
		font-weight: 700;
	}

	.thread-preview {
		margin: 8px 0 0;
		color: var(--text-ink);
		line-height: 1.4;
	}
</style>
