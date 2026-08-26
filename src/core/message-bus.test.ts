import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MessageBus } from './message-bus.js';
import type { TypedBusMessage } from './types.js';

describe('MessageBus', () => {
  let bus: MessageBus;

  beforeEach(() => {
    bus = new MessageBus();
  });

  const turn = {
    turnId: 'turn-1',
    source: 'chat' as const,
    mode: 'chat' as const,
    originalText: 'hi',
    createdAt: '2026-08-26T00:00:00.000Z',
  };

  it('delivers a typed message to a subscriber', () => {
    const handler = vi.fn();
    bus.on('chat:message', handler);

    bus.emit('test-service', 'chat:message', turn);

    expect(handler).toHaveBeenCalledOnce();
    const msg: TypedBusMessage<'chat:message'> = handler.mock.calls[0][0];
    expect(msg.source).toBe('test-service');
    expect(msg.topic).toBe('chat:message');
    expect(msg.data).toEqual(turn);
    expect(msg.timestamp).toBeTruthy();
  });

  it('delivers to multiple subscribers', () => {
    const h1 = vi.fn();
    const h2 = vi.fn();
    bus.on('llm:chunk', h1);
    bus.on('llm:chunk', h2);

    bus.emit('llm', 'llm:chunk', { turnId: 'turn-1', outputId: 'output-1', sequence: 0, text: 'hello' });

    expect(h1).toHaveBeenCalledOnce();
    expect(h2).toHaveBeenCalledOnce();
  });

  it('does not deliver after unsubscribe', () => {
    const handler = vi.fn();
    const unsub = bus.on('llm:done', handler);

    unsub();
    bus.emit('llm', 'llm:done', { turnId: 'turn-1', outputId: 'output-1', sequence: 1, fullText: 'done' });

    expect(handler).not.toHaveBeenCalled();
  });

  it('supports wildcard * to receive all messages', () => {
    const handler = vi.fn();
    bus.on('*', handler);

    bus.emit('a', 'chat:message', { ...turn, originalText: 'one' });
    bus.emit('b', 'llm:done', { turnId: 'turn-1', outputId: 'output-1', sequence: 1, fullText: 'two' });

    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler.mock.calls[0][0].topic).toBe('chat:message');
    expect(handler.mock.calls[1][0].topic).toBe('llm:done');
  });

  it('does not crash when emitting with no subscribers', () => {
    expect(() => bus.emit('svc', 'voice:wake', {})).not.toThrow();
  });

  it('isolates a throwing listener and still reaches later and wildcard listeners', () => {
    const healthy = vi.fn();
    const wildcard = vi.fn();
    bus.on('llm:chunk', () => { throw new Error('broken listener'); });
    bus.on('llm:chunk', healthy);
    bus.on('*', wildcard);

    expect(() => bus.emit('llm', 'llm:chunk', {
      turnId: 'turn-1',
      outputId: 'output-1',
      sequence: 0,
      text: 'hello',
    })).not.toThrow();
    expect(healthy).toHaveBeenCalledOnce();
    expect(wildcard).toHaveBeenCalledOnce();
  });

  it('accepts exactly one terminal event per turn across all producers', () => {
    const terminals = vi.fn();
    bus.on('turn:terminal', terminals);
    bus.emit('voice', 'turn:accepted', { turnId: 'turn-1', source: 'voice', mode: 'voice' });

    expect(bus.emit('voice', 'turn:terminal', { turnId: 'turn-1', status: 'canceled' })).toBe(true);
    expect(bus.emit('router', 'turn:terminal', { turnId: 'turn-1', status: 'done' })).toBe(false);
    expect(terminals).toHaveBeenCalledOnce();
    expect(bus.isTurnTerminal('turn-1')).toBe(true);
  });

  it('publishes an accepted turn request exactly once', () => {
    const handler = vi.fn();
    bus.on('chat:message', handler);
    bus.emit('runtime', 'turn:accepted', { turnId: turn.turnId, source: 'chat', mode: 'chat' });

    expect(bus.emit('renderer', 'chat:message', turn)).toBe(true);
    expect(bus.emit('renderer', 'chat:message', turn)).toBe(false);
    expect(handler).toHaveBeenCalledOnce();
  });

  it('refuses a terminal event without a previously accepted turn', () => {
    const handler = vi.fn();
    bus.on('turn:terminal', handler);

    expect(bus.emit('runtime', 'turn:terminal', { turnId: 'unknown', status: 'error' })).toBe(false);
    expect(handler).not.toHaveBeenCalled();
    expect(bus.isTurnKnown('unknown')).toBe(false);
  });

  it('refuses to reopen a terminal turn through chat input', () => {
    bus.emit('voice', 'turn:accepted', { turnId: 'turn-1', source: 'voice', mode: 'voice' });
    bus.emit('voice', 'turn:terminal', { turnId: 'turn-1', status: 'canceled' });
    const handler = vi.fn();
    bus.on('chat:message', handler);

    expect(bus.emit('renderer', 'chat:message', turn)).toBe(false);
    expect(handler).not.toHaveBeenCalled();
  });
});
