import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AcceptedSpecialistTaskMetadataSchema, SpecialistTaskRequestSchema } from '../../../../src/core/specialist-task.js';
import { OpenAiResearchAdapter } from '../../../../src/services/providers/openai/openai-research-adapter.js';
import { createOpenAiClient } from '../../../../src/services/providers/openai/responses-common.js';
import { SpecialistRuntimeService } from '../../../../src/services/specialists/specialist-runtime-service.js';
import { SpecialistTaskStore } from '../../../../src/services/specialists/specialist-task-store.js';

const directories: string[] = [];
const runtimes: SpecialistRuntimeService[] = [];
const refusal = 'I cannot provide this research.';
const measuredUsage = { input_tokens: 4, input_tokens_details: { cached_tokens: 0 }, output_tokens: 3,
  output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 7 };

function request() {
  return SpecialistTaskRequestSchema.parse({
    taskId: randomUUID(), role: 'research', goal: 'Synthetic research question',
    sourceTurnId: randomUUID(), planId: randomUUID(), planRevision: 1, planFingerprint: 'a'.repeat(64),
    stepId: 'research-step', providerId: 'openai', operationId: 'openai_deep_research',
    connectionId: randomUUID(), bindingId: randomUUID(), bindingRevision: 1, credentialGeneration: 1,
    authKind: 'api_key', modelId: 'o3-deep-research', backgroundConsent: true,
    privateContext: false, originMode: 'chat', dataEgress: ['goal'], accessMode: 'none',
    budget: { maxTurns: 1, timeoutMs: 60_000, maxOutputTokens: 100, maxToolCalls: 1 },
  });
}

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.destroy();
  for (const directory of directories.splice(0)) {
    const resolved = path.resolve(directory);
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('sarah-research-refusal-')) {
      throw new Error('Unsafe test cleanup target');
    }
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});

describe('OpenAI research refusal integration', () => {
  it.each(['immediate', 'poll', 'recovery'] as const)('keeps %s refusal visible and durably failed with measured usage', async (mode) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sarah-research-refusal-'));
    directories.push(directory);
    const refused = { id: 'resp_refusal', status: 'completed', usage: measuredUsage,
      output: [{ type: 'message', content: [{ type: 'refusal', refusal }] }] };
    const transport = vi.fn<typeof fetch>();
    if (mode === 'poll') transport.mockResolvedValueOnce(Response.json({ id: 'resp_refusal', status: 'queued', output: [] }));
    transport.mockImplementation(async () => Response.json(refused));
    const adapter = new OpenAiResearchAdapter((key) => createOpenAiClient(key, { fetchImpl: transport }), 1);
    const input = request();
    const store = new SpecialistTaskStore(directory);
    if (mode === 'recovery') {
      store.create(AcceptedSpecialistTaskMetadataSchema.parse({
        taskId: input.taskId, role: input.role, providerId: input.providerId, operationId: input.operationId,
        connectionId: input.connectionId, bindingId: input.bindingId, bindingRevision: input.bindingRevision,
        credentialGeneration: input.credentialGeneration, authKind: input.authKind, modelId: input.modelId,
        remoteRef: 'resp_refusal', status: 'running', sequence: 0,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        deadlineAt: new Date(Date.now() + 60_000).toISOString(), eventIds: [], maxTurns: 1, turnsUsed: 1,
      }), store.snapshot().generation);
    }
    const onTerminal = vi.fn();
    const runtime = new SpecialistRuntimeService({ store, adapters: [adapter], onTerminal,
      resolveCredential: () => 'synthetic-key', resolveBinding: () => ({
        providerId: input.providerId, operationId: input.operationId, connectionId: input.connectionId,
        bindingId: input.bindingId, bindingRevision: input.bindingRevision,
        credentialGeneration: input.credentialGeneration, authKind: input.authKind, modelId: input.modelId,
      }) });
    runtimes.push(runtime);
    if (mode === 'recovery') await runtime.reconcile();
    else expect(await runtime.start(input)).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(runtime.snapshot(input.taskId)).toMatchObject({
      status: 'failed', result: { text: refusal, citations: [] },
      terminal: { code: 'research_refused', usage: { inputTokens: 4, outputTokens: 3 } },
    }));
    expect(onTerminal).toHaveBeenCalledOnce();
    expect(onTerminal.mock.calls[0]![1].terminal.usage).toMatchObject({ inputTokens: 4, outputTokens: 3 });
    expect(new SpecialistTaskStore(directory).snapshot().tasks).toEqual([
      expect.objectContaining({ taskId: input.taskId, status: 'failed', terminalCode: 'research_refused' }),
    ]);
    const persisted = fs.readFileSync(path.join(directory, 'specialist-tasks.json'), 'utf8');
    for (const ephemeral of [refusal, input.goal, 'synthetic-key']) expect(persisted).not.toContain(ephemeral);
    expect(transport.mock.calls.map((call) => call[1]?.method)).toEqual(mode === 'poll' ? ['POST', 'GET']
      : mode === 'recovery' ? ['GET'] : ['POST']);
  });

  it.each(['empty', 'after-long-output'] as const)('retains a visible bounded explanation for %s refusal', async (mode) => {
    const transport = vi.fn<typeof fetch>(async () => Response.json({ id: 'resp_refusal', status: 'completed',
      output: [{ type: 'message', content: [
        ...(mode === 'after-long-output' ? [{ type: 'output_text', text: 'x'.repeat(120_000), annotations: [] }] : []),
        { type: 'refusal', refusal: mode === 'empty' ? '' : refusal },
      ] }], usage: measuredUsage }));
    const adapter = new OpenAiResearchAdapter((key) => createOpenAiClient(key, { fetchImpl: transport }));
    const context = { resolveCredential: () => 'synthetic-key', publishResult: vi.fn(), emit: vi.fn() };
    const accepted = await adapter.start(request(), context);
    const input = request();
    await adapter.activate(AcceptedSpecialistTaskMetadataSchema.parse({
      taskId: input.taskId, role: input.role, providerId: input.providerId, operationId: input.operationId,
      connectionId: input.connectionId, bindingId: input.bindingId, bindingRevision: input.bindingRevision,
      remoteRef: accepted.remoteRef, status: 'running', sequence: 0, createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(), eventIds: [], maxTurns: 1, turnsUsed: 1,
    }), context);
    expect(context.emit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ type: 'failed', code: 'research_refused' }));
    expect(context.publishResult).toHaveBeenCalledOnce();
    const text = context.publishResult.mock.calls[0]![0].text;
    expect(text.startsWith(mode === 'empty' ? 'Der Anbieter hat diese Anfrage abgelehnt.' : refusal)).toBe(true);
    expect(text.length).toBeLessThanOrEqual(100_000);
    expect(transport).toHaveBeenCalledOnce();
  });
});
