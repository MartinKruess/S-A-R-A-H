export interface OllamaOptions {
  temperature?: number;
  num_predict?: number;
  num_ctx?: number;
  num_gpu?: number;
}

export interface WorkerOptions {
  num_ctx: number;
  num_gpu: number;
}

export interface LlmConfig {
  baseUrl: string;
  routerModel: string;
  workerModel: string;
  workerOptions: WorkerOptions;
  options?: OllamaOptions;
}

export const DEFAULT_LLM_CONFIG: LlmConfig = {
  baseUrl: 'http://localhost:11434',
  routerModel: 'qwen3.5:2b',
  workerModel: 'qwen3.5:9b',
  workerOptions: {
    num_ctx: 8192,
    num_gpu: 24,
  },
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
