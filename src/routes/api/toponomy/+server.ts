import type { RequestHandler } from '@sveltejs/kit';
import type { ClusterApiResponse } from '$lib/types';
import {
	createBucketClusterStorage
} from '$lib/server/clusterSnapshot';
import {
	resolveToponomyApiResponse
} from '$lib/server/toponomySnapshot';

function jsonResponse(data: ClusterApiResponse, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: {
			'Content-Type': 'application/json; charset=utf-8',
			'Cache-Control': 'no-store'
		}
	});
}

async function resolveResponse(platform: App.Platform | undefined): Promise<Response> {
	const bucket = platform?.env?.POST_CACHE;
	if (!bucket) {
		return jsonResponse({ status: 'missing' }, 503);
	}

	const payload = await resolveToponomyApiResponse(createBucketClusterStorage(bucket));
	return jsonResponse(payload);
}

export const GET: RequestHandler = async ({ platform }) => resolveResponse(platform);
export const POST: RequestHandler = async ({ platform }) => resolveResponse(platform);
