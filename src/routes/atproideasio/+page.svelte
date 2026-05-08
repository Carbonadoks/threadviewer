<script lang="ts">
	import { onMount } from 'svelte';
	import { browser } from '$app/environment';
	import '../../app.css';
	import {
		getFullThread,
		type PostSearchAgent,
		type ProfileInfo
	} from '$lib/api/bluesky';
	import {
		connectBlueskyWithPopup,
		getBlueskyOAuthDebugInfo,
		forgetStoredBlueskySessionLocally,
		hasBlueskySearchPostsScope,
		initAuthenticatedBlueskyClient,
		resetBlueskyOAuthClient,
		type BlueskyOAuthDebugInfo,
		type AuthenticatedBlueskyContext
	} from '$lib/api/blueskyAuth';
	import {
		BLUESKY_OAUTH_SCOPE,
		BLUESKY_SEARCH_POSTS_SCOPE,
		BLUESKY_SEARCH_POSTS_SCOPES
	} from '$lib/constants/blueskyOAuth';
	import FontPicker from '$lib/components/FontPicker.svelte';
	import LoadingSpinner from '$lib/components/LoadingSpinner.svelte';
	import PostEmbedPreview from '$lib/components/PostEmbedPreview.svelte';
	import RouteNav from '$lib/components/RouteNav.svelte';
	import type { SelfReplyThread, ThreadPost } from '$lib/types';
	import { flattenThread } from '$lib/utils/threadFlattener';
	import { buildBskyPostUrl } from '$lib/utils/viewerLinks';

	const IDEA_TAG = 'atproideasio';
	const SEARCH_AUTH_OPTIONS = {
		scope: BLUESKY_OAUTH_SCOPE,
		prompt: 'consent' as const
	};
	const SAVED_IDEAS_STORAGE_KEY = 'atproideasio.savedIdeas.v1';
	const DISMISSED_STORAGE_KEY = 'atproideasio.dismissedRootUris.v1';

	const fontFamilies: Record<string, string> = {
		virgil: "'Virgil', cursive",
		caveat: "'Caveat', cursive",
		patrick: "'Patrick Hand', cursive",
		'comic-neue': "'Comic Neue', cursive",
		inter: "'Inter', sans-serif",
		system: "system-ui, -apple-system, sans-serif"
	};

	type IdeaStatus = 'todo' | 'in_progress' | 'done';
	type IdeaPriority = 'low' | 'medium' | 'high';
	type SavedIdeasView = 'kanban' | 'list';
	type IssueField =
		| 'title'
		| 'userStory'
		| 'description'
		| 'acceptanceCriteria'
		| 'notes'
		| 'status'
		| 'priority';

	interface DraftIssue {
		title: string;
		userStory: string;
		description: string;
		acceptanceCriteria: string;
		notes: string;
		status: IdeaStatus;
		priority: IdeaPriority;
	}

	interface IdeaThread extends SelfReplyThread {
		isTruncated?: boolean;
	}

	interface IdeaCandidate {
		id: string;
		taggedPostUri: string;
		sourceUrl: string | null;
		thread: IdeaThread;
		includedUris: string[];
		issue: DraftIssue;
		fetchedAt: string;
	}

	interface SavedSourcePost {
		uri: string;
		authorHandle: string;
		authorDisplayName?: string;
		text: string;
		createdAt: string;
	}

	interface SavedIdea extends DraftIssue {
		id: string;
		rootUri: string;
		taggedPostUri: string;
		sourceUrl: string | null;
		keptPostUris: string[];
		sourcePosts: SavedSourcePost[];
		postCount: number;
		authorHandle: string;
		authorDisplayName?: string;
		createdAt: string;
		updatedAt: string;
	}

	interface TaggedPostSearchPage {
		posts: ThreadPost[];
		cursor?: string;
		hitsTotal?: number;
		searchMode?: string;
		warnings?: Array<{ label: string; status?: number; detail: string }>;
		message?: string;
		detail?: string;
		failures?: Array<{ label: string; status?: number; detail: string }>;
	}

	const IDEA_STATUS_COLUMNS: Array<{ id: IdeaStatus; label: string }> = [
		{ id: 'todo', label: 'Todo' },
		{ id: 'in_progress', label: 'In Progress' },
		{ id: 'done', label: 'Done' }
	];

	let fontKey = $state('patrick');
	let fontFamily = $derived(fontFamilies[fontKey] ?? fontFamilies.virgil);
	let candidates: IdeaCandidate[] = $state([]);
	let savedIdeas: SavedIdea[] = $state([]);
	let dismissedRootUris: string[] = $state([]);
	let activeCandidateId: string | null = $state(null);
	let loading = $state(false);
	let connecting = $state(false);
	let restoringSession = $state(true);
	let fetchPhase = $state('');
	let fetchCurrent = $state(0);
	let fetchTotal = $state(0);
	let fetchError: string | null = $state(null);
	let fetchWarnings: string[] = $state([]);
	let hitsTotal: number | null = $state(null);
	let authError: string | null = $state(null);
	let profile: ProfileInfo | null = $state(null);
	let sessionSub: string | null = $state(null);
	let grantedScope: string | null = $state(null);
	let oauthDebug: BlueskyOAuthDebugInfo | null = $state(null);
	let authAgent: PostSearchAgent | null = $state(null);
	let savedIdeasView: SavedIdeasView = $state('kanban');
	let activeFetchController: AbortController | null = null;

	const dismissedRootSet = $derived(new Set(dismissedRootUris));
	const sessionLabel = $derived.by(() => {
		if (profile) return `Connected as @${profile.handle}`;
		if (connecting) return 'Connecting to Bluesky...';
		if (restoringSession) return 'Restoring Bluesky session...';
		return 'Bluesky search requires sign-in';
	});
	const activeCandidate = $derived(
		candidates.find((candidate) => candidate.id === activeCandidateId) ?? candidates[0] ?? null
	);
	const activeFlatPosts = $derived(
		activeCandidate ? flattenThread(activeCandidate.thread.rootPost) : []
	);
	const activeKeptPostCount = $derived(activeCandidate?.includedUris.length ?? 0);
	const hasSavedIdeas = $derived(savedIdeas.length > 0);
	const hasGrantedSearchPostsScope = $derived(
		grantedScope ? hasBlueskySearchPostsScope(grantedScope) : false
	);
	const kanbanColumns = $derived(
		IDEA_STATUS_COLUMNS.map((column) => ({
			...column,
			ideas: savedIdeas.filter((idea) => idea.status === column.id)
		}))
	);

	function handleFontChange(key: string) {
		fontKey = key;
		try {
			localStorage.setItem('preferred-font', key);
		} catch {}
	}

	function readStoredArray<T>(key: string): T[] {
		if (!browser) return [];
		try {
			const raw = localStorage.getItem(key);
			const parsed = raw ? JSON.parse(raw) : [];
			return Array.isArray(parsed) ? parsed : [];
		} catch {
			return [];
		}
	}

	function persistSavedIdeas() {
		if (!browser) return;
		try {
			localStorage.setItem(SAVED_IDEAS_STORAGE_KEY, JSON.stringify(savedIdeas));
		} catch {}
	}

	function persistDismissedRootUris() {
		if (!browser) return;
		try {
			localStorage.setItem(DISMISSED_STORAGE_KEY, JSON.stringify(dismissedRootUris));
		} catch {}
	}

	function normalizeIdeaStatus(value: unknown): IdeaStatus {
		if (value === 'done') return 'done';
		if (value === 'doing' || value === 'in_progress') return 'in_progress';
		return 'todo';
	}

	function normalizeIdeaPriority(value: unknown): IdeaPriority {
		if (value === 'low' || value === 'high') return value;
		return 'medium';
	}

	function normalizeSavedIdea(idea: SavedIdea): SavedIdea {
		return {
			...idea,
			status: normalizeIdeaStatus(idea.status),
			priority: normalizeIdeaPriority(idea.priority)
		};
	}

	function truncate(text: string, limit: number): string {
		const clean = text.trim();
		if (clean.length <= limit) return clean;
		return `${clean.slice(0, Math.max(0, limit - 1)).trim()}...`;
	}

	function cleanIdeaText(text: string): string {
		return text
			.replace(new RegExp(`#${IDEA_TAG}\\b`, 'gi'), '')
			.replace(/\s+/g, ' ')
			.trim();
	}

	function postUrl(post: ThreadPost): string | null {
		return buildBskyPostUrl(post.uri, post.author.handle);
	}

	function dateLabel(value: string): string {
		if (!value) return '';
		const date = new Date(value);
		if (!Number.isFinite(date.getTime())) return value;
		return new Intl.DateTimeFormat(undefined, {
			month: 'short',
			day: 'numeric',
			year: 'numeric',
			hour: '2-digit',
			minute: '2-digit'
		}).format(date);
	}

	function selectedPostsForCandidate(candidate: IdeaCandidate): ThreadPost[] {
		const included = new Set(candidate.includedUris);
		return flattenThread(candidate.thread.rootPost)
			.map((item) => item.post)
			.filter((post) => included.has(post.uri));
	}

	function isGeneratedDraftText(text: string): boolean {
		const clean = text.trim();
		return clean.startsWith('As a user,') || clean.startsWith('Need:');
	}

	function savedIdeaPostText(idea: SavedIdea): string {
		const storedText = cleanIdeaText(idea.userStory);
		if (storedText && !isGeneratedDraftText(storedText)) return storedText;
		return cleanIdeaText(idea.sourcePosts.map((post) => post.text).join('\n\n')) || '[No text]';
	}

	function buildIssueDraft(
		thread: IdeaThread,
		taggedPostUri: string,
		includedUris?: string[]
	): DraftIssue {
		const posts = flattenThread(thread.rootPost).map((item) => item.post);
		const included = includedUris
			? posts.filter((post) => includedUris.includes(post.uri))
			: posts;
		const source = included.find((post) => post.uri === taggedPostUri) ?? included[0] ?? thread.rootPost;
		const sourceText = cleanIdeaText(source.text);
		const fallbackText = cleanIdeaText(included.map((post) => post.text).join(' '));
		const summary = truncate(sourceText || fallbackText || 'Untitled idea', 110);
		const title = truncate(summary.split(/[.!?\n]/)[0] || summary, 78);

		return {
			title,
			userStory: sourceText || fallbackText || '[No text]',
			description: '',
			acceptanceCriteria: '',
			notes: '',
			status: 'todo',
			priority: 'medium'
		};
	}

	function makeCandidate(thread: IdeaThread, taggedPost: ThreadPost): IdeaCandidate {
		const posts = flattenThread(thread.rootPost).map((item) => item.post);
		const includedUris = posts.map((post) => post.uri);
		return {
			id: thread.rootUri,
			taggedPostUri: taggedPost.uri,
			sourceUrl: postUrl(taggedPost),
			thread,
			includedUris,
			issue: buildIssueDraft(thread, taggedPost.uri, includedUris),
			fetchedAt: new Date().toISOString()
		};
	}

	function sourcePostSnapshot(post: ThreadPost): SavedSourcePost {
		return {
			uri: post.uri,
			authorHandle: post.author.handle,
			authorDisplayName: post.author.displayName,
			text: post.text,
			createdAt: post.createdAt
		};
	}

	function isAbortError(error: unknown): boolean {
		return (
			error instanceof DOMException && error.name === 'AbortError'
		) || String((error as { name?: string })?.name ?? '') === 'AbortError';
	}

	function isMissingSearchScopeError(error: unknown): boolean {
		const message = String((error as { message?: string } | null | undefined)?.message ?? '');
		return message.includes('Missing required scope') && message.includes('app.bsky.feed.searchPosts');
	}

	function errorDebugFields(error: unknown): Record<string, unknown> {
		const item = error as {
			name?: string;
			message?: string;
			status?: unknown;
			statusCode?: unknown;
			error?: unknown;
			headers?: unknown;
			cause?: unknown;
			data?: unknown;
		} | null;
		return {
			name: item?.name,
			message: item?.message,
			status: item?.status,
			statusCode: item?.statusCode,
			error: item?.error,
			headers: item?.headers,
			cause: item?.cause,
			data: item?.data
		};
	}

	function logSearchPostsError(error: unknown, page: number, cursor?: string) {
		const grantHasScope = grantedScope ? hasBlueskySearchPostsScope(grantedScope) : false;
		console.error('[atproideasio] app.bsky.feed.searchPosts failed', {
			page,
			cursor,
			requestedScope: BLUESKY_SEARCH_POSTS_SCOPE,
			requestedSearchScopes: BLUESKY_SEARCH_POSTS_SCOPES,
			metadataScope: oauthDebug?.scope ?? null,
			grantedScope,
			grantHasRequiredScope: grantHasScope,
			clientId: oauthDebug?.clientId ?? null,
			error: errorDebugFields(error),
			rawError: error
		});
	}

	function missingSearchScopeMessage(): string {
		return `Your Bluesky grant is missing post search permission (${BLUESKY_SEARCH_POSTS_SCOPES.join(' or ')}). Click Connect Bluesky once and approve the new permission before fetching again.`;
	}

	function rejectedSearchScopeMessage(): string {
		return `Bluesky rejected post search for ${BLUESKY_SEARCH_POSTS_SCOPE}, even though this session reports that scope. Check the browser console for the raw XRPC error.`;
	}

	function formatAuthError(error: unknown, fallback: string): string {
		const message = String((error as { message?: string } | null | undefined)?.message ?? '');
		if (message.includes('Missing required scope')) {
			return missingSearchScopeMessage();
		}
		if (message.includes('popup')) {
			return 'Bluesky sign-in popup was blocked or closed before the search could start.';
		}
		return message || fallback;
	}

	function resetAuthState() {
		profile = null;
		sessionSub = null;
		grantedScope = null;
		authAgent = null;
	}

	async function refreshOAuthDebug() {
		if (!browser) return;
		try {
			oauthDebug = await getBlueskyOAuthDebugInfo();
		} catch {
			oauthDebug = null;
		}
	}

	async function applyAuthenticatedContext(context: AuthenticatedBlueskyContext) {
		profile = context.profile;
		sessionSub = context.session.sub;
		grantedScope = context.scope;
		authAgent = context.agent as unknown as PostSearchAgent;
		authError = null;
	}

	async function restoreSession() {
		restoringSession = true;
		authError = null;

		try {
			const { context } = await initAuthenticatedBlueskyClient();
			if (context) {
				await applyAuthenticatedContext(context);
			} else {
				resetAuthState();
			}
		} catch (error: any) {
			const message = String(error?.message || '');
			if (message.includes('Redirecting to loopback IP')) return;
			authError = formatAuthError(error, 'Could not restore your Bluesky session.');
			resetAuthState();
		} finally {
			restoringSession = false;
		}
	}

	async function handleConnect() {
		connecting = true;
		authError = null;
		resetBlueskyOAuthClient();
		await refreshOAuthDebug();
		await forgetStoredBlueskySessionLocally(sessionSub);
		resetAuthState();

		try {
			const context = await connectBlueskyWithPopup(SEARCH_AUTH_OPTIONS);
			await applyAuthenticatedContext(context);
		} catch (error) {
			authError = formatAuthError(error, 'Could not connect your Bluesky account.');
		} finally {
			connecting = false;
		}
	}

	async function handleDisconnect() {
		const sub = sessionSub;
		if (!sub) return;

		try {
			await forgetStoredBlueskySessionLocally(sub);
			resetAuthState();
		} catch (error: any) {
			authError = error?.message || 'Could not disconnect your Bluesky session.';
		}
	}

	async function getSearchAgent(): Promise<PostSearchAgent> {
		if (authAgent) return authAgent;
		throw new Error('Connect Bluesky first, then fetch tagged posts.');
	}

	async function searchTaggedPostsPage(options: {
		agent: PostSearchAgent;
		cursor?: string;
		limit?: number;
		signal?: AbortSignal;
	}): Promise<TaggedPostSearchPage> {
		const params = new URLSearchParams({
			tag: IDEA_TAG,
			sort: 'latest',
			limit: String(options.limit ?? 100)
		});
		if (options.cursor) params.set('cursor', options.cursor);

		const response = await fetch(`/api/atproideasio/search?${params}`, {
			headers: { Accept: 'application/json' },
			signal: options.signal
		});
		const data = await response.json().catch(() => ({}));

		if (!response.ok) {
			const error = new Error(data?.message || `Tagged post search failed with ${response.status}`) as Error & {
				status?: number;
				error?: unknown;
				data?: unknown;
			};
			error.status = response.status;
			error.error = data?.error;
			error.data = data;
			throw error;
		}

		return data as TaggedPostSearchPage;
	}

	function inputValue(event: Event): string {
		return (event.currentTarget as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement).value;
	}

	function setCandidateIssueField(id: string, field: IssueField, value: string) {
		candidates = candidates.map((candidate) =>
			candidate.id === id
				? {
						...candidate,
						issue: {
							...candidate.issue,
							[field]:
								field === 'status'
									? normalizeIdeaStatus(value)
									: field === 'priority'
										? normalizeIdeaPriority(value)
										: value
						}
					}
				: candidate
		);
	}

	function setSavedIdeaField(id: string, field: IssueField, value: string) {
		savedIdeas = savedIdeas.map((idea) =>
			idea.id === id
				? {
						...idea,
						[field]:
							field === 'status'
								? normalizeIdeaStatus(value)
								: field === 'priority'
									? normalizeIdeaPriority(value)
									: value,
						updatedAt: new Date().toISOString()
					}
				: idea
		);
		persistSavedIdeas();
	}

	function moveSavedIdeaToStatus(id: string, status: IdeaStatus) {
		setSavedIdeaField(id, 'status', status);
	}

	function toggleCandidatePost(candidateId: string, postUri: string) {
		candidates = candidates.map((candidate) => {
			if (candidate.id !== candidateId) return candidate;
			const isKept = candidate.includedUris.includes(postUri);
			const includedUris = isKept
				? candidate.includedUris.filter((uri) => uri !== postUri)
				: [...candidate.includedUris, postUri];
			return { ...candidate, includedUris };
		});
	}

	function dismissCandidate(candidateId: string) {
		const candidate = candidates.find((item) => item.id === candidateId);
		if (!candidate) return;
		if (!dismissedRootSet.has(candidate.thread.rootUri)) {
			dismissedRootUris = [...dismissedRootUris, candidate.thread.rootUri];
			persistDismissedRootUris();
		}
		candidates = candidates.filter((item) => item.id !== candidateId);
		activeCandidateId = candidates[0]?.id ?? null;
	}

	function clearDismissedIdeas() {
		dismissedRootUris = [];
		persistDismissedRootUris();
	}

	function saveCandidate(candidateId: string) {
		const candidate = candidates.find((item) => item.id === candidateId);
		if (!candidate) return;
		const sourcePosts = selectedPostsForCandidate(candidate);
		if (sourcePosts.length === 0) return;

		const existing = savedIdeas.find((idea) => idea.id === candidate.id);
		const now = new Date().toISOString();
		const saved: SavedIdea = {
			id: candidate.id,
			rootUri: candidate.thread.rootUri,
			taggedPostUri: candidate.taggedPostUri,
			sourceUrl: candidate.sourceUrl,
			keptPostUris: candidate.includedUris,
			sourcePosts: sourcePosts.map(sourcePostSnapshot),
			postCount: sourcePosts.length,
			authorHandle: candidate.thread.rootPost.author.handle,
			authorDisplayName: candidate.thread.rootPost.author.displayName,
			createdAt: existing?.createdAt ?? now,
			updatedAt: now,
			...candidate.issue
		};

		savedIdeas = [saved, ...savedIdeas.filter((idea) => idea.id !== saved.id)];
		persistSavedIdeas();
		candidates = candidates.filter((item) => item.id !== candidateId);
		activeCandidateId = candidates[0]?.id ?? null;
	}

	function deleteSavedIdea(id: string) {
		savedIdeas = savedIdeas.filter((idea) => idea.id !== id);
		persistSavedIdeas();
	}

	function cancelFetch() {
		activeFetchController?.abort();
	}

	async function fetchTaggedIdeas() {
		if (loading) return;
		if (!authAgent) {
			authError = 'Connect Bluesky first, then fetch tagged posts.';
			return;
		}

		const controller = new AbortController();
		activeFetchController = controller;
		loading = true;
		fetchError = null;
		fetchWarnings = [];
		fetchPhase = 'Searching posts';
		fetchCurrent = 0;
		fetchTotal = 0;
		hitsTotal = null;

		try {
			const searchAgent = await getSearchAgent();
			fetchPhase = 'Searching posts';
			const posts: ThreadPost[] = [];
			const seenPostUris = new Set<string>();

			let result: TaggedPostSearchPage;
			try {
				result = await searchTaggedPostsPage({
					agent: searchAgent,
					limit: 100,
					signal: controller.signal
				});
			} catch (error) {
				if (!isMissingSearchScopeError(error)) throw error;
				logSearchPostsError(error, 0);
				if (!grantedScope || !hasBlueskySearchPostsScope(grantedScope)) {
					throw new Error(missingSearchScopeMessage());
				}
				throw new Error(rejectedSearchScopeMessage());
			}
			hitsTotal = result.hitsTotal ?? hitsTotal;
			for (const post of result.posts) {
				if (seenPostUris.has(post.uri)) continue;
				seenPostUris.add(post.uri);
				posts.push(post);
			}
			fetchCurrent = posts.length;
			fetchTotal = result.hitsTotal ?? posts.length;
			if (result.cursor) {
				fetchWarnings = [
					...fetchWarnings,
					'Bluesky search pagination is disabled because the public AppView rejects cursor-based search requests.'
				];
			}
			if (result.warnings?.length) {
				fetchWarnings = [
					...fetchWarnings,
					...result.warnings.slice(0, 3).map((warning) => warning.detail)
				];
			}

			const knownRootUris = new Set([
				...candidates.map((candidate) => candidate.thread.rootUri),
				...savedIdeas.map((idea) => idea.rootUri),
				...dismissedRootUris
			]);
			const nextCandidates: IdeaCandidate[] = [];
			fetchPhase = 'Fetching threads';
			fetchCurrent = 0;
			fetchTotal = posts.length;

			for (let index = 0; index < posts.length; index += 1) {
				const post = posts[index];
				fetchCurrent = index + 1;
				try {
					const thread = await getFullThread(post.uri);
					if (knownRootUris.has(thread.rootUri)) continue;
					knownRootUris.add(thread.rootUri);
					nextCandidates.push(makeCandidate(thread, post));
				} catch (error: any) {
					if (isAbortError(error)) throw error;
					if (fetchWarnings.length < 6) {
						fetchWarnings = [
							...fetchWarnings,
							`Could not load @${post.author.handle}'s thread: ${error?.message || 'unknown error'}`
						];
					}
				}
			}

			candidates = [...nextCandidates, ...candidates];
			activeCandidateId = nextCandidates[0]?.id ?? candidates[0]?.id ?? null;
			fetchPhase = nextCandidates.length ? 'Ready' : 'No new threads';
			fetchCurrent = nextCandidates.length;
			fetchTotal = nextCandidates.length;
		} catch (error: any) {
			if (isAbortError(error)) {
				fetchPhase = 'Stopped';
			} else {
				fetchError = error?.message || 'Failed to fetch tagged posts.';
			}
		} finally {
			loading = false;
			activeFetchController = null;
		}
	}

	onMount(() => {
		try {
			const saved = localStorage.getItem('preferred-font');
			if (saved && saved in fontFamilies) {
				fontKey = saved;
			}
		} catch {}

		savedIdeas = readStoredArray<SavedIdea>(SAVED_IDEAS_STORAGE_KEY).map(normalizeSavedIdea);
		dismissedRootUris = readStoredArray<string>(DISMISSED_STORAGE_KEY).filter(
			(uri) => typeof uri === 'string'
		);
		void refreshOAuthDebug();
		void restoreSession();
	});
</script>

<svelte:head>
	<title>atproideasio</title>
</svelte:head>

{#snippet savedIdeaCard(idea: SavedIdea)}
	<article class="saved-idea wobbly-border-light">
		<div class="saved-idea-header">
			<div>
				<input
					class="saved-title"
					value={idea.title}
					oninput={(event) => setSavedIdeaField(idea.id, 'title', inputValue(event))}
				/>
				<p>
					@{idea.authorHandle} · {idea.postCount} posts
					{#if idea.sourceUrl}
						· <a href={idea.sourceUrl} target="_blank" rel="noopener noreferrer">source</a>
					{/if}
				</p>
			</div>
			<button type="button" class="mini-btn danger" onclick={() => deleteSavedIdea(idea.id)}>
				Delete
			</button>
		</div>

		<textarea
			class="post-text-editor"
			rows="5"
			value={savedIdeaPostText(idea)}
			oninput={(event) => setSavedIdeaField(idea.id, 'userStory', inputValue(event))}
		></textarea>

		<div class="status-toggle" role="group" aria-label={`Status for ${idea.title}`}>
			{#each IDEA_STATUS_COLUMNS as status}
				<button
					type="button"
					class:active={idea.status === status.id}
					aria-pressed={idea.status === status.id}
					onclick={() => moveSavedIdeaToStatus(idea.id, status.id)}
				>
					{status.label}
				</button>
			{/each}
		</div>

		<div class="saved-controls">
			<label>
				<span>Priority</span>
				<select
					value={idea.priority}
					onchange={(event) => setSavedIdeaField(idea.id, 'priority', inputValue(event))}
				>
					<option value="low">Low</option>
					<option value="medium">Medium</option>
					<option value="high">High</option>
				</select>
			</label>
		</div>

		<details>
			<summary>Thread posts</summary>
			<div class="saved-source-list">
				{#each idea.sourcePosts as post}
					<p><strong>@{post.authorHandle}</strong> {cleanIdeaText(post.text) || '[No text]'}</p>
				{/each}
			</div>
		</details>
	</article>
{/snippet}

<main style="font-family: {fontFamily}">
	<header>
		<RouteNav current="atproideasio" align="center" />
		<div class="title-row">
			<div>
				<p class="eyebrow">#{IDEA_TAG}</p>
				<h1>atproideasio</h1>
			</div>
			<FontPicker value={fontKey} onchange={handleFontChange} />
		</div>
	</header>

	<section class="toolbar" aria-label="Idea intake controls">
		<button
			type="button"
			class="primary-btn wobbly-border"
			disabled={!authAgent || loading || connecting || restoringSession}
			onclick={fetchTaggedIdeas}
		>
			Fetch #{IDEA_TAG}
		</button>
		{#if loading}
			<button type="button" class="ghost-btn wobbly-border-light" onclick={cancelFetch}>Stop</button>
		{/if}
		<div class="auth-strip">
			<span>{sessionLabel}</span>
			{#if profile}
				<button
					type="button"
					class="text-btn"
					disabled={loading || connecting}
					onclick={handleDisconnect}
				>
					Disconnect
				</button>
			{:else}
				<button
					type="button"
					class="text-btn"
					disabled={loading || connecting || restoringSession}
					onclick={handleConnect}
				>
					Connect Bluesky
				</button>
			{/if}
		</div>
		<div class="stats-strip">
			<span>{candidates.length} candidates</span>
			<span>{savedIdeas.length} ideas</span>
			<span>{dismissedRootUris.length} dismissed</span>
			{#if dismissedRootUris.length > 0}
				<button type="button" class="text-btn" onclick={clearDismissedIdeas}>Clear dismissed</button>
			{/if}
		</div>
		{#if oauthDebug}
			<details class="oauth-debug">
				<summary>OAuth</summary>
				<p>
					<strong>{oauthDebug.mode}</strong>
					{#if oauthDebug.clientName}
						· {oauthDebug.clientName}
					{:else}
						· loopback clients do not show an app name in Bluesky
					{/if}
				</p>
				<code>{oauthDebug.clientId}</code>
				<code class:missing={!oauthDebug.hasSearchPostsScope}>requested {oauthDebug.scope}</code>
				{#if grantedScope}
					<code class:missing={!hasGrantedSearchPostsScope}>granted {grantedScope}</code>
				{/if}
			</details>
		{/if}
	</section>

	{#if loading}
		<LoadingSpinner progress={{ phase: fetchPhase, current: fetchCurrent, total: fetchTotal }} />
	{:else if fetchPhase}
		<p class="fetch-status">{fetchPhase}{hitsTotal ? ` · ${hitsTotal} search hits` : ''}</p>
	{/if}

	{#if fetchError}
		<div class="error-banner wobbly-border-light">{fetchError}</div>
	{/if}

	{#if authError}
		<div class="error-banner wobbly-border-light">{authError}</div>
	{/if}

	{#if fetchWarnings.length > 0}
		<div class="warning-banner wobbly-border-light">
			{#each fetchWarnings as warning}
				<p>{warning}</p>
			{/each}
		</div>
	{/if}

	<section class="workspace" aria-label="Idea kanban workspace">
		<aside class="candidate-lane">
			<div class="lane-heading">
				<h2>Intake</h2>
				<span>{candidates.length}</span>
			</div>
			{#if candidates.length === 0}
				<p class="empty-state">No open candidates.</p>
			{:else}
				<div class="candidate-list">
					{#each candidates as candidate}
						<button
							type="button"
							class="candidate-card"
							class:active={candidate.id === activeCandidate?.id}
							onclick={() => {
								activeCandidateId = candidate.id;
							}}
						>
							<span>{candidate.issue.title}</span>
							<small>@{candidate.thread.rootPost.author.handle} · {candidate.includedUris.length} posts</small>
						</button>
					{/each}
				</div>
			{/if}
		</aside>

		<section class="editor-lane">
			{#if activeCandidate}
				<div class="editor-header">
					<div>
						<h2>Post Text</h2>
						<p>
							@{activeCandidate.thread.rootPost.author.handle}
							{#if activeCandidate.sourceUrl}
								· <a href={activeCandidate.sourceUrl} target="_blank" rel="noopener noreferrer">source</a>
							{/if}
						</p>
					</div>
					<div class="editor-actions">
						<button
							type="button"
							class="ghost-btn danger wobbly-border-light"
							onclick={() => dismissCandidate(activeCandidate.id)}
						>
							Dismiss
						</button>
						<button
							type="button"
							class="primary-btn wobbly-border"
							onclick={() => saveCandidate(activeCandidate.id)}
							disabled={activeKeptPostCount === 0 || !activeCandidate.issue.title.trim()}
						>
							Save Idea
						</button>
					</div>
				</div>

				<div class="issue-card wobbly-border-light">
					<label>
						<span>Title</span>
						<input
							value={activeCandidate.issue.title}
							oninput={(event) =>
								setCandidateIssueField(activeCandidate.id, 'title', inputValue(event))}
						/>
					</label>
					<label>
						<span>Post text</span>
						<textarea
							rows="8"
							value={activeCandidate.issue.userStory}
							oninput={(event) =>
								setCandidateIssueField(activeCandidate.id, 'userStory', inputValue(event))}
						></textarea>
					</label>
					<div class="issue-row">
						<label>
							<span>Status</span>
							<select
								value={activeCandidate.issue.status}
								onchange={(event) =>
									setCandidateIssueField(activeCandidate.id, 'status', inputValue(event))}
							>
								<option value="todo">Todo</option>
								<option value="in_progress">In Progress</option>
								<option value="done">Done</option>
							</select>
						</label>
						<label>
							<span>Priority</span>
							<select
								value={activeCandidate.issue.priority}
								onchange={(event) =>
									setCandidateIssueField(activeCandidate.id, 'priority', inputValue(event))}
							>
								<option value="low">Low</option>
								<option value="medium">Medium</option>
								<option value="high">High</option>
							</select>
						</label>
					</div>
				</div>
			{:else}
				<div class="empty-editor wobbly-border-light">
					<h2>Post Text</h2>
					<p>Fetch tagged posts to start.</p>
				</div>
			{/if}
		</section>

		<aside class="thread-lane">
			<div class="lane-heading">
				<h2>Thread</h2>
				<span>{activeKeptPostCount}/{activeFlatPosts.length}</span>
			</div>
			{#if activeCandidate}
				{#if activeCandidate.thread.isTruncated}
					<p class="truncation-warning">Some replies may be missing.</p>
				{/if}
				<div class="source-posts">
					{#each activeFlatPosts as item}
						{@const post = item.post}
						{@const kept = activeCandidate.includedUris.includes(post.uri)}
						<article class="source-post" class:removed={!kept}>
							<div class="source-post-header">
								<div>
									<strong>@{post.author.handle}</strong>
									<small>{dateLabel(post.createdAt)}</small>
								</div>
								<button
									type="button"
									class="mini-btn"
									onclick={() => toggleCandidatePost(activeCandidate.id, post.uri)}
								>
									{kept ? 'Remove' : 'Restore'}
								</button>
							</div>
							<p style={`margin-left: ${Math.min(item.depth, 6) * 10}px`}>{post.text || '[No text]'}</p>
							<PostEmbedPreview {post} compact />
						</article>
					{/each}
				</div>
			{:else}
				<p class="empty-state">No thread selected.</p>
			{/if}
		</aside>
	</section>

	<section class="ideas-section" aria-label="Saved ideas">
		<div class="section-heading">
			<div class="section-title">
				<h2>Saved Ideas</h2>
				<span>{savedIdeas.length}</span>
			</div>
			<div class="view-toggle" role="group" aria-label="Saved ideas view">
				<button
					type="button"
					class:active={savedIdeasView === 'kanban'}
					aria-pressed={savedIdeasView === 'kanban'}
					onclick={() => {
						savedIdeasView = 'kanban';
					}}
				>
					Kanban
				</button>
				<button
					type="button"
					class:active={savedIdeasView === 'list'}
					aria-pressed={savedIdeasView === 'list'}
					onclick={() => {
						savedIdeasView = 'list';
					}}
				>
					List
				</button>
			</div>
		</div>

		{#if !hasSavedIdeas}
			<p class="empty-state">No ideas saved yet.</p>
		{:else if savedIdeasView === 'list'}
			<div class="idea-list">
				{#each savedIdeas as idea}
					{@render savedIdeaCard(idea)}
				{/each}
			</div>
		{:else}
			<div class="kanban-board">
				{#each kanbanColumns as column}
					<section class="kanban-column" aria-label={column.label}>
						<div class="lane-heading">
							<h3>{column.label}</h3>
							<span>{column.ideas.length}</span>
						</div>
						{#if column.ideas.length === 0}
							<p class="empty-state">Empty</p>
						{:else}
							<div class="kanban-cards">
								{#each column.ideas as idea}
									{@render savedIdeaCard(idea)}
								{/each}
							</div>
						{/if}
					</section>
				{/each}
			</div>
		{/if}
	</section>
</main>

<style>
	main {
		width: min(1440px, calc(100vw - 32px));
		margin: 0 auto;
		padding: 28px 0 56px;
	}

	header {
		margin-bottom: 18px;
	}

	.title-row {
		display: flex;
		align-items: end;
		justify-content: space-between;
		gap: 18px;
	}

	.eyebrow {
		color: var(--warm-text);
		font-size: 0.9rem;
		font-weight: 800;
	}

	h1 {
		margin: 0;
		color: var(--text-ink);
		font-size: clamp(2rem, 5vw, 4.4rem);
		line-height: 1;
	}

	h2 {
		margin: 0;
		font-size: 1.25rem;
		line-height: 1.15;
	}

	h3 {
		margin: 0;
		font-size: 1rem;
		line-height: 1.2;
	}

	a {
		font-weight: 700;
	}

	.toolbar,
	.workspace,
	.ideas-section {
		margin-top: 16px;
	}

	.toolbar {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 10px;
		padding: 12px;
		background: var(--panel-bg-muted);
		border: 1px solid var(--warm-border);
		border-radius: 8px;
	}

	.primary-btn,
	.ghost-btn,
	.text-btn,
	.mini-btn,
	.view-toggle button,
	.status-toggle button {
		font-weight: 800;
		transition:
			transform 0.16s ease,
			opacity 0.16s ease,
			background 0.16s ease;
	}

	.primary-btn,
	.ghost-btn {
		min-height: 40px;
		padding: 8px 14px;
		font-size: 0.95rem;
	}

	.primary-btn {
		background: var(--accent);
		color: white;
		border-color: var(--border-color);
	}

	.ghost-btn {
		background: var(--control-bg);
		color: var(--text-ink);
	}

	.primary-btn:hover:not(:disabled),
	.ghost-btn:hover:not(:disabled),
	.mini-btn:hover:not(:disabled),
	.view-toggle button:hover,
	.status-toggle button:hover {
		transform: translateY(-1px);
	}

	button:disabled {
		cursor: not-allowed;
		opacity: 0.55;
	}

	.text-btn,
	.mini-btn,
	.view-toggle button,
	.status-toggle button {
		border: 1px solid var(--control-border);
		border-radius: 8px;
		background: var(--control-bg);
		color: var(--text-ink);
	}

	.text-btn {
		padding: 4px 8px;
	}

	.mini-btn {
		flex-shrink: 0;
		padding: 5px 9px;
		font-size: 0.82rem;
	}

	.danger {
		color: var(--danger-text);
	}

	.stats-strip {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 8px;
		color: var(--muted);
		font-size: 0.92rem;
	}

	.auth-strip {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 8px;
		margin-left: auto;
		color: var(--muted);
		font-size: 0.92rem;
	}

	.auth-strip span {
		padding: 5px 9px;
		border-radius: 8px;
		background: color-mix(in srgb, var(--card-bg) 76%, transparent);
	}

	.oauth-debug {
		flex-basis: 100%;
		padding: 8px 10px;
		border: 1px dashed var(--control-border);
		border-radius: 8px;
		background: color-mix(in srgb, var(--card-bg) 72%, transparent);
		color: var(--muted);
		font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
		font-size: 0.76rem;
	}

	.oauth-debug summary {
		cursor: pointer;
		font-weight: 900;
		color: var(--text-ink);
	}

	.oauth-debug p {
		margin: 8px 0 6px;
	}

	.oauth-debug code {
		display: block;
		margin-top: 6px;
		overflow-wrap: anywhere;
		white-space: normal;
	}

	.oauth-debug code.missing {
		color: var(--danger-text);
	}

	.stats-strip span,
	.fetch-status {
		padding: 5px 9px;
		border-radius: 8px;
		background: color-mix(in srgb, var(--card-bg) 76%, transparent);
	}

	.fetch-status,
	.error-banner,
	.warning-banner {
		margin-top: 12px;
	}

	.error-banner,
	.warning-banner {
		padding: 10px 14px;
		border-radius: 8px;
	}

	.error-banner {
		background: var(--error-bg);
		color: var(--danger-text);
	}

	.warning-banner {
		background: var(--warning-bg);
		color: var(--text-ink);
	}

	.workspace {
		display: grid;
		grid-template-columns: minmax(220px, 0.72fr) minmax(360px, 1.35fr) minmax(280px, 1fr);
		gap: 14px;
		align-items: start;
	}

	.candidate-lane,
	.editor-lane,
	.thread-lane,
	.ideas-section {
		min-width: 0;
		border: 1px solid var(--warm-border);
		border-radius: 8px;
		background: var(--panel-bg-plain);
	}

	.candidate-lane,
	.thread-lane {
		padding: 12px;
		position: sticky;
		top: 14px;
		max-height: calc(100vh - 28px);
		overflow: auto;
	}

	.editor-lane {
		padding: 14px;
	}

	.lane-heading,
	.section-heading,
	.section-title,
	.editor-header,
	.saved-idea-header,
	.source-post-header,
	.saved-controls,
	.issue-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 10px;
	}

	.lane-heading span,
	.section-title span {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-width: 28px;
		height: 28px;
		border-radius: 999px;
		background: var(--active-bg);
		font-weight: 900;
	}

	.candidate-list,
	.source-posts,
	.idea-list,
	.kanban-cards {
		display: grid;
		gap: 10px;
		margin-top: 12px;
	}

	.candidate-card {
		width: 100%;
		display: grid;
		gap: 5px;
		padding: 10px;
		text-align: left;
		border: 1px solid var(--control-border);
		border-radius: 8px;
		background: var(--card-bg);
		color: var(--text-ink);
		box-shadow: var(--shadow-soft);
	}

	.candidate-card.active {
		background: var(--active-bg);
		border-color: color-mix(in srgb, var(--accent) 55%, var(--control-border));
	}

	.candidate-card span,
	.saved-title {
		font-weight: 900;
	}

	.candidate-card small,
	.editor-header p,
	.saved-idea-header p,
	.source-post-header small,
	.empty-state,
	.truncation-warning {
		color: var(--muted);
	}

	.editor-header {
		align-items: start;
		margin-bottom: 12px;
	}

	.editor-actions {
		display: flex;
		flex-wrap: wrap;
		justify-content: end;
		gap: 8px;
	}

	.issue-card,
	.empty-editor {
		display: grid;
		gap: 12px;
		padding: 14px;
		border-radius: 8px;
		background: var(--card-bg);
		box-shadow: var(--shadow-soft);
	}

	label {
		display: grid;
		gap: 5px;
		min-width: 0;
	}

	label span {
		font-size: 0.82rem;
		font-weight: 900;
		color: var(--warm-text);
	}

	input,
	textarea,
	select {
		width: 100%;
		border: 1px solid var(--control-border);
		border-radius: 8px;
		padding: 9px 10px;
		font-size: 0.96rem;
		line-height: 1.45;
		background: var(--input-bg);
		color: var(--text-ink);
	}

	textarea {
		resize: vertical;
	}

	.issue-row > label,
	.saved-controls > label {
		flex: 1 1 160px;
	}

	.source-post {
		padding: 10px;
		border: 1px solid var(--control-border);
		border-radius: 8px;
		background: var(--card-bg);
	}

	.source-post.removed {
		opacity: 0.52;
		background: color-mix(in srgb, var(--muted-surface) 70%, var(--card-bg));
	}

	.source-post-header {
		align-items: start;
	}

	.source-post-header div {
		display: grid;
		gap: 1px;
		min-width: 0;
	}

	.source-post p {
		margin-top: 8px;
		white-space: pre-wrap;
		word-break: break-word;
	}

	.empty-state,
	.empty-editor p,
	.truncation-warning {
		margin-top: 10px;
	}

	.ideas-section {
		padding: 14px;
	}

	.view-toggle {
		display: inline-flex;
		gap: 4px;
		padding: 3px;
		border: 1px solid var(--control-border);
		border-radius: 8px;
		background: color-mix(in srgb, var(--card-bg) 72%, transparent);
	}

	.view-toggle button {
		min-height: 32px;
		padding: 4px 10px;
		font-size: 0.84rem;
	}

	.view-toggle button.active,
	.status-toggle button.active {
		background: var(--active-bg);
		border-color: color-mix(in srgb, var(--accent) 55%, var(--control-border));
		color: var(--text-ink);
	}

	.kanban-board {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 12px;
		margin-top: 12px;
		align-items: start;
	}

	.kanban-column {
		min-width: 0;
		padding: 10px;
		border: 1px solid var(--control-border);
		border-radius: 8px;
		background: color-mix(in srgb, var(--panel-bg-muted) 72%, transparent);
	}

	.saved-idea {
		display: grid;
		gap: 10px;
		padding: 12px;
		border-radius: 8px;
		background: var(--card-bg);
	}

	.saved-idea-header {
		align-items: start;
	}

	.saved-title {
		border: 0;
		padding: 0;
		background: transparent;
		font-size: 1.1rem;
	}

	.post-text-editor {
		min-height: 118px;
	}

	.status-toggle {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 6px;
	}

	.status-toggle button {
		min-height: 34px;
		padding: 5px 6px;
		font-size: 0.78rem;
		line-height: 1.15;
		white-space: normal;
	}

	.saved-controls {
		justify-content: start;
		flex-wrap: wrap;
	}

	details {
		border-top: 1px solid var(--control-border);
		padding-top: 8px;
	}

	summary {
		cursor: pointer;
		font-weight: 800;
	}

	.saved-source-list {
		display: grid;
		gap: 7px;
		margin-top: 8px;
		color: var(--muted);
	}

	.saved-source-list p {
		white-space: pre-wrap;
		word-break: break-word;
	}

	@media (max-width: 1100px) {
		.workspace {
			grid-template-columns: 1fr;
		}

		.kanban-board {
			grid-template-columns: 1fr;
		}

		.candidate-lane,
		.thread-lane {
			position: static;
			max-height: none;
		}
	}

	@media (max-width: 720px) {
		main {
			width: min(100vw - 20px, 100%);
			padding-top: 18px;
		}

		.title-row,
		.section-heading,
		.editor-header,
		.saved-idea-header {
			align-items: stretch;
			flex-direction: column;
		}

		.editor-actions {
			justify-content: start;
		}

		.primary-btn,
		.ghost-btn {
			width: 100%;
		}

		.view-toggle {
			width: 100%;
		}

		.view-toggle button {
			flex: 1;
		}
	}
</style>
