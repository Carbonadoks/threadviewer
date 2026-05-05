import type { RequestHandler } from './$types';

const ANALYSIS_CACHE_VERSION = 'v3';
const EMBEDDING_CACHE_NAMESPACE = 'cf-bge-small-en-v1.5-cls';
const ANALYSIS_CACHE_INDEX_KEY = `analysis-index/${ANALYSIS_CACHE_VERSION}/${EMBEDDING_CACHE_NAMESPACE}.json`;

interface AnalysisCacheIndexEntry {
	did: string;
	updatedAt: string;
	maxPosts: number;
}

interface AnalysisCacheIndex {
	accounts: AnalysisCacheIndexEntry[];
}

async function writeAnalysisCacheIndex(
	bucket: R2Bucket,
	index: AnalysisCacheIndex
): Promise<void> {
	await bucket.put(ANALYSIS_CACHE_INDEX_KEY, JSON.stringify(index), {
		httpMetadata: { contentType: 'application/json' }
	});
}

function sortAccounts(accounts: AnalysisCacheIndexEntry[]): AnalysisCacheIndexEntry[] {
	return [...accounts].sort(
		(a, b) =>
			new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime() ||
			a.did.localeCompare(b.did)
	);
}

function extractAccountsFromKeys(objects: R2Object[]): AnalysisCacheIndexEntry[] {
	const byDid = new Map<string, AnalysisCacheIndexEntry>();

	for (const object of objects) {
		const parts = object.key.split('/');
		if (
			parts.length < 6 ||
			parts[0] !== 'analysis' ||
			parts[1] !== ANALYSIS_CACHE_VERSION ||
			parts[2] !== EMBEDDING_CACHE_NAMESPACE
		) {
			continue;
		}

		const did = parts[3];
		const maxPosts = Number.parseInt(parts[4].replace('posts-', '').replace(/\.json$/, ''), 10);
		if (!did) {
			continue;
		}

		const uploadedAt =
			object.uploaded instanceof Date ? object.uploaded.toISOString() : new Date().toISOString();
		const existing = byDid.get(did);

		if (existing) {
			if (new Date(uploadedAt).getTime() > new Date(existing.updatedAt).getTime()) {
				existing.updatedAt = uploadedAt;
			}
			if (Number.isFinite(maxPosts)) {
				existing.maxPosts = Math.max(existing.maxPosts, maxPosts);
			}
		} else {
			byDid.set(did, {
				did,
				updatedAt: uploadedAt,
				maxPosts: Number.isFinite(maxPosts) ? maxPosts : 0
			});
		}
	}

	return sortAccounts([...byDid.values()]);
}

export const GET: RequestHandler = async ({ platform }) => {
	const bucket = platform?.env?.POST_CACHE;

	if (!bucket) {
		return Response.json({ accounts: [] });
	}

	const object = await bucket.get(ANALYSIS_CACHE_INDEX_KEY);
	if (object) {
		try {
			const payload = (await object.json()) as AnalysisCacheIndex;
			const accounts = Array.isArray(payload?.accounts) ? payload.accounts : [];
			if (accounts.length > 0) {
				return Response.json({
					accounts: sortAccounts(
						accounts.filter((account) => typeof account?.did === 'string' && account.did)
					)
				});
			}
		} catch {
			// Fall through to key scan.
		}
	}

	try {
		const listing = await bucket.list({
			prefix: `analysis/${ANALYSIS_CACHE_VERSION}/${EMBEDDING_CACHE_NAMESPACE}/`
		});
		const accounts = extractAccountsFromKeys(listing.objects);
		if (accounts.length > 0) {
			try {
				await writeAnalysisCacheIndex(bucket, { accounts });
			} catch {
				// Best-effort index backfill.
			}
		}
		return Response.json({
			accounts
		});
	} catch {
		return Response.json({ accounts: [] });
	}
};
