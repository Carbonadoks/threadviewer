// Shared message contract between the classifier pool and its workers.

export type Prediction = {
	label: string;
	probability: number;
};

export type ClassifierWorkerRequest =
	| { type: 'init'; preferredBackend: string }
	| { type: 'classify'; id: string; bitmap: ImageBitmap; topK: number; embed: boolean }
	| { type: 'embedText'; id: string; text: string };

export type ClassifierWorkerResponse =
	| { type: 'ready'; backend: string }
	| { type: 'progress'; stage: string }
	| { type: 'textResult'; id: string; embedding: Float32Array }
	| {
			type: 'result';
			id: string;
			predictions: Prediction[];
			// L2-normalized penultimate-layer features, so cosine similarity is a dot product.
			embedding?: Float32Array;
			durationMs: number;
	  }
	| { type: 'error'; id: string; message: string }
	| { type: 'fatal'; message: string };
