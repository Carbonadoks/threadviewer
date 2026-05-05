/**
 * Simplified Picasso-like layout algorithm.
 *
 * Maps data points from an initial 2D layout toward target shape coordinates
 * using a combined force: shape attraction + UMAP graph structure preservation.
 */

import type { WeightedEdge } from './toponomyUmap';

export interface PicassoOptions {
	/** Blend factor: 1.0 = pure shape, 0.0 = pure structure. Default 0.8. */
	frac?: number;
	/** Number of relaxation iterations. Default 200. */
	iterations?: number;
	/** Velocity cap per step. Default 0.15. */
	maxVelocity?: number;
	/** Damping factor applied to velocity each step. Default 0.78. */
	damping?: number;
}

interface Point {
	x: number;
	y: number;
}

const DEFAULT_FRAC = 0.8;
const DEFAULT_ITERATIONS = 200;
const DEFAULT_MAX_VELOCITY = 0.15;
const DEFAULT_DAMPING = 0.78;
const REPULSION_RADIUS = 0.08;

/**
 * Assign each data point to a unique target point using angle-sorted greedy
 * matching. Both sets are sorted by angle from their respective centroids,
 * then matched 1:1 in order.
 */
function greedyAngleAssignment(
	sources: Point[],
	targets: Point[]
): number[] {
	const n = sources.length;
	if (n === 0) return [];

	function centroid(pts: Point[]): Point {
		let sx = 0, sy = 0;
		for (const p of pts) { sx += p.x; sy += p.y; }
		return { x: sx / pts.length, y: sy / pts.length };
	}

	function angleFromCenter(p: Point, c: Point): number {
		return Math.atan2(p.y - c.y, p.x - c.x);
	}

	const srcCenter = centroid(sources);
	const tgtCenter = centroid(targets);

	const srcOrder = sources
		.map((p, i) => ({ index: i, angle: angleFromCenter(p, srcCenter) }))
		.sort((a, b) => a.angle - b.angle);

	const tgtOrder = targets
		.map((p, i) => ({ index: i, angle: angleFromCenter(p, tgtCenter) }))
		.sort((a, b) => a.angle - b.angle);

	// Match by rank in angle order
	const assignment = new Array<number>(n);
	for (let i = 0; i < n; i++) {
		assignment[srcOrder[i].index] = tgtOrder[i].index;
	}
	return assignment;
}

/**
 * Run the Picasso layout relaxation.
 *
 * @param initialCoords - Starting 2D coordinates (e.g. from UMAP)
 * @param targetCoords - Target shape coordinates (elephant)
 * @param edges - UMAP fuzzy graph edges for structure preservation
 * @param options - Algorithm parameters
 * @returns Final 2D coordinates
 */
export function picassoLayout(
	initialCoords: Point[],
	targetCoords: Point[],
	edges: WeightedEdge[],
	options: PicassoOptions = {}
): Point[] {
	const n = initialCoords.length;
	if (n === 0) return [];
	if (n === 1) return [{ ...targetCoords[0] }];

	const frac = options.frac ?? DEFAULT_FRAC;
	const iterations = options.iterations ?? DEFAULT_ITERATIONS;
	const maxVelocity = options.maxVelocity ?? DEFAULT_MAX_VELOCITY;
	const damping = options.damping ?? DEFAULT_DAMPING;

	// Assign each point to a target
	const assignment = greedyAngleAssignment(initialCoords, targetCoords);

	// Initialize positions from initial coords, normalized to roughly same scale as targets
	const positions: Point[] = initialCoords.map((p) => ({ ...p }));
	const velocities: Point[] = positions.map(() => ({ x: 0, y: 0 }));

	// Normalize positions to fit within target bounding box
	let tMinX = Infinity, tMaxX = -Infinity, tMinY = Infinity, tMaxY = -Infinity;
	for (const p of targetCoords) {
		if (p.x < tMinX) tMinX = p.x;
		if (p.x > tMaxX) tMaxX = p.x;
		if (p.y < tMinY) tMinY = p.y;
		if (p.y > tMaxY) tMaxY = p.y;
	}
	let sMinX = Infinity, sMaxX = -Infinity, sMinY = Infinity, sMaxY = -Infinity;
	for (const p of positions) {
		if (p.x < sMinX) sMinX = p.x;
		if (p.x > sMaxX) sMaxX = p.x;
		if (p.y < sMinY) sMinY = p.y;
		if (p.y > sMaxY) sMaxY = p.y;
	}
	const sRangeX = sMaxX - sMinX || 1;
	const sRangeY = sMaxY - sMinY || 1;
	const tRangeX = tMaxX - tMinX || 1;
	const tRangeY = tMaxY - tMinY || 1;
	const sCx = (sMinX + sMaxX) / 2;
	const sCy = (sMinY + sMaxY) / 2;
	const tCx = (tMinX + tMaxX) / 2;
	const tCy = (tMinY + tMaxY) / 2;
	for (const p of positions) {
		p.x = ((p.x - sCx) / sRangeX) * tRangeX + tCx;
		p.y = ((p.y - sCy) / sRangeY) * tRangeY + tCy;
	}

	const repulsionRadiusSq = REPULSION_RADIUS * REPULSION_RADIUS;

	for (let iter = 0; iter < iterations; iter++) {
		const cooling = 1 - iter / (iterations + 1);
		const shapeFrac = frac * cooling;
		const structFrac = (1 - frac) * cooling;

		const forces: Point[] = positions.map(() => ({ x: 0, y: 0 }));

		// Shape force: attract each point toward its assigned target
		for (let i = 0; i < n; i++) {
			const target = targetCoords[assignment[i]];
			const dx = target.x - positions[i].x;
			const dy = target.y - positions[i].y;
			forces[i].x += shapeFrac * dx;
			forces[i].y += shapeFrac * dy;
		}

		// Structure force: UMAP edge attraction
		for (const edge of edges) {
			const left = positions[edge.left];
			const right = positions[edge.right];
			if (!left || !right) continue;

			const dx = right.x - left.x;
			const dy = right.y - left.y;
			const dist = Math.hypot(dx, dy);
			if (dist < 1e-8) continue;

			// Light spring-like attraction along edges
			const strength = structFrac * edge.weight * 0.3;
			forces[edge.left].x += strength * dx;
			forces[edge.left].y += strength * dy;
			forces[edge.right].x -= strength * dx;
			forces[edge.right].y -= strength * dy;
		}

		// Mild repulsion to prevent overlapping points (grid-accelerated)
		const cellSize = REPULSION_RADIUS * 2;
		const grid = new Map<string, number[]>();
		for (let i = 0; i < n; i++) {
			const cx = Math.floor(positions[i].x / cellSize);
			const cy = Math.floor(positions[i].y / cellSize);
			const key = `${cx}:${cy}`;
			const bucket = grid.get(key);
			if (bucket) bucket.push(i);
			else grid.set(key, [i]);
		}

		for (let i = 0; i < n; i++) {
			const cx = Math.floor(positions[i].x / cellSize);
			const cy = Math.floor(positions[i].y / cellSize);
			for (let ox = -1; ox <= 1; ox++) {
				for (let oy = -1; oy <= 1; oy++) {
					const bucket = grid.get(`${cx + ox}:${cy + oy}`);
					if (!bucket) continue;
					for (const j of bucket) {
						if (j <= i) continue;
						const dx = positions[i].x - positions[j].x;
						const dy = positions[i].y - positions[j].y;
						const dSq = dx * dx + dy * dy;
						if (dSq > repulsionRadiusSq || dSq < 1e-12) continue;
						const coeff = structFrac * 0.002 / Math.max(dSq, 1e-6);
						forces[i].x += coeff * dx;
						forces[i].y += coeff * dy;
						forces[j].x -= coeff * dx;
						forces[j].y -= coeff * dy;
					}
				}
			}
		}

		// Apply forces via velocity
		for (let i = 0; i < n; i++) {
			velocities[i].x = (velocities[i].x + forces[i].x) * damping;
			velocities[i].y = (velocities[i].y + forces[i].y) * damping;
			const mag = Math.hypot(velocities[i].x, velocities[i].y);
			if (mag > maxVelocity) {
				const scale = maxVelocity / mag;
				velocities[i].x *= scale;
				velocities[i].y *= scale;
			}
			positions[i].x += velocities[i].x;
			positions[i].y += velocities[i].y;
		}
	}

	return positions;
}
