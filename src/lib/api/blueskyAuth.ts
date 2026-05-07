import {
	Agent,
	AppBskyActorDefs,
	type AppBskyFeedDefs
} from '@atproto/api';
import {
	BrowserOAuthClient,
	type OAuthSession
} from '@atproto/oauth-client-browser';
import {
	buildAtprotoLoopbackClientMetadata,
	type OAuthRedirectUri
} from '@atproto/oauth-types';
import type { ProfileInfo } from '$lib/api/bluesky';
import {
	BLUESKY_ENTRYWAY_URL,
	BLUESKY_HANDLE_RESOLVER_URL,
	BLUESKY_OAUTH_REDIRECT_ROUTES,
	BLUESKY_OAUTH_SCOPE,
	buildBlueskyOAuthClientMetadata
} from '$lib/constants/blueskyOAuth';

export const FOLLOWING_FEED_ID = 'following';

type FeedState = {
	pinned: boolean;
	saved: boolean;
};

export type FollowingFeedOption = {
	id: typeof FOLLOWING_FEED_ID;
	kind: 'timeline';
	label: string;
	description: string;
	pinned: true;
	saved: true;
	avatar?: string;
	creatorHandle?: string;
};

export type CustomFeedOption = {
	id: string;
	kind: 'feed';
	uri: string;
	label: string;
	description: string;
	pinned: boolean;
	saved: boolean;
	avatar?: string;
	creatorHandle?: string;
};

export type PersonalFeedOption = FollowingFeedOption | CustomFeedOption;

export type AuthenticatedBlueskyContext = {
	client: BrowserOAuthClient;
	session: OAuthSession;
	agent: Agent;
	profile: ProfileInfo;
};

let oauthClientPromise: Promise<BrowserOAuthClient> | null = null;

function isMissingScopeError(error: unknown): boolean {
	return String((error as { message?: string } | null | undefined)?.message ?? '').includes(
		'Missing required scope'
	);
}

function isLoopbackHost(hostname: string): boolean {
	return (
		hostname === 'localhost' ||
		hostname === '127.0.0.1' ||
		hostname === '::1' ||
		hostname === '[::1]'
	);
}

function buildLoopbackOrigin(): string {
	const hostname = window.location.hostname === 'localhost' ? '127.0.0.1' : window.location.hostname;
	const port = window.location.port ? `:${window.location.port}` : '';
	return `${window.location.protocol}//${hostname}${port}`;
}

function createOAuthClient(): BrowserOAuthClient {
	const options = {
		handleResolver: BLUESKY_HANDLE_RESOLVER_URL
	};

	if (isLoopbackHost(window.location.hostname)) {
		const origin = buildLoopbackOrigin();
		return new BrowserOAuthClient({
			...options,
			clientMetadata: buildAtprotoLoopbackClientMetadata({
				scope: BLUESKY_OAUTH_SCOPE,
				redirect_uris: BLUESKY_OAUTH_REDIRECT_ROUTES.map((route) => `${origin}${route}`) as [
					string,
					...string[]
				]
			})
		});
	}

	return new BrowserOAuthClient({
		...options,
		clientMetadata: buildBlueskyOAuthClientMetadata(window.location.origin)
	});
}

async function getOAuthClient(): Promise<BrowserOAuthClient> {
	if (!oauthClientPromise) {
		oauthClientPromise = Promise.resolve().then(() => createOAuthClient());
	}

	return oauthClientPromise;
}

async function getAuthenticatedProfile(agent: Agent, actor: string): Promise<ProfileInfo> {
	const res = await agent.app.bsky.actor.getProfile({ actor });
	return {
		did: res.data.did,
		handle: res.data.handle,
		displayName: res.data.displayName,
		avatar: res.data.avatar,
		postsCount: res.data.postsCount ?? 0
	};
}

async function buildAuthenticatedContext(
	client: BrowserOAuthClient,
	session: OAuthSession
): Promise<AuthenticatedBlueskyContext> {
	const agent = new Agent(session);
	const profile = await getAuthenticatedProfile(agent, session.did);
	return {
		client,
		session,
		agent,
		profile
	};
}

function buildFollowingFeedOption(): FollowingFeedOption {
	return {
		id: FOLLOWING_FEED_ID,
		kind: 'timeline',
		label: 'Following',
		description: 'Your authenticated Following timeline.',
		pinned: true,
		saved: true
	};
}

function mergeFeedState(map: Map<string, FeedState>, uri: string | undefined, next: FeedState) {
	if (!uri) return;
	const current = map.get(uri) ?? { pinned: false, saved: false };
	map.set(uri, {
		pinned: current.pinned || next.pinned,
		saved: current.saved || next.saved
	});
}

function isCustomFeedUri(uri: string | undefined): uri is string {
	return Boolean(uri?.includes('/app.bsky.feed.generator/'));
}

function collectSavedFeedState(preferences: AppBskyActorDefs.Preferences): Map<string, FeedState> {
	const feedState = new Map<string, FeedState>();

	for (const preference of preferences) {
		if (AppBskyActorDefs.isSavedFeedsPrefV2(preference)) {
			for (const item of preference.items ?? []) {
				if (item.type !== 'feed' || !isCustomFeedUri(item.value)) continue;
				mergeFeedState(feedState, item.value, {
					pinned: Boolean(item.pinned),
					saved: true
				});
			}
			continue;
		}

		if (AppBskyActorDefs.isSavedFeedsPref(preference)) {
			for (const uri of preference.saved ?? []) {
				if (!isCustomFeedUri(uri)) continue;
				mergeFeedState(feedState, uri, {
					pinned: false,
					saved: true
				});
			}

			for (const uri of preference.pinned ?? []) {
				if (!isCustomFeedUri(uri)) continue;
				mergeFeedState(feedState, uri, {
					pinned: true,
					saved: true
				});
			}
		}
	}

	return feedState;
}

async function fetchFeedGeneratorsByUri(
	agent: Agent,
	uris: string[]
): Promise<Map<string, AppBskyFeedDefs.GeneratorView>> {
	const batchSize = 25;
	const batches: string[][] = [];
	for (let index = 0; index < uris.length; index += batchSize) {
		batches.push(uris.slice(index, index + batchSize));
	}

	const results = await Promise.allSettled(
		batches.map((feeds) => agent.app.bsky.feed.getFeedGenerators({ feeds }))
	);

	const generators = new Map<string, AppBskyFeedDefs.GeneratorView>();
	for (const result of results) {
		if (result.status !== 'fulfilled') continue;
		for (const feed of result.value.data.feeds) {
			generators.set(feed.uri, feed);
		}
	}

	return generators;
}

function fallbackFeedLabel(uri: string): string {
	const fallback = uri.split('/').pop() ?? 'custom-feed';
	return fallback
		.replace(/[-_]+/g, ' ')
		.trim()
		.replace(/\b\w/g, (match) => match.toUpperCase());
}

function buildCustomFeedOption(
	uri: string,
	state: FeedState,
	generator?: AppBskyFeedDefs.GeneratorView
): CustomFeedOption {
	const creatorHandle = generator?.creator?.handle;
	return {
		id: uri,
		kind: 'feed',
		uri,
		label: generator?.displayName || fallbackFeedLabel(uri),
		description:
			generator?.description ||
			(creatorHandle ? `Custom feed by @${creatorHandle}.` : 'Saved custom feed.'),
		pinned: state.pinned,
		saved: state.saved,
		avatar: generator?.avatar || generator?.creator?.avatar,
		creatorHandle
	};
}

export async function initAuthenticatedBlueskyClient(): Promise<{
	client: BrowserOAuthClient;
	context: AuthenticatedBlueskyContext | null;
}> {
	const client = await getOAuthClient();
	const result = await client.init();
	if (!result) {
		return {
			client,
			context: null
		};
	}

	try {
		return {
			client,
			context: await buildAuthenticatedContext(client, result.session)
		};
	} catch (error) {
		if (isMissingScopeError(error)) {
			await client.revoke(result.session.sub).catch(() => undefined);
		}
		throw error;
	}
}

export async function connectBlueskyWithPopup(): Promise<AuthenticatedBlueskyContext> {
	const client = await getOAuthClient();
	const session = await client.signInPopup(BLUESKY_ENTRYWAY_URL);
	try {
		return await buildAuthenticatedContext(client, session);
	} catch (error) {
		if (isMissingScopeError(error)) {
			await client.revoke(session.sub).catch(() => undefined);
		}
		throw error;
	}
}

export async function connectBlueskyWithRedirect(redirectUri?: string): Promise<never> {
	const client = await getOAuthClient();
	await client.signInRedirect(
		BLUESKY_ENTRYWAY_URL,
		redirectUri ? { redirect_uri: redirectUri as OAuthRedirectUri } : undefined
	);
	throw new Error('User navigated back from Bluesky sign-in.');
}

export async function disconnectBluesky(sub: string): Promise<void> {
	const client = await getOAuthClient();
	await client.revoke(sub);
}

export async function resolvePersonalFeeds(agent: Agent): Promise<PersonalFeedOption[]> {
	const following = buildFollowingFeedOption();

	let preferences: AppBskyActorDefs.Preferences;
	try {
		preferences = (await agent.app.bsky.actor.getPreferences()).data.preferences;
	} catch {
		return [following];
	}

	const feedState = collectSavedFeedState(preferences);
	if (feedState.size === 0) {
		return [following];
	}

	const uris = [...feedState.keys()];
	const generators = await fetchFeedGeneratorsByUri(agent, uris);
	const customFeeds = uris
		.map((uri) => buildCustomFeedOption(uri, feedState.get(uri)!, generators.get(uri)))
		.sort((left, right) => {
			if (left.pinned !== right.pinned) {
				return left.pinned ? -1 : 1;
			}
			return left.label.localeCompare(right.label);
		});

	return [following, ...customFeeds];
}

export async function fetchPersonalFeedPosts(
	agent: Agent,
	feed: PersonalFeedOption,
	cursor?: string
): Promise<{ posts: AppBskyFeedDefs.FeedViewPost[]; cursor?: string }> {
	if (feed.kind === 'timeline') {
		const res = await agent.app.bsky.feed.getTimeline({
			limit: 100,
			cursor
		});
		return {
			posts: res.data.feed,
			cursor: res.data.cursor
		};
	}

	const res = await agent.app.bsky.feed.getFeed({
		feed: feed.uri,
		limit: 100,
		cursor
	});
	return {
		posts: res.data.feed,
		cursor: res.data.cursor
	};
}
