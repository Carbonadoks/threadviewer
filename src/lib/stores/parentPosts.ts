import { writable, get } from 'svelte/store';
import type { ThreadPost } from '$lib/types';
import { fetchPostsByUris, getFullThread } from '$lib/api/bluesky';

/**
 * Shared store of fetched "parent" posts (the post a given post is replying to).
 *
 * In viewer2 the loaded repository only contains posts authored by the loaded
 * account(s). When a post is a reply to *someone else* (e.g. a mention/reply to
 * another user), that parent is not in the repo. This store lets us fetch those
 * parents on demand and render them inline, keyed by the parent post's URI.
 */

// Map of parent post URI -> resolved ThreadPost.
export const parentPostsByUri = writable<Record<string, ThreadPost>>({});

// Parent URIs we've already attempted (resolved or failed) so the UI can stop
// offering a fetch button and we avoid refetching.
export const attemptedParentUris = writable<Set<string>>(new Set());

// Parent URIs currently being fetched, for spinner/disabled state.
export const fetchingParentUris = writable<Set<string>>(new Set());

// Post URIs whose *whole thread* is currently being fetched.
export const fetchingThreadUris = writable<Set<string>>(new Set());

// Map of a requested post URI -> the full conversation root (all participants,
// every branch) fetched for it. Used to render the complete thread inline.
export const fullThreadByPostUri = writable<Record<string, ThreadPost>>({});

export function getParentPost(uri: string | null | undefined): ThreadPost | null {
	if (!uri) return null;
	return get(parentPostsByUri)[uri] ?? null;
}

function markFetching(uris: string[], on: boolean) {
	fetchingParentUris.update((set) => {
		const next = new Set(set);
		for (const uri of uris) {
			if (on) next.add(uri);
			else next.delete(uri);
		}
		return next;
	});
}

/**
 * Fetch the given parent post URIs (skipping ones already resolved or in-flight)
 * and merge the results into the store. Returns the number newly resolved.
 */
export async function fetchParentPosts(
	uris: Array<string | null | undefined>,
	options: { signal?: AbortSignal; onProgress?: (completed: number, total: number) => void } = {}
): Promise<number> {
	const resolved = get(parentPostsByUri);
	const inFlight = get(fetchingParentUris);
	const toFetch = [
		...new Set(
			uris.filter(
				(uri): uri is string =>
					typeof uri === 'string' && uri.length > 0 && !resolved[uri] && !inFlight.has(uri)
			)
		)
	];
	if (toFetch.length === 0) return 0;

	markFetching(toFetch, true);
	try {
		const fetched = await fetchPostsByUris(toFetch, {
			signal: options.signal,
			concurrency: 4,
			onProgress: ({ completed, total }) => options.onProgress?.(completed, total)
		});

		if (fetched.size > 0) {
			parentPostsByUri.update((map) => {
				const next = { ...map };
				for (const [uri, post] of fetched) next[uri] = post;
				return next;
			});
		}
		attemptedParentUris.update((set) => {
			const next = new Set(set);
			for (const uri of toFetch) next.add(uri);
			return next;
		});
		return fetched.size;
	} finally {
		markFetching(toFetch, false);
	}
}

function markFetchingThread(uris: string[], on: boolean) {
	fetchingThreadUris.update((set) => {
		const next = new Set(set);
		for (const uri of uris) {
			if (on) next.add(uri);
			else next.delete(uri);
		}
		return next;
	});
}

/**
 * Fetch the *entire* conversation that a post belongs to and merge every
 * ancestor (the full parent chain up to the conversation root) into the store.
 * One call fills the whole chain, vs. fetchParentPosts which only grabs one
 * level. Returns the number of ancestors newly resolved.
 */
export async function fetchThreadAncestors(
	postUri: string,
	options: { signal?: AbortSignal } = {}
): Promise<number> {
	if (!postUri) return 0;
	if (get(fetchingThreadUris).has(postUri)) return 0;

	markFetchingThread([postUri], true);
	try {
		const full = await getFullThread(postUri);
		if (options.signal?.aborted) return 0;

		// Index every post in the fetched conversation by URI.
		const index = new Map<string, ThreadPost>();
		const walk = (post: ThreadPost) => {
			index.set(post.uri, post);
			for (const child of post.children) walk(child);
		};
		walk(full.rootPost);

		// Walk up from the target post's parent to the conversation root.
		const ancestors: Record<string, ThreadPost> = {};
		const target = index.get(postUri);
		const seen = new Set<string>();
		let cursor = target?.parentUri ?? full.rootPost.parentUri;
		while (cursor && index.has(cursor) && !seen.has(cursor)) {
			seen.add(cursor);
			const ancestor = index.get(cursor)!;
			ancestors[cursor] = ancestor;
			cursor = ancestor.parentUri;
		}

		// Store the full conversation tree (all participants) for inline rendering.
		fullThreadByPostUri.update((map) => ({ ...map, [postUri]: full.rootPost }));

		const keys = Object.keys(ancestors);
		if (keys.length > 0) {
			parentPostsByUri.update((map) => {
				const next = { ...map };
				for (const key of keys) next[key] = ancestors[key];
				return next;
			});
			attemptedParentUris.update((set) => {
				const nextSet = new Set(set);
				for (const key of keys) nextSet.add(key);
				return nextSet;
			});
		}
		return keys.length;
	} finally {
		markFetchingThread([postUri], false);
	}
}

/** Collect parent URIs from a set of posts (recursing into children). */
export function collectParentUris(posts: ThreadPost[]): string[] {
	const out = new Set<string>();
	const walk = (post: ThreadPost) => {
		if (post.parentUri) out.add(post.parentUri);
		for (const child of post.children) walk(child);
	};
	for (const post of posts) walk(post);
	return [...out];
}

export function resetParentPosts() {
	parentPostsByUri.set({});
	attemptedParentUris.set(new Set());
	fetchingParentUris.set(new Set());
	fetchingThreadUris.set(new Set());
	fullThreadByPostUri.set({});
}
