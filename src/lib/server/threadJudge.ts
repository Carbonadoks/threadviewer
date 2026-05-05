import type {
	ThreadJudgeCacheEntry,
	ThreadJudgeGlossaryItem,
	ThreadJudgePayload,
	ThreadJudgePost,
	ThreadJudgeSentiment,
	ThreadJudgment
} from '$lib/types';
import { classificationModel, sha256Hex } from '$lib/server/classification';
import {
	DEFAULT_THREAD_JUDGE_MODEL,
	normalizeThreadJudgeModel
} from '$lib/utils/judgeModels';
import { buildBskyPostUrl } from '$lib/utils/viewerLinks';

const DEFAULT_THREAD_JUDGE_MAX_RETRIES = 3;
const DEFAULT_THREAD_JUDGE_BASE_DELAY_MS = 700;
const DEFAULT_THREAD_JUDGE_INDEX_LIMIT = 200;

const SUPPORTED_SENTIMENTS = new Set<ThreadJudgeSentiment>([
	'very_negative',
	'negative',
	'neutral',
	'positive',
	'very_positive',
	'mixed'
]);

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

function clampScore(value: unknown): number | null {
	const numeric = Number(value);
	if (!Number.isFinite(numeric)) return null;
	return Math.max(0, Math.min(100, Math.round(numeric)));
}

function normalizeSentiment(value: unknown): ThreadJudgeSentiment | null {
	const normalized = String(value ?? '')
		.trim()
		.toLowerCase()
		.replace(/[\s-]+/g, '_');

	if (SUPPORTED_SENTIMENTS.has(normalized as ThreadJudgeSentiment)) {
		return normalized as ThreadJudgeSentiment;
	}

	if (normalized === 'verypositive') return 'very_positive';
	if (normalized === 'verynegative') return 'very_negative';
	return null;
}

function normalizeGlossary(value: unknown): ThreadJudgeGlossaryItem[] {
	if (!Array.isArray(value)) return [];

	const seen = new Set<string>();
	const glossary: ThreadJudgeGlossaryItem[] = [];

	for (const item of value) {
		if (!item || typeof item !== 'object') continue;
		const term = typeof (item as any).term === 'string' ? (item as any).term.trim().slice(0, 48) : '';
		const explanation =
			typeof (item as any).explanation === 'string'
				? (item as any).explanation.trim().replace(/\s+/g, ' ').slice(0, 140)
				: '';

		if (!term || !explanation) continue;

		const dedupeKey = term.toLowerCase();
		if (seen.has(dedupeKey)) continue;
		seen.add(dedupeKey);
		glossary.push({ term, explanation });

		if (glossary.length >= 3) {
			break;
		}
	}

	return glossary;
}

function normalizeJudgment(value: unknown): ThreadJudgment | null {
	if (!value || typeof value !== 'object') return null;

	const judgment = value as Record<string, unknown>;
	const positivity = clampScore(judgment.positivity);
	const excitingness = clampScore(judgment.excitingness);
	const intensity = clampScore(judgment.intensity);
	const curiosity = clampScore(judgment.curiosity);
	const confidence = clampScore(judgment.confidence);
	const summary = typeof judgment.summary === 'string' ? judgment.summary.trim().slice(0, 160) : '';

	if (
		positivity === null ||
		excitingness === null ||
		intensity === null ||
		curiosity === null ||
		confidence === null ||
		!summary
	) {
		return null;
	}

	return {
		sentiment: normalizeSentiment(judgment.sentiment) ?? 'neutral',
		positivity,
		excitingness,
		intensity,
		curiosity,
		confidence,
		summary,
		glossary: normalizeGlossary(judgment.glossary)
	};
}

function normalizeReturnedJudgments(
	raw: unknown,
	expectedPostCount: number
): Record<string, ThreadJudgment> {
	const rawObject =
		raw && typeof raw === 'object' && !Array.isArray(raw)
			? (((raw as Record<string, unknown>).judgments as Record<string, unknown> | undefined) ??
				(raw as Record<string, unknown>))
			: null;

	const judgments: Record<string, ThreadJudgment> = {};

	if (!rawObject || typeof rawObject !== 'object') {
		return judgments;
	}

	for (let index = 1; index <= expectedPostCount; index++) {
		const key = String(index);
		const normalized = normalizeJudgment(rawObject[key]);
		if (normalized) {
			judgments[key] = normalized;
		}
	}

	return judgments;
}

export function threadJudgeModel(): string {
	return normalizeThreadJudgeModel(classificationModel()) ?? DEFAULT_THREAD_JUDGE_MODEL;
}

export function normalizeThreadJudgePosts(
	raw: unknown
): ThreadJudgePost[] {
	const input = Array.isArray(raw) ? raw : [];

	return input
		.filter(
			(post): post is ThreadJudgePost =>
				typeof post?.index === 'number' &&
				typeof post?.uri === 'string' &&
				typeof post?.author?.did === 'string' &&
				typeof post?.author?.handle === 'string' &&
				typeof post?.createdAt === 'string' &&
				typeof post?.text === 'string'
		)
		.map((post) => ({
			index: Math.max(1, Math.round(post.index)),
			uri: post.uri.trim(),
			author: {
				did: post.author.did.trim(),
				handle: post.author.handle.trim(),
				displayName: typeof post.author.displayName === 'string' ? post.author.displayName.trim() : undefined
			},
			createdAt: post.createdAt.trim(),
			text: post.text,
			depth: Math.max(0, Math.round(Number(post.depth) || 0)),
			replyToIndex: Number.isFinite(Number(post.replyToIndex))
				? Math.max(1, Math.round(Number(post.replyToIndex)))
				: null
		}))
		.filter((post) => post.uri && post.author.did && post.author.handle && post.createdAt)
		.sort((left, right) => left.index - right.index);
}

export function buildThreadJudgePrompt(
	posts: ThreadJudgePost[],
	options: { maxTextChars?: number } = {}
): string {
	const maxTextChars =
		typeof options.maxTextChars === 'number' &&
		Number.isFinite(options.maxTextChars) &&
		options.maxTextChars > 0
			? Math.max(1, Math.round(options.maxTextChars))
			: null;
	const body = JSON.stringify(
		posts.map((post) => ({
			index: post.index,
			replyToIndex: post.replyToIndex,
			depth: post.depth,
			author: post.author.handle,
			createdAt: post.createdAt,
			text: maxTextChars === null ? post.text : post.text.slice(0, maxTextChars)
		})),
		null,
		2
	);

		return [
			'You are judging post-by-post emotional movement inside one Bluesky thread.',
			'Return only a JSON object keyed by the post index strings.',
			'Every key from "1" through the last post index must be present exactly once.',
			'Each value must contain: sentiment, positivity, excitingness, intensity, curiosity, confidence, summary, glossary.',
			'Use sentiment from this set only: very_negative, negative, neutral, positive, very_positive, mixed.',
			'Use integers from 0 to 100 for positivity, excitingness, intensity, curiosity, and confidence.',
			'Score each post on its own words plus the surrounding thread context.',
			'When a post is a reply, use the immediately previous post and any referenced parent as context for the shift in tone.',
			'Keep the score scale consistent across the whole thread so adjacent deltas are meaningful.',
			'Keep summary short, concrete, and under 12 words.',
			'Glossary must be an array with up to 3 items. Each item must contain: term, explanation.',
			'Only include words, slang, acronyms, or references from the post that a general reader may not know.',
			'If nothing needs explanation, return an empty glossary array.',
			'Keep each glossary explanation short and concrete.',
			'Do not include markdown, explanations, or code fences.',
			'Thread posts:',
			body
		].join('\n\n');
}

export async function buildThreadJudgeSignature(
	posts: ThreadJudgePost[],
	rootUri = ''
): Promise<string> {
	return sha256Hex(
		JSON.stringify({
			rootUri: rootUri.trim(),
			posts
		})
	);
}

function threadJudgeCacheModelKey(model: unknown): string {
	const normalized = normalizeThreadJudgeModel(model) ?? DEFAULT_THREAD_JUDGE_MODEL;
	return normalized.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '');
}

export function threadJudgeCacheKey(signature: string, model: unknown, version = 'v6'): string {
	return `thread-judgments/${version}/${threadJudgeCacheModelKey(model)}/${signature}.json`;
}

export function legacyThreadJudgeCacheKeys(signature: string): string[] {
	return ['v5', 'v4', 'v3', 'v2', 'v1'].map(
		(version) => `thread-judgments/${version}/${signature}.json`
	);
}

export function threadJudgeIndexKey(version = 'v1'): string {
	return `thread-judgments/index/${version}.json`;
}

function normalizeThreadJudgeCacheEntry(value: unknown): ThreadJudgeCacheEntry | null {
	if (!value || typeof value !== 'object') return null;

	const entry = value as Record<string, unknown>;
	const rootUri = typeof entry.rootUri === 'string' ? entry.rootUri.trim() : '';
	const threadUrl = typeof entry.threadUrl === 'string' ? entry.threadUrl.trim() : '';
	const handle = typeof entry.handle === 'string' ? entry.handle.trim() : '';
	const title = typeof entry.title === 'string' ? entry.title.trim() : '';
	const model = typeof entry.model === 'string' ? entry.model.trim() : '';
	const updatedAt = typeof entry.updatedAt === 'string' ? entry.updatedAt.trim() : '';
	const postCount = Number.isFinite(Number(entry.postCount)) ? Math.max(0, Math.round(Number(entry.postCount))) : 0;

	if (!rootUri || !threadUrl || !handle || !title || !model || !updatedAt || postCount <= 0) {
		return null;
	}

	return {
		rootUri,
		threadUrl,
		handle,
		title,
		postCount,
		model,
		updatedAt
	};
}

function updatedAtMs(value: string): number {
	const timestamp = new Date(value).getTime();
	return Number.isFinite(timestamp) ? timestamp : 0;
}

export function buildThreadJudgeIndexEntry(
	rootUri: string,
	posts: ThreadJudgePost[],
	payload: ThreadJudgePayload,
	updatedAt = new Date().toISOString()
): ThreadJudgeCacheEntry | null {
	const openingPost = posts[0];
	if (!openingPost?.author?.handle) return null;

	const threadUrl = buildBskyPostUrl(rootUri, openingPost.author.handle);
	if (!threadUrl) return null;

	const compactTitle = openingPost.text.trim().replace(/\s+/g, ' ');
	const title = compactTitle.length > 140 ? `${compactTitle.slice(0, 140)}...` : compactTitle;

	if (!title) return null;

	return {
		rootUri: rootUri.trim(),
		threadUrl,
		handle: openingPost.author.handle,
		title,
		postCount: payload.postCount,
		model: payload.model,
		updatedAt
	};
}

export function upsertThreadJudgeIndex(
	existing: ThreadJudgeCacheEntry[],
	entry: ThreadJudgeCacheEntry,
	limit = DEFAULT_THREAD_JUDGE_INDEX_LIMIT
): ThreadJudgeCacheEntry[] {
	const entryModel = normalizeThreadJudgeModel(entry.model) ?? entry.model;
	const next = [
		entry,
		...existing.filter((candidate) => {
			const candidateModel = normalizeThreadJudgeModel(candidate.model) ?? candidate.model;
			return candidate.rootUri !== entry.rootUri || candidateModel !== entryModel;
		})
	];
	return next
		.sort((left, right) => updatedAtMs(right.updatedAt) - updatedAtMs(left.updatedAt))
		.slice(0, limit);
}

export async function readThreadJudgeIndex(
	bucket: R2Bucket | undefined,
	key = threadJudgeIndexKey('v1')
): Promise<ThreadJudgeCacheEntry[]> {
	if (!bucket) return [];
	const object = await bucket.get(key);
	if (!object) return [];

	try {
		const payload = (await object.json()) as { threads?: unknown } | unknown;
		const threads = Array.isArray((payload as any)?.threads) ? (payload as any).threads : payload;
		if (!Array.isArray(threads)) {
			return [];
		}

		return threads
			.map((entry) => normalizeThreadJudgeCacheEntry(entry))
			.filter((entry): entry is ThreadJudgeCacheEntry => entry !== null)
			.sort((left, right) => updatedAtMs(right.updatedAt) - updatedAtMs(left.updatedAt));
	} catch {
		return [];
	}
}

export async function writeThreadJudgeIndex(
	bucket: R2Bucket | undefined,
	key: string,
	threads: ThreadJudgeCacheEntry[]
): Promise<void> {
	if (!bucket) return;

	await bucket.put(
		key,
		JSON.stringify({ threads }, null, 2),
		{
			httpMetadata: { contentType: 'application/json' }
		}
	);
}

export async function readCachedThreadJudge(
	bucket: R2Bucket | undefined,
	key: string
): Promise<ThreadJudgePayload | null> {
	if (!bucket) return null;
	const object = await bucket.get(key);
	if (!object) return null;

	try {
		const payload = (await object.json()) as ThreadJudgePayload;
		if (!payload?.model || typeof payload?.postCount !== 'number' || !payload?.judgments) {
			return null;
		}
		return payload;
	} catch {
		return null;
	}
}

export async function writeCachedThreadJudge(
	bucket: R2Bucket | undefined,
	key: string,
	payload: ThreadJudgePayload
): Promise<void> {
	if (!bucket) return;

	await bucket.put(key, JSON.stringify(payload), {
		httpMetadata: { contentType: 'application/json' }
	});
}

export async function requestThreadJudge(
	apiKey: string,
	prompt: string,
	options: {
		expectedPostCount: number;
		model?: string;
		maxRetries?: number;
		baseDelayMs?: number;
	} = {
		expectedPostCount: 0
	}
): Promise<ThreadJudgePayload> {
	const model = options.model ?? threadJudgeModel();
	const maxRetries = options.maxRetries ?? DEFAULT_THREAD_JUDGE_MAX_RETRIES;
	const baseDelayMs = options.baseDelayMs ?? DEFAULT_THREAD_JUDGE_BASE_DELAY_MS;
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
			const judgments = normalizeReturnedJudgments(parsed, options.expectedPostCount);

			if (!judgments['1']) {
				throw new Error('Gemini Flash did not return a usable baseline for post 1.');
			}

			return {
				model,
				postCount: options.expectedPostCount,
				judgments
			};
		}

		const text = await response.text();
		if (attempt < maxRetries && isRetryableStatus(response.status)) {
			await sleep(backoffDelayMs(attempt, baseDelayMs));
			continue;
		}

		throw new Error(`Gemini Flash thread judging failed ${response.status}: ${text}`);
	}

	throw new Error('Gemini Flash thread judging retries exhausted.');
}
