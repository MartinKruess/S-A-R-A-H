import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  AudioBridge,
  audioTestEnvironment as env,
  createAudioBridgeTestFixture,
  makeAudioConfig,
} from './audio-bridge-test-harness.js';

describe('AudioBridge (startup & warm capture)', () => {
  let fixture: ReturnType<typeof createAudioBridgeTestFixture>;
  let bridge: InstanceType<typeof AudioBridge>;

  beforeEach(() => {
    fixture = createAudioBridgeTestFixture();
    bridge = fixture.bridge;
  });

  afterEach(async () => {
    await bridge.destroy();
  });

it('registers state and playAudio listeners on start', async () => {
    await bridge.start();
    expect(env.sarahVoiceMock.onStateChange).toHaveBeenCalledOnce();
    expect(env.sarahVoiceMock.onPlayAudio).toHaveBeenCalledOnce();
    expect(env.sarahVoiceMock.onStopPlayback).toHaveBeenCalledOnce();
    expect(env.sarahVoiceMock.onCaptureFlushRequest).toHaveBeenCalledOnce();
    expect(env.sarahVoiceMock.getState).toHaveBeenCalledOnce();
  });

  it('starts capture when state changes to listening', async () => {
    await bridge.start();
    fixture.stateChange({ state: 'listening' });

    await vi.waitFor(() => {
      expect((navigator.mediaDevices.getUserMedia as ReturnType<typeof vi.fn>)).toHaveBeenCalledOnce();
    });
  });

  it('keeps the mic warm when state changes from listening to processing', async () => {
    await bridge.start();
    fixture.stateChange({ state: 'listening' });

    await vi.waitFor(() => {
      expect((navigator.mediaDevices.getUserMedia as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
    });

    fixture.stateChange({ state: 'processing' });

    // Mic graph stays warm across the utterance boundary — the stream is NOT
    // torn down, only `recording` flips off. Re-acquisition latency was the
    // root cause of clipped sentence starts.
    expect(env.mockTrack.stop).not.toHaveBeenCalled();
    const internal = bridge as unknown as { recording: boolean; capturing: boolean };
    expect(internal.recording).toBe(false);
    expect(internal.capturing).toBe(true);
  });

  it('warms capture on start() when voiceMode is push-to-talk, before any state change', async () => {
    env.sarahMock.getConfig.mockResolvedValue({
      audio: makeAudioConfig(),
      controls: { voiceMode: 'push-to-talk' },
    });

    await bridge.start();

    // Warm-on-start acquires the mic and builds the gain graph up front — with
    // NO 'listening' state change having fired yet.
    await vi.waitFor(() => {
      expect((navigator.mediaDevices.getUserMedia as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
      expect(env.captureCtxInstance.createGain).toHaveBeenCalled();
    });
    const internal = bridge as unknown as { recording: boolean; capturing: boolean };
    expect(internal.capturing).toBe(true);
    // Warming is not recording — nothing streamed to main until 'listening'.
    expect(internal.recording).toBe(false);
    expect(env.sarahVoiceMock.sendAudioChunk).not.toHaveBeenCalled();
  });

  it('does not re-acquire the mic across listening → idle → listening cycles', async () => {
    await bridge.start();

    const getUserMediaMock = navigator.mediaDevices.getUserMedia as ReturnType<typeof vi.fn>;

    fixture.stateChange({ state: 'listening' });
    await vi.waitFor(() => {
      expect(getUserMediaMock).toHaveBeenCalled();
    });

    fixture.stateChange({ state: 'idle' });
    fixture.stateChange({ state: 'listening' });
    // Give any (unwanted) re-acquisition a tick to show up.
    await Promise.resolve();

    // Mic stayed warm — acquired exactly once for both cycles.
    expect(getUserMediaMock).toHaveBeenCalledOnce();
  });

  it('discards warm-mic chunks from before PTT instead of assigning them to the new turn', async () => {
    // Warm-on-start so the capture worklet exists before any 'listening'.
    env.sarahMock.getConfig.mockResolvedValue({
      audio: makeAudioConfig(),
      controls: { voiceMode: 'push-to-talk' },
    });
    await bridge.start();

    await vi.waitFor(() => {
      expect(env.captureCtxInstance._workletNode.port.onmessage).not.toBeNull();
    });

    const port = env.captureCtxInstance._workletNode.port;

    // A chunk arrives while warm but NOT recording (state still idle): it must
    // be discarded, not streamed or retained for a later capture.
    // Use exactly Float32-representable values so the round-trip is lossless.
    port.onmessage?.({ data: {
      type: 'chunk', captureId: env.TEST_CAPTURE_ID, samples: new Float32Array([0.5, 0.25]),
    } } as MessageEvent);
    expect(env.sarahVoiceMock.sendAudioChunk).not.toHaveBeenCalled();

    // On 'listening', pre-key audio remains outside the new PTT capture.
    fixture.stateChange({ state: 'listening' });
    expect(env.sarahVoiceMock.sendAudioChunk).not.toHaveBeenCalled();
  });

  it('normalizes the unavailable keyword mode to off instead of opening the microphone', async () => {
    env.sarahMock.getConfig.mockResolvedValue({
      audio: makeAudioConfig(),
      controls: { voiceMode: 'keyword' },
    });

    await bridge.start();

    expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
    expect(env.sarahVoiceMock.setCaptureReady).toHaveBeenLastCalledWith(false);
  });

  it('closes and rewarms the mic when voice mode or STT capability changes', async () => {
    env.sarahMock.getConfig.mockResolvedValue({
      audio: makeAudioConfig(),
      controls: { voiceMode: 'push-to-talk' },
    });
    await bridge.start();

    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledOnce();
    expect(env.sarahVoiceMock.setCaptureReady).toHaveBeenLastCalledWith(true);

    fixture.voiceInputConfig({ voiceMode: 'off' });
    const internal = bridge as unknown as { captureLifecyclePromise: Promise<void> };
    await internal.captureLifecyclePromise;
    expect(env.mockTrack.stop).toHaveBeenCalled();
    expect(env.sarahVoiceMock.setCaptureReady).toHaveBeenLastCalledWith(false);

    fixture.voiceInputConfig({ voiceMode: 'push-to-talk' });
    await internal.captureLifecyclePromise;
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(2);
    expect(env.sarahVoiceMock.setCaptureReady).toHaveBeenLastCalledWith(true);

    fixture.capability({ stt: false, tts: true });
    await internal.captureLifecyclePromise;
    expect(env.sarahVoiceMock.setCaptureReady).toHaveBeenLastCalledWith(false);

    fixture.capability({ stt: true, tts: true });
    await internal.captureLifecyclePromise;
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(3);
    expect(env.sarahVoiceMock.setCaptureReady).toHaveBeenLastCalledWith(true);
  });

  it('times out a hung microphone setup and can warm successfully on retry', async () => {
    vi.useFakeTimers();
    try {
      env.sarahMock.getConfig.mockResolvedValue({
        audio: makeAudioConfig(),
        controls: { voiceMode: 'push-to-talk' },
      });
      const getUserMedia = navigator.mediaDevices.getUserMedia as ReturnType<typeof vi.fn>;
      getUserMedia.mockReturnValueOnce(new Promise<MediaStream>(() => {}));

      const starting = bridge.start();
      await vi.advanceTimersByTimeAsync(10_000);
      await starting;

      expect(env.sarahVoiceMock.captureFailed).toHaveBeenCalledWith(
        undefined,
        expect.stringContaining('Mikrofon konnte nicht gestartet werden'),
      );
      expect(env.sarahVoiceMock.setCaptureReady).toHaveBeenLastCalledWith(false);

      getUserMedia.mockResolvedValueOnce(env.mockStream);
      fixture.capability({ stt: false, tts: true });
      fixture.capability({ stt: true, tts: true });
      const internal = bridge as unknown as { captureLifecyclePromise: Promise<void> };
      await internal.captureLifecyclePromise;

      expect(getUserMedia).toHaveBeenCalledTimes(2);
      expect(env.sarahVoiceMock.setCaptureReady).toHaveBeenLastCalledWith(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('self-retries a transient initial capture failure with bounded backoff', async () => {
    vi.useFakeTimers();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      env.sarahMock.getConfig.mockResolvedValue({
        audio: makeAudioConfig(),
        controls: { voiceMode: 'push-to-talk' },
      });
      const transient = new Error('temporary device failure');
      const getUserMedia = navigator.mediaDevices.getUserMedia as ReturnType<typeof vi.fn>;
      getUserMedia.mockRejectedValueOnce(transient).mockResolvedValueOnce(env.mockStream);

      await bridge.start();
      expect(getUserMedia).toHaveBeenCalledOnce();
      expect(env.sarahVoiceMock.setCaptureReady).toHaveBeenLastCalledWith(false);

      await vi.advanceTimersByTimeAsync(250);
      const internal = bridge as unknown as { captureLifecyclePromise: Promise<void> };
      await internal.captureLifecyclePromise;

      expect(getUserMedia).toHaveBeenCalledTimes(2);
      expect(env.sarahVoiceMock.setCaptureReady).toHaveBeenLastCalledWith(true);
    } finally {
      errorSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('stops self-retrying after the bounded capture backoff budget is exhausted', async () => {
    vi.useFakeTimers();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      env.sarahMock.getConfig.mockResolvedValue({
        audio: makeAudioConfig(),
        controls: { voiceMode: 'push-to-talk' },
      });
      const getUserMedia = navigator.mediaDevices.getUserMedia as ReturnType<typeof vi.fn>;
      getUserMedia.mockRejectedValue(new Error('device remains unavailable'));

      await bridge.start();
      await vi.advanceTimersByTimeAsync(10_000);
      const internal = bridge as unknown as { captureLifecyclePromise: Promise<void> };
      await internal.captureLifecyclePromise;

      expect(getUserMedia).toHaveBeenCalledTimes(4);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(getUserMedia).toHaveBeenCalledTimes(4);
    } finally {
      errorSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('keeps subscription updates that arrive while startup snapshots are pending', async () => {
    let resolveConfig!: (value: {
      audio: AudioConfigFields;
      controls: { voiceMode: 'push-to-talk' };
    }) => void;
    let resolveRuntime!: (value: {
      state: 'ready';
      generation: number;
      updatedAt: number;
      capabilities: { stt: { state: 'ready' } };
    }) => void;
    env.sarahMock.getConfig.mockReturnValueOnce(new Promise((resolve) => {
      resolveConfig = resolve;
    }));
    env.sarahMock.getRuntimeStatus.mockReturnValueOnce(new Promise((resolve) => {
      resolveRuntime = resolve;
    }));

    const starting = bridge.start();
    fixture.voiceInputConfig({ voiceMode: 'off' });
    fixture.capability({ stt: false, tts: true });
    resolveConfig({
      audio: makeAudioConfig(),
      controls: { voiceMode: 'push-to-talk' },
    });
    resolveRuntime({
      state: 'ready',
      generation: 1,
      updatedAt: 1,
      capabilities: { stt: { state: 'ready' } },
    });
    await starting;

    expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
    expect(env.sarahVoiceMock.setCaptureReady).toHaveBeenLastCalledWith(false);
  });

  it('does not overwrite a live voice state after asynchronous startup reconciliation', async () => {
    let resolveWorklet!: () => void;
    env.captureCtxInstance.audioWorklet.addModule.mockReturnValueOnce(new Promise<void>((resolve) => {
      resolveWorklet = resolve;
    }));
    env.sarahMock.getConfig.mockResolvedValue({
      audio: makeAudioConfig(),
      controls: { voiceMode: 'push-to-talk' },
    });
    const starting = bridge.start();
    await vi.waitFor(() => expect(env.captureCtxInstance.audioWorklet.addModule).toHaveBeenCalledOnce());

    fixture.stateChange({ state: 'listening', captureId: env.TEST_CAPTURE_ID });
    resolveWorklet();
    await starting;

    const internal = bridge as unknown as {
      currentCaptureId: string | null;
      recording: boolean;
    };
    expect(internal.currentCaptureId).toBe(env.TEST_CAPTURE_ID);
    expect(internal.recording).toBe(true);
  });

  it('best-effort reports an active capture failure before renderer teardown', async () => {
    env.sarahMock.getConfig.mockResolvedValue({
      audio: makeAudioConfig(),
      controls: { voiceMode: 'push-to-talk' },
    });
    await bridge.start();
    fixture.stateChange({ state: 'listening', captureId: env.TEST_CAPTURE_ID });

    const destroying = bridge.destroy();

    expect(env.sarahVoiceMock.captureFailed).toHaveBeenCalledWith(
      env.TEST_CAPTURE_ID,
      'Die Mikrofonverbindung wurde unterbrochen. Bitte Audiogerät prüfen und erneut versuchen.',
    );
    await destroying;
    expect(env.sarahVoiceMock.setCaptureReady).toHaveBeenLastCalledWith(false);
  });

  it('terminates capture setup when AudioContext resume hangs', async () => {
    vi.useFakeTimers();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      env.sarahMock.getConfig.mockResolvedValue({
        audio: makeAudioConfig(),
        controls: { voiceMode: 'push-to-talk' },
      });
      env.captureCtxInstance.state = 'suspended';
      env.captureCtxInstance.resume.mockReturnValueOnce(new Promise<void>(() => {}));

      const starting = bridge.start();
      await vi.advanceTimersByTimeAsync(3_000);
      await starting;

      expect(env.sarahVoiceMock.captureFailed).toHaveBeenCalledWith(
        undefined,
        expect.stringContaining('Mikrofon konnte nicht gestartet werden'),
      );
      expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
      expect(env.sarahVoiceMock.setCaptureReady).toHaveBeenLastCalledWith(false);
    } finally {
      errorSpy.mockRestore();
      vi.useRealTimers();
    }
  });
});
