export interface OllamaOptions {
  temperature?: number;
  num_predict?: number;
  num_ctx?: number;
  num_gpu?: number;
}

export type PerformanceProfile = 'leistung' | 'schnell' | 'normal' | 'sparsam';

export const PERFORMANCE_PROFILE_MAP: Record<PerformanceProfile, number> = {
  leistung: 30,
  schnell: 26,
  normal: 21,
  sparsam: 16,
};

export interface WorkerOptions {
  num_ctx: number;
}

export interface LlmConfig {
  baseUrl: string;
  routerModel: string;
  workerModel: string;
  performanceProfile: PerformanceProfile;
  workerOptions: WorkerOptions;
  options?: OllamaOptions;
}

export const NUM_PREDICT_MAP: Record<string, number> = {
  kurz: 512,
  mittel: 1600,
  ausführlich: 3000,
};
export { DEFAULT_LLM_CONFIG } from '../../core/llm-defaults.js';
