export interface SemanticDbSummary {
	filename: string;
	handle: string;
	did: string;
	displayName: string | null;
	avatar: string | null;
	embeddedPosts: number;
	embeddingDim: number;
	generatedAt: string | null;
}

export interface SemanticPostPreview {
	uri: string;
	createdAt: string;
	parentUri: string | null;
	threadRootUri: string;
	isReply: boolean;
	text: string;
	charLength: number;
	tokenEstimate: number;
}

export interface SemanticRankedPost extends SemanticPostPreview {
	score: number;
	rank: number;
}

type SemanticEmbeddedRow = Record<string, unknown> & {
	embedding_f32?: Uint8Array;
};

type DatabaseHandle = {
	close: () => void;
	prepare: (sql: string) => {
		get: (...params: any[]) => any;
		all: (...params: any[]) => any[];
	};
};

const SQLITE_EXTENSION = '.sqlite';

async function getNodeModules() {
	const fsSpecifier = 'node:fs/promises';
	const pathSpecifier = 'node:path';
	const sqliteSpecifier = 'node:sqlite';

	try {
		const [{ readdir }, pathModule, { DatabaseSync }] = await Promise.all([
			import(fsSpecifier),
			import(pathSpecifier),
			import(sqliteSpecifier)
		]);

		return {
			readdir,
			path: pathModule.default ?? pathModule,
			DatabaseSync
		};
	} catch (error: any) {
		throw new Error(
			error?.message ||
				'Semantic DB APIs are only available in local Node environments with filesystem and sqlite access.'
		);
	}
}

async function resolveDbDirectory(): Promise<string> {
	const { path } = await getNodeModules();
	return process.env.SEMANTIC_DB_DIR?.trim()
		? path.resolve(process.cwd(), process.env.SEMANTIC_DB_DIR.trim())
		: path.resolve(process.cwd(), 'output', 'embedding-dbs');
}

function readMetaValue(db: DatabaseHandle, key: string): string | null {
	const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as
		| { value?: string }
		| undefined;
	return typeof row?.value === 'string' ? row.value : null;
}

function normalizeSummary(filename: string, db: DatabaseHandle): SemanticDbSummary {
	const embeddedPosts = Number.parseInt(readMetaValue(db, 'embedded_posts') || '0', 10) || 0;
	const embeddingDim = Number.parseInt(readMetaValue(db, 'embedding_dim') || '0', 10) || 0;
	return {
		filename,
		handle: readMetaValue(db, 'handle') || filename.replace(/\.sqlite$/i, ''),
		did: readMetaValue(db, 'did') || '',
		displayName: readMetaValue(db, 'display_name'),
		avatar: readMetaValue(db, 'avatar'),
		embeddedPosts,
		embeddingDim,
		generatedAt: readMetaValue(db, 'generated_at')
	};
}

function normalizePreviewRow(row: any): SemanticPostPreview {
	return {
		uri: String(row.uri || ''),
		createdAt: String(row.created_at || ''),
		parentUri: typeof row.parent_uri === 'string' && row.parent_uri ? row.parent_uri : null,
		threadRootUri: String(row.thread_root_uri || row.uri || ''),
		isReply: Boolean(row.is_reply),
		text: String(row.text || ''),
		charLength: Number(row.char_length) || 0,
		tokenEstimate: Number(row.token_estimate) || 0
	};
}

function normalizeDbFilename(filename: string): string {
	const trimmed = filename.trim();
	if (!trimmed || trimmed.includes('/') || trimmed.includes('\\')) {
		throw new Error('Invalid semantic DB filename.');
	}
	if (!trimmed.endsWith(SQLITE_EXTENSION)) {
		throw new Error('Semantic DB filename must end with .sqlite.');
	}
	return trimmed;
}

async function withDatabase<T>(
	filename: string,
	run: (db: DatabaseHandle, summary: SemanticDbSummary) => Promise<T> | T
): Promise<T> {
	const { path, DatabaseSync } = await getNodeModules();
	const dbDir = await resolveDbDirectory();
	const normalizedFilename = normalizeDbFilename(filename);
	const dbPath = path.join(dbDir, normalizedFilename);
	const db = new DatabaseSync(dbPath) as DatabaseHandle;

	try {
		const summary = normalizeSummary(normalizedFilename, db);
		return await run(db, summary);
	} finally {
		db.close();
	}
}

function blobToVector(blob: Uint8Array): Float32Array {
	return new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4);
}

function normalizeNumericVector(values: ArrayLike<number>): Float32Array {
	const normalized = new Float32Array(values.length);
	let magnitudeSquared = 0;

	for (let index = 0; index < values.length; index++) {
		const value = Number(values[index]) || 0;
		normalized[index] = value;
		magnitudeSquared += value * value;
	}

	const magnitude = Math.sqrt(magnitudeSquared);
	if (!Number.isFinite(magnitude) || magnitude === 0) {
		return normalized;
	}

	for (let index = 0; index < normalized.length; index++) {
		normalized[index] /= magnitude;
	}

	return normalized;
}

function dotProduct(a: ArrayLike<number>, b: ArrayLike<number>): number {
	const length = Math.min(a.length, b.length);
	let total = 0;
	for (let index = 0; index < length; index++) {
		total += a[index] * b[index];
	}
	return total;
}

function readEmbeddedRows(db: DatabaseHandle): SemanticEmbeddedRow[] {
	return db.prepare(
		`
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
		`
	).all() as SemanticEmbeddedRow[];
}

function rankRows(
	rows: SemanticEmbeddedRow[],
	queryVector: ArrayLike<number>
): SemanticRankedPost[] {
	return rows
		.filter((row) => row.embedding_f32 instanceof Uint8Array)
		.map((row) => {
			const preview = normalizePreviewRow(row);
			const score = dotProduct(queryVector, blobToVector(row.embedding_f32!));
			return {
				...preview,
				score
			};
		})
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
}

export async function listSemanticDbs(): Promise<SemanticDbSummary[]> {
	const { readdir } = await getNodeModules();
	const dbDir = await resolveDbDirectory();

	let entries: string[] = [];
	try {
		entries = await readdir(dbDir);
	} catch (error: any) {
		if (error?.code === 'ENOENT') {
			return [];
		}
		throw error;
	}

	const summaries = await Promise.all(
		entries
			.filter((entry) => entry.endsWith(SQLITE_EXTENSION))
			.sort((a, b) => a.localeCompare(b))
			.map(async (filename) => {
				try {
					return await withDatabase(filename, (_db, summary) => summary);
				} catch {
					return null;
				}
			})
	);

	return summaries
		.filter((summary): summary is SemanticDbSummary => summary !== null)
		.sort(
			(a, b) =>
				b.embeddedPosts - a.embeddedPosts ||
				a.handle.localeCompare(b.handle) ||
				a.filename.localeCompare(b.filename)
		);
}

export async function searchSemanticPosts(
	filename: string,
	query: string,
	limit = 50
): Promise<{
		summary: SemanticDbSummary;
		posts: SemanticPostPreview[];
	}> {
	return withDatabase(filename, (db, summary) => {
		const normalizedLimit = Math.max(1, Math.min(limit, 200));
		const cleanedQuery = query.trim();
		const rows = cleanedQuery
			? db
					.prepare(
						`
							SELECT
								uri,
								created_at,
								parent_uri,
								thread_root_uri,
								is_reply,
								text,
								char_length,
								token_estimate
							FROM posts
							WHERE text LIKE ? COLLATE NOCASE
							ORDER BY created_at DESC, uri DESC
							LIMIT ?
						`
					)
					.all(`%${cleanedQuery}%`, normalizedLimit)
			: db
					.prepare(
						`
							SELECT
								uri,
								created_at,
								parent_uri,
								thread_root_uri,
								is_reply,
								text,
								char_length,
								token_estimate
							FROM posts
							ORDER BY created_at DESC, uri DESC
							LIMIT ?
						`
					)
					.all(normalizedLimit);

		return {
			summary,
			posts: rows.map(normalizePreviewRow)
		};
	});
}

export async function rankSemanticPosts(
	filename: string,
	sourceUri: string
): Promise<{
		summary: SemanticDbSummary;
		sourcePost: SemanticPostPreview;
		posts: SemanticRankedPost[];
	}> {
	return withDatabase(filename, (db, summary) => {
		const sourceRow = db
			.prepare(
				`
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
					WHERE uri = ?
				`
			)
			.get(sourceUri) as SemanticEmbeddedRow | undefined;

		if (!sourceRow?.embedding_f32) {
			throw new Error(`Source post not found in ${filename}.`);
		}

		const sourcePost = normalizePreviewRow(sourceRow);
		const sourceVector = blobToVector(sourceRow.embedding_f32);

		return {
			summary,
			sourcePost,
			posts: rankRows(readEmbeddedRows(db), sourceVector)
		};
	});
}

export async function rankSemanticPostsByVector(
	filename: string,
	queryVector: ArrayLike<number>
): Promise<{
		summary: SemanticDbSummary;
		posts: SemanticRankedPost[];
	}> {
	return withDatabase(filename, (db, summary) => ({
		summary,
		posts: rankRows(readEmbeddedRows(db), normalizeNumericVector(queryVector))
	}));
}
