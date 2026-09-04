import { describe, expect, it, vi } from 'vitest';
import type { IpcMain } from 'electron';
import type {
  AiHubMutationResult,
  AiProviderHubSnapshot,
} from '../../src/core/ai-provider-contract.js';
import { registerAiProviderHandlers } from '../../src/main/ipc-ai-providers.js';
import {
  AI_GENERAL_COST_WARNING,
  AI_PROVIDER_CATALOG,
} from '../../src/services/integrations/ai-provider-catalog.js';
import type { AiProviderHubService } from '../../src/services/integrations/ai-provider-hub-service.js';

type Handler = (event: object | null, input?: unknown) => unknown;

function fakeIpcMain(): { readonly ipcMain: IpcMain; readonly handlers: Map<string, Handler> } {
  const handlers = new Map<string, Handler>();
  const ipcMain = {
    handle: (channel: string, listener: Handler) => handlers.set(channel, listener),
  } as unknown as IpcMain;
  return { ipcMain, handlers };
}

const SNAPSHOT: AiProviderHubSnapshot = {
  generalWarning: AI_GENERAL_COST_WARNING,
  catalog: AI_PROVIDER_CATALOG,
  connections: [],
  bindings: [],
  bindingRevision: 0,
  storage: { state: 'ready' },
};

const SUCCESS: AiHubMutationResult = { ok: true, snapshot: SNAPSHOT };
const CONNECTION_ID = 'db2f10d4-cc66-4c22-8611-43cc728682b6';
const BINDING_ID = '9d44aa94-4431-485a-8a54-6eb930653a44';
const TEST_KEY = 'test-secret-api-key-value';

function fakeHub(overrides: Partial<{
  snapshot: () => AiProviderHubSnapshot;
  saveApiKey: (input: object) => Promise<AiHubMutationResult>;
  acknowledgeWarnings: (input: object) => Promise<AiHubMutationResult>;
  deleteConnection: (input: object) => Promise<AiHubMutationResult>;
  replaceBindings: (input: object) => Promise<AiHubMutationResult>;
  checkHealth: (input: object) => Promise<AiHubMutationResult>;
}> = {}): AiProviderHubService {
  return {
    snapshot: vi.fn(() => SNAPSHOT),
    saveApiKey: vi.fn(async () => SUCCESS),
    acknowledgeWarnings: vi.fn(async () => SUCCESS),
    deleteConnection: vi.fn(async () => SUCCESS),
    replaceBindings: vi.fn(async () => SUCCESS),
    checkHealth: vi.fn(async () => SUCCESS),
    ...overrides,
  } as unknown as AiProviderHubService;
}

function setup(hub = fakeHub()): {
  readonly hub: AiProviderHubService;
  readonly handlers: Map<string, Handler>;
} {
  const { ipcMain, handlers } = fakeIpcMain();
  registerAiProviderHandlers(ipcMain, { getHub: () => hub });
  return { hub, handlers };
}

describe('registerAiProviderHandlers', () => {
  it('registers the six fixed provider-hub channels', () => {
    const { handlers } = setup();
    expect([...handlers.keys()]).toEqual([
      'ai-provider-hub-list',
      'ai-provider-save-key',
      'ai-provider-acknowledge-warnings',
      'ai-provider-delete',
      'ai-provider-save-bindings',
      'ai-provider-check-health',
    ]);
  });

  it('returns the validated service snapshot', () => {
    const { hub, handlers } = setup();
    expect(handlers.get('ai-provider-hub-list')!(null)).toEqual(SNAPSHOT);
    expect(hub.snapshot).toHaveBeenCalledOnce();
  });

  it('delegates every valid mutation with its parsed contract value', async () => {
    const { hub, handlers } = setup();
    const saveInput = {
      providerId: 'openai',
      apiKey: TEST_KEY,
      acknowledgement: { generalWarningVersion: AI_GENERAL_COST_WARNING.version },
    };
    const deleteInput = { connectionId: CONNECTION_ID };
    const acknowledgementInput = {
      connectionId: CONNECTION_ID,
      acknowledgement: { generalWarningVersion: AI_GENERAL_COST_WARNING.version },
    };
    const bindingInput = {
      expectedRevision: 0,
      bindings: [{
        bindingId: BINDING_ID,
        connectionId: CONNECTION_ID,
        role: 'text',
        operationId: 'openai_responses_text',
        modelProfile: 'provider_default',
        enabled: true,
        position: 0,
        revision: 1,
      }],
    };
    const healthInput = { connectionId: CONNECTION_ID };

    await expect(handlers.get('ai-provider-save-key')!(null, saveInput)).resolves.toEqual(SUCCESS);
    await expect(
      handlers.get('ai-provider-acknowledge-warnings')!(null, acknowledgementInput),
    ).resolves.toEqual(SUCCESS);
    await expect(handlers.get('ai-provider-delete')!(null, deleteInput)).resolves.toEqual(SUCCESS);
    await expect(handlers.get('ai-provider-save-bindings')!(null, bindingInput)).resolves.toEqual(SUCCESS);
    await expect(handlers.get('ai-provider-check-health')!(null, healthInput)).resolves.toEqual(SUCCESS);

    expect(hub.saveApiKey).toHaveBeenCalledWith(saveInput);
    expect(hub.acknowledgeWarnings).toHaveBeenCalledWith(acknowledgementInput);
    expect(hub.deleteConnection).toHaveBeenCalledWith(deleteInput);
    expect(hub.replaceBindings).toHaveBeenCalledWith(bindingInput);
    expect(hub.checkHealth).toHaveBeenCalledWith(healthInput);
  });

  it.each([
    ['ai-provider-save-key', { providerId: 'openai', apiKey: TEST_KEY, acknowledgement: {}, extra: true }, 'saveApiKey'],
    ['ai-provider-acknowledge-warnings', { connectionId: CONNECTION_ID, acknowledgement: {}, extra: true }, 'acknowledgeWarnings'],
    ['ai-provider-delete', { connectionId: '../connections.enc' }, 'deleteConnection'],
    ['ai-provider-save-bindings', { expectedRevision: -1, bindings: [] }, 'replaceBindings'],
    ['ai-provider-check-health', { connectionId: 'not-a-uuid' }, 'checkHealth'],
  ] as const)('rejects invalid input on %s without delegating', async (channel, input, method) => {
    const { hub, handlers } = setup();
    const result = await handlers.get(channel)!(null, input);
    expect(result).toEqual({
      ok: false,
      code: 'invalid_input',
      message: 'Die Angaben für die KI-Verbindung sind ungültig.',
    });
    expect(hub[method]).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain(TEST_KEY);
  });

  it('maps a thrown service error to a stable result without reflecting its secret', async () => {
    const hub = fakeHub({
      saveApiKey: vi.fn(async () => {
        throw new Error(`provider rejected ${TEST_KEY}`);
      }),
    });
    const { handlers } = setup(hub);
    const result = await handlers.get('ai-provider-save-key')!(null, {
      providerId: 'openai',
      apiKey: TEST_KEY,
      acknowledgement: { generalWarningVersion: AI_GENERAL_COST_WARNING.version },
    });

    expect(result).toEqual({
      ok: false,
      code: 'operation_failed',
      message: 'Die KI-Verbindung konnte nicht sicher geändert werden.',
    });
    expect(JSON.stringify(result)).not.toContain(TEST_KEY);
  });

  it('rejects a malformed service result before it crosses into the renderer', async () => {
    const hub = fakeHub({
      saveApiKey: vi.fn(async () => ({ ...SUCCESS, apiKey: TEST_KEY } as AiHubMutationResult)),
    });
    const { handlers } = setup(hub);
    const result = await handlers.get('ai-provider-save-key')!(null, {
      providerId: 'openai',
      apiKey: TEST_KEY,
      acknowledgement: { generalWarningVersion: AI_GENERAL_COST_WARNING.version },
    });

    expect(result).toEqual({
      ok: false,
      code: 'operation_failed',
      message: 'Die KI-Verbindung konnte nicht sicher geändert werden.',
    });
    expect(JSON.stringify(result)).not.toContain(TEST_KEY);
  });

  it('replaces a raw list failure with a stable error message', () => {
    const hub = fakeHub({
      snapshot: vi.fn(() => {
        throw new Error(`storage leaked ${TEST_KEY}`);
      }),
    });
    const { handlers } = setup(hub);

    expect(() => handlers.get('ai-provider-hub-list')!(null)).toThrow(
      'Der Status der KI-Anbieter konnte nicht sicher geladen werden.',
    );
  });
});
