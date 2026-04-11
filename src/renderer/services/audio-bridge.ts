// src/renderer/services/audio-bridge.ts

import type { SarahApi } from '../../core/sarah-api.js';

declare const sarah: SarahApi;

const CAPTURE_SAMPLE_RATE = 16_000;

export class AudioBridge {
  private captureCtx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private capturing = false;
  private workletLoaded = false;

  private playbackCtx: AudioContext | null = null;
  private currentPlaybackSource: AudioBufferSourceNode | null = null;

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

  async destroy(): Promise<void> {
    this.stopCapture();
    this.stopPlayback();
    this.unsubState?.();
    this.unsubPlayAudio?.();
    this.unsubState = null;
    this.unsubPlayAudio = null;

    if (this.captureCtx) {
      await this.captureCtx.close();
      this.captureCtx = null;
      this.workletLoaded = false;
    }
    if (this.playbackCtx) {
      await this.playbackCtx.close();
      this.playbackCtx = null;
    }
  }

  private handleStateChange(state: string): void {
    if (state === 'listening') {
      this.stopPlayback();
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

      // Load worklet processor (only once)
      if (!this.workletLoaded) {
        await this.captureCtx.audioWorklet.addModule(
          new URL('./audio-worklet-processor.js', import.meta.url).href
        );
        this.workletLoaded = true;
      }

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
      this.workletNode.connect(this.captureCtx.destination);
    } catch (err) {
      console.error('[AudioBridge] Capture failed:', err);
      this.capturing = false;
    }
  }

  private stopCapture(): void {
    if (!this.capturing) return;
    this.capturing = false;

    this.workletNode?.disconnect();
    this.sourceNode?.disconnect();
    this.workletNode = null;
    this.sourceNode = null;

    if (this.stream) {
      for (const track of this.stream.getTracks()) {
        track.stop();
      }
      this.stream = null;
    }
  }

  // ── Playback ──

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
}
