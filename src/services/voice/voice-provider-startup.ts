import { traceBootPerformance } from '../../core/boot-performance-trace.js';
import { throwIfAborted } from '../../core/abort-utils.js';

interface VoiceProviderLifecycle {
  init(signal?: AbortSignal): Promise<void>;
  destroy(signal?: AbortSignal): Promise<void>;
}

interface VoiceProviderStartupOptions {
  provider: VoiceProviderLifecycle;
  signal?: AbortSignal;
  providerLabel: string;
  traceLabel: string;
  cleanupAfterFailure: boolean;
  onAvailable: () => void;
  onUnavailable: (message: string) => void;
}

/** Initializes one independent voice capability and contains partial-start cleanup. */
export async function initializeVoiceProvider({
  provider,
  signal,
  providerLabel,
  traceLabel,
  cleanupAfterFailure,
  onAvailable,
  onUnavailable,
}: VoiceProviderStartupOptions): Promise<void> {
  const startedAt = performance.now();
  traceBootPerformance(traceLabel, 'start');
  try {
    await provider.init(signal);
    onAvailable();
    traceBootPerformance(traceLabel, 'ready', {
      durationMs: performance.now() - startedAt,
    });
  } catch (error) {
    traceBootPerformance(traceLabel, 'failed', {
      durationMs: performance.now() - startedAt,
    });
    if (cleanupAfterFailure) await cleanupFailedProvider(providerLabel, () => provider.destroy());
    throwIfAborted(signal);
    console.error(`[VoiceService] ${providerLabel} init failed:`, error);
    onUnavailable(error instanceof Error ? error.message : String(error));
  }
}

async function cleanupFailedProvider(label: string, cleanup: () => Promise<void>): Promise<void> {
  try {
    await cleanup();
  } catch (error) {
    console.warn(`[VoiceService] ${label} partial-init cleanup failed:`, error);
  }
}
