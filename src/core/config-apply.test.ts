import { describe, expect, it } from 'vitest';
import { SarahConfigSchema } from './config-schema.js';
import { getLlmRestartReasons } from './config-apply.js';

describe('getLlmRestartReasons', () => {
  it('returns no restart reason for an unchanged runtime config', () => {
    const llm = SarahConfigSchema.parse({}).llm;
    expect(getLlmRestartReasons(llm, structuredClone(llm))).toEqual([]);
  });

  it('names every runtime-sensitive model change', () => {
    const previous = SarahConfigSchema.parse({}).llm;
    const next = {
      ...previous,
      baseUrl: 'http://other:11434',
      routerModel: 'router:new',
      workerModel: 'worker:new',
      performanceProfile: 'sparsam' as const,
      workerOptions: { num_ctx: 8192 },
      options: { ...previous.options, temperature: 0.2 },
    };

    expect(getLlmRestartReasons(previous, next)).toEqual([
      'Ollama-Adresse',
      'Router-Modell',
      'Worker-Modell',
      'Leistungsprofil',
      'Kontextgröße',
      'Modelloptionen',
    ]);
  });
});
