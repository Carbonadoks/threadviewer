import type { RequestHandler } from '@sveltejs/kit';
import type { ClusterPoint } from '$lib/types';
import { POINTS_KEY } from '$lib/server/toponomySnapshot';
import { normalizeProjectionCoordinates } from '$lib/utils/clusterProjection';
import { encodeCompactClusterPoints } from '$lib/utils/clusterPointsCompact';

const COMPACT_POINTS_CACHE_CONTROL = 'no-store';
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
		return new Response('Toponomy points bucket is unavailable.', {
			status: 503,
			headers: {
				'Content-Type': 'text/plain; charset=utf-8',
				'Cache-Control': 'no-store'
			}
		});
	}

	const object = await bucket.get(POINTS_KEY);
	if (!object) {
		return new Response('Toponomy points not found.', {
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

	let parsed: ClusterPoint[];
	try {
		const text = await object.text();
		const payload = JSON.parse(text) as unknown;
		if (!Array.isArray(payload)) {
			throw new Error('Toponomy points payload is not an array.');
		}
		parsed = payload as ClusterPoint[];
	} catch {
		return new Response('Toponomy points payload is malformed.', {
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

	return buildCompactResponse(encodeCompactClusterPoints(normalizedPoints), compactEtag);
};
