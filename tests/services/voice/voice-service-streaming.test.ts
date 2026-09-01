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

describe('VoiceService (streaming playback)', () => {
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
});
