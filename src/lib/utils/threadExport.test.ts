import test from 'node:test';
import assert from 'node:assert/strict';
import type { SelfReplyThread, ThreadPost } from '$lib/types';
import { buildThreadExportData, formatThreadExport } from './threadExport';

function makePost(overrides: Partial<ThreadPost> & { uri: string }): ThreadPost {
	return {
		uri: overrides.uri,
		cid: overrides.cid ?? `cid-${overrides.uri.split('/').pop() ?? 'post'}`,
		author: overrides.author ?? {
			did: 'did:plc:alice',
			handle: 'alice.test',
			displayName: 'Alice'
		},
		text: overrides.text ?? '',
		createdAt: overrides.createdAt ?? '2026-03-01T12:00:00.000Z',
		linkedUrls: overrides.linkedUrls,
		needsHydratedPostView: overrides.needsHydratedPostView,
		likeCount: overrides.likeCount ?? 0,
		repostCount: overrides.repostCount ?? 0,
		replyCount: overrides.replyCount ?? 0,
		quoteCount: overrides.quoteCount ?? 0,
		embed: overrides.embed,
		parentUri: overrides.parentUri,
		children: overrides.children ?? []
	};
}

function makeThread(): SelfReplyThread {
	const rootUri = 'at://did:plc:alice/app.bsky.feed.post/root';
	const childUri = 'at://did:plc:bob/app.bsky.feed.post/reply';
	const child = makePost({
		uri: childUri,
		author: {
			did: 'did:plc:bob',
			handle: 'bob.test',
			displayName: 'Bob'
		},
		parentUri: rootUri,
		text: 'A reply from Bob'
	});
	const root = makePost({
		uri: rootUri,
		text: 'Root text',
		linkedUrls: ['https://bsky.app/profile/bob.test/post/reply'],
		embed: {
			type: 'recordWithMedia',
			external: {
				uri: 'https://example.com/story',
				title: 'Story link',
				description: 'A useful link card',
				thumb: 'https://example.com/thumb.jpg'
			},
			record: {
				uri: 'at://did:plc:bob/app.bsky.feed.post/quoted',
				author: {
					handle: 'bob.test',
					displayName: 'Bob',
					avatar: 'https://example.com/avatar.jpg'
				},
				text: 'Quoted text from Bob',
				createdAt: '2026-03-01T12:05:00.000Z',
				images: [{ thumb: 'thumb.jpg', fullsize: 'full.jpg', alt: 'image alt' }],
				video: {
					cid: 'video-cid',
					playlist: 'https://example.com/video.m3u8'
				}
			}
		},
		children: [child]
	});

	return { rootPost: root, depth: 2, rootUri };
}

test('thread export keeps authors, quote text, and link embeds without media payloads', () => {
	const data = buildThreadExportData(makeThread(), {
		identityMode: 'author',
		exportedAt: '2026-03-08T00:00:00.000Z'
	});

	assert.equal(data.rootUri, 'at://did:plc:alice/app.bsky.feed.post/root');
	assert.deepEqual(data.root.author, {
		did: 'did:plc:alice',
		handle: 'alice.test',
		displayName: 'Alice'
	});
	assert.equal(data.root.quote?.text, 'Quoted text from Bob');
	assert.deepEqual(data.root.quote?.author, {
		handle: 'bob.test',
		displayName: 'Bob'
	});
	const quoteRecord = data.root.quote as unknown as Record<string, unknown>;
	assert.equal('images' in quoteRecord, false);
	assert.equal('video' in quoteRecord, false);
	assert.deepEqual(data.root.links, [
		{
			kind: 'external_embed',
			uri: 'https://example.com/story',
			title: 'Story link',
			description: 'A useful link card'
		},
		{
			kind: 'linked_url',
			uri: 'https://bsky.app/profile/bob.test/post/reply'
		}
	]);
});

test('thread export can replace authors with stable anonymous ids', () => {
	const data = buildThreadExportData(makeThread(), {
		identityMode: 'anon',
		exportedAt: '2026-03-08T00:00:00.000Z'
	});

	assert.equal(data.rootUri, undefined);
	assert.equal(data.root.uri, undefined);
	assert.deepEqual(data.root.author, { id: 'anon_1' });
	assert.deepEqual(data.root.replies[0].author, { id: 'anon_2' });
	assert.deepEqual(data.root.quote?.author, { id: 'anon_2' });
});

test('thread export formats markdown, yaml, and json for clipboard use', () => {
	const thread = makeThread();
	const md = formatThreadExport(thread, {
		format: 'md',
		identityMode: 'author',
		exportedAt: '2026-03-08T00:00:00.000Z'
	});
	const yaml = formatThreadExport(thread, {
		format: 'yaml',
		identityMode: 'anon',
		exportedAt: '2026-03-08T00:00:00.000Z'
	});
	const json = JSON.parse(
		formatThreadExport(thread, {
			format: 'json',
			identityMode: 'author',
			exportedAt: '2026-03-08T00:00:00.000Z'
		})
	);

	assert.ok(/Quote: Bob \(@bob\.test\)/.test(md));
	assert.ok(/> Quoted text from Bob/.test(md));
	assert.ok(/\[Story link\]\(https:\/\/example\.com\/story\)/.test(md));
	assert.ok(/identityMode: "anon"/.test(yaml));
	assert.equal(json.root.quote.text, 'Quoted text from Bob');
});
