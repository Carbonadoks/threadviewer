export const THREAD_JUDGE_MODEL_OPTIONS = [
	{
		id: 'gemini-3.1-flash-lite-preview',
		label: 'Gemini 3.1 Flash Lite Preview'
	},
	{
		id: 'gemini-2.5-flash-lite',
		label: 'Gemini 2.5 Flash Lite'
	}
] as const;

export type ThreadJudgeModelId = (typeof THREAD_JUDGE_MODEL_OPTIONS)[number]['id'];

export const DEFAULT_THREAD_JUDGE_MODEL: ThreadJudgeModelId = 'gemini-3.1-flash-lite-preview';

const SUPPORTED_THREAD_JUDGE_MODELS = new Set<string>(
	THREAD_JUDGE_MODEL_OPTIONS.map((model) => model.id)
);

export function normalizeThreadJudgeModel(value: unknown): ThreadJudgeModelId | null {
	const normalized = String(value ?? '')
		.trim()
		.replace(/\s+\([^)]*\)\s*$/, '');

	if (SUPPORTED_THREAD_JUDGE_MODELS.has(normalized)) {
		return normalized as ThreadJudgeModelId;
	}

	return null;
}

export function threadJudgeModelLabel(value: unknown): string {
	const normalized = normalizeThreadJudgeModel(value);
	if (!normalized) return String(value ?? '').trim() || 'Unknown model';
	return (
		THREAD_JUDGE_MODEL_OPTIONS.find((option) => option.id === normalized)?.label ?? normalized
	);
}
