<script lang="ts">
	import { openLightbox } from '$lib/stores/lightbox';
	import {
		collectXThreadPosts,
		type XArchivePost,
		type XArchiveThread,
		xArchivePostHasImages
	} from '$lib/api/x';
	import {
		buildFuzzyTextMatcher,
		fuzzyTextMatchRanges,
		fuzzyTextMatches,
		type FuzzyTextMatcher
	} from '$lib/utils/fuzzySearch';

	type GalleryContentMode = 'all' | 'images';
	type GalleryGroupMode = 'threads' | 'posts';
	type SearchMode = 'fuzzy' | 'literal';
	type GalleryImage = NonNullable<NonNullable<XArchivePost['embed']>['images']>[number];
	type HighlightRange = {
		start: number;
		end: number;
	};
	type HighlightSegment = {
		text: string;
		hit: boolean;
	};
	type GalleryMatcher =
		| {
				mode: 'none';
		  }
		| {
				mode: 'literal';
				literal: string;
		  }
		| {
				mode: 'fuzzy';
				literal: string;
				fuzzy: FuzzyTextMatcher;
		  }
		| {
				mode: 'regex';
				regex: RegExp;
		  };
	type GalleryPostItem = {
		post: XArchivePost;
		postNumber: number;
		segments: HighlightSegment[];
		matched: boolean;
	};

	type GalleryEntry =
		| {
				kind: 'thread';
				key: string;
				thread: XArchiveThread;
				post: XArchivePost;
				totalPosts: number;
		  }
		| {
				kind: 'post';
				key: string;
				thread: XArchiveThread;
				post: XArchivePost;
				totalPosts: number;
		  };

	let {
		threads,
		contentMode = 'all',
		groupMode = 'threads',
		gridZoom = 100,
		searchQuery = '',
		searchMode = 'fuzzy',
		onblog,
		onopenx
	}: {
		threads: XArchiveThread[];
		contentMode?: GalleryContentMode;
		groupMode?: GalleryGroupMode;
		gridZoom?: number;
		searchQuery?: string;
		searchMode?: SearchMode;
		onblog?: (rootUri: string) => void;
		onopenx?: (rootUri: string) => void;
	} = $props();

	const normalizedZoom = $derived(Math.max(70, Math.min(160, gridZoom)));
	const tileMin = $derived(Math.round(210 * (normalizedZoom / 100)));
	const matcher = $derived(parseMatcher(searchQuery, searchMode));
	let matchCursorByEntryKey: Record<string, number> = $state({});

	function threadPosts(thread: XArchiveThread): XArchivePost[] {
		return collectXThreadPosts(thread.rootPost);
	}

	function firstImageForPost(post: XArchivePost): GalleryImage | null {
		return post.embed?.images?.[0] ?? null;
	}

	function firstImageForThread(thread: XArchiveThread): GalleryImage | null {
		for (const post of threadPosts(thread)) {
			const image = firstImageForPost(post);
			if (image) return image;
		}
		return null;
	}

	function postMatchesContent(post: XArchivePost): boolean {
		return contentMode === 'all' || xArchivePostHasImages(post);
	}

	function postSearchText(post: XArchivePost): string {
		return `${post.text}\n${post.linkedUrls.join('\n')}`;
	}

	function parseMatcher(query: string, mode: SearchMode): GalleryMatcher {
		const trimmed = query.trim();
		if (!trimmed) return { mode: 'none' };

		if (mode === 'literal') {
			return {
				mode: 'literal',
				literal: trimmed
			};
		}

		if (!trimmed.startsWith('/')) {
			return {
				mode: 'fuzzy',
				literal: trimmed,
				fuzzy: buildFuzzyTextMatcher(trimmed)
			};
		}

		let closingSlash = -1;
		let escapeNext = false;
		for (let i = 1; i < trimmed.length; i += 1) {
			if (trimmed[i] === '\\' && !escapeNext) {
				escapeNext = true;
				continue;
			}
			if (trimmed[i] === '/' && !escapeNext) closingSlash = i;
			escapeNext = false;
		}

		if (closingSlash <= 0) {
			return {
				mode: 'fuzzy',
				literal: trimmed,
				fuzzy: buildFuzzyTextMatcher(trimmed)
			};
		}

		try {
			const pattern = trimmed.slice(1, closingSlash);
			const rawFlags = trimmed.slice(closingSlash + 1).toLowerCase();
			const flags = rawFlags.includes('i') ? rawFlags : `${rawFlags}i`;
			return { mode: 'regex', regex: new RegExp(pattern, flags) };
		} catch {
			return {
				mode: 'fuzzy',
				literal: trimmed,
				fuzzy: buildFuzzyTextMatcher(trimmed)
			};
		}
	}

	function postMatchesSearch(post: XArchivePost, activeMatcher: GalleryMatcher): boolean {
		if (activeMatcher.mode === 'none') return true;
		const haystack = postSearchText(post);
		if (activeMatcher.mode === 'regex') {
			activeMatcher.regex.lastIndex = 0;
			return activeMatcher.regex.test(haystack);
		}
		const literal = activeMatcher.literal.toLowerCase();
		const hasLiteralMatch = haystack.toLowerCase().includes(literal);
		if (activeMatcher.mode === 'literal') return hasLiteralMatch;
		return hasLiteralMatch || fuzzyTextMatches(haystack, activeMatcher.fuzzy);
	}

	function firstMatchingPost(thread: XArchiveThread): XArchivePost {
		const trimmed = searchQuery.trim();
		if (!trimmed) return thread.rootPost;
		return (
			threadPosts(thread).find((post) => postMatchesSearch(post, matcher)) ?? thread.rootPost
		);
	}

	function threadMatchesContent(thread: XArchiveThread): boolean {
		if (contentMode === 'all') return true;
		return threadPosts(thread).some(postMatchesContent);
	}

	const entries = $derived.by<GalleryEntry[]>(() => {
		if (groupMode === 'posts') {
			const result: GalleryEntry[] = [];
			for (const thread of threads) {
				const posts = threadPosts(thread);
				for (const post of posts) {
					if (!postMatchesContent(post)) continue;
					if (!postMatchesSearch(post, matcher)) continue;
					result.push({
						kind: 'post',
						key: `${thread.rootUri}:${post.uri}`,
						thread,
						post,
						totalPosts: posts.length
					});
				}
			}
			return result;
		}

		return threads
			.filter(threadMatchesContent)
			.map((thread) => ({
				kind: 'thread' as const,
				key: thread.rootUri,
				thread,
				post: firstMatchingPost(thread),
				totalPosts: thread.postCount
			}));
	});

	function literalRanges(text: string, literal: string): HighlightRange[] {
		const needle = literal.toLowerCase();
		if (!needle) return [];

		const haystack = text.toLowerCase();
		const ranges: HighlightRange[] = [];
		let start = haystack.indexOf(needle);
		while (start !== -1) {
			ranges.push({ start, end: start + literal.length });
			start = haystack.indexOf(needle, start + Math.max(1, literal.length));
		}
		return ranges;
	}

	function regexRanges(text: string, regex: RegExp): HighlightRange[] {
		const flags = regex.flags.includes('g') ? regex.flags : `${regex.flags}g`;
		const globalRegex = new RegExp(regex.source, flags);
		const ranges: HighlightRange[] = [];
		let match: RegExpExecArray | null;

		while ((match = globalRegex.exec(text)) !== null) {
			const value = match[0];
			if (!value) {
				globalRegex.lastIndex += 1;
				continue;
			}
			ranges.push({ start: match.index, end: match.index + value.length });
		}

		return ranges;
	}

	function highlightRanges(text: string, activeMatcher: GalleryMatcher): HighlightRange[] {
		if (activeMatcher.mode === 'literal') return literalRanges(text, activeMatcher.literal);
		if (activeMatcher.mode === 'fuzzy') {
			const ranges = literalRanges(text, activeMatcher.literal);
			return ranges.length > 0 ? ranges : fuzzyTextMatchRanges(text, activeMatcher.fuzzy);
		}
		if (activeMatcher.mode === 'regex') return regexRanges(text, activeMatcher.regex);
		return [];
	}

	function mergeRanges(ranges: HighlightRange[]): HighlightRange[] {
		const sorted = [...ranges]
			.filter((range) => range.end > range.start)
			.sort((a, b) => a.start - b.start || a.end - b.end);
		const merged: HighlightRange[] = [];

		for (const range of sorted) {
			const previous = merged[merged.length - 1];
			if (!previous || range.start > previous.end) {
				merged.push({ ...range });
			} else {
				previous.end = Math.max(previous.end, range.end);
			}
		}

		return merged;
	}

	function clamp(value: number, min: number, max: number): number {
		return Math.max(min, Math.min(max, value));
	}

	function buildSegments(text: string, ranges: HighlightRange[]): HighlightSegment[] {
		const merged = mergeRanges(ranges);
		if (merged.length === 0) return [{ text, hit: false }];

		const segments: HighlightSegment[] = [];
		let cursor = 0;
		for (const range of merged) {
			const start = clamp(range.start, 0, text.length);
			const end = clamp(range.end, 0, text.length);
			if (end <= cursor) continue;
			if (start > cursor) {
				segments.push({ text: text.slice(cursor, start), hit: false });
			}
			segments.push({ text: text.slice(Math.max(cursor, start), end), hit: true });
			cursor = end;
		}
		if (cursor < text.length) {
			segments.push({ text: text.slice(cursor), hit: false });
		}

		return segments.filter((segment) => segment.text.length > 0);
	}

	function buildPostItem(post: XArchivePost, postNumber: number): GalleryPostItem {
		const ranges = highlightRanges(post.text, matcher);
		return {
			post,
			postNumber,
			segments: buildSegments(post.text, ranges),
			matched: ranges.length > 0 || postMatchesSearch(post, matcher)
		};
	}

	function displayImage(entry: GalleryEntry): GalleryImage | null {
		if (entry.kind === 'post') return firstImageForPost(entry.post);
		return firstImageForThread(entry.thread);
	}

	function tilePosts(entry: GalleryEntry): GalleryPostItem[] {
		const posts = threadPosts(entry.thread);
		if (entry.kind === 'thread') {
			return posts.map((post, index) => buildPostItem(post, index + 1));
		}
		const postIndex = posts.findIndex((post) => post.uri === entry.post.uri);
		return [buildPostItem(entry.post, postIndex >= 0 ? postIndex + 1 : 1)];
	}

	function matchingPostUris(posts: GalleryPostItem[]): string[] {
		if (!searchQuery.trim()) return [];
		return posts.filter((post) => post.matched).map((post) => post.post.uri);
	}

	function getMatchCursor(entryKey: string, posts: GalleryPostItem[]): number {
		const matches = matchingPostUris(posts);
		if (matches.length === 0) return 0;
		return clamp(matchCursorByEntryKey[entryKey] ?? 0, 0, matches.length - 1);
	}

	function activeMatchUri(entryKey: string, posts: GalleryPostItem[]): string | null {
		const matches = matchingPostUris(posts);
		if (matches.length === 0) return null;
		return matches[getMatchCursor(entryKey, posts)] ?? matches[0] ?? null;
	}

	function cssEscape(value: string): string {
		return globalThis.CSS?.escape?.(value) ?? value.replace(/["\\]/g, '\\$&');
	}

	function scrollTileToPost(entryKey: string, postUri: string) {
		if (typeof document === 'undefined') return;
		const tile = document.querySelector<HTMLElement>(`[data-gallery-entry="${cssEscape(entryKey)}"]`);
		const post = tile?.querySelector<HTMLElement>(`[data-post-uri="${cssEscape(postUri)}"]`);
		post?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
	}

	function stepMatch(entryKey: string, posts: GalleryPostItem[], direction: number) {
		const matches = matchingPostUris(posts);
		if (matches.length <= 1) return;
		const next = (getMatchCursor(entryKey, posts) + direction + matches.length) % matches.length;
		matchCursorByEntryKey = {
			...matchCursorByEntryKey,
			[entryKey]: next
		};
		setTimeout(() => scrollTileToPost(entryKey, matches[next]), 0);
	}

	function entryEngagement(entry: GalleryEntry) {
		const posts = entry.kind === 'thread' ? threadPosts(entry.thread) : [entry.post];
		return posts.reduce(
			(totals, post) => ({
				likeCount: totals.likeCount + post.likeCount,
				repostCount: totals.repostCount + post.repostCount,
				replyCount: totals.replyCount + post.replyCount,
				quoteCount: totals.quoteCount + post.quoteCount
			}),
			{ likeCount: 0, repostCount: 0, replyCount: 0, quoteCount: 0 }
		);
	}

	function formatDate(iso: string): string {
		const d = new Date(iso);
		return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
	}

	function formatCount(value: number): string {
		if (value < 1000) return value.toLocaleString();
		return new Intl.NumberFormat('en-US', {
			notation: 'compact',
			maximumFractionDigits: 1
		}).format(value);
	}
</script>

<div class="x-gallery" style={`--tile-min: ${tileMin}px;`}>
	{#each entries as entry (entry.key)}
		{@const image = displayImage(entry)}
		{@const engagement = entryEngagement(entry)}
		{@const postItems = tilePosts(entry)}
		{@const matchUris = matchingPostUris(postItems)}
		{@const currentMatchUri = activeMatchUri(entry.key, postItems)}
		<article
			class="x-gallery-tile"
			class:has-image={Boolean(image)}
			class:thread-entry={entry.kind === 'thread'}
			class:post-entry={entry.kind === 'post'}
			data-gallery-entry={entry.key}
		>
			{#if image}
				<button
					type="button"
					class="tile-image-button"
					aria-label="Open image"
					onclick={() => openLightbox(image.fullsize, image.alt)}
				>
					<img src={image.thumb} alt={image.alt} class="tile-image" loading="lazy" />
				</button>
			{/if}

			<div class="tile-copy">
				<div class="tile-meta">
					<span>{entry.kind === 'thread' ? `${entry.thread.depth} deep` : 'post'}</span>
					<span>{entry.kind === 'thread' ? `${entry.thread.postCount} posts` : `${entry.totalPosts} in chain`}</span>
					<span>
						{entry.kind === 'thread'
							? entry.thread.characterLength.toLocaleString()
							: entry.post.characterLength.toLocaleString()} chars
					</span>
					{#if searchQuery.trim() && matchUris.length > 0}
						<span class="match-label">{matchUris.length} hit{matchUris.length !== 1 ? 's' : ''}</span>
					{/if}
				</div>

				{#if searchQuery.trim() && matchUris.length > 0}
					<div class="match-nav" aria-label="Tile search matches">
						<span>{getMatchCursor(entry.key, postItems) + 1} / {matchUris.length}</span>
						<button
							type="button"
							class="match-nav-btn"
							disabled={matchUris.length <= 1}
							onclick={() => stepMatch(entry.key, postItems, -1)}
						>
							Prev
						</button>
						<button
							type="button"
							class="match-nav-btn"
							disabled={matchUris.length <= 1}
							onclick={() => stepMatch(entry.key, postItems, 1)}
						>
							Next
						</button>
					</div>
				{/if}

				<div class="tile-text">
					{#each postItems as item (item.post.uri)}
						<section
							class="tile-post"
							class:matched-post={item.matched}
							class:current-match={currentMatchUri === item.post.uri}
							data-post-uri={item.post.uri}
						>
							{#if entry.kind === 'thread'}
								<span class="tile-post-index">{item.postNumber} / {postItems.length}</span>
							{/if}
							<p class="tile-post-text">
								{#each item.segments as segment}
									<span class:search-hit={segment.hit}>{segment.text}</span>
								{/each}
							</p>
						</section>
					{/each}
				</div>

				<div class="tile-footer">
					<span>{formatDate(entry.post.createdAt)}</span>
					<span>{formatCount(engagement.likeCount)} likes</span>
					<span>{formatCount(engagement.repostCount)} reposts</span>
					{#if engagement.replyCount > 0}
						<span>{formatCount(engagement.replyCount)} replies</span>
					{/if}
					{#if engagement.quoteCount > 0}
						<span>{formatCount(engagement.quoteCount)} quotes</span>
					{/if}
				</div>

				<div class="tile-actions">
					{#if onblog}
						<button type="button" class="tile-action" onclick={() => onblog(entry.thread.rootUri)}>
							XBlog
						</button>
					{/if}
					{#if onopenx}
						<button type="button" class="tile-action" onclick={() => onopenx(entry.thread.rootUri)}>
							Open on X
						</button>
					{/if}
				</div>
			</div>
		</article>
	{/each}
</div>

<style>
	.x-gallery {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(min(100%, var(--tile-min)), 1fr));
		gap: 14px;
		margin-top: 18px;
	}

	.x-gallery-tile {
		display: flex;
		flex-direction: column;
		min-height: 330px;
		overflow: hidden;
		border: 1.5px solid var(--control-border);
		border-radius: 8px;
		background: color-mix(in srgb, var(--card-bg) 94%, white 6%);
		box-shadow: var(--shadow-soft);
	}

	.x-gallery-tile.thread-entry,
	.x-gallery-tile.post-entry {
		height: clamp(440px, 58vh, 680px);
	}

	.tile-image-button {
		display: block;
		width: 100%;
		height: clamp(92px, 12vw, 150px);
		padding: 0;
		overflow: hidden;
		border: 0;
		background: color-mix(in srgb, var(--muted) 12%, transparent);
		cursor: zoom-in;
	}

	.tile-image {
		width: 100%;
		height: 100%;
		object-fit: cover;
		display: block;
		transition: transform 0.18s ease;
	}

	.tile-image-button:hover .tile-image {
		transform: scale(1.025);
	}

	.tile-copy {
		display: flex;
		flex: 1;
		min-height: 0;
		flex-direction: column;
		gap: 10px;
		padding: 12px;
	}

	.tile-meta,
	.tile-footer {
		display: flex;
		flex-wrap: wrap;
		gap: 6px 9px;
		color: var(--muted);
		font-family: Inter, system-ui, sans-serif;
		font-size: 0.76rem;
		line-height: 1.25;
	}

	.tile-meta span:first-child {
		color: var(--accent);
		font-weight: 800;
	}

	.match-label {
		color: var(--accent);
		font-weight: 800;
	}

	.match-nav {
		display: flex;
		align-items: center;
		justify-content: flex-end;
		gap: 6px;
		margin: -3px 0 0;
		color: var(--muted);
		font-family: Inter, system-ui, sans-serif;
		font-size: 0.74rem;
	}

	.match-nav-btn {
		padding: 2px 7px;
		border: 1px solid color-mix(in srgb, var(--accent) 58%, transparent);
		border-radius: 999px;
		background: color-mix(in srgb, var(--card-bg) 90%, white 10%);
		color: var(--accent);
		font-family: inherit;
		font-size: 0.72rem;
		line-height: 1.2;
		cursor: pointer;
	}

	.match-nav-btn:hover:not(:disabled),
	.match-nav-btn:focus-visible {
		border-color: var(--accent);
		background: color-mix(in srgb, var(--accent) 10%, var(--card-bg));
	}

	.match-nav-btn:disabled {
		cursor: default;
		opacity: 0.45;
	}

	.tile-text {
		flex: 1;
		min-height: 0;
		max-height: 180px;
		margin: 0;
		padding-right: 4px;
		overflow-y: auto;
	}

	.x-gallery-tile.thread-entry .tile-text,
	.x-gallery-tile.post-entry .tile-text {
		max-height: none;
	}

	.tile-post {
		padding: 0 0 12px;
		margin: 0 0 12px;
		border-bottom: 1px solid color-mix(in srgb, var(--control-border) 40%, transparent);
		scroll-margin: 10px;
	}

	.tile-post:last-child {
		margin-bottom: 0;
		border-bottom: 0;
	}

	.tile-post.matched-post {
		border-color: color-mix(in srgb, var(--accent) 42%, transparent);
	}

	.tile-post.current-match {
		padding: 8px 8px 10px;
		border-left: 3px solid var(--accent);
		border-bottom-color: transparent;
		border-radius: 6px;
		background: color-mix(in srgb, var(--accent) 7%, transparent);
	}

	.tile-post-index {
		display: inline-flex;
		margin-bottom: 5px;
		color: var(--accent);
		font-family: Inter, system-ui, sans-serif;
		font-size: 0.72rem;
		font-weight: 800;
	}

	.tile-post-text {
		margin: 0;
		color: var(--text-ink);
		font-size: 0.96rem;
		line-height: 1.38;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}

	.search-hit {
		background: color-mix(in srgb, var(--accent) 24%, #fff58a);
		color: var(--text-ink);
		border-radius: 3px;
		padding: 0 2px;
		box-decoration-break: clone;
		-webkit-box-decoration-break: clone;
	}

	.tile-text::-webkit-scrollbar {
		width: 7px;
	}

	.tile-text::-webkit-scrollbar-thumb {
		border-radius: 999px;
		background: color-mix(in srgb, var(--muted) 34%, transparent);
	}

	.tile-footer {
		margin-top: auto;
	}

	.tile-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}

	.tile-action {
		padding: 4px 9px;
		border: 1px solid var(--control-border);
		border-radius: 6px;
		background: var(--card-bg);
		color: var(--muted);
		font: inherit;
		font-size: 0.78rem;
		cursor: pointer;
	}

	.tile-action:hover {
		color: var(--accent);
		border-color: var(--accent);
	}

	@media (max-width: 640px) {
		.x-gallery {
			grid-template-columns: 1fr;
		}
	}
</style>
