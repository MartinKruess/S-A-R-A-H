import type { IpcMain } from 'electron';
import type { AppContext } from '../core/bootstrap.js';
import type { MessageBus } from '../core/message-bus.js';
import { VoiceService } from '../services/voice/voice-service.js';
import { forwardToRenderers } from './forward-to-renderers.js';
import { getService } from './ipc-helpers.js';
import {
  isValidAudioInput,
  isValidCaptureFailureInput,
  isValidCorrelationId,
  isValidInteractionMode,
  isValidPlaybackDoneInput,
  isValidPlaybackFailureInput,
} from './ipc-validation.js';

export interface VoiceHandlerDeps {
  getAppContext: () => AppContext;
  onChunk?: (captureId: string, chunk: Float32Array) => void;
}

export function registerVoiceHandlers(ipcMain: IpcMain, deps: VoiceHandlerDeps): () => void {
  const { getAppContext, onChunk } = deps;

  ipcMain.handle('voice-get-state', () => {
    return getService<VoiceService>(getAppContext(), 'voice').voiceStateSnapshot;
  });

  ipcMain.handle('voice-capture-failed', (_event, input: unknown) => {
    if (!isValidCaptureFailureInput(input)) {
      console.warn('[IPC] invalid payload for voice-capture-failed');
      return;
    }
    getService<VoiceService>(getAppContext(), 'voice').handleCaptureFailure(
      input.captureId,
      input.message,
    );
  });

  ipcMain.handle('voice-playback-done', (_event, input: { turnId: string; playbackId: string }) => {
    if (!isValidPlaybackDoneInput(input)) {
      console.warn('[IPC] invalid payload for voice-playback-done');
      return;
    }
    getAppContext().bus.emit('renderer', 'voice:playback-done', input);
  });

  ipcMain.handle('voice-playback-failed', (_event, input: unknown) => {
    if (!isValidPlaybackFailureInput(input)) {
      console.warn('[IPC] invalid payload for voice-playback-failed');
      return;
    }
    getService<VoiceService>(getAppContext(), 'voice').handlePlaybackFailure(
      input.turnId,
      input.playbackId,
      input.message,
    );
  });

  ipcMain.handle('voice-set-capture-ready', (_event, ready: unknown) => {
    if (typeof ready !== 'boolean') {
      console.warn('[IPC] invalid payload for voice-set-capture-ready');
      return;
    }
    getService<VoiceService>(getAppContext(), 'voice').setRendererCaptureReady(ready);
  });

  ipcMain.handle('voice-audio-chunk', (_event, input: { captureId: string; chunk: number[] }) => {
    if (!isValidAudioInput(input)) {
      console.warn('[IPC] invalid payload for voice-audio-chunk');
      return;
    }
    const samples = new Float32Array(input.chunk);
    const accepted = getService<VoiceService>(getAppContext(), 'voice')
      .feedAudioChunk(input.captureId, samples);
    if (accepted && onChunk) onChunk(input.captureId, samples);
  });

  ipcMain.handle('voice-capture-flushed', (_event, input: { captureId: string }) => {
    if (!input || !isValidCorrelationId(input.captureId)) {
      console.warn('[IPC] invalid payload for voice-capture-flushed');
      return;
    }
    getService<VoiceService>(getAppContext(), 'voice').handleCaptureFlushed(input.captureId);
  });

  ipcMain.handle('voice-set-interaction-mode', (_event, mode: string) => {
    if (!isValidInteractionMode(mode)) {
      console.warn('[IPC] invalid payload for voice-set-interaction-mode');
      return;
    }
    getService<VoiceService>(getAppContext(), 'voice').setInteractionMode(mode);
  });

  ipcMain.handle('voice-config-changed', async () => {
    await getService<VoiceService>(getAppContext(), 'voice').applyConfig();
  });

  // Forward voice events to renderers
  const bus: MessageBus = getAppContext().bus;
  const unsubscribers = [
    forwardToRenderers(bus, 'voice:state'),
    forwardToRenderers(bus, 'voice:capture-flush-request'),
    forwardToRenderers(bus, 'voice:transcript'),
    forwardToRenderers(bus, 'voice:error'),
    forwardToRenderers(bus, 'voice:capability'),
    forwardToRenderers(bus, 'voice:play-audio'),
    forwardToRenderers(bus, 'voice:stop-playback'),
  ];

  return () => {
    for (const unsubscribe of unsubscribers) unsubscribe();
    for (const channel of [
      'voice-get-state',
      'voice-capture-failed',
      'voice-playback-done',
      'voice-playback-failed',
      'voice-set-capture-ready',
      'voice-audio-chunk',
      'voice-capture-flushed',
      'voice-set-interaction-mode',
      'voice-config-changed',
    ]) ipcMain.removeHandler(channel);
  };
}
