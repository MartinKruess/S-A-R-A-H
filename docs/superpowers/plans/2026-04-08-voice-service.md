# Voice Service Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add offline voice interaction to Sarah with STT (Whisper), TTS (Piper), and Wake-Word (Porcupine), orchestrated by a VoiceService state machine.

**Architecture:** A `VoiceService` implements `SarahService` and manages a state machine (idle→listening→processing→speaking). Three provider interfaces (`SttProvider`, `TtsProvider`, `WakeWordProvider`) abstract the concrete implementations. An `AudioManager` handles microphone input and speaker output. All logic runs in the Main Process.

**Tech Stack:** whisper.cpp (child process), piper (child process), @picovoice/porcupine-node, naudiodon2 (mic/speaker), Electron globalShortcut

**Spec:** `docs/superpowers/specs/2026-04-08-voice-service-design.md`

---

## File Structure

```
src/services/voice/
├── voice-types.ts                  — Shared types (VoiceState, VoiceMode, abort phrases)
├── stt-provider.interface.ts       — SttProvider interface
├── tts-provider.interface.ts       — TtsProvider interface
├── wake-word-provider.interface.ts — WakeWordProvider interface
├── audio-manager.ts                — Microphone & speaker access (naudiodon2)
├── voice-service.ts                — VoiceService (SarahService, state machine, orchestrator)
├── hotkey-manager.ts               — Global hotkey registration (Electron globalShortcut)
└── providers/
    ├── whisper-provider.ts         — WhisperProvider (child process wrapper)
    ├── piper-provider.ts           — PiperProvider (child process wrapper)
    └── porcupine-provider.ts       — PorcupineProvider (@picovoice/porcupine-node)

tests/services/voice/
├── voice-service.test.ts           — State machine unit tests (mocked providers)
├── audio-manager.test.ts           — AudioManager unit tests (mocked naudiodon2)
└── hotkey-manager.test.ts          — HotkeyManager unit tests (mocked globalShortcut)

src/main.ts                         — Add VoiceService registration + IPC handlers
src/preload.ts                      — Add voice API to sarah namespace
```

---

### Task 1: Install Dependencies

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install runtime dependencies**

```bash
npm install naudiodon2 @picovoice/porcupine-node
```

`naudiodon2` provides native PortAudio bindings for microphone input and speaker output in Node.js (no external SoX dependency). `@picovoice/porcupine-node` provides the wake-word detection engine.

- [ ] **Step 2: Install type definitions**

```bash
npm install -D @types/naudiodon2
```

Note: `@picovoice/porcupine-node` ships its own types. If `@types/naudiodon2` does not exist on npm, skip this step — we'll declare the module in a `.d.ts` file in Task 2.

- [ ] **Step 3: Verify build still works**

Run: `npx tsc --noEmit`
Expected: No new errors

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add naudiodon2 and porcupine-node dependencies"
```

---

### Task 2: Shared Types & Provider Interfaces

**Files:**
- Create: `src/services/voice/voice-types.ts`
- Create: `src/services/voice/stt-provider.interface.ts`
- Create: `src/services/voice/tts-provider.interface.ts`
- Create: `src/services/voice/wake-word-provider.interface.ts`

- [ ] **Step 1: Create voice-types.ts**

```typescript
// src/services/voice/voice-types.ts

/** Voice service state machine states */
export type VoiceState = 'idle' | 'listening' | 'processing' | 'speaking';

/** Voice control modes — mutually exclusive */
export type VoiceMode = 'off' | 'keyword' | 'push-to-talk';

/** Silence duration before end-of-speech in keyword mode (ms) */
export const SILENCE_TIMEOUT_MS = 2_000;

/** Conversation window duration after last interaction in keyword mode (ms) */
export const CONVERSATION_WINDOW_MS = 60_000;

/** Default push-to-talk hotkey */
export const DEFAULT_PTT_KEY = 'F9';

/** Abort phrases that end the conversation window immediately */
export const ABORT_PHRASES: readonly string[] = [
  'sarah stop',
  'danke sarah',
  'sarah aus',
  'sarah du bist nicht gemeint',
] as const;

/** Check if a transcript contains an abort phrase */
export function isAbortPhrase(transcript: string): boolean {
  const normalized = transcript.toLowerCase().trim();
  return ABORT_PHRASES.some((phrase) => normalized.includes(phrase));
}
```

- [ ] **Step 2: Create stt-provider.interface.ts**

```typescript
// src/services/voice/stt-provider.interface.ts

export interface SttProvider {
  /** Unique provider ID, e.g. 'whisper' */
  readonly id: string;

  /** Initialize the provider (verify binary exists, load model) */
  init(): Promise<void>;

  /** Transcribe PCM audio to text */
  transcribe(audio: Float32Array, sampleRate: number): Promise<string>;

  /** Clean up resources */
  destroy(): Promise<void>;
}
```

- [ ] **Step 3: Create tts-provider.interface.ts**

```typescript
// src/services/voice/tts-provider.interface.ts

export interface TtsProvider {
  /** Unique provider ID, e.g. 'piper' */
  readonly id: string;

  /** Initialize the provider (verify binary exists, load voice model) */
  init(): Promise<void>;

  /** Convert text to PCM audio. Returns raw PCM Float32Array at 22050 Hz. */
  speak(text: string): Promise<Float32Array>;

  /** Stop any in-progress speech generation and playback */
  stop(): void;

  /** Clean up resources */
  destroy(): Promise<void>;
}
```

- [ ] **Step 4: Create wake-word-provider.interface.ts**

```typescript
// src/services/voice/wake-word-provider.interface.ts

export interface WakeWordProvider {
  /** Unique provider ID, e.g. 'porcupine' */
  readonly id: string;

  /** Initialize the provider (load wake-word model) */
  init(): Promise<void>;

  /**
   * Start listening for wake-word. Calls onDetected when wake-word is heard.
   * The provider manages its own audio input for wake-word detection.
   */
  start(onDetected: () => void): void;

  /** Stop listening for wake-word */
  stop(): void;

  /** Clean up resources */
  destroy(): Promise<void>;
}
```

- [ ] **Step 5: Verify build**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add src/services/voice/voice-types.ts src/services/voice/stt-provider.interface.ts src/services/voice/tts-provider.interface.ts src/services/voice/wake-word-provider.interface.ts
git commit -m "feat(voice): add shared types and provider interfaces"
```

---

### Task 3: AudioManager

**Files:**
- Create: `src/services/voice/audio-manager.ts`
- Create: `tests/services/voice/audio-manager.test.ts`

- [ ] **Step 1: Write failing tests for AudioManager**

```typescript
// tests/services/voice/audio-manager.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock naudiodon2 before importing AudioManager
vi.mock('naudiodon2', () => {
  const mockAudioInput = {
    on: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    destroy: vi.fn(),
  };
  const mockAudioOutput = {
    on: vi.fn(),
    write: vi.fn((_data: Buffer, _encoding: string, cb: () => void) => cb()),
    end: vi.fn(),
    destroy: vi.fn(),
  };
  return {
    AudioIO: vi.fn().mockImplementation(({ inOptions, outOptions }) => {
      if (inOptions) return mockAudioInput;
      if (outOptions) return mockAudioOutput;
      return mockAudioInput;
    }),
    SampleFormatFloat32: 8,
    __mockInput: mockAudioInput,
    __mockOutput: mockAudioOutput,
  };
});

import { AudioManager } from '../../../src/services/voice/audio-manager.js';

describe('AudioManager', () => {
  let manager: AudioManager;

  beforeEach(() => {
    manager = new AudioManager();
  });

  afterEach(async () => {
    await manager.destroy();
  });

  it('starts recording and emits audio chunks', () => {
    const onChunk = vi.fn();
    manager.startRecording(onChunk);
    expect(manager.isRecording).toBe(true);
  });

  it('stops recording', () => {
    const onChunk = vi.fn();
    manager.startRecording(onChunk);
    const audio = manager.stopRecording();
    expect(manager.isRecording).toBe(false);
    expect(audio).toBeInstanceOf(Float32Array);
  });

  it('does not start recording twice', () => {
    const onChunk = vi.fn();
    manager.startRecording(onChunk);
    manager.startRecording(onChunk);
    expect(manager.isRecording).toBe(true);
  });

  it('plays audio buffer', async () => {
    const audio = new Float32Array([0.1, 0.2, 0.3]);
    await manager.play(audio);
  });

  it('stops playback', () => {
    manager.stopPlayback();
    expect(manager.isPlaying).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/services/voice/audio-manager.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement AudioManager**

```typescript
// src/services/voice/audio-manager.ts
import { AudioIO, SampleFormatFloat32 } from 'naudiodon2';

const SAMPLE_RATE = 16_000;
const CHANNELS = 1;

export class AudioManager {
  private inputStream: ReturnType<typeof AudioIO> | null = null;
  private outputStream: ReturnType<typeof AudioIO> | null = null;
  private recordingChunks: Float32Array[] = [];
  private _isRecording = false;
  private _isPlaying = false;

  get isRecording(): boolean {
    return this._isRecording;
  }

  get isPlaying(): boolean {
    return this._isPlaying;
  }

  /**
   * Start recording from the microphone.
   * @param onChunk — called with each PCM chunk for real-time processing (e.g. VAD)
   */
  startRecording(onChunk?: (chunk: Float32Array) => void): void {
    if (this._isRecording) return;

    this.recordingChunks = [];
    this.inputStream = AudioIO({
      inOptions: {
        channelCount: CHANNELS,
        sampleFormat: SampleFormatFloat32,
        sampleRate: SAMPLE_RATE,
        framesPerBuffer: 1024,
      },
    });

    this.inputStream.on('data', (buffer: Buffer) => {
      const float32 = new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4);
      this.recordingChunks.push(new Float32Array(float32));
      onChunk?.(float32);
    });

    this.inputStream.start();
    this._isRecording = true;
  }

  /**
   * Stop recording and return the complete audio buffer.
   */
  stopRecording(): Float32Array {
    if (!this._isRecording || !this.inputStream) {
      return new Float32Array(0);
    }

    this.inputStream.stop();
    this.inputStream.destroy();
    this.inputStream = null;
    this._isRecording = false;

    const totalLength = this.recordingChunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const combined = new Float32Array(totalLength);
    let offset = 0;
    for (const chunk of this.recordingChunks) {
      combined.set(chunk, offset);
      offset += chunk.length;
    }
    this.recordingChunks = [];
    return combined;
  }

  /**
   * Play PCM audio through the speakers.
   */
  async play(audio: Float32Array): Promise<void> {
    this._isPlaying = true;

    this.outputStream = AudioIO({
      outOptions: {
        channelCount: CHANNELS,
        sampleFormat: SampleFormatFloat32,
        sampleRate: 22_050, // Piper outputs at 22050 Hz
        framesPerBuffer: 1024,
      },
    });

    const buffer = Buffer.from(audio.buffer);

    return new Promise<void>((resolve) => {
      this.outputStream!.write(buffer, 'binary', () => {
        this.outputStream!.end();
        this._isPlaying = false;
        this.outputStream = null;
        resolve();
      });
    });
  }

  /**
   * Stop any in-progress playback immediately.
   */
  stopPlayback(): void {
    if (this.outputStream) {
      this.outputStream.destroy();
      this.outputStream = null;
    }
    this._isPlaying = false;
  }

  /**
   * Clean up all resources.
   */
  async destroy(): Promise<void> {
    this.stopPlayback();
    if (this._isRecording) {
      this.stopRecording();
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/services/voice/audio-manager.test.ts`
Expected: PASS — all 5 tests

- [ ] **Step 5: Commit**

```bash
git add src/services/voice/audio-manager.ts tests/services/voice/audio-manager.test.ts
git commit -m "feat(voice): add AudioManager for mic input and speaker output"
```

---

### Task 4: HotkeyManager

**Files:**
- Create: `src/services/voice/hotkey-manager.ts`
- Create: `tests/services/voice/hotkey-manager.test.ts`

- [ ] **Step 1: Write failing tests for HotkeyManager**

```typescript
// tests/services/voice/hotkey-manager.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock electron
vi.mock('electron', () => ({
  globalShortcut: {
    register: vi.fn().mockReturnValue(true),
    unregister: vi.fn(),
    isRegistered: vi.fn().mockReturnValue(false),
  },
}));

import { HotkeyManager } from '../../../src/services/voice/hotkey-manager.js';
import { globalShortcut } from 'electron';

describe('HotkeyManager', () => {
  let manager: HotkeyManager;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new HotkeyManager();
  });

  afterEach(() => {
    manager.unregister();
  });

  it('registers a global hotkey', () => {
    const onDown = vi.fn();
    const onUp = vi.fn();
    manager.register('F9', onDown, onUp);
    expect(globalShortcut.register).toHaveBeenCalled();
  });

  it('unregisters the hotkey', () => {
    const onDown = vi.fn();
    const onUp = vi.fn();
    manager.register('F9', onDown, onUp);
    manager.unregister();
    expect(globalShortcut.unregister).toHaveBeenCalled();
  });

  it('changes hotkey by unregistering old and registering new', () => {
    const onDown = vi.fn();
    const onUp = vi.fn();
    manager.register('F9', onDown, onUp);
    manager.register('F10', onDown, onUp);
    expect(globalShortcut.unregister).toHaveBeenCalledTimes(1);
    expect(globalShortcut.register).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/services/voice/hotkey-manager.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement HotkeyManager**

```typescript
// src/services/voice/hotkey-manager.ts
import { globalShortcut } from 'electron';

/**
 * Manages a global Push-to-Talk hotkey.
 * Electron's globalShortcut only fires on keydown. For keyup detection,
 * we register the accelerator and use a polling approach to detect release.
 */
export class HotkeyManager {
  private currentKey: string | null = null;
  private pollInterval: ReturnType<typeof setInterval> | null = null;

  /**
   * Register a global hotkey for push-to-talk.
   * @param key — Electron accelerator string, e.g. 'F9'
   * @param onDown — Called when key is pressed
   * @param onUp — Called when key is released
   */
  register(key: string, onDown: () => void, onUp: () => void): void {
    if (this.currentKey) {
      this.unregister();
    }

    this.currentKey = key;
    let isDown = false;

    globalShortcut.register(key, () => {
      if (!isDown) {
        isDown = true;
        onDown();

        // Poll for key release — globalShortcut has no keyup event
        this.pollInterval = setInterval(() => {
          if (!globalShortcut.isRegistered(key)) return;
          // Re-register triggers if key was released and pressed again
          // For sustained hold: the accelerator fires repeatedly on some OS
          // We rely on the initial press and detect release via absence of repeat
        }, 100);
      }
    });

    // Register the "CommandOrControl+key" variant to catch release
    // Simpler approach: register both press and release using a toggle
    // Since Electron lacks keyup, we use a secondary approach:
    // Register the key, on first fire = keyDown, on repeated fire within 150ms = still held
    // After 150ms without fire = keyUp
    let lastFireTime = 0;
    const originalRegister = globalShortcut.register;

    // Clean approach: use a timeout to detect release
    globalShortcut.unregister(key);
    globalShortcut.register(key, () => {
      const now = Date.now();
      if (!isDown) {
        isDown = true;
        onDown();
      }
      lastFireTime = now;

      if (this.pollInterval) clearInterval(this.pollInterval);
      this.pollInterval = setInterval(() => {
        if (Date.now() - lastFireTime > 200) {
          isDown = false;
          onUp();
          if (this.pollInterval) {
            clearInterval(this.pollInterval);
            this.pollInterval = null;
          }
        }
      }, 50);
    });
  }

  /**
   * Unregister the current hotkey.
   */
  unregister(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    if (this.currentKey) {
      globalShortcut.unregister(this.currentKey);
      this.currentKey = null;
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/services/voice/hotkey-manager.test.ts`
Expected: PASS — all 3 tests

- [ ] **Step 5: Commit**

```bash
git add src/services/voice/hotkey-manager.ts tests/services/voice/hotkey-manager.test.ts
git commit -m "feat(voice): add HotkeyManager for global push-to-talk hotkey"
```

---

### Task 5: VoiceService — State Machine Core

This is the main orchestrator. It implements `SarahService`, manages the state machine, and coordinates all providers.

**Files:**
- Create: `src/services/voice/voice-service.ts`
- Create: `tests/services/voice/voice-service.test.ts`

- [ ] **Step 1: Write failing tests for VoiceService state machine**

```typescript
// tests/services/voice/voice-service.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MessageBus } from '../../../src/core/message-bus.js';
import { VoiceService } from '../../../src/services/voice/voice-service.js';
import type { SttProvider } from '../../../src/services/voice/stt-provider.interface.js';
import type { TtsProvider } from '../../../src/services/voice/tts-provider.interface.js';
import type { WakeWordProvider } from '../../../src/services/voice/wake-word-provider.interface.js';
import type { AudioManager } from '../../../src/services/voice/audio-manager.js';
import type { HotkeyManager } from '../../../src/services/voice/hotkey-manager.js';
import type { AppContext } from '../../../src/core/bootstrap.js';

function createMockStt(): SttProvider {
  return {
    id: 'mock-stt',
    init: vi.fn(async () => {}),
    transcribe: vi.fn(async () => 'Hallo Sarah'),
    destroy: vi.fn(async () => {}),
  };
}

function createMockTts(): TtsProvider {
  return {
    id: 'mock-tts',
    init: vi.fn(async () => {}),
    speak: vi.fn(async () => new Float32Array([0.1, 0.2])),
    stop: vi.fn(),
    destroy: vi.fn(async () => {}),
  };
}

function createMockWakeWord(): WakeWordProvider {
  return {
    id: 'mock-ww',
    init: vi.fn(async () => {}),
    start: vi.fn(),
    stop: vi.fn(),
    destroy: vi.fn(async () => {}),
  };
}

function createMockAudioManager(): AudioManager {
  return {
    isRecording: false,
    isPlaying: false,
    startRecording: vi.fn(),
    stopRecording: vi.fn(() => new Float32Array([0.1, 0.2, 0.3])),
    play: vi.fn(async () => {}),
    stopPlayback: vi.fn(),
    destroy: vi.fn(async () => {}),
  } as unknown as AudioManager;
}

function createMockHotkeyManager(): HotkeyManager {
  return {
    register: vi.fn(),
    unregister: vi.fn(),
  } as unknown as HotkeyManager;
}

function createMockContext(bus: MessageBus): AppContext {
  return {
    bus,
    registry: {} as AppContext['registry'],
    config: {
      get: vi.fn(async (key: string) => {
        if (key === 'root') {
          return {
            controls: {
              voiceMode: 'push-to-talk',
              pushToTalkKey: 'F9',
              quietModeDuration: 60,
              customCommands: [],
            },
          };
        }
        return undefined;
      }),
      set: vi.fn(async () => {}),
      query: vi.fn(async () => []),
      insert: vi.fn(async () => 1),
      update: vi.fn(async () => 1),
      delete: vi.fn(async () => 1),
      close: vi.fn(async () => {}),
    },
    db: {
      get: vi.fn(async () => undefined),
      set: vi.fn(async () => {}),
      query: vi.fn(async () => []),
      insert: vi.fn(async () => 1),
      update: vi.fn(async () => 1),
      delete: vi.fn(async () => 1),
      close: vi.fn(async () => {}),
    },
    shutdown: vi.fn(async () => {}),
  };
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
    audio = createMockAudioManager();
    hotkey = createMockHotkeyManager();
    context = createMockContext(bus);
    service = new VoiceService(context, stt, tts, wakeWord, audio, hotkey);
  });

  afterEach(async () => {
    await service.destroy();
  });

  it('has correct id and initial status', () => {
    expect(service.id).toBe('voice');
    expect(service.status).toBe('pending');
  });

  it('subscribes to llm:done and llm:chunk', () => {
    expect(service.subscriptions).toContain('llm:done');
    expect(service.subscriptions).toContain('llm:chunk');
  });

  it('initializes all providers on init', async () => {
    await service.init();
    expect(stt.init).toHaveBeenCalledOnce();
    expect(tts.init).toHaveBeenCalledOnce();
    expect(service.status).toBe('running');
  });

  it('starts in idle state after init', async () => {
    await service.init();
    expect(service.voiceState).toBe('idle');
  });

  it('registers hotkey in push-to-talk mode', async () => {
    await service.init();
    expect(hotkey.register).toHaveBeenCalledWith('F9', expect.any(Function), expect.any(Function));
  });

  it('starts wake-word listener in keyword mode', async () => {
    (context.config.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      controls: { voiceMode: 'keyword', pushToTalkKey: 'F9' },
    });
    await service.init();
    expect(wakeWord.init).toHaveBeenCalledOnce();
    expect(wakeWord.start).toHaveBeenCalledOnce();
  });

  it('does not start any listener when voice is off', async () => {
    (context.config.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      controls: { voiceMode: 'off', pushToTalkKey: 'F9' },
    });
    await service.init();
    expect(hotkey.register).not.toHaveBeenCalled();
    expect(wakeWord.start).not.toHaveBeenCalled();
  });

  it('transitions to listening when hotkey pressed', async () => {
    await service.init();
    // Extract the onDown callback from hotkey.register call
    const onDown = (hotkey.register as ReturnType<typeof vi.fn>).mock.calls[0][1];
    onDown();
    expect(service.voiceState).toBe('listening');
    expect(audio.startRecording).toHaveBeenCalled();
  });

  it('transitions to processing when hotkey released', async () => {
    await service.init();
    const [, onDown, onUp] = (hotkey.register as ReturnType<typeof vi.fn>).mock.calls[0];
    onDown();
    await onUp();
    expect(audio.stopRecording).toHaveBeenCalled();
    expect(stt.transcribe).toHaveBeenCalled();
  });

  it('emits chat:message with transcript after processing', async () => {
    const emitted: string[] = [];
    bus.on('chat:message', (msg) => emitted.push(msg.data.text as string));

    await service.init();
    const [, onDown, onUp] = (hotkey.register as ReturnType<typeof vi.fn>).mock.calls[0];
    onDown();
    await onUp();

    expect(emitted).toContain('Hallo Sarah');
  });

  it('detects abort phrase and does not emit chat:message', async () => {
    (stt.transcribe as ReturnType<typeof vi.fn>).mockResolvedValueOnce('Sarah stop');
    const emitted: string[] = [];
    bus.on('chat:message', (msg) => emitted.push(msg.data.text as string));

    await service.init();
    const [, onDown, onUp] = (hotkey.register as ReturnType<typeof vi.fn>).mock.calls[0];
    onDown();
    await onUp();

    expect(emitted).toHaveLength(0);
  });

  it('speaks LLM response via TTS on llm:done', async () => {
    await service.init();
    // Simulate LLM done event
    service.onMessage({
      source: 'llm',
      topic: 'llm:done',
      data: { fullText: 'Das Wetter wird schön.' },
      timestamp: new Date().toISOString(),
    });

    // Wait for async TTS
    await vi.waitFor(() => {
      expect(tts.speak).toHaveBeenCalledWith('Das Wetter wird schön.');
    });
  });

  it('stops TTS when interrupted', async () => {
    await service.init();
    // Put service in speaking state by simulating llm:done
    service.onMessage({
      source: 'llm',
      topic: 'llm:done',
      data: { fullText: 'Eine lange Antwort...' },
      timestamp: new Date().toISOString(),
    });

    // Interrupt by pressing hotkey
    const [, onDown] = (hotkey.register as ReturnType<typeof vi.fn>).mock.calls[0];
    onDown();

    expect(tts.stop).toHaveBeenCalled();
    expect(service.voiceState).toBe('listening');
  });

  it('destroys all providers on destroy', async () => {
    await service.init();
    await service.destroy();
    expect(stt.destroy).toHaveBeenCalledOnce();
    expect(tts.destroy).toHaveBeenCalledOnce();
    expect(hotkey.unregister).toHaveBeenCalled();
    expect(service.status).toBe('stopped');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/services/voice/voice-service.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement VoiceService**

```typescript
// src/services/voice/voice-service.ts
import type { SarahService } from '../../core/service.interface.js';
import type { BusMessage, ServiceStatus } from '../../core/types.js';
import type { AppContext } from '../../core/bootstrap.js';
import type { SttProvider } from './stt-provider.interface.js';
import type { TtsProvider } from './tts-provider.interface.js';
import type { WakeWordProvider } from './wake-word-provider.interface.js';
import type { AudioManager } from './audio-manager.js';
import type { HotkeyManager } from './hotkey-manager.js';
import {
  type VoiceState,
  type VoiceMode,
  SILENCE_TIMEOUT_MS,
  CONVERSATION_WINDOW_MS,
  DEFAULT_PTT_KEY,
  isAbortPhrase,
} from './voice-types.js';

export class VoiceService implements SarahService {
  readonly id = 'voice';
  readonly subscriptions = ['llm:done', 'llm:chunk'];
  status: ServiceStatus = 'pending';

  private _voiceState: VoiceState = 'idle';
  private voiceMode: VoiceMode = 'off';
  private conversationActive = false;
  private conversationTimer: ReturnType<typeof setTimeout> | null = null;
  private silenceTimer: ReturnType<typeof setTimeout> | null = null;

  get voiceState(): VoiceState {
    return this._voiceState;
  }

  constructor(
    private context: AppContext,
    private stt: SttProvider,
    private tts: TtsProvider,
    private wakeWord: WakeWordProvider,
    private audio: AudioManager,
    private hotkey: HotkeyManager,
  ) {}

  async init(): Promise<void> {
    const config = (await this.context.config.get<Record<string, Record<string, unknown>>>('root')) ?? {};
    const controls = config.controls ?? {};
    this.voiceMode = (controls.voiceMode as VoiceMode) ?? 'off';
    const pttKey = (controls.pushToTalkKey as string) ?? DEFAULT_PTT_KEY;

    await this.stt.init();
    await this.tts.init();

    if (this.voiceMode === 'push-to-talk') {
      this.hotkey.register(
        pttKey,
        () => this.onPttDown(),
        () => this.onPttUp(),
      );
    } else if (this.voiceMode === 'keyword') {
      await this.wakeWord.init();
      this.wakeWord.start(() => this.onWakeWordDetected());
    }

    this._voiceState = 'idle';
    this.status = 'running';
  }

  async destroy(): Promise<void> {
    this.clearTimers();
    this.hotkey.unregister();
    await this.stt.destroy();
    await this.tts.destroy();
    await this.wakeWord.destroy();
    await this.audio.destroy();
    this._voiceState = 'idle';
    this.status = 'stopped';
  }

  onMessage(msg: BusMessage): void {
    if (msg.topic === 'llm:done' && this.voiceMode !== 'off') {
      const fullText = msg.data.fullText as string;
      this.speakResponse(fullText).catch(() => {
        this.emitError('Sprachausgabe fehlgeschlagen.');
      });
    }
  }

  // --- Push-to-Talk handlers ---

  private onPttDown(): void {
    if (this._voiceState === 'speaking') {
      this.interrupt();
    }
    this.startListening();
  }

  private async onPttUp(): Promise<void> {
    if (this._voiceState !== 'listening') return;
    await this.stopListeningAndProcess();
  }

  // --- Keyword mode handlers ---

  private onWakeWordDetected(): void {
    this.context.bus.emit(this.id, 'voice:wake', {});

    if (this._voiceState === 'speaking') {
      this.interrupt();
    }

    this.conversationActive = true;
    this.resetConversationTimer();
    this.startListening();
  }

  private onSilenceDetected(): void {
    if (this._voiceState !== 'listening') return;
    this.stopListeningAndProcess().catch(() => {
      this.emitError('Verarbeitung fehlgeschlagen.');
    });
  }

  // --- Core flow ---

  private startListening(): void {
    this._voiceState = 'listening';
    this.context.bus.emit(this.id, 'voice:listening', {});

    this.audio.startRecording((chunk) => {
      if (this.voiceMode === 'keyword') {
        this.checkSilence(chunk);
      }
    });
  }

  private async stopListeningAndProcess(): Promise<void> {
    const audioData = this.audio.stopRecording();
    this._voiceState = 'processing';

    const transcript = await this.stt.transcribe(audioData, 16_000);

    if (!transcript.trim()) {
      this._voiceState = 'idle';
      return;
    }

    if (isAbortPhrase(transcript)) {
      this.endConversation();
      this._voiceState = 'idle';
      return;
    }

    // Emit transcript for Chat-UI (if open)
    this.context.bus.emit(this.id, 'voice:transcript', { text: transcript });

    // Send to LLM via the same bus topic as typed messages
    this.context.bus.emit(this.id, 'chat:message', { text: transcript });

    if (this.conversationActive) {
      this.resetConversationTimer();
    }
  }

  private async speakResponse(text: string): Promise<void> {
    this._voiceState = 'speaking';
    this.context.bus.emit(this.id, 'voice:speaking', {});

    const audioData = await this.tts.speak(text);
    await this.audio.play(audioData);

    this._voiceState = 'idle';
    this.context.bus.emit(this.id, 'voice:done', {});

    // In keyword mode, start listening again within conversation window
    if (this.voiceMode === 'keyword' && this.conversationActive) {
      this.startListening();
    }
  }

  private interrupt(): void {
    this.tts.stop();
    this.audio.stopPlayback();
    this.context.bus.emit(this.id, 'voice:interrupted', {});
  }

  // --- VAD (Voice Activity Detection) ---

  private checkSilence(chunk: Float32Array): void {
    const rms = Math.sqrt(chunk.reduce((sum, v) => sum + v * v, 0) / chunk.length);
    const silenceThreshold = 0.01;

    if (rms < silenceThreshold) {
      if (!this.silenceTimer) {
        this.silenceTimer = setTimeout(() => {
          this.silenceTimer = null;
          this.onSilenceDetected();
        }, SILENCE_TIMEOUT_MS);
      }
    } else {
      this.clearSilenceTimer();
    }
  }

  // --- Conversation window ---

  private resetConversationTimer(): void {
    if (this.conversationTimer) clearTimeout(this.conversationTimer);
    this.conversationTimer = setTimeout(() => {
      this.endConversation();
    }, CONVERSATION_WINDOW_MS);
  }

  private endConversation(): void {
    this.conversationActive = false;
    this.clearTimers();
    if (this._voiceState === 'listening') {
      this.audio.stopRecording();
      this._voiceState = 'idle';
    }
    // Restart wake-word listening
    if (this.voiceMode === 'keyword') {
      this.wakeWord.start(() => this.onWakeWordDetected());
    }
  }

  // --- Helpers ---

  private clearTimers(): void {
    this.clearSilenceTimer();
    if (this.conversationTimer) {
      clearTimeout(this.conversationTimer);
      this.conversationTimer = null;
    }
  }

  private clearSilenceTimer(): void {
    if (this.silenceTimer) {
      clearTimeout(this.silenceTimer);
      this.silenceTimer = null;
    }
  }

  private emitError(message: string): void {
    this.context.bus.emit(this.id, 'voice:error', { message });
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/services/voice/voice-service.test.ts`
Expected: PASS — all tests

- [ ] **Step 5: Commit**

```bash
git add src/services/voice/voice-service.ts tests/services/voice/voice-service.test.ts
git commit -m "feat(voice): add VoiceService state machine with conversation window"
```

---

### Task 6: WhisperProvider

**Files:**
- Create: `src/services/voice/providers/whisper-provider.ts`

- [ ] **Step 1: Implement WhisperProvider**

```typescript
// src/services/voice/providers/whisper-provider.ts
import { spawn, type ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import type { SttProvider } from '../stt-provider.interface.js';

export class WhisperProvider implements SttProvider {
  readonly id = 'whisper';
  private binaryPath: string;
  private modelPath: string;

  /**
   * @param resourcesPath — path to app resources directory (e.g. process.resourcesPath)
   */
  constructor(resourcesPath: string) {
    this.binaryPath = path.join(resourcesPath, 'whisper', 'whisper.exe');
    this.modelPath = path.join(resourcesPath, 'whisper', 'models', 'ggml-small.bin');
  }

  async init(): Promise<void> {
    if (!fs.existsSync(this.binaryPath)) {
      throw new Error(`Whisper binary not found: ${this.binaryPath}`);
    }
    if (!fs.existsSync(this.modelPath)) {
      throw new Error(`Whisper model not found: ${this.modelPath}`);
    }
  }

  async transcribe(audio: Float32Array, sampleRate: number): Promise<string> {
    // Write PCM to temp file (whisper.cpp reads WAV/PCM files)
    const tmpPath = path.join(process.env.TEMP ?? '/tmp', `sarah-stt-${Date.now()}.raw`);
    const buffer = Buffer.from(audio.buffer);
    fs.writeFileSync(tmpPath, buffer);

    try {
      const result = await this.runWhisper(tmpPath, sampleRate);
      return result.trim();
    } finally {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    }
  }

  async destroy(): Promise<void> {
    // No persistent process to clean up
  }

  private runWhisper(audioPath: string, sampleRate: number): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const args = [
        '--model', this.modelPath,
        '--file', audioPath,
        '--language', 'de',
        '--output-txt',
        '--no-timestamps',
        '--threads', '4',
      ];

      const proc: ChildProcess = spawn(this.binaryPath, args);
      let stdout = '';
      let stderr = '';

      proc.stdout?.on('data', (data: Buffer) => {
        stdout += data.toString();
      });

      proc.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString();
      });

      proc.on('close', (code) => {
        if (code === 0) {
          resolve(stdout);
        } else {
          reject(new Error(`Whisper exited with code ${code}: ${stderr}`));
        }
      });

      proc.on('error', (err) => {
        reject(new Error(`Failed to start whisper: ${err.message}`));
      });

      // Timeout after 30 seconds
      setTimeout(() => {
        proc.kill();
        reject(new Error('Whisper transcription timed out'));
      }, 30_000);
    });
  }
}
```

- [ ] **Step 2: Verify build**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/services/voice/providers/whisper-provider.ts
git commit -m "feat(voice): add WhisperProvider for offline STT via whisper.cpp"
```

---

### Task 7: PiperProvider

**Files:**
- Create: `src/services/voice/providers/piper-provider.ts`

- [ ] **Step 1: Implement PiperProvider**

```typescript
// src/services/voice/providers/piper-provider.ts
import { spawn, type ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import type { TtsProvider } from '../tts-provider.interface.js';

export class PiperProvider implements TtsProvider {
  readonly id = 'piper';
  private binaryPath: string;
  private voicePath: string;
  private activeProcess: ChildProcess | null = null;

  /**
   * @param resourcesPath — path to app resources directory
   */
  constructor(resourcesPath: string) {
    this.binaryPath = path.join(resourcesPath, 'piper', 'piper.exe');
    this.voicePath = path.join(resourcesPath, 'piper', 'voices', 'de_DE-thorsten-medium.onnx');
  }

  async init(): Promise<void> {
    if (!fs.existsSync(this.binaryPath)) {
      throw new Error(`Piper binary not found: ${this.binaryPath}`);
    }
    if (!fs.existsSync(this.voicePath)) {
      throw new Error(`Piper voice not found: ${this.voicePath}`);
    }
  }

  async speak(text: string): Promise<Float32Array> {
    return new Promise<Float32Array>((resolve, reject) => {
      const args = [
        '--model', this.voicePath,
        '--output_raw',
      ];

      this.activeProcess = spawn(this.binaryPath, args);
      const chunks: Buffer[] = [];

      this.activeProcess.stdout?.on('data', (data: Buffer) => {
        chunks.push(data);
      });

      this.activeProcess.stderr?.on('data', () => {
        // Piper logs to stderr, ignore
      });

      this.activeProcess.on('close', (code) => {
        this.activeProcess = null;
        if (code === 0 || code === null) {
          const combined = Buffer.concat(chunks);
          // Piper outputs 16-bit PCM at 22050 Hz — convert to Float32
          const int16 = new Int16Array(combined.buffer, combined.byteOffset, combined.byteLength / 2);
          const float32 = new Float32Array(int16.length);
          for (let i = 0; i < int16.length; i++) {
            float32[i] = int16[i] / 32768;
          }
          resolve(float32);
        } else {
          reject(new Error(`Piper exited with code ${code}`));
        }
      });

      this.activeProcess.on('error', (err) => {
        this.activeProcess = null;
        reject(new Error(`Failed to start piper: ${err.message}`));
      });

      // Send text to piper via stdin
      this.activeProcess.stdin?.write(text);
      this.activeProcess.stdin?.end();

      // Timeout after 30 seconds
      setTimeout(() => {
        this.stop();
        reject(new Error('Piper speech generation timed out'));
      }, 30_000);
    });
  }

  stop(): void {
    if (this.activeProcess) {
      this.activeProcess.kill();
      this.activeProcess = null;
    }
  }

  async destroy(): Promise<void> {
    this.stop();
  }
}
```

- [ ] **Step 2: Verify build**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/services/voice/providers/piper-provider.ts
git commit -m "feat(voice): add PiperProvider for offline TTS via piper"
```

---

### Task 8: PorcupineProvider

**Files:**
- Create: `src/services/voice/providers/porcupine-provider.ts`

- [ ] **Step 1: Implement PorcupineProvider**

```typescript
// src/services/voice/providers/porcupine-provider.ts
import * as path from 'path';
import * as fs from 'fs';
import type { WakeWordProvider } from '../wake-word-provider.interface.js';

// Dynamic import to avoid bundling issues — porcupine is a native module
let Porcupine: typeof import('@picovoice/porcupine-node').Porcupine;

export class PorcupineProvider implements WakeWordProvider {
  readonly id = 'porcupine';
  private instance: InstanceType<typeof Porcupine> | null = null;
  private modelPath: string;
  private listening = false;
  private pollInterval: ReturnType<typeof setInterval> | null = null;

  /**
   * @param resourcesPath — path to app resources directory
   * @param accessKey — Picovoice access key (free for personal use)
   */
  constructor(
    resourcesPath: string,
    private accessKey: string,
  ) {
    this.modelPath = path.join(resourcesPath, 'porcupine', 'sarah_ww.ppn');
  }

  async init(): Promise<void> {
    if (!fs.existsSync(this.modelPath)) {
      throw new Error(`Porcupine wake-word model not found: ${this.modelPath}`);
    }

    const porcupineModule = await import('@picovoice/porcupine-node');
    Porcupine = porcupineModule.Porcupine;

    this.instance = new Porcupine(
      this.accessKey,
      [this.modelPath],
      [0.5], // sensitivity
    );
  }

  start(onDetected: () => void): void {
    if (!this.instance || this.listening) return;
    this.listening = true;

    // Porcupine processes audio frames. We need to feed it mic audio.
    // The AudioManager is not used here — Porcupine has its own lightweight
    // audio processing to avoid keeping the full recording pipeline active.
    // In practice, we use @picovoice/porcupine-node's built-in recorder.

    // For now, we use a polling approach with the PvRecorder from picovoice
    const { PvRecorder } = require('@picovoice/porcupine-node');
    const recorder = new PvRecorder(this.instance.frameLength);
    recorder.start();

    this.pollInterval = setInterval(() => {
      if (!this.listening || !this.instance) return;
      const frame = recorder.read();
      const keywordIndex = this.instance.process(frame);
      if (keywordIndex >= 0) {
        recorder.stop();
        this.listening = false;
        if (this.pollInterval) {
          clearInterval(this.pollInterval);
          this.pollInterval = null;
        }
        onDetected();
      }
    }, 10);
  }

  stop(): void {
    this.listening = false;
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }

  async destroy(): Promise<void> {
    this.stop();
    if (this.instance) {
      this.instance.release();
      this.instance = null;
    }
  }
}
```

- [ ] **Step 2: Verify build**

Run: `npx tsc --noEmit`
Expected: No errors (may need to adjust import if porcupine types differ — check actual package API)

- [ ] **Step 3: Commit**

```bash
git add src/services/voice/providers/porcupine-provider.ts
git commit -m "feat(voice): add PorcupineProvider for wake-word detection"
```

---

### Task 9: IPC Handlers & Preload API

**Files:**
- Modify: `src/preload.ts`
- Modify: `src/main.ts` (IPC handler section)

- [ ] **Step 1: Add voice API to preload.ts**

Add the following to the `contextBridge.exposeInMainWorld('sarah', { ... })` object in `src/preload.ts`, after the existing Chat API block:

```typescript
  // Voice API
  voice: {
    getState: () => ipcRenderer.invoke('voice-get-state'),
    onStateChange: (callback: (data: { state: string }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: { state: string }) => callback(data);
      ipcRenderer.on('voice:state', handler);
      return () => ipcRenderer.removeListener('voice:state', handler);
    },
    onTranscript: (callback: (data: { text: string }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: { text: string }) => callback(data);
      ipcRenderer.on('voice:transcript', handler);
      return () => ipcRenderer.removeListener('voice:transcript', handler);
    },
    onError: (callback: (data: { message: string }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: { message: string }) => callback(data);
      ipcRenderer.on('voice:error', handler);
      return () => ipcRenderer.removeListener('voice:error', handler);
    },
  },
```

- [ ] **Step 2: Add IPC handlers in main.ts**

Add the following to `src/main.ts` in the section where IPC handlers are registered (after the chat IPC handlers):

```typescript
  // Voice IPC handlers
  ipcMain.handle('voice-get-state', () => {
    const voiceService = appContext?.registry.get('voice');
    if (!voiceService) return 'idle';
    return (voiceService as VoiceService).voiceState;
  });

  // Forward voice events to all renderer windows
  forwardToRenderers('voice:listening');
  forwardToRenderers('voice:transcript');
  forwardToRenderers('voice:speaking');
  forwardToRenderers('voice:done');
  forwardToRenderers('voice:error');
  forwardToRenderers('voice:interrupted');
  forwardToRenderers('voice:wake');

  // Map voice state changes for the renderer
  const voiceStateTopics = ['voice:listening', 'voice:speaking', 'voice:done', 'voice:error', 'voice:interrupted'];
  const stateMap: Record<string, string> = {
    'voice:listening': 'listening',
    'voice:speaking': 'speaking',
    'voice:done': 'idle',
    'voice:error': 'idle',
    'voice:interrupted': 'listening',
  };
  for (const topic of voiceStateTopics) {
    appContext!.bus.on(topic, () => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) {
          win.webContents.send('voice:state', { state: stateMap[topic] });
        }
      }
    });
  }
```

Also add the import at the top of `main.ts`:

```typescript
import { VoiceService } from './services/voice/voice-service.js';
```

- [ ] **Step 3: Verify build**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/preload.ts src/main.ts
git commit -m "feat(voice): add voice IPC handlers and preload API"
```

---

### Task 10: Service Registration in main.ts

**Files:**
- Modify: `src/main.ts`

- [ ] **Step 1: Add VoiceService registration**

Add the following in `src/main.ts` after the LLM service registration block (after `appContext.registry.register(llmService)`):

```typescript
  // Register Voice service
  const { AudioManager } = await import('./services/voice/audio-manager.js');
  const { HotkeyManager } = await import('./services/voice/hotkey-manager.js');
  const { WhisperProvider } = await import('./services/voice/providers/whisper-provider.js');
  const { PiperProvider } = await import('./services/voice/providers/piper-provider.js');
  const { PorcupineProvider } = await import('./services/voice/providers/porcupine-provider.js');

  const resourcesPath = process.resourcesPath;
  const whisperProvider = new WhisperProvider(resourcesPath);
  const piperProvider = new PiperProvider(resourcesPath);
  const porcupineProvider = new PorcupineProvider(resourcesPath, 'YOUR_PICOVOICE_ACCESS_KEY');
  const audioManager = new AudioManager();
  const hotkeyManager = new HotkeyManager();

  const voiceService = new VoiceService(
    appContext,
    whisperProvider,
    piperProvider,
    porcupineProvider,
    audioManager,
    hotkeyManager,
  );
  appContext.registry.register(voiceService);
```

Note: The Picovoice access key should be loaded from config or environment variable. Replace `'YOUR_PICOVOICE_ACCESS_KEY'` with:

```typescript
  const picovoiceKey = process.env.PICOVOICE_ACCESS_KEY ?? '';
  const porcupineProvider = new PorcupineProvider(resourcesPath, picovoiceKey);
```

Move the existing `await appContext.registry.initAll()` call to AFTER the voice service registration so both LLM and Voice services are initialized together.

- [ ] **Step 2: Verify build**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/main.ts
git commit -m "feat(voice): register VoiceService in main process startup"
```

---

### Task 11: Config Extension & Settings UI Update

**Files:**
- Modify: `src/renderer/wizard/wizard.ts` (add pushToTalkKey to controls defaults)
- Modify: `src/renderer/dashboard/views/settings.ts` (add hotkey input)

- [ ] **Step 1: Add pushToTalkKey to wizard defaults**

In `src/renderer/wizard/wizard.ts`, update the `controls` default in the `WizardData` interface and defaults object:

In the interface, update the controls type:
```typescript
  controls: {
    voiceMode: 'keyword' | 'push-to-talk' | 'off';
    pushToTalkKey: string;
    quietModeDuration: number;
    customCommands: CustomCommand[];
  };
```

In the defaults object, add the new field:
```typescript
  controls: {
    voiceMode: 'off',
    pushToTalkKey: 'F9',
    quietModeDuration: 60,
    customCommands: [],
  },
```

- [ ] **Step 2: Add hotkey input to settings**

In `src/renderer/dashboard/views/settings.ts`, in the Steuerung section, add a hotkey input field after the voiceMode select. This field should appear only when push-to-talk is selected:

```typescript
    // Push-to-Talk hotkey (shown only when push-to-talk mode selected)
    const hotkeyRow = document.createElement('div');
    hotkeyRow.className = 'sarah-form-group';
    hotkeyRow.style.display = (controls.voiceMode === 'push-to-talk') ? '' : 'none';

    const hotkeyLabel = document.createElement('label');
    hotkeyLabel.textContent = 'Push-to-Talk Taste';
    hotkeyRow.appendChild(hotkeyLabel);

    const hotkeyInput = document.createElement('input');
    hotkeyInput.className = 'sarah-input';
    hotkeyInput.type = 'text';
    hotkeyInput.readOnly = true;
    hotkeyInput.value = controls.pushToTalkKey || 'F9';
    hotkeyInput.placeholder = 'Taste drücken...';
    hotkeyInput.style.cursor = 'pointer';
    hotkeyInput.addEventListener('keydown', (e: KeyboardEvent) => {
      e.preventDefault();
      const key = e.key === ' ' ? 'Space' : e.key;
      hotkeyInput.value = key;
      save('controls', { ...controls, pushToTalkKey: key });
      showSaved(hotkeyInput);
    });
    hotkeyRow.appendChild(hotkeyInput);
    section.appendChild(hotkeyRow);

    // Toggle hotkey row visibility when voiceMode changes
    voiceModeSelect.addEventListener('change', () => {
      hotkeyRow.style.display = voiceModeSelect.value === 'push-to-talk' ? '' : 'none';
    });
```

- [ ] **Step 3: Verify build**

Run: `npm run build`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/renderer/wizard/wizard.ts src/renderer/dashboard/views/settings.ts
git commit -m "feat(voice): add pushToTalkKey config and hotkey settings UI"
```

---

### Task 12: Run All Tests & Final Verification

**Files:** None (verification only)

- [ ] **Step 1: Run all unit tests**

Run: `npx vitest run`
Expected: All tests pass, including new voice tests

- [ ] **Step 2: Run TypeScript type check**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Run full build**

Run: `npm run build`
Expected: Build completes successfully

- [ ] **Step 4: Final commit if any fixes needed**

```bash
git add -A
git commit -m "fix(voice): address test and build issues"
```
