<script lang="ts">
	import { onMount } from 'svelte';
	import { browser } from '$app/environment';
	import '../../app.css';
	import FontPicker from '$lib/components/FontPicker.svelte';
	import LoadingSpinner from '$lib/components/LoadingSpinner.svelte';
	import PostEmbedPreview from '$lib/components/PostEmbedPreview.svelte';
	import RouteNav from '$lib/components/RouteNav.svelte';
	import { ATPROIDEASIO_TAG } from '$lib/constants/atproideasio';
	import type { ThreadPost } from '$lib/types';
	import type {
		AtproideasioBoardResponse,
		AtproideasioCandidate,
		AtproideasioIssueDraft,
		AtproideasioPriority,
		AtproideasioSavedIdea,
		AtproideasioSavedStories,
		AtproideasioSourcePost,
		AtproideasioStatus
	} from '$lib/types/atproideasio';
	import {
		buildFuzzyTextMatcher,
		fuzzyTextMatches,
		type FuzzyTextMatcher
	} from '$lib/utils/fuzzySearch';
	import { flattenThread } from '$lib/utils/threadFlattener';

	const IDEA_TAG = ATPROIDEASIO_TAG;
	const DISMISSED_STORAGE_KEY = 'atproideasio.dismissedRootUris.v1';

	const fontFamilies: Record<string, string> = {
		virgil: "'Virgil', cursive",
		caveat: "'Caveat', cursive",
		patrick: "'Patrick Hand', cursive",
		'comic-neue': "'Comic Neue', cursive",
		inter: "'Inter', sans-serif",
		system: "system-ui, -apple-system, sans-serif"
	};

	type IdeaStatus = AtproideasioStatus;
	type IdeaPriority = AtproideasioPriority;
	type SavedIdeasView = 'kanban' | 'list';
	type IssueField =
		| 'title'
		| 'userStory'
		| 'description'
		| 'acceptanceCriteria'
		| 'notes'
		| 'status'
		| 'priority';

	type DraftIssue = AtproideasioIssueDraft;
	type IdeaCandidate = AtproideasioCandidate;
	type SavedSourcePost = AtproideasioSourcePost;
	type SavedIdea = AtproideasioSavedIdea;
	type CandidateStateFilter = 'all' | 'unsaved' | 'saved' | 'improved';

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
	let intakeCollapsed = $state(false);
	let loading = $state(false);
	let fetchPhase = $state('');
	let fetchCurrent = $state(0);
	let fetchTotal = $state(0);
	let fetchError: string | null = $state(null);
	let fetchWarnings: string[] = $state([]);
	let hitsTotal: number | null = $state(null);
	let cacheUpdatedAt: string | null = $state(null);
	let cacheMissing = $state(true);
	let cacheStats: AtproideasioBoardResponse['stats'] = $state(null);
	let savedIdeasView: SavedIdeasView = $state('kanban');
	let intakeSearchQuery = $state('');
	let intakeStatusFilter: 'all' | IdeaStatus = $state('all');
	let intakePriorityFilter: 'all' | IdeaPriority = $state('all');
	let intakeStateFilter: CandidateStateFilter = $state('all');
	let savedSearchQuery = $state('');
	let savedStatusFilter: 'all' | IdeaStatus = $state('all');
	let savedPriorityFilter: 'all' | IdeaPriority = $state('all');
	let claimDrafts: Record<string, string> = $state({});
	let savedStoriesSaving = $state(false);
	let savedStoriesError: string | null = $state(null);
	let activeFetchController: AbortController | null = null;

	const dismissedRootSet = $derived(new Set(dismissedRootUris));
	const savedRootSet = $derived(new Set(savedIdeas.map((idea) => idea.rootUri)));
	const intakeSearchMatcher = $derived(buildFuzzyTextMatcher(intakeSearchQuery));
	const savedSearchMatcher = $derived(buildFuzzyTextMatcher(savedSearchQuery));
	const hasIntakeFilters = $derived(
		Boolean(intakeSearchQuery.trim()) ||
			intakeStatusFilter !== 'all' ||
			intakePriorityFilter !== 'all' ||
			intakeStateFilter !== 'all'
	);
	const hasSavedFilters = $derived(
		Boolean(savedSearchQuery.trim()) ||
			savedStatusFilter !== 'all' ||
			savedPriorityFilter !== 'all'
	);
	const filteredCandidates = $derived(
		candidates.filter((candidate) => candidateMatchesIntakeFilters(candidate, intakeSearchMatcher))
	);
	const filteredSavedIdeas = $derived(
		savedIdeas.filter((idea) => savedIdeaMatchesFilters(idea, savedSearchMatcher))
	);
	const intakeCountLabel = $derived(
		filteredCandidates.length === candidates.length
			? String(candidates.length)
			: `${filteredCandidates.length}/${candidates.length}`
	);
	const savedCountLabel = $derived(
		filteredSavedIdeas.length === savedIdeas.length
			? String(savedIdeas.length)
			: `${filteredSavedIdeas.length}/${savedIdeas.length}`
	);
	const activeCandidate = $derived(
		filteredCandidates.find((candidate) => candidate.id === activeCandidateId) ??
			filteredCandidates[0] ??
			null
	);
	const activeFlatPosts = $derived(
		activeCandidate ? flattenThread(activeCandidate.thread.rootPost) : []
	);
	const activeKeptPostCount = $derived(activeCandidate?.includedUris.length ?? 0);
	const hasSavedIdeas = $derived(savedIdeas.length > 0);
	const hasVisibleSavedIdeas = $derived(filteredSavedIdeas.length > 0);
	const claimedSavedCount = $derived(
		savedIdeas.filter((idea) => Boolean(idea.claim?.claimedBy)).length
	);
	const kanbanColumns = $derived(
		IDEA_STATUS_COLUMNS.map((column) => ({
			...column,
			ideas: filteredSavedIdeas.filter((idea) => idea.status === column.id)
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

	function normalizeIdeaClaim(value: unknown): SavedIdea['claim'] {
		if (!value || typeof value !== 'object') return undefined;
		const claim = value as Partial<NonNullable<SavedIdea['claim']>>;
		const claimedBy = typeof claim.claimedBy === 'string' ? claim.claimedBy.trim() : '';
		if (!claimedBy) return undefined;
		return {
			claimedBy,
			claimedAt:
				typeof claim.claimedAt === 'string' && claim.claimedAt ? claim.claimedAt : new Date().toISOString()
		};
	}

	function normalizeSavedIdea(idea: SavedIdea): SavedIdea {
		return {
			...idea,
			status: normalizeIdeaStatus(idea.status),
			priority: normalizeIdeaPriority(idea.priority),
			claim: normalizeIdeaClaim(idea.claim)
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

	function matchesTextSearch(text: string, matcher: FuzzyTextMatcher): boolean {
		return matcher.terms.length === 0 || fuzzyTextMatches(text, matcher);
	}

	function candidateSearchText(candidate: IdeaCandidate): string {
		const posts = flattenThread(candidate.thread.rootPost).map((item) => item.post);
		return [
			candidate.ai?.title,
			candidate.ai?.summary,
			candidate.issue.title,
			candidate.issue.userStory,
			candidate.issue.description,
			candidate.issue.acceptanceCriteria,
			candidate.issue.notes,
			candidate.issue.status,
			candidate.issue.priority,
			candidate.thread.rootPost.author.handle,
			candidate.thread.rootPost.author.displayName,
			candidate.sourceUrl ?? '',
			posts
				.map((post) =>
					[post.author.handle, post.author.displayName, post.text, post.createdAt].filter(Boolean).join(' ')
				)
				.join('\n')
		]
			.filter(Boolean)
			.join('\n');
	}

	function savedIdeaSearchText(idea: SavedIdea): string {
		return [
			idea.ai?.title,
			idea.ai?.summary,
			idea.title,
			savedIdeaPostText(idea),
			idea.description,
			idea.acceptanceCriteria,
			idea.notes,
			idea.status,
			idea.priority,
			idea.claim?.claimedBy,
			idea.authorHandle,
			idea.authorDisplayName,
			idea.sourceUrl ?? '',
			idea.sourcePosts
				.map((post) =>
					[post.authorHandle, post.authorDisplayName, post.text, post.createdAt].filter(Boolean).join(' ')
				)
				.join('\n')
		]
			.filter(Boolean)
			.join('\n');
	}

	function candidateMatchesIntakeFilters(
		candidate: IdeaCandidate,
		matcher: FuzzyTextMatcher
	): boolean {
		if (intakeStatusFilter !== 'all' && candidate.issue.status !== intakeStatusFilter) return false;
		if (intakePriorityFilter !== 'all' && candidate.issue.priority !== intakePriorityFilter) return false;
		if (intakeStateFilter === 'saved' && !candidateIsSaved(candidate)) return false;
		if (intakeStateFilter === 'unsaved' && candidateIsSaved(candidate)) return false;
		if (intakeStateFilter === 'improved' && !candidate.state?.improved && !candidate.ai) return false;
		return matchesTextSearch(candidateSearchText(candidate), matcher);
	}

	function savedIdeaMatchesFilters(idea: SavedIdea, matcher: FuzzyTextMatcher): boolean {
		if (savedStatusFilter !== 'all' && idea.status !== savedStatusFilter) return false;
		if (savedPriorityFilter !== 'all' && idea.priority !== savedPriorityFilter) return false;
		return matchesTextSearch(savedIdeaSearchText(idea), matcher);
	}

	function clearIntakeFilters() {
		intakeSearchQuery = '';
		intakeStatusFilter = 'all';
		intakePriorityFilter = 'all';
		intakeStateFilter = 'all';
	}

	function clearSavedFilters() {
		savedSearchQuery = '';
		savedStatusFilter = 'all';
		savedPriorityFilter = 'all';
	}

	function fallbackIssueDraft(candidate: IdeaCandidate, posts: ThreadPost[]): DraftIssue {
		const source =
			posts.find((post) => post.uri === candidate.taggedPostUri) ?? posts[0] ?? candidate.thread.rootPost;
		const sourceText = cleanIdeaText(source.text);
		const fallbackText = cleanIdeaText(posts.map((post) => post.text).join(' '));
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

	function candidateIsSaved(candidate: IdeaCandidate): boolean {
		return Boolean(candidate.state?.saved) || savedRootSet.has(candidate.thread.rootUri);
	}

	function normalizeCandidate(candidate: IdeaCandidate): IdeaCandidate {
		const posts = flattenThread(candidate.thread.rootPost).map((item) => item.post);
		const fallbackIssue = fallbackIssueDraft(candidate, posts);
		const postUris = new Set(posts.map((post) => post.uri));
		const includedUris = Array.isArray(candidate.includedUris)
			? candidate.includedUris.filter((uri) => postUris.has(uri))
			: posts.map((post) => post.uri);
		const issue = candidate.issue ?? fallbackIssue;

		return {
			...candidate,
			id: candidate.id || candidate.thread.rootUri,
			includedUris: includedUris.length > 0 ? includedUris : posts.map((post) => post.uri),
			issue: {
				...fallbackIssue,
				...issue,
				status: normalizeIdeaStatus(issue.status),
				priority: normalizeIdeaPriority(issue.priority)
			},
			fetchedAt: candidate.fetchedAt || new Date().toISOString(),
			state: {
				saved: Boolean(candidate.state?.saved) || savedRootSet.has(candidate.thread.rootUri),
				improved: Boolean(candidate.ai ?? candidate.state?.improved)
			}
		};
	}

	function filterCachedCandidates(nextCandidates: IdeaCandidate[]): IdeaCandidate[] {
		const hiddenRootUris = new Set(dismissedRootUris);
		return nextCandidates
			.map(normalizeCandidate)
			.filter((candidate) => !hiddenRootUris.has(candidate.thread.rootUri));
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

	function updateSavedIdeaField(id: string, field: IssueField, value: string): SavedIdea[] {
		return savedIdeas.map((idea) =>
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
	}

	function setSavedIdeaField(id: string, field: IssueField, value: string) {
		savedIdeas = updateSavedIdeaField(id, field, value);
	}

	function claimDraftValue(idea: SavedIdea): string {
		return claimDrafts[idea.id] ?? idea.claim?.claimedBy ?? '';
	}

	function setClaimDraft(id: string, value: string) {
		claimDrafts = {
			...claimDrafts,
			[id]: value
		};
	}

	function clearClaimDraft(id: string) {
		const { [id]: _removed, ...nextDrafts } = claimDrafts;
		claimDrafts = nextDrafts;
	}

	function canSubmitClaim(idea: SavedIdea): boolean {
		const nextClaimant = claimDraftValue(idea).trim();
		const currentClaimant = idea.claim?.claimedBy.trim() ?? '';
		return Boolean(nextClaimant) && nextClaimant !== currentClaimant;
	}

	function applySavedStories(stories: SavedIdea[]) {
		savedIdeas = stories.map(normalizeSavedIdea);
		candidates = candidates.map((candidate) => ({
			...candidate,
			state: {
				saved: savedIdeas.some((idea) => idea.rootUri === candidate.thread.rootUri),
				improved: Boolean(candidate.ai ?? candidate.state?.improved)
			}
		}));
	}

	async function persistSavedStories(nextStories: SavedIdea[] = savedIdeas) {
		savedStoriesSaving = true;
		savedStoriesError = null;
		const payload: AtproideasioSavedStories = {
			version: 1,
			updatedAt: new Date().toISOString(),
			stories: nextStories
		};

		try {
			const response = await fetch('/api/atproideasio/saved-stories', {
				method: 'PUT',
				headers: {
					Accept: 'application/json',
					'Content-Type': 'application/json'
				},
				body: JSON.stringify(payload)
			});
			const data = (await response.json().catch(() => ({}))) as Partial<AtproideasioSavedStories> & {
				message?: string;
			};
			if (!response.ok) {
				throw new Error(data.message || `Saved stories update failed with ${response.status}`);
			}
			applySavedStories(data.stories ?? nextStories);
		} catch (error: any) {
			savedStoriesError = error?.message || 'Failed to save stories.';
		} finally {
			savedStoriesSaving = false;
		}
	}

	async function updateSavedIdeaClaim(id: string, claimedBy: string | null) {
		const cleanClaimant = claimedBy?.trim() ?? '';
		if (claimedBy !== null && !cleanClaimant) {
			savedStoriesError = 'Enter a name or handle before claiming an idea.';
			return;
		}

		savedStoriesSaving = true;
		savedStoriesError = null;
		try {
			const response = await fetch('/api/atproideasio/saved-stories', {
				method: 'POST',
				headers: {
					Accept: 'application/json',
					'Content-Type': 'application/json'
				},
				body: JSON.stringify({
					action: cleanClaimant ? 'claim' : 'release',
					id,
					claimedBy: cleanClaimant || undefined
				})
			});
			const data = (await response.json().catch(() => ({}))) as Partial<AtproideasioSavedStories> & {
				message?: string;
			};
			if (!response.ok) {
				throw new Error(data.message || `Claim update failed with ${response.status}`);
			}
			applySavedStories(data.stories ?? savedIdeas);
			if (cleanClaimant) {
				setClaimDraft(id, cleanClaimant);
			} else {
				clearClaimDraft(id);
			}
		} catch (error: any) {
			savedStoriesError = error?.message || 'Failed to update claim.';
		} finally {
			savedStoriesSaving = false;
		}
	}

	function claimSavedIdea(idea: SavedIdea) {
		void updateSavedIdeaClaim(idea.id, claimDraftValue(idea));
	}

	function releaseSavedIdeaClaim(id: string) {
		void updateSavedIdeaClaim(id, null);
	}

	function moveSavedIdeaToStatus(id: string, status: IdeaStatus) {
		const nextIdeas = updateSavedIdeaField(id, 'status', status);
		savedIdeas = nextIdeas;
		void persistSavedStories(nextIdeas);
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
		void loadCachedIdeas();
	}

	function saveCandidate(candidateId: string) {
		const candidate = candidates.find((item) => item.id === candidateId);
		if (!candidate || candidateIsSaved(candidate)) return;
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
			ai: candidate.ai,
			...candidate.issue
		};

		const nextIdeas = [saved, ...savedIdeas.filter((idea) => idea.id !== saved.id)];
		savedIdeas = nextIdeas;
		candidates = candidates.map((item) =>
			item.id === candidateId
				? {
						...item,
						state: {
							saved: true,
							improved: Boolean(item.ai ?? item.state?.improved)
						}
					}
				: item
		);
		void persistSavedStories(nextIdeas);
	}

	function deleteSavedIdea(id: string) {
		const deleted = savedIdeas.find((idea) => idea.id === id);
		const nextIdeas = savedIdeas.filter((idea) => idea.id !== id);
		savedIdeas = nextIdeas;
		if (deleted) {
			candidates = candidates.map((candidate) =>
				candidate.thread.rootUri === deleted.rootUri
					? {
							...candidate,
							state: {
								saved: false,
								improved: Boolean(candidate.ai ?? candidate.state?.improved)
							}
						}
					: candidate
			);
		}
		void persistSavedStories(nextIdeas);
	}

	function cancelFetch() {
		activeFetchController?.abort();
	}

	async function loadSavedStories() {
		savedStoriesError = null;
		try {
			const response = await fetch('/api/atproideasio/saved-stories', {
				headers: { Accept: 'application/json' }
			});
			const data = (await response.json().catch(() => ({}))) as Partial<AtproideasioSavedStories> & {
				message?: string;
			};
			if (!response.ok) {
				throw new Error(data.message || `Saved stories failed with ${response.status}`);
			}
			applySavedStories(data.stories ?? []);
		} catch (error: any) {
			savedStoriesError = error?.message || 'Failed to load saved stories.';
			savedIdeas = [];
		}
	}

	async function loadCachedIdeas() {
		if (loading) return;

		const controller = new AbortController();
		activeFetchController = controller;
		loading = true;
		fetchError = null;
		fetchWarnings = [];
		fetchPhase = 'Loading cached intake';
		fetchCurrent = 0;
		fetchTotal = 0;
		hitsTotal = null;

		try {
			const response = await fetch('/api/atproideasio/board', {
				headers: { Accept: 'application/json' },
				signal: controller.signal
			});
			const data = (await response.json().catch(() => ({}))) as Partial<AtproideasioBoardResponse> & {
				message?: string;
			};

			if (!response.ok) {
				throw new Error(data.message || `Cached intake failed with ${response.status}`);
			}

			const nextCandidates = filterCachedCandidates(data.candidates ?? []);
			candidates = nextCandidates;
			activeCandidateId = nextCandidates[0]?.id ?? null;
			cacheUpdatedAt = data.updatedAt || null;
			cacheMissing = Boolean(data.missing);
			cacheStats = data.stats ?? null;
			hitsTotal = data.stats?.hitsTotal ?? null;
			fetchWarnings = data.warnings ?? [];

			fetchPhase = cacheMissing
				? 'No cached intake'
				: nextCandidates.length
					? 'Cached intake loaded'
					: 'No open cached candidates';
			fetchCurrent = nextCandidates.length;
			fetchTotal = nextCandidates.length;
		} catch (error: any) {
			if (isAbortError(error)) {
				fetchPhase = 'Stopped';
			} else {
				fetchError = error?.message || 'Failed to load cached intake.';
			}
		} finally {
			loading = false;
			activeFetchController = null;
		}
	}

	async function loadBoardData() {
		await loadSavedStories();
		await loadCachedIdeas();
	}

	onMount(() => {
		try {
			const saved = localStorage.getItem('preferred-font');
			if (saved && saved in fontFamilies) {
				fontKey = saved;
			}
		} catch {}

		dismissedRootUris = readStoredArray<string>(DISMISSED_STORAGE_KEY).filter(
			(uri) => typeof uri === 'string'
		);
		void loadBoardData();
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
					onblur={() => void persistSavedStories()}
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
			onblur={() => void persistSavedStories()}
		></textarea>

		{#if idea.ai}
			<div class="ai-summary compact">
				<span>DeepSeek V4</span>
				<p>{idea.ai.summary}</p>
			</div>
		{/if}

		<div class="claim-panel" class:claimed={Boolean(idea.claim?.claimedBy)}>
			<div class="claim-meta">
				<span>Reserved</span>
				{#if idea.claim?.claimedBy}
					<strong>{idea.claim.claimedBy}</strong>
					<small>{dateLabel(idea.claim.claimedAt)}</small>
				{:else}
					<strong>Unclaimed</strong>
				{/if}
			</div>
			<div class="claim-actions">
				<input
					class="claim-input"
					type="text"
					placeholder="Name or @handle"
					value={claimDraftValue(idea)}
					oninput={(event) => setClaimDraft(idea.id, inputValue(event))}
				/>
				<button
					type="button"
					class="mini-btn"
					disabled={savedStoriesSaving || !canSubmitClaim(idea)}
					onclick={() => claimSavedIdea(idea)}
				>
					{idea.claim?.claimedBy ? 'Reassign' : 'Claim'}
				</button>
				{#if idea.claim?.claimedBy}
					<button
						type="button"
						class="mini-btn danger"
						disabled={savedStoriesSaving}
						onclick={() => releaseSavedIdeaClaim(idea.id)}
					>
						Release
					</button>
				{/if}
			</div>
		</div>

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
					onchange={(event) => {
						setSavedIdeaField(idea.id, 'priority', inputValue(event));
						void persistSavedStories();
					}}
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
			disabled={loading}
			onclick={loadBoardData}
		>
			Reload Cached Intake
		</button>
		{#if loading}
			<button type="button" class="ghost-btn wobbly-border-light" onclick={cancelFetch}>Stop</button>
		{/if}
		<div class="stats-strip">
			<span>{candidates.length} candidates</span>
			<span>{savedIdeas.length} ideas</span>
			<span>{claimedSavedCount} claimed</span>
			{#if savedStoriesSaving}
				<span>saving stories</span>
			{/if}
			<span>{dismissedRootUris.length} dismissed</span>
			{#if cacheUpdatedAt}
				<span>cached {dateLabel(cacheUpdatedAt)}</span>
			{/if}
			{#if cacheStats}
				<span>{cacheStats.taggedPosts} tagged posts</span>
				<span>{cacheStats.searchPages} pages</span>
			{:else if cacheMissing}
				<span>no R2 snapshot</span>
			{/if}
			{#if dismissedRootUris.length > 0}
				<button type="button" class="text-btn" onclick={clearDismissedIdeas}>Clear dismissed</button>
			{/if}
		</div>
	</section>

	{#if loading}
		<LoadingSpinner progress={{ phase: fetchPhase, current: fetchCurrent, total: fetchTotal }} />
	{:else if fetchPhase}
		<p class="fetch-status">{fetchPhase}{hitsTotal ? ` · ${hitsTotal} search hits` : ''}</p>
	{/if}

	{#if fetchError}
		<div class="error-banner wobbly-border-light">{fetchError}</div>
	{/if}

	{#if savedStoriesError}
		<div class="error-banner wobbly-border-light">{savedStoriesError}</div>
	{/if}

	{#if fetchWarnings.length > 0}
		<div class="warning-banner wobbly-border-light">
			{#each fetchWarnings as warning}
				<p>{warning}</p>
			{/each}
		</div>
	{/if}

	<section class="intake-section" aria-label="Cached intake">
		<div class="section-heading">
			<div class="section-title">
				<h2>Cached Intake</h2>
				<span>{intakeCountLabel}</span>
			</div>
			<button
				type="button"
				class="ghost-btn wobbly-border-light"
				aria-expanded={!intakeCollapsed}
				onclick={() => {
					intakeCollapsed = !intakeCollapsed;
				}}
			>
				{intakeCollapsed ? 'Open Intake' : 'Collapse Intake'}
			</button>
		</div>

		{#if !intakeCollapsed}
			<div class="filter-bar" aria-label="Cached intake filters">
				<label class="search-control" for="intake-search">
					<span>Search cached posts</span>
					<input
						id="intake-search"
						type="text"
						placeholder="Text, title, author, summary"
						bind:value={intakeSearchQuery}
					/>
				</label>
				<label>
					<span>Status</span>
					<select bind:value={intakeStatusFilter}>
						<option value="all">All</option>
						<option value="todo">Todo</option>
						<option value="in_progress">In Progress</option>
						<option value="done">Done</option>
					</select>
				</label>
				<label>
					<span>Priority</span>
					<select bind:value={intakePriorityFilter}>
						<option value="all">All</option>
						<option value="low">Low</option>
						<option value="medium">Medium</option>
						<option value="high">High</option>
					</select>
				</label>
				<label>
					<span>State</span>
					<select bind:value={intakeStateFilter}>
						<option value="all">All</option>
						<option value="unsaved">Unsaved</option>
						<option value="saved">Saved</option>
						<option value="improved">Improved</option>
					</select>
				</label>
				{#if hasIntakeFilters}
					<button type="button" class="text-btn" onclick={clearIntakeFilters}>Clear filters</button>
				{/if}
				<p class="filter-summary">
					Showing {filteredCandidates.length} of {candidates.length} cached posts
				</p>
			</div>
			<section class="workspace" aria-label="Idea kanban workspace">
		<aside class="candidate-lane">
			<div class="lane-heading">
				<h2>Intake</h2>
				<span>{filteredCandidates.length}</span>
			</div>
			{#if candidates.length === 0}
				<p class="empty-state">
					{cacheMissing ? 'Run the R2 ingestion job to fill intake.' : 'No open candidates.'}
				</p>
			{:else if filteredCandidates.length === 0}
				<p class="empty-state">No cached posts match the current filters.</p>
			{:else}
				<div class="candidate-list">
					{#each filteredCandidates as candidate}
						<button
							type="button"
							class="candidate-card"
							class:active={candidate.id === activeCandidate?.id}
							class:saved={candidateIsSaved(candidate)}
							onclick={() => {
								activeCandidateId = candidate.id;
							}}
						>
							<span>{candidate.ai?.title ?? candidate.issue.title}</span>
							<small>
								@{candidate.thread.rootPost.author.handle} · {candidate.includedUris.length} posts
								{#if candidate.state?.improved}
									· improved
								{/if}
								{#if candidateIsSaved(candidate)}
									· saved
								{/if}
							</small>
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
							disabled={candidateIsSaved(activeCandidate) || activeKeptPostCount === 0 || !activeCandidate.issue.title.trim()}
						>
							{candidateIsSaved(activeCandidate) ? 'Saved' : 'Save Idea'}
						</button>
					</div>
				</div>

				<div class="issue-card wobbly-border-light">
					{#if activeCandidate.ai}
						<div class="ai-summary">
							<span>DeepSeek V4 title and summary</span>
							<h3>{activeCandidate.ai.title}</h3>
							<p>{activeCandidate.ai.summary}</p>
							<small>
								{activeCandidate.ai.model} · {activeCandidate.ai.inputPostCount} posts · {dateLabel(activeCandidate.ai.generatedAt)}
							</small>
						</div>
					{/if}
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
					<p>
						{cacheMissing
							? 'No cached intake has been written yet.'
							: hasIntakeFilters
								? 'No cached post matches the current filters.'
								: 'No cached thread selected.'}
					</p>
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
		{/if}
	</section>

	<section class="ideas-section" aria-label="Saved ideas">
		<div class="section-heading">
			<div class="section-title">
				<h2>Saved Ideas</h2>
				<span>{savedCountLabel}</span>
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

		<div class="filter-bar saved-filter-bar" aria-label="Saved ideas filters">
			<label class="search-control" for="saved-search">
				<span>Search saved ideas</span>
				<input
					id="saved-search"
					type="text"
					placeholder="Text, title, author, summary"
					bind:value={savedSearchQuery}
				/>
			</label>
			<label>
				<span>Status</span>
				<select bind:value={savedStatusFilter}>
					<option value="all">All</option>
					<option value="todo">Todo</option>
					<option value="in_progress">In Progress</option>
					<option value="done">Done</option>
				</select>
			</label>
			<label>
				<span>Priority</span>
				<select bind:value={savedPriorityFilter}>
					<option value="all">All</option>
					<option value="low">Low</option>
					<option value="medium">Medium</option>
					<option value="high">High</option>
				</select>
			</label>
			{#if hasSavedFilters}
				<button type="button" class="text-btn" onclick={clearSavedFilters}>Clear filters</button>
			{/if}
			<p class="filter-summary">
				Showing {filteredSavedIdeas.length} of {savedIdeas.length} saved ideas
			</p>
		</div>

		{#if !hasSavedIdeas}
			<p class="empty-state">No ideas saved yet.</p>
		{:else if !hasVisibleSavedIdeas}
			<p class="empty-state">No saved ideas match the current filters.</p>
		{:else if savedIdeasView === 'list'}
			<div class="idea-list">
				{#each filteredSavedIdeas as idea}
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
	.intake-section,
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

	.stats-strip span,
	.fetch-status {
		padding: 5px 9px;
		border-radius: 8px;
		background: color-mix(in srgb, var(--card-bg) 76%, transparent);
	}

	.filter-bar {
		display: flex;
		align-items: end;
		flex-wrap: wrap;
		gap: 10px;
		margin-top: 12px;
		padding: 10px;
		border: 1px solid var(--control-border);
		border-radius: 8px;
		background: color-mix(in srgb, var(--panel-bg-muted) 72%, transparent);
	}

	.saved-filter-bar {
		margin-bottom: 12px;
	}

	.filter-bar label {
		flex: 0 1 150px;
	}

	.filter-bar .search-control {
		flex: 1 1 280px;
	}

	.filter-bar .text-btn {
		min-height: 38px;
		align-self: end;
	}

	.filter-summary {
		margin: 0 0 4px auto;
		color: var(--muted);
		font-size: 0.86rem;
		line-height: 1.25;
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
	.intake-section,
	.ideas-section {
		min-width: 0;
		border: 1px solid var(--warm-border);
		border-radius: 8px;
		background: var(--panel-bg-plain);
	}

	.intake-section {
		padding: 14px;
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

	.candidate-card.saved {
		border-color: color-mix(in srgb, var(--success-text, #2f7d32) 48%, var(--control-border));
		background: color-mix(in srgb, var(--active-bg) 70%, var(--card-bg));
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

	.ai-summary {
		display: grid;
		gap: 6px;
		padding: 10px;
		border: 1px solid color-mix(in srgb, var(--accent) 40%, var(--control-border));
		border-radius: 8px;
		background: color-mix(in srgb, var(--active-bg) 62%, var(--card-bg));
	}

	.ai-summary.compact {
		padding: 8px;
	}

	.ai-summary span {
		font-size: 0.78rem;
		font-weight: 900;
		color: var(--warm-text);
	}

	.ai-summary p,
	.ai-summary h3 {
		margin: 0;
	}

	.ai-summary small {
		color: var(--muted);
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

	.claim-panel {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 10px;
		padding: 9px;
		border: 1px solid var(--control-border);
		border-radius: 8px;
		background: color-mix(in srgb, var(--panel-bg-muted) 64%, transparent);
	}

	.claim-panel.claimed {
		border-color: color-mix(in srgb, var(--accent) 48%, var(--control-border));
		background: color-mix(in srgb, var(--active-bg) 50%, var(--card-bg));
	}

	.claim-meta {
		display: grid;
		gap: 2px;
		min-width: 0;
	}

	.claim-meta span {
		color: var(--warm-text);
		font-size: 0.76rem;
		font-weight: 900;
	}

	.claim-meta strong,
	.claim-meta small {
		overflow-wrap: anywhere;
	}

	.claim-meta small {
		color: var(--muted);
	}

	.claim-actions {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		justify-content: end;
		gap: 6px;
	}

	.claim-input {
		flex: 1 1 150px;
		min-width: 0;
		padding: 6px 8px;
		font-size: 0.86rem;
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

		.claim-panel {
			align-items: stretch;
			flex-direction: column;
		}

		.claim-actions {
			justify-content: start;
		}

		.claim-input {
			flex-basis: 100%;
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

		.filter-bar label,
		.filter-bar .search-control,
		.filter-bar .text-btn,
		.filter-summary {
			width: 100%;
			flex-basis: 100%;
		}

		.filter-summary {
			margin-left: 0;
		}
	}
</style>
