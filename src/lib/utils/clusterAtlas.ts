import {
	normalizeProjectionCoordinates,
	type ProjectionCoordinate
} from './clusterProjection';
import { projectEmbeddingsRaw } from './threadAnalysis';

export interface AtlasClusterCenter {
	cluster: number;
	center: number[];
	threadCount?: number;
}

export interface AtlasRegionLayout {
	cluster: number;
	x: number;
	y: number;
	radiusX: number;
	radiusY: number;
	angle: number;
	labelRank: number;
	threadCount: number;
}

export interface AtlasLayoutResult {
	coordinates: ProjectionCoordinate[];
	regions: AtlasRegionLayout[];
}

interface ClusterAtlasStat {
	cluster: number;
	center: number[];
	centroid: ProjectionCoordinate;
	extent: number;
	threadCount: number;
	spreadScale: number;
	memberIndices: number[];
	offsets: ProjectionCoordinate[];
}

interface OffsetShape {
	angle: number;
	radiusMajor: number;
	radiusMinor: number;
	aspectRatio: number;
	averageRadius: number;
	maxRadius: number;
}

const ANCHOR_ITERATIONS = 104;
const ANCHOR_ATTRACTION = 0.034;
const ANCHOR_TETHER = 0.148;
const ANCHOR_DAMPING = 0.78;
const MAX_ANCHOR_DISPLACEMENT_FACTOR = 0.9;
const MIN_REGION_RADIUS = 0.09;
const BASE_SPREAD_SCALE = 1;
const MAX_SPREAD_SCALE = 1.05;
const CLUSTER_GAP_PADDING = 0.045;
const LOCAL_BLEND_MIN = 0.42;
const LOCAL_BLEND_MAX = 0.9;
const TARGET_CLUSTER_ASPECT_RATIO = 1.9;
const MAX_CLUSTER_ASPECT_RATIO = 2.05;

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

function stableUnitVector(leftIndex: number, rightIndex: number): ProjectionCoordinate {
	const angle =
		(((leftIndex + 1) * 0.61803398875 + (rightIndex + 1) * 1.32471795724) %
			(Math.PI * 2)) +
		Math.PI / 8;
	return {
		x: Math.cos(angle),
		y: Math.sin(angle)
	};
}

function meanCoordinate(points: ProjectionCoordinate[]): ProjectionCoordinate {
	if (points.length === 0) {
		return { x: 0, y: 0 };
	}

	let totalX = 0;
	let totalY = 0;
	for (const point of points) {
		totalX += point.x;
		totalY += point.y;
	}

	return {
		x: totalX / points.length,
		y: totalY / points.length
	};
}

function percentileAbsolute(values: number[], percentile: number): number {
	if (values.length === 0) return 0;
	const ordered = values.map((value) => Math.abs(value)).sort((left, right) => left - right);
	const position = clamp(percentile, 0, 1) * (ordered.length - 1);
	const lowerIndex = Math.floor(position);
	const upperIndex = Math.ceil(position);
	if (lowerIndex === upperIndex) {
		return ordered[lowerIndex] ?? 0;
	}
	const lower = ordered[lowerIndex] ?? 0;
	const upper = ordered[upperIndex] ?? lower;
	return lower + (upper - lower) * (position - lowerIndex);
}

function computeAxisAngle(points: ProjectionCoordinate[], centroid: ProjectionCoordinate): number {
	if (points.length <= 1) return 0;

	let xx = 0;
	let xy = 0;
	let yy = 0;
	for (const point of points) {
		const dx = point.x - centroid.x;
		const dy = point.y - centroid.y;
		xx += dx * dx;
		xy += dx * dy;
		yy += dy * dy;
	}

	return 0.5 * Math.atan2(2 * xy, xx - yy);
}

function rotatePoint(point: ProjectionCoordinate, angle: number): ProjectionCoordinate {
	const cos = Math.cos(angle);
	const sin = Math.sin(angle);
	return {
		x: point.x * cos - point.y * sin,
		y: point.x * sin + point.y * cos
	};
}

function averageRadius(points: ProjectionCoordinate[]): number {
	if (points.length === 0) return 0;
	let total = 0;
	for (const point of points) {
		total += Math.hypot(point.x, point.y);
	}
	return total / points.length;
}

function maxRadius(points: ProjectionCoordinate[]): number {
	let maxValue = 0;
	for (const point of points) {
		maxValue = Math.max(maxValue, Math.hypot(point.x, point.y));
	}
	return maxValue;
}

function measureOffsetShape(offsets: ProjectionCoordinate[]): OffsetShape {
	if (offsets.length === 0) {
		return {
			angle: 0,
			radiusMajor: 0,
			radiusMinor: 0,
			aspectRatio: 1,
			averageRadius: 0,
			maxRadius: 0
		};
	}

	let angle = computeAxisAngle(offsets, { x: 0, y: 0 });
	const cos = Math.cos(angle);
	const sin = Math.sin(angle);
	const projectedX: number[] = [];
	const projectedY: number[] = [];

	for (const point of offsets) {
		projectedX.push(point.x * cos + point.y * sin);
		projectedY.push(-point.x * sin + point.y * cos);
	}

	let radiusMajor = Math.max(1e-6, percentileAbsolute(projectedX, 0.88));
	let radiusMinor = Math.max(1e-6, percentileAbsolute(projectedY, 0.88));
	if (radiusMinor > radiusMajor) {
		[radiusMajor, radiusMinor] = [radiusMinor, radiusMajor];
		angle += Math.PI / 2;
	}

	return {
		angle,
		radiusMajor,
		radiusMinor,
		aspectRatio: radiusMajor / Math.max(radiusMinor, 1e-6),
		averageRadius: averageRadius(offsets),
		maxRadius: maxRadius(offsets)
	};
}

function rescaleOffsets(offsets: ProjectionCoordinate[], targetAverageRadius: number): ProjectionCoordinate[] {
	if (offsets.length === 0 || !(targetAverageRadius > 0)) return offsets;
	const currentAverageRadius = averageRadius(offsets);
	if (!(currentAverageRadius > 1e-6)) return offsets;
	const scale = targetAverageRadius / currentAverageRadius;
	return offsets.map((point) => ({
		x: point.x * scale,
		y: point.y * scale
	}));
}

function softenLinearOffsets(offsets: ProjectionCoordinate[], targetAverageRadius: number): ProjectionCoordinate[] {
	const shape = measureOffsetShape(offsets);
	if (!(shape.aspectRatio > TARGET_CLUSTER_ASPECT_RATIO)) {
		return offsets;
	}

	const pressure = clamp((shape.aspectRatio - TARGET_CLUSTER_ASPECT_RATIO) / 3.2, 0, 0.34);
	const angle = shape.angle;
	const cos = Math.cos(angle);
	const sin = Math.sin(angle);
	const softened = offsets.map((point) => {
		const major = point.x * cos + point.y * sin;
		const minor = -point.x * sin + point.y * cos;
		const nextMajor = major * (1 - pressure * 0.46);
		const nextMinor = minor * (1 + pressure);
		return {
			x: nextMajor * cos - nextMinor * sin,
			y: nextMajor * sin + nextMinor * cos
		};
	});

	return rescaleOffsets(softened, targetAverageRadius);
}

function capOffsetAspectRatio(
	offsets: ProjectionCoordinate[],
	targetAverageRadius: number
): ProjectionCoordinate[] {
	const shape = measureOffsetShape(offsets);
	if (!(shape.aspectRatio > MAX_CLUSTER_ASPECT_RATIO)) {
		return offsets;
	}

	const angle = shape.angle;
	const cos = Math.cos(angle);
	const sin = Math.sin(angle);
	const majorScale = Math.sqrt(MAX_CLUSTER_ASPECT_RATIO / shape.aspectRatio);
	const minorScale = 1 / Math.max(majorScale, 1e-6);
	const capped = offsets.map((point) => {
		const major = point.x * cos + point.y * sin;
		const minor = -point.x * sin + point.y * cos;
		const nextMajor = major * majorScale;
		const nextMinor = minor * minorScale;
		return {
			x: nextMajor * cos - nextMinor * sin,
			y: nextMajor * sin + nextMinor * cos
		};
	});

	return rescaleOffsets(capped, targetAverageRadius);
}

function buildBaseOffsets(points: ProjectionCoordinate[], centroid: ProjectionCoordinate): ProjectionCoordinate[] {
	return points.map((point) => ({
		x: point.x - centroid.x,
		y: point.y - centroid.y
	}));
}

function alignLocalOffsetsToBase(
	baseOffsets: ProjectionCoordinate[],
	localCoordinates: ProjectionCoordinate[],
	targetAverageRadius: number
): ProjectionCoordinate[] {
	const localCentroid = meanCoordinate(localCoordinates);
	const centeredLocal = localCoordinates.map((point) => ({
		x: point.x - localCentroid.x,
		y: point.y - localCentroid.y
	}));
	const baseShape = measureOffsetShape(baseOffsets);
	const localShape = measureOffsetShape(centeredLocal);
	const rotation = baseShape.angle - localShape.angle;
	const rotated = centeredLocal.map((point) => rotatePoint(point, rotation));

	let bestScore = Number.NEGATIVE_INFINITY;
	let best = rotated;
	for (const signX of [1, -1]) {
		for (const signY of [1, -1]) {
			const candidate = rotated.map((point) => ({
				x: point.x * signX,
				y: point.y * signY
			}));
			let score = 0;
			for (let index = 0; index < candidate.length; index += 1) {
				score +=
					(candidate[index]?.x ?? 0) * (baseOffsets[index]?.x ?? 0) +
					(candidate[index]?.y ?? 0) * (baseOffsets[index]?.y ?? 0);
			}
			if (score > bestScore) {
				bestScore = score;
				best = candidate;
			}
		}
	}

	return rescaleOffsets(best, targetAverageRadius);
}

function buildClusterOffsets(
	memberCoordinates: ProjectionCoordinate[],
	memberIndices: number[],
	normalizedVectors?: number[][]
): { offsets: ProjectionCoordinate[]; averageRadius: number; maxRadius: number } {
	const centroid = meanCoordinate(memberCoordinates);
	const baseOffsets = buildBaseOffsets(memberCoordinates, centroid);
	const baseShape = measureOffsetShape(baseOffsets);
	let offsets = baseOffsets;
	let usedLocalReprojection = false;

	if (normalizedVectors && memberIndices.length >= 3) {
		const memberVectors = memberIndices.map((index) => normalizedVectors[index]).filter(Boolean);
		if (memberVectors.length === memberIndices.length) {
			const localCoordinates = normalizeProjectionCoordinates(projectEmbeddingsRaw(memberVectors));
			const localOffsets = alignLocalOffsetsToBase(
				baseOffsets,
				localCoordinates,
				baseShape.averageRadius > 1e-6 ? baseShape.averageRadius : 1
			);
			const localBlend = clamp(
				LOCAL_BLEND_MIN + Math.max(0, baseShape.aspectRatio - 1.35) * 0.18,
				LOCAL_BLEND_MIN,
				LOCAL_BLEND_MAX
			);
			offsets = baseOffsets.map((basePoint, index) => ({
				x: basePoint.x * (1 - localBlend) + (localOffsets[index]?.x ?? 0) * localBlend,
				y: basePoint.y * (1 - localBlend) + (localOffsets[index]?.y ?? 0) * localBlend
			}));
			offsets = rescaleOffsets(
				offsets,
				baseShape.averageRadius > 1e-6 ? baseShape.averageRadius : averageRadius(offsets)
			);
			usedLocalReprojection = true;
		}
	}

	const targetAverageRadius =
		baseShape.averageRadius > 1e-6 ? baseShape.averageRadius : averageRadius(offsets);
	if (usedLocalReprojection || baseShape.aspectRatio > 4.4) {
		offsets = softenLinearOffsets(offsets, targetAverageRadius);
		offsets = capOffsetAspectRatio(offsets, targetAverageRadius);
	}

	return {
		offsets,
		averageRadius: averageRadius(offsets),
		maxRadius: maxRadius(offsets)
	};
}

function buildClusterAtlasStats(
	baseCoordinates: ProjectionCoordinate[],
	assignments: number[],
	clusterCenters: AtlasClusterCenter[],
	normalizedVectors?: number[][]
): ClusterAtlasStat[] {
	const membersByCluster = new Map<number, number[]>();
	for (let index = 0; index < assignments.length; index += 1) {
		const cluster = assignments[index] ?? 0;
		const existing = membersByCluster.get(cluster);
		if (existing) {
			existing.push(index);
		} else {
			membersByCluster.set(cluster, [index]);
		}
	}

	return clusterCenters
		.map((clusterCenter) => {
			const memberIndices = membersByCluster.get(clusterCenter.cluster) ?? [];
			if (memberIndices.length === 0) return null;
			const memberCoordinates = memberIndices.map((index) => baseCoordinates[index] ?? { x: 0, y: 0 });
			const centroid = meanCoordinate(memberCoordinates);
			const clusterOffsets = buildClusterOffsets(memberCoordinates, memberIndices, normalizedVectors);
			const threadCount = clusterCenter.threadCount ?? memberIndices.length;
			const extent = Math.max(
				MIN_REGION_RADIUS,
				clusterOffsets.maxRadius * 0.9 + clusterOffsets.averageRadius * 0.15 + 0.018
			);
			const spreadScale = clamp(
				BASE_SPREAD_SCALE + Math.log1p(threadCount) * 0.014,
				BASE_SPREAD_SCALE,
				MAX_SPREAD_SCALE
			);

			return {
				cluster: clusterCenter.cluster,
				center: clusterCenter.center,
				centroid,
				extent,
				threadCount,
				spreadScale,
				memberIndices,
				offsets: clusterOffsets.offsets
			};
		})
		.filter((stat): stat is ClusterAtlasStat => Boolean(stat))
		.sort((left, right) => left.cluster - right.cluster);
}

function relaxClusterAnchors(stats: ClusterAtlasStat[]): ProjectionCoordinate[] {
	if (stats.length <= 1) {
		return stats.map((stat) => ({ ...stat.centroid }));
	}

	const anchors = stats.map((stat) => ({ ...stat.centroid }));
	const velocities = stats.map(() => ({ x: 0, y: 0 }));
	const preferredUnits = stats.map((leftStat, leftIndex) =>
		stats.map((rightStat, rightIndex) => {
			if (leftIndex === rightIndex) {
				return { x: 0, y: 0 };
			}
			const dx = rightStat.centroid.x - leftStat.centroid.x;
			const dy = rightStat.centroid.y - leftStat.centroid.y;
			const distance = Math.hypot(dx, dy);
			if (distance > 1e-6) {
				return { x: dx / distance, y: dy / distance };
			}
			return stableUnitVector(leftIndex, rightIndex);
		})
	);
	const targetDistances = stats.map((leftStat, leftIndex) =>
		stats.map((rightStat, rightIndex) => {
			if (leftIndex === rightIndex) return 0;
			const originalDistance = Math.hypot(
				rightStat.centroid.x - leftStat.centroid.x,
				rightStat.centroid.y - leftStat.centroid.y
			);
			const minGap = leftStat.extent + rightStat.extent + CLUSTER_GAP_PADDING;
			return Math.max(minGap, originalDistance);
		})
	);

	for (let iteration = 0; iteration < ANCHOR_ITERATIONS; iteration += 1) {
		const cooling = 1 - iteration / (ANCHOR_ITERATIONS + 1);
		const forces = anchors.map(() => ({ x: 0, y: 0 }));

		for (let leftIndex = 0; leftIndex < stats.length; leftIndex += 1) {
			for (let rightIndex = leftIndex + 1; rightIndex < stats.length; rightIndex += 1) {
				const dx = anchors[rightIndex].x - anchors[leftIndex].x;
				const dy = anchors[rightIndex].y - anchors[leftIndex].y;
				const unit = preferredUnits[leftIndex][rightIndex] ?? stableUnitVector(leftIndex, rightIndex);
				const distance = dx * unit.x + dy * unit.y;
				const minGap = stats[leftIndex].extent + stats[rightIndex].extent + CLUSTER_GAP_PADDING;
				const targetDistance = Math.max(minGap, targetDistances[leftIndex][rightIndex] ?? minGap);
				let spring = (distance - targetDistance) * ANCHOR_ATTRACTION * cooling;

				if (distance < minGap) {
					spring -= (minGap - distance) * 0.22 * cooling;
				}

				forces[leftIndex].x += unit.x * spring;
				forces[leftIndex].y += unit.y * spring;
				forces[rightIndex].x -= unit.x * spring;
				forces[rightIndex].y -= unit.y * spring;
			}
		}

		let meanX = 0;
		let meanY = 0;
		for (let index = 0; index < stats.length; index += 1) {
			forces[index].x += (stats[index].centroid.x - anchors[index].x) * ANCHOR_TETHER * cooling;
			forces[index].y += (stats[index].centroid.y - anchors[index].y) * ANCHOR_TETHER * cooling;
			velocities[index].x = (velocities[index].x + forces[index].x) * ANCHOR_DAMPING;
			velocities[index].y = (velocities[index].y + forces[index].y) * ANCHOR_DAMPING;
			anchors[index].x += velocities[index].x;
			anchors[index].y += velocities[index].y;

			const displacementX = anchors[index].x - stats[index].centroid.x;
			const displacementY = anchors[index].y - stats[index].centroid.y;
			const displacement = Math.hypot(displacementX, displacementY);
			const maxDisplacement =
				stats[index].extent * MAX_ANCHOR_DISPLACEMENT_FACTOR + CLUSTER_GAP_PADDING;
			if (displacement > maxDisplacement) {
				const scale = maxDisplacement / displacement;
				anchors[index].x = stats[index].centroid.x + displacementX * scale;
				anchors[index].y = stats[index].centroid.y + displacementY * scale;
				velocities[index].x *= 0.5;
				velocities[index].y *= 0.5;
			}

			meanX += anchors[index].x;
			meanY += anchors[index].y;
		}

		meanX /= stats.length;
		meanY /= stats.length;
		for (const anchor of anchors) {
			anchor.x -= meanX;
			anchor.y -= meanY;
		}
	}

	return anchors;
}

export function buildAtlasRegions(
	coordinates: ProjectionCoordinate[],
	assignments: number[],
	threadCounts = new Map<number, number>()
): AtlasRegionLayout[] {
	const pointsByCluster = new Map<number, ProjectionCoordinate[]>();
	for (let index = 0; index < assignments.length; index += 1) {
		const cluster = assignments[index] ?? 0;
		const existing = pointsByCluster.get(cluster);
		if (existing) {
			existing.push(coordinates[index] ?? { x: 0, y: 0 });
		} else {
			pointsByCluster.set(cluster, [coordinates[index] ?? { x: 0, y: 0 }]);
		}
	}

	const clusterOrder = [...pointsByCluster.entries()]
		.map(([cluster, points]) => ({
			cluster,
			threadCount: threadCounts.get(cluster) ?? points.length
		}))
		.sort(
			(left, right) =>
				right.threadCount - left.threadCount || left.cluster - right.cluster
		);
	const labelRankByCluster = new Map(
		clusterOrder.map((entry, index) => [entry.cluster, index + 1] as const)
	);

	return [...pointsByCluster.entries()]
		.map(([cluster, points]) => {
			const centroid = meanCoordinate(points);
			let angle = computeAxisAngle(points, centroid);
			const cos = Math.cos(angle);
			const sin = Math.sin(angle);
			const projectedX: number[] = [];
			const projectedY: number[] = [];

			for (const point of points) {
				const dx = point.x - centroid.x;
				const dy = point.y - centroid.y;
				projectedX.push(dx * cos + dy * sin);
				projectedY.push(-dx * sin + dy * cos);
			}

			let radiusX = Math.max(MIN_REGION_RADIUS, percentileAbsolute(projectedX, 0.9) * 1.28 + 0.08);
			let radiusY = Math.max(MIN_REGION_RADIUS * 0.78, percentileAbsolute(projectedY, 0.9) * 1.28 + 0.07);
			if (radiusY > radiusX) {
				[radiusX, radiusY] = [radiusY, radiusX];
				angle += Math.PI / 2;
			}

			return {
				cluster,
				x: centroid.x,
				y: centroid.y,
				radiusX,
				radiusY,
				angle,
				labelRank: labelRankByCluster.get(cluster) ?? clusterOrder.length,
				threadCount: threadCounts.get(cluster) ?? points.length
			};
		})
		.sort((left, right) => left.cluster - right.cluster);
}

export function buildAtlasClusterLayout(
	baseCoordinates: ProjectionCoordinate[],
	assignments: number[],
	clusterCenters: AtlasClusterCenter[],
	normalizedVectors?: number[][]
): AtlasLayoutResult {
	if (baseCoordinates.length === 0) {
		return {
			coordinates: [],
			regions: []
		};
	}

	const stats = buildClusterAtlasStats(
		baseCoordinates,
		assignments,
		clusterCenters,
		normalizedVectors
	);
	if (stats.length === 0) {
		const coordinates = normalizeProjectionCoordinates(baseCoordinates);
		return {
			coordinates,
			regions: buildAtlasRegions(coordinates, assignments)
		};
	}

	const anchors = relaxClusterAnchors(stats);
	const rawCoordinates = baseCoordinates.map((point) => ({ ...point }));
	for (let statIndex = 0; statIndex < stats.length; statIndex += 1) {
		const stat = stats[statIndex];
		const anchor = anchors[statIndex] ?? stat.centroid;
		for (let memberIndex = 0; memberIndex < stat.memberIndices.length; memberIndex += 1) {
			const pointIndex = stat.memberIndices[memberIndex];
			const offset = stat.offsets[memberIndex] ?? { x: 0, y: 0 };
			rawCoordinates[pointIndex] = {
				x: anchor.x + offset.x * stat.spreadScale,
				y: anchor.y + offset.y * stat.spreadScale
			};
		}
	}

	const coordinates = normalizeProjectionCoordinates(rawCoordinates);
	const threadCounts = new Map(stats.map((stat) => [stat.cluster, stat.threadCount] as const));

	return {
		coordinates,
		regions: buildAtlasRegions(coordinates, assignments, threadCounts)
	};
}
