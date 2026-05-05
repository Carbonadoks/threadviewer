import * as ex from 'excalibur';
import * as tiled from '@excaliburjs/plugin-tiled';
import type {
	TownConversationState,
	TownGameController,
	TownDialogueLine,
	TownNpcData,
	TownPlayerIdentity
} from '$lib/town/types';

const MAP_PATH = '/town/maps/starter-town.tmj';
const VIEWPORT_WIDTH = 320;
const VIEWPORT_HEIGHT = 240;
const TILE_SIZE = 16;
const TALK_RANGE = 28;
const NPC_SIZE = 20;
const PLAYER_MARKER_WORLD_SIZE = 22;
const PLAYER_FALLBACK_COLOR = '#3d405b';
const NPC_GRID_SPACING = 52;
const BUBBLE_MAX_WIDTH = 300;
const BUBBLE_STAGE_MARGIN = 10;
const BUBBLE_TOP_FLIP_THRESHOLD = 120;
const MARKER_CULL_MARGIN = 64;
const LANDSCAPE_CHUNK_SIZE = 192;
const LANDSCAPE_TILE_SIZE = 24;
const LANDSCAPE_PADDING = 96;
const AUTO_ADVANCE_MIN_MS = 4200;
const AUTO_ADVANCE_MAX_MS = 18000;
const AUTO_ADVANCE_PER_CHAR_MS = 26;
const AUTO_ADVANCE_PER_LINK_MS = 720;
const AUTO_ADVANCE_EMBED_MS = 1900;

const GRASS_SHADES = [
	ex.Color.fromHex('#8cbf6b'),
	ex.Color.fromHex('#7cad63'),
	ex.Color.fromHex('#6f9f59'),
	ex.Color.fromHex('#95c87a')
];
const MEADOW_SHADES = [
	ex.Color.fromHex('#a9d478'),
	ex.Color.fromHex('#9bc96f'),
	ex.Color.fromHex('#8fc466')
];
const PATH_SHADES = [
	ex.Color.fromHex('#b59563'),
	ex.Color.fromHex('#a98755')
];
const WATER_SHADES = [
	ex.Color.fromHex('#78b4ce'),
	ex.Color.fromHex('#6aa6c4')
];
const SAND_COLOR = ex.Color.fromHex('#d8c28d');
const TREE_DARK = ex.Color.fromHex('#335b35');
const TREE_MID = ex.Color.fromHex('#4c7f3f');
const TREE_LIGHT = ex.Color.fromHex('#6b9d56');
const TRUNK_COLOR = ex.Color.fromHex('#6e4c2f');
const FLOWER_PINK = ex.Color.fromHex('#f2c6d9');
const FLOWER_GOLD = ex.Color.fromHex('#f0d16d');
const ROCK_COLOR = ex.Color.fromHex('#8f8d8b');
const LILY_COLOR = ex.Color.fromHex('#dceab9');

type MarkerVariant = 'npc' | 'player';

function clamp(value: number, min: number, max: number): number {
	if (max < min) return (min + max) / 2;
	return Math.min(Math.max(value, min), max);
}

function fract(value: number): number {
	return value - Math.floor(value);
}

function lerp(start: number, end: number, amount: number): number {
	return start + (end - start) * amount;
}

function smoothstep(amount: number): number {
	return amount * amount * (3 - 2 * amount);
}

function hashCoordinate(x: number, y: number, seed: number): number {
	return fract(Math.sin(x * 127.1 + y * 311.7 + seed * 73.13) * 43758.5453123);
}

function sampleNoise(x: number, y: number, scale: number, seed: number): number {
	const scaledX = x / scale;
	const scaledY = y / scale;
	const cellX = Math.floor(scaledX);
	const cellY = Math.floor(scaledY);
	const tx = smoothstep(fract(scaledX));
	const ty = smoothstep(fract(scaledY));

	const topLeft = hashCoordinate(cellX, cellY, seed);
	const topRight = hashCoordinate(cellX + 1, cellY, seed);
	const bottomLeft = hashCoordinate(cellX, cellY + 1, seed);
	const bottomRight = hashCoordinate(cellX + 1, cellY + 1, seed);

	return lerp(lerp(topLeft, topRight, tx), lerp(bottomLeft, bottomRight, tx), ty);
}

function estimateAutoAdvanceMs(line: TownDialogueLine): number {
	const textLength = line.text.replace(/\s+/g, ' ').trim().length;
	return clamp(
		3600 +
			textLength * AUTO_ADVANCE_PER_CHAR_MS +
			line.linkedUrls.length * AUTO_ADVANCE_PER_LINK_MS +
			(line.embed ? AUTO_ADVANCE_EMBED_MS : 0),
		AUTO_ADVANCE_MIN_MS,
		AUTO_ADVANCE_MAX_MS
	);
}

function buildSpawnPositions(count: number, origin: ex.Vector): ex.Vector[] {
	const positions: ex.Vector[] = [];
	for (let ring = 1; positions.length < count; ring++) {
		for (let gridY = -ring; gridY <= ring && positions.length < count; gridY++) {
			for (let gridX = -ring; gridX <= ring && positions.length < count; gridX++) {
				if (Math.max(Math.abs(gridX), Math.abs(gridY)) !== ring) continue;
				positions.push(
					ex.vec(origin.x + gridX * NPC_GRID_SPACING, origin.y + gridY * NPC_GRID_SPACING)
				);
			}
		}
	}
	return positions;
}

function sampleGroundColor(worldX: number, worldY: number) {
	const meadowNoise = sampleNoise(worldX + 46, worldY - 18, 180, 13);
	const waterNoise = sampleNoise(worldX - 72, worldY + 24, 300, 29);
	const textureNoise = sampleNoise(worldX + 12, worldY + 66, 96, 41);
	const pathNoise = sampleNoise(worldX + 96, worldY - 54, 460, 53);

	const pathBand = Math.min(
		Math.abs(Math.sin(worldX / 150 + pathNoise * 4.7)),
		Math.abs(Math.cos(worldY / 168 - pathNoise * 4.3))
	);

	const isWater = waterNoise > 0.71 && meadowNoise < 0.46;
	const isPath = !isWater && pathBand < 0.08;
	const isSand = !isWater && !isPath && waterNoise > 0.64 && meadowNoise < 0.5;
	const useMeadow = meadowNoise > 0.68 && !isWater && !isPath;

	let color = GRASS_SHADES[Math.floor(textureNoise * GRASS_SHADES.length) % GRASS_SHADES.length];
	if (useMeadow) {
		color = MEADOW_SHADES[Math.floor(textureNoise * MEADOW_SHADES.length) % MEADOW_SHADES.length];
	} else if (isPath) {
		color = PATH_SHADES[Math.floor(textureNoise * PATH_SHADES.length) % PATH_SHADES.length];
	} else if (isSand) {
		color = SAND_COLOR;
	} else if (isWater) {
		color = WATER_SHADES[Math.floor(textureNoise * WATER_SHADES.length) % WATER_SHADES.length];
	}

	return {
		color,
		isWater,
		isPath,
		isSand,
		textureNoise,
		meadowNoise
	};
}

function drawTreeCluster(ctx: ex.ExcaliburGraphicsContext, pos: ex.Vector, seed: number) {
	const radius = 4 + Math.round(seed * 3);
	ctx.drawRectangle(pos.add(ex.vec(-1, 4)), 2, 5, TRUNK_COLOR);
	ctx.drawCircle(pos.add(ex.vec(-4, -1)), radius, TREE_DARK);
	ctx.drawCircle(pos.add(ex.vec(0, -3)), radius + 1, TREE_MID);
	ctx.drawCircle(pos.add(ex.vec(5, 0)), Math.max(3, radius - 1), TREE_LIGHT);
}

function drawFlowerPatch(ctx: ex.ExcaliburGraphicsContext, pos: ex.Vector, seed: number) {
	const flowerCount = 3 + Math.round(seed * 2);
	for (let index = 0; index < flowerCount; index++) {
		const offsetX = (hashCoordinate(index, Math.round(pos.x), 67) - 0.5) * 10;
		const offsetY = (hashCoordinate(index, Math.round(pos.y), 79) - 0.5) * 8;
		ctx.drawCircle(
			pos.add(ex.vec(offsetX, offsetY)),
			1.4,
			index % 2 === 0 ? FLOWER_GOLD : FLOWER_PINK
		);
	}
}

function drawRockCluster(ctx: ex.ExcaliburGraphicsContext, pos: ex.Vector, seed: number) {
	ctx.drawRectangle(pos.add(ex.vec(-4, -2)), 7, 4, ROCK_COLOR);
	if (seed > 0.55) {
		ctx.drawCircle(pos.add(ex.vec(3, 2)), 2.5, ROCK_COLOR);
	}
}

function drawWaterDetail(ctx: ex.ExcaliburGraphicsContext, pos: ex.Vector, seed: number) {
	if (seed < 0.58) return;
	ctx.drawCircle(pos.add(ex.vec(-2, -1)), 1.4, LILY_COLOR);
	ctx.drawCircle(pos.add(ex.vec(3, 2)), 1.1, LILY_COLOR);
}

function buildConversationSignature(state: TownConversationState | null): string {
	if (!state) return 'none';

	if (state.mode === 'prompt') {
		return `prompt:${state.npc.id}:${state.placement}:${Math.round(state.screenX)}:${Math.round(state.screenY)}`;
	}

	return `talk:${state.npc.id}:${state.line.id}:${state.lineIndex}:${state.placement}:${Math.round(state.screenX)}:${Math.round(state.screenY)}`;
}

function renderMarkerContent(
	marker: HTMLDivElement,
	options: {
		avatar: string | null;
		colorHex: string;
		variant: MarkerVariant;
		label?: string | null;
	}
) {
	marker.className =
		options.variant === 'player' ? 'town-npc-marker town-player-marker' : 'town-npc-marker';
	marker.style.setProperty('--town-npc-accent', options.colorHex);
	marker.replaceChildren();

	const frame = document.createElement('div');
	frame.className = 'town-npc-marker__frame';

	const appendFallback = () => {
		if (frame.querySelector('.town-npc-marker__fallback')) return;
		const fallback = document.createElement('div');
		fallback.className = 'town-npc-marker__fallback';
		fallback.style.background = options.colorHex;
		frame.append(fallback);
	};

	if (options.avatar) {
		const img = document.createElement('img');
		img.className = 'town-npc-marker__image';
		img.src = options.avatar;
		img.alt = '';
		img.decoding = 'async';
		img.referrerPolicy = 'no-referrer';
		img.onerror = () => {
			img.remove();
			appendFallback();
		};
		frame.append(img);
	} else {
		appendFallback();
	}

	marker.append(frame);

	if (options.label) {
		const badge = document.createElement('span');
		badge.className = 'town-npc-marker__badge';
		badge.textContent = options.label;
		marker.append(badge);
	}
}

function createMarkerElement(
	layer: HTMLElement | null,
	options: {
		avatar: string | null;
		colorHex: string;
		variant: MarkerVariant;
		label?: string | null;
	}
): HTMLDivElement | null {
	if (!layer) return null;

	const marker = document.createElement('div');
	marker.setAttribute('aria-hidden', 'true');
	renderMarkerContent(marker, options);
	layer.append(marker);
	return marker;
}

class TownPlayer extends ex.Actor {
	private readonly walkSpeed = 76;
	private readonly sprintSpeed = 114;
	private readonly markerEl: HTMLDivElement | null;

	constructor(
		startPos: ex.Vector,
		markerEl: HTMLDivElement | null,
		identity: TownPlayerIdentity | null
	) {
		super({
			pos: startPos.clone(),
			width: 10,
			height: 10,
			color: ex.Color.Transparent,
			z: Math.round(startPos.y),
			collisionType: ex.CollisionType.PreventCollision
		});

		this.markerEl = markerEl;
		this.graphics.hide();
		this.setIdentity(identity);
	}

	onPreUpdate(engine: ex.Engine, elapsed: number): void {
		const keyboard = engine.input.keyboard;
		const horizontal =
			(keyboard.isHeld(ex.Keys.D) || keyboard.isHeld(ex.Keys.Right) ? 1 : 0) -
			(keyboard.isHeld(ex.Keys.A) || keyboard.isHeld(ex.Keys.Left) ? 1 : 0);
		const vertical =
			(keyboard.isHeld(ex.Keys.S) || keyboard.isHeld(ex.Keys.Down) ? 1 : 0) -
			(keyboard.isHeld(ex.Keys.W) || keyboard.isHeld(ex.Keys.Up) ? 1 : 0);

		let moveX = horizontal;
		let moveY = vertical;

		if (moveX !== 0 || moveY !== 0) {
			const magnitude = Math.hypot(moveX, moveY);
			moveX /= magnitude;
			moveY /= magnitude;
		}

		const speed =
			keyboard.isHeld(ex.Keys.ShiftLeft) || keyboard.isHeld(ex.Keys.ShiftRight)
				? this.sprintSpeed
				: this.walkSpeed;
		const distance = (speed * elapsed) / 1000;

		this.pos.x += moveX * distance;
		this.pos.y += moveY * distance;
		this.z = Math.round(this.pos.y);
	}

	setIdentity(identity: TownPlayerIdentity | null): void {
		if (!this.markerEl) return;
		renderMarkerContent(this.markerEl, {
			avatar: identity?.avatar ?? null,
			colorHex: identity?.colorHex ?? PLAYER_FALLBACK_COLOR,
			variant: 'player',
			label: identity ? 'You' : 'Guest'
		});
	}

	syncMarker(x: number, y: number, size: number): void {
		if (!this.markerEl) return;
		this.markerEl.style.left = `${x}px`;
		this.markerEl.style.top = `${y}px`;
		this.markerEl.style.width = `${size}px`;
		this.markerEl.style.height = `${size}px`;
	}

	removeMarker(): void {
		this.markerEl?.remove();
	}
}

class FeedAuthorNpc extends ex.Actor {
	data: TownNpcData;
	private basePos: ex.Vector;
	private readonly phaseOffset: number;
	private readonly markerEl: HTMLDivElement | null;

	constructor(
		data: TownNpcData,
		pos: ex.Vector,
		phaseOffset: number,
		markerEl: HTMLDivElement | null
	) {
		super({
			pos: pos.clone(),
			width: NPC_SIZE,
			height: NPC_SIZE,
			color: ex.Color.Transparent,
			z: Math.round(pos.y),
			collisionType: ex.CollisionType.PreventCollision
		});

		this.data = data;
		this.basePos = pos.clone();
		this.phaseOffset = phaseOffset;
		this.markerEl = markerEl;
		this.graphics.hide();
	}

	onPreUpdate(_engine: ex.Engine, _elapsed: number): void {
		this.pos.y = this.basePos.y + Math.sin((performance.now() + this.phaseOffset) / 420) * 0.85;
		this.z = Math.round(this.basePos.y);
	}

	syncMarker(x: number, y: number, size: number, active: boolean, visible: boolean): void {
		if (!this.markerEl) return;
		this.markerEl.style.display = visible ? 'block' : 'none';
		if (!visible) {
			this.markerEl.classList.toggle('active', active);
			return;
		}
		this.markerEl.style.left = `${x}px`;
		this.markerEl.style.top = `${y}px`;
		this.markerEl.style.width = `${size}px`;
		this.markerEl.style.height = `${size}px`;
		this.markerEl.classList.toggle('active', active);
	}

	updateData(nextData: TownNpcData): void {
		this.data = nextData;
		if (!this.markerEl) return;
		renderMarkerContent(this.markerEl, {
			avatar: nextData.avatar,
			colorHex: nextData.colorHex,
			variant: 'npc'
		});
	}

	setBasePos(pos: ex.Vector): void {
		this.basePos = pos.clone();
		this.pos.x = pos.x;
		this.pos.y = pos.y;
		this.z = Math.round(pos.y);
	}

	removeMarker(): void {
		this.markerEl?.remove();
	}
}

export async function mountTownGame(
	canvas: HTMLCanvasElement,
	options: {
		onConversationChange?: (state: TownConversationState | null) => void;
		npcLayer?: HTMLElement | null;
		playerIdentity?: TownPlayerIdentity | null;
	} = {}
): Promise<TownGameController> {
	const onConversationChange = options.onConversationChange ?? (() => undefined);
	const markerLayer = options.npcLayer ?? null;
	const game = new ex.Engine({
		canvasElement: canvas,
		displayMode: ex.DisplayMode.FitContainer,
		viewport: { width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT },
		resolution: { width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT },
		antialiasing: false,
		snapToPixel: true,
		suppressConsoleBootMessage: true
	});

	const townResource = new tiled.TiledResource(MAP_PATH, {
		mapFormatOverride: 'TMJ',
		useExcaliburWiring: false,
		useMapBackgroundColor: true,
		useTilemapCameraStrategy: false
	});

	let disposed = false;
	let npcActors: FeedAuthorNpc[] = [];
	let player: TownPlayer | null = null;
	let activeNpcId: string | null = null;
	let activeMessageIndex = 0;
	let activeLineElapsedMs = 0;
	let dismissedNpcId: string | null = null;
	let lastConversationSignature = 'none';
	let populationRequestToken = 0;
	const npcActorsById = new Map<string, FeedAuthorNpc>();

	const preventBrowserKeys = (event: KeyboardEvent) => {
		const target = event.target as HTMLElement | null;
		if (target) {
			const tagName = target.tagName.toLowerCase();
			if (
				tagName === 'input' ||
				tagName === 'textarea' ||
				tagName === 'select' ||
				target.isContentEditable
			) {
				return;
			}
		}

		if (
			event.code === 'Space' ||
			event.code === 'ArrowUp' ||
			event.code === 'ArrowDown' ||
			event.code === 'ArrowLeft' ||
			event.code === 'ArrowRight'
		) {
			event.preventDefault();
		}
	};

	function worldToStagePoint(worldPoint: ex.Vector): ex.Vector {
		const screenPoint = game.worldToScreenCoordinates(worldPoint);
		const scaleX = canvas.clientWidth / VIEWPORT_WIDTH;
		const scaleY = canvas.clientHeight / VIEWPORT_HEIGHT;
		return ex.vec(screenPoint.x * scaleX, screenPoint.y * scaleY);
	}

	function computeActorScreenMetrics(
		worldPoint: ex.Vector,
		worldSize: number
	): { x: number; y: number; size: number } {
		const center = worldToStagePoint(worldPoint);
		const rightEdge = worldToStagePoint(worldPoint.add(ex.vec(worldSize / 2, 0)));
		const topEdge = worldToStagePoint(worldPoint.add(ex.vec(0, -worldSize / 2)));
		const halfWidth = Math.abs(rightEdge.x - center.x);
		const halfHeight = Math.abs(center.y - topEdge.y);
		const size = Math.max(28, Math.round(Math.max(halfWidth, halfHeight) * 2));
		return {
			x: center.x,
			y: center.y,
			size
		};
	}

	function emitConversation(state: TownConversationState | null) {
		const signature = buildConversationSignature(state);
		if (signature === lastConversationSignature) return;
		lastConversationSignature = signature;
		onConversationChange(state);
	}

	function clearNpcActors() {
		for (const actor of npcActors) {
			actor.removeMarker();
			game.currentScene.remove(actor);
		}
		npcActors = [];
		npcActorsById.clear();
		activeNpcId = null;
		activeMessageIndex = 0;
		activeLineElapsedMs = 0;
		dismissedNpcId = null;
		emitConversation(null);
	}

	function findNearestNpc(): FeedAuthorNpc | null {
		if (!player || npcActors.length === 0) return null;

		let nearest: FeedAuthorNpc | null = null;
		let nearestDistance = Number.POSITIVE_INFINITY;
		for (const npc of npcActors) {
			const distance = npc.pos.distance(player.pos);
			if (distance > TALK_RANGE || distance >= nearestDistance) continue;
			nearest = npc;
			nearestDistance = distance;
		}
		return nearest;
	}

	function computeBubblePosition(actor: FeedAuthorNpc): {
		x: number;
		y: number;
		placement: 'above' | 'below';
	} {
		const metrics = computeActorScreenMetrics(actor.pos, NPC_SIZE);
		const stageWidth = Math.max(canvas.clientWidth, VIEWPORT_WIDTH);
		const stageHeight = Math.max(canvas.clientHeight, VIEWPORT_HEIGHT);
		const bubbleWidth = Math.min(BUBBLE_MAX_WIDTH, stageWidth - BUBBLE_STAGE_MARGIN * 2);
		const bubbleHalfWidth = bubbleWidth / 2;
		const minX = bubbleHalfWidth + BUBBLE_STAGE_MARGIN;
		const maxX = stageWidth - bubbleHalfWidth - BUBBLE_STAGE_MARGIN;
		const npcTop = metrics.y - metrics.size / 2;
		const npcBottom = metrics.y + metrics.size / 2;
		const availableAbove = npcTop - BUBBLE_STAGE_MARGIN;
		const availableBelow = stageHeight - npcBottom - BUBBLE_STAGE_MARGIN;
		const placement =
			availableAbove < BUBBLE_TOP_FLIP_THRESHOLD && availableBelow > availableAbove
				? 'below'
				: 'above';
		const anchorY = placement === 'below' ? npcBottom : npcTop;
		const clampedY = placement === 'below'
			? clamp(anchorY, BUBBLE_STAGE_MARGIN, stageHeight - BUBBLE_STAGE_MARGIN)
			: clamp(anchorY, BUBBLE_STAGE_MARGIN, stageHeight - BUBBLE_STAGE_MARGIN);
		return {
			x: maxX > minX ? clamp(metrics.x, minX, maxX) : stageWidth / 2,
			y: clampedY,
			placement
		};
	}

	function syncPlayerMarker() {
		if (!player) return;
		const metrics = computeActorScreenMetrics(player.pos, PLAYER_MARKER_WORLD_SIZE);
		player.syncMarker(metrics.x, metrics.y, Math.max(metrics.size, 34));
	}

	function syncNpcMarkers(focusNpcId: string | null) {
		const stageWidth = Math.max(canvas.clientWidth, VIEWPORT_WIDTH);
		const stageHeight = Math.max(canvas.clientHeight, VIEWPORT_HEIGHT);
		for (const actor of npcActors) {
			const metrics = computeActorScreenMetrics(actor.pos, NPC_SIZE);
			const visible =
				metrics.x + metrics.size / 2 >= -MARKER_CULL_MARGIN &&
				metrics.x - metrics.size / 2 <= stageWidth + MARKER_CULL_MARGIN &&
				metrics.y + metrics.size / 2 >= -MARKER_CULL_MARGIN &&
				metrics.y - metrics.size / 2 <= stageHeight + MARKER_CULL_MARGIN;
			actor.syncMarker(
				metrics.x,
				metrics.y,
				metrics.size,
				actor.data.id === focusNpcId,
				visible
			);
		}
	}

	function syncConversationState(elapsed: number) {
		syncPlayerMarker();

		if (!player) {
			syncNpcMarkers(null);
			emitConversation(null);
			return;
		}

		const keyboard = game.input.keyboard;
		const nearestNpc = findNearestNpc();
		const manualAdvancePressed =
			keyboard.wasPressed(ex.Keys.Space) ||
			keyboard.wasPressed(ex.Keys.Enter) ||
			keyboard.wasPressed(ex.Keys.NumEnter);
		const closePressed = keyboard.wasPressed(ex.Keys.Escape);

		if (!nearestNpc) {
			dismissedNpcId = null;
			activeNpcId = null;
			activeMessageIndex = 0;
			activeLineElapsedMs = 0;
			syncNpcMarkers(null);
			emitConversation(null);
			return;
		}

		if (dismissedNpcId && nearestNpc.data.id !== dismissedNpcId) {
			dismissedNpcId = null;
		}

		if (closePressed && activeNpcId && nearestNpc.data.id === activeNpcId) {
			dismissedNpcId = activeNpcId;
			activeNpcId = null;
			activeMessageIndex = 0;
			activeLineElapsedMs = 0;
		}

		if (dismissedNpcId === nearestNpc.data.id) {
			syncNpcMarkers(nearestNpc.data.id);
			emitConversation(null);
			return;
		}

		if (activeNpcId !== nearestNpc.data.id) {
			activeNpcId = nearestNpc.data.id;
			activeMessageIndex = 0;
			activeLineElapsedMs = 0;
		}

		const lineCount = Math.max(1, nearestNpc.data.lines.length);
		if (lineCount > 1) {
			if (manualAdvancePressed) {
				activeMessageIndex = (activeMessageIndex + 1) % lineCount;
				activeLineElapsedMs = 0;
			} else {
				const activeLine = nearestNpc.data.lines[activeMessageIndex % lineCount];
				activeLineElapsedMs += elapsed;
				if (activeLineElapsedMs >= estimateAutoAdvanceMs(activeLine)) {
					activeMessageIndex = (activeMessageIndex + 1) % lineCount;
					activeLineElapsedMs = 0;
				}
			}
		} else {
			activeLineElapsedMs = 0;
		}

		syncNpcMarkers(activeNpcId);

		const line = nearestNpc.data.lines[activeMessageIndex % lineCount];
		const bubble = computeBubblePosition(nearestNpc);
		emitConversation({
			mode: 'talk',
			npc: nearestNpc.data,
			line,
			lineIndex: activeMessageIndex % lineCount,
			lineCount,
			screenX: bubble.x,
			screenY: bubble.y,
			placement: bubble.placement,
			hint:
				lineCount > 1
					? 'Posts open automatically nearby. Space skips ahead. Esc hides this author until you walk away.'
					: 'Posts open automatically nearby. Esc hides this author until you walk away.'
		});
	}

	const loader = new ex.Loader([townResource]);
	await game.start(loader);

	if (disposed) {
		game.dispose();
		return {
			async setPopulation() {},
			setPlayerIdentity() {},
			dispose() {}
		};
	}

	const scene = game.currentScene;
	townResource.addToScene(scene, { pos: ex.vec(0, 0) });

	const landscapeDrawHandler = (event: ex.PreDrawEvent) => {
		if (disposed) return;

		const ctx = event.ctx;
		const zoom = scene.camera.zoom || 1;
		const halfWidth = VIEWPORT_WIDTH / (2 * zoom) + LANDSCAPE_PADDING;
		const halfHeight = VIEWPORT_HEIGHT / (2 * zoom) + LANDSCAPE_PADDING;
		const cameraPos = scene.camera.pos.clone();
		const minWorldX = cameraPos.x - halfWidth;
		const maxWorldX = cameraPos.x + halfWidth;
		const minWorldY = cameraPos.y - halfHeight;
		const maxWorldY = cameraPos.y + halfHeight;
		const minChunkX = Math.floor(minWorldX / LANDSCAPE_CHUNK_SIZE);
		const maxChunkX = Math.floor(maxWorldX / LANDSCAPE_CHUNK_SIZE);
		const minChunkY = Math.floor(minWorldY / LANDSCAPE_CHUNK_SIZE);
		const maxChunkY = Math.floor(maxWorldY / LANDSCAPE_CHUNK_SIZE);

		ctx.save();
		ctx.useDrawSorting = false;
		ctx.smoothing = false;
		scene.camera.draw(ctx);

		for (let chunkY = minChunkY; chunkY <= maxChunkY; chunkY++) {
			for (let chunkX = minChunkX; chunkX <= maxChunkX; chunkX++) {
				const originX = chunkX * LANDSCAPE_CHUNK_SIZE;
				const originY = chunkY * LANDSCAPE_CHUNK_SIZE;

				for (
					let tileOffsetY = 0;
					tileOffsetY < LANDSCAPE_CHUNK_SIZE;
					tileOffsetY += LANDSCAPE_TILE_SIZE
				) {
					for (
						let tileOffsetX = 0;
						tileOffsetX < LANDSCAPE_CHUNK_SIZE;
						tileOffsetX += LANDSCAPE_TILE_SIZE
					) {
						const tileX = originX + tileOffsetX;
						const tileY = originY + tileOffsetY;
						const centerX = tileX + LANDSCAPE_TILE_SIZE / 2;
						const centerY = tileY + LANDSCAPE_TILE_SIZE / 2;
						const ground = sampleGroundColor(centerX, centerY);
						ctx.drawRectangle(
							ex.vec(tileX, tileY),
							LANDSCAPE_TILE_SIZE + 1,
							LANDSCAPE_TILE_SIZE + 1,
							ground.color
						);

						const detailSeed = hashCoordinate(
							Math.floor(centerX / LANDSCAPE_TILE_SIZE),
							Math.floor(centerY / LANDSCAPE_TILE_SIZE),
							71
						);
						const detailPos = ex.vec(centerX, centerY);

						if (ground.isWater) {
							drawWaterDetail(ctx, detailPos, detailSeed);
							continue;
						}

						if (ground.isPath) {
							if (detailSeed > 0.86) {
								drawRockCluster(ctx, detailPos, detailSeed);
							}
							continue;
						}

						if (!ground.isSand && ground.meadowNoise > 0.56 && detailSeed > 0.73) {
							drawTreeCluster(ctx, detailPos.add(ex.vec(0, 2)), detailSeed);
						} else if (detailSeed > 0.88) {
							drawRockCluster(ctx, detailPos, detailSeed);
						} else if (detailSeed > 0.62 && ground.textureNoise > 0.48) {
							drawFlowerPatch(ctx, detailPos, detailSeed);
						}
					}
				}
			}
		}

		ctx.restore();
	};

	const postUpdateHandler = (event: ex.PostUpdateEvent<ex.Engine>) => {
		if (!disposed) syncConversationState(event.elapsed);
	};

	const markersLayer = townResource.getObjectLayers('Markers')[0];
	const playerStart = markersLayer?.getObjectsByName('player-start')[0];
	const playerStartPos = playerStart
		? ex.vec(playerStart.x, playerStart.y)
		: ex.vec(TILE_SIZE * 10 + TILE_SIZE / 2, TILE_SIZE * 7 + TILE_SIZE / 2);

	player = new TownPlayer(
		playerStartPos,
		createMarkerElement(markerLayer, {
			avatar: options.playerIdentity?.avatar ?? null,
			colorHex: options.playerIdentity?.colorHex ?? PLAYER_FALLBACK_COLOR,
			variant: 'player',
			label: options.playerIdentity ? 'You' : 'Guest'
		}),
		options.playerIdentity ?? null
	);
	scene.add(player);

	scene.camera.zoom = 2.15;
	scene.camera.pos = player.pos.clone();
	scene.camera.strategy.lockToActor(player);

	scene.on('predraw', landscapeDrawHandler);
	game.on('postupdate', postUpdateHandler);
	window.addEventListener('keydown', preventBrowserKeys, { passive: false });

	return {
		async setPopulation(npcs: TownNpcData[]) {
			const requestToken = ++populationRequestToken;
			if (disposed) return;

			const spawnPositions = buildSpawnPositions(npcs.length, playerStartPos);
			const seenIds = new Set<string>();
			const nextActors = npcs.map((npc, index) => {
				seenIds.add(npc.id);

				const existingActor = npcActorsById.get(npc.id);
				if (existingActor) {
					existingActor.updateData(npc);
					existingActor.setBasePos(spawnPositions[index]);
					return existingActor;
				}

				const actor = new FeedAuthorNpc(
					npc,
					spawnPositions[index],
					(index * 380) % 2000,
					createMarkerElement(markerLayer, {
						avatar: npc.avatar,
						colorHex: npc.colorHex,
						variant: 'npc'
					})
				);
				npcActorsById.set(npc.id, actor);
				scene.add(actor);
				return actor;
			});

			for (const actor of npcActors) {
				if (seenIds.has(actor.data.id)) continue;
				npcActorsById.delete(actor.data.id);
				actor.removeMarker();
				scene.remove(actor);
			}

			npcActors = nextActors;
			syncPlayerMarker();
			syncNpcMarkers(activeNpcId);

			if (disposed || requestToken !== populationRequestToken) return;
		},
		setPlayerIdentity(identity: TownPlayerIdentity | null) {
			player?.setIdentity(identity);
			syncPlayerMarker();
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			window.removeEventListener('keydown', preventBrowserKeys);
			scene.off('predraw', landscapeDrawHandler);
			game.off('postupdate', postUpdateHandler);
			clearNpcActors();
			player?.removeMarker();
			emitConversation(null);
			game.dispose();
		}
	};
}
