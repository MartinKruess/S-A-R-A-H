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

describe('VoiceService (startup & capture)', () => {
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

it('has correct id, initial status, and subscriptions', () => {
    expect(service.id).toBe('voice');
    expect(service.status).toBe('pending');
    expect(service.subscriptions).toEqual([
      'turn:accepted',
      'chat:message',
      'turn:output-policy',
      'llm:chunk',
      'llm:done',
      'llm:error',
      'llm:filler',
      'voice:priority-speech',
      'voice:resume-speech',
      'voice:discard-paused-speech',
      'turn:terminal',
    ]);
    expect(service.voiceState).toBe('idle');
  });

  // --- 2. Initializes providers on init ---

  it('initializes STT and TTS on init (PTT mode)', async () => {
    await service.init();

    expect(stt.init).toHaveBeenCalledOnce();
    expect(tts.init).toHaveBeenCalledOnce();
    expect(wakeWord.init).not.toHaveBeenCalled(); // only in keyword mode
    expect(service.status).toBe('running');
  });

  it('shares concurrent and repeated initialization', async () => {
    await Promise.all([service.init(), service.init()]);
    await service.init();

    expect(stt.init).toHaveBeenCalledOnce();
    expect(tts.init).toHaveBeenCalledOnce();
    expect(hotkey.register).toHaveBeenCalledOnce();
  });

  it('stays running with degraded capability if only STT init fails', async () => {
    (stt.init as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('init fail'));

    await service.init();

    expect(service.status).toBe('running');
    expect(stt.destroy).toHaveBeenCalledOnce();
  });

  it('keeps a self-recovering STT provider alive after its initial attempt fails', async () => {
    let availabilityListener: ((state: { available: boolean; message?: string }) => void) | null = null;
    Object.defineProperty(stt, 'recoversAfterInitFailure', { value: true });
    stt.onAvailabilityChange = vi.fn((listener) => {
      availabilityListener = listener;
      return vi.fn();
    });
    (stt.init as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('transient init fail'));

    await service.init();

    expect(service.status).toBe('running');
    expect(stt.destroy).not.toHaveBeenCalled();
    expect(hotkey.register).toHaveBeenCalledOnce();

    availabilityListener!({ available: true });
    expect(hotkey.register).toHaveBeenCalledWith('F9', expect.any(Function), expect.any(Function));
  });

  // --- 3. Registers hotkey in push-to-talk mode ---

  it('registers hotkey in push-to-talk mode', async () => {
    await service.init();

    expect(hotkey.register).toHaveBeenCalledOnce();
    expect(hotkey.register).toHaveBeenCalledWith('F9', expect.any(Function), expect.any(Function));
  });

  it('keeps PTT unavailable until the renderer capture graph is ready', async () => {
    service.setRendererCaptureReady(false);
    await service.init();

    expect(hotkey.register).not.toHaveBeenCalled();

    service.setRendererCaptureReady(true);
    expect(hotkey.register).toHaveBeenCalledWith('F9', expect.any(Function), expect.any(Function));

    service.setRendererCaptureReady(false);
    expect(hotkey.unregister).toHaveBeenCalledOnce();
  });

  it('rejects a stale PTT callback instead of opening an unready capture', async () => {
    const errors: Array<{ message: string }> = [];
    bus.on('voice:error', (message) => {
      errors.push(message.data);
    });
    await service.init();
    const onDown = (hotkey.register as ReturnType<typeof vi.fn>).mock.calls[0][1] as () => void;

    service.setRendererCaptureReady(false);
    onDown();

    expect(audio.startRecording).not.toHaveBeenCalled();
    expect(errors).toEqual([
      { message: 'Das Mikrofon wird noch vorbereitet. Bitte versuche es gleich noch einmal.' },
    ]);
  });

  // --- 4. Keyword mode falls back to off ---

  it('treats keyword mode as off (non-functional)', async () => {
    context = createMockContext(bus, 'keyword');
    service = new VoiceService(context, stt, tts, wakeWord, audio, hotkey);

    await service.init();

    expect(wakeWord.init).not.toHaveBeenCalled();
    expect(wakeWord.start).not.toHaveBeenCalled();
    expect(hotkey.register).not.toHaveBeenCalled();
  });

  // --- 5. Does nothing when voice is off ---

  it('does nothing when voice mode is off', async () => {
    context = createMockContext(bus, 'off');
    service = new VoiceService(context, stt, tts, wakeWord, audio, hotkey);
    service.setRendererCaptureReady(true);

    await service.init();

    expect(hotkey.register).not.toHaveBeenCalled();
    expect(wakeWord.start).not.toHaveBeenCalled();
    expect(service.status).toBe('running');
  });

  // --- 6. PTT down -> listening state, starts recording ---

  it('transitions to listening state on PTT down', async () => {
    await service.init();

    // Get the onDown callback from hotkey.register
    const registerCall = (hotkey.register as ReturnType<typeof vi.fn>).mock.calls[0];
    const onDown = registerCall[1] as () => void;

    onDown();

    expect(service.voiceState).toBe('listening');
    expect(audio.startRecording).toHaveBeenCalled();
  });

  it('emits voice:listening on PTT down', async () => {
    await service.init();

    const listener = vi.fn();
    bus.on('voice:listening', listener);

    const registerCall = (hotkey.register as ReturnType<typeof vi.fn>).mock.calls[0];
    const onDown = registerCall[1] as () => void;

    onDown();

    expect(listener).toHaveBeenCalledOnce();
  });

  it('returns the active captureId in the current voice state snapshot', async () => {
    await service.init();
    const listening = vi.fn();
    bus.on('voice:listening', listening);
    const registerCall = (hotkey.register as ReturnType<typeof vi.fn>).mock.calls[0];
    const onDown = registerCall[1] as () => void;

    onDown();

    const listeningEvent = listening.mock.calls[0][0].data;
    expect(service.voiceStateSnapshot).toEqual({
      state: 'listening',
      turnId: listeningEvent.turnId,
      captureId: listeningEvent.captureId,
    });
  });

  it('ends only the listening turn whose renderer capture failed', async () => {
    await service.init();
    const voiceError = vi.fn();
    const terminal = vi.fn();
    bus.on('voice:error', voiceError);
    bus.on('turn:terminal', terminal);
    const registerCall = (hotkey.register as ReturnType<typeof vi.fn>).mock.calls[0];
    const onDown = registerCall[1] as () => void;
    onDown();
    const snapshot = service.voiceStateSnapshot;

    service.handleCaptureFailure(randomUUID(), 'stale capture');
    expect(service.voiceState).toBe('listening');
    expect(voiceError).not.toHaveBeenCalled();

    service.handleCaptureFailure(snapshot.captureId, 'Mikrofon konnte nicht gestartet werden.');

    expect(service.voiceState).toBe('idle');
    expect(audio.stopRecording).toHaveBeenCalledWith(snapshot.captureId);
    expect(voiceError).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        turnId: snapshot.turnId,
        message: 'Mikrofon konnte nicht gestartet werden.',
      }),
    }));
    expect(terminal).toHaveBeenCalledWith(expect.objectContaining({
      data: {
        turnId: snapshot.turnId,
        status: 'error',
        message: 'Mikrofon konnte nicht gestartet werden.',
      },
    }));
  });

  // --- 7. PTT up -> processes, transcribes, emits chat:message ---
});
