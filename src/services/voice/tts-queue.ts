// src/services/voice/tts-queue.ts

import type { TtsProvider } from './tts-provider.interface.js';

const TTS_SAMPLE_RATE = 22_050;

type QueueState = 'idle' | 'synthesizing' | 'playing' | 'prebuffering';

export class TtsQueue {
  private queue: string[] = [];
  private state: QueueState = 'idle';

  // Audio that has been synthesized and is ready to play after current playback
  private preBuffer: Float32Array | null = null;
  // The sentence that produced the preBuffer
  private preBufferSentence: string | null = null;

  constructor(
    private tts: TtsProvider,
    private onAudioReady: (audio: Float32Array, sampleRate: number) => void,
    private onQueueEmpty: () => void,
    private onError: (error: Error) => void,
  ) {}

  enqueue(sentence: string): void {
    this.queue.push(sentence);
    if (this.state === 'idle') {
      void this.processNext();
    }
  }

  playbackDone(): void {
    if (this.state !== 'playing' && this.state !== 'prebuffering') {
      // Defensive: ignore when not in a playing state
      return;
    }

    if (this.preBuffer !== null) {
      // Pre-buffered audio is ready — emit it immediately
      const audio = this.preBuffer;
      this.preBuffer = null;
      this.preBufferSentence = null;
      this.state = 'playing';
      this.onAudioReady(audio, TTS_SAMPLE_RATE);
      // Start pre-buffering the next item if available
      this.startPreBuffer();
    } else if (this.state === 'prebuffering') {
      // Pre-buffer synthesis is still in progress; transition to playing so that
      // when it finishes the audio is emitted immediately
      this.state = 'playing';
    } else {
      // Nothing pre-buffered and no synthesis in progress
      if (this.queue.length > 0) {
        void this.processNext();
      } else {
        this.state = 'idle';
        this.onQueueEmpty();
      }
    }
  }

  stop(): void {
    this.tts.stop();
    this.queue = [];
    this.preBuffer = null;
    this.preBufferSentence = null;
    this.state = 'idle';
  }

  get isActive(): boolean {
    return this.state !== 'idle';
  }

  get pendingCount(): number {
    return this.queue.length;
  }

  // ── Private ──────────────────────────────────────────────────────────────────

  private async processNext(): Promise<void> {
    const sentence = this.queue.shift();
    if (sentence === undefined) {
      this.state = 'idle';
      this.onQueueEmpty();
      return;
    }

    this.state = 'synthesizing';
    let audio: Float32Array;
    try {
      audio = await this.tts.speak(sentence);
    } catch (err) {
      this.onError(err instanceof Error ? err : new Error(String(err)));
      // Attempt to continue with remaining queue items
      if (this.queue.length > 0) {
        void this.processNext();
      } else {
        this.state = 'idle';
        this.onQueueEmpty();
      }
      return;
    }

    // Emit the audio and move to playing state, then kick off pre-buffer
    this.state = 'playing';
    this.onAudioReady(audio, TTS_SAMPLE_RATE);
    this.startPreBuffer();
  }

  /**
   * If there is a sentence waiting, synthesize it in the background so it is
   * ready by the time playback of the current sentence finishes.
   */
  private startPreBuffer(): void {
    if (this.queue.length === 0) return;

    const sentence = this.queue.shift()!;
    this.preBufferSentence = sentence;
    this.state = 'prebuffering';

    void (async () => {
      let audio: Float32Array;
      try {
        audio = await this.tts.speak(sentence);
      } catch (err) {
        this.onError(err instanceof Error ? err : new Error(String(err)));
        this.preBuffer = null;
        this.preBufferSentence = null;

        // If playback already finished while we were synthesizing, continue
        if (this.state === 'playing') {
          if (this.queue.length > 0) {
            void this.processNext();
          } else {
            this.state = 'idle';
            this.onQueueEmpty();
          }
        } else {
          // Still in prebuffering — playbackDone hasn't arrived yet; transition
          // to playing so playbackDone can clean up properly
          this.state = 'playing';
        }
        return;
      }

      if (this.state === 'prebuffering') {
        // Playback is still ongoing — store the result
        this.preBuffer = audio;
      } else if (this.state === 'playing') {
        // playbackDone arrived while we were synthesizing — emit immediately
        this.preBuffer = null;
        this.preBufferSentence = null;
        this.state = 'playing';
        this.onAudioReady(audio, TTS_SAMPLE_RATE);
        this.startPreBuffer();
      }
      // If state is 'idle' (stop() was called), discard the result silently
    })();
  }
}
