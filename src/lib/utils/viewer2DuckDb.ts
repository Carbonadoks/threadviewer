import type { AuthorInfo, SelfReplyThread, ThreadPost } from '$lib/types';
import type { RepoDownloadProgress, RepoFeedLoadResult } from '$lib/utils/repoHydration';
import { loadRepoFeedItems } from '$lib/utils/repoHydration';
import type { ParsedPost } from '$lib/utils/carParser';
import { extractBskyPostUrlsFromFacets } from '$lib/utils/viewerLinks';

type DuckDbModule = typeof import('@duckdb/duckdb-wasm');
type AsyncDuckDB = import('@duckdb/duckdb-wasm').AsyncDuckDB;
type AsyncDuckDBConnection = import('@duckdb/duckdb-wasm').AsyncDuckDBConnection;

export const VIEWER2_DUCKDB_SCHEMA_VERSION = '1';
export const VIEWER2_DUCKDB_PATH = 'opfs://threadviewer-viewer2db.duckdb';

export type Viewer2DbSearchMode = 'literal' | 'regex';
export type Viewer2DbGalleryContentMode = 'all' | 'media' | 'images' | 'movies';
export type Viewer2DbGalleryGroupMode = 'threads' | 'posts';
export type Viewer2DbThreadSortMode = 'depth' | 'newest' | 'oldest' | 'liked' | 'reposted' | 'quoted';

export interface Viewer2DbGalleryQueryOptions {
	query?: string;
	searchMode?: Viewer2DbSearchMode;
	dateFrom?: string;
	dateTo?: string;
	minDepth?: number;
	contentMode?: Viewer2DbGalleryContentMode;
	groupMode?: Viewer2DbGalleryGroupMode;
	sortMode?: Viewer2DbThreadSortMode;
	limit?: number;
	offset?: number;
	accountDids?: string[];
}

export interface Viewer2DbGallerySql {
	sql: string;
	countSql: string;
}

export interface Viewer2DbPostRow {
	uri: string;
	did: string;
	rkey: string;
	cid: string;
	text: string;
	created_at: string;
	indexed_at: string;
	reply_parent_uri: string | null;
	reply_root_uri: string | null;
	facets_json: string;
	embed_json: string;
	linked_urls_json: string;
	like_count: number;
	repost_count: number;
	reply_count: number;
	quote_count: number;
	has_images: boolean;
	has_video: boolean;
	has_media: boolean;
	search_text: string;
	handle?: string | null;
	display_name?: string | null;
	avatar?: string | null;
}

export interface Viewer2DbThreadPostRow extends Viewer2DbPostRow {
	root_uri: string;
	post_uri: string;
	parent_uri: string | null;
	ordinal: number;
	thread_depth?: number;
	thread_post_count?: number;
}

export interface Viewer2DbThreadBuildResult {
	threads: SelfReplyThread[];
	threadPosts: Array<{
		root_uri: string;
		post_uri: string;
		parent_uri: string | null;
		ordinal: number;
	}>;
	stats: {
		postsScanned: number;
		chainStarts: number;
		threadsWithSelfReplies: number;
	};
}

export interface Viewer2DbAccount {
	did: string;
	handle: string;
	display_name: string | null;
	avatar: string | null;
	source: 'pds' | 'relay' | null;
	downloaded_bytes: number;
	total_posts: number;
	indexed_at: string;
	last_error: string | null;
	thread_count: number;
	self_reply_thread_count: number;
}

export interface Viewer2DbOverview {
	accountCount: number;
	postCount: number;
	threadCount: number;
	selfReplyThreadCount: number;
	downloadedBytes: number;
}

export interface Viewer2DbIngestCallbacks {
	onDownloadProgress?: (progress: RepoDownloadProgress) => void;
	onParseProgress?: (parsedPosts: number) => void;
	onPhase?: (phase: string, detail?: string) => void;
}

export interface Viewer2DbIngestResult {
	account: Viewer2DbAccount;
	repo: RepoFeedLoadResult;
	stats: Viewer2DbThreadBuildResult['stats'];
}

type ArrowLikeTable = Iterable<unknown> & {
	toArray?: () => unknown[];
	schema?: {
		fields?: Array<{ name: string }>;
	};
};

const POST_COLUMNS = [
	'uri',
	'did',
	'rkey',
	'cid',
	'text',
	'created_at',
	'indexed_at',
	'reply_parent_uri',
	'reply_root_uri',
	'facets_json',
	'embed_json',
	'linked_urls_json',
	'like_count',
	'repost_count',
	'reply_count',
	'quote_count',
	'has_images',
	'has_video',
	'has_media',
	'search_text'
] as const;
const THREAD_COLUMNS = [
	'root_uri',
	'did',
	'root_created_at',
	'root_text',
	'depth',
	'post_count',
	'has_images',
	'has_video',
	'has_media',
	'like_count',
	'repost_count',
	'quote_count',
	'updated_at'
] as const;
const THREAD_POST_COLUMNS = ['root_uri', 'post_uri', 'parent_uri', 'ordinal'] as const;
const INSERT_BATCH_SIZE = 100;
const VIEWER2_DUCKDB_SNAPSHOT_DB_NAME = 'threadviewer-viewer2db-snapshots';
const VIEWER2_DUCKDB_SNAPSHOT_DB_VERSION = 1;
const VIEWER2_DUCKDB_SNAPSHOT_STORE_NAME = 'accounts';
const VIEWER2_DUCKDB_SNAPSHOT_VERSION = 1;

interface Viewer2DbReplacePayload {
	indexedAt: string;
	downloadedBytes: number;
	source: 'pds' | 'relay';
	totalPosts: number;
	postRows: Viewer2DbPostRow[];
	threadSummaryRows: Array<Record<string, unknown>>;
	threadPostRows: Viewer2DbThreadBuildResult['threadPosts'];
}

interface Viewer2DbAccountSnapshot extends Viewer2DbReplacePayload {
	version: number;
	did: string;
	author: AuthorInfo;
	savedAt: string;
}

const SCHEMA_STATEMENTS = [
	`CREATE TABLE IF NOT EXISTS meta (
		key TEXT PRIMARY KEY,
		value TEXT
	)`,
	`CREATE TABLE IF NOT EXISTS repo_accounts (
		did TEXT PRIMARY KEY,
		handle TEXT,
		display_name TEXT,
		avatar TEXT,
		source TEXT,
		downloaded_bytes INTEGER,
		total_posts INTEGER,
		indexed_at TEXT,
		last_error TEXT
	)`,
	`CREATE TABLE IF NOT EXISTS posts (
		uri TEXT PRIMARY KEY,
		did TEXT,
		rkey TEXT,
		cid TEXT,
		text TEXT,
		created_at TEXT,
		indexed_at TEXT,
		reply_parent_uri TEXT,
		reply_root_uri TEXT,
		facets_json TEXT,
		embed_json TEXT,
		linked_urls_json TEXT,
		like_count INTEGER,
		repost_count INTEGER,
		reply_count INTEGER,
		quote_count INTEGER,
		has_images BOOLEAN,
		has_video BOOLEAN,
		has_media BOOLEAN,
		search_text TEXT
	)`,
	`CREATE TABLE IF NOT EXISTS threads (
		root_uri TEXT PRIMARY KEY,
		did TEXT,
		root_created_at TEXT,
		root_text TEXT,
		depth INTEGER,
		post_count INTEGER,
		has_images BOOLEAN,
		has_video BOOLEAN,
		has_media BOOLEAN,
		like_count INTEGER,
		repost_count INTEGER,
		quote_count INTEGER,
		updated_at TEXT
	)`,
	`CREATE TABLE IF NOT EXISTS thread_posts (
		root_uri TEXT,
		post_uri TEXT,
		parent_uri TEXT,
		ordinal INTEGER,
		PRIMARY KEY(root_uri, post_uri)
	)`,
	`CREATE INDEX IF NOT EXISTS posts_did_idx ON posts(did)`,
	`CREATE INDEX IF NOT EXISTS posts_created_at_idx ON posts(created_at)`,
	`CREATE INDEX IF NOT EXISTS posts_reply_parent_uri_idx ON posts(reply_parent_uri)`,
	`CREATE INDEX IF NOT EXISTS posts_reply_root_uri_idx ON posts(reply_root_uri)`,
	`CREATE INDEX IF NOT EXISTS posts_search_text_idx ON posts(search_text)`,
	`CREATE INDEX IF NOT EXISTS posts_media_idx ON posts(has_media, has_images, has_video)`,
	`CREATE INDEX IF NOT EXISTS posts_engagement_idx ON posts(like_count, repost_count, quote_count)`,
	`CREATE INDEX IF NOT EXISTS threads_did_idx ON threads(did)`,
	`CREATE INDEX IF NOT EXISTS threads_root_created_at_idx ON threads(root_created_at)`,
	`CREATE INDEX IF NOT EXISTS threads_depth_idx ON threads(depth)`,
	`CREATE INDEX IF NOT EXISTS threads_media_idx ON threads(has_media, has_images, has_video)`,
	`CREATE INDEX IF NOT EXISTS threads_engagement_idx ON threads(like_count, repost_count, quote_count)`,
	`CREATE INDEX IF NOT EXISTS thread_posts_root_idx ON thread_posts(root_uri)`,
	`CREATE INDEX IF NOT EXISTS thread_posts_post_idx ON thread_posts(post_uri)`
];

function nowIso(): string {
	return new Date().toISOString();
}

function toText(value: unknown): string {
	return typeof value === 'string' ? value : '';
}

function toNullableText(value: unknown): string | null {
	const text = toText(value).trim();
	return text ? text : null;
}

function toFiniteCount(value: unknown): number {
	const numeric = Number(value);
	return Number.isFinite(numeric) ? Math.max(0, Math.round(numeric)) : 0;
}

function toBoolean(value: unknown): boolean {
	return value === true || value === 1 || value === 'true';
}

function safeJson(value: unknown): string {
	return JSON.stringify(value ?? null);
}

function parseJsonArray(value: string | null | undefined): string[] {
	if (!value) return [];
	try {
		const parsed = JSON.parse(value);
		return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
	} catch {
		return [];
	}
}

function parseJsonObject(value: string | null | undefined): any {
	if (!value) return null;
	try {
		return JSON.parse(value);
	} catch {
		return null;
	}
}

function normalizeSearchText(parts: Array<string | null | undefined>): string {
	return parts
		.map((part) => (part ?? '').trim())
		.filter(Boolean)
		.join('\n')
		.toLowerCase();
}

export function quoteSqlIdentifier(value: string): string {
	return `"${value.replace(/"/g, '""')}"`;
}

export function sqlStringLiteral(value: string): string {
	return `'${value.replace(/'/g, "''")}'`;
}

export function escapeSqlLikePattern(value: string): string {
	return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

function sqlStringList(values: string[]): string {
	return values.map(sqlStringLiteral).join(', ');
}

function sqlValueLiteral(value: unknown): string {
	if (value === null || value === undefined) return 'NULL';
	if (typeof value === 'string') return sqlStringLiteral(value);
	if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
	if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL';
	if (typeof value === 'bigint') return String(value);
	return sqlStringLiteral(JSON.stringify(value));
}

function errorText(value: unknown): string {
	if (value instanceof Error) return value.message;
	return String(value ?? '');
}

export function isViewer2DuckDbFatalError(value: unknown): boolean {
	const message = errorText(value);
	return (
		/\bFATAL\b/i.test(message) ||
		/database has been invalidated/i.test(message) ||
		/database must be restarted/i.test(message) ||
		/must be restarted prior to being used again/i.test(message)
	);
}

export function isViewer2DuckDbMissingWalMessage(value: unknown): boolean {
	return /Buffering missing file:\s*opfs:\/+.*\.wal\b/i.test(errorText(value));
}

function clampLimit(value: unknown): number {
	const numeric = Number(value);
	if (!Number.isFinite(numeric)) return 100;
	return Math.max(1, Math.min(500, Math.round(numeric)));
}

function clampOffset(value: unknown): number {
	const numeric = Number(value);
	if (!Number.isFinite(numeric)) return 0;
	return Math.max(0, Math.round(numeric));
}

function normalizeMinDepth(value: unknown): number {
	const numeric = Number(value);
	if (!Number.isFinite(numeric)) return 1;
	return Math.max(1, Math.round(numeric));
}

function contentPredicate(alias: string, mode: Viewer2DbGalleryContentMode): string | null {
	if (mode === 'media') return `${alias}.has_media = TRUE`;
	if (mode === 'images') return `${alias}.has_images = TRUE`;
	if (mode === 'movies') return `${alias}.has_video = TRUE`;
	return null;
}

function searchPredicate(alias: string, query: string, mode: Viewer2DbSearchMode): string | null {
	const trimmed = query.trim();
	if (!trimmed) return null;
	if (mode === 'regex') {
		return `regexp_matches(${alias}.search_text, ${sqlStringLiteral(trimmed)}, 'i')`;
	}
	const pattern = `%${escapeSqlLikePattern(trimmed.toLowerCase())}%`;
	return `${alias}.search_text LIKE ${sqlStringLiteral(pattern)} ESCAPE '\\'`;
}

function sortClause(sortMode: Viewer2DbThreadSortMode): string {
	if (sortMode === 'newest') return 't.root_created_at DESC, t.depth DESC, t.root_uri ASC';
	if (sortMode === 'oldest') return 't.root_created_at ASC, t.depth DESC, t.root_uri ASC';
	if (sortMode === 'liked') return 't.like_count DESC, t.depth DESC, t.root_created_at DESC, t.root_uri ASC';
	if (sortMode === 'reposted') return 't.repost_count DESC, t.depth DESC, t.root_created_at DESC, t.root_uri ASC';
	if (sortMode === 'quoted') return 't.quote_count DESC, t.depth DESC, t.root_created_at DESC, t.root_uri ASC';
	return 't.depth DESC, t.root_created_at DESC, t.root_uri ASC';
}

export function buildViewer2DbGalleryQuery(
	options: Viewer2DbGalleryQueryOptions = {}
): Viewer2DbGallerySql {
	const query = options.query ?? '';
	const searchMode = options.searchMode ?? 'literal';
	const contentMode = options.contentMode ?? 'all';
	const groupMode = options.groupMode ?? 'threads';
	const sortMode = options.sortMode ?? 'depth';
	const limit = clampLimit(options.limit);
	const offset = clampOffset(options.offset);
	const filters: string[] = [`t.depth >= ${normalizeMinDepth(options.minDepth)}`];

	const accountDids = [...new Set((options.accountDids ?? []).map((did) => did.trim()).filter(Boolean))];
	if (accountDids.length > 0) {
		filters.push(`t.did IN (${sqlStringList(accountDids)})`);
	}
	if (options.dateFrom?.trim()) {
		filters.push(`t.root_created_at >= ${sqlStringLiteral(`${options.dateFrom.trim()}T00:00:00.000Z`)}`);
	}
	if (options.dateTo?.trim()) {
		filters.push(`t.root_created_at <= ${sqlStringLiteral(`${options.dateTo.trim()}T23:59:59.999Z`)}`);
	}

	const threadContentPredicate = contentPredicate('t', contentMode);
	const postContentPredicate = contentPredicate('p_filter', contentMode);
	const postSearchPredicate = searchPredicate('p_filter', query, searchMode);
	const needsPostFilter = groupMode === 'posts' || Boolean(postSearchPredicate);

	if (groupMode === 'threads' && threadContentPredicate) {
		filters.push(threadContentPredicate);
	}

	if (needsPostFilter) {
		const postFilters = [
			'p_filter.uri = tp_filter.post_uri',
			'tp_filter.root_uri = t.root_uri',
			groupMode === 'posts' ? postContentPredicate : null,
			postSearchPredicate
		].filter((part): part is string => Boolean(part));
		filters.push(`EXISTS (
			SELECT 1
			FROM thread_posts tp_filter
			JOIN posts p_filter ON ${postFilters.join(' AND ')}
		)`);
	}

	const where = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : '';
	const base = `FROM threads t ${where}`;

	return {
		sql: `SELECT t.root_uri ${base} ORDER BY ${sortClause(sortMode)} LIMIT ${limit} OFFSET ${offset}`,
		countSql: `SELECT COUNT(*) AS total ${base}`
	};
}

function rawEmbedMediaFlags(embed: any): { hasImages: boolean; hasVideo: boolean; hasMedia: boolean } {
	const type = toText(embed?.$type);
	let hasImages = type === 'app.bsky.embed.images';
	let hasVideo = type === 'app.bsky.embed.video';

	if (type === 'app.bsky.embed.recordWithMedia') {
		const mediaFlags = rawEmbedMediaFlags(embed?.media);
		hasImages ||= mediaFlags.hasImages;
		hasVideo ||= mediaFlags.hasVideo;
	}

	return { hasImages, hasVideo, hasMedia: hasImages || hasVideo };
}

function rawEmbedTypes(embed: any): { embedType?: string; mediaEmbedType?: string } {
	const embedType = toText(embed?.$type) || undefined;
	const mediaEmbedType =
		embedType === 'app.bsky.embed.recordWithMedia' ? toText(embed?.media?.$type) || undefined : undefined;
	return { embedType, mediaEmbedType };
}

export function parsedPostToViewer2DbRow(
	did: string,
	post: ParsedPost,
	author: AuthorInfo,
	indexedAt = nowIso()
): Viewer2DbPostRow {
	const record = post.record ?? {};
	const uri = `at://${did}/app.bsky.feed.post/${post.rkey}`;
	const createdAt = toText(record.createdAt) || indexedAt;
	const reply = record.reply;
	const mediaFlags = rawEmbedMediaFlags(record.embed);
	const linkedUrls = extractBskyPostUrlsFromFacets(record.facets);
	const text = toText(record.text);

	return {
		uri,
		did,
		rkey: post.rkey,
		cid: post.cid,
		text,
		created_at: createdAt,
		indexed_at: indexedAt,
		reply_parent_uri: toNullableText(reply?.parent?.uri),
		reply_root_uri: toNullableText(reply?.root?.uri),
		facets_json: safeJson(record.facets ?? null),
		embed_json: safeJson(record.embed ?? null),
		linked_urls_json: safeJson(linkedUrls),
		like_count: toFiniteCount((post as any).likeCount),
		repost_count: toFiniteCount((post as any).repostCount),
		reply_count: toFiniteCount((post as any).replyCount),
		quote_count: toFiniteCount((post as any).quoteCount),
		has_images: mediaFlags.hasImages,
		has_video: mediaFlags.hasVideo,
		has_media: mediaFlags.hasMedia,
		search_text: normalizeSearchText([text, author.handle, author.displayName]),
		handle: author.handle,
		display_name: author.displayName ?? null,
		avatar: author.avatar ?? null
	};
}

function postRowToThreadPost(row: Viewer2DbPostRow): ThreadPost {
	const rawEmbed = parseJsonObject(row.embed_json);
	const { embedType, mediaEmbedType } = rawEmbedTypes(rawEmbed);
	return {
		uri: row.uri,
		cid: row.cid,
		author: {
			did: row.did,
			handle: row.handle ?? row.did,
			displayName: row.display_name ?? undefined,
			avatar: row.avatar ?? undefined
		},
		text: row.text,
		createdAt: row.created_at || row.indexed_at,
		linkedUrls: parseJsonArray(row.linked_urls_json),
		needsHydratedPostView: Boolean(rawEmbed),
		hydrationEmbedType: embedType,
		hydrationMediaEmbedType: mediaEmbedType,
		likeCount: toFiniteCount(row.like_count),
		repostCount: toFiniteCount(row.repost_count),
		replyCount: toFiniteCount(row.reply_count),
		quoteCount: toFiniteCount(row.quote_count),
		parentUri: row.reply_parent_uri ?? undefined,
		children: []
	};
}

function measureDepth(node: ThreadPost): number {
	if (node.children.length === 0) return 1;
	return 1 + Math.max(...node.children.map(measureDepth));
}

function flattenThread(root: ThreadPost): Array<{ post: ThreadPost; parentUri: string | null }> {
	const rows: Array<{ post: ThreadPost; parentUri: string | null }> = [];
	function visit(post: ThreadPost, parentUri: string | null) {
		rows.push({ post, parentUri });
		for (const child of post.children) {
			visit(child, post.uri);
		}
	}
	visit(root, null);
	return rows;
}

function collectThreadMedia(root: ThreadPost, sourceRows: Map<string, Viewer2DbPostRow>) {
	let hasImages = false;
	let hasVideo = false;
	let postCount = 0;
	function visit(post: ThreadPost) {
		postCount += 1;
		const source = sourceRows.get(post.uri);
		hasImages ||= toBoolean(source?.has_images);
		hasVideo ||= toBoolean(source?.has_video);
		for (const child of post.children) visit(child);
	}
	visit(root);
	return { hasImages, hasVideo, hasMedia: hasImages || hasVideo, postCount };
}

export function buildViewer2DbThreadsFromPostRows(
	rows: Viewer2DbPostRow[],
	authorDid: string | string[]
): Viewer2DbThreadBuildResult {
	const authorSet = new Set(
		(Array.isArray(authorDid) ? authorDid : [authorDid]).filter(
			(did): did is string => typeof did === 'string' && did.length > 0
		)
	);
	const postsByUri = new Map<string, ThreadPost>();
	const sourceRows = new Map<string, Viewer2DbPostRow>();
	const parentUriOf = new Map<string, string>();
	const rootUriOf = new Map<string, string>();

	for (const row of rows) {
		if (!authorSet.has(row.did)) continue;
		const post = postRowToThreadPost(row);
		postsByUri.set(row.uri, post);
		sourceRows.set(row.uri, row);
		if (row.reply_parent_uri) parentUriOf.set(row.uri, row.reply_parent_uri);
		if (row.reply_root_uri) rootUriOf.set(row.uri, row.reply_root_uri);
	}

	const childUris = new Set<string>();
	for (const [childUri, parentUri] of parentUriOf) {
		const parent = postsByUri.get(parentUri);
		const child = postsByUri.get(childUri);
		if (parent && child) {
			parent.children.push(child);
			childUris.add(childUri);
		}
	}

	for (const [uri, rootUri] of rootUriOf) {
		if (childUris.has(uri) || uri === rootUri) continue;
		const root = postsByUri.get(rootUri);
		const orphan = postsByUri.get(uri);
		if (root && orphan) {
			root.children.push(orphan);
			childUris.add(uri);
		}
	}

	const threads: SelfReplyThread[] = [];
	const threadPosts: Viewer2DbThreadBuildResult['threadPosts'] = [];
	for (const [uri, post] of postsByUri) {
		if (childUris.has(uri)) continue;
		const depth = measureDepth(post);
		const thread: SelfReplyThread = { rootPost: post, depth, rootUri: uri };
		threads.push(thread);
		flattenThread(post).forEach((item, index) => {
			threadPosts.push({
				root_uri: uri,
				post_uri: item.post.uri,
				parent_uri: item.parentUri,
				ordinal: index
			});
		});
	}

	return {
		threads,
		threadPosts,
		stats: {
			postsScanned: rows.length,
			chainStarts: threads.length,
			threadsWithSelfReplies: threads.filter((thread) => thread.depth >= 2).length
		}
	};
}

export function viewer2DbThreadRowsToThreads(
	rows: Viewer2DbThreadPostRow[],
	rootOrder: string[] = []
): SelfReplyThread[] {
	const grouped = new Map<string, Viewer2DbThreadPostRow[]>();
	for (const row of rows) {
		const rootUri = row.root_uri;
		const group = grouped.get(rootUri);
		if (group) group.push(row);
		else grouped.set(rootUri, [row]);
	}

	const orderedRootUris = [
		...rootOrder.filter((rootUri) => grouped.has(rootUri)),
		...[...grouped.keys()].filter((rootUri) => !rootOrder.includes(rootUri))
	];
	const threads: SelfReplyThread[] = [];

	for (const rootUri of orderedRootUris) {
		const group = [...(grouped.get(rootUri) ?? [])].sort((a, b) => toFiniteCount(a.ordinal) - toFiniteCount(b.ordinal));
		const postsByUri = new Map<string, ThreadPost>();

		for (const row of group) {
			const post = postRowToThreadPost(row);
			post.parentUri = row.parent_uri ?? row.reply_parent_uri ?? undefined;
			postsByUri.set(row.post_uri, post);
		}

		for (const row of group) {
			if (!row.parent_uri) continue;
			const parent = postsByUri.get(row.parent_uri);
			const child = postsByUri.get(row.post_uri);
			if (parent && child && row.post_uri !== rootUri) parent.children.push(child);
		}

		const rootPost = postsByUri.get(rootUri) ?? postsByUri.get(group[0]?.post_uri ?? '');
		if (!rootPost) continue;
		threads.push({
			rootPost,
			rootUri,
			depth: toFiniteCount(group[0]?.thread_depth) || measureDepth(rootPost)
		});
	}

	return threads;
}

function arrowValueToJson(value: any): any {
	if (typeof value?.toJSON === 'function') return value.toJSON();
	if (Array.isArray(value)) return value.map(arrowValueToJson);
	if (value && typeof value === 'object') {
		const result: Record<string, unknown> = {};
		for (const key of Object.keys(value)) {
			result[key] = arrowValueToJson(value[key]);
		}
		return result;
	}
	if (typeof value === 'bigint') return Number(value);
	return value;
}

function tableToRows<T>(table: ArrowLikeTable): T[] {
	const rawRows = typeof table.toArray === 'function' ? table.toArray() : [...table];
	const fields = table.schema?.fields ?? [];
	return rawRows.map((row: any) => {
		if (typeof row?.toJSON === 'function') return row.toJSON() as T;
		if (typeof row?.get === 'function' && fields.length > 0) {
			const result: Record<string, unknown> = {};
			fields.forEach((field, index) => {
				result[field.name] = arrowValueToJson(row.get(index));
			});
			return result as T;
		}
		return arrowValueToJson(row) as T;
	});
}

function openViewer2DbSnapshotDb(): Promise<IDBDatabase> {
	if (typeof indexedDB === 'undefined') {
		return Promise.reject(new Error('IndexedDB is not available for the DuckDB recovery mirror.'));
	}

	return new Promise((resolve, reject) => {
		const request = indexedDB.open(
			VIEWER2_DUCKDB_SNAPSHOT_DB_NAME,
			VIEWER2_DUCKDB_SNAPSHOT_DB_VERSION
		);
		request.onupgradeneeded = () => {
			const db = request.result;
			if (!db.objectStoreNames.contains(VIEWER2_DUCKDB_SNAPSHOT_STORE_NAME)) {
				db.createObjectStore(VIEWER2_DUCKDB_SNAPSHOT_STORE_NAME, { keyPath: 'did' });
			}
		};
		request.onsuccess = () => resolve(request.result);
		request.onerror = () =>
			reject(request.error ?? new Error('Could not open the DuckDB recovery mirror.'));
	});
}

function withViewer2DbSnapshotStore<T>(
	mode: IDBTransactionMode,
	callback: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T> {
	return openViewer2DbSnapshotDb().then(
		(db) =>
			new Promise<T>((resolve, reject) => {
				const transaction = db.transaction(VIEWER2_DUCKDB_SNAPSHOT_STORE_NAME, mode);
				const request = callback(transaction.objectStore(VIEWER2_DUCKDB_SNAPSHOT_STORE_NAME));
				request.onsuccess = () => resolve(request.result);
				request.onerror = () =>
					reject(request.error ?? new Error('DuckDB recovery mirror request failed.'));
				transaction.oncomplete = () => db.close();
				transaction.onabort = () => {
					db.close();
					reject(transaction.error ?? new Error('DuckDB recovery mirror transaction aborted.'));
				};
			})
	);
}

function sanitizeSnapshot(value: unknown): Viewer2DbAccountSnapshot | null {
	if (!value || typeof value !== 'object') return null;
	const snapshot = value as Partial<Viewer2DbAccountSnapshot>;
	if (
		snapshot.version !== VIEWER2_DUCKDB_SNAPSHOT_VERSION ||
		typeof snapshot.did !== 'string' ||
		!snapshot.author ||
		typeof snapshot.author.did !== 'string' ||
		typeof snapshot.author.handle !== 'string' ||
		(snapshot.source !== 'pds' && snapshot.source !== 'relay') ||
		typeof snapshot.indexedAt !== 'string' ||
		!Array.isArray(snapshot.postRows) ||
		!Array.isArray(snapshot.threadSummaryRows) ||
		!Array.isArray(snapshot.threadPostRows)
	) {
		return null;
	}

	return snapshot as Viewer2DbAccountSnapshot;
}

async function readViewer2DbSnapshots(): Promise<Viewer2DbAccountSnapshot[]> {
	if (typeof indexedDB === 'undefined') return [];
	const snapshots = await withViewer2DbSnapshotStore<Viewer2DbAccountSnapshot[]>(
		'readonly',
		(store) => store.getAll()
	).catch(() => []);
	return snapshots
		.map(sanitizeSnapshot)
		.filter((snapshot): snapshot is Viewer2DbAccountSnapshot => snapshot !== null)
		.sort((a, b) => a.indexedAt.localeCompare(b.indexedAt));
}

async function writeViewer2DbSnapshot(snapshot: Viewer2DbAccountSnapshot): Promise<void> {
	if (typeof indexedDB === 'undefined') return;
	await withViewer2DbSnapshotStore('readwrite', (store) => store.put(snapshot));
}

async function importDuckDbBundle() {
	const [duckdb, mvpModule, mvpWorker, ehModule, ehWorker, coiModule, coiWorker, coiPthreadWorker] =
		await Promise.all([
			import('@duckdb/duckdb-wasm'),
			import('@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url') as Promise<{ default: string }>,
			import('@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url') as Promise<{ default: string }>,
			import('@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url') as Promise<{ default: string }>,
			import('@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url') as Promise<{ default: string }>,
			import('@duckdb/duckdb-wasm/dist/duckdb-coi.wasm?url') as Promise<{ default: string }>,
			import('@duckdb/duckdb-wasm/dist/duckdb-browser-coi.worker.js?url') as Promise<{ default: string }>,
			import('@duckdb/duckdb-wasm/dist/duckdb-browser-coi.pthread.worker.js?url') as Promise<{ default: string }>
		]);
	const bundles: import('@duckdb/duckdb-wasm').DuckDBBundles = {
		mvp: {
			mainModule: mvpModule.default,
			mainWorker: mvpWorker.default
		},
		eh: {
			mainModule: ehModule.default,
			mainWorker: ehWorker.default
		},
		coi: {
			mainModule: coiModule.default,
			mainWorker: coiWorker.default,
			pthreadWorker: coiPthreadWorker.default
		}
	};
	return { duckdb, bundle: await duckdb.selectBundle(bundles) };
}

function createDuckDbWorker(workerUrl: string): Worker {
	const bootstrap = `
const __viewer2DuckDbWarn = console.warn.bind(console);
console.warn = (...args) => {
	const message = args.map((arg) => {
		try {
			return typeof arg === 'string' ? arg : String(arg);
		} catch {
			return '';
		}
	}).join(' ');
	if (/Buffering missing file:\\s*opfs:\\/+.*\\.wal\\b/i.test(message)) return;
	__viewer2DuckDbWarn(...args);
};
importScripts(${JSON.stringify(workerUrl)});
`;
	try {
		const blobUrl = URL.createObjectURL(new Blob([bootstrap], { type: 'text/javascript' }));
		const worker = new Worker(blobUrl, { type: 'classic' });
		URL.revokeObjectURL(blobUrl);
		return worker;
	} catch {
		return new Worker(workerUrl, { type: 'classic' });
	}
}

export class Viewer2DuckDbClient {
	readonly db: AsyncDuckDB;
	readonly conn: AsyncDuckDBConnection;
	private readonly duckdb: DuckDbModule;
	private writeQueue: Promise<void> = Promise.resolve();

	private constructor(duckdb: DuckDbModule, db: AsyncDuckDB, conn: AsyncDuckDBConnection) {
		this.duckdb = duckdb;
		this.db = db;
		this.conn = conn;
	}

	static async create(): Promise<Viewer2DuckDbClient> {
		if (!globalThis.window) {
			throw new Error('DuckDB-Wasm is only available in the browser.');
		}
		if (!navigator.storage?.getDirectory) {
			throw new Error('This browser does not expose OPFS storage for DuckDB persistence.');
		}
		await navigator.storage.persist?.().catch(() => false);

		const { duckdb, bundle } = await importDuckDbBundle();
		if (!bundle.mainWorker) throw new Error('DuckDB-Wasm did not provide a worker bundle.');
		const worker = createDuckDbWorker(bundle.mainWorker);
		const logger = new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING);
		const db = new duckdb.AsyncDuckDB(logger, worker);
		await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
		await db.open({
			path: VIEWER2_DUCKDB_PATH,
			accessMode: duckdb.DuckDBAccessMode.READ_WRITE,
			opfs: { fileHandling: 'auto' },
			query: {
				castBigIntToDouble: true,
				castTimestampToDate: false
			}
		});
		const conn = await db.connect();
		const client = new Viewer2DuckDbClient(duckdb, db, conn);
		await client.migrate();
		await client.restoreSnapshotsIfDatabaseIsEmpty();
		return client;
	}

	async close(): Promise<void> {
		await this.writeQueue.catch(() => {});
		await this.persistChanges().catch(() => {});
		await this.conn.close().catch(() => {});
		await this.db.flushFiles().catch(() => {});
		await this.db.terminate().catch(() => {});
	}

	async queryRows<T>(sql: string): Promise<T[]> {
		const table = await this.conn.query(sql);
		return tableToRows<T>(table as ArrowLikeTable);
	}

	async migrate(): Promise<void> {
		for (const statement of SCHEMA_STATEMENTS) {
			await this.conn.query(statement);
		}
		await this.conn.query(`DELETE FROM meta WHERE key = 'schema_version'`);
		await this.conn.query(`INSERT INTO meta (key, value) VALUES ('schema_version', ${sqlStringLiteral(VIEWER2_DUCKDB_SCHEMA_VERSION)})`);
	}

	private async persistChanges(): Promise<void> {
		// Explicit CHECKPOINT can OOM in DuckDB-Wasm on large OPFS databases.
		await this.db.flushFiles();
	}

	private async withWriteLock<T>(task: () => Promise<T>): Promise<T> {
		const previous = this.writeQueue;
		const run = previous.catch(() => {}).then(task);
		this.writeQueue = run.then(
			() => undefined,
			() => undefined
		);
		return run;
	}

	private async restoreSnapshotsIfDatabaseIsEmpty(): Promise<void> {
		const current = await this.overview();
		if (current.accountCount > 0 || current.postCount > 0 || current.threadCount > 0) return;

		const snapshots = await readViewer2DbSnapshots();
		if (snapshots.length === 0) return;

		await this.withWriteLock(async () => {
			for (const snapshot of snapshots) {
				await this.replaceAccountRowsUnlocked(
					snapshot.author,
					{
						indexedAt: snapshot.indexedAt,
						downloadedBytes: snapshot.downloadedBytes,
						source: snapshot.source,
						totalPosts: snapshot.totalPosts,
						postRows: snapshot.postRows,
						threadSummaryRows: snapshot.threadSummaryRows,
						threadPostRows: snapshot.threadPostRows
					},
					{ saveSnapshot: false }
				);
			}
			await this.persistChanges();
		});
	}

	async listAccounts(): Promise<Viewer2DbAccount[]> {
		return this.queryRows<Viewer2DbAccount>(`
			SELECT
				a.did,
				COALESCE(a.handle, '') AS handle,
				a.display_name,
				a.avatar,
				a.source,
				COALESCE(a.downloaded_bytes, 0) AS downloaded_bytes,
				COALESCE(a.total_posts, 0) AS total_posts,
				COALESCE(a.indexed_at, '') AS indexed_at,
				a.last_error,
				COUNT(t.root_uri) AS thread_count,
				SUM(CASE WHEN t.depth >= 2 THEN 1 ELSE 0 END) AS self_reply_thread_count
			FROM repo_accounts a
			LEFT JOIN threads t ON t.did = a.did
			GROUP BY a.did, a.handle, a.display_name, a.avatar, a.source, a.downloaded_bytes, a.total_posts, a.indexed_at, a.last_error
			ORDER BY a.indexed_at DESC, a.handle ASC
		`);
	}

	async overview(): Promise<Viewer2DbOverview> {
		const rows = await this.queryRows<Viewer2DbOverview>(`
			SELECT
				(SELECT COUNT(*) FROM repo_accounts) AS accountCount,
				(SELECT COUNT(*) FROM posts) AS postCount,
				(SELECT COUNT(*) FROM threads) AS threadCount,
				(SELECT COUNT(*) FROM threads WHERE depth >= 2) AS selfReplyThreadCount,
				(SELECT COALESCE(SUM(downloaded_bytes), 0) FROM repo_accounts) AS downloadedBytes
		`);
		return rows[0] ?? {
			accountCount: 0,
			postCount: 0,
			threadCount: 0,
			selfReplyThreadCount: 0,
			downloadedBytes: 0
		};
	}

	async downloadAndIngestRepo(
		author: AuthorInfo,
		callbacks: Viewer2DbIngestCallbacks = {},
		signal?: AbortSignal
	): Promise<Viewer2DbIngestResult> {
		callbacks.onPhase?.('download');
		const repo = await loadRepoFeedItems(author.did, author, {
			signal,
			onDownloadProgress: callbacks.onDownloadProgress,
			onParseProgress: callbacks.onParseProgress
		});
		callbacks.onPhase?.('index', `${repo.totalPosts.toLocaleString()} posts`);
		const account = await this.ingestParsedRepoPosts(author, repo);
		return { account, repo, stats: accountStatsFromAccount(account, repo.totalPosts) };
	}

	async ingestParsedRepoPosts(
		author: AuthorInfo,
		repo: Pick<RepoFeedLoadResult, 'parsedPosts' | 'downloadedBytes' | 'source' | 'totalPosts'>
	): Promise<Viewer2DbAccount> {
		const indexedAt = nowIso();
		const postRows = repo.parsedPosts.map((post) => parsedPostToViewer2DbRow(author.did, post, author, indexedAt));
		const built = buildViewer2DbThreadsFromPostRows(postRows, author.did);
		const postRowsByUri = new Map(postRows.map((row) => [row.uri, row]));
		const threadSummaryRows = built.threads.map((thread) => {
			const media = collectThreadMedia(thread.rootPost, postRowsByUri);
			return {
				root_uri: thread.rootUri,
				did: thread.rootPost.author.did,
				root_created_at: thread.rootPost.createdAt,
				root_text: thread.rootPost.text,
				depth: thread.depth,
				post_count: media.postCount,
				has_images: media.hasImages,
				has_video: media.hasVideo,
				has_media: media.hasMedia,
				like_count: thread.rootPost.likeCount ?? 0,
				repost_count: thread.rootPost.repostCount ?? 0,
				quote_count: thread.rootPost.quoteCount ?? 0,
				updated_at: indexedAt
			};
		});

		return this.withWriteLock(async () => {
			await this.replaceAccountRowsUnlocked(author, {
				indexedAt,
				downloadedBytes: repo.downloadedBytes,
				source: repo.source,
				totalPosts: repo.totalPosts,
				postRows,
				threadSummaryRows,
				threadPostRows: built.threadPosts
			});

			const accounts = await this.listAccounts();
			return accounts.find((account) => account.did === author.did) ?? {
				did: author.did,
				handle: author.handle,
				display_name: author.displayName ?? null,
				avatar: author.avatar ?? null,
				source: repo.source,
				downloaded_bytes: repo.downloadedBytes,
				total_posts: repo.totalPosts,
				indexed_at: indexedAt,
				last_error: null,
				thread_count: built.stats.chainStarts,
				self_reply_thread_count: built.stats.threadsWithSelfReplies
			};
		});
	}

	private async replaceAccountRowsUnlocked(
		author: AuthorInfo,
		payload: Viewer2DbReplacePayload,
		options: { saveSnapshot?: boolean } = {}
	): Promise<void> {
		const didLiteral = sqlStringLiteral(author.did);
		const maxAttempts = 2;
		let finalError: unknown = null;
		let finalRollbackError: unknown = null;

		const runTransaction = async () => {
			await this.conn.query('BEGIN TRANSACTION');
			await this.conn.query(`DELETE FROM thread_posts WHERE root_uri IN (SELECT root_uri FROM threads WHERE did = ${didLiteral})`);
			await this.conn.query(`DELETE FROM threads WHERE did = ${didLiteral}`);
			await this.conn.query(`DELETE FROM posts WHERE did = ${didLiteral}`);
			await this.conn.query(`DELETE FROM repo_accounts WHERE did = ${didLiteral}`);
			await this.conn.query(`
				INSERT INTO repo_accounts (did, handle, display_name, avatar, source, downloaded_bytes, total_posts, indexed_at, last_error)
				VALUES (
					${didLiteral},
					${sqlStringLiteral(author.handle)},
					${author.displayName ? sqlStringLiteral(author.displayName) : 'NULL'},
					${author.avatar ? sqlStringLiteral(author.avatar) : 'NULL'},
					${sqlStringLiteral(payload.source)},
					${toFiniteCount(payload.downloadedBytes)},
					${toFiniteCount(payload.totalPosts)},
					${sqlStringLiteral(payload.indexedAt)},
					NULL
				)
			`);

			if (payload.postRows.length > 0) {
				await this.insertRows('posts', POST_COLUMNS, payload.postRows);
			}

			if (payload.threadSummaryRows.length > 0) {
				await this.insertRows('threads', THREAD_COLUMNS, payload.threadSummaryRows);
			}

			if (payload.threadPostRows.length > 0) {
				await this.insertRows('thread_posts', THREAD_POST_COLUMNS, payload.threadPostRows);
			}

			await this.conn.query('COMMIT');
		};

		for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
			try {
				await runTransaction();
				await this.persistChanges().catch((error) => {
					if (isViewer2DuckDbFatalError(error)) throw error;
				});
				if (options.saveSnapshot !== false) {
					await writeViewer2DbSnapshot({
						version: VIEWER2_DUCKDB_SNAPSHOT_VERSION,
						did: author.did,
						author,
						savedAt: nowIso(),
						...payload
					}).catch(() => {});
				}
				return;
			} catch (error) {
				finalError = error;
				const rollbackError = await this.conn.query('ROLLBACK').then(
					() => null,
					(value) => value
				);
				finalRollbackError = rollbackError;
				const fatal = isViewer2DuckDbFatalError(error) || isViewer2DuckDbFatalError(rollbackError);
				if (!fatal && rollbackError === null && attempt < maxAttempts - 1) continue;
				break;
			}
		}

		if (!isViewer2DuckDbFatalError(finalError) && !isViewer2DuckDbFatalError(finalRollbackError)) {
			await this.markAccountError(author, finalError).catch((error) => {
				if (isViewer2DuckDbFatalError(error)) throw error;
			});
			await this.persistChanges().catch((error) => {
				if (isViewer2DuckDbFatalError(error)) throw error;
			});
		}
		throw finalError instanceof Error ? finalError : new Error('DuckDB transaction failed.');
	}

	private async insertRows(
		tableName: string,
		columns: readonly string[],
		rows: object[]
	): Promise<void> {
		const quotedColumns = columns.map(quoteSqlIdentifier).join(', ');
		for (let index = 0; index < rows.length; index += INSERT_BATCH_SIZE) {
			const batch = rows.slice(index, index + INSERT_BATCH_SIZE);
			if (batch.length === 0) continue;
			const values = batch
				.map((row) => {
					const record = row as Record<string, unknown>;
					return `(${columns.map((column) => sqlValueLiteral(record[column])).join(', ')})`;
				})
				.join(',\n');
			await this.conn.query(`INSERT INTO ${quoteSqlIdentifier(tableName)} (${quotedColumns}) VALUES ${values}`);
		}
	}

	private async markAccountError(author: AuthorInfo, error: unknown): Promise<void> {
		const indexedAt = nowIso();
		const message = error instanceof Error ? error.message : 'Ingestion failed.';
		await this.conn.query(`DELETE FROM repo_accounts WHERE did = ${sqlStringLiteral(author.did)}`);
		await this.conn.query(`
			INSERT INTO repo_accounts (did, handle, display_name, avatar, source, downloaded_bytes, total_posts, indexed_at, last_error)
			VALUES (
				${sqlStringLiteral(author.did)},
				${sqlStringLiteral(author.handle)},
				${author.displayName ? sqlStringLiteral(author.displayName) : 'NULL'},
				${author.avatar ? sqlStringLiteral(author.avatar) : 'NULL'},
				NULL,
				0,
				0,
				${sqlStringLiteral(indexedAt)},
				${sqlStringLiteral(message)}
			)
		`);
	}

	async queryGalleryThreads(
		options: Viewer2DbGalleryQueryOptions
	): Promise<{ threads: SelfReplyThread[]; total: number; rootUris: string[] }> {
		const built = buildViewer2DbGalleryQuery(options);
		const rootRows = await this.queryRows<{ root_uri: string }>(built.sql);
		const countRows = await this.queryRows<{ total: number }>(built.countSql);
		const rootUris = rootRows.map((row) => row.root_uri).filter(Boolean);
		const threads = await this.getThreadsByRootUris(rootUris);
		return {
			threads,
			total: toFiniteCount(countRows[0]?.total),
			rootUris
		};
	}

	async getThreadsByRootUris(rootUris: string[]): Promise<SelfReplyThread[]> {
		const uniqueRootUris = [...new Set(rootUris.filter(Boolean))];
		if (uniqueRootUris.length === 0) return [];
		const rows = await this.queryRows<Viewer2DbThreadPostRow>(`
			SELECT
				tp.root_uri,
				tp.post_uri,
				tp.parent_uri,
				tp.ordinal,
				t.depth AS thread_depth,
				t.post_count AS thread_post_count,
				p.uri,
				p.did,
				p.rkey,
				p.cid,
				p.text,
				p.created_at,
				p.indexed_at,
				p.reply_parent_uri,
				p.reply_root_uri,
				p.facets_json,
				p.embed_json,
				p.linked_urls_json,
				p.like_count,
				p.repost_count,
				p.reply_count,
				p.quote_count,
				p.has_images,
				p.has_video,
				p.has_media,
				p.search_text,
				a.handle,
				a.display_name,
				a.avatar
			FROM thread_posts tp
			JOIN posts p ON p.uri = tp.post_uri
			JOIN threads t ON t.root_uri = tp.root_uri
			LEFT JOIN repo_accounts a ON a.did = p.did
			WHERE tp.root_uri IN (${sqlStringList(uniqueRootUris)})
			ORDER BY tp.root_uri ASC, tp.ordinal ASC
		`);
		return viewer2DbThreadRowsToThreads(rows, rootUris);
	}
}

function accountStatsFromAccount(
	account: Viewer2DbAccount,
	postsScanned: number
): Viewer2DbThreadBuildResult['stats'] {
	return {
		postsScanned,
		chainStarts: toFiniteCount(account.thread_count),
		threadsWithSelfReplies: toFiniteCount(account.self_reply_thread_count)
	};
}
