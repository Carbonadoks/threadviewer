<script lang="ts">
	interface Props {
		value: string;
		onchange: (fontKey: string) => void;
	}

	let { value, onchange }: Props = $props();

	const fonts = [
		{ key: 'virgil', label: 'Virgil', family: "'Virgil', cursive" },
		{ key: 'caveat', label: 'Caveat', family: "'Caveat', cursive" },
		{ key: 'patrick', label: 'Patrick Hand', family: "'Patrick Hand', cursive" },
		{ key: 'comic-neue', label: 'Comic Neue', family: "'Comic Neue', cursive" },
		{ key: 'inter', label: 'Inter', family: "'Inter', sans-serif" },
		{ key: 'system', label: 'System UI', family: "system-ui, -apple-system, sans-serif" }
	];

	export function getFontFamily(key: string): string {
		return fonts.find((f) => f.key === key)?.family ?? fonts[0].family;
	}

	function handleChange(e: Event) {
		const select = e.target as HTMLSelectElement;
		onchange(select.value);
	}
</script>

<div class="font-picker">
	<label for="font-select">Font:</label>
	<select id="font-select" value={value} onchange={handleChange} style={`font-family: ${getFontFamily(value)}`}>
		{#each fonts as font (font.key)}
			<option value={font.key} style="font-family: {font.family}">{font.label}</option>
		{/each}
	</select>
</div>

<style>
	.font-picker {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font-size: 0.9rem;
		color: var(--muted);
	}

	label {
		font-size: 0.85rem;
	}

	select {
		font-family: inherit;
		font-size: 0.9rem;
		padding: 2px 6px;
		border: 1.5px solid var(--muted);
		border-radius: 6px;
		background: var(--card-bg);
		color: var(--text-ink);
		cursor: pointer;
	}

	select:focus {
		outline: 2px solid var(--accent);
		outline-offset: 1px;
	}
</style>
