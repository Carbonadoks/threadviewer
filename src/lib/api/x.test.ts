import assert from 'node:assert/strict';
import test from 'node:test';
import {
	buildFixupXStatusUrl,
	extractXArchiveEmbedUrls,
	extractXStatusCandidateUrls,
	normalizeXStatusUrl,
	parseXStatusUrl,
	type XArchivePost
} from './x';

function mockPost(overrides: Partial<XArchivePost>): XArchivePost {
	return {
		id: '100',
		uri: 'x://status/100',
		cid: 'x:100',
		author: {
			did: 'x:1',
			handle: 'alice',
			displayName: 'Alice'
		},
		text: '',
		createdAt: new Date(0).toISOString(),
		linkedUrls: [],
		likeCount: 0,
		repostCount: 0,
		replyCount: 0,
		quoteCount: 0,
		sourceUrl: 'https://x.com/alice/status/100',
		countableText: '',
		characterLength: 0,
		children: [],
		...overrides
	};
}

test('parses x/twitter status URLs and builds FixupX URLs', () => {
	assert.deepEqual(parseXStatusUrl('https://x.com/alice/status/123/photo/1'), {
		id: '123',
		handle: 'alice',
		canonicalUrl: 'https://x.com/alice/status/123',
		fixupxUrl: 'https://fixupx.com/alice/status/123'
	});
	assert.equal(normalizeXStatusUrl('https://twitter.com/@bob/statuses/456?s=20'), 'https://x.com/bob/status/456');
	assert.equal(buildFixupXStatusUrl('https://mobile.twitter.com/bob/status/456'), 'https://fixupx.com/bob/status/456');
	assert.equal(parseXStatusUrl('https://t.co/abc123'), null);
});

test('extracts candidate X status and t.co URLs without duplicates', () => {
	assert.deepEqual(
		extractXStatusCandidateUrls('look https://t.co/abc and https://x.com/alice/status/123.', [
			'https://twitter.com/alice/status/123?s=20',
			'https://example.com/nope'
		]),
		['https://twitter.com/alice/status/123?s=20', 'https://t.co/abc']
	);
});

test('extractXArchiveEmbedUrls skips the archived post self link', () => {
	const post = mockPost({
		text: 'self https://t.co/self linked https://x.com/bob/status/200',
		linkedUrls: [
			'https://x.com/alice/status/100/photo/1',
			'https://x.com/bob/status/200'
		]
	});

	assert.deepEqual(extractXArchiveEmbedUrls(post), ['https://x.com/bob/status/200', 'https://t.co/self']);
});
