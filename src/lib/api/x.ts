import type { AuthorInfo, DiscoverProgress, SelfReplyThread, ThreadPost } from '$lib/types';

export type XArchiveThreadSortMode = 'depth' | 'length' | 'newest' | 'oldest' | 'liked' | 'reposted';

export type XArchivePost = Omit<ThreadPost, 'children' | 'linkedUrls'> & {
	id: string;
	parentId?: string;
	replyToUserId?: string;
	replyToScreenName?: string;
	sourceUrl: string;
	linkedUrls: string[];
	countableText: string;
	characterLength: number;
	isNoteTweet?: boolean;
	children: XArchivePost[];
};

export type XArchiveThread = Omit<SelfReplyThread, 'rootPost'> & {
	rootPost: XArchivePost;
	characterLength: number;
	postCount: number;
	latestCreatedAt: string;
};

export type XArchiveStats = {
	totalEntries: number;
	postsScanned: number;
	retweetsSkipped: number;
	notesSeen: number;
	notesMatched: number;
	notesUnmatched: number;
	chainStarts: number;
	threadsWithSelfReplies: number;
	maxDepth: number;
	totalCharacters: number;
};

export type XArchiveParseResult = {
	author: AuthorInfo;
	threads: XArchiveThread[];
	posts: XArchivePost[];
	stats: XArchiveStats;
	warnings: string[];
};

export type XArchiveParseCallbacks = {
	onProgress?: (progress: DiscoverProgress) => void;
};

export type ParsedXStatusUrl = {
	id: string;
	handle: string | null;
	canonicalUrl: string;
	fixupxUrl: string;
};

export type FixupXTweetMedia = {
	type: string;
	url: string;
	thumbnailUrl?: string;
	alt?: string;
	width?: number;
	height?: number;
	duration?: number;
};

export type FixupXTweet = {
	id: string;
	url: string;
	text: string;
	createdAt: string | null;
	author: {
		handle: string;
		displayName: string;
		avatar?: string;
	};
	stats: {
		likes: number;
		reposts: number;
		replies: number;
		quotes: number;
		views?: number;
	};
	media: FixupXTweetMedia[];
	quote?: FixupXTweet;
	raw: Record<string, unknown>;
};

export type FixupXEmbed = {
	inputUrl: string;
	resolvedUrl: string;
	canonicalUrl: string;
	fixupxUrl: string;
	statusId: string;
	handle: string | null;
	title: string;
	description: string;
	image: string | null;
	provider: string;
	tweet: FixupXTweet | null;
};

type XArchiveAccount = {
	accountId?: string;
	username?: string;
	accountDisplayName?: string;
	createdAt?: string;
};

type XArchiveProfile = {
	avatarMediaUrl?: string;
	headerMediaUrl?: string;
	description?: {
		bio?: string;
		website?: string;
		location?: string;
	};
};

type XArchiveTweetEntityUrl = {
	url?: string;
	expanded_url?: string;
	display_url?: string;
	indices?: [number, number] | string[];
};

type XArchiveTweetMedia = XArchiveTweetEntityUrl & {
	media_url?: string;
	media_url_https?: string;
	type?: string;
	ext_alt_text?: string;
	sizes?: Record<
		string,
		{
			w?: number | string;
			h?: number | string;
			resize?: string;
		}
	>;
	video_info?: {
		variants?: Array<{
			content_type?: string;
			url?: string;
			bitrate?: number;
		}>;
	};
};

type XArchiveTweet = {
	id?: string;
	id_str?: string;
	full_text?: string;
	text?: string;
	created_at?: string;
	favorite_count?: string | number;
	retweet_count?: string | number;
	reply_count?: string | number;
	quote_count?: string | number;
	retweeted?: boolean;
	in_reply_to_status_id?: string | number;
	in_reply_to_status_id_str?: string;
	in_reply_to_user_id?: string | number;
	in_reply_to_user_id_str?: string;
	in_reply_to_screen_name?: string;
	entities?: {
		urls?: XArchiveTweetEntityUrl[];
		media?: XArchiveTweetMedia[];
	};
	extended_entities?: {
		media?: XArchiveTweetMedia[];
	};
};

type XArchiveNoteTweet = {
	noteTweetId?: string;
	createdAt?: string;
	core?: {
		text?: string;
		urls?: XArchiveTweetEntityUrl[];
	};
};

const ARCHIVE_JS_ASSIGNMENT_RE = /^\s*(?:window\.)?YTD\.[^=]+=\s*(.*?);?\s*$/s;
const URL_RE = /https?:\/\/\S+|\b(?:pic\.)?(?:twitter|x)\.com\/\S+/giu;
const RETWEET_RE = /^RT @/;
const LEADING_MENTIONS_RE = /^(?:@\w+\s+)+/u;
const X_STATUS_HOSTS = new Set(['x.com', 'twitter.com', 'mobile.twitter.com', 'fixupx.com']);
const X_SHORT_LINK_HOSTS = new Set(['t.co']);
const X_STATUS_PATH_RE = /^\/([^/]+)\/status(?:es)?\/(\d+)(?:\/|$)/i;
const X_I_STATUS_PATH_RE = /^\/i\/(?:web\/)?status\/(\d+)(?:\/|$)/i;

function toStringValue(value: unknown): string {
	if (value === null || value === undefined) return '';
	return String(value);
}

function toNumber(value: unknown): number {
	const numeric = Number(value);
	return Number.isFinite(numeric) ? Math.max(0, Math.round(numeric)) : 0;
}

function cleanUrlToken(raw: string): string {
	return raw.trim().replace(/^["'<({\[]+/g, '').replace(/["')\]}>.,;!?]+$/g, '');
}

function parseUrlWithDefaultProtocol(raw: string): URL | null {
	const cleaned = cleanUrlToken(raw);
	if (!cleaned) return null;

	try {
		return new URL(cleaned);
	} catch {
		try {
			return new URL(`https://${cleaned}`);
		} catch {
			return null;
		}
	}
}

function normalizedHostname(url: URL): string {
	return url.hostname.toLowerCase().replace(/^www\./, '');
}

function encodePathSegment(value: string): string {
	return encodeURIComponent(value).replace(/%40/g, '@');
}

export function isXShortLinkUrl(url: string): boolean {
	const parsed = parseUrlWithDefaultProtocol(url);
	return Boolean(parsed && X_SHORT_LINK_HOSTS.has(normalizedHostname(parsed)));
}

export function parseXStatusUrl(url: string): ParsedXStatusUrl | null {
	const parsed = parseUrlWithDefaultProtocol(url);
	if (!parsed) return null;

	const host = normalizedHostname(parsed);
	if (!X_STATUS_HOSTS.has(host)) return null;

	const iStatusMatch = parsed.pathname.match(X_I_STATUS_PATH_RE);
	if (iStatusMatch) {
		const id = iStatusMatch[1];
		return {
			id,
			handle: null,
			canonicalUrl: `https://x.com/i/status/${id}`,
			fixupxUrl: `https://fixupx.com/i/status/${id}`
		};
	}

	const statusMatch = parsed.pathname.match(X_STATUS_PATH_RE);
	if (!statusMatch) return null;

	const handle = decodeURIComponent(statusMatch[1]).replace(/^@/, '').trim();
	const id = statusMatch[2];
	if (!handle || !id || handle.toLowerCase() === 'i') return null;

	const encodedHandle = encodePathSegment(handle);
	return {
		id,
		handle,
		canonicalUrl: `https://x.com/${encodedHandle}/status/${id}`,
		fixupxUrl: `https://fixupx.com/${encodedHandle}/status/${id}`
	};
}

export function normalizeXStatusUrl(url: string): string | null {
	return parseXStatusUrl(url)?.canonicalUrl ?? null;
}

export function buildFixupXStatusUrl(url: string): string | null {
	return parseXStatusUrl(url)?.fixupxUrl ?? null;
}

function extractUrlTokens(text: string): string[] {
	return (text.match(URL_RE) ?? []).map(cleanUrlToken).filter(Boolean);
}

export function extractXStatusCandidateUrls(text: string, linkedUrls: string[] = []): string[] {
	const seen = new Set<string>();
	const result: string[] = [];

	function add(raw: string) {
		const cleaned = cleanUrlToken(raw);
		if (!cleaned) return;
		if (!parseXStatusUrl(cleaned) && !isXShortLinkUrl(cleaned)) return;
		const key = parseXStatusUrl(cleaned)?.canonicalUrl ?? cleaned;
		if (seen.has(key)) return;
		seen.add(key);
		result.push(cleaned);
	}

	for (const url of linkedUrls) add(url);
	for (const url of extractUrlTokens(text)) add(url);

	return result;
}

export function extractXArchiveEmbedUrls(
	post: Pick<XArchivePost, 'id' | 'text' | 'linkedUrls' | 'sourceUrl'>
): string[] {
	return extractXStatusCandidateUrls(post.text, post.linkedUrls).filter((url) => {
		const parsed = parseXStatusUrl(url);
		if (!parsed) return true;
		if (parsed.id === post.id) return false;
		return parsed.canonicalUrl !== normalizeXStatusUrl(post.sourceUrl);
	});
}

function parseArchivePayload(contents: string): unknown {
	const trimmed = contents.replace(/^\uFEFF/, '').trim();
	try {
		return JSON.parse(trimmed);
	} catch (jsonError) {
		const match = trimmed.match(ARCHIVE_JS_ASSIGNMENT_RE);
		if (!match) throw jsonError;
		return JSON.parse(match[1]);
	}
}

function arrayFromUnknown(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

function unwrapTweet(value: unknown): XArchiveTweet | null {
	if (!value || typeof value !== 'object') return null;
	const maybeWrapped = value as { tweet?: XArchiveTweet };
	const tweet = maybeWrapped.tweet ?? (value as XArchiveTweet);
	if (!tweet || typeof tweet !== 'object') return null;
	if (!tweet.id && !tweet.id_str) return null;
	return tweet;
}

function unwrapNoteTweet(value: unknown): XArchiveNoteTweet | null {
	if (!value || typeof value !== 'object') return null;
	const maybeWrapped = value as { noteTweet?: XArchiveNoteTweet };
	const note = maybeWrapped.noteTweet ?? (value as XArchiveNoteTweet);
	if (!note || typeof note !== 'object') return null;
	if (!note.noteTweetId && !note.core?.text) return null;
	return note;
}

function readAccount(data: any): XArchiveAccount {
	const account = arrayFromUnknown(data?.account)[0] as { account?: XArchiveAccount } | undefined;
	return account?.account ?? {};
}

function readProfile(data: any): XArchiveProfile {
	const profile = arrayFromUnknown(data?.profile)[0] as { profile?: XArchiveProfile } | undefined;
	return profile?.profile ?? {};
}

function readTweets(data: unknown): XArchiveTweet[] {
	if (Array.isArray(data)) return data.map(unwrapTweet).filter((tweet): tweet is XArchiveTweet => Boolean(tweet));
	const archive = data as Record<string, unknown>;
	return [
		...arrayFromUnknown(archive?.tweets),
		...arrayFromUnknown(archive?.['community-tweet'])
	]
		.map(unwrapTweet)
		.filter((tweet): tweet is XArchiveTweet => Boolean(tweet));
}

function readNoteTweets(data: unknown): XArchiveNoteTweet[] {
	if (Array.isArray(data)) return [];
	const archive = data as Record<string, unknown>;
	return arrayFromUnknown(archive?.['note-tweet'])
		.map(unwrapNoteTweet)
		.filter((note): note is XArchiveNoteTweet => Boolean(note));
}

function parseCreatedAt(value: unknown): string {
	const raw = toStringValue(value);
	const timestamp = Date.parse(raw);
	if (!Number.isFinite(timestamp)) return new Date(0).toISOString();
	return new Date(timestamp).toISOString();
}

function epochSecond(value: unknown): number | null {
	const raw = toStringValue(value);
	const timestamp = Date.parse(raw);
	if (!Number.isFinite(timestamp)) return null;
	return Math.floor(timestamp / 1000);
}

function normalizeComparableText(value: string): string {
	return value
		.replace(URL_RE, ' ')
		.replace(LEADING_MENTIONS_RE, '')
		.replace(/\u2026/g, '')
		.replace(/\s+/g, ' ')
		.trim()
		.toLowerCase();
}

function noteMatchesTweet(note: XArchiveNoteTweet, tweet: XArchiveTweet): boolean {
	const noteText = normalizeComparableText(note.core?.text ?? '');
	const tweetText = normalizeComparableText(tweet.full_text ?? tweet.text ?? '');
	if (!noteText || !tweetText) return false;
	const sampleLength = Math.min(80, noteText.length, tweetText.length);
	if (sampleLength < 24) return true;
	const noteSample = noteText.slice(0, sampleLength);
	const tweetSample = tweetText.slice(0, sampleLength);
	return noteText.startsWith(tweetSample) || tweetText.startsWith(noteSample);
}

function buildNotesBySecond(notes: XArchiveNoteTweet[]): Map<number, XArchiveNoteTweet[]> {
	const notesBySecond = new Map<number, XArchiveNoteTweet[]>();
	for (const note of notes) {
		const second = epochSecond(note.createdAt);
		if (second === null) continue;
		const bucket = notesBySecond.get(second) ?? [];
		bucket.push(note);
		notesBySecond.set(second, bucket);
	}
	return notesBySecond;
}

function findMatchingNote(
	tweet: XArchiveTweet,
	notesBySecond: Map<number, XArchiveNoteTweet[]>,
	usedNoteIds: Set<string>
): XArchiveNoteTweet | null {
	const second = epochSecond(tweet.created_at);
	if (second === null) return null;
	const candidates = notesBySecond.get(second) ?? [];
	const unused = candidates.filter((note) => !usedNoteIds.has(note.noteTweetId ?? ''));
	if (unused.length === 0) return null;
	const matched = unused.find((note) => noteMatchesTweet(note, tweet)) ?? unused[0];
	if (matched.noteTweetId) usedNoteIds.add(matched.noteTweetId);
	return matched;
}

function tweetText(tweet: XArchiveTweet, note: XArchiveNoteTweet | null): string {
	const fallback = toStringValue(tweet.full_text ?? tweet.text);
	const noteText = toStringValue(note?.core?.text);
	if (!noteText) return fallback;

	const prefix = fallback.match(LEADING_MENTIONS_RE)?.[0] ?? '';
	if (!prefix || noteText.startsWith(prefix.trim())) return noteText;
	return `${prefix}${noteText}`;
}

function cleanTextForLength(text: string, urls: XArchiveTweetEntityUrl[]): string {
	let cleaned = text;
	for (const url of urls) {
		const shortUrl = toStringValue(url.url);
		const expandedUrl = toStringValue(url.expanded_url);
		const displayUrl = toStringValue(url.display_url);
		for (const candidate of [shortUrl, expandedUrl, displayUrl]) {
			if (!candidate) continue;
			cleaned = cleaned.split(candidate).join(' ');
		}
	}
	return cleaned.replace(URL_RE, ' ').replace(/\s+/g, ' ').trim();
}

function countCharacters(text: string): number {
	return Array.from(text).length;
}

function tweetId(tweet: XArchiveTweet): string {
	return toStringValue(tweet.id_str || tweet.id);
}

function tweetUri(id: string): string {
	return `x://status/${id}`;
}

function buildXPostUrl(handle: string, id: string): string {
	return handle ? `https://x.com/${encodeURIComponent(handle)}/status/${id}` : `https://x.com/i/status/${id}`;
}

function readEntityUrls(tweet: XArchiveTweet, note: XArchiveNoteTweet | null): XArchiveTweetEntityUrl[] {
	return [
		...(tweet.entities?.urls ?? []),
		...(tweet.entities?.media ?? []),
		...(note?.core?.urls ?? [])
	];
}

function expandedUrls(urls: XArchiveTweetEntityUrl[]): string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const url of urls) {
		const value = toStringValue(url.expanded_url || url.url);
		if (!value || seen.has(value)) continue;
		seen.add(value);
		result.push(value);
	}
	return result;
}

function mediaAspectRatio(media: XArchiveTweetMedia): { width: number; height: number } | undefined {
	const sizes = media.sizes ?? {};
	const size = sizes.large ?? sizes.medium ?? sizes.small ?? sizes.thumb;
	const width = Number(size?.w);
	const height = Number(size?.h);
	if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return undefined;
	return { width, height };
}

function buildTweetEmbed(tweet: XArchiveTweet): ThreadPost['embed'] | undefined {
	const media = tweet.extended_entities?.media ?? tweet.entities?.media ?? [];
	const images = media
		.filter((item) => item.type === 'photo' && (item.media_url_https || item.media_url))
		.map((item) => {
			const url = toStringValue(item.media_url_https || item.media_url);
			return {
				thumb: url,
				fullsize: url,
				alt: toStringValue(item.ext_alt_text),
				aspectRatio: mediaAspectRatio(item)
			};
		});

	if (images.length > 0) {
		return { type: 'images', images };
	}

	return undefined;
}

function isRetweet(tweet: XArchiveTweet): boolean {
	return RETWEET_RE.test(toStringValue(tweet.full_text ?? tweet.text));
}

function toXArchivePost(
	tweet: XArchiveTweet,
	note: XArchiveNoteTweet | null,
	author: AuthorInfo
): XArchivePost {
	const id = tweetId(tweet);
	const text = tweetText(tweet, note);
	const urls = readEntityUrls(tweet, note);
	const countableText = cleanTextForLength(text, urls);
	const parentId = toStringValue(tweet.in_reply_to_status_id_str || tweet.in_reply_to_status_id) || undefined;
	const replyToUserId = toStringValue(tweet.in_reply_to_user_id_str || tweet.in_reply_to_user_id) || undefined;

	return {
		id,
		uri: tweetUri(id),
		cid: `x:${id}`,
		author,
		text,
		createdAt: parseCreatedAt(tweet.created_at),
		linkedUrls: expandedUrls(urls),
		likeCount: toNumber(tweet.favorite_count),
		repostCount: toNumber(tweet.retweet_count),
		replyCount: toNumber(tweet.reply_count),
		quoteCount: toNumber(tweet.quote_count),
		embed: buildTweetEmbed(tweet),
		parentId,
		parentUri: parentId ? tweetUri(parentId) : undefined,
		replyToUserId,
		replyToScreenName: toStringValue(tweet.in_reply_to_screen_name) || undefined,
		sourceUrl: buildXPostUrl(author.handle, id),
		countableText,
		characterLength: countCharacters(countableText),
		isNoteTweet: Boolean(note),
		children: []
	};
}

function postTime(post: Pick<XArchivePost, 'createdAt' | 'uri'>): number {
	const value = Date.parse(post.createdAt);
	return Number.isFinite(value) ? value : 0;
}

function comparePostsByCreatedAt(a: XArchivePost, b: XArchivePost): number {
	return postTime(a) - postTime(b) || a.uri.localeCompare(b.uri);
}

function measureDepth(post: XArchivePost, seen = new Set<string>()): number {
	if (seen.has(post.uri)) return 0;
	seen.add(post.uri);
	if (post.children.length === 0) return 1;
	return 1 + Math.max(...post.children.map((child) => measureDepth(child, new Set(seen))));
}

function summarizeThread(post: XArchivePost): {
	postCount: number;
	characterLength: number;
	latestCreatedAt: string;
} {
	const seen = new Set<string>();
	let postCount = 0;
	let characterLength = 0;
	let latest = post.createdAt;

	function walk(node: XArchivePost) {
		if (seen.has(node.uri)) return;
		seen.add(node.uri);
		postCount += 1;
		characterLength += node.characterLength;
		if (postTime(node) > Date.parse(latest)) latest = node.createdAt;
		for (const child of node.children) {
			walk(child);
		}
	}

	walk(post);
	return { postCount, characterLength, latestCreatedAt: latest };
}

function buildThreads(posts: XArchivePost[], accountId: string): XArchiveThread[] {
	const postsById = new Map(posts.map((post) => [post.id, post]));
	const childIds = new Set<string>();

	for (const post of posts) {
		if (!post.parentId || post.replyToUserId !== accountId) continue;
		const parent = postsById.get(post.parentId);
		if (!parent || parent.uri === post.uri) continue;
		parent.children.push(post);
		childIds.add(post.id);
	}

	for (const post of posts) {
		post.children.sort(comparePostsByCreatedAt);
	}

	const threads: XArchiveThread[] = [];
	for (const post of posts) {
		if (childIds.has(post.id)) continue;
		const summary = summarizeThread(post);
		const depth = measureDepth(post);
		threads.push({
			rootPost: post,
			rootUri: post.uri,
			depth,
			...summary
		});
	}

	return threads;
}

export function collectXThreadPosts(root: XArchivePost): XArchivePost[] {
	const posts: XArchivePost[] = [];
	const seen = new Set<string>();

	function walk(post: XArchivePost) {
		if (seen.has(post.uri)) return;
		seen.add(post.uri);
		posts.push(post);
		for (const child of post.children) {
			walk(child);
		}
	}

	walk(root);
	return posts.sort(comparePostsByCreatedAt);
}

export function xArchivePostHasImages(post: XArchivePost): boolean {
	return (post.embed?.images?.length ?? 0) > 0;
}

export function xArchiveThreadHasImages(thread: XArchiveThread): boolean {
	const seen = new Set<string>();

	function walk(post: XArchivePost): boolean {
		if (seen.has(post.uri)) return false;
		seen.add(post.uri);
		if (xArchivePostHasImages(post)) return true;
		return post.children.some(walk);
	}

	return walk(thread.rootPost);
}

export function compareXArchiveThreads(mode: XArchiveThreadSortMode) {
	return (a: XArchiveThread, b: XArchiveThread): number => {
		if (mode === 'length') {
			return b.characterLength - a.characterLength || b.depth - a.depth || postTime(b.rootPost) - postTime(a.rootPost);
		}
		if (mode === 'newest') {
			return postTime(b.rootPost) - postTime(a.rootPost) || b.depth - a.depth;
		}
		if (mode === 'oldest') {
			return postTime(a.rootPost) - postTime(b.rootPost) || b.depth - a.depth;
		}
		if (mode === 'liked') {
			return (b.rootPost.likeCount ?? 0) - (a.rootPost.likeCount ?? 0) || b.characterLength - a.characterLength;
		}
		if (mode === 'reposted') {
			return (b.rootPost.repostCount ?? 0) - (a.rootPost.repostCount ?? 0) || b.characterLength - a.characterLength;
		}
		return b.depth - a.depth || b.characterLength - a.characterLength || postTime(b.rootPost) - postTime(a.rootPost);
	};
}

export function parseXArchiveText(
	contents: string,
	callbacks: XArchiveParseCallbacks = {}
): XArchiveParseResult {
	const data = parseArchivePayload(contents);
	const account = readAccount(data);
	const profile = readProfile(data);
	const accountId = toStringValue(account.accountId);
	const handle = toStringValue(account.username) || 'twitter-user';
	const author: AuthorInfo = {
		did: accountId ? `x:${accountId}` : `x:${handle}`,
		handle,
		displayName: toStringValue(account.accountDisplayName) || handle,
		avatar: toStringValue(profile.avatarMediaUrl) || undefined
	};
	const rawTweets = readTweets(data);
	const notes = readNoteTweets(data);
	const notesBySecond = buildNotesBySecond(notes);
	const usedNoteIds = new Set<string>();
	const posts: XArchivePost[] = [];
	let retweetsSkipped = 0;

	callbacks.onProgress?.({ phase: 'Reading archive tweets...', current: 0, total: rawTweets.length });

	for (let index = 0; index < rawTweets.length; index += 1) {
		const tweet = rawTweets[index];
		if (isRetweet(tweet)) {
			retweetsSkipped += 1;
			continue;
		}
		const note = findMatchingNote(tweet, notesBySecond, usedNoteIds);
		posts.push(toXArchivePost(tweet, note, author));
		if (index > 0 && index % 5000 === 0) {
			callbacks.onProgress?.({
				phase: 'Normalizing tweets...',
				current: index,
				total: rawTweets.length
			});
		}
	}

	callbacks.onProgress?.({ phase: 'Linking self-reply chains...', current: 0, total: posts.length });

	const threads = buildThreads(posts, accountId);
	const maxDepth = threads.length > 0 ? Math.max(...threads.map((thread) => thread.depth)) : 0;
	const totalCharacters = threads.reduce((sum, thread) => sum + thread.characterLength, 0);
	const warnings: string[] = [];
	if (!accountId) {
		warnings.push('No account id was found in the archive; self-reply linking may be incomplete.');
	}
	if (notes.length > usedNoteIds.size) {
		warnings.push(`${notes.length - usedNoteIds.size} note-tweet records did not match an archived tweet.`);
	}

	return {
		author,
		posts,
		threads,
		stats: {
			totalEntries: rawTweets.length,
			postsScanned: posts.length,
			retweetsSkipped,
			notesSeen: notes.length,
			notesMatched: usedNoteIds.size,
			notesUnmatched: Math.max(0, notes.length - usedNoteIds.size),
			chainStarts: threads.length,
			threadsWithSelfReplies: threads.filter((thread) => thread.depth > 1).length,
			maxDepth,
			totalCharacters
		},
		warnings
	};
}

export function isXPostInDateRange(post: XArchivePost, from: string, toDate: string): boolean {
	if (!from && !toDate) return true;
	const postDate = new Date(post.createdAt);
	if (Number.isNaN(postDate.getTime())) return true;
	if (from && postDate < new Date(from)) return false;
	if (toDate) {
		const to = new Date(toDate);
		to.setHours(23, 59, 59, 999);
		if (postDate > to) return false;
	}
	return true;
}
