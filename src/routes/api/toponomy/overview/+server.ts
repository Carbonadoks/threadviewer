import type { RequestHandler } from '@sveltejs/kit';
import { OVERVIEW_KEY } from '$lib/server/toponomySnapshot';

export const GET: RequestHandler = async ({ platform }) => {
	const bucket = platform?.env?.POST_CACHE;
	if (!bucket) {
		return new Response('Toponomy overview bucket is unavailable.', {
			status: 503,
			headers: {
				'Content-Type': 'text/plain; charset=utf-8',
				'Cache-Control': 'no-store'
			}
		});
	}

	const object = await bucket.get(OVERVIEW_KEY);
	if (!object) {
		return new Response('Toponomy overview not found.', {
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
	headers.set('Cache-Control', 'no-store');
	if (object.httpEtag) {
		headers.set('ETag', object.httpEtag);
	}

	return new Response(object.body, {
		status: 200,
		headers
	});
};
