import type { AudioConfig } from '../../core/config-schema.js';
import type { SarahApi } from '../../core/sarah-api.js';
import type { PlaybackId, TurnId, VoiceCaptureId } from '../../core/turn-contract.js';
import { normalizeVoiceMode } from '../../services/voice/voice-types.js';
import { AudioCaptureController } from './audio-capture-controller.js';
import { AudioPlaybackController } from './audio-playback-controller.js';

declare const sarah: SarahApi;

export class AudioBridge {
  private readonly playback = new AudioPlaybackController();
  private readonly capture = new AudioCaptureController(
    () => this.playback.stopPlayback(),
    (devices) => this.playback.handleDevicesChanged(devices),
  );
  private unsubState: (() => void) | null = null;
  private unsubCaptureFlush: (() => void) | null = null;
  private unsubPlayAudio: (() => void) | null = null;
  private unsubStopPlayback: (() => void) | null = null;
  private unsubAudioConfig: (() => void) | null = null;
  private unsubVoiceInputConfig: (() => void) | null = null;
  private unsubCapability: (() => void) | null = null;
  private started = false;
  private destroyed = false;
  private audioConfigRevision = 0;
  private voiceInputConfigRevision = 0;
  private capabilityRevision = 0;
  private voiceStateRevision = 0;
  private pendingVoiceState: { state: string; captureId?: VoiceCaptureId } | null = null;
  private applyPromise: Promise<void> = Promise.resolve();

  async start(): Promise<void> {
    this.unsubState = sarah.voice.onStateChange(({ state, captureId }) => {
      this.voiceStateRevision += 1;
      if (!this.started) {
        this.pendingVoiceState = { state, ...(captureId ? { captureId } : {}) };
        return;
      }
      this.capture.handleStateChange(state, captureId);
    });
    this.unsubCaptureFlush = sarah.voice.onCaptureFlushRequest(({ captureId }) => {
      this.capture.handleCaptureFlushRequest(captureId);
    });
    this.unsubPlayAudio = sarah.voice.onPlayAudio(({ turnId, playbackId, audio, sampleRate }) => {
      this.playback.enqueue(turnId, playbackId, audio, sampleRate);
    });
    this.unsubStopPlayback = sarah.voice.onStopPlayback(({ turnId, playbackId }) => {
      this.playback.stopPlayback(turnId, playbackId);
    });
    this.capture.subscribeDeviceChanges();
    this.unsubAudioConfig = sarah.onAudioConfigChanged((audio) => {
      this.audioConfigRevision += 1;
      if (!this.started) {
        this.rememberAudioConfig(audio);
        return;
      }
      void this.applyAudioConfig(audio);
    });
    this.unsubVoiceInputConfig = sarah.onVoiceInputConfigChanged(({ voiceMode }) => {
      this.voiceInputConfigRevision += 1;
      void this.capture.setVoiceMode(normalizeVoiceMode(voiceMode));
    });
    this.unsubCapability = sarah.voice.onCapability(({ stt }) => {
      this.capabilityRevision += 1;
      void this.capture.setSttAvailable(stt);
    });

    const audioRevision = this.audioConfigRevision;
    const voiceInputRevision = this.voiceInputConfigRevision;
    const capabilityRevision = this.capabilityRevision;
    const voiceStateRevision = this.voiceStateRevision;
    const [configResult, runtimeResult, stateResult] = await Promise.allSettled([
      sarah.getConfig(), sarah.getRuntimeStatus(), sarah.voice.getState(),
    ]);
    if (configResult.status === 'fulfilled') {
      if (this.audioConfigRevision === audioRevision) this.rememberAudioConfig(configResult.value.audio);
      if (this.voiceInputConfigRevision === voiceInputRevision) {
        await this.capture.setVoiceMode(normalizeVoiceMode(configResult.value.controls?.voiceMode ?? 'off'));
      }
    } else console.warn('[AudioBridge] initial config fetch failed:', configResult.reason);
    if (runtimeResult.status === 'fulfilled') {
      if (this.capabilityRevision === capabilityRevision) {
        await this.capture.setSttAvailable(runtimeResult.value.capabilities.stt?.state === 'ready');
      }
    } else console.warn('[AudioBridge] initial STT capability fetch failed:', runtimeResult.reason);

    const initialVoiceState = this.voiceStateRevision === voiceStateRevision
      && stateResult.status === 'fulfilled' ? stateResult.value : this.pendingVoiceState;
    const initialVoiceStateRevision = this.voiceStateRevision;
    if (stateResult.status === 'rejected') {
      console.warn('[AudioBridge] initial voice state fetch failed:', stateResult.reason);
    }
    this.started = true;
    await this.capture.start();
    if (initialVoiceState && this.voiceStateRevision === initialVoiceStateRevision) {
      this.capture.handleStateChange(initialVoiceState.state, initialVoiceState.captureId);
    }
  }

  async destroy(): Promise<void> {
    this.destroyed = true;
    const captureDestroy = this.capture.destroy();
    const playbackDestroy = this.playback.destroy();
    await this.applyPromise.catch(() => undefined);
    await Promise.allSettled([captureDestroy, playbackDestroy]);
    this.unsubState?.();
    this.unsubCaptureFlush?.();
    this.unsubPlayAudio?.();
    this.unsubStopPlayback?.();
    this.unsubAudioConfig?.();
    this.unsubVoiceInputConfig?.();
    this.unsubCapability?.();
    this.unsubState = null;
    this.unsubCaptureFlush = null;
    this.unsubPlayAudio = null;
    this.unsubStopPlayback = null;
    this.unsubAudioConfig = null;
    this.unsubVoiceInputConfig = null;
    this.unsubCapability = null;
  }

  applyAudioConfig(audio: AudioConfig): Promise<void> {
    this.applyPromise = this.applyPromise.then(
      () => this.applyAudioConfigSerial(audio),
      () => this.applyAudioConfigSerial(audio),
    );
    return this.applyPromise;
  }

  private async applyAudioConfigSerial(audio: AudioConfig): Promise<void> {
    if (this.destroyed || !this.started) {
      if (!this.started && !this.destroyed) {
        console.debug('[AudioBridge] audio-config arrived before start(), ignoring');
      }
      return;
    }
    this.playback.applyAudioConfig(audio);
    await this.capture.applyAudioConfig(audio);
  }

  private rememberAudioConfig(audio: AudioConfig): void {
    this.capture.rememberAudioConfig(audio);
    this.playback.rememberAudioConfig(audio);
  }

  private get captureCtx(): AudioContext | null { return this.capture.context; }
  private get stream(): MediaStream | null { return this.capture.mediaStream; }
  private get capturing(): boolean { return this.capture.isCapturing; }
  private get recording(): boolean { return this.capture.isRecording; }
  private get currentCaptureId(): VoiceCaptureId | null { return this.capture.captureId; }
  private get activeInputDeviceId(): string | undefined { return this.capture.inputDeviceId; }
  private get captureLifecyclePromise(): Promise<void> { return this.capture.lifecyclePromise; }
  private get captureIpcTails(): Map<VoiceCaptureId, Promise<void>> { return this.capture.ipcTails; }
  private get playbackStartControllers(): Map<PlaybackId, { turnId: TurnId; controller: AbortController }> {
    return this.playback.startControllers;
  }
  private get outputPlaybackEndedAt(): number | null { return this.playback.playbackEndedAt; }
  private get currentPlaybackSource(): AudioBufferSourceNode | null { return this.playback.playbackSource; }
  private stopCapture(): void { this.capture.stopCapture(); }
}
