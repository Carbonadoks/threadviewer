<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import '../../app.css';
	import RouteNav from '$lib/components/RouteNav.svelte';
	import { rememberRecentThread } from '$lib/utils/recentThreads';
	import { writeCachedThread } from '$lib/utils/threadContentCache';
	import {
		convertXCaptureToThread,
		hydrateXQuotesWithFxtwitter,
		parseXThreadCapture,
		X_CAPTURE_ACK_TYPE
	} from '$lib/utils/xTreeThread';

	const ALLOWED_ORIGINS = new Set([
		'https://x.com',
		'https://twitter.com',
		'https://mobile.twitter.com'
	]);

	let error = $state<string | null>(null);
	let summary = $state<string | null>(null);
	let pasteValue = $state('');
	let handled = false;

	async function handleCapture(raw: unknown): Promise<boolean> {
		const capture = parseXThreadCapture(raw);
		if (!capture) return false;
		if (handled) return true;

		const converted = convertXCaptureToThread(capture);
		if (!converted) {
			error = 'Capture was valid JSON but contained no linkable thread.';
			return true;
		}

		handled = true;
		error = null;

		let quotesHydrated = 0;
		if (converted.quoteRefs.length > 0) {
			summary = `Fetching ${converted.quoteRefs.length} quoted post(s) via fxtwitter…`;
			quotesHydrated = await hydrateXQuotesWithFxtwitter(converted.quoteRefs);
		}

		const notes = [
			`${converted.tweetCount} posts from @${converted.rootHandle}`,
			quotesHydrated > 0 ? `${quotesHydrated} quote embed(s)` : '',
			converted.droppedCount > 0 ? `${converted.droppedCount} outside the main tree dropped` : '',
			capture.partial ? 'partial capture (hit request budget or rate limit)' : ''
		].filter(Boolean);
		summary = notes.join(' — ');

		await writeCachedThread({
			url: converted.url,
			rootPost: converted.thread.rootPost,
			rootUri: converted.thread.rootUri,
			depth: converted.thread.depth,
			isTruncated: converted.thread.isTruncated
		});
		rememberRecentThread(localStorage, {
			url: converted.url,
			title: converted.thread.rootPost.text,
			authorHandle: converted.rootHandle
		});
		await goto(`/treeviewer?url=${encodeURIComponent(converted.url)}`);
		return true;
	}

	function handleMessage(event: MessageEvent) {
		if (!ALLOWED_ORIGINS.has(event.origin)) return;
		if (!parseXThreadCapture(event.data)) return;
		// Ack immediately so the grabber stops re-posting / skips the clipboard fallback.
		(event.source as Window | null)?.postMessage(
			{ type: X_CAPTURE_ACK_TYPE },
			{ targetOrigin: event.origin }
		);
		void handleCapture(event.data);
	}

	function handlePasteSubmit(e: Event) {
		e.preventDefault();
		const raw = pasteValue.trim();
		if (!raw) return;
		void handleCapture(raw).then((recognized) => {
			if (!recognized) {
				error = 'Could not parse that JSON as an xtreeviewer capture payload.';
			}
		});
	}

	onMount(() => {
		window.addEventListener('message', handleMessage);
	});
	onDestroy(() => {
		if (typeof window !== 'undefined') window.removeEventListener('message', handleMessage);
	});
</script>

<svelte:head>
	<title>xtreeviewer — X thread capture</title>
</svelte:head>

<div class="page">
	<RouteNav current="xtreeviewer" hideThreadTools />

	<h1>xtreeviewer</h1>
	<p class="lede">
		View an X.com thread in the treeviewer. Capture happens in your own X tab with your own
		session — nothing is sent to any server; the thread goes straight into this browser's local
		cache.
	</p>

	{#if summary}
		<p class="status ok">Received: {summary}. Opening treeviewer…</p>
	{/if}
	{#if error}
		<p class="status err">{error}</p>
	{/if}

	<section class="card">
		<h2>1. Install the grabber (once)</h2>
		<p>
			With <a href="https://www.tampermonkey.net/" target="_blank" rel="noreferrer">Tampermonkey</a>
			installed, open
			<a href="/xtreeviewer.user.js" target="_blank">xtreeviewer.user.js</a> and confirm the install.
		</p>
	</section>

	<section class="card">
		<h2>2. Capture a thread</h2>
		<p>
			Open any thread on x.com and click the floating <strong>🌳 xtreeviewer</strong> button
			(bottom-right). It fetches the whole conversation with your session, then opens this page in
			a new tab and hands the thread over automatically. Leave this tab open — it is listening for
			the handoff right now.
		</p>
	</section>

	<section class="card">
		<h2>Fallback: paste captured JSON</h2>
		<p>
			If the automatic handoff fails, the grabber copies the capture JSON to your clipboard —
			paste it here.
		</p>
		<form onsubmit={handlePasteSubmit}>
			<textarea
				bind:value={pasteValue}
				rows="6"
				placeholder={'{"type":"xtreeviewer:thread","version":1,...}'}
			></textarea>
			<button type="submit" disabled={!pasteValue.trim()}>Load pasted capture</button>
		</form>
	</section>
</div>

<style>
	.page {
		max-width: 720px;
		margin: 0 auto;
		padding: 16px 20px 60px;
		font-family: 'Patrick Hand', system-ui, sans-serif;
	}

	h1 {
		margin: 18px 0 4px;
		font-size: 2rem;
	}

	.lede {
		margin: 0 0 18px;
		opacity: 0.8;
	}

	.card {
		border: 1.5px solid rgba(0, 0, 0, 0.35);
		border-radius: 10px;
		padding: 12px 16px;
		margin-bottom: 14px;
		background: rgba(255, 255, 255, 0.6);
	}

	.card h2 {
		margin: 0 0 6px;
		font-size: 1.15rem;
	}

	.card p {
		margin: 0 0 8px;
	}

	textarea {
		width: 100%;
		box-sizing: border-box;
		font-family: monospace;
		font-size: 12px;
		border: 1px solid rgba(0, 0, 0, 0.35);
		border-radius: 8px;
		padding: 8px;
	}

	button {
		margin-top: 8px;
		padding: 8px 14px;
		border-radius: 8px;
		border: 1.5px solid rgba(0, 0, 0, 0.5);
		background: #fff;
		cursor: pointer;
		font: inherit;
	}

	button:disabled {
		opacity: 0.5;
		cursor: default;
	}

	.status {
		padding: 10px 12px;
		border-radius: 8px;
		border: 1.5px solid;
	}

	.status.ok {
		border-color: #2e7d32;
		background: #e8f5e9;
	}

	.status.err {
		border-color: #c62828;
		background: #ffebee;
	}
</style>
