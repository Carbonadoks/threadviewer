<script>
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { Toaster } from 'svelte-sonner';
	import Lightbox from '$lib/components/Lightbox.svelte';
	import ThemeToggle from '$lib/components/ThemeToggle.svelte';

	let { children } = $props();
	let hideThemeToggle = $derived(page.url.searchParams.get('embed') === 'thread-section');

	function systemTheme() {
		if (typeof window === 'undefined') return 'light';
		return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
	}

	function applyTheme(nextTheme) {
		document.documentElement.dataset.theme = nextTheme;
		document.documentElement.style.colorScheme = nextTheme;
	}

	function readPreferredTheme() {
		const saved = localStorage.getItem('preferred-theme');
		return saved === 'light' || saved === 'dark' ? saved : systemTheme();
	}

	onMount(() => {
		applyTheme(readPreferredTheme());

		function handleStorage(event) {
			if (event.key !== 'preferred-theme') return;
			applyTheme(event.newValue === 'light' || event.newValue === 'dark' ? event.newValue : systemTheme());
		}

		window.addEventListener('storage', handleStorage);
		return () => window.removeEventListener('storage', handleStorage);
	});
</script>

<Toaster position="bottom-right" richColors closeButton />
<Lightbox />
{#if !hideThemeToggle}
	<ThemeToggle />
{/if}
{@render children()}
