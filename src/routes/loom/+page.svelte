<script lang="ts">
	import { onDestroy, onMount, tick } from 'svelte';
	import { browser } from '$app/environment';
	import '../../app.css';
	import SearchBar from '$lib/components/SearchBar.svelte';
	import FontPicker from '$lib/components/FontPicker.svelte';
	import LoadingSpinner from '$lib/components/LoadingSpinner.svelte';
	import ErrorBanner from '$lib/components/ErrorBanner.svelte';
	import RouteNav from '$lib/components/RouteNav.svelte';
	import { getProfile, type ProfileInfo } from '$lib/api/bluesky';
	import type { AuthorInfo, DiscoverProgress } from '$lib/types';
	import { loadRepoFeedItems, type RepoDownloadProgress } from '$lib/utils/repoHydration';
	import { parseCarPostsWasm } from '$lib/utils/carParserWasm';
	import {
		buildCorpusCompletionIndex,
		generateCorpusMarkovContinuations,
		getCorpusSuggestions,
		type CorpusCompletionIndex,
		type CorpusMarkovContinuation,
		type CorpusMarkovStrategy,
		type CorpusPost,
		type CorpusSuggestion
	} from '$lib/utils/corpusCompletions';

	const fontFamilies: Record<string, string> = {
		virgil: "'Virgil', cursive",
		caveat: "'Caveat', cursive",
		patrick: "'Patrick Hand', cursive",
		'comic-neue': "'Comic Neue', cursive",
		inter: "'Inter', sans-serif",
		system: "system-ui, -apple-system, sans-serif"
	};

	type CorpusStats = {
		totalPosts: number;
		usablePosts: number;
		tokenCount: number;
		contextCount: number;
		elapsedMs: number;
		downloadedBytes: number;
		source: 'pds' | 'relay' | 'mixed' | 'file' | null;
		authorCount: number;
	};

	type LoomCorpusFile = {
		version: 1;
		exportedAt: string;
		authors: ProfileInfo[];
		stats: Pick<CorpusStats, 'totalPosts' | 'usablePosts' | 'downloadedBytes' | 'source' | 'authorCount'>;
		posts: CorpusPost[];
	};

	type HighlightSegment = {
		text: string;
		match: boolean;
	};

	const HIGHLIGHT_TOKEN_PATTERN = /[\p{L}\p{N}]+(?:['\u2019][\p{L}\p{N}]+)*/gu;
	const COMPLETION_REFRESH_MS = 90;
	const DRAFT_SAVE_MS = 350;
	const ECHO_ROW_HEIGHT = 148;
	const ECHO_VIEWPORT_HEIGHT = 330;
	const ECHO_OVERSCAN = 4;
	const ECHO_POST_LIMIT = 5000;
	const SUGGESTION_LIMIT = 24;
	const BSKY_URL_FILTER_STORAGE_KEY = 'loom-remove-bsky-app-urls';

	let fontKey = $state('patrick');
	let fontFamily = $derived(fontFamilies[fontKey] ?? fontFamilies.patrick);
	let initialHandle = $state('');
	let profile: ProfileInfo | null = $state(null);
	let corpusAuthors: ProfileInfo[] = $state([]);
	let profileLoading = $state(false);
	let loading = $state(false);
	let error: string | null = $state(null);
	let progress: DiscoverProgress = $state({ phase: '', current: 0, total: 0 });
	let abortController: AbortController | null = $state(null);
	let corpusPosts: CorpusPost[] = $state([]);
	let corpusIndex: CorpusCompletionIndex | null = $state(null);
	let corpusStats: CorpusStats = $state({
		totalPosts: 0,
		usablePosts: 0,
		tokenCount: 0,
		contextCount: 0,
		elapsedMs: 0,
		downloadedBytes: 0,
		source: null,
		authorCount: 0
	});
	let draftText = $state('');
	let cursorIndex = $state(0);
	let completionText = $state('');
	let completionCursorIndex = $state(0);
	let markovCount = $state(5);
	let markovMaxTokens = $state(14);
	let markovSeedLimit = $state(15);
	let markovStrategy: CorpusMarkovStrategy = $state('frequent');
	let removeBskyAppUrls = $state(true);
	let selectedSuggestionIndex = $state(0);
	let echoScrollTop = $state(0);
	let echoSelectionKey = $state('');
	let editorEl: HTMLTextAreaElement | undefined = $state();
	let echoScrollEl: HTMLDivElement | undefined = $state();
	let corpusFileInputEl: HTMLInputElement | undefined = $state();
	let completionRefreshTimer: ReturnType<typeof setTimeout> | null = null;
	let draftSaveTimer: ReturnType<typeof setTimeout> | null = null;

	const suggestions = $derived(
		corpusIndex
			? getCorpusSuggestions(corpusIndex, completionText, {
					cursor: completionCursorIndex,
					limit: SUGGESTION_LIMIT
				})
			: []
	);
	const markovContinuations = $derived(
		corpusIndex
			? generateCorpusMarkovContinuations(corpusIndex, completionText, {
					cursor: completionCursorIndex,
					count: markovCount,
					maxTokens: markovMaxTokens,
					seedLimit: markovSeedLimit,
					strategy: markovStrategy
				})
			: []
	);
	const selectedSuggestion = $derived(
		suggestions.length > 0 ? suggestions[Math.min(selectedSuggestionIndex, suggestions.length - 1)] : null
	);
	const topEcho = $derived(selectedSuggestion?.examples[0] ?? null);
	const corpusEchoPosts = $derived(selectedSuggestion?.echoPosts ?? []);
	const echoStartIndex = $derived(
		Math.max(0, Math.floor(echoScrollTop / ECHO_ROW_HEIGHT) - ECHO_OVERSCAN)
	);
	const echoVisibleCount = $derived(
		Math.ceil(ECHO_VIEWPORT_HEIGHT / ECHO_ROW_HEIGHT) + ECHO_OVERSCAN * 2
	);
	const visibleEchoPosts = $derived(
		corpusEchoPosts.slice(echoStartIndex, echoStartIndex + echoVisibleCount)
	);
	const echoTopPad = $derived(echoStartIndex * ECHO_ROW_HEIGHT);
	const echoBottomPad = $derived(
		Math.max(0, (corpusEchoPosts.length - echoStartIndex - visibleEchoPosts.length) * ECHO_ROW_HEIGHT)
	);
	const draftBeforeCursor = $derived(draftText.slice(0, cursorIndex));
	const draftAfterCursor = $derived(draftText.slice(cursorIndex));
	const ghostText = $derived(selectedSuggestion?.ghostText ?? '');
	const canDownload = $derived(corpusAuthors.length > 0 && !loading && !profileLoading);
	const corpusHandleLabel = $derived(corpusAuthors.map((author) => author.handle).join(', '));

	$effect(() => {
		const nextKey = selectedSuggestion
			? `${selectedSuggestion.source}:${selectedSuggestion.context}:${selectedSuggestion.token}`
			: '';
		if (nextKey !== echoSelectionKey) {
			echoSelectionKey = nextKey;
			echoScrollTop = 0;
			if (echoScrollEl) {
				echoScrollEl.scrollTop = 0;
			}
		}
	});

	$effect(() => {
		if (markovSeedLimit < markovCount) {
			markovSeedLimit = markovCount;
		}
	});

	function formatBytes(bytes: number): string {
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
		return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	}

	function formatSpeed(bytesPerSec: number): string {
		if (bytesPerSec < 1024) return `${bytesPerSec.toFixed(0)} B/s`;
		if (bytesPerSec < 1024 * 1024) return `${(bytesPerSec / 1024).toFixed(0)} KB/s`;
		return `${(bytesPerSec / (1024 * 1024)).toFixed(1)} MB/s`;
	}

	function formatDuration(ms: number): string {
		if (ms <= 0) return '0s';
		if (ms < 1000) return `${Math.round(ms)}ms`;
		return `${(ms / 1000).toFixed(1)}s`;
	}

	function buildRepoDownloadDetail(downloadProgress: RepoDownloadProgress): string {
		const detailParts = [
			`${formatBytes(downloadProgress.receivedBytes)}${downloadProgress.totalBytes > 0 ? ` / ${formatBytes(downloadProgress.totalBytes)}` : ''}`
		];
		if (downloadProgress.bytesPerSecond > 0) {
			detailParts.push(formatSpeed(downloadProgress.bytesPerSecond));
		}
		if (downloadProgress.elapsedMs > 0) {
			detailParts.push(`${formatDuration(downloadProgress.elapsedMs)} elapsed`);
		}
		return detailParts.join(' · ');
	}

	function normalizeHandle(handle: string | null | undefined): string {
		return (handle ?? '').replace(/^@/, '').trim();
	}

	function updateAuthorsQuery(authors: ProfileInfo[] = corpusAuthors) {
		if (!browser) return;
		const url = new URL(window.location.href);
		if (authors.length > 1) {
			url.searchParams.set('handles', authors.map((author) => author.handle).join(','));
			url.searchParams.delete('handle');
		} else if (authors.length === 1) {
			url.searchParams.set('handle', authors[0].handle);
			url.searchParams.delete('handles');
		} else {
			url.searchParams.delete('handle');
			url.searchParams.delete('handles');
		}
		window.history.replaceState({}, '', url.toString());
	}

	function handleFontChange(key: string) {
		fontKey = key;
		try {
			localStorage.setItem('preferred-font', key);
		} catch {}
	}

	function setProfile(nextProfile: ProfileInfo) {
		profile = nextProfile;
		initialHandle = nextProfile.handle;
		addCorpusAuthor(nextProfile);
		error = null;
	}

	function addCorpusAuthor(nextProfile: ProfileInfo) {
		const exists = corpusAuthors.some(
			(author) => author.did === nextProfile.did || author.handle === nextProfile.handle
		);
		const nextAuthors = exists ? corpusAuthors : [...corpusAuthors, nextProfile];
		if (!exists) {
			corpusAuthors = nextAuthors;
			resetCorpus();
		}
		profile = nextProfile;
		initialHandle = nextProfile.handle;
		updateAuthorsQuery(nextAuthors);
	}

	function removeCorpusAuthor(did: string) {
		corpusAuthors = corpusAuthors.filter((author) => author.did !== did);
		if (profile?.did === did) {
			profile = corpusAuthors[corpusAuthors.length - 1] ?? null;
			initialHandle = profile?.handle ?? '';
		}
		updateAuthorsQuery(corpusAuthors);
		resetCorpus();
	}

	async function selectHandle(rawHandle: string) {
		const handle = normalizeHandle(rawHandle);
		if (!handle) return;

		profileLoading = true;
		error = null;
		try {
			const nextProfile = await getProfile(handle);
			setProfile(nextProfile);
		} catch (err: any) {
			error = err?.message || `Could not resolve @${handle}.`;
			profile = null;
		} finally {
			profileLoading = false;
		}
	}

	function handleProfileSelected(nextProfile: ProfileInfo) {
		setProfile(nextProfile);
	}

	function resetCorpus() {
		corpusPosts = [];
		corpusIndex = null;
		corpusStats = {
			totalPosts: 0,
			usablePosts: 0,
			tokenCount: 0,
			contextCount: 0,
			elapsedMs: 0,
			downloadedBytes: 0,
			source: null,
			authorCount: 0
		};
		selectedSuggestionIndex = 0;
	}

	function syncCompletionState() {
		if (completionRefreshTimer) {
			clearTimeout(completionRefreshTimer);
			completionRefreshTimer = null;
		}
		completionText = draftText;
		completionCursorIndex = cursorIndex;
	}

	function scheduleCompletionRefresh(delay = COMPLETION_REFRESH_MS) {
		if (completionRefreshTimer) {
			clearTimeout(completionRefreshTimer);
		}
		completionRefreshTimer = setTimeout(() => {
			completionRefreshTimer = null;
			completionText = draftText;
			completionCursorIndex = cursorIndex;
		}, delay);
	}

	function saveDraftSoon() {
		if (draftSaveTimer) {
			clearTimeout(draftSaveTimer);
		}
		draftSaveTimer = setTimeout(() => {
			draftSaveTimer = null;
			try {
				localStorage.setItem('loom-draft', draftText);
			} catch {}
		}, DRAFT_SAVE_MS);
	}

	function abortDownload() {
		abortController?.abort();
		abortController = null;
		loading = false;
	}

	function normalizeCorpusPosts(posts: CorpusPost[]): CorpusPost[] {
		return posts
			.map((post) => ({
				text: typeof post.text === 'string' ? post.text.trim() : '',
				uri: typeof post.uri === 'string' ? post.uri : undefined,
				createdAt: typeof post.createdAt === 'string' ? post.createdAt : undefined,
				authorDid: typeof post.authorDid === 'string' ? post.authorDid : undefined,
				authorHandle: typeof post.authorHandle === 'string' ? post.authorHandle : undefined,
				authorDisplayName:
					typeof post.authorDisplayName === 'string' ? post.authorDisplayName : undefined,
				authorAvatar: typeof post.authorAvatar === 'string' ? post.authorAvatar : undefined
			}))
			.filter((post) => post.text.length > 0);
	}

	function authorProfilesFromPosts(posts: CorpusPost[]): ProfileInfo[] {
		const authors = new Map<string, ProfileInfo>();
		for (const post of posts) {
			const did = post.authorDid;
			const handle = post.authorHandle;
			if (!did || !handle || authors.has(did)) continue;
			authors.set(did, {
				did,
				handle,
				displayName: post.authorDisplayName,
				avatar: post.authorAvatar,
				postsCount: 0
			});
		}
		return [...authors.values()];
	}

	function rebuildCorpusFromPosts(
		posts: CorpusPost[],
		options: {
			totalPosts?: number;
			downloadedBytes?: number;
			source?: CorpusStats['source'];
			authorCount?: number;
			elapsedMs?: number;
		} = {}
	) {
		const startedAt = performance.now();
		const usablePosts = normalizeCorpusPosts(posts);
		usablePosts.sort((a, b) => {
			const aTime = a.createdAt ? Date.parse(a.createdAt) : 0;
			const bTime = b.createdAt ? Date.parse(b.createdAt) : 0;
			return (Number.isFinite(bTime) ? bTime : 0) - (Number.isFinite(aTime) ? aTime : 0);
		});

		const nextIndex = buildCorpusCompletionIndex(usablePosts, {
			maxContextTokens: 3,
			maxExamples: 4,
			maxEchoPosts: ECHO_POST_LIMIT,
			removeBskyAppUrls
		});

		corpusPosts = usablePosts;
		corpusIndex = nextIndex;
		corpusStats = {
			totalPosts: options.totalPosts ?? usablePosts.length,
			usablePosts: usablePosts.length,
			tokenCount: nextIndex.tokenCount,
			contextCount: nextIndex.contextCount,
			elapsedMs: options.elapsedMs ?? Math.round(performance.now() - startedAt),
			downloadedBytes: options.downloadedBytes ?? 0,
			source: options.source ?? null,
			authorCount: options.authorCount ?? corpusAuthors.length
		};
		selectedSuggestionIndex = 0;
		syncCompletionState();
	}

	function handleBskyUrlFilterToggle(event: Event) {
		const nextValue = (event.currentTarget as HTMLInputElement).checked;
		if (removeBskyAppUrls === nextValue) return;

		removeBskyAppUrls = nextValue;
		try {
			localStorage.setItem(BSKY_URL_FILTER_STORAGE_KEY, nextValue ? '1' : '0');
		} catch {}

		if (corpusPosts.length > 0) {
			rebuildCorpusFromPosts(corpusPosts, {
				totalPosts: corpusStats.totalPosts,
				downloadedBytes: corpusStats.downloadedBytes,
				source: corpusStats.source,
				authorCount: corpusStats.authorCount || corpusAuthors.length
			});
		}
	}

	async function downloadCorpus() {
		if (corpusAuthors.length === 0 || loading) return;

		abortController?.abort();
		const controller = new AbortController();
		abortController = controller;
		loading = true;
		error = null;
		resetCorpus();

		try {
			const authors = [...corpusAuthors];
			const startedAt = performance.now();
			const posts: CorpusPost[] = [];
			let totalPosts = 0;
			let downloadedBytes = 0;
			const sources = new Set<'pds' | 'relay'>();

			for (let authorIndex = 0; authorIndex < authors.length; authorIndex += 1) {
				const currentAuthor = authors[authorIndex];
				const author: AuthorInfo = {
					did: currentAuthor.did,
					handle: currentAuthor.handle,
					displayName: currentAuthor.displayName,
					avatar: currentAuthor.avatar
				};
				let latestDownloadedBytes = 0;
				progress = {
					phase: `Preparing @${currentAuthor.handle}...`,
					current: authorIndex,
					total: authors.length,
					detail: `${authorIndex + 1} / ${authors.length} authors`
				};

				const repo = await loadRepoFeedItems(currentAuthor.did, author, {
					signal: controller.signal,
					onDownloadProgress: (downloadProgress) => {
						latestDownloadedBytes = downloadProgress.receivedBytes;
						progress =
							downloadProgress.totalBytes > 0
								? {
										phase: `Downloading @${currentAuthor.handle}...`,
										current: Math.round(
											(downloadProgress.receivedBytes / downloadProgress.totalBytes) * 100
										),
										total: 100,
										detail: `${authorIndex + 1} / ${authors.length} authors · ${buildRepoDownloadDetail(downloadProgress)}`
									}
								: {
										phase: `Downloading @${currentAuthor.handle}...`,
										current: authorIndex,
										total: authors.length,
										detail: buildRepoDownloadDetail(downloadProgress)
									};
					},
					onParseProgress: (count) => {
						progress = {
							phase: `Parsing @${currentAuthor.handle}...`,
							current: authorIndex,
							total: authors.length,
							detail: `${count.toLocaleString()} posts extracted from ${formatBytes(latestDownloadedBytes)}`
						};
					}
				});

				if (controller.signal.aborted) return;

				totalPosts += repo.totalPosts;
				downloadedBytes += repo.downloadedBytes;
				sources.add(repo.source);
				posts.push(
					...repo.parsedPosts
						.map((post) => {
							const text = typeof post.record?.text === 'string' ? post.record.text.trim() : '';
							return {
								text,
								uri: `at://${currentAuthor.did}/app.bsky.feed.post/${post.rkey}`,
								createdAt:
									typeof post.record?.createdAt === 'string' ? post.record.createdAt : undefined,
								authorDid: currentAuthor.did,
								authorHandle: currentAuthor.handle,
								authorDisplayName: currentAuthor.displayName,
								authorAvatar: currentAuthor.avatar
							};
						})
						.filter((post) => post.text.length > 0)
				);
			}

			progress = {
				phase: 'Building corpus...',
				current: posts.length,
				total: totalPosts,
				detail: `${posts.length.toLocaleString()} text posts from ${authors.length.toLocaleString()} authors`
			};

			rebuildCorpusFromPosts(posts, {
				totalPosts,
				elapsedMs: Math.round(performance.now() - startedAt),
				downloadedBytes,
				source: sources.size > 1 ? 'mixed' : [...sources][0] ?? null,
				authorCount: authors.length
			});
		} catch (err: any) {
			if (err?.name !== 'AbortError') {
				error = err?.message || 'Could not download the selected corpus.';
			}
		} finally {
			if (abortController === controller) {
				abortController = null;
				loading = false;
			}
		}
	}

	function exportCorpusFile() {
		if (!browser || corpusPosts.length === 0) return;
		const payload: LoomCorpusFile = {
			version: 1,
			exportedAt: new Date().toISOString(),
			authors: corpusAuthors,
			stats: {
				totalPosts: corpusStats.totalPosts,
				usablePosts: corpusStats.usablePosts,
				downloadedBytes: corpusStats.downloadedBytes,
				source: corpusStats.source,
				authorCount: corpusStats.authorCount
			},
			posts: corpusPosts
		};
		const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
		const url = URL.createObjectURL(blob);
		const link = document.createElement('a');
		const handleSlug = corpusAuthors.map((author) => author.handle).join('_') || 'local';
		link.href = url;
		link.download = `loom-corpus-${handleSlug}-${new Date().toISOString().slice(0, 10)}.json`;
		document.body.appendChild(link);
		link.click();
		link.remove();
		URL.revokeObjectURL(url);
	}

	function triggerCorpusImport() {
		corpusFileInputEl?.click();
	}

	function normalizeImportedAuthors(value: unknown): ProfileInfo[] {
		if (!Array.isArray(value)) return [];
		return value
			.map((author): ProfileInfo | null => {
				if (!author || typeof author !== 'object') return null;
				const candidate = author as Partial<ProfileInfo>;
				if (typeof candidate.did !== 'string' || typeof candidate.handle !== 'string') return null;

				const nextAuthor: ProfileInfo = {
					did: candidate.did,
					handle: candidate.handle,
					postsCount: Number.isFinite(Number(candidate.postsCount))
						? Math.max(0, Math.round(Number(candidate.postsCount)))
						: 0
				};
				if (typeof candidate.displayName === 'string') {
					nextAuthor.displayName = candidate.displayName;
				}
				if (typeof candidate.avatar === 'string') {
					nextAuthor.avatar = candidate.avatar;
				}
				return nextAuthor;
			})
			.filter((author): author is ProfileInfo => author !== null);
	}

	async function importCorpusJson(file: File) {
		const startedAt = performance.now();
		const raw = JSON.parse(await file.text()) as Partial<LoomCorpusFile>;
		const posts = Array.isArray(raw.posts) ? normalizeCorpusPosts(raw.posts as CorpusPost[]) : [];
		if (posts.length === 0) {
			throw new Error('That corpus file did not contain any text posts.');
		}

		const importedAuthors = normalizeImportedAuthors(raw.authors);
		corpusAuthors = importedAuthors.length > 0 ? importedAuthors : authorProfilesFromPosts(posts);
		profile = corpusAuthors[0] ?? null;
		initialHandle = profile?.handle ?? '';
		updateAuthorsQuery(corpusAuthors);

		progress = {
			phase: 'Building imported corpus...',
			current: posts.length,
			total: posts.length,
			detail: file.name
		};
		rebuildCorpusFromPosts(posts, {
			totalPosts: raw.stats?.totalPosts ?? posts.length,
			downloadedBytes: file.size,
			source: 'file',
			authorCount: corpusAuthors.length,
			elapsedMs: Math.round(performance.now() - startedAt)
		});
	}

	async function importCorpusCar(file: File) {
		const selectedAuthor = profile ?? corpusAuthors[0] ?? null;
		if (!selectedAuthor) {
			throw new Error('Add the author handle first, then upload that author’s CAR file.');
		}

		const startedAt = performance.now();
		progress = {
			phase: `Reading ${file.name}...`,
			current: 0,
			total: file.size,
			detail: `${formatBytes(file.size)} local CAR`
		};
		const parsedPosts = await parseCarPostsWasm(new Uint8Array(await file.arrayBuffer()), (count) => {
			progress = {
				phase: `Parsing ${file.name}...`,
				current: count,
				total: count,
				detail: `${count.toLocaleString()} posts extracted`
			};
		});

		const posts = parsedPosts
			.map((post) => {
				const text = typeof post.record?.text === 'string' ? post.record.text.trim() : '';
				return {
					text,
					uri: `at://${selectedAuthor.did}/app.bsky.feed.post/${post.rkey}`,
					createdAt: typeof post.record?.createdAt === 'string' ? post.record.createdAt : undefined,
					authorDid: selectedAuthor.did,
					authorHandle: selectedAuthor.handle,
					authorDisplayName: selectedAuthor.displayName,
					authorAvatar: selectedAuthor.avatar
				};
			})
			.filter((post) => post.text.length > 0);

		corpusAuthors = [selectedAuthor];
		profile = selectedAuthor;
		initialHandle = selectedAuthor.handle;
		updateAuthorsQuery(corpusAuthors);
		progress = {
			phase: 'Building uploaded corpus...',
			current: posts.length,
			total: parsedPosts.length,
			detail: `${posts.length.toLocaleString()} text posts`
		};
		rebuildCorpusFromPosts(posts, {
			totalPosts: parsedPosts.length,
			downloadedBytes: file.size,
			source: 'file',
			authorCount: 1,
			elapsedMs: Math.round(performance.now() - startedAt)
		});
	}

	async function handleCorpusFileSelected(event: Event) {
		const input = event.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		input.value = '';
		if (!file || loading) return;

		abortController?.abort();
		abortController = null;
		loading = true;
		error = null;
		resetCorpus();

		try {
			const isJson = file.type === 'application/json' || file.name.toLowerCase().endsWith('.json');
			if (isJson) {
				await importCorpusJson(file);
			} else {
				await importCorpusCar(file);
			}
		} catch (err: any) {
			error = err?.message || 'Could not import that corpus file.';
		} finally {
			loading = false;
		}
	}

	function captureCursor() {
		cursorIndex = editorEl?.selectionStart ?? draftText.length;
		selectedSuggestionIndex = Math.min(selectedSuggestionIndex, Math.max(0, suggestions.length - 1));
		scheduleCompletionRefresh();
	}

	function handleEditorInput() {
		captureCursor();
		selectedSuggestionIndex = 0;
		saveDraftSoon();
	}

	function handleEchoScroll(event: Event) {
		echoScrollTop = (event.currentTarget as HTMLElement).scrollTop;
	}

	async function applySuggestion(suggestion: CorpusSuggestion | null) {
		if (!suggestion || !editorEl) return;
		const start = Math.max(0, Math.min(cursorIndex, draftText.length));
		const insertText = suggestion.insertText;
		draftText = `${draftText.slice(0, start)}${insertText}${draftText.slice(start)}`;
		cursorIndex = start + insertText.length;
		selectedSuggestionIndex = 0;
		syncCompletionState();
		try {
			localStorage.setItem('loom-draft', draftText);
		} catch {}
		await tick();
		editorEl.focus();
		editorEl.setSelectionRange(cursorIndex, cursorIndex);
	}

	async function applyMarkovContinuation(continuation: CorpusMarkovContinuation | null) {
		if (!continuation || !editorEl) return;
		const start = Math.max(0, Math.min(cursorIndex, draftText.length));
		draftText = `${draftText.slice(0, start)}${continuation.insertText}${draftText.slice(start)}`;
		cursorIndex = start + continuation.insertText.length;
		syncCompletionState();
		try {
			localStorage.setItem('loom-draft', draftText);
		} catch {}
		await tick();
		editorEl.focus();
		editorEl.setSelectionRange(cursorIndex, cursorIndex);
	}

	function handleEditorKeydown(event: KeyboardEvent) {
		if (event.key === 'Tab' && event.shiftKey && markovContinuations[0]) {
			event.preventDefault();
			void applyMarkovContinuation(markovContinuations[0]);
			return;
		}

		if (event.key === 'Tab' && selectedSuggestion) {
			event.preventDefault();
			void applySuggestion(selectedSuggestion);
			return;
		}

		if ((event.metaKey || event.ctrlKey) && event.key === 'ArrowDown' && suggestions.length > 0) {
			event.preventDefault();
			selectedSuggestionIndex = (selectedSuggestionIndex + 1) % suggestions.length;
			return;
		}

		if ((event.metaKey || event.ctrlKey) && event.key === 'ArrowUp' && suggestions.length > 0) {
			event.preventDefault();
			selectedSuggestionIndex =
				selectedSuggestionIndex <= 0 ? suggestions.length - 1 : selectedSuggestionIndex - 1;
		}
	}

	function previewText(text: string): string {
		const trimmed = text.trim();
		if (!trimmed) return '';
		if (trimmed.length <= 220) return trimmed;
		return `${trimmed.slice(0, 217).trimEnd()}...`;
	}

	function buildHighlightedSegments(
		text: string,
		suggestion: CorpusSuggestion | null
	): HighlightSegment[] {
		if (!text) return [];
		if (!suggestion) return [{ text, match: false }];

		const targetTokens = [...suggestion.contextTokens, suggestion.token].map((token) =>
			token.toLocaleLowerCase()
		);
		if (targetTokens.length === 0) return [{ text, match: false }];

		const tokens = [...text.matchAll(HIGHLIGHT_TOKEN_PATTERN)].map((match) => {
			const raw = match[0];
			const start = match.index ?? 0;
			return {
				lower: raw.toLocaleLowerCase(),
				start,
				end: start + raw.length
			};
		});

		const ranges: Array<{ start: number; end: number }> = [];
		for (let i = 0; i <= tokens.length - targetTokens.length; i += 1) {
			let matches = true;
			for (let j = 0; j < targetTokens.length; j += 1) {
				if (tokens[i + j]?.lower !== targetTokens[j]) {
					matches = false;
					break;
				}
			}
			if (matches) {
				ranges.push({
					start: tokens[i].start,
					end: tokens[i + targetTokens.length - 1].end
				});
				i += Math.max(0, targetTokens.length - 1);
			}
		}

		if (ranges.length === 0) return [{ text, match: false }];

		const segments: HighlightSegment[] = [];
		let cursor = 0;
		for (const range of ranges) {
			if (range.start > cursor) {
				segments.push({ text: text.slice(cursor, range.start), match: false });
			}
			segments.push({ text: text.slice(range.start, range.end), match: true });
			cursor = range.end;
		}
		if (cursor < text.length) {
			segments.push({ text: text.slice(cursor), match: false });
		}
		return segments;
	}

	function formatPostDate(createdAt: string | undefined): string {
		if (!createdAt) return '';
		const date = new Date(createdAt);
		if (Number.isNaN(date.getTime())) return '';
		return date.toLocaleDateString(undefined, {
			year: 'numeric',
			month: 'short',
			day: 'numeric'
		});
	}

	function postUrlFromUri(uri: string | undefined): string | null {
		if (!uri) return null;
		const did = uri.match(/^at:\/\/([^/]+)\//)?.[1];
		const author = corpusAuthors.find((candidate) => candidate.did === did);
		const handle = author?.handle;
		if (!handle) return null;
		const rkey = uri.split('/').pop();
		return rkey ? `https://bsky.app/profile/${handle}/post/${rkey}` : null;
	}

	function exampleAuthorLabel(example: { authorHandle?: string; authorDisplayName?: string }): string {
		return example.authorDisplayName || example.authorHandle || 'Unknown author';
	}

	async function loadInitialHandles(handles: string[]) {
		for (const handle of handles) {
			await selectHandle(handle);
		}
	}

	onMount(() => {
		try {
			const savedFont = localStorage.getItem('preferred-font');
			if (savedFont && savedFont in fontFamilies) {
				fontKey = savedFont;
			}
			const savedBskyUrlFilter = localStorage.getItem(BSKY_URL_FILTER_STORAGE_KEY);
			if (savedBskyUrlFilter !== null) {
				removeBskyAppUrls = savedBskyUrlFilter === '1';
			}
			draftText = localStorage.getItem('loom-draft') ?? '';
			cursorIndex = draftText.length;
			completionText = draftText;
			completionCursorIndex = cursorIndex;
		} catch {}

		const params = new URLSearchParams(window.location.search);
		const handlesParam = params.get('handles')?.trim() ?? '';
		const handles = handlesParam
			? handlesParam.split(',').map(normalizeHandle).filter(Boolean)
			: [params.get('handle')?.trim() ?? ''].map(normalizeHandle).filter(Boolean);
		if (handles.length > 0) {
			initialHandle = handles[0];
			void loadInitialHandles(handles);
		}
	});

	onDestroy(() => {
		if (completionRefreshTimer) {
			clearTimeout(completionRefreshTimer);
		}
		if (draftSaveTimer) {
			clearTimeout(draftSaveTimer);
		}
	});
</script>

<svelte:head>
	<title>Loom</title>
</svelte:head>

<main style="font-family: {fontFamily}">
	<header class="page-header">
		<RouteNav current="loom" align="center" handle={profile?.handle ?? initialHandle ?? null} />
		<div class="header-row">
			<div>
				<p class="eyebrow">ATProto corpus</p>
				<h1>Loom</h1>
				{#if corpusHandleLabel}
					<p class="corpus-subtitle">{corpusHandleLabel}</p>
				{/if}
			</div>
			<FontPicker value={fontKey} onchange={handleFontChange} />
		</div>
	</header>

	<section class="control-strip wobbly-border-light">
		<div class="search-cell">
			<SearchBar
				onsearch={selectHandle}
				onprofile={handleProfileSelected}
				disabled={loading || profileLoading}
				{initialHandle}
				placeholder="handle.bsky.social"
				buttonLabel="Add Author"
			/>
		</div>
		<div class="profile-cell">
			{#if corpusAuthors.length > 0}
				<div class="author-chip-list" aria-label="Corpus authors">
					{#each corpusAuthors as author (author.did)}
						<div class="author-chip">
							{#if author.avatar}
								<img class="avatar small-avatar" src={author.avatar} alt="" />
							{:else}
								<div class="avatar small-avatar avatar-placeholder"></div>
							{/if}
							<div>
								<strong>{author.displayName || author.handle}</strong>
								<span>@{author.handle}</span>
							</div>
							<button
								class="remove-author"
								type="button"
								disabled={loading}
								aria-label={`Remove @${author.handle}`}
								onclick={() => removeCorpusAuthor(author.did)}
							>
								x
							</button>
						</div>
					{/each}
				</div>
			{:else}
				<div class="empty-profile">No corpus authors</div>
			{/if}
		</div>
		<div class="action-cell">
			<input
				bind:this={corpusFileInputEl}
				class="file-input"
				type="file"
				accept=".json,.car,application/json,application/vnd.ipld.car"
				onchange={handleCorpusFileSelected}
			/>
			{#if loading}
				<button class="secondary-btn wobbly-border-light" type="button" onclick={abortDownload}>Cancel</button>
			{:else}
				<button class="primary-btn wobbly-border" type="button" disabled={!canDownload} onclick={downloadCorpus}>
					Download Corpus
				</button>
				<button class="secondary-btn wobbly-border-light" type="button" onclick={triggerCorpusImport}>
					Import File
				</button>
				<button
					class="secondary-btn wobbly-border-light"
					type="button"
					disabled={corpusPosts.length === 0}
					onclick={exportCorpusFile}
				>
					Export File
				</button>
			{/if}
		</div>
	</section>

	{#if error}
		<ErrorBanner message={error} />
	{/if}

	{#if loading}
		<LoadingSpinner {progress} />
	{/if}

	<section class="corpus-options" aria-label="Corpus options">
		<label class="corpus-toggle wobbly-border-light">
			<input
				type="checkbox"
				checked={removeBskyAppUrls}
				onchange={handleBskyUrlFilterToggle}
			/>
			<span>Remove bsky.app URLs</span>
		</label>
	</section>

	<section class="stats-bar" aria-label="Corpus stats">
		<div class="stat wobbly-border-light">
			<span>Posts</span>
			<strong>{corpusStats.usablePosts.toLocaleString()}</strong>
		</div>
		<div class="stat wobbly-border-light">
			<span>Tokens</span>
			<strong>{corpusStats.tokenCount.toLocaleString()}</strong>
		</div>
		<div class="stat wobbly-border-light">
			<span>Contexts</span>
			<strong>{corpusStats.contextCount.toLocaleString()}</strong>
		</div>
		<div class="stat wobbly-border-light">
			<span>Source</span>
			<strong>{corpusStats.source?.toUpperCase() ?? '-'}</strong>
		</div>
		<div class="stat wobbly-border-light">
			<span>Authors</span>
			<strong>{corpusStats.authorCount || corpusAuthors.length}</strong>
		</div>
	</section>

	<section class="loom-workspace">
		<div class="board-stage wobbly-border-light">
			<svg class="board-lines" viewBox="0 0 1000 560" preserveAspectRatio="none" aria-hidden="true">
				<path class="line-main" d="M 348 205 C 455 150, 548 150, 650 205" />
				<path class="line-side" d="M 348 355 C 480 430, 705 410, 820 315" />
			</svg>

			<article class="loom-card draft-card">
				<div class="card-heading">
					<span>Draft post</span>
					<small>{draftText.length.toLocaleString()} chars</small>
				</div>
				<textarea
					bind:this={editorEl}
					bind:value={draftText}
					oninput={handleEditorInput}
					onclick={captureCursor}
					onkeyup={captureCursor}
					onselect={captureCursor}
					onkeydown={handleEditorKeydown}
					placeholder="Good"
					spellcheck="true"
					rows="9"
				></textarea>
				<div class="draft-preview" aria-live="polite">
					{#if draftText || ghostText}
						<span>{draftBeforeCursor}</span><span class="ghost-text">{ghostText}</span><span>{draftAfterCursor}</span>
					{:else}
						<span class="muted-preview">...</span>
					{/if}
				</div>
			</article>

			<article class="loom-card completion-card" class:empty={!selectedSuggestion}>
				<div class="card-heading">
					<span>Corpus echo</span>
					{#if selectedSuggestion}
						<small>{selectedSuggestion.display} · {selectedSuggestion.count.toLocaleString()}x</small>
					{/if}
				</div>
				{#if selectedSuggestion && corpusEchoPosts.length > 0}
					{@const echoUrl = postUrlFromUri(corpusEchoPosts[0]?.uri)}
					<div
						bind:this={echoScrollEl}
						class="echo-text echo-scroll"
						role="region"
						aria-label="Matching corpus echo posts"
						onscroll={handleEchoScroll}
					>
						<div style:height={`${echoTopPad}px`} aria-hidden="true"></div>
						{#each visibleEchoPosts as echoPost, index (echoPost.uri ?? `${echoStartIndex + index}:${echoPost.text}`)}
							{@const postUrl = postUrlFromUri(echoPost.uri)}
							<article class="echo-post">
								<div class="echo-post-meta">
									{#if echoPost.authorAvatar}
										<img class="avatar tiny-avatar" src={echoPost.authorAvatar} alt="" />
									{/if}
									<span>{exampleAuthorLabel(echoPost)}</span>
									{#if echoPost.authorHandle}
										<small>@{echoPost.authorHandle}</small>
									{/if}
									{#if postUrl}
										<a href={postUrl} target="_blank" rel="noreferrer">Open</a>
									{/if}
								</div>
								<div class="echo-post-text">
									{#each buildHighlightedSegments(echoPost.text, selectedSuggestion) as segment}
										{#if segment.match}
											<mark class="ngram-highlight">{segment.text}</mark>
										{:else}
											{segment.text}
										{/if}
									{/each}
								</div>
							</article>
						{/each}
						<div style:height={`${echoBottomPad}px`} aria-hidden="true"></div>
					</div>
					<div class="echo-actions">
						<button class="accept-echo-btn" type="button" onclick={() => applySuggestion(selectedSuggestion)}>
							Accept {selectedSuggestion.insertText.trim()}
						</button>
						{#if echoUrl}
							<a class="echo-link" href={echoUrl} target="_blank" rel="noreferrer">Open post</a>
						{/if}
					</div>
					<p class="completion-meta">
						Seen {selectedSuggestion.count.toLocaleString()} time{selectedSuggestion.count === 1 ? '' : 's'}
						across {selectedSuggestion.postCount.toLocaleString()} post{selectedSuggestion.postCount === 1 ? '' : 's'}.
						Showing {corpusEchoPosts.length.toLocaleString()} of {selectedSuggestion.postCount.toLocaleString()} echo post{selectedSuggestion.postCount === 1 ? '' : 's'}.
					</p>
				{:else if selectedSuggestion && topEcho}
					<div class="echo-text">
						{#each buildHighlightedSegments(topEcho.text, selectedSuggestion) as segment}
							{#if segment.match}
								<mark class="ngram-highlight">{segment.text}</mark>
							{:else}
								{segment.text}
							{/if}
						{/each}
					</div>
					<button class="accept-echo-btn" type="button" onclick={() => applySuggestion(selectedSuggestion)}>
						Accept {selectedSuggestion.insertText.trim()}
					</button>
				{:else if selectedSuggestion}
					<div class="echo-text empty-echo">
						{selectedSuggestion.display}
					</div>
					<button class="accept-echo-btn" type="button" onclick={() => applySuggestion(selectedSuggestion)}>
						Accept {selectedSuggestion.insertText.trim()}
					</button>
				{:else}
					<div class="echo-text placeholder-completion">...</div>
				{/if}
			</article>

			<aside class="suggestion-rail">
				<div class="rail-heading">
					<span>Suggestions</span>
					<small>{suggestions.length}</small>
				</div>
				{#if suggestions.length > 0}
					<div class="suggestion-list">
						{#each suggestions as suggestion, index}
							<button
								type="button"
								class="suggestion-row"
								class:selected={index === Math.min(selectedSuggestionIndex, suggestions.length - 1)}
								onclick={() => applySuggestion(suggestion)}
								onmouseenter={() => (selectedSuggestionIndex = index)}
							>
								<span class="suggestion-token">{suggestion.display}</span>
								<span class="suggestion-count">{suggestion.source === 'word' ? 'word' : suggestion.count.toLocaleString()}</span>
							</button>
						{/each}
					</div>
				{:else}
					<div class="empty-suggestions">No completion</div>
				{/if}

				<div class="markov-panel">
					<div class="rail-heading compact-heading">
						<span>Markov chains</span>
						<small>{markovContinuations.length}</small>
					</div>
					<div class="markov-controls">
						<label>
							<span>Chains</span>
							<input type="range" min="1" max="8" step="1" bind:value={markovCount} />
							<strong>{markovCount}</strong>
						</label>
						<label>
							<span>Words</span>
							<input type="range" min="4" max="30" step="1" bind:value={markovMaxTokens} />
							<strong>{markovMaxTokens}</strong>
						</label>
						<label>
							<span>Seed pool</span>
							<input type="range" min={markovCount} max="32" step="1" bind:value={markovSeedLimit} />
							<strong>{markovSeedLimit}</strong>
						</label>
						<div class="markov-mode-control" aria-label="Markov continuation style">
							{#each [
								{ id: 'frequent', label: 'Frequent' },
								{ id: 'varied', label: 'Varied' },
								{ id: 'loose', label: 'Loose' }
							] as mode}
								<button
									type="button"
									class:active={markovStrategy === mode.id}
									onclick={() => (markovStrategy = mode.id as CorpusMarkovStrategy)}
								>
									{mode.label}
								</button>
							{/each}
						</div>
					</div>
					{#if markovContinuations.length > 0}
						<div class="markov-list">
							{#each markovContinuations as chain}
								<button
									type="button"
									class="markov-row"
									onclick={() => applyMarkovContinuation(chain)}
								>
									<span class="markov-text">{chain.text}</span>
									<span class="markov-meta">{chain.tokens.length} words</span>
								</button>
							{/each}
						</div>
					{:else}
						<div class="empty-suggestions">No chain</div>
					{/if}
				</div>
			</aside>
		</div>

		<div class="source-board">
			<article class="source-card wobbly-border-light">
				<div class="card-heading">
					<span>Corpus echoes</span>
					{#if selectedSuggestion}
						<small>{selectedSuggestion.contextTokens.join(' ')}</small>
					{/if}
				</div>
				{#if selectedSuggestion && selectedSuggestion.examples.length > 0}
					<div class="examples">
						{#each selectedSuggestion.examples as example}
							{@const url = postUrlFromUri(example.uri)}
							{#if url}
								<a class="example" href={url} target="_blank" rel="noreferrer">
									<span class="example-author">{exampleAuthorLabel(example)}</span>
									{#each buildHighlightedSegments(previewText(example.text), selectedSuggestion) as segment}
										{#if segment.match}
											<mark class="ngram-highlight">{segment.text}</mark>
										{:else}
											{segment.text}
										{/if}
									{/each}
								</a>
							{:else}
								<p class="example">
									<span class="example-author">{exampleAuthorLabel(example)}</span>
									{#each buildHighlightedSegments(previewText(example.text), selectedSuggestion) as segment}
										{#if segment.match}
											<mark class="ngram-highlight">{segment.text}</mark>
										{:else}
											{segment.text}
										{/if}
									{/each}
								</p>
							{/if}
						{/each}
					</div>
				{:else if corpusIndex}
					<p class="empty-examples">No matching continuation yet.</p>
				{:else}
					<p class="empty-examples">Corpus not loaded.</p>
				{/if}
			</article>

			<article class="source-card stats-card wobbly-border-light">
				<div class="card-heading">
					<span>Download</span>
					<small>{corpusStats.elapsedMs ? formatDuration(corpusStats.elapsedMs) : '-'}</small>
				</div>
				<div class="download-facts">
					<span>{formatBytes(corpusStats.downloadedBytes)}</span>
					<span>{corpusStats.totalPosts.toLocaleString()} records</span>
					<span>{corpusPosts.length.toLocaleString()} text posts</span>
					<span>{(corpusStats.authorCount || corpusAuthors.length).toLocaleString()} authors</span>
				</div>
			</article>

		</div>
	</section>
</main>

<style>
	main {
		width: min(1480px, 100%);
		margin: 0 auto;
		padding: 28px 20px 44px;
	}

	.page-header {
		margin: 0 auto 18px;
	}

	.header-row {
		display: flex;
		align-items: end;
		justify-content: space-between;
		gap: 18px;
		max-width: 1100px;
		margin: 0 auto;
	}

	.eyebrow {
		color: #476a6f;
		font-family: system-ui, -apple-system, sans-serif;
		font-size: 0.78rem;
		font-weight: 800;
		letter-spacing: 0;
		text-transform: uppercase;
	}

	h1 {
		margin: 2px 0 0;
		color: var(--text-ink);
		font-size: clamp(2rem, 4vw, 3.3rem);
		line-height: 0.95;
	}

	.corpus-subtitle {
		max-width: min(760px, 88vw);
		margin: 6px 0 0;
		color: #476a6f;
		font-family: system-ui, -apple-system, sans-serif;
		font-size: 0.92rem;
		font-weight: 750;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.control-strip {
		display: grid;
		grid-template-columns: minmax(280px, 0.85fr) minmax(280px, 1fr) auto;
		gap: 16px;
		align-items: center;
		max-width: 1160px;
		margin: 0 auto 18px;
		padding: 14px;
		background: rgba(255, 254, 249, 0.86);
		box-shadow: 0 16px 34px rgba(24, 35, 43, 0.08);
	}

	.search-cell :global(.search-bar) {
		max-width: none;
		margin: 0;
	}

	.profile-cell {
		display: flex;
		align-items: center;
		gap: 10px;
		min-width: 0;
		font-family: system-ui, -apple-system, sans-serif;
	}

	.profile-cell strong,
	.profile-cell span {
		display: block;
		max-width: 230px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.profile-cell strong {
		font-size: 0.95rem;
		color: #18232b;
	}

	.profile-cell span,
	.empty-profile {
		color: var(--muted);
		font-size: 0.84rem;
	}

	.author-chip-list {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		max-height: 112px;
		overflow: auto;
		scrollbar-gutter: stable;
	}

	.author-chip {
		display: grid;
		grid-template-columns: auto minmax(0, 1fr) auto;
		gap: 8px;
		align-items: center;
		max-width: 260px;
		padding: 6px 7px;
		border: 1px solid rgba(61, 64, 91, 0.16);
		border-radius: 7px;
		background: #fffaf0;
		box-shadow: 0 6px 14px rgba(33, 40, 48, 0.06);
	}

	.author-chip strong,
	.author-chip span {
		max-width: 150px;
	}

	.avatar {
		width: 42px;
		height: 42px;
		flex: 0 0 auto;
		border-radius: 50%;
		object-fit: cover;
		border: 1px solid rgba(61, 64, 91, 0.24);
		background: #dbe7e4;
	}

	.avatar-placeholder {
		background: linear-gradient(135deg, #dbe7e4, #f4d7bf);
	}

	.small-avatar {
		width: 34px;
		height: 34px;
	}

	.tiny-avatar {
		width: 24px;
		height: 24px;
	}

	.remove-author {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 26px;
		height: 26px;
		border: 1px solid rgba(61, 64, 91, 0.18);
		border-radius: 50%;
		background: #fffef9;
		color: #476a6f;
		font: 0.85rem/1 system-ui, -apple-system, sans-serif;
		font-weight: 850;
	}

	.remove-author:hover:not(:disabled) {
		border-color: rgba(224, 122, 95, 0.5);
		background: #fff4ed;
		color: #b55643;
	}

	.remove-author:disabled {
		cursor: not-allowed;
		opacity: 0.45;
	}

	.action-cell {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		justify-content: flex-end;
	}

	.corpus-options {
		display: flex;
		justify-content: flex-end;
		max-width: 1160px;
		margin: 0 auto 12px;
	}

	.corpus-toggle {
		display: inline-flex;
		align-items: center;
		gap: 9px;
		min-height: 38px;
		padding: 8px 12px;
		background: rgba(255, 254, 249, 0.82);
		color: #38444b;
		font-family: system-ui, -apple-system, sans-serif;
		font-size: 0.84rem;
		font-weight: 850;
	}

	.corpus-toggle input {
		width: 16px;
		height: 16px;
		accent-color: #e07a5f;
	}

	.file-input {
		display: none;
	}

	button {
		font-family: inherit;
	}

	.primary-btn,
	.secondary-btn {
		min-height: 42px;
		padding: 9px 16px;
		border-color: var(--border-color);
		font-weight: 800;
		white-space: nowrap;
		transition:
			transform 0.14s ease,
			opacity 0.14s ease,
			box-shadow 0.14s ease;
	}

	.primary-btn {
		background: #e07a5f;
		color: white;
		box-shadow: 0 10px 22px rgba(224, 122, 95, 0.22);
	}

	.secondary-btn {
		background: #fffef9;
		color: #38444b;
	}

	.primary-btn:hover:not(:disabled),
	.secondary-btn:hover:not(:disabled) {
		transform: translateY(-1px);
	}

	.primary-btn:disabled,
	.secondary-btn:disabled {
		cursor: not-allowed;
		opacity: 0.48;
	}

	.stats-bar {
		display: grid;
		grid-template-columns: repeat(5, minmax(0, 1fr));
		gap: 12px;
		max-width: 1160px;
		margin: 0 auto 18px;
	}

	.stat {
		padding: 10px 14px;
		background: rgba(255, 254, 249, 0.8);
		font-family: system-ui, -apple-system, sans-serif;
	}

	.stat span,
	.stat strong {
		display: block;
	}

	.stat span {
		color: var(--muted);
		font-size: 0.74rem;
		font-weight: 800;
		text-transform: uppercase;
		letter-spacing: 0;
	}

	.stat strong {
		color: #18232b;
		font-size: 1.15rem;
		line-height: 1.15;
	}

	.loom-workspace {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 16px;
	}

	.board-stage {
		position: relative;
		display: grid;
		grid-template-columns: minmax(280px, 1fr) minmax(220px, 0.78fr) minmax(220px, 0.58fr);
		gap: 34px;
		min-height: 560px;
		padding: 34px;
		overflow: hidden;
		background:
			linear-gradient(rgba(61, 64, 91, 0.045) 1px, transparent 1px),
			linear-gradient(90deg, rgba(61, 64, 91, 0.045) 1px, transparent 1px),
			#f7f2df;
		background-size: 34px 34px;
		box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.55);
	}

	.board-lines {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		pointer-events: none;
	}

	.line-main,
	.line-side {
		fill: none;
		stroke-linecap: round;
		stroke-width: 4;
	}

	.line-main {
		stroke: rgba(71, 106, 111, 0.28);
	}

	.line-side {
		stroke: rgba(224, 122, 95, 0.2);
		stroke-dasharray: 12 12;
	}

	.loom-card,
	.source-card {
		position: relative;
		z-index: 1;
		border: 2px solid rgba(35, 38, 53, 0.82);
		border-radius: 7px;
		background: #fffef9;
		box-shadow: 0 18px 34px rgba(33, 40, 48, 0.14);
	}

	.loom-card {
		align-self: start;
		min-height: 260px;
		padding: 16px;
	}

	.draft-card {
		transform: rotate(-0.7deg);
	}

	.completion-card {
		margin-top: 66px;
		background: #eef3f1;
		border-color: rgba(71, 106, 111, 0.5);
		transform: rotate(0.8deg);
	}

	.completion-card.empty {
		opacity: 0.68;
	}

	.card-heading,
	.rail-heading {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		margin-bottom: 10px;
		font-family: system-ui, -apple-system, sans-serif;
		font-size: 0.76rem;
		font-weight: 850;
		letter-spacing: 0;
		text-transform: uppercase;
		color: #38444b;
	}

	.card-heading small,
	.rail-heading small {
		color: var(--muted);
		font-size: 0.72rem;
		font-weight: 750;
		text-transform: none;
	}

	textarea {
		display: block;
		width: 100%;
		min-height: 230px;
		resize: vertical;
		padding: 12px;
		border: 1px solid rgba(61, 64, 91, 0.2);
		border-radius: 7px;
		outline: none;
		background: #fffaf0;
		color: #1f2428;
		font: 1.12rem/1.5 system-ui, -apple-system, sans-serif;
	}

	textarea:focus {
		border-color: #e07a5f;
		box-shadow: 0 0 0 3px rgba(224, 122, 95, 0.16);
	}

	.draft-preview {
		min-height: 76px;
		margin-top: 12px;
		padding: 12px;
		border-radius: 7px;
		background: #f4efe2;
		color: #1f2428;
		font: 1rem/1.5 system-ui, -apple-system, sans-serif;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}

	.ghost-text {
		color: rgba(61, 64, 91, 0.42);
	}

	.ngram-highlight {
		padding: 0 2px;
		border-radius: 4px;
		background: #ffe08a;
		color: #1f2428;
		box-decoration-break: clone;
		-webkit-box-decoration-break: clone;
	}

	.muted-preview,
	.placeholder-completion,
	.empty-suggestions,
	.empty-examples,
	.empty-echo {
		color: var(--muted);
	}

	.echo-text {
		min-height: 160px;
		max-height: 260px;
		overflow: auto;
		width: 100%;
		padding: 16px;
		border: 1px dashed rgba(71, 106, 111, 0.45);
		border-radius: 7px;
		background: rgba(255, 255, 255, 0.58);
		color: #293138;
		font: 1rem/1.45 system-ui, -apple-system, sans-serif;
		overflow-wrap: anywhere;
		white-space: pre-wrap;
	}

	.echo-scroll {
		display: grid;
		gap: 10px;
		max-height: 330px;
		padding: 10px;
		scrollbar-gutter: stable;
	}

	.echo-post {
		display: grid;
		gap: 8px;
		min-height: 136px;
		padding: 10px 11px;
		border: 1px solid rgba(61, 64, 91, 0.13);
		border-radius: 7px;
		background: rgba(255, 254, 249, 0.86);
	}

	.echo-post-meta {
		display: flex;
		align-items: center;
		gap: 8px;
		min-width: 0;
		color: #38444b;
		font-family: system-ui, -apple-system, sans-serif;
		font-size: 0.78rem;
		font-weight: 850;
	}

	.echo-post-meta span {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.echo-post-meta small {
		color: var(--muted);
		font-size: 0.74rem;
		font-weight: 760;
	}

	.echo-post-meta a {
		margin-left: auto;
		color: #476a6f;
		font-size: 0.74rem;
		font-weight: 850;
		text-decoration: none;
	}

	.echo-post-meta a:hover {
		color: #b55643;
		text-decoration: underline;
	}

	.echo-post-text {
		color: #293138;
		font: 0.92rem/1.42 system-ui, -apple-system, sans-serif;
		overflow-wrap: anywhere;
		white-space: pre-wrap;
	}

	.echo-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 10px;
		align-items: center;
		margin-top: 12px;
	}

	.accept-echo-btn,
	.echo-link {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-height: 34px;
		padding: 7px 11px;
		border: 1px solid rgba(61, 64, 91, 0.22);
		border-radius: 7px;
		background: #fffef9;
		color: #293138;
		font: 0.84rem/1 system-ui, -apple-system, sans-serif;
		font-weight: 850;
		text-decoration: none;
	}

	.accept-echo-btn:hover,
	.echo-link:hover {
		border-color: rgba(224, 122, 95, 0.5);
		background: #fff4ed;
		text-decoration: none;
	}

	.completion-meta {
		margin-top: 12px;
		color: #476a6f;
		font-family: system-ui, -apple-system, sans-serif;
		font-size: 0.88rem;
		font-weight: 750;
	}

	.suggestion-rail {
		position: relative;
		z-index: 1;
		align-self: start;
		max-height: 460px;
		margin-top: 22px;
		padding: 14px;
		border: 1.5px solid rgba(61, 64, 91, 0.34);
		border-radius: 7px;
		background: rgba(255, 254, 249, 0.86);
		box-shadow: 0 14px 28px rgba(33, 40, 48, 0.1);
		overflow: auto;
	}

	.suggestion-list {
		display: grid;
		gap: 8px;
	}

	.suggestion-row {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		gap: 10px;
		align-items: center;
		width: 100%;
		padding: 9px 10px;
		border: 1px solid rgba(61, 64, 91, 0.14);
		border-radius: 7px;
		background: #fffef9;
		color: #1f2428;
		font-family: system-ui, -apple-system, sans-serif;
		text-align: left;
	}

	.suggestion-row:hover,
	.suggestion-row.selected {
		border-color: rgba(224, 122, 95, 0.5);
		background: #fff4ed;
	}

	.suggestion-token {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-weight: 800;
	}

	.suggestion-count {
		min-width: 38px;
		padding: 3px 7px;
		border-radius: 999px;
		background: #dbe7e4;
		color: #35545a;
		font-size: 0.8rem;
		font-weight: 850;
		text-align: center;
	}

	.markov-panel {
		margin-top: 18px;
		padding-top: 14px;
		border-top: 1px dashed rgba(61, 64, 91, 0.22);
	}

	.markov-controls {
		display: grid;
		gap: 10px;
		margin-bottom: 12px;
		padding: 10px;
		border: 1px solid rgba(61, 64, 91, 0.13);
		border-radius: 7px;
		background: rgba(255, 254, 249, 0.72);
		font-family: system-ui, -apple-system, sans-serif;
	}

	.markov-controls label {
		display: grid;
		grid-template-columns: 62px minmax(0, 1fr) 28px;
		gap: 8px;
		align-items: center;
		color: #38444b;
		font-size: 0.74rem;
		font-weight: 850;
	}

	.markov-controls input[type='range'] {
		width: 100%;
		accent-color: #e07a5f;
	}

	.markov-controls strong {
		color: #1f2428;
		font-size: 0.78rem;
		text-align: right;
	}

	.markov-mode-control {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 6px;
	}

	.markov-mode-control button {
		min-height: 30px;
		padding: 6px 7px;
		border: 1px solid rgba(61, 64, 91, 0.16);
		border-radius: 7px;
		background: #fffef9;
		color: #38444b;
		font-size: 0.74rem;
		font-weight: 850;
	}

	.markov-mode-control button:hover,
	.markov-mode-control button.active {
		border-color: rgba(224, 122, 95, 0.5);
		background: #fff4ed;
		color: #b55643;
	}

	.compact-heading {
		margin-bottom: 8px;
	}

	.markov-list {
		display: grid;
		gap: 8px;
	}

	.markov-row {
		display: grid;
		gap: 6px;
		width: 100%;
		padding: 10px;
		border: 1px solid rgba(71, 106, 111, 0.18);
		border-radius: 7px;
		background: #eef3f1;
		color: #253238;
		font-family: system-ui, -apple-system, sans-serif;
		text-align: left;
	}

	.markov-row:hover {
		border-color: rgba(71, 106, 111, 0.46);
		background: #e3eeeb;
	}

	.markov-text {
		font-size: 0.92rem;
		font-weight: 760;
		line-height: 1.32;
		overflow-wrap: anywhere;
	}

	.markov-meta {
		color: #476a6f;
		font-size: 0.72rem;
		font-weight: 850;
		text-transform: uppercase;
		letter-spacing: 0;
	}

	.source-board {
		display: grid;
		grid-template-columns: minmax(0, 1.3fr) minmax(220px, 0.7fr);
		gap: 16px;
	}

	.source-card {
		padding: 16px;
		background: rgba(255, 254, 249, 0.9);
	}

	.examples {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 10px;
		max-height: 360px;
		padding-right: 8px;
		overflow: auto;
		scrollbar-gutter: stable;
	}

	.example {
		display: block;
		min-height: 82px;
		padding: 10px 12px;
		border: 1px solid rgba(61, 64, 91, 0.13);
		border-radius: 7px;
		background: #fffaf0;
		color: #293138;
		font: 0.9rem/1.38 system-ui, -apple-system, sans-serif;
		overflow-wrap: anywhere;
	}

	.example-author {
		display: block;
		margin-bottom: 6px;
		color: #476a6f;
		font-size: 0.76rem;
		font-weight: 850;
		line-height: 1.1;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	a.example:hover {
		border-color: rgba(224, 122, 95, 0.5);
		text-decoration: none;
	}

	.download-facts {
		display: grid;
		gap: 8px;
		font-family: system-ui, -apple-system, sans-serif;
		color: #293138;
	}

	.download-facts span {
		padding: 8px 10px;
		border-radius: 7px;
		background: #eef3f1;
		font-weight: 750;
	}

	@media (max-width: 1040px) {
		.control-strip,
		.board-stage,
		.source-board {
			grid-template-columns: 1fr;
		}

		.action-cell {
			justify-content: stretch;
		}

		.primary-btn,
		.secondary-btn {
			width: 100%;
		}

		.completion-card,
		.suggestion-rail {
			margin-top: 0;
		}

		.board-lines {
			display: none;
		}
	}

	@media (max-width: 720px) {
		main {
			padding: 18px 12px 32px;
		}

		.header-row {
			align-items: start;
			flex-direction: column;
		}

		.control-strip,
		.board-stage {
			padding: 12px;
		}

		.stats-bar,
		.examples {
			grid-template-columns: 1fr 1fr;
		}

		.profile-cell strong,
		.profile-cell span {
			max-width: 100%;
		}
	}

	@media (max-width: 500px) {
		.stats-bar,
		.examples {
			grid-template-columns: 1fr;
		}

		.echo-actions {
			align-items: stretch;
			flex-direction: column;
		}
	}
</style>
