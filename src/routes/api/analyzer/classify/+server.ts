import type { RequestHandler } from '@sveltejs/kit';
import {
	buildClassificationPrompt,
	classificationModel,
	didClassificationCacheKey,
	normalizeClassificationInputs,
	readCachedClassification,
	requestSemanticClassification,
	sha256Hex,
	writeCachedClassification
} from '$lib/server/classification';

function jsonResponse(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: {
			'Content-Type': 'application/json; charset=utf-8'
		}
	});
}

export const POST: RequestHandler = async ({ request, platform }) => {
	try {
		const body = (await request.json().catch(() => null)) as
			| { did?: string; clusters?: unknown }
			| null;
		const did = typeof body?.did === 'string' ? body.did.trim() : '';
		const clusters = normalizeClassificationInputs(body?.clusters);

		if (clusters.length === 0) {
			return jsonResponse({ classifications: [], model: classificationModel() });
		}

		const bucket = platform?.env?.POST_CACHE;
		const fetchEnabled = platform?.env?.FETCH !== '0';
		const apiKey = platform?.env?.GEMINI_API_KEY;
		let cacheKey: string | null = null;
		if (did) {
			const signature = await sha256Hex(JSON.stringify(clusters));
			cacheKey = didClassificationCacheKey(did, signature, 'v1');
			const cached = await readCachedClassification(bucket, cacheKey);
			if (cached) {
				return jsonResponse(cached);
			}
		}

		if (!fetchEnabled) {
			return jsonResponse({
				model: `${classificationModel()} (fetch-disabled)`,
				classifications: []
			});
		}

		if (!apiKey) {
			return jsonResponse(
				{ message: 'GEMINI_API_KEY is missing. Showing keyword labels until Gemini is configured.' },
				503
			);
		}

		const responsePayload = await requestSemanticClassification(
			apiKey,
			buildClassificationPrompt(clusters),
			{ model: classificationModel() }
		);

		if (cacheKey) {
			try {
				await writeCachedClassification(bucket, cacheKey, responsePayload);
			} catch {
				// Best-effort cache write.
			}
		}

		return jsonResponse(responsePayload);
	} catch (error: any) {
		return jsonResponse(
			{ message: error?.message || 'Failed to classify clusters.' },
			500
		);
	}
};
