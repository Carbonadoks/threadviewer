<script lang="ts">
	import { onMount } from 'svelte';
	import type { Terminal } from '@xterm/xterm';
	import type { FitAddon } from '@xterm/addon-fit';
	import type { WebglAddon } from '@xterm/addon-webgl';
	import '@xterm/xterm/css/xterm.css';
	import type { MatrixTerminalPost } from '$lib/components/MatrixFeedTerminal.svelte';
	import {
		getMatrixTerminalFontOption,
		type MatrixTerminalFontId
	} from '$lib/constants/matrixTerminalFonts';

	let {
		posts = [],
		feedKey = '',
		handle = '',
		displayName = null,
		loading = false,
		paused = false,
		frameDelayMs = 72,
		terminalFontId = 'rain',
		panelIndex = 0,
		panelCount = 1,
		onopenpost = null,
		onpreview = null,
		idlePrimaryText = 'Insert a Bluesky handle to start this panel.',
		idleSecondaryText = 'Each panel types one full post, then moves to the next.',
		loadingText = 'Loading the latest 100 posts_with_replies...'
	}: {
		posts?: MatrixTerminalPost[];
		feedKey?: string;
		handle?: string;
		displayName?: string | null;
		loading?: boolean;
		paused?: boolean;
		frameDelayMs?: number;
		terminalFontId?: MatrixTerminalFontId;
		panelIndex?: number;
		panelCount?: number;
		onopenpost?: ((post: MatrixTerminalPost) => void) | null;
		onpreview?: ((post: MatrixTerminalPost) => void) | null;
		idlePrimaryText?: string;
		idleSecondaryText?: string;
		loadingText?: string;
	} = $props();

	let containerEl: HTMLDivElement;
	let terminal: Terminal | null = null;
	let fitAddon: FitAddon | null = null;
	let webglAddon: WebglAddon | null = null;
	let resizeObserver: ResizeObserver | null = null;
	let resizeTimeout: ReturnType<typeof setTimeout> | null = null;
	let renderToken = 0;
	let rendererMode = $state<'webgl' | 'dom'>('dom');
	let destroyed = false;
	let currentScreenMode = $state<'boot' | 'idle' | 'loading' | 'feed'>('boot');
	let activeStructureKey = '';
	let activeFeedKey = '';
	let drainingFeed = false;
	let hasRenderedFeedContent = false;
	let waitingBannerShown = false;
	let renderedPostIds = new Set<string>();
	let queuedPostIds = new Set<string>();
	let pendingBatches: PendingBatch[] = [];
	let activePost = $state<MatrixTerminalPost | null>(null);

	type TerminalLine = {
		color: string;
		text: string;
	};

	type PendingEntry = {
		post: MatrixTerminalPost;
		index: number;
		total: number;
	};

	type PendingBatch = {
		key: string;
		entries: PendingEntry[];
		totalAssigned: number;
	};

	function getActiveFont() {
		return getMatrixTerminalFontOption(terminalFontId);
	}

	const LOADING_INTERVAL_MS = 100;

	function sleep(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}

	async function waitWhilePaused(token: number) {
		while (!destroyed && token === renderToken && paused) {
			await sleep(40);
		}
	}

	async function pauseableSleep(ms: number, token: number) {
		let remainingMs = ms;
		while (!destroyed && token === renderToken && remainingMs > 0) {
			await waitWhilePaused(token);
			const sliceMs = Math.min(remainingMs, 40);
			await sleep(sliceMs);
			remainingMs -= sliceMs;
		}
	}

	function clamp(value: number, min: number, max: number): number {
		return Math.min(max, Math.max(min, value));
	}

	function truncate(text: string, width: number): string {
		if (width <= 1) return '';
		if (text.length <= width) return text;
		return `${text.slice(0, Math.max(0, width - 1))}...`;
	}

	function wrapParagraph(paragraph: string, width: number): string[] {
		const clean = paragraph.trim();
		if (!clean) return [''];
		if (width <= 4) return [clean];

		const words = clean.split(/\s+/);
		const lines: string[] = [];
		let current = '';

		for (const word of words) {
			if (!current) {
				if (word.length <= width) {
					current = word;
					continue;
				}

				for (let index = 0; index < word.length; index += width) {
					lines.push(word.slice(index, index + width));
				}
				continue;
			}

			const next = `${current} ${word}`;
			if (next.length <= width) {
				current = next;
				continue;
			}

			lines.push(current);
			if (word.length <= width) {
				current = word;
				continue;
			}

			for (let index = 0; index < word.length; index += width) {
				const segment = word.slice(index, index + width);
				if (segment.length === width || index + width < word.length) {
					lines.push(segment);
				} else {
					current = segment;
				}
			}
		}

		if (current) {
			lines.push(current);
		}

		return lines.length > 0 ? lines : [''];
	}

	function wrapText(text: string, width: number): string[] {
		const normalized = text.replace(/\r/g, '').trim() || '[no text body]';
		const paragraphs = normalized
			.split(/\n{2,}/)
			.map((paragraph) => paragraph.replace(/\n/g, ' ').trim());
		const wrapped: string[] = [];

		for (let index = 0; index < paragraphs.length; index += 1) {
			wrapped.push(...wrapParagraph(paragraphs[index], width));
			if (index < paragraphs.length - 1) {
				wrapped.push('');
			}
		}

		return wrapped.length > 0 ? wrapped : [''];
	}

	function clearTerminal() {
		if (!terminal) return;
		terminal.clear();
		terminal.write('\x1b[?25l\x1b[2J\x1b[H');
	}

	function getStructureKey(): string {
		return `${handle}::${displayName ?? ''}::${panelIndex}::${panelCount}`;
	}

	function getHeaderLines(totalPosts: number): TerminalLine[] {
		const width = Math.max((terminal?.cols ?? 40) - 1, 18);
		return [
			{
				color: '\x1b[1;92m',
				text: truncate(`PANEL ${panelIndex + 1}/${panelCount} :: @${handle || 'waiting'}`, width)
			},
			{
				color: '\x1b[38;5;48m',
				text: truncate(displayName || 'public Bluesky author feed', width)
			},
			{
				color: '\x1b[38;5;35m',
				text: truncate(`posts=${totalPosts} speed=${frameDelayMs}ms renderer=${rendererMode}`, width)
			},
			{
				color: '\x1b[38;5;22m',
				text: '-'.repeat(Math.max(12, Math.min(width, 26)))
			},
			{ color: '\x1b[0m', text: '' }
		];
	}

	function getIdleLines(): TerminalLine[] {
		return [
			...getHeaderLines(0),
			{ color: '\x1b[38;5;70m', text: idlePrimaryText },
			{ color: '\x1b[38;5;40m', text: idleSecondaryText }
		];
	}

	function getLoadingLines(frame: string): TerminalLine[] {
		return [
			...getHeaderLines(posts.length),
			{ color: '\x1b[38;5;118m', text: `SYNC ${frame}` },
			{ color: '\x1b[38;5;35m', text: loadingText }
		];
	}

	function getBatchIntroLines(totalAssigned: number, newEntries: number, refreshing: boolean): TerminalLine[] {
		const width = Math.max((terminal?.cols ?? 40) - 1, 18);
		return [
			...(hasRenderedFeedContent ? [{ color: '\x1b[0m', text: '' }] : []),
			...getHeaderLines(totalAssigned),
			{
				color: '\x1b[38;5;118m',
				text: truncate(
					refreshing
						? `SYNC COMPLETE :: +${newEntries} newly assigned posts`
						: `ASSIGNED PANEL SLICE :: ${totalAssigned} posts`,
					width
				)
			},
			{
				color: '\x1b[38;5;35m',
				text: truncate(
					refreshing ? 'continuing current stream without panel reset' : 'rendering local panel queue',
					width
				)
			},
			{ color: '\x1b[0m', text: '' }
		];
	}

	function getWaitingLines(): TerminalLine[] {
		const width = Math.max((terminal?.cols ?? 40) - 1, 18);
		return [
			{ color: '\x1b[0m', text: '' },
			{ color: '\x1b[38;5;70m', text: truncate('AWAITING NEXT FEED SNAPSHOT', width) },
			{ color: '\x1b[38;5;34m', text: truncate('current panel queue complete', width) },
			{ color: '\x1b[0m', text: '' }
		];
	}

	function buildPostLines(post: MatrixTerminalPost, index: number, total: number): TerminalLine[] {
		const width = Math.max((terminal?.cols ?? 40) - 1, 18);
		const bodyWidth = Math.max(width - 2, 12);
		const wrappedBody = wrapText(post.body, bodyWidth);
		const lines: TerminalLine[] = [
			{
				color: '\x1b[1;92m',
				text: truncate(`POST ${String(index + 1).padStart(3, '0')}/${String(total).padStart(3, '0')} @${post.authorHandle}`, width)
			},
			{
				color: '\x1b[38;5;71m',
				text: truncate(`${post.createdAtLabel} :: ${post.metaLabel}`, width)
			},
			...wrappedBody.map((line) => ({
				color: '\x1b[38;5;120m',
				text: truncate(line, width)
			}))
		];

		if (post.permalink) {
			lines.push({
				color: '\x1b[38;5;34m',
				text: truncate(post.permalink, width)
			});
		}

		lines.push({
			color: '\x1b[38;5;22m',
			text: '-'.repeat(Math.max(12, Math.min(width, 26)))
		});
		lines.push({ color: '\x1b[0m', text: '' });
		return lines;
	}

	async function writeLinesInstant(lines: TerminalLine[], token: number) {
		if (!terminal) return;

		for (const line of lines) {
			if (!terminal || token !== renderToken) return;
			await waitWhilePaused(token);
			terminal.writeln(`${line.color}${line.text}\x1b[0m`);
		}
	}

	async function typeLine(line: TerminalLine, token: number) {
		if (!terminal) return;

		const charDelayMs = clamp(Math.round(frameDelayMs / 3), 2, 28);
		await waitWhilePaused(token);
		terminal.write(line.color);
		for (const character of line.text) {
			if (!terminal || token !== renderToken) return;
			await waitWhilePaused(token);
			terminal.write(character);
			await pauseableSleep(charDelayMs, token);
		}
		if (!terminal || token !== renderToken) return;
		terminal.writeln('\x1b[0m');
	}

	async function runIdleScreen(token: number) {
		activePost = null;
		clearTerminal();
		await writeLinesInstant(getIdleLines(), token);
	}

	async function runLoadingLoop(token: number) {
		const frames = ['[    ]', '[=   ]', '[==  ]', '[=== ]', '[====]'];
		let frame = 0;

		while (!destroyed && terminal && loading && posts.length === 0 && token === renderToken) {
			activePost = null;
			clearTerminal();
			await writeLinesInstant(getLoadingLines(frames[frame]), token);
			frame = (frame + 1) % frames.length;
			await pauseableSleep(LOADING_INTERVAL_MS, token);
		}
	}

	function resetFeedState(clearScreen = false) {
		renderToken += 1;
		activeFeedKey = '';
		pendingBatches = [];
		renderedPostIds = new Set<string>();
		queuedPostIds = new Set<string>();
		drainingFeed = false;
		hasRenderedFeedContent = false;
		waitingBannerShown = false;
		currentScreenMode = 'boot';
		activePost = null;
		if (clearScreen) {
			clearTerminal();
		}
	}

	function buildPendingBatch(): PendingBatch | null {
		const entries = posts
			.map((post, index) => ({
				post,
				index,
				total: posts.length
			}))
			.filter((entry) => !renderedPostIds.has(entry.post.id) && !queuedPostIds.has(entry.post.id));

		if (entries.length === 0) return null;

		for (const entry of entries) {
			queuedPostIds.add(entry.post.id);
		}

		return {
			key: feedKey,
			entries,
			totalAssigned: posts.length
		};
	}

	async function appendWaitingBanner(token: number) {
		if (!terminal || token !== renderToken || waitingBannerShown) return;
		await writeLinesInstant(getWaitingLines(), token);
		waitingBannerShown = true;
	}

	async function runFeedDrain(token: number) {
		if (!terminal || drainingFeed) return;

		drainingFeed = true;
		currentScreenMode = 'feed';

		try {
			while (!destroyed && terminal && token === renderToken && pendingBatches.length > 0) {
				const [batch, ...rest] = pendingBatches;
				pendingBatches = rest;

				if (!hasRenderedFeedContent) {
					clearTerminal();
				}

				await writeLinesInstant(
					getBatchIntroLines(batch.totalAssigned, batch.entries.length, hasRenderedFeedContent),
					token
				);
				hasRenderedFeedContent = true;

				for (const entry of batch.entries) {
					if (!terminal || token !== renderToken) return;
					await waitWhilePaused(token);
					activePost = entry.post;

					const lines = buildPostLines(entry.post, entry.index, entry.total);
					for (const line of lines) {
						if (!terminal || token !== renderToken) return;
						await typeLine(line, token);
					}

					renderedPostIds.add(entry.post.id);
					queuedPostIds.delete(entry.post.id);
					await pauseableSleep(clamp(Math.round(frameDelayMs * 1.1), 18, 180), token);
				}
			}
		} finally {
			drainingFeed = false;
		}

		if (!destroyed && terminal && token === renderToken && pendingBatches.length === 0 && !loading) {
			await appendWaitingBanner(token);
		}
	}

	function ensureFeedDrain() {
		if (!terminal || drainingFeed || pendingBatches.length === 0) return;
		waitingBannerShown = false;
		renderToken += 1;
		const currentToken = renderToken;
		void runFeedDrain(currentToken);
	}

	function showIdleScreenIfNeeded() {
		if (!terminal || currentScreenMode === 'idle') return;
		renderToken += 1;
		currentScreenMode = 'idle';
		const currentToken = renderToken;
		void runIdleScreen(currentToken);
	}

	function showLoadingScreenIfNeeded() {
		if (!terminal || currentScreenMode === 'loading') return;
		renderToken += 1;
		currentScreenMode = 'loading';
		const currentToken = renderToken;
		void runLoadingLoop(currentToken);
	}

	function syncFeedState() {
		if (!terminal) return;

		if (loading && posts.length === 0 && !hasRenderedFeedContent && pendingBatches.length === 0) {
			showLoadingScreenIfNeeded();
			return;
		}

		if (posts.length === 0) {
			if (!hasRenderedFeedContent) {
				showIdleScreenIfNeeded();
				return;
			}

			if (!loading && !drainingFeed && pendingBatches.length === 0) {
				renderToken += 1;
				const currentToken = renderToken;
				void appendWaitingBanner(currentToken);
			}
			return;
		}

		if (feedKey !== activeFeedKey) {
			activeFeedKey = feedKey;
			const nextBatch = buildPendingBatch();
			if (nextBatch) {
				pendingBatches = [...pendingBatches, nextBatch];
			}
		}

		if (pendingBatches.length > 0) {
			ensureFeedDrain();
			return;
		}

		if (!loading && hasRenderedFeedContent && !drainingFeed) {
			renderToken += 1;
			const currentToken = renderToken;
			void appendWaitingBanner(currentToken);
		}
	}

	onMount(() => {
		async function initTerminal() {
			const [{ Terminal }, { FitAddon }, { WebglAddon }] = await Promise.all([
				import('@xterm/xterm'),
				import('@xterm/addon-fit'),
				import('@xterm/addon-webgl')
			]);

			if (destroyed) return;

			const activeFont = getActiveFont();
			const nextTerminal = new Terminal({
				allowTransparency: true,
				convertEol: true,
				cursorBlink: true,
				cursorStyle: 'bar',
				disableStdin: true,
				fontFamily: activeFont.family,
				fontSize: activeFont.terminalSize,
				fontWeight: activeFont.terminalWeight,
				lineHeight: activeFont.terminalLineHeight,
				scrollback: 0,
				smoothScrollDuration: 0,
				theme: {
					background: '#030605',
					foreground: '#9bff88',
					cursor: '#b7ff9d',
					selectionBackground: '#17401d',
					black: '#020403',
					brightBlack: '#154018',
					green: '#49ff57',
					brightGreen: '#c7ff9e',
					cyan: '#65ffd8',
					brightCyan: '#9ffff0',
					yellow: '#e1ff71',
					brightYellow: '#f7ffba'
				}
			});

			const nextFitAddon = new FitAddon();
			nextTerminal.loadAddon(nextFitAddon);
			nextTerminal.open(containerEl);
			nextFitAddon.fit();

			try {
				const nextWebglAddon = new WebglAddon();
				nextTerminal.loadAddon(nextWebglAddon);
				webglAddon = nextWebglAddon;
				rendererMode = 'webgl';
			} catch {
				rendererMode = 'dom';
			}

			terminal = nextTerminal;
			fitAddon = nextFitAddon;

			resizeObserver = new ResizeObserver(() => {
				if (resizeTimeout) clearTimeout(resizeTimeout);
				resizeTimeout = setTimeout(() => {
					fitAddon?.fit();
				}, 90);
			});
			resizeObserver.observe(containerEl);

			requestAnimationFrame(() => {
				fitAddon?.fit();
				activeStructureKey = getStructureKey();
				syncFeedState();
			});
		}

		void initTerminal();

		return () => {
			destroyed = true;
			renderToken += 1;
			if (resizeTimeout) clearTimeout(resizeTimeout);
			resizeObserver?.disconnect();
			webglAddon?.dispose();
			terminal?.dispose();
			webglAddon = null;
			fitAddon = null;
			terminal = null;
		};
	});

	$effect(() => {
		handle;
		displayName;
		panelIndex;
		panelCount;
		if (!terminal) return;

		const nextStructureKey = getStructureKey();
		if (nextStructureKey !== activeStructureKey) {
			activeStructureKey = nextStructureKey;
			resetFeedState(true);
			syncFeedState();
		}
	});

	$effect(() => {
		feedKey;
		posts;
		loading;
		frameDelayMs;
		if (!terminal) return;
		syncFeedState();
	});

	$effect(() => {
		paused;
		if (!terminal || paused) return;
		syncFeedState();
	});

	$effect(() => {
		terminalFontId;
		if (!terminal) return;

		const activeFont = getActiveFont();
		terminal.options.fontFamily = activeFont.family;
		terminal.options.fontSize = activeFont.terminalSize;
		terminal.options.fontWeight = activeFont.terminalWeight;
		terminal.options.lineHeight = activeFont.terminalLineHeight;
		fitAddon?.fit();
	});
	function handleActivePostClick() {
		if (!activePost) return;
		if (onopenpost) {
			onopenpost(activePost);
			return;
		}
		onpreview?.(activePost);
	}

</script>

<div class="matrix-terminal-panel-shell">
	<div class="matrix-terminal-panel" bind:this={containerEl}></div>
	{#if activePost && (onopenpost || onpreview)}
		<button
			type="button"
			class="matrix-preview-hitbox"
			class:paused
			aria-label={`${onopenpost ? 'Open' : 'Preview'} latest visible post by @${activePost.authorHandle}`}
			onclick={handleActivePostClick}
		>
			<span class="matrix-preview-chip">{onopenpost ? 'Open on Bluesky' : 'Preview latest post'}</span>
		</button>
	{/if}
</div>

<style>
	.matrix-terminal-panel-shell {
		position: relative;
		width: 100%;
		height: 100%;
		min-height: 0;
	}

	.matrix-terminal-panel {
		position: relative;
		width: 100%;
		height: 100%;
		min-height: 0;
		background:
			radial-gradient(circle at top, rgba(81, 255, 104, 0.08), transparent 24%),
			linear-gradient(180deg, rgba(4, 11, 7, 0.98), rgba(2, 7, 4, 0.995));
	}

	.matrix-terminal-panel::before {
		content: '';
		position: absolute;
		inset: 0;
		background:
			repeating-linear-gradient(
				180deg,
				rgba(123, 255, 146, 0.03) 0,
				rgba(123, 255, 146, 0.03) 1px,
				transparent 1px,
				transparent 4px
			),
			linear-gradient(180deg, rgba(150, 255, 165, 0.03), transparent 18%, transparent 82%, rgba(150, 255, 165, 0.02));
		pointer-events: none;
		mix-blend-mode: screen;
	}

	.matrix-terminal-panel::after {
		content: '';
		position: absolute;
		inset: 0;
		box-shadow:
			inset 0 0 40px rgba(28, 138, 48, 0.08),
			inset 0 -20px 40px rgba(6, 36, 12, 0.35);
		pointer-events: none;
	}

	.matrix-terminal-panel :global(.xterm) {
		position: relative;
		height: 100%;
		padding: 10px 12px 12px;
	}

	.matrix-terminal-panel :global(.xterm-viewport) {
		overflow: hidden !important;
		background: transparent !important;
	}

	.matrix-terminal-panel :global(.xterm-screen),
	.matrix-terminal-panel :global(.xterm-helpers),
	.matrix-terminal-panel :global(.xterm-rows) {
		background: transparent !important;
	}

	.matrix-terminal-panel :global(.xterm-screen canvas) {
		filter:
			drop-shadow(0 0 6px rgba(105, 255, 120, 0.2))
			drop-shadow(0 0 14px rgba(105, 255, 120, 0.12));
	}

	.matrix-preview-hitbox {
		position: absolute;
		inset: 0;
		display: flex;
		align-items: flex-end;
		justify-content: flex-end;
		padding: 12px;
		border: 0;
		background: transparent;
		cursor: pointer;
	}

	.matrix-preview-chip {
		padding: 5px 8px;
		border: 1px solid rgba(138, 255, 161, 0.2);
		border-radius: 999px;
		background: rgba(3, 10, 5, 0.5);
		color: rgba(210, 255, 197, 0.72);
		font-family: var(--font-matrix-ui);
		font-size: 0.56rem;
		letter-spacing: 0.16em;
		text-transform: uppercase;
		transition:
			background 120ms ease,
			border-color 120ms ease,
			color 120ms ease;
	}

	.matrix-preview-hitbox:hover .matrix-preview-chip,
	.matrix-preview-hitbox:focus-visible .matrix-preview-chip,
	.matrix-preview-hitbox.paused .matrix-preview-chip {
		border-color: rgba(156, 255, 174, 0.46);
		background: rgba(7, 22, 11, 0.82);
		color: rgba(238, 255, 228, 0.96);
	}
</style>
