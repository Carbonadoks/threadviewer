/// <reference lib="webworker" />
// SigLIP 2 (base/patch16/224) embeddings, one model instance per worker.
//
// The two towers load independently: the vision tower (~55MB at q4f16) comes up
// with the worker, while the text tower is far heavier — SigLIP 2 uses the Gemma
// tokenizer, so its 256k-row embedding matrix dominates the file — and is only
// fetched the first time someone actually runs a text query.
import {
	AutoProcessor,
	AutoTokenizer,
	RawImage,
	SiglipTextModel,
	SiglipVisionModel,
	env,
	type DataType,
	type PreTrainedModel,
	type PreTrainedTokenizer,
	type Processor
} from '@huggingface/transformers';

import type {
	ClassifierWorkerRequest,
	ClassifierWorkerResponse
} from '$lib/utils/classifierTypes';

const MODEL_ID = 'onnx-community/siglip2-base-patch16-224-ONNX';
const INPUT_SIZE = 224;
// SigLIP trains on fixed 64-token text. This MUST be passed explicitly: the repo's
// tokenizer_config reports model_max_length = 1e30, so `padding: 'max_length'`
// without it tries to allocate a 1e30-element array and throws
// "RangeError: Invalid array length".
const TEXT_MAX_LENGTH = 64;

// Weights come from the Hugging Face CDN; there is no local model directory.
env.allowLocalModels = false;

let vision: { model: PreTrainedModel; processor: Processor } | null = null;
let visionLoading: Promise<{ model: PreTrainedModel; processor: Processor }> | null = null;
let text: { model: PreTrainedModel; tokenizer: PreTrainedTokenizer } | null = null;
let textLoading: Promise<{ model: PreTrainedModel; tokenizer: PreTrainedTokenizer }> | null = null;
let device: 'webgpu' | 'wasm' = 'webgpu';
let canvas: OffscreenCanvas | null = null;
let ctx: OffscreenCanvasRenderingContext2D | null = null;

function post(message: ClassifierWorkerResponse, transfer?: Transferable[]) {
	if (transfer) self.postMessage(message, transfer);
	else self.postMessage(message);
}

function progress(stage: string) {
	post({ type: 'progress', stage });
}

// An fp16 dtype needs the adapter to expose `shader-f16`. Plenty of capable GPUs
// do not (Chrome on Linux/Vulkan in particular), and the failure surfaces as a
// shader compile error at OrtRun time rather than at load, so ask up front.
async function detectDevice(): Promise<{ device: 'webgpu' | 'wasm'; f16: boolean }> {
	const gpu = (navigator as Navigator & { gpu?: GPU }).gpu;
	if (!gpu) return { device: 'wasm', f16: false };
	try {
		const adapter = await gpu.requestAdapter();
		if (!adapter) return { device: 'wasm', f16: false };
		return { device: 'webgpu', f16: adapter.features.has('shader-f16') };
	} catch {
		return { device: 'wasm', f16: false };
	}
}

// Feature detection still is not proof: run one real inference before committing
// to a dtype, and fall through to the next candidate if the shaders will not run.
async function warmupVision(model: PreTrainedModel, processor: Processor) {
	const blank = new RawImage(
		new Uint8ClampedArray(INPUT_SIZE * INPUT_SIZE * 3),
		INPUT_SIZE,
		INPUT_SIZE,
		3
	);
	const inputs = await processor(blank);
	await model(inputs);
}

async function loadVision() {
	if (vision) return vision;
	if (!visionLoading) {
		visionLoading = (async () => {
			const processor = await AutoProcessor.from_pretrained(MODEL_ID);
			const detected = await detectDevice();
			device = detected.device;
			const candidates: DataType[] =
				device === 'wasm' ? ['q8'] : detected.f16 ? ['q4f16', 'q4', 'q8'] : ['q4', 'q8', 'fp32'];

			let lastError: unknown = null;
			for (const dtype of candidates) {
				try {
					progress(`vision ${dtype} loading`);
					const model = await SiglipVisionModel.from_pretrained(MODEL_ID, {
						dtype,
						device,
						progress_callback: (info: { status?: string; progress?: number }) => {
							if (info?.status === 'progress' && typeof info.progress === 'number') {
								progress(`vision ${dtype} ${Math.round(info.progress)}%`);
							}
						}
					});
					await warmupVision(model, processor);
					vision = { model, processor };
					return vision;
				} catch (error) {
					lastError = error;
					progress(`vision ${dtype} unsupported, retrying`);
				}
			}
			throw lastError instanceof Error ? lastError : new Error('no usable vision dtype');
		})().catch((error) => {
			// Clear the memo so a later request can retry instead of inheriting a
			// permanently rejected promise.
			visionLoading = null;
			throw error;
		});
	}
	return visionLoading;
}

async function loadText() {
	if (text) return text;
	if (!textLoading) {
		textLoading = (async () => {
			progress('text tower downloading');
			const tokenizer = await AutoTokenizer.from_pretrained(MODEL_ID);
			const onProgress = (info: { status?: string; progress?: number }) => {
				if (info?.status === 'progress' && typeof info.progress === 'number') {
					progress(`text ${Math.round(info.progress)}%`);
				}
			};
			// q8 carries no f16 dependency, but keep a wasm fallback for GPU refusals.
			let model: PreTrainedModel;
			try {
				model = await SiglipTextModel.from_pretrained(MODEL_ID, {
					dtype: 'q8',
					device,
					progress_callback: onProgress
				});
			} catch {
				progress('text falling back to wasm');
				model = await SiglipTextModel.from_pretrained(MODEL_ID, {
					dtype: 'q8',
					device: 'wasm',
					progress_callback: onProgress
				});
			}
			text = { model, tokenizer };
			return text;
		})().catch((error) => {
			textLoading = null;
			throw error;
		});
	}
	return textLoading;
}

// L2-normalize so cosine similarity is a plain dot product on the main thread.
function normalize(data: Float32Array): Float32Array {
	let sum = 0;
	for (const value of data) sum += value * value;
	const norm = Math.sqrt(sum) || 1;
	const out = new Float32Array(data.length);
	for (let i = 0; i < data.length; i += 1) out[i] = data[i] / norm;
	return out;
}

function toRawImage(bitmap: ImageBitmap): RawImage {
	if (!canvas || !ctx) {
		canvas = new OffscreenCanvas(INPUT_SIZE, INPUT_SIZE);
		ctx = canvas.getContext('2d', { willReadFrequently: true });
	}
	if (!ctx) throw new Error('2d context unavailable in worker');
	ctx.clearRect(0, 0, INPUT_SIZE, INPUT_SIZE);
	ctx.drawImage(bitmap, 0, 0, INPUT_SIZE, INPUT_SIZE);
	const { data, width, height } = ctx.getImageData(0, 0, INPUT_SIZE, INPUT_SIZE);
	return new RawImage(new Uint8ClampedArray(data), width, height, 4).rgb();
}

async function handleImage(id: string, bitmap: ImageBitmap) {
	const startedAt = performance.now();
	try {
		const { model, processor } = await loadVision();
		const inputs = await processor(toRawImage(bitmap));
		const { pooler_output } = await model(inputs);
		const embedding = normalize(pooler_output.data as Float32Array);
		post(
			{
				type: 'result',
				id,
				predictions: [],
				embedding,
				durationMs: performance.now() - startedAt
			},
			[embedding.buffer]
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

async function handleText(id: string, value: string) {
	try {
		const { model, tokenizer } = await loadText();
		const inputs = tokenizer([value], {
			padding: 'max_length',
			max_length: TEXT_MAX_LENGTH,
			truncation: true
		});
		const { pooler_output } = await model(inputs);
		const embedding = normalize(pooler_output.data as Float32Array);
		post({ type: 'textResult', id, embedding }, [embedding.buffer]);
	} catch (error) {
		post({
			type: 'error',
			id,
			message: error instanceof Error ? error.message : String(error)
		});
	}
}

self.addEventListener('message', (event: MessageEvent<ClassifierWorkerRequest>) => {
	const message = event.data;
	if (message.type === 'init') {
		void loadVision()
			.then(() => post({ type: 'ready', backend: `siglip2/${device}` }))
			.catch((error) =>
				post({
					type: 'fatal',
					message: error instanceof Error ? error.message : String(error)
				})
			);
		return;
	}
	if (message.type === 'classify') {
		void handleImage(message.id, message.bitmap);
		return;
	}
	if (message.type === 'embedText') {
		void handleText(message.id, message.text);
	}
});
