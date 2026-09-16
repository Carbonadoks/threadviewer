/// <reference lib="webworker" />
// One MobileNet v2 instance per worker. The pool spawns several of these so a
// discrete GPU can stay busy; each worker owns its own backend + model copy.
import * as tf from '@tensorflow/tfjs';
import '@tensorflow/tfjs-backend-webgpu';
import * as mobilenet from '@tensorflow-models/mobilenet';

import type {
	ClassifierWorkerRequest,
	ClassifierWorkerResponse,
	Prediction
} from '$lib/utils/classifierTypes';

const INPUT_SIZE = 224;

let model: mobilenet.MobileNet | null = null;
let loading: Promise<mobilenet.MobileNet> | null = null;
let backend = 'unknown';
let canvas: OffscreenCanvas | null = null;
let ctx: OffscreenCanvasRenderingContext2D | null = null;

function post(message: ClassifierWorkerResponse, transfer?: Transferable[]) {
	if (transfer) self.postMessage(message, transfer);
	else self.postMessage(message);
}

// webgpu first (that is where a real GPU pays off), then webgl, then plain cpu.
async function selectBackend(preferred: string): Promise<string> {
	const order = preferred === 'webgl' ? ['webgl', 'webgpu', 'cpu'] : ['webgpu', 'webgl', 'cpu'];
	for (const candidate of order) {
		if (candidate === 'webgpu' && !('gpu' in navigator)) continue;
		try {
			if (await tf.setBackend(candidate)) {
				await tf.ready();
				return tf.getBackend();
			}
		} catch {
			// Try the next backend; a missing GPU adapter throws rather than returning false.
		}
	}
	await tf.ready();
	return tf.getBackend();
}

async function ensureModel(preferredBackend: string): Promise<mobilenet.MobileNet> {
	if (model) return model;
	if (!loading) {
		loading = (async () => {
			backend = await selectBackend(preferredBackend);
			const loaded = await mobilenet.load({ version: 2, alpha: 1.0 });
			model = loaded;
			return loaded;
		})();
	}
	return loading;
}

// ImageBitmap -> ImageData: the ImageData path into fromPixels needs no DOM, so it
// works the same on every backend inside a worker.
function toImageData(bitmap: ImageBitmap): ImageData {
	if (!canvas || !ctx) {
		canvas = new OffscreenCanvas(INPUT_SIZE, INPUT_SIZE);
		ctx = canvas.getContext('2d', { willReadFrequently: true });
	}
	if (!ctx) throw new Error('2d context unavailable in worker');
	ctx.clearRect(0, 0, INPUT_SIZE, INPUT_SIZE);
	ctx.drawImage(bitmap, 0, 0, INPUT_SIZE, INPUT_SIZE);
	return ctx.getImageData(0, 0, INPUT_SIZE, INPUT_SIZE);
}

// MobileNet's penultimate layer, L2-normalized so cosine similarity is a dot
// product. Costs a second forward pass — infer() and classify() read different
// output tensors — so it stays opt-in.
async function embedImage(net: mobilenet.MobileNet, pixels: ImageData): Promise<Float32Array> {
	const normalized = tf.tidy(() => {
		const features = net.infer(pixels, true) as tf.Tensor2D;
		return tf.div<tf.Tensor2D>(features, tf.norm(features, 'euclidean', 1, true));
	});
	const data = await normalized.data();
	normalized.dispose();
	return data instanceof Float32Array ? data : new Float32Array(data);
}

async function handleClassify(id: string, bitmap: ImageBitmap, topK: number, embed: boolean) {
	const startedAt = performance.now();
	try {
		const net = await ensureModel(backend);
		const pixels = toImageData(bitmap);
		const raw = await net.classify(pixels, topK);
		const predictions: Prediction[] = raw.map((entry) => ({
			label: entry.className,
			probability: entry.probability
		}));
		const embedding = embed ? await embedImage(net, pixels) : undefined;
		post(
			{
				type: 'result',
				id,
				predictions,
				embedding,
				durationMs: performance.now() - startedAt
			},
			embedding ? [embedding.buffer] : undefined
		);
	} catch (error) {
		post({
			type: 'error',
			id,
			message: error instanceof Error ? error.message : String(error)
		});
	} finally {
		bitmap.close();
	}
}

self.addEventListener('message', (event: MessageEvent<ClassifierWorkerRequest>) => {
	const message = event.data;
	if (message.type === 'init') {
		void ensureModel(message.preferredBackend)
			.then(() => post({ type: 'ready', backend }))
			.catch((error) =>
				post({
					type: 'fatal',
					message: error instanceof Error ? error.message : String(error)
				})
			);
		return;
	}
	if (message.type === 'classify') {
		void handleClassify(message.id, message.bitmap, message.topK, message.embed);
	}
});
