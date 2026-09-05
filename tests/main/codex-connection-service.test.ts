import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexConnectionService } from '../../src/main/codex-connection-service.js';
import type { AiProviderHubService } from '../../src/services/integrations/ai-provider-hub-service.js';
import { CODEX_MANAGED_CHATGPT_NOTICE } from '../../src/services/integrations/ai-auth-policy.js';
import type { CodexRpc, CodexRpcMessage, RpcValue } from '../../src/services/providers/codex/codex-app-server-client.js';

describe.skipIf(process.platform !== 'win32')('Codex owned connection lifecycle', () => {
  function fixture(stale = false) {
    const userData = mkdtempSync(join(tmpdir(), 'sarah-codex-service-'));
    const listeners = new Set<(message: CodexRpcMessage) => void>();
    const client: CodexRpc = { request: vi.fn(async (method): Promise<RpcValue> => method === 'account/read'
      ? { account: { type: 'chatgpt', email: null, planType: 'plus' } }
      : method === 'account/login/start' ? { type: 'chatgptDeviceCode', loginId: 'login', verificationUrl: 'https://auth.openai.com/codex/device', userCode: '123456' } : {}),
      subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); }, respond: vi.fn(), close: vi.fn() };
    const snapshot = { connections: [{ connectionId: 'connection', authKind: 'codex_managed_chatgpt', acknowledgement: {
      generalWarningVersion: stale ? 'old' : CODEX_MANAGED_CHATGPT_NOTICE.version } }] };
    const hub = { snapshot: vi.fn(() => snapshot), saveManagedConnection: vi.fn(async () => ({ ok: true, snapshot })),
      invalidateConnection: vi.fn(), checkHealth: vi.fn(async () => ({})) } as Pick<AiProviderHubService, 'snapshot' | 'saveManagedConnection' | 'invalidateConnection' | 'checkHealth'> as AiProviderHubService;
    const launch = vi.fn(async () => client);
    const service = new CodexConnectionService(userData, hub, launch);
    return { userData, client, hub, launch, service, emit: (message: CodexRpcMessage) => listeners.forEach((listener) => listener(message)),
      dispose: () => { service.close(); rmSync(userData, { recursive: true, force: true }); } };
  }
  it('requires explicit current acknowledgement before login metadata or process launch', async () => {
    const fixtureValue = fixture();
    try {
      const invalid = { acknowledgementVersion: 'old' } as Parameters<CodexConnectionService['start']>[0];
      expect((await fixtureValue.service.start(invalid)).state).toBe('unavailable');
      expect(fixtureValue.hub.saveManagedConnection).not.toHaveBeenCalled(); expect(fixtureValue.launch).not.toHaveBeenCalled();
    } finally { fixtureValue.dispose(); }
  });
  it('does not silently acknowledge a new notice when checking old sessions', async () => {
    const value = fixture(true);
    try { expect((await value.service.status()).state).toBe('unavailable'); expect(value.hub.saveManagedConnection).not.toHaveBeenCalled();
      expect(value.launch).not.toHaveBeenCalled(); } finally { value.dispose(); }
  });
  it('resolves the actual installed native package and invalidates published identity', async () => {
    const value = fixture();
    try {
      expect((await value.service.status()).state).toBe('connected');
      expect(value.service.available('connection')).toBe(true);
      expect(value.launch).toHaveBeenCalledWith(expect.objectContaining({ binaryPath: expect.stringMatching(/codex\.exe$/u), authKind: 'codex_managed_chatgpt' }));
      value.emit({ method: 'account/updated' }); expect(value.service.available('connection')).toBe(false);
      expect(value.hub.invalidateConnection).toHaveBeenCalledWith('connection');
    } finally { value.dispose(); }
  });
  it('closes a process that finishes launching after shutdown', async () => {
    const value = fixture(); let resolveLaunch: ((client: CodexRpc) => void) | undefined;
    value.launch.mockImplementation(() => new Promise<CodexRpc>((resolve) => { resolveLaunch = resolve; }));
    try {
      const pending = value.service.status(); await vi.waitFor(() => expect(resolveLaunch).toBeDefined());
      value.service.close(); resolveLaunch!(value.client);
      expect((await pending).state).toBe('unavailable'); expect(value.client.close).toHaveBeenCalled();
      expect(value.service.available('connection')).toBe(false);
    } finally { value.dispose(); }
  });
  it('logs out a persisted session even before status or login was opened this run', async () => {
    const value = fixture();
    try {
      expect((await value.service.logout()).state).toBe('not_connected');
      expect(value.client.request).toHaveBeenCalledWith('account/logout', {});
      expect(value.client.close).toHaveBeenCalled();
    } finally { value.dispose(); }
  });
});
