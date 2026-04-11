import type { BusEvents, BusTopic } from './bus-events.js';

/** A typed message sent through the message bus between services. */
export interface TypedBusMessage<T extends BusTopic = BusTopic> {
  /** Source service ID, e.g. 'voice', 'actions'. Set by the bus. */
  source: string;
  /** Event topic — constrained to known BusEvents keys. */
  topic: T;
  /** Typed payload matching the topic. */
  data: BusEvents[T];
  /** ISO timestamp, set by the bus. */
  timestamp: string;
}

/** Lifecycle status of a service. */
export type ServiceStatus = 'pending' | 'running' | 'stopped' | 'error';
