import { describe, expect, it, vi } from 'vitest';
import type {
  AiConnectionHealthState,
  AiConnectionSnapshot,
  AiHubMutationResult,
  AiProviderHubSnapshot,
  AiProviderId,
  AiRoleBinding,
  SaveAiApiKeyInput,
} from '../../../../../src/core/ai-provider-contract.js';
import type { SarahAiProvidersApi } from '../../../../../src/core/sarah-api.js';
import {
  AI_GENERAL_COST_WARNING,
  AI_PROVIDER_CATALOG,
} from '../../../../../src/services/integrations/ai-provider-catalog.js';
import {
  buildAcknowledgeWarningsInput,
  buildReplaceBindingsInput,
  buildSaveApiKeyInput,
  compatibleBindingOptions,
  deleteAiConnection,
  moveRoleBinding,
  orderRoleBindings,
  providerWarnings,
  requiresWarningAcknowledgement,
  submitApiKey,
  submitWarningAcknowledgement,
  submitRoleBindings,
  toAiProviderCardView,
} from '../../../../../src/renderer/dashboard/views/sections/ai-provider-section-logic.js';

const OPENAI_ID = '11111111-1111-4111-8111-111111111111';
const ANTHROPIC_ID = '22222222-2222-4222-8222-222222222222';
const BINDING_ONE = '33333333-3333-4333-8333-333333333333';
const BINDING_TWO = '44444444-4444-4444-8444-444444444444';
const BINDING_THREE = '55555555-5555-4555-8555-555555555555';

function connection(
  providerId: AiProviderId,
  connectionId: string,
  state: AiConnectionHealthState = 'credential_saved_unverified',
): AiConnectionSnapshot {
  const provider = AI_PROVIDER_CATALOG.find((entry) => entry.id === providerId)!;
  return {
    connectionId,
    providerId,
    authKind: 'api_key',
    displayLabel: `${provider.displayName} API`,
    hasCredential: state !== 'not_configured' && state !== 'storage_degraded',
    acknowledgement: {
      generalWarningVersion: provider.generalWarningVersion,
      ...(provider.providerWarning
        ? { providerWarningVersion: provider.providerWarning.version }
        : {}),
    },
    health: { state },
    createdAt: '2026-09-04T12:00:00.000Z',
    updatedAt: '2026-09-04T12:00:00.000Z',
  };
}

function snapshot(overrides: Partial<AiProviderHubSnapshot> = {}): AiProviderHubSnapshot {
  return {
    generalWarning: AI_GENERAL_COST_WARNING,
    catalog: AI_PROVIDER_CATALOG,
    connections: [
      connection('openai', OPENAI_ID),
      connection('anthropic', ANTHROPIC_ID),
    ],
    bindings: [],
    bindingRevision: 4,
    storage: { state: 'ready' },
    ...overrides,
  };
}

function apiWith(
  mutations: {
    save?: (input: SaveAiApiKeyInput) => Promise<AiHubMutationResult>;
    remove?: (input: { connectionId: string }) => Promise<AiHubMutationResult>;
    bindings?: SarahAiProvidersApi['replaceBindings'];
    acknowledge?: SarahAiProvidersApi['acknowledgeWarnings'];
  } = {},
): SarahAiProvidersApi {
  return {
    list: vi.fn(async () => snapshot()),
    saveApiKey: vi.fn(mutations.save ?? (async () => ({ ok: true, snapshot: snapshot() }))),
    acknowledgeWarnings: vi.fn(
      mutations.acknowledge ?? (async () => ({ ok: true, snapshot: snapshot() })),
    ),
    deleteConnection: vi.fn(mutations.remove ?? (async () => ({ ok: true, snapshot: snapshot() }))),
    replaceBindings: vi.fn(mutations.bindings ?? (async () => ({ ok: true, snapshot: snapshot() }))),
    checkHealth: vi.fn(async () => ({
      ok: false,
      code: 'health_adapter_unavailable',
      message: 'Die technische Prüfung folgt mit dem Anbieteradapter.',
    })),
  };
}

describe('AI provider card view', () => {
  it('distinguishes absent, unverified, healthy, and invalid credentials truthfully', () => {
    const base = snapshot();
    const openai = base.catalog[0];
    const perplexity = base.catalog[2];
    expect(toAiProviderCardView(base, perplexity)).toMatchObject({
      badgeText: 'Nicht verbunden',
      badgeState: 'disconnected',
    });
    expect(toAiProviderCardView(base, openai)).toMatchObject({
      badgeText: 'Gespeichert, ungeprüft',
      badgeState: 'pending',
    });

    const healthy = snapshot({ connections: [connection('openai', OPENAI_ID, 'healthy')] });
    expect(toAiProviderCardView(healthy, openai)).toMatchObject({
      badgeText: 'Verifiziert',
      badgeState: 'connected',
    });
    const invalid = snapshot({ connections: [connection('openai', OPENAI_ID, 'invalid_credentials')] });
    expect(toAiProviderCardView(invalid, openai)).toMatchObject({
      badgeText: 'Zugangsdaten ungültig',
      badgeState: 'error',
    });
  });

  it('fails closed when the hub storage is degraded', () => {
    const degraded = snapshot({ storage: { state: 'degraded', message: 'Nicht lesbar.' } });
    expect(toAiProviderCardView(degraded, degraded.catalog[0])).toMatchObject({
      badgeText: 'Speicherfehler',
      badgeState: 'error',
      mutationsDisabled: true,
      statusMessage: 'Nicht lesbar.',
    });
  });

  it('selects the general warning for every provider and the extra warning only for Anthropic', () => {
    const current = snapshot();
    expect(providerWarnings(current, current.catalog[0])).toEqual([
      { ...current.generalWarning, kind: 'general' },
    ]);
    expect(providerWarnings(current, current.catalog[1])).toEqual([
      { ...current.generalWarning, kind: 'general' },
      { ...current.catalog[1].providerWarning!, kind: 'provider' },
    ]);
  });
});

describe('AI provider key actions', () => {
  it('gates submission on a valid key and every displayed warning version', () => {
    const current = snapshot();
    const openai = current.catalog[0];
    const anthropic = current.catalog[1];
    expect(buildSaveApiKeyInput(current, openai, 'short', true, false)).toBeNull();
    expect(buildSaveApiKeyInput(current, openai, 'openai-key', false, false)).toBeNull();
    expect(buildSaveApiKeyInput(current, anthropic, 'anthropic-key', true, false)).toBeNull();
    expect(buildSaveApiKeyInput(current, anthropic, 'anthropic-key', true, true)).toEqual({
      providerId: 'anthropic',
      apiKey: 'anthropic-key',
      acknowledgement: {
        generalWarningVersion: current.generalWarning.version,
        providerWarningVersion: anthropic.providerWarning!.version,
      },
    });

    const stale = snapshot({
      generalWarning: { ...current.generalWarning, version: '2026-09-04.v2' },
    });
    expect(buildSaveApiKeyInput(stale, openai, 'openai-key', true, false)).toBeNull();
  });

  it.each([
    {
      label: 'success',
      result: { ok: true, snapshot: snapshot() } satisfies AiHubMutationResult,
      expected: true,
    },
    {
      label: 'service failure',
      result: {
        ok: false,
        code: 'operation_failed',
        message: 'Sicher fehlgeschlagen.',
      } satisfies AiHubMutationResult,
      expected: false,
    },
  ])('clears the key field after $label', async ({ result, expected }) => {
    const providerApi = apiWith({ save: async () => result });
    const clear = vi.fn();
    const input = buildSaveApiKeyInput(snapshot(), snapshot().catalog[0], 'openai-key', true, false)!;

    const outcome = await submitApiKey(providerApi, input, clear);

    expect(outcome.ok).toBe(expected);
    expect(clear).toHaveBeenCalledOnce();
  });

  it('clears the key and returns a fixed message after an IPC rejection', async () => {
    const providerApi = apiWith({ save: async () => { throw new Error('raw secret detail'); } });
    const clear = vi.fn();
    const current = snapshot();
    const input = buildSaveApiKeyInput(current, current.catalog[0], 'openai-key', true, false)!;

    const outcome = await submitApiKey(providerApi, input, clear);

    expect(outcome).toEqual({
      ok: false,
      message: 'Die KI-Einstellungen konnten gerade nicht sicher geändert werden.',
    });
    expect(clear).toHaveBeenCalledOnce();
  });

  it('deletes only the explicitly confirmed connection id', async () => {
    const providerApi = apiWith();
    const outcome = await deleteAiConnection(providerApi, OPENAI_ID);
    expect(providerApi.deleteConnection).toHaveBeenCalledWith({ connectionId: OPENAI_ID });
    expect(outcome.ok).toBe(true);
  });

  it('builds and submits an acknowledgement-only update for a stale connection', async () => {
    const staleConnection = {
      ...connection('openai', OPENAI_ID),
      acknowledgement: { generalWarningVersion: 'old-warning' },
    };
    const current = snapshot({ connections: [staleConnection] });
    const provider = current.catalog[0];
    expect(requiresWarningAcknowledgement(provider, staleConnection)).toBe(true);
    const input = buildAcknowledgeWarningsInput(current, provider, true, false);
    expect(input).toEqual({
      connectionId: OPENAI_ID,
      acknowledgement: { generalWarningVersion: provider.generalWarningVersion },
    });
    const providerApi = apiWith();

    const outcome = await submitWarningAcknowledgement(providerApi, input!);

    expect(providerApi.acknowledgeWarnings).toHaveBeenCalledWith(input);
    expect(outcome).toMatchObject({ ok: true, message: 'Kostenhinweise erneut bestätigt.' });
  });
});

describe('AI role bindings', () => {
  const textFallback: AiRoleBinding = {
    bindingId: BINDING_TWO,
    connectionId: ANTHROPIC_ID,
    role: 'text',
    operationId: 'anthropic_messages_text',
    modelProfile: 'provider_default',
    enabled: false,
    position: 8,
    revision: 4,
  };
  const textStandard: AiRoleBinding = {
    bindingId: BINDING_ONE,
    connectionId: OPENAI_ID,
    role: 'text',
    operationId: 'openai_responses_text',
    modelProfile: 'provider_default',
    enabled: true,
    position: 2,
    revision: 4,
  };
  const codingStandard: AiRoleBinding = {
    bindingId: BINDING_THREE,
    connectionId: OPENAI_ID,
    role: 'coding',
    operationId: 'openai_codex',
    modelProfile: 'provider_default',
    enabled: true,
    position: 7,
    revision: 4,
  };

  it('derives only connected catalog operations compatible with a role', () => {
    const current = snapshot();
    expect(compatibleBindingOptions(current, 'text').map((option) => option.operationId)).toEqual([
      'openai_responses_text',
      'anthropic_messages_text',
    ]);
    expect(compatibleBindingOptions(current, 'coding').map((option) => option.operationId)).toEqual([
      'openai_codex',
      'anthropic_claude_agent',
    ]);
    expect(compatibleBindingOptions(current, 'research').map((option) => option.operationId)).toEqual([
      'openai_deep_research',
    ]);
  });

  it('does not offer a connection whose cost acknowledgement is stale', () => {
    const staleOpenAi = {
      ...connection('openai', OPENAI_ID),
      acknowledgement: { generalWarningVersion: 'old-warning' },
    };
    const current = snapshot({ connections: [staleOpenAi] });

    expect(compatibleBindingOptions(current, 'text')).toEqual([]);
    expect(buildReplaceBindingsInput(current, [textStandard])).toBeNull();
  });

  it('orders roles deterministically and compacts standard/fallback positions', () => {
    expect(orderRoleBindings([codingStandard, textFallback, textStandard])).toEqual([
      { ...textStandard, position: 0 },
      { ...textFallback, position: 1 },
      { ...codingStandard, position: 0 },
    ]);
  });

  it('moves a fallback to standard without changing another role', () => {
    expect(moveRoleBinding([textStandard, textFallback, codingStandard], 'text', 1, -1)).toEqual([
      { ...textFallback, position: 0 },
      { ...textStandard, position: 1 },
      { ...codingStandard, position: 0 },
    ]);
  });

  it('builds a full revision-bound replacement with fixed provider_default profiles', () => {
    const current = snapshot();
    expect(buildReplaceBindingsInput(current, [codingStandard, textFallback, textStandard])).toEqual({
      bindings: [
        { ...textStandard, position: 0 },
        { ...textFallback, position: 1 },
        { ...codingStandard, position: 0 },
      ],
      expectedRevision: 4,
    });
  });

  it('rejects duplicate choices and provider-incompatible operations', () => {
    const current = snapshot();
    expect(buildReplaceBindingsInput(current, [
      textStandard,
      { ...textStandard, bindingId: BINDING_TWO, position: 1 },
    ])).toBeNull();
    expect(buildReplaceBindingsInput(current, [
      { ...textStandard, operationId: 'anthropic_messages_text' },
    ])).toBeNull();
  });

  it('submits the complete replacement and reports the service snapshot', async () => {
    const current = snapshot();
    const input = buildReplaceBindingsInput(current, [textStandard])!;
    const providerApi = apiWith();
    const outcome = await submitRoleBindings(providerApi, input);
    expect(providerApi.replaceBindings).toHaveBeenCalledWith(input);
    expect(outcome).toMatchObject({ ok: true, message: 'Rollenbindungen gespeichert.' });
  });

  it('keeps a fresh service snapshot on a revision conflict', async () => {
    const fresh = snapshot({ bindingRevision: 5 });
    const providerApi = apiWith({
      bindings: async () => ({
        ok: false,
        code: 'revision_conflict',
        message: 'Bitte neu laden.',
        snapshot: fresh,
      }),
    });
    const input = buildReplaceBindingsInput(snapshot(), [textStandard])!;

    const outcome = await submitRoleBindings(providerApi, input);

    expect(outcome).toMatchObject({ ok: false, snapshot: { bindingRevision: 5 } });
  });
});
