// tests/renderer/services/audio-bridge.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mock Browser APIs ──

function createMockAudioContext() {
  const workletAddModule = vi.fn().mockResolvedValue(undefined);
  const mockSourceNode = { connect: vi.fn(), disconnect: vi.fn() };
  const mockWorkletNode = {
    port: { onmessage: null as ((ev: MessageEvent) => void) | null },
    connect: vi.fn(),
    disconnect: vi.fn(),
  };
  const gainParam = {
    value: 1,
    setTargetAtTime: vi.fn(),
  };
  const mockGainNode = {
    gain: gainParam,
    connect: vi.fn(),
    disconnect: vi.fn(),
  };

  return {
    state: 'running' as string,
    sampleRate: 16_000,
    currentTime: 0,
    resume: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    audioWorklet: { addModule: workletAddModule },
    createMediaStreamSource: vi.fn().mockReturnValue(mockSourceNode),
    createGain: vi.fn().mockReturnValue(mockGainNode),
    createBuffer: vi.fn().mockReturnValue({
      getChannelData: vi.fn().mockReturnValue(new Float32Array(100)),
    }),
    createBufferSource: vi.fn().mockReturnValue({
      buffer: null,
      connect: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
      onended: null as (() => void) | null,
    }),
    destination: {},
    _sourceNode: mockSourceNode,
    _workletNode: mockWorkletNode,
    _gainNode: mockGainNode,
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

const mockTrack = { stop: vi.fn() };
const mockStream = { getTracks: () => [mockTrack] };

// ── Global stubs ──

let captureCtxInstance: MockAudioCtx;
let playbackCtxInstance: MockAudioCtx;
let extraCtxInstances: MockAudioCtx[] = [];
let ctxCallCount: number;

const sarahVoiceMock = {
  getState: vi.fn().mockResolvedValue('idle'),
  onStateChange: vi.fn().mockReturnValue(vi.fn()),
  onPlayAudio: vi.fn().mockReturnValue(vi.fn()),
  playbackDone: vi.fn().mockResolvedValue(undefined),
  onError: vi.fn().mockReturnValue(vi.fn()),
  sendAudioChunk: vi.fn().mockResolvedValue(undefined),
};

const sarahMock = {
  voice: sarahVoiceMock,
  getConfig: vi.fn().mockResolvedValue({ audio: makeAudioConfig() }),
  onAudioConfigChanged: vi.fn().mockReturnValue(vi.fn()),
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

vi.stubGlobal('navigator', {
  mediaDevices: {
    getUserMedia: vi.fn().mockResolvedValue(mockStream),
  },
});

// Must import AFTER globals are set up
const { AudioBridge } = await import('../../../src/renderer/services/audio-bridge.js');

describe('AudioBridge', () => {
  let bridge: InstanceType<typeof AudioBridge>;
  let stateChangeCb: (data: { state: string }) => void;
  let playAudioCb: (data: { audio: number[]; sampleRate: number }) => void;

  let audioCfgCb: (audio: AudioConfigFields) => void;

  beforeEach(() => {
    vi.clearAllMocks();
    ctxCallCount = 0;
    extraCtxInstances = [];
    captureCtxInstance = createMockAudioContext();
    playbackCtxInstance = createMockAudioContext();
    mockTrack.stop.mockClear();

    sarahVoiceMock.onStateChange.mockImplementation((cb: (data: { state: string }) => void) => {
      stateChangeCb = cb;
      return vi.fn();
    });
    sarahVoiceMock.onPlayAudio.mockImplementation((cb: (data: { audio: number[]; sampleRate: number }) => void) => {
      playAudioCb = cb;
      return vi.fn();
    });
    sarahMock.getConfig.mockResolvedValue({ audio: makeAudioConfig() });
    sarahMock.onAudioConfigChanged.mockImplementation((cb: (audio: AudioConfigFields) => void) => {
      audioCfgCb = cb;
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
    expect(sarahVoiceMock.getState).toHaveBeenCalledOnce();
  });

  it('starts capture when state changes to listening', async () => {
    await bridge.start();
    stateChangeCb({ state: 'listening' });

    await vi.waitFor(() => {
      expect((navigator.mediaDevices.getUserMedia as ReturnType<typeof vi.fn>)).toHaveBeenCalledOnce();
    });
  });

  it('stops capture when state changes from listening to processing', async () => {
    await bridge.start();
    stateChangeCb({ state: 'listening' });

    await vi.waitFor(() => {
      expect((navigator.mediaDevices.getUserMedia as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
    });

    stateChangeCb({ state: 'processing' });
    expect(mockTrack.stop).toHaveBeenCalledOnce();
  });

  it('closes AudioContext instances on destroy', async () => {
    await bridge.start();

    // Trigger capture to create captureCtx
    stateChangeCb({ state: 'listening' });
    await vi.waitFor(() => {
      expect((navigator.mediaDevices.getUserMedia as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
    });

    // Trigger playback to create playbackCtx
    playAudioCb({ audio: [0.1, 0.2, 0.3], sampleRate: 22_050 });
    await vi.waitFor(() => {
      expect(ctxCallCount).toBe(2);
    });

    await bridge.destroy();

    expect(captureCtxInstance.close).toHaveBeenCalledOnce();
    expect(playbackCtxInstance.close).toHaveBeenCalledOnce();
  });

  it('signals playbackDone even on playback error', async () => {
    // Without capture, playback AudioContext is the first one created
    captureCtxInstance.createBuffer.mockImplementation(() => {
      throw new Error('buffer creation failed');
    });

    await bridge.start();
    playAudioCb({ audio: [0.1], sampleRate: 22_050 });

    await vi.waitFor(() => {
      expect(sarahVoiceMock.playbackDone).toHaveBeenCalled();
    });
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
    port.onmessage?.({ data: { samples } } as MessageEvent);
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
    port.onmessage?.({ data: { samples } } as MessageEvent);
    expect(sarahVoiceMock.sendAudioChunk).toHaveBeenCalledOnce();
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
});
