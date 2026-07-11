import type { ParsedRepoRecord } from '$lib/utils/carParser';

const POST_COLLECTION = 'app.bsky.feed.post';
const MENTION_FACET_TYPE = 'app.bsky.richtext.facet#mention';
const POST_URI_PATTERN = /^at:\/\/[^/]+\/app\.bsky\.feed\.post\/[^/]+$/;

export interface MentionPost {
	/** at:// URI of the repo owner's post that contains the mention. */
	uri: string;
	/** Thread root URI (reply.root.uri when present, else the post URI itself). */
	rootUri: string;
	/** Direct parent URI when the post is a reply, else null. */
	parentUri: string | null;
	text: string;
	createdAt: string | null;
	isReply: boolean;
}

export interface MentionedUser {
	did: string;
	/** Number of repo posts that mention this account. */
	mentionPostCount: number;
	/** Total mention occurrences (a post mentioning the same account twice counts twice). */
	mentionInstanceCount: number;
	firstMentionedAt: string | null;
	lastMentionedAt: string | null;
	/** Posts that mention this account, newest first. */
	posts: MentionPost[];
}

export interface RepoMentionsSummary {
	ownerDid: string;
	scannedPosts: number;
	postsWithMentions: number;
	totalMentionInstances: number;
	uniqueMentionedUsers: number;
	/** Sorted by mentionPostCount desc, then lastMentionedAt desc, then did. */
	users: MentionedUser[];
}

function toText(value: unknown): string {
	return typeof value === 'string' ? value : '';
}

function isPostUri(value: unknown): value is string {
	return typeof value === 'string' && POST_URI_PATTERN.test(value);
}

function getCreatedAt(record: any): string | null {
	const value = toText(record?.createdAt).trim();
	return value.length > 0 ? value : null;
}

function parseDate(value: string | null): number | null {
	if (!value) return null;
	const timestamp = Date.parse(value);
	return Number.isFinite(timestamp) ? timestamp : null;
}

function minDate(a: string | null, b: string | null): string | null {
	const aTime = parseDate(a);
	const bTime = parseDate(b);
	if (aTime === null) return b;
	if (bTime === null) return a;
	return aTime <= bTime ? a : b;
}

function maxDate(a: string | null, b: string | null): string | null {
	const aTime = parseDate(a);
	const bTime = parseDate(b);
	if (aTime === null) return b;
	if (bTime === null) return a;
	return aTime >= bTime ? a : b;
}

function compareDateDesc(a: string | null, b: string | null): number {
	const aTime = parseDate(a);
	const bTime = parseDate(b);
	if (aTime === null && bTime === null) return 0;
	if (aTime === null) return 1;
	if (bTime === null) return -1;
	return bTime - aTime;
}

function extractMentionDids(record: any, ownerDid: string): Map<string, number> {
	const perPost = new Map<string, number>();
	const facets = Array.isArray(record?.facets) ? record.facets : [];

	for (const facet of facets) {
		const features = Array.isArray(facet?.features) ? facet.features : [];
		for (const feature of features) {
			if (toText(feature?.$type) !== MENTION_FACET_TYPE) continue;
			const did = toText(feature?.did).trim();
			if (!did.startsWith('did:') || did === ownerDid) continue;
			perPost.set(did, (perPost.get(did) ?? 0) + 1);
		}
	}

	return perPost;
}

/**
 * Extract every mentioned account from a parsed repo's post records.
 *
 * Works on the `ParsedRepoRecord[]` produced by `parseCarRecordsWasm`. Only
 * `app.bsky.feed.post` records are scanned; self-mentions are skipped to match
 * `cachedSummary.ts`.
 */
export function extractRepoMentions(
	ownerDid: string,
	records: ParsedRepoRecord[]
): RepoMentionsSummary {
	const usersByDid = new Map<string, MentionedUser>();
	let scannedPosts = 0;
	let postsWithMentions = 0;
	let totalMentionInstances = 0;

	for (const record of records) {
		if (record.collection !== POST_COLLECTION) continue;
		scannedPosts += 1;

		const value = record.record ?? {};
		const perPostDids = extractMentionDids(value, ownerDid);
		if (perPostDids.size === 0) continue;

		postsWithMentions += 1;
		const uri = `at://${ownerDid}/${POST_COLLECTION}/${record.rkey}`;
		const createdAt = getCreatedAt(value);
		const rootUri = isPostUri(value?.reply?.root?.uri) ? value.reply.root.uri : uri;
		const parentUri = isPostUri(value?.reply?.parent?.uri) ? value.reply.parent.uri : null;
		const mentionPost: MentionPost = {
			uri,
			rootUri,
			parentUri,
			text: toText(value?.text),
			createdAt,
			isReply: Boolean(value?.reply)
		};

		for (const [did, instances] of perPostDids) {
			totalMentionInstances += instances;
			let entry = usersByDid.get(did);
			if (!entry) {
				entry = {
					did,
					mentionPostCount: 0,
					mentionInstanceCount: 0,
					firstMentionedAt: null,
					lastMentionedAt: null,
					posts: []
				};
				usersByDid.set(did, entry);
			}
			entry.mentionPostCount += 1;
			entry.mentionInstanceCount += instances;
			entry.posts.push(mentionPost);
			entry.firstMentionedAt = minDate(entry.firstMentionedAt, createdAt);
			entry.lastMentionedAt = maxDate(entry.lastMentionedAt, createdAt);
		}
	}

	const users = [...usersByDid.values()];
	for (const user of users) {
		user.posts.sort(
			(a, b) => compareDateDesc(a.createdAt, b.createdAt) || a.uri.localeCompare(b.uri)
		);
	}
	users.sort(
		(a, b) =>
			b.mentionPostCount - a.mentionPostCount ||
			b.mentionInstanceCount - a.mentionInstanceCount ||
			compareDateDesc(a.lastMentionedAt, b.lastMentionedAt) ||
			a.did.localeCompare(b.did)
	);

	return {
		ownerDid,
		scannedPosts,
		postsWithMentions,
		totalMentionInstances,
		uniqueMentionedUsers: users.length,
		users
	};
}

/**
 * Group a mentioned account's posts by thread root, newest mention first, so
 * the page can fetch each conversation once. Returns up to `limit` roots.
 */
export interface MentionThreadGroup {
	rootUri: string;
	latestMentionAt: string | null;
	mentionPostUris: string[];
}

export function groupMentionPostsByThread(
	posts: MentionPost[],
	limit = Infinity
): MentionThreadGroup[] {
	const byRoot = new Map<string, { rootUri: string; latestMentionAt: string | null; uris: Set<string> }>();

	for (const post of posts) {
		const existing = byRoot.get(post.rootUri);
		if (existing) {
			existing.uris.add(post.uri);
			existing.latestMentionAt = maxDate(existing.latestMentionAt, post.createdAt);
		} else {
			byRoot.set(post.rootUri, {
				rootUri: post.rootUri,
				latestMentionAt: post.createdAt,
				uris: new Set([post.uri])
			});
		}
	}

	return [...byRoot.values()]
		.sort(
			(a, b) => compareDateDesc(a.latestMentionAt, b.latestMentionAt) || a.rootUri.localeCompare(b.rootUri)
		)
		.slice(0, limit)
		.map((group) => ({
			rootUri: group.rootUri,
			latestMentionAt: group.latestMentionAt,
			mentionPostUris: [...group.uris]
		}));
}
