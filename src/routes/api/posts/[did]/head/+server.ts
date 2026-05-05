import type { RequestHandler } from '@sveltejs/kit';
import { readPostCacheHeadBatch } from '$lib/server/postCache';

function headerBool(value: boolean): string {
	return value ? '1' : '0';
}

export const GET: RequestHandler = async ({ params, platform, url }) => {
	const did = params.did ?? '';
	const groupId = url.searchParams.get('group') ?? '';
	const batchIndex = Number.parseInt(url.searchParams.get('batch') || '0', 10);
	const normalizedBatchIndex = Number.isFinite(batchIndex) ? Math.max(0, batchIndex) : 0;
	const bucket = platform?.env?.POST_CACHE;

	const result = await readPostCacheHeadBatch(bucket, did, groupId, normalizedBatchIndex);

	return new Response(JSON.stringify(result.posts), {
		headers: {
			'Content-Type': 'application/json; charset=utf-8',
			'X-Head-Group': groupId,
			'X-Head-Batch': String(normalizedBatchIndex),
			'X-Head-Post-Count': String(result.postCount),
			'X-Head-Missing': headerBool(result.missing)
		}
	});
};
