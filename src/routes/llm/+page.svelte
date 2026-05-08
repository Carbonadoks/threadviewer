<script lang="ts">
	import { onDestroy, onMount, tick } from 'svelte';
	import '../../app.css';
	import RouteNav from '$lib/components/RouteNav.svelte';
	import {
		GEMMA_CONTEXT_WINDOWS,
		GEMMA_DEFAULT_CONTEXT_WINDOW,
		GEMMA_WEBLLM_MODEL_ID,
		GEMMA_WEBLLM_REPO,
		createGemmaWebllmAppConfig
	} from '$lib/llm/gemmaWebllm';
	import type {
		ChatCompletionMessageParam,
		InitProgressReport,
		MLCEngineInterface
	} from '@mlc-ai/web-llm';

	type LlmRole = 'user' | 'assistant';
	type LoadState = 'idle' | 'checking' | 'loading' | 'ready' | 'generating' | 'error';

	interface ChatMessage {
		id: string;
		role: LlmRole;
		content: string;
		pending?: boolean;
		error?: boolean;
	}

	interface WebGpuStatus {
		supported: boolean;
		hasShaderF16: boolean;
		vendor: string;
		reason: string;
		features: string[];
	}

	const defaultSystemPrompt =
		'You are a concise local assistant running entirely in this browser tab.';
	const seedPrompts = [
		'Give me three weirdly practical uses for a tiny local LLM.',
		'Summarize why browser-local inference changes the privacy model.',
		'Write a short Svelte component that streams tokens into a paragraph.'
	];

	let engine: MLCEngineInterface | null = null;
	let worker: Worker | null = null;
	let loadState = $state<LoadState>('idle');
	let loadProgress = $state(0);
	let loadText = $state('Model not loaded');
	let error = $state<string | null>(null);
	let webgpu = $state<WebGpuStatus | null>(null);
	let messages = $state<ChatMessage[]>([]);
	let prompt = $state(seedPrompts[0]);
	let systemPrompt = $state(defaultSystemPrompt);
	let temperature = $state(0.7);
	let topP = $state(0.9);
	let maxTokens = $state(512);
	let contextWindowIndex = $state(0);
	let loadedContextWindowSize = $state<number | null>(null);
	let runtimeStats = $state('');
	let transcriptEl: HTMLDivElement | undefined = $state();
	let loadPromise: Promise<void> | null = null;
	let messageCounter = 0;

	const isLoaded = $derived(loadState === 'ready' || loadState === 'generating');
	const contextWindowSize = $derived(
		GEMMA_CONTEXT_WINDOWS[contextWindowIndex] ?? GEMMA_DEFAULT_CONTEXT_WINDOW
	);
	const contextControlDisabled = $derived(
		loadState === 'checking' || loadState === 'loading' || loadState === 'generating'
	);
	const canLoad = $derived(
		loadState !== 'loading' &&
			loadState !== 'checking' &&
			loadState !== 'generating' &&
			(!webgpu || (webgpu.supported && webgpu.hasShaderF16))
	);
	const canSend = $derived(
		prompt.trim().length > 0 && loadState !== 'loading' && loadState !== 'checking' && loadState !== 'generating'
	);

	function nextId(role: LlmRole) {
		messageCounter += 1;
		return `${role}-${Date.now()}-${messageCounter}`;
	}

	function formatPercent(value: number) {
		return `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`;
	}

	function describeError(value: unknown) {
		if (value instanceof Error) return value.message;
		if (typeof value === 'string') return value;
		return 'Something went wrong while running the model.';
	}

	function appendMessage(message: ChatMessage) {
		messages = [...messages, message];
	}

	function updateMessage(id: string, patch: Partial<ChatMessage>) {
		messages = messages.map((message) =>
			message.id === id ? { ...message, ...patch } : message
		);
	}

	async function scrollTranscript() {
		await tick();
		transcriptEl?.scrollTo({ top: transcriptEl.scrollHeight, behavior: 'smooth' });
	}

	async function inspectWebGpu(): Promise<WebGpuStatus> {
		const gpu = (navigator as Navigator & { gpu?: any }).gpu;
		if (!gpu?.requestAdapter) {
			return {
				supported: false,
				hasShaderF16: false,
				vendor: '',
				reason: 'WebGPU is not available in this browser.',
				features: []
			};
		}

		const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
		if (!adapter) {
			return {
				supported: false,
				hasShaderF16: false,
				vendor: '',
				reason: 'No WebGPU adapter was found.',
				features: []
			};
		}

		const features = Array.from(adapter.features ?? []).map(String);
		let vendor = '';
		try {
			const info = await adapter.requestAdapterInfo?.();
			vendor = [info?.vendor, info?.architecture].filter(Boolean).join(' ');
		} catch {
			vendor = '';
		}

		return {
			supported: true,
			hasShaderF16: features.includes('shader-f16'),
			vendor,
			reason: features.includes('shader-f16')
				? 'WebGPU is ready.'
				: 'This model needs WebGPU shader-f16 support.',
			features
		};
	}

	function handleProgress(report: InitProgressReport) {
		loadProgress = report.progress;
		loadText = report.text || `Loading ${formatPercent(report.progress)}`;
	}

	async function unloadModel(nextLoadText = 'Model not loaded', nextLoadState: LoadState = 'idle') {
		const currentEngine = engine;
		const currentWorker = worker;
		engine = null;
		worker = null;
		loadedContextWindowSize = null;
		runtimeStats = '';
		loadProgress = 0;
		loadState = nextLoadState;
		loadText = nextLoadText;
		try {
			await currentEngine?.unload();
		} catch {}
		currentWorker?.terminate();
	}

	function handleContextWindowInput(event: Event) {
		const input = event.currentTarget as HTMLInputElement;
		const nextIndex = Number(input.value);
		if (!Number.isInteger(nextIndex) || !GEMMA_CONTEXT_WINDOWS[nextIndex]) return;

		const nextContext = GEMMA_CONTEXT_WINDOWS[nextIndex];
		contextWindowIndex = nextIndex;
		error = null;

		if (engine && loadState === 'ready' && loadedContextWindowSize !== nextContext) {
			void unloadModel(`Context set to ${nextContext.toLocaleString()} tokens. Load the model again.`);
		}
	}

	async function loadModel() {
		if (engine) return;
		if (loadPromise) return loadPromise;

		loadPromise = (async () => {
			loadState = 'checking';
			error = null;
			loadText = 'Checking WebGPU';
			loadProgress = 0;

			const status = await inspectWebGpu();
			webgpu = status;
			if (!status.supported || !status.hasShaderF16) {
				throw new Error(status.reason);
			}

			loadState = 'loading';
			loadText = 'Preparing WebLLM';

			const { CreateWebWorkerMLCEngine } = await import('@mlc-ai/web-llm');
			worker = new Worker(new URL('../../lib/llm/webllm.worker.ts', import.meta.url), {
				type: 'module'
			});
			engine = await CreateWebWorkerMLCEngine(
				worker,
				GEMMA_WEBLLM_MODEL_ID,
				{
					appConfig: createGemmaWebllmAppConfig(contextWindowSize),
					initProgressCallback: handleProgress,
					logLevel: 'WARN'
				}
			);

			loadProgress = 1;
			loadText = 'Model ready';
			loadState = 'ready';
			loadedContextWindowSize = contextWindowSize;
			try {
				runtimeStats = await engine.runtimeStatsText();
			} catch {
				runtimeStats = '';
			}
		})().catch((value) => {
			error = describeError(value);
			loadState = 'error';
			loadText = 'Model failed to load';
			loadProgress = 0;
			void unloadModel('Model failed to load', 'error');
			throw value;
		}).finally(() => {
			loadPromise = null;
		});

		return loadPromise;
	}

	function buildApiMessages(): ChatCompletionMessageParam[] {
		const apiMessages: ChatCompletionMessageParam[] = [];
		const system = systemPrompt.trim();
		if (system) {
			apiMessages.push({ role: 'system', content: system });
		}
		for (const message of messages) {
			if (message.pending || message.error || !message.content.trim()) continue;
			apiMessages.push({ role: message.role, content: message.content });
		}
		return apiMessages;
	}

	async function sendPrompt() {
		const content = prompt.trim();
		if (!content || loadState === 'generating') return;

		try {
			if (!engine) {
				await loadModel();
			}
			if (!engine) return;
		} catch {
			return;
		}

		const userMessage: ChatMessage = {
			id: nextId('user'),
			role: 'user',
			content
		};
		const assistantId = nextId('assistant');
		const assistantMessage: ChatMessage = {
			id: assistantId,
			role: 'assistant',
			content: '',
			pending: true
		};

		prompt = '';
		error = null;
		appendMessage(userMessage);
		appendMessage(assistantMessage);
		await scrollTranscript();

		loadState = 'generating';
		loadText = 'Generating';

		try {
			const chunks = await engine.chat.completions.create({
				messages: buildApiMessages(),
				stream: true,
				stream_options: { include_usage: true },
				temperature,
				top_p: topP,
				max_tokens: maxTokens
			});

			let output = '';
			for await (const chunk of chunks) {
				const delta = chunk.choices[0]?.delta.content ?? '';
				if (!delta) continue;
				output += delta;
				updateMessage(assistantId, { content: output });
				await scrollTranscript();
			}

			if (!output.trim()) {
				try {
					output = await engine.getMessage();
				} catch {
					output = '';
				}
			}

			updateMessage(assistantId, {
				content: output.trim() || '(No output)',
				pending: false
			});
			runtimeStats = await engine.runtimeStatsText().catch(() => '');
		} catch (value) {
			const message = describeError(value);
			updateMessage(assistantId, {
				content: message,
				pending: false,
				error: true
			});
			error = message;
		} finally {
			loadState = engine ? 'ready' : 'error';
			loadText = engine ? 'Model ready' : 'Model unavailable';
			await scrollTranscript();
		}
	}

	async function stopGeneration() {
		if (!engine || loadState !== 'generating') return;
		try {
			engine.interruptGenerate();
		} catch {}
	}

	async function resetChat() {
		messages = [];
		error = null;
		runtimeStats = '';
		try {
			await engine?.resetChat(true);
		} catch {}
	}

	function useSeedPrompt(value: string) {
		prompt = value;
	}

	function handlePromptKeydown(event: KeyboardEvent) {
		if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
			event.preventDefault();
			void sendPrompt();
		}
	}

	onMount(() => {
		void inspectWebGpu().then((status) => {
			webgpu = status;
			loadText = status.supported ? 'Model not loaded' : status.reason;
		});
	});

	onDestroy(() => {
		void unloadModel();
	});
</script>

<svelte:head>
	<title>LLM</title>
</svelte:head>

<main class="llm-page">
	<header class="llm-header">
		<RouteNav current="llm" align="center" />
		<div class="title-row">
			<div>
				<p class="eyebrow">WebLLM</p>
				<h1>LLM</h1>
			</div>
			<button
				type="button"
				class="load-button wobbly-border"
				disabled={!canLoad}
				onclick={() => void loadModel()}
			>
				{isLoaded ? 'Loaded' : loadState === 'loading' || loadState === 'checking' ? 'Loading' : 'Load Gemma 4'}
			</button>
		</div>
	</header>

	<section class="status-band" aria-live="polite">
		<div class="status-copy">
			<span class:ok={isLoaded} class:error-state={loadState === 'error'}>
				{loadText}
			</span>
			<small>
				{GEMMA_WEBLLM_MODEL_ID} · {contextWindowSize.toLocaleString()} ctx
			</small>
		</div>
		<div class="progress-track" aria-label="Model load progress">
			<div class="progress-fill" style:width={formatPercent(loadProgress)}></div>
		</div>
	</section>

	{#if error}
		<div class="error-banner wobbly-border-light">{error}</div>
	{/if}

	<div class="llm-shell">
		<section class="chat-panel" aria-label="Local chat">
			<div class="transcript" bind:this={transcriptEl}>
				{#if messages.length === 0}
					<div class="empty-state">
						<p>Gemma 4 E2B runs locally here after the first model load.</p>
					</div>
				{:else}
					{#each messages as message (message.id)}
						<article
							class="message"
							class:user={message.role === 'user'}
							class:assistant={message.role === 'assistant'}
							class:error-message={message.error}
						>
							<div class="message-role">{message.role === 'user' ? 'You' : 'Gemma'}</div>
							<div class="message-content">
								{message.content}{#if message.pending}<span class="cursor">▌</span>{/if}
							</div>
						</article>
					{/each}
				{/if}
			</div>

			<div class="composer">
				<textarea
					bind:value={prompt}
					onkeydown={handlePromptKeydown}
					placeholder="Ask the local model..."
					rows="4"
					disabled={loadState === 'generating'}
				></textarea>
				<div class="composer-actions">
					<button
						type="button"
						class="secondary-button wobbly-border-light"
						onclick={resetChat}
						disabled={messages.length === 0 && !runtimeStats}
					>
						Clear
					</button>
					{#if loadState === 'generating'}
						<button type="button" class="secondary-button wobbly-border-light" onclick={stopGeneration}>
							Stop
						</button>
					{:else}
						<button
							type="button"
							class="send-button wobbly-border"
							onclick={() => void sendPrompt()}
							disabled={!canSend}
						>
							Send
						</button>
					{/if}
				</div>
			</div>
		</section>

		<aside class="control-panel" aria-label="Model controls">
			<label>
				<span>System</span>
				<textarea bind:value={systemPrompt} rows="4" disabled={loadState === 'generating'}></textarea>
			</label>

			<label>
				<span>Temperature <b>{temperature.toFixed(2)}</b></span>
				<input
					type="range"
					min="0"
					max="1.5"
					step="0.05"
					bind:value={temperature}
					disabled={loadState === 'generating'}
				/>
			</label>

			<label>
				<span>Top P <b>{topP.toFixed(2)}</b></span>
				<input
					type="range"
					min="0.05"
					max="1"
					step="0.05"
					bind:value={topP}
					disabled={loadState === 'generating'}
				/>
			</label>

			<label>
				<span>Context <b>{contextWindowSize.toLocaleString()} tokens</b></span>
				<input
					type="range"
					min="0"
					max={GEMMA_CONTEXT_WINDOWS.length - 1}
					step="1"
					value={contextWindowIndex}
					oninput={handleContextWindowInput}
					disabled={contextControlDisabled}
				/>
			</label>

			<label>
				<span>Max Tokens</span>
				<input
					type="number"
					min="16"
					max="2048"
					step="16"
					bind:value={maxTokens}
					disabled={loadState === 'generating'}
				/>
			</label>

			<div class="seed-list" aria-label="Prompt starters">
				{#each seedPrompts as seed}
					<button type="button" class="seed-button" onclick={() => useSeedPrompt(seed)}>
						{seed}
					</button>
				{/each}
			</div>

			<dl class="model-facts">
				<div>
					<dt>Model</dt>
					<dd>Gemma 4 E2B IT</dd>
				</div>
				<div>
					<dt>Quant</dt>
					<dd>int4 / q4f16_1</dd>
				</div>
				<div>
					<dt>Runtime</dt>
					<dd>WebLLM WebGPU</dd>
				</div>
				<div>
					<dt>Context</dt>
					<dd>{contextWindowSize.toLocaleString()}</dd>
				</div>
				<div>
					<dt>GPU</dt>
					<dd>{webgpu?.vendor || (webgpu?.supported ? 'Available' : 'Unavailable')}</dd>
				</div>
				<div>
					<dt>shader-f16</dt>
					<dd>{webgpu?.hasShaderF16 ? 'Yes' : 'No'}</dd>
				</div>
				<div>
					<dt>Weights</dt>
					<dd><a href={GEMMA_WEBLLM_REPO} target="_blank" rel="noreferrer">Hugging Face</a></dd>
				</div>
			</dl>

			{#if runtimeStats}
				<pre class="runtime-stats">{runtimeStats}</pre>
			{/if}
		</aside>
	</div>
</main>

<style>
	.llm-page {
		width: min(1180px, calc(100vw - 32px));
		margin: 0 auto;
		padding: 28px 0 42px;
	}

	.llm-header {
		margin-bottom: 16px;
	}

	.title-row {
		display: flex;
		align-items: flex-end;
		justify-content: space-between;
		gap: 18px;
		margin-top: 8px;
	}

	.eyebrow {
		color: var(--muted);
		font-family: var(--font-matrix-ui);
		font-size: 0.82rem;
		letter-spacing: 0;
		text-transform: uppercase;
	}

	h1 {
		font-size: clamp(2.6rem, 8vw, 5.6rem);
		line-height: 0.92;
		letter-spacing: 0;
	}

	.load-button,
	.send-button,
	.secondary-button {
		min-height: 42px;
		border: 2px solid var(--border-color);
		border-radius: 8px;
		font-weight: 800;
		transition:
			transform 0.16s ease,
			opacity 0.16s ease,
			background 0.16s ease;
	}

	.load-button,
	.send-button {
		padding: 9px 16px;
		background: var(--accent);
		color: var(--accent-contrast);
	}

	.secondary-button {
		padding: 9px 14px;
		background: var(--control-bg);
		color: var(--text-ink);
		border-width: 1.5px;
	}

	button:disabled {
		cursor: not-allowed;
		opacity: 0.55;
	}

	button:not(:disabled):hover {
		transform: translateY(-1px);
	}

	.status-band {
		display: grid;
		grid-template-columns: minmax(0, 1fr) minmax(180px, 360px);
		align-items: center;
		gap: 18px;
		margin-bottom: 16px;
		padding: 12px 14px;
		border: 1px solid var(--control-border);
		border-radius: 8px;
		background: var(--panel-bg-plain);
		box-shadow: var(--shadow-soft);
	}

	.status-copy {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 10px;
		min-width: 0;
	}

	.status-copy span {
		font-weight: 800;
	}

	.status-copy span.ok {
		color: #237466;
	}

	.status-copy span.error-state {
		color: var(--danger-text);
	}

	.status-copy small {
		color: var(--muted);
		font-family: var(--font-matrix-ui);
		font-size: 0.78rem;
		overflow-wrap: anywhere;
	}

	.progress-track {
		width: 100%;
		height: 10px;
		overflow: hidden;
		border: 1px solid var(--control-border);
		border-radius: 999px;
		background: var(--muted-surface);
	}

	.progress-fill {
		height: 100%;
		border-radius: inherit;
		background: linear-gradient(90deg, #237466, var(--accent));
		transition: width 0.2s ease;
	}

	.error-banner {
		margin-bottom: 16px;
		padding: 12px 14px;
		background: var(--error-bg);
		color: var(--danger-text);
		font-weight: 700;
	}

	.llm-shell {
		display: grid;
		grid-template-columns: minmax(0, 1fr) minmax(270px, 340px);
		gap: 18px;
		align-items: start;
	}

	.chat-panel,
	.control-panel {
		border: 1px solid var(--control-border);
		border-radius: 8px;
		background: var(--panel-bg);
		box-shadow: var(--shadow-soft);
	}

	.chat-panel {
		display: grid;
		grid-template-rows: minmax(360px, 62vh) auto;
		min-height: 0;
		overflow: hidden;
	}

	.transcript {
		min-height: 360px;
		overflow: auto;
		padding: 18px;
		scroll-behavior: smooth;
	}

	.empty-state {
		display: grid;
		place-items: center;
		min-height: 100%;
		color: var(--muted);
		text-align: center;
	}

	.empty-state p {
		max-width: 32ch;
	}

	.message {
		width: min(78%, 760px);
		margin-bottom: 14px;
		padding: 12px 14px;
		border: 1px solid var(--control-border);
		border-radius: 8px;
		background: var(--card-bg);
		box-shadow: 0 8px 20px rgba(26, 35, 44, 0.06);
	}

	.message.user {
		margin-left: auto;
		background: color-mix(in srgb, var(--accent) 13%, var(--card-bg));
	}

	.message.error-message {
		background: var(--error-bg);
		color: var(--danger-text);
	}

	.message-role {
		margin-bottom: 4px;
		color: var(--muted);
		font-family: var(--font-matrix-ui);
		font-size: 0.74rem;
		font-weight: 700;
		text-transform: uppercase;
	}

	.message-content {
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}

	.cursor {
		display: inline-block;
		margin-left: 2px;
		animation: blink 1s steps(2, start) infinite;
	}

	.composer {
		display: grid;
		gap: 10px;
		padding: 14px;
		border-top: 1px solid var(--control-border);
		background: var(--panel-bg-muted);
	}

	textarea,
	input[type='number'] {
		width: 100%;
		border: 1px solid var(--control-border);
		border-radius: 8px;
		background: var(--input-bg);
		color: var(--text-ink);
		font-size: 1rem;
		line-height: 1.45;
	}

	textarea {
		resize: vertical;
		min-height: 92px;
		padding: 11px 12px;
	}

	input[type='number'] {
		min-height: 40px;
		padding: 8px 10px;
	}

	input[type='range'] {
		width: 100%;
		accent-color: var(--accent);
	}

	.composer-actions {
		display: flex;
		justify-content: flex-end;
		gap: 10px;
	}

	.control-panel {
		display: grid;
		gap: 16px;
		padding: 16px;
	}

	.control-panel label {
		display: grid;
		gap: 7px;
	}

	.control-panel label span {
		display: flex;
		justify-content: space-between;
		gap: 8px;
		color: var(--muted);
		font-family: var(--font-matrix-ui);
		font-size: 0.78rem;
		font-weight: 700;
		text-transform: uppercase;
	}

	.seed-list {
		display: grid;
		gap: 8px;
	}

	.seed-button {
		width: 100%;
		padding: 9px 10px;
		border: 1px solid var(--control-border);
		border-radius: 8px;
		background: var(--control-bg);
		color: var(--text-ink);
		font-size: 0.9rem;
		line-height: 1.25;
		text-align: left;
	}

	.model-facts {
		display: grid;
		gap: 8px;
		padding-top: 2px;
	}

	.model-facts div {
		display: grid;
		grid-template-columns: 88px minmax(0, 1fr);
		gap: 10px;
	}

	.model-facts dt {
		color: var(--muted);
		font-family: var(--font-matrix-ui);
		font-size: 0.72rem;
		font-weight: 700;
		text-transform: uppercase;
	}

	.model-facts dd {
		min-width: 0;
		overflow-wrap: anywhere;
	}

	.runtime-stats {
		max-height: 160px;
		overflow: auto;
		padding: 10px;
		border: 1px solid var(--control-border);
		border-radius: 8px;
		background: var(--muted-surface);
		color: var(--text-ink);
		font-family: var(--font-matrix-ui);
		font-size: 0.78rem;
		white-space: pre-wrap;
	}

	@keyframes blink {
		50% {
			opacity: 0;
		}
	}

	@media (max-width: 900px) {
		.llm-shell,
		.status-band {
			grid-template-columns: 1fr;
		}

		.chat-panel {
			grid-template-rows: minmax(320px, 58vh) auto;
		}

		.message {
			width: min(92%, 720px);
		}
	}

	@media (max-width: 640px) {
		.llm-page {
			width: min(100vw - 20px, 1180px);
			padding-top: 18px;
		}

		.title-row {
			align-items: stretch;
			flex-direction: column;
		}

		.load-button {
			width: 100%;
		}

		.transcript {
			padding: 12px;
		}

		.message {
			width: 100%;
		}
	}
</style>
