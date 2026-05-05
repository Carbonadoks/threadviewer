<script lang="ts">
	import type { SelfReplyThread, ThreadPost } from '$lib/types';
	import RoughBorder from './RoughBorder.svelte';
	import PostNode from './PostNode.svelte';

	let {
		thread,
		collapsed,
		highlightedPostUri = null,
		oncollapsedchange,
		onexpand,
		onshare,
		onopenbluesky
	}: {
		thread: SelfReplyThread;
		collapsed: boolean;
		highlightedPostUri?: string | null;
		oncollapsedchange: (collapsed: boolean) => void;
		onexpand?: (rootUri: string) => void;
		onshare?: (rootUri: string) => void;
		onopenbluesky?: (rootUri: string) => void;
	} = $props();

	function stableRotation(rootUri: string): number {
		let hash = 0;
		for (let i = 0; i < rootUri.length; i++) {
			hash = (hash * 31 + rootUri.charCodeAt(i)) >>> 0;
		}
		return ((hash % 21) - 10) * 0.08;
	}

	const rotation = $derived(stableRotation(thread.rootUri));

	function countPosts(post: ThreadPost): number {
		return 1 + post.children.reduce((s, c) => s + countPosts(c), 0);
	}

	function countByAuthor(post: ThreadPost, counts = new Map<string, { handle: string; count: number }>()): Map<string, { handle: string; count: number }> {
		const key = post.author.did;
		const entry = counts.get(key);
		if (entry) entry.count++;
		else counts.set(key, { handle: post.author.handle, count: 1 });
		for (const child of post.children) countByAuthor(child, counts);
		return counts;
	}

	const totalPosts = $derived(countPosts(thread.rootPost));
	const authorCounts = $derived([...countByAuthor(thread.rootPost).values()].sort((a, b) => b.count - a.count));

	function formatDate(iso: string): string {
		const d = new Date(iso);
		return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
	}

	function preview(text: string): string {
		if (text.length <= 120) return text;
		return text.slice(0, 120) + '...';
	}
</script>

<div class="thread-card" style="transform: rotate({rotation}deg)">
	<RoughBorder>
		<button class="thread-toggle" onclick={() => oncollapsedchange(!collapsed)}>
			<div class="thread-header">
				<span class="depth-badge wobbly-border">{thread.depth} deep</span>
				<span class="posts-badge">{totalPosts} posts</span>
				<span class="author-counts">
					{#each authorCounts as ac}
						<span class="author-count">@{ac.handle}: {ac.count}</span>
					{/each}
				</span>
				<span class="thread-date">{formatDate(thread.rootPost.createdAt)}</span>
				{#if onexpand}
					<button class="expand-btn wobbly-border" onclick={(e) => { e.stopPropagation(); onexpand(thread.rootUri); }}>Full thread</button>
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
				<p class="thread-preview">{preview(thread.rootPost.text)}</p>
			{/if}
		</button>
		{#if !collapsed}
			<PostNode post={thread.rootPost} level={0} {highlightedPostUri} />
		{/if}
	</RoughBorder>
</div>

<style>
	.thread-card {
		margin-bottom: 24px;
		transition: transform 0.2s;
	}

	.thread-card:hover {
		transform: rotate(0deg) !important;
	}

	.thread-toggle {
		display: block;
		width: 100%;
		background: none;
		border: none;
		padding: 0;
		margin: 0;
		cursor: pointer;
		text-align: left;
		color: inherit;
		font: inherit;
	}

	.thread-header {
		display: flex;
		align-items: center;
		gap: 12px;
		margin-bottom: 8px;
	}

	.depth-badge {
		display: inline-block;
		padding: 2px 12px;
		font-size: 0.9rem;
		background: var(--accent);
		color: white;
		border-color: var(--text-ink);
	}

	.posts-badge {
		font-size: 0.85rem;
		font-weight: 600;
		color: var(--text-ink);
	}

	.author-counts {
		display: flex;
		gap: 8px;
		flex-wrap: wrap;
	}

	.author-count {
		font-size: 0.8rem;
		color: var(--muted);
	}

	.thread-date {
		font-size: 0.85rem;
		color: var(--muted);
	}

	.expand-btn, .share-btn, .open-btn {
		padding: 2px 10px;
		font-size: 0.8rem;
		background: var(--card-bg);
		color: var(--accent);
		border-color: var(--accent);
		cursor: pointer;
		transition: opacity 0.2s;
	}

	.expand-btn:hover, .share-btn:hover, .open-btn:hover {
		opacity: 0.7;
	}

	.toggle-icon {
		margin-left: auto;
		font-size: 1.2rem;
		color: var(--muted);
		font-weight: bold;
	}

	.thread-preview {
		font-size: 0.9rem;
		color: var(--muted);
		margin: 0 0 4px;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
</style>
