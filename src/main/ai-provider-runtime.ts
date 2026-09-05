import OpenAI from 'openai';
import type { AiProviderOperationId } from '../core/ai-provider-contract.js';
import type { AiCredentialStore } from '../services/integrations/ai-credential-store.js';
import { AiProviderHubService } from '../services/integrations/ai-provider-hub-service.js';
import type { AiProviderHubStore } from '../services/integrations/ai-provider-hub-store.js';
import { SpecialistRuntimeService } from '../services/specialists/specialist-runtime-service.js';
import { SpecialistTaskStore } from '../services/specialists/specialist-task-store.js';
import { SpecialistHandoffCoordinator } from '../services/specialists/specialist-handoff-coordinator.js';
import { OpenAiTextAdapter } from '../services/providers/openai/openai-text-adapter.js';
import { OpenAiResearchAdapter } from '../services/providers/openai/openai-research-adapter.js';
import type { TextGenerationAdapter } from '../services/providers/text-generation-adapter.js';
import { selectCloudText } from '../services/providers/cloud-text-service.js';
import type { DecisionCapability } from '../core/decision-context.js';
import type { SpecialistCapability } from '../core/intent-plan.js';
import { CodexConnectionService } from './codex-connection-service.js';
import { CodexTaskAdapter } from '../services/providers/codex/codex-task-adapter.js';
import { AiUsageStore } from '../services/providers/ai-usage-store.js';

/** Composes real provider adapters without exposing provider objects to the local router. */
export function createAiProviderRuntime(userData: string, store: AiProviderHubStore,
  credentials: AiCredentialStore, webAllowed: () => boolean) {
  const textAdapters = new Map<AiProviderOperationId, TextGenerationAdapter>([
    ['openai_responses_text', new OpenAiTextAdapter()],
  ]);
  const research = new OpenAiResearchAdapter();
  const coding = new CodexTaskAdapter(() => null);
  const usage = new AiUsageStore(userData);
  let codex: CodexConnectionService | undefined;
  const knownModels = new Set<string>();
  let runtime: SpecialistRuntimeService | undefined;
  const hub = new AiProviderHubService(store, credentials, {
    isOperationReady: (operation) => textAdapters.has(operation)
      || (operation === 'openai_deep_research' && webAllowed()),
    isModelSupported: (operation, model) => operation === 'openai_deep_research'
      ? ['o3-deep-research', 'o4-mini-deep-research'].includes(model)
      : operation === 'openai_responses_text' && knownModels.has(model) && /^gpt-/u.test(model),
    beforeConnectionChange: async (id) => runtime ? runtime.cancelConnection(id) : true,
    managedSessionAvailable: (id) => codex?.available(id) === true,
    healthCheck: async (connection, key) => {
      if (connection.authKind === 'codex_managed_chatgpt') return {
        state: codex?.available(connection.connectionId) ? 'healthy' : 'not_configured',
        message: 'Coding ist bis zum Nachweis der Projektbegrenzung gesperrt.',
      };
      if (connection.providerId !== 'openai' || connection.authKind !== 'api_key' || !key) {
        return {state: 'temporarily_unavailable', message: 'Dieser Anmeldeweg ist noch nicht verfügbar.'};
      }
      try {
        const client = new OpenAI({apiKey: key, maxRetries: 0, timeout: 8_000,
          baseURL: 'https://api.openai.com/v1'});
        const models = await client.models.list();
        for (const model of models.data) knownModels.add(model.id);
        return {state: 'healthy', message: 'API-Schlüssel geprüft. Modellzugriff wird bei der Anfrage geprüft.'};
      } catch (error) {
        return {state: error instanceof OpenAI.APIError && [401,403].includes(error.status ?? 0)
          ? 'invalid_credentials' : 'temporarily_unavailable', message: 'Die API-Prüfung ist fehlgeschlagen.'};
      }
    },
  });
  const resolve = (role: 'coding' | 'research') => {
    if (role === 'research' && !webAllowed()) return null;
    const binding = hub.resolveBinding(role);
    return binding ? {...binding, bindingRevision: binding.revision} : null;
  };
  codex = new CodexConnectionService(userData, hub);
  runtime = new SpecialistRuntimeService({store: new SpecialistTaskStore(userData), adapters: [research,coding],
    resolveBinding: resolve,
    isTaskAllowed: (role) => role !== 'research' || webAllowed(),
    resolveCredential: (id, provider, generation) => hub.resolveCredential(id, provider, generation),
    resolveRecoveryCredential: (id, provider, generation) => hub.resolveRecoveryCredential(id, provider, generation),
    onTerminal: (task, snapshot) => {
      if (!task.modelId || !task.authKind) return;
      usage.record({requestId:task.taskId,providerId:task.providerId,operationId:task.operationId,
        role:task.role,model:task.modelId,authKind:task.authKind,
        ...(snapshot.terminal?.usage ? {usage:snapshot.terminal.usage} : {}),
      });
    },
  });
  const handoffs = new SpecialistHandoffCoordinator(runtime, (role) => {
    const binding = resolve(role);
    return binding ? {...binding, providerName: binding.providerId, roleName: role === 'coding' ? 'Coding' : 'Recherche',
      modelName: binding.modelId, backgroundConsent: role === 'research'} : null;
  });
  return {hub, runtime, handoffs, codex, selectCloudText: () => selectCloudText(hub, textAdapters, (entry) => { usage.record(entry); }),
    readiness: (): Readonly<Record<SpecialistCapability, DecisionCapability>> => ({
      coding: {state:'unavailable', reason:'no_adapter'},
      research: resolve('research') ? {state:'available', reason:'ready'} : {state:'unavailable', reason:'no_adapter'},
      vision: {state:'unavailable', reason:'no_adapter'},
    }),
  };
}
