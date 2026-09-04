import { describe, expect, it } from 'vitest';
import {
  AI_PROVIDER_IDS,
  AI_PROVIDER_OPERATION_IDS,
} from '../../../src/core/ai-provider-contract.js';
import {
  AI_GENERAL_COST_WARNING,
  AI_PROVIDER_CATALOG,
  ANTHROPIC_COST_WARNING,
  getAiProviderCatalogEntry,
} from '../../../src/services/integrations/ai-provider-catalog.js';

describe('AI provider catalog', () => {
  it('contains each fixed provider and operation exactly once', () => {
    expect(AI_PROVIDER_CATALOG.map((entry) => entry.id)).toEqual(AI_PROVIDER_IDS);
    expect(AI_PROVIDER_CATALOG.flatMap((entry) => (
      entry.operations.map((operation) => operation.id)
    ))).toEqual(AI_PROVIDER_OPERATION_IDS);
    expect(new Set(AI_PROVIDER_CATALOG.map((entry) => entry.id)).size).toBe(3);
  });

  it('uses the exact approved provider/role matrix', () => {
    expect(AI_PROVIDER_CATALOG.map((entry) => ({
      provider: entry.id,
      operations: entry.operations.map(({ id, role }) => ({ id, role })),
    }))).toEqual([
      {
        provider: 'openai',
        operations: [
          { id: 'openai_responses_text', role: 'text' },
          { id: 'openai_deep_research', role: 'research' },
          { id: 'openai_codex', role: 'coding' },
        ],
      },
      {
        provider: 'anthropic',
        operations: [
          { id: 'anthropic_messages_text', role: 'text' },
          { id: 'anthropic_claude_agent', role: 'coding' },
        ],
      },
      {
        provider: 'perplexity',
        operations: [{ id: 'perplexity_agent_research', role: 'research' }],
      },
    ]);
  });

  it('contains the exact approved German warnings and versions', () => {
    expect(AI_GENERAL_COST_WARNING).toEqual({
      version: '2026-09-04.v1',
      title: '⚠️ Separate API-Kosten',
      text: 'Dein bestehendes Abo bei diesem Anbieter kann nicht in Sarah verwendet werden. Sarah nutzt die jeweilige kostenpflichtige API. Dadurch können – insbesondere bei Claude und Perplexity – deutlich höhere Kosten als beim normalen Monatsabo entstehen. Bitte prüfe vor der Verbindung die aktuellen API-Preise und setze ein Ausgabenlimit.',
    });
    expect(ANTHROPIC_COST_WARNING.text).toBe(
      'Claude kann in Sarah derzeit nur über die kostenpflichtige Anthropic API verwendet werden. Dein bestehendes Claude Pro- oder Max-Abonnement kann dafür nicht genutzt werden.\n\nBei intensiver Nutzung können die API-Kosten – insbesondere mit Claude Opus – ein Vielfaches der Kosten eines vergleichbaren Claude-Abonnements betragen (typischerweise etwa 5–10×, abhängig von der Nutzung).\n\nWir empfehlen daher, vor der Verbindung die aktuellen API-Preise und ein Ausgabenlimit bei Anthropic zu prüfen.',
    );
    expect(getAiProviderCatalogEntry('anthropic').providerWarning).toEqual(ANTHROPIC_COST_WARNING);
    expect(getAiProviderCatalogEntry('openai').providerWarning).toBeUndefined();
    expect(getAiProviderCatalogEntry('perplexity').providerWarning).toBeUndefined();
  });

  it('is deeply immutable', () => {
    expect(Object.isFrozen(AI_PROVIDER_CATALOG)).toBe(true);
    for (const entry of AI_PROVIDER_CATALOG) {
      expect(Object.isFrozen(entry)).toBe(true);
      expect(Object.isFrozen(entry.authKinds)).toBe(true);
      expect(Object.isFrozen(entry.operations)).toBe(true);
      expect(Object.isFrozen(entry.helpLinks)).toBe(true);
      expect(entry.operations.every(Object.isFrozen)).toBe(true);
    }
  });

  it('uses only fixed official HTTPS help hosts', () => {
    const hosts: Record<string, readonly string[]> = {
      openai: ['developers.openai.com', 'platform.openai.com'],
      anthropic: ['platform.claude.com'],
      perplexity: ['docs.perplexity.ai', 'www.perplexity.ai'],
    };
    for (const entry of AI_PROVIDER_CATALOG) {
      for (const value of Object.values(entry.helpLinks)) {
        const url = new URL(value);
        expect(url.protocol).toBe('https:');
        expect(hosts[entry.id]).toContain(url.hostname);
      }
    }
  });
});
