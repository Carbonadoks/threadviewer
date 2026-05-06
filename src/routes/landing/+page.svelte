<script lang="ts">
	import '../../app.css';
	import RoughBorder from '$lib/components/RoughBorder.svelte';
	import RouteNav from '$lib/components/RouteNav.svelte';

	type Feature = {
		title: string;
		href: string;
		label: string;
		description: string;
		details: string[];
		color: string;
		tilt: string;
	};

	const readerTools: Feature[] = [
		{
			title: 'Thread Viewer',
			href: '/threadviewer',
			label: 'find the long ones',
			description: 'Search an account, shake out the self-reply chains, and pick whichever trail looks suspiciously interesting.',
			details: ['cached feed slices', 'depth filters', 'four list disguises'],
			color: 'var(--landing-feature-thread)',
			tilt: '-1.4deg'
		},
		{
			title: 'Chat',
			href: '/chat',
			label: 'read it like a room',
			description: 'Paste one post URL and get the whole thread as a compact transcript with branches and embeds still attached.',
			details: ['avatars', 'date breaks', 'branch picker'],
			color: 'var(--landing-feature-chat)',
			tilt: '1deg'
		},
		{
			title: 'Board',
			href: '/board',
			label: 'pin the thread up',
			description: 'Spread replies across a board so forks, loops, and strange little side paths are easier to see.',
			details: ['pan', 'zoom', 'minimap'],
			color: 'var(--landing-feature-board)',
			tilt: '-0.7deg'
		},
		{
			title: 'Treeviewer',
			href: '/treeviewer',
			label: 'pick a path',
			description: 'Start on the longest chain, expand the tree, open quotes as lanes, then read it as chat or tiny forum notes.',
			details: ['quote lanes', 'forum mode', 'collapsible branches'],
			color: 'var(--landing-feature-tree)',
			tilt: '1.6deg'
		},
		{
			title: 'Parallel Board',
			href: '/parallelboard',
			label: 'lanes beside lanes',
			description: 'Line related threads next to each other when the conversation starts behaving like a folded paper map.',
			details: ['aligned quotes', 'lane reading', 'tree shortcut'],
			color: 'var(--landing-feature-parallel)',
			tilt: '-1deg'
		}
	];

	const thinkingTools: Feature[] = [
		{
			title: 'Analyzer',
			href: '/analyzer',
			label: 'sort the thoughts',
			description: 'Turn cached self-reply threads into clusters, novelty trails, and odd little distances between ideas.',
			details: ['embedding map', 'novelty', 'compare accounts'],
			color: 'var(--landing-feature-analyzer)',
			tilt: '0.8deg'
		},
		{
			title: 'Cluster',
			href: '/cluster',
			label: 'big pile map',
			description: 'Browse the larger cached atlas, filter by author or cluster, and open representative threads from the scatter.',
			details: ['global snapshot', 'cluster filters', 'thread inspector'],
			color: 'var(--landing-feature-cluster)',
			tilt: '-1.3deg'
		},
		{
			title: 'Semantic',
			href: '/semantic',
			label: 'search by vibe',
			description: 'Look for posts by meaning instead of exact words, then jump back into the cached context.',
			details: ['semantic ranking', 'cache search', 'source links'],
			color: 'var(--landing-feature-semantic)',
			tilt: '1.4deg'
		},
		{
			title: 'Summary',
			href: '/summary',
			label: 'what keeps showing up',
			description: 'Fold an account cache into repeated posts, mentions, liked things, reposts, and busy thread corners.',
			details: ['mentions', 'repeated posts', 'thread highlights'],
			color: 'var(--landing-feature-summary)',
			tilt: '-0.8deg'
		},
		{
			title: 'Word Cloud',
			href: '/wordcloud',
			label: 'word confetti',
			description: 'A quick language sketch for seeing which terms keep returning to the table.',
			details: ['frequency', 'account focus', 'visual scan'],
			color: 'var(--landing-feature-wordcloud)',
			tilt: '0.9deg'
		}
	];

	const sideRooms: Feature[] = [
		{
			title: 'Follow Interaction',
			href: '/followinteraction',
			label: 'who nudged what',
			description: 'Check how a profile touches follows through likes, replies, quotes, and reposts.',
			details: ['kind filters', 'counts', 'post references'],
			color: 'var(--landing-feature-follow)',
			tilt: '-1deg'
		},
		{
			title: 'Dialogue',
			href: '/dialogue2',
			label: 'two voices',
			description: 'Read cached traces between accounts as a back-and-forth instead of a pile of separate posts.',
			details: ['two-account view', 'cache dialogue', 'thread context'],
			color: 'var(--landing-feature-dialogue)',
			tilt: '1.2deg'
		},
		{
			title: 'Judge',
			href: '/judge',
			label: 'clipboard mode',
			description: 'Open a thread in the judging workflow for structured review experiments.',
			details: ['scoring', 'cached judgments', 'model knobs'],
			color: 'var(--landing-feature-judge)',
			tilt: '-0.5deg'
		},
		{
			title: 'Matrix Feed',
			href: '/matrix-feed',
			label: 'terminal stream',
			description: 'Let a feed run through a terminal-style surface when normal scrolling feels too tidy.',
			details: ['terminal UI', 'feed playback', 'preview overlay'],
			color: 'var(--landing-feature-matrix)',
			tilt: '1deg'
		},
		{
			title: 'Toponomy',
			href: '/toponomy',
			label: 'map scraps',
			description: 'Explore compact point artifacts and top-level maps made from cached thread data.',
			details: ['overview', 'compact points', 'inspector'],
			color: 'var(--landing-feature-toponomy)',
			tilt: '-1.5deg'
		},
		{
			title: 'Town',
			href: '/town',
			label: 'walk around',
			description: 'A spatial experiment where cached social data becomes a place to wander through.',
			details: ['tile map', 'profile markers', 'experiments'],
			color: 'var(--landing-feature-town)',
			tilt: '0.6deg'
		}
	];

	const doodleSteps = [
		'paste one bsky.app URL',
		'watch the thread become a tree',
		'open the quote side-paths',
		'read, fold, compare, wander'
	];
</script>

<svelte:head>
	<title>Thread Viewer - a messy thread playground</title>
	<meta
		name="description"
		content="A playful landing page for Thread Viewer: chat, boards, tree views, quote lanes, semantic maps, summaries, and odd little cached-thread experiments."
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
					<a class="sketch-button primary" href="/threadviewer">open the usual viewer</a>
					<a class="sketch-button" href="/treeviewer">open the tree toy</a>
					<a class="sketch-button" href="/parallelboard">open lanes</a>
				</div>
			</RoughBorder>
		</div>
	</section>

	<section class="doodle-strip" aria-labelledby="doodle-title">
		<div class="section-heading">
			<p>How it tends to go</p>
			<h2 id="doodle-title">One post goes in. A little conversation contraption comes out.</h2>
		</div>
		<div class="step-string">
			{#each doodleSteps as step, index}
				<div class="step-scrap" style={`--step-tilt: ${index % 2 === 0 ? '-1deg' : '1.2deg'}`}>
					<span>{index + 1}</span>
					<p>{step}</p>
				</div>
			{/each}
		</div>
	</section>

	<section class="tool-shelf" aria-labelledby="reader-title">
		<div class="section-heading">
			<p>Thread readers</p>
			<h2 id="reader-title">Different little windows for the same tangled thing.</h2>
		</div>
		<div class="feature-grid reader-grid">
			{#each readerTools as feature}
				<a class="tool-link" href={feature.href} style={`--feature-color: ${feature.color}; --tilt: ${feature.tilt}`}>
					<RoughBorder>
						<article class="tool-card">
							<h3>{feature.title}</h3>
							<p>{feature.description}</p>
						</article>
					</RoughBorder>
				</a>
			{/each}
		</div>
	</section>

	<section class="tool-shelf thinking-shelf" aria-labelledby="thinking-title">
		<div class="section-heading">
			<p>Thinking tables</p>
			<h2 id="thinking-title">When the cache gets big enough to start making shapes.</h2>
		</div>
		<div class="feature-grid">
			{#each thinkingTools as feature}
				<a class="tool-link" href={feature.href} style={`--feature-color: ${feature.color}; --tilt: ${feature.tilt}`}>
					<RoughBorder>
						<article class="tool-card">
							<h3>{feature.title}</h3>
							<p>{feature.description}</p>
						</article>
					</RoughBorder>
				</a>
			{/each}
		</div>
	</section>

	<section class="tool-shelf" aria-labelledby="rooms-title">
		<div class="section-heading">
			<p>Side drawers</p>
			<h2 id="rooms-title">Other odd surfaces for poking the same data.</h2>
		</div>
		<div class="feature-grid side-grid">
			{#each sideRooms as feature}
				<a class="tool-link small" href={feature.href} style={`--feature-color: ${feature.color}; --tilt: ${feature.tilt}`}>
					<RoughBorder>
						<article class="tool-card">
							<h3>{feature.title}</h3>
							<p>{feature.description}</p>
						</article>
					</RoughBorder>
				</a>
			{/each}
		</div>
	</section>

	<footer class="github-footer" aria-label="Project source">
		<a class="sketch-button primary github-link" href="https://github.com/Carbonadoks/threadviewer" target="_blank" rel="noreferrer">
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
		min-height: 76vh;
		overflow: hidden;
		display: flex;
		align-items: center;
		padding: 64px max(18px, calc((100vw - 1120px) / 2)) 78px;
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

	.ink { stroke: color-mix(in srgb, var(--landing-ink) 72%, transparent); }
	.teal-line { stroke: var(--landing-line-teal); }
	.purple-line { stroke: var(--landing-line-purple); }
	.accent-line { stroke: var(--landing-line-accent); }

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

	.root { left: 32px; top: 58px; transform: rotate(-5deg); background: var(--landing-node-root); }
	.reply-one { left: 160px; top: 168px; transform: rotate(3deg); background: var(--landing-node-reply-one); }
	.reply-two { left: 304px; top: 282px; transform: rotate(-2deg); background: var(--landing-node-reply-two); }
	.leaf { left: 478px; top: 402px; transform: rotate(4deg); background: var(--landing-node-leaf); }
	.branch { left: 430px; top: 94px; transform: rotate(-4deg); background: var(--landing-node-branch); }
	.quote { left: 648px; top: 270px; transform: rotate(3deg); background: var(--landing-node-quote); }

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

	.map-note i:nth-of-type(1) { left: 34px; bottom: 36px; }
	.map-note i:nth-of-type(2) { left: 74px; bottom: 72px; background: var(--landing-map-dot-two); }
	.map-note i:nth-of-type(3) { left: 124px; bottom: 44px; background: var(--landing-map-dot-three); }
	.map-note i:nth-of-type(4) { left: 138px; bottom: 90px; background: var(--landing-map-dot-four); }

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

	.section-heading p {
		margin: 0 0 10px;
		color: var(--warm-text);
		font-size: 0.9rem;
		font-weight: 900;
		line-height: 1.1;
	}

	h1,
	h2,
	h3,
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
	}

	.hero-actions {
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

	.sketch-button:hover,
	.tool-link:hover {
		text-decoration: none;
		transform: translateY(-2px) rotate(var(--tilt, -0.5deg));
	}

	.sketch-button:hover {
		box-shadow: var(--landing-card-shadow);
	}

	.doodle-strip,
	.tool-shelf {
		padding: 56px max(18px, calc((100vw - 1120px) / 2));
	}

	.doodle-strip {
		background: var(--landing-section);
	}

	.thinking-shelf {
		background: var(--landing-section-alt);
	}

	.github-footer {
		display: flex;
		justify-content: center;
		padding: 22px max(18px, calc((100vw - 1120px) / 2)) 58px;
		background: var(--landing-section-alt);
	}

	.github-footer .github-link {
		width: min(100%, 260px);
	}

	.section-heading {
		max-width: 760px;
		margin-bottom: 28px;
	}

	.section-heading h2 {
		margin: 0;
		color: var(--landing-ink);
		font-size: clamp(1.8rem, 4vw, 3rem);
		line-height: 1;
		font-weight: 900;
		text-wrap: balance;
	}

	.step-string {
		display: grid;
		grid-template-columns: repeat(4, minmax(0, 1fr));
		gap: 14px;
	}

	.step-scrap {
		min-height: 112px;
		border: 2px solid var(--landing-ink);
		border-radius: 18px 255px 20px 230px / 230px 20px 255px 18px;
		background: var(--landing-card);
		padding: 16px;
		box-shadow: var(--landing-card-shadow);
		transform: rotate(var(--step-tilt));
	}

	.step-scrap span {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 28px;
		height: 28px;
		border: 2px solid var(--landing-ink);
		border-radius: 50%;
		background: var(--landing-step-chip);
		font-weight: 900;
	}

	.step-scrap p {
		margin: 13px 0 0;
		color: var(--landing-muted-ink);
		font-size: 1.02rem;
		line-height: 1.25;
		font-weight: 800;
	}

	.feature-grid {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 18px;
		align-items: stretch;
	}

	.reader-grid {
		grid-template-columns: repeat(5, minmax(0, 1fr));
	}

	.side-grid {
		grid-template-columns: repeat(3, minmax(0, 1fr));
	}

	.tool-link {
		display: block;
		min-height: 100%;
		color: var(--landing-ink);
		text-decoration: none;
		transform: rotate(var(--tilt));
		transition: transform 0.14s ease;
	}

	.tool-link :global(.rough-border-wrapper) {
		height: 100%;
		background: color-mix(in srgb, var(--feature-color) 10%, var(--landing-card));
		box-shadow: var(--landing-card-shadow);
	}

	.tool-link :global(.rough-content) {
		height: 100%;
		padding: 18px;
	}

	.tool-card {
		display: flex;
		min-height: 248px;
		height: 100%;
		flex-direction: column;
	}

	.tool-link.small .tool-card {
		min-height: 228px;
	}

	.tool-card h3 {
		margin: 0;
		font-size: 1.34rem;
		line-height: 1;
		font-weight: 900;
	}

	.tool-card p {
		margin: 13px 0 0;
		color: var(--landing-muted-ink);
		font-size: 0.98rem;
		line-height: 1.28;
	}

	@media (max-width: 1180px) {
		.reader-grid,
		.feature-grid,
		.side-grid {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}

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
			min-height: 78vh;
			padding: 46px 18px 86px;
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

		.doodle-strip,
		.tool-shelf {
			padding: 44px 18px;
		}

		.step-string,
		.reader-grid,
		.feature-grid,
		.side-grid {
			grid-template-columns: 1fr;
		}

		.tool-link,
		.step-scrap {
			transform: rotate(0deg);
		}

		.tool-card,
		.tool-link.small .tool-card {
			min-height: 0;
		}
	}

	@media (max-width: 520px) {
		.hero-stage {
			min-height: 80vh;
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
