<script lang="ts">
	import { onMount } from 'svelte';
	import '../../app.css';
	import ErrorBanner from '$lib/components/ErrorBanner.svelte';
	import LoadingSpinner from '$lib/components/LoadingSpinner.svelte';
	import FontPicker from '$lib/components/FontPicker.svelte';
	import RouteNav from '$lib/components/RouteNav.svelte';
	import {
		getProfile,
		searchActorsTypeahead,
		type ActorSuggestion,
		type ProfileInfo
	} from '$lib/api/bluesky';
	import type {
		ClusterApiResponse,
		ClusterBuildFailure,
		ClusterBuildProgress,
		ClusterInspectorThread,
		ClusterOverview,
		ClusterSummary,
		ClusterThreadApiResponse
	} from '$lib/types';
	import {
		createCompactClusterPointStore,
		parseDidFromRootUri,
		type CompactClusterPointStore
	} from '$lib/utils/clusterPointsCompact';
	import {
		buildRenderedClusterLabels,
		buildRenderedClusterPoints,
		createClusterSpatialIndex,
		getClusterWorldBounds,
		hitTestClusterSpatialIndex,
		screenRadiusToWorld,
		screenToWorld,
		worldToScreen,
		type ClusterSpatialIndex,
		type ClusterViewport
	} from '$lib/utils/clusterPlot';
	import type { ProjectionCoordinate } from '$lib/utils/clusterProjection';

	type AtlasRoutePageProps = {
		currentRoute?: 'cluster' | 'toponomy';
		pageTitle?: string;
		pageSubtitle?: string;
		statusEndpoint?: string;
		overviewEndpoint?: string;
		pointsEndpoint?: string;
		threadEndpoint?: string;
		loadingLabel?: string;
		pointLabel?: string;
		missingTitle?: string;
		missingBody?: string;
		failureTitle?: string;
		buildCommand?: string;
	};

	let {
		currentRoute = 'cluster',
		pageTitle = 'Global Cluster Snapshot',
		pageSubtitle = 'Global cached thread embeddings projected into a stable atlas. Pan and zoom move the camera only; the map itself does not reflow.',
		statusEndpoint = '/api/cluster',
		overviewEndpoint = '/api/cluster/overview',
		pointsEndpoint = '/api/cluster/points/compact',
		threadEndpoint = '/api/cluster/thread',
		loadingLabel = 'cluster snapshot',
		pointLabel = 'cluster points',
		missingTitle = 'Snapshot Not Built Yet',
		missingBody = 'The atlas reads a saved cluster snapshot. Build it locally, then refresh this page.',
		failureTitle = 'Snapshot Build Failed',
		buildCommand = 'npm run cluster:build'
	}: AtlasRoutePageProps = $props();

	const FIT_MARGIN = 80;
	const ZOOM_MIN = 0.0001;
	const ZOOM_MAX = 200000;
	const PAN_DRAG_THRESHOLD_PX = 4;
	const HOVER_THRESHOLD_PX = 18;
	const CLICK_THRESHOLD_PX = 16;
	const ATLAS_LABEL_PADDING_PX = 72;
	const COMPACT_POINTS_REQUEST_VERSION = 'compact-v2';
	const fontFamilies: Record<string, string> = {
		virgil: "'Virgil', cursive",
		caveat: "'Caveat', cursive",
		patrick: "'Patrick Hand', cursive",
		'comic-neue': "'Comic Neue', cursive",
		inter: "'Inter', sans-serif",
		system: 'system-ui, -apple-system, sans-serif'
	};
	const clusterPalette = [
		'#c8553d',
		'#457b9d',
		'#2a9d8f',
		'#f4a261',
		'#6d597a',
		'#7b9e46',
		'#d62828',
		'#264653',
		'#ffb703',
		'#8ecae6',
		'#9c6644',
		'#5a189a'
	];

	type PlotBounds = {
		minX: number;
		maxX: number;
		minY: number;
		maxY: number;
	};

	type ThreadSelectionTarget = {
		rootUri: string;
		cluster: number;
		did?: string | null;
		pointIndex?: number | null;
		worldX?: number | null;
		worldY?: number | null;
	};

	type SelectedPointRef = {
		rootUri: string;
		cluster: number;
		did: string | null;
		pointIndex: number | null;
		worldX: number | null;
		worldY: number | null;
	};

	type ClusterPaint = {
		fill: string;
		idleFill: string;
		idleHoverFill: string;
		mutedFill: string;
		hoverFill: string;
		selectedStroke: string;
	};

	type HoverCardState = {
		rootUri: string;
		cluster: number;
		screenX: number;
		screenY: number;
	};

	type HoverCardPosition = {
		left: number;
		top: number;
	};

	type AtlasRegionLabel = {
		cluster: number;
		summary: ClusterSummary;
		screenX: number;
		screenY: number;
		active: boolean;
		inspected: boolean;
		labelRank: number;
	};

	type ClusterAuthorSuggestion = ActorSuggestion & {
		threadCount: number;
	};

	let overview = $state<ClusterOverview | null>(null);
	let pointStore = $state.raw<CompactClusterPointStore | null>(null);
	let pointIndex = $state.raw<ClusterSpatialIndex | null>(null);
	let pointDids = $state.raw<string[]>([]);
	let authorPointIndices = $state.raw<Map<string, number[]>>(new Map());
	let progress = $state<ClusterBuildProgress | null>(null);
	let failure = $state<ClusterBuildFailure | null>(null);
	let missing = $state(false);
	let selectedClusterIds = $state<number[]>([]);
	let selectedAuthorDid = $state<string | null>(null);
	let selectedRootUri = $state<string | null>(null);
	let selectedPointRef = $state<SelectedPointRef | null>(null);
	let inspectedClusterId = $state<number | null>(null);
	let detailMode = $state<'cluster' | 'thread'>('cluster');
	let selectedThread = $state<ClusterInspectorThread | null>(null);
	let selectedThreadLoading = $state(false);
	let selectedThreadError = $state<string | null>(null);
	let loading = $state(true);
	let pointsLoading = $state(false);
	let pointsError = $state<string | null>(null);
	let error = $state<string | null>(null);
	let polling = false;
	let destroyed = false;
	let mapViewportEl: HTMLDivElement | undefined = $state();
	let backgroundCanvasEl: HTMLCanvasElement | undefined = $state();
	let pointCanvasEl: HTMLCanvasElement | undefined = $state();
	let zoom = $state(1);
	let fitZoom = $state(1);
	let panX = $state(0);
	let panY = $state(0);
	let isPanning = $state(false);
	let hasManualCamera = $state(false);
	let fitSignature = $state('');
	let viewportWidth = $state(0);
	let viewportHeight = $state(0);
	let viewportDpr = $state(1);
	let pointerStartX = $state(0);
	let pointerStartY = $state(0);
	let pointerStartPanX = $state(0);
	let pointerStartPanY = $state(0);
	let pointerMoved = $state(false);
	let hoveredPointIndex = $state<number | null>(null);
	let hoveredRootUri = $state<string | null>(null);
	let hoverPreviewThread = $state<ClusterInspectorThread | null>(null);
	let hoverPreviewLoading = $state(false);
	let selectionAuthorProfile = $state<ProfileInfo | null>(null);
	let hoverAuthorProfile = $state<ProfileInfo | null>(null);
	let authorSearchInput = $state('');
	let authorSuggestions = $state<ClusterAuthorSuggestion[]>([]);
	let showAuthorSuggestions = $state(false);
	let activeAuthorSuggestionIndex = $state(-1);
	let authorSearchLoading = $state(false);
	let authorSearchError = $state<string | null>(null);
	let authorSearchTimer: ReturnType<typeof setTimeout> | null = null;
	let showAtlasInfoCard = $state(true);
	let showAuthorSearchCard = $state(true);
	let showClusterListCard = $state(true);
	let showSelectedClassesCard = $state(true);
	let fontKey = $state('system');
	let fontFamily = $derived(fontFamilies[fontKey] ?? fontFamilies.system);

	const threadCache = new Map<string, ClusterInspectorThread>();
	const authorProfileCache = new Map<string, ProfileInfo>();
	const clusterPaintCache = new Map<number, ClusterPaint>();
	let threadRequestId = 0;
	let hoverRequestId = 0;
	let selectionAuthorRequestId = 0;
	let hoverAuthorRequestId = 0;
	let authorSuggestionRequestId = 0;
	let hoverPreviewTimer: ReturnType<typeof setTimeout> | null = null;
	let backgroundFrame = 0;
	let pointFrame = 0;

	function clamp(value: number, min: number, max: number): number {
		return Math.min(max, Math.max(min, value));
	}

	function clusterColor(cluster: number): string {
		return clusterPalette[cluster % clusterPalette.length];
	}

	function colorWithAlpha(color: string, alpha: number): string {
		const normalized = color.replace('#', '');
		const value =
			normalized.length === 3
				? normalized
						.split('')
						.map((part) => part + part)
						.join('')
				: normalized;
		const red = Number.parseInt(value.slice(0, 2), 16);
		const green = Number.parseInt(value.slice(2, 4), 16);
		const blue = Number.parseInt(value.slice(4, 6), 16);
		return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
	}

	function clusterPaint(cluster: number): ClusterPaint {
		const cached = clusterPaintCache.get(cluster);
		if (cached) return cached;

		const color = clusterColor(cluster);
		const nextPaint = {
			fill: colorWithAlpha(color, 0.94),
			idleFill: colorWithAlpha(color, 0.28),
			idleHoverFill: colorWithAlpha(color, 0.5),
			mutedFill: colorWithAlpha(color, 0.12),
			hoverFill: colorWithAlpha(color, 1),
			selectedStroke: '#101217'
		};
		clusterPaintCache.set(cluster, nextPaint);
		return nextPaint;
	}

	function formatDateTime(value: string): string {
		const parsed = new Date(value);
		if (!Number.isFinite(parsed.getTime())) return value;
		return parsed.toLocaleString();
	}

	function handleFontChange(key: string) {
		fontKey = key;
		try {
			localStorage.setItem('preferred-font', key);
		} catch {}
	}

	function parseRootUri(rootUri: string): { did: string; rkey: string } | null {
		const parts = rootUri.split('/');
		const did = parts[2]?.trim();
		const rkey = parts[4]?.trim();
		if (!did || !rkey) return null;
		return { did, rkey };
	}

	function buildBskyUrl(rootUri: string): string {
		const parsed = parseRootUri(rootUri);
		if (!parsed) return '';
		return `https://bsky.app/profile/${parsed.did}/post/${parsed.rkey}`;
	}

	function buildThreadViewUrl(rootUri: string): string {
		const bskyUrl = buildBskyUrl(rootUri);
		return bskyUrl ? `/board?url=${encodeURIComponent(bskyUrl)}` : '/board';
	}

	function buildChatUrl(rootUri: string): string {
		const bskyUrl = buildBskyUrl(rootUri);
		return bskyUrl ? `/chat?url=${encodeURIComponent(bskyUrl)}` : '/chat';
	}

	function isClusterOverview(value: unknown): value is ClusterOverview {
		return Boolean(
			value &&
				typeof value === 'object' &&
				(value as ClusterOverview).meta &&
				Array.isArray((value as ClusterOverview).clusters)
		);
	}

	function pointWorldX(index: number): number {
		return pointStore?.x[index] ?? 0;
	}

	function pointWorldY(index: number): number {
		return -((pointStore?.y[index] ?? 0) as number);
	}

	function pointCluster(index: number): number {
		return pointStore?.clusters[index] ?? 0;
	}

	function pointRootUri(index: number): string {
		return pointStore?.decodeRootUri(index) ?? '';
	}

	function pointDid(index: number): string | null {
		const did = pointDids[index];
		return did?.trim() ? did : null;
	}

	function cacheAuthorProfile(profile: ActorSuggestion | ProfileInfo): ProfileInfo {
		const cached = authorProfileCache.get(profile.did);
		const nextProfile: ProfileInfo = {
			did: profile.did,
			handle: profile.handle,
			displayName: profile.displayName,
			avatar: profile.avatar,
			postsCount:
				'postsCount' in profile && Number.isFinite(profile.postsCount)
					? profile.postsCount
					: cached?.postsCount ?? 0
		};
		authorProfileCache.set(profile.did, nextProfile);
		return nextProfile;
	}

	async function resolveAuthorProfile(did: string | null): Promise<ProfileInfo | null> {
		const cleaned = did?.trim() ?? '';
		if (!cleaned) return null;
		const cached = authorProfileCache.get(cleaned);
		if (cached) return cached;
		try {
			const profile = await getProfile(cleaned);
			authorProfileCache.set(cleaned, profile);
			return profile;
		} catch {
			return null;
		}
	}

	function authorDisplayName(profile: ProfileInfo | null, did: string | null): string {
		return profile?.displayName?.trim() || (profile?.handle ? `@${profile.handle}` : did?.trim() || '');
	}

	function authorHandleLabel(profile: ProfileInfo | null, did: string | null): string {
		return profile?.handle?.trim() ? `@${profile.handle}` : did?.trim() || '';
	}

	function buildBskyProfileUrl(actor: string | null): string {
		const cleaned = actor?.trim() ?? '';
		return cleaned ? `https://bsky.app/profile/${cleaned}` : '';
	}

	function findPointIndexByRootUriInStore(
		points: CompactClusterPointStore | null,
		rootUri: string
	): number | null {
		if (!points || !rootUri) return null;
		for (let index = 0; index < points.count; index += 1) {
			if (points.decodeRootUri(index) === rootUri) {
				return index;
			}
		}
		return null;
	}

	function findPointIndexByRootUri(rootUri: string): number | null {
		return findPointIndexByRootUriInStore(pointStore, rootUri);
	}

	async function requestCluster(): Promise<ClusterApiResponse> {
		const response = await fetch(statusEndpoint);
		const payload = (await response.json().catch(() => null)) as ClusterApiResponse | null;
		if (!response.ok || !payload) {
			throw new Error(`${pageTitle} request failed (${response.status}).`);
		}
		return payload;
	}

	async function requestClusterOverview(): Promise<ClusterOverview | null> {
		const response = await fetch(overviewEndpoint);
		if (response.status === 404) {
			return null;
		}
		const payload = (await response.json().catch(() => null)) as ClusterOverview | null;
		if (!response.ok || !payload || !isClusterOverview(payload)) {
			throw new Error(`${pageTitle} overview request failed (${response.status}).`);
		}
		return payload;
	}

	async function requestCompactClusterPoints(): Promise<CompactClusterPointStore | null> {
		const response = await fetch(
			`${pointsEndpoint}?format=${encodeURIComponent(COMPACT_POINTS_REQUEST_VERSION)}`
		);
		if (response.status === 404) {
			return null;
		}
		const payload = await response.arrayBuffer().catch(() => null);
		if (!response.ok || !payload) {
			throw new Error(`${pageTitle} compact points request failed (${response.status}).`);
		}
		return createCompactClusterPointStore(payload);
	}

	async function requestClusterThread(
		did: string,
		rootUri: string
	): Promise<ClusterInspectorThread> {
		const response = await fetch(
			`${threadEndpoint}?did=${encodeURIComponent(did)}&rootUri=${encodeURIComponent(rootUri)}`
		);
		const payload = (await response.json().catch(() => null)) as ClusterThreadApiResponse | null;
		if (payload?.status === 'ready') {
			return payload.thread;
		}
		if (payload?.status === 'missing') {
			throw new Error(payload.message || 'The cached self-reply thread is not available.');
		}
		throw new Error(`${pageTitle} thread request failed (${response.status}).`);
	}

	function applyOverview(nextOverview: ClusterOverview) {
		overview = nextOverview;
		progress = null;
		failure = null;
		missing = false;
		selectedClusterIds = selectedClusterIds.filter((clusterId) =>
			nextOverview.clusters.some((cluster) => cluster.cluster === clusterId)
		);
		loading = false;
	}

	function applyPoints(nextPoints: CompactClusterPointStore) {
		pointStore = nextPoints;
		pointIndex = createClusterSpatialIndex(nextPoints, { yDirection: -1 });
		const nextPointDids = new Array<string>(nextPoints.count);
		const nextAuthorPointIndices = new Map<string, number[]>();
		for (let index = 0; index < nextPoints.count; index += 1) {
			const did = parseDidFromRootUri(nextPoints.decodeRootUri(index)) ?? '';
			nextPointDids[index] = did;
			if (!did) continue;
			const existing = nextAuthorPointIndices.get(did);
			if (existing) {
				existing.push(index);
			} else {
				nextAuthorPointIndices.set(did, [index]);
			}
		}
		pointDids = nextPointDids;
		authorPointIndices = nextAuthorPointIndices;
		pointsLoading = false;
		pointsError = null;
		if (selectedAuthorDid && !nextAuthorPointIndices.has(selectedAuthorDid)) {
			selectedAuthorDid = null;
		}

		const currentSelection = selectedPointRef;
		if (
			currentSelection &&
			currentSelection.pointIndex !== null &&
			currentSelection.pointIndex >= nextPoints.count
		) {
			selectedPointRef = {
				...currentSelection,
				pointIndex: null
			};
		}

		if (selectedPointRef?.pointIndex === null && selectedPointRef?.rootUri) {
			const matchedIndex = findPointIndexByRootUriInStore(nextPoints, selectedPointRef.rootUri);
			if (matchedIndex !== null) {
				const matchedRootUri = nextPoints.decodeRootUri(matchedIndex);
				selectedPointRef = {
					...selectedPointRef,
					rootUri: matchedRootUri,
					did: selectedPointRef.did ?? parseDidFromRootUri(matchedRootUri),
					pointIndex: matchedIndex,
					worldX: nextPoints.x[matchedIndex] ?? null,
					worldY: -((nextPoints.y[matchedIndex] ?? 0) as number)
				};
			}
		}
	}

	function clearPointState() {
		pointStore = null;
		pointIndex = null;
	}

	function applyClusterPayload(payload: ClusterApiResponse) {
		if (payload.status === 'building') {
			overview = null;
			clearPointState();
			selectedClusterIds = [];
			inspectedClusterId = null;
			selectedRootUri = null;
			selectedPointRef = null;
			detailMode = 'cluster';
			selectedThread = null;
			selectedThreadError = null;
			selectedThreadLoading = false;
			progress = payload.progress;
			failure = null;
			missing = false;
			loading = true;
			pointsLoading = false;
			pointsError = null;
			fitSignature = '';
			return;
		}

		if (payload.status === 'failed') {
			overview = null;
			clearPointState();
			selectedClusterIds = [];
			inspectedClusterId = null;
			selectedRootUri = null;
			selectedPointRef = null;
			detailMode = 'cluster';
			selectedThread = null;
			selectedThreadError = null;
			selectedThreadLoading = false;
			progress = null;
			failure = payload.failure;
			missing = false;
			loading = false;
			pointsLoading = false;
			pointsError = null;
			fitSignature = '';
			return;
		}

		overview = null;
		clearPointState();
		selectedClusterIds = [];
		inspectedClusterId = null;
		selectedRootUri = null;
		selectedPointRef = null;
		detailMode = 'cluster';
		selectedThread = null;
		selectedThreadError = null;
		selectedThreadLoading = false;
		progress = null;
		failure = null;
		missing = payload.status === 'missing';
		loading = false;
		pointsLoading = false;
		pointsError = null;
		fitSignature = '';
	}

	async function loadPoints() {
		pointsLoading = true;
		pointsError = null;

		try {
			const payload = await requestCompactClusterPoints();
			if (!payload) {
				pointsLoading = false;
				pointsError = `Saved ${pointLabel} are not available yet.`;
				return;
			}
			applyPoints(payload);
		} catch (cause: any) {
			pointsLoading = false;
			pointsError = cause?.message || `Failed to load ${pointLabel}.`;
		}
	}

	function wait(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}

	async function pollBuild() {
		if (polling) return;
		polling = true;

		try {
			while (!destroyed) {
				const payload = await requestCluster();
				if (payload.status === 'ready') {
					const nextOverview = await requestClusterOverview();
					if (nextOverview) {
						applyOverview(nextOverview);
						await loadPoints();
						break;
					}
					applyClusterPayload({ status: 'missing' });
					break;
				}
				applyClusterPayload(payload);
				if (payload.status !== 'building') break;
				await wait(1000);
			}
		} finally {
			polling = false;
		}
	}

	async function load() {
		loading = true;
		error = null;
		failure = null;
		missing = false;
		pointsError = null;

		try {
			const overviewPayload = await requestClusterOverview();
			if (overviewPayload) {
				applyOverview(overviewPayload);
				await loadPoints();
				return;
			}

			const payload = await requestCluster();
			if (payload.status === 'ready') {
				const readyOverview = await requestClusterOverview();
				if (readyOverview) {
					applyOverview(readyOverview);
					await loadPoints();
					return;
				}
				applyClusterPayload({ status: 'missing' });
				return;
			}

			applyClusterPayload(payload);
			if (payload.status === 'building') {
				await pollBuild();
			}
		} catch (cause: any) {
			error = cause?.message || `Failed to load ${loadingLabel}.`;
			loading = false;
		}
	}

	function clearThreadInspector() {
		selectedRootUri = null;
		selectedPointRef = null;
		detailMode = 'cluster';
		selectedThread = null;
		selectedThreadError = null;
		selectedThreadLoading = false;
	}

	function clearClusterSelection() {
		selectedClusterIds = [];
		inspectedClusterId = null;
	}

	function isClusterSelected(cluster: number): boolean {
		return selectedClusterIds.includes(cluster);
	}

	function setClusterSelected(cluster: number, selected: boolean) {
		const alreadySelected = isClusterSelected(cluster);
		if (selected === alreadySelected) return;
		selectedClusterIds = selected
			? [...selectedClusterIds, cluster].sort((left, right) => left - right)
			: selectedClusterIds.filter((value) => value !== cluster);
		if (!selected && inspectedClusterId === cluster) {
			inspectedClusterId = null;
		}
	}

	function toggleClusterSelection(cluster: number) {
		clearAuthorHighlight();
		clearThreadInspector();
		setClusterSelected(cluster, !isClusterSelected(cluster));
	}

	function openClusterInspector(cluster: number) {
		clearAuthorHighlight();
		clearThreadInspector();
		setClusterSelected(cluster, true);
		inspectedClusterId = cluster;
		detailMode = 'cluster';
		showSelectedClassesCard = true;
	}

	function dismissClusterInspector() {
		inspectedClusterId = null;
	}

	function focusRepresentative(rep: ClusterSummary['representatives'][number]) {
		const matchedIndex = findPointIndexByRootUri(rep.rootUri);
		if (matchedIndex !== null) {
			focusPointIndex(matchedIndex);
			return;
		}

		void focusThread({
			rootUri: rep.rootUri,
			cluster: rep.cluster,
			did: rep.did,
			pointIndex: null,
			worldX: Number.isFinite(rep.x) ? rep.x : null,
			worldY: Number.isFinite(rep.y) ? -rep.y : null
		});
	}

	function focusPointIndex(index: number) {
		const rootUri = pointRootUri(index);
		if (!rootUri) return;
		void focusThread({
			rootUri,
			cluster: pointCluster(index),
			did: parseDidFromRootUri(rootUri),
			pointIndex: index,
			worldX: pointWorldX(index),
			worldY: pointWorldY(index)
		});
	}

	async function focusThread(target: ThreadSelectionTarget) {
		const did = target.did?.trim() || parseDidFromRootUri(target.rootUri);
		clearAuthorHighlight();
		inspectedClusterId = null;
		selectedPointRef = {
			rootUri: target.rootUri,
			cluster: target.cluster,
			did: did ?? null,
			pointIndex: target.pointIndex ?? null,
			worldX: target.worldX ?? null,
			worldY: target.worldY ?? null
		};
		selectedRootUri = target.rootUri;
		detailMode = 'thread';
		selectedThreadError = null;

		if (!did) {
			selectedThread = null;
			selectedThreadLoading = false;
			selectedThreadError = 'Could not derive the account DID for this thread.';
			return;
		}

		const cached = threadCache.get(target.rootUri);
		if (cached) {
			selectedThread = cached;
			selectedThreadLoading = false;
			return;
		}

		selectedThread = null;
		selectedThreadLoading = true;
		const requestId = ++threadRequestId;

		try {
			const thread = await requestClusterThread(did, target.rootUri);
			if (destroyed || requestId !== threadRequestId || selectedRootUri !== target.rootUri) return;
			threadCache.set(target.rootUri, thread);
			selectedThread = thread;
		} catch (cause: any) {
			if (destroyed || requestId !== threadRequestId || selectedRootUri !== target.rootUri) return;
			selectedThreadError = cause?.message || 'Failed to load the thread.';
		} finally {
			if (!destroyed && requestId === threadRequestId && selectedRootUri === target.rootUri) {
				selectedThreadLoading = false;
			}
		}
	}

	function resetInspector() {
		clearAuthorHighlight();
		clearClusterSelection();
		authorSearchInput = '';
		clearThreadInspector();
	}

	function getPlotBounds(points: CompactClusterPointStore): PlotBounds {
		return getClusterWorldBounds(points, -1);
	}

	function getPlotCentroid(points: CompactClusterPointStore): ProjectionCoordinate {
		if (points.count === 0) {
			return { x: 0, y: 0 };
		}

		let totalX = 0;
		let totalY = 0;
		for (let index = 0; index < points.count; index += 1) {
			totalX += points.x[index] ?? 0;
			totalY += -((points.y[index] ?? 0) as number);
		}

		return {
			x: totalX / points.count,
			y: totalY / points.count
		};
	}

	function fitCameraToPoints(points: CompactClusterPointStore) {
		if (viewportWidth <= 0 || viewportHeight <= 0) return;
		const bounds = getPlotBounds(points);
		const centroid = getPlotCentroid(points);
		const width = Math.max(
			1e-6,
			Math.max(
				Math.abs(bounds.maxX - centroid.x),
				Math.abs(centroid.x - bounds.minX)
			) * 2
		);
		const height = Math.max(
			1e-6,
			Math.max(
				Math.abs(bounds.maxY - centroid.y),
				Math.abs(centroid.y - bounds.minY)
			) * 2
		);
		const nextZoom = clamp(
			Math.min(
				Math.max(32, viewportWidth - FIT_MARGIN * 2) / width,
				Math.max(32, viewportHeight - FIT_MARGIN * 2) / height
			),
			ZOOM_MIN,
			ZOOM_MAX
		);
		const centerX = centroid.x;
		const centerY = centroid.y;

		fitZoom = nextZoom;
		zoom = nextZoom;
		panX = viewportWidth / 2 - nextZoom * centerX;
		panY = viewportHeight / 2 - nextZoom * centerY;
	}

	function fitCameraToPointIndices(indices: number[]) {
		const points = pointStore;
		if (!points || indices.length === 0 || viewportWidth <= 0 || viewportHeight <= 0) return;

		let minX = Number.POSITIVE_INFINITY;
		let maxX = Number.NEGATIVE_INFINITY;
		let minY = Number.POSITIVE_INFINITY;
		let maxY = Number.NEGATIVE_INFINITY;
		let totalX = 0;
		let totalY = 0;
		let count = 0;

		for (const index of indices) {
			const worldX = points.x[index] ?? 0;
			const worldY = -((points.y[index] ?? 0) as number);
			if (!Number.isFinite(worldX) || !Number.isFinite(worldY)) continue;
			minX = Math.min(minX, worldX);
			maxX = Math.max(maxX, worldX);
			minY = Math.min(minY, worldY);
			maxY = Math.max(maxY, worldY);
			totalX += worldX;
			totalY += worldY;
			count += 1;
		}

		if (count === 0) return;
		const centerX = totalX / count;
		const centerY = totalY / count;
		const width = Math.max(0.16, Math.max(Math.abs(maxX - centerX), Math.abs(centerX - minX)) * 2);
		const height = Math.max(0.16, Math.max(Math.abs(maxY - centerY), Math.abs(centerY - minY)) * 2);
		const nextZoom = clamp(
			Math.min(
				Math.max(32, viewportWidth - FIT_MARGIN * 2) / width,
				Math.max(32, viewportHeight - FIT_MARGIN * 2) / height
			),
			ZOOM_MIN,
			ZOOM_MAX
		);

		hasManualCamera = true;
		zoom = nextZoom;
		panX = viewportWidth / 2 - nextZoom * centerX;
		panY = viewportHeight / 2 - nextZoom * centerY;
	}

	function clearAuthorSuggestions() {
		showAuthorSuggestions = false;
		activeAuthorSuggestionIndex = -1;
		authorSuggestions = [];
	}

	function clearAuthorHighlight() {
		selectedAuthorDid = null;
		authorSearchError = null;
	}

	async function fetchAuthorSuggestions() {
		const query = authorSearchInput.replace(/^@/, '').trim();
		if (query.length < 2 || authorPointIndices.size === 0) {
			authorSearchLoading = false;
			clearAuthorSuggestions();
			return;
		}

		const requestId = ++authorSuggestionRequestId;
		authorSearchLoading = true;
		try {
			const results = await searchActorsTypeahead(query);
			if (destroyed || requestId !== authorSuggestionRequestId) return;
			const filtered = results
				.filter((result) => authorPointIndices.has(result.did))
				.map((result) => ({
					...result,
					threadCount: authorPointIndices.get(result.did)?.length ?? 0
				}))
				.sort(
					(left, right) =>
						Number(right.handle.startsWith(query)) - Number(left.handle.startsWith(query)) ||
						right.threadCount - left.threadCount ||
						left.handle.localeCompare(right.handle)
				);
			authorSuggestions = filtered;
			showAuthorSuggestions = filtered.length > 0;
			activeAuthorSuggestionIndex = filtered.length > 0 ? 0 : -1;
		} catch {
			if (!destroyed && requestId === authorSuggestionRequestId) {
				clearAuthorSuggestions();
			}
		} finally {
			if (!destroyed && requestId === authorSuggestionRequestId) {
				authorSearchLoading = false;
			}
		}
	}

	function queueAuthorSuggestions() {
		if (authorSearchTimer) {
			clearTimeout(authorSearchTimer);
		}
		authorSearchTimer = window.setTimeout(() => {
			void fetchAuthorSuggestions();
		}, 180);
	}

	function handleAuthorSearchInput() {
		authorSearchError = null;
		queueAuthorSuggestions();
	}

	function handleAuthorSearchBlur() {
		window.setTimeout(() => {
			clearAuthorSuggestions();
		}, 160);
	}

	function focusAuthorDid(did: string, profile?: ActorSuggestion | ProfileInfo) {
		const indices = authorPointIndices.get(did) ?? [];
		if (indices.length === 0) {
			authorSearchError = 'That author does not have any mapped threads in this atlas.';
			return;
		}
		if (profile) {
			cacheAuthorProfile(profile);
			authorSearchInput = profile.handle;
		}
		clearAuthorSuggestions();
		clearClusterSelection();
		selectedAuthorDid = did;
		authorSearchError = null;
		clearThreadInspector();
		fitCameraToPointIndices(indices);
	}

	async function submitAuthorSearch(event: Event) {
		event.preventDefault();
		clearAuthorSuggestions();
		const cleaned = authorSearchInput.replace(/^@/, '').trim();
		if (!cleaned) return;
		authorSearchLoading = true;
		authorSearchError = null;
		try {
			const profile = await getProfile(cleaned);
			cacheAuthorProfile(profile);
			if (!authorPointIndices.has(profile.did)) {
				authorSearchError = `@${profile.handle} does not have any mapped threads in this atlas.`;
				return;
			}
			focusAuthorDid(profile.did, profile);
		} catch {
			authorSearchError = `Could not find a mapped author for "${cleaned}".`;
		} finally {
			authorSearchLoading = false;
		}
	}

	function handleAuthorSearchKeydown(event: KeyboardEvent) {
		if (event.key === 'Escape') {
			clearAuthorSuggestions();
			return;
		}
		if (!showAuthorSuggestions || authorSuggestions.length === 0) return;

		if (event.key === 'ArrowDown') {
			event.preventDefault();
			activeAuthorSuggestionIndex = (activeAuthorSuggestionIndex + 1) % authorSuggestions.length;
			return;
		}
		if (event.key === 'ArrowUp') {
			event.preventDefault();
			activeAuthorSuggestionIndex =
				activeAuthorSuggestionIndex <= 0 ? authorSuggestions.length - 1 : activeAuthorSuggestionIndex - 1;
			return;
		}
		if (event.key === 'Enter' && activeAuthorSuggestionIndex >= 0) {
			event.preventDefault();
			const suggestion = authorSuggestions[activeAuthorSuggestionIndex];
			if (suggestion) {
				focusAuthorDid(suggestion.did, suggestion);
			}
		}
	}

	function currentViewport(): ClusterViewport {
		return {
			width: viewportWidth,
			height: viewportHeight,
			zoom,
			panX,
			panY
		};
	}

	function zoomAt(nextZoom: number, centerX: number, centerY: number) {
		const worldAnchor = screenToWorld(currentViewport(), centerX, centerY);
		if (!worldAnchor) return;
		const clampedZoom = clamp(nextZoom, ZOOM_MIN, ZOOM_MAX);
		if (clampedZoom === zoom) return;
		zoom = clampedZoom;
		panX = centerX - worldAnchor.x * clampedZoom;
		panY = centerY - worldAnchor.y * clampedZoom;
	}

	function zoomIn() {
		hasManualCamera = true;
		zoomAt(zoom * 1.2, viewportWidth / 2, viewportHeight / 2);
	}

	function zoomOut() {
		hasManualCamera = true;
		zoomAt(zoom / 1.2, viewportWidth / 2, viewportHeight / 2);
	}

	function zoomReset() {
		hasManualCamera = false;
		if (pointStore) {
			fitCameraToPoints(pointStore);
		}
	}

	function syncCanvasSize(canvas: HTMLCanvasElement | undefined) {
		if (!canvas || viewportWidth <= 0 || viewportHeight <= 0) return;
		const pixelWidth = Math.max(1, Math.round(viewportWidth * viewportDpr));
		const pixelHeight = Math.max(1, Math.round(viewportHeight * viewportDpr));
		if (canvas.width === pixelWidth && canvas.height === pixelHeight) return;
		canvas.width = pixelWidth;
		canvas.height = pixelHeight;
	}

	function scheduleBackgroundRender() {
		if (backgroundFrame || destroyed) return;
		backgroundFrame = requestAnimationFrame(() => {
			backgroundFrame = 0;
			drawBackground();
		});
	}

	function schedulePointRender() {
		if (pointFrame || destroyed) return;
		pointFrame = requestAnimationFrame(() => {
			pointFrame = 0;
			drawPoints();
		});
	}

	function clearHoverTimer() {
		if (!hoverPreviewTimer) return;
		clearTimeout(hoverPreviewTimer);
		hoverPreviewTimer = null;
	}

	function updateHoverState(nextIndex: number | null) {
		if (hoveredPointIndex === nextIndex) return;

		clearHoverTimer();
		hoveredPointIndex = nextIndex;
		hoverPreviewThread = null;
		hoverPreviewLoading = false;
		hoveredRootUri = nextIndex === null ? null : pointRootUri(nextIndex);
		if (nextIndex === null || !hoveredRootUri || isPanning) return;

		const cached = threadCache.get(hoveredRootUri);
		if (cached) {
			hoverPreviewThread = cached;
			return;
		}

		const did = parseDidFromRootUri(hoveredRootUri);
		if (!did) return;
		const targetRootUri = hoveredRootUri;

		hoverPreviewLoading = true;
		const requestId = ++hoverRequestId;
		hoverPreviewTimer = window.setTimeout(async () => {
			try {
				const thread = await requestClusterThread(did, targetRootUri);
				threadCache.set(targetRootUri, thread);
				if (
					!destroyed &&
					requestId === hoverRequestId &&
					hoveredRootUri === thread.rootUri &&
					hoveredPointIndex !== null
				) {
					hoverPreviewThread = thread;
				}
			} catch {
				if (!destroyed && requestId === hoverRequestId) {
					hoverPreviewThread = null;
				}
			} finally {
				if (!destroyed && requestId === hoverRequestId) {
					hoverPreviewLoading = false;
				}
			}
		}, 120);
	}

	function drawBackground() {
		const canvas = backgroundCanvasEl;
		if (!canvas || viewportWidth <= 0 || viewportHeight <= 0) return;
		const context = canvas.getContext('2d');
		if (!context) return;

		const viewport = currentViewport();
		context.setTransform(1, 0, 0, 1, 0, 0);
		context.clearRect(0, 0, canvas.width, canvas.height);
		context.setTransform(viewportDpr, 0, 0, viewportDpr, 0, 0);

		context.save();
		context.beginPath();
		context.roundRect(0, 0, viewportWidth, viewportHeight, 28);
		context.clip();

		const gradient = context.createLinearGradient(0, 0, viewportWidth, viewportHeight);
		gradient.addColorStop(0, '#fffef8');
		gradient.addColorStop(0.56, '#f4ebd8');
		gradient.addColorStop(1, '#eadbc0');
		context.fillStyle = gradient;
		context.fillRect(0, 0, viewportWidth, viewportHeight);

		context.save();
		context.globalAlpha = 0.34;
		context.strokeStyle = 'rgba(61, 64, 91, 0.08)';
		context.lineWidth = 1;
		for (let line = -1; line <= 7; line += 1) {
			const y = (line / 6) * viewportHeight + 24;
			context.beginPath();
			context.moveTo(-40, y);
			context.lineTo(viewportWidth + 40, y + 28);
			context.stroke();
		}
		context.restore();

		context.lineWidth = 1.2;
		context.strokeStyle = 'rgba(61, 64, 91, 0.12)';
		context.beginPath();
		context.roundRect(0, 0, viewportWidth, viewportHeight, 28);
		context.stroke();
		context.restore();
	}

	function drawPoints() {
		const canvas = pointCanvasEl;
		const points = pointStore;
		if (!canvas || viewportWidth <= 0 || viewportHeight <= 0) return;
		const context = canvas.getContext('2d');
		if (!context) return;

		context.setTransform(1, 0, 0, 1, 0, 0);
		context.clearRect(0, 0, canvas.width, canvas.height);
		context.setTransform(viewportDpr, 0, 0, viewportDpr, 0, 0);

		if (!points || points.count === 0) {
			return;
		}

		context.save();
		context.beginPath();
		context.roundRect(0, 0, viewportWidth, viewportHeight, 28);
		context.clip();

		const rendered = buildRenderedClusterPoints(points, currentViewport(), {
			selectedIndex: selectedPointRef?.pointIndex ?? null,
			hoveredIndex: hoveredPointIndex,
			paddingPx: 28,
			yDirection: -1
		});

		const hasClusterHighlight = activeClusterIds.length > 0;
		const hasAuthorHighlight = selectedAuthorDid !== null;

		for (const point of rendered) {
			const paint = clusterPaint(point.cluster);
			const authorActive = hasAuthorHighlight && pointDid(point.index) === selectedAuthorDid;
			const clusterActive = activeClusterLookup.has(point.cluster);
			const visiblyActive = hasClusterHighlight
				? clusterActive || point.selected
				: hasAuthorHighlight
					? authorActive || point.selected
					: false;
			let radius = 3.3;
			if (point.selected) {
				radius = 9;
			} else if (point.hovered) {
				radius = visiblyActive ? 7.2 : 6.2;
			} else if (visiblyActive) {
				radius = 5.4;
			}

			let fillStyle = point.hovered ? paint.hoverFill : paint.fill;
			if (point.selected) {
				fillStyle = paint.hoverFill;
			} else if (hasClusterHighlight) {
				fillStyle = clusterActive
					? point.hovered
						? paint.hoverFill
						: paint.fill
					: point.hovered
						? colorWithAlpha(clusterColor(point.cluster), 0.42)
						: paint.mutedFill;
			} else if (hasAuthorHighlight) {
				fillStyle = authorActive
					? point.hovered
						? paint.hoverFill
						: paint.fill
					: point.hovered
						? colorWithAlpha(clusterColor(point.cluster), 0.42)
						: paint.mutedFill;
			} else {
				fillStyle = point.hovered ? paint.idleHoverFill : paint.idleFill;
			}

			context.beginPath();
			context.arc(point.screenX, point.screenY, radius, 0, Math.PI * 2);
			context.fillStyle = fillStyle;
			context.fill();

			if (point.selected) {
				context.lineWidth = 2.2;
				context.strokeStyle = paint.selectedStroke;
				context.stroke();
			} else if (point.hovered) {
				context.lineWidth = 1.8;
				context.strokeStyle = colorWithAlpha(clusterColor(point.cluster), 0.72);
				context.stroke();
			}
		}

		context.restore();
	}

	function updateViewportSize() {
		if (!mapViewportEl) return;
		const rect = mapViewportEl.getBoundingClientRect();
		const nextWidth = Math.max(1, Math.round(rect.width));
		const nextHeight = Math.max(1, Math.round(rect.height));
		const nextDpr = Math.max(1, window.devicePixelRatio || 1);
		const changed =
			nextWidth !== viewportWidth || nextHeight !== viewportHeight || nextDpr !== viewportDpr;
		if (!changed) return;

		viewportWidth = nextWidth;
		viewportHeight = nextHeight;
		viewportDpr = nextDpr;
		syncCanvasSize(backgroundCanvasEl);
		syncCanvasSize(pointCanvasEl);
		scheduleBackgroundRender();
		schedulePointRender();

		if (!hasManualCamera && pointStore && pointStore.count > 0) {
			fitCameraToPoints(pointStore);
		}
	}

	function clientToViewportPoint(clientX: number, clientY: number): { x: number; y: number } | null {
		if (!mapViewportEl) return null;
		const rect = mapViewportEl.getBoundingClientRect();
		if (rect.width === 0 || rect.height === 0) return null;
		return {
			x: clientX - rect.left,
			y: clientY - rect.top
		};
	}

	function updateHoveredFromPointer(clientX: number, clientY: number) {
		const anchor = clientToViewportPoint(clientX, clientY);
		if (!anchor || !pointStore || !pointIndex) {
			updateHoverState(null);
			return;
		}
		const worldPoint = screenToWorld(currentViewport(), anchor.x, anchor.y);
		if (!worldPoint) {
			updateHoverState(null);
			return;
		}
		const hit = hitTestClusterSpatialIndex(
			pointStore,
			pointIndex,
			worldPoint.x,
			worldPoint.y,
			screenRadiusToWorld(currentViewport(), HOVER_THRESHOLD_PX)
		);
		updateHoverState(hit?.index ?? null);
	}

	function handleMapWheel(event: WheelEvent) {
		event.preventDefault();
		const anchor = clientToViewportPoint(event.clientX, event.clientY);
		if (!anchor) return;
		hasManualCamera = true;
		const multiplier = Math.exp(-event.deltaY * 0.0015);
		zoomAt(zoom * multiplier, anchor.x, anchor.y);
	}

	function handleMapPointerDown(event: PointerEvent) {
		const target = event.target instanceof Element ? event.target : null;
		if (
			(event.button !== 0 && event.button !== 1) ||
			target?.closest('.map-controls, .hover-card, a, button')
		) {
			return;
		}

		event.preventDefault();
		isPanning = true;
		pointerMoved = false;
		pointerStartX = event.clientX;
		pointerStartY = event.clientY;
		pointerStartPanX = panX;
		pointerStartPanY = panY;
		mapViewportEl?.setPointerCapture(event.pointerId);
	}

	function handleMapPointerMove(event: PointerEvent) {
		if (!isPanning) {
			updateHoveredFromPointer(event.clientX, event.clientY);
			return;
		}

		const rawDeltaX = event.clientX - pointerStartX;
		const rawDeltaY = event.clientY - pointerStartY;
		if (!pointerMoved && Math.hypot(rawDeltaX, rawDeltaY) < PAN_DRAG_THRESHOLD_PX) {
			return;
		}

		if (!pointerMoved) {
			pointerMoved = true;
			hasManualCamera = true;
			updateHoverState(null);
		}

		panX = pointerStartPanX + rawDeltaX;
		panY = pointerStartPanY + rawDeltaY;
	}

	function handleMapPointerUp(event: PointerEvent) {
		if (!isPanning) return;
		const anchor = clientToViewportPoint(event.clientX, event.clientY);
		const moved = pointerMoved;
		isPanning = false;
		pointerMoved = false;
		mapViewportEl?.releasePointerCapture(event.pointerId);

		if (moved || !anchor || !pointStore || !pointIndex) {
			updateHoveredFromPointer(event.clientX, event.clientY);
			return;
		}

		const worldPoint = screenToWorld(currentViewport(), anchor.x, anchor.y);
		if (!worldPoint) return;
		const hit = hitTestClusterSpatialIndex(
			pointStore,
			pointIndex,
			worldPoint.x,
			worldPoint.y,
			screenRadiusToWorld(currentViewport(), CLICK_THRESHOLD_PX)
		);
		if (hit) {
			focusPointIndex(hit.index);
		}
	}

	function handleMapPointerLeave() {
		if (!isPanning) {
			updateHoverState(null);
		}
	}

	function buildHoverCardState(): HoverCardState | null {
		if (hoveredPointIndex === null || !pointStore) return null;
		const worldX = pointWorldX(hoveredPointIndex);
		const worldY = pointWorldY(hoveredPointIndex);
		const screen = worldToScreen(currentViewport(), worldX, worldY);
		return {
			rootUri: pointRootUri(hoveredPointIndex),
			cluster: pointCluster(hoveredPointIndex),
			screenX: screen.x,
			screenY: screen.y
		};
	}

	function buildHoverCardPosition(): HoverCardPosition | null {
		const hover = hoverCardState;
		if (!hover || viewportWidth <= 0 || viewportHeight <= 0) return null;
		const cardWidth = 286;
		const cardHeight = 164;
		return {
			left: clamp(hover.screenX + 18, 12, Math.max(12, viewportWidth - cardWidth - 12)),
			top: clamp(hover.screenY - cardHeight - 18, 12, Math.max(12, viewportHeight - cardHeight - 12))
		};
	}

	const snapshot = $derived(
		overview
			? {
					meta: overview.meta,
					clusters: overview.clusters
				}
			: null
	);
	const activeClusterIds = $derived(
		(() => {
			const currentOverview = overview;
			if (!currentOverview) return [];
			return selectedClusterIds.filter((clusterId) =>
				currentOverview.clusters.some((item) => item.cluster === clusterId)
			);
		})()
	);
	const activeClusterLookup = $derived(new Set(activeClusterIds));
	const activeAuthorThreadCount = $derived(
		selectedAuthorDid ? (authorPointIndices.get(selectedAuthorDid)?.length ?? 0) : 0
	);
	const activeClusterThreadCount = $derived(
		(() => {
			const currentOverview = overview;
			if (!currentOverview) return 0;
			return activeClusterIds.reduce((total, clusterId) => {
				const cluster = currentOverview.clusters.find((item) => item.cluster === clusterId);
				return total + (cluster?.threadCount ?? 0);
			}, 0);
		})()
	);
	const activeClusterPeopleCount = $derived(
		(() => {
			const currentOverview = overview;
			if (!currentOverview) return 0;
			return activeClusterIds.reduce((total, clusterId) => {
				const cluster = currentOverview.clusters.find((item) => item.cluster === clusterId);
				return total + (cluster?.peopleCount ?? 0);
			}, 0);
		})()
	);
	const inspectedCluster = $derived(
		overview && inspectedClusterId !== null
			? overview.clusters.find((item) => item.cluster === inspectedClusterId) ?? null
			: null
	);
	const activeClusters = $derived(
		overview
			? overview.clusters.filter((item) => activeClusterLookup.has(item.cluster))
			: []
	);
	const selectedPointCluster = $derived(selectedPointRef?.cluster ?? null);
	const selectedPointClusterSummary = $derived(
		overview && selectedPointCluster !== null
			? overview.clusters.find((item) => item.cluster === selectedPointCluster) ?? null
			: null
	);
	const selectionAuthorDid = $derived(selectedPointRef?.did ?? selectedAuthorDid);
	const hoveredAuthorDid = $derived(hoveredPointIndex !== null ? pointDid(hoveredPointIndex) : null);
	const selectedThreadTitle = $derived(
		selectedThread?.title ?? (selectedRootUri ? 'Loading cached thread...' : 'Overview')
	);
	const selectedThreadPreview = $derived(selectedThread?.preview ?? '');
	const progressPhase = $derived(
		progress ? `Building ${loadingLabel} locally: ${progress.phase}` : `Checking saved ${loadingLabel}...`
	);
	const progressCurrent = $derived(progress ? progress.threadsProcessed : 0);
	const progressTotal = $derived(progress?.totalThreads ?? 0);
	const hoverCardState = $derived(buildHoverCardState());
	const hoverCardPosition = $derived(buildHoverCardPosition());
	const atlasLabels = $derived(
		((): AtlasRegionLabel[] => {
			const currentOverview = overview;
			if (!currentOverview || viewportWidth <= 0 || viewportHeight <= 0) return [];

			const rendered = buildRenderedClusterLabels(currentOverview.clusters, currentViewport(), {
				fitZoom,
				paddingPx: ATLAS_LABEL_PADDING_PX,
				yDirection: -1,
				baseVisibleCount: Math.min(currentOverview.clusters.length, 18),
				maxVisibleCount: currentOverview.clusters.length
			});

			return rendered
				.flatMap((label) => {
					const summary = currentOverview.clusters.find((item) => item.cluster === label.cluster);
					if (!summary) return [];

					const active = activeClusterLookup.has(summary.cluster);
					const inspected = inspectedClusterId === summary.cluster;
					const withinViewport =
						label.screenX >= -ATLAS_LABEL_PADDING_PX &&
						label.screenY >= -ATLAS_LABEL_PADDING_PX &&
						label.screenX <= viewportWidth + ATLAS_LABEL_PADDING_PX &&
						label.screenY <= viewportHeight + ATLAS_LABEL_PADDING_PX;

					if (!withinViewport || (!label.visible && !active && !inspected)) {
						return [];
					}

					return [
						{
							cluster: summary.cluster,
							summary,
							screenX: label.screenX,
							screenY: label.screenY,
							active,
							inspected,
							labelRank: label.labelRank
						}
					];
				})
				.sort((left, right) => {
					if (left.inspected !== right.inspected) {
						return Number(right.inspected) - Number(left.inspected);
					}
					if (left.active !== right.active) {
						return Number(right.active) - Number(left.active);
					}
					return left.labelRank - right.labelRank;
				});
		})()
	);

	$effect(() => {
		const did = selectionAuthorDid;
		if (!did) {
			selectionAuthorProfile = null;
			return;
		}
		const cached = authorProfileCache.get(did);
		if (cached) {
			selectionAuthorProfile = cached;
			return;
		}
		selectionAuthorProfile = null;
		const requestId = ++selectionAuthorRequestId;
		void resolveAuthorProfile(did).then((profile) => {
			if (destroyed || requestId !== selectionAuthorRequestId || selectionAuthorDid !== did) return;
			selectionAuthorProfile = profile;
		});
	});

	$effect(() => {
		if (activeClusters.length === 0) {
			showSelectedClassesCard = true;
		}
	});

	$effect(() => {
		if (inspectedClusterId === null) return;
		if (!activeClusterLookup.has(inspectedClusterId)) {
			inspectedClusterId = null;
		}
	});

	$effect(() => {
		const did = hoveredAuthorDid;
		if (!did) {
			hoverAuthorProfile = null;
			return;
		}
		const cached = authorProfileCache.get(did);
		if (cached) {
			hoverAuthorProfile = cached;
			return;
		}
		hoverAuthorProfile = null;
		const requestId = ++hoverAuthorRequestId;
		void resolveAuthorProfile(did).then((profile) => {
			if (destroyed || requestId !== hoverAuthorRequestId || hoveredAuthorDid !== did) return;
			hoverAuthorProfile = profile;
		});
	});

	$effect(() => {
		const viewportEl = mapViewportEl;
		if (!viewportEl) return;

		const refresh = () => updateViewportSize();
		refresh();

		const observer = new ResizeObserver(() => refresh());
		observer.observe(viewportEl);
		window.addEventListener('resize', refresh);

		return () => {
			observer.disconnect();
			window.removeEventListener('resize', refresh);
		};
	});

	$effect(() => {
		backgroundCanvasEl;
		overview;
		viewportWidth;
		viewportHeight;
		viewportDpr;
		zoom;
		panX;
		panY;
		activeClusterIds;
		syncCanvasSize(backgroundCanvasEl);
		scheduleBackgroundRender();
	});

		$effect(() => {
			pointCanvasEl;
			pointStore;
		viewportWidth;
		viewportHeight;
		viewportDpr;
			zoom;
			panX;
			panY;
			activeClusterIds;
			selectedAuthorDid;
			selectedPointRef;
			hoveredPointIndex;
			syncCanvasSize(pointCanvasEl);
		schedulePointRender();
	});

	$effect(() => {
		const points = pointStore;
		const currentOverview = overview;
		if (!points || !currentOverview || points.count === 0) return;
		const nextSignature = `${currentOverview.meta.generatedAt}:${points.count}`;
		if (fitSignature === nextSignature) return;
		fitSignature = nextSignature;
		hasManualCamera = false;
		fitCameraToPoints(points);
	});

	onMount(() => {
		try {
			const saved = localStorage.getItem('preferred-font');
			if (saved && saved in fontFamilies) {
				fontKey = saved;
			}
		} catch {}

		void load();
		return () => {
			destroyed = true;
			clearHoverTimer();
			if (authorSearchTimer) clearTimeout(authorSearchTimer);
			if (backgroundFrame) cancelAnimationFrame(backgroundFrame);
			if (pointFrame) cancelAnimationFrame(pointFrame);
		};
	});
</script>

<svelte:head>
	<title>{pageTitle}</title>
</svelte:head>

<main class:snapshot-ready={!!snapshot} style="font-family: {fontFamily}; --font-hand: {fontFamily};">
	{#if !snapshot}
		<header class="hero">
			<div class="hero-copy">
				<RouteNav current={currentRoute} />
				<h1>{pageTitle}</h1>
				<p class="subtitle">{pageSubtitle}</p>
			</div>
		</header>
	{/if}

	{#if error}
		<ErrorBanner message={error} />
	{/if}

	{#if loading && !snapshot}
		<LoadingSpinner progress={{ phase: progressPhase, current: progressCurrent, total: progressTotal }} />

		{#if progress}
			<section class="build-progress wobbly-border-light">
				<div>
					<strong>Build host:</strong> local offline builder
				</div>
				<div>
					<strong>Objects scanned:</strong> {progress.objectsProcessed}
				</div>
				<div>
					<strong>Threads extracted:</strong> {progress.threadsProcessed}
				</div>
				<div>
					<strong>Unique people discovered:</strong> {progress.uniquePeopleSoFar}
				</div>
				<div>
					<strong>Scan pages processed:</strong> {progress.pageIndex}
				</div>
				{#if progress.clusterCount}
					<div>
						<strong>Cluster count:</strong> {progress.clusterCount}
					</div>
				{/if}
			</section>
		{/if}
	{/if}

	{#if !loading && !snapshot && missing}
		<section class="status-card wobbly-border-light">
			<h2>{missingTitle}</h2>
			<p>{missingBody}</p>
			<code>{buildCommand}</code>
		</section>
	{/if}

	{#if !loading && !snapshot && failure}
		<section class="status-card wobbly-border-light">
			<h2>{failureTitle}</h2>
			<p>{failure.message}</p>
			<div class="status-meta">
				<span><strong>Phase:</strong> {failure.phase}</span>
				<span><strong>Updated:</strong> {formatDateTime(failure.updatedAt)}</span>
			</div>
			<code>{buildCommand}</code>
			{#if failure.details}
				<details>
					<summary>Details</summary>
					<pre>{failure.details}</pre>
				</details>
			{/if}
		</section>
	{/if}

	{#if snapshot}
		<section class="atlas-shell">
			<div class="map-card map-card-fullscreen wobbly-border">
				<div class="map-stage map-stage-fullscreen">
					<div class="atlas-header">
						{#if showAtlasInfoCard}
							<div class="atlas-header-card wobbly-border-light">
								<div class="panel-topline">
									<div class="route-nav-host">
										<RouteNav current={currentRoute} compact />
									</div>
									<button
										type="button"
										class="panel-close-btn"
										aria-label="Hide atlas info"
										onclick={() => (showAtlasInfoCard = false)}
									>
										&times;
									</button>
								</div>
								<h1>{pageTitle}</h1>
								<p class="subtitle">{pageSubtitle}</p>
								<div class="atlas-font-picker">
									<FontPicker value={fontKey} onchange={handleFontChange} />
								</div>
								<div class="atlas-stats">
									<div class="atlas-stat">
										<span>Threads</span>
										<strong>{snapshot.meta.totalThreads}</strong>
									</div>
									<div class="atlas-stat">
										<span>People</span>
										<strong>{snapshot.meta.totalPeople}</strong>
									</div>
									<div class="atlas-stat">
										<span>Clusters</span>
										<strong>{snapshot.meta.clusterCount}</strong>
									</div>
									<div class="atlas-stat">
										<span>Built</span>
										<strong>{formatDateTime(snapshot.meta.generatedAt)}</strong>
									</div>
								</div>
							</div>
						{:else}
							<button
								type="button"
								class="panel-reopen-btn wobbly-border-light"
								onclick={() => (showAtlasInfoCard = true)}
							>
								Info
							</button>
						{/if}
					</div>

					<div class="atlas-search-wrap">
						{#if !showAuthorSearchCard || !showClusterListCard || (activeClusters.length > 0 && !showSelectedClassesCard)}
							<div class="atlas-mini-stack">
								{#if !showAuthorSearchCard}
									<button
										type="button"
										class="panel-reopen-btn wobbly-border-light"
										onclick={() => (showAuthorSearchCard = true)}
									>
										Find
									</button>
								{/if}
								{#if !showClusterListCard}
									<button
										type="button"
										class="panel-reopen-btn wobbly-border-light"
										onclick={() => (showClusterListCard = true)}
									>
										Classes
									</button>
								{/if}
								{#if activeClusters.length > 0 && !showSelectedClassesCard}
									<button
										type="button"
										class="panel-reopen-btn wobbly-border-light"
										onclick={() => (showSelectedClassesCard = true)}
									>
										Selected
									</button>
								{/if}
							</div>
						{/if}

						{#if showAuthorSearchCard}
							<form class="author-search wobbly-border-light" onsubmit={submitAuthorSearch}>
								<div class="panel-topline">
									<strong class="panel-heading">Find author</strong>
									<button
										type="button"
										class="panel-close-btn"
										aria-label="Hide author search"
										onclick={() => {
											showAuthorSearchCard = false;
											clearAuthorSuggestions();
										}}
									>
										&times;
									</button>
								</div>
								<div class="author-search-row">
									<div class="author-search-input-wrap">
										<input
											type="text"
											bind:value={authorSearchInput}
											class="author-search-input"
											placeholder="Find a mapped author by handle..."
											autocomplete="off"
											role="combobox"
											aria-expanded={showAuthorSuggestions}
											aria-autocomplete="list"
											aria-controls="cluster-author-suggestions"
											aria-activedescendant={activeAuthorSuggestionIndex >= 0 ? `cluster-author-suggestion-${activeAuthorSuggestionIndex}` : undefined}
											oninput={handleAuthorSearchInput}
											onkeydown={handleAuthorSearchKeydown}
											onblur={handleAuthorSearchBlur}
											onfocus={handleAuthorSearchInput}
										/>
										{#if showAuthorSuggestions && authorSuggestions.length > 0}
											<ul
												class="author-suggestions wobbly-border-light"
												id="cluster-author-suggestions"
												role="listbox"
											>
												{#each authorSuggestions as suggestion, index}
													<li
														id={`cluster-author-suggestion-${index}`}
														class="author-suggestion"
														class:active={index === activeAuthorSuggestionIndex}
														role="option"
														aria-selected={index === activeAuthorSuggestionIndex}
														onmousedown={() => focusAuthorDid(suggestion.did, suggestion)}
														onmouseenter={() => (activeAuthorSuggestionIndex = index)}
													>
														<div class="author-suggestion-copy">
															<strong>{suggestion.displayName || `@${suggestion.handle}`}</strong>
															<span>@{suggestion.handle}</span>
														</div>
														<span class="author-suggestion-count">{suggestion.threadCount} threads</span>
													</li>
												{/each}
											</ul>
										{/if}
									</div>
									<button
										type="submit"
										class="author-search-btn"
										disabled={authorSearchLoading || !authorSearchInput.trim()}
									>
										{authorSearchLoading ? 'Finding...' : 'Find'}
									</button>
								</div>
							</form>
						{/if}
						{#if showAuthorSearchCard && authorSearchError}
							<p class="author-search-error atlas-search-error wobbly-border-light">
								{authorSearchError}
							</p>
						{/if}
						{#if showClusterListCard}
							<section class="cluster-list-panel wobbly-border-light" aria-label="Cluster classes">
								<div class="cluster-list-header">
									<div>
										<strong>Classes</strong>
										<span>{snapshot.meta.clusterCount} total</span>
									</div>
									<div class="cluster-list-actions">
										{#if activeClusterIds.length > 0}
											<button type="button" class="cluster-list-clear" onclick={clearClusterSelection}>
												Clear
											</button>
										{/if}
										<button
											type="button"
											class="panel-close-btn"
											aria-label="Hide classes panel"
											onclick={() => (showClusterListCard = false)}
										>
											&times;
										</button>
									</div>
								</div>
								<div class="cluster-list-scroll">
									{#each snapshot.clusters as cluster}
										<div
											class="cluster-list-item"
											class:active={activeClusterLookup.has(cluster.cluster)}
											style={`--cluster-color: ${clusterColor(cluster.cluster)}`}
										>
											<input
												type="checkbox"
												checked={activeClusterLookup.has(cluster.cluster)}
												aria-label={`Toggle ${cluster.label} highlight`}
												onclick={(event) => event.stopPropagation()}
												onchange={() => toggleClusterSelection(cluster.cluster)}
											/>
											<button
												type="button"
												class="cluster-list-open"
												onclick={() => openClusterInspector(cluster.cluster)}
											>
												<span class="cluster-list-dot"></span>
												<span class="cluster-list-copy">
													<strong>{cluster.label}</strong>
													<span>{cluster.threadCount} threads • {cluster.peopleCount} people</span>
												</span>
											</button>
										</div>
									{/each}
								</div>
							</section>
						{/if}
						{#if activeClusters.length > 0 && showSelectedClassesCard}
							<section class="selected-classes-panel wobbly-border-light" aria-label="Selected classes">
								<div class="cluster-list-header">
									<div>
										<strong>Selected classes</strong>
										<span>
											{activeClusters.length} selected • {activeClusterThreadCount} threads • {activeClusterPeopleCount} people
										</span>
									</div>
									<div class="cluster-list-actions">
										<button type="button" class="cluster-list-clear" onclick={clearClusterSelection}>
											Clear
										</button>
										<button
											type="button"
											class="panel-close-btn"
											aria-label="Hide selected classes"
											onclick={() => (showSelectedClassesCard = false)}
										>
											&times;
										</button>
									</div>
								</div>
								<p class="selected-classes-copy">
									Selected classes stay highlighted until you uncheck them or clear the selection.
								</p>
								<div class="cluster-token-list">
									{#each activeClusters as cluster}
										<button
											type="button"
											class="cluster-token"
											style={`--cluster-color: ${clusterColor(cluster.cluster)}`}
											onclick={() => openClusterInspector(cluster.cluster)}
										>
											<span class="cluster-token-dot"></span>
											<span>{cluster.label}</span>
										</button>
									{/each}
								</div>
							</section>
						{/if}
					</div>

					<div class="map-controls map-controls-left">
						<button type="button" class="map-control-btn" onclick={zoomIn} title="Zoom in">+</button>
						<button
							type="button"
							class="map-control-btn map-control-label"
							onclick={zoomReset}
							title="Fit atlas"
						>
							Reset
						</button>
						<button type="button" class="map-control-btn" onclick={zoomOut} title="Zoom out">
							&minus;
						</button>
					</div>

					<div
						class="map-viewport"
						class:panning={isPanning}
						bind:this={mapViewportEl}
						role="group"
						aria-label="Interactive cluster atlas viewport"
						onwheel={handleMapWheel}
						onpointerdown={handleMapPointerDown}
						onpointermove={handleMapPointerMove}
						onpointerup={handleMapPointerUp}
						onpointercancel={handleMapPointerUp}
						onpointerleave={handleMapPointerLeave}
					>
						<canvas bind:this={backgroundCanvasEl} class="map-layer map-layer-background" aria-hidden="true"></canvas>
						<canvas bind:this={pointCanvasEl} class="map-layer map-layer-points" aria-hidden="true"></canvas>

						<div class="map-layer map-layer-labels">
							{#each atlasLabels as atlasLabel (atlasLabel.cluster)}
								<button
									type="button"
									class="atlas-region-label"
									class:active={atlasLabel.active}
									class:inspected={atlasLabel.inspected}
									style={`left:${atlasLabel.screenX}px; top:${atlasLabel.screenY}px; --cluster-color:${clusterColor(atlasLabel.cluster)}`}
									title={`${atlasLabel.summary.threadCount} threads • ${atlasLabel.summary.peopleCount} people`}
									aria-label={`Open ${atlasLabel.summary.label} class inspector`}
									onclick={() => openClusterInspector(atlasLabel.cluster)}
								>
									{atlasLabel.summary.label}
								</button>
							{/each}
						</div>

						<div class="map-layer map-layer-overlays" aria-hidden="true">
							{#if hoverCardState && hoverCardPosition}
								<div
									class="hover-card wobbly-border-light"
									style={`left:${hoverCardPosition.left}px; top:${hoverCardPosition.top}px; --cluster-color:${clusterColor(hoverCardState.cluster)}`}
								>
									<div class="hover-card-meta">
										<span>
											{overview?.clusters.find((cluster) => cluster.cluster === hoverCardState.cluster)?.label ??
												`Cluster ${hoverCardState.cluster + 1}`}
										</span>
										{#if hoverPreviewThread}
											<span>{hoverPreviewThread.postCount} posts</span>
										{:else if hoverPreviewLoading}
											<span>Loading preview...</span>
										{:else}
											<span>Cached point</span>
										{/if}
									</div>
									<div class="hover-card-author">
										<strong>{authorDisplayName(hoverAuthorProfile, hoveredAuthorDid) || 'Unknown author'}</strong>
										<span>{authorHandleLabel(hoverAuthorProfile, hoveredAuthorDid) || 'Unresolved handle'}</span>
									</div>
									<h3>{hoverPreviewThread?.title ?? 'Loading cached thread preview...'}</h3>
									<p>
										{hoverPreviewThread?.preview ??
											'A compact inspector will open when you click this point.'}
									</p>
								</div>
							{/if}
						</div>

						{#if pointsLoading}
							<div class="map-overlay-note">Loading projected points...</div>
						{:else if pointsError}
							<div class="map-overlay-note map-overlay-error">{pointsError}</div>
						{/if}
					</div>

					{#if detailMode === 'thread' && selectedRootUri}
						<aside class="atlas-inspector atlas-inspector-right wobbly-border">
							<div class="inspector-topline">
								<div class="detail-meta">
									<span>
										{selectedPointClusterSummary?.label ??
											(selectedPointCluster !== null ? `Cluster ${selectedPointCluster + 1}` : 'Selected thread')}
									</span>
									<span>{authorHandleLabel(selectionAuthorProfile, selectionAuthorDid) || 'Unknown author'}</span>
									{#if selectedThread}
										<span>{selectedThread.postCount} posts</span>
										<span>Depth {selectedThread.depth}</span>
									{:else}
										<span>Loading cached summary</span>
									{/if}
								</div>
								<button type="button" class="inspector-close" onclick={clearThreadInspector}>Close</button>
							</div>

							<h2>{selectedThreadTitle}</h2>
							<p class="detail-author">
								{authorDisplayName(selectionAuthorProfile, selectionAuthorDid) || 'Unknown author'}
							</p>
							{#if selectedThreadPreview}
								<p class="detail-preview">{selectedThreadPreview}</p>
							{/if}

							<div class="detail-links">
								{#if selectionAuthorDid}
									<a
										href={buildBskyProfileUrl(selectionAuthorProfile?.handle || selectionAuthorDid)}
										target="_blank"
										rel="noreferrer"
									>
										Open author profile
									</a>
								{/if}
								<a href={buildBskyUrl(selectedRootUri)} target="_blank" rel="noreferrer">Open on Bluesky</a>
								<a href={buildThreadViewUrl(selectedRootUri)}>Open live thread view</a>
								<a href={buildChatUrl(selectedRootUri)}>Open live chat view</a>
							</div>

							{#if selectedThreadLoading}
								<p class="detail-note">Loading cached thread summary...</p>
							{:else if selectedThreadError}
								<p class="inspector-error">{selectedThreadError}</p>
							{/if}
						</aside>
					{:else if selectedAuthorDid}
						<aside class="atlas-inspector atlas-inspector-right wobbly-border">
							<div class="inspector-topline">
								<div class="detail-meta">
									<span>{authorHandleLabel(selectionAuthorProfile, selectedAuthorDid) || 'Unknown author'}</span>
									<span>{activeAuthorThreadCount} mapped threads</span>
								</div>
								<button type="button" class="inspector-close" onclick={resetInspector}>Close</button>
							</div>

							<h2>{authorDisplayName(selectionAuthorProfile, selectedAuthorDid) || 'Unknown author'}</h2>
							<p class="detail-preview">
								The camera is centered on this author&apos;s mapped threads. Click any highlighted point to
								open one cached self-reply thread.
							</p>

							<div class="detail-links">
								<a
									href={buildBskyProfileUrl(selectionAuthorProfile?.handle || selectedAuthorDid)}
									target="_blank"
									rel="noreferrer"
								>
									Open author profile
								</a>
							</div>
						</aside>
					{:else if inspectedCluster}
						<aside class="atlas-inspector atlas-inspector-left wobbly-border">
							<div class="inspector-topline">
								<div class="detail-meta">
									<span>{inspectedCluster.label}</span>
									<span>{inspectedCluster.threadCount} threads</span>
									<span>{inspectedCluster.peopleCount} people</span>
								</div>
								<button type="button" class="inspector-close" onclick={dismissClusterInspector}>
									Close
								</button>
							</div>

							<h2>{inspectedCluster.label}</h2>
							<p class="detail-preview">{inspectedCluster.summary}</p>
							{#if inspectedCluster.keywords.length > 0}
								<p class="detail-note">
									Keywords: {inspectedCluster.keywords.slice(0, 5).join(' • ')}
								</p>
							{/if}

							<div class="rep-grid rep-grid-compact">
								{#each inspectedCluster.representatives as rep}
									<button
										type="button"
										class="rep-card rep-card-compact wobbly-border-light"
										onclick={() => focusRepresentative(rep)}
									>
										<div class="rep-topline">
											<strong>{rep.title}</strong>
											<small>{rep.postCount} posts</small>
										</div>
										<p>{rep.preview}</p>
									</button>
								{/each}
							</div>
						</aside>
					{/if}
				</div>
			</div>
		</section>
	{/if}
</main>

<style>
	main {
		padding: 40px 28px 52px;
		max-width: 1480px;
		margin: 0 auto;
		display: flex;
		flex-direction: column;
		gap: 24px;
	}

	main.snapshot-ready {
		max-width: none;
		padding: 16px;
		gap: 16px;
		min-height: 100dvh;
	}

	.hero h1 {
		font-size: clamp(1.75rem, 4vw, 2.35rem);
		margin-bottom: 8px;
	}

	.subtitle {
		max-width: 760px;
		color: var(--muted);
	}

	.build-progress {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
		gap: 10px;
		padding: 16px 18px;
		background: var(--card-bg);
	}

	.status-card {
		background: var(--card-bg);
		padding: 18px 20px;
		display: flex;
		flex-direction: column;
		gap: 10px;
	}

	.status-card code {
		display: inline-flex;
		width: fit-content;
		padding: 8px 10px;
		background: rgba(61, 64, 91, 0.08);
		border-radius: 10px;
		font-size: 0.92rem;
	}

	.status-card details {
		margin-top: 4px;
	}

	.status-card pre {
		margin: 8px 0 0;
		padding: 12px;
		border-radius: 14px;
		background: rgba(61, 64, 91, 0.08);
		overflow-x: auto;
		white-space: pre-wrap;
		word-break: break-word;
	}

	.status-meta {
		display: flex;
		flex-wrap: wrap;
		gap: 12px;
		font-size: 0.92rem;
		color: var(--muted);
	}

	.map-card {
		background: var(--card-bg);
		padding: 0;
		overflow: hidden;
	}

	.map-card-fullscreen {
		position: relative;
		height: calc(100dvh - 32px);
		min-height: 640px;
	}

	.atlas-shell {
		min-height: 0;
	}

	.atlas-header,
		.atlas-search-wrap,
		.map-controls {
		position: absolute;
		z-index: 8;
	}

	.atlas-header {
		top: 18px;
		left: 18px;
		width: min(430px, calc(100% - 36px));
		pointer-events: none;
	}

	.atlas-header-card {
		pointer-events: auto;
		padding: 10px 12px;
		background: rgba(255, 252, 245, 0.92);
		backdrop-filter: blur(16px);
		box-shadow: 0 20px 48px rgba(26, 35, 44, 0.1);
	}

	.panel-topline {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 10px;
		margin-bottom: 6px;
	}

	.route-nav-host {
		flex: 1;
		min-width: 0;
	}

	.panel-heading {
		font-size: 0.82rem;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: var(--muted);
	}

	.panel-close-btn,
	.panel-reopen-btn {
		pointer-events: auto;
		border: 1px solid rgba(61, 64, 91, 0.12);
		background: #fffdf6;
		color: #24313d;
		box-shadow: 0 10px 24px rgba(26, 35, 44, 0.08);
	}

	.panel-close-btn {
		width: 28px;
		height: 28px;
		border-radius: 999px;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		font-size: 1rem;
		line-height: 1;
		flex-shrink: 0;
	}

	.panel-reopen-btn {
		padding: 8px 11px;
		border-radius: 999px;
		font-size: 0.78rem;
		font-weight: 700;
	}

	.atlas-header-card h1 {
		font-size: clamp(0.96rem, 1.55vw, 1.22rem);
		margin-bottom: 3px;
	}

	.atlas-stats {
		display: grid;
		grid-template-columns: repeat(4, minmax(0, 1fr));
		gap: 6px;
		margin-top: 8px;
	}

	.atlas-font-picker {
		margin-top: 10px;
		display: flex;
		justify-content: flex-end;
	}

	.atlas-stat {
		padding: 7px 8px;
		border-radius: 12px;
		background: rgba(255, 248, 235, 0.88);
		border: 1px solid rgba(61, 64, 91, 0.08);
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-width: 0;
	}

	.atlas-stat span {
		font-size: 0.58rem;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--muted);
	}

	.atlas-stat strong {
		font-size: 0.76rem;
		line-height: 1.3;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.atlas-search-wrap {
		top: 18px;
		right: 18px;
		width: min(380px, calc(100% - 36px));
		pointer-events: none;
		display: flex;
		flex-direction: column;
		gap: 6px;
		align-items: flex-end;
	}

	.atlas-mini-stack {
		display: flex;
		flex-wrap: wrap;
		justify-content: flex-end;
		gap: 6px;
		pointer-events: auto;
	}

	.author-search {
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding: 9px;
		background: rgba(255, 252, 245, 0.94);
		backdrop-filter: blur(14px);
		box-shadow: 0 18px 42px rgba(26, 35, 44, 0.1);
		pointer-events: auto;
	}

	.author-search-row {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		gap: 8px;
	}

	.author-search-input-wrap {
		position: relative;
		min-width: 0;
	}

	.author-search-input {
		width: 100%;
		padding: 10px 12px;
		background: #fffdf6;
		border: 1px solid rgba(61, 64, 91, 0.12);
		border-radius: 14px;
		color: #24313d;
		font-size: 0.9rem;
	}

	.author-search-input:focus {
		border-color: var(--accent);
		outline: none;
	}

	.author-search-btn {
		min-width: 74px;
		border-radius: 14px;
		border: 1px solid rgba(61, 64, 91, 0.12);
		padding: 0 14px;
		background: #fffdf6;
		font-size: 0.82rem;
		font-weight: 700;
		color: #24313d;
	}

	.author-search-btn:disabled {
		opacity: 0.6;
	}

	.author-search-error {
		font-size: 0.84rem;
		color: #8b3a2e;
	}

	.atlas-search-error {
		margin-top: 0;
		padding: 9px 11px;
		background: rgba(255, 248, 242, 0.96);
		pointer-events: auto;
	}

	.cluster-list-panel {
		padding: 9px;
		background: rgba(255, 252, 245, 0.94);
		backdrop-filter: blur(14px);
		box-shadow: 0 18px 42px rgba(26, 35, 44, 0.1);
		pointer-events: auto;
	}

	.selected-classes-panel {
		width: 100%;
		padding: 9px;
		background: rgba(255, 252, 245, 0.94);
		backdrop-filter: blur(14px);
		box-shadow: 0 18px 42px rgba(26, 35, 44, 0.1);
		pointer-events: auto;
	}

	.selected-classes-copy {
		font-size: 0.76rem;
		line-height: 1.42;
		color: var(--muted);
		margin-bottom: 8px;
	}

	.cluster-list-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		margin-bottom: 8px;
	}

	.cluster-list-header div {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	.cluster-list-header strong {
		font-size: 0.86rem;
	}

	.cluster-list-header span {
		font-size: 0.72rem;
		color: var(--muted);
		text-transform: uppercase;
		letter-spacing: 0.05em;
	}

	.cluster-list-actions {
		display: flex;
		align-items: center;
		gap: 6px;
	}

	.cluster-list-clear {
		padding: 5px 9px;
		border: 1px solid rgba(61, 64, 91, 0.12);
		border-radius: 12px;
		background: #fffdf6;
		font-size: 0.74rem;
		font-weight: 700;
		color: #24313d;
	}

	.cluster-list-scroll {
		display: flex;
		flex-direction: column;
		gap: 6px;
		max-height: min(38vh, 320px);
		overflow-y: auto;
		padding-right: 2px;
	}

	.cluster-list-item {
		display: grid;
		grid-template-columns: auto minmax(0, 1fr);
		align-items: center;
		gap: 10px;
		padding: 8px 9px;
		border-radius: 12px;
		background: rgba(255, 248, 235, 0.7);
		border: 1px solid rgba(61, 64, 91, 0.08);
		cursor: pointer;
		transition:
			background 120ms ease,
			border-color 120ms ease,
			transform 120ms ease;
	}

	.cluster-list-item:hover,
	.cluster-list-item:focus-within,
	.cluster-list-item.active {
		background: rgba(255, 248, 235, 0.96);
		border-color: color-mix(in srgb, var(--cluster-color) 48%, #c9baa2);
		transform: translateY(-1px);
	}

	.cluster-list-item input {
		margin: 0;
		accent-color: var(--cluster-color);
	}

	.cluster-list-dot {
		width: 10px;
		height: 10px;
		border-radius: 999px;
		background: var(--cluster-color);
		box-shadow: 0 0 0 3px color-mix(in srgb, var(--cluster-color) 18%, transparent);
	}

	.cluster-list-open {
		display: grid;
		grid-template-columns: auto minmax(0, 1fr);
		align-items: center;
		gap: 10px;
		padding: 0;
		border: none;
		background: none;
		color: inherit;
		font: inherit;
		text-align: left;
		min-width: 0;
		cursor: pointer;
	}

	.cluster-list-copy {
		display: flex;
		flex-direction: column;
		min-width: 0;
	}

	.cluster-list-copy strong,
	.cluster-list-copy span {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.cluster-list-copy strong {
		font-size: 0.82rem;
	}

	.cluster-list-copy span {
		font-size: 0.74rem;
		color: var(--muted);
	}

	.author-suggestions {
		position: absolute;
		top: calc(100% + 6px);
		left: 0;
		right: 0;
		z-index: 12;
		background: rgba(255, 252, 245, 0.98);
		list-style: none;
		padding: 6px 0;
		box-shadow: 0 16px 28px rgba(26, 35, 44, 0.08);
		max-height: 320px;
		overflow-y: auto;
	}

	.author-suggestion {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		padding: 9px 12px;
		cursor: pointer;
	}

	.author-suggestion:hover,
	.author-suggestion.active {
		background: rgba(69, 123, 157, 0.08);
	}

	.author-suggestion-copy {
		display: flex;
		flex-direction: column;
		min-width: 0;
	}

	.author-suggestion-copy strong,
	.author-suggestion-copy span {
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.author-suggestion-copy strong {
		font-size: 0.92rem;
	}

	.author-suggestion-copy span,
	.author-suggestion-count {
		font-size: 0.8rem;
		color: var(--muted);
	}

	.map-stage {
		position: relative;
		height: 100%;
		min-height: 0;
	}

	.map-stage-fullscreen {
		height: 100%;
	}

	.map-viewport {
		position: relative;
		overflow: hidden;
		border-radius: 28px;
		height: 100%;
		border: 1px solid rgba(61, 64, 91, 0.14);
		cursor: grab;
		touch-action: none;
		background: #f8f0de;
	}

	.map-viewport.panning {
		cursor: grabbing;
	}

	.map-layer {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		display: block;
	}

	.map-layer-background,
	.map-layer-points {
		pointer-events: none;
	}

	.map-layer-overlays {
		pointer-events: none;
	}

	.map-layer-labels {
		pointer-events: none;
		z-index: 3;
	}

	.atlas-region-label {
		position: absolute;
		transform: translate(-50%, -50%);
		pointer-events: auto;
		max-width: min(260px, calc(100% - 24px));
		padding: 0;
		border: none;
		background: none;
		color: var(--cluster-color);
		font: inherit;
		font-size: 0.88rem;
		font-weight: 900;
		letter-spacing: 0;
		line-height: 1.12;
		text-shadow:
			0 1px 0 rgba(255, 252, 245, 0.98),
			0 -1px 0 rgba(255, 252, 245, 0.98),
			1px 0 0 rgba(255, 252, 245, 0.98),
			-1px 0 0 rgba(255, 252, 245, 0.98),
			0 0 10px rgba(255, 252, 245, 0.78);
		cursor: pointer;
		transition:
			transform 120ms ease,
			opacity 120ms ease;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		opacity: 0.96;
	}

	.atlas-region-label:hover,
	.atlas-region-label:focus-visible {
		transform: translate(-50%, -50%) scale(1.03);
		opacity: 1;
		outline: none;
	}

	.atlas-region-label.active {
		opacity: 1;
	}

	.atlas-region-label.inspected {
		opacity: 1;
		text-decoration: underline;
		text-decoration-thickness: 2px;
		text-underline-offset: 0.16em;
	}

	.map-overlay-note {
		position: absolute;
		left: 50%;
		top: 50%;
		transform: translate(-50%, -50%);
		z-index: 4;
		padding: 10px 14px;
		border-radius: 999px;
		background: rgba(255, 253, 246, 0.94);
		border: 1px solid rgba(61, 64, 91, 0.14);
		color: #3d405b;
		font-size: 0.9rem;
		pointer-events: none;
		white-space: nowrap;
	}

	.map-overlay-error {
		color: #8b3a2e;
		border-color: rgba(139, 58, 46, 0.22);
	}

	.map-controls {
		pointer-events: none;
	}

	.map-controls-left {
		left: 18px;
		bottom: 92px;
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.map-control-btn {
		pointer-events: auto;
		width: 42px;
		min-height: 34px;
		background: rgba(255, 253, 246, 0.94);
		border: 1px solid #cdbfa7;
		border-radius: 14px;
		color: #3d405b;
		font-size: 1rem;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		cursor: pointer;
		box-shadow: 0 14px 30px rgba(26, 35, 44, 0.08);
	}

	.map-control-label {
		width: auto;
		padding: 0 10px;
		font-size: 0.8rem;
		font-weight: 700;
	}

	.map-control-btn:hover {
		background: #fff;
	}

	.hover-card {
		position: absolute;
		pointer-events: auto;
		z-index: 4;
	}

	.hover-card {
		width: min(286px, calc(100% - 24px));
		background: rgba(255, 252, 245, 0.96);
		border-color: color-mix(in srgb, var(--cluster-color) 28%, #d0c4af);
		padding: 12px 14px;
		display: flex;
		flex-direction: column;
		gap: 8px;
		box-shadow: 0 16px 36px rgba(26, 35, 44, 0.12);
	}

	.hover-card-meta {
		display: flex;
		justify-content: space-between;
		gap: 8px;
		flex-wrap: wrap;
		font-size: 0.76rem;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--muted);
	}

	.hover-card-author {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	.hover-card-author strong {
		font-size: 0.92rem;
	}

	.hover-card-author span {
		font-size: 0.8rem;
		color: var(--muted);
	}

	.hover-card h3 {
		font-size: 1.06rem;
		line-height: 1.28;
	}

	.hover-card p {
		font-size: 0.9rem;
		line-height: 1.5;
		color: #24313d;
	}

	.atlas-inspector {
		position: absolute;
		bottom: 84px;
		z-index: 9;
		width: min(324px, calc(100% - 36px));
		max-height: min(48vh, 392px);
		overflow: auto;
		padding: 13px 15px;
		background: rgba(255, 252, 245, 0.96);
		box-shadow: 0 24px 52px rgba(26, 35, 44, 0.14);
	}

	.atlas-inspector-right {
		right: 18px;
	}

	.atlas-inspector-left {
		left: 18px;
	}

	.inspector-topline {
		display: flex;
		justify-content: space-between;
		gap: 12px;
		align-items: flex-start;
		margin-bottom: 10px;
	}

	.inspector-close {
		background: #fffdf6;
		border: 1px solid rgba(61, 64, 91, 0.12);
		border-radius: 12px;
		padding: 6px 10px;
		font-size: 0.76rem;
		font-weight: 700;
		color: #24313d;
		flex-shrink: 0;
	}

	.detail-meta {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		font-size: 0.78rem;
		color: var(--muted);
		margin-bottom: 0;
	}

	.atlas-inspector h2 {
		font-size: 1.08rem;
		line-height: 1.25;
		margin-bottom: 4px;
	}

	.detail-author {
		font-size: 0.82rem;
		color: var(--muted);
		margin-bottom: 6px;
	}

	.detail-preview {
		font-size: 0.86rem;
		line-height: 1.46;
		margin-bottom: 8px;
	}

	.detail-links {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		font-size: 0.76rem;
		margin-bottom: 0;
	}

	.detail-links a {
		color: var(--accent);
	}

	.cluster-token-list {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		margin-top: 6px;
	}

	.cluster-token {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		padding: 6px 9px;
		border-radius: 999px;
		border: 1px solid rgba(61, 64, 91, 0.12);
		background: rgba(255, 248, 235, 0.72);
		font-size: 0.76rem;
		color: #24313d;
		transition:
			background 120ms ease,
			border-color 120ms ease,
			transform 120ms ease;
	}

	.cluster-token:hover {
		background: color-mix(in srgb, var(--cluster-color) 10%, #fff8ec);
		border-color: color-mix(in srgb, var(--cluster-color) 32%, #c9baa2);
		transform: translateY(-1px);
	}

	.cluster-token-dot {
		width: 8px;
		height: 8px;
		border-radius: 999px;
		background: var(--cluster-color);
	}

	.detail-note,
	.inspector-error {
		font-size: 0.82rem;
		color: var(--muted);
		margin-top: 8px;
	}

	.inspector-error {
		color: #8b3a2e;
	}

	.rep-grid {
		display: grid;
		grid-template-columns: 1fr;
		gap: 10px;
	}

	.rep-card {
		background: #fffdf6;
		padding: 10px 11px;
		display: flex;
		flex-direction: column;
		gap: 7px;
		text-align: left;
	}

	.rep-grid-compact {
		margin-top: 12px;
	}

	.rep-card-compact p {
		font-size: 0.8rem;
		line-height: 1.4;
		line-clamp: 2;
		display: -webkit-box;
		-webkit-line-clamp: 2;
		-webkit-box-orient: vertical;
		overflow: hidden;
	}

	.rep-topline {
		display: flex;
		justify-content: space-between;
		gap: 8px;
		flex-wrap: wrap;
	}

	.rep-topline strong {
		font-size: 0.88rem;
	}

	.rep-topline small {
		font-size: 0.72rem;
		color: var(--muted);
	}

	.rep-card p {
		font-size: 0.86rem;
		line-height: 1.45;
	}

	@media (max-width: 1100px) {
		.atlas-header {
			width: min(400px, calc(100% - 36px));
		}

		.atlas-search-wrap {
			top: 198px;
			left: 18px;
			right: auto;
		}

		.atlas-inspector {
			width: min(308px, calc(100% - 36px));
		}

		.map-controls-left {
			flex-direction: row;
			bottom: 84px;
		}
	}

	@media (max-width: 640px) {
		main {
			padding-inline: 16px;
		}

		main.snapshot-ready {
			padding: 10px;
		}

		.map-card-fullscreen {
			height: calc(100dvh - 20px);
			min-height: 560px;
		}

		.atlas-header,
		.atlas-search-wrap,
		.atlas-inspector,
		.map-controls-left {
			left: 10px;
			right: 10px;
		}

		.atlas-header {
			top: 10px;
			width: auto;
		}

		.atlas-header-card {
			padding: 10px 11px;
		}

		.atlas-stats {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}

		.atlas-search-wrap {
			top: 206px;
			width: auto;
		}

		.author-search-row {
			grid-template-columns: 1fr;
		}

		.author-search-btn {
			min-height: 38px;
		}

		.map-control-btn {
			width: 46px;
			min-height: 38px;
		}

		.map-control-label {
			padding-inline: 12px;
		}

		.map-controls-left {
			bottom: 82px;
		}

		.atlas-inspector {
			bottom: 70px;
			width: auto;
			max-height: min(42vh, 332px);
			padding: 12px;
		}

		.cluster-list-scroll {
			max-height: min(28vh, 220px);
		}
	}
</style>
