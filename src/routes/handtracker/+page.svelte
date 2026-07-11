<script lang="ts">
	import { onMount } from 'svelte';
	import { browser } from '$app/environment';
	import '../../app.css';
	import { getProfile, getFullThread } from '$lib/api/bluesky';
	import LoadingSpinner from '$lib/components/LoadingSpinner.svelte';
	import ParallelBoardView from '$lib/components/ParallelBoardView.svelte';
	import type { SelfReplyThread } from '$lib/types';
	import { buildAtUri, normalizeBskyPostUrl, parseBskyPostUrl } from '$lib/utils/viewerLinks';
	import {
		forward,
		landmarksToFeatures,
		loadTrainedGestureModel,
		type Point3,
		type TrainedModel
	} from '$lib/utils/gestureModel';

	type Direction = 'left' | 'right' | 'up' | 'down';
	type Gesture = Direction;
	type Pose = Gesture | null;

	const GESTURE_ICONS: Record<Gesture, string> = {
		left: '←',
		right: '→',
		up: '↑',
		down: '↓'
	};
	const GESTURE_KEYS: Record<Gesture, string> = {
		left: 'ArrowLeft',
		right: 'ArrowRight',
		up: 'ArrowUp',
		down: 'ArrowDown'
	};

	// ---- Tunable thresholds (editable via the ⚙️ config modal, persisted) ----

	type TrackerConfig = {
		/** Minimum smoothed class probability before a direction counts. */
		minProb: number;
		/** Tip must sit this far beyond the middle joint (relative to wrist)
		 * for the index finger to count as extended — gates the model to
		 * pointing-like poses. */
		fingerExtendedRatio: number;
		/** Hold a gesture this long to trigger its key. */
		holdTriggerMs: number;
		/** Grace period so a single dropped frame doesn't reset the hold. */
		holdGraceMs: number;
		/** Key auto-repeat interval while a triggered gesture stays held. */
		repeatMs: number;
		/** EMA factor for probability smoothing (1 = no smoothing). */
		emaAlpha: number;
	};

	const DEFAULT_CONFIG: TrackerConfig = {
		minProb: 0.75,
		fingerExtendedRatio: 1.1,
		holdTriggerMs: 300,
		holdGraceMs: 200,
		repeatMs: 150,
		emaAlpha: 0.4
	};

	const CONFIG_STORAGE_KEY = 'handtracker:config:v1';

	function loadConfig(): TrackerConfig {
		if (!browser) return { ...DEFAULT_CONFIG };
		try {
			const raw = localStorage.getItem(CONFIG_STORAGE_KEY);
			if (!raw) return { ...DEFAULT_CONFIG };
			const parsed = JSON.parse(raw);
			const cfg = { ...DEFAULT_CONFIG };
			for (const key of Object.keys(cfg) as (keyof TrackerConfig)[]) {
				if (typeof parsed?.[key] === 'number' && Number.isFinite(parsed[key])) {
					cfg[key] = parsed[key];
				}
			}
			return cfg;
		} catch {
			return { ...DEFAULT_CONFIG };
		}
	}

	let config = $state<TrackerConfig>(loadConfig());
	let showConfig = $state(false);

	$effect(() => {
		const snapshot = JSON.stringify(config);
		try {
			localStorage.setItem(CONFIG_STORAGE_KEY, snapshot);
		} catch {
			// storage full/blocked — keep running with in-memory config
		}
	});

	function resetConfig() {
		config = { ...DEFAULT_CONFIG };
	}

	let videoEl: HTMLVideoElement;
	let canvasEl: HTMLCanvasElement;

	let trackerStatus = $state<'loading' | 'ready' | 'error'>('loading');
	let trackerMessage = $state('Loading model…');
	let handVisible = $state(false);
	let currentPose = $state<Pose>(null);
	let holdProgress = $state(0);
	let holdTriggered = $state(false);

	let holdGesture: Gesture | null = null;
	let holdStart = 0;
	let lastSeenAt = 0;
	// Key currently "held down" for the board (set once the hold triggers);
	// auto-repeats until the gesture is released.
	let heldKey: string | null = null;
	let lastRepeatAt = 0;

	// Pointing-direction model trained on /handtrainer (localStorage). It is
	// the sole gesture source; without it no gesture triggers.
	let customModel = $state.raw<TrainedModel | null>(null);
	let customProbEma: Record<string, number> = {};

	// Live classifier output for the viewer panel: smoothed per-class
	// probabilities, and whether the pointing gate is currently blocking
	// classification (index finger not extended).
	let classProbs = $state<Record<string, number>>({});
	let classifierGated = $state(true);

	/** Maps a trained class name like "PointLeft" / "point_left" to a direction. */
	function modelDirection(name: string): Direction | null {
		const n = name.toLowerCase().replace(/[^a-z]/g, '');
		if (n.endsWith('up')) return 'up';
		if (n.endsWith('down')) return 'down';
		if (n.endsWith('left')) return 'left';
		if (n.endsWith('right')) return 'right';
		return null;
	}

	/**
	 * Classifies the pointing direction with the model trained on
	 * /handtrainer. This is the only gesture source: without a trained model
	 * (or outside a pointing-like pose) nothing triggers.
	 */
	function classifyPose(landmarks: Point[], world: Point3[] | undefined): Pose {
		if (!customModel || !world) {
			classifierGated = true;
			return null;
		}
		// Only consult the model when the index finger is extended — the model
		// was trained solely on pointing poses and would otherwise hallucinate
		// a direction for any unknown hand shape.
		const wrist = landmarks[0];
		const indexExtended =
			dist(landmarks[8], wrist) > dist(landmarks[6], wrist) * config.fingerExtendedRatio;
		classifierGated = !indexExtended;
		if (!indexExtended) return null;

		const { probs } = forward(customModel, landmarksToFeatures(world));
		let bestName = '';
		let bestProb = -1;
		for (let i = 0; i < customModel.classes.length; i++) {
			const name = customModel.classes[i];
			const prev = customProbEma[name] ?? probs[i];
			const smoothed = prev + (probs[i] - prev) * config.emaAlpha;
			customProbEma[name] = smoothed;
			if (smoothed > bestProb) {
				bestProb = smoothed;
				bestName = name;
			}
		}
		classProbs = { ...customProbEma };
		const dir = modelDirection(bestName);
		if (dir && bestProb >= config.minProb) return dir;
		return null;
	}

	const HAND_CONNECTIONS: [number, number][] = [
		[0, 1], [1, 2], [2, 3], [3, 4],
		[0, 5], [5, 6], [6, 7], [7, 8],
		[5, 9], [9, 10], [10, 11], [11, 12],
		[9, 13], [13, 14], [14, 15], [15, 16],
		[13, 17], [17, 18], [18, 19], [19, 20],
		[0, 17]
	];

	type Point = { x: number; y: number };

	function dist(a: Point, b: Point): number {
		return Math.hypot(a.x - b.x, a.y - b.y);
	}

	function resetHold() {
		releaseHeldKey();
		holdGesture = null;
		holdProgress = 0;
		holdTriggered = false;
	}

	/**
	 * Advances the hold state machine. Once the hold triggers, the mapped key
	 * behaves like a physically held key: an initial keydown, auto-repeat
	 * keydowns while the gesture stays held, and a keyup on release.
	 */
	function updateHold(pose: Pose, now: number) {
		currentPose = pose;
		if (pose === null) {
			if (holdGesture !== null && now - lastSeenAt <= config.holdGraceMs) return;
			resetHold();
			return;
		}
		lastSeenAt = now;
		if (pose !== holdGesture) {
			releaseHeldKey();
			holdGesture = pose;
			holdStart = now;
			holdProgress = 0;
			holdTriggered = false;
			return;
		}
		if (holdTriggered) {
			if (heldKey && now - lastRepeatAt >= config.repeatMs) {
				lastRepeatAt = now;
				dispatchKey('keydown', heldKey, true);
			}
			return;
		}
		holdProgress = Math.min(1, (now - holdStart) / config.holdTriggerMs);
		if (holdProgress >= 1) {
			holdTriggered = true;
			heldKey = GESTURE_KEYS[pose];
			lastRepeatAt = now;
			dispatchKey('keydown', heldKey);
		}
	}

	function dispatchKey(type: 'keydown' | 'keyup', key: string, repeat = false) {
		window.dispatchEvent(
			new KeyboardEvent(type, {
				key,
				repeat,
				shiftKey: key.length === 1 && key !== key.toLowerCase(),
				bubbles: true
			})
		);
	}

	/** Sends the keyup for the currently held gesture key, if any. */
	function releaseHeldKey() {
		if (!heldKey) return;
		dispatchKey('keyup', heldKey);
		heldKey = null;
	}

	/** Dispatches a discrete key press (down + up) to the board below. */
	function pressKey(key: string) {
		dispatchKey('keydown', key);
		dispatchKey('keyup', key);
	}

	function drawHand(
		ctx: CanvasRenderingContext2D,
		landmarks: { x: number; y: number }[],
		width: number,
		height: number
	) {
		// The canvas is CSS-mirrored together with the video, so draw in raw coords.
		ctx.strokeStyle = 'rgba(80, 220, 140, 0.9)';
		ctx.lineWidth = 3;
		for (const [a, b] of HAND_CONNECTIONS) {
			ctx.beginPath();
			ctx.moveTo(landmarks[a].x * width, landmarks[a].y * height);
			ctx.lineTo(landmarks[b].x * width, landmarks[b].y * height);
			ctx.stroke();
		}
		ctx.fillStyle = 'rgba(255, 255, 255, 0.95)';
		for (const lm of landmarks) {
			ctx.beginPath();
			ctx.arc(lm.x * width, lm.y * height, 4, 0, Math.PI * 2);
			ctx.fill();
		}
		// Highlight the index finger — it drives the classifier.
		ctx.strokeStyle = 'rgba(255, 120, 80, 0.95)';
		ctx.lineWidth = 5;
		ctx.beginPath();
		ctx.moveTo(landmarks[5].x * width, landmarks[5].y * height);
		ctx.lineTo(landmarks[8].x * width, landmarks[8].y * height);
		ctx.stroke();
		ctx.fillStyle = 'rgba(255, 120, 80, 0.9)';
		ctx.beginPath();
		ctx.arc(landmarks[8].x * width, landmarks[8].y * height, 8, 0, Math.PI * 2);
		ctx.fill();
	}

	// ---- Parallel board (same flow as /parallelboard) ----

	let urlInput = $state('');
	let loading = $state(false);
	let error: string | null = $state(null);
	let thread = $state<(SelfReplyThread & { isTruncated?: boolean }) | null>(null);

	function updateQueryParam(url: string) {
		if (!browser) return;
		const current = new URL(window.location.href);
		if (url) {
			current.searchParams.set('url', url);
		} else {
			current.searchParams.delete('url');
		}
		window.history.replaceState({}, '', current.toString());
	}

	async function loadThread(bskyUrl: string) {
		const normalizedUrl = normalizeBskyPostUrl(bskyUrl);
		const parsed = normalizedUrl ? parseBskyPostUrl(normalizedUrl) : null;
		if (!normalizedUrl || !parsed) {
			error = 'Invalid URL. Expected format: https://bsky.app/profile/{handle}/post/{rkey}';
			return;
		}

		loading = true;
		error = null;
		thread = null;
		urlInput = normalizedUrl;
		updateQueryParam(normalizedUrl);

		try {
			const profile = await getProfile(parsed.handle);
			const atUri = buildAtUri(profile.did, parsed.rkey);
			if (!atUri) {
				error = 'Could not build an AT URI for this thread.';
				return;
			}
			thread = await getFullThread(atUri);
		} catch (e: any) {
			if (e?.message?.includes('resolve')) {
				error = `Could not find handle "${parsed.handle}".`;
			} else {
				error = e?.message || 'Failed to load thread.';
			}
		} finally {
			loading = false;
		}
	}

	function handleSubmit(e: Event) {
		e.preventDefault();
		if (urlInput.trim()) loadThread(urlInput.trim());
	}

	onMount(() => {
		customModel = loadTrainedGestureModel();

		const params = new URLSearchParams(window.location.search);
		const urlParam = params.get('url');
		if (urlParam) {
			urlInput = urlParam;
			loadThread(urlParam);
		}

		let cancelled = false;
		let rafId = 0;
		let stream: MediaStream | null = null;
		let landmarker: { detectForVideo: Function; close: () => void } | null = null;

		(async () => {
			try {
				const { FilesetResolver, HandLandmarker } = await import('@mediapipe/tasks-vision');
				const fileset = await FilesetResolver.forVisionTasks(
					'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm'
				);
				const hand = await HandLandmarker.createFromOptions(fileset, {
					baseOptions: {
						modelAssetPath:
							'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
						delegate: 'GPU'
					},
					runningMode: 'VIDEO',
					numHands: 1
				});
				if (cancelled) {
					hand.close();
					return;
				}
				landmarker = hand;

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

				const ctx = canvasEl.getContext('2d')!;
				let lastVideoTime = -1;

				const loop = () => {
					if (cancelled) return;
					rafId = requestAnimationFrame(loop);
					if (!landmarker || videoEl.readyState < 2) return;
					if (videoEl.currentTime === lastVideoTime) return;
					lastVideoTime = videoEl.currentTime;

					const width = videoEl.videoWidth;
					const height = videoEl.videoHeight;
					if (canvasEl.width !== width) canvasEl.width = width;
					if (canvasEl.height !== height) canvasEl.height = height;

					const now = performance.now();
					const result = landmarker.detectForVideo(videoEl, now);

					ctx.clearRect(0, 0, width, height);
					const landmarks = result.landmarks?.[0];
					if (landmarks) {
						handVisible = true;
						drawHand(ctx, landmarks, width, height);
						updateHold(classifyPose(landmarks, result.worldLandmarks?.[0]), now);
					} else {
						handVisible = false;
						updateHold(null, now);
					}
				};
				rafId = requestAnimationFrame(loop);
			} catch (err) {
				console.error('handtracker init failed', err);
				if (!cancelled) {
					trackerStatus = 'error';
					trackerMessage =
						err instanceof DOMException && err.name === 'NotAllowedError'
							? 'Webcam denied'
							: `Failed: ${err instanceof Error ? err.message : String(err)}`;
				}
			}
		})();

		return () => {
			cancelled = true;
			releaseHeldKey();
			if (rafId) cancelAnimationFrame(rafId);
			stream?.getTracks().forEach((t) => t.stop());
			landmarker?.close();
		};
	});
</script>

<svelte:head>
	<title>Hand Tracker Board</title>
</svelte:head>

<div class="tracker-card" class:triggered={holdTriggered}>
	<div class="video-wrap">
		<!-- svelte-ignore a11y_media_has_caption -->
		<video bind:this={videoEl} playsinline muted></video>
		<canvas bind:this={canvasEl}></canvas>
		{#if trackerStatus !== 'ready'}
			<div class="tracker-message" class:error={trackerStatus === 'error'}>{trackerMessage}</div>
		{/if}
	</div>
	<div class="tracker-side">
		<div class="direction-display" class:active={currentPose !== null}>
			{#if currentPose}
				<div class="hold-ring">
					<svg viewBox="0 0 100 100" aria-hidden="true">
						<circle class="ring-track" cx="50" cy="50" r="42" />
						<circle
							class="ring-fill"
							cx="50"
							cy="50"
							r="42"
							stroke-dasharray={2 * Math.PI * 42}
							stroke-dashoffset={2 * Math.PI * 42 * (1 - holdProgress)}
						/>
					</svg>
					<span class="arrow">{GESTURE_ICONS[currentPose]}</span>
				</div>
			{:else if handVisible}
				<span class="waiting">☝️</span>
			{:else}
				<span class="waiting">✋?</span>
			{/if}
		</div>
		<button
			type="button"
			class="quote-all-btn"
			title="Open a lane for every quote post of the selected card (Shift+W)"
			onclick={() => pressKey('W')}
		>
			🫱 All quotes
		</button>
		{#if customModel}
			<span
				class="model-badge"
				title="Pointing directions use your model trained on /handtrainer ({customModel.classes.join(', ')})"
			>
				🧠 trained poses
			</span>
		{:else}
			<span class="model-badge missing" title="Gestures are disabled until a model is trained">
				no model — train on /handtrainer
			</span>
		{/if}
		<button
			type="button"
			class="config-btn"
			title="Configure thresholds"
			onclick={() => (showConfig = !showConfig)}
		>
			⚙️ config
		</button>
	</div>
	{#if customModel}
		<div class="class-viewer" class:gated={classifierGated}>
			<div class="class-viewer-title">
				classifier
				{#if classifierGated}
					<span class="gated-note" title="Extend your index finger to classify">gated ☝️</span>
				{/if}
			</div>
			{#each customModel.classes as name (name)}
				{@const prob = classProbs[name] ?? 0}
				{@const dir = modelDirection(name)}
				<div class="class-row" title="{name}: {(prob * 100).toFixed(0)}%">
					<span class="class-name">{dir ? GESTURE_ICONS[dir] : '·'} {name}</span>
					<div class="class-bar">
						<div
							class="class-bar-fill"
							class:over={prob >= config.minProb && !classifierGated}
							style="width: {Math.min(100, prob * 100)}%"
						></div>
						<div class="class-bar-threshold" style="left: {config.minProb * 100}%"></div>
					</div>
					<span class="class-prob">{(prob * 100).toFixed(0)}%</span>
				</div>
			{/each}
		</div>
	{/if}
</div>

{#if showConfig}
	<div
		class="config-overlay"
		role="presentation"
		onclick={(e) => {
			if (e.target === e.currentTarget) showConfig = false;
		}}
	>
		<div class="config-modal" role="dialog" aria-label="Tracker configuration">
			<div class="config-header">
				<h2>Tracker config</h2>
				<button type="button" class="config-close" onclick={() => (showConfig = false)}>✕</button>
			</div>

			<label class="config-field">
				<span class="config-label">
					Hold duration
					<span class="config-value">{config.holdTriggerMs} ms</span>
				</span>
				<input type="range" min="100" max="2000" step="50" bind:value={config.holdTriggerMs} />
				<span class="config-hint">How long a direction must be held before its key fires.</span>
			</label>

			<label class="config-field">
				<span class="config-label">
					Repeat interval
					<span class="config-value">{config.repeatMs} ms</span>
				</span>
				<input type="range" min="50" max="1000" step="25" bind:value={config.repeatMs} />
				<span class="config-hint">
					Auto-repeat rate while you keep holding a triggered direction, like a held key.
				</span>
			</label>

			<label class="config-field">
				<span class="config-label">
					Min probability
					<span class="config-value">{(config.minProb * 100).toFixed(0)}%</span>
				</span>
				<input type="range" min="0.3" max="0.99" step="0.01" bind:value={config.minProb} />
				<span class="config-hint">Smoothed class probability needed to count as a direction.</span>
			</label>

			<label class="config-field">
				<span class="config-label">
					Hold grace
					<span class="config-value">{config.holdGraceMs} ms</span>
				</span>
				<input type="range" min="0" max="1000" step="25" bind:value={config.holdGraceMs} />
				<span class="config-hint">Dropped-frame tolerance before a hold resets.</span>
			</label>

			<label class="config-field">
				<span class="config-label">
					Finger extended ratio
					<span class="config-value">{config.fingerExtendedRatio.toFixed(2)}</span>
				</span>
				<input
					type="range"
					min="1"
					max="1.5"
					step="0.01"
					bind:value={config.fingerExtendedRatio}
				/>
				<span class="config-hint">
					How far the index tip must reach past its middle joint to enable classification.
				</span>
			</label>

			<label class="config-field">
				<span class="config-label">
					Smoothing
					<span class="config-value">{config.emaAlpha.toFixed(2)}</span>
				</span>
				<input type="range" min="0.05" max="1" step="0.05" bind:value={config.emaAlpha} />
				<span class="config-hint">
					Per-frame weight of new probabilities (lower = steadier, slower).
				</span>
			</label>

			<button type="button" class="config-reset" onclick={resetConfig}>Reset to defaults</button>
		</div>
	</div>
{/if}

<main>
	<header>
		<h1>Hand Tracker Board</h1>
		<p class="subtitle">
			Point up/down/left/right to move the selected card — directions are recognized by your
			model trained on /handtrainer. Press the 🫱 button to open every quote post lane.
		</p>
	</header>

	<form class="url-form" onsubmit={handleSubmit}>
		<input
			type="text"
			class="url-input wobbly-border-light"
			placeholder="https://bsky.app/profile/handle.bsky.social/post/..."
			bind:value={urlInput}
			disabled={loading}
		/>
		<button type="submit" class="load-btn wobbly-border" disabled={loading || !urlInput.trim()}>
			Load Thread
		</button>
	</form>

	{#if error}
		<div class="error-banner wobbly-border-light">{error}</div>
	{/if}

	{#if loading}
		<LoadingSpinner progress={{ phase: 'Loading thread...', current: 0, total: 0 }} />
	{/if}

	{#if thread}
		{#if thread.isTruncated}
			<p class="truncation-warning">Some replies may be missing</p>
		{/if}
		<ParallelBoardView {thread} />
	{/if}
</main>

<style>
	.tracker-card {
		position: fixed;
		top: 16px;
		right: 16px;
		z-index: 1000;
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 10px;
		background: #101418;
		border: 1px solid #2a3138;
		border-radius: 14px;
		box-shadow: 0 8px 32px rgba(0, 0, 0, 0.45);
		transition: border-color 0.15s;
	}

	.tracker-card.triggered {
		border-color: #50dc8c;
	}

	.video-wrap {
		position: relative;
		width: 200px;
		aspect-ratio: 4 / 3;
		border-radius: 8px;
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
		font-size: 0.75rem;
		font-family: system-ui, sans-serif;
		color: #8b96a3;
	}

	.tracker-message.error {
		color: #ff8a7a;
	}

	.tracker-side {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 6px;
	}

	.direction-display {
		width: 72px;
		height: 72px;
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.quote-all-btn {
		padding: 4px 8px;
		font-size: 0.7rem;
		font-family: system-ui, sans-serif;
		white-space: nowrap;
		color: #8b96a3;
		background: #181e24;
		border: 1px solid #2a3138;
		border-radius: 8px;
		cursor: pointer;
		transition: color 0.15s, border-color 0.15s;
	}

	.quote-all-btn:hover {
		color: #50dc8c;
		border-color: #50dc8c;
	}

	.model-badge {
		font-size: 0.65rem;
		font-family: system-ui, sans-serif;
		color: #4cb8e8;
		white-space: nowrap;
		cursor: help;
	}

	.model-badge.missing {
		color: #e8b64c;
	}

	.config-btn {
		padding: 3px 8px;
		font-size: 0.65rem;
		font-family: system-ui, sans-serif;
		white-space: nowrap;
		color: #8b96a3;
		background: #181e24;
		border: 1px solid #2a3138;
		border-radius: 8px;
		cursor: pointer;
		transition: color 0.15s, border-color 0.15s;
	}

	.config-btn:hover {
		color: #4cb8e8;
		border-color: #4cb8e8;
	}

	.class-viewer {
		display: flex;
		flex-direction: column;
		gap: 4px;
		width: 170px;
		font-family: system-ui, sans-serif;
	}

	.class-viewer.gated {
		opacity: 0.55;
	}

	.class-viewer-title {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		font-size: 0.65rem;
		color: #5b6672;
		text-transform: uppercase;
		letter-spacing: 0.05em;
	}

	.gated-note {
		color: #e8b64c;
		text-transform: none;
		letter-spacing: normal;
	}

	.class-row {
		display: grid;
		grid-template-columns: 62px 1fr 30px;
		align-items: center;
		gap: 6px;
		font-size: 0.65rem;
	}

	.class-name {
		color: #8b96a3;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.class-bar {
		position: relative;
		height: 8px;
		background: #181e24;
		border: 1px solid #2a3138;
		border-radius: 4px;
		overflow: hidden;
	}

	.class-bar-fill {
		height: 100%;
		background: #4cb8e8;
		border-radius: 3px;
		transition: width 0.08s linear;
	}

	.class-bar-fill.over {
		background: #50dc8c;
	}

	.class-bar-threshold {
		position: absolute;
		top: 0;
		bottom: 0;
		width: 1px;
		background: #e8b64c;
	}

	.class-prob {
		color: #5b6672;
		text-align: right;
		font-variant-numeric: tabular-nums;
	}

	.config-overlay {
		position: fixed;
		inset: 0;
		z-index: 1100;
		display: flex;
		align-items: center;
		justify-content: center;
		background: rgba(0, 0, 0, 0.5);
	}

	.config-modal {
		width: min(420px, calc(100vw - 32px));
		max-height: calc(100vh - 64px);
		overflow-y: auto;
		display: flex;
		flex-direction: column;
		gap: 16px;
		padding: 20px;
		background: #101418;
		border: 1px solid #2a3138;
		border-radius: 14px;
		box-shadow: 0 12px 48px rgba(0, 0, 0, 0.6);
		font-family: system-ui, sans-serif;
		color: #c7d0d9;
	}

	.config-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
	}

	.config-header h2 {
		margin: 0;
		font-size: 1rem;
		color: #e6edf3;
	}

	.config-close {
		padding: 2px 8px;
		font-size: 0.9rem;
		color: #8b96a3;
		background: none;
		border: none;
		cursor: pointer;
	}

	.config-close:hover {
		color: #e6edf3;
	}

	.config-field {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.config-label {
		display: flex;
		justify-content: space-between;
		font-size: 0.8rem;
	}

	.config-value {
		color: #50dc8c;
		font-variant-numeric: tabular-nums;
	}

	.config-field input[type='range'] {
		width: 100%;
		accent-color: #50dc8c;
	}

	.config-hint {
		font-size: 0.7rem;
		color: #5b6672;
	}

	.config-reset {
		align-self: flex-start;
		padding: 6px 12px;
		font-size: 0.75rem;
		color: #8b96a3;
		background: #181e24;
		border: 1px solid #2a3138;
		border-radius: 8px;
		cursor: pointer;
		transition: color 0.15s, border-color 0.15s;
	}

	.config-reset:hover {
		color: #e8b64c;
		border-color: #e8b64c;
	}

	.hold-ring {
		position: relative;
		width: 72px;
		height: 72px;
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.hold-ring svg {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		transform: rotate(-90deg);
	}

	.ring-track,
	.ring-fill {
		fill: none;
		stroke-width: 7;
	}

	.ring-track {
		stroke: #2a3138;
	}

	.ring-fill {
		stroke: #50dc8c;
		stroke-linecap: round;
	}

	.arrow {
		font-size: 2.2rem;
		line-height: 1;
		color: #50dc8c;
	}

	.waiting {
		color: #5b6672;
		font-size: 1.4rem;
	}

	main {
		max-width: 100%;
		margin: 0 auto;
		padding: 32px 20px;
	}

	header {
		text-align: center;
		margin-bottom: 24px;
		max-width: 1200px;
		margin-left: auto;
		margin-right: auto;
	}

	h1 {
		font-size: 2rem;
		color: var(--text-ink);
		margin: 8px 0 4px;
	}

	.subtitle {
		color: var(--muted);
		font-size: 1rem;
	}

	.url-form {
		display: flex;
		gap: 10px;
		max-width: 600px;
		margin: 0 auto 24px;
	}

	.url-input {
		flex: 1;
		padding: 10px 14px;
		font-size: 0.95rem;
		font-family: inherit;
		background: var(--card-bg);
		color: var(--text-ink);
	}

	.url-input::placeholder {
		color: var(--muted);
		opacity: 0.7;
	}

	.load-btn {
		padding: 10px 20px;
		font-size: 0.95rem;
		background: var(--accent);
		color: white;
		border-color: var(--border-color);
		cursor: pointer;
		white-space: nowrap;
		transition: opacity 0.2s;
	}

	.load-btn:hover:not(:disabled) {
		opacity: 0.85;
	}

	.load-btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.error-banner {
		max-width: 600px;
		margin: 0 auto 16px;
		padding: 10px 16px;
		background: #ffeaea;
		color: #a33;
		text-align: center;
		font-size: 0.95rem;
	}
</style>
