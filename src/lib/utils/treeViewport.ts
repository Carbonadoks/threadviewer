export type ViewRect = { x: number; y: number; width: number; height: number };

export function intersectsViewport(rect: ViewRect, viewport: ViewRect): boolean {
	return rect.x + rect.width >= viewport.x && rect.x <= viewport.x + viewport.width &&
		rect.y + rect.height >= viewport.y && rect.y <= viewport.y + viewport.height;
}

/** Overscan covers a full scroll bucket, avoiding DOM churn for every scroll pixel. */
export function treeViewport(left: number, top: number, width: number, height: number, zoom: number): ViewRect {
	const bucket = 256;
	const margin = 384;
	return {
		x: (Math.floor(left / bucket) * bucket - margin) / zoom,
		y: (Math.floor(top / bucket) * bucket - margin) / zoom,
		width: (width + bucket + margin * 2) / zoom,
		height: (height + bucket + margin * 2) / zoom
	};
}
