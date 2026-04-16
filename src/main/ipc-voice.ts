import type { IpcMain } from 'electron';
import type { AppContext } from '../core/bootstrap.js';
import type { MessageBus } from '../core/message-bus.js';
import { VoiceService } from '../services/voice/voice-service.js';
import { forwardToRenderers } from './forward-to-renderers.js';

export interface VoiceHandlerDeps {
  getAppContext: () => AppContext;
}

export function registerVoiceHandlers(ipcMain: IpcMain, deps: VoiceHandlerDeps): void {
  const { getAppContext } = deps;

  ipcMain.handle('voice-get-state', () => {
    const voiceService = getAppContext().registry.get('voice');
    if (!voiceService || !(voiceService instanceof VoiceService)) return 'idle';
    return voiceService.voiceState;
  });

  ipcMain.handle('voice-playback-done', () => {
    getAppContext().bus.emit('renderer', 'voice:playback-done', {});
  });

  ipcMain.handle('voice-audio-chunk', (_event, chunk: number[]) => {
    const voiceService = getAppContext().registry.get('voice');
    if (voiceService && voiceService instanceof VoiceService) {
      voiceService.feedAudioChunk(new Float32Array(chunk));
    }
  });

  ipcMain.handle('voice-set-interaction-mode', (_event, mode: string) => {
    const voiceService = getAppContext().registry.get('voice');
    if (voiceService && voiceService instanceof VoiceService) {
      voiceService.setInteractionMode(mode as 'chat' | 'voice');
    }
  });

  ipcMain.handle('voice-config-changed', async () => {
    const voiceService = getAppContext().registry.get('voice');
    if (voiceService && voiceService instanceof VoiceService) {
      await voiceService.applyConfig();
    }
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
