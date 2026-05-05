import { browser } from '$app/environment';
import {
	DEFAULT_MATRIX_TERMINAL_FONT_ID,
	getMatrixTerminalFontOption,
	MATRIX_TERMINAL_FONT_OPTIONS,
	type MatrixTerminalFontId
} from '$lib/constants/matrixTerminalFonts';

export const MATRIX_SPEED_MIN = 10;
export const MATRIX_SPEED_MAX = 140;
export const LIVE_REFRESH_MS = 12000;

export type LayoutMode = 'grid' | 'btree';
export type RenderStyle = 'terminal' | 'rain' | 'rain-horizontal';

export function createMatrixSettings(keyPrefix: string) {
	const keys = {
		speed: `${keyPrefix}-speed`,
		panels: `${keyPrefix}-panel-count`,
		layout: `${keyPrefix}-layout-mode`,
		render: `${keyPrefix}-render-style`,
		font: `${keyPrefix}-terminal-font`,
		live: `${keyPrefix}-live-refresh`,
		collapsed: `${keyPrefix}-controls-collapsed`
	};

	let speed = $state(92);
	let panelCount = $state(4);
	let layoutMode = $state<LayoutMode>('grid');
	let renderStyle = $state<RenderStyle>('terminal');
	let terminalFontId = $state<MatrixTerminalFontId>(DEFAULT_MATRIX_TERMINAL_FONT_ID);
	let liveRefreshEnabled = $state(true);
	let controlsCollapsed = $state(true);

	const frameDelayMs = $derived(Math.max(4, Math.round(104 - speed * 0.95)));
	const speedLabel = $derived(
		speed >= 124
			? 'overclock'
			: speed >= 100
				? 'warp'
				: speed >= 74
					? 'fast'
					: speed >= 46
						? 'balanced'
						: 'readable'
	);
	const terminalFontLabel = $derived(getMatrixTerminalFontOption(terminalFontId).label);
	const renderStyleLabel = $derived(
		renderStyle === 'rain'
			? 'Vertical rain'
			: renderStyle === 'rain-horizontal'
				? 'Horizontal rain'
				: 'Terminal stream'
	);

	function restore() {
		if (!browser) return;

		const storedSpeed = Number(localStorage.getItem(keys.speed));
		if (Number.isFinite(storedSpeed) && storedSpeed >= MATRIX_SPEED_MIN && storedSpeed <= MATRIX_SPEED_MAX) {
			speed = storedSpeed;
		}

		const storedPanels = Number(localStorage.getItem(keys.panels));
		if (Number.isFinite(storedPanels) && storedPanels >= 1 && storedPanels <= 100) {
			panelCount = storedPanels;
		}

		const storedLayout = localStorage.getItem(keys.layout);
		if (storedLayout === 'grid' || storedLayout === 'btree') {
			layoutMode = storedLayout;
		}

		const storedRender = localStorage.getItem(keys.render);
		if (storedRender === 'terminal' || storedRender === 'rain' || storedRender === 'rain-horizontal') {
			renderStyle = storedRender;
		}

		const storedFont = localStorage.getItem(keys.font);
		if (storedFont && MATRIX_TERMINAL_FONT_OPTIONS.some((o) => o.id === storedFont)) {
			terminalFontId = storedFont as MatrixTerminalFontId;
		}

		const storedLive = localStorage.getItem(keys.live);
		if (storedLive === '0') {
			liveRefreshEnabled = false;
		}

		const storedCollapse = localStorage.getItem(keys.collapsed);
		if (storedCollapse === '0') {
			controlsCollapsed = false;
		}
	}

	function persistSpeed() {
		if (browser) localStorage.setItem(keys.speed, String(speed));
	}

	function persistPanels() {
		if (browser) localStorage.setItem(keys.panels, String(panelCount));
	}

	function persistLayout() {
		if (browser) localStorage.setItem(keys.layout, layoutMode);
	}

	function persistRender() {
		if (browser) localStorage.setItem(keys.render, renderStyle);
	}

	function persistFont() {
		if (browser) localStorage.setItem(keys.font, terminalFontId);
	}

	function persistLive() {
		if (browser) localStorage.setItem(keys.live, liveRefreshEnabled ? '1' : '0');
	}

	function persistCollapsed() {
		if (browser) localStorage.setItem(keys.collapsed, controlsCollapsed ? '1' : '0');
	}

	return {
		get speed() { return speed; },
		set speed(v: number) { speed = v; },

		get panelCount() { return panelCount; },
		set panelCount(v: number) { panelCount = Math.max(1, Math.min(100, Math.round(v))); },

		get layoutMode() { return layoutMode; },
		set layoutMode(v: LayoutMode) { layoutMode = v; },

		get renderStyle() { return renderStyle; },
		set renderStyle(v: RenderStyle) { renderStyle = v; },

		get terminalFontId() { return terminalFontId; },
		set terminalFontId(v: MatrixTerminalFontId) { terminalFontId = v; },

		get liveRefreshEnabled() { return liveRefreshEnabled; },
		set liveRefreshEnabled(v: boolean) { liveRefreshEnabled = v; },

		get controlsCollapsed() { return controlsCollapsed; },
		set controlsCollapsed(v: boolean) { controlsCollapsed = v; },

		get frameDelayMs() { return frameDelayMs; },
		get speedLabel() { return speedLabel; },
		get terminalFontLabel() { return terminalFontLabel; },
		get renderStyleLabel() { return renderStyleLabel; },

		restore,
		persistSpeed,
		persistPanels,
		persistLayout,
		persistRender,
		persistFont,
		persistLive,
		persistCollapsed
	};
}

export type MatrixSettings = ReturnType<typeof createMatrixSettings>;
