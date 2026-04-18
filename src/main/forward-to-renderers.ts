import { BrowserWindow } from 'electron';
import type { BusTopic } from '../core/bus-events.js';
import type { MessageBus } from '../core/message-bus.js';

/**
 * Subscribe to a bus topic and forward every message to all open renderer windows.
 * Used for LLM events, voice events, and any other bus→renderer bridging.
 */
export function forwardToRenderers(bus: MessageBus, topic: BusTopic): void {
  bus.on(topic, (msg) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send(topic, msg.data);
      }
    }
  });
}
