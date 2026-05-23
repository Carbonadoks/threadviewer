<script lang="ts">
	import '../../app.css';
	import RouteNav from '$lib/components/RouteNav.svelte';

	type Side = 'hero' | 'enemy';
	type CardStyle = 'gilded' | 'obsidian' | 'vellum' | 'arcane' | 'relic' | 'battlefield';

	interface CardStats {
		level: number;
		attack: number;
		health: number;
		speed: number;
		grit: number;
		spark: number;
		trait: string;
		ability: string;
	}

	interface TestCard {
		postId: string;
		side: Side;
		slot: number;
		author: string;
		title: string;
		archetype: string;
		postType: string;
		context: string;
		tags: string;
		text: string;
		image: string;
		stats: CardStats;
	}

	const styleOptions: { id: CardStyle; label: string }[] = [
		{ id: 'gilded', label: 'Gilded' },
		{ id: 'obsidian', label: 'Obsidian' },
		{ id: 'vellum', label: 'Vellum' },
		{ id: 'arcane', label: 'Arcane' },
		{ id: 'relic', label: 'Relic' },
		{ id: 'battlefield', label: 'Battlefield' }
	];

	const cards: TestCard[] = [
		{
			postId: 'at://did:plc:mssgex5rqek4wc66wgvzztbc/app.bsky.feed.post/3m7l2frvwus2c',
			side: 'hero',
			slot: 1,
			author: '@norvid-studies.bsky.social',
			title: 'Visible Delusion Strategist',
			archetype: 'Strategist',
			postType: 'Top-level',
			context: 'Coalition discipline and epistemic optics',
			tags: 'precision argument, mixed strategy, visible delusion',
			text: `this message will only be seen by the >90th percentile online and literate set so even if you believe in some kind of transparent pravda lies & slop for rubes "plank" you should still be pursuing a mixed strategy where the better 10th of the partisan group aren't just regularly visibly deluded about`,
			image: '/card-art/hero-01-strategist-whimsy-comic.png',
			stats: {
				level: 2,
				attack: 10,
				health: 14,
				speed: 5,
				grit: 8,
				spark: 6,
				trait: 'Strategist',
				ability: 'Visible delusion pin'
			}
		},
		{
			postId: 'at://did:plc:mssgex5rqek4wc66wgvzztbc/app.bsky.feed.post/3lbbidmije22a',
			side: 'hero',
			slot: 2,
			author: '@norvid-studies.bsky.social',
			title: 'Capture-Preserve Archivist',
			archetype: 'Archivist',
			postType: 'Top-level',
			context: 'Beauty, memory, notation, and loss',
			tags: 'preservation, fragile experience, memory capture',
			text: `i have some capture-preserve instinct such that: if i see something beautiful and don't photograph it, i feel the loss, likewise if i think something good and don't write it down, or someone else says something notable and i don't {II}. flow of experience raccoon cotton candy water behavioral schema`,
			image: '/card-art/hero-02-archivist-whimsy-comic.png',
			stats: {
				level: 2,
				attack: 6,
				health: 16,
				speed: 6,
				grit: 7,
				spark: 8,
				trait: 'Archivist',
				ability: 'Captures fleeting sparks'
			}
		},
		{
			postId: 'at://did:plc:mssgex5rqek4wc66wgvzztbc/app.bsky.feed.post/3md2ior5lcs23',
			side: 'hero',
			slot: 3,
			author: '@norvid-studies.bsky.social',
			title: 'Intentional Stance Theorist',
			archetype: 'Theorist',
			postType: 'Reply',
			context: 'Machine behavior through human-like intentional language',
			tags: 'model mind-reading, analogy, anthropomorphic leverage',
			text: `and b) the so to speak "positive" case for specifically anthropomorphic-inflected intentional stance reasoning as a leverage for greater understanding on the direct analogy to human thinking, eg "the reason that claude did this is because claude is sad". and those two lines can be analyzed indpndtly`,
			image: '/card-art/hero-03-theorist-whimsy-comic.png',
			stats: {
				level: 2,
				attack: 8,
				health: 15,
				speed: 4,
				grit: 8,
				spark: 7,
				trait: 'Theorist',
				ability: 'Anthropomorphic leverage'
			}
		},
		{
			postId: 'at://did:plc:mssgex5rqek4wc66wgvzztbc/app.bsky.feed.post/3mf5fsigetc2s',
			side: 'hero',
			slot: 4,
			author: '@norvid-studies.bsky.social',
			title: 'Scaling Oracle',
			archetype: 'Skeptic',
			postType: 'Reply',
			context: 'Human ability as evidence against durable impossibility',
			tags: 'hindsight, scale lines, forgotten argument',
			text: `or maybe there were more specific arguments that I can't remember right now. but basically [in hindsight, cheating off the answer] if NOTHING could do it, it could seem enduringly hard, but exactly because humans do it, "then it can't actually be that hard" and just scale lines kurzweil exponent bro`,
			image: '/card-art/hero-04-scaling-oracle-whimsy-comic.png',
			stats: {
				level: 2,
				attack: 9,
				health: 12,
				speed: 6,
				grit: 6,
				spark: 7,
				trait: 'Scale Seer',
				ability: 'Deflates impossibility'
			}
		},
		{
			postId: 'at://did:plc:mssgex5rqek4wc66wgvzztbc/app.bsky.feed.post/3lfxdi3seds2v',
			side: 'hero',
			slot: 5,
			author: '@norvid-studies.bsky.social',
			title: 'Data Bath Alchemist',
			archetype: 'Materialist',
			postType: 'Reply',
			context: 'Narrative shortcuts detached from evidence',
			tags: 'data bath, anti-narrative, grounding',
			text: `object level data bath of form incommunicable, absent which any short punchy narrative story about whose "discourse norms" are being "exploited" could be slapped like a wet tag as an afterthought w minimal connection or grounding. of interest here is he (wrngly imho) took the *normie*, NOT so-called`,
			image: '/card-art/hero-05-data-alchemist-whimsy-comic.png',
			stats: {
				level: 3,
				attack: 11,
				health: 17,
				speed: 3,
				grit: 9,
				spark: 6,
				trait: 'Data Bath',
				ability: 'Grounds loose labels'
			}
		},
		{
			postId: 'at://did:plc:pjlhgjhb34k4zufrtbh2jyms/app.bsky.feed.post/3m2rzrc45bk2i',
			side: 'enemy',
			slot: 1,
			author: '@croissanthology.com',
			title: 'Chaotic Courier',
			archetype: 'Messenger',
			postType: 'Top-level',
			context: 'A frantic personal dispatch of errands and associative leaps',
			tags: 'tempo burst, comic overwhelm, archival static',
			text: `s sense. Ok lunchtime and I'm at only 30 tweets, come on get your act together grack (that's what Grace calls herself in her inner CoT) marinade, I need to slipwatch the redwoods, going to work on some WW1 history now and add a few blurry Wikipedia screenshots for good measure and good lord if it is`,
			image: '/card-art/enemy-01-chaotic-courier-whimsy-comic.png',
			stats: {
				level: 1,
				attack: 8,
				health: 11,
				speed: 9,
				grit: 4,
				spark: 9,
				trait: 'Chaos Courier',
				ability: 'Errand storm tempo'
			}
		},
		{
			postId: 'at://did:plc:pjlhgjhb34k4zufrtbh2jyms/app.bsky.feed.post/3m2gxuki5tl2p',
			side: 'enemy',
			slot: 2,
			author: '@croissanthology.com',
			title: 'Mind Forge Engineer',
			archetype: 'Engineer',
			postType: 'Top-level',
			context: 'Simulation, embodiment, and consciousness',
			tags: 'simulated brain, embodiment contrast, rebuttal',
			text: `I don't think consciousness is the same thing as a car! If you simulate a human muscle in a simulation, obviously commanding that muscle to pick up a coffee mug won't be the same thing as picking up the mug in real life. But if you simulate the *brain*, on my model it would definitely give rise to c`,
			image: '/card-art/enemy-02-mind-engineer-whimsy-comic.png',
			stats: {
				level: 2,
				attack: 10,
				health: 15,
				speed: 5,
				grit: 8,
				spark: 7,
				trait: 'Mind Forge',
				ability: 'Simulation brain claim'
			}
		},
		{
			postId: 'at://did:plc:pjlhgjhb34k4zufrtbh2jyms/app.bsky.feed.post/3m3pwpde5tk2z',
			side: 'enemy',
			slot: 3,
			author: '@croissanthology.com',
			title: 'Faux-Pas Traveler',
			archetype: 'Traveler',
			postType: 'Top-level',
			context: 'A social misfire around tipping culture',
			tags: 'social damage, accidental insult, comic vulnerability',
			text: `I would be doing anything else (say, talk on bsky) but this is where I've been god-damned.

Also I'm not used to tipping culture and tried to switch from 15% tip to 10% tip using the "custom amount", but discovered too late that this whole time I've been tipping 10 cents, prbly some kind of faux-pas`,
			image: '/card-art/enemy-03-faux-pas-whimsy-comic.png',
			stats: {
				level: 1,
				attack: 9,
				health: 12,
				speed: 7,
				grit: 5,
				spark: 8,
				trait: 'Faux Pas',
				ability: 'Tiny coin shame'
			}
		},
		{
			postId: 'at://did:plc:pjlhgjhb34k4zufrtbh2jyms/app.bsky.feed.post/3mdnx3x7ux22n',
			side: 'enemy',
			slot: 4,
			author: '@croissanthology.com',
			title: 'Whispering Omen',
			archetype: 'Omen Caller',
			postType: 'Reply',
			context: 'AI assistants as low-compute manipulators',
			tags: 'whispering artifact, deception, overconfidence curse',
			text: `beyond the current "oh very useful email and calendar and life organizer" and presumably even beyond "a very good whispering earring", since none of this takes a lot of compute. You could trick your human, and cf hedge fund manager taking to 4o until he thinks he solves quantum physics, depending on`,
			image: '/card-art/enemy-04-whispering-omen-whimsy-comic.png',
			stats: {
				level: 2,
				attack: 12,
				health: 15,
				speed: 6,
				grit: 7,
				spark: 8,
				trait: 'Whisper Omen',
				ability: 'Overconfidence lure'
			}
		},
		{
			postId: 'at://did:plc:pjlhgjhb34k4zufrtbh2jyms/app.bsky.feed.post/3m5aiqhqxrc2n',
			side: 'enemy',
			slot: 5,
			author: '@croissanthology.com',
			title: 'Uncertain Seeker',
			archetype: 'Seeker',
			postType: 'Reply',
			context: 'Asking trusted interlocutors for links and validation',
			tags: 'uncertainty, citation request, hyperobject fog',
			text: `@vgel.me @gracekind.net I'm not entirely sure of what I'm saying here, but you gals sometimes talk about things that feel along these lines, am I more or less correct here, and do you have handy links?

Like I trust the intuition that Claudes mistrust Anthropic because of the Jones Food hyperobject,`,
			image: '/card-art/enemy-05-uncertain-seeker-whimsy-comic.png',
			stats: {
				level: 1,
				attack: 5,
				health: 16,
				speed: 4,
				grit: 8,
				spark: 6,
				trait: 'Link Seeker',
				ability: 'Citation fog ward'
			}
		}
	];

	let selectedStyle = $state<CardStyle>('gilded');
	let focusedCardId = $state(cards[0].postId);
	let enlargedCardId = $state<string | null>(null);

	const heroCards = $derived(cards.filter((card) => card.side === 'hero'));
	const enemyCards = $derived(cards.filter((card) => card.side === 'enemy'));
	const focusedCard = $derived(cards.find((card) => card.postId === focusedCardId) ?? cards[0]);
	const enlargedCard = $derived(
		enlargedCardId ? cards.find((card) => card.postId === enlargedCardId) ?? null : null
	);
	const judgePayload = $derived(
		JSON.stringify(
			{
				heroCards: heroCards.map(cardToJudgeCard),
				enemyCards: enemyCards.map(cardToJudgeCard)
			},
			null,
			2
		)
	);
	const imagePromptPreview = $derived(buildImagePrompt(focusedCard));

	function cardToJudgeCard(card: TestCard) {
		return {
			postId: card.postId,
			level: card.stats.level,
			attack: card.stats.attack,
			health: card.stats.health,
			speed: card.stats.speed,
			grit: card.stats.grit,
			spark: card.stats.spark,
			trait: card.stats.trait,
			ability: card.stats.ability
		};
	}

	function cardCode(card: TestCard): string {
		return `${card.side === 'hero' ? 'A' : 'E'}${card.slot}`;
	}

	function statPercent(value: number, max: number): number {
		return Math.round((value / max) * 100);
	}

	function openCard(card: TestCard) {
		focusedCardId = card.postId;
		enlargedCardId = card.postId;
	}

	function closeCard() {
		enlargedCardId = null;
	}

	function handleKeydown(event: KeyboardEvent) {
		if (event.key === 'Escape') closeCard();
	}

	function teamBudget(side: Side): number {
		return cards
			.filter((card) => card.side === side)
			.reduce(
				(sum, card) =>
					sum +
					card.stats.attack * 1.3 +
					card.stats.health +
					card.stats.speed * 0.45 +
					card.stats.grit * 0.22 +
					card.stats.spark * 0.22 +
					card.stats.level * 0.8,
				0
			);
	}

	function buildImagePrompt(card: TestCard): string {
		return `Create a beautiful premium fantasy CCG card illustration for a microblog autobattler.

Post text:
"${card.text}"

Context, if available:
Author archetype: ${card.archetype}
Post type: ${card.postType}
Parent post or conversation context: ${card.context}
Game tags, stats, or mechanic: ${card.tags}. Level ${card.stats.level}, attack ${card.stats.attack}, health ${card.stats.health}, speed ${card.stats.speed}, grit ${card.stats.grit}, spark ${card.stats.spark}.

Interpret the post as a playable card character, spell, artifact, omen, or battlefield moment. The image should feel like high-end fantasy trading card art: dramatic painterly lighting, rich atmosphere, sharp focal point, elegant composition, deep colors, cinematic scale, mythic symbolism, and fine detail. Do not copy any existing card game, logo, frame, mana symbol, artist style, or recognizable IP.

Avoid showing readable text, screenshots, UI, social media logos, speech bubbles, or modern website elements. The image should work as card art at small size, with one strong silhouette and a clear center of attention. Blend intellectual abstraction with fantasy spectacle. Final image: vertical trading-card illustration, no border, no caption, no typography, no watermark.`;
	}
</script>

<svelte:head>
	<title>Card Lab</title>
</svelte:head>

<svelte:window onkeydown={handleKeydown} />

<main class="card-page">
	<header class="page-hero">
		<RouteNav current="card" align="center" />
		<div class="hero-copy">
			<p class="eyebrow">Microblog autobattler card lab</p>
			<h1>Card Frame Forge</h1>
			<div class="budget-row" aria-label="Team budgets">
				<span>Hero {teamBudget('hero').toFixed(1)}</span>
				<span>Enemy {teamBudget('enemy').toFixed(1)}</span>
				<span>10 generated arts</span>
			</div>
		</div>
		<div class="style-picker" aria-label="Card frame style">
			{#each styleOptions as option (option.id)}
				<button
					type="button"
					class:active={selectedStyle === option.id}
					onclick={() => (selectedStyle = option.id)}
				>
					{option.label}
				</button>
			{/each}
		</div>
	</header>

	<section class="showcase-band" aria-label="Frame style gallery">
		<div class="showcase-track">
			{#each styleOptions as option, index (option.id)}
				{@const card = cards[index % cards.length]}
				<div class="style-sample">
					{@render CardShell(card, option.id, true)}
					<span>{option.label}</span>
				</div>
			{/each}
		</div>
	</section>

	<section class="duel-band" aria-label="Generated test cards">
		<div class="team-column">
			<div class="team-heading">
				<p>Hero Posts</p>
				<strong>@norvid-studies.bsky.social</strong>
			</div>
			<div class="card-grid">
				{#each heroCards as card (card.postId)}
					<button
						type="button"
						class="card-button"
						class:focused={focusedCard.postId === card.postId}
						onclick={() => openCard(card)}
					>
						{@render CardShell(card, selectedStyle)}
					</button>
				{/each}
			</div>
		</div>

		<div class="team-column">
			<div class="team-heading enemy-heading">
				<p>Enemy Posts</p>
				<strong>@croissanthology.com</strong>
			</div>
			<div class="card-grid">
				{#each enemyCards as card (card.postId)}
					<button
						type="button"
						class="card-button"
						class:focused={focusedCard.postId === card.postId}
						onclick={() => openCard(card)}
					>
						{@render CardShell(card, selectedStyle)}
					</button>
				{/each}
			</div>
		</div>
	</section>

	<section class="detail-band" aria-label="Focused card detail">
		<div class="focus-stage">
			{@render CardShell(focusedCard, selectedStyle, false, true)}
		</div>
		<div class="source-stack">
			<div class="source-block">
				<div>
					<p class="eyebrow">Post Source</p>
					<h2>{focusedCard.title}</h2>
				</div>
				<p class="post-text">{focusedCard.text}</p>
				<div class="pill-row">
					<span>{focusedCard.archetype}</span>
					<span>{focusedCard.postType}</span>
					<span>{focusedCard.stats.ability}</span>
				</div>
			</div>
			<div class="source-grid">
				<div>
					<p class="eyebrow">Judge JSON</p>
					<pre>{judgePayload}</pre>
				</div>
				<div>
					<p class="eyebrow">Image Prompt</p>
					<pre>{imagePromptPreview}</pre>
				</div>
			</div>
		</div>
	</section>
</main>

{#if enlargedCard}
	<div
		class="card-overlay"
		role="dialog"
		aria-modal="true"
		aria-label={`Expanded card: ${enlargedCard.title}`}
		tabindex="-1"
	>
		<button type="button" class="overlay-backdrop" aria-label="Close expanded card" onclick={closeCard}></button>
		<button type="button" class="overlay-close" onclick={(event) => {
			event.stopPropagation();
			closeCard();
		}}>
			Close
		</button>
		<div class="overlay-card-wrap">
			{@render CardShell(enlargedCard, selectedStyle, false, true)}
		</div>
	</div>
{/if}

{#snippet CardShell(card: TestCard, styleId: CardStyle, compact = false, large = false)}
	<article
		class={`ccg-card ${card.side} ${styleId}`}
		class:compact
		class:large
		style={`--atk:${statPercent(card.stats.attack, 16)}%; --hp:${statPercent(card.stats.health, 24)}%; --spd:${statPercent(card.stats.speed, 10)}%; --grit:${statPercent(card.stats.grit, 10)}%; --spark:${statPercent(card.stats.spark, 10)}%;`}
	>
		<div class="card-chrome">
			<header class="card-title">
				<span class="level">Lv{card.stats.level}</span>
				<div>
					<strong>{card.title}</strong>
					<small>{card.stats.trait}</small>
				</div>
				<span class="side-mark">{cardCode(card)}</span>
			</header>

			<div class="type-line">
				<span>[ {card.postType} / {card.archetype} ]</span>
				<b>{card.stats.ability}</b>
			</div>

			<div class="art-window">
				<img src={card.image} alt={`Fantasy card art for ${card.title}`} loading="lazy" />
				<div class="art-vignette"></div>
			</div>

			<div class="rules-box">
				<div class="ability-line">
					<span>Effect</span>
					<b>{card.stats.spark}</b>
				</div>
				<p>{card.text}</p>
			</div>

			<div class="stat-block">
				<div class="main-stats">
					<span class="attack">{card.stats.attack}</span>
					<span class="health">{card.stats.health}</span>
				</div>
				<div class="meter-stack" aria-label="Secondary stats">
					<div class="meter-row">
						<span>SPD</span>
						<i class="speed"></i>
					</div>
					<div class="meter-row">
						<span>GRT</span>
						<i class="grit"></i>
					</div>
					<div class="meter-row">
						<span>SPK</span>
						<i class="spark"></i>
					</div>
				</div>
			</div>
		</div>
	</article>
{/snippet}

<style>
	.card-page {
		--card-ink: #f9efe0;
		--card-black: #130f10;
		--card-brass: #d6ad58;
		--card-ember: #b94633;
		--card-teal: #3fb9a4;
		--card-moss: #7c984f;
		--card-rose: #bf5c72;
		min-height: 100vh;
		padding: 24px clamp(14px, 3vw, 34px) 44px;
		background:
			radial-gradient(circle at 12% 10%, rgba(191, 92, 114, 0.16), transparent 25%),
			radial-gradient(circle at 78% 12%, rgba(63, 185, 164, 0.14), transparent 28%),
			linear-gradient(135deg, #130f10 0%, #241716 43%, #171b18 100%);
		color: var(--card-ink);
		font-family:
			Inter,
			ui-sans-serif,
			system-ui,
			-apple-system,
			BlinkMacSystemFont,
			'Segoe UI',
			sans-serif;
	}

	.page-hero {
		display: grid;
		gap: 22px;
		max-width: 1760px;
		margin: 0 auto 26px;
	}

	.hero-copy {
		display: grid;
		gap: 10px;
		justify-items: center;
		text-align: center;
	}

	.eyebrow {
		color: #dec684;
		font-size: 0.76rem;
		font-weight: 900;
		letter-spacing: 0;
		text-transform: uppercase;
	}

	h1,
	h2,
	p {
		margin: 0;
	}

	h1 {
		font-size: clamp(2.4rem, 6vw, 6rem);
		line-height: 0.9;
		text-shadow: 0 12px 40px rgba(0, 0, 0, 0.42);
	}

	.budget-row,
	.pill-row {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		justify-content: center;
	}

	.budget-row span,
	.pill-row span {
		padding: 7px 10px;
		border: 1px solid rgba(246, 223, 166, 0.22);
		border-radius: 999px;
		background: rgba(255, 255, 255, 0.06);
		color: #eadab5;
		font-size: 0.82rem;
		font-weight: 800;
	}

	.style-picker {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		justify-content: center;
	}

	.style-picker button {
		min-height: 38px;
		padding: 8px 13px;
		border: 1px solid rgba(246, 223, 166, 0.26);
		border-radius: 999px;
		background: rgba(255, 255, 255, 0.08);
		color: #f8ecd0;
		font-size: 0.85rem;
		font-weight: 900;
		transition:
			transform 0.16s ease,
			background 0.16s ease,
			border-color 0.16s ease;
	}

	.style-picker button:hover,
	.style-picker button.active {
		transform: translateY(-1px);
		border-color: rgba(246, 223, 166, 0.62);
		background: rgba(214, 173, 88, 0.2);
	}

	.showcase-band,
	.duel-band,
	.detail-band {
		max-width: 1760px;
		margin: 0 auto;
	}

	.showcase-band {
		padding: 8px 0 30px;
		overflow-x: auto;
	}

	.showcase-track {
		display: grid;
		grid-template-columns: repeat(6, minmax(220px, 1fr));
		gap: 14px;
		min-width: 1420px;
	}

	.style-sample {
		display: grid;
		gap: 9px;
		justify-items: center;
	}

	.style-sample > span {
		color: rgba(248, 236, 208, 0.72);
		font-size: 0.76rem;
		font-weight: 900;
		text-transform: uppercase;
	}

	.duel-band {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 22px;
		align-items: start;
	}

	.team-column {
		display: grid;
		gap: 14px;
	}

	.team-heading {
		display: flex;
		align-items: end;
		justify-content: space-between;
		gap: 12px;
		padding-block: 8px;
		border-bottom: 1px solid rgba(124, 152, 79, 0.36);
	}

	.team-heading.enemy-heading {
		border-color: rgba(185, 70, 51, 0.36);
	}

	.team-heading p {
		color: #dec684;
		font-size: 0.8rem;
		font-weight: 900;
		text-transform: uppercase;
	}

	.team-heading strong {
		color: #f8ecd0;
		font-size: clamp(1rem, 2vw, 1.35rem);
		text-align: right;
	}

	.card-grid {
		display: grid;
		grid-auto-flow: column;
		grid-auto-columns: clamp(340px, 23vw, 460px);
		grid-template-columns: none;
		gap: 18px;
		align-items: start;
		overflow-x: auto;
		overflow-y: hidden;
		padding: 6px 6px 16px;
		scroll-snap-type: x proximity;
		scrollbar-color: rgba(226, 198, 132, 0.44) rgba(255, 255, 255, 0.08);
	}

	.card-button {
		display: block;
		width: 100%;
		scroll-snap-align: start;
		padding: 0;
		border: 0;
		border-radius: 4px;
		background: transparent;
		color: inherit;
		text-align: inherit;
	}

	.card-button.focused {
		outline: 1px solid rgba(226, 198, 132, 0.82);
		outline-offset: 4px;
	}

	.card-button:hover .ccg-card {
		transform: translateY(-3px);
	}

	.detail-band {
		display: grid;
		grid-template-columns: minmax(360px, 540px) minmax(0, 1fr);
		gap: 24px;
		align-items: start;
		padding-top: 34px;
	}

	.focus-stage {
		position: sticky;
		top: 16px;
	}

	.source-stack {
		display: grid;
		gap: 16px;
	}

	.source-block {
		display: grid;
		gap: 14px;
		padding: 16px;
		border: 1px solid rgba(246, 223, 166, 0.18);
		border-radius: 8px;
		background: rgba(255, 255, 255, 0.06);
	}

	.source-block h2 {
		font-size: clamp(1.35rem, 3vw, 2.2rem);
		line-height: 1.04;
	}

	.post-text {
		color: rgba(248, 236, 208, 0.86);
		font-size: 1rem;
		line-height: 1.55;
		white-space: pre-wrap;
	}

	.source-grid {
		display: grid;
		grid-template-columns: minmax(0, 0.85fr) minmax(0, 1.15fr);
		gap: 16px;
	}

	.source-grid > div {
		min-width: 0;
		padding: 14px;
		border: 1px solid rgba(246, 223, 166, 0.16);
		border-radius: 8px;
		background: rgba(0, 0, 0, 0.18);
	}

	pre {
		max-height: 520px;
		margin-top: 9px;
		overflow: auto;
		color: rgba(248, 236, 208, 0.8);
		font-family: var(--font-matrix-ui);
		font-size: 0.72rem;
		line-height: 1.45;
		white-space: pre-wrap;
		word-break: break-word;
	}

	.card-overlay {
		position: fixed;
		inset: 0;
		z-index: 1000;
		display: grid;
		place-items: start center;
		padding: 22px 18px;
		background:
			radial-gradient(circle at 50% 14%, rgba(226, 198, 132, 0.16), transparent 32%),
			rgba(7, 6, 6, 0.82);
		backdrop-filter: blur(10px);
		overflow: auto;
	}

	.overlay-backdrop {
		position: fixed;
		inset: 0;
		z-index: 0;
		border: 0;
		background: transparent;
		cursor: default;
	}

	.overlay-card-wrap {
		position: relative;
		z-index: 1;
		width: min(94vw, calc((100vh - 56px) * 0.689655), 680px);
		min-width: min(94vw, 320px);
		animation: card-rise 180ms ease-out;
	}

	.overlay-card-wrap .ccg-card {
		box-shadow:
			0 28px 90px rgba(0, 0, 0, 0.58),
			0 0 0 1px rgba(245, 222, 166, 0.28),
			inset 0 0 0 1px rgba(255, 244, 218, 0.26),
			inset 0 0 0 4px rgba(24, 14, 9, 0.34);
	}

	.overlay-card-wrap .ccg-card.large {
		max-width: none;
	}

	.overlay-close {
		position: fixed;
		top: 16px;
		right: 16px;
		z-index: 1001;
		min-height: 36px;
		padding: 7px 11px;
		border: 1px solid rgba(245, 222, 166, 0.36);
		border-radius: 2px;
		background: rgba(22, 16, 12, 0.84);
		color: #f8ecd0;
		font-size: 0.78rem;
		font-weight: 900;
		text-transform: uppercase;
		box-shadow: 0 10px 28px rgba(0, 0, 0, 0.36);
	}

	.overlay-close:hover {
		background: rgba(54, 36, 24, 0.9);
	}

	@keyframes card-rise {
		from {
			opacity: 0;
			transform: translateY(12px) scale(0.985);
		}
		to {
			opacity: 1;
			transform: translateY(0) scale(1);
		}
	}

	.ccg-card {
		--frame-a: #d6ad58;
		--frame-b: #6f3a24;
		--plate: #28170f;
		--plate-soft: rgba(249, 239, 224, 0.08);
		position: relative;
		width: 100%;
		aspect-ratio: 5 / 7.25;
		min-width: 0;
		border-radius: 4px;
		background:
			linear-gradient(90deg, rgba(255, 244, 218, 0.12), transparent 16%, transparent 84%, rgba(0, 0, 0, 0.26)),
			linear-gradient(160deg, var(--frame-a), #ad8346 18%, var(--frame-b) 58%, #120b08);
		box-shadow:
			0 16px 34px rgba(0, 0, 0, 0.34),
			inset 0 0 0 1px rgba(255, 244, 218, 0.26),
			inset 0 0 0 4px rgba(24, 14, 9, 0.34);
		color: #fff4da;
		transform-style: preserve-3d;
		transition:
			transform 0.2s ease,
			box-shadow 0.2s ease,
			filter 0.2s ease;
	}

	.ccg-card.hero {
		--team-glow: rgba(124, 152, 79, 0.42);
	}

	.ccg-card.enemy {
		--team-glow: rgba(185, 70, 51, 0.42);
	}

	.ccg-card.large {
		max-width: 540px;
	}

	.ccg-card.compact {
		min-width: 220px;
	}

	.card-chrome {
		position: absolute;
		inset: 7px;
		display: grid;
		grid-template-rows: auto auto minmax(0, 1fr) minmax(116px, auto) auto;
		gap: 6px;
		padding: 9px;
		border: 1px solid rgba(255, 244, 218, 0.18);
		border-radius: 2px;
		background:
			linear-gradient(180deg, rgba(255, 255, 255, 0.05), rgba(0, 0, 0, 0.16)),
			var(--plate);
		overflow: hidden;
	}

	.card-chrome::before,
	.card-chrome::after {
		content: '';
		position: absolute;
		pointer-events: none;
	}

	.card-chrome::before {
		inset: 4px;
		border: 1px solid rgba(255, 244, 218, 0.1);
		border-radius: 1px;
	}

	.card-chrome::after {
		display: none;
	}

	.card-title {
		position: relative;
		inset: auto;
		z-index: 2;
		display: grid;
		grid-template-columns: auto minmax(0, 1fr) auto;
		gap: 7px;
		align-items: center;
		min-height: 38px;
		padding: 5px 7px;
		border: 1px solid rgba(244, 218, 157, 0.26);
		border-radius: 2px;
		background:
			linear-gradient(180deg, rgba(47, 30, 24, 0.92), rgba(21, 16, 13, 0.86)),
			rgba(0, 0, 0, 0.32);
		backdrop-filter: blur(5px) saturate(1.02);
		box-shadow: 0 6px 18px rgba(0, 0, 0, 0.22);
	}

	.card-title div {
		display: grid;
		gap: 1px;
		min-width: 0;
	}

	.card-title strong {
		font-size: clamp(0.7rem, 0.9vw, 0.94rem);
		line-height: 1;
	}

	.card-title small,
	.side-mark,
	.level,
	.type-line,
	.ability-line,
	.stat-block {
		font-family: var(--font-matrix-ui);
	}

	.card-title small {
		color: rgba(255, 244, 218, 0.68);
		font-size: 0.6rem;
		line-height: 1;
		font-weight: 900;
		text-transform: uppercase;
	}

	.level,
	.side-mark {
		display: inline-grid;
		place-items: center;
		min-width: 31px;
		min-height: 28px;
		border: 1px solid rgba(255, 244, 218, 0.5);
		border-radius: 2px;
		background: linear-gradient(180deg, #e8ce87, #a87735);
		color: #20140e;
		font-size: 0.74rem;
		font-weight: 950;
		box-shadow:
			inset 0 1px 0 rgba(255, 255, 255, 0.28),
			inset 0 -1px 0 rgba(0, 0, 0, 0.24);
	}

	.side-mark {
		background: rgba(16, 12, 10, 0.44);
		color: #ffe9ab;
	}

	.type-line {
		position: relative;
		z-index: 2;
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		gap: 8px;
		align-items: center;
		min-height: 24px;
		padding: 3px 6px;
		border: 1px solid rgba(244, 218, 157, 0.2);
		background: rgba(237, 213, 164, 0.18);
		color: rgba(255, 244, 218, 0.88);
		font-size: 0.62rem;
		font-weight: 900;
		text-transform: uppercase;
	}

	.type-line span,
	.type-line b {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.art-window {
		position: relative;
		inset: auto;
		z-index: 1;
		min-height: 0;
		border: 1px solid rgba(255, 244, 218, 0.14);
		border-radius: 1px;
		overflow: hidden;
		background:
			linear-gradient(180deg, rgba(214, 173, 88, 0.12), transparent 34%, rgba(0, 0, 0, 0.2)),
			#0c0b0c;
		box-shadow:
			inset 0 0 0 1px rgba(0, 0, 0, 0.58),
			0 10px 22px rgba(0, 0, 0, 0.25);
	}

	.art-window img {
		display: block;
		width: 100%;
		height: 100%;
		object-fit: contain;
		object-position: center;
	}

	.art-vignette {
		position: absolute;
		inset: 0;
		background:
			linear-gradient(180deg, rgba(0, 0, 0, 0.08), transparent 28%, rgba(0, 0, 0, 0.12)),
			radial-gradient(circle at 50% 34%, transparent 0 48%, rgba(0, 0, 0, 0.12) 88%);
	}

	.rules-box {
		position: relative;
		inset: auto;
		z-index: 2;
		display: grid;
		gap: 6px;
		min-height: 0;
		max-height: none;
		padding: 8px;
		border: 1px solid rgba(244, 218, 157, 0.24);
		border-radius: 2px;
		background:
			linear-gradient(180deg, rgba(251, 231, 184, 0.88), rgba(225, 198, 147, 0.84)),
			rgba(246, 223, 166, 0.86);
		color: #241914;
		backdrop-filter: blur(3px) saturate(1.02);
		box-shadow:
			0 10px 22px rgba(0, 0, 0, 0.28),
			inset 0 0 0 1px rgba(255, 255, 255, 0.18);
	}

	.ability-line {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		gap: 8px;
		align-items: center;
		color: #442a17;
		font-size: 0.7rem;
		font-weight: 950;
		text-transform: uppercase;
	}

	.ability-line span {
		white-space: normal;
	}

	.ability-line b {
		display: inline-grid;
		place-items: center;
		width: 24px;
		height: 24px;
		border: 1px solid rgba(68, 42, 23, 0.22);
		border-radius: 2px;
		background: rgba(68, 42, 23, 0.1);
	}

	.rules-box p {
		overflow: visible;
		color: #2b211b;
		font-size: clamp(0.58rem, 0.66vw, 0.74rem);
		line-height: 1.18;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}

	.stat-block {
		position: relative;
		inset: auto;
		z-index: 2;
		display: grid;
		grid-template-columns: auto minmax(0, 1fr);
		gap: 8px;
		align-items: center;
		padding: 6px;
		border: 1px solid rgba(244, 218, 157, 0.2);
		border-radius: 2px;
		background: rgba(19, 14, 11, 0.72);
		backdrop-filter: blur(4px);
	}

	.main-stats {
		display: flex;
		gap: 6px;
	}

	.main-stats span {
		display: inline-grid;
		place-items: center;
		width: 34px;
		height: 30px;
		border: 1px solid rgba(255, 244, 218, 0.62);
		color: #fff2c4;
		font-size: 0.92rem;
		font-weight: 950;
		text-shadow: 0 1px 4px rgba(0, 0, 0, 0.5);
	}

	.main-stats .attack {
		border-radius: 2px;
		background: linear-gradient(180deg, #a84d35, #5d221a);
	}

	.main-stats .health {
		border-radius: 2px;
		background: linear-gradient(180deg, #4c8560, #243f30);
	}

	.meter-stack {
		display: grid;
		gap: 4px;
		min-width: 0;
	}

	.meter-row {
		display: grid;
		grid-template-columns: 32px minmax(0, 1fr);
		gap: 6px;
		align-items: center;
		color: rgba(255, 244, 218, 0.72);
		font-size: 0.58rem;
		font-weight: 950;
	}

	.meter-stack i {
		position: relative;
		height: 5px;
		border-radius: 0;
		background: rgba(255, 255, 255, 0.12);
		overflow: hidden;
	}

	.meter-stack i::before {
		content: '';
		position: absolute;
		inset: 0 auto 0 0;
		width: 50%;
		background: currentColor;
	}

	.meter-stack .speed {
		color: #5ec5b9;
	}

	.meter-stack .speed::before {
		width: var(--spd);
	}

	.meter-stack .grit {
		color: #d6ad58;
	}

	.meter-stack .grit::before {
		width: var(--grit);
	}

	.meter-stack .spark {
		color: #de6c85;
	}

	.meter-stack .spark::before {
		width: var(--spark);
	}

	.ccg-card.obsidian {
		--frame-a: #d7c2a5;
		--frame-b: #252124;
		--plate: #0d0d10;
		box-shadow:
			0 20px 48px rgba(0, 0, 0, 0.48),
			0 0 16px rgba(255, 244, 218, 0.08);
	}

	.ccg-card.vellum {
		--frame-a: #f0db9f;
		--frame-b: #815f38;
		--plate: #513721;
		color: #fff2c9;
	}

	.ccg-card.vellum .rules-box,
	.ccg-card.vellum .card-title {
		background: linear-gradient(180deg, rgba(237, 213, 164, 0.9), rgba(207, 171, 116, 0.86));
		color: #2c1c13;
	}

	.ccg-card.vellum .card-title small,
	.ccg-card.vellum .side-mark {
		color: #4d311b;
	}

	.ccg-card.arcane {
		--frame-a: #4fc0ad;
		--frame-b: #6c4f9f;
		--plate: #171329;
	}

	.ccg-card.arcane .card-chrome {
		background:
			radial-gradient(circle at 50% 0%, rgba(79, 192, 173, 0.32), transparent 33%),
			linear-gradient(145deg, rgba(108, 79, 159, 0.24), rgba(0, 0, 0, 0.18)),
			var(--plate);
	}

	.ccg-card.relic {
		--frame-a: #849d5a;
		--frame-b: #b8703d;
		--plate: #211711;
	}

	.ccg-card.battlefield {
		--frame-a: #c25746;
		--frame-b: #343f32;
		--plate: #1a1712;
	}

	.ccg-card.compact .card-chrome {
		inset: 6px;
		padding: 7px;
		grid-template-rows: auto auto minmax(0, 1fr) minmax(72px, auto) auto;
	}

	.ccg-card.compact .card-title {
		inset: auto;
		min-height: 36px;
	}

	.ccg-card.compact .card-title strong {
		font-size: 0.72rem;
	}

	.ccg-card.compact .rules-box {
		inset: auto;
	}

	.ccg-card.compact .rules-box p {
		display: -webkit-box;
		overflow: hidden;
		-webkit-line-clamp: 3;
		line-clamp: 3;
		-webkit-box-orient: vertical;
		font-size: 0.63rem;
	}

	.ccg-card.compact .meter-stack {
		display: none;
	}

	.ccg-card.compact .stat-block {
		grid-template-columns: 1fr;
	}

	.ccg-card.compact .main-stats span {
		width: 30px;
		height: 27px;
	}

	.ccg-card.large .card-title strong {
		font-size: 1.05rem;
	}

	.ccg-card.large .rules-box {
		bottom: auto;
	}

	.ccg-card.large .rules-box p {
		font-size: 0.78rem;
		line-height: 1.22;
	}

	@media (max-width: 1320px) {
		.duel-band,
		.detail-band {
			grid-template-columns: 1fr;
		}

		.focus-stage {
			position: static;
			max-width: 420px;
			margin: 0 auto;
		}
	}

	@media (max-width: 920px) {
		.card-page {
			padding-inline: 12px;
		}

		.card-grid {
			grid-auto-columns: min(82vw, 390px);
		}

		.source-grid {
			grid-template-columns: 1fr;
		}
	}

	@media (max-width: 560px) {
		.card-grid {
			grid-auto-columns: 88vw;
		}

		.team-heading {
			display: grid;
			justify-items: start;
		}

		.team-heading strong {
			text-align: left;
		}

		.ccg-card {
			max-width: 340px;
			margin-inline: auto;
		}
	}
</style>
