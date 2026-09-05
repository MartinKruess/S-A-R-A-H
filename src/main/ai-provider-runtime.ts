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
import { ApiKeyHealthService } from '../services/providers/api-key-health-service.js';
import { AnthropicTextAdapter } from '../services/providers/anthropic/anthropic-text-adapter.js';

/** Composes real provider adapters without exposing provider objects to the local router. */
export function createAiProviderRuntime(userData: string, store: AiProviderHubStore,
  credentials: AiCredentialStore, webAllowed: () => boolean) {
  const textAdapters = new Map<AiProviderOperationId, TextGenerationAdapter>([
    ['openai_responses_text', new OpenAiTextAdapter()],
    ['anthropic_messages_text', new AnthropicTextAdapter()],
  ]);
  const research = new OpenAiResearchAdapter();
  const coding = new CodexTaskAdapter(() => null);
  const usage = new AiUsageStore(userData);
  let codex: CodexConnectionService | undefined;
  const health = new ApiKeyHealthService();
  let runtime: SpecialistRuntimeService | undefined;
  const hub = new AiProviderHubService(store, credentials, {
    isOperationReady: (operation) => textAdapters.has(operation)
      || (operation === 'openai_deep_research' && webAllowed()),
    isModelSupported: (operation, model, connection) => health.isModelSupported(operation, model, connection),
    beforeConnectionChange: async (id) => {
      health.invalidate(id);
      return runtime ? runtime.cancelConnection(id) : true;
    },
    managedSessionAvailable: (id) => codex?.available(id) === true,
    healthCheck: async (connection, key) => {
      if (connection.authKind === 'codex_managed_chatgpt') return {
        state: codex?.available(connection.connectionId) ? 'healthy' : 'not_configured',
        message: 'Coding ist bis zum Nachweis der Projektbegrenzung gesperrt.',
      };
      return health.check(connection, key);
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
