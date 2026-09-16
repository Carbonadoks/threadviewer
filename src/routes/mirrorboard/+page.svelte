<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { browser } from '$app/environment';
	import '../../app.css';
	import { getFullThread, getProfile } from '$lib/api/bluesky';
	import FontPicker from '$lib/components/FontPicker.svelte';
	import LoadingSpinner from '$lib/components/LoadingSpinner.svelte';
	import ParallelBoardView from '$lib/components/ParallelBoardView.svelte';
	import RouteNav from '$lib/components/RouteNav.svelte';
	import type { SelfReplyThread } from '$lib/types';
	import { buildAtUri, normalizeBskyPostUrl, parseBskyPostUrl } from '$lib/utils/viewerLinks';

	type MirrorStatus = 'queued' | 'generating' | 'ready' | 'error';
	type MirrorImage = {
		key: string;
		alt: string;
		status: MirrorStatus;
		src?: string;
		error?: string;
	};
	type ImagegenHealth = {
		backend?: string;
		model_id?: string;
		cuda_available?: boolean;
		loaded?: boolean;
	};
	type ImagegenResponse = {
		image_base64: string;
		format: 'png' | 'jpeg' | 'webp';
	};

	const DEFAULT_BACKEND_URL = 'http://127.0.0.1:8008';
	const BACKEND_URL_STORAGE_KEY = 'abstractfeed-imagegen-url';
	const fontFamilies: Record<string, string> = {
		virgil: "'Virgil', cursive",
		caveat: "'Caveat', cursive",
		patrick: "'Patrick Hand', cursive",
		'comic-neue': "'Comic Neue', cursive",
		inter: "'Inter', sans-serif",
		system: 'system-ui, -apple-system, sans-serif'
	};

	let fontKey = $state('patrick');
	let fontFamily = $derived(fontFamilies[fontKey] ?? fontFamilies.virgil);
	let urlInput = $state('');
	let backendUrl = $state(DEFAULT_BACKEND_URL);
	let imageSize = $state(512);
	let steps = $state(8);
	let guidanceScale = $state(2);
	let loading = $state(false);
	let generating = $state(false);
	let checkingBackend = $state(false);
	let error: string | null = $state(null);
	let backendError: string | null = $state(null);
	let backendHealth: ImagegenHealth | null = $state(null);
	let thread = $state<(SelfReplyThread & { isTruncated?: boolean }) | null>(null);
	let mirrors = $state<Record<string, MirrorImage>>({});
	let showingMirrors = $state<Record<string, boolean>>({});
	let generationToken = 0;
	let activeController: AbortController | null = null;
	const objectUrls = new Map<string, string>();

	let backendBaseUrl = $derived(backendUrl.trim().replace(/\/+$/, '') || DEFAULT_BACKEND_URL);
	let mirrorList = $derived(Object.values(mirrors));
	let readyCount = $derived(mirrorList.filter((image) => image.status === 'ready').length);
	let pendingCount = $derived(
		mirrorList.filter((image) => image.status === 'queued' || image.status === 'generating').length
	);
	let failedCount = $derived(mirrorList.filter((image) => image.status === 'error').length);
	let imageOverrides = $derived.by(() =>
		Object.fromEntries(
			mirrorList
				.filter(
					(image): image is MirrorImage & { src: string } =>
						image.status === 'ready' && Boolean(image.src)
				)
				.map((image) => [image.key, image.src])
		)
	);

	function handleFontChange(key: string) {
		fontKey = key;
		try {
			localStorage.setItem('preferred-font', key);
		} catch {}
	}

	function updateQueryParam(url: string) {
		if (!browser) return;
		const current = new URL(window.location.href);
		if (url) current.searchParams.set('url', url);
		else current.searchParams.delete('url');
		window.history.replaceState({}, '', current.toString());
	}

	function revokeImages() {
		for (const src of objectUrls.values()) URL.revokeObjectURL(src);
		objectUrls.clear();
	}

	function resetMirrors() {
		generationToken += 1;
		activeController?.abort();
		activeController = null;
		generating = false;
		revokeImages();
		mirrors = {};
		showingMirrors = {};
	}

	function setMirror(key: string, patch: Partial<MirrorImage>) {
		const current = mirrors[key];
		if (!current) return;
		mirrors = { ...mirrors, [key]: { ...current, ...patch } };
	}

	function handleImagesDiscovered(images: Array<{ key: string; alt: string }>) {
		let next = mirrors;
		let changed = false;
		for (const image of images) {
			const alt = image.alt.trim();
			if (!image.key || !alt || next[image.key]) continue;
			if (!changed) next = { ...next };
			next[image.key] = { key: image.key, alt, status: 'queued' };
			changed = true;
		}
		if (!changed) return;
		mirrors = next;
		if (!backendError && !checkingBackend) void generateQueuedImages();
	}

	function base64ToBlob(base64: string, mediaType: string): Blob {
		const binary = atob(base64);
		const bytes = new Uint8Array(binary.length);
		for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
		return new Blob([bytes], { type: mediaType });
	}

	async function readErrorMessage(response: Response): Promise<string> {
		try {
			const payload = (await response.json()) as { detail?: string | Array<string | { msg?: string }> };
			if (typeof payload.detail === 'string') return payload.detail;
			if (Array.isArray(payload.detail)) {
				return payload.detail.map((item) => (typeof item === 'string' ? item : item.msg)).join(', ');
			}
		} catch {}
		return `ImageGen request failed with HTTP ${response.status}`;
	}

	async function checkBackend(): Promise<boolean> {
		checkingBackend = true;
		backendError = null;
		try {
			const response = await fetch(`${backendBaseUrl}/health`);
			if (!response.ok) throw new Error(`ImageGen health check failed with HTTP ${response.status}`);
			backendHealth = (await response.json()) as ImagegenHealth;
			if (browser) localStorage.setItem(BACKEND_URL_STORAGE_KEY, backendBaseUrl);
			return true;
		} catch (cause: any) {
			backendHealth = null;
			backendError = cause?.message || `Could not reach ImageGen at ${backendBaseUrl}.`;
			return false;
		} finally {
			checkingBackend = false;
		}
	}

	async function reconnectBackend() {
		if (await checkBackend()) void generateQueuedImages();
	}

	async function generateOne(image: MirrorImage, token: number) {
		setMirror(image.key, { status: 'generating', error: undefined });
		const controller = new AbortController();
		activeController = controller;
		try {
			const response = await fetch(`${backendBaseUrl}/generate`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					prompt: image.alt,
					width: imageSize,
					height: imageSize,
					steps,
					guidance_scale: guidanceScale,
					format: 'png'
				}),
				signal: controller.signal
			});
			if (!response.ok) throw new Error(await readErrorMessage(response));
			const payload = (await response.json()) as ImagegenResponse;
			if (!payload.image_base64) throw new Error('ImageGen response did not include image data.');
			const src = URL.createObjectURL(base64ToBlob(payload.image_base64, `image/${payload.format}`));
			if (token !== generationToken) {
				URL.revokeObjectURL(src);
				return;
			}
			objectUrls.set(image.key, src);
			setMirror(image.key, { status: 'ready', src });
		} catch (cause: any) {
			if (cause?.name !== 'AbortError' && token === generationToken) {
				setMirror(image.key, { status: 'error', error: cause?.message || 'Image generation failed.' });
			}
		} finally {
			if (activeController === controller) activeController = null;
		}
	}

	async function generateQueuedImages() {
		if (generating || checkingBackend) return;
		if (backendError && !(await checkBackend())) return;
		const token = generationToken;
		generating = true;
		try {
			while (token === generationToken) {
				const next = Object.values(mirrors).find((image) => image.status === 'queued');
				if (!next) break;
				await generateOne(next, token);
			}
		} finally {
			if (token === generationToken) generating = false;
		}
	}

	function retryFailed() {
		mirrors = Object.fromEntries(
			Object.entries(mirrors).map(([key, image]) => [
				key,
				image.status === 'error' ? { ...image, status: 'queued' as const, error: undefined } : image
			])
		);
		void generateQueuedImages();
	}

	function toggleImageMirror(key: string) {
		showingMirrors = { ...showingMirrors, [key]: showingMirrors[key] === false };
	}

	function stopGeneration() {
		generationToken += 1;
		activeController?.abort();
		activeController = null;
		generating = false;
		mirrors = Object.fromEntries(
			Object.entries(mirrors).map(([key, image]) => [
				key,
				image.status === 'generating' ? { ...image, status: 'queued' as const } : image
			])
		);
	}

	async function loadThread(rawUrl: string) {
		const normalizedUrl = normalizeBskyPostUrl(rawUrl);
		const parsed = normalizedUrl ? parseBskyPostUrl(normalizedUrl) : null;
		if (!normalizedUrl || !parsed) {
			error = 'Invalid URL. Expected format: https://bsky.app/profile/{handle}/post/{rkey}';
			return;
		}

		resetMirrors();
		loading = true;
		error = null;
		thread = null;
		urlInput = normalizedUrl;
		updateQueryParam(normalizedUrl);
		try {
			const profile = await getProfile(parsed.handle);
			const atUri = buildAtUri(profile.did, parsed.rkey);
			if (!atUri) throw new Error('Could not build an AT URI for this thread.');
			thread = await getFullThread(atUri);
			if (await checkBackend()) void generateQueuedImages();
		} catch (cause: any) {
			error = cause?.message || 'Failed to load thread.';
		} finally {
			loading = false;
		}
	}

	function handleSubmit(event: SubmitEvent) {
		event.preventDefault();
		if (urlInput.trim()) void loadThread(urlInput.trim());
	}

	onMount(() => {
		try {
			const savedFont = localStorage.getItem('preferred-font');
			if (savedFont && savedFont in fontFamilies) fontKey = savedFont;
			backendUrl = localStorage.getItem(BACKEND_URL_STORAGE_KEY) || DEFAULT_BACKEND_URL;
		} catch {}
		const urlParam = new URL(window.location.href).searchParams.get('url');
		if (urlParam) {
			urlInput = urlParam;
			void loadThread(urlParam);
		} else {
			void checkBackend();
		}
	});

	onDestroy(() => resetMirrors());
</script>

<svelte:head>
	<title>Mirror Board</title>
	<meta name="description" content="A parallel Bluesky thread board whose described images are regenerated from their alt text." />
</svelte:head>

<main style:font-family={fontFamily}>
	<header>
		<RouteNav
			current="mirrorboard"
			align="center"
			threadUrl={urlInput}
			handle={parseBskyPostUrl(urlInput)?.handle ?? null}
		/>
		<h1>Mirror Board</h1>
		<p class="subtitle">A parallel board where image alt text becomes the prompt for its mirror image.</p>
		<FontPicker value={fontKey} onchange={handleFontChange} />
	</header>

	<section class="controls wobbly-border-light" aria-label="Mirror board controls">
		<form class="url-form" onsubmit={handleSubmit}>
			<input
				type="text"
				class="url-input"
				placeholder="https://bsky.app/profile/handle.bsky.social/post/..."
				bind:value={urlInput}
				disabled={loading}
			/>
			<button type="submit" disabled={loading || !urlInput.trim()}>Load thread</button>
		</form>
		<div class="generator-controls">
			<label>
				<span>ImageGen</span>
				<input type="url" bind:value={backendUrl} disabled={generating || checkingBackend} />
			</label>
			<label><span>Size</span><select bind:value={imageSize} disabled={generating}><option value={384}>384</option><option value={512}>512</option><option value={768}>768</option></select></label>
			<label><span>Steps</span><input type="number" min="1" max="12" bind:value={steps} disabled={generating} /></label>
			<label><span>Guidance</span><input type="number" min="0" max="20" step="0.1" bind:value={guidanceScale} disabled={generating} /></label>
			<button type="button" class="secondary" onclick={() => void reconnectBackend()} disabled={checkingBackend || generating}>Check</button>
			{#if pendingCount > 0 && !generating}
				<button type="button" class="secondary" onclick={() => void generateQueuedImages()}>Resume</button>
			{/if}
			{#if generating}<button type="button" class="danger" onclick={stopGeneration}>Stop</button>{/if}
			{#if failedCount > 0}<button type="button" class="secondary" onclick={retryFailed} disabled={generating}>Retry failed</button>{/if}
		</div>
		<div class="status-line">
			<span class:offline={Boolean(backendError)}>{checkingBackend ? 'checking backend' : backendError ? 'backend offline' : backendHealth?.loaded ? 'backend loaded' : 'backend ready'}</span>
			<span>{readyCount} mirrored</span>
			<span>{pendingCount} pending</span>
			{#if failedCount}<span class="offline">{failedCount} failed</span>{/if}
			<span>Images without alt text stay original.</span>
		</div>
	</section>

	{#if error || backendError}
		<div class="error-banner wobbly-border-light">{error || backendError}</div>
	{/if}
	{#if loading}
		<LoadingSpinner progress={{ phase: 'Loading thread...', current: 0, total: 0 }} />
	{/if}
	{#if thread}
		{#if thread.isTruncated}<p class="truncation-warning">Some replies may be missing</p>{/if}
		<ParallelBoardView
			{thread}
			{imageOverrides}
			imageMirrorVisibility={showingMirrors}
			showImageAltOverlays
			showImageMirrorButtons
			showGalleryAltFilter
			onImageMirrorToggle={toggleImageMirror}
			onImagesDiscovered={handleImagesDiscovered}
		/>
	{/if}
</main>

<style>
	main { max-width: 100%; margin: 0 auto; padding: 24px 20px 32px; }
	header { max-width: 1200px; margin: 0 auto 20px; text-align: center; }
	h1 { margin: 8px 0 4px; color: var(--text-ink); font-size: 2rem; }
	.subtitle { margin: 0 0 12px; color: var(--muted); }
	.controls { display: grid; gap: 12px; max-width: 1200px; margin: 0 auto 20px; padding: 14px; background: var(--panel-bg); }
	.url-form { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 10px; }
	.generator-controls { display: grid; grid-template-columns: minmax(240px, 1fr) repeat(3, minmax(82px, auto)) auto auto auto; gap: 9px; align-items: end; }
	.generator-controls label { display: grid; gap: 4px; color: var(--muted); font-size: 0.78rem; font-weight: 700; text-transform: uppercase; }
	input, select, button { min-height: 40px; border: 1px solid var(--control-border); border-radius: 7px; font: inherit; }
	input, select { min-width: 0; padding: 8px 10px; background: var(--input-bg); color: var(--text-ink); }
	button { padding: 8px 14px; background: var(--accent); color: white; cursor: pointer; font-weight: 700; }
	button.secondary { background: var(--muted-surface); color: var(--text-ink); }
	button.danger { background: var(--danger-text); }
	button:disabled { cursor: not-allowed; opacity: 0.5; }
	.status-line { display: flex; flex-wrap: wrap; gap: 8px 16px; color: var(--muted); font-size: 0.85rem; }
	.status-line span:first-child { color: var(--success-text); font-weight: 700; }
	.status-line span.offline, .offline { color: var(--danger-text); }
	.error-banner { max-width: 1200px; margin: 0 auto 16px; padding: 10px 14px; background: var(--error-bg); color: var(--danger-text); }
	.truncation-warning { text-align: center; color: var(--warning-text); }
	@media (max-width: 900px) {
		.generator-controls { grid-template-columns: repeat(3, minmax(0, 1fr)); }
		.generator-controls label:first-child { grid-column: 1 / -1; }
	}
	@media (max-width: 560px) {
		main { padding-inline: 10px; }
		.url-form, .generator-controls { grid-template-columns: 1fr; }
		.generator-controls label:first-child { grid-column: auto; }
	}
</style>
