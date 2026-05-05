export type SemanticBucketFile = {
	key: string;
	prefix: string;
	filename: string;
	size: number;
	uploadedAt: string | null;
	downloadPath: string;
};

export const SEMANTIC_DB_PREFIXES = [
	'output/embedding-dbs/',
	'output/embdding-dbs/',
	'output/thread-embedding-dbs/',
	'output/window-embedding-dbs/'
] as const;

function hasAllowedExtension(value: string): boolean {
	return /\.sqlite$/i.test(value) || /\.db$/i.test(value);
}

export function isAllowedSemanticDbKey(key: string): boolean {
	const trimmed = key.trim();
	return (
		!!trimmed &&
		hasAllowedExtension(trimmed) &&
		SEMANTIC_DB_PREFIXES.some((prefix) => trimmed.startsWith(prefix))
	);
}

export function semanticDbDownloadPath(key: string): string {
	return `/api/semantic/file?key=${encodeURIComponent(key)}`;
}

export async function listSemanticBucketFiles(bucket: R2Bucket): Promise<SemanticBucketFile[]> {
	const byKey = new Map<string, SemanticBucketFile>();

	for (const prefix of SEMANTIC_DB_PREFIXES) {
		let cursor: string | undefined;
		do {
			const listing = await bucket.list({ prefix, cursor });
			for (const object of listing.objects) {
				if (!isAllowedSemanticDbKey(object.key)) continue;

				byKey.set(object.key, {
					key: object.key,
					prefix,
					filename: object.key.slice(prefix.length) || object.key,
					size: object.size,
					uploadedAt:
						object.uploaded instanceof Date ? object.uploaded.toISOString() : null,
					downloadPath: semanticDbDownloadPath(object.key)
				});
			}
			cursor = listing.truncated ? listing.cursor : undefined;
		} while (cursor);
	}

	return [...byKey.values()].sort((a, b) => {
		const aTime = a.uploadedAt ? new Date(a.uploadedAt).getTime() : 0;
		const bTime = b.uploadedAt ? new Date(b.uploadedAt).getTime() : 0;
		return bTime - aTime || a.filename.localeCompare(b.filename) || a.key.localeCompare(b.key);
	});
}
