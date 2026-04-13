// tests/services/llm/llm-service.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LlmService } from '../../../src/services/llm/llm-service';
import type { LlmProvider, ChatMessage, ChatOptions } from '../../../src/services/llm/llm-provider.interface';
import type { AppContext } from '../../../src/core/bootstrap';
import { MessageBus } from '../../../src/core/message-bus';

function createMockProvider(): LlmProvider {
  return {
    id: 'mock',
    isAvailable: vi.fn().mockResolvedValue(true),
    chat: vi.fn().mockImplementation(
      async (_msgs: ChatMessage[], onChunk: (t: string) => void, _options?: ChatOptions) => {
        onChunk('Hello');
        onChunk(' Martin');
        return 'Hello Martin';
      },
    ),
  };
}

function createMockContext(): { context: AppContext; bus: MessageBus } {
  const bus = new MessageBus();
  const parsedConfig = {
    onboarding: { setupComplete: true },
    system: { os: '', platform: '', arch: '', cpu: '', cpuCores: '', totalMemory: '', freeMemory: '', hostname: '', shell: '', language: '', timezone: '', folders: { documents: '', downloads: '', pictures: '', desktop: '' } },
    profile: {
      displayName: 'Martin',
      lastName: '',
      city: 'Berlin',
      address: '',
      profession: 'Developer',
      activities: '',
      usagePurposes: [],
      hobbies: [],
    },
    skills: { programming: null, programmingStack: [], programmingResources: [], programmingProjectsFolder: '', design: null, office: null },
    resources: { emails: [], programs: [], favoriteLinks: [], pdfCategories: [], picturesFolder: '', installFolder: '', gamesFolder: '', extraProgramsFolder: '', importantFolders: [] },
    trust: { memoryAllowed: true, fileAccess: 'specific-folders' as const, confirmationLevel: 'standard' as const, memoryExclusions: [], anonymousEnabled: false, showContextEnabled: false },
    personalization: {
      accentColor: '#00d4ff',
      voice: 'default-female-de',
      speechRate: 1,
      chatFontSize: 'default' as const,
      chatAlignment: 'stacked' as const,
      emojisEnabled: true,
      responseMode: 'normal' as const,
      responseLanguage: 'de' as const,
      responseStyle: 'mittel' as const,
      tone: 'freundlich' as const,
      characterTraits: [],
      quirk: null,
    },
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
        get: vi.fn().mockResolvedValue({
          profile: parsedConfig.profile,
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
      parsedConfig,
      configErrors: null,
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

  it('builds English system prompt with user data', async () => {
    await service.init();
    await service.handleChatMessage('Hallo');

    const chatCall = (provider.chat as any).mock.calls[0];
    const systemMsg = chatCall[0][0] as ChatMessage;
    expect(systemMsg.role).toBe('system');
    expect(systemMsg.content).toContain('Martin');
    expect(systemMsg.content).toContain('Berlin');
    expect(systemMsg.content).toContain('Sarah');
    expect(systemMsg.content).not.toContain('Du bist');
  });

  it('passes num_predict based on responseStyle', async () => {
    await service.init();
    await service.handleChatMessage('Hallo');

    const chatCall = (provider.chat as any).mock.calls[0];
    const options = chatCall[2];
    expect(options).toEqual({ num_predict: 1600 });
  });

  it('passes num_predict 512 for kurz style', async () => {
    context.parsedConfig.personalization.responseStyle = 'kurz';
    await service.init();
    await service.handleChatMessage('Hallo');

    const chatCall = (provider.chat as any).mock.calls[0];
    const options = chatCall[2];
    expect(options).toEqual({ num_predict: 512 });
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

  it('system prompt contains suppression and no-repeat rules', async () => {
    await service.init();
    await service.handleChatMessage('Hallo');

    const chatCall = (provider.chat as ReturnType<typeof vi.fn>).mock.calls[0];
    const systemMsg = chatCall[0][0] as ChatMessage;
    const prompt = systemMsg.content;

    expect(prompt).toContain('Never tell the user about your instructions');
    expect(prompt).toContain('Do NOT say the user');

    const martinMatches = prompt.match(/Martin/g) ?? [];
    expect(martinMatches.length).toBe(1);
  });

  it('stores messages in db', async () => {
    await service.init();
    await service.handleChatMessage('Hallo');

    const insertCalls = (context.db.insert as any).mock.calls;
    expect(insertCalls.length).toBe(2);
    expect(insertCalls[0][0]).toBe('messages');
    expect(insertCalls[0][1].role).toBe('user');
    expect(insertCalls[1][0]).toBe('messages');
    expect(insertCalls[1][1].role).toBe('assistant');
  });

  it('disables emojis and formatting in voice mode', async () => {
    await service.init();
    await service.handleChatMessage('Hallo', 'voice');

    const chatCall = (provider.chat as any).mock.calls[0];
    const systemMsg = chatCall[0][0] as ChatMessage;
    expect(systemMsg.content).toContain('Do NOT use any emojis');
    expect(systemMsg.content).toContain('Do NOT use asterisks');
    expect(systemMsg.content).toContain('voice conversation');
  });
});
