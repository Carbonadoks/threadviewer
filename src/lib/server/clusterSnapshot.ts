import type {
	ClusterApiResponse,
	ClusterBuildFailure,
	ClusterBuildProgress,
	ClusterOverview,
	ClusterPoint,
	ClusterRepresentative,
	ClusterSnapshot,
	ClusterSummary
} from '$lib/types';
import {
	buildClassificationPrompt,
	buildClassificationSignature,
	classificationModel,
	globalClassificationCacheKey,
	requestSemanticClassification,
	type SemanticClassificationPayload
} from '$lib/server/classification';
import { normalizeProjectionCoordinates } from '$lib/utils/clusterProjection';
import {
	buildAtlasClusterLayout,
	type AtlasClusterCenter,
	type AtlasRegionLayout
} from '$lib/utils/clusterAtlas';
import { normalizeVector, projectEmbeddingsRaw } from '$lib/utils/threadAnalysis';

export const ANALYSIS_CACHE_VERSION = 'v3';
export const EMBEDDING_CACHE_NAMESPACE = 'cf-bge-small-en-v1.5-cls';
export const EMBEDDING_MODEL_LABEL = '@cf/baai/bge-small-en-v1.5 (cls)';
export const SNAPSHOT_MAX_POSTS = 1000;
export const REPRESENTATIVES_PER_CLUSTER = 6;
export const CLUSTER_CACHE_VERSION = 'v7';
export const CLUSTER_CLASSIFICATION_CACHE_VERSION = 'v2';
const ANALYSIS_LIST_LIMIT = 100;
const KMEANS_ITERATIONS = 12;
const CLUSTER_TEXT_LIMIT = 1400;
const PROJECT_NEIGHBOR_K = 10;
const PROJECTION_GRAPH_K = 18;
const PROJECTION_REFINE_ITERATIONS = 140;
const PROJECTION_ATTRACTION = 0.11;
const PROJECTION_REPULSION = 0.028;
const PROJECTION_DAMPING = 0.8;
const PROJECTION_REPULSION_RADIUS_FACTOR = 1.45;
const ANALYSIS_PREFIX = `analysis/${ANALYSIS_CACHE_VERSION}/${EMBEDDING_CACHE_NAMESPACE}/`;
const ANALYSIS_POSTS_KEY = `posts-${SNAPSHOT_MAX_POSTS}`;
export const CLUSTER_PREFIX = `clusters/${CLUSTER_CACHE_VERSION}/${EMBEDDING_CACHE_NAMESPACE}/posts-${SNAPSHOT_MAX_POSTS}`;
export const SNAPSHOT_KEY = `${CLUSTER_PREFIX}/snapshot.json`;
export const OVERVIEW_KEY = `${CLUSTER_PREFIX}/overview.json`;
export const POINTS_KEY = `${CLUSTER_PREFIX}/points.json`;
export const META_KEY = `${CLUSTER_PREFIX}/meta.json`;
export const BUILD_STATE_KEY = `${CLUSTER_PREFIX}/build-state.json`;
export const FAILURE_KEY = `${CLUSTER_PREFIX}/failure.json`;
const LEGACY_BUILD_PREFIX = `${CLUSTER_PREFIX}/build/`;
const CLUSTER_STOPWORDS = new Set([
	'the',
	'and',
	'that',
	'this',
	'with',
	'from',
	'they',
	'them',
	'then',
	'there',
	'their',
	'about',
	'into',
	'because',
	'after',
	'before',
	'while',
	'where',
	'when',
	'what',
	'which',
	'just',
	'than',
	'have',
	'has',
	'will',
	'would',
	'could',
	'should',
	'been',
	'being',
	'were',
	'was',
	'are',
	'you',
	'your',
	'its',
	'our',
	'out',
	'for',
	'not',
	'but',
	'too',
	'can',
	'cant',
	'dont',
	'does',
	'did',
	'why',
	'how',
	'who',
	'all',
	'any',
	'more',
	'most',
	'some',
	'like',
	'thread',
	'threads',
	'post',
	'posts',
	'reply',
	'replies'
]);

export interface ClusterStorageObject {
	key: string;
}

export interface ClusterStorageListResult {
	objects: ClusterStorageObject[];
	truncated: boolean;
	cursor?: string;
}

export interface ClusterStorage {
	list(prefix: string, options?: { cursor?: string; limit?: number }): Promise<ClusterStorageListResult>;
	has(key: string): Promise<boolean>;
	getText(key: string): Promise<string | null>;
	putText(key: string, value: string, options?: { contentType?: string }): Promise<void>;
	delete(key: string): Promise<void>;
}

interface BuildThreadRecord {
	did: string;
	rootUri: string;
	createdAt: string;
	title: string;
	preview: string;
	text: string;
	depth: number;
	postCount: number;
	segmentCount: number;
	embedding: number[];
}

interface ClusterBuildStateRecord {
	phase: ClusterBuildProgress['phase'];
	createdAt: string;
	updatedAt: string;
	scan: {
		cursor?: string;
		pageIndex: number;
		objectsProcessed: number;
		threadsProcessed: number;
		seenPeople: string[];
		hasMore: boolean;
	};
	cluster?: {
		totalThreads: number;
		totalPeople: number;
		clusterCount: number;
	};
}

interface ClusterArtifactPoint {
	did: string;
	rootUri: string;
	createdAt: string;
	title: string;
	preview: string;
	text: string;
	depth: number;
	postCount: number;
	segmentCount: number;
	cluster: number;
	x?: number;
	y?: number;
}

interface ClusterArtifactRepresentative extends Omit<ClusterRepresentative, 'x' | 'y'> {
	text: string;
	x?: number;
	y?: number;
}

interface ClusteredArtifactCluster {
	cluster: number;
	threadCount: number;
	peopleCount: number;
	representatives: ClusterArtifactRepresentative[];
	classificationText: string;
	region?: AtlasRegionLayout;
}

interface ClusteredArtifact {
	generatedAt: string;
	points: ClusterArtifactPoint[];
	clusters: ClusteredArtifactCluster[];
	totalThreads: number;
	totalPeople: number;
	projection?: {
		method: 'mds-cosine' | 'mds-cosine-refined' | 'atlas-cluster-relaxed';
		neighborRecall: number;
	};
}

interface SemanticLabel {
	label: string;
	keywords: string[];
	summary: string;
}

class ClusterBuildError extends Error {
	phase: ClusterBuildProgress['phase'];
	details?: string;

	constructor(phase: ClusterBuildProgress['phase'], message: string, details?: string) {
		super(message);
		this.name = 'ClusterBuildError';
		this.phase = phase;
		this.details = details;
	}
}

export interface OfflineClusterBuildOptions {
	storage: ClusterStorage;
	fetchEnabled?: boolean;
	apiKey?: string;
	log?: (message: string) => void;
	shouldAbort?: () => string | null;
}

export function createBucketClusterStorage(bucket: R2Bucket): ClusterStorage {
	return {
		async list(prefix, options = {}) {
			const listing = await bucket.list({
				prefix,
				cursor: options.cursor,
				limit: options.limit
			});
			const cursor = listing.truncated ? listing.cursor : undefined;
			return {
				objects: listing.objects.map((object) => ({ key: object.key })),
				truncated: listing.truncated,
				cursor
			};
		},
		async has(key) {
			const object = await bucket.head(key);
			return Boolean(object);
		},
		async getText(key) {
			const object = await bucket.get(key);
			if (!object) return null;
			return object.text();
		},
		async putText(key, value, options = {}) {
			await bucket.put(key, value, {
				httpMetadata: {
					contentType: options.contentType ?? 'application/json'
				}
			});
		},
		async delete(key) {
			await bucket.delete(key);
		}
	};
}

function jsonResponse(data: ClusterApiResponse): ClusterApiResponse {
	return data;
}

function parseVector(value: unknown): number[] | null {
	if (!Array.isArray(value) || value.length === 0) return null;
	const vector = value.map((item) => Number(item));
	if (vector.some((item) => !Number.isFinite(item))) return null;
	return vector;
}

function dotProduct(a: number[], b: number[]): number {
	let total = 0;
	const length = Math.min(a.length, b.length);
	for (let index = 0; index < length; index++) {
		total += a[index] * b[index];
	}
	return total;
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

function rootId(record: { did: string; rootUri: string }): string {
	return `${record.did}:${record.rootUri}`;
}

function parseAnalysisKey(key: string): { did: string } | null {
	const parts = key.split('/');
	if (
		parts.length !== 6 ||
		parts[0] !== 'analysis' ||
		parts[1] !== ANALYSIS_CACHE_VERSION ||
		parts[2] !== EMBEDDING_CACHE_NAMESPACE ||
		parts[4] !== ANALYSIS_POSTS_KEY ||
		!/^offset-\d+\.json$/.test(parts[5])
	) {
		return null;
	}

	const did = parts[3]?.trim();
	return did ? { did } : null;
}

function toCount(value: unknown): number {
	return Number.isFinite(Number(value)) ? Math.max(0, Math.round(Number(value))) : 0;
}

function extractCreatedAt(thread: any, generatedAt: string): string {
	const firstPost = thread?.posts?.[0]?.createdAt;
	if (typeof firstPost === 'string' && firstPost.trim().length > 0) {
		return firstPost;
	}

	const firstSegment = thread?.segments?.[0]?.createdAt;
	if (typeof firstSegment === 'string' && firstSegment.trim().length > 0) {
		return firstSegment;
	}

	return generatedAt;
}

function extractBuildRecordsFromBatch(payload: any, did: string): BuildThreadRecord[] {
	const generatedAt =
		typeof payload?.generatedAt === 'string' && payload.generatedAt.trim().length > 0
			? payload.generatedAt
			: new Date().toISOString();
	const threads = Array.isArray(payload?.batch?.threads) ? payload.batch.threads : [];
	const records: BuildThreadRecord[] = [];

	for (const thread of threads) {
		const rootUri = typeof thread?.rootUri === 'string' ? thread.rootUri.trim() : '';
		const embedding = parseVector(thread?.embedding);
		if (!rootUri || !embedding) continue;

		const title = typeof thread?.title === 'string' ? thread.title.trim() : '';
		const preview = typeof thread?.preview === 'string' ? thread.preview.trim() : '';
		const text = typeof thread?.text === 'string' ? thread.text.trim() : '';
		records.push({
			did,
			rootUri,
			createdAt: extractCreatedAt(thread, generatedAt),
			title: title || preview || 'Untitled thread',
			preview: preview || text.slice(0, 220),
			text: text || preview || title || 'Untitled thread',
			depth: toCount(thread?.depth),
			postCount: toCount(thread?.postCount),
			segmentCount: toCount(thread?.segmentCount),
			embedding
		});
	}

	return records;
}

function buildInitialState(): ClusterBuildStateRecord {
	const now = new Date().toISOString();
	return {
		phase: 'scan',
		createdAt: now,
		updatedAt: now,
		scan: {
			cursor: undefined,
			pageIndex: 0,
			objectsProcessed: 0,
			threadsProcessed: 0,
			seenPeople: [],
			hasMore: true
		}
	};
}

function toBuildProgress(state: ClusterBuildStateRecord): ClusterBuildProgress {
	return {
		phase: state.phase,
		startedAt: state.createdAt,
		updatedAt: state.updatedAt,
		objectsProcessed: state.scan.objectsProcessed,
		threadsProcessed: state.scan.threadsProcessed,
		uniquePeopleSoFar: state.scan.seenPeople.length,
		pageIndex: state.scan.pageIndex,
		hasMore: state.phase === 'scan' ? state.scan.hasMore : false,
		clusterCount: state.cluster?.clusterCount,
		totalThreads: state.cluster?.totalThreads
	};
}

async function readJson<T>(storage: ClusterStorage, key: string): Promise<T | null> {
	const text = await storage.getText(key);
	if (!text) return null;
	try {
		return JSON.parse(text) as T;
	} catch {
		return null;
	}
}

async function putJson(storage: ClusterStorage, key: string, payload: unknown): Promise<void> {
	await storage.putText(key, JSON.stringify(payload), {
		contentType: 'application/json'
	});
}

async function listAllObjects(storage: ClusterStorage, prefix: string): Promise<ClusterStorageObject[]> {
	const objects: ClusterStorageObject[] = [];
	let cursor: string | undefined;

	while (true) {
		const listing = await storage.list(prefix, { cursor, limit: ANALYSIS_LIST_LIMIT });
		objects.push(...listing.objects);
		if (!listing.truncated || !listing.cursor) break;
		cursor = listing.cursor;
	}

	return objects;
}

async function deleteByPrefix(storage: ClusterStorage, prefix: string): Promise<void> {
	const objects = await listAllObjects(storage, prefix);
	for (const object of objects) {
		await storage.delete(object.key);
	}
}

async function readBuildState(storage: ClusterStorage): Promise<ClusterBuildStateRecord | null> {
	const state = await readJson<ClusterBuildStateRecord>(storage, BUILD_STATE_KEY);
	if (!state?.scan || !state?.phase) return null;
	return state;
}

async function writeBuildState(storage: ClusterStorage, state: ClusterBuildStateRecord): Promise<void> {
	await putJson(storage, BUILD_STATE_KEY, state);
}

async function clearBuildState(storage: ClusterStorage): Promise<void> {
	await storage.delete(BUILD_STATE_KEY);
}

async function readFailure(storage: ClusterStorage): Promise<ClusterBuildFailure | null> {
	const failure = await readJson<ClusterBuildFailure>(storage, FAILURE_KEY);
	if (!failure?.phase || !failure?.message || !failure?.updatedAt) {
		return null;
	}
	return failure;
}

async function writeFailure(storage: ClusterStorage, failure: ClusterBuildFailure): Promise<void> {
	await putJson(storage, FAILURE_KEY, failure);
}

async function clearFailure(storage: ClusterStorage): Promise<void> {
	await storage.delete(FAILURE_KEY);
}

async function readCachedClassificationFromStorage(
	storage: ClusterStorage,
	key: string
): Promise<SemanticClassificationPayload | null> {
	const payload = await readJson<SemanticClassificationPayload>(storage, key);
	if (!payload?.model || !Array.isArray(payload?.classifications)) {
		return null;
	}
	return payload;
}

async function writeCachedClassificationToStorage(
	storage: ClusterStorage,
	key: string,
	payload: SemanticClassificationPayload
): Promise<void> {
	await putJson(storage, key, payload);
}

function choosePreferredRecord(a: BuildThreadRecord, b: BuildThreadRecord): BuildThreadRecord {
	if (a.segmentCount !== b.segmentCount) {
		return a.segmentCount > b.segmentCount ? a : b;
	}
	if (a.postCount !== b.postCount) {
		return a.postCount > b.postCount ? a : b;
	}
	if (a.depth !== b.depth) {
		return a.depth > b.depth ? a : b;
	}
	if (a.createdAt !== b.createdAt) {
		return a.createdAt > b.createdAt ? a : b;
	}
	return rootId(a).localeCompare(rootId(b)) <= 0 ? a : b;
}

function clusterCountForThreads(threadCount: number): number {
	if (threadCount <= 0) return 0;
	if (threadCount < 2) return 1;
	return Math.max(2, Math.min(12, Math.round(Math.sqrt(threadCount / 18))));
}

function kMeansCosine(
	vectors: number[][],
	ids: string[],
	clusterCount: number
): { assignments: number[]; centers: number[][] } {
	if (vectors.length === 0 || clusterCount === 0) {
		return { assignments: [], centers: [] };
	}
	if (clusterCount === 1) {
		return {
			assignments: new Array(vectors.length).fill(0),
			centers: [vectors[0].slice()]
		};
	}

	const ordered = ids
		.map((id, index) => ({ id, index }))
		.sort((a, b) => a.id.localeCompare(b.id));
	const centers = new Array(clusterCount).fill(null).map((_, clusterIndex) => {
		const source = ordered[Math.floor((clusterIndex * ordered.length) / clusterCount)];
		return vectors[source.index].slice();
	});
	const assignments = new Array<number>(vectors.length).fill(0);

	for (let round = 0; round < KMEANS_ITERATIONS; round++) {
		let changed = false;

		for (let index = 0; index < vectors.length; index++) {
			let bestCluster = 0;
			let bestScore = Number.NEGATIVE_INFINITY;
			for (let clusterIndex = 0; clusterIndex < centers.length; clusterIndex++) {
				const score = dotProduct(vectors[index], centers[clusterIndex]);
				if (score > bestScore) {
					bestScore = score;
					bestCluster = clusterIndex;
				}
			}
			if (assignments[index] !== bestCluster) {
				assignments[index] = bestCluster;
				changed = true;
			}
		}

		const sums = new Array(clusterCount).fill(null).map(() => ({
			total: new Array<number>(vectors[0].length).fill(0),
			count: 0
		}));
		for (let index = 0; index < vectors.length; index++) {
			const target = sums[assignments[index]];
			for (let axis = 0; axis < vectors[index].length; axis++) {
				target.total[axis] += vectors[index][axis];
			}
			target.count += 1;
		}

		for (let clusterIndex = 0; clusterIndex < clusterCount; clusterIndex++) {
			if (sums[clusterIndex].count > 0) {
				centers[clusterIndex] = normalizeVector(
					sums[clusterIndex].total.map((value) => value / sums[clusterIndex].count)
				);
				continue;
			}

			const fallback = ordered[(round + clusterIndex) % ordered.length];
			centers[clusterIndex] = vectors[fallback.index].slice();
		}

		if (!changed) {
			break;
		}
	}

	return { assignments, centers };
}

function tokenize(text: string): string[] {
	return (
		text
			.toLowerCase()
			.replace(/https?:\/\/\S+/g, ' ')
			.match(/[a-z][a-z0-9'-]{2,}/g)
			?.filter((token) => !CLUSTER_STOPWORDS.has(token)) ?? []
	);
}

function buildHeuristicClassification(
	cluster: number,
	points: ClusterArtifactRepresentative[]
): Pick<ClusterSummary, 'label' | 'keywords' | 'summary' | 'labelSource'> {
	const counts = new Map<string, number>();
	for (const point of points) {
		for (const token of tokenize(`${point.title} ${point.preview}`)) {
			counts.set(token, (counts.get(token) ?? 0) + 1);
		}
	}

	const keywords = [...counts.entries()]
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.slice(0, 4)
		.map(([token]) => token);
	const label = keywords.length > 0 ? keywords.slice(0, 2).join(' / ') : `Cluster ${cluster + 1}`;
	const summary =
		keywords.length > 0
			? `Representative threads focus on ${keywords.slice(0, 3).join(', ')}.`
			: 'Representative threads in this cluster share similar wording and structure.';

	return {
		label,
		keywords,
		summary,
		labelSource: 'heuristic'
	};
}

function representativeText(cluster: number, points: ClusterArtifactRepresentative[]): string {
	return points
		.map(
			(point, index) =>
				`Thread ${index + 1} (cluster ${cluster}, ${point.did}): ${point.title}\n${point.text.slice(0, CLUSTER_TEXT_LIMIT)}`
		)
		.join('\n\n');
}

function selectRepresentatives(
	cluster: number,
	memberIndices: number[],
	points: ClusterArtifactPoint[],
	vectors: number[][],
	center: number[]
): ClusterArtifactRepresentative[] {
	const ranked = memberIndices
		.map((index) => ({
			index,
			score: dotProduct(vectors[index], center)
		}))
		.sort((a, b) => {
			if (a.score !== b.score) return b.score - a.score;
			const left = points[a.index];
			const right = points[b.index];
			if (left.depth !== right.depth) return right.depth - left.depth;
			if (left.segmentCount !== right.segmentCount) return right.segmentCount - left.segmentCount;
			if (left.postCount !== right.postCount) return right.postCount - left.postCount;
			if (left.createdAt !== right.createdAt) return right.createdAt.localeCompare(left.createdAt);
			return rootId(left).localeCompare(rootId(right));
		});

	const selected = new Set<number>();
	const selectedDids = new Set<string>();
	const ordered: Array<{ index: number; score: number }> = [];

	for (const candidate of ranked) {
		if (ordered.length >= REPRESENTATIVES_PER_CLUSTER) break;
		const point = points[candidate.index];
		if (selectedDids.has(point.did)) continue;
		selectedDids.add(point.did);
		selected.add(candidate.index);
		ordered.push(candidate);
	}

	for (const candidate of ranked) {
		if (ordered.length >= REPRESENTATIVES_PER_CLUSTER) break;
		if (selected.has(candidate.index)) continue;
		selected.add(candidate.index);
		ordered.push(candidate);
	}

	return ordered.map((candidate) => ({
		...points[candidate.index],
		cluster,
		score: candidate.score
	}));
}

function insertNearest(
	best: Array<{ index: number; distance: number }>,
	index: number,
	distance: number,
	limit: number
) {
	let inserted = false;
	for (let position = 0; position < best.length; position++) {
		if (distance < best[position].distance) {
			best.splice(position, 0, { index, distance });
			inserted = true;
			break;
		}
	}

	if (!inserted && best.length < limit) {
		best.push({ index, distance });
	}

	if (best.length > limit) {
		best.length = limit;
	}
}

function overlapCount(left: number[], right: number[]): number {
	const leftSet = new Set(left);
	let overlap = 0;
	for (const value of right) {
		if (leftSet.has(value)) {
			overlap += 1;
		}
	}
	return overlap;
}

interface ProjectionNeighbor {
	index: number;
	target: number;
	weight: number;
}

function buildProjectionNeighborGraph(vectors: number[][]): {
	neighbors: ProjectionNeighbor[][];
	averageTarget: number;
} {
	const neighbors: ProjectionNeighbor[][] = Array.from({ length: vectors.length }, () => []);
	let totalTarget = 0;
	let totalEdges = 0;

	for (let rowIndex = 0; rowIndex < vectors.length; rowIndex++) {
		const best: Array<{ index: number; distance: number }> = [];
		for (let columnIndex = 0; columnIndex < vectors.length; columnIndex++) {
			if (columnIndex === rowIndex) continue;
			const similarity = clamp(dotProduct(vectors[rowIndex], vectors[columnIndex]), -1, 1);
			insertNearest(best, columnIndex, Math.max(0, 2 - 2 * similarity), PROJECTION_GRAPH_K);
		}

		neighbors[rowIndex] = best.map((entry) => {
			const target = Math.sqrt(Math.max(entry.distance, 1e-9));
			totalTarget += target;
			totalEdges += 1;
			return {
				index: entry.index,
				target,
				weight: 1 / (0.25 + target)
			};
		});
	}

	return {
		neighbors,
		averageTarget: totalEdges > 0 ? totalTarget / totalEdges : 1
	};
}

function refineProjectionCoordinates(
	initialCoordinates: Array<{ x: number; y: number }>,
	neighbors: ProjectionNeighbor[][],
	averageTarget: number
): Array<{ x: number; y: number }> {
	if (initialCoordinates.length <= 1) {
		return initialCoordinates;
	}

	const positions = initialCoordinates.map((point) => ({ x: point.x, y: point.y }));
	const velocities = positions.map(() => ({ x: 0, y: 0 }));
	const repulsionRadius = Math.max(averageTarget * PROJECTION_REPULSION_RADIUS_FACTOR, 1e-4);
	const cellSize = repulsionRadius;
	const repulsionRadiusSquared = repulsionRadius * repulsionRadius;

	for (let iteration = 0; iteration < PROJECTION_REFINE_ITERATIONS; iteration++) {
		const forces = positions.map(() => ({ x: 0, y: 0 }));
		const cooling = 1 - iteration / (PROJECTION_REFINE_ITERATIONS + 1);

		for (let index = 0; index < positions.length; index++) {
			for (const neighbor of neighbors[index] ?? []) {
				const source = positions[index];
				const target = positions[neighbor.index];
				if (!target) continue;
				const dx = target.x - source.x;
				const dy = target.y - source.y;
				const distance = Math.hypot(dx, dy) || 1e-6;
				const force =
					(distance - neighbor.target) *
					neighbor.weight *
					PROJECTION_ATTRACTION *
					cooling;
				const fx = (dx / distance) * force;
				const fy = (dy / distance) * force;
				forces[index].x += fx;
				forces[index].y += fy;
				forces[neighbor.index].x -= fx;
				forces[neighbor.index].y -= fy;
			}
		}

		const grid = new Map<string, number[]>();
		for (let index = 0; index < positions.length; index++) {
			const cellX = Math.floor(positions[index].x / cellSize);
			const cellY = Math.floor(positions[index].y / cellSize);
			const key = `${cellX}:${cellY}`;
			const bucket = grid.get(key);
			if (bucket) {
				bucket.push(index);
			} else {
				grid.set(key, [index]);
			}
		}

		for (let index = 0; index < positions.length; index++) {
			const source = positions[index];
			const cellX = Math.floor(source.x / cellSize);
			const cellY = Math.floor(source.y / cellSize);

			for (let offsetX = -1; offsetX <= 1; offsetX++) {
				for (let offsetY = -1; offsetY <= 1; offsetY++) {
					const bucket = grid.get(`${cellX + offsetX}:${cellY + offsetY}`) ?? [];
					for (const otherIndex of bucket) {
						if (otherIndex <= index) continue;
						const target = positions[otherIndex];
						const dx = target.x - source.x;
						const dy = target.y - source.y;
						const distanceSquared = dx * dx + dy * dy;
						if (distanceSquared <= 1e-12 || distanceSquared > repulsionRadiusSquared) continue;

						const distance = Math.sqrt(distanceSquared);
						const strength =
							((repulsionRadius - distance) / repulsionRadius) *
							PROJECTION_REPULSION *
							cooling;
						const fx = (dx / distance) * strength;
						const fy = (dy / distance) * strength;
						forces[index].x -= fx;
						forces[index].y -= fy;
						forces[otherIndex].x += fx;
						forces[otherIndex].y += fy;
					}
				}
			}
		}

		let meanX = 0;
		let meanY = 0;
		for (let index = 0; index < positions.length; index++) {
			velocities[index].x = (velocities[index].x + forces[index].x) * PROJECTION_DAMPING;
			velocities[index].y = (velocities[index].y + forces[index].y) * PROJECTION_DAMPING;
			positions[index].x += velocities[index].x;
			positions[index].y += velocities[index].y;
			meanX += positions[index].x;
			meanY += positions[index].y;
		}

		meanX /= positions.length;
		meanY /= positions.length;
		for (const position of positions) {
			position.x -= meanX;
			position.y -= meanY;
		}
	}

	return positions;
}

function computeNeighborRecall(
	vectors: number[][],
	coordinates: Array<{ x: number; y: number }>
): number {
	const pointCount = vectors.length;
	if (pointCount <= 2) return 1;

	const neighborLimit = Math.min(PROJECT_NEIGHBOR_K, Math.max(0, pointCount - 1));
	if (neighborLimit <= 0) return 1;

	let totalRecall = 0;
	let compared = 0;

	for (let rowIndex = 0; rowIndex < pointCount; rowIndex++) {
		const originalBest: Array<{ index: number; distance: number }> = [];
		const projectedBest: Array<{ index: number; distance: number }> = [];
		const sourceCoordinate = coordinates[rowIndex] ?? { x: 0, y: 0 };

		for (let columnIndex = 0; columnIndex < pointCount; columnIndex++) {
			if (columnIndex === rowIndex) continue;

			const similarity = clamp(dotProduct(vectors[rowIndex], vectors[columnIndex]), -1, 1);
			insertNearest(originalBest, columnIndex, Math.max(0, 2 - 2 * similarity), neighborLimit);
			const targetCoordinate = coordinates[columnIndex] ?? { x: 0, y: 0 };
			const dx = sourceCoordinate.x - targetCoordinate.x;
			const dy = sourceCoordinate.y - targetCoordinate.y;
			insertNearest(projectedBest, columnIndex, dx * dx + dy * dy, neighborLimit);
		}

		totalRecall +=
			overlapCount(
				originalBest.map((entry) => entry.index),
				projectedBest.map((entry) => entry.index)
			) / neighborLimit;
		compared += 1;
	}

	return compared > 0 ? totalRecall / compared : 1;
}

function attachProjectionToArtifact(
	artifact: ClusteredArtifact,
	coordinates: Array<{ x: number; y: number }>,
	neighborRecall: number,
	regions: AtlasRegionLayout[]
): ClusteredArtifact {
	const coordinateByRoot = new Map(
		artifact.points.map((point, index) => [rootId(point), coordinates[index] ?? { x: 0, y: 0 }])
	);
	const regionByCluster = new Map(regions.map((region) => [region.cluster, region] as const));

	return {
		...artifact,
		points: artifact.points.map((point, index) => ({
			...point,
			x: coordinates[index]?.x ?? 0,
			y: coordinates[index]?.y ?? 0
		})),
			clusters: artifact.clusters.map((cluster) => ({
				...cluster,
				region: regionByCluster.get(cluster.cluster),
				representatives: cluster.representatives.map((representative) => {
					const coordinate = coordinateByRoot.get(rootId(representative)) ?? { x: 0, y: 0 };
					return {
						...representative,
					x: coordinate.x,
					y: coordinate.y
				};
			})
			})),
			projection: {
				method: 'atlas-cluster-relaxed',
				neighborRecall
			}
	};
}

async function mapWithConcurrency<T, R>(
	items: T[],
	limit: number,
	worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
	const results = new Array<R>(items.length);
	let nextIndex = 0;

	async function runWorker() {
		while (true) {
			const currentIndex = nextIndex;
			nextIndex += 1;
			if (currentIndex >= items.length) return;
			results[currentIndex] = await worker(items[currentIndex], currentIndex);
		}
	}

	const workers = new Array(Math.min(limit, items.length)).fill(null).map(() => runWorker());
	await Promise.all(workers);
	return results;
}

function buildClusterArtifact(records: BuildThreadRecord[]): {
	artifact: ClusteredArtifact;
	normalizedVectors: number[][];
	assignments: number[];
	clusterCenters: AtlasClusterCenter[];
} {
	const dedupedByRoot = new Map<string, BuildThreadRecord>();
	for (const record of records) {
		const key = rootId(record);
		const existing = dedupedByRoot.get(key);
		if (!existing) {
			dedupedByRoot.set(key, record);
			continue;
		}
		dedupedByRoot.set(key, choosePreferredRecord(existing, record));
	}

	const orderedRecords = [...dedupedByRoot.values()].sort(
		(a, b) => rootId(a).localeCompare(rootId(b)) || a.createdAt.localeCompare(b.createdAt)
	);
	const firstVector = orderedRecords.find((record) => record.embedding.length > 0)?.embedding;
	const dimension = firstVector?.length ?? 0;
	const filteredRecords = orderedRecords.filter(
		(record) =>
			record.embedding.length === dimension &&
			record.embedding.every((value) => Number.isFinite(value))
	);
	const normalizedVectors = filteredRecords.map((record) => normalizeVector(record.embedding));
	const ids = filteredRecords.map((record) => rootId(record));
	const clusterCount = clusterCountForThreads(filteredRecords.length);
	const { assignments, centers } = kMeansCosine(normalizedVectors, ids, clusterCount);
	const points: ClusterArtifactPoint[] = filteredRecords.map((record, index) => ({
		did: record.did,
		rootUri: record.rootUri,
		createdAt: record.createdAt,
		title: record.title,
		preview: record.preview,
		text: record.text,
		depth: record.depth,
		postCount: record.postCount,
		segmentCount: record.segmentCount,
		cluster: assignments[index] ?? 0
	}));
	const allPeople = new Set(points.map((point) => point.did));
	const clusters: ClusteredArtifactCluster[] = [];

	for (let cluster = 0; cluster < clusterCount; cluster++) {
		const memberIndices = points
			.map((point, index) => ({ point, index }))
			.filter((entry) => entry.point.cluster === cluster)
			.map((entry) => entry.index);
		if (memberIndices.length === 0) continue;

		const representatives = selectRepresentatives(
			cluster,
			memberIndices,
			points,
			normalizedVectors,
			centers[cluster] ?? normalizedVectors[memberIndices[0]]
		);
		clusters.push({
			cluster,
			threadCount: memberIndices.length,
			peopleCount: new Set(memberIndices.map((index) => points[index].did)).size,
			representatives,
			classificationText: representativeText(cluster, representatives)
		});
	}

	clusters.sort((a, b) => b.threadCount - a.threadCount || a.cluster - b.cluster);
	return {
		artifact: {
			generatedAt: new Date().toISOString(),
			points,
			clusters,
			totalThreads: points.length,
			totalPeople: allPeople.size
		},
		normalizedVectors,
		assignments,
		clusterCenters: clusters
			.map((cluster) => ({
				cluster: cluster.cluster,
				center: centers[cluster.cluster] ?? [],
				threadCount: cluster.threadCount
			}))
			.sort((left, right) => left.cluster - right.cluster)
	};
}

async function buildSemanticLabels(
	storage: ClusterStorage,
	artifact: ClusteredArtifact,
	fetchEnabled: boolean,
	apiKey: string | undefined,
	log: (message: string) => void
): Promise<{
	semanticModel: string;
	semanticByCluster: Map<number, SemanticLabel>;
}> {
	const classificationInputs = artifact.clusters
		.map((cluster) => ({
			cluster: cluster.cluster,
			text: cluster.classificationText
		}))
		.filter((cluster) => cluster.text.trim().length > 0);

	let semanticModel = `${classificationModel()} (heuristic)`;
	let semanticByCluster = new Map<number, SemanticLabel>();

	if (classificationInputs.length === 0) {
		return { semanticModel, semanticByCluster };
	}

	const signature = await buildClassificationSignature(classificationInputs);
	const cacheKey = globalClassificationCacheKey(signature, CLUSTER_CLASSIFICATION_CACHE_VERSION);
	const cached = await readCachedClassificationFromStorage(storage, cacheKey);
	let resolved = cached;

	if (!resolved && fetchEnabled && apiKey) {
		log('Requesting semantic cluster labels from Gemini.');
		try {
			resolved = await requestSemanticClassification(
				apiKey,
				buildClassificationPrompt(classificationInputs),
				{ model: classificationModel() }
			);
			await writeCachedClassificationToStorage(storage, cacheKey, resolved);
		} catch (error: any) {
			log(
				`Gemini labeling failed for cluster snapshot; falling back to heuristic labels. ${error?.message || ''}`.trim()
			);
		}
	}

	if (resolved) {
		semanticModel = resolved.model;
		semanticByCluster = new Map(
			resolved.classifications.map((item) => [
				item.cluster,
				{
					label: item.label,
					keywords: item.keywords,
					summary: item.summary
				}
			])
		);
	} else if (!fetchEnabled) {
		semanticModel = `${classificationModel()} (fetch-disabled)`;
	} else if (!apiKey) {
		semanticModel = `${classificationModel()} (api-key-missing)`;
	} else {
		semanticModel = `${classificationModel()} (heuristic-fallback)`;
	}

	return { semanticModel, semanticByCluster };
}

function buildSnapshot(
	artifact: ClusteredArtifact,
	semanticModel: string,
	semanticByCluster: Map<number, SemanticLabel>
): ClusterSnapshot {
	const clusters: ClusterSummary[] = artifact.clusters.map((cluster) => {
		const fallbackRegion = {
			x:
				cluster.representatives.reduce((sum, representative) => sum + (representative.x ?? 0), 0) /
				Math.max(1, cluster.representatives.length),
			y:
				cluster.representatives.reduce((sum, representative) => sum + (representative.y ?? 0), 0) /
				Math.max(1, cluster.representatives.length),
			radiusX: 0.24,
			radiusY: 0.18,
			angle: 0,
			labelRank: cluster.cluster + 1
		};
		const region = cluster.region ?? fallbackRegion;
		const semantic = semanticByCluster.get(cluster.cluster);
		if (semantic) {
			return {
				cluster: cluster.cluster,
				label: semantic.label,
				keywords: semantic.keywords,
				summary: semantic.summary,
				labelSource: 'flash',
				threadCount: cluster.threadCount,
				peopleCount: cluster.peopleCount,
				region,
				representatives: cluster.representatives.map((representative) => ({
					did: representative.did,
					rootUri: representative.rootUri,
					createdAt: representative.createdAt,
					title: representative.title,
					preview: representative.preview,
					depth: representative.depth,
					postCount: representative.postCount,
					segmentCount: representative.segmentCount,
					cluster: representative.cluster,
					x: representative.x ?? 0,
					y: representative.y ?? 0,
					score: representative.score
				}))
			};
		}

		const heuristic = buildHeuristicClassification(cluster.cluster, cluster.representatives);
		return {
			cluster: cluster.cluster,
			label: heuristic.label,
			keywords: heuristic.keywords,
				summary: heuristic.summary,
				labelSource: heuristic.labelSource,
				threadCount: cluster.threadCount,
				peopleCount: cluster.peopleCount,
				region,
				representatives: cluster.representatives.map((representative) => ({
					did: representative.did,
					rootUri: representative.rootUri,
				createdAt: representative.createdAt,
				title: representative.title,
				preview: representative.preview,
				depth: representative.depth,
				postCount: representative.postCount,
				segmentCount: representative.segmentCount,
				cluster: representative.cluster,
				x: representative.x ?? 0,
				y: representative.y ?? 0,
				score: representative.score
			}))
		};
	});

	return {
		meta: {
			generatedAt: new Date().toISOString(),
			model: EMBEDDING_MODEL_LABEL,
			analysisVersion: ANALYSIS_CACHE_VERSION,
			embeddingNamespace: EMBEDDING_CACHE_NAMESPACE,
			snapshotMaxPosts: SNAPSHOT_MAX_POSTS,
			totalThreads: artifact.totalThreads,
			totalPeople: artifact.totalPeople,
			clusterCount: clusters.length,
			representativesPerCluster: REPRESENTATIVES_PER_CLUSTER,
			classificationModel: semanticModel,
			projectionMethod: artifact.projection?.method ?? 'mds-cosine',
			projectionNeighborRecall: artifact.projection?.neighborRecall ?? 0,
			buildMode: 'build-once'
		},
		points: artifact.points.map((point) => ({
			did: point.did,
			rootUri: point.rootUri,
			cluster: point.cluster,
			x: point.x ?? 0,
			y: point.y ?? 0
		})),
		clusters
	};
}

function buildOverview(snapshot: ClusterSnapshot): ClusterOverview {
	return {
		meta: snapshot.meta,
		clusters: snapshot.clusters
	};
}

function throwIfAborted(
	phase: ClusterBuildProgress['phase'],
	shouldAbort?: () => string | null
): void {
	const reason = shouldAbort?.();
	if (reason) {
		throw new ClusterBuildError(phase, reason);
	}
}

async function failBuild(
	storage: ClusterStorage,
	phase: ClusterBuildProgress['phase'],
	error: unknown
): Promise<never> {
	const message = error instanceof Error ? error.message : 'Cluster snapshot build failed.';
	const details = error instanceof ClusterBuildError ? error.details : error instanceof Error ? error.stack : undefined;
	await writeFailure(storage, {
		phase,
		message,
		updatedAt: new Date().toISOString(),
		details
	});
	await clearBuildState(storage);
	throw error;
}

export async function buildOfflineClusterSnapshot(
	options: OfflineClusterBuildOptions
): Promise<ClusterSnapshot> {
	const storage = options.storage;
	const log = options.log ?? (() => undefined);
	const fetchEnabled = options.fetchEnabled !== false;
	let phase: ClusterBuildProgress['phase'] = 'scan';
	let state = buildInitialState();

	try {
		await clearFailure(storage);
		await clearBuildState(storage);
		await deleteByPrefix(storage, LEGACY_BUILD_PREFIX);
		await writeBuildState(storage, state);
		log('Scanning cached analyzer batches from R2.');

		const records: BuildThreadRecord[] = [];
		const seenPeople = new Set<string>();
		let cursor: string | undefined;
		let pageIndex = 0;
		let objectsProcessed = 0;
		let threadsProcessed = 0;

		while (true) {
			throwIfAborted('scan', options.shouldAbort);
			const listing = await storage.list(ANALYSIS_PREFIX, {
				cursor,
				limit: ANALYSIS_LIST_LIMIT
			});
			const matching = listing.objects.filter((object) => parseAnalysisKey(object.key) !== null);
			const batches = await mapWithConcurrency(matching, 8, async (object) => {
				const parsed = parseAnalysisKey(object.key);
				if (!parsed) return [] as BuildThreadRecord[];
				const text = await storage.getText(object.key);
				if (!text) return [] as BuildThreadRecord[];
				try {
					const payload = JSON.parse(text);
					return extractBuildRecordsFromBatch(payload, parsed.did);
				} catch {
					return [] as BuildThreadRecord[];
				}
			});

			for (const batch of batches) {
				for (const record of batch) {
					records.push(record);
					seenPeople.add(record.did);
				}
				threadsProcessed += batch.length;
			}

			objectsProcessed += listing.objects.length;
			pageIndex += 1;
			cursor = listing.truncated && listing.cursor ? listing.cursor : undefined;
			state = {
				...state,
				phase: 'scan',
				updatedAt: new Date().toISOString(),
				scan: {
					cursor,
					pageIndex,
					objectsProcessed,
					threadsProcessed,
					seenPeople: [...seenPeople].sort((a, b) => a.localeCompare(b)),
					hasMore: Boolean(cursor)
				}
			};
			await writeBuildState(storage, state);
			if (!cursor) break;
		}

		phase = 'cluster';
		throwIfAborted(phase, options.shouldAbort);
		log(`Clustering ${records.length} cached threads.`);
		state = {
			...state,
			phase,
			updatedAt: new Date().toISOString()
		};
		await writeBuildState(storage, state);
			const { artifact: clusteredArtifact, normalizedVectors, assignments, clusterCenters } =
				buildClusterArtifact(records);
		state = {
			...state,
			phase,
			updatedAt: new Date().toISOString(),
			cluster: {
				totalThreads: clusteredArtifact.totalThreads,
				totalPeople: clusteredArtifact.totalPeople,
				clusterCount: clusteredArtifact.clusters.length
			}
		};
		await writeBuildState(storage, state);

		phase = 'project';
		throwIfAborted(phase, options.shouldAbort);
		log('Projecting normalized embeddings into 2D.');
		state = {
			...state,
			phase,
			updatedAt: new Date().toISOString()
		};
		await writeBuildState(storage, state);
			const coordinates = projectEmbeddingsRaw(normalizedVectors);
			log('Refining local neighborhoods in projection space.');
			const { neighbors, averageTarget } = buildProjectionNeighborGraph(normalizedVectors);
			const refinedCoordinates = normalizeProjectionCoordinates(
				refineProjectionCoordinates(coordinates, neighbors, averageTarget)
			);
			log('Spreading semantic clusters into stable atlas regions.');
			const atlasLayout = buildAtlasClusterLayout(
				refinedCoordinates,
				assignments,
				clusterCenters,
				normalizedVectors
			);
			const projectedArtifact = attachProjectionToArtifact(
				clusteredArtifact,
				atlasLayout.coordinates,
				computeNeighborRecall(normalizedVectors, atlasLayout.coordinates),
				atlasLayout.regions
			);

		phase = 'classify';
		throwIfAborted(phase, options.shouldAbort);
		log('Resolving cluster labels.');
		state = {
			...state,
			phase,
			updatedAt: new Date().toISOString(),
			cluster: {
				totalThreads: projectedArtifact.totalThreads,
				totalPeople: projectedArtifact.totalPeople,
				clusterCount: projectedArtifact.clusters.length
			}
		};
		await writeBuildState(storage, state);
		const { semanticModel, semanticByCluster } = await buildSemanticLabels(
			storage,
			projectedArtifact,
			fetchEnabled,
			options.apiKey,
			log
		);
		const snapshot = buildSnapshot(projectedArtifact, semanticModel, semanticByCluster);

		phase = 'upload';
		throwIfAborted(phase, options.shouldAbort);
		log('Uploading cluster snapshot and metadata to R2.');
		state = {
			...state,
			phase,
			updatedAt: new Date().toISOString(),
			cluster: {
				totalThreads: snapshot.meta.totalThreads,
				totalPeople: snapshot.meta.totalPeople,
				clusterCount: snapshot.meta.clusterCount
			}
		};
		await writeBuildState(storage, state);
		await putJson(storage, SNAPSHOT_KEY, snapshot);
		await putJson(storage, OVERVIEW_KEY, buildOverview(snapshot));
		await putJson(storage, POINTS_KEY, snapshot.points);
		await putJson(storage, META_KEY, snapshot.meta);
		await clearBuildState(storage);
		await clearFailure(storage);
		await deleteByPrefix(storage, LEGACY_BUILD_PREFIX);
		log(`Cluster snapshot is ready at ${SNAPSHOT_KEY}.`);
		return snapshot;
	} catch (error) {
		return await failBuild(storage, phase, error);
	}
}

export async function resolveClusterApiResponse(storage: ClusterStorage): Promise<ClusterApiResponse> {
	const [buildState, failure, hasOverview, hasPoints] = await Promise.all([
		readBuildState(storage),
		readFailure(storage),
		storage.has(OVERVIEW_KEY),
		storage.has(POINTS_KEY)
	]);

	if (buildState) {
		return jsonResponse({
			status: 'building',
			progress: toBuildProgress(buildState)
		});
	}

	if (failure) {
		return jsonResponse({
			status: 'failed',
			failure
		});
	}

	if (hasOverview && hasPoints) {
		return jsonResponse({
			status: 'ready'
		});
	}

	return jsonResponse({ status: 'missing' });
}
