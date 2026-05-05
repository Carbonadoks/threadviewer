<script lang="ts">
	import { searchActorsTypeahead, getProfile, type ActorSuggestion, type ProfileInfo } from '$lib/api/bluesky';
	import { toastWarning } from '$lib/utils/toasts';

	let {
		onsearch,
		onprofile,
		onchange,
		disabled = false,
		initialHandle = '',
		placeholder = 'Search for a Bluesky user...',
		buttonLabel = 'Search'
	}: {
		onsearch: (handle: string) => void;
		onprofile?: (profile: ProfileInfo) => void;
		onchange?: (handle: string) => void;
		disabled?: boolean;
		initialHandle?: string;
		placeholder?: string;
		buttonLabel?: string;
	} = $props();

	let handle = $state('');
	let suggestions: ActorSuggestion[] = $state([]);
	let showSuggestions = $state(false);
	let activeIndex = $state(-1);
	let typeaheadTimer: ReturnType<typeof setTimeout> | undefined;
	let inputEl: HTMLInputElement;

	function submit(e: Event) {
		e.preventDefault();
		closeSuggestions();
		const trimmed = handle.trim();
		if (trimmed) {
			onsearch(trimmed);
		}
	}

	async function pickSuggestion(actor: ActorSuggestion) {
		handle = actor.handle;
		onchange?.(handle);
		closeSuggestions();
		try {
			const profile = await getProfile(actor.handle);
			onprofile?.(profile);
		} catch {
			toastWarning('Could not load profile details');
		}
	}

	function closeSuggestions() {
		showSuggestions = false;
		activeIndex = -1;
		suggestions = [];
	}

	async function fetchSuggestions() {
		const query = handle.replace(/^@/, '').trim();
		if (query.length < 2 || disabled) {
			closeSuggestions();
			return;
		}

		try {
			const results = await searchActorsTypeahead(query);
			// Only show if input still matches (avoid stale results)
			const current = handle.replace(/^@/, '').trim();
			if (current.length >= 2) {
				suggestions = results;
				showSuggestions = results.length > 0;
				activeIndex = -1;
			}
		} catch {
			// Silently fail — suggestions are optional
		}
	}

	function handleInput() {
		onchange?.(handle);
		clearTimeout(typeaheadTimer);
		typeaheadTimer = setTimeout(fetchSuggestions, 250);
	}

	function handleKeydown(e: KeyboardEvent) {
		if (!showSuggestions || suggestions.length === 0) return;

		if (e.key === 'ArrowDown') {
			e.preventDefault();
			activeIndex = (activeIndex + 1) % suggestions.length;
		} else if (e.key === 'ArrowUp') {
			e.preventDefault();
			activeIndex = activeIndex <= 0 ? suggestions.length - 1 : activeIndex - 1;
		} else if (e.key === 'Enter' && activeIndex >= 0) {
			e.preventDefault();
			pickSuggestion(suggestions[activeIndex]);
		} else if (e.key === 'Escape') {
			closeSuggestions();
		}
	}

	function handleBlur() {
		// Delay to allow click on suggestion to fire first
		setTimeout(closeSuggestions, 200);
	}

	$effect(() => {
		handle = initialHandle;
	});
</script>

<form class="search-bar" onsubmit={submit}>
	<div class="input-wrapper">
		<input
			type="text"
			bind:value={handle}
			bind:this={inputEl}
			oninput={handleInput}
			onkeydown={handleKeydown}
			onblur={handleBlur}
			onfocus={handleInput}
			{placeholder}
			{disabled}
			class="wobbly-border"
			autocomplete="off"
			role="combobox"
			aria-expanded={showSuggestions}
			aria-autocomplete="list"
			aria-controls="suggestions-list"
			aria-activedescendant={activeIndex >= 0 ? `suggestion-${activeIndex}` : undefined}
		/>
		{#if showSuggestions && suggestions.length > 0}
			<ul class="suggestions wobbly-border" id="suggestions-list" role="listbox">
				{#each suggestions as actor, i}
					<li
						id="suggestion-{i}"
						class="suggestion-item"
						class:active={i === activeIndex}
						role="option"
						aria-selected={i === activeIndex}
						onmousedown={() => pickSuggestion(actor)}
						onmouseenter={() => (activeIndex = i)}
					>
						{#if actor.avatar}
							<img src={actor.avatar} alt="" class="suggestion-avatar" />
						{:else}
							<div class="suggestion-avatar placeholder-avatar"></div>
						{/if}
						<div class="suggestion-text">
							<span class="suggestion-name">{actor.displayName || actor.handle}</span>
							<span class="suggestion-handle">@{actor.handle}</span>
						</div>
					</li>
				{/each}
			</ul>
		{/if}
	</div>
	<button type="submit" disabled={disabled || !handle.trim()} class="wobbly-border">
		{disabled ? 'Searching...' : buttonLabel}
	</button>
</form>

<style>
	.search-bar {
		display: flex;
		gap: 12px;
		max-width: 600px;
		margin: 0 auto;
		font-family: inherit;
	}

	.input-wrapper {
		flex: 1;
		position: relative;
	}

	input {
		width: 100%;
		padding: 10px 16px;
		font-family: inherit;
		font-size: 1.1rem;
		background: var(--card-bg);
		color: var(--text-ink);
		outline: none;
	}

	input:focus {
		border-color: var(--accent);
	}

	.suggestions {
		position: absolute;
		top: 100%;
		left: 0;
		right: 0;
		z-index: 100;
		background: var(--card-bg);
		list-style: none;
		margin: 4px 0 0;
		padding: 4px 0;
		max-height: 320px;
		overflow-y: auto;
		border-color: var(--muted);
	}

	.suggestion-item {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 8px 14px;
		cursor: pointer;
		transition: background 0.1s;
	}

	.suggestion-item:hover,
	.suggestion-item.active {
		background: var(--accent-light);
	}

	.suggestion-avatar {
		width: 32px;
		height: 32px;
		border-radius: 50%;
		object-fit: cover;
		flex-shrink: 0;
	}

	.placeholder-avatar {
		background: var(--muted);
		opacity: 0.3;
	}

	.suggestion-text {
		display: flex;
		flex-direction: column;
		min-width: 0;
	}

	.suggestion-name {
		font-size: 0.95rem;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.suggestion-handle {
		font-size: 0.8rem;
		color: var(--muted);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	button {
		padding: 10px 24px;
		font-family: inherit;
		font-size: 1.1rem;
		background: var(--accent);
		color: var(--accent-contrast);
		border-color: var(--text-ink);
		transition: opacity 0.2s;
	}

	button:hover:not(:disabled) {
		opacity: 0.85;
	}

	button:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	@media (max-width: 500px) {
		.search-bar {
			flex-direction: column;
		}
	}
</style>
