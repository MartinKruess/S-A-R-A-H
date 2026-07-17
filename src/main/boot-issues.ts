import type { ServiceStatus } from '../core/types.js';

/**
 * Boot problem derivation (A7): a container that came up fine can still leave
 * the router in error state (routerService.init resolves instead of throwing
 * when Ollama is unreachable) — that case must surface on the splash screen.
 */
export function deriveBootIssue(
  containerError: string | null,
  routerStatus: ServiceStatus,
): { message: string; severity: 'warning' | 'error' } | null {
  if (containerError) return { message: containerError, severity: 'error' };
  if (routerStatus === 'error') {
    return {
      message: 'Sarah-Protokoll nicht erreichbar — Sprachverarbeitung ist gestört.',
      severity: 'error',
    };
  }
  return null;
}
