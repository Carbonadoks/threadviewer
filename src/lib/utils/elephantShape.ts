/**
 * Elephant silhouette coordinates for the Picasso visualization.
 *
 * The outline is defined as hand-traced polygon vertices of a side-profile
 * African elephant (facing right), then densely resampled along the perimeter.
 * Coordinates are normalized to [-1, 1].
 */

// Key vertices tracing a side-profile elephant outline clockwise,
// starting at the top of the head. Coordinates in a raw canvas space
// (will be normalized). Y-axis points down (SVG convention) — the
// normalizer flips to math convention.
//
// The shape includes: domed head, ear bulge, back, rump, tail,
// rear leg pair, belly, front leg pair, chest, trunk curling down
// and back up to the lower lip / tusk area, then up to forehead.
const RAW_VERTICES: Array<[number, number]> = [
	// Top of head / forehead
	[200, 100],
	[215, 92],
	[235, 88],
	[255, 90],
	// Ear top bulge
	[270, 85],
	[290, 78],
	[310, 80],
	[325, 90],
	[332, 105],
	[330, 120],
	// Behind ear, nape
	[325, 135],
	[320, 148],
	[318, 160],
	// Back (gently curving)
	[322, 180],
	[330, 200],
	[340, 220],
	[352, 240],
	[365, 260],
	[378, 278],
	[390, 295],
	[400, 310],
	[408, 325],
	// Rump
	[412, 340],
	[414, 355],
	[413, 370],
	[410, 382],
	// Tail (thin upward flick)
	[412, 390],
	[418, 398],
	[425, 392],
	[428, 380],
	[424, 370],
	[416, 365],
	// Rear upper leg (right/back leg, outer)
	[410, 385],
	[408, 400],
	[406, 420],
	[405, 440],
	[406, 458],
	[408, 470],
	// Rear foot
	[412, 478],
	[418, 482],
	[424, 482],
	[428, 478],
	// Rear leg inner
	[426, 465],
	[424, 450],
	[420, 435],
	[416, 420],
	// Gap between rear legs
	[400, 415],
	[390, 420],
	// Second rear leg outer
	[388, 435],
	[386, 450],
	[385, 465],
	[386, 475],
	// Second rear foot
	[390, 482],
	[396, 485],
	[402, 485],
	[406, 480],
	// Second rear leg inner
	[404, 468],
	[400, 450],
	[395, 435],
	// Belly
	[380, 425],
	[360, 420],
	[340, 418],
	[320, 418],
	[300, 420],
	[280, 422],
	[260, 425],
	// Front leg area
	[248, 428],
	// Front leg #1 outer
	[245, 440],
	[243, 455],
	[242, 468],
	[243, 478],
	// Front foot #1
	[247, 484],
	[253, 487],
	[260, 487],
	[264, 483],
	// Front leg #1 inner
	[262, 470],
	[260, 455],
	[258, 442],
	// Gap between front legs
	[248, 438],
	[238, 440],
	// Front leg #2 outer
	[235, 452],
	[233, 465],
	[232, 476],
	// Front foot #2
	[235, 484],
	[241, 488],
	[248, 488],
	[252, 484],
	// Front leg #2 inner
	[250, 474],
	[248, 460],
	[245, 448],
	[240, 438],
	// Chest
	[232, 428],
	[225, 415],
	[218, 400],
	[212, 385],
	[208, 370],
	[205, 355],
	[202, 340],
	// Lower face / jaw
	[200, 325],
	[198, 310],
	[195, 295],
	[192, 280],
	// Trunk starts
	[188, 265],
	[182, 252],
	[175, 242],
	[168, 235],
	[158, 230],
	[148, 232],
	[140, 240],
	[135, 252],
	[132, 268],
	[130, 285],
	[128, 305],
	[125, 325],
	[122, 345],
	[118, 365],
	[115, 380],
	[112, 395],
	[108, 408],
	// Trunk tip curl
	[105, 418],
	[100, 425],
	[94, 428],
	[88, 426],
	[85, 420],
	[88, 412],
	[94, 406],
	[100, 398],
	[106, 388],
	// Trunk back up (underside)
	[112, 375],
	[118, 355],
	[124, 335],
	[130, 315],
	[135, 295],
	[140, 278],
	[146, 262],
	[152, 250],
	[160, 242],
	// Mouth / lower lip back to face
	[170, 238],
	[178, 230],
	[185, 222],
	[190, 212],
	// Eye area / face
	[192, 200],
	[194, 185],
	[196, 170],
	[197, 155],
	[198, 140],
	[198, 125],
	[199, 112],
	[200, 100]
];

function buildNormalizedOutline(): Array<{ x: number; y: number }> {
	let minX = Infinity,
		maxX = -Infinity,
		minY = Infinity,
		maxY = -Infinity;
	for (const [x, y] of RAW_VERTICES) {
		if (x < minX) minX = x;
		if (x > maxX) maxX = x;
		if (y < minY) minY = y;
		if (y > maxY) maxY = y;
	}
	const cx = (minX + maxX) / 2;
	const cy = (minY + maxY) / 2;
	const scale = Math.max(maxX - minX, maxY - minY) / 2 || 1;

	// Normalize and flip Y so trunk points down in math coords
	return RAW_VERTICES.map(([x, y]) => ({
		x: (x - cx) / scale,
		y: -(y - cy) / scale
	}));
}

/**
 * Elephant outline vertices, normalized to [-1, 1].
 */
export const ELEPHANT_POINTS: Array<{ x: number; y: number }> = buildNormalizedOutline();

/**
 * Resample the elephant outline to exactly `n` points by interpolating
 * along the boundary path (closed loop).
 */
export function sampleElephantTargets(n: number): Array<{ x: number; y: number }> {
	const source = ELEPHANT_POINTS;
	if (n <= 0) return [];
	if (n === 1) return [{ x: 0, y: 0 }];

	// Compute cumulative arc lengths along the outline (closed loop)
	const arcLengths = [0];
	for (let i = 1; i < source.length; i++) {
		const dx = source[i].x - source[i - 1].x;
		const dy = source[i].y - source[i - 1].y;
		arcLengths.push(arcLengths[i - 1] + Math.hypot(dx, dy));
	}
	// Close the loop back to the first point
	const closeDx = source[0].x - source[source.length - 1].x;
	const closeDy = source[0].y - source[source.length - 1].y;
	const totalLength = arcLengths[arcLengths.length - 1] + Math.hypot(closeDx, closeDy);

	const result: Array<{ x: number; y: number }> = [];
	for (let i = 0; i < n; i++) {
		const targetArc = (i / n) * totalLength;

		// Find the segment this arc length falls on
		let segIndex = 0;
		for (let j = 1; j < arcLengths.length; j++) {
			if (arcLengths[j] > targetArc) {
				segIndex = j - 1;
				break;
			}
			segIndex = j;
		}

		const segStart = arcLengths[segIndex];
		const nextIndex = (segIndex + 1) % source.length;
		const segDx = source[nextIndex].x - source[segIndex].x;
		const segDy = source[nextIndex].y - source[segIndex].y;
		const segLen = Math.hypot(segDx, segDy);
		const t = segLen > 0 ? Math.min(1, (targetArc - segStart) / segLen) : 0;

		result.push({
			x: source[segIndex].x + segDx * t,
			y: source[segIndex].y + segDy * t
		});
	}

	return result;
}
