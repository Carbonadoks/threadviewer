<script lang="ts">
	import { tick } from 'svelte';
	import { onMount } from 'svelte';
	import { browser } from '$app/environment';
	import '../../app.css';
	import type { DiscoverProgress } from '$lib/types';
	import {
		fetchReplyParentVisibility,
		getProfile,
		getProfiles,
		type ProfileInfo,
		type ReplyParentVisibility
	} from '$lib/api/bluesky';
	import ErrorBanner from '$lib/components/ErrorBanner.svelte';
	import FontPicker from '$lib/components/FontPicker.svelte';
	import LoadingSpinner from '$lib/components/LoadingSpinner.svelte';
	import RouteNav from '$lib/components/RouteNav.svelte';
	import SearchBar from '$lib/components/SearchBar.svelte';
	import {
		findRepliesToBlockedParents,
		loadRepoBlockList,
		loadRepoFeedItems,
		parseRepoFeedItemsFromCar,
		type BlockedParentReply,
		type BlockedParentReplyScanStats
	} from '$lib/utils/repoHydration';
	import type { SavedRepoCarEntry } from '$lib/utils/localStorageRepo';
	import {
		buildAtUri,
		buildBskyPostUrl,
		buildViewerHref,
		parseBskyPostUrl
	} from '$lib/utils/viewerLinks';

	type RepoLoadStats = {
		source: 'pds' | 'relay' | null;
		elapsedMs: number;
		downloadedBytes: number;
		totalPosts: number;
	};

	type RepoBlockStats = {
		source: 'pds' | 'appview' | null;
		elapsedMs: number;
		downloadedBytes: number;
		totalBlocks: number;
		error: string | null;
	};

	type RepoPostSearchResult = {
		uri: string;
		cid: string;
		text: string;
		createdAt: string;
		parentUri: string | null;
		rootUri: string | null;
		parentText: string;
		parentCreatedAt: string;
		parentInRepo: boolean;
		hiddenReply: BlockedParentReply | null;
		parentVisibility: ReplyParentVisibility | null;
		parentBlockedByRepoOwner: boolean;
	};

	type BlockedRootReplyGroup = {
		rootUri: string;
		replies: BlockedParentReply[];
		parentUris: string[];
		latestCreatedAt: string;
	};

	type BlockedUserReplyGroup = {
		did: string;
		profile: ProfileInfo | null;
		replies: BlockedParentReply[];
		rootGroups: BlockedRootReplyGroup[];
		latestCreatedAt: string;
	};

	const fontFamilies: Record<string, string> = {
		virgil: "'Virgil', cursive",
		caveat: "'Caveat', cursive",
		patrick: "'Patrick Hand', cursive",
		'comic-neue': "'Comic Neue', cursive",
		inter: "'Inter', sans-serif",
		system: 'system-ui, -apple-system, sans-serif'
	};

	const dateFormatter = new Intl.DateTimeFormat('en-US', {
		dateStyle: 'medium'
	});
	function createInitialRepoLoadStats(): RepoLoadStats {
		return {
			source: null,
			elapsedMs: 0,
			downloadedBytes: 0,
			totalPosts: 0
		};
	}

	function createInitialRepoBlockStats(): RepoBlockStats {
		return {
			source: null,
			elapsedMs: 0,
			downloadedBytes: 0,
			totalBlocks: 0,
			error: null
		};
	}

	function createInitialScanStats(): BlockedParentReplyScanStats {
		return {
			scannedReplyCount: 0,
			candidateParentCount: 0,
			visibleParentCount: 0,
			hiddenParentCount: 0,
			checkedThreadCount: 0,
			blockedParentCount: 0,
			unresolvedParentCount: 0
		};
	}

	let fontKey = $state('patrick');
	let fontFamily = $derived(fontFamilies[fontKey] ?? fontFamilies.virgil);
	let initialHandle = $state('');
	let profile = $state<ProfileInfo | null>(null);
	let repoFeedItems = $state<any[]>([]);
	let blockedSubjectDids = $state<Set<string>>(new Set());
	let blockedProfilesByDid = $state<Map<string, ProfileInfo>>(new Map());
	let expandedBlockedDids = $state<Set<string>>(new Set());
	let allParentReplies = $state<BlockedParentReply[]>([]);
	let blockedUserQuery = $state('');
	let blockedByOwnerReplies = $derived(
		allParentReplies.filter((reply) => reply.parentBlockedByRepoOwner)
	);
	let blockedUserSearchQuery = $derived(blockedUserQuery.trim().toLowerCase());
	let blockedUserGroups = $derived(groupBlockedUserReplies(blockedByOwnerReplies));
	let filteredBlockedUserGroups = $derived(
		blockedUserSearchQuery
			? blockedUserGroups.filter((group) => blockedUserGroupMatchesSearch(group, blockedUserSearchQuery))
			: blockedUserGroups
	);
	let filteredBlockedReplyCount = $derived(
		filteredBlockedUserGroups.reduce((total, group) => total + group.replies.length, 0)
	);
	let filteredBlockedRootCount = $derived(
		filteredBlockedUserGroups.reduce((total, group) => total + group.rootGroups.length, 0)
	);
	let scanCompleted = $state(false);
	let repoLoadStats = $state<RepoLoadStats>(createInitialRepoLoadStats());
	let repoBlockStats = $state<RepoBlockStats>(createInitialRepoBlockStats());
	let scanStats = $state<BlockedParentReplyScanStats>(createInitialScanStats());
	let loading = $state(false);
	let progress = $state<DiscoverProgress>({
		phase: 'Preparing blocked reply scan…',
		current: 0,
		total: 0
	});
	let postSearchUrl = $state('');
	let postSearchMessage = $state<string | null>(null);
	let searchedPostResult = $state<RepoPostSearchResult | null>(null);
	let highlightedPostUri = $state<string | null>(null);
	let error = $state<string | null>(null);
	let loadToken = 0;
	let loadController: AbortController | null = null;

	function throwIfAborted(signal: AbortSignal) {
		if (signal.aborted) {
			throw new DOMException('Aborted', 'AbortError');
		}
	}

	function formatDate(value: string | null | undefined): string {
		if (!value) return 'Unknown date';
		const parsed = new Date(value);
		return Number.isNaN(parsed.getTime()) ? 'Unknown date' : dateFormatter.format(parsed);
	}

	function formatDuration(ms: number): string {
		if (ms <= 0) return '0s';
		if (ms < 1000) return `${Math.round(ms)}ms`;
		return `${(ms / 1000).toFixed(1)}s`;
	}

	function formatBytes(bytes: number): string {
		if (bytes <= 0) return '0 B';
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
		return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	}

	function formatSpeed(bytesPerSecond: number): string {
		if (bytesPerSecond <= 0) return '0 B/s';
		if (bytesPerSecond < 1024) return `${bytesPerSecond.toFixed(0)} B/s`;
		if (bytesPerSecond < 1024 * 1024) return `${(bytesPerSecond / 1024).toFixed(0)} KB/s`;
		return `${(bytesPerSecond / (1024 * 1024)).toFixed(1)} MB/s`;
	}

	function blockSourceLabel(source: RepoBlockStats['source']): string {
		if (source === 'pds') return 'PDS listRecords';
		if (source === 'appview') return 'public AppView listRecords';
		return 'record list';
	}

	function truncateText(text: string, maxLength = 220): string {
		const normalized = text.replace(/\s+/g, ' ').trim();
		if (normalized.length <= maxLength) return normalized;
		return `${normalized.slice(0, maxLength - 1).trimEnd()}…`;
	}

	function updateHandleQuery(handle: string | null) {
		if (!browser) return;
		const url = new URL(window.location.href);
		const nextHandle = handle?.replace(/^@/, '').trim() ?? '';
		if (nextHandle) {
			url.searchParams.set('handle', nextHandle);
		} else {
			url.searchParams.delete('handle');
		}
		window.history.replaceState({}, '', url.toString());
	}

	function postRowId(uri: string): string {
		return `hidden-reply-${encodeURIComponent(uri).replace(/%/g, '_')}`;
	}

	function findFeedItemByUri(uri: string): any | null {
		return repoFeedItems.find((item) => item?.post?.uri === uri) ?? null;
	}

	function didFromAtUri(uri: string | null | undefined): string | null {
		if (!uri) return null;
		const match = uri.match(/^at:\/\/([^/]+)\//);
		return match?.[1] ?? null;
	}

	function buildSearchResult(uri: string, item: any): RepoPostSearchResult {
		const hiddenReply = allParentReplies.find((reply) => reply.uri === uri) ?? null;
		const parentUri =
			typeof item?.post?.record?.reply?.parent?.uri === 'string'
				? item.post.record.reply.parent.uri
				: null;
		const rootUri =
			typeof item?.post?.record?.reply?.root?.uri === 'string'
				? item.post.record.reply.root.uri
				: null;
		const parentItem = parentUri ? findFeedItemByUri(parentUri) : null;
		const parentDid = didFromAtUri(parentUri);

		return {
			uri,
			cid: typeof item?.post?.cid === 'string' ? item.post.cid : '',
			text: typeof item?.post?.record?.text === 'string' ? item.post.record.text : '',
			createdAt:
				(typeof item?.post?.record?.createdAt === 'string' && item.post.record.createdAt) ||
				(typeof item?.post?.indexedAt === 'string' && item.post.indexedAt) ||
				'',
			parentUri,
			rootUri,
			parentText:
				(typeof parentItem?.post?.record?.text === 'string' && parentItem.post.record.text) ||
				hiddenReply?.parentText ||
				'',
			parentCreatedAt:
				(typeof parentItem?.post?.record?.createdAt === 'string' && parentItem.post.record.createdAt) ||
				(typeof parentItem?.post?.indexedAt === 'string' && parentItem.post.indexedAt) ||
				hiddenReply?.parentCreatedAt ||
				'',
			parentInRepo: Boolean(parentItem),
			hiddenReply,
			parentVisibility: null,
			parentBlockedByRepoOwner: parentDid ? blockedSubjectDids.has(parentDid) : false
		};
	}

	function postUrl(uri: string): string | null {
		return buildBskyPostUrl(uri, profile?.handle ?? null);
	}

	function parentUrl(reply: BlockedParentReply): string | null {
		return buildBskyPostUrl(reply.parentUri, reply.parentAuthorDid);
	}

	function uriPostUrl(uri: string): string | null {
		return buildBskyPostUrl(uri, didFromAtUri(uri));
	}

	function improSocialUrl(url: string | null | undefined): string | null {
		if (!url) return null;
		return url.replace('https://bsky.app', 'https://impro.social');
	}

	function profileUrl(did: string): string {
		const resolved = blockedProfilesByDid.get(did);
		return `https://bsky.app/profile/${resolved?.handle ?? did}`;
	}

	function blockedUserName(group: BlockedUserReplyGroup): string {
		return group.profile?.displayName || group.profile?.handle || group.did;
	}

	function blockedUserHandle(group: BlockedUserReplyGroup): string {
		return group.profile?.handle ? `@${group.profile.handle}` : group.did;
	}

	function viewerUrl(reply: BlockedParentReply): string | null {
		const url = postUrl(reply.uri);
		if (!url) return null;
		return buildViewerHref('threadviewer', {
			url,
			handle: profile?.handle ?? initialHandle
		});
	}

	function shortItemType(type: string): string {
		const suffix = type.split('#').pop() ?? type;
		return suffix.replace(/^threadItem/, '') || 'Hidden';
	}

	function parentStatusLabel(reply: BlockedParentReply): string {
		if (reply.parentBlockedByRepoOwner) return 'Blocked by repo owner';
		if (reply.parentInRepo) return 'Parent in CAR';
		if (reply.parentVisibility === 'blocked') {
			return shortItemType(reply.parentItemType) || 'Blocked';
		}
		if (reply.parentVisibility === 'unavailable') return 'Unavailable';
		if (reply.parentVisibility === 'visible') return 'Visible';
		return reply.parentItemType ? `Unknown: ${shortItemType(reply.parentItemType)}` : 'Unknown (no item type)';
	}

	function parentStatusClass(reply: BlockedParentReply): string {
		if (reply.parentBlockedByRepoOwner) return 'blocked-pill status-blocked';
		return `blocked-pill status-${reply.parentVisibility}`;
	}

	function searchResultParentStatus(result: RepoPostSearchResult): string {
		if (!result.parentUri) return 'Not a reply';
		if (result.parentBlockedByRepoOwner) return 'Parent author is in block list';
		if (result.parentVisibility) {
			const itemType = result.parentVisibility.itemType || '(no item type)';
			return `Thread parent: ${result.parentVisibility.visibility} · ${itemType}`;
		}
		if (result.hiddenReply) return `Scanned parent: ${parentStatusLabel(result.hiddenReply)}`;
		if (result.parentInRepo) return 'Parent found in same CAR';
		return 'Parent not in this CAR';
	}

	function groupRepliesByRootUri(replies: BlockedParentReply[]): BlockedRootReplyGroup[] {
		const grouped = new Map<string, BlockedParentReply[]>();
		for (const reply of replies) {
			const rootUri = reply.rootUri || reply.parentUri || reply.uri;
			const existing = grouped.get(rootUri);
			if (existing) {
				existing.push(reply);
			} else {
				grouped.set(rootUri, [reply]);
			}
		}

		return [...grouped.entries()]
			.map(([rootUri, rootReplies]) => {
				const sortedReplies = [...rootReplies].sort(
					(a, b) =>
						Date.parse(b.createdAt || '') - Date.parse(a.createdAt || '') ||
						a.uri.localeCompare(b.uri)
				);
				const parentUris = [...new Set(sortedReplies.map((reply) => reply.parentUri))];
				return {
					rootUri,
					replies: sortedReplies,
					parentUris,
					latestCreatedAt: sortedReplies[0]?.createdAt ?? ''
				};
			})
			.sort(
				(a, b) =>
					Date.parse(b.latestCreatedAt || '') - Date.parse(a.latestCreatedAt || '') ||
					b.replies.length - a.replies.length ||
					a.rootUri.localeCompare(b.rootUri)
			);
	}

	function groupBlockedUserReplies(replies: BlockedParentReply[]): BlockedUserReplyGroup[] {
		const grouped = new Map<string, BlockedParentReply[]>();
		for (const reply of replies) {
			const did = reply.parentAuthorDid ?? didFromAtUri(reply.parentUri);
			if (!did) continue;
			const existing = grouped.get(did);
			if (existing) {
				existing.push(reply);
			} else {
				grouped.set(did, [reply]);
			}
		}

		return [...grouped.entries()]
			.map(([did, groupReplies]) => {
				const sortedReplies = [...groupReplies].sort(
					(a, b) =>
						Date.parse(b.createdAt || '') - Date.parse(a.createdAt || '') ||
						a.uri.localeCompare(b.uri)
				);
				return {
					did,
					profile: blockedProfilesByDid.get(did) ?? null,
					replies: sortedReplies,
					rootGroups: groupRepliesByRootUri(sortedReplies),
					latestCreatedAt: sortedReplies[0]?.createdAt ?? ''
				};
			})
			.sort(
				(a, b) =>
					b.replies.length - a.replies.length ||
					Date.parse(b.latestCreatedAt || '') - Date.parse(a.latestCreatedAt || '') ||
					a.did.localeCompare(b.did)
			);
	}

	function blockedUserGroupMatchesSearch(group: BlockedUserReplyGroup, query: string): boolean {
		const profile = group.profile;
		const haystack = [
			group.did,
			profile?.handle ?? '',
			profile?.displayName ?? '',
			...group.replies.flatMap((reply) => [
				reply.text,
				reply.parentText,
				reply.uri,
				reply.parentUri,
				reply.rootUri,
				reply.parentItemType || '(no item type)',
				reply.parentVisibility
			])
		]
			.join(' ')
			.toLowerCase();
		return haystack.includes(query);
	}

	function isBlockedUserExpanded(did: string): boolean {
		return expandedBlockedDids.has(did);
	}

	function toggleBlockedUser(did: string) {
		const next = new Set(expandedBlockedDids);
		if (next.has(did)) {
			next.delete(did);
		} else {
			next.add(did);
		}
		expandedBlockedDids = next;
	}

	async function revealSearchedPost(uri: string, searchedProfile: ProfileInfo) {
		const item = findFeedItemByUri(uri);
		if (!item) {
			searchedPostResult = null;
			highlightedPostUri = null;
			postSearchMessage = `Downloaded @${searchedProfile.handle}'s CAR, but that post record was not found there.`;
			return;
		}

		const result = buildSearchResult(uri, item);
		searchedPostResult = result;
		if (result.parentUri) {
			postSearchMessage = `Found that post in @${searchedProfile.handle}'s CAR. Checking its reply parent through the thread API…`;
			const parentVisibility = await fetchReplyParentVisibility(result.uri, result.parentUri);
			const parentDid = parentVisibility.parentAuthorDid ?? didFromAtUri(result.parentUri);
			searchedPostResult = {
				...result,
				parentVisibility,
				parentText: parentVisibility.parentText ?? result.parentText,
				parentCreatedAt: parentVisibility.parentCreatedAt ?? result.parentCreatedAt,
				parentBlockedByRepoOwner: parentDid ? blockedSubjectDids.has(parentDid) : false
			};
		}
		const index = allParentReplies.findIndex((reply) => reply.uri === uri);
		if (index < 0) {
			highlightedPostUri = null;
			postSearchMessage = `Found that post in @${searchedProfile.handle}'s CAR. It is not currently in the scanned reply results.`;
			await tick();
			if (!browser) return;
			document.getElementById('post-search-result')?.scrollIntoView({
				behavior: 'smooth',
				block: 'center'
			});
			return;
		}

		highlightedPostUri = uri;
		const matchingReply = allParentReplies[index];
		const blockedDid = matchingReply.parentAuthorDid ?? didFromAtUri(matchingReply.parentUri);
		if (blockedDid && matchingReply.parentBlockedByRepoOwner) {
			blockedUserQuery = blockedDid;
			expandedBlockedDids = new Set([...expandedBlockedDids, blockedDid]);
		}
		postSearchMessage = matchingReply.parentBlockedByRepoOwner
			? `Found that post in @${searchedProfile.handle}'s CAR and opened the matching blocked-user group.`
			: `Found that post in @${searchedProfile.handle}'s CAR. Its parent author is not in this repo's block list.`;
		await tick();
		if (!browser) return;
		document.getElementById(postRowId(uri))?.scrollIntoView({
			behavior: 'smooth',
			block: 'center'
		});
	}

	async function loadBlocksForProfile(
		nextProfile: ProfileInfo,
		token: number,
		signal: AbortSignal
	): Promise<Set<string>> {
		try {
			progress = {
				phase: 'Loading block list…',
				current: 0,
				total: 0,
				detail: 'Reading app.bsky.graph.block with com.atproto.repo.listRecords'
			};
			const blocks = await loadRepoBlockList(nextProfile.did, {
				signal,
				onPageProgress: (pageProgress) => {
					if (token !== loadToken) return;
					progress = {
						phase: 'Loading block list…',
						current: pageProgress.records,
						total: 0,
						detail: `${pageProgress.records.toLocaleString()} block records · ${pageProgress.pages.toLocaleString()} ${pageProgress.pages === 1 ? 'page' : 'pages'} · ${formatBytes(pageProgress.downloadedBytes)} via ${blockSourceLabel(pageProgress.source)}`
					};
				}
			});
			if (token !== loadToken) return new Set();
			throwIfAborted(signal);

			blockedSubjectDids = blocks.blockedDids;
			repoBlockStats = {
				source: blocks.source,
				elapsedMs: blocks.elapsedMs,
				downloadedBytes: blocks.downloadedBytes,
				totalBlocks: blocks.totalBlocks,
				error: null
			};
			return blocks.blockedDids;
		} catch (err: any) {
			if (token !== loadToken || err?.name === 'AbortError') {
				throw err;
			}
			blockedSubjectDids = new Set();
			repoBlockStats = {
				...createInitialRepoBlockStats(),
				error: err?.message || 'Could not load app.bsky.graph.block records.'
			};
			return new Set();
		}
	}

	async function resolveBlockedUserProfiles(replies: BlockedParentReply[], token: number) {
		const dids = [
			...new Set(
				replies
					.map((reply) => reply.parentAuthorDid ?? didFromAtUri(reply.parentUri))
					.filter((did): did is string => Boolean(did))
			)
		];
		if (dids.length === 0) {
			blockedProfilesByDid = new Map();
			return;
		}

		progress = {
			phase: 'Resolving blocked users…',
			current: 0,
			total: dids.length,
			detail: `${dids.length.toLocaleString()} blocked DIDs with matching replies`
		};

		try {
			const profiles = await getProfiles(dids);
			if (token !== loadToken) return;
			blockedProfilesByDid = new Map(profiles.map((resolvedProfile) => [resolvedProfile.did, resolvedProfile]));
		} catch {
			if (token !== loadToken) return;
			blockedProfilesByDid = new Map();
		}
	}

	async function loadRepoOnlyForProfile(nextProfile: ProfileInfo) {
		const token = ++loadToken;
		loadController?.abort();
		loadController = new AbortController();
		loading = true;
		error = null;
		profile = nextProfile;
		repoFeedItems = [];
		blockedSubjectDids = new Set();
		blockedProfilesByDid = new Map();
		expandedBlockedDids = new Set();
		allParentReplies = [];
		scanCompleted = false;
		blockedUserQuery = '';
		highlightedPostUri = null;
		searchedPostResult = null;
		repoLoadStats = createInitialRepoLoadStats();
		repoBlockStats = createInitialRepoBlockStats();
		scanStats = createInitialScanStats();
		initialHandle = nextProfile.handle;
		updateHandleQuery(nextProfile.handle);

		try {
			let latestDownloadedBytes = 0;
			progress = { phase: 'Preparing repo search…', current: 0, total: 0 };
			const repo = await loadRepoFeedItems(
				nextProfile.did,
				{
					did: nextProfile.did,
					handle: nextProfile.handle,
					displayName: nextProfile.displayName,
					avatar: nextProfile.avatar
				},
				{
					signal: loadController.signal,
					onDownloadProgress: (downloadProgress) => {
						if (token !== loadToken) return;
						latestDownloadedBytes = downloadProgress.receivedBytes;
						const detailParts = [
							`${formatBytes(downloadProgress.receivedBytes)}${downloadProgress.totalBytes > 0 ? ` / ${formatBytes(downloadProgress.totalBytes)}` : ''}`
						];
						if (downloadProgress.bytesPerSecond > 0) {
							detailParts.push(formatSpeed(downloadProgress.bytesPerSecond));
						}
						progress =
							downloadProgress.totalBytes > 0
								? {
										phase: 'Downloading repository…',
										current: Math.round(
											(downloadProgress.receivedBytes / downloadProgress.totalBytes) * 100
										),
										total: 100,
										detail: detailParts.join(' · ')
									}
								: {
										phase: 'Downloading repository…',
										current: 0,
										total: 0,
										detail: detailParts.join(' · ')
									};
					},
					onParseProgress: (count) => {
						if (token !== loadToken) return;
						progress = {
							phase: 'Parsing repository posts…',
							current: 0,
							total: 0,
							detail: `${count.toLocaleString()} posts extracted from ${formatBytes(latestDownloadedBytes)}`
						};
					}
				}
			);
			if (token !== loadToken) return;
			throwIfAborted(loadController.signal);

			repoFeedItems = repo.feedItems;
			repoLoadStats = {
				source: repo.source,
				elapsedMs: repo.elapsedMs,
				downloadedBytes: repo.downloadedBytes,
				totalPosts: repo.totalPosts
			};
			await loadBlocksForProfile(nextProfile, token, loadController.signal);
		} catch (err: any) {
			if (token !== loadToken || err?.name === 'AbortError') return;
			error = err?.message || `Could not download a repo for @${nextProfile.handle}.`;
		} finally {
			if (token === loadToken) {
				loading = false;
			}
		}
	}

	async function handlePostUrlSearch() {
		const rawUrl = postSearchUrl.trim();
		postSearchMessage = null;
		highlightedPostUri = null;
		searchedPostResult = null;
		if (!rawUrl) {
			postSearchMessage = 'Paste a Bluesky post URL first.';
			return;
		}

		const parsed = parseBskyPostUrl(rawUrl);
		if (!parsed) {
			postSearchMessage = 'Use a Bluesky post URL like https://bsky.app/profile/handle/post/rkey.';
			return;
		}

		try {
			postSearchMessage = 'Resolving post author…';
			const nextProfile = await getProfile(parsed.handle);
			const targetUri = buildAtUri(nextProfile.did, parsed.rkey);
			if (!targetUri) {
				postSearchMessage = 'Could not convert that post URL into an AT URI.';
				return;
			}

			if (profile?.did !== nextProfile.did || repoFeedItems.length === 0) {
				postSearchMessage = `Downloading @${nextProfile.handle}'s CAR before searching repo records…`;
				await loadRepoOnlyForProfile(nextProfile);
			}

			await revealSearchedPost(targetUri, nextProfile);
		} catch (err: any) {
			postSearchMessage = err?.message || 'Could not search that post URL.';
		}
	}

	async function loadBlockedRepliesForProfile(
		nextProfile: ProfileInfo,
		options: { carBytes?: Uint8Array } = {}
	) {
		const token = ++loadToken;
		loadController?.abort();
		loadController = new AbortController();
		loading = true;
		error = null;
		profile = nextProfile;
		repoFeedItems = [];
		blockedSubjectDids = new Set();
		blockedProfilesByDid = new Map();
		expandedBlockedDids = new Set();
		allParentReplies = [];
		scanCompleted = false;
		blockedUserQuery = '';
		searchedPostResult = null;
		highlightedPostUri = null;
		repoLoadStats = createInitialRepoLoadStats();
		repoBlockStats = createInitialRepoBlockStats();
		scanStats = createInitialScanStats();
		initialHandle = nextProfile.handle;
		updateHandleQuery(nextProfile.handle);

		try {
			let latestDownloadedBytes = 0;
			progress = { phase: 'Preparing repo scan…', current: 0, total: 0 };
			const repo = options.carBytes
				? await parseRepoFeedItemsFromCar(
						nextProfile.did,
						{
							did: nextProfile.did,
							handle: nextProfile.handle,
							displayName: nextProfile.displayName,
							avatar: nextProfile.avatar
						},
						options.carBytes,
						{
							onParseProgress: (count) => {
								if (token !== loadToken) return;
								progress = {
									phase: 'Parsing saved repository posts…',
									current: 0,
									total: 0,
									detail: `${count.toLocaleString()} posts extracted from saved CAR`
								};
							}
						}
					)
				: await loadRepoFeedItems(
						nextProfile.did,
						{
							did: nextProfile.did,
							handle: nextProfile.handle,
							displayName: nextProfile.displayName,
							avatar: nextProfile.avatar
						},
						{
							signal: loadController.signal,
							onDownloadProgress: (downloadProgress) => {
								if (token !== loadToken) return;
								latestDownloadedBytes = downloadProgress.receivedBytes;
								const detailParts = [
									`${formatBytes(downloadProgress.receivedBytes)}${downloadProgress.totalBytes > 0 ? ` / ${formatBytes(downloadProgress.totalBytes)}` : ''}`
								];
								if (downloadProgress.bytesPerSecond > 0) {
									detailParts.push(formatSpeed(downloadProgress.bytesPerSecond));
								}
								if (downloadProgress.elapsedMs > 0) {
									detailParts.push(formatDuration(downloadProgress.elapsedMs));
								}
								progress =
									downloadProgress.totalBytes > 0
										? {
												phase: 'Downloading repository…',
												current: Math.round(
													(downloadProgress.receivedBytes / downloadProgress.totalBytes) * 100
												),
												total: 100,
												detail: detailParts.join(' · ')
											}
										: {
												phase: 'Downloading repository…',
												current: 0,
												total: 0,
												detail: detailParts.join(' · ')
											};
							},
							onParseProgress: (count) => {
								if (token !== loadToken) return;
								progress = {
									phase: 'Parsing repository posts…',
									current: 0,
									total: 0,
									detail: `${count.toLocaleString()} posts extracted from ${formatBytes(latestDownloadedBytes)}`
								};
							}
						}
					);

			if (token !== loadToken) return;
			throwIfAborted(loadController.signal);

			if (repo.totalPosts <= 0) {
				error = `No repository posts were found for @${nextProfile.handle}.`;
				return;
			}
			repoFeedItems = repo.feedItems;
			const nextBlockedSubjectDids = await loadBlocksForProfile(
				nextProfile,
				token,
				loadController.signal
			);
			if (token !== loadToken) return;
			throwIfAborted(loadController.signal);

			progress = {
				phase: 'Checking reply parents…',
				current: 0,
				total: 0
			};

			const scan = await findRepliesToBlockedParents(repo.feedItems, {
				signal: loadController.signal,
				concurrency: 4,
				blockedDids: nextBlockedSubjectDids,
				onProgress: (nextProgress) => {
					if (token !== loadToken) return;
					progress = nextProgress;
				}
			});

			if (token !== loadToken) return;
			throwIfAborted(loadController.signal);

			repoLoadStats = {
				source: repo.source,
				elapsedMs: repo.elapsedMs,
				downloadedBytes: repo.downloadedBytes,
				totalPosts: repo.totalPosts
			};
			scanStats = {
				scannedReplyCount: scan.scannedReplyCount,
				candidateParentCount: scan.candidateParentCount,
				visibleParentCount: scan.visibleParentCount,
				hiddenParentCount: scan.hiddenParentCount,
				checkedThreadCount: scan.checkedThreadCount,
				blockedParentCount: scan.blockedParentCount,
				unresolvedParentCount: scan.unresolvedParentCount
			};
			allParentReplies = scan.allReplies;
			await resolveBlockedUserProfiles(scan.allReplies.filter((reply) => reply.parentBlockedByRepoOwner), token);
			if (token !== loadToken) return;
			scanCompleted = true;
		} catch (err: any) {
			if (token !== loadToken || err?.name === 'AbortError') return;
			error = err?.message || `Could not scan blocked replies for @${nextProfile.handle}.`;
		} finally {
			if (token === loadToken) {
				loading = false;
			}
		}
	}

	async function loadBlockedRepliesFromHandle(rawHandle: string) {
		const nextHandle = rawHandle.replace(/^@/, '').trim();
		if (!nextHandle) return;

		error = null;
		try {
			progress = { phase: 'Resolving profile…', current: 0, total: 0 };
			const nextProfile = await getProfile(nextHandle);
			await loadBlockedRepliesForProfile(nextProfile);
		} catch (err: any) {
			error = err?.message || `Could not resolve @${nextHandle}.`;
			profile = null;
			repoFeedItems = [];
			blockedSubjectDids = new Set();
			blockedProfilesByDid = new Map();
			expandedBlockedDids = new Set();
			allParentReplies = [];
			scanCompleted = false;
			blockedUserQuery = '';
			searchedPostResult = null;
			repoLoadStats = createInitialRepoLoadStats();
			repoBlockStats = createInitialRepoBlockStats();
			scanStats = createInitialScanStats();
			loading = false;
			updateHandleQuery(nextHandle);
		}
	}

	function handleFontChange(key: string) {
		fontKey = key;
		try {
			localStorage.setItem('preferred-font', key);
		} catch {}
	}

	function handleProfileSelected(nextProfile: ProfileInfo) {
		void loadBlockedRepliesForProfile(nextProfile);
	}

	async function loadSavedRepoCar(_entry: SavedRepoCarEntry, carBytes: Uint8Array) {
		if (!profile) {
			error = 'Choose a profile before loading a saved CAR.';
			return;
		}
		await loadBlockedRepliesForProfile(profile, { carBytes });
	}

	onMount(() => {
		try {
			const saved = localStorage.getItem('preferred-font');
			if (saved && saved in fontFamilies) {
				fontKey = saved;
			}
		} catch {}

		const params = new URLSearchParams(window.location.search);
		const handle = params.get('handle')?.trim() ?? '';
		if (handle) {
			initialHandle = handle;
			void loadBlockedRepliesFromHandle(handle);
		}
	});
</script>

<svelte:head>
	<title>Blocked Reply Parents</title>
</svelte:head>

<main style="font-family: {fontFamily}">
	<header class="page-header">
		<RouteNav current="blocked" align="center" handle={profile?.handle ?? initialHandle ?? null} />
		<h1>Blocked Reply Parents</h1>
		<p class="subtitle">
			Find reply posts whose direct parent author DID appears in the repo owner&apos;s
			app.bsky.graph.block records, grouped by blocked user.
		</p>
		<FontPicker value={fontKey} onchange={handleFontChange} />
	</header>

	<section class="lookup-panel wobbly-border-light">
		<SearchBar
			onsearch={loadBlockedRepliesFromHandle}
			onprofile={handleProfileSelected}
			disabled={loading}
			{initialHandle}
			placeholder="Search any public Bluesky user..."
			buttonLabel="Scan Blocked Parents"
		/>
		<form
			class="post-search-form"
			onsubmit={(event) => {
				event.preventDefault();
				void handlePostUrlSearch();
			}}
		>
			<input
				type="url"
				bind:value={postSearchUrl}
				placeholder="Paste a Bluesky post URL to find that record in its author's CAR"
				disabled={loading}
			/>
			<button type="submit" disabled={loading}>Download CAR & Search</button>
		</form>
		{#if postSearchMessage}
			<p class="post-search-message">{postSearchMessage}</p>
		{/if}
		<p class="lookup-note">
			Account scan reads app.bsky.feed.post and app.bsky.graph.block from the repo, then groups
			matching reply parents by blocked DID. Post URL search still checks one repo record directly.
		</p>
	</section>

	{#if error}
		<div class="error-wrap">
			<ErrorBanner message={error} />
		</div>
	{/if}

	{#if loading}
		<div class="loading-wrap">
			<LoadingSpinner {progress} />
		</div>
	{/if}

	{#if profile && !loading && repoLoadStats.totalPosts > 0}
		<section class="hero-card wobbly-border-light">
			<div class="hero-profile">
				{#if profile.avatar}
					<img class="hero-avatar" src={profile.avatar} alt="" />
				{:else}
					<div class="hero-avatar placeholder"></div>
				{/if}
				<div class="hero-copy">
					<p class="eyebrow">Blocked reply scan for</p>
					<h2>{profile.displayName || profile.handle}</h2>
					<p class="hero-handle">@{profile.handle}</p>
				</div>
			</div>
			<div class="hero-stats">
				<div class="stat-chip">
					<span class="stat-label">Repo posts</span>
					<strong>{repoLoadStats.totalPosts.toLocaleString()}</strong>
				</div>
				{#if scanCompleted}
					<div class="stat-chip">
						<span class="stat-label">Block records</span>
						<strong>{repoBlockStats.totalBlocks.toLocaleString()}</strong>
					</div>
					<div class="stat-chip">
						<span class="stat-label">Reply posts</span>
						<strong>{allParentReplies.length.toLocaleString()}</strong>
					</div>
					<div class="stat-chip">
						<span class="stat-label">Replies to blocked users</span>
						<strong>{blockedByOwnerReplies.length.toLocaleString()}</strong>
					</div>
					<div class="stat-chip">
						<span class="stat-label">Blocked users matched</span>
						<strong>{blockedUserGroups.length.toLocaleString()}</strong>
					</div>
					<div class="stat-chip">
						<span class="stat-label">External parents</span>
						<strong>{scanStats.candidateParentCount.toLocaleString()}</strong>
					</div>
				{/if}
			</div>
			<div class="hero-meta">
				{#if repoLoadStats.source}
					<span>
						Loaded via {repoLoadStats.source === 'pds' ? 'PDS' : 'relay'} in {formatDuration(repoLoadStats.elapsedMs)}
						from {formatBytes(repoLoadStats.downloadedBytes)}
					</span>
				{/if}
				{#if scanCompleted}
					<span>{scanStats.checkedThreadCount.toLocaleString()} reply parents checked via thread API</span>
					{#if repoBlockStats.source}
						<span>
							Loaded {repoBlockStats.totalBlocks.toLocaleString()} block records via {blockSourceLabel(repoBlockStats.source)}
						</span>
					{:else if repoBlockStats.error}
						<span class="partial-pill">Block list unavailable: {repoBlockStats.error}</span>
					{/if}
					{#if scanStats.unresolvedParentCount > 0}
						<span class="partial-pill">{scanStats.unresolvedParentCount.toLocaleString()} unknown parents</span>
					{/if}
				{:else}
					<span>CAR parsed for direct post lookup</span>
					{#if repoBlockStats.source}
						<span>
							Loaded {repoBlockStats.totalBlocks.toLocaleString()} block records via {blockSourceLabel(repoBlockStats.source)}
						</span>
					{:else if repoBlockStats.error}
						<span class="partial-pill">Block list unavailable: {repoBlockStats.error}</span>
					{/if}
				{/if}
			</div>
		</section>

		{#if searchedPostResult}
			{@const searchedPostUrl = postUrl(searchedPostResult.uri)}
			{@const searchedImproUrl = improSocialUrl(searchedPostUrl)}
			<section id="post-search-result" class="search-result-panel wobbly-border-light">
				<div class="panel-heading">
					<h3>Post Found In CAR</h3>
					<p>{searchResultParentStatus(searchedPostResult)}</p>
				</div>
				<div class="reply-card highlighted">
					<p class="reply-text">{truncateText(searchedPostResult.text || '(No text)')}</p>
					<div class="reply-meta">
						<span>{formatDate(searchedPostResult.createdAt)}</span>
						<span title={searchedPostResult.uri}>{searchedPostResult.uri}</span>
					</div>
					{#if searchedPostResult.parentUri}
						<div class="parent-row">
							<span class="blocked-pill status-unknown">Parent</span>
							<span class="parent-uri" title={searchedPostResult.parentUri}>
								{searchedPostResult.parentUri}
							</span>
						</div>
					{/if}
					{#if searchedPostResult.parentText}
						<div class="parent-text-box">
							<span>Parent text</span>
							<p>{truncateText(searchedPostResult.parentText, 360)}</p>
							{#if searchedPostResult.parentCreatedAt}
								<small>{formatDate(searchedPostResult.parentCreatedAt)}</small>
							{/if}
						</div>
					{/if}
					{#if searchedPostResult.parentVisibility}
						<div class="parent-row">
							<span class={`blocked-pill status-${searchedPostResult.parentVisibility.visibility}`}>
								Thread API
							</span>
							<span class="parent-uri">
								{searchedPostResult.parentVisibility.visibility} · {searchedPostResult.parentVisibility.itemType || '(no item type)'}
							</span>
						</div>
					{/if}
					{#if searchedPostResult.parentBlockedByRepoOwner}
						<div class="parent-row">
							<span class="blocked-pill status-blocked">Block list</span>
							<span class="parent-uri">Parent author DID is in this repo&apos;s app.bsky.graph.block records</span>
						</div>
					{/if}
					{#if searchedPostResult.rootUri && searchedPostResult.rootUri !== searchedPostResult.uri}
						<div class="parent-row">
							<span class="blocked-pill status-unavailable">Root</span>
							<span class="parent-uri" title={searchedPostResult.rootUri}>
								{searchedPostResult.rootUri}
							</span>
						</div>
					{/if}
					{#if searchedPostUrl}
						<a href={searchedPostUrl} class="post-url" target="_blank" rel="noreferrer">
							{searchedPostUrl}
						</a>
					{/if}
					{#if searchedImproUrl}
						<div class="reply-links">
							<a href={searchedImproUrl} class="text-link" target="_blank" rel="noreferrer">
								Open on impro.social
							</a>
						</div>
					{/if}
				</div>
			</section>
		{/if}

		{#if scanCompleted}
			<section class="results-panel wobbly-border-light">
				<div class="panel-heading blocked-panel-heading">
					<div>
						<h3>Blocked Users With Reply Parents</h3>
						<p>
							Showing {filteredBlockedUserGroups.length.toLocaleString()} of {blockedUserGroups.length.toLocaleString()}
							blocked {blockedUserGroups.length === 1 ? 'user' : 'users'} and {filteredBlockedReplyCount.toLocaleString()}
							of {blockedByOwnerReplies.length.toLocaleString()} matching {blockedByOwnerReplies.length === 1 ? 'reply' : 'replies'}
							across {filteredBlockedRootCount.toLocaleString()} root {filteredBlockedRootCount === 1 ? 'thread' : 'threads'}.
						</p>
					</div>
					<div class="reply-info-search blocked-user-search">
						<input
							type="search"
							bind:value={blockedUserQuery}
							placeholder="Search blocked handle, DID, reply text, parent text, URI..."
						/>
						{#if blockedUserQuery}
							<button type="button" onclick={() => (blockedUserQuery = '')}>Clear</button>
						{/if}
					</div>
				</div>

				{#if blockedUserGroups.length === 0}
					<p class="empty-state">No reply parents were authored by a DID in this repo&apos;s block list.</p>
				{:else if filteredBlockedUserGroups.length === 0}
					<p class="empty-state">No blocked users matched that search.</p>
				{:else}
					<ul class="blocked-user-list">
						{#each filteredBlockedUserGroups as group (group.did)}
							{@const expanded = isBlockedUserExpanded(group.did)}
							<li class="blocked-user-card">
								<div class="blocked-user-header">
									<button
										type="button"
										class="blocked-user-toggle"
										aria-expanded={expanded}
										onclick={() => toggleBlockedUser(group.did)}
									>
										<div class="blocked-user-main">
											{#if group.profile?.avatar}
												<img class="blocked-user-avatar" src={group.profile.avatar} alt="" />
											{:else}
												<div class="blocked-user-avatar placeholder">
													{blockedUserName(group).slice(0, 1).toUpperCase()}
												</div>
											{/if}
											<div class="blocked-user-copy">
												<strong>{blockedUserName(group)}</strong>
												<span>{blockedUserHandle(group)}</span>
												<small title={group.did}>{group.did}</small>
											</div>
										</div>
										<div class="blocked-user-meta">
											<span>{group.replies.length.toLocaleString()} {group.replies.length === 1 ? 'reply' : 'replies'}</span>
											<span>{group.rootGroups.length.toLocaleString()} root {group.rootGroups.length === 1 ? 'thread' : 'threads'}</span>
											<span>Latest {formatDate(group.latestCreatedAt)}</span>
											<span class="expand-label">{expanded ? 'Hide replies' : 'Show replies'}</span>
										</div>
									</button>
									<a href={profileUrl(group.did)} class="text-link blocked-user-profile-link" target="_blank" rel="noreferrer">
										Open profile
									</a>
								</div>

								{#if expanded}
									<ul class="root-group-list">
										{#each group.rootGroups as rootGroup, rootIndex (rootGroup.rootUri)}
											{@const firstReply = rootGroup.replies[0]}
											{@const rootPostUrl = uriPostUrl(rootGroup.rootUri)}
											{@const rootImproUrl = improSocialUrl(rootPostUrl)}
											{@const rootViewerUrl = firstReply ? viewerUrl(firstReply) : null}
											<li class="root-group-card">
												<div class="root-group-header">
													<div class="rank-index">{rootIndex + 1}</div>
													<div class="root-group-copy">
														<strong>Root thread</strong>
														<span title={rootGroup.rootUri}>{rootGroup.rootUri}</span>
														<div class="reply-meta">
															<span>{rootGroup.replies.length.toLocaleString()} matching {rootGroup.replies.length === 1 ? 'reply' : 'replies'}</span>
															<span>{rootGroup.parentUris.length.toLocaleString()} direct {rootGroup.parentUris.length === 1 ? 'parent' : 'parents'}</span>
															<span>Latest {formatDate(rootGroup.latestCreatedAt)}</span>
														</div>
													</div>
												</div>

												<div class="reply-links root-group-links">
													{#if rootViewerUrl}
														<a href={rootViewerUrl} class="text-link">Open thread</a>
													{/if}
													{#if rootPostUrl}
														<a href={rootPostUrl} class="text-link" target="_blank" rel="noreferrer">Open root on Bluesky</a>
													{/if}
													{#if rootImproUrl}
														<a href={rootImproUrl} class="text-link" target="_blank" rel="noreferrer">Open root on impro.social</a>
													{/if}
												</div>

												<ul class="reply-list nested-reply-list root-reply-list">
													{#each rootGroup.replies as reply, replyIndex (reply.uri)}
														{@const replyPostUrl = postUrl(reply.uri)}
														{@const replyViewerUrl = viewerUrl(reply)}
														{@const replyParentUrl = parentUrl(reply)}
														{@const replyImproUrl = improSocialUrl(replyPostUrl)}
														{@const parentImproUrl = improSocialUrl(replyParentUrl)}
														<li
															id={postRowId(reply.uri)}
															class="reply-card"
															class:highlighted={highlightedPostUri === reply.uri}
														>
															<div class="reply-card-top">
																<div class="rank-index">{replyIndex + 1}</div>
																<div class="reply-copy">
																	<p class="reply-text">{truncateText(reply.text || '(No text)')}</p>
																	<div class="reply-meta">
																		<span>{formatDate(reply.createdAt)}</span>
																	</div>
																</div>
															</div>
															<div class="parent-row">
																<span class={parentStatusClass(reply)}>{parentStatusLabel(reply)}</span>
																<span class="parent-uri" title={reply.parentUri}>
																	Parent {blockedUserHandle(group)}
																</span>
															</div>
															{#if reply.parentText}
																<div class="parent-text-box">
																	<span>Parent text</span>
																	<p>{truncateText(reply.parentText, 360)}</p>
																	{#if reply.parentCreatedAt}
																		<small>{formatDate(reply.parentCreatedAt)}</small>
																	{/if}
																</div>
															{/if}
															<div class="parent-row">
																<span class="blocked-pill status-unavailable">Reply</span>
																<span class="parent-uri" title={reply.uri}>{reply.uri}</span>
															</div>
															<div class="parent-row">
																<span class="blocked-pill status-unavailable">Info</span>
																<span class="parent-uri">
																	{reply.parentVisibility} · {reply.parentItemType || '(no item type)'}
																	{reply.parentInRepo ? ' · parent in CAR' : ''}
																	{reply.parentBlockedByRepoOwner ? ' · parent author in block list' : ''}
																</span>
															</div>
															{#if replyPostUrl}
																<a href={replyPostUrl} class="post-url" target="_blank" rel="noreferrer">
																	{replyPostUrl}
																</a>
															{/if}
															<div class="reply-links">
																{#if replyViewerUrl}
																	<a href={replyViewerUrl} class="text-link">Open thread</a>
																{/if}
																{#if replyPostUrl}
																	<a href={replyPostUrl} class="text-link" target="_blank" rel="noreferrer">Open reply on Bluesky</a>
																{/if}
																{#if replyImproUrl}
																	<a href={replyImproUrl} class="text-link" target="_blank" rel="noreferrer">Open reply on impro.social</a>
																{/if}
																{#if replyParentUrl}
																	<a href={replyParentUrl} class="text-link" target="_blank" rel="noreferrer">Open parent URI</a>
																{/if}
																{#if parentImproUrl}
																	<a href={parentImproUrl} class="text-link" target="_blank" rel="noreferrer">Open parent on impro.social</a>
																{/if}
															</div>
														</li>
													{/each}
												</ul>
											</li>
										{/each}
									</ul>
								{/if}
							</li>
						{/each}
					</ul>
				{/if}
			</section>
		{/if}
	{/if}
</main>

<style>
	main {
		max-width: 1100px;
		margin: 0 auto;
		padding: 32px 20px 56px;
	}

	.page-header {
		text-align: center;
		margin-bottom: 24px;
	}

	h1 {
		margin: 10px 0 6px;
		font-size: clamp(2.1rem, 3vw, 3rem);
		color: var(--text-ink);
	}

	.subtitle {
		max-width: 760px;
		margin: 0 auto;
		color: var(--muted);
		font-size: 1rem;
		line-height: 1.5;
	}

	.lookup-panel,
	.hero-card,
	.search-result-panel,
	.results-panel {
		background: rgba(255, 252, 246, 0.92);
		box-shadow: 0 18px 42px rgba(32, 33, 36, 0.08);
	}

	.lookup-panel {
		padding: 18px;
		margin-bottom: 22px;
	}

	.lookup-note {
		margin: 12px auto 0;
		max-width: 720px;
		color: var(--muted);
		text-align: center;
		line-height: 1.45;
	}

	.post-search-form {
		display: flex;
		gap: 10px;
		max-width: 820px;
		margin: 14px auto 0;
	}

	.post-search-form input {
		flex: 1;
		min-width: 0;
		border: 1px solid rgba(61, 64, 91, 0.16);
		border-radius: 14px;
		padding: 11px 13px;
		background: rgba(255, 255, 255, 0.82);
		color: var(--text-ink);
		font: inherit;
		font-size: 0.95rem;
	}

	.post-search-form input:focus {
		outline: 2px solid color-mix(in srgb, var(--accent) 28%, transparent);
		border-color: color-mix(in srgb, var(--accent) 48%, rgba(61, 64, 91, 0.16));
	}

	.post-search-form button {
		border: 1px solid rgba(61, 64, 91, 0.16);
		border-radius: 14px;
		padding: 11px 15px;
		background: color-mix(in srgb, var(--accent) 16%, white);
		color: var(--text-ink);
		font: inherit;
		font-weight: 700;
		cursor: pointer;
	}

	.post-search-form button:disabled,
	.post-search-form input:disabled {
		cursor: wait;
		opacity: 0.62;
	}

	.post-search-message {
		max-width: 820px;
		margin: 8px auto 0;
		color: var(--muted);
		font-size: 0.88rem;
		line-height: 1.4;
	}

	.error-wrap,
	.loading-wrap {
		max-width: 720px;
		margin: 0 auto 22px;
	}

	.hero-card {
		padding: 22px;
		margin-bottom: 22px;
	}

	.hero-profile {
		display: flex;
		align-items: center;
		gap: 18px;
		margin-bottom: 18px;
	}

	.hero-avatar {
		width: 78px;
		height: 78px;
		border-radius: 24px;
		object-fit: cover;
		background: rgba(61, 64, 91, 0.08);
	}

	.hero-avatar.placeholder {
		background: linear-gradient(135deg, rgba(61, 64, 91, 0.12), rgba(224, 122, 95, 0.16));
	}

	.eyebrow {
		margin: 0 0 4px;
		font-size: 0.78rem;
		font-weight: 700;
		letter-spacing: 0.12em;
		text-transform: uppercase;
		color: var(--muted);
	}

	h2 {
		margin: 0;
		font-size: clamp(1.5rem, 2vw, 2.1rem);
		color: var(--text-ink);
	}

	.hero-handle {
		margin: 4px 0 0;
		color: var(--muted);
		font-size: 1rem;
	}

	.hero-stats {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
		gap: 12px;
		margin-bottom: 16px;
	}

	.stat-chip {
		display: flex;
		flex-direction: column;
		gap: 6px;
		padding: 14px 16px;
		border-radius: 14px;
		background: rgba(255, 255, 255, 0.72);
		border: 1px solid rgba(61, 64, 91, 0.1);
	}

	.stat-label {
		color: var(--muted);
		font-size: 0.82rem;
	}

	.stat-chip strong {
		font-size: 1.25rem;
		color: var(--text-ink);
	}

	.hero-meta {
		display: flex;
		flex-wrap: wrap;
		gap: 10px 14px;
		color: var(--muted);
		font-size: 0.88rem;
	}

	.partial-pill,
	.blocked-pill {
		display: inline-flex;
		align-items: center;
		padding: 4px 10px;
		border-radius: 999px;
		background: rgba(176, 58, 72, 0.12);
		color: #8b2635;
		font-weight: 700;
	}

	.status-unavailable {
		background: rgba(61, 64, 91, 0.1);
		color: color-mix(in srgb, var(--text-ink) 78%, var(--muted));
	}

	.status-unknown {
		background: rgba(224, 122, 95, 0.12);
		color: color-mix(in srgb, var(--accent) 72%, black);
	}

	.status-visible {
		background: rgba(45, 125, 95, 0.12);
		color: #2b6b52;
	}

	.results-panel {
		padding: 20px;
	}

	.search-result-panel {
		padding: 20px;
		margin-bottom: 22px;
	}

	.panel-heading {
		margin-bottom: 14px;
	}

	.blocked-panel-heading {
		display: grid;
		grid-template-columns: minmax(0, 1fr) minmax(280px, 380px);
		gap: 14px;
		align-items: start;
	}

	.reply-info-search {
		display: flex;
		gap: 8px;
		margin-top: 12px;
	}

	.blocked-user-search {
		margin-top: 0;
	}

	.reply-info-search input {
		flex: 1;
		min-width: 0;
		border: 1px solid rgba(61, 64, 91, 0.14);
		border-radius: 12px;
		padding: 9px 11px;
		background: rgba(255, 255, 255, 0.74);
		color: var(--text-ink);
		font: inherit;
		font-size: 0.9rem;
	}

	.reply-info-search input:focus {
		outline: 2px solid color-mix(in srgb, var(--accent) 24%, transparent);
		border-color: color-mix(in srgb, var(--accent) 42%, rgba(61, 64, 91, 0.14));
	}

	.reply-info-search button {
		border: 1px solid rgba(61, 64, 91, 0.12);
		border-radius: 12px;
		padding: 9px 11px;
		background: rgba(255, 255, 255, 0.72);
		color: var(--text-ink);
		font: inherit;
		font-size: 0.86rem;
		font-weight: 700;
		cursor: pointer;
	}

	.panel-heading h3 {
		margin: 0 0 4px;
		font-size: 1.18rem;
		color: var(--text-ink);
	}

	.panel-heading p,
	.empty-state {
		margin: 0;
		color: var(--muted);
		line-height: 1.45;
	}

	.blocked-user-list {
		list-style: none;
		padding: 0;
		margin: 0;
		display: grid;
		gap: 12px;
	}

	.blocked-user-card {
		display: grid;
		gap: 12px;
		padding: 14px;
		border-radius: 14px;
		background: rgba(255, 255, 255, 0.72);
		border: 1px solid rgba(61, 64, 91, 0.08);
	}

	.blocked-user-header {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		gap: 12px;
		align-items: center;
	}

	.blocked-user-toggle {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 14px;
		min-width: 0;
		width: 100%;
		border: 0;
		padding: 0;
		background: transparent;
		color: inherit;
		font: inherit;
		text-align: left;
		cursor: pointer;
	}

	.blocked-user-main {
		display: flex;
		align-items: center;
		gap: 12px;
		min-width: 0;
	}

	.blocked-user-avatar {
		width: 48px;
		height: 48px;
		border-radius: 14px;
		object-fit: cover;
		background: rgba(61, 64, 91, 0.08);
		flex-shrink: 0;
	}

	.blocked-user-avatar.placeholder {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		background: color-mix(in srgb, var(--accent) 16%, white);
		color: var(--text-ink);
		font-weight: 800;
	}

	.blocked-user-copy {
		display: grid;
		gap: 2px;
		min-width: 0;
	}

	.blocked-user-copy strong,
	.blocked-user-copy span,
	.blocked-user-copy small {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.blocked-user-copy strong {
		color: var(--text-ink);
		font-size: 1rem;
	}

	.blocked-user-copy span,
	.blocked-user-copy small,
	.blocked-user-meta {
		color: var(--muted);
		font-size: 0.84rem;
	}

	.blocked-user-meta {
		display: flex;
		flex-wrap: wrap;
		justify-content: flex-end;
		gap: 8px 10px;
		text-align: right;
	}

	.expand-label {
		color: var(--text-ink);
		font-weight: 800;
	}

	.blocked-user-profile-link {
		white-space: nowrap;
		justify-self: end;
	}

	.root-group-list {
		list-style: none;
		padding: 0;
		margin: 0;
		display: grid;
		gap: 12px;
	}

	.root-group-card {
		display: grid;
		gap: 12px;
		padding: 12px;
		border-radius: 12px;
		background: rgba(61, 64, 91, 0.045);
		border: 1px solid rgba(61, 64, 91, 0.08);
	}

	.root-group-header {
		display: flex;
		gap: 12px;
		align-items: flex-start;
		min-width: 0;
	}

	.root-group-copy {
		display: grid;
		gap: 4px;
		min-width: 0;
	}

	.root-group-copy strong {
		color: var(--text-ink);
		font-size: 0.96rem;
	}

	.root-group-copy > span {
		color: var(--muted);
		font-size: 0.84rem;
		overflow-wrap: anywhere;
	}

	.root-group-links {
		padding-left: 44px;
	}

	.reply-list {
		list-style: none;
		padding: 0;
		margin: 0;
		display: grid;
		gap: 12px;
		max-height: 44rem;
		overflow-y: auto;
		padding-right: 4px;
	}

	.nested-reply-list {
		max-height: none;
		overflow-y: visible;
		padding-right: 0;
	}

	.root-reply-list {
		padding-left: 44px;
	}

	.reply-card {
		display: grid;
		gap: 12px;
		padding: 14px;
		border-radius: 14px;
		background: rgba(255, 255, 255, 0.72);
		border: 1px solid rgba(61, 64, 91, 0.08);
	}

	.reply-card.highlighted {
		border-color: color-mix(in srgb, var(--accent) 58%, rgba(61, 64, 91, 0.12));
		box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 18%, transparent);
	}

	.reply-card-top {
		display: flex;
		gap: 12px;
		align-items: flex-start;
		min-width: 0;
	}

	.rank-index {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 32px;
		height: 32px;
		border-radius: 999px;
		background: color-mix(in srgb, var(--accent) 16%, white);
		color: var(--text-ink);
		font-size: 0.9rem;
		font-weight: 700;
		flex-shrink: 0;
	}

	.reply-copy {
		min-width: 0;
	}

	.reply-text {
		margin: 0;
		color: var(--text-ink);
		font-size: 0.98rem;
		line-height: 1.5;
		overflow-wrap: anywhere;
	}

	.reply-meta,
	.reply-links,
	.parent-row {
		display: flex;
		flex-wrap: wrap;
		gap: 8px 12px;
		align-items: center;
	}

	.reply-meta {
		margin-top: 8px;
		color: var(--muted);
		font-size: 0.84rem;
	}

	.parent-row {
		color: var(--muted);
		font-size: 0.86rem;
	}

	.parent-uri {
		min-width: 0;
		overflow-wrap: anywhere;
	}

	.parent-text-box {
		display: grid;
		gap: 5px;
		padding: 10px 12px;
		border-radius: 12px;
		background: rgba(61, 64, 91, 0.05);
		border: 1px solid rgba(61, 64, 91, 0.08);
	}

	.parent-text-box span {
		color: var(--muted);
		font-size: 0.78rem;
		font-weight: 700;
		text-transform: uppercase;
	}

	.parent-text-box p {
		margin: 0;
		color: var(--text-ink);
		font-size: 0.92rem;
		line-height: 1.45;
		overflow-wrap: anywhere;
	}

	.parent-text-box small {
		color: var(--muted);
		font-size: 0.8rem;
	}

	.post-url {
		display: block;
		width: fit-content;
		max-width: 100%;
		color: var(--muted);
		font-size: 0.84rem;
		text-decoration: none;
		overflow-wrap: anywhere;
	}

	.post-url:hover {
		color: var(--accent);
	}

	.text-link {
		color: var(--text-ink);
		font-size: 0.9rem;
		font-weight: 700;
		text-decoration: none;
	}

	.text-link:hover {
		color: var(--accent);
	}

	@media (max-width: 640px) {
		main {
			padding: 24px 14px 42px;
		}

		.lookup-panel,
		.hero-card,
		.search-result-panel,
		.results-panel {
			padding: 16px;
		}

		.hero-profile {
			align-items: flex-start;
		}

		.hero-avatar {
			width: 64px;
			height: 64px;
			border-radius: 18px;
		}

		.reply-card {
			padding: 12px;
		}

		.post-search-form {
			flex-direction: column;
		}

		.blocked-panel-heading,
		.blocked-user-header {
			grid-template-columns: 1fr;
		}

		.blocked-user-toggle {
			align-items: flex-start;
			flex-direction: column;
		}

		.blocked-user-meta {
			justify-content: flex-start;
			text-align: left;
		}

		.blocked-user-profile-link {
			justify-self: start;
		}

		.root-group-links,
		.root-reply-list {
			padding-left: 0;
		}

		.reply-info-search {
			flex-direction: column;
		}
	}
</style>
