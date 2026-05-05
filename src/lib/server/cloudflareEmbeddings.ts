const EMBEDDING_MODEL = '@cf/baai/bge-small-en-v1.5';
const EMBEDDING_POOLING = 'cls';
const DEFAULT_ENV_PATH = '.env.cluster.local';
const RUN_ENDPOINT_BASE = 'https://api.cloudflare.com/client/v4/accounts';
const MAX_EMBED_RETRIES = 5;
const RETRY_BASE_DELAY_MS = 800;
const RETRYABLE_STATUSES = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

type EnvMap = Record<string, string>;

type EmbedBatchResult = {
	vectors: number[][];
	pooling?: string;
};

async function getNodeModules() {
	const importNodeModule = <T>(specifier: string) =>
		Function('specifier', 'return import(specifier)')(specifier) as Promise<T>;
	const [{ readFile }, pathModule] = await Promise.all([
		importNodeModule<typeof import('node:fs/promises')>(`node:${'fs/promises'}`),
		importNodeModule<typeof import('node:path')>(`node:${'path'}`)
	]);

	return {
		readFile,
		path: pathModule.default ?? pathModule
	};
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

async function loadLocalEnv(): Promise<EnvMap> {
	const { readFile, path } = await getNodeModules();
	const envPath = path.resolve(process.cwd(), DEFAULT_ENV_PATH);

	try {
		return parseEnvFile(await readFile(envPath, 'utf8'));
	} catch (error: any) {
		if (error?.code === 'ENOENT') {
			return {};
		}
		throw error;
	}
}

function readConfigValue(localEnv: EnvMap, keys: string[]): string {
	for (const key of keys) {
		const processValue = process.env[key]?.trim();
		if (processValue) return processValue;

		const localValue = localEnv[key]?.trim();
		if (localValue) return localValue;
	}
	return '';
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeVector(values: ArrayLike<number>): number[] {
	let magnitudeSquared = 0;
	for (let index = 0; index < values.length; index++) {
		const value = Number(values[index]) || 0;
		magnitudeSquared += value * value;
	}

	const magnitude = Math.sqrt(magnitudeSquared);
	if (!Number.isFinite(magnitude) || magnitude === 0) {
		return Array.from({ length: values.length }, () => 0);
	}

	const normalized = new Array<number>(values.length);
	for (let index = 0; index < values.length; index++) {
		normalized[index] = (Number(values[index]) || 0) / magnitude;
	}
	return normalized;
}

function extractVectors(payload: any): number[][] {
	const result = payload?.result ?? payload;
	const vectors = Array.isArray(result?.data) ? result.data : null;
	if (!vectors || vectors.some((vector: unknown) => !Array.isArray(vector))) {
		throw new Error('Workers AI did not return a valid embedding payload.');
	}
	return vectors as number[][];
}

function summarizeApiError(payload: any, status: number): string {
	const candidate =
		typeof payload?.errors?.[0]?.message === 'string'
			? payload.errors[0].message
			: typeof payload?.result?.error === 'string'
				? payload.result.error
				: typeof payload?.error === 'string'
					? payload.error
					: typeof payload?.message === 'string'
						? payload.message
						: '';
	return candidate ? `Cloudflare AI error (${status}): ${candidate}` : `Cloudflare AI error (${status}).`;
}

async function requestAiBindingEmbeddings(ai: Ai, texts: string[]): Promise<EmbedBatchResult> {
	const payload = await ai.run(EMBEDDING_MODEL, {
		text: texts,
		pooling: EMBEDDING_POOLING
	});

	return {
		vectors: extractVectors(payload),
		pooling: EMBEDDING_POOLING
	};
}

async function requestRestEmbeddings(
	accountId: string,
	apiToken: string,
	texts: string[],
	signal?: AbortSignal
): Promise<EmbedBatchResult> {
	const response = await fetch(`${RUN_ENDPOINT_BASE}/${accountId}/ai/run/${EMBEDDING_MODEL}`, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${apiToken}`,
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({
			text: texts,
			pooling: EMBEDDING_POOLING
		}),
		signal
	});

	const payload = await response.json().catch(() => null);
	if (!response.ok) {
		throw Object.assign(new Error(summarizeApiError(payload, response.status)), {
			status: response.status
		});
	}

	const result = payload?.result ?? payload;
	return {
		vectors: extractVectors(payload),
		pooling: typeof result?.pooling === 'string' ? result.pooling : undefined
	};
}

async function requestRestEmbeddingsWithRetry(
	accountId: string,
	apiToken: string,
	texts: string[],
	signal?: AbortSignal
): Promise<EmbedBatchResult> {
	for (let attempt = 0; attempt <= MAX_EMBED_RETRIES; attempt++) {
		try {
			return await requestRestEmbeddings(accountId, apiToken, texts, signal);
		} catch (error: any) {
			const status = Number(error?.status);
			const retryable =
				RETRYABLE_STATUSES.has(status) ||
				/network|fetch|timeout|temporary/i.test(error?.message || '');

			if (!retryable || attempt >= MAX_EMBED_RETRIES) {
				throw error;
			}

			await sleep(RETRY_BASE_DELAY_MS * 2 ** attempt);
		}
	}

	throw new Error('Workers AI embedding retries exhausted.');
}

export async function embedTextQuery(
	text: string,
	platform?: App.Platform
): Promise<{
	vector: number[];
	model: string;
	pooling: string;
}> {
	const trimmed = text.trim();
	if (!trimmed) {
		throw new Error('A semantic query is required.');
	}

	if (platform?.env?.FETCH === '0') {
		throw new Error('Live query embeddings are disabled because FETCH=0.');
	}

	let result: EmbedBatchResult;
	if (platform?.env?.AI) {
		result = await requestAiBindingEmbeddings(platform.env.AI, [trimmed]);
	} else {
		const localEnv = await loadLocalEnv();
		const accountId = readConfigValue(localEnv, [
			'CLOUDFLARE_ACCOUNT_ID',
			'CLUSTER_R2_ACCOUNT_ID'
		]);
		const apiToken = readConfigValue(localEnv, ['CLOUDFLARE_API_TOKEN', 'CF_API_TOKEN']);

		if (!accountId || !apiToken) {
			throw new Error(
				'Cloudflare credentials are missing. Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN, or add them to .env.cluster.local.'
			);
		}

		result = await requestRestEmbeddingsWithRetry(accountId, apiToken, [trimmed]);
	}

	if (result.pooling && result.pooling !== EMBEDDING_POOLING) {
		throw new Error(
			`Workers AI returned pooling=${result.pooling}, expected ${EMBEDDING_POOLING}.`
		);
	}

	const vector = result.vectors[0];
	if (!Array.isArray(vector) || vector.length === 0) {
		throw new Error('Workers AI did not return a query embedding.');
	}

	return {
		vector: normalizeVector(vector),
		model: EMBEDDING_MODEL,
		pooling: EMBEDDING_POOLING
	};
}
