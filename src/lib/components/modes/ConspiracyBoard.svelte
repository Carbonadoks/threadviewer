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

	let boardEl: HTMLDivElement | undefined = $state();
	let lines: string = $state('');

	const flat = $derived(collapsed ? [] : flattenThread(thread.rootPost));

	function rotation(i: number): number {
		return ((i * 7 + 3) % 11 - 5);
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

	function computeLines() {
		if (!boardEl) return;
		const cards = boardEl.querySelectorAll('.index-card');
		if (cards.length < 2) { lines = ''; return; }

		const boardRect = boardEl.getBoundingClientRect();
		let path = '';

		for (let i = 0; i < cards.length - 1; i++) {
			const a = cards[i].getBoundingClientRect();
			const b = cards[i + 1].getBoundingClientRect();
			const x1 = a.left + a.width / 2 - boardRect.left;
			const y1 = a.top + a.height / 2 - boardRect.top;
			const x2 = b.left + b.width / 2 - boardRect.left;
			const y2 = b.top + b.height / 2 - boardRect.top;
			const cx = (x1 + x2) / 2 + (i % 2 === 0 ? 30 : -30);
			const cy = (y1 + y2) / 2 - 20;
			path += `M${x1},${y1} Q${cx},${cy} ${x2},${y2} `;
		}

		lines = path;
	}

	$effect(() => {
		if (!collapsed && boardEl) {
			// Wait for layout
			const frame = requestAnimationFrame(() => computeLines());

			const observer = new ResizeObserver(() => computeLines());
			observer.observe(boardEl);

			return () => {
				cancelAnimationFrame(frame);
				observer.disconnect();
			};
		}
	});
</script>

<div class="conspiracy-card">
	<div
		class="conspiracy-toggle"
		role="button"
		tabindex="0"
		onclick={() => oncollapsedchange(!collapsed)}
		onkeydown={handleToggleKeydown}
	>
		<div class="conspiracy-header">
			<span class="depth-badge wobbly-border">{thread.depth} deep</span>
			<span class="conspiracy-date">{formatDate(thread.rootPost.createdAt)}</span>
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
			<p class="conspiracy-preview">{preview(thread.rootPost.text)}</p>
		{/if}
	</div>

	{#if !collapsed}
		<div class="corkboard" bind:this={boardEl}>
			<svg class="string-overlay" aria-hidden="true">
				{#if lines}
					<path d={lines} fill="none" stroke="#cc0000" stroke-width="2" opacity="0.7" />
				{/if}
			</svg>

			<div class="cards-container">
				{#each flat as { post }, i}
					<div class="index-card" style="transform: rotate({rotation(i)}deg)">
						<div class="pushpin"></div>
						<p class="card-text">{post.text}</p>
						{#if post.embed?.type === 'images' && post.embed.images}
							<div class="card-images">
								{#each post.embed.images as img}
									<img src={img.thumb} alt={img.alt} class="card-img"
									 onclick={(e) => { e.stopPropagation(); openLightbox(img.fullsize, img.alt); }}
									 onkeydown={(e) => { if (e.key === 'Enter') openLightbox(img.fullsize, img.alt); }}
									 role="button" tabindex="0" style="cursor: pointer;" />
								{/each}
							</div>
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
						<span class="card-date">{formatDate(post.createdAt)}</span>
					</div>
				{/each}
			</div>
		</div>
	{/if}
</div>

<style>
	.conspiracy-card {
		margin-bottom: 24px;
		border: 1.5px solid var(--muted);
		border-radius: 8px;
		overflow: hidden;
	}

	.conspiracy-toggle {
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

	.conspiracy-header {
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

	.conspiracy-date {
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

	.conspiracy-preview {
		font-size: 0.9rem;
		color: var(--muted);
		margin: 0;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.corkboard {
		position: relative;
		background: #b8860b;
		background-image:
			radial-gradient(circle at 20% 30%, rgba(0,0,0,0.05) 0%, transparent 50%),
			radial-gradient(circle at 80% 70%, rgba(255,255,255,0.05) 0%, transparent 50%);
		padding: 24px;
		min-height: 200px;
	}

	.string-overlay {
		position: absolute;
		top: 0;
		left: 0;
		width: 100%;
		height: 100%;
		pointer-events: none;
		z-index: 1;
	}

	.cards-container {
		display: flex;
		flex-wrap: wrap;
		gap: 20px;
		position: relative;
		z-index: 2;
	}

	.index-card {
		background: #fdf5e6;
		padding: 16px;
		width: 220px;
		min-height: 100px;
		box-shadow: 3px 3px 8px rgba(0,0,0,0.3);
		position: relative;
		border: 1px solid #d4c5a0;
	}

	.pushpin {
		position: absolute;
		top: -6px;
		left: 50%;
		transform: translateX(-50%);
		width: 16px;
		height: 16px;
		border-radius: 50%;
		background: radial-gradient(circle at 40% 40%, #ff4444, #cc0000);
		box-shadow: 0 2px 4px rgba(0,0,0,0.3);
	}

	.pushpin::after {
		content: '';
		position: absolute;
		bottom: -4px;
		left: 50%;
		transform: translateX(-50%);
		width: 2px;
		height: 6px;
		background: #888;
	}

	.card-text {
		font-size: 0.85rem;
		white-space: pre-wrap;
		word-break: break-word;
		margin-top: 8px;
		color: #333;
		font-family: 'Courier New', monospace;
	}

	.card-images {
		display: flex;
		gap: 4px;
		flex-wrap: wrap;
		margin-top: 6px;
	}

	.card-img {
		max-width: 80px;
		border-radius: 2px;
	}

	.card-date {
		display: block;
		margin-top: 8px;
		font-size: 0.7rem;
		color: #888;
		font-family: 'Courier New', monospace;
	}
</style>
