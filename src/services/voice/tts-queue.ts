import { randomUUID } from 'crypto';
import type { OutputId, PlaybackId, TurnId } from '../../core/turn-contract.js';
import type { TtsProvider } from './tts-provider.interface.js';

const TTS_SAMPLE_RATE = 22_050;

type QueueState = 'idle' | 'synthesizing' | 'playing' | 'prebuffering';

export interface TtsQueueItem {
  turnId: TurnId;
  outputId: OutputId;
  text: string;
}

interface BufferedAudio {
  item: TtsQueueItem;
  audio: Float32Array;
}

export class TtsQueue {
  private queue: TtsQueueItem[] = [];
  private state: QueueState = 'idle';
  private preBuffer: BufferedAudio | null = null;
  private activePlayback: { turnId: TurnId; playbackId: PlaybackId } | null = null;
  private generation = 0;
  private synthesisAbort = new AbortController();

  constructor(
    private tts: TtsProvider,
    private onAudioReady: (
      item: TtsQueueItem,
      playbackId: PlaybackId,
      audio: Float32Array,
      sampleRate: number,
    ) => void,
    private onQueueEmpty: () => void,
    private onError: (error: Error) => void,
    private onTiming?: (ms: number, turnId: TurnId) => void,
  ) {}

  enqueue(item: TtsQueueItem): void {
    this.queue.push(item);
    if (this.state === 'idle') void this.processNext();
  }

  playbackDone(turnId?: TurnId, playbackId?: PlaybackId): void {
    const resolvedTurnId = turnId ?? this.activePlayback?.turnId;
    const resolvedPlaybackId = playbackId ?? this.activePlayback?.playbackId;
    if (
      !this.activePlayback
      || this.activePlayback.turnId !== resolvedTurnId
      || this.activePlayback.playbackId !== resolvedPlaybackId
    ) return;
    this.activePlayback = null;

    if (this.preBuffer) {
      const buffered = this.preBuffer;
      this.preBuffer = null;
      this.state = 'playing';
      this.emitAudio(buffered.item, buffered.audio);
      this.startPreBuffer();
    } else if (this.state === 'prebuffering') {
      this.state = 'playing';
    } else if (this.queue.length > 0) {
      void this.processNext();
    } else {
      this.state = 'idle';
      this.onQueueEmpty();
    }
  }

  stop(): void {
    this.generation += 1;
    this.synthesisAbort.abort();
    this.synthesisAbort = new AbortController();
    this.tts.stop();
    this.queue = [];
    this.preBuffer = null;
    this.activePlayback = null;
    this.state = 'idle';
  }

  get isActive(): boolean {
    return this.state !== 'idle';
  }

  get pendingCount(): number {
    return this.queue.length;
  }

  private async processNext(): Promise<void> {
    const item = this.queue.shift();
    if (!item) {
      this.state = 'idle';
      this.onQueueEmpty();
      return;
    }

    const generation = this.generation;
    this.state = 'synthesizing';
    try {
      const startedAt = performance.now();
      const audio = await this.tts.speak(item.text, this.synthesisAbort.signal);
      if (generation !== this.generation) return;
      this.onTiming?.(Math.round(performance.now() - startedAt), item.turnId);
      this.state = 'playing';
      this.emitAudio(item, audio);
      this.startPreBuffer();
    } catch (value) {
      if (generation !== this.generation || this.synthesisAbort.signal.aborted) return;
      this.onError(value instanceof Error ? value : new Error(String(value)));
      if (this.queue.length > 0) void this.processNext();
      else {
        this.state = 'idle';
        this.onQueueEmpty();
      }
    }
  }

  private startPreBuffer(): void {
    const item = this.queue.shift();
    if (!item) return;
    const generation = this.generation;
    this.state = 'prebuffering';

    void this.tts.speak(item.text, this.synthesisAbort.signal).then((audio) => {
      if (generation !== this.generation) return;
      if (this.state === 'prebuffering') {
        this.preBuffer = { item, audio };
      } else if (this.state === 'playing') {
        this.emitAudio(item, audio);
        this.startPreBuffer();
      }
    }, (value) => {
      if (generation !== this.generation || this.synthesisAbort.signal.aborted) return;
      this.onError(value instanceof Error ? value : new Error(String(value)));
      if (this.state === 'playing') {
        if (this.queue.length > 0) void this.processNext();
        else {
          this.state = 'idle';
          this.onQueueEmpty();
        }
      } else {
        this.state = 'playing';
      }
    });
  }

  private emitAudio(item: TtsQueueItem, audio: Float32Array): void {
    const playbackId = randomUUID();
    this.activePlayback = { turnId: item.turnId, playbackId };
    this.onAudioReady(item, playbackId, audio, TTS_SAMPLE_RATE);
  }
}
