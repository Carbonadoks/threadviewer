import test from 'node:test';
import assert from 'node:assert/strict';
import {
	buildAtUri,
	buildBskyPostUrl,
	buildViewerHref,
	extractBskyPostUrls,
	extractBskyPostUrlsFromFacets,
	normalizeBskyPostUrl,
	parseBskyPostUrl
} from './viewerLinks';

test('parseBskyPostUrl extracts handle and rkey from a valid Bluesky post URL', () => {
	assert.deepEqual(
		parseBskyPostUrl('https://bsky.app/profile/example.bsky.social/post/3lxyz'),
		{
			handle: 'example.bsky.social',
			rkey: '3lxyz'
		}
	);
});

test('parseBskyPostUrl rejects invalid hosts and paths', () => {
	assert.equal(parseBskyPostUrl('https://example.com/profile/foo/post/bar'), null);
	assert.equal(parseBskyPostUrl('https://bsky.app/profile/foo'), null);
	assert.equal(parseBskyPostUrl('not a url'), null);
});

test('normalizeBskyPostUrl strips query strings and fragments', () => {
	assert.equal(
		normalizeBskyPostUrl(' https://bsky.app/profile/example.bsky.social/post/3lxyz?utm=1#frag '),
		'https://bsky.app/profile/example.bsky.social/post/3lxyz'
	);
});

test('extractBskyPostUrls finds canonical Bluesky post links in text and deduplicates them', () => {
	assert.deepEqual(
		extractBskyPostUrls(
			'look https://bsky.app/profile/example.bsky.social/post/3lxyz?utm=1 and again https://bsky.app/profile/example.bsky.social/post/3lxyz.'
		),
		['https://bsky.app/profile/example.bsky.social/post/3lxyz']
	);
});

test('extractBskyPostUrls ignores non-post links and trims trailing punctuation', () => {
	assert.deepEqual(
		extractBskyPostUrls(
			'other https://example.com/test and linked (https://bsky.app/profile/quoted.test/post/3labc)!'
		),
		['https://bsky.app/profile/quoted.test/post/3labc']
	);
});

test('extractBskyPostUrlsFromFacets keeps Bluesky post links from richtext facets', () => {
	assert.deepEqual(
		extractBskyPostUrlsFromFacets([
			{
				features: [
					{
						$type: 'app.bsky.richtext.facet#link',
						uri: 'https://bsky.app/profile/example.bsky.social/post/3lxyz?utm=1'
					}
				]
			},
			{
				features: [
					{
						$type: 'app.bsky.richtext.facet#mention',
						uri: 'https://example.com/not-a-post'
					}
				]
			}
		]),
		['https://bsky.app/profile/example.bsky.social/post/3lxyz']
	);
});

test('buildBskyPostUrl converts a root AT URI to a Bluesky web URL', () => {
	assert.equal(
		buildBskyPostUrl('at://did:plc:example/app.bsky.feed.post/3lxyz'),
		'https://bsky.app/profile/did%3Aplc%3Aexample/post/3lxyz'
	);
	assert.equal(
		buildBskyPostUrl('at://did:plc:example/app.bsky.feed.post/3lxyz', 'example.bsky.social'),
		'https://bsky.app/profile/example.bsky.social/post/3lxyz'
	);
});

test('buildAtUri converts a DID and rkey into a post AT URI', () => {
	assert.equal(
		buildAtUri('did:plc:example', '3lxyz'),
		'at://did:plc:example/app.bsky.feed.post/3lxyz'
	);
	assert.equal(buildAtUri('', '3lxyz'), null);
});

test('buildViewerHref preserves canonical url state across viewer pages', () => {
	const threadUrl = 'https://bsky.app/profile/example.bsky.social/post/3lxyz';

	assert.equal(
		buildViewerHref('threadviewer', { url: threadUrl }),
		'/threadviewer?url=https%3A%2F%2Fbsky.app%2Fprofile%2Fexample.bsky.social%2Fpost%2F3lxyz'
	);
	assert.equal(
		buildViewerHref('viewer2', { url: threadUrl }),
		'/viewer2?handle=example.bsky.social'
	);
	assert.equal(
		buildViewerHref('dialogue', {
			url: threadUrl,
			handleA: '@alice.test',
			handleB: '@bob.test'
		}),
		'/dialogue?handleA=alice.test&handleB=bob.test&url=https%3A%2F%2Fbsky.app%2Fprofile%2Fexample.bsky.social%2Fpost%2F3lxyz'
	);
	assert.equal(buildViewerHref('chat', { url: threadUrl }), '/chat?url=https%3A%2F%2Fbsky.app%2Fprofile%2Fexample.bsky.social%2Fpost%2F3lxyz');
	assert.equal(buildViewerHref('board', { url: threadUrl }), '/board?url=https%3A%2F%2Fbsky.app%2Fprofile%2Fexample.bsky.social%2Fpost%2F3lxyz');
	assert.equal(buildViewerHref('blog', { url: threadUrl }), '/blog?url=https%3A%2F%2Fbsky.app%2Fprofile%2Fexample.bsky.social%2Fpost%2F3lxyz');
	assert.equal(
		buildViewerHref('parallelboard', { url: threadUrl }),
		'/parallelboard?url=https%3A%2F%2Fbsky.app%2Fprofile%2Fexample.bsky.social%2Fpost%2F3lxyz'
	);
	assert.equal(buildViewerHref('band', { url: threadUrl }), '/band?url=https%3A%2F%2Fbsky.app%2Fprofile%2Fexample.bsky.social%2Fpost%2F3lxyz');
	assert.equal(buildViewerHref('judge', { url: threadUrl }), '/judge?url=https%3A%2F%2Fbsky.app%2Fprofile%2Fexample.bsky.social%2Fpost%2F3lxyz');
});

test('buildViewerHref falls back to handle-only home links when no thread url exists', () => {
	assert.equal(
		buildViewerHref('threadviewer', { handle: '@example.bsky.social' }),
		'/threadviewer?handle=example.bsky.social'
	);
	assert.equal(
		buildViewerHref('viewer2', { handle: '@example.bsky.social' }),
		'/viewer2?handle=example.bsky.social'
	);
	assert.equal(
		buildViewerHref('dialogue', { handleA: '@alice.test', handleB: '@bob.test' }),
		'/dialogue?handleA=alice.test&handleB=bob.test'
	);
	assert.equal(buildViewerHref('chat', { handle: '@example.bsky.social' }), '/chat');
	assert.equal(buildViewerHref('blog', { handle: '@example.bsky.social' }), '/blog');
	assert.equal(buildViewerHref('parallelboard', { handle: '@example.bsky.social' }), '/parallelboard');
	assert.equal(buildViewerHref('band', { handle: '@example.bsky.social' }), '/band');
	assert.equal(buildViewerHref('judge', { handle: '@example.bsky.social' }), '/judge');
});
