import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { VoiceService } from '../../../src/services/voice/voice-service.js';
import { MessageBus } from '../../../src/core/message-bus.js';
import type { AppContext } from '../../../src/core/bootstrap.js';
import type { SttProvider } from '../../../src/services/voice/stt-provider.interface.js';
import type { TtsProvider } from '../../../src/services/voice/tts-provider.interface.js';
import type { WakeWordProvider } from '../../../src/services/voice/wake-word-provider.interface.js';
import type { AudioManager } from '../../../src/services/voice/audio-manager.js';
import type { HotkeyManager } from '../../../src/services/voice/hotkey-manager.js';
import { STT_UNAVAILABLE_MESSAGE } from '../../../src/core/chat-availability.js';
import { randomUUID } from 'node:crypto';
import type { BusEvents } from '../../../src/core/bus-events.js';
import type { TypedBusMessage } from '../../../src/core/types.js';
import {
  acknowledgeCaptureFlushes,
  autoCompletePlayback,
  createMockAudio,
  createMockContext,
  createMockHotkey,
  createMockStt,
  createMockTts,
  createMockWakeWord,
  flush,
  makeDiscardPausedSpeechMsg,
  makeMsg,
  makePrioritySpeechMsg,
  makeResumeSpeechMsg,
  terminalizeActiveOutput,
} from './voice-service-test-harness.js';

describe('VoiceService (recognition)', () => {
  let bus: MessageBus;
  let stt: SttProvider;
  let tts: TtsProvider;
  let wakeWord: WakeWordProvider;
  let audio: AudioManager;
  let hotkey: HotkeyManager;
  let context: AppContext;
  let service: VoiceService;
  let autoFlushCapture: boolean;

  beforeEach(() => {
    bus = new MessageBus();
    stt = createMockStt();
    tts = createMockTts();
    wakeWord = createMockWakeWord();
    audio = createMockAudio();
    hotkey = createMockHotkey();
    context = createMockContext(bus);
    service = new VoiceService(context, stt, tts, wakeWord, audio, hotkey);
    autoFlushCapture = true;
    bus.on('voice:capture-flush-request', (message) => {
      if (autoFlushCapture) {
        queueMicrotask(() => service.handleCaptureFlushed(message.data.captureId));
      }
    });
    service.setRendererCaptureReady(true);
  });

  afterEach(async () => {
    if (service.status === 'running') {
      await service.destroy();
    }
  });

it('processes audio and emits chat:message on PTT up', async () => {
    await service.init();

    const chatListener = vi.fn();
    bus.on('chat:message', chatListener);

    const transcriptListener = vi.fn();
    bus.on('voice:transcript', transcriptListener);

    const registerCall = (hotkey.register as ReturnType<typeof vi.fn>).mock.calls[0];
    const onDown = registerCall[1] as () => void;
    const onUp = registerCall[2] as () => void;

    onDown();
    onUp();
    await flush();

    expect(audio.stopRecording).toHaveBeenCalled();
    expect(stt.transcribe).toHaveBeenCalledWith(
      expect.any(Float32Array),
      16_000,
      'de',
      expect.any(AbortSignal),
    );
    expect(transcriptListener).toHaveBeenCalledOnce();
    expect(transcriptListener.mock.calls[0][0].data.text).toBe('Hallo Sarah');
    expect(chatListener).toHaveBeenCalledOnce();
    expect(chatListener.mock.calls[0][0].data.originalText).toBe('Hallo Sarah');
  });

  it('does not snapshot the recording until the correlated renderer flush is acknowledged', async () => {
    autoFlushCapture = false;
    await service.init();
    const flushRequest = vi.fn();
    bus.on('voice:capture-flush-request', flushRequest);
    const registerCall = (hotkey.register as ReturnType<typeof vi.fn>).mock.calls[0];
    const onDown = registerCall[1] as () => void;
    const onUp = registerCall[2] as () => void;

    onDown();
    const captureId = service.voiceStateSnapshot.captureId;
    onUp();
    await Promise.resolve();

    expect(flushRequest).toHaveBeenCalledWith(expect.objectContaining({
      data: { captureId },
    }));
    expect(audio.stopRecording).not.toHaveBeenCalled();
    service.handleCaptureFlushed(captureId!);
    await flush();

    expect(audio.stopRecording).toHaveBeenCalledWith(captureId);
    expect(stt.transcribe).toHaveBeenCalledOnce();
  });

  it('terminally fails a turn instead of transcribing when its renderer flush fails', async () => {
    autoFlushCapture = false;
    await service.init();
    const terminals: Array<{ turnId: string; status: string; message?: string }> = [];
    bus.on('turn:terminal', (message) => terminals.push(message.data));
    const registerCall = (hotkey.register as ReturnType<typeof vi.fn>).mock.calls[0];
    const onDown = registerCall[1] as () => void;
    const onUp = registerCall[2] as () => void;

    onDown();
    const snapshot = service.voiceStateSnapshot;
    onUp();
    await Promise.resolve();
    service.handleCaptureFailure(snapshot.captureId, 'Capture flush failed');
    await flush();

    expect(stt.transcribe).not.toHaveBeenCalled();
    expect(audio.stopRecording).toHaveBeenCalledWith(snapshot.captureId);
    expect(terminals).toEqual([{
      turnId: snapshot.turnId,
      status: 'error',
      message: 'Capture flush failed',
    }]);
    expect(service.voiceState).toBe('idle');
  });

  // --- 8. Detects abort phrase -> does not emit chat:message ---

  it('detects abort phrase and does not emit chat:message', async () => {
    (stt.transcribe as ReturnType<typeof vi.fn>).mockResolvedValue('sarah stop');

    await service.init();

    const chatListener = vi.fn();
    const terminalListener = vi.fn();
    bus.on('chat:message', chatListener);
    bus.on('turn:terminal', terminalListener);

    const registerCall = (hotkey.register as ReturnType<typeof vi.fn>).mock.calls[0];
    const onDown = registerCall[1] as () => void;
    const onUp = registerCall[2] as () => void;

    onDown();
    onUp();
    await flush();

    expect(chatListener).not.toHaveBeenCalled();
    expect(terminalListener).toHaveBeenCalledOnce();
    expect(terminalListener.mock.calls[0][0].data.status).toBe('canceled');
    expect(bus.isTurnTerminal(terminalListener.mock.calls[0][0].data.turnId)).toBe(true);
  });

  // --- 9. Streaming TTS: llm:chunk + llm:done ---
});
