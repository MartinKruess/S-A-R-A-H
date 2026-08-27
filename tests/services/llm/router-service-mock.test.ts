// tests/services/llm/router-service.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RouterService } from '../../../src/services/llm/router-service';
import type { LlmProvider, ChatMessage, ChatOptions } from '../../../src/services/llm/llm-provider.interface';
import type { AppContext } from '../../../src/core/bootstrap';
import { MessageBus } from '../../../src/core/message-bus';
import { feedbackTexts } from '../../../src/services/llm/filler-phrases';
import type { ModelRuntimePort } from '../../../src/services/llm/model-runtime';
import { ROUTER_DEADLINE_MS } from '../../../src/services/llm/routing-service';

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
    llm: { baseUrl: 'http://localhost:11434', routerModel: 'phi4-mini:3.8b', workerModel: 'qwen3:8b', performanceProfile: 'normal' as const, workerOptions: { num_ctx: 8192 }, options: {} },
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
        query: vi.fn().mockResolvedValue([]),
        insert: vi.fn().mockResolvedValue(1),
        insertTurnMessages: vi.fn().mockResolvedValue(undefined),
        persistTurnWithMemoryStaging: vi.fn().mockResolvedValue(1),
        update: vi.fn(),
        delete: vi.fn(),
        queryMessagesPage: vi.fn().mockResolvedValue([]),
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

  function runtime(): ModelRuntimePort {
    return (service as unknown as { modelRuntime: ModelRuntimePort }).modelRuntime;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    routerProvider = createMockProvider('router', '[ROUTE:9b]');
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

  it('warms the router model during init with a 1-token keep_alive=-1 call', async () => {
    await service.init();
    expect(routerProvider.chat).toHaveBeenCalledTimes(1);
    const [, , options] = (routerProvider.chat as any).mock.calls[0];
    expect(options).toMatchObject({ num_predict: 1, keep_alive: -1 });
  });

  it('keeps the recovery service running while the runtime reports a warmup error', async () => {
    (routerProvider.chat as any).mockRejectedValueOnce(new Error('ollama unreachable'));
    await service.init();
    expect(service.status).toBe('running');
    expect(runtime().snapshot.state).toBe('error');
  });

  it('keeps unavailable capability observable and recovers it without rebuilding the service', async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(routerProvider.isAvailable)
        .mockResolvedValueOnce(false)
        .mockResolvedValue(true);
      await service.init();
      expect(service.status).toBe('running');
      expect(runtime().snapshot.roles.router.availability).toBe('unavailable');

      await vi.advanceTimersByTimeAsync(5_000);

      expect(runtime().snapshot.roles.router.availability).toBe('available');
      expect(runtime().snapshot.state).toBe('ready');
      expect(service.status).toBe('running');
    } finally {
      vi.useRealTimers();
    }
  });

  describe('init idempotence (single-flight)', () => {
    it('runs the init body exactly once for concurrent and repeated calls', async () => {
      await Promise.all([service.init(), service.init()]);
      await service.init();
      expect(routerProvider.isAvailable).toHaveBeenCalledTimes(1);
      expect(routerProvider.chat).toHaveBeenCalledTimes(1); // warmup once
    });

    it('returns the same promise for repeated calls', () => {
      expect(service.init()).toBe(service.init());
    });
  });

  describe('routing to 9b', () => {
    beforeEach(() => {
      (routerProvider.chat as any).mockImplementation(
        async (_msgs: ChatMessage[], onChunk: (t: string) => void) => {
          const response = '[ROUTE:9b]';
          onChunk(response);
          return response;
        },
      );
    });

    it('emits a routing event without model prose and then the worker response', async () => {
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
      expect(routings[0]).toMatchObject({
        from: 'router',
        to: 'local_worker',
      });

      // Worker response emitted
      expect(dones).toEqual(['Ausführliche Antwort vom 9B Modell.']);

      // activeModel switched to 9b
      expect(service.activeModel).toBe('9b');
    });

    it('sets activeModel to 9b and subsequent messages go directly to 9B', async () => {
      await service.init();
      (routerProvider.chat as any).mockClear();

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
    it('falls back safely to the worker when the router returns prose', async () => {
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

      expect(workerProvider.chat).toHaveBeenCalledTimes(1);
      expect(dones).toEqual(['Ausführliche Antwort vom 9B Modell.']);
      expect(dones).not.toContain('Hallo, wie kann ich helfen?');
      expect(service.activeModel).toBe('9b');
    });
  });

  describe('idle timer', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      (routerProvider.chat as any).mockImplementation(
        async (_msgs: ChatMessage[], onChunk: (t: string) => void) => {
          const response = '[ROUTE:9b]';
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

  describe('filler phrases (voice bridging)', () => {
    function route9b(): void {
      (routerProvider.chat as any).mockImplementation(
        async (_msgs: ChatMessage[], onChunk: (t: string) => void) => {
          const response = '[ROUTE:9b]';
          onChunk(response);
          return response;
        },
      );
    }

    it('emits a frontendThinking filler on the 2B→9B route in voice mode', async () => {
      route9b();
      await service.init();

      const fillers: string[] = [];
      bus.on('llm:filler', (msg) => fillers.push(msg.data.text));
      bus.on('action:result', (msg) => service.onMessage(msg));
      bus.on('action:request', (msg) => {
        bus.emit('test', 'action:result', {
          turnId: msg.data.turnId,
          requestId: msg.data.requestId,
          action: msg.data.action,
          ok: true,
        });
      });

      await service.handleChatMessage('Erkläre mir Quantenphysik', 'voice');

      expect(fillers).toHaveLength(1);
      expect(feedbackTexts.frontendThinking).toContain(fillers[0]);
      expect(service.activeModel).toBe('9b');
    });

    it('emits a switchingBack filler on the 9B→2B gate in voice mode', async () => {
      await service.init();
      (routerProvider.chat as any).mockImplementation(
        async (_msgs: ChatMessage[], onChunk: (t: string) => void) => {
          const response = '[ACTION:open_program:spotify]';
          onChunk(response);
          return response;
        },
      );
      service.activeModel = '9b';

      const fillers: string[] = [];
      bus.on('llm:filler', (msg) => fillers.push(msg.data.text));
      bus.on('action:result', (msg) => service.onMessage(msg));
      bus.on('action:request', (msg) => {
        bus.emit('test', 'action:result', {
          turnId: msg.data.turnId,
          requestId: msg.data.requestId,
          action: msg.data.action,
          ok: true,
        });
      });

      // A device-command-looking message while 9B is active triggers the gate swap.
      await service.handleChatMessage('Öffne Spotify', 'voice');

      expect(fillers).toHaveLength(1);
      expect(feedbackTexts.switchingBack).toContain(fillers[0]);
    });

    it('emits NO filler for the same 2B→9B route in chat mode', async () => {
      route9b();
      await service.init();

      const fillers: string[] = [];
      bus.on('llm:filler', (msg) => fillers.push(msg.data.text));

      await service.handleChatMessage('Erkläre mir Quantenphysik', 'chat');

      expect(fillers).toHaveLength(0);
      expect(service.activeModel).toBe('9b');
    });

    it('emits NO filler when 9B stays warm without a device command (no swap)', async () => {
      await service.init();
      service.activeModel = '9b';

      const fillers: string[] = [];
      bus.on('llm:filler', (msg) => fillers.push(msg.data.text));

      // Plain follow-up, not a device command → goes straight to the worker, no swap.
      await service.handleChatMessage('Und was war nochmal Chlorophyll?', 'voice');

      expect(fillers).toHaveLength(0);
      expect(workerProvider.chat).toHaveBeenCalled();
    });

    it('never persists the filler and never puts it in the worker history', async () => {
      route9b();
      await service.init();

      const fillers: string[] = [];
      bus.on('llm:filler', (msg) => fillers.push(msg.data.text));

      await service.handleChatMessage('Erkläre mir Quantenphysik', 'voice');

      const fillerText = fillers[0];
      // The whole turn is persisted atomically; the transient filler adds no row.
      expect(context.db.persistTurnWithMemoryStaging).toHaveBeenCalledOnce();
      expect(context.db.persistTurnWithMemoryStaging).toHaveBeenCalledWith(1, expect.any(String), [
        { role: 'user', content: 'Erkläre mir Quantenphysik' },
        { role: 'assistant', content: 'Ausführliche Antwort vom 9B Modell.' },
      ], expect.any(String), expect.any(String));
      const persisted = vi.mocked(context.db.persistTurnWithMemoryStaging).mock.calls[0][2];
      expect(persisted.map((message) => message.content)).not.toContain(fillerText);

      // The filler was not pushed to history: it never reaches the worker context.
      const workerMessages = (workerProvider.chat as any).mock.calls[0][0] as ChatMessage[];
      expect(workerMessages.some((m) => m.content === fillerText)).toBe(false);
    });
  });

  describe('error handling', () => {
    it('surfaces the hard router deadline as the existing timeout terminal', async () => {
      await service.init();
      vi.useFakeTimers();
      try {
        (routerProvider.chat as ReturnType<typeof vi.fn>).mockImplementation(
          async (_messages: ChatMessage[], _onChunk: (text: string) => void, options?: ChatOptions) => (
            new Promise<string>((_resolve, reject) => {
              options?.signal?.addEventListener(
                'abort',
                () => reject(options.signal?.reason),
                { once: true },
              );
            })
          ),
        );
        const errors: string[] = [];
        const terminals: Array<{ status: string; message?: string }> = [];
        bus.on('llm:error', (message) => errors.push(message.data.message));
        bus.on('turn:terminal', (message) => terminals.push(message.data));
        const turn = service.handleChatMessage('Erkläre mir den Himmel.', 'chat');

        await vi.advanceTimersByTimeAsync(ROUTER_DEADLINE_MS);
        await turn;

        expect(errors).toEqual(['Sarah hat den Faden verloren... Versuch es nochmal.']);
        expect(terminals).toEqual([{
          status: 'error',
          message: 'Sarah hat den Faden verloren... Versuch es nochmal.',
          turnId: expect.any(String),
        }]);
      } finally {
        vi.useRealTimers();
      }
    });

    it('cancels active and queued turns when lifecycle enters stopping', async () => {
      let lifecycleListener: ((snapshot: { state: string }) => void) | null = null;
      context.lifecycle = {
        snapshot: { state: 'ready' },
        subscribe: vi.fn((listener: (snapshot: { state: string }) => void) => {
          lifecycleListener = listener;
          listener({ state: 'ready' });
          return vi.fn();
        }),
      } as unknown as AppContext['lifecycle'];
      const shutdownAware = new RouterService(context, routerProvider, workerProvider);
      await shutdownAware.init();
      shutdownAware.activeModel = '9b';
      (workerProvider.chat as ReturnType<typeof vi.fn>).mockImplementation(
        async (_messages: ChatMessage[], _onChunk: (text: string) => void, options?: ChatOptions) => (
          new Promise<string>((_resolve, reject) => {
            options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true });
          })
        ),
      );
      const terminals: string[] = [];
      bus.on('turn:terminal', (message) => terminals.push(message.data.status));

      const active = shutdownAware.handleChatMessage('Aktiv');
      const queued = shutdownAware.handleChatMessage('Wartend');
      await vi.waitFor(() => expect(workerProvider.chat).toHaveBeenCalledOnce());
      lifecycleListener!({ state: 'stopping' });
      await Promise.all([active, queued]);

      expect(terminals).toEqual(['canceled', 'canceled']);
      expect(workerProvider.chat).toHaveBeenCalledOnce();
    });

    it('accepts an external barge-in terminal without logging the expected abort or emitting a duplicate', async () => {
      await service.init();
      service.activeModel = '9b';
      (workerProvider.chat as ReturnType<typeof vi.fn>).mockImplementation(
        async (_messages: ChatMessage[], _onChunk: (text: string) => void, options?: ChatOptions) => (
          new Promise<string>((_resolve, reject) => {
            options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true });
          })
        ),
      );
      const terminals: Array<{ turnId: string; status: string }> = [];
      let turnId = '';
      bus.on('turn:accepted', (message) => { turnId = message.data.turnId; });
      bus.on('turn:terminal', (message) => {
        terminals.push(message.data);
        service.onMessage(message);
      });
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

      try {
        const active = service.handleChatMessage('Lange Workerantwort', 'chat');
        await vi.waitFor(() => expect(workerProvider.chat).toHaveBeenCalledOnce());
        bus.emit('voice', 'turn:terminal', { turnId, status: 'canceled' });
        await active;

        expect(terminals).toEqual([{ turnId, status: 'canceled' }]);
        expect(warn).not.toHaveBeenCalledWith(
          '[Router] Output job failed:',
          expect.objectContaining({ name: 'AbortError' }),
        );
        expect(warn).not.toHaveBeenCalledWith(
          '[MessageBus] terminal event for unknown turn refused:',
          turnId,
        );
      } finally {
        warn.mockRestore();
      }
    });

    it('keeps the interrupted user question as follow-up context without persisting partial assistant output', async () => {
      await service.init();
      service.activeModel = '9b';
      let workerCall = 0;
      let followUpMessages: ChatMessage[] = [];
      (workerProvider.chat as ReturnType<typeof vi.fn>).mockImplementation(
        async (messages: ChatMessage[], onChunk: (text: string) => void, options?: ChatOptions) => {
          workerCall += 1;
          if (workerCall === 1) {
            onChunk('Unvollständige Teilantwort');
            return new Promise<string>((_resolve, reject) => {
              options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true });
            });
          }
          followUpMessages = messages;
          onChunk('Fortsetzung zur letzten Frage.');
          return 'Fortsetzung zur letzten Frage.';
        },
      );
      let interruptedTurnId = '';
      bus.on('turn:accepted', (message) => {
        if (!interruptedTurnId) interruptedTurnId = message.data.turnId;
      });
      bus.on('turn:cancel', (message) => service.onMessage(message));
      bus.on('turn:terminal', (message) => service.onMessage(message));

      const interrupted = service.handleChatMessage('Erkläre die Relativitätstheorie ausführlich', 'chat');
      await vi.waitFor(() => expect(workerCall).toBe(1));
      bus.emit('voice', 'turn:cancel', {
        turnId: interruptedTurnId,
        reason: 'Voice interruption',
      });
      bus.emit('voice', 'turn:terminal', {
        turnId: interruptedTurnId,
        status: 'canceled',
      });
      await interrupted;

      expect(context.db.insertTurnMessages).not.toHaveBeenCalled();

      await service.handleChatMessage('Erzähl mir mehr dazu', 'chat');

      expect(followUpMessages).toContainEqual({
        role: 'user',
        content: 'Erkläre die Relativitätstheorie ausführlich',
      });
      expect(followUpMessages).toContainEqual({ role: 'user', content: 'Erzähl mir mehr dazu' });
      expect(followUpMessages).not.toContainEqual({
        role: 'assistant',
        content: 'Unvollständige Teilantwort',
      });
      const allWrites = vi.mocked(context.db.insertTurnMessages).mock.calls.flatMap((call) => call[1]);
      expect(allWrites).not.toContainEqual({
        role: 'user',
        content: 'Erkläre die Relativitätstheorie ausführlich',
      });
      expect(allWrites).not.toContainEqual({
        role: 'assistant',
        content: 'Unvollständige Teilantwort',
      });
    });

    it('does not retain a worker turn canceled before its first output chunk', async () => {
      await service.init();
      service.activeModel = '9b';
      let workerCall = 0;
      let followUpMessages: ChatMessage[] = [];
      (workerProvider.chat as ReturnType<typeof vi.fn>).mockImplementation(
        async (messages: ChatMessage[], onChunk: (text: string) => void, options?: ChatOptions) => {
          workerCall += 1;
          if (workerCall === 1) return new Promise<string>((_resolve, reject) => {
            options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true });
          });
          followUpMessages = messages;
          onChunk('Neue Antwort');
          return 'Neue Antwort';
        },
      );
      let turnId = '';
      bus.on('turn:accepted', (message) => { turnId = message.data.turnId; });
      bus.on('turn:cancel', (message) => service.onMessage(message));

      const interrupted = service.handleChatMessage('Noch nicht beantwortete Frage', 'chat');
      await vi.waitFor(() => expect(workerProvider.chat).toHaveBeenCalledOnce());
      bus.emit('voice', 'turn:cancel', { turnId, reason: 'Voice interruption' });
      await interrupted;

      expect(context.db.insertTurnMessages).not.toHaveBeenCalled();
      await service.handleChatMessage('Unabhängige Folgefrage', 'chat');
      expect(followUpMessages).not.toContainEqual({
        role: 'user',
        content: 'Noch nicht beantwortete Frage',
      });
    });

    it.each([
      {
        label: 'memory disabled',
        configure: (target: AppContext) => { target.parsedConfig.trust.memoryAllowed = false; },
        question: 'Meine nicht gespeicherte Frage',
        expectedHistory: 'Meine nicht gespeicherte Frage',
      },
      {
        label: 'anonymous mode',
        configure: (target: AppContext) => { target.parsedConfig.trust.anonymousEnabled = true; },
        question: '/anonymous Mein Codename ist Eule',
        expectedHistory: 'Mein Codename ist Eule',
      },
      {
        label: 'memory exclusion',
        configure: (target: AppContext) => { target.parsedConfig.trust.memoryExclusions = ['Finanzen']; },
        question: 'Meine Finanzen betreffen dieses Thema',
        expectedHistory: 'Meine Finanzen betreffen dieses Thema',
      },
    ])('keeps interrupted user context transient with $label', async ({
      configure,
      question,
      expectedHistory,
    }) => {
      configure(context);
      await service.init();
      service.activeModel = '9b';
      let workerCall = 0;
      let followUpMessages: ChatMessage[] = [];
      (workerProvider.chat as ReturnType<typeof vi.fn>).mockImplementation(
        async (messages: ChatMessage[], onChunk: (text: string) => void, options?: ChatOptions) => {
          workerCall += 1;
          if (workerCall === 1) {
            onChunk('Verworfene Teilantwort');
            return new Promise<string>((_resolve, reject) => {
              options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true });
            });
          }
          followUpMessages = messages;
          onChunk('Private Folgeantwort');
          return 'Private Folgeantwort';
        },
      );
      let turnId = '';
      bus.on('turn:accepted', (message) => { turnId = message.data.turnId; });
      bus.on('turn:cancel', (message) => service.onMessage(message));

      const interrupted = service.handleChatMessage(question, 'chat');
      await vi.waitFor(() => expect(workerProvider.chat).toHaveBeenCalledOnce());
      bus.emit('voice', 'turn:cancel', { turnId, reason: 'Voice interruption' });
      await interrupted;

      expect(context.db.insertTurnMessages).not.toHaveBeenCalled();
      await service.handleChatMessage('Erzähl mir mehr dazu', 'chat');
      expect(followUpMessages).toContainEqual({
        role: 'user',
        content: expectedHistory,
      });
      expect(followUpMessages).not.toContainEqual({
        role: 'assistant',
        content: 'Verworfene Teilantwort',
      });
      expect(context.db.insertTurnMessages).not.toHaveBeenCalled();
    });

    it('emits llm:error when provider throws', async () => {
      await service.init();
      (routerProvider.chat as any).mockRejectedValue(new Error('connection lost'));

      const errors: string[] = [];
      bus.on('llm:error', (msg) => errors.push(msg.data.message));

      await service.handleChatMessage('Hallo', 'chat');

      expect(errors.length).toBe(1);
      expect(errors[0]).toBe('Sarah ist kurz weggedriftet. Einen Moment...');
    });
  });
});
