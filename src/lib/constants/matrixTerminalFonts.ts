export type MatrixTerminalFontId = 'rain' | 'tech' | 'plex';

export type MatrixTerminalFontOption = {
	id: MatrixTerminalFontId;
	label: string;
	family: string;
	terminalSize: number;
	terminalLineHeight: number;
	terminalWeight: string;
	rainScale: number;
};

export const DEFAULT_MATRIX_TERMINAL_FONT_ID: MatrixTerminalFontId = 'rain';

export const MATRIX_TERMINAL_FONT_OPTIONS: MatrixTerminalFontOption[] = [
	{
		id: 'rain',
		label: 'Rain Glyph',
		family:
			'"VT323", "Share Tech Mono", "IBM Plex Mono", "JetBrains Mono", "Fira Code", Menlo, Monaco, Consolas, monospace',
		terminalSize: 20,
		terminalLineHeight: 1.02,
		terminalWeight: '400',
		rainScale: 1.06
	},
	{
		id: 'tech',
		label: 'Tech Mono',
		family:
			'"Share Tech Mono", "IBM Plex Mono", "JetBrains Mono", "Fira Code", Menlo, Monaco, Consolas, monospace',
		terminalSize: 16,
		terminalLineHeight: 1.08,
		terminalWeight: '500',
		rainScale: 0.92
	},
	{
		id: 'plex',
		label: 'Plex Mono',
		family:
			'"IBM Plex Mono", "JetBrains Mono", "Fira Code", Menlo, Monaco, Consolas, monospace',
		terminalSize: 15,
		terminalLineHeight: 1.12,
		terminalWeight: '500',
		rainScale: 0.88
	}
];

export function getMatrixTerminalFontOption(
	id: MatrixTerminalFontId | string | null | undefined
): MatrixTerminalFontOption {
	return (
		MATRIX_TERMINAL_FONT_OPTIONS.find((option) => option.id === id) ??
		MATRIX_TERMINAL_FONT_OPTIONS[0]
	);
}
