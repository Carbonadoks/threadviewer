import test from 'node:test';
import assert from 'node:assert/strict';
import { RequestScheduler } from './requestScheduler';

test('promote moves a queued background request ahead of other queued work', async () => {
	const scheduler = new RequestScheduler({ maxConcurrency: 1, initialConcurrency: 1 });
	const order: string[] = [];
	let releaseBlocker!: () => void;
	const blocker = new Promise<void>((resolve) => (releaseBlocker = resolve));

	const run = (name: string, wait?: Promise<void>) => async () => {
		order.push(name);
		await wait;
		return name;
	};
	// One slot, held by the first request; the rest queue behind it.
	const first = scheduler.schedule({ kind: 'thread', key: 'first', label: 'first', priority: 1, run: run('first', blocker) });
	const bulk = Array.from({ length: 3 }, (_, index) =>
		scheduler.schedule({ kind: 'thread', key: `bulk${index}`, label: 'bulk', priority: 1, run: run(`bulk${index}`) })
	);
	const quotes = scheduler.schedule({ kind: 'quotes', key: 'quotes:page', label: 'quotes', priority: 2, run: run('quotes') });

	scheduler.promote('quotes:page', 0);
	releaseBlocker();
	await Promise.all([first, quotes, ...bulk]);
	assert.deepEqual(order, ['first', 'quotes', 'bulk0', 'bulk1', 'bulk2']);
});

test('promote ignores unknown keys and lower priorities', async () => {
	const scheduler = new RequestScheduler({ maxConcurrency: 1, initialConcurrency: 1 });
	scheduler.promote('missing', 0);
	const value = await scheduler.schedule({ kind: 'quotes', key: 'a', label: 'a', priority: 0, run: async () => 1 });
	assert.equal(value, 1);
});
