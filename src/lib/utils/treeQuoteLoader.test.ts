import test from 'node:test';
import assert from 'node:assert/strict';
import { downloadQuoteThreads } from './treeQuoteLoader';
import type { ThreadPost } from '../types';

function post(id: string, replyCount = 0): ThreadPost {
	return { uri: `at://did:plc:test/app.bsky.feed.post/${id}`, cid: id,
		author: { did: 'did:plc:test', handle: 'test.bsky.social' }, text: id,
		createdAt: '2026-01-01T00:00:00Z', likeCount: 0, repostCount: 0, quoteCount: 0, replyCount, children: [] };
}

test('standalone quotes need no requests; duplicates and existing lanes are skipped', async () => {
	const a = post('a'); const b = post('b');
	const result = await downloadQuoteThreads([a, a, b], new Set([b.uri]), async () => { throw new Error('unexpected request'); });
	assert.equal(result.failed, 0);
	assert.deepEqual(result.threads.map((item) => item.uri), [a.uri]);
});

test('downloads at most five at once, preserves order, and retains successes after failures', async () => {
	const posts = Array.from({ length: 12 }, (_, index) => post(String(index), 1));
	let active = 0; let peak = 0;
	const progress: number[] = [];
	const result = await downloadQuoteThreads(posts, new Set(), async (uri) => {
		active++; peak = Math.max(peak, active);
		await new Promise((resolve) => setTimeout(resolve, uri.endsWith('/0') ? 12 : 1));
		active--;
		if (uri.endsWith('/3')) throw new Error('unavailable');
		const rootPost = posts.find((item) => item.uri === uri)!;
		return { rootPost, rootUri: uri, depth: 1 };
	}, (completed) => progress.push(completed));
	assert.equal(peak, 5);
	assert.equal(result.failed, 1);
	assert.deepEqual(result.threads.map((item) => item.uri), posts.filter((item) => !item.uri.endsWith('/3')).map((item) => item.uri));
	assert.equal(progress.at(-1), 12);
});

test('reply quotes with no children still fetch the parent conversation', async () => {
	const reply = { ...post('reply'), parentUri: post('parent').uri };
	let fetched = false;
	await downloadQuoteThreads([reply], new Set(), async () => {
		fetched = true;
		return { rootPost: reply, rootUri: reply.uri, depth: 1 };
	});
	assert.equal(fetched, true);
});
