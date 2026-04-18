import type { LlmProvider, ChatMessage } from './llm-provider.interface.js';
import { NUM_PREDICT_MAP } from './llm-types.js';
import { chatWithTimeout } from './chat-with-timeout.js';

export interface WorkerResult {
  fullText: string;
  tookMs: number;
}

export class WorkerService {
  constructor(private provider: LlmProvider) {}

  async stream(
    messages: ChatMessage[],
    responseStyle: string,
    onChunk: (text: string) => void,
  ): Promise<WorkerResult> {
    const numPredict = NUM_PREDICT_MAP[responseStyle] ?? NUM_PREDICT_MAP.mittel;
    const start = performance.now();
    const fullText = await chatWithTimeout(this.provider, messages, onChunk, { num_predict: numPredict });
    const tookMs = Math.round(performance.now() - start);
    return { fullText, tookMs };
  }
}
