import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bootstrap, type AppContext } from '../../../src/core/bootstrap.js';
import type { BusEvents } from '../../../src/core/bus-events.js';
import { RouterService } from '../../../src/services/llm/router-service.js';
import { ScriptedProvider, StubActionService } from './router-service-test-harness.js';

describe('RouterService foundation audit regressions', () => {
  let directory: string;
  let context: AppContext;
  let router: RouterService | null;

  beforeEach(async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sarah-foundation-regression-'));
    context = await bootstrap(directory, { testWrappingKey: Buffer.alloc(32, 94) });
    context.parsedConfig.profile.displayName = 'Martin';
    context.parsedConfig.trust.confirmationLevel = 'minimal';
    context.registry.register(new StubActionService());
    context.bus.on('action:result', (message) => router?.onMessage(message));
    router = null;
  });

  afterEach(async () => {
    await router?.destroy();
    await context.shutdown();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it.each([', ', ' & '])('executes the timer accompanying a profile question joined by %s', async (separator) => {
    const profileQuestion = 'Wie ist mein Name';
    const timerRequest = 'stelle einen Timer auf zehn Minuten';
    const proposal = `SARAH_PROPOSAL_V1 ${JSON.stringify({ intents: [
      { kind: 'answer', evidence: profileQuestion },
      { kind: 'action', action: 'set_timer', param: '10m', evidence: timerRequest },
    ] })}`;
    const routingProvider = new ScriptedProvider('ok', proposal);
    router = new RouterService(context, routingProvider, new ScriptedProvider('Du heißt Martin.'));
    await router.init();
    await context.lifecycle.start();
    context.lifecycle.setCapability('router', 'ready');
    context.lifecycle.setCapability('local_worker', 'ready');

    const requests: BusEvents['action:request'][] = [];
    context.bus.on('action:request', (message) => {
      requests.push(message.data);
      context.bus.emit('test', 'action:result', { turnId: message.data.turnId,
        requestId: message.data.requestId, action: message.data.action, ok: true });
    });
    await router.handleChatMessage(`${profileQuestion}${separator}${timerRequest}`);

    expect(routingProvider.calls).toBe(2);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ action: 'set_timer', param: '10m',
      provenance: { validation: 'semantic_grounding', evidenceScope: { kind: 'clause', ordinal: 1 } } });
  });
});
