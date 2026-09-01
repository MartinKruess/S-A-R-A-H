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
import {
  BlockingProvider,
  FakeProvider,
  FailingAfterWarmupProvider,
  FailingMidstreamProvider,
  FailingStorage,
  RecoveringProvider,
  ScriptedProvider,
  StubActionService,
  StubVoiceService,
  UnavailableProvider,
  startAction,
} from './router-service-test-harness.js';

describe('RouterService (media context)', () => {
  // Minimal fake AppContext: the media-context shortcut path only touches the bus.
  // No init() → conversationId stays FALLBACK → persistMessage skips the DB.
  function fakeCtx(bus: MessageBus): AppContext {
    return {
      bus,
      registry: { get: () => ({ status: 'running' }) },
      db: { insert: async () => 0 },
      parsedConfig: {
        llm: { baseUrl: 'http://localhost:11434' },
        trust: {
          memoryAllowed: true,
          memoryExclusions: [],
          confirmationLevel: 'standard',
          anonymousEnabled: false,
        },
      },
      actionConfirmations: new ActionConfirmationGate(),
    } as unknown as AppContext;
  }

  it('warm 9B window: terse "weiter" resolves to media_next and never calls the worker', async () => {
    const bus = new MessageBus();
    const requests: BusEvents['action:request'][] = [];
    bus.on('action:request', (m) => requests.push(m.data));

    const worker = new FakeProvider();
    const mediaContext = new MediaContext();
    mediaContext.record('media_next', Date.now()); // warm: last action was a skip

    const r = new RouterService(fakeCtx(bus), new FakeProvider(), worker, mediaContext);
    bus.on('action:result', (message) => r.onMessage(message));
    bus.on('action:request', (message) => {
      bus.emit('test', 'action:result', {
        turnId: message.data.turnId,
        requestId: message.data.requestId,
        action: message.data.action,
        ok: true,
      });
    });
    r.status = 'running'; // bypass init()/DB (conversationId stays FALLBACK → no SQLite)
    r.activeModel = '9b';

    await r.handleChatMessage('weiter');

    expect(requests).toHaveLength(1);
    expect(requests[0].action).toBe('media_next'); // shortcut fired before the 9B worker
    expect(worker.lastMessages).toBeNull();          // worker.stream never ran
    await r.destroy();
  });

  it('does not advance the media hint when the correlated media action fails', async () => {
    const bus = new MessageBus();
    const mediaContext = new MediaContext();
    mediaContext.record('media_pause', Date.now());
    const r = new RouterService(fakeCtx(bus), new FakeProvider(), new FakeProvider(), mediaContext);
    bus.on('action:result', (message) => r.onMessage(message));
    bus.on('action:request', (message) => {
      bus.emit('test', 'action:result', {
        turnId: message.data.turnId,
        requestId: message.data.requestId,
        action: message.data.action,
        ok: false,
      });
    });
    r.status = 'running';
    r.activeModel = '9b';

    await r.handleChatMessage('weiter');

    expect(mediaContext.resolve('weiter', Date.now())?.action).toBe('media_play');
    await r.destroy();
  });

  it('clears a warm media hint when incognito toggles and when the router is destroyed', async () => {
    const bus = new MessageBus();
    const mediaContext = new MediaContext();
    const context = fakeCtx(bus);
    context.parsedConfig.trust.anonymousEnabled = true;
    const r = new RouterService(context, new FakeProvider(), new FakeProvider(), mediaContext);
    r.status = 'running';

    mediaContext.record('media_pause', Date.now());
    await r.handleChatMessage('/anonymous');
    expect(mediaContext.resolve('weiter', Date.now())).toBeNull();

    mediaContext.record('media_pause', Date.now());
    await r.destroy();
    expect(mediaContext.resolve('weiter', Date.now())).toBeNull();
  });
});
