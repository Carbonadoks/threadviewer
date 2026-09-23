import type { ThreadPost } from '$lib/types';
import {
	fetchPostsByUris,
	getPostsBatch,
	GET_POSTS_BATCH_SIZE,
	type FetchPostsProgress
} from '$lib/api/bluesky';
import type { RequestScheduler } from '$lib/utils/requestScheduler';
import { parseCarRecordsWasm } from '$lib/utils/carParserWasm';
import { downloadRepoCar, type RepoDownloadProgress } from '$lib/utils/repoHydration';

export const REPOST_COLLECTION = 'app.bsky.feed.repost';
export const LIKE_COLLECTION = 'app.bsky.feed.like';

/** Repo collections whose records point at another post via `subject: { uri, cid }`. */
export type SubjectCollection = typeof REPOST_COLLECTION | typeof LIKE_COLLECTION;

/** A repost or like record (same shape); field names are repost-flavoured for history. */
export interface RepoRepost {
	/** at:// URI of the repost/like record in the owner's repo. */
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
 * Extract every `app.bsky.feed.repost` (or `app.bsky.feed.like`) record from an
 * already-downloaded repo CAR. The record only references the subject post (uri + cid);
 * the actual post content lives in another user's repo and must be hydrated separately.
 */
export async function parseRepoRepostsFromCar(
	did: string,
	carBytes: Uint8Array,
	onParseProgress?: (count: number) => void,
	collection: SubjectCollection = REPOST_COLLECTION
): Promise<RepoRepost[]> {
	const records = await parseCarRecordsWasm(carBytes);
	const reposts: RepoRepost[] = [];

	for (const record of records) {
		if (record.collection !== collection) continue;
		const value = record.record as { subject?: { uri?: unknown; cid?: unknown }; createdAt?: unknown };
		const subjectUri = toText(value?.subject?.uri);
		if (!subjectUri) continue;
		reposts.push({
			repostUri: `at://${did}/${collection}/${record.rkey}`,
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
		collection?: SubjectCollection;
	} = {}
): Promise<RepoRepostLoadResult> {
	const {
		signal,
		concurrency,
		onDownloadProgress,
		onParseProgress,
		onHydrateProgress,
		collection = REPOST_COLLECTION
	} = options;
	const startTime = performance.now();

	const download = await downloadRepoCar(did, { signal, onDownloadProgress });
	const reposts = await parseRepoRepostsFromCar(did, download.carBytes, onParseProgress, collection);

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

export interface RepoSubjectRecords {
	reposts: RepoRepost[];
	likes: RepoRepost[];
}

/**
 * Reposts and likes from an already-downloaded CAR in one parse, newest first. Records
 * are only URIs + timestamps, so keeping them in memory is cheap compared to the CAR.
 */
export async function parseRepoSubjectRecordsFromCar(
	did: string,
	carBytes: Uint8Array
): Promise<RepoSubjectRecords> {
	const records = await parseCarRecordsWasm(carBytes);
	const out: RepoSubjectRecords = { reposts: [], likes: [] };

	for (const record of records) {
		const list =
			record.collection === REPOST_COLLECTION
				? out.reposts
				: record.collection === LIKE_COLLECTION
					? out.likes
					: null;
		if (!list) continue;
		const value = record.record as { subject?: { uri?: unknown; cid?: unknown }; createdAt?: unknown };
		const subjectUri = toText(value?.subject?.uri);
		if (!subjectUri) continue;
		list.push({
			repostUri: `at://${did}/${record.collection}/${record.rkey}`,
			repostCreatedAt: toText(value?.createdAt),
			subjectUri,
			subjectCid: toText(value?.subject?.cid)
		});
	}

	const newestFirst = (a: RepoRepost, b: RepoRepost) =>
		(Date.parse(b.repostCreatedAt) || 0) - (Date.parse(a.repostCreatedAt) || 0);
	out.reposts.sort(newestFirst);
	out.likes.sort(newestFirst);
	return out;
}

export interface SubjectHydrationBatch {
	/** URIs requested in this batch. */
	uris: string[];
	/** Posts the appview returned; requested URIs missing here are deleted/blocked/hidden. */
	posts: ThreadPost[];
}

/**
 * Hydrate posts through a shared RequestScheduler (adaptive concurrency, rate budget,
 * 429 back-off, bounded retries), one getPosts call per 25 URIs, in the given order.
 * Resolves once every batch settled; batches that still failed are counted, not thrown.
 */
export async function hydrateSubjectPosts(
	uris: string[],
	options: {
		scheduler: RequestScheduler;
		signal?: AbortSignal;
		label?: string;
		onBatch?: (batch: SubjectHydrationBatch) => void;
	}
): Promise<{ failedBatches: number; failedUris: number }> {
	const { scheduler, signal, label = 'posts', onBatch } = options;
	const batches: string[][] = [];
	for (let index = 0; index < uris.length; index += GET_POSTS_BATCH_SIZE) {
		batches.push(uris.slice(index, index + GET_POSTS_BATCH_SIZE));
	}

	let failedBatches = 0;
	let failedUris = 0;
	await Promise.all(
		batches.map(async (batch, index) => {
			try {
				const posts = await scheduler.schedule({
					kind: 'posts',
					label: `${label} ${index + 1}/${batches.length}`,
					priority: 1,
					signal,
					run: (taskSignal) => getPostsBatch(batch, taskSignal)
				});
				onBatch?.({ uris: batch, posts });
			} catch (err: any) {
				if (signal?.aborted || err?.name === 'AbortError') return;
				failedBatches += 1;
				failedUris += batch.length;
			}
		})
	);
	if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
	return { failedBatches, failedUris };
}
