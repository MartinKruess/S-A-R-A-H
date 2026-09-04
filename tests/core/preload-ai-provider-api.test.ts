import { beforeAll, describe, expect, it, vi } from 'vitest';
import type {
  AcknowledgeAiWarningsInput,
  CheckAiConnectionHealthInput,
  DeleteAiConnectionInput,
  ReplaceAiBindingsInput,
  SaveAiApiKeyInput,
  SarahApi,
} from '../../src/core/sarah-api.js';

const electronMock = vi.hoisted(() => {
  const exposed: { key: string; value: object | null } = { key: '', value: null };
  return {
    exposed,
    invoke: vi.fn(async () => ({})),
    exposeInMainWorld: vi.fn((key: string, value: object) => {
      exposed.key = key;
      exposed.value = value;
    }),
  };
});

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: electronMock.exposeInMainWorld,
  },
  ipcRenderer: {
    invoke: electronMock.invoke,
    on: vi.fn(),
    once: vi.fn(),
    removeListener: vi.fn(),
    send: vi.fn(),
  },
}));

describe('AI provider preload API', () => {
  beforeAll(async () => {
    await import('../../src/preload.js');
  });

  it('exposes the dedicated API and forwards typed inputs unchanged', async () => {
    const api = electronMock.exposed.value as SarahApi;
    const saveInput: SaveAiApiKeyInput = {
      providerId: 'openai',
      apiKey: 'test-key',
      acknowledgement: { generalWarningVersion: 'v1' },
    };
    const deleteInput: DeleteAiConnectionInput = {
      connectionId: '11111111-1111-4111-8111-111111111111',
    };
    const acknowledgementInput: AcknowledgeAiWarningsInput = {
      connectionId: '33333333-3333-4333-8333-333333333333',
      acknowledgement: { generalWarningVersion: 'v1' },
    };
    const bindingsInput: ReplaceAiBindingsInput = {
      bindings: [],
      expectedRevision: 3,
    };
    const healthInput: CheckAiConnectionHealthInput = {
      connectionId: '22222222-2222-4222-8222-222222222222',
    };

    electronMock.invoke.mockClear();
    await api.aiProviders.list();
    await api.aiProviders.saveApiKey(saveInput);
    await api.aiProviders.acknowledgeWarnings(acknowledgementInput);
    await api.aiProviders.deleteConnection(deleteInput);
    await api.aiProviders.replaceBindings(bindingsInput);
    await api.aiProviders.checkHealth(healthInput);

    expect(electronMock.exposed.key).toBe('sarah');
    expect(electronMock.invoke.mock.calls).toEqual([
      ['ai-provider-hub-list'],
      ['ai-provider-save-key', saveInput],
      ['ai-provider-acknowledge-warnings', acknowledgementInput],
      ['ai-provider-delete', deleteInput],
      ['ai-provider-save-bindings', bindingsInput],
      ['ai-provider-check-health', healthInput],
    ]);
  });
});
