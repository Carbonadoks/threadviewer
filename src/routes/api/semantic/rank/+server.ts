import type { RequestHandler } from '@sveltejs/kit';
import { rankSemanticPosts } from '$lib/server/semanticDb';

function jsonResponse(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: {
			'Content-Type': 'application/json; charset=utf-8',
			'Cache-Control': 'no-store'
		}
	});
}

export const GET: RequestHandler = async ({ url }) => {
	const db = url.searchParams.get('db')?.trim() || '';
	const sourceUri = url.searchParams.get('uri')?.trim() || '';

	if (!db || !sourceUri) {
		return jsonResponse(
			{ message: 'Both db and uri are required for semantic ranking.' },
			400
		);
	}

	try {
		const payload = await rankSemanticPosts(db, sourceUri);
		return jsonResponse(payload);
	} catch (error: any) {
		return jsonResponse(
			{ message: error?.message || 'Failed to rank semantic posts.' },
			500
		);
	}
};
