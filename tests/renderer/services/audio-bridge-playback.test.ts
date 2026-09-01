import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  AudioBridge,
  audioTestEnvironment as env,
  createAudioBridgeTestFixture,
  makeAudioConfig,
} from './audio-bridge-test-harness.js';

describe('AudioBridge (playback)', () => {
  let fixture: ReturnType<typeof createAudioBridgeTestFixture>;
  let bridge: InstanceType<typeof AudioBridge>;

  beforeEach(() => {
    fixture = createAudioBridgeTestFixture();
    bridge = fixture.bridge;
  });

  afterEach(async () => {
    await bridge.destroy();
  });

it('reports a correlated playback failure instead of acknowledging success', async () => {
    // Without capture, playback AudioContext is the first one created
    env.captureCtxInstance.createBuffer.mockImplementation(() => {
      throw new Error('buffer creation failed');
    });

    await bridge.start();
    const correlation = fixture.playAudio([0.1]);

    await vi.waitFor(() => {
      expect(env.sarahVoiceMock.playbackFailed).toHaveBeenCalledWith(
        correlation.turnId,
        correlation.playbackId,
        expect.stringContaining('buffer creation failed'),
      );
    });
    expect(env.sarahVoiceMock.playbackDone).not.toHaveBeenCalledWith(
      correlation.turnId,
      correlation.playbackId,
    );
  });

  it('routes playback through <audio>.setSinkId when outputDeviceId is set', async () => {
    env.sarahMock.getConfig.mockResolvedValue({
      audio: makeAudioConfig({ outputDeviceId: 'out-a' }),
    });
    await bridge.start();

    fixture.playAudio([0.1, 0.2, 0.3]);

    await vi.waitFor(() => {
      expect(env.lastAudioEl).not.toBeNull();
      expect(env.lastAudioEl?.setSinkId).toHaveBeenCalled();
    });

    // No capture triggered — the playback ctx is ctx #1 (env.captureCtxInstance).
    // An <audio> element was created, wired to the MediaStreamDestination, and
    // its setSinkId was called with the configured device id.
    expect(env.lastAudioEl?.setSinkId).toHaveBeenCalledWith('out-a');
    expect(env.lastAudioEl?.autoplay).toBe(true);
    expect(env.lastAudioEl?.srcObject).toBe(env.captureCtxInstance._streamDest.stream);
  });

  it('falls back gracefully when setSinkId rejects', async () => {
    env.sarahMock.getConfig.mockResolvedValue({
      audio: makeAudioConfig({ outputDeviceId: 'out-a' }),
    });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    env.setSinkIdImpl = () => Promise.reject(new Error('invalid sink'));

    await bridge.start();
    fixture.playAudio([0.1, 0.2, 0.3]);

    await vi.waitFor(() => {
      expect(env.lastAudioEl).not.toBeNull();
      expect(env.lastAudioEl?.setSinkId).toHaveBeenCalled();
      // The catch handler must have run and warned.
      expect(warnSpy).toHaveBeenCalled();
    });

    // Fallback message format.
    const sinkWarnCalls = warnSpy.mock.calls.filter((c) =>
      typeof c[0] === 'string' && c[0].includes('setSinkId("out-a") failed/timed out'),
    );
    expect(sinkWarnCalls.length).toBeGreaterThanOrEqual(1);
    expect(env.lastAudioEl?.pause).toHaveBeenCalledOnce();
    expect(env.lastAudioEl?.srcObject).toBeNull();
    expect(env.lastAudioEl?.load).toHaveBeenCalledOnce();
    expect(env.captureCtxInstance._gainNode.disconnect).toHaveBeenCalled();
    expect(env.captureCtxInstance._gainNode.connect).toHaveBeenLastCalledWith(
      env.captureCtxInstance.destination,
    );

    warnSpy.mockRestore();
  });

  it('falls back to the default sink when setSinkId times out', async () => {
    vi.useFakeTimers();
    env.sarahMock.getConfig.mockResolvedValue({
      audio: makeAudioConfig({ outputDeviceId: 'out-timeout' }),
    });
    env.setSinkIdImpl = () => new Promise<void>(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await bridge.start();
    fixture.playAudio([0.1]);
    for (let i = 0; i < 8 && !env.lastAudioEl?.setSinkId.mock.calls.length; i += 1) {
      await Promise.resolve();
    }
    expect(env.lastAudioEl?.setSinkId).toHaveBeenCalledWith('out-timeout');

    await vi.advanceTimersByTimeAsync(2_000);
    expect(env.lastAudioEl?.pause).toHaveBeenCalledOnce();
    expect(env.lastAudioEl?.srcObject).toBeNull();
    expect(env.captureCtxInstance._gainNode.connect).toHaveBeenLastCalledWith(
      env.captureCtxInstance.destination,
    );
    warnSpy.mockRestore();
  });

  it('keeps a failed sink on the default path until a device change makes retry meaningful', async () => {
    env.sarahMock.getConfig.mockResolvedValue({
      audio: makeAudioConfig({ outputDeviceId: 'out-sticky' }),
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let sinkAttempts = 0;
    env.setSinkIdImpl = () => {
      sinkAttempts += 1;
      return sinkAttempts === 1
        ? Promise.reject(new Error('sink unavailable'))
        : Promise.resolve();
    };
    await bridge.start();

    fixture.playAudio([0.1]);
    await vi.waitFor(() => expect(fixture.totalBufferSourceCalls()).toBe(1));
    fixture.playAudio([0.2]);
    await vi.waitFor(() => expect(fixture.totalBufferSourceCalls()).toBe(2));
    expect(sinkAttempts).toBe(1);

    (navigator.mediaDevices.enumerateDevices as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { kind: 'audiooutput', deviceId: 'out-sticky' },
    ]);
    env.deviceChangeListener?.();
    await Promise.resolve();
    await Promise.resolve();

    fixture.playAudio([0.3]);
    await vi.waitFor(() => expect(sinkAttempts).toBe(2));
    expect(fixture.totalBufferSourceCalls()).toBe(3);
    warnSpy.mockRestore();
  });

  it('reports an active Path-B media error and suppresses its success ACK', async () => {
    env.sarahMock.getConfig.mockResolvedValue({
      audio: makeAudioConfig({ outputDeviceId: 'out-a' }),
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await bridge.start();
    const correlation = fixture.playAudio([0.1]);
    await vi.waitFor(() => expect(fixture.totalBufferSourceCalls()).toBe(1));
    const source = env.captureCtxInstance.createBufferSource.mock.results[0].value;
    if (env.lastAudioEl) env.lastAudioEl.error = { message: 'device disconnected' };
    env.lastAudioEl?._errorListeners[0]?.();

    await vi.waitFor(() => expect(env.sarahVoiceMock.playbackFailed).toHaveBeenCalledWith(
      correlation.turnId,
      correlation.playbackId,
      'device disconnected',
    ));
    expect(source.stop).toHaveBeenCalledOnce();
    expect(source.onended).toBeNull();
    expect(env.sarahVoiceMock.playbackDone).not.toHaveBeenCalledWith(
      correlation.turnId,
      correlation.playbackId,
    );
  });

  it('does not start stale playback after an async sink switch was interrupted', async () => {
    env.sarahMock.getConfig.mockResolvedValue({
      audio: makeAudioConfig({ outputDeviceId: 'out-a' }),
    });
    let resolveSink = (): void => {};
    env.setSinkIdImpl = () => new Promise<void>((resolve) => { resolveSink = resolve; });

    await bridge.start();
    const correlation = fixture.playAudio([0.1, 0.2, 0.3]);
    await vi.waitFor(() => expect(env.lastAudioEl?.setSinkId).toHaveBeenCalledWith('out-a'));

    fixture.stateChange({ state: 'listening' });
    resolveSink();

    await vi.waitFor(() => {
      const internal = bridge as unknown as {
        playbackStartControllers: Map<string, AbortController>;
      };
      expect(internal.playbackStartControllers.size).toBe(0);
    });
    expect(env.captureCtxInstance.createBufferSource).not.toHaveBeenCalled();
    expect(env.sarahVoiceMock.playbackDone).not.toHaveBeenCalledWith(
      correlation.turnId,
      correlation.playbackId,
    );
    expect(env.sarahVoiceMock.playbackFailed).not.toHaveBeenCalledWith(
      correlation.turnId,
      correlation.playbackId,
      expect.any(String),
    );
  });

  it('aborts a hung playback setup so a following playback is not blocked', async () => {
    env.captureCtxInstance.state = 'suspended';
    env.captureCtxInstance.resume.mockReturnValueOnce(new Promise<void>(() => {}));
    await bridge.start();

    const first = fixture.playAudio([0.1]);
    await vi.waitFor(() => expect(env.captureCtxInstance.resume).toHaveBeenCalledOnce());
    fixture.stopPlayback(first);
    env.captureCtxInstance.state = 'running';

    const second = fixture.playAudio([0.2]);
    await vi.waitFor(() => expect(fixture.totalBufferSourceCalls()).toBe(1));
    expect(env.sarahVoiceMock.playbackDone).not.toHaveBeenCalledWith(first.turnId, first.playbackId);
    expect(env.sarahVoiceMock.playbackFailed).not.toHaveBeenCalledWith(
      first.turnId,
      first.playbackId,
      expect.any(String),
    );
    expect(env.sarahVoiceMock.playbackFailed).not.toHaveBeenCalledWith(
      second.turnId,
      second.playbackId,
      expect.any(String),
    );
  });

  it('times out a hung playback setup and lets the serialized queue continue', async () => {
    vi.useFakeTimers();
    try {
      env.captureCtxInstance.state = 'suspended';
      env.captureCtxInstance.resume.mockReturnValueOnce(new Promise<void>(() => {}));
      await bridge.start();

      const first = fixture.playAudio([0.1]);
      await Promise.resolve();
      await Promise.resolve();
      expect(env.captureCtxInstance.resume).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(4_000);

      expect(env.sarahVoiceMock.playbackFailed).toHaveBeenCalledWith(
        first.turnId,
        first.playbackId,
        expect.stringContaining('timed out'),
      );

      env.captureCtxInstance.state = 'running';
      fixture.playAudio([0.2]);
      await vi.advanceTimersByTimeAsync(0);
      expect(fixture.totalBufferSourceCalls()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('flips Path A → Path B when outputDeviceId becomes set between utterances', async () => {
    // First utterance: no outputDeviceId → Path A (ctx.destination). Since we
    // never triggered capture, the playback AudioContext is ctx #1, which our
    // stub maps to env.captureCtxInstance.
    await bridge.start();
    fixture.playAudio([0.1]);

    await vi.waitFor(() => {
      expect(env.captureCtxInstance.createBufferSource).toHaveBeenCalled();
    });
    // No <audio> element on Path A.
    expect(env.lastAudioEl).toBeNull();
    // createMediaStreamDestination was NOT used on Path A.
    expect(env.captureCtxInstance.createMediaStreamDestination).not.toHaveBeenCalled();

    // Apply config — switch to a specific sink. Use the bridge directly so
    // we can await the apply to settle (the onAudioConfigChanged callback is
    // fire-and-forget, await'ing it returns immediately).
    await bridge.applyAudioConfig(makeAudioConfig({ outputDeviceId: 'out-b' }));

    // Second utterance: now Path B. Still same ctx (sampleRate unchanged).
    fixture.playAudio([0.1]);

    await vi.waitFor(() => {
      expect(env.lastAudioEl).not.toBeNull();
    });
    expect(env.lastAudioEl?.setSinkId).toHaveBeenCalledWith('out-b');
    // The same ctx (#1) is still live — createMediaStreamDestination is on it.
    const activeCtx = env.ctxCallCount === 1 ? env.captureCtxInstance :
                      env.ctxCallCount === 2 ? env.playbackCtxInstance :
                      env.extraCtxInstances[env.extraCtxInstances.length - 1];
    expect(activeCtx.createMediaStreamDestination).toHaveBeenCalled();
  });

  it('warns and uses default sink when setSinkId is unsupported', async () => {
    // Remove setSinkId from HTMLAudioElement.prototype so hasSetSinkIdSupport()
    // returns false on this run. Restore after the test.
    const origMockAudio = (globalThis as { Audio: typeof MockAudio }).Audio;
    const origProto = (origMockAudio as unknown as { prototype: Record<string, unknown> }).prototype;
    const protoCopy = { ...origProto };
    delete (protoCopy as { setSinkId?: unknown }).setSinkId;
    (origMockAudio as unknown as { prototype: Record<string, unknown> }).prototype = protoCopy;

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    env.sarahMock.getConfig.mockResolvedValue({
      audio: makeAudioConfig({ outputDeviceId: 'out-unsupported' }),
    });
    await bridge.start();
    fixture.playAudio([0.1]);

    // No capture was triggered — playback AudioContext is the first one, which
    // the stub maps to env.captureCtxInstance.
    await vi.waitFor(() => {
      expect(env.captureCtxInstance.createBufferSource).toHaveBeenCalled();
    });

    // No <audio> element — Path A fallback.
    expect(env.lastAudioEl).toBeNull();
    // Warning surfaced about unsupported setSinkId.
    const unsupportedWarns = warnSpy.mock.calls.filter(
      (c) => typeof c[0] === 'string' && c[0].includes('setSinkId unsupported'),
    );
    expect(unsupportedWarns.length).toBeGreaterThanOrEqual(1);

    // Restore original prototype
    (origMockAudio as unknown as { prototype: Record<string, unknown> }).prototype = origProto;
    warnSpy.mockRestore();
  });

  // ── stopPlayback / decay priming (C1) ──

  it('stopPlayback() with no active playback is a no-op', async () => {
    await bridge.start();
    // Directly invoke via state change to 'listening' — handleStateChange
    // calls stopPlayback() even without a playback in flight.
    expect(() => fixture.stateChange({ state: 'listening' })).not.toThrow();
  });

  it('stopPlayback() primes decay synchronously before onended fires', async () => {
    // Start, kick off a playback so a BufferSource is live. No capture here,
    // so the playback ctx is ctx #1 (env.captureCtxInstance).
    await bridge.start();
    fixture.playAudio([0.1, 0.2, 0.3]);

    await vi.waitFor(() => {
      expect(env.captureCtxInstance.createBufferSource).toHaveBeenCalled();
    });

    // Interrupt mid-playback via a state change to 'listening'. stopPlayback
    // must SYNCHRONOUSLY prime `outputPlaybackEndedAt`, not wait for onended.
    const bridgeInternal = bridge as unknown as {
      outputPlaybackEndedAt: number | null;
      currentPlaybackSource: { stop: ReturnType<typeof vi.fn>; onended: (() => void) | null } | null;
    };
    // Sanity: playback is in flight, decay not yet primed.
    expect(bridgeInternal.outputPlaybackEndedAt).toBeNull();

    fixture.stateChange({ state: 'listening' });

    // Decay timestamp must be set RIGHT NOW, before any async onended hop.
    expect(bridgeInternal.outputPlaybackEndedAt).not.toBeNull();
    expect(typeof bridgeInternal.outputPlaybackEndedAt).toBe('number');

    // BufferSource was stopped.
    const bufferSource = env.captureCtxInstance.createBufferSource.mock.results[0].value;
    expect(bufferSource.stop).toHaveBeenCalled();

    // onended (if it fires after) must not overwrite the earlier timestamp.
    const firstStamp = bridgeInternal.outputPlaybackEndedAt;
    bufferSource.onended?.();
    expect(bridgeInternal.outputPlaybackEndedAt).toBe(firstStamp);
  });

  it('stops only the correlated renderer playback and ignores a stale stop event', async () => {
    await bridge.start();
    const first = fixture.playAudio([0.1]);
    await vi.waitFor(() => expect(env.captureCtxInstance.createBufferSource).toHaveBeenCalledTimes(1));
    const firstSource = env.captureCtxInstance.createBufferSource.mock.results[0].value;

    fixture.stopPlayback(first);
    expect(firstSource.stop).toHaveBeenCalledOnce();

    const second = fixture.playAudio([0.2]);
    await vi.waitFor(() => expect(env.playbackCtxInstance.createBufferSource).toHaveBeenCalledOnce());
    const secondSource = env.playbackCtxInstance.createBufferSource.mock.results[0].value;

    fixture.stopPlayback(first);
    expect(secondSource.stop).not.toHaveBeenCalled();
    fixture.stopPlayback(second);
    expect(secondSource.stop).toHaveBeenCalledOnce();
  });
});
