import type { ThreadPost } from '$lib/types';

export type RecordEmbed = NonNullable<NonNullable<ThreadPost['embed']>['record']>;

export function hasRenderableRecordEmbedContent(record: RecordEmbed): boolean {
	return record.text.trim().length > 0 || Boolean(record.images?.length) || Boolean(record.video?.playlist);
}

export function mergeRecordEmbed(base: RecordEmbed, incoming: RecordEmbed): RecordEmbed {
	return {
		uri: incoming.uri || base.uri,
		author: {
			handle: incoming.author.handle || base.author.handle,
			displayName: incoming.author.displayName || base.author.displayName,
			avatar: incoming.author.avatar || base.author.avatar
		},
		text: incoming.text || base.text,
		createdAt: incoming.createdAt || base.createdAt,
		images: incoming.images?.length ? incoming.images : base.images,
		video: incoming.video?.playlist ? incoming.video : base.video
	};
}
