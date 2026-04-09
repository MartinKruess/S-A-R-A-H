# Voice Service — Design Spec

## Goal

Add offline voice interaction to Sarah: Speech-to-Text (STT), Text-to-Speech (TTS), and Wake-Word recognition. Sarah can be spoken to and speaks back — fully offline, no cloud APIs.

## Architecture

The Voice Service follows the existing Provider pattern (like LLM Service). A single `VoiceService` implements `SarahService` and orchestrates three providers via interfaces: `SttProvider`, `TtsProvider`, `WakeWordProvider`. An `AudioManager` handles microphone access and audio output. All voice logic runs in the Main Process.

## Voice Modes

Two modes, configured in `controls.voiceMode`:

- **off** — No microphone access, no voice features
- **push-to-talk** — Global hotkey (default: F9, configurable via F1-F12). Hold to speak, release to process.

> **Note:** Keyword/Wake-Word mode (`keyword`) was planned but is currently non-functional. The VoiceService treats `keyword` config values as `off`. The Settings UI only offers `off` and `push-to-talk`.

## State Machine

```
idle → listening → processing → speaking → idle
         ↑                         │
         └─── (interruption) ──────┘
```

- **idle**: No microphone active (voiceMode=off) OR wake-word listener waiting passively (voiceMode=keyword)
- **listening**: Microphone active, user is speaking. Ends by: key release (PTT), 2s silence (keyword), or abort phrase
- **processing**: Audio → Whisper → text → LLM. Sarah is "thinking"
- **speaking**: Piper speaks the response. Interruptible → back to listening

### Interruption

When the user starts speaking (F9 press or wake-word detected) while Sarah is speaking:
1. `ttsProvider.stop()` — audio stops immediately
2. `voice:interrupted` emitted on bus
3. New listening session starts

## Conversation Window (Keyword Mode Only)

After wake-word detection, a conversation window opens. During this window, the user can speak directly without repeating the wake-word.

```
Wake-word detected
  → conversationActive = true
  → start 60s timer

User speaks → Sarah answers
  → reset 60s timer

Abort phrase detected
  → conversationActive = false
  → timer cleared
  → immediately back to wake-word listening

Timer expires (60s without input)
  → conversationActive = false
  → back to wake-word listening
```

### End-of-Speech Detection

- **Push-to-Talk**: Key release ends speech
- **Keyword Mode**: 2s silence threshold (VAD amplitude-based, no separate model)

### Abort Phrases (Hardcoded)

Checked via lowercase string matching on Whisper transcripts:
- "sarah stop"
- "danke sarah"
- "sarah aus"
- "sarah du bist nicht gemeint"

When detected, conversation window closes immediately (no 60s wait).

## Provider Interfaces

### SttProvider

```typescript
interface SttProvider {
  init(): Promise<void>;
  transcribe(audio: Float32Array, sampleRate: number): Promise<string>;
  destroy(): Promise<void>;
}
```

**WhisperProvider**: Runs `whisper.cpp` as child process, communicates via stdin/stdout with PCM data. Model: `ggml-small.bin` (~460MB, good quality/speed tradeoff for German).

### TtsProvider

```typescript
interface TtsProvider {
  init(): Promise<void>;
  speak(text: string): Promise<Float32Array>;
  stop(): void;
  destroy(): Promise<void>;
}
```

**PiperProvider**: Runs `piper` as child process, receives text, returns WAV/PCM. Supports sentence-by-sentence streaming: while first sentence plays, next sentence is already generating.

### WakeWordProvider

```typescript
interface WakeWordProvider {
  init(): Promise<void>;
  start(onDetected: () => void): void;
  stop(): void;
  destroy(): Promise<void>;
}
```

**PorcupineProvider**: Uses `@picovoice/porcupine-node` with custom wake-word models for "Sarah", "Hey Sarah", "Hi Sarah", "Ok Sarah".

### TTS Roadmap

- **Phase 1 (now):** Piper — fast, good German voices, small models
- **Phase 2 (future):** Coqui TTS — more personality, custom voice training
- **Phase 3 (future):** ElevenLabs-alternative for premium offline voices

Provider interfaces ensure swapping is a single-file change.

## Audio Architecture

Audio capture runs in the **Renderer Process** via Web Audio API:

1. **AudioWorklet** (`audio-worklet-processor.ts`) — Captures PCM samples in 2048-sample buffers
2. **AudioBridge** (`audio-bridge.ts`) — Manages mic capture and TTS playback in the renderer
   - Capture: `getUserMedia` → `AudioWorkletNode` → IPC → Main Process
   - Playback: Main Process → IPC → `AudioBufferSourceNode` → speakers
   - Separate AudioContexts: capture at 16kHz (STT), playback at 22050Hz (TTS)
   - Cleanup: `beforeunload` handler calls `destroy()`, closing both AudioContexts
3. **AudioManager** (`audio-manager.ts`) — Collects chunks in Main Process, returns combined buffer on stop

### Audio Pipeline (Capture)

```
Renderer: getUserMedia → AudioWorklet → AudioBridge → IPC (voice-audio-chunk)
Main:     IPC handler → VoiceService.feedAudioChunk → AudioManager.feedChunk
```

### Audio Pipeline (Playback)

```
Main:     VoiceService → voice:play-audio event → IPC → Renderer
Renderer: AudioBridge → AudioBufferSourceNode → speakers → voice:playback-done → IPC → Main
```

## LLM & Chat Integration

### Voice → LLM Flow

1. VoiceService receives transcript from SttProvider
2. Checks for abort phrases → if match, end conversation
3. If chat mode active: emits `voice:transcript` for Chat-UI display
4. Emits `chat:message` on bus → LLM Service handles it identically to typed input
5. VoiceService subscribes to `llm:done` / `llm:chunk` for TTS output

### Response Output by Mode

- **Voice mode (no chat open):** `llm:done` → full text to TTS → speech output. No text in UI.
- **Chat mode active:** `llm:chunk` → text appears in chat as before. Additionally `llm:done` → full text to TTS → speech output.

### Persistence

All messages go to the database regardless of mode. The LLM Service already persists every message in the `messages` table via `chat:message` handler. Voice input is treated identically to typed input — no special handling needed.

### Streaming TTS (Chat Mode)

Piper receives the response sentence by sentence. While the first sentence is being spoken, the next is already generating. This makes responses feel fast.

## Interaction Mode

A synchronized `interactionMode` ('chat' | 'voice') prevents TTS from firing during text chat:

- Default: `'voice'`
- Dashboard sends mode change via IPC when chat mode is toggled
- VoiceService suppresses TTS when `interactionMode === 'chat'`
- IPC channel: `voice-set-interaction-mode`

## Global Hotkey (Push-to-Talk)

- Uses `uiohook-napi` for real keydown/keyup detection (Electron's `globalShortcut` cannot detect keyup)
- Default: `F9`, configurable in settings (F1-F12 only)
- KeyDown → start listening
- KeyUp → stop listening, trigger transcription
- Settings UI: key input field restricted to F1-F12 function keys

## Config Extension

```typescript
controls: {
  voiceMode: 'push-to-talk' | 'off';    // keyword treated as off
  pushToTalkKey: string;                  // default: 'F9', restricted to F1-F12
  quietModeDuration: number;
  customCommands: CustomCommand[];
}
```

Settings changes are applied live — `save-config` triggers `VoiceService.applyConfig()` automatically.

## Preload API (IPC Channels)

```typescript
sarah.voice: {
  getState(): Promise<string>;
  onStateChange(cb: (data: { state: string }) => void): () => void;
  onTranscript(cb: (data: { text: string }) => void): () => void;
  onPlayAudio(cb: (data: { audio: number[]; sampleRate: number }) => void): () => void;
  playbackDone(): Promise<void>;
  onError(cb: (data: { message: string }) => void): () => void;
  sendAudioChunk(chunk: number[]): Promise<void>;
  setInteractionMode(mode: string): Promise<void>;
  configChanged(): Promise<void>;
}
```

## Message Bus Topics

- `voice:wake` — Wake-word detected
- `voice:listening` — Microphone active
- `voice:transcript` — Finished text from STT (for Chat-UI display)
- `voice:speaking` — TTS started
- `voice:done` — TTS finished
- `voice:error` — Error occurred
- `voice:interrupted` — User interrupted Sarah
- `voice:state` — State machine change (idle, listening, processing, speaking)
- `voice:play-audio` — Audio buffer ready for playback in renderer
- `voice:playback-done` — Renderer finished playing audio

## Binary Distribution

All binaries ship with the installer via Electron-Builder `extraResources`. No separate download, no auto-update for models.

```
resources/
├── whisper/
│   ├── whisper.exe              (~2MB)
│   └── models/
│       └── ggml-small.bin       (~460MB)
├── piper/
│   ├── piper.exe                (~5MB)
│   └── voices/
│       └── de_DE-thorsten-medium.onnx  (~60MB)
└── porcupine/
    └── sarah_ww.ppn             (~1MB)
```

Total additional size: ~530MB. Platform: Windows (win64) only for now.

## File Structure

```
src/services/voice/
├── voice-service.ts            — VoiceService (SarahService, state machine)
├── audio-manager.ts            — Microphone & speaker access
├── stt-provider.interface.ts   — SttProvider interface
├── tts-provider.interface.ts   — TtsProvider interface
├── wake-word-provider.interface.ts — WakeWordProvider interface
└── providers/
    ├── whisper-provider.ts     — WhisperProvider (child process)
    ├── piper-provider.ts       — PiperProvider (child process)
    └── porcupine-provider.ts   — PorcupineProvider
```

## Future Considerations (Not In Scope)

- macOS / Linux support (provider interfaces make this easy)
- Coqui TTS / premium voice provider swap (Phase 2/3)
- Voice activity visualization on the orb
- Configurable silence threshold (currently fixed at 2s)
- Configurable conversation window duration (currently fixed at 60s)
- Source field in messages table (`voice` vs `text`) for filtering
