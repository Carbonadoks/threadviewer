import type { RequestHandler } from './$types';

// cdn.bsky.app serves images without any access-control-allow-origin header, so a
// browser fetch() for pixel data (as opposed to an <img> tag) is blocked. The
// classifier needs the bytes to build an ImageBitmap, so we re-serve them from our
// own origin. Strictly limited to Bluesky image paths — this must never become an
// open proxy.
const ALLOWED_HOST = 'cdn.bsky.app';
const CACHE_SECONDS = 604800;

export const GET: RequestHandler = async ({ url, fetch }) => {
	const target = url.searchParams.get('url');
	if (!target) {
		return new Response('missing url', { status: 400 });
	}

	let parsed: URL;
	try {
		parsed = new URL(target);
	} catch {
		return new Response('invalid url', { status: 400 });
	}

	if (
		parsed.protocol !== 'https:' ||
		parsed.hostname !== ALLOWED_HOST ||
		!parsed.pathname.startsWith('/img/')
	) {
		return new Response('forbidden target', { status: 403 });
	}

	const upstream = await fetch(parsed.toString(), {
		headers: { accept: 'image/*' },
		// Let Cloudflare's cache absorb repeats; the firehose replays popular images.
		cf: { cacheEverything: true, cacheTtl: CACHE_SECONDS }
	} as RequestInit);

	if (!upstream.ok || !upstream.body) {
		return new Response('upstream error', { status: 502 });
	}

	return new Response(upstream.body, {
		status: 200,
		headers: {
			'content-type': upstream.headers.get('content-type') ?? 'application/octet-stream',
			'cache-control': `public, max-age=${CACHE_SECONDS}, immutable`
		}
	});
};
