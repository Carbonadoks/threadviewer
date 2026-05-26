import { AtpAgent } from '@atproto/api';
import {
	getFullThread,
	searchPostsByTag,
	type PostSearchAgent,
	type TaggedPostSearchPage
} from '../api/bluesky';
import {
	ATPROIDEASIO_CACHE_KEY,
	ATPROIDEASIO_OPENROUTER_MODEL,
	ATPROIDEASIO_SAVED_STORIES_KEY,
	ATPROIDEASIO_TAG
} from '../constants/atproideasio';
import { BLUESKY_APPVIEW_DID, BLUESKY_APPVIEW_SERVICE_TYPE } from '../constants/blueskyOAuth';
import type { ThreadPost } from '../types';
import type {
	AtproideasioIdeaClaim,
	AtproideasioAiSummary,
	AtproideasioCandidate,
	AtproideasioIssueDraft,
	AtproideasioSavedIdea,
	AtproideasioSavedStories,
	AtproideasioSnapshot,
	AtproideasioThread
} from '../types/atproideasio';
import { flattenThread } from '../utils/threadFlattener';
import { buildBskyPostUrl } from '../utils/viewerLinks';

export interface AtproideasioIngestEnv {
	POST_CACHE?: AtproideasioStorageBucket;
	ATPROIDEASIO_BSKY_HANDLE?: string;
	ATPROIDEASIO_BSKY_IDENTIFIER?: string;
	ATPROIDEASIO_BSKY_APP_PASSWORD?: string;
	ATPROIDEASIO_MAX_SEARCH_PAGES?: string;
	ATPROIDEASIO_MAX_THREAD_FETCHES?: string;
}

export interface AtproideasioStorageObject {
	json(): Promise<unknown>;
}

export interface AtproideasioStorageBucket {
	get(key: string): Promise<AtproideasioStorageObject | null>;
	put(
		key: string,
		value: string,
		options?: { httpMetadata?: { contentType?: string } }
	): Promise<unknown>;
}

export interface AtproideasioIngestOptions {
	maxSearchPages?: number | null;
	maxThreadFetches?: number | null;
	log?: (message: string) => void;
}

export interface AtproideasioImproveOptions {
	openRouterApiToken: string;
	model?: string;
	force?: boolean;
	limit?: number | null;
	log?: (message: string) => void;
}

export function emptyAtproideasioSnapshot(): AtproideasioSnapshot {
	return {
		version: 1,
		tag: ATPROIDEASIO_TAG,
		updatedAt: '',
		candidates: [],
		stats: null,
		warnings: []
	};
}

export function emptyAtproideasioSavedStories(): AtproideasioSavedStories {
	return {
		version: 1,
		updatedAt: '',
		stories: []
	};
}

function normalizePositiveInteger(value: unknown): number | null {
	const parsed = Number.parseInt(String(value ?? ''), 10);
	if (!Number.isFinite(parsed) || parsed <= 0) return null;
	return parsed;
}

function normalizeAiSummary(value: unknown): AtproideasioAiSummary | undefined {
	if (!value || typeof value !== 'object') return undefined;
	const summary = value as Partial<AtproideasioAiSummary>;
	if (typeof summary.title !== 'string' || typeof summary.summary !== 'string') return undefined;
	return {
		provider: 'openrouter',
		model: typeof summary.model === 'string' && summary.model ? summary.model : ATPROIDEASIO_OPENROUTER_MODEL,
		promptVersion:
			typeof summary.promptVersion === 'string' && summary.promptVersion
				? summary.promptVersion
				: 'atproideasio-title-summary-v1',
		title: summary.title,
		summary: summary.summary,
		generatedAt:
			typeof summary.generatedAt === 'string' && summary.generatedAt
				? summary.generatedAt
				: new Date().toISOString(),
		inputPostCount: Number.isFinite(summary.inputPostCount) ? Number(summary.inputPostCount) : 0
	};
}

function normalizeIdeaClaim(value: unknown): AtproideasioIdeaClaim | undefined {
	if (!value || typeof value !== 'object') return undefined;
	const claim = value as Partial<AtproideasioIdeaClaim>;
	const claimedBy = typeof claim.claimedBy === 'string' ? claim.claimedBy.trim() : '';
	if (!claimedBy) return undefined;
	return {
		claimedBy,
		claimedAt:
			typeof claim.claimedAt === 'string' && claim.claimedAt ? claim.claimedAt : new Date().toISOString()
	};
}

function normalizeSnapshot(raw: unknown): AtproideasioSnapshot {
	const fallback = emptyAtproideasioSnapshot();
	if (!raw || typeof raw !== 'object') return fallback;
	const value = raw as Partial<AtproideasioSnapshot>;
	const candidates = Array.isArray(value.candidates)
		? (value.candidates.filter(
				(candidate) => candidate && typeof candidate === 'object'
			) as AtproideasioCandidate[])
		: [];
	return {
		version: 1,
		tag: typeof value.tag === 'string' && value.tag ? value.tag : ATPROIDEASIO_TAG,
		updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : '',
		candidates: candidates.map((candidate) => ({
			...candidate,
			ai: normalizeAiSummary(candidate.ai),
			state: {
				saved: Boolean(candidate.state?.saved),
				improved: Boolean(candidate.ai ?? candidate.state?.improved)
			}
		})),
		stats: value.stats && typeof value.stats === 'object' ? value.stats : null,
		warnings: Array.isArray(value.warnings)
			? value.warnings.filter((warning): warning is string => typeof warning === 'string')
			: []
	};
}

function normalizeSavedStories(raw: unknown): AtproideasioSavedStories {
	const fallback = emptyAtproideasioSavedStories();
	if (!raw || typeof raw !== 'object') return fallback;
	const value = raw as Partial<AtproideasioSavedStories>;
	return {
		version: 1,
		updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : '',
		stories: Array.isArray(value.stories)
			? (value.stories
					.filter((story) => story && typeof story === 'object')
					.map((story) => {
							const saved = story as AtproideasioSavedIdea;
							return {
								...saved,
								claim: normalizeIdeaClaim(saved.claim),
								ai: normalizeAiSummary(saved.ai)
							};
						}) as AtproideasioSavedIdea[])
			: []
	};
}

function tagCandidatesWithState(
	candidates: AtproideasioCandidate[],
	savedStories: AtproideasioSavedStories
): AtproideasioCandidate[] {
	const savedRootUris = new Set(savedStories.stories.map((story) => story.rootUri));
	return candidates.map((candidate) => ({
		...candidate,
		state: {
			saved: savedRootUris.has(candidate.thread.rootUri),
			improved: Boolean(candidate.ai)
		}
	}));
}

export async function readAtproideasioSnapshot(
	bucket: AtproideasioStorageBucket | undefined
): Promise<AtproideasioSnapshot> {
	if (!bucket) return emptyAtproideasioSnapshot();
	const object = await bucket.get(ATPROIDEASIO_CACHE_KEY);
	if (!object) return emptyAtproideasioSnapshot();
	return normalizeSnapshot(await object.json().catch(() => null));
}

export async function writeAtproideasioSnapshot(
	bucket: AtproideasioStorageBucket,
	snapshot: AtproideasioSnapshot
): Promise<void> {
	await bucket.put(ATPROIDEASIO_CACHE_KEY, JSON.stringify(snapshot), {
		httpMetadata: { contentType: 'application/json; charset=utf-8' }
	});
}

export async function readAtproideasioSavedStories(
	bucket: AtproideasioStorageBucket | undefined
): Promise<AtproideasioSavedStories> {
	if (!bucket) return emptyAtproideasioSavedStories();
	const object = await bucket.get(ATPROIDEASIO_SAVED_STORIES_KEY);
	if (!object) return emptyAtproideasioSavedStories();
	return normalizeSavedStories(await object.json().catch(() => null));
}

export async function writeAtproideasioSavedStories(
	bucket: AtproideasioStorageBucket,
	stories: AtproideasioSavedStories
): Promise<void> {
	await bucket.put(ATPROIDEASIO_SAVED_STORIES_KEY, JSON.stringify(stories), {
		httpMetadata: { contentType: 'application/json; charset=utf-8' }
	});
}

export async function ensureAtproideasioSavedStories(
	bucket: AtproideasioStorageBucket
): Promise<AtproideasioSavedStories> {
	const stories = await readAtproideasioSavedStories(bucket);
	if (!stories.updatedAt) {
		const next = { ...stories, updatedAt: new Date().toISOString() };
		await writeAtproideasioSavedStories(bucket, next);
		return next;
	}
	return stories;
}

export async function readAtproideasioBoardSnapshot(
	bucket: AtproideasioStorageBucket | undefined
): Promise<AtproideasioSnapshot> {
	const [snapshot, savedStories] = await Promise.all([
		readAtproideasioSnapshot(bucket),
		readAtproideasioSavedStories(bucket)
	]);
	return {
		...snapshot,
		candidates: tagCandidatesWithState(snapshot.candidates, savedStories)
	};
}

function requireCredential(value: string | undefined, label: string): string {
	const clean = value?.trim();
	if (!clean) throw new Error(`Missing required ${label}.`);
	return clean;
}

async function createAuthenticatedSearchAgent(
	env: AtproideasioIngestEnv
): Promise<AtpAgent & PostSearchAgent> {
	const handle = requireCredential(
		env.ATPROIDEASIO_BSKY_HANDLE ?? env.ATPROIDEASIO_BSKY_IDENTIFIER,
		'ATPROIDEASIO_BSKY_HANDLE'
	);
	const password = requireCredential(
		env.ATPROIDEASIO_BSKY_APP_PASSWORD,
		'ATPROIDEASIO_BSKY_APP_PASSWORD'
	);
	const agent = new AtpAgent({ service: 'https://bsky.social' });
	await agent.login({ identifier: handle, password });
	agent.configureProxy(`${BLUESKY_APPVIEW_DID}#${BLUESKY_APPVIEW_SERVICE_TYPE}`);
	return agent as unknown as AtpAgent & PostSearchAgent;
}

function truncate(text: string, limit: number): string {
	const clean = text.trim();
	if (clean.length <= limit) return clean;
	return `${clean.slice(0, Math.max(0, limit - 1)).trim()}...`;
}

function cleanIdeaText(text: string): string {
	return text
		.replace(new RegExp(`#${ATPROIDEASIO_TAG}\\b`, 'gi'), '')
		.replace(/\s+/g, ' ')
		.trim();
}

function buildIssueDraft(
	thread: AtproideasioThread,
	taggedPostUri: string,
	includedUris?: string[]
): AtproideasioIssueDraft {
	const posts = flattenThread(thread.rootPost).map((item) => item.post);
	const included = includedUris
		? posts.filter((post) => includedUris.includes(post.uri))
		: posts;
	const source = included.find((post) => post.uri === taggedPostUri) ?? included[0] ?? thread.rootPost;
	const sourceText = cleanIdeaText(source.text);
	const fallbackText = cleanIdeaText(included.map((post) => post.text).join(' '));
	const summary = truncate(sourceText || fallbackText || 'Untitled idea', 110);
	const title = truncate(summary.split(/[.!?\n]/)[0] || summary, 78);

	return {
		title,
		userStory: sourceText || fallbackText || '[No text]',
		description: '',
		acceptanceCriteria: '',
		notes: '',
		status: 'todo',
		priority: 'medium'
	};
}

function makeCandidate(thread: AtproideasioThread, taggedPost: ThreadPost): AtproideasioCandidate {
	const posts = flattenThread(thread.rootPost).map((item) => item.post);
	const includedUris = posts.map((post) => post.uri);
	return {
		id: thread.rootUri,
		taggedPostUri: taggedPost.uri,
		sourceUrl: buildBskyPostUrl(taggedPost.uri, taggedPost.author.handle),
		thread,
		includedUris,
		issue: buildIssueDraft(thread, taggedPost.uri, includedUris),
		fetchedAt: new Date().toISOString(),
		state: {
			saved: false,
			improved: false
		}
	};
}

function sortCandidates(candidates: AtproideasioCandidate[]): AtproideasioCandidate[] {
	return [...candidates].sort((left, right) => {
		const leftTime = new Date(left.fetchedAt).getTime();
		const rightTime = new Date(right.fetchedAt).getTime();
		if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) {
			return rightTime - leftTime;
		}
		return left.id.localeCompare(right.id);
	});
}

function buildThreadPrompt(candidate: AtproideasioCandidate): string {
	const posts = flattenThread(candidate.thread.rootPost).map((item, index) => {
		const post = item.post;
		return [
			`Post ${index + 1}`,
			`Author: @${post.author.handle}`,
			`Created: ${post.createdAt}`,
			`URI: ${post.uri}`,
			`Text: ${cleanIdeaText(post.text) || '[No text]'}`
		].join('\n');
	});

	return `Read the whole Bluesky/ATProto thread below and turn it into one product story for an AT Protocol feature tracker.

Return JSON only with exactly these keys:
{
  "title": "one specific title under 80 characters",
  "summary": "one or two sentences starting with The user wants..."
}

The title and summary must preserve the concrete feature request. Do not include markdown.

Thread:
${posts.join('\n\n---\n\n')}`;
}

function parseJsonObject(text: string): any {
	const clean = text.trim();
	try {
		return JSON.parse(clean);
	} catch {}
	const match = clean.match(/\{[\s\S]*\}/);
	if (!match) throw new Error('OpenRouter response did not contain JSON.');
	return JSON.parse(match[0]);
}

function wait(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function generateAiSummaryForCandidate(
	candidate: AtproideasioCandidate,
	options: AtproideasioImproveOptions
): Promise<AtproideasioAiSummary> {
	const model = options.model || ATPROIDEASIO_OPENROUTER_MODEL;
	const posts = flattenThread(candidate.thread.rootPost).map((item) => item.post);
	let lastError: Error | null = null;

	for (let attempt = 1; attempt <= 3; attempt += 1) {
		try {
			const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${options.openRouterApiToken}`,
					'Content-Type': 'application/json',
					'HTTP-Referer': 'https://thread-viewer.pages.dev',
					'X-Title': 'threadviewer atproideasio'
				},
				body: JSON.stringify({
					model,
					messages: [
						{
							role: 'system',
							content:
								'You summarize AT Protocol feature-request threads. Return compact valid JSON only.'
						},
						{
							role: 'user',
							content: buildThreadPrompt(candidate)
						}
					],
					response_format: { type: 'json_object' },
					temperature: 0.2,
					max_tokens: 320
				})
			});

			const data = (await response.json().catch(() => null)) as any;
			if (!response.ok) {
				throw new Error(
					data?.error?.message || data?.message || `OpenRouter request failed with ${response.status}`
				);
			}

			const content = data?.choices?.[0]?.message?.content;
			if (typeof content !== 'string' || !content.trim()) {
				throw new Error('OpenRouter response was empty.');
			}
			const parsed = parseJsonObject(content);
			const title = truncate(String(parsed.title ?? '').replace(/\s+/g, ' '), 80);
			const summary = truncate(String(parsed.summary ?? '').replace(/\s+/g, ' '), 520);
			if (!title || !summary) {
				throw new Error('OpenRouter response missed title or summary.');
			}

			return {
				provider: 'openrouter',
				model,
				promptVersion: 'atproideasio-title-summary-v1',
				title,
				summary,
				generatedAt: new Date().toISOString(),
				inputPostCount: posts.length
			};
		} catch (error: any) {
			lastError = error instanceof Error ? error : new Error(error?.message || 'OpenRouter failed.');
			if (attempt < 3) {
				await wait(500 * attempt);
			}
		}
	}

	throw lastError ?? new Error('OpenRouter failed.');
}

export async function improveAtproideasioSnapshot(
	bucket: AtproideasioStorageBucket,
	options: AtproideasioImproveOptions
): Promise<AtproideasioSnapshot> {
	const snapshot = await readAtproideasioSnapshot(bucket);
	const savedStories = await ensureAtproideasioSavedStories(bucket);
	const limit = options.limit ?? null;
	let improvedCount = 0;
	let attemptedCount = 0;

	const candidates: AtproideasioCandidate[] = [];
	for (const candidate of snapshot.candidates) {
		if (!options.force && candidate.ai) {
			candidates.push(candidate);
			continue;
		}
		if (limit && attemptedCount >= limit) {
			candidates.push(candidate);
			continue;
		}

		attemptedCount += 1;
		try {
			options.log?.(`Improving ${attemptedCount}: ${candidate.id}`);
			const ai = await generateAiSummaryForCandidate(candidate, options);
			improvedCount += 1;
			candidates.push({
				...candidate,
				ai,
				issue: {
					...candidate.issue,
					title: ai.title,
					userStory: ai.summary
				},
				state: {
					saved: savedStories.stories.some((story) => story.rootUri === candidate.thread.rootUri),
					improved: true
				}
			});
		} catch (error: any) {
			const warning = `Could not improve ${candidate.id}: ${error?.message || 'unknown error'}`;
			options.log?.(warning);
			candidates.push(candidate);
			snapshot.warnings = [...snapshot.warnings, warning].slice(-25);
		}
	}

	const nextSnapshot: AtproideasioSnapshot = {
		...snapshot,
		updatedAt: new Date().toISOString(),
		candidates: tagCandidatesWithState(sortCandidates(candidates), savedStories)
	};

	await writeAtproideasioSnapshot(bucket, nextSnapshot);
	options.log?.(`Improved ${improvedCount} threads with ${options.model || ATPROIDEASIO_OPENROUTER_MODEL}.`);
	return nextSnapshot;
}

export async function retagAtproideasioSnapshot(
	bucket: AtproideasioStorageBucket
): Promise<AtproideasioSnapshot> {
	const [snapshot, savedStories] = await Promise.all([
		readAtproideasioSnapshot(bucket),
		ensureAtproideasioSavedStories(bucket)
	]);
	const nextSnapshot: AtproideasioSnapshot = {
		...snapshot,
		updatedAt: snapshot.updatedAt || new Date().toISOString(),
		candidates: tagCandidatesWithState(snapshot.candidates, savedStories)
	};
	await writeAtproideasioSnapshot(bucket, nextSnapshot);
	return nextSnapshot;
}

export async function ingestAtproideasioIdeas(
	env: AtproideasioIngestEnv,
	options: AtproideasioIngestOptions = {}
): Promise<AtproideasioSnapshot> {
	const bucket = env.POST_CACHE;
	if (!bucket) throw new Error('POST_CACHE binding is unavailable.');

	const startedAt = new Date().toISOString();
	const previous = await readAtproideasioSnapshot(bucket);
	const candidatesByRootUri = new Map(previous.candidates.map((candidate) => [candidate.id, candidate]));
	const candidatesByTaggedPostUri = new Map(
		previous.candidates.map((candidate) => [candidate.taggedPostUri, candidate])
	);
	const agent = await createAuthenticatedSearchAgent(env);
	const maxSearchPages =
		options.maxSearchPages === undefined
			? normalizePositiveInteger(env.ATPROIDEASIO_MAX_SEARCH_PAGES)
			: options.maxSearchPages;
	const maxThreadFetches =
		options.maxThreadFetches === undefined
			? normalizePositiveInteger(env.ATPROIDEASIO_MAX_THREAD_FETCHES)
			: options.maxThreadFetches;
	const log = options.log;

	const posts: ThreadPost[] = [];
	const seenPostUris = new Set<string>();
	const seenCursors = new Set<string>();
	const warnings: string[] = [];
	let cursor: string | undefined;
	let hitsTotal: number | null = null;
	let searchPages = 0;
	let stoppedReason = 'cursor_exhausted';

	while (true) {
		if (maxSearchPages && searchPages >= maxSearchPages) {
			stoppedReason = 'max_search_pages';
			warnings.push(`Stopped after ${maxSearchPages} search pages.`);
			break;
		}

		searchPages += 1;
		const page: TaggedPostSearchPage = await searchPostsByTag(ATPROIDEASIO_TAG, {
			agent,
			cursor,
			limit: 100,
			sort: 'latest'
		});
		hitsTotal = page.hitsTotal ?? hitsTotal;

		const beforeCount = posts.length;
		for (const post of page.posts) {
			if (seenPostUris.has(post.uri)) continue;
			seenPostUris.add(post.uri);
			posts.push(post);
		}
		log?.(`Search page ${searchPages}: ${page.posts.length} posts, ${posts.length} unique total.`);

		if (!page.cursor) break;
		if (seenCursors.has(page.cursor)) {
			stoppedReason = 'repeated_cursor';
			warnings.push('Bluesky search returned a repeated cursor, so ingestion stopped.');
			break;
		}
		seenCursors.add(page.cursor);

		if (page.posts.length === 0 || posts.length === beforeCount) {
			stoppedReason = 'cursor_without_new_posts';
			warnings.push('Bluesky search returned a cursor without new posts, so ingestion stopped.');
			break;
		}

		cursor = page.cursor;
	}

	let threadFetches = 0;
	let threadFailures = 0;
	let reusedCandidates = 0;
	let newCandidates = 0;

	for (const post of posts) {
		const existingByTaggedPost = candidatesByTaggedPostUri.get(post.uri);
		if (existingByTaggedPost) {
			reusedCandidates += 1;
			continue;
		}

		if (maxThreadFetches && threadFetches >= maxThreadFetches) {
			stoppedReason = 'max_thread_fetches';
			warnings.push(`Stopped after fetching ${maxThreadFetches} new threads.`);
			break;
		}

		try {
			threadFetches += 1;
			const thread = await getFullThread(post.uri, { agent });
			if (candidatesByRootUri.has(thread.rootUri)) {
				reusedCandidates += 1;
				continue;
			}
			const candidate = makeCandidate(thread, post);
			candidatesByRootUri.set(candidate.id, candidate);
			candidatesByTaggedPostUri.set(candidate.taggedPostUri, candidate);
			newCandidates += 1;
			log?.(`Hydrated ${threadFetches}: @${post.author.handle} (${newCandidates} new).`);
		} catch (error: any) {
			threadFailures += 1;
			if (warnings.length < 10) {
				warnings.push(
					`Could not hydrate @${post.author.handle}'s tagged thread: ${error?.message || 'unknown error'}`
				);
			}
		}
	}

	const finishedAt = new Date().toISOString();
	const savedStories = await ensureAtproideasioSavedStories(bucket);
	const snapshot: AtproideasioSnapshot = {
		version: 1,
		tag: ATPROIDEASIO_TAG,
		updatedAt: finishedAt,
		candidates: tagCandidatesWithState(sortCandidates([...candidatesByRootUri.values()]), savedStories),
		stats: {
			startedAt,
			finishedAt,
			searchPages,
			taggedPosts: posts.length,
			hitsTotal,
			candidatesBefore: previous.candidates.length,
			candidatesAfter: candidatesByRootUri.size,
			newCandidates,
			reusedCandidates,
			threadFetches,
			threadFailures,
			stoppedReason
		},
		warnings
	};

	await writeAtproideasioSnapshot(bucket, snapshot);
	return snapshot;
}
