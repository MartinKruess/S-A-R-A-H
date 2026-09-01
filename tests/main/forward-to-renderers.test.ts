import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageBus } from '../../src/core/message-bus.js';

const electronMocks = vi.hoisted(() => ({
  getAllWindows: vi.fn(),
}));

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: electronMocks.getAllWindows },
}));

import { forwardToRenderers } from '../../src/main/forward-to-renderers.js';

describe('forwardToRenderers', () => {
  beforeEach(() => {
    electronMocks.getAllWindows.mockReset();
  });

  it('preserves the domain payload and sends source/timestamp separately', () => {
    const send = vi.fn();
    electronMocks.getAllWindows.mockReturnValue([{
      isDestroyed: () => false,
      webContents: { isDestroyed: () => false, send },
    }]);
    const bus = new MessageBus();
    const stop = forwardToRenderers(bus, 'llm:chunk');
    const payload = {
      turnId: '11111111-1111-4111-8111-111111111111',
      outputId: '22222222-2222-4222-8222-222222222222',
      sequence: 0,
      text: 'Hallo',
    };

    bus.emit('router', 'llm:chunk', payload);

    expect(send).toHaveBeenNthCalledWith(1, 'llm:chunk', payload);
    expect(send).toHaveBeenNthCalledWith(2, 'bus:diagnostic', expect.objectContaining({
      topic: 'llm:chunk',
      source: 'router',
      turnId: payload.turnId,
      timestamp: expect.any(String),
    }));
    stop();
  });

  it('does not send into a destroyed renderer', () => {
    const send = vi.fn();
    electronMocks.getAllWindows.mockReturnValue([{
      isDestroyed: () => true,
      webContents: { isDestroyed: () => false, send },
    }]);
    const bus = new MessageBus();
    forwardToRenderers(bus, 'storage:degraded');

    bus.emit('router', 'storage:degraded', { message: 'offline' });

    expect(send).not.toHaveBeenCalled();
  });

  it('does not send into destroyed webContents', () => {
    const send = vi.fn();
    electronMocks.getAllWindows.mockReturnValue([{
      isDestroyed: () => false,
      webContents: { isDestroyed: () => true, send },
    }]);
    const bus = new MessageBus();
    forwardToRenderers(bus, 'storage:degraded');

    bus.emit('router', 'storage:degraded', { message: 'offline' });

    expect(send).not.toHaveBeenCalled();
  });

  it('continues forwarding after a closing renderer throws during send', () => {
    const firstSend = vi.fn(() => { throw new Error('renderer gone'); });
    const secondSend = vi.fn();
    electronMocks.getAllWindows.mockReturnValue([
      {
        isDestroyed: () => false,
        webContents: { isDestroyed: () => false, send: firstSend },
      },
      {
        isDestroyed: () => false,
        webContents: { isDestroyed: () => false, send: secondSend },
      },
    ]);
    const bus = new MessageBus();
    forwardToRenderers(bus, 'storage:degraded');

    bus.emit('router', 'storage:degraded', { message: 'offline' });

    expect(secondSend).toHaveBeenNthCalledWith(1, 'storage:degraded', { message: 'offline' });
    expect(secondSend).toHaveBeenCalledTimes(2);
  });
});
