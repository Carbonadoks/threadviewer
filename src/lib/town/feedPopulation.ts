import type { Agent, AppBskyFeedDefs } from '@atproto/api';
import {
	fetchPersonalFeedPosts,
	type PersonalFeedOption
} from '$lib/api/blueskyAuth';
import {
	buildBskyPostUrl,
	extractBskyPostUrlsFromFacets
} from '$lib/utils/viewerLinks';
import type { TownDialogueLine, TownNpcData } from '$lib/town/types';
import { parsePostViewEmbed } from '$lib/utils/threadWalker';

const DEFAULT_MAX_NPCS = 400;
const DEFAULT_MAX_PAGES = 24;

const palette = [
	'#d95d39',
	'#2a9d8f',
	'#5c7aff',
	'#e9c46a',
	'#c44569',
	'#4d908e',
	'#9c6644',
	'#577590',
	'#8ab17d',
	'#b56576'
];

const timestampFormatter = new Intl.DateTimeFormat('en-US', {
	month: 'short',
	day: '2-digit',
	hour: '2-digit',
	minute: '2-digit',
	hour12: false
});

export type TownPopulationResult = {
	npcs: TownNpcData[];
	scannedPosts: number;
	uniqueAuthors: number;
};

function hashString(input: string): number {
	let hash = 0;
	for (let index = 0; index < input.length; index++) {
		hash = (hash * 31 + input.charCodeAt(index)) >>> 0;
	}
	return hash;
}

function pickColorHex(seed: string): string {
	return palette[hashString(seed) % palette.length];
}

function normalizeDialogueText(text: string): string {
	return text.trim();
}

function buildFallbackDialogue(post: any): string {
	const embedType = post?.embed?.$type ?? '';
	if (embedType.includes('images')) return '[shared images]';
	if (embedType.includes('external')) return '[shared a link]';
	if (embedType.includes('recordWithMedia')) return '[shared a quoted post with media]';
	if (embedType.includes('record')) return '[shared a quoted post]';
	return '[shared a post without text]';
}

function buildDialogueLine(post: any, authorHandle: string): TownDialogueLine {
	const createdAt = post?.record?.createdAt ?? post?.indexedAt ?? new Date().toISOString();
	const text = normalizeDialogueText(post?.record?.text ?? '') || buildFallbackDialogue(post);
	const uri = post?.uri ?? `${authorHandle}:${createdAt}`;
	return {
		id: uri,
		uri,
		text,
		createdAtLabel: timestampFormatter.format(new Date(createdAt)),
		permalink: buildBskyPostUrl(uri, authorHandle),
		linkedUrls: extractBskyPostUrlsFromFacets(post?.record?.facets),
		embed: parsePostViewEmbed(post?.embed)
	};
}

function buildPopulationFromPosts(
	feedItems: AppBskyFeedDefs.FeedViewPost[],
	maxNpcs: number
): TownNpcData[] {
	const authors = new Map<string, TownNpcData>();

	for (const item of feedItems) {
		const post = item?.post as any;
		const author = post?.author as any;
		const did = String(author?.did ?? '').trim();
		const handle = String(author?.handle ?? '').trim();
		if (!did || !handle) continue;

		if (!authors.has(did) && authors.size >= maxNpcs) continue;

		let npc = authors.get(did);
		if (!npc) {
			npc = {
				id: did,
				did,
				handle,
				displayName: String(author?.displayName ?? handle).trim() || handle,
				avatar: typeof author?.avatar === 'string' ? author.avatar : null,
				colorHex: pickColorHex(did),
				lines: []
			};
			authors.set(did, npc);
		}

		const line = buildDialogueLine(post, handle);
		if (!npc.lines.some((entry) => entry.id === line.id)) {
			npc.lines.push(line);
		}
	}

	for (const npc of authors.values()) {
		if (npc.lines.length === 0) {
			npc.lines.push({
				id: `${npc.id}:fallback`,
				uri: `${npc.id}:fallback`,
				text: '[waiting for a post to talk about]',
				createdAtLabel: '--',
				permalink: null,
				linkedUrls: []
			});
		}
	}

	return [...authors.values()];
}

export async function fetchTownPopulation(
	agent: Agent,
	feed: PersonalFeedOption,
	options: {
		maxNpcs?: number;
		maxPages?: number;
	} = {}
): Promise<TownPopulationResult> {
	const maxNpcs = options.maxNpcs ?? DEFAULT_MAX_NPCS;
	const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
	const collectedPosts: AppBskyFeedDefs.FeedViewPost[] = [];
	const seenAuthors = new Set<string>();

	let cursor: string | undefined;
	for (let pageIndex = 0; pageIndex < maxPages; pageIndex++) {
		const page = await fetchPersonalFeedPosts(agent, feed, cursor);
		collectedPosts.push(...page.posts);

		for (const item of page.posts) {
			const did = String((item as any)?.post?.author?.did ?? '').trim();
			if (did) seenAuthors.add(did);
		}

		cursor = page.cursor;
		if (!cursor || seenAuthors.size >= maxNpcs) break;
	}

	return {
		npcs: buildPopulationFromPosts(collectedPosts, maxNpcs),
		scannedPosts: collectedPosts.length,
		uniqueAuthors: seenAuthors.size
	};
}
