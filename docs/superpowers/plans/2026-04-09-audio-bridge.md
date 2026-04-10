# Audio Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable end-to-end voice I/O — microphone capture from renderer to main process, and TTS playback from main process to renderer speakers.

**Architecture:** A single `AudioBridge` class in the renderer manages both capture (mic → AudioWorklet → IPC chunks) and playback (IPC audio data → AudioBuffer → speakers). It reacts to voice state changes from the main process and self-manages its lifecycle. An `AudioWorkletProcessor` runs in the audio thread to collect samples efficiently.

**Tech Stack:** Web Audio API, AudioWorklet, navigator.mediaDevices.getUserMedia, Electron IPC (via existing `sarah.voice.*` preload API)

---

### Task 1: AudioWorklet Processor

**Files:**
- Create: `src/renderer/services/audio-worklet-processor.ts`

This file will be compiled to JS and loaded by `AudioContext.audioWorklet.addModule()`. It collects PCM samples in a buffer and posts them to the main thread every ~2048 samples (~128ms at 16kHz).

- [ ] **Step 1: Create the AudioWorkletProcessor**

```typescript
// src/renderer/services/audio-worklet-processor.ts

/**
 * Collects audio samples and posts Float32Array chunks to the main thread.
 * Runs in the AudioWorklet thread — no DOM access.
 */
const BUFFER_SIZE = 2048;

class CaptureProcessor extends AudioWorkletProcessor {
  private buffer: Float32Array = new Float32Array(BUFFER_SIZE);
  private writeIndex = 0;

  process(inputs: Float32Array[][]): boolean {
    const input = inputs[0]?.[0]; // mono channel 0
    if (!input) return true;

    for (let i = 0; i < input.length; i++) {
      this.buffer[this.writeIndex++] = input[i];
      if (this.writeIndex >= BUFFER_SIZE) {
        this.port.postMessage({ samples: this.buffer.slice() });
        this.writeIndex = 0;
      }
    }
    return true;
  }
}

registerProcessor('capture-processor', CaptureProcessor);
```

- [ ] **Step 2: Verify TypeScript compiles this file**

Run: `npx tsc -p tsconfig.renderer.json --noEmit`
Expected: No errors (file is in `src/renderer/` which is included in the renderer tsconfig)

- [ ] **Step 3: Commit**

```bash
git add src/renderer/services/audio-worklet-processor.ts
git commit -m "feat(voice): add AudioWorklet capture processor"
```

---

### Task 2: AudioBridge — Capture (Mic → Main)

**Files:**
- Create: `src/renderer/services/audio-bridge.ts`

The AudioBridge class manages the AudioContext, getUserMedia stream, and AudioWorklet node. When voice state changes to `listening`, it starts capture. When state leaves `listening`, it stops.

- [ ] **Step 1: Create AudioBridge with capture logic**

```typescript
// src/renderer/services/audio-bridge.ts

declare const sarah: {
  voice: {
    getState: () => Promise<string>;
    onStateChange: (cb: (data: { state: string }) => void) => () => void;
    onPlayAudio: (cb: (data: { audio: number[]; sampleRate: number }) => void) => () => void;
    playbackDone: () => Promise<void>;
    onError: (cb: (data: { message: string }) => void) => () => void;
    sendAudioChunk: (chunk: number[]) => Promise<void>;
  };
};

const CAPTURE_SAMPLE_RATE = 16_000;

export class AudioBridge {
  private captureCtx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private capturing = false;

  private unsubState: (() => void) | null = null;
  private unsubPlayAudio: (() => void) | null = null;

  async start(): Promise<void> {
    this.unsubState = sarah.voice.onStateChange(({ state }) => {
      this.handleStateChange(state);
    });

    this.unsubPlayAudio = sarah.voice.onPlayAudio(({ audio, sampleRate }) => {
      this.playAudio(audio, sampleRate);
    });

    // Check initial state
    const initialState = await sarah.voice.getState();
    this.handleStateChange(initialState);
  }

  destroy(): void {
    this.stopCapture();
    this.unsubState?.();
    this.unsubPlayAudio?.();
    this.unsubState = null;
    this.unsubPlayAudio = null;
  }

  private handleStateChange(state: string): void {
    if (state === 'listening') {
      this.startCapture();
    } else if (this.capturing) {
      this.stopCapture();
    }
  }

  // ── Capture ──

  private async startCapture(): Promise<void> {
    if (this.capturing) return;
    this.capturing = true;

    try {
      // Create AudioContext at 16kHz (STT sample rate)
      if (!this.captureCtx) {
        this.captureCtx = new AudioContext({ sampleRate: CAPTURE_SAMPLE_RATE });
      }
      if (this.captureCtx.state === 'suspended') {
        await this.captureCtx.resume();
      }

      // Load worklet processor
      await this.captureCtx.audioWorklet.addModule(
        new URL('./audio-worklet-processor.js', import.meta.url).href
      );

      // Get mic stream
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          sampleRate: CAPTURE_SAMPLE_RATE,
        },
      });

      // Wire up: mic → worklet → IPC
      this.sourceNode = this.captureCtx.createMediaStreamSource(this.stream);
      this.workletNode = new AudioWorkletNode(this.captureCtx, 'capture-processor');

      this.workletNode.port.onmessage = (event: MessageEvent<{ samples: Float32Array }>) => {
        const samples = event.data.samples;
        sarah.voice.sendAudioChunk(Array.from(samples));
      };

      this.sourceNode.connect(this.workletNode);
      // Worklet doesn't produce output, but must be connected to keep processing alive
      this.workletNode.connect(this.captureCtx.destination);
    } catch (err) {
      console.error('[AudioBridge] Capture failed:', err);
      this.capturing = false;
    }
  }

  private stopCapture(): void {
    if (!this.capturing) return;
    this.capturing = false;

    // Disconnect audio nodes
    this.workletNode?.disconnect();
    this.sourceNode?.disconnect();
    this.workletNode = null;
    this.sourceNode = null;

    // Stop mic stream tracks
    if (this.stream) {
      for (const track of this.stream.getTracks()) {
        track.stop();
      }
      this.stream = null;
    }
  }

  // ── Playback (placeholder — implemented in Task 3) ──

  private async playAudio(_audio: number[], _sampleRate: number): Promise<void> {
    // Will be implemented in Task 3
  }
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc -p tsconfig.renderer.json --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/renderer/services/audio-bridge.ts
git commit -m "feat(voice): add AudioBridge with mic capture via AudioWorklet"
```

---

### Task 3: AudioBridge — Playback (Main → Speaker)

**Files:**
- Modify: `src/renderer/services/audio-bridge.ts`

Add TTS playback: receive `number[]` PCM + sampleRate from main process, build an AudioBuffer, play it, and signal `playbackDone` when finished.

- [ ] **Step 1: Add playback AudioContext and implement playAudio**

Replace the placeholder `playAudio` method and add a playback context. The playback context uses a separate `AudioContext` because playback runs at 22050 Hz (Piper TTS output rate), while capture runs at 16000 Hz.

In `src/renderer/services/audio-bridge.ts`, add a `playbackCtx` field and a `currentPlaybackSource` field:

```typescript
// Add to class fields (after sourceNode line):
private playbackCtx: AudioContext | null = null;
private currentPlaybackSource: AudioBufferSourceNode | null = null;
```

Replace the placeholder `playAudio` method with:

```typescript
  private async playAudio(audio: number[], sampleRate: number): Promise<void> {
    try {
      if (!this.playbackCtx) {
        this.playbackCtx = new AudioContext({ sampleRate });
      }
      if (this.playbackCtx.state === 'suspended') {
        await this.playbackCtx.resume();
      }

      const buffer = this.playbackCtx.createBuffer(1, audio.length, sampleRate);
      buffer.getChannelData(0).set(audio);

      const source = this.playbackCtx.createBufferSource();
      source.buffer = buffer;
      source.connect(this.playbackCtx.destination);

      this.currentPlaybackSource = source;

      source.onended = () => {
        this.currentPlaybackSource = null;
        sarah.voice.playbackDone();
      };

      source.start();
    } catch (err) {
      console.error('[AudioBridge] Playback failed:', err);
      sarah.voice.playbackDone();
    }
  }
```

- [ ] **Step 2: Add stopPlayback method for interruption support**

Add a method to stop current playback (e.g., when user interrupts with PTT):

```typescript
  private stopPlayback(): void {
    if (this.currentPlaybackSource) {
      try {
        this.currentPlaybackSource.stop();
      } catch {
        // Already stopped
      }
      this.currentPlaybackSource = null;
    }
  }
```

Update `handleStateChange` to stop playback when state changes to `listening` (interrupt scenario):

```typescript
  private handleStateChange(state: string): void {
    if (state === 'listening') {
      this.stopPlayback();
      this.startCapture();
    } else if (this.capturing) {
      this.stopCapture();
    }
  }
```

Update `destroy` to stop playback:

```typescript
  destroy(): void {
    this.stopCapture();
    this.stopPlayback();
    this.unsubState?.();
    this.unsubPlayAudio?.();
    this.unsubState = null;
    this.unsubPlayAudio = null;
  }
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `npx tsc -p tsconfig.renderer.json --noEmit`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/renderer/services/audio-bridge.ts
git commit -m "feat(voice): add TTS playback and interruption to AudioBridge"
```

---

### Task 4: Integrate AudioBridge into Dashboard

**Files:**
- Modify: `src/renderer/dashboard/dashboard.ts`

Initialize the AudioBridge when the dashboard loads. The bridge self-manages based on voice state events.

- [ ] **Step 1: Add voice type declarations to dashboard.ts**

Add voice API types to the existing `sarah` declare block in `src/renderer/dashboard/dashboard.ts`:

```typescript
// Add inside the existing `declare const sarah` block:
  voice: {
    getState: () => Promise<string>;
    onStateChange: (cb: (data: { state: string }) => void) => () => void;
    onPlayAudio: (cb: (data: { audio: number[]; sampleRate: number }) => void) => () => void;
    playbackDone: () => Promise<void>;
    onError: (cb: (data: { message: string }) => void) => () => void;
    sendAudioChunk: (chunk: number[]) => Promise<void>;
  };
```

- [ ] **Step 2: Import and initialize AudioBridge**

Add to the top of `src/renderer/dashboard/dashboard.ts`:

```typescript
import { AudioBridge } from '../services/audio-bridge.js';
```

Add at the bottom of the file:

```typescript
// ── Voice Audio Bridge ──
const audioBridge = new AudioBridge();
audioBridge.start().catch((err) => {
  console.error('[Dashboard] AudioBridge failed to start:', err);
});
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `npx tsc -p tsconfig.renderer.json --noEmit`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/renderer/dashboard/dashboard.ts
git commit -m "feat(voice): initialize AudioBridge in dashboard"
```

---

### Task 5: Fix IPC audio chunk routing in main process

**Files:**
- Modify: `src/main.ts` (lines 350-358)

The current `voice-audio-chunk` handler emits to the bus, but `VoiceService.startListening()` calls `audio.startRecording()` which expects `AudioManager.feedChunk()` to be called directly. The bus event `voice:audio-chunk` is never consumed. Fix: call `AudioManager.feedChunk()` directly.

- [ ] **Step 1: Update the IPC handler to feed AudioManager directly**

In `src/main.ts`, replace the `voice-audio-chunk` handler (lines 350-358):

```typescript
  ipcMain.handle('voice-audio-chunk', (_event, chunk: number[]) => {
    const voiceService = appContext?.registry.get('voice');
    if (voiceService && voiceService instanceof VoiceService) {
      const float32 = new Float32Array(chunk);
      (voiceService as any).audio.feedChunk(float32);
    }
  });
```

Note: Accessing `audio` via `(voiceService as any)` is needed because `audio` is private. A cleaner alternative is to add a public `feedAudioChunk` method to VoiceService.

- [ ] **Step 2: Add public feedAudioChunk method to VoiceService**

In `src/services/voice/voice-service.ts`, add a public method:

```typescript
  /** Feed an audio chunk from the renderer. Called by IPC handler. */
  feedAudioChunk(chunk: Float32Array): void {
    this.audio.feedChunk(chunk);
  }
```

- [ ] **Step 3: Update main.ts to use the public method**

```typescript
  ipcMain.handle('voice-audio-chunk', (_event, chunk: number[]) => {
    const voiceService = appContext?.registry.get('voice');
    if (voiceService && voiceService instanceof VoiceService) {
      voiceService.feedAudioChunk(new Float32Array(chunk));
    }
  });
```

- [ ] **Step 4: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add src/main.ts src/services/voice/voice-service.ts
git commit -m "fix(voice): route renderer audio chunks to AudioManager directly"
```

---

### Task 6: AudioWorklet URL resolution fix

**Files:**
- Modify: `src/renderer/services/audio-bridge.ts`

The `addModule(new URL('./audio-worklet-processor.js', import.meta.url).href)` pattern may not resolve correctly in Electron's file:// protocol depending on bundler setup. Since the project uses plain TypeScript compilation (`tsc` → `dist/renderer/`), the compiled JS files will be siblings. The URL needs to resolve relative to the running script.

- [ ] **Step 1: Verify the URL resolution works in Electron**

Check the build output structure:

Run: `npx tsc -p tsconfig.renderer.json && ls dist/renderer/services/`
Expected: `audio-bridge.js`, `audio-worklet-processor.js` both present

If `import.meta.url` doesn't work in Electron's renderer (some builds strip it), use a fallback:

Replace the `addModule` call in `startCapture`:

```typescript
      // Resolve worklet script path relative to this script
      const workletUrl = new URL('./audio-worklet-processor.js', import.meta.url).href;
      await this.captureCtx.audioWorklet.addModule(workletUrl);
```

If Electron strips `import.meta.url`, fallback to constructing the path from `location`:

```typescript
      // Worklet is compiled alongside this file in dist/renderer/services/
      const base = location.href.substring(0, location.href.lastIndexOf('/'));
      const workletUrl = `${base}/dist/renderer/services/audio-worklet-processor.js`;
      await this.captureCtx.audioWorklet.addModule(workletUrl);
```

- [ ] **Step 2: Test with `npm start` or equivalent**

Run: Start the Electron app, switch voice mode to push-to-talk, press the PTT key.
Expected: Console shows no errors about failing to load the worklet module.

- [ ] **Step 3: Commit if changes were needed**

```bash
git add src/renderer/services/audio-bridge.ts
git commit -m "fix(voice): ensure AudioWorklet module URL resolves in Electron"
```

---

### Task 7: End-to-End Manual Test

**Files:** None (testing only)

- [ ] **Step 1: Set voice mode to push-to-talk in Settings**

Open Settings → Steuerung → Voice Mode → "Push-to-Talk" → Key: F9

- [ ] **Step 2: Test capture path**

1. Press and hold F9
2. Speak something in German (e.g., "Hallo Sarah")
3. Release F9
4. Expected: Console logs show audio chunks being sent, then transcript appears in `voice:transcript` event

- [ ] **Step 3: Test playback path**

After step 2, the LLM should respond and TTS should generate audio:
1. Expected: Audio plays through speakers
2. Expected: After playback finishes, `voice:playback-done` fires and state returns to `idle`

- [ ] **Step 4: Test interruption**

1. Press F9 while TTS is playing
2. Expected: Playback stops, capture starts immediately

- [ ] **Step 5: Check for echo issues**

Verify that `echoCancellation: true` in getUserMedia prevents feedback loop where TTS output gets captured by the mic.

- [ ] **Step 6: Note any issues for follow-up**

Document anything that needs fixing (audio quality, latency, echo) for next iteration.
