import type { ClusterPoint } from '$lib/types';

const UINT32_SIZE = 4;
const FLOAT32_SIZE = 4;

export interface CompactClusterPointColumns {
	count: number;
	clusters: Uint32Array;
	x: Float32Array;
	y: Float32Array;
	rootUriOffsets: Uint32Array;
	rootUriBytes: Uint8Array;
}

export interface CompactClusterPointStore extends CompactClusterPointColumns {
	decodeRootUri(index: number): string;
}

function assertPointIndex(count: number, index: number): void {
	if (!Number.isInteger(index) || index < 0 || index >= count) {
		throw new RangeError(`Point index ${index} is out of bounds for ${count} points.`);
	}
}

export function encodeCompactClusterPoints(points: ClusterPoint[]): ArrayBuffer {
	const encoder = new TextEncoder();
	const encodedUris = points.map((point) => encoder.encode(point.rootUri));
	const totalUriBytes = encodedUris.reduce((total, value) => total + value.byteLength, 0);
	const count = points.length;
	const totalBytes =
		UINT32_SIZE +
		UINT32_SIZE * count +
		FLOAT32_SIZE * count +
		FLOAT32_SIZE * count +
		UINT32_SIZE * (count + 1) +
		totalUriBytes;
	const buffer = new ArrayBuffer(totalBytes);
	const view = new DataView(buffer);

	let offset = 0;
	view.setUint32(offset, count, true);
	offset += UINT32_SIZE;

	const clusters = new Uint32Array(buffer, offset, count);
	offset += UINT32_SIZE * count;

	const x = new Float32Array(buffer, offset, count);
	offset += FLOAT32_SIZE * count;

	const y = new Float32Array(buffer, offset, count);
	offset += FLOAT32_SIZE * count;

	const rootUriOffsets = new Uint32Array(buffer, offset, count + 1);
	offset += UINT32_SIZE * (count + 1);

	const rootUriBytes = new Uint8Array(buffer, offset, totalUriBytes);
	let uriOffset = 0;

	for (let index = 0; index < count; index += 1) {
		const point = points[index];
		const encodedUri = encodedUris[index];
		clusters[index] = point.cluster >>> 0;
		x[index] = point.x;
		y[index] = point.y;
		rootUriOffsets[index] = uriOffset;
		rootUriBytes.set(encodedUri, uriOffset);
		uriOffset += encodedUri.byteLength;
	}

	rootUriOffsets[count] = uriOffset;
	return buffer;
}

export function decodeCompactClusterPoints(buffer: ArrayBuffer): CompactClusterPointColumns {
	if (buffer.byteLength < UINT32_SIZE * 2) {
		throw new Error('Compact cluster points payload is too small.');
	}

	const count = new DataView(buffer).getUint32(0, true);
	let offset = UINT32_SIZE;

	const clustersEnd = offset + UINT32_SIZE * count;
	const xEnd = clustersEnd + FLOAT32_SIZE * count;
	const yEnd = xEnd + FLOAT32_SIZE * count;
	const offsetsEnd = yEnd + UINT32_SIZE * (count + 1);

	if (offsetsEnd > buffer.byteLength) {
		throw new Error('Compact cluster points payload is truncated.');
	}

	const clusters = new Uint32Array(buffer, offset, count);
	offset = clustersEnd;

	const x = new Float32Array(buffer, offset, count);
	offset = xEnd;

	const y = new Float32Array(buffer, offset, count);
	offset = yEnd;

	const rootUriOffsets = new Uint32Array(buffer, offset, count + 1);
	offset = offsetsEnd;

	const rootUriBytes = new Uint8Array(buffer, offset);
	const expectedRootUriLength = rootUriOffsets[count] ?? 0;
	if (expectedRootUriLength !== rootUriBytes.byteLength) {
		throw new Error('Compact cluster points URI payload is malformed.');
	}

	return {
		count,
		clusters,
		x,
		y,
		rootUriOffsets,
		rootUriBytes
	};
}

export function decodeCompactRootUri(
	columns: CompactClusterPointColumns,
	index: number,
	decoder = new TextDecoder()
): string {
	assertPointIndex(columns.count, index);
	const start = columns.rootUriOffsets[index] ?? 0;
	const end = columns.rootUriOffsets[index + 1] ?? start;
	if (end < start || end > columns.rootUriBytes.byteLength) {
		throw new Error(`Compact cluster point URI offsets are invalid for point ${index}.`);
	}
	return decoder.decode(columns.rootUriBytes.subarray(start, end));
}

export function createCompactClusterPointStore(buffer: ArrayBuffer): CompactClusterPointStore {
	const columns = decodeCompactClusterPoints(buffer);
	const decoder = new TextDecoder();
	const cache = new Map<number, string>();

	return {
		...columns,
		decodeRootUri(index: number): string {
			assertPointIndex(columns.count, index);
			const cached = cache.get(index);
			if (cached) return cached;
			const rootUri = decodeCompactRootUri(columns, index, decoder);
			cache.set(index, rootUri);
			return rootUri;
		}
	};
}

export function parseDidFromRootUri(rootUri: string): string | null {
	const parts = rootUri.split('/');
	const did = parts[2]?.trim();
	return did ? did : null;
}
