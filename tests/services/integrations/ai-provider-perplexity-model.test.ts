import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { KeyManager } from '../../../src/core/crypto/key-manager.js';
import { AiProviderHubSnapshotSchema } from '../../../src/core/ai-provider-contract.js';
import { PERPLEXITY_PAID_PROBE } from '../../../src/core/perplexity-policy.js';
import { SpecialistHandoffConfirmationGate } from '../../../src/core/specialist-handoff-confirmation.js';
import { AcceptedSpecialistTaskMetadataSchema, SpecialistTaskRequestSchema } from '../../../src/core/specialist-task.js';
import { AiCredentialStore } from '../../../src/services/integrations/ai-credential-store.js';
import { AI_GENERAL_COST_WARNING } from '../../../src/services/integrations/ai-provider-catalog.js';
import { AiProviderHubService } from '../../../src/services/integrations/ai-provider-hub-service.js';
import { AiProviderHubStore } from '../../../src/services/integrations/ai-provider-hub-store.js';
import { PerplexityHealthService } from '../../../src/services/providers/perplexity-health-service.js';

describe('native Perplexity model configuration', () => {
  const directories: string[] = [];
  afterEach(() => {
    for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
  });

  it('keeps the native model through verified binding, persistence, consent and accepted task metadata', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sarah-perplexity-model-'));
    directories.push(directory);
    const transport = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      id: 'probe-fixture', model: 'perplexity/sonar', status: 'completed',
      usage: { input_tokens: 3, output_tokens: 1 },
    }));
    const health = new PerplexityHealthService(vi.fn(), transport);
    const credentials = new AiCredentialStore(directory,
      new KeyManager(directory, { testWrappingKey: Buffer.alloc(32, 51) }));
    const hub = new AiProviderHubService(new AiProviderHubStore(directory), credentials, {
      healthCheck: (connection, key, input) => health.check(connection, key, input!),
      isOperationReady: (operation) => operation === 'perplexity_agent_research',
      isModelSupported: (operation, model, connection) => operation === 'perplexity_agent_research'
        && health.isModelSupported(model, connection),
    });
    const saved = await hub.saveApiKey({ providerId: 'perplexity', apiKey: 'pplx-synthetic-fixture',
      acknowledgement: { generalWarningVersion: AI_GENERAL_COST_WARNING.version } });
    expect(saved.ok).toBe(true);
    if (!saved.ok) throw new Error('Fixture connection was not saved');
    const connection = saved.snapshot.connections[0]!;
    expect(await hub.checkHealth({ connectionId: connection.connectionId,
      expectedCredentialGeneration: connection.credentialGeneration ?? 1,
      paidProbeConsentVersion: PERPLEXITY_PAID_PROBE.version })).toMatchObject({ ok: true });
    expect(await hub.replaceBindings({ expectedRevision: 0, bindings: [{
      bindingId: randomUUID(), connectionId: connection.connectionId,
      role: 'research', operationId: 'perplexity_agent_research',
      modelProfile: 'provider_default', modelId: 'perplexity/sonar',
      enabled: true, position: 0, revision: 1,
    }] })).toMatchObject({ ok: true });

    const binding = hub.resolveBinding('research');
    expect(binding).toMatchObject({ modelId: 'perplexity/sonar', providerId: 'perplexity' });
    if (!binding) throw new Error('Fixture research binding was not activated');
    expect(AiProviderHubSnapshotSchema.parse(hub.snapshot()).bindings[0]?.modelId).toBe('perplexity/sonar');
    expect(new AiProviderHubStore(directory).snapshot().bindings[0]?.modelId).toBe('perplexity/sonar');
    expect(transport).toHaveBeenCalledTimes(1);

    const subject = {
      planId: randomUUID(), revision: 1, fingerprint: 'a'.repeat(64),
      sourceTurnId: randomUUID(), stepId: 'research-step', task: 'Recherchiere Fahrräder.',
      capability: 'research', privateContext: false, originMode: 'chat', dataEgress: ['goal'],
      modelId: binding.modelId, accessMode: 'none', budget: { maxTurns: 1, timeoutMs: 60_000 },
      bindingLease: { providerId: binding.providerId, operationId: binding.operationId,
        connectionId: binding.connectionId, bindingId: binding.bindingId, revision: binding.revision,
        credentialGeneration: binding.credentialGeneration, authKind: binding.authKind },
      display: { providerName: 'Perplexity', roleName: 'Recherche', modelName: binding.modelId },
    } as const;
    const gate = new SpecialistHandoffConfirmationGate();
    const confirmation = gate.request(subject);
    expect(confirmation?.subject.modelId).toBe('perplexity/sonar');
    if (!confirmation) throw new Error('Fixture confirmation was rejected');
    const grant = gate.approve(confirmation.confirmationId, randomUUID());
    expect(grant?.subject.modelId).toBe('perplexity/sonar');
    if (!grant) throw new Error('Fixture grant was rejected');
    expect(gate.consume(grant, { ...subject, modelId: 'other-model' })).toBe(false);
    expect(gate.consume(grant, subject)).toBe(true);

    const request = SpecialistTaskRequestSchema.parse({
      taskId: randomUUID(), role: 'research', goal: subject.task,
      sourceTurnId: subject.sourceTurnId, planId: subject.planId, planRevision: subject.revision,
      planFingerprint: subject.fingerprint, stepId: subject.stepId,
      providerId: binding.providerId, operationId: binding.operationId,
      connectionId: binding.connectionId, bindingId: binding.bindingId, bindingRevision: binding.revision,
      modelId: binding.modelId, credentialGeneration: binding.credentialGeneration, authKind: binding.authKind,
      privateContext: false, originMode: 'chat', dataEgress: ['goal'], accessMode: 'none', budget: subject.budget,
    });
    expect(request.modelId).toBe('perplexity/sonar');
    const metadata = AcceptedSpecialistTaskMetadataSchema.parse({
      taskId: request.taskId, role: request.role, providerId: request.providerId, operationId: request.operationId,
      connectionId: request.connectionId, bindingId: request.bindingId, bindingRevision: request.bindingRevision,
      modelId: request.modelId, credentialGeneration: request.credentialGeneration, authKind: request.authKind,
      remoteRef: 'response-fixture', status: 'running', sequence: 0,
      createdAt: '2026-09-05T12:00:00.000Z', updatedAt: '2026-09-05T12:00:00.000Z',
      eventIds: [], maxTurns: 1, turnsUsed: 1,
    });
    expect(AcceptedSpecialistTaskMetadataSchema.parse(JSON.parse(JSON.stringify(metadata))).modelId)
      .toBe('perplexity/sonar');
  });
});
