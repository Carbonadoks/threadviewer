const DEFAULT_CLASSIFICATION_MODEL = 'gemini-3.1-flash-lite-preview';
const DEFAULT_CLASSIFICATION_MAX_TEXT_CHARS = 7000;
const DEFAULT_CLASSIFICATION_MAX_RETRIES = 3;
const DEFAULT_CLASSIFICATION_BASE_DELAY_MS = 700;
const DEFAULT_CLASSIFICATION_MAX_CLUSTERS = 12;

export interface SemanticClassificationInput {
	cluster: number;
	text: string;
}

export interface SemanticClassificationOutput {
	cluster: number;
	label: string;
	keywords: string[];
	summary: string;
}

export interface SemanticClassificationPayload {
	model: string;
	classifications: SemanticClassificationOutput[];
}

export function classificationModel(): string {
	return DEFAULT_CLASSIFICATION_MODEL;
}

export function normalizeClassificationInputs(
	raw: unknown,
	maxClusters = DEFAULT_CLASSIFICATION_MAX_CLUSTERS
): SemanticClassificationInput[] {
	const input = Array.isArray(raw) ? raw : [];
	return input
		.filter(
			(cluster): cluster is SemanticClassificationInput =>
				typeof cluster?.cluster === 'number' && typeof cluster?.text === 'string'
		)
		.map((cluster) => ({
			cluster: Math.round(cluster.cluster),
			text: cluster.text.trim()
		}))
		.filter((cluster) => cluster.text.length > 0)
		.slice(0, maxClusters);
}

function isRetryableStatus(status: number): boolean {
	return status === 429 || status >= 500;
}

function backoffDelayMs(attempt: number, baseDelayMs: number): number {
	const exponential = baseDelayMs * 2 ** attempt;
	const jitter = Math.floor(Math.random() * 250);
	return Math.min(6000, exponential + jitter);
}

async function sleep(ms: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function sha256Hex(value: string): Promise<string> {
	const encoded = new TextEncoder().encode(value);
	const digest = await crypto.subtle.digest('SHA-256', encoded);
	return Array.from(new Uint8Array(digest))
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('');
}

function extractTextCandidate(payload: any): string {
	const parts = payload?.candidates?.[0]?.content?.parts;
	const text = parts?.find((part: any) => typeof part?.text === 'string')?.text;
	if (!text) {
		throw new Error('Gemini Flash did not return text.');
	}
	return text;
}

function parseJsonBlock(text: string): unknown {
	const trimmed = text.trim();
	const withoutFence = trimmed
		.replace(/^```json\s*/i, '')
		.replace(/^```\s*/i, '')
		.replace(/\s*```$/, '')
		.trim();
	return JSON.parse(withoutFence);
}

function normalizeClassification(item: any): SemanticClassificationOutput | null {
	const cluster = Number.isFinite(Number(item?.cluster)) ? Math.round(Number(item.cluster)) : NaN;
	const label = typeof item?.label === 'string' ? item.label.trim() : '';
	const summary = typeof item?.summary === 'string' ? item.summary.trim() : '';
	const keywords = Array.isArray(item?.keywords)
		? item.keywords
				.filter((keyword: unknown): keyword is string => typeof keyword === 'string')
				.map((keyword: string) => keyword.trim().toLowerCase())
				.filter(Boolean)
				.slice(0, 4)
		: [];

	if (!Number.isFinite(cluster) || !label || !summary) {
		return null;
	}

	return {
		cluster,
		label,
		keywords,
		summary
	};
}

export function buildClassificationPrompt(
	clusters: SemanticClassificationInput[],
	options: { maxTextChars?: number } = {}
): string {
	const maxTextChars = options.maxTextChars ?? DEFAULT_CLASSIFICATION_MAX_TEXT_CHARS;
	const body = clusters
		.map(
			(cluster) =>
				`Cluster ${cluster.cluster}:\n${cluster.text.slice(0, maxTextChars)}`
		)
		.join('\n\n---\n\n');

	return [
		'You are labeling semantic clusters of Bluesky self-reply threads.',
		'For each cluster, infer one concise semantic category.',
		'Return only a JSON array.',
		'Each item must have: cluster (number), label (2-4 words), keywords (2-4 lowercase words), summary (one sentence).',
		'Avoid generic labels like "posts", "threads", "discussion", or "misc".',
		'Use the provided cluster numbers unchanged.',
		'Clusters:',
		body
	].join('\n\n');
}

export function didClassificationCacheKey(
	did: string,
	signature: string,
	version = 'v1'
): string {
	return `classifications/${version}/${did}/${signature}.json`;
}

export function globalClassificationCacheKey(signature: string, version = 'v2'): string {
	return `classifications/${version}/global/${signature}.json`;
}

export async function buildClassificationSignature(
	clusters: SemanticClassificationInput[]
): Promise<string> {
	const normalized = [...clusters]
		.map((cluster) => ({
			cluster: Math.round(cluster.cluster),
			text: cluster.text.trim()
		}))
		.filter((cluster) => cluster.text.length > 0)
		.sort((a, b) => a.cluster - b.cluster || a.text.localeCompare(b.text));
	return sha256Hex(JSON.stringify(normalized));
}

export async function readCachedClassification(
	bucket: R2Bucket | undefined,
	key: string
): Promise<SemanticClassificationPayload | null> {
	if (!bucket) return null;
	const object = await bucket.get(key);
	if (!object) return null;

	try {
		const payload = (await object.json()) as SemanticClassificationPayload;
		if (!payload?.model || !Array.isArray(payload?.classifications)) {
			return null;
		}
		return payload;
	} catch {
		return null;
	}
}

export async function writeCachedClassification(
	bucket: R2Bucket | undefined,
	key: string,
	payload: SemanticClassificationPayload
): Promise<void> {
	if (!bucket) return;

	await bucket.put(key, JSON.stringify(payload), {
		httpMetadata: { contentType: 'application/json' }
	});
}

export async function requestSemanticClassification(
	apiKey: string,
	prompt: string,
	options: {
		model?: string;
		maxRetries?: number;
		baseDelayMs?: number;
	} = {}
): Promise<SemanticClassificationPayload> {
	const model = options.model ?? DEFAULT_CLASSIFICATION_MODEL;
	const maxRetries = options.maxRetries ?? DEFAULT_CLASSIFICATION_MAX_RETRIES;
	const baseDelayMs = options.baseDelayMs ?? DEFAULT_CLASSIFICATION_BASE_DELAY_MS;
	const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

	for (let attempt = 0; attempt <= maxRetries; attempt++) {
		const response = await fetch(url, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'x-goog-api-key': apiKey
			},
			body: JSON.stringify({
				contents: [
					{
						role: 'user',
						parts: [{ text: prompt }]
					}
				],
				generationConfig: {
					temperature: 0.2
				}
			})
		});

		if (response.ok) {
			const payload = await response.json();
			const parsed = parseJsonBlock(extractTextCandidate(payload));
			if (!Array.isArray(parsed)) {
				throw new Error('Gemini Flash returned an invalid classification payload.');
			}

			const classifications = parsed
				.map((item) => normalizeClassification(item))
				.filter((item): item is SemanticClassificationOutput => item !== null);

			return {
				model,
				classifications
			};
		}

		const text = await response.text();
		if (attempt < maxRetries && isRetryableStatus(response.status)) {
			await sleep(backoffDelayMs(attempt, baseDelayMs));
			continue;
		}

		throw new Error(`Gemini Flash classification failed ${response.status}: ${text}`);
	}

	throw new Error('Gemini Flash classification retries exhausted.');
}
