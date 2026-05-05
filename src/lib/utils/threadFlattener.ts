import type { ThreadPost } from '$lib/types';

export interface FlatPost {
	post: ThreadPost;
	depth: number;
}

export function flattenThread(root: ThreadPost): FlatPost[] {
	const result: FlatPost[] = [];

	function walk(node: ThreadPost, depth: number) {
		result.push({ post: node, depth });
		for (const child of node.children) {
			walk(child, depth + 1);
		}
	}

	walk(root, 0);
	return result;
}

export interface ChatFlatPost {
	post: ThreadPost;
	showAuthorHeader: boolean;
	replyQuote: ThreadPost | null;
}

export function flattenThreadForChat(root: ThreadPost): ChatFlatPost[] {
	// Collect all posts via DFS
	const allPosts: ThreadPost[] = [];
	function collect(node: ThreadPost) {
		allPosts.push(node);
		for (const child of node.children) {
			collect(child);
		}
	}
	collect(root);

	// Sort chronologically
	allPosts.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

	// Build lookup map for reply quotes
	const postMap = new Map<string, ThreadPost>();
	for (const p of allPosts) {
		postMap.set(p.uri, p);
	}

	// Build chat flat posts
	const result: ChatFlatPost[] = [];
	for (let i = 0; i < allPosts.length; i++) {
		const post = allPosts[i];
		const prev = i > 0 ? allPosts[i - 1] : null;

		const showAuthorHeader = !prev || prev.author.did !== post.author.did;

		let replyQuote: ThreadPost | null = null;
		if (post.parentUri && prev && post.parentUri !== prev.uri) {
			replyQuote = postMap.get(post.parentUri) ?? null;
		}

		result.push({ post, showAuthorHeader, replyQuote });
	}

	return result;
}
