import type { BusTopic } from './bus-events.js';
import type { TypedBusMessage, ServiceStatus } from './types.js';

/**
 * Every S.A.R.A.H. service implements this interface.
 * Services are registered with the ServiceRegistry and communicate via the MessageBus.
 */
export interface SarahService {
  /** Unique service ID, e.g. 'llm', 'voice', 'actions'. */
  readonly id: string;

  /** Current lifecycle status. */
  readonly status: ServiceStatus;

  /** Initialize the service. Called once by the registry at startup. */
  init(): Promise<void>;

  /** Shut down the service. Called once by the registry at shutdown. */
  destroy(): Promise<void>;

  /** Handle an incoming bus message. Called by the registry for subscribed topics. */
  onMessage(msg: TypedBusMessage): void;

  /** Topics this service subscribes to. The registry wires these up automatically. */
  readonly subscriptions: readonly BusTopic[];
}
