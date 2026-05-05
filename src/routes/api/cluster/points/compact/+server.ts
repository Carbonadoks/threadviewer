import type { RequestHandler } from '@sveltejs/kit';
import type { ClusterPoint } from '$lib/types';
import { POINTS_KEY } from '$lib/server/clusterSnapshot';
import { normalizeProjectionCoordinates } from '$lib/utils/clusterProjection';
import { encodeCompactClusterPoints } from '$lib/utils/clusterPointsCompact';

const COMPACT_POINTS_CACHE_CONTROL =
	'public, max-age=300, s-maxage=86400, stale-while-revalidate=86400';
const COMPACT_POINTS_VERSION = 'compact-v2';

function derivedCompactEtag(sourceEtag: string | null | undefined): string {
	const normalized = (sourceEtag ?? '').trim();
	if (!normalized) {
		return `"${COMPACT_POINTS_VERSION}"`;
	}

	const weakPrefix = normalized.startsWith('W/') ? 'W/' : '';
	const rawValue = normalized.replace(/^W\//, '').replace(/^"+|"+$/g, '');
	return `${weakPrefix}"${rawValue}-${COMPACT_POINTS_VERSION}"`;
}

function ifNoneMatchIncludes(headerValue: string | null, etag: string): boolean {
	if (!headerValue) return false;
	return headerValue
		.split(',')
		.map((value) => value.trim())
		.some((candidate) => candidate === '*' || candidate === etag);
}

function buildCacheKey(request: Request, etag: string): Request {
	const url = new URL(request.url);
	url.searchParams.set('__compactEtag', etag);
	return new Request(url.toString(), {
		method: 'GET'
	});
}

function resolveDefaultCache(): Cache | null {
	const runtimeCaches = (globalThis as typeof globalThis & {
		caches?: CacheStorage & { default?: Cache };
	}).caches;
	return runtimeCaches?.default ?? null;
}

function buildCompactResponse(payload: ArrayBuffer, etag: string): Response {
	return new Response(payload, {
		status: 200,
		headers: {
			'Content-Type': 'application/octet-stream',
			'Content-Length': String(payload.byteLength),
			'Cache-Control': COMPACT_POINTS_CACHE_CONTROL,
			'ETag': etag,
			'X-Cluster-Points-Format': COMPACT_POINTS_VERSION
		}
	});
}

export const GET: RequestHandler = async ({ platform, request }) => {
	const bucket = platform?.env?.POST_CACHE;
	if (!bucket) {
		return new Response('Cluster points bucket is unavailable.', {
			status: 503,
			headers: {
				'Content-Type': 'text/plain; charset=utf-8',
				'Cache-Control': 'no-store'
			}
		});
	}

	const object = await bucket.get(POINTS_KEY);
	if (!object) {
		return new Response('Cluster points not found.', {
			status: 404,
			headers: {
				'Content-Type': 'text/plain; charset=utf-8',
				'Cache-Control': 'no-store'
			}
		});
	}

	const compactEtag = derivedCompactEtag(object.httpEtag);
	if (ifNoneMatchIncludes(request.headers.get('if-none-match'), compactEtag)) {
		return new Response(null, {
			status: 304,
			headers: {
				'Cache-Control': COMPACT_POINTS_CACHE_CONTROL,
				ETag: compactEtag,
				'X-Cluster-Points-Format': COMPACT_POINTS_VERSION
			}
		});
	}

	const cache = resolveDefaultCache();
	const cacheKey = buildCacheKey(request, compactEtag);
	if (cache) {
		const cached = await cache.match(cacheKey);
		if (cached) {
			return new Response(cached.body, {
				status: cached.status,
				headers: cached.headers
			});
		}
	}

	let parsed: ClusterPoint[];
	try {
		const text = await object.text();
		const payload = JSON.parse(text) as unknown;
		if (!Array.isArray(payload)) {
			throw new Error('Cluster points payload is not an array.');
		}
		parsed = payload as ClusterPoint[];
	} catch {
		return new Response('Cluster points payload is malformed.', {
			status: 500,
			headers: {
				'Content-Type': 'text/plain; charset=utf-8',
				'Cache-Control': 'no-store'
			}
		});
	}

	const normalizedCoordinates = normalizeProjectionCoordinates(
		parsed.map((point) => ({
			x: point.x ?? 0,
			y: point.y ?? 0
		}))
	);
	const normalizedPoints = parsed.map((point, index) => ({
		...point,
		x: normalizedCoordinates[index]?.x ?? 0,
		y: normalizedCoordinates[index]?.y ?? 0
	}));

	const response = buildCompactResponse(encodeCompactClusterPoints(normalizedPoints), compactEtag);
	if (cache && platform?.context) {
		platform.context.waitUntil(cache.put(cacheKey, response.clone()));
	}
	return response;
};
