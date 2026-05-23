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

	type LoadState = 'idle' | 'generating' | 'error';
	type DuelSide = 'hero' | 'enemy';

	interface ChatMessage {
		role: 'user';
		content: string;
	}

	interface BattlePost {
		id: string;
		uri: string;
		text: string;
		createdAt?: string;
		authorHandle: string;
	}

	interface LlmRunInfo {
		phase: string;
		requestSource: string;
		modelId: string;
		requestedMaxTokens: number;
		effectiveMaxTokens: number | null;
		estimatedPromptTokens: number | null;
		messageCount: number;
		promptCharacters: number;
		temperature: number;
		topP: number;
		finishReason: string;
		outputCharacters: number | null;
		finalOutputCharacters: number | null;
		usagePromptTokens: number | null;
		usageCompletionTokens: number | null;
		usageTotalTokens: number | null;
		usageExtra: string;
		durationMs: number | null;
		error: string | null;
		rawResponse: string;
	}

	interface GeminiGenerateResponse {
		text?: string;
		model?: string;
		finishReason?: string;
		usageMetadata?: {
			promptTokenCount?: number;
			candidatesTokenCount?: number;
			totalTokenCount?: number;
			[key: string]: unknown;
		} | null;
		raw?: unknown;
		message?: string;
	}

	interface DuelEvent {
		id: string;
		speaker: DuelSide;
		target: DuelSide;
		postId: string;
		text: string;
		aspect: string;
		damage: number;
		reason: string;
		heroHpAfter: number;
		enemyHpAfter: number;
	}

	interface DuelResult {
		title: string;
		summary: string;
		winner: DuelSide | 'draw';
		events: DuelEvent[];
	}

	const SELECTION_LIMIT = 5;
	const DEFAULT_DRAFT_SIZE = 20;
	const ENEMY_SELECTION_COUNT = 5;
	const STARTING_HP = 100;
	const DUEL_STEP_MS = 1800;
	const DEFAULT_MAX_OUTPUT_TOKENS = 2048;
	const GEMINI_MODEL_ID = DEFAULT_THREAD_JUDGE_MODEL;
	const GEMINI_MODEL_LABEL = threadJudgeModelLabel(GEMINI_MODEL_ID).replace(' Preview', '');
	const GEMINI_KEY_STORAGE_KEY = 'threadviewer.autobattler.geminiApiKey';
	const fontFamilies: Record<string, string> = {
		virgil: "'Virgil', cursive",
		caveat: "'Caveat', cursive",
		patrick: "'Patrick Hand', cursive",
		'comic-neue': "'Comic Neue', cursive",
		inter: "'Inter', sans-serif",
		system: "system-ui, -apple-system, sans-serif"
	};
	const BATTLE_JUDGE_INSTRUCTIONS =
		'You are a dramatic but fair RPG battle judge. Be decisive and ground the result in the texts.';

	let initialHandle = $state('');
	let profile = $state<ProfileInfo | null>(null);
	let profileLoading = $state(false);
	let repoLoading = $state(false);
	let repoError = $state<string | null>(null);
	let enemyInitialHandle = $state('');
	let enemyProfile = $state<ProfileInfo | null>(null);
	let enemyProfileLoading = $state(false);
	let enemyRepoLoading = $state(false);
	let enemyRepoError = $state<string | null>(null);
	let llmError = $state<string | null>(null);
	let progress = $state<DiscoverProgress>({ phase: '', current: 0, total: 0 });
	let enemyProgress = $state<DiscoverProgress>({ phase: '', current: 0, total: 0 });
	let allPosts = $state<BattlePost[]>([]);
	let enemyAllPosts = $state<BattlePost[]>([]);
	let draftPosts = $state<BattlePost[]>([]);
	let enemyDraftPosts = $state<BattlePost[]>([]);
	let selectedIds = $state<string[]>([]);
	let minChars = $state(200);
	let draftSize = $state(DEFAULT_DRAFT_SIZE);
	let maxOutputTokens = $state(DEFAULT_MAX_OUTPUT_TOKENS);
	let frontendGeminiKey = $state('');
	let fontKey = $state('patrick');
	let showGeminiKey = $state(false);
	let abortController: AbortController | null = null;
	let enemyAbortController: AbortController | null = null;
	let duelPlaybackTimer: ReturnType<typeof setTimeout> | null = null;
	let duelStageElement: HTMLDivElement | null = null;

	let llmState = $state<LoadState>('idle');
	let llmProgress = $state(0);
	let llmText = $state(`${GEMINI_MODEL_LABEL} ready`);
	let debugOutput = $state('');
	let debugLabel = $state('');
	let rawDuelOutput = $state('');
	let duelTitle = $state('');
	let duelSummary = $state('');
	let duelWinner = $state<DuelSide | 'draw' | ''>('');
	let duelEvents = $state<DuelEvent[]>([]);
	let displayedDuelEvents = $state<DuelEvent[]>([]);
	let activeDuelIndex = $state(-1);
	let duelPlaying = $state(false);
	let heroHp = $state(STARTING_HP);
	let enemyHp = $state(STARTING_HP);
	let lastRunInfo = $state<LlmRunInfo | null>(null);

	const eligiblePosts = $derived(allPosts.filter((post) => post.text.length >= minChars));
	const eligibleEnemyPosts = $derived(enemyAllPosts.filter((post) => post.text.length >= minChars));
	const selectedPosts = $derived(draftPosts.filter((post) => selectedIds.includes(post.id)));
	const fontFamily = $derived(fontFamilies[fontKey] ?? fontFamilies.patrick);
	const canLoadRepo = $derived(Boolean(profile) && !repoLoading && !profileLoading);
	const canLoadEnemyRepo = $derived(Boolean(enemyProfile) && !enemyRepoLoading && !enemyProfileLoading);
	const canDraft = $derived(eligiblePosts.length > 0 && !repoLoading);
	const canDraftEnemy = $derived(eligibleEnemyPosts.length > 0 && !enemyRepoLoading);
	const canJudgeDuel = $derived(
		selectedPosts.length === SELECTION_LIMIT &&
			enemyDraftPosts.length === ENEMY_SELECTION_COUNT &&
			frontendGeminiKey.trim().length > 0 &&
			llmState !== 'generating'
	);

	function randomPostsFromPool(posts: BattlePost[], count: number): BattlePost[] {
		const pool = [...posts];
		for (let i = pool.length - 1; i > 0; i -= 1) {
			const j = Math.floor(Math.random() * (i + 1));
			[pool[i], pool[j]] = [pool[j], pool[i]];
		}
		return pool.slice(0, Math.min(count, pool.length));
	}

	function normalizeHandle(handle: string | null | undefined): string {
		return (handle ?? '').replace(/^@/, '').trim();
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

	function describeError(value: unknown): string {
		if (value instanceof Error) return value.message;
		if (typeof value === 'string') return value;
		return 'Something went wrong.';
	}

	function formatNumber(value: number | null | undefined): string {
		return typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString() : 'n/a';
	}

	function formatNullableDuration(value: number | null | undefined): string {
		return typeof value === 'number' && Number.isFinite(value) ? formatDuration(value) : 'n/a';
	}

	function clampHp(value: number): number {
		return Math.max(0, Math.min(STARTING_HP, Math.round(value)));
	}

	function clampDamage(value: unknown): number {
		const parsed = Math.round(Number(value));
		if (!Number.isFinite(parsed)) return 8;
		return Math.max(0, Math.min(35, parsed));
	}

	function sideLabel(side: DuelSide): string {
		return side === 'hero'
			? profile?.handle ? `@${profile.handle}` : 'Author'
			: enemyProfile?.handle ? `@${enemyProfile.handle}` : 'Enemy';
	}

	function sideProfile(side: DuelSide): ProfileInfo | null {
		return side === 'hero' ? profile : enemyProfile;
	}

	function sideAvatar(side: DuelSide): string {
		return sideProfile(side)?.avatar ?? '';
	}

	function sideInitial(side: DuelSide): string {
		const profileInfo = sideProfile(side);
		const source = profileInfo?.displayName || profileInfo?.handle || (side === 'hero' ? 'A' : 'E');
		return source.trim().charAt(0).toUpperCase() || (side === 'hero' ? 'A' : 'E');
	}

	function postBiskUrl(post: BattlePost): string | null {
		return buildBskyPostUrl(post.uri, post.authorHandle);
	}

	function duelEventBiskUrl(event: DuelEvent): string | null {
		const post = findRequestedPost(event.speaker, event.postId);
		return post ? postBiskUrl(post) : null;
	}

	function messageContentText(message: ChatMessage): string {
		return message.content;
	}

	function summarizeMessages(messages: ChatMessage[]) {
		return {
			messageCount: messages.length,
			promptCharacters: messages.reduce(
				(sum, message) => sum + messageContentText(message).length,
				0
			)
		};
	}

	function updateRunInfo(patch: Partial<LlmRunInfo>) {
		if (!lastRunInfo) return;
		lastRunInfo = { ...lastRunInfo, ...patch };
	}

	function formatRawResponse(value: unknown): string {
		try {
			const text = JSON.stringify(value, null, 2);
			return text.length > 20000 ? `${text.slice(0, 20000)}\n...truncated...` : text;
		} catch {
			return String(value);
		}
	}

	function readGeminiUsage(value: GeminiGenerateResponse) {
		const usage = value.usageMetadata;
		if (!usage) return;
		updateRunInfo({
			usagePromptTokens: usage.promptTokenCount ?? null,
			usageCompletionTokens: usage.candidatesTokenCount ?? null,
			usageTotalTokens: usage.totalTokenCount ?? null,
			usageExtra: formatRawResponse(usage)
		});
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

	function handleFontChange(key: string) {
		fontKey = key;
		try {
			localStorage.setItem('preferred-font', key);
		} catch {}
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

	function clearDuelPlayback() {
		if (duelPlaybackTimer) {
			clearTimeout(duelPlaybackTimer);
			duelPlaybackTimer = null;
		}
		duelPlaying = false;
	}

	function scrollDuelStageToEnd() {
		requestAnimationFrame(() => {
			duelStageElement?.scrollTo({
				top: duelStageElement.scrollHeight,
				behavior: 'smooth'
			});
		});
	}

	function resetDuelState() {
		clearDuelPlayback();
		rawDuelOutput = '';
		duelTitle = '';
		duelSummary = '';
		duelWinner = '';
		duelEvents = [];
		displayedDuelEvents = [];
		activeDuelIndex = -1;
		heroHp = STARTING_HP;
		enemyHp = STARTING_HP;
	}

	function resetDraftState() {
		draftPosts = [];
		selectedIds = [];
		debugOutput = '';
		debugLabel = '';
		resetDuelState();
	}

	function resetEnemyDraftState() {
		enemyDraftPosts = [];
		resetDuelState();
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
			enemyDraftPosts = randomPostsFromPool(
				nextPosts.filter((post) => post.text.length >= minChars),
				ENEMY_SELECTION_COUNT
			);
			resetDuelState();
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

	function draftPostsFromPool() {
		if (eligiblePosts.length === 0) return;
		const count = Math.max(5, Math.min(50, Math.round(Number(draftSize) || DEFAULT_DRAFT_SIZE)));
		draftSize = count;
		draftPosts = randomPostsFromPool(eligiblePosts, count);
		selectedIds = [];
		debugOutput = '';
		debugLabel = '';
		resetDuelState();
	}

	function draftEnemyPostsFromPool() {
		if (eligibleEnemyPosts.length === 0) return;
		enemyDraftPosts = randomPostsFromPool(eligibleEnemyPosts, ENEMY_SELECTION_COUNT);
		resetDuelState();
	}

	function handleMinCharsChange(event: Event) {
		const value = Number((event.currentTarget as HTMLInputElement).value);
		minChars = Math.max(1, Math.min(2000, Math.round(Number.isFinite(value) ? value : 200)));
		resetDraftState();
		resetEnemyDraftState();
	}

	function handleMaxOutputTokensChange(event: Event) {
		const value = Number((event.currentTarget as HTMLInputElement).value);
		maxOutputTokens = Math.max(
			128,
			Math.min(8192, Math.round(Number.isFinite(value) ? value : DEFAULT_MAX_OUTPUT_TOKENS))
		);
	}

	function togglePost(id: string) {
		let nextIds: string[];
		if (selectedIds.includes(id)) {
			nextIds = selectedIds.filter((selectedId) => selectedId !== id);
		} else {
			if (selectedIds.length >= SELECTION_LIMIT) return;
			nextIds = [...selectedIds, id];
		}

		selectedIds = nextIds;
		resetDuelState();
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
			throw new Error('Paste a Gemini API key before judging.');
		}

		const generationConfig: Record<string, unknown> = {
			temperature,
			topP,
			maxOutputTokens: maxTokens
		};
		if (responseMimeType) {
			generationConfig.responseMimeType = responseMimeType;
		}

		const response = await fetch(
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
				})
			}
		);
		const payload = await response.json().catch(() => null);
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
		maxTokens = 900,
		options: {
			temperature?: number;
			topP?: number;
			onDelta?: (delta: string) => void;
			onStatus?: (status: string) => void;
			responseMimeType?: 'application/json';
		} = {}
	): Promise<string> {
		const startedAt = performance.now();
		const temperature = options.temperature ?? 0.55;
		const topP = options.topP ?? 0.9;
		const summary = summarizeMessages(messages);
		const prompt = messages.map((message) => messageContentText(message).trim()).filter(Boolean).join('\n\n');
		const requestSource = 'browser Gemini API key';
		let failed = false;
		const estimatedPromptTokens =
			messages.reduce((sum, message) => {
				const content = messageContentText(message);
				return sum + Math.ceil(content.length / 4) + 16;
			}, 0) + 64;

		lastRunInfo = {
			phase: 'sending',
			requestSource,
			modelId: GEMINI_MODEL_ID,
			requestedMaxTokens: maxTokens,
			effectiveMaxTokens: maxTokens,
			estimatedPromptTokens,
			messageCount: summary.messageCount,
			promptCharacters: summary.promptCharacters,
			temperature,
			topP,
			finishReason: '',
			outputCharacters: null,
			finalOutputCharacters: null,
			usagePromptTokens: null,
			usageCompletionTokens: null,
			usageTotalTokens: null,
			usageExtra: '',
			durationMs: null,
			error: null,
			rawResponse: ''
		};

		llmState = 'generating';
		llmProgress = 0.45;
		llmText = `${GEMINI_MODEL_LABEL} is judging · ${maxTokens.toLocaleString()} out`;
		options.onStatus?.(
			`Sending ${estimatedPromptTokens.toLocaleString()} estimated prompt tokens to ${GEMINI_MODEL_LABEL} via ${requestSource}...`
		);

		try {
			const payload = await requestGeminiFromBrowser(
				prompt,
				maxTokens,
				temperature,
				topP,
				options.responseMimeType
			);
			const output = payload?.text ?? '';
			readGeminiUsage(payload ?? {});
			updateRunInfo({
				phase: 'done',
				requestSource,
				modelId: payload?.model || GEMINI_MODEL_ID,
				finishReason: payload?.finishReason || '',
				outputCharacters: output.length,
				finalOutputCharacters: output.trim().length,
				rawResponse: formatRawResponse(payload),
				durationMs: performance.now() - startedAt
			});
			options.onDelta?.(output);
			return output.trim();
		} catch (value) {
			failed = true;
			updateRunInfo({
				phase: 'error',
				error: describeError(value),
				durationMs: performance.now() - startedAt
			});
			throw value;
		} finally {
			llmState = failed ? 'error' : 'idle';
			llmProgress = failed ? 0 : 1;
			llmText = failed ? 'Gemini request failed' : `${GEMINI_MODEL_LABEL} ready`;
		}
	}

	function truncateForPrompt(text: string, limit = 1500): string {
		return text.length > limit ? `${text.slice(0, limit)}...` : text;
	}

	function buildDuelRoster(label: string, posts: BattlePost[]): string {
		return posts
			.map(
				(post, index) =>
					`${label}${index + 1}
ID: ${post.id}
AUTHOR: @${post.authorHandle}
TEXT:
${truncateForPrompt(post.text, 1100)}`
			)
			.join('\n\n---\n\n');
	}

	function buildAuthorDuelPrompt(): string {
		const heroHandle = profile?.handle ?? 'author';
		const enemyHandle = enemyProfile?.handle ?? 'enemy';
		const eventCount = selectedPosts.length + enemyDraftPosts.length;

		return `${BATTLE_JUDGE_INSTRUCTIONS}

Judge a text duel between two Bluesky authors.

Each event is one author speaking one exact post as an attack. The target loses HP because the speaker's post lands better on some textual aspect. The aspect can be anything relevant to the writing: rhetorical force, funniness, cleverness, a pun, timing, sincerity, vividness, weirdness, precision, surprise, elegance, or emotional damage.

Return one JSON object and nothing else.

Top-level keys:
- title: short fight title
- summary: one sentence summary of the matchup
- winner: "author", "enemy", or "draw"
- events: exactly ${eventCount} items

Each event must include:
- speaker: "author" or "enemy"
- target: "author" or "enemy"
- postId: exact ID of the post being spoken
- aspect: short phrase naming why the hit works
- damage: integer from 0 to 35
- reason: one sentence like "@${heroHandle} loses 10 HP because @${enemyHandle}'s pun is cleaner."

Rules:
- Start both authors at 100 HP.
- Alternate speakers as much as possible, starting with "author".
- Use every provided post exactly once.
- Never rewrite the posts. The UI will use the original post text as the speech bubble.
- The target should usually be the opposite author.
- Damage 0 means the post whiffs; 5-12 is light; 13-22 is strong; 23-35 is devastating.

AUTHOR = @${heroHandle}
${buildDuelRoster('A', selectedPosts)}

ENEMY = @${enemyHandle}
${buildDuelRoster('E', enemyDraftPosts)}`;
	}

	function normalizeDuelSide(value: unknown, fallback: DuelSide): DuelSide {
		const text = String(value ?? '')
			.trim()
			.toLowerCase()
			.replace(/^@/, '');
		const heroHandle = profile?.handle?.toLowerCase();
		const enemyHandle = enemyProfile?.handle?.toLowerCase();

		if (
			text === 'enemy' ||
			text === 'author2' ||
			text === 'opponent' ||
			text === 'challenger' ||
			text === 'e' ||
			(enemyHandle && text.includes(enemyHandle))
		) {
			return 'enemy';
		}

		if (
			text === 'author' ||
			text === 'author1' ||
			text === 'hero' ||
			text === 'player' ||
			text === 'a' ||
			(heroHandle && text.includes(heroHandle))
		) {
			return 'hero';
		}

		return fallback;
	}

	function sideForPostId(postId: string): DuelSide | null {
		if (selectedPosts.some((post) => post.id === postId || post.uri === postId)) return 'hero';
		if (enemyDraftPosts.some((post) => post.id === postId || post.uri === postId)) return 'enemy';
		return null;
	}

	function findRequestedPost(side: DuelSide, requestedId: string): BattlePost | null {
		const posts = side === 'hero' ? selectedPosts : enemyDraftPosts;
		return posts.find((post) => post.id === requestedId || post.uri === requestedId) ?? null;
	}

	function takeUnusedPost(side: DuelSide, requestedId: string, usedIds: Set<string>): BattlePost | null {
		const posts = side === 'hero' ? selectedPosts : enemyDraftPosts;
		const requested = requestedId ? findRequestedPost(side, requestedId) : null;
		if (requested) {
			usedIds.add(requested.id);
			return requested;
		}

		const next = posts.find((post) => !usedIds.has(post.id)) ?? posts[0] ?? null;
		if (next) usedIds.add(next.id);
		return next;
	}

	function normalizeDuelResult(value: unknown): DuelResult {
		const payload = Array.isArray(value) ? { events: value } : (value as any);
		const rawEvents = (
			Array.isArray(payload?.events)
				? payload.events
				: Array.isArray(payload?.turns)
					? payload.turns
					: Array.isArray(payload?.rounds)
						? payload.rounds
						: Array.isArray(payload?.conversation)
							? payload.conversation
							: []
		) as any[];

		if (rawEvents.length === 0) {
			throw new Error('Gemini returned JSON without duel events.');
		}

		const usedIds = new Set<string>();
		const events: DuelEvent[] = [];
		let nextFallbackSide: DuelSide = 'hero';
		let runningHeroHp = STARTING_HP;
		let runningEnemyHp = STARTING_HP;
		const maxEvents = Math.max(1, selectedPosts.length + enemyDraftPosts.length);

		for (const rawEvent of rawEvents.slice(0, maxEvents)) {
			const requestedId = String(
				rawEvent?.postId ?? rawEvent?.postID ?? rawEvent?.post_id ?? rawEvent?.id ?? rawEvent?.uri ?? ''
			).trim();
			const inferredSide = requestedId ? sideForPostId(requestedId) : null;
			const speaker = inferredSide ?? normalizeDuelSide(
				rawEvent?.speaker ?? rawEvent?.attacker ?? rawEvent?.author,
				nextFallbackSide
			);
			const post = takeUnusedPost(speaker, requestedId, usedIds);
			if (!post) continue;

			const defaultTarget: DuelSide = speaker === 'hero' ? 'enemy' : 'hero';
			const parsedTarget = normalizeDuelSide(
				rawEvent?.target ?? rawEvent?.defender ?? rawEvent?.damagedAuthor ?? rawEvent?.loser,
				defaultTarget
			);
			const target = parsedTarget === speaker ? defaultTarget : parsedTarget;
			const damage = clampDamage(rawEvent?.damage ?? rawEvent?.hpLoss ?? rawEvent?.hp_loss);
			if (target === 'hero') {
				runningHeroHp = clampHp(runningHeroHp - damage);
			} else {
				runningEnemyHp = clampHp(runningEnemyHp - damage);
			}

			events.push({
				id: `${events.length}-${post.id}`,
				speaker,
				target,
				postId: post.id,
				text: post.text,
				aspect:
					typeof rawEvent?.aspect === 'string' && rawEvent.aspect.trim()
						? rawEvent.aspect.trim()
						: 'textual hit',
				damage,
				reason:
					typeof rawEvent?.reason === 'string' && rawEvent.reason.trim()
						? rawEvent.reason.trim()
						: `${sideLabel(target)} loses ${damage} HP from ${sideLabel(speaker)}'s post.`,
				heroHpAfter: runningHeroHp,
				enemyHpAfter: runningEnemyHp
			});
			nextFallbackSide = speaker === 'hero' ? 'enemy' : 'hero';
		}

		const fallbackOrder: Array<{ side: DuelSide; post: BattlePost }> = [];
		const longest = Math.max(selectedPosts.length, enemyDraftPosts.length);
		for (let index = 0; index < longest; index += 1) {
			if (selectedPosts[index]) fallbackOrder.push({ side: 'hero', post: selectedPosts[index] });
			if (enemyDraftPosts[index]) fallbackOrder.push({ side: 'enemy', post: enemyDraftPosts[index] });
		}

		for (const { side, post } of fallbackOrder) {
			if (events.length >= maxEvents || usedIds.has(post.id)) continue;
			const target: DuelSide = side === 'hero' ? 'enemy' : 'hero';
			const damage = 8;
			if (target === 'hero') {
				runningHeroHp = clampHp(runningHeroHp - damage);
			} else {
				runningEnemyHp = clampHp(runningEnemyHp - damage);
			}
			events.push({
				id: `${events.length}-${post.id}`,
				speaker: side,
				target,
				postId: post.id,
				text: post.text,
				aspect: 'unresolved hit',
				damage,
				reason: `${sideLabel(target)} loses ${damage} HP because Gemini skipped this post, so it lands as a default jab.`,
				heroHpAfter: runningHeroHp,
				enemyHpAfter: runningEnemyHp
			});
		}

		if (events.length === 0) {
			throw new Error('Gemini returned no usable duel events.');
		}

		const computedWinner: DuelSide | 'draw' =
			runningHeroHp === runningEnemyHp ? 'draw' : runningHeroHp > runningEnemyHp ? 'hero' : 'enemy';
		const parsedWinner = normalizeDuelSide(payload?.winner, computedWinner === 'draw' ? 'hero' : computedWinner);
		const winner =
			String(payload?.winner ?? '').toLowerCase().includes('draw') ? 'draw' : parsedWinner;

		return {
			title: typeof payload?.title === 'string' && payload.title.trim() ? payload.title.trim() : 'Author Duel',
			summary:
				typeof payload?.summary === 'string' && payload.summary.trim()
					? payload.summary.trim()
					: `${sideLabel(winner === 'draw' ? 'hero' : winner)} ${winner === 'draw' ? 'forces a draw' : 'wins the exchange'}.`,
			winner,
			events
		};
	}

	function playDuelEvents(events: DuelEvent[] = duelEvents) {
		clearDuelPlayback();
		displayedDuelEvents = [];
		activeDuelIndex = -1;
		heroHp = STARTING_HP;
		enemyHp = STARTING_HP;

		if (events.length === 0) return;

		let index = 0;
		duelPlaying = true;
		const step = () => {
			const event = events[index];
			if (!event) {
				duelPlaying = false;
				duelPlaybackTimer = null;
				return;
			}
			displayedDuelEvents = [...displayedDuelEvents, event];
			activeDuelIndex = index;
			heroHp = event.heroHpAfter;
			enemyHp = event.enemyHpAfter;
			scrollDuelStageToEnd();
			index += 1;
			duelPlaybackTimer = setTimeout(step, DUEL_STEP_MS);
		};

		duelPlaybackTimer = setTimeout(step, 250);
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

		throw new Error('The model did not return JSON.');
	}

	async function judgeAuthorDuel() {
		if (!canJudgeDuel) return;
		llmError = null;
		resetDuelState();
		rawDuelOutput = '';
		debugOutput = '';
		debugLabel = 'Gemini duel response';

		try {
			const output = await runGeminiChat(
				[{ role: 'user', content: buildAuthorDuelPrompt() }],
				maxOutputTokens,
				{
					temperature: 0.45,
					topP: 0.9,
					responseMimeType: 'application/json',
					onDelta: (delta) => {
						debugOutput += delta;
						rawDuelOutput = debugOutput;
					},
					onStatus: (status) => {
						debugOutput = debugOutput ? `${debugOutput}\n\n[status] ${status}` : `[status] ${status}`;
						rawDuelOutput = debugOutput;
					}
				}
			);
			rawDuelOutput = output;
			debugOutput = output;
			debugLabel = 'Raw duel response';
			const normalized = normalizeDuelResult(extractJsonObject(output));
			duelTitle = normalized.title;
			duelSummary = normalized.summary;
			duelWinner = normalized.winner;
			duelEvents = normalized.events;
			playDuelEvents(normalized.events);
		} catch (value) {
			llmError = describeError(value);
		}
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
		if (handle) {
			initialHandle = handle;
			void selectHandle(handle);
		}
	});

	onDestroy(() => {
		abortController?.abort();
		enemyAbortController?.abort();
		clearDuelPlayback();
	});
</script>

<svelte:head>
	<title>Autobattler</title>
</svelte:head>

<main class="autobattler-page" style="font-family: {fontFamily}; --font-hand: {fontFamily};">
	<header class="page-header">
		<RouteNav current="autobattler" align="center" handle={profile?.handle ?? null} />
		<div class="title-row">
			<div>
				<p class="eyebrow">PDS CAR Arena</p>
				<h1>Autobattler</h1>
			</div>
			<div class="referee-status" class:ready={llmState === 'idle'} class:error={llmState === 'error'}>
				<span>{llmText}</span>
				<div class="progress-track" aria-label="Gemini request progress">
					<div class="progress-fill" style:width={`${Math.round(llmProgress * 100)}%`}></div>
				</div>
			</div>
		</div>
		<div class="header-tools">
			<FontPicker value={fontKey} onchange={handleFontChange} />
		</div>
	</header>

	<section class="control-strip" aria-label="Draft controls">
		<div class="search-cell">
			<SearchBar
				onsearch={selectHandle}
				onprofile={handleProfileSelected}
				disabled={profileLoading || repoLoading}
				{initialHandle}
				placeholder="Search for a Bluesky account..."
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
			<span>Draft Size</span>
			<input type="number" min="5" max="50" step="1" bind:value={draftSize} />
		</label>

		<label>
			<span>Output Tokens</span>
			<input
				type="number"
				min="128"
				max="8192"
				step="128"
				value={maxOutputTokens}
				onchange={handleMaxOutputTokensChange}
			/>
		</label>

		<button type="button" class="primary-button wobbly-border" disabled={!canLoadRepo} onclick={loadRepo}>
			Load CAR
		</button>
		<button type="button" class="primary-button wobbly-border" disabled={!canDraft} onclick={draftPostsFromPool}>
			Draft
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
		<span class:ready={frontendGeminiKey.trim().length > 0}>
			{frontendGeminiKey.trim() ? 'browser API key active' : 'browser API key required'}
		</span>
	</section>

	<section class="status-line" aria-live="polite">
		<div>
			<b>{profile ? `@${profile.handle}` : 'No account selected'}</b>
			<span>{allPosts.length.toLocaleString()} posts loaded</span>
			<span>{eligiblePosts.length.toLocaleString()} eligible</span>
			<span>{selectedPosts.length} selected · target {SELECTION_LIMIT}</span>
		</div>
		<div>
			<span>{GEMINI_MODEL_LABEL}</span>
			<span>{maxOutputTokens.toLocaleString()} out</span>
			<span>browser API key only</span>
		</div>
	</section>

	{#if repoError}
		<ErrorBanner message={repoError} />
	{/if}
	{#if llmError}
		<ErrorBanner message={llmError} />
	{/if}
	{#if repoLoading}
		<LoadingSpinner {progress} />
	{/if}
	{#if enemyRepoError}
		<ErrorBanner message={enemyRepoError} />
	{/if}
	{#if enemyRepoLoading}
		<LoadingSpinner progress={enemyProgress} />
	{/if}

	<section class="enemy-panel" aria-label="Enemy author controls">
		<div class="panel-heading">
			<div>
				<h2>Enemy PDS</h2>
				<span>
					{enemyProfile ? `@${enemyProfile.handle}` : 'No enemy selected'} ·
					{enemyAllPosts.length.toLocaleString()} loaded ·
					{enemyDraftPosts.length} rolled
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
					disabled={!canDraftEnemy}
					onclick={draftEnemyPostsFromPool}
				>
					Roll 5 Posts
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
			<div class="enemy-roster-preview">
				{#if enemyDraftPosts.length === 0}
					<div class="empty-state compact">Roll an enemy squad</div>
				{:else}
					{#each enemyDraftPosts as post, index (post.id)}
						<article class="mini-post-card">
							<header>
								<b>E{index + 1}</b>
								<span>{post.text.length.toLocaleString()} chars</span>
								{#if postBiskUrl(post)}
									<a class="bisk-link" href={postBiskUrl(post)} target="_blank" rel="noreferrer">Open Bisk</a>
								{/if}
							</header>
							<p>{post.text}</p>
						</article>
					{/each}
				{/if}
			</div>
		</div>
	</section>

	<div class="arena-grid">
		<section class="draft-panel" aria-label="Drafted posts">
			<div class="panel-heading">
				<h2>Draft Pool</h2>
				<span>Select exactly {SELECTION_LIMIT} posts for the duel</span>
			</div>

			{#if draftPosts.length === 0}
				<div class="empty-state">No draft yet</div>
			{:else}
				<div class="draft-list">
					{#each draftPosts as post, index (post.id)}
						<button
							type="button"
							class="post-card"
							class:selected={selectedIds.includes(post.id)}
							disabled={!selectedIds.includes(post.id) && selectedIds.length >= SELECTION_LIMIT}
							onclick={() => togglePost(post.id)}
						>
							<span class="post-meta">
								<span>#{index + 1}</span>
								<span>{post.text.length.toLocaleString()} chars</span>
							</span>
							<span class="post-text">{post.text}</span>
						</button>
					{/each}
				</div>
			{/if}
		</section>
	</div>

	<section class="duel-panel" aria-label="Author duel">
		<div class="panel-heading">
			<div>
				<h2>{duelTitle || 'Author Duel'}</h2>
				<span>
					{selectedPosts.length} author posts vs {enemyDraftPosts.length} enemy posts
					{#if duelWinner}
						· Winner: {duelWinner === 'draw' ? 'Draw' : sideLabel(duelWinner)}
					{/if}
				</span>
			</div>
			<div class="panel-actions">
				<button
					type="button"
					class="primary-button wobbly-border"
					disabled={!canJudgeDuel}
					onclick={judgeAuthorDuel}
				>
					Judge Duel
				</button>
				<button
					type="button"
					class="secondary-button wobbly-border-light"
					disabled={duelEvents.length === 0 || duelPlaying}
					onclick={() => playDuelEvents()}
				>
					Replay
				</button>
			</div>
		</div>

		<div class="fighters">
			<article class="fighter-card hero">
				<div class="fighter-top">
					<div class="avatar">
						{#if sideAvatar('hero')}
							<img src={sideAvatar('hero')} alt="" />
						{:else}
							<span>{sideInitial('hero')}</span>
						{/if}
					</div>
					<div>
						<b>{sideLabel('hero')}</b>
						<span>{selectedPosts.length} selected</span>
					</div>
					<strong>{heroHp} HP</strong>
				</div>
				<div class="health-track">
					<div class="health-fill" style:width={`${heroHp}%`}></div>
				</div>
			</article>

			<article class="fighter-card enemy">
				<div class="fighter-top">
					<div class="avatar">
						{#if sideAvatar('enemy')}
							<img src={sideAvatar('enemy')} alt="" />
						{:else}
							<span>{sideInitial('enemy')}</span>
						{/if}
					</div>
					<div>
						<b>{sideLabel('enemy')}</b>
						<span>{enemyDraftPosts.length} rolled</span>
					</div>
					<strong>{enemyHp} HP</strong>
				</div>
				<div class="health-track">
					<div class="health-fill enemy-fill" style:width={`${enemyHp}%`}></div>
				</div>
			</article>
		</div>

		{#if duelSummary}
			<p class="duel-summary">{duelSummary}</p>
		{/if}

		<div class="duel-stage" bind:this={duelStageElement}>
			{#if displayedDuelEvents.length === 0}
				<div class="empty-state compact">Judge a duel to animate the exchange</div>
			{:else}
				{#each displayedDuelEvents as event, index (event.id)}
					<article
						class="duel-bubble"
						class:hero={event.speaker === 'hero'}
						class:enemy={event.speaker === 'enemy'}
						class:active={index === activeDuelIndex}
					>
						<div class="avatar small">
							{#if sideAvatar(event.speaker)}
								<img src={sideAvatar(event.speaker)} alt="" />
							{:else}
								<span>{sideInitial(event.speaker)}</span>
							{/if}
						</div>
						<div class="speech-bubble">
							<header>
								<b>{sideLabel(event.speaker)}</b>
								<span>-{event.damage} HP to {sideLabel(event.target)} · {event.aspect}</span>
							</header>
							<p>{event.text}</p>
							<footer>
								<span>{event.reason}</span>
								{#if duelEventBiskUrl(event)}
									<a class="bisk-link" href={duelEventBiskUrl(event)} target="_blank" rel="noreferrer">Open Bisk</a>
								{/if}
							</footer>
						</div>
					</article>
				{/each}
			{/if}
		</div>
	</section>

	<section class="diagnostics-panel" aria-label="Gemini run information">
		<div class="panel-heading">
			<h2>Run Info</h2>
			<span>{lastRunInfo?.phase ?? llmState}</span>
		</div>
		<div class="diagnostics-grid">
			<article>
				<span>Model</span>
				<b>{lastRunInfo?.modelId ?? GEMINI_MODEL_ID}</b>
			</article>
			<article>
				<span>Request Source</span>
				<b>{lastRunInfo?.requestSource ?? 'browser Gemini API key'}</b>
			</article>
			<article>
				<span>Requested Output</span>
				<b>{formatNumber(lastRunInfo?.requestedMaxTokens ?? maxOutputTokens)}</b>
			</article>
			<article>
				<span>Effective Output</span>
				<b>{formatNumber(lastRunInfo?.effectiveMaxTokens)}</b>
			</article>
			<article>
				<span>Estimated Prompt</span>
				<b>{formatNumber(lastRunInfo?.estimatedPromptTokens)}</b>
			</article>
			<article>
				<span>Messages / Chars</span>
				<b>{formatNumber(lastRunInfo?.messageCount)} / {formatNumber(lastRunInfo?.promptCharacters)}</b>
			</article>
			<article>
				<span>Temperature / Top P</span>
				<b>{lastRunInfo ? `${lastRunInfo.temperature} / ${lastRunInfo.topP}` : 'n/a'}</b>
			</article>
			<article>
				<span>Finish</span>
				<b>{lastRunInfo?.finishReason || 'n/a'}</b>
			</article>
			<article>
				<span>Output Chars</span>
				<b>{formatNumber(lastRunInfo?.outputCharacters)}</b>
			</article>
			<article>
				<span>Final Chars</span>
				<b>{formatNumber(lastRunInfo?.finalOutputCharacters)}</b>
			</article>
			<article>
				<span>Usage Tokens</span>
				<b>
					{formatNumber(lastRunInfo?.usagePromptTokens)} in ·
					{formatNumber(lastRunInfo?.usageCompletionTokens)} out ·
					{formatNumber(lastRunInfo?.usageTotalTokens)} total
				</b>
			</article>
			<article>
				<span>Duration</span>
				<b>{formatNullableDuration(lastRunInfo?.durationMs)}</b>
			</article>
			<article>
				<span>Error</span>
				<b>{lastRunInfo?.error ?? llmError ?? 'none'}</b>
			</article>
		</div>
		{#if lastRunInfo?.usageExtra}
			<details class="raw-details">
				<summary>Usage Extra</summary>
				<pre class="raw-output">{lastRunInfo.usageExtra}</pre>
			</details>
		{/if}
		{#if lastRunInfo?.rawResponse}
			<details class="raw-details">
				<summary>Raw Gemini Response</summary>
				<pre class="raw-output">{lastRunInfo.rawResponse}</pre>
			</details>
		{/if}
	</section>

	{#if debugOutput}
		<section class="debug-panel" aria-label="Model debug output">
			<div class="panel-heading">
				<h2>Debug</h2>
				<span>{debugLabel}</span>
			</div>
			<pre class="raw-output">{debugOutput}</pre>
		</section>
	{/if}
</main>

<style>
	.autobattler-page {
		width: min(1320px, calc(100vw - 32px));
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
		font-weight: 700;
		letter-spacing: 0;
		text-transform: uppercase;
	}

	h1 {
		font-size: clamp(2.7rem, 8vw, 5.8rem);
		line-height: 0.92;
		letter-spacing: 0;
	}

	h2 {
		letter-spacing: 0;
		line-height: 1.05;
	}

	.referee-status {
		display: grid;
		gap: 8px;
		min-width: min(340px, 100%);
		padding: 12px;
		border: 1px solid var(--control-border);
		border-radius: 8px;
		background: var(--panel-bg-plain);
		box-shadow: var(--shadow-soft);
	}

	.referee-status span {
		font-weight: 800;
	}

	.referee-status.ready span {
		color: #237466;
	}

	.referee-status.error span {
		color: var(--danger-text);
	}

	.progress-track {
		overflow: hidden;
		border: 1px solid var(--control-border);
		border-radius: 999px;
		background: var(--muted-surface);
	}

	.progress-track {
		height: 10px;
	}

	.progress-fill {
		height: 100%;
		background: linear-gradient(90deg, #237466, var(--accent));
		transition: width 0.2s ease;
	}

	.control-strip,
	.gemini-key-panel,
	.status-line,
	.enemy-panel,
	.draft-panel,
	.duel-panel,
	.debug-panel {
		border: 1px solid var(--control-border);
		border-radius: 8px;
		background: var(--panel-bg);
		box-shadow: var(--shadow-soft);
	}

	.control-strip {
		display: grid;
		grid-template-columns: minmax(260px, 1.5fr) repeat(3, minmax(112px, 160px)) auto auto;
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
		border: 1px solid var(--control-border);
		border-radius: 8px;
		background: var(--input-bg);
		color: var(--text-ink);
		font-family: inherit;
		font-size: 1rem;
		line-height: 1.4;
		min-height: 42px;
		padding: 8px 10px;
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

	.arena-grid {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 16px;
		align-items: start;
	}

	.draft-panel,
	.enemy-panel,
	.duel-panel,
	.debug-panel {
		padding: 16px;
	}

	.enemy-panel,
	.duel-panel {
		display: grid;
		gap: 12px;
		margin-top: 16px;
	}

	.enemy-controls {
		display: grid;
		grid-template-columns: minmax(260px, 0.8fr) minmax(0, 1.2fr);
		gap: 12px;
		align-items: start;
	}

	.enemy-roster-preview {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
		gap: 10px;
	}

	.mini-post-card {
		display: grid;
		gap: 8px;
		padding: 10px;
		border: 1px solid var(--control-border);
		border-radius: 8px;
		background: var(--card-bg);
	}

	.mini-post-card header {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		font-family: var(--font-matrix-ui);
		font-size: 0.78rem;
	}

	.mini-post-card span {
		color: var(--muted);
	}

	.mini-post-card p {
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}

	.bisk-link {
		display: inline-flex;
		align-items: center;
		justify-content: center;
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
		text-align: right;
	}

	.panel-actions {
		display: flex;
		flex-wrap: wrap;
		justify-content: flex-end;
		gap: 8px;
	}

	.empty-state {
		display: grid;
		place-items: center;
		min-height: 220px;
		color: var(--muted);
		border: 1px dashed var(--control-border);
		border-radius: 8px;
		background: var(--panel-bg-muted);
	}

	.empty-state.compact {
		min-height: 78px;
	}

	.draft-list {
		display: grid;
		gap: 10px;
		max-height: 780px;
		overflow: auto;
		padding-right: 4px;
	}

	.post-card {
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

	.post-card.selected {
		border-color: color-mix(in srgb, var(--accent) 68%, var(--control-border));
		background: color-mix(in srgb, var(--accent) 14%, var(--card-bg));
		box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 16%, transparent);
	}

	.post-meta {
		display: flex;
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

	.fighters {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 12px;
	}

	.fighter-card {
		display: grid;
		gap: 10px;
		padding: 12px;
		border: 1px solid var(--control-border);
		border-radius: 8px;
		background: var(--card-bg);
	}

	.fighter-card.enemy {
		background: color-mix(in srgb, #8a2f47 8%, var(--card-bg));
	}

	.fighter-top {
		display: grid;
		grid-template-columns: auto minmax(0, 1fr) auto;
		gap: 10px;
		align-items: center;
	}

	.fighter-top div:not(.avatar) {
		display: grid;
		gap: 2px;
		min-width: 0;
	}

	.fighter-top span,
	.duel-summary {
		color: var(--muted);
	}

	.speech-bubble footer {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
	}

	.speech-bubble footer span {
		color: var(--muted);
	}

	.fighter-top strong {
		font-family: var(--font-matrix-ui);
		font-size: 1.1rem;
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

	.avatar.small {
		width: 38px;
		height: 38px;
		flex: 0 0 auto;
	}

	.avatar img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}

	.health-track {
		overflow: hidden;
		height: 14px;
		border: 1px solid var(--control-border);
		border-radius: 999px;
		background: color-mix(in srgb, var(--muted-surface) 78%, #8a2f47);
	}

	.health-fill {
		height: 100%;
		background: linear-gradient(90deg, #237466, #95c84c);
		transition: width 0.45s ease;
	}

	.health-fill.enemy-fill {
		background: linear-gradient(90deg, #8a2f47, var(--accent));
	}

	.duel-stage {
		display: grid;
		gap: 12px;
		min-height: 220px;
		max-height: min(58vh, 680px);
		overflow-y: auto;
		padding-right: 4px;
		scroll-behavior: smooth;
	}

	.duel-bubble {
		display: flex;
		gap: 10px;
		align-items: flex-start;
		max-width: min(760px, 100%);
		opacity: 0.72;
		transform: translateY(4px);
		transition:
			opacity 0.2s ease,
			transform 0.2s ease;
	}

	.duel-bubble.enemy {
		justify-self: end;
		flex-direction: row-reverse;
	}

	.duel-bubble.active {
		opacity: 1;
		transform: translateY(0);
	}

	.speech-bubble {
		display: grid;
		gap: 8px;
		padding: 12px;
		border: 1px solid var(--control-border);
		border-radius: 8px;
		background: var(--card-bg);
		box-shadow: var(--shadow-soft);
	}

	.duel-bubble.enemy .speech-bubble {
		background: color-mix(in srgb, #8a2f47 9%, var(--card-bg));
	}

	.speech-bubble header {
		display: flex;
		flex-wrap: wrap;
		justify-content: space-between;
		gap: 8px;
		font-family: var(--font-matrix-ui);
	}

	.speech-bubble header span {
		color: var(--danger-text);
		font-size: 0.78rem;
		font-weight: 900;
		text-transform: uppercase;
	}

	.speech-bubble p {
		white-space: pre-wrap;
	}

	.diagnostics-panel {
		margin-top: 16px;
	}

	.diagnostics-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
		gap: 10px;
	}

	.diagnostics-grid article {
		display: grid;
		gap: 6px;
		padding: 12px;
		border: 1px solid var(--control-border);
		border-radius: 8px;
		background: var(--card-bg);
		min-width: 0;
	}

	.diagnostics-grid span,
	.raw-details summary {
		color: var(--muted);
		font-family: var(--font-matrix-ui);
		font-size: 0.76rem;
		text-transform: uppercase;
		letter-spacing: 0.06em;
	}

	.diagnostics-grid b {
		overflow-wrap: anywhere;
		font-size: 0.92rem;
	}

	.raw-details {
		margin-top: 10px;
	}

	.raw-details summary {
		cursor: pointer;
	}

	.debug-panel {
		margin-top: 16px;
	}

	.raw-output {
		padding: 14px;
		border: 1px solid var(--control-border);
		border-radius: 8px;
		background: var(--card-bg);
		white-space: pre-wrap;
	}

	.raw-output {
		overflow: auto;
		font-family: var(--font-matrix-ui);
		font-size: 0.82rem;
	}

	@media (max-width: 980px) {
		.control-strip,
		.gemini-key-panel,
		.arena-grid,
		.enemy-controls,
		.fighters {
			grid-template-columns: 1fr;
		}

		.title-row {
			align-items: stretch;
			flex-direction: column;
		}
	}

	@media (max-width: 640px) {
		.autobattler-page {
			width: min(100vw - 20px, 1320px);
			padding-top: 18px;
		}

		.status-line,
		.panel-heading {
			align-items: stretch;
			flex-direction: column;
		}
	}
</style>
