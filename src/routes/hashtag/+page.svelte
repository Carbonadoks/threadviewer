<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { browser } from '$app/environment';
	import '../../app.css';
	import FontPicker from '$lib/components/FontPicker.svelte';
	import RouteNav from '$lib/components/RouteNav.svelte';
	import { openLightbox } from '$lib/stores/lightbox';

	const JETSTREAM_URL = 'wss://jetstream2.us-east.bsky.network/subscribe';
	const MAX_GALLERY_ITEMS = 140;
	const MAX_GALLERY_CANDIDATES = 280;
	const MAX_STREAM_EVENTS = 80;
	const MAX_RECENT_POSTS_PER_TAG = 36;
	const MAX_TRACKED_STREAM_TAGS = 400;
	const STORAGE_TAGS_KEY = 'hashtag-gallery-tags';
	const STORAGE_BLACKLIST_KEY = 'hashtag-gallery-blacklist';
	const STORAGE_MODERATION_KEY = 'hashtag-gallery-moderation';
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
	let watchedTags = $state<string[]>(['art', 'photography', 'nature']);
	let blacklistedTags = $state<string[]>([]);
	let status = $state<StreamStatus>('idle');
	let statusMessage = $state('Ready');
	let galleryCandidates = $state<GalleryImage[]>([]);
	let postsSeen = $state(0);
	let imagePostsSeen = $state(0);
	let matchingPostsSeen = $state(0);
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
	let socket: WebSocket | null = null;
	let seenImageIds = new Set<string>();
	const adultCheckCache = new Map<string, AdultCheckCacheEntry>();
	const activeModerationRefreshes = new Set<string>();

	const watchedTagSet = $derived(new Set(watchedTags.map((tag) => tag.toLowerCase())));
	const blacklistedTagSet = $derived(new Set(blacklistedTags.map((tag) => tag.toLowerCase())));
	const galleryItems = $derived(
		galleryCandidates
			.filter(
				(item) =>
					!hasBlacklistedTag(item.tags) &&
					(!moderationEnabled || (item.moderationChecked && !item.moderationBlocked))
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

	function applyTags() {
		const nextTags = parseTagList(tagInput);
		const nextTagSet = new Set(nextTags);
		watchedTags = nextTags;
		tagInput = nextTags.join(', ');
		galleryCandidates =
			nextTags.length === 0
				? []
				: galleryCandidates.filter((item) =>
						item.tags.some((tag) => nextTagSet.has(tag.toLowerCase()))
					);
		seenImageIds = new Set(galleryCandidates.map((item) => item.id));
		try {
			localStorage.setItem(STORAGE_TAGS_KEY, tagInput);
		} catch {}
		updateQuery(nextTags);
		for (const tag of nextTags) {
			void hydrateGalleryFromRecentTag(tag);
		}
	}

	function updateQuery(tags: string[]) {
		if (!browser) return;
		const next = new URL(window.location.href);
		if (tags.length > 0) {
			next.searchParams.set('tags', tags.join(','));
		} else {
			next.searchParams.delete('tags');
		}
		window.history.replaceState({}, '', next.toString());
	}

	function persistTags() {
		tagInput = watchedTags.join(', ');
		try {
			localStorage.setItem(STORAGE_TAGS_KEY, tagInput);
		} catch {}
		updateQuery(watchedTags);
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

	async function hydrateGalleryFromRecentTag(tag: string) {
		if (blacklistedTagSet.has(tag)) return;
		const events = recentPostsByTag[tag] ?? [];
		const eventsWithImages = events.filter((event) => event.images.length > 0);
		if (eventsWithImages.length === 0) return;

		const nextItems: GalleryImage[] = [];
		const pendingModeration = new Map<string, { base: AdultCheck; createdAt: string }>();
		for (const event of eventsWithImages) {
			const itemTags = event.tags;
			if (itemTags.length === 0) continue;
			let eventAdded = false;
			for (const image of event.images) {
				if (seenImageIds.has(image.id)) continue;
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
					tags: itemTags,
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
			for (const [uri, moderation] of pendingModeration.entries()) {
				void moderateImagePost(uri, moderation.base, moderation.createdAt);
			}
		}
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

		if (watchedTags.length === 0) return;
		const matchedTags = postTags.filter((tag) => watchedTagSet.has(tag));
		if (matchedTags.length === 0) return;
		matchingPostsSeen += 1;

		if (watchedTags.length === 0 || matchedTags.every((tag) => !watchedTagSet.has(tag))) {
			return;
		}

		const nextItems: GalleryImage[] = [];
		eventImages.forEach((image) => {
			if (seenImageIds.has(image.id)) return;
			seenImageIds.add(image.id);
			nextItems.push({
				id: image.id,
				postUri: uri,
				postUrl: postUrl(did, rkey),
				thumb: image.thumb,
				fullsize: image.fullsize,
				alt: image.alt,
				aspectRatio: image.aspectRatio,
				tags: postTags,
				createdAt,
				authorDid: image.authorDid,
				moderationChecked,
				moderationBlocked: initialModeration.blocked,
				moderationLabels: initialModeration.labels
			});
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

	function handleBlacklistSubmit(event: Event) {
		event.preventDefault();
		applyBlacklist();
	}

	function removeTag(tag: string) {
		const nextTags = watchedTags.filter((candidate) => candidate !== tag);
		watchedTags = nextTags;
		tagInput = watchedTags.join(', ');
		galleryCandidates = galleryCandidates.filter((item) =>
			watchedTags.length > 0 && item.tags.some((itemTag) => watchedTags.includes(itemTag))
		);
		seenImageIds = new Set(galleryCandidates.map((item) => item.id));
		try {
			localStorage.setItem(STORAGE_TAGS_KEY, tagInput);
		} catch {}
		updateQuery(watchedTags);
		if (watchedTags.length === 0) {
			galleryCandidates = [];
			seenImageIds = new Set();
		}
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
		updateQuery(watchedTags);
		connectJetstream();
	});

	onDestroy(() => {
		disconnectJetstream();
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
				<span>Matches</span>
				<strong>{matchingPostsSeen.toLocaleString()}</strong>
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
														<button
															type="button"
															class="event-image-button"
															aria-label={`Open image from ${event.uri}`}
															style={`--image-ratio: ${image.aspectRatio}`}
															onclick={() => openLightbox(image.fullsize, image.alt)}
														>
															<img src={image.thumb} alt={image.alt || `Image tagged ${event.tags.join(', ')}`} />
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
														<button
															type="button"
															class="event-image-button"
															aria-label={`Open image from ${event.uri}`}
															style={`--image-ratio: ${image.aspectRatio}`}
															onclick={() => openLightbox(image.fullsize, image.alt)}
														>
															<img src={image.thumb} alt={image.alt || `Image tagged ${event.tags.join(', ')}`} />
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

	{#if watchedTags.length === 0}
		<section class="empty-state wobbly-border-light">
			<h2>Add hashtags to fill the gallery.</h2>
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
								</span>
								{#if labels.length > 0}
									<span class="overlay-labels" aria-label="Moderation labels">
										{#each labels.slice(0, 4) as label}
											<span>{label}</span>
										{/each}
									</span>
								{/if}
							</span>
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

	.event-image-button {
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
