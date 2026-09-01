import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { RouterService, type RouterServiceOptions } from '../../../src/services/llm/router-service.js';
import { bootstrap } from '../../../src/core/bootstrap.js';
import type { AppContext } from '../../../src/core/bootstrap.js';
import type { LlmProvider, ChatMessage } from '../../../src/services/llm/llm-provider.interface.js';
import type { ApplyMemoryAuthorDeltaInput, ApplyMemoryAuthorDeltaResult, CompleteMemoryStagingInput, StorageProvider, Filter, MessageRow, MessagesPageQuery, TurnMessageWrite, Layer2MemoryPurgeResult } from '../../../src/core/storage/storage.interface.js';
import type { BusEvents } from '../../../src/core/bus-events.js';
import { START_CONTEXT_HEADER } from '../../../src/services/llm/context-window.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { MessageBus } from '../../../src/core/message-bus.js';
import { MediaContext } from '../../../src/services/llm/media-context.js';
import type { TurnRequest } from '../../../src/core/turn-contract.js';
import {
  ActionConfirmationGate,
} from '../../../src/core/action-confirmation.js';
import { WORKER_UNAVAILABLE_MESSAGE } from '../../../src/core/chat-availability.js';
import { ModelRuntime } from '../../../src/services/llm/model-runtime.js';
import type { SarahService } from '../../../src/core/service.interface.js';
import type { ServiceStatus } from '../../../src/core/types.js';

export class StubActionService implements SarahService {
  readonly id = 'actions';
  readonly subscriptions = [] as const;
  status: ServiceStatus = 'running';
  async init(): Promise<void> { this.status = 'running'; }
  async destroy(): Promise<void> { this.status = 'stopped'; }
  onMessage(): void {}
}

export class StubVoiceService implements SarahService {
  readonly id = 'voice';
  readonly subscriptions = [] as const;
  status: ServiceStatus = 'running';

  constructor(public isSpeechPaused: boolean) {}

  async init(): Promise<void> { this.status = 'running'; }
  async destroy(): Promise<void> { this.status = 'stopped'; }
  onMessage(): void {}
}

export async function startAction(
  context: AppContext,
  service: RouterService,
  text: string,
  source: TurnRequest['source'] = 'chat',
): Promise<{
  request: BusEvents['action:request'];
  actionTurn: Promise<void>;
}> {
  let unsubscribeRequest = (): void => {};
  const requestSeen = new Promise<BusEvents['action:request']>((resolve) => {
    unsubscribeRequest = context.bus.on('action:request', (message) => resolve(message.data));
  });
  const actionTurn = service.handleChatMessage(text, source);
  const request = await requestSeen;
  unsubscribeRequest();
  return { request, actionTurn };
}

export async function completeActionTurn(
  context: AppContext,
  service: RouterService,
  text: string,
  result: { ok?: boolean; speak?: string } = {},
): Promise<BusEvents['action:request']> {
  const { request, actionTurn } = await startAction(context, service, text);
  context.bus.emit('test', 'action:result', {
    turnId: request.turnId,
    requestId: request.requestId,
    action: request.action,
    ok: result.ok ?? true,
    ...(result.speak ? { speak: result.speak } : {}),
  });
  await actionTurn;
  return request;
}

export class FakeProvider implements LlmProvider {
  readonly id = 'fake';
  lastMessages: ChatMessage[] | null = null;
  private memoryAuthorReplies: string[] = [];
  constructor(
    private reply = 'Antwort von Sarah',
    private readonly beforeReply?: () => Promise<void>,
  ) {}
  async isAvailable(): Promise<boolean> {
    return true;
  }
  queueMemoryAuthorReplies(...replies: string[]): void {
    this.memoryAuthorReplies.push(...replies);
  }
  async chat(messages: ChatMessage[], onChunk: (text: string) => void): Promise<string> {
    this.lastMessages = messages;
    await this.beforeReply?.();
    const system = messages[0]?.content ?? '';
    let response = this.reply;
    if (system.includes('Du extrahierst genau null oder eine langfristig nützliche Nutzeraussage.')) {
      const scripted = this.memoryAuthorReplies.shift();
      const source = messages.find(({ role }) => role === 'user')?.content ?? '';
      const explicit = source.match(/USER:\s*([\s\S]*?)\n\[\/GESPRÄCHSDATEN\]/u)?.[1]?.trim()
        ?? 'Explizite Testaussage';
      response = scripted ?? JSON.stringify({
        decision: 'candidate',
        kind: 'fact',
        topic: 'Allgemein',
        content: explicit.slice(0, 320),
        evidence: explicit.slice(0, 240),
        searchTerms: ['allgemein'],
        durability: 'stable',
        confidence: 1,
      });
    } else if (system.includes('Du wählst nur ein Memory-Delta für den angebotenen Kandidaten.')) {
      response = this.memoryAuthorReplies.shift() ?? JSON.stringify({
        action: 'add',
        topic: null,
        targets: [],
      });
    }
    onChunk(response);
    return response;
  }
}

/** Delegating storage that fails selected operations — simulates a broken DB. */
export class FailingStorage implements StorageProvider {
  constructor(
    private inner: StorageProvider,
    private opts: {
      failInsertTables?: string[];
      failReads?: boolean;
      beforeQuery?: (table: string) => Promise<void>;
      beforeInsert?: (table: string) => Promise<void>;
    } = {},
  ) {}

  async get<T = unknown>(key: string): Promise<T | undefined> {
    return this.inner.get<T>(key);
  }
  async set(key: string, value: unknown): Promise<void> {
    return this.inner.set(key, value);
  }
  async query<T = Record<string, unknown>>(table: string, filter?: Filter): Promise<T[]> {
    if (this.opts.failReads) throw new Error('disk I/O error');
    await this.opts.beforeQuery?.(table);
    return this.inner.query<T>(table, filter);
  }
  async queryMessagesPage(query: MessagesPageQuery): Promise<MessageRow[]> {
    if (this.opts.failReads) throw new Error('disk I/O error');
    return this.inner.queryMessagesPage(query);
  }
  async insert(table: string, data: Record<string, unknown>): Promise<number> {
    await this.opts.beforeInsert?.(table);
    if (this.opts.failInsertTables?.includes(table)) throw new Error('disk I/O error');
    return this.inner.insert(table, data);
  }
  async reserveRowIds(table: string, count: number): Promise<number[]> {
    return this.inner.reserveRowIds(table, count);
  }
  async insertTurnMessages(
    conversationId: number,
    turnId: string,
    messages: readonly TurnMessageWrite[],
  ): Promise<void> {
    if (this.opts.failInsertTables?.includes('messages')) throw new Error('disk I/O error');
    return this.inner.insertTurnMessages(conversationId, turnId, messages);
  }
  async persistTurnWithMemoryStaging(
    conversationId: number,
    turnId: string,
    messages: readonly TurnMessageWrite[],
    stagingSource: string,
    policyTerms?: string,
  ): Promise<number> {
    if (this.opts.failInsertTables?.includes('messages')
      || this.opts.failInsertTables?.includes('memory_staging')) throw new Error('disk I/O error');
    return this.inner.persistTurnWithMemoryStaging(
      conversationId,
      turnId,
      messages,
      stagingSource,
      policyTerms,
    );
  }
  async deleteTurnMessages(conversationId: number, turnId: string): Promise<number> {
    return this.inner.deleteTurnMessages(conversationId, turnId);
  }
  async completeMemoryStaging(input: CompleteMemoryStagingInput): Promise<void> {
    return this.inner.completeMemoryStaging(input);
  }
  async applyMemoryAuthorDelta(input: ApplyMemoryAuthorDeltaInput): Promise<ApplyMemoryAuthorDeltaResult> {
    if (!this.inner.applyMemoryAuthorDelta) throw new Error('unsupported');
    return this.inner.applyMemoryAuthorDelta(input);
  }
  async discardMemoryStaging(stagingId: number): Promise<void> {
    return this.inner.discardMemoryStaging(stagingId);
  }
  async failMemoryStaging(stagingId: number): Promise<void> {
    return this.inner.failMemoryStaging(stagingId);
  }
  async purgeAllLayer2Memory(): Promise<Layer2MemoryPurgeResult> {
    if (this.opts.failReads) throw new Error('disk I/O error');
    return this.inner.purgeAllLayer2Memory();
  }
  async purgeQuarantinedLayer2Memory(): Promise<Layer2MemoryPurgeResult> {
    if (this.opts.failReads) throw new Error('disk I/O error');
    return this.inner.purgeQuarantinedLayer2Memory();
  }
  async purgeLayer2LegacyMemory(input: Parameters<StorageProvider['purgeLayer2LegacyMemory']>[0]): Promise<number> {
    if (this.opts.failReads) throw new Error('disk I/O error');
    return this.inner.purgeLayer2LegacyMemory(input);
  }
  async update(table: string, filter: Filter, data: Record<string, unknown>): Promise<number> {
    return this.inner.update(table, filter, data);
  }
  async delete(table: string, filter: Filter): Promise<number> {
    return this.inner.delete(table, filter);
  }
  async close(): Promise<void> {
    return this.inner.close();
  }
}

/** Provider whose replies can be scripted per call (routing answers, worker answers). */
export class ScriptedProvider implements LlmProvider {
  readonly id = 'scripted';
  lastMessages: ChatMessage[] | null = null;
  calls = 0;
  private queue: string[];
  constructor(...replies: string[]) {
    this.queue = replies;
  }
  push(reply: string): void {
    this.queue.push(reply);
  }
  async isAvailable(): Promise<boolean> {
    return true;
  }
  async chat(messages: ChatMessage[], onChunk: (t: string) => void): Promise<string> {
    this.calls++;
    this.lastMessages = messages;
    const reply = this.queue.shift() ?? 'leer';
    onChunk(reply);
    return reply;
  }
}

export class FailingAfterWarmupProvider implements LlmProvider {
  readonly id = 'failing-after-warmup';
  private calls = 0;

  async isAvailable(): Promise<boolean> {
    return true;
  }
  async chat(_messages: ChatMessage[], onChunk: (text: string) => void): Promise<string> {
    this.calls += 1;
    if (this.calls === 1) {
      onChunk('ok');
      return 'ok';
    }
    throw new Error('router connection failed');
  }
}

export class UnavailableProvider implements LlmProvider {
  readonly id = 'unavailable';

  async isAvailable(): Promise<boolean> {
    return false;
  }

  async chat(): Promise<string> {
    throw new Error('Unavailable provider must never be called');
  }
}

export class RecoveringProvider implements LlmProvider {
  readonly id = 'recovering';
  private checks = 0;

  async isAvailable(): Promise<boolean> {
    this.checks += 1;
    return this.checks > 1;
  }

  async chat(_messages: ChatMessage[], onChunk: (text: string) => void): Promise<string> {
    onChunk('ok');
    return 'ok';
  }
}

export class FailingMidstreamProvider implements LlmProvider {
  readonly id = 'failing-midstream';

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async chat(_messages: ChatMessage[], onChunk: (text: string) => void): Promise<string> {
    onChunk('Unvollständige Antwort');
    throw new Error('worker connection lost');
  }
}

export class BlockingProvider implements LlmProvider {
  readonly id = 'blocking';
  calls = 0;
  releaseFirst = (): void => {};
  private firstGate = new Promise<void>((resolve) => { this.releaseFirst = resolve; });

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async chat(
    _messages: ChatMessage[],
    onChunk: (text: string) => void,
    options?: { signal?: AbortSignal },
  ): Promise<string> {
    this.calls += 1;
    const call = this.calls;
    if (call === 1) {
      await Promise.race([
        this.firstGate,
        new Promise<void>((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => {
            onChunk('late-after-abort');
            reject(options.signal?.reason);
          }, { once: true });
        }),
      ]);
    }
    const response = `Antwort ${call}`;
    onChunk(response);
    return response;
  }
}
