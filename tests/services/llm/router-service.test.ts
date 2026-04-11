// tests/services/llm/router-service.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RouterService } from '../../../src/services/llm/router-service';
import type { LlmProvider, ChatMessage, ChatOptions } from '../../../src/services/llm/llm-provider.interface';
import type { AppContext } from '../../../src/core/bootstrap';
import { MessageBus } from '../../../src/core/message-bus';

function createMockProvider(id: string, chatResponse: string): LlmProvider {
  return {
    id,
    isAvailable: vi.fn().mockResolvedValue(true),
    chat: vi.fn().mockImplementation(
      async (_msgs: ChatMessage[], onChunk: (t: string) => void, _options?: ChatOptions) => {
        onChunk(chatResponse);
        return chatResponse;
      },
    ),
  };
}

function createMockContext(): { context: AppContext; bus: MessageBus } {
  const bus = new MessageBus();
  const parsedConfig = {
    onboarding: { setupComplete: true },
    system: { os: '', platform: '', arch: '', cpu: '', cpuCores: '', totalMemory: '', freeMemory: '', hostname: '', shell: '', language: '', timezone: '', folders: { documents: '', downloads: '', pictures: '', desktop: '' } },
    profile: { displayName: 'Martin', lastName: '', city: 'Berlin', address: '', profession: 'Developer', activities: '', usagePurposes: [], hobbies: [] },
    skills: { programming: null, programmingStack: [], programmingResources: [], programmingProjectsFolder: '', design: null, office: null },
    resources: { emails: [], programs: [], favoriteLinks: [], pdfCategories: [], picturesFolder: '', installFolder: '', gamesFolder: '', extraProgramsFolder: '', importantFolders: [] },
    trust: { memoryAllowed: true, fileAccess: 'specific-folders' as const, confirmationLevel: 'standard' as const, memoryExclusions: [], anonymousEnabled: false, showContextEnabled: false },
    personalization: { accentColor: '#00d4ff', voice: 'default-female-de', speechRate: 1, chatFontSize: 'default' as const, chatAlignment: 'stacked' as const, emojisEnabled: true, responseMode: 'normal' as const, responseLanguage: 'de' as const, responseStyle: 'mittel' as const, tone: 'freundlich' as const, characterTraits: [], quirk: null },
    controls: { voiceMode: 'off' as const, pushToTalkKey: 'F9', quietModeDuration: 30, customCommands: [] },
    llm: { baseUrl: 'http://localhost:11434', routerModel: 'qwen3.5:2b', workerModel: 'qwen3.5:9b', performanceProfile: 'normal' as const, workerOptions: { num_ctx: 8192 }, options: {} },
    integrations: { context7: false },
  };
  return {
    bus,
    context: {
      bus,
      registry: {} as any,
      config: {
        get: vi.fn(),
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
      parsedConfig,
      configErrors: null,
      shutdown: vi.fn(),
    } as unknown as AppContext,
  };
}

// Mock fetch globally for VramManager calls
const mockFetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ models: [] }) });
vi.stubGlobal('fetch', mockFetch);

describe('RouterService', () => {
  let service: RouterService;
  let routerProvider: LlmProvider;
  let workerProvider: LlmProvider;
  let context: AppContext;
  let bus: MessageBus;

  beforeEach(() => {
    vi.clearAllMocks();
    routerProvider = createMockProvider('router', '[ROUTE:self] Hallo Martin!');
    workerProvider = createMockProvider('worker', 'Ausführliche Antwort vom 9B Modell.');
    const mock = createMockContext();
    context = mock.context;
    bus = mock.bus;
    service = new RouterService(context, routerProvider, workerProvider);
  });

  it('has id "router"', () => {
    expect(service.id).toBe('router');
  });

  it('subscribes to chat:message', () => {
    expect(service.subscriptions).toContain('chat:message');
  });

  it('status is running after init when router provider available', async () => {
    await service.init();
    expect(service.status).toBe('running');
  });

  it('status is error after init when router provider not available', async () => {
    (routerProvider.isAvailable as any).mockResolvedValue(false);
    await service.init();
    expect(service.status).toBe('error');
  });

  describe('routing to self', () => {
    it('emits feedback directly and stores messages in db', async () => {
      await service.init();

      const chunks: string[] = [];
      const dones: string[] = [];
      bus.on('llm:chunk', (msg) => chunks.push(msg.data.text));
      bus.on('llm:done', (msg) => dones.push(msg.data.fullText));

      await service.handleChatMessage('Hallo', 'chat');

      // Router provider was called, worker was NOT called
      expect(routerProvider.chat).toHaveBeenCalledTimes(1);
      expect(workerProvider.chat).not.toHaveBeenCalled();

      // Feedback emitted as chunk and done
      expect(chunks).toContain('Hallo Martin!');
      expect(dones).toEqual(['Hallo Martin!']);

      // Messages stored in db (user + assistant)
      const insertCalls = (context.db.insert as any).mock.calls;
      expect(insertCalls.length).toBe(2);
      expect(insertCalls[0][1].role).toBe('user');
      expect(insertCalls[1][1].role).toBe('assistant');
      expect(insertCalls[1][1].content).toBe('Hallo Martin!');
    });
  });

  describe('routing to 9b', () => {
    beforeEach(() => {
      (routerProvider.chat as any).mockImplementation(
        async (_msgs: ChatMessage[], onChunk: (t: string) => void) => {
          const response = '[ROUTE:9b] Moment, ich schaue genauer...';
          onChunk(response);
          return response;
        },
      );
    });

    it('emits routing feedback then worker response', async () => {
      await service.init();

      const chunks: string[] = [];
      const dones: string[] = [];
      const routings: any[] = [];
      bus.on('llm:chunk', (msg) => chunks.push(msg.data.text));
      bus.on('llm:done', (msg) => dones.push(msg.data.fullText));
      bus.on('llm:routing', (msg) => routings.push(msg.data));

      await service.handleChatMessage('Erkläre mir Quantenphysik', 'chat');

      // Routing event emitted
      expect(routings.length).toBe(1);
      expect(routings[0]).toEqual({
        from: '2b',
        to: '9b',
        feedback: 'Moment, ich schaue genauer...',
      });

      // Worker response emitted
      expect(dones).toEqual(['Ausführliche Antwort vom 9B Modell.']);

      // activeModel switched to 9b
      expect(service.activeModel).toBe('9b');
    });

    it('sets activeModel to 9b and subsequent messages go directly to 9B', async () => {
      await service.init();

      // First message — routes via 2B to 9B
      await service.handleChatMessage('Erkläre mir Quantenphysik', 'chat');
      expect(service.activeModel).toBe('9b');
      expect(routerProvider.chat).toHaveBeenCalledTimes(1);
      expect(workerProvider.chat).toHaveBeenCalledTimes(1);

      // Second message — goes directly to 9B, skips router
      await service.handleChatMessage('Und was noch?', 'chat');
      expect(routerProvider.chat).toHaveBeenCalledTimes(1); // NOT called again
      expect(workerProvider.chat).toHaveBeenCalledTimes(2);
    });
  });

  describe('no-tag fallback', () => {
    it('treats response without tag as self', async () => {
      (routerProvider.chat as any).mockImplementation(
        async (_msgs: ChatMessage[], onChunk: (t: string) => void) => {
          const response = 'Hallo, wie kann ich helfen?';
          onChunk(response);
          return response;
        },
      );

      await service.init();

      const dones: string[] = [];
      bus.on('llm:done', (msg) => dones.push(msg.data.fullText));

      await service.handleChatMessage('Hallo', 'chat');

      // Treated as self — no worker call
      expect(workerProvider.chat).not.toHaveBeenCalled();
      expect(dones).toEqual(['Hallo, wie kann ich helfen?']);
      expect(service.activeModel).toBe('2b');
    });
  });

  describe('idle timer', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      (routerProvider.chat as any).mockImplementation(
        async (_msgs: ChatMessage[], onChunk: (t: string) => void) => {
          const response = '[ROUTE:9b] Moment...';
          onChunk(response);
          return response;
        },
      );
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('swaps back to 2b after 5 min idle', async () => {
      await service.init();
      await service.handleChatMessage('Erkläre mir etwas', 'chat');
      expect(service.activeModel).toBe('9b');

      // Advance 5 minutes
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);

      expect(service.activeModel).toBe('2b');
    });

    it('resets timer on new message', async () => {
      await service.init();
      await service.handleChatMessage('Erkläre mir etwas', 'chat');
      expect(service.activeModel).toBe('9b');

      // Advance 4 minutes
      await vi.advanceTimersByTimeAsync(4 * 60 * 1000);
      expect(service.activeModel).toBe('9b');

      // Send another message — resets timer
      await service.handleChatMessage('Und weiter?', 'chat');

      // Advance another 4 minutes (total 8 from start, but only 4 from last message)
      await vi.advanceTimersByTimeAsync(4 * 60 * 1000);
      expect(service.activeModel).toBe('9b');

      // Advance 1 more minute (5 from last message)
      await vi.advanceTimersByTimeAsync(1 * 60 * 1000);
      expect(service.activeModel).toBe('2b');
    });
  });

  describe('error handling', () => {
    it('emits llm:error when provider throws', async () => {
      (routerProvider.chat as any).mockRejectedValue(new Error('connection lost'));
      await service.init();

      const errors: string[] = [];
      bus.on('llm:error', (msg) => errors.push(msg.data.message));

      await service.handleChatMessage('Hallo', 'chat');

      expect(errors.length).toBe(1);
      expect(errors[0]).toBe('Sarah ist kurz weggedriftet. Einen Moment...');
    });
  });
});
