import { getProfiles, type ProfileInfo } from '$lib/api/bluesky';
import type { TownDialogueLine, TownNpcData } from '$lib/town/types';
import {
	buildAtUri,
	buildBskyPostUrl,
	extractBskyPostUrlsFromFacets
} from '$lib/utils/viewerLinks';

const JETSTREAM_URLS = [
	'wss://jetstream1.us-east.bsky.network/subscribe',
	'wss://jetstream2.us-east.bsky.network/subscribe',
	'wss://jetstream1.us-west.bsky.network/subscribe',
	'wss://jetstream2.us-west.bsky.network/subscribe'
];
const DEFAULT_MAX_NPCS = 140;
const MAX_LINES_PER_AUTHOR = 24;
const PROFILE_BATCH_DELAY_MS = 180;
const POPULATION_EMIT_DELAY_MS = 600;
const MAX_RECONNECT_DELAY_MS = 15000;
const LIVE_CURSOR_REWIND_US = 20_000_000;
const RECONNECT_CURSOR_REWIND_US = 3_000_000;
const STALL_RECONNECT_MS = 9000;

const palette = [
	'#d95d39',
	'#2a9d8f',
	'#5c7aff',
	'#e9c46a',
	'#c44569',
	'#4d908e',
	'#9c6644',
	'#577590',
	'#8ab17d',
	'#b56576'
];

const timestampFormatter = new Intl.DateTimeFormat('en-US', {
	month: 'short',
	day: '2-digit',
	hour: '2-digit',
	minute: '2-digit',
	hour12: false
});

export type TownFirehoseStatus = 'idle' | 'connecting' | 'live' | 'reconnecting' | 'error';

export type TownFirehoseSnapshot = {
	npcs: TownNpcData[];
	scannedPosts: number;
	uniqueAuthors: number;
};

type JetstreamCommitRecord = {
	$type?: string;
	text?: string;
	createdAt?: string;
	facets?: any[];
	embed?: {
		$type?: string;
	};
};

type JetstreamEvent = {
	did?: string;
	kind?: string;
	time_us?: number | string;
	commit?: {
		operation?: string;
		collection?: string;
		rkey?: string;
		record?: JetstreamCommitRecord;
	};
};

type FirehoseControllerOptions = {
	maxNpcs?: number;
	onSnapshot: (snapshot: TownFirehoseSnapshot) => void;
	onStatusChange?: (status: TownFirehoseStatus) => void;
	onError?: (message: string | null) => void;
};

export type TownFirehoseController = {
	dispose: () => void;
};

function buildJetstreamUrl(endpointIndex: number, cursorUs: number): string {
	const url = new URL(JETSTREAM_URLS[((endpointIndex % JETSTREAM_URLS.length) + JETSTREAM_URLS.length) % JETSTREAM_URLS.length]);
	url.searchParams.append('wantedCollections', 'app.bsky.feed.post');
	url.searchParams.set('cursor', String(Math.max(0, Math.round(cursorUs))));
	return url.toString();
}

function hashString(input: string): number {
	let hash = 0;
	for (let index = 0; index < input.length; index++) {
		hash = (hash * 31 + input.charCodeAt(index)) >>> 0;
	}
	return hash;
}

function pickColorHex(seed: string): string {
	return palette[hashString(seed) % palette.length];
}

function normalizeDialogueText(text: string): string {
	return text.trim();
}

function buildFallbackDialogue(embedType: string): string {
	if (embedType.includes('images')) return '[shared images]';
	if (embedType.includes('external')) return '[shared a link]';
	if (embedType.includes('recordWithMedia')) return '[shared a quoted post with media]';
	if (embedType.includes('record')) return '[shared a quoted post]';
	return '[shared a post without text]';
}

function buildDialogueLine(
	did: string,
	handle: string,
	record: JetstreamCommitRecord,
	rkey: string
): TownDialogueLine | null {
	const uri = buildAtUri(did, rkey);
	if (!uri) return null;

	const createdAt = record.createdAt ?? new Date().toISOString();
	const text = normalizeDialogueText(record.text ?? '') || buildFallbackDialogue(record.embed?.$type ?? '');

	return {
		id: uri,
		uri,
		text,
		createdAtLabel: timestampFormatter.format(new Date(createdAt)),
		permalink: buildBskyPostUrl(uri, handle || did),
		linkedUrls: extractBskyPostUrlsFromFacets(record.facets),
		embed: undefined
	};
}

function applyProfile(npc: TownNpcData, profile: ProfileInfo | undefined) {
	if (!profile) return;
	npc.handle = profile.handle;
	npc.displayName = profile.displayName?.trim() || profile.handle;
	npc.avatar = profile.avatar ?? null;
	for (const line of npc.lines) {
		line.permalink = buildBskyPostUrl(line.uri, profile.handle);
	}
}

export function connectTownFirehose(options: FirehoseControllerOptions): TownFirehoseController {
	const maxNpcs = options.maxNpcs ?? DEFAULT_MAX_NPCS;
	const onStatusChange = options.onStatusChange ?? (() => undefined);
	const onError = options.onError ?? (() => undefined);

	let disposed = false;
	let socket: WebSocket | null = null;
	let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	let populationEmitTimer: ReturnType<typeof setTimeout> | null = null;
	let profileBatchTimer: ReturnType<typeof setTimeout> | null = null;
	let stallTimer: ReturnType<typeof setTimeout> | null = null;
	let reconnectAttempt = 0;
	let scannedPosts = 0;
	let endpointIndex = 0;
	let lastCursorUs: number | null = null;
	let lastMessageAt = 0;

	const npcByDid = new Map<string, TownNpcData>();
	const lastSeenByDid = new Map<string, number>();
	const profileCache = new Map<string, ProfileInfo>();
	const pendingProfileDids = new Set<string>();

	function clearStallTimer() {
		if (!stallTimer) return;
		clearTimeout(stallTimer);
		stallTimer = null;
	}

	function scheduleStallReconnect() {
		clearStallTimer();
		stallTimer = setTimeout(() => {
			if (disposed || !socket) return;
			const idleForMs = Date.now() - lastMessageAt;
			if (idleForMs < STALL_RECONNECT_MS - 50) {
				scheduleStallReconnect();
				return;
			}
			onStatusChange('reconnecting');
			onError('Firehose mode is reconnecting to a busier Jetstream instance.');
			socket.close();
		}, STALL_RECONNECT_MS);
	}

	function emitSnapshot() {
		if (populationEmitTimer) {
			clearTimeout(populationEmitTimer);
		}
		populationEmitTimer = setTimeout(() => {
			populationEmitTimer = null;
			if (disposed) return;
			options.onSnapshot({
				npcs: [...npcByDid.values()],
				scannedPosts,
				uniqueAuthors: npcByDid.size
			});
		}, POPULATION_EMIT_DELAY_MS);
	}

	async function flushProfiles() {
		profileBatchTimer = null;
		if (disposed || pendingProfileDids.size === 0) return;

		const dids = [...pendingProfileDids].slice(0, 25);
		for (const did of dids) pendingProfileDids.delete(did);

		try {
			const profiles = await getProfiles(dids);
			for (const profile of profiles) {
				profileCache.set(profile.did, profile);
				const npc = npcByDid.get(profile.did);
				if (npc) {
					applyProfile(npc, profile);
				}
			}
			emitSnapshot();
		} catch {
			for (const did of dids) pendingProfileDids.add(did);
		} finally {
			if (!disposed && pendingProfileDids.size > 0 && !profileBatchTimer) {
				profileBatchTimer = setTimeout(() => {
					void flushProfiles();
				}, PROFILE_BATCH_DELAY_MS);
			}
		}
	}

	function scheduleProfileFetch(did: string) {
		if (profileCache.has(did) || pendingProfileDids.has(did)) return;
		pendingProfileDids.add(did);
		if (profileBatchTimer) return;
		profileBatchTimer = setTimeout(() => {
			void flushProfiles();
		}, PROFILE_BATCH_DELAY_MS);
	}

	function trimNpcPool() {
		if (npcByDid.size <= maxNpcs) return;

		let oldestDid: string | null = null;
		let oldestSeen = Number.POSITIVE_INFINITY;
		for (const [did, lastSeen] of lastSeenByDid.entries()) {
			if (lastSeen >= oldestSeen) continue;
			oldestSeen = lastSeen;
			oldestDid = did;
		}

		if (!oldestDid) return;
		npcByDid.delete(oldestDid);
		lastSeenByDid.delete(oldestDid);
	}

	function processEvent(message: string) {
		let parsed: JetstreamEvent;
		try {
			parsed = JSON.parse(message) as JetstreamEvent;
		} catch {
			return;
		}

		if (parsed.kind !== 'commit') return;
		if (parsed.commit?.operation !== 'create') return;
		if (parsed.commit?.collection !== 'app.bsky.feed.post') return;

		const did = String(parsed.did ?? '').trim();
		const rkey = String(parsed.commit.rkey ?? '').trim();
		const record = parsed.commit.record;
		if (!did || !rkey || !record) return;
		const cursorUs = Number(parsed.time_us);
		if (Number.isFinite(cursorUs) && cursorUs > 0) {
			lastCursorUs = Math.round(cursorUs);
		}

		scannedPosts += 1;

		let npc = npcByDid.get(did);
		if (!npc) {
			const profile = profileCache.get(did);
			npc = {
				id: did,
				did,
				handle: profile?.handle ?? did,
				displayName: profile?.displayName?.trim() || profile?.handle || did,
				avatar: profile?.avatar ?? null,
				colorHex: pickColorHex(did),
				lines: []
			};
			npcByDid.set(did, npc);
		}

		const line = buildDialogueLine(did, npc.handle, record, rkey);
		if (!line) return;

		if (!npc.lines.some((entry) => entry.id === line.id)) {
			npc.lines.unshift(line);
			if (npc.lines.length > MAX_LINES_PER_AUTHOR) {
				npc.lines.length = MAX_LINES_PER_AUTHOR;
			}
		}

		lastSeenByDid.set(did, Date.now());
		trimNpcPool();
		scheduleProfileFetch(did);
		emitSnapshot();
	}

	async function decodeMessageData(data: unknown): Promise<string | null> {
		if (typeof data === 'string') return data;
		if (data instanceof Blob) return await data.text();
		if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
		if (ArrayBuffer.isView(data)) {
			return new TextDecoder().decode(data);
		}
		return null;
	}

	async function handleSocketMessage(data: unknown) {
		const message = await decodeMessageData(data);
		if (!message || disposed) return;
		lastMessageAt = Date.now();
		scheduleStallReconnect();
		processEvent(message);
	}

	function scheduleReconnect() {
		if (disposed || reconnectTimer) return;
		const delay = Math.min(1000 * 2 ** reconnectAttempt, MAX_RECONNECT_DELAY_MS);
		reconnectAttempt += 1;
		endpointIndex = (endpointIndex + 1) % JETSTREAM_URLS.length;
		onStatusChange('reconnecting');
		reconnectTimer = setTimeout(() => {
			reconnectTimer = null;
			connect();
		}, delay);
	}

	function connect() {
		if (disposed) return;

		onStatusChange(reconnectAttempt > 0 ? 'reconnecting' : 'connecting');
		onError(null);
		clearStallTimer();

		const cursorUs =
			lastCursorUs && Number.isFinite(lastCursorUs)
				? Math.max(0, lastCursorUs - RECONNECT_CURSOR_REWIND_US)
				: Date.now() * 1000 - LIVE_CURSOR_REWIND_US;
		socket = new WebSocket(buildJetstreamUrl(endpointIndex, cursorUs));
		socket.binaryType = 'arraybuffer';

		socket.onopen = () => {
			reconnectAttempt = 0;
			lastMessageAt = Date.now();
			onStatusChange('live');
			onError(null);
			scheduleStallReconnect();
		};

		socket.onmessage = (event) => {
			void handleSocketMessage(event.data);
		};

		socket.onerror = () => {
			onStatusChange('error');
			onError('Firehose mode lost the live stream connection.');
		};

		socket.onclose = () => {
			socket = null;
			if (disposed) return;
			scheduleReconnect();
		};
	}

	connect();

	return {
		dispose() {
			disposed = true;
			if (reconnectTimer) clearTimeout(reconnectTimer);
			if (populationEmitTimer) clearTimeout(populationEmitTimer);
			if (profileBatchTimer) clearTimeout(profileBatchTimer);
			clearStallTimer();
			socket?.close();
			socket = null;
			onStatusChange('idle');
		}
	};
}
