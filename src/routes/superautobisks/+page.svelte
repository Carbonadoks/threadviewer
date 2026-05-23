<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import '../../app.css';
	import ErrorBanner from '$lib/components/ErrorBanner.svelte';
	import FontPicker from '$lib/components/FontPicker.svelte';
	import LoadingSpinner from '$lib/components/LoadingSpinner.svelte';
	import RouteNav from '$lib/components/RouteNav.svelte';
	import SearchBar from '$lib/components/SearchBar.svelte';
	import { getProfile, type ProfileInfo } from '$lib/api/bluesky';
	import type { AuthorInfo, DiscoverProgress } from '$lib/types';
	import {
		loadRepoFeedItems,
		parseRepoFeedItemsFromCar,
		type RepoDownloadProgress
	} from '$lib/utils/repoHydration';
	import {
		DEFAULT_THREAD_JUDGE_MODEL,
		threadJudgeModelLabel
	} from '$lib/utils/judgeModels';
	import { buildBskyPostUrl } from '$lib/utils/viewerLinks';

	type Side = 'hero' | 'enemy';
	type FightPhase = 'idle' | 'playing' | 'finished';
	type LoadState = 'idle' | 'generating' | 'error';

	interface ChatMessage {
		role: 'user';
		content: string;
	}

	interface GeminiGenerateResponse {
		text?: string;
		model?: string;
		finishReason?: string;
		usageMetadata?: unknown;
		raw?: unknown;
		message?: string;
	}

	interface BattlePost {
		id: string;
		uri: string;
		text: string;
		createdAt?: string;
		authorHandle: string;
	}

	interface PostStats {
		level: number;
		attack: number;
		health: number;
		speed: number;
		grit: number;
		spark: number;
		trait: string;
		ability: string;
		source: 'gemini' | 'fallback';
	}

	interface PostCard {
		id: string;
		side: Side;
		slot: number;
		post: BattlePost;
		stats: PostStats;
		currentHealth: number;
		alive: boolean;
	}

	interface FightEvent {
		id: string;
		round: number;
		heroCardId: string;
		enemyCardId: string;
		heroName: string;
		enemyName: string;
		heroDamage: number;
		enemyDamage: number;
		heroHealthAfter: number;
		enemyHealthAfter: number;
		heroFainted: boolean;
		enemyFainted: boolean;
		summary: string;
		heroCards: PostCard[];
		enemyCards: PostCard[];
	}

	const TEAM_SIZE = 5;
	const DRAFT_POOL_SIZE = 15;
	const MIN_CHARS_DEFAULT = 80;
	const FIGHT_STEP_MS = 1050;
	const MAX_ROUNDS = 80;
	const BALANCE_TOLERANCE = 0.08;
	const MAX_BALANCE_SHIFT = 0.15;
	const DEFAULT_MAX_OUTPUT_TOKENS = 4096;
	const GEMINI_MODEL_ID = DEFAULT_THREAD_JUDGE_MODEL;
	const GEMINI_MODEL_LABEL = threadJudgeModelLabel(GEMINI_MODEL_ID).replace(' Preview', '');
	const GEMINI_KEY_STORAGE_KEY = 'threadviewer.superautobisks.geminiApiKey';
	const JUDGE_INSTRUCTIONS =
		'You are a sharp, fair autobattler judge. Turn post text into stats and damage by judging the writing, not by counting characters.';

	const fontFamilies: Record<string, string> = {
		virgil: "'Virgil', cursive",
		caveat: "'Caveat', cursive",
		patrick: "'Patrick Hand', cursive",
		'comic-neue': "'Comic Neue', cursive",
		inter: "'Inter', sans-serif",
		system: "system-ui, -apple-system, sans-serif"
	};

	let initialHandle = $state('');
	let enemyInitialHandle = $state('');
	let profile = $state<ProfileInfo | null>(null);
	let enemyProfile = $state<ProfileInfo | null>(null);
	let profileLoading = $state(false);
	let enemyProfileLoading = $state(false);
	let repoLoading = $state(false);
	let enemyRepoLoading = $state(false);
	let repoError = $state<string | null>(null);
	let enemyRepoError = $state<string | null>(null);
	let progress = $state<DiscoverProgress>({ phase: '', current: 0, total: 0 });
	let enemyProgress = $state<DiscoverProgress>({ phase: '', current: 0, total: 0 });
	let allPosts = $state<BattlePost[]>([]);
	let enemyAllPosts = $state<BattlePost[]>([]);
	let draftPosts = $state<BattlePost[]>([]);
	let enemyDraftPosts = $state<BattlePost[]>([]);
	let selectedIds = $state<string[]>([]);
	let heroCards = $state<PostCard[]>([]);
	let enemyCards = $state<PostCard[]>([]);
	let combatHeroCards = $state<PostCard[]>([]);
	let combatEnemyCards = $state<PostCard[]>([]);
	let fightEvents = $state<FightEvent[]>([]);
	let displayedFightEvents = $state<FightEvent[]>([]);
	let activeEventIndex = $state(-1);
	let fightPhase = $state<FightPhase>('idle');
	let fightWinner = $state<Side | 'draw' | ''>('');
	let fightSummary = $state('');
	let balanceSummary = $state('');
	let minChars = $state(MIN_CHARS_DEFAULT);
	let maxOutputTokens = $state(DEFAULT_MAX_OUTPUT_TOKENS);
	let frontendGeminiKey = $state('');
	let showGeminiKey = $state(false);
	let fontKey = $state('patrick');
	let llmState = $state<LoadState>('idle');
	let llmProgress = $state(0);
	let llmText = $state(`${GEMINI_MODEL_LABEL} ready`);
	let llmError = $state<string | null>(null);
	let debugOutput = $state('');
	let debugLabel = $state('');
	let fightTimer: ReturnType<typeof setTimeout> | null = null;
	let abortController: AbortController | null = null;
	let enemyAbortController: AbortController | null = null;
	let logElement: HTMLDivElement | null = null;

	const eligiblePosts = $derived(allPosts.filter((post) => post.text.length >= minChars));
	const eligibleEnemyPosts = $derived(enemyAllPosts.filter((post) => post.text.length >= minChars));
	const selectedPosts = $derived(draftPosts.filter((post) => selectedIds.includes(post.id)));
	const visibleHeroCards = $derived(combatHeroCards.length > 0 ? combatHeroCards : heroCards);
	const visibleEnemyCards = $derived(combatEnemyCards.length > 0 ? combatEnemyCards : enemyCards);
	const fontFamily = $derived(fontFamilies[fontKey] ?? fontFamilies.patrick);
	const hasGeminiKey = $derived(frontendGeminiKey.trim().length > 0);
	const canLoadRepo = $derived(Boolean(profile) && !repoLoading && !profileLoading);
	const canLoadEnemyRepo = $derived(
		Boolean(enemyProfile) && !enemyRepoLoading && !enemyProfileLoading && llmState !== 'generating'
	);
	const canRollDraft = $derived(eligiblePosts.length > 0 && !repoLoading);
	const canRollEnemy = $derived(eligibleEnemyPosts.length > 0 && !enemyRepoLoading && llmState !== 'generating');
	const canForgeCards = $derived(
		selectedPosts.length === TEAM_SIZE &&
			enemyDraftPosts.length === TEAM_SIZE &&
			hasGeminiKey &&
			llmState !== 'generating'
	);
	const canFight = $derived(
		heroCards.length === TEAM_SIZE &&
			enemyCards.length === TEAM_SIZE &&
			llmState !== 'generating' &&
			fightPhase !== 'playing'
	);
	const activeHeroCardId = $derived(displayedFightEvents[activeEventIndex]?.heroCardId ?? '');
	const activeEnemyCardId = $derived(displayedFightEvents[activeEventIndex]?.enemyCardId ?? '');

	function normalizeHandle(handle: string | null | undefined): string {
		return (handle ?? '').replace(/^@/, '').trim();
	}

	function describeError(value: unknown): string {
		if (value instanceof Error) return value.message;
		if (typeof value === 'string') return value;
		return 'Something went wrong.';
	}

	function formatBytes(bytes: number): string {
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
		return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	}

	function formatSpeed(bytesPerSec: number): string {
		if (bytesPerSec < 1024) return `${bytesPerSec.toFixed(0)} B/s`;
		if (bytesPerSec < 1024 * 1024) return `${(bytesPerSec / 1024).toFixed(0)} KB/s`;
		return `${(bytesPerSec / (1024 * 1024)).toFixed(1)} MB/s`;
	}

	function formatDuration(ms: number): string {
		if (ms < 1000) return `${Math.round(ms)}ms`;
		return `${(ms / 1000).toFixed(1)}s`;
	}

	function buildRepoDownloadDetail(downloadProgress: RepoDownloadProgress): string {
		const parts = [
			`${formatBytes(downloadProgress.receivedBytes)}${
				downloadProgress.totalBytes > 0 ? ` / ${formatBytes(downloadProgress.totalBytes)}` : ''
			}`
		];
		if (downloadProgress.bytesPerSecond > 0) parts.push(formatSpeed(downloadProgress.bytesPerSecond));
		if (downloadProgress.elapsedMs > 0) parts.push(`${formatDuration(downloadProgress.elapsedMs)} elapsed`);
		return parts.join(' · ');
	}

	function randomPostsFromPool(posts: BattlePost[], count: number): BattlePost[] {
		const pool = [...posts];
		for (let i = pool.length - 1; i > 0; i -= 1) {
			const j = Math.floor(Math.random() * (i + 1));
			[pool[i], pool[j]] = [pool[j], pool[i]];
		}
		return pool.slice(0, Math.min(count, pool.length));
	}

	function clampInt(min: number, max: number, value: number): number {
		return Math.max(min, Math.min(max, Math.round(value)));
	}

	function hashString(input: string): number {
		let hash = 2166136261;
		for (let index = 0; index < input.length; index += 1) {
			hash ^= input.charCodeAt(index);
			hash = Math.imul(hash, 16777619);
		}
		return hash >>> 0;
	}

	function countMatches(text: string, pattern: RegExp): number {
		return text.match(pattern)?.length ?? 0;
	}

	function cardName(card: PostCard): string {
		return `${card.side === 'hero' ? 'A' : 'E'}${card.slot + 1}`;
	}

	function sideLabel(side: Side): string {
		return side === 'hero'
			? profile?.handle ? `@${profile.handle}` : 'Author'
			: enemyProfile?.handle ? `@${enemyProfile.handle}` : 'Enemy';
	}

	function sideProfile(side: Side): ProfileInfo | null {
		return side === 'hero' ? profile : enemyProfile;
	}

	function sideAvatar(side: Side): string {
		return sideProfile(side)?.avatar ?? '';
	}

	function sideInitial(side: Side): string {
		const profileInfo = sideProfile(side);
		const source = profileInfo?.displayName || profileInfo?.handle || (side === 'hero' ? 'A' : 'E');
		return source.trim().charAt(0).toUpperCase() || (side === 'hero' ? 'A' : 'E');
	}

	function postBiskUrl(post: BattlePost): string | null {
		return buildBskyPostUrl(post.uri, post.authorHandle);
	}

	function shortDate(value: string | undefined): string {
		if (!value) return 'undated';
		const parsed = new Date(value);
		if (Number.isNaN(parsed.getTime())) return 'undated';
		return parsed.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
	}

	function messageContentText(message: ChatMessage): string {
		return message.content;
	}

	function summarizeMessages(messages: ChatMessage[]) {
		return {
			messageCount: messages.length,
			promptCharacters: messages.reduce((sum, message) => sum + messageContentText(message).length, 0)
		};
	}

	function extractTextCandidate(payload: any): string {
		const parts = payload?.candidates?.[0]?.content?.parts;
		if (!Array.isArray(parts)) return '';
		return parts
			.map((part) => (typeof part?.text === 'string' ? part.text : ''))
			.filter(Boolean)
			.join('\n');
	}

	function geminiApiErrorMessage(payload: unknown, status: number): string {
		const message =
			typeof (payload as any)?.error?.message === 'string'
				? (payload as any).error.message
				: typeof (payload as any)?.message === 'string'
					? (payload as any).message
					: '';
		return message ? `Gemini request failed ${status}: ${message}` : `Gemini request failed ${status}.`;
	}

	function persistFrontendGeminiKey() {
		const key = frontendGeminiKey.trim();
		if (!key) {
			window.localStorage.removeItem(GEMINI_KEY_STORAGE_KEY);
			return;
		}
		window.localStorage.setItem(GEMINI_KEY_STORAGE_KEY, key);
	}

	function handleFrontendGeminiKeyInput(event: Event) {
		frontendGeminiKey = (event.currentTarget as HTMLInputElement).value.trim();
		persistFrontendGeminiKey();
	}

	function clearFrontendGeminiKey() {
		frontendGeminiKey = '';
		window.localStorage.removeItem(GEMINI_KEY_STORAGE_KEY);
	}

	function handleMaxOutputTokensChange(event: Event) {
		const value = Number((event.currentTarget as HTMLInputElement).value);
		maxOutputTokens = Math.max(
			512,
			Math.min(8192, Math.round(Number.isFinite(value) ? value : DEFAULT_MAX_OUTPUT_TOKENS))
		);
	}

	async function requestGeminiFromBrowser(
		prompt: string,
		maxTokens: number,
		temperature: number,
		topP: number,
		responseMimeType?: 'application/json'
	): Promise<GeminiGenerateResponse> {
		const apiKey = frontendGeminiKey.trim();
		if (!apiKey) {
			throw new Error('Paste a Gemini API key before asking the judge.');
		}

		const generationConfig: Record<string, unknown> = {
			temperature,
			topP,
			maxOutputTokens: maxTokens
		};
		if (responseMimeType) {
			generationConfig.responseMimeType = responseMimeType;
		}

		const requestController = new AbortController();
		const timeout = window.setTimeout(() => requestController.abort(), 45000);
		let response: Response;
		try {
			response = await fetch(
				`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL_ID}:generateContent`,
				{
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
						'x-goog-api-key': apiKey
					},
					body: JSON.stringify({
						contents: [
							{
								role: 'user',
								parts: [{ text: prompt }]
							}
						],
						generationConfig
					}),
					signal: requestController.signal
				}
			);
		} catch (value) {
			if ((value as any)?.name === 'AbortError') {
				throw new Error('Gemini card creation timed out after 45 seconds.');
			}
			throw value;
		} finally {
			window.clearTimeout(timeout);
		}
		const payload: any = await response.json().catch(() => null);
		if (!response.ok) {
			throw new Error(geminiApiErrorMessage(payload, response.status));
		}

		const candidate = payload?.candidates?.[0] ?? {};
		return {
			text: extractTextCandidate(payload),
			model: GEMINI_MODEL_ID,
			finishReason: typeof candidate.finishReason === 'string' ? candidate.finishReason : '',
			usageMetadata: payload?.usageMetadata ?? null,
			raw: payload
		};
	}

	async function runGeminiChat(
		messages: ChatMessage[],
		maxTokens = DEFAULT_MAX_OUTPUT_TOKENS,
		options: {
			temperature?: number;
			topP?: number;
			label?: string;
			responseMimeType?: 'application/json';
		} = {}
	): Promise<string> {
		const temperature = options.temperature ?? 0.45;
		const topP = options.topP ?? 0.9;
		const summary = summarizeMessages(messages);
		const prompt = messages.map((message) => messageContentText(message).trim()).filter(Boolean).join('\n\n');
		const estimatedPromptTokens =
			messages.reduce((sum, message) => sum + Math.ceil(messageContentText(message).length / 4) + 16, 0) + 64;

		llmState = 'generating';
		llmProgress = 0.45;
		llmText = `${GEMINI_MODEL_LABEL} ${options.label ?? 'judging'} · ${maxTokens.toLocaleString()} out`;
		debugLabel = `${options.label ?? 'Gemini'} prompt`;
		debugOutput = `[status] ${summary.messageCount} message / ${summary.promptCharacters.toLocaleString()} chars / ${estimatedPromptTokens.toLocaleString()} estimated prompt tokens`;

		try {
			const payload = await requestGeminiFromBrowser(
				prompt,
				maxTokens,
				temperature,
				topP,
				options.responseMimeType
			);
			const output = payload?.text?.trim() ?? '';
			debugLabel = `${options.label ?? 'Gemini'} response`;
			debugOutput = output;
			llmState = 'idle';
			llmProgress = 1;
			llmText = `${GEMINI_MODEL_LABEL} ready`;
			return output;
		} catch (value) {
			llmState = 'error';
			llmProgress = 0;
			llmText = 'Gemini request failed';
			throw value;
		}
	}

	function parseJsonCandidate(candidate: string): unknown {
		try {
			return JSON.parse(candidate);
		} catch {
			return JSON.parse(candidate.replace(/,\s*([}\]])/g, '$1'));
		}
	}

	function findBalancedJsonSlices(text: string): string[] {
		const slices: string[] = [];
		for (let start = 0; start < text.length; start += 1) {
			const opener = text[start];
			if (opener !== '{' && opener !== '[') continue;

			const closer = opener === '{' ? '}' : ']';
			let depth = 0;
			let inString = false;
			let escaped = false;

			for (let index = start; index < text.length; index += 1) {
				const char = text[index];
				if (escaped) {
					escaped = false;
					continue;
				}
				if (char === '\\') {
					escaped = true;
					continue;
				}
				if (char === '"') {
					inString = !inString;
					continue;
				}
				if (inString) continue;
				if (char === opener) depth += 1;
				if (char === closer) depth -= 1;
				if (depth === 0) {
					slices.push(text.slice(start, index + 1));
					break;
				}
			}
		}
		return slices;
	}

	function extractJsonObject(text: string): unknown {
		const trimmed = text.trim();
		const fencedBlocks = Array.from(trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi))
			.map((match) => match[1]?.trim())
			.filter((candidate): candidate is string => Boolean(candidate));
		const candidates = [...fencedBlocks, trimmed];

		for (const candidate of candidates) {
			try {
				return parseJsonCandidate(candidate);
			} catch {}

			for (const slice of findBalancedJsonSlices(candidate)) {
				try {
					return parseJsonCandidate(slice);
				} catch {}
			}
		}

		throw new Error('The judge did not return JSON.');
	}

	function truncateForPrompt(text: string, limit = 1100): string {
		return text.length > limit ? `${text.slice(0, limit)}...` : text;
	}

	function createFallbackStats(post: BattlePost): PostStats {
		const text = post.text;
		const words = text.toLowerCase().match(/[a-z0-9_']+/g) ?? [];
		const uniqueWords = new Set(words).size;
		const letters = text.match(/[a-z]/gi)?.length ?? 0;
		const uppercaseLetters = text.match(/[A-Z]/g)?.length ?? 0;
		const capsRatio = letters > 0 ? uppercaseLetters / letters : 0;
		const urlCount = countMatches(text, /https?:\/\/\S+/g);
		const mentionCount = countMatches(text, /@\S+/g);
		const hashtagCount = countMatches(text, /#[^\s#]+/g);
		const exclamationCount = countMatches(text, /!/g);
		const questionCount = countMatches(text, /\?/g);
		const lineBreakCount = countMatches(text, /\n/g);
		const quoteCount = countMatches(text, /["']/g);
		const hash = hashString(`${post.uri}\n${post.text}`);
		const jitterA = hash % 5;
		const jitterB = (hash >> 5) % 5;
		const wordCount = Math.max(1, words.length);
		const clarity = uniqueWords / wordCount;
		const spark = clampInt(
			1,
			10,
			3 + exclamationCount * 1.4 + questionCount + hashtagCount * 1.2 + capsRatio * 9 + jitterA * 0.4
		);
		const grit = clampInt(
			1,
			10,
			2 + Math.sqrt(text.length) / 9 + lineBreakCount * 0.8 + urlCount + quoteCount * 0.15 + jitterB * 0.35
		);
		const attack = clampInt(
			1,
			16,
			2 + Math.sqrt(uniqueWords) * 1.05 + spark * 0.72 + mentionCount * 0.45 + clarity * 2.3
		);
		const health = clampInt(3, 24, 4 + Math.sqrt(text.length) * 0.72 + grit * 0.9 + wordCount / 22);
		const speed = clampInt(1, 10, 7 + spark * 0.3 - text.length / 260 + ((hash >> 9) % 3));
		const total = attack + health + speed;
		const level = total >= 42 ? 3 : total >= 31 ? 2 : 1;
		const trait =
			urlCount > 0
				? 'Linker'
				: hashtagCount > 0
					? 'Signal'
					: exclamationCount + questionCount >= 3
						? 'Spark'
						: text.length > 420
							? 'Brick'
							: clarity > 0.78
								? 'Needle'
								: 'Bisk';

		return {
			level,
			attack,
			health,
			speed,
			grit,
			spark,
			trait,
			ability: 'Fallback judging',
			source: 'fallback'
		};
	}

	function createPostCard(post: BattlePost, side: Side, slot: number, stats = createFallbackStats(post)): PostCard {
		return {
			id: `${side}-${slot}-${post.id}`,
			side,
			slot,
			post,
			stats,
			currentHealth: stats.health,
			alive: true
		};
	}

	function normalizeStat(value: unknown, min: number, max: number, fallback: number): number {
		const parsed = Math.round(Number(value));
		if (!Number.isFinite(parsed)) return fallback;
		return clampInt(min, max, parsed);
	}

	function normalizeStatText(value: unknown, fallback: string, limit = 56): string {
		const text = String(value ?? '').trim();
		if (!text) return fallback;
		return text.length > limit ? text.slice(0, limit).trim() : text;
	}

	function buildCardRoster(sideName: string, posts: BattlePost[]): string {
		return posts
			.map(
				(post, index) => `${sideName}${index + 1}
postId: ${post.id}
author: @${post.authorHandle}
text:
${truncateForPrompt(post.text)}`
			)
			.join('\n\n---\n\n');
	}

	function buildCardStatsPrompt(heroPosts: BattlePost[], enemyPosts: BattlePost[]): string {
		return `${JUDGE_INSTRUCTIONS}

Create Super Auto Bisks cards from these Bluesky posts.

Return one JSON object and nothing else:
{
  "heroCards": [
    {
      "postId": "exact postId",
      "level": 1,
      "attack": 1,
      "health": 3,
      "speed": 1,
      "grit": 1,
      "spark": 1,
      "trait": "short archetype",
      "ability": "short reason the card attacks this way"
    }
  ],
  "enemyCards": [
    {
      "postId": "exact postId",
      "level": 1,
      "attack": 1,
      "health": 3,
      "speed": 1,
      "grit": 1,
      "spark": 1,
      "trait": "short archetype",
      "ability": "short reason the card attacks this way"
    }
  ]
}

Rules:
- Use every post exactly once.
- Create exactly ${TEAM_SIZE} hero cards and exactly ${TEAM_SIZE} enemy cards.
- Derive attack from your judgement of how hard the post lands as an attack: wit, force, surprise, precision, emotional damage, or rhetorical bite.
- Derive health from your judgement of how well the post can withstand counterattack: composure, density, clarity, sincerity, or durable substance.
- Do not derive attack from character count. Long posts can be weak; short posts can hit hard.
- Keep the two full-team budgets roughly fair overall, even if individual cards spike.
- level is 1 to 3. attack is 1 to 16. health is 3 to 24. speed, grit, and spark are 1 to 10.
- trait is 1 or 2 words. ability is one short phrase, not a sentence.

HERO POSTS:
${buildCardRoster('AUTHOR', heroPosts)}

ENEMY POSTS:
${buildCardRoster('ENEMY', enemyPosts)}`;
	}

	function normalizeGeminiCardStats(value: unknown, posts: BattlePost[], side: Side): PostCard[] {
		const payload = Array.isArray(value) ? { cards: value } : (value as any);
		const rawCards = (
			Array.isArray(payload?.cards)
				? payload.cards
				: Array.isArray(payload?.postCards)
					? payload.postCards
					: Array.isArray(payload?.stats)
						? payload.stats
						: []
		) as any[];

		const usedIndexes = new Set<number>();
		return posts.map((post, index) => {
			const fallback = createFallbackStats(post);
			let rawIndex = rawCards.findIndex((candidate, candidateIndex) => {
				if (usedIndexes.has(candidateIndex)) return false;
				const candidateId = String(
					candidate?.postId ?? candidate?.postID ?? candidate?.post_id ?? candidate?.id ?? candidate?.uri ?? ''
				).trim();
				return candidateId === post.id || candidateId === post.uri;
			});
			if (rawIndex < 0 && rawCards[index] && !usedIndexes.has(index)) rawIndex = index;
			const raw = rawIndex >= 0 ? rawCards[rawIndex] : null;
			if (rawIndex >= 0) usedIndexes.add(rawIndex);

			const stats: PostStats = raw
				? {
						level: normalizeStat(raw.level, 1, 3, fallback.level),
						attack: normalizeStat(raw.attack ?? raw.atk, 1, 16, fallback.attack),
						health: normalizeStat(raw.health ?? raw.hp, 3, 24, fallback.health),
						speed: normalizeStat(raw.speed ?? raw.spd, 1, 10, fallback.speed),
						grit: normalizeStat(raw.grit, 1, 10, fallback.grit),
						spark: normalizeStat(raw.spark, 1, 10, fallback.spark),
						trait: normalizeStatText(raw.trait ?? raw.archetype ?? raw.type, fallback.trait, 24),
						ability: normalizeStatText(raw.ability ?? raw.reason ?? raw.move, fallback.ability, 64),
						source: 'gemini'
					}
				: fallback;

			return createPostCard(post, side, index, stats);
		});
	}

	function readCardArray(payload: any, side: Side): unknown[] {
		const sideCards =
			side === 'hero'
				? payload?.heroCards ?? payload?.authorCards ?? payload?.heroes
				: payload?.enemyCards ?? payload?.opponentCards ?? payload?.enemies;
		if (Array.isArray(sideCards)) return sideCards;
		if (Array.isArray(payload?.cards)) {
			return payload.cards.filter((card: any) => {
				const sideText = String(card?.side ?? card?.team ?? card?.owner ?? '').toLowerCase();
				return side === 'hero'
					? sideText.includes('hero') || sideText.includes('author')
					: sideText.includes('enemy') || sideText.includes('opponent');
			});
		}
		return [];
	}

	async function createBothTeamsWithGemini(
		heroPosts: BattlePost[],
		enemyPosts: BattlePost[]
	): Promise<{ hero: PostCard[]; enemy: PostCard[] }> {
		const output = await runGeminiChat(
			[{ role: 'user', content: buildCardStatsPrompt(heroPosts, enemyPosts) }],
			maxOutputTokens,
			{
				temperature: 0.35,
				topP: 0.9,
				label: 'creating both teams',
				responseMimeType: 'application/json'
			}
		);
		const payload = extractJsonObject(output) as any;
		return {
			hero: normalizeGeminiCardStats(readCardArray(payload, 'hero'), heroPosts, 'hero'),
			enemy: normalizeGeminiCardStats(readCardArray(payload, 'enemy'), enemyPosts, 'enemy')
		};
	}

	function teamPower(cards: PostCard[]): number {
		return cards.reduce(
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

	function formatPower(value: number): string {
		return Number.isFinite(value) ? value.toFixed(1) : '0.0';
	}

	function scaleTeam(cards: PostCard[], scale: number): PostCard[] {
		return cards.map((card) => {
			const attack = normalizeStat(card.stats.attack * scale, 1, 16, card.stats.attack);
			const health = normalizeStat(card.stats.health * scale, 3, 24, card.stats.health);
			const level = attack + health + card.stats.speed >= 42 ? 3 : attack + health + card.stats.speed >= 31 ? 2 : 1;
			return {
				...cloneCard(card),
				stats: {
					...card.stats,
					level,
					attack,
					health
				},
				currentHealth: health,
				alive: true
			};
		});
	}

	function balanceTeams(hero: PostCard[], enemy: PostCard[]) {
		const heroPower = teamPower(hero);
		const enemyPower = teamPower(enemy);
		const lowerPower = Math.max(1, Math.min(heroPower, enemyPower));
		const upperPower = Math.max(heroPower, enemyPower);
		const ratio = upperPower / lowerPower;

		if (ratio <= 1 + BALANCE_TOLERANCE) {
			return {
				hero,
				enemy,
				summary: `Balance check: ${sideLabel('hero')} ${formatPower(heroPower)} vs ${sideLabel('enemy')} ${formatPower(enemyPower)}. No adjustment.`
			};
		}

		const targetPower = (heroPower + enemyPower) / 2;
		const heroScale = Math.max(
			1 - MAX_BALANCE_SHIFT,
			Math.min(1 + MAX_BALANCE_SHIFT, targetPower / Math.max(1, heroPower))
		);
		const enemyScale = Math.max(
			1 - MAX_BALANCE_SHIFT,
			Math.min(1 + MAX_BALANCE_SHIFT, targetPower / Math.max(1, enemyPower))
		);
		const balancedHero = scaleTeam(hero, heroScale);
		const balancedEnemy = scaleTeam(enemy, enemyScale);
		const nextHeroPower = teamPower(balancedHero);
		const nextEnemyPower = teamPower(balancedEnemy);

		return {
			hero: balancedHero,
			enemy: balancedEnemy,
			summary: `Balance pass: ${sideLabel('hero')} ${formatPower(heroPower)} -> ${formatPower(nextHeroPower)}, ${sideLabel('enemy')} ${formatPower(enemyPower)} -> ${formatPower(nextEnemyPower)}.`
		};
	}

	function cloneCard(card: PostCard): PostCard {
		return {
			...card,
			post: { ...card.post },
			stats: { ...card.stats }
		};
	}

	function resetCardsForFight(cards: PostCard[]): PostCard[] {
		return cards.map((card) => ({
			...cloneCard(card),
			currentHealth: card.stats.health,
			alive: true
		}));
	}

	function firstAlive(cards: PostCard[]): PostCard | null {
		return cards.find((card) => card.alive && card.currentHealth > 0) ?? null;
	}

	function snapshot(cards: PostCard[]): PostCard[] {
		return cards.map(cloneCard);
	}

	function summarizeWinner(winner: Side | 'draw', heroFinal: PostCard[], enemyFinal: PostCard[]): string {
		if (winner === 'draw') return 'Both boards ran out of health at the same time.';
		const survivors = (winner === 'hero' ? heroFinal : enemyFinal).filter((card) => card.alive).length;
		return `${sideLabel(winner)} wins with ${survivors} card${survivors === 1 ? '' : 's'} still standing.`;
	}

	function simulateFight(heroBase: PostCard[], enemyBase: PostCard[]) {
		const hero = resetCardsForFight(heroBase);
		const enemy = resetCardsForFight(enemyBase);
		const events: FightEvent[] = [];
		let round = 1;

		while (firstAlive(hero) && firstAlive(enemy) && round <= MAX_ROUNDS) {
			const heroFront = firstAlive(hero);
			const enemyFront = firstAlive(enemy);
			if (!heroFront || !enemyFront) break;

			const heroFirst = heroFront.stats.speed >= enemyFront.stats.speed;
			const first = heroFirst ? heroFront : enemyFront;
			const second = heroFirst ? enemyFront : heroFront;
			const firstDamage = first.stats.attack;
			const secondDamage = second.stats.attack;

			second.currentHealth = Math.max(0, second.currentHealth - firstDamage);
			if (second.currentHealth <= 0) second.alive = false;
			first.currentHealth = Math.max(0, first.currentHealth - secondDamage);
			if (first.currentHealth <= 0) first.alive = false;

			const heroDamage = heroFront.stats.attack;
			const enemyDamage = enemyFront.stats.attack;

			const heroFainted = !heroFront.alive;
			const enemyFainted = !enemyFront.alive;
			const heroName = cardName(heroFront);
			const enemyName = cardName(enemyFront);
			const faintText =
				heroFainted && enemyFainted
					? 'Both cards faint.'
					: heroFainted
							? `${heroName} faints.`
							: enemyFainted
									? `${enemyName} faints.`
									: `${heroName} and ${enemyName} stay in.`;

			events.push({
				id: `round-${round}-${heroFront.id}-${enemyFront.id}`,
				round,
				heroCardId: heroFront.id,
				enemyCardId: enemyFront.id,
				heroName,
				enemyName,
				heroDamage,
				enemyDamage,
				heroHealthAfter: heroFront.currentHealth,
				enemyHealthAfter: enemyFront.currentHealth,
				heroFainted,
				enemyFainted,
				summary: `${heroName} uses ${heroFront.stats.ability} for ${heroDamage}; ${enemyName} uses ${enemyFront.stats.ability} for ${enemyDamage}. ${faintText}`,
				heroCards: snapshot(hero),
				enemyCards: snapshot(enemy)
			});

			round += 1;
		}

		const heroAlive = firstAlive(hero);
		const enemyAlive = firstAlive(enemy);
		const winner: Side | 'draw' = heroAlive && !enemyAlive ? 'hero' : enemyAlive && !heroAlive ? 'enemy' : 'draw';
		return {
			events,
			winner,
			summary: summarizeWinner(winner, hero, enemy),
			heroFinal: hero,
			enemyFinal: enemy
		};
	}

	function scrollLogToEnd() {
		requestAnimationFrame(() => {
			logElement?.scrollTo({
				top: logElement.scrollHeight,
				behavior: 'smooth'
			});
		});
	}

	function clearFightPlayback() {
		if (fightTimer) {
			clearTimeout(fightTimer);
			fightTimer = null;
		}
		if (fightPhase === 'playing') fightPhase = 'idle';
	}

	function resetFightState() {
		clearFightPlayback();
		combatHeroCards = [];
		combatEnemyCards = [];
		fightEvents = [];
		displayedFightEvents = [];
		activeEventIndex = -1;
		fightWinner = '';
		fightSummary = '';
		fightPhase = 'idle';
	}

	function resetDraftState() {
		draftPosts = [];
		selectedIds = [];
		heroCards = [];
		balanceSummary = '';
		resetFightState();
	}

	function resetEnemyDraftState() {
		enemyDraftPosts = [];
		enemyCards = [];
		balanceSummary = '';
		resetFightState();
	}

	function setProfile(nextProfile: ProfileInfo) {
		profile = nextProfile;
		initialHandle = nextProfile.handle;
		repoError = null;
		allPosts = [];
		resetDraftState();
	}

	function setEnemyProfile(nextProfile: ProfileInfo) {
		enemyProfile = nextProfile;
		enemyInitialHandle = nextProfile.handle;
		enemyRepoError = null;
		enemyAllPosts = [];
		resetEnemyDraftState();
	}

	async function selectHandle(rawHandle: string) {
		const handle = normalizeHandle(rawHandle);
		if (!handle) return;

		profileLoading = true;
		repoError = null;
		try {
			setProfile(await getProfile(handle));
		} catch (value) {
			repoError = describeError(value) || `Could not resolve @${handle}.`;
			profile = null;
		} finally {
			profileLoading = false;
		}
	}

	function handleProfileSelected(nextProfile: ProfileInfo) {
		setProfile(nextProfile);
	}

	async function selectEnemyHandle(rawHandle: string) {
		const handle = normalizeHandle(rawHandle);
		if (!handle) return;

		enemyProfileLoading = true;
		enemyRepoError = null;
		try {
			setEnemyProfile(await getProfile(handle));
		} catch (value) {
			enemyRepoError = describeError(value) || `Could not resolve @${handle}.`;
			enemyProfile = null;
		} finally {
			enemyProfileLoading = false;
		}
	}

	function handleEnemyProfileSelected(nextProfile: ProfileInfo) {
		setEnemyProfile(nextProfile);
	}

	async function loadPostsForProfile(
		currentProfile: ProfileInfo,
		controller: AbortController,
		setLoadProgress: (nextProgress: DiscoverProgress) => void
	): Promise<BattlePost[]> {
		const author: AuthorInfo = {
			did: currentProfile.did,
			handle: currentProfile.handle,
			displayName: currentProfile.displayName,
			avatar: currentProfile.avatar
		};

		let latestDownloadedBytes = 0;
		setLoadProgress({
			phase: `Preparing @${currentProfile.handle}...`,
			current: 0,
			total: 100
		});

		const repo = await loadRepoFeedItems(currentProfile.did, author, {
			signal: controller.signal,
			onDownloadProgress: (downloadProgress) => {
				latestDownloadedBytes = downloadProgress.receivedBytes;
				setLoadProgress(
					downloadProgress.totalBytes > 0
						? {
								phase: `Downloading @${currentProfile.handle}...`,
								current: Math.round(
									(downloadProgress.receivedBytes / downloadProgress.totalBytes) * 100
								),
								total: 100,
								detail: buildRepoDownloadDetail(downloadProgress)
							}
						: {
								phase: `Downloading @${currentProfile.handle}...`,
								current: 0,
								total: 0,
								detail: buildRepoDownloadDetail(downloadProgress)
							}
				);
			},
			onParseProgress: (count) => {
				setLoadProgress({
					phase: `Parsing @${currentProfile.handle}...`,
					current: count,
					total: 0,
					detail: `${count.toLocaleString()} posts extracted from ${formatBytes(latestDownloadedBytes)}`
				});
			}
		});

		if (controller.signal.aborted) return [];

		return repo.parsedPosts
			.map((post): BattlePost | null => {
				const text = typeof post.record?.text === 'string' ? post.record.text.trim() : '';
				if (!text) return null;
				const uri = `at://${currentProfile.did}/app.bsky.feed.post/${post.rkey}`;
				return {
					id: uri,
					uri,
					text,
					createdAt: typeof post.record?.createdAt === 'string' ? post.record.createdAt : undefined,
					authorHandle: currentProfile.handle
				};
			})
			.filter((post): post is BattlePost => post !== null)
			.sort((a, b) => {
				const aTime = a.createdAt ? Date.parse(a.createdAt) : 0;
				const bTime = b.createdAt ? Date.parse(b.createdAt) : 0;
				return (Number.isFinite(bTime) ? bTime : 0) - (Number.isFinite(aTime) ? aTime : 0);
			});
	}

	async function loadPostsForProfileFromCar(
		currentProfile: ProfileInfo,
		carBytes: Uint8Array,
		controller: AbortController,
		setLoadProgress: (nextProgress: DiscoverProgress) => void
	): Promise<BattlePost[]> {
		const author: AuthorInfo = {
			did: currentProfile.did,
			handle: currentProfile.handle,
			displayName: currentProfile.displayName,
			avatar: currentProfile.avatar
		};
		setLoadProgress({
			phase: `Parsing saved CAR for @${currentProfile.handle}...`,
			current: 0,
			total: 0,
			detail: formatBytes(carBytes.byteLength)
		});
		const repo = await parseRepoFeedItemsFromCar(currentProfile.did, author, carBytes, {
			signal: controller.signal,
			downloadedBytes: carBytes.byteLength,
			totalBytes: carBytes.byteLength,
			source: 'pds',
			onParseProgress: (count) => {
				setLoadProgress({
					phase: `Parsing saved CAR for @${currentProfile.handle}...`,
					current: count,
					total: 0,
					detail: `${count.toLocaleString()} posts extracted from ${formatBytes(carBytes.byteLength)}`
				});
			}
		});

		if (controller.signal.aborted) return [];

		return repo.parsedPosts
			.map((post): BattlePost | null => {
				const text = typeof post.record?.text === 'string' ? post.record.text.trim() : '';
				if (!text) return null;
				const uri = `at://${currentProfile.did}/app.bsky.feed.post/${post.rkey}`;
				return {
					id: uri,
					uri,
					text,
					createdAt: typeof post.record?.createdAt === 'string' ? post.record.createdAt : undefined,
					authorHandle: currentProfile.handle
				};
			})
			.filter((post): post is BattlePost => post !== null)
			.sort((a, b) => {
				const aTime = a.createdAt ? Date.parse(a.createdAt) : 0;
				const bTime = b.createdAt ? Date.parse(b.createdAt) : 0;
				return (Number.isFinite(bTime) ? bTime : 0) - (Number.isFinite(aTime) ? aTime : 0);
			});
	}

	async function loadRepo() {
		if (!profile || repoLoading) return;

		abortController?.abort();
		const controller = new AbortController();
		abortController = controller;
		repoLoading = true;
		repoError = null;
		resetDraftState();

		const currentProfile = profile;
		try {
			const nextPosts = await loadPostsForProfile(currentProfile, controller, (nextProgress) => {
				progress = nextProgress;
			});
			if (controller.signal.aborted) return;

			allPosts = nextPosts;
			progress = {
				phase: 'Loaded',
				current: nextPosts.length,
				total: nextPosts.length,
				detail: `${nextPosts.filter((post) => post.text.length >= minChars).length.toLocaleString()} posts pass the current filter`
			};
		} catch (value) {
			if ((value as any)?.name !== 'AbortError') {
				repoError = describeError(value) || 'Could not load this repo.';
			}
		} finally {
			if (abortController === controller) {
				abortController = null;
				repoLoading = false;
			}
		}
	}

	async function loadEnemyRepo() {
		if (!enemyProfile || enemyRepoLoading) return;

		enemyAbortController?.abort();
		const controller = new AbortController();
		enemyAbortController = controller;
		enemyRepoLoading = true;
		enemyRepoError = null;
		resetEnemyDraftState();

		const currentProfile = enemyProfile;
		try {
			const nextPosts = await loadPostsForProfile(currentProfile, controller, (nextProgress) => {
				enemyProgress = nextProgress;
			});
			if (controller.signal.aborted) return;

			enemyAllPosts = nextPosts;
			enemyProgress = {
				phase: 'Loaded',
				current: nextPosts.length,
				total: nextPosts.length,
				detail: `${nextPosts.filter((post) => post.text.length >= minChars).length.toLocaleString()} enemy posts pass the current filter`
			};
			const eligibleNextPosts = nextPosts.filter((post) => post.text.length >= minChars);
			if (eligibleNextPosts.length > 0) rollEnemyCards(eligibleNextPosts);
		} catch (value) {
			if ((value as any)?.name !== 'AbortError') {
				enemyRepoError = describeError(value) || 'Could not load this enemy repo.';
			}
		} finally {
			if (enemyAbortController === controller) {
				enemyAbortController = null;
				enemyRepoLoading = false;
			}
		}
	}

	async function loadSavedRepoCar(_entry: unknown, carBytes: Uint8Array) {
		if (!profile || repoLoading) return;
		abortController?.abort();
		const controller = new AbortController();
		abortController = controller;
		repoLoading = true;
		repoError = null;
		resetDraftState();
		const currentProfile = profile;
		try {
			const nextPosts = await loadPostsForProfileFromCar(currentProfile, carBytes, controller, (nextProgress) => {
				progress = nextProgress;
			});
			if (controller.signal.aborted) return;
			allPosts = nextPosts;
			progress = {
				phase: 'Loaded saved CAR',
				current: nextPosts.length,
				total: nextPosts.length,
				detail: `${nextPosts.filter((post) => post.text.length >= minChars).length.toLocaleString()} posts pass the current filter`
			};
		} catch (value) {
			if ((value as any)?.name !== 'AbortError') {
				repoError = describeError(value) || 'Could not load this saved CAR.';
			}
		} finally {
			if (abortController === controller) {
				abortController = null;
				repoLoading = false;
			}
		}
	}

	async function loadSavedEnemyRepoCar(_entry: unknown, carBytes: Uint8Array) {
		if (!enemyProfile || enemyRepoLoading) return;
		enemyAbortController?.abort();
		const controller = new AbortController();
		enemyAbortController = controller;
		enemyRepoLoading = true;
		enemyRepoError = null;
		resetEnemyDraftState();
		const currentProfile = enemyProfile;
		try {
			const nextPosts = await loadPostsForProfileFromCar(currentProfile, carBytes, controller, (nextProgress) => {
				enemyProgress = nextProgress;
			});
			if (controller.signal.aborted) return;
			enemyAllPosts = nextPosts;
			enemyProgress = {
				phase: 'Loaded saved CAR',
				current: nextPosts.length,
				total: nextPosts.length,
				detail: `${nextPosts.filter((post) => post.text.length >= minChars).length.toLocaleString()} enemy posts pass the current filter`
			};
			enemyDraftPosts = randomPostsFromPool(
				nextPosts.filter((post) => post.text.length >= minChars),
				ENEMY_SELECTION_COUNT
			);
			resetDuelState();
		} catch (value) {
			if ((value as any)?.name !== 'AbortError') {
				enemyRepoError = describeError(value) || 'Could not load this saved enemy CAR.';
			}
		} finally {
			if (enemyAbortController === controller) {
				enemyAbortController = null;
				enemyRepoLoading = false;
			}
		}
	}

	function abortRepoLoad() {
		abortController?.abort();
		abortController = null;
		repoLoading = false;
		progress = { phase: '', current: 0, total: 0 };
	}

	function abortEnemyRepoLoad() {
		enemyAbortController?.abort();
		enemyAbortController = null;
		enemyRepoLoading = false;
		enemyProgress = { phase: '', current: 0, total: 0 };
	}

	function rollDraftPool() {
		if (eligiblePosts.length === 0) return;
		draftPosts = randomPostsFromPool(eligiblePosts, DRAFT_POOL_SIZE);
		selectedIds = [];
		heroCards = [];
		enemyCards = [];
		balanceSummary = '';
		resetFightState();
	}

	function rollEnemyCards(pool = eligibleEnemyPosts) {
		if (pool.length === 0) return;
		const nextPosts = randomPostsFromPool(pool, TEAM_SIZE);
		enemyDraftPosts = nextPosts;
		heroCards = [];
		enemyCards = [];
		balanceSummary = '';
		resetFightState();
	}

	async function forgeHeroCards() {
		if (selectedPosts.length !== TEAM_SIZE || enemyDraftPosts.length !== TEAM_SIZE) return;
		resetFightState();
		llmError = null;
		const heroPosts = [...selectedPosts];
		const enemyPosts = [...enemyDraftPosts];
		try {
			const nextTeams = await createBothTeamsWithGemini(heroPosts, enemyPosts);
			const balancedTeams = balanceTeams(nextTeams.hero, nextTeams.enemy);
			heroCards = balancedTeams.hero;
			enemyCards = balancedTeams.enemy;
			balanceSummary = balancedTeams.summary;
		} catch (value) {
			llmError = describeError(value);
			heroCards = [];
			enemyCards = [];
			balanceSummary = '';
		}
	}

	function togglePost(id: string) {
		let nextIds: string[];
		if (selectedIds.includes(id)) {
			nextIds = selectedIds.filter((selectedId) => selectedId !== id);
		} else {
			if (selectedIds.length >= TEAM_SIZE) return;
			nextIds = [...selectedIds, id];
		}

		selectedIds = nextIds;
		heroCards = [];
		enemyCards = [];
		balanceSummary = '';
		resetFightState();
	}

	function handleMinCharsChange(event: Event) {
		const value = Number((event.currentTarget as HTMLInputElement).value);
		minChars = Math.max(1, Math.min(2000, Math.round(Number.isFinite(value) ? value : MIN_CHARS_DEFAULT)));
		resetDraftState();
		resetEnemyDraftState();
	}

	function handleFontChange(key: string) {
		fontKey = key;
		try {
			localStorage.setItem('preferred-font', key);
		} catch {}
	}

	function playFight(events: FightEvent[] = fightEvents) {
		clearFightPlayback();
		displayedFightEvents = [];
		activeEventIndex = -1;
		combatHeroCards = resetCardsForFight(heroCards);
		combatEnemyCards = resetCardsForFight(enemyCards);

		if (events.length === 0) return;

		let index = 0;
		fightPhase = 'playing';
		const step = () => {
			const event = events[index];
			if (!event) {
				fightPhase = 'finished';
				fightTimer = null;
				return;
			}

			combatHeroCards = snapshot(event.heroCards);
			combatEnemyCards = snapshot(event.enemyCards);
			displayedFightEvents = [...displayedFightEvents, event];
			activeEventIndex = index;
			scrollLogToEnd();
			index += 1;
			fightTimer = setTimeout(step, FIGHT_STEP_MS);
		};

		fightTimer = setTimeout(step, 250);
	}

	function startFight() {
		if (!canFight) return;
		llmError = null;
		resetFightState();
		const result = simulateFight(heroCards, enemyCards);
		fightEvents = result.events;
		fightWinner = result.winner;
		fightSummary = result.summary;
		playFight(result.events);
	}

	onMount(() => {
		llmProgress = 1;
		frontendGeminiKey = window.localStorage.getItem(GEMINI_KEY_STORAGE_KEY) ?? '';
		const savedFont = window.localStorage.getItem('preferred-font');
		if (savedFont && savedFont in fontFamilies) {
			fontKey = savedFont;
		}
		const params = new URLSearchParams(window.location.search);
		const handle = params.get('handle');
		const enemy = params.get('enemy');
		if (handle) {
			initialHandle = handle;
			void selectHandle(handle);
		}
		if (enemy) {
			enemyInitialHandle = enemy;
			void selectEnemyHandle(enemy);
		}
	});

	onDestroy(() => {
		abortController?.abort();
		enemyAbortController?.abort();
		clearFightPlayback();
	});
</script>

<svelte:head>
	<title>Super Auto Bisks</title>
</svelte:head>

<main class="super-page" style="font-family: {fontFamily}; --font-hand: {fontFamily};">
	<header class="page-header">
		<RouteNav current="superautobisks" align="center" handle={profile?.handle ?? null} />
		<div class="title-row">
			<div>
				<p class="eyebrow">Five-card post autobattler</p>
				<h1>Super Auto Bisks</h1>
			</div>
				<div class="score-pill" class:active={fightPhase === 'playing'}>
					<span>{fightPhase === 'playing' ? 'Fighting' : fightWinner ? 'Resolved' : 'Ready'}</span>
					<b>
						{fightWinner
							? fightWinner === 'draw'
								? 'Draw'
								: `${sideLabel(fightWinner)} wins`
							: `${heroCards.length}/${TEAM_SIZE} vs ${enemyCards.length}/${TEAM_SIZE}`}
					</b>
					<div class="mini-progress" aria-label="Gemini request progress">
						<div style:width={`${Math.round(llmProgress * 100)}%`}></div>
					</div>
				</div>
		</div>
		<div class="header-tools">
			<FontPicker value={fontKey} onchange={handleFontChange} />
		</div>
	</header>

	<section class="control-strip" aria-label="Author controls">
		<div class="search-cell">
			<SearchBar
				onsearch={selectHandle}
				onprofile={handleProfileSelected}
				disabled={profileLoading || repoLoading}
				{initialHandle}
				placeholder="Search your author..."
				buttonLabel="Set"
			/>
		</div>

			<label>
				<span>Minimum Characters</span>
				<input
					type="number"
					min="1"
				max="2000"
				step="25"
				value={minChars}
				onchange={handleMinCharsChange}
				/>
			</label>

			<label>
				<span>Output Tokens</span>
				<input
					type="number"
					min="512"
					max="8192"
					step="256"
					value={maxOutputTokens}
					onchange={handleMaxOutputTokensChange}
				/>
			</label>

			<button type="button" class="primary-button wobbly-border" disabled={!canLoadRepo} onclick={loadRepo}>
				Load CAR
			</button>
			<button type="button" class="primary-button wobbly-border" disabled={!canRollDraft} onclick={rollDraftPool}>
				Roll Draft
			</button>

			{#if repoLoading}
				<button type="button" class="secondary-button wobbly-border-light" onclick={abortRepoLoad}>
					Stop
				</button>
			{/if}
		</section>

		<section class="gemini-key-panel" aria-label="Gemini API key">
			<label class="key-field">
				<span>Gemini API Key</span>
				<input
					type={showGeminiKey ? 'text' : 'password'}
					value={frontendGeminiKey}
					placeholder="AIza..."
					autocomplete="off"
					spellcheck="false"
					oninput={handleFrontendGeminiKeyInput}
				/>
			</label>
			<button
				type="button"
				class="secondary-button wobbly-border-light"
				disabled={!frontendGeminiKey}
				onclick={() => (showGeminiKey = !showGeminiKey)}
			>
				{showGeminiKey ? 'Hide' : 'Show'}
			</button>
			<button
				type="button"
				class="secondary-button wobbly-border-light"
				disabled={!frontendGeminiKey}
				onclick={clearFrontendGeminiKey}
			>
				Clear
			</button>
			<span class:ready={hasGeminiKey}>{hasGeminiKey ? `${GEMINI_MODEL_LABEL} active` : 'Gemini key required'}</span>
		</section>

		<section class="status-line" aria-live="polite">
			<div>
				<b>{profile ? `@${profile.handle}` : 'No author selected'}</b>
				<span>{allPosts.length.toLocaleString()} posts loaded</span>
			<span>{eligiblePosts.length.toLocaleString()} eligible</span>
			<span>{selectedIds.length}/{TEAM_SIZE} drafted</span>
		</div>
			<div>
				<b>{enemyProfile ? `@${enemyProfile.handle}` : 'No enemy selected'}</b>
				<span>{enemyAllPosts.length.toLocaleString()} loaded</span>
				<span>{enemyCards.length}/{TEAM_SIZE} enemy cards</span>
			</div>
			<div>
				<b>{llmText}</b>
				<span>{maxOutputTokens.toLocaleString()} out</span>
			</div>
		</section>

	{#if repoError}
		<ErrorBanner message={repoError} />
	{/if}
		{#if enemyRepoError}
			<ErrorBanner message={enemyRepoError} />
		{/if}
		{#if llmError}
			<ErrorBanner message={llmError} />
		{/if}
	{#if repoLoading}
		<LoadingSpinner {progress} />
	{/if}
	{#if enemyRepoLoading}
		<LoadingSpinner progress={enemyProgress} />
	{/if}

	<section class="enemy-panel" aria-label="Enemy author controls">
		<div class="panel-heading">
			<div>
				<h2>Enemy Poster</h2>
				<span>
					{enemyProfile ? `@${enemyProfile.handle}` : 'Choose an enemy poster'} ·
					{enemyDraftPosts.length} random posts
				</span>
			</div>
			<div class="panel-actions">
				<button
					type="button"
					class="primary-button wobbly-border"
					disabled={!canLoadEnemyRepo}
					onclick={loadEnemyRepo}
				>
					Load Enemy CAR
				</button>
				<button
					type="button"
					class="secondary-button wobbly-border-light"
					disabled={!canRollEnemy}
					onclick={() => void rollEnemyCards()}
				>
					Roll Enemy 5
				</button>
				{#if enemyRepoLoading}
					<button type="button" class="secondary-button wobbly-border-light" onclick={abortEnemyRepoLoad}>
						Stop
					</button>
				{/if}
			</div>
		</div>
		<div class="enemy-controls">
			<div class="search-cell">
				<SearchBar
					onsearch={selectEnemyHandle}
					onprofile={handleEnemyProfileSelected}
					disabled={enemyProfileLoading || enemyRepoLoading}
					initialHandle={enemyInitialHandle}
					placeholder="Search enemy author..."
					buttonLabel="Set Enemy"
				/>
			</div>
			<div class="mini-team">
				{#if enemyCards.length === 0}
					{#if enemyDraftPosts.length > 0}
						{#each enemyDraftPosts as post, index (post.id)}
							<article class="mini-card pending">
								<b>E{index + 1}</b>
								<span>{llmState === 'generating' ? 'Gemini judging both teams' : 'queued for team stats'}</span>
								{#if postBiskUrl(post)}
									<a class="bisk-link" href={postBiskUrl(post)} target="_blank" rel="noreferrer">Open Bisk</a>
								{/if}
								<p>{post.text}</p>
							</article>
						{/each}
					{:else}
						<div class="empty-state compact">
							{hasGeminiKey ? 'Roll five enemy post cards' : 'Paste a Gemini key to create enemy cards'}
						</div>
					{/if}
				{:else}
					{#each enemyCards as card (card.id)}
						<article class="mini-card">
								<b>{cardName(card)} · Lv{card.stats.level}</b>
								<span>{card.stats.attack} ATK / {card.stats.health} HP</span>
								<small>{card.stats.ability}</small>
								{#if postBiskUrl(card.post)}
									<a class="bisk-link" href={postBiskUrl(card.post)} target="_blank" rel="noreferrer">Open Bisk</a>
								{/if}
								<p>{card.post.text}</p>
							</article>
					{/each}
				{/if}
			</div>
		</div>
	</section>

	<div class="setup-grid">
		<section class="draft-panel" aria-label="Draft pool">
			<div class="panel-heading">
				<div>
					<h2>Draft Pool</h2>
					<span>Pick exactly {TEAM_SIZE} posts, then create both teams</span>
				</div>
				<button
					type="button"
					class="primary-button wobbly-border"
					disabled={!canForgeCards}
					onclick={() => void forgeHeroCards()}
				>
					Create Both Teams
				</button>
			</div>

			{#if draftPosts.length === 0}
				<div class="empty-state">Roll a draft pool from the author repo</div>
			{:else}
				<div class="draft-list">
					{#each draftPosts as post, index (post.id)}
						<button
							type="button"
							class="draft-post"
							class:selected={selectedIds.includes(post.id)}
							disabled={!selectedIds.includes(post.id) && selectedIds.length >= TEAM_SIZE}
							onclick={() => togglePost(post.id)}
						>
							<span class="post-meta">
								<span>#{index + 1}</span>
								<span>{post.text.length.toLocaleString()} chars</span>
								<span>{shortDate(post.createdAt)}</span>
							</span>
							<span class="post-text">{post.text}</span>
						</button>
					{/each}
				</div>
			{/if}
		</section>

		<section class="cards-panel" aria-label="Your post cards">
			<div class="panel-heading">
				<div>
					<h2>Your Cards</h2>
					<span>
						{heroCards.length
							? 'Gemini stats locked'
							: `${selectedPosts.length}/${TEAM_SIZE} selected · ${enemyDraftPosts.length}/${TEAM_SIZE} enemy ready`}
					</span>
				</div>
			</div>

			{#if heroCards.length === 0 && selectedPosts.length === 0}
				<div class="empty-state">Selected posts become Gemini-judged stat cards here</div>
			{:else if heroCards.length === 0}
				<div class="selected-stubs">
					{#each selectedPosts as post, index (post.id)}
							<article>
								<b>A{index + 1}</b>
								<span>{llmState === 'generating' ? 'Gemini judging both teams' : 'queued for team stats'}</span>
								{#if postBiskUrl(post)}
									<a class="bisk-link" href={postBiskUrl(post)} target="_blank" rel="noreferrer">Open Bisk</a>
								{/if}
								<p>{post.text}</p>
							</article>
					{/each}
				</div>
			{:else}
				<div class="card-grid compact-cards">
					{#each heroCards as card (card.id)}
						<article class="battle-card hero-card preview">
							<header>
								<span class="level-badge">Lv{card.stats.level}</span>
								<div>
									<b>{cardName(card)}</b>
									<span>{card.stats.trait}</span>
								</div>
								<div class="avatar small-avatar">
									{#if sideAvatar('hero')}
										<img src={sideAvatar('hero')} alt="" />
									{:else}
										<span>{sideInitial('hero')}</span>
									{/if}
								</div>
							</header>
								<p>{card.post.text}</p>
								<small class="ability">{card.stats.ability}</small>
								{#if postBiskUrl(card.post)}
									<a class="bisk-link" href={postBiskUrl(card.post)} target="_blank" rel="noreferrer">Open Bisk</a>
								{/if}
								<footer>
								<span class="stat attack">{card.stats.attack}</span>
								<span class="stat health">{card.stats.health}</span>
								<span class="stat speed">{card.stats.speed} SPD</span>
							</footer>
						</article>
					{/each}
				</div>
			{/if}
		</section>
	</div>

	<section class="battle-panel" aria-label="Super Auto Bisks fight">
		<div class="panel-heading">
			<div>
				<h2>Fight Board</h2>
				<span>
					{heroCards.length}/{TEAM_SIZE} author cards vs {enemyCards.length}/{TEAM_SIZE} enemy cards
					{#if fightWinner}
						· {fightWinner === 'draw' ? 'Draw' : `${sideLabel(fightWinner)} wins`}
					{/if}
				</span>
			</div>
				<div class="panel-actions">
				<button type="button" class="primary-button wobbly-border" disabled={!canFight} onclick={startFight}>
					Start Fight
				</button>
				<button
					type="button"
					class="secondary-button wobbly-border-light"
					disabled={fightEvents.length === 0 || fightPhase === 'playing'}
					onclick={() => playFight()}
				>
					Replay
				</button>
			</div>
		</div>

		<div class="versus-board">
			<div class="team-banner hero-banner">
				<div class="avatar">
					{#if sideAvatar('hero')}
						<img src={sideAvatar('hero')} alt="" />
					{:else}
						<span>{sideInitial('hero')}</span>
					{/if}
				</div>
				<div>
					<b>{sideLabel('hero')}</b>
					<span>{visibleHeroCards.filter((card) => card.alive).length} standing</span>
				</div>
			</div>

			<div class="team-row hero-row">
				{#if visibleHeroCards.length === 0}
					<div class="empty-row">Create your five post cards</div>
				{:else}
					{#each visibleHeroCards as card (card.id)}
						<article
							class="battle-card hero-card"
							class:active={card.id === activeHeroCardId}
							class:fainted={!card.alive}
						>
							<header>
								<span class="level-badge">Lv{card.stats.level}</span>
								<div>
									<b>{cardName(card)}</b>
									<span>{card.stats.trait}</span>
								</div>
								<div class="avatar small-avatar">
									{#if sideAvatar('hero')}
										<img src={sideAvatar('hero')} alt="" />
									{:else}
										<span>{sideInitial('hero')}</span>
									{/if}
								</div>
							</header>
								<p>{card.post.text}</p>
								<small class="ability">{card.stats.ability}</small>
								{#if postBiskUrl(card.post)}
									<a class="bisk-link" href={postBiskUrl(card.post)} target="_blank" rel="noreferrer">Open Bisk</a>
								{/if}
								<footer>
								<span class="stat attack">{card.stats.attack}</span>
								<span class="stat health">{card.currentHealth}</span>
								<span class="stat speed">{card.stats.speed} SPD</span>
							</footer>
						</article>
					{/each}
				{/if}
			</div>

			<div class="board-divider">VS</div>

			<div class="team-row enemy-row">
				{#if visibleEnemyCards.length === 0}
					<div class="empty-row">Roll five enemy post cards</div>
				{:else}
					{#each visibleEnemyCards as card (card.id)}
						<article
							class="battle-card enemy-card"
							class:active={card.id === activeEnemyCardId}
							class:fainted={!card.alive}
						>
							<header>
								<span class="level-badge">Lv{card.stats.level}</span>
								<div>
									<b>{cardName(card)}</b>
									<span>{card.stats.trait}</span>
								</div>
								<div class="avatar small-avatar">
									{#if sideAvatar('enemy')}
										<img src={sideAvatar('enemy')} alt="" />
									{:else}
										<span>{sideInitial('enemy')}</span>
									{/if}
								</div>
							</header>
								<p>{card.post.text}</p>
								<small class="ability">{card.stats.ability}</small>
								{#if postBiskUrl(card.post)}
									<a class="bisk-link" href={postBiskUrl(card.post)} target="_blank" rel="noreferrer">Open Bisk</a>
								{/if}
								<footer>
								<span class="stat attack">{card.stats.attack}</span>
								<span class="stat health">{card.currentHealth}</span>
								<span class="stat speed">{card.stats.speed} SPD</span>
							</footer>
						</article>
					{/each}
				{/if}
			</div>

			<div class="team-banner enemy-banner">
				<div class="avatar">
					{#if sideAvatar('enemy')}
						<img src={sideAvatar('enemy')} alt="" />
					{:else}
						<span>{sideInitial('enemy')}</span>
					{/if}
				</div>
				<div>
					<b>{sideLabel('enemy')}</b>
					<span>{visibleEnemyCards.filter((card) => card.alive).length} standing</span>
				</div>
			</div>
		</div>

		{#if balanceSummary}
			<p class="balance-summary">{balanceSummary}</p>
		{/if}

		{#if fightSummary}
			<p class="fight-summary">{fightSummary}</p>
		{/if}

		<div class="fight-log" bind:this={logElement}>
			{#if displayedFightEvents.length === 0}
				<div class="empty-state compact">Start a fight to simulate from the Gemini card stats</div>
			{:else}
				{#each displayedFightEvents as event, index (event.id)}
					<article class="log-entry" class:active={index === activeEventIndex}>
						<b>Round {event.round}</b>
						<span>{event.summary}</span>
						<small>
							{event.heroName}: {event.heroHealthAfter} HP · {event.enemyName}: {event.enemyHealthAfter} HP
						</small>
					</article>
				{/each}
			{/if}
			</div>
		</section>

		{#if debugOutput}
			<section class="debug-panel" aria-label="Gemini debug output">
				<div class="panel-heading">
					<h2>Debug</h2>
					<span>{debugLabel}</span>
				</div>
				<pre class="raw-output">{debugOutput}</pre>
			</section>
		{/if}
	</main>

<style>
	.super-page {
		width: min(1440px, calc(100vw - 32px));
		margin: 0 auto;
		padding: 28px 0 44px;
	}

	.page-header {
		margin-bottom: 16px;
	}

	.title-row {
		display: flex;
		align-items: flex-end;
		justify-content: space-between;
		gap: 18px;
		margin-top: 10px;
	}

	.header-tools {
		display: flex;
		justify-content: flex-end;
		margin-top: 8px;
	}

	.eyebrow {
		color: var(--muted);
		font-family: var(--font-matrix-ui);
		font-size: 0.78rem;
		font-weight: 800;
		text-transform: uppercase;
	}

	h1 {
		font-size: clamp(2.4rem, 7vw, 5.4rem);
		line-height: 0.92;
		letter-spacing: 0;
	}

	h2 {
		letter-spacing: 0;
		line-height: 1.05;
	}

	.score-pill {
		display: grid;
		gap: 4px;
		min-width: min(280px, 100%);
		padding: 12px;
		border: 1px solid var(--control-border);
		border-radius: 8px;
		background: var(--panel-bg-plain);
		box-shadow: var(--shadow-soft);
	}

	.score-pill span {
		color: var(--muted);
		font-family: var(--font-matrix-ui);
		font-size: 0.74rem;
		font-weight: 900;
		text-transform: uppercase;
	}

	.score-pill b {
		font-size: 1.2rem;
	}

	.score-pill.active {
		border-color: color-mix(in srgb, #3e8f55 58%, var(--control-border));
		background: color-mix(in srgb, #3e8f55 13%, var(--panel-bg-plain));
	}

	.mini-progress {
		overflow: hidden;
		height: 8px;
		border: 1px solid var(--control-border);
		border-radius: 999px;
		background: var(--muted-surface);
	}

	.mini-progress div {
		height: 100%;
		background: linear-gradient(90deg, #237466, var(--accent));
		transition: width 0.2s ease;
	}

	.control-strip,
	.gemini-key-panel,
	.status-line,
	.enemy-panel,
	.draft-panel,
	.cards-panel,
	.battle-panel,
	.debug-panel {
		border: 1px solid var(--control-border);
		border-radius: 8px;
		background: var(--panel-bg);
		box-shadow: var(--shadow-soft);
	}

	.control-strip {
		display: grid;
		grid-template-columns: minmax(260px, 1fr) repeat(2, minmax(120px, 180px)) auto auto auto;
		gap: 12px;
		align-items: end;
		padding: 14px;
		margin-bottom: 12px;
	}

	.gemini-key-panel {
		display: grid;
		grid-template-columns: minmax(260px, 1fr) auto auto auto;
		gap: 10px;
		align-items: end;
		margin-bottom: 12px;
		padding: 12px 14px;
	}

	.gemini-key-panel > span {
		align-self: center;
		color: var(--muted);
		font-family: var(--font-matrix-ui);
		font-size: 0.78rem;
		font-weight: 800;
		text-transform: uppercase;
	}

	.gemini-key-panel > span.ready {
		color: #237466;
	}

	.search-cell {
		min-width: 0;
	}

	label {
		display: grid;
		gap: 6px;
		min-width: 0;
	}

	label span {
		color: var(--muted);
		font-family: var(--font-matrix-ui);
		font-size: 0.72rem;
		font-weight: 800;
		text-transform: uppercase;
	}

	input {
		width: 100%;
		min-height: 42px;
		padding: 8px 10px;
		border: 1px solid var(--control-border);
		border-radius: 8px;
		background: var(--input-bg);
		color: var(--text-ink);
		font-family: inherit;
		font-size: 1rem;
		line-height: 1.4;
	}

	.primary-button,
	.secondary-button {
		min-height: 42px;
		padding: 9px 14px;
		border-radius: 8px;
		font-family: inherit;
		font-weight: 900;
		transition:
			transform 0.16s ease,
			opacity 0.16s ease;
	}

	.primary-button {
		border: 2px solid var(--border-color);
		background: var(--accent);
		color: var(--accent-contrast);
	}

	.secondary-button {
		border: 1.5px solid var(--control-border);
		background: var(--control-bg);
		color: var(--text-ink);
	}

	button:disabled {
		cursor: not-allowed;
		opacity: 0.5;
	}

	button:not(:disabled):hover {
		transform: translateY(-1px);
	}

	.status-line {
		display: flex;
		flex-wrap: wrap;
		justify-content: space-between;
		gap: 10px;
		margin-bottom: 14px;
		padding: 10px 12px;
	}

	.status-line div {
		display: flex;
		flex-wrap: wrap;
		gap: 10px;
		align-items: center;
	}

	.status-line span {
		color: var(--muted);
		font-family: var(--font-matrix-ui);
		font-size: 0.78rem;
	}

	.enemy-panel,
	.draft-panel,
	.cards-panel,
	.battle-panel,
	.debug-panel {
		padding: 16px;
	}

	.enemy-panel,
	.battle-panel {
		display: grid;
		gap: 12px;
		margin-top: 16px;
	}

	.debug-panel {
		margin-top: 16px;
	}

	.panel-heading {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		margin-bottom: 12px;
	}

	.panel-heading span {
		color: var(--muted);
		font-size: 0.95rem;
	}

	.panel-actions {
		display: flex;
		flex-wrap: wrap;
		justify-content: flex-end;
		gap: 8px;
	}

	.enemy-controls {
		display: grid;
		grid-template-columns: minmax(260px, 0.72fr) minmax(0, 1.28fr);
		gap: 12px;
		align-items: start;
	}

	.mini-team {
		display: grid;
		grid-template-columns: repeat(5, minmax(140px, 1fr));
		gap: 10px;
	}

	.mini-card {
		display: grid;
		gap: 6px;
		min-width: 0;
		padding: 10px;
		border: 1px solid var(--control-border);
		border-radius: 8px;
		background: color-mix(in srgb, #9c3b4f 8%, var(--card-bg));
	}

	.mini-card.pending {
		border-style: dashed;
		background: var(--panel-bg-muted);
	}

	.mini-card span {
		color: var(--muted);
		font-family: var(--font-matrix-ui);
		font-size: 0.76rem;
		font-weight: 800;
	}

	.mini-card small,
	.ability {
		color: var(--muted);
		font-family: var(--font-matrix-ui);
		font-size: 0.74rem;
		font-weight: 800;
		text-transform: uppercase;
	}

	.bisk-link {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: fit-content;
		min-height: 28px;
		padding: 4px 9px;
		border: 1px solid var(--control-border);
		border-radius: 999px;
		background: var(--control-bg);
		color: var(--text-ink);
		font-family: var(--font-matrix-ui);
		font-size: 0.72rem;
		font-weight: 900;
		text-decoration: none;
		text-transform: uppercase;
	}

	.bisk-link:hover {
		background: var(--control-bg-hover);
	}

	.mini-card p {
		display: -webkit-box;
		overflow: hidden;
		line-clamp: 4;
		-webkit-line-clamp: 4;
		-webkit-box-orient: vertical;
		overflow-wrap: anywhere;
	}

	.setup-grid {
		display: grid;
		grid-template-columns: minmax(320px, 0.8fr) minmax(0, 1.2fr);
		gap: 16px;
		align-items: start;
		margin-top: 16px;
	}

	.empty-state,
	.empty-row {
		display: grid;
		place-items: center;
		min-height: 180px;
		color: var(--muted);
		border: 1px dashed var(--control-border);
		border-radius: 8px;
		background: var(--panel-bg-muted);
	}

	.empty-state.compact {
		min-height: 76px;
	}

	.empty-row {
		grid-column: 1 / -1;
		min-height: 164px;
	}

	.draft-list {
		display: grid;
		gap: 10px;
		max-height: 780px;
		overflow: auto;
		padding-right: 4px;
	}

	.draft-post {
		display: grid;
		gap: 8px;
		width: 100%;
		padding: 12px;
		border: 1px solid var(--control-border);
		border-radius: 8px;
		background: var(--card-bg);
		color: var(--text-ink);
		text-align: left;
	}

	.draft-post.selected {
		border-color: color-mix(in srgb, #3e8f55 68%, var(--control-border));
		background: color-mix(in srgb, #3e8f55 13%, var(--card-bg));
		box-shadow: 0 0 0 2px color-mix(in srgb, #3e8f55 16%, transparent);
	}

	.selected-stubs {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
		gap: 10px;
	}

	.selected-stubs article {
		display: grid;
		gap: 6px;
		padding: 12px;
		border: 1px solid var(--control-border);
		border-radius: 8px;
		background: var(--card-bg);
	}

	.selected-stubs span {
		color: var(--muted);
		font-family: var(--font-matrix-ui);
		font-size: 0.76rem;
		font-weight: 800;
		text-transform: uppercase;
	}

	.selected-stubs p {
		display: -webkit-box;
		overflow: hidden;
		line-clamp: 6;
		-webkit-line-clamp: 6;
		-webkit-box-orient: vertical;
		overflow-wrap: anywhere;
		white-space: pre-wrap;
	}

	.post-meta {
		display: flex;
		flex-wrap: wrap;
		justify-content: space-between;
		gap: 8px;
		color: var(--muted);
		font-family: var(--font-matrix-ui);
		font-size: 0.72rem;
		font-weight: 800;
	}

	.post-text {
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}

	.card-grid,
	.team-row {
		display: grid;
		grid-template-columns: repeat(5, minmax(148px, 1fr));
		gap: 10px;
	}

	.compact-cards {
		align-items: stretch;
	}

	.battle-card {
		position: relative;
		display: grid;
		grid-template-rows: auto minmax(98px, 1fr) auto auto;
		gap: 8px;
		min-width: 0;
		min-height: 236px;
		padding: 10px;
		border: 2px solid var(--border-color);
		border-radius: 8px;
		background: var(--card-bg);
		box-shadow: var(--shadow-soft);
		transition:
			transform 0.2s ease,
			opacity 0.2s ease,
			filter 0.2s ease,
			box-shadow 0.2s ease;
	}

	.battle-card header {
		display: grid;
		grid-template-columns: auto minmax(0, 1fr) auto;
		gap: 8px;
		align-items: center;
	}

	.battle-card header div:not(.avatar) {
		display: grid;
		min-width: 0;
	}

	.battle-card header b {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.battle-card header span:not(.level-badge) {
		color: var(--muted);
		font-family: var(--font-matrix-ui);
		font-size: 0.76rem;
		font-weight: 800;
		text-transform: uppercase;
	}

	.battle-card p {
		display: -webkit-box;
		overflow: hidden;
		line-clamp: 6;
		-webkit-line-clamp: 6;
		-webkit-box-orient: vertical;
		overflow-wrap: anywhere;
		white-space: pre-wrap;
	}

	.battle-card footer {
		display: grid;
		grid-template-columns: auto auto minmax(0, 1fr);
		gap: 8px;
		align-items: center;
	}

	.battle-card.active {
		transform: translateY(-5px);
		box-shadow: 0 14px 28px color-mix(in srgb, var(--text-ink) 18%, transparent);
	}

	.battle-card.fainted {
		filter: grayscale(0.82);
		opacity: 0.45;
		transform: scale(0.97);
	}

	.hero-card {
		background: linear-gradient(180deg, color-mix(in srgb, #63b45a 18%, var(--card-bg)), var(--card-bg));
	}

	.enemy-card {
		background: linear-gradient(180deg, color-mix(in srgb, #b65453 18%, var(--card-bg)), var(--card-bg));
	}

	.level-badge {
		display: inline-grid;
		place-items: center;
		min-width: 42px;
		min-height: 28px;
		padding: 3px 7px;
		border: 2px solid #3f2b18;
		border-radius: 999px;
		background: #f0b62f;
		color: #2b1b10;
		font-family: var(--font-matrix-ui);
		font-size: 0.78rem;
		font-weight: 950;
		text-shadow: 0 1px 0 rgba(255, 255, 255, 0.55);
	}

	.stat {
		display: inline-grid;
		place-items: center;
		min-width: 34px;
		min-height: 34px;
		padding: 5px;
		border: 2px solid #ffffff;
		font-family: var(--font-matrix-ui);
		font-weight: 950;
		box-shadow: 0 2px 0 rgba(0, 0, 0, 0.26);
	}

	.stat.attack {
		border-radius: 9px 9px 13px 13px;
		background: #e6e7e9;
		color: #24262b;
	}

	.stat.health {
		border-radius: 50%;
		background: #c7203e;
		color: #fff;
	}

	.stat.speed {
		justify-self: end;
		min-width: 0;
		border: 1px solid var(--control-border);
		border-radius: 999px;
		background: var(--muted-surface);
		box-shadow: none;
		color: var(--muted);
		font-size: 0.72rem;
	}

	.avatar {
		display: grid;
		place-items: center;
		width: 48px;
		height: 48px;
		overflow: hidden;
		border: 1px solid var(--control-border);
		border-radius: 50%;
		background: var(--muted-surface);
		font-family: var(--font-matrix-ui);
		font-weight: 900;
	}

	.small-avatar {
		width: 36px;
		height: 36px;
	}

	.avatar img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}

	.versus-board {
		display: grid;
		gap: 12px;
		padding: 14px;
		border: 2px solid var(--border-color);
		border-radius: 8px;
		background:
			linear-gradient(180deg, rgba(70, 147, 68, 0.2), rgba(70, 147, 68, 0) 38%),
			linear-gradient(0deg, rgba(159, 63, 72, 0.2), rgba(159, 63, 72, 0) 38%),
			var(--panel-bg-plain);
	}

	.team-banner {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 10px;
		border: 1px solid var(--control-border);
		border-radius: 8px;
		background: var(--panel-bg);
	}

	.team-banner div:not(.avatar) {
		display: grid;
	}

	.team-banner span {
		color: var(--muted);
	}

	.hero-banner {
		border-color: color-mix(in srgb, #3e8f55 54%, var(--control-border));
	}

	.enemy-banner {
		border-color: color-mix(in srgb, #9c3b4f 54%, var(--control-border));
	}

	.board-divider {
		display: grid;
		place-items: center;
		height: 34px;
		color: var(--muted);
		font-family: var(--font-matrix-ui);
		font-weight: 950;
		letter-spacing: 0;
	}

	.fight-summary,
	.balance-summary {
		margin: 4px 0;
		color: var(--muted);
		font-size: 1.05rem;
	}

	.balance-summary {
		font-family: var(--font-matrix-ui);
		font-size: 0.86rem;
		font-weight: 800;
	}

	.fight-log {
		display: grid;
		gap: 10px;
		max-height: 360px;
		overflow: auto;
		padding-right: 4px;
	}

	.log-entry {
		display: grid;
		gap: 4px;
		padding: 10px 12px;
		border: 1px solid var(--control-border);
		border-radius: 8px;
		background: var(--card-bg);
	}

	.log-entry.active {
		border-color: color-mix(in srgb, var(--accent) 62%, var(--control-border));
		background: color-mix(in srgb, var(--accent) 10%, var(--card-bg));
	}

	.log-entry span {
		overflow-wrap: anywhere;
	}

	.log-entry small {
		color: var(--muted);
		font-family: var(--font-matrix-ui);
	}

	.raw-output {
		overflow: auto;
		max-height: 420px;
		padding: 14px;
		border: 1px solid var(--control-border);
		border-radius: 8px;
		background: var(--card-bg);
		font-family: var(--font-matrix-ui);
		font-size: 0.82rem;
		white-space: pre-wrap;
	}

	@media (max-width: 1180px) {
		.mini-team,
		.card-grid,
		.team-row {
			grid-template-columns: repeat(auto-fit, minmax(168px, 1fr));
		}

		.setup-grid,
		.enemy-controls {
			grid-template-columns: 1fr;
		}
	}

	@media (max-width: 860px) {
		.control-strip,
		.gemini-key-panel {
			grid-template-columns: 1fr;
		}

		.title-row,
		.panel-heading {
			align-items: stretch;
			flex-direction: column;
		}

		.panel-actions {
			justify-content: flex-start;
		}
	}

	@media (max-width: 640px) {
		.super-page {
			width: min(100vw - 20px, 1440px);
			padding-top: 18px;
		}

		.battle-card {
			min-height: 220px;
		}

		.status-line {
			align-items: stretch;
			flex-direction: column;
		}
	}
</style>
