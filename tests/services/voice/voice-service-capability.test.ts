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

  it('exposes an explicit retry path after recoverable STT initialization fails', async () => {
    const bus = new MessageBus();
    const stt = createMockStt();
    Object.defineProperty(stt, 'recoversAfterInitFailure', { value: true });
    (stt.init as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Python fehlt'));
    stt.retry = vi.fn().mockResolvedValue(undefined);
    const context = createMockContext(bus, 'push-to-talk');
    context.lifecycle = { setCapability: vi.fn() } as AppContext['lifecycle'];
    const service = new VoiceService(
      context,
      stt,
      createMockTts(),
      createMockWakeWord(),
      createMockAudio(),
      createMockHotkey(),
    );

    await service.init();
    expect(service.capabilitySnapshot.stt).toBe(false);
    await service.retryRuntimeRecovery();

    expect(stt.retry).toHaveBeenCalledOnce();
    expect(service.capabilitySnapshot.stt).toBe(true);
    expect(context.lifecycle.setCapability).toHaveBeenLastCalledWith('stt', 'ready', undefined);
    await service.destroy();
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
