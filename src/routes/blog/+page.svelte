<script lang="ts">
	import { onMount } from 'svelte';
	import { browser } from '$app/environment';
	import '../../app.css';
	import { getProfile, getFullThread } from '$lib/api/bluesky';
	import BlogArticle from '$lib/components/BlogArticle.svelte';
	import LoadingSpinner from '$lib/components/LoadingSpinner.svelte';
	import FontPicker from '$lib/components/FontPicker.svelte';
	import RouteNav from '$lib/components/RouteNav.svelte';
	import ThreadExportButton from '$lib/components/ThreadExportButton.svelte';
	import type { SelfReplyThread } from '$lib/types';
	import { findSelfReplyChainRoot, measureSelfReplyChainDepth } from '$lib/utils/threadBlog';
	import { buildAtUri, normalizeBskyPostUrl, parseBskyPostUrl } from '$lib/utils/viewerLinks';
	import { buildYouTubePlaylists, collectYouTubeIds } from '$lib/utils/youtubePlaylist';
	import { toastError, toastSuccess } from '$lib/utils/toasts';

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

	type LoadedThread = SelfReplyThread & { isTruncated?: boolean };

	let urlInput = $state('');
	let loading = $state(false);
	let error: string | null = $state(null);
	type BlogViewMode = 'chain' | 'thread';

	let viewMode = $state<BlogViewMode>('chain');
	let loadedThreads = $state<{ chain: LoadedThread; whole: LoadedThread } | null>(null);
	let thread = $derived(
		loadedThreads ? (viewMode === 'chain' ? loadedThreads.chain : loadedThreads.whole) : null
	);

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

	function setViewMode(mode: BlogViewMode) {
		viewMode = mode;
		if (!browser) return;
		const current = new URL(window.location.href);
		current.searchParams.set('view', mode);
		window.history.replaceState({}, '', current.toString());
	}

	async function loadThread(bskyUrl: string) {
		const normalizedUrl = normalizeBskyPostUrl(bskyUrl);
		const parsed = normalizedUrl ? parseBskyPostUrl(normalizedUrl) : null;
		if (!normalizedUrl || !parsed) {
			error = 'Invalid URL. Expected format: https://bsky.app/profile/{handle}/post/{rkey}';
			return;
		}

		loading = true;
		error = null;
		loadedThreads = null;
		urlInput = normalizedUrl;
		updateQueryParam(normalizedUrl);

		try {
			const profile = await getProfile(parsed.handle);
			const atUri = buildAtUri(profile.did, parsed.rkey);
			if (!atUri) {
				error = 'Could not build an AT URI for this thread.';
				return;
			}

			const fullThread = await getFullThread(atUri);
			const chainRoot = findSelfReplyChainRoot(fullThread.rootPost, atUri);
			loadedThreads = {
				chain: {
					rootPost: chainRoot,
					rootUri: chainRoot.uri,
					depth: measureSelfReplyChainDepth(chainRoot),
					isTruncated: fullThread.isTruncated
				},
				whole: fullThread
			};
		} catch (e: any) {
			if (e?.message?.includes('resolve')) {
				error = `Could not find handle "${parsed.handle}".`;
			} else {
				error = e?.message || 'Failed to load thread.';
			}
		} finally {
			loading = false;
		}
	}

	function handleSubmit(e: Event) {
		e.preventDefault();
		if (urlInput.trim()) loadThread(urlInput.trim());
	}

	let youtubeIds = $derived(thread ? collectYouTubeIds([thread.rootPost]) : []);
	let playlists = $derived(buildYouTubePlaylists(youtubeIds));
	let playlistMenuOpen = $state(false);

	$effect(() => {
		// close the menu whenever the thread changes / has no videos
		if (youtubeIds.length === 0) playlistMenuOpen = false;
	});

	function openPlaylist(url: string) {
		window.open(url, '_blank', 'noopener,noreferrer');
		playlistMenuOpen = false;
	}

	async function copyPlaylist(url: string) {
		try {
			if (navigator.clipboard?.writeText) {
				await navigator.clipboard.writeText(url);
			} else {
				const textarea = document.createElement('textarea');
				textarea.value = url;
				textarea.style.position = 'fixed';
				textarea.style.left = '-9999px';
				document.body.appendChild(textarea);
				textarea.select();
				document.execCommand('copy');
				textarea.remove();
			}
			toastSuccess('Playlist link copied');
		} catch {
			toastError('Could not copy link');
		}
		playlistMenuOpen = false;
	}

	onMount(() => {
		try {
			const saved = localStorage.getItem('preferred-font');
			if (saved && saved in fontFamilies) fontKey = saved;
		} catch {}

		const params = new URLSearchParams(window.location.search);
		const viewParam = params.get('view');
		if (viewParam === 'chain' || viewParam === 'thread') {
			viewMode = viewParam;
		}
		const urlParam = params.get('url');
		if (urlParam) {
			urlInput = urlParam;
			loadThread(urlParam);
		}
	});
</script>

<svelte:head>
	<title>Blog - Bluesky Thread Viewer</title>
</svelte:head>

<main style="font-family: {fontFamily}">
	{#if !thread}
		<header>
			<RouteNav
				current="blog"
				align="center"
				threadUrl={urlInput}
				handle={parseBskyPostUrl(urlInput)?.handle ?? null}
			/>
			<h1>Blog</h1>
			<p class="subtitle">Self-reply chains as quiet reading</p>
			<FontPicker value={fontKey} onchange={handleFontChange} />
		</header>

		<form class="url-form" onsubmit={handleSubmit}>
			<input
				type="text"
				class="url-input"
				placeholder="https://bsky.app/profile/handle.bsky.social/post/..."
				bind:value={urlInput}
				disabled={loading}
			/>
			<button type="submit" class="load-btn" disabled={loading || !urlInput.trim()}>
				Load
			</button>
		</form>
	{/if}

	{#if error}
		<div class="error-banner wobbly-border-light">{error}</div>
	{/if}

	{#if loading}
		<LoadingSpinner progress={{ phase: 'Loading full thread...', current: 0, total: 0 }} />
	{/if}

	{#if thread}
		<div class="reader-topbar">
			<button type="button" class="change-btn" onclick={() => (loadedThreads = null)}>
				Change thread
			</button>
			<div class="mode-toggle" role="group" aria-label="Blog format">
				<button
					type="button"
					class="mode-btn"
					class:active={viewMode === 'chain'}
					onclick={() => setViewMode('chain')}
				>
					Self-reply
				</button>
				<button
					type="button"
					class="mode-btn"
					class:active={viewMode === 'thread'}
					onclick={() => setViewMode('thread')}
				>
					Whole thread
				</button>
			</div>
			<div class="playlist-menu">
				<button
					type="button"
					class="playlist-btn"
					aria-haspopup="menu"
					aria-expanded={playlistMenuOpen}
					onclick={() => (playlistMenuOpen = !playlistMenuOpen)}
					disabled={youtubeIds.length === 0}
					title={youtubeIds.length === 0
						? 'No YouTube links in this thread'
						: `${youtubeIds.length} video${youtubeIds.length === 1 ? '' : 's'} found`}
				>
					▶ Playlist{youtubeIds.length > 0 ? ` (${youtubeIds.length})` : ''} ▾
				</button>

				{#if playlistMenuOpen && playlists.length > 0}
					<div class="playlist-popover wobbly-border-light" role="menu">
						{#if playlists.length > 1}
							<p class="playlist-note">
								YouTube caps anonymous playlists at 50 videos, so this is split into
								{playlists.length} parts.
							</p>
						{/if}
						{#each playlists as playlist, i}
							<div class="playlist-row">
								<span class="playlist-label">
									{playlists.length > 1 ? `Part ${i + 1}` : 'Playlist'}
									<span class="playlist-count">{playlist.ids.length} video{playlist.ids.length === 1 ? '' : 's'}</span>
								</span>
								<div class="playlist-actions">
									<button type="button" role="menuitem" onclick={() => openPlaylist(playlist.url)}>Open</button>
									<button type="button" role="menuitem" onclick={() => copyPlaylist(playlist.url)}>Copy link</button>
								</div>
							</div>
						{/each}
					</div>
				{/if}
			</div>
			<ThreadExportButton {thread} label="Export MD" compact />
		</div>
		{#if thread.isTruncated}
			<p class="truncation-warning">Some replies may be missing</p>
		{/if}
		<BlogArticle {thread} mode={viewMode} />
	{/if}
</main>

<style>
	main {
		max-width: 1040px;
		margin: 0 auto;
		padding: 28px 20px 72px;
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
		max-width: 680px;
		margin: 0 auto 28px;
	}

	.url-input {
		flex: 1;
		min-width: 0;
		padding: 12px 0;
		font-size: 0.95rem;
		font-family: inherit;
		background: transparent;
		color: var(--text-ink);
		border: 0;
		border-bottom: 1px solid var(--control-border);
		outline: none;
	}

	.url-input:focus {
		border-bottom-color: var(--accent);
	}

	.url-input::placeholder {
		color: var(--muted);
		opacity: 0.7;
	}

	.load-btn {
		padding: 8px 4px;
		font-size: 0.95rem;
		background: transparent;
		color: var(--accent);
		border: 0;
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

	.reader-topbar {
		display: flex;
		justify-content: center;
		align-items: center;
		gap: 18px;
		margin-bottom: 32px;
	}

	.mode-toggle {
		display: flex;
		gap: 2px;
	}

	.mode-btn {
		border: 0;
		background: transparent;
		color: var(--muted);
		font-family: Inter, system-ui, sans-serif;
		font-size: 0.8rem;
		padding: 4px 8px;
		cursor: pointer;
	}

	.mode-btn:hover {
		color: var(--accent);
	}

	.mode-btn.active {
		color: var(--accent);
		font-weight: 700;
		text-decoration: underline;
		text-underline-offset: 4px;
	}

	.change-btn {
		border: 0;
		background: transparent;
		color: var(--muted);
		font-family: Inter, system-ui, sans-serif;
		font-size: 0.8rem;
		cursor: pointer;
	}

	.change-btn:hover {
		color: var(--accent);
	}

	.playlist-menu {
		position: relative;
		display: inline-flex;
	}

	.playlist-btn {
		border: 1px solid var(--control-border, rgba(63, 56, 78, 0.24));
		border-radius: 7px;
		background: var(--control-bg, var(--card-bg, #fff));
		color: var(--text-ink, #2d2733);
		font-family: Inter, system-ui, sans-serif;
		font-size: 0.72rem;
		font-weight: 800;
		min-height: 24px;
		padding: 0 8px;
		cursor: pointer;
	}

	.playlist-btn:hover:not(:disabled) {
		background: var(--control-bg-hover, var(--muted-surface, #f2eee4));
		color: var(--accent);
	}

	.playlist-btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.playlist-popover {
		position: absolute;
		top: calc(100% + 6px);
		right: 0;
		z-index: 40;
		width: min(280px, calc(100vw - 32px));
		display: grid;
		gap: 8px;
		padding: 10px;
		border-radius: 8px;
		background: color-mix(in srgb, var(--card-bg, #fff) 96%, white);
		box-shadow: var(--shadow-soft, 0 10px 24px rgba(0, 0, 0, 0.14));
		color: var(--text-ink, #2d2733);
		font-family: Inter, system-ui, sans-serif;
	}

	.playlist-note {
		margin: 0;
		font-size: 0.72rem;
		line-height: 1.35;
		color: var(--muted, #6b6670);
	}

	.playlist-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 10px;
	}

	.playlist-label {
		display: flex;
		flex-direction: column;
		font-size: 0.78rem;
		font-weight: 800;
	}

	.playlist-count {
		font-size: 0.68rem;
		font-weight: 600;
		color: var(--muted, #6b6670);
	}

	.playlist-actions {
		display: flex;
		gap: 4px;
	}

	.playlist-actions button {
		border: 1px solid var(--control-border, rgba(63, 56, 78, 0.24));
		border-radius: 6px;
		background: var(--control-bg, var(--card-bg, #fff));
		color: var(--text-ink, #2d2733);
		font-family: inherit;
		font-size: 0.72rem;
		font-weight: 800;
		padding: 3px 8px;
		cursor: pointer;
	}

	.playlist-actions button:hover {
		background: var(--control-bg-hover, var(--muted-surface, #f2eee4));
		color: var(--accent);
	}

	.error-banner {
		max-width: 680px;
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
		margin: 0 auto 12px;
		text-align: center;
		max-width: 680px;
	}

	@media (max-width: 640px) {
		main {
			padding: 24px 16px 48px;
		}

		.url-form {
			flex-direction: column;
		}

		.load-btn {
			width: 100%;
		}
	}
</style>
