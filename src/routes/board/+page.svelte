<script lang="ts">
	import { onMount } from 'svelte';
	import { browser } from '$app/environment';
	import '../../app.css';
	import { getProfile, getFullThread } from '$lib/api/bluesky';
	import LoadingSpinner from '$lib/components/LoadingSpinner.svelte';
	import FontPicker from '$lib/components/FontPicker.svelte';
	import BoardView from '$lib/components/BoardView.svelte';
	import RouteNav from '$lib/components/RouteNav.svelte';
	import type { SelfReplyThread } from '$lib/types';
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

	function handleFontChange(key: string) {
		fontKey = key;
		try { localStorage.setItem('preferred-font', key); } catch {}
	}

	let urlInput = $state('');
	let loading = $state(false);
	let error: string | null = $state(null);
	let thread = $state<(SelfReplyThread & { isTruncated?: boolean }) | null>(null);

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
			thread = await getFullThread(atUri);
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
	<title>Board</title>
</svelte:head>

<main style="font-family: {fontFamily}">
	<header>
		<RouteNav
			current="board"
			align="center"
			threadUrl={urlInput}
			handle={parseBskyPostUrl(urlInput)?.handle ?? null}
		/>
		<h1>Board</h1>
		<p class="subtitle">Paste a Bluesky post URL to view its thread on the board</p>
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
		<BoardView {thread} />
	{/if}
</main>

<style>
	main {
		max-width: 100%;
		margin: 0 auto;
		padding: 32px 20px;
	}

	header {
		text-align: center;
		margin-bottom: 24px;
		max-width: 1200px;
		margin-left: auto;
		margin-right: auto;
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
		max-width: 600px;
		margin: 0 auto 24px;
	}

	.url-input {
		flex: 1;
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
		max-width: 600px;
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
		margin-bottom: 8px;
		text-align: center;
		max-width: 600px;
		margin-left: auto;
		margin-right: auto;
	}
</style>
