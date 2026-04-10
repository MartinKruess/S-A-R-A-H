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

  return {
    state: 'running' as string,
    sampleRate: 16_000,
    resume: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    audioWorklet: { addModule: workletAddModule },
    createMediaStreamSource: vi.fn().mockReturnValue(mockSourceNode),
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
    _sourceNode: mockSourceNode,
    _workletNode: mockWorkletNode,
    _workletAddModule: workletAddModule,
  };
}

const mockTrack = { stop: vi.fn() };
const mockStream = { getTracks: () => [mockTrack] };

// ── Global stubs ──

let captureCtxInstance: ReturnType<typeof createMockAudioContext>;
let playbackCtxInstance: ReturnType<typeof createMockAudioContext>;
let ctxCallCount: number;

const sarahVoiceMock = {
  getState: vi.fn().mockResolvedValue('idle'),
  onStateChange: vi.fn().mockReturnValue(vi.fn()),
  onPlayAudio: vi.fn().mockReturnValue(vi.fn()),
  playbackDone: vi.fn().mockResolvedValue(undefined),
  onError: vi.fn().mockReturnValue(vi.fn()),
  sendAudioChunk: vi.fn().mockResolvedValue(undefined),
};

(globalThis as Record<string, unknown>).sarah = { voice: sarahVoiceMock };

// AudioContext must be a real constructor function (not arrow)
vi.stubGlobal('AudioContext', function MockAudioContext(this: Record<string, unknown>) {
  ctxCallCount++;
  const instance = ctxCallCount === 1 ? captureCtxInstance : playbackCtxInstance;
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

  beforeEach(() => {
    vi.clearAllMocks();
    ctxCallCount = 0;
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
});
