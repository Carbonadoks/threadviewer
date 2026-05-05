import test from 'node:test';
import assert from 'node:assert/strict';
import { buildThreadJudgeIndexEntry, buildThreadJudgePrompt, upsertThreadJudgeIndex } from './threadJudge';
import type { ThreadJudgePayload, ThreadJudgePost } from '$lib/types';

const samplePosts: ThreadJudgePost[] = [
	{
		index: 1,
		uri: 'at://did:plc:example/app.bsky.feed.post/root',
		author: {
			did: 'did:plc:example',
			handle: 'example.bsky.social',
			displayName: 'Example'
		},
		createdAt: '2026-03-10T12:00:00.000Z',
		text: 'Opening post for the judgment cache entry',
		depth: 0,
		replyToIndex: null
	},
	{
		index: 2,
		uri: 'at://did:plc:example/app.bsky.feed.post/reply',
		author: {
			did: 'did:plc:reply',
			handle: 'reply.bsky.social',
			displayName: 'Reply'
		},
		createdAt: '2026-03-10T12:01:00.000Z',
		text: 'Reply',
		depth: 1,
		replyToIndex: 1
	}
];

const samplePayload: ThreadJudgePayload = {
	model: 'gemini-3.1-flash-lite-preview',
	postCount: 2,
	judgments: {
		'1': {
			sentiment: 'neutral',
			positivity: 42,
			excitingness: 28,
			intensity: 35,
			curiosity: 40,
			confidence: 77,
			summary: 'Opening post',
			glossary: [
				{
					term: 'OP',
					explanation: 'Short for original poster or opening post.'
				}
			]
		},
		'2': {
			sentiment: 'positive',
			positivity: 64,
			excitingness: 55,
			intensity: 51,
			curiosity: 48,
			confidence: 79,
			summary: 'Reply',
			glossary: []
		}
	}
};

test('buildThreadJudgePrompt asks Gemini for a glossary of unfamiliar terms', () => {
	const prompt = buildThreadJudgePrompt(samplePosts);

	assert.ok(/summary, glossary\./.test(prompt));
	assert.ok(/Glossary must be an array with up to 3 items\./.test(prompt));
	assert.ok(/If nothing needs explanation, return an empty glossary array\./.test(prompt));
});

test('buildThreadJudgePrompt keeps full post text by default', () => {
	const longText = 'x'.repeat(1500);
	const prompt = buildThreadJudgePrompt([
		{
			...samplePosts[0],
			text: longText
		}
	]);

	assert.ok(prompt.includes(longText));
});

test('buildThreadJudgeIndexEntry derives a judge cache card from the opening post', () => {
	const entry = buildThreadJudgeIndexEntry(
		'at://did:plc:example/app.bsky.feed.post/root',
		samplePosts,
		samplePayload,
		'2026-03-10T12:05:00.000Z'
	);

	assert.deepEqual(entry, {
		rootUri: 'at://did:plc:example/app.bsky.feed.post/root',
		threadUrl: 'https://bsky.app/profile/example.bsky.social/post/root',
		handle: 'example.bsky.social',
		title: 'Opening post for the judgment cache entry',
		postCount: 2,
		model: 'gemini-3.1-flash-lite-preview',
		updatedAt: '2026-03-10T12:05:00.000Z'
	});
});

test('upsertThreadJudgeIndex replaces existing entries for the same thread and model', () => {
	const older = buildThreadJudgeIndexEntry(
		'at://did:plc:example/app.bsky.feed.post/root',
		samplePosts,
		samplePayload,
		'2026-03-10T12:05:00.000Z'
	)!;
	const newer = buildThreadJudgeIndexEntry(
		'at://did:plc:example/app.bsky.feed.post/root',
		samplePosts,
		{
			...samplePayload,
			judgments: {
				...samplePayload.judgments,
				'1': {
					...samplePayload.judgments['1'],
					summary: 'Updated opening post'
				}
			}
		},
		'2026-03-10T12:10:00.000Z'
	)!;
	const another = buildThreadJudgeIndexEntry(
		'at://did:plc:another/app.bsky.feed.post/other',
		[
			{
				...samplePosts[0],
				uri: 'at://did:plc:another/app.bsky.feed.post/other',
				author: { ...samplePosts[0].author, handle: 'another.bsky.social' },
				text: 'Another thread'
			}
		],
		{ ...samplePayload, postCount: 1 },
		'2026-03-10T12:07:00.000Z'
	)!;

	const merged = upsertThreadJudgeIndex([older, another], newer);

	assert.equal(merged.length, 2);
	assert.equal(merged[0].rootUri, newer.rootUri);
	assert.equal(merged[0].updatedAt, '2026-03-10T12:10:00.000Z');
	assert.equal(merged[0].model, 'gemini-3.1-flash-lite-preview');
	assert.equal(merged[1].rootUri, another.rootUri);
});

test('upsertThreadJudgeIndex keeps multiple models for the same thread', () => {
	const currentModel = buildThreadJudgeIndexEntry(
		'at://did:plc:example/app.bsky.feed.post/root',
		samplePosts,
		samplePayload,
		'2026-03-10T12:05:00.000Z'
	)!;
	const alternateModel = buildThreadJudgeIndexEntry(
		'at://did:plc:example/app.bsky.feed.post/root',
		samplePosts,
		{ ...samplePayload, model: 'gemini-2.5-flash-lite' },
		'2026-03-10T12:07:00.000Z'
	)!;

	const merged = upsertThreadJudgeIndex([currentModel], alternateModel);

	assert.equal(merged.length, 2);
	assert.equal(merged[0].model, 'gemini-2.5-flash-lite');
	assert.equal(merged[1].model, 'gemini-3.1-flash-lite-preview');
});
