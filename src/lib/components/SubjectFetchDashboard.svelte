<script module lang="ts">
	export type SubjectSource = 'reposts' | 'likes';
	/** Engagement hydration of the loaded posts reuses the same dashboard. */
	export type FetchJobKind = SubjectSource | 'engagement';

	export type SubjectFetchPhase =
		| 'waiting'
		| 'memory'
		| 'downloading'
		| 'parsing'
		| 'hydrating'
		| 'done'
		| 'failed';

	export type SubjectFetchAccount = {
		did: string;
		handle: string;
		phase: SubjectFetchPhase;
		fromMemory: boolean;
		records: number;
		downloadedBytes: number;
		error?: string;
	};

	export type SubjectFetchJob = {
		kind: FetchJobKind;
		status: 'running' | 'done' | 'stopped' | 'failed';
		startedAt: number;
		/** When hydration requests started (after records were ready). */
		hydrateStartedAt: number | null;
		finishedAt: number | null;
		accounts: SubjectFetchAccount[];
		/** Unique subject posts across all accounts. */
		total: number;
		/** Already hydrated (or known unavailable) before this run. */
		alreadyDone: number;
		/** URIs this run has to request. */
		toFetch: number;
		/** URIs this run settled (returned or confirmed unavailable). */
		processed: number;
		/** Posts returned this run. */
		fetched: number;
		/** Subject posts that can't be shown (deleted, blocked, hidden). */
		unavailable: number;
		/** URIs whose request still failed after retries; fetched again on resume. */
		failed: number;
	};
</script>

<script lang="ts">
	import type { SchedulerSnapshot } from '$lib/utils/requestScheduler';

	interface Props {
		job: SubjectFetchJob;
		snapshot: SchedulerSnapshot | null;
		/** Posts per request, for the req/s estimate; omit when requests vary in size. */
		postsPerRequest?: number;
		onstop?: () => void;
		onresume?: () => void;
		onclose?: () => void;
	}

	let { job, snapshot, postsPerRequest, onstop, onresume, onclose }: Props = $props();

	let now = $state(Date.now());
	$effect(() => {
		if (job.status !== 'running') return;
		const timer = setInterval(() => (now = Date.now()), 500);
		return () => clearInterval(timer);
	});

	const noun = $derived(job.kind);
	const icon = $derived(job.kind === 'likes' ? '♥' : job.kind === 'engagement' ? '📊' : '🔁');
	const endAt = $derived(job.finishedAt ?? now);
	const done = $derived(job.alreadyDone + job.processed);
	const pct = $derived(job.total > 0 ? Math.min(100, (done / job.total) * 100) : 0);
	const hydrateSeconds = $derived(
		job.hydrateStartedAt != null ? Math.max(0.001, (endAt - job.hydrateStartedAt) / 1000) : 0
	);
	const postsPerSec = $derived(hydrateSeconds > 0 ? job.processed / hydrateSeconds : 0);
	const remaining = $derived(Math.max(0, job.toFetch - job.processed - job.failed));
	const etaSeconds = $derived(
		job.status === 'running' && postsPerSec > 0 && remaining > 0 ? remaining / postsPerSec : null
	);
	const pausedFor = $derived(
		snapshot?.pausedUntil ? Math.max(0, Math.ceil((snapshot.pausedUntil - now) / 1000)) : 0
	);
	const budgetPct = $derived(
		snapshot?.budget ? Math.min(100, (snapshot.budget.used / snapshot.budget.limit) * 100) : 0
	);

	const title = $derived.by(() => {
		const verb = job.kind === 'engagement' ? 'hydrating' : 'fetching';
		if (job.status === 'running') return `${verb[0].toUpperCase()}${verb.slice(1)} ${noun}`;
		if (job.status === 'stopped') return `Stopped ${verb} ${noun}`;
		if (job.status === 'failed') return `${verb[0].toUpperCase()}${verb.slice(1)} ${noun} failed`;
		return job.failed > 0 ? `${noun[0].toUpperCase()}${noun.slice(1)} partly loaded` : `${noun[0].toUpperCase()}${noun.slice(1)} loaded`;
	});

	function fmt(n: number): string {
		return Math.round(n).toLocaleString();
	}

	function fmtDuration(seconds: number): string {
		const s = Math.max(0, Math.round(seconds));
		if (s < 60) return `${s}s`;
		const m = Math.floor(s / 60);
		if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
		return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
	}

	function fmtBytes(bytes: number): string {
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
		return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	}

	function phaseLabel(account: SubjectFetchAccount): string {
		switch (account.phase) {
			case 'waiting':
				return 'waiting';
			case 'memory':
				return 'reading records from the loaded repo';
			case 'downloading':
				return account.downloadedBytes > 0
					? `downloading repo · ${fmtBytes(account.downloadedBytes)}`
					: 'downloading repo';
			case 'parsing':
				return 'reading records';
			case 'hydrating':
				return 'loading posts';
			case 'done':
				return 'done';
			case 'failed':
				return account.error ? `failed: ${account.error}` : 'failed';
		}
	}
</script>

<section class="fetch-dash wobbly-border-light" aria-label={`${noun} fetching`}>
	<header class="dash-head">
		<h3>{icon} {title}</h3>
		<div class="dash-actions">
			{#if job.status === 'running'}
				<button type="button" class="mini-btn" onclick={onstop}>Stop</button>
			{:else}
				{#if job.status !== 'done' || job.failed > 0}
					<button type="button" class="mini-btn active" onclick={onresume}>
						{job.failed > 0 && job.status === 'done' ? `Retry ${fmt(job.failed)} failed` : 'Resume'}
					</button>
				{/if}
				<button type="button" class="mini-btn" onclick={onclose} aria-label="Close">×</button>
			{/if}
		</div>
	</header>

	<div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow={Math.round(pct)}>
		<div class="progress-fill" class:running={job.status === 'running'} style={`width:${pct}%`}></div>
	</div>
	<p class="dash-line strong">
		{#if job.total > 0}
			{fmt(done)} / {fmt(job.total)} posts ({pct.toFixed(0)}%)
		{:else if job.status === 'running'}
			Reading {noun}…
		{:else}
			No {noun} found
		{/if}
	</p>
	<p class="dash-line">
		{fmt(job.fetched)} loaded this run
		{#if job.alreadyDone > 0}<span class="sep">·</span>{fmt(job.alreadyDone)} already in memory{/if}
		{#if job.unavailable > 0}<span class="sep">·</span>{fmt(job.unavailable)} unavailable{/if}
		{#if job.failed > 0}<span class="sep">·</span><span class="warn">{fmt(job.failed)} failed</span>{/if}
	</p>
	{#if job.hydrateStartedAt != null}
		<p class="dash-line">
			{fmt(postsPerSec)} posts/s
			{#if postsPerRequest}<span class="sep">·</span>~{(postsPerSec / postsPerRequest).toFixed(1)} req/s{/if}
			<span class="sep">·</span>elapsed {fmtDuration((endAt - job.startedAt) / 1000)}
			{#if etaSeconds != null}<span class="sep">·</span>ETA {fmtDuration(etaSeconds)}{/if}
		</p>
	{/if}

	{#if snapshot && job.status === 'running'}
		<div class="dash-grid">
			<div class="stat"><span class="stat-value">{snapshot.running.length}</span><span class="stat-label">running</span></div>
			<div class="stat"><span class="stat-value">{fmt(snapshot.queued)}</span><span class="stat-label">queued</span></div>
			<div class="stat"><span class="stat-value">{fmt(snapshot.completed)}</span><span class="stat-label">done</span></div>
			<div class="stat"><span class="stat-value">{fmt(snapshot.retried)}</span><span class="stat-label">retried</span></div>
			<div class="stat"><span class="stat-value">{fmt(snapshot.failed)}</span><span class="stat-label">failed</span></div>
			<div class="stat">
				<span class="stat-value">{snapshot.concurrency}/{snapshot.maxConcurrency}</span>
				<span class="stat-label">parallel</span>
			</div>
		</div>
		{#if snapshot.budget}
			<div class="budget">
				<span class="budget-label">
					Rate budget {fmt(snapshot.budget.used)} / {fmt(snapshot.budget.limit)} requests per {Math.round(
						snapshot.budget.windowMs / 60_000
					)} min
				</span>
				<div class="budget-bar"><div class="budget-fill" class:full={budgetPct >= 99} style={`width:${budgetPct}%`}></div></div>
			</div>
		{/if}
		{#if pausedFor > 0}
			<p class="dash-line warn">⚠ Rate limited by Bluesky — resuming in {pausedFor}s</p>
		{:else if budgetPct >= 99 && snapshot.queued > 0}
			<p class="dash-line muted">Budget full — waiting for the window to free up</p>
		{/if}
	{/if}

	{#if job.accounts.length > 0}
		<ul class="accounts">
			{#each job.accounts as account (account.did)}
				<li>
					<span class="acct-handle">@{account.handle}</span>
					<span class="acct-detail">
						{#if account.records > 0}{fmt(account.records)} {noun}{account.fromMemory ? ' · from memory' : ' · downloaded'} · {/if}{phaseLabel(account)}
					</span>
				</li>
			{/each}
		</ul>
	{/if}
</section>

<style>
	.fetch-dash {
		background: var(--card-bg);
		padding: 12px 16px 14px;
		margin: 10px 0;
		font-size: 0.85rem;
		color: var(--text-ink);
	}

	.dash-head {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 10px;
		margin-bottom: 8px;
	}

	.dash-head h3 {
		margin: 0;
		font-size: 0.95rem;
		font-weight: 600;
	}

	.dash-actions {
		display: flex;
		gap: 6px;
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

	.progress {
		height: 8px;
		border-radius: 4px;
		background: color-mix(in srgb, var(--text-ink) 10%, var(--card-bg));
		overflow: hidden;
	}

	.progress-fill {
		height: 100%;
		background: var(--accent);
		border-radius: 4px;
		transition: width 0.3s ease;
	}

	.progress-fill.running {
		background-image: linear-gradient(
			90deg,
			transparent 0,
			color-mix(in srgb, white 30%, transparent) 50%,
			transparent 100%
		);
		background-size: 200% 100%;
		background-color: var(--accent);
		animation: shimmer 1.6s linear infinite;
	}

	@keyframes shimmer {
		from {
			background-position: 200% 0;
		}
		to {
			background-position: -200% 0;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.progress-fill,
		.progress-fill.running {
			transition: none;
			animation: none;
		}
	}

	.dash-line {
		margin: 6px 0 0;
		line-height: 1.35;
		opacity: 0.85;
	}

	.dash-line.strong {
		font-weight: 600;
		opacity: 1;
	}

	.dash-line.muted {
		opacity: 0.65;
	}

	.sep {
		margin: 0 6px;
		opacity: 0.5;
	}

	.warn {
		color: #c2410c;
		opacity: 1;
	}

	.dash-grid {
		display: grid;
		grid-template-columns: repeat(6, minmax(0, 1fr));
		gap: 6px;
		margin-top: 10px;
	}

	@media (max-width: 560px) {
		.dash-grid {
			grid-template-columns: repeat(3, minmax(0, 1fr));
		}
	}

	.stat {
		display: flex;
		flex-direction: column;
		align-items: center;
		padding: 5px 4px;
		border-radius: 6px;
		background: color-mix(in srgb, var(--text-ink) 5%, var(--card-bg));
	}

	.stat-value {
		font-weight: 600;
		font-variant-numeric: tabular-nums;
	}

	.stat-label {
		font-size: 0.72rem;
		opacity: 0.7;
	}

	.budget {
		margin-top: 10px;
	}

	.budget-label {
		font-size: 0.78rem;
		opacity: 0.8;
	}

	.budget-bar {
		height: 5px;
		margin-top: 4px;
		border-radius: 3px;
		background: color-mix(in srgb, var(--text-ink) 10%, var(--card-bg));
		overflow: hidden;
	}

	.budget-fill {
		height: 100%;
		background: color-mix(in srgb, var(--accent) 70%, var(--card-bg));
	}

	.budget-fill.full {
		background: #c2410c;
	}

	.accounts {
		list-style: none;
		margin: 10px 0 0;
		padding: 0;
	}

	.accounts li {
		display: flex;
		gap: 8px;
		flex-wrap: wrap;
		font-size: 0.8rem;
		padding: 3px 0;
		border-top: 1px solid color-mix(in srgb, var(--text-ink) 8%, transparent);
	}

	.acct-handle {
		font-weight: 600;
	}

	.acct-detail {
		opacity: 0.75;
	}
</style>
