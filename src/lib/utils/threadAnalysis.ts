import type {
	SelfReplyThread,
	ThreadAnalysisPost
} from '$lib/types';
import { flattenThreadForChat } from '$lib/utils/threadFlattener';

const TARGET_SEGMENT_CHARS = 900;
const MAX_SEGMENT_CHARS = 1200;

function normalizeWhitespace(text: string): string {
	return text
		.replace(/\r\n/g, '\n')
		.replace(/[ \t]+\n/g, '\n')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}

function splitSentences(text: string): string[] {
	const normalized = normalizeWhitespace(text).replace(/\n+/g, ' ');
	if (!normalized) return [];

	const parts = normalized.split(/(?<=[.!?])\s+(?=[A-Z0-9"'(])/g);
	return parts.map((part) => part.trim()).filter(Boolean);
}

function splitLongBlock(text: string): string[] {
	const sentences = splitSentences(text);
	if (sentences.length <= 1) {
		const chunks: string[] = [];
		let start = 0;
		while (start < text.length) {
			const slice = text.slice(start, start + MAX_SEGMENT_CHARS).trim();
			if (slice) chunks.push(slice);
			start += MAX_SEGMENT_CHARS;
		}
		return chunks;
	}

	const chunks: string[] = [];
	let current = '';

	for (const sentence of sentences) {
		if (!current) {
			current = sentence;
			continue;
		}

		if (current.length + 1 + sentence.length <= MAX_SEGMENT_CHARS) {
			current += ` ${sentence}`;
			continue;
		}

		chunks.push(current);
		current = sentence;
	}

	if (current) chunks.push(current);
	return chunks;
}

function toParagraphUnits(text: string): string[] {
	const normalized = normalizeWhitespace(text);
	if (!normalized) return [];

	const rawParagraphs = normalized
		.split(/\n\s*\n+/)
		.map((paragraph) => paragraph.replace(/\s+/g, ' ').trim())
		.filter(Boolean);

	if (rawParagraphs.length === 0) return [];

	const units: string[] = [];
	for (const paragraph of rawParagraphs) {
		if (paragraph.length <= MAX_SEGMENT_CHARS) {
			units.push(paragraph);
			continue;
		}
		units.push(...splitLongBlock(paragraph));
	}

	return units;
}

export function chunkParagraphs(text: string, maxSegments = 8): string[] {
	const units = toParagraphUnits(text);
	if (units.length === 0) return [];

	const segments: string[] = [];
	let current = '';

	for (const unit of units) {
		if (!current) {
			current = unit;
			continue;
		}

		if (current.length + 2 + unit.length <= TARGET_SEGMENT_CHARS) {
			current += `\n\n${unit}`;
			continue;
		}

		segments.push(current);
		current = unit;

		if (segments.length >= maxSegments) {
			break;
		}
	}

	if (segments.length < maxSegments && current) {
		segments.push(current);
	}

	return segments.slice(0, maxSegments);
}

function trimPreview(text: string, maxLength: number): string {
	if (text.length <= maxLength) return text;
	return `${text.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

export function buildThreadAnalysisDocument(
	thread: SelfReplyThread,
	maxSegments = 8
): {
	posts: ThreadAnalysisPost[];
	text: string;
	title: string;
	preview: string;
	segments: string[];
} {
	const posts = flattenThreadForChat(thread.rootPost)
		.map(({ post }) => ({
			uri: post.uri,
			text: normalizeWhitespace(post.text),
			createdAt: post.createdAt
		}))
		.filter((post) => post.text.length > 0);

	const combinedText = posts.map((post) => post.text).join('\n\n');
	const fallbackText = posts.length > 0 ? posts[0].text : 'Untitled thread';
	const normalizedText = normalizeWhitespace(combinedText) || fallbackText;
	const title = trimPreview(posts[0]?.text || 'Untitled thread', 84);
	const preview = trimPreview(normalizedText, 220);
	const segments = chunkParagraphs(normalizedText, maxSegments);

	return {
		posts,
		text: normalizedText,
		title,
		preview,
		segments: segments.length > 0 ? segments : [normalizedText]
	};
}

export function normalizeVector(vector: number[]): number[] {
	const magnitude = Math.hypot(...vector);
	if (!Number.isFinite(magnitude) || magnitude === 0) {
		return vector.map(() => 0);
	}
	return vector.map((value) => value / magnitude);
}

export function averageEmbeddings(vectors: number[][]): number[] {
	if (vectors.length === 0) return [];
	if (vectors.length === 1) return normalizeVector(vectors[0].slice());

	const length = vectors[0].length;
	const totals = new Array<number>(length).fill(0);

	for (const vector of vectors) {
		for (let i = 0; i < length; i++) {
			totals[i] += vector[i] ?? 0;
		}
	}

	for (let i = 0; i < length; i++) {
		totals[i] /= vectors.length;
	}

	return normalizeVector(totals);
}

function dotProduct(a: number[], b: number[]): number {
	let total = 0;
	const length = Math.min(a.length, b.length);
	for (let i = 0; i < length; i++) {
		total += a[i] * b[i];
	}
	return total;
}

function multiplyMatrixVector(matrix: number[][], vector: number[]): number[] {
	return matrix.map((row) => dotProduct(row, vector));
}

function normalizeCoordinateVector(vector: number[]): number[] {
	const magnitude = Math.hypot(...vector);
	if (!Number.isFinite(magnitude) || magnitude === 0) return vector.map(() => 0);
	return vector.map((value) => value / magnitude);
}

function powerIteration(
	matrix: number[][],
	orthogonalTo: number[][] = [],
	iterations = 80
): { value: number; vector: number[] } {
	const size = matrix.length;
	let vector = new Array<number>(size)
		.fill(0)
		.map((_, index) => Math.sin((index + 1) * 1.61803398875));
	vector = normalizeCoordinateVector(vector);

	for (let step = 0; step < iterations; step++) {
		let next = multiplyMatrixVector(matrix, vector);

		for (const basis of orthogonalTo) {
			const projection = dotProduct(next, basis);
			next = next.map((value, index) => value - projection * basis[index]);
		}

		const normalized = normalizeCoordinateVector(next);
		if (normalized.every((value) => value === 0)) {
			break;
		}
		vector = normalized;
	}

	const multiplied = multiplyMatrixVector(matrix, vector);
	return {
		value: dotProduct(vector, multiplied),
		vector
	};
}

function fallbackCoordinates(count: number): Array<{ x: number; y: number }> {
	if (count <= 1) return [{ x: 0, y: 0 }];

	return new Array(count).fill(null).map((_, index) => {
		const angle = (index / count) * Math.PI * 2;
		return {
			x: Math.cos(angle),
			y: Math.sin(angle)
		};
	});
}

export function projectEmbeddingsRaw(vectors: number[][]): Array<{ x: number; y: number }> {
	if (vectors.length === 0) return [];
	if (vectors.length === 1) return [{ x: 0, y: 0 }];

	const normalized = vectors.map((vector) => normalizeVector(vector));
	const size = normalized.length;
	const distanceSquared = Array.from({ length: size }, () => new Array<number>(size).fill(0));
	const rowMeans = new Array<number>(size).fill(0);
	let totalMean = 0;

	for (let i = 0; i < size; i++) {
		for (let j = i + 1; j < size; j++) {
			const similarity = Math.max(-1, Math.min(1, dotProduct(normalized[i], normalized[j])));
			const squared = Math.max(0, 2 - 2 * similarity);
			distanceSquared[i][j] = squared;
			distanceSquared[j][i] = squared;
			rowMeans[i] += squared;
			rowMeans[j] += squared;
			totalMean += squared * 2;
		}
	}

	for (let i = 0; i < size; i++) {
		rowMeans[i] /= size;
	}
	totalMean /= size * size;

	const centered = Array.from({ length: size }, () => new Array<number>(size).fill(0));
	for (let i = 0; i < size; i++) {
		for (let j = 0; j < size; j++) {
			centered[i][j] =
				-0.5 *
				(distanceSquared[i][j] - rowMeans[i] - rowMeans[j] + totalMean);
		}
	}

	const first = powerIteration(centered);
	const axes = first.value > 0 ? [first] : [];
	const second = powerIteration(centered, axes.map((axis) => axis.vector));
	if (second.value > 0) axes.push(second);

	if (axes.length === 0) {
		return fallbackCoordinates(size);
	}

	return new Array(size).fill(null).map((_, index) => ({
		x: axes[0] ? axes[0].vector[index] * Math.sqrt(Math.max(axes[0].value, 0)) : 0,
		y: axes[1] ? axes[1].vector[index] * Math.sqrt(Math.max(axes[1].value, 0)) : 0
	}));
}

export function projectEmbeddings(vectors: number[][]): Array<{ x: number; y: number }> {
	const coordinates = projectEmbeddingsRaw(vectors);
	if (coordinates.length <= 1) {
		return coordinates;
	}

	const maxAbs = Math.max(
		1e-9,
		...coordinates.map((point) => Math.max(Math.abs(point.x), Math.abs(point.y)))
	);

	return coordinates.map((point) => ({
		x: point.x / maxAbs,
		y: point.y / maxAbs
	}));
}

export function clusterCoordinates(points: Array<{ x: number; y: number }>): number[] {
	const count = points.length;
	if (count === 0) return [];
	if (count < 3) return new Array<number>(count).fill(0);

	const clusterCount = Math.max(1, Math.min(6, Math.round(Math.sqrt(count / 2))));
	const centers = new Array(clusterCount).fill(null).map((_, index) => {
		const source = points[Math.floor((index * count) / clusterCount)];
		return { x: source.x, y: source.y };
	});
	const assignments = new Array<number>(count).fill(0);

	for (let round = 0; round < 8; round++) {
		for (let i = 0; i < count; i++) {
			let bestIndex = 0;
			let bestDistance = Number.POSITIVE_INFINITY;

			for (let j = 0; j < clusterCount; j++) {
				const dx = points[i].x - centers[j].x;
				const dy = points[i].y - centers[j].y;
				const distance = dx * dx + dy * dy;
				if (distance < bestDistance) {
					bestDistance = distance;
					bestIndex = j;
				}
			}

			assignments[i] = bestIndex;
		}

		const nextCenters = new Array(clusterCount).fill(null).map(() => ({
			x: 0,
			y: 0,
			count: 0
		}));

		for (let i = 0; i < count; i++) {
			const bucket = nextCenters[assignments[i]];
			bucket.x += points[i].x;
			bucket.y += points[i].y;
			bucket.count += 1;
		}

		for (let i = 0; i < clusterCount; i++) {
			if (nextCenters[i].count === 0) continue;
			centers[i] = {
				x: nextCenters[i].x / nextCenters[i].count,
				y: nextCenters[i].y / nextCenters[i].count
			};
		}
	}

	return assignments;
}
