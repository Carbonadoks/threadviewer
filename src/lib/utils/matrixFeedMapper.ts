import type { MatrixTerminalPost } from '$lib/components/MatrixFeedTerminal.svelte';
import { buildBskyPostUrl } from '$lib/utils/viewerLinks';

const timestampFormatter = new Intl.DateTimeFormat('en-US', {
	month: 'short',
	day: '2-digit',
	hour: '2-digit',
	minute: '2-digit',
	hour12: false
});

function buildMetaLabel(post: any): string {
	const stats = [
		`L${post.likeCount ?? 0}`,
		`R${post.repostCount ?? 0}`,
		`P${post.replyCount ?? 0}`
	];

	if (post.embed?.$type === 'app.bsky.embed.images#view') {
		stats.push(`IMG${post.embed.images?.length ?? 0}`);
	} else if (post.embed?.$type === 'app.bsky.embed.external#view') {
		stats.push('LINK');
	} else if (post.embed?.$type === 'app.bsky.embed.recordWithMedia#view') {
		stats.push('STACK');
	} else if (post.embed?.$type === 'app.bsky.embed.record#view') {
		stats.push('QUOTE');
	}

	return stats.join(' :: ');
}

function normalizeBody(text: string): string {
	const clean = text.replace(/\r/g, '').trim();
	return clean.length > 0 ? clean : '[no text body]';
}

export function mapFeedItem(item: any): MatrixTerminalPost | null {
	const post = item?.post;
	if (!post?.uri || !post?.author?.handle) return null;

	return {
		id: post.uri,
		authorHandle: post.author.handle,
		createdAtLabel: timestampFormatter.format(
			new Date(post.record?.createdAt || post.indexedAt || Date.now())
		),
		metaLabel: buildMetaLabel(post),
		body: normalizeBody(post.record?.text || ''),
		permalink: buildBskyPostUrl(post.uri, post.author.handle)
	};
}
