import type { ThreadPost } from '$lib/types';

export interface CachedThreadEntry {
	url: string;
	rootPost: ThreadPost;
	rootUri: string;
	depth: number;
	isTruncated?: boolean;
	savedAt: number;
}

const DB_NAME = 'treeviewer-thread-cache';
const DB_VERSION = 1;
const STORE_NAME = 'threads';

function openDb(): Promise<IDBDatabase | null> {
	if (typeof indexedDB === 'undefined') return Promise.resolve(null);

	return new Promise((resolve) => {
		try {
			const request = indexedDB.open(DB_NAME, DB_VERSION);
			request.onupgradeneeded = () => {
				const db = request.result;
				if (!db.objectStoreNames.contains(STORE_NAME)) {
					db.createObjectStore(STORE_NAME, { keyPath: 'url' });
				}
			};
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => resolve(null);
			request.onblocked = () => resolve(null);
		} catch {
			resolve(null);
		}
	});
}

async function withStore<T>(
	mode: IDBTransactionMode,
	run: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T | null> {
	const db = await openDb();
	if (!db) return null;

	return new Promise((resolve) => {
		try {
			const tx = db.transaction(STORE_NAME, mode);
			const request = run(tx.objectStore(STORE_NAME));
			request.onsuccess = () => resolve(request.result ?? null);
			request.onerror = () => resolve(null);
			tx.oncomplete = () => db.close();
			tx.onabort = () => {
				db.close();
				resolve(null);
			};
		} catch {
			db.close();
			resolve(null);
		}
	});
}

export async function readCachedThread(url: string): Promise<CachedThreadEntry | null> {
	if (!url) return null;
	const entry = await withStore<CachedThreadEntry>('readonly', (store) => store.get(url));
	if (!entry || !entry.rootPost || typeof entry.rootUri !== 'string') return null;
	return entry;
}

export async function writeCachedThread(
	entry: Omit<CachedThreadEntry, 'savedAt'>
): Promise<void> {
	if (!entry.url) return;
	await withStore('readwrite', (store) => store.put({ ...entry, savedAt: Date.now() }));
}

/** Drop cached threads whose URL is no longer in the recent-threads list. */
export async function pruneThreadCache(keepUrls: string[]): Promise<void> {
	const keep = new Set(keepUrls);
	const allKeys = await withStore<IDBValidKey[]>('readonly', (store) => store.getAllKeys());
	if (!allKeys) return;

	for (const key of allKeys) {
		if (typeof key === 'string' && !keep.has(key)) {
			await withStore('readwrite', (store) => store.delete(key));
		}
	}
}
