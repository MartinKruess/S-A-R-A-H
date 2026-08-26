import { BrowserWindow } from 'electron';
import type { BusTopic } from '../core/bus-events.js';
import type { MessageBus } from '../core/message-bus.js';

/**
 * Subscribe to a bus topic and forward every message to all open renderer windows.
 * Used for LLM events, voice events, and any other bus→renderer bridging.
 */
export function forwardToRenderers(bus: MessageBus, topic: BusTopic): () => void {
  return bus.on(topic, (msg) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send(topic, msg.data);
        const turnId = 'turnId' in Object(msg.data)
          ? (msg.data as { turnId?: string }).turnId
          : undefined;
        win.webContents.send('bus:diagnostic', {
          topic: msg.topic,
          source: msg.source,
          timestamp: msg.timestamp,
          ...(turnId ? { turnId } : {}),
        });
      }
    }
  });
}
