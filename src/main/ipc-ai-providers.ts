import type { IpcMain } from 'electron';
import {
  AcknowledgeAiWarningsInputSchema,
  AiHubMutationResultSchema,
  AiProviderHubSnapshotSchema,
  CheckAiConnectionHealthInputSchema,
  DeleteAiConnectionInputSchema,
  ReplaceAiBindingsInputSchema,
  SaveAiApiKeyInputSchema,
  type AiHubMutationResult,
} from '../core/ai-provider-contract.js';
import type { AiProviderHubService } from '../services/integrations/ai-provider-hub-service.js';

const INVALID_INPUT_RESULT: AiHubMutationResult = Object.freeze({
  ok: false,
  code: 'invalid_input',
  message: 'Die Angaben für die KI-Verbindung sind ungültig.',
});

const OPERATION_FAILED_RESULT: AiHubMutationResult = Object.freeze({
  ok: false,
  code: 'operation_failed',
  message: 'Die KI-Verbindung konnte nicht sicher geändert werden.',
});

export interface AiProviderHandlerDependencies {
  readonly getHub: () => AiProviderHubService;
}

function safeMutationResult(value: AiHubMutationResult): AiHubMutationResult {
  const parsed = AiHubMutationResultSchema.safeParse(value);
  return parsed.success ? parsed.data : OPERATION_FAILED_RESULT;
}

async function safelyDelegate(
  operation: () => Promise<AiHubMutationResult>,
): Promise<AiHubMutationResult> {
  try {
    return safeMutationResult(await operation());
  } catch {
    return OPERATION_FAILED_RESULT;
  }
}

/**
 * Registers the provider-hub Main IPC boundary.
 *
 * - Revalidates every untrusted renderer payload with the shared strict schemas.
 * - Delegates only parsed values and validates every mutation result before exposure.
 * - Maps internal failures to stable German messages without reflecting payloads or errors.
 *
 * @category Validation Event Handler
 */
export function registerAiProviderHandlers(
  ipcMain: IpcMain,
  dependencies: AiProviderHandlerDependencies,
): void {
  ipcMain.handle('ai-provider-hub-list', () => {
    try {
      return AiProviderHubSnapshotSchema.parse(dependencies.getHub().snapshot());
    } catch {
      throw new Error('Der Status der KI-Anbieter konnte nicht sicher geladen werden.');
    }
  });

  ipcMain.handle('ai-provider-save-key', (_event, input: unknown) => {
    const parsed = SaveAiApiKeyInputSchema.safeParse(input);
    if (!parsed.success) return INVALID_INPUT_RESULT;
    return safelyDelegate(() => dependencies.getHub().saveApiKey(parsed.data));
  });

  ipcMain.handle('ai-provider-acknowledge-warnings', (_event, input: unknown) => {
    const parsed = AcknowledgeAiWarningsInputSchema.safeParse(input);
    if (!parsed.success) return INVALID_INPUT_RESULT;
    return safelyDelegate(() => dependencies.getHub().acknowledgeWarnings(parsed.data));
  });

  ipcMain.handle('ai-provider-delete', (_event, input: unknown) => {
    const parsed = DeleteAiConnectionInputSchema.safeParse(input);
    if (!parsed.success) return INVALID_INPUT_RESULT;
    return safelyDelegate(() => dependencies.getHub().deleteConnection(parsed.data));
  });

  ipcMain.handle('ai-provider-save-bindings', (_event, input: unknown) => {
    const parsed = ReplaceAiBindingsInputSchema.safeParse(input);
    if (!parsed.success) return INVALID_INPUT_RESULT;
    return safelyDelegate(() => dependencies.getHub().replaceBindings(parsed.data));
  });

  ipcMain.handle('ai-provider-check-health', (_event, input: unknown) => {
    const parsed = CheckAiConnectionHealthInputSchema.safeParse(input);
    if (!parsed.success) return INVALID_INPUT_RESULT;
    return safelyDelegate(() => dependencies.getHub().checkHealth(parsed.data));
  });
}
