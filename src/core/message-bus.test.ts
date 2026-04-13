import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MessageBus } from './message-bus.js';
import type { TypedBusMessage } from './types.js';

describe('MessageBus', () => {
  let bus: MessageBus;

  beforeEach(() => {
    bus = new MessageBus();
  });

  it('delivers a typed message to a subscriber', () => {
    const handler = vi.fn();
    bus.on('chat:message', handler);

    bus.emit('test-service', 'chat:message', { text: 'hi', mode: 'chat' });

    expect(handler).toHaveBeenCalledOnce();
    const msg: TypedBusMessage<'chat:message'> = handler.mock.calls[0][0];
    expect(msg.source).toBe('test-service');
    expect(msg.topic).toBe('chat:message');
    expect(msg.data).toEqual({ text: 'hi', mode: 'chat' });
    expect(msg.timestamp).toBeTruthy();
  });

  it('delivers to multiple subscribers', () => {
    const h1 = vi.fn();
    const h2 = vi.fn();
    bus.on('llm:chunk', h1);
    bus.on('llm:chunk', h2);

    bus.emit('llm', 'llm:chunk', { text: 'hello' });

    expect(h1).toHaveBeenCalledOnce();
    expect(h2).toHaveBeenCalledOnce();
  });

  it('does not deliver after unsubscribe', () => {
    const handler = vi.fn();
    const unsub = bus.on('llm:done', handler);

    unsub();
    bus.emit('llm', 'llm:done', { fullText: 'done' });

    expect(handler).not.toHaveBeenCalled();
  });

  it('supports wildcard * to receive all messages', () => {
    const handler = vi.fn();
    bus.on('*', handler);

    bus.emit('a', 'chat:message', { text: 'one', mode: 'chat' });
    bus.emit('b', 'llm:done', { fullText: 'two' });

    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler.mock.calls[0][0].topic).toBe('chat:message');
    expect(handler.mock.calls[1][0].topic).toBe('llm:done');
  });

  it('does not crash when emitting with no subscribers', () => {
    expect(() => bus.emit('svc', 'voice:wake', {})).not.toThrow();
  });
});
