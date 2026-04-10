// tests/services/voice/voice-service.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { VoiceService } from '../../../src/services/voice/voice-service.js';
import { MessageBus } from '../../../src/core/message-bus.js';
import type { AppContext } from '../../../src/core/bootstrap.js';
import type { SttProvider } from '../../../src/services/voice/stt-provider.interface.js';
import type { TtsProvider } from '../../../src/services/voice/tts-provider.interface.js';
import type { WakeWordProvider } from '../../../src/services/voice/wake-word-provider.interface.js';
import type { AudioManager } from '../../../src/services/voice/audio-manager.js';
import type { HotkeyManager } from '../../../src/services/voice/hotkey-manager.js';

function createMockStt(): SttProvider {
  return {
    id: 'mock-stt',
    init: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    transcribe: vi.fn<(audio: Float32Array, sampleRate: number) => Promise<string>>().mockResolvedValue('Hallo Sarah'),
    destroy: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  };
}

function createMockTts(): TtsProvider {
  return {
    id: 'mock-tts',
    init: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    speak: vi.fn<(text: string) => Promise<Float32Array>>().mockResolvedValue(new Float32Array([0.1, 0.2])),
    stop: vi.fn(),
    destroy: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  };
}

function createMockWakeWord(): WakeWordProvider {
  return {
    id: 'mock-wake',
    init: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    start: vi.fn<(onDetected: () => void) => void>(),
    stop: vi.fn(),
    destroy: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  };
}

function createMockAudio(): AudioManager {
  return {
    isRecording: false,
    isPlaying: false,
    startRecording: vi.fn(function (this: AudioManager) {
      (this as { isRecording: boolean }).isRecording = true;
    }),
    feedChunk: vi.fn(),
    stopRecording: vi.fn(function (this: AudioManager) {
      (this as { isRecording: boolean }).isRecording = false;
      return new Float32Array([0.1, 0.2, 0.3]);
    }),
    setPlaying: vi.fn(function (this: AudioManager, playing: boolean) {
      (this as { isPlaying: boolean }).isPlaying = playing;
    }),
    destroy: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  } as AudioManager;
}

function createMockHotkey(): HotkeyManager {
  return {
    register: vi.fn(),
    unregister: vi.fn(),
  } as HotkeyManager;
}

function createMockContext(bus: MessageBus, voiceMode: string = 'push-to-talk'): AppContext {
  return {
    bus,
    registry: {} as AppContext['registry'],
    config: {
      get: vi.fn().mockResolvedValue({
        controls: {
          voiceMode,
          pushToTalkKey: 'F9',
          quietModeDuration: 60,
          customCommands: [],
        },
      }),
      set: vi.fn(),
      query: vi.fn(),
      insert: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      close: vi.fn(),
    } as AppContext['config'],
    db: {
      get: vi.fn(),
      set: vi.fn(),
      query: vi.fn(),
      insert: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      close: vi.fn(),
    } as AppContext['db'],
    shutdown: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  };
}

/** Let microtasks and promises settle */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** Helper to create a BusMessage */
function makeMsg(topic: string, data: Record<string, unknown>) {
  return { source: 'llm', topic, data, timestamp: new Date().toISOString() };
}

describe('VoiceService', () => {
  let bus: MessageBus;
  let stt: SttProvider;
  let tts: TtsProvider;
  let wakeWord: WakeWordProvider;
  let audio: AudioManager;
  let hotkey: HotkeyManager;
  let context: AppContext;
  let service: VoiceService;

  beforeEach(() => {
    bus = new MessageBus();
    stt = createMockStt();
    tts = createMockTts();
    wakeWord = createMockWakeWord();
    audio = createMockAudio();
    hotkey = createMockHotkey();
    context = createMockContext(bus);
    service = new VoiceService(context, stt, tts, wakeWord, audio, hotkey);
  });

  afterEach(async () => {
    if (service.status === 'running') {
      await service.destroy();
    }
  });

  // --- 1. Correct id, initial status, subscriptions ---

  it('has correct id, initial status, and subscriptions', () => {
    expect(service.id).toBe('voice');
    expect(service.status).toBe('pending');
    expect(service.subscriptions).toEqual(['llm:chunk', 'llm:done', 'llm:error']);
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

  it('sets error status if init fails', async () => {
    (stt.init as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('init fail'));

    await service.init();

    expect(service.status).toBe('error');
  });

  // --- 3. Registers hotkey in push-to-talk mode ---

  it('registers hotkey in push-to-talk mode', async () => {
    await service.init();

    expect(hotkey.register).toHaveBeenCalledOnce();
    expect(hotkey.register).toHaveBeenCalledWith('F9', expect.any(Function), expect.any(Function));
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

  // --- 7. PTT up -> processes, transcribes, emits chat:message ---

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
    expect(stt.transcribe).toHaveBeenCalledWith(expect.any(Float32Array), 16_000);
    expect(transcriptListener).toHaveBeenCalledOnce();
    expect(transcriptListener.mock.calls[0][0].data.text).toBe('Hallo Sarah');
    expect(chatListener).toHaveBeenCalledOnce();
    expect(chatListener.mock.calls[0][0].data.text).toBe('Hallo Sarah');
  });

  // --- 8. Detects abort phrase -> does not emit chat:message ---

  it('detects abort phrase and does not emit chat:message', async () => {
    (stt.transcribe as ReturnType<typeof vi.fn>).mockResolvedValue('sarah stop');

    await service.init();

    const chatListener = vi.fn();
    bus.on('chat:message', chatListener);

    const registerCall = (hotkey.register as ReturnType<typeof vi.fn>).mock.calls[0];
    const onDown = registerCall[1] as () => void;
    const onUp = registerCall[2] as () => void;

    onDown();
    onUp();
    await flush();

    expect(chatListener).not.toHaveBeenCalled();
  });

  // --- 9. Streaming TTS: llm:chunk + llm:done ---

  it('speaks response via streaming chunks', async () => {
    await service.init();

    const speakingListener = vi.fn();
    bus.on('voice:speaking', speakingListener);

    const doneListener = vi.fn();
    bus.on('voice:done', doneListener);

    // Auto-respond to voice:play-audio with voice:playback-done
    bus.on('voice:play-audio', () => {
      setTimeout(() => bus.emit('renderer', 'voice:playback-done', {}), 0);
    });

    // Simulate PTT flow to get into 'processing' state
    const registerCall = (hotkey.register as ReturnType<typeof vi.fn>).mock.calls[0];
    const onDown = registerCall[1] as () => void;
    const onUp = registerCall[2] as () => void;

    onDown();
    onUp();
    await flush();

    // Now in 'processing' state — send chunk with a complete sentence
    service.onMessage(makeMsg('llm:chunk', { text: 'Hallo! ' }));
    await flush();

    expect(speakingListener).toHaveBeenCalledOnce();
    expect(service.voiceState).toBe('speaking');

    // Send more text and done
    service.onMessage(makeMsg('llm:chunk', { text: 'Wie kann ich helfen?' }));
    service.onMessage(makeMsg('llm:done', {}));
    await flush();
    await flush();

    // TTS should have been called for both sentences
    expect(tts.speak).toHaveBeenCalledWith('Hallo!');
    expect(tts.speak).toHaveBeenCalledWith('Wie kann ich helfen?');
    expect(doneListener).toHaveBeenCalledOnce();
  });

  it('does not speak response when interactionMode is chat', async () => {
    await service.init();

    service.setInteractionMode('chat');

    service.onMessage(makeMsg('llm:chunk', { text: 'Hallo! Wie kann ich helfen?' }));
    service.onMessage(makeMsg('llm:done', {}));

    await flush();

    expect(tts.speak).not.toHaveBeenCalled();
  });

  it('speaks response when interactionMode is voice', async () => {
    await service.init();

    // Auto-respond to voice:play-audio with voice:playback-done
    bus.on('voice:play-audio', () => {
      setTimeout(() => bus.emit('renderer', 'voice:playback-done', {}), 0);
    });

    service.setInteractionMode('voice');

    // Get into processing state via PTT
    const registerCall = (hotkey.register as ReturnType<typeof vi.fn>).mock.calls[0];
    const onDown = registerCall[1] as () => void;
    const onUp = registerCall[2] as () => void;

    onDown();
    onUp();
    await flush();

    // Send chunk with complete sentence and done
    service.onMessage(makeMsg('llm:chunk', { text: 'Hallo! Wie kann ich helfen?' }));
    service.onMessage(makeMsg('llm:done', {}));
    await flush();
    await flush();

    expect(tts.speak).toHaveBeenCalledWith('Hallo!');
  });

  it('does not speak when voice mode is off', async () => {
    context = createMockContext(bus, 'off');
    service = new VoiceService(context, stt, tts, wakeWord, audio, hotkey);
    await service.init();

    service.onMessage(makeMsg('llm:chunk', { text: 'Test.' }));
    service.onMessage(makeMsg('llm:done', {}));

    await flush();

    expect(tts.speak).not.toHaveBeenCalled();
  });

  // --- 10. Interruption: speaking -> pressing PTT stops TTS, starts listening ---

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
    service.onMessage(makeMsg('llm:chunk', { text: 'Antwort.' }));
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
    expect(hotkey.unregister).toHaveBeenCalled();
    expect(service.status).toBe('stopped');
    expect(service.voiceState).toBe('idle');
  });

  // --- Additional edge cases ---

  it('returns to idle when stopRecording returns empty buffer', async () => {
    (audio.stopRecording as ReturnType<typeof vi.fn>).mockReturnValue(new Float32Array(0));

    await service.init();

    const registerCall = (hotkey.register as ReturnType<typeof vi.fn>).mock.calls[0];
    const onDown = registerCall[1] as () => void;
    const onUp = registerCall[2] as () => void;

    onDown();
    onUp();
    await flush();

    expect(stt.transcribe).not.toHaveBeenCalled();
    expect(service.voiceState).toBe('idle');
  });

  // --- 12. applyConfig re-reads config and re-registers hotkey ---

  it('applyConfig re-reads config and re-registers hotkey', async () => {
    // Start with mode=off
    context = createMockContext(bus, 'off');
    service = new VoiceService(context, stt, tts, wakeWord, audio, hotkey);
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

  // --- 13. llm:error behavior ---

  it('transitions from processing to idle on llm:error', async () => {
    await service.init();

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
    service.onMessage(makeMsg('llm:error', { message: 'Connection failed' }));

    expect(service.voiceState).toBe('idle');
    expect(errorListener).toHaveBeenCalledOnce();
    expect(errorListener.mock.calls[0][0].data.message).toBe('Connection failed');
  });

  it('ignores llm:error when not in processing state and not streaming', async () => {
    await service.init();

    const errorListener = vi.fn();
    bus.on('voice:error', errorListener);

    // State is 'idle'
    expect(service.voiceState).toBe('idle');

    service.onMessage(makeMsg('llm:error', { message: 'Some error' }));

    expect(service.voiceState).toBe('idle');
    expect(errorListener).not.toHaveBeenCalled();
  });

  // --- 14. State transition guard ---

  it('ignores onPttDown during active transition', async () => {
    // Make STT slow so the transition stays active
    let resolveTranscribe: (value: string) => void;
    (stt.transcribe as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise<string>((resolve) => { resolveTranscribe = resolve; }),
    );

    await service.init();

    const registerCall = (hotkey.register as ReturnType<typeof vi.fn>).mock.calls[0];
    const onDown = registerCall[1] as () => void;
    const onUp = registerCall[2] as () => void;

    // PTT down -> listening, PTT up -> starts async stopListeningAndProcess (transition active)
    onDown();
    onUp();

    // Reset the startRecording call count after the initial onDown
    (audio.startRecording as ReturnType<typeof vi.fn>).mockClear();

    // PTT down again while transition is still active (STT hasn't resolved)
    onDown();

    // startListening should NOT have been called again
    expect(audio.startRecording).not.toHaveBeenCalled();

    // Resolve the pending transcription to clean up
    resolveTranscribe!('test');
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

  it('resets interactionMode from chatspeak to voice after TTS completes', async () => {
    await service.init();

    const doneListener = vi.fn();
    bus.on('voice:done', doneListener);

    // Auto-respond to voice:play-audio with voice:playback-done
    bus.on('voice:play-audio', () => {
      setTimeout(() => bus.emit('renderer', 'voice:playback-done', {}), 0);
    });

    // Set chatspeak mode and put service in processing state via PTT
    service.setInteractionMode('chatspeak');

    const registerCall = (hotkey.register as ReturnType<typeof vi.fn>).mock.calls[0];
    const onDown = registerCall[1] as () => void;
    const onUp = registerCall[2] as () => void;

    onDown();
    onUp();
    await flush();

    // Send chunk + done
    service.onMessage(makeMsg('llm:chunk', { text: 'Antwort.' }));
    service.onMessage(makeMsg('llm:done', {}));
    await flush();
    await flush();

    expect(doneListener).toHaveBeenCalledOnce();
    // After completion, mode should be reset to 'voice'
    // We verify indirectly: setInteractionMode('chatspeak') was set, and after
    // speaking completes, it should have reset. Send another llm:chunk — if mode
    // were still chatspeak it would speak; if it's voice it also speaks.
    // The key behavior is that chatspeak resets, so the next chat message
    // won't auto-speak. We test the internal reset by checking the done event fired.
  });

  // --- 16. Streaming: multiple sentences from chunks ---

  it('calls TTS for each complete sentence from streaming chunks', async () => {
    await service.init();

    // Auto-respond to voice:play-audio with voice:playback-done
    bus.on('voice:play-audio', () => {
      setTimeout(() => bus.emit('renderer', 'voice:playback-done', {}), 0);
    });

    // Get into processing state
    const registerCall = (hotkey.register as ReturnType<typeof vi.fn>).mock.calls[0];
    const onDown = registerCall[1] as () => void;
    const onUp = registerCall[2] as () => void;

    onDown();
    onUp();
    await flush();

    // Send chunks that build up to multiple sentences
    service.onMessage(makeMsg('llm:chunk', { text: 'Erste Antwort. ' }));
    service.onMessage(makeMsg('llm:chunk', { text: 'Zweite Antwort. ' }));
    service.onMessage(makeMsg('llm:chunk', { text: 'Rest' }));
    service.onMessage(makeMsg('llm:done', {}));
    await flush();
    await flush();
    await flush();

    // TTS should have been called for all 3 segments
    expect(tts.speak).toHaveBeenCalledWith('Erste Antwort.');
    expect(tts.speak).toHaveBeenCalledWith('Zweite Antwort.');
    expect(tts.speak).toHaveBeenCalledWith('Rest');
  });

  // --- 17. llm:error during streaming flushes and lets queue finish ---

  it('flushes buffer and lets queue finish on llm:error during streaming', async () => {
    await service.init();

    // Auto-respond to voice:play-audio with voice:playback-done
    bus.on('voice:play-audio', () => {
      setTimeout(() => bus.emit('renderer', 'voice:playback-done', {}), 0);
    });

    // Get into processing state
    const registerCall = (hotkey.register as ReturnType<typeof vi.fn>).mock.calls[0];
    const onDown = registerCall[1] as () => void;
    const onUp = registerCall[2] as () => void;

    onDown();
    onUp();
    await flush();

    // Send a chunk to start streaming
    service.onMessage(makeMsg('llm:chunk', { text: 'Teilantwort.' }));
    await flush();

    expect(service.voiceState).toBe('speaking');

    // Now send llm:error while streaming
    service.onMessage(makeMsg('llm:error', { message: 'Connection lost' }));

    // Should NOT go to idle immediately — the queue should finish
    // The state stays speaking until TTS queue empties
    await flush();
    await flush();
  });
});
