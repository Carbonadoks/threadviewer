import test from 'node:test';
import assert from 'node:assert/strict';
import {
	hasRenderableRecordEmbedContent,
	mergeRecordEmbed,
	type RecordEmbed
} from './recordEmbed';

function makeRecord(overrides: Partial<RecordEmbed> = {}): RecordEmbed {
	return {
		uri: 'at://did:plc:test/app.bsky.feed.post/quoted',
		author: {
			handle: 'quoted.test',
			displayName: 'Quoted Test',
			avatar: 'https://example.com/avatar.jpg'
		},
		text: '',
		createdAt: '',
		images: undefined,
		...overrides
	};
}

test('hasRenderableRecordEmbedContent only returns true when quoted content is present', () => {
	assert.equal(hasRenderableRecordEmbedContent(makeRecord()), false);
	assert.equal(hasRenderableRecordEmbedContent(makeRecord({ text: 'quoted text' })), true);
	assert.equal(
		hasRenderableRecordEmbedContent(
			makeRecord({
				images: [{ thumb: 'thumb.jpg', fullsize: 'full.jpg', alt: 'alt text' }]
			})
		),
		true
	);
});

test('mergeRecordEmbed keeps fallback metadata but prefers fetched quote content', () => {
	const merged = mergeRecordEmbed(
		makeRecord({
			author: {
				handle: 'quoted.test',
				displayName: undefined,
				avatar: undefined
			}
		}),
		makeRecord({
			text: 'Fetched quoted text',
			createdAt: '2026-03-09T12:00:00.000Z',
			images: [{ thumb: 'thumb.jpg', fullsize: 'full.jpg', alt: 'alt text' }]
		})
	);

	assert.equal(merged.author.handle, 'quoted.test');
	assert.equal(merged.text, 'Fetched quoted text');
	assert.equal(merged.createdAt, '2026-03-09T12:00:00.000Z');
	assert.equal(merged.images?.length, 1);
});
