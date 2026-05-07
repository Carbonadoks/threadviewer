import type { SelfReplyThread, ThreadPost } from '$lib/types';
import { buildBskyPostUrl } from '$lib/utils/viewerLinks';

export type ThreadExportFormat = 'md' | 'yaml' | 'json';
export type ThreadExportIdentityMode = 'author' | 'anon';

export interface ThreadExportNamedAuthor {
	did?: string;
	handle?: string;
	displayName?: string;
}

export interface ThreadExportAnonAuthor {
	id: string;
}

export type ThreadExportAuthor = ThreadExportNamedAuthor | ThreadExportAnonAuthor;

export interface ThreadExportLink {
	kind: 'external_embed' | 'linked_url';
	uri: string;
	title?: string;
	description?: string;
}

export interface ThreadExportQuote {
	uri?: string;
	author: ThreadExportAuthor;
	text: string;
	createdAt?: string;
}

export interface ThreadExportPost {
	id: string;
	uri?: string;
	url?: string;
	parentId: string | null;
	depth: number;
	author: ThreadExportAuthor;
	createdAt: string;
	text: string;
	quote?: ThreadExportQuote;
	links?: ThreadExportLink[];
	replies: ThreadExportPost[];
}

export interface ThreadExportData {
	exportVersion: 1;
	exportedAt: string;
	identityMode: ThreadExportIdentityMode;
	rootUri?: string;
	rootId: string;
	depth: number;
	postCount: number;
	root: ThreadExportPost;
}

export interface BuildThreadExportOptions {
	identityMode?: ThreadExportIdentityMode;
	exportedAt?: string;
}

export interface FormatThreadExportOptions extends BuildThreadExportOptions {
	format: ThreadExportFormat;
}

type QuoteAuthor = NonNullable<NonNullable<ThreadPost['embed']>['record']>['author'];
type AnyAuthor = ThreadPost['author'] | QuoteAuthor;

class ExportIdentityMapper {
	private anonByKey = new Map<string, string>();
	private anonByHandle = new Map<string, string>();
	private nextAnon = 1;

	constructor(private readonly mode: ThreadExportIdentityMode) {}

	seedPostAuthors(root: ThreadPost) {
		this.walk(root, (post) => {
			this.authorFor(post.author);
		});
	}

	authorFor(author: AnyAuthor): ThreadExportAuthor {
		if (this.mode === 'author') {
			return cleanAuthor(author);
		}

		const handle = cleanString(author.handle);
		const did = 'did' in author ? cleanString(author.did) : '';
		if (!did && handle && this.anonByHandle.has(handle)) {
			return { id: this.anonByHandle.get(handle)! };
		}

		const key = did ? `did:${did}` : handle ? `handle:${handle}` : `unknown:${this.nextAnon}`;
		const id = this.anonIdFor(key);
		if (handle) {
			this.anonByHandle.set(handle, id);
		}
		return { id };
	}

	private anonIdFor(key: string): string {
		const existing = this.anonByKey.get(key);
		if (existing) return existing;
		const id = `anon_${this.nextAnon++}`;
		this.anonByKey.set(key, id);
		return id;
	}

	private walk(root: ThreadPost, visit: (post: ThreadPost) => void) {
		visit(root);
		for (const child of root.children) {
			this.walk(child, visit);
		}
	}
}

function cleanString(value: unknown): string {
	return typeof value === 'string' ? value.trim() : '';
}

function cleanAuthor(author: AnyAuthor): ThreadExportNamedAuthor {
	const did = 'did' in author ? cleanString(author.did) : '';
	return cleanRecord({
		did: did || undefined,
		handle: cleanString(author.handle) || undefined,
		displayName: cleanString(author.displayName) || undefined
	});
}

function countPosts(root: ThreadPost): number {
	let total = 1;
	for (const child of root.children) {
		total += countPosts(child);
	}
	return total;
}

function assignPostIds(root: ThreadPost): Map<string, string> {
	const ids = new Map<string, string>();
	let nextId = 1;

	function walk(post: ThreadPost) {
		ids.set(post.uri, `post_${nextId++}`);
		for (const child of post.children) {
			walk(child);
		}
	}

	walk(root);
	return ids;
}

function collectLinks(post: ThreadPost): ThreadExportLink[] | undefined {
	const links: ThreadExportLink[] = [];
	const seen = new Set<string>();
	const external = post.embed?.external;

	if (external?.uri) {
		const uri = external.uri;
		seen.add(uri);
		links.push(
			cleanRecord({
				kind: 'external_embed' as const,
				uri,
				title: cleanString(external.title) || undefined,
				description: cleanString(external.description) || undefined
			})
		);
	}

	for (const uri of post.linkedUrls ?? []) {
		if (!uri || seen.has(uri)) continue;
		seen.add(uri);
		links.push({ kind: 'linked_url', uri });
	}

	return links.length > 0 ? links : undefined;
}

function buildQuote(
	post: ThreadPost,
	identity: ExportIdentityMapper,
	identityMode: ThreadExportIdentityMode
): ThreadExportQuote | undefined {
	const record = post.embed?.record;
	if (!record) return undefined;

	return cleanRecord({
		uri: identityMode === 'author' && record.uri ? record.uri : undefined,
		author: identity.authorFor(record.author),
		text: record.text ?? '',
		createdAt: cleanString(record.createdAt) || undefined
	});
}

function buildExportPost(
	post: ThreadPost,
	parentId: string | null,
	depth: number,
	postIds: Map<string, string>,
	identity: ExportIdentityMapper,
	identityMode: ThreadExportIdentityMode
): ThreadExportPost {
	const id = postIds.get(post.uri) ?? `post_unknown_${postIds.size + 1}`;
	const url = identityMode === 'author' ? buildBskyPostUrl(post.uri, post.author.handle) : null;

	return cleanRecord({
		id,
		uri: identityMode === 'author' ? post.uri : undefined,
		url: url || undefined,
		parentId,
		depth,
		author: identity.authorFor(post.author),
		createdAt: post.createdAt,
		text: post.text ?? '',
		quote: buildQuote(post, identity, identityMode),
		links: collectLinks(post),
		replies: post.children.map((child) =>
			buildExportPost(child, id, depth + 1, postIds, identity, identityMode)
		)
	});
}

export function buildThreadExportData(
	thread: SelfReplyThread,
	options: BuildThreadExportOptions = {}
): ThreadExportData {
	const identityMode = options.identityMode ?? 'author';
	const identity = new ExportIdentityMapper(identityMode);
	identity.seedPostAuthors(thread.rootPost);

	const postIds = assignPostIds(thread.rootPost);
	const root = buildExportPost(thread.rootPost, null, 0, postIds, identity, identityMode);

	return cleanRecord({
		exportVersion: 1 as const,
		exportedAt: options.exportedAt ?? new Date().toISOString(),
		identityMode,
		rootUri: identityMode === 'author' ? thread.rootUri : undefined,
		rootId: root.id,
		depth: thread.depth,
		postCount: countPosts(thread.rootPost),
		root
	});
}

export function formatThreadExport(thread: SelfReplyThread, options: FormatThreadExportOptions): string {
	const data = buildThreadExportData(thread, options);
	if (options.format === 'json') {
		return `${JSON.stringify(data, null, 2)}\n`;
	}
	if (options.format === 'yaml') {
		return `${toYaml(data)}\n`;
	}
	return formatMarkdown(data);
}

function formatMarkdown(data: ThreadExportData): string {
	const lines = [
		'# Thread export',
		'',
		`Exported: ${data.exportedAt}`,
		`Identity: ${data.identityMode}`,
		`Posts: ${data.postCount}`,
		`Depth: ${data.depth}`,
		''
	];

	appendPostMarkdown(lines, data.root, 0);
	return `${lines.join('\n').replace(/\n{3,}/g, '\n\n')}\n`;
}

function appendPostMarkdown(lines: string[], post: ThreadExportPost, level: number) {
	const headingLevel = Math.min(2 + level, 6);
	lines.push(`${'#'.repeat(headingLevel)} ${post.id} - ${authorLabel(post.author)}`);
	lines.push(`Created: ${post.createdAt || 'unknown'}`);
	lines.push(`Depth: ${post.depth}`);
	if (post.parentId) lines.push(`Reply to: ${post.parentId}`);
	if (post.uri) lines.push(`URI: ${post.uri}`);
	if (post.url) lines.push(`URL: ${post.url}`);
	lines.push('');
	lines.push(blockquote(post.text || 'No text'));

	if (post.quote) {
		lines.push('');
		lines.push(`Quote: ${authorLabel(post.quote.author)}`);
		if (post.quote.uri) lines.push(`Quote URI: ${post.quote.uri}`);
		lines.push(blockquote(post.quote.text || 'No quote text'));
	}

	if (post.links?.length) {
		lines.push('');
		lines.push('Links:');
		for (const link of post.links) {
			const label = link.title || link.uri;
			const description = link.description ? ` - ${link.description}` : '';
			lines.push(`- ${link.kind}: [${escapeMarkdownLabel(label)}](${link.uri})${description}`);
		}
	}

	lines.push('');
	for (const reply of post.replies) {
		appendPostMarkdown(lines, reply, level + 1);
	}
}

function authorLabel(author: ThreadExportAuthor): string {
	if ('id' in author) return author.id;
	if (author.displayName && author.handle) return `${author.displayName} (@${author.handle})`;
	if (author.handle) return `@${author.handle}`;
	if (author.did) return author.did;
	return 'unknown';
}

function blockquote(text: string): string {
	return text.split(/\r?\n/).map((line) => `> ${line}`).join('\n');
}

function escapeMarkdownLabel(value: string): string {
	return value.replace(/\]/g, '\\]');
}

function toYaml(value: unknown, indent = 0): string {
	const pad = '  '.repeat(indent);
	if (isScalar(value)) return `${pad}${yamlScalar(value)}`;

	if (Array.isArray(value)) {
		if (value.length === 0) return `${pad}[]`;
		return value
			.map((item) => {
				if (isScalar(item)) return `${pad}- ${yamlScalar(item)}`;
				return `${pad}-\n${toYaml(item, indent + 1)}`;
			})
			.join('\n');
	}

	const entries = Object.entries((value ?? {}) as Record<string, unknown>).filter(
		([, entryValue]) => entryValue !== undefined
	);
	if (entries.length === 0) return `${pad}{}`;

	return entries
		.map(([key, entryValue]) => {
			const yamlKey = /^[A-Za-z_][A-Za-z0-9_-]*$/.test(key) ? key : JSON.stringify(key);
			if (isScalar(entryValue)) return `${pad}${yamlKey}: ${yamlScalar(entryValue)}`;
			return `${pad}${yamlKey}:\n${toYaml(entryValue, indent + 1)}`;
		})
		.join('\n');
}

function isScalar(value: unknown): boolean {
	return value === null || ['string', 'number', 'boolean', 'undefined'].includes(typeof value);
}

function yamlScalar(value: unknown): string {
	if (value === undefined || value === null) return 'null';
	if (typeof value === 'string') return JSON.stringify(value);
	if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null';
	if (typeof value === 'boolean') return value ? 'true' : 'false';
	return JSON.stringify(value);
}

function cleanRecord<T extends Record<string, unknown>>(record: T): T {
	return Object.fromEntries(
		Object.entries(record).filter(([, value]) => value !== undefined)
	) as T;
}
