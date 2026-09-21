<script lang="ts">
	import { getContext } from 'svelte';
	import { ROUTE_NAV_CONTEXT, type RouteNavContext, type RouteNavRegistration } from '$lib/utils/routeNav';

	// Routes supply their live selection; the shared layout owns the visible navigation.
	let { current, threadUrl = null, handle = null, dialogueHandleA = null,
		dialogueHandleB = null, hideThreadTools = false }: RouteNavContext & {
		compact?: boolean;
		align?: 'start' | 'center';
	} = $props();
	const navigation = getContext<RouteNavRegistration>(ROUTE_NAV_CONTEXT);

	$effect(() => navigation.register({
		current, threadUrl, handle, dialogueHandleA, dialogueHandleB, hideThreadTools
	}));
</script>
