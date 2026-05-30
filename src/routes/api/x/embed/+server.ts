import type { RequestHandler } from './$types';
import {
	isXShortLinkUrl,
	parseXStatusUrl,
	type FixupXEmbed,
	type FixupXTweet,
	type FixupXTweetMedia
} from '$lib/api/x';

const MAX_URL_LENGTH = 2048;
const MAX_REDIRECTS = 6;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function jsonResponse(data: unknown, status = 200): Response {
	return Response.json(data, {
		status,
		headers: {
			'Cache-Control': status === 200 ? 'public, max-age=86400' : 'no-store'
		}
	});
}

function parseHttpUrl(value: string): URL | null {
	if (!value || value.length > MAX_URL_LENGTH) return null;
	try {
		const parsed = new URL(value);
		if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
		return parsed;
	} catch {
		try {
			const parsed = new URL(`https://${value}`);
			return parsed.protocol === 'https:' ? parsed : null;
		} catch {
			return null;
		}
	}
}

function decodeHtmlEntities(value: string): string {
	const decodeCodePoint = (raw: string, radix: number) => {
		const codePoint = parseInt(raw, radix);
		if (!Number.isFinite(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return '';
		return String.fromCodePoint(codePoint);
	};

	return value
		.replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => decodeCodePoint(hex, 16))
		.replace(/&#(\d+);/g, (_, decimal: string) => decodeCodePoint(decimal, 10))
		.replace(/&quot;/g, '"')
		.replace(/&#39;|&apos;/g, "'")
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&amp;/g, '&');
}

function cleanMetaText(value: string | undefined): string {
	return decodeHtmlEntities(value ?? '')
		.replace(/<br\s*\/?>/gi, '\n')
		.replace(/<[^>]+>/g, '')
		.replace(/[ \t]+\n/g, '\n')
		.replace(/\n[ \t]+/g, '\n')
		.replace(/[ \t]{2,}/g, ' ')
		.trim();
}

function readMetaAttributes(tag: string): Record<string, string> {
	const attrs: Record<string, string> = {};
	const attrRe = /([a-zA-Z_:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
	let match: RegExpExecArray | null;

	while ((match = attrRe.exec(tag)) !== null) {
		attrs[match[1].toLowerCase()] = match[2] ?? match[3] ?? match[4] ?? '';
	}

	return attrs;
}

function extractMeta(html: string): Map<string, string> {
	const meta = new Map<string, string>();
	const metaRe = /<meta\b[^>]*>/gi;
	let match: RegExpExecArray | null;

	while ((match = metaRe.exec(html)) !== null) {
		const attrs = readMetaAttributes(match[0]);
		const key = attrs.property || attrs.name;
		if (!key || !attrs.content) continue;
		meta.set(key.toLowerCase(), attrs.content);
	}

	return meta;
}

function validImageUrl(value: string | undefined): string | null {
	if (!value || value === '0') return null;
	const parsed = parseHttpUrl(decodeHtmlEntities(value));
	return parsed ? parsed.toString() : null;
}

function stringValue(value: unknown): string {
	return typeof value === 'string' ? value : '';
}

function numberValue(value: unknown): number {
	const numeric = Number(value);
	return Number.isFinite(numeric) ? numeric : 0;
}

function isoDateFromUnknown(value: unknown): string | null {
	const raw = stringValue(value);
	if (!raw) return null;
	const timestamp = Date.parse(raw);
	return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function normalizeTweetMedia(media: unknown): FixupXTweetMedia[] {
	const source = media as { all?: unknown[]; photos?: unknown[]; videos?: unknown[] } | null;
	if (!source) return [];
	const rawItems =
		Array.isArray(source.all) && source.all.length > 0
			? source.all
			: [...(Array.isArray(source.photos) ? source.photos : []), ...(Array.isArray(source.videos) ? source.videos : [])];

	return rawItems
		.map((item): FixupXTweetMedia | null => {
			if (!item || typeof item !== 'object') return null;
			const raw = item as Record<string, unknown>;
			const url = stringValue(raw.url);
			if (!url) return null;
			const normalized: FixupXTweetMedia = {
				type: stringValue(raw.type) || 'media',
				url,
				thumbnailUrl: stringValue(raw.thumbnail_url) || undefined,
				alt: stringValue(raw.altText) || undefined
			};
			const width = numberValue(raw.width);
			const height = numberValue(raw.height);
			const duration = numberValue(raw.duration);
			if (width > 0) normalized.width = width;
			if (height > 0) normalized.height = height;
			if (duration > 0) normalized.duration = duration;
			return normalized;
		})
		.filter((item): item is FixupXTweetMedia => Boolean(item));
}

function normalizeTweet(value: unknown, depth = 0): FixupXTweet | null {
	if (!value || typeof value !== 'object') return null;
	const raw = value as Record<string, unknown>;
	const author = raw.author as Record<string, unknown> | undefined;
	const id = stringValue(raw.id);
	const url = stringValue(raw.url);
	const handle = stringValue(author?.screen_name);
	if (!id || !url || !handle) return null;

	const timestamp = numberValue(raw.created_timestamp);
	const quote = depth < 2 ? normalizeTweet(raw.quote, depth + 1) ?? undefined : undefined;
	return {
		id,
		url,
		text: stringValue(raw.text),
		createdAt: timestamp > 0 ? new Date(timestamp * 1000).toISOString() : isoDateFromUnknown(raw.created_at),
		author: {
			handle,
			displayName: stringValue(author?.name) || handle,
			avatar: stringValue(author?.avatar_url) || undefined
		},
		stats: {
			likes: Math.max(0, Math.round(numberValue(raw.likes))),
			reposts: Math.max(0, Math.round(numberValue(raw.reposts ?? raw.retweets))),
			replies: Math.max(0, Math.round(numberValue(raw.replies))),
			quotes: Math.max(0, Math.round(numberValue(raw.quotes))),
			views: Math.max(0, Math.round(numberValue(raw.views))) || undefined
		},
		media: normalizeTweetMedia(raw.media),
		quote,
		raw
	};
}

async function fetchTweetFromApi(fetcher: typeof fetch, apiUrl: string): Promise<FixupXTweet | null> {
	const response = await fetcher(apiUrl, {
		headers: {
			accept: 'application/json',
			'user-agent': 'ThreadViewer/1.0 (+https://github.com/)'
		}
	});

	if (!response.ok) return null;

	const payload = (await response.json().catch(() => null)) as
		| { code?: unknown; status?: unknown; tweet?: unknown }
		| null;
	if (!payload || numberValue(payload.code) >= 400) return null;
	return normalizeTweet(payload.status ?? payload.tweet);
}

async function resolveShortLink(fetcher: typeof fetch, initialUrl: URL): Promise<string> {
	let current = initialUrl;

	for (let attempt = 0; attempt < MAX_REDIRECTS; attempt += 1) {
		if (!isXShortLinkUrl(current.toString())) return current.toString();

		const response = await fetcher(current.toString(), {
			redirect: 'manual',
			headers: {
				accept: 'text/html,application/xhtml+xml',
				'user-agent': 'ThreadViewer/1.0 (+https://github.com/)'
			}
		});

		const location = response.headers.get('location');
		if (!location || !REDIRECT_STATUSES.has(response.status)) {
			return response.url || current.toString();
		}

		const next = parseHttpUrl(new URL(location, current).toString());
		if (!next) return current.toString();
		current = next;
	}

	return current.toString();
}

async function readFixupXMetadata(fetcher: typeof fetch, fixupxUrl: string) {
	const response = await fetcher(fixupxUrl, {
		redirect: 'manual',
		headers: {
			accept: 'text/html,application/xhtml+xml',
			'user-agent': 'ThreadViewer/1.0 (+https://github.com/)'
		}
	});

	if (!response.ok) {
		return {
			title: '',
			description: '',
			image: null
		};
	}

	const meta = extractMeta(await response.text());
	return {
		title: cleanMetaText(meta.get('og:title') || meta.get('twitter:title')),
		description: cleanMetaText(meta.get('og:description') || meta.get('twitter:description')),
		image: validImageUrl(meta.get('og:image') || meta.get('twitter:image'))
	};
}

async function readFixupXTweet(fetcher: typeof fetch, statusId: string): Promise<FixupXTweet | null> {
	const encodedId = encodeURIComponent(statusId);
	return (
		(await fetchTweetFromApi(fetcher, `https://api.fxtwitter.com/2/status/${encodedId}?about_account=1`)) ??
		(await fetchTweetFromApi(fetcher, `https://api.fxtwitter.com/status/${encodedId}`))
	);
}

export const GET: RequestHandler = async ({ fetch, url }) => {
	const inputUrl = url.searchParams.get('url')?.trim() ?? '';
	const parsedInput = parseHttpUrl(inputUrl);

	if (!parsedInput) {
		return jsonResponse({ message: 'A valid http(s) URL is required.' }, 400);
	}

	const directStatus = parseXStatusUrl(parsedInput.toString());
	if (!directStatus && !isXShortLinkUrl(parsedInput.toString())) {
		return jsonResponse({ message: 'Only X/Twitter status URLs and t.co links can be embedded.' }, 400);
	}

	const resolvedUrl = directStatus ? parsedInput.toString() : await resolveShortLink(fetch, parsedInput);
	const status = parseXStatusUrl(resolvedUrl);
	if (!status) {
		return jsonResponse(
			{
				message: 'Resolved link is not an X/Twitter status URL.',
				inputUrl,
				resolvedUrl
			},
			404
		);
	}

	const [metadata, tweet] = await Promise.all([
		readFixupXMetadata(fetch, status.fixupxUrl),
		readFixupXTweet(fetch, status.id)
	]);
	const title =
		tweet?.author.displayName && tweet.author.handle
			? `${tweet.author.displayName} (@${tweet.author.handle})`
			: metadata.title || (status.handle ? `@${status.handle}` : 'X post');

	const payload: FixupXEmbed = {
		inputUrl,
		resolvedUrl,
		canonicalUrl: status.canonicalUrl,
		fixupxUrl: status.fixupxUrl,
		statusId: status.id,
		handle: status.handle,
		title,
		description: tweet?.text || metadata.description,
		image: tweet?.media.find((item) => item.type === 'photo')?.url ?? metadata.image,
		provider: 'FixupX',
		tweet
	};

	return jsonResponse(payload);
};
