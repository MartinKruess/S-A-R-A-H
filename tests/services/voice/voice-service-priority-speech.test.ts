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

describe('VoiceService (speech & priority output)', () => {
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

  it('keeps a visual-only turn silent while a normal voice turn still speaks', async () => {
    await service.init();
    autoCompletePlayback(bus);

    const visualTurnId = randomUUID();
    service.onMessage(makeMsg(service, bus, 'turn:accepted', {
      turnId: visualTurnId,
      source: 'chat',
      mode: 'voice',
    }));
    service.onMessage(makeMsg(service, bus, 'turn:output-policy', {
      turnId: visualTurnId,
      speech: 'suppress',
    }));
    service.onMessage(makeMsg(service, bus, 'llm:chunk', {
      turnId: visualTurnId,
      text: 'Turn 85-123 und sehr lange Diagnosedaten.',
    }));
    service.onMessage(makeMsg(service, bus, 'llm:done', { turnId: visualTurnId }));
    await flush();

    expect(tts.speak).not.toHaveBeenCalled();

    const normalTurnId = randomUUID();
    service.onMessage(makeMsg(service, bus, 'turn:accepted', {
      turnId: normalTurnId,
      source: 'chat',
      mode: 'voice',
    }));
    service.onMessage(makeMsg(service, bus, 'llm:chunk', {
      turnId: normalTurnId,
      text: 'Diese normale Antwort wird gesprochen.',
    }));
    service.onMessage(makeMsg(service, bus, 'llm:done', { turnId: normalTurnId }));
    await flush();

    expect(tts.speak).toHaveBeenCalledWith(
      'Diese normale Antwort wird gesprochen.',
      expect.any(AbortSignal),
    );
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

  it('speaks an llm:filler through the safe TTS queue without changing voice state', async () => {
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

  it('defers an llm:filler while the microphone is listening', async () => {
    await service.init();
    (service as unknown as { setState: (state: string) => void }).setState('listening');

    service.onMessage(makeMsg(service, bus, 'llm:filler', { text: 'Einen Moment.' }));
    await flush();

    expect(tts.speak).not.toHaveBeenCalled();
    (service as unknown as { setState: (state: string) => void }).setState('processing');
    await vi.waitFor(() => expect(tts.speak).toHaveBeenCalledWith(
      'Einen Moment.',
      expect.any(AbortSignal),
    ));
  });

  it('defers an llm:filler while the renderer is unavailable', async () => {
    await service.init();
    (service as unknown as { rendererAvailable: boolean }).rendererAvailable = false;

    service.onMessage(makeMsg(service, bus, 'llm:filler', { text: 'Einen Moment.' }));
    await flush();

    expect(tts.speak).not.toHaveBeenCalled();
  });

  it('no-ops an llm:filler when TTS is unavailable', async () => {
    (tts.init as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('piper broken'));
    await service.init();

    // No ttsQueue exists → must not throw.
    expect(() => service.onMessage(makeMsg(service, bus, 'llm:filler', { text: 'Sofort.' }))).not.toThrow();
    expect(tts.speak).not.toHaveBeenCalled();
  });

  // --- 9c. Priority speech and timer pause ownership ---

  it('speaks a timer in idle without creating an artificial pause', async () => {
    await service.init();
    const playbacks: BusEvents['voice:play-audio'][] = [];
    bus.on('voice:play-audio', (message) => playbacks.push(message.data));
    const timerTurnId = randomUUID();

    service.onMessage(makePrioritySpeechMsg(bus, {
      turnId: timerTurnId,
      outputId: randomUUID(),
      text: 'Dein Timer ist abgelaufen.',
      priority: 'timer',
      pauseAfter: true,
    }));

    await vi.waitFor(() => expect(playbacks).toHaveLength(1));
    bus.emit('renderer', 'voice:playback-done', {
      turnId: playbacks[0].turnId,
      playbackId: playbacks[0].playbackId,
    });
    await flush();

    expect(tts.speak).toHaveBeenCalledWith(
      'Dein Timer ist abgelaufen.',
      expect.any(AbortSignal),
    );
    expect(service.isSpeechPaused).toBe(false);
    expect(service.voiceState).toBe('idle');
  });

  it('keeps priority speech silent when voice output is disabled', async () => {
    context = createMockContext(bus, 'off');
    service = new VoiceService(context, stt, tts, wakeWord, audio, hotkey);
    await service.init();

    service.onMessage(makePrioritySpeechMsg(bus, {
      turnId: randomUUID(),
      outputId: randomUUID(),
      text: 'Dein Timer ist abgelaufen.',
      priority: 'timer',
      pauseAfter: true,
    }));
    await flush();

    expect(tts.speak).not.toHaveBeenCalled();
    expect(service.isSpeechPaused).toBe(false);
    expect(service.voiceState).toBe('idle');
  });

  it('allows another timer during a pause and then resumes the preserved prebuffer', async () => {
    await service.init();
    const playbacks: BusEvents['voice:play-audio'][] = [];
    bus.on('voice:play-audio', (message) => playbacks.push(message.data));
    const normalTurnId = randomUUID();
    const timerTurnId = randomUUID();

    service.onMessage(makeMsg(service, bus, 'llm:chunk', {
      turnId: normalTurnId,
      text: 'Erster Satz. Zweiter Satz.',
    }));
    await vi.waitFor(() => expect(playbacks).toHaveLength(1));

    service.onMessage(makePrioritySpeechMsg(bus, {
      turnId: timerTurnId,
      outputId: randomUUID(),
      text: 'Dein Timer ist abgelaufen.',
      priority: 'timer',
      pauseAfter: true,
    }));
    bus.emit('renderer', 'voice:playback-done', {
      turnId: playbacks[0].turnId,
      playbackId: playbacks[0].playbackId,
    });
    await vi.waitFor(() => expect(playbacks).toHaveLength(2));
    expect(playbacks[1].turnId).toBe(timerTurnId);

    bus.emit('renderer', 'voice:playback-done', {
      turnId: playbacks[1].turnId,
      playbackId: playbacks[1].playbackId,
    });
    await flush();

    expect(service.isSpeechPaused).toBe(true);
    expect(service.voiceState).not.toBe('speaking');
    expect(playbacks).toHaveLength(2);

    const secondTimerTurnId = randomUUID();
    service.onMessage(makePrioritySpeechMsg(bus, {
      turnId: secondTimerTurnId,
      outputId: randomUUID(),
      text: 'Noch ein Timer.',
      priority: 'timer',
      pauseAfter: true,
    }));
    await vi.waitFor(() => expect(playbacks).toHaveLength(3));
    expect(playbacks[2].turnId).toBe(secondTimerTurnId);
    bus.emit('renderer', 'voice:playback-done', {
      turnId: playbacks[2].turnId,
      playbackId: playbacks[2].playbackId,
    });
    await flush();

    expect(service.isSpeechPaused).toBe(true);
    expect(service.voiceState).not.toBe('speaking');

    service.onMessage(makeResumeSpeechMsg());
    await vi.waitFor(() => expect(playbacks).toHaveLength(4));

    expect(playbacks[3].turnId).toBe(normalTurnId);
    expect(service.isSpeechPaused).toBe(false);
    expect(service.voiceState).toBe('speaking');
  });

  it('starts F9 capture during a timer pause without discarding normal speech', async () => {
    await service.init();
    const playbacks: BusEvents['voice:play-audio'][] = [];
    bus.on('voice:play-audio', (message) => playbacks.push(message.data));
    const normalTurnId = randomUUID();
    const timerTurnId = randomUUID();

    service.onMessage(makeMsg(service, bus, 'llm:chunk', {
      turnId: normalTurnId,
      text: 'Erster Satz. Zweiter Satz.',
    }));
    await vi.waitFor(() => expect(playbacks).toHaveLength(1));
    service.onMessage(makePrioritySpeechMsg(bus, {
      turnId: timerTurnId,
      outputId: randomUUID(),
      text: 'Timer.',
      priority: 'timer',
      pauseAfter: true,
    }));
    bus.emit('renderer', 'voice:playback-done', {
      turnId: playbacks[0].turnId,
      playbackId: playbacks[0].playbackId,
    });
    await vi.waitFor(() => expect(playbacks).toHaveLength(2));
    bus.emit('renderer', 'voice:playback-done', {
      turnId: playbacks[1].turnId,
      playbackId: playbacks[1].playbackId,
    });
    await vi.waitFor(() => expect(service.isSpeechPaused).toBe(true));

    const registerCall = (hotkey.register as ReturnType<typeof vi.fn>).mock.calls[0];
    const onDown = registerCall[1] as () => void;
    const onUp = registerCall[2] as () => void;
    onDown();

    expect(service.voiceState).toBe('listening');
    expect(tts.stop).not.toHaveBeenCalled();
    expect(service.isSpeechPaused).toBe(true);

    onUp();
    await vi.waitFor(() => expect(stt.transcribe).toHaveBeenCalledOnce());
    expect(service.isSpeechPaused).toBe(true);
    expect(playbacks).toHaveLength(2);

    service.onMessage(makeResumeSpeechMsg());
    await vi.waitFor(() => expect(playbacks).toHaveLength(3));
    expect(playbacks[2].turnId).toBe(normalTurnId);
  });

  it('discards paused speech after a content decision and preserves the new input turn', async () => {
    await service.init();
    const playbacks: BusEvents['voice:play-audio'][] = [];
    const chatMessages: BusEvents['chat:message'][] = [];
    const canceledTurns: BusEvents['turn:cancel'][] = [];
    const visibleTimerOutputs: BusEvents['llm:done'][] = [];
    const completedVoiceTurns: BusEvents['voice:done'][] = [];
    bus.on('voice:play-audio', (message) => playbacks.push(message.data));
    bus.on('chat:message', (message) => chatMessages.push(message.data));
    bus.on('turn:cancel', (message) => canceledTurns.push(message.data));
    bus.on('llm:done', (message) => {
      if (message.data.turnId === timerTurnId) visibleTimerOutputs.push(message.data);
    });
    bus.on('voice:done', (message) => completedVoiceTurns.push(message.data));
    const normalTurnId = randomUUID();
    const timerTurnId = randomUUID();

    service.onMessage(makeMsg(service, bus, 'llm:chunk', {
      turnId: normalTurnId,
      text: 'Erster Satz. Zweiter Satz.',
    }));
    await vi.waitFor(() => expect(playbacks).toHaveLength(1));
    service.onMessage(makePrioritySpeechMsg(bus, {
      turnId: timerTurnId,
      outputId: randomUUID(),
      text: 'Timer.',
      priority: 'timer',
      pauseAfter: true,
    }));
    bus.emit('renderer', 'voice:playback-done', {
      turnId: playbacks[0].turnId,
      playbackId: playbacks[0].playbackId,
    });
    await vi.waitFor(() => expect(playbacks).toHaveLength(2));
    bus.emit('renderer', 'voice:playback-done', {
      turnId: playbacks[1].turnId,
      playbackId: playbacks[1].playbackId,
    });
    await vi.waitFor(() => expect(service.isSpeechPaused).toBe(true));
    expect(visibleTimerOutputs).toHaveLength(0);

    const registerCall = (hotkey.register as ReturnType<typeof vi.fn>).mock.calls[0];
    const onDown = registerCall[1] as () => void;
    const onUp = registerCall[2] as () => void;
    onDown();
    onUp();
    await vi.waitFor(() => expect(chatMessages).toHaveLength(1));
    const newTurnId = chatMessages[0].turnId;

    service.onMessage(makeDiscardPausedSpeechMsg({
      preserveTurnId: newTurnId,
      reason: 'New user input superseded paused speech',
    }));

    expect(service.isSpeechPaused).toBe(false);
    expect(tts.stop).toHaveBeenCalledOnce();
    expect(canceledTurns.map((turn) => turn.turnId)).toContain(normalTurnId);
    expect(canceledTurns.map((turn) => turn.turnId)).not.toContain(newTurnId);
    expect(canceledTurns.map((turn) => turn.turnId)).not.toContain(timerTurnId);
    expect(bus.isTurnOpen(newTurnId)).toBe(true);
    expect(bus.isTurnOpen(timerTurnId)).toBe(true);

    service.onMessage(makeMsg(service, bus, 'llm:chunk', {
      turnId: newTurnId,
      text: 'Neue Antwort.',
    }));
    await vi.waitFor(() => expect(playbacks).toHaveLength(3));
    expect(playbacks[2].turnId).toBe(newTurnId);

    const timerOutputId = randomUUID();
    const timerChunk: BusEvents['llm:chunk'] = {
      turnId: timerTurnId,
      outputId: timerOutputId,
      sequence: 0,
      text: 'Timer.',
    };
    const timerDone: BusEvents['llm:done'] = {
      turnId: timerTurnId,
      outputId: timerOutputId,
      sequence: 1,
      fullText: 'Timer.',
    };
    service.onMessage({
      source: 'router',
      topic: 'turn:output-policy',
      data: { turnId: timerTurnId, speech: 'suppress' },
      timestamp: new Date().toISOString(),
    });
    bus.emit('router', 'llm:chunk', timerChunk);
    service.onMessage({
      source: 'router',
      topic: 'llm:chunk',
      data: timerChunk,
      timestamp: new Date().toISOString(),
    });
    bus.emit('router', 'llm:done', timerDone);
    service.onMessage({
      source: 'router',
      topic: 'llm:done',
      data: timerDone,
      timestamp: new Date().toISOString(),
    });
    const timerTerminal: BusEvents['turn:terminal'] = { turnId: timerTurnId, status: 'done' };
    bus.emit('router', 'turn:terminal', timerTerminal);
    service.onMessage({
      source: 'router',
      topic: 'turn:terminal',
      data: timerTerminal,
      timestamp: new Date().toISOString(),
    });

    expect(visibleTimerOutputs).toEqual([timerDone]);
    expect(completedVoiceTurns.filter((turn) => turn.turnId === timerTurnId)).toHaveLength(1);
    expect(bus.isTurnTerminal(timerTurnId)).toBe(true);
  });

  // --- 10. Interruption: speaking -> pressing PTT stops TTS, starts listening ---
});
