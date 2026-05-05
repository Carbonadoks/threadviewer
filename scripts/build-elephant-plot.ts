import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import {
	DeleteObjectCommand,
	GetObjectCommand,
	HeadObjectCommand,
	ListObjectsV2Command,
	PutObjectCommand,
	S3Client,
	type GetObjectCommandOutput
} from '@aws-sdk/client-s3';
import type { ClusterStorage } from '../src/lib/server/clusterSnapshot';
import {
	ANALYSIS_CACHE_VERSION,
	EMBEDDING_CACHE_NAMESPACE,
	SNAPSHOT_MAX_POSTS
} from '../src/lib/server/clusterSnapshot';
import { normalizeVector } from '../src/lib/utils/threadAnalysis';
import {
	reduceEmbeddingsWithUmap,
	clusterReducedCoordinates,
	buildFuzzyNeighborGraph
} from '../src/lib/utils/toponomyUmap';
import { sampleElephantTargets } from '../src/lib/utils/elephantShape';
import { picassoLayout } from '../src/lib/utils/picasso';
import { normalizeProjectionCoordinates } from '../src/lib/utils/clusterProjection';

const DEFAULT_BUCKET = 'thread-viewer-cache';
const ENV_PATH = path.resolve(process.cwd(), '.env.cluster.local');
const OUTPUT_DIR = path.resolve(process.cwd(), 'output');

const ANALYSIS_PREFIX = `analysis/${ANALYSIS_CACHE_VERSION}/${EMBEDDING_CACHE_NAMESPACE}/`;
const ANALYSIS_POSTS_KEY = `posts-${SNAPSHOT_MAX_POSTS}`;
const ANALYSIS_LIST_LIMIT = 100;

type EnvMap = Record<string, string>;

function parseEnvFile(text: string): EnvMap {
	const env: EnvMap = {};
	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith('#')) continue;
		const separatorIndex = line.indexOf('=');
		if (separatorIndex <= 0) continue;
		const key = line.slice(0, separatorIndex).trim();
		let value = line.slice(separatorIndex + 1).trim();
		if (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		) {
			value = value.slice(1, -1);
		}
		env[key] = value;
	}
	return env;
}

async function loadLocalEnv(envPath: string): Promise<EnvMap> {
	try {
		return parseEnvFile(await readFile(envPath, 'utf8'));
	} catch (error: any) {
		if (error?.code === 'ENOENT') return {};
		throw error;
	}
}

function readConfigValue(localEnv: EnvMap, key: string, fallback = ''): string {
	return process.env[key]?.trim() || localEnv[key]?.trim() || fallback;
}

function requireConfig(localEnv: EnvMap, key: string): string {
	const value = readConfigValue(localEnv, key);
	if (!value) throw new Error(`Missing required config: ${key}`);
	return value;
}

async function bodyToString(body: GetObjectCommandOutput['Body']): Promise<string> {
	if (!body) return '';
	if (typeof (body as any).transformToString === 'function') {
		return (body as any).transformToString();
	}
	const chunks: Buffer[] = [];
	for await (const chunk of body as AsyncIterable<Uint8Array | string>) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	}
	return Buffer.concat(chunks).toString('utf8');
}

function isMissingError(error: unknown): boolean {
	return (
		(error as any)?.name === 'NoSuchKey' ||
		(error as any)?.$metadata?.httpStatusCode === 404 ||
		(error as any)?.Code === 'NoSuchKey'
	);
}

function createS3ClusterStorage(client: S3Client, bucket: string): ClusterStorage {
	return {
		async list(prefix, options = {}) {
			const response = await client.send(
				new ListObjectsV2Command({
					Bucket: bucket,
					Prefix: prefix,
					ContinuationToken: options.cursor,
					MaxKeys: options.limit
				})
			);
			return {
				objects: (response.Contents ?? [])
					.map((item) => item.Key)
					.filter((key): key is string => typeof key === 'string' && key.length > 0)
					.map((key) => ({ key })),
				truncated: Boolean(response.IsTruncated),
				cursor: response.NextContinuationToken
			};
		},
		async has(key) {
			try {
				await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
				return true;
			} catch (error) {
				if (isMissingError(error)) return false;
				throw error;
			}
		},
		async getText(key) {
			try {
				const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
				return bodyToString(response.Body);
			} catch (error) {
				if (isMissingError(error)) return null;
				throw error;
			}
		},
		async putText(key, value, options = {}) {
			await client.send(
				new PutObjectCommand({
					Bucket: bucket,
					Key: key,
					Body: value,
					ContentType: options.contentType ?? 'application/json'
				})
			);
		},
		async delete(key) {
			await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
		}
	};
}

interface BuildThreadRecord {
	did: string;
	rootUri: string;
	title: string;
	preview: string;
	embedding: number[];
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

function parseVector(value: unknown): number[] | null {
	if (!Array.isArray(value) || value.length === 0) return null;
	const vector = value.map((item) => Number(item));
	if (vector.some((item) => !Number.isFinite(item))) return null;
	return vector;
}

function extractRecordsFromBatch(payload: any, did: string): BuildThreadRecord[] {
	const threads = Array.isArray(payload?.batch?.threads) ? payload.batch.threads : [];
	const records: BuildThreadRecord[] = [];
	for (const thread of threads) {
		const rootUri = typeof thread?.rootUri === 'string' ? thread.rootUri.trim() : '';
		const embedding = parseVector(thread?.embedding);
		if (!rootUri || !embedding) continue;
		const title = typeof thread?.title === 'string' ? thread.title.trim() : '';
		const preview = typeof thread?.preview === 'string' ? thread.preview.trim() : '';
		records.push({ did, rootUri, title: title || preview || 'Untitled', preview: preview || title, embedding });
	}
	return records;
}

async function mapWithConcurrency<T, R>(
	items: T[],
	limit: number,
	worker: (item: T) => Promise<R>
): Promise<R[]> {
	const results = new Array<R>(items.length);
	let nextIndex = 0;
	async function runWorker() {
		while (true) {
			const i = nextIndex++;
			if (i >= items.length) return;
			results[i] = await worker(items[i]);
		}
	}
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => runWorker()));
	return results;
}

async function scanAllRecords(storage: ClusterStorage, log: (m: string) => void): Promise<BuildThreadRecord[]> {
	const records: BuildThreadRecord[] = [];
	let cursor: string | undefined;
	let page = 0;

	while (true) {
		const listing = await storage.list(ANALYSIS_PREFIX, { cursor, limit: ANALYSIS_LIST_LIMIT });
		const matching = listing.objects.filter((o) => parseAnalysisKey(o.key) !== null);

		const batches = await mapWithConcurrency(matching, 8, async (object) => {
			const parsed = parseAnalysisKey(object.key);
			if (!parsed) return [] as BuildThreadRecord[];
			const text = await storage.getText(object.key);
			if (!text) return [] as BuildThreadRecord[];
			try {
				return extractRecordsFromBatch(JSON.parse(text), parsed.did);
			} catch {
				return [] as BuildThreadRecord[];
			}
		});

		for (const batch of batches) records.push(...batch);
		page++;
		cursor = listing.truncated && listing.cursor ? listing.cursor : undefined;
		if (!cursor) break;
	}

	log(`Scanned ${page} pages, found ${records.length} thread records.`);
	return records;
}

function deduplicateRecords(records: BuildThreadRecord[]): {
	records: BuildThreadRecord[];
	ids: string[];
	normalizedVectors: number[][];
} {
	const byRoot = new Map<string, BuildThreadRecord>();
	for (const r of records) {
		const key = `${r.did}:${r.rootUri}`;
		if (!byRoot.has(key)) byRoot.set(key, r);
	}
	const ordered = [...byRoot.values()].sort((a, b) =>
		`${a.did}:${a.rootUri}`.localeCompare(`${b.did}:${b.rootUri}`)
	);
	const dim = ordered.find((r) => r.embedding.length > 0)?.embedding.length ?? 0;
	const filtered = ordered.filter(
		(r) => r.embedding.length === dim && r.embedding.every((v) => Number.isFinite(v))
	);
	return {
		records: filtered,
		ids: filtered.map((r) => `${r.did}:${r.rootUri}`),
		normalizedVectors: filtered.map((r) => normalizeVector(r.embedding))
	};
}

// 10-NN recall metric between high-D and 2D neighbors
function computeNeighborRecall(
	vectors: number[][],
	coords: Array<{ x: number; y: number }>,
	k = 10
): number {
	const n = vectors.length;
	if (n <= 2) return 1;
	const limit = Math.min(k, n - 1);
	if (limit <= 0) return 1;

	let totalRecall = 0;
	for (let i = 0; i < n; i++) {
		const hdNeighbors: Array<{ idx: number; d: number }> = [];
		const ldNeighbors: Array<{ idx: number; d: number }> = [];
		for (let j = 0; j < n; j++) {
			if (j === i) continue;
			let dot = 0;
			for (let d = 0; d < vectors[i].length; d++) dot += vectors[i][d] * vectors[j][d];
			const hdDist = Math.max(0, 2 - 2 * Math.min(1, Math.max(-1, dot)));
			hdNeighbors.push({ idx: j, d: hdDist });

			const dx = coords[i].x - coords[j].x;
			const dy = coords[i].y - coords[j].y;
			ldNeighbors.push({ idx: j, d: dx * dx + dy * dy });
		}
		hdNeighbors.sort((a, b) => a.d - b.d);
		ldNeighbors.sort((a, b) => a.d - b.d);
		const hdSet = new Set(hdNeighbors.slice(0, limit).map((x) => x.idx));
		let overlap = 0;
		for (const nb of ldNeighbors.slice(0, limit)) {
			if (hdSet.has(nb.idx)) overlap++;
		}
		totalRecall += overlap / limit;
	}
	return totalRecall / n;
}

const CLUSTER_COLORS = [
	'#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4',
	'#42d4f4', '#f032e6', '#bfef45', '#fabed4', '#469990',
	'#dcbeff', '#9A6324', '#fffac8', '#800000', '#aaffc3',
	'#808000', '#ffd8b1', '#000075', '#a9a9a9', '#000000'
];

function generateHtml(
	points: Array<{ x: number; y: number; cluster: number; did: string; rootUri: string; title: string }>,
	meta: { pointCount: number; frac: number; neighborRecall: number; clusterCount: number }
): string {
	const svgWidth = 900;
	const svgHeight = 700;
	const padding = 40;

	let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
	for (const p of points) {
		if (p.x < minX) minX = p.x;
		if (p.x > maxX) maxX = p.x;
		if (p.y < minY) minY = p.y;
		if (p.y > maxY) maxY = p.y;
	}
	const rangeX = maxX - minX || 1;
	const rangeY = maxY - minY || 1;

	function toSvgX(x: number): number {
		return padding + ((x - minX) / rangeX) * (svgWidth - 2 * padding);
	}
	function toSvgY(y: number): number {
		return padding + ((y - minY) / rangeY) * (svgHeight - 2 * padding);
	}

	const circles = points
		.map((p) => {
			const sx = toSvgX(p.x).toFixed(1);
			const sy = toSvgY(p.y).toFixed(1);
			const color = CLUSTER_COLORS[p.cluster % CLUSTER_COLORS.length];
			const escapedTitle = p.title.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
			const escapedDid = p.did.replace(/&/g, '&amp;').replace(/</g, '&lt;');
			return `<circle cx="${sx}" cy="${sy}" r="3.5" fill="${color}" opacity="0.75" stroke="#fff" stroke-width="0.5"><title>${escapedDid}\n${escapedTitle}</title></circle>`;
		})
		.join('\n    ');

	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Elephant Plot – Picasso Visualization</title>
<style>
  body { margin: 0; display: flex; flex-direction: column; align-items: center; background: #1a1a2e; color: #e0e0e0; font-family: system-ui, sans-serif; }
  h1 { margin: 1rem 0 0.25rem; font-size: 1.4rem; }
  .meta { font-size: 0.85rem; color: #999; margin-bottom: 0.5rem; }
  svg { background: #16213e; border-radius: 8px; box-shadow: 0 2px 12px rgba(0,0,0,0.4); }
  circle:hover { r: 6; opacity: 1; stroke-width: 1.5; cursor: pointer; }
</style>
</head>
<body>
<h1>Elephant Plot</h1>
<p class="meta">${meta.pointCount} threads &middot; ${meta.clusterCount} clusters &middot; frac=${meta.frac} &middot; ${Math.round(meta.neighborRecall * 100)}% 10-NN recall</p>
<svg width="${svgWidth}" height="${svgHeight}" xmlns="http://www.w3.org/2000/svg">
    ${circles}
</svg>
</body>
</html>`;
}

async function main() {
	console.log('Elephant Plot Builder');
	console.log('Run with: npm run elephant:build\n');

	const localEnv = await loadLocalEnv(ENV_PATH);
	if (Object.keys(localEnv).length > 0) {
		console.log(`Loaded config from ${ENV_PATH}`);
	}

	const accountId = requireConfig(localEnv, 'CLUSTER_R2_ACCOUNT_ID');
	const accessKeyId = requireConfig(localEnv, 'CLUSTER_R2_ACCESS_KEY_ID');
	const secretAccessKey = requireConfig(localEnv, 'CLUSTER_R2_SECRET_ACCESS_KEY');
	const bucket = readConfigValue(localEnv, 'CLUSTER_R2_BUCKET', DEFAULT_BUCKET);
	const frac = parseFloat(readConfigValue(localEnv, 'ELEPHANT_FRAC', '0.8'));

	const client = new S3Client({
		region: 'auto',
		endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
		credentials: { accessKeyId, secretAccessKey }
	});
	const storage = createS3ClusterStorage(client, bucket);
	const log = (m: string) => console.log(`  ${m}`);

	try {
		// 1. Scan and prepare embeddings
		log('Scanning cached analyzer batches from R2...');
		const rawRecords = await scanAllRecords(storage, log);
		if (rawRecords.length === 0) {
			console.error('No thread records found in R2. Run the analyzer first.');
			process.exitCode = 1;
			return;
		}

		const prepared = deduplicateRecords(rawRecords);
		log(`Prepared ${prepared.records.length} deduplicated threads.`);

		// 2. Run UMAP to get initial 2D layout
		log('Running UMAP reduction for initial layout...');
		const initialCoords = reduceEmbeddingsWithUmap(prepared.normalizedVectors);
		log(`UMAP produced ${initialCoords.length} coordinates.`);

		// 3. Build fuzzy neighbor graph for structure edges
		log('Building fuzzy neighbor graph...');
		const graph = buildFuzzyNeighborGraph(prepared.normalizedVectors);

		// 4. Sample elephant targets
		const elephantTargets = sampleElephantTargets(prepared.records.length);
		log(`Sampled ${elephantTargets.length} elephant target points.`);

		// 5. Run Picasso layout
		log(`Running Picasso layout (frac=${frac})...`);
		const finalCoords = picassoLayout(initialCoords, elephantTargets, graph.edges, { frac });
		log('Picasso layout complete.');

		// 6. Normalize final coordinates
		const normalized = normalizeProjectionCoordinates(finalCoords);

		// 7. Cluster the final positions
		const clusterCount = Math.max(2, Math.min(12, Math.round(Math.sqrt(prepared.records.length / 18))));
		const { assignments } = clusterReducedCoordinates(normalized, prepared.ids, clusterCount);

		// 8. Compute neighbor recall
		const recall = computeNeighborRecall(prepared.normalizedVectors, normalized);
		log(`10-NN neighbor recall: ${Math.round(recall * 100)}%`);

		// 9. Build points array for HTML
		const htmlPoints = prepared.records.map((r, i) => ({
			x: normalized[i].x,
			y: normalized[i].y,
			cluster: assignments[i],
			did: r.did,
			rootUri: r.rootUri,
			title: r.title
		}));

		// 10. Generate and write HTML
		const html = generateHtml(htmlPoints, {
			pointCount: htmlPoints.length,
			frac,
			neighborRecall: recall,
			clusterCount
		});

		await mkdir(OUTPUT_DIR, { recursive: true });
		const outputPath = path.join(OUTPUT_DIR, 'elephant-plot.html');
		await writeFile(outputPath, html, 'utf8');
		console.log(`\nElephant plot written to ${outputPath}`);
		process.exitCode = 0;
	} catch (error: any) {
		console.error(error?.message || 'Elephant plot build failed.');
		if (error?.stack) console.error(error.stack);
		process.exitCode = 1;
	} finally {
		client.destroy();
	}
}

void main();
