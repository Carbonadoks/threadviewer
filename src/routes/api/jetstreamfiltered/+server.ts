import { dev } from '$app/environment';
import { env } from '$env/dynamic/private';
import { error, json, type RequestHandler } from '@sveltejs/kit';
import { parseTagTemplate } from '$lib/utils/jetstreamTags';
import { buildTagRequest, parseTagResponse, type TagPost } from '$lib/server/jetstreamTypesafe';

function requireLocalKey() {
	if (!dev) error(403, 'TypeSafe Jetstream filtering is only enabled in local development.');
	const key = env.TYPESAFE_KEY || env.TYPESAFE_API_KEY;
	if (!key) error(503, 'Set TYPESAFE_KEY in .env and restart the local dev server.');
	return key;
}

export const GET: RequestHandler = () => {
	requireLocalKey();
	return json({ ready: true, model: 'jev-latest' });
};

export const POST: RequestHandler = async ({ request, fetch, url }) => {
	const key = requireLocalKey();
	if (request.headers.get('origin') !== url.origin) error(403, 'Same-origin requests required.');
	const raw = await request.text();
	if (raw.length > 65_000) error(413, 'Batch is too large.');
	let posts: TagPost[];
	let tags;
	try {
		const body = JSON.parse(raw);
		if (typeof body.template !== 'string') throw new Error('Missing tag definitions.');
		tags = parseTagTemplate(body.template);
		if (!Array.isArray(body.posts) || body.posts.length < 1 || body.posts.length > 10) throw new Error('Send 1–10 posts.');
		posts = body.posts.map((post: TagPost) => {
			if (!post || typeof post.id !== 'string' || post.id.length > 200 || typeof post.text !== 'string' || post.text.length > 1200 || !Array.isArray(post.altText) || post.altText.length > 4 || post.altText.some(alt => typeof alt !== 'string' || alt.length > 1000)) throw new Error('Invalid post input.');
			return { id: post.id, text: post.text, altText: post.altText };
		});
		if (new Set(posts.map(post => post.id)).size !== posts.length) throw new Error('Duplicate post IDs.');
	} catch (cause) {
		error(400, cause instanceof Error ? cause.message : 'Invalid batch.');
	}
	try {
		const response = await fetch('https://api.typesafe.ai/v1/systemone', {
			method: 'POST',
			headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
			body: JSON.stringify(buildTagRequest(posts, tags)),
			signal: AbortSignal.any([request.signal, AbortSignal.timeout(45_000)])
		});
		if (!response.ok) return json({ message: `TypeSafe request failed (${response.status}). Queue paused; wait before resuming if rate limited.` }, { status: 502 });
		return json({ posts: parseTagResponse(await response.json(), posts, tags) });
	} catch {
		return json({ message: 'TypeSafe request failed or returned invalid data. Queue paused; retry when ready.' }, { status: 502 });
	}
};
