import type { RequestHandler } from '@sveltejs/kit';
import { POINTS_KEY } from '$lib/server/clusterSnapshot';

const POINTS_CACHE_CONTROL = 'public, max-age=300, s-maxage=86400, stale-while-revalidate=86400';

export const GET: RequestHandler = async ({ platform }) => {
	const bucket = platform?.env?.POST_CACHE;
	if (!bucket) {
		return new Response('Cluster points bucket is unavailable.', {
			status: 503,
			headers: {
				'Content-Type': 'text/plain; charset=utf-8',
				'Cache-Control': 'no-store'
			}
		});
	}

	const object = await bucket.get(POINTS_KEY);
	if (!object) {
		return new Response('Cluster points not found.', {
			status: 404,
			headers: {
				'Content-Type': 'text/plain; charset=utf-8',
				'Cache-Control': 'no-store'
			}
		});
	}

	const headers = new Headers();
	object.writeHttpMetadata(headers);
	headers.set('Content-Type', headers.get('Content-Type') ?? 'application/json; charset=utf-8');
	headers.set('Cache-Control', POINTS_CACHE_CONTROL);
	if (object.httpEtag) {
		headers.set('ETag', object.httpEtag);
	}

	return new Response(object.body, {
		status: 200,
		headers
	});
};
