<script lang="ts">
	import { onDestroy, onMount, tick } from 'svelte';
	import { browser } from '$app/environment';
	import type { Agent, AppBskyFeedDefs } from '@atproto/api';
	import type { BrowserOAuthClient } from '@atproto/oauth-client-browser';
	import '../../app.css';
	import FontPicker from '$lib/components/FontPicker.svelte';
	import PostEmbedPreview from '$lib/components/PostEmbedPreview.svelte';
	import RouteNav from '$lib/components/RouteNav.svelte';
	import type { ProfileInfo } from '$lib/api/bluesky';
	import {
		FOLLOWING_FEED_ID,
		connectBlueskyWithRedirect,
		disconnectBluesky,
		fetchPersonalFeedPosts,
		initAuthenticatedBlueskyClient,
		resolvePersonalFeeds,
		type AuthenticatedBlueskyContext,
		type PersonalFeedOption
	} from '$lib/api/blueskyAuth';
	import type { ThreadPost } from '$lib/types';
	import { rememberRecentThread } from '$lib/utils/recentThreads';
	import { parsePostViewEmbed } from '$lib/utils/threadWalker';
	import {
		buildBskyPostUrl,
		buildViewerHref,
		extractBskyPostUrlsFromFacets
	} from '$lib/utils/viewerLinks';

	type FrontpageEmbedPost = Pick<ThreadPost, 'uri' | 'text' | 'linkedUrls' | 'embed'>;

	type FrontpagePost = {
		id: string;
		authorDid: string;
		authorHandle: string;
		authorDisplayName?: string;
		authorAvatar?: string;
		text: string;
		createdAt: Date;
		createdAtLabel: string;
		likeCount: number;
		repostCount: number;
		replyCount: number;
		quoteCount: number;
		permalink: string | null;
		treeHref: string;
		sourceLabel?: string;
		externalTitle?: string;
		externalDomain?: string;
		embedPost: FrontpageEmbedPost;
	};

	type FrontpageAuthorProfile = ProfileInfo & {
		description?: string;
		followersCount?: number;
		followsCount?: number;
	};

	type TreeviewerSection = {
		id: string;
		href: string;
		sectionHref: string;
		returnPostId?: string;
		title: string;
		author: string;
		textPanelMode: TreeviewerTextPanelMode;
		treeCollapsed: boolean;
		chatCollapsed: boolean;
		uiCollapsed: boolean;
		allReplies: boolean;
		createdAt: number;
	};

	type TreeviewerTextPanelMode = 'chat' | 'forum';

	type TreeviewerSectionSettings = Pick<
		TreeviewerSection,
		'textPanelMode' | 'treeCollapsed' | 'chatCollapsed' | 'uiCollapsed' | 'allReplies'
	>;

	type FrontpageSettings = {
		treePanePercent?: number;
		feedPaneCollapsed?: boolean;
		treeviewerPaneCollapsed?: boolean;
		treeviewerDefaults?: Partial<TreeviewerSectionSettings>;
	};

	const FEED_STORAGE_KEY_PREFIX = 'frontpage-feed-selection';
	const FRONTPAGE_SETTINGS_STORAGE_KEY = 'frontpage-settings-v1';
	const TREEVIEWER_PANEL_STATE_MESSAGE = 'atprotocodex:treeviewer:panel-state';
	const PAGE_SIZE = 100;
	const PHONE_VIEWPORT_QUERY = '(max-width: 720px)';
	const DEFAULT_TREEVIEWER_SECTION_SETTINGS: TreeviewerSectionSettings = {
		textPanelMode: 'forum',
		treeCollapsed: false,
		chatCollapsed: false,
		uiCollapsed: false,
		allReplies: false
	};
	const fontFamilies: Record<string, string> = {
		virgil: "'Virgil', cursive",
		caveat: "'Caveat', cursive",
		patrick: "'Patrick Hand', cursive",
		'comic-neue': "'Comic Neue', cursive",
		inter: "'Inter', sans-serif",
		system: "system-ui, -apple-system, sans-serif"
	};

	let loading = $state(false);
	let loadingMore = $state(false);
	let connecting = $state(false);
	let restoringSession = $state(true);
	let loadingFeeds = $state(false);
	let error: string | null = $state(null);
	let profile: ProfileInfo | null = $state(null);
	let posts: FrontpagePost[] = $state([]);
	let authorProfile: FrontpageAuthorProfile | null = $state(null);
	let authorPosts: FrontpagePost[] = $state([]);
	let authorCursor: string | undefined = $state(undefined);
	let authorLoading = $state(false);
	let authorLoadingMore = $state(false);
	let authorError: string | null = $state(null);
	let authorTargetLabel: string | null = $state(null);
	let authorReturnPostId: string | null = $state(null);
	let feedOptions: PersonalFeedOption[] = $state([]);
	let selectedFeedId = $state(FOLLOWING_FEED_ID);
	let switchingFeedId: string | null = $state(null);
	let cursor: string | undefined = $state(undefined);
	let sessionSub = $state<string | null>(null);
	let authClient: BrowserOAuthClient | null = null;
	let authAgent: Agent | null = null;
	let feedRequestToken = 0;
	let authorRequestToken = 0;
	let fontKey = $state('system');
	let treeviewerSections = $state<TreeviewerSection[]>([]);
	let workspaceElement: HTMLDivElement | null = $state(null);
	let treeviewerSectionsElement: HTMLElement | null = $state(null);
	let splitDragging = $state(false);
	let treePanePercent = $state(48);
	let feedPaneCollapsed = $state(false);
	let treeviewerPaneCollapsed = $state(false);
	let mobileThreadFocused = $state(false);
	let returnedPostHighlightId: string | null = $state(null);
	let treeviewerDefaultSettings = $state<TreeviewerSectionSettings>({
		...DEFAULT_TREEVIEWER_SECTION_SETTINGS
	});
	let frontpageSettingsRestored = $state(false);
	let treeviewerSectionCounter = 0;
	let returnHighlightTimeout: number | null = null;
	const treeviewerFrames = new Map<string, HTMLIFrameElement>();
	let fontFamily = $derived(fontFamilies[fontKey] ?? fontFamilies.system);

	let selectedFeed = $derived(feedOptions.find((option) => option.id === selectedFeedId) ?? null);
	let hasTreeviewerSections = $derived(treeviewerSections.length > 0);
	let authorViewActive = $derived(authorLoading || Boolean(authorProfile));
	let activePosts = $derived(authorViewActive ? authorPosts : posts);
	let activeLoading = $derived(authorViewActive ? authorLoading : loading);
	let activeLoadingMore = $derived(authorViewActive ? authorLoadingMore : loadingMore);
	let activeCursor = $derived(authorViewActive ? authorCursor : cursor);
	let feedPaneEffectiveCollapsed = $derived(feedPaneCollapsed && hasTreeviewerSections);
	let treeviewerPaneEffectiveCollapsed = $derived(treeviewerPaneCollapsed && hasTreeviewerSections);
	let showWorkspaceSplitter = $derived(
		hasTreeviewerSections && !feedPaneEffectiveCollapsed && !treeviewerPaneEffectiveCollapsed
	);
	let sessionLabel = $derived.by(() => {
		if (profile) return `@${profile.handle}`;
		if (connecting) return 'connecting';
		if (restoringSession) return 'restoring';
		return 'signed out';
	});

	function getFeedStorageKey(sub: string): string {
		return `${FEED_STORAGE_KEY_PREFIX}:${sub}`;
	}

	function readRequestedFeedId(): string | null {
		if (!browser) return null;
		return new URL(window.location.href).searchParams.get('feed');
	}

	function readStoredFeedId(sub: string): string | null {
		if (!browser) return null;
		return localStorage.getItem(getFeedStorageKey(sub));
	}

	function persistSelectedFeedId(sub: string, feedId: string) {
		if (browser) localStorage.setItem(getFeedStorageKey(sub), feedId);
	}

	function clearStoredFeedId(sub: string | null) {
		if (!browser || !sub) return;
		localStorage.removeItem(getFeedStorageKey(sub));
	}

	function updateFeedQuery(feedId: string | null) {
		if (!browser) return;
		const url = new URL(window.location.href);
		if (feedId && feedId !== FOLLOWING_FEED_ID) {
			url.searchParams.set('feed', feedId);
		} else {
			url.searchParams.delete('feed');
		}
		window.history.replaceState({}, '', url.toString());
	}

	function isPhoneViewport(): boolean {
		return browser && window.matchMedia(PHONE_VIEWPORT_QUERY).matches;
	}

	function formatAuthError(err: unknown, fallback: string): string {
		const message = String((err as { message?: string } | null | undefined)?.message ?? '');
		if (message.includes('Missing required scope')) {
			return 'Your previous Bluesky grant was missing feed permissions. Connect again to refresh the grant.';
		}
		return message || fallback;
	}

	function handleFontChange(key: string) {
		fontKey = key;
		try {
			localStorage.setItem('preferred-font', key);
		} catch {}
	}

	function resetGuestState(clearPosts = true) {
		clearStoredFeedId(sessionSub);
		sessionSub = null;
		profile = null;
		feedOptions = [];
		selectedFeedId = FOLLOWING_FEED_ID;
		cursor = undefined;
		closeAuthorView();
		authAgent = null;
		if (clearPosts) posts = [];
		updateFeedQuery(null);
	}

	function resolveInitialFeedId(options: PersonalFeedOption[], preferredFeedId: string | null): string {
		if (preferredFeedId && options.some((option) => option.id === preferredFeedId)) {
			return preferredFeedId;
		}

		const firstPinnedCustomFeed = options.find((option) => option.kind === 'feed' && option.pinned);
		return firstPinnedCustomFeed?.id ?? FOLLOWING_FEED_ID;
	}

	function formatRelativeTime(date: Date): string {
		const diffMs = Date.now() - date.getTime();
		const minutes = Math.max(0, Math.floor(diffMs / 60000));
		if (minutes < 1) return 'just now';
		if (minutes < 60) return `${minutes}m ago`;
		const hours = Math.floor(minutes / 60);
		if (hours < 24) return `${hours}h ago`;
		const days = Math.floor(hours / 24);
		if (days < 14) return `${days}d ago`;
		return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
	}

	function normalizeText(text: string): string {
		const clean = text.replace(/\s+/g, ' ').trim();
		return clean || '[no text body]';
	}

	function extractExternal(post: any): { title?: string; domain?: string } {
		const external =
			post?.embed?.external ??
			post?.embed?.media?.external ??
			post?.record?.embed?.external ??
			post?.record?.embed?.media?.external;
		const title = typeof external?.title === 'string' ? external.title.trim() : '';
		const uri = typeof external?.uri === 'string' ? external.uri : '';
		let domain = '';
		try {
			domain = uri ? new URL(uri).hostname.replace(/^www\./, '') : '';
		} catch {}
		return {
			title: title || undefined,
			domain: domain || undefined
		};
	}

	function repostReasonLabel(reason: AppBskyFeedDefs.FeedViewPost['reason']): string | undefined {
		if (!reason || reason.$type !== 'app.bsky.feed.defs#reasonRepost') return undefined;
		const by = 'by' in reason ? reason.by : null;
		return by?.handle ? `reposted by @${by.handle}` : undefined;
	}

	function replyReasonLabel(reply: AppBskyFeedDefs.FeedViewPost['reply']): string | undefined {
		const parentAuthor = reply?.parent?.author?.handle;
		return parentAuthor ? `replying to @${parentAuthor}` : undefined;
	}

	function mapFrontpagePost(item: AppBskyFeedDefs.FeedViewPost): FrontpagePost | null {
		const post = item?.post;
		if (!post?.uri || !post.author?.did || !post.author?.handle) return null;

		const createdAt = new Date(
			(typeof post.record === 'object' && post.record && 'createdAt' in post.record
				? String(post.record.createdAt)
				: post.indexedAt) || Date.now()
		);
		const permalink = buildBskyPostUrl(post.uri, post.author.handle);
		const external = extractExternal(post);
		const sourceLabel = repostReasonLabel(item.reason) ?? replyReasonLabel(item.reply);
		const text = normalizeText(typeof post.record === 'object' && post.record ? String((post.record as any).text ?? '') : '');

		return {
			id: post.uri,
			authorDid: post.author.did,
			authorHandle: post.author.handle,
			authorDisplayName: post.author.displayName,
			authorAvatar: post.author.avatar,
			text,
			createdAt,
			createdAtLabel: formatRelativeTime(createdAt),
			likeCount: post.likeCount ?? 0,
			repostCount: post.repostCount ?? 0,
			replyCount: post.replyCount ?? 0,
			quoteCount: post.quoteCount ?? 0,
			permalink,
			treeHref: buildViewerHref('treeviewer', { url: permalink }),
			sourceLabel,
			externalTitle: external.title,
			externalDomain: external.domain,
			embedPost: {
				uri: post.uri,
				text,
				linkedUrls: extractBskyPostUrlsFromFacets(
					typeof post.record === 'object' && post.record ? (post.record as any).facets : undefined
				),
				embed: parsePostViewEmbed(post.embed)
			}
		};
	}

	function mergePosts(current: FrontpagePost[], next: FrontpagePost[]): FrontpagePost[] {
		const seen = new Set(current.map((post) => post.id));
		const merged = [...current];
		for (const post of next) {
			if (seen.has(post.id)) continue;
			seen.add(post.id);
			merged.push(post);
		}
		return merged;
	}

	function uniquePosts(next: FrontpagePost[]): FrontpagePost[] {
		return mergePosts([], next);
	}

	async function refreshFeed(feed: PersonalFeedOption, options: { append?: boolean } = {}) {
		if (!authAgent) return;

		const requestToken = ++feedRequestToken;
		const append = options.append ?? false;
		if (append) {
			loadingMore = true;
		} else {
			loading = true;
			error = null;
			cursor = undefined;
		}

		try {
			const result = await fetchPersonalFeedPosts(authAgent, feed, append ? cursor : undefined);
			const mappedPosts = result.posts
				.slice(0, PAGE_SIZE)
				.map(mapFrontpagePost)
				.filter((entry): entry is FrontpagePost => Boolean(entry));

			if (requestToken !== feedRequestToken) return;

			posts = append ? mergePosts(posts, mappedPosts) : uniquePosts(mappedPosts);
			cursor = result.cursor;
			selectedFeedId = feed.id;
			if (sessionSub) persistSelectedFeedId(sessionSub, feed.id);
			updateFeedQuery(feed.id);
		} catch (err: any) {
			if (requestToken !== feedRequestToken) return;
			error = err?.message || `Could not load ${feed.label}.`;
			if (!append) posts = [];
		} finally {
			if (requestToken !== feedRequestToken) return;
			loading = false;
			loadingMore = false;
		}
	}

	async function loadFeedsForContext(
		context: AuthenticatedBlueskyContext,
		preferredFeedId: string | null = null
	) {
		authAgent = context.agent;
		profile = context.profile;
		sessionSub = context.session.sub;
		loadingFeeds = true;

		try {
			const options = await resolvePersonalFeeds(context.agent);
			feedOptions = options;
			const nextFeedId = resolveInitialFeedId(options, preferredFeedId);
			selectedFeedId = nextFeedId;
			const nextFeed = options.find((option) => option.id === nextFeedId) ?? options[0];
			if (nextFeed) await refreshFeed(nextFeed);
		} finally {
			loadingFeeds = false;
		}
	}

	async function applyAuthenticatedContext(context: AuthenticatedBlueskyContext) {
		const requestedFeedId = readRequestedFeedId();
		const storedFeedId = readStoredFeedId(context.session.sub);
		await loadFeedsForContext(context, requestedFeedId ?? storedFeedId);
	}

	async function restoreSession() {
		restoringSession = true;
		error = null;

		try {
			const { client, context } = await initAuthenticatedBlueskyClient();
			authClient = client;
			if (context) {
				await applyAuthenticatedContext(context);
			} else {
				resetGuestState();
			}
		} catch (err: any) {
			const message = String(err?.message || '');
			if (message.includes('Redirecting to loopback IP')) return;
			error = formatAuthError(err, 'Could not restore your Bluesky session.');
			resetGuestState();
		} finally {
			restoringSession = false;
		}
	}

	async function handleConnect() {
		connecting = true;
		error = null;

		try {
			await connectBlueskyWithRedirect(
				browser ? `${window.location.origin}${window.location.pathname}` : undefined
			);
		} catch (err: any) {
			error = formatAuthError(err, 'Could not connect your Bluesky account.');
			connecting = false;
		} finally {
			if (!browser) connecting = false;
		}
	}

	async function handleDisconnect() {
		const sub = sessionSub;
		if (!sub) return;

		try {
			await disconnectBluesky(sub);
			resetGuestState();
		} catch (err: any) {
			error = err?.message || 'Could not disconnect your Bluesky session.';
		}
	}

	async function handleRefreshNow() {
		if (authorProfile) {
			await loadAuthorView(authorProfile.did);
		} else if (selectedFeed) {
			await refreshFeed(selectedFeed);
		}
	}

	async function handleLoadMore() {
		if (authorProfile && authorCursor) {
			await loadAuthorView(authorProfile.did, { append: true });
		} else if (selectedFeed && cursor) {
			await refreshFeed(selectedFeed, { append: true });
		}
	}

	async function fetchAuthorProfile(actor: string): Promise<FrontpageAuthorProfile> {
		if (!authAgent) throw new Error('Connect Bluesky before opening author profiles.');
		const res = await authAgent.app.bsky.actor.getProfile({ actor });
		return {
			did: res.data.did,
			handle: res.data.handle,
			displayName: res.data.displayName,
			avatar: res.data.avatar,
			description: res.data.description,
			followersCount: res.data.followersCount,
			followsCount: res.data.followsCount,
			postsCount: res.data.postsCount ?? 0
		};
	}

	async function loadAuthorView(actor: string, options: { append?: boolean } = {}) {
		if (!authAgent) return;
		const append = options.append ?? false;
		const requestToken = ++authorRequestToken;

		if (append) {
			authorLoadingMore = true;
		} else {
			authorLoading = true;
			authorError = null;
			authorPosts = [];
			authorCursor = undefined;
		}

		try {
			let nextProfile = authorProfile;
			if (!append) {
				nextProfile = await fetchAuthorProfile(actor);
				if (requestToken !== authorRequestToken) return;
				authorProfile = nextProfile;
				authorTargetLabel = `@${nextProfile.handle}`;
			}

			const targetActor = nextProfile?.did ?? actor;
			const targetDid = nextProfile?.did;
			const result = await authAgent.app.bsky.feed.getAuthorFeed({
				actor: targetActor,
				filter: 'posts_with_replies',
				limit: 100,
				cursor: append ? authorCursor : undefined
			});
			const mappedPosts = result.data.feed
				.filter((item) => !targetDid || item.post.author?.did === targetDid)
				.slice(0, PAGE_SIZE)
				.map(mapFrontpagePost)
				.filter((entry): entry is FrontpagePost => Boolean(entry));

			if (requestToken !== authorRequestToken) return;
			authorPosts = append ? mergePosts(authorPosts, mappedPosts) : uniquePosts(mappedPosts);
			authorCursor = result.data.cursor;
			void tick().then(() => workspaceElement?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
		} catch (err: any) {
			if (requestToken !== authorRequestToken) return;
			authorError = err?.message || `Could not load ${authorTargetLabel ?? 'that author'}.`;
			if (!append) authorPosts = [];
		} finally {
			if (requestToken !== authorRequestToken) return;
			authorLoading = false;
			authorLoadingMore = false;
		}
	}

	async function openAuthorView(event: MouseEvent, post: FrontpagePost) {
		event.preventDefault();
		event.stopPropagation();
		authorTargetLabel = `@${post.authorHandle}`;
		if (!authorViewActive) authorReturnPostId = post.id;
		await loadAuthorView(post.authorDid);
	}

	function closeAuthorView(options: { returnToFeed?: boolean } = {}) {
		const returnPostId = options.returnToFeed ? authorReturnPostId : null;
		authorRequestToken++;
		authorProfile = null;
		authorPosts = [];
		authorCursor = undefined;
		authorLoading = false;
		authorLoadingMore = false;
		authorError = null;
		authorTargetLabel = null;
		authorReturnPostId = null;
		if (returnPostId) scrollFeedPostIntoView(returnPostId);
	}

	async function selectFeed(nextId: string) {
		const nextFeed = feedOptions.find((option) => option.id === nextId);
		if (!nextFeed || loadingFeeds || loadingMore) return;

		selectedFeedId = nextId;
		switchingFeedId = nextId;
		if (sessionSub) persistSelectedFeedId(sessionSub, nextId);
		updateFeedQuery(nextId);

		try {
			await refreshFeed(nextFeed);
		} finally {
			if (switchingFeedId === nextId) switchingFeedId = null;
		}
	}

	async function handleFeedChange(event: Event) {
		await selectFeed((event.currentTarget as HTMLSelectElement).value);
	}

	function handleSessionDeleted() {
		error = 'Your Bluesky session expired. Connect again when you want your front page back.';
		resetGuestState();
	}

	function rememberThread(post: FrontpagePost) {
		if (!browser || !post.permalink) return;
		rememberRecentThread(localStorage, {
			url: post.permalink,
			title: post.text,
			authorHandle: post.authorHandle
		});
	}

	function buildTreeSectionHref(href: string, textPanelMode: TreeviewerTextPanelMode = 'forum'): string {
		try {
			const url = new URL(href, 'http://atprotocodex.local');
			url.searchParams.set('embed', 'thread-section');
			url.searchParams.set('view', textPanelMode);
			return `${url.pathname}${url.search}${url.hash}`;
		} catch {
			const separator = href.includes('?') ? '&' : '?';
			return `${href}${separator}embed=thread-section&view=${textPanelMode}`;
		}
	}

	function normalizeTreeviewerSettings(settings?: Partial<TreeviewerSectionSettings>): TreeviewerSectionSettings {
		const normalized = {
			textPanelMode:
				settings?.textPanelMode === 'chat' || settings?.textPanelMode === 'forum'
					? settings.textPanelMode
					: DEFAULT_TREEVIEWER_SECTION_SETTINGS.textPanelMode,
			treeCollapsed:
				typeof settings?.treeCollapsed === 'boolean'
					? settings.treeCollapsed
					: DEFAULT_TREEVIEWER_SECTION_SETTINGS.treeCollapsed,
			chatCollapsed:
				typeof settings?.chatCollapsed === 'boolean'
					? settings.chatCollapsed
					: DEFAULT_TREEVIEWER_SECTION_SETTINGS.chatCollapsed,
			uiCollapsed:
				typeof settings?.uiCollapsed === 'boolean'
					? settings.uiCollapsed
					: DEFAULT_TREEVIEWER_SECTION_SETTINGS.uiCollapsed,
			allReplies:
				typeof settings?.allReplies === 'boolean'
					? settings.allReplies
					: DEFAULT_TREEVIEWER_SECTION_SETTINGS.allReplies
		};

		if (normalized.allReplies) normalized.chatCollapsed = false;
		if (normalized.treeCollapsed && normalized.chatCollapsed) normalized.chatCollapsed = false;
		return normalized;
	}

	function settingsFromSection(section: TreeviewerSection): TreeviewerSectionSettings {
		return normalizeTreeviewerSettings({
			textPanelMode: section.textPanelMode,
			treeCollapsed: section.treeCollapsed,
			chatCollapsed: section.chatCollapsed,
			uiCollapsed: section.uiCollapsed,
			allReplies: section.allReplies
		});
	}

	function settingsForNewTreeviewerSection(): TreeviewerSectionSettings {
		const defaultSection = treeviewerSections[0];
		return defaultSection ? settingsFromSection(defaultSection) : { ...treeviewerDefaultSettings };
	}

	function readFrontpageSettings(): FrontpageSettings | null {
		if (!browser) return null;
		try {
			const raw = localStorage.getItem(FRONTPAGE_SETTINGS_STORAGE_KEY);
			if (!raw) return null;
			const parsed = JSON.parse(raw) as FrontpageSettings;
			return parsed && typeof parsed === 'object' ? parsed : null;
		} catch {
			return null;
		}
	}

	function restoreFrontpageSettings() {
		const settings = readFrontpageSettings();
		if (settings) {
			if (typeof settings.treePanePercent === 'number' && Number.isFinite(settings.treePanePercent)) {
				treePanePercent = clampTreePanePercent(settings.treePanePercent);
			}
			feedPaneCollapsed = settings.feedPaneCollapsed === true;
			treeviewerPaneCollapsed = settings.treeviewerPaneCollapsed === true;
			if (feedPaneCollapsed && treeviewerPaneCollapsed) treeviewerPaneCollapsed = false;
			treeviewerDefaultSettings = normalizeTreeviewerSettings(settings.treeviewerDefaults);
		}
		frontpageSettingsRestored = true;
	}

	function persistFrontpageSettings() {
		if (!browser || !frontpageSettingsRestored) return;
		try {
			localStorage.setItem(
				FRONTPAGE_SETTINGS_STORAGE_KEY,
				JSON.stringify({
					treePanePercent,
					feedPaneCollapsed,
					treeviewerPaneCollapsed,
					treeviewerDefaults: treeviewerDefaultSettings
				})
			);
		} catch {}
	}

	function openThreadSection(event: MouseEvent, post: FrontpagePost) {
		event.preventDefault();
		rememberThread(post);
		const phoneViewport = isPhoneViewport();
		const defaultSettings = settingsForNewTreeviewerSection();
		const nextSection: TreeviewerSection = {
			id: `treeviewer-section-${Date.now()}-${++treeviewerSectionCounter}`,
			href: post.treeHref,
			sectionHref: buildTreeSectionHref(post.treeHref, defaultSettings.textPanelMode),
			returnPostId: post.id,
			title: post.text,
			author: post.authorHandle,
			...defaultSettings,
			createdAt: Date.now()
		};
		if (phoneViewport) {
			treeviewerFrames.clear();
			treeviewerSections = [nextSection];
			feedPaneCollapsed = false;
			mobileThreadFocused = true;
		} else {
			treeviewerSections = [...treeviewerSections, nextSection];
		}
		treeviewerPaneCollapsed = false;
		void tick().then(() => {
			if (phoneViewport) {
				workspaceElement?.scrollIntoView({ behavior: 'smooth', block: 'start', inline: 'nearest' });
				scrollTreeviewerSectionIntoView(nextSection.id, 'start', 'nearest');
				return;
			}
			scrollTreeviewerSectionIntoView(nextSection.id);
		});
	}

	function closeThreadSection(sectionId: string, options: { returnToFeed?: boolean } = {}) {
		const closedSection = treeviewerSections.find((section) => section.id === sectionId);
		treeviewerFrames.delete(sectionId);
		const wasDefaultSection = treeviewerSections[0]?.id === sectionId;
		const nextSections = treeviewerSections.filter((section) => section.id !== sectionId);
		treeviewerSections = nextSections;
		if (wasDefaultSection && nextSections[0]) {
			treeviewerDefaultSettings = settingsFromSection(nextSections[0]);
		}
		if (nextSections.length === 0) {
			feedPaneCollapsed = false;
			treeviewerPaneCollapsed = false;
			mobileThreadFocused = false;
		}
		if (nextSections.length <= 1) stopPaneSplitDrag();
		if (options.returnToFeed) scrollFeedPostIntoView(closedSection?.returnPostId);
	}

	function scrollFeedPostIntoView(postId: string | undefined) {
		if (!browser || !postId) return;
		void tick().then(() => {
			const postRows = Array.from(document.querySelectorAll<HTMLElement>('[data-frontpage-post-id]'));
			const target = postRows.find((row) => row.dataset.frontpagePostId === postId);
			if (!target) return;
			target.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
			returnedPostHighlightId = postId;
			if (returnHighlightTimeout !== null) window.clearTimeout(returnHighlightTimeout);
			returnHighlightTimeout = window.setTimeout(() => {
				if (returnedPostHighlightId === postId) returnedPostHighlightId = null;
				returnHighlightTimeout = null;
			}, 1600);
		});
	}

	function setFeedPaneCollapsed(nextCollapsed: boolean) {
		if (nextCollapsed && !hasTreeviewerSections) return;
		feedPaneCollapsed = nextCollapsed;
		if (nextCollapsed) treeviewerPaneCollapsed = false;
	}

	function setTreeviewerPaneCollapsed(nextCollapsed: boolean) {
		if (nextCollapsed && !hasTreeviewerSections) return;
		treeviewerPaneCollapsed = nextCollapsed;
		if (nextCollapsed) {
			feedPaneCollapsed = false;
			mobileThreadFocused = false;
		} else {
			if (isPhoneViewport()) mobileThreadFocused = true;
			void tick().then(() => {
				for (const section of treeviewerSections) {
					syncTreeviewerSectionState(section.id);
				}
			});
		}
	}

	function scrollTreeviewerSectionIntoView(
		sectionId: string,
		block: ScrollLogicalPosition = 'nearest',
		inline: ScrollLogicalPosition = 'end'
	) {
		if (!treeviewerSectionsElement) return;
		const sectionElement = treeviewerSectionsElement.querySelector<HTMLElement>(
			`[data-treeviewer-section-id="${sectionId}"]`
		);
		sectionElement?.scrollIntoView({
			behavior: 'smooth',
			block,
			inline
		});
	}

	function clampTreePanePercent(value: number): number {
		return Math.min(78, Math.max(25, Math.round(value)));
	}

	function setTreePanePercent(nextPercent: number) {
		treePanePercent = clampTreePanePercent(nextPercent);
	}

	function updateSplitFromClientX(clientX: number) {
		if (!workspaceElement) return;
		const bounds = workspaceElement.getBoundingClientRect();
		if (bounds.width <= 0) return;
		setTreePanePercent(((bounds.right - clientX) / bounds.width) * 100);
	}

	function handlePaneSplitPointerMove(event: PointerEvent) {
		updateSplitFromClientX(event.clientX);
	}

	function stopPaneSplitDrag() {
		if (!browser) return;
		splitDragging = false;
		window.removeEventListener('pointermove', handlePaneSplitPointerMove);
		window.removeEventListener('pointerup', stopPaneSplitDrag);
		window.removeEventListener('pointercancel', stopPaneSplitDrag);
		document.body.style.cursor = '';
		document.body.style.userSelect = '';
	}

	function startPaneSplitDrag(event: PointerEvent) {
		if (!showWorkspaceSplitter) return;
		event.preventDefault();
		splitDragging = true;
		updateSplitFromClientX(event.clientX);
		window.addEventListener('pointermove', handlePaneSplitPointerMove);
		window.addEventListener('pointerup', stopPaneSplitDrag);
		window.addEventListener('pointercancel', stopPaneSplitDrag);
		document.body.style.cursor = 'col-resize';
		document.body.style.userSelect = 'none';
	}

	function handlePaneSplitKeydown(event: KeyboardEvent) {
		if (event.key === 'ArrowLeft') {
			setTreePanePercent(treePanePercent + 4);
		} else if (event.key === 'ArrowRight') {
			setTreePanePercent(treePanePercent - 4);
		} else if (event.key === 'Home') {
			setTreePanePercent(78);
		} else if (event.key === 'End') {
			setTreePanePercent(25);
		} else {
			return;
		}

		event.preventDefault();
	}

	function findTreeviewerSection(sectionId: string): TreeviewerSection | null {
		return treeviewerSections.find((section) => section.id === sectionId) ?? null;
	}

	function updateTreeviewerSection(
		sectionId: string,
		updater: (section: TreeviewerSection) => TreeviewerSection
	): TreeviewerSection | null {
		let nextSection: TreeviewerSection | null = null;
		const isDefaultSection = treeviewerSections[0]?.id === sectionId;
		treeviewerSections = treeviewerSections.map((section) => {
			if (section.id !== sectionId) return section;
			nextSection = {
				...updater(section),
				createdAt: section.createdAt
			};
			return nextSection;
		});
		if (isDefaultSection && nextSection) {
			treeviewerDefaultSettings = settingsFromSection(nextSection);
		}
		return nextSection;
	}

	function handleTreeviewerFrameLoad(event: Event, sectionId: string) {
		const frame = event.currentTarget as HTMLIFrameElement | null;
		if (!frame) return;
		treeviewerFrames.set(sectionId, frame);
		syncTreeviewerSectionState(sectionId);
		window.setTimeout(() => syncTreeviewerSectionState(sectionId), 120);
		window.setTimeout(() => syncTreeviewerSectionState(sectionId), 360);
	}

	function syncTreeviewerSectionState(sectionId: string) {
		const section = findTreeviewerSection(sectionId);
		if (!section) return;
		sendTreeviewerPanelState(sectionId, section);
		sendTreeviewerAllRepliesState(sectionId, section.allReplies);
	}

	function sendTreeviewerPanelState(sectionId: string, sectionOverride?: TreeviewerSection | null) {
		const section = sectionOverride ?? findTreeviewerSection(sectionId);
		const frame = treeviewerFrames.get(sectionId);
		if (!browser || !section || !frame?.contentWindow) return;
		frame.contentWindow.postMessage(
			{
				type: TREEVIEWER_PANEL_STATE_MESSAGE,
				textPanelMode: section.textPanelMode,
				treeCollapsed: section.treeCollapsed,
				chatCollapsed: section.chatCollapsed,
				uiCollapsed: section.uiCollapsed
			},
			window.location.origin
		);
	}

	function sendTreeviewerAllRepliesState(sectionId: string, enabled: boolean) {
		const frame = treeviewerFrames.get(sectionId);
		if (!browser || !frame?.contentWindow) return;
		frame.contentWindow.postMessage(
			{
				type: TREEVIEWER_PANEL_STATE_MESSAGE,
				allReplies: enabled
			},
			window.location.origin
		);
	}

	function setEmbeddedTreeCollapsed(sectionId: string, nextCollapsed: boolean) {
		const nextSection = updateTreeviewerSection(sectionId, (section) => ({
			...section,
			treeCollapsed: nextCollapsed,
			chatCollapsed: nextCollapsed && section.chatCollapsed ? false : section.chatCollapsed
		}));
		sendTreeviewerPanelState(sectionId, nextSection);
	}

	function setEmbeddedChatCollapsed(sectionId: string, nextCollapsed: boolean) {
		const nextSection = updateTreeviewerSection(sectionId, (section) => ({
			...section,
			treeCollapsed: nextCollapsed && section.treeCollapsed ? false : section.treeCollapsed,
			chatCollapsed: nextCollapsed
		}));
		sendTreeviewerPanelState(sectionId, nextSection);
	}

	function setEmbeddedUiCollapsed(sectionId: string, nextCollapsed: boolean) {
		const nextSection = updateTreeviewerSection(sectionId, (section) => ({
			...section,
			uiCollapsed: nextCollapsed
		}));
		sendTreeviewerPanelState(sectionId, nextSection);
	}

	function setEmbeddedTextPanelMode(sectionId: string, textPanelMode: TreeviewerTextPanelMode) {
		const nextSection = updateTreeviewerSection(sectionId, (section) => ({
			...section,
			textPanelMode
		}));
		sendTreeviewerPanelState(sectionId, nextSection);
	}

	function toggleAllRepliesInTreeviewer(sectionId: string) {
		const nextSection = updateTreeviewerSection(sectionId, (section) => ({
			...section,
			chatCollapsed: section.allReplies ? section.chatCollapsed : false,
			allReplies: !section.allReplies
		}));
		if (!nextSection) return;
		sendTreeviewerAllRepliesState(sectionId, nextSection.allReplies);
	}

	function handleTreeviewerPanelMessage(event: MessageEvent) {
		if (!browser || event.origin !== window.location.origin) return;
		const data = event.data as { type?: unknown; ready?: unknown; allRepliesState?: unknown };
		if (!data || data.type !== TREEVIEWER_PANEL_STATE_MESSAGE) return;
		const section = treeviewerSections.find(
			(candidate) => treeviewerFrames.get(candidate.id)?.contentWindow === event.source
		);
		if (!section) return;
		if (data.ready === true) {
			syncTreeviewerSectionState(section.id);
			return;
		}
		if (typeof data.allRepliesState === 'boolean') {
			updateTreeviewerSection(section.id, (current) => ({
				...current,
				chatCollapsed: data.allRepliesState ? false : current.chatCollapsed,
				allReplies: data.allRepliesState as boolean
			}));
		}
	}

	function addAuthClientListener(client: BrowserOAuthClient, handler: EventListener) {
		(client as unknown as EventTarget).addEventListener('deleted', handler);
	}

	function removeAuthClientListener(client: BrowserOAuthClient | null, handler: EventListener) {
		(client as unknown as EventTarget | null)?.removeEventListener('deleted', handler);
	}

	onMount(() => {
		try {
			const savedFont = localStorage.getItem('preferred-font');
			if (savedFont && savedFont in fontFamilies) fontKey = savedFont;
		} catch {}
		restoreFrontpageSettings();

		void restoreSession();
		window.addEventListener('message', handleTreeviewerPanelMessage);

		return () => {
			window.removeEventListener('message', handleTreeviewerPanelMessage);
			removeAuthClientListener(authClient, handleSessionDeleted as EventListener);
		};
	});

	$effect(() => {
		frontpageSettingsRestored;
		treePanePercent;
		feedPaneCollapsed;
		treeviewerPaneCollapsed;
		treeviewerDefaultSettings;
		persistFrontpageSettings();
	});

	$effect(() => {
		if (!authClient) return;
		addAuthClientListener(authClient, handleSessionDeleted as EventListener);

		return () => {
			removeAuthClientListener(authClient, handleSessionDeleted as EventListener);
		};
	});

	onDestroy(() => {
		stopPaneSplitDrag();
		if (returnHighlightTimeout !== null) window.clearTimeout(returnHighlightTimeout);
	});
</script>

<svelte:head>
	<title>Frontpage</title>
</svelte:head>

<main
	class="frontpage-shell"
	class:mobile-thread-focused={mobileThreadFocused && hasTreeviewerSections && !treeviewerPaneEffectiveCollapsed}
	style="font-family: {fontFamily}"
>
	<header class="frontpage-header">
		<RouteNav current="frontpage" compact handle={profile?.handle ?? null} />
		<div class="masthead">
			<div class="masthead-copy">
				<p class="kicker">ATProto frontpage</p>
				<div class="title-row">
					<h1>Frontpage</h1>
					{#if profile}
						<div class="feed-toolbar">
							{#if authorViewActive}
								<button type="button" class="back-to-feed-button" onclick={() => closeAuthorView({ returnToFeed: true })}>
									Back to feed
								</button>
								<span>{authorProfile ? `@${authorProfile.handle}` : (authorTargetLabel ?? 'Author')} profile</span>
								<span>{activePosts.length} items</span>
							{:else}
								<label for="feed-picker">Feed</label>
								<select
									id="feed-picker"
									bind:value={selectedFeedId}
									onchange={handleFeedChange}
									disabled={loadingFeeds || loadingMore || feedOptions.length === 0}
								>
									{#each feedOptions as feed (feed.id)}
										<option value={feed.id}>{feed.label}</option>
									{/each}
								</select>
								<span>{posts.length} items</span>
								{#if selectedFeed?.description}
									<span class="feed-description">{selectedFeed.description}</span>
								{/if}
							{/if}
						</div>
					{/if}
				</div>
				<p class="subtitle">A compact feed reader with one-click Treeviewer sections.</p>
			</div>
			<div class="session-panel">
				{#if profile}
					<div class="session-actions">
						<span class="session-identity">
							{#if profile.avatar}
								<img src={profile.avatar} alt="" />
							{/if}
							<span>{profile.displayName || profile.handle}</span>
						</span>
						<span class="session-label">{sessionLabel}</span>
						<button type="button" onclick={handleRefreshNow} disabled={activeLoading || loadingFeeds}>
							{activeLoading ? 'Refreshing' : 'Refresh'}
						</button>
						<button type="button" class="ghost" onclick={handleDisconnect}>Disconnect</button>
					</div>
				{:else}
					<div class="session-actions">
						<span class="session-label">{sessionLabel}</span>
						<button type="button" onclick={handleConnect} disabled={connecting || restoringSession}>
							{connecting ? 'Opening Bluesky' : 'Connect Bluesky'}
						</button>
					</div>
				{/if}
				<div class="view-controls">
					<FontPicker value={fontKey} onchange={handleFontChange} />
					{#if hasTreeviewerSections}
						<div class="pane-collapse-controls" role="group" aria-label="Pane collapse options">
							<button type="button" class="ghost" onclick={() => setFeedPaneCollapsed(!feedPaneEffectiveCollapsed)}>
								{feedPaneEffectiveCollapsed ? 'Show feed' : 'Collapse feed'}
							</button>
							<button
								type="button"
								class="ghost"
								onclick={() => setTreeviewerPaneCollapsed(!treeviewerPaneEffectiveCollapsed)}
							>
								{treeviewerPaneEffectiveCollapsed ? 'Show Treeviewers' : 'Collapse Treeviewers'}
							</button>
						</div>
					{/if}
				</div>
			</div>
		</div>
	</header>

	{#if error}
		<div class="frontpage-error">{error}</div>
	{/if}
	{#if authorError}
		<div class="frontpage-error">{authorError}</div>
	{/if}

	{#if !profile && !restoringSession}
		<section class="empty-state">
			<h2>Connect Bluesky to build your front page.</h2>
			<p>Your Following timeline and saved feeds will appear here, then each post can open as a tree.</p>
		</section>
	{:else if activeLoading && activePosts.length === 0}
		<section class="empty-state">
			<h2>{authorViewActive ? 'Loading author profile...' : 'Loading the front page...'}</h2>
			<p>
				{authorViewActive
					? `Fetching posts and replies from ${authorTargetLabel ?? 'that author'}.`
					: `Fetching the newest posts from ${selectedFeed?.label ?? 'your feed'}.`}
			</p>
		</section>
	{:else if activePosts.length === 0 && profile}
		<section class="empty-state">
			<h2>No posts found.</h2>
			<p>{authorViewActive ? 'Try refreshing this author profile.' : 'Try refreshing or picking another saved feed.'}</p>
		</section>
	{:else}
		<div
			bind:this={workspaceElement}
			class="frontpage-workspace"
			class:with-viewer={hasTreeviewerSections}
			class:feed-collapsed={feedPaneEffectiveCollapsed}
			class:treeviewer-collapsed={treeviewerPaneEffectiveCollapsed}
			style={hasTreeviewerSections
				? `--feed-fr: ${100 - treePanePercent}fr; --viewer-fr: ${treePanePercent}fr;`
				: ''}
		>
			<section class="feed-section" class:collapsed={feedPaneEffectiveCollapsed} aria-label="Frontpage feed">
				{#if feedPaneEffectiveCollapsed}
					<button type="button" class="pane-rail-button" onclick={() => setFeedPaneCollapsed(false)}>
						Show feed
					</button>
				{:else}
					{#if authorViewActive}
						<section class="author-profile-card" aria-label="Author profile">
							<button type="button" class="back-to-feed-button" onclick={() => closeAuthorView({ returnToFeed: true })}>
								Back to feed
							</button>
							{#if authorProfile}
								<div class="author-profile-main">
									{#if authorProfile.avatar}
										<img src={authorProfile.avatar} alt="" />
									{/if}
									<div>
										<h2>{authorProfile.displayName || `@${authorProfile.handle}`}</h2>
										<p class="author-handle">@{authorProfile.handle}</p>
										{#if authorProfile.description}
											<p class="author-description">{authorProfile.description}</p>
										{/if}
										<div class="author-stats">
											<span>{authorProfile.postsCount} posts</span>
											{#if typeof authorProfile.followersCount === 'number'}
												<span>{authorProfile.followersCount} followers</span>
											{/if}
											{#if typeof authorProfile.followsCount === 'number'}
												<span>{authorProfile.followsCount} following</span>
											{/if}
										</div>
									</div>
								</div>
							{:else}
								<p class="author-description">Loading {authorTargetLabel ?? 'author'}...</p>
							{/if}
						</section>
					{/if}
					<ol class="post-list">
						{#each activePosts as post (post.id)}
							<li
								class="post-row"
								class:active={treeviewerSections.some((section) => section.href === post.treeHref)}
								class:return-highlight={returnedPostHighlightId === post.id}
								data-frontpage-post-id={post.id}
							>
								<a
									class="row-hit-link"
									href={post.treeHref}
									aria-label={`Open ${post.text} in Treeviewer`}
									onclick={(event) => openThreadSection(event, post)}
								></a>
								<div class="post-main">
									<button
										type="button"
										class="post-author-line author-profile-button"
										aria-label={`Open @${post.authorHandle} profile`}
										onclick={(event) => openAuthorView(event, post)}
									>
										{#if post.authorAvatar}
											<img src={post.authorAvatar} alt="" />
										{/if}
										<span>{post.authorDisplayName || `@${post.authorHandle}`}</span>
										{#if post.authorDisplayName}
											<small>@{post.authorHandle}</small>
										{/if}
									</button>
									<div class="post-title-line">
										<a class="post-title" href={post.treeHref} onclick={(event) => openThreadSection(event, post)}
											>{post.text}</a
										>
									</div>
									<PostEmbedPreview post={post.embedPost} compact />
									<div class="post-meta">
										<span>{post.createdAtLabel}</span>
										<span>{post.replyCount} comments</span>
										<span>{post.likeCount} likes</span>
										{#if post.externalDomain}
											<span>{post.externalDomain}</span>
										{/if}
										{#if post.sourceLabel}
											<span>{post.sourceLabel}</span>
										{/if}
										{#if post.permalink}
											<a href={post.permalink} target="_blank" rel="noreferrer">Bluesky</a>
										{/if}
										<a href={post.treeHref} onclick={(event) => openThreadSection(event, post)}>
											Open beside
										</a>
									</div>
								</div>
							</li>
						{/each}
					</ol>

					<div class="load-more-row">
						<button type="button" onclick={handleLoadMore} disabled={!activeCursor || activeLoadingMore || activeLoading}>
							{#if activeLoadingMore}
								Loading more
							{:else if activeCursor}
								More
							{:else}
								{authorViewActive ? 'End of profile' : 'End of feed'}
							{/if}
						</button>
					</div>
				{/if}
			</section>

			{#if showWorkspaceSplitter}
				<button
					type="button"
					class="workspace-splitter"
					class:dragging={splitDragging}
					aria-label={`Resize feed and Treeviewer sections, Treeviewer ${treePanePercent}%`}
					onpointerdown={startPaneSplitDrag}
					onkeydown={handlePaneSplitKeydown}
				>
					<span aria-hidden="true"></span>
				</button>
			{/if}
			{#if hasTreeviewerSections && treeviewerPaneEffectiveCollapsed}
				<aside class="treeviewer-pane-rail" aria-label="Collapsed Treeviewer pane">
					<button type="button" class="pane-rail-button" onclick={() => setTreeviewerPaneCollapsed(false)}>
						Show Treeviewers
					</button>
				</aside>
			{/if}
			{#if hasTreeviewerSections}
				<section
					class="treeviewer-pane"
					class:collapsed={treeviewerPaneEffectiveCollapsed}
					aria-label="Treeviewer pane"
					aria-hidden={treeviewerPaneEffectiveCollapsed}
				>
					<section
						bind:this={treeviewerSectionsElement}
						class="treeviewer-sections"
						class:single={treeviewerSections.length === 1}
						aria-label="Treeviewer sections"
					>
						{#each treeviewerSections as section (section.id)}
							<article
								class="treeviewer-section"
								data-treeviewer-section-id={section.id}
								aria-label={`Treeviewer for ${section.title}`}
							>
								<div class="treeviewer-toolbar">
									<div>
										<p>{section.id === treeviewerSections[0]?.id ? 'Default Treeviewer' : 'Treeviewer'}</p>
										<span class="treeviewer-author">@{section.author}</span>
										<h2>{section.title}</h2>
									</div>
									<div class="treeviewer-actions">
										<button
											type="button"
											class="mobile-back-button"
											onclick={() => closeThreadSection(section.id, { returnToFeed: true })}
										>
											Back to feed
										</button>
										<a href={section.href}>Full page</a>
										<button
											type="button"
											class="panel-toggle"
											class:active={section.textPanelMode === 'chat'}
											aria-pressed={section.textPanelMode === 'chat'}
											onclick={() => setEmbeddedTextPanelMode(section.id, 'chat')}
										>
											Chat
										</button>
										<button
											type="button"
											class="panel-toggle"
											class:active={section.textPanelMode === 'forum'}
											aria-pressed={section.textPanelMode === 'forum'}
											onclick={() => setEmbeddedTextPanelMode(section.id, 'forum')}
										>
											Forum
										</button>
										<button
											type="button"
											class="panel-toggle"
											class:active={!section.treeCollapsed}
											aria-pressed={!section.treeCollapsed}
											onclick={() => setEmbeddedTreeCollapsed(section.id, !section.treeCollapsed)}
										>
											{section.treeCollapsed ? 'Show tree' : 'Hide tree'}
										</button>
										<button
											type="button"
											class="panel-toggle"
											class:active={!section.chatCollapsed}
											aria-pressed={!section.chatCollapsed}
											onclick={() => setEmbeddedChatCollapsed(section.id, !section.chatCollapsed)}
										>
											{section.chatCollapsed ? 'Show chat' : 'Hide chat'}
										</button>
										<button
											type="button"
											class="panel-toggle"
											class:active={!section.uiCollapsed}
											aria-pressed={!section.uiCollapsed}
											onclick={() => setEmbeddedUiCollapsed(section.id, !section.uiCollapsed)}
										>
											{section.uiCollapsed ? 'Show UI' : 'Hide UI'}
										</button>
										<button type="button" class="panel-toggle" onclick={() => toggleAllRepliesInTreeviewer(section.id)}>
											{section.allReplies ? 'Path only' : 'Show all replies'}
										</button>
										<button
											type="button"
											class="ghost"
											onclick={() => closeThreadSection(section.id, { returnToFeed: isPhoneViewport() })}
										>
											Close
										</button>
									</div>
								</div>
								<iframe
									title={`Treeviewer for ${section.title}`}
									src={section.sectionHref}
									onload={(event) => handleTreeviewerFrameLoad(event, section.id)}
								></iframe>
							</article>
						{/each}
					</section>
				</section>
			{/if}
		</div>
	{/if}
</main>

<style>
	.frontpage-shell {
		height: 100vh;
		display: flex;
		flex-direction: column;
		overflow: hidden;
		padding: 4px;
		background:
			linear-gradient(180deg, rgba(255, 248, 226, 0.82), rgba(244, 247, 244, 0.96)),
			var(--bg);
		color: var(--text-ink);
	}

	.frontpage-header {
		width: 100%;
		flex: 0 0 auto;
		margin: 0 0 10px;
	}

	.masthead {
		display: flex;
		align-items: flex-end;
		justify-content: space-between;
		gap: 14px;
		padding: 10px 0 12px;
		border-bottom: 1px solid color-mix(in srgb, var(--text-ink) 18%, transparent);
	}

	.masthead-copy {
		min-width: 0;
		flex: 1 1 auto;
	}

	.title-row {
		display: flex;
		align-items: center;
		gap: 12px;
		min-width: 0;
		flex-wrap: wrap;
	}

	.kicker {
		margin: 0 0 2px;
		color: var(--muted);
		font-size: 0.68rem;
		font-weight: 800;
		letter-spacing: 0;
		text-transform: uppercase;
	}

	h1 {
		margin: 0;
		font-size: clamp(1.65rem, 4vw, 2.7rem);
		line-height: 1;
	}

	.subtitle {
		margin: 4px 0 0;
		color: var(--muted);
		font-size: 0.88rem;
	}

	.session-panel {
		display: flex;
		flex-direction: column;
		align-items: flex-end;
		gap: 6px;
		min-width: min(280px, 100%);
	}

	.session-label {
		font-size: 0.68rem;
		font-weight: 800;
		text-transform: uppercase;
		color: var(--muted);
	}

	.session-identity {
		display: flex;
		align-items: center;
		gap: 6px;
		font-weight: 800;
		font-size: 0.88rem;
	}

	.session-identity img {
		width: 18px;
		height: 18px;
		border-radius: 50%;
		object-fit: cover;
	}

	.session-actions,
	.feed-toolbar,
	.view-controls,
	.pane-collapse-controls {
		display: flex;
		align-items: center;
		gap: 8px;
		flex-wrap: wrap;
	}

	button,
	select {
		border: 1px solid var(--control-border);
		background: var(--control-bg);
		color: var(--text-ink);
		border-radius: 6px;
		font: inherit;
		font-weight: 750;
	}

	button {
		padding: 5px 9px;
		cursor: pointer;
	}

	button:hover:not(:disabled) {
		background: var(--control-bg-hover);
	}

	button:disabled {
		cursor: not-allowed;
		opacity: 0.55;
	}

	button.ghost {
		background: transparent;
	}

	select {
		padding: 5px 8px;
		min-width: 220px;
	}

	.feed-toolbar {
		margin: 0;
		padding: 0;
		color: var(--muted);
		font-size: 0.82rem;
	}

	.feed-toolbar label {
		font-weight: 800;
		color: var(--text-ink);
	}

	.feed-description {
		flex: 1 1 280px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.view-controls {
		justify-content: flex-end;
	}

	.pane-collapse-controls {
		gap: 6px;
	}

	.pane-collapse-controls button {
		min-height: 28px;
		padding: 3px 8px;
		font-size: 0.74rem;
		white-space: nowrap;
	}

	.frontpage-error,
	.author-profile-card,
	.empty-state,
	.post-list,
	.load-more-row {
		max-width: 1120px;
		margin-left: auto;
		margin-right: auto;
	}

	.frontpage-error {
		margin-top: 10px;
		padding: 9px 11px;
		border: 1px solid color-mix(in srgb, var(--danger-text) 48%, var(--control-border));
		border-radius: 6px;
		background: color-mix(in srgb, var(--error-bg) 70%, var(--card-bg));
		color: var(--danger-text);
		font-weight: 700;
	}

	.empty-state {
		margin-top: 18px;
		padding: 20px 0;
		border-top: 1px solid color-mix(in srgb, var(--text-ink) 14%, transparent);
	}

	.empty-state h2 {
		margin: 0 0 8px;
		font-size: 1.45rem;
	}

	.empty-state p {
		margin: 0;
		color: var(--muted);
	}

	.frontpage-workspace {
		width: 100%;
		flex: 1 1 auto;
		min-height: 0;
		margin: 0;
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 6px;
		align-items: stretch;
	}

	.frontpage-workspace.with-viewer {
		grid-template-columns: minmax(260px, var(--feed-fr, 52fr)) 10px minmax(340px, var(--viewer-fr, 48fr));
	}

	.frontpage-workspace.with-viewer.feed-collapsed {
		grid-template-columns: 38px minmax(340px, 1fr);
	}

	.frontpage-workspace.with-viewer.treeviewer-collapsed {
		grid-template-columns: minmax(260px, 1fr) 38px;
	}

	.feed-section {
		min-width: 0;
		min-height: 0;
		display: flex;
		flex-direction: column;
		overflow: auto;
	}

	.feed-section.collapsed,
	.treeviewer-pane-rail {
		overflow: hidden;
	}

	.pane-rail-button {
		width: 100%;
		height: 100%;
		min-height: 0;
		display: grid;
		place-items: center;
		padding: 8px 4px;
		writing-mode: vertical-rl;
		text-orientation: mixed;
		border-radius: 7px;
		font-size: 0.74rem;
		letter-spacing: 0;
	}

	.treeviewer-pane {
		min-width: 0;
		min-height: 0;
		display: flex;
		flex-direction: column;
		overflow: hidden;
	}

	.treeviewer-pane.collapsed {
		display: none;
	}

	.treeviewer-pane-rail {
		min-width: 0;
		min-height: 0;
		display: flex;
	}

	.frontpage-workspace .post-list,
	.frontpage-workspace .author-profile-card,
	.frontpage-workspace .load-more-row {
		width: 100%;
		max-width: none;
	}

	.author-profile-card {
		display: flex;
		align-items: flex-start;
		gap: 10px;
		margin-top: 0;
		margin-bottom: 8px;
		padding: 9px 4px 10px;
		border-bottom: 1px solid color-mix(in srgb, var(--text-ink) 14%, transparent);
		color: var(--text-ink);
	}

	.author-profile-card .back-to-feed-button {
		flex: 0 0 auto;
		min-height: 28px;
		padding: 3px 8px;
		font-size: 0.74rem;
	}

	.author-profile-main {
		display: flex;
		align-items: flex-start;
		gap: 10px;
		min-width: 0;
	}

	.author-profile-main img {
		width: 48px;
		height: 48px;
		flex: 0 0 auto;
		border-radius: 50%;
		object-fit: cover;
	}

	.author-profile-card h2 {
		margin: 0;
		font-size: 1rem;
		font-weight: 750;
		line-height: 1.12;
	}

	.author-handle,
	.author-description {
		margin: 2px 0 0;
		color: var(--muted);
		font-size: 0.78rem;
		line-height: 1.25;
	}

	.author-description {
		max-width: 720px;
		white-space: pre-line;
	}

	.author-stats {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		margin-top: 6px;
		color: var(--muted);
		font-size: 0.72rem;
		font-weight: 800;
	}

	.post-list {
		list-style: none;
		padding: 0;
		margin-top: 8px;
		border-top: 1px solid color-mix(in srgb, var(--text-ink) 14%, transparent);
	}

	.post-row {
		position: relative;
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		padding: 6px 4px;
		border-bottom: 1px solid color-mix(in srgb, var(--text-ink) 11%, transparent);
		border-radius: 6px;
		cursor: pointer;
	}

	.row-hit-link {
		position: absolute;
		inset: 0;
		z-index: 1;
		border-radius: 6px;
	}

	.row-hit-link:focus-visible {
		outline: 2px solid color-mix(in srgb, var(--accent) 58%, transparent);
		outline-offset: 2px;
	}

	.post-row:hover {
		background: color-mix(in srgb, var(--accent) 7%, transparent);
	}

	.post-row.active {
		background: color-mix(in srgb, var(--accent) 10%, transparent);
		box-shadow: inset 3px 0 0 color-mix(in srgb, var(--accent) 72%, var(--text-ink));
	}

	.post-row.return-highlight {
		background: color-mix(in srgb, var(--accent) 16%, transparent);
		box-shadow:
			inset 3px 0 0 color-mix(in srgb, var(--accent) 78%, var(--text-ink)),
			0 0 0 2px color-mix(in srgb, var(--accent) 24%, transparent);
	}

	.post-main {
		position: relative;
		z-index: 2;
		pointer-events: none;
		min-width: 0;
	}

	.post-main :global(a),
	.post-main :global(button),
	.post-main :global(input),
	.post-main :global(select),
	.post-main :global(textarea),
	.post-main :global(video),
	.post-main :global(audio),
	.post-main :global([role='button']),
	.post-main :global([contenteditable='true']) {
		pointer-events: auto;
	}

	.post-title-line {
		display: flex;
		align-items: baseline;
		gap: 5px;
		min-width: 0;
	}

	.post-author-line {
		display: flex;
		align-items: center;
		gap: 6px;
		min-width: 0;
		margin-bottom: 2px;
		color: var(--text-ink);
		font-size: 0.9rem;
		font-weight: 800;
		line-height: 1.15;
	}

	.author-profile-button {
		width: fit-content;
		max-width: 100%;
		border: 0;
		background: transparent;
		padding: 0;
		text-align: left;
		cursor: pointer;
	}

	.author-profile-button:hover:not(:disabled) {
		background: transparent;
	}

	.author-profile-button:hover span,
	.author-profile-button:focus-visible span {
		color: var(--accent);
	}

	.author-profile-button:focus-visible {
		outline: 2px solid color-mix(in srgb, var(--accent) 46%, transparent);
		outline-offset: 2px;
	}

	.post-author-line img {
		width: 20px;
		height: 20px;
		flex: 0 0 auto;
		border-radius: 50%;
		object-fit: cover;
	}

	.post-author-line span,
	.post-author-line small {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.post-author-line small {
		color: var(--muted);
		font-size: 0.72rem;
		font-weight: 700;
	}

	.post-title {
		color: var(--text-ink);
		font-size: 0.86rem;
		font-weight: 650;
		line-height: 1.22;
		text-decoration: none;
		overflow-wrap: anywhere;
	}

	.post-title:hover {
		text-decoration: none;
	}

	.post-meta {
		color: var(--muted);
		font-size: 0.74rem;
	}

	.post-meta {
		display: flex;
		align-items: center;
		gap: 6px;
		flex-wrap: wrap;
		margin-top: 4px;
	}

	.post-meta a {
		color: color-mix(in srgb, var(--accent) 76%, var(--text-ink));
		font-weight: 750;
		text-decoration: none;
	}

	.post-meta a:hover {
		text-decoration: none;
	}

	.load-more-row {
		padding: 16px 0 38px;
		text-align: center;
	}

	.load-more-row button {
		min-width: 160px;
	}

	.workspace-splitter {
		align-self: stretch;
		width: 10px;
		min-height: 0;
		display: grid;
		place-items: center;
		border: 0;
		border-radius: 999px;
		background: transparent;
		cursor: col-resize;
		padding: 0;
		touch-action: none;
	}

	.workspace-splitter span {
		width: 3px;
		height: 84px;
		border-radius: 999px;
		background: color-mix(in srgb, var(--text-ink) 22%, transparent);
		box-shadow:
			0 0 0 1px color-mix(in srgb, var(--card-bg) 76%, transparent),
			0 6px 16px rgba(26, 35, 44, 0.12);
		transition:
			background 0.16s ease,
			height 0.16s ease,
			width 0.16s ease;
	}

	.workspace-splitter:hover span,
	.workspace-splitter:focus-visible span,
	.workspace-splitter.dragging span {
		width: 5px;
		height: 128px;
		background: color-mix(in srgb, var(--accent) 72%, var(--text-ink));
	}

	.workspace-splitter:focus-visible {
		outline: 2px solid color-mix(in srgb, var(--accent) 34%, transparent);
		outline-offset: 2px;
	}

	.treeviewer-sections {
		flex: 1 1 auto;
		min-width: 0;
		min-height: 0;
		display: flex;
		flex-direction: row;
		gap: 6px;
		overflow-x: auto;
		overflow-y: hidden;
		scroll-snap-type: x proximity;
		scrollbar-gutter: stable;
	}

	.treeviewer-sections.single {
		overflow: hidden;
	}

	.treeviewer-section {
		position: relative;
		flex: 0 0 clamp(420px, 92%, 760px);
		height: 100%;
		min-height: 0;
		display: flex;
		flex-direction: column;
		overflow: hidden;
		scroll-snap-align: start;
		border: 1px solid color-mix(in srgb, var(--text-ink) 16%, transparent);
		border-radius: 8px;
		background: var(--panel-bg-plain);
		box-shadow: var(--shadow-soft);
	}

	.treeviewer-sections.single .treeviewer-section {
		flex: 1 1 auto;
		min-height: 0;
	}

	.treeviewer-toolbar {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 10px;
		padding: 9px 10px;
		border-bottom: 1px solid color-mix(in srgb, var(--text-ink) 13%, transparent);
		background: color-mix(in srgb, var(--control-bg) 76%, var(--card-bg));
	}

	.treeviewer-toolbar div:first-child {
		min-width: 0;
	}

	.treeviewer-toolbar p,
	.treeviewer-toolbar h2,
	.treeviewer-toolbar span {
		margin: 0;
	}

	.treeviewer-toolbar p {
		color: var(--muted);
		font-size: 0.66rem;
		font-weight: 850;
		text-transform: uppercase;
	}

	.treeviewer-toolbar h2 {
		max-width: 100%;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: var(--text-ink);
		font-size: 0.78rem;
		font-weight: 500;
		line-height: 1.18;
	}

	.treeviewer-toolbar span {
		display: block;
		margin-top: 2px;
		color: var(--muted);
		font-size: 0.72rem;
	}

	.treeviewer-toolbar .treeviewer-author {
		margin-top: 1px;
		color: var(--text-ink);
		font-size: 0.82rem;
		font-weight: 700;
	}

	.treeviewer-actions {
		display: flex;
		flex: 0 0 auto;
		align-items: center;
		gap: 6px;
	}

	.treeviewer-actions a,
	.treeviewer-actions button {
		display: inline-flex;
		align-items: center;
		min-height: 28px;
		border: 1px solid var(--control-border);
		border-radius: 6px;
		background: var(--control-bg);
		color: var(--text-ink);
		padding: 0 9px;
		font-size: 0.78rem;
		font-weight: 800;
		text-decoration: none;
		white-space: nowrap;
	}

	.treeviewer-actions button {
		cursor: pointer;
	}

	.mobile-back-button {
		display: none;
	}

	.treeviewer-actions .panel-toggle.active {
		background: color-mix(in srgb, var(--accent) 12%, var(--control-bg));
		border-color: color-mix(in srgb, var(--accent) 34%, var(--control-border));
		color: var(--accent);
	}

	.treeviewer-actions a:hover,
	.treeviewer-actions button:hover {
		background: var(--control-bg-hover);
	}

	.treeviewer-section iframe {
		flex: 1 1 auto;
		width: 100%;
		min-height: 0;
		border: 0;
		background: var(--bg);
	}

	.session-panel :global(.font-picker) {
		font-size: 0.76rem;
		color: var(--muted);
	}

	.session-panel :global(.font-picker label) {
		font-size: 0.72rem;
	}

	.session-panel :global(.font-picker select) {
		padding: 2px 6px;
		font-size: 0.76rem;
	}

	.post-row :global(.post-embed-preview) {
		gap: 5px;
		margin-top: 5px;
		max-width: 720px;
	}

	.post-row :global(.post-embed-preview.compact) {
		gap: 5px;
		margin-top: 5px;
	}

	.post-row :global(.embed-images) {
		gap: 5px;
	}

	.post-row :global(.embed-image) {
		width: 72px;
		max-height: 72px;
		border-radius: 6px;
		box-shadow: none;
	}

	.post-row :global(.embed-link) {
		gap: 7px;
		padding: 6px;
		border-radius: 6px;
		background: color-mix(in srgb, var(--card-bg) 82%, transparent);
	}

	.post-row :global(.embed-link-thumb) {
		width: 42px;
		height: 42px;
		border-radius: 5px;
	}

	.post-row :global(.embed-link-copy) {
		gap: 2px;
	}

	.post-row :global(.embed-link-copy strong) {
		font-size: 0.78rem;
		line-height: 1.15;
	}

	.post-row :global(.embed-link-copy span) {
		font-size: 0.7rem;
		line-height: 1.2;
		display: -webkit-box;
		line-clamp: 2;
		-webkit-line-clamp: 2;
		-webkit-box-orient: vertical;
		overflow: hidden;
	}

	.post-row :global(.record-embed) {
		margin: 4px 0 2px;
		padding: 5px 7px;
		border-radius: 6px;
		background: color-mix(in srgb, var(--card-bg) 84%, transparent);
	}

	.post-row :global(.record-header) {
		gap: 6px;
		margin-bottom: 4px;
	}

	.post-row :global(.record-avatar) {
		width: 18px;
		height: 18px;
	}

	.post-row :global(.record-name) {
		font-size: 0.72rem;
	}

	.post-row :global(.record-handle),
	.post-row :global(.record-placeholder) {
		font-size: 0.68rem;
	}

	.post-row :global(.record-text) {
		font-size: 0.74rem;
		line-height: 1.22;
		display: -webkit-box;
		line-clamp: 2;
		-webkit-line-clamp: 2;
		-webkit-box-orient: vertical;
		overflow: hidden;
	}

	.post-row :global(.record-images) {
		gap: 5px;
		margin-top: 5px;
	}

	.post-row :global(.record-image) {
		max-width: 72px;
		max-height: 64px;
		border-radius: 5px;
	}

	.post-row :global(.embed-video video) {
		max-width: 240px;
		max-height: 160px;
		border-radius: 6px;
	}

	@media (max-width: 720px) {
		.frontpage-shell {
			height: auto;
			min-height: 100svh;
			overflow: visible;
		}

		.masthead {
			align-items: flex-start;
			flex-direction: column;
		}

		.session-panel {
			align-items: flex-start;
			width: 100%;
		}

		.post-title-line {
			align-items: flex-start;
			flex-direction: column;
			gap: 3px;
		}

		.frontpage-workspace {
			flex: 0 0 auto;
			min-height: 0;
			overflow: visible;
		}

		.feed-section {
			overflow: visible;
		}
	}

	@media (max-width: 980px) {
		.frontpage-workspace.with-viewer {
			grid-template-columns: 1fr;
			grid-auto-rows: auto;
			height: auto;
			overflow: visible;
		}

		.workspace-splitter {
			display: none;
		}

		.treeviewer-sections {
			overflow-x: auto;
			overflow-y: hidden;
		}

		.treeviewer-section {
			position: static;
			flex-basis: clamp(360px, 92vw, 760px);
			height: min(78vh, 760px);
			min-height: 460px;
		}
	}

	@media (max-width: 720px) {
		.frontpage-shell.mobile-thread-focused {
			padding: 0;
		}

		.frontpage-shell.mobile-thread-focused .frontpage-header,
		.frontpage-shell.mobile-thread-focused .feed-section,
		.frontpage-shell.mobile-thread-focused .workspace-splitter,
		.frontpage-shell.mobile-thread-focused .treeviewer-pane-rail {
			display: none;
		}

		.frontpage-shell.mobile-thread-focused .frontpage-workspace.with-viewer {
			display: block;
			height: auto;
			min-height: 100svh;
			overflow: visible;
		}

		.frontpage-shell.mobile-thread-focused .treeviewer-pane,
		.frontpage-shell.mobile-thread-focused .treeviewer-sections {
			min-height: 100svh;
			overflow: visible;
		}

		.frontpage-shell.mobile-thread-focused .treeviewer-sections {
			display: block;
		}

		.frontpage-shell.mobile-thread-focused .treeviewer-section {
			width: 100%;
			height: 100svh;
			min-height: 100svh;
			border: 0;
			border-radius: 0;
			box-shadow: none;
		}

		.frontpage-shell.mobile-thread-focused .treeviewer-toolbar {
			flex-direction: column;
			gap: 7px;
			padding: 8px;
		}

		.frontpage-shell.mobile-thread-focused .treeviewer-toolbar h2 {
			font-size: 0.74rem;
			font-weight: 500;
			line-height: 1.2;
			white-space: normal;
		}

		.frontpage-shell.mobile-thread-focused .treeviewer-actions {
			width: 100%;
			display: grid;
			grid-template-columns: repeat(3, minmax(0, 1fr));
			gap: 6px;
			overflow: visible;
			padding-bottom: 0;
		}

		.frontpage-shell.mobile-thread-focused .treeviewer-actions a,
		.frontpage-shell.mobile-thread-focused .treeviewer-actions button {
			justify-content: center;
			min-width: 0;
			padding: 0 6px;
			text-align: center;
			white-space: normal;
		}

		.frontpage-shell.mobile-thread-focused .mobile-back-button {
			display: inline-flex;
		}
	}
</style>
