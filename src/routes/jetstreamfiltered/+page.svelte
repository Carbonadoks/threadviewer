<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { DEFAULT_TAG_TEMPLATE, parseTagTemplate, matchingTags, type TagResult, type PostTag } from '$lib/utils/jetstreamTags';
	import { browser } from '$app/environment';
	import '../../app.css';
	import FontPicker from '$lib/components/FontPicker.svelte';
	import RouteNav from '$lib/components/RouteNav.svelte';
	import { getProfiles, type ProfileInfo } from '$lib/api/bluesky';
	import { openLightbox } from '$lib/stores/lightbox';
	import { buildAtUri, buildBskyPostUrl } from '$lib/utils/viewerLinks';

	type ModelState = 'idle' | 'checking' | 'loading' | 'ready' | 'error';
	type StreamStatus = 'idle' | 'connecting' | 'live' | 'closed' | 'error';
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
		tags: PostTag[];
		description: string;
		error?: string;
	};

	type ClassifiedPost = {
		post: QueuedPost;
		decision: ClassifierDecision;
		raw: string;
		processedAt: string;
	};

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
	const STORAGE_PROMPT_KEY = 'jetstream-typesafe-tag-template-v1';
	const STORAGE_FONT_KEY = 'preferred-font';
	const MAX_QUEUE_SIZE = 180;
	const MAX_ACCEPTED_POSTS = 140;
	const MAX_REJECTED_POSTS = 80;
	const MAX_SEEN_URIS = 1200;
	const MAX_PROMPT_TEXT_LENGTH = 1200;
	const PROFILE_BATCH_DELAY_MS = 220;
	const LIVE_CURSOR_REWIND_US = 12_000_000;
	const CLASSIFIER_DESCRIPTION_LIMIT = 100;
	const DEFAULT_CLASSIFIER_BATCH_SIZE = 6;
	const MAX_CLASSIFIER_BATCH_SIZE = 10;
	const CLASSIFIER_BATCH_WAIT_MS = 1000;
	const DEFAULT_PROMPT_TEMPLATE = DEFAULT_TAG_TEMPLATE;

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
	let modelStatus = $state('TypeSafe not connected');
	let modelError: string | null = $state(null);
	let tagThreshold = $state(0.75);
	let selectedTag = $state('');
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
	let languageSkipped = $state(0);
	let postsProcessed = $state(0);
	let promptFailures = $state(0);
	let batchSize = $state(DEFAULT_CLASSIFIER_BATCH_SIZE);
	let queuePaused = $state(false);
	let isClassifying = $state(false);

	type BlastCard = {
		id: number;
		text: string;
		style: string;
	};

	const MAX_BLAST_CARDS = 40;
	let blastMode = $state(false);
	let blastCards = $state<BlastCard[]>([]);
	let blastCardId = 0;
	let endpointIndex = 0;
	let profilesByDid = $state<Record<string, ProfileInfo>>({});

	let modelAbortController: AbortController | null = null;
	let promptAbortController: AbortController | null = null;
	let socket: WebSocket | null = null;
	let drainScheduled = false;
	let drainTimer: ReturnType<typeof setTimeout> | null = null;
	let profileBatchTimer: ReturnType<typeof setTimeout> | null = null;
	const pendingProfileDids = new Set<string>();
	const seenUris: string[] = [];
	const seenUriSet = new Set<string>();

	const fontFamily = $derived(fontFamilies[fontKey] ?? fontFamilies.patrick);
	const canLoadModel = $derived(modelState !== 'checking' && modelState !== 'loading');
	const canStartFirehose = $derived(
		modelState === 'ready' &&
			streamStatus !== 'connecting' &&
			streamStatus !== 'live'
	);
	const promptClasses = $derived(promptTemplate.split('\n').map(line => line.split(':')[0].trim()).filter(Boolean));
	const visiblePosts = $derived(selectedTag ? acceptedPosts.filter(item => item.decision.tags.some(tag => tag.name === selectedTag)) : acceptedPosts);
	const resultTags = $derived([...new Set(acceptedPosts.flatMap(item => item.decision.tags.map(tag => tag.name)))]);
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

	async function loadModel() {
		if (!browser || !canLoadModel) return;
		stopCurrentPrompt();
		const controller = new AbortController();
		modelAbortController = controller;
		modelState = 'checking';
		modelStatus = 'Checking TypeSafe configuration';
		modelError = null;
		try {
			const response = await fetch('/api/jetstreamfiltered', { signal: controller.signal });
			const data = await response.json() as { message?: string };
			if (!response.ok) throw new Error(data.message || 'TypeSafe is unavailable.');
			if (controller.signal.aborted) return;
			modelState = 'ready';
			modelStatus = 'TypeSafe configured · Jev';
			scheduleQueueDrain();
		} catch (error) {
			if (controller.signal.aborted) return;
			modelState = 'error';
			modelStatus = 'TypeSafe unavailable';
			modelError = describeError(error);
		}
	}

	function unloadModel() {
		stopCurrentPrompt();
		modelAbortController?.abort();
		modelState = 'idle';
		modelStatus = 'TypeSafe disconnected';
		if (drainTimer) clearTimeout(drainTimer);
		drainTimer = null;
		drainScheduled = false;
		disconnectJetstream();
	}

	function stopCurrentPrompt() {
		promptAbortController?.abort();
		promptAbortController = null;
	}

	function applyPromptTemplate(event: Event) {
		event.preventDefault();
		try {
			parseTagTemplate(promptTemplate);
			modelError = null;
			localStorage.setItem(STORAGE_PROMPT_KEY, promptTemplate);
			templateSavedAt = new Date().toISOString();
		} catch (error) { modelError = describeError(error); }
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
		if (!text && !images.some(image => image.alt.trim())) {
			textOnlySkipped += 1;
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
		// Unknown language is judged server-side; declared non-English posts skip inference.
		if (!post.langs.length || post.langs.some(lang => /^en(?:-|$)/i.test(lang))) return true;
		languageSkipped += 1;
		postsSkipped += 1;
		return false;
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
		if (queuePaused || isClassifying || modelState !== 'ready') return;
		const batch = pendingPosts.slice(0, classifierBatchSize());
		if (batch.length === 0) return;

		pendingPosts = pendingPosts.slice(batch.length);
		currentBatchPosts = batch;
		isClassifying = true;
		const controller = new AbortController();
		promptAbortController = controller;

		try {
			const threshold = Number(tagThreshold);
			const raw = await runClassifierPrompt(batch, controller.signal);
			const results = JSON.parse(raw).posts as TagResult[];
			const decisions = new Map(results.map(result => {
				const tags = matchingTags(result, threshold);
				const keep = result.eligible >= 0.75 && tags.length > 0;
				return [result.id, { keep, answer: keep ? 'YES' as const : 'NO' as const, confidence: result.eligible, tags,
					description: result.eligible < 0.75 ? 'Outside the English discovery feed criteria.' : tags.length ? tags.map(tag => tag.name).join(', ') : 'No tags above the threshold.' }];
			}));
			const processedAt = new Date().toISOString();
			const items = batch.map((post, index) => ({
				post,
				decision:
					decisions.get(batchPostId(index)) ??
					omittedDecision(),
				raw,
				processedAt
			}));
			postsProcessed += items.length;
			storeClassifiedItems(items);
		} catch (error) {
			if ((error as Error)?.name === 'AbortError') {
				pendingPosts = [...batch, ...pendingPosts].slice(0, MAX_QUEUE_SIZE);
			} else {
				queuePaused = true;
				modelError = describeError(error);
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
			tags: [],
			description,
			error: message
		};
	}

	function omittedDecision(): ClassifierDecision {
		return {
			keep: false,
			answer: 'NO',
			confidence: 0,
			tags: [],
			description: 'Not returned by model.'
		};
	}

	function blastCardStyle(stagger: number): string {
		const vw = window.innerWidth;
		const vh = window.innerHeight;
		// Spawn near the middle of the screen with some spray
		const ox = vw / 2 + (Math.random() - 0.5) * vw * 0.3;
		const oy = vh / 2 + (Math.random() - 0.5) * vh * 0.3;
		// Blast outward in a random direction, well past the screen edge
		const angle = Math.random() * Math.PI * 2;
		const dist = Math.hypot(vw, vh) * (0.6 + Math.random() * 0.6);
		const tx = Math.cos(angle) * dist;
		const ty = Math.sin(angle) * dist;
		const scale = 1.6 + Math.random() * 2.2;
		const rot = (Math.random() - 0.5) * 90;
		const dur = 1600 + Math.random() * 1400;
		const delay = stagger * 180 + Math.random() * 120;
		return (
			`left: ${ox.toFixed(0)}px; top: ${oy.toFixed(0)}px; ` +
			`--tx: ${tx.toFixed(0)}px; --ty: ${ty.toFixed(0)}px; ` +
			`--sc: ${scale.toFixed(2)}; --rot: ${rot.toFixed(1)}deg; ` +
			`--dur: ${dur.toFixed(0)}ms; --delay: ${delay.toFixed(0)}ms;`
		);
	}

	function spawnBlastCards(items: ClassifiedPost[]) {
		if (!browser || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
		const fresh = items
			.filter((item) => item.post.text.trim().length > 0)
			.map((item, i) => ({
				id: blastCardId++,
				text: item.post.text,
				style: blastCardStyle(i)
			}));
		if (fresh.length === 0) return;
		const next = [...blastCards, ...fresh];
		blastCards = next.length > MAX_BLAST_CARDS ? next.slice(next.length - MAX_BLAST_CARDS) : next;
	}

	function removeBlastCard(id: number) {
		blastCards = blastCards.filter((card) => card.id !== id);
	}

	function toggleBlastMode() {
		blastMode = !blastMode;
		if (!blastMode) blastCards = [];
	}

	function storeClassifiedItems(items: ClassifiedPost[]) {
		const accepted = items.filter((item) => item.decision.keep);
		const rejected = items.filter((item) => !item.decision.keep);
		postsAccepted += accepted.length;
		postsRejected += rejected.length;

		if (blastMode && accepted.length > 0) {
			spawnBlastCards(accepted);
		}

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
		parseTagTemplate(promptTemplate);
		const response = await fetch('/api/jetstreamfiltered', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			signal,
			body: JSON.stringify({
				template: promptTemplate,
				posts: posts.map((post, index) => ({ id: batchPostId(index), text: post.text.slice(0, MAX_PROMPT_TEXT_LENGTH), altText: post.images.slice(0, 4).map(image => image.alt.slice(0, 1000)) }))
			})
		});
		const data = await response.json() as { message?: string };
		if (!response.ok) throw new Error(data.message || 'TypeSafe request failed.');
		return JSON.stringify(data);
	}

	function pauseQueue() {
		queuePaused = true;
	}

	function resumeQueue() {
		queuePaused = false;
		modelError = null;
		scheduleQueueDrain();
	}

	function clearQueue() {
		pendingPosts = [];
	}

	function clearResults() {
		selectedTag = '';
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
		if (drainTimer) clearTimeout(drainTimer);
		if (profileBatchTimer) clearTimeout(profileBatchTimer);
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
				<p class="subtitle">TypeSafe AI tags over live Bluesky Jetstream posts · local development</p>
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
					{modelState === 'ready' ? 'Recheck TypeSafe' : 'Connect TypeSafe'}
				</button>
				<button
					type="button"
					class="secondary-button wobbly-border-light"
					disabled={modelState === 'idle'}
					onclick={unloadModel}
				>
					Disconnect
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

		<p class="muted-copy">Starting the stream sends sampled post text and image alt text to TypeSafe AI. Images themselves are not analyzed. A post may match several tags.</p>
		<form class="prompt-form" onsubmit={applyPromptTemplate}>
			<label for="prompt-template">Tags — one Tag: description per line</label>
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
			<label class="confidence-control" for="tag-threshold">
				<span>Tag probability threshold <strong>{formatPercent(tagThreshold)}</strong></span>
				<input id="tag-threshold" type="range" min="0.5" max="0.99" step="0.01" bind:value={tagThreshold} />
				<small>Applies to new batches. Show a post if any tag matches.</small>
			</label>
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
				<button
					type="button"
					class="secondary-button wobbly-border-light blast-toggle"
					class:active={blastMode}
					onclick={toggleBlastMode}
					title="Blast newly accepted posts across the screen as they arrive"
				>
					🔥 Blast mode {blastMode ? 'on' : 'off'}
				</button>
			</div>
		</div>

		<div class="stats-grid">
			<div class="stat">
				<span>Model</span>
				<strong class:live={modelState === 'ready'}>{modelStatus}</strong>
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
				<span>Non-English</span>
				<strong>{languageSkipped.toLocaleString()}</strong>
			</div>
		</div>

		{#if modelError || streamError}
			<div class="error-row">
				{#if modelError}
					<p>{modelError}</p>
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
					<button type="button" class="mini-button" onclick={() => { pauseQueue(); stopCurrentPrompt(); }}>Stop classification</button>
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
				English discovery feed: {postsSkipped.toLocaleString()} skipped,
				{promptFailures.toLocaleString()} classification failures
			</p>
		</section>
	{:else}
		<label for="tag-filter">Show tag</label>
		<select id="tag-filter" bind:value={selectedTag}>
			<option value="">All tags</option>
			{#each resultTags as tag}<option value={tag}>{tag}</option>{/each}
		</select>
		<p class="muted-copy">{visiblePosts.length} posts shown</p>
		<section class="filtered-gallery" aria-label="Jetstream filtered posts">
			{#each visiblePosts as item (item.post.uri)}
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
						{#each item.decision.tags as tag}
							<span title="Probability that this tag applies">{tag.name} {formatPercent(tag.probability)}</span>
						{/each}
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

{#if blastMode && blastCards.length > 0}
	<div class="blast-layer" aria-hidden="true" style="font-family: {fontFamily}">
		{#each blastCards as card (card.id)}
			<article
				class="blast-card"
				style={card.style}
				onanimationend={() => removeBlastCard(card.id)}
			>
				<p class="blast-text">{card.text}</p>
			</article>
		{/each}
	</div>
{/if}

<style>
	main {
		width: min(1440px, calc(100vw - 32px));
		margin: 0 auto;
		padding: 28px 0 56px;
	}

	.page-header {
		margin-bottom: 16px;
	}

	.blast-toggle.active {
		background: color-mix(in srgb, #e25822 22%, white);
		border-color: #e25822;
	}

	.blast-layer {
		position: fixed;
		inset: 0;
		z-index: 950;
		overflow: hidden;
		pointer-events: none;
	}

	.blast-card {
		position: absolute;
		width: min(300px, 70vw);
		padding: 10px 14px;
		background: rgba(255, 252, 246, 0.97);
		border-radius: 10px;
		box-shadow: 0 8px 32px rgba(0, 0, 0, 0.45);
		transform: translate(-50%, -50%) scale(0.05);
		animation: blast-out var(--dur, 1800ms) cubic-bezier(0.3, 0.6, 0.6, 1) both;
		animation-delay: var(--delay, 0ms);
		will-change: transform, opacity;
	}

	@keyframes blast-out {
		0% {
			transform: translate(-50%, -50%) scale(0.05) rotate(0deg);
			opacity: 0;
		}
		12% {
			opacity: 1;
		}
		75% {
			opacity: 1;
		}
		100% {
			transform: translate(calc(-50% + var(--tx, 0px)), calc(-50% + var(--ty, 0px)))
				scale(var(--sc, 2.5)) rotate(var(--rot, 0deg));
			opacity: 0;
		}
	}

	.blast-text {
		margin: 0;
		font-size: 0.85rem;
		line-height: 1.45;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
		display: -webkit-box;
		-webkit-line-clamp: 6;
		line-clamp: 6;
		-webkit-box-orient: vertical;
		overflow: hidden;
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

	.decision-row span {
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
