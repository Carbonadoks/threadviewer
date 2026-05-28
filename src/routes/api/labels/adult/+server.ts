import type { RequestHandler } from './$types';

const BLUESKY_MODERATION_LABELER_DID = 'did:plc:ar7c4by46qjdydhdevvrndac';
const BLUESKY_APPVIEW_POSTS_URL = 'https://public.api.bsky.app/xrpc/app.bsky.feed.getPosts';
const BLUESKY_MODERATION_LABELER_URL =
	'https://mod.bsky.app/xrpc/com.atproto.label.queryLabels';
const MAX_URIS_PER_REQUEST = 25;
const ADULT_LABEL_VALUES = new Set([
	'porn',
	'nsfw',
	'sexual',
	'suggestive',
	'nudity',
	'graphic-media',
	'gore',
	'!hide',
	'!warn',
	'!takedown'
]);

type Label = {
	src?: string;
	uri?: string;
	val?: string;
	neg?: boolean;
	cts?: string;
};

type PostView = {
	uri?: string;
	labels?: Label[];
	author?: {
		did?: string;
		labels?: Label[];
	};
};

type AdultLabelResult = {
	blocked: boolean;
	labels: string[];
};

function isAtUri(value: unknown): value is string {
	return typeof value === 'string' && value.startsWith('at://') && value.length <= 512;
}

function applyLabel(labelsByUri: Map<string, Set<string>>, label: Label): void {
	if (!label.uri || !label.val) return;
	if (!ADULT_LABEL_VALUES.has(label.val)) return;
	let labels = labelsByUri.get(label.uri);
	if (!labels) {
		labels = new Set();
		labelsByUri.set(label.uri, labels);
	}
	if (label.neg) {
		labels.delete(label.val);
	} else {
		labels.add(label.val);
	}
}

function activeAdultValues(labels: Label[] | undefined): string[] {
	return [
		...new Set(
			(labels ?? [])
				.filter((label) => !label.neg && label.val && ADULT_LABEL_VALUES.has(label.val))
				.map((label) => label.val as string)
		)
	];
}

async function readAppViewLabels(
	fetch: typeof globalThis.fetch,
	uris: string[]
): Promise<{ labelsByUri: Map<string, Set<string>>; failed: boolean }> {
	const labelsByUri = new Map<string, Set<string>>();
	const url = new URL(BLUESKY_APPVIEW_POSTS_URL);
	for (const uri of uris) {
		url.searchParams.append('uris', uri);
	}

	const response = await fetch(url.toString(), {
		headers: {
			accept: 'application/json',
			'atproto-accept-labelers': BLUESKY_MODERATION_LABELER_DID
		}
	});

	if (!response.ok) return { labelsByUri, failed: true };

	const payload = (await response.json()) as { posts?: PostView[] };
	for (const post of payload.posts ?? []) {
		if (!post.uri) continue;
		const activeLabels = [
			...activeAdultValues(post.labels),
			...activeAdultValues(post.author?.labels)
		];
		if (activeLabels.length === 0) continue;
		let labels = labelsByUri.get(post.uri);
		if (!labels) {
			labels = new Set();
			labelsByUri.set(post.uri, labels);
		}
		for (const label of activeLabels) {
			labels.add(label);
		}
	}

	return { labelsByUri, failed: false };
}

export const POST: RequestHandler = async ({ request, fetch }) => {
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return Response.json({ results: {} });
	}

	const rawUris = Array.isArray((body as { uris?: unknown }).uris)
		? (body as { uris: unknown[] }).uris
		: [];
	const uris = [...new Set(rawUris.filter(isAtUri))].slice(0, MAX_URIS_PER_REQUEST);
	if (uris.length === 0) {
		return Response.json({ results: {} });
	}

	const appViewLabels = await readAppViewLabels(fetch, uris);

	const url = new URL(BLUESKY_MODERATION_LABELER_URL);
	for (const uri of uris) {
		url.searchParams.append('uriPatterns', uri);
	}
	url.searchParams.append('sources', BLUESKY_MODERATION_LABELER_DID);
	url.searchParams.set('limit', String(Math.max(uris.length * 8, 25)));

	const response = await fetch(url.toString(), {
		headers: {
			accept: 'application/json'
		}
	});

	if (!response.ok) {
		if (appViewLabels.failed) {
			return Response.json(
				{
					error: 'LabelLookupFailed',
					message: `Adult label lookup failed with ${response.status}.`
				},
				{ status: 502 }
			);
		}

		const results: Record<string, AdultLabelResult> = {};
		for (const uri of uris) {
			const activeLabels = [...(appViewLabels.labelsByUri.get(uri) ?? [])];
			results[uri] = {
				blocked: activeLabels.length > 0,
				labels: activeLabels
			};
		}
		return Response.json({ results, source: 'appview' });
	}

	const payload = (await response.json()) as { labels?: Label[] };
	const labels = [...(payload.labels ?? [])].sort((a, b) =>
		(a.cts ?? '').localeCompare(b.cts ?? '')
	);
	const labelsByUri = new Map<string, Set<string>>();
	for (const [uri, labels] of appViewLabels.labelsByUri.entries()) {
		labelsByUri.set(uri, new Set(labels));
	}
	for (const label of labels) {
		applyLabel(labelsByUri, label);
	}

	const results: Record<string, AdultLabelResult> = {};
	for (const uri of uris) {
		const activeLabels = [...(labelsByUri.get(uri) ?? [])];
		results[uri] = {
			blocked: activeLabels.length > 0,
			labels: activeLabels
		};
	}

	return Response.json({ results });
};
