export interface ParsedPost {
	rkey: string;
	cid: string;
	record: any;
}

export interface ParsedRepoRecord {
	collection: string;
	rkey: string;
	cid: string;
	record: any;
}

interface MstEntry {
	p: number;
	k: Uint8Array;
	v: any; // CID
	t?: any; // CID
}

interface MstNode {
	l?: any; // CID
	e: MstEntry[];
}

export interface CarDeps {
	CarReader: any;
	dagCbor: { decode: (bytes: Uint8Array) => any };
}

const POST_COLLECTION = 'app.bsky.feed.post';
const textDecoder = new TextDecoder();

function parseCollectionKey(key: string): { collection: string; rkey: string } | null {
	const slashIndex = key.indexOf('/');
	if (slashIndex <= 0 || slashIndex >= key.length - 1) {
		return null;
	}

	return {
		collection: key.slice(0, slashIndex),
		rkey: key.slice(slashIndex + 1)
	};
}

export async function parseCarRecords(
	carBytes: Uint8Array,
	deps: CarDeps,
	options: {
		collections?: Iterable<string>;
		onRecord?: (count: number) => void;
	} = {}
): Promise<ParsedRepoRecord[]> {
	const { CarReader, dagCbor } = deps;
	const { collections, onRecord } = options;
	const allowedCollections = collections ? new Set(collections) : null;

	const reader = await CarReader.fromBytes(carBytes);
	const roots = await reader.getRoots();
	if (roots.length === 0) throw new Error('CAR has no roots');

	const commitBlock = await reader.get(roots[0]);
	if (!commitBlock) throw new Error('Commit block not found');
	const commit = dagCbor.decode(commitBlock.bytes) as any;

	const mstRootCid = commit.data;
	if (!mstRootCid) throw new Error('Commit block has no data (MST root) field');

	const records: ParsedRepoRecord[] = [];
	let yieldCounter = 0;

	async function walkMst(cid: any, prevKey: string): Promise<void> {
		const block = await reader.get(cid);
		if (!block) return;

		const node = dagCbor.decode(block.bytes) as MstNode;

		if (node.l) {
			await walkMst(node.l, prevKey);
		}

		let currentKey = prevKey;
		for (const entry of node.e) {
			const suffix = textDecoder.decode(entry.k);
			currentKey = currentKey.slice(0, entry.p) + suffix;

			const parsedKey = parseCollectionKey(currentKey);
			const allowed =
				parsedKey && (!allowedCollections || allowedCollections.has(parsedKey.collection));
			if (parsedKey && allowed) {
				try {
					const recordBlock = await reader.get(entry.v);
					if (recordBlock) {
						const record = dagCbor.decode(recordBlock.bytes);
						records.push({
							collection: parsedKey.collection,
							rkey: parsedKey.rkey,
							cid: entry.v.toString(),
							record
						});

						yieldCounter += 1;
						if (yieldCounter % 200 === 0) {
							onRecord?.(records.length);
							await new Promise((resolve) => setTimeout(resolve, 0));
						}
					}
				} catch {
					// Skip malformed record blocks
				}
			}

			if (entry.t) {
				await walkMst(entry.t, currentKey);
			}
		}
	}

	await walkMst(mstRootCid, '');
	onRecord?.(records.length);
	return records;
}

/**
 * Parse a CAR file and extract all app.bsky.feed.post records.
 *
 * Accepts pre-imported deps so the caller (a client-only page) can
 * import @ipld/car and @ipld/dag-cbor without polluting the SSR bundle.
 *
 * onPost is called after each post is extracted, yielding to the event
 * loop periodically so the UI can update.
 */
export async function parseCarPosts(
	carBytes: Uint8Array,
	deps: CarDeps,
	onPost?: (count: number) => void
): Promise<ParsedPost[]> {
	const records = await parseCarRecords(carBytes, deps, {
		collections: [POST_COLLECTION],
		onRecord: onPost
	});

	return records.map((record) => ({
		rkey: record.rkey,
		cid: record.cid,
		record: record.record
	}));
}
