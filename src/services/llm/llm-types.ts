export interface OllamaOptions {
  temperature?: number;
  num_predict?: number;
  num_ctx?: number;
}

export interface LlmConfig {
  baseUrl: string;
  model: string;
  options?: OllamaOptions;
}

export const DEFAULT_LLM_CONFIG: LlmConfig = {
  baseUrl: 'http://localhost:11434',
  model: 'qwen3.5:4b',
  options: {
    temperature: 0.7,
    num_predict: 1600,
    num_ctx: 32768,
  },
};

export const NUM_PREDICT_MAP: Record<string, number> = {
  kurz: 512,
  mittel: 1600,
  'ausführlich': 3000,
};
