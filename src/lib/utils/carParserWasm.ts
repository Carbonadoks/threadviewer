import type { ParsedPost, ParsedRepoRecord } from './carParser';
import init, {
	parseCarPostsWasm as wasmParsePosts,
	parseCarRecordsWasm as wasmParseRecords
} from './wasm_car_parser.js';

let ready: Promise<void> | null = null;

function ensureInit(): Promise<void> {
	if (!ready) {
		ready = init(new URL('/wasm_car_parser_bg.wasm', window.location.origin)).then(() => {});
	}
	return ready;
}

/**
 * Parse a CAR file using the WASM parser. Returns the same ParsedPost[]
 * shape as the JS carParser.ts version.
 */
export async function parseCarPostsWasm(
	carBytes: Uint8Array,
	onPost?: (count: number) => void
): Promise<ParsedPost[]> {
	await ensureInit();
	const jsonStr = wasmParsePosts(carBytes) as string;
	const posts: ParsedPost[] = JSON.parse(jsonStr);
	onPost?.(posts.length);
	return posts;
}

export async function parseCarRecordsWasm(
	carBytes: Uint8Array,
	onRecord?: (count: number) => void
): Promise<ParsedRepoRecord[]> {
	await ensureInit();
	const jsonStr = wasmParseRecords(carBytes) as string;
	const records: ParsedRepoRecord[] = JSON.parse(jsonStr);
	onRecord?.(records.length);
	return records;
}
