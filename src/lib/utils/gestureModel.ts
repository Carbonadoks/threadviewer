// Custom gesture model shared between /handtrainer (training + persistence)
// and /handtracker (inference). The model is a tiny MLP over hand landmarks:
// FEATURE_SIZE inputs -> hidden ReLU layer -> softmax over trained classes.

export type Point3 = { x: number; y: number; z: number };

export type TrainedModel = {
	classes: string[];
	// input -> hidden
	W1: number[][];
	b1: number[];
	// hidden -> output
	W2: number[][];
	b2: number[];
};

export const GESTURE_STORAGE_KEY = 'handtrainer:v1';
// 20 landmarks (skip wrist) x 3, wrist-relative, scale-normalized.
export const FEATURE_SIZE = 60;

export function dist3(a: Point3, b: Point3): number {
	return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

/**
 * Wrist-relative, scale-normalized feature vector from world landmarks.
 * Invariant to hand position and distance from the camera.
 */
export function landmarksToFeatures(world: Point3[]): number[] {
	const wrist = world[0];
	const scale = dist3(world[9], wrist) || 1;
	const feats: number[] = [];
	for (let i = 1; i < 21; i++) {
		feats.push(
			(world[i].x - wrist.x) / scale,
			(world[i].y - wrist.y) / scale,
			(world[i].z - wrist.z) / scale
		);
	}
	return feats;
}

export function softmax(logits: number[]): number[] {
	const max = Math.max(...logits);
	const exps = logits.map((v) => Math.exp(v - max));
	const sum = exps.reduce((a, b) => a + b, 0);
	return exps.map((v) => v / sum);
}

export function forward(model: TrainedModel, x: number[]): { hidden: number[]; probs: number[] } {
	const hidden = model.b1.map((b, j) => {
		let s = b;
		const w = model.W1[j];
		for (let i = 0; i < x.length; i++) s += w[i] * x[i];
		return Math.max(0, s);
	});
	const logits = model.b2.map((b, k) => {
		let s = b;
		const w = model.W2[k];
		for (let j = 0; j < hidden.length; j++) s += w[j] * hidden[j];
		return s;
	});
	return { hidden, probs: softmax(logits) };
}

/** Loads the model trained on /handtrainer from localStorage, if any. */
export function loadTrainedGestureModel(): TrainedModel | null {
	try {
		const raw = localStorage.getItem(GESTURE_STORAGE_KEY);
		if (!raw) return null;
		const model = JSON.parse(raw)?.model;
		return model?.classes?.length ? (model as TrainedModel) : null;
	} catch (err) {
		console.warn('gestureModel: failed to load trained model', err);
		return null;
	}
}
