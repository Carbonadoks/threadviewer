import type { RequestHandler } from '@sveltejs/kit';
import { normalizeBskyPostUrl } from '$lib/utils/viewerLinks';

const DEFAULT_PAIR_KEY = 'bisk2bisk.json';

type StoredBiskPair = {
	from?: unknown;
	to?: unknown;
};

function resolvePairKey(rawKey: string | null): string {
	const trimmed = rawKey?.trim() ?? '';
	if (!trimmed) {
		return DEFAULT_PAIR_KEY;
	}

	return trimmed.replace(/^\/+/, '');
}

function readNormalizedUrl(value: unknown): string | null {
	if (typeof value !== 'string') {
		return null;
	}

	return normalizeBskyPostUrl(value);
}

export const GET: RequestHandler = async ({ platform, url }) => {
	const bucket = platform?.env?.POST_CACHE;
	if (!bucket) {
		return new Response('Post cache bucket is unavailable.', {
			status: 503,
			headers: {
				'Content-Type': 'text/plain; charset=utf-8',
				'Cache-Control': 'no-store'
			}
		});
	}

	const key = resolvePairKey(url.searchParams.get('key'));
	const object = await bucket.get(key);
	if (!object) {
		return new Response(`Bisk2Bisk pair not found for key "${key}".`, {
			status: 404,
			headers: {
				'Content-Type': 'text/plain; charset=utf-8',
				'Cache-Control': 'no-store'
			}
		});
	}

	const payload = await object.json<StoredBiskPair>();
	const from = readNormalizedUrl(payload?.from);
	const to = readNormalizedUrl(payload?.to);

	if (!from || !to) {
		return new Response(`Bisk2Bisk pair "${key}" must contain valid "from" and "to" Bluesky post URLs.`, {
			status: 400,
			headers: {
				'Content-Type': 'text/plain; charset=utf-8',
				'Cache-Control': 'no-store'
			}
		});
	}

	return Response.json(
		{
			key,
			from,
			to
		},
		{
			headers: {
				'Cache-Control': 'no-store'
			}
		}
	);
};
