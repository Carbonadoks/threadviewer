import { normalizeBskyPostUrl } from '$lib/utils/viewerLinks';

export type RecentThreadEntry = {
	url: string;
	title?: string;
	authorHandle?: string;
	addedAt: number;
};

const RECENT_THREADS_KEY = 'frontpage-recent-treeviewer-threads';
const MAX_RECENT_THREADS = 10;

function normalizeEntry(entry: unknown): RecentThreadEntry | null {
	if (!entry || typeof entry !== 'object') return null;
	const candidate = entry as Partial<RecentThreadEntry>;
	const url = normalizeBskyPostUrl(String(candidate.url ?? ''));
	if (!url) return null;

	return {
		url,
		title: typeof candidate.title === 'string' ? candidate.title : undefined,
		authorHandle: typeof candidate.authorHandle === 'string' ? candidate.authorHandle : undefined,
		addedAt: Number.isFinite(candidate.addedAt) ? Number(candidate.addedAt) : Date.now()
	};
}

export function readRecentThreads(storage: Storage | null | undefined): RecentThreadEntry[] {
	if (!storage) return [];
	try {
		const raw = JSON.parse(storage.getItem(RECENT_THREADS_KEY) ?? '[]');
		if (!Array.isArray(raw)) return [];
		return raw.map(normalizeEntry).filter((entry): entry is RecentThreadEntry => Boolean(entry));
	} catch {
		return [];
	}
}

export function writeRecentThreads(
	storage: Storage | null | undefined,
	entries: RecentThreadEntry[]
) {
	if (!storage) return;
	const deduped: RecentThreadEntry[] = [];
	const seen = new Set<string>();

	for (const entry of entries) {
		const normalized = normalizeEntry(entry);
		if (!normalized || seen.has(normalized.url)) continue;
		seen.add(normalized.url);
		deduped.push(normalized);
		if (deduped.length >= MAX_RECENT_THREADS) break;
	}

	storage.setItem(RECENT_THREADS_KEY, JSON.stringify(deduped));
}

export function rememberRecentThread(
	storage: Storage | null | undefined,
	entry: Omit<RecentThreadEntry, 'addedAt'> & { addedAt?: number }
): RecentThreadEntry[] {
	const normalized = normalizeEntry({
		...entry,
		addedAt: entry.addedAt ?? Date.now()
	});
	if (!normalized) return readRecentThreads(storage);

	const next = [
		normalized,
		...readRecentThreads(storage).filter((candidate) => candidate.url !== normalized.url)
	];
	writeRecentThreads(storage, next);
	return readRecentThreads(storage);
}

export function getAdjacentRecentThreads(
	entries: RecentThreadEntry[],
	currentUrl: string | null | undefined
): { previous: RecentThreadEntry | null; next: RecentThreadEntry | null; index: number } {
	const normalizedUrl = normalizeBskyPostUrl(currentUrl ?? '');
	const index = normalizedUrl ? entries.findIndex((entry) => entry.url === normalizedUrl) : -1;
	return {
		previous: index >= 0 ? entries[index + 1] ?? null : entries[0] ?? null,
		next: index > 0 ? entries[index - 1] ?? null : null,
		index
	};
}
