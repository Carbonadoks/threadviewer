import type { ThreadPost } from '$lib/types';

export type CollapsedBranchMap = Record<string, boolean>;

export function isBranchCollapsed(postUri: string, collapsedBranches: CollapsedBranchMap): boolean {
	return collapsedBranches[postUri] ?? false;
}

export function getVisibleChildren(
	post: ThreadPost,
	collapsedBranches: CollapsedBranchMap
): ThreadPost[] {
	return post.children.filter((child) => !isBranchCollapsed(child.uri, collapsedBranches));
}

export function buildParentMap(rootPost: ThreadPost): Map<string, ThreadPost> {
	const map = new Map<string, ThreadPost>();

	function walk(post: ThreadPost) {
		for (const child of post.children) {
			map.set(child.uri, post);
			walk(child);
		}
	}

	walk(rootPost);
	return map;
}

export function findFirstMatchingPost(
	rootPost: ThreadPost,
	matcher: (post: ThreadPost) => boolean
): ThreadPost | null {
	if (matcher(rootPost)) return rootPost;

	for (const child of rootPost.children) {
		const match = findFirstMatchingPost(child, matcher);
		if (match) return match;
	}

	return null;
}

export function findMatchingPosts(
	rootPost: ThreadPost,
	matcher: (post: ThreadPost) => boolean
): ThreadPost[] {
	const matches: ThreadPost[] = [];

	function walk(post: ThreadPost) {
		if (matcher(post)) {
			matches.push(post);
		}

		for (const child of post.children) {
			walk(child);
		}
	}

	walk(rootPost);
	return matches;
}

export function revealCollapsedPath(
	postUri: string,
	parentMap: Map<string, ThreadPost>,
	collapsedBranches: CollapsedBranchMap
): CollapsedBranchMap {
	const nextCollapsedBranches = { ...collapsedBranches };
	let currentUri: string | undefined = postUri;

	while (currentUri) {
		delete nextCollapsedBranches[currentUri];
		currentUri = parentMap.get(currentUri)?.uri;
	}

	return nextCollapsedBranches;
}

export function revealCollapsedPaths(
	postUris: string[],
	parentMap: Map<string, ThreadPost>,
	collapsedBranches: CollapsedBranchMap
): CollapsedBranchMap {
	let nextCollapsedBranches = { ...collapsedBranches };

	for (const postUri of postUris) {
		nextCollapsedBranches = revealCollapsedPath(postUri, parentMap, nextCollapsedBranches);
	}

	return nextCollapsedBranches;
}

export function buildVisiblePostOrder(
	rootPost: ThreadPost,
	collapsedBranches: CollapsedBranchMap
): ThreadPost[] {
	const result: ThreadPost[] = [];

	function walk(post: ThreadPost) {
		result.push(post);
		for (const child of getVisibleChildren(post, collapsedBranches)) {
			walk(child);
		}
	}

	walk(rootPost);
	return result;
}

export function buildVisibleParentMap(
	rootPost: ThreadPost,
	collapsedBranches: CollapsedBranchMap
): Map<string, ThreadPost> {
	const map = new Map<string, ThreadPost>();

	function walk(post: ThreadPost) {
		for (const child of getVisibleChildren(post, collapsedBranches)) {
			map.set(child.uri, post);
			walk(child);
		}
	}

	walk(rootPost);
	return map;
}

export function countDescendants(post: ThreadPost): number {
	let count = 0;
	for (const child of post.children) {
		count += 1 + countDescendants(child);
	}
	return count;
}
