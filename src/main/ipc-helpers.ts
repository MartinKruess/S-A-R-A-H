import type { AppContext } from '../core/bootstrap.js';
import type { SarahService } from '../core/service.interface.js';

/**
 * Typed service lookup for IPC handlers.
 * Throws if the service ID is not registered — callers can rely on a non-null return.
 */
export function getService<T extends SarahService>(context: AppContext, id: string): T {
  const service = context.registry.get(id);
  if (!service) {
    throw new Error(`Service not found: ${id}`);
  }
  return service as T;
}
