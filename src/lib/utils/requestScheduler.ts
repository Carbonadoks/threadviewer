/**
 * One bounded request queue shared by every loading path on a board.
 *
 * - Slots refill as soon as any request finishes (no batch barriers).
 * - Lower `priority` runs first; FIFO within a priority.
 * - Requests with the same `key` share one in-flight task. A shared task is only
 *   cancelled once every caller has aborted.
 * - Rate limits (429) halve concurrency and pause the queue for the server's
 *   retry-after, then concurrency grows back one slot at a time.
 * - Retries are bounded, so failures cannot turn into a retry storm.
 */

export type RequestKind = 'quotes' | 'thread';
export type RequestPriority = 0 | 1 | 2;

export type ScheduleOptions<T> = {
	kind: RequestKind;
	label: string;
	run: (signal: AbortSignal) => Promise<T>;
	key?: string;
	priority?: RequestPriority;
	signal?: AbortSignal;
	retries?: number;
};

export type RunningRequest = { id: number; kind: RequestKind; label: string; attempt: number };

export type SchedulerSnapshot = {
	running: RunningRequest[];
	queued: number;
	queuedByKind: Record<RequestKind, number>;
	/** Counters for the current busy period; they reset when new work arrives on an idle queue. */
	completed: number;
	failed: number;
	cancelled: number;
	retried: number;
	concurrency: number;
	maxConcurrency: number;
	pausedUntil: number;
};

type Task = {
	id: number;
	key?: string;
	kind: RequestKind;
	label: string;
	priority: RequestPriority;
	run: (signal: AbortSignal) => Promise<unknown>;
	retries: number;
	attempt: number;
	controller: AbortController;
	subscribers: number;
	state: 'queued' | 'waiting' | 'running' | 'settled';
	resolve: (value: unknown) => void;
	reject: (error: unknown) => void;
	promise: Promise<unknown>;
};

export function isAbortError(error: unknown): boolean {
	return (
		(error instanceof DOMException && error.name === 'AbortError') ||
		(error instanceof Error && error.name === 'AbortError')
	);
}

export function abortError(): Error {
	return new DOMException('Aborted', 'AbortError');
}

export function errorStatus(error: unknown): number | undefined {
	const status = Number((error as { status?: unknown } | null)?.status);
	return Number.isFinite(status) && status > 0 ? status : undefined;
}

function retryAfterMs(error: unknown): number | undefined {
	const headers = (error as { headers?: Record<string, string> } | null)?.headers;
	const seconds = Number(headers?.['retry-after'] ?? headers?.['Retry-After']);
	return Number.isFinite(seconds) && seconds > 0 ? Math.min(60_000, seconds * 1000) : undefined;
}

function isRetryable(error: unknown): boolean {
	const status = errorStatus(error);
	if (status === undefined) return error instanceof TypeError; // network failure
	return status === 429 || status >= 500;
}

export class RequestScheduler {
	private queues: Task[][] = [[], [], []];
	private byKey = new Map<string, Task>();
	private running = new Set<Task>();
	private waiting = new Set<Task>();
	private nextId = 1;
	private concurrency: number;
	private successStreak = 0;
	private pausedUntil = 0;
	private resumeTimer: ReturnType<typeof setTimeout> | null = null;
	private completed = 0;
	private failed = 0;
	private cancelled = 0;
	private retried = 0;
	private disposed = false;

	constructor(
		private readonly options: {
			maxConcurrency?: number;
			initialConcurrency?: number;
			maxRetries?: number;
			onChange?: () => void;
		} = {}
	) {
		this.concurrency = Math.min(options.initialConcurrency ?? 4, this.maxConcurrency);
	}

	private get maxConcurrency(): number {
		return this.options.maxConcurrency ?? 6;
	}

	schedule<T>(options: ScheduleOptions<T>): Promise<T> {
		if (this.disposed) return Promise.reject(abortError());
		if (options.signal?.aborted) return Promise.reject(abortError());

		let task = options.key ? this.byKey.get(options.key) : undefined;
		if (task && task.state !== 'settled') {
			// Upgrade a shared task that is still waiting to the most urgent caller's priority.
			const priority = options.priority ?? 1;
			if (task.state === 'queued' && priority < task.priority) {
				this.removeQueued(task);
				task.priority = priority;
				this.queues[priority].push(task);
			}
		} else {
			task = this.createTask(options as ScheduleOptions<unknown>);
		}
		task.subscribers += 1;
		const shared = task;

		return new Promise<T>((resolve, reject) => {
			let done = false;
			const onAbort = () => {
				if (done) return;
				done = true;
				reject(abortError());
				this.release(shared);
			};
			options.signal?.addEventListener('abort', onAbort, { once: true });
			shared.promise.then(
				(value) => {
					if (done) return;
					done = true;
					options.signal?.removeEventListener('abort', onAbort);
					resolve(value as T);
				},
				(error) => {
					if (done) return;
					done = true;
					options.signal?.removeEventListener('abort', onAbort);
					reject(error);
				}
			);
			this.pump();
		});
	}

	snapshot(): SchedulerSnapshot {
		const queuedByKind: Record<RequestKind, number> = { quotes: 0, thread: 0 };
		let queued = 0;
		for (const task of this.waiting) {
			queuedByKind[task.kind] += 1;
			queued += 1;
		}
		for (const queue of this.queues) {
			for (const task of queue) {
				queuedByKind[task.kind] += 1;
				queued += 1;
			}
		}
		return {
			running: Array.from(this.running, (task) => ({
				id: task.id,
				kind: task.kind,
				label: task.label,
				attempt: task.attempt
			})),
			queued,
			queuedByKind,
			completed: this.completed,
			failed: this.failed,
			cancelled: this.cancelled,
			retried: this.retried,
			concurrency: this.concurrency,
			maxConcurrency: this.maxConcurrency,
			pausedUntil: this.pausedUntil > Date.now() ? this.pausedUntil : 0
		};
	}

	/** Cancels everything; the scheduler stays usable afterwards. */
	cancelAll() {
		for (const queue of this.queues) {
			for (const task of queue.splice(0)) this.settle(task, 'cancelled', abortError());
		}
		for (const task of [...this.waiting]) this.settle(task, 'cancelled', abortError());
		for (const task of [...this.running]) {
			task.controller.abort();
		}
		this.notify();
	}

	dispose() {
		this.cancelAll();
		this.disposed = true;
		if (this.resumeTimer) clearTimeout(this.resumeTimer);
	}

	private createTask(options: ScheduleOptions<unknown>): Task {
		let resolve!: (value: unknown) => void;
		let reject!: (error: unknown) => void;
		const promise = new Promise<unknown>((res, rej) => {
			resolve = res;
			reject = rej;
		});
		// Callers observe the promise through their own wrapper; avoid unhandled rejections.
		promise.catch(() => {});
		if (this.running.size === 0 && this.waiting.size === 0 && this.queues.every((queue) => !queue.length)) {
			// A new busy period: progress counters start fresh for this batch of work.
			this.completed = 0;
			this.failed = 0;
			this.cancelled = 0;
			this.retried = 0;
		}
		const task: Task = {
			id: this.nextId++,
			key: options.key,
			kind: options.kind,
			label: options.label,
			priority: options.priority ?? 1,
			run: options.run,
			retries: options.retries ?? this.options.maxRetries ?? 3,
			attempt: 0,
			controller: new AbortController(),
			subscribers: 0,
			state: 'queued',
			resolve,
			reject,
			promise
		};
		if (task.key) this.byKey.set(task.key, task);
		this.queues[task.priority].push(task);
		this.notify();
		return task;
	}

	private release(task: Task) {
		task.subscribers -= 1;
		if (task.subscribers > 0 || task.state === 'settled') return;
		if (task.state === 'running') {
			task.controller.abort();
			return;
		}
		this.removeQueued(task);
		this.settle(task, 'cancelled', abortError());
		this.pump();
	}

	private removeQueued(task: Task) {
		const queue = this.queues[task.priority];
		const index = queue.indexOf(task);
		if (index >= 0) queue.splice(index, 1);
	}

	private settle(task: Task, outcome: 'completed' | 'failed' | 'cancelled', value: unknown) {
		if (task.state === 'settled') return;
		task.state = 'settled';
		this.running.delete(task);
		this.waiting.delete(task);
		if (task.key && this.byKey.get(task.key) === task) this.byKey.delete(task.key);
		this[outcome] += 1;
		if (outcome === 'completed') task.resolve(value);
		else task.reject(value);
	}

	private nextTask(): Task | undefined {
		for (const queue of this.queues) {
			const task = queue.shift();
			if (task) return task;
		}
		return undefined;
	}

	private pump() {
		const now = Date.now();
		if (this.pausedUntil > now) {
			this.resumeTimer ??= setTimeout(() => {
				this.resumeTimer = null;
				this.pump();
			}, this.pausedUntil - now);
			this.notify();
			return;
		}
		while (this.running.size < this.concurrency) {
			const task = this.nextTask();
			if (!task) break;
			void this.start(task);
		}
		this.notify();
	}

	private async start(task: Task) {
		task.state = 'running';
		task.attempt += 1;
		this.running.add(task);
		this.notify();
		try {
			const value = await task.run(task.controller.signal);
			if (task.controller.signal.aborted) throw abortError();
			this.onSuccess();
			this.settle(task, 'completed', value);
		} catch (error) {
			this.running.delete(task);
			if (task.controller.signal.aborted || isAbortError(error)) {
				this.settle(task, 'cancelled', abortError());
			} else if (isRetryable(error) && task.attempt <= task.retries) {
				this.onRetryableFailure(error, task);
				return;
			} else {
				this.settle(task, 'failed', error);
			}
		}
		this.pump();
	}

	private onSuccess() {
		this.successStreak += 1;
		if (this.concurrency < this.maxConcurrency && this.successStreak >= this.concurrency * 4) {
			this.concurrency += 1;
			this.successStreak = 0;
		}
	}

	private onRetryableFailure(error: unknown, task: Task) {
		this.retried += 1;
		this.successStreak = 0;
		const rateLimited = errorStatus(error) === 429;
		if (rateLimited) this.concurrency = Math.max(1, Math.floor(this.concurrency / 2));
		const delay =
			retryAfterMs(error) ?? Math.min(15_000, 600 * 2 ** (task.attempt - 1)) + Math.random() * 300;
		if (rateLimited) {
			// Everyone waits out a rate limit, not just this request.
			this.pausedUntil = Math.max(this.pausedUntil, Date.now() + delay);
			task.state = 'queued';
			this.queues[task.priority].unshift(task);
			this.pump();
			return;
		}
		task.state = 'waiting';
		this.waiting.add(task);
		this.notify();
		setTimeout(() => {
			if (task.state !== 'waiting') return;
			this.waiting.delete(task);
			if (task.controller.signal.aborted || task.subscribers <= 0) {
				this.settle(task, 'cancelled', abortError());
				this.pump();
				return;
			}
			task.state = 'queued';
			this.queues[task.priority].unshift(task);
			this.pump();
		}, delay);
	}

	private notify() {
		this.options.onChange?.();
	}
}
