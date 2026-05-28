<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { browser } from '$app/environment';
	import '../../app.css';
	import RouteNav from '$lib/components/RouteNav.svelte';
	import { getFullThread, getProfile } from '$lib/api/bluesky';
	import type { SelfReplyThread, ThreadPost } from '$lib/types';
	import {
		buildAtUri,
		buildBskyPostUrl,
		normalizeBskyPostUrl,
		parseBskyPostUrl
	} from '$lib/utils/viewerLinks';

	type ImageStatus = 'idle' | 'queued' | 'generating' | 'ready' | 'error';

	type AbstractThreadItem = {
		id: string;
		post: ThreadPost;
		index: number;
		depth: number;
		text: string;
		createdAtLabel: string;
		permalink: string | null;
		imageStatus: ImageStatus;
		imageSrc?: string;
		imagePrompt?: string;
		imageError?: string;
		seed?: number;
		generationSeconds?: number;
	};

	type ImagegenHealth = {
		ok?: boolean;
		backend?: string;
		model_id?: string;
		cuda_available?: boolean;
		gpu?: string;
		loaded?: boolean;
		load_seconds?: number | null;
	};

	type ImagegenGenerateResponse = {
		image_base64: string;
		format: 'png' | 'jpeg' | 'webp';
		seed: number;
		width: number;
		height: number;
		steps: number;
		timings?: {
			generation_seconds?: number;
			total_seconds?: number;
		};
	};

	const DEFAULT_BACKEND_URL = 'http://127.0.0.1:8008';
	const BACKEND_URL_STORAGE_KEY = 'abstractfeed-imagegen-url';
	const PROMPT_TEMPLATE_STORAGE_KEY = 'abstractfeed-prompt-template';
	const POST_TEXT_TOKEN = '{{postText}}';
	const DEFAULT_PROMPT_TEMPLATE = [
		'Create a Kandinsky-inspired abstract thumbnail that captures the emotional vibe of this Bluesky thread post or reply.',
		'Use expressive geometric abstraction: circles, arcs, diagonals, sharp color contrasts, layered forms, and rhythmic visual movement.',
		'Do not depict the post literally. Translate its mood, tension, humor, curiosity, or intensity into composition and color.',
		'Do not include text, captions, usernames, logos, watermarks, UI, screenshots, or social-media chrome.',
		'Keep it polished, square, high-contrast, and readable as a small thread image.',
		`Post text: "${POST_TEXT_TOKEN}"`
	].join('\n');
	const timestampFormatter = new Intl.DateTimeFormat('en-US', {
		month: 'short',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		hour12: false
	});

	let urlInput = $state('');
	let backendUrl = $state(DEFAULT_BACKEND_URL);
	let promptTemplate = $state(DEFAULT_PROMPT_TEMPLATE);
	let imageSize = $state(512);
	let steps = $state(2);
	let guidanceScale = $state(1);
	let loadingThread = $state(false);
	let generating = $state(false);
	let checkingBackend = $state(false);
	let error: string | null = $state(null);
	let backendError: string | null = $state(null);
	let backendHealth: ImagegenHealth | null = $state(null);
	let thread: (SelfReplyThread & { isTruncated?: boolean }) | null = $state(null);
	let threadItems: AbstractThreadItem[] = $state([]);
	let generationToken = 0;
	let activeGenerationController: AbortController | null = null;
	const imageObjectUrls = new Map<string, string>();

	let generatedCount = $derived(threadItems.filter((item) => item.imageStatus === 'ready').length);
	let queuedCount = $derived(
		threadItems.filter((item) => item.imageStatus === 'queued' || item.imageStatus === 'generating')
			.length
	);
	let failedCount = $derived(threadItems.filter((item) => item.imageStatus === 'error').length);
	let selectedHandle = $derived(parseBskyPostUrl(urlInput)?.handle ?? null);
	let backendBaseUrl = $derived(normalizeBackendUrl(backendUrl));
	let backendStatusLabel = $derived.by(() => {
		if (checkingBackend) return 'checking';
		if (backendError) return 'offline';
		if (!backendHealth) return 'unknown';
		if (!backendHealth.cuda_available) return 'no cuda';
		return backendHealth.loaded ? 'loaded' : 'idle';
	});

	function normalizeBackendUrl(value: string): string {
		return value.trim().replace(/\/+$/, '') || DEFAULT_BACKEND_URL;
	}

	function updateUrlQuery(url: string | null) {
		if (!browser) return;
		const current = new URL(window.location.href);
		if (url) {
			current.searchParams.set('url', url);
		} else {
			current.searchParams.delete('url');
		}
		window.history.replaceState({}, '', current.toString());
	}

	function normalizePostText(text: unknown): string {
		const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
		return clean || '[no text body]';
	}

	function flattenThread(root: ThreadPost): Array<{ post: ThreadPost; depth: number }> {
		const items: Array<{ post: ThreadPost; depth: number }> = [];

		function visit(post: ThreadPost, depth: number) {
			items.push({ post, depth });
			for (const child of post.children ?? []) {
				visit(child, depth + 1);
			}
		}

		visit(root, 0);
		return items;
	}

	function mapThreadItems(root: ThreadPost): AbstractThreadItem[] {
		return flattenThread(root).map(({ post, depth }, index) => ({
			id: post.uri,
			post,
			index,
			depth,
			text: normalizePostText(post.text),
			createdAtLabel: timestampFormatter.format(new Date(post.createdAt || Date.now())),
			permalink: buildBskyPostUrl(post.uri, post.author.handle),
			imageStatus: 'idle'
		}));
	}

	function revokeImage(itemId: string) {
		const existing = imageObjectUrls.get(itemId);
		if (!existing) return;
		URL.revokeObjectURL(existing);
		imageObjectUrls.delete(itemId);
	}

	function clearImages() {
		for (const src of imageObjectUrls.values()) {
			URL.revokeObjectURL(src);
		}
		imageObjectUrls.clear();
	}

	function setItemState(itemId: string, patch: Partial<AbstractThreadItem>) {
		threadItems = threadItems.map((item) => (item.id === itemId ? { ...item, ...patch } : item));
	}

	function buildImagePrompt(item: AbstractThreadItem): string {
		const sourceText = item.text.slice(0, 900);
		const cleanTemplate = promptTemplate.trim() || DEFAULT_PROMPT_TEMPLATE;
		if (cleanTemplate.includes(POST_TEXT_TOKEN)) {
			return cleanTemplate.replaceAll(POST_TEXT_TOKEN, sourceText);
		}
		return `${cleanTemplate}\nPost text: "${sourceText}"`;
	}

	function handlePromptTemplateInput(event: Event) {
		promptTemplate = (event.currentTarget as HTMLTextAreaElement).value;
		if (browser) localStorage.setItem(PROMPT_TEMPLATE_STORAGE_KEY, promptTemplate);
	}

	function resetPromptTemplate() {
		promptTemplate = DEFAULT_PROMPT_TEMPLATE;
		if (browser) localStorage.setItem(PROMPT_TEMPLATE_STORAGE_KEY, promptTemplate);
	}

	async function checkBackend() {
		checkingBackend = true;
		backendError = null;
		try {
			const response = await fetch(`${backendBaseUrl}/health`);
			const payload = (await response.json()) as ImagegenHealth;
			if (!response.ok) {
				throw new Error(`ImageGen health check failed with HTTP ${response.status}`);
			}
			backendHealth = payload;
			if (browser) localStorage.setItem(BACKEND_URL_STORAGE_KEY, backendBaseUrl);
		} catch (err: any) {
			backendHealth = null;
			backendError =
				err?.message ||
				`Could not reach the local ImageGen backend at ${backendBaseUrl}.`;
		} finally {
			checkingBackend = false;
		}
	}

	async function loadThread(rawUrl: string) {
		const normalizedUrl = normalizeBskyPostUrl(rawUrl);
		const parsed = normalizedUrl ? parseBskyPostUrl(normalizedUrl) : null;
		if (!normalizedUrl || !parsed) {
			error = 'Invalid URL. Expected format: https://bsky.app/profile/{handle}/post/{rkey}';
			return;
		}

		generationToken++;
		activeGenerationController?.abort();
		clearImages();
		urlInput = normalizedUrl;
		updateUrlQuery(normalizedUrl);
		loadingThread = true;
		generating = false;
		error = null;
		thread = null;
		threadItems = [];

		try {
			const profile = await getProfile(parsed.handle);
			const atUri = buildAtUri(profile.did, parsed.rkey);
			if (!atUri) {
				error = 'Could not build an AT URI for this thread.';
				return;
			}

			const hydratedThread = await getFullThread(atUri);
			thread = hydratedThread;
			threadItems = mapThreadItems(hydratedThread.rootPost);
			loadingThread = false;

			await checkBackend();
			if (!backendError && threadItems.length > 0) {
				await generateMissingImages();
			}
		} catch (err: any) {
			error = err?.message || 'Failed to load thread.';
			thread = null;
			threadItems = [];
		} finally {
			loadingThread = false;
		}
	}

	function handleSubmit(event: Event) {
		event.preventDefault();
		if (urlInput.trim()) {
			void loadThread(urlInput.trim());
		}
	}

	function base64ToBlob(base64: string, mediaType: string): Blob {
		const binary = atob(base64);
		const bytes = new Uint8Array(binary.length);
		for (let index = 0; index < binary.length; index += 1) {
			bytes[index] = binary.charCodeAt(index);
		}
		return new Blob([bytes], { type: mediaType });
	}

	async function readErrorMessage(response: Response): Promise<string> {
		try {
			const payload = (await response.json()) as {
				detail?: string | Array<string | { msg?: string }>;
			};
			if (typeof payload?.detail === 'string') return payload.detail;
			if (Array.isArray(payload?.detail)) {
				return payload.detail.map((item: any) => item.msg || item).join(', ');
			}
		} catch {}
		return `ImageGen request failed with HTTP ${response.status}`;
	}

	async function generateImageForItem(itemId: string, token: number) {
		const item = threadItems.find((entry) => entry.id === itemId);
		if (!item || token !== generationToken) return;

		const prompt = buildImagePrompt(item);
		setItemState(itemId, {
			imageStatus: 'generating',
			imageError: undefined,
			imagePrompt: prompt
		});

		const controller = new AbortController();
		activeGenerationController = controller;

		try {
			const requestBody = {
				prompt,
				width: imageSize,
				height: imageSize,
				steps,
				guidance_scale: guidanceScale,
				format: 'png'
			};
			console.groupCollapsed(`[abstractthread] ImageGen prompt for post ${item.index + 1}`);
			console.log(prompt);
			console.log(requestBody);
			console.groupEnd();

			const response = await fetch(`${backendBaseUrl}/generate`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(requestBody),
				signal: controller.signal
			});

			if (!response.ok) {
				throw new Error(await readErrorMessage(response));
			}

			const payload = (await response.json()) as ImagegenGenerateResponse;
			if (!payload.image_base64) throw new Error('ImageGen response did not include image data.');

			revokeImage(itemId);
			const blob = base64ToBlob(payload.image_base64, `image/${payload.format}`);
			const src = URL.createObjectURL(blob);
			imageObjectUrls.set(itemId, src);

			if (token !== generationToken) {
				revokeImage(itemId);
				return;
			}

			setItemState(itemId, {
				imageStatus: 'ready',
				imageSrc: src,
				seed: payload.seed,
				generationSeconds: payload.timings?.generation_seconds
			});
		} catch (err: any) {
			if (err?.name === 'AbortError') return;
			if (token !== generationToken) return;
			setItemState(itemId, {
				imageStatus: 'error',
				imageError: err?.message || 'Image generation failed.'
			});
		} finally {
			if (activeGenerationController === controller) activeGenerationController = null;
		}
	}

	async function generateMissingImages() {
		if (generating || threadItems.length === 0) return;

		const token = ++generationToken;
		const targetIds = threadItems
			.filter((item) => item.imageStatus !== 'ready')
			.map((item) => item.id);
		if (targetIds.length === 0) return;

		generating = true;
		error = null;
		threadItems = threadItems.map((item) =>
			targetIds.includes(item.id)
				? { ...item, imageStatus: 'queued', imageError: undefined }
				: item
		);

		for (const itemId of targetIds) {
			if (token !== generationToken) break;
			await generateImageForItem(itemId, token);
		}

		if (token === generationToken) {
			generating = false;
		}
	}

	function stopGeneration() {
		generationToken++;
		activeGenerationController?.abort();
		activeGenerationController = null;
		generating = false;
		threadItems = threadItems.map((item) =>
			item.imageStatus === 'queued' || item.imageStatus === 'generating'
				? { ...item, imageStatus: 'idle' }
				: item
		);
	}

	function retryItem(itemId: string) {
		if (generating) return;
		const token = ++generationToken;
		generating = true;
		void generateImageForItem(itemId, token).finally(() => {
			if (token === generationToken) generating = false;
		});
	}

	onMount(() => {
		const storedBackendUrl = localStorage.getItem(BACKEND_URL_STORAGE_KEY);
		if (storedBackendUrl) backendUrl = storedBackendUrl;
		const storedPromptTemplate = localStorage.getItem(PROMPT_TEMPLATE_STORAGE_KEY);
		if (storedPromptTemplate) promptTemplate = storedPromptTemplate;

		const urlParam = new URL(window.location.href).searchParams.get('url');
		if (urlParam) {
			urlInput = urlParam;
			void loadThread(urlParam);
		} else {
			void checkBackend();
		}
	});

	onDestroy(() => {
		activeGenerationController?.abort();
		clearImages();
	});
</script>

<svelte:head>
	<title>Abstract Thread View</title>
	<meta
		name="description"
		content="Local-only Bluesky thread view that generates one abstract image per hydrated post and reply."
	/>
</svelte:head>

<main class="abstract-shell">
	<header class="page-header">
		<RouteNav current="abstractfeed" compact threadUrl={urlInput} handle={selectedHandle} />
		<div class="title-row">
			<div>
				<p class="eyebrow">local only</p>
				<h1>Abstract Thread View</h1>
			</div>
			<div class="backend-chip" class:error={Boolean(backendError)}>
				<span>{backendStatusLabel}</span>
			</div>
		</div>
		<p class="local-note">
			Paste a Bluesky post URL. The thread is hydrated from Bluesky, then each post and reply is
			sent individually to the local ImageGen backend at <code>{backendBaseUrl}</code>.
		</p>
	</header>

	<section class="control-band" aria-label="Thread controls">
		<form class="url-form" onsubmit={handleSubmit}>
			<label for="abstract-url">Thread URL</label>
			<div class="url-input-shell">
				<input
					id="abstract-url"
					type="text"
					bind:value={urlInput}
					placeholder="https://bsky.app/profile/handle.bsky.social/post/..."
					autocomplete="off"
					spellcheck="false"
					disabled={loadingThread || generating}
				/>
				<button type="submit" disabled={loadingThread || generating || !urlInput.trim()}>
					{loadingThread ? 'Loading' : 'Load thread'}
				</button>
			</div>
		</form>

		<div class="settings-grid">
			<label>
				<span>Backend</span>
				<input
					type="url"
					bind:value={backendUrl}
					placeholder={DEFAULT_BACKEND_URL}
					disabled={checkingBackend || generating}
				/>
			</label>
			<label>
				<span>Size</span>
				<select bind:value={imageSize} disabled={generating}>
					<option value={384}>384</option>
					<option value={512}>512</option>
					<option value={768}>768</option>
				</select>
			</label>
			<label>
				<span>Steps</span>
				<input type="number" min="1" max="12" bind:value={steps} disabled={generating} />
			</label>
			<label>
				<span>Guidance</span>
				<input
					type="number"
					min="0"
					max="20"
					step="0.1"
					bind:value={guidanceScale}
					disabled={generating}
				/>
			</label>
		</div>

		<div class="action-row">
			<button type="button" class="secondary" onclick={checkBackend} disabled={checkingBackend || generating}>
				{checkingBackend ? 'Checking' : 'Check backend'}
			</button>
			<button
				type="button"
				onclick={generateMissingImages}
				disabled={loadingThread || generating || threadItems.length === 0}
			>
				{generating ? 'Generating' : 'Generate images'}
			</button>
			{#if generating}
				<button type="button" class="danger" onclick={stopGeneration}>Stop</button>
			{/if}
		</div>
	</section>

	<section class="prompt-panel" aria-label="Image prompt">
		<div class="prompt-panel-header">
			<label for="abstract-prompt">Prompt</label>
			<button type="button" class="secondary compact-button" onclick={resetPromptTemplate} disabled={generating}>
				Reset
			</button>
		</div>
		<textarea
			id="abstract-prompt"
			value={promptTemplate}
			oninput={handlePromptTemplateInput}
			spellcheck="true"
			disabled={generating}
		></textarea>
	</section>

	{#if backendHealth}
		<section class="status-strip" aria-label="ImageGen status">
			<span>{backendHealth.backend ?? 'imagegen'}</span>
			<span>{backendHealth.model_id ?? 'model unknown'}</span>
			<span>{backendHealth.cuda_available ? backendHealth.gpu ?? 'CUDA available' : 'CUDA unavailable'}</span>
		</section>
	{/if}

	{#if error || backendError}
		<section class="message-strip error">
			{error || backendError}
		</section>
	{/if}

	<section class="thread-summary" aria-label="Thread summary">
		<div>
			<strong>{thread ? 'Hydrated thread' : 'No thread loaded'}</strong>
			<span>{threadItems.length} posts and replies</span>
			{#if thread?.isTruncated}
				<span class="warning-pill">some replies may be missing</span>
			{/if}
		</div>
		<div>
			<span>{generatedCount} ready</span>
			<span>{queuedCount} queued</span>
			<span>{failedCount} failed</span>
		</div>
	</section>

	<section class="thread-list" aria-label="Abstract thread">
		{#if loadingThread}
			<div class="empty-state">Hydrating thread</div>
		{:else if threadItems.length === 0}
			<div class="empty-state">Load a Bluesky thread URL to generate abstract images.</div>
		{:else}
			{#each threadItems as item (item.id)}
				<article class="thread-row" style={`--depth:${Math.min(item.depth, 6)}`}>
					<section class="text-panel" aria-label={`Post ${item.index + 1} text`}>
						<div class="post-author">
							{#if item.post.author.avatar}
								<img src={item.post.author.avatar} alt="" />
							{:else}
								<div class="avatar-placeholder"></div>
							{/if}
							<div>
								<strong>{item.post.author.displayName || item.post.author.handle}</strong>
								<span>@{item.post.author.handle} · {item.createdAtLabel}</span>
							</div>
						</div>
						<p>{item.text}</p>
						<div class="post-meta">
							<span>#{item.index + 1}</span>
							<span>depth {item.depth}</span>
							<span>{item.post.likeCount} likes</span>
							<span>{item.post.repostCount} reposts</span>
							<span>{item.post.replyCount} replies</span>
							{#if item.permalink}
								<a href={item.permalink} target="_blank" rel="noreferrer">Open post</a>
							{/if}
						</div>
						{#if item.imageError}
							<p class="post-error">{item.imageError}</p>
						{/if}
					</section>

					<section class="image-panel" aria-label={`Generated image for post ${item.index + 1}`}>
						<div class="image-frame" class:ready={item.imageStatus === 'ready'} class:error={item.imageStatus === 'error'}>
							{#if item.imageSrc}
								<img src={item.imageSrc} alt={`Generated abstract image for post ${item.index + 1}`} />
							{:else if item.imageStatus === 'generating'}
								<div class="image-placeholder active">Generating</div>
							{:else if item.imageStatus === 'queued'}
								<div class="image-placeholder">Queued</div>
							{:else if item.imageStatus === 'error'}
								<div class="image-placeholder error-text">Failed</div>
							{:else}
								<div class="image-placeholder">Idle</div>
							{/if}
						</div>
						<div class="image-actions">
							{#if item.imageStatus === 'error'}
								<button type="button" class="link-button" onclick={() => retryItem(item.id)} disabled={generating}>
									Retry
								</button>
							{/if}
							{#if item.seed}
								<span>seed {item.seed}</span>
							{/if}
							{#if item.generationSeconds}
								<span>{item.generationSeconds.toFixed(1)}s</span>
							{/if}
						</div>
					</section>
				</article>
			{/each}
		{/if}
	</section>
</main>

<style>
	:global(body) {
		background:
			linear-gradient(135deg, color-mix(in srgb, var(--bg-paper) 88%, #d8f3eb 12%), var(--bg-paper));
	}

	.abstract-shell {
		min-height: 100svh;
		width: min(1440px, 100%);
		margin: 0 auto;
		padding: 18px;
		color: var(--text-ink);
	}

	.page-header {
		display: grid;
		gap: 14px;
		margin-bottom: 16px;
	}

	.title-row {
		display: flex;
		align-items: end;
		justify-content: space-between;
		gap: 16px;
	}

	.eyebrow {
		color: var(--warm-text);
		font-size: 0.82rem;
		font-weight: 800;
		text-transform: uppercase;
		letter-spacing: 0;
	}

	h1 {
		margin: 0;
		font-size: clamp(2rem, 5vw, 4.6rem);
		line-height: 0.95;
	}

	.local-note {
		max-width: 880px;
		color: var(--muted);
		font-size: 1rem;
	}

	code {
		padding: 2px 6px;
		border-radius: 6px;
		background: var(--muted-surface);
		color: var(--text-ink);
		font-family: var(--font-matrix-ui);
		font-size: 0.9em;
	}

	.backend-chip {
		display: inline-flex;
		align-items: center;
		min-height: 38px;
		padding: 8px 14px;
		border: 1px solid color-mix(in srgb, var(--accent) 55%, var(--control-border));
		border-radius: 999px;
		background: color-mix(in srgb, var(--accent) 14%, var(--card-bg));
		font-weight: 800;
		text-transform: uppercase;
	}

	.backend-chip.error {
		border-color: color-mix(in srgb, var(--danger-text) 60%, var(--control-border));
		background: var(--error-bg);
		color: var(--danger-text);
	}

	.control-band {
		display: grid;
		grid-template-columns: minmax(320px, 1.25fr) minmax(320px, 1.55fr) auto;
		gap: 14px;
		align-items: end;
		padding: 14px;
		border: 1px solid var(--control-border);
		border-radius: 8px;
		background: var(--panel-bg);
		box-shadow: var(--shadow-soft);
	}

	.url-form,
	.settings-grid label,
	.prompt-panel-header label {
		position: relative;
		display: grid;
		gap: 7px;
		font-size: 0.82rem;
		font-weight: 800;
		color: var(--muted);
		text-transform: uppercase;
	}

	.url-input-shell {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		gap: 8px;
	}

	input,
	select,
	textarea,
	button {
		font: inherit;
		letter-spacing: 0;
	}

	input,
	select,
	textarea {
		width: 100%;
		border: 1px solid var(--control-border);
		border-radius: 7px;
		background: var(--input-bg);
		color: var(--text-ink);
	}

	input,
	select {
		min-height: 42px;
		padding: 0 11px;
	}

	textarea {
		min-height: 168px;
		padding: 11px;
		resize: vertical;
		font-family: var(--font-matrix-ui);
		font-size: 0.9rem;
		line-height: 1.45;
	}

	input:focus,
	select:focus,
	textarea:focus {
		outline: none;
		border-color: color-mix(in srgb, var(--accent) 72%, var(--control-border));
		box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 18%, transparent);
	}

	button {
		min-height: 42px;
		border: 1px solid color-mix(in srgb, var(--accent) 62%, var(--control-border));
		border-radius: 7px;
		padding: 0 14px;
		background: var(--accent);
		color: var(--accent-contrast);
		font-weight: 850;
		cursor: pointer;
	}

	button.secondary {
		background: var(--control-bg);
		color: var(--text-ink);
	}

	button.danger {
		border-color: color-mix(in srgb, var(--danger-text) 62%, var(--control-border));
		background: var(--danger-text);
	}

	.compact-button {
		min-height: 34px;
		padding: 0 12px;
		font-size: 0.86rem;
	}

	button:disabled {
		cursor: wait;
		opacity: 0.58;
	}

	.settings-grid {
		display: grid;
		grid-template-columns: minmax(220px, 1.7fr) repeat(3, minmax(88px, 0.65fr));
		gap: 10px;
	}

	.action-row {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		justify-content: flex-end;
	}

	.prompt-panel {
		display: grid;
		gap: 9px;
		margin-top: 14px;
		padding: 14px;
		border: 1px solid var(--control-border);
		border-radius: 8px;
		background: var(--panel-bg);
		box-shadow: var(--shadow-soft);
	}

	.prompt-panel-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 10px;
	}

	.status-strip,
	.message-strip,
	.thread-summary {
		display: flex;
		flex-wrap: wrap;
		gap: 10px;
		align-items: center;
		justify-content: space-between;
		margin-top: 14px;
		padding: 10px 12px;
		border: 1px solid var(--control-border);
		border-radius: 8px;
		background: var(--panel-bg-plain);
	}

	.status-strip {
		justify-content: flex-start;
		color: var(--muted);
		font-size: 0.9rem;
	}

	.status-strip span,
	.thread-summary span {
		padding: 4px 8px;
		border-radius: 999px;
		background: var(--muted-surface);
	}

	.message-strip.error {
		color: var(--danger-text);
		background: var(--error-bg);
	}

	.thread-summary > div {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		align-items: center;
	}

	.warning-pill {
		color: var(--warm-text);
	}

	.thread-list {
		display: grid;
		gap: 14px;
		margin-top: 14px;
		padding-bottom: 32px;
	}

	.thread-row {
		display: grid;
		grid-template-columns: minmax(0, 1fr) minmax(260px, 34%);
		gap: 14px;
		align-items: stretch;
		padding-left: calc(var(--depth) * 14px);
	}

	.text-panel,
	.image-panel {
		min-width: 0;
		border: 1px solid var(--control-border);
		border-radius: 8px;
		background: var(--card-bg);
		box-shadow: var(--shadow-soft);
	}

	.text-panel {
		display: grid;
		gap: 12px;
		align-content: start;
		padding: 14px;
		border-left: 5px solid color-mix(in srgb, var(--accent) 62%, var(--control-border));
	}

	.image-panel {
		display: grid;
		grid-template-rows: auto minmax(36px, auto);
		overflow: hidden;
	}

	.post-author {
		display: grid;
		grid-template-columns: 40px minmax(0, 1fr);
		gap: 9px;
		align-items: center;
	}

	.post-author img,
	.avatar-placeholder {
		width: 40px;
		height: 40px;
		border-radius: 50%;
		background: var(--muted-surface);
		object-fit: cover;
	}

	.post-author strong,
	.post-author span {
		display: block;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.post-author span,
	.post-meta,
	.image-actions,
	.post-error {
		color: var(--muted);
		font-size: 0.88rem;
	}

	.text-panel p {
		color: var(--text-ink);
		font-size: 1rem;
		line-height: 1.48;
		white-space: pre-wrap;
	}

	.post-meta,
	.image-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 8px 10px;
		align-items: center;
	}

	.post-meta a,
	.link-button {
		min-height: auto;
		border: 0;
		padding: 0;
		background: transparent;
		color: var(--accent);
		font-weight: 850;
		text-decoration: none;
	}

	.post-meta a:hover,
	.link-button:hover {
		text-decoration: underline;
	}

	.post-error {
		color: var(--danger-text);
	}

	.image-frame {
		display: grid;
		place-items: center;
		aspect-ratio: 1 / 1;
		background:
			linear-gradient(135deg, rgba(29, 127, 110, 0.16), transparent 42%),
			linear-gradient(315deg, rgba(138, 79, 131, 0.12), transparent 48%),
			var(--muted-surface);
		overflow: hidden;
	}

	.image-frame.ready {
		background: #111419;
	}

	.image-frame.error {
		background: var(--error-bg);
	}

	.image-frame img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}

	.image-placeholder {
		display: grid;
		place-items: center;
		width: 92%;
		aspect-ratio: 1 / 1;
		border: 1px dashed color-mix(in srgb, var(--text-ink) 28%, transparent);
		border-radius: 8px;
		color: var(--muted);
		font-weight: 850;
		text-transform: uppercase;
	}

	.image-placeholder.active {
		color: var(--text-ink);
		background: color-mix(in srgb, var(--accent) 10%, transparent);
	}

	.error-text {
		color: var(--danger-text);
	}

	.image-actions {
		padding: 10px 12px;
	}

	.empty-state {
		display: grid;
		place-items: center;
		min-height: 260px;
		border: 1px dashed var(--control-border);
		border-radius: 8px;
		background: var(--panel-bg-plain);
		color: var(--muted);
		text-align: center;
		padding: 24px;
	}

	@media (max-width: 1100px) {
		.control-band {
			grid-template-columns: 1fr;
		}

		.settings-grid {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}

		.action-row {
			justify-content: flex-start;
		}
	}

	@media (max-width: 760px) {
		.abstract-shell {
			padding: 12px;
		}

		.title-row {
			align-items: start;
			flex-direction: column;
		}

		.url-input-shell,
		.settings-grid,
		.thread-row {
			grid-template-columns: 1fr;
		}

		.thread-row {
			padding-left: 0;
		}
	}
</style>
