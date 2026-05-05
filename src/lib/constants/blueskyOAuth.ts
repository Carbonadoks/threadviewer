import type { OAuthClientMetadataInput } from '@atproto/oauth-client-browser';

export const MATRIX_FEED_ROUTE = '/matrix-feed';
export const BLUESKY_OAUTH_REDIRECT_ROUTES = [MATRIX_FEED_ROUTE, '/frontpage', '/town'] as const;
export const BLUESKY_OAUTH_CLIENT_METADATA_PATH = '/oauth/bsky-client-metadata-v7.json';
export const BLUESKY_ENTRYWAY_URL = 'https://bsky.social';
export const BLUESKY_HANDLE_RESOLVER_URL = 'https://bsky.social';
export const BLUESKY_OAUTH_CLIENT_INFO_PATH = '/oauth/';
export const BLUESKY_OAUTH_LOGO_PATH = '/oauth-client-logo.svg';
const BLUESKY_APPVIEW_AUDIENCE = 'did:web:api.bsky.app#bsky_appview';

const BLUESKY_OAUTH_SCOPES = [
	'atproto',
	`rpc:app.bsky.actor.getProfile?aud=${BLUESKY_APPVIEW_AUDIENCE}`,
	`rpc:app.bsky.actor.getPreferences?aud=${BLUESKY_APPVIEW_AUDIENCE}`,
	`rpc:app.bsky.feed.getFeedGenerators?aud=${BLUESKY_APPVIEW_AUDIENCE}`,
	`rpc:app.bsky.feed.getTimeline?aud=${BLUESKY_APPVIEW_AUDIENCE}`,
	`rpc:app.bsky.feed.getFeed?aud=${BLUESKY_APPVIEW_AUDIENCE}`,
	`rpc:app.bsky.feed.getFeedSkeleton?aud=${BLUESKY_APPVIEW_AUDIENCE}`
];

export const BLUESKY_OAUTH_SCOPE = BLUESKY_OAUTH_SCOPES.join(' ');

export function buildBlueskyOAuthClientId(
	origin: string,
	metadataPath: string = BLUESKY_OAUTH_CLIENT_METADATA_PATH
): string {
	return `${origin}${metadataPath}`;
}

export function buildBlueskyOAuthRedirectUri(origin: string): string {
	return `${origin}${MATRIX_FEED_ROUTE}`;
}

export function buildBlueskyOAuthRedirectUris(origin: string): string[] {
	return BLUESKY_OAUTH_REDIRECT_ROUTES.map((route) => `${origin}${route}`);
}

export function buildBlueskyOAuthClientUri(origin: string): string {
	return `${origin}${BLUESKY_OAUTH_CLIENT_INFO_PATH}`;
}

export function buildBlueskyOAuthLogoUri(origin: string): string {
	return `${origin}${BLUESKY_OAUTH_LOGO_PATH}`;
}

export function buildBlueskyOAuthClientMetadata(
	origin: string,
	metadataPath: string = BLUESKY_OAUTH_CLIENT_METADATA_PATH
): OAuthClientMetadataInput {
	return {
		client_id: buildBlueskyOAuthClientId(origin, metadataPath),
		client_name: 'ATProto Codex',
		client_uri: buildBlueskyOAuthClientUri(origin),
		logo_uri: buildBlueskyOAuthLogoUri(origin),
		redirect_uris: buildBlueskyOAuthRedirectUris(origin),
		scope: BLUESKY_OAUTH_SCOPE,
		grant_types: ['authorization_code', 'refresh_token'],
		response_types: ['code'],
		token_endpoint_auth_method: 'none',
		application_type: 'web',
		dpop_bound_access_tokens: true
	};
}
