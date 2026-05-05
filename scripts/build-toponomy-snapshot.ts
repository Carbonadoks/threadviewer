import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import {
	DeleteObjectCommand,
	GetObjectCommand,
	HeadObjectCommand,
	ListObjectsV2Command,
	PutObjectCommand,
	S3Client,
	type GetObjectCommandOutput
} from '@aws-sdk/client-s3';
import {
	buildOfflineToponomySnapshot
} from '../src/lib/server/toponomySnapshot';
import type { ClusterStorage } from '../src/lib/server/clusterSnapshot';

const DEFAULT_BUCKET = 'thread-viewer-cache';
const ENV_PATH = path.resolve(process.cwd(), '.env.cluster.local');

type EnvMap = Record<string, string>;

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

async function loadLocalEnv(envPath: string): Promise<EnvMap> {
	try {
		return parseEnvFile(await readFile(envPath, 'utf8'));
	} catch (error: any) {
		if (error?.code === 'ENOENT') {
			return {};
		}
		throw error;
	}
}

function readConfigValue(localEnv: EnvMap, key: string, fallback = ''): string {
	return process.env[key]?.trim() || localEnv[key]?.trim() || fallback;
}

function requireConfig(localEnv: EnvMap, key: string): string {
	const value = readConfigValue(localEnv, key);
	if (!value) {
		throw new Error(`Missing required config: ${key}`);
	}
	return value;
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

function createS3ClusterStorage(client: S3Client, bucket: string): ClusterStorage {
	return {
		async list(prefix, options = {}) {
			const response = await client.send(
				new ListObjectsV2Command({
					Bucket: bucket,
					Prefix: prefix,
					ContinuationToken: options.cursor,
					MaxKeys: options.limit
				})
			);
			return {
				objects: (response.Contents ?? [])
					.map((item) => item.Key)
					.filter((key): key is string => typeof key === 'string' && key.length > 0)
					.map((key) => ({ key })),
				truncated: Boolean(response.IsTruncated),
				cursor: response.NextContinuationToken
			};
		},
		async has(key) {
			try {
				await client.send(
					new HeadObjectCommand({
						Bucket: bucket,
						Key: key
					})
				);
				return true;
			} catch (error) {
				if (isMissingError(error)) {
					return false;
				}
				throw error;
			}
		},
		async getText(key) {
			try {
				const response = await client.send(
					new GetObjectCommand({
						Bucket: bucket,
						Key: key
					})
				);
				return bodyToString(response.Body);
			} catch (error) {
				if (isMissingError(error)) {
					return null;
				}
				throw error;
			}
		},
		async putText(key, value, options = {}) {
			await client.send(
				new PutObjectCommand({
					Bucket: bucket,
					Key: key,
					Body: value,
					ContentType: options.contentType ?? 'application/json'
				})
			);
		},
		async delete(key) {
			await client.send(
				new DeleteObjectCommand({
					Bucket: bucket,
					Key: key
				})
			);
		}
	};
}

async function main() {
	console.log('Run this builder with: npm run toponomy:build');
	const localEnv = await loadLocalEnv(ENV_PATH);
	if (Object.keys(localEnv).length > 0) {
		console.log(`Loaded local cluster config from ${ENV_PATH}`);
	}

	const accountId = requireConfig(localEnv, 'CLUSTER_R2_ACCOUNT_ID');
	const accessKeyId = requireConfig(localEnv, 'CLUSTER_R2_ACCESS_KEY_ID');
	const secretAccessKey = requireConfig(localEnv, 'CLUSTER_R2_SECRET_ACCESS_KEY');
	const bucket = readConfigValue(localEnv, 'CLUSTER_R2_BUCKET', DEFAULT_BUCKET);
	const fetchEnabled = readConfigValue(localEnv, 'FETCH', '1') !== '0';
	const apiKey = readConfigValue(localEnv, 'GEMINI_API_KEY');

	const client = new S3Client({
		region: 'auto',
		endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
		credentials: {
			accessKeyId,
			secretAccessKey
		}
	});
	const storage = createS3ClusterStorage(client, bucket);
	let abortReason: string | null = null;

	function handleSignal(signal: 'SIGINT' | 'SIGTERM') {
		if (!abortReason) {
			abortReason = `Interrupted by ${signal}.`;
			console.error(abortReason);
		}
	}
	const onSigint = () => handleSignal('SIGINT');
	const onSigterm = () => handleSignal('SIGTERM');

	process.on('SIGINT', onSigint);
	process.on('SIGTERM', onSigterm);

	try {
		console.log(`Building toponomy snapshot in bucket ${bucket}.`);
		console.log(`FETCH=${fetchEnabled ? '1' : '0'}; Gemini ${apiKey ? 'configured' : 'not configured'}.`);
		const snapshot = await buildOfflineToponomySnapshot({
			storage,
			fetchEnabled,
			apiKey: apiKey || undefined,
			log: (message) => console.log(message),
			shouldAbort: () => abortReason
		});
		console.log(
			`Toponomy ready: ${snapshot.meta.totalThreads} threads, ${snapshot.meta.clusterCount} classes, ${Math.round(snapshot.meta.projectionNeighborRecall * 100)}% 10-NN preservation.`
		);
		process.exitCode = 0;
	} catch (error: any) {
		console.error(error?.message || 'Toponomy snapshot build failed.');
		if (error?.stack) {
			console.error(error.stack);
		}
		process.exitCode = abortReason ? 130 : 1;
	} finally {
		process.off('SIGINT', onSigint);
		process.off('SIGTERM', onSigterm);
		client.destroy();
	}
}

void main();
