<script lang="ts">
	import { onMount, setContext } from 'svelte';
	import { page } from '$app/state';
	import { Toaster } from 'svelte-sonner';
	import Lightbox from '$lib/components/Lightbox.svelte';
	import '../app.css';
	import RouteNavLinks from '$lib/components/RouteNavLinks.svelte';
	import { ROUTE_NAV_CONTEXT, type RouteNavContext, type RouteNavRegistration } from '$lib/utils/routeNav';
	import ThemeToggle from '$lib/components/ThemeToggle.svelte';

	let { children } = $props();
	let headerHeight = $state(0);
	let registered = $state.raw<{ context: RouteNavContext; pathname: string } | null>(null);
	let current = $derived((page.url.pathname.replace(/^\/|\/$/g, '') || 'animations') as RouteNavContext['current']);
	let navigation = $derived<RouteNavContext>(registered?.pathname === page.url.pathname && registered.context.current === current
		? registered.context
		: { current, threadUrl: page.url.searchParams.get('url'), handle: page.url.searchParams.get('handle'),
			dialogueHandleA: page.url.searchParams.get('handleA'), dialogueHandleB: page.url.searchParams.get('handleB') });

	setContext<RouteNavRegistration>(ROUTE_NAV_CONTEXT, {
		register(context) {
			// Inline viewers must not replace their host route's navigation context.
			if (context.current !== current) return () => {};
			const entry = { context, pathname: page.url.pathname };
			registered = entry;
			return () => {
				if (registered?.context === context) registered = null;
			};
		}
	});

	let hideThemeToggle = $derived(['thread-section', 'tree'].includes(page.url.searchParams.get('embed') ?? ''));

	function systemTheme() {
		if (typeof window === 'undefined') return 'light';
		return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
	}

	function applyTheme(nextTheme: string) {
		document.documentElement.dataset.theme = nextTheme;
		document.documentElement.style.colorScheme = nextTheme;
	}

	function readPreferredTheme() {
		const saved = localStorage.getItem('preferred-theme');
		return saved === 'light' || saved === 'dark' ? saved : systemTheme();
	}

	onMount(() => {
		applyTheme(readPreferredTheme());

		function handleStorage(event: StorageEvent) {
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
<div class="app-shell" style:--app-header-height={`${hideThemeToggle ? 0 : headerHeight}px`}>
	{#if !hideThemeToggle}
		<header class="app-header" bind:clientHeight={headerHeight}>
			<RouteNavLinks {...navigation} />
		</header>
	{/if}
	{@render children()}
</div>

<style>
	.app-header {
		position: relative;
		padding: 16px 120px 14px;
		/* Follows the page's font picker (FontPicker sets --app-font on the root). */
		font-family: var(--app-font, var(--font-hand));
		color: var(--landing-ink);
		background:
			linear-gradient(var(--landing-grid) 1px, transparent 1px),
			linear-gradient(90deg, var(--landing-grid) 1px, transparent 1px),
			var(--landing-bg);
		background-size: 28px 28px;
	}

	@media (max-width: 640px) {
		.app-header {
			padding: 56px 16px 14px;
		}
	}
</style>
