import type { RequestHandler } from '@sveltejs/kit';
import { isAllowedSemanticDbKey } from '$lib/server/semanticBucket';

function filenameFromKey(key: string): string {
	const segments = key.split('/').filter(Boolean);
	return segments[segments.length - 1] || 'semantic.sqlite';
}

export const GET: RequestHandler = async ({ platform, url }) => {
	const bucket = platform?.env?.POST_CACHE;
	if (!bucket) {
		return new Response('Semantic DB bucket is unavailable.', {
			status: 503,
			headers: {
				'Content-Type': 'text/plain; charset=utf-8',
				'Cache-Control': 'no-store'
			}
		});
	}

	const key = url.searchParams.get('key')?.trim() || '';
	if (!isAllowedSemanticDbKey(key)) {
		return new Response('Invalid semantic DB key.', {
			status: 400,
			headers: {
				'Content-Type': 'text/plain; charset=utf-8',
				'Cache-Control': 'no-store'
			}
		});
	}

	const object = await bucket.get(key);
	if (!object) {
		return new Response('Semantic DB file not found.', {
			status: 404,
			headers: {
				'Content-Type': 'text/plain; charset=utf-8',
				'Cache-Control': 'no-store'
			}
		});
	}

	const headers = new Headers();
	object.writeHttpMetadata(headers);
	headers.set(
		'Content-Type',
		headers.get('Content-Type') ?? 'application/vnd.sqlite3'
	);
	headers.set(
		'Content-Disposition',
		`attachment; filename="${filenameFromKey(key).replace(/"/g, '')}"`
	);
	headers.set('Cache-Control', 'public, max-age=300, s-maxage=3600, stale-while-revalidate=3600');
	if (object.httpEtag) {
		headers.set('ETag', object.httpEtag);
	}

	return new Response(object.body, {
		status: 200,
		headers
	});
};
