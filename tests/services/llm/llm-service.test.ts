// tests/services/llm/llm-service.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LlmService } from '../../../src/services/llm/llm-service';
import type { LlmProvider, ChatMessage } from '../../../src/services/llm/llm-provider.interface';
import type { AppContext } from '../../../src/core/bootstrap';
import { MessageBus } from '../../../src/core/message-bus';

function createMockProvider(): LlmProvider {
  return {
    id: 'mock',
    isAvailable: vi.fn().mockResolvedValue(true),
    chat: vi.fn().mockImplementation(
      async (_msgs: ChatMessage[], onChunk: (t: string) => void) => {
        onChunk('Hello');
        onChunk(' Martin');
        return 'Hello Martin';
      },
    ),
  };
}

function createMockContext(): { context: AppContext; bus: MessageBus } {
  const bus = new MessageBus();
  return {
    bus,
    context: {
      bus,
      registry: {} as any,
      config: {
        get: vi.fn().mockResolvedValue({
          profile: {
            displayName: 'Martin',
            city: 'Berlin',
            profession: 'Developer',
            responseStyle: 'mittel',
            tone: 'freundlich',
          },
        }),
        set: vi.fn(),
        query: vi.fn(),
        insert: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
        close: vi.fn(),
      },
      db: {
        get: vi.fn(),
        set: vi.fn(),
        query: vi.fn(),
        insert: vi.fn().mockResolvedValue(1),
        update: vi.fn(),
        delete: vi.fn(),
        close: vi.fn(),
      },
      shutdown: vi.fn(),
    } as unknown as AppContext,
  };
}

describe('LlmService', () => {
  let service: LlmService;
  let provider: LlmProvider;
  let context: AppContext;
  let bus: MessageBus;

  beforeEach(() => {
    provider = createMockProvider();
    const mock = createMockContext();
    context = mock.context;
    bus = mock.bus;
    service = new LlmService(context, provider);
  });

  it('has id "llm"', () => {
    expect(service.id).toBe('llm');
  });

  it('subscribes to chat:message', () => {
    expect(service.subscriptions).toContain('chat:message');
  });

  it('status is pending before init', () => {
    expect(service.status).toBe('pending');
  });

  it('status is running after init when provider available', async () => {
    await service.init();
    expect(service.status).toBe('running');
  });

  it('status is error after init when provider not available', async () => {
    (provider.isAvailable as any).mockResolvedValue(false);
    await service.init();
    expect(service.status).toBe('error');
  });

  it('builds system prompt from config', async () => {
    await service.init();

    const emitted: { topic: string; data: Record<string, unknown> }[] = [];
    bus.on('llm:done', (msg) => emitted.push(msg));

    await service.handleChatMessage('Hallo');

    const chatCall = (provider.chat as any).mock.calls[0];
    const systemMsg = chatCall[0][0] as ChatMessage;
    expect(systemMsg.role).toBe('system');
    expect(systemMsg.content).toContain('Martin');
    expect(systemMsg.content).toContain('Berlin');
  });

  it('emits llm:chunk and llm:done on chat', async () => {
    await service.init();

    const chunks: string[] = [];
    const dones: string[] = [];
    bus.on('llm:chunk', (msg) => chunks.push(msg.data.text as string));
    bus.on('llm:done', (msg) => dones.push(msg.data.fullText as string));

    await service.handleChatMessage('Hallo');

    expect(chunks).toEqual(['Hello', ' Martin']);
    expect(dones).toEqual(['Hello Martin']);
  });

  it('emits llm:error when provider throws', async () => {
    (provider.chat as any).mockRejectedValue(new Error('connection lost'));
    await service.init();

    const errors: string[] = [];
    bus.on('llm:error', (msg) => errors.push(msg.data.message as string));

    await service.handleChatMessage('Hallo');

    expect(errors.length).toBe(1);
    expect(errors[0]).toBe('Sarah ist kurz weggedriftet. Einen Moment...');
  });

  it('stores messages in db', async () => {
    await service.init();
    await service.handleChatMessage('Hallo');

    const insertCalls = (context.db.insert as any).mock.calls;
    // User message + assistant message = 2 inserts
    expect(insertCalls.length).toBe(2);
    expect(insertCalls[0][0]).toBe('messages');
    expect(insertCalls[0][1].role).toBe('user');
    expect(insertCalls[1][0]).toBe('messages');
    expect(insertCalls[1][1].role).toBe('assistant');
  });
});
