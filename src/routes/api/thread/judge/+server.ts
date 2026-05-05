import type { RequestHandler } from '@sveltejs/kit';
import {
	buildThreadJudgeIndexEntry,
	buildThreadJudgePrompt,
	buildThreadJudgeSignature,
	legacyThreadJudgeCacheKeys,
	normalizeThreadJudgePosts,
	readCachedThreadJudge,
	readThreadJudgeIndex,
	requestThreadJudge,
	threadJudgeCacheKey,
	threadJudgeIndexKey,
	threadJudgeModel,
	writeCachedThreadJudge,
	writeThreadJudgeIndex,
	upsertThreadJudgeIndex
} from '$lib/server/threadJudge';
import { THREAD_JUDGE_MODEL_OPTIONS, normalizeThreadJudgeModel } from '$lib/utils/judgeModels';

function jsonResponse(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: {
			'Content-Type': 'application/json; charset=utf-8'
		}
	});
}

async function readCachedJudgeForRequest(
	bucket: R2Bucket | undefined,
	signature: string,
	requestedModel: string,
	allowAnyCachedModel: boolean
) {
	const currentModelKey = threadJudgeCacheKey(signature, requestedModel, 'v6');
	const currentModelPayload = await readCachedThreadJudge(bucket, currentModelKey);
	if (currentModelPayload) {
		return { payload: currentModelPayload, key: currentModelKey };
	}

	let firstLegacyMatch: { payload: any; key: string } | null = null;
	for (const legacyKey of legacyThreadJudgeCacheKeys(signature)) {
		const payload = await readCachedThreadJudge(bucket, legacyKey);
		if (!payload) continue;

		const payloadModel = normalizeThreadJudgeModel(payload.model);
		if (payloadModel === requestedModel) {
			return { payload, key: legacyKey };
		}

		if (allowAnyCachedModel && !firstLegacyMatch) {
			firstLegacyMatch = { payload, key: legacyKey };
		}
	}

	if (allowAnyCachedModel) {
		for (const model of THREAD_JUDGE_MODEL_OPTIONS.map((option) => option.id)) {
			if (model === requestedModel) continue;
			const key = threadJudgeCacheKey(signature, model, 'v6');
			const payload = await readCachedThreadJudge(bucket, key);
			if (payload) {
				return { payload, key };
			}
		}
	}

	return firstLegacyMatch;
}

export const POST: RequestHandler = async ({ request, platform }) => {
	try {
		const body = (await request.json().catch(() => null)) as
			| { rootUri?: string; posts?: unknown; cacheOnly?: boolean; model?: string; allowAnyCachedModel?: boolean }
			| null;
		const rootUri = typeof body?.rootUri === 'string' ? body.rootUri.trim() : '';
		const posts = normalizeThreadJudgePosts(body?.posts);
		const cacheOnly = body?.cacheOnly === true;
		const requestedModel = normalizeThreadJudgeModel(body?.model) ?? threadJudgeModel();
		const allowAnyCachedModel = body?.allowAnyCachedModel === true;

		if (posts.length === 0) {
			return jsonResponse({ judgments: {}, model: requestedModel, postCount: 0 });
		}

		const bucket = platform?.env?.POST_CACHE;
		const fetchEnabled = platform?.env?.FETCH !== '0';
		const apiKey = platform?.env?.GEMINI_API_KEY;
		const signature = await buildThreadJudgeSignature(posts, rootUri);
		const cached = await readCachedJudgeForRequest(
			bucket,
			signature,
			requestedModel,
			allowAnyCachedModel
		);
		if (cached?.payload) {
			try {
				const entry = buildThreadJudgeIndexEntry(rootUri, posts, cached.payload);
				if (entry) {
					const indexKey = threadJudgeIndexKey('v1');
					const existing = await readThreadJudgeIndex(bucket, indexKey);
					await writeThreadJudgeIndex(bucket, indexKey, upsertThreadJudgeIndex(existing, entry));
				}
			} catch {
				// Best-effort cache index write.
			}
			return jsonResponse(cached.payload);
		}

		if (cacheOnly) {
			return jsonResponse({ message: 'No cached judgment found for this thread.' }, 404);
		}

			if (!fetchEnabled) {
				return jsonResponse({
					model: `${requestedModel} (fetch-disabled)`,
					postCount: posts.length,
					judgments: {}
				});
			}

		if (!apiKey) {
			return jsonResponse(
				{ message: 'GEMINI_API_KEY is missing. Thread judging is unavailable until Gemini is configured.' },
				503
			);
		}

			const responsePayload = await requestThreadJudge(apiKey, buildThreadJudgePrompt(posts), {
				model: requestedModel,
				expectedPostCount: posts.length
			});
			const cacheKey = threadJudgeCacheKey(signature, requestedModel, 'v6');

			try {
				await writeCachedThreadJudge(bucket, cacheKey, responsePayload);
		} catch {
			// Best-effort cache write.
		}

		try {
			const entry = buildThreadJudgeIndexEntry(rootUri, posts, responsePayload);
			if (entry) {
				const indexKey = threadJudgeIndexKey('v1');
				const existing = await readThreadJudgeIndex(bucket, indexKey);
				await writeThreadJudgeIndex(bucket, indexKey, upsertThreadJudgeIndex(existing, entry));
			}
		} catch {
			// Best-effort cache index write.
		}

		return jsonResponse(responsePayload);
	} catch (error: any) {
		return jsonResponse(
			{ message: error?.message || 'Failed to judge thread.' },
			500
		);
	}
};
