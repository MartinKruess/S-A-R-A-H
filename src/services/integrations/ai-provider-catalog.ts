import {
  AiProviderCatalogEntrySchema,
  type AiProviderCatalogEntry,
  type AiProviderId,
} from '../../core/ai-provider-contract.js';

export const AI_GENERAL_COST_WARNING = Object.freeze({
  version: '2026-09-04.v1',
  title: '⚠️ Separate API-Kosten',
  text: 'Dein bestehendes Abo bei diesem Anbieter kann nicht in Sarah verwendet werden. Sarah nutzt die jeweilige kostenpflichtige API. Dadurch können – insbesondere bei Claude und Perplexity – deutlich höhere Kosten als beim normalen Monatsabo entstehen. Bitte prüfe vor der Verbindung die aktuellen API-Preise und setze ein Ausgabenlimit.',
});

export const ANTHROPIC_COST_WARNING = Object.freeze({
  version: '2026-09-04.v1',
  title: '⚠️ Hinweis zu Claude',
  text: 'Claude kann in Sarah derzeit nur über die kostenpflichtige Anthropic API verwendet werden. Dein bestehendes Claude Pro- oder Max-Abonnement kann dafür nicht genutzt werden.\n\nBei intensiver Nutzung können die API-Kosten – insbesondere mit Claude Opus – ein Vielfaches der Kosten eines vergleichbaren Claude-Abonnements betragen (typischerweise etwa 5–10×, abhängig von der Nutzung).\n\nWir empfehlen daher, vor der Verbindung die aktuellen API-Preise und ein Ausgabenlimit bei Anthropic zu prüfen.',
});

const parsedCatalog = [
  {
    id: 'openai',
    displayName: 'OpenAI',
    authKinds: ['api_key'],
    operations: [
      { id: 'openai_responses_text', providerId: 'openai', role: 'text' },
      { id: 'openai_deep_research', providerId: 'openai', role: 'research' },
      { id: 'openai_codex', providerId: 'openai', role: 'coding' },
    ],
    generalWarningVersion: AI_GENERAL_COST_WARNING.version,
    helpLinks: {
      pricing: 'https://developers.openai.com/api/docs/pricing',
      spendingLimits: 'https://platform.openai.com/settings/organization/limits',
    },
  },
  {
    id: 'anthropic',
    displayName: 'Anthropic',
    authKinds: ['api_key'],
    operations: [
      { id: 'anthropic_messages_text', providerId: 'anthropic', role: 'text' },
      { id: 'anthropic_claude_agent', providerId: 'anthropic', role: 'coding' },
    ],
    generalWarningVersion: AI_GENERAL_COST_WARNING.version,
    providerWarning: ANTHROPIC_COST_WARNING,
    helpLinks: {
      pricing: 'https://platform.claude.com/docs/en/about-claude/pricing',
      spendingLimits: 'https://platform.claude.com/settings/limits',
    },
  },
  {
    id: 'perplexity',
    displayName: 'Perplexity',
    authKinds: ['api_key'],
    operations: [
      { id: 'perplexity_agent_research', providerId: 'perplexity', role: 'research' },
    ],
    generalWarningVersion: AI_GENERAL_COST_WARNING.version,
    helpLinks: {
      pricing: 'https://docs.perplexity.ai/docs/getting-started/pricing',
      spendingLimits: 'https://www.perplexity.ai/help-center/en/articles/10354847-api-payment-and-billing',
    },
  },
] satisfies readonly object[];

function freezeCatalogEntry(entry: AiProviderCatalogEntry): AiProviderCatalogEntry {
  return Object.freeze({
    ...entry,
    authKinds: Object.freeze([...entry.authKinds]),
    operations: Object.freeze(entry.operations.map((operation) => Object.freeze({ ...operation }))),
    ...(entry.providerWarning
      ? { providerWarning: Object.freeze({ ...entry.providerWarning }) }
      : {}),
    helpLinks: Object.freeze({ ...entry.helpLinks }),
  });
}

export const AI_PROVIDER_CATALOG: readonly AiProviderCatalogEntry[] = Object.freeze(
  parsedCatalog.map((entry) => freezeCatalogEntry(AiProviderCatalogEntrySchema.parse(entry))),
);

/** Returns one immutable application-owned catalog entry. */
export function getAiProviderCatalogEntry(
  providerId: AiProviderId,
): AiProviderCatalogEntry {
  const entry = AI_PROVIDER_CATALOG.find((candidate) => candidate.id === providerId);
  if (!entry) throw new Error(`Missing fixed AI provider catalog entry: ${providerId}`);
  return entry;
}
