<script lang="ts">
	import { onMount } from 'svelte';
	import { browser } from '$app/environment';
	import '../../app.css';
	import FontPicker from '$lib/components/FontPicker.svelte';
	import RouteNav from '$lib/components/RouteNav.svelte';
	import {
		REPO_CAR_INDEX_KEY,
		REPO_CAR_VALUE_PREFIX,
		deleteSavedRepoCar,
		readSavedRepoCarIndex,
		writeSavedRepoCarIndex,
		type SavedRepoCarEntry
	} from '$lib/utils/localStorageRepo';

	type StorageEntry = {
		key: string;
		value: string;
		bytes: number;
		kind: 'repo-car' | 'repo-index' | 'json' | 'text';
	};

	const fontFamilies: Record<string, string> = {
		virgil: "'Virgil', cursive",
		caveat: "'Caveat', cursive",
		patrick: "'Patrick Hand', cursive",
		'comic-neue': "'Comic Neue', cursive",
		inter: "'Inter', sans-serif",
		system: 'system-ui, -apple-system, sans-serif'
	};

	let fontKey = $state('patrick');
	let fontFamily = $derived(fontFamilies[fontKey] ?? fontFamilies.patrick);
	let entries = $state<StorageEntry[]>([]);
	let savedRepos = $state<SavedRepoCarEntry[]>([]);
	let searchQuery = $state('');
	let selectedKey = $state<string | null>(null);
	let keyDraft = $state('');
	let valueDraft = $state('');
	let status = $state<string | null>(null);
	let error = $state<string | null>(null);

	const filteredEntries = $derived.by(() => {
		const query = searchQuery.trim().toLowerCase();
		if (!query) return entries;
		return entries.filter(
			(entry) =>
				entry.key.toLowerCase().includes(query) || entry.value.toLowerCase().includes(query)
		);
	});
	const selectedEntry = $derived(
		selectedKey ? entries.find((entry) => entry.key === selectedKey) ?? null : null
	);
	const totalBytes = $derived(entries.reduce((sum, entry) => sum + entry.bytes, 0));
	const hasEditorValue = $derived(keyDraft.trim().length > 0 || valueDraft.length > 0);

	function byteLength(value: string): number {
		return new TextEncoder().encode(value).length;
	}

	function formatBytes(bytes: number): string {
		if (bytes <= 0) return '0 B';
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
		return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	}

	function classifyEntry(key: string, value: string): StorageEntry['kind'] {
		if (key === REPO_CAR_INDEX_KEY) return 'repo-index';
		if (key.startsWith(REPO_CAR_VALUE_PREFIX)) return 'repo-car';
		try {
			JSON.parse(value);
			return 'json';
		} catch {
			return 'text';
		}
	}

	function loadEntries(nextSelectedKey = selectedKey) {
		if (!browser) return;
		const nextEntries: StorageEntry[] = [];
		try {
			for (let index = 0; index < localStorage.length; index += 1) {
				const key = localStorage.key(index);
				if (!key) continue;
				const value = localStorage.getItem(key) ?? '';
				nextEntries.push({
					key,
					value,
					bytes: byteLength(value),
					kind: classifyEntry(key, value)
				});
			}
			nextEntries.sort((a, b) => a.key.localeCompare(b.key));
			entries = nextEntries;
			const indexedRepos = readSavedRepoCarIndex();
			savedRepos = indexedRepos.filter((repo) => localStorage.getItem(repo.key) !== null);
			if (savedRepos.length !== indexedRepos.length) {
				writeSavedRepoCarIndex(savedRepos);
			}
			if (nextSelectedKey && nextEntries.some((entry) => entry.key === nextSelectedKey)) {
				selectEntry(nextSelectedKey);
			} else if (nextEntries.length > 0 && !selectedKey) {
				selectEntry(nextEntries[0].key);
			} else if (!nextEntries.some((entry) => entry.key === selectedKey)) {
				selectedKey = null;
				keyDraft = '';
				valueDraft = '';
			}
			error = null;
		} catch (value) {
			error = value instanceof Error ? value.message : 'Could not read localStorage.';
		}
	}

	function selectEntry(key: string) {
		const value = browser ? localStorage.getItem(key) ?? '' : '';
		selectedKey = key;
		keyDraft = key;
		valueDraft = value;
		status = null;
		error = null;
	}

	function createEntry() {
		selectedKey = null;
		keyDraft = 'threadviewer:';
		valueDraft = '';
		status = 'New key ready.';
		error = null;
	}

	function saveEntry() {
		if (!browser) return;
		const nextKey = keyDraft.trim();
		if (!nextKey) {
			error = 'Key is required.';
			return;
		}
		try {
			if (selectedKey && selectedKey !== nextKey) {
				localStorage.removeItem(selectedKey);
			}
			localStorage.setItem(nextKey, valueDraft);
			selectedKey = nextKey;
			loadEntries(nextKey);
			status = `Saved ${nextKey}.`;
			error = null;
		} catch (value) {
			error = value instanceof Error ? value.message : 'Could not save this key.';
		}
	}

	async function deleteEntry() {
		if (!browser || !selectedKey) return;
		const ok = window.confirm(`Delete ${selectedKey}?`);
		if (!ok) return;
		try {
			const repoEntry = savedRepos.find((repo) => repo.key === selectedKey);
			if (repoEntry) {
				await deleteSavedRepoCar(repoEntry);
			} else {
				localStorage.removeItem(selectedKey);
			}
			const removedKey = selectedKey;
			selectedKey = null;
			keyDraft = '';
			valueDraft = '';
			loadEntries(null);
			status = `Deleted ${removedKey}.`;
			error = null;
		} catch (value) {
			error = value instanceof Error ? value.message : 'Could not delete this key.';
		}
	}

	function formatJsonValue() {
		try {
			valueDraft = JSON.stringify(JSON.parse(valueDraft), null, 2);
			status = 'Formatted JSON.';
			error = null;
		} catch {
			error = 'This value is not valid JSON.';
		}
	}

	function handleFontChange(key: string) {
		fontKey = key;
		try {
			localStorage.setItem('preferred-font', key);
		} catch {}
	}

	onMount(() => {
		try {
			const saved = localStorage.getItem('preferred-font');
			if (saved && saved in fontFamilies) fontKey = saved;
		} catch {}
		loadEntries(null);
	});
</script>

<svelte:head>
	<title>localStorage</title>
</svelte:head>

<main style="font-family: {fontFamily}">
	<header class="page-header">
		<RouteNav current="localstorage" align="center" />
		<div class="header-row">
			<div>
				<p class="eyebrow">Browser storage</p>
				<h1>localStorage</h1>
				<p class="subtitle">Inspect and edit the values saved by this app in your current browser.</p>
			</div>
			<FontPicker value={fontKey} onchange={handleFontChange} />
		</div>
	</header>

	<section class="storage-stats" aria-label="localStorage summary">
		<div class="stat-pill wobbly-border-light">
			<span>Keys</span>
			<strong>{entries.length.toLocaleString()}</strong>
		</div>
		<div class="stat-pill wobbly-border-light">
			<span>Stored Text</span>
			<strong>{formatBytes(totalBytes)}</strong>
		</div>
		<div class="stat-pill wobbly-border-light">
			<span>Saved Repos</span>
			<strong>{savedRepos.length.toLocaleString()}</strong>
		</div>
	</section>

	{#if savedRepos.length > 0}
		<section class="repo-strip" aria-label="Saved repo CAR files">
			{#each savedRepos as repo (repo.id)}
				<button
					type="button"
					class="repo-chip wobbly-border-light"
					class:active={selectedKey === repo.key}
					onclick={() => selectEntry(repo.key)}
				>
					<span>@{repo.handle ?? repo.did}</span>
					<strong>{formatBytes(repo.downloadedBytes)}</strong>
					<small>{repo.collection ?? 'full repo'}</small>
				</button>
			{/each}
		</section>
	{/if}

	<section class="storage-workspace">
		<aside class="key-browser wobbly-border-light" aria-label="localStorage keys">
			<div class="browser-toolbar">
				<input
					type="search"
					placeholder="Search keys or values..."
					bind:value={searchQuery}
					aria-label="Search localStorage"
				/>
				<button type="button" class="tool-button" onclick={() => loadEntries(selectedKey)}>Refresh</button>
				<button type="button" class="tool-button" onclick={createEntry}>New</button>
			</div>

			<div class="key-list" role="listbox" aria-label="Stored keys">
				{#if filteredEntries.length === 0}
					<p class="empty-state">No matching localStorage keys.</p>
				{:else}
					{#each filteredEntries as entry (entry.key)}
						<button
							type="button"
							class="key-row"
							class:active={entry.key === selectedKey}
							onclick={() => selectEntry(entry.key)}
						>
							<span class="key-name">{entry.key}</span>
							<span class="key-meta">
								{entry.kind} / {formatBytes(entry.bytes)}
							</span>
						</button>
					{/each}
				{/if}
			</div>
		</aside>

		<section class="editor-panel wobbly-border-light" aria-label="localStorage editor">
			<div class="editor-toolbar">
				<div>
					<p class="eyebrow">Selected key</p>
					<h2>{selectedEntry?.key ?? (hasEditorValue ? 'New key' : 'Nothing selected')}</h2>
				</div>
				<div class="editor-actions">
					<button type="button" class="tool-button" disabled={!hasEditorValue} onclick={formatJsonValue}>
						Format JSON
					</button>
					<button type="button" class="save-button" disabled={!keyDraft.trim()} onclick={saveEntry}>
						Save
					</button>
					<button type="button" class="danger-button" disabled={!selectedKey} onclick={deleteEntry}>
						Delete
					</button>
				</div>
			</div>

			<label class="field-label">
				<span>Key</span>
				<input type="text" bind:value={keyDraft} spellcheck="false" />
			</label>

			<label class="field-label value-field">
				<span>Value</span>
				<textarea bind:value={valueDraft} spellcheck="false"></textarea>
			</label>

			<div class="editor-footer">
				<span>{formatBytes(byteLength(valueDraft))}</span>
				{#if status}
					<span class="status">{status}</span>
				{/if}
				{#if error}
					<span class="error">{error}</span>
				{/if}
			</div>
		</section>
	</section>
</main>

<style>
	main {
		min-height: 100vh;
		padding: 28px;
		background: var(--bg-paper);
		color: var(--text-ink);
	}

	.page-header {
		max-width: 1180px;
		margin: 0 auto 18px;
	}

	.header-row,
	.editor-toolbar,
	.browser-toolbar,
	.editor-actions,
	.storage-stats,
	.repo-strip {
		display: flex;
		align-items: center;
		gap: 12px;
	}

	.header-row,
	.editor-toolbar {
		justify-content: space-between;
	}

	.eyebrow {
		color: var(--accent);
		font-size: 0.78rem;
		font-weight: 800;
		letter-spacing: 0;
		text-transform: uppercase;
	}

	h1 {
		font-size: clamp(2.2rem, 5vw, 4.4rem);
		line-height: 0.95;
	}

	h2 {
		font-size: 1.4rem;
		line-height: 1.1;
		overflow-wrap: anywhere;
	}

	.subtitle {
		max-width: 680px;
		color: var(--muted);
		font-size: 1.02rem;
	}

	.storage-stats,
	.repo-strip,
	.storage-workspace {
		max-width: 1180px;
		margin: 0 auto 16px;
	}

	.storage-stats,
	.repo-strip {
		flex-wrap: wrap;
	}

	.stat-pill,
	.repo-chip {
		background: var(--panel-bg);
		box-shadow: var(--shadow-soft);
	}

	.stat-pill {
		display: grid;
		gap: 2px;
		min-width: 150px;
		padding: 12px 14px;
	}

	.stat-pill span,
	.key-meta,
	.field-label span,
	.editor-footer,
	.repo-chip small {
		color: var(--muted);
		font-size: 0.78rem;
		font-weight: 700;
	}

	.stat-pill strong {
		font-size: 1.28rem;
		line-height: 1.1;
	}

	.repo-chip {
		display: grid;
		gap: 2px;
		padding: 10px 12px;
		text-align: left;
		color: var(--text-ink);
	}

	.repo-chip.active {
		border-color: var(--accent);
		background: var(--active-bg);
	}

	.storage-workspace {
		display: grid;
		grid-template-columns: minmax(280px, 380px) minmax(0, 1fr);
		gap: 16px;
		align-items: start;
	}

	.key-browser,
	.editor-panel {
		background: var(--panel-bg);
		box-shadow: var(--shadow-soft);
	}

	.key-browser {
		display: grid;
		gap: 12px;
		padding: 14px;
	}

	.browser-toolbar {
		flex-wrap: wrap;
	}

	input,
	textarea {
		width: 100%;
		border: 1px solid var(--control-border);
		border-radius: 10px;
		background: var(--input-bg);
		color: var(--text-ink);
	}

	input {
		min-height: 40px;
		padding: 8px 10px;
	}

	.browser-toolbar input {
		flex: 1 1 180px;
	}

	.tool-button,
	.save-button,
	.danger-button {
		min-height: 38px;
		padding: 8px 12px;
		border: 1px solid var(--control-border);
		border-radius: 999px;
		font-weight: 800;
	}

	.tool-button {
		background: var(--control-bg);
		color: var(--text-ink);
	}

	.save-button {
		background: var(--accent);
		color: var(--accent-contrast);
		border-color: color-mix(in srgb, var(--accent) 72%, var(--control-border));
	}

	.danger-button {
		background: var(--error-bg);
		color: var(--danger-text);
	}

	button:disabled {
		cursor: not-allowed;
		opacity: 0.55;
	}

	.key-list {
		display: grid;
		gap: 8px;
		max-height: 68vh;
		overflow: auto;
		padding-right: 2px;
	}

	.key-row {
		display: grid;
		gap: 3px;
		width: 100%;
		padding: 10px;
		border: 1px solid var(--control-border);
		border-radius: 10px;
		background: var(--control-bg);
		color: var(--text-ink);
		text-align: left;
	}

	.key-row.active {
		background: var(--active-bg);
		border-color: var(--accent);
	}

	.key-name {
		font-weight: 800;
		overflow-wrap: anywhere;
	}

	.editor-panel {
		display: grid;
		gap: 14px;
		min-width: 0;
		padding: 16px;
	}

	.editor-toolbar {
		align-items: flex-start;
		gap: 16px;
	}

	.editor-actions {
		flex-wrap: wrap;
		justify-content: flex-end;
	}

	.field-label {
		display: grid;
		gap: 6px;
	}

	textarea {
		min-height: 52vh;
		padding: 12px;
		font-family: var(--font-matrix-ui);
		font-size: 0.9rem;
		line-height: 1.4;
		resize: vertical;
	}

	.editor-footer {
		display: flex;
		flex-wrap: wrap;
		gap: 10px;
		justify-content: space-between;
	}

	.status {
		color: var(--accent);
	}

	.error {
		color: var(--danger-text);
	}

	.empty-state {
		color: var(--muted);
		padding: 12px 4px;
	}

	@media (max-width: 820px) {
		main {
			padding: 18px;
		}

		.header-row,
		.editor-toolbar {
			align-items: flex-start;
			flex-direction: column;
		}

		.storage-workspace {
			grid-template-columns: 1fr;
		}

		.key-list {
			max-height: 42vh;
		}

		.editor-actions {
			justify-content: flex-start;
		}
	}
</style>
