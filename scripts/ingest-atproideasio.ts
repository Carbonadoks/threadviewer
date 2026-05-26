import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import {
	GetObjectCommand,
	PutObjectCommand,
	S3Client,
	type GetObjectCommandOutput
} from '@aws-sdk/client-s3';
import {
	ATPROIDEASIO_CACHE_KEY,
	ATPROIDEASIO_OPENROUTER_MODEL,
	ATPROIDEASIO_SAVED_STORIES_KEY
} from '../src/lib/constants/atproideasio';
import {
	ensureAtproideasioSavedStories,
	improveAtproideasioSnapshot,
	ingestAtproideasioIdeas,
	readAtproideasioSavedStories,
	retagAtproideasioSnapshot,
	type AtproideasioStorageBucket
} from '../src/lib/server/atproideasio';
import type { AtproideasioSavedStories, AtproideasioSnapshot } from '../src/lib/types/atproideasio';

const DEFAULT_BUCKET = 'thread-viewer-cache';
const DEFAULT_LOCAL_R2_DIR = 'output/local-r2';
const DEFAULT_OUTPUT_PATH = 'output/atproideasio/snapshot.json';
const DEFAULT_SAVED_STORIES_OUTPUT_PATH = 'output/atproideasio/saved-stories.json';
const ENV_FILES = ['.env', '.env.local', '.dev.vars', '.env.cluster.local'];

type EnvMap = Record<string, string>;
type StorageMode = 'local' | 'r2';

interface CliOptions {
	help: boolean;
	storage?: StorageMode;
	maxSearchPages?: number | null;
	maxThreadFetches?: number | null;
	improve?: boolean;
	forceImprove?: boolean;
	maxImprove?: number | null;
	outputPath?: string;
}

function parseEnvFile(text: string): EnvMap {
	const env: EnvMap = {};
	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith('#')) continue;
		const separatorIndex = line.indexOf('=');
		if (separatorIndex <= 0) continue;
		const key = line.slice(0, separatorIndex).trim();
		let value = line.slice(separatorIndex + 1).trim();
		if (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		) {
			value = value.slice(1, -1);
		}
		env[key] = value;
	}
	return env;
}

async function loadEnvFiles(): Promise<{ env: EnvMap; loaded: string[] }> {
	const env: EnvMap = {};
	const loaded: string[] = [];
	for (const file of ENV_FILES) {
		const fullPath = path.resolve(process.cwd(), file);
		try {
			Object.assign(env, parseEnvFile(await readFile(fullPath, 'utf8')));
			loaded.push(file);
		} catch (error: any) {
			if (error?.code !== 'ENOENT') throw error;
		}
	}
	return { env, loaded };
}

function readConfigValue(localEnv: EnvMap, keys: string | string[], fallback = ''): string {
	const keyList = Array.isArray(keys) ? keys : [keys];
	for (const key of keyList) {
		const processValue = process.env[key]?.trim();
		if (processValue) return processValue;
		const localValue = localEnv[key]?.trim();
		if (localValue) return localValue;
	}
	return fallback;
}

function parseLimit(raw: string | undefined): number | null | undefined {
	const clean = raw?.trim();
	if (!clean) return undefined;
	if (clean === 'all' || clean === 'none' || clean === '0') return null;
	const parsed = Number.parseInt(clean, 10);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		throw new Error(`Invalid positive integer limit: ${raw}`);
	}
	return parsed;
}

function parseArgs(argv: string[]): CliOptions {
	const options: CliOptions = { help: false };
	for (const arg of argv) {
		if (arg === '--help' || arg === '-h') {
			options.help = true;
		} else if (arg === '--all') {
			options.maxSearchPages = null;
			options.maxThreadFetches = null;
			options.maxImprove = null;
		} else if (arg === '--improve') {
			options.improve = true;
		} else if (arg === '--no-improve') {
			options.improve = false;
		} else if (arg === '--force-improve') {
			options.improve = true;
			options.forceImprove = true;
		} else if (arg === '--local') {
			options.storage = 'local';
		} else if (arg === '--r2') {
			options.storage = 'r2';
		} else if (arg.startsWith('--storage=')) {
			const value = arg.slice('--storage='.length);
			if (value !== 'local' && value !== 'r2') {
				throw new Error('--storage must be local or r2.');
			}
			options.storage = value;
		} else if (arg.startsWith('--max-search-pages=')) {
			options.maxSearchPages = parseLimit(arg.slice('--max-search-pages='.length));
		} else if (arg.startsWith('--max-thread-fetches=')) {
			options.maxThreadFetches = parseLimit(arg.slice('--max-thread-fetches='.length));
		} else if (arg.startsWith('--max-improve=')) {
			options.maxImprove = parseLimit(arg.slice('--max-improve='.length));
		} else if (arg.startsWith('--output=')) {
			options.outputPath = arg.slice('--output='.length).trim();
		} else {
			throw new Error(`Unknown argument: ${arg}`);
		}
	}
	return options;
}

function printHelp() {
	console.log(`Usage:
  npm run atproideasio:ingest -- --r2 --all
  npm run atproideasio:ingest -- --local --max-search-pages=1 --max-thread-fetches=5
  npm run atproideasio:ingest -- --r2 --all --force-improve

Env files loaded, in order:
  ${ENV_FILES.join(', ')}

Bluesky:
  ATPROIDEASIO_BSKY_HANDLE
  ATPROIDEASIO_BSKY_APP_PASSWORD

Optional limits:
  ATPROIDEASIO_MAX_SEARCH_PAGES
  ATPROIDEASIO_MAX_THREAD_FETCHES

OpenRouter enrichment:
  OPENROUTER_API_TOKEN
  OPENROUTER_MODEL defaults to ${ATPROIDEASIO_OPENROUTER_MODEL}
  --no-improve skips title/summary generation
  --force-improve regenerates every thread title/summary
  --max-improve=N limits DeepSeek calls for a test run

R2, for --r2 or ATPROIDEASIO_STORAGE=r2:
  CLOUDFLARE_ACCOUNT_ID or CLUSTER_R2_ACCOUNT_ID
  CLUSTER_R2_ACCESS_KEY_ID
  CLUSTER_R2_SECRET_ACCESS_KEY
  CLUSTER_R2_BUCKET defaults to ${DEFAULT_BUCKET}

Local output:
  ATPROIDEASIO_LOCAL_R2_DIR defaults to ${DEFAULT_LOCAL_R2_DIR}
  ATPROIDEASIO_OUTPUT_PATH defaults to ${DEFAULT_OUTPUT_PATH}
  ATPROIDEASIO_SAVED_STORIES_OUTPUT_PATH defaults to ${DEFAULT_SAVED_STORIES_OUTPUT_PATH}`);
}

async function bodyToString(body: GetObjectCommandOutput['Body']): Promise<string> {
	if (!body) return '';
	if (typeof (body as any).transformToString === 'function') {
		return (body as any).transformToString();
	}

	const chunks: Buffer[] = [];
	for await (const chunk of body as AsyncIterable<Uint8Array | string>) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	}
	return Buffer.concat(chunks).toString('utf8');
}

function isMissingError(error: unknown): boolean {
	return (
		(error as any)?.name === 'NoSuchKey' ||
		(error as any)?.$metadata?.httpStatusCode === 404 ||
		(error as any)?.Code === 'NoSuchKey'
	);
}

function createLocalBucket(rootDir: string): AtproideasioStorageBucket {
	function resolveKey(key: string): string {
		return path.resolve(process.cwd(), rootDir, key);
	}

	return {
		async get(key) {
			try {
				const text = await readFile(resolveKey(key), 'utf8');
				return {
					async json() {
						return JSON.parse(text);
					}
				};
			} catch (error: any) {
				if (error?.code === 'ENOENT') return null;
				throw error;
			}
		},
		async put(key, value) {
			const filePath = resolveKey(key);
			await mkdir(path.dirname(filePath), { recursive: true });
			await writeFile(filePath, value, 'utf8');
		}
	};
}

function createR2Bucket(client: S3Client, bucket: string): AtproideasioStorageBucket {
	return {
		async get(key) {
			try {
				const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
				const text = await bodyToString(response.Body);
				return {
					async json() {
						return JSON.parse(text);
					}
				};
			} catch (error) {
				if (isMissingError(error)) return null;
				throw error;
			}
		},
		async put(key, value, options = {}) {
			await client.send(
				new PutObjectCommand({
					Bucket: bucket,
					Key: key,
					Body: value,
					ContentType: options.httpMetadata?.contentType ?? 'application/json; charset=utf-8'
				})
			);
		}
	};
}

function hasR2Config(localEnv: EnvMap): boolean {
	return Boolean(
		readConfigValue(localEnv, ['CLOUDFLARE_ACCOUNT_ID', 'CLUSTER_R2_ACCOUNT_ID']) &&
			readConfigValue(localEnv, 'CLUSTER_R2_ACCESS_KEY_ID') &&
			readConfigValue(localEnv, 'CLUSTER_R2_SECRET_ACCESS_KEY')
	);
}

async function writeSnapshotCopy(snapshot: AtproideasioSnapshot, outputPath: string) {
	const fullPath = path.resolve(process.cwd(), outputPath);
	await mkdir(path.dirname(fullPath), { recursive: true });
	await writeFile(fullPath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
	console.log(`Wrote local snapshot copy: ${outputPath}`);
}

async function writeSavedStoriesCopy(stories: AtproideasioSavedStories, outputPath: string) {
	const fullPath = path.resolve(process.cwd(), outputPath);
	await mkdir(path.dirname(fullPath), { recursive: true });
	await writeFile(fullPath, `${JSON.stringify(stories, null, 2)}\n`, 'utf8');
	console.log(`Wrote local saved stories copy: ${outputPath}`);
}

async function main() {
	const cli = parseArgs(process.argv.slice(2));
	if (cli.help) {
		printHelp();
		return;
	}

	const { env: localEnv, loaded } = await loadEnvFiles();
	if (loaded.length > 0) {
		console.log(`Loaded env files: ${loaded.join(', ')}`);
	}

	const requestedStorage = readConfigValue(localEnv, 'ATPROIDEASIO_STORAGE') as StorageMode | '';
	const storageMode = cli.storage ?? (requestedStorage || (hasR2Config(localEnv) ? 'r2' : 'local'));
	if (storageMode !== 'local' && storageMode !== 'r2') {
		throw new Error('ATPROIDEASIO_STORAGE must be local or r2.');
	}

	const maxSearchPages =
		cli.maxSearchPages !== undefined
			? cli.maxSearchPages
			: parseLimit(readConfigValue(localEnv, 'ATPROIDEASIO_MAX_SEARCH_PAGES'));
	const maxThreadFetches =
		cli.maxThreadFetches !== undefined
			? cli.maxThreadFetches
			: parseLimit(readConfigValue(localEnv, 'ATPROIDEASIO_MAX_THREAD_FETCHES'));
	const maxImprove =
		cli.maxImprove !== undefined
			? cli.maxImprove
			: parseLimit(readConfigValue(localEnv, 'ATPROIDEASIO_MAX_IMPROVE'));
	const openRouterApiToken = readConfigValue(localEnv, ['OPENROUTER_API_TOKEN', 'OPENROUTER_API_KEY']);
	const improve = cli.improve ?? Boolean(openRouterApiToken);
	const openRouterModel = readConfigValue(
		localEnv,
		['OPENROUTER_MODEL', 'ATPROIDEASIO_OPENROUTER_MODEL'],
		ATPROIDEASIO_OPENROUTER_MODEL
	);

	let client: S3Client | null = null;
	let bucket: AtproideasioStorageBucket;
	if (storageMode === 'r2') {
		const accountId = readConfigValue(localEnv, ['CLOUDFLARE_ACCOUNT_ID', 'CLUSTER_R2_ACCOUNT_ID']);
		const accessKeyId = readConfigValue(localEnv, 'CLUSTER_R2_ACCESS_KEY_ID');
		const secretAccessKey = readConfigValue(localEnv, 'CLUSTER_R2_SECRET_ACCESS_KEY');
		if (!accountId || !accessKeyId || !secretAccessKey) {
			throw new Error(
				'Missing R2 config. Set CLOUDFLARE_ACCOUNT_ID or CLUSTER_R2_ACCOUNT_ID, plus CLUSTER_R2_ACCESS_KEY_ID and CLUSTER_R2_SECRET_ACCESS_KEY.'
			);
		}
		const bucketName = readConfigValue(localEnv, 'CLUSTER_R2_BUCKET', DEFAULT_BUCKET);
		client = new S3Client({
			region: 'auto',
			endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
			credentials: {
				accessKeyId,
				secretAccessKey
			}
		});
		bucket = createR2Bucket(client, bucketName);
		console.log(
			`Using R2 bucket ${bucketName}; keys ${ATPROIDEASIO_CACHE_KEY} and ${ATPROIDEASIO_SAVED_STORIES_KEY}.`
		);
	} else {
		const localRoot = readConfigValue(localEnv, 'ATPROIDEASIO_LOCAL_R2_DIR', DEFAULT_LOCAL_R2_DIR);
		bucket = createLocalBucket(localRoot);
		console.log(
			`Using local storage dir ${localRoot}; keys ${ATPROIDEASIO_CACHE_KEY} and ${ATPROIDEASIO_SAVED_STORIES_KEY}.`
		);
	}

	const outputPath = cli.outputPath ?? readConfigValue(localEnv, 'ATPROIDEASIO_OUTPUT_PATH', DEFAULT_OUTPUT_PATH);
	const savedStoriesOutputPath = readConfigValue(
		localEnv,
		'ATPROIDEASIO_SAVED_STORIES_OUTPUT_PATH',
		DEFAULT_SAVED_STORIES_OUTPUT_PATH
	);

	try {
		await ensureAtproideasioSavedStories(bucket);
		let snapshot = await ingestAtproideasioIdeas(
			{
				POST_CACHE: bucket,
				ATPROIDEASIO_BSKY_HANDLE: readConfigValue(localEnv, 'ATPROIDEASIO_BSKY_HANDLE'),
				ATPROIDEASIO_BSKY_IDENTIFIER: readConfigValue(localEnv, 'ATPROIDEASIO_BSKY_IDENTIFIER'),
				ATPROIDEASIO_BSKY_APP_PASSWORD: readConfigValue(localEnv, 'ATPROIDEASIO_BSKY_APP_PASSWORD'),
				ATPROIDEASIO_MAX_SEARCH_PAGES: readConfigValue(localEnv, 'ATPROIDEASIO_MAX_SEARCH_PAGES'),
				ATPROIDEASIO_MAX_THREAD_FETCHES: readConfigValue(localEnv, 'ATPROIDEASIO_MAX_THREAD_FETCHES')
			},
			{
				maxSearchPages,
				maxThreadFetches,
				log: (message) => console.log(message)
			}
		);

		if (improve) {
			if (!openRouterApiToken) {
				console.warn('OPENROUTER_API_TOKEN is missing; skipping DeepSeek title/summary generation.');
				snapshot = await retagAtproideasioSnapshot(bucket);
			} else {
				snapshot = await improveAtproideasioSnapshot(bucket, {
					openRouterApiToken,
					model: openRouterModel,
					force: Boolean(cli.forceImprove),
					limit: maxImprove,
					log: (message) => console.log(message)
				});
			}
		} else {
			snapshot = await retagAtproideasioSnapshot(bucket);
		}

		if (outputPath && outputPath !== '0') {
			await writeSnapshotCopy(snapshot, outputPath);
		}
		if (savedStoriesOutputPath && savedStoriesOutputPath !== '0') {
			await writeSavedStoriesCopy(await readAtproideasioSavedStories(bucket), savedStoriesOutputPath);
		}

		console.log(
			`Done: ${snapshot.stats?.newCandidates ?? 0} new, ${snapshot.candidates.length} total, ${snapshot.stats?.threadFailures ?? 0} thread failures.`
		);
		if (snapshot.warnings.length > 0) {
			console.warn(`Warnings: ${snapshot.warnings.length}`);
			for (const warning of snapshot.warnings) {
				console.warn(`- ${warning}`);
			}
		}
	} finally {
		client?.destroy();
	}
}

main().catch((error: any) => {
	console.error(error?.message || 'atproideasio ingest failed.');
	if (error?.stack) {
		console.error(error.stack);
	}
	process.exitCode = 1;
});
