export class AudioOperationAbortedError extends Error {
  constructor() {
    super('Audio operation aborted');
    this.name = 'AbortError';
  }
}

export function isAudioOperationAborted(error: Error): boolean {
  return error.name === 'AbortError';
}

/** Race a browser audio operation against lifecycle cancellation and a hard timeout. */
export function waitForAudioOperation<T>(
  operation: Promise<T>,
  signal: AbortSignal,
  timeoutMs: number,
  timeoutMessage: string,
  onLateValue?: (value: T) => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      signal.removeEventListener('abort', onAbort);
      callback();
    };
    const onAbort = (): void => finish(() => reject(new AudioOperationAbortedError()));

    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    timeout = setTimeout(() => {
      finish(() => reject(new Error(timeoutMessage)));
    }, timeoutMs);

    void operation.then(
      (value) => {
        if (settled) {
          onLateValue?.(value);
          return;
        }
        finish(() => resolve(value));
      },
      (error) => finish(() => reject(error instanceof Error ? error : new Error(String(error)))),
    );
  });
}
