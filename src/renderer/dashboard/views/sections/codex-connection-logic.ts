import { CodexLoginInputSchema, type CodexLoginInput } from '../../../../core/codex-connection.js';
import { CODEX_MANAGED_CHATGPT_NOTICE } from '../../../../services/integrations/ai-auth-policy.js';

export const CODEX_DEVICE_LOGIN_URL = 'https://auth.openai.com/codex/device';

/** Requires explicit acknowledgement of the exact currently supported managed-login disclosure. */
export function managedCodexLoginInput(acknowledged: boolean): CodexLoginInput | null {
  if (!acknowledged) return null;
  const parsed = CodexLoginInputSchema.safeParse({ acknowledgementVersion: CODEX_MANAGED_CHATGPT_NOTICE.version });
  return parsed.success ? parsed.data : null;
}
