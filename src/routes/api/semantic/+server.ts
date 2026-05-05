import type { RequestHandler } from '@sveltejs/kit';
import { listSemanticBucketFiles } from '$lib/server/semanticBucket';

function jsonResponse(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: {
			'Content-Type': 'application/json; charset=utf-8',
			'Cache-Control': 'no-store'
		}
	});
}

export const GET: RequestHandler = async ({ platform }) => {
	const bucket = platform?.env?.POST_CACHE;
	if (!bucket) {
		return jsonResponse({ message: 'Semantic DB bucket is unavailable.' }, 503);
	}

	try {
		const files = await listSemanticBucketFiles(bucket);
		return jsonResponse({ files });
	} catch (error: any) {
		return jsonResponse(
			{ message: error?.message || 'Failed to list semantic database files.' },
			500
		);
	}
};
