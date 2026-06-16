import test from 'node:test';
import assert from 'node:assert/strict';
import { buildThreadsFromFeed } from './threadWalker';
import {
	buildViewer2DbGalleryQuery,
	buildViewer2DbThreadsFromPostRows,
	escapeSqlLikePattern,
	isViewer2DuckDbFatalError,
	isViewer2DuckDbMissingWalMessage,
	parsedPostToViewer2DbRow,
	sqlStringLiteral,
	viewer2DbThreadRowsToThreads,
	type Viewer2DbPostRow,
	type Viewer2DbThreadPostRow
} from './viewer2DuckDb';

const ALICE = {
	did: 'did:plc:alice',
	handle: 'alice.test',
	displayName: 'Alice',
	avatar: 'https://example.com/alice.jpg'
};
const BOB = {
	did: 'did:plc:bob',
	handle: 'bob.test',
	displayName: 'Bob'
};

function uri(did: string, id: string): string {
	return `at://${did}/app.bsky.feed.post/${id}`;
}

function dbRow(options: {
	id: string;
	did?: string;
	handle?: string;
	displayName?: string;
	parentUri?: string;
	rootUri?: string;
	text?: string;
	createdAt?: string;
	hasImages?: boolean;
	hasVideo?: boolean;
}): Viewer2DbPostRow {
	const did = options.did ?? ALICE.did;
	const handle = options.handle ?? (did === BOB.did ? BOB.handle : ALICE.handle);
	const displayName = options.displayName ?? (did === BOB.did ? BOB.displayName : ALICE.displayName);
	const postUri = uri(did, options.id);
	const createdAt = options.createdAt ?? '2026-03-01T12:00:00.000Z';
	const hasImages = options.hasImages ?? false;
	const hasVideo = options.hasVideo ?? false;
	return {
		uri: postUri,
		did,
		rkey: options.id,
		cid: `cid-${options.id}`,
		text: options.text ?? options.id,
		created_at: createdAt,
		indexed_at: createdAt,
		reply_parent_uri: options.parentUri ?? null,
		reply_root_uri: options.rootUri ?? (options.parentUri ? options.parentUri : null),
		facets_json: 'null',
		embed_json: hasImages ? JSON.stringify({ $type: 'app.bsky.embed.images', images: [] }) : 'null',
		linked_urls_json: '[]',
		like_count: 0,
		repost_count: 0,
		reply_count: 0,
		quote_count: 0,
		has_images: hasImages,
		has_video: hasVideo,
		has_media: hasImages || hasVideo,
		search_text: `${options.text ?? options.id}\n${handle}`.toLowerCase(),
		handle,
		display_name: displayName,
		avatar: did === ALICE.did ? ALICE.avatar : null
	};
}

function feedItem(row: Viewer2DbPostRow): any {
	return {
		post: {
			uri: row.uri,
			cid: row.cid,
			author: {
				did: row.did,
				handle: row.handle,
				displayName: row.display_name,
				avatar: row.avatar
			},
			record: {
				text: row.text,
				createdAt: row.created_at,
				reply: row.reply_parent_uri
					? {
							parent: { uri: row.reply_parent_uri },
							root: { uri: row.reply_root_uri ?? row.reply_parent_uri }
						}
					: undefined,
				embed: row.embed_json === 'null' ? undefined : JSON.parse(row.embed_json)
			},
			indexedAt: row.indexed_at,
			likeCount: row.like_count,
			repostCount: row.repost_count,
			replyCount: row.reply_count,
			quoteCount: row.quote_count
		}
	};
}

function treeShape(node: { uri: string; children: Array<any> }): any {
	return {
		uri: node.uri,
		children: node.children.map(treeShape)
	};
}

function threadShapes(threads: Array<{ rootUri: string; depth: number; rootPost: any }>): any[] {
	return threads
		.map((thread) => ({
			rootUri: thread.rootUri,
			depth: thread.depth,
			tree: treeShape(thread.rootPost)
		}))
		.sort((a, b) => a.rootUri.localeCompare(b.rootUri));
}

test('SQL literal and LIKE escaping keep user text inside string values', () => {
	assert.equal(sqlStringLiteral("can't stop"), "'can''t stop'");
	assert.equal(escapeSqlLikePattern('100%_real\\path'), '100\\%\\_real\\\\path');

	const { sql } = buildViewer2DbGalleryQuery({
		query: "needle%' OR 1=1 --",
		searchMode: 'literal',
		groupMode: 'posts',
		contentMode: 'images',
		dateFrom: '2026-01-01',
		dateTo: '2026-01-31',
		minDepth: 3,
		sortMode: 'liked',
		limit: 9999,
		offset: -10,
		accountDids: ["did:plc:o'hare"]
	});

	assert.match(sql, /t\.depth >= 3/);
	assert.match(sql, /t\.root_created_at >= '2026-01-01T00:00:00\.000Z'/);
	assert.match(sql, /t\.root_created_at <= '2026-01-31T23:59:59\.999Z'/);
	assert.match(sql, /t\.did IN \('did:plc:o''hare'\)/);
	assert.match(sql, /p_filter\.has_images = TRUE/);
	assert.match(sql, /needle\\%'' or 1=1 --/);
	assert.match(sql, /ORDER BY t\.like_count DESC/);
	assert.match(sql, /LIMIT 500 OFFSET 0$/);
});

test('regex query builder escapes regex text as a SQL literal', () => {
	const { sql, countSql } = buildViewer2DbGalleryQuery({
		query: "foo'bar",
		searchMode: 'regex',
		groupMode: 'threads',
		contentMode: 'media'
	});

	assert.match(sql, /t\.has_media = TRUE/);
	assert.match(sql, /regexp_matches\(p_filter\.search_text, 'foo''bar', 'i'\)/);
	assert.match(countSql, /COUNT\(\*\) AS total/);
});

test('DuckDB fatal classifier catches invalidated database errors only', () => {
	assert.equal(
		isViewer2DuckDbFatalError(
			new Error(
				'FATAL Error: Failed: database has been invalidated because of a previous fatal error. The database must be restarted prior to being used again.'
			)
		),
		true
	);
	assert.equal(
		isViewer2DuckDbFatalError(
			new Error(
				'FATAL Error: Failed to create checkpoint because of error: FATAL Error: Failed to create checkpoint: Out of Memory Error: Allocation failure'
			)
		),
		true
	);
	assert.equal(isViewer2DuckDbFatalError(new Error('TransactionContext Error: cannot start a transaction within a transaction')), false);
});

test('DuckDB missing WAL warning classifier only matches WAL buffering noise', () => {
	assert.equal(
		isViewer2DuckDbMissingWalMessage('08854836:0x8cc60f Buffering missing file: opfs:/threadviewer-viewer2db.duckdb.wal'),
		true
	);
	assert.equal(isViewer2DuckDbMissingWalMessage('Buffering missing file: opfs:/threadviewer-viewer2db.duckdb'), false);
	assert.equal(isViewer2DuckDbMissingWalMessage(new Error('FATAL Error: Out of Memory Error')), false);
});

test('DB thread builder matches buildThreadsFromFeed for a simple self-reply chain', () => {
	const root = dbRow({ id: 'root' });
	const reply = dbRow({ id: 'reply', parentUri: root.uri, rootUri: root.uri });
	const rows = [root, reply];

	const dbBuilt = buildViewer2DbThreadsFromPostRows(rows, ALICE.did);
	const feedBuilt = buildThreadsFromFeed(rows.map(feedItem), ALICE.did);

	assert.deepEqual(threadShapes(dbBuilt.threads), threadShapes(feedBuilt.threads));
	assert.equal(dbBuilt.stats.postsScanned, 2);
	assert.equal(dbBuilt.stats.threadsWithSelfReplies, 1);
	assert.deepEqual(
		dbBuilt.threadPosts.map((row) => [row.root_uri, row.post_uri, row.parent_uri, row.ordinal]),
		[
			[root.uri, root.uri, null, 0],
			[root.uri, reply.uri, root.uri, 1]
		]
	);
});

test('DB thread builder uses known-root fallback when a direct parent is missing', () => {
	const root = dbRow({ id: 'root' });
	const orphan = dbRow({
		id: 'orphan',
		parentUri: uri(ALICE.did, 'missing-parent'),
		rootUri: root.uri
	});
	const rows = [root, orphan];

	const dbBuilt = buildViewer2DbThreadsFromPostRows(rows, ALICE.did);
	const feedBuilt = buildThreadsFromFeed(rows.map(feedItem), ALICE.did);

	assert.deepEqual(threadShapes(dbBuilt.threads), threadShapes(feedBuilt.threads));
	assert.equal(dbBuilt.threads[0].rootPost.children[0].uri, orphan.uri);
});

test('DB thread builder respects multiple selected authors', () => {
	const aliceRoot = dbRow({ id: 'alice-root', did: ALICE.did });
	const bobReply = dbRow({
		id: 'bob-reply',
		did: BOB.did,
		parentUri: aliceRoot.uri,
		rootUri: aliceRoot.uri
	});
	const aliceFollowup = dbRow({
		id: 'alice-followup',
		did: ALICE.did,
		parentUri: bobReply.uri,
		rootUri: aliceRoot.uri
	});
	const rows = [aliceRoot, bobReply, aliceFollowup];

	const aliceOnly = buildViewer2DbThreadsFromPostRows(rows, ALICE.did);
	const feedAliceOnly = buildThreadsFromFeed(rows.map(feedItem), ALICE.did);
	const both = buildViewer2DbThreadsFromPostRows(rows, [ALICE.did, BOB.did]);
	const feedBoth = buildThreadsFromFeed(rows.map(feedItem), [ALICE.did, BOB.did]);

	assert.deepEqual(threadShapes(aliceOnly.threads), threadShapes(feedAliceOnly.threads));
	assert.equal(aliceOnly.threads[0].depth, 2);
	assert.deepEqual(threadShapes(both.threads), threadShapes(feedBoth.threads));
	assert.equal(both.threads[0].depth, 3);
});

test('parsed rows keep media flags and thread-row conversion restores renderable posts', () => {
	const parsed = parsedPostToViewer2DbRow(
		ALICE.did,
		{
			rkey: 'with-images',
			cid: 'cid-with-images',
			record: {
				text: 'post with media',
				createdAt: '2026-04-02T10:00:00.000Z',
				embed: { $type: 'app.bsky.embed.images', images: [{ alt: 'one' }] },
				facets: []
			}
		},
		ALICE,
		'2026-04-02T10:00:00.000Z'
	);
	assert.equal(parsed.has_images, true);
	assert.equal(parsed.has_media, true);
	assert.equal(parsed.has_video, false);

	const row: Viewer2DbThreadPostRow = {
		...parsed,
		root_uri: parsed.uri,
		post_uri: parsed.uri,
		parent_uri: null,
		ordinal: 0,
		thread_depth: 1,
		thread_post_count: 1
	};
	const [thread] = viewer2DbThreadRowsToThreads([row], [parsed.uri]);
	assert.equal(thread.rootUri, parsed.uri);
	assert.equal(thread.rootPost.needsHydratedPostView, true);
	assert.equal(thread.rootPost.author.handle, ALICE.handle);
});
