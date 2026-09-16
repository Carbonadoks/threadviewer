// A small work pool that keeps N MobileNet workers fed.
//
// Two stages, because the firehose is network-bound long before it is GPU-bound:
//   1. fetch + decode the thumbnail (async I/O, runs `fetchConcurrency` at a time)
//   2. hand the decoded bitmap to whichever worker is idle
// Both stages are bounded and drop the oldest work when they back up, so a burst
// of posts costs latency on a few images rather than unbounded memory.
import type {
	ClassifierWorkerRequest,
	ClassifierWorkerResponse,
	Prediction
} from './classifierTypes';

export type ClassifierJob = {
	id: string;
	url: string;
};

export type ClassifierStats = {
	queued: number;
	decoding: number;
	inflight: number;
	classified: number;
	errors: number;
	dropped: number;
	perSecond: number;
	avgMs: number;
	backend: string;
	workers: number;
	ready: boolean;
};

export type ClassifierPoolOptions = {
	workers: number;
	topK?: number;
	fetchConcurrency?: number;
	maxQueue?: number;
	preferredBackend?: 'webgpu' | 'webgl';
	// Vite needs a literal `new URL(..., import.meta.url)` to bundle a worker, so the
	// caller supplies the constructor and this pool stays model-agnostic.
	createWorker: () => Worker;
	// Ask the worker for penultimate/pooled features alongside its predictions.
	embed?: boolean;
	onResult: (id: string, predictions: Prediction[], embedding?: Float32Array) => void;
	onDropped?: (id: string) => void;
	onStats?: (stats: ClassifierStats) => void;
};

const INPUT_SIZE = 224;

type Ready = { job: ClassifierJob; bitmap: ImageBitmap };

export class ClassifierPool {
	#workers: Worker[] = [];
	#busy = new Set<number>();
	#pending = new Map<string, ClassifierJob>();
	#queue: ClassifierJob[] = [];
	#ready: Ready[] = [];
	#decoding = 0;
	#seen = new Set<string>();
	#classified = 0;
	#errors = 0;
	#dropped = 0;
	#completions: number[] = [];
	#avgMs = 0;
	#backend = 'loading';
	#readyWorkers = 0;
	#topK: number;
	#fetchConcurrency: number;
	#maxQueue: number;
	#preferredBackend: 'webgpu' | 'webgl';
	#createWorker: () => Worker;
	#embed: boolean;
	#textRequests = new Map<string, (embedding: Float32Array) => void>();
	#textErrors = new Map<string, (error: Error) => void>();
	#textCounter = 0;
	#onResult: (id: string, predictions: Prediction[], embedding?: Float32Array) => void;
	#onDropped?: (id: string) => void;
	#onStats?: (stats: ClassifierStats) => void;
	#disposed = false;

	constructor(options: ClassifierPoolOptions) {
		this.#createWorker = options.createWorker;
		this.#embed = options.embed ?? false;
		this.#topK = options.topK ?? 5;
		this.#fetchConcurrency = options.fetchConcurrency ?? 12;
		this.#maxQueue = options.maxQueue ?? 240;
		this.#preferredBackend = options.preferredBackend ?? 'webgpu';
		this.#onResult = options.onResult;
		this.#onDropped = options.onDropped;
		this.#onStats = options.onStats;
		this.setWorkerCount(options.workers);
	}

	get stats(): ClassifierStats {
		const now = performance.now();
		this.#completions = this.#completions.filter((time) => now - time < 1000);
		return {
			queued: this.#queue.length + this.#ready.length,
			decoding: this.#decoding,
			inflight: this.#busy.size,
			classified: this.#classified,
			errors: this.#errors,
			dropped: this.#dropped,
			perSecond: this.#completions.length,
			avgMs: this.#avgMs,
			backend: this.#backend,
			workers: this.#workers.length,
			ready: this.#readyWorkers > 0
		};
	}

	setTopK(topK: number) {
		this.#topK = Math.max(1, Math.min(20, Math.round(topK)));
	}

	setWorkerCount(count: number) {
		if (this.#disposed) return;
		const next = Math.max(1, Math.min(16, Math.round(count)));
		while (this.#workers.length > next) {
			const index = this.#workers.length - 1;
			this.#workers.pop()?.terminate();
			this.#busy.delete(index);
			this.#readyWorkers = Math.min(this.#readyWorkers, this.#workers.length);
		}
		while (this.#workers.length < next) {
			this.#spawnWorker();
		}
		this.#emitStats();
		this.#pump();
	}

	// Returns false when the job was rejected (duplicate or the queue is saturated).
	submit(job: ClassifierJob): boolean {
		if (this.#disposed) return false;
		if (this.#seen.has(job.id)) return false;
		this.#seen.add(job.id);
		if (this.#seen.size > 20_000) {
			// Bound the dedupe set; ids arrive newest-first so old ones will not recur.
			this.#seen = new Set([...this.#seen].slice(-10_000));
		}
		this.#queue.push(job);
		while (this.#queue.length > this.#maxQueue) {
			const stale = this.#queue.shift();
			if (stale) {
				this.#dropped += 1;
				this.#onDropped?.(stale.id);
			}
		}
		this.#pump();
		return true;
	}

	dispose() {
		this.#disposed = true;
		for (const worker of this.#workers) worker.terminate();
		this.#workers = [];
		this.#busy.clear();
		this.#pending.clear();
		this.#queue = [];
		for (const entry of this.#ready) entry.bitmap.close();
		this.#ready = [];
	}

	// Text embedding is a one-off request, not pooled work: it always goes to worker
	// 0, which is also the only worker that then holds the text tower in memory.
	embedText(text: string): Promise<Float32Array> {
		const worker = this.#workers[0];
		if (!worker) return Promise.reject(new Error('no worker available'));
		const id = `text-${(this.#textCounter += 1)}`;
		return new Promise<Float32Array>((resolve, reject) => {
			this.#textRequests.set(id, resolve);
			this.#textErrors.set(id, reject);
			this.#send(worker, { type: 'embedText', id, text });
		});
	}

	#spawnWorker() {
		const worker = this.#createWorker();
		const index = this.#workers.length;
		worker.addEventListener('message', (event: MessageEvent<ClassifierWorkerResponse>) => {
			this.#handleMessage(index, event.data);
		});
		worker.addEventListener('error', () => {
			this.#busy.delete(index);
			this.#errors += 1;
			this.#pump();
		});
		this.#workers.push(worker);
		this.#send(worker, { type: 'init', preferredBackend: this.#preferredBackend });
	}

	#send(worker: Worker, message: ClassifierWorkerRequest, transfer?: Transferable[]) {
		if (transfer) worker.postMessage(message, transfer);
		else worker.postMessage(message);
	}

	#handleMessage(index: number, message: ClassifierWorkerResponse) {
		if (message.type === 'ready') {
			this.#readyWorkers += 1;
			this.#backend = message.backend;
			this.#emitStats();
			this.#pump();
			return;
		}
		if (message.type === 'fatal') {
			this.#backend = `failed: ${message.message}`;
			this.#emitStats();
			return;
		}
		if (message.type === 'progress') {
			this.#backend = message.stage;
			this.#emitStats();
			return;
		}
		if (message.type === 'textResult') {
			this.#textRequests.get(message.id)?.(message.embedding);
			this.#textRequests.delete(message.id);
			this.#textErrors.delete(message.id);
			return;
		}

		// A failed text request reports as a plain error keyed by its request id.
		if (message.type === 'error' && this.#textErrors.has(message.id)) {
			this.#textErrors.get(message.id)?.(new Error(message.message));
			this.#textErrors.delete(message.id);
			this.#textRequests.delete(message.id);
			return;
		}

		this.#busy.delete(index);
		this.#pending.delete(message.id);
		if (message.type === 'result') {
			this.#classified += 1;
			this.#completions.push(performance.now());
			// Exponential moving average keeps the readout stable without a histogram.
			this.#avgMs = this.#avgMs === 0 ? message.durationMs : this.#avgMs * 0.9 + message.durationMs * 0.1;
			this.#onResult(message.id, message.predictions, message.embedding);
		} else {
			this.#errors += 1;
		}
		this.#emitStats();
		this.#pump();
	}

	#idleWorkerIndex(): number {
		for (let index = 0; index < this.#workers.length; index += 1) {
			if (!this.#busy.has(index)) return index;
		}
		return -1;
	}

	#pump() {
		if (this.#disposed) return;

		// Stage 2 first: never let a decoded bitmap sit while a worker idles.
		while (this.#ready.length > 0) {
			const index = this.#idleWorkerIndex();
			if (index === -1) break;
			const entry = this.#ready.shift();
			if (!entry) break;
			this.#busy.add(index);
			this.#pending.set(entry.job.id, entry.job);
			this.#send(
				this.#workers[index],
				{
					type: 'classify',
					id: entry.job.id,
					bitmap: entry.bitmap,
					topK: this.#topK,
					embed: this.#embed
				},
				[entry.bitmap]
			);
		}

		// Stage 1: keep a shallow buffer of decoded frames ahead of the workers.
		const readyTarget = Math.max(2, this.#workers.length * 2);
		while (
			this.#queue.length > 0 &&
			this.#decoding < this.#fetchConcurrency &&
			this.#ready.length + this.#decoding < readyTarget
		) {
			const job = this.#queue.shift();
			if (!job) break;
			this.#decoding += 1;
			void this.#decode(job);
		}
	}

	async #decode(job: ClassifierJob) {
		try {
			const response = await fetch(job.url, { mode: 'cors', credentials: 'omit' });
			if (!response.ok) throw new Error(`thumb ${response.status}`);
			const blob = await response.blob();
			// Resize during decode so neither the main thread nor the GPU handles full frames.
			const bitmap = await createImageBitmap(blob, {
				resizeWidth: INPUT_SIZE,
				resizeHeight: INPUT_SIZE,
				resizeQuality: 'medium'
			});
			if (this.#disposed) {
				bitmap.close();
				return;
			}
			this.#ready.push({ job, bitmap });
		} catch {
			this.#errors += 1;
		} finally {
			this.#decoding -= 1;
			this.#pump();
			this.#emitStats();
		}
	}

	#emitStats() {
		this.#onStats?.(this.stats);
	}
}
