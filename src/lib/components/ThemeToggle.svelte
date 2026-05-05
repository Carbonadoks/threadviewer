<script lang="ts">
	import { onMount } from 'svelte';

	type Theme = 'light' | 'dark';

	let theme: Theme = $state('light');

	function systemTheme(): Theme {
		if (typeof window === 'undefined') return 'light';
		return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
	}

	function applyTheme(nextTheme: Theme, persist = true) {
		theme = nextTheme;
		document.documentElement.dataset.theme = nextTheme;
		document.documentElement.style.colorScheme = nextTheme;

		if (persist) {
			localStorage.setItem('preferred-theme', nextTheme);
		}
	}

	function toggleTheme() {
		applyTheme(theme === 'dark' ? 'light' : 'dark');
	}

	onMount(() => {
		const saved = localStorage.getItem('preferred-theme');
		applyTheme(saved === 'light' || saved === 'dark' ? saved : systemTheme(), false);
	});
</script>

<button
	type="button"
	class="theme-toggle"
	aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
	aria-pressed={theme === 'dark'}
	onclick={toggleTheme}
	title={theme === 'dark' ? 'Light mode' : 'Dark mode'}
>
	<span class="toggle-track" aria-hidden="true">
		<span class="toggle-thumb">{theme === 'dark' ? 'D' : 'L'}</span>
	</span>
	<span class="toggle-label">{theme === 'dark' ? 'Dark' : 'Light'}</span>
</button>

<style>
	.theme-toggle {
		position: fixed;
		top: 14px;
		right: 14px;
		z-index: 50;
		display: inline-flex;
		align-items: center;
		gap: 8px;
		padding: 6px 10px 6px 6px;
		border: 1px solid var(--control-border);
		border-radius: 999px;
		background: var(--control-bg);
		color: var(--text-ink);
		box-shadow: var(--shadow-soft);
		backdrop-filter: blur(14px);
		transition:
			transform 140ms ease,
			background 140ms ease,
			border-color 140ms ease;
	}

	.theme-toggle:hover {
		transform: translateY(-1px);
		background: var(--control-bg-hover);
		border-color: var(--control-border-hover);
	}

	.toggle-track {
		position: relative;
		width: 42px;
		height: 24px;
		border-radius: 999px;
		background: var(--muted-surface);
		border: 1px solid var(--control-border);
	}

	.toggle-thumb {
		position: absolute;
		top: 2px;
		left: 2px;
		display: grid;
		width: 18px;
		height: 18px;
		place-items: center;
		border-radius: 50%;
		background: var(--accent);
		color: var(--accent-contrast);
		font-size: 0.65rem;
		font-family: system-ui, -apple-system, sans-serif;
		font-weight: 800;
		line-height: 1;
		transition: transform 160ms ease;
	}

	:global([data-theme='dark']) .toggle-thumb {
		transform: translateX(18px);
	}

	.toggle-label {
		font-size: 0.8rem;
		font-weight: 700;
		line-height: 1;
	}

	@media (max-width: 640px) {
		.theme-toggle {
			top: 10px;
			right: 10px;
			padding-right: 8px;
		}

		.toggle-label {
			display: none;
		}
	}
</style>
