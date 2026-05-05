import type { RequestHandler } from '@sveltejs/kit';
import { readThreadJudgeIndex, threadJudgeIndexKey } from '$lib/server/threadJudge';

export const GET: RequestHandler = async ({ platform }) => {
	const bucket = platform?.env?.POST_CACHE;

	if (!bucket) {
		return Response.json({ threads: [] });
	}

	const threads = await readThreadJudgeIndex(bucket, threadJudgeIndexKey('v1'));
	return Response.json({ threads });
};
