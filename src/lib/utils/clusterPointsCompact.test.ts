import test from 'node:test';
import assert from 'node:assert/strict';
import {
	createCompactClusterPointStore,
	encodeCompactClusterPoints,
	parseDidFromRootUri
} from './clusterPointsCompact';

test('compact cluster points round-trip preserves coordinates, clusters, and lazy URI decode', () => {
	const input = [
		{
			did: 'did:plc:alpha',
			rootUri: 'at://did:plc:alpha/app.bsky.feed.post/one',
			cluster: 2,
			x: 12.5,
			y: -4.25
		},
		{
			did: 'did:plc:beta',
			rootUri: 'at://did:plc:beta/app.bsky.feed.post/two',
			cluster: 5,
			x: -3.75,
			y: 8.125
		}
	];

	const store = createCompactClusterPointStore(encodeCompactClusterPoints(input));

	assert.equal(store.count, input.length);
	assert.deepEqual(Array.from(store.clusters), input.map((point) => point.cluster));
	assert.deepEqual(Array.from(store.x), input.map((point) => point.x));
	assert.deepEqual(Array.from(store.y), input.map((point) => point.y));
	assert.equal(store.decodeRootUri(0), input[0].rootUri);
	assert.equal(store.decodeRootUri(1), input[1].rootUri);
	assert.equal(store.decodeRootUri(0), input[0].rootUri);
});

test('parseDidFromRootUri extracts the embedded DID', () => {
	assert.equal(
		parseDidFromRootUri('at://did:plc:example/app.bsky.feed.post/abc123'),
		'did:plc:example'
	);
	assert.equal(parseDidFromRootUri(''), null);
});
