import test from 'node:test';
import assert from 'node:assert/strict';
import {
	buildRenderedClusterLabels,
	buildRenderedClusterPoints,
	createClusterSpatialIndex,
	hitTestClusterSpatialIndex,
	screenToWorld,
	worldToScreen
} from './clusterPlot';

const baseViewport = {
	width: 320,
	height: 220,
	zoom: 120,
	panX: 160,
	panY: 110
};

test('world and screen transforms round-trip through the current camera', () => {
	const world = { x: 0.42, y: -0.18 };
	const screen = worldToScreen(baseViewport, world.x, world.y);
	const roundTrip = screenToWorld(baseViewport, screen.x, screen.y);

	assert.ok(roundTrip);
	assert.ok(Math.abs((roundTrip?.x ?? 0) - world.x) < 1e-9);
	assert.ok(Math.abs((roundTrip?.y ?? 0) - world.y) < 1e-9);
});

test('rendered points keep their world coordinates across pan and zoom changes', () => {
	const points = {
		count: 3,
		x: new Float32Array([0, 0.28, -0.42]),
		y: new Float32Array([0.1, -0.18, 0.36]),
		clusters: new Uint32Array([1, 2, 3])
	};

	const firstPass = buildRenderedClusterPoints(points, baseViewport, {
		yDirection: -1,
		includeOffscreen: true
	});
	const secondPass = buildRenderedClusterPoints(
		points,
		{
			...baseViewport,
			zoom: 260,
			panX: 48,
			panY: -36
		},
		{
			yDirection: -1,
			includeOffscreen: true
		}
	);

	assert.deepEqual(
		firstPass.map((point) => ({
			index: point.index,
			cluster: point.cluster,
			worldX: point.worldX,
			worldY: point.worldY
		})),
		secondPass.map((point) => ({
			index: point.index,
			cluster: point.cluster,
			worldX: point.worldX,
			worldY: point.worldY
		}))
	);
});

test('spatial hit testing resolves the same point after zoom and pan transforms', () => {
	const points = {
		count: 3,
		x: new Float32Array([0, 0.35, -0.2]),
		y: new Float32Array([0, 0.25, -0.4]),
		clusters: new Uint32Array([0, 1, 2])
	};
	const spatialIndex = createClusterSpatialIndex(points, { yDirection: -1, cellSizeWorld: 0.1 });
	const targetWorld = { x: 0.35, y: -0.25 };
	const targetScreen = worldToScreen(baseViewport, targetWorld.x, targetWorld.y);
	const pointerWorld = screenToWorld(baseViewport, targetScreen.x + 2, targetScreen.y - 3);

	assert.ok(pointerWorld);
	const hit = hitTestClusterSpatialIndex(points, spatialIndex, pointerWorld?.x ?? 0, pointerWorld?.y ?? 0, 0.05);

	assert.equal(hit?.index, 1);
	assert.equal(hit?.cluster, 1);
});

test('label visibility can change with zoom without changing atlas anchors', () => {
	const clusters = [
		{
			cluster: 0,
			region: { x: 0.1, y: 0.15, labelRank: 1 }
		},
		{
			cluster: 1,
			region: { x: -0.22, y: -0.08, labelRank: 3 }
		},
		{
			cluster: 2,
			region: { x: 0.32, y: -0.31, labelRank: 6 }
		}
	];

	const defaultZoom = buildRenderedClusterLabels(clusters, baseViewport, {
		fitZoom: baseViewport.zoom,
		yDirection: -1,
		baseVisibleCount: 2,
		maxVisibleCount: 6
	});
	const zoomedIn = buildRenderedClusterLabels(
		clusters,
		{
			...baseViewport,
			zoom: baseViewport.zoom * 2
		},
		{
			fitZoom: baseViewport.zoom,
			yDirection: -1,
			baseVisibleCount: 2,
			maxVisibleCount: 6
		}
	);

	assert.deepEqual(
		defaultZoom.map((label) => ({
			cluster: label.cluster,
			worldX: label.worldX,
			worldY: label.worldY
		})),
		zoomedIn.map((label) => ({
			cluster: label.cluster,
			worldX: label.worldX,
			worldY: label.worldY
		}))
	);
	assert.equal(defaultZoom.filter((label) => label.visible).length < zoomedIn.filter((label) => label.visible).length, true);
});
