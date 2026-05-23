export const REPO_CAR_INDEX_KEY = 'threadviewer:repo-car:index';
export const REPO_CAR_VALUE_PREFIX = 'threadviewer:repo-car:';
const REPO_CAR_DB_NAME = 'threadviewer-repo-cars';
const REPO_CAR_DB_VERSION = 1;
const REPO_CAR_STORE_NAME = 'cars';

export type SavedRepoCarSource = 'pds' | 'relay';
export type SavedRepoCarStorage = 'indexeddb' | 'localstorage';
export type SavedRepoCarEncoding = 'uint8array' | 'base64';

export interface SavedRepoCarEntry {
	id: string;
	key: string;
	did: string;
	handle: string | null;
	displayName: string | null;
	avatar: string | null;
	collection: string | null;
	source: SavedRepoCarSource;
	savedAt: string;
	downloadedBytes: number;
	totalBytes: number;
	encodedBytes: number;
	storage: SavedRepoCarStorage;
	encoding: SavedRepoCarEncoding;
	mediaType: 'application/vnd.ipld.car';
}

export interface SavedRepoCarValue extends SavedRepoCarEntry {
	dataBase64?: string;
}

export interface SaveRepoCarInput {
	carBytes: Uint8Array;
	did: string;
	handle?: string | null;
	displayName?: string | null;
	avatar?: string | null;
	collection?: string | null;
	source: SavedRepoCarSource;
	downloadedBytes: number;
	totalBytes: number;
	savedAt?: string;
}

function normalizeCollection(collection: string | null | undefined): string | null {
	const trimmed = collection?.trim() ?? '';
	return trimmed.length > 0 ? trimmed : null;
}

export function buildRepoCarStorageId(did: string, collection?: string | null): string {
	const scope = normalizeCollection(collection) ?? 'repo';
	return encodeURIComponent(`${did}::${scope}`);
}

export function buildRepoCarStorageKey(did: string, collection?: string | null): string {
	return `${REPO_CAR_VALUE_PREFIX}${buildRepoCarStorageId(did, collection)}`;
}

function openRepoCarDb(): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const request = indexedDB.open(REPO_CAR_DB_NAME, REPO_CAR_DB_VERSION);
		request.onupgradeneeded = () => {
			const db = request.result;
			if (!db.objectStoreNames.contains(REPO_CAR_STORE_NAME)) {
				db.createObjectStore(REPO_CAR_STORE_NAME, { keyPath: 'id' });
			}
		};
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error ?? new Error('Could not open repo storage.'));
	});
}

function withRepoCarStore<T>(
	mode: IDBTransactionMode,
	callback: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T> {
	return openRepoCarDb().then(
		(db) =>
			new Promise<T>((resolve, reject) => {
				const transaction = db.transaction(REPO_CAR_STORE_NAME, mode);
				const request = callback(transaction.objectStore(REPO_CAR_STORE_NAME));
				request.onsuccess = () => resolve(request.result);
				request.onerror = () => reject(request.error ?? new Error('Repo storage request failed.'));
				transaction.oncomplete = () => db.close();
				transaction.onabort = () => {
					db.close();
					reject(transaction.error ?? new Error('Repo storage transaction was aborted.'));
				};
			})
	);
}

function writeRepoCarBytes(id: string, bytes: Uint8Array, entry: SavedRepoCarEntry): Promise<void> {
	return withRepoCarStore('readwrite', (store) =>
		store.put({
			id,
			bytes,
			entry,
			updatedAt: entry.savedAt
		})
	).then(() => {});
}

function readRepoCarRecord(id: string): Promise<{ bytes?: Uint8Array; entry?: SavedRepoCarEntry } | undefined> {
	return withRepoCarStore('readonly', (store) => store.get(id));
}

function deleteRepoCarBytes(id: string): Promise<void> {
	return withRepoCarStore('readwrite', (store) => store.delete(id)).then(() => {});
}

function base64ToBytes(value: string): Uint8Array {
	const binary = atob(value);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index += 1) {
		bytes[index] = binary.charCodeAt(index);
	}
	return bytes;
}

function sanitizeEntry(value: unknown): SavedRepoCarEntry | null {
	if (!value || typeof value !== 'object') return null;
	const entry = value as Partial<SavedRepoCarEntry>;
	if (
		typeof entry.id !== 'string' ||
		typeof entry.key !== 'string' ||
		typeof entry.did !== 'string' ||
		typeof entry.savedAt !== 'string'
	) {
		return null;
	}

	return {
		id: entry.id,
		key: entry.key,
		did: entry.did,
		handle: typeof entry.handle === 'string' ? entry.handle : null,
		displayName: typeof entry.displayName === 'string' ? entry.displayName : null,
		avatar: typeof entry.avatar === 'string' ? entry.avatar : null,
		collection: typeof entry.collection === 'string' ? entry.collection : null,
		source: entry.source === 'pds' ? 'pds' : 'relay',
		savedAt: entry.savedAt,
		downloadedBytes: Number.isFinite(Number(entry.downloadedBytes))
			? Math.max(0, Math.round(Number(entry.downloadedBytes)))
			: 0,
		totalBytes: Number.isFinite(Number(entry.totalBytes))
			? Math.max(0, Math.round(Number(entry.totalBytes)))
			: 0,
		encodedBytes: Number.isFinite(Number(entry.encodedBytes))
			? Math.max(0, Math.round(Number(entry.encodedBytes)))
			: 0,
		storage: entry.storage === 'localstorage' ? 'localstorage' : 'indexeddb',
		encoding: entry.encoding === 'base64' ? 'base64' : 'uint8array',
		mediaType: 'application/vnd.ipld.car'
	};
}

export function readSavedRepoCarIndex(storage: Storage = localStorage): SavedRepoCarEntry[] {
	const raw = storage.getItem(REPO_CAR_INDEX_KEY);
	if (!raw) return [];

	try {
		const parsed = JSON.parse(raw);
		const entries = Array.isArray(parsed) ? parsed : parsed?.entries;
		if (!Array.isArray(entries)) return [];
		return entries
			.map(sanitizeEntry)
			.filter((entry): entry is SavedRepoCarEntry => entry !== null)
			.sort((a, b) => b.savedAt.localeCompare(a.savedAt));
	} catch {
		return [];
	}
}

export function writeSavedRepoCarIndex(
	entries: SavedRepoCarEntry[],
	storage: Storage = localStorage
): void {
	storage.setItem(REPO_CAR_INDEX_KEY, JSON.stringify({ version: 1, entries }));
}

export function readSavedRepoCarEntry(
	did: string,
	collection?: string | null,
	storage: Storage = localStorage
): SavedRepoCarEntry | null {
	const id = buildRepoCarStorageId(did, collection);
	return readSavedRepoCarIndex(storage).find((entry) => entry.id === id) ?? null;
}

export async function readSavedRepoCarBytes(
	entry: SavedRepoCarEntry,
	storage: Storage = localStorage
): Promise<Uint8Array | null> {
	if (entry.storage === 'indexeddb') {
		const record = await readRepoCarRecord(entry.id);
		if (record?.bytes instanceof Uint8Array) return record.bytes;
		if (record?.bytes) return new Uint8Array(record.bytes);
	}

	const raw = storage.getItem(entry.key);
	if (!raw) return null;
	try {
		const value = JSON.parse(raw) as Partial<SavedRepoCarValue>;
		if (typeof value.dataBase64 === 'string') return base64ToBytes(value.dataBase64);
	} catch {}
	return null;
}

async function compactLegacyRepoCarValues(storage: Storage): Promise<void> {
	const nextIndex = readSavedRepoCarIndex(storage).map((entry) => ({
		...entry,
		storage: 'indexeddb' as const,
		encoding: 'uint8array' as const
	}));

	for (let index = storage.length - 1; index >= 0; index -= 1) {
		const key = storage.key(index);
		if (!key?.startsWith(REPO_CAR_VALUE_PREFIX)) continue;

		const raw = storage.getItem(key);
		if (!raw) continue;
		try {
			const value = JSON.parse(raw) as Partial<SavedRepoCarValue>;
			if (!value || typeof value !== 'object' || !('dataBase64' in value)) continue;
			const entry = sanitizeEntry({
				...value,
				key,
				storage: 'indexeddb',
				encoding: 'uint8array',
				encodedBytes: typeof value.dataBase64 === 'string' ? value.dataBase64.length : value.encodedBytes
			});
			if (!entry) continue;
			let decodedBytes: Uint8Array | null = null;
			if (typeof value.dataBase64 === 'string' && value.dataBase64.length > 0) {
				decodedBytes = base64ToBytes(value.dataBase64);
				await writeRepoCarBytes(entry.id, decodedBytes, {
					...entry,
					encodedBytes: decodedBytes.byteLength,
					storage: 'indexeddb',
					encoding: 'uint8array'
				});
			}
			storage.removeItem(key);
			storage.setItem(
				key,
				JSON.stringify({
					...entry,
					encodedBytes: decodedBytes?.byteLength ?? entry.encodedBytes,
					storage: 'indexeddb',
					encoding: 'uint8array'
				})
			);
		} catch {
			// Leave unrelated or malformed localStorage values alone.
		}
	}

	writeSavedRepoCarIndex(nextIndex, storage);
}

export async function saveRepoCarToLocalStorage(
	input: SaveRepoCarInput,
	storage: Storage = localStorage
): Promise<SavedRepoCarEntry> {
	const collection = normalizeCollection(input.collection);
	const id = buildRepoCarStorageId(input.did, collection);
	const key = buildRepoCarStorageKey(input.did, collection);
	const savedAt = input.savedAt ?? new Date().toISOString();
	const entry: SavedRepoCarEntry = {
		id,
		key,
		did: input.did,
		handle: input.handle?.trim() || null,
		displayName: input.displayName?.trim() || null,
		avatar: input.avatar?.trim() || null,
		collection,
		source: input.source,
		savedAt,
		downloadedBytes: input.downloadedBytes,
		totalBytes: input.totalBytes,
		encodedBytes: input.carBytes.byteLength,
		storage: 'indexeddb',
		encoding: 'uint8array',
		mediaType: 'application/vnd.ipld.car'
	};
	await writeRepoCarBytes(id, input.carBytes, entry);
	await compactLegacyRepoCarValues(storage);

	const value: SavedRepoCarValue = { ...entry };
	const nextIndex = [
		entry,
		...readSavedRepoCarIndex(storage).filter((candidate) => candidate.id !== entry.id)
	];

	storage.setItem(key, JSON.stringify(value));
	writeSavedRepoCarIndex(nextIndex, storage);
	return entry;
}

export async function deleteSavedRepoCar(
	entry: SavedRepoCarEntry,
	storage: Storage = localStorage
): Promise<void> {
	await deleteRepoCarBytes(entry.id).catch(() => {});
	storage.removeItem(entry.key);
	writeSavedRepoCarIndex(
		readSavedRepoCarIndex(storage).filter((candidate) => candidate.id !== entry.id),
		storage
	);
}
