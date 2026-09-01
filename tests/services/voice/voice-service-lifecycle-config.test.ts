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

describe('VoiceService (lifecycle & configuration)', () => {
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

it('interrupts TTS when PTT is pressed while speaking', async () => {
    // Make TTS speak slowly so we can interrupt
    let resolveTts: (value: Float32Array) => void;
    (tts.speak as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise<Float32Array>((resolve) => { resolveTts = resolve; }),
    );

    await service.init();

    const interruptedListener = vi.fn();
    bus.on('voice:interrupted', interruptedListener);

    // Get into processing state
    const registerCall = (hotkey.register as ReturnType<typeof vi.fn>).mock.calls[0];
    const onDown = registerCall[1] as () => void;
    const onUp = registerCall[2] as () => void;

    onDown();
    onUp();
    await flush();

    // Send a chunk with a complete sentence to start speaking
    service.onMessage(makeMsg(service, bus, 'llm:chunk', { text: 'Antwort.' }));
    await flush();

    expect(service.voiceState).toBe('speaking');

    // PTT down while speaking
    onDown();

    expect(tts.stop).toHaveBeenCalled();
    expect(interruptedListener).toHaveBeenCalledOnce();
    expect(service.voiceState).toBe('listening');

    // Resolve the pending TTS to avoid unhandled rejection
    resolveTts!(new Float32Array(0));
    await flush();
  });

  // --- 11. Destroys all providers on destroy ---

  it('destroys all providers on destroy', async () => {
    await service.init();
    await service.destroy();

    expect(stt.destroy).toHaveBeenCalledOnce();
    expect(tts.destroy).toHaveBeenCalledOnce();
    expect(wakeWord.destroy).toHaveBeenCalledOnce();
    expect(audio.destroy).toHaveBeenCalledOnce();
    expect(hotkey.destroy).toHaveBeenCalledOnce();
    expect(service.status).toBe('stopped');
    expect(service.voiceState).toBe('idle');
  });

  it('rejects push-to-talk immediately when the router is unavailable', async () => {
    context.lifecycle = {
      acceptingWork: true,
      setCapability: vi.fn(),
      snapshot: {
        state: 'degraded',
        generation: 1,
        updatedAt: 1,
        capabilities: { router: { state: 'error', message: 'Docker offline' } },
      },
    } as AppContext['lifecycle'];
    await service.init();
    service.setInteractionMode('chat');

    const llmError = vi.fn();
    const playAudio = vi.fn();
    const stopPlayback = vi.fn();
    const transcript = vi.fn();
    const chatMessage = vi.fn();
    bus.on('llm:error', llmError);
    bus.on('voice:play-audio', playAudio);
    bus.on('voice:stop-playback', stopPlayback);
    bus.on('voice:transcript', transcript);
    bus.on('chat:message', chatMessage);
    const registerCall = (hotkey.register as ReturnType<typeof vi.fn>).mock.calls[0];
    const onDown = registerCall[1] as () => void;
    const onUp = registerCall[2] as () => void;

    onDown();
    onUp();
    await flush();

    expect(audio.startRecording).not.toHaveBeenCalled();
    expect(stt.transcribe).not.toHaveBeenCalled();
    expect(transcript).not.toHaveBeenCalled();
    expect(chatMessage).not.toHaveBeenCalled();
    expect(llmError).toHaveBeenCalledOnce();
    expect(tts.speak).toHaveBeenCalledWith(
      expect.stringContaining('nicht bereit'),
      expect.any(AbortSignal),
    );
    expect(playAudio).toHaveBeenCalledOnce();
    expect(service.voiceState).toBe('speaking');

    onDown();

    expect(llmError).toHaveBeenCalledOnce();
    expect(tts.speak).toHaveBeenCalledOnce();
    expect(stopPlayback).toHaveBeenCalledOnce();
    expect(service.voiceState).toBe('idle');
  });

  it('continues provider cleanup when one provider destroy fails', async () => {
    (stt.destroy as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('stt cleanup failed'));
    await service.init();

    await expect(service.destroy()).rejects.toThrow(/Voice provider cleanup failed/);

    expect(tts.destroy).toHaveBeenCalledOnce();
    expect(wakeWord.destroy).toHaveBeenCalledOnce();
    expect(audio.destroy).toHaveBeenCalledOnce();
    expect(service.status).toBe('stopped');
  });

  // --- Additional edge cases ---

  it('accepts and terminalizes an empty F9 capture exactly once', async () => {
    (audio.stopRecording as ReturnType<typeof vi.fn>).mockReturnValue(new Float32Array(0));

    await service.init();

    const acceptedListener = vi.fn();
    const terminalListener = vi.fn();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    bus.on('turn:accepted', acceptedListener);
    bus.on('turn:terminal', terminalListener);

    const registerCall = (hotkey.register as ReturnType<typeof vi.fn>).mock.calls[0];
    const onDown = registerCall[1] as () => void;
    const onUp = registerCall[2] as () => void;

    onDown();
    onUp();
    await flush();

    expect(stt.transcribe).not.toHaveBeenCalled();
    expect(service.voiceState).toBe('idle');
    expect(acceptedListener).toHaveBeenCalledOnce();
    expect(terminalListener).toHaveBeenCalledOnce();
    expect(terminalListener.mock.calls[0][0].data.status).toBe('canceled');
    expect(terminalListener.mock.calls[0][0].data.turnId).toBe(
      acceptedListener.mock.calls[0][0].data.turnId,
    );
    expect(warn).not.toHaveBeenCalledWith(
      '[MessageBus] terminal event for unknown turn refused:',
      expect.any(String),
    );
    warn.mockRestore();
  });

  // --- 12. applyConfig re-reads config and re-registers hotkey ---

  it('applyConfig re-reads config and re-registers hotkey', async () => {
    // Start with mode=off
    context = createMockContext(bus, 'off');
    service = new VoiceService(context, stt, tts, wakeWord, audio, hotkey);
    service.setRendererCaptureReady(true);
    await service.init();

    expect(hotkey.register).not.toHaveBeenCalled();

    // Change mock config to push-to-talk
    (context.config.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      controls: {
        voiceMode: 'push-to-talk',
        pushToTalkKey: 'F10',
        quietModeDuration: 60,
        customCommands: [],
      },
    });

    await service.applyConfig();

    expect(hotkey.unregister).toHaveBeenCalled();
    expect(hotkey.register).toHaveBeenCalledWith('F10', expect.any(Function), expect.any(Function));
    expect(service.voiceState).toBe('idle');
  });

  it('applyConfig cancels an active turn exactly once before changing the hotkey', async () => {
    await service.init();
    const terminals = vi.fn();
    bus.on('turn:terminal', terminals);
    const registerCall = (hotkey.register as ReturnType<typeof vi.fn>).mock.calls[0];
    const onDown = registerCall[1] as () => void;
    const onUp = registerCall[2] as () => void;
    onDown();
    onUp();
    await flush();
    const activeTurnId = (service as unknown as { processingTurnId: string }).processingTurnId;

    await service.applyConfig();

    const activeTurnTerminals = terminals.mock.calls.filter(([message]) => (
      message.data.turnId === activeTurnId
    ));
    expect(activeTurnTerminals).toHaveLength(1);
    expect(activeTurnTerminals[0][0].data.status).toBe('canceled');
    expect(bus.isTurnTerminal(activeTurnId)).toBe(true);
  });

  // --- 13. llm:error behavior ---

  it('speaks a router error once and returns to idle after its terminal playback drains', async () => {
    await service.init();
    autoCompletePlayback(bus);

    const errorListener = vi.fn();
    bus.on('voice:error', errorListener);

    const registerCall = (hotkey.register as ReturnType<typeof vi.fn>).mock.calls[0];
    const onDown = registerCall[1] as () => void;
    const onUp = registerCall[2] as () => void;

    // PTT down → listening, PTT up → processing
    onDown();
    onUp();
    await flush();

    // After transcription, state should be processing
    expect(service.voiceState).toBe('processing');

    // Simulate LLM error
    const errorMessage = makeMsg(service, bus, 'llm:error', { message: 'Connection failed' });
    service.onMessage(errorMessage);
    service.onMessage(errorMessage);

    expect(service.voiceState).toBe('speaking');
    expect(errorListener).not.toHaveBeenCalled();
    expect(tts.speak).toHaveBeenCalledTimes(1);
    expect(tts.speak).toHaveBeenCalledWith('Connection failed', expect.any(AbortSignal));

    const terminal = { turnId: errorMessage.data.turnId, status: 'error' as const, message: 'Connection failed' };
    bus.emit('router', 'turn:terminal', terminal);
    service.onMessage({
      source: 'router',
      topic: 'turn:terminal',
      data: terminal,
      timestamp: new Date().toISOString(),
    });
    await flush();
    await flush();
    expect(service.voiceState).toBe('idle');
  });

  it('ignores llm:error when not in processing state and not streaming', async () => {
    await service.init();

    const errorListener = vi.fn();
    bus.on('voice:error', errorListener);

    // State is 'idle'
    expect(service.voiceState).toBe('idle');

    service.onMessage(makeMsg(service, bus, 'llm:error', { message: 'Some error' }));

    expect(service.voiceState).toBe('idle');
    expect(errorListener).not.toHaveBeenCalled();
  });

  // --- 14. State transition guard ---

  it('interrupts processing and starts a fresh recording on a second PTT down', async () => {
    // Make STT slow so the transition stays active
    (stt.transcribe as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise<string>(() => {}),
    );

    await service.init();

    const registerCall = (hotkey.register as ReturnType<typeof vi.fn>).mock.calls[0];
    const onDown = registerCall[1] as () => void;
    const onUp = registerCall[2] as () => void;

    // PTT down -> listening, PTT up -> starts async stopListeningAndProcess (transition active)
    onDown();
    onUp();
    await flush();

    // Reset the startRecording call count after the initial onDown
    (audio.startRecording as ReturnType<typeof vi.fn>).mockClear();

    // PTT down again while STT is still active: Layer 1 treats this as barge-in.
    onDown();

    expect(audio.startRecording).toHaveBeenCalledOnce();

    await flush();
  });

  it('emits voice:transcript with transcription text', async () => {
    (stt.transcribe as ReturnType<typeof vi.fn>).mockResolvedValue('Teste Transkription');

    await service.init();

    const transcriptListener = vi.fn();
    bus.on('voice:transcript', transcriptListener);

    const registerCall = (hotkey.register as ReturnType<typeof vi.fn>).mock.calls[0];
    const onDown = registerCall[1] as () => void;
    const onUp = registerCall[2] as () => void;

    onDown();
    onUp();
    await flush();

    expect(transcriptListener).toHaveBeenCalledOnce();
    expect(transcriptListener.mock.calls[0][0].data.text).toBe('Teste Transkription');
  });

  // --- 15. Chatspeak mode ---
});
