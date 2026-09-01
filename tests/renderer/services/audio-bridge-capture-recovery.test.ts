import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  AudioBridge,
  audioTestEnvironment as env,
  createAudioBridgeTestFixture,
  makeAudioConfig,
} from './audio-bridge-test-harness.js';

describe('AudioBridge (capture recovery)', () => {
  let fixture: ReturnType<typeof createAudioBridgeTestFixture>;
  let bridge: InstanceType<typeof AudioBridge>;

  beforeEach(() => {
    fixture = createAudioBridgeTestFixture();
    bridge = fixture.bridge;
  });

  afterEach(async () => {
    await bridge.destroy();
  });

it('withdraws readiness and resumes a suspended live capture context', async () => {
    env.sarahMock.getConfig.mockResolvedValue({
      audio: makeAudioConfig(),
      controls: { voiceMode: 'push-to-talk' },
    });
    await bridge.start();
    const liveCaptureContext = (bridge as unknown as { captureCtx: MockAudioCtx }).captureCtx;
    env.captureCtxInstance.resume.mockImplementationOnce(async () => {
      liveCaptureContext.state = 'running';
    });
    liveCaptureContext.state = 'suspended';

    env.captureCtxInstance._emitStateChange();

    await vi.waitFor(() => expect(env.captureCtxInstance.resume).toHaveBeenCalledOnce());
    await vi.waitFor(() => {
      expect(env.sarahVoiceMock.setCaptureReady).toHaveBeenLastCalledWith(true);
    });
    const readiness = env.sarahVoiceMock.setCaptureReady.mock.calls.map(([ready]) => ready);
    expect(readiness.slice(-2)).toEqual([false, true]);
  });

  it('removes the capture context state listener during teardown', async () => {
    env.sarahMock.getConfig.mockResolvedValue({
      audio: makeAudioConfig(),
      controls: { voiceMode: 'push-to-talk' },
    });
    await bridge.start();

    expect(env.captureCtxInstance._stateChangeListeners.size).toBe(1);
    await bridge.destroy();

    expect(env.captureCtxInstance.removeEventListener).toHaveBeenCalledWith(
      'statechange',
      expect.any(Function),
    );
    expect(env.captureCtxInstance._stateChangeListeners.size).toBe(0);
  });

  it('terminates capture setup when AudioWorklet loading hangs', async () => {
    vi.useFakeTimers();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      env.sarahMock.getConfig.mockResolvedValue({
        audio: makeAudioConfig(),
        controls: { voiceMode: 'push-to-talk' },
      });
      env.captureCtxInstance._workletAddModule.mockReturnValueOnce(new Promise<void>(() => {}));

      const starting = bridge.start();
      await vi.advanceTimersByTimeAsync(5_000);
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

  it('keeps all idle audio outside both the current and next utterance', async () => {
    env.sarahMock.getConfig.mockResolvedValue({
      audio: makeAudioConfig(),
      controls: { voiceMode: 'push-to-talk' },
    });
    await bridge.start();
    await vi.waitFor(() => expect(env.captureCtxInstance._workletNode.port.onmessage).not.toBeNull());

    const port = env.captureCtxInstance._workletNode.port;
    port.onmessage?.({ data: {
      type: 'chunk', captureId: env.TEST_CAPTURE_ID, samples: new Float32Array([0.25]),
    } } as MessageEvent);
    fixture.stateChange({ state: 'listening', captureId: env.TEST_CAPTURE_ID });
    port.onmessage?.({ data: {
      type: 'chunk', captureId: env.TEST_CAPTURE_ID, samples: new Float32Array([0.5]),
    } } as MessageEvent);
    fixture.stateChange({ state: 'processing' });
    port.onmessage?.({ data: {
      type: 'chunk', captureId: env.TEST_CAPTURE_ID, samples: new Float32Array([0.75]),
    } } as MessageEvent);

    const nextCaptureId = '44444444-4444-4444-8444-444444444444';
    fixture.stateChange({ state: 'listening', captureId: nextCaptureId });

    await vi.waitFor(() => {
      expect(env.sarahVoiceMock.sendAudioChunk.mock.calls).toEqual([
        [env.TEST_CAPTURE_ID, [0.5]],
      ]);
    });
  });

  it('does not leak muted or pre-key samples across the unmute/PTT boundary', async () => {
    env.sarahMock.getConfig.mockResolvedValue({
      audio: makeAudioConfig({ inputMuted: true }),
      controls: { voiceMode: 'push-to-talk' },
    });
    await bridge.start();
    const port = env.captureCtxInstance._workletNode.port;

    port.onmessage?.({ data: {
      type: 'chunk', captureId: env.TEST_CAPTURE_ID, samples: new Float32Array([0.25]),
    } } as MessageEvent);
    await bridge.applyAudioConfig(makeAudioConfig({ inputMuted: false }));
    fixture.stateChange({ state: 'listening', captureId: env.TEST_CAPTURE_ID });
    port.onmessage?.({ data: {
      type: 'chunk', captureId: env.TEST_CAPTURE_ID, samples: new Float32Array([0.5]),
    } } as MessageEvent);

    await vi.waitFor(() => {
      expect(env.sarahVoiceMock.sendAudioChunk.mock.calls).toEqual([
        [env.TEST_CAPTURE_ID, [0.5]],
      ]);
    });
  });

  it('uses the captureId returned by getState when the dashboard starts mid-capture', async () => {
    const captureId = '55555555-5555-4555-8555-555555555555';
    env.sarahVoiceMock.getState.mockResolvedValue({ state: 'listening', captureId });

    await bridge.start();
    await vi.waitFor(() => expect(env.captureCtxInstance._workletNode.port.onmessage).not.toBeNull());
    env.captureCtxInstance._workletNode.port.onmessage?.({
      data: { type: 'chunk', captureId, samples: new Float32Array([0.5]) },
    } as MessageEvent);

    await vi.waitFor(() => {
      expect(env.sarahVoiceMock.sendAudioChunk).toHaveBeenCalledWith(captureId, [0.5]);
    });
  });

  it('acknowledges a capture flush only after its final chunk reached main', async () => {
    let releaseChunk: (() => void) | null = null;
    env.sarahVoiceMock.sendAudioChunk.mockImplementationOnce(() => new Promise<void>((resolve) => {
      releaseChunk = resolve;
    }));
    env.sarahMock.getConfig.mockResolvedValue({
      audio: makeAudioConfig(),
      controls: { voiceMode: 'push-to-talk' },
    });
    await bridge.start();
    await vi.waitFor(() => {
      expect(env.captureCtxInstance._workletNode.port.onmessage).not.toBeNull();
    });
    fixture.stateChange({ state: 'listening', captureId: env.TEST_CAPTURE_ID });
    const port = env.captureCtxInstance._workletNode.port;

    expect(port.postMessage).toHaveBeenCalledWith({
      type: 'begin', captureId: env.TEST_CAPTURE_ID,
    });
    fixture.captureFlush({ captureId: env.TEST_CAPTURE_ID });
    expect(port.postMessage).toHaveBeenCalledWith({
      type: 'flush', captureId: env.TEST_CAPTURE_ID,
    });
    port.onmessage?.({
      data: {
        type: 'chunk', captureId: env.TEST_CAPTURE_ID, samples: new Float32Array([0.75]),
      },
    } as MessageEvent);
    port.onmessage?.({
      data: { type: 'flushed', captureId: env.TEST_CAPTURE_ID },
    } as MessageEvent);

    await Promise.resolve();
    expect(env.sarahVoiceMock.captureFlushed).not.toHaveBeenCalled();
    releaseChunk?.();
    await vi.waitFor(() => {
      expect(env.sarahVoiceMock.captureFlushed).toHaveBeenCalledWith(env.TEST_CAPTURE_ID);
    });
  });

  it('reports a correlated failure instead of acknowledging when the worklet disappeared', async () => {
    env.sarahMock.getConfig.mockResolvedValue({
      audio: makeAudioConfig(),
      controls: { voiceMode: 'push-to-talk' },
    });
    await bridge.start();
    fixture.stateChange({ state: 'listening', captureId: env.TEST_CAPTURE_ID });
    (bridge as unknown as { stopCapture(): void }).stopCapture();

    fixture.captureFlush({ captureId: env.TEST_CAPTURE_ID });

    await vi.waitFor(() => {
      expect(env.sarahVoiceMock.captureFailed).toHaveBeenCalledWith(
        env.TEST_CAPTURE_ID,
        expect.stringContaining('Mikrofonverbindung wurde unterbrochen'),
      );
    });
    expect(env.sarahVoiceMock.captureFlushed).not.toHaveBeenCalled();
  });

  it('cancels worklet state and releases IPC-tail ownership on a non-flush terminal state', async () => {
    let rejectChunk: ((reason: Error) => void) | null = null;
    env.sarahVoiceMock.sendAudioChunk.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => {
      rejectChunk = reject;
    }));
    env.sarahMock.getConfig.mockResolvedValue({
      audio: makeAudioConfig(),
      controls: { voiceMode: 'push-to-talk' },
    });
    await bridge.start();
    fixture.stateChange({ state: 'listening', captureId: env.TEST_CAPTURE_ID });
    const port = env.captureCtxInstance._workletNode.port;
    port.onmessage?.({
      data: {
        type: 'chunk', captureId: env.TEST_CAPTURE_ID, samples: new Float32Array([0.5]),
      },
    } as MessageEvent);
    await Promise.resolve();

    fixture.stateChange({ state: 'idle' });

    expect(port.postMessage).toHaveBeenCalledWith({
      type: 'cancel', captureId: env.TEST_CAPTURE_ID,
    });
    const internal = bridge as unknown as {
      captureIpcTails: Map<string, Promise<void>>;
      currentCaptureId: string | null;
    };
    expect(internal.captureIpcTails.size).toBe(0);
    expect(internal.currentCaptureId).toBeNull();

    rejectChunk?.(new Error('renderer IPC closed'));
    await Promise.resolve();
    await Promise.resolve();
  });

  it('reports capture initialization failure and stops renderer recording state', async () => {
    const denied = Object.assign(new Error('permission denied'), { name: 'NotAllowedError' });
    (navigator.mediaDevices.getUserMedia as ReturnType<typeof vi.fn>).mockRejectedValueOnce(denied);
    await bridge.start();

    fixture.stateChange({ state: 'listening', captureId: env.TEST_CAPTURE_ID });

    await vi.waitFor(() => {
      expect(env.sarahVoiceMock.captureFailed).toHaveBeenCalledWith(
        env.TEST_CAPTURE_ID,
        expect.stringContaining('Mikrofon konnte nicht gestartet werden'),
      );
    });
    const internal = bridge as unknown as { recording: boolean; currentCaptureId: string | null };
    expect(internal.recording).toBe(false);
    expect(internal.currentCaptureId).toBeNull();
  });

  it('fails an active capture and reinitializes the warm mic when its track ends', async () => {
    env.sarahMock.getConfig.mockResolvedValue({
      audio: makeAudioConfig(),
      controls: { voiceMode: 'push-to-talk' },
    });
    await bridge.start();
    await vi.waitFor(() => expect(env.trackEndedListeners).toHaveLength(1));

    fixture.stateChange({ state: 'listening', captureId: env.TEST_CAPTURE_ID });
    env.trackEndedListeners[0]();

    await vi.waitFor(() => {
      expect(env.sarahVoiceMock.captureFailed).toHaveBeenCalledWith(
        env.TEST_CAPTURE_ID,
        expect.stringContaining('Mikrofonverbindung wurde unterbrochen'),
      );
      expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(2);
    });
    const internal = bridge as unknown as {
      recording: boolean;
      capturing: boolean;
      currentCaptureId: string | null;
    };
    expect(internal.recording).toBe(false);
    expect(internal.capturing).toBe(true);
    expect(internal.currentCaptureId).toBeNull();
  });

  it('backs off and retries when the first live-capture recovery is transiently rejected', async () => {
    vi.useFakeTimers();
    try {
      env.sarahMock.getConfig.mockResolvedValue({
        audio: makeAudioConfig(),
        controls: { voiceMode: 'push-to-talk' },
      });
      await bridge.start();
      expect(env.trackEndedListeners).toHaveLength(1);
      (navigator.mediaDevices.getUserMedia as ReturnType<typeof vi.fn>)
        .mockRejectedValueOnce(new Error('temporary device outage'));

      env.trackEndedListeners[0]();
      await vi.waitFor(() => {
        expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(2);
      });
      expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(250);
      await vi.waitFor(() => {
        expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(3);
      });
      expect(env.sarahVoiceMock.setCaptureReady).toHaveBeenLastCalledWith(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('coalesces a second track loss during recovery and waits for a live replacement', async () => {
    env.sarahMock.getConfig.mockResolvedValue({
      audio: makeAudioConfig(),
      controls: { voiceMode: 'push-to-talk' },
    });
    await bridge.start();
    expect(env.trackEndedListeners).toHaveLength(1);

    const endedDuringSetupTrack = {
      stop: vi.fn(),
      readyState: 'ended' as MediaStreamTrackState,
      getSettings: vi.fn(() => ({ deviceId: 'failed-replacement' })),
      addEventListener: vi.fn((event: string, listener: () => void) => {
        if (event === 'ended') listener();
      }),
    };
    const endedDuringSetupStream = { getTracks: () => [endedDuringSetupTrack] };
    let releaseLiveReplacement: ((stream: typeof env.mockStream) => void) | null = null;
    const liveReplacement = new Promise<typeof env.mockStream>((resolve) => {
      releaseLiveReplacement = resolve;
    });
    (navigator.mediaDevices.getUserMedia as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(endedDuringSetupStream)
      .mockReturnValueOnce(liveReplacement);

    env.trackEndedListeners[0]();
    await vi.waitFor(() => {
      expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(3);
    });
    expect(env.sarahVoiceMock.setCaptureReady).toHaveBeenLastCalledWith(false);

    releaseLiveReplacement?.(env.mockStream);
    await vi.waitFor(() => {
      expect(env.sarahVoiceMock.setCaptureReady).toHaveBeenLastCalledWith(true);
    });
  });

  it('fails and rebuilds an active capture when its selected input disappears', async () => {
    env.sarahMock.getConfig.mockResolvedValue({
      audio: makeAudioConfig({ inputDeviceId: 'mic-a' }),
      controls: { voiceMode: 'push-to-talk' },
    });
    await bridge.start();
    await vi.waitFor(() => expect(env.deviceChangeListener).not.toBeNull());
    fixture.stateChange({ state: 'listening', captureId: env.TEST_CAPTURE_ID });

    (navigator.mediaDevices.enumerateDevices as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([]);
    env.deviceChangeListener?.();

    await vi.waitFor(() => {
      expect(env.sarahVoiceMock.captureFailed).toHaveBeenCalledWith(
        env.TEST_CAPTURE_ID,
        expect.stringContaining('Mikrofonverbindung wurde unterbrochen'),
      );
      expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(2);
    });
  });

  it('disposes a stale mic acquired after a device switch and keeps only the new stream', async () => {
    const staleTrack = {
      stop: vi.fn(),
      readyState: 'live' as MediaStreamTrackState,
      addEventListener: vi.fn(),
      getSettings: vi.fn(() => ({ deviceId: 'mic-a' })),
    };
    const freshTrack = {
      stop: vi.fn(),
      readyState: 'live' as MediaStreamTrackState,
      addEventListener: vi.fn(),
      getSettings: vi.fn(() => ({ deviceId: 'mic-b' })),
    };
    const staleStream = { getTracks: () => [staleTrack] };
    const freshStream = { getTracks: () => [freshTrack] };
    let releaseStale!: (stream: typeof staleStream) => void;
    const pendingStale = new Promise<typeof staleStream>((resolve) => {
      releaseStale = resolve;
    });
    const getUserMedia = navigator.mediaDevices.getUserMedia as ReturnType<typeof vi.fn>;
    getUserMedia
      .mockReturnValueOnce(pendingStale)
      .mockResolvedValueOnce(freshStream);
    env.sarahMock.getConfig.mockResolvedValue({
      audio: makeAudioConfig({ inputDeviceId: 'mic-a' }),
    });

    await bridge.start();
    fixture.stateChange({ state: 'listening', captureId: env.TEST_CAPTURE_ID });
    await vi.waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(1));
    await bridge.applyAudioConfig(makeAudioConfig({ inputDeviceId: 'mic-b' }));

    releaseStale(staleStream);
    await vi.waitFor(() => expect(staleTrack.stop).toHaveBeenCalledOnce());

    const internal = bridge as unknown as { stream: typeof freshStream | null };
    expect(internal.stream).toBe(freshStream);
    expect(freshTrack.stop).not.toHaveBeenCalled();
  });

  it('closes AudioContext instances on destroy', async () => {
    await bridge.start();

    // Trigger capture to create captureCtx
    fixture.stateChange({ state: 'listening' });
    await vi.waitFor(() => {
      expect((navigator.mediaDevices.getUserMedia as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
    });

    // Trigger playback to create playbackCtx
    fixture.playAudio([0.1, 0.2, 0.3]);
    await vi.waitFor(() => {
      expect(env.ctxCallCount).toBe(2);
    });

    await bridge.destroy();

    expect(env.captureCtxInstance.close).toHaveBeenCalledOnce();
    expect(env.playbackCtxInstance.close).toHaveBeenCalledOnce();
  });

  it('cancels active worklet state and releases IPC tails during destroy', async () => {
    let rejectChunk: ((reason: Error) => void) | null = null;
    env.sarahVoiceMock.sendAudioChunk.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => {
      rejectChunk = reject;
    }));
    env.sarahMock.getConfig.mockResolvedValue({
      audio: makeAudioConfig(),
      controls: { voiceMode: 'push-to-talk' },
    });
    await bridge.start();
    fixture.stateChange({ state: 'listening', captureId: env.TEST_CAPTURE_ID });
    const port = env.captureCtxInstance._workletNode.port;
    port.onmessage?.({
      data: {
        type: 'chunk', captureId: env.TEST_CAPTURE_ID, samples: new Float32Array([0.25]),
      },
    } as MessageEvent);
    await Promise.resolve();

    await bridge.destroy();

    expect(port.postMessage).toHaveBeenCalledWith({
      type: 'cancel', captureId: env.TEST_CAPTURE_ID,
    });
    const internal = bridge as unknown as { captureIpcTails: Map<string, Promise<void>> };
    expect(internal.captureIpcTails.size).toBe(0);

    rejectChunk?.(new Error('renderer IPC closed'));
    await Promise.resolve();
    await Promise.resolve();
  });
});
