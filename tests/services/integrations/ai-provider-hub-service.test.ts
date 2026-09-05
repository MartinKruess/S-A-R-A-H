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

  it('restores the credential when metadata deletion cannot be published', async () => {
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

    expect(deleted).toMatchObject({ ok: false, code: 'operation_failed' });
    expect(credentials.read({
      connectionId: connection.connectionId,
      providerId: connection.providerId,
      authKind: connection.authKind,
    })).toBe('sk-openai-rollback-secret');
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
    metadataStore.upsertConnection({
      ...connection,
      acknowledgement: { generalWarningVersion: 'old-warning' },
    }, stored.generation);

    const current = isolatedService.snapshot();
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
