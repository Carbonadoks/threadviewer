<script lang="ts">
	let { value = $bindable(3), min = 2, max = 20 }: { value: number; min?: number; max?: number } = $props();
</script>

<div class="threshold-control">
	<label for="threshold-range">
		Min chain length: <strong>{value}</strong>
	</label>
	<input id="threshold-range" type="range" bind:value {min} {max} />
</div>

<style>
	.threshold-control {
		display: flex;
		align-items: center;
		gap: 16px;
		justify-content: center;
		font-size: 1rem;
	}

	label {
		white-space: nowrap;
	}

	input[type='range'] {
		width: 200px;
		accent-color: var(--accent);
	}
</style>
