const RENDERER_AUDIO_LOST_MESSAGE = 'Die Sprachverbindung wurde beendet, weil die Benutzeroberfläche neu geladen oder geschlossen wurde.';

interface LifecycleEmitter {
  on(event: string, listener: () => void): object;
  removeListener(event: string, listener: () => void): object;
}

interface VoiceRendererWindow extends LifecycleEmitter {
  webContents: LifecycleEmitter;
}

interface VoiceRendererCaptureOwner {
  handleRendererCaptureUnavailable(message: string): void;
}

/**
 * Correlates renderer loss with main-owned voice capture and playback.
 *
 * - Covers navigation/reload, renderer crashes and window destruction.
 * - Repeated Electron lifecycle signals remain idempotent in `VoiceService`.
 *
 * @returns Unsubscriber for application shutdown.
 *
 * @category Event Handler
 */
export function registerVoiceRendererLifecycle(
  window: VoiceRendererWindow,
  voiceService: VoiceRendererCaptureOwner,
): () => void {
  const webContents = window.webContents;
  const handleUnavailable = (): void => {
    voiceService.handleRendererCaptureUnavailable(RENDERER_AUDIO_LOST_MESSAGE);
  };

  webContents.on('did-start-loading', handleUnavailable);
  webContents.on('render-process-gone', handleUnavailable);
  webContents.on('destroyed', handleUnavailable);
  window.on('closed', handleUnavailable);

  return () => {
    webContents.removeListener('did-start-loading', handleUnavailable);
    webContents.removeListener('render-process-gone', handleUnavailable);
    webContents.removeListener('destroyed', handleUnavailable);
    window.removeListener('closed', handleUnavailable);
  };
}
