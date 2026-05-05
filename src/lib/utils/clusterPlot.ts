import { isRenderableClusterCoordinate } from './clusterProjection';

export interface ClusterPointColumnsLike {
	count: number;
	x: ArrayLike<number>;
	y: ArrayLike<number>;
	clusters: ArrayLike<number>;
}

export interface ClusterViewport {
	width: number;
	height: number;
	zoom: number;
	panX: number;
	panY: number;
}

export interface ClusterWorldBounds {
	minX: number;
	maxX: number;
	minY: number;
	maxY: number;
}

export interface ClusterRenderedPoint {
	index: number;
	cluster: number;
	worldX: number;
	worldY: number;
	screenX: number;
	screenY: number;
	selected: boolean;
	active: boolean;
	hovered: boolean;
}

export interface ClusterRenderedLabel {
	cluster: number;
	worldX: number;
	worldY: number;
	screenX: number;
	screenY: number;
	labelRank: number;
	visible: boolean;
}

export interface ClusterRegionLike {
	cluster: number;
	region: {
		x: number;
		y: number;
		labelRank: number;
	};
}

export interface ClusterSpatialIndex {
	cellSizeWorld: number;
	yDirection: 1 | -1;
	buckets: Map<string, number[]>;
}

export interface ClusterHitTestResult {
	index: number;
	cluster: number;
	worldX: number;
	worldY: number;
	distanceSquared: number;
}

export interface BuildRenderedClusterPointOptions {
	activeCluster?: number | null;
	selectedIndex?: number | null;
	hoveredIndex?: number | null;
	paddingPx?: number;
	yDirection?: 1 | -1;
	includeOffscreen?: boolean;
}

export interface BuildRenderedClusterLabelOptions {
	fitZoom: number;
	paddingPx?: number;
	yDirection?: 1 | -1;
	baseVisibleCount?: number;
	maxVisibleCount?: number;
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

export function worldToScreen(
	viewport: ClusterViewport,
	worldX: number,
	worldY: number
): { x: number; y: number } {
	return {
		x: worldX * viewport.zoom + viewport.panX,
		y: worldY * viewport.zoom + viewport.panY
	};
}

export function screenToWorld(
	viewport: ClusterViewport,
	screenX: number,
	screenY: number
): { x: number; y: number } | null {
	if (viewport.zoom <= 0) return null;
	return {
		x: (screenX - viewport.panX) / viewport.zoom,
		y: (screenY - viewport.panY) / viewport.zoom
	};
}

export function screenRadiusToWorld(
	viewport: ClusterViewport,
	radiusPx: number
): number {
	if (viewport.zoom <= 0) return Number.POSITIVE_INFINITY;
	return Math.max(0, radiusPx / viewport.zoom);
}

export function getClusterWorldBounds(
	points: ClusterPointColumnsLike,
	yDirection: 1 | -1 = 1
): ClusterWorldBounds {
	if (points.count === 0) {
		return {
			minX: -1,
			maxX: 1,
			minY: -1,
			maxY: 1
		};
	}

	let minX = Number.POSITIVE_INFINITY;
	let maxX = Number.NEGATIVE_INFINITY;
	let minY = Number.POSITIVE_INFINITY;
	let maxY = Number.NEGATIVE_INFINITY;

	for (let index = 0; index < points.count; index += 1) {
		const worldX = points.x[index] ?? 0;
		const worldY = (points.y[index] ?? 0) * yDirection;
		if (!isRenderableClusterCoordinate(worldX) || !isRenderableClusterCoordinate(worldY)) {
			continue;
		}
		minX = Math.min(minX, worldX);
		maxX = Math.max(maxX, worldX);
		minY = Math.min(minY, worldY);
		maxY = Math.max(maxY, worldY);
	}

	if (
		!Number.isFinite(minX) ||
		!Number.isFinite(maxX) ||
		!Number.isFinite(minY) ||
		!Number.isFinite(maxY)
	) {
		return {
			minX: -1,
			maxX: 1,
			minY: -1,
			maxY: 1
		};
	}

	return { minX, maxX, minY, maxY };
}

export function buildRenderedClusterPoints(
	points: ClusterPointColumnsLike,
	viewport: ClusterViewport,
	options: BuildRenderedClusterPointOptions = {}
): ClusterRenderedPoint[] {
	if (points.count === 0 || viewport.width <= 0 || viewport.height <= 0 || viewport.zoom <= 0) {
		return [];
	}

	const paddingPx = Math.max(0, options.paddingPx ?? 24);
	const yDirection = options.yDirection ?? 1;
	const activeCluster = options.activeCluster ?? null;
	const selectedIndex = options.selectedIndex ?? null;
	const hoveredIndex = options.hoveredIndex ?? null;
	const includeOffscreen = options.includeOffscreen === true;
	const rendered: ClusterRenderedPoint[] = [];

	for (let index = 0; index < points.count; index += 1) {
		const worldX = points.x[index] ?? 0;
		const worldY = (points.y[index] ?? 0) * yDirection;
		if (!isRenderableClusterCoordinate(worldX) || !isRenderableClusterCoordinate(worldY)) {
			continue;
		}

		const screen = worldToScreen(viewport, worldX, worldY);
		if (
			!includeOffscreen &&
			(screen.x < -paddingPx ||
				screen.y < -paddingPx ||
				screen.x > viewport.width + paddingPx ||
				screen.y > viewport.height + paddingPx)
		) {
			continue;
		}

		const cluster = points.clusters[index] ?? 0;
		rendered.push({
			index,
			cluster,
			worldX,
			worldY,
			screenX: screen.x,
			screenY: screen.y,
			selected: selectedIndex === index,
			active: activeCluster !== null && cluster === activeCluster,
			hovered: hoveredIndex === index
		});
	}

	return rendered;
}

function bucketKey(cellX: number, cellY: number): string {
	return `${cellX}:${cellY}`;
}

function deriveCellSizeWorld(
	points: ClusterPointColumnsLike,
	yDirection: 1 | -1
): number {
	const bounds = getClusterWorldBounds(points, yDirection);
	const width = Math.max(1e-6, bounds.maxX - bounds.minX);
	const height = Math.max(1e-6, bounds.maxY - bounds.minY);
	return Math.max(0.025, Math.max(width, height) / 52);
}

export function createClusterSpatialIndex(
	points: ClusterPointColumnsLike,
	options: {
		cellSizeWorld?: number;
		yDirection?: 1 | -1;
	} = {}
): ClusterSpatialIndex {
	const yDirection = options.yDirection ?? 1;
	const cellSizeWorld = Math.max(1e-6, options.cellSizeWorld ?? deriveCellSizeWorld(points, yDirection));
	const buckets = new Map<string, number[]>();

	for (let index = 0; index < points.count; index += 1) {
		const worldX = points.x[index] ?? 0;
		const worldY = (points.y[index] ?? 0) * yDirection;
		if (!isRenderableClusterCoordinate(worldX) || !isRenderableClusterCoordinate(worldY)) {
			continue;
		}
		const cellX = Math.floor(worldX / cellSizeWorld);
		const cellY = Math.floor(worldY / cellSizeWorld);
		const key = bucketKey(cellX, cellY);
		const existing = buckets.get(key);
		if (existing) {
			existing.push(index);
		} else {
			buckets.set(key, [index]);
		}
	}

	return {
		cellSizeWorld,
		yDirection,
		buckets
	};
}

export function hitTestClusterSpatialIndex(
	points: ClusterPointColumnsLike,
	index: ClusterSpatialIndex,
	queryWorldX: number,
	queryWorldY: number,
	radiusWorld: number
): ClusterHitTestResult | null {
	if (points.count === 0 || !(radiusWorld >= 0) || !Number.isFinite(radiusWorld)) return null;
	const searchRadius = Math.max(radiusWorld, 1e-6);
	const minCellX = Math.floor((queryWorldX - searchRadius) / index.cellSizeWorld);
	const maxCellX = Math.floor((queryWorldX + searchRadius) / index.cellSizeWorld);
	const minCellY = Math.floor((queryWorldY - searchRadius) / index.cellSizeWorld);
	const maxCellY = Math.floor((queryWorldY + searchRadius) / index.cellSizeWorld);
	const radiusSquared = searchRadius * searchRadius;
	let best: ClusterHitTestResult | null = null;

	for (let cellX = minCellX; cellX <= maxCellX; cellX += 1) {
		for (let cellY = minCellY; cellY <= maxCellY; cellY += 1) {
			const bucket = index.buckets.get(bucketKey(cellX, cellY)) ?? [];
			for (const pointIndex of bucket) {
				const worldX = points.x[pointIndex] ?? 0;
				const worldY = (points.y[pointIndex] ?? 0) * index.yDirection;
				const dx = worldX - queryWorldX;
				const dy = worldY - queryWorldY;
				const distanceSquared = dx * dx + dy * dy;
				if (distanceSquared > radiusSquared) continue;
				if (best && distanceSquared >= best.distanceSquared) continue;
				best = {
					index: pointIndex,
					cluster: points.clusters[pointIndex] ?? 0,
					worldX,
					worldY,
					distanceSquared
				};
			}
		}
	}

	return best;
}

export function buildRenderedClusterLabels(
	clusters: ClusterRegionLike[],
	viewport: ClusterViewport,
	options: BuildRenderedClusterLabelOptions
): ClusterRenderedLabel[] {
	const paddingPx = Math.max(0, options.paddingPx ?? 56);
	const yDirection = options.yDirection ?? 1;
	const clusterCount = clusters.length;
	const baseVisibleCount =
		options.baseVisibleCount ?? Math.max(3, Math.min(clusterCount, Math.ceil(clusterCount * 0.45)));
	const maxVisibleCount = options.maxVisibleCount ?? clusterCount;
	const zoomRatio = options.fitZoom > 0 ? viewport.zoom / options.fitZoom : 1;
	const extraVisible = zoomRatio <= 1 ? 0 : Math.floor((zoomRatio - 1) / 0.35);
	const visibleCount = clamp(baseVisibleCount + extraVisible, baseVisibleCount, maxVisibleCount);

	return clusters.map((cluster) => {
		const worldX = cluster.region.x;
		const worldY = cluster.region.y * yDirection;
		const screen = worldToScreen(viewport, worldX, worldY);
		return {
			cluster: cluster.cluster,
			worldX,
			worldY,
			screenX: screen.x,
			screenY: screen.y,
			labelRank: cluster.region.labelRank,
			visible:
				cluster.region.labelRank <= visibleCount &&
				screen.x >= -paddingPx &&
				screen.y >= -paddingPx &&
				screen.x <= viewport.width + paddingPx &&
				screen.y <= viewport.height + paddingPx
		};
	});
}
