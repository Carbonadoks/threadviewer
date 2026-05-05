import test from 'node:test';
import assert from 'node:assert/strict';
import {
	appendNewPostsToCache,
	appendOlderPostsToCache,
	readCachedPostPrefix,
	readPostCacheBucketUsage,
	readPostCacheHeadBatch,
	readPostCacheMeta,
	readPostCacheSlice,
	toPublicPostCacheStatus
} from './postCache';

class MemoryR2Bucket {
	private readonly objects = new Map<string, string>();
	private readonly sizes = new Map<string, number>();

	async get(key: string): Promise<any | null> {
		const value = this.objects.get(key);
		if (value == null) return null;

		return {
			body: null,
			json: async <T>() => JSON.parse(value) as T,
			text: async () => value
		};
	}

	async put(key: string, value: unknown): Promise<any> {
		if (typeof value !== 'string') {
			throw new Error(`Unsupported put payload for ${key}`);
		}
		this.objects.set(key, value);
		const size = new TextEncoder().encode(value).byteLength;
		this.sizes.set(key, size);
		return {
			key,
			size
		};
	}

	async head(key: string): Promise<any | null> {
		if (!this.objects.has(key)) return null;
		return {
			key,
			size: this.sizes.get(key) ?? 0
		};
	}

	seed(key: string, value: string, sizeBytes: number): void {
		this.objects.set(key, value);
		this.sizes.set(key, sizeBytes);
	}

	async delete(key: string): Promise<void> {
		this.objects.delete(key);
		this.sizes.delete(key);
	}

	createMultipartUpload(): never {
		throw new Error('Not implemented in MemoryR2Bucket');
	}

	resumeMultipartUpload(): never {
		throw new Error('Not implemented in MemoryR2Bucket');
	}

	async list(options: { prefix?: string; cursor?: string } = {}): Promise<any> {
		const prefix = options.prefix ?? '';
		const keys = [...this.objects.keys()]
			.filter((key) => key.startsWith(prefix))
			.sort();
		return {
			objects: keys.map((key) => ({ key, size: this.sizes.get(key) ?? 0 })),
			truncated: false,
			cursor: options.cursor
		};
	}
}

function bucket(): MemoryR2Bucket {
	return new MemoryR2Bucket();
}

function expectDefined<T>(
	value: T | null | undefined,
	message = 'Expected value to be defined'
): NonNullable<T> {
	assert.ok(value, message);
	return value as NonNullable<T>;
}

function feedItem(id: string): any {
	return {
		post: {
			uri: `at://did:plc:test/app.bsky.feed.post/${id}`,
			cid: `cid-${id}`
		}
	};
}

function uris(posts: any[]): string[] {
	return posts.map((item) => item.post.uri);
}

async function writeLegacyCache(bucket: R2Bucket, did: string, posts: any[]): Promise<void> {
	await bucket.put(
		`posts/${did}/meta.json`,
		JSON.stringify({
			postCount: posts.length,
			cursor: 'legacy-cursor',
			updatedAt: '2026-03-09T00:00:00.000Z',
			reachedEnd: false,
			chunkCount: 1
		})
	);
	await bucket.put(`posts/${did}/chunk-0.json`, JSON.stringify(posts));
}

async function readJson(bucket: R2Bucket, key: string): Promise<any> {
	const object = expectDefined(await bucket.get(key), `Missing object ${key}`);
	return object.json();
}

test('legacy tail-only caches remain readable through logical cache reads', async () => {
	const did = 'did:plc:legacy';
	const cache = bucket();
	const legacyPosts = [feedItem('c'), feedItem('b'), feedItem('a')];
	await writeLegacyCache(cache, did, legacyPosts);

	const prefix = expectDefined(await readCachedPostPrefix(cache, did, 2));
	assert.deepEqual(uris(prefix.posts), uris(legacyPosts.slice(0, 2)));

	const slice = await readPostCacheSlice(cache, did, {
		offset: 1,
		limit: 2
	});
	assert.equal(slice.missing, false);
	assert.deepEqual(uris(slice.posts), uris(legacyPosts.slice(1, 3)));
	assert.deepEqual(toPublicPostCacheStatus(slice.meta), {
		postCount: 3,
		reachedEnd: false,
		updatedAt: '2026-03-09T00:00:00.000Z',
		chunkCount: 1,
		cursor: 'legacy-cursor'
	});
});

test('logical cache slices span head batches and tail chunks without rechunking', async () => {
	const did = 'did:plc:head-tail';
	const cache = bucket();
	await appendOlderPostsToCache(cache, did, [feedItem('c'), feedItem('b'), feedItem('a')], {
		nextCursor: 'tail-cursor',
		reachedEnd: false,
		postsCount: 9000
	});
	await appendNewPostsToCache(cache, did, [feedItem('e'), feedItem('d')], {
		anchorUri: feedItem('c').post.uri,
		nextCursor: null,
		hasMore: false
	});

	const slice = await readPostCacheSlice(cache, did, {
		offset: 1,
		limit: 3
	});
	assert.equal(slice.missing, false);
	assert.deepEqual(uris(slice.posts), uris([feedItem('d'), feedItem('c'), feedItem('b')]));
});

test('multi-click new-post sync appends continuation batches behind the same anchor group', async () => {
	const did = 'did:plc:new-sync';
	const cache = bucket();
	const anchorUri = feedItem('c').post.uri;

	await appendOlderPostsToCache(cache, did, [feedItem('c'), feedItem('b'), feedItem('a')], {
		nextCursor: 'tail-cursor',
		reachedEnd: false,
		postsCount: 9000
	});
	await appendNewPostsToCache(cache, did, [feedItem('f'), feedItem('e')], {
		anchorUri,
		nextCursor: 'head-cursor-1',
		hasMore: true
	});
	await appendNewPostsToCache(cache, did, [feedItem('d')], {
		anchorUri,
		nextCursor: null,
		hasMore: false
	});

	const prefix = expectDefined(await readCachedPostPrefix(cache, did, 10, { allowPartial: true }));
	assert.deepEqual(
		uris(prefix.posts),
		uris([feedItem('f'), feedItem('e'), feedItem('d'), feedItem('c'), feedItem('b'), feedItem('a')])
	);

	const meta = expectDefined(await readPostCacheMeta(cache, did));
	assert.equal(meta.head.groups.length, 1);
	assert.equal(meta.head.groups[0].anchorUri, anchorUri);
	assert.equal(meta.head.groups[0].complete, true);
	assert.equal(meta.head.groups[0].nextCursor, null);
	assert.deepEqual(meta.head.groups[0].batches.map((batch) => batch.postCount), [2, 1]);
});

test('older-post appends update totals, cursor, reachedEnd, and cache enrollment', async () => {
	const did = 'did:plc:older';
	const cache = bucket();

	const firstAppend = await appendOlderPostsToCache(cache, did, [feedItem('b'), feedItem('a')], {
		nextCursor: 'older-cursor-1',
		reachedEnd: false,
		postsCount: 12
	});
	assert.equal(firstAppend.written, true);
	assert.equal(firstAppend.postCount, 2);
	assert.equal(firstAppend.reachedEnd, false);

	const secondAppend = await appendOlderPostsToCache(cache, did, [feedItem('older-1')], {
		nextCursor: null,
		reachedEnd: true,
		postsCount: 12
	});
	assert.equal(secondAppend.written, true);
	assert.equal(secondAppend.postCount, 3);
	assert.equal(secondAppend.reachedEnd, true);

	const meta = expectDefined(await readPostCacheMeta(cache, did));
	assert.equal(meta.postCount, 3);
	assert.equal(meta.cursor, null);
	assert.equal(meta.reachedEnd, true);
	assert.equal(meta.chunkCount, 1);

	const index = await readJson(cache, 'cache-index.json');
	assert.deepEqual(index, { dids: [did] });
});

test('new-post sync can enroll and persist head batches for an eligible uncached account', async () => {
	const did = 'did:plc:head-enroll';
	const cache = bucket();

	const write = await appendNewPostsToCache(cache, did, [feedItem('new-2'), feedItem('new-1')], {
		anchorUri: feedItem('old-head').post.uri,
		nextCursor: null,
		hasMore: false,
		postsCount: 7
	});

	assert.equal(write.written, true);
	assert.equal(write.postCount, 2);

	const meta = expectDefined(await readPostCacheMeta(cache, did));
	assert.equal(meta.head.groups.length, 1);
	assert.equal(meta.head.groups[0].batches.length, 1);
	assert.deepEqual(meta.head.groups[0].batches.map((batch) => batch.postCount), [2]);

	const prefix = expectDefined(await readCachedPostPrefix(cache, did, 10, { allowPartial: true }));
	assert.deepEqual(uris(prefix.posts), uris([feedItem('new-2'), feedItem('new-1')]));

	const index = await readJson(cache, 'cache-index.json');
	assert.deepEqual(index, { dids: [did] });
});

test('bucket size cap blocks new cache writes once R2 usage reaches 9 GB', async () => {
	const did = 'did:plc:bucket-full';
	const cache = bucket();
	cache.seed('cluster/snapshot.json', JSON.stringify({ ok: true }), 9_000_000_000);

	const write = await appendOlderPostsToCache(cache, did, [feedItem('a')], {
		nextCursor: 'cursor-1',
		reachedEnd: false,
		postsCount: 1
	});

	assert.equal(write.written, false);
	assert.equal(write.limitReached, true);
	assert.equal(await readPostCacheMeta(cache, did), null);
	assert.equal(await cache.get('cache-index.json'), null);
});

test('bucket usage reports total bytes and limit state', async () => {
	const cache = bucket();
	cache.seed('posts/a/meta.json', '{}', 1200);
	cache.seed('posts/a/chunk-0.json', '[]', 3400);

	const usage = expectDefined(await readPostCacheBucketUsage(cache));
	assert.equal(usage.bytes, 4600);
	assert.equal(usage.limitReached, false);
});

test('raw head batches stay individually readable for client-side cache composition', async () => {
	const did = 'did:plc:head-raw';
	const cache = bucket();
	const anchorUri = feedItem('old-head').post.uri;

	await appendNewPostsToCache(cache, did, [feedItem('new-3'), feedItem('new-2')], {
		anchorUri,
		nextCursor: 'cursor-1',
		hasMore: true,
		postsCount: 7000
	});
	await appendNewPostsToCache(cache, did, [feedItem('new-1')], {
		anchorUri,
		nextCursor: null,
		hasMore: false,
		postsCount: 7000
	});

	const meta = expectDefined(await readPostCacheMeta(cache, did));
	const groupId = meta.head.groups[0].id;

	const firstBatch = await readPostCacheHeadBatch(cache, did, groupId, 0);
	const secondBatch = await readPostCacheHeadBatch(cache, did, groupId, 1);

	assert.equal(firstBatch.missing, false);
	assert.equal(secondBatch.missing, false);
	assert.deepEqual(uris(firstBatch.posts), uris([feedItem('new-3'), feedItem('new-2')]));
	assert.deepEqual(uris(secondBatch.posts), uris([feedItem('new-1')]));
});
