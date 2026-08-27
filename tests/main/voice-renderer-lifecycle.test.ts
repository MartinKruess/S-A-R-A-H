import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { registerVoiceRendererLifecycle } from '../../src/main/voice-renderer-lifecycle.js';

describe('registerVoiceRendererLifecycle', () => {
  it('routes reload, crash and destruction signals through the main voice owner', () => {
    const window = new EventEmitter();
    const webContents = new EventEmitter();
    const handleRendererCaptureUnavailable = vi.fn();
    const stop = registerVoiceRendererLifecycle(
      Object.assign(window, { webContents }),
      { handleRendererCaptureUnavailable },
    );

    webContents.emit('did-start-loading');
    webContents.emit('render-process-gone');
    webContents.emit('destroyed');
    window.emit('closed');

    expect(handleRendererCaptureUnavailable).toHaveBeenCalledTimes(4);
    expect(handleRendererCaptureUnavailable).toHaveBeenCalledWith(
      'Die Sprachverbindung wurde beendet, weil die Benutzeroberfläche neu geladen oder geschlossen wurde.',
    );

    stop();
    webContents.emit('did-start-loading');
    expect(handleRendererCaptureUnavailable).toHaveBeenCalledTimes(4);
  });
});
