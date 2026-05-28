<script lang="ts">
	interface Props {
		value: string;
		onchange: (mode: string) => void;
	}

	let { value, onchange }: Props = $props();

	const modes = [
		{ key: 'default', label: 'Default' },
		{ key: 'gallery', label: 'Gallery' }
	];
</script>

<div class="mode-picker">
	{#each modes as mode (mode.key)}
		<button
			class="mode-btn wobbly-border-light"
			class:active={value === mode.key}
			onclick={() => onchange(mode.key)}
		>
			{mode.label}
		</button>
	{/each}
</div>

<style>
	.mode-picker {
		display: flex;
		gap: 6px;
		justify-content: center;
		margin-top: 8px;
	}

	.mode-btn {
		padding: 4px 14px;
		font-size: 0.85rem;
		font-family: var(--font-hand);
		background: var(--card-bg);
		color: var(--text-ink);
		cursor: pointer;
		transition: all 0.15s;
	}

	.mode-btn:hover {
		opacity: 0.8;
	}

	.mode-btn.active {
		background: var(--accent);
		color: white;
		border-color: var(--accent);
	}
</style>
