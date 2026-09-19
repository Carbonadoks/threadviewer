import test from 'node:test';
import assert from 'node:assert/strict';
import { treeViewport, intersectsViewport } from './treeViewport';

test('hundreds of lanes mount only the nearby trees', () => {
	const lanes = Array.from({ length: 500 }, (_, index) => ({ x: index * 300, y: 0, width: 240, height: 600 }));
	const visible = lanes.filter((lane) => intersectsViewport(lane, treeViewport(60000, 0, 1000, 800, 1)));
	assert.ok(visible.length < 10);
	assert.ok(visible.some((lane) => lane.x === 60000));
	assert.ok(!visible.includes(lanes[0]));
});

test('viewport accounts for zoom and stays stable inside scroll buckets', () => {
	assert.deepEqual(treeViewport(512, 256, 1000, 800, 1), treeViewport(700, 400, 1000, 800, 1));
	const view = treeViewport(6000, 1000, 1000, 800, 0.5);
	assert.ok(intersectsViewport({ x: 12000, y: 2000, width: 50, height: 50 }, view));
	assert.ok(!intersectsViewport({ x: 0, y: 0, width: 50, height: 50 }, view));
});

test('connectors crossing the viewport survive even with endpoints outside it', () => {
	assert.ok(intersectsViewport({ x: 0, y: 0, width: 10000, height: 50 }, { x: 4000, y: 0, width: 1000, height: 800 }));
});
