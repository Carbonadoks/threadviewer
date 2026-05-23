<script lang="ts">
	import { onMount } from 'svelte';
	import { browser } from '$app/environment';
	import '../../app.css';
	import { getProfile, getFullThread } from '$lib/api/bluesky';
	import BlogArticle from '$lib/components/BlogArticle.svelte';
	import LoadingSpinner from '$lib/components/LoadingSpinner.svelte';
	import FontPicker from '$lib/components/FontPicker.svelte';
	import RouteNav from '$lib/components/RouteNav.svelte';
	import type { SelfReplyThread } from '$lib/types';
	import { findSelfReplyChainRoot, measureSelfReplyChainDepth } from '$lib/utils/threadBlog';
	import { buildAtUri, normalizeBskyPostUrl, parseBskyPostUrl } from '$lib/utils/viewerLinks';

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

	async function loadThread(bskyUrl: string) {
		const normalizedUrl = normalizeBskyPostUrl(bskyUrl);
		const parsed = normalizedUrl ? parseBskyPostUrl(normalizedUrl) : null;
		if (!normalizedUrl || !parsed) {
			error = 'Invalid URL. Expected format: https://bsky.app/profile/{handle}/post/{rkey}';
			return;
		}

		loading = true;
		error = null;
		thread = null;
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
			thread = {
				rootPost: chainRoot,
				rootUri: chainRoot.uri,
				depth: measureSelfReplyChainDepth(chainRoot),
				isTruncated: fullThread.isTruncated
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
			<button type="button" class="change-btn" onclick={() => (thread = null)}>
				Change thread
			</button>
		</div>
		{#if thread.isTruncated}
			<p class="truncation-warning">Some replies may be missing</p>
		{/if}
		<BlogArticle {thread} />
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
		margin-bottom: 32px;
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
