import type { SelfReplyThread, ThreadPost } from '../types';

export type LoadedQuoteThread = {
	uri: string;
	thread: SelfReplyThread & { isTruncated?: boolean };
};

/** Download independently of rendering, preserving quote order despite concurrent requests. */
export async function downloadQuoteThreads(
	posts: ThreadPost[],
	skipUris: Set<string>,
	loadThread: (uri: string) => Promise<LoadedQuoteThread['thread']>,
	onProgress: (completed: number, total: number) => void = () => {}
): Promise<{ threads: LoadedQuoteThread[]; failed: number }> {
	const seen = new Set(skipUris);
	const candidates = posts.filter((post) => {
		if (!post.uri.startsWith('at://') || seen.has(post.uri)) return false;
		seen.add(post.uri);
		return true;
	});
	const results: Array<LoadedQuoteThread | undefined> = new Array(candidates.length);
	let nextIndex = 0;
	let completed = 0;
	let failed = 0;
	onProgress(0, candidates.length);
	await Promise.all(Array.from({ length: Math.min(5, candidates.length) }, async () => {
		while (nextIndex < candidates.length) {
			const index = nextIndex++;
			const post = candidates[index];
			try {
				const thread = post.replyCount === 0 && !post.parentUri
					? { rootPost: { ...post, children: [] }, rootUri: post.uri, depth: 1 }
					: await loadThread(post.uri);
				results[index] = { uri: post.uri, thread };
			} catch {
				failed += 1;
			}
			onProgress(++completed, candidates.length);
		}
	}));
	return { threads: results.filter((result): result is LoadedQuoteThread => !!result), failed };
}

export type QuoteDownloadCommand =
	| { type: 'download'; sourceUri: string; skipUris: string[]; posts?: ThreadPost[] }
	| { type: 'publish' };
export type QuoteDownloadEvent =
	| { type: 'progress'; completed: number; total: number }
	| { type: 'ready'; count: number; failed: number }
	| { type: 'result'; posts: ThreadPost[]; threads: LoadedQuoteThread[]; failed: number }
	| { type: 'error'; error: string };
