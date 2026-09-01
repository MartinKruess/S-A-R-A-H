import type { VoiceCaptureId } from '../../core/turn-contract.js';

const CAPTURE_FLUSH_TIMEOUT_MS = 2_000;

interface CaptureFlushWaiter {
  resolve: () => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

/** Correlates renderer flush acknowledgements with the exact recording capture. */
export class VoiceCaptureFlush {
  private readonly waiters = new Map<VoiceCaptureId, CaptureFlushWaiter>();

  constructor(private readonly requestRendererFlush: (captureId: VoiceCaptureId) => void) {}

  request(captureId: VoiceCaptureId): Promise<void> {
    if (this.waiters.has(captureId)) {
      return Promise.reject(new Error(`Capture ${captureId} is already being flushed`));
    }
    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.waiters.delete(captureId);
        reject(new Error('Renderer capture flush timed out'));
      }, CAPTURE_FLUSH_TIMEOUT_MS);
      this.waiters.set(captureId, { resolve, reject, timeout });
      this.requestRendererFlush(captureId);
    });
  }

  resolve(captureId: VoiceCaptureId): void {
    const waiter = this.waiters.get(captureId);
    if (!waiter) return;
    clearTimeout(waiter.timeout);
    this.waiters.delete(captureId);
    waiter.resolve();
  }

  reject(captureId: VoiceCaptureId, error: Error): void {
    const waiter = this.waiters.get(captureId);
    if (!waiter) return;
    clearTimeout(waiter.timeout);
    this.waiters.delete(captureId);
    waiter.reject(error);
  }

  rejectAll(error: Error): void {
    for (const captureId of [...this.waiters.keys()]) this.reject(captureId, error);
  }
}
