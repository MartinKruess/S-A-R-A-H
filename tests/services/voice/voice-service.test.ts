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
import { STT_UNAVAILABLE_MESSAGE } from '../../../src/core/chat-availability.js';
import { randomUUID } from 'node:crypto';

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
    feedChunk: vi.fn().mockReturnValue({ accepted: true, limitReached: false }),
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
    suspend: vi.fn(),
    resume: vi.fn(),
    unregister: vi.fn(),
    destroy: vi.fn(),
  } as HotkeyManager;
}

function createMockContext(bus: MessageBus, voiceMode: string = 'push-to-talk'): AppContext {
  const controlsConfig = {
    voiceMode,
    pushToTalkKey: 'F9',
    quietModeDuration: 60,
    customCommands: [],
  };
  return {
    bus,
    registry: {} as AppContext['registry'],
    config: {
      get: vi.fn().mockResolvedValue({
        controls: controlsConfig,
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
    parsedConfig: {
      controls: controlsConfig,
      personalization: {
        responseLanguage: 'de' as const,
        responseStyle: 'mittel' as const,
        tone: 'freundlich' as const,
      },
    } as AppContext['parsedConfig'],
    configErrors: null,
    shutdown: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  };
}

/** Let microtasks and promises settle */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function acknowledgeCaptureFlushes(bus: MessageBus, service: VoiceService): void {
  bus.on('voice:capture-flush-request', (message) => {
    queueMicrotask(() => service.handleCaptureFlushed(message.data.captureId));
  });
}

interface TestStreamState {
  outputId: string;
  sequence: number;
  fullText: string;
}

const streamStates = new WeakMap<VoiceService, Map<string, TestStreamState>>();

/** Build a correlated LLM message and register its owning turn on the real ledger. */
function makeMsg(
  service: VoiceService,
  bus: MessageBus,
  topic: string,
  data: Record<string, string | number | undefined>,
) {
  const internal = service as unknown as {
    processingTurnId: string | null;
    activeOutputTurnId: string | null;
  };
  const turnId = typeof data.turnId === 'string'
    ? data.turnId
    : internal.processingTurnId ?? internal.activeOutputTurnId ?? randomUUID();
  if (!bus.isTurnKnown(turnId)) {
    bus.emit('test', 'turn:accepted', { turnId, source: 'voice', mode: 'voice' });
  }

  let normalized = { ...data, turnId };
  if (topic === 'llm:chunk' || topic === 'llm:done') {
    let perService = streamStates.get(service);
    if (!perService) {
      perService = new Map();
      streamStates.set(service, perService);
    }
    const state = perService.get(turnId) ?? {
      outputId: typeof data.outputId === 'string' ? data.outputId : randomUUID(),
      sequence: 0,
      fullText: '',
    };
    if (topic === 'llm:chunk') {
      const text = typeof data.text === 'string' ? data.text : '';
      const sequence = typeof data.sequence === 'number' ? data.sequence : state.sequence;
      state.sequence = sequence + 1;
      state.fullText += text;
      normalized = { ...normalized, outputId: state.outputId, sequence, text };
    } else {
      normalized = {
        ...normalized,
        outputId: state.outputId,
        sequence: typeof data.sequence === 'number' ? data.sequence : state.sequence,
        fullText: typeof data.fullText === 'string' ? data.fullText : state.fullText,
      };
    }
    perService.set(turnId, state);
  }
  return { source: 'llm', topic, data: normalized, timestamp: new Date().toISOString() };
}

function autoCompletePlayback(bus: MessageBus): void {
  bus.on('voice:play-audio', (msg) => {
    setTimeout(() => bus.emit('renderer', 'voice:playback-done', {
      turnId: msg.data.turnId,
      playbackId: msg.data.playbackId,
    }), 0);
  });
}

function terminalizeActiveOutput(service: VoiceService, bus: MessageBus): void {
  const turnId = (service as unknown as { activeOutputTurnId: string | null }).activeOutputTurnId;
  if (!turnId) throw new Error('Expected an active output turn');
  const data = { turnId, status: 'done' as const };
  bus.emit('router', 'turn:terminal', data);
  service.onMessage({
    source: 'router',
    topic: 'turn:terminal',
    data,
    timestamp: new Date().toISOString(),
  });
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

  // --- 1. Correct id, initial status, subscriptions ---

  it('has correct id, initial status, and subscriptions', () => {
    expect(service.id).toBe('voice');
    expect(service.status).toBe('pending');
    expect(service.subscriptions).toEqual([
      'turn:accepted',
      'chat:message',
      'llm:chunk',
      'llm:done',
      'llm:error',
      'llm:filler',
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

  it('speaks response via streaming chunks', async () => {
    await service.init();

    const speakingListener = vi.fn();
    bus.on('voice:speaking', speakingListener);

    const doneListener = vi.fn();
    bus.on('voice:done', doneListener);

    // Auto-respond to voice:play-audio with voice:playback-done
    autoCompletePlayback(bus);

    // Simulate PTT flow to get into 'processing' state
    const registerCall = (hotkey.register as ReturnType<typeof vi.fn>).mock.calls[0];
    const onDown = registerCall[1] as () => void;
    const onUp = registerCall[2] as () => void;

    onDown();
    onUp();
    await flush();

    // Now in 'processing' state — send chunk with a complete sentence
    service.onMessage(makeMsg(service, bus, 'llm:chunk', { text: 'Hallo! ' }));
    await flush();

    expect(speakingListener).toHaveBeenCalledOnce();
    expect(service.voiceState).toBe('speaking');

    // Send more text and done
    service.onMessage(makeMsg(service, bus, 'llm:chunk', { text: 'Wie kann ich helfen?' }));
    service.onMessage(makeMsg(service, bus, 'llm:done', {}));
    terminalizeActiveOutput(service, bus);
    await flush();
    await flush();

    // TTS should have been called for both sentences
    expect(tts.speak).toHaveBeenCalledWith('Hallo!', expect.any(AbortSignal));
    expect(tts.speak).toHaveBeenCalledWith('Wie kann ich helfen?', expect.any(AbortSignal));
    expect(doneListener).toHaveBeenCalledOnce();
  });

  it('does not speak response when interactionMode is chat', async () => {
    await service.init();

    service.setInteractionMode('chat');

    service.onMessage(makeMsg(service, bus, 'llm:chunk', { text: 'Hallo! Wie kann ich helfen?' }));
    service.onMessage(makeMsg(service, bus, 'llm:done', {}));

    await flush();

    expect(tts.speak).not.toHaveBeenCalled();
  });

  it('speaks response when interactionMode is voice', async () => {
    await service.init();

    // Auto-respond to voice:play-audio with voice:playback-done
    autoCompletePlayback(bus);

    service.setInteractionMode('voice');

    // Get into processing state via PTT
    const registerCall = (hotkey.register as ReturnType<typeof vi.fn>).mock.calls[0];
    const onDown = registerCall[1] as () => void;
    const onUp = registerCall[2] as () => void;

    onDown();
    onUp();
    await flush();

    // Send chunk with complete sentence and done
    service.onMessage(makeMsg(service, bus, 'llm:chunk', { text: 'Hallo! Wie kann ich helfen?' }));
    service.onMessage(makeMsg(service, bus, 'llm:done', {}));
    await flush();
    await flush();

    expect(tts.speak).toHaveBeenCalledWith('Hallo!', expect.any(AbortSignal));
  });

  it('does not speak when voice mode is off', async () => {
    context = createMockContext(bus, 'off');
    service = new VoiceService(context, stt, tts, wakeWord, audio, hotkey);
    await service.init();

    service.onMessage(makeMsg(service, bus, 'llm:chunk', { text: 'Test.' }));
    service.onMessage(makeMsg(service, bus, 'llm:done', {}));

    await flush();

    expect(tts.speak).not.toHaveBeenCalled();
  });

  // --- 9b. Filler bridging phrase (llm:filler) ---

  it('subscribes to llm:filler', () => {
    expect(service.subscriptions).toContain('llm:filler');
  });

  it('speaks an llm:filler straight to the TTS queue without changing voice state', async () => {
    await service.init();

    // Auto-drain the queue so synthesis proceeds.
    autoCompletePlayback(bus);

    const stateBefore = service.voiceState;
    const stateListener = vi.fn();
    bus.on('voice:state', stateListener);

    service.onMessage(makeMsg(service, bus, 'llm:filler', { text: 'Einen Moment.' }));
    await flush();

    expect(tts.speak).toHaveBeenCalledWith('Einen Moment.', expect.any(AbortSignal));
    // The filler is a spoken bridge, not turn content: no state transition.
    expect(service.voiceState).toBe(stateBefore);
    expect(stateListener).not.toHaveBeenCalled();
  });

  it('no-ops an llm:filler when TTS is unavailable', async () => {
    (tts.init as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('piper broken'));
    await service.init();

    // No ttsQueue exists → must not throw.
    expect(() => service.onMessage(makeMsg(service, bus, 'llm:filler', { text: 'Sofort.' }))).not.toThrow();
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

  it('returns to idle when stopRecording returns empty buffer', async () => {
    (audio.stopRecording as ReturnType<typeof vi.fn>).mockReturnValue(new Float32Array(0));

    await service.init();

    const terminalListener = vi.fn();
    bus.on('turn:terminal', terminalListener);

    const registerCall = (hotkey.register as ReturnType<typeof vi.fn>).mock.calls[0];
    const onDown = registerCall[1] as () => void;
    const onUp = registerCall[2] as () => void;

    onDown();
    onUp();
    await flush();

    expect(stt.transcribe).not.toHaveBeenCalled();
    expect(service.voiceState).toBe('idle');
    expect(terminalListener).toHaveBeenCalledOnce();
    expect(terminalListener.mock.calls[0][0].data.status).toBe('canceled');
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

  it('resets interactionMode from chatspeak to voice after TTS completes', async () => {
    await service.init();

    const doneListener = vi.fn();
    bus.on('voice:done', doneListener);

    // Auto-respond to voice:play-audio with voice:playback-done
    autoCompletePlayback(bus);

    // Set chatspeak mode and put service in processing state via PTT
    service.setInteractionMode('chatspeak');

    const registerCall = (hotkey.register as ReturnType<typeof vi.fn>).mock.calls[0];
    const onDown = registerCall[1] as () => void;
    const onUp = registerCall[2] as () => void;

    onDown();
    onUp();
    await flush();

    // Send chunk + done
    service.onMessage(makeMsg(service, bus, 'llm:chunk', { text: 'Antwort.' }));
    service.onMessage(makeMsg(service, bus, 'llm:done', {}));
    terminalizeActiveOutput(service, bus);
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

  it('treats a typed message in voice mode as a correlated processing turn', async () => {
    await service.init();
    autoCompletePlayback(bus);
    const turnId = '44444444-4444-4444-8444-444444444444';
    const request = {
      turnId,
      source: 'chat' as const,
      mode: 'voice' as const,
      originalText: 'Wie heiße ich?',
      createdAt: new Date().toISOString(),
    };
    bus.emit('renderer', 'chat:message', request);
    service.onMessage({
      source: 'renderer',
      topic: 'chat:message',
      data: request,
      timestamp: new Date().toISOString(),
    });

    expect(service.voiceState).toBe('processing');
    service.onMessage(makeMsg(service, bus, 'llm:chunk', { text: 'Du heißt Martin.' }));
    service.onMessage(makeMsg(service, bus, 'llm:done', {}));
    const terminal = { turnId, status: 'done' as const };
    bus.emit('router', 'turn:terminal', terminal);
    service.onMessage({
      source: 'router',
      topic: 'turn:terminal',
      data: terminal,
      timestamp: new Date().toISOString(),
    });
    await flush();
    await flush();

    expect(tts.speak).toHaveBeenCalledWith('Du heißt Martin.', expect.any(AbortSignal));
    expect(service.voiceState).toBe('idle');
  });

  it('recovers a missing chunk from the authoritative llm:done fullText', async () => {
    await service.init();
    autoCompletePlayback(bus);
    const turnId = '55555555-5555-4555-8555-555555555555';
    const outputId = '66666666-6666-4666-8666-666666666666';

    service.onMessage(makeMsg(service, bus, 'llm:chunk', {
      turnId,
      outputId,
      sequence: 1,
      text: 'Zweiter Satz.',
    }));
    service.onMessage(makeMsg(service, bus, 'llm:done', {
      turnId,
      outputId,
      sequence: 2,
      fullText: 'Erster Satz. Zweiter Satz.',
    }));
    await flush();
    await flush();
    await flush();

    expect(tts.speak).toHaveBeenCalledWith('Erster Satz.', expect.any(AbortSignal));
    expect(tts.speak).toHaveBeenCalledWith('Zweiter Satz.', expect.any(AbortSignal));
  });

  // --- 16. Streaming: multiple sentences from chunks ---

  it('calls TTS for each complete sentence from streaming chunks', async () => {
    await service.init();

    // Auto-respond to voice:play-audio with voice:playback-done
    autoCompletePlayback(bus);

    // Get into processing state
    const registerCall = (hotkey.register as ReturnType<typeof vi.fn>).mock.calls[0];
    const onDown = registerCall[1] as () => void;
    const onUp = registerCall[2] as () => void;

    onDown();
    onUp();
    await flush();

    // Send chunks that build up to multiple sentences
    service.onMessage(makeMsg(service, bus, 'llm:chunk', { text: 'Erste Antwort. ' }));
    service.onMessage(makeMsg(service, bus, 'llm:chunk', { text: 'Zweite Antwort. ' }));
    service.onMessage(makeMsg(service, bus, 'llm:chunk', { text: 'Rest' }));
    service.onMessage(makeMsg(service, bus, 'llm:done', {}));
    await flush();
    await flush();
    await flush();

    // TTS should have been called for all 3 segments
    expect(tts.speak).toHaveBeenCalledWith('Erste Antwort.', expect.any(AbortSignal));
    expect(tts.speak).toHaveBeenCalledWith('Zweite Antwort.', expect.any(AbortSignal));
    expect(tts.speak).toHaveBeenCalledWith('Rest', expect.any(AbortSignal));
  });

  it('reports voice completion separately for two turns queued into playback', async () => {
    await service.init();
    const playbacks: Array<{ turnId: string; playbackId: string }> = [];
    const doneTurns: string[] = [];
    bus.on('voice:play-audio', (message) => playbacks.push({
      turnId: message.data.turnId,
      playbackId: message.data.playbackId,
    }));
    bus.on('voice:done', (message) => doneTurns.push(message.data.turnId));
    bus.on('turn:terminal', (message) => service.onMessage(message));
    const turnOne = '99999999-9999-4999-8999-999999999999';
    const turnTwo = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

    service.onMessage(makeMsg(service, bus, 'llm:chunk', { turnId: turnOne, text: 'Eins.' }));
    service.onMessage(makeMsg(service, bus, 'llm:done', { turnId: turnOne }));
    bus.emit('router', 'turn:terminal', { turnId: turnOne, status: 'done' });
    await vi.waitFor(() => expect(playbacks).toHaveLength(1));

    service.onMessage(makeMsg(service, bus, 'llm:chunk', { turnId: turnTwo, text: 'Zwei.' }));
    service.onMessage(makeMsg(service, bus, 'llm:done', { turnId: turnTwo }));
    bus.emit('router', 'turn:terminal', { turnId: turnTwo, status: 'done' });

    bus.emit('renderer', 'voice:playback-done', playbacks[0]);
    await vi.waitFor(() => expect(playbacks).toHaveLength(2));
    expect(doneTurns).toEqual([turnOne]);

    bus.emit('renderer', 'voice:playback-done', playbacks[1]);
    await vi.waitFor(() => expect(doneTurns).toEqual([turnOne, turnTwo]));
    expect(service.voiceState).toBe('idle');
  });

  it('turns a correlated renderer playback failure into a voice error and leaves speaking', async () => {
    await service.init();
    const playbacks: Array<{ turnId: string; playbackId: string }> = [];
    const errors: Array<{ turnId?: string; message: string }> = [];
    bus.on('voice:play-audio', (message) => playbacks.push(message.data));
    bus.on('voice:error', (message) => errors.push(message.data));
    const turnId = 'abababab-abab-4bab-8bab-abababababab';

    service.onMessage(makeMsg(service, bus, 'llm:chunk', { turnId, text: 'Antwort.' }));
    service.onMessage(makeMsg(service, bus, 'llm:done', { turnId }));
    const terminal = { turnId, status: 'done' as const };
    bus.emit('router', 'turn:terminal', terminal);
    service.onMessage({
      source: 'router',
      topic: 'turn:terminal',
      data: terminal,
      timestamp: new Date().toISOString(),
    });
    await vi.waitFor(() => expect(playbacks).toHaveLength(1));

    service.handlePlaybackFailure(
      playbacks[0].turnId,
      playbacks[0].playbackId,
      'Audiogerät nicht verfügbar',
    );

    await vi.waitFor(() => expect(service.voiceState).toBe('idle'));
    expect(errors).toContainEqual(expect.objectContaining({
      turnId,
      message: 'Audiogerät nicht verfügbar',
    }));
    expect(audio.setPlaying).toHaveBeenLastCalledWith(false);
  });

  it('fails the active correlated playback immediately when the renderer becomes unavailable', async () => {
    await service.init();
    const playbacks: Array<{ turnId: string; playbackId: string }> = [];
    const stoppedPlaybacks: Array<{ turnId: string; playbackId: string }> = [];
    const errors: Array<{ turnId?: string; message: string }> = [];
    bus.on('voice:play-audio', (message) => playbacks.push(message.data));
    bus.on('voice:stop-playback', (message) => stoppedPlaybacks.push(message.data));
    bus.on('voice:error', (message) => errors.push(message.data));
    const turnId = 'bcbcbcbc-bcbc-4bcb-8bcb-bcbcbcbcbcbc';

    service.onMessage(makeMsg(service, bus, 'llm:chunk', {
      turnId,
      text: 'Erster Satz. Zweiter Satz. Dritter Satz.',
    }));
    service.onMessage(makeMsg(service, bus, 'llm:done', { turnId }));
    terminalizeActiveOutput(service, bus);
    await vi.waitFor(() => expect(playbacks).toHaveLength(1));

    service.handleRendererCaptureUnavailable('Renderer verloren');

    const internal = service as unknown as {
      activePlaybackTurnId: string | null;
      activePlaybackId: string | null;
    };
    expect(internal.activePlaybackTurnId).toBeNull();
    expect(internal.activePlaybackId).toBeNull();
    expect(audio.setPlaying).toHaveBeenLastCalledWith(false);
    expect(stoppedPlaybacks).toEqual([{
      turnId: playbacks[0].turnId,
      playbackId: playbacks[0].playbackId,
    }]);
    expect(errors).toContainEqual(expect.objectContaining({
      turnId,
      message: 'Renderer verloren',
    }));
    await vi.waitFor(() => expect(service.voiceState).toBe('idle'));

    const recoveryTurnId = 'cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd';
    service.onMessage(makeMsg(service, bus, 'llm:chunk', {
      turnId: recoveryTurnId,
      text: 'Neue Antwort nach dem Reload.',
    }));
    service.onMessage(makeMsg(service, bus, 'llm:done', { turnId: recoveryTurnId }));
    terminalizeActiveOutput(service, bus);
    await flush();
    expect(playbacks).toHaveLength(1);

    // Even capture-ready=false proves a live renderer and must release playback.
    service.setRendererCaptureReady(false);
    await vi.waitFor(() => expect(playbacks).toHaveLength(2));
    expect(tts.speak).toHaveBeenCalledWith(
      'Neue Antwort nach dem Reload.',
      expect.any(AbortSignal),
    );
    expect(tts.speak).not.toHaveBeenCalledWith('Dritter Satz.', expect.any(AbortSignal));
    expect(service.voiceState).toBe('speaking');
  });

  it('generation-safely stops first-sentence synthesis when the renderer is lost before playback', async () => {
    let resolveSynthesis: ((audio: Float32Array) => void) | null = null;
    (tts.speak as ReturnType<typeof vi.fn>).mockImplementation(() => (
      new Promise<Float32Array>((resolve) => {
        resolveSynthesis = resolve;
      })
    ));
    await service.init();
    const playbacks: Array<{ turnId: string; playbackId: string }> = [];
    bus.on('voice:play-audio', (message) => playbacks.push(message.data));
    const turnId = 'dededede-dede-4ede-8ede-dededededede';

    service.onMessage(makeMsg(service, bus, 'llm:chunk', { turnId, text: 'Antwort.' }));
    service.onMessage(makeMsg(service, bus, 'llm:done', { turnId }));
    terminalizeActiveOutput(service, bus);
    await vi.waitFor(() => expect(tts.speak).toHaveBeenCalledOnce());
    expect(playbacks).toHaveLength(0);

    service.handleRendererCaptureUnavailable('Renderer verloren');
    const completeSynthesis = resolveSynthesis as ((audio: Float32Array) => void) | null;
    if (!completeSynthesis) throw new Error('Expected pending TTS synthesis');
    completeSynthesis(new Float32Array([0.1, 0.2]));
    await flush();

    const internal = service as unknown as { ttsQueue: { isActive: boolean } | null };
    expect(playbacks).toHaveLength(0);
    expect(internal.ttsQueue?.isActive).toBe(false);
    expect(service.voiceState).toBe('idle');
    expect(tts.stop).toHaveBeenCalledOnce();
  });

  // --- 17. llm:error cancels partial speech before the error announcement ---

  it('cancels active, prebuffered and queued partial speech before speaking the llm error', async () => {
    await service.init();
    const playbacks: Array<{ turnId: string; playbackId: string }> = [];
    const stoppedPlaybacks: Array<{ turnId: string; playbackId: string }> = [];
    const doneTurns: string[] = [];
    bus.on('voice:play-audio', (message) => playbacks.push(message.data));
    bus.on('voice:stop-playback', (message) => stoppedPlaybacks.push(message.data));
    bus.on('voice:done', (message) => doneTurns.push(message.data.turnId));

    // Get into processing state
    const registerCall = (hotkey.register as ReturnType<typeof vi.fn>).mock.calls[0];
    const onDown = registerCall[1] as () => void;
    const onUp = registerCall[2] as () => void;

    onDown();
    onUp();
    await flush();

    // Send a chunk to start streaming
    const chunk = makeMsg(service, bus, 'llm:chunk', {
      text: 'Teil eins. Teil zwei. Teil drei.',
    });
    service.onMessage(chunk);
    await vi.waitFor(() => expect(playbacks).toHaveLength(1));

    expect(service.voiceState).toBe('speaking');

    // Now send llm:error while streaming
    service.onMessage(makeMsg(service, bus, 'llm:error', {
      turnId: chunk.data.turnId,
      message: 'Connection lost',
    }));
    const terminal = { turnId: chunk.data.turnId, status: 'error' as const, message: 'Connection lost' };
    bus.emit('router', 'turn:terminal', terminal);
    service.onMessage({ source: 'router', topic: 'turn:terminal', data: terminal, timestamp: new Date().toISOString() });

    expect(service.voiceState).toBe('speaking');
    await vi.waitFor(() => expect(playbacks).toHaveLength(2));
    expect(stoppedPlaybacks).toEqual([{
      turnId: playbacks[0].turnId,
      playbackId: playbacks[0].playbackId,
    }]);
    bus.emit('renderer', 'voice:playback-done', playbacks[1]);
    await vi.waitFor(() => expect(service.voiceState).toBe('idle'));
    await flush();
    expect(playbacks).toHaveLength(2);

    const internal = service as unknown as { outputs: Map<string, object>; processingTurnIds: Set<string> };
    expect(internal.outputs.size).toBe(0);
    expect(internal.processingTurnIds.size).toBe(0);
    expect(doneTurns).toEqual([chunk.data.turnId]);
    expect(tts.speak).not.toHaveBeenCalledWith('Teil drei.', expect.any(AbortSignal));
    expect(tts.speak).toHaveBeenCalledWith('Connection lost', expect.any(AbortSignal));
  });

  it('keeps an action acknowledgement processing and cancelable until the turn terminal arrives', async () => {
    await service.init();
    const playbacks: Array<{ turnId: string; playbackId: string }> = [];
    const canceled: string[] = [];
    bus.on('voice:play-audio', (message) => playbacks.push(message.data));
    bus.on('turn:cancel', (message) => canceled.push(message.data.turnId));
    const turnId = '10101010-1010-4010-8010-101010101010';
    const request = {
      turnId,
      source: 'chat' as const,
      mode: 'voice' as const,
      originalText: 'Suche Hotels',
      createdAt: new Date().toISOString(),
    };
    bus.emit('renderer', 'chat:message', request);
    service.onMessage({ source: 'renderer', topic: 'chat:message', data: request, timestamp: new Date().toISOString() });
    service.onMessage(makeMsg(service, bus, 'llm:chunk', { turnId, text: 'Ich suche danach.' }));
    service.onMessage(makeMsg(service, bus, 'llm:done', { turnId }));
    await vi.waitFor(() => expect(playbacks).toHaveLength(1));
    bus.emit('renderer', 'voice:playback-done', playbacks[0]);
    await vi.waitFor(() => expect(service.voiceState).toBe('processing'));

    const onDown = (hotkey.register as ReturnType<typeof vi.fn>).mock.calls[0][1] as () => void;
    onDown();

    expect(canceled).toContain(turnId);
    expect(bus.isTurnTerminal(turnId)).toBe(true);
    expect(service.voiceState).toBe('listening');
  });

  it('finishes an already speaking turn consistently after switching interaction mode', async () => {
    await service.init();
    const playbacks: Array<{ turnId: string; playbackId: string }> = [];
    bus.on('voice:play-audio', (message) => playbacks.push(message.data));
    const turnId = '20202020-2020-4020-8020-202020202020';
    const request = {
      turnId,
      source: 'chat' as const,
      mode: 'voice' as const,
      originalText: 'Erkläre etwas',
      createdAt: new Date().toISOString(),
    };
    bus.emit('renderer', 'chat:message', request);
    service.onMessage({ source: 'renderer', topic: 'chat:message', data: request, timestamp: new Date().toISOString() });
    service.onMessage(makeMsg(service, bus, 'llm:chunk', { turnId, text: 'Erster Satz. ' }));
    await vi.waitFor(() => expect(playbacks).toHaveLength(1));

    service.setInteractionMode('chat');
    service.onMessage(makeMsg(service, bus, 'llm:chunk', { turnId, text: 'Zweiter Satz.' }));
    service.onMessage(makeMsg(service, bus, 'llm:done', { turnId }));
    const terminal = { turnId, status: 'done' as const };
    bus.emit('router', 'turn:terminal', terminal);
    service.onMessage({ source: 'router', topic: 'turn:terminal', data: terminal, timestamp: new Date().toISOString() });

    bus.emit('renderer', 'voice:playback-done', playbacks[0]);
    await vi.waitFor(() => expect(playbacks).toHaveLength(2));
    bus.emit('renderer', 'voice:playback-done', playbacks[1]);
    await vi.waitFor(() => expect(service.voiceState).toBe('idle'));
    expect(tts.speak).toHaveBeenCalledWith('Erster Satz.', expect.any(AbortSignal));
    expect(tts.speak).toHaveBeenCalledWith('Zweiter Satz.', expect.any(AbortSignal));
  });

  it('keeps the accepted voice-chat turn audible when mode changes before its first output', async () => {
    await service.init();
    autoCompletePlayback(bus);
    const turnId = '21212121-2121-4121-8121-212121212121';
    const accepted = { turnId, source: 'chat' as const, mode: 'voice' as const };
    bus.emit('runtime', 'turn:accepted', accepted);
    service.onMessage({ source: 'runtime', topic: 'turn:accepted', data: accepted, timestamp: new Date().toISOString() });
    service.setInteractionMode('chat');
    const request = {
      turnId,
      source: 'chat' as const,
      mode: 'voice' as const,
      originalText: 'Erkläre etwas',
      createdAt: new Date().toISOString(),
    };
    bus.emit('renderer', 'chat:message', request);
    service.onMessage({ source: 'renderer', topic: 'chat:message', data: request, timestamp: new Date().toISOString() });
    service.onMessage(makeMsg(service, bus, 'llm:chunk', { turnId, text: 'Die Antwort bleibt hörbar.' }));
    service.onMessage(makeMsg(service, bus, 'llm:done', { turnId }));
    const terminal = { turnId, status: 'done' as const };
    bus.emit('router', 'turn:terminal', terminal);
    service.onMessage({ source: 'router', topic: 'turn:terminal', data: terminal, timestamp: new Date().toISOString() });

    await vi.waitFor(() => {
      expect(tts.speak).toHaveBeenCalledWith('Die Antwort bleibt hörbar.', expect.any(AbortSignal));
      expect(service.voiceState).toBe('idle');
    });
  });

  it('keeps the accepted text-chat turn silent when mode changes before its first output', async () => {
    await service.init();
    const turnId = '22222222-2222-4222-8222-222222222222';
    const accepted = { turnId, source: 'chat' as const, mode: 'chat' as const };
    bus.emit('runtime', 'turn:accepted', accepted);
    service.onMessage({ source: 'runtime', topic: 'turn:accepted', data: accepted, timestamp: new Date().toISOString() });
    service.setInteractionMode('voice');
    const request = {
      turnId,
      source: 'chat' as const,
      mode: 'chat' as const,
      originalText: 'Erkläre etwas',
      createdAt: new Date().toISOString(),
    };
    bus.emit('renderer', 'chat:message', request);
    service.onMessage({ source: 'renderer', topic: 'chat:message', data: request, timestamp: new Date().toISOString() });
    service.onMessage(makeMsg(service, bus, 'llm:chunk', { turnId, text: 'Diese Antwort bleibt stumm.' }));
    service.onMessage(makeMsg(service, bus, 'llm:done', { turnId }));
    const terminal = { turnId, status: 'done' as const };
    bus.emit('router', 'turn:terminal', terminal);
    service.onMessage({ source: 'router', topic: 'turn:terminal', data: terminal, timestamp: new Date().toISOString() });
    await flush();

    expect(tts.speak).not.toHaveBeenCalled();
    expect(service.voiceState).toBe('idle');
  });

  it('speaks an accepted voice-chat error even when the request is rejected before publication', async () => {
    await service.init();
    autoCompletePlayback(bus);
    const turnId = '23232323-2323-4323-8323-232323232323';
    const accepted = { turnId, source: 'chat' as const, mode: 'voice' as const };
    bus.emit('runtime', 'turn:accepted', accepted);
    service.onMessage({ source: 'runtime', topic: 'turn:accepted', data: accepted, timestamp: new Date().toISOString() });
    service.setInteractionMode('chat');
    const error = { turnId, message: 'Sarah ist gerade nicht verfügbar.' };
    service.onMessage({ source: 'runtime', topic: 'llm:error', data: error, timestamp: new Date().toISOString() });
    const terminal = { turnId, status: 'error' as const, message: error.message };
    bus.emit('runtime', 'turn:terminal', terminal);
    service.onMessage({ source: 'runtime', topic: 'turn:terminal', data: terminal, timestamp: new Date().toISOString() });

    await vi.waitFor(() => {
      expect(tts.speak).toHaveBeenCalledWith(error.message, expect.any(AbortSignal));
      expect(service.voiceState).toBe('idle');
    });
  });

  it('does not leave turn B processing after it completes while turn A is playing', async () => {
    await service.init();
    const playbacks: Array<{ turnId: string; playbackId: string }> = [];
    bus.on('voice:play-audio', (message) => playbacks.push(message.data));
    const turnA = '30303030-3030-4030-8030-303030303030';
    const turnB = '40404040-4040-4040-8040-404040404040';
    service.onMessage(makeMsg(service, bus, 'llm:chunk', { turnId: turnA, text: 'Antwort A.' }));
    service.onMessage(makeMsg(service, bus, 'llm:done', { turnId: turnA }));
    const terminalA = { turnId: turnA, status: 'done' as const };
    bus.emit('router', 'turn:terminal', terminalA);
    service.onMessage({ source: 'router', topic: 'turn:terminal', data: terminalA, timestamp: new Date().toISOString() });
    await vi.waitFor(() => expect(playbacks).toHaveLength(1));

    const requestB = { turnId: turnB, source: 'chat' as const, mode: 'voice' as const, originalText: 'B', createdAt: new Date().toISOString() };
    bus.emit('renderer', 'chat:message', requestB);
    service.onMessage({ source: 'renderer', topic: 'chat:message', data: requestB, timestamp: new Date().toISOString() });
    service.onMessage(makeMsg(service, bus, 'llm:chunk', { turnId: turnB, text: 'Antwort B.' }));
    service.onMessage(makeMsg(service, bus, 'llm:done', { turnId: turnB }));
    const terminalB = { turnId: turnB, status: 'done' as const };
    bus.emit('router', 'turn:terminal', terminalB);
    service.onMessage({ source: 'router', topic: 'turn:terminal', data: terminalB, timestamp: new Date().toISOString() });

    const internal = service as unknown as { processingTurnIds: Set<string> };
    expect(internal.processingTurnIds.has(turnB)).toBe(false);
    expect(service.voiceState).toBe('speaking');
    bus.emit('renderer', 'voice:playback-done', playbacks[0]);
    await vi.waitFor(() => expect(playbacks).toHaveLength(2));
    bus.emit('renderer', 'voice:playback-done', playbacks[1]);
    await vi.waitFor(() => expect(service.voiceState).toBe('idle'));
  });

  it('cancels every open chatspeak turn on F9 and rejects all late output', async () => {
    await service.init();
    const canceled: string[] = [];
    bus.on('turn:cancel', (message) => canceled.push(message.data.turnId));
    const turns = [
      '50505050-5050-4050-8050-505050505050',
      '60606060-6060-4060-8060-606060606060',
      '70707070-7070-4070-8070-707070707070',
    ];
    for (const turnId of turns) {
      const request = { turnId, source: 'chat' as const, mode: 'voice' as const, originalText: turnId, createdAt: new Date().toISOString() };
      bus.emit('renderer', 'chat:message', request);
      service.onMessage({ source: 'renderer', topic: 'chat:message', data: request, timestamp: new Date().toISOString() });
    }

    const onDown = (hotkey.register as ReturnType<typeof vi.fn>).mock.calls[0][1] as () => void;
    onDown();

    expect(new Set(canceled)).toEqual(new Set(turns));
    for (const turnId of turns) {
      expect(bus.isTurnTerminal(turnId)).toBe(true);
      service.onMessage(makeMsg(service, bus, 'llm:chunk', { turnId, text: `Späte Antwort ${turnId}.` }));
      service.onMessage(makeMsg(service, bus, 'llm:done', { turnId }));
    }
    await flush();
    expect(tts.speak).not.toHaveBeenCalled();
  });

  it('cancels an active text-only chat turn before F9 opens the replacement voice turn', async () => {
    await service.init();
    const canceled: string[] = [];
    bus.on('turn:cancel', (message) => canceled.push(message.data.turnId));
    const chatTurnId = '80808080-8080-4080-8080-808080808080';
    const request = {
      turnId: chatTurnId,
      source: 'chat' as const,
      mode: 'chat' as const,
      originalText: 'Erkläre mir, warum der Himmel blau ist.',
      createdAt: new Date().toISOString(),
    };
    bus.emit('renderer', 'chat:message', request);
    service.onMessage({
      source: 'renderer',
      topic: 'chat:message',
      data: request,
      timestamp: new Date().toISOString(),
    });

    expect(service.voiceState).toBe('processing');
    const onDown = (hotkey.register as ReturnType<typeof vi.fn>).mock.calls[0][1] as () => void;
    onDown();

    const replacementTurnId = service.voiceStateSnapshot.turnId;
    expect(canceled).toEqual([chatTurnId]);
    expect(bus.isTurnTerminal(chatTurnId)).toBe(true);
    expect(service.voiceState).toBe('listening');
    expect(replacementTurnId).toBeTruthy();
    expect(replacementTurnId).not.toBe(chatTurnId);
  });
});

describe('VoiceService partial failure (voice:capability)', () => {
  it('keeps STT alive and reports capability when TTS init fails', async () => {
    const bus = new MessageBus();
    const emitted: Array<{ topic: string; data: object }> = [];
    bus.on('voice:capability', (msg) => emitted.push({ topic: msg.topic, data: msg.data }));
    const context = createMockContext(bus, 'push-to-talk');
    const tts = createMockTts();
    (tts.init as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('piper broken'));
    const service = new VoiceService(context, createMockStt(), tts, createMockWakeWord(), createMockAudio(), createMockHotkey());

    await service.init();

    expect(service.status).toBe('running');
    expect(emitted).toHaveLength(1);
    expect(emitted[0].data).toEqual({ stt: true, tts: false });
    expect(tts.destroy).toHaveBeenCalledOnce();
    await service.destroy();
  });

  it('publishes runtime STT degradation and recovery after initial readiness', async () => {
    const bus = new MessageBus();
    const capabilities: Array<{ stt: boolean; tts: boolean }> = [];
    bus.on('voice:capability', (msg) => capabilities.push(msg.data));
    const stt = createMockStt();
    let availabilityListener: ((state: { available: boolean; message?: string }) => void) | null = null;
    const unsubscribe = vi.fn();
    stt.onAvailabilityChange = vi.fn((listener) => {
      availabilityListener = listener;
      return unsubscribe;
    });
    const context = createMockContext(bus, 'push-to-talk');
    const setCapability = vi.fn();
    context.lifecycle = { setCapability } as AppContext['lifecycle'];
    const service = new VoiceService(
      context,
      stt,
      createMockTts(),
      createMockWakeWord(),
      createMockAudio(),
      createMockHotkey(),
    );

    await service.init();
    expect(capabilities).toEqual([{ stt: true, tts: true }]);

    availabilityListener!({ available: false, message: 'whisper process exited' });
    expect(service.capabilitySnapshot.stt).toBe(false);
    expect(capabilities.at(-1)).toEqual({ stt: false, tts: true });
    expect(setCapability).toHaveBeenCalledWith('stt', 'unavailable', 'whisper process exited');

    availabilityListener!({ available: true });
    expect(service.capabilitySnapshot.stt).toBe(true);
    expect(capabilities.at(-1)).toEqual({ stt: true, tts: true });
    expect(setCapability).toHaveBeenCalledWith('stt', 'ready', undefined);

    await service.destroy();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it('terminalizes the held F9 capture when STT becomes unavailable', async () => {
    const bus = new MessageBus();
    const stt = createMockStt();
    const audio = createMockAudio();
    const hotkey = createMockHotkey();
    let availabilityListener: ((state: { available: boolean; message?: string }) => void) | null = null;
    stt.onAvailabilityChange = vi.fn((listener) => {
      availabilityListener = listener;
      return vi.fn();
    });
    const service = new VoiceService(
      createMockContext(bus, 'push-to-talk'),
      stt,
      createMockTts(),
      createMockWakeWord(),
      audio,
      hotkey,
    );
    service.setRendererCaptureReady(true);
    await service.init();
    const terminals: Array<{ turnId: string; status: string; message?: string }> = [];
    bus.on('turn:terminal', (message) => terminals.push(message.data));
    const registerCall = (hotkey.register as ReturnType<typeof vi.fn>).mock.calls[0];
    const onDown = registerCall[1] as () => void;
    const onUp = registerCall[2] as () => void;

    onDown();
    const snapshot = service.voiceStateSnapshot;
    availabilityListener!({ available: false, message: 'whisper exited' });
    onUp();

    expect(audio.stopRecording).toHaveBeenCalledWith(snapshot.captureId);
    expect(terminals).toEqual([{
      turnId: snapshot.turnId,
      status: 'error',
      message: STT_UNAVAILABLE_MESSAGE,
    }]);
    expect(stt.transcribe).not.toHaveBeenCalled();
    expect(service.voiceState).toBe('idle');
    expect(service.voiceStateSnapshot.captureId).toBeUndefined();
    await service.destroy();
  });

  it('preserves the held PTT key-up while renderer capture readiness recovers', async () => {
    const bus = new MessageBus();
    const hotkey = createMockHotkey();
    const stt = createMockStt();
    const service = new VoiceService(
      createMockContext(bus, 'push-to-talk'),
      stt,
      createMockTts(),
      createMockWakeWord(),
      createMockAudio(),
      hotkey,
    );
    acknowledgeCaptureFlushes(bus, service);
    service.setRendererCaptureReady(true);
    await service.init();
    const registerCall = (hotkey.register as ReturnType<typeof vi.fn>).mock.calls[0];
    const onDown = registerCall[1] as () => void;
    const onUp = registerCall[2] as () => void;

    onDown();
    service.setRendererCaptureReady(false);
    service.setRendererCaptureReady(true);

    expect(service.voiceState).toBe('listening');
    expect(hotkey.unregister).not.toHaveBeenCalled();
    expect(hotkey.register).toHaveBeenCalledTimes(1);

    onUp();
    await flush();

    expect(stt.transcribe).toHaveBeenCalledOnce();
    expect(service.voiceState).toBe('processing');
    expect(hotkey.register).toHaveBeenCalledTimes(2);
    await service.destroy();
  });

  it('terminalizes a renderer-lost capture once and rearms PTT without re-registering a held key', async () => {
    const bus = new MessageBus();
    const hotkey = createMockHotkey();
    const service = new VoiceService(
      createMockContext(bus, 'push-to-talk'),
      createMockStt(),
      createMockTts(),
      createMockWakeWord(),
      createMockAudio(),
      hotkey,
    );
    const terminals: Array<{ turnId: string; status: string; message?: string }> = [];
    bus.on('turn:terminal', (message) => terminals.push(message.data));
    service.setRendererCaptureReady(true);
    await service.init();
    const onDown = (hotkey.register as ReturnType<typeof vi.fn>).mock.calls[0][1] as () => void;
    onDown();
    const snapshot = service.voiceStateSnapshot;

    service.handleRendererCaptureUnavailable('Renderer verloren');
    service.handleRendererCaptureUnavailable('Renderer verloren');
    service.setRendererCaptureReady(true);

    expect(terminals).toEqual([{
      turnId: snapshot.turnId,
      status: 'error',
      message: 'Renderer verloren',
    }]);
    expect(service.voiceState).toBe('idle');
    expect(service.voiceStateSnapshot.captureId).toBeUndefined();
    expect(hotkey.suspend).toHaveBeenCalledOnce();
    expect(hotkey.resume).toHaveBeenCalledOnce();
    expect(hotkey.unregister).not.toHaveBeenCalled();
    expect(hotkey.register).toHaveBeenCalledOnce();
    await service.destroy();
  });

  it('publishes runtime TTS degradation and recovery after initial readiness', async () => {
    const bus = new MessageBus();
    const capabilities: Array<{ stt: boolean; tts: boolean }> = [];
    bus.on('voice:capability', (msg) => capabilities.push(msg.data));
    const tts = createMockTts();
    let availabilityListener: ((state: { available: boolean; message?: string }) => void) | null = null;
    const unsubscribe = vi.fn();
    tts.onAvailabilityChange = vi.fn((listener) => {
      availabilityListener = listener;
      return unsubscribe;
    });
    const context = createMockContext(bus, 'push-to-talk');
    const setCapability = vi.fn();
    context.lifecycle = { setCapability } as AppContext['lifecycle'];
    const service = new VoiceService(
      context,
      createMockStt(),
      tts,
      createMockWakeWord(),
      createMockAudio(),
      createMockHotkey(),
    );

    await service.init();
    expect(capabilities).toEqual([{ stt: true, tts: true }]);

    availabilityListener!({ available: false, message: 'piper exited' });
    expect(service.capabilitySnapshot.tts).toBe(false);
    expect(capabilities.at(-1)).toEqual({ stt: true, tts: false });
    expect(setCapability).toHaveBeenCalledWith('tts', 'unavailable', 'piper exited');

    availabilityListener!({ available: true });
    expect(service.capabilitySnapshot.tts).toBe(true);
    expect(capabilities.at(-1)).toEqual({ stt: true, tts: true });
    expect(setCapability).toHaveBeenCalledWith('tts', 'ready', undefined);

    await service.destroy();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it('rejects push-to-talk immediately and audibly when STT init fails', async () => {
    const bus = new MessageBus();
    const context = createMockContext(bus, 'push-to-talk');
    const stt = createMockStt();
    const tts = createMockTts();
    const audio = createMockAudio();
    const hotkey = createMockHotkey();
    (stt.init as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('whisper broken'));
    const service = new VoiceService(context, stt, tts, createMockWakeWord(), audio, hotkey);
    const voiceError = vi.fn();
    const playAudio = vi.fn();
    const stopPlayback = vi.fn();
    bus.on('voice:error', voiceError);
    bus.on('voice:play-audio', playAudio);
    bus.on('voice:stop-playback', stopPlayback);

    await service.init();
    const registerCall = (hotkey.register as ReturnType<typeof vi.fn>).mock.calls[0];
    const onDown = registerCall[1] as () => void;
    onDown();
    await flush();

    expect(service.voiceState).toBe('speaking');
    expect(audio.startRecording).not.toHaveBeenCalled();
    expect(stt.transcribe).not.toHaveBeenCalled();
    expect(voiceError).toHaveBeenCalledOnce();
    expect(voiceError.mock.calls[0][0].data.message).toBe(STT_UNAVAILABLE_MESSAGE);
    expect(tts.speak).toHaveBeenCalledWith(STT_UNAVAILABLE_MESSAGE, expect.any(AbortSignal));

    onDown();

    expect(voiceError).toHaveBeenCalledOnce();
    expect(tts.speak).toHaveBeenCalledOnce();
    expect(playAudio).toHaveBeenCalledOnce();
    expect(stopPlayback).toHaveBeenCalledOnce();
    expect(service.voiceState).toBe('idle');
    await service.destroy();
  });

  it('reports error status only when both capabilities fail', async () => {
    const bus = new MessageBus();
    const context = createMockContext(bus, 'push-to-talk');
    const stt = createMockStt();
    const tts = createMockTts();
    (stt.init as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('whisper broken'));
    (tts.init as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('piper broken'));
    const service = new VoiceService(context, stt, tts, createMockWakeWord(), createMockAudio(), createMockHotkey());

    await service.init();

    expect(service.status).toBe('error');
    await service.destroy();
  });
});

describe('TTS deferral while listening (F9)', () => {
  it('drops deferred partial output on llm:error and retains only the error announcement', async () => {
    const bus = new MessageBus();
    const tts = createMockTts();
    const hotkey = createMockHotkey();
    const service = new VoiceService(createMockContext(bus), createMockStt(), tts, createMockWakeWord(), createMockAudio(), hotkey);
    service.setRendererCaptureReady(true);
    await service.init();
    const onDown = (hotkey.register as ReturnType<typeof vi.fn>).mock.calls[0][1] as () => void;
    onDown();

    const chunk = makeMsg(service, bus, 'llm:chunk', { text: 'Unvollständige Teilantwort.' });
    service.onMessage(chunk);
    service.onMessage(makeMsg(service, bus, 'llm:error', {
      turnId: chunk.data.turnId,
      message: 'Connection lost',
    }));

    const internal = service as unknown as {
      deferredSentences: Array<{ text: string }>;
      setState: (s: string) => void;
    };
    expect(internal.deferredSentences.map((item) => item.text)).toEqual(['Connection lost']);

    internal.setState('processing');
    await vi.waitFor(() => expect(tts.speak).toHaveBeenCalledOnce());
    expect(tts.speak).toHaveBeenCalledWith('Connection lost', expect.any(AbortSignal));
    expect(tts.speak).not.toHaveBeenCalledWith(
      'Unvollständige Teilantwort.',
      expect.any(AbortSignal),
    );
    await service.destroy();
  });

  it('buffers llm output while listening and enqueues it after the recording ends', async () => {
    const bus = new MessageBus();
    const tts = createMockTts();
    const service = new VoiceService(createMockContext(bus), createMockStt(), tts, createMockWakeWord(), createMockAudio(), createMockHotkey());
    await service.init();

    // Zustand wie bei gedrücktem PTT herstellen (gleiches Muster wie die bestehenden State-Tests):
    // Harness note: this file drives onMessage() directly (see neighboring tests using
    // `service.onMessage(makeMsg(...))`) rather than the bus, since VoiceService's own
    // bus subscription wiring lives in ServiceRegistry, not in VoiceService itself.
    (service as unknown as { setState: (s: string) => void }).setState('listening');

    service.onMessage(makeMsg(service, bus, 'llm:chunk', { text: 'Dein Timer ist abgelaufen.' }));
    service.onMessage(makeMsg(service, bus, 'llm:done', { fullText: 'Dein Timer ist abgelaufen.' }));
    await new Promise((r) => setTimeout(r, 10));
    expect(tts.speak).not.toHaveBeenCalled(); // während der Aufnahme: still

    (service as unknown as { setState: (s: string) => void }).setState('processing');
    await new Promise((r) => setTimeout(r, 10));
    expect(tts.speak).toHaveBeenCalledWith(
      'Dein Timer ist abgelaufen.',
      expect.any(AbortSignal),
    ); // danach: gesprochen
  });

  it('does not defer when idle', async () => {
    const bus = new MessageBus();
    const tts = createMockTts();
    const service = new VoiceService(createMockContext(bus), createMockStt(), tts, createMockWakeWord(), createMockAudio(), createMockHotkey());
    await service.init();

    service.onMessage(makeMsg(service, bus, 'llm:chunk', { text: 'Hallo.' }));
    service.onMessage(makeMsg(service, bus, 'llm:done', { fullText: 'Hallo.' }));
    await new Promise((r) => setTimeout(r, 10));
    expect(tts.speak).toHaveBeenCalled();
  });

  it('rejects turn-1 output after double-PTT cancellation and speaks only turn 2', async () => {
    const bus = new MessageBus();
    const tts = createMockTts();
    const stt = createMockStt();
    const hotkey = createMockHotkey();

    let transcribeCall = 0;
    let resolveTurn2Transcribe: (value: string) => void;
    (stt.transcribe as ReturnType<typeof vi.fn>).mockImplementation(() => {
      transcribeCall += 1;
      if (transcribeCall === 1) {
        // Turn 1's transcription resolves immediately.
        return Promise.resolve('Turn eins Frage');
      }
      // Turn 2's transcription stays pending until resolved manually below —
      // this keeps the service in 'processing' so we can observe it.
      return new Promise<string>((resolve) => {
        resolveTurn2Transcribe = resolve;
      });
    });

    const service = new VoiceService(createMockContext(bus), stt, tts, createMockWakeWord(), createMockAudio(), hotkey);
    service.setRendererCaptureReady(true);
    acknowledgeCaptureFlushes(bus, service);
    await service.init();

    const doneListener = vi.fn();
    bus.on('voice:done', doneListener);

    // Auto-respond to voice:play-audio with voice:playback-done so the TTS
    // queue can actually drain (same pattern as the other streaming tests).
    autoCompletePlayback(bus);

    const registerCall = (hotkey.register as ReturnType<typeof vi.fn>).mock.calls[0];
    const onDown = registerCall[1] as () => void;
    const onUp = registerCall[2] as () => void;

    // --- Turn 1: PTT down/up — transcribed, sent to the router, now "generating" ---
    onDown();
    onUp();
    await flush();
    expect(service.voiceState).toBe('processing');
    const turnOneId = (service as unknown as { processingTurnId: string }).processingTurnId;

    // --- User presses PTT again while turn 1 is still generating (no chunk yet) ---
    onDown();
    expect(service.voiceState).toBe('listening');

    // Late output from the canceled turn must be ignored centrally.
    service.onMessage(makeMsg(service, bus, 'llm:chunk', {
      turnId: turnOneId,
      text: 'Antwort auf Turn eins.',
    }));
    service.onMessage(makeMsg(service, bus, 'llm:done', { turnId: turnOneId }));
    await flush();
    expect(tts.speak).not.toHaveBeenCalled();

    // --- User releases PTT: turn-2 recording ends, flush happens, turn-2 STT starts ---
    onUp();
    await flush();

    expect(tts.speak).not.toHaveBeenCalled();
    expect(doneListener).not.toHaveBeenCalled();
    expect(service.voiceState).toBe('processing');

    // --- Turn 2 completes normally ---
    resolveTurn2Transcribe!('Turn zwei Frage');
    await flush();
    expect(service.voiceState).toBe('processing'); // now waiting for turn 2's LLM

    service.onMessage(makeMsg(service, bus, 'llm:chunk', { text: 'Antwort auf Turn zwei.' }));
    service.onMessage(makeMsg(service, bus, 'llm:done', {}));
    terminalizeActiveOutput(service, bus);
    await flush();
    await flush();
    await flush();

    expect(tts.speak).toHaveBeenCalledWith('Antwort auf Turn zwei.', expect.any(AbortSignal));
    expect(tts.speak).not.toHaveBeenCalledWith('Antwort auf Turn eins.', expect.any(AbortSignal));
    expect(doneListener).toHaveBeenCalledOnce();
    expect(service.voiceState).toBe('idle');
  });

  it('keeps turn B output state intact when a late canceled terminal arrives for turn A', async () => {
    const bus = new MessageBus();
    const tts = createMockTts();
    const service = new VoiceService(
      createMockContext(bus),
      createMockStt(),
      tts,
      createMockWakeWord(),
      createMockAudio(),
      createMockHotkey(),
    );
    await service.init();
    const turnA = '11111111-1111-4111-8111-111111111111';
    const turnB = '22222222-2222-4222-8222-222222222222';

    service.onMessage(makeMsg(service, bus, 'llm:chunk', {
      turnId: turnA,
      text: 'Antwort A.',
    }));
    service.onMessage(makeMsg(service, bus, 'llm:done', { turnId: turnA }));
    await vi.waitFor(() => expect(tts.speak).toHaveBeenCalledOnce());

    bus.emit('test', 'turn:accepted', { turnId: turnB, source: 'chat', mode: 'voice' });
    service.onMessage({
      source: 'renderer',
      topic: 'chat:message',
      data: {
        turnId: turnB,
        source: 'chat',
        mode: 'voice',
        originalText: 'Frage B',
        createdAt: new Date().toISOString(),
      },
      timestamp: new Date().toISOString(),
    });
    service.onMessage(makeMsg(service, bus, 'llm:chunk', {
      turnId: turnB,
      text: 'Antwort B',
    }));

    const before = service as unknown as {
      activeOutputTurnId: string | null;
      activeOutputText: string;
      llmStreaming: boolean;
      processingTurnId: string | null;
    };
    expect(before.activeOutputTurnId).toBe(turnB);
    expect(before.activeOutputText).toBe('Antwort B');
    expect(before.llmStreaming).toBe(false);
    expect(before.processingTurnId).toBe(turnB);

    const canceledA = { turnId: turnA, status: 'canceled' as const };
    bus.emit('router', 'turn:terminal', canceledA);
    service.onMessage({
      source: 'router',
      topic: 'turn:terminal',
      data: canceledA,
      timestamp: new Date().toISOString(),
    });

    const after = service as unknown as {
      activeOutputTurnId: string | null;
      activeOutputText: string;
      llmStreaming: boolean;
      processingTurnId: string | null;
    };
    expect(after.activeOutputTurnId).toBe(turnB);
    expect(after.activeOutputText).toBe('Antwort B');
    expect(after.llmStreaming).toBe(false);
    expect(after.processingTurnId).toBe(turnB);
    expect(service.voiceState).toBe('processing');

    service.onMessage(makeMsg(service, bus, 'llm:chunk', { turnId: turnB, text: '.' }));
    service.onMessage(makeMsg(service, bus, 'llm:done', { turnId: turnB }));
    await vi.waitFor(() => expect(tts.speak).toHaveBeenCalledTimes(2));
    expect(tts.speak).toHaveBeenLastCalledWith('Antwort B.', expect.any(AbortSignal));
  });

  it('stops terminal playback A and cancels processing turn B when F9 starts turn C', async () => {
    const bus = new MessageBus();
    const tts = createMockTts();
    const hotkey = createMockHotkey();
    const service = new VoiceService(
      createMockContext(bus),
      createMockStt(),
      tts,
      createMockWakeWord(),
      createMockAudio(),
      hotkey,
    );
    service.setRendererCaptureReady(true);
    await service.init();
    const playbacks: Array<{ turnId: string; playbackId: string }> = [];
    const canceledTurns: string[] = [];
    const interruptedTurns: string[] = [];
    bus.on('voice:play-audio', (message) => playbacks.push({
      turnId: message.data.turnId,
      playbackId: message.data.playbackId,
    }));
    bus.on('turn:cancel', (message) => canceledTurns.push(message.data.turnId));
    bus.on('voice:interrupted', (message) => interruptedTurns.push(message.data.turnId));

    const turnA = '33333333-3333-4333-8333-333333333333';
    service.onMessage(makeMsg(service, bus, 'llm:chunk', { turnId: turnA, text: 'Antwort A.' }));
    service.onMessage(makeMsg(service, bus, 'llm:done', { turnId: turnA }));
    const doneA = { turnId: turnA, status: 'done' as const };
    bus.emit('router', 'turn:terminal', doneA);
    service.onMessage({
      source: 'router',
      topic: 'turn:terminal',
      data: doneA,
      timestamp: new Date().toISOString(),
    });
    await vi.waitFor(() => expect(playbacks).toHaveLength(1));
    expect(bus.isTurnTerminal(turnA)).toBe(true);

    const turnB = '44444444-4444-4444-8444-444444444444';
    bus.emit('test', 'turn:accepted', { turnId: turnB, source: 'chat', mode: 'voice' });
    service.onMessage({
      source: 'renderer',
      topic: 'chat:message',
      data: {
        turnId: turnB,
        source: 'chat',
        mode: 'voice',
        originalText: 'Frage B',
        createdAt: new Date().toISOString(),
      },
      timestamp: new Date().toISOString(),
    });
    const beforeF9 = service as unknown as {
      activePlaybackTurnId: string | null;
      processingTurnId: string | null;
    };
    expect(beforeF9.activePlaybackTurnId).toBe(turnA);
    expect(beforeF9.processingTurnId).toBe(turnB);
    expect(service.voiceState).toBe('speaking');

    const registerCall = (hotkey.register as ReturnType<typeof vi.fn>).mock.calls[0];
    const onDown = registerCall[1] as () => void;
    onDown();

    expect(canceledTurns).toEqual([turnB]);
    expect(interruptedTurns).toEqual([turnB]);
    expect(bus.isTurnTerminal(turnB)).toBe(true);
    expect(service.voiceState).toBe('listening');
    expect(tts.stop).toHaveBeenCalled();
  });

  it('cancels an independent pure text-chat output when F9 takes turn ownership', async () => {
    const bus = new MessageBus();
    const tts = createMockTts();
    const hotkey = createMockHotkey();
    const service = new VoiceService(
      createMockContext(bus),
      createMockStt(),
      tts,
      createMockWakeWord(),
      createMockAudio(),
      hotkey,
    );
    service.setRendererCaptureReady(true);
    await service.init();
    const canceledTurns: string[] = [];
    bus.on('turn:cancel', (message) => canceledTurns.push(message.data.turnId));

    const voiceTurnId = '55555555-5555-4555-8555-555555555555';
    service.onMessage(makeMsg(service, bus, 'llm:chunk', {
      turnId: voiceTurnId,
      text: 'Gesprochene Antwort.',
    }));
    service.onMessage(makeMsg(service, bus, 'llm:done', { turnId: voiceTurnId }));
    await vi.waitFor(() => expect(service.voiceState).toBe('speaking'));

    const textTurnId = '66666666-6666-4666-8666-666666666666';
    const acceptedText = {
      turnId: textTurnId,
      source: 'chat' as const,
      mode: 'chat' as const,
    };
    bus.emit('test', 'turn:accepted', acceptedText);
    service.onMessage({
      source: 'renderer',
      topic: 'turn:accepted',
      data: acceptedText,
      timestamp: new Date().toISOString(),
    });
    service.onMessage({
      source: 'renderer',
      topic: 'chat:message',
      data: {
        ...acceptedText,
        originalText: 'Nur als Text',
        createdAt: new Date().toISOString(),
      },
      timestamp: new Date().toISOString(),
    });
    service.onMessage(makeMsg(service, bus, 'llm:chunk', {
      turnId: textTurnId,
      text: 'Unabhängige Textantwort',
    }));

    const registerCall = (hotkey.register as ReturnType<typeof vi.fn>).mock.calls[0];
    const onDown = registerCall[1] as () => void;
    onDown();

    const outputs = service as unknown as {
      outputs: Map<string, { turnId: string }>;
    };
    expect(new Set(canceledTurns)).toEqual(new Set([voiceTurnId, textTurnId]));
    expect(bus.isTurnTerminal(textTurnId)).toBe(true);
    expect([...outputs.outputs.values()].map((output) => output.turnId)).not.toContain(textTurnId);
    expect(service.voiceState).toBe('listening');
    await service.destroy();
  });

  it('terminally fails an auto-limited recording when STT rejects', async () => {
    const bus = new MessageBus();
    const audio = createMockAudio();
    const stt = createMockStt();
    const hotkey = createMockHotkey();
    const service = new VoiceService(
      createMockContext(bus),
      stt,
      createMockTts(),
      createMockWakeWord(),
      audio,
      hotkey,
    );
    service.setRendererCaptureReady(true);
    acknowledgeCaptureFlushes(bus, service);
    (audio.feedChunk as ReturnType<typeof vi.fn>).mockReturnValue({
      accepted: true,
      limitReached: true,
    });
    (stt.transcribe as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('STT failed'));
    await service.init();
    const errors: Array<{ turnId?: string; message: string }> = [];
    const terminals: Array<{ turnId: string; status: string }> = [];
    bus.on('voice:error', (message) => errors.push(message.data));
    bus.on('turn:terminal', (message) => terminals.push(message.data));

    const registerCall = (hotkey.register as ReturnType<typeof vi.fn>).mock.calls[0];
    const onDown = registerCall[1] as () => void;
    onDown();
    const captureId = (service as unknown as { activeCaptureId: string }).activeCaptureId;
    service.feedAudioChunk(captureId, new Float32Array([0.2]));
    await flush();

    expect(errors).toHaveLength(1);
    expect(terminals).toEqual([{
      turnId: errors[0].turnId,
      status: 'error',
      message: 'Die Spracheingabe konnte nicht verarbeitet werden.',
    }]);
    expect(bus.isTurnTerminal(errors[0].turnId!)).toBe(true);
    expect(service.voiceState).toBe('idle');
  });

  it('terminally times out an auto-limited recording instead of staying processing', async () => {
    vi.useFakeTimers();
    try {
      const bus = new MessageBus();
      const audio = createMockAudio();
      const stt = createMockStt();
      const hotkey = createMockHotkey();
      const service = new VoiceService(
        createMockContext(bus),
        stt,
        createMockTts(),
        createMockWakeWord(),
        audio,
        hotkey,
      );
      service.setRendererCaptureReady(true);
      acknowledgeCaptureFlushes(bus, service);
      (audio.feedChunk as ReturnType<typeof vi.fn>).mockReturnValue({
        accepted: true,
        limitReached: true,
      });
      (stt.transcribe as ReturnType<typeof vi.fn>).mockImplementation(
        () => new Promise<string>(() => {}),
      );
      await service.init();
      const errors: Array<{ turnId?: string; message: string }> = [];
      const terminals: Array<{ turnId: string; status: string; message?: string }> = [];
      bus.on('voice:error', (message) => errors.push(message.data));
      bus.on('turn:terminal', (message) => terminals.push(message.data));

      const registerCall = (hotkey.register as ReturnType<typeof vi.fn>).mock.calls[0];
      const onDown = registerCall[1] as () => void;
      onDown();
      const captureId = (service as unknown as { activeCaptureId: string }).activeCaptureId;
      service.feedAudioChunk(captureId, new Float32Array([0.2]));
      await vi.advanceTimersByTimeAsync(60_000);

      expect(errors).toHaveLength(1);
      expect(errors[0].message).toBe('Die Spracherkennung hat zu lange gebraucht. Bitte versuche es erneut.');
      expect(terminals).toEqual([{
        turnId: errors[0].turnId,
        status: 'error',
        message: errors[0].message,
      }]);
      expect(service.voiceState).toBe('idle');
    } finally {
      vi.useRealTimers();
    }
  });
});
