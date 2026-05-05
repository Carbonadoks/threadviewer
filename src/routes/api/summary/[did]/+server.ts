import type { RequestHandler } from '@sveltejs/kit';
import type { CachedUserSummary } from '$lib/types';

const SUMMARY_CACHE_VERSION = 'v2';

function summaryCacheKey(did: string): string {
	return `summary/${SUMMARY_CACHE_VERSION}/${did}.json`;
}

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' }
	});
}

export const GET: RequestHandler = async ({ params, platform }) => {
	const did = params.did;
	if (!did) {
		return jsonResponse({ error: 'Missing DID' }, 400);
	}

	const bucket = platform?.env?.POST_CACHE as R2Bucket | undefined;
	if (!bucket) {
		return jsonResponse({ error: 'Storage unavailable' }, 503);
	}

	try {
		const obj = await bucket.get(summaryCacheKey(did));
		if (!obj) {
			return jsonResponse({ error: 'No cached summary' }, 404);
		}
		const envelope = await obj.json();
		return jsonResponse(envelope);
	} catch {
		return jsonResponse({ error: 'Cache read failed' }, 500);
	}
};

export const PUT: RequestHandler = async ({ params, platform, request }) => {
	const did = params.did;
	if (!did) {
		return jsonResponse({ error: 'Missing DID' }, 400);
	}

	const bucket = platform?.env?.POST_CACHE as R2Bucket | undefined;
	if (!bucket) {
		return jsonResponse({ error: 'Storage unavailable' }, 503);
	}

	let body: { summary: CachedUserSummary };
	try {
		body = await request.json();
	} catch {
		return jsonResponse({ error: 'Invalid JSON body' }, 400);
	}

	if (!body?.summary?.did || body.summary.did !== did) {
		return jsonResponse({ error: 'DID mismatch' }, 400);
	}

	const envelope = {
		summary: body.summary,
		cachedAt: new Date().toISOString()
	};

	try {
		await bucket.put(summaryCacheKey(did), JSON.stringify(envelope), {
			httpMetadata: { contentType: 'application/json' }
		});
	} catch {
		return jsonResponse({ error: 'Cache write failed' }, 500);
	}

	return jsonResponse({ ok: true });
};
