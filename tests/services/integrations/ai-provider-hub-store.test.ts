import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AiProviderId, AiProviderRole } from '../../../src/core/ai-provider-contract.js';
import {
  AiProviderHubStore,
  AiProviderHubStoreDegradedError,
  AiProviderHubStoreOperationError,
  AiProviderHubStoreRevisionConflictError,
  AiProviderHubStoreValidationError,
  type AiProviderConnectionMetadata,
  type AiRoleBindingDraft,
} from '../../../src/services/integrations/ai-provider-hub-store.js';

const GENERAL_WARNING = '2026-09-04.v1';
const CREATED_AT = '2026-09-04T08:00:00.000Z';
const UPDATED_AT = '2026-09-04T09:00:00.000Z';

function connection(
  providerId: AiProviderId,
  overrides: Partial<AiProviderConnectionMetadata> = {},
): AiProviderConnectionMetadata {
  return {
    connectionId: randomUUID(),
    providerId,
    authKind: 'api_key',
    displayLabel: `${providerId} API`,
    acknowledgement: {
      generalWarningVersion: GENERAL_WARNING,
      ...(providerId === 'anthropic' ? { providerWarningVersion: GENERAL_WARNING } : {}),
    },
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
    ...overrides,
  };
}

function binding(
  connectionId: string,
  role: AiProviderRole,
  position: number,
  overrides: Partial<AiRoleBindingDraft> = {},
): AiRoleBindingDraft {
  const operationId = role === 'text'
    ? 'openai_responses_text'
    : role === 'coding'
      ? 'openai_codex'
      : 'openai_deep_research';
  return {
    bindingId: randomUUID(),
    connectionId,
    role,
    operationId,
    modelProfile: 'provider_default',
    enabled: true,
    position,
    ...overrides,
  };
}

describe('AiProviderHubStore', () => {
  let tmpDir: string;
  const primary = (): string => path.join(tmpDir, 'ai-provider-hub.json');
  const backup = (): string => `${primary()}.bak`;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sarah-ai-hub-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it.each(['codex_managed_chatgpt', 'chatgptAuthTokens', 'claude_oauth', 'session_cookie'])(
    'does not activate %s by injecting a saved auth kind', (authKind) => {
      const original = connection('openai');
      const writer = new AiProviderHubStore(tmpDir);
      const valid = writer.upsertConnection(original, 0);
      expect(new AiProviderHubStore(tmpDir).getStatus().state).toBe('ready');
      const invalid = JSON.stringify({
        ...valid,
        connections: [{ ...original, authKind }],
      });
      fs.writeFileSync(primary(), invalid, 'utf-8');
      fs.writeFileSync(backup(), invalid, 'utf-8');
      const store = new AiProviderHubStore(tmpDir);
      expect(store.getStatus().state).toBe('degraded');
      expect(store.snapshot().connections).toEqual([]);
    },
  );

  it('starts empty and persists only strict non-secret metadata in matching copies', () => {
    const store = new AiProviderHubStore(tmpDir);
    const empty = store.snapshot();
    expect(empty).toMatchObject({
      schemaVersion: 1,
      generation: 0,
      connections: [],
      bindings: [],
      bindingRevision: 0,
    });
    expect(store.getStatus()).toEqual({ state: 'ready' });

    const openai = connection('openai');
    const saved = store.upsertConnection(openai, empty.generation);
    const bound = store.replaceBindings(
      [binding(openai.connectionId, 'text', 0)],
      saved.bindingRevision,
      saved.generation,
    );

    expect(bound.generation).toBe(2);
    expect(bound.bindingRevision).toBe(1);
    expect(bound.bindings[0]?.revision).toBe(1);
    expect(Object.isFrozen(bound)).toBe(true);
    expect(Object.isFrozen(bound.connections)).toBe(true);
    expect(Object.isFrozen(bound.bindings)).toBe(true);
    expect(fs.readFileSync(primary(), 'utf-8')).toBe(fs.readFileSync(backup(), 'utf-8'));
    const serialized = fs.readFileSync(primary(), 'utf-8');
    expect(serialized).not.toMatch(/apiKey|credential|health|catalog|secret/iu);
  });

  it('recovers from one corrupt or missing copy and selects an interrupted newer backup', () => {
    const first = connection('openai');
    const store = new AiProviderHubStore(tmpDir);
    store.upsertConnection(first, 0);
    fs.writeFileSync(primary(), '{broken', 'utf-8');

    const recovered = new AiProviderHubStore(tmpDir);
    expect(recovered.snapshot().connections).toEqual([first]);
    expect(recovered.getStatus()).toEqual({
      state: 'recovered',
      message: 'Die neueste gültige KI-Anbieter-Konfiguration wurde aus einer sicheren Kopie geladen.',
    });

    const secondDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sarah-ai-hub-interrupted-'));
    try {
      const interrupted = new AiProviderHubStore(secondDir, (point) => {
        if (point === 'after-backup-publish') throw new Error('raw injected failure');
      });
      expect(() => interrupted.upsertConnection(first, 0)).toThrow(AiProviderHubStoreOperationError);
      expect(() => interrupted.upsertConnection(first, 0)).toThrow(
        'Die KI-Anbieter-Konfiguration wurde zwischenzeitlich geändert.',
      );
      const afterCrash = new AiProviderHubStore(secondDir);
      expect(afterCrash.snapshot()).toMatchObject({ generation: 1, connections: [first] });
      expect(afterCrash.getStatus().state).toBe('recovered');
    } finally {
      fs.rmSync(secondDir, { recursive: true, force: true });
    }
  });

  it('fails closed for invalid strict snapshots and conflicting same-generation commits', () => {
    const invalid = JSON.stringify({
      schemaVersion: 1,
      generation: 1,
      commitId: randomUUID(),
      connections: [],
      bindings: [],
      bindingRevision: 0,
      credential: 'must-not-be-accepted',
    });
    fs.writeFileSync(primary(), invalid, 'utf-8');
    fs.writeFileSync(backup(), invalid, 'utf-8');
    const invalidStore = new AiProviderHubStore(tmpDir);
    expect(invalidStore.snapshot().connections).toEqual([]);
    expect(invalidStore.getStatus()).toEqual({
      state: 'degraded',
      message: 'Die KI-Anbieter-Konfiguration ist beschädigt und bleibt unverändert.',
    });
    expect(() => invalidStore.upsertConnection(connection('openai'), 0))
      .toThrow(AiProviderHubStoreDegradedError);

    const conflictDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sarah-ai-hub-conflict-'));
    try {
      const conflictStore = new AiProviderHubStore(conflictDir);
      conflictStore.upsertConnection(connection('openai'), 0);
      const conflicting = JSON.parse(fs.readFileSync(
        path.join(conflictDir, 'ai-provider-hub.json.bak'),
        'utf-8',
      )) as { commitId: string };
      conflicting.commitId = randomUUID();
      fs.writeFileSync(
        path.join(conflictDir, 'ai-provider-hub.json.bak'),
        JSON.stringify(conflicting),
        'utf-8',
      );
      const degraded = new AiProviderHubStore(conflictDir);
      expect(degraded.getStatus().state).toBe('degraded');
      expect(() => degraded.replaceBindings([], 0, 0)).toThrow(AiProviderHubStoreDegradedError);
    } finally {
      fs.rmSync(conflictDir, { recursive: true, force: true });
    }
  });

  it('enforces provider uniqueness, provider-warning shape and ordered timestamps', () => {
    const store = new AiProviderHubStore(tmpDir);
    const openai = connection('openai');
    const saved = store.upsertConnection(openai, 0);

    expect(() => store.upsertConnection(connection('openai'), saved.generation))
      .toThrow(AiProviderHubStoreValidationError);
    expect(() => store.upsertConnection(connection('anthropic', {
      acknowledgement: { generalWarningVersion: GENERAL_WARNING },
    }), saved.generation)).toThrow(AiProviderHubStoreValidationError);
    expect(() => store.upsertConnection(connection('perplexity', {
      acknowledgement: {
        generalWarningVersion: GENERAL_WARNING,
        providerWarningVersion: GENERAL_WARNING,
      },
    }), saved.generation)).toThrow(AiProviderHubStoreValidationError);
    const staleButReadable = store.upsertConnection(connection('perplexity', {
      acknowledgement: { generalWarningVersion: '2026-01-01.v1' },
    }), saved.generation);
    expect(staleButReadable.connections.find(
      (entry) => entry.providerId === 'perplexity',
    )?.acknowledgement.generalWarningVersion).toBe('2026-01-01.v1');
    expect(() => store.upsertConnection(connection('perplexity', {
      createdAt: UPDATED_AT,
      updatedAt: CREATED_AT,
    }), staleButReadable.generation)).toThrow(AiProviderHubStoreValidationError);
    expect(() => store.upsertConnection({
      ...openai,
      updatedAt: '2026-09-04T08:30:00.000Z',
    }, staleButReadable.generation)).toThrow(AiProviderHubStoreValidationError);
    expect(store.snapshot()).toEqual(staleButReadable);
  });

  it('rejects dangling, incompatible, duplicate and non-compact role bindings', () => {
    const store = new AiProviderHubStore(tmpDir);
    const openai = connection('openai');
    const anthropic = connection('anthropic');
    const savedOpenAi = store.upsertConnection(openai, 0);
    const saved = store.upsertConnection(anthropic, savedOpenAi.generation);

    expect(() => store.replaceBindings(
      [binding(randomUUID(), 'text', 0)],
      0,
      saved.generation,
    )).toThrow(AiProviderHubStoreValidationError);
    expect(() => store.replaceBindings(
      [binding(openai.connectionId, 'coding', 0, { operationId: 'openai_responses_text' })],
      0,
      saved.generation,
    )).toThrow(AiProviderHubStoreValidationError);
    expect(() => store.replaceBindings([
      binding(openai.connectionId, 'text', 0),
      binding(openai.connectionId, 'text', 0),
    ], 0, saved.generation)).toThrow(AiProviderHubStoreValidationError);
    expect(() => store.replaceBindings(
      [binding(openai.connectionId, 'text', 1)],
      0,
      saved.generation,
    )).toThrow(AiProviderHubStoreValidationError);
    expect(() => store.replaceBindings(
      [binding(anthropic.connectionId, 'text', 0)],
      0,
      saved.generation,
    )).toThrow(AiProviderHubStoreValidationError);
    const duplicateId = randomUUID();
    expect(() => store.replaceBindings([
      binding(openai.connectionId, 'text', 0, { bindingId: duplicateId }),
      binding(openai.connectionId, 'text', 1, { bindingId: duplicateId }),
    ], 0, saved.generation)).toThrow(AiProviderHubStoreValidationError);
    expect(store.snapshot()).toEqual(saved);
  });

  it('owns monotonic binding revisions and rejects optimistic conflicts', () => {
    const store = new AiProviderHubStore(tmpDir);
    const openai = connection('openai');
    const saved = store.upsertConnection(openai, 0);
    const first = store.replaceBindings(
      [binding(openai.connectionId, 'coding', 0)],
      0,
      saved.generation,
    );
    expect(first).toMatchObject({ bindingRevision: 1 });
    expect(first.bindings.map((entry) => entry.revision)).toEqual([1]);

    expect(() => store.replaceBindings([], 0, first.generation))
      .toThrow(AiProviderHubStoreRevisionConflictError);
    expect(() => store.replaceBindings([], 1, saved.generation))
      .toThrow(AiProviderHubStoreRevisionConflictError);

    const second = store.replaceBindings([], 1, first.generation);
    expect(second).toMatchObject({ bindingRevision: 2, bindings: [] });
  });

  it('removes dangling bindings atomically when a connection is deleted', () => {
    const store = new AiProviderHubStore(tmpDir);
    const openai = connection('openai');
    const anthropic = connection('anthropic');
    const first = store.upsertConnection(openai, 0);
    const second = store.upsertConnection(anthropic, first.generation);
    const bound = store.replaceBindings([
      binding(openai.connectionId, 'text', 0),
      binding(anthropic.connectionId, 'text', 1, {
        operationId: 'anthropic_messages_text',
      }),
    ], 0, second.generation);

    const deleted = store.deleteConnection(openai.connectionId, bound.generation);
    expect(deleted.connections).toEqual([anthropic]);
    expect(deleted.bindings).toHaveLength(1);
    expect(deleted.bindings[0]).toMatchObject({
      connectionId: anthropic.connectionId,
      role: 'text',
      position: 0,
      revision: 2,
    });
    expect(deleted.bindingRevision).toBe(2);
  });

  it('detects another store publication before overwriting it', () => {
    const firstStore = new AiProviderHubStore(tmpDir);
    const secondStore = new AiProviderHubStore(tmpDir);
    const initial = firstStore.snapshot();
    secondStore.snapshot();
    firstStore.upsertConnection(connection('openai'), initial.generation);

    expect(() => secondStore.upsertConnection(connection('anthropic'), initial.generation))
      .toThrow(AiProviderHubStoreRevisionConflictError);
    expect(secondStore.snapshot().connections[0]?.providerId).toBe('openai');
  });
});
