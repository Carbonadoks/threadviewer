import { json } from '@sveltejs/kit';
import { buildBlueskyOAuthClientMetadata } from '$lib/constants/blueskyOAuth';

function resolvePublicOrigin(url: URL, request: Request): string {
	const host = request.headers.get('host') ?? url.host;
	const forwardedProto = request.headers.get('x-forwarded-proto');
	const isLocalHost =
		host.startsWith('localhost') ||
		host.startsWith('127.0.0.1') ||
		host.startsWith('[::1]');
	const protocol = forwardedProto || (isLocalHost ? url.protocol.replace(/:$/, '') : 'https');

	return `${protocol}://${host}`;
}

export function GET({ url, request }) {
	return json(
		buildBlueskyOAuthClientMetadata(
			resolvePublicOrigin(url, request),
			'/oauth/bsky-client-metadata-v4.json'
		)
	);
}
