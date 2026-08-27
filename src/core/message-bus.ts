import type { BusEvents, BusTopic } from './bus-events.js';
import type { TypedBusMessage } from './types.js';
import type { TurnId, TurnMode, TurnSource, TurnTerminalStatus } from './turn-contract.js';

export type MessageHandler<T extends BusTopic = BusTopic> = (msg: TypedBusMessage<T>) => void;

export class MessageBus {
  private listeners = new Map<string, Set<MessageHandler<BusTopic>>>();
  private readonly openTurns = new Map<TurnId, {
    source: TurnSource;
    mode: TurnMode;
    requestPublished: boolean;
  }>();
  private readonly terminalTurns = new Map<TurnId, TurnTerminalStatus>();
  private readonly terminalTurnOrder: TurnId[] = [];

  isTurnOpen(turnId: TurnId): boolean {
    return this.openTurns.has(turnId) && !this.terminalTurns.has(turnId);
  }

  isTurnTerminal(turnId: TurnId): boolean {
    return this.terminalTurns.has(turnId);
  }

  isTurnKnown(turnId: TurnId): boolean {
    return this.openTurns.has(turnId) || this.terminalTurns.has(turnId);
  }

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
  emit<T extends BusTopic>(source: string, topic: T, data: BusEvents[T]): boolean {
    if (topic === 'chat:message') {
      const turn = data as BusEvents['chat:message'];
      if (!this.publishTurnRequest(turn.turnId, turn.source, turn.mode)) return false;
    } else if (topic === 'turn:accepted') {
      const turn = data as BusEvents['turn:accepted'];
      if (!this.acceptTurn(turn.turnId, turn.source, turn.mode)) return false;
    } else if (topic === 'turn:terminal') {
      const terminal = data as BusEvents['turn:terminal'];
      if (!this.openTurns.has(terminal.turnId)) {
        console.warn('[MessageBus] terminal event for unknown turn refused:', terminal.turnId);
        return false;
      }
      if (this.terminalTurns.has(terminal.turnId)) {
        console.warn('[MessageBus] duplicate terminal turn refused:', terminal.turnId, terminal.status);
        return false;
      }
      this.openTurns.delete(terminal.turnId);
      this.terminalTurns.set(terminal.turnId, terminal.status);
      this.terminalTurnOrder.push(terminal.turnId);
      if (this.terminalTurnOrder.length > 5_000) {
        const expired = this.terminalTurnOrder.shift();
        if (expired) this.terminalTurns.delete(expired);
      }
    }

    const msg = {
      source,
      topic,
      data,
      timestamp: new Date().toISOString(),
    } as TypedBusMessage<T>;

    const topicListeners = this.listeners.get(topic as string);
    topicListeners?.forEach((handler) => {
      try {
        (handler as MessageHandler<T>)(msg);
      } catch (error) {
        console.error(`[MessageBus] listener failed for ${String(topic)}:`, error);
      }
    });

    if ((topic as string) !== '*') {
      const wildcardListeners = this.listeners.get('*');
      wildcardListeners?.forEach((handler) => {
        try {
          (handler as MessageHandler<T>)(msg);
        } catch (error) {
          console.error(`[MessageBus] wildcard listener failed for ${String(topic)}:`, error);
        }
      });
    }
    return true;
  }

  private acceptTurn(turnId: TurnId, source: TurnSource, mode: TurnMode): boolean {
    if (this.terminalTurns.has(turnId)) {
      console.warn('[MessageBus] terminal turn cannot be accepted again:', turnId);
      return false;
    }
    const current = this.openTurns.get(turnId);
    if (current) {
      return current.source === source && current.mode === mode;
    }
    this.openTurns.set(turnId, { source, mode, requestPublished: false });
    return true;
  }

  private publishTurnRequest(turnId: TurnId, source: TurnSource, mode: TurnMode): boolean {
    if (this.terminalTurns.has(turnId)) {
      console.warn('[MessageBus] terminal turn cannot publish a request:', turnId);
      return false;
    }
    const current = this.openTurns.get(turnId);
    if (current) {
      if (current.source !== source || current.mode !== mode || current.requestPublished) {
        console.warn('[MessageBus] duplicate or mismatched turn request refused:', turnId);
        return false;
      }
      current.requestPublished = true;
      return true;
    }
    this.openTurns.set(turnId, { source, mode, requestPublished: true });
    return true;
  }
}
