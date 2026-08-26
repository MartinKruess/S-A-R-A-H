import type { IpcMain } from 'electron';
import type { AppContext } from '../core/bootstrap.js';
import type { MessageBus } from '../core/message-bus.js';
import { VoiceService } from '../services/voice/voice-service.js';
import { forwardToRenderers } from './forward-to-renderers.js';
import { getService } from './ipc-helpers.js';
import {
  isValidAudioInput,
  isValidInteractionMode,
  isValidPlaybackDoneInput,
} from './ipc-validation.js';

export interface VoiceHandlerDeps {
  getAppContext: () => AppContext;
  onChunk?: (chunk: Float32Array) => void;
}

export function registerVoiceHandlers(ipcMain: IpcMain, deps: VoiceHandlerDeps): () => void {
  const { getAppContext, onChunk } = deps;

  ipcMain.handle('voice-get-state', () => {
    return getService<VoiceService>(getAppContext(), 'voice').voiceState;
  });

  ipcMain.handle('voice-playback-done', (_event, input: { turnId: string; playbackId: string }) => {
    if (!isValidPlaybackDoneInput(input)) {
      console.warn('[IPC] invalid payload for voice-playback-done');
      return;
    }
    getAppContext().bus.emit('renderer', 'voice:playback-done', input);
  });

  ipcMain.handle('voice-audio-chunk', (_event, input: { captureId: string; chunk: number[] }) => {
    if (!isValidAudioInput(input)) {
      console.warn('[IPC] invalid payload for voice-audio-chunk');
      return;
    }
    const samples = new Float32Array(input.chunk);
    getService<VoiceService>(getAppContext(), 'voice').feedAudioChunk(input.captureId, samples);
    if (onChunk) onChunk(samples);
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
    forwardToRenderers(bus, 'voice:transcript'),
    forwardToRenderers(bus, 'voice:error'),
    forwardToRenderers(bus, 'voice:capability'),
    forwardToRenderers(bus, 'voice:play-audio'),
  ];

  return () => {
    for (const unsubscribe of unsubscribers) unsubscribe();
    for (const channel of [
      'voice-get-state',
      'voice-playback-done',
      'voice-audio-chunk',
      'voice-set-interaction-mode',
      'voice-config-changed',
    ]) ipcMain.removeHandler(channel);
  };
}
