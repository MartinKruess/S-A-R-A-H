import type { BusEvents, BusTopic } from './bus-events.js';

/**
 * A typed message sent through the message bus between services.
 * Distributive over T so that TypedBusMessage (default) is a discriminated union —
 * narrowing msg.topic automatically narrows msg.data to the matching payload type.
 */
export type TypedBusMessage<T extends BusTopic = BusTopic> = T extends BusTopic ? {
  /** Source service ID, e.g. 'voice', 'actions'. Set by the bus. */
  source: string;
  /** Event topic — constrained to known BusEvents keys. */
  topic: T;
  /** Typed payload matching the topic. */
  data: BusEvents[T];
  /** ISO timestamp, set by the bus. */
  timestamp: string;
} : never;

/** Lifecycle status of a service. */
export type ServiceStatus = 'pending' | 'running' | 'stopped' | 'error';
