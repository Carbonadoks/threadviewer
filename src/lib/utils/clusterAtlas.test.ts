import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAtlasClusterLayout } from './clusterAtlas';
import { normalizeProjectionCoordinates } from './clusterProjection';

type Point = { x: number; y: number };

function clusterCentroid(points: Point[], assignments: number[], cluster: number): Point {
	const members = points.filter((_, index) => assignments[index] === cluster);
	const total = members.reduce(
		(sum, point) => ({
			x: sum.x + point.x,
			y: sum.y + point.y
		}),
		{ x: 0, y: 0 }
	);
	return {
		x: total.x / Math.max(1, members.length),
		y: total.y / Math.max(1, members.length)
	};
}

function distance(left: Point, right: Point): number {
	return Math.hypot(left.x - right.x, left.y - right.y);
}

function nearestNeighborByCluster(points: Point[], assignments: number[]): number[] {
	return points.map((point, index) => {
		let bestIndex = -1;
		let bestDistance = Number.POSITIVE_INFINITY;
		for (let otherIndex = 0; otherIndex < points.length; otherIndex += 1) {
			if (otherIndex === index || assignments[otherIndex] !== assignments[index]) continue;
			const nextDistance = distance(point, points[otherIndex]);
			if (nextDistance < bestDistance) {
				bestDistance = nextDistance;
				bestIndex = otherIndex;
			}
		}
		return bestIndex;
	});
}

function clusterAspectRatio(points: Point[], assignments: number[], cluster: number): number {
	const members = points.filter((_, index) => assignments[index] === cluster);
	if (members.length <= 1) return 1;
	const centroid = clusterCentroid(points, assignments, cluster);
	let xx = 0;
	let xy = 0;
	let yy = 0;
	for (const point of members) {
		const dx = point.x - centroid.x;
		const dy = point.y - centroid.y;
		xx += dx * dx;
		xy += dx * dy;
		yy += dy * dy;
	}
	const angle = 0.5 * Math.atan2(2 * xy, xx - yy);
	const cos = Math.cos(angle);
	const sin = Math.sin(angle);
	const projectedX: number[] = [];
	const projectedY: number[] = [];
	for (const point of members) {
		const dx = point.x - centroid.x;
		const dy = point.y - centroid.y;
		projectedX.push(dx * cos + dy * sin);
		projectedY.push(-dx * sin + dy * cos);
	}
	const radius = (values: number[]) =>
		values
			.map((value) => Math.abs(value))
			.sort((left, right) => left - right)[Math.floor(values.length * 0.8)] ?? 1e-6;
	return radius(projectedX) / Math.max(radius(projectedY), 1e-6);
}

test('atlas spreading increases inter-cluster centroid separation', () => {
	const coordinates = [
		{ x: -0.08, y: 0.01 },
		{ x: -0.04, y: -0.02 },
		{ x: 0.02, y: 0.03 },
		{ x: 0.06, y: 0.01 }
	];
	const assignments = [0, 0, 1, 1];
	const centers = [
		{ cluster: 0, center: [1, 0], threadCount: 2 },
		{ cluster: 1, center: [-1, 0], threadCount: 2 }
	];

	const before = distance(
		clusterCentroid(coordinates, assignments, 0),
		clusterCentroid(coordinates, assignments, 1)
	);
	const result = buildAtlasClusterLayout(coordinates, assignments, centers);
	const after = distance(
		clusterCentroid(result.coordinates, assignments, 0),
		clusterCentroid(result.coordinates, assignments, 1)
	);

	assert.ok(after > before);
});

test('atlas spreading preserves within-cluster nearest neighbors', () => {
	const coordinates = [
		{ x: -0.16, y: -0.05 },
		{ x: -0.12, y: 0.01 },
		{ x: -0.09, y: -0.02 },
		{ x: -0.04, y: 0.03 },
		{ x: 0.05, y: -0.03 },
		{ x: 0.09, y: 0.02 },
		{ x: 0.14, y: -0.01 },
		{ x: 0.19, y: 0.04 }
	];
	const assignments = [0, 0, 0, 0, 1, 1, 1, 1];
	const centers = [
		{ cluster: 0, center: [0.95, 0.05], threadCount: 4 },
		{ cluster: 1, center: [-0.9, 0.1], threadCount: 4 }
	];

	const before = nearestNeighborByCluster(coordinates, assignments);
	const result = buildAtlasClusterLayout(coordinates, assignments, centers);
	const after = nearestNeighborByCluster(result.coordinates, assignments);
	const retained = before.filter((neighbor, index) => neighbor === after[index]).length / before.length;

	assert.ok(retained >= 0.75);
});

test('atlas spreading does not over-separate already distinct clusters', () => {
	const coordinates = [
		{ x: -0.12, y: 0.02 },
		{ x: -0.08, y: -0.03 },
		{ x: -0.01, y: 0.01 },
		{ x: 0.03, y: -0.02 },
		{ x: 0.1, y: 0.04 },
		{ x: 0.14, y: -0.01 }
	];
	const assignments = [0, 0, 1, 1, 2, 2];
	const centers = [
		{ cluster: 0, center: [1, 0], threadCount: 2 },
		{ cluster: 1, center: [0, 1], threadCount: 2 },
		{ cluster: 2, center: [-1, 0], threadCount: 2 }
	];

	const normalizedBefore = normalizeProjectionCoordinates(coordinates);
	const beforeCentroids = [0, 1, 2].map((cluster) =>
		clusterCentroid(normalizedBefore, assignments, cluster)
	);
	const result = buildAtlasClusterLayout(coordinates, assignments, centers);
	const afterCentroids = [0, 1, 2].map((cluster) =>
		clusterCentroid(result.coordinates, assignments, cluster)
	);
	const beforePairs = [
		distance(beforeCentroids[0], beforeCentroids[1]),
		distance(beforeCentroids[0], beforeCentroids[2]),
		distance(beforeCentroids[1], beforeCentroids[2])
	];
	const afterPairs = [
		distance(afterCentroids[0], afterCentroids[1]),
		distance(afterCentroids[0], afterCentroids[2]),
		distance(afterCentroids[1], afterCentroids[2])
	];
	const maxExpansion = afterPairs.reduce(
		(max, afterDistance, index) => Math.max(max, afterDistance / Math.max(beforePairs[index], 1e-6)),
		0
	);

	assert.ok(maxExpansion <= 1.25);
});

test('atlas local reprojection reduces line-like cluster shapes', () => {
	const coordinates = [
		{ x: -0.22, y: -0.008 },
		{ x: -0.18, y: 0.006 },
		{ x: -0.14, y: -0.005 },
		{ x: -0.1, y: 0.004 },
		{ x: -0.06, y: -0.006 },
		{ x: -0.02, y: 0.005 },
		{ x: 0.04, y: -0.007 },
		{ x: 0.08, y: 0.006 },
		{ x: 0.12, y: -0.004 },
		{ x: 0.16, y: 0.005 },
		{ x: 0.2, y: -0.006 },
		{ x: 0.24, y: 0.007 }
	];
	const assignments = [0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1];
	const centers = [
		{ cluster: 0, center: [1, 0, 0], threadCount: 6 },
		{ cluster: 1, center: [-1, 0, 0], threadCount: 6 }
	];
	const vectors = [
		[1, -0.24, -0.2],
		[1, -0.18, 0.12],
		[1, -0.06, -0.08],
		[1, 0.04, 0.2],
		[1, 0.16, -0.14],
		[1, 0.26, 0.08],
		[-1, -0.22, -0.16],
		[-1, -0.14, 0.1],
		[-1, -0.02, -0.18],
		[-1, 0.08, 0.18],
		[-1, 0.18, -0.1],
		[-1, 0.28, 0.12]
	];

	const before = clusterAspectRatio(coordinates, assignments, 0);
	const result = buildAtlasClusterLayout(coordinates, assignments, centers, vectors);
	const after = clusterAspectRatio(result.coordinates, assignments, 0);

	assert.ok(after < before * 0.7);
	assert.ok(after <= 2.05);
});

test('atlas region metadata is deterministic for the same input', () => {
	const coordinates = [
		{ x: -0.15, y: -0.08 },
		{ x: -0.1, y: 0.02 },
		{ x: -0.05, y: -0.01 },
		{ x: 0.08, y: -0.04 },
		{ x: 0.12, y: 0.03 },
		{ x: 0.18, y: 0.01 }
	];
	const assignments = [0, 0, 0, 1, 1, 1];
	const centers = [
		{ cluster: 0, center: [0.82, 0.18], threadCount: 3 },
		{ cluster: 1, center: [-0.88, 0.12], threadCount: 3 }
	];

	const first = buildAtlasClusterLayout(coordinates, assignments, centers);
	const second = buildAtlasClusterLayout(coordinates, assignments, centers);

	assert.deepEqual(first, second);
});
