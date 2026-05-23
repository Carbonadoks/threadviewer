export type FuzzyTextMatcher = {
	normalized: string;
	terms: string[];
};

const COMBINING_MARKS_PATTERN = /[\u0300-\u036f]/g;
const NON_SEARCH_CHAR_PATTERN = /[^a-z0-9@#]+/g;

export function normalizeFuzzyText(value: string): string {
	return value
		.toLowerCase()
		.normalize('NFKD')
		.replace(COMBINING_MARKS_PATTERN, '')
		.replace(NON_SEARCH_CHAR_PATTERN, ' ')
		.trim()
		.replace(/\s+/g, ' ');
}

export function buildFuzzyTextMatcher(query: string): FuzzyTextMatcher {
	const normalized = normalizeFuzzyText(query);
	return {
		normalized,
		terms: normalized ? normalized.split(' ') : []
	};
}

export function fuzzyTextMatches(value: string, matcher: FuzzyTextMatcher): boolean {
	if (!matcher.normalized || matcher.terms.length === 0) return false;

	const normalizedValue = normalizeFuzzyText(value);
	if (!normalizedValue) return false;
	if (normalizedValue.includes(matcher.normalized)) return true;

	const tokens = normalizedValue.split(' ');
	return matcher.terms.every((term) => tokens.some((token) => fuzzyTermMatchesToken(term, token)));
}

function fuzzyTermMatchesToken(term: string, token: string): boolean {
	if (!term || !token) return false;
	if (token.includes(term)) return true;
	if (term.length < 4) return false;
	if (isCompactSubsequence(term, token)) return true;

	const maxDistance = maxEditDistance(term);
	if (Math.abs(token.length - term.length) > maxDistance) return false;
	return damerauLevenshteinDistance(term, token, maxDistance) <= maxDistance;
}

function maxEditDistance(term: string): number {
	if (term.length <= 5) return 1;
	if (term.length <= 8) return 2;
	return Math.max(2, Math.floor(term.length * 0.25));
}

function isCompactSubsequence(term: string, token: string): boolean {
	if (term.length < 4 || token.length < term.length || token.length > term.length * 2) return false;
	if (term[0] !== token[0]) return false;

	let termIndex = 0;
	for (let tokenIndex = 0; tokenIndex < token.length && termIndex < term.length; tokenIndex += 1) {
		if (token[tokenIndex] === term[termIndex]) {
			termIndex += 1;
		}
	}

	return termIndex === term.length;
}

function damerauLevenshteinDistance(source: string, target: string, maxDistance: number): number {
	let previousPrevious = new Array(target.length + 1).fill(0);
	let previous = Array.from({ length: target.length + 1 }, (_, index) => index);

	for (let sourceIndex = 1; sourceIndex <= source.length; sourceIndex += 1) {
		const current = new Array(target.length + 1).fill(0);
		current[0] = sourceIndex;
		let rowMinimum = current[0];

		for (let targetIndex = 1; targetIndex <= target.length; targetIndex += 1) {
			const substitutionCost = source[sourceIndex - 1] === target[targetIndex - 1] ? 0 : 1;
			let distance = Math.min(
				previous[targetIndex] + 1,
				current[targetIndex - 1] + 1,
				previous[targetIndex - 1] + substitutionCost
			);

			if (
				sourceIndex > 1 &&
				targetIndex > 1 &&
				source[sourceIndex - 1] === target[targetIndex - 2] &&
				source[sourceIndex - 2] === target[targetIndex - 1]
			) {
				distance = Math.min(distance, previousPrevious[targetIndex - 2] + 1);
			}

			current[targetIndex] = distance;
			rowMinimum = Math.min(rowMinimum, distance);
		}

		if (rowMinimum > maxDistance) return maxDistance + 1;

		previousPrevious = previous;
		previous = current;
	}

	return previous[target.length];
}
