<script lang="ts">
	import type { ThreadPost } from '$lib/types';
	import { feedItemToPost } from '$lib/utils/threadWalker';
	import { buildBskyPostUrl } from '$lib/utils/viewerLinks';
	import PostEmbedPreview from '$lib/components/PostEmbedPreview.svelte';

	type EngagementCounts = {
		likeCount: number;
		repostCount: number;
		replyCount: number;
		quoteCount: number;
	};

	interface Props {
		feedItems: any[];
		engagementCountsByUri: Record<string, EngagementCounts>;
		hydrating?: boolean;
		hydrationProgress?: { current: number; total: number };
		onhydrate: (fromMs: number, toMs: number) => void;
		onselect?: (fromMs: number | null, toMs: number | null) => void;
		onopenpost?: (uri: string, handle: string) => void;
	}

	let {
		feedItems,
		engagementCountsByUri,
		hydrating = false,
		hydrationProgress = { current: 0, total: 0 },
		onhydrate,
		onselect,
		onopenpost
	}: Props = $props();

	const MARGIN = { top: 10, right: 16, bottom: 28, left: 44 };
	const HEIGHT = 170;

	let containerWidth = $state(800);
	let logScale = $state(true);
	// When locked, clicking empty space won't set/replace the date-range selection —
	// only clicking a point (to preview it) works.
	let locked = $state(false);

	// Selection in time-ms. null until user clicks.
	let selFrom = $state<number | null>(null);
	let selTo = $state<number | null>(null);

	type Point = {
		uri: string;
		handle: string;
		t: number;
		likes: number | null;
	};

	function postCreatedMs(item: any): number {
		const raw = item?.post?.record?.createdAt ?? item?.post?.indexedAt ?? '';
		const parsed = Date.parse(raw);
		return Number.isFinite(parsed) ? parsed : NaN;
	}

	const points = $derived.by<Point[]>(() => {
		const result: Point[] = [];
		const seen = new Set<string>();
		for (const item of feedItems) {
			const uri = item?.post?.uri;
			if (typeof uri !== 'string' || seen.has(uri)) continue;
			const t = postCreatedMs(item);
			if (!Number.isFinite(t)) continue;
			seen.add(uri);
			const counts = engagementCountsByUri[uri];
			result.push({
				uri,
				handle: item?.post?.author?.handle ?? '',
				t,
				likes: counts ? counts.likeCount : null
			});
		}
		return result;
	});

	const tDomain = $derived.by(() => {
		let min = Infinity;
		let max = -Infinity;
		for (const p of points) {
			if (p.t < min) min = p.t;
			if (p.t > max) max = p.t;
		}
		if (!Number.isFinite(min) || !Number.isFinite(max)) {
			const now = Date.now();
			return { min: now - 86_400_000, max: now };
		}
		if (min === max) return { min: min - 86_400_000, max: max + 86_400_000 };
		return { min, max };
	});

	const maxLikes = $derived.by(() => {
		let max = 0;
		for (const p of points) {
			if (p.likes != null && p.likes > max) max = p.likes;
		}
		return Math.max(max, 1);
	});

	const plotW = $derived(Math.max(10, containerWidth - MARGIN.left - MARGIN.right));
	const plotH = $derived(HEIGHT - MARGIN.top - MARGIN.bottom);

	// Zoomable/pannable visible time window. null => full domain.
	let viewStart = $state<number | null>(null);
	let viewEnd = $state<number | null>(null);
	const vMin = $derived(viewStart ?? tDomain.min);
	const vMax = $derived(viewEnd ?? tDomain.max);
	const isZoomed = $derived(viewStart != null || viewEnd != null);

	function xFor(t: number): number {
		return MARGIN.left + ((t - vMin) / (vMax - vMin)) * plotW;
	}

	function tForX(x: number): number {
		const ratio = Math.min(1, Math.max(0, (x - MARGIN.left) / plotW));
		return vMin + ratio * (vMax - vMin);
	}

	function clampX(x: number): number {
		return Math.min(MARGIN.left + plotW, Math.max(MARGIN.left, x));
	}

	function clampWindow(start: number, end: number): { start: number; end: number } {
		const span = end - start;
		const fullMin = tDomain.min;
		const fullMax = tDomain.max;
		let s = start;
		let e = end;
		if (s < fullMin) {
			s = fullMin;
			e = s + span;
		}
		if (e > fullMax) {
			e = fullMax;
			s = e - span;
		}
		if (s < fullMin) s = fullMin;
		return { start: s, end: e };
	}

	function zoomAt(cursorT: number, factor: number) {
		const fullSpan = tDomain.max - tDomain.min;
		const minSpan = Math.max(fullSpan / 20000, 60 * 60 * 1000); // never below ~1 hour
		let newSpan = (vMax - vMin) * factor;
		newSpan = Math.min(fullSpan, Math.max(minSpan, newSpan));
		const ratio = (cursorT - vMin) / (vMax - vMin);
		const { start, end } = clampWindow(cursorT - ratio * newSpan, cursorT - ratio * newSpan + newSpan);
		if (end - start >= fullSpan) {
			viewStart = null;
			viewEnd = null;
		} else {
			viewStart = start;
			viewEnd = end;
		}
		closePopup();
	}

	function resetZoom() {
		viewStart = null;
		viewEnd = null;
		monthAnchor = null;
		closePopup();
	}

	// --- Month mode: zoom to one month, pre-select it, jump month to month ---
	let monthAnchor = $state<number | null>(null); // ms at start of the active month

	function startOfMonthMs(ms: number): number {
		const d = new Date(ms);
		return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
	}
	function endOfMonthMs(ms: number): number {
		const d = new Date(ms);
		return new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime() - 1;
	}
	function addMonthsMs(ms: number, delta: number): number {
		const d = new Date(ms);
		return new Date(d.getFullYear(), d.getMonth() + delta, 1).getTime();
	}

	function applyMonth() {
		if (monthAnchor == null) return;
		const s = monthAnchor;
		const e = endOfMonthMs(monthAnchor);
		viewStart = s;
		viewEnd = e;
		selFrom = s;
		selTo = e;
		emitSelection();
		closePopup();
	}

	function enterMonthMode() {
		monthAnchor = startOfMonthMs(tDomain.max);
		applyMonth();
	}

	function shiftMonth(delta: number) {
		if (monthAnchor == null) return;
		const next = addMonthsMs(monthAnchor, delta);
		if (delta < 0 && endOfMonthMs(next) < tDomain.min) return;
		if (delta > 0 && next > tDomain.max) return;
		monthAnchor = next;
		applyMonth();
	}

	const canPrevMonth = $derived(
		monthAnchor != null && endOfMonthMs(addMonthsMs(monthAnchor, -1)) >= tDomain.min
	);
	const canNextMonth = $derived(monthAnchor != null && addMonthsMs(monthAnchor, 1) <= tDomain.max);
	const monthOptions = $derived.by(() => {
		const out: { ms: number; label: string }[] = [];
		if (!Number.isFinite(tDomain.min) || !Number.isFinite(tDomain.max)) return out;
		let cur = startOfMonthMs(tDomain.min);
		const end = startOfMonthMs(tDomain.max);
		let guard = 0;
		while (cur <= end && guard < 1200) {
			out.push({
				ms: cur,
				label: new Date(cur).toLocaleString(undefined, { month: 'short', year: 'numeric' })
			});
			cur = addMonthsMs(cur, 1);
			guard += 1;
		}
		return out;
	});

	function selectMonth(ms: number) {
		monthAnchor = ms;
		applyMonth();
	}

	function yFor(likes: number | null): number {
		const baseline = MARGIN.top + plotH;
		if (likes == null) return baseline;
		if (logScale) {
			const v = Math.log1p(likes) / Math.log1p(maxLikes);
			return baseline - v * plotH;
		}
		return baseline - (likes / maxLikes) * plotH;
	}

	const hydratedCount = $derived(points.filter((p) => p.likes != null).length);

	const inRangeUnhydrated = $derived.by(() => {
		if (selFrom == null || selTo == null) return 0;
		const lo = Math.min(selFrom, selTo);
		const hi = Math.max(selFrom, selTo);
		let n = 0;
		for (const p of points) {
			if (p.likes == null && p.t >= lo && p.t <= hi) n += 1;
		}
		return n;
	});

	let svgEl = $state<SVGSVGElement | null>(null);
	let pointerDown = false;
	let didPan = false;
	let dragStartClientX = 0;
	let dragStartWindow = { min: 0, max: 0 };

	function svgPoint(event: { clientX: number; clientY: number }): { x: number; y: number } {
		const rect = svgEl!.getBoundingClientRect();
		const scale = containerWidth / rect.width;
		return { x: (event.clientX - rect.left) * scale, y: (event.clientY - rect.top) * scale };
	}

	function nearestPoint(x: number, y: number) {
		let best: typeof points[number] | null = null;
		let bestDist = 256; // ~16px radius (squared)
		for (const p of points) {
			if (p.t < vMin || p.t > vMax) continue;
			const dx = xFor(p.t) - x;
			const dy = yFor(p.likes) - y;
			const d = dx * dx + dy * dy;
			if (d < bestDist) {
				bestDist = d;
				best = p;
			}
		}
		return best;
	}

	function handlePointerDown(event: PointerEvent) {
		if (!svgEl) return;
		pointerDown = true;
		didPan = false;
		dragStartClientX = event.clientX;
		dragStartWindow = { min: vMin, max: vMax };
		svgEl.setPointerCapture(event.pointerId);
	}

	function handlePointerMove(event: PointerEvent) {
		if (!pointerDown) return;
		const scale = containerWidth / svgEl!.getBoundingClientRect().width;
		const dxPx = (event.clientX - dragStartClientX) * scale;
		if (Math.abs(dxPx) > 4) {
			didPan = true;
			closePopup();
		}
		if (!didPan) return;
		const span = dragStartWindow.max - dragStartWindow.min;
		const dt = -(dxPx / plotW) * span;
		const { start, end } = clampWindow(dragStartWindow.min + dt, dragStartWindow.max + dt);
		viewStart = start;
		viewEnd = end;
	}

	function handlePointerUp(event: PointerEvent) {
		if (!pointerDown) return;
		pointerDown = false;
		svgEl?.releasePointerCapture(event.pointerId);
		if (didPan) {
			didPan = false;
			return;
		}
		// Treat as a click: open a post popup if one is near, else set a selection edge.
		const { x, y } = svgPoint(event);
		const hit = nearestPoint(x, y);
		if (hit) {
			openPopupForPoint(hit, x, y);
			return;
		}
		closePopup();
		if (locked) return; // selection locked — ignore empty-space clicks
		const t = tForX(x);
		if (selFrom == null || (selFrom != null && selTo != null)) {
			selFrom = t;
			selTo = null;
		} else {
			selTo = t;
		}
		emitSelection();
	}

	// --- Post popup ---
	const itemByUri = $derived.by(() => {
		const map = new Map<string, any>();
		for (const item of feedItems) {
			const uri = item?.post?.uri;
			if (typeof uri === 'string' && !map.has(uri)) map.set(uri, item);
		}
		return map;
	});

	let popupUri = $state<string | null>(null);
	let popupPost = $state<ThreadPost | null>(null);
	let popupX = $state(0);
	let popupY = $state(0);

	function openPopupForPoint(p: { uri: string }, x: number, y: number) {
		const item = itemByUri.get(p.uri);
		const post = item ? feedItemToPost(item) : null;
		if (!post) return;
		popupPost = post;
		popupUri = p.uri;
		// Keep the popup within the plot horizontally.
		popupX = Math.min(Math.max(x, 150), Math.max(150, containerWidth - 150));
		popupY = Math.max(8, y);
	}

	function closePopup() {
		popupUri = null;
		popupPost = null;
	}

	const popupCounts = $derived(popupUri ? engagementCountsByUri[popupUri] ?? null : null);

	// --- Scrollbar (pans the visible window) ---
	const fullSpan = $derived(Math.max(1, tDomain.max - tDomain.min));
	const thumbLeftPct = $derived(((vMin - tDomain.min) / fullSpan) * 100);
	const thumbWidthPct = $derived(Math.max(4, ((vMax - vMin) / fullSpan) * 100));

	let scrollTrackEl = $state<HTMLDivElement | null>(null);
	let scrollDragging = false;
	let scrollStartClientX = 0;
	let scrollStartWindow = { min: 0, max: 0 };

	function handleScrollPointerDown(event: PointerEvent) {
		if (!isZoomed || !scrollTrackEl) return;
		scrollDragging = true;
		scrollStartClientX = event.clientX;
		scrollStartWindow = { min: vMin, max: vMax };
		(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
		closePopup();
	}

	function handleScrollPointerMove(event: PointerEvent) {
		if (!scrollDragging || !scrollTrackEl) return;
		const trackW = scrollTrackEl.getBoundingClientRect().width || 1;
		const dt = ((event.clientX - scrollStartClientX) / trackW) * fullSpan;
		const { start, end } = clampWindow(scrollStartWindow.min + dt, scrollStartWindow.max + dt);
		viewStart = start;
		viewEnd = end;
	}

	function handleScrollPointerUp(event: PointerEvent) {
		if (!scrollDragging) return;
		scrollDragging = false;
		(event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId);
	}

	function emitSelection() {
		if (selFrom != null && selTo != null) {
			onselect?.(Math.min(selFrom, selTo), Math.max(selFrom, selTo));
		} else {
			onselect?.(null, null);
		}
	}

	function clearSelection() {
		selFrom = null;
		selTo = null;
		emitSelection();
	}

	function hydrateSelection() {
		if (selFrom == null || selTo == null) return;
		onhydrate(Math.min(selFrom, selTo), Math.max(selFrom, selTo));
	}

	function fmtDate(ms: number): string {
		return new Date(ms).toLocaleDateString(undefined, {
			year: 'numeric',
			month: 'short',
			day: 'numeric'
		});
	}

	// X axis ticks (~6 evenly spaced across the visible window)
	const xTicks = $derived.by(() => {
		const count = 6;
		const span = vMax - vMin;
		const withTime = span < 3 * 24 * 60 * 60 * 1000; // < 3 days: include time
		const ticks: { t: number; label: string }[] = [];
		for (let i = 0; i <= count; i += 1) {
			const t = vMin + (span * i) / count;
			ticks.push({
				t,
				label: withTime
					? new Date(t).toLocaleString(undefined, {
							month: 'short',
							day: 'numeric',
							hour: '2-digit'
						})
					: fmtDate(t)
			});
		}
		return ticks;
	});

	const yTicks = $derived.by(() => {
		const count = 4;
		const ticks: { likes: number }[] = [];
		for (let i = 0; i <= count; i += 1) {
			if (logScale) {
				const v = Math.expm1((Math.log1p(maxLikes) * i) / count);
				ticks.push({ likes: Math.round(v) });
			} else {
				ticks.push({ likes: Math.round((maxLikes * i) / count) });
			}
		}
		return ticks;
	});

	const selLo = $derived(selFrom != null && selTo != null ? Math.min(selFrom, selTo) : null);
	const selHi = $derived(selFrom != null && selTo != null ? Math.max(selFrom, selTo) : null);

	// Points are drawn on a canvas (not SVG) — thousands of DOM nodes lag badly.
	let canvasEl = $state<HTMLCanvasElement | null>(null);

	$effect(() => {
		const canvas = canvasEl;
		if (!canvas) return;
		// Track reactive deps so we redraw on change.
		const pts = points;
		const w = containerWidth;
		void plotW;
		void plotH;
		void maxLikes;
		void logScale;
		void tDomain;
		const lo = vMin;
		const hi = vMax;

		const dpr = window.devicePixelRatio || 1;
		canvas.width = Math.round(w * dpr);
		canvas.height = Math.round(HEIGHT * dpr);
		const ctx = canvas.getContext('2d');
		if (!ctx) return;
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.clearRect(0, 0, w, HEIGHT);

		const styles = getComputedStyle(canvas);
		const accent = styles.getPropertyValue('--accent').trim() || '#3b82f6';
		const ink = styles.getPropertyValue('--text-ink').trim() || '#222';

		// Un-hydrated first (faint baseline), hydrated on top.
		ctx.fillStyle = ink;
		ctx.globalAlpha = 0.22;
		for (const p of pts) {
			if (p.likes != null || p.t < lo || p.t > hi) continue;
			ctx.beginPath();
			ctx.arc(xFor(p.t), yFor(p.likes), 1.4, 0, Math.PI * 2);
			ctx.fill();
		}

		ctx.fillStyle = accent;
		ctx.globalAlpha = 0.75;
		for (const p of pts) {
			if (p.likes == null || p.t < lo || p.t > hi) continue;
			ctx.beginPath();
			ctx.arc(xFor(p.t), yFor(p.likes), 2.6, 0, Math.PI * 2);
			ctx.fill();
		}
		ctx.globalAlpha = 1;
	});
</script>

<div class="timeline-viewer wobbly-border-light" bind:clientWidth={containerWidth}>
	<div class="timeline-toolbar">
		<div class="timeline-info">
			<span>{points.length.toLocaleString()} posts</span>
			<span class="sep">·</span>
			<span>{hydratedCount.toLocaleString()} with likes</span>
		</div>
		<div class="timeline-controls">
			<button
				type="button"
				class="mini-btn"
				onclick={resetZoom}
				disabled={!isZoomed}
				title="Reset zoom"
			>
				Reset
			</button>
			<button
				type="button"
				class="mini-btn"
				onclick={() => zoomAt((vMin + vMax) / 2, 0.6)}
				title="Zoom in"
			>
				+
			</button>
			<button
				type="button"
				class="mini-btn"
				onclick={() => zoomAt((vMin + vMax) / 2, 1.6)}
				title="Zoom out"
			>
				−
			</button>
			{#if monthAnchor == null}
				<button type="button" class="mini-btn" onclick={enterMonthMode} title="Zoom to a month">
					Month
				</button>
			{:else}
				<span class="month-nav">
					<button
						type="button"
						class="mini-btn"
						onclick={() => shiftMonth(-1)}
						disabled={!canPrevMonth}
						title="Previous month"
					>
						◀
					</button>
					<select
						class="mini-btn month-select"
						value={monthAnchor}
						onchange={(e) => selectMonth(Number((e.currentTarget as HTMLSelectElement).value))}
						title="Jump to month"
					>
						{#each monthOptions as opt (opt.ms)}
							<option value={opt.ms}>{opt.label}</option>
						{/each}
					</select>
					<button
						type="button"
						class="mini-btn"
						onclick={() => shiftMonth(1)}
						disabled={!canNextMonth}
						title="Next month"
					>
						▶
					</button>
				</span>
			{/if}
			<button
				type="button"
				class="mini-btn"
				class:active={locked}
				onclick={() => (locked = !locked)}
				title={locked ? 'Unlock range selection' : 'Lock range selection (click only opens posts)'}
			>
				{locked ? '🔒 Locked' : '🔓 Lock'}
			</button>
			<button
				type="button"
				class="mini-btn"
				class:active={logScale}
				onclick={() => (logScale = !logScale)}
			>
				{logScale ? 'Log' : 'Linear'} scale
			</button>
		</div>
	</div>

	<div class="timeline-hint">
		{#if selFrom == null}
			Click a point to preview it · click empty space to set the range <strong>start</strong> · use +/− to zoom, the scrollbar or drag to pan.
		{:else if selTo == null}
			Now click empty space to set the range <strong>end</strong>.<br />
			Start: {fmtDate(selFrom)}
		{:else}
			Range: <strong>{fmtDate(selLo!)}</strong> → <strong>{fmtDate(selHi!)}</strong>
			· {inRangeUnhydrated.toLocaleString()} posts to hydrate
		{/if}
	</div>

	<div class="timeline-plot" style={`height:${HEIGHT}px`}>
	<canvas bind:this={canvasEl} class="timeline-canvas" style={`width:${containerWidth}px;height:${HEIGHT}px`}></canvas>
	<svg
		bind:this={svgEl}
		class="timeline-svg"
		class:panning={isZoomed}
		viewBox={`0 0 ${containerWidth} ${HEIGHT}`}
		width="100%"
		height={HEIGHT}
		onpointerdown={handlePointerDown}
		onpointermove={handlePointerMove}
		onpointerup={handlePointerUp}
		role="presentation"
	>
		<!-- y grid + labels -->
		{#each yTicks as tick, i (i)}
			<line
				x1={MARGIN.left}
				x2={MARGIN.left + plotW}
				y1={yFor(tick.likes)}
				y2={yFor(tick.likes)}
				class="grid-line"
			/>
			<text x={MARGIN.left - 8} y={yFor(tick.likes) + 4} class="axis-label" text-anchor="end">
				{tick.likes.toLocaleString()}
			</text>
		{/each}

		<!-- selection band (clamped to the visible plot area) -->
		{#if selLo != null && selHi != null}
			<rect
				x={clampX(xFor(selLo))}
				y={MARGIN.top}
				width={Math.max(0, clampX(xFor(selHi)) - clampX(xFor(selLo)))}
				height={plotH}
				class="selection-band"
			/>
		{/if}
		{#if selFrom != null && selFrom >= vMin && selFrom <= vMax}
			<line
				x1={xFor(selFrom)}
				x2={xFor(selFrom)}
				y1={MARGIN.top}
				y2={MARGIN.top + plotH}
				class="selection-edge"
			/>
		{/if}
		{#if selTo != null && selTo >= vMin && selTo <= vMax}
			<line
				x1={xFor(selTo)}
				x2={xFor(selTo)}
				y1={MARGIN.top}
				y2={MARGIN.top + plotH}
				class="selection-edge"
			/>
		{/if}

		<!-- x axis -->
		<line
			x1={MARGIN.left}
			x2={MARGIN.left + plotW}
			y1={MARGIN.top + plotH}
			y2={MARGIN.top + plotH}
			class="axis-line"
		/>
		{#each xTicks as tick, i (i)}
			<line
				x1={xFor(tick.t)}
				x2={xFor(tick.t)}
				y1={MARGIN.top + plotH}
				y2={MARGIN.top + plotH + 5}
				class="axis-line"
			/>
			<text x={xFor(tick.t)} y={MARGIN.top + plotH + 20} class="axis-label" text-anchor="middle">
				{tick.label}
			</text>
		{/each}
	</svg>

		{#if popupPost}
			<div class="timeline-popup" style={`left:${popupX}px;top:${popupY}px`} role="dialog">
				<button type="button" class="popup-close" onclick={closePopup} aria-label="Close">×</button>
				<div class="popup-head">
					{#if popupPost.author.avatar}
						<img class="popup-avatar" src={popupPost.author.avatar} alt="" />
					{/if}
					<div class="popup-author">
						<span class="popup-name">{popupPost.author.displayName || popupPost.author.handle}</span>
						<span class="popup-handle">@{popupPost.author.handle}</span>
					</div>
				</div>
				{#if popupPost.text}
					<p class="popup-text">{popupPost.text}</p>
				{/if}
				<div class="popup-embed">
					<PostEmbedPreview post={popupPost} compact eager />
				</div>
				<div class="popup-footer">
					<span class="popup-date">{fmtDate(Date.parse(popupPost.createdAt))}</span>
					{#if popupCounts}
						<span class="popup-stats">♥ {popupCounts.likeCount.toLocaleString()} · 🔁 {popupCounts.repostCount.toLocaleString()} · 💬 {popupCounts.replyCount.toLocaleString()}</span>
					{/if}
					<a
						class="popup-link"
						href={buildBskyPostUrl(popupPost.uri, popupPost.author.handle)}
						target="_blank"
						rel="noopener noreferrer"
					>
						Open ↗
					</a>
				</div>
			</div>
		{/if}
	</div>

	<div class="timeline-scrollbar" class:disabled={!isZoomed} bind:this={scrollTrackEl}>
		<div
			class="timeline-scroll-thumb"
			style={`left:${thumbLeftPct}%;width:${thumbWidthPct}%`}
			role="presentation"
			onpointerdown={handleScrollPointerDown}
			onpointermove={handleScrollPointerMove}
			onpointerup={handleScrollPointerUp}
		></div>
	</div>

	<div class="timeline-actions">
		<button
			type="button"
			class="hydrate-btn wobbly-border"
			disabled={hydrating || selFrom == null || selTo == null || inRangeUnhydrated === 0}
			onclick={hydrateSelection}
		>
			{#if hydrating}
				Hydrating {hydrationProgress.current.toLocaleString()}/{hydrationProgress.total.toLocaleString()}...
			{:else}
				Hydrate {inRangeUnhydrated.toLocaleString()} posts in range
			{/if}
		</button>
		<button
			type="button"
			class="clear-btn"
			disabled={selFrom == null && selTo == null}
			onclick={clearSelection}
		>
			Clear selection
		</button>
	</div>
</div>

<style>
	.timeline-viewer {
		background: var(--card-bg);
		padding: 14px 16px 16px;
		margin-top: 12px;
	}

	.timeline-toolbar {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 12px;
		flex-wrap: wrap;
	}

	.timeline-info {
		font-size: 0.85rem;
		color: var(--text-ink);
		opacity: 0.85;
	}

	.timeline-info .sep {
		margin: 0 6px;
		opacity: 0.5;
	}

	.mini-btn {
		padding: 3px 12px;
		font-size: 0.8rem;
		font-family: inherit;
		background: var(--card-bg);
		color: var(--text-ink);
		border: 1px solid var(--border-ink, #ccc);
		border-radius: 6px;
		cursor: pointer;
	}

	.mini-btn.active {
		background: var(--accent);
		color: white;
		border-color: var(--accent);
	}

	.mini-btn:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}

	.month-nav {
		display: inline-flex;
		gap: 2px;
		align-items: center;
	}

	.month-select {
		min-width: 92px;
		appearance: auto;
	}

	.timeline-hint {
		font-size: 0.8rem;
		color: var(--text-ink);
		opacity: 0.8;
		margin: 8px 0;
		min-height: 2.4em;
		line-height: 1.3;
	}

	.timeline-plot {
		position: relative;
		width: 100%;
	}

	.timeline-canvas {
		position: absolute;
		inset: 0;
		pointer-events: none;
	}

	.timeline-svg {
		position: relative;
		display: block;
		width: 100%;
		cursor: crosshair;
		user-select: none;
		touch-action: none;
	}

	.timeline-svg.panning {
		cursor: grab;
	}

	.timeline-svg.panning:active {
		cursor: grabbing;
	}

	.timeline-popup {
		position: absolute;
		transform: translate(-50%, 8px);
		width: 280px;
		max-width: calc(100% - 16px);
		background: var(--card-bg);
		border: 1px solid var(--border-ink, #ccc);
		border-radius: 10px;
		box-shadow: 0 8px 28px rgba(0, 0, 0, 0.22);
		padding: 10px 12px 12px;
		z-index: 20;
		font-family: inherit;
	}

	.popup-close {
		position: absolute;
		top: 4px;
		right: 6px;
		border: none;
		background: transparent;
		font-size: 1.1rem;
		line-height: 1;
		cursor: pointer;
		color: var(--text-ink);
		opacity: 0.6;
	}

	.popup-close:hover {
		opacity: 1;
	}

	.popup-head {
		display: flex;
		align-items: center;
		gap: 8px;
		padding-right: 16px;
	}

	.popup-avatar {
		width: 28px;
		height: 28px;
		border-radius: 50%;
		object-fit: cover;
		flex-shrink: 0;
	}

	.popup-author {
		display: flex;
		flex-direction: column;
		min-width: 0;
	}

	.popup-name {
		font-weight: 600;
		font-size: 0.85rem;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.popup-handle {
		font-size: 0.75rem;
		opacity: 0.7;
	}

	.popup-text {
		margin: 8px 0;
		font-size: 0.9rem;
		white-space: pre-wrap;
		word-break: break-word;
		max-height: 160px;
		overflow-y: auto;
	}

	.popup-embed {
		max-height: 220px;
		overflow: hidden;
	}

	.popup-footer {
		display: flex;
		align-items: center;
		gap: 8px;
		flex-wrap: wrap;
		margin-top: 8px;
		font-size: 0.75rem;
		opacity: 0.85;
	}

	.popup-link {
		margin-left: auto;
		color: var(--accent);
		text-decoration: none;
	}

	.timeline-scrollbar {
		position: relative;
		height: 12px;
		margin-top: 6px;
		background: var(--border-ink, #e2e2e2);
		border-radius: 6px;
		opacity: 0.9;
	}

	.timeline-scrollbar.disabled {
		opacity: 0.4;
	}

	.timeline-scroll-thumb {
		position: absolute;
		top: 1px;
		bottom: 1px;
		min-width: 24px;
		background: var(--accent);
		border-radius: 6px;
		cursor: grab;
		touch-action: none;
	}

	.timeline-scrollbar.disabled .timeline-scroll-thumb {
		cursor: default;
	}

	.timeline-scroll-thumb:active {
		cursor: grabbing;
	}

	.grid-line {
		stroke: var(--border-ink, #ddd);
		stroke-width: 1;
		opacity: 0.3;
	}

	.axis-line {
		stroke: var(--text-ink);
		stroke-width: 1;
		opacity: 0.6;
	}

	.axis-label {
		fill: var(--text-ink);
		font-size: 11px;
		opacity: 0.7;
		font-family: inherit;
	}

	.selection-band {
		fill: var(--accent);
		opacity: 0.12;
		pointer-events: none;
	}

	.selection-edge {
		stroke: var(--accent);
		stroke-width: 1.5;
		stroke-dasharray: 4 3;
		pointer-events: none;
	}

	.timeline-actions {
		display: flex;
		gap: 10px;
		align-items: center;
		margin-top: 12px;
		flex-wrap: wrap;
	}

	.hydrate-btn {
		padding: 6px 18px;
		font-size: 0.9rem;
		font-family: inherit;
		background: var(--accent);
		color: white;
		cursor: pointer;
	}

	.hydrate-btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.clear-btn {
		padding: 6px 14px;
		font-size: 0.85rem;
		font-family: inherit;
		background: transparent;
		color: var(--text-ink);
		border: none;
		text-decoration: underline;
		cursor: pointer;
	}

	.clear-btn:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}
</style>
