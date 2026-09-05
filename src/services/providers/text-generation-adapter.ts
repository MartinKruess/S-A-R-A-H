import type { SpecialistTaskUsage } from '../../core/specialist-task.js';

export interface TextGenerationRequest {
  readonly text: string;
  readonly model: string;
  readonly maxOutputTokens: number;
  readonly signal?: AbortSignal;
}
export interface TextGenerationContext {
  readonly resolveCredential: () => string | null;
  readonly onDelta: (text: string) => void;
}
export interface TextGenerationResult {
  readonly fullText: string;
  readonly status: 'completed' | 'incomplete';
  readonly usage?: SpecialistTaskUsage;
}
export interface TextGenerationAdapter {
  generate(request: TextGenerationRequest, context: TextGenerationContext): Promise<TextGenerationResult>;
}

/** Safe failure retaining partial output without permitting an automatic paid retry. */
export class TextGenerationError extends Error {
  constructor(readonly partial: TextGenerationResult) { super('provider_generation_failed'); }
}
