import type { RequestHandler } from './$types';
import { readPostCacheMeta, toPublicPostCacheStatus } from '$lib/server/postCache';

export const GET: RequestHandler = async ({ params, platform }) => {
	const did = params.did;
	const bucket = platform?.env?.POST_CACHE;

	if (!bucket) {
		return Response.json(toPublicPostCacheStatus(null));
	}

	const meta = await readPostCacheMeta(bucket, did);
	return Response.json({
		...toPublicPostCacheStatus(meta),
		head: meta
			? {
					postCount: meta.head.postCount,
					groups: meta.head.groups.map((group) => ({
						id: group.id,
						anchorUri: group.anchorUri,
						postCount: group.postCount,
						updatedAt: group.updatedAt,
						nextCursor: group.nextCursor,
						complete: group.complete,
						batches: group.batches.map((batch) => ({
							postCount: batch.postCount
						}))
					}))
				}
			: {
					postCount: 0,
					groups: []
				},
		tail: meta
			? {
					postCount: meta.tail.postCount,
					chunkCount: meta.tail.chunkCount,
					cursor: meta.tail.cursor,
					reachedEnd: meta.tail.reachedEnd
				}
			: {
					postCount: 0,
					chunkCount: 0,
					cursor: null,
					reachedEnd: false
				}
	});
};
