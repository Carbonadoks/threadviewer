<script lang="ts">
	type EngagementCounts = {
		likeCount: number;
		repostCount: number;
		replyCount: number;
		quoteCount: number;
	};

	interface Props {
		feedItems?: any[];
		engagementCountsByUri: Record<string, EngagementCounts>;
		// Active date filter as YYYY-MM-DD strings ('' = open-ended).
		selectedFrom?: string;
		selectedTo?: string;
		onselect?: (fromMs: number | null, toMs: number | null) => void;
		// When set, clicking the header hides the heatmap.
		oncollapse?: () => void;
	}

	let {
		feedItems = [],
		engagementCountsByUri,
		selectedFrom = '',
		selectedTo = '',
		onselect,
		oncollapse
	}: Props = $props();

	type Mode = 'calendar' | 'hours';
	type Metric = 'posts' | 'likes';

	let mode = $state<Mode>('calendar');
	let metric = $state<Metric>('posts');

	// Calendar geometry (SVG units; the SVG scales down to fit its container).
	const CELL = 12;
	const STEP = CELL + 2;
	const CAL_COLS = 54; // max week columns a year can span
	const DAY_LABEL_W = 28;
	const MONTH_LABEL_H = 14;
	const CAL_W = DAY_LABEL_W + CAL_COLS * STEP;
	const CAL_H = MONTH_LABEL_H + 7 * STEP;

	// Day × hour geometry.
	const HOUR_CELL = 22;
	const HOUR_STEP = HOUR_CELL + 3;
	const HOUR_LABEL_W = 34;
	const HOUR_LABEL_H = 16;
	const HOURS_W = HOUR_LABEL_W + 24 * HOUR_STEP;
	const HOURS_H = HOUR_LABEL_H + 7 * HOUR_STEP;

	function pad2(n: number): string {
		return String(n).padStart(2, '0');
	}

	function dayKeyOf(d: Date): string {
		return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
	}

	function parseKey(key: string): [number, number, number] {
		const [y, m, d] = key.split('-').map(Number);
		return [y, m - 1, d];
	}

	// Integer day number, DST-safe, for streak math.
	function dayNumber(y: number, m: number, d: number): number {
		return Math.round(Date.UTC(y, m, d) / 86_400_000);
	}

	type Entry = { uri: string; key: string; year: number; dow: number; hour: number };

	// Posts are bucketed in the viewer's local time zone.
	const entries = $derived.by<Entry[]>(() => {
		const out: Entry[] = [];
		const seen = new Set<string>();
		for (const item of feedItems) {
			const uri = item?.post?.uri;
			if (typeof uri !== 'string' || seen.has(uri)) continue;
			const t = Date.parse(item?.post?.record?.createdAt ?? item?.post?.indexedAt ?? '');
			if (!Number.isFinite(t)) continue;
			seen.add(uri);
			const d = new Date(t);
			out.push({ uri, key: dayKeyOf(d), year: d.getFullYear(), dow: d.getDay(), hour: d.getHours() });
		}
		return out;
	});

	const hydratedCount = $derived(
		entries.reduce((n, e) => n + (engagementCountsByUri[e.uri] ? 1 : 0), 0)
	);

	type Bucket = { posts: number; likes: number };
	const EMPTY_BUCKET: Bucket = { posts: 0, likes: 0 };

	function valueOf(b: Bucket | undefined): number {
		if (!b) return 0;
		return metric === 'likes' ? b.likes : b.posts;
	}

	// 0 = empty, 1..4 = log-scaled intensity relative to the max value.
	function levelFor(value: number, max: number): number {
		if (value <= 0 || max <= 0) return 0;
		return Math.max(1, Math.min(4, Math.ceil((4 * Math.log1p(value)) / Math.log1p(max))));
	}

	const hasRange = $derived(Boolean(selectedFrom || selectedTo));

	function inRange(key: string): boolean {
		if (selectedFrom && key < selectedFrom) return false;
		if (selectedTo && key > selectedTo) return false;
		return true;
	}

	const byDay = $derived.by(() => {
		const map = new Map<string, Bucket>();
		for (const e of entries) {
			let b = map.get(e.key);
			if (!b) {
				b = { posts: 0, likes: 0 };
				map.set(e.key, b);
			}
			b.posts += 1;
			b.likes += engagementCountsByUri[e.uri]?.likeCount ?? 0;
		}
		return map;
	});

	type DayCell = { key: string; col: number; row: number; value: number };
	type YearBlock = {
		year: number;
		cells: DayCell[];
		months: { col: number; label: string }[];
		posts: number;
		likes: number;
	};

	// One block per year that has posts, newest first (skips empty years from bogus createdAt).
	const years = $derived.by<YearBlock[]>(() => {
		const yearSet = new Set<number>();
		for (const e of entries) yearSet.add(e.year);
		const blocks: YearBlock[] = [];
		for (const year of [...yearSet].sort((a, b) => b - a)) {
			const jan1Dow = new Date(year, 0, 1).getDay();
			const daysInYear = dayNumber(year + 1, 0, 1) - dayNumber(year, 0, 1);
			const cells: DayCell[] = [];
			const months: YearBlock['months'] = [];
			let posts = 0;
			let likes = 0;
			for (let i = 0; i < daysInYear; i += 1) {
				const d = new Date(year, 0, 1 + i);
				const key = dayKeyOf(d);
				const b = byDay.get(key);
				const col = Math.floor((i + jan1Dow) / 7);
				if (d.getDate() === 1) {
					months.push({ col, label: d.toLocaleString(undefined, { month: 'short' }) });
				}
				cells.push({ key, col, row: d.getDay(), value: valueOf(b) });
				posts += b?.posts ?? 0;
				likes += b?.likes ?? 0;
			}
			blocks.push({ year, cells, months, posts, likes });
		}
		return blocks;
	});

	const dayMax = $derived(
		years.reduce((max, y) => y.cells.reduce((m, c) => Math.max(m, c.value), max), 0)
	);

	const daySummary = $derived.by(() => {
		let busiestKey = '';
		let busiestValue = 0;
		const dayNums: number[] = [];
		for (const [key, b] of byDay) {
			const v = valueOf(b);
			if (v > busiestValue) {
				busiestValue = v;
				busiestKey = key;
			}
			dayNums.push(dayNumber(...parseKey(key)));
		}
		dayNums.sort((a, b) => a - b);
		let longest = 0;
		let run = 0;
		let prev = NaN;
		for (const n of dayNums) {
			run = n === prev + 1 ? run + 1 : 1;
			if (run > longest) longest = run;
			prev = n;
		}
		return { activeDays: byDay.size, longest, busiestKey, busiestValue };
	});

	// Day-of-week × hour grid, restricted to the active date filter.
	const hourGrid = $derived.by<Bucket[]>(() => {
		const cells = Array.from({ length: 7 * 24 }, () => ({ posts: 0, likes: 0 }));
		for (const e of entries) {
			if (hasRange && !inRange(e.key)) continue;
			const b = cells[e.dow * 24 + e.hour];
			b.posts += 1;
			b.likes += engagementCountsByUri[e.uri]?.likeCount ?? 0;
		}
		return cells;
	});

	const hourMax = $derived(hourGrid.reduce((m, b) => Math.max(m, valueOf(b)), 0));

	const busiestSlot = $derived.by(() => {
		let idx = -1;
		let max = 0;
		hourGrid.forEach((b, i) => {
			const v = valueOf(b);
			if (v > max) {
				max = v;
				idx = i;
			}
		});
		return idx < 0 ? null : { dow: Math.floor(idx / 24), hour: idx % 24, value: max };
	});

	const hourPostTotal = $derived(hourGrid.reduce((n, b) => n + b.posts, 0));

	function weekdayName(dow: number, style: 'short' | 'long' = 'short'): string {
		// 2024-01-07 was a Sunday.
		return new Date(2024, 0, 7 + dow).toLocaleDateString(undefined, { weekday: style });
	}

	function fmtDay(key: string): string {
		const [y, m, d] = parseKey(key);
		return new Date(y, m, d).toLocaleDateString(undefined, {
			weekday: 'short',
			year: 'numeric',
			month: 'short',
			day: 'numeric'
		});
	}

	function fmtHour(h: number): string {
		return `${pad2(h)}:00`;
	}

	function fmtMetric(value: number): string {
		return `${value.toLocaleString()} ${metric === 'likes' ? 'likes' : value === 1 ? 'post' : 'posts'}`;
	}

	function describe(b: Bucket): string {
		const parts = [`${b.posts.toLocaleString()} post${b.posts === 1 ? '' : 's'}`];
		if (hydratedCount > 0) parts.push(`${b.likes.toLocaleString()} likes`);
		return parts.join(' · ');
	}

	// --- Selection (drives the page's date filter) ---
	let anchorKey = $state<string | null>(null);

	function keyStartMs(key: string): number {
		const [y, m, d] = parseKey(key);
		return new Date(y, m, d).getTime();
	}

	function keyEndMs(key: string): number {
		const [y, m, d] = parseKey(key);
		return new Date(y, m, d + 1).getTime() - 1;
	}

	function selectDay(key: string, extend: boolean) {
		if (extend && anchorKey) {
			const lo = anchorKey < key ? anchorKey : key;
			const hi = anchorKey < key ? key : anchorKey;
			onselect?.(keyStartMs(lo), keyEndMs(hi));
			return;
		}
		if (selectedFrom === key && selectedTo === key) {
			clearSelection();
			return;
		}
		anchorKey = key;
		onselect?.(keyStartMs(key), keyEndMs(key));
	}

	function selectYear(year: number) {
		anchorKey = null;
		onselect?.(new Date(year, 0, 1).getTime(), new Date(year + 1, 0, 1).getTime() - 1);
	}

	function clearSelection() {
		anchorKey = null;
		onselect?.(null, null);
	}

	// --- Hover tooltip ---
	let bodyEl = $state<HTMLDivElement | null>(null);
	let hover = $state<{ key: string; x: number; y: number } | null>(null);

	function cellFromEvent(event: Event): SVGRectElement | null {
		const target = event.target;
		return target instanceof SVGRectElement && target.dataset.cell ? target : null;
	}

	function handleCellHover(event: PointerEvent) {
		const el = cellFromEvent(event);
		if (!el || !bodyEl) {
			hover = null;
			return;
		}
		const box = bodyEl.getBoundingClientRect();
		const r = el.getBoundingClientRect();
		const half = 110;
		const x = Math.min(Math.max(r.left + r.width / 2 - box.left, half), Math.max(half, box.width - half));
		hover = { key: el.dataset.cell!, x, y: r.top - box.top };
	}

	function handleCalendarPointerUp(event: PointerEvent) {
		if (event.button !== 0) return;
		const el = cellFromEvent(event);
		if (el) selectDay(el.dataset.cell!, event.shiftKey);
	}

	const hoverText = $derived.by(() => {
		if (!hover) return '';
		if (hover.key.startsWith('h:')) {
			const idx = Number(hover.key.slice(2));
			const dow = Math.floor(idx / 24);
			const hour = idx % 24;
			return `${weekdayName(dow, 'long')} ${fmtHour(hour)}–${fmtHour((hour + 1) % 24)} — ${describe(hourGrid[idx] ?? EMPTY_BUCKET)}`;
		}
		return `${fmtDay(hover.key)} — ${describe(byDay.get(hover.key) ?? EMPTY_BUCKET)}`;
	});

	$effect(() => {
		// Drop a stale tooltip when the view changes under it.
		void mode;
		hover = null;
	});

	$effect(() => {
		if (hydratedCount === 0 && metric === 'likes') metric = 'posts';
	});
</script>

<div class="heatmap wobbly-border-light">
	<div class="heatmap-toolbar">
		{#snippet infoContent()}
			{#if mode === 'calendar'}
				<span>{entries.length.toLocaleString()} posts</span>
				<span class="sep">·</span>
				<span>{daySummary.activeDays.toLocaleString()} active days</span>
				<span class="sep">·</span>
				<span>longest streak {daySummary.longest.toLocaleString()}d</span>
				{#if daySummary.busiestKey}
					<span class="sep">·</span>
					<span>busiest {fmtDay(daySummary.busiestKey)} ({fmtMetric(daySummary.busiestValue)})</span>
				{/if}
			{:else}
				<span>{hourPostTotal.toLocaleString()} posts{hasRange ? ' in selected dates' : ''}</span>
				{#if busiestSlot}
					<span class="sep">·</span>
					<span>
						busiest {weekdayName(busiestSlot.dow)} {fmtHour(busiestSlot.hour)} ({fmtMetric(busiestSlot.value)})
					</span>
				{/if}
			{/if}
		{/snippet}
		{#if oncollapse}
			<button type="button" class="heatmap-info collapsible" onclick={oncollapse} title="Hide heatmap">
				<span class="collapse-caret">▾</span>
				{@render infoContent()}
			</button>
		{:else}
			<div class="heatmap-info">{@render infoContent()}</div>
		{/if}
		<div class="heatmap-controls">
			<div class="seg" role="group" aria-label="Heatmap view">
				<button
					type="button"
					class="mini-btn"
					class:active={mode === 'calendar'}
					onclick={() => (mode = 'calendar')}
				>
					Calendar
				</button>
				<button
					type="button"
					class="mini-btn"
					class:active={mode === 'hours'}
					onclick={() => (mode = 'hours')}
				>
					Day × hour
				</button>
			</div>
			<div class="seg" role="group" aria-label="Heatmap metric">
				<button
					type="button"
					class="mini-btn"
					class:active={metric === 'posts'}
					onclick={() => (metric = 'posts')}
				>
					Posts
				</button>
				<button
					type="button"
					class="mini-btn"
					class:active={metric === 'likes'}
					disabled={hydratedCount === 0}
					title={hydratedCount === 0
						? 'Hydrate engagement to color by likes'
						: `Likes from ${hydratedCount.toLocaleString()} hydrated posts`}
					onclick={() => (metric = 'likes')}
				>
					Likes
				</button>
			</div>
		</div>
	</div>

	<div class="heatmap-hint">
		{#if mode === 'calendar'}
			Click a day to filter to it · shift-click another day for a range · click a year to filter to the whole year.
		{:else}
			Local time · {hasRange ? 'posts within the selected dates' : 'all posts'}.
		{/if}
	</div>

	{#if entries.length === 0}
		<p class="heatmap-empty">No posts loaded yet.</p>
	{:else}
		<div class="heatmap-body" bind:this={bodyEl}>
			<div class="heatmap-scroll">
				{#if mode === 'calendar'}
					{#each years as block (block.year)}
						<div class="year-block">
							<div class="year-head">
								<button
									type="button"
									class="year-btn"
									onclick={() => selectYear(block.year)}
									title={`Filter to ${block.year}`}
								>
									{block.year}
								</button>
								<span class="year-total">
									{block.posts.toLocaleString()} posts{#if hydratedCount > 0}
										· {block.likes.toLocaleString()} likes{/if}
								</span>
							</div>
							<svg
								class="heatmap-svg calendar-svg"
								viewBox={`0 0 ${CAL_W} ${CAL_H}`}
								style={`max-width:${CAL_W}px`}
								onpointermove={handleCellHover}
								onpointerdown={handleCellHover}
								onpointerleave={() => (hover = null)}
								onpointerup={handleCalendarPointerUp}
								role="presentation"
							>
								{#each block.months as month, i (i)}
									<text x={DAY_LABEL_W + month.col * STEP} y={10} class="axis-label">
										{month.label}
									</text>
								{/each}
								{#each [1, 3, 5] as row (row)}
									<text
										x={DAY_LABEL_W - 5}
										y={MONTH_LABEL_H + row * STEP + CELL - 2}
										class="axis-label"
										text-anchor="end"
									>
										{weekdayName(row)}
									</text>
								{/each}
								{#each block.cells as cell (cell.key)}
									<rect
										data-cell={cell.key}
										x={DAY_LABEL_W + cell.col * STEP}
										y={MONTH_LABEL_H + cell.row * STEP}
										width={CELL}
										height={CELL}
										rx="2"
										class={`cell l${levelFor(cell.value, dayMax)}`}
										class:dim={hasRange && !inRange(cell.key)}
										class:hovered={hover?.key === cell.key}
									/>
								{/each}
							</svg>
						</div>
					{/each}
				{:else}
					<svg
						class="heatmap-svg hours-svg"
						viewBox={`0 0 ${HOURS_W} ${HOURS_H}`}
						style={`max-width:${HOURS_W}px`}
						onpointermove={handleCellHover}
						onpointerdown={handleCellHover}
						onpointerleave={() => (hover = null)}
						role="presentation"
					>
						{#each Array.from({ length: 8 }, (_, i) => i * 3) as hour (hour)}
							<text
								x={HOUR_LABEL_W + hour * HOUR_STEP + HOUR_CELL / 2}
								y={11}
								class="axis-label"
								text-anchor="middle"
							>
								{pad2(hour)}
							</text>
						{/each}
						{#each Array.from({ length: 7 }, (_, i) => i) as dow (dow)}
							<text
								x={HOUR_LABEL_W - 6}
								y={HOUR_LABEL_H + dow * HOUR_STEP + HOUR_CELL / 2 + 4}
								class="axis-label"
								text-anchor="end"
							>
								{weekdayName(dow)}
							</text>
							{#each Array.from({ length: 24 }, (_, h) => h) as hour (hour)}
								{@const idx = dow * 24 + hour}
								<rect
									data-cell={`h:${idx}`}
									x={HOUR_LABEL_W + hour * HOUR_STEP}
									y={HOUR_LABEL_H + dow * HOUR_STEP}
									width={HOUR_CELL}
									height={HOUR_CELL}
									rx="3"
									class={`cell l${levelFor(valueOf(hourGrid[idx]), hourMax)}`}
									class:hovered={hover?.key === `h:${idx}`}
								/>
							{/each}
						{/each}
					</svg>
				{/if}
			</div>

			{#if hover}
				<div class="heatmap-tooltip" style={`left:${hover.x}px;top:${hover.y}px`}>{hoverText}</div>
			{/if}
		</div>
	{/if}

	<div class="heatmap-footer">
		<div class="legend" aria-hidden="true">
			<span>Less</span>
			<span class="swatch l0"></span>
			<span class="swatch l1"></span>
			<span class="swatch l2"></span>
			<span class="swatch l3"></span>
			<span class="swatch l4"></span>
			<span>More {metric === 'likes' ? 'likes' : 'posts'}</span>
		</div>
		{#if hasRange}
			<button type="button" class="clear-btn" onclick={clearSelection}>Clear dates</button>
		{/if}
	</div>
</div>

<style>
	.heatmap {
		background: var(--card-bg);
		padding: 14px 16px 16px;
		margin-top: 12px;
	}

	.heatmap-toolbar {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 12px;
		flex-wrap: wrap;
	}

	.heatmap-info {
		font-size: 0.85rem;
		color: var(--text-ink);
		opacity: 0.85;
	}

	.heatmap-info.collapsible {
		padding: 0;
		font-family: inherit;
		text-align: left;
		background: transparent;
		border: none;
		cursor: pointer;
	}

	.heatmap-info.collapsible:hover {
		opacity: 1;
		text-decoration: underline;
	}

	.collapse-caret {
		margin-right: 4px;
	}

	.heatmap-info .sep {
		margin: 0 6px;
		opacity: 0.5;
	}

	.heatmap-controls {
		display: flex;
		gap: 10px;
		flex-wrap: wrap;
	}

	.seg {
		display: inline-flex;
		gap: 2px;
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

	.heatmap-hint {
		font-size: 0.8rem;
		color: var(--text-ink);
		opacity: 0.8;
		margin: 8px 0;
		line-height: 1.3;
	}

	.heatmap-empty {
		font-size: 0.85rem;
		opacity: 0.7;
		margin: 12px 0;
	}

	.heatmap-body {
		position: relative;
	}

	.heatmap-scroll {
		overflow-x: auto;
	}

	.year-block + .year-block {
		margin-top: 10px;
	}

	.year-head {
		display: flex;
		align-items: baseline;
		gap: 8px;
		margin-bottom: 2px;
	}

	.year-btn {
		padding: 0;
		font-size: 0.9rem;
		font-weight: 600;
		font-family: inherit;
		background: transparent;
		color: var(--text-ink);
		border: none;
		cursor: pointer;
	}

	.year-btn:hover {
		color: var(--accent);
		text-decoration: underline;
	}

	.year-total {
		font-size: 0.75rem;
		opacity: 0.7;
	}

	.heatmap-svg {
		display: block;
		width: 100%;
		height: auto;
		user-select: none;
	}

	.calendar-svg {
		min-width: 520px;
	}

	.hours-svg {
		min-width: 420px;
	}

	.calendar-svg .cell {
		cursor: pointer;
	}

	.cell.dim {
		opacity: 0.3;
	}

	.cell.hovered {
		stroke: var(--text-ink);
		stroke-width: 1.5;
	}

	.l0 {
		fill: color-mix(in srgb, var(--text-ink) 8%, var(--card-bg));
		background: color-mix(in srgb, var(--text-ink) 8%, var(--card-bg));
	}

	.l1 {
		fill: color-mix(in srgb, var(--accent) 30%, var(--card-bg));
		background: color-mix(in srgb, var(--accent) 30%, var(--card-bg));
	}

	.l2 {
		fill: color-mix(in srgb, var(--accent) 52%, var(--card-bg));
		background: color-mix(in srgb, var(--accent) 52%, var(--card-bg));
	}

	.l3 {
		fill: color-mix(in srgb, var(--accent) 76%, var(--card-bg));
		background: color-mix(in srgb, var(--accent) 76%, var(--card-bg));
	}

	.l4 {
		fill: var(--accent);
		background: var(--accent);
	}

	.axis-label {
		fill: var(--text-ink);
		font-size: 10px;
		opacity: 0.65;
		font-family: inherit;
	}

	.heatmap-tooltip {
		position: absolute;
		transform: translate(-50%, calc(-100% - 6px));
		max-width: 220px;
		padding: 5px 9px;
		font-size: 0.78rem;
		line-height: 1.3;
		text-align: center;
		color: var(--text-ink);
		background: var(--card-bg);
		border: 1px solid var(--border-ink, #ccc);
		border-radius: 8px;
		box-shadow: 0 6px 18px rgba(0, 0, 0, 0.18);
		pointer-events: none;
		z-index: 20;
	}

	.heatmap-footer {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 10px;
		flex-wrap: wrap;
		margin-top: 10px;
	}

	.legend {
		display: inline-flex;
		align-items: center;
		gap: 3px;
		font-size: 0.75rem;
		opacity: 0.8;
	}

	.legend span:first-child {
		margin-right: 3px;
	}

	.legend span:last-child {
		margin-left: 3px;
	}

	.swatch {
		width: 11px;
		height: 11px;
		border-radius: 2px;
	}

	.clear-btn {
		padding: 4px 10px;
		font-size: 0.85rem;
		font-family: inherit;
		background: transparent;
		color: var(--text-ink);
		border: none;
		text-decoration: underline;
		cursor: pointer;
	}
</style>
