<script lang="ts">
	import { MATRIX_TERMINAL_FONT_OPTIONS } from '$lib/constants/matrixTerminalFonts';
	import { LIVE_REFRESH_MS, MATRIX_SPEED_MIN, MATRIX_SPEED_MAX, type MatrixSettings } from '$lib/stores/matrixSettings.svelte';

	let {
		settings,
		loading = false,
		isBackgroundRefreshing = false,
		profileHandle = null,
		feedLabel = null,
		waitingLabel = 'waiting for a handle'
	}: {
		settings: MatrixSettings;
		loading?: boolean;
		isBackgroundRefreshing?: boolean;
		profileHandle?: string | null;
		feedLabel?: string | null;
		waitingLabel?: string;
	} = $props();

	function handleSpeedInput(event: Event) {
		settings.speed = Number((event.currentTarget as HTMLInputElement).value);
	}

	function handlePanelInput(event: Event) {
		const value = Number((event.currentTarget as HTMLInputElement).value);
		if (Number.isFinite(value)) {
			settings.panelCount = value;
		}
	}
</script>

<div class="control-grid">
	<div class="control-card">
		<div class="control-copy">
			<span class="control-label">Speed</span>
			<span class="control-value">{settings.speedLabel} :: {settings.frameDelayMs}ms pace</span>
		</div>
		<input
			class="speed-slider"
			type="range"
			min={MATRIX_SPEED_MIN}
			max={MATRIX_SPEED_MAX}
			step="1"
			value={settings.speed}
			oninput={handleSpeedInput}
			aria-label="Matrix feed speed"
		/>
		<div class="slider-scale">
			<span>Readable</span>
			<span>Overclock</span>
		</div>
	</div>

	<div class="control-card">
		<div class="control-copy">
			<span class="control-label">Panels</span>
			<span class="control-value">{settings.panelCount} active panels</span>
		</div>
		<div class="panel-input-row">
			<input
				class="panel-count-input"
				type="number"
				min="1"
				max="100"
				step="1"
				value={settings.panelCount}
				oninput={handlePanelInput}
				aria-label="Number of terminal panels"
			/>
			<div class="panel-buttons" role="group" aria-label="Panel presets">
				{#each [1, 4, 12, 24, 100] as count}
					<button
						type="button"
						class:active={settings.panelCount === count}
						onclick={() => (settings.panelCount = count)}
					>
						{count}
					</button>
				{/each}
			</div>
		</div>
	</div>

	<div class="control-card">
		<div class="control-copy">
			<span class="control-label">Render</span>
			<span class="control-value">{settings.renderStyleLabel}</span>
		</div>
		<div class="layout-buttons render-buttons" role="group" aria-label="Render style">
			<button
				type="button"
				class:active={settings.renderStyle === 'terminal'}
				onclick={() => (settings.renderStyle = 'terminal')}
			>
				Terminal
			</button>
			<button
				type="button"
				class:active={settings.renderStyle === 'rain'}
				onclick={() => (settings.renderStyle = 'rain')}
			>
				Vertical
			</button>
			<button
				type="button"
				class:active={settings.renderStyle === 'rain-horizontal'}
				onclick={() => (settings.renderStyle = 'rain-horizontal')}
			>
				Horizontal
			</button>
		</div>
	</div>

	<div class="control-card">
		<div class="control-copy">
			<span class="control-label">Terminal Font</span>
			<span class="control-value">{settings.terminalFontLabel}</span>
		</div>
		<select class="font-select" bind:value={settings.terminalFontId} aria-label="Choose a terminal font">
			{#each MATRIX_TERMINAL_FONT_OPTIONS as option}
				<option value={option.id}>{option.label}</option>
			{/each}
		</select>
	</div>

	<div class="control-card">
		<div class="control-copy">
			<span class="control-label">Feed</span>
			<span class="control-value">
				{settings.liveRefreshEnabled ? `Live every ${Math.round(LIVE_REFRESH_MS / 1000)}s` : 'Manual'}
			</span>
		</div>
		<button
			type="button"
			class="live-toggle"
			class:active={settings.liveRefreshEnabled}
			onclick={() => (settings.liveRefreshEnabled = !settings.liveRefreshEnabled)}
			aria-pressed={settings.liveRefreshEnabled}
		>
			{settings.liveRefreshEnabled ? 'Live On' : 'Live Off'}
		</button>
		<div class="live-state">
			{#if loading}
				<span>syncing feed...</span>
			{:else if isBackgroundRefreshing}
				<span>refreshing in background...</span>
			{:else if profileHandle}
				<span>tracking {feedLabel ?? `@${profileHandle}`}</span>
			{:else}
				<span>{waitingLabel}</span>
			{/if}
		</div>
	</div>

	<div class="control-card">
		<div class="control-copy">
			<span class="control-label">Layout</span>
			<span class="control-value">
				{settings.layoutMode === 'btree' ? 'Btree fill' : 'Grid fill'}
			</span>
		</div>
		<div class="layout-buttons" role="group" aria-label="Layout style">
			<button
				type="button"
				class:active={settings.layoutMode === 'grid'}
				onclick={() => (settings.layoutMode = 'grid')}
			>
				Grid
			</button>
			<button
				type="button"
				class:active={settings.layoutMode === 'btree'}
				onclick={() => (settings.layoutMode = 'btree')}
			>
				Btree
			</button>
		</div>
	</div>
</div>

<style>
	.control-grid {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 8px;
		align-items: stretch;
	}

	.control-card {
		min-width: 0;
		position: relative;
		display: grid;
		gap: 6px;
		padding: 10px;
		border-radius: 14px;
		border: 1px solid rgba(125, 255, 154, 0.16);
		background: rgba(2, 8, 4, 0.72);
	}

	.control-label {
		font-size: 0.64rem;
		letter-spacing: 0.16em;
		text-transform: uppercase;
		color: var(--matrix-green-dim);
	}

	.control-copy,
	.slider-scale {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		flex-wrap: wrap;
	}

	.control-copy > * {
		min-width: 0;
	}

	.control-value,
	.live-state {
		font-size: 0.72rem;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--matrix-green-strong);
		min-width: 0;
		overflow-wrap: anywhere;
	}

	.control-label,
	.control-value,
	.slider-scale,
	.live-state {
		font-family: var(--matrix-ui-font);
	}

	.speed-slider {
		width: 100%;
		height: 18px;
		appearance: none;
		background: transparent;
	}

	.speed-slider::-webkit-slider-runnable-track {
		height: 6px;
		border-radius: 999px;
		background: linear-gradient(90deg, rgba(74, 255, 92, 0.32), rgba(182, 255, 115, 0.92));
	}

	.speed-slider::-moz-range-track {
		height: 6px;
		border-radius: 999px;
		background: linear-gradient(90deg, rgba(74, 255, 92, 0.32), rgba(182, 255, 115, 0.92));
	}

	.speed-slider::-webkit-slider-thumb {
		appearance: none;
		width: 16px;
		height: 16px;
		margin-top: -5px;
		border: 1px solid rgba(216, 255, 182, 0.95);
		border-radius: 50%;
		background: #d4ffb2;
		box-shadow: 0 0 16px rgba(125, 255, 154, 0.34);
	}

	.speed-slider::-moz-range-thumb {
		width: 16px;
		height: 16px;
		border: 1px solid rgba(216, 255, 182, 0.95);
		border-radius: 50%;
		background: #d4ffb2;
		box-shadow: 0 0 16px rgba(125, 255, 154, 0.34);
	}

	.panel-input-row {
		display: grid;
		gap: 8px;
	}

	.panel-count-input {
		min-height: 40px;
		padding: 0 12px;
		font-size: 0.82rem;
		font-family: var(--matrix-ui-font);
	}

	.font-select,
	.panel-count-input,
	.panel-buttons button,
	.layout-buttons button,
	.live-toggle {
		border-radius: 12px;
		border: 1px solid rgba(125, 255, 154, 0.2);
		background: rgba(1, 7, 3, 0.9);
		color: var(--matrix-green-strong);
		font-family: var(--matrix-ui-font);
	}

	.font-select {
		width: 100%;
		min-height: 40px;
		padding: 0 12px;
		font-size: 0.82rem;
		outline: none;
	}

	.panel-buttons {
		display: grid;
		grid-template-columns: repeat(5, minmax(0, 1fr));
		gap: 6px;
	}

	.layout-buttons {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 6px;
	}

	.render-buttons {
		grid-template-columns: repeat(3, minmax(0, 1fr));
	}

	.panel-buttons button,
	.layout-buttons button,
	.live-toggle {
		padding: 0 12px;
		min-height: 42px;
		font-size: 0.68rem;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		cursor: pointer;
		line-height: 1.15;
		text-align: center;
		white-space: normal;
		word-break: break-word;
	}

	.panel-buttons button.active,
	.layout-buttons button.active,
	.live-toggle.active {
		background: rgba(18, 48, 24, 0.92);
		border-color: rgba(125, 255, 154, 0.4);
		box-shadow: 0 0 0 1px rgba(125, 255, 154, 0.14);
	}

	@media (max-width: 760px) {
		.control-grid {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
	}

	@media (max-width: 640px) {
		.control-grid {
			grid-template-columns: 1fr;
		}
	}
</style>
