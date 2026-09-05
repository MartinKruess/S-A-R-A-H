import { BrowserWindow } from 'electron';
import type { BusTopic } from '../core/bus-events.js';
import type { BusEvents } from '../core/bus-events.js';
import type { MessageBus } from '../core/message-bus.js';

/** Deliver one IPC event without letting a closing renderer break main-process work. */
export function sendToRendererSafely<T>(
  win: BrowserWindow | null | undefined,
  channel: string,
  payload?: T,
): boolean {
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return false;
  try {
    if (arguments.length >= 3) win.webContents.send(channel, payload);
    else win.webContents.send(channel);
    return true;
  } catch (error) {
    console.warn(`[RendererForwarder] ${channel} could not be sent to one window:`, error);
    return false;
  }
}

/**
 * Subscribe to a bus topic and forward every message to all open renderer windows.
 * Used for LLM events, voice events, and any other bus→renderer bridging.
 */
export function forwardToRenderers(bus: MessageBus, topic: BusTopic): () => void {
  return bus.on(topic, (msg) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!sendToRendererSafely(win, topic, msg.data)) continue;
      const turnId = 'turnId' in Object(msg.data)
        ? (msg.data as { turnId?: string }).turnId
        : undefined;
      sendToRendererSafely(win, 'bus:diagnostic', {
        topic: msg.topic,
        source: msg.source,
        timestamp: msg.timestamp,
        ...(turnId ? { turnId } : {}),
      });
    }
  });
}

/** Forwards only payloads that pass a strict public-event projection. */
export function forwardValidatedSpecialistStateToRenderers(
  bus: MessageBus,
  validate: (
    payload: BusEvents['specialist:state'],
  ) => BusEvents['specialist:state'] | null,
): () => void {
  return bus.on('specialist:state', (msg) => {
    const payload = validate(msg.data);
    if (!payload) return;
    for (const win of BrowserWindow.getAllWindows()) {
      if (!sendToRendererSafely(win, 'specialist:state', payload)) continue;
      sendToRendererSafely(win, 'bus:diagnostic', {
        topic: msg.topic,
        source: msg.source,
        timestamp: msg.timestamp,
      });
    }
  });
}
