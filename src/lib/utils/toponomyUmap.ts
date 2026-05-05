import {
	normalizeProjectionCoordinates,
	type ProjectionCoordinate
} from './clusterProjection';
import { normalizeVector, projectEmbeddingsRaw } from './threadAnalysis';

interface DirectedNeighbor {
	index: number;
	distance: number;
}

interface FuzzyNeighbor extends DirectedNeighbor {
	weight: number;
}

export interface WeightedEdge {
	left: number;
	right: number;
	weight: number;
}

export interface ReducedCoordinateCluster {
	center: number[];
	indices: number[];
}

const DEFAULT_NEIGHBOR_COUNT = 16;
const DEFAULT_LAYOUT_ITERATIONS = 220;
const INITIAL_LAYOUT_SCALE = 3.2;
const EDGE_ATTRACTION_A = 1.5769434603113077;
const EDGE_ATTRACTION_B = 0.8950608779914887;
const ATTRACTIVE_STEP = 0.92;
const REPULSION_GAMMA = 0.042;
const REPULSION_RADIUS = 1.4;
const DAMPING = 0.82;
const TARGET_SIGMA_SUM_OFFSET = 1;

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

function dotProduct(left: number[], right: number[]): number {
	let total = 0;
	const length = Math.min(left.length, right.length);
	for (let index = 0; index < length; index += 1) {
		total += (left[index] ?? 0) * (right[index] ?? 0);
	}
	return total;
}

function euclideanDistanceSquared(left: ProjectionCoordinate, right: ProjectionCoordinate): number {
	const dx = left.x - right.x;
	const dy = left.y - right.y;
	return dx * dx + dy * dy;
}

function stableDirection(leftIndex: number, rightIndex: number): ProjectionCoordinate {
	const angle =
		(((leftIndex + 1) * 0.7548776662 + (rightIndex + 1) * 1.3247179572) % (Math.PI * 2)) +
		Math.PI / 10;
	return {
		x: Math.cos(angle),
		y: Math.sin(angle)
	};
}

function insertNearest(
	best: DirectedNeighbor[],
	index: number,
	distance: number,
	limit: number
): void {
	let inserted = false;
	for (let position = 0; position < best.length; position += 1) {
		if (distance < best[position].distance) {
			best.splice(position, 0, { index, distance });
			inserted = true;
			break;
		}
	}

	if (!inserted && best.length < limit) {
		best.push({ index, distance });
	}

	if (best.length > limit) {
		best.length = limit;
	}
}

function buildNearestNeighborLists(vectors: number[][], neighborCount: number): DirectedNeighbor[][] {
	const normalized = vectors.map((vector) => normalizeVector(vector));
	const neighbors: DirectedNeighbor[][] = Array.from({ length: normalized.length }, () => []);

	for (let rowIndex = 0; rowIndex < normalized.length; rowIndex += 1) {
		const best: DirectedNeighbor[] = [];
		for (let columnIndex = 0; columnIndex < normalized.length; columnIndex += 1) {
			if (columnIndex === rowIndex) continue;
			const similarity = clamp(dotProduct(normalized[rowIndex], normalized[columnIndex]), -1, 1);
			insertNearest(best, columnIndex, Math.max(0, 2 - 2 * similarity), neighborCount);
		}
		neighbors[rowIndex] = best;
	}

	return neighbors;
}

function smoothMembershipTotal(distances: number[], rho: number, sigma: number): number {
	const safeSigma = Math.max(sigma, 1e-6);
	let total = 0;
	for (const distance of distances) {
		total += distance <= rho ? 1 : Math.exp(-(distance - rho) / safeSigma);
	}
	return total;
}

function smoothLocalScale(distances: number[], neighborCount: number): { rho: number; sigma: number } {
	if (distances.length === 0) {
		return { rho: 0, sigma: 1 };
	}

	const rho = distances.find((distance) => distance > 0) ?? 0;
	const target = Math.max(1, Math.log2(Math.max(2, neighborCount)) + TARGET_SIGMA_SUM_OFFSET);
	let lower = 0;
	let upper = 1;

	while (smoothMembershipTotal(distances, rho, upper) < target && upper < 65_536) {
		upper *= 2;
	}

	for (let iteration = 0; iteration < 48; iteration += 1) {
		const midpoint = (lower + upper) / 2;
		if (smoothMembershipTotal(distances, rho, midpoint) < target) {
			lower = midpoint;
		} else {
			upper = midpoint;
		}
	}

	return {
		rho,
		sigma: Math.max(upper, 1e-4)
	};
}

export function buildFuzzyNeighborGraph(
	vectors: number[][],
	neighborCount = DEFAULT_NEIGHBOR_COUNT
): {
	normalizedVectors: number[][];
	neighborsByNode: FuzzyNeighbor[][];
	edges: WeightedEdge[];
} {
	if (vectors.length === 0) {
		return {
			normalizedVectors: [],
			neighborsByNode: [],
			edges: []
		};
	}

	const normalizedVectors = vectors.map((vector) => normalizeVector(vector));
	const directed = buildNearestNeighborLists(normalizedVectors, neighborCount);
	const fuzzyByNode: FuzzyNeighbor[][] = [];
	const directedWeights = new Map<string, number>();

	for (let rowIndex = 0; rowIndex < directed.length; rowIndex += 1) {
		const neighbors = directed[rowIndex] ?? [];
		const distances = neighbors.map((neighbor) => neighbor.distance);
		const { rho, sigma } = smoothLocalScale(distances, neighborCount);
		const weightedNeighbors = neighbors.map((neighbor) => {
			const weight =
				neighbor.distance <= rho
					? 1
					: Math.exp(-(neighbor.distance - rho) / Math.max(sigma, 1e-6));
			directedWeights.set(`${rowIndex}:${neighbor.index}`, weight);
			return {
				...neighbor,
				weight
			};
		});
		fuzzyByNode[rowIndex] = weightedNeighbors;
	}

	const mergedEdges = new Map<string, WeightedEdge>();
	for (let rowIndex = 0; rowIndex < fuzzyByNode.length; rowIndex += 1) {
		for (const neighbor of fuzzyByNode[rowIndex] ?? []) {
			const left = Math.min(rowIndex, neighbor.index);
			const right = Math.max(rowIndex, neighbor.index);
			const forward = directedWeights.get(`${left}:${right}`) ?? 0;
			const backward = directedWeights.get(`${right}:${left}`) ?? 0;
			const weight = forward + backward - forward * backward;
			if (!(weight > 0)) continue;
			mergedEdges.set(`${left}:${right}`, {
				left,
				right,
				weight
			});
		}
	}

	return {
		normalizedVectors,
		neighborsByNode: fuzzyByNode,
		edges: [...mergedEdges.values()]
	};
}

function initializeLayout(vectors: number[][]): ProjectionCoordinate[] {
	const base = normalizeProjectionCoordinates(projectEmbeddingsRaw(vectors));
	return base.map((coordinate, index) => ({
		x:
			coordinate.x * INITIAL_LAYOUT_SCALE +
			Math.cos((index + 1) * 2.399963229728653) * 0.0008,
		y:
			coordinate.y * INITIAL_LAYOUT_SCALE +
			Math.sin((index + 1) * 2.399963229728653) * 0.0008
	}));
}

function attractiveGradient(distanceSquared: number): number {
	if (!(distanceSquared > 0)) return 0;
	const raised = Math.pow(distanceSquared, EDGE_ATTRACTION_B);
	const numerator =
		-2 *
		EDGE_ATTRACTION_A *
		EDGE_ATTRACTION_B *
		Math.pow(distanceSquared, EDGE_ATTRACTION_B - 1);
	const denominator = EDGE_ATTRACTION_A * raised + 1;
	return numerator / Math.max(denominator, 1e-6);
}

function repulsiveGradient(distanceSquared: number): number {
	const safeDistanceSquared = Math.max(distanceSquared, 1e-6);
	const raised = Math.pow(safeDistanceSquared, EDGE_ATTRACTION_B);
	return (
		(2 * REPULSION_GAMMA * EDGE_ATTRACTION_B) /
		((0.001 + safeDistanceSquared) * (EDGE_ATTRACTION_A * raised + 1))
	);
}

function optimizeReducedLayout(
	initialCoordinates: ProjectionCoordinate[],
	edges: WeightedEdge[],
	iterations = DEFAULT_LAYOUT_ITERATIONS
): ProjectionCoordinate[] {
	if (initialCoordinates.length <= 1) {
		return initialCoordinates;
	}

	const positions = initialCoordinates.map((coordinate) => ({ ...coordinate }));
	const velocities = positions.map(() => ({ x: 0, y: 0 }));
	const cellSize = REPULSION_RADIUS;
	const repulsionRadiusSquared = REPULSION_RADIUS * REPULSION_RADIUS;

	for (let iteration = 0; iteration < iterations; iteration += 1) {
		const cooling = 1 - iteration / (iterations + 1);
		const forces = positions.map(() => ({ x: 0, y: 0 }));

		for (const edge of edges) {
			const left = positions[edge.left];
			const right = positions[edge.right];
			if (!left || !right) continue;

			let dx = left.x - right.x;
			let dy = left.y - right.y;
			let distanceSquared = dx * dx + dy * dy;
			if (distanceSquared < 1e-12) {
				const direction = stableDirection(edge.left, edge.right);
				dx = direction.x * 1e-3;
				dy = direction.y * 1e-3;
				distanceSquared = dx * dx + dy * dy;
			}

			const coefficient =
				attractiveGradient(distanceSquared) * edge.weight * ATTRACTIVE_STEP * cooling;
			const forceX = coefficient * dx;
			const forceY = coefficient * dy;
			forces[edge.left].x += forceX;
			forces[edge.left].y += forceY;
			forces[edge.right].x -= forceX;
			forces[edge.right].y -= forceY;
		}

		const grid = new Map<string, number[]>();
		for (let index = 0; index < positions.length; index += 1) {
			const position = positions[index];
			const cellX = Math.floor(position.x / cellSize);
			const cellY = Math.floor(position.y / cellSize);
			const key = `${cellX}:${cellY}`;
			const bucket = grid.get(key);
			if (bucket) {
				bucket.push(index);
			} else {
				grid.set(key, [index]);
			}
		}

		for (let index = 0; index < positions.length; index += 1) {
			const source = positions[index];
			const cellX = Math.floor(source.x / cellSize);
			const cellY = Math.floor(source.y / cellSize);

			for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
				for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
					const bucket = grid.get(`${cellX + offsetX}:${cellY + offsetY}`) ?? [];
					for (const otherIndex of bucket) {
						if (otherIndex <= index) continue;
						let dx = positions[index].x - positions[otherIndex].x;
						let dy = positions[index].y - positions[otherIndex].y;
						let distanceSquared = dx * dx + dy * dy;
						if (distanceSquared > repulsionRadiusSquared) continue;
						if (distanceSquared < 1e-12) {
							const direction = stableDirection(index, otherIndex);
							dx = direction.x * 1e-3;
							dy = direction.y * 1e-3;
							distanceSquared = dx * dx + dy * dy;
						}

						const coefficient = repulsiveGradient(distanceSquared) * cooling;
						const forceX = coefficient * dx;
						const forceY = coefficient * dy;
						forces[index].x += forceX;
						forces[index].y += forceY;
						forces[otherIndex].x -= forceX;
						forces[otherIndex].y -= forceY;
					}
				}
			}
		}

		let meanX = 0;
		let meanY = 0;
		for (let index = 0; index < positions.length; index += 1) {
			velocities[index].x = (velocities[index].x + forces[index].x) * DAMPING;
			velocities[index].y = (velocities[index].y + forces[index].y) * DAMPING;
			const velocityMagnitude = Math.hypot(velocities[index].x, velocities[index].y);
			if (velocityMagnitude > 0.28) {
				const scale = 0.28 / velocityMagnitude;
				velocities[index].x *= scale;
				velocities[index].y *= scale;
			}
			positions[index].x += velocities[index].x;
			positions[index].y += velocities[index].y;
			meanX += positions[index].x;
			meanY += positions[index].y;
		}

		meanX /= positions.length;
		meanY /= positions.length;
		for (const position of positions) {
			position.x -= meanX;
			position.y -= meanY;
		}
	}

	return positions;
}

export function reduceEmbeddingsWithUmap(
	vectors: number[][],
	options: {
		neighborCount?: number;
		iterations?: number;
	} = {}
): ProjectionCoordinate[] {
	if (vectors.length === 0) return [];
	if (vectors.length === 1) return [{ x: 0, y: 0 }];

	const graph = buildFuzzyNeighborGraph(vectors, options.neighborCount ?? DEFAULT_NEIGHBOR_COUNT);
	if (graph.normalizedVectors.length <= 1) {
		return graph.normalizedVectors.length === 1 ? [{ x: 0, y: 0 }] : [];
	}

	const initialCoordinates = initializeLayout(graph.normalizedVectors);
	const reduced = optimizeReducedLayout(
		initialCoordinates,
		graph.edges,
		options.iterations ?? DEFAULT_LAYOUT_ITERATIONS
	);
	return normalizeProjectionCoordinates(reduced);
}

export function clusterReducedCoordinates(
	coordinates: ProjectionCoordinate[],
	ids: string[],
	clusterCount: number
): { assignments: number[]; clusters: ReducedCoordinateCluster[] } {
	if (coordinates.length === 0 || clusterCount <= 0) {
		return { assignments: [], clusters: [] };
	}
	if (clusterCount === 1) {
		return {
			assignments: new Array(coordinates.length).fill(0),
			clusters: [
				{
					center: [0, 0],
					indices: coordinates.map((_, index) => index)
				}
			]
		};
	}

	const orderedSeeds = ids
		.map((id, index) => ({ id, index }))
		.sort((left, right) => left.id.localeCompare(right.id));
	const centers = new Array(clusterCount).fill(null).map((_, clusterIndex) => {
		const source = coordinates[orderedSeeds[Math.floor((clusterIndex * orderedSeeds.length) / clusterCount)].index];
		return {
			x: source?.x ?? 0,
			y: source?.y ?? 0
		};
	});
	const assignments = new Array<number>(coordinates.length).fill(0);

	for (let iteration = 0; iteration < 14; iteration += 1) {
		let changed = false;
		for (let index = 0; index < coordinates.length; index += 1) {
			let bestCluster = 0;
			let bestDistance = Number.POSITIVE_INFINITY;
			for (let clusterIndex = 0; clusterIndex < centers.length; clusterIndex += 1) {
				const dx = coordinates[index].x - centers[clusterIndex].x;
				const dy = coordinates[index].y - centers[clusterIndex].y;
				const distance = dx * dx + dy * dy;
				if (distance < bestDistance) {
					bestDistance = distance;
					bestCluster = clusterIndex;
				}
			}
			if (assignments[index] !== bestCluster) {
				assignments[index] = bestCluster;
				changed = true;
			}
		}

		const nextCenters = new Array(clusterCount).fill(null).map(() => ({
			x: 0,
			y: 0,
			count: 0
		}));
		for (let index = 0; index < coordinates.length; index += 1) {
			const bucket = nextCenters[assignments[index]];
			bucket.x += coordinates[index].x;
			bucket.y += coordinates[index].y;
			bucket.count += 1;
		}

		for (let clusterIndex = 0; clusterIndex < clusterCount; clusterIndex += 1) {
			const bucket = nextCenters[clusterIndex];
			if (bucket.count > 0) {
				centers[clusterIndex] = {
					x: bucket.x / bucket.count,
					y: bucket.y / bucket.count
				};
				continue;
			}

			const fallbackSeed = orderedSeeds[(iteration + clusterIndex) % orderedSeeds.length];
			const fallback = coordinates[fallbackSeed.index];
			centers[clusterIndex] = {
				x: fallback?.x ?? 0,
				y: fallback?.y ?? 0
			};
		}

		if (!changed) {
			break;
		}
	}

	const clusters = centers.map((center, cluster) => ({
		center: [center.x, center.y],
		indices: assignments
			.map((assignment, index) => ({ assignment, index }))
			.filter((entry) => entry.assignment === cluster)
			.map((entry) => entry.index)
	}));

	return {
		assignments,
		clusters
	};
}

export function nearestReducedCenterDistance(
	point: ProjectionCoordinate,
	center: number[]
): number {
	const centerPoint = {
		x: center[0] ?? 0,
		y: center[1] ?? 0
	};
	return euclideanDistanceSquared(point, centerPoint);
}
