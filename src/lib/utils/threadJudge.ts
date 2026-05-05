import type { SelfReplyThread, ThreadJudgePost, ThreadPost } from '$lib/types';

type CollectedPost = {
	post: ThreadPost;
	depth: number;
	traversalOrder: number;
};

function createdAtMs(value: string): number {
	const timestamp = new Date(value).getTime();
	return Number.isFinite(timestamp) ? timestamp : Number.MAX_SAFE_INTEGER;
}

export function serializeThreadForJudging(thread: SelfReplyThread): ThreadJudgePost[] {
	const collected: CollectedPost[] = [];
	let traversalOrder = 0;

	function walk(node: ThreadPost, depth: number) {
		collected.push({
			post: node,
			depth,
			traversalOrder: traversalOrder++
		});

		for (const child of node.children) {
			walk(child, depth + 1);
		}
	}

	walk(thread.rootPost, 0);

	if (collected.length === 0) {
		return [];
	}

	const [root, ...rest] = collected;
	rest.sort((left, right) => {
		const timeDelta = createdAtMs(left.post.createdAt) - createdAtMs(right.post.createdAt);
		if (timeDelta !== 0) return timeDelta;
		if (left.depth !== right.depth) return left.depth - right.depth;
		return left.traversalOrder - right.traversalOrder;
	});

	const ordered = [root, ...rest];
	const uriToIndex = new Map<string, number>();

	for (const [offset, item] of ordered.entries()) {
		uriToIndex.set(item.post.uri, offset + 1);
	}

	return ordered.map((item, offset) => ({
		index: offset + 1,
		uri: item.post.uri,
		author: {
			did: item.post.author.did,
			handle: item.post.author.handle,
			displayName: item.post.author.displayName
		},
		createdAt: item.post.createdAt,
		text: item.post.text,
		depth: item.depth,
		replyToIndex: item.post.parentUri ? (uriToIndex.get(item.post.parentUri) ?? null) : null
	}));
}
