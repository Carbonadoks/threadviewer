export interface CorpusPost {
	text: string;
	uri?: string;
	createdAt?: string;
	authorDid?: string;
	authorHandle?: string;
	authorDisplayName?: string;
	authorAvatar?: string;
}

export interface CorpusSuggestionExample {
	text: string;
	uri?: string;
	createdAt?: string;
	authorDid?: string;
	authorHandle?: string;
	authorDisplayName?: string;
	authorAvatar?: string;
}

export interface CorpusSuggestion {
	token: string;
	display: string;
	count: number;
	postCount: number;
	context: string;
	contextTokens: string[];
	source: 'ngram' | 'word';
	insertText: string;
	ghostText: string;
	examples: CorpusSuggestionExample[];
	echoPosts: CorpusPost[];
	latestCreatedAt: string | null;
}

export interface CorpusMarkovStep {
	token: string;
	display: string;
	count: number;
	contextTokens: string[];
}

export interface CorpusMarkovContinuation {
	text: string;
	insertText: string;
	tokens: string[];
	steps: CorpusMarkovStep[];
	seed: CorpusSuggestion;
	score: number;
	examples: CorpusSuggestionExample[];
}

export type CorpusMarkovStrategy = 'frequent' | 'varied' | 'loose';

export interface CorpusCompletionIndex {
	contexts: Map<string, Map<string, CorpusTokenStats>>;
	words: Map<string, CorpusTokenStats>;
	postCount: number;
	tokenCount: number;
	contextCount: number;
	maxContextTokens: number;
}

interface CorpusTokenStats {
	token: string;
	count: number;
	postKeys: Set<string>;
	variantCounts: Map<string, number>;
	examples: CorpusSuggestionExample[];
	echoPosts: CorpusPost[];
	latestCreatedAt: string | null;
}

interface TokenMatch {
	raw: string;
	lower: string;
	start: number;
	end: number;
}

interface SuggestionLookup {
	contextTokens: string[];
	partialToken: string;
	replacePartial: boolean;
}

interface CursorTokenState {
	token: TokenMatch | null;
	endsWithWord: boolean;
}

const DEFAULT_MAX_CONTEXT_TOKENS = 3;
const DEFAULT_MAX_EXAMPLES = 4;
const DEFAULT_MAX_ECHO_POSTS = 120;
const CONTEXT_SEPARATOR = '\u0001';
const TOKEN_PATTERN = /[\p{L}\p{N}]+(?:['\u2019][\p{L}\p{N}]+)*/gu;
const WORD_END_PATTERN = /[\p{L}\p{N}'\u2019]$/u;
const SENTENCE_STOP_TOKEN_PATTERN = /^(?:lol|lmao|haha|ok|okay|yes|no)$/i;

function normalizeToken(token: string): string {
	return token.toLocaleLowerCase();
}

function contextKey(tokens: string[]): string {
	return tokens.map(normalizeToken).join(CONTEXT_SEPARATOR);
}

function tokenize(text: string): TokenMatch[] {
	const tokens: TokenMatch[] = [];
	for (const match of text.matchAll(TOKEN_PATTERN)) {
		const raw = match[0];
		const start = match.index ?? 0;
		tokens.push({
			raw,
			lower: normalizeToken(raw),
			start,
			end: start + raw.length
		});
	}
	return tokens;
}

function snippetForMatch(text: string, matchStart: number, matchEnd: number): string {
	const oneLine = text.replace(/\s+/g, ' ').trim();
	if (oneLine.length <= 180) return oneLine;

	const safeStart = Math.max(0, Math.min(matchStart, oneLine.length));
	const safeEnd = Math.max(safeStart, Math.min(matchEnd, oneLine.length));
	const matchCenter = Math.round((safeStart + safeEnd) / 2);
	const snippetStart = Math.max(0, matchCenter - 80);
	const snippetEnd = Math.min(oneLine.length, snippetStart + 180);
	const adjustedStart = Math.max(0, snippetEnd - 180);
	const prefix = adjustedStart > 0 ? '...' : '';
	const suffix = snippetEnd < oneLine.length ? '...' : '';
	return `${prefix}${oneLine.slice(adjustedStart, snippetEnd).trim()}${suffix}`;
}

function bestVariant(stats: CorpusTokenStats): string {
	let best = stats.token;
	let bestCount = -1;
	for (const [variant, count] of stats.variantCounts) {
		if (count > bestCount || (count === bestCount && variant.length < best.length)) {
			best = variant;
			bestCount = count;
		}
	}
	return best;
}

function latestDateValue(value: string | null): number {
	if (!value) return 0;
	const time = Date.parse(value);
	return Number.isFinite(time) ? time : 0;
}

function compareStats(a: CorpusTokenStats, b: CorpusTokenStats): number {
	const countDelta = b.count - a.count;
	if (countDelta !== 0) return countDelta;

	const postDelta = b.postKeys.size - a.postKeys.size;
	if (postDelta !== 0) return postDelta;

	const dateDelta = latestDateValue(b.latestCreatedAt) - latestDateValue(a.latestCreatedAt);
	if (dateDelta !== 0) return dateDelta;

	const aDisplay = bestVariant(a);
	const bDisplay = bestVariant(b);
	const lengthDelta = aDisplay.length - bDisplay.length;
	if (lengthDelta !== 0) return lengthDelta;

	return aDisplay.localeCompare(bDisplay);
}

function hashString(value: string): number {
	let hash = 2166136261;
	for (let i = 0; i < value.length; i += 1) {
		hash ^= value.charCodeAt(i);
		hash = Math.imul(hash, 16777619);
	}
	return hash >>> 0;
}

function createTokenStats(token: string): CorpusTokenStats {
	return {
		token,
		count: 0,
		postKeys: new Set(),
		variantCounts: new Map(),
		examples: [],
		echoPosts: [],
		latestCreatedAt: null
	};
}

function recordTokenStats(
	stats: CorpusTokenStats,
	options: {
		rawToken: string;
		postKey: string;
		post: CorpusPost;
		text: string;
		matchStart: number;
		matchEnd: number;
		maxExamples: number;
		maxEchoPosts: number;
	}
): void {
	const { rawToken, postKey, post, text, matchStart, matchEnd, maxExamples, maxEchoPosts } = options;
	const alreadyHadPost = stats.postKeys.has(postKey);
	stats.count += 1;
	stats.postKeys.add(postKey);
	stats.variantCounts.set(rawToken, (stats.variantCounts.get(rawToken) ?? 0) + 1);

	if (post.createdAt && latestDateValue(post.createdAt) > latestDateValue(stats.latestCreatedAt)) {
		stats.latestCreatedAt = post.createdAt;
	}

	if (maxExamples > 0 && stats.examples.length < maxExamples) {
		const snippet = snippetForMatch(text, matchStart, matchEnd);
		if (snippet && !stats.examples.some((example) => example.text === snippet)) {
			stats.examples.push({
				text: snippet,
				uri: post.uri,
				createdAt: post.createdAt,
				authorDid: post.authorDid,
				authorHandle: post.authorHandle,
				authorDisplayName: post.authorDisplayName,
				authorAvatar: post.authorAvatar
			});
		}
	}

	if (!alreadyHadPost && maxEchoPosts > 0 && stats.echoPosts.length < maxEchoPosts) {
		stats.echoPosts.push(post);
	}
}

function getCursorTokenState(text: string, cursor: number): CursorTokenState {
	const beforeCursor = text.slice(0, cursor);
	const tokens = tokenize(beforeCursor);
	const endsWithWord = WORD_END_PATTERN.test(beforeCursor);
	const lastToken = tokens[tokens.length - 1] ?? null;

	return {
		token: endsWithWord ? lastToken : null,
		endsWithWord
	};
}

function getContextTokensBeforeCursor(text: string, cursor: number): string[] {
	return tokenize(text.slice(0, cursor)).map((token) => token.raw);
}

function isLikelyTerminalToken(token: string): boolean {
	return SENTENCE_STOP_TOKEN_PATTERN.test(token);
}

function buildSuggestionFromStats(options: {
	stats: CorpusTokenStats;
	insertText: string;
	contextKey: string;
	contextTokens: string[];
	source: 'ngram' | 'word';
}): CorpusSuggestion {
	const { stats, insertText, contextKey, contextTokens, source } = options;
	const display = bestVariant(stats);
	return {
		token: stats.token,
		display,
		count: stats.count,
		postCount: stats.postKeys.size,
		context: contextKey,
		contextTokens,
		source,
		insertText,
		ghostText: insertText,
		examples: stats.examples,
		echoPosts: stats.echoPosts,
		latestCreatedAt: stats.latestCreatedAt
	};
}

function selectMarkovStats(
	candidates: CorpusTokenStats[],
	chainTokens: string[],
	stepIndex: number,
	seedKey: string,
	strategy: CorpusMarkovStrategy
): CorpusTokenStats | null {
	const viable = candidates.filter((stats) => {
		const display = bestVariant(stats);
		if (!display) return false;
		const recent = chainTokens.slice(-3).map((token) => normalizeToken(token));
		const repeatCount = recent.filter((token) => token === stats.token).length;
		return repeatCount < 2;
	});
	if (viable.length === 0) return null;
	if (strategy === 'frequent') return viable[0];

	const poolSize = Math.min(strategy === 'loose' ? 14 : 8, viable.length);
	const pool = viable.slice(0, poolSize);
	if (strategy === 'loose') {
		const offset = Math.min(pool.length - 1, 2 + (hashString(`${seedKey}:${stepIndex}:loose`) % Math.max(1, pool.length - 2)));
		return pool[offset];
	}

	return pool[hashString(`${seedKey}:${stepIndex}:varied`) % pool.length];
}

function getContextStats(
	index: CorpusCompletionIndex,
	tokens: string[]
): { key: string; tokens: string[]; stats: Map<string, CorpusTokenStats> } | null {
	const maxLength = Math.min(index.maxContextTokens, tokens.length);
	for (let length = maxLength; length >= 1; length -= 1) {
		const contextTokens = tokens.slice(tokens.length - length);
		const key = contextKey(contextTokens);
		const stats = index.contexts.get(key);
		if (stats && stats.size > 0) {
			return { key, tokens: contextTokens, stats };
		}
	}
	return null;
}

function buildLookupPlan(
	index: CorpusCompletionIndex,
	text: string,
	cursor: number
): SuggestionLookup[] {
	const beforeCursor = text.slice(0, cursor);
	const tokens = tokenize(beforeCursor);
	if (tokens.length === 0) return [];

	const lastToken = tokens[tokens.length - 1];
	const endsWithWord = WORD_END_PATTERN.test(beforeCursor);
	const plans: SuggestionLookup[] = [];

	if (endsWithWord && tokens.length > 1 && lastToken.raw.length <= 2) {
		plans.push({
			contextTokens: tokens.slice(0, -1).map((token) => token.raw),
			partialToken: lastToken.raw,
			replacePartial: true
		});
	}

	plans.push({
		contextTokens: tokens.map((token) => token.raw),
		partialToken: '',
		replacePartial: false
	});

	if (endsWithWord && tokens.length > 1) {
		plans.push({
			contextTokens: tokens.slice(0, -1).map((token) => token.raw),
			partialToken: lastToken.raw,
			replacePartial: true
		});
	}

	if (!endsWithWord && tokens.length > 0) {
		plans.push({
			contextTokens: tokens.map((token) => token.raw),
			partialToken: '',
			replacePartial: false
		});
	}

	return plans.filter((plan) => plan.contextTokens.length > 0);
}

export function buildCorpusCompletionIndex(
	posts: CorpusPost[],
	options: { maxContextTokens?: number; maxExamples?: number; maxEchoPosts?: number } = {}
): CorpusCompletionIndex {
	const maxContextTokens = Math.max(1, Math.floor(options.maxContextTokens ?? DEFAULT_MAX_CONTEXT_TOKENS));
	const maxExamples = Math.max(0, Math.floor(options.maxExamples ?? DEFAULT_MAX_EXAMPLES));
	const maxEchoPosts = Math.max(0, Math.floor(options.maxEchoPosts ?? DEFAULT_MAX_ECHO_POSTS));
	const contexts = new Map<string, Map<string, CorpusTokenStats>>();
	const words = new Map<string, CorpusTokenStats>();
	let tokenCount = 0;

	posts.forEach((post, index) => {
		const text = post.text.trim();
		if (!text) return;

		const tokens = tokenize(text);
		tokenCount += tokens.length;
		const postKey = post.uri ?? `${index}:${text.slice(0, 40)}`;

		for (const token of tokens) {
			let stats = words.get(token.lower);
			if (!stats) {
				stats = createTokenStats(token.lower);
				words.set(token.lower, stats);
			}
			recordTokenStats(stats, {
				rawToken: token.raw,
				postKey,
				post,
				text,
				matchStart: token.start,
				matchEnd: token.end,
				maxExamples,
				maxEchoPosts
			});
		}

		for (let nextIndex = 1; nextIndex < tokens.length; nextIndex += 1) {
			const nextToken = tokens[nextIndex];
			for (let contextLength = 1; contextLength <= maxContextTokens; contextLength += 1) {
				const start = nextIndex - contextLength;
				if (start < 0) break;

				const keyTokens = tokens.slice(start, nextIndex).map((token) => token.lower);
				const key = contextKey(keyTokens);
				let contextStats = contexts.get(key);
				if (!contextStats) {
					contextStats = new Map();
					contexts.set(key, contextStats);
				}

				let stats = contextStats.get(nextToken.lower);
				if (!stats) {
					stats = createTokenStats(nextToken.lower);
					contextStats.set(nextToken.lower, stats);
				}

				recordTokenStats(stats, {
					rawToken: nextToken.raw,
					postKey,
					post,
					text,
					matchStart: tokens[start]?.start ?? 0,
					matchEnd: nextToken.end,
					maxExamples,
					maxEchoPosts
				});
			}
		}
	});

	return {
		contexts,
		words,
		postCount: posts.length,
		tokenCount,
		contextCount: contexts.size,
		maxContextTokens
	};
}

export function getCorpusSuggestions(
	index: CorpusCompletionIndex,
	text: string,
	options: { cursor?: number; limit?: number } = {}
): CorpusSuggestion[] {
	const cursor = Math.max(0, Math.min(text.length, options.cursor ?? text.length));
	const limit = Math.max(1, Math.floor(options.limit ?? 8));
	const beforeCursor = text.slice(0, cursor);
	const hasTrailingSpace = beforeCursor.length === 0 || /\s$/.test(beforeCursor);
	const plans = buildLookupPlan(index, text, cursor);

	for (const plan of plans) {
		const context = getContextStats(index, plan.contextTokens);
		if (!context) continue;

		const partial = normalizeToken(plan.partialToken);
		const matches = [...context.stats.values()]
			.filter((stats) => {
				if (!partial) return true;
				return stats.token.startsWith(partial) && stats.token !== partial;
			})
			.sort(compareStats)
			.slice(0, limit);

		if (matches.length === 0) continue;

		return matches.map((stats) => {
			const display = bestVariant(stats);
			const insertedCompletion = plan.replacePartial
				? display.slice(plan.partialToken.length)
				: `${hasTrailingSpace ? '' : ' '}${display}`;

			return buildSuggestionFromStats({
				stats,
				insertText: insertedCompletion,
				contextKey: context.key,
				contextTokens: context.tokens,
				source: 'ngram'
			});
		});
	}

	const currentToken = getCursorTokenState(text, cursor).token;
	if (!currentToken || currentToken.raw.length === 0) return [];

	const partial = currentToken.lower;
	const matches = [...index.words.values()]
		.filter((stats) => stats.token.startsWith(partial) && stats.token !== partial)
		.sort(compareStats)
		.slice(0, limit);

	return matches.map((stats) => {
		const display = bestVariant(stats);
		const insertedCompletion = display.slice(currentToken.raw.length);

		return buildSuggestionFromStats({
			stats,
			insertText: insertedCompletion,
			contextKey: partial,
			contextTokens: [],
			source: 'word'
		});
	});
}

export function generateCorpusMarkovContinuations(
	index: CorpusCompletionIndex,
	text: string,
	options: {
		cursor?: number;
		count?: number;
		maxTokens?: number;
		seedLimit?: number;
		strategy?: CorpusMarkovStrategy;
	} = {}
): CorpusMarkovContinuation[] {
	const cursor = Math.max(0, Math.min(text.length, options.cursor ?? text.length));
	const count = Math.max(1, Math.floor(options.count ?? 5));
	const maxTokens = Math.max(2, Math.floor(options.maxTokens ?? 12));
	const seedLimit = Math.max(count, Math.floor(options.seedLimit ?? count * 3));
	const strategy = options.strategy ?? 'frequent';
	const baseContextTokens = getContextTokensBeforeCursor(text, cursor);
	const seeds = getCorpusSuggestions(index, text, { cursor, limit: seedLimit });
	const continuations: CorpusMarkovContinuation[] = [];
	const seen = new Set<string>();

	for (const seed of seeds) {
		const chainTokens = [seed.display];
		const steps: CorpusMarkovStep[] = [
			{
				token: seed.token,
				display: seed.display,
				count: seed.count,
				contextTokens: seed.contextTokens
			}
		];
		const insertionParts = [seed.insertText];
		let score = Math.log(seed.count + 1);

		const seedContextTokens =
			seed.source === 'ngram'
				? [...seed.contextTokens, seed.display]
				: [...baseContextTokens.slice(0, -1), seed.display].filter(Boolean);

		let walkingTokens = seedContextTokens.length > 0 ? seedContextTokens : [seed.display];
		const seedKey = `${seed.context}:${seed.token}:${seed.display}`;

		for (let stepIndex = 1; stepIndex < maxTokens; stepIndex += 1) {
			const context = getContextStats(index, walkingTokens);
			if (!context) break;

			const candidates = [...context.stats.values()].sort(compareStats);
			const selected = selectMarkovStats(candidates, chainTokens, stepIndex, seedKey, strategy);
			if (!selected) break;

			const display = bestVariant(selected);
			chainTokens.push(display);
			insertionParts.push(` ${display}`);
			steps.push({
				token: selected.token,
				display,
				count: selected.count,
				contextTokens: context.tokens
			});
			score += Math.log(selected.count + 1) / (stepIndex + 1);
			walkingTokens = [...walkingTokens, display];

			if (isLikelyTerminalToken(display) && chainTokens.length >= 4) break;
		}

		if (chainTokens.length < 2) continue;

		const insertText = insertionParts.join('');
		const chainText = chainTokens.join(' ');
		const key = chainText.toLocaleLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);

		continuations.push({
			text: chainText,
			insertText,
			tokens: chainTokens,
			steps,
			seed,
			score,
			examples: seed.examples
		});

		if (continuations.length >= count) break;
	}

	return continuations.sort((a, b) => b.score - a.score);
}
