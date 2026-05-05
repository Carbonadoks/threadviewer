<script lang="ts">
	let {
		dateFrom = $bindable(''),
		dateTo = $bindable('')
	}: {
		dateFrom: string;
		dateTo: string;
	} = $props();

	let expanded = $state(false);
</script>

<div class="search-options">
	<button class="toggle-btn" onclick={() => (expanded = !expanded)}>
		{expanded ? '- Hide' : '+ Show'} date filters
	</button>

	{#if expanded}
		<div class="options-panel wobbly-border-light">
			<div class="option-row">
				<label for="date-from">From date:</label>
				<input
					id="date-from"
					type="date"
					bind:value={dateFrom}
					class="wobbly-border-light"
				/>
			</div>

			<div class="option-row">
				<label for="date-to">To date:</label>
				<input
					id="date-to"
					type="date"
					bind:value={dateTo}
					class="wobbly-border-light"
				/>
			</div>

			{#if dateFrom || dateTo}
				<button class="clear-dates" onclick={() => { dateFrom = ''; dateTo = ''; }}>
					Clear date filters
				</button>
			{/if}
		</div>
	{/if}
</div>

<style>
	.search-options {
		max-width: 600px;
		margin: 0 auto;
	}

	.toggle-btn {
		background: none;
		border: none;
		color: var(--muted);
		font-size: 0.9rem;
		padding: 4px 0;
	}

	.toggle-btn:hover {
		color: var(--accent);
	}

	.options-panel {
		margin-top: 8px;
		padding: 16px 20px;
		background: var(--card-bg);
		display: flex;
		flex-direction: column;
		gap: 12px;
	}

	.option-row {
		display: flex;
		align-items: center;
		gap: 12px;
		flex-wrap: wrap;
	}

	.option-row label {
		min-width: 160px;
		font-size: 0.95rem;
	}

	input[type='date'] {
		padding: 4px 8px;
		font-size: 0.9rem;
		background: var(--bg-paper);
		color: var(--text-ink);
	}

	.clear-dates {
		background: none;
		border: none;
		color: var(--accent);
		font-size: 0.85rem;
		padding: 2px 0;
		align-self: flex-start;
	}

	.clear-dates:hover {
		text-decoration: underline;
	}
</style>
