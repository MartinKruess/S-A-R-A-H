/** Productive local-model defaults shared by validation and runtime code. */
export const DEFAULT_LLM_CONFIG = {
  baseUrl: 'http://localhost:11434',
  routerModel: 'phi4-mini:3.8b',
  workerModel: 'qwen3:8b',
  performanceProfile: 'normal',
  workerOptions: {
    num_ctx: 4096,
  },
  options: {},
} as const;
