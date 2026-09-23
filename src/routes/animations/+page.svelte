<script lang="ts">
	import '../../app.css';
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import RouteNav from '$lib/components/RouteNav.svelte';

	// Each film is a self-contained p5.js page in static/films/. They run in global
	// p5 mode, so they can't share one document — each gets its own iframe.
	type Film = {
		id: string;
		step: string;
		name: string;
		tagline: string;
		blurb: string;
		src: string;
		route: string;
		routeLabel: string;
		color: string;
	};

	const films: Film[] = [
		{
			id: 'tree',
			step: '01',
			name: 'Treeviewer',
			tagline: 'A thousand replies, one tree',
			blurb:
				'Paste any post from a huge conversation and see every reply as one tree. Then read it one path at a time and steer between the branches.',
			src: '/films/treeviewer.html',
			route: '/treeviewer',
			routeLabel: 'open the treeviewer',
			color: 'var(--landing-feature-tree)'
		},
		{
			id: 'lanes',
			step: '02',
			name: 'Parallel Board',
			tagline: 'Thousands of lanes, one board',
			blurb:
				'Every quote post becomes its own lane. Replies fan out into trees, and fetch mode keeps pulling in more, generation after generation.',
			src: '/films/parallelboard.html',
			route: '/parallelboard',
			routeLabel: 'open the parallel board',
			color: 'var(--landing-feature-parallel)'
		},
		{
			id: 'repo',
			step: '03',
			name: 'Repo Viewer',
			tagline: 'Your whole repo, one timeline',
			blurb:
				'Pull an entire Bluesky repo into your browser, lay every post out on a timeline, then filter down to exactly what you are looking for.',
			src: '/films/repoviewer.html',
			route: '/viewer2',
			routeLabel: 'open the repo viewer',
			color: 'var(--landing-feature-board)'
		}
	];

	let selectedId = $derived(
		films.some((f) => f.id === page.url.searchParams.get('film'))
			? (page.url.searchParams.get('film') as string)
			: films[0].id
	);
	let selected = $derived(films.find((f) => f.id === selectedId) ?? films[0]);
	let frameHeight = $state(820);

	function select(id: string) {
		const url = new URL(page.url);
		url.searchParams.set('film', id);
		goto(url, { replaceState: true, noScroll: true, keepFocus: true });
	}

	function onTabKey(event: KeyboardEvent, index: number) {
		const delta = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
		if (!delta) return;
		event.preventDefault();
		const next = films[(index + delta + films.length) % films.length];
		select(next.id);
		document.getElementById(`film-tab-${next.id}`)?.focus();
	}

	// Same-origin iframe: size it to its content so the film's controls never scroll inside a box.
	function autosize(frame: HTMLIFrameElement) {
		let observer: ResizeObserver | null = null;
		const attach = () => {
			observer?.disconnect();
			const root = frame.contentDocument?.documentElement;
			if (!root) return;
			const measure = () => (frameHeight = Math.ceil(root.getBoundingClientRect().height));
			observer = new ResizeObserver(measure);
			observer.observe(root);
			measure();
		};
		frame.addEventListener('load', attach);
		return () => {
			frame.removeEventListener('load', attach);
			observer?.disconnect();
		};
	}
</script>

<svelte:head>
	<title>Thread Viewer · the tour</title>
	<meta
		name="description"
		content="Three short animated films explaining Thread Viewer's Treeviewer, Parallel Board and Repo Viewer."
	/>
</svelte:head>

<main class="tour-page">
	<RouteNav current="animations" />

	<header class="tour-head">
		<p class="eyebrow">the tour · three short films</p>
		<h1>What Thread Viewer does, <span>in about four minutes</span></h1>
		<p class="lede">
			Thread Viewer has three big ideas. Each one gets a ninety-second film. Pick one, press play, then try
			it for real.
		</p>
	</header>

	<div class="film-picker" role="tablist" aria-label="Films">
		{#each films as film, i (film.id)}
			<button
				id="film-tab-{film.id}"
				class="film-card"
				type="button"
				role="tab"
				aria-selected={film.id === selected.id}
				aria-controls="film-panel"
				tabindex={film.id === selected.id ? 0 : -1}
				style="--film-color: {film.color}"
				onclick={() => select(film.id)}
				onkeydown={(e) => onTabKey(e, i)}
			>
				<span class="step">{film.step}</span>
				<strong>{film.name}</strong>
				<span class="tagline">{film.tagline}</span>
			</button>
		{/each}
	</div>

	<div id="film-panel" class="film-panel" role="tabpanel" aria-labelledby="film-tab-{selected.id}">
		<div class="film-intro">
			<p>{selected.blurb}</p>
			<a class="sketch-button primary" href={selected.route}>{selected.routeLabel} →</a>
		</div>

		{#key selected.id}
			<iframe
				{@attach autosize}
				class="film-frame"
				src={selected.src}
				title="{selected.name} showreel"
				allow="fullscreen; autoplay"
				allowfullscreen
				style="height: {frameHeight}px"
			></iframe>
		{/key}

		<nav class="film-next" aria-label="Other films">
			{#each films.filter((f) => f.id !== selected.id) as other (other.id)}
				<button class="sketch-button" type="button" onclick={() => select(other.id)}>
					watch {other.name}
				</button>
			{/each}
		</nav>
	</div>
</main>

<style>
	:global(body) {
		background: var(--landing-bg);
	}

	.tour-page {
		min-height: calc(100vh - var(--app-header-height, 0px));
		padding: 36px max(16px, calc((100vw - 1280px) / 2)) 48px;
		display: grid;
		gap: 22px;
		align-content: start;
		color: var(--landing-ink);
		font-family: var(--font-hand);
		background:
			linear-gradient(var(--landing-grid) 1px, transparent 1px),
			linear-gradient(90deg, var(--landing-grid) 1px, transparent 1px),
			var(--landing-bg);
		background-size: 28px 28px;
		overflow-x: hidden;
	}

	.tour-head {
		display: grid;
		gap: 8px;
	}

	.eyebrow {
		margin: 0;
		font-size: 0.9rem;
		letter-spacing: 0.12em;
		text-transform: uppercase;
		color: var(--landing-soft-ink);
	}

	h1 {
		margin: 0;
		font-size: clamp(2.2rem, 5.4vw, 4rem);
		line-height: 0.95;
		font-weight: 900;
		text-wrap: balance;
	}

	h1 span {
		color: var(--landing-feature-thread);
	}

	.lede {
		margin: 4px 0 0;
		max-width: 62ch;
		color: var(--landing-muted-ink);
		font-size: 1.15rem;
		line-height: 1.4;
	}

	.film-picker {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 14px;
	}

	.film-card {
		display: grid;
		gap: 4px;
		justify-items: start;
		text-align: left;
		padding: 14px 16px;
		font-family: var(--font-hand);
		color: var(--landing-ink);
		background: var(--landing-card);
		border: 2px solid var(--landing-ink);
		border-radius: 255px 18px 230px 20px / 16px 230px 18px 245px;
		box-shadow: var(--landing-card-shadow);
		cursor: pointer;
		transition:
			transform 0.14s ease,
			background 0.14s ease;
	}

	.film-card:nth-child(1) {
		transform: rotate(-0.8deg);
	}

	.film-card:nth-child(3) {
		transform: rotate(0.7deg);
	}

	.film-card:hover {
		transform: translateY(-2px) rotate(-0.4deg);
	}

	.film-card[aria-selected='true'] {
		background: var(--landing-node-root);
		box-shadow: 8px 10px 0 color-mix(in srgb, var(--film-color) 45%, transparent);
	}

	.film-card:focus-visible {
		outline: 3px solid var(--film-color);
		outline-offset: 3px;
	}

	.step {
		font-size: 0.85rem;
		color: var(--film-color);
		font-weight: 900;
	}

	.film-card strong {
		font-size: 1.45rem;
		line-height: 1;
	}

	.tagline {
		color: var(--landing-muted-ink);
		font-size: 1rem;
	}

	.film-panel {
		display: grid;
		gap: 14px;
	}

	.film-intro {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 12px 20px;
	}

	.film-intro p {
		margin: 0;
		max-width: 70ch;
		font-size: 1.1rem;
		line-height: 1.4;
		color: var(--landing-muted-ink);
	}

	.film-frame {
		display: block;
		width: 100%;
		border: 0;
		border-radius: 14px;
		background: #13110e;
		box-shadow: var(--landing-shadow);
	}

	.film-next {
		display: flex;
		flex-wrap: wrap;
		gap: 10px;
	}

	.sketch-button {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-height: 42px;
		border: 2px solid var(--landing-ink);
		border-radius: 255px 17px 230px 18px / 18px 230px 16px 245px;
		padding: 0 15px;
		background: var(--landing-button-bg);
		color: var(--landing-ink);
		font-family: var(--font-hand);
		font-size: 0.98rem;
		font-weight: 900;
		text-decoration: none;
		box-shadow: var(--landing-card-shadow);
		cursor: pointer;
	}

	.sketch-button.primary {
		background: var(--landing-button-primary-bg);
		color: var(--landing-button-primary-text);
	}

	.sketch-button:hover {
		text-decoration: none;
		transform: translateY(-2px) rotate(-0.5deg);
	}

	@media (max-width: 720px) {
		.tour-page {
			padding-top: 24px;
		}

		.film-picker {
			grid-template-columns: 1fr;
		}

		.film-card,
		.film-card:nth-child(1),
		.film-card:nth-child(3) {
			transform: none;
		}

		.film-intro .sketch-button {
			width: 100%;
		}
	}
</style>
