import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MessageBus } from './message-bus.js';
import type { BusMessage } from './types.js';

describe('MessageBus', () => {
  let bus: MessageBus;

  beforeEach(() => {
    bus = new MessageBus();
  });

  it('delivers a message to a subscriber', () => {
    const handler = vi.fn();
    bus.on('test:hello', handler);

    bus.emit('test-service', 'test:hello', { greeting: 'hi' });

    expect(handler).toHaveBeenCalledOnce();
    const msg: BusMessage = handler.mock.calls[0][0];
    expect(msg.source).toBe('test-service');
    expect(msg.topic).toBe('test:hello');
    expect(msg.data).toEqual({ greeting: 'hi' });
    expect(msg.timestamp).toBeTruthy();
  });

  it('delivers to multiple subscribers', () => {
    const h1 = vi.fn();
    const h2 = vi.fn();
    bus.on('test:multi', h1);
    bus.on('test:multi', h2);

    bus.emit('svc', 'test:multi', {});

    expect(h1).toHaveBeenCalledOnce();
    expect(h2).toHaveBeenCalledOnce();
  });

  it('does not deliver after unsubscribe', () => {
    const handler = vi.fn();
    const unsub = bus.on('test:unsub', handler);

    unsub();
    bus.emit('svc', 'test:unsub', {});

    expect(handler).not.toHaveBeenCalled();
  });

  it('supports wildcard * to receive all messages', () => {
    const handler = vi.fn();
    bus.on('*', handler);

    bus.emit('a', 'topic:one', {});
    bus.emit('b', 'topic:two', {});

    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler.mock.calls[0][0].topic).toBe('topic:one');
    expect(handler.mock.calls[1][0].topic).toBe('topic:two');
  });

  it('does not crash when emitting with no subscribers', () => {
    expect(() => bus.emit('svc', 'nobody:listens', {})).not.toThrow();
  });
});
