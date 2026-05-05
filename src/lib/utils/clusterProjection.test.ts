import test from 'node:test';
import assert from 'node:assert/strict';
import {
	isRenderableClusterCoordinate,
	normalizeProjectionCoordinates
} from './clusterProjection';

test('normalizeProjectionCoordinates rescales huge finite coordinates into a renderable range', () => {
	const result = normalizeProjectionCoordinates([
		{ x: -3.679116268450799e172, y: -3.0647927441843982e172 },
		{ x: 6.060671233570306e170, y: 5.048656878273675e170 }
	]);

	assert.equal(result.length, 2);
	for (const point of result) {
		assert.equal(Number.isFinite(point.x), true);
		assert.equal(Number.isFinite(point.y), true);
		assert.equal(isRenderableClusterCoordinate(point.x), true);
		assert.equal(isRenderableClusterCoordinate(point.y), true);
	}
	assert.ok(result[0]!.x < result[1]!.x);
	assert.ok(result[0]!.y < result[1]!.y);
});

test('normalizeProjectionCoordinates falls back when every source coordinate is non-finite', () => {
	const result = normalizeProjectionCoordinates([
		{ x: Number.NaN, y: Number.POSITIVE_INFINITY },
		{ x: Number.NEGATIVE_INFINITY, y: Number.NaN }
	]);

	assert.equal(result.length, 2);
	for (const point of result) {
		assert.equal(Number.isFinite(point.x), true);
		assert.equal(Number.isFinite(point.y), true);
	}
	assert.equal(
		JSON.stringify(result[0]) === JSON.stringify(result[1]),
		false
	);
});
