export interface ProjectionCoordinate {
	x: number;
	y: number;
}

export const MAX_RENDERABLE_CLUSTER_COORDINATE_ABS = 1_000_000;

function fallbackCoordinate(index: number, count: number): ProjectionCoordinate {
	if (count <= 1) {
		return { x: 0, y: 0 };
	}

	const angle = (index / count) * Math.PI * 2;
	return {
		x: Math.cos(angle),
		y: Math.sin(angle)
	};
}

export function isRenderableClusterCoordinate(value: number): boolean {
	return Number.isFinite(value) && Math.abs(value) <= MAX_RENDERABLE_CLUSTER_COORDINATE_ABS;
}

export function normalizeProjectionCoordinates(
	coordinates: ProjectionCoordinate[]
): ProjectionCoordinate[] {
	if (coordinates.length === 0) return [];
	if (coordinates.length === 1) return [{ x: 0, y: 0 }];

	let minX = Number.POSITIVE_INFINITY;
	let maxX = Number.NEGATIVE_INFINITY;
	let minY = Number.POSITIVE_INFINITY;
	let maxY = Number.NEGATIVE_INFINITY;
	let finiteCount = 0;

	for (const point of coordinates) {
		if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) continue;
		minX = Math.min(minX, point.x);
		maxX = Math.max(maxX, point.x);
		minY = Math.min(minY, point.y);
		maxY = Math.max(maxY, point.y);
		finiteCount += 1;
	}

	if (finiteCount === 0) {
		return coordinates.map((_, index) => fallbackCoordinate(index, coordinates.length));
	}

	const centerX = (minX + maxX) / 2;
	const centerY = (minY + maxY) / 2;
	let maxAbs = 0;

	for (const point of coordinates) {
		if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) continue;
		maxAbs = Math.max(maxAbs, Math.abs(point.x - centerX), Math.abs(point.y - centerY));
	}

	if (!(maxAbs > 0) || !Number.isFinite(maxAbs)) {
		return coordinates.map((_, index) => fallbackCoordinate(index, coordinates.length));
	}

	return coordinates.map((point, index) => {
		if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
			return fallbackCoordinate(index, coordinates.length);
		}

		return {
			x: (point.x - centerX) / maxAbs,
			y: (point.y - centerY) / maxAbs
		};
	});
}
