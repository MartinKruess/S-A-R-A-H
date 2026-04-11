// src/services/llm/llm-service.ts
import type { SarahService } from '../../core/service.interface.js';
import type { TypedBusMessage, ServiceStatus } from '../../core/types.js';
import type { AppContext } from '../../core/bootstrap.js';
import type { LlmProvider, ChatMessage } from './llm-provider.interface.js';
import { buildSystemPrompt } from './prompt-builder.js';
import { NUM_PREDICT_MAP } from './llm-types.js';

const MAX_CONTEXT_TOKENS = 120_000;
const CHARS_PER_TOKEN = 4;
const STREAM_TIMEOUT_MS = 120_000;

const ERROR_MESSAGES: Record<string, string> = {
  unavailable: 'Sarah träumt noch... Einen Moment.',
  timeout: 'Sarah hat den Faden verloren... Versuch es nochmal.',
  connection: 'Sarah ist kurz weggedriftet. Einen Moment...',
};

export class LlmService implements SarahService {
  readonly id = 'llm';
  readonly subscriptions = ['chat:message'] as const;
  status: ServiceStatus = 'pending';

  private history: ChatMessage[] = [];

  constructor(
    private context: AppContext,
    private provider: LlmProvider,
  ) {}

  async init(): Promise<void> {
    const available = await this.provider.isAvailable();
    if (!available) {
      this.status = 'error';
      return;
    }
    this.status = 'running';
  }

  async destroy(): Promise<void> {
    this.history = [];
    this.status = 'stopped';
  }

  onMessage(msg: TypedBusMessage): void {
    if (msg.topic === 'chat:message') {
      const { text } = msg.data;
      this.handleChatMessage(text).catch(() => {
        this.context.bus.emit(this.id, 'llm:error', {
          message: ERROR_MESSAGES.connection,
        });
      });
    }
  }

  async handleChatMessage(text: string, mode: 'chat' | 'voice' = 'chat'): Promise<void> {
    if (this.status !== 'running') {
      this.context.bus.emit(this.id, 'llm:error', {
        message: ERROR_MESSAGES.unavailable,
      });
      return;
    }

    const userMsg: ChatMessage = { role: 'user', content: text };
    this.history.push(userMsg);

    await this.context.db.insert('messages', {
      conversation_id: 1,
      role: 'user',
      content: text,
    });

    // Build prompt fresh each call (picks up settings changes)
    const systemPrompt = buildSystemPrompt(this.context.parsedConfig, mode);
    console.log('[LLM] System prompt:\n', systemPrompt);

    const messages = this.buildMessages(systemPrompt);

    // Resolve num_predict from responseStyle
    const responseStyle = this.context.parsedConfig.personalization.responseStyle;
    const numPredict = NUM_PREDICT_MAP[responseStyle] ?? NUM_PREDICT_MAP.mittel;

    try {
      let fullText = '';
      let timeoutId: ReturnType<typeof setTimeout>;
      let rejectTimeout: (err: Error) => void;

      const timeoutPromise = new Promise<never>((_, reject) => {
        rejectTimeout = reject;
        timeoutId = setTimeout(
          () => reject(new Error('timeout')),
          STREAM_TIMEOUT_MS,
        );
      });

      const chatPromise = this.provider.chat(messages, (chunk) => {
        clearTimeout(timeoutId);
        timeoutId = setTimeout(
          () => rejectTimeout(new Error('timeout')),
          STREAM_TIMEOUT_MS,
        );
        this.context.bus.emit(this.id, 'llm:chunk', { text: chunk });
      }, { num_predict: numPredict });

      fullText = await Promise.race([chatPromise, timeoutPromise]);
      clearTimeout(timeoutId!);

      this.history.push({ role: 'assistant', content: fullText });

      await this.context.db.insert('messages', {
        conversation_id: 1,
        role: 'assistant',
        content: fullText,
      });

      this.context.bus.emit(this.id, 'llm:done', { fullText });
    } catch (err) {
      const errorKey =
        err instanceof Error && err.message === 'timeout'
          ? 'timeout'
          : 'connection';
      this.context.bus.emit(this.id, 'llm:error', {
        message: ERROR_MESSAGES[errorKey],
      });
    }
  }

  private buildMessages(systemPrompt: string): ChatMessage[] {
    const system: ChatMessage = { role: 'system', content: systemPrompt };
    const systemTokens = this.estimateTokens(systemPrompt);
    const budget = MAX_CONTEXT_TOKENS - systemTokens;

    const trimmed: ChatMessage[] = [];
    let usedTokens = 0;

    for (let i = this.history.length - 1; i >= 0; i--) {
      const msg = this.history[i];
      const tokens = this.estimateTokens(msg.content);
      if (usedTokens + tokens > budget) break;
      usedTokens += tokens;
      trimmed.unshift(msg);
    }

    return [system, ...trimmed];
  }

  private estimateTokens(text: string): number {
    return Math.ceil(text.length / CHARS_PER_TOKEN);
  }
}
