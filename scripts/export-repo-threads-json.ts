import { AtpAgent } from '@atproto/api';
import { CarReader } from '@ipld/car';
import * as dagCbor from '@ipld/dag-cbor';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { performance } from 'node:perf_hooks';
import type { AuthorInfo, SelfReplyThread, ThreadPost } from '../src/lib/types';
import { parseCarPosts, type ParsedPost } from '../src/lib/utils/carParser';
import { buildFuzzyTextMatcher, fuzzyTextMatches, type FuzzyTextMatcher } from '../src/lib/utils/fuzzySearch';
import { resolvePds } from '../src/lib/utils/pdsResolver';
import { repoPostsToFeedItems } from '../src/lib/utils/repoToFeed';
import { buildThreadAnalysisDocument } from '../src/lib/utils/threadAnalysis';
import { buildThreadsFromFeed } from '../src/lib/utils/threadWalker';
import { buildBskyPostUrl } from '../src/lib/utils/viewerLinks';

const PROFILE_API = 'https://public.api.bsky.app';
const DEFAULT_OUTPUT_DIR = path.resolve(process.cwd(), 'output', 'repo-thread-json');
const SCHEMA_VERSION = 1;

type ExportScope = 'filtered' | 'all';
type SearchMatcherMode = 'none' | 'literal' | 'regex';

type CliOptions = {
	handle: string | null;
	outputPath: string | null;
	minDepth: number;
	search: string;
	dateFrom: string;
	dateTo: string;
	limit: number | null;
	exportScope: ExportScope;
	pretty: boolean;
	force: boolean;
	progressJsonl: boolean;
};

type ProfileInfo = {
	did: string;
	handle: string;
	displayName?: string;
	avatar?: string;
	postsCount: number;
};

type RepoDownloadResult = {
	carBytes: Uint8Array;
	downloadedBytes: number;
	totalBytes: number;
	elapsedMs: number;
	source: 'pds' | 'relay';
};

type ThreadSearchMatcher = {
	mode: SearchMatcherMode;
	literal: string | null;
	fuzzy: FuzzyTextMatcher | null;
	regex: RegExp | null;
	helperText: string | null;
	helperTone: 'info' | 'warning' | null;
};

type SerializedThread = {
	rootUri: string;
	depth: number;
	postCount: number;
	characterCount: number;
	firstCreatedAt: string;
	lastCreatedAt: string;
	title: string;
	preview: string;
	text: string;
	blueskyUrl: string | null;
	rootPost: ThreadPost;
};

type ExportPayload = {
	schemaVersion: number;
	kind: 'bsky-repo-thread-json';
	generatedAt: string;
	profile: ProfileInfo;
	repo: {
		source: 'pds' | 'relay';
		downloadedBytes: number;
		totalBytes: number;
		elapsedMs: number;
		carSha256: string;
		parsedPosts: number;
	};
	filters: {
		minDepth: number;
		search: string;
		dateFrom: string;
		dateTo: string;
		limit: number | null;
		exportScope: ExportScope;
		searchMode: SearchMatcherMode;
		searchHelperText: string | null;
	};
	stats: {
		postsScanned: number;
		chainStarts: number;
		threadsWithSelfReplies: number;
		maxDepth: number;
		filteredThreads: number;
		exportedThreads: number;
		exportedCharacters: number;
		exportedPosts: number;
	};
	threads: SerializedThread[];
};

function usage(): string {
	return [
		'Download one Bluesky repository CAR, build self-reply threads, and save them as JSON.',
		'',
		'Usage:',
		'  node --import tsx scripts/export-repo-threads-json.ts <handle> [options]',
		'',
		'Options:',
		'  --output <path>              Output JSON path',
		'  --min-depth <n>             Minimum thread depth, matching Repo Viewer threshold (default: 2)',
		'  --search <query>            Text filter. Supports literal/fuzzy search or /pattern/flags regex',
		'  --date-from <YYYY-MM-DD>    Include threads rooted on or after this date',
		'  --date-to <YYYY-MM-DD>      Include threads rooted on or before this date',
		'  --limit <n>                 Save only the first n threads after sorting/filtering',
		'  --export-scope <scope>      filtered or all (default: filtered)',
		'  --pretty                    Pretty-print JSON',
		'  --force                     Overwrite an existing output file',
		'  --progress-jsonl            Emit machine-readable progress events on stdout',
		'  --help                      Show this help',
		'',
		'Examples:',
		'  node --import tsx scripts/export-repo-threads-json.ts alice.bsky.social --min-depth 3 --pretty',
		'  node --import tsx scripts/export-repo-threads-json.ts alice.bsky.social --search "/atproto/i" --date-from 2024-01-01'
	].join('\n');
}

function normalizeHandle(handle: string): string {
	return handle.replace(/^@/, '').trim();
}

function sanitizeHandleForFilename(handle: string): string {
	return handle.replace(/[^a-z0-9._-]+/gi, '_');
}

function defaultOutputPath(handle: string): string {
	return path.join(DEFAULT_OUTPUT_DIR, `${sanitizeHandleForFilename(handle)}.repo-threads.json`);
}

function parsePositiveInteger(value: string, flagName: string): number {
	const parsed = Number.parseInt(value, 10);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		throw new Error(`${flagName} must be a positive integer.`);
	}
	return parsed;
}

function parseCliArgs(argv: string[]): CliOptions {
	let handle: string | null = null;
	let outputPath: string | null = null;
	let minDepth = 2;
	let search = '';
	let dateFrom = '';
	let dateTo = '';
	let limit: number | null = null;
	let exportScope: ExportScope = 'filtered';
	let pretty = false;
	let force = false;
	let progressJsonl = false;

	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === '--help' || arg === '-h') {
			console.log(usage());
			process.exit(0);
		}
		if (arg === '--output') {
			outputPath = argv[++index] ?? '';
			if (!outputPath) throw new Error('--output requires a value.');
			continue;
		}
		if (arg === '--min-depth') {
			minDepth = parsePositiveInteger(argv[++index] ?? '', '--min-depth');
			continue;
		}
		if (arg === '--search') {
			search = argv[++index] ?? '';
			continue;
		}
		if (arg === '--date-from') {
			dateFrom = argv[++index] ?? '';
			continue;
		}
		if (arg === '--date-to') {
			dateTo = argv[++index] ?? '';
			continue;
		}
		if (arg === '--limit') {
			limit = parsePositiveInteger(argv[++index] ?? '', '--limit');
			continue;
		}
		if (arg === '--export-scope') {
			const nextScope = (argv[++index] ?? '') as ExportScope;
			if (nextScope !== 'filtered' && nextScope !== 'all') {
				throw new Error('--export-scope must be filtered or all.');
			}
			exportScope = nextScope;
			continue;
		}
		if (arg === '--pretty') {
			pretty = true;
			continue;
		}
		if (arg === '--force') {
			force = true;
			continue;
		}
		if (arg === '--progress-jsonl') {
			progressJsonl = true;
			continue;
		}
		if (arg.startsWith('-')) {
			throw new Error(`Unknown flag: ${arg}`);
		}
		if (!handle) {
			handle = arg;
			continue;
		}
		throw new Error(`Unexpected argument: ${arg}`);
	}

	return {
		handle,
		outputPath,
		minDepth,
		search,
		dateFrom,
		dateTo,
		limit,
		exportScope,
		pretty,
		force,
		progressJsonl
	};
}

function emitProgress(options: CliOptions, event: Record<string, unknown>): void {
	if (options.progressJsonl) {
		console.log(JSON.stringify({ timestamp: new Date().toISOString(), ...event }));
		return;
	}

	if (event.type === 'download') {
		const received = Number(event.receivedBytes ?? 0);
		const total = Number(event.totalBytes ?? 0);
		const totalText = total > 0 ? ` / ${formatBytes(total)}` : '';
		console.error(`Downloading repository: ${formatBytes(received)}${totalText}`);
		return;
	}

	if (event.type === 'parse') {
		console.error(`Parsing repository posts: ${Number(event.parsedPosts ?? 0).toLocaleString()}`);
		return;
	}

	if (event.type === 'build') {
		const current = Number(event.current ?? 0);
		const total = Number(event.total ?? 0);
		console.error(`Building threads: ${event.phase ?? ''} ${current.toLocaleString()} / ${total.toLocaleString()}`);
		return;
	}

	if (typeof event.message === 'string') {
		console.error(event.message);
	}
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function sha256Hex(bytes: Uint8Array): string {
	return createHash('sha256').update(bytes).digest('hex');
}

function compareIsoDateDesc(a: string, b: string): number {
	const aTime = new Date(a).getTime();
	const bTime = new Date(b).getTime();
	if (Number.isFinite(aTime) && Number.isFinite(bTime) && aTime !== bTime) {
		return bTime - aTime;
	}
	return a.localeCompare(b);
}

function compareThreadsByDepth(a: SelfReplyThread, b: SelfReplyThread): number {
	return (
		b.depth - a.depth ||
		compareIsoDateDesc(a.rootPost.createdAt, b.rootPost.createdAt) ||
		a.rootUri.localeCompare(b.rootUri)
	);
}

function buildSearchMatcher(query: string): ThreadSearchMatcher {
	const trimmed = query.trim();
	if (!trimmed) {
		return { mode: 'none', literal: null, fuzzy: null, regex: null, helperText: null, helperTone: null };
	}

	if (!trimmed.startsWith('/')) {
		return {
			mode: 'literal',
			literal: trimmed.toLowerCase(),
			fuzzy: buildFuzzyTextMatcher(trimmed),
			regex: null,
			helperText: null,
			helperTone: null
		};
	}

	let closingSlash = -1;
	let escapeNext = false;
	for (let i = 1; i < trimmed.length; i += 1) {
		if (trimmed[i] === '\\' && !escapeNext) {
			escapeNext = true;
			continue;
		}
		if (trimmed[i] === '/' && !escapeNext) closingSlash = i;
		escapeNext = false;
	}

	if (closingSlash <= 0) {
		return {
			mode: 'literal',
			literal: trimmed.toLowerCase(),
			fuzzy: buildFuzzyTextMatcher(trimmed),
			regex: null,
			helperText: null,
			helperTone: 'info'
		};
	}

	try {
		const pattern = trimmed.slice(1, closingSlash);
		const rawFlags = trimmed.slice(closingSlash + 1).toLowerCase();
		const flags = rawFlags.includes('i') ? rawFlags : `${rawFlags}i`;
		const regex = new RegExp(pattern, flags);
		return { mode: 'regex', literal: null, fuzzy: null, regex, helperText: null, helperTone: null };
	} catch {
		return {
			mode: 'literal',
			literal: trimmed.toLowerCase(),
			fuzzy: buildFuzzyTextMatcher(trimmed),
			regex: null,
			helperText: 'Invalid regex, using literal search.',
			helperTone: 'warning'
		};
	}
}

function matchesSearch(thread: SelfReplyThread, matcher: ThreadSearchMatcher): boolean {
	if (matcher.mode === 'none') return true;
	const regex = matcher.mode === 'regex' ? matcher.regex : null;
	const literal = matcher.mode === 'literal' ? matcher.literal : null;
	const fuzzy = matcher.mode === 'literal' ? matcher.fuzzy : null;

	function check(post: ThreadPost): boolean {
		if (regex) {
			regex.lastIndex = 0;
			if (regex.test(post.text)) return true;
		} else if (
			literal &&
			(post.text.toLowerCase().includes(literal) || (fuzzy && fuzzyTextMatches(post.text, fuzzy)))
		) {
			return true;
		}
		return post.children.some(check);
	}

	return check(thread.rootPost);
}

function isInDateRange(createdAt: string, dateFrom: string, dateTo: string): boolean {
	if (!dateFrom && !dateTo) return true;
	const postDate = new Date(createdAt);
	if (Number.isNaN(postDate.getTime())) return true;
	if (dateFrom && postDate < new Date(dateFrom)) return false;
	if (dateTo) {
		const to = new Date(dateTo);
		to.setHours(23, 59, 59, 999);
		if (postDate > to) return false;
	}
	return true;
}

function flattenThread(root: ThreadPost): ThreadPost[] {
	const result: ThreadPost[] = [];
	function walk(node: ThreadPost): void {
		result.push(node);
		for (const child of node.children) walk(child);
	}
	walk(root);
	return result;
}

function cloneThreadPost(post: ThreadPost, parentUri?: string): ThreadPost {
	return {
		...post,
		parentUri,
		children: post.children.map((child) => cloneThreadPost(child, post.uri))
	};
}

function countThreadCharacters(thread: SelfReplyThread): number {
	const seen = new Set<string>();
	function walk(post: ThreadPost): number {
		if (seen.has(post.uri)) return 0;
		seen.add(post.uri);
		return post.text.length + post.children.reduce((total, child) => total + walk(child), 0);
	}
	return walk(thread.rootPost);
}

function serializeThread(thread: SelfReplyThread): SerializedThread {
	const document = buildThreadAnalysisDocument(thread);
	const flatPosts = flattenThread(thread.rootPost);
	const createdAtValues = flatPosts
		.map((post) => post.createdAt)
		.filter((value): value is string => typeof value === 'string' && value.length > 0)
		.sort((a, b) => new Date(a).getTime() - new Date(b).getTime());

	return {
		rootUri: thread.rootUri,
		depth: thread.depth,
		postCount: flatPosts.length,
		characterCount: countThreadCharacters(thread),
		firstCreatedAt: createdAtValues[0] ?? thread.rootPost.createdAt,
		lastCreatedAt: createdAtValues[createdAtValues.length - 1] ?? thread.rootPost.createdAt,
		title: document.title,
		preview: document.preview,
		text: document.text,
		blueskyUrl: buildBskyPostUrl(thread.rootUri, thread.rootPost.author.handle),
		rootPost: cloneThreadPost(thread.rootPost)
	};
}

async function resolveProfile(handle: string): Promise<ProfileInfo> {
	const agent = new AtpAgent({ service: PROFILE_API });
	const response = await agent.getProfile({ actor: handle });
	return {
		did: response.data.did,
		handle: response.data.handle,
		displayName: response.data.displayName,
		avatar: response.data.avatar,
		postsCount: response.data.postsCount ?? 0
	};
}

async function downloadRepoCar(did: string, options: CliOptions): Promise<RepoDownloadResult> {
	const repoParams = new URLSearchParams({ did });
	const repoHeaders = { Accept: 'application/vnd.ipld.car' };
	const startTime = performance.now();

	let res: Response | null = null;
	let source: 'pds' | 'relay' = 'relay';
	const pdsEndpoint = await resolvePds(did);

	if (pdsEndpoint) {
		try {
			const pdsRes = await fetch(`${pdsEndpoint}/xrpc/com.atproto.sync.getRepo?${repoParams.toString()}`, {
				headers: repoHeaders
			});
			if (pdsRes.ok) {
				res = pdsRes;
				source = 'pds';
			}
		} catch {
			// Fall back to the relay.
		}
	}

	if (!res) {
		res = await fetch(`https://bsky.network/xrpc/com.atproto.sync.getRepo?${repoParams.toString()}`, {
			headers: repoHeaders
		});
		source = 'relay';
	}

	if (!res.ok) {
		const errorText = await res.text().catch(() => 'Unknown error');
		throw new Error(`Repository download failed (${res.status}): ${errorText}`);
	}

	const totalBytes = Number.parseInt(res.headers.get('content-length') || '0', 10);
	const reader = res.body?.getReader();
	if (!reader) throw new Error('Repository response body is not readable.');

	const chunks: Uint8Array[] = [];
	let downloadedBytes = 0;
	let lastProgressAt = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		chunks.push(value);
		downloadedBytes += value.length;

		const now = performance.now();
		if (now - lastProgressAt >= 250 || (totalBytes > 0 && downloadedBytes >= totalBytes)) {
			emitProgress(options, {
				type: 'download',
				phase: 'Downloading repository',
				receivedBytes: downloadedBytes,
				totalBytes,
				elapsedMs: now - startTime,
				source
			});
			lastProgressAt = now;
		}
	}

	const carBytes = new Uint8Array(downloadedBytes);
	let offset = 0;
	for (const chunk of chunks) {
		carBytes.set(chunk, offset);
		offset += chunk.length;
	}

	return {
		carBytes,
		downloadedBytes,
		totalBytes,
		elapsedMs: Math.round(performance.now() - startTime),
		source
	};
}

async function parseRepoPostsFromCar(carBytes: Uint8Array, options: CliOptions): Promise<ParsedPost[]> {
	return parseCarPosts(
		carBytes,
		{
			CarReader,
			dagCbor
		},
		(count) => {
			emitProgress(options, {
				type: 'parse',
				phase: 'Parsing repository posts',
				parsedPosts: count
			});
		}
	);
}

function buildPayload(
	profile: ProfileInfo,
	repoDownload: RepoDownloadResult,
	parsedPosts: ParsedPost[],
	options: CliOptions
): ExportPayload {
	const author: AuthorInfo = {
		did: profile.did,
		handle: profile.handle,
		displayName: profile.displayName,
		avatar: profile.avatar
	};
	const feedItems = repoPostsToFeedItems(profile.did, parsedPosts, author);
	const buildResult = buildThreadsFromFeed(feedItems, profile.did, (progress) => {
		emitProgress(options, {
			type: 'build',
			phase: progress.phase,
			current: progress.current,
			total: progress.total,
			detail: progress.detail
		});
	});

	const sortedThreads = [...buildResult.threads].sort(compareThreadsByDepth);
	const matcher = buildSearchMatcher(options.search);
	const filteredThreads = sortedThreads.filter(
		(thread) =>
			thread.depth >= options.minDepth &&
			isInDateRange(thread.rootPost.createdAt, options.dateFrom, options.dateTo) &&
			matchesSearch(thread, matcher)
	);
	const scopedThreads = options.exportScope === 'all' ? sortedThreads : filteredThreads;
	const selectedThreads = options.limit ? scopedThreads.slice(0, options.limit) : scopedThreads;
	const serializedThreads = selectedThreads.map(serializeThread);
	const threadsWithSelfReplies = buildResult.threads.filter((thread) => thread.depth >= 2).length;
	const maxDepth = buildResult.threads.length > 0 ? Math.max(...buildResult.threads.map((thread) => thread.depth)) : 0;

	return {
		schemaVersion: SCHEMA_VERSION,
		kind: 'bsky-repo-thread-json',
		generatedAt: new Date().toISOString(),
		profile,
		repo: {
			source: repoDownload.source,
			downloadedBytes: repoDownload.downloadedBytes,
			totalBytes: repoDownload.totalBytes,
			elapsedMs: repoDownload.elapsedMs,
			carSha256: sha256Hex(repoDownload.carBytes),
			parsedPosts: parsedPosts.length
		},
		filters: {
			minDepth: options.minDepth,
			search: options.search,
			dateFrom: options.dateFrom,
			dateTo: options.dateTo,
			limit: options.limit,
			exportScope: options.exportScope,
			searchMode: matcher.mode,
			searchHelperText: matcher.helperText
		},
		stats: {
			postsScanned: feedItems.length,
			chainStarts: buildResult.threads.length,
			threadsWithSelfReplies,
			maxDepth,
			filteredThreads: filteredThreads.length,
			exportedThreads: serializedThreads.length,
			exportedCharacters: serializedThreads.reduce((sum, thread) => sum + thread.characterCount, 0),
			exportedPosts: serializedThreads.reduce((sum, thread) => sum + thread.postCount, 0)
		},
		threads: serializedThreads
	};
}

async function writeJsonFile(outputPath: string, payload: ExportPayload, options: CliOptions): Promise<void> {
	const resolvedOutputPath = path.resolve(process.cwd(), outputPath);
	await mkdir(path.dirname(resolvedOutputPath), { recursive: true });

	const json = options.pretty ? `${JSON.stringify(payload, null, 2)}\n` : JSON.stringify(payload);
	try {
		await writeFile(resolvedOutputPath, json, { flag: options.force ? 'w' : 'wx' });
	} catch (error: any) {
		if (error?.code === 'EEXIST') {
			throw new Error(`Output already exists: ${resolvedOutputPath} (pass --force to overwrite).`);
		}
		throw error;
	}
}

async function main(): Promise<void> {
	const options = parseCliArgs(process.argv.slice(2));
	const handle = options.handle ? normalizeHandle(options.handle) : '';
	if (!handle) throw new Error('A Bluesky handle is required.');

	emitProgress(options, { type: 'profile', message: `Resolving profile for ${handle}...` });
	const profile = await resolveProfile(handle);
	const outputPath = options.outputPath ? path.resolve(process.cwd(), options.outputPath) : defaultOutputPath(profile.handle);

	emitProgress(options, {
		type: 'profile',
		message: `Resolved ${profile.handle} (${profile.did}).`,
		handle: profile.handle,
		did: profile.did
	});

	const repoDownload = await downloadRepoCar(profile.did, options);
	emitProgress(options, {
		type: 'downloaded',
		message: `Repository download complete via ${repoDownload.source.toUpperCase()}.`,
		downloadedBytes: repoDownload.downloadedBytes,
		totalBytes: repoDownload.totalBytes,
		elapsedMs: repoDownload.elapsedMs,
		source: repoDownload.source
	});

	const parsedPosts = await parseRepoPostsFromCar(repoDownload.carBytes, options);
	emitProgress(options, {
		type: 'parsed',
		message: `Parsed ${parsedPosts.length.toLocaleString()} posts.`,
		parsedPosts: parsedPosts.length
	});

	const payload = buildPayload(profile, repoDownload, parsedPosts, options);
	if (payload.threads.length === 0) {
		emitProgress(options, {
			type: 'empty',
			message: 'No threads matched the selected filters.'
		});
	}

	emitProgress(options, {
		type: 'write',
		message: `Writing JSON to ${outputPath}...`,
		outputPath
	});
	await writeJsonFile(outputPath, payload, options);

	emitProgress(options, {
		type: 'done',
		message: `JSON written to ${outputPath}.`,
		outputPath,
		stats: payload.stats,
		profile: payload.profile,
		repo: payload.repo
	});
}

void main().catch((error: any) => {
	console.error(error?.message || 'Repo thread JSON export failed.');
	if (error?.stack && process.env.DEBUG && !process.argv.includes('--progress-jsonl')) {
		console.error(error.stack);
	}
	process.exitCode = 1;
});
