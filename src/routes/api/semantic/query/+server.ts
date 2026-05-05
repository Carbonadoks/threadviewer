import type { RequestHandler } from '@sveltejs/kit';
import { embedTextQuery } from '$lib/server/cloudflareEmbeddings';

function jsonResponse(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: {
			'Content-Type': 'application/json; charset=utf-8',
			'Cache-Control': 'no-store'
		}
	});
}

export const POST: RequestHandler = async ({ platform, request }) => {
	const body = (await request.json().catch(() => null)) as
		| { query?: string }
		| null;
	const query = typeof body?.query === 'string' ? body.query.trim() : '';

	if (!query) {
		return jsonResponse({ message: 'A semantic query is required.' }, 400);
	}

	try {
		const embedding = await embedTextQuery(query, platform);
		return jsonResponse({
			query,
			vector: embedding.vector,
			model: embedding.model,
			pooling: embedding.pooling
		});
	} catch (error: any) {
		return jsonResponse(
			{ message: error?.message || 'Failed to run semantic search.' },
			500
		);
	}
};
