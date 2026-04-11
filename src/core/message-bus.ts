import type { BusEvents, BusTopic } from './bus-events.js';
import type { TypedBusMessage } from './types.js';

export type MessageHandler<T extends BusTopic = BusTopic> = (msg: TypedBusMessage<T>) => void;

export class MessageBus {
  private listeners = new Map<string, Set<MessageHandler<BusTopic>>>();

  /**
   * Subscribe to a topic. Use '*' to receive all messages.
   * Returns an unsubscribe function.
   */
  on<T extends BusTopic>(topic: T | '*', handler: MessageHandler<T>): () => void {
    const key = topic as string;
    if (!this.listeners.has(key)) {
      this.listeners.set(key, new Set());
    }
    this.listeners.get(key)!.add(handler as MessageHandler<BusTopic>);

    return () => {
      this.listeners.get(key)?.delete(handler as MessageHandler<BusTopic>);
    };
  }

  /** Emit a message to all subscribers of the topic and wildcard listeners. */
  emit<T extends BusTopic>(source: string, topic: T, data: BusEvents[T]): void {
    const msg: TypedBusMessage<T> = {
      source,
      topic,
      data,
      timestamp: new Date().toISOString(),
    };

    const topicListeners = this.listeners.get(topic as string);
    topicListeners?.forEach((h) => (h as MessageHandler<T>)(msg));

    if (topic !== '*') {
      const wildcardListeners = this.listeners.get('*');
      wildcardListeners?.forEach((h) => (h as MessageHandler<T>)(msg));
    }
  }
}
