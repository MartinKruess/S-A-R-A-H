import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KeyManager } from '../../../src/core/crypto/key-manager.js';
import { AiCredentialStore } from '../../../src/services/integrations/ai-credential-store.js';
import {
  AI_GENERAL_COST_WARNING,
  ANTHROPIC_COST_WARNING,
} from '../../../src/services/integrations/ai-provider-catalog.js';
import { AiProviderHubService } from '../../../src/services/integrations/ai-provider-hub-service.js';
import { AiProviderHubStore } from '../../../src/services/integrations/ai-provider-hub-store.js';
import { CODEX_MANAGED_CHATGPT_NOTICE } from '../../../src/services/integrations/ai-auth-policy.js';
import { PERPLEXITY_PAID_PROBE } from '../../../src/core/perplexity-policy.js';

describe('AiProviderHubService', () => {
  let tmpDir: string;
  let credentials: AiCredentialStore;
  let service: AiProviderHubService;
  let now: number;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sarah-ai-hub-service-'));
    credentials = new AiCredentialStore(
      tmpDir,
      new KeyManager(tmpDir, { testWrappingKey: Buffer.alloc(32, 51) }),
    );
    now = Date.parse('2026-09-04T12:00:00.000Z');
    service = new AiProviderHubService(
      new AiProviderHubStore(tmpDir),
      credentials,
      { now: () => now, createId: () => randomUUID() },
    );
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('starts with the fixed catalog and no configured or active provider', () => {
    const snapshot = service.snapshot();

    expect(snapshot.catalog.map((provider) => provider.id)).toEqual([
      'openai', 'anthropic', 'perplexity',
    ]);
    expect(snapshot.generalWarning).toEqual(AI_GENERAL_COST_WARNING);
    expect(snapshot.connections).toEqual([]);
    expect(snapshot.bindings).toEqual([]);
    expect(snapshot.storage).toEqual({ state: 'ready' });
  });

  it('pins explicit paid health consent to provider and credential generation', async () => {
    const check = vi.fn(async () => ({ state: 'healthy' as const }));
    const hub = new AiProviderHubService(new AiProviderHubStore(tmpDir), credentials, { healthCheck: check });
    const save = () => hub.saveApiKey({providerId:'perplexity', apiKey:'pplx-fixture',
      acknowledgement:{generalWarningVersion:AI_GENERAL_COST_WARNING.version}});
    const saved = await save();
    if (!saved.ok) throw new Error('save failed');
    const connection = saved.snapshot.connections[0]!;
    const consent = {connectionId:connection.connectionId, paidProbeConsentVersion:PERPLEXITY_PAID_PROBE.version,
      expectedCredentialGeneration:connection.credentialGeneration ?? 1};
    expect((await hub.checkHealth({...consent,paidProbeConsentVersion:'old'})).ok).toBe(false);
    expect(check).not.toHaveBeenCalled();
    expect((await hub.checkHealth(consent)).ok).toBe(true);
    expect(check).toHaveBeenCalledWith(expect.objectContaining({connectionId:connection.connectionId}), 'pplx-fixture', consent);
    await save();
    check.mockClear();
    expect((await hub.checkHealth(consent)).ok).toBe(false);
    expect(check).not.toHaveBeenCalled();
  });

  it('recovers only an exact accepted API identity without enabling unhealthy new dispatch', async () => {
    await service.saveApiKey({ providerId: 'openai', apiKey: 'sk-recovery-fixture', acknowledgement: { generalWarningVersion: AI_GENERAL_COST_WARNING.version } });
    const connectionId = service.snapshot().connections[0]!.connectionId;
    const restarted = new AiProviderHubService(new AiProviderHubStore(tmpDir), credentials);
    expect(restarted.resolveCredential(connectionId, 'openai', 1)).toBeNull();
    expect(restarted.resolveRecoveryCredential(connectionId, 'openai', 1)).toBe('sk-recovery-fixture');
    expect(restarted.resolveRecoveryCredential(connectionId, 'openai')).toBeNull();
    expect(restarted.resolveRecoveryCredential(connectionId, 'openai', 2)).toBeNull();
    expect(restarted.resolveRecoveryCredential(connectionId, 'anthropic', 1)).toBeNull();
    restarted.invalidateConnection(connectionId);
    expect(restarted.resolveRecoveryCredential(connectionId, 'openai', 1)).toBeNull();
  });

  it('does not recover a deleted API credential', async () => {
    await service.saveApiKey({ providerId: 'openai', apiKey: 'sk-deleted-recovery-fixture', acknowledgement: { generalWarningVersion: AI_GENERAL_COST_WARNING.version } });
    const connectionId = service.snapshot().connections[0]!.connectionId;
    expect(service.resolveRecoveryCredential(connectionId, 'openai', 1)).toBe('sk-deleted-recovery-fixture');
    expect((await service.deleteConnection({ connectionId })).ok).toBe(true);
    expect(new AiProviderHubService(new AiProviderHubStore(tmpDir), credentials).resolveRecoveryCredential(connectionId, 'openai', 1)).toBeNull();
  });

  it('requires model, readiness, health and explicit cloud text opt-in, and revokes old generations', async () => {
    const draining = vi.fn(async () => true);
    service = new AiProviderHubService(new AiProviderHubStore(tmpDir), credentials, {
      healthCheck: async () => ({ state: 'healthy' }), isOperationReady: () => true,
      isModelSupported: (_operation, model) => model === 'test-model', beforeConnectionChange: draining,
    });
    const input = { providerId: 'openai' as const, apiKey: 'sk-test-secret',
      acknowledgement: { generalWarningVersion: AI_GENERAL_COST_WARNING.version } };
    await service.saveApiKey(input);
    const connectionId = service.snapshot().connections[0]!.connectionId;
    const binding = { bindingId: randomUUID(), connectionId, role: 'text' as const,
      operationId: 'openai_responses_text' as const, modelProfile: 'provider_default' as const,
      modelId: 'test-model', enabled: true, position: 0, revision: 1 };
    await service.replaceBindings({ bindings: [binding], expectedRevision: 0 });
    await service.checkHealth({ connectionId });
    expect(service.resolveBinding('text')).toBeNull();
    await service.replaceBindings({ bindings: [{ ...binding, cloudTextOptIn: true }], expectedRevision: 1 });
    expect(service.resolveBinding('text')).toMatchObject({ credentialGeneration: 1, modelId: 'test-model' });
    expect(service.resolveCredential(connectionId, 'openai', 1)).toBe(input.apiKey);
    await service.saveApiKey({ ...input, apiKey: 'sk-replacement-secret' });
    expect(draining).toHaveBeenCalledWith(connectionId, 1);
    expect(service.resolveBinding('text')).toBeNull();
    await service.checkHealth({ connectionId });
    expect(service.resolveCredential(connectionId, 'openai', 1)).toBeNull();
    expect(service.resolveCredential(connectionId, 'openai', 2)).toBe('sk-replacement-secret');
  });

  it('keeps managed sessions outside encrypted API secrets and supports four connections', async () => {
    for (const providerId of ['openai', 'anthropic', 'perplexity'] as const) {
      await service.saveApiKey({ providerId, apiKey: 'sk-test-secret', acknowledgement: {
        generalWarningVersion: AI_GENERAL_COST_WARNING.version,
        ...(providerId === 'anthropic' ? { providerWarningVersion: ANTHROPIC_COST_WARNING.version } : {}),
      } });
    }
    const secretWrite = vi.spyOn(credentials, 'write');
    const saved = await service.saveManagedConnection({ acknowledgement: {
      generalWarningVersion: CODEX_MANAGED_CHATGPT_NOTICE.version,
    } });
    expect(saved.ok).toBe(true);
    expect(service.snapshot().connections).toHaveLength(4);
    expect(secretWrite).not.toHaveBeenCalled();
    const managed = service.snapshot().connections.find((entry) => entry.authKind === 'codex_managed_chatgpt')!;
    expect(service.resolveCredential(managed.connectionId, 'openai')).toBeNull();
    expect(managed.hasCredential).toBe(false);
  });

  it('blocks rotation and selection when accepted work cannot safely drain', async () => {
    service = new AiProviderHubService(new AiProviderHubStore(tmpDir), credentials, {
      beforeConnectionChange: async () => false,
    });
    const input = { providerId: 'openai' as const, apiKey: 'sk-original-secret',
      acknowledgement: { generalWarningVersion: AI_GENERAL_COST_WARNING.version } };
    await service.saveApiKey(input);
    const connection = service.snapshot().connections[0]!;
    expect(await service.saveApiKey({ ...input, apiKey: 'sk-replacement-secret' })).toMatchObject({ ok: false });
    expect(credentials.read({ connectionId: connection.connectionId, providerId: 'openai', authKind: 'api_key' })).toBe(input.apiKey);
    expect(service.resolveCredential(connection.connectionId, 'openai')).toBeNull();
  });

  it('rejects stale warning acknowledgement before creating a credential file', async () => {
    const result = await service.saveApiKey({
      providerId: 'openai',
      apiKey: 'sk-test-secret-value',
      acknowledgement: { generalWarningVersion: 'old-warning' },
    });

    expect(result).toMatchObject({ ok: false, code: 'stale_acknowledgement' });
    expect(fs.existsSync(path.join(tmpDir, 'ai-credentials'))).toBe(false);
  });

  it('requires the additional current Anthropic warning acknowledgement', async () => {
    const missing = await service.saveApiKey({
      providerId: 'anthropic',
      apiKey: 'sk-ant-test-secret',
      acknowledgement: { generalWarningVersion: AI_GENERAL_COST_WARNING.version },
    });
    const accepted = await service.saveApiKey({
      providerId: 'anthropic',
      apiKey: 'sk-ant-test-secret',
      acknowledgement: {
        generalWarningVersion: AI_GENERAL_COST_WARNING.version,
        providerWarningVersion: ANTHROPIC_COST_WARNING.version,
      },
    });

    expect(missing).toMatchObject({ ok: false, code: 'acknowledgement_required' });
    expect(accepted).toMatchObject({ ok: true });
    if (accepted.ok) {
      expect(accepted.snapshot.connections[0]?.health.state).toBe('credential_saved_unverified');
    }
  });

  it('saves a credential without exposing it or claiming provider health', async () => {
    const apiKey = 'sk-openai-do-not-leak';
    const result = await service.saveApiKey({
      providerId: 'openai',
      apiKey,
      acknowledgement: { generalWarningVersion: AI_GENERAL_COST_WARNING.version },
    });

    expect(result.ok).toBe(true);
    expect(JSON.stringify(result)).not.toContain(apiKey);
    if (!result.ok) throw new Error('Expected successful local save');
    const connection = result.snapshot.connections[0];
    expect(connection).toMatchObject({
      providerId: 'openai',
      hasCredential: true,
      health: { state: 'credential_saved_unverified' },
    });
    expect(credentials.read({
      connectionId: connection!.connectionId,
      providerId: 'openai',
      authKind: 'api_key',
    })).toBe(apiKey);
  });

  it('persists compatible inactive bindings with an authoritative revision', async () => {
    const saved = await service.saveApiKey({
      providerId: 'openai',
      apiKey: 'sk-openai-test-secret',
      acknowledgement: { generalWarningVersion: AI_GENERAL_COST_WARNING.version },
    });
    if (!saved.ok) throw new Error('Expected connection save');
    const connectionId = saved.snapshot.connections[0]!.connectionId;

    const result = await service.replaceBindings({
      expectedRevision: 0,
      bindings: [{
        bindingId: randomUUID(),
        connectionId,
        role: 'coding',
        operationId: 'openai_codex',
        modelProfile: 'provider_default',
        enabled: false,
        position: 0,
        revision: 1,
      }],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.snapshot.bindingRevision).toBe(1);
      expect(result.snapshot.bindings[0]).toMatchObject({
        role: 'coding',
        enabled: false,
        revision: 1,
      });
    }
  });

  it('deletes only one connection, its acknowledgement, credential, and bindings', async () => {
    const openai = await service.saveApiKey({
      providerId: 'openai',
      apiKey: 'sk-openai-test-secret',
      acknowledgement: { generalWarningVersion: AI_GENERAL_COST_WARNING.version },
    });
    const perplexity = await service.saveApiKey({
      providerId: 'perplexity',
      apiKey: 'pplx-test-secret',
      acknowledgement: { generalWarningVersion: AI_GENERAL_COST_WARNING.version },
    });
    if (!openai.ok || !perplexity.ok) throw new Error('Expected connection saves');
    const openaiId = perplexity.snapshot.connections.find(
      (connection) => connection.providerId === 'openai',
    )!.connectionId;
    const perplexityId = perplexity.snapshot.connections.find(
      (connection) => connection.providerId === 'perplexity',
    )!.connectionId;
    await service.replaceBindings({
      expectedRevision: 0,
      bindings: [{
        bindingId: randomUUID(),
        connectionId: openaiId,
        role: 'text',
        operationId: 'openai_responses_text',
        modelProfile: 'provider_default',
        enabled: false,
        position: 0,
        revision: 1,
      }],
    });

    const deleted = await service.deleteConnection({ connectionId: openaiId });

    expect(deleted.ok).toBe(true);
    if (!deleted.ok) throw new Error('Expected deletion');
    expect(deleted.snapshot.connections.map((connection) => connection.providerId)).toEqual([
      'perplexity',
    ]);
    expect(deleted.snapshot.bindings).toEqual([]);
    expect(credentials.read({
      connectionId: perplexityId,
      providerId: 'perplexity',
      authKind: 'api_key',
    })).toBe('pplx-test-secret');
  });

  it('never restores a revoked credential when metadata deletion cannot be published', async () => {
    const metadataStore = new AiProviderHubStore(tmpDir);
    const isolatedService = new AiProviderHubService(metadataStore, credentials, {
      now: () => now,
      createId: () => randomUUID(),
    });
    const saved = await isolatedService.saveApiKey({
      providerId: 'openai',
      apiKey: 'sk-openai-rollback-secret',
      acknowledgement: { generalWarningVersion: AI_GENERAL_COST_WARNING.version },
    });
    if (!saved.ok) throw new Error('Expected connection save');
    const connection = saved.snapshot.connections[0]!;
    vi.spyOn(metadataStore, 'deleteConnection').mockImplementation(() => {
      throw new Error('simulated metadata write failure');
    });

    const deleted = await isolatedService.deleteConnection({
      connectionId: connection.connectionId,
    });

    expect(deleted).toMatchObject({ ok: false, code: 'storage_degraded' });
    expect(credentials.read({
      connectionId: connection.connectionId,
      providerId: connection.providerId,
      authKind: connection.authKind,
    })).toBeUndefined();
    expect(isolatedService.snapshot().connections).toHaveLength(1);
  });

  it('reconciles a deletion committed through the metadata backup without restoring an orphan', async () => {
    let injectFailure = false;
    const metadataStore = new AiProviderHubStore(tmpDir, (point) => {
      if (injectFailure && point === 'after-backup-publish') {
        throw new Error('simulated late metadata write failure');
      }
    });
    const isolatedService = new AiProviderHubService(metadataStore, credentials, {
      now: () => now,
      createId: () => randomUUID(),
    });
    const saved = await isolatedService.saveApiKey({
      providerId: 'openai',
      apiKey: 'sk-openai-delete-reconcile',
      acknowledgement: { generalWarningVersion: AI_GENERAL_COST_WARNING.version },
    });
    if (!saved.ok) throw new Error('Expected connection save');
    const connection = saved.snapshot.connections[0]!;
    injectFailure = true;

    const deleted = await isolatedService.deleteConnection({
      connectionId: connection.connectionId,
    });

    expect(deleted.ok).toBe(true);
    expect(isolatedService.snapshot().connections).toEqual([]);
    expect(credentials.read({
      connectionId: connection.connectionId,
      providerId: connection.providerId,
      authKind: connection.authKind,
    })).toBeUndefined();
  });

  it('keeps a newly saved credential when metadata was committed through the backup', async () => {
    const metadataStore = new AiProviderHubStore(tmpDir, (point) => {
      if (point === 'after-backup-publish') throw new Error('simulated late metadata write failure');
    });
    const isolatedService = new AiProviderHubService(metadataStore, credentials, {
      now: () => now,
      createId: () => randomUUID(),
    });

    const saved = await isolatedService.saveApiKey({
      providerId: 'openai',
      apiKey: 'sk-openai-save-reconcile',
      acknowledgement: { generalWarningVersion: AI_GENERAL_COST_WARNING.version },
    });

    expect(saved.ok).toBe(true);
    if (!saved.ok) throw new Error('Expected reconciled connection save');
    const connection = saved.snapshot.connections[0]!;
    expect(credentials.read({
      connectionId: connection.connectionId,
      providerId: connection.providerId,
      authKind: connection.authKind,
    })).toBe('sk-openai-save-reconcile');
  });

  it('requires renewed warning acknowledgement before a connection can be bound', async () => {
    const metadataStore = new AiProviderHubStore(tmpDir);
    const isolatedService = new AiProviderHubService(metadataStore, credentials, {
      now: () => now,
      createId: () => randomUUID(),
    });
    const saved = await isolatedService.saveApiKey({
      providerId: 'openai',
      apiKey: 'sk-openai-stale-warning',
      acknowledgement: { generalWarningVersion: AI_GENERAL_COST_WARNING.version },
    });
    if (!saved.ok) throw new Error('Expected connection save');
    const stored = metadataStore.snapshot();
    const connection = stored.connections[0]!;
    expect(isolatedService.resolveRecoveryCredential(connection.connectionId, 'openai', connection.credentialGeneration ?? 1)).toBe('sk-openai-stale-warning');
    metadataStore.upsertConnection({
      ...connection,
      acknowledgement: { generalWarningVersion: 'old-warning' },
    }, stored.generation);

    const current = isolatedService.snapshot();
    expect(isolatedService.resolveRecoveryCredential(connection.connectionId, 'openai', connection.credentialGeneration ?? 1)).toBeNull();
    expect(current.connections[0]?.health.message).toContain('aktualisiert');
    const result = await isolatedService.replaceBindings({
      expectedRevision: current.bindingRevision,
      bindings: [{
        bindingId: randomUUID(),
        connectionId: connection.connectionId,
        role: 'text',
        operationId: 'openai_responses_text',
        modelProfile: 'provider_default',
        enabled: true,
        position: 0,
        revision: 1,
      }],
    });

    expect(result).toMatchObject({ ok: false, code: 'stale_acknowledgement' });
  });

  it('renews warning acknowledgement without replacing the stored credential', async () => {
    const metadataStore = new AiProviderHubStore(tmpDir);
    const isolatedService = new AiProviderHubService(metadataStore, credentials, {
      now: () => now,
      createId: () => randomUUID(),
    });
    const saved = await isolatedService.saveApiKey({
      providerId: 'openai',
      apiKey: 'sk-openai-ack-only-secret',
      acknowledgement: { generalWarningVersion: AI_GENERAL_COST_WARNING.version },
    });
    if (!saved.ok) throw new Error('Expected connection save');
    const stored = metadataStore.snapshot();
    const connection = stored.connections[0]!;
    metadataStore.upsertConnection({
      ...connection,
      acknowledgement: { generalWarningVersion: 'old-warning' },
    }, stored.generation);
    now += 1_000;

    const acknowledged = await isolatedService.acknowledgeWarnings({
      connectionId: connection.connectionId,
      acknowledgement: { generalWarningVersion: AI_GENERAL_COST_WARNING.version },
    });

    expect(acknowledged.ok).toBe(true);
    expect(credentials.read({
      connectionId: connection.connectionId,
      providerId: connection.providerId,
      authKind: connection.authKind,
    })).toBe('sk-openai-ack-only-secret');
    expect(isolatedService.snapshot().connections[0]?.health.message).toBeUndefined();
  });

  it('returns a truthful no-adapter result without changing the saved state', async () => {
    const saved = await service.saveApiKey({
      providerId: 'openai',
      apiKey: 'sk-openai-test-secret',
      acknowledgement: { generalWarningVersion: AI_GENERAL_COST_WARNING.version },
    });
    if (!saved.ok) throw new Error('Expected connection save');

    const checked = await service.checkHealth({
      connectionId: saved.snapshot.connections[0]!.connectionId,
    });

    expect(checked).toMatchObject({ ok: false, code: 'health_adapter_unavailable' });
    expect(checked.snapshot?.connections[0]?.health.state).toBe('credential_saved_unverified');
  });

  it('serializes concurrent replacement of the same provider connection', async () => {
    const input = (apiKey: string) => ({
      providerId: 'openai' as const,
      apiKey,
      acknowledgement: { generalWarningVersion: AI_GENERAL_COST_WARNING.version },
    });

    const [first, second] = await Promise.all([
      service.saveApiKey(input('sk-first-test-secret')),
      service.saveApiKey(input('sk-second-test-secret')),
    ]);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(service.snapshot().connections).toHaveLength(1);
  });
});
