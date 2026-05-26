<script lang="ts">
	import { onDestroy } from 'svelte';
	import type { SelfReplyThread, ThreadPost } from '$lib/types';
	import {
		formatThreadExport,
		formatThreadPostMarkdown,
		formatThreadPostsMarkdown,
		type ThreadExportFormat,
		type ThreadExportIdentityMode
	} from '$lib/utils/threadExport';

	type ThreadExportScope = 'thread' | 'selected-post' | 'all-posts';

	interface Props {
		thread: SelfReplyThread;
		selectedPost?: ThreadPost | null;
		allPosts?: ThreadPost[];
		label?: string;
		compact?: boolean;
	}

	let {
		thread,
		selectedPost = null,
		allPosts = [],
		label = 'Export',
		compact = false
	}: Props = $props();

	let open = $state(false);
	let scope = $state<ThreadExportScope>('thread');
	let format = $state<ThreadExportFormat>('md');
	let identityMode = $state<ThreadExportIdentityMode>('author');
	let status = $state('');
	let copying = $state(false);
	let statusTimer: ReturnType<typeof setTimeout> | null = null;
	let hasExtraScopes = $derived(Boolean(selectedPost) || allPosts.length > 0);

	$effect(() => {
		if (scope === 'selected-post' && !selectedPost) {
			scope = 'thread';
		}
		if (scope === 'all-posts' && allPosts.length === 0) {
			scope = 'thread';
		}
	});

	function setStatus(message: string) {
		status = message;
		if (statusTimer) clearTimeout(statusTimer);
		statusTimer = setTimeout(() => {
			status = '';
			statusTimer = null;
		}, 2400);
	}

	function fallbackCopy(value: string): boolean {
		const textarea = document.createElement('textarea');
		textarea.value = value;
		textarea.setAttribute('readonly', '');
		textarea.style.position = 'fixed';
		textarea.style.left = '-9999px';
		document.body.appendChild(textarea);
		textarea.select();
		const copied = document.execCommand('copy');
		textarea.remove();
		return copied;
	}

	async function copyExport() {
		copying = true;
		try {
			const value =
				scope === 'selected-post' && selectedPost
					? formatThreadPostMarkdown(selectedPost, { identityMode })
					: scope === 'all-posts'
						? formatThreadPostsMarkdown(allPosts, {
								identityMode,
								title: 'All loaded board posts'
							})
						: formatThreadExport(thread, { format, identityMode });
			if (navigator.clipboard?.writeText) {
				await navigator.clipboard.writeText(value);
			} else if (!fallbackCopy(value)) {
				throw new Error('Clipboard unavailable');
			}
			setStatus(`Copied ${scope === 'thread' ? format.toUpperCase() : 'Markdown'}`);
			open = false;
		} catch {
			setStatus('Copy failed');
		} finally {
			copying = false;
		}
	}

	onDestroy(() => {
		if (statusTimer) clearTimeout(statusTimer);
	});
</script>

<div class="thread-export" class:compact>
	<button
		type="button"
		class="thread-export-toggle"
		aria-haspopup="dialog"
		aria-expanded={open}
		onclick={() => (open = !open)}
	>
		{label}
	</button>

	{#if open}
		<div class="thread-export-popover wobbly-border-light" role="dialog" aria-label="Thread export">
			{#if hasExtraScopes}
				<label>
					<span>Scope</span>
					<select bind:value={scope}>
						<option value="thread">Current thread</option>
						{#if selectedPost}
							<option value="selected-post">Selected post</option>
						{/if}
						{#if allPosts.length > 0}
							<option value="all-posts">All loaded posts</option>
						{/if}
					</select>
				</label>
			{/if}

			{#if scope === 'thread'}
				<label>
					<span>Format</span>
					<select bind:value={format}>
						<option value="md">Markdown</option>
						<option value="yaml">YAML</option>
						<option value="json">JSON</option>
					</select>
				</label>
			{:else}
				<div class="thread-export-fixed-format">
					<span>Format</span>
					<strong>Markdown</strong>
				</div>
			{/if}

			<label>
				<span>Authors</span>
				<select bind:value={identityMode}>
					<option value="author">Keep authors</option>
					<option value="anon">Anon IDs</option>
				</select>
			</label>

			<button type="button" class="thread-export-copy" disabled={copying} onclick={copyExport}>
				{copying ? 'Copying...' : 'Copy to clipboard'}
			</button>
		</div>
	{/if}

	{#if status}
		<span class="thread-export-status" aria-live="polite">{status}</span>
	{/if}
</div>

<style>
	.thread-export {
		position: relative;
		display: inline-flex;
		align-items: center;
		gap: 8px;
		font-family: inherit;
		letter-spacing: 0;
		z-index: 30;
	}

	.thread-export-toggle,
	.thread-export-copy {
		border: 1px solid var(--control-border, rgba(63, 56, 78, 0.24));
		border-radius: 7px;
		background: var(--control-bg, var(--card-bg, #fff));
		color: var(--text-ink, #2d2733);
		font: inherit;
		font-size: 0.78rem;
		font-weight: 800;
		letter-spacing: 0;
		cursor: pointer;
	}

	.thread-export-toggle {
		min-height: 28px;
		padding: 0 10px;
	}

	.compact .thread-export-toggle {
		min-height: 24px;
		padding: 0 8px;
		font-size: 0.72rem;
	}

	.thread-export-toggle:hover,
	.thread-export-toggle:focus-visible,
	.thread-export-copy:hover:not(:disabled),
	.thread-export-copy:focus-visible {
		background: var(--control-bg-hover, var(--muted-surface, #f2eee4));
		border-color: var(--control-border-hover, var(--control-border, rgba(63, 56, 78, 0.34)));
	}

	.thread-export-popover {
		position: absolute;
		top: calc(100% + 6px);
		right: 0;
		width: min(240px, calc(100vw - 32px));
		display: grid;
		gap: 8px;
		padding: 10px;
		border-radius: 8px;
		background: color-mix(in srgb, var(--card-bg, #fff) 96%, white);
		box-shadow: var(--shadow-soft, 0 10px 24px rgba(0, 0, 0, 0.14));
		color: var(--text-ink, #2d2733);
	}

	.thread-export-popover label {
		display: grid;
		gap: 3px;
		font-size: 0.68rem;
		font-weight: 800;
		color: var(--muted, #6b6670);
		text-transform: uppercase;
	}

	.thread-export-fixed-format {
		display: grid;
		gap: 3px;
		font-size: 0.68rem;
		font-weight: 800;
		color: var(--muted, #6b6670);
		text-transform: uppercase;
	}

	.thread-export-fixed-format strong {
		min-height: 30px;
		display: inline-flex;
		align-items: center;
		padding: 0 9px;
		border: 1px solid var(--control-border, rgba(63, 56, 78, 0.24));
		border-radius: 7px;
		background: color-mix(in srgb, var(--control-bg, var(--card-bg, #fff)) 88%, transparent);
		color: var(--text-ink, #2d2733);
		font-size: 0.8rem;
		text-transform: none;
	}

	.thread-export-popover select {
		min-width: 0;
		min-height: 30px;
		border: 1px solid var(--control-border, rgba(63, 56, 78, 0.24));
		border-radius: 7px;
		background: var(--control-bg, var(--card-bg, #fff));
		color: var(--text-ink, #2d2733);
		font: inherit;
		font-size: 0.8rem;
		font-weight: 700;
		text-transform: none;
	}

	.thread-export-copy {
		min-height: 32px;
		background: var(--accent, #6f61ff);
		color: var(--accent-contrast, white);
	}

	.thread-export-copy:disabled {
		opacity: 0.55;
		cursor: wait;
	}

	.thread-export-status {
		color: var(--muted, #6b6670);
		font-size: 0.72rem;
		font-weight: 800;
		white-space: nowrap;
	}
</style>
