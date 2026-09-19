<script lang="ts">
	import type { Block, Span } from '$lib/utils/atprotoBlog';
	import ReaderBlocks from './ReaderBlocks.svelte';

	let { blocks }: { blocks: Block[] } = $props();

	function hostOf(url: string): string {
		try {
			return new URL(url).hostname.replace(/^www\./, '');
		} catch {
			return url;
		}
	}
</script>

{#snippet spans(list: Span[])}
	{#each list as span}
		{#if span.image}
			<img class="inline-img" src={span.image} alt={span.text} loading="lazy" />
		{:else}
			{@const m = span.marks ?? []}
			{#snippet marked()}
				{#if m.includes('code')}<code>{span.text}</code>{:else}<span
						class:b={m.includes('bold')}
						class:i={m.includes('italic')}
						class:u={m.includes('underline')}
						class:s={m.includes('strike')}
						class:hl={m.includes('highlight')}>{span.text}</span
					>{/if}
			{/snippet}
			{#if span.href}<a href={span.href} target="_blank" rel="noopener noreferrer">{@render marked()}</a
				>{:else}{@render marked()}{/if}
		{/if}
	{/each}
{/snippet}

{#each blocks as block}
	{#if block.type === 'paragraph'}
		<p>{@render spans(block.spans)}</p>
	{:else if block.type === 'heading'}
		{#if block.level <= 2}
			<h2>{@render spans(block.spans)}</h2>
		{:else if block.level === 3}
			<h3>{@render spans(block.spans)}</h3>
		{:else}
			<h4>{@render spans(block.spans)}</h4>
		{/if}
	{:else if block.type === 'quote'}
		<blockquote><ReaderBlocks blocks={block.blocks} /></blockquote>
	{:else if block.type === 'list'}
		{#if block.ordered}
			<ol start={block.start}>
				{#each block.items as item}
					<li><ReaderBlocks blocks={item.blocks} /></li>
				{/each}
			</ol>
		{:else}
			<ul>
				{#each block.items as item}
					<li class:task={item.checked !== undefined}>
						{#if item.checked !== undefined}<input type="checkbox" checked={item.checked} disabled />{/if}
						<ReaderBlocks blocks={item.blocks} />
					</li>
				{/each}
			</ul>
		{/if}
	{:else if block.type === 'code'}
		<pre><code>{block.code}</code></pre>
	{:else if block.type === 'image'}
		<figure>
			<img src={block.src} alt={block.alt ?? ''} loading="lazy" />
			{#if block.alt}<figcaption>{block.alt}</figcaption>{/if}
		</figure>
	{:else if block.type === 'card'}
		<a class="card" href={block.url} target="_blank" rel="noopener noreferrer">
			{#if block.image}<img src={block.image} alt="" loading="lazy" />{/if}
			<span class="card-text">
				<span class="card-title">{block.title ?? hostOf(block.url)}</span>
				{#if block.description}<span class="card-desc">{block.description}</span>{/if}
				<span class="card-host">{hostOf(block.url)}</span>
			</span>
		</a>
	{:else if block.type === 'hr'}
		<hr />
	{/if}
{/each}

<style>
	p,
	li {
		font-family: ui-serif, Georgia, Cambria, 'Times New Roman', serif;
		font-size: clamp(1.08rem, 2.2vw, 1.25rem);
		line-height: 1.75;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}

	p {
		margin: 0 0 1.2em;
	}

	h2,
	h3,
	h4 {
		font-family: Inter, system-ui, sans-serif;
		line-height: 1.25;
		margin: 1.8em 0 0.6em;
	}

	h2 {
		font-size: 1.55rem;
	}

	h3 {
		font-size: 1.25rem;
	}

	h4 {
		font-size: 1.08rem;
	}

	ul,
	ol {
		margin: 0 0 1.2em;
		padding-left: 1.4em;
	}

	li :global(p) {
		margin: 0 0 0.3em;
	}

	li.task {
		list-style: none;
		margin-left: -1.3em;
		display: flex;
		gap: 0.5em;
		align-items: baseline;
	}

	blockquote {
		margin: 0 0 1.2em;
		padding: 0.1em 0 0.1em 1.1em;
		border-left: 3px solid var(--accent);
		color: color-mix(in srgb, var(--text-ink) 78%, transparent);
		font-style: italic;
	}

	pre {
		margin: 0 0 1.2em;
		padding: 14px 16px;
		overflow-x: auto;
		background: var(--muted-surface);
		border-radius: 8px;
		font-size: 0.88rem;
		line-height: 1.5;
	}

	code {
		font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
		font-size: 0.88em;
	}

	:not(pre) > code {
		padding: 0.1em 0.3em;
		border-radius: 4px;
		background: var(--muted-surface);
	}

	figure {
		margin: 1.6em 0;
		text-align: center;
	}

	figure img {
		max-width: 100%;
		border-radius: 6px;
	}

	figcaption {
		margin-top: 0.5em;
		color: var(--muted);
		font-family: Inter, system-ui, sans-serif;
		font-size: 0.82rem;
	}

	.inline-img {
		max-width: 100%;
		vertical-align: middle;
	}

	hr {
		margin: 2.4em auto;
		width: 30%;
		border: 0;
		border-top: 1px solid var(--control-border);
	}

	a {
		color: var(--accent);
		text-underline-offset: 3px;
	}

	.b {
		font-weight: 700;
	}

	.i {
		font-style: italic;
	}

	.u {
		text-decoration: underline;
	}

	.s {
		text-decoration: line-through;
	}

	.hl {
		background: color-mix(in srgb, var(--accent) 22%, transparent);
	}

	.card {
		display: flex;
		gap: 14px;
		margin: 0 0 1.4em;
		padding: 12px 14px;
		border: 1px solid var(--control-border);
		border-radius: 10px;
		background: var(--link-card-bg);
		color: var(--text-ink);
		text-decoration: none;
		font-family: Inter, system-ui, sans-serif;
	}

	.card:hover {
		border-color: var(--accent);
	}

	.card img {
		width: 96px;
		height: 72px;
		object-fit: cover;
		border-radius: 6px;
		flex-shrink: 0;
	}

	.card-text {
		display: flex;
		flex-direction: column;
		gap: 3px;
		min-width: 0;
	}

	.card-title {
		font-weight: 700;
		font-size: 0.95rem;
	}

	.card-desc {
		font-size: 0.84rem;
		color: var(--muted);
		overflow: hidden;
		display: -webkit-box;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		-webkit-box-orient: vertical;
	}

	.card-host {
		font-size: 0.75rem;
		color: var(--muted);
	}
</style>
