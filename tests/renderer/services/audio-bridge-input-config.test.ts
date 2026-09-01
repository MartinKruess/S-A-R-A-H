import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  AudioBridge,
  audioTestEnvironment as env,
  createAudioBridgeTestFixture,
  makeAudioConfig,
} from './audio-bridge-test-harness.js';

describe('AudioBridge (input configuration)', () => {
  let fixture: ReturnType<typeof createAudioBridgeTestFixture>;
  let bridge: InstanceType<typeof AudioBridge>;

  beforeEach(() => {
    fixture = createAudioBridgeTestFixture();
    bridge = fixture.bridge;
  });

  afterEach(async () => {
    await bridge.destroy();
  });

it('inserts a GainNode between source and worklet on capture', async () => {
    env.sarahMock.getConfig.mockResolvedValue({
      audio: makeAudioConfig({ inputGain: 1.2, inputVolume: 0.5 }),
    });
    await bridge.start();
    fixture.stateChange({ state: 'listening' });

    await vi.waitFor(() => {
      expect(env.captureCtxInstance.createGain).toHaveBeenCalledOnce();
    });

    // source → gain, gain → worklet, worklet → destination
    expect(env.captureCtxInstance._sourceNode.connect).toHaveBeenCalledWith(env.captureCtxInstance._gainNode);
    expect(env.captureCtxInstance._gainNode.connect).toHaveBeenCalledWith(env.captureCtxInstance._workletNode);
    // GainNode seeded with effective gain (1.2 * 0.5 = 0.6)
    expect(env.captureCtxInstance._gainNode.gain.value).toBeCloseTo(0.6);
  });

  it('short-circuits IPC send when muted', async () => {
    env.sarahMock.getConfig.mockResolvedValue({
      audio: makeAudioConfig({ inputMuted: true }),
    });
    await bridge.start();
    fixture.stateChange({ state: 'listening' });

    await vi.waitFor(() => {
      expect(env.captureCtxInstance._workletNode.port.onmessage).not.toBeNull();
    });

    // Simulate worklet posting samples — mute should drop them
    const port = env.captureCtxInstance._workletNode.port;
    const samples = new Float32Array([0, 0, 0]);
    port.onmessage?.({ data: { type: 'chunk', captureId: env.TEST_CAPTURE_ID, samples } } as MessageEvent);
    expect(env.sarahVoiceMock.sendAudioChunk).not.toHaveBeenCalled();
  });

  it('forwards IPC chunks when not muted', async () => {
    await bridge.start();
    fixture.stateChange({ state: 'listening' });

    await vi.waitFor(() => {
      expect(env.captureCtxInstance._workletNode.port.onmessage).not.toBeNull();
    });

    const port = env.captureCtxInstance._workletNode.port;
    const samples = new Float32Array([0.1, 0.2]);
    port.onmessage?.({ data: { type: 'chunk', captureId: env.TEST_CAPTURE_ID, samples } } as MessageEvent);
    await vi.waitFor(() => {
      expect(env.sarahVoiceMock.sendAudioChunk).toHaveBeenCalledOnce();
    });
  });

  it('ramps gain via setTargetAtTime on config change', async () => {
    await bridge.start();
    fixture.stateChange({ state: 'listening' });

    await vi.waitFor(() => {
      expect(env.captureCtxInstance.createGain).toHaveBeenCalled();
    });

    const setTargetAtTime = env.captureCtxInstance._gainNode.gain.setTargetAtTime;
    setTargetAtTime.mockClear();

    await fixture.audioConfig(makeAudioConfig({ inputGain: 1.5, inputVolume: 0.8 }));

    // 1.5 * 0.8 = 1.2 at the mocked currentTime (0) with 15ms constant
    expect(setTargetAtTime).toHaveBeenCalledTimes(1);
    const [target, atTime, tc] = setTargetAtTime.mock.calls[0];
    expect(target).toBeCloseTo(1.2);
    expect(atTime).toBe(0);
    expect(tc).toBe(0.015);
  });

  it('is idempotent when audio config is unchanged', async () => {
    const cfg = makeAudioConfig({ inputGain: 1.1 });
    env.sarahMock.getConfig.mockResolvedValue({ audio: cfg });
    await bridge.start();
    fixture.stateChange({ state: 'listening' });

    await vi.waitFor(() => {
      expect(env.captureCtxInstance.createGain).toHaveBeenCalled();
    });

    const setTargetAtTime = env.captureCtxInstance._gainNode.gain.setTargetAtTime;
    setTargetAtTime.mockClear();

    // Same slice arrives — should be a no-op, no ramp triggered
    await fixture.audioConfig({ ...cfg });
    expect(setTargetAtTime).not.toHaveBeenCalled();
  });

  it('rebuilds capture graph when inputDeviceId changes while capturing', async () => {
    env.sarahMock.getConfig.mockResolvedValue({
      audio: makeAudioConfig({ inputDeviceId: 'mic-a' }),
    });
    await bridge.start();
    fixture.stateChange({ state: 'listening' });

    await vi.waitFor(() => {
      expect(env.captureCtxInstance.createGain).toHaveBeenCalled();
    });

    const firstCtx = env.captureCtxInstance;
    (navigator.mediaDevices.getUserMedia as ReturnType<typeof vi.fn>).mockClear();

    await fixture.audioConfig(makeAudioConfig({ inputDeviceId: 'mic-b' }));
    await vi.waitFor(() => {
      expect((navigator.mediaDevices.getUserMedia as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
    });

    // Old stream stopped, old context closed, new context created
    expect(env.mockTrack.stop).toHaveBeenCalled();
    expect(firstCtx.close).toHaveBeenCalled();
    // A third AudioContext was constructed (capture1, playback-unused, capture2) or (capture1, capture2, ...)
    expect(env.ctxCallCount).toBeGreaterThanOrEqual(2);
    // New getUserMedia call passed the exact device constraint
    const lastCall = (navigator.mediaDevices.getUserMedia as ReturnType<typeof vi.fn>).mock.calls.at(-1);
    expect(lastCall?.[0]?.audio?.deviceId?.exact).toBe('mic-b');
  });

  it('passes deviceId constraint to getUserMedia when configured', async () => {
    env.sarahMock.getConfig.mockResolvedValue({
      audio: makeAudioConfig({ inputDeviceId: 'mic-xyz' }),
    });
    await bridge.start();
    fixture.stateChange({ state: 'listening' });

    await vi.waitFor(() => {
      expect((navigator.mediaDevices.getUserMedia as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
    });

    const call = (navigator.mediaDevices.getUserMedia as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0].audio.deviceId.exact).toBe('mic-xyz');
  });

  it('serializes rapid applyAudioConfig calls — last deviceId wins', async () => {
    // Start with mic-a capturing, so decideCaptureReset() returns 'reset'
    // for each queued call (state='listening' + device change).
    env.sarahMock.getConfig.mockResolvedValue({
      audio: makeAudioConfig({ inputDeviceId: 'mic-a' }),
      controls: { voiceMode: 'push-to-talk' },
    });
    await bridge.start();
    fixture.stateChange({ state: 'listening' });

    await vi.waitFor(() => {
      expect(env.captureCtxInstance.createGain).toHaveBeenCalled();
    });

    const getUserMediaMock = navigator.mediaDevices.getUserMedia as ReturnType<typeof vi.fn>;
    getUserMediaMock.mockClear();

    // Two rapid applies: B must see A's committed state, not stale mic-a.
    const pA = bridge.applyAudioConfig(makeAudioConfig({ inputDeviceId: 'mic-b' }));
    const pB = bridge.applyAudioConfig(makeAudioConfig({ inputDeviceId: 'mic-c' }));
    await Promise.all([pA, pB]);

    // Both calls reached startCapture → two new getUserMedia calls, in order.
    expect(getUserMediaMock).toHaveBeenCalledTimes(2);
    expect(getUserMediaMock.mock.calls[0][0].audio.deviceId.exact).toBe('mic-b');
    expect(getUserMediaMock.mock.calls[1][0].audio.deviceId.exact).toBe('mic-c');

    // Final constraint — the call that "wins" for the live graph — is mic-c.
    const lastCall = getUserMediaMock.mock.calls.at(-1);
    expect(lastCall?.[0]?.audio?.deviceId?.exact).toBe('mic-c');
  });

  it('destroy() mid-apply does not leave a live mic stream or worklet behind', async () => {
    env.sarahMock.getConfig.mockResolvedValue({
      audio: makeAudioConfig({ inputDeviceId: 'mic-a' }),
    });
    await bridge.start();
    fixture.stateChange({ state: 'listening' });

    await vi.waitFor(() => {
      expect(env.captureCtxInstance.createGain).toHaveBeenCalled();
    });

    // Freeze getUserMedia so the rebuild below is still in-flight when destroy hits.
    const getUserMediaMock = navigator.mediaDevices.getUserMedia as ReturnType<typeof vi.fn>;
    let release!: (value: typeof env.mockStream) => void;
    const pending = new Promise<typeof env.mockStream>((resolve) => {
      release = resolve;
    });
    getUserMediaMock.mockClear();
    // mic-b triggers a reset → stopCapture, close ctx, then startCapture whose
    // getUserMedia hangs on `pending`. mic-a from the initial startCapture was
    // already stopped by that reset; env.mockTrack.stop resets can confirm the
    // second teardown (from destroy) does its job.
    getUserMediaMock.mockReturnValueOnce(pending);

    // Kick off a device-switch apply; it will await the pending getUserMedia
    // inside startCapture, which itself runs inside _applyAudioConfigSerial.
    const applying = bridge.applyAudioConfig(makeAudioConfig({ inputDeviceId: 'mic-b' }));

    // Wait until the in-flight startCapture has reached the pending
    // getUserMedia — that's the moment apply is mid-flight.
    await vi.waitFor(() => {
      expect(getUserMediaMock).toHaveBeenCalled();
    });

    // Clear counters: we care about teardown effects AFTER destroy latches.
    // The reset path already stopped the mic-a stream & disconnected that
    // graph; those calls aren't what we're validating here.
    env.mockTrack.stop.mockClear();
    env.playbackCtxInstance.close.mockClear();

    // Now destroy while apply is pending. destroy awaits applyPromise before
    // tearing down, so it blocks until we release the pending stream.
    const destroying = bridge.destroy();

    // Release the stream so the in-flight startCapture can finish, then apply
    // resolves, then destroy proceeds to its own stopCapture + context close.
    release(env.mockStream);

    await applying;
    await destroying;

    // The pending setup is invalidated before it wires a worklet: its late
    // stream is stopped and its private context is closed before destroy ends.
    expect(env.mockTrack.stop).toHaveBeenCalled();
    expect(env.playbackCtxInstance.close).toHaveBeenCalled();
  });

  it('falls back to default mic on OverconstrainedError', async () => {
    env.sarahMock.getConfig.mockResolvedValue({
      audio: makeAudioConfig({ inputDeviceId: 'mic-gone' }),
    });

    const overconstrained = Object.assign(new Error('no such device'), { name: 'OverconstrainedError' });
    const getUserMediaMock = navigator.mediaDevices.getUserMedia as ReturnType<typeof vi.fn>;
    getUserMediaMock
      .mockRejectedValueOnce(overconstrained)
      .mockResolvedValueOnce(env.mockStream);

    await bridge.start();
    fixture.stateChange({ state: 'listening' });

    await vi.waitFor(() => {
      expect(getUserMediaMock).toHaveBeenCalledTimes(2);
    });

    // First call had the exact deviceId, retry had no deviceId constraint
    expect(getUserMediaMock.mock.calls[0][0].audio.deviceId.exact).toBe('mic-gone');
    expect(getUserMediaMock.mock.calls[1][0].audio.deviceId).toBeUndefined();
  });

  it('fails an active capture immediately before rebuilding for an input-device change', async () => {
    env.sarahMock.getConfig.mockResolvedValue({
      audio: makeAudioConfig({ inputDeviceId: 'mic-a' }),
      controls: { voiceMode: 'push-to-talk' },
    });
    await bridge.start();
    fixture.stateChange({ state: 'listening', captureId: env.TEST_CAPTURE_ID });
    const firstPort = env.captureCtxInstance._workletNode.port;

    await bridge.applyAudioConfig(makeAudioConfig({ inputDeviceId: 'mic-b' }));

    expect(firstPort.postMessage).toHaveBeenCalledWith({
      type: 'cancel', captureId: env.TEST_CAPTURE_ID,
    });
    expect(env.sarahVoiceMock.captureFailed).toHaveBeenCalledWith(
      env.TEST_CAPTURE_ID,
      expect.stringContaining('Mikrofonverbindung wurde unterbrochen'),
    );
    const internal = bridge as unknown as {
      recording: boolean;
      currentCaptureId: string | null;
    };
    expect(internal.recording).toBe(false);
    expect(internal.currentCaptureId).toBeNull();
  });

  it('tracks the actual fallback mic and switches back only when the preferred mic returns', async () => {
    const fallbackTrack = {
      stop: vi.fn(),
      readyState: 'live' as MediaStreamTrackState,
      addEventListener: vi.fn(),
      getSettings: vi.fn(() => ({ deviceId: 'default-mic' })),
    };
    const preferredTrack = {
      stop: vi.fn(),
      readyState: 'live' as MediaStreamTrackState,
      addEventListener: vi.fn(),
      getSettings: vi.fn(() => ({ deviceId: 'preferred-mic' })),
    };
    const fallbackStream = { getTracks: () => [fallbackTrack] };
    const preferredStream = { getTracks: () => [preferredTrack] };
    const unavailable = Object.assign(new Error('missing'), { name: 'NotFoundError' });
    const getUserMedia = navigator.mediaDevices.getUserMedia as ReturnType<typeof vi.fn>;
    getUserMedia
      .mockRejectedValueOnce(unavailable)
      .mockResolvedValueOnce(fallbackStream)
      .mockResolvedValueOnce(preferredStream);
    env.sarahMock.getConfig.mockResolvedValue({
      audio: makeAudioConfig({ inputDeviceId: 'preferred-mic' }),
      controls: { voiceMode: 'push-to-talk' },
    });

    await bridge.start();
    expect(getUserMedia).toHaveBeenCalledTimes(2);

    (navigator.mediaDevices.enumerateDevices as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { kind: 'audioinput', deviceId: 'default-mic' },
    ]);
    env.deviceChangeListener?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(fallbackTrack.stop).not.toHaveBeenCalled();

    (navigator.mediaDevices.enumerateDevices as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { kind: 'audioinput', deviceId: 'default-mic' },
      { kind: 'audioinput', deviceId: 'preferred-mic' },
    ]);
    env.deviceChangeListener?.();

    await vi.waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(3));
    expect(fallbackTrack.stop).toHaveBeenCalledOnce();
    const internal = bridge as unknown as { activeInputDeviceId: string | undefined };
    expect(internal.activeInputDeviceId).toBe('preferred-mic');
  });

  // ── Path-B (setSinkId) playback routing ──
});
