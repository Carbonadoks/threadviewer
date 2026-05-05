import type { RequestHandler } from './$types';

interface CacheIndex {
	dids: string[];
}

interface CacheMeta {
	postCount: number;
	reachedEnd: boolean;
	updatedAt: string;
}

export const GET: RequestHandler = async ({ platform }) => {
	const bucket = platform?.env?.POST_CACHE;

	if (!bucket) {
		return Response.json({ accounts: [] });
	}

	const indexObj = await bucket.get('cache-index.json');
	if (!indexObj) {
		return Response.json({ accounts: [] });
	}

	const index: CacheIndex = await indexObj.json();
	if (!index.dids || index.dids.length === 0) {
		return Response.json({ accounts: [] });
	}

	const results = await Promise.allSettled(
		index.dids.map(async (did) => {
			const obj = await bucket.get(`posts/${did}/meta.json`);
			if (!obj) return null;
			const meta: CacheMeta = await obj.json();
			return {
				did,
				postCount: meta.postCount,
				reachedEnd: meta.reachedEnd,
				updatedAt: meta.updatedAt
			};
		})
	);

	const accounts = results
		.filter((r) => r.status === 'fulfilled' && r.value != null)
		.map((r) => (r as PromiseFulfilledResult<any>).value);

	return Response.json({ accounts });
};
