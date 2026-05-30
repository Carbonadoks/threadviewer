<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { browser } from '$app/environment';
	import '../../app.css';
	import FontPicker from '$lib/components/FontPicker.svelte';
	import RouteNav from '$lib/components/RouteNav.svelte';
	import { getProfiles, type ProfileInfo } from '$lib/api/bluesky';
	import { openLightbox } from '$lib/stores/lightbox';
	import { buildAtUri, buildBskyPostUrl } from '$lib/utils/viewerLinks';

	type ModelState = 'idle' | 'checking' | 'loading' | 'ready' | 'error';
	type StreamStatus = 'idle' | 'connecting' | 'live' | 'closed' | 'error';
	type Availability = 'available' | 'downloadable' | 'downloading' | 'unavailable' | string;

	type PromptMessage = {
		role: 'system' | 'user' | 'assistant';
		content: string;
		prefix?: boolean;
	};

	type PromptSession = EventTarget & {
		prompt: (
			input: string | PromptMessage[],
			options?: {
				signal?: AbortSignal;
				responseConstraint?: unknown;
				omitResponseConstraintInput?: boolean;
			}
		) => Promise<string>;
		destroy?: () => void;
		contextUsage?: number;
		contextWindow?: number;
	};

	type PromptFactory = {
		availability: (options?: Record<string, unknown>) => Promise<Availability>;
		create: (options?: Record<string, unknown>) => Promise<PromptSession>;
	};

	type LanguageDetectionResult = {
		detectedLanguage: string;
		confidence: number;
	};

	type LanguageDetectorSession = {
		detect: (
			input: string,
			options?: {
				signal?: AbortSignal;
			}
		) => Promise<LanguageDetectionResult[]>;
		destroy?: () => void;
		inputQuota?: number;
		measureInputUsage?: (input: string) => Promise<number>;
	};

	type LanguageDetectorFactory = {
		availability: (options?: Record<string, unknown>) => Promise<Availability>;
		create: (options?: Record<string, unknown>) => Promise<LanguageDetectorSession>;
	};

	type FirehoseImage = {
		id: string;
		thumb: string;
		fullsize: string;
		alt: string;
		aspectRatio: string;
	};

	type QueuedPost = {
		id: string;
		uri: string;
		cid: string;
		did: string;
		rkey: string;
		text: string;
		createdAt: string;
		queuedAt: string;
		images: FirehoseImage[];
		tags: string[];
		links: string[];
		langs: string[];
		labels: string[];
		replyParentUri: string | null;
		hasEmbed: boolean;
	};

	type ClassifierDecision = {
		keep: boolean;
		answer: 'YES' | 'NO' | 'ERROR';
		confidence: number;
		description: string;
		error?: string;
	};

	type ClassifiedPost = {
		post: QueuedPost;
		decision: ClassifierDecision;
		raw: string;
		processedAt: string;
	};

	type ClassifierRecord = Record<string, unknown>;

	type JetstreamEvent = {
		did?: string;
		kind?: string;
		time_us?: number | string;
		commit?: {
			operation?: string;
			collection?: string;
			rkey?: string;
			cid?: string;
			record?: any;
		};
	};

	const JETSTREAM_URLS = [
		'wss://jetstream2.us-east.bsky.network/subscribe',
		'wss://jetstream1.us-east.bsky.network/subscribe',
		'wss://jetstream2.us-west.bsky.network/subscribe',
		'wss://jetstream1.us-west.bsky.network/subscribe'
	];
	const STORAGE_PROMPT_KEY = 'firehose-filtered-prompt-template';
	const STORAGE_FONT_KEY = 'preferred-font';
	const MAX_QUEUE_SIZE = 180;
	const MAX_ACCEPTED_POSTS = 140;
	const MAX_REJECTED_POSTS = 80;
	const MAX_SEEN_URIS = 1200;
	const MAX_PROMPT_TEXT_LENGTH = 1200;
	const PROFILE_BATCH_DELAY_MS = 220;
	const LIVE_CURSOR_REWIND_US = 12_000_000;
	const MODEL_DOWNLOAD_HINT_MS = 20_000;
	const CLASSIFIER_DESCRIPTION_LIMIT = 100;
	const DEFAULT_CLASSIFIER_BATCH_SIZE = 6;
	const MAX_CLASSIFIER_BATCH_SIZE = 10;
	const CLASSIFIER_BATCH_WAIT_MS = 160;
	const MAX_BATCH_PROMPT_TEXT_LENGTH = 600;
	const CLASSIFIER_BATCH_SCHEMA = {
		type: 'object',
		properties: {
			posts: {
				type: 'array',
				items: {
					type: 'object',
					properties: {
						id: { type: 'string' },
						description: { type: 'string', maxLength: CLASSIFIER_DESCRIPTION_LIMIT }
					},
					required: ['id', 'description'],
					additionalProperties: false
				}
			}
		},
		required: ['posts'],
		additionalProperties: false
	};

	const MODEL_OPTIONS = {
		expectedInputs: [{ type: 'text', languages: ['en'] }],
		expectedOutputs: [{ type: 'text', languages: ['en'] }]
	};
	const LANGUAGE_DETECTOR_OPTIONS = {
		expectedInputLanguages: ['en']
	};
	const ENGLISH_CONFIDENCE_THRESHOLD = 0.9;

	const SYSTEM_PROMPT =
		'You filter batches of public Bluesky Jetstream posts for a live personal feed. Return JSON with only the posts that should be shown.';

	const DEFAULT_PROMPT_TEMPLATE = `Wanted classes:
- Concrete builds, demos, tools, visual experiments, or prototypes.
- Posts with a specific observation, field note, research finding, or technical detail.
- Thoughtful questions that could start a useful discussion.
- Weird, poetic, or unusually well-phrased posts with real substance.

Skip:
- Engagement bait, generic outrage, pure dunking, scams, giveaways, ads, and low-context replies.
- Adult, graphic, hateful, or harassment-heavy posts.
- Posts that only say good morning, lol, same, or quote without context.`;

	const fontFamilies: Record<string, string> = {
		virgil: "'Virgil', cursive",
		caveat: "'Caveat', cursive",
		patrick: "'Patrick Hand', cursive",
		'comic-neue': "'Comic Neue', cursive",
		inter: "'Inter', sans-serif",
		system: "system-ui, -apple-system, sans-serif"
	};

	let fontKey = $state('patrick');
	let promptTemplate = $state(DEFAULT_PROMPT_TEMPLATE);
	let templateSavedAt: string | null = $state(null);
	let modelState = $state<ModelState>('idle');
	let modelStatus = $state('Model not loaded');
	let modelProgress = $state(0);
	let modelProgressIndeterminate = $state(false);
	let modelHint: string | null = $state(null);
	let modelError: string | null = $state(null);
	let availability: Availability | null = $state(null);
	let languageState = $state<ModelState>('idle');
	let languageStatus = $state('Language detector not loaded');
	let languageAvailability: Availability | null = $state(null);
	let languageError: string | null = $state(null);
	let streamStatus = $state<StreamStatus>('idle');
	let streamStatusText = $state('Idle');
	let streamError: string | null = $state(null);
	let pendingPosts = $state<QueuedPost[]>([]);
	let currentBatchPosts = $state<QueuedPost[]>([]);
	let acceptedPosts = $state<ClassifiedPost[]>([]);
	let rejectedPosts = $state<ClassifiedPost[]>([]);
	let postsAccepted = $state(0);
	let postsRejected = $state(0);
	let postsSeen = $state(0);
	let postsQueued = $state(0);
	let postsDropped = $state(0);
	let postsSkipped = $state(0);
	let textOnlySkipped = $state(0);
	let imageSkipped = $state(0);
	let languageSkipped = $state(0);
	let postsProcessed = $state(0);
	let promptFailures = $state(0);
	let batchSize = $state(DEFAULT_CLASSIFIER_BATCH_SIZE);
	let queuePaused = $state(false);
	let isClassifying = $state(false);
	let endpointIndex = 0;
	let profilesByDid = $state<Record<string, ProfileInfo>>({});

	let modelSession: PromptSession | null = null;
	let languageDetector: LanguageDetectorSession | null = null;
	let modelAbortController: AbortController | null = null;
	let promptAbortController: AbortController | null = null;
	let socket: WebSocket | null = null;
	let drainScheduled = false;
	let drainTimer: ReturnType<typeof setTimeout> | null = null;
	let profileBatchTimer: ReturnType<typeof setTimeout> | null = null;
	let modelDownloadHintTimer: ReturnType<typeof setTimeout> | null = null;
	const pendingProfileDids = new Set<string>();
	const seenUris: string[] = [];
	const seenUriSet = new Set<string>();

	const fontFamily = $derived(fontFamilies[fontKey] ?? fontFamilies.patrick);
	const canLoadModel = $derived(modelState !== 'checking' && modelState !== 'loading');
	const canStartFirehose = $derived(
		modelState === 'ready' &&
			languageState === 'ready' &&
			streamStatus !== 'connecting' &&
			streamStatus !== 'live'
	);
	const promptClasses = $derived(
		promptTemplate
			.split('\n')
			.map((line) => line.replace(/^[-*\s]+/, '').trim())
			.filter(Boolean)
			.slice(0, 12)
	);
	const queuePreview = $derived(pendingPosts.slice(0, 16));
	const acceptedCount = $derived(postsAccepted);
	const rejectedCount = $derived(postsRejected);
	const acceptanceRate = $derived(
		postsProcessed > 0 ? Math.round((acceptedCount / postsProcessed) * 100) : 0
	);

	function handleFontChange(key: string) {
		fontKey = key;
		try {
			localStorage.setItem(STORAGE_FONT_KEY, key);
		} catch {}
	}

	function describeError(value: unknown): string {
		if (value instanceof Error) return value.message;
		if (typeof value === 'string') return value;
		return 'Unknown error';
	}

	function modelFactory(): PromptFactory | null {
		const scope = globalThis as typeof globalThis & {
			LanguageModel?: PromptFactory;
			LanguageDetector?: LanguageDetectorFactory;
			ai?: { languageModel?: PromptFactory };
		};
		return scope.LanguageModel ?? scope.ai?.languageModel ?? null;
	}

	function languageDetectorFactory(): LanguageDetectorFactory | null {
		const scope = globalThis as typeof globalThis & {
			LanguageDetector?: LanguageDetectorFactory;
		};
		return scope.LanguageDetector ?? null;
	}

	function normalizeAvailability(value: Availability): string {
		if (value === 'available') return 'Available';
		if (value === 'downloadable') return 'Downloadable';
		if (value === 'downloading') return 'Downloading';
		if (value === 'unavailable') return 'Unavailable';
		return String(value || 'Unknown');
	}

	function clearModelDownloadHintTimer() {
		if (!modelDownloadHintTimer) return;
		clearTimeout(modelDownloadHintTimer);
		modelDownloadHintTimer = null;
	}

	function scheduleModelDownloadHint() {
		clearModelDownloadHintTimer();
		modelDownloadHintTimer = setTimeout(() => {
			modelDownloadHintTimer = null;
			if (modelState !== 'loading' || modelProgress > 0) return;
			modelProgressIndeterminate = true;
			modelStatus = 'Waiting for Chrome download progress';
			modelHint =
				'Chrome has started model setup but has not reported download progress yet. Keep this tab open; if it stays here for several minutes, restart Chrome and try again.';
		}, MODEL_DOWNLOAD_HINT_MS);
	}

	function updateModelDownloadProgress(loadedValue: unknown) {
		const loaded = Number(loadedValue ?? 0);
		if (!Number.isFinite(loaded) || loaded <= 0) {
			modelProgress = 0;
			modelProgressIndeterminate = true;
			modelStatus = 'Downloading model';
			modelHint = 'Chrome has not reported a nonzero download percentage yet.';
			return;
		}

		modelProgress = Math.max(0, Math.min(1, loaded));
		modelProgressIndeterminate = false;
		modelStatus = `Downloading model ${formatPercent(modelProgress)}`;
		modelHint = null;
	}

	async function loadModel() {
		if (!browser || !canLoadModel) return;

		stopCurrentPrompt();
		modelSession?.destroy?.();
		modelSession = null;
		languageDetector?.destroy?.();
		languageDetector = null;
		modelAbortController = new AbortController();
		modelError = null;
		languageError = null;
		modelProgress = 0;
		modelProgressIndeterminate = false;
		modelHint = null;
		modelState = 'checking';
		modelStatus = 'Checking Prompt API';
		languageState = 'checking';
		languageStatus = 'Checking LanguageDetector';
		clearModelDownloadHintTimer();

		const factory = modelFactory();
		if (!factory) {
			modelState = 'error';
			modelStatus = 'Prompt API unavailable';
			modelError = 'LanguageModel is not available in this browser.';
			languageState = 'idle';
			languageStatus = 'Language detector not loaded';
			return;
		}

		const detectorFactory = languageDetectorFactory();
		if (!detectorFactory) {
			modelState = 'error';
			modelStatus = 'Language detector unavailable';
			modelError = 'LanguageDetector is not available in this browser.';
			languageState = 'error';
			languageStatus = 'Language detector unavailable';
			languageError = 'LanguageDetector is required for the English prefilter.';
			return;
		}

		try {
			const nextLanguageAvailability = await detectorFactory.availability(LANGUAGE_DETECTOR_OPTIONS);
			languageAvailability = nextLanguageAvailability;
			if (nextLanguageAvailability === 'unavailable') {
				modelState = 'error';
				modelStatus = 'Language detector unavailable';
				modelError = 'LanguageDetector cannot run with the English prefilter in this browser.';
				languageState = 'error';
				languageStatus = 'Language detector unavailable';
				languageError = 'LanguageDetector is required for the English prefilter.';
				return;
			}

			languageState = 'loading';
			languageStatus =
				nextLanguageAvailability === 'available'
					? 'Opening language detector'
					: `${normalizeAvailability(nextLanguageAvailability)} language detector`;
			languageDetector = await detectorFactory.create({
				...LANGUAGE_DETECTOR_OPTIONS,
				signal: modelAbortController.signal,
				monitor(monitor: EventTarget) {
					monitor.addEventListener('downloadprogress', (event) => {
						const progress = event as Event & { loaded?: number };
						const loaded = Number(progress.loaded ?? 0);
						languageStatus =
							Number.isFinite(loaded) && loaded > 0
								? `Downloading language detector ${formatPercent(loaded)}`
								: 'Downloading language detector';
					});
				}
			});
			languageState = 'ready';
			languageStatus = 'English detector ready';

			const nextAvailability = await factory.availability(MODEL_OPTIONS);
			availability = nextAvailability;
			if (nextAvailability === 'unavailable') {
				modelState = 'error';
				modelStatus = 'Model unavailable';
				modelError = 'This browser or device cannot run the built-in language model.';
				return;
			}

			modelState = 'loading';
			modelProgressIndeterminate = nextAvailability !== 'available';
			modelHint =
				nextAvailability === 'available'
					? null
					: 'Chrome may sit at 0% while it prepares the on-device model download.';
			modelStatus =
				nextAvailability === 'available'
					? 'Opening model session'
					: `${normalizeAvailability(nextAvailability)} model`;
			scheduleModelDownloadHint();

			const session = await factory.create({
				...MODEL_OPTIONS,
				initialPrompts: [{ role: 'system', content: SYSTEM_PROMPT }],
				signal: modelAbortController.signal,
				monitor(monitor: EventTarget) {
					monitor.addEventListener('downloadprogress', (event) => {
						const progress = event as Event & { loaded?: number; total?: number };
						updateModelDownloadProgress(progress.loaded);
					});
				}
			});

			clearModelDownloadHintTimer();
			session.addEventListener?.('contextoverflow', () => {
				modelStatus = 'Model ready, context rolling forward';
			});
			modelSession = session;
			modelState = 'ready';
			modelStatus = 'Model ready';
			modelProgress = 1;
			modelProgressIndeterminate = false;
			modelHint = null;
			scheduleQueueDrain();
		} catch (error) {
			clearModelDownloadHintTimer();
			modelState = 'error';
			modelStatus = 'Model load failed';
			modelProgressIndeterminate = false;
			modelError = describeError(error);
			if (languageState !== 'ready') {
				languageState = 'error';
				languageStatus = 'Language detector failed';
				languageError = describeError(error);
			}
		}
	}

	function unloadModel() {
		stopCurrentPrompt();
		modelAbortController?.abort();
		modelAbortController = null;
		modelSession?.destroy?.();
		languageDetector?.destroy?.();
		modelSession = null;
		languageDetector = null;
		currentBatchPosts = [];
		modelState = 'idle';
		modelStatus = 'Model not loaded';
		languageState = 'idle';
		languageStatus = 'Language detector not loaded';
		languageError = null;
		modelProgress = 0;
		modelProgressIndeterminate = false;
		modelHint = null;
		if (drainTimer) {
			clearTimeout(drainTimer);
			drainTimer = null;
			drainScheduled = false;
		}
		clearModelDownloadHintTimer();
		if (streamStatus === 'connecting' || streamStatus === 'live') {
			disconnectJetstream();
		}
	}

	function stopCurrentPrompt() {
		promptAbortController?.abort();
		promptAbortController = null;
	}

	function applyPromptTemplate(event: Event) {
		event.preventDefault();
		try {
			localStorage.setItem(STORAGE_PROMPT_KEY, promptTemplate);
			templateSavedAt = new Date().toISOString();
		} catch {}
	}

	function resetPromptTemplate() {
		promptTemplate = DEFAULT_PROMPT_TEMPLATE;
		templateSavedAt = null;
		try {
			localStorage.setItem(STORAGE_PROMPT_KEY, promptTemplate);
		} catch {}
	}

	function buildJetstreamUrl(): string {
		const url = new URL(JETSTREAM_URLS[((endpointIndex % JETSTREAM_URLS.length) + JETSTREAM_URLS.length) % JETSTREAM_URLS.length]);
		url.searchParams.set('wantedCollections', 'app.bsky.feed.post');
		url.searchParams.set('cursor', String(Math.max(0, Date.now() * 1000 - LIVE_CURSOR_REWIND_US)));
		return url.toString();
	}

	function connectJetstream() {
		if (!browser || !canStartFirehose) return;

		disconnectJetstream();
		streamError = null;
		streamStatus = 'connecting';
		streamStatusText = 'Connecting';

		const nextSocket = new WebSocket(buildJetstreamUrl());
		nextSocket.binaryType = 'arraybuffer';
		socket = nextSocket;

		nextSocket.addEventListener('open', () => {
			if (socket !== nextSocket) return;
			streamStatus = 'live';
			streamStatusText = 'Live';
			streamError = null;
		});
		nextSocket.addEventListener('message', (event) => {
			void handleJetstreamMessage(event.data);
		});
		nextSocket.addEventListener('error', () => {
			if (socket !== nextSocket) return;
			streamStatus = 'error';
			streamStatusText = 'Stream error';
			streamError = 'Jetstream connection failed.';
		});
		nextSocket.addEventListener('close', () => {
			if (socket !== nextSocket) return;
			socket = null;
			if (streamStatus === 'error') return;
			streamStatus = 'closed';
			streamStatusText = 'Closed';
		});
	}

	function disconnectJetstream() {
		const current = socket;
		socket = null;
		if (current && current.readyState <= WebSocket.OPEN) {
			current.close();
		}
		if (streamStatus === 'connecting' || streamStatus === 'live') {
			streamStatus = 'closed';
			streamStatusText = 'Closed';
		}
	}

	function rotateEndpoint() {
		endpointIndex = (endpointIndex + 1) % JETSTREAM_URLS.length;
		if (streamStatus === 'live' || streamStatus === 'connecting') {
			connectJetstream();
		}
	}

	async function handleJetstreamMessage(data: unknown) {
		const message = await decodeMessageData(data);
		if (!message) return;

		try {
			const event = JSON.parse(message) as JetstreamEvent;
			const post = parseJetstreamPost(event);
			if (!post) return;
			if (!(await isEnglishPost(post))) return;
			enqueuePost(post);
		} catch {
			postsSkipped += 1;
		}
	}

	async function decodeMessageData(data: unknown): Promise<string | null> {
		if (typeof data === 'string') return data;
		if (data instanceof Blob) return await data.text();
		if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
		if (ArrayBuffer.isView(data)) return new TextDecoder().decode(data);
		return null;
	}

	function parseJetstreamPost(event: JetstreamEvent): QueuedPost | null {
		const commit = event.commit;
		const record = commit?.record;
		const did = typeof event.did === 'string' ? event.did.trim() : '';
		const rkey = typeof commit?.rkey === 'string' ? commit.rkey.trim() : '';
		if (event.kind !== 'commit' || commit?.operation !== 'create') return null;
		if (commit.collection !== 'app.bsky.feed.post') return null;
		if (!did || !rkey || !record) return null;

		postsSeen += 1;
		const uri = buildAtUri(did, rkey);
		if (!uri || seenUriSet.has(uri)) return null;
		rememberUri(uri);

		const text = typeof record.text === 'string' ? record.text.trim() : '';
		const images = streamEventImages(imageEmbeds(record), did, uri);
		if (!text) {
			textOnlySkipped += 1;
			postsSkipped += 1;
			return null;
		}
		if (images.length > 0) {
			imageSkipped += 1;
			postsSkipped += 1;
			return null;
		}

		const tags = extractTags(record);
		const links = extractLinks(record);
		const labels = extractLabels(record);
		const langs = Array.isArray(record.langs)
			? record.langs.filter((lang: unknown): lang is string => typeof lang === 'string')
			: [];
		const hasEmbed = Boolean(record.embed);

		scheduleProfileFetch(did);
		return {
			id: uri,
			uri,
			cid: typeof commit.cid === 'string' ? commit.cid : uri,
			did,
			rkey,
			text,
			createdAt: streamCreatedAt(record, event),
			queuedAt: new Date().toISOString(),
			images,
			tags,
			links,
			langs,
			labels,
			replyParentUri: typeof record.reply?.parent?.uri === 'string' ? record.reply.parent.uri : null,
			hasEmbed
		};
	}

	async function isEnglishPost(post: QueuedPost): Promise<boolean> {
		if (!languageDetector) {
			languageSkipped += 1;
			postsSkipped += 1;
			return false;
		}

		try {
			const results = await languageDetector.detect(post.text.slice(0, MAX_PROMPT_TEXT_LENGTH));
			const top = results[0];
			const detectedLanguage = top?.detectedLanguage.toLowerCase() ?? '';
			const isEnglish = detectedLanguage === 'en' || detectedLanguage.startsWith('en-');
			if (isEnglish && (top?.confidence ?? 0) >= ENGLISH_CONFIDENCE_THRESHOLD) return true;

			languageSkipped += 1;
			postsSkipped += 1;
			return false;
		} catch {
			languageSkipped += 1;
			postsSkipped += 1;
			return false;
		}
	}

	function rememberUri(uri: string) {
		seenUris.push(uri);
		seenUriSet.add(uri);
		while (seenUris.length > MAX_SEEN_URIS) {
			const oldUri = seenUris.shift();
			if (oldUri) seenUriSet.delete(oldUri);
		}
	}

	function enqueuePost(post: QueuedPost) {
		let nextQueue = [...pendingPosts, post];
		if (nextQueue.length > MAX_QUEUE_SIZE) {
			const overflow = nextQueue.length - MAX_QUEUE_SIZE;
			postsDropped += overflow;
			nextQueue = nextQueue.slice(overflow);
		}
		pendingPosts = nextQueue;
		postsQueued += 1;
		scheduleQueueDrain();
	}

	function scheduleQueueDrain() {
		const delay = pendingPosts.length >= classifierBatchSize() ? 0 : CLASSIFIER_BATCH_WAIT_MS;
		if (drainScheduled) {
			if (delay > 0 || !drainTimer) return;
			clearTimeout(drainTimer);
			drainTimer = null;
			drainScheduled = false;
		}

		drainScheduled = true;
		drainTimer = setTimeout(() => {
			drainScheduled = false;
			drainTimer = null;
			void drainQueue();
		}, delay);
	}

	async function drainQueue() {
		if (queuePaused || isClassifying || !modelSession || modelState !== 'ready') return;
		const batch = pendingPosts.slice(0, classifierBatchSize());
		if (batch.length === 0) return;

		pendingPosts = pendingPosts.slice(batch.length);
		currentBatchPosts = batch;
		isClassifying = true;
		const controller = new AbortController();
		promptAbortController = controller;

		try {
			const raw = await runClassifierPrompt(batch, controller.signal);
			const decisions = parseBatchDecisions(raw, batch);
			const processedAt = new Date().toISOString();
			const items = batch.map((post, index) => ({
				post,
				decision:
					decisions.get(batchPostId(index)) ??
					omittedDecision(),
				raw,
				processedAt
			}));
			const verifiedItems = await verifyAcceptedItems(items, controller.signal);

			postsProcessed += verifiedItems.length;
			storeClassifiedItems(verifiedItems);
		} catch (error) {
			if ((error as Error)?.name === 'AbortError') {
				pendingPosts = [...batch, ...pendingPosts].slice(0, MAX_QUEUE_SIZE);
			} else {
				promptFailures += batch.length;
				const errorMessage = describeError(error).slice(0, 140);
				const processedAt = new Date().toISOString();
				storeClassifiedItems(
					batch.map((post) => ({
						post,
						decision: errorDecision(errorMessage),
						raw: '',
						processedAt
					}))
				);
			}
		} finally {
			if (promptAbortController === controller) promptAbortController = null;
			currentBatchPosts = [];
			isClassifying = false;
			scheduleQueueDrain();
		}
	}

	function classifierBatchSize(): number {
		const value = Math.round(Number(batchSize));
		if (!Number.isFinite(value)) return DEFAULT_CLASSIFIER_BATCH_SIZE;
		return Math.max(1, Math.min(MAX_CLASSIFIER_BATCH_SIZE, value));
	}

	function batchPostId(index: number): string {
		return `p${index + 1}`;
	}

	function errorDecision(message: string): ClassifierDecision {
		const description = message.slice(0, CLASSIFIER_DESCRIPTION_LIMIT);
		return {
			keep: false,
			answer: 'ERROR',
			confidence: 0,
			description,
			error: message
		};
	}

	function omittedDecision(): ClassifierDecision {
		return {
			keep: false,
			answer: 'NO',
			confidence: 0,
			description: 'Not returned by model.'
		};
	}

	function storeClassifiedItems(items: ClassifiedPost[]) {
		const accepted = items.filter((item) => item.decision.keep);
		const rejected = items.filter((item) => !item.decision.keep);
		postsAccepted += accepted.length;
		postsRejected += rejected.length;

		if (accepted.length > 0) {
			const acceptedUris = new Set(accepted.map((item) => item.post.uri));
			acceptedPosts = [...accepted, ...acceptedPosts.filter((item) => !acceptedUris.has(item.post.uri))].slice(
				0,
				MAX_ACCEPTED_POSTS
			);
		}

		if (rejected.length > 0) {
			rejectedPosts = [...rejected, ...rejectedPosts].slice(0, MAX_REJECTED_POSTS);
		}
	}

	async function runClassifierPrompt(posts: QueuedPost[], signal: AbortSignal): Promise<string> {
		if (!modelSession) throw new Error('Model session is not ready.');
		const prompt = buildClassifierPrompt(posts);
		try {
			const raw = await modelSession.prompt(prompt, {
				signal,
				responseConstraint: CLASSIFIER_BATCH_SCHEMA
			});
			logLlmOutput('batch', posts, raw);
			return raw;
		} catch (error) {
			if ((error as Error)?.name === 'AbortError') throw error;
			const raw = await modelSession.prompt(
				`${prompt}\n\nReturn exactly one JSON object like {"posts":[{"id":"p1","description":"short reason"}]}.`,
				{ signal }
			);
			logLlmOutput('batch fallback', posts, raw);
			return raw;
		}
	}

	async function runVerificationPrompt(post: QueuedPost, signal: AbortSignal): Promise<string> {
		if (!modelSession) throw new Error('Model session is not ready.');
		const prompt = `${buildClassifierPrompt([post])}

Second pass:
- This is a verification pass for a candidate accepted by a batch.
- Judge only this one post.
- Default to NO unless this specific post is an obvious high-signal match.`;

		try {
			const raw = await modelSession.prompt(prompt, {
				signal,
				responseConstraint: CLASSIFIER_BATCH_SCHEMA
			});
			logLlmOutput('verification', [post], raw);
			return raw;
		} catch (error) {
			if ((error as Error)?.name === 'AbortError') throw error;
			const raw = await modelSession.prompt(
				`${prompt}\n\nReturn exactly one JSON object like {"posts":[{"id":"p1","description":"short reason"}]}.`,
				{ signal }
			);
			logLlmOutput('verification fallback', [post], raw);
			return raw;
		}
	}

	function logLlmOutput(stage: string, posts: QueuedPost[], raw: string) {
		console.groupCollapsed(
			`[jetstreamfiltered] LLM ${stage} output · ${posts.length} post${posts.length === 1 ? '' : 's'}`
		);
		console.log(
			'posts',
			posts.map((post, index) => ({
				id: batchPostId(index),
				uri: post.uri,
				author: authorHandle(post),
				text: post.text.slice(0, 180)
			}))
		);
		console.log('raw', raw);
		console.groupEnd();
	}

	async function verifyAcceptedItems(items: ClassifiedPost[], signal: AbortSignal): Promise<ClassifiedPost[]> {
		const verified: ClassifiedPost[] = [];

		for (const item of items) {
			if (!item.decision.keep) {
				verified.push(item);
				continue;
			}

			try {
				const raw = await runVerificationPrompt(item.post, signal);
				const decisions = parseBatchDecisions(raw, [item.post]);
				verified.push({
					...item,
					decision:
						decisions.get(batchPostId(0)) ??
						omittedDecision(),
					raw: `${item.raw}\n\nverification:\n${raw}`
				});
			} catch (error) {
				if ((error as Error)?.name === 'AbortError') throw error;
				promptFailures += 1;
				verified.push({
					...item,
					decision: errorDecision(`Verification failed: ${describeError(error)}`),
					raw: item.raw
				});
			}
		}

		return verified;
	}

	function buildClassifierPrompt(posts: QueuedPost[]): string {
		const payload = posts.map((post, index) => classifierPostPayload(post, index));
		return `Filter this batch of Bluesky Jetstream posts against the user template.

User template:
${promptTemplate.trim() || DEFAULT_PROMPT_TEMPLATE}

Decision:
- Return only the most interesting posts that should be shown.
- Do not return rejected posts.
- If no posts should be shown, return {"posts":[]}.
- Include a post only when it clearly matches at least one wanted class, avoids the skip classes, and you are highly confident it is worth showing.
- Omit everything else. Default to omission when uncertain.
- Description must be ${CLASSIFIER_DESCRIPTION_LIMIT} characters or less and explain the decision.
- Preserve each id exactly.
- Judge each post independently. A shown post must not affect any other post.
- Never copy a description from one post to another.
- Return exactly one JSON object with a posts array.
- Shape: {"posts":[{"id":"p1","description":"short reason"}]}
- Do not include markdown, code fences, or extra text.

Posts:
${JSON.stringify(payload, null, 2)}`;
	}

	function classifierPostPayload(post: QueuedPost, index: number) {
		const profile = profilesByDid[post.did];
		const author = profile?.handle ? `@${profile.handle}` : post.did;
		return {
			id: batchPostId(index),
			author,
			createdAt: post.createdAt,
			kind: post.replyParentUri ? 'reply' : 'root post or quote',
			langs: post.langs.length > 0 ? post.langs : ['unknown'],
			labels: post.labels,
			tags: post.tags,
			links: post.links,
			text: post.text.slice(0, MAX_BATCH_PROMPT_TEXT_LENGTH)
		};
	}

	function parseBatchDecisions(raw: string, posts: QueuedPost[]): Map<string, ClassifierDecision> {
		const cleaned = stripModelEnvelope(raw);
		const records = parseBatchDecisionRecords(cleaned);

		const expectedIds = posts.map((_, index) => batchPostId(index));
		const expectedIdSet = new Set(expectedIds);
		const decisions = new Map<string, ClassifierDecision>();

		for (const record of records) {
			const id = recordId(record);
			if (id && expectedIdSet.has(id)) decisions.set(id, decisionFromRecord(record));
		}

		for (const id of expectedIds) {
			if (!decisions.has(id)) decisions.set(id, omittedDecision());
		}

		return decisions;
	}

	function stripModelEnvelope(raw: string): string {
		return raw
			.trim()
			.replace(/^```(?:json|text)?/i, '')
			.replace(/```$/i, '')
			.trim();
	}

	function parseBatchDecisionRecords(raw: string): ClassifierRecord[] {
		const json = parseJsonValue(raw);
		const jsonRecords = recordsFromJson(json);
		if (jsonRecords.length > 0) return jsonRecords;
		return recordsFromLabeledLines(raw);
	}

	function parseJsonValue(raw: string): unknown {
		const objectStart = raw.indexOf('{');
		const arrayStart = raw.indexOf('[');
		const starts = [objectStart, arrayStart].filter((index) => index >= 0);
		if (starts.length === 0) return null;

		const start = Math.min(...starts);
		const end = Math.max(raw.lastIndexOf('}'), raw.lastIndexOf(']'));
		if (end <= start) return null;

		try {
			return JSON.parse(raw.slice(start, end + 1));
		} catch {
			return null;
		}
	}

	function recordsFromJson(value: unknown): ClassifierRecord[] {
		if (Array.isArray(value)) return value.filter(isRecord);
		if (!isRecord(value)) return [];

		const list =
			value.posts ??
			value.shownPosts ??
			value.shown ??
			value.show ??
			value.results ??
			value.items ??
			value.decisions ??
			value.classifications;
		if (Array.isArray(list)) return list.filter(isRecord).filter(isShownRecord);
		if ('id' in value && ('description' in value || 'confidence' in value || 'score' in value)) return [value];
		return [];
	}

	function isShownRecord(record: ClassifierRecord): boolean {
		if (!('answer' in record) && !('decision' in record)) return true;
		const answer = String(record.answer ?? record.decision ?? '')
			.trim()
			.replace(/[^a-z]/gi, '')
			.toUpperCase();
		return answer === 'YES' || answer === 'SHOW' || answer === 'KEEP';
	}

	function recordsFromLabeledLines(raw: string): ClassifierRecord[] {
		return raw
			.split('\n')
			.map((line) => {
				const match = line.match(
					/^\s*(p?\d+|post\s*\d+)\s*[:=-]\s*(yes|no)\b(?:\s*[,|;-]\s*([0-9]+(?:\.[0-9]+)?%?))?(?:\s*[,|;-]\s*(.*))?$/i
				);
				if (!match) return null;
				return {
					id: normalizeRecordId(match[1]),
					answer: match[2],
					confidence: match[3],
					description: match[4]
				};
			})
			.filter((record): record is ClassifierRecord => Boolean(record) && isShownRecord(record));
	}

	function isRecord(value: unknown): value is ClassifierRecord {
		return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
	}

	function recordId(record: ClassifierRecord): string | null {
		return normalizeRecordId(record.id ?? record.postId ?? record.post_id);
	}

	function normalizeRecordId(value: unknown): string | null {
		const text = String(value ?? '').trim().toLowerCase();
		if (!text) return null;
		const postMatch = text.match(/^post\s*(\d+)$/);
		if (postMatch) return `p${Math.max(1, Number(postMatch[1]))}`;
		const compactMatch = text.match(/^p?(\d+)$/);
		if (compactMatch) return `p${Math.max(1, Number(compactMatch[1]))}`;
		return text;
	}

	function decisionFromRecord(record: ClassifierRecord): ClassifierDecision {
		try {
			return applyConfidenceGate(
				decisionFromParts(
					record.answer ?? record.decision ?? 'YES',
					record.confidence ?? record.score,
					record.description ?? record.reason ?? record.summary
				)
			);
		} catch (error) {
			return errorDecision(describeError(error).slice(0, 140));
		}
	}

	function decisionFromParts(answerValue: unknown, confidenceValue: unknown, descriptionValue: unknown): ClassifierDecision {
		const answer = normalizeAnswer(answerValue);
		const confidence =
			answer === 'YES' && (confidenceValue == null || confidenceValue === '') ? 1 : normalizeConfidence(confidenceValue);
		const description =
			normalizeDescription(descriptionValue) ||
			(answer === 'YES' ? 'Matches the saved filter.' : 'Does not match the saved filter.');
		return {
			keep: answer === 'YES',
			answer,
			confidence,
			description
		};
	}

	function normalizeAnswer(value: unknown): 'YES' | 'NO' {
		const answer = String(value ?? '')
			.trim()
			.replace(/[^a-z]/gi, '')
			.toUpperCase();
		if (answer === 'YES' || answer === 'SHOW' || answer === 'KEEP') return 'YES';
		if (answer === 'NO' || answer === 'OMIT' || answer === 'SKIP' || answer === 'REJECT') return 'NO';
		throw new Error('Model response did not include YES or NO.');
	}

	function normalizeConfidence(value: unknown): number {
		const text = String(value ?? '').trim();
		const parsed = Number(text.replace(/%$/, ''));
		if (!Number.isFinite(parsed)) return 0;
		const normalized = parsed > 1 ? parsed / 100 : parsed;
		return Math.max(0, Math.min(1, normalized));
	}

	function normalizeDescription(value: unknown): string {
		return String(value ?? '')
			.replace(/\s+/g, ' ')
			.trim()
			.slice(0, CLASSIFIER_DESCRIPTION_LIMIT);
	}

	function applyConfidenceGate(decision: ClassifierDecision): ClassifierDecision {
		if (decision.answer !== 'YES') return { ...decision, keep: false };
		return { ...decision, keep: true };
	}

	function pauseQueue() {
		queuePaused = true;
	}

	function resumeQueue() {
		queuePaused = false;
		scheduleQueueDrain();
	}

	function clearQueue() {
		pendingPosts = [];
	}

	function clearResults() {
		acceptedPosts = [];
		rejectedPosts = [];
		postsAccepted = 0;
		postsRejected = 0;
	}

	function scheduleProfileFetch(did: string) {
		if (!did || profilesByDid[did] || pendingProfileDids.has(did)) return;
		pendingProfileDids.add(did);
		if (profileBatchTimer) return;
		profileBatchTimer = setTimeout(() => {
			void flushProfiles();
		}, PROFILE_BATCH_DELAY_MS);
	}

	async function flushProfiles() {
		profileBatchTimer = null;
		const dids = [...pendingProfileDids].slice(0, 25);
		for (const did of dids) pendingProfileDids.delete(did);
		if (dids.length === 0) return;

		try {
			const profiles = await getProfiles(dids);
			if (profiles.length > 0) {
				profilesByDid = {
					...profilesByDid,
					...Object.fromEntries(profiles.map((profile) => [profile.did, profile]))
				};
			}
		} catch {
			for (const did of dids) pendingProfileDids.add(did);
		} finally {
			if (pendingProfileDids.size > 0 && !profileBatchTimer) {
				profileBatchTimer = setTimeout(() => {
					void flushProfiles();
				}, PROFILE_BATCH_DELAY_MS);
			}
		}
	}

	function cidFromBlob(blob: any): string | null {
		const ref = blob?.ref;
		if (typeof ref === 'string') return ref;
		if (typeof ref?.$link === 'string') return ref.$link;
		if (typeof ref?.['/'] === 'string') return ref['/'];
		if (typeof blob?.cid === 'string') return blob.cid;
		return null;
	}

	function imageUrl(kind: 'feed_thumbnail' | 'feed_fullsize', did: string, cid: string): string {
		return `https://cdn.bsky.app/img/${kind}/plain/${did}/${cid}@jpeg`;
	}

	function imageEmbeds(record: any): any[] {
		const embed = record?.embed;
		if (embed?.$type === 'app.bsky.embed.images') return embed.images ?? [];
		if (embed?.$type === 'app.bsky.embed.recordWithMedia') {
			const media = embed.media;
			if (media?.$type === 'app.bsky.embed.images') return media.images ?? [];
		}
		return [];
	}

	function streamEventImages(images: any[], did: string, uri: string): FirehoseImage[] {
		return images
			.map((image, index) => {
				const cid = cidFromBlob(image?.image);
				if (!cid) return null;
				return {
					id: `${uri}/${cid}/${index}`,
					thumb: imageUrl('feed_thumbnail', did, cid),
					fullsize: imageUrl('feed_fullsize', did, cid),
					alt: typeof image?.alt === 'string' ? image.alt : '',
					aspectRatio: ratioFor(image)
				};
			})
			.filter((image): image is FirehoseImage => Boolean(image));
	}

	function ratioFor(image: any): string {
		const width = Number(image?.aspectRatio?.width);
		const height = Number(image?.aspectRatio?.height);
		if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
			return `${Math.round(width)} / ${Math.round(height)}`;
		}
		return '4 / 3';
	}

	function normalizeTag(tag: unknown): string | null {
		if (typeof tag !== 'string') return null;
		const clean = tag.replace(/^#/, '').trim().toLowerCase();
		return /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(clean) ? clean : null;
	}

	function extractTags(record: any): string[] {
		const tags = new Set<string>();
		for (const facet of record?.facets ?? []) {
			for (const feature of facet?.features ?? []) {
				if (feature?.$type === 'app.bsky.richtext.facet#tag') {
					const tag = normalizeTag(feature.tag);
					if (tag) tags.add(tag);
				}
			}
		}
		const text = typeof record?.text === 'string' ? record.text : '';
		for (const match of text.matchAll(/(^|\s)#([A-Za-z0-9][A-Za-z0-9_-]{0,63})/g)) {
			const tag = normalizeTag(match[2]);
			if (tag) tags.add(tag);
		}
		return [...tags];
	}

	function extractLinks(record: any): string[] {
		const links = new Set<string>();
		for (const facet of record?.facets ?? []) {
			for (const feature of facet?.features ?? []) {
				if (feature?.$type === 'app.bsky.richtext.facet#link' && typeof feature.uri === 'string') {
					links.add(feature.uri);
				}
			}
		}
		const text = typeof record?.text === 'string' ? record.text : '';
		for (const match of text.matchAll(/https?:\/\/[^\s<>"']+/gi)) {
			links.add(match[0].replace(/[),.;!?]+$/g, ''));
		}
		return [...links].slice(0, 8);
	}

	function extractLabels(record: any): string[] {
		const values = record?.labels?.values;
		if (!Array.isArray(values)) return [];
		return values
			.map((label) => (typeof label?.val === 'string' ? label.val : null))
			.filter((label): label is string => Boolean(label));
	}

	function streamCreatedAt(record: any, event: JetstreamEvent): string {
		if (typeof record?.createdAt === 'string') return record.createdAt;
		const timeUs = Number(event.time_us);
		return Number.isFinite(timeUs) && timeUs > 0
			? new Date(timeUs / 1000).toISOString()
			: new Date().toISOString();
	}

	function postUrl(post: QueuedPost): string {
		const profile = profilesByDid[post.did];
		return buildBskyPostUrl(post.uri, profile?.handle || post.did) ?? `https://bsky.app/profile/${post.did}/post/${post.rkey}`;
	}

	function authorLabel(post: QueuedPost): string {
		const profile = profilesByDid[post.did];
		return profile?.displayName?.trim() || profile?.handle || post.did;
	}

	function authorHandle(post: QueuedPost): string {
		const profile = profilesByDid[post.did];
		return profile?.handle ? `@${profile.handle}` : post.did;
	}

	function formatTime(value: string | null): string {
		if (!value) return 'none';
		return new Intl.DateTimeFormat(undefined, {
			hour: '2-digit',
			minute: '2-digit',
			second: '2-digit'
		}).format(new Date(value));
	}

	function formatDateTime(value: string): string {
		return new Intl.DateTimeFormat(undefined, {
			month: 'short',
			day: 'numeric',
			hour: '2-digit',
			minute: '2-digit'
		}).format(new Date(value));
	}

	function formatPercent(value: number): string {
		return `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`;
	}

	function contextLabel(): string {
		if (!modelSession?.contextWindow || !modelSession.contextUsage) return 'n/a';
		return `${modelSession.contextUsage} / ${modelSession.contextWindow}`;
	}

	onMount(() => {
		try {
			const savedFont = localStorage.getItem(STORAGE_FONT_KEY);
			if (savedFont && savedFont in fontFamilies) fontKey = savedFont;
			const savedPrompt = localStorage.getItem(STORAGE_PROMPT_KEY);
			if (savedPrompt?.trim()) promptTemplate = savedPrompt;
		} catch {}
	});

	onDestroy(() => {
		disconnectJetstream();
		stopCurrentPrompt();
		modelAbortController?.abort();
		modelSession?.destroy?.();
		languageDetector?.destroy?.();
		if (drainTimer) clearTimeout(drainTimer);
		if (profileBatchTimer) clearTimeout(profileBatchTimer);
		clearModelDownloadHintTimer();
	});
</script>

<svelte:head>
	<title>Jetstream Filtered</title>
</svelte:head>

<main style="font-family: {fontFamily}">
	<header class="page-header">
		<RouteNav current="jetstreamfiltered" align="center" />
		<div class="title-row">
			<div>
				<h1>Jetstream Filtered</h1>
				<p class="subtitle">Prompt API queue over live Bluesky Jetstream posts</p>
			</div>
			<FontPicker value={fontKey} onchange={handleFontChange} />
		</div>
	</header>

	<section class="control-panel wobbly-border-light">
		<div class="action-row">
			<div class="action-group">
				<button
					type="button"
					class="primary-button wobbly-border"
					disabled={!canLoadModel}
					onclick={loadModel}
				>
					{modelState === 'ready' ? 'Reload model' : 'Load model'}
				</button>
				<button
					type="button"
					class="secondary-button wobbly-border-light"
					disabled={modelState === 'idle'}
					onclick={unloadModel}
				>
					Unload
				</button>
			</div>
			<div class="action-group">
				{#if streamStatus === 'live' || streamStatus === 'connecting'}
					<button type="button" class="secondary-button wobbly-border-light" onclick={disconnectJetstream}>
						Stop Jetstream
					</button>
				{:else}
					<button
						type="button"
						class="primary-button wobbly-border"
						disabled={!canStartFirehose}
						onclick={connectJetstream}
					>
						Start Jetstream
					</button>
				{/if}
				<button type="button" class="secondary-button wobbly-border-light" onclick={rotateEndpoint}>
					Rotate endpoint
				</button>
			</div>
		</div>

		<form class="prompt-form" onsubmit={applyPromptTemplate}>
			<label for="prompt-template">Post classes</label>
			<textarea
				id="prompt-template"
				rows="8"
				spellcheck="true"
				bind:value={promptTemplate}
			></textarea>
			<div class="template-actions">
				<button type="submit" class="secondary-button wobbly-border-light">Save template</button>
				<button type="button" class="secondary-button wobbly-border-light" onclick={resetPromptTemplate}>
					Reset
				</button>
				{#if templateSavedAt}
					<span>Saved {formatTime(templateSavedAt)}</span>
				{/if}
			</div>
		</form>

		{#if promptClasses.length > 0}
			<div class="class-strip" aria-label="Prompt classes">
				{#each promptClasses as item}
					<span>{item}</span>
				{/each}
			</div>
		{/if}

		<div class="queue-controls">
			<label class="confidence-control" for="classifier-batch-size">
				<span>
					Batch size
					<strong>{classifierBatchSize()}</strong>
				</span>
				<input
					id="classifier-batch-size"
					type="range"
					min="1"
					max={MAX_CLASSIFIER_BATCH_SIZE}
					step="1"
					bind:value={batchSize}
				/>
			</label>
			<div class="action-group">
				{#if queuePaused}
					<button type="button" class="secondary-button wobbly-border-light" onclick={resumeQueue}>
						Resume queue
					</button>
				{:else}
					<button type="button" class="secondary-button wobbly-border-light" onclick={pauseQueue}>
						Pause queue
					</button>
				{/if}
				<button type="button" class="secondary-button wobbly-border-light" onclick={clearQueue}>
					Clear queue
				</button>
				<button type="button" class="secondary-button wobbly-border-light" onclick={clearResults}>
					Clear results
				</button>
			</div>
		</div>

		<div class="stats-grid">
			<div class="stat">
				<span>Model</span>
				<strong class:live={modelState === 'ready'}>{modelStatus}</strong>
			</div>
			<div class="stat">
				<span>Language</span>
				<strong class:live={languageState === 'ready'}>{languageStatus}</strong>
			</div>
			<div class="stat">
				<span>Availability</span>
				<strong>{availability ? normalizeAvailability(availability) : 'n/a'}</strong>
			</div>
			<div class="stat">
				<span>Detector</span>
				<strong>{languageAvailability ? normalizeAvailability(languageAvailability) : 'n/a'}</strong>
			</div>
			<div class="stat">
				<span>Jetstream</span>
				<strong class:live={streamStatus === 'live'}>{streamStatusText}</strong>
			</div>
			<div class="stat">
				<span>Queued</span>
				<strong>{pendingPosts.length.toLocaleString()}</strong>
			</div>
			<div class="stat">
				<span>Seen</span>
				<strong>{postsSeen.toLocaleString()}</strong>
			</div>
			<div class="stat">
				<span>Processed</span>
				<strong>{postsProcessed.toLocaleString()}</strong>
			</div>
			<div class="stat">
				<span>Accepted</span>
				<strong>{acceptedCount.toLocaleString()}</strong>
			</div>
			<div class="stat">
				<span>Rejected</span>
				<strong>{rejectedCount.toLocaleString()}</strong>
			</div>
			<div class="stat">
				<span>Rate</span>
				<strong>{acceptanceRate}%</strong>
			</div>
			<div class="stat">
				<span>Batch</span>
				<strong>{classifierBatchSize()}</strong>
			</div>
			<div class="stat">
				<span>Dropped</span>
				<strong>{postsDropped.toLocaleString()}</strong>
			</div>
			<div class="stat">
				<span>No Text</span>
				<strong>{textOnlySkipped.toLocaleString()}</strong>
			</div>
			<div class="stat">
				<span>Images</span>
				<strong>{imageSkipped.toLocaleString()}</strong>
			</div>
			<div class="stat">
				<span>Non-English</span>
				<strong>{languageSkipped.toLocaleString()}</strong>
			</div>
			<div class="stat">
				<span>Context</span>
				<strong>{contextLabel()}</strong>
			</div>
		</div>

		{#if modelState === 'loading'}
			<div
				class="progress-shell"
				class:indeterminate={modelProgressIndeterminate || modelProgress <= 0}
				aria-label="Model download progress"
			>
				<span style={`width: ${modelProgressIndeterminate || modelProgress <= 0 ? '36%' : formatPercent(modelProgress)}`}></span>
			</div>
			{#if modelHint}
				<p class="model-hint">{modelHint}</p>
			{/if}
		{/if}

		{#if modelError || languageError || streamError}
			<div class="error-row">
				{#if modelError}
					<p>{modelError}</p>
				{/if}
				{#if languageError}
					<p>{languageError}</p>
				{/if}
				{#if streamError}
					<p>{streamError}</p>
				{/if}
			</div>
		{/if}
	</section>

	<section class="queue-panel">
		<div class="queue-card wobbly-border-light">
			<div class="queue-heading">
				<h2>Current batch</h2>
				{#if isClassifying}
					<button type="button" class="mini-button" onclick={stopCurrentPrompt}>Stop prompt</button>
				{/if}
			</div>
			{#if currentBatchPosts.length > 0}
				<div class="queue-list current-batch-list">
					{#each currentBatchPosts as post, index (post.uri)}
						<article class="queue-post active-post">
							<strong>{batchPostId(index)} · {authorLabel(post)}</strong>
							<span>{formatDateTime(post.createdAt)}</span>
							<p>{post.text || '[media post]'}</p>
						</article>
					{/each}
				</div>
			{:else}
				<p class="muted-copy">{queuePaused ? 'Paused' : 'Idle'}</p>
			{/if}
		</div>

		<div class="queue-card wobbly-border-light">
			<div class="queue-heading">
				<h2>Queue</h2>
				<span>{postsQueued.toLocaleString()} queued total</span>
			</div>
			{#if queuePreview.length === 0}
				<p class="muted-copy">Empty</p>
			{:else}
				<div class="queue-list">
					{#each queuePreview as post (post.uri)}
						<article class="queue-post">
							<strong>{authorLabel(post)}</strong>
							<span>{formatTime(post.queuedAt)}</span>
							<p>{post.text || '[media post]'}</p>
						</article>
					{/each}
				</div>
			{/if}
		</div>

		<div class="queue-card wobbly-border-light">
			<div class="queue-heading">
				<h2>Rejected</h2>
				<span>{rejectedCount.toLocaleString()} total · {rejectedPosts.length.toLocaleString()} kept</span>
			</div>
			{#if rejectedPosts.length === 0}
				<p class="muted-copy">None</p>
			{:else}
				<div class="queue-list">
					{#each rejectedPosts.slice(0, 10) as item (item.post.uri)}
						<article class="queue-post">
							<strong>{item.decision.answer}</strong>
							<span>{formatTime(item.processedAt)}</span>
							<p>{item.decision.error || item.decision.description || item.post.text}</p>
						</article>
					{/each}
				</div>
			{/if}
		</div>
	</section>

	{#if acceptedPosts.length === 0}
		<section class="empty-state wobbly-border-light">
			<h2>{streamStatus === 'live' ? 'Waiting for accepted posts.' : 'Ready for Jetstream.'}</h2>
			<p>
				Text-only English gate: {postsSkipped.toLocaleString()} skipped,
				{promptFailures.toLocaleString()} prompt failures
			</p>
		</section>
	{:else}
		<section class="filtered-gallery" aria-label="Jetstream filtered posts">
			{#each acceptedPosts as item (item.post.uri)}
				{@const post = item.post}
				{@const profile = profilesByDid[post.did]}
				<article class="post-card">
					<div class="post-card-header">
						<div class="author-chip">
							{#if profile?.avatar}
								<img src={profile.avatar} alt="" />
							{/if}
							<span>
								<strong>{authorLabel(post)}</strong>
								<small>{authorHandle(post)}</small>
							</span>
						</div>
						<a href={postUrl(post)} target="_blank" rel="noreferrer">Post</a>
					</div>

					<div class="decision-row">
						<span>Shown</span>
						<strong title={item.decision.description}>{item.decision.description}</strong>
					</div>

					{#if post.images.length > 0}
						<div class="image-grid" class:solo={post.images.length === 1}>
							{#each post.images.slice(0, 4) as image (image.id)}
								<button
									type="button"
									class="image-button"
									style={`--image-ratio: ${image.aspectRatio}`}
									onclick={() => openLightbox(image.fullsize, image.alt)}
								>
									<img src={image.thumb} alt={image.alt || post.text || 'Jetstream image'} loading="lazy" />
								</button>
							{/each}
						</div>
					{/if}

					{#if post.text}
						<p class="post-text">{post.text}</p>
					{:else}
						<p class="post-text muted">Media post</p>
					{/if}

					<div class="post-footer">
						<span>{formatDateTime(post.createdAt)}</span>
						{#if post.tags.length > 0}
							<span>{post.tags.slice(0, 4).map((tag) => `#${tag}`).join(' ')}</span>
						{/if}
					</div>
				</article>
			{/each}
		</section>
	{/if}
</main>

<style>
	main {
		width: min(1440px, calc(100vw - 32px));
		margin: 0 auto;
		padding: 28px 0 56px;
	}

	.page-header {
		margin-bottom: 16px;
	}

	.title-row {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 18px;
	}

	h1 {
		margin: 0;
		color: var(--text-ink);
		font-size: clamp(2rem, 4vw, 3.6rem);
		line-height: 1;
		letter-spacing: 0;
	}

	.subtitle {
		margin: 8px 0 0;
		color: var(--muted);
		font-size: 1rem;
	}

	.control-panel,
	.queue-card,
	.empty-state {
		background: var(--panel-bg);
		box-shadow: var(--shadow-soft);
	}

	.control-panel {
		display: grid;
		gap: 12px;
		padding: 12px;
	}

	.action-row,
	.queue-controls,
	.template-actions,
	.action-group {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 8px;
	}

	.action-row,
	.queue-controls {
		justify-content: space-between;
	}

	button {
		min-height: 34px;
		border: 0;
		font-weight: 850;
		line-height: 1;
	}

	button:disabled {
		cursor: not-allowed;
		opacity: 0.52;
	}

	.primary-button,
	.secondary-button,
	.mini-button {
		padding: 0 13px;
	}

	.primary-button {
		background: var(--accent);
		color: var(--accent-contrast);
	}

	.secondary-button,
	.mini-button {
		background: var(--control-bg);
		color: var(--text-ink);
	}

	.mini-button {
		min-height: 28px;
		border: 1px solid var(--control-border);
		border-radius: 999px;
		font-size: 0.78rem;
	}

	.prompt-form {
		display: grid;
		gap: 6px;
	}

	label,
	.template-actions span {
		color: var(--muted);
		font-size: 0.78rem;
		font-weight: 800;
	}

	.confidence-control {
		display: inline-flex;
		align-items: center;
		flex: 1 1 260px;
		gap: 10px;
		max-width: 380px;
		min-height: 34px;
		padding: 0 10px;
		border: 1px solid var(--control-border);
		border-radius: 999px;
		background: var(--panel-bg-plain);
	}

	.confidence-control span {
		display: inline-flex;
		align-items: baseline;
		flex: 0 0 auto;
		gap: 5px;
		white-space: nowrap;
	}

	.confidence-control strong {
		color: var(--text-ink);
	}

	.confidence-control input {
		width: 100%;
		min-width: 100px;
		accent-color: var(--accent);
	}

	textarea {
		width: 100%;
		min-height: 150px;
		padding: 10px 12px;
		border: 1px solid var(--control-border);
		border-radius: 8px;
		background: var(--input-bg);
		color: var(--text-ink);
		font-size: 0.95rem;
		line-height: 1.35;
		resize: vertical;
	}

	.class-strip {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
	}

	.class-strip span {
		max-width: 360px;
		padding: 5px 8px;
		overflow: hidden;
		border: 1px solid var(--control-border);
		border-radius: 999px;
		background: color-mix(in srgb, var(--accent) 10%, var(--card-bg));
		color: var(--text-ink);
		font-size: 0.78rem;
		font-weight: 800;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.stats-grid {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
	}

	.stat {
		display: inline-flex;
		align-items: baseline;
		gap: 7px;
		min-width: 0;
		min-height: 28px;
		padding: 5px 8px;
		border: 1px solid var(--control-border);
		border-radius: 999px;
		background: var(--panel-bg-plain);
	}

	.stat span,
	.stat strong {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.stat span {
		color: var(--muted);
		font-size: 0.67rem;
		font-weight: 800;
		text-transform: uppercase;
	}

	.stat strong {
		color: var(--text-ink);
		font-size: 0.9rem;
	}

	.stat strong.live {
		color: #1d7f6e;
	}

	.progress-shell {
		height: 8px;
		overflow: hidden;
		border-radius: 999px;
		background: var(--muted-surface);
	}

	.progress-shell span {
		display: block;
		height: 100%;
		border-radius: inherit;
		background: var(--accent);
		transition: width 180ms ease;
	}

	.progress-shell.indeterminate span {
		animation: progress-sweep 1.35s ease-in-out infinite;
	}

	.model-hint {
		margin: -4px 0 0;
		color: var(--muted);
		font-size: 0.84rem;
		font-weight: 750;
		line-height: 1.3;
	}

	@keyframes progress-sweep {
		0% {
			transform: translateX(-115%);
		}
		50% {
			transform: translateX(90%);
		}
		100% {
			transform: translateX(300%);
		}
	}

	.error-row {
		display: grid;
		gap: 5px;
		padding: 8px 10px;
		border: 1px solid color-mix(in srgb, var(--danger-text) 38%, var(--control-border));
		border-radius: 8px;
		background: var(--error-bg);
		color: var(--danger-text);
		font-weight: 800;
	}

	.error-row p {
		margin: 0;
	}

	.queue-panel {
		display: grid;
		grid-template-columns: minmax(0, 0.9fr) minmax(320px, 1.3fr) minmax(280px, 0.9fr);
		gap: 10px;
		margin-top: 12px;
	}

	.queue-card {
		min-width: 0;
		padding: 12px;
	}

	.queue-heading {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		margin-bottom: 8px;
	}

	.queue-heading h2 {
		margin: 0;
		color: var(--text-ink);
		font-size: 1rem;
		line-height: 1.1;
	}

	.queue-heading span,
	.muted-copy {
		color: var(--muted);
		font-size: 0.82rem;
		font-weight: 800;
	}

	.queue-list {
		display: grid;
		gap: 7px;
		max-height: 270px;
		overflow: auto;
		padding-right: 2px;
	}

	.queue-post {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		gap: 4px 8px;
		padding: 8px;
		border: 1px solid var(--control-border);
		border-radius: 8px;
		background: var(--card-bg);
	}

	.queue-post.active-post {
		background: color-mix(in srgb, var(--accent) 10%, var(--card-bg));
	}

	.queue-post strong,
	.queue-post span {
		overflow: hidden;
		font-size: 0.78rem;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.queue-post strong {
		color: var(--text-ink);
	}

	.queue-post span {
		color: var(--muted);
	}

	.queue-post p {
		grid-column: 1 / -1;
		display: -webkit-box;
		margin: 0;
		overflow: hidden;
		color: var(--text-ink);
		font-size: 0.84rem;
		line-height: 1.25;
		-webkit-box-orient: vertical;
		-webkit-line-clamp: 2;
		line-clamp: 2;
	}

	.empty-state {
		margin-top: 16px;
		padding: 40px 20px;
		text-align: center;
	}

	.empty-state h2,
	.empty-state p {
		margin: 0;
	}

	.empty-state h2 {
		color: var(--muted);
		font-size: 1.2rem;
	}

	.empty-state p {
		margin-top: 6px;
		color: var(--muted);
		font-size: 0.9rem;
	}

	.filtered-gallery {
		column-width: 290px;
		column-gap: 12px;
		margin-top: 18px;
	}

	.post-card {
		display: inline-block;
		width: 100%;
		margin: 0 0 12px;
		padding: 12px;
		border: 1px solid var(--control-border);
		border-radius: 8px;
		background: var(--card-bg);
		box-shadow: var(--shadow-soft);
		break-inside: avoid;
		transition:
			transform 150ms ease,
			box-shadow 150ms ease;
	}

	.post-card:hover {
		transform: translateY(-2px);
		box-shadow: var(--shadow-medium);
	}

	.post-card-header {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 10px;
		margin-bottom: 9px;
	}

	.author-chip {
		display: flex;
		align-items: center;
		min-width: 0;
		gap: 8px;
	}

	.author-chip img {
		width: 34px;
		height: 34px;
		flex: 0 0 auto;
		border-radius: 999px;
		object-fit: cover;
	}

	.author-chip span {
		display: grid;
		min-width: 0;
		line-height: 1.1;
	}

	.author-chip strong,
	.author-chip small {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.author-chip strong {
		color: var(--text-ink);
		font-size: 0.92rem;
	}

	.author-chip small {
		color: var(--muted);
		font-size: 0.78rem;
	}

	.post-card-header a {
		flex: 0 0 auto;
		padding: 5px 8px;
		border: 1px solid var(--control-border);
		border-radius: 999px;
		background: var(--control-bg);
		font-size: 0.8rem;
		font-weight: 850;
	}

	.decision-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		margin-bottom: 6px;
	}

	.decision-row span,
	.decision-row strong {
		padding: 4px 8px;
		border-radius: 999px;
		font-size: 0.78rem;
		font-weight: 900;
	}

	.decision-row span {
		flex: 0 0 auto;
		min-width: 0;
		overflow: hidden;
		background: color-mix(in srgb, #2a9d8f 14%, var(--card-bg));
		color: color-mix(in srgb, #0e6d5d 72%, var(--text-ink));
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.decision-row strong {
		flex: 1 1 auto;
		min-width: 0;
		overflow: hidden;
		background: color-mix(in srgb, var(--accent) 14%, var(--card-bg));
		color: var(--warm-text);
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.image-grid {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 6px;
		margin: 8px 0 10px;
	}

	.image-grid.solo {
		grid-template-columns: 1fr;
	}

	.image-button {
		width: 100%;
		min-height: 0;
		padding: 0;
		overflow: hidden;
		border: 1px solid var(--control-border);
		border-radius: 8px;
		background: var(--muted-surface);
		aspect-ratio: var(--image-ratio);
	}

	.image-button img {
		display: block;
		width: 100%;
		height: 100%;
		object-fit: cover;
	}

	.image-grid.solo .image-button img {
		object-fit: contain;
	}

	.post-text {
		margin: 0;
		color: var(--text-ink);
		font-size: 0.96rem;
		line-height: 1.42;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}

	.post-text.muted {
		color: var(--muted);
		font-style: italic;
	}

	.post-footer {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
		margin-top: 10px;
		color: var(--muted);
		font-size: 0.78rem;
		font-weight: 800;
	}

	@media (max-width: 920px) {
		.queue-panel {
			grid-template-columns: 1fr;
		}
	}

	@media (max-width: 720px) {
		main {
			width: min(100vw - 20px, 100%);
			padding-top: 18px;
		}

		.title-row,
		.action-row,
		.queue-controls {
			display: grid;
			grid-template-columns: 1fr;
		}

		.action-group,
		.template-actions {
			width: 100%;
		}

		.action-group button,
		.template-actions button {
			flex: 1 1 auto;
		}

		.filtered-gallery {
			column-width: 220px;
			column-gap: 8px;
		}
	}
</style>
