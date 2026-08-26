import { randomUUID } from 'crypto';
import type { OutputId, PlaybackId, TurnId } from '../../core/turn-contract.js';
import type { TtsProvider } from './tts-provider.interface.js';

const TTS_SAMPLE_RATE = 22_050;
const PLAYBACK_ACK_GRACE_MS = 5_000;
const PLAYBACK_ACK_MAX_MS = 120_000;

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
  private activePlayback: {
    item: TtsQueueItem;
    playbackId: PlaybackId;
  } | null = null;
  private playbackAckTimer: ReturnType<typeof setTimeout> | null = null;
  private activeSynthesis: TtsQueueItem | null = null;
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
    private onError: (error: Error, item: TtsQueueItem) => void,
    private onTiming?: (ms: number, turnId: TurnId) => void,
    private onPlaybackProgress?: (turnId: TurnId) => void,
    private onPlaybackCancel?: (turnId: TurnId, playbackId: PlaybackId) => void,
  ) {}

  enqueue(item: TtsQueueItem): void {
    this.queue.push(item);
    if (this.state === 'idle') void this.processNext();
  }

  playbackDone(turnId: TurnId, playbackId: PlaybackId): void {
    if (
      !this.activePlayback
      || this.activePlayback.item.turnId !== turnId
      || this.activePlayback.playbackId !== playbackId
    ) return;
    this.finishPlayback();
  }

  playbackFailed(turnId: TurnId, playbackId: PlaybackId, error: Error): void {
    if (
      !this.activePlayback
      || this.activePlayback.item.turnId !== turnId
      || this.activePlayback.playbackId !== playbackId
    ) return;
    this.onError(error, this.activePlayback.item);
    this.finishPlayback();
  }

  private finishPlayback(): void {
    if (!this.activePlayback) return;
    const completedTurnId = this.activePlayback.item.turnId;
    this.clearPlaybackAckTimer();
    this.activePlayback = null;
    this.onPlaybackProgress?.(completedTurnId);

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
    this.clearPlaybackAckTimer();
    if (this.activePlayback) {
      this.onPlaybackCancel?.(
        this.activePlayback.item.turnId,
        this.activePlayback.playbackId,
      );
    }
    this.activePlayback = null;
    this.activeSynthesis = null;
    this.state = 'idle';
  }

  cancelTurn(turnId: TurnId): void {
    this.queue = this.queue.filter((item) => item.turnId !== turnId);
    if (this.preBuffer?.item.turnId === turnId) {
      this.preBuffer = null;
      if (this.activePlayback) this.state = 'playing';
    }
    if (this.activePlayback?.item.turnId === turnId) {
      this.onPlaybackCancel?.(turnId, this.activePlayback.playbackId);
      if (this.activeSynthesis?.turnId === turnId) {
        this.generation += 1;
        this.synthesisAbort.abort();
        this.synthesisAbort = new AbortController();
        this.activeSynthesis = null;
        this.state = 'playing';
      }
      // Complete only the canceled playback. A global stop would also drop
      // already queued or pre-buffered speech owned by a different turn.
      this.finishPlayback();
      return;
    }
    if (this.activeSynthesis?.turnId !== turnId) return;

    this.generation += 1;
    this.synthesisAbort.abort();
    this.synthesisAbort = new AbortController();
    this.activeSynthesis = null;
    if (this.activePlayback) {
      this.state = 'playing';
    } else if (this.queue.length > 0) {
      this.state = 'idle';
      void this.processNext();
    } else {
      this.state = 'idle';
      this.onQueueEmpty();
    }
  }

  get isActive(): boolean {
    return this.state !== 'idle';
  }

  get pendingCount(): number {
    return this.queue.length;
  }

  hasTurn(turnId: TurnId): boolean {
    return this.activePlayback?.item.turnId === turnId
      || this.activeSynthesis?.turnId === turnId
      || this.preBuffer?.item.turnId === turnId
      || this.queue.some((item) => item.turnId === turnId);
  }

  private async processNext(): Promise<void> {
    const item = this.queue.shift();
    if (!item) {
      this.state = 'idle';
      this.onQueueEmpty();
      return;
    }

    const generation = this.generation;
    this.activeSynthesis = item;
    this.state = 'synthesizing';
    try {
      const startedAt = performance.now();
      const audio = await this.tts.speak(item.text, this.synthesisAbort.signal);
      if (generation !== this.generation) return;
      this.activeSynthesis = null;
      this.onTiming?.(Math.round(performance.now() - startedAt), item.turnId);
      this.state = 'playing';
      this.emitAudio(item, audio);
      this.startPreBuffer();
    } catch (value) {
      if (generation !== this.generation || this.synthesisAbort.signal.aborted) return;
      this.activeSynthesis = null;
      this.onError(value instanceof Error ? value : new Error(String(value)), item);
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
    this.activeSynthesis = item;
    this.state = 'prebuffering';

    void this.tts.speak(item.text, this.synthesisAbort.signal).then((audio) => {
      if (generation !== this.generation) return;
      this.activeSynthesis = null;
      if (this.state === 'prebuffering') {
        this.preBuffer = { item, audio };
      } else if (this.state === 'playing') {
        this.emitAudio(item, audio);
        this.startPreBuffer();
      }
    }, (value) => {
      if (generation !== this.generation || this.synthesisAbort.signal.aborted) return;
      this.activeSynthesis = null;
      this.onError(value instanceof Error ? value : new Error(String(value)), item);
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
    this.activePlayback = { item, playbackId };
    this.clearPlaybackAckTimer();
    const audioDurationMs = Math.ceil((audio.length / TTS_SAMPLE_RATE) * 1_000);
    const timeoutMs = Math.min(
      PLAYBACK_ACK_MAX_MS,
      Math.max(PLAYBACK_ACK_GRACE_MS, audioDurationMs + PLAYBACK_ACK_GRACE_MS),
    );
    this.playbackAckTimer = setTimeout(() => {
      if (this.activePlayback?.playbackId !== playbackId) return;
      this.onError(new Error('Audio playback acknowledgement timed out'), item);
      this.onPlaybackCancel?.(item.turnId, playbackId);
      this.finishPlayback();
    }, timeoutMs);
    this.onAudioReady(item, playbackId, audio, TTS_SAMPLE_RATE);
  }

  private clearPlaybackAckTimer(): void {
    if (!this.playbackAckTimer) return;
    clearTimeout(this.playbackAckTimer);
    this.playbackAckTimer = null;
  }
}
