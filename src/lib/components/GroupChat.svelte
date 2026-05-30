<script lang="ts">
	import { onMount, tick } from 'svelte';
	import type { SelfReplyThread } from '$lib/types';
	import LinkedPostEmbeds from '$lib/components/LinkedPostEmbeds.svelte';
	import ThreadExportButton from '$lib/components/ThreadExportButton.svelte';
	import { flattenThreadForChat, type ChatFlatPost } from '$lib/utils/threadFlattener';
	import { buildBskyPostUrl } from '$lib/utils/viewerLinks';
	import { openLightbox } from '$lib/stores/lightbox';

	interface Props {
		thread: SelfReplyThread;
		fullHeight?: boolean;
		showExport?: boolean;
		branchOptionsByUri?: Map<string, ChatBranchOption[]>;
		quoteStateByUri?: Map<string, ChatQuoteState>;
		scrollToPostRequest?: ChatScrollRequest | null;
		onbranchselect?: (leafUri: string) => void;
		onquoteload?: (postUri: string, fetchAll?: boolean) => void;
		onquoteselect?: (sourceUri: string, quoteUri: string, authorHandle: string) => void;
		onquoteall?: (postUri: string) => void;
		onpostselect?: (uri: string) => void;
		onactivepostchange?: (uri: string) => void;
	}

	interface ChatBranchOption {
		branchUri: string;
		leafUri: string;
		authorName: string;
		authorHandle: string;
		avatar?: string;
		text: string;
		postCount: number;
		longestChainLength: number;
	}

	interface ChatAuthorGroup {
		key: string;
		items: ChatFlatPost[];
		dateKey: string;
	}

	interface ChatScrollRequest {
		uri: string;
		nonce: number;
	}

	interface ChatQuoteOption {
		uri: string;
		authorName: string;
		authorHandle: string;
		avatar?: string;
		text: string;
		createdAt: string;
		isOpen?: boolean;
	}

	interface ChatQuoteState {
		quoteCount: number;
		status: 'idle' | 'loading' | 'ready' | 'error';
		options: ChatQuoteOption[];
		hasMore?: boolean;
		loadedAll?: boolean;
		loadingMode?: 'page' | 'all';
		error?: string;
		quotedRecord?: ChatQuoteOption;
	}

	const {
		thread,
		fullHeight = false,
		showExport = true,
		branchOptionsByUri = new Map(),
		quoteStateByUri = new Map(),
		scrollToPostRequest = null,
		onbranchselect,
		onquoteload,
		onquoteselect,
		onquoteall,
		onpostselect,
		onactivepostchange
	}: Props = $props();
	let openBranchMenus = $state<Set<string>>(new Set());
	let openQuoteMenus = $state<Set<string>>(new Set());
	let quoteSearchByUri = $state<Record<string, string>>({});
	let chatContainer = $state<HTMLDivElement | null>(null);
	let activePostUri: string | null = null;

	const AUTHOR_COLORS = [
		'#e07a5f', '#3d85c6', '#6aa84f', '#8e7cc3',
		'#c27ba0', '#e69138', '#76a5af', '#a64d79',
		'#6d9eeb', '#93c47d'
	];

	function hashDid(did: string): number {
		let hash = 0;
		for (let i = 0; i < did.length; i++) {
			hash = ((hash << 5) - hash + did.charCodeAt(i)) | 0;
		}
		return Math.abs(hash);
	}

	function getAuthorColor(did: string): string {
		return AUTHOR_COLORS[hashDid(did) % AUTHOR_COLORS.length];
	}

	function formatTime(dateStr: string): string {
		const d = new Date(dateStr);
		return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
	}

	function formatDate(dateStr: string): string {
		const d = new Date(dateStr);
		return d.toLocaleDateString([], { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
	}

	function getDateKey(dateStr: string): string {
		const d = new Date(dateStr);
		return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
	}

	function groupConsecutiveAuthorPosts(items: ChatFlatPost[]): ChatAuthorGroup[] {
		const groups: ChatAuthorGroup[] = [];

		for (const item of items) {
			const dateKey = getDateKey(item.post.createdAt);
			const previous = groups[groups.length - 1];

			if (
				previous &&
				previous.dateKey === dateKey &&
				previous.items[0]?.post.author.did === item.post.author.did
			) {
				previous.items.push(item);
				continue;
			}

			groups.push({
				key: `${item.post.uri}:${groups.length}`,
				items: [item],
				dateKey
			});
		}

		return groups;
	}

	function branchOptionsFor(uri: string): ChatBranchOption[] {
		return [...(branchOptionsByUri.get(uri) ?? [])].sort((a, b) => {
			const chainDelta = b.longestChainLength - a.longestChainLength;
			if (chainDelta !== 0) return chainDelta;

			const postDelta = b.postCount - a.postCount;
			if (postDelta !== 0) return postDelta;

			return a.authorName.localeCompare(b.authorName);
		});
	}

	function quoteStateFor(uri: string): ChatQuoteState | null {
		return quoteStateByUri.get(uri) ?? null;
	}

	function quoteOptionsFor(uri: string): ChatQuoteOption[] {
		const state = quoteStateFor(uri);
		if (!state) return [];
		const query = (quoteSearchByUri[uri] ?? '').trim().toLowerCase();
		const options = state.options;
		if (!query) return options;
		return options.filter((option) => {
			return (
				option.text.toLowerCase().includes(query) ||
				option.authorName.toLowerCase().includes(query) ||
				option.authorHandle.toLowerCase().includes(query)
			);
		});
	}

	function toggleQuoteMenu(uri: string) {
		const next = new Set(openQuoteMenus);
		if (next.has(uri)) {
			next.delete(uri);
		} else {
			next.add(uri);
			const state = quoteStateFor(uri);
			if (state && state.status === 'idle' && state.quoteCount > 0) {
				onquoteload?.(uri, false);
			}
		}
		openQuoteMenus = next;
	}

	function formatShortDate(dateStr: string): string {
		const d = new Date(dateStr);
		return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
	}

	function postUrl(uri: string, handle: string): string | null {
		return buildBskyPostUrl(uri, handle);
	}

	function scrollPostIntoView(uri: string) {
		if (!chatContainer) return;

		const entry = Array.from(
			chatContainer.querySelectorAll<HTMLElement>('[data-chat-post-uri]')
		).find((candidate) => candidate.dataset.chatPostUri === uri);

		entry?.scrollIntoView({
			behavior: 'smooth',
			block: 'center'
		});
	}

	function toggleBranchMenu(uri: string) {
		const next = new Set(openBranchMenus);
		if (next.has(uri)) {
			next.delete(uri);
		} else {
			next.add(uri);
		}
		openBranchMenus = next;
	}

	function selectBranch(parentUri: string, leafUri: string) {
		const next = new Set(openBranchMenus);
		next.delete(parentUri);
		openBranchMenus = next;
		onbranchselect?.(leafUri);
	}

	function handleEntryClick(event: MouseEvent, uri: string) {
		const target = event.target;
		if (
			target instanceof Element &&
			target.closest('a, button, img, video, input, textarea, select')
		) {
			return;
		}
		onpostselect?.(uri);
	}

	function handleEntryKeydown(event: KeyboardEvent, uri: string) {
		if (event.currentTarget !== event.target) return;
		if (event.key !== 'Enter' && event.key !== ' ') return;
		event.preventDefault();
		onpostselect?.(uri);
	}

	function handleReplyQuoteClick(event: MouseEvent, uri: string) {
		event.stopPropagation();
		onpostselect?.(uri);
		scrollPostIntoView(uri);
	}

	function updateActivePostFromScroll() {
		if (!chatContainer || !onactivepostchange) return;

		const containerRect = chatContainer.getBoundingClientRect();
		const entries = Array.from(
			chatContainer.querySelectorAll<HTMLElement>('[data-chat-post-uri]')
		);
		let bestUri = '';
		let bestDistance = Number.POSITIVE_INFINITY;

		for (const entry of entries) {
			const rect = entry.getBoundingClientRect();
			if (rect.bottom < containerRect.top + 6 || rect.top > containerRect.bottom) continue;
			const distance = Math.abs(rect.top - containerRect.top);
			if (distance < bestDistance) {
				bestDistance = distance;
				bestUri = entry.dataset.chatPostUri ?? '';
			}
		}

		if (bestUri && bestUri !== activePostUri) {
			activePostUri = bestUri;
			onactivepostchange(bestUri);
		}
	}

	function previewText(text: string): string {
		const trimmed = text.replace(/\s+/g, ' ').trim();
		if (!trimmed) return 'No text';
		return trimmed.length > 160 ? `${trimmed.slice(0, 160)}...` : trimmed;
	}

	const chatPosts = $derived(flattenThreadForChat(thread.rootPost));
	const chatGroups = $derived(groupConsecutiveAuthorPosts(chatPosts));

	onMount(() => {
		void tick().then(updateActivePostFromScroll);
	});

	$effect(() => {
		chatPosts;
		void tick().then(updateActivePostFromScroll);
	});

	$effect(() => {
		const request = scrollToPostRequest;
		if (!request?.uri) return;
		void tick().then(() => scrollPostIntoView(request.uri));
	});
</script>

<div bind:this={chatContainer} class="group-chat" class:full-height={fullHeight} onscroll={updateActivePostFromScroll}>
	{#if showExport}
		<div class="chat-export-bar">
			<ThreadExportButton {thread} compact />
		</div>
	{/if}

	{#each chatGroups as group, i (group.key)}
		{@const firstItem = group.items[0]}
		{@const prevDateKey = i > 0 ? chatGroups[i - 1].dateKey : null}
		{@const color = getAuthorColor(firstItem.post.author.did)}

		{#if group.dateKey !== prevDateKey}
			<div class="date-separator">
				<span class="date-label">{formatDate(firstItem.post.createdAt)}</span>
			</div>
		{/if}

		<div class="chat-message has-header">
			{#if firstItem}
				<div class="author-header">
					{#if firstItem.post.author.avatar}
						<img src={firstItem.post.author.avatar} alt="" class="author-avatar" />
					{:else}
						<div class="author-avatar-placeholder" style="background: {color}">
							{(firstItem.post.author.displayName || firstItem.post.author.handle).charAt(0).toUpperCase()}
						</div>
					{/if}
					<span class="author-name" style="color: {color}">
						{firstItem.post.author.displayName || firstItem.post.author.handle}
					</span>
					<span class="author-handle">@{firstItem.post.author.handle}</span>
				</div>
			{/if}

			<div class="bubble" style="border-left-color: {color}">
				{#each group.items as item (item.post.uri)}
					{@const branchOptions = branchOptionsFor(item.post.uri)}
					{@const quoteState = quoteStateFor(item.post.uri)}
					{@const quoteOptions = quoteOptionsFor(item.post.uri)}
					{@const bskyPostUrl = postUrl(item.post.uri, item.post.author.handle)}
					<div
						class="bubble-entry"
						data-chat-post-uri={item.post.uri}
						role="button"
						tabindex="0"
						aria-label="Center this post in the tree"
						onclick={(event) => handleEntryClick(event, item.post.uri)}
						onkeydown={(event) => handleEntryKeydown(event, item.post.uri)}
					>
						{#if item.replyQuote}
							{@const quoteColor = getAuthorColor(item.replyQuote.author.did)}
							<button
								type="button"
								class="reply-quote"
								style="border-left-color: {quoteColor}"
								onclick={(event) => handleReplyQuoteClick(event, item.replyQuote!.uri)}
							>
								<span class="reply-quote-author" style="color: {quoteColor}">
									{item.replyQuote.author.displayName || item.replyQuote.author.handle}
								</span>
								<span class="reply-quote-text">
									{item.replyQuote.text.length > 120
										? item.replyQuote.text.slice(0, 120) + '...'
										: item.replyQuote.text}
								</span>
							</button>
						{/if}

						<p class="bubble-text">{item.post.text}</p>

						{#if item.post.embed}
							<div class="embed">
								{#if item.post.embed.images}
									<div class="embed-images">
										{#each item.post.embed.images as img}
											<img src={img.thumb} alt={img.alt} class="embed-image"
												 onclick={(e) => { e.stopPropagation(); openLightbox(img.fullsize, img.alt); }}
												 onkeydown={(e) => { if (e.key === 'Enter') openLightbox(img.fullsize, img.alt); }}
												 role="button" tabindex="0" style="cursor: pointer;" />
										{/each}
									</div>
								{/if}
								{#if item.post.embed.video}
									<div class="embed-video">
										<!-- svelte-ignore a11y_media_has_caption -->
										<video
											controls
											preload="none"
											poster={item.post.embed.video.thumbnail}
											style={item.post.embed.video.aspectRatio ? `aspect-ratio: ${item.post.embed.video.aspectRatio.width} / ${item.post.embed.video.aspectRatio.height}` : ''}
										>
											<source src={item.post.embed.video.playlist} type="application/x-mpegURL" />
										</video>
										{#if item.post.embed.video.alt}
											<p class="embed-video-alt">{item.post.embed.video.alt}</p>
										{/if}
									</div>
								{/if}
								{#if item.post.embed.external}
									<a href={item.post.embed.external.uri} target="_blank" rel="noopener noreferrer" class="embed-link">
										{#if item.post.embed.external.thumb}
											<img src={item.post.embed.external.thumb} alt="" class="embed-link-thumb" />
										{/if}
										<div class="embed-link-info">
											<strong>{item.post.embed.external.title}</strong>
											<span>{item.post.embed.external.description}</span>
										</div>
									</a>
								{/if}
								{#if item.post.embed.record}
									<div class="embed-quote">
										<div class="embed-quote-header">
											{#if item.post.embed.record.author.avatar}
												<img src={item.post.embed.record.author.avatar} alt="" class="embed-quote-avatar" />
											{/if}
											<span class="embed-quote-author">
												{item.post.embed.record.author.displayName || item.post.embed.record.author.handle}
											</span>
											<span class="embed-quote-handle">@{item.post.embed.record.author.handle}</span>
										</div>
										<p class="embed-quote-text">{item.post.embed.record.text}</p>
										{#if item.post.embed.record.images}
											<div class="embed-images">
												{#each item.post.embed.record.images as img}
													<img src={img.thumb} alt={img.alt} class="embed-image"
														 onclick={(e) => { e.stopPropagation(); openLightbox(img.fullsize, img.alt); }}
														 onkeydown={(e) => { if (e.key === 'Enter') openLightbox(img.fullsize, img.alt); }}
														 role="button" tabindex="0" style="cursor: pointer;" />
												{/each}
											</div>
										{/if}
									</div>
								{/if}
							</div>
						{/if}
						<LinkedPostEmbeds
							text={item.post.text}
							externalUri={item.post.embed?.external?.uri}
							urls={item.post.linkedUrls ?? []}
							excludeUris={[item.post.uri, item.post.embed?.record?.uri ?? '']}
						/>

						{#if branchOptions.length > 0}
							<div class="branch-picker">
								<button
									type="button"
									class="branch-picker-toggle"
									aria-expanded={openBranchMenus.has(item.post.uri)}
									onclick={(event) => {
										event.stopPropagation();
										toggleBranchMenu(item.post.uri);
									}}
								>
									<span aria-hidden="true">{openBranchMenus.has(item.post.uri) ? '-' : '+'}</span>
									{branchOptions.length} repl{branchOptions.length === 1 ? 'y' : 'ies'}
								</button>

								{#if openBranchMenus.has(item.post.uri)}
									<div class="branch-options">
										{#each branchOptions as option (option.branchUri)}
											<button
												type="button"
												class="branch-option"
												onclick={(event) => {
													event.stopPropagation();
													selectBranch(item.post.uri, option.leafUri);
												}}
											>
												{#if option.avatar}
													<img src={option.avatar} alt="" class="branch-option-avatar" />
												{:else}
													<span class="branch-option-avatar placeholder">
														{option.authorName.charAt(0).toUpperCase()}
													</span>
												{/if}
												<span class="branch-option-body">
													<span class="branch-option-header">
														<strong>{option.authorName}</strong>
														<span>@{option.authorHandle}</span>
													</span>
													<span class="branch-option-text">{previewText(option.text)}</span>
													<span class="branch-option-meta">
														{option.postCount} post{option.postCount === 1 ? '' : 's'} · longest {option.longestChainLength}
													</span>
												</span>
											</button>
										{/each}
									</div>
								{/if}
							</div>
						{/if}

						{#if quoteState}
							<div class="quote-picker">
								<button
									type="button"
									class="quote-picker-toggle"
									aria-expanded={openQuoteMenus.has(item.post.uri)}
									onclick={(event) => {
										event.stopPropagation();
										toggleQuoteMenu(item.post.uri);
									}}
								>
									<span aria-hidden="true">Q</span>
									{quoteState.quoteCount > 0
										? `${quoteState.quoteCount} quote${quoteState.quoteCount === 1 ? '' : 's'}`
										: 'Quote'}
								</button>

								{#if openQuoteMenus.has(item.post.uri)}
									<div class="quote-options">
										<div class="quote-actions">
											{#if quoteState.quotedRecord}
												{@const quotedRecord = quoteState.quotedRecord}
												<button
													type="button"
													class="quote-action-btn"
													onclick={(event) => {
															event.stopPropagation();
															onquoteselect?.(
																item.post.uri,
															quotedRecord.uri,
															quotedRecord.authorHandle
															);
														}}
												>
													Open quoted post
												</button>
											{/if}
											{#if quoteState.quoteCount > 0}
												<button
													type="button"
													class="quote-action-btn"
													disabled={quoteState.status === 'loading'}
													onclick={(event) => {
														event.stopPropagation();
														onquoteload?.(item.post.uri, false);
													}}
												>
													{quoteState.status === 'loading' && quoteState.loadingMode !== 'all'
														? 'Loading...'
														: quoteState.status === 'ready'
															? 'Refresh'
															: 'Load quotes'}
												</button>
												<button
													type="button"
													class="quote-action-btn primary"
													disabled={quoteState.status === 'loading'}
													onclick={(event) => {
														event.stopPropagation();
														onquoteall?.(item.post.uri);
													}}
												>
													{quoteState.status === 'loading' && quoteState.loadingMode === 'all'
														? 'Showing...'
														: 'Show all quoted posts'}
												</button>
											{/if}
										</div>

										{#if quoteState.options.length > 0}
											<input
												class="quote-search"
												type="search"
												placeholder="Search quotes"
												value={quoteSearchByUri[item.post.uri] ?? ''}
												onclick={(event) => event.stopPropagation()}
												oninput={(event) => {
													quoteSearchByUri = {
														...quoteSearchByUri,
														[item.post.uri]: event.currentTarget.value
													};
												}}
											/>
										{/if}

										{#if quoteState.status === 'error'}
											<p class="quote-status error">{quoteState.error || 'Could not load quote posts.'}</p>
										{:else if quoteOptions.length > 0}
											<div class="quote-option-list">
												{#each quoteOptions as option (option.uri)}
													<button
														type="button"
														class="quote-option"
														class:open={option.isOpen}
														onclick={(event) => {
															event.stopPropagation();
															onquoteselect?.(item.post.uri, option.uri, option.authorHandle);
														}}
													>
														{#if option.avatar}
															<img src={option.avatar} alt="" class="quote-option-avatar" />
														{:else}
															<span class="quote-option-avatar placeholder">
																{option.authorName.charAt(0).toUpperCase()}
															</span>
														{/if}
														<span class="quote-option-body">
															<span class="quote-option-header">
																<strong>@{option.authorHandle}</strong>
																<span>{formatShortDate(option.createdAt)}</span>
															</span>
															<span class="quote-option-text">{previewText(option.text)}</span>
															<span class="quote-option-action">{option.isOpen ? 'Jump to lane' : 'Create lane'}</span>
														</span>
													</button>
												{/each}
											</div>
										{:else if quoteState.status === 'loading'}
											<p class="quote-status">Loading quote posts...</p>
										{:else}
											<p class="quote-status">Load quote posts to choose lanes.</p>
										{/if}
									</div>
								{/if}
							</div>
						{/if}

						<div class="entry-footer">
							<span class="timestamp">{formatTime(item.post.createdAt)}</span>
							{#if bskyPostUrl}
								<a
									href={bskyPostUrl}
									target="_blank"
									rel="noopener noreferrer"
									class="bsky-post-link"
									aria-label="Open post on Bluesky"
									onclick={(event) => event.stopPropagation()}
								>
									Open
								</a>
							{/if}
						</div>
					</div>
				{/each}
			</div>
		</div>
	{/each}
</div>

<style>
	.group-chat {
		background: color-mix(in srgb, var(--bg-paper) 72%, var(--muted-surface));
		border-radius: 12px;
		padding: 16px 12px;
		max-height: 80vh;
		overflow-y: auto;
	}

	.group-chat.full-height {
		max-height: none;
	}

	.chat-export-bar {
		position: sticky;
		top: 0;
		z-index: 5;
		display: flex;
		justify-content: flex-end;
		padding: 0 0 8px;
		background: linear-gradient(
			180deg,
			color-mix(in srgb, var(--bg-paper) 72%, var(--muted-surface)) 78%,
			transparent
		);
	}

	.date-separator {
		text-align: center;
		margin: 16px 0 12px;
	}

	.date-label {
		background: var(--muted-surface);
		color: var(--muted);
		font-size: 0.75rem;
		padding: 4px 12px;
		border-radius: 8px;
		display: inline-block;
	}

	.chat-message {
		margin-bottom: 2px;
		padding-left: 48px;
	}

	.chat-message.has-header {
		margin-top: 12px;
	}

	.author-header {
		display: flex;
		align-items: center;
		gap: 8px;
		margin-bottom: 2px;
		margin-left: -48px;
	}

	.author-avatar {
		width: 32px;
		height: 32px;
		border-radius: 50%;
		flex-shrink: 0;
	}

	.author-avatar-placeholder {
		width: 32px;
		height: 32px;
		border-radius: 50%;
		display: flex;
		align-items: center;
		justify-content: center;
		color: white;
		font-size: 0.85rem;
		font-weight: bold;
		flex-shrink: 0;
	}

	.author-name {
		font-weight: bold;
		font-size: 0.9rem;
	}

	.author-handle {
		color: var(--muted);
		font-size: 0.75rem;
	}

	.reply-quote {
		display: block;
		width: 100%;
		background: color-mix(in srgb, var(--muted-surface) 74%, transparent);
		border-left: 3px solid var(--muted);
		border-top: 0;
		border-right: 0;
		border-bottom: 0;
		border-radius: 4px;
		padding: 4px 8px;
		margin-bottom: 2px;
		color: inherit;
		text-align: left;
		font-size: 0.8rem;
		max-width: 500px;
		cursor: pointer;
	}

	.reply-quote:hover,
	.reply-quote:focus-visible {
		background: color-mix(in srgb, var(--muted-surface) 92%, transparent);
	}

	.reply-quote-author {
		font-weight: bold;
		display: block;
		font-size: 0.75rem;
	}

	.reply-quote-text {
		color: var(--muted);
		display: block;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.bubble {
		background: var(--card-bg);
		border-radius: 0 8px 8px 8px;
		padding: 0 10px;
		display: inline-block;
		max-width: 500px;
		border-left: 3px solid var(--control-border);
		position: relative;
		word-break: break-word;
	}

	.bubble-entry {
		padding: 7px 0 6px;
		border-top: 1px solid var(--control-border);
		cursor: default;
	}

	.bubble-entry:first-child {
		border-top: 0;
	}

	.bubble-entry::after {
		content: '';
		display: block;
		clear: both;
	}

	.bubble-text {
		margin: 0;
		font-size: 0.92rem;
		line-height: 1.4;
		white-space: pre-wrap;
	}

	.timestamp {
		font-size: 0.65rem;
		color: var(--muted);
	}

	.entry-footer {
		display: flex;
		align-items: center;
		justify-content: flex-end;
		gap: 6px;
		margin-top: 5px;
	}

	.bsky-post-link {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-height: 20px;
		border-radius: 999px;
		background: color-mix(in srgb, #2f80c8 14%, var(--card-bg));
		color: color-mix(in srgb, #2f80c8 78%, var(--text-ink));
		font-size: 0.66rem;
		font-weight: 800;
		line-height: 1;
		padding: 3px 8px;
		text-decoration: none;
	}

	.bsky-post-link:hover,
	.bsky-post-link:focus-visible {
		background: color-mix(in srgb, #2f80c8 24%, var(--card-bg));
		color: color-mix(in srgb, #2f80c8 92%, var(--text-ink));
	}

	.branch-picker {
		clear: both;
		margin-top: 7px;
	}

	.branch-picker-toggle {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		min-height: 24px;
		border: 1px solid var(--control-border);
		border-radius: 999px;
		background: var(--muted-surface);
		color: var(--text-ink);
		font: inherit;
		font-size: 0.72rem;
		font-weight: 800;
		padding: 2px 9px;
	}

	.branch-picker-toggle span {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 13px;
		height: 13px;
		box-sizing: border-box;
		border-radius: 50%;
		background: rgba(224, 122, 95, 0.86);
		color: white;
		line-height: 1;
		font-size: 0.72em;
		padding-bottom: 1px;
	}

	.branch-options {
		display: grid;
		gap: 5px;
		margin-top: 6px;
		max-height: min(320px, 42vh);
		overflow-y: auto;
		overscroll-behavior: contain;
		padding-right: 2px;
		scrollbar-gutter: stable;
	}

	.branch-option {
		display: grid;
		grid-template-columns: 28px minmax(0, 1fr);
		gap: 7px;
		width: min(100%, 420px);
		border: 1px solid var(--control-border);
		border-radius: 8px;
		background: var(--card-bg);
		color: inherit;
		font: inherit;
		padding: 7px;
		text-align: left;
	}

	.branch-option:hover,
	.branch-option:focus-visible {
		border-color: rgba(224, 122, 95, 0.45);
		background: color-mix(in srgb, var(--accent) 10%, var(--card-bg));
	}

	.branch-option-avatar {
		width: 28px;
		height: 28px;
		border-radius: 50%;
		object-fit: cover;
	}

	.branch-option-avatar.placeholder {
		display: inline-grid;
		place-items: center;
		background: #8e7cc3;
		color: white;
		font-size: 0.78rem;
		font-weight: 800;
	}

	.branch-option-body {
		display: grid;
		gap: 2px;
		min-width: 0;
	}

	.branch-option-header {
		display: flex;
		align-items: baseline;
		gap: 5px;
		min-width: 0;
		font-size: 0.74rem;
	}

	.branch-option-header strong,
	.branch-option-header span {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.branch-option-header span {
		color: var(--muted);
	}

	.branch-option-text {
		display: -webkit-box;
		-webkit-line-clamp: 2;
		-webkit-box-orient: vertical;
		overflow: hidden;
		color: var(--text-ink);
		font-size: 0.76rem;
		line-height: 1.25;
	}

	.branch-option-meta {
		color: var(--muted);
		font-size: 0.68rem;
		font-weight: 800;
	}

	.quote-picker {
		clear: both;
		margin-top: 7px;
	}

	.quote-picker-toggle {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		min-height: 24px;
		border: 1px solid rgba(22, 101, 168, 0.18);
		border-radius: 999px;
		background: color-mix(in srgb, #2f80c8 14%, var(--card-bg));
		color: color-mix(in srgb, #2f80c8 80%, var(--text-ink));
		font: inherit;
		font-size: 0.72rem;
		font-weight: 800;
		padding: 2px 9px;
	}

	.quote-picker-toggle span {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 14px;
		height: 14px;
		box-sizing: border-box;
		border-radius: 50%;
		background: #2f80c8;
		color: white;
		font-size: 0.62rem;
		line-height: 1;
	}

	.quote-options {
		display: grid;
		gap: 7px;
		margin-top: 6px;
		max-height: min(360px, 46vh);
		overflow-y: auto;
		overscroll-behavior: contain;
		padding: 7px;
		border: 1px solid rgba(22, 101, 168, 0.14);
		border-radius: 9px;
		background: color-mix(in srgb, #2f80c8 7%, var(--card-bg));
		scrollbar-gutter: stable;
	}

	.quote-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 5px;
	}

	.quote-action-btn {
		min-height: 25px;
		border: 1px solid rgba(22, 101, 168, 0.16);
		border-radius: 999px;
		background: var(--card-bg);
		color: color-mix(in srgb, #2f80c8 80%, var(--text-ink));
		font: inherit;
		font-size: 0.7rem;
		font-weight: 800;
		padding: 3px 9px;
	}

	.quote-action-btn.primary {
		background: #2f80c8;
		color: white;
		border-color: #2f80c8;
	}

	.quote-action-btn:disabled {
		opacity: 0.55;
		cursor: progress;
	}

	.quote-search {
		width: 100%;
		min-height: 28px;
		border: 1px solid rgba(22, 101, 168, 0.18);
		border-radius: 7px;
		background: var(--card-bg);
		color: inherit;
		font: inherit;
		font-size: 0.74rem;
		padding: 4px 8px;
	}

	.quote-option-list {
		display: grid;
		gap: 5px;
	}

	.quote-option {
		display: grid;
		grid-template-columns: 28px minmax(0, 1fr);
		gap: 7px;
		width: min(100%, 430px);
		border: 1px solid rgba(22, 101, 168, 0.13);
		border-radius: 8px;
		background: var(--card-bg);
		color: inherit;
		font: inherit;
		padding: 7px;
		text-align: left;
	}

	.quote-option:hover,
	.quote-option:focus-visible,
	.quote-option.open {
		border-color: rgba(47, 128, 200, 0.42);
		background: color-mix(in srgb, #2f80c8 14%, var(--card-bg));
	}

	.quote-option-avatar {
		width: 28px;
		height: 28px;
		border-radius: 50%;
		object-fit: cover;
	}

	.quote-option-avatar.placeholder {
		display: inline-grid;
		place-items: center;
		background: #2f80c8;
		color: white;
		font-size: 0.78rem;
		font-weight: 800;
	}

	.quote-option-body {
		display: grid;
		gap: 2px;
		min-width: 0;
	}

	.quote-option-header {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 8px;
		min-width: 0;
		font-size: 0.74rem;
	}

	.quote-option-header strong,
	.quote-option-header span {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.quote-option-header span {
		color: var(--muted);
	}

	.quote-option-text {
		display: -webkit-box;
		-webkit-line-clamp: 2;
		-webkit-box-orient: vertical;
		overflow: hidden;
		color: var(--text-ink);
		font-size: 0.76rem;
		line-height: 1.25;
	}

	.quote-option-action,
	.quote-status {
		color: var(--muted);
		font-size: 0.68rem;
		font-weight: 800;
	}

	.quote-status {
		margin: 0;
	}

	.quote-status.error {
		color: #a33;
	}

	.embed {
		margin-top: 6px;
	}

	.embed-images {
		display: flex;
		gap: 4px;
		flex-wrap: wrap;
	}

	.embed-image {
		max-width: 200px;
		max-height: 200px;
		border-radius: 6px;
		object-fit: cover;
	}

	.embed-video video {
		max-width: 100%;
		max-height: 360px;
		border-radius: 6px;
		background: #000;
	}

	.embed-video-alt {
		font-size: 0.78rem;
		color: var(--muted);
		margin: 2px 0 0;
	}

	.embed-link {
		display: flex;
		gap: 8px;
		background: var(--link-card-bg);
		border-radius: 6px;
		padding: 6px;
		text-decoration: none;
		color: inherit;
	}

	.embed-link:hover {
		background: color-mix(in srgb, var(--accent) 10%, var(--link-card-bg));
	}

	.embed-link-thumb {
		width: 60px;
		height: 60px;
		border-radius: 4px;
		object-fit: cover;
		flex-shrink: 0;
	}

	.embed-link-info {
		display: flex;
		flex-direction: column;
		gap: 2px;
		font-size: 0.8rem;
		overflow: hidden;
	}

	.embed-link-info strong {
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.embed-link-info span {
		color: var(--muted);
		display: -webkit-box;
		-webkit-line-clamp: 2;
		-webkit-box-orient: vertical;
		overflow: hidden;
	}

	.embed-quote {
		background: var(--link-card-bg);
		border: 1px solid var(--control-border);
		border-radius: 8px;
		padding: 8px 10px;
		margin-top: 4px;
	}

	.embed-quote-header {
		display: flex;
		align-items: center;
		gap: 6px;
		margin-bottom: 4px;
	}

	.embed-quote-avatar {
		width: 18px;
		height: 18px;
		border-radius: 50%;
	}

	.embed-quote-author {
		font-weight: bold;
		font-size: 0.8rem;
		color: var(--text-ink);
	}

	.embed-quote-handle {
		font-size: 0.7rem;
		color: var(--muted);
	}

	.embed-quote-text {
		font-size: 0.85rem;
		line-height: 1.35;
		color: var(--text-ink);
		white-space: pre-wrap;
		margin: 0;
	}
</style>
