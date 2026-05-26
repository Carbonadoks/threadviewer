export type ViewerPage =
	| 'home'
	| 'threadviewer'
	| 'viewer2'
	| 'chat'
	| 'board'
	| 'blog'
	| 'treeviewer'
	| 'parallelboard'
	| 'band'
	| 'bisk2bisk'
	| 'judge'
	| 'dialogue'
	| 'dialogue2';

export interface ParsedBskyPostUrl {
	handle: string;
	rkey: string;
}

export interface BskyLinkFacet {
	features?: Array<{
		$type?: string;
		uri?: string;
	}>;
}

const BSKY_HOST = 'bsky.app';
const BSKY_POST_PATH = /^\/profile\/([^/]+)\/post\/([^/]+)$/;
const AT_URI_POST = /^at:\/\/([^/]+)\/app\.bsky\.feed\.post\/([^/]+)$/;
const URL_TOKEN = /https?:\/\/[^\s<>"']+/gi;

function cleanActor(actor: string | null | undefined): string {
	return (actor ?? '').replace(/^@/, '').trim();
}

export function parseBskyPostUrl(url: string): ParsedBskyPostUrl | null {
	const trimmed = url.trim();
	if (!trimmed) return null;

	try {
		const parsed = new URL(trimmed);
		if (parsed.hostname !== BSKY_HOST) return null;

		const match = parsed.pathname.match(BSKY_POST_PATH);
		if (!match) return null;

		const handle = cleanActor(decodeURIComponent(match[1]));
		const rkey = decodeURIComponent(match[2]).trim();
		if (!handle || !rkey) return null;

		return { handle, rkey };
	} catch {
		return null;
	}
}

export function normalizeBskyPostUrl(url: string): string | null {
	const parsed = parseBskyPostUrl(url);
	if (!parsed) return null;

	return `https://${BSKY_HOST}/profile/${encodeURIComponent(parsed.handle)}/post/${encodeURIComponent(parsed.rkey)}`;
}

export function extractBskyPostUrls(text: string): string[] {
	const matches = text.match(URL_TOKEN) ?? [];
	if (matches.length === 0) return [];

	const urls: string[] = [];
	const seen = new Set<string>();

	for (const raw of matches) {
		const cleaned = raw.replace(/[),.;!?]+$/g, '');
		const normalized = normalizeBskyPostUrl(cleaned);
		if (!normalized || seen.has(normalized)) continue;
		seen.add(normalized);
		urls.push(normalized);
	}

	return urls;
}

export function extractBskyPostUrlsFromFacets(facets: BskyLinkFacet[] | null | undefined): string[] {
	if (!Array.isArray(facets) || facets.length === 0) return [];

	const urls: string[] = [];
	const seen = new Set<string>();

	for (const facet of facets) {
		for (const feature of facet?.features ?? []) {
			if (feature?.$type !== 'app.bsky.richtext.facet#link') continue;
			const normalized = normalizeBskyPostUrl(feature.uri ?? '');
			if (!normalized || seen.has(normalized)) continue;
			seen.add(normalized);
			urls.push(normalized);
		}
	}

	return urls;
}

export function buildAtUri(did: string, rkey: string): string | null {
	const cleanDid = did.trim();
	const cleanRkey = rkey.trim();
	if (!cleanDid || !cleanRkey) return null;
	return `at://${cleanDid}/app.bsky.feed.post/${cleanRkey}`;
}

export function buildBskyPostUrl(rootUri: string, actor?: string | null): string | null {
	const match = rootUri.trim().match(AT_URI_POST);
	if (!match) return null;

	const profileActor = cleanActor(actor) || match[1];
	const rkey = match[2];
	if (!profileActor || !rkey) return null;

	return `https://${BSKY_HOST}/profile/${encodeURIComponent(profileActor)}/post/${encodeURIComponent(rkey)}`;
}

export function buildViewerHref(
	page: ViewerPage,
	options: {
		url?: string | null;
		handle?: string | null;
		handleA?: string | null;
		handleB?: string | null;
	} = {}
): string {
	const pathname = page === 'home' ? '/threadviewer' : `/${page}`;
	if (page === 'dialogue' || page === 'dialogue2') {
		const params = new URLSearchParams();
		const handleA = cleanActor(options.handleA);
		const handleB = cleanActor(options.handleB);
		const normalizedUrl = options.url ? normalizeBskyPostUrl(options.url) : null;

		if (handleA) params.set('handleA', handleA);
		if (handleB) params.set('handleB', handleB);
		if (normalizedUrl) params.set('url', normalizedUrl);

		const query = params.toString();
		return query ? `${pathname}?${query}` : pathname;
	}

	if (page === 'bisk2bisk') {
		return pathname;
	}

	if (page === 'viewer2') {
		const handle = cleanActor(options.handle) || (options.url ? parseBskyPostUrl(options.url)?.handle : '') || '';
		if (handle) {
			return `${pathname}?handle=${encodeURIComponent(handle)}`;
		}
		return pathname;
	}

	const normalizedUrl = options.url ? normalizeBskyPostUrl(options.url) : null;
	if (normalizedUrl) {
		return `${pathname}?url=${encodeURIComponent(normalizedUrl)}`;
	}

	if (page === 'home' || page === 'threadviewer') {
		const handle = cleanActor(options.handle);
		if (handle) {
			return `${pathname}?handle=${encodeURIComponent(handle)}`;
		}
	}

	return pathname;
}
