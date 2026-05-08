import type { AppConfig } from '@mlc-ai/web-llm';

export const GEMMA_WEBLLM_REPO = 'https://huggingface.co/welcoma/gemma-4-E2B-it-q4f16_1-MLC';
export const GEMMA_WEBLLM_MODEL_ID = 'gemma-4-E2B-it-q4f16_1-MLC';
export const GEMMA_WEBLLM_MODEL_LIB = `${GEMMA_WEBLLM_REPO}/resolve/main/libs/gemma-4-E2B-it-q4f16_1-MLC-webgpu.wasm`;
export const GEMMA_CONTEXT_WINDOWS = [4096, 8192, 16384, 32768] as const;
export const GEMMA_DEFAULT_CONTEXT_WINDOW = GEMMA_CONTEXT_WINDOWS[0];

export function createGemmaWebllmAppConfig(
	contextWindowSize: number = GEMMA_DEFAULT_CONTEXT_WINDOW
): AppConfig {
	return {
		model_list: [
			{
				model: GEMMA_WEBLLM_REPO,
				model_id: GEMMA_WEBLLM_MODEL_ID,
				model_lib: GEMMA_WEBLLM_MODEL_LIB,
				required_features: ['shader-f16'],
				vram_required_MB: 3200,
				low_resource_required: false,
				overrides: {
					context_window_size: contextWindowSize,
					sliding_window_size: -1
				}
			}
		]
	};
}

export const GEMMA_WEBLLM_APP_CONFIG: AppConfig = createGemmaWebllmAppConfig();
