<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { browser } from '$app/environment';
	import '../../app.css';
	import FontPicker from '$lib/components/FontPicker.svelte';
	import RouteNav from '$lib/components/RouteNav.svelte';
	import { openLightbox } from '$lib/stores/lightbox';
	import { IMAGENET_LABELS } from '$lib/data/imagenetLabels';
	import { ClassifierPool, type ClassifierStats } from '$lib/utils/classifierPool';
	import type { Prediction } from '$lib/utils/classifierTypes';

	const JETSTREAM_URL = 'wss://jetstream2.us-east.bsky.network/subscribe';
	const MAX_GALLERY_ITEMS = 140;
	const MAX_GALLERY_CANDIDATES = 280;
	const MAX_STREAM_EVENTS = 80;
	const MAX_RECENT_POSTS_PER_TAG = 36;
	const MAX_TRACKED_STREAM_TAGS = 400;
	const STORAGE_TAGS_KEY = 'hashtag-gallery-tags';
	const STORAGE_BLACKLIST_KEY = 'hashtag-gallery-blacklist';
	const STORAGE_MODERATION_KEY = 'hashtag-gallery-moderation';
	const STORAGE_SEARCH_KEY = 'hashtag-gallery-search';
	const STORAGE_SEARCH_SCOPE_KEY = 'hashtag-gallery-search-scope';
	const STORAGE_CLASSIFIER_KEY = 'hashtag-gallery-classifier';
	// ImageNet class ranges, from the label table MobileNet was trained on.
	const CAT_LABELS = IMAGENET_LABELS.slice(281, 286);
	const BIG_CAT_LABELS = IMAGENET_LABELS.slice(286, 294);
	const DOG_LABELS = IMAGENET_LABELS.slice(151, 269);
	const MAX_LABEL_RESULTS = 160;
	const MAX_TRACKED_LABELS = 300;
	const MAX_RECENT_IMAGES_PER_LABEL = 36;
	const ADULT_CHECK_CACHE_TTL_MS = 45_000;
	const MODERATION_RECHECK_DELAY_MS = 12_000;
	const ADULT_LABEL_VALUES = new Set([
		'porn',
		'nsfw',
		'sexual',
		'suggestive',
		'nudity',
		'graphic-media',
		'gore',
		'!hide',
		'!warn',
		'!takedown'
	]);
	const ADULT_TAG_VALUES = new Set([
		'adult',
		'explicit',
		'gore',
		'hentai',
		'lewd',
		'nude',
		'nudity',
		'nsfw',
		'porn',
		'sexual'
	]);

	const fontFamilies: Record<string, string> = {
		virgil: "'Virgil', cursive",
		caveat: "'Caveat', cursive",
		patrick: "'Patrick Hand', cursive",
		'comic-neue': "'Comic Neue', cursive",
		inter: "'Inter', sans-serif",
		system: "system-ui, -apple-system, sans-serif"
	};

	type StreamStatus = 'idle' | 'connecting' | 'open' | 'closed' | 'error';

	type GalleryImage = {
		id: string;
		postUri: string;
		postUrl: string;
		thumb: string;
		fullsize: string;
		alt: string;
		aspectRatio: string;
		tags: string[];
		text: string;
		matchedTerms: string[];
		matchedQueries: string[];
		similarity: number;
		predictions: Prediction[];
		classifierChecked: boolean;
		classifierMatched: string[];
		createdAt: string;
		authorDid: string;
		moderationChecked: boolean;
		moderationBlocked: boolean;
		moderationLabels: string[];
	};

	type AdultCheck = {
		blocked: boolean;
		labels: string[];
	};

	type AdultCheckCacheEntry = {
		checkedAt: number;
		promise: Promise<AdultCheck>;
	};

	type ClassifierLabelStat = {
		label: string;
		hits: number;
		lastSeenAt: string;
	};

	type SemanticQuery = {
		id: string;
		kind: 'text' | 'image';
		label: string;
		thumb?: string;
	};

	type ClassifiedImage = {
		id: string;
		postUri: string;
		postUrl: string;
		thumb: string;
		fullsize: string;
		alt: string;
		aspectRatio: string;
		createdAt: string;
		probability: number;
	};

	type StreamTagStats = {
		tag: string;
		posts: number;
		imagePosts: number;
		lastSeenAt: string;
	};

	type StreamEventImage = {
		id: string;
		thumb: string;
		fullsize: string;
		alt: string;
		aspectRatio: string;
		authorDid: string;
	};

	type BlastCard = {
		id: number;
		thumb: string;
		aspectRatio: string;
		style: string;
	};

	type StreamTagEvent = {
		id: string;
		uri: string;
		tags: string[];
		hasImages: boolean;
		createdAt: string;
		postUrl: string;
		text: string;
		images: StreamEventImage[];
		ownLabels: string[];
		moderationBlocked: boolean;
		moderationChecked: boolean;
		moderationLabels: string[];
	};

	let fontKey = $state('patrick');
	let fontFamily = $derived(fontFamilies[fontKey] ?? fontFamilies.patrick);
	let tagInput = $state('art, photography, nature');
	let blacklistInput = $state('');
	let searchInput = $state('');
	let searchTerms = $state<string[]>([]);
	let searchInText = $state(true);
	let searchInAlt = $state(true);
	let watchedTags = $state<string[]>(['art', 'photography', 'nature']);
	let blacklistedTags = $state<string[]>([]);
	let status = $state<StreamStatus>('idle');
	let statusMessage = $state('Ready');
	let galleryCandidates = $state<GalleryImage[]>([]);
	let postsSeen = $state(0);
	let imagePostsSeen = $state(0);
	let matchingPostsSeen = $state(0);
	let searchMatchingPostsSeen = $state(0);
	let moderationChecks = $state(0);
	let moderationEnabled = $state(true);
	let analyticsOpen = $state(false);
	let blacklistOpen = $state(false);
	let selectedAnalyticsTag = $state<string | null>(null);
	let streamTagStats = $state<Record<string, StreamTagStats>>({});
	let recentPostsByTag = $state<Record<string, StreamTagEvent[]>>({});
	let recentStreamEvents = $state<StreamTagEvent[]>([]);
	let streamTaggedPostsSeen = $state(0);
	let streamImageTaggedPostsSeen = $state(0);
	let lastEventAt: string | null = $state(null);
	const MAX_BLAST_CARDS = 40;
	let blastMode = $state(false);
	let blastCards = $state<BlastCard[]>([]);
	let blastCardId = 0;
	const blastedImageIds = new Set<string>();
	let classifierEnabled = $state(false);
	let classifierStrict = $state(false);
	let classifierLabels = $state<string[]>([...CAT_LABELS]);
	let classifierThreshold = $state(0.2);
	let classifierWorkers = $state(4);
	let classifierPanelOpen = $state(false);
	let labelQuery = $state('');
	let classifierStats = $state<ClassifierStats | null>(null);
	let classifierMatches = $state(0);
	let classifierLabelStats = $state<Record<string, ClassifierLabelStat>>({});
	let recentImagesByLabel = $state<Record<string, ClassifiedImage[]>>({});
	let selectedClassifierLabel = $state<string | null>(null);
	let classifierAnalyticsOpen = $state(false);
	let predictionVersion = $state(0);
	const labelStatBuffer = new Map<string, { hits: number; lastSeenAt: string }>();
	const labelImageBuffer = new Map<string, ClassifiedImage[]>();
	const predictionsByImageId = new Map<string, Prediction[]>();
	// Metadata for anything handed to the classifier, so a result can be rendered
	// even when the image never entered the gallery.
	const classifiedImageMeta = new Map<string, Omit<ClassifiedImage, 'probability'>>();
	const dismissedImageIds = new Set<string>();
	let socket: WebSocket | null = null;
	let seenImageIds = new Set<string>();
	let embedderEnabled = $state(false);
	let embedderWorkers = $state(2);
	let semanticQueries = $state<SemanticQuery[]>([]);
	let semanticInput = $state('');
	let semanticBusy = $state(false);
	let semanticError = $state('');
	let textThreshold = $state(0.08);
	let imageThreshold = $state(0.72);
	let embedStats = $state<ClassifierStats | null>(null);
	let pool: ClassifierPool | null = null;
	let embedPool: ClassifierPool | null = null;
	let latestStats: ClassifierStats | null = null;
	let latestEmbedStats: ClassifierStats | null = null;
	let statsTimer: ReturnType<typeof setInterval> | null = null;
	const queryEmbeddings = new Map<string, Float32Array>();
	const embeddingById = new Map<string, Float32Array>();
	let semanticQueryCounter = 0;
	// Images fetched purely for the classifier: they only enter the gallery if they hit.
	const pendingClassification = new Map<string, GalleryImage>();
	// Same idea for the embedder: held until a reference similarity clears.
	const pendingSemantic = new Map<string, GalleryImage>();
	const adultCheckCache = new Map<string, AdultCheckCacheEntry>();
	const activeModerationRefreshes = new Set<string>();

	const classifierLabelSet = $derived(new Set(classifierLabels));
	const classifierActive = $derived(classifierEnabled && classifierLabels.length > 0);
	const watchedTagSet = $derived(new Set(watchedTags.map((tag) => tag.toLowerCase())));
	const blacklistedTagSet = $derived(new Set(blacklistedTags.map((tag) => tag.toLowerCase())));
	const galleryItems = $derived(
		galleryCandidates
			.filter(
				(item) =>
					!hasBlacklistedTag(item.tags) &&
					(!moderationEnabled || (item.moderationChecked && !item.moderationBlocked)) &&
					(!classifierStrict || !classifierActive || item.classifierMatched.length > 0)
			)
			.slice(0, MAX_GALLERY_ITEMS)
	);
	const hiddenCandidatePostUris = $derived(
		galleryCandidates
			.filter((item) => item.moderationBlocked && !hasBlacklistedTag(item.tags))
			.map((item) => item.postUri)
	);
	const adultHiddenPosts = $derived(
		moderationEnabled ? new Set(hiddenCandidatePostUris).size : 0
	);
	const galleryTags = $derived(
		watchedTags.map((tag) => ({
			tag,
			count: galleryItems.filter((item) => item.tags.includes(tag)).length
		}))
	);
	const galleryTerms = $derived(
		searchTerms.map((term) => ({
			term,
			count: galleryItems.filter((item) => item.matchedTerms.includes(term)).length
		}))
	);
	const galleryLabels = $derived(
		classifierLabels
			.map((label) => ({
				label,
				count: galleryItems.filter((item) => item.classifierMatched.includes(label)).length
			}))
			.filter((entry) => entry.count > 0 || classifierLabels.length <= 12)
	);
	const semanticActive = $derived(embedderEnabled && semanticQueries.length > 0);
	const hasFilters = $derived(
		watchedTags.length > 0 || searchTerms.length > 0 || classifierActive || semanticActive
	);
	const galleryQueries = $derived(
		semanticQueries.map((query) => ({
			query,
			count: galleryItems.filter((item) => item.matchedQueries.includes(query.id)).length
		}))
	);
	const labelResults = $derived.by(() => {
		const query = labelQuery.trim().toLowerCase();
		const matches = query
			? IMAGENET_LABELS.filter((label) => label.toLowerCase().includes(query))
			: IMAGENET_LABELS;
		return { total: matches.length, shown: matches.slice(0, MAX_LABEL_RESULTS) };
	});
	const searchScopeLabel = $derived(
		searchInText && searchInAlt
			? 'text + alt'
			: searchInText
				? 'text only'
				: searchInAlt
					? 'alt only'
					: 'no fields'
	);
	const topStreamTags = $derived(
		Object.values(streamTagStats)
			.filter((entry) => !blacklistedTagSet.has(entry.tag))
			.sort(
				(a, b) =>
					b.imagePosts - a.imagePosts ||
					b.posts - a.posts ||
					b.lastSeenAt.localeCompare(a.lastSeenAt) ||
					a.tag.localeCompare(b.tag)
			)
			.slice(0, 60)
	);
	const topClassifierLabels = $derived(
		Object.values(classifierLabelStats)
			.sort(
				(a, b) => b.hits - a.hits || b.lastSeenAt.localeCompare(a.lastSeenAt) || a.label.localeCompare(b.label)
			)
			.slice(0, 48)
	);
	const selectedLabelImages = $derived(
		selectedClassifierLabel ? (recentImagesByLabel[selectedClassifierLabel] ?? []) : []
	);
	const classifiedTotal = $derived(
		Object.values(classifierLabelStats).reduce((total, entry) => total + entry.hits, 0)
	);
	// predictionsByImageId is a plain Map (it churns far too fast to be reactive);
	// reading predictionVersion is what re-renders the badges after each flush.
	const predictionIndex = $derived.by(() => {
		predictionVersion;
		return predictionsByImageId;
	});
	const newestFirst = $derived([...galleryItems].sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
	const visibleRecentStreamEvents = $derived(
		recentStreamEvents.filter((event) => isVisibleStreamEvent(event))
	);
	const selectedAnalyticsPosts = $derived(
		selectedAnalyticsTag && !blacklistedTagSet.has(selectedAnalyticsTag)
			? (recentPostsByTag[selectedAnalyticsTag] ?? []).filter((event) =>
					isVisibleStreamEvent(event)
				)
			: []
	);
	const blacklistButtonLabel = $derived(
		blacklistOpen
			? 'Hide blacklist'
			: `Blacklist${blacklistedTags.length > 0 ? ` (${blacklistedTags.length})` : ''}`
	);

	function handleFontChange(key: string) {
		fontKey = key;
		try {
			localStorage.setItem('preferred-font', key);
		} catch {}
	}

	function setModerationEnabled(nextEnabled: boolean) {
		moderationEnabled = nextEnabled;
		try {
			localStorage.setItem(STORAGE_MODERATION_KEY, nextEnabled ? '1' : '0');
		} catch {}
	}

	function handleModerationChange(event: Event) {
		const target = event.currentTarget as HTMLInputElement;
		setModerationEnabled(target.checked);
	}

	function parseTagList(value: string): string[] {
		const next = value
			.split(/[\s,]+/)
			.map((tag) => tag.replace(/^#/, '').trim().toLowerCase())
			.filter((tag) => /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(tag));
		return [...new Set(next)];
	}

	// Search terms are comma separated so a single term can contain spaces.
	function parseSearchTerms(value: string): string[] {
		const next = value
			.split(',')
			.map((term) => term.trim().toLowerCase().replace(/\s+/g, ' '))
			.filter(Boolean);
		return [...new Set(next)];
	}

	function matchedTagsFor(tags: string[]): string[] {
		return tags.filter((tag) => watchedTagSet.has(tag.toLowerCase()));
	}

	// A term matches when it appears in the post text or in that image's alt text,
	// depending on which scopes are enabled.
	function matchedTermsFor(text: string, alt: string): string[] {
		if (searchTerms.length === 0) return [];
		const haystacks: string[] = [];
		if (searchInText && text) haystacks.push(text.toLowerCase());
		if (searchInAlt && alt) haystacks.push(alt.toLowerCase());
		if (haystacks.length === 0) return [];
		return searchTerms.filter((term) => haystacks.some((hay) => hay.includes(term)));
	}

	function eventMatchesSearch(text: string, images: StreamEventImage[]): boolean {
		if (searchTerms.length === 0) return false;
		if (matchedTermsFor(text, '').length > 0) return true;
		return images.some((image) => matchedTermsFor(text, image.alt).length > 0);
	}

	// Embeddings arrive L2-normalized, so cosine similarity is just a dot product.
	function cosine(a: Float32Array, b: Float32Array): number {
		if (a.length !== b.length) return 0;
		let total = 0;
		for (let i = 0; i < a.length; i += 1) total += a[i] * b[i];
		return total;
	}

	// Text and image references live on very different similarity scales, so each
	// kind carries its own threshold.
	function thresholdFor(kind: SemanticQuery['kind']): number {
		return kind === 'text' ? textThreshold : imageThreshold;
	}

	function matchedQueriesFor(embedding: Float32Array | undefined): {
		ids: string[];
		best: number;
	} {
		if (!embedding || !semanticActive) return { ids: [], best: 0 };
		const ids: string[] = [];
		let best = 0;
		for (const query of semanticQueries) {
			const reference = queryEmbeddings.get(query.id);
			if (!reference) continue;
			const score = cosine(embedding, reference);
			if (score > best) best = score;
			if (score >= thresholdFor(query.kind)) ids.push(query.id);
		}
		return { ids, best };
	}

	function matchedLabelsFor(predictions: Prediction[]): string[] {
		if (!classifierActive || predictions.length === 0) return [];
		return predictions
			.filter(
				(prediction) =>
					prediction.probability >= classifierThreshold && classifierLabelSet.has(prediction.label)
			)
			.map((prediction) => prediction.label);
	}

	// classify() returns predictions already sorted by probability.
	function topPredictionFor(
		index: Map<string, Prediction[]>,
		imageId: string
	): Prediction | null {
		const predictions = index.get(imageId);
		const best = predictions?.[0];
		return best && best.probability >= classifierThreshold ? best : null;
	}

	// Gallery membership is tag match OR search match OR classifier match, recomputed
	// from the stored text/predictions whenever any of those criteria change.
	function refilterGallery() {
		galleryCandidates = hasFilters
			? galleryCandidates
					.map((item) => {
						const semantic = matchedQueriesFor(embeddingById.get(item.id));
						return {
							...item,
							matchedTerms: matchedTermsFor(item.text, item.alt),
							classifierMatched: matchedLabelsFor(item.predictions),
							matchedQueries: semantic.ids,
							similarity: semantic.best
						};
					})
					.filter(
						(item) =>
							matchedTagsFor(item.tags).length > 0 ||
							item.matchedTerms.length > 0 ||
							item.classifierMatched.length > 0 ||
							item.matchedQueries.length > 0
					)
			: [];
		seenImageIds = new Set([
			...galleryCandidates.map((item) => item.id),
			...pendingClassification.keys(),
			...pendingSemantic.keys()
		]);
	}

	function handleClassifierResult(id: string, predictions: Prediction[]) {
		if (dismissedImageIds.has(id)) return;
		recordLabelStats(id, predictions, new Date().toISOString());
		const matched = matchedLabelsFor(predictions);
		if (matched.length > 0) classifierMatches += 1;

		const pending = pendingClassification.get(id);
		if (pending) {
			pendingClassification.delete(id);
			// Classifier-sourced images earn their slot only by matching a selected label.
			if (matched.length === 0) return;
			const item: GalleryImage = {
				...pending,
				predictions,
				classifierChecked: true,
				classifierMatched: matched
			};
			galleryCandidates = [item, ...galleryCandidates].slice(0, MAX_GALLERY_CANDIDATES);
			maybeBlastImages([item]);
			void moderateImagePost(
				item.postUri,
				{ blocked: item.moderationBlocked, labels: item.moderationLabels },
				item.createdAt
			);
			return;
		}

		// A miss on an already-admitted image changes nothing on screen unless strict mode
		// is gating on it — skip the copy so misses (the common case) stay free.
		if (matched.length === 0 && !classifierStrict) return;

		galleryCandidates = galleryCandidates.map((item) =>
			item.id === id
				? { ...item, predictions, classifierChecked: true, classifierMatched: matched }
				: item
		);
	}

	// cdn.bsky.app serves no access-control-allow-origin header, so reading pixels
	// cross-origin is blocked; the bytes have to come back through our own origin.
	function classifierSourceUrl(thumb: string): string {
		return `/api/img?url=${encodeURIComponent(thumb)}`;
	}

	function submitForClassification(item: GalleryImage) {
		if (!classifierEnabled) return;
		classifiedImageMeta.set(item.id, {
			id: item.id,
			postUri: item.postUri,
			postUrl: item.postUrl,
			thumb: item.thumb,
			fullsize: item.fullsize,
			alt: item.alt,
			aspectRatio: item.aspectRatio,
			createdAt: item.createdAt
		});
		if (classifiedImageMeta.size > 4000) {
			const oldest = classifiedImageMeta.keys().next().value;
			if (oldest) classifiedImageMeta.delete(oldest);
		}
		pool?.submit({ id: item.id, url: classifierSourceUrl(item.thumb) });
	}

	// Buffered so a few hundred results a second do not each trigger a render;
	// flushClassifierBuffers() drains these on the stats interval.
	function recordLabelStats(id: string, predictions: Prediction[], seenAt: string) {
		predictionsByImageId.set(id, predictions);
		if (predictionsByImageId.size > 4000) {
			const oldest = predictionsByImageId.keys().next().value;
			if (oldest) predictionsByImageId.delete(oldest);
		}
		const meta = classifiedImageMeta.get(id);
		for (const prediction of predictions) {
			if (prediction.probability < classifierThreshold) continue;
			const current = labelStatBuffer.get(prediction.label);
			labelStatBuffer.set(prediction.label, {
				hits: (current?.hits ?? 0) + 1,
				lastSeenAt: seenAt
			});
			if (!meta) continue;
			const images = labelImageBuffer.get(prediction.label) ?? [];
			images.push({ ...meta, probability: prediction.probability });
			labelImageBuffer.set(prediction.label, images.slice(-MAX_RECENT_IMAGES_PER_LABEL));
		}
	}

	function flushClassifierBuffers() {
		if (latestStats) classifierStats = latestStats;
		if (latestEmbedStats) embedStats = latestEmbedStats;
		if (labelStatBuffer.size === 0) return;

		let next: Record<string, ClassifierLabelStat> = { ...classifierLabelStats };
		for (const [label, delta] of labelStatBuffer.entries()) {
			const current = next[label];
			next[label] = {
				label,
				hits: (current?.hits ?? 0) + delta.hits,
				lastSeenAt: delta.lastSeenAt
			};
		}
		labelStatBuffer.clear();

		const entries = Object.values(next);
		if (entries.length > MAX_TRACKED_LABELS) {
			next = Object.fromEntries(
				entries
					.sort((a, b) => b.hits - a.hits || b.lastSeenAt.localeCompare(a.lastSeenAt))
					.slice(0, MAX_TRACKED_LABELS)
					.map((entry) => [entry.label, entry])
			);
		}
		classifierLabelStats = next;

		if (labelImageBuffer.size > 0) {
			const nextImages: Record<string, ClassifiedImage[]> = { ...recentImagesByLabel };
			for (const [label, images] of labelImageBuffer.entries()) {
				const fresh = images.filter((image) => !dismissedImageIds.has(image.id)).reverse();
				const seen = new Set(fresh.map((image) => image.id));
				nextImages[label] = [
					...fresh,
					...(nextImages[label] ?? []).filter((image) => !seen.has(image.id))
				].slice(0, MAX_RECENT_IMAGES_PER_LABEL);
			}
			labelImageBuffer.clear();
			// Only keep image lists for labels still in the ranking.
			recentImagesByLabel = Object.fromEntries(
				Object.entries(nextImages).filter(([label]) => Boolean(next[label]))
			);
		}
		predictionVersion += 1;
	}

	function selectClassifierLabel(label: string) {
		selectedClassifierLabel = label;
		classifierAnalyticsOpen = true;
	}

	// Dismissing pulls the image out of the gallery and every label list, and keeps
	// it out: its id stays in seenImageIds so the live path will not re-add it.
	function dismissClassifiedImage(id: string) {
		dismissedImageIds.add(id);
		pendingClassification.delete(id);
		pendingSemantic.delete(id);
		galleryCandidates = galleryCandidates.filter((item) => item.id !== id);
		recentImagesByLabel = Object.fromEntries(
			Object.entries(recentImagesByLabel).map(([label, images]) => [
				label,
				images.filter((image) => image.id !== id)
			])
		);
	}

	function dismissLabelImages(label: string) {
		const images = recentImagesByLabel[label] ?? [];
		if (images.length === 0) return;
		const ids = new Set(images.map((image) => image.id));
		for (const id of ids) {
			dismissedImageIds.add(id);
			pendingClassification.delete(id);
			pendingSemantic.delete(id);
		}
		galleryCandidates = galleryCandidates.filter((item) => !ids.has(item.id));
		recentImagesByLabel = Object.fromEntries(
			Object.entries(recentImagesByLabel).map(([key, entries]) => [
				key,
				entries.filter((image) => !ids.has(image.id))
			])
		);
	}

	function handleEmbeddingResult(id: string, embedding?: Float32Array) {
		if (!embedding || dismissedImageIds.has(id)) return;
		embeddingById.set(id, embedding);
		if (embeddingById.size > 4000) {
			const oldest = embeddingById.keys().next().value;
			if (oldest) embeddingById.delete(oldest);
		}

		const semantic = matchedQueriesFor(embedding);
		const pending = pendingSemantic.get(id);
		if (pending) {
			pendingSemantic.delete(id);
			// A reference-only candidate earns its slot by clearing a threshold.
			if (semantic.ids.length === 0) return;
			const item: GalleryImage = {
				...pending,
				matchedQueries: semantic.ids,
				similarity: semantic.best
			};
			galleryCandidates = [item, ...galleryCandidates].slice(0, MAX_GALLERY_CANDIDATES);
			maybeBlastImages([item]);
			void moderateImagePost(
				item.postUri,
				{ blocked: item.moderationBlocked, labels: item.moderationLabels },
				item.createdAt
			);
			return;
		}

		if (semantic.ids.length === 0) return;
		galleryCandidates = galleryCandidates.map((item) =>
			item.id === id
				? { ...item, matchedQueries: semantic.ids, similarity: semantic.best }
				: item
		);
	}

	// One timer drives both pools' readouts; it lives as long as either is up.
	function ensureStatsTimer() {
		if (statsTimer === null) statsTimer = setInterval(flushClassifierBuffers, 250);
	}

	function maybeStopStatsTimer() {
		if (pool || embedPool || statsTimer === null) return;
		clearInterval(statsTimer);
		statsTimer = null;
	}

	function ensureEmbedderPool() {
		if (!browser || embedPool) return;
		ensureStatsTimer();
		embedPool = new ClassifierPool({
			workers: embedderWorkers,
			createWorker: () =>
				new Worker(new URL('../../lib/workers/siglipEmbedder.worker.ts', import.meta.url), {
					type: 'module'
				}),
			onResult: (id, _predictions, embedding) => handleEmbeddingResult(id, embedding),
			onDropped: (id) => pendingSemantic.delete(id),
			onStats: (stats) => (latestEmbedStats = stats)
		});
	}

	function teardownEmbedderPool() {
		embedPool?.dispose();
		embedPool = null;
		latestEmbedStats = null;
		embedStats = null;
		pendingSemantic.clear();
		maybeStopStatsTimer();
	}

	function setEmbedderEnabled(next: boolean) {
		embedderEnabled = next;
		if (next) ensureEmbedderPool();
		else teardownEmbedderPool();
		refilterGallery();
		persistClassifier();
	}

	function submitForEmbedding(item: GalleryImage) {
		if (!embedderEnabled) return;
		embedPool?.submit({ id: item.id, url: classifierSourceUrl(item.thumb) });
	}

	async function addTextQuery() {
		const value = semanticInput.trim();
		if (!value || semanticBusy) return;
		ensureEmbedderPool();
		semanticBusy = true;
		semanticError = '';
		try {
			// First call pulls the text tower down; later queries are instant.
			const embedding = await embedPool!.embedText(value);
			const id = `q${(semanticQueryCounter += 1)}`;
			queryEmbeddings.set(id, embedding);
			semanticQueries = [...semanticQueries, { id, kind: 'text', label: value }];
			semanticInput = '';
			refilterGallery();
		} catch (error) {
			semanticError = error instanceof Error ? error.message : String(error);
		} finally {
			semanticBusy = false;
		}
	}

	function pinImageQuery(item: GalleryImage | ClassifiedImage, label: string) {
		const embedding = embeddingById.get(item.id);
		if (!embedding) {
			semanticError = 'No embedding for that image yet — give the embedder a moment.';
			return;
		}
		const id = `q${(semanticQueryCounter += 1)}`;
		queryEmbeddings.set(id, embedding);
		semanticQueries = [
			...semanticQueries,
			{ id, kind: 'image', label, thumb: item.thumb }
		];
		semanticError = '';
		refilterGallery();
	}

	function removeSemanticQuery(id: string) {
		semanticQueries = semanticQueries.filter((query) => query.id !== id);
		queryEmbeddings.delete(id);
		refilterGallery();
	}

	function setTextThreshold(value: number) {
		textThreshold = Math.min(0.5, Math.max(0.01, value));
		refilterGallery();
	}

	function setImageThreshold(value: number) {
		imageThreshold = Math.min(0.99, Math.max(0.3, value));
		refilterGallery();
	}

	function ensureClassifierPool() {
		if (!browser || pool) return;
		pool = new ClassifierPool({
			workers: classifierWorkers,
			createWorker: () =>
				new Worker(new URL('../../lib/workers/mobilenetClassifier.worker.ts', import.meta.url), {
					type: 'module'
				}),
			onResult: handleClassifierResult,
			onDropped: (id) => pendingClassification.delete(id),
			// The pool reports after every job; sample it instead of re-rendering per image.
			onStats: (stats) => (latestStats = stats)
		});
		ensureStatsTimer();
	}

	function teardownClassifierPool() {
		pool?.dispose();
		pool = null;
		latestStats = null;
		classifierStats = null;
		pendingClassification.clear();
		labelStatBuffer.clear();
		maybeStopStatsTimer();
	}

	function persistClassifier() {
		try {
			localStorage.setItem(
				STORAGE_CLASSIFIER_KEY,
				JSON.stringify({
					enabled: classifierEnabled,
					strict: classifierStrict,
					labels: classifierLabels,
					threshold: classifierThreshold,
					workers: classifierWorkers,
					embedder: embedderEnabled,
					embedderWorkers,
					textThreshold,
					imageThreshold
				})
			);
		} catch {}
	}

	function setClassifierEnabled(next: boolean) {
		classifierEnabled = next;
		if (next) {
			ensureClassifierPool();
			classifierPanelOpen = true;
		} else {
			teardownClassifierPool();
		}
		refilterGallery();
		persistClassifier();
	}

	function setClassifierWorkers(count: number) {
		classifierWorkers = Math.max(1, Math.min(16, Math.round(count)));
		pool?.setWorkerCount(classifierWorkers);
		persistClassifier();
	}

	function setClassifierThreshold(value: number) {
		classifierThreshold = Math.min(0.95, Math.max(0.01, value));
		refilterGallery();
		persistClassifier();
	}

	function setClassifierStrict(next: boolean) {
		classifierStrict = next;
		persistClassifier();
	}

	function toggleLabel(label: string) {
		classifierLabels = classifierLabels.includes(label)
			? classifierLabels.filter((candidate) => candidate !== label)
			: [...classifierLabels, label];
		refilterGallery();
		persistClassifier();
	}

	function setLabels(labels: readonly string[]) {
		classifierLabels = [...labels];
		refilterGallery();
		persistClassifier();
	}

	function addLabels(labels: readonly string[]) {
		setLabels([...new Set([...classifierLabels, ...labels])]);
	}

	function applyTags() {
		const nextTags = parseTagList(tagInput);
		watchedTags = nextTags;
		tagInput = nextTags.join(', ');
		refilterGallery();
		try {
			localStorage.setItem(STORAGE_TAGS_KEY, tagInput);
		} catch {}
		updateQuery();
		for (const tag of nextTags) {
			void hydrateGalleryFromRecentTag(tag);
		}
	}

	function applySearch() {
		searchTerms = parseSearchTerms(searchInput);
		searchInput = searchTerms.join(', ');
		refilterGallery();
		persistSearch();
		hydrateGalleryFromSearch();
	}

	function persistSearch() {
		try {
			localStorage.setItem(STORAGE_SEARCH_KEY, searchTerms.join(', '));
			localStorage.setItem(
				STORAGE_SEARCH_SCOPE_KEY,
				`${searchInText ? 'text' : ''}${searchInText && searchInAlt ? ',' : ''}${searchInAlt ? 'alt' : ''}`
			);
		} catch {}
		updateQuery();
	}

	function setSearchScope(scope: 'text' | 'alt', enabled: boolean) {
		if (scope === 'text') searchInText = enabled;
		else searchInAlt = enabled;
		refilterGallery();
		persistSearch();
		hydrateGalleryFromSearch();
	}

	function removeSearchTerm(term: string) {
		searchTerms = searchTerms.filter((candidate) => candidate !== term);
		searchInput = searchTerms.join(', ');
		refilterGallery();
		persistSearch();
	}

	function updateQuery() {
		if (!browser) return;
		const next = new URL(window.location.href);
		if (watchedTags.length > 0) {
			next.searchParams.set('tags', watchedTags.join(','));
		} else {
			next.searchParams.delete('tags');
		}
		if (searchTerms.length > 0) {
			next.searchParams.set('q', searchTerms.join(','));
			next.searchParams.set(
				'in',
				[searchInText ? 'text' : null, searchInAlt ? 'alt' : null].filter(Boolean).join(',')
			);
		} else {
			next.searchParams.delete('q');
			next.searchParams.delete('in');
		}
		window.history.replaceState({}, '', next.toString());
	}

	function persistTags() {
		tagInput = watchedTags.join(', ');
		try {
			localStorage.setItem(STORAGE_TAGS_KEY, tagInput);
		} catch {}
		updateQuery();
	}

	function persistBlacklist() {
		blacklistInput = blacklistedTags.join(', ');
		try {
			localStorage.setItem(STORAGE_BLACKLIST_KEY, blacklistInput);
		} catch {}
	}

	function applyBlacklist() {
		const nextTags = parseTagList(blacklistInput);
		blacklistedTags = nextTags;
		dropBlacklistedAnalyticsTags(nextTags);
		persistBlacklist();
	}

	function blacklistTag(tag: string) {
		if (blacklistedTags.includes(tag)) return;
		blacklistedTags = [...blacklistedTags, tag];
		dropBlacklistedAnalyticsTags([tag]);
		persistBlacklist();
	}

	function removeBlacklistedTag(tag: string) {
		blacklistedTags = blacklistedTags.filter((candidate) => candidate !== tag);
		persistBlacklist();
	}

	function hasBlacklistedTag(tags: string[]): boolean {
		return tags.some((tag) => blacklistedTagSet.has(tag.toLowerCase()));
	}

	function isBlacklistedTag(tag: string | null): boolean {
		return Boolean(tag && blacklistedTagSet.has(tag));
	}

	function isWatchedTag(tag: string | null): boolean {
		return Boolean(tag && watchedTagSet.has(tag));
	}

	function visibleTags(tags: string[]): string[] {
		return tags.filter((tag) => !blacklistedTagSet.has(tag.toLowerCase()));
	}

	function isVisibleStreamEvent(event: StreamTagEvent): boolean {
		return visibleTags(event.tags).length > 0;
	}

	function visibleEventImages(event: StreamTagEvent): StreamEventImage[] {
		return event.images;
	}

	function dropBlacklistedAnalyticsTags(tags: string[]) {
		const blocked = new Set(tags.map((tag) => tag.toLowerCase()));
		if (blocked.size === 0) return;
		streamTagStats = Object.fromEntries(
			Object.entries(streamTagStats).filter(([tag]) => !blocked.has(tag.toLowerCase()))
		);
		recentPostsByTag = Object.fromEntries(
			Object.entries(recentPostsByTag).filter(([tag]) => !blocked.has(tag.toLowerCase()))
		);
		if (selectedAnalyticsTag && blocked.has(selectedAnalyticsTag.toLowerCase())) {
			selectedAnalyticsTag = null;
		}
	}

	function selectAnalyticsTag(tag: string) {
		selectedAnalyticsTag = tag;
		analyticsOpen = true;
	}

	function addAnalyticsTagToList(tag: string) {
		if (blacklistedTagSet.has(tag) || watchedTags.includes(tag)) return;
		watchedTags = [...watchedTags, tag];
		persistTags();
		void hydrateGalleryFromRecentTag(tag);
	}

	function addSelectedAnalyticsTagToList() {
		if (!selectedAnalyticsTag) return;
		addAnalyticsTagToList(selectedAnalyticsTag);
	}

	function removeSelectedAnalyticsTagFromList() {
		if (!selectedAnalyticsTag) return;
		removeTag(selectedAnalyticsTag);
	}

	function blacklistSelectedAnalyticsTag() {
		if (!selectedAnalyticsTag) return;
		blacklistTag(selectedAnalyticsTag);
	}

	// Pull already-captured stream events into the gallery, one image at a time.
	// `qualifies` decides which images belong for the criterion that just changed.
	function hydrateGalleryFromEvents(
		events: StreamTagEvent[],
		qualifies: (event: StreamTagEvent, image: StreamEventImage) => boolean
	) {
		const nextItems: GalleryImage[] = [];
		const pendingModeration = new Map<string, { base: AdultCheck; createdAt: string }>();
		for (const event of events) {
			if (event.images.length === 0) continue;
			let eventAdded = false;
			for (const image of event.images) {
				if (seenImageIds.has(image.id)) continue;
				if (!qualifies(event, image)) continue;
				seenImageIds.add(image.id);
				// Backlog hydration should fill the gallery quietly, not blast the screen.
				blastedImageIds.add(image.id);
				eventAdded = true;
				nextItems.push({
					id: image.id,
					postUri: event.uri,
					postUrl: event.postUrl,
					thumb: image.thumb,
					fullsize: image.fullsize,
					alt: image.alt,
					aspectRatio: image.aspectRatio,
					tags: event.tags,
					text: event.text,
					matchedTerms: matchedTermsFor(event.text, image.alt),
					matchedQueries: [],
					similarity: 0,
					predictions: [],
					classifierChecked: false,
					classifierMatched: [],
					createdAt: event.createdAt,
					authorDid: image.authorDid,
					moderationChecked: event.moderationChecked,
					moderationBlocked: event.moderationBlocked,
					moderationLabels: event.moderationLabels
				});
			}
			if (eventAdded) {
				pendingModeration.set(event.uri, {
					base: { blocked: event.moderationBlocked, labels: event.moderationLabels },
					createdAt: event.createdAt
				});
			}
		}

		if (nextItems.length > 0) {
			galleryCandidates = [...nextItems, ...galleryCandidates].slice(0, MAX_GALLERY_CANDIDATES);
			for (const item of nextItems) {
				submitForClassification(item);
				submitForEmbedding(item);
			}
			for (const [uri, moderation] of pendingModeration.entries()) {
				void moderateImagePost(uri, moderation.base, moderation.createdAt);
			}
		}
	}

	async function hydrateGalleryFromRecentTag(tag: string) {
		if (blacklistedTagSet.has(tag)) return;
		const events = recentPostsByTag[tag] ?? [];
		hydrateGalleryFromEvents(events, (event) => event.tags.length > 0);
	}

	// Every event we have kept around, deduped: the stream log plus per-tag buffers.
	function knownStreamEvents(): StreamTagEvent[] {
		const byId = new Map<string, StreamTagEvent>();
		for (const event of recentStreamEvents) byId.set(event.id, event);
		for (const events of Object.values(recentPostsByTag)) {
			for (const event of events) byId.set(event.id, event);
		}
		return [...byId.values()];
	}

	function hydrateGalleryFromSearch() {
		if (searchTerms.length === 0) return;
		hydrateGalleryFromEvents(
			knownStreamEvents(),
			(event, image) => matchedTermsFor(event.text, image.alt).length > 0
		);
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

	function maybeBlastImages(items: GalleryImage[]) {
		if (!blastMode || !browser) return;
		if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
		const eligible = items.filter(
			(item) =>
				!blastedImageIds.has(item.id) &&
				!hasBlacklistedTag(item.tags) &&
				(!moderationEnabled || (item.moderationChecked && !item.moderationBlocked))
		);
		if (eligible.length === 0) return;
		const fresh = eligible.map((item, i) => {
			blastedImageIds.add(item.id);
			return {
				id: blastCardId++,
				thumb: item.thumb,
				aspectRatio: item.aspectRatio,
				style: blastCardStyle(i)
			};
		});
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

	function normalizeTag(tag: unknown): string | null {
		if (typeof tag !== 'string') return null;
		const clean = tag.replace(/^#/, '').trim().toLowerCase();
		return clean ? clean : null;
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

	function streamEventImages(images: any[], did: string, uri: string): StreamEventImage[] {
		return images
			.map((image, index) => {
				const cid = cidFromBlob(image?.image);
				if (!cid) return null;
				return {
					id: `${uri}/${cid}/${index}`,
					thumb: imageUrl('feed_thumbnail', did, cid),
					fullsize: imageUrl('feed_fullsize', did, cid),
					alt: typeof image?.alt === 'string' ? image.alt : '',
					aspectRatio: ratioFor(image),
					authorDid: did
				};
			})
			.filter((image): image is StreamEventImage => Boolean(image));
	}

	function selfLabels(record: any): string[] {
		const values = record?.labels?.values;
		if (!Array.isArray(values)) return [];
		return values
			.map((label) => (typeof label?.val === 'string' ? label.val : null))
			.filter((value): value is string => Boolean(value));
	}

	function hasAdultLabel(labels: string[]): boolean {
		return labels.some((label) => ADULT_LABEL_VALUES.has(label.toLowerCase()));
	}

	function adultTagLabels(tags: string[]): string[] {
		return tags
			.map((tag) => tag.toLowerCase())
			.filter((tag) => ADULT_TAG_VALUES.has(tag))
			.map((tag) => `tag:${tag}`);
	}

	function visibleModerationLabels(labels: string[]): string[] {
		return [...new Set(labels.map((label) => label.trim()).filter(Boolean))].sort((a, b) =>
			a.localeCompare(b)
		);
	}

	function initialModerationForEvent(tags: string[], labels: string[]): AdultCheck {
		const tagLabels = adultTagLabels(tags);
		return {
			blocked: hasAdultLabel(labels) || tagLabels.length > 0,
			labels: visibleModerationLabels([...labels, ...tagLabels])
		};
	}

	function moderationRecheckWaitMs(createdAt: string): number {
		const createdMs = Date.parse(createdAt);
		if (!Number.isFinite(createdMs)) return MODERATION_RECHECK_DELAY_MS;
		const ageMs = Date.now() - createdMs;
		return Math.max(0, MODERATION_RECHECK_DELAY_MS - ageMs);
	}

	function sleep(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}

	async function checkAdultLabels(uri: string, options?: { force?: boolean }): Promise<AdultCheck> {
		const cached = adultCheckCache.get(uri);
		if (cached && !options?.force && Date.now() - cached.checkedAt < ADULT_CHECK_CACHE_TTL_MS) {
			return cached.promise;
		}

		const request = fetch('/api/labels/adult', {
			method: 'POST',
			headers: {
				'content-type': 'application/json'
			},
			body: JSON.stringify({ uris: [uri] })
		})
			.then(async (response) => {
				if (!response.ok) {
					return { blocked: true, labels: ['moderation-unavailable'] };
				}
				const payload = (await response.json()) as {
					results?: Record<string, AdultCheck | undefined>;
				};
				return payload.results?.[uri] ?? { blocked: false, labels: [] };
			})
			.catch(() => ({ blocked: true, labels: ['moderation-unavailable'] }));

		adultCheckCache.set(uri, { checkedAt: Date.now(), promise: request });
		return request;
	}

	async function requestModeration(
		uri: string,
		base: AdultCheck,
		options?: { force?: boolean }
	): Promise<AdultCheck> {
		moderationChecks += 1;
		const adultCheck = await checkAdultLabels(uri, options);
		return {
			blocked: base.blocked || adultCheck.blocked,
			labels: visibleModerationLabels([...base.labels, ...adultCheck.labels])
		};
	}

	function applyModerationResult(uri: string, moderation: AdultCheck) {
		const normalized = {
			blocked: moderation.blocked,
			labels: visibleModerationLabels(moderation.labels)
		};
		const updateEvent = (event: StreamTagEvent): StreamTagEvent =>
			event.uri === uri
				? {
						...event,
						moderationChecked: true,
						moderationBlocked: normalized.blocked,
						moderationLabels: normalized.labels
					}
				: event;

		recentStreamEvents = recentStreamEvents.map(updateEvent);
		recentPostsByTag = Object.fromEntries(
			Object.entries(recentPostsByTag).map(([tag, events]) => [
				tag,
				events.map(updateEvent)
			])
		);
		galleryCandidates = galleryCandidates.map((item) =>
			item.postUri === uri
				? {
						...item,
						moderationChecked: true,
						moderationBlocked: normalized.blocked,
						moderationLabels: normalized.labels
					}
				: item
		);
		if (!normalized.blocked) {
			maybeBlastImages(galleryCandidates.filter((item) => item.postUri === uri));
		}
	}

	async function moderateImagePost(uri: string, base: AdultCheck, createdAt: string) {
		if (activeModerationRefreshes.has(uri)) return;
		activeModerationRefreshes.add(uri);
		try {
			const firstCheck = await requestModeration(uri, base);
			applyModerationResult(uri, firstCheck);
			const waitMs = moderationRecheckWaitMs(createdAt);
			if (waitMs > 0) {
				await sleep(waitMs);
			}
			const secondCheck = await requestModeration(uri, firstCheck, { force: true });
			applyModerationResult(uri, secondCheck);
		} finally {
			activeModerationRefreshes.delete(uri);
		}
	}

	function ratioFor(image: any): string {
		const width = Number(image?.aspectRatio?.width);
		const height = Number(image?.aspectRatio?.height);
		if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
			return `${Math.round(width)} / ${Math.round(height)}`;
		}
		return '4 / 3';
	}

	function postUrl(did: string, rkey: string): string {
		return `https://bsky.app/profile/${did}/post/${rkey}`;
	}

	function streamCreatedAt(record: any, event: any): string {
		return typeof record?.createdAt === 'string'
			? record.createdAt
			: new Date(Number(event?.time_us ?? Date.now() * 1000) / 1000).toISOString();
	}

	function recordStreamTags(
		tags: string[],
		options: {
			hasImages: boolean;
			createdAt: string;
			postUrl: string;
			uri: string;
			text: string;
			images: StreamEventImage[];
			ownLabels: string[];
			moderationChecked: boolean;
			moderationBlocked: boolean;
			moderationLabels: string[];
		}
	) {
		const analyticsTags = visibleTags(tags);
		if (analyticsTags.length === 0) return;

		streamTaggedPostsSeen += 1;
		if (options.hasImages) streamImageTaggedPostsSeen += 1;

		const nextEvent: StreamTagEvent = {
			id: `${options.postUrl}-${streamTaggedPostsSeen}`,
			uri: options.uri,
			tags,
			hasImages: options.hasImages,
			createdAt: options.createdAt,
			postUrl: options.postUrl,
			text: options.text,
			images: options.images,
			ownLabels: options.ownLabels,
			moderationChecked: options.moderationChecked,
			moderationBlocked: options.moderationBlocked,
			moderationLabels: options.moderationLabels
		};

		let nextStats: Record<string, StreamTagStats> = { ...streamTagStats };
		for (const tag of analyticsTags) {
			const current = nextStats[tag] ?? {
				tag,
				posts: 0,
				imagePosts: 0,
				lastSeenAt: options.createdAt
			};
			nextStats[tag] = {
				tag,
				posts: current.posts + 1,
				imagePosts: current.imagePosts + (options.hasImages ? 1 : 0),
				lastSeenAt: options.createdAt
			};
		}

		const stats = Object.values(nextStats);
		if (stats.length > MAX_TRACKED_STREAM_TAGS) {
			nextStats = Object.fromEntries(
				stats
					.sort(
						(a, b) =>
							b.imagePosts - a.imagePosts ||
							b.posts - a.posts ||
							b.lastSeenAt.localeCompare(a.lastSeenAt)
					)
					.slice(0, MAX_TRACKED_STREAM_TAGS)
					.map((entry) => [entry.tag, entry])
			);
		}
		streamTagStats = nextStats;

		let nextRecentPostsByTag: Record<string, StreamTagEvent[]> = { ...recentPostsByTag };
		for (const tag of analyticsTags) {
			const current = nextRecentPostsByTag[tag] ?? [];
			nextRecentPostsByTag[tag] = [
				nextEvent,
				...current.filter((event) => event.uri !== options.uri)
			].slice(0, MAX_RECENT_POSTS_PER_TAG);
		}
		nextRecentPostsByTag = Object.fromEntries(
			Object.entries(nextRecentPostsByTag).filter(([tag]) => Boolean(nextStats[tag]))
		);
		recentPostsByTag = nextRecentPostsByTag;

		recentStreamEvents = [nextEvent, ...recentStreamEvents].slice(0, MAX_STREAM_EVENTS);
	}

	async function addGalleryImages(event: any) {
		const commit = event?.commit;
		const record = commit?.record;
		const did = typeof event?.did === 'string' ? event.did : '';
		const rkey = typeof commit?.rkey === 'string' ? commit.rkey : '';
		if (!did || !rkey || commit?.operation !== 'create') return;
		if (commit?.collection !== 'app.bsky.feed.post') return;

		postsSeen += 1;
		lastEventAt = new Date().toISOString();

		const images = imageEmbeds(record);
		const postTags = extractTags(record);
		const createdAt = streamCreatedAt(record, event);
		const uri = `at://${did}/app.bsky.feed.post/${rkey}`;
		const eventImages = streamEventImages(images, did, uri);
		const ownLabels = selfLabels(record);
		const initialModeration = initialModerationForEvent(postTags, ownLabels);
		const moderationChecked = eventImages.length === 0 || initialModeration.blocked;
		recordStreamTags(postTags, {
			hasImages: eventImages.length > 0,
			createdAt,
			postUrl: postUrl(did, rkey),
			uri,
			text: typeof record?.text === 'string' ? record.text : '',
			images: eventImages,
			ownLabels,
			moderationChecked,
			moderationBlocked: initialModeration.blocked,
			moderationLabels: initialModeration.labels
		});

		if (eventImages.length === 0) return;
		imagePostsSeen += 1;

		const modelsRunning = classifierEnabled || embedderEnabled;
		if (!hasFilters && !modelsRunning) return;
		const postText = typeof record?.text === 'string' ? record.text : '';
		const matchedTags = matchedTagsFor(postTags);
		const searchMatched = eventMatchesSearch(postText, eventImages);
		if (matchedTags.length === 0 && !searchMatched && !modelsRunning) return;
		if (matchedTags.length > 0) matchingPostsSeen += 1;
		if (searchMatched) searchMatchingPostsSeen += 1;

		const nextItems: GalleryImage[] = [];
		eventImages.forEach((image) => {
			if (seenImageIds.has(image.id)) return;
			const matchedTerms = matchedTermsFor(postText, image.alt);
			// A tag match pulls in every image; a search-only match pulls in the images it hit.
			const admitted = matchedTags.length > 0 || matchedTerms.length > 0;
			if (!admitted && !modelsRunning) return;
			seenImageIds.add(image.id);
			const item: GalleryImage = {
				id: image.id,
				postUri: uri,
				postUrl: postUrl(did, rkey),
				thumb: image.thumb,
				fullsize: image.fullsize,
				alt: image.alt,
				aspectRatio: image.aspectRatio,
				tags: postTags,
				text: postText,
				matchedTerms,
				matchedQueries: [],
				similarity: 0,
				predictions: [],
				classifierChecked: false,
				classifierMatched: [],
				createdAt,
				authorDid: image.authorDid,
				moderationChecked,
				moderationBlocked: initialModeration.blocked,
				moderationLabels: initialModeration.labels
			};
			// Already-qualifying images go straight in and get annotated later; the rest
			// wait in the classifier queue and only appear if a selected label fires.
			if (admitted) {
				nextItems.push(item);
			} else {
				// Only worth holding if a selected label or reference could still admit
				// it; with nothing selected the models run purely for analytics.
				if (classifierActive) {
					pendingClassification.set(item.id, item);
					// Bound the holding area: a dropped fetch never reports back.
					if (pendingClassification.size > 1500) {
						const oldest = pendingClassification.keys().next().value;
						if (oldest) pendingClassification.delete(oldest);
					}
				}
				if (semanticActive) {
					pendingSemantic.set(item.id, item);
					if (pendingSemantic.size > 1500) {
						const oldest = pendingSemantic.keys().next().value;
						if (oldest) pendingSemantic.delete(oldest);
					}
				}
			}
			submitForClassification(item);
			submitForEmbedding(item);
		});

		if (nextItems.length > 0) {
			galleryCandidates = [...nextItems, ...galleryCandidates].slice(0, MAX_GALLERY_CANDIDATES);
			maybeBlastImages(nextItems);
			void moderateImagePost(uri, initialModeration, createdAt);
		}
	}

	function handleJetstreamMessage(message: MessageEvent) {
		if (typeof message.data !== 'string') return;
		try {
			void addGalleryImages(JSON.parse(message.data));
		} catch {
			// Jetstream should be JSON; ignore malformed frames without dropping the stream.
		}
	}

	function connectJetstream() {
		disconnectJetstream();
		const url = new URL(JETSTREAM_URL);
		url.searchParams.set('wantedCollections', 'app.bsky.feed.post');

		status = 'connecting';
		statusMessage = 'Connecting';
		const nextSocket = new WebSocket(url.toString());
		socket = nextSocket;

		nextSocket.addEventListener('open', () => {
			if (socket !== nextSocket) return;
			status = 'open';
			statusMessage = 'Live';
		});
		nextSocket.addEventListener('message', handleJetstreamMessage);
		nextSocket.addEventListener('error', () => {
			if (socket !== nextSocket) return;
			status = 'error';
			statusMessage = 'Stream error';
		});
		nextSocket.addEventListener('close', () => {
			if (socket !== nextSocket) return;
			socket = null;
			status = status === 'error' ? 'error' : 'closed';
			statusMessage = status === 'error' ? 'Stream error' : 'Disconnected';
		});
	}

	function disconnectJetstream() {
		const current = socket;
		socket = null;
		if (current && current.readyState <= WebSocket.OPEN) {
			current.close();
		}
		if (status === 'connecting' || status === 'open') {
			status = 'closed';
			statusMessage = 'Disconnected';
		}
	}

	function handleTagsSubmit(event: Event) {
		event.preventDefault();
		applyTags();
		if (status === 'open' || status === 'connecting') {
			connectJetstream();
		}
	}

	function handleSearchSubmit(event: Event) {
		event.preventDefault();
		applySearch();
	}

	function handleBlacklistSubmit(event: Event) {
		event.preventDefault();
		applyBlacklist();
	}

	function removeTag(tag: string) {
		watchedTags = watchedTags.filter((candidate) => candidate !== tag);
		tagInput = watchedTags.join(', ');
		refilterGallery();
		try {
			localStorage.setItem(STORAGE_TAGS_KEY, tagInput);
		} catch {}
		updateQuery();
	}

	function formatTime(value: string | null): string {
		if (!value) return 'none';
		return new Intl.DateTimeFormat(undefined, {
			hour: '2-digit',
			minute: '2-digit',
			second: '2-digit'
		}).format(new Date(value));
	}

	onMount(() => {
		try {
			const savedFont = localStorage.getItem('preferred-font');
			if (savedFont && savedFont in fontFamilies) fontKey = savedFont;
			const savedModeration = localStorage.getItem(STORAGE_MODERATION_KEY);
			if (savedModeration === '0' || savedModeration === '1') {
				moderationEnabled = savedModeration === '1';
			}
		} catch {}

		const params = new URLSearchParams(window.location.search);
		const queryTags = params.get('tags');
		let nextTags = queryTags ? parseTagList(queryTags) : [];
		if (nextTags.length === 0) {
			try {
				const savedTags = localStorage.getItem(STORAGE_TAGS_KEY);
				nextTags = savedTags ? parseTagList(savedTags) : nextTags;
			} catch {}
		}
		if (nextTags.length > 0) {
			watchedTags = nextTags;
			tagInput = nextTags.join(', ');
		}
		try {
			const savedBlacklist = localStorage.getItem(STORAGE_BLACKLIST_KEY);
			const nextBlacklist = savedBlacklist ? parseTagList(savedBlacklist) : [];
			if (nextBlacklist.length > 0) {
				blacklistedTags = nextBlacklist;
				blacklistInput = nextBlacklist.join(', ');
			}
		} catch {}

		const queryTerms = params.get('q');
		let nextTerms = queryTerms ? parseSearchTerms(queryTerms) : [];
		let scope = params.get('in');
		if (nextTerms.length === 0) {
			try {
				const savedSearch = localStorage.getItem(STORAGE_SEARCH_KEY);
				nextTerms = savedSearch ? parseSearchTerms(savedSearch) : nextTerms;
				scope = scope ?? localStorage.getItem(STORAGE_SEARCH_SCOPE_KEY);
			} catch {}
		}
		if (scope) {
			const scopes = new Set(parseSearchTerms(scope));
			// Ignore an empty scope so search can never become unmatchable.
			if (scopes.has('text') || scopes.has('alt')) {
				searchInText = scopes.has('text');
				searchInAlt = scopes.has('alt');
			}
		}
		if (nextTerms.length > 0) {
			searchTerms = nextTerms;
			searchInput = nextTerms.join(', ');
		}

		try {
			const savedClassifier = localStorage.getItem(STORAGE_CLASSIFIER_KEY);
			if (savedClassifier) {
				const parsed = JSON.parse(savedClassifier) as {
					enabled?: boolean;
					strict?: boolean;
					labels?: unknown;
					threshold?: number;
					workers?: number;
					embedder?: boolean;
					embedderWorkers?: number;
					textThreshold?: number;
					imageThreshold?: number;
				};
				if (Array.isArray(parsed.labels)) {
					const known = new Set(IMAGENET_LABELS);
					const labels = parsed.labels.filter(
						(label): label is string => typeof label === 'string' && known.has(label)
					);
					if (labels.length > 0) classifierLabels = labels;
				}
				if (typeof parsed.threshold === 'number' && Number.isFinite(parsed.threshold)) {
					classifierThreshold = Math.min(0.95, Math.max(0.01, parsed.threshold));
				}
				if (typeof parsed.workers === 'number' && Number.isFinite(parsed.workers)) {
					classifierWorkers = Math.max(1, Math.min(16, Math.round(parsed.workers)));
				}
				if (typeof parsed.embedderWorkers === 'number' && Number.isFinite(parsed.embedderWorkers)) {
					embedderWorkers = Math.max(1, Math.min(8, Math.round(parsed.embedderWorkers)));
				}
				if (typeof parsed.textThreshold === 'number' && Number.isFinite(parsed.textThreshold)) {
					textThreshold = Math.min(0.5, Math.max(0.01, parsed.textThreshold));
				}
				if (typeof parsed.imageThreshold === 'number' && Number.isFinite(parsed.imageThreshold)) {
					imageThreshold = Math.min(0.99, Math.max(0.3, parsed.imageThreshold));
				}
				classifierStrict = parsed.strict === true;
				// The embedder is a large download; remember the toggle but let the
				// pool spin up on demand rather than at page load.
				embedderEnabled = parsed.embedder === true;
				if (embedderEnabled) ensureEmbedderPool();
				if (parsed.enabled === true) {
					classifierEnabled = true;
					classifierPanelOpen = true;
					ensureClassifierPool();
				}
			}
		} catch {}

		updateQuery();
		connectJetstream();
	});

	onDestroy(() => {
		disconnectJetstream();
		teardownClassifierPool();
		teardownEmbedderPool();
	});
</script>

<svelte:head>
	<title>Hashtag Image Gallery</title>
</svelte:head>

<main style="font-family: {fontFamily}">
	<header class="page-header">
		<RouteNav current="hashtag" align="center" />
		<div class="title-row">
			<div>
				<h1>Hashtag Image Gallery</h1>
				<p class="subtitle">Live Jetstream images filtered by hashtag</p>
			</div>
			<FontPicker value={fontKey} onchange={handleFontChange} />
		</div>
	</header>

	<section class="control-panel wobbly-border-light">
		<div class="control-top">
			<div class="filter-stack">
				<form class="tag-form" onsubmit={handleTagsSubmit}>
					<label for="tag-input">Hashtags</label>
					<div class="tag-input-row">
						<input
							id="tag-input"
							type="text"
							placeholder="art, photography, nature"
							bind:value={tagInput}
						/>
						<button type="submit" class="primary-button wobbly-border">Apply</button>
						{#if status === 'open' || status === 'connecting'}
							<button type="button" class="secondary-button wobbly-border-light" onclick={disconnectJetstream}>
								Stop
							</button>
						{:else}
							<button
								type="button"
								class="secondary-button wobbly-border-light"
								onclick={connectJetstream}
							>
								Start
							</button>
						{/if}
					</div>
				</form>

				<form class="tag-form" onsubmit={handleSearchSubmit}>
					<label for="search-input">Search text <small>(matched OR hashtags)</small></label>
					<div class="tag-input-row">
						<input
							id="search-input"
							type="search"
							placeholder="comma separated, e.g. sunset, watercolor"
							bind:value={searchInput}
						/>
						<button type="submit" class="primary-button wobbly-border">Search</button>
					</div>
					<div class="search-scope">
						<label class="scope-toggle">
							<input
								type="checkbox"
								checked={searchInText}
								onchange={(event) =>
									setSearchScope('text', (event.currentTarget as HTMLInputElement).checked)}
							/>
							<span>Post text</span>
						</label>
						<label class="scope-toggle">
							<input
								type="checkbox"
								checked={searchInAlt}
								onchange={(event) =>
									setSearchScope('alt', (event.currentTarget as HTMLInputElement).checked)}
							/>
							<span>Alt text</span>
						</label>
						<small class="scope-hint">
							{#if searchTerms.length === 0}
								Search is off
							{:else if !searchInText && !searchInAlt}
								Pick a field to search
							{:else}
								Searching {searchScopeLabel}
							{/if}
						</small>
					</div>
				</form>

				<div class="blacklist-drawer">
					<button
						type="button"
						class="blacklist-toggle secondary-button wobbly-border-light"
						aria-expanded={blacklistOpen}
						onclick={() => (blacklistOpen = !blacklistOpen)}
					>
						{blacklistButtonLabel}
					</button>

					{#if blacklistOpen}
						<form class="tag-form blacklist-form" onsubmit={handleBlacklistSubmit}>
							<label for="blacklist-input">Blacklist</label>
							<div class="tag-input-row">
								<input
									id="blacklist-input"
									type="text"
									placeholder="mute tags"
									bind:value={blacklistInput}
								/>
								<button type="submit" class="secondary-button wobbly-border-light">Mute</button>
							</div>
						</form>
					{/if}
				</div>
			</div>

			<div class="control-side">
				<label class="moderation-toggle">
					<input type="checkbox" checked={moderationEnabled} onchange={handleModerationChange} />
					<span>Moderation</span>
					<strong>{moderationEnabled ? 'On' : 'Off'}</strong>
				</label>
				<button
					type="button"
					class="secondary-button wobbly-border-light blast-toggle"
					class:active={blastMode}
					onclick={toggleBlastMode}
					title="Blast newly matched images across the screen as they arrive"
				>
					🔥 Blast mode {blastMode ? 'on' : 'off'}
				</button>
			</div>
		</div>

		<div class="tag-strip" aria-label="Active hashtags">
			{#each galleryTags as item (item.tag)}
				<button type="button" class="tag-chip" onclick={() => removeTag(item.tag)}>
					<span>#{item.tag}</span>
					<strong>{item.count}</strong>
				</button>
			{/each}
			{#each galleryTerms as item (item.term)}
				<button
					type="button"
					class="tag-chip term-chip"
					title="Remove search term"
					onclick={() => removeSearchTerm(item.term)}
				>
					<span>“{item.term}”</span>
					<strong>{item.count}</strong>
				</button>
			{/each}
			{#each galleryQueries as item (item.query.id)}
				<button
					type="button"
					class="tag-chip query-chip"
					title="Remove semantic query"
					onclick={() => removeSemanticQuery(item.query.id)}
				>
					{#if item.query.thumb}
						<img class="query-thumb" src={item.query.thumb} alt="" />
					{/if}
					<span>{item.query.kind === 'text' ? `“${item.query.label}”` : 'similar'}</span>
					<strong>{item.count}</strong>
				</button>
			{/each}
			{#if classifierActive}
				{#each galleryLabels as item (item.label)}
					<button
						type="button"
						class="tag-chip label-chip"
						title="Remove classifier label"
						onclick={() => toggleLabel(item.label)}
					>
						<span>🧠 {item.label}</span>
						<strong>{item.count}</strong>
					</button>
				{/each}
			{/if}
		</div>

		{#if blacklistOpen && blacklistedTags.length > 0}
			<div class="tag-strip muted-strip" aria-label="Blacklisted hashtags">
				{#each blacklistedTags as tag (tag)}
					<button type="button" class="tag-chip muted-chip" onclick={() => removeBlacklistedTag(tag)}>
						<span>#{tag}</span>
						<strong>off</strong>
					</button>
				{/each}
			</div>
		{/if}

		<div class="stats-grid">
			<div class="stat">
				<span>Status</span>
				<strong class:live={status === 'open'}>{statusMessage}</strong>
			</div>
			<div class="stat">
				<span>Posts</span>
				<strong>{postsSeen.toLocaleString()}</strong>
			</div>
			<div class="stat">
				<span>Image Posts</span>
				<strong>{imagePostsSeen.toLocaleString()}</strong>
			</div>
			<div class="stat">
				<span>Tag Matches</span>
				<strong>{matchingPostsSeen.toLocaleString()}</strong>
			</div>
			<div class="stat">
				<span>Text Matches</span>
				<strong>{searchMatchingPostsSeen.toLocaleString()}</strong>
			</div>
			<div class="stat">
				<span>AI Matches</span>
				<strong>{classifierMatches.toLocaleString()}</strong>
			</div>
			<div class="stat">
				<span>Moderation</span>
				<strong>{moderationEnabled ? 'On' : 'Off'}</strong>
			</div>
			<div class="stat">
				<span>Adult Hidden</span>
				<strong>{adultHiddenPosts.toLocaleString()}</strong>
			</div>
			<div class="stat">
				<span>Label Checks</span>
				<strong>{moderationChecks.toLocaleString()}</strong>
			</div>
			<div class="stat">
				<span>Last Event</span>
				<strong>{formatTime(lastEventAt)}</strong>
			</div>
		</div>
	</section>

	<section class="classifier-card wobbly-border-light">
		<div class="classifier-head">
			<label class="moderation-toggle">
				<input
					type="checkbox"
					checked={classifierEnabled}
					onchange={(event) =>
						setClassifierEnabled((event.currentTarget as HTMLInputElement).checked)}
				/>
				<span>🧠 Classifier</span>
				<strong>MobileNet v2</strong>
			</label>
			<span class="classifier-summary">
				{#if !classifierEnabled}
					Off — classify every firehose image in-browser
				{:else if !classifierStats?.ready}
					Loading model…
				{:else}
					{classifierStats.backend} · {classifierStats.workers} workers ·
					{classifierStats.perSecond}/s · {classifierStats.avgMs.toFixed(1)}ms
				{/if}
			</span>
			<button
				type="button"
				class="secondary-button wobbly-border-light"
				aria-expanded={classifierPanelOpen}
				onclick={() => (classifierPanelOpen = !classifierPanelOpen)}
			>
				{classifierPanelOpen ? 'Hide' : `Labels (${classifierLabels.length})`}
			</button>
		</div>

		{#if classifierEnabled}
			<div class="classifier-stats">
				<div class="stat"><span>Backend</span><strong>{classifierStats?.backend ?? '…'}</strong></div>
				<div class="stat"><span>Classified</span><strong>{(classifierStats?.classified ?? 0).toLocaleString()}</strong></div>
				<div class="stat"><span>Hits</span><strong>{classifierMatches.toLocaleString()}</strong></div>
				<div class="stat"><span>Queue</span><strong>{classifierStats?.queued ?? 0}</strong></div>
				<div class="stat"><span>In flight</span><strong>{classifierStats?.inflight ?? 0}</strong></div>
				<div class="stat"><span>Dropped</span><strong>{(classifierStats?.dropped ?? 0).toLocaleString()}</strong></div>
				<div class="stat"><span>Errors</span><strong>{(classifierStats?.errors ?? 0).toLocaleString()}</strong></div>
			</div>

			<div class="classifier-controls">
				<label class="slider-control">
					<span>Workers <strong>{classifierWorkers}</strong></span>
					<input
						type="range"
						min="1"
						max="16"
						step="1"
						value={classifierWorkers}
						oninput={(event) =>
							setClassifierWorkers(Number((event.currentTarget as HTMLInputElement).value))}
					/>
				</label>
				<label class="slider-control">
					<span>Confidence <strong>{Math.round(classifierThreshold * 100)}%</strong></span>
					<input
						type="range"
						min="0.01"
						max="0.95"
						step="0.01"
						value={classifierThreshold}
						oninput={(event) =>
							setClassifierThreshold(Number((event.currentTarget as HTMLInputElement).value))}
					/>
				</label>
				<label class="scope-toggle">
					<input
						type="checkbox"
						checked={classifierStrict}
						onchange={(event) =>
							setClassifierStrict((event.currentTarget as HTMLInputElement).checked)}
					/>
					<span>Only show classifier hits</span>
				</label>
			</div>
		{/if}

		<div class="classifier-head">
			<label class="moderation-toggle">
				<input
					type="checkbox"
					checked={embedderEnabled}
					onchange={(event) =>
						setEmbedderEnabled((event.currentTarget as HTMLInputElement).checked)}
				/>
				<span>🔎 Semantic</span>
				<strong>SigLIP 2</strong>
			</label>
			<span class="classifier-summary">
				{#if !embedderEnabled}
					Off — 55MB vision tower, text tower loads on first query
				{:else if !embedStats?.ready}
					{embedStats?.backend ?? 'Loading model…'}
				{:else}
					{embedStats.backend} · {embedStats.workers} workers ·
					{embedStats.perSecond}/s · {embedStats.avgMs.toFixed(0)}ms
				{/if}
			</span>
		</div>

		{#if embedderEnabled}
			<form
				class="tag-form"
				onsubmit={(event) => {
					event.preventDefault();
					void addTextQuery();
				}}
			>
				<label for="semantic-input">Describe what to look for</label>
				<div class="tag-input-row">
					<input
						id="semantic-input"
						type="search"
						placeholder="a cat asleep on a keyboard"
						bind:value={semanticInput}
						disabled={semanticBusy}
					/>
					<button type="submit" class="primary-button wobbly-border" disabled={semanticBusy}>
						{semanticBusy ? 'Embedding…' : 'Add query'}
					</button>
				</div>
				{#if semanticError}
					<small class="semantic-error">{semanticError}</small>
				{/if}
			</form>

			<div class="classifier-controls">
				<label class="slider-control">
					<span>Text match <strong>{textThreshold.toFixed(2)}</strong></span>
					<input
						type="range"
						min="0.01"
						max="0.5"
						step="0.01"
						value={textThreshold}
						oninput={(event) =>
							setTextThreshold(Number((event.currentTarget as HTMLInputElement).value))}
					/>
				</label>
				<label class="slider-control">
					<span>Image match <strong>{imageThreshold.toFixed(2)}</strong></span>
					<input
						type="range"
						min="0.3"
						max="0.99"
						step="0.01"
						value={imageThreshold}
						oninput={(event) =>
							setImageThreshold(Number((event.currentTarget as HTMLInputElement).value))}
					/>
				</label>
				<span class="scope-hint">Queue {embedStats?.queued ?? 0} · {(embedStats?.classified ?? 0).toLocaleString()} embedded</span>
			</div>
		{/if}

		{#if classifierPanelOpen}
			<div class="label-picker">
				<div class="label-presets">
					<button type="button" class="mini-action primary-action" onclick={() => setLabels(CAT_LABELS)}>
						🐱 Cats
					</button>
					<button type="button" class="mini-action" onclick={() => addLabels(BIG_CAT_LABELS)}>
						+ Big cats
					</button>
					<button type="button" class="mini-action" onclick={() => addLabels(DOG_LABELS)}>
						+ Dogs
					</button>
					<button type="button" class="mini-action" onclick={() => setLabels([])}>Clear</button>
				</div>

				<div class="tag-strip" aria-label="Selected classifier labels">
					{#each classifierLabels as label (label)}
						<button
							type="button"
							class="tag-chip label-chip"
							title="Remove label"
							onclick={() => toggleLabel(label)}
						>
							<span>{label}</span>
						</button>
					{/each}
				</div>

				<input
					type="search"
					class="label-search"
					placeholder="Search all 1000 ImageNet labels"
					bind:value={labelQuery}
				/>
				<p class="label-count">
					{labelResults.total.toLocaleString()} labels
					{#if labelResults.total > labelResults.shown.length}
						· showing first {labelResults.shown.length}
					{/if}
				</p>
				<div class="label-list">
					{#each labelResults.shown as label (label)}
						<label class="label-option" class:selected={classifierLabelSet.has(label)}>
							<input
								type="checkbox"
								checked={classifierLabelSet.has(label)}
								onchange={() => toggleLabel(label)}
							/>
							<span>{label}</span>
						</label>
					{/each}
				</div>
			</div>
		{/if}
	</section>

	<section class="analytics-card wobbly-border-light" class:open={classifierAnalyticsOpen}>
		<button
			type="button"
			class="analytics-header"
			aria-expanded={classifierAnalyticsOpen}
			onclick={() => (classifierAnalyticsOpen = !classifierAnalyticsOpen)}
		>
			<span>
				<strong>Classifier Analytics</strong>
				<small>
					{classifiedTotal.toLocaleString()} label hits across
					{topClassifierLabels.length.toLocaleString()} classes
				</small>
				<small class="analytics-warning" role="note">MobileNet v2 on the raw firehose</small>
			</span>
			<em>{classifierAnalyticsOpen ? 'Collapse' : 'Open'}</em>
		</button>

		{#if classifierAnalyticsOpen}
			<div class="analytics-body">
				<div class="analytics-grid">
					<div class="analytics-section">
						<h2>Detected Classes</h2>
						{#if !classifierEnabled}
							<p class="analytics-empty">
								Turn on the classifier to see what MobileNet finds in the stream.
							</p>
						{:else if topClassifierLabels.length === 0}
							<p class="analytics-empty">Waiting for classified images.</p>
						{:else}
							<div class="ranked-tags">
								{#each topClassifierLabels as entry (entry.label)}
									<button
										type="button"
										class="ranked-tag"
										class:active={classifierLabelSet.has(entry.label)}
										class:selected={selectedClassifierLabel === entry.label}
										onclick={() => selectClassifierLabel(entry.label)}
									>
										<span>{entry.label}</span>
										<small>{entry.hits.toLocaleString()} images</small>
									</button>
								{/each}
							</div>
						{/if}
					</div>

					<div class="analytics-section">
						<div class="analytics-section-heading">
							<h2>{selectedClassifierLabel ? selectedClassifierLabel : 'Class Images'}</h2>
							{#if selectedClassifierLabel}
								<div class="preview-actions">
									{#if classifierLabelSet.has(selectedClassifierLabel)}
										<button
											type="button"
											class="mini-action"
											onclick={() => toggleLabel(selectedClassifierLabel!)}
										>
											Remove from filter
										</button>
									{:else}
										<button
											type="button"
											class="mini-action primary-action"
											onclick={() => toggleLabel(selectedClassifierLabel!)}
										>
											Add to filter
										</button>
									{/if}
									<button
										type="button"
										class="mini-action"
										disabled={selectedLabelImages.length === 0}
										onclick={() => dismissLabelImages(selectedClassifierLabel!)}
									>
										Remove all ({selectedLabelImages.length})
									</button>
								</div>
							{/if}
						</div>
						{#if !selectedClassifierLabel}
							<p class="analytics-empty">Click a class to see the images it matched.</p>
						{:else if selectedLabelImages.length === 0}
							<p class="analytics-empty">
								No images held for {selectedClassifierLabel} right now.
							</p>
						{:else}
							<div class="label-images">
								{#each selectedLabelImages as image (image.id)}
									<article class="label-image" style={`--image-ratio: ${image.aspectRatio}`}>
										<button
											type="button"
											class="event-image-button"
											aria-label={`Open image from ${image.postUri}`}
											onclick={() => openLightbox(image.fullsize, image.alt)}
										>
											<img src={image.thumb} alt={image.alt || selectedClassifierLabel} />
											<span class="event-image-label">
												{formatTime(image.createdAt)}
												<em>{Math.round(image.probability * 100)}%</em>
											</span>
										</button>
										<div class="label-image-actions">
											<a href={image.postUrl} target="_blank" rel="noreferrer">Post</a>
											<button
												type="button"
												class="mini-action"
												onclick={() => dismissClassifiedImage(image.id)}
											>
												Remove
											</button>
										</div>
									</article>
								{/each}
							</div>
						{/if}
					</div>
				</div>
			</div>
		{/if}
	</section>

	<section class="analytics-card wobbly-border-light" class:open={analyticsOpen}>
		<button
			type="button"
			class="analytics-header"
			aria-expanded={analyticsOpen}
			onclick={() => (analyticsOpen = !analyticsOpen)}
		>
			<span>
				<strong>Stream Analytics</strong>
					<small>
						{streamTaggedPostsSeen.toLocaleString()} tagged posts,
						{streamImageTaggedPostsSeen.toLocaleString()} with images
					</small>
					<small class="analytics-warning" role="note">Unfiltered Jetstream firehose</small>
				</span>
				<em>{analyticsOpen ? 'Collapse' : 'Open'}</em>
			</button>

			{#if analyticsOpen}
				<div class="analytics-body">
					<div class="analytics-grid">
						<div class="analytics-section">
							<h2>Top Image Tags</h2>
						{#if topStreamTags.length === 0}
							<p class="analytics-empty">Waiting for stream tags.</p>
						{:else}
							<div class="ranked-tags">
								{#each topStreamTags as entry (entry.tag)}
									<button
										type="button"
										class="ranked-tag"
										class:active={watchedTagSet.has(entry.tag)}
										class:selected={selectedAnalyticsTag === entry.tag}
										onclick={() => selectAnalyticsTag(entry.tag)}
									>
										<span>#{entry.tag}</span>
										<small>{entry.imagePosts.toLocaleString()} images / {entry.posts.toLocaleString()} posts</small>
									</button>
								{/each}
							</div>
						{/if}
					</div>

					<div class="analytics-stack">
						<div class="analytics-section">
							<div class="analytics-section-heading">
								<h2>{selectedAnalyticsTag ? `Recent #${selectedAnalyticsTag}` : 'Tag Posts'}</h2>
								{#if selectedAnalyticsTag}
									<div class="preview-actions">
										{#if isWatchedTag(selectedAnalyticsTag)}
											<button
												type="button"
												class="mini-action"
												onclick={removeSelectedAnalyticsTagFromList}
											>
												Remove tag
											</button>
										{:else}
											<button
												type="button"
												class="mini-action primary-action"
												disabled={isBlacklistedTag(selectedAnalyticsTag)}
												onclick={addSelectedAnalyticsTagToList}
											>
												Add tag to list
											</button>
										{/if}
										<button
											type="button"
											class="mini-action"
											disabled={isBlacklistedTag(selectedAnalyticsTag)}
											onclick={blacklistSelectedAnalyticsTag}
										>
											{isBlacklistedTag(selectedAnalyticsTag) ? 'Muted' : 'Mute'}
										</button>
									</div>
								{/if}
							</div>
							{#if !selectedAnalyticsTag}
								<p class="analytics-empty">Click a tag to preview its recent posts.</p>
							{:else if selectedAnalyticsPosts.length === 0}
								<p class="analytics-empty">No recent posts captured for #{selectedAnalyticsTag} yet.</p>
							{:else}
								<div class="tag-posts">
									{#each selectedAnalyticsPosts as event (event.id)}
										{@const eventImages = visibleEventImages(event)}
										<article class="tag-post">
											<div class="stream-event-meta">
												<span>{formatTime(event.createdAt)}</span>
												{#if eventImages.length > 0}
													<strong>image</strong>
												{/if}
												<a href={event.postUrl} target="_blank" rel="noreferrer">Post</a>
											</div>
											{#if event.text}
												<p class="tag-post-text">{event.text}</p>
											{/if}
											{#if eventImages.length > 0}
												<div class="event-images">
													{#each eventImages.slice(0, 4) as image (image.id)}
														{@const prediction = topPredictionFor(predictionIndex, image.id)}
														<button
															type="button"
															class="event-image-button"
															aria-label={`Open image from ${event.uri}`}
															style={`--image-ratio: ${image.aspectRatio}`}
															onclick={() => openLightbox(image.fullsize, image.alt)}
														>
															<img src={image.thumb} alt={image.alt || `Image tagged ${event.tags.join(', ')}`} />
															{#if prediction}
																<span class="event-image-label">
																	{prediction.label.split(',')[0]}
																	<em>{Math.round(prediction.probability * 100)}%</em>
																</span>
															{/if}
														</button>
													{/each}
												</div>
											{/if}
											<div class="stream-event-tags">
												{#each visibleTags(event.tags).slice(0, 8) as tag}
													<button
														type="button"
														class:active={watchedTagSet.has(tag)}
														class:selected={selectedAnalyticsTag === tag}
														onclick={() => selectAnalyticsTag(tag)}
													>
														#{tag}
													</button>
												{/each}
											</div>
										</article>
									{/each}
								</div>
							{/if}
						</div>

						<div class="analytics-section">
							<h2>Recent Stream</h2>
							{#if visibleRecentStreamEvents.length === 0}
								<p class="analytics-empty">Waiting for tagged posts.</p>
							{:else}
								<div class="stream-events">
									{#each visibleRecentStreamEvents as event (event.id)}
										{@const eventImages = visibleEventImages(event)}
										<article class="stream-event">
											<div class="stream-event-meta">
												<span>{formatTime(event.createdAt)}</span>
												{#if eventImages.length > 0}
													<strong>image</strong>
												{/if}
												<a href={event.postUrl} target="_blank" rel="noreferrer">Post</a>
											</div>
											{#if event.text}
												<p class="stream-event-text">{event.text}</p>
											{/if}
											{#if eventImages.length > 0}
												<div class="event-images compact">
													{#each eventImages.slice(0, 3) as image (image.id)}
														{@const prediction = topPredictionFor(predictionIndex, image.id)}
														<button
															type="button"
															class="event-image-button"
															aria-label={`Open image from ${event.uri}`}
															style={`--image-ratio: ${image.aspectRatio}`}
															onclick={() => openLightbox(image.fullsize, image.alt)}
														>
															<img src={image.thumb} alt={image.alt || `Image tagged ${event.tags.join(', ')}`} />
															{#if prediction}
																<span class="event-image-label">
																	{prediction.label.split(',')[0]}
																	<em>{Math.round(prediction.probability * 100)}%</em>
																</span>
															{/if}
														</button>
													{/each}
												</div>
											{/if}
											<div class="stream-event-tags">
												{#each visibleTags(event.tags).slice(0, 8) as tag}
													<button
														type="button"
														class:active={watchedTagSet.has(tag)}
														class:selected={selectedAnalyticsTag === tag}
														onclick={() => selectAnalyticsTag(tag)}
													>
														#{tag}
													</button>
												{/each}
											</div>
										</article>
									{/each}
								</div>
							{/if}
						</div>
					</div>
				</div>
			</div>
		{/if}
	</section>

	{#if !hasFilters}
		<section class="empty-state wobbly-border-light">
			<h2>Add hashtags or a text search to fill the gallery.</h2>
		</section>
	{:else if newestFirst.length === 0}
		<section class="empty-state wobbly-border-light">
			<h2>Waiting for matching images.</h2>
		</section>
	{:else}
		<section class="gallery" aria-label="Matching hashtag images">
			{#each newestFirst as item (item.id)}
				{@const labels = visibleModerationLabels(item.moderationLabels)}
				<article class="image-card" style={`--image-ratio: ${item.aspectRatio}`}>
					<div class="image-frame">
						<button
							type="button"
							class="image-button"
							aria-label={`Open image from ${item.postUri}`}
							onclick={() => openLightbox(item.fullsize, item.alt)}
						>
							<img
								src={item.thumb}
								alt={item.alt || `Image tagged ${item.tags.join(', ')}`}
								loading="lazy"
							/>
						</button>
						<span class="image-overlay">
							<span class="overlay-meta">
								<span class="overlay-tags">
									{#each item.tags as tag}
										<span>#{tag}</span>
									{/each}
									{#each item.matchedTerms as term}
										<span class="overlay-term">“{term}”</span>
									{/each}
									{#each item.classifierMatched as label}
										<span class="overlay-label-hit">🧠 {label}</span>
									{/each}
								</span>
								{#if labels.length > 0}
									<span class="overlay-labels" aria-label="Moderation labels">
										{#each labels.slice(0, 4) as label}
											<span>{label}</span>
										{/each}
									</span>
								{/if}
							</span>
							{#if embedderEnabled}
								<button
									type="button"
									class="overlay-pin"
									title="Find visually similar images"
									onclick={() => pinImageQuery(item, item.tags[0] ?? 'image')}
								>
									📌
								</button>
							{/if}
							<a href={item.postUrl} target="_blank" rel="noreferrer">Post</a>
						</span>
					</div>
				</article>
			{/each}
		</section>
	{/if}
</main>

{#if blastMode && blastCards.length > 0}
	<div class="blast-layer" aria-hidden="true">
		{#each blastCards as card (card.id)}
			<article
				class="blast-card"
				style={card.style}
				onanimationend={() => removeBlastCard(card.id)}
			>
				<img src={card.thumb} alt="" style={`aspect-ratio: ${card.aspectRatio}`} />
			</article>
		{/each}
	</div>
{/if}

<style>
	main {
		width: min(1440px, calc(100vw - 32px));
		margin: 0 auto;
		padding: 28px 0 48px;
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
		font-size: clamp(2rem, 4vw, 3.8rem);
		line-height: 1;
		letter-spacing: 0;
	}

	.subtitle {
		margin-top: 8px;
		color: var(--muted);
		font-size: 1rem;
	}

	.control-panel {
		display: grid;
		gap: 8px;
		padding: 10px 12px;
		background: var(--panel-bg);
		box-shadow: var(--shadow-soft);
	}

	.control-top {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		gap: 10px;
		align-items: end;
	}

	.filter-stack {
		display: grid;
		gap: 6px;
		min-width: 0;
	}

	.blacklist-drawer {
		display: grid;
		gap: 6px;
		justify-items: start;
	}

	.blacklist-toggle {
		width: fit-content;
	}

	.tag-form {
		display: grid;
		gap: 4px;
		width: 100%;
	}

	label {
		color: var(--muted);
		font-size: 0.76rem;
		font-weight: 700;
	}

	.tag-input-row {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto auto;
		gap: 8px;
	}

	.blacklist-form .tag-input-row {
		grid-template-columns: minmax(0, 1fr) auto;
	}

	input {
		min-width: 0;
		min-height: 34px;
		padding: 7px 10px;
		border: 1px solid var(--control-border);
		border-radius: 8px;
		background: var(--input-bg);
		color: var(--text-ink);
		font-size: 0.96rem;
	}

	button {
		min-height: 34px;
		border: 0;
		font-weight: 800;
		line-height: 1;
	}

	button:disabled {
		cursor: not-allowed;
		opacity: 0.52;
	}

	.primary-button,
	.secondary-button {
		padding: 0 13px;
	}

	.primary-button {
		background: var(--accent);
		color: var(--accent-contrast);
	}

	.secondary-button {
		background: var(--control-bg);
		color: var(--text-ink);
	}

	.tag-strip {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
		min-height: 24px;
	}

	.tag-chip {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		min-height: 26px;
		padding: 4px 8px;
		border: 1px solid var(--control-border);
		border-radius: 999px;
		background: color-mix(in srgb, var(--accent) 12%, var(--card-bg));
		color: var(--text-ink);
		font-size: 0.82rem;
	}

	.tag-chip strong {
		display: inline-grid;
		min-width: 20px;
		height: 20px;
		place-items: center;
		border-radius: 999px;
		background: var(--card-bg);
		color: var(--warm-text);
		font-size: 0.78rem;
	}

	.classifier-card {
		display: grid;
		gap: 10px;
		padding: 12px 14px;
		background: var(--card-bg);
	}

	.classifier-head {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 10px;
	}

	.classifier-summary {
		flex: 1 1 auto;
		min-width: 160px;
		color: var(--muted);
		font-size: 0.82rem;
	}

	.classifier-stats {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(96px, 1fr));
		gap: 8px;
	}

	.classifier-controls {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 16px;
	}

	.slider-control {
		display: grid;
		gap: 3px;
		min-width: 170px;
		font-size: 0.8rem;
	}

	.slider-control input {
		width: 100%;
	}

	.label-picker {
		display: grid;
		gap: 8px;
	}

	.label-presets {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
	}

	.label-search {
		width: 100%;
	}

	.label-count {
		margin: 0;
		color: var(--muted);
		font-size: 0.76rem;
	}

	.label-list {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
		gap: 2px 10px;
		max-height: 260px;
		padding: 6px;
		border: 1px solid var(--control-border);
		border-radius: 10px;
		overflow-y: auto;
	}

	.label-option {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 3px 4px;
		border-radius: 6px;
		font-size: 0.8rem;
		cursor: pointer;
	}

	.label-option.selected {
		background: color-mix(in srgb, var(--accent) 16%, transparent);
	}

	.label-images {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(132px, 1fr));
		gap: 8px;
	}

	.label-image {
		display: grid;
		gap: 4px;
		min-width: 0;
	}

	.label-image-actions {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 6px;
		font-size: 0.74rem;
	}

	.query-chip {
		background: color-mix(in srgb, #7b5cbd 18%, var(--card-bg));
	}

	.query-thumb {
		width: 18px;
		height: 18px;
		border-radius: 4px;
		object-fit: cover;
	}

	.semantic-error {
		color: #a33;
		font-size: 0.76rem;
	}

	.overlay-pin {
		flex: 0 0 auto;
		padding: 3px 6px;
		border: none;
		border-radius: 999px;
		background: rgba(255, 255, 255, 0.88);
		font-size: 0.75rem;
		line-height: 1;
		cursor: pointer;
	}

	.label-chip {
		background: color-mix(in srgb, #4a7dbd 18%, var(--card-bg));
	}

	.term-chip {
		background: color-mix(in srgb, var(--warm-text) 14%, var(--card-bg));
		font-style: italic;
	}

	.search-scope {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 12px;
		font-size: 0.8rem;
	}

	.scope-toggle {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		cursor: pointer;
	}

	.scope-hint {
		color: var(--muted);
	}

	.muted-strip {
		opacity: 0.82;
	}

	.muted-chip {
		background: color-mix(in srgb, var(--muted-surface) 74%, var(--card-bg));
	}

	.muted-chip strong {
		min-width: 28px;
		color: var(--muted);
	}

	.control-side {
		display: grid;
		gap: 6px;
		justify-items: end;
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
		width: min(260px, 60vw);
		padding: 6px;
		background: rgba(255, 252, 246, 0.97);
		border-radius: 10px;
		box-shadow: 0 8px 32px rgba(0, 0, 0, 0.45);
		transform: translate(-50%, -50%) scale(0.05);
		animation: blast-out var(--dur, 1800ms) cubic-bezier(0.3, 0.6, 0.6, 1) both;
		animation-delay: var(--delay, 0ms);
		will-change: transform, opacity;
	}

	.blast-card img {
		display: block;
		width: 100%;
		max-height: 60vh;
		object-fit: cover;
		border-radius: 6px;
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

	.moderation-toggle {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		width: fit-content;
		min-height: 34px;
		padding: 5px 9px;
		border: 1px solid var(--control-border);
		border-radius: 999px;
		background: var(--control-bg);
		color: var(--text-ink);
		cursor: pointer;
	}

	.moderation-toggle input {
		width: 15px;
		height: 15px;
		min-width: 15px;
		margin: 0;
		padding: 0;
		accent-color: var(--accent);
	}

	.moderation-toggle span {
		font-weight: 800;
	}

	.moderation-toggle strong {
		display: inline-grid;
		min-width: 32px;
		height: 22px;
		place-items: center;
		border-radius: 999px;
		background: color-mix(in srgb, var(--accent) 14%, var(--card-bg));
		color: var(--warm-text);
		font-size: 0.82rem;
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
		display: inline;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.stat span {
		color: var(--muted);
		font-size: 0.67rem;
		font-weight: 700;
		text-transform: uppercase;
	}

	.stat strong {
		margin-top: 0;
		color: var(--text-ink);
		font-size: 0.9rem;
	}

	.stat strong.live {
		color: #1d7f6e;
	}

	.analytics-card {
		margin-top: 8px;
		overflow: hidden;
		background: var(--panel-bg);
		box-shadow: var(--shadow-soft);
	}

	.analytics-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 10px;
		width: 100%;
		min-height: 42px;
		padding: 8px 12px;
		border: 0;
		background: transparent;
		color: var(--text-ink);
		text-align: left;
	}

	.analytics-header span {
		display: grid;
		gap: 2px;
		min-width: 0;
	}

	.analytics-header strong {
		font-size: 0.98rem;
	}

	.analytics-header small {
		overflow: hidden;
		color: var(--muted);
		font-size: 0.78rem;
		font-weight: 700;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.analytics-header em {
		flex: 0 0 auto;
		padding: 6px 9px;
		border: 1px solid var(--control-border);
		border-radius: 999px;
		background: var(--control-bg);
		font-style: normal;
		font-weight: 800;
	}

	.analytics-body {
		padding: 0 18px 18px;
	}

	.analytics-warning {
		width: fit-content;
		max-width: 100%;
		padding: 2px 7px;
		border: 1px solid color-mix(in srgb, #d38b1f 60%, var(--control-border));
		border-radius: 999px;
		background: color-mix(in srgb, #f6c453 22%, var(--panel-bg-plain));
		color: color-mix(in srgb, #7b4a00 72%, var(--text-ink));
		font-size: 0.72rem;
		font-weight: 800;
		line-height: 1.2;
	}

	.analytics-grid {
		display: grid;
		grid-template-columns: minmax(0, 1.15fr) minmax(280px, 0.85fr);
		gap: 14px;
	}

	.analytics-stack {
		display: grid;
		gap: 14px;
		min-width: 0;
	}

	.analytics-section {
		min-width: 0;
		padding: 12px;
		border: 1px solid var(--control-border);
		border-radius: 8px;
		background: var(--panel-bg-plain);
	}

	.analytics-section h2 {
		margin: 0 0 10px;
		color: var(--text-ink);
		font-size: 1rem;
		line-height: 1.15;
	}

	.analytics-section-heading {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		margin-bottom: 10px;
	}

	.analytics-section-heading h2 {
		margin: 0;
	}

	.preview-actions {
		display: flex;
		flex: 0 0 auto;
		flex-wrap: wrap;
		justify-content: flex-end;
		gap: 6px;
	}

	.mini-action {
		min-height: 28px;
		padding: 5px 8px;
		border: 1px solid var(--control-border);
		border-radius: 999px;
		background: var(--control-bg);
		color: var(--text-ink);
		font-size: 0.75rem;
	}

	.primary-action {
		border-color: color-mix(in srgb, var(--accent) 55%, var(--control-border));
		background: color-mix(in srgb, var(--accent) 14%, var(--control-bg));
		font-weight: 800;
	}

	.analytics-empty {
		color: var(--muted);
		font-size: 0.95rem;
	}

	.ranked-tags {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
		gap: 8px;
		max-height: 360px;
		overflow: auto;
		padding-right: 2px;
	}

	.ranked-tag {
		display: grid;
		gap: 3px;
		min-height: 52px;
		padding: 8px 10px;
		border: 1px solid var(--control-border);
		border-radius: 8px;
		background: var(--card-bg);
		color: var(--text-ink);
		text-align: left;
	}

	.ranked-tag.active,
	.ranked-tag.selected,
	.stream-event-tags button.selected,
	.stream-event-tags button.active {
		border-color: color-mix(in srgb, var(--accent) 56%, var(--control-border));
		background: color-mix(in srgb, var(--accent) 16%, var(--card-bg));
	}

	.ranked-tag.selected,
	.stream-event-tags button.selected {
		box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 20%, transparent);
	}

	.ranked-tag span {
		overflow: hidden;
		font-weight: 900;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.ranked-tag small {
		overflow: hidden;
		color: var(--muted);
		font-size: 0.76rem;
		font-weight: 700;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.stream-events,
	.tag-posts {
		display: grid;
		gap: 8px;
		max-height: 360px;
		overflow: auto;
		padding-right: 2px;
	}

	.analytics-stack .stream-events,
	.tag-posts {
		max-height: 220px;
	}

	.stream-event,
	.tag-post {
		display: grid;
		gap: 7px;
		padding: 9px;
		border: 1px solid var(--control-border);
		border-radius: 8px;
		background: var(--card-bg);
	}

	.stream-event-meta {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 7px;
		color: var(--muted);
		font-size: 0.78rem;
		font-weight: 800;
	}

	.stream-event-meta strong {
		padding: 3px 6px;
		border-radius: 999px;
		background: color-mix(in srgb, #1d7f6e 15%, var(--card-bg));
		color: #1d7f6e;
		font-size: 0.72rem;
		text-transform: uppercase;
	}

	.stream-event-text,
	.tag-post-text {
		display: -webkit-box;
		margin: 0;
		overflow: hidden;
		color: var(--text-ink);
		font-size: 0.84rem;
		font-weight: 650;
		line-height: 1.25;
		-webkit-box-orient: vertical;
		-webkit-line-clamp: 3;
	}

	.event-images {
		display: grid;
		grid-template-columns: repeat(4, minmax(0, 1fr));
		gap: 6px;
	}

	.event-images.compact {
		grid-template-columns: repeat(3, minmax(0, 72px));
	}

	.event-image-label {
		position: absolute;
		left: 3px;
		right: 3px;
		bottom: 3px;
		display: flex;
		justify-content: space-between;
		gap: 4px;
		padding: 2px 5px;
		border-radius: 5px;
		background: rgba(20, 20, 20, 0.72);
		color: #f4f4f4;
		font-size: 0.66rem;
		line-height: 1.2;
		text-align: left;
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
	}

	.event-image-label em {
		flex: 0 0 auto;
		font-style: normal;
		opacity: 0.8;
	}

	.event-image-button {
		position: relative;
		width: 100%;
		min-height: 0;
		padding: 0;
		overflow: hidden;
		border: 1px solid var(--control-border);
		border-radius: 7px;
		background: var(--muted-surface);
		aspect-ratio: var(--image-ratio);
	}

	.event-image-button img {
		display: block;
		width: 100%;
		height: 100%;
		object-fit: cover;
	}

	.stream-event-tags {
		display: flex;
		flex-wrap: wrap;
		gap: 5px;
	}

	.stream-event-tags button {
		min-height: 26px;
		padding: 4px 7px;
		border: 1px solid var(--control-border);
		border-radius: 999px;
		background: var(--control-bg);
		color: var(--text-ink);
		font-size: 0.78rem;
	}

	.empty-state {
		margin-top: 18px;
		padding: 42px 20px;
		background: var(--card-bg);
		text-align: center;
		box-shadow: var(--shadow-soft);
	}

	.empty-state h2 {
		color: var(--muted);
		font-size: 1.2rem;
	}

	.gallery {
		column-width: 240px;
		column-gap: 12px;
		margin-top: 18px;
	}

	.image-card {
		display: inline-block;
		width: 100%;
		margin: 0 0 12px;
		overflow: hidden;
		border-radius: 8px;
		background: color-mix(in srgb, var(--card-bg) 86%, var(--muted-surface));
		box-shadow: var(--shadow-soft);
		break-inside: avoid;
		transition:
			transform 150ms ease,
			box-shadow 150ms ease;
	}

	.image-card:hover {
		transform: translateY(-2px);
		box-shadow: var(--shadow-medium);
	}

	.image-frame {
		position: relative;
		width: 100%;
		overflow: hidden;
		aspect-ratio: var(--image-ratio);
		background: var(--muted-surface);
		border-radius: 8px;
	}

	.image-button {
		display: block;
		width: 100%;
		height: 100%;
		min-height: 0;
		padding: 0;
		background: transparent;
		border: 0;
		border-radius: 8px;
	}

	.image-button img {
		display: block;
		width: 100%;
		height: 100%;
		object-fit: contain;
	}

	.image-overlay {
		position: absolute;
		inset: auto 0 0;
		display: flex;
		align-items: flex-end;
		justify-content: space-between;
		gap: 8px;
		padding: 26px 9px 9px;
		background: linear-gradient(to top, rgba(0, 0, 0, 0.72), rgba(0, 0, 0, 0));
		color: white;
		opacity: 0;
		transition: opacity 150ms ease;
	}

	.image-frame:hover .image-overlay,
	.image-frame:focus-within .image-overlay {
		opacity: 1;
	}

	.overlay-meta {
		display: grid;
		flex: 1 1 auto;
		gap: 5px;
		min-width: 0;
	}

	.overlay-labels,
	.overlay-tags {
		display: flex;
		flex-wrap: wrap;
		gap: 5px;
		min-width: 0;
	}

	.overlay-labels span,
	.overlay-tags span,
	.image-overlay a {
		border-radius: 999px;
		background: rgba(255, 255, 255, 0.88);
		color: #1e1e1e;
		font-size: 0.75rem;
		font-weight: 800;
		line-height: 1;
	}

	.overlay-labels span,
	.overlay-tags span {
		max-width: 100%;
		padding: 5px 7px;
		overflow-wrap: anywhere;
		line-height: 1.1;
	}

	.overlay-labels span {
		background: rgba(255, 226, 214, 0.94);
		color: #8a321c;
	}

	.overlay-tags span.overlay-label-hit {
		background: rgba(214, 236, 222, 0.94);
		color: #1c6b3e;
	}

	.overlay-tags span.overlay-term {
		background: rgba(222, 238, 255, 0.94);
		color: #1c4a8a;
		font-style: italic;
	}

	.image-overlay a {
		flex: 0 0 auto;
		padding: 6px 8px;
		text-decoration: none;
	}

	@media (max-width: 760px) {
		main {
			width: min(100vw - 20px, 100%);
			padding-top: 18px;
		}

		.title-row,
		.tag-input-row,
		.control-top {
			grid-template-columns: 1fr;
		}

		.title-row {
			display: grid;
		}

		.stats-grid {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}

		.analytics-header {
			align-items: flex-start;
			padding: 12px;
		}

		.analytics-body {
			padding: 0 12px 12px;
		}

		.analytics-grid {
			grid-template-columns: 1fr;
		}

		.ranked-tags,
		.stream-events,
		.tag-posts {
			max-height: 300px;
		}

		.gallery {
			column-width: 160px;
			column-gap: 8px;
		}

		.image-card {
			margin-bottom: 8px;
		}

		.image-overlay {
			opacity: 1;
		}
	}
</style>
