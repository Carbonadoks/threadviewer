<script lang="ts">
	import { onMount } from 'svelte';
	import '../../app.css';
	import {
		FEATURE_SIZE,
		GESTURE_STORAGE_KEY as STORAGE_KEY,
		dist3,
		forward,
		landmarksToFeatures,
		type Point3,
		type TrainedModel
	} from '$lib/utils/gestureModel';

	// ---- Types ----

	type GestureClass = {
		name: string;
		samples: number[][];
	};

	// ---- Constants ----

	const GESTURE_MODEL_URL =
		'https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task';

	// Canonical classes the bundled MediaPipe gesture model was pretrained on.
	const PRETRAINED_CLASSES: { id: string; label: string; icon: string }[] = [
		{ id: 'Closed_Fist', label: 'Closed Fist', icon: '✊' },
		{ id: 'Open_Palm', label: 'Open Palm', icon: '🖐️' },
		{ id: 'Pointing_Up', label: 'Pointing Up', icon: '☝️' },
		{ id: 'Thumb_Down', label: 'Thumb Down', icon: '👎' },
		{ id: 'Thumb_Up', label: 'Thumb Up', icon: '👍' },
		{ id: 'Victory', label: 'Victory', icon: '✌️' },
		{ id: 'ILoveYou', label: 'I Love You', icon: '🤟' },
		{ id: 'None', label: 'None', icon: '·' }
	];

	const HAND_CONNECTIONS: [number, number][] = [
		[0, 1], [1, 2], [2, 3], [3, 4],
		[0, 5], [5, 6], [6, 7], [7, 8],
		[5, 9], [9, 10], [10, 11], [11, 12],
		[9, 13], [13, 14], [14, 15], [15, 16],
		[13, 17], [17, 18], [18, 19], [19, 20],
		[0, 17]
	];
	// Palm outline for the constructed hand's filled base.
	const PALM_LOOP = [0, 1, 5, 9, 13, 17];

	const HIDDEN_SIZE = 24;
	const RECORD_COUNTDOWN_MS = 1500;
	const RECORD_DURATION_MS = 2500;
	const MIN_SAMPLES_PER_CLASS = 20;

	// ---- Tracker state ----

	let videoEl: HTMLVideoElement;
	let overlayEl: HTMLCanvasElement;
	let handCanvasEl: HTMLCanvasElement;

	let trackerStatus = $state<'loading' | 'ready' | 'error'>('loading');
	let trackerMessage = $state('Loading gesture model…');
	let handVisible = $state(false);
	let handednessLabel = $state('');
	let fps = $state(0);

	// Pretrained model live output.
	let pretrainedScores = $state<Record<string, number>>({});
	let pretrainedTop = $state<{ id: string; score: number } | null>(null);

	// ---- Right panel tabs ----

	let activeTab = $state<'pretrained' | 'trainer' | 'tuning'>('pretrained');

	// ---- Trainer state ----

	let classes = $state<GestureClass[]>([]);
	let newClassName = $state('');
	let trainedModel = $state<TrainedModel | null>(null);
	let training = $state(false);
	let trainStatus = $state('');
	let liveProbs = $state<Record<string, number>>({});
	let liveTop = $state<{ name: string; prob: number } | null>(null);

	// Recording session (mutated from the video loop, mirrored into $state below).
	let recordingClass = $state<string | null>(null);
	let recordPhase = $state<'idle' | 'countdown' | 'recording'>('idle');
	let recordProgress = $state(0);
	let recordStart = 0;
	let recordBuffer: number[][] = [];

	// Smoothed probabilities for stable bars.
	let probEma: Record<string, number> = {};

	// ---- Dynamic gesture tuning (rule-based swipes + click, no training) ----

	const TUNING_KEY = 'handtrainer:tuning:v1';
	const TUNING_DEFAULTS = {
		// Wrist speed (in hand-sizes/second) that counts as a swipe.
		swipeVel: 2.2,
		// Consecutive fast frames needed before a swipe fires.
		swipeFrames: 4,
		// How much the dominant axis must beat the other to pick a direction.
		axisDom: 1.3,
		// Refractory period after any fired gesture.
		cooldownMs: 600,
		// Index-tip dip toward the camera (in hand-sizes) that counts as a click.
		clickDepth: 0.35,
		// The dip must return within this window to be a click.
		clickReturnMs: 450,
		// EMA factor for velocity smoothing (higher = snappier, noisier).
		smoothing: 0.5
	};

	let tuning = $state({ ...TUNING_DEFAULTS });
	let dynEvents = $state<{ id: number; name: string; icon: string; at: number }[]>([]);
	let lastDynEvent = $state<{ name: string; icon: string } | null>(null);
	let liveSpeed = $state(0);
	let livePoke = $state(0);

	let dynPrev: { x: number; y: number; zRel: number; t: number } | null = null;
	let dynVx = 0;
	let dynVy = 0;
	let dynZVel = 0;
	let swipeDir: string | null = null;
	let swipeRun = 0;
	let dynCooldownUntil = 0;
	let clickState = $state<'idle' | 'dip'>('idle');
	let clickBase = 0;
	let clickMin = 0;
	let clickStart = 0;
	let dynEventId = 0;

	const SWIPE_ICONS: Record<string, string> = { left: '⬅️', right: '➡️', up: '⬆️', down: '⬇️' };

	function resetDynamics() {
		dynPrev = null;
		dynVx = 0;
		dynVy = 0;
		dynZVel = 0;
		swipeDir = null;
		swipeRun = 0;
		clickState = 'idle';
		liveSpeed = 0;
		livePoke = 0;
	}

	function fireDynGesture(name: string, icon: string, now: number) {
		lastDynEvent = { name, icon };
		dynEvents = [{ id: dynEventId++, name, icon, at: Date.now() }, ...dynEvents].slice(0, 8);
		dynCooldownUntil = now + tuning.cooldownMs;
		swipeDir = null;
		swipeRun = 0;
		clickState = 'idle';
	}

	/**
	 * Rule-based dynamic gestures over the tracked landmarks: sustained fast
	 * wrist motion along a dominant axis fires a swipe; an index-tip poke
	 * toward the camera that returns within a window fires a click.
	 * Velocities are in hand-sizes/second, so distance from the camera
	 * cancels out.
	 */
	function updateDynamics(landmarks: Point3[], world: Point3[], now: number) {
		const handSize = Math.hypot(
			landmarks[9].x - landmarks[0].x,
			landmarks[9].y - landmarks[0].y
		);
		if (handSize < 1e-6) return;
		const worldSize = dist3(world[9], world[0]) || 1;
		// Index-tip depth relative to the wrist; more negative = toward camera.
		const zRel = (world[8].z - world[0].z) / worldSize;
		const cur = { x: landmarks[0].x / handSize, y: landmarks[0].y / handSize, zRel, t: now };
		if (!dynPrev) {
			dynPrev = cur;
			return;
		}
		const dt = (now - dynPrev.t) / 1000;
		if (dt <= 0) return;
		const a = tuning.smoothing;
		// Mirror x so "swipe right" matches the mirrored on-screen view.
		dynVx += (-(cur.x - dynPrev.x) / dt - dynVx) * a;
		dynVy += ((cur.y - dynPrev.y) / dt - dynVy) * a;
		dynZVel += ((cur.zRel - dynPrev.zRel) / dt - dynZVel) * a;
		dynPrev = cur;

		liveSpeed = Math.hypot(dynVx, dynVy);
		livePoke = Math.max(0, -dynZVel);

		if (now < dynCooldownUntil) {
			swipeDir = null;
			swipeRun = 0;
			return;
		}

		// Swipes.
		const ax = Math.abs(dynVx);
		const ay = Math.abs(dynVy);
		let dir: string | null = null;
		if (liveSpeed >= tuning.swipeVel) {
			if (ax >= ay * tuning.axisDom) dir = dynVx > 0 ? 'right' : 'left';
			else if (ay >= ax * tuning.axisDom) dir = dynVy > 0 ? 'down' : 'up';
		}
		if (dir !== null && dir === swipeDir) {
			swipeRun += 1;
			if (swipeRun >= tuning.swipeFrames) {
				fireDynGesture(`swipe ${dir}`, SWIPE_ICONS[dir], now);
				return;
			}
		} else {
			swipeDir = dir;
			swipeRun = dir ? 1 : 0;
		}

		// Click: poke toward the camera that comes back quickly.
		if (clickState === 'idle') {
			if (dynZVel < -1.5 && liveSpeed < tuning.swipeVel) {
				clickState = 'dip';
				clickBase = zRel;
				clickMin = zRel;
				clickStart = now;
			}
		} else {
			clickMin = Math.min(clickMin, zRel);
			if (now - clickStart > tuning.clickReturnMs) {
				clickState = 'idle';
			} else if (
				clickBase - clickMin >= tuning.clickDepth &&
				zRel >= clickBase - tuning.clickDepth * 0.3
			) {
				fireDynGesture('click', '🖱️', now);
			}
		}
	}

	function persistTuning() {
		try {
			localStorage.setItem(TUNING_KEY, JSON.stringify($state.snapshot(tuning)));
		} catch (err) {
			console.warn('handtrainer: failed to persist tuning', err);
		}
	}

	function restoreTuning() {
		try {
			const raw = localStorage.getItem(TUNING_KEY);
			if (raw) tuning = { ...TUNING_DEFAULTS, ...JSON.parse(raw) };
		} catch (err) {
			console.warn('handtrainer: failed to restore tuning', err);
		}
	}

	function resetTuning() {
		tuning = { ...TUNING_DEFAULTS };
		persistTuning();
	}

	// ---- Constructed hand view state ----

	let viewYaw = 0;
	let viewPitch = 0;
	let dragging = false;
	let dragLast = { x: 0, y: 0 };
	let smoothWorld: Point3[] | null = null;

	// ---- Tiny MLP training (FEATURE_SIZE -> 24 ReLU -> softmax) ----
	// Feature extraction and the forward pass live in $lib/utils/gestureModel
	// so /handtracker can run inference with the same code.

	function randMatrix(rows: number, cols: number, scale: number): number[][] {
		return Array.from({ length: rows }, () =>
			Array.from({ length: cols }, () => (Math.random() * 2 - 1) * scale)
		);
	}

	async function trainModel() {
		const usable = classes.filter((c) => c.samples.length >= MIN_SAMPLES_PER_CLASS);
		if (usable.length < 2) return;

		training = true;
		trainStatus = 'Preparing data…';
		await new Promise((r) => setTimeout(r, 0));

		const classNames = usable.map((c) => c.name);
		const X: number[][] = [];
		const y: number[] = [];
		usable.forEach((c, idx) => {
			for (const s of c.samples) {
				X.push(s);
				y.push(idx);
			}
		});

		const C = classNames.length;
		const model: TrainedModel = {
			classes: classNames,
			W1: randMatrix(HIDDEN_SIZE, FEATURE_SIZE, Math.sqrt(2 / FEATURE_SIZE)),
			b1: new Array(HIDDEN_SIZE).fill(0),
			W2: randMatrix(C, HIDDEN_SIZE, Math.sqrt(2 / HIDDEN_SIZE)),
			b2: new Array(C).fill(0)
		};

		const EPOCHS = 200;
		const LR = 0.05;
		const L2 = 1e-4;
		const n = X.length;

		for (let epoch = 0; epoch < EPOCHS; epoch++) {
			// Full-batch gradient accumulators.
			const gW1 = model.W1.map((row) => row.map(() => 0));
			const gb1 = new Array(HIDDEN_SIZE).fill(0);
			const gW2 = model.W2.map((row) => row.map(() => 0));
			const gb2 = new Array(C).fill(0);
			let loss = 0;

			for (let s = 0; s < n; s++) {
				const x = X[s];
				const { hidden, probs } = forward(model, x);
				loss -= Math.log(Math.max(probs[y[s]], 1e-9));

				// dL/dlogits = probs - onehot
				const dLogits = probs.map((p, k) => p - (k === y[s] ? 1 : 0));
				const dHidden = new Array(HIDDEN_SIZE).fill(0);
				for (let k = 0; k < C; k++) {
					gb2[k] += dLogits[k];
					for (let j = 0; j < HIDDEN_SIZE; j++) {
						gW2[k][j] += dLogits[k] * hidden[j];
						dHidden[j] += dLogits[k] * model.W2[k][j];
					}
				}
				for (let j = 0; j < HIDDEN_SIZE; j++) {
					if (hidden[j] <= 0) continue; // ReLU gate
					gb1[j] += dHidden[j];
					for (let i = 0; i < FEATURE_SIZE; i++) gW1[j][i] += dHidden[j] * x[i];
				}
			}

			const step = LR / n;
			for (let j = 0; j < HIDDEN_SIZE; j++) {
				model.b1[j] -= step * gb1[j];
				for (let i = 0; i < FEATURE_SIZE; i++)
					model.W1[j][i] -= step * gW1[j][i] + LR * L2 * model.W1[j][i];
			}
			for (let k = 0; k < C; k++) {
				model.b2[k] -= step * gb2[k];
				for (let j = 0; j < HIDDEN_SIZE; j++)
					model.W2[k][j] -= step * gW2[k][j] + LR * L2 * model.W2[k][j];
			}

			if (epoch % 20 === 0) {
				trainStatus = `Training… epoch ${epoch}/${EPOCHS}, loss ${(loss / n).toFixed(3)}`;
				await new Promise((r) => setTimeout(r, 0));
			}
		}

		// Training accuracy as a sanity check.
		let correct = 0;
		for (let s = 0; s < n; s++) {
			const { probs } = forward(model, X[s]);
			if (probs.indexOf(Math.max(...probs)) === y[s]) correct += 1;
		}

		trainedModel = model;
		probEma = {};
		trainStatus = `Trained on ${n} samples · ${((correct / n) * 100).toFixed(1)}% train accuracy`;
		training = false;
		persist();
	}

	// ---- Trainer class management ----

	function addClass() {
		const name = newClassName.trim();
		if (!name || classes.some((c) => c.name === name)) return;
		classes = [...classes, { name, samples: [] }];
		newClassName = '';
		persist();
	}

	function deleteClass(name: string) {
		classes = classes.filter((c) => c.name !== name);
		if (trainedModel?.classes.includes(name)) trainedModel = null;
		persist();
	}

	function clearSamples(name: string) {
		classes = classes.map((c) => (c.name === name ? { ...c, samples: [] } : c));
		if (trainedModel?.classes.includes(name)) trainedModel = null;
		persist();
	}

	function startRecording(name: string) {
		if (recordPhase !== 'idle' || training) return;
		recordingClass = name;
		recordPhase = 'countdown';
		recordProgress = 0;
		recordStart = performance.now();
		recordBuffer = [];
	}

	/** Advances the record state machine from the video loop; captures features. */
	function updateRecording(now: number, features: number[] | null) {
		if (recordPhase === 'idle') return;
		const elapsed = now - recordStart;
		if (recordPhase === 'countdown') {
			recordProgress = Math.min(1, elapsed / RECORD_COUNTDOWN_MS);
			if (elapsed >= RECORD_COUNTDOWN_MS) {
				recordPhase = 'recording';
				recordStart = now;
				recordProgress = 0;
			}
			return;
		}
		recordProgress = Math.min(1, elapsed / RECORD_DURATION_MS);
		if (features) recordBuffer.push(features);
		if (elapsed >= RECORD_DURATION_MS) finishRecording();
	}

	function finishRecording() {
		const name = recordingClass;
		const captured = recordBuffer;
		recordPhase = 'idle';
		recordingClass = null;
		recordBuffer = [];
		if (!name || captured.length === 0) return;
		classes = classes.map((c) =>
			c.name === name ? { ...c, samples: [...c.samples, ...captured] } : c
		);
		// Samples changed; a previously trained model is stale for this class.
		if (trainedModel?.classes.includes(name)) trainStatus = 'Samples changed — retrain to update';
		persist();
	}

	function cancelRecording() {
		recordPhase = 'idle';
		recordingClass = null;
		recordBuffer = [];
	}

	// ---- Persistence ----

	function persist() {
		try {
			localStorage.setItem(
				STORAGE_KEY,
				JSON.stringify({ classes: $state.snapshot(classes), model: $state.snapshot(trainedModel) })
			);
		} catch (err) {
			console.warn('handtrainer: failed to persist', err);
		}
	}

	function restore() {
		try {
			const raw = localStorage.getItem(STORAGE_KEY);
			if (!raw) return;
			const data = JSON.parse(raw);
			if (Array.isArray(data.classes)) classes = data.classes;
			if (data.model?.classes?.length) trainedModel = data.model;
		} catch (err) {
			console.warn('handtrainer: failed to restore', err);
		}
	}

	// ---- Camera overlay drawing ----

	function drawOverlay(ctx: CanvasRenderingContext2D, landmarks: Point3[], w: number, h: number) {
		ctx.strokeStyle = 'rgba(80, 220, 140, 0.9)';
		ctx.lineWidth = 3;
		for (const [a, b] of HAND_CONNECTIONS) {
			ctx.beginPath();
			ctx.moveTo(landmarks[a].x * w, landmarks[a].y * h);
			ctx.lineTo(landmarks[b].x * w, landmarks[b].y * h);
			ctx.stroke();
		}
		ctx.fillStyle = 'rgba(255, 255, 255, 0.95)';
		for (const lm of landmarks) {
			ctx.beginPath();
			ctx.arc(lm.x * w, lm.y * h, 4, 0, Math.PI * 2);
			ctx.fill();
		}
	}

	// ---- Constructed hand drawing ----

	function rotatePoint(p: Point3, yaw: number, pitch: number): Point3 {
		// Mirror x so the constructed hand matches the mirrored camera view.
		let x = -p.x;
		let y = p.y;
		let z = p.z;
		const cy = Math.cos(yaw);
		const sy = Math.sin(yaw);
		const x2 = x * cy + z * sy;
		const z2 = -x * sy + z * cy;
		const cp = Math.cos(pitch);
		const sp = Math.sin(pitch);
		const y2 = y * cp - z2 * sp;
		const z3 = y * sp + z2 * cp;
		return { x: x2, y: y2, z: z3 };
	}

	function drawConstructedHand(ctx: CanvasRenderingContext2D, world: Point3[], w: number, h: number) {
		ctx.clearRect(0, 0, w, h);

		// Smooth toward the latest frame so the hand moves fluidly.
		if (!smoothWorld) {
			smoothWorld = world.map((p) => ({ ...p }));
		} else {
			for (let i = 0; i < 21; i++) {
				smoothWorld[i].x += (world[i].x - smoothWorld[i].x) * 0.45;
				smoothWorld[i].y += (world[i].y - smoothWorld[i].y) * 0.45;
				smoothWorld[i].z += (world[i].z - smoothWorld[i].z) * 0.45;
			}
		}

		const rotated = smoothWorld.map((p) => rotatePoint(p, viewYaw, viewPitch));
		const cx = rotated.reduce((s, p) => s + p.x, 0) / 21;
		const cyc = rotated.reduce((s, p) => s + p.y, 0) / 21;
		const handSize = dist3(smoothWorld[0], smoothWorld[9]) || 0.08;
		const scale = (0.3 * Math.min(w, h)) / handSize;

		const proj = rotated.map((p) => ({
			x: w / 2 + (p.x - cx) * scale,
			y: h / 2 + (p.y - cyc) * scale,
			z: p.z
		}));

		const zs = proj.map((p) => p.z);
		const zMin = Math.min(...zs);
		const zMax = Math.max(...zs);
		const zRange = Math.max(zMax - zMin, 1e-6);
		// 0 = closest to the viewer, 1 = farthest.
		const depth = (z: number) => (z - zMin) / zRange;

		// Palm plate first (it sits behind the fingers visually).
		ctx.beginPath();
		for (let i = 0; i < PALM_LOOP.length; i++) {
			const p = proj[PALM_LOOP[i]];
			if (i === 0) ctx.moveTo(p.x, p.y);
			else ctx.lineTo(p.x, p.y);
		}
		ctx.closePath();
		ctx.fillStyle = 'rgba(45, 190, 210, 0.14)';
		ctx.strokeStyle = 'rgba(45, 190, 210, 0.4)';
		ctx.lineWidth = 2;
		ctx.fill();
		ctx.stroke();

		// Bones far-to-near so nearer segments paint over farther ones.
		const bones = HAND_CONNECTIONS.map(([a, b]) => ({
			a,
			b,
			z: (proj[a].z + proj[b].z) / 2
		})).sort((p, q) => q.z - p.z);

		for (const bone of bones) {
			const pa = proj[bone.a];
			const pb = proj[bone.b];
			const d = depth(bone.z);
			const width = (7 - d * 4) * (scale / 900 + 0.6);
			const alpha = 0.95 - d * 0.55;
			ctx.strokeStyle = `rgba(85, 225, 235, ${alpha})`;
			ctx.lineWidth = Math.max(1.5, width);
			ctx.lineCap = 'round';
			ctx.beginPath();
			ctx.moveTo(pa.x, pa.y);
			ctx.lineTo(pb.x, pb.y);
			ctx.stroke();
		}

		// Joints, also depth-cued.
		const jointOrder = proj
			.map((p, i) => ({ p, i }))
			.sort((a, b) => b.p.z - a.p.z);
		for (const { p, i } of jointOrder) {
			const d = depth(p.z);
			const r = i === 0 ? 7 - d * 3 : 4.5 - d * 2;
			ctx.beginPath();
			ctx.arc(p.x, p.y, Math.max(1.5, r), 0, Math.PI * 2);
			ctx.fillStyle = `rgba(240, 250, 255, ${0.95 - d * 0.6})`;
			ctx.fill();
		}

		// Fingertips glow.
		for (const tip of [4, 8, 12, 16, 20]) {
			const p = proj[tip];
			const d = depth(p.z);
			ctx.beginPath();
			ctx.arc(p.x, p.y, 6 - d * 2.5, 0, Math.PI * 2);
			ctx.fillStyle = `rgba(120, 255, 200, ${0.8 - d * 0.5})`;
			ctx.fill();
		}
	}

	function drawHandPlaceholder(ctx: CanvasRenderingContext2D, w: number, h: number) {
		ctx.clearRect(0, 0, w, h);
		ctx.fillStyle = 'rgba(120, 135, 150, 0.5)';
		ctx.font = '14px system-ui, sans-serif';
		ctx.textAlign = 'center';
		ctx.fillText('Show your hand to the camera', w / 2, h / 2);
	}

	function onHandPointerDown(e: PointerEvent) {
		dragging = true;
		dragLast = { x: e.clientX, y: e.clientY };
		(e.target as HTMLElement).setPointerCapture(e.pointerId);
	}

	function onHandPointerMove(e: PointerEvent) {
		if (!dragging) return;
		viewYaw += (e.clientX - dragLast.x) * 0.01;
		viewPitch += (e.clientY - dragLast.y) * 0.01;
		viewPitch = Math.max(-1.4, Math.min(1.4, viewPitch));
		dragLast = { x: e.clientX, y: e.clientY };
	}

	function onHandPointerUp() {
		dragging = false;
	}

	function resetView() {
		viewYaw = 0;
		viewPitch = 0;
	}

	// ---- Main loop ----

	onMount(() => {
		restore();
		restoreTuning();

		let cancelled = false;
		let rafId = 0;
		let stream: MediaStream | null = null;
		let recognizer: { recognizeForVideo: Function; close: () => void } | null = null;

		(async () => {
			try {
				const { FilesetResolver, GestureRecognizer } = await import('@mediapipe/tasks-vision');
				const fileset = await FilesetResolver.forVisionTasks(
					'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm'
				);
				const rec = await GestureRecognizer.createFromOptions(fileset, {
					baseOptions: { modelAssetPath: GESTURE_MODEL_URL, delegate: 'GPU' },
					runningMode: 'VIDEO',
					numHands: 1
				});
				if (cancelled) {
					rec.close();
					return;
				}
				recognizer = rec;

				trackerMessage = 'Requesting webcam…';
				stream = await navigator.mediaDevices.getUserMedia({
					video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' },
					audio: false
				});
				if (cancelled) {
					stream.getTracks().forEach((t) => t.stop());
					return;
				}
				videoEl.srcObject = stream;
				await videoEl.play();

				trackerStatus = 'ready';
				trackerMessage = '';

				const overlayCtx = overlayEl.getContext('2d')!;
				const handCtx = handCanvasEl.getContext('2d')!;
				let lastVideoTime = -1;
				let frameCount = 0;
				let fpsWindowStart = performance.now();

				const loop = () => {
					if (cancelled) return;
					rafId = requestAnimationFrame(loop);
					if (!recognizer || videoEl.readyState < 2) return;

					// Keep the constructed-hand canvas sized to its element.
					const hw = handCanvasEl.clientWidth;
					const hh = handCanvasEl.clientHeight;
					if (hw && handCanvasEl.width !== hw) handCanvasEl.width = hw;
					if (hh && handCanvasEl.height !== hh) handCanvasEl.height = hh;

					if (videoEl.currentTime === lastVideoTime) return;
					lastVideoTime = videoEl.currentTime;

					const width = videoEl.videoWidth;
					const height = videoEl.videoHeight;
					if (overlayEl.width !== width) overlayEl.width = width;
					if (overlayEl.height !== height) overlayEl.height = height;

					const now = performance.now();
					const result = recognizer.recognizeForVideo(videoEl, now);

					frameCount += 1;
					if (now - fpsWindowStart >= 1000) {
						fps = Math.round((frameCount * 1000) / (now - fpsWindowStart));
						frameCount = 0;
						fpsWindowStart = now;
					}

					overlayCtx.clearRect(0, 0, width, height);
					const landmarks: Point3[] | undefined = result.landmarks?.[0];
					const world: Point3[] | undefined = result.worldLandmarks?.[0];

					if (landmarks && world) {
						handVisible = true;
						handednessLabel = result.handedness?.[0]?.[0]?.displayName ?? '';
						drawOverlay(overlayCtx, landmarks, width, height);
						drawConstructedHand(handCtx, world, handCanvasEl.width, handCanvasEl.height);

						// Pretrained scores.
						const cats: { categoryName: string; score: number }[] = result.gestures?.[0] ?? [];
						const scores: Record<string, number> = {};
						for (const c of cats) scores[c.categoryName || 'None'] = c.score;
						pretrainedScores = scores;
						pretrainedTop = cats.length
							? { id: cats[0].categoryName || 'None', score: cats[0].score }
							: null;

						updateDynamics(landmarks, world, now);

						const features = landmarksToFeatures(world);
						updateRecording(now, features);

						// Live prediction with the custom model.
						if (trainedModel && !training) {
							const { probs } = forward(trainedModel, features);
							const smoothed: Record<string, number> = {};
							trainedModel.classes.forEach((name, i) => {
								const prev = probEma[name] ?? probs[i];
								smoothed[name] = prev + (probs[i] - prev) * 0.3;
							});
							probEma = smoothed;
							liveProbs = smoothed;
							let best: { name: string; prob: number } | null = null;
							for (const [name, prob] of Object.entries(smoothed)) {
								if (!best || prob > best.prob) best = { name, prob };
							}
							liveTop = best;
						}
					} else {
						handVisible = false;
						handednessLabel = '';
						smoothWorld = null;
						resetDynamics();
						pretrainedTop = null;
						pretrainedScores = {};
						drawHandPlaceholder(handCtx, handCanvasEl.width, handCanvasEl.height);
						updateRecording(now, null);
					}
				};
				rafId = requestAnimationFrame(loop);
			} catch (err) {
				console.error('handtrainer init failed', err);
				if (!cancelled) {
					trackerStatus = 'error';
					trackerMessage =
						err instanceof DOMException && err.name === 'NotAllowedError'
							? 'Webcam access denied'
							: `Failed: ${err instanceof Error ? err.message : String(err)}`;
				}
			}
		})();

		return () => {
			cancelled = true;
			if (rafId) cancelAnimationFrame(rafId);
			stream?.getTracks().forEach((t) => t.stop());
			recognizer?.close();
		};
	});

	const trainableCount = $derived(
		classes.filter((c) => c.samples.length >= MIN_SAMPLES_PER_CLASS).length
	);
</script>

<svelte:head>
	<title>Hand Gesture Trainer</title>
</svelte:head>

<div class="dashboard">
	<header class="dash-header">
		<h1>Hand Gesture Trainer</h1>
		<div class="header-meta">
			{#if trackerStatus === 'ready'}
				<span class="meta-pill" class:ok={handVisible}>
					{handVisible ? `✋ ${handednessLabel || 'Hand'} tracked` : 'No hand'}
				</span>
				<span class="meta-pill">{fps} fps</span>
			{:else}
				<span class="meta-pill" class:err={trackerStatus === 'error'}>{trackerMessage}</span>
			{/if}
		</div>
	</header>

	<div class="panels">
		<!-- Left: camera + landmarks -->
		<section class="panel camera-panel">
			<h2>Camera</h2>
			<div class="video-wrap">
				<!-- svelte-ignore a11y_media_has_caption -->
				<video bind:this={videoEl} playsinline muted></video>
				<canvas bind:this={overlayEl}></canvas>
				{#if trackerStatus !== 'ready'}
					<div class="tracker-message" class:error={trackerStatus === 'error'}>
						{trackerMessage}
					</div>
				{/if}
				{#if recordPhase !== 'idle'}
					<div class="record-banner" class:live={recordPhase === 'recording'}>
						{#if recordPhase === 'countdown'}
							Get ready… hold "{recordingClass}"
						{:else}
							● Recording "{recordingClass}"
						{/if}
						<div class="record-bar">
							<div class="record-bar-fill" style="width: {recordProgress * 100}%"></div>
						</div>
					</div>
				{/if}
			</div>
			<p class="panel-hint">
				MediaPipe hand landmarks drawn live over your webcam feed.
			</p>
		</section>

		<!-- Middle: constructed hand -->
		<section class="panel hand-panel">
			<h2>
				Constructed Hand
				<button type="button" class="mini-btn" onclick={resetView}>reset view</button>
			</h2>
			<canvas
				bind:this={handCanvasEl}
				class="hand-canvas"
				onpointerdown={onHandPointerDown}
				onpointermove={onHandPointerMove}
				onpointerup={onHandPointerUp}
				onpointercancel={onHandPointerUp}
			></canvas>
			<p class="panel-hint">3D world landmarks, depth-shaded. Drag to orbit.</p>
		</section>

		<!-- Right: pretrained model + trainer tabs -->
		<section class="panel model-panel">
			<div class="tabs">
				<button
					type="button"
					class="tab"
					class:active={activeTab === 'pretrained'}
					onclick={() => (activeTab = 'pretrained')}
				>
					Pretrained
				</button>
				<button
					type="button"
					class="tab"
					class:active={activeTab === 'trainer'}
					onclick={() => (activeTab = 'trainer')}
				>
					Trainer
				</button>
				<button
					type="button"
					class="tab"
					class:active={activeTab === 'tuning'}
					onclick={() => (activeTab = 'tuning')}
				>
					Tuning
				</button>
			</div>

			{#if activeTab === 'pretrained'}
				<div class="tab-body">
					<div class="top-gesture">
						{#if pretrainedTop && pretrainedTop.id !== 'None'}
							<span class="top-icon">
								{PRETRAINED_CLASSES.find((c) => c.id === pretrainedTop?.id)?.icon ?? '❔'}
							</span>
							<span class="top-name">
								{PRETRAINED_CLASSES.find((c) => c.id === pretrainedTop?.id)?.label ??
									pretrainedTop.id}
							</span>
							<span class="top-score">{(pretrainedTop.score * 100).toFixed(0)}%</span>
						{:else}
							<span class="top-name muted">
								{handVisible ? 'No confident gesture' : 'Show your hand'}
							</span>
						{/if}
					</div>
					<ul class="class-bars">
						{#each PRETRAINED_CLASSES as cls (cls.id)}
							{@const score = pretrainedScores[cls.id] ?? 0}
							<li class="bar-row" class:hit={pretrainedTop?.id === cls.id && score > 0}>
								<span class="bar-icon">{cls.icon}</span>
								<span class="bar-label">{cls.label}</span>
								<div class="bar-track">
									<div class="bar-fill" style="width: {score * 100}%"></div>
								</div>
								<span class="bar-value">{(score * 100).toFixed(0)}%</span>
							</li>
						{/each}
					</ul>
					<p class="panel-hint">
						Built-in MediaPipe gesture model — the classes it was pretrained on.
					</p>
				</div>
			{:else if activeTab === 'trainer'}
				<div class="tab-body">
					{#if trainedModel && liveTop}
						<div class="top-gesture custom">
							<span class="top-name">{liveTop.name}</span>
							<span class="top-score">{(liveTop.prob * 100).toFixed(0)}%</span>
						</div>
						<ul class="class-bars">
							{#each trainedModel.classes as name (name)}
								{@const prob = liveProbs[name] ?? 0}
								<li class="bar-row" class:hit={liveTop?.name === name}>
									<span class="bar-label">{name}</span>
									<div class="bar-track">
										<div class="bar-fill custom" style="width: {prob * 100}%"></div>
									</div>
									<span class="bar-value">{(prob * 100).toFixed(0)}%</span>
								</li>
							{/each}
						</ul>
						<hr class="divider" />
					{/if}

					<form
						class="add-class"
						onsubmit={(e) => {
							e.preventDefault();
							addClass();
						}}
					>
						<input
							type="text"
							placeholder="New gesture name…"
							bind:value={newClassName}
							maxlength="32"
						/>
						<button type="submit" disabled={!newClassName.trim()}>Add</button>
					</form>

					{#if classes.length === 0}
						<p class="panel-hint">
							Add a gesture class, then record a few takes of yourself holding (or moving
							through) that gesture. Each take captures ~2.5s of landmark frames.
						</p>
					{/if}

					<ul class="trainer-classes">
						{#each classes as cls (cls.name)}
							<li class="trainer-class">
								<div class="tc-head">
									<span class="tc-name">{cls.name}</span>
									<span class="tc-count" class:enough={cls.samples.length >= MIN_SAMPLES_PER_CLASS}>
										{cls.samples.length} frames
									</span>
								</div>
								<div class="tc-actions">
									{#if recordingClass === cls.name}
										<button type="button" class="rec-btn recording" onclick={cancelRecording}>
											{recordPhase === 'countdown' ? 'Get ready…' : '● Recording'} (cancel)
										</button>
									{:else}
										<button
											type="button"
											class="rec-btn"
											disabled={recordPhase !== 'idle' || trackerStatus !== 'ready'}
											onclick={() => startRecording(cls.name)}
										>
											⏺ Record take
										</button>
									{/if}
									<button
										type="button"
										class="mini-btn"
										disabled={cls.samples.length === 0}
										onclick={() => clearSamples(cls.name)}
									>
										clear
									</button>
									<button type="button" class="mini-btn danger" onclick={() => deleteClass(cls.name)}>
										delete
									</button>
								</div>
							</li>
						{/each}
					</ul>

					{#if classes.length > 0}
						<button
							type="button"
							class="train-btn"
							disabled={training || trainableCount < 2 || recordPhase !== 'idle'}
							onclick={trainModel}
						>
							{training ? 'Training…' : 'Train model'}
						</button>
						{#if trainableCount < 2}
							<p class="panel-hint">
								Need at least 2 classes with {MIN_SAMPLES_PER_CLASS}+ frames each to train.
							</p>
						{/if}
						{#if trainStatus}
							<p class="train-status">{trainStatus}</p>
						{/if}
					{/if}
				</div>
			{:else}
				<div class="tab-body">
					<div class="top-gesture custom">
						{#if lastDynEvent}
							<span class="top-icon">{lastDynEvent.icon}</span>
							<span class="top-name">{lastDynEvent.name}</span>
						{:else}
							<span class="top-name muted">
								Swipe fast in a direction, or poke toward the camera to click
							</span>
						{/if}
					</div>

					<div class="meter">
						<span class="meter-label">speed</span>
						<div class="meter-track">
							<div
								class="meter-fill"
								class:over={liveSpeed >= tuning.swipeVel}
								style="width: {Math.min(100, (liveSpeed / (tuning.swipeVel * 2)) * 100)}%"
							></div>
							<div class="meter-mark"></div>
						</div>
						<span class="bar-value">{liveSpeed.toFixed(1)}</span>
					</div>
					<div class="meter">
						<span class="meter-label">poke</span>
						<div class="meter-track">
							<div
								class="meter-fill poke"
								class:over={clickState === 'dip'}
								style="width: {Math.min(100, (livePoke / 3) * 100)}%"
							></div>
							<div class="meter-mark"></div>
						</div>
						<span class="bar-value">{livePoke.toFixed(1)}</span>
					</div>

					<div class="slider-row">
						<label for="tune-swipevel">Swipe speed <em>{tuning.swipeVel.toFixed(1)} hand/s</em></label>
						<input id="tune-swipevel" type="range" min="0.5" max="6" step="0.1"
							bind:value={tuning.swipeVel} onchange={persistTuning} />
					</div>
					<div class="slider-row">
						<label for="tune-frames">Swipe frames <em>{tuning.swipeFrames}</em></label>
						<input id="tune-frames" type="range" min="1" max="10" step="1"
							bind:value={tuning.swipeFrames} onchange={persistTuning} />
					</div>
					<div class="slider-row">
						<label for="tune-axis">Axis dominance <em>{tuning.axisDom.toFixed(2)}×</em></label>
						<input id="tune-axis" type="range" min="1" max="3" step="0.05"
							bind:value={tuning.axisDom} onchange={persistTuning} />
					</div>
					<div class="slider-row">
						<label for="tune-cooldown">Cooldown <em>{tuning.cooldownMs} ms</em></label>
						<input id="tune-cooldown" type="range" min="100" max="2000" step="50"
							bind:value={tuning.cooldownMs} onchange={persistTuning} />
					</div>
					<div class="slider-row">
						<label for="tune-depth">Click depth <em>{tuning.clickDepth.toFixed(2)} hand</em></label>
						<input id="tune-depth" type="range" min="0.1" max="1" step="0.05"
							bind:value={tuning.clickDepth} onchange={persistTuning} />
					</div>
					<div class="slider-row">
						<label for="tune-window">Click window <em>{tuning.clickReturnMs} ms</em></label>
						<input id="tune-window" type="range" min="150" max="1500" step="50"
							bind:value={tuning.clickReturnMs} onchange={persistTuning} />
					</div>
					<div class="slider-row">
						<label for="tune-smooth">Smoothing <em>{tuning.smoothing.toFixed(2)}</em></label>
						<input id="tune-smooth" type="range" min="0.1" max="0.9" step="0.05"
							bind:value={tuning.smoothing} onchange={persistTuning} />
					</div>

					<button type="button" class="mini-btn" onclick={resetTuning}>reset defaults</button>

					{#if dynEvents.length > 0}
						<hr class="divider" />
						<ul class="event-log">
							{#each dynEvents as ev (ev.id)}
								<li>
									<span class="ev-icon">{ev.icon}</span>
									<span class="ev-name">{ev.name}</span>
									<span class="ev-time">{new Date(ev.at).toLocaleTimeString()}</span>
								</li>
							{/each}
						</ul>
					{/if}

					<p class="panel-hint">
						Rule-based dynamic gestures — no training needed. The speed meter's tick is the
						swipe threshold; tune until deliberate swipes cross it but normal motion doesn't.
						Velocities are measured in hand-sizes/second, so camera distance doesn't matter.
					</p>
				</div>
			{/if}
		</section>
	</div>
</div>

<style>
	.dashboard {
		min-height: 100vh;
		display: flex;
		flex-direction: column;
		background: #0b0f13;
		color: #dce4ec;
		font-family: system-ui, sans-serif;
		padding: 16px;
		gap: 14px;
	}

	.dash-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		flex-wrap: wrap;
	}

	.dash-header h1 {
		font-size: 1.3rem;
		margin: 0;
		color: #eef4fa;
	}

	.header-meta {
		display: flex;
		gap: 8px;
	}

	.meta-pill {
		padding: 4px 10px;
		font-size: 0.75rem;
		border-radius: 999px;
		background: #161d24;
		border: 1px solid #2a3138;
		color: #8b96a3;
	}

	.meta-pill.ok {
		color: #50dc8c;
		border-color: #2e5c44;
	}

	.meta-pill.err {
		color: #ff8a7a;
		border-color: #5c3630;
	}

	.panels {
		flex: 1;
		display: grid;
		grid-template-columns: minmax(280px, 420px) minmax(280px, 1fr) minmax(300px, 380px);
		gap: 14px;
		align-items: stretch;
	}

	@media (max-width: 1000px) {
		.panels {
			grid-template-columns: 1fr;
		}
	}

	.panel {
		background: #101418;
		border: 1px solid #2a3138;
		border-radius: 14px;
		padding: 14px;
		display: flex;
		flex-direction: column;
		gap: 10px;
		min-width: 0;
	}

	.panel h2 {
		margin: 0;
		font-size: 0.85rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: #8b96a3;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
	}

	.panel-hint {
		margin: 0;
		font-size: 0.75rem;
		color: #5b6672;
	}

	/* Camera panel */

	.video-wrap {
		position: relative;
		width: 100%;
		aspect-ratio: 4 / 3;
		border-radius: 10px;
		overflow: hidden;
		background: #000;
	}

	.video-wrap video,
	.video-wrap canvas {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		object-fit: cover;
		transform: scaleX(-1);
	}

	.tracker-message {
		position: absolute;
		inset: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		text-align: center;
		padding: 8px;
		font-size: 0.8rem;
		color: #8b96a3;
	}

	.tracker-message.error {
		color: #ff8a7a;
	}

	.record-banner {
		position: absolute;
		left: 8px;
		right: 8px;
		bottom: 8px;
		padding: 8px 10px;
		border-radius: 8px;
		background: rgba(12, 16, 20, 0.85);
		border: 1px solid #3c4750;
		font-size: 0.8rem;
		color: #dce4ec;
	}

	.record-banner.live {
		border-color: #e2574c;
		color: #ffb0a8;
	}

	.record-bar {
		margin-top: 6px;
		height: 4px;
		border-radius: 2px;
		background: #2a3138;
		overflow: hidden;
	}

	.record-bar-fill {
		height: 100%;
		background: #e2574c;
		transition: width 0.1s linear;
	}

	.record-banner:not(.live) .record-bar-fill {
		background: #e8b64c;
	}

	/* Constructed hand panel */

	.hand-canvas {
		flex: 1;
		width: 100%;
		min-height: 320px;
		border-radius: 10px;
		background:
			radial-gradient(ellipse at center, rgba(45, 190, 210, 0.06), transparent 70%),
			#0a0e12;
		border: 1px solid #1c242c;
		cursor: grab;
		touch-action: none;
	}

	.hand-canvas:active {
		cursor: grabbing;
	}

	/* Right panel */

	.tabs {
		display: flex;
		gap: 6px;
	}

	.tab {
		flex: 1;
		padding: 8px 10px;
		font-size: 0.8rem;
		font-weight: 600;
		color: #8b96a3;
		background: #161d24;
		border: 1px solid #2a3138;
		border-radius: 8px;
		cursor: pointer;
		transition: color 0.15s, border-color 0.15s;
	}

	.tab:hover {
		color: #dce4ec;
	}

	.tab.active {
		color: #50dc8c;
		border-color: #50dc8c;
	}

	.tab-body {
		display: flex;
		flex-direction: column;
		gap: 10px;
		overflow-y: auto;
	}

	.top-gesture {
		display: flex;
		align-items: baseline;
		gap: 10px;
		padding: 12px;
		background: #161d24;
		border: 1px solid #2a3138;
		border-radius: 10px;
		min-height: 52px;
	}

	.top-icon {
		font-size: 1.6rem;
		line-height: 1;
		align-self: center;
	}

	.top-name {
		font-size: 1.05rem;
		font-weight: 700;
		color: #eef4fa;
	}

	.top-name.muted {
		color: #5b6672;
		font-weight: 400;
		font-size: 0.85rem;
	}

	.top-score {
		margin-left: auto;
		font-size: 0.9rem;
		color: #50dc8c;
		font-variant-numeric: tabular-nums;
	}

	.top-gesture.custom .top-name {
		color: #85e0ff;
	}

	.class-bars {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.bar-row {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 0.78rem;
		color: #8b96a3;
	}

	.bar-row.hit {
		color: #dce4ec;
	}

	.bar-icon {
		width: 20px;
		text-align: center;
	}

	.bar-label {
		width: 90px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.bar-track {
		flex: 1;
		height: 8px;
		border-radius: 4px;
		background: #1c242c;
		overflow: hidden;
	}

	.bar-fill {
		height: 100%;
		background: #50dc8c;
		border-radius: 4px;
		transition: width 0.12s linear;
	}

	.bar-fill.custom {
		background: #4cb8e8;
	}

	.bar-value {
		width: 36px;
		text-align: right;
		font-variant-numeric: tabular-nums;
	}

	.divider {
		border: none;
		border-top: 1px solid #2a3138;
		margin: 2px 0;
	}

	/* Trainer */

	.add-class {
		display: flex;
		gap: 6px;
	}

	.add-class input {
		flex: 1;
		padding: 8px 10px;
		font-size: 0.85rem;
		font-family: inherit;
		color: #dce4ec;
		background: #161d24;
		border: 1px solid #2a3138;
		border-radius: 8px;
		min-width: 0;
	}

	.add-class input::placeholder {
		color: #5b6672;
	}

	.add-class button {
		padding: 8px 14px;
		font-size: 0.85rem;
		font-weight: 600;
		color: #0b0f13;
		background: #50dc8c;
		border: none;
		border-radius: 8px;
		cursor: pointer;
	}

	.add-class button:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}

	.trainer-classes {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.trainer-class {
		padding: 10px;
		background: #161d24;
		border: 1px solid #2a3138;
		border-radius: 10px;
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.tc-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
	}

	.tc-name {
		font-weight: 600;
		font-size: 0.9rem;
		color: #eef4fa;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.tc-count {
		font-size: 0.72rem;
		color: #8b96a3;
		white-space: nowrap;
	}

	.tc-count.enough {
		color: #50dc8c;
	}

	.tc-actions {
		display: flex;
		align-items: center;
		gap: 6px;
		flex-wrap: wrap;
	}

	.rec-btn {
		padding: 6px 10px;
		font-size: 0.78rem;
		font-weight: 600;
		color: #dce4ec;
		background: #1c242c;
		border: 1px solid #3c4750;
		border-radius: 8px;
		cursor: pointer;
		transition: border-color 0.15s;
	}

	.rec-btn:hover:not(:disabled) {
		border-color: #e2574c;
	}

	.rec-btn:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}

	.rec-btn.recording {
		color: #ffb0a8;
		border-color: #e2574c;
	}

	.mini-btn {
		padding: 4px 8px;
		font-size: 0.7rem;
		color: #8b96a3;
		background: transparent;
		border: 1px solid #2a3138;
		border-radius: 6px;
		cursor: pointer;
		transition: color 0.15s, border-color 0.15s;
	}

	.mini-btn:hover:not(:disabled) {
		color: #dce4ec;
		border-color: #5b6672;
	}

	.mini-btn:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}

	.mini-btn.danger:hover {
		color: #ff8a7a;
		border-color: #ff8a7a;
	}

	.train-btn {
		padding: 10px;
		font-size: 0.9rem;
		font-weight: 700;
		color: #0b0f13;
		background: #4cb8e8;
		border: none;
		border-radius: 10px;
		cursor: pointer;
		transition: opacity 0.15s;
	}

	.train-btn:hover:not(:disabled) {
		opacity: 0.85;
	}

	.train-btn:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}

	.train-status {
		margin: 0;
		font-size: 0.75rem;
		color: #4cb8e8;
	}

	/* Tuning */

	.meter {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 0.75rem;
		color: #8b96a3;
	}

	.meter-label {
		width: 40px;
	}

	.meter-track {
		flex: 1;
		position: relative;
		height: 10px;
		border-radius: 5px;
		background: #1c242c;
		overflow: hidden;
	}

	.meter-fill {
		height: 100%;
		background: #50dc8c;
		border-radius: 5px;
		transition: width 0.06s linear;
	}

	.meter-fill.poke {
		background: #4cb8e8;
	}

	.meter-fill.over {
		background: #e8b64c;
	}

	.meter-mark {
		position: absolute;
		left: 50%;
		top: 0;
		bottom: 0;
		width: 2px;
		background: #dce4ec;
		opacity: 0.6;
	}

	.slider-row {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	.slider-row label {
		display: flex;
		justify-content: space-between;
		font-size: 0.75rem;
		color: #8b96a3;
	}

	.slider-row label em {
		font-style: normal;
		color: #dce4ec;
		font-variant-numeric: tabular-nums;
	}

	.slider-row input[type='range'] {
		width: 100%;
		accent-color: #50dc8c;
	}

	.event-log {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.event-log li {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 0.78rem;
		color: #dce4ec;
	}

	.ev-icon {
		width: 20px;
		text-align: center;
	}

	.ev-time {
		margin-left: auto;
		color: #5b6672;
		font-variant-numeric: tabular-nums;
	}
</style>
