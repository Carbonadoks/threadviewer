import type { ThreadPost } from '$lib/types';
import { fetchPostsByUris, type FetchPostsProgress } from '$lib/api/bluesky';
import { parseCarRecordsWasm } from '$lib/utils/carParserWasm';
import { downloadRepoCar, type RepoDownloadProgress } from '$lib/utils/repoHydration';

const REPOST_COLLECTION = 'app.bsky.feed.repost';

export interface RepoRepost {
	/** at:// URI of the repost record in the owner's repo. */
	repostUri: string;
	/** When the owner reposted (record.createdAt). */
	repostCreatedAt: string;
	/** at:// URI of the reposted post (record.subject.uri). */
	subjectUri: string;
	/** CID of the reposted post (record.subject.cid). */
	subjectCid: string;
}

export interface RepoRepostLoadResult {
	/** All repost records from the CAR, newest first. */
	reposts: RepoRepost[];
	/** Hydrated reposted posts, keyed by their at:// URI. Deleted/blocked ones are absent. */
	posts: Map<string, ThreadPost>;
	totalReposts: number;
	hydratedCount: number;
	elapsedMs: number;
	downloadedBytes: number;
	source: 'pds' | 'relay';
}

function toText(value: unknown): string {
	return typeof value === 'string' ? value : '';
}

/**
 * Extract every `app.bsky.feed.repost` record from an already-downloaded repo CAR.
 * A repost record only references the reposted post (subject uri + cid); the actual
 * post content lives in another user's repo and must be hydrated separately.
 */
export async function parseRepoRepostsFromCar(
	did: string,
	carBytes: Uint8Array,
	onParseProgress?: (count: number) => void
): Promise<RepoRepost[]> {
	const records = await parseCarRecordsWasm(carBytes);
	const reposts: RepoRepost[] = [];

	for (const record of records) {
		if (record.collection !== REPOST_COLLECTION) continue;
		const value = record.record as { subject?: { uri?: unknown; cid?: unknown }; createdAt?: unknown };
		const subjectUri = toText(value?.subject?.uri);
		if (!subjectUri) continue;
		reposts.push({
			repostUri: `at://${did}/${REPOST_COLLECTION}/${record.rkey}`,
			repostCreatedAt: toText(value?.createdAt),
			subjectUri,
			subjectCid: toText(value?.subject?.cid)
		});
	}

	reposts.sort(
		(a, b) => (Date.parse(b.repostCreatedAt) || 0) - (Date.parse(a.repostCreatedAt) || 0)
	);
	onParseProgress?.(reposts.length);
	return reposts;
}

/**
 * Download a repo CAR, extract its reposts, and hydrate the reposted posts via the
 * appview so they can be rendered. The repost list itself is fully local to the CAR;
 * only the referenced post contents require network calls.
 */
export async function loadRepoReposts(
	did: string,
	options: {
		signal?: AbortSignal;
		concurrency?: number;
		onDownloadProgress?: (progress: RepoDownloadProgress) => void;
		onParseProgress?: (count: number) => void;
		onHydrateProgress?: (progress: FetchPostsProgress) => void;
	} = {}
): Promise<RepoRepostLoadResult> {
	const { signal, concurrency, onDownloadProgress, onParseProgress, onHydrateProgress } = options;
	const startTime = performance.now();

	const download = await downloadRepoCar(did, { signal, onDownloadProgress });
	const reposts = await parseRepoRepostsFromCar(did, download.carBytes, onParseProgress);

	const subjectUris = [...new Set(reposts.map((repost) => repost.subjectUri))];
	const posts =
		subjectUris.length > 0
			? await fetchPostsByUris(subjectUris, { signal, concurrency, onProgress: onHydrateProgress })
			: new Map<string, ThreadPost>();

	return {
		reposts,
		posts,
		totalReposts: reposts.length,
		hydratedCount: posts.size,
		elapsedMs: Math.round(performance.now() - startTime),
		downloadedBytes: download.downloadedBytes,
		source: download.source
	};
}
