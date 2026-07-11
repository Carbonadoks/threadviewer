<script lang="ts">
	import { buildViewerHref } from '$lib/utils/viewerLinks';

	type RouteNavPage =
		| 'landing'
		| 'frontpage'
		| 'home'
		| 'threadviewer'
		| 'viewer2'
		| 'viewer2db'
		| 'twitterarchiveviewer'
		| 'semantic'
		| 'summary'
		| 'summary2'
		| 'blocked'
		| 'followinteraction'
		| 'followsearch'
		| 'mentions'
		| 'warg'
		| 'dialogue'
		| 'dialogue2'
		| 'chat'
		| 'board'
		| 'blog'
		| 'clock'
		| 'treeviewer'
		| 'xtreeviewer'
		| 'carousel'
		| 'town'
		| 'parallelboard'
		| 'band'
		| 'loom'
		| 'bisk2bisk'
		| 'matrix'
		| 'matrix-feed'
		| 'abstractfeed'
		| 'atproideasio'
		| 'llm'
		| 'card'
		| 'autobattler'
		| 'superautobisks'
		| 'localstorage'
		| 'analyzer'
		| 'cluster'
		| 'toponomy'
		| 'wordcloud'
		| 'hashtag'
		| 'jetstreamfiltered';
	type RouteNavAlign = 'start' | 'center';

	type RouteNavItem = {
		id: RouteNavPage;
		href: string;
		label: string;
		compactLabel?: string;
	};

	export let current: RouteNavPage;
	export let compact = false;
	export let align: RouteNavAlign = 'start';
	export let threadUrl: string | null = null;
	export let handle: string | null = null;
	export let dialogueHandleA: string | null = null;
	export let dialogueHandleB: string | null = null;
	export let hideThreadTools = false;

	const items: RouteNavItem[] = [
		{ id: 'landing', href: '/', label: 'Landing', compactLabel: 'Start' },
		{ id: 'frontpage', href: '/frontpage', label: 'Frontpage', compactLabel: 'Front' },
		{ id: 'viewer2', href: '/viewer2', label: 'Repo Viewer', compactLabel: 'Repo' },
		{ id: 'viewer2db', href: '/viewer2db', label: 'Repo DB', compactLabel: 'Repo DB' },
		{ id: 'twitterarchiveviewer', href: '/twitterarchiveviewer', label: 'Twitter Archive', compactLabel: 'X Archive' },
		{ id: 'semantic', href: '/semantic', label: 'Semantic', compactLabel: 'Semantic' },
		{ id: 'summary2', href: '/summary2', label: 'Repo Summary', compactLabel: 'Repo Sum' },
		{ id: 'blocked', href: '/blocked', label: 'Blocked', compactLabel: 'Blocked' },
		{ id: 'followinteraction', href: '/followinteraction', label: 'Follow Interaction', compactLabel: 'Follow Int' },
		{ id: 'followsearch', href: '/followsearch', label: 'Follow Search', compactLabel: 'Follow' },
		{ id: 'mentions', href: '/mentions', label: 'Mentions', compactLabel: 'Mentions' },
		{ id: 'warg', href: '/warg', label: 'Warg' },
		{ id: 'dialogue2', href: '/dialogue2', label: 'Dialogue', compactLabel: 'Repo Dlg' },
		{ id: 'chat', href: '/chat', label: 'Chat' },
		{ id: 'board', href: '/board', label: 'Board' },
		{ id: 'blog', href: '/blog', label: 'Blog' },
		{ id: 'clock', href: '/clock', label: 'Clock' },
		{ id: 'treeviewer', href: '/treeviewer', label: 'Treeviewer', compactLabel: 'Tree' },
		{ id: 'xtreeviewer', href: '/xtreeviewer', label: 'X Treeviewer', compactLabel: 'X Tree' },
		{ id: 'carousel', href: '/carousel', label: 'Carousel', compactLabel: 'Carousel' },
		{ id: 'parallelboard', href: '/parallelboard', label: 'Parallel Board', compactLabel: 'Parallel' },
		{ id: 'band', href: '/band', label: 'Band' },
		{ id: 'loom', href: '/loom', label: 'Loom' },
		{ id: 'bisk2bisk', href: '/bisk2bisk', label: 'Bisk2Bisk', compactLabel: 'Bisk2Bisk' },
		{ id: 'matrix', href: '/matrix', label: 'Matrix' },
		{ id: 'matrix-feed', href: '/matrix-feed', label: 'In Matrix', compactLabel: 'In Matrix' },
		{ id: 'abstractfeed', href: '/abstractfeed', label: 'Abstract Thread', compactLabel: 'Abstract' },
		{ id: 'atproideasio', href: '/atproideasio', label: 'atproideasio', compactLabel: 'Ideas' },
		{ id: 'llm', href: '/llm', label: 'LLM' },
		{ id: 'card', href: '/card', label: 'Cards', compactLabel: 'Cards' },
		{ id: 'autobattler', href: '/autobattler', label: 'Autobattler', compactLabel: 'Battle' },
		{ id: 'superautobisks', href: '/superautobisks', label: 'Super Auto Bisks', compactLabel: 'Auto Bisks' },
		{ id: 'localstorage', href: '/localstorage', label: 'localStorage', compactLabel: 'Storage' },
		{ id: 'hashtag', href: '/hashtag', label: 'Hashtag', compactLabel: 'Tags' },
		{ id: 'jetstreamfiltered', href: '/jetstreamfiltered', label: 'Jetstream Filtered', compactLabel: 'Jetstream' },
		{ id: 'analyzer', href: '/analyzer', label: 'Analyze' },
		{ id: 'toponomy', href: '/toponomy', label: 'Toponomy', compactLabel: 'Topo' },
		{ id: 'wordcloud', href: '/wordcloud', label: 'Word Cloud', compactLabel: 'Words' }
	];

	function hrefFor(item: RouteNavItem): string {
		if (
			item.id === 'home' ||
			item.id === 'threadviewer' ||
			item.id === 'viewer2' ||
			item.id === 'viewer2db' ||
			item.id === 'chat' ||
			item.id === 'board' ||
			item.id === 'blog' ||
			item.id === 'clock' ||
			item.id === 'treeviewer' ||
			item.id === 'carousel' ||
			item.id === 'parallelboard' ||
			item.id === 'band' ||
			item.id === 'bisk2bisk' ||
			item.id === 'abstractfeed'
		) {
			if (item.id === 'abstractfeed') {
				const nextUrl = threadUrl?.trim() ?? '';
				return nextUrl ? `${item.href}?url=${encodeURIComponent(nextUrl)}` : item.href;
			}
			return buildViewerHref(item.id, {
				url: threadUrl,
				handle
			});
		}

		if (item.id === 'dialogue' || item.id === 'dialogue2') {
			return buildViewerHref(item.id, {
				url: threadUrl,
				handleA: dialogueHandleA,
				handleB: dialogueHandleB
			});
		}

		if (item.id === 'matrix') {
			const nextHandle = handle?.trim() ?? '';
			return nextHandle ? `${item.href}?handle=${encodeURIComponent(nextHandle)}` : item.href;
		}

		const nextHandle = handle?.trim() ?? '';
		if (
			(item.id === 'analyzer' ||
				item.id === 'summary' ||
				item.id === 'summary2' ||
				item.id === 'blocked' ||
				item.id === 'followinteraction' ||
				item.id === 'followsearch' ||
				item.id === 'mentions' ||
				item.id === 'warg' ||
				item.id === 'wordcloud' ||
				item.id === 'loom' ||
				item.id === 'superautobisks') &&
			nextHandle
		) {
			return `${item.href}?handle=${encodeURIComponent(nextHandle)}`;
		}

		return item.href;
	}

	function shouldShowItem(item: RouteNavItem): boolean {
		if (!hideThreadTools) return true;
		return item.id !== 'treeviewer';
	}
</script>

<nav
	class="route-nav"
	class:compact
	class:center={align === 'center'}
	aria-label="Primary"
>
	{#each items as item}
		{#if shouldShowItem(item)}
			{@const active = item.id === current}
			<a
				href={hrefFor(item)}
				class="route-nav-link wobbly-border-light"
				class:active
				aria-current={active ? 'page' : undefined}
			>
				{compact ? item.compactLabel ?? item.label : item.label}
			</a>
		{/if}
	{/each}
</nav>

<style>
	/* Full-bleed: span the viewport regardless of the page's content column so the
	   nav reads as one wide, centered block on every page. Relies on the nav's
	   container being horizontally centered (the standard `margin: 0 auto` layout).
	   Side padding clears the fixed top-right ThemeToggle (right:14px, ~42px). */
	.route-nav {
		display: flex;
		flex-wrap: wrap;
		justify-content: center;
		gap: 10px;
		box-sizing: border-box;
		width: 100vw;
		position: relative;
		left: 50%;
		margin-left: -50vw;
		padding: 0 64px;
		margin-bottom: 18px;
	}

	.route-nav.center {
		justify-content: center;
	}

	.route-nav.compact {
		gap: 8px;
		margin-bottom: 10px;
	}

	.route-nav-link {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		padding: 8px 12px;
		border-radius: 999px;
		background: var(--control-bg);
		border: 1px solid var(--control-border);
		box-shadow: var(--shadow-soft);
		color: var(--text-ink);
		font-size: 0.9rem;
		font-weight: 600;
		line-height: 1.1;
		text-decoration: none;
		transition:
			transform 0.16s ease,
			background 0.16s ease,
			border-color 0.16s ease,
			box-shadow 0.16s ease;
	}

	.route-nav-link:hover {
		transform: translateY(-1px);
		background: var(--control-bg-hover);
		border-color: var(--control-border-hover);
		box-shadow: var(--shadow-medium);
	}

	.route-nav-link.active {
		background: color-mix(in srgb, var(--accent) 18%, var(--card-bg));
		border-color: color-mix(in srgb, var(--accent) 58%, var(--control-border));
		box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 16%, transparent);
	}

	.route-nav.compact .route-nav-link {
		padding: 6px 10px;
		font-size: 0.78rem;
	}

	@media (max-width: 640px) {
		.route-nav {
			gap: 8px;
			padding: 0 16px;
		}

		.route-nav-link {
			padding: 7px 10px;
			font-size: 0.84rem;
		}
	}
</style>
