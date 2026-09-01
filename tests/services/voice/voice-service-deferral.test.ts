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
