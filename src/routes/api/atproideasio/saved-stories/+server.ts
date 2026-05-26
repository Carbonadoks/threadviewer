import type { RequestHandler } from './$types';
import {
	emptyAtproideasioSavedStories,
	readAtproideasioSavedStories,
	retagAtproideasioSnapshot,
	writeAtproideasioSavedStories
} from '$lib/server/atproideasio';
import type {
	AtproideasioIdeaClaim,
	AtproideasioSavedIdea,
	AtproideasioSavedStories
} from '$lib/types/atproideasio';

type SavedStoriesAction = 'claim' | 'release';

interface SavedStoriesActionBody {
	action?: SavedStoriesAction;
	id?: string;
	rootUri?: string;
	claimedBy?: string;
}

function normalizeIdeaClaim(value: unknown): AtproideasioIdeaClaim | undefined {
	if (!value || typeof value !== 'object') return undefined;
	const claim = value as Partial<AtproideasioIdeaClaim>;
	const claimedBy = typeof claim.claimedBy === 'string' ? claim.claimedBy.trim() : '';
	if (!claimedBy) return undefined;
	return {
		claimedBy,
		claimedAt:
			typeof claim.claimedAt === 'string' && claim.claimedAt ? claim.claimedAt : new Date().toISOString()
	};
}

function normalizeSavedIdea(value: AtproideasioSavedIdea): AtproideasioSavedIdea {
	return {
		...value,
		claim: normalizeIdeaClaim(value.claim)
	};
}

function normalizeStoriesBody(value: unknown): AtproideasioSavedStories {
	const fallback = emptyAtproideasioSavedStories();
	if (!value || typeof value !== 'object') return fallback;
	const body = value as Partial<AtproideasioSavedStories>;
	const stories = Array.isArray(body.stories)
		? (body.stories
				.filter((story) => story && typeof story === 'object')
				.map((story) => normalizeSavedIdea(story as AtproideasioSavedIdea)) as AtproideasioSavedIdea[])
		: [];
	return {
		version: 1,
		updatedAt: new Date().toISOString(),
		stories
	};
}

function matchSavedIdea(story: AtproideasioSavedIdea, id?: string, rootUri?: string): boolean {
	return Boolean((id && story.id === id) || (rootUri && story.rootUri === rootUri));
}

function normalizeActionBody(value: unknown): SavedStoriesActionBody {
	if (!value || typeof value !== 'object') return {};
	const body = value as SavedStoriesActionBody;
	return {
		action: body.action === 'release' ? 'release' : body.action === 'claim' ? 'claim' : undefined,
		id: typeof body.id === 'string' ? body.id.trim() : undefined,
		rootUri: typeof body.rootUri === 'string' ? body.rootUri.trim() : undefined,
		claimedBy: typeof body.claimedBy === 'string' ? body.claimedBy.trim() : undefined
	};
}

export const GET: RequestHandler = async ({ platform }) => {
	const bucket = platform?.env?.POST_CACHE;
	const stories = await readAtproideasioSavedStories(bucket);
	return Response.json(stories, {
		headers: {
			'Cache-Control': 'no-store'
		}
	});
};

export const POST: RequestHandler = async ({ request, platform }) => {
	const bucket = platform?.env?.POST_CACHE;
	if (!bucket) {
		return Response.json({ message: 'POST_CACHE binding is unavailable.' }, { status: 500 });
	}

	const body = normalizeActionBody(await request.json().catch(() => null));
	if (!body.action) {
		return Response.json({ message: 'Action must be claim or release.' }, { status: 400 });
	}
	if (!body.id && !body.rootUri) {
		return Response.json({ message: 'Claim action requires an idea id or rootUri.' }, { status: 400 });
	}
	if (body.action === 'claim' && !body.claimedBy) {
		return Response.json({ message: 'Claim action requires claimedBy.' }, { status: 400 });
	}

	const current = await readAtproideasioSavedStories(bucket);
	const now = new Date().toISOString();
	let matched = false;
	const stories = current.stories.map((story) => {
		if (!matchSavedIdea(story, body.id, body.rootUri)) return story;
		matched = true;
		if (body.action === 'release') {
			const { claim: _claim, ...rest } = story;
			return {
				...rest,
				updatedAt: now
			};
		}
		return {
			...story,
			claim: {
				claimedBy: body.claimedBy ?? '',
				claimedAt: now
			},
			updatedAt: now
		};
	});

	if (!matched) {
		return Response.json({ message: 'Saved idea was not found.' }, { status: 404 });
	}

	const payload: AtproideasioSavedStories = {
		version: 1,
		updatedAt: now,
		stories
	};
	await writeAtproideasioSavedStories(bucket, payload);
	return Response.json(payload, {
		headers: {
			'Cache-Control': 'no-store'
		}
	});
};

export const PUT: RequestHandler = async ({ request, platform }) => {
	const bucket = platform?.env?.POST_CACHE;
	if (!bucket) {
		return Response.json({ message: 'POST_CACHE binding is unavailable.' }, { status: 500 });
	}

	const payload = normalizeStoriesBody(await request.json().catch(() => null));
	await writeAtproideasioSavedStories(bucket, payload);
	await retagAtproideasioSnapshot(bucket);
	return Response.json(payload, {
		headers: {
			'Cache-Control': 'no-store'
		}
	});
};
