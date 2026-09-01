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

export function createMockStt(): SttProvider {
  return {
    id: 'mock-stt',
    init: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    transcribe: vi.fn<(audio: Float32Array, sampleRate: number) => Promise<string>>().mockResolvedValue('Hallo Sarah'),
    destroy: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  };
}

export function createMockTts(): TtsProvider {
  return {
    id: 'mock-tts',
    init: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    speak: vi.fn<(text: string) => Promise<Float32Array>>().mockResolvedValue(new Float32Array([0.1, 0.2])),
    stop: vi.fn(),
    destroy: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  };
}

export function createMockWakeWord(): WakeWordProvider {
  return {
    id: 'mock-wake',
    init: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    start: vi.fn<(onDetected: () => void) => void>(),
    stop: vi.fn(),
    destroy: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  };
}

export function createMockAudio(): AudioManager {
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

export function createMockHotkey(): HotkeyManager {
  return {
    register: vi.fn(),
    suspend: vi.fn(),
    resume: vi.fn(),
    unregister: vi.fn(),
    destroy: vi.fn(),
  } as HotkeyManager;
}

export function createMockContext(bus: MessageBus, voiceMode: string = 'push-to-talk'): AppContext {
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
export async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

export function acknowledgeCaptureFlushes(bus: MessageBus, service: VoiceService): void {
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
export function makeMsg(
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

export function autoCompletePlayback(bus: MessageBus): void {
  bus.on('voice:play-audio', (msg) => {
    setTimeout(() => bus.emit('renderer', 'voice:playback-done', {
      turnId: msg.data.turnId,
      playbackId: msg.data.playbackId,
    }), 0);
  });
}

export function terminalizeActiveOutput(service: VoiceService, bus: MessageBus): void {
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

export function makePrioritySpeechMsg(
  bus: MessageBus,
  data: BusEvents['voice:priority-speech'],
): TypedBusMessage<'voice:priority-speech'> {
  if (!bus.isTurnKnown(data.turnId)) {
    bus.emit('test', 'turn:accepted', { turnId: data.turnId, source: 'system', mode: 'voice' });
  }
  return {
    source: 'router',
    topic: 'voice:priority-speech',
    data,
    timestamp: new Date().toISOString(),
  };
}

export function makeResumeSpeechMsg(): TypedBusMessage<'voice:resume-speech'> {
  return {
    source: 'router',
    topic: 'voice:resume-speech',
    data: {},
    timestamp: new Date().toISOString(),
  };
}

export function makeDiscardPausedSpeechMsg(
  data: BusEvents['voice:discard-paused-speech'],
): TypedBusMessage<'voice:discard-paused-speech'> {
  return {
    source: 'router',
    topic: 'voice:discard-paused-speech',
    data,
    timestamp: new Date().toISOString(),
  };
}
