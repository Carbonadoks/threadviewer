import type { ThreadPost } from '$lib/types';

function postTime(post: ThreadPost): number {
	const value = new Date(post.createdAt).getTime();
	return Number.isFinite(value) ? value : 0;
}

function comparePostsByCreatedAt(a: ThreadPost, b: ThreadPost): number {
	const timeDelta = postTime(a) - postTime(b);
	if (timeDelta !== 0) return timeDelta;
	return a.uri.localeCompare(b.uri);
}

export function collectSelfReplyChainPosts(root: ThreadPost): ThreadPost[] {
	const authorDid = root.author.did;
	const posts: ThreadPost[] = [];
	const seen = new Set<string>();

	function walk(node: ThreadPost): void {
		if (seen.has(node.uri)) return;
		seen.add(node.uri);
		posts.push(node);

		for (const child of node.children) {
			if (child.author.did !== authorDid) continue;
			if (child.parentUri && child.parentUri !== node.uri) continue;
			walk(child);
		}
	}

	walk(root);
	return posts.sort(comparePostsByCreatedAt);
}

export function findSelfReplyChainRoot(root: ThreadPost, selectedUri: string): ThreadPost {
	const postsByUri = new Map<string, ThreadPost>();
	const parentByUri = new Map<string, ThreadPost>();

	function walk(node: ThreadPost): void {
		postsByUri.set(node.uri, node);
		for (const child of node.children) {
			parentByUri.set(child.uri, node);
			walk(child);
		}
	}

	walk(root);

	let current = postsByUri.get(selectedUri) ?? root;
	const chainAuthorDid = current.author.did;

	while (current.parentUri) {
		const parent = parentByUri.get(current.uri) ?? postsByUri.get(current.parentUri);
		if (!parent || parent.author.did !== chainAuthorDid) break;
		current = parent;
	}

	return current;
}

export function measureSelfReplyChainDepth(root: ThreadPost): number {
	const authorDid = root.author.did;

	function measure(node: ThreadPost): number {
		const childDepths = node.children
			.filter((child) => child.author.did === authorDid && (!child.parentUri || child.parentUri === node.uri))
			.map((child) => measure(child));
		return 1 + (childDepths.length > 0 ? Math.max(...childDepths) : 0);
	}

	return measure(root);
}

export function countThreadPosts(root: ThreadPost): number {
	let count = 0;

	function walk(node: ThreadPost): void {
		count += 1;
		for (const child of node.children) {
			walk(child);
		}
	}

	walk(root);
	return count;
}

export function splitPostIntoBlogParagraphs(text: string): string[] {
	return text
		.replace(/\r\n/g, '\n')
		.trim()
		.split(/\n{2,}/)
		.map((paragraph) => paragraph.replace(/\n/g, ' ').trim())
		.filter(Boolean);
}

export function buildBlogTitle(text: string, fallback = 'Untitled thread'): string {
	const cleaned = text
		.replace(/\s+/g, ' ')
		.trim();
	if (!cleaned) return fallback;

	const sentenceEnd = cleaned.search(/[.!?](\s|$)/);
	const candidate = sentenceEnd >= 12 ? cleaned.slice(0, sentenceEnd + 1) : cleaned;
	if (candidate.length <= 96) return candidate;

	const truncated = candidate.slice(0, 96).trimEnd();
	const lastSpace = truncated.lastIndexOf(' ');
	return `${truncated.slice(0, lastSpace > 48 ? lastSpace : truncated.length).trimEnd()}...`;
}
