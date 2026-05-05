<script lang="ts">
	import AtlasPage from '../cluster/+page.svelte';

	const endpointVersion = 'v20260309-nostore';
</script>

<AtlasPage
	currentRoute="toponomy"
	pageTitle="Global Toponomy Atlas"
	pageSubtitle="Cached thread embeddings reduced into a local UMAP-style atlas, then clustered in reduced space before semantic labeling."
	statusEndpoint="/api/toponomy"
	overviewEndpoint={`/api/toponomy/overview?v=${endpointVersion}`}
	pointsEndpoint={`/api/toponomy/points/compact?v=${endpointVersion}`}
	threadEndpoint="/api/toponomy/thread"
	loadingLabel="toponomy atlas"
	pointLabel="toponomy points"
	missingTitle="Toponomy Not Built Yet"
	missingBody="The atlas reads a saved toponomy snapshot built from cached thread embeddings. Build it locally, then refresh this page."
	failureTitle="Toponomy Build Failed"
	buildCommand="npm run toponomy:build"
/>
