import type { RuntimeSnapshot } from '../../core/app-lifecycle-controller.js';

export interface RuntimeStatusSource {
  getRuntimeStatus(): Promise<RuntimeSnapshot>;
  onRuntimeStatus(callback: (snapshot: RuntimeSnapshot) => void): () => void;
}

/**
 * Reconciles the initial runtime snapshot with the live event stream.
 *
 * - Subscribes before requesting the snapshot.
 * - Discards a delayed snapshot after any newer live event.
 * - Prevents late promise callbacks after renderer teardown.
 *
 * @category Event Handler
 */
export function synchronizeRuntimeStatus(
  source: RuntimeStatusSource,
  apply: (snapshot: RuntimeSnapshot) => void,
  onInitialError: (error: Error) => void,
): () => void {
  let stopped = false;
  let eventRevision = 0;
  const unsubscribe = source.onRuntimeStatus((snapshot) => {
    if (stopped) return;
    eventRevision += 1;
    apply(snapshot);
  });
  const requestedAtRevision = eventRevision;
  void source.getRuntimeStatus().then(
    (snapshot) => {
      if (!stopped && eventRevision === requestedAtRevision) apply(snapshot);
    },
    (value) => {
      if (stopped || eventRevision !== requestedAtRevision) return;
      onInitialError(value instanceof Error ? value : new Error(String(value)));
    },
  );

  return () => {
    if (stopped) return;
    stopped = true;
    unsubscribe();
  };
}
