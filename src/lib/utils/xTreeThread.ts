import type { EmbedImage, QuotedRecordEmbed, SelfReplyThread, ThreadPost } from '$lib/types';
import type { FixupXTweet } from '$lib/api/x';

/**
 * Payload produced by the xtreeviewer Tampermonkey grabber
 * (static/xtreeviewer.user.js) running on x.com. See docs/xtreeviewer-spec.md.
 */
export const X_CAPTURE_MESSAGE_TYPE = 'xtreeviewer:thread';
export const X_CAPTURE_ACK_TYPE = 'xtreeviewer:ack';
export const X_CAPTURE_VERSION = 1;

export type XCapturedMedia = {
	type: string;
	url: string;
	thumb?: string;
	alt?: string;
	width?: number;
	height?: number;
};

export type XCapturedTweet = {
	id: string;
	parentId?: string | null;
	userId?: string;
	handle: string;
	name?: string;
	avatar?: string;
	text: string;
	createdAt?: string;
	likes?: number;
	retweets?: number;
	replies?: number;
	quotes?: number;
	views?: number;
	media?: XCapturedMedia[];
	quotedId?: string | null;
};

export type XThreadCapture = {
	type: typeof X_CAPTURE_MESSAGE_TYPE;
	version: number;
	capturedAt?: string;
	focusId?: string;
	partial?: boolean;
	tweets: XCapturedTweet[];
};

export type XQuoteRef = {
	post: ThreadPost;
	quotedId: string;
};

export type XThreadConversion = {
	thread: SelfReplyThread & { isTruncated?: boolean };
	url: string;
	rootHandle: string;
	tweetCount: number;
	droppedCount: number;
	/** Posts that quote another tweet, to be hydrated via fxtwitter. */
	quoteRefs: XQuoteRef[];
};

function asString(value: unknown): string {
	return typeof value === 'string' ? value : '';
}

function asCount(value: unknown): number {
	const numeric = Number(value);
	return Number.isFinite(numeric) ? Math.max(0, Math.round(numeric)) : 0;
}

function normalizeCapturedMedia(value: unknown): XCapturedMedia[] {
	if (!Array.isArray(value)) return [];
	const media: XCapturedMedia[] = [];
	for (const raw of value) {
		if (!raw || typeof raw !== 'object') continue;
		const candidate = raw as Record<string, unknown>;
		const url = asString(candidate.url).trim();
		if (!url) continue;
		media.push({
			type: asString(candidate.type) || 'photo',
			url,
			thumb: asString(candidate.thumb) || undefined,
			alt: asString(candidate.alt) || undefined,
			width: Number.isFinite(Number(candidate.width)) ? Number(candidate.width) : undefined,
			height: Number.isFinite(Number(candidate.height)) ? Number(candidate.height) : undefined
		});
	}
	return media;
}

function normalizeCapturedTweet(value: unknown): XCapturedTweet | null {
	if (!value || typeof value !== 'object') return null;
	const candidate = value as Record<string, unknown>;
	const id = asString(candidate.id).trim();
	const handle = asString(candidate.handle).replace(/^@/, '').trim();
	if (!/^\d+$/.test(id) || !handle) return null;

	const parentId = asString(candidate.parentId).trim();
	const quotedId = asString(candidate.quotedId).trim();

	return {
		id,
		parentId: /^\d+$/.test(parentId) ? parentId : null,
		userId: asString(candidate.userId).trim() || undefined,
		handle,
		name: asString(candidate.name).trim() || undefined,
		avatar: asString(candidate.avatar).trim() || undefined,
		text: asString(candidate.text),
		createdAt: asString(candidate.createdAt).trim() || undefined,
		likes: asCount(candidate.likes),
		retweets: asCount(candidate.retweets),
		replies: asCount(candidate.replies),
		quotes: asCount(candidate.quotes),
		views: Number.isFinite(Number(candidate.views)) ? Number(candidate.views) : undefined,
		media: normalizeCapturedMedia(candidate.media),
		quotedId: /^\d+$/.test(quotedId) ? quotedId : null
	};
}

/** Validate + normalize an untrusted capture payload (postMessage or pasted JSON). */
export function parseXThreadCapture(raw: unknown): XThreadCapture | null {
	let value = raw;
	if (typeof value === 'string') {
		try {
			value = JSON.parse(value);
		} catch {
			return null;
		}
	}
	if (!value || typeof value !== 'object') return null;
	const candidate = value as Record<string, unknown>;
	if (candidate.type !== X_CAPTURE_MESSAGE_TYPE) return null;
	if (Number(candidate.version) !== X_CAPTURE_VERSION) return null;
	if (!Array.isArray(candidate.tweets)) return null;

	const seen = new Set<string>();
	const tweets: XCapturedTweet[] = [];
	for (const rawTweet of candidate.tweets) {
		const tweet = normalizeCapturedTweet(rawTweet);
		if (!tweet || seen.has(tweet.id)) continue;
		seen.add(tweet.id);
		tweets.push(tweet);
	}
	if (tweets.length === 0) return null;

	const focusId = asString(candidate.focusId).trim();
	return {
		type: X_CAPTURE_MESSAGE_TYPE,
		version: X_CAPTURE_VERSION,
		capturedAt: asString(candidate.capturedAt) || undefined,
		focusId: seen.has(focusId) ? focusId : undefined,
		partial: candidate.partial === true,
		tweets
	};
}

export function buildXPostUrl(handle: string, id: string): string {
	return `https://x.com/${encodeURIComponent(handle)}/status/${id}`;
}

function parseXDate(value: string | undefined): number {
	if (!value) return 0;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : 0;
}

function toIsoDate(value: string | undefined, fallbackId: string): string {
	const parsed = parseXDate(value);
	if (parsed > 0) return new Date(parsed).toISOString();
	// Derive from the snowflake id (ms since the Twitter epoch in the top bits).
	try {
		const ms = Number(BigInt(fallbackId) >> 22n) + 1288834974657;
		if (Number.isFinite(ms) && ms > 0) return new Date(ms).toISOString();
	} catch {
		// fall through
	}
	return new Date(0).toISOString();
}

function buildImages(media: XCapturedMedia[] | undefined): EmbedImage[] {
	if (!media) return [];
	return media
		.filter((item) => item.type === 'photo' && item.url)
		.map((item) => ({
			thumb: item.thumb || item.url,
			fullsize: item.url,
			alt: item.alt ?? '',
			aspectRatio:
				item.width && item.height ? { width: item.width, height: item.height } : undefined
		}));
}

function toThreadPost(tweet: XCapturedTweet): ThreadPost {
	const images = buildImages(tweet.media);
	const video = tweet.media?.find((item) => item.type === 'video' || item.type === 'animated_gif');

	return {
		uri: buildXPostUrl(tweet.handle, tweet.id),
		cid: tweet.id,
		author: {
			did: tweet.userId ? `x:${tweet.userId}` : `x:@${tweet.handle}`,
			handle: tweet.handle,
			displayName: tweet.name,
			avatar: tweet.avatar
		},
		text: tweet.text,
		createdAt: toIsoDate(tweet.createdAt, tweet.id),
		likeCount: tweet.likes ?? 0,
		repostCount: tweet.retweets ?? 0,
		replyCount: tweet.replies ?? 0,
		quoteCount: tweet.quotes ?? 0,
		embed:
			images.length > 0
				? { type: 'images', images }
				: video
					? {
							type: 'external',
							external: {
								uri: buildXPostUrl(tweet.handle, tweet.id),
								title: video.type === 'animated_gif' ? 'GIF on X' : 'Video on X',
								description: video.alt ?? '',
								thumb: video.thumb || video.url
							}
						}
					: undefined,
		children: []
	};
}

function measureDepth(post: ThreadPost): number {
	let deepest = 1;
	for (const child of post.children) {
		deepest = Math.max(deepest, 1 + measureDepth(child));
	}
	return deepest;
}

function countPosts(post: ThreadPost): number {
	let total = 1;
	for (const child of post.children) total += countPosts(child);
	return total;
}

/**
 * Build a ThreadPost tree from a capture. Root selection: the topmost captured
 * ancestor of the focal tweet when known, otherwise the parentless tweet with
 * the largest subtree. Orphan subtrees (parent not captured) are attached under
 * the root so no captured tweet is lost.
 */
export function convertXCaptureToThread(capture: XThreadCapture): XThreadConversion | null {
	const byId = new Map<string, XCapturedTweet>();
	for (const tweet of capture.tweets) byId.set(tweet.id, tweet);

	const nodes = new Map<string, ThreadPost>();
	for (const tweet of capture.tweets) nodes.set(tweet.id, toThreadPost(tweet));

	for (const tweet of capture.tweets) {
		if (!tweet.parentId) continue;
		const parent = nodes.get(tweet.parentId);
		const child = nodes.get(tweet.id);
		if (parent && child) {
			child.parentUri = parent.uri;
			parent.children.push(child);
		}
	}

	for (const node of nodes.values()) {
		node.children.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
	}

	const rootIds = capture.tweets
		.filter((tweet) => !tweet.parentId || !byId.has(tweet.parentId))
		.map((tweet) => tweet.id);
	if (rootIds.length === 0) return null;

	let rootId: string | null = null;
	if (capture.focusId && byId.has(capture.focusId)) {
		let cursor = capture.focusId;
		const visited = new Set<string>();
		while (!visited.has(cursor)) {
			visited.add(cursor);
			const parentId = byId.get(cursor)?.parentId;
			if (!parentId || !byId.has(parentId)) break;
			cursor = parentId;
		}
		rootId = cursor;
	}
	if (!rootId) {
		let best = -1;
		for (const candidate of rootIds) {
			const size = countPosts(nodes.get(candidate)!);
			if (size > best) {
				best = size;
				rootId = candidate;
			}
		}
	}

	const rootPost = rootId ? nodes.get(rootId) : null;
	const rootTweet = rootId ? byId.get(rootId) : null;
	if (!rootPost || !rootTweet) return null;

	// Keep every captured tweet: attach orphan subtrees (whose real parent wasn't
	// captured) directly under the chosen root instead of dropping them.
	for (const orphanId of rootIds) {
		if (orphanId === rootId) continue;
		const orphan = nodes.get(orphanId);
		if (!orphan) continue;
		orphan.parentUri = rootPost.uri;
		rootPost.children.push(orphan);
	}
	rootPost.children.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));

	// Walk the chosen tree to collect quotes worth hydrating (post.cid === tweet id).
	const quoteRefs: XQuoteRef[] = [];
	const walk = (post: ThreadPost) => {
		const tweet = byId.get(post.cid);
		if (tweet?.quotedId) quoteRefs.push({ post, quotedId: tweet.quotedId });
		for (const child of post.children) walk(child);
	};
	walk(rootPost);

	const kept = countPosts(rootPost);
	return {
		thread: {
			rootPost,
			rootUri: rootPost.uri,
			depth: measureDepth(rootPost),
			isTruncated: capture.partial === true
		},
		url: buildXPostUrl(rootTweet.handle, rootTweet.id),
		rootHandle: rootTweet.handle,
		tweetCount: capture.tweets.length,
		droppedCount: capture.tweets.length - kept,
		quoteRefs
	};
}

/** Map an fxtwitter tweet payload into the viewer's quoted-record embed shape. */
export function fixupTweetToRecordEmbed(tweet: FixupXTweet, depth = 0): QuotedRecordEmbed {
	const images: EmbedImage[] = tweet.media
		.filter((item) => item.type === 'photo' && item.url)
		.map((item) => ({
			thumb: item.thumbnailUrl || item.url,
			fullsize: item.url,
			alt: item.alt ?? '',
			aspectRatio: item.width && item.height ? { width: item.width, height: item.height } : undefined
		}));
	const video = tweet.media.find((item) => item.type === 'video' || item.type === 'gif');

	const record: QuotedRecordEmbed = {
		uri: tweet.url,
		author: {
			handle: tweet.author.handle,
			displayName: tweet.author.displayName,
			avatar: tweet.author.avatar
		},
		text: tweet.text,
		createdAt: tweet.createdAt ?? new Date(0).toISOString(),
		images: images.length > 0 ? images : undefined,
		external:
			images.length === 0 && video
				? {
						uri: tweet.url,
						title: video.type === 'gif' ? 'GIF on X' : 'Video on X',
						description: video.alt ?? '',
						thumb: video.thumbnailUrl || video.url
					}
				: undefined,
		record: depth < 2 && tweet.quote ? fixupTweetToRecordEmbed(tweet.quote, depth + 1) : undefined
	};
	return record;
}

/**
 * Hydrate quoted tweets via the server's fxtwitter proxy (`/api/x/embed`) and
 * attach them as `embed.record` on the quoting posts. Dedupes by quoted id and
 * mutates the posts in place. Failures are skipped silently.
 */
export async function hydrateXQuotesWithFxtwitter(
	quoteRefs: XQuoteRef[],
	options: {
		fetchImpl?: typeof fetch;
		concurrency?: number;
	} = {}
): Promise<number> {
	if (quoteRefs.length === 0) return 0;
	const fetchImpl = options.fetchImpl ?? fetch;
	const concurrency = Math.max(1, options.concurrency ?? 4);

	const cache = new Map<string, QuotedRecordEmbed | null>();
	let hydrated = 0;

	async function resolve(quotedId: string): Promise<QuotedRecordEmbed | null> {
		if (cache.has(quotedId)) return cache.get(quotedId) ?? null;
		let record: QuotedRecordEmbed | null = null;
		try {
			const target = `https://x.com/i/status/${quotedId}`;
			const response = await fetchImpl(`/api/x/embed?url=${encodeURIComponent(target)}`);
			if (response.ok) {
				const payload = (await response.json()) as { tweet?: FixupXTweet | null };
				if (payload?.tweet) record = fixupTweetToRecordEmbed(payload.tweet);
			}
		} catch {
			record = null;
		}
		cache.set(quotedId, record);
		return record;
	}

	let cursor = 0;
	async function worker() {
		while (cursor < quoteRefs.length) {
			const ref = quoteRefs[cursor++];
			const record = await resolve(ref.quotedId);
			if (!record) continue;
			ref.post.embed = { ...(ref.post.embed ?? { type: 'record' }), record };
			if (!ref.post.embed.type) ref.post.embed.type = 'record';
			hydrated += 1;
		}
	}

	await Promise.all(Array.from({ length: Math.min(concurrency, quoteRefs.length) }, worker));
	return hydrated;
}
