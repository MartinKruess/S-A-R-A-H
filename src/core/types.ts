/** A message sent through the message bus between services. */
export interface BusMessage {
  /** Source service ID, e.g. 'voice', 'actions'. Set by the bus. */
  source: string;
  /** Event topic, e.g. 'voice:transcript', 'actions:executed'. */
  topic: string;
  /** Arbitrary payload. */
  data: Record<string, unknown>;
  /** ISO timestamp, set by the bus. */
  timestamp: string;
}

/** Lifecycle status of a service. */
export type ServiceStatus = 'pending' | 'running' | 'stopped' | 'error';
