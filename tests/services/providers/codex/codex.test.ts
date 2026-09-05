import { describe, it, expect, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { CodexAppServerClient, type CodexRpc, type CodexRpcMessage, type RpcValue } from '../../../../src/services/providers/codex/codex-app-server-client.js';
import { CodexAuthService } from '../../../../src/services/providers/codex/codex-auth-service.js';
import { CodexTaskAdapter } from '../../../../src/services/providers/codex/codex-task-adapter.js';
import { SpecialistTaskRequestSchema } from '../../../../src/core/specialist-task.js';

function fakeRpc() {
  const listeners = new Set<(message: CodexRpcMessage) => void>();
  const rpc: CodexRpc = { request: vi.fn(async (): Promise<RpcValue> => ({})), respond: vi.fn(), close: vi.fn(),
    subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); } };
  return { rpc, emit: (message: CodexRpcMessage) => listeners.forEach((fn) => fn(message)) };
}
describe('isolated Codex transport', () => {
  function transport() {
    const process = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
    return { process, client: new CodexAppServerClient(process as ChildProcessWithoutNullStreams, 100) };
  }
  it('correlates split frames and strips provider error details', async () => {
    const { process, client } = transport();
    const first = client.request('account/read', {});
    process.stdout.write('{"id":1,"res'); process.stdout.write('ult":{"account":null}}\n');
    await expect(first).resolves.toEqual({ account: null });
    const second = client.request('account/read', {});
    process.stdout.write('{"id":2,"error":{"message":"secret-key"}}\n');
    await expect(second).rejects.toThrow('codex_rpc_failed'); client.close();
  });
  it('kills malformed and oversized input without echoing it', async () => {
    const { process, client } = transport(); const pending = client.request('test', {});
    process.stdout.write('not json secret\n');
    await expect(pending).rejects.toThrow('codex_disconnected'); expect(process.kill).toHaveBeenCalled();
    const second = transport(); second.process.stdout.write('x'.repeat(2_097_153)); expect(second.process.kill).toHaveBeenCalled();
  });
  it('aborts pending requests and ignores late responses', async () => {
    const { process, client } = transport(); const controller = new AbortController();
    const pending = client.request('test', {}, controller.signal); controller.abort();
    await expect(pending).rejects.toThrow('codex_request_interrupted');
    process.stdout.write('{"id":1,"result":{}}\n'); client.close();
  });
});
describe('Codex auth policy', () => {
  it('never exchanges managed login for an API key', async () => {
    const { rpc } = fakeRpc(); const auth = new CodexAuthService(rpc, 'codex_managed_chatgpt');
    await expect(auth.loginApiKey('key')).rejects.toThrow('codex_auth_policy_denied');
    expect(rpc.request).not.toHaveBeenCalled();
  });
  it('accepts only the official device URL', async () => {
    const { rpc } = fakeRpc(); vi.mocked(rpc.request).mockResolvedValue({ type: 'chatgptDeviceCode', loginId: 'login', verificationUrl: 'https://evil.test/', userCode: '123' });
    await expect(new CodexAuthService(rpc, 'codex_managed_chatgpt').startManagedLogin()).rejects.toThrow();
  });
  it('invalidates identity on account change and disconnect', async () => {
    const { rpc, emit } = fakeRpc(); vi.mocked(rpc.request).mockResolvedValue({ account: { type: 'chatgpt', email: null, planType: 'plus' } });
    const auth = new CodexAuthService(rpc, 'codex_managed_chatgpt'); expect(await auth.check()).toBe(true);
    emit({ method: 'sarah/disconnected' }); expect(auth.isReady()).toBe(false); expect(auth.getGeneration()).toBe(1);
  });
});
describe('Codex workspace containment', () => {
  const request = () => SpecialistTaskRequestSchema.parse({ taskId: '123e4567-e89b-42d3-a456-426614174000',
    role: 'coding', goal: 'Review code', sourceTurnId: 'turn', planId: '123e4567-e89b-42d3-a456-426614174001',
    planRevision: 1, planFingerprint: 'a'.repeat(64), stepId: 'step', providerId: 'openai', operationId: 'openai_codex',
    connectionId: '123e4567-e89b-42d3-a456-426614174002', bindingId: '123e4567-e89b-42d3-a456-426614174003',
    bindingRevision: 1, credentialGeneration: 1, modelId: 'model', privateContext: false, originMode: 'chat',
    dataEgress: ['goal', 'workspace_files'], workspaceReference: 'workspace', accessMode: 'read_only', budget: { maxTurns: 1, timeoutMs: 1000 } });
  it('does not treat read-only filesystem access as workspace isolation', async () => {
    const { rpc } = fakeRpc(); const adapter = new CodexTaskAdapter(() => ({ client: rpc, model: 'model', cwd: 'G:/workspace', containmentVerified: false, isCurrent: () => true }));
    expect(await adapter.preflight({ providerId: 'openai', operationId: 'openai_codex', bindingId: 'id', bindingRevision: 1, connectionId: 'id' })).toEqual({ ok: false, code: 'unavailable' });
    expect(rpc.request).not.toHaveBeenCalled();
  });
  it('delivers a bounded result only for the exact turn and releases it', async () => {
    const { rpc, emit } = fakeRpc();
    vi.mocked(rpc.request).mockResolvedValueOnce({ thread: { id: 'thread' } }).mockResolvedValueOnce({ turn: { id: 'turn' } });
    const adapter = new CodexTaskAdapter(() => ({ client: rpc, model: 'model', cwd: 'G:/workspace', containmentVerified: true, isCurrent: () => true }), () => true);
    const context = { resolveCredential: () => null, emit: vi.fn(), publishResult: vi.fn() };
    await adapter.start(request(), context);
    emit({ method: 'item/completed', params: { threadId: 'thread', turnId: 'other', item: { type: 'agentMessage', text: 'wrong' } } });
    emit({ method: 'item/completed', params: { threadId: 'thread', turnId: 'turn', item: { type: 'agentMessage', text: 'answer' } } });
    emit({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'turn', status: 'completed' } } });
    expect(context.publishResult).toHaveBeenCalledExactlyOnceWith({ text: 'answer', citations: [] });
    expect(context.emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'completed' }));
  });
  it('does not call an interrupt acknowledgement a confirmed cancellation', async () => {
    const { rpc, emit } = fakeRpc(); vi.mocked(rpc.request).mockResolvedValueOnce({ thread: { id: 'thread' } }).mockResolvedValueOnce({ turn: { id: 'turn' } }).mockResolvedValue({});
    const adapter = new CodexTaskAdapter(() => ({ client: rpc, model: 'model', cwd: 'G:/workspace', containmentVerified: true, isCurrent: () => true }), () => true);
    const context = { resolveCredential: () => null, emit: vi.fn() }; const accepted = await adapter.start(request(), context);
    await adapter.cancel(accepted); expect(context.emit).not.toHaveBeenCalled();
    emit({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'turn', status: 'interrupted' } } });
    expect(context.emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'canceled' }));
  });
});
