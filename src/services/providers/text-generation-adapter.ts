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
  readonly status: 'completed' | 'incomplete' | 'refused';
  readonly usage?: SpecialistTaskUsage;
}
export interface TextGenerationAdapter {
  generate(request: TextGenerationRequest, context: TextGenerationContext): Promise<TextGenerationResult>;
}

/**
 * @param iterator - Provider stream awaiting its next event.
 * @param signal - Caller cancellation combined with the whole-request deadline.
 * - Bounds body reads even when a transport does not settle after cancellation.
 * @returns Next event while the generation remains active.
 * @category External Integration
 */
export async function nextTextGenerationEvent<T>(iterator: AsyncIterator<T>, signal: AbortSignal): Promise<IteratorResult<T>> {
  signal.throwIfAborted();
  let rejectAbort: (() => void) | undefined;
  const abort = new Promise<IteratorResult<T>>((_, reject) => {
    rejectAbort = () => reject(new Error('provider_stream_aborted'));
    signal.addEventListener('abort', rejectAbort, { once: true });
  });
  try { return await Promise.race([iterator.next(), abort]); }
  finally { if (rejectAbort) signal.removeEventListener('abort', rejectAbort); }
}

/** Safe failure retaining partial output without permitting an automatic paid retry. */
export class TextGenerationError extends Error {
  constructor(readonly partial: TextGenerationResult) { super('provider_generation_failed'); }
}
