<script lang="ts">
	import type { XArchiveThread } from '$lib/api/x';
	import TwitterArchiveArticle from './TwitterArchiveArticle.svelte';

	let { thread }: { thread: XArchiveThread } = $props();
</script>

<TwitterArchiveArticle {thread} />
