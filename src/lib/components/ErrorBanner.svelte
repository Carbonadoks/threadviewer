<script lang="ts">
	let { message }: { message: string } = $props();
</script>

<div class="error-banner wobbly-border">
	<p>{message}</p>
</div>

<style>
	.error-banner {
		max-width: 600px;
		margin: 24px auto;
		padding: 16px 20px;
		background: var(--error-bg);
		border-color: var(--accent);
		text-align: center;
		font-size: 1rem;
	}
</style>
