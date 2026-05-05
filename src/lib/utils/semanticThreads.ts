import type { SelfReplyThread, ThreadPost } from '$lib/types';
import { measureDepth } from '$lib/utils/threadWalker';

export interface SemanticThreadSourcePost {
	uri: string;
	createdAt: string;
	parentUri: string | null;
	threadRootUri: string | null;
	text: string;
}

export interface SemanticThreadSourceAuthor {
	did: string;
	handle: string;
	displayName: string | null;
	avatar: string | null;
}

export interface SemanticThreadBuildResult {
	threads: SelfReplyThread[];
	rootUriByPostUri: Map<string, string>;
}

function safeTimestamp(value: string): number {
	const parsed = new Date(value);
	return Number.isFinite(parsed.getTime()) ? parsed.getTime() : 0;
}

export function compareIsoDateAsc(a: string, b: string): number {
	return safeTimestamp(a) - safeTimestamp(b) || a.localeCompare(b);
}

export function compareIsoDateDesc(a: string, b: string): number {
	return safeTimestamp(b) - safeTimestamp(a) || a.localeCompare(b);
}

function cleanHandle(handle: string | null | undefined, did: string): string {
	const cleaned = (handle ?? '').replace(/^@/, '').trim();
	return cleaned || did || 'unknown';
}

function buildThreadPost(
	post: SemanticThreadSourcePost,
	author: SemanticThreadSourceAuthor
): ThreadPost {
	return {
		uri: post.uri,
		cid: '',
		author: {
			did: author.did,
			handle: cleanHandle(author.handle, author.did),
			displayName: author.displayName || undefined,
			avatar: author.avatar || undefined
		},
		text: post.text,
		createdAt: post.createdAt,
		needsHydratedPostView: true,
		likeCount: 0,
		repostCount: 0,
		replyCount: 0,
		quoteCount: 0,
		parentUri: post.parentUri || undefined,
		children: []
	};
}

function sortChildrenChronologically(post: ThreadPost) {
	post.children.sort(
		(a, b) => compareIsoDateAsc(a.createdAt, b.createdAt) || a.uri.localeCompare(b.uri)
	);
	for (const child of post.children) {
		sortChildrenChronologically(child);
	}
}

function assignRootUri(node: ThreadPost, rootUri: string, rootUriByPostUri: Map<string, string>) {
	rootUriByPostUri.set(node.uri, rootUri);
	for (const child of node.children) {
		assignRootUri(child, rootUri, rootUriByPostUri);
	}
}

export function buildSemanticSelfReplyThreads(
	posts: SemanticThreadSourcePost[],
	author: SemanticThreadSourceAuthor
): SemanticThreadBuildResult {
	const postsByUri = new Map<string, ThreadPost>();
	const parentUriByPostUri = new Map<string, string>();
	const threadRootUriByPostUri = new Map<string, string>();

	for (const post of posts) {
		postsByUri.set(post.uri, buildThreadPost(post, author));
		if (post.parentUri) {
			parentUriByPostUri.set(post.uri, post.parentUri);
		}
		if (post.threadRootUri) {
			threadRootUriByPostUri.set(post.uri, post.threadRootUri);
		}
	}

	const childUris = new Set<string>();
	for (const [childUri, parentUri] of parentUriByPostUri) {
		const parent = postsByUri.get(parentUri);
		const child = postsByUri.get(childUri);
		if (!parent || !child) continue;
		parent.children.push(child);
		childUris.add(childUri);
	}

	for (const [childUri, threadRootUri] of threadRootUriByPostUri) {
		if (childUris.has(childUri)) continue;
		if (childUri === threadRootUri) continue;
		const threadRoot = postsByUri.get(threadRootUri);
		const child = postsByUri.get(childUri);
		if (!threadRoot || !child) continue;
		threadRoot.children.push(child);
		childUris.add(childUri);
	}

	const threads: SelfReplyThread[] = [];
	for (const [uri, post] of postsByUri) {
		if (childUris.has(uri)) continue;
		sortChildrenChronologically(post);
		threads.push({
			rootPost: post,
			depth: measureDepth(post),
			rootUri: uri
		});
	}

	threads.sort(
		(a, b) =>
			compareIsoDateDesc(a.rootPost.createdAt, b.rootPost.createdAt) ||
			a.rootUri.localeCompare(b.rootUri)
	);

	const rootUriByPostUri = new Map<string, string>();
	for (const thread of threads) {
		assignRootUri(thread.rootPost, thread.rootUri, rootUriByPostUri);
	}

	return {
		threads,
		rootUriByPostUri
	};
}
