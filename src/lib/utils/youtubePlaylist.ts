import type { ThreadPost } from '$lib/types';

const YOUTUBE_ID = '[A-Za-z0-9_-]{11}';

// Ordered patterns covering the common YouTube URL shapes.
const YOUTUBE_PATTERNS: RegExp[] = [
	new RegExp(`(?:youtube\\.com|youtube-nocookie\\.com)/watch\\?(?:[^\\s]*&)?v=(${YOUTUBE_ID})`, 'i'),
	new RegExp(`youtu\\.be/(${YOUTUBE_ID})`, 'i'),
	new RegExp(`(?:youtube\\.com|youtube-nocookie\\.com)/(?:embed|shorts|live|v)/(${YOUTUBE_ID})`, 'i')
];

/** Extract a single YouTube video id from a URL or arbitrary text, or null. */
export function extractYouTubeId(value: string | null | undefined): string | null {
	if (!value) return null;
	for (const pattern of YOUTUBE_PATTERNS) {
		const match = value.match(pattern);
		if (match?.[1]) return match[1];
	}
	return null;
}

function collectFromPost(post: ThreadPost, ids: string[], seen: Set<string>): void {
	const candidates: (string | undefined)[] = [
		post.text,
		post.embed?.external?.uri,
		...(post.linkedUrls ?? [])
	];

	for (const candidate of candidates) {
		if (!candidate) continue;
		const id = extractYouTubeId(candidate);
		if (id && !seen.has(id)) {
			seen.add(id);
			ids.push(id);
		}
	}
}

/**
 * Walk a thread (or list of posts) and collect unique YouTube video ids in
 * reading order.
 */
export function collectYouTubeIds(posts: ThreadPost[]): string[] {
	const ids: string[] = [];
	const seen = new Set<string>();

	function walk(post: ThreadPost): void {
		collectFromPost(post, ids, seen);
		for (const child of post.children) walk(child);
	}

	for (const post of posts) walk(post);
	return ids;
}

/** YouTube's anonymous watch_videos endpoint accepts at most 50 ids. */
export const YOUTUBE_PLAYLIST_LIMIT = 50;

/** Build the anonymous YouTube "watch videos" playlist URL for the given ids. */
export function buildYouTubePlaylistUrl(ids: string[]): string | null {
	if (ids.length === 0) return null;
	return `https://www.youtube.com/watch_videos?video_ids=${ids.join(',')}`;
}

export interface YouTubePlaylist {
	ids: string[];
	url: string;
}

/**
 * Split ids into chunks of at most 50 (YouTube's limit) and build a playlist
 * URL for each chunk.
 */
export function buildYouTubePlaylists(
	ids: string[],
	chunkSize = YOUTUBE_PLAYLIST_LIMIT
): YouTubePlaylist[] {
	const playlists: YouTubePlaylist[] = [];
	for (let i = 0; i < ids.length; i += chunkSize) {
		const chunk = ids.slice(i, i + chunkSize);
		const url = buildYouTubePlaylistUrl(chunk);
		if (url) playlists.push({ ids: chunk, url });
	}
	return playlists;
}
