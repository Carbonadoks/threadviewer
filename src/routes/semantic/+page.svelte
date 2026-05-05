<script lang="ts">
	import { onMount } from 'svelte';
	import { browser } from '$app/environment';
	import '../../app.css';
	import { getFullThread } from '$lib/api/bluesky';
	import BoardView from '$lib/components/BoardView.svelte';
	import ErrorBanner from '$lib/components/ErrorBanner.svelte';
	import FontPicker from '$lib/components/FontPicker.svelte';
	import GroupChat from '$lib/components/GroupChat.svelte';
	import LoadingSpinner from '$lib/components/LoadingSpinner.svelte';
	import ParallelBoardView from '$lib/components/ParallelBoardView.svelte';
	import RouteNav from '$lib/components/RouteNav.svelte';
	import VirtualThreadList from '$lib/components/VirtualThreadList.svelte';
	import type { SelfReplyThread, ThreadPost } from '$lib/types';
	import { buildSemanticSelfReplyThreads, compareIsoDateDesc } from '$lib/utils/semanticThreads';
	import { toastError, toastSuccess } from '$lib/utils/toasts';
	import { buildBskyPostUrl } from '$lib/utils/viewerLinks';

	type SemanticBucketFile = {
		key: string;
		prefix: string;
		filename: string;
		size: number;
		uploadedAt: string | null;
		downloadPath: string;
	};

	type SemanticDbKind =
		| 'bsky-post-embedding-db'
		| 'bsky-thread-embedding-db'
		| 'bsky-window-embedding-db';

	type SemanticDbSummary = {
		filename: string;
		handle: string;
		did: string;
		displayName: string | null;
		avatar: string | null;
		kind: SemanticDbKind;
		embeddedPosts: number;
		embeddedWindows: number;
		embeddedThreads: number;
		embeddedSegments: number;
		threadPostCount: number;
		embeddingDim: number;
		generatedAt: string | null;
	};

	type LoadedSemanticSearchUnit = {
		uri: string;
		sourcePostUri: string;
		rootUri: string;
		createdAt: string;
		parentUri: string | null;
		isReply: boolean;
		text: string;
		charLength: number;
		tokenEstimate: number;
		unitKind: 'post' | 'segment' | 'window';
		embedding: Float32Array;
	};

	type SemanticDisplayedPost = Omit<LoadedSemanticSearchUnit, 'embedding'> & {
		score: number | null;
		rank: number;
	};

	type ThreadDbRow = {
		rootUri: string;
		depth: number;
		postCount: number;
		segmentCount: number;
		firstCreatedAt: string;
		lastCreatedAt: string;
		title: string;
		preview: string;
		text: string;
	};

	type ThreadDbPostRow = {
		rootUri: string;
		postIndex: number;
		uri: string;
		createdAt: string;
		parentUri: string | null;
		text: string;
		charLength: number;
		tokenEstimate: number;
	};

	type ResultMode = 'threads' | 'posts';

	type ThreadRenderMode = 'default' | 'chat' | 'conspiracy' | 'ransom';
	type ExpandedViewMode = 'chat' | 'board' | 'parallel';
	type ExpandedSemanticThread = SelfReplyThread & { isTruncated?: boolean };

	type LoadedSemanticDb = {
		kind: SemanticDbKind;
		secondaryResultLabel: 'posts' | 'segments' | 'windows';
		sourceLabel: string;
		sourceUrl: string | null;
		sourceKey: string | null;
		summary: SemanticDbSummary;
		searchUnits: LoadedSemanticSearchUnit[];
		searchUnitsByNewest: LoadedSemanticSearchUnit[];
		threads: SelfReplyThread[];
		rootUriByPostUri: Map<string, string>;
	};

	type QueryVectorPayload = {
		query?: string;
		vector?: number[];
		model?: string;
		pooling?: string;
		message?: string;
	};

	const fontFamilies: Record<string, string> = {
		virgil: "'Virgil', cursive",
		caveat: "'Caveat', cursive",
		patrick: "'Patrick Hand', cursive",
		'comic-neue': "'Comic Neue', cursive",
		inter: "'Inter', sans-serif",
		system: 'system-ui, -apple-system, sans-serif'
	};

	let fontKey = $state('patrick');
	let fontFamily = $derived(fontFamilies[fontKey] ?? fontFamilies.virgil);
	let filesLoading = $state(false);
	let filesError: string | null = $state(null);
	let availableFiles = $state<SemanticBucketFile[]>([]);
	let selectedFileKey = $state('');
	let dbLoading = $state(false);
	let dbError: string | null = $state(null);
	let loadedDb = $state<LoadedSemanticDb | null>(null);
	let resultMode = $state<ResultMode>('posts');
	let renderMode = $state<ThreadRenderMode>('default');
	let queryText = $state('');
	let activeQuery = $state('');
	let searchLoading = $state(false);
	let searchError: string | null = $state(null);
	let rankedPosts = $state<SemanticDisplayedPost[]>([]);
	let visibleCount = $state(200);
	let searchRequestId = 0;
	let embeddingModelLabel = $state('');
	let collapsedByRootUri = $state<Record<string, boolean>>({});
	let pendingScrollToRootUri: string | null = $state(null);
	let expandedThread = $state<ExpandedSemanticThread | null>(null);
	let expandedLoading = $state(false);
	let showExpanded = $state(false);
	let expandedError: string | null = $state(null);
	let expandedViewMode = $state<ExpandedViewMode>('chat');
	let savedScrollY = 0;
	let sqlModulePromise: Promise<any> | null = null;

	const loadedSummary = $derived(loadedDb?.summary ?? null);
	const secondaryResultLabel = $derived(loadedDb?.secondaryResultLabel ?? 'posts');
	const displayPosts = $derived.by(() => {
		if (!loadedDb) return [] as SemanticDisplayedPost[];
		if (activeQuery) return rankedPosts;

		return loadedDb.searchUnitsByNewest.map((post, index) => ({
			uri: post.uri,
			sourcePostUri: post.sourcePostUri,
			rootUri: post.rootUri,
			createdAt: post.createdAt,
			parentUri: post.parentUri,
			isReply: post.isReply,
			text: post.text,
			charLength: post.charLength,
			tokenEstimate: post.tokenEstimate,
			unitKind: post.unitKind,
			score: null,
			rank: index + 1
		}));
	});
	const visiblePosts = $derived(displayPosts.slice(0, visibleCount));
	const highlightedPostByRootUri = $derived.by(() => {
		if (!loadedDb || !activeQuery || rankedPosts.length === 0) {
			return {} as Record<string, string>;
		}

		const bestPostByRootUri = new Map<string, { uri: string; score: number }>();
		for (const post of rankedPosts) {
			if (post.score === null) continue;
			const rootUri = post.rootUri;
			const previous = bestPostByRootUri.get(rootUri);
			if (!previous || post.score > previous.score) {
				bestPostByRootUri.set(rootUri, { uri: post.sourcePostUri, score: post.score });
			}
		}

		return Object.fromEntries(
			[...bestPostByRootUri.entries()].map(([rootUri, best]) => [rootUri, best.uri])
		);
	});
	const displayThreads = $derived.by(() => {
		if (!loadedDb) return [] as SelfReplyThread[];
		if (!activeQuery || rankedPosts.length === 0) {
			return [...loadedDb.threads].sort(
				(a, b) =>
					b.depth - a.depth ||
					compareIsoDateDesc(a.rootPost.createdAt, b.rootPost.createdAt) ||
					a.rootUri.localeCompare(b.rootUri)
			);
		}

		const bestScoreByRootUri = new Map<string, number>();
		for (const post of rankedPosts) {
			const rootUri = post.rootUri;
			const previous = bestScoreByRootUri.get(rootUri);
			if (previous === undefined || post.score === null || post.score > previous) {
				bestScoreByRootUri.set(rootUri, post.score ?? Number.NEGATIVE_INFINITY);
			}
		}

		return [...loadedDb.threads].sort((a, b) => {
			const scoreA = bestScoreByRootUri.get(a.rootUri) ?? Number.NEGATIVE_INFINITY;
			const scoreB = bestScoreByRootUri.get(b.rootUri) ?? Number.NEGATIVE_INFINITY;
			return (
				scoreB - scoreA ||
				b.depth - a.depth ||
				compareIsoDateDesc(a.rootPost.createdAt, b.rootPost.createdAt) ||
				a.rootUri.localeCompare(b.rootUri)
			);
		});
	});

	function formatDate(value: string): string {
		const parsed = new Date(value);
		return Number.isFinite(parsed.getTime()) ? parsed.toLocaleString() : value;
	}

	function formatCompactDate(value: string | null): string {
		if (!value) return 'Unknown date';
		const parsed = new Date(value);
		return Number.isFinite(parsed.getTime()) ? parsed.toLocaleDateString() : value;
	}

	function formatScore(score: number | null): string {
		if (score === null) return '';
		return score.toFixed(4);
	}

	function formatBytes(bytes: number): string {
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
		if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
		return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
	}

	function handleFontChange(key: string) {
		fontKey = key;
		try {
			localStorage.setItem('preferred-font', key);
		} catch {}
	}

	function handleResultModeChange(nextMode: ResultMode) {
		if (resultMode === nextMode) return;
		resultMode = nextMode;
		updateUrl();
	}

	function isThreadCollapsed(rootUri: string): boolean {
		return collapsedByRootUri[rootUri] ?? true;
	}

	function setThreadCollapsed(rootUri: string, collapsed: boolean) {
		if (isThreadCollapsed(rootUri) === collapsed) return;
		collapsedByRootUri = {
			...collapsedByRootUri,
			[rootUri]: collapsed
		};
	}

	function handleScrollToRootUriComplete(rootUri: string, _found: boolean) {
		if (pendingScrollToRootUri !== rootUri) return;
		pendingScrollToRootUri = null;
	}

	function resetExpandedState() {
		showExpanded = false;
		expandedLoading = false;
		expandedThread = null;
		expandedError = null;
		expandedViewMode = 'chat';
	}

	function updateUrl() {
		if (!browser) return;

		const url = new URL(window.location.href);
		if (selectedFileKey) {
			url.searchParams.set('key', selectedFileKey);
		} else {
			url.searchParams.delete('key');
		}

		if (activeQuery) {
			url.searchParams.set('q', activeQuery);
		} else {
			url.searchParams.delete('q');
		}

		if (resultMode !== 'posts') {
			url.searchParams.set('mode', resultMode);
		} else {
			url.searchParams.delete('mode');
		}

		window.history.replaceState({}, '', url.toString());
	}

	function semanticReturnTo(): string {
		if (browser) {
			return `${window.location.pathname}${window.location.search}`;
		}

		const params = new URLSearchParams();
		if (selectedFileKey) params.set('key', selectedFileKey);
		if (activeQuery) params.set('q', activeQuery);
		if (resultMode !== 'posts') params.set('mode', resultMode);
		const query = params.toString();
		return query ? `/semantic?${query}` : '/semantic';
	}

	function threadViewerUrl(uri: string): string | null {
		const bskyUrl = buildBskyPostUrl(uri, loadedSummary?.handle ?? null);
		if (!bskyUrl) return null;

		return `/?url=${encodeURIComponent(bskyUrl)}&view=thread&returnTo=${encodeURIComponent(semanticReturnTo())}`;
	}

	function handleOpenOnBluesky(rootUri: string) {
		const bskyUrl = buildBskyPostUrl(rootUri, loadedSummary?.handle ?? null);
		if (!bskyUrl || !browser) return;
		window.open(bskyUrl, '_blank', 'noopener,noreferrer');
	}

	async function copyExpandedThreadLink() {
		if (!expandedThread || !browser) return;
		const bskyUrl = buildBskyPostUrl(
			expandedThread.rootUri,
			expandedThread.rootPost.author.handle || loadedSummary?.handle || null
		);
		if (!bskyUrl) {
			toastError('Could not build a Bluesky link for this thread.');
			return;
		}

		try {
			await navigator.clipboard.writeText(bskyUrl);
			toastSuccess('Bluesky link copied to clipboard');
		} catch {
			toastError('Failed to copy thread link.');
		}
	}

	async function openExpandedThread(uri: string) {
		if (browser) {
			savedScrollY = window.scrollY;
		}

		expandedLoading = true;
		showExpanded = true;
		expandedError = null;
		expandedThread = null;

		try {
			expandedThread = await getFullThread(uri);
		} catch (error: any) {
			const message = error?.message || 'Failed to load the full thread.';
			expandedError = message;
			toastError(message);
		} finally {
			expandedLoading = false;
		}
	}

	function handleExpandThread(rootUri: string) {
		void openExpandedThread(rootUri);
	}

	function handleExpandedBack() {
		resetExpandedState();
		if (!browser) return;
		requestAnimationFrame(() => {
			window.scrollTo(0, savedScrollY);
		});
	}

	function metaString(meta: Map<string, string>, key: string): string | null {
		const value = meta.get(key)?.trim() || '';
		return value ? value : null;
	}

	function metaNumber(meta: Map<string, string>, key: string): number {
		const value = Number.parseInt(meta.get(key) || '0', 10);
		return Number.isFinite(value) ? value : 0;
	}

	function detectDbKind(meta: Map<string, string>, db: any): SemanticDbKind {
		const kind = metaString(meta, 'kind');
		if (
			kind === 'bsky-thread-embedding-db' ||
			kind === 'bsky-post-embedding-db' ||
			kind === 'bsky-window-embedding-db'
		) {
			return kind;
		}

		const windowStmt = db.prepare(
			"SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'windows' LIMIT 1"
		);
		try {
			if (windowStmt.step()) {
				return 'bsky-window-embedding-db';
			}
		} finally {
			windowStmt.free();
		}

		const threadStmt = db.prepare(
			"SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'threads' LIMIT 1"
		);
		try {
			if (threadStmt.step()) {
				return 'bsky-thread-embedding-db';
			}
		} finally {
			threadStmt.free();
		}

		return 'bsky-post-embedding-db';
	}

	function tableColumns(db: any, tableName: string): Set<string> {
		const stmt = db.prepare(`PRAGMA table_info(${tableName})`);
		const columns = new Set<string>();
		try {
			while (stmt.step()) {
				const [, name] = stmt.get() as [unknown, unknown];
				if (typeof name === 'string' && name) {
					columns.add(name);
				}
			}
		} finally {
			stmt.free();
		}
		return columns;
	}

	function normalizeSummary(
		meta: Map<string, string>,
		sourceLabel: string,
		kind: SemanticDbKind
	): SemanticDbSummary {
		const embeddedPosts =
			metaNumber(meta, 'embedded_posts') ||
			metaNumber(meta, 'embedded_thread_posts') ||
			metaNumber(meta, 'thread_post_count');
		const embeddedThreads =
			metaNumber(meta, 'embedded_threads') || metaNumber(meta, 'threads_selected');
		const embeddedSegments =
			metaNumber(meta, 'embedded_segments') || metaNumber(meta, 'segment_count');
		const threadPostCount =
			metaNumber(meta, 'embedded_thread_posts') || metaNumber(meta, 'thread_post_count');

		return {
			filename: sourceLabel,
			handle: metaString(meta, 'handle') || sourceLabel.replace(/\.sqlite$/i, ''),
			did: metaString(meta, 'did') || '',
			displayName: metaString(meta, 'display_name'),
			avatar: metaString(meta, 'avatar'),
			kind,
			embeddedPosts,
			embeddedWindows: metaNumber(meta, 'embedded_windows') || metaNumber(meta, 'window_count'),
			embeddedThreads,
			embeddedSegments,
			threadPostCount,
			embeddingDim:
				metaNumber(meta, 'embedding_dim') ||
				metaNumber(meta, 'segment_embedding_dim') ||
				metaNumber(meta, 'thread_embedding_dim'),
			generatedAt: metaString(meta, 'generated_at')
		};
	}

	function summaryStats(summary: SemanticDbSummary, threadCount: number): string {
		if (summary.kind === 'bsky-thread-embedding-db') {
			const threadTotal = summary.embeddedThreads || threadCount;
			const segmentTotal = summary.embeddedSegments;
			const postTotal = summary.threadPostCount;
			return [
				`${threadTotal.toLocaleString()} threads`,
				`${segmentTotal.toLocaleString()} segments`,
				postTotal > 0 ? `${postTotal.toLocaleString()} thread posts` : null,
				summary.embeddingDim > 0 ? `${summary.embeddingDim}-dim embeddings` : null
			]
				.filter(Boolean)
				.join(' - ');
		}

		if (summary.kind === 'bsky-window-embedding-db') {
			return [
				`${summary.embeddedWindows.toLocaleString()} windows`,
				`${summary.embeddedPosts.toLocaleString()} posts`,
				`${threadCount.toLocaleString()} self-reply threads`,
				summary.embeddingDim > 0 ? `${summary.embeddingDim}-dim embeddings` : null
			]
				.filter(Boolean)
				.join(' - ');
		}

		return [
			`${summary.embeddedPosts.toLocaleString()} posts`,
			`${threadCount.toLocaleString()} self-reply threads`,
			summary.embeddingDim > 0 ? `${summary.embeddingDim}-dim embeddings` : null
		]
			.filter(Boolean)
			.join(' - ');
	}

	function rawResultLabel(kind: SemanticDbKind): 'posts' | 'segments' | 'windows' {
		if (kind === 'bsky-thread-embedding-db') return 'segments';
		if (kind === 'bsky-window-embedding-db') return 'windows';
		return 'posts';
	}

	function rawResultHeading(kind: SemanticDbKind, hasQuery: boolean): string {
		const label = rawResultLabel(kind);
		const singular = label === 'posts' ? 'Post' : label === 'segments' ? 'Segment' : 'Window';
		const plural = singular.endsWith('s') ? singular : `${singular}s`;
		return `${hasQuery ? 'Ranked' : 'All'} ${plural}`;
	}

	function bestMatchLabel(kind: SemanticDbKind): 'post' | 'segment' | 'window' {
		if (kind === 'bsky-thread-embedding-db') return 'segment';
		if (kind === 'bsky-window-embedding-db') return 'window';
		return 'post';
	}

	function makeThreadPost(
		summary: SemanticDbSummary,
		post: {
			uri: string;
			createdAt: string;
			text: string;
			parentUri?: string | null;
		}
	): ThreadPost {
		return {
			uri: post.uri,
			cid: '',
			author: {
				did: summary.did,
				handle: summary.handle,
				displayName: summary.displayName || undefined,
				avatar: summary.avatar || undefined
			},
			text: post.text,
			createdAt: post.createdAt,
			linkedUrls: [],
			needsHydratedPostView: true,
			likeCount: 0,
			repostCount: 0,
			replyCount: 0,
			quoteCount: 0,
			parentUri: post.parentUri || undefined,
			children: []
		};
	}

	function blobToVector(value: unknown): Float32Array {
		const bytes =
			value instanceof Uint8Array
				? value
				: value instanceof ArrayBuffer
					? new Uint8Array(value)
					: null;

		if (!bytes) {
			throw new Error('Encountered an invalid embedding blob while reading the SQLite DB.');
		}

		return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
	}

	function buildThreadsFromPostRows(
		summary: SemanticDbSummary,
		rows: Array<{
			uri: string;
			createdAt: string;
			parentUri: string | null;
			threadRootUri: string;
			text: string;
		}>
	): {
		threads: SelfReplyThread[];
		rootUriByPostUri: Map<string, string>;
	} {
		return buildSemanticSelfReplyThreads(rows, {
			did: summary.did,
			handle: summary.handle,
			displayName: summary.displayName,
			avatar: summary.avatar
		});
	}

	function dotProduct(a: ArrayLike<number>, b: ArrayLike<number>): number {
		let total = 0;
		const length = Math.min(a.length, b.length);
		for (let index = 0; index < length; index++) {
			total += a[index] * b[index];
		}
		return total;
	}

	async function getSqlModule() {
		if (!browser) {
			throw new Error('The semantic SQLite loader only runs in the browser.');
		}

		if (!sqlModulePromise) {
			sqlModulePromise = Promise.all([
				import('sql.js'),
				import('sql.js/dist/sql-wasm.wasm?url')
			]).then(async ([sqlModule, wasmModule]) => {
				const initSqlJs = sqlModule.default;
				const wasmUrl = wasmModule.default;
				return initSqlJs({
					locateFile: () => wasmUrl
				});
			});
		}

		return sqlModulePromise;
	}

	function extractPostDb(
		db: any,
		meta: Map<string, string>,
		sourceLabel: string,
		sourceUrl: string | null,
		sourceKey: string | null
	): LoadedSemanticDb {
		const posts: LoadedSemanticSearchUnit[] = [];
		const postStmt = db.prepare(`
			SELECT
				uri,
				created_at,
				parent_uri,
				thread_root_uri,
				is_reply,
				text,
				char_length,
				token_estimate,
				embedding_f32
			FROM posts
		`);

		try {
			while (postStmt.step()) {
				const [
					uri,
					createdAt,
					parentUri,
					threadRootUri,
					isReply,
					text,
					charLength,
					tokenEstimate,
					embeddingBlob
				] = postStmt.get() as [
					unknown,
					unknown,
					unknown,
					unknown,
					unknown,
					unknown,
					unknown,
					unknown,
					unknown
				];

				posts.push({
					uri: String(uri || ''),
					sourcePostUri: String(uri || ''),
					rootUri: String(threadRootUri || uri || ''),
					createdAt: String(createdAt || ''),
					parentUri: typeof parentUri === 'string' && parentUri ? parentUri : null,
					isReply: Boolean(isReply),
					text: String(text || ''),
					charLength: Number(charLength) || 0,
					tokenEstimate: Number(tokenEstimate) || 0,
					unitKind: 'post',
					embedding: blobToVector(embeddingBlob)
				});
			}
		} finally {
			postStmt.free();
		}

		const summary = normalizeSummary(meta, sourceLabel, 'bsky-post-embedding-db');
		if (!summary.embeddedPosts) {
			summary.embeddedPosts = posts.length;
		}
		if (!summary.embeddingDim) {
			summary.embeddingDim = posts[0]?.embedding.length || 0;
		}

		const searchUnitsByNewest = [...posts].sort(
			(a, b) => compareIsoDateDesc(a.createdAt, b.createdAt) || a.uri.localeCompare(b.uri)
		);
		const { threads, rootUriByPostUri } = buildThreadsFromPostRows(
			summary,
			searchUnitsByNewest.map((post) => ({
				uri: post.uri,
				createdAt: post.createdAt,
				parentUri: post.parentUri,
				threadRootUri: post.rootUri,
				text: post.text
			}))
		);

		return {
			kind: 'bsky-post-embedding-db',
			secondaryResultLabel: 'posts',
			sourceLabel,
			sourceUrl,
			sourceKey,
			summary,
			searchUnits: posts,
			searchUnitsByNewest,
			threads,
			rootUriByPostUri
		};
	}

	function extractWindowDb(
		db: any,
		meta: Map<string, string>,
		sourceLabel: string,
		sourceUrl: string | null,
		sourceKey: string | null
	): LoadedSemanticDb {
		const summary = normalizeSummary(meta, sourceLabel, 'bsky-window-embedding-db');
		const postRows: Array<{
			uri: string;
			createdAt: string;
			parentUri: string | null;
			threadRootUri: string;
			text: string;
		}> = [];
		const postStmt = db.prepare(`
			SELECT
				uri,
				created_at,
				parent_uri,
				thread_root_uri,
				text
			FROM posts
		`);

		try {
			while (postStmt.step()) {
				const [uri, createdAt, parentUri, threadRootUri, text] = postStmt.get() as [
					unknown,
					unknown,
					unknown,
					unknown,
					unknown
				];

				postRows.push({
					uri: String(uri || ''),
					createdAt: String(createdAt || ''),
					parentUri: typeof parentUri === 'string' && parentUri ? parentUri : null,
					threadRootUri: String(threadRootUri || uri || ''),
					text: String(text || '')
				});
			}
		} finally {
			postStmt.free();
		}

		const searchUnits: LoadedSemanticSearchUnit[] = [];
		const windowStmt = db.prepare(`
			SELECT
				window_uri,
				focal_post_uri,
				thread_root_uri,
				created_at,
				parent_uri,
				text,
				char_length,
				token_estimate,
				embedding_f32
			FROM windows
		`);

		try {
			while (windowStmt.step()) {
				const [
					windowUri,
					focalPostUri,
					threadRootUri,
					createdAt,
					parentUri,
					text,
					charLength,
					tokenEstimate,
					embeddingBlob
				] = windowStmt.get() as [
					unknown,
					unknown,
					unknown,
					unknown,
					unknown,
					unknown,
					unknown,
					unknown,
					unknown
				];

				if (embeddingBlob == null) continue;

				searchUnits.push({
					uri: String(windowUri || ''),
					sourcePostUri: String(focalPostUri || ''),
					rootUri: String(threadRootUri || focalPostUri || ''),
					createdAt: String(createdAt || ''),
					parentUri: typeof parentUri === 'string' && parentUri ? parentUri : null,
					isReply: Boolean(parentUri),
					text: String(text || ''),
					charLength: Number(charLength) || 0,
					tokenEstimate: Number(tokenEstimate) || 0,
					unitKind: 'window',
					embedding: blobToVector(embeddingBlob)
				});
			}
		} finally {
			windowStmt.free();
		}

		if (!summary.embeddedPosts) {
			summary.embeddedPosts = postRows.length;
		}
		if (!summary.embeddedWindows) {
			summary.embeddedWindows = searchUnits.length;
		}
		if (!summary.embeddingDim) {
			summary.embeddingDim = searchUnits[0]?.embedding.length || 0;
		}

		const searchUnitsByNewest = [...searchUnits].sort(
			(a, b) => compareIsoDateDesc(a.createdAt, b.createdAt) || a.uri.localeCompare(b.uri)
		);
		const { threads, rootUriByPostUri } = buildThreadsFromPostRows(summary, postRows);

		return {
			kind: 'bsky-window-embedding-db',
			secondaryResultLabel: 'windows',
			sourceLabel,
			sourceUrl,
			sourceKey,
			summary,
			searchUnits,
			searchUnitsByNewest,
			threads,
			rootUriByPostUri
		};
	}

	function extractThreadDb(
		db: any,
		meta: Map<string, string>,
		sourceLabel: string,
		sourceUrl: string | null,
		sourceKey: string | null
	): LoadedSemanticDb {
		const summary = normalizeSummary(meta, sourceLabel, 'bsky-thread-embedding-db');
		const rootUriByPostUri = new Map<string, string>();
		const threadRows: ThreadDbRow[] = [];
		const threadStmt = db.prepare(`
			SELECT
				root_uri,
				depth,
				post_count,
				segment_count,
				first_post_created_at,
				last_post_created_at,
				title,
				preview,
				text
			FROM threads
		`);

		try {
			while (threadStmt.step()) {
				const [
					rootUri,
					depth,
					postCount,
					segmentCount,
					firstCreatedAt,
					lastCreatedAt,
					title,
					preview,
					text
				] = threadStmt.get() as [
					unknown,
					unknown,
					unknown,
					unknown,
					unknown,
					unknown,
					unknown,
					unknown,
					unknown
				];

				threadRows.push({
					rootUri: String(rootUri || ''),
					depth: Number(depth) || 1,
					postCount: Number(postCount) || 0,
					segmentCount: Number(segmentCount) || 0,
					firstCreatedAt: String(firstCreatedAt || ''),
					lastCreatedAt: String(lastCreatedAt || ''),
					title: String(title || ''),
					preview: String(preview || ''),
					text: String(text || '')
				});
			}
		} finally {
			threadStmt.free();
		}

		const threadPostColumns = tableColumns(db, 'thread_posts');
		const hasParentUri = threadPostColumns.has('parent_uri');
		const threadPostRows = new Map<string, ThreadDbPostRow[]>();
		const threadPostStmt = db.prepare(`
			SELECT
				root_uri,
				post_index,
				uri,
				created_at,
				${hasParentUri ? 'parent_uri' : 'NULL AS parent_uri'},
				text,
				char_length,
				token_estimate
			FROM thread_posts
			ORDER BY root_uri ASC, post_index ASC, created_at ASC
		`);

		try {
			while (threadPostStmt.step()) {
				const [
					rootUri,
					postIndex,
					uri,
					createdAt,
					parentUri,
					text,
					charLength,
					tokenEstimate
				] = threadPostStmt.get() as [
					unknown,
					unknown,
					unknown,
					unknown,
					unknown,
					unknown,
					unknown,
					unknown
				];

				const row: ThreadDbPostRow = {
					rootUri: String(rootUri || ''),
					postIndex: Number(postIndex) || 0,
					uri: String(uri || ''),
					createdAt: String(createdAt || ''),
					parentUri: typeof parentUri === 'string' && parentUri ? parentUri : null,
					text: String(text || ''),
					charLength: Number(charLength) || 0,
					tokenEstimate: Number(tokenEstimate) || 0
				};

				rootUriByPostUri.set(row.uri, row.rootUri);
				const rows = threadPostRows.get(row.rootUri);
				if (rows) {
					rows.push(row);
				} else {
					threadPostRows.set(row.rootUri, [row]);
				}
			}
		} finally {
			threadPostStmt.free();
		}

		const searchUnits: LoadedSemanticSearchUnit[] = [];
		const segmentStmt = db.prepare(`
			SELECT
				segment_uri,
				root_uri,
				source_post_uri,
				created_at,
				text,
				char_length,
				token_estimate,
				embedding_f32
			FROM segments
		`);

		try {
			while (segmentStmt.step()) {
				const [
					segmentUri,
					rootUri,
					sourcePostUri,
					createdAt,
					text,
					charLength,
					tokenEstimate,
					embeddingBlob
				] = segmentStmt.get() as [
					unknown,
					unknown,
					unknown,
					unknown,
					unknown,
					unknown,
					unknown,
					unknown
				];

				searchUnits.push({
					uri: String(segmentUri || ''),
					sourcePostUri: String(sourcePostUri || rootUri || ''),
					rootUri: String(rootUri || ''),
					createdAt: String(createdAt || ''),
					parentUri: null,
					isReply: String(sourcePostUri || '') !== String(rootUri || ''),
					text: String(text || ''),
					charLength: Number(charLength) || 0,
					tokenEstimate: Number(tokenEstimate) || 0,
					unitKind: 'segment',
					embedding: blobToVector(embeddingBlob)
				});
			}
		} finally {
			segmentStmt.free();
		}

		if (!summary.embeddedThreads) {
			summary.embeddedThreads = threadRows.length;
		}
		if (!summary.embeddedSegments) {
			summary.embeddedSegments = searchUnits.length;
		}
		if (!summary.threadPostCount) {
			summary.threadPostCount = [...threadPostRows.values()].reduce(
				(sum, rows) => sum + rows.length,
				0
			);
		}
		if (!summary.embeddingDim) {
			summary.embeddingDim = searchUnits[0]?.embedding.length || 0;
		}

		const searchUnitsByNewest = [...searchUnits].sort(
			(a, b) => compareIsoDateDesc(a.createdAt, b.createdAt) || a.uri.localeCompare(b.uri)
		);

		const threads = threadRows.map((threadRow) => {
			const rows = [...(threadPostRows.get(threadRow.rootUri) ?? [])].sort(
				(a, b) =>
					a.postIndex - b.postIndex ||
					compareIsoDateDesc(b.createdAt, a.createdAt) ||
					a.uri.localeCompare(b.uri)
			);

			if (rows.length === 0) {
				const rootPost = makeThreadPost(summary, {
					uri: threadRow.rootUri,
					createdAt: threadRow.firstCreatedAt || threadRow.lastCreatedAt,
					text: threadRow.text || threadRow.preview || threadRow.title || 'Untitled thread'
				});
				rootUriByPostUri.set(rootPost.uri, threadRow.rootUri);
				return {
					rootPost,
					depth: threadRow.depth,
					rootUri: threadRow.rootUri
				};
			}

			const nodesByUri = new Map<string, ThreadPost>();
			const childUris = new Set<string>();
			for (const row of rows) {
				nodesByUri.set(
					row.uri,
					makeThreadPost(summary, {
						uri: row.uri,
						createdAt: row.createdAt,
						text: row.text,
						parentUri: row.parentUri
					})
				);
			}

			if (hasParentUri && rows.some((row) => row.parentUri)) {
				for (let index = 0; index < rows.length; index++) {
					const row = rows[index];
					const node = nodesByUri.get(row.uri);
					const explicitParent = row.parentUri ? nodesByUri.get(row.parentUri) : null;
					const fallbackParent =
						index > 0 ? nodesByUri.get(rows[index - 1].uri) ?? null : null;
					const parent = explicitParent ?? fallbackParent;
					if (!node || !parent || parent.uri === node.uri) continue;
					parent.children.push(node);
					node.parentUri = parent.uri;
					childUris.add(node.uri);
				}
			} else {
				for (let index = 1; index < rows.length; index++) {
					const parent = nodesByUri.get(rows[index - 1].uri);
					const child = nodesByUri.get(rows[index].uri);
					if (!parent || !child) continue;
					parent.children.push(child);
					child.parentUri = parent.uri;
					childUris.add(child.uri);
				}
			}

			const rootPost =
				nodesByUri.get(threadRow.rootUri) ??
				rows
					.map((row) => nodesByUri.get(row.uri))
					.find((node): node is ThreadPost => Boolean(node && !childUris.has(node.uri))) ??
				nodesByUri.get(rows[0]?.uri) ??
				makeThreadPost(summary, {
					uri: threadRow.rootUri,
					createdAt: threadRow.firstCreatedAt || threadRow.lastCreatedAt,
					text: threadRow.text || threadRow.preview || threadRow.title || 'Untitled thread'
				});

			return {
				rootPost,
				depth: threadRow.depth,
				rootUri: threadRow.rootUri
			};
		});

		return {
			kind: 'bsky-thread-embedding-db',
			secondaryResultLabel: 'segments',
			sourceLabel,
			sourceUrl,
			sourceKey,
			summary,
			searchUnits,
			searchUnitsByNewest,
			threads,
			rootUriByPostUri
		};
	}

	function extractDb(
		db: any,
		sourceLabel: string,
		sourceUrl: string | null,
		sourceKey: string | null
	): LoadedSemanticDb {
		const meta = new Map<string, string>();
		const metaStmt = db.prepare('SELECT key, value FROM meta');
		try {
			while (metaStmt.step()) {
				const [key, value] = metaStmt.get() as [unknown, unknown];
				meta.set(String(key || ''), String(value || ''));
			}
		} finally {
			metaStmt.free();
		}

		const kind = detectDbKind(meta, db);
		if (kind === 'bsky-thread-embedding-db') {
			return extractThreadDb(db, meta, sourceLabel, sourceUrl, sourceKey);
		}
		if (kind === 'bsky-window-embedding-db') {
			return extractWindowDb(db, meta, sourceLabel, sourceUrl, sourceKey);
		}
		return extractPostDb(db, meta, sourceLabel, sourceUrl, sourceKey);
	}

	async function openDbBuffer(
		buffer: ArrayBuffer,
		sourceLabel: string,
		sourceUrl: string | null,
		sourceKey: string | null
	): Promise<void> {
		const SQL = await getSqlModule();
		const db = new SQL.Database(new Uint8Array(buffer));

		try {
			const nextDb = extractDb(db, sourceLabel, sourceUrl, sourceKey);
			loadedDb = nextDb;
			selectedFileKey = sourceKey ?? '';
			rankedPosts = [];
			visibleCount = 200;
			collapsedByRootUri = {};
			pendingScrollToRootUri = null;
			resetExpandedState();
			searchError = null;
			dbError = null;
			updateUrl();

			if (queryText.trim()) {
				await runSemanticSearch(queryText, nextDb);
			}
		} finally {
			db.close();
		}
	}

	async function loadBucketFile(entry: SemanticBucketFile): Promise<void> {
		dbLoading = true;
		dbError = null;
		selectedFileKey = entry.key;
		updateUrl();

		try {
			const response = await fetch(entry.downloadPath);
			if (!response.ok) {
				throw new Error(`Failed to download SQLite DB: ${response.status}`);
			}

			await openDbBuffer(await response.arrayBuffer(), entry.filename, entry.downloadPath, entry.key);
		} catch (error: any) {
			dbError = error?.message || 'Failed to download the semantic SQLite DB in the browser.';
			loadedDb = null;
			rankedPosts = [];
			resetExpandedState();
		} finally {
			dbLoading = false;
		}
	}

	async function handleDbFileChange(event: Event) {
		const input = event.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) return;

		dbLoading = true;
		dbError = null;
		selectedFileKey = '';
		updateUrl();

		try {
			await openDbBuffer(await file.arrayBuffer(), file.name, null, null);
		} catch (error: any) {
			dbError = error?.message || 'Failed to load the local semantic SQLite DB.';
			loadedDb = null;
			rankedPosts = [];
			resetExpandedState();
		} finally {
			dbLoading = false;
		}
	}

	async function loadAvailableFiles(requestedKey = '') {
		filesLoading = true;
		filesError = null;
		try {
			const response = await fetch('/api/semantic');
			const payload = (await response.json().catch(() => null)) as
				| { files?: SemanticBucketFile[]; message?: string }
				| null;

			if (!response.ok) {
				throw new Error(payload?.message || `Semantic file list failed: ${response.status}`);
			}

			availableFiles = Array.isArray(payload?.files) ? payload.files : [];

			if (requestedKey) {
				const requested = availableFiles.find((entry) => entry.key === requestedKey);
				if (requested) {
					await loadBucketFile(requested);
				} else {
					filesError = `Could not find ${requestedKey} in the semantic DB bucket.`;
				}
			}
		} catch (error: any) {
			filesError = error?.message || 'Failed to load semantic DB files from R2.';
		} finally {
			filesLoading = false;
		}
	}

	function handleQueryInput(event: Event) {
		queryText = (event.currentTarget as HTMLInputElement).value;
		if (!queryText.trim() && activeQuery) {
			activeQuery = '';
			rankedPosts = [];
			searchError = null;
			visibleCount = 200;
			pendingScrollToRootUri = null;
			updateUrl();
		}
	}

	async function runSemanticSearch(query = queryText, db = loadedDb) {
		const requestId = ++searchRequestId;
		const cleanedQuery = query.trim();
		resetExpandedState();

		if (!db) {
			searchError = 'Download a semantic DB in the browser first.';
			activeQuery = '';
			rankedPosts = [];
			pendingScrollToRootUri = null;
			updateUrl();
			return;
		}

		if (!cleanedQuery) {
			searchError = 'Enter a semantic search query.';
			activeQuery = '';
			rankedPosts = [];
			pendingScrollToRootUri = null;
			updateUrl();
			return;
		}

		searchLoading = true;
		searchError = null;
		try {
			const response = await fetch('/api/semantic/query', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json'
				},
				body: JSON.stringify({
					query: cleanedQuery
				})
			});
			const payload = (await response.json().catch(() => null)) as QueryVectorPayload | null;

			if (!response.ok) {
				throw new Error(payload?.message || `Semantic search failed: ${response.status}`);
			}

			if (requestId !== searchRequestId) return;

			const vectorValues = Array.isArray(payload?.vector) ? payload.vector : [];
			if (vectorValues.length === 0) {
				throw new Error('The query embedding response was empty.');
			}

			const queryVector = Float32Array.from(vectorValues);
			embeddingModelLabel =
				payload?.model && payload?.pooling
					? `${payload.model} (${payload.pooling})`
					: payload?.model || embeddingModelLabel;

			activeQuery = typeof payload?.query === 'string' ? payload.query : cleanedQuery;
			queryText = activeQuery;
			const nextRankedPosts = db.searchUnits
				.map((post) => ({
					uri: post.uri,
					sourcePostUri: post.sourcePostUri,
					rootUri: post.rootUri,
					createdAt: post.createdAt,
					parentUri: post.parentUri,
					isReply: post.isReply,
					text: post.text,
					charLength: post.charLength,
					tokenEstimate: post.tokenEstimate,
					unitKind: post.unitKind,
					score: dotProduct(queryVector, post.embedding),
					rank: 0
				}))
				.sort(
					(a, b) =>
						b.score - a.score ||
						new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime() ||
						a.uri.localeCompare(b.uri)
				)
				.map((post, index) => ({
					...post,
					rank: index + 1
				}));
			rankedPosts = nextRankedPosts;
			pendingScrollToRootUri = nextRankedPosts[0]?.rootUri ?? null;
			visibleCount = Math.min(200, nextRankedPosts.length);
			updateUrl();
		} catch (error: any) {
			if (requestId !== searchRequestId) return;
			searchError = error?.message || 'Failed to run semantic search.';
			activeQuery = '';
			rankedPosts = [];
			pendingScrollToRootUri = null;
			updateUrl();
		} finally {
			if (requestId === searchRequestId) {
				searchLoading = false;
			}
		}
	}

	function handleQuerySubmit(event: SubmitEvent) {
		event.preventDefault();
		void runSemanticSearch(queryText, loadedDb);
	}

	function showMore() {
		visibleCount = Math.min(displayPosts.length, visibleCount + 200);
	}

	onMount(() => {
		try {
			const saved = localStorage.getItem('preferred-font');
			if (saved && saved in fontFamilies) {
				fontKey = saved;
			}
		} catch {}

		const params = new URLSearchParams(window.location.search);
		const requestedKey = params.get('key')?.trim() || '';
		const requestedQuery = params.get('q')?.trim() || '';
		const requestedMode = params.get('mode')?.trim() || '';
		queryText = requestedQuery;
		resultMode = requestedMode === 'threads' ? 'threads' : 'posts';

		void loadAvailableFiles(requestedKey);
	});
</script>

<main style="font-family: {fontFamily}">
	<RouteNav current="semantic" handle={loadedSummary?.handle ?? null} />

	<header class="semantic-header">
		<div>
			<p class="page-kicker">Semantic Search + Thread Viewer</p>
			<h1>Download In Browser, Then Search And Browse</h1>
			<p class="page-subtitle">
				Choose one SQLite DB from your R2 semantic folders on the left. The page downloads it
				in the browser, opens it with SQLite WASM, and then semantic search adapts to the DB
				shape automatically: post DBs rerank posts, window DBs rerank contextual windows, and
				thread DBs rerank analyzer-style segments while still browsing full self-reply threads
				for that one account.
			</p>
		</div>
		<FontPicker value={fontKey} onchange={handleFontChange} />
	</header>

	{#if dbError}
		<ErrorBanner message={dbError} />
	{/if}
	{#if filesError}
		<ErrorBanner message={filesError} />
	{/if}

	<div class="semantic-layout">
		<aside class="semantic-sidebar">
			<section class="sidebar-card wobbly-border-light">
				<h2>Available Files</h2>
				<p class="sidebar-copy">
					Download in browser, then semantic search and thread browsing happen locally.
				</p>

				{#if filesLoading}
					<p class="control-meta">Loading R2 files...</p>
				{:else if availableFiles.length === 0}
					<p class="control-meta">
						No semantic SQLite files were found under `output/embedding-dbs`,
						`output/window-embedding-dbs`, or `output/thread-embedding-dbs`.
					</p>
				{:else}
					<div class="file-list">
						{#each availableFiles as entry}
							<button
								class="file-row wobbly-border-light"
								class:selected={loadedDb?.sourceKey === entry.key}
								class:loading={dbLoading && selectedFileKey === entry.key}
								onclick={() => loadBucketFile(entry)}
							>
								<div class="file-row-top">
									<strong>{entry.filename}</strong>
									<span>{formatBytes(entry.size)}</span>
								</div>
								<div class="file-row-meta">
									<span>{formatCompactDate(entry.uploadedAt)}</span>
									<span>{entry.prefix.replace(/\/$/, '')}</span>
								</div>
								<div class="file-row-cta">
									{#if dbLoading && selectedFileKey === entry.key}
										Loading in browser...
									{:else}
										Download in browser
									{/if}
								</div>
							</button>
						{/each}
					</div>
				{/if}
			</section>

			<section class="sidebar-card wobbly-border-light">
				<h2>Local Fallback</h2>
				<label for="semantic-db-file">Open a local SQLite file</label>
				<input
					id="semantic-db-file"
					type="file"
					accept=".sqlite,.db,application/vnd.sqlite3,application/octet-stream"
					onchange={handleDbFileChange}
				/>
				<p class="control-meta">Useful if the DB has not been uploaded to R2 yet.</p>
			</section>
		</aside>

		<section class="semantic-main">
			<div class="control-card search-card wobbly-border-light">
				{#if loadedSummary}
					<div class="loaded-summary">
						<h2>{loadedSummary.displayName || loadedSummary.handle}</h2>
						<p>{summaryStats(loadedSummary, loadedDb?.threads.length ?? 0)}</p>
					</div>
				{:else}
					<div class="loaded-summary">
						<h2>No DB Loaded Yet</h2>
						<p>Pick a file on the left to download it in the browser.</p>
					</div>
				{/if}

				<form onsubmit={handleQuerySubmit}>
					<label for="semantic-query">Semantic query</label>
					<div class="search-row">
						<input
							id="semantic-query"
							type="text"
							placeholder="Search for a theme, idea, or kind of post..."
							value={queryText}
							oninput={handleQueryInput}
						/>
						<button
							type="submit"
							class="search-btn wobbly-border"
							disabled={dbLoading || searchLoading || !loadedDb || !queryText.trim()}
						>
							Search
						</button>
					</div>
				</form>

				<div class="result-mode-row">
					<span class="result-mode-label">Show</span>
					<div class="result-mode-toggle">
						<button
							type="button"
							class="mode-btn wobbly-border-light"
							class:active={resultMode === 'posts'}
							onclick={() => handleResultModeChange('posts')}
						>
							{secondaryResultLabel === 'segments'
								? 'Segments'
								: secondaryResultLabel === 'windows'
									? 'Windows'
									: 'Posts'}
						</button>
						<button
							type="button"
							class="mode-btn wobbly-border-light"
							class:active={resultMode === 'threads'}
							onclick={() => handleResultModeChange('threads')}
						>
							Threads
						</button>
					</div>
				</div>

				{#if dbLoading}
					<p class="control-meta">Downloading the selected SQLite DB in the browser...</p>
				{:else if searchLoading}
					<p class="control-meta">
						Embedding query and reranking {resultMode === 'threads' ? 'threads' : secondaryResultLabel} locally...
					</p>
				{:else if searchError}
					<p class="control-meta error-text">{searchError}</p>
				{:else if activeQuery && loadedSummary}
					<p class="control-meta">
						{#if loadedDb?.kind === 'bsky-thread-embedding-db'}
							Showing semantically ranked {resultMode === 'threads' ? 'threads' : 'segments'} for
							"{activeQuery}" across {loadedSummary.embeddedThreads.toLocaleString()} threads and
							{loadedSummary.embeddedSegments.toLocaleString()} segments{embeddingModelLabel
								? ` with ${embeddingModelLabel}`
								: ''}. Threads are ranked by their strongest matching segment.
						{:else if loadedDb?.kind === 'bsky-window-embedding-db'}
							Showing semantically ranked {resultMode === 'threads' ? 'threads' : 'windows'} for
							"{activeQuery}" across {loadedSummary.embeddedPosts.toLocaleString()} posts and
							{loadedSummary.embeddedWindows.toLocaleString()} contextual windows{embeddingModelLabel
								? ` with ${embeddingModelLabel}`
								: ''}. Threads are ranked by their strongest matching window.
						{:else}
							Showing semantically ranked {resultMode} for "{activeQuery}" across
							{loadedSummary.embeddedPosts.toLocaleString()} posts{embeddingModelLabel
								? ` with ${embeddingModelLabel}`
								: ''}. Threads are ranked by their strongest matching post.
						{/if}
					</p>
				{:else if loadedSummary}
					<p class="control-meta">
						{#if loadedDb?.kind === 'bsky-thread-embedding-db'}
							Browsing everything in this one-user thread embedding DB. Switch between thread-viewer
							mode and raw segment mode above.
						{:else if loadedDb?.kind === 'bsky-window-embedding-db'}
							Browsing everything in this one-user window embedding DB. Switch between thread-viewer
							mode and raw contextual window mode above.
						{:else}
							Browsing everything in this one-user embedding DB. Switch between thread-viewer mode
							and raw post mode above.
						{/if}
					</p>
				{:else}
					<p class="control-meta">
						Download a file on the left, then you can semantic search and browse everything in
						that DB.
					</p>
				{/if}
			</div>

			{#if dbLoading}
				<LoadingSpinner progress={{ phase: 'Loading semantic SQLite DB in the browser...', current: 0, total: 0 }} />
			{:else if searchLoading}
				<LoadingSpinner
					progress={{
						phase: `Ranking all ${resultMode === 'threads' ? 'threads' : loadedDb ? rawResultLabel(loadedDb.kind) : 'results'} by semantic similarity...`,
						current: 0,
						total: 0
					}}
				/>
			{:else if showExpanded}
				<div class="panel-detail">
					{#if expandedLoading}
						<LoadingSpinner progress={{ phase: 'Loading full thread...', current: 0, total: 0 }} />
					{:else if expandedThread}
						<div class="expanded-actions">
							<button class="back-btn wobbly-border" onclick={handleExpandedBack}>
								&#8592; Back to results
							</button>
							<button class="copy-link-btn wobbly-border" onclick={copyExpandedThreadLink}>
								Copy Bluesky link
							</button>
							<button
								class="copy-link-btn wobbly-border"
								onclick={() => handleOpenOnBluesky(expandedThread?.rootUri ?? '')}
							>
								Open on Bluesky
							</button>
							<div class="view-toggle">
								<button
									class="view-toggle-btn wobbly-border"
									class:active={expandedViewMode === 'chat'}
									onclick={() => (expandedViewMode = 'chat')}
								>
									Chat
								</button>
								<button
									class="view-toggle-btn wobbly-border"
									class:active={expandedViewMode === 'board'}
									onclick={() => (expandedViewMode = 'board')}
								>
									Board
								</button>
								<button
									class="view-toggle-btn wobbly-border"
									class:active={expandedViewMode === 'parallel'}
									onclick={() => (expandedViewMode = 'parallel')}
								>
									Parallel
								</button>
							</div>
						</div>
						{#if expandedThread.isTruncated}
							<p class="truncation-warning">Some replies may be missing</p>
						{/if}
						<div
							class="expanded-thread"
							class:expanded-thread--wide={expandedViewMode === 'board' || expandedViewMode === 'parallel'}
						>
							{#if expandedViewMode === 'chat'}
								<GroupChat thread={expandedThread} />
							{:else if expandedViewMode === 'board'}
								<BoardView thread={expandedThread} />
							{:else}
								<ParallelBoardView thread={expandedThread} />
							{/if}
						</div>
					{:else if expandedError}
						<section class="empty-state wobbly-border-light">
							<p>{expandedError}</p>
							<button class="back-btn wobbly-border" onclick={handleExpandedBack}>
								Back to results
							</button>
						</section>
					{/if}
				</div>
			{:else if !loadedDb}
				<section class="empty-state wobbly-border-light">
					<p>No semantic DB is loaded yet.</p>
					<p class="empty-hint">
						Choose a file in the left sidebar. The page will download it in the browser and then
						you can run semantic search or browse the reconstructed thread list.
					</p>
				</section>
			{:else if resultMode === 'threads' && displayThreads.length > 0}
				<section class="ranked-section">
					<div class="ranked-header">
						<div>
							<h2>{activeQuery ? 'Ranked Threads' : 'All Threads'}</h2>
							<p>
								{#if activeQuery}
									Showing {displayThreads.length.toLocaleString()} self-reply threads ranked by the
									best matching {bestMatchLabel(loadedDb.kind)}
									for "{activeQuery}".
								{:else}
									Showing {displayThreads.length.toLocaleString()} reconstructed self-reply threads
									from this embedding DB.
								{/if}
							</p>
						</div>
					</div>

					<VirtualThreadList
						threads={displayThreads}
						{renderMode}
						{highlightedPostByRootUri}
						{collapsedByRootUri}
						oncollapsedchange={setThreadCollapsed}
						onexpand={handleExpandThread}
						onopenbluesky={handleOpenOnBluesky}
						scrollToRootUri={pendingScrollToRootUri}
						onscrolltorooturicomplete={handleScrollToRootUriComplete}
					/>
				</section>
			{:else if resultMode === 'posts' && displayPosts.length > 0}
				<section class="ranked-section">
					<div class="ranked-header">
						<div>
							<h2>{rawResultHeading(loadedDb.kind, Boolean(activeQuery))}</h2>
							<p>
								{#if activeQuery}
									Showing {visiblePosts.length.toLocaleString()} of
									{displayPosts.length.toLocaleString()}
									{rawResultLabel(loadedDb.kind)} for
									"{activeQuery}".
								{:else}
									Showing {visiblePosts.length.toLocaleString()} of
									{displayPosts.length.toLocaleString()}
									{rawResultLabel(loadedDb.kind)} from this
									embedding DB.
								{/if}
							</p>
						</div>
						{#if visiblePosts.length < displayPosts.length}
							<button class="show-more-btn wobbly-border" onclick={showMore}>
								Show 200 More
							</button>
						{/if}
					</div>

					<div class="ranked-list">
						{#each visiblePosts as post}
							<article class="ranked-card wobbly-border-light">
								<div class="ranked-card-top">
									<span class="rank-pill">#{post.rank}</span>
									{#if post.score !== null}
										<span class="score-pill">{formatScore(post.score)}</span>
									{/if}
									<span>{formatDate(post.createdAt)}</span>
									<span>
										{post.unitKind === 'segment'
											? 'Segment'
											: post.unitKind === 'window'
												? 'Window'
											: post.isReply
												? 'Reply'
												: 'Root'}
									</span>
								</div>
								<p>{post.text}</p>
								<div class="ranked-card-links">
									{#if threadViewerUrl(post.sourcePostUri)}
										<a href={threadViewerUrl(post.sourcePostUri) ?? '#'}>Thread Viewer</a>
									{/if}
									{#if buildBskyPostUrl(post.sourcePostUri, loadedSummary?.handle)}
										<a
											href={buildBskyPostUrl(post.sourcePostUri, loadedSummary?.handle)}
											target="_blank"
											rel="noreferrer"
										>
											Open on Bluesky
										</a>
									{/if}
								</div>
							</article>
						{/each}
					</div>
				</section>
			{:else if activeQuery}
				<section class="empty-state wobbly-border-light">
					<p>
						No ranked {resultMode === 'threads' ? 'threads' : secondaryResultLabel} were returned
						for "{activeQuery}".
					</p>
				</section>
			{:else}
				<section class="empty-state wobbly-border-light">
					<p>
						No {resultMode === 'threads' ? 'threads' : secondaryResultLabel} could be reconstructed
						from this embedding DB.
					</p>
				</section>
			{/if}
		</section>
	</div>
</main>

<style>
	main {
		max-width: 1320px;
		margin: 0 auto;
		padding: 20px 18px 80px;
	}

	.semantic-header {
		display: flex;
		justify-content: space-between;
		align-items: flex-start;
		gap: 18px;
		margin-bottom: 18px;
	}

	.page-kicker {
		margin: 0 0 6px;
		font-size: 0.82rem;
		font-weight: 700;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: color-mix(in srgb, var(--accent) 70%, #5c6677 30%);
	}

	h1 {
		margin: 0;
		font-size: clamp(2rem, 5vw, 3rem);
	}

	.page-subtitle {
		max-width: 780px;
		margin: 10px 0 0;
		color: #516173;
		line-height: 1.55;
	}

	.semantic-layout {
		display: grid;
		grid-template-columns: 310px minmax(0, 1fr);
		gap: 18px;
		align-items: start;
	}

	.semantic-sidebar {
		display: grid;
		gap: 14px;
		position: sticky;
		top: 16px;
	}

	.semantic-main {
		display: grid;
		gap: 18px;
	}

	.sidebar-card,
	.control-card,
	.empty-state {
		padding: 16px;
		background: rgba(255, 252, 245, 0.88);
	}

	.sidebar-card h2,
	.loaded-summary h2,
	.ranked-header h2 {
		margin: 0 0 6px;
	}

	.sidebar-copy,
	.loaded-summary p,
	.ranked-header p {
		margin: 0;
		color: #556475;
		line-height: 1.5;
	}

	label {
		display: block;
		font-size: 0.86rem;
		font-weight: 700;
		margin-bottom: 8px;
	}

	input {
		width: 100%;
		padding: 10px 12px;
		border-radius: 12px;
		border: 1px solid rgba(61, 64, 91, 0.18);
		background: rgba(255, 255, 255, 0.96);
		font: inherit;
	}

	.file-list {
		display: grid;
		gap: 10px;
		margin-top: 12px;
		max-height: 68vh;
		overflow: auto;
		padding-right: 4px;
	}

	.file-row {
		padding: 12px;
		text-align: left;
		background: rgba(255, 252, 245, 0.88);
		cursor: pointer;
	}

	.file-row.selected {
		background: color-mix(in srgb, var(--accent) 16%, white);
		border-color: rgba(224, 122, 95, 0.36);
	}

	.file-row.loading {
		opacity: 0.82;
	}

	.file-row-top,
	.file-row-meta {
		display: flex;
		justify-content: space-between;
		gap: 8px;
		align-items: center;
	}

	.file-row-top {
		margin-bottom: 6px;
		font-size: 0.92rem;
	}

	.file-row-meta {
		font-size: 0.78rem;
		color: #6a7482;
	}

	.file-row-cta {
		margin-top: 10px;
		font-size: 0.84rem;
		font-weight: 700;
		color: color-mix(in srgb, var(--accent) 70%, #253040 30%);
	}

	.search-card {
		display: grid;
		gap: 14px;
	}

	.search-row {
		display: flex;
		gap: 10px;
		align-items: center;
	}

	.result-mode-row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 10px;
	}

	.result-mode-label {
		font-size: 0.82rem;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: #5b6778;
	}

	.result-mode-toggle {
		display: inline-flex;
		flex-wrap: wrap;
		gap: 8px;
	}

	.mode-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		padding: 8px 12px;
		background: rgba(255, 255, 255, 0.92);
		font: inherit;
		color: var(--text-ink);
		text-decoration: none;
		cursor: pointer;
	}

	.mode-btn.active {
		background: color-mix(in srgb, var(--accent) 16%, white);
		border-color: rgba(224, 122, 95, 0.36);
		color: color-mix(in srgb, var(--accent) 74%, #253040 26%);
	}

	.search-btn,
	.show-more-btn {
		flex: 0 0 auto;
		padding: 10px 16px;
		background: color-mix(in srgb, var(--accent) 14%, white);
		font: inherit;
		cursor: pointer;
	}

	.search-btn:disabled {
		cursor: not-allowed;
		opacity: 0.6;
	}

	.control-meta,
	.empty-hint {
		margin: 0;
		color: #5b6778;
		font-size: 0.9rem;
		line-height: 1.5;
	}

	.error-text {
		color: #9a3b2f;
	}

	.panel-detail {
		margin-top: 8px;
	}

	.panel-detail:has(.expanded-thread--wide) {
		width: 100vw;
		position: relative;
		left: 50%;
		transform: translateX(-50%);
		padding: 0 20px;
		box-sizing: border-box;
	}

	.expanded-actions {
		display: flex;
		gap: 8px;
		margin-bottom: 16px;
		flex-wrap: wrap;
		align-items: center;
	}

	.view-toggle {
		display: flex;
		gap: 4px;
		margin-left: auto;
		flex-wrap: wrap;
	}

	.view-toggle-btn {
		padding: 6px 14px;
		font-size: 0.9rem;
		background: var(--card-bg);
		color: var(--muted);
		border-color: var(--muted);
		cursor: pointer;
		transition: background 0.2s, color 0.2s;
	}

	.view-toggle-btn.active {
		background: var(--accent);
		color: white;
		border-color: var(--accent);
	}

	.view-toggle-btn:hover:not(.active) {
		opacity: 0.7;
	}

	.back-btn,
	.copy-link-btn {
		display: inline-block;
		padding: 6px 16px;
		font-size: 0.95rem;
		background: var(--card-bg);
		color: var(--text-ink);
		border-color: var(--muted);
		cursor: pointer;
		transition: opacity 0.2s;
	}

	.back-btn:hover,
	.copy-link-btn:hover {
		opacity: 0.7;
	}

	.truncation-warning {
		background: #fff3cd;
		color: #856404;
		border: 1px solid #ffc107;
		border-radius: 6px;
		padding: 6px 12px;
		font-size: 0.85rem;
		margin-bottom: 8px;
		text-align: center;
	}

	.expanded-thread {
		margin-top: 8px;
		max-width: 100vw;
	}

	.ranked-section {
		display: grid;
		gap: 12px;
	}

	.ranked-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 16px;
	}

	.ranked-list {
		display: grid;
		gap: 12px;
	}

	.ranked-card {
		padding: 16px;
		background: rgba(255, 252, 245, 0.84);
	}

	.ranked-card-top {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		align-items: center;
		margin-bottom: 10px;
		font-size: 0.88rem;
		color: #5b6778;
	}

	.rank-pill,
	.score-pill {
		display: inline-flex;
		align-items: center;
		padding: 4px 9px;
		border-radius: 999px;
		background: rgba(255, 255, 255, 0.9);
		border: 1px solid rgba(61, 64, 91, 0.14);
		color: #253040;
		font-weight: 700;
	}

	.score-pill {
		color: color-mix(in srgb, var(--accent) 70%, #253040 30%);
	}

	.ranked-card p {
		margin: 0;
		white-space: pre-wrap;
		line-height: 1.6;
	}

	.ranked-card-links {
		margin-top: 12px;
		display: flex;
		flex-wrap: wrap;
		gap: 10px;
	}

	.ranked-card a {
		color: var(--accent);
		text-decoration: none;
	}

	.ranked-card a:hover {
		text-decoration: underline;
	}

	@media (max-width: 980px) {
		.semantic-layout {
			grid-template-columns: 1fr;
		}

		.semantic-sidebar {
			position: static;
		}

		.file-list {
			max-height: none;
		}
	}

	@media (max-width: 780px) {
		.semantic-header,
		.ranked-header {
			flex-direction: column;
			align-items: stretch;
		}

		.view-toggle {
			margin-left: 0;
		}
	}

	@media (max-width: 640px) {
		main {
			padding-inline: 14px;
		}

		.search-row,
		.result-mode-row,
		.file-row-top,
		.file-row-meta {
			flex-direction: column;
			align-items: stretch;
		}

		.search-btn,
		.show-more-btn,
		.mode-btn {
			width: 100%;
		}

		.back-btn,
		.copy-link-btn,
		.view-toggle-btn {
			width: 100%;
		}
	}
</style>
