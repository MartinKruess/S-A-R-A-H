/** Create the shared error shape used for expected lifecycle cancellation. */
export function abortError(message = 'Operation aborted'): Error {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

/** Throw immediately when an optional lifecycle signal is already cancelled. */
export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

/** Wait without leaving a timer behind when the owning lifecycle is cancelled. */
export function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const finish = (): void => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    };
    const onAbort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(abortError());
    };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Create the shared error shape for a bounded operation that exceeded its deadline. */
export function timeoutError(message: string): Error {
  const error = new Error(message);
  error.name = 'TimeoutError';
  return error;
}

export interface LinkedAbortSignal {
  signal: AbortSignal;
  dispose(): void;
}

/** Wait for cleanup work only up to the lifecycle's bounded drain window. */
export async function waitForSettlement(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise.then(() => true, () => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Combine optional caller/runtime signals without depending on a specific Node version.
 *
 * @category Utility
 */
export function linkAbortSignals(...signals: Array<AbortSignal | undefined>): LinkedAbortSignal {
  const controller = new AbortController();
  const active = signals.filter((signal): signal is AbortSignal => signal !== undefined);
  const listeners = new Map<AbortSignal, () => void>();

  for (const signal of active) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    const listener = (): void => controller.abort(signal.reason);
    listeners.set(signal, listener);
    signal.addEventListener('abort', listener, { once: true });
  }

  return {
    signal: controller.signal,
    dispose: () => {
      for (const [signal, listener] of listeners) {
        signal.removeEventListener('abort', listener);
      }
      listeners.clear();
    },
  };
}

/**
 * Run cooperative work behind a hard deadline.
 *
 * - Passes one combined signal to the operation.
 * - Rejects at the deadline even when the operation ignores cancellation.
 * - Removes timers and signal listeners after settlement.
 *
 * @category Utility
 */
export async function runWithTimeout<T>(
  operation: (signal: AbortSignal) => T | Promise<T>,
  timeoutMs: number,
  message: string,
  parentSignal?: AbortSignal,
): Promise<T> {
  const timeoutController = new AbortController();
  const linked = linkAbortSignals(parentSignal, timeoutController.signal);
  if (linked.signal.aborted) {
    const reason = linked.signal.reason;
    linked.dispose();
    throw reason instanceof Error ? reason : abortError();
  }

  let removeAbortListener = (): void => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    const onAbort = (): void => {
      const reason = linked.signal.reason;
      reject(reason instanceof Error ? reason : abortError());
    };
    removeAbortListener = () => linked.signal.removeEventListener('abort', onAbort);
    linked.signal.addEventListener('abort', onAbort, { once: true });
  });
  const deadlineError = timeoutError(message);
  const timer = setTimeout(() => timeoutController.abort(deadlineError), Math.max(0, timeoutMs));
  timer.unref?.();

  try {
    return await Promise.race([
      Promise.resolve().then(() => operation(linked.signal)),
      aborted,
    ]);
  } finally {
    clearTimeout(timer);
    removeAbortListener();
    linked.dispose();
  }
}
