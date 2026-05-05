<script lang="ts">
	import { onMount } from 'svelte';
	import { browser } from '$app/environment';
	import '../../app.css';
	import { getProfile, getFullThread } from '$lib/api/bluesky';
	import CachedJudgments from '$lib/components/CachedJudgments.svelte';
	import FontPicker from '$lib/components/FontPicker.svelte';
	import LoadingSpinner from '$lib/components/LoadingSpinner.svelte';
	import RouteNav from '$lib/components/RouteNav.svelte';
	import ThreadJudgePanel from '$lib/components/ThreadJudgePanel.svelte';
	import type { SelfReplyThread } from '$lib/types';
	import { DEFAULT_THREAD_JUDGE_MODEL, normalizeThreadJudgeModel } from '$lib/utils/judgeModels';
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
	let judgeModel = $state(DEFAULT_THREAD_JUDGE_MODEL);

	function handleFontChange(key: string) {
		fontKey = key;
		try {
			localStorage.setItem('preferred-font', key);
		} catch {}
	}

	function updateQueryParam(url: string, model: string) {
		if (!browser) return;
		const current = new URL(window.location.href);
		if (url) {
			current.searchParams.set('url', url);
		} else {
			current.searchParams.delete('url');
		}
		if (model) {
			current.searchParams.set('judgeModel', model);
		} else {
			current.searchParams.delete('judgeModel');
		}
		window.history.replaceState({}, '', current.toString());
	}

	async function loadThread(bskyUrl: string, options: { judgeModel?: string | null } = {}) {
		const normalizedUrl = normalizeBskyPostUrl(bskyUrl);
		const parsed = normalizedUrl ? parseBskyPostUrl(normalizedUrl) : null;
		if (!normalizedUrl || !parsed) {
			error = 'Invalid URL. Expected format: https://bsky.app/profile/{handle}/post/{rkey}';
			return;
		}

		const nextJudgeModel =
			normalizeThreadJudgeModel(options.judgeModel) ??
			normalizeThreadJudgeModel(judgeModel) ??
			DEFAULT_THREAD_JUDGE_MODEL;

		loading = true;
		error = null;
		thread = null;
		urlInput = normalizedUrl;
		judgeModel = nextJudgeModel;
		updateQueryParam(normalizedUrl, nextJudgeModel);

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

	function handleSubmit(event: Event) {
		event.preventDefault();
		if (urlInput.trim()) {
			loadThread(urlInput.trim());
		}
	}

	function handleCachedJudgeSelect(threadUrl: string, model: string) {
		urlInput = threadUrl;
		loadThread(threadUrl, { judgeModel: model });
	}

	function handleJudgeModelChange(model: string) {
		const nextJudgeModel = normalizeThreadJudgeModel(model) ?? DEFAULT_THREAD_JUDGE_MODEL;
		judgeModel = nextJudgeModel;
		updateQueryParam(normalizeBskyPostUrl(urlInput) ?? '', nextJudgeModel);
	}

	onMount(() => {
		try {
			const saved = localStorage.getItem('preferred-font');
			if (saved && saved in fontFamilies) {
				fontKey = saved;
			}
		} catch {}

		const params = new URLSearchParams(window.location.search);
		const urlParam = params.get('url');
		const modelParam = normalizeThreadJudgeModel(params.get('judgeModel')) ?? DEFAULT_THREAD_JUDGE_MODEL;
		judgeModel = modelParam;
		if (urlParam) {
			urlInput = urlParam;
			loadThread(urlParam, { judgeModel: modelParam });
		}
	});
</script>

<svelte:head>
	<title>Thread Judge</title>
</svelte:head>

<main style="font-family: {fontFamily}">
	<header>
		<RouteNav
			current="judge"
			align="center"
			threadUrl={urlInput}
			handle={parseBskyPostUrl(urlInput)?.handle ?? null}
		/>
		<h1>Thread Judge</h1>
		<p class="subtitle">Load a Bluesky thread to inspect cached or live Gemini judgments</p>
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

	<CachedJudgments onselect={handleCachedJudgeSelect} />

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
		{#key thread.rootUri}
			<ThreadJudgePanel
				thread={thread}
				autoloadCache
				initialModel={judgeModel}
				onmodelchange={handleJudgeModelChange}
			/>
		{/key}
	{/if}
</main>

<style>
	main {
		max-width: 980px;
		margin: 0 auto;
		padding: 32px 20px 48px;
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
		max-width: 720px;
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
		max-width: 720px;
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
		margin-bottom: 10px;
		text-align: center;
		max-width: 720px;
		margin-left: auto;
		margin-right: auto;
	}

	@media (max-width: 640px) {
		.url-form {
			flex-direction: column;
		}
	}
</style>
