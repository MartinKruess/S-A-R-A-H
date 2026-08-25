import type { LlmConfig, SarahConfig } from './config-schema.js';

export interface SaveConfigResult {
  config: SarahConfig;
  restartRequired: boolean;
  restartReasons: string[];
}

function stableOptions(options: LlmConfig['options']): string {
  return JSON.stringify(Object.entries(options ?? {}).sort(([a], [b]) => a.localeCompare(b)));
}

/**
 * Determine whether a saved LLM change can apply to the current ModelRuntime.
 * Prompt/personality fields live outside this object and remain live per turn.
 *
 * @category Validation
 */
export function getLlmRestartReasons(previous: LlmConfig, next: LlmConfig): string[] {
  const reasons: string[] = [];
  if (previous.baseUrl !== next.baseUrl) reasons.push('Ollama-Adresse');
  if (previous.routerModel !== next.routerModel) reasons.push('Router-Modell');
  if (previous.workerModel !== next.workerModel) reasons.push('Worker-Modell');
  if (previous.performanceProfile !== next.performanceProfile) reasons.push('Leistungsprofil');
  if (previous.workerOptions.num_ctx !== next.workerOptions.num_ctx) reasons.push('Kontextgröße');
  if (stableOptions(previous.options) !== stableOptions(next.options)) reasons.push('Modelloptionen');
  return reasons;
}
