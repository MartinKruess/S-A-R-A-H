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

describe('VoiceService (turn ownership)', () => {
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
