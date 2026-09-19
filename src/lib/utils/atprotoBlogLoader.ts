import { resolvePds } from '$lib/utils/pdsResolver';
import {
	KNOWN_BLOG_COLLECTIONS,
	PUBLICATION_COLLECTIONS,
	contentToBlocks,
	dedupePosts,
	heuristicRecordToPost,
	isIgnoredCollection,
	isPubliclyVisible,
	markdownToBlocks,
	parseAtUri,
	recordToPublication,
	scoreCollection,
	stripDuplicateTitle,
	blocksText,
	type BlogPost,
	type BlogPublication,
	type RepoContext,
	type RepoRecord
} from '$lib/utils/atprotoBlog';

const PUBLIC_APPVIEW = 'https://public.api.bsky.app';
const PAGE_LIMIT = 100;
const MAX_PAGES_KNOWN = 20;
const MAX_PAGES_HEURISTIC = 5;
const HEURISTIC_SAMPLE = 10;

export interface ReaderIdentity {
	did: string;
	handle?: string;
	pds: string;
	displayName?: string;
	avatar?: string;
	bio?: string;
}

export interface ReaderSource {
	collection: string;
	label: string;
	count: number;
	heuristic: boolean;
	reason?: string;
}

export interface ReaderBlog {
	identity: ReaderIdentity;
	publications: BlogPublication[];
	posts: BlogPost[];
	sources: ReaderSource[];
	/** Every collection in the repo, for transparency in the UI. */
	collections: string[];
	warnings: string[];
}

export type ReaderProgress = (message: string) => void;

async function getJson(url: string): Promise<any> {
	const res = await fetch(url);
	if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
	return res.json();
}

/** Accepts a handle, @handle, DID, at:// URI, bsky.app profile URL or pds.ls URL. */
export function extractActor(input: string): string | null {
	let s = input.trim();
	if (!s) return null;
	s = s.replace(/^https?:\/\/pds\.ls\//i, '');
	const at = /^at:\/\/([^/]+)/.exec(s);
	if (at) return decodeURIComponent(at[1]);
	const profile = /^https?:\/\/[^/]+\/profile\/([^/?#]+)/i.exec(s);
	if (profile) return decodeURIComponent(profile[1]);
	s = s.replace(/^@/, '').replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
	if (s.startsWith('did:')) return s;
	return /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(s) ? s.toLowerCase() : null;
}

async function resolveHandle(handle: string): Promise<string> {
	try {
		const data = await getJson(
			`${PUBLIC_APPVIEW}/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(handle)}`
		);
		if (typeof data?.did === 'string') return data.did;
	} catch {
		// fall through to well-known
	}
	const res = await fetch(`https://${handle}/.well-known/atproto-did`);
	if (res.ok) {
		const did = (await res.text()).trim();
		if (did.startsWith('did:')) return did;
	}
	throw new Error(`Could not resolve handle "${handle}".`);
}

async function handleFromDidDoc(did: string): Promise<string | undefined> {
	try {
		const url = did.startsWith('did:plc:')
			? `https://plc.directory/${encodeURIComponent(did)}`
			: `https://${did.slice('did:web:'.length).replace(/%3A/gi, ':')}/.well-known/did.json`;
		const doc = await getJson(url);
		const aka = (doc?.alsoKnownAs ?? []).find((a: unknown) => typeof a === 'string' && a.startsWith('at://'));
		return aka ? aka.slice('at://'.length) : undefined;
	} catch {
		return undefined;
	}
}

export async function resolveIdentity(input: string): Promise<ReaderIdentity> {
	const actor = extractActor(input);
	if (!actor) throw new Error('Enter a handle (alice.bsky.social) or a DID.');
	const did = actor.startsWith('did:') ? actor : await resolveHandle(actor);
	const pds = await resolvePds(did);
	if (!pds) throw new Error(`Could not find a PDS for ${did}.`);

	const identity: ReaderIdentity = { did, pds, handle: actor.startsWith('did:') ? undefined : actor };
	try {
		const profile = await getJson(`${PUBLIC_APPVIEW}/xrpc/app.bsky.actor.getProfile?actor=${encodeURIComponent(did)}`);
		identity.handle = profile?.handle && profile.handle !== 'handle.invalid' ? profile.handle : identity.handle;
		identity.displayName = profile?.displayName || undefined;
		identity.avatar = profile?.avatar || undefined;
		identity.bio = profile?.description || undefined;
	} catch {
		identity.handle ??= await handleFromDidDoc(did);
	}
	return identity;
}

async function listRecords(
	ident: ReaderIdentity,
	collection: string,
	maxPages: number,
	limit = PAGE_LIMIT
): Promise<RepoRecord[]> {
	const out: RepoRecord[] = [];
	let cursor: string | undefined;
	const base = ident.pds.replace(/\/+$/, '');
	for (let page = 0; page < maxPages; page++) {
		const params = new URLSearchParams({ repo: ident.did, collection, limit: String(limit) });
		if (cursor) params.set('cursor', cursor);
		const data = await getJson(`${base}/xrpc/com.atproto.repo.listRecords?${params}`);
		const records = Array.isArray(data?.records) ? data.records : [];
		out.push(...records);
		cursor = typeof data?.cursor === 'string' ? data.cursor : undefined;
		if (!cursor || records.length === 0) break;
	}
	return out;
}

async function getRecord(uri: string, fallbackPds: string): Promise<RepoRecord | null> {
	const parsed = parseAtUri(uri);
	if (!parsed) return null;
	try {
		const pds = (await resolvePds(parsed.did)) ?? fallbackPds;
		const params = new URLSearchParams({ repo: parsed.did, collection: parsed.collection, rkey: parsed.rkey });
		return await getJson(`${pds.replace(/\/+$/, '')}/xrpc/com.atproto.repo.getRecord?${params}`);
	} catch {
		return null;
	}
}

/** Fill in posts whose content lives in another record (e.g. app.greengale.document#contentRef). */
async function resolveContentRefs(ctx: RepoContext, posts: BlogPost[], known: Map<string, RepoRecord>): Promise<void> {
	await Promise.all(
		posts
			.filter((p) => p.contentRef)
			.map(async (post) => {
				const ref = post.contentRef!;
				const record = known.get(ref) ?? (await getRecord(ref, ctx.pds));
				const value = record?.value;
				if (!value) return;
				const blocks =
					typeof value.content === 'string' ? markdownToBlocks(value.content) : contentToBlocks(ctx, value.content) ?? [];
				if (blocks.length) {
					post.blocks = stripDuplicateTitle(blocks, post.title);
					post.textLength = blocksText(post.blocks).length;
				}
				post.contentRef = undefined;
			})
	);
}

export async function loadReaderBlog(input: string, onProgress: ReaderProgress = () => {}): Promise<ReaderBlog> {
	onProgress('Resolving identity…');
	const identity = await resolveIdentity(input);
	const ctx: RepoContext = { did: identity.did, pds: identity.pds, handle: identity.handle };
	const warnings: string[] = [];

	onProgress('Listing repo collections…');
	const describe = await getJson(
		`${identity.pds.replace(/\/+$/, '')}/xrpc/com.atproto.repo.describeRepo?repo=${encodeURIComponent(identity.did)}`
	);
	const collections: string[] = Array.isArray(describe?.collections) ? describe.collections : [];
	const has = new Set(collections);

	// Publications first so documents can build canonical URLs.
	const publicationMap = new Map<string, BlogPublication>();
	for (const col of PUBLICATION_COLLECTIONS.filter((c) => has.has(c))) {
		try {
			for (const rec of await listRecords(identity, col, 2)) {
				const pub = recordToPublication(ctx, rec);
				if (pub) publicationMap.set(pub.uri, pub);
			}
		} catch (e: any) {
			warnings.push(`${col}: ${e?.message ?? e}`);
		}
	}

	const posts: BlogPost[] = [];
	const sources: ReaderSource[] = [];
	const recordsByUri = new Map<string, RepoRecord>();

	for (const known of KNOWN_BLOG_COLLECTIONS.filter((k) => has.has(k.collection))) {
		onProgress(`Reading ${known.label} (${known.collection})…`);
		try {
			const records = await listRecords(identity, known.collection, MAX_PAGES_KNOWN);
			let count = 0;
			for (const record of records) {
				recordsByUri.set(record.uri, record);
				if (!isPubliclyVisible(record.value)) continue;
				const post = known.adapter({ ctx, record, publications: publicationMap });
				if (post) {
					posts.push(post);
					count++;
				}
			}
			sources.push({ collection: known.collection, label: known.label, count, heuristic: false });
		} catch (e: any) {
			warnings.push(`${known.collection}: ${e?.message ?? e}`);
		}
	}

	const candidates = collections.filter((c) => !isIgnoredCollection(c));
	let next = 0;
	const sniffWorker = async () => {
		while (next < candidates.length) await sniffCollection(candidates[next++]);
	};
	const sniffCollection = async (collection: string) => {
		onProgress(`Sniffing ${collection}…`);
		try {
			const sample = await listRecords(identity, collection, 1, HEURISTIC_SAMPLE);
			const verdict = scoreCollection(ctx, collection, sample);
			if (!verdict.isBlog) return;
			onProgress(`Reading ${collection} (looks like a blog: ${verdict.reason})…`);
			const records = await listRecords(identity, collection, MAX_PAGES_HEURISTIC);
			let count = 0;
			for (const record of records) {
				recordsByUri.set(record.uri, record);
				const post = heuristicRecordToPost(ctx, record);
				// Individual records must still look like writing, not stubs.
				if (post && post.textLength >= 80) {
					posts.push(post);
					count++;
				}
			}
			if (count) sources.push({ collection, label: collection, count, heuristic: true, reason: verdict.reason });
		} catch (e: any) {
			warnings.push(`${collection}: ${e?.message ?? e}`);
		}
	};
	await Promise.all(Array.from({ length: Math.min(4, candidates.length) }, sniffWorker));

	onProgress('Resolving referenced content…');
	await resolveContentRefs(ctx, posts, recordsByUri);

	return {
		identity,
		publications: [...publicationMap.values()],
		posts: dedupePosts(posts),
		sources,
		collections,
		warnings
	};
}
