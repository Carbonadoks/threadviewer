<script lang="ts">
	import { browser } from '$app/environment';
	import type { SelfReplyThread } from '$lib/types';
	import ThreadCard from '$lib/components/ThreadCard.svelte';
	import ChatBubbles from '$lib/components/modes/ChatBubbles.svelte';
	import ConspiracyBoard from '$lib/components/modes/ConspiracyBoard.svelte';
	import RansomNote from '$lib/components/modes/RansomNote.svelte';

	type RenderMode = 'default' | 'chat' | 'conspiracy' | 'ransom';

	let {
		threads,
		renderMode = 'default',
		highlightedThread = null,
		highlightedPostByRootUri = {},
		shattering = false,
		appearing = false,
		collapsedByRootUri,
		oncollapsedchange,
		onexpand,
		onshare,
		onopenbluesky,
		scrollToRootUri = null,
		onscrolltorooturicomplete,
		onshatterend,
		onappearend
	}: {
		threads: SelfReplyThread[];
		renderMode?: RenderMode;
		highlightedThread?: string | null;
		highlightedPostByRootUri?: Record<string, string>;
		shattering?: boolean;
		appearing?: boolean;
		collapsedByRootUri: Record<string, boolean>;
		oncollapsedchange: (rootUri: string, collapsed: boolean) => void;
		onexpand?: (rootUri: string) => void;
		onshare?: (rootUri: string) => void;
		onopenbluesky?: (rootUri: string) => void;
		scrollToRootUri?: string | null;
		onscrolltorooturicomplete?: (rootUri: string, found: boolean) => void;
		onshatterend?: () => void;
		onappearend?: () => void;
	} = $props();

	const ESTIMATED_ROW_HEIGHT = 300;
	const MIN_ROW_HEIGHT = 120;
	const OVERSCAN_PX = 720;

	let listEl: HTMLDivElement | undefined = $state();
	let viewportHeight = $state(0);
	let windowScrollY = $state(0);
	let listPageTop = $state(0);
	let rowHeights = $state<Record<string, number>>({});
	let handledScrollTarget: string | null = $state(null);
	let metricsRafId: number | null = null;

	function setRowHeight(rootUri: string, height: number) {
		if (!Number.isFinite(height) || height <= 0) return;
		const rounded = Math.max(MIN_ROW_HEIGHT, Math.ceil(height));
		if (rowHeights[rootUri] === rounded) return;
		rowHeights = {
			...rowHeights,
			[rootUri]: rounded
		};
	}

	function rowHeight(rootUri: string): number {
		return Math.max(MIN_ROW_HEIGHT, rowHeights[rootUri] ?? ESTIMATED_ROW_HEIGHT);
	}

	const prefixOffsets = $derived.by(() => {
		const offsets = [0];
		let total = 0;
		for (const thread of threads) {
			total += rowHeight(thread.rootUri);
			offsets.push(total);
		}
		return offsets;
	});

	const totalHeight = $derived(prefixOffsets[prefixOffsets.length - 1] ?? 0);
	const visibleTop = $derived(Math.max(0, windowScrollY - listPageTop - OVERSCAN_PX));
	const visibleBottom = $derived(
		Math.max(0, windowScrollY + viewportHeight - listPageTop + OVERSCAN_PX)
	);

	function findIndexForOffset(offsets: number[], offset: number): number {
		const itemCount = Math.max(0, offsets.length - 1);
		if (itemCount === 0) return 0;

		const clamped = Math.max(0, Math.min(offset, offsets[itemCount]));
		let low = 0;
		let high = itemCount - 1;

		while (low <= high) {
			const mid = Math.floor((low + high) / 2);
			if (offsets[mid + 1] <= clamped) {
				low = mid + 1;
			} else {
				high = mid - 1;
			}
		}

		return Math.max(0, Math.min(low, itemCount - 1));
	}

	const startIndex = $derived(
		threads.length === 0 ? 0 : findIndexForOffset(prefixOffsets, visibleTop)
	);
	const endIndex = $derived(
		threads.length === 0
			? -1
			: Math.max(
					startIndex,
					findIndexForOffset(prefixOffsets, Math.min(totalHeight, visibleBottom))
			  )
	);
	const visibleThreads = $derived(
		endIndex < startIndex ? [] : threads.slice(startIndex, endIndex + 1)
	);
	const topSpacerHeight = $derived(prefixOffsets[startIndex] ?? 0);
	const bottomSpacerHeight = $derived(
		Math.max(0, totalHeight - (prefixOffsets[endIndex + 1] ?? totalHeight))
	);

	const threadIndexByRootUri = $derived.by(() => {
		const map = new Map<string, number>();
		for (let i = 0; i < threads.length; i++) {
			map.set(threads[i].rootUri, i);
		}
		return map;
	});

	function syncViewportMetrics() {
		if (!browser) return;
		viewportHeight = window.innerHeight;
		windowScrollY = window.scrollY || window.pageYOffset || 0;
		if (!listEl) return;
		const rect = listEl.getBoundingClientRect();
		listPageTop = windowScrollY + rect.top;
	}

	function scheduleViewportSync() {
		if (!browser) return;
		if (metricsRafId !== null) return;
		metricsRafId = requestAnimationFrame(() => {
			metricsRafId = null;
			syncViewportMetrics();
		});
	}

	function measureRow(node: HTMLElement, rootUri: string) {
		let currentRootUri = rootUri;

		const measure = () => {
			setRowHeight(currentRootUri, node.getBoundingClientRect().height);
		};

		measure();

		if (!browser) {
			return {
				update(nextRootUri: string) {
					currentRootUri = nextRootUri;
					measure();
				}
			};
		}

		const observer = new ResizeObserver(() => {
			measure();
		});
		observer.observe(node);

		return {
			update(nextRootUri: string) {
				currentRootUri = nextRootUri;
				measure();
			},
			destroy() {
				observer.disconnect();
			}
		};
	}

	function collapsed(rootUri: string): boolean {
		return collapsedByRootUri[rootUri] ?? true;
	}

	function handleAnimationEnd(event: AnimationEvent) {
		if (event.animationName === 'shatter-out') {
			onshatterend?.();
		} else if (event.animationName === 'appear-in') {
			onappearend?.();
		}
	}

	$effect(() => {
		if (!browser) return;

		syncViewportMetrics();

		const onScroll = () => {
			scheduleViewportSync();
		};
		const onResize = () => {
			scheduleViewportSync();
		};

		window.addEventListener('scroll', onScroll, { passive: true });
		window.addEventListener('resize', onResize, { passive: true });

		return () => {
			window.removeEventListener('scroll', onScroll);
			window.removeEventListener('resize', onResize);
			if (metricsRafId !== null) {
				cancelAnimationFrame(metricsRafId);
				metricsRafId = null;
			}
		};
	});

	$effect(() => {
		threads.length;
		renderMode;
		scheduleViewportSync();
	});

	$effect(() => {
		if (!scrollToRootUri) {
			handledScrollTarget = null;
		}
	});

	$effect(() => {
		const target = scrollToRootUri;
		if (!target || handledScrollTarget === target) return;

		if (!browser) {
			handledScrollTarget = target;
			onscrolltorooturicomplete?.(target, false);
			return;
		}

		let cancelled = false;
		const frame = requestAnimationFrame(() => {
			if (cancelled) return;

			syncViewportMetrics();
			const index = threadIndexByRootUri.get(target);
			handledScrollTarget = target;

			if (index === undefined) {
				onscrolltorooturicomplete?.(target, false);
				return;
			}

			const offset = prefixOffsets[index] ?? 0;
			const targetScrollTop = Math.max(
				0,
				listPageTop + offset - Math.max(64, Math.floor(viewportHeight * 0.35))
			);
			window.scrollTo({
				top: targetScrollTop,
				behavior: 'smooth'
			});
			onscrolltorooturicomplete?.(target, true);
		});

		return () => {
			cancelled = true;
			cancelAnimationFrame(frame);
		};
	});

	$effect(() => {
		const activeRoots = new Set(threads.map((thread) => thread.rootUri));
		let changed = false;
		const nextHeights: Record<string, number> = {};

		for (const [rootUri, height] of Object.entries(rowHeights)) {
			if (activeRoots.has(rootUri)) {
				nextHeights[rootUri] = height;
			} else {
				changed = true;
			}
		}

		if (changed) {
			rowHeights = nextHeights;
		}
	});
</script>

<div
	class="threads-list"
	class:shattering
	class:appearing
	bind:this={listEl}
	onanimationend={handleAnimationEnd}
>
	{#if threads.length > 0}
		<div class="virtual-spacer" style={`height: ${topSpacerHeight}px;`}></div>

		{#each visibleThreads as thread (thread.rootUri)}
			<div
				class="virtual-row"
				data-thread-uri={thread.rootUri}
				class:thread-highlight={highlightedThread === thread.rootUri}
				use:measureRow={thread.rootUri}
			>
				{#if renderMode === 'chat'}
					<ChatBubbles
						{thread}
						collapsed={collapsed(thread.rootUri)}
						oncollapsedchange={(nextCollapsed) => oncollapsedchange(thread.rootUri, nextCollapsed)}
						onexpand={onexpand}
						onshare={onshare}
						onopenbluesky={onopenbluesky}
					/>
				{:else if renderMode === 'conspiracy'}
					<ConspiracyBoard
						{thread}
						collapsed={collapsed(thread.rootUri)}
						oncollapsedchange={(nextCollapsed) => oncollapsedchange(thread.rootUri, nextCollapsed)}
						onexpand={onexpand}
						onshare={onshare}
						onopenbluesky={onopenbluesky}
					/>
				{:else if renderMode === 'ransom'}
					<RansomNote
						{thread}
						collapsed={collapsed(thread.rootUri)}
						oncollapsedchange={(nextCollapsed) => oncollapsedchange(thread.rootUri, nextCollapsed)}
						onexpand={onexpand}
						onshare={onshare}
						onopenbluesky={onopenbluesky}
					/>
				{:else}
					<ThreadCard
						{thread}
						highlightedPostUri={highlightedPostByRootUri[thread.rootUri] ?? null}
						collapsed={collapsed(thread.rootUri)}
						oncollapsedchange={(nextCollapsed) => oncollapsedchange(thread.rootUri, nextCollapsed)}
						onexpand={onexpand}
						onshare={onshare}
						onopenbluesky={onopenbluesky}
					/>
				{/if}
			</div>
		{/each}

		<div class="virtual-spacer" style={`height: ${bottomSpacerHeight}px;`}></div>
	{/if}
</div>

<style>
	.threads-list {
		margin-top: 16px;
	}

	.virtual-row {
		display: flow-root;
	}

	.virtual-spacer {
		width: 100%;
		pointer-events: none;
	}

	@keyframes shatter-out {
		0% { opacity: 1; transform: scale(1); }
		50% { opacity: 0.6; transform: scale(0.97) rotate(1deg); }
		100% { opacity: 0; transform: scale(0.9) rotate(2deg); filter: blur(2px); }
	}

	@keyframes appear-in {
		0% { opacity: 0; transform: scale(0.95); }
		100% { opacity: 1; transform: scale(1); }
	}

	@keyframes thread-glow {
		0%, 100% { box-shadow: 0 0 0 3px transparent; }
		20%, 80% { box-shadow: 0 0 12px 3px var(--accent); }
	}

	.thread-highlight {
		animation: thread-glow 3s ease-in-out forwards;
		border-radius: 12px;
	}

	.threads-list.shattering {
		animation: shatter-out 400ms ease-in forwards;
	}

	.threads-list.appearing {
		animation: appear-in 300ms ease-out forwards;
	}
</style>
