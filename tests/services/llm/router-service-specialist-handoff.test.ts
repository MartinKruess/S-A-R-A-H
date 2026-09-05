import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bootstrap, type AppContext } from '../../../src/core/bootstrap.js';
import type { BusEvents } from '../../../src/core/bus-events.js';
import type { SarahService } from '../../../src/core/service.interface.js';
import type { ServiceStatus } from '../../../src/core/types.js';
import { SpecialistHandoffCoordinator } from '../../../src/services/specialists/specialist-handoff-coordinator.js';
import { SpecialistRuntimeService } from '../../../src/services/specialists/specialist-runtime-service.js';
import type { SpecialistTaskAdapter } from '../../../src/services/specialists/specialist-task-adapter.js';
import { SpecialistTaskStore } from '../../../src/services/specialists/specialist-task-store.js';
import { RouterService } from '../../../src/services/llm/router-service.js';
import { ScriptedProvider } from './router-service-test-harness.js';

const BINDING_ID = '33333333-3333-4333-8333-333333333333';
const CONNECTION_ID = '44444444-4444-4444-8444-444444444444';

function readyService(id: string): SarahService {
  return {
    id,
    subscriptions: [],
    status: 'running' as ServiceStatus,
    async init(): Promise<void> { this.status = 'running'; },
    async destroy(): Promise<void> { this.status = 'stopped'; },
    onMessage(): void {},
  };
}

describe('RouterService specialist handoff integration', () => {
  let directory: string;
  let context: AppContext | undefined;
  let router: RouterService | undefined;
  let runtime: SpecialistRuntimeService | undefined;

  beforeEach(async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sarah-router-specialist-'));
    context = await bootstrap(directory, { testWrappingKey: Buffer.alloc(32, 73) });
  });

  afterEach(async () => {
    await router?.destroy();
    await runtime?.destroy();
    await context?.shutdown();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  async function createHarness() {
    if (!context) throw new Error('Expected bootstrapped context');
    let bindingRevision = 2;
    const adapter: SpecialistTaskAdapter = {
      operationId: 'openai_codex',
      isReady: () => true,
      preflight: vi.fn(async () => ({ ok: true })),
      start: vi.fn(async () => ({ remoteRef: 'remote-task', status: 'running' })),
      resume: vi.fn(async () => undefined),
      provideInput: vi.fn(async () => undefined),
      cancel: vi.fn(async () => undefined),
    };
    const resolveBinding = () => ({
      bindingId: BINDING_ID,
      bindingRevision,
      providerId: 'openai' as const,
      operationId: 'openai_codex' as const,
      connectionId: CONNECTION_ID,
    });
    runtime = new SpecialistRuntimeService({
      store: new SpecialistTaskStore(directory),
      adapters: [adapter],
      resolveBinding,
      resolveCredential: () => 'test-secret',
      shutdownDrainMs: 1,
    });
    const coordinator = new SpecialistHandoffCoordinator(
      runtime,
      () => ({
        ...resolveBinding(),
        providerName: 'OpenAI',
        roleName: 'Programmierung',
        modelName: 'Anbieterstandard',
      }),
    );
    const proposal = 'SARAH_PROPOSAL_V1 {"intents":[{"kind":"handoff","specialist":"coding","evidence":"Implementiere TTS in Sarah"}]}';
    router = new RouterService(
      context,
      new ScriptedProvider('ok', proposal),
      new ScriptedProvider('worker must not run'),
      undefined,
      {
        specialistHandoffs: coordinator,
        getSpecialistReadiness: () => ({
          coding: { state: 'available', reason: 'ready' },
          research: { state: 'unavailable', reason: 'no_adapter' },
          vision: { state: 'unavailable', reason: 'no_adapter' },
        }),
      },
    );
    await router.init();
    context.registry.register(readyService('search'));
    context.registry.register(readyService('reminders'));
    await context.lifecycle.start();
    context.lifecycle.setCapability('router', 'ready');
    context.lifecycle.setCapability('local_worker', 'ready');
    const done: string[] = [];
    context.bus.on('llm:done', (message) => done.push(message.data.fullText));
    return {
      adapter,
      coordinator,
      done,
      setBindingRevision: (revision: number) => { bindingRevision = revision; },
    };
  }

  it('keeps an explicit goal inert until exact confirmation and starts it once', async () => {
    const { adapter, coordinator, done } = await createHarness();

    await router!.handleChatMessage('Implementiere TTS in Sarah');

    expect(adapter.start).not.toHaveBeenCalled();
    expect(done.at(-1)).toContain('Soll ich den Spezialisten jetzt starten?');
    const confirmationId = coordinator.singleConfirmationId();
    expect(confirmationId).not.toBeNull();

    await router!.handleChatMessage(`/confirm ${confirmationId}`);

    expect(adapter.start).toHaveBeenCalledOnce();
    expect(adapter.start).toHaveBeenCalledWith(
      expect.objectContaining({ goal: 'Implementiere TTS in Sarah', role: 'coding' }),
      expect.any(Object),
      expect.any(AbortSignal),
    );
    expect(done.at(-1)).toBe('Der Spezialistenauftrag wurde gestartet.');

    await router!.handleChatMessage(`/confirm ${confirmationId}`);
    expect(adapter.start).toHaveBeenCalledOnce();
  });

  it('accepts the natural voice confirmation only for the single pending handoff', async () => {
    const { adapter, coordinator, done } = await createHarness();

    await router!.handleChatMessage('Implementiere TTS in Sarah', 'voice');
    expect(coordinator.hasSinglePending()).toBe(true);
    expect(adapter.start).not.toHaveBeenCalled();

    await router!.handleChatMessage('Ja', 'voice');

    expect(adapter.start).toHaveBeenCalledOnce();
    expect(done.at(-1)).toBe('Der Spezialistenauftrag wurde gestartet.');
  });

  it('invalidates a pending handoff when privacy changes', async () => {
    if (!context) throw new Error('Expected bootstrapped context');
    context.parsedConfig.trust.anonymousEnabled = true;
    const { adapter, coordinator } = await createHarness();

    await router!.handleChatMessage('Implementiere TTS in Sarah');
    const confirmationId = coordinator.singleConfirmationId();
    await router!.handleChatMessage('/anonymous');
    await router!.handleChatMessage(`/confirm ${confirmationId}`);

    expect(adapter.start).not.toHaveBeenCalled();
    expect(coordinator.hasSinglePending()).toBe(false);
  });

  it('rejects ambiguous natural confirmation when an action is also pending', async () => {
    if (!context) throw new Error('Expected bootstrapped context');
    const { adapter, done } = await createHarness();
    await router!.handleChatMessage('Implementiere TTS in Sarah');
    context.actionConfirmations.request(
      'action-turn',
      {
        action: 'open_program',
        param: 'spotify',
        provenance: {
          sourceTurnId: 'action-turn',
          decisionSource: 'router_model',
          evidenceSource: 'user_text',
          validation: 'schema_only',
          evidenceScope: { kind: 'whole_turn' },
        },
      },
      false,
    );

    await router!.handleChatMessage('Ja');

    expect(adapter.start).not.toHaveBeenCalled();
    expect(done.at(-1)).toContain('mehrere Bestätigungen offen');
  });

  it('fails closed when the selected binding changes after the prompt', async () => {
    const { adapter, coordinator, done, setBindingRevision } = await createHarness();
    await router!.handleChatMessage('Implementiere TTS in Sarah');
    const confirmationId = coordinator.singleConfirmationId();
    setBindingRevision(3);

    await router!.handleChatMessage(`/confirm ${confirmationId}`);

    expect(adapter.start).not.toHaveBeenCalled();
    expect(done.at(-1)).toContain('Spezialistenverbindung hat sich geändert');
  });
});
