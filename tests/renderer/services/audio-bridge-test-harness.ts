import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mock Browser APIs ──

function createMockAudioContext() {
  const stateChangeListeners = new Set<() => void>();
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
    addEventListener: vi.fn((event: string, listener: () => void) => {
      if (event === 'statechange') stateChangeListeners.add(listener);
    }),
    removeEventListener: vi.fn((event: string, listener: () => void) => {
      if (event === 'statechange') stateChangeListeners.delete(listener);
    }),
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
    _emitStateChange: () => {
      for (const listener of stateChangeListeners) listener();
    },
    _stateChangeListeners: stateChangeListeners,
  };
}

type MockAudioCtx = ReturnType<typeof createMockAudioContext>;

export interface AudioConfigFields {
  inputDeviceId?: string;
  outputDeviceId?: string;
  inputMuted: boolean;
  inputGain: number;
  inputVolume: number;
  outputVolume: number;
}

export function makeAudioConfig(overrides: Partial<AudioConfigFields> = {}): AudioConfigFields {
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
export const { AudioBridge } = await import('../../../src/renderer/services/audio-bridge.js');


export const audioTestEnvironment = {
  get captureCtxInstance() { return captureCtxInstance; },
  get playbackCtxInstance() { return playbackCtxInstance; },
  get extraCtxInstances() { return extraCtxInstances; },
  get ctxCallCount() { return ctxCallCount; },
  get trackEndedListeners() { return trackEndedListeners; },
  get deviceChangeListener() { return deviceChangeListener; },
  get lastAudioEl() { return lastAudioEl; },
  get mockTrack() { return mockTrack; },
  get mockStream() { return mockStream; },
  get sarahVoiceMock() { return sarahVoiceMock; },
  get sarahMock() { return sarahMock; },
  get TEST_CAPTURE_ID() { return TEST_CAPTURE_ID; },
  set setSinkIdImpl(implementation: (sinkId: string) => Promise<void>) {
    setSinkIdImpl = implementation;
  },
};

export function resetAudioTestEnvironment(): void {
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
  setSinkIdImpl = () => Promise.resolve();
}

export function createAudioBridgeTestFixture() {
  resetAudioTestEnvironment();

  let stateChangeCallback = (_data: { state: string; captureId?: string }): void => {
    throw new Error('AudioBridge state listener is not registered');
  };
  let captureFlushCallback = (_data: { captureId: string }): void => {
    throw new Error('AudioBridge capture-flush listener is not registered');
  };
  let playAudioCallback = (_data: {
    turnId: string;
    playbackId: string;
    audio: number[];
    sampleRate: number;
  }): void => {
    throw new Error('AudioBridge playback listener is not registered');
  };
  let stopPlaybackCallback = (_data: { turnId: string; playbackId: string }): void => {
    throw new Error('AudioBridge stop-playback listener is not registered');
  };
  let capabilityCallback = (_data: { stt: boolean; tts: boolean }): void => {
    throw new Error('AudioBridge capability listener is not registered');
  };
  let voiceInputConfigCallback = (_data: {
    voiceMode: 'off' | 'push-to-talk' | 'keyword';
  }): void => {
    throw new Error('AudioBridge voice-input listener is not registered');
  };
  let audioConfigCallback = (_audio: AudioConfigFields): void => {
    throw new Error('AudioBridge audio-config listener is not registered');
  };
  let playbackNumber = 0;

  sarahVoiceMock.getState.mockResolvedValue({ state: 'idle' });
  sarahVoiceMock.onStateChange.mockImplementation((callback) => {
    stateChangeCallback = (data) => callback(
      data.state === 'listening' && !data.captureId
        ? { ...data, captureId: TEST_CAPTURE_ID }
        : data,
    );
    return vi.fn();
  });
  sarahVoiceMock.onPlayAudio.mockImplementation((callback) => {
    playAudioCallback = callback;
    return vi.fn();
  });
  sarahVoiceMock.onCaptureFlushRequest.mockImplementation((callback) => {
    captureFlushCallback = callback;
    return vi.fn();
  });
  sarahVoiceMock.onStopPlayback.mockImplementation((callback) => {
    stopPlaybackCallback = callback;
    return vi.fn();
  });
  sarahVoiceMock.onCapability.mockImplementation((callback) => {
    capabilityCallback = callback;
    return vi.fn();
  });
  (navigator.mediaDevices.getUserMedia as ReturnType<typeof vi.fn>).mockResolvedValue(mockStream);
  (navigator.mediaDevices.enumerateDevices as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  sarahMock.getConfig.mockResolvedValue({ audio: makeAudioConfig() });
  sarahMock.onAudioConfigChanged.mockImplementation((callback) => {
    audioConfigCallback = callback;
    return vi.fn();
  });
  sarahMock.onVoiceInputConfigChanged.mockImplementation((callback) => {
    voiceInputConfigCallback = callback;
    return vi.fn();
  });

  const bridge = new AudioBridge();
  return {
    bridge,
    stateChange: (data: { state: string; captureId?: string }) => stateChangeCallback(data),
    captureFlush: (data: { captureId: string }) => captureFlushCallback(data),
    stopPlayback: (data: { turnId: string; playbackId: string }) => stopPlaybackCallback(data),
    capability: (data: { stt: boolean; tts: boolean }) => capabilityCallback(data),
    voiceInputConfig: (data: { voiceMode: 'off' | 'push-to-talk' | 'keyword' }) => (
      voiceInputConfigCallback(data)
    ),
    audioConfig: (audio: AudioConfigFields) => audioConfigCallback(audio),
    playAudio(audio: number[], sampleRate = 22_050): { turnId: string; playbackId: string } {
      playbackNumber += 1;
      const correlation = {
        turnId: '11111111-1111-4111-8111-111111111111',
        playbackId: `22222222-2222-4222-8222-${String(playbackNumber).padStart(12, '0')}`,
      };
      playAudioCallback({ ...correlation, audio, sampleRate });
      return correlation;
    },
    totalBufferSourceCalls(): number {
      return [captureCtxInstance, playbackCtxInstance, ...extraCtxInstances]
        .reduce((total, context) => total + context.createBufferSource.mock.calls.length, 0);
    },
  };
}
