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
  model: 'qwen3.5:latest',
  options: {
    temperature: 0.7,
    num_predict: 2048,
    num_ctx: 32768,
  },
};
