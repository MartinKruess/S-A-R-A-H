import type { IpcMain } from 'electron';
import type { AppContext } from '../core/bootstrap.js';
import type { MessageBus } from '../core/message-bus.js';
import { VoiceService } from '../services/voice/voice-service.js';
import { forwardToRenderers } from './forward-to-renderers.js';
import { getService } from './ipc-helpers.js';

export interface VoiceHandlerDeps {
  getAppContext: () => AppContext;
  onChunk?: (chunk: Float32Array) => void;
}

export function registerVoiceHandlers(ipcMain: IpcMain, deps: VoiceHandlerDeps): void {
  const { getAppContext, onChunk } = deps;

  ipcMain.handle('voice-get-state', () => {
    return getService<VoiceService>(getAppContext(), 'voice').voiceState;
  });

  ipcMain.handle('voice-playback-done', () => {
    getAppContext().bus.emit('renderer', 'voice:playback-done', {});
  });

  ipcMain.handle('voice-audio-chunk', (_event, chunk: number[]) => {
    const samples = new Float32Array(chunk);
    getService<VoiceService>(getAppContext(), 'voice').feedAudioChunk(samples);
    if (onChunk) onChunk(samples);
  });

  ipcMain.handle('voice-set-interaction-mode', (_event, mode: string) => {
    getService<VoiceService>(getAppContext(), 'voice').setInteractionMode(mode as 'chat' | 'voice');
  });

  ipcMain.handle('voice-config-changed', async () => {
    await getService<VoiceService>(getAppContext(), 'voice').applyConfig();
  });

  // Forward voice events to renderers
  const bus: MessageBus = getAppContext().bus;
  forwardToRenderers(bus, 'voice:state');
  forwardToRenderers(bus, 'voice:listening');
  forwardToRenderers(bus, 'voice:transcript');
  forwardToRenderers(bus, 'voice:speaking');
  forwardToRenderers(bus, 'voice:done');
  forwardToRenderers(bus, 'voice:error');
  forwardToRenderers(bus, 'voice:interrupted');
  forwardToRenderers(bus, 'voice:wake');
  forwardToRenderers(bus, 'voice:play-audio');
}
