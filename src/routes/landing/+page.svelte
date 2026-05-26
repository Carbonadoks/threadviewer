<script lang="ts">
	import '../../app.css';
	import RoughBorder from '$lib/components/RoughBorder.svelte';
	import RouteNav from '$lib/components/RouteNav.svelte';
</script>

<svelte:head>
	<title>Thread Viewer</title>
	<meta
		name="description"
		content="Thread Viewer turns Bluesky threads into chat, boards, trees, lanes, and cached analysis views."
	/>
</svelte:head>

<main class="landing-page">
	<div class="nav-shell">
		<RouteNav current="landing" compact align="center" />
	</div>

	<section class="hero-stage" aria-labelledby="landing-title">
		<div class="hero-paper" aria-hidden="true">
			<div class="paper-grid"></div>
			<div class="scribble-board">
				<svg class="thread-doodle" viewBox="0 0 780 520" aria-hidden="true">
					<path class="doodle-line ink" d="M88 96 C126 130, 144 163, 190 196 S292 262, 340 310 S428 398, 518 446" />
					<path class="doodle-line teal-line" d="M242 232 C298 196, 332 168, 420 150 S558 148, 644 98" />
					<path class="doodle-line purple-line" d="M365 322 C436 296, 492 286, 580 300 S692 330, 730 366" />
					<path class="doodle-line accent-line" d="M190 196 C160 266, 144 315, 94 390" />
				</svg>

				<div class="doodle-node root">root note</div>
				<div class="doodle-node reply-one">reply</div>
				<div class="doodle-node reply-two">hmm</div>
				<div class="doodle-node leaf">leaf</div>
				<div class="doodle-node branch">branch</div>
				<div class="doodle-node quote">quote lane</div>

				<div class="sticky-note chat-note">
					<strong>chat</strong>
					<span></span>
					<span></span>
					<span></span>
				</div>
				<div class="sticky-note map-note">
					<strong>map</strong>
					<i></i>
					<i></i>
					<i></i>
					<i></i>
				</div>
			</div>
		</div>

		<div class="hero-copy-card">
			<RoughBorder>
				<h1 id="landing-title">Thread Viewer</h1>
				<p class="hero-copy">
					Paste a Bluesky thread, pull it apart, fold it back together, chase quotes sideways,
					and see what shape the conversation was hiding.
				</p>
				<div class="hero-actions" aria-label="Primary actions">
					<a class="sketch-button primary" href="/viewer2">open the repo viewer</a>
					<a class="sketch-button" href="/treeviewer">open the tree toy</a>
					<a class="sketch-button" href="/parallelboard">open lanes</a>
				</div>
			</RoughBorder>
		</div>
	</section>

	<footer class="github-footer" aria-label="Project source">
		<a
			class="sketch-button primary github-link"
			href="https://github.com/Carbonadoks/threadviewer"
			target="_blank"
			rel="noreferrer"
		>
			View on GitHub
		</a>
	</footer>
</main>

<style>
	:global(body) {
		background: var(--landing-bg);
	}

	.landing-page,
	.landing-page a {
		font-family: var(--font-hand);
		letter-spacing: 0;
	}

	.landing-page {
		min-height: 100vh;
		display: flex;
		flex-direction: column;
		color: var(--landing-ink);
		background:
			linear-gradient(var(--landing-grid) 1px, transparent 1px),
			linear-gradient(90deg, var(--landing-grid) 1px, transparent 1px),
			var(--landing-bg);
		background-size: 28px 28px;
		overflow-x: hidden;
	}

	.nav-shell {
		width: min(1120px, calc(100% - 28px));
		margin: 0 auto;
		padding: 16px 0 4px;
	}

	.hero-stage {
		position: relative;
		flex: 1;
		min-height: 72vh;
		overflow: hidden;
		display: flex;
		align-items: center;
		padding: 64px max(18px, calc((100vw - 1120px) / 2)) 62px;
		isolation: isolate;
	}

	.hero-paper {
		position: absolute;
		inset: 14px max(14px, calc((100vw - 1180px) / 2)) 20px;
		z-index: -1;
		border-radius: 18px;
		background: var(--landing-paper);
		box-shadow: var(--landing-shadow);
		transform: rotate(-0.35deg);
	}

	.paper-grid {
		position: absolute;
		inset: 0;
		background-image:
			linear-gradient(var(--landing-grid-strong) 1px, transparent 1px),
			linear-gradient(90deg, var(--landing-grid-strong) 1px, transparent 1px);
		background-size: 36px 36px;
		border-radius: inherit;
	}

	.hero-paper::before,
	.hero-paper::after {
		content: "";
		position: absolute;
		width: 120px;
		height: 34px;
		background: var(--landing-tape);
		border: 1px solid var(--warm-border);
		box-shadow: var(--shadow-soft);
	}

	.hero-paper::before {
		left: 8%;
		top: -10px;
		transform: rotate(-7deg);
	}

	.hero-paper::after {
		right: 12%;
		bottom: -9px;
		transform: rotate(6deg);
	}

	.scribble-board {
		position: absolute;
		inset: 5% 2% 4% 38%;
		min-width: 640px;
	}

	.thread-doodle {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		overflow: visible;
	}

	.doodle-line {
		fill: none;
		stroke-linecap: round;
		stroke-linejoin: round;
		stroke-width: 7;
		stroke-dasharray: 1 13;
		filter: drop-shadow(0 2px 0 color-mix(in srgb, var(--landing-paper) 78%, transparent));
	}

	.ink {
		stroke: color-mix(in srgb, var(--landing-ink) 72%, transparent);
	}

	.teal-line {
		stroke: var(--landing-line-teal);
	}

	.purple-line {
		stroke: var(--landing-line-purple);
	}

	.accent-line {
		stroke: var(--landing-line-accent);
	}

	.doodle-node,
	.sticky-note {
		position: absolute;
		border: 2px solid var(--landing-ink);
		border-radius: 255px 18px 230px 20px / 16px 230px 18px 245px;
		background: var(--landing-card);
		box-shadow: var(--landing-card-shadow);
		color: var(--landing-ink);
	}

	.doodle-node {
		min-width: 96px;
		padding: 9px 12px;
		font-size: 0.88rem;
		font-weight: 800;
		text-align: center;
	}

	.root {
		left: 32px;
		top: 58px;
		transform: rotate(-5deg);
		background: var(--landing-node-root);
	}

	.reply-one {
		left: 160px;
		top: 168px;
		transform: rotate(3deg);
		background: var(--landing-node-reply-one);
	}

	.reply-two {
		left: 304px;
		top: 282px;
		transform: rotate(-2deg);
		background: var(--landing-node-reply-two);
	}

	.leaf {
		left: 478px;
		top: 402px;
		transform: rotate(4deg);
		background: var(--landing-node-leaf);
	}

	.branch {
		left: 430px;
		top: 94px;
		transform: rotate(-4deg);
		background: var(--landing-node-branch);
	}

	.quote {
		left: 648px;
		top: 270px;
		transform: rotate(3deg);
		background: var(--landing-node-quote);
	}

	.sticky-note {
		width: 184px;
		padding: 14px;
	}

	.sticky-note strong {
		display: block;
		margin-bottom: 10px;
		font-size: 1rem;
	}

	.chat-note {
		right: 28px;
		top: 42px;
		transform: rotate(2.5deg);
		background: var(--landing-note);
	}

	.chat-note span {
		display: block;
		height: 14px;
		margin-top: 8px;
		border: 1.5px solid var(--landing-soft-ink);
		border-radius: 999px;
		background: var(--landing-inline);
	}

	.chat-note span:nth-child(3) {
		width: 74%;
		margin-left: auto;
	}

	.chat-note span:nth-child(4) {
		width: 86%;
	}

	.map-note {
		left: 76px;
		bottom: 32px;
		height: 132px;
		transform: rotate(-3deg);
		background: var(--landing-map-note);
	}

	.map-note i {
		position: absolute;
		width: 14px;
		height: 14px;
		border-radius: 50%;
		background: var(--accent);
		box-shadow: 0 0 0 5px color-mix(in srgb, var(--accent) 16%, transparent);
	}

	.map-note i:nth-of-type(1) {
		left: 34px;
		bottom: 36px;
	}

	.map-note i:nth-of-type(2) {
		left: 74px;
		bottom: 72px;
		background: var(--landing-map-dot-two);
	}

	.map-note i:nth-of-type(3) {
		left: 124px;
		bottom: 44px;
		background: var(--landing-map-dot-three);
	}

	.map-note i:nth-of-type(4) {
		left: 138px;
		bottom: 90px;
		background: var(--landing-map-dot-four);
	}

	.hero-copy-card {
		width: min(560px, 100%);
		transform: rotate(-0.6deg);
	}

	.hero-copy-card :global(.rough-border-wrapper) {
		background: var(--landing-card);
		box-shadow: var(--landing-card-shadow);
	}

	.hero-copy-card :global(.rough-content) {
		padding: 26px;
	}

	h1,
	p {
		letter-spacing: 0;
	}

	h1 {
		margin: 0;
		color: var(--landing-ink);
		font-size: clamp(3.2rem, 8vw, 6.5rem);
		line-height: 0.88;
		font-weight: 900;
		text-wrap: balance;
	}

	.hero-copy {
		max-width: 510px;
		margin: 24px 0 0;
		color: var(--landing-muted-ink);
		font-size: 1.28rem;
		line-height: 1.35;
	}

	.hero-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 10px;
		margin-top: 26px;
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
		font-size: 0.98rem;
		font-weight: 900;
		text-decoration: none;
		box-shadow: var(--landing-card-shadow);
		transition:
			transform 0.14s ease,
			box-shadow 0.14s ease;
	}

	.sketch-button.primary {
		background: var(--landing-button-primary-bg);
		color: var(--landing-button-primary-text);
	}

	.sketch-button:hover {
		text-decoration: none;
		transform: translateY(-2px) rotate(-0.5deg);
		box-shadow: var(--landing-card-shadow);
	}

	.github-footer {
		display: flex;
		justify-content: center;
		padding: 12px max(18px, calc((100vw - 1120px) / 2)) 34px;
	}

	.github-footer .github-link {
		width: min(100%, 260px);
	}

	@media (max-width: 1180px) {
		.scribble-board {
			left: 30%;
			opacity: 0.74;
		}
	}

	@media (max-width: 820px) {
		.nav-shell {
			width: min(100% - 20px, 1120px);
			padding-top: 10px;
		}

		.hero-stage {
			min-height: 74vh;
			padding: 46px 18px 58px;
		}

		.hero-paper {
			inset: 10px;
		}

		.scribble-board {
			inset: 18% auto 0 5%;
			min-width: 650px;
			opacity: 0.28;
			transform: scale(0.84);
			transform-origin: left center;
		}

		.hero-copy-card {
			transform: rotate(0deg);
		}

		.hero-copy {
			font-size: 1.1rem;
		}
	}

	@media (max-width: 520px) {
		.hero-stage {
			padding-top: 36px;
		}

		.hero-copy-card :global(.rough-content) {
			padding: 20px;
		}

		.hero-actions {
			display: grid;
			grid-template-columns: 1fr;
		}

		.sketch-button {
			width: 100%;
		}
	}
</style>
