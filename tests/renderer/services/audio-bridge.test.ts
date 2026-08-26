// tests/renderer/services/audio-bridge.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mock Browser APIs ──

function createMockAudioContext() {
  const workletAddModule = vi.fn().mockResolvedValue(undefined);
  const mockSourceNode = { connect: vi.fn(), disconnect: vi.fn() };
  const mockWorkletNode = {
    port: {
      onmessage: null as ((ev: MessageEvent) => void) | null,
      postMessage: vi.fn(),
    },
    connect: vi.fn(),
    disconnect: vi.fn(),
  };
  const gainParam = {
    value: 1,
    setTargetAtTime: vi.fn(),
  };
  // createGain is called for both capture AND output paths. Give every call
  // a fresh node so the test can reason about whichever branch it cares about.
  const makeGainNode = () => ({
    gain: { value: 1, setTargetAtTime: vi.fn() },
    connect: vi.fn(),
    disconnect: vi.fn(),
  });
  const mockGainNode = { gain: gainParam, connect: vi.fn(), disconnect: vi.fn() };
  const mockAnalyserNode = {
    fftSize: 256,
    connect: vi.fn(),
    disconnect: vi.fn(),
    getFloatTimeDomainData: vi.fn(),
  };
  const mockStreamDest = {
    stream: { id: 'mock-stream' },
    connect: vi.fn(),
    disconnect: vi.fn(),
  };

  let gainCallCount = 0;
  const createGainFn = vi.fn().mockImplementation(() => {
    gainCallCount++;
    // First createGain call on this ctx maps to the capture gain the existing
    // tests inspect. Subsequent calls (output gain) get a fresh isolated node.
    return gainCallCount === 1 ? mockGainNode : makeGainNode();
  });

  return {
    state: 'running' as string,
    sampleRate: 16_000,
    currentTime: 0,
    resume: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    audioWorklet: { addModule: workletAddModule },
    createMediaStreamSource: vi.fn().mockReturnValue(mockSourceNode),
    createGain: createGainFn,
    createAnalyser: vi.fn().mockReturnValue(mockAnalyserNode),
    createMediaStreamDestination: vi.fn().mockReturnValue(mockStreamDest),
    createBuffer: vi.fn().mockReturnValue({
      getChannelData: vi.fn().mockReturnValue(new Float32Array(100)),
    }),
    createBufferSource: vi.fn().mockImplementation(() => ({
      buffer: null,
      connect: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
      onended: null as (() => void) | null,
    })),
    destination: {},
    _sourceNode: mockSourceNode,
    _workletNode: mockWorkletNode,
    _gainNode: mockGainNode,
    _analyserNode: mockAnalyserNode,
    _streamDest: mockStreamDest,
    _workletAddModule: workletAddModule,
  };
}

type MockAudioCtx = ReturnType<typeof createMockAudioContext>;

interface AudioConfigFields {
  inputDeviceId?: string;
  outputDeviceId?: string;
  inputMuted: boolean;
  inputGain: number;
  inputVolume: number;
  outputVolume: number;
}

function makeAudioConfig(overrides: Partial<AudioConfigFields> = {}): AudioConfigFields {
  return {
    inputDeviceId: undefined,
    outputDeviceId: undefined,
    inputMuted: false,
    inputGain: 1.0,
    inputVolume: 1.0,
    outputVolume: 1.0,
    ...overrides,
  };
}

let trackEndedListeners: Array<() => void> = [];
const mockTrack = {
  stop: vi.fn(),
  readyState: 'live' as MediaStreamTrackState,
  addEventListener: vi.fn((event: string, listener: () => void) => {
    if (event === 'ended') trackEndedListeners.push(listener);
  }),
  getSettings: vi.fn(() => ({ deviceId: 'default-mic' })),
};
const mockStream = { getTracks: () => [mockTrack] };
const TEST_CAPTURE_ID = '33333333-3333-4333-8333-333333333333';

// ── Global stubs ──

let captureCtxInstance: MockAudioCtx;
let playbackCtxInstance: MockAudioCtx;
let extraCtxInstances: MockAudioCtx[] = [];
let ctxCallCount: number;

const sarahVoiceMock = {
  getState: vi.fn().mockResolvedValue({ state: 'idle' }),
  onStateChange: vi.fn().mockReturnValue(vi.fn()),
  onCaptureFlushRequest: vi.fn().mockReturnValue(vi.fn()),
  onPlayAudio: vi.fn().mockReturnValue(vi.fn()),
  onStopPlayback: vi.fn().mockReturnValue(vi.fn()),
  playbackDone: vi.fn().mockResolvedValue(undefined),
  playbackFailed: vi.fn().mockResolvedValue(undefined),
  onError: vi.fn().mockReturnValue(vi.fn()),
  onCapability: vi.fn().mockReturnValue(vi.fn()),
  sendAudioChunk: vi.fn().mockResolvedValue(undefined),
  captureFlushed: vi.fn().mockResolvedValue(undefined),
  captureFailed: vi.fn().mockResolvedValue(undefined),
  setCaptureReady: vi.fn().mockResolvedValue(undefined),
};

const sarahMock = {
  voice: sarahVoiceMock,
  getConfig: vi.fn().mockResolvedValue({ audio: makeAudioConfig() }),
  getRuntimeStatus: vi.fn().mockResolvedValue({
    state: 'ready',
    generation: 1,
    updatedAt: 1,
    capabilities: { stt: { state: 'ready' } },
  }),
  onAudioConfigChanged: vi.fn().mockReturnValue(vi.fn()),
  onVoiceInputConfigChanged: vi.fn().mockReturnValue(vi.fn()),
};

(globalThis as Record<string, unknown>).sarah = sarahMock;

// AudioContext must be a real constructor function (not arrow)
vi.stubGlobal('AudioContext', function MockAudioContext(this: Record<string, unknown>) {
  ctxCallCount++;
  let instance: MockAudioCtx;
  if (ctxCallCount === 1) {
    instance = captureCtxInstance;
  } else if (ctxCallCount === 2) {
    instance = playbackCtxInstance;
  } else {
    const extra = createMockAudioContext();
    extraCtxInstances.push(extra);
    instance = extra;
  }
  Object.assign(this, instance);
  return this;
});

// AudioWorkletNode must also be a constructor
vi.stubGlobal('AudioWorkletNode', function MockAudioWorkletNode(this: Record<string, unknown>) {
  Object.assign(this, captureCtxInstance._workletNode);
  return this;
});

let deviceChangeListener: (() => void) | null = null;

vi.stubGlobal('navigator', {
  mediaDevices: {
    getUserMedia: vi.fn().mockResolvedValue(mockStream),
    enumerateDevices: vi.fn().mockResolvedValue([]),
    addEventListener: vi.fn((event: string, listener: () => void) => {
      if (event === 'devicechange') deviceChangeListener = listener;
    }),
    removeEventListener: vi.fn((event: string, listener: () => void) => {
      if (event === 'devicechange' && deviceChangeListener === listener) {
        deviceChangeListener = null;
      }
    }),
  },
});

// ── <audio> element mock for Path-B (setSinkId) tests ──
//
// Node's test env has no DOM, so we expose a bare-bones HTMLAudioElement
// constructor with the surface the AudioBridge touches: srcObject, autoplay,
// pause, load, addEventListener('error'), and a `setSinkId` mock on the
// prototype so feature detection sees it.

interface MockAudioEl {
  autoplay: boolean;
  srcObject: unknown;
  error: { message: string } | null;
  pause: ReturnType<typeof vi.fn>;
  load: ReturnType<typeof vi.fn>;
  addEventListener: ReturnType<typeof vi.fn>;
  setSinkId: ReturnType<typeof vi.fn>;
  _errorListeners: Array<() => void>;
}

let lastAudioEl: MockAudioEl | null = null;
const audioElInstances: MockAudioEl[] = [];

/** setSinkId implementation injected per test. Reset in beforeEach. */
let setSinkIdImpl: (sinkId: string) => Promise<void> = () => Promise.resolve();

function populateMockAudioEl(target: Record<string, unknown>): MockAudioEl {
  const listeners: Array<() => void> = [];
  const addEventListener = vi.fn((evt: string, cb: () => void) => {
    if (evt === 'error') listeners.push(cb);
  });
  target.autoplay = false;
  target.srcObject = null;
  target.error = null;
  target.pause = vi.fn();
  target.load = vi.fn();
  target.addEventListener = addEventListener;
  target.setSinkId = vi.fn((sinkId: string) => setSinkIdImpl(sinkId));
  target._errorListeners = listeners;
  return target as unknown as MockAudioEl;
}

function MockAudio(this: Record<string, unknown>) {
  const el = populateMockAudioEl(this);
  audioElInstances.push(el);
  lastAudioEl = el;
  return this;
}
// Expose setSinkId on the prototype so `'setSinkId' in HTMLAudioElement.prototype`
// returns true for the feature-detect helper in audio-bridge.
(MockAudio as unknown as { prototype: Record<string, unknown> }).prototype = {
  setSinkId: function stubSetSinkId() {
    return Promise.resolve();
  },
};

vi.stubGlobal('Audio', MockAudio);
vi.stubGlobal('HTMLAudioElement', MockAudio);

// Must import AFTER globals are set up
const { AudioBridge } = await import('../../../src/renderer/services/audio-bridge.js');

describe('AudioBridge', () => {
  let bridge: InstanceType<typeof AudioBridge>;
  let stateChangeCb: (data: { state: string; captureId?: string }) => void;
  let captureFlushCb: (data: { captureId: string }) => void;
  let playAudioCb: (data: { turnId: string; playbackId: string; audio: number[]; sampleRate: number }) => void;
  let stopPlaybackCb: (data: { turnId: string; playbackId: string }) => void;
  let capabilityCb: (data: { stt: boolean; tts: boolean }) => void;
  let voiceInputConfigCb: (data: { voiceMode: 'off' | 'push-to-talk' | 'keyword' }) => void;
  let playbackNumber = 0;

  function playAudio(audio: number[], sampleRate = 22_050): { turnId: string; playbackId: string } {
    playbackNumber += 1;
    const correlation = {
      turnId: '11111111-1111-4111-8111-111111111111',
      playbackId: `22222222-2222-4222-8222-${String(playbackNumber).padStart(12, '0')}`,
    };
    playAudioCb({ ...correlation, audio, sampleRate });
    return correlation;
  }

  function totalBufferSourceCalls(): number {
    return [captureCtxInstance, playbackCtxInstance, ...extraCtxInstances]
      .reduce((total, context) => total + context.createBufferSource.mock.calls.length, 0);
  }

  let audioCfgCb: (audio: AudioConfigFields) => void;

  beforeEach(() => {
    vi.clearAllMocks();
    ctxCallCount = 0;
    extraCtxInstances = [];
    captureCtxInstance = createMockAudioContext();
    playbackCtxInstance = createMockAudioContext();
    mockTrack.stop.mockClear();
    mockTrack.readyState = 'live';
    trackEndedListeners = [];
    deviceChangeListener = null;
    audioElInstances.length = 0;
    lastAudioEl = null;
    playbackNumber = 0;
    setSinkIdImpl = () => Promise.resolve();

    sarahVoiceMock.getState.mockResolvedValue({ state: 'idle' });
    sarahVoiceMock.onStateChange.mockImplementation((cb: (data: { state: string; captureId?: string }) => void) => {
      stateChangeCb = (data) => cb(
        data.state === 'listening' && !data.captureId
          ? { ...data, captureId: TEST_CAPTURE_ID }
          : data,
      );
      return vi.fn();
    });
    sarahVoiceMock.onPlayAudio.mockImplementation((cb: (data: { turnId: string; playbackId: string; audio: number[]; sampleRate: number }) => void) => {
      playAudioCb = cb;
      return vi.fn();
    });
    sarahVoiceMock.onCaptureFlushRequest.mockImplementation((cb: (data: { captureId: string }) => void) => {
      captureFlushCb = cb;
      return vi.fn();
    });
    sarahVoiceMock.onStopPlayback.mockImplementation((cb: (data: { turnId: string; playbackId: string }) => void) => {
      stopPlaybackCb = cb;
      return vi.fn();
    });
    sarahVoiceMock.onCapability.mockImplementation((cb: (data: { stt: boolean; tts: boolean }) => void) => {
      capabilityCb = cb;
      return vi.fn();
    });
    (navigator.mediaDevices.getUserMedia as ReturnType<typeof vi.fn>).mockResolvedValue(mockStream);
    (navigator.mediaDevices.enumerateDevices as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    sarahMock.getConfig.mockResolvedValue({ audio: makeAudioConfig() });
    sarahMock.onAudioConfigChanged.mockImplementation((cb: (audio: AudioConfigFields) => void) => {
      audioCfgCb = cb;
      return vi.fn();
    });
    sarahMock.onVoiceInputConfigChanged.mockImplementation((cb: (data: { voiceMode: 'off' | 'push-to-talk' | 'keyword' }) => void) => {
      voiceInputConfigCb = cb;
      return vi.fn();
    });

    bridge = new AudioBridge();
  });

  afterEach(async () => {
    await bridge.destroy();
  });

  it('registers state and playAudio listeners on start', async () => {
    await bridge.start();
    expect(sarahVoiceMock.onStateChange).toHaveBeenCalledOnce();
    expect(sarahVoiceMock.onPlayAudio).toHaveBeenCalledOnce();
    expect(sarahVoiceMock.onStopPlayback).toHaveBeenCalledOnce();
    expect(sarahVoiceMock.onCaptureFlushRequest).toHaveBeenCalledOnce();
    expect(sarahVoiceMock.getState).toHaveBeenCalledOnce();
  });

  it('starts capture when state changes to listening', async () => {
    await bridge.start();
    stateChangeCb({ state: 'listening' });

    await vi.waitFor(() => {
      expect((navigator.mediaDevices.getUserMedia as ReturnType<typeof vi.fn>)).toHaveBeenCalledOnce();
    });
  });

  it('keeps the mic warm when state changes from listening to processing', async () => {
    await bridge.start();
    stateChangeCb({ state: 'listening' });

    await vi.waitFor(() => {
      expect((navigator.mediaDevices.getUserMedia as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
    });

    stateChangeCb({ state: 'processing' });

    // Mic graph stays warm across the utterance boundary — the stream is NOT
    // torn down, only `recording` flips off. Re-acquisition latency was the
    // root cause of clipped sentence starts.
    expect(mockTrack.stop).not.toHaveBeenCalled();
    const internal = bridge as unknown as { recording: boolean; capturing: boolean };
    expect(internal.recording).toBe(false);
    expect(internal.capturing).toBe(true);
  });

  it('warms capture on start() when voiceMode is push-to-talk, before any state change', async () => {
    sarahMock.getConfig.mockResolvedValue({
      audio: makeAudioConfig(),
      controls: { voiceMode: 'push-to-talk' },
    });

    await bridge.start();

    // Warm-on-start acquires the mic and builds the gain graph up front — with
    // NO 'listening' state change having fired yet.
    await vi.waitFor(() => {
      expect((navigator.mediaDevices.getUserMedia as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
      expect(captureCtxInstance.createGain).toHaveBeenCalled();
    });
    const internal = bridge as unknown as { recording: boolean; capturing: boolean };
    expect(internal.capturing).toBe(true);
    // Warming is not recording — nothing streamed to main until 'listening'.
    expect(internal.recording).toBe(false);
    expect(sarahVoiceMock.sendAudioChunk).not.toHaveBeenCalled();
  });

  it('does not re-acquire the mic across listening → idle → listening cycles', async () => {
    await bridge.start();

    const getUserMediaMock = navigator.mediaDevices.getUserMedia as ReturnType<typeof vi.fn>;

    stateChangeCb({ state: 'listening' });
    await vi.waitFor(() => {
      expect(getUserMediaMock).toHaveBeenCalled();
    });

    stateChangeCb({ state: 'idle' });
    stateChangeCb({ state: 'listening' });
    // Give any (unwanted) re-acquisition a tick to show up.
    await Promise.resolve();

    // Mic stayed warm — acquired exactly once for both cycles.
    expect(getUserMediaMock).toHaveBeenCalledOnce();
  });

  it('discards warm-mic chunks from before PTT instead of assigning them to the new turn', async () => {
    // Warm-on-start so the capture worklet exists before any 'listening'.
    sarahMock.getConfig.mockResolvedValue({
      audio: makeAudioConfig(),
      controls: { voiceMode: 'push-to-talk' },
    });
    await bridge.start();

    await vi.waitFor(() => {
      expect(captureCtxInstance._workletNode.port.onmessage).not.toBeNull();
    });

    const port = captureCtxInstance._workletNode.port;

    // A chunk arrives while warm but NOT recording (state still idle): it must
    // be discarded, not streamed or retained for a later capture.
    // Use exactly Float32-representable values so the round-trip is lossless.
    port.onmessage?.({ data: {
      type: 'chunk', captureId: TEST_CAPTURE_ID, samples: new Float32Array([0.5, 0.25]),
    } } as MessageEvent);
    expect(sarahVoiceMock.sendAudioChunk).not.toHaveBeenCalled();

    // On 'listening', pre-key audio remains outside the new PTT capture.
    stateChangeCb({ state: 'listening' });
    expect(sarahVoiceMock.sendAudioChunk).not.toHaveBeenCalled();
  });

  it('closes and rewarms the mic when voice mode or STT capability changes', async () => {
    sarahMock.getConfig.mockResolvedValue({
      audio: makeAudioConfig(),
      controls: { voiceMode: 'push-to-talk' },
    });
    await bridge.start();

    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledOnce();
    expect(sarahVoiceMock.setCaptureReady).toHaveBeenLastCalledWith(true);

    voiceInputConfigCb({ voiceMode: 'off' });
    const internal = bridge as unknown as { captureLifecyclePromise: Promise<void> };
    await internal.captureLifecyclePromise;
    expect(mockTrack.stop).toHaveBeenCalled();
    expect(sarahVoiceMock.setCaptureReady).toHaveBeenLastCalledWith(false);

    voiceInputConfigCb({ voiceMode: 'push-to-talk' });
    await internal.captureLifecyclePromise;
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(2);
    expect(sarahVoiceMock.setCaptureReady).toHaveBeenLastCalledWith(true);

    capabilityCb({ stt: false, tts: true });
    await internal.captureLifecyclePromise;
    expect(sarahVoiceMock.setCaptureReady).toHaveBeenLastCalledWith(false);

    capabilityCb({ stt: true, tts: true });
    await internal.captureLifecyclePromise;
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(3);
    expect(sarahVoiceMock.setCaptureReady).toHaveBeenLastCalledWith(true);
  });

  it('times out a hung microphone setup and can warm successfully on retry', async () => {
    vi.useFakeTimers();
    try {
      sarahMock.getConfig.mockResolvedValue({
        audio: makeAudioConfig(),
        controls: { voiceMode: 'push-to-talk' },
      });
      const getUserMedia = navigator.mediaDevices.getUserMedia as ReturnType<typeof vi.fn>;
      getUserMedia.mockReturnValueOnce(new Promise<MediaStream>(() => {}));

      const starting = bridge.start();
      await vi.advanceTimersByTimeAsync(10_000);
      await starting;

      expect(sarahVoiceMock.captureFailed).toHaveBeenCalledWith(
        undefined,
        expect.stringContaining('Mikrofon konnte nicht gestartet werden'),
      );
      expect(sarahVoiceMock.setCaptureReady).toHaveBeenLastCalledWith(false);

      getUserMedia.mockResolvedValueOnce(mockStream);
      capabilityCb({ stt: false, tts: true });
      capabilityCb({ stt: true, tts: true });
      const internal = bridge as unknown as { captureLifecyclePromise: Promise<void> };
      await internal.captureLifecyclePromise;

      expect(getUserMedia).toHaveBeenCalledTimes(2);
      expect(sarahVoiceMock.setCaptureReady).toHaveBeenLastCalledWith(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('self-retries a transient initial capture failure with bounded backoff', async () => {
    vi.useFakeTimers();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      sarahMock.getConfig.mockResolvedValue({
        audio: makeAudioConfig(),
        controls: { voiceMode: 'push-to-talk' },
      });
      const transient = new Error('temporary device failure');
      const getUserMedia = navigator.mediaDevices.getUserMedia as ReturnType<typeof vi.fn>;
      getUserMedia.mockRejectedValueOnce(transient).mockResolvedValueOnce(mockStream);

      await bridge.start();
      expect(getUserMedia).toHaveBeenCalledOnce();
      expect(sarahVoiceMock.setCaptureReady).toHaveBeenLastCalledWith(false);

      await vi.advanceTimersByTimeAsync(250);
      const internal = bridge as unknown as { captureLifecyclePromise: Promise<void> };
      await internal.captureLifecyclePromise;

      expect(getUserMedia).toHaveBeenCalledTimes(2);
      expect(sarahVoiceMock.setCaptureReady).toHaveBeenLastCalledWith(true);
    } finally {
      errorSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('stops self-retrying after the bounded capture backoff budget is exhausted', async () => {
    vi.useFakeTimers();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      sarahMock.getConfig.mockResolvedValue({
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
    sarahMock.getConfig.mockReturnValueOnce(new Promise((resolve) => {
      resolveConfig = resolve;
    }));
    sarahMock.getRuntimeStatus.mockReturnValueOnce(new Promise((resolve) => {
      resolveRuntime = resolve;
    }));

    const starting = bridge.start();
    voiceInputConfigCb({ voiceMode: 'off' });
    capabilityCb({ stt: false, tts: true });
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
    expect(sarahVoiceMock.setCaptureReady).toHaveBeenLastCalledWith(false);
  });

  it('terminates capture setup when AudioContext resume hangs', async () => {
    vi.useFakeTimers();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      sarahMock.getConfig.mockResolvedValue({
        audio: makeAudioConfig(),
        controls: { voiceMode: 'push-to-talk' },
      });
      captureCtxInstance.state = 'suspended';
      captureCtxInstance.resume.mockReturnValueOnce(new Promise<void>(() => {}));

      const starting = bridge.start();
      await vi.advanceTimersByTimeAsync(3_000);
      await starting;

      expect(sarahVoiceMock.captureFailed).toHaveBeenCalledWith(
        undefined,
        expect.stringContaining('Mikrofon konnte nicht gestartet werden'),
      );
      expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
      expect(sarahVoiceMock.setCaptureReady).toHaveBeenLastCalledWith(false);
    } finally {
      errorSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('terminates capture setup when AudioWorklet loading hangs', async () => {
    vi.useFakeTimers();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      sarahMock.getConfig.mockResolvedValue({
        audio: makeAudioConfig(),
        controls: { voiceMode: 'push-to-talk' },
      });
      captureCtxInstance._workletAddModule.mockReturnValueOnce(new Promise<void>(() => {}));

      const starting = bridge.start();
      await vi.advanceTimersByTimeAsync(5_000);
      await starting;

      expect(sarahVoiceMock.captureFailed).toHaveBeenCalledWith(
        undefined,
        expect.stringContaining('Mikrofon konnte nicht gestartet werden'),
      );
      expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
      expect(sarahVoiceMock.setCaptureReady).toHaveBeenLastCalledWith(false);
    } finally {
      errorSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('keeps all idle audio outside both the current and next utterance', async () => {
    sarahMock.getConfig.mockResolvedValue({
      audio: makeAudioConfig(),
      controls: { voiceMode: 'push-to-talk' },
    });
    sarahMock.onVoiceInputConfigChanged.mockImplementation((cb: (data: { voiceMode: 'off' | 'push-to-talk' | 'keyword' }) => void) => {
      voiceInputConfigCb = cb;
      return vi.fn();
    });
    await bridge.start();
    await vi.waitFor(() => expect(captureCtxInstance._workletNode.port.onmessage).not.toBeNull());

    const port = captureCtxInstance._workletNode.port;
    port.onmessage?.({ data: {
      type: 'chunk', captureId: TEST_CAPTURE_ID, samples: new Float32Array([0.25]),
    } } as MessageEvent);
    stateChangeCb({ state: 'listening', captureId: TEST_CAPTURE_ID });
    port.onmessage?.({ data: {
      type: 'chunk', captureId: TEST_CAPTURE_ID, samples: new Float32Array([0.5]),
    } } as MessageEvent);
    stateChangeCb({ state: 'processing' });
    port.onmessage?.({ data: {
      type: 'chunk', captureId: TEST_CAPTURE_ID, samples: new Float32Array([0.75]),
    } } as MessageEvent);

    const nextCaptureId = '44444444-4444-4444-8444-444444444444';
    stateChangeCb({ state: 'listening', captureId: nextCaptureId });

    await vi.waitFor(() => {
      expect(sarahVoiceMock.sendAudioChunk.mock.calls).toEqual([
        [TEST_CAPTURE_ID, [0.5]],
      ]);
    });
  });

  it('does not leak muted or pre-key samples across the unmute/PTT boundary', async () => {
    sarahMock.getConfig.mockResolvedValue({
      audio: makeAudioConfig({ inputMuted: true }),
      controls: { voiceMode: 'push-to-talk' },
    });
    await bridge.start();
    const port = captureCtxInstance._workletNode.port;

    port.onmessage?.({ data: {
      type: 'chunk', captureId: TEST_CAPTURE_ID, samples: new Float32Array([0.25]),
    } } as MessageEvent);
    await bridge.applyAudioConfig(makeAudioConfig({ inputMuted: false }));
    stateChangeCb({ state: 'listening', captureId: TEST_CAPTURE_ID });
    port.onmessage?.({ data: {
      type: 'chunk', captureId: TEST_CAPTURE_ID, samples: new Float32Array([0.5]),
    } } as MessageEvent);

    await vi.waitFor(() => {
      expect(sarahVoiceMock.sendAudioChunk.mock.calls).toEqual([
        [TEST_CAPTURE_ID, [0.5]],
      ]);
    });
  });

  it('uses the captureId returned by getState when the dashboard starts mid-capture', async () => {
    const captureId = '55555555-5555-4555-8555-555555555555';
    sarahVoiceMock.getState.mockResolvedValue({ state: 'listening', captureId });

    await bridge.start();
    await vi.waitFor(() => expect(captureCtxInstance._workletNode.port.onmessage).not.toBeNull());
    captureCtxInstance._workletNode.port.onmessage?.({
      data: { type: 'chunk', captureId, samples: new Float32Array([0.5]) },
    } as MessageEvent);

    await vi.waitFor(() => {
      expect(sarahVoiceMock.sendAudioChunk).toHaveBeenCalledWith(captureId, [0.5]);
    });
  });

  it('acknowledges a capture flush only after its final chunk reached main', async () => {
    let releaseChunk: (() => void) | null = null;
    sarahVoiceMock.sendAudioChunk.mockImplementationOnce(() => new Promise<void>((resolve) => {
      releaseChunk = resolve;
    }));
    sarahMock.getConfig.mockResolvedValue({
      audio: makeAudioConfig(),
      controls: { voiceMode: 'push-to-talk' },
    });
    await bridge.start();
    await vi.waitFor(() => {
      expect(captureCtxInstance._workletNode.port.onmessage).not.toBeNull();
    });
    stateChangeCb({ state: 'listening', captureId: TEST_CAPTURE_ID });
    const port = captureCtxInstance._workletNode.port;

    expect(port.postMessage).toHaveBeenCalledWith({
      type: 'begin', captureId: TEST_CAPTURE_ID,
    });
    captureFlushCb({ captureId: TEST_CAPTURE_ID });
    expect(port.postMessage).toHaveBeenCalledWith({
      type: 'flush', captureId: TEST_CAPTURE_ID,
    });
    port.onmessage?.({
      data: {
        type: 'chunk', captureId: TEST_CAPTURE_ID, samples: new Float32Array([0.75]),
      },
    } as MessageEvent);
    port.onmessage?.({
      data: { type: 'flushed', captureId: TEST_CAPTURE_ID },
    } as MessageEvent);

    await Promise.resolve();
    expect(sarahVoiceMock.captureFlushed).not.toHaveBeenCalled();
    releaseChunk?.();
    await vi.waitFor(() => {
      expect(sarahVoiceMock.captureFlushed).toHaveBeenCalledWith(TEST_CAPTURE_ID);
    });
  });

  it('reports a correlated failure instead of acknowledging when the worklet disappeared', async () => {
    sarahMock.getConfig.mockResolvedValue({
      audio: makeAudioConfig(),
      controls: { voiceMode: 'push-to-talk' },
    });
    await bridge.start();
    stateChangeCb({ state: 'listening', captureId: TEST_CAPTURE_ID });
    (bridge as unknown as { stopCapture(): void }).stopCapture();

    captureFlushCb({ captureId: TEST_CAPTURE_ID });

    await vi.waitFor(() => {
      expect(sarahVoiceMock.captureFailed).toHaveBeenCalledWith(
        TEST_CAPTURE_ID,
        expect.stringContaining('Mikrofonverbindung wurde unterbrochen'),
      );
    });
    expect(sarahVoiceMock.captureFlushed).not.toHaveBeenCalled();
  });

  it('cancels worklet state and releases IPC-tail ownership on a non-flush terminal state', async () => {
    let rejectChunk: ((reason: Error) => void) | null = null;
    sarahVoiceMock.sendAudioChunk.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => {
      rejectChunk = reject;
    }));
    sarahMock.getConfig.mockResolvedValue({
      audio: makeAudioConfig(),
      controls: { voiceMode: 'push-to-talk' },
    });
    await bridge.start();
    stateChangeCb({ state: 'listening', captureId: TEST_CAPTURE_ID });
    const port = captureCtxInstance._workletNode.port;
    port.onmessage?.({
      data: {
        type: 'chunk', captureId: TEST_CAPTURE_ID, samples: new Float32Array([0.5]),
      },
    } as MessageEvent);
    await Promise.resolve();

    stateChangeCb({ state: 'idle' });

    expect(port.postMessage).toHaveBeenCalledWith({
      type: 'cancel', captureId: TEST_CAPTURE_ID,
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

    stateChangeCb({ state: 'listening', captureId: TEST_CAPTURE_ID });

    await vi.waitFor(() => {
      expect(sarahVoiceMock.captureFailed).toHaveBeenCalledWith(
        TEST_CAPTURE_ID,
        expect.stringContaining('Mikrofon konnte nicht gestartet werden'),
      );
    });
    const internal = bridge as unknown as { recording: boolean; currentCaptureId: string | null };
    expect(internal.recording).toBe(false);
    expect(internal.currentCaptureId).toBeNull();
  });

  it('fails an active capture and reinitializes the warm mic when its track ends', async () => {
    sarahMock.getConfig.mockResolvedValue({
      audio: makeAudioConfig(),
      controls: { voiceMode: 'push-to-talk' },
    });
    await bridge.start();
    await vi.waitFor(() => expect(trackEndedListeners).toHaveLength(1));

    stateChangeCb({ state: 'listening', captureId: TEST_CAPTURE_ID });
    trackEndedListeners[0]();

    await vi.waitFor(() => {
      expect(sarahVoiceMock.captureFailed).toHaveBeenCalledWith(
        TEST_CAPTURE_ID,
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
      sarahMock.getConfig.mockResolvedValue({
        audio: makeAudioConfig(),
        controls: { voiceMode: 'push-to-talk' },
      });
      await bridge.start();
      expect(trackEndedListeners).toHaveLength(1);
      (navigator.mediaDevices.getUserMedia as ReturnType<typeof vi.fn>)
        .mockRejectedValueOnce(new Error('temporary device outage'));

      trackEndedListeners[0]();
      await vi.waitFor(() => {
        expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(2);
      });
      expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(250);
      await vi.waitFor(() => {
        expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(3);
      });
      expect(sarahVoiceMock.setCaptureReady).toHaveBeenLastCalledWith(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('coalesces a second track loss during recovery and waits for a live replacement', async () => {
    sarahMock.getConfig.mockResolvedValue({
      audio: makeAudioConfig(),
      controls: { voiceMode: 'push-to-talk' },
    });
    await bridge.start();
    expect(trackEndedListeners).toHaveLength(1);

    const endedDuringSetupTrack = {
      stop: vi.fn(),
      readyState: 'ended' as MediaStreamTrackState,
      getSettings: vi.fn(() => ({ deviceId: 'failed-replacement' })),
      addEventListener: vi.fn((event: string, listener: () => void) => {
        if (event === 'ended') listener();
      }),
    };
    const endedDuringSetupStream = { getTracks: () => [endedDuringSetupTrack] };
    let releaseLiveReplacement: ((stream: typeof mockStream) => void) | null = null;
    const liveReplacement = new Promise<typeof mockStream>((resolve) => {
      releaseLiveReplacement = resolve;
    });
    (navigator.mediaDevices.getUserMedia as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(endedDuringSetupStream)
      .mockReturnValueOnce(liveReplacement);

    trackEndedListeners[0]();
    await vi.waitFor(() => {
      expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(3);
    });
    expect(sarahVoiceMock.setCaptureReady).toHaveBeenLastCalledWith(false);

    releaseLiveReplacement?.(mockStream);
    await vi.waitFor(() => {
      expect(sarahVoiceMock.setCaptureReady).toHaveBeenLastCalledWith(true);
    });
  });

  it('fails and rebuilds an active capture when its selected input disappears', async () => {
    sarahMock.getConfig.mockResolvedValue({
      audio: makeAudioConfig({ inputDeviceId: 'mic-a' }),
      controls: { voiceMode: 'push-to-talk' },
    });
    await bridge.start();
    await vi.waitFor(() => expect(deviceChangeListener).not.toBeNull());
    stateChangeCb({ state: 'listening', captureId: TEST_CAPTURE_ID });

    (navigator.mediaDevices.enumerateDevices as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([]);
    deviceChangeListener?.();

    await vi.waitFor(() => {
      expect(sarahVoiceMock.captureFailed).toHaveBeenCalledWith(
        TEST_CAPTURE_ID,
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
    sarahMock.getConfig.mockResolvedValue({
      audio: makeAudioConfig({ inputDeviceId: 'mic-a' }),
    });

    await bridge.start();
    stateChangeCb({ state: 'listening', captureId: TEST_CAPTURE_ID });
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
    stateChangeCb({ state: 'listening' });
    await vi.waitFor(() => {
      expect((navigator.mediaDevices.getUserMedia as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
    });

    // Trigger playback to create playbackCtx
    playAudio([0.1, 0.2, 0.3]);
    await vi.waitFor(() => {
      expect(ctxCallCount).toBe(2);
    });

    await bridge.destroy();

    expect(captureCtxInstance.close).toHaveBeenCalledOnce();
    expect(playbackCtxInstance.close).toHaveBeenCalledOnce();
  });

  it('cancels active worklet state and releases IPC tails during destroy', async () => {
    let rejectChunk: ((reason: Error) => void) | null = null;
    sarahVoiceMock.sendAudioChunk.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => {
      rejectChunk = reject;
    }));
    sarahMock.getConfig.mockResolvedValue({
      audio: makeAudioConfig(),
      controls: { voiceMode: 'push-to-talk' },
    });
    await bridge.start();
    stateChangeCb({ state: 'listening', captureId: TEST_CAPTURE_ID });
    const port = captureCtxInstance._workletNode.port;
    port.onmessage?.({
      data: {
        type: 'chunk', captureId: TEST_CAPTURE_ID, samples: new Float32Array([0.25]),
      },
    } as MessageEvent);
    await Promise.resolve();

    await bridge.destroy();

    expect(port.postMessage).toHaveBeenCalledWith({
      type: 'cancel', captureId: TEST_CAPTURE_ID,
    });
    const internal = bridge as unknown as { captureIpcTails: Map<string, Promise<void>> };
    expect(internal.captureIpcTails.size).toBe(0);

    rejectChunk?.(new Error('renderer IPC closed'));
    await Promise.resolve();
    await Promise.resolve();
  });

  it('reports a correlated playback failure instead of acknowledging success', async () => {
    // Without capture, playback AudioContext is the first one created
    captureCtxInstance.createBuffer.mockImplementation(() => {
      throw new Error('buffer creation failed');
    });

    await bridge.start();
    const correlation = playAudio([0.1]);

    await vi.waitFor(() => {
      expect(sarahVoiceMock.playbackFailed).toHaveBeenCalledWith(
        correlation.turnId,
        correlation.playbackId,
        expect.stringContaining('buffer creation failed'),
      );
    });
    expect(sarahVoiceMock.playbackDone).not.toHaveBeenCalledWith(
      correlation.turnId,
      correlation.playbackId,
    );
  });

  it('inserts a GainNode between source and worklet on capture', async () => {
    sarahMock.getConfig.mockResolvedValue({
      audio: makeAudioConfig({ inputGain: 1.2, inputVolume: 0.5 }),
    });
    await bridge.start();
    stateChangeCb({ state: 'listening' });

    await vi.waitFor(() => {
      expect(captureCtxInstance.createGain).toHaveBeenCalledOnce();
    });

    // source → gain, gain → worklet, worklet → destination
    expect(captureCtxInstance._sourceNode.connect).toHaveBeenCalledWith(captureCtxInstance._gainNode);
    expect(captureCtxInstance._gainNode.connect).toHaveBeenCalledWith(captureCtxInstance._workletNode);
    // GainNode seeded with effective gain (1.2 * 0.5 = 0.6)
    expect(captureCtxInstance._gainNode.gain.value).toBeCloseTo(0.6);
  });

  it('short-circuits IPC send when muted', async () => {
    sarahMock.getConfig.mockResolvedValue({
      audio: makeAudioConfig({ inputMuted: true }),
    });
    await bridge.start();
    stateChangeCb({ state: 'listening' });

    await vi.waitFor(() => {
      expect(captureCtxInstance._workletNode.port.onmessage).not.toBeNull();
    });

    // Simulate worklet posting samples — mute should drop them
    const port = captureCtxInstance._workletNode.port;
    const samples = new Float32Array([0, 0, 0]);
    port.onmessage?.({ data: { type: 'chunk', captureId: TEST_CAPTURE_ID, samples } } as MessageEvent);
    expect(sarahVoiceMock.sendAudioChunk).not.toHaveBeenCalled();
  });

  it('forwards IPC chunks when not muted', async () => {
    await bridge.start();
    stateChangeCb({ state: 'listening' });

    await vi.waitFor(() => {
      expect(captureCtxInstance._workletNode.port.onmessage).not.toBeNull();
    });

    const port = captureCtxInstance._workletNode.port;
    const samples = new Float32Array([0.1, 0.2]);
    port.onmessage?.({ data: { type: 'chunk', captureId: TEST_CAPTURE_ID, samples } } as MessageEvent);
    await vi.waitFor(() => {
      expect(sarahVoiceMock.sendAudioChunk).toHaveBeenCalledOnce();
    });
  });

  it('ramps gain via setTargetAtTime on config change', async () => {
    await bridge.start();
    stateChangeCb({ state: 'listening' });

    await vi.waitFor(() => {
      expect(captureCtxInstance.createGain).toHaveBeenCalled();
    });

    const setTargetAtTime = captureCtxInstance._gainNode.gain.setTargetAtTime;
    setTargetAtTime.mockClear();

    await audioCfgCb(makeAudioConfig({ inputGain: 1.5, inputVolume: 0.8 }));

    // 1.5 * 0.8 = 1.2 at the mocked currentTime (0) with 15ms constant
    expect(setTargetAtTime).toHaveBeenCalledTimes(1);
    const [target, atTime, tc] = setTargetAtTime.mock.calls[0];
    expect(target).toBeCloseTo(1.2);
    expect(atTime).toBe(0);
    expect(tc).toBe(0.015);
  });

  it('is idempotent when audio config is unchanged', async () => {
    const cfg = makeAudioConfig({ inputGain: 1.1 });
    sarahMock.getConfig.mockResolvedValue({ audio: cfg });
    await bridge.start();
    stateChangeCb({ state: 'listening' });

    await vi.waitFor(() => {
      expect(captureCtxInstance.createGain).toHaveBeenCalled();
    });

    const setTargetAtTime = captureCtxInstance._gainNode.gain.setTargetAtTime;
    setTargetAtTime.mockClear();

    // Same slice arrives — should be a no-op, no ramp triggered
    await audioCfgCb({ ...cfg });
    expect(setTargetAtTime).not.toHaveBeenCalled();
  });

  it('rebuilds capture graph when inputDeviceId changes while capturing', async () => {
    sarahMock.getConfig.mockResolvedValue({
      audio: makeAudioConfig({ inputDeviceId: 'mic-a' }),
    });
    await bridge.start();
    stateChangeCb({ state: 'listening' });

    await vi.waitFor(() => {
      expect(captureCtxInstance.createGain).toHaveBeenCalled();
    });

    const firstCtx = captureCtxInstance;
    (navigator.mediaDevices.getUserMedia as ReturnType<typeof vi.fn>).mockClear();

    await audioCfgCb(makeAudioConfig({ inputDeviceId: 'mic-b' }));
    await vi.waitFor(() => {
      expect((navigator.mediaDevices.getUserMedia as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
    });

    // Old stream stopped, old context closed, new context created
    expect(mockTrack.stop).toHaveBeenCalled();
    expect(firstCtx.close).toHaveBeenCalled();
    // A third AudioContext was constructed (capture1, playback-unused, capture2) or (capture1, capture2, ...)
    expect(ctxCallCount).toBeGreaterThanOrEqual(2);
    // New getUserMedia call passed the exact device constraint
    const lastCall = (navigator.mediaDevices.getUserMedia as ReturnType<typeof vi.fn>).mock.calls.at(-1);
    expect(lastCall?.[0]?.audio?.deviceId?.exact).toBe('mic-b');
  });

  it('passes deviceId constraint to getUserMedia when configured', async () => {
    sarahMock.getConfig.mockResolvedValue({
      audio: makeAudioConfig({ inputDeviceId: 'mic-xyz' }),
    });
    await bridge.start();
    stateChangeCb({ state: 'listening' });

    await vi.waitFor(() => {
      expect((navigator.mediaDevices.getUserMedia as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
    });

    const call = (navigator.mediaDevices.getUserMedia as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0].audio.deviceId.exact).toBe('mic-xyz');
  });

  it('serializes rapid applyAudioConfig calls — last deviceId wins', async () => {
    // Start with mic-a capturing, so decideCaptureReset() returns 'reset'
    // for each queued call (state='listening' + device change).
    sarahMock.getConfig.mockResolvedValue({
      audio: makeAudioConfig({ inputDeviceId: 'mic-a' }),
      controls: { voiceMode: 'push-to-talk' },
    });
    await bridge.start();
    stateChangeCb({ state: 'listening' });

    await vi.waitFor(() => {
      expect(captureCtxInstance.createGain).toHaveBeenCalled();
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
    sarahMock.getConfig.mockResolvedValue({
      audio: makeAudioConfig({ inputDeviceId: 'mic-a' }),
    });
    await bridge.start();
    stateChangeCb({ state: 'listening' });

    await vi.waitFor(() => {
      expect(captureCtxInstance.createGain).toHaveBeenCalled();
    });

    // Freeze getUserMedia so the rebuild below is still in-flight when destroy hits.
    const getUserMediaMock = navigator.mediaDevices.getUserMedia as ReturnType<typeof vi.fn>;
    let release!: (value: typeof mockStream) => void;
    const pending = new Promise<typeof mockStream>((resolve) => {
      release = resolve;
    });
    getUserMediaMock.mockClear();
    // mic-b triggers a reset → stopCapture, close ctx, then startCapture whose
    // getUserMedia hangs on `pending`. mic-a from the initial startCapture was
    // already stopped by that reset; mockTrack.stop resets can confirm the
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
    mockTrack.stop.mockClear();
    playbackCtxInstance.close.mockClear();

    // Now destroy while apply is pending. destroy awaits applyPromise before
    // tearing down, so it blocks until we release the pending stream.
    const destroying = bridge.destroy();

    // Release the stream so the in-flight startCapture can finish, then apply
    // resolves, then destroy proceeds to its own stopCapture + context close.
    release(mockStream);

    await applying;
    await destroying;

    // The pending setup is invalidated before it wires a worklet: its late
    // stream is stopped and its private context is closed before destroy ends.
    expect(mockTrack.stop).toHaveBeenCalled();
    expect(playbackCtxInstance.close).toHaveBeenCalled();
  });

  it('falls back to default mic on OverconstrainedError', async () => {
    sarahMock.getConfig.mockResolvedValue({
      audio: makeAudioConfig({ inputDeviceId: 'mic-gone' }),
    });

    const overconstrained = Object.assign(new Error('no such device'), { name: 'OverconstrainedError' });
    const getUserMediaMock = navigator.mediaDevices.getUserMedia as ReturnType<typeof vi.fn>;
    getUserMediaMock
      .mockRejectedValueOnce(overconstrained)
      .mockResolvedValueOnce(mockStream);

    await bridge.start();
    stateChangeCb({ state: 'listening' });

    await vi.waitFor(() => {
      expect(getUserMediaMock).toHaveBeenCalledTimes(2);
    });

    // First call had the exact deviceId, retry had no deviceId constraint
    expect(getUserMediaMock.mock.calls[0][0].audio.deviceId.exact).toBe('mic-gone');
    expect(getUserMediaMock.mock.calls[1][0].audio.deviceId).toBeUndefined();
  });

  it('fails an active capture immediately before rebuilding for an input-device change', async () => {
    sarahMock.getConfig.mockResolvedValue({
      audio: makeAudioConfig({ inputDeviceId: 'mic-a' }),
      controls: { voiceMode: 'push-to-talk' },
    });
    await bridge.start();
    stateChangeCb({ state: 'listening', captureId: TEST_CAPTURE_ID });
    const firstPort = captureCtxInstance._workletNode.port;

    await bridge.applyAudioConfig(makeAudioConfig({ inputDeviceId: 'mic-b' }));

    expect(firstPort.postMessage).toHaveBeenCalledWith({
      type: 'cancel', captureId: TEST_CAPTURE_ID,
    });
    expect(sarahVoiceMock.captureFailed).toHaveBeenCalledWith(
      TEST_CAPTURE_ID,
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
    sarahMock.getConfig.mockResolvedValue({
      audio: makeAudioConfig({ inputDeviceId: 'preferred-mic' }),
      controls: { voiceMode: 'push-to-talk' },
    });

    await bridge.start();
    expect(getUserMedia).toHaveBeenCalledTimes(2);

    (navigator.mediaDevices.enumerateDevices as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { kind: 'audioinput', deviceId: 'default-mic' },
    ]);
    deviceChangeListener?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(fallbackTrack.stop).not.toHaveBeenCalled();

    (navigator.mediaDevices.enumerateDevices as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { kind: 'audioinput', deviceId: 'default-mic' },
      { kind: 'audioinput', deviceId: 'preferred-mic' },
    ]);
    deviceChangeListener?.();

    await vi.waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(3));
    expect(fallbackTrack.stop).toHaveBeenCalledOnce();
    const internal = bridge as unknown as { activeInputDeviceId: string | undefined };
    expect(internal.activeInputDeviceId).toBe('preferred-mic');
  });

  // ── Path-B (setSinkId) playback routing ──

  it('routes playback through <audio>.setSinkId when outputDeviceId is set', async () => {
    sarahMock.getConfig.mockResolvedValue({
      audio: makeAudioConfig({ outputDeviceId: 'out-a' }),
    });
    await bridge.start();

    playAudio([0.1, 0.2, 0.3]);

    await vi.waitFor(() => {
      expect(lastAudioEl).not.toBeNull();
      expect(lastAudioEl?.setSinkId).toHaveBeenCalled();
    });

    // No capture triggered — the playback ctx is ctx #1 (captureCtxInstance).
    // An <audio> element was created, wired to the MediaStreamDestination, and
    // its setSinkId was called with the configured device id.
    expect(lastAudioEl?.setSinkId).toHaveBeenCalledWith('out-a');
    expect(lastAudioEl?.autoplay).toBe(true);
    expect(lastAudioEl?.srcObject).toBe(captureCtxInstance._streamDest.stream);
  });

  it('falls back gracefully when setSinkId rejects', async () => {
    sarahMock.getConfig.mockResolvedValue({
      audio: makeAudioConfig({ outputDeviceId: 'out-a' }),
    });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    setSinkIdImpl = () => Promise.reject(new Error('invalid sink'));

    await bridge.start();
    playAudio([0.1, 0.2, 0.3]);

    await vi.waitFor(() => {
      expect(lastAudioEl).not.toBeNull();
      expect(lastAudioEl?.setSinkId).toHaveBeenCalled();
      // The catch handler must have run and warned.
      expect(warnSpy).toHaveBeenCalled();
    });

    // Fallback message format.
    const sinkWarnCalls = warnSpy.mock.calls.filter((c) =>
      typeof c[0] === 'string' && c[0].includes('setSinkId("out-a") failed/timed out'),
    );
    expect(sinkWarnCalls.length).toBeGreaterThanOrEqual(1);
    expect(lastAudioEl?.pause).toHaveBeenCalledOnce();
    expect(lastAudioEl?.srcObject).toBeNull();
    expect(lastAudioEl?.load).toHaveBeenCalledOnce();
    expect(captureCtxInstance._gainNode.disconnect).toHaveBeenCalled();
    expect(captureCtxInstance._gainNode.connect).toHaveBeenLastCalledWith(
      captureCtxInstance.destination,
    );

    warnSpy.mockRestore();
  });

  it('falls back to the default sink when setSinkId times out', async () => {
    vi.useFakeTimers();
    sarahMock.getConfig.mockResolvedValue({
      audio: makeAudioConfig({ outputDeviceId: 'out-timeout' }),
    });
    setSinkIdImpl = () => new Promise<void>(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await bridge.start();
    playAudio([0.1]);
    for (let i = 0; i < 8 && !lastAudioEl?.setSinkId.mock.calls.length; i += 1) {
      await Promise.resolve();
    }
    expect(lastAudioEl?.setSinkId).toHaveBeenCalledWith('out-timeout');

    await vi.advanceTimersByTimeAsync(2_000);
    expect(lastAudioEl?.pause).toHaveBeenCalledOnce();
    expect(lastAudioEl?.srcObject).toBeNull();
    expect(captureCtxInstance._gainNode.connect).toHaveBeenLastCalledWith(
      captureCtxInstance.destination,
    );
    warnSpy.mockRestore();
  });

  it('keeps a failed sink on the default path until a device change makes retry meaningful', async () => {
    sarahMock.getConfig.mockResolvedValue({
      audio: makeAudioConfig({ outputDeviceId: 'out-sticky' }),
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let sinkAttempts = 0;
    setSinkIdImpl = () => {
      sinkAttempts += 1;
      return sinkAttempts === 1
        ? Promise.reject(new Error('sink unavailable'))
        : Promise.resolve();
    };
    await bridge.start();

    playAudio([0.1]);
    await vi.waitFor(() => expect(totalBufferSourceCalls()).toBe(1));
    playAudio([0.2]);
    await vi.waitFor(() => expect(totalBufferSourceCalls()).toBe(2));
    expect(sinkAttempts).toBe(1);

    (navigator.mediaDevices.enumerateDevices as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { kind: 'audiooutput', deviceId: 'out-sticky' },
    ]);
    deviceChangeListener?.();
    await Promise.resolve();
    await Promise.resolve();

    playAudio([0.3]);
    await vi.waitFor(() => expect(sinkAttempts).toBe(2));
    expect(totalBufferSourceCalls()).toBe(3);
    warnSpy.mockRestore();
  });

  it('reports an active Path-B media error and suppresses its success ACK', async () => {
    sarahMock.getConfig.mockResolvedValue({
      audio: makeAudioConfig({ outputDeviceId: 'out-a' }),
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await bridge.start();
    const correlation = playAudio([0.1]);
    await vi.waitFor(() => expect(totalBufferSourceCalls()).toBe(1));
    const source = captureCtxInstance.createBufferSource.mock.results[0].value;
    if (lastAudioEl) lastAudioEl.error = { message: 'device disconnected' };
    lastAudioEl?._errorListeners[0]?.();

    await vi.waitFor(() => expect(sarahVoiceMock.playbackFailed).toHaveBeenCalledWith(
      correlation.turnId,
      correlation.playbackId,
      'device disconnected',
    ));
    expect(source.stop).toHaveBeenCalledOnce();
    expect(source.onended).toBeNull();
    expect(sarahVoiceMock.playbackDone).not.toHaveBeenCalledWith(
      correlation.turnId,
      correlation.playbackId,
    );
  });

  it('does not start stale playback after an async sink switch was interrupted', async () => {
    sarahMock.getConfig.mockResolvedValue({
      audio: makeAudioConfig({ outputDeviceId: 'out-a' }),
    });
    let resolveSink = (): void => {};
    setSinkIdImpl = () => new Promise<void>((resolve) => { resolveSink = resolve; });

    await bridge.start();
    const correlation = playAudio([0.1, 0.2, 0.3]);
    await vi.waitFor(() => expect(lastAudioEl?.setSinkId).toHaveBeenCalledWith('out-a'));

    stateChangeCb({ state: 'listening' });
    resolveSink();

    await vi.waitFor(() => {
      const internal = bridge as unknown as {
        playbackStartControllers: Map<string, AbortController>;
      };
      expect(internal.playbackStartControllers.size).toBe(0);
    });
    expect(captureCtxInstance.createBufferSource).not.toHaveBeenCalled();
    expect(sarahVoiceMock.playbackDone).not.toHaveBeenCalledWith(
      correlation.turnId,
      correlation.playbackId,
    );
    expect(sarahVoiceMock.playbackFailed).not.toHaveBeenCalledWith(
      correlation.turnId,
      correlation.playbackId,
      expect.any(String),
    );
  });

  it('aborts a hung playback setup so a following playback is not blocked', async () => {
    captureCtxInstance.state = 'suspended';
    captureCtxInstance.resume.mockReturnValueOnce(new Promise<void>(() => {}));
    await bridge.start();

    const first = playAudio([0.1]);
    await vi.waitFor(() => expect(captureCtxInstance.resume).toHaveBeenCalledOnce());
    stopPlaybackCb(first);
    captureCtxInstance.state = 'running';

    const second = playAudio([0.2]);
    await vi.waitFor(() => expect(totalBufferSourceCalls()).toBe(1));
    expect(sarahVoiceMock.playbackDone).not.toHaveBeenCalledWith(first.turnId, first.playbackId);
    expect(sarahVoiceMock.playbackFailed).not.toHaveBeenCalledWith(
      first.turnId,
      first.playbackId,
      expect.any(String),
    );
    expect(sarahVoiceMock.playbackFailed).not.toHaveBeenCalledWith(
      second.turnId,
      second.playbackId,
      expect.any(String),
    );
  });

  it('times out a hung playback setup and lets the serialized queue continue', async () => {
    vi.useFakeTimers();
    try {
      captureCtxInstance.state = 'suspended';
      captureCtxInstance.resume.mockReturnValueOnce(new Promise<void>(() => {}));
      await bridge.start();

      const first = playAudio([0.1]);
      await Promise.resolve();
      await Promise.resolve();
      expect(captureCtxInstance.resume).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(4_000);

      expect(sarahVoiceMock.playbackFailed).toHaveBeenCalledWith(
        first.turnId,
        first.playbackId,
        expect.stringContaining('timed out'),
      );

      captureCtxInstance.state = 'running';
      playAudio([0.2]);
      await vi.advanceTimersByTimeAsync(0);
      expect(totalBufferSourceCalls()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('flips Path A → Path B when outputDeviceId becomes set between utterances', async () => {
    // First utterance: no outputDeviceId → Path A (ctx.destination). Since we
    // never triggered capture, the playback AudioContext is ctx #1, which our
    // stub maps to captureCtxInstance.
    await bridge.start();
    playAudio([0.1]);

    await vi.waitFor(() => {
      expect(captureCtxInstance.createBufferSource).toHaveBeenCalled();
    });
    // No <audio> element on Path A.
    expect(lastAudioEl).toBeNull();
    // createMediaStreamDestination was NOT used on Path A.
    expect(captureCtxInstance.createMediaStreamDestination).not.toHaveBeenCalled();

    // Apply config — switch to a specific sink. Use the bridge directly so
    // we can await the apply to settle (the onAudioConfigChanged callback is
    // fire-and-forget, await'ing it returns immediately).
    await bridge.applyAudioConfig(makeAudioConfig({ outputDeviceId: 'out-b' }));

    // Second utterance: now Path B. Still same ctx (sampleRate unchanged).
    playAudio([0.1]);

    await vi.waitFor(() => {
      expect(lastAudioEl).not.toBeNull();
    });
    expect(lastAudioEl?.setSinkId).toHaveBeenCalledWith('out-b');
    // The same ctx (#1) is still live — createMediaStreamDestination is on it.
    const activeCtx = ctxCallCount === 1 ? captureCtxInstance :
                      ctxCallCount === 2 ? playbackCtxInstance :
                      extraCtxInstances[extraCtxInstances.length - 1];
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

    sarahMock.getConfig.mockResolvedValue({
      audio: makeAudioConfig({ outputDeviceId: 'out-unsupported' }),
    });
    await bridge.start();
    playAudio([0.1]);

    // No capture was triggered — playback AudioContext is the first one, which
    // the stub maps to captureCtxInstance.
    await vi.waitFor(() => {
      expect(captureCtxInstance.createBufferSource).toHaveBeenCalled();
    });

    // No <audio> element — Path A fallback.
    expect(lastAudioEl).toBeNull();
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
    expect(() => stateChangeCb({ state: 'listening' })).not.toThrow();
  });

  it('stopPlayback() primes decay synchronously before onended fires', async () => {
    // Start, kick off a playback so a BufferSource is live. No capture here,
    // so the playback ctx is ctx #1 (captureCtxInstance).
    await bridge.start();
    playAudio([0.1, 0.2, 0.3]);

    await vi.waitFor(() => {
      expect(captureCtxInstance.createBufferSource).toHaveBeenCalled();
    });

    // Interrupt mid-playback via a state change to 'listening'. stopPlayback
    // must SYNCHRONOUSLY prime `outputPlaybackEndedAt`, not wait for onended.
    const bridgeInternal = bridge as unknown as {
      outputPlaybackEndedAt: number | null;
      currentPlaybackSource: { stop: ReturnType<typeof vi.fn>; onended: (() => void) | null } | null;
    };
    // Sanity: playback is in flight, decay not yet primed.
    expect(bridgeInternal.outputPlaybackEndedAt).toBeNull();

    stateChangeCb({ state: 'listening' });

    // Decay timestamp must be set RIGHT NOW, before any async onended hop.
    expect(bridgeInternal.outputPlaybackEndedAt).not.toBeNull();
    expect(typeof bridgeInternal.outputPlaybackEndedAt).toBe('number');

    // BufferSource was stopped.
    const bufferSource = captureCtxInstance.createBufferSource.mock.results[0].value;
    expect(bufferSource.stop).toHaveBeenCalled();

    // onended (if it fires after) must not overwrite the earlier timestamp.
    const firstStamp = bridgeInternal.outputPlaybackEndedAt;
    bufferSource.onended?.();
    expect(bridgeInternal.outputPlaybackEndedAt).toBe(firstStamp);
  });

  it('stops only the correlated renderer playback and ignores a stale stop event', async () => {
    await bridge.start();
    const first = playAudio([0.1]);
    await vi.waitFor(() => expect(captureCtxInstance.createBufferSource).toHaveBeenCalledTimes(1));
    const firstSource = captureCtxInstance.createBufferSource.mock.results[0].value;

    stopPlaybackCb(first);
    expect(firstSource.stop).toHaveBeenCalledOnce();

    const second = playAudio([0.2]);
    await vi.waitFor(() => expect(playbackCtxInstance.createBufferSource).toHaveBeenCalledOnce());
    const secondSource = playbackCtxInstance.createBufferSource.mock.results[0].value;

    stopPlaybackCb(first);
    expect(secondSource.stop).not.toHaveBeenCalled();
    stopPlaybackCb(second);
    expect(secondSource.stop).toHaveBeenCalledOnce();
  });
});
