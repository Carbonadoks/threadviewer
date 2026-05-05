import type { ParsedRepoRecord } from '$lib/utils/carParser';

export const FOLLOW_INTERACTION_KINDS = ['quote', 'repost', 'like', 'reply'] as const;

export type FollowInteractionKind = (typeof FOLLOW_INTERACTION_KINDS)[number];

export interface ResolvedFollowInteraction {
	kind: FollowInteractionKind;
	createdAt: string | null;
	followedDid: string;
	followedAt: string | null;
	targetUri: string;
	sourceUri: string | null;
}

export interface FollowInteractionFollowSummary {
	did: string;
	followedAt: string | null;
	interactions: Record<FollowInteractionKind, ResolvedFollowInteraction | null>;
	interactionCounts: Record<FollowInteractionKind, number>;
	matchedKindCount: number;
	totalInteractionCount: number;
	firstInteractionAt: string | null;
	latestInteractionAt: string | null;
}

export interface FollowInteractionSummary {
	followsCount: number;
	candidateCounts: Record<FollowInteractionKind, number>;
	follows: FollowInteractionFollowSummary[];
}

export interface FollowInteractionResolveProgress {
	stage: 'scan';
	kind: FollowInteractionKind;
	current: number;
	total: number;
	currentKind: number;
	totalKind: number;
	resolvedFollows: number;
	totalFollows: number;
}

type PendingResolvedFollowInteraction = ResolvedFollowInteraction;

type FollowEntry = {
	did: string;
	followedAt: string | null;
	rkey: string;
};

type InteractionCandidate = {
	kind: FollowInteractionKind;
	rkey: string;
	createdAt: string | null;
	targetUri: string;
	sourceUri: string | null;
};

type KindResolutionResult = {
	firstByDid: Map<string, PendingResolvedFollowInteraction>;
	countsByDid: Map<string, number>;
	latestByDid: Map<string, string | null>;
};

const POST_URI_PATTERN = /^at:\/\/([^/]+)\/app\.bsky\.feed\.post\/[^/]+$/;
const RESOLVE_FETCH_WINDOW_SIZE = 100;

function createKindMap<T>(factory: () => T): Record<FollowInteractionKind, T> {
	return {
		quote: factory(),
		repost: factory(),
		like: factory(),
		reply: factory()
	};
}

function parseRecordDate(value: string | null | undefined): number | null {
	if (!value) return null;
	const timestamp = Date.parse(value);
	return Number.isFinite(timestamp) ? timestamp : null;
}

function compareRecordOrder(
	a: { createdAt: string | null; rkey: string },
	b: { createdAt: string | null; rkey: string }
): number {
	const aTime = parseRecordDate(a.createdAt);
	const bTime = parseRecordDate(b.createdAt);
	if (aTime !== null && bTime !== null && aTime !== bTime) {
		return aTime - bTime;
	}
	if (aTime !== null && bTime === null) return -1;
	if (aTime === null && bTime !== null) return 1;
	return a.rkey.localeCompare(b.rkey);
}

function minRecordDate(a: string | null, b: string | null): string | null {
	const aTime = parseRecordDate(a);
	const bTime = parseRecordDate(b);
	if (aTime === null) return b;
	if (bTime === null) return a;
	return aTime <= bTime ? a : b;
}

function maxRecordDate(a: string | null, b: string | null): string | null {
	const aTime = parseRecordDate(a);
	const bTime = parseRecordDate(b);
	if (aTime === null) return b;
	if (bTime === null) return a;
	return aTime >= bTime ? a : b;
}

function isPostUri(uri: unknown): uri is string {
	return typeof uri === 'string' && POST_URI_PATTERN.test(uri);
}

function extractDidFromPostUri(uri: string): string | null {
	const match = uri.match(POST_URI_PATTERN);
	if (!match) return null;
	return match[1]?.startsWith('did:') ? match[1] : null;
}

function getRecordCreatedAt(record: any): string | null {
	return typeof record?.createdAt === 'string' && record.createdAt.trim().length > 0
		? record.createdAt
		: null;
}

function buildRecordUri(did: string, collection: string, rkey: string): string {
	return `at://${did}/${collection}/${rkey}`;
}

function extractFollowedDid(record: any): string | null {
	return typeof record?.subject === 'string' && record.subject.startsWith('did:')
		? record.subject
		: null;
}

function extractSubjectUri(record: any): string | null {
	return isPostUri(record?.subject?.uri) ? record.subject.uri : null;
}

function extractReplyTargetUri(record: any): string | null {
	return isPostUri(record?.reply?.parent?.uri) ? record.reply.parent.uri : null;
}

function extractQuoteTargetUri(record: any): string | null {
	const embed = record?.embed;
	if (!embed || typeof embed !== 'object') return null;

	if (embed.$type === 'app.bsky.embed.record') {
		return isPostUri(embed.record?.uri) ? embed.record.uri : null;
	}

	if (embed.$type === 'app.bsky.embed.recordWithMedia') {
		return isPostUri(embed.record?.uri) ? embed.record.uri : null;
	}

	return null;
}

function buildFollowMap(records: ParsedRepoRecord[]): Map<string, FollowEntry> {
	const follows = new Map<string, FollowEntry>();

	for (const record of records) {
		if (record.collection !== 'app.bsky.graph.follow') continue;
		const followedDid = extractFollowedDid(record.record);
		if (!followedDid) continue;

		const nextEntry: FollowEntry = {
			did: followedDid,
			followedAt: getRecordCreatedAt(record.record),
			rkey: record.rkey
		};
		const existing = follows.get(followedDid);
		if (
			!existing ||
			compareRecordOrder(
				{ createdAt: nextEntry.followedAt, rkey: nextEntry.rkey },
				{ createdAt: existing.followedAt, rkey: existing.rkey }
			) < 0
		) {
			follows.set(followedDid, nextEntry);
		}
	}

	return follows;
}

function buildCandidates(
	did: string,
	records: ParsedRepoRecord[]
): Record<FollowInteractionKind, InteractionCandidate[]> {
	const candidates = createKindMap<InteractionCandidate[]>(() => []);

	for (const record of records) {
		if (record.collection === 'app.bsky.feed.like') {
			const targetUri = extractSubjectUri(record.record);
			if (targetUri) {
				candidates.like.push({
					kind: 'like',
					rkey: record.rkey,
					createdAt: getRecordCreatedAt(record.record),
					targetUri,
					sourceUri: null
				});
			}
			continue;
		}

		if (record.collection === 'app.bsky.feed.repost') {
			const targetUri = extractSubjectUri(record.record);
			if (targetUri) {
				candidates.repost.push({
					kind: 'repost',
					rkey: record.rkey,
					createdAt: getRecordCreatedAt(record.record),
					targetUri,
					sourceUri: null
				});
			}
			continue;
		}

		if (record.collection !== 'app.bsky.feed.post') continue;

		const sourceUri = buildRecordUri(did, record.collection, record.rkey);
		const sourceCreatedAt = getRecordCreatedAt(record.record);

		const replyTargetUri = extractReplyTargetUri(record.record);
		if (replyTargetUri) {
			candidates.reply.push({
				kind: 'reply',
				rkey: record.rkey,
				createdAt: sourceCreatedAt,
				targetUri: replyTargetUri,
				sourceUri
			});
		}

		const quoteTargetUri = extractQuoteTargetUri(record.record);
		if (quoteTargetUri) {
			candidates.quote.push({
				kind: 'quote',
				rkey: record.rkey,
				createdAt: sourceCreatedAt,
				targetUri: quoteTargetUri,
				sourceUri
			});
		}
	}

	for (const kind of FOLLOW_INTERACTION_KINDS) {
		candidates[kind].sort(compareRecordOrder);
	}

	return candidates;
}

async function resolveFirstCandidatesForFollowSet(
	kind: FollowInteractionKind,
	candidates: InteractionCandidate[],
	follows: Map<string, FollowEntry>,
	options: {
		onProgress?: (completed: number, resolvedFollows: number) => void;
		fetchWindowSize?: number;
	} = {}
): Promise<KindResolutionResult> {
	const { onProgress, fetchWindowSize = RESOLVE_FETCH_WINDOW_SIZE } = options;
	const firstByDid = new Map<string, PendingResolvedFollowInteraction>();
	const countsByDid = new Map<string, number>();
	const latestByDid = new Map<string, string | null>();

	onProgress?.(0, 0);
	for (let index = 0; index < candidates.length; index += fetchWindowSize) {
		const batch = candidates.slice(index, index + fetchWindowSize);

		for (const candidate of batch) {
			const targetDid = extractDidFromPostUri(candidate.targetUri);
			if (!targetDid) continue;

			const followedEntry = follows.get(targetDid);
			if (!followedEntry) continue;

			countsByDid.set(followedEntry.did, (countsByDid.get(followedEntry.did) ?? 0) + 1);
			latestByDid.set(
				followedEntry.did,
				maxRecordDate(latestByDid.get(followedEntry.did) ?? null, candidate.createdAt)
			);

			if (!firstByDid.has(followedEntry.did)) {
				firstByDid.set(followedEntry.did, {
					kind,
					createdAt: candidate.createdAt,
					followedDid: followedEntry.did,
					followedAt: followedEntry.followedAt,
					targetUri: candidate.targetUri,
					sourceUri: candidate.sourceUri
				});
			}
		}

		onProgress?.(Math.min(index + batch.length, candidates.length), firstByDid.size);
	}

	return {
		firstByDid,
		countsByDid,
		latestByDid
	};
}

export async function resolveFirstFollowInteractions(
	did: string,
	records: ParsedRepoRecord[],
	options: {
		onProgress?: (progress: FollowInteractionResolveProgress) => void;
		fetchWindowSize?: number;
	} = {}
): Promise<FollowInteractionSummary> {
	const { onProgress, fetchWindowSize = RESOLVE_FETCH_WINDOW_SIZE } = options;
	const follows = buildFollowMap(records);
	const candidates = buildCandidates(did, records);
	if (follows.size === 0) {
		return {
			followsCount: 0,
			candidateCounts: {
				quote: candidates.quote.length,
				repost: candidates.repost.length,
				like: candidates.like.length,
				reply: candidates.reply.length
			},
			follows: []
		};
	}

	const totalCandidates = FOLLOW_INTERACTION_KINDS.reduce(
		(sum, kind) => sum + candidates[kind].length,
		0
	);
	const followSummaries = [...follows.values()]
		.sort((a, b) =>
			compareRecordOrder(
				{ createdAt: a.followedAt, rkey: a.rkey },
				{ createdAt: b.followedAt, rkey: b.rkey }
			)
		)
		.map<FollowInteractionFollowSummary>((follow) => ({
			did: follow.did,
			followedAt: follow.followedAt,
			interactions: createKindMap<ResolvedFollowInteraction | null>(() => null),
			interactionCounts: createKindMap<number>(() => 0),
			matchedKindCount: 0,
			totalInteractionCount: 0,
			firstInteractionAt: null,
			latestInteractionAt: null
		}));
	const followSummaryByDid = new Map(followSummaries.map((follow) => [follow.did, follow]));
	const latestByDid = new Map(followSummaries.map((follow) => [follow.did, null as string | null]));
	let processedCandidates = 0;

	for (const kind of FOLLOW_INTERACTION_KINDS) {
		const totalKind = candidates[kind].length;
		const resolvedForKind = await resolveFirstCandidatesForFollowSet(
			kind,
			candidates[kind],
			follows,
			{
				fetchWindowSize,
				onProgress: (currentKind, resolvedFollows) => {
					onProgress?.({
						stage: 'scan',
						kind,
						current: Math.min(processedCandidates + currentKind, totalCandidates),
						total: totalCandidates,
						currentKind,
						totalKind,
						resolvedFollows,
						totalFollows: follows.size
					});
				}
			}
		);

		for (const [followDid, interaction] of resolvedForKind.firstByDid) {
			followSummaryByDid.get(followDid)!.interactions[kind] = interaction;
		}
		for (const [followDid, count] of resolvedForKind.countsByDid) {
			followSummaryByDid.get(followDid)!.interactionCounts[kind] = count;
		}
		for (const [followDid, latestAt] of resolvedForKind.latestByDid) {
			latestByDid.set(followDid, maxRecordDate(latestByDid.get(followDid) ?? null, latestAt));
		}

		processedCandidates += totalKind;
	}

	for (const follow of followSummaries) {
		follow.matchedKindCount = FOLLOW_INTERACTION_KINDS.filter(
			(kind) => follow.interactions[kind] !== null
		).length;
		follow.totalInteractionCount = FOLLOW_INTERACTION_KINDS.reduce(
			(sum, kind) => sum + follow.interactionCounts[kind],
			0
		);
		follow.firstInteractionAt = FOLLOW_INTERACTION_KINDS.reduce<string | null>(
			(earliest, kind) => minRecordDate(earliest, follow.interactions[kind]?.createdAt ?? null),
			null
		);
		follow.latestInteractionAt = latestByDid.get(follow.did) ?? null;
	}

	return {
		followsCount: follows.size,
		candidateCounts: {
			quote: candidates.quote.length,
			repost: candidates.repost.length,
			like: candidates.like.length,
			reply: candidates.reply.length
		},
		follows: followSummaries
	};
}
