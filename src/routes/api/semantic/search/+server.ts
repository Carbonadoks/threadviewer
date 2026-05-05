import type { RequestHandler } from '@sveltejs/kit';
import { searchSemanticPosts } from '$lib/server/semanticDb';

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
	const query = url.searchParams.get('q')?.trim() || '';
	const limit = Number.parseInt(url.searchParams.get('limit') || '50', 10) || 50;

	if (!db) {
		return jsonResponse({ message: 'A semantic DB filename is required.' }, 400);
	}

	try {
		const payload = await searchSemanticPosts(db, query, limit);
		return jsonResponse(payload);
	} catch (error: any) {
		return jsonResponse(
			{ message: error?.message || 'Failed to search semantic posts.' },
			500
		);
	}
};
