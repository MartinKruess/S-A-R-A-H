import type { BusMessage } from './types.js';

export type MessageHandler = (msg: BusMessage) => void;

export class MessageBus {
  private listeners = new Map<string, Set<MessageHandler>>();

  /**
   * Subscribe to a topic. Use '*' to receive all messages.
   * Returns an unsubscribe function.
   */
  on(topic: string, handler: MessageHandler): () => void {
    if (!this.listeners.has(topic)) {
      this.listeners.set(topic, new Set());
    }
    this.listeners.get(topic)!.add(handler);

    return () => {
      this.listeners.get(topic)?.delete(handler);
    };
  }

  /** Emit a message to all subscribers of the topic and wildcard listeners. */
  emit(source: string, topic: string, data: Record<string, unknown>): void {
    const msg: BusMessage = {
      source,
      topic,
      data,
      timestamp: new Date().toISOString(),
    };

    this.listeners.get(topic)?.forEach((h) => h(msg));

    if (topic !== '*') {
      this.listeners.get('*')?.forEach((h) => h(msg));
    }
  }
}
