import test from 'node:test';
import assert from 'node:assert/strict';
import {
	clusterReducedCoordinates,
	reduceEmbeddingsWithUmap
} from './toponomyUmap';

test('reduceEmbeddingsWithUmap returns finite normalized coordinates', () => {
	const vectors = [
		[1, 0, 0, 0],
		[0.92, 0.08, 0, 0],
		[0.9, 0.1, 0, 0],
		[0, 1, 0, 0],
		[0.05, 0.95, 0, 0],
		[0.08, 0.92, 0, 0]
	];

	const coordinates = reduceEmbeddingsWithUmap(vectors, {
		neighborCount: 3,
		iterations: 120
	});

	assert.equal(coordinates.length, vectors.length);
	for (const coordinate of coordinates) {
		assert.equal(Number.isFinite(coordinate.x), true);
		assert.equal(Number.isFinite(coordinate.y), true);
		assert.ok(Math.abs(coordinate.x) <= 1.001);
		assert.ok(Math.abs(coordinate.y) <= 1.001);
	}
});

test('clusterReducedCoordinates separates obvious two-island layouts', () => {
	const coordinates = [
		{ x: -0.92, y: -0.1 },
		{ x: -0.84, y: 0.08 },
		{ x: -0.76, y: 0.02 },
		{ x: 0.78, y: 0.06 },
		{ x: 0.86, y: -0.04 },
		{ x: 0.94, y: 0.1 }
	];

	const { assignments, clusters } = clusterReducedCoordinates(
		coordinates,
		coordinates.map((_, index) => `thread-${index}`),
		2
	);

	assert.equal(assignments.length, coordinates.length);
	assert.equal(clusters.length, 2);
	assert.deepEqual(new Set(assignments).size, 2);
	assert.deepEqual(assignments.slice(0, 3), [assignments[0], assignments[0], assignments[0]]);
	assert.deepEqual(assignments.slice(3), [assignments[3], assignments[3], assignments[3]]);
	assert.ok(assignments[0] !== assignments[3]);
});
