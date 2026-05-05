import type { RequestHandler } from './$types';
import { readPostCacheMeta } from '$lib/server/postCache';

function headerBool(value: boolean): string {
	return value ? '1' : '0';
}

function chunkResponse(options: {
	index: number;
	chunkCount: number;
	postCount: number;
	reachedEnd: boolean;
	missing: boolean;
	nextIndex: number | null;
	body?: ReadableStream | string;
}): Response {
	const headers = new Headers({
		'Content-Type': 'application/json; charset=utf-8',
		'X-Chunk-Index': String(options.index),
		'X-Chunk-Count': String(options.chunkCount),
		'X-Post-Count': String(options.postCount),
		'X-Reached-End': headerBool(options.reachedEnd),
		'X-Chunk-Missing': headerBool(options.missing),
		'X-Next-Index': options.nextIndex == null ? '' : String(options.nextIndex)
	});

	return new Response(options.body ?? '[]', { headers });
}

export const GET: RequestHandler = async ({ params, platform, url }) => {
	const did = params.did;
	const requestedIndex = parseInt(url.searchParams.get('index') || '0');
	const index = Number.isFinite(requestedIndex) ? Math.max(0, requestedIndex) : 0;
	const bucket = platform?.env?.POST_CACHE;

	if (!bucket) {
		return chunkResponse({
			index,
			chunkCount: 0,
			postCount: 0,
			reachedEnd: false,
			nextIndex: null,
			missing: true
		});
	}

	const meta = await readPostCacheMeta(bucket, did);
	if (!meta) {
		return chunkResponse({
			index,
			chunkCount: 0,
			postCount: 0,
			reachedEnd: false,
			nextIndex: null,
			missing: true
		});
	}
	const chunkCount = meta?.tail.chunkCount ?? 0;
	const postCount = meta?.tail.postCount ?? 0;
	const reachedEnd = meta?.tail.reachedEnd ?? false;

	if (index >= chunkCount) {
		return chunkResponse({
			index,
			chunkCount,
			postCount,
			reachedEnd,
			nextIndex: null,
			missing: false
		});
	}

	const object = await bucket.get(`posts/${did}/chunk-${index}.json`);
	if (!object) {
		return chunkResponse({
			index,
			chunkCount,
			postCount,
			reachedEnd,
			nextIndex: index + 1 < chunkCount ? index + 1 : null,
			missing: true
		});
	}

	return chunkResponse({
		index,
		chunkCount,
		postCount,
		reachedEnd,
		nextIndex: index + 1 < chunkCount ? index + 1 : null,
		missing: false,
		body: object.body ?? (await object.text())
	});
};
