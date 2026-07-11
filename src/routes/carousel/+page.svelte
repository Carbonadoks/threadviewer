<script lang="ts">
	import { onMount } from 'svelte';
	import { browser } from '$app/environment';
	import '../../app.css';
	import { getProfile, getFullThread } from '$lib/api/bluesky';
	import LoadingSpinner from '$lib/components/LoadingSpinner.svelte';
	import FontPicker from '$lib/components/FontPicker.svelte';
	import PostEmbedPreview from '$lib/components/PostEmbedPreview.svelte';
	import RouteNav from '$lib/components/RouteNav.svelte';
	import RoughBorder from '$lib/components/RoughBorder.svelte';
	import type { SelfReplyThread, ThreadPost } from '$lib/types';
	import { readCachedThread, writeCachedThread } from '$lib/utils/threadContentCache';
	import {
		buildAtUri,
		buildBskyPostUrl,
		normalizeBskyPostUrl,
		parseBskyPostUrl
	} from '$lib/utils/viewerLinks';

	const fontFamilies: Record<string, string> = {
		virgil: "'Virgil', cursive",
		caveat: "'Caveat', cursive",
		patrick: "'Patrick Hand', cursive",
		'comic-neue': "'Comic Neue', cursive",
		inter: "'Inter', sans-serif",
		system: "system-ui, -apple-system, sans-serif"
	};

	let fontKey = $state('patrick');
	let fontFamily = $derived(fontFamilies[fontKey] ?? fontFamilies.virgil);

	let urlInput = $state('');
	let loading = $state(false);
	let error: string | null = $state(null);
	let thread: (SelfReplyThread & { isTruncated?: boolean }) | null = $state(null);
	let branchChoices = $state<Record<string, number>>({});

	type CarouselLevel = {
		key: string;
		parentUri: string | null;
		items: ThreadPost[];
		selectedIndex: number;
	};

	const levels = $derived.by<CarouselLevel[]>(() => {
		if (!thread) return [];

		const rows: CarouselLevel[] = [];
		let parent: ThreadPost | null = null;
		let items: ThreadPost[] = [thread.rootPost];

		while (items.length > 0) {
			const raw = parent ? (branchChoices[parent.uri] ?? 0) : 0;
			const selectedIndex = Math.min(items.length - 1, Math.max(0, raw));
			rows.push({
				key: parent?.uri ?? 'root',
				parentUri: parent?.uri ?? null,
				items,
				selectedIndex
			});
			parent = items[selectedIndex];
			items = parent.children;
		}

		return rows;
	});

	function handleFontChange(key: string) {
		fontKey = key;
		try { localStorage.setItem('preferred-font', key); } catch {}
	}

	function updateQueryParam(url: string) {
		if (!browser) return;
		const current = new URL(window.location.href);
		if (url) {
			current.searchParams.set('url', url);
		} else {
			current.searchParams.delete('url');
		}
		window.history.replaceState({}, '', current.toString());
	}

	function selectCard(parentUri: string | null, index: number) {
		if (!parentUri) return;
		branchChoices = { ...branchChoices, [parentUri]: index };
	}

	function postAuthorName(post: ThreadPost): string {
		return post.author.displayName?.trim() || `@${post.author.handle}`;
	}

	function postUrl(post: ThreadPost): string {
		return buildBskyPostUrl(post.uri, post.author.handle) ?? '#';
	}

	function formatCardDate(createdAt: string): string {
		const ms = Date.parse(createdAt);
		if (!Number.isFinite(ms)) return '';
		const date = new Date(ms);
		const time = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
		const day = date.toLocaleDateString(undefined, {
			month: 'short',
			day: 'numeric',
			year: 'numeric'
		});
		return `${time} · ${day}`;
	}

	function centerWhenSelected(node: HTMLElement, selected: boolean) {
		// Scroll only the strip's own horizontal axis; scrollIntoView would also
		// scroll the page vertically, and every re-mounted row below a click
		// would fight over the viewport.
		function center(isSelected: boolean, behavior: ScrollBehavior) {
			if (!isSelected) return;
			const strip = node.closest('.level-strip');
			if (!(strip instanceof HTMLElement)) return;
			const stripRect = strip.getBoundingClientRect();
			const nodeRect = node.getBoundingClientRect();
			const left =
				nodeRect.left - stripRect.left + strip.scrollLeft - (strip.clientWidth - nodeRect.width) / 2;
			strip.scrollTo({ left: Math.max(0, left), behavior });
		}

		// Rows that (re)mount after a click center instantly; only a selection
		// change within an existing row animates.
		center(selected, 'auto');
		return {
			update(isSelected: boolean) {
				center(isSelected, 'smooth');
			}
		};
	}

	let loadRequestId = 0;

	async function loadThread(bskyUrl: string) {
		const normalizedUrl = normalizeBskyPostUrl(bskyUrl);
		const parsed = normalizedUrl ? parseBskyPostUrl(normalizedUrl) : null;
		if (!normalizedUrl || !parsed) {
			error = 'Invalid URL. Expected format: https://bsky.app/profile/{handle}/post/{rkey}';
			return;
		}

		const requestId = ++loadRequestId;
		loading = true;
		error = null;
		thread = null;
		branchChoices = {};
		urlInput = normalizedUrl;
		updateQueryParam(normalizedUrl);

		// Shared with treeviewer: show the cached copy first, revalidate below.
		const cached = await readCachedThread(normalizedUrl);
		if (requestId !== loadRequestId) return;
		if (cached) {
			thread = {
				rootPost: cached.rootPost,
				rootUri: cached.rootUri,
				depth: cached.depth,
				isTruncated: cached.isTruncated
			};
			loading = false;
		}

		try {
			const profile = await getProfile(parsed.handle);
			const atUri = buildAtUri(profile.did, parsed.rkey);
			if (!atUri) {
				if (!cached) error = 'Could not build an AT URI for this thread.';
				return;
			}

			const loadedThread = await getFullThread(atUri);
			if (requestId !== loadRequestId) return;
			thread = loadedThread;
			void writeCachedThread({
				url: normalizedUrl,
				rootPost: loadedThread.rootPost,
				rootUri: loadedThread.rootUri,
				depth: loadedThread.depth,
				isTruncated: loadedThread.isTruncated
			});
		} catch (e: any) {
			if (requestId !== loadRequestId || cached) return;
			if (e?.message?.includes('resolve')) {
				error = `Could not find handle "${parsed.handle}".`;
			} else {
				error = e?.message || 'Failed to load thread.';
			}
		} finally {
			if (requestId === loadRequestId) loading = false;
		}
	}

	function handleSubmit(e: Event) {
		e.preventDefault();
		if (urlInput.trim()) loadThread(urlInput.trim());
	}

	onMount(() => {
		try {
			const saved = localStorage.getItem('preferred-font');
			if (saved && saved in fontFamilies) fontKey = saved;
		} catch {}

		const params = new URLSearchParams(window.location.search);
		const urlParam = params.get('url');
		if (urlParam) {
			urlInput = urlParam;
			loadThread(urlParam);
		}
	});
</script>

<svelte:head>
	<title>Carousel - Bluesky Thread Viewer</title>
</svelte:head>

<main style="font-family: {fontFamily}">
	<header>
		<RouteNav
			current="carousel"
			align="center"
			threadUrl={urlInput}
			handle={parseBskyPostUrl(urlInput)?.handle ?? null}
		/>
		<h1>Carousel</h1>
		<p class="subtitle">Walk the reply tree one level at a time — pick a card to steer.</p>
		<FontPicker value={fontKey} onchange={handleFontChange} />
	</header>

	<form class="url-form" onsubmit={handleSubmit}>
		<input
			type="text"
			class="url-input wobbly-border-light"
			placeholder="https://bsky.app/profile/handle.bsky.social/post/..."
			bind:value={urlInput}
			disabled={loading}
		/>
		<button type="submit" class="load-btn wobbly-border" disabled={loading || !urlInput.trim()}>
			Load Thread
		</button>
	</form>

	{#if error}
		<div class="error-banner wobbly-border-light">{error}</div>
	{/if}

	{#if loading}
		<LoadingSpinner progress={{ phase: 'Loading thread...', current: 0, total: 0 }} />
	{/if}

	{#if thread}
		{#if thread.isTruncated}
			<p class="truncation-warning">Some replies may be missing</p>
		{/if}

		<div class="levels">
			{#each levels as level, depth (level.key)}
				<section class="level" aria-label={`Reply depth ${depth}`}>
					{#if level.items.length > 1}
						<div class="level-label">
							{level.selectedIndex + 1} of {level.items.length} replies
						</div>
					{/if}
					<div class="level-strip" class:single={level.items.length === 1}>
						{#each level.items as post, index (post.uri)}
							{@const selected = index === level.selectedIndex}
							<div
								class="card-slot"
								class:selected
								class:steerable={level.items.length > 1}
								use:centerWhenSelected={selected}
							>
								<button
									type="button"
									class="card-hit"
									aria-pressed={selected}
									aria-label={`Select reply by ${postAuthorName(post)}`}
									onclick={() => selectCard(level.parentUri, index)}
									disabled={level.items.length === 1}
								>
									<RoughBorder
										stroke={selected && level.items.length > 1 ? '--accent' : '#333'}
										strokeWidth={selected && level.items.length > 1 ? 2.2 : 1.3}
										padding={16}
									>
										<div class="card-head">
											{#if post.author.avatar}
												<img src={post.author.avatar} alt="" class="card-avatar" />
											{:else}
												<div class="card-avatar card-avatar--empty" aria-hidden="true"></div>
											{/if}
											<div class="card-author">
												<span class="card-name">{postAuthorName(post)}</span>
												<span class="card-handle">@{post.author.handle}</span>
											</div>
											<a
												class="card-open"
												href={postUrl(post)}
												target="_blank"
												rel="noopener noreferrer"
												title="Open on Bluesky"
												onclick={(event) => event.stopPropagation()}
											>
												↗
											</a>
										</div>

										{#if post.text}
											<p class="card-text">{post.text}</p>
										{/if}

										<div class="card-embed">
											<PostEmbedPreview {post} eager />
										</div>

										<div class="card-footer">
											<div class="card-stats">
												<span>♥ {(post.likeCount ?? 0).toLocaleString()}</span>
												<span>💬 {(post.replyCount ?? 0).toLocaleString()}</span>
												<span>🔁 {(post.repostCount ?? 0).toLocaleString()}</span>
												{#if (post.quoteCount ?? 0) > 0}
													<span>❝ {(post.quoteCount ?? 0).toLocaleString()}</span>
												{/if}
											</div>
											<span class="card-date">{formatCardDate(post.createdAt)}</span>
										</div>
									</RoughBorder>
								</button>
							</div>
						{/each}
					</div>
				</section>
			{/each}
		</div>
	{/if}
</main>

<style>
	main {
		max-width: 1100px;
		margin: 0 auto;
		padding: 28px 20px 96px;
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
	}

	.url-form {
		display: flex;
		gap: 10px;
		max-width: 640px;
		margin: 0 auto 28px;
	}

	.url-input {
		flex: 1;
		min-width: 0;
		padding: 10px 14px;
		font-size: 0.95rem;
		font-family: inherit;
		background: var(--card-bg);
		color: var(--text-ink);
	}

	.url-input::placeholder {
		color: var(--muted);
		opacity: 0.7;
	}

	.load-btn {
		padding: 10px 20px;
		font-size: 0.95rem;
		background: var(--accent);
		color: white;
		border-color: var(--border-color);
		cursor: pointer;
		white-space: nowrap;
		transition: opacity 0.2s;
	}

	.load-btn:hover:not(:disabled) {
		opacity: 0.85;
	}

	.load-btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.error-banner {
		max-width: 640px;
		margin: 0 auto 16px;
		padding: 10px 16px;
		background: #ffeaea;
		color: #a33;
		text-align: center;
		font-size: 0.95rem;
	}

	.truncation-warning {
		background: #fff3cd;
		color: #856404;
		border: 1px solid #ffc107;
		border-radius: 6px;
		padding: 6px 12px;
		font-size: 0.85rem;
		margin: 0 auto 16px;
		text-align: center;
		max-width: 640px;
	}

	.levels {
		display: flex;
		flex-direction: column;
		gap: 26px;
	}

	.level-label {
		text-align: center;
		font-family: Inter, system-ui, sans-serif;
		font-size: 0.76rem;
		letter-spacing: 0.04em;
		color: var(--muted);
		margin-bottom: 8px;
	}

	.level-strip {
		display: flex;
		align-items: flex-start;
		gap: 16px;
		overflow-x: auto;
		padding: 6px 4px 14px;
		scroll-snap-type: x proximity;
		-webkit-overflow-scrolling: touch;
	}

	.level-strip.single {
		justify-content: center;
	}

	.card-slot {
		flex: 0 0 min(420px, 86vw);
		max-width: min(420px, 86vw);
		scroll-snap-align: center;
		opacity: 0.65;
		transition: opacity 0.16s ease, transform 0.16s ease;
	}

	.card-slot:hover {
		opacity: 1;
	}

	.card-slot.selected {
		opacity: 1;
	}

	.card-slot.selected.steerable {
		transform: translateY(-3px);
	}

	.level-strip.single .card-slot {
		opacity: 1;
	}

	.card-hit {
		display: block;
		width: 100%;
		border: 0;
		background: transparent;
		padding: 0;
		text-align: left;
		font-family: inherit;
		color: var(--text-ink);
		cursor: pointer;
	}

	.card-hit:disabled {
		cursor: default;
	}

	.card-head {
		display: flex;
		align-items: center;
		gap: 10px;
	}

	.card-avatar {
		width: 40px;
		height: 40px;
		border-radius: 50%;
		object-fit: cover;
		flex-shrink: 0;
	}

	.card-avatar--empty {
		background: var(--control-border, #d9d2c2);
	}

	.card-author {
		display: flex;
		flex-direction: column;
		min-width: 0;
	}

	.card-name {
		font-family: Inter, system-ui, sans-serif;
		font-size: 0.95rem;
		font-weight: 700;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.card-handle {
		font-family: Inter, system-ui, sans-serif;
		font-size: 0.8rem;
		color: var(--muted);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.card-open {
		margin-left: auto;
		flex-shrink: 0;
		color: var(--muted);
		text-decoration: none;
		font-size: 0.95rem;
	}

	.card-open:hover {
		color: var(--accent);
	}

	.card-text {
		margin: 12px 0 0;
		font-size: 1.02rem;
		line-height: 1.55;
		white-space: pre-wrap;
		word-break: break-word;
	}

	.card-embed:not(:empty) {
		margin-top: 12px;
	}

	.card-embed :global(.post-embed-preview) {
		width: 100%;
	}

	.card-footer {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		margin-top: 14px;
		font-family: Inter, system-ui, sans-serif;
	}

	.card-stats {
		display: flex;
		gap: 14px;
		font-size: 0.8rem;
		font-weight: 600;
		color: var(--muted);
	}

	.card-date {
		font-size: 0.74rem;
		color: var(--muted);
		white-space: nowrap;
	}

	@media (max-width: 640px) {
		main {
			padding: 24px 12px 64px;
		}

		.url-form {
			flex-direction: column;
		}

		.load-btn {
			width: 100%;
		}
	}
</style>
