<script lang="ts">
	import { onDestroy } from 'svelte';
	import {
		readSavedRepoCarBytes,
		readSavedRepoCarEntry,
		saveRepoCarToLocalStorage,
		type SavedRepoCarEntry
	} from '$lib/utils/localStorageRepo';
	import { downloadRepoCar, type RepoDownloadProgress } from '$lib/utils/repoHydration';

	let {
		did = null,
		handle = null,
		displayName = null,
		avatar = null,
		collection = 'app.bsky.feed.post',
		label = 'Save Repo',
		loadLabel = 'Load Saved',
		disabled = false,
		compact = false,
		onsaved,
		onload
	}: {
		did?: string | null;
		handle?: string | null;
		displayName?: string | null;
		avatar?: string | null;
		collection?: string | null;
		label?: string;
		loadLabel?: string;
		disabled?: boolean;
		compact?: boolean;
		onsaved?: (entry: SavedRepoCarEntry) => void;
		onload?: (entry: SavedRepoCarEntry, carBytes: Uint8Array) => void | Promise<void>;
	} = $props();

	let saving = $state(false);
	let loadingSaved = $state(false);
	let savedEntry = $state<SavedRepoCarEntry | null>(null);
	let error = $state<string | null>(null);
	let progress = $state<RepoDownloadProgress | null>(null);
	let abortController: AbortController | null = null;

	const percent = $derived(
		progress && progress.totalBytes > 0
			? Math.min(100, Math.round((progress.receivedBytes / progress.totalBytes) * 100))
			: null
	);
	const buttonLabel = $derived(saving ? (percent === null ? 'Saving…' : `Saving ${percent}%`) : label);

	function formatBytes(bytes: number): string {
		if (bytes <= 0) return '0 B';
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
		return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	}

	function describeStorageError(value: unknown): string {
		const message = value instanceof Error ? value.message : String(value ?? '');
		if (/quota|storage/i.test(message)) {
			return 'Browser storage is full for this profile.';
		}
		return message || 'Could not save the repo in browser storage.';
	}

	async function loadSavedRepo() {
		const nextDid = did?.trim();
		if (!nextDid || saving || loadingSaved) return;

		loadingSaved = true;
		error = null;
		try {
			const entry = readSavedRepoCarEntry(nextDid, collection);
			if (!entry) {
				error = 'No saved CAR for this account yet.';
				return;
			}

			const carBytes = await readSavedRepoCarBytes(entry);
			if (!carBytes) {
				error = 'Saved CAR bytes were not found.';
				return;
			}

			await onload?.(entry, carBytes);
			savedEntry = entry;
		} catch (value) {
			error = value instanceof Error ? value.message : 'Could not load the saved CAR.';
		} finally {
			loadingSaved = false;
		}
	}

	async function saveRepo() {
		const nextDid = did?.trim();
		if (!nextDid || saving) return;

		abortController?.abort();
		abortController = new AbortController();
		saving = true;
		error = null;
		savedEntry = null;
		progress = null;

		try {
			const download = await downloadRepoCar(nextDid, {
				signal: abortController.signal,
				onDownloadProgress: (nextProgress) => {
					progress = nextProgress;
				}
			});
			const entry = await saveRepoCarToLocalStorage({
				carBytes: download.carBytes,
				did: nextDid,
				handle,
				displayName,
				avatar,
				collection,
				source: download.source,
				downloadedBytes: download.downloadedBytes,
				totalBytes: download.totalBytes
			});
			savedEntry = entry;
			onsaved?.(entry);
		} catch (value) {
			if ((value as any)?.name === 'AbortError') return;
			error = describeStorageError(value);
		} finally {
			saving = false;
			abortController = null;
		}
	}

	onDestroy(() => {
		abortController?.abort();
	});
</script>

<div class="save-repo-button-shell" class:compact>
	<button
		type="button"
		class="save-repo-button wobbly-border-light"
		disabled={disabled || saving || !did}
		onclick={saveRepo}
	>
		{buttonLabel}
	</button>
	{#if onload}
		<button
			type="button"
			class="save-repo-button load-button wobbly-border-light"
			disabled={disabled || saving || loadingSaved || !did}
			onclick={loadSavedRepo}
		>
			{loadingSaved ? 'Loading…' : loadLabel}
		</button>
	{/if}
	{#if saving && progress}
		<span class="save-status">
			{formatBytes(progress.receivedBytes)}{#if progress.totalBytes > 0} / {formatBytes(progress.totalBytes)}{/if}
		</span>
	{:else if savedEntry}
		<a class="save-status success" href="/localstorage">Saved {formatBytes(savedEntry.downloadedBytes)}</a>
	{:else if error}
		<span class="save-status error">{error}</span>
	{/if}
</div>

<style>
	.save-repo-button-shell {
		display: inline-flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 8px;
		min-width: 0;
	}

	.save-repo-button {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-height: 36px;
		padding: 8px 12px;
		border-radius: 999px;
		background: var(--control-bg);
		color: var(--text-ink);
		border-color: var(--control-border);
		font-size: 0.86rem;
		font-weight: 700;
		line-height: 1.1;
		white-space: nowrap;
		box-shadow: var(--shadow-soft);
		transition:
			transform 0.16s ease,
			background 0.16s ease,
			border-color 0.16s ease;
	}

	.save-repo-button:hover:not(:disabled) {
		transform: translateY(-1px);
		background: var(--control-bg-hover);
		border-color: var(--control-border-hover);
	}

	.save-repo-button:disabled {
		cursor: not-allowed;
		opacity: 0.58;
	}

	.save-status {
		max-width: 240px;
		color: var(--muted);
		font-size: 0.78rem;
		font-weight: 700;
		line-height: 1.25;
		overflow-wrap: anywhere;
	}

	.save-status.success {
		color: var(--accent);
		text-decoration: none;
	}

	.save-status.error {
		color: var(--danger-text);
	}

	.save-repo-button-shell.compact {
		gap: 6px;
	}

	.save-repo-button-shell.compact .save-repo-button {
		min-height: 30px;
		padding: 6px 9px;
		font-size: 0.76rem;
	}

	.save-repo-button-shell.compact .save-status {
		max-width: 160px;
		font-size: 0.72rem;
	}
</style>
