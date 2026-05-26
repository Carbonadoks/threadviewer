import type { RequestHandler } from './$types';
import { readAtproideasioBoardSnapshot } from '$lib/server/atproideasio';
import type { AtproideasioBoardResponse } from '$lib/types/atproideasio';

export const GET: RequestHandler = async ({ platform }) => {
	const bucket = platform?.env?.POST_CACHE;
	const snapshot = await readAtproideasioBoardSnapshot(bucket);
	const payload: AtproideasioBoardResponse = {
		...snapshot,
		missing: !snapshot.updatedAt
	};

	return Response.json(payload, {
		headers: {
			'Cache-Control': 'no-store'
		}
	});
};
