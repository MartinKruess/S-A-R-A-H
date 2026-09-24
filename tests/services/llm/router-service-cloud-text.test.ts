import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { bootstrap, type AppContext } from '../../../src/core/bootstrap.js';
import { RouterService } from '../../../src/services/llm/router-service.js';
import { ScriptedProvider, StubActionService } from './router-service-test-harness.js';
import { selectCloudText, type CloudTextGenerator } from '../../../src/services/providers/cloud-text-service.js';
import { TextGenerationError } from '../../../src/services/providers/text-generation-adapter.js';
import type { AiResolvedBinding } from '../../../src/services/integrations/ai-provider-hub-service.js';
import type { BusEvents } from '../../../src/core/bus-events.js';
import { randomUUID } from 'node:crypto';

let directory: string;
let context: AppContext;
let router: RouterService | undefined;
beforeEach(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sarah-router-cloud-'));
  context = await bootstrap(directory, { testWrappingKey: Buffer.alloc(32, 17) });
  context.registry.register(new StubActionService());
  context.parsedConfig.trust.confirmationLevel = 'minimal';
  context.parsedConfig.trust.memoryAllowed = false;
  context.bus.on('action:result', (msg) => router?.onMessage(msg));
  context.bus.on('turn:terminal', (msg) => router?.onMessage(msg));
});
afterEach(async () => {
  await router?.destroy();
  await context.shutdown();
  fs.rmSync(directory, { recursive: true, force: true });
});

function cloudHub() {
  const binding: AiResolvedBinding = { bindingId: randomUUID(), revision: 1, credentialGeneration: 1,
    connectionId: randomUUID(), operationId: 'openai_responses_text', providerId: 'openai',
    modelId: 'gpt-4.1-mini', authKind: 'api_key', role: 'text', enabled: true, position: 0,
    modelProfile: 'provider_default', cloudTextOptIn: true };
  return { resolveBinding: () => binding, resolveCredential: () => 'synthetic-test-key' };
}

it.each([
  { status: 'failed', dependent: true },
  { status: 'incomplete', dependent: true },
  { status: 'refused', dependent: true },
  { status: 'completed', dependent: true },
  { status: 'failed', dependent: false },
] as const)(
  'respects plan dependencies after $status cloud output (dependent=$dependent)', async ({ status, dependent }) => {
    const generate = vi.fn(async () => {
      if (status === 'failed') throw new TextGenerationError({ fullText: '', status: 'incomplete' });
      return { fullText: 'Cloud output', status };
    });
    const cloud = selectCloudText(cloudHub(), new Map([['openai_responses_text', { generate }]]));
    const proposal = 'SARAH_PROPOSAL_V1 {"intents":[{"kind":"answer","evidence":"Erkläre Fahrräder"},{"kind":"action","action":"set_timer","param":"10m","evidence":"stelle einen Timer auf 10 Minuten"}]}';
    router = new RouterService(context, new ScriptedProvider('ok', proposal), new ScriptedProvider('local unused'), undefined, { selectCloudText: () => cloud });
    await router.init();
    await context.lifecycle.start();
    context.lifecycle.setCapability('router', 'ready');
    context.lifecycle.setCapability('local_worker', 'ready');
    const actions: BusEvents['action:request'][] = [];
    const outputs: string[] = [];
    const terminals: BusEvents['turn:terminal'][] = [];
    context.bus.on('llm:done', (msg) => outputs.push(msg.data.fullText));
    context.bus.on('turn:terminal', (msg) => terminals.push(msg.data));
    context.bus.on('action:request', (msg) => {
      actions.push(msg.data);
      context.bus.emit('test', 'action:result', { turnId: msg.data.turnId,
        requestId: msg.data.requestId, action: msg.data.action, ok: true });
    });
    await router.handleChatMessage(`Erkläre Fahrräder und ${dependent ? 'dann ' : ''}stelle einen Timer auf 10 Minuten`);
    expect(generate).toHaveBeenCalledOnce();
    expect(actions).toHaveLength(status === 'completed' || !dependent ? 1 : 0);
    expect(terminals).toHaveLength(1);
    if (status !== 'completed') expect(outputs.at(-1)).toContain('nicht vollständig');
  },
);

it('dispatches cloud text within IPC limits even if its unused local context would overflow', async () => {
  const cloud = vi.fn<CloudTextGenerator>(async (_text, _signal, onDelta) => {
    onDelta('Cloud answer'); return { fullText: 'Cloud answer', tookMs: 1, status: 'completed' };
  });
  context.parsedConfig.llm.workerOptions.num_ctx = 4096;
  let enabled = false;
  const worker = new ScriptedProvider('Local warmup');
  router = new RouterService(context, new ScriptedProvider('ok', '[ROUTE:9b]'), worker, undefined, { selectCloudText: () => enabled ? cloud : null });
  await router.init();
  await router.handleChatMessage('Erkläre Fahrräder');
  expect(router.activeModel).toBe('9b');
  enabled = true;
  const errors: BusEvents['llm:error'][] = [];
  context.bus.on('llm:error', (msg) => errors.push(msg.data));
  await router.handleChatMessage('x'.repeat(4000));
  expect(cloud).toHaveBeenCalledOnce();
  expect(cloud.mock.calls[0][0]).toBe('x'.repeat(4000));
  expect(errors).toEqual([]);
  expect(worker.calls).toBe(1);
});

it('keeps one-shot private messages and their inherited context local', async () => {
  context.parsedConfig.trust.anonymousEnabled = true;
  const cloud = vi.fn<CloudTextGenerator>(async () => ({ fullText: 'Cloud answer', tookMs: 1, status: 'completed' }));
  const worker = new ScriptedProvider('Private answer', 'Private follow-up');
  router = new RouterService(context, new ScriptedProvider('ok', '[ROUTE:9b]'), worker, undefined, { selectCloudText: () => cloud });
  await router.init();
  await router.handleChatMessage('/anonymous Erzähle etwas über Bäume');
  await router.handleChatMessage('Erkläre das genauer');
  expect(cloud).not.toHaveBeenCalled();
  expect(worker.calls).toBe(2);
});
