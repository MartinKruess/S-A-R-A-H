import { afterEach, describe, expect, it, vi } from 'vitest';

interface BootStatus {
  step: string;
  message?: string;
  severity?: 'info' | 'warning' | 'error';
}

function createElement(): {
  classList: { add: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn> };
  style: { opacity: string };
  textContent: string;
  innerHTML: string;
} {
  return {
    classList: { add: vi.fn(), remove: vi.fn() },
    style: { opacity: '' },
    textContent: '',
    innerHTML: '',
  };
}

describe('dashboard boot sequence', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('continues boot in degraded mode when the initial config cannot be read', async () => {
    vi.useFakeTimers();
    const element = {
      classList: { add: vi.fn(), remove: vi.fn() },
      style: { opacity: '' },
      textContent: '',
      innerHTML: '',
    };
    vi.stubGlobal('document', {
      getElementById: vi.fn(() => element),
    });
    const getConfig = vi.fn().mockRejectedValue(new Error('config unavailable'));
    const requestAnimationFrame = vi.fn();
    const bootReady = vi.fn();
    const onBootStatus = vi.fn(() => vi.fn());
    vi.stubGlobal('requestAnimationFrame', requestAnimationFrame);
    vi.stubGlobal('sarah', {
      getConfig,
      bootReady,
      onBootStatus,
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { startBootSequence } = await import(
      '../../../src/renderer/dashboard/boot-sequence.js'
    );

    void startBootSequence({} as never);
    await Promise.resolve();
    await Promise.resolve();

    expect(onBootStatus).toHaveBeenCalledOnce();
    expect(bootReady).toHaveBeenCalledOnce();
    expect(requestAnimationFrame).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(150);
    expect(element.textContent).toContain('Konfiguration konnte nicht geladen werden');
  });

  it('keeps boot ownership until splash playback has actually ended', async () => {
    vi.useFakeTimers();
    const element = createElement();
    let frame: FrameRequestCallback | null = null;
    let statusListener: ((status: BootStatus) => void) | null = null;
    const source = {
      buffer: null as AudioBuffer | null,
      connect: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
      onended: null as (() => void) | null,
    };
    class MockAudioContext {
      destination = {};
      createBuffer(): { getChannelData(): Float32Array } {
        return { getChannelData: () => new Float32Array(4) };
      }
      createBufferSource(): typeof source {
        return source;
      }
    }
    const bootDone = vi.fn();
    const splashTts = vi.fn().mockResolvedValue({ audio: [0.1, 0.2, 0.1, 0], sampleRate: 22_050 });
    vi.stubGlobal('document', { getElementById: vi.fn(() => element) });
    vi.stubGlobal('AudioContext', MockAudioContext);
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
      frame = callback;
      return 1;
    }));
    vi.stubGlobal('sarah', {
      getConfig: vi.fn().mockResolvedValue({ onboarding: { firstStart: false } }),
      bootReady: vi.fn(),
      bootDone,
      revealDone: vi.fn(),
      splashTts,
      onTransitionStart: vi.fn(),
      onBootStatus: vi.fn((listener: (status: BootStatus) => void) => {
        statusListener = listener;
        return vi.fn();
      }),
    });
    const orb = {
      setLightIntensity: vi.fn(),
      setOrbScale: vi.fn(),
      setOrbOffset: vi.fn(),
      setLightColor: vi.fn(),
      triggerBreak: vi.fn(),
    };
    const { startBootSequence } = await import('../../../src/renderer/dashboard/boot-sequence.js');
    const boot = startBootSequence(orb as never);
    await Promise.resolve();
    await Promise.resolve();
    statusListener?.({ step: 'router-ready' });
    statusListener?.({ step: 'piper-ready' });

    frame?.(performance.now());
    await vi.advanceTimersByTimeAsync(5_000);
    frame?.(performance.now());
    await vi.advanceTimersByTimeAsync(4_100);
    frame?.(performance.now());
    frame?.(performance.now());
    await Promise.resolve();
    frame?.(performance.now());
    await vi.advanceTimersByTimeAsync(200);

    expect(source.start).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(8_100);
    frame?.(performance.now());
    expect(bootDone).not.toHaveBeenCalled();
    expect(source.stop).not.toHaveBeenCalled();

    source.onended?.();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1_000);
    frame?.(performance.now());
    await boot;

    expect(bootDone).toHaveBeenCalledOnce();
    expect(source.stop).not.toHaveBeenCalled();
  });

  it('degrades boot without starting a splash request when Piper becomes ready after its deadline', async () => {
    vi.useFakeTimers();
    const element = createElement();
    let frame: FrameRequestCallback | null = null;
    let statusListener: ((status: BootStatus) => void) | null = null;
    const bootDone = vi.fn();
    const splashTts = vi.fn();
    vi.stubGlobal('document', { getElementById: vi.fn(() => element) });
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
      frame = callback;
      return 1;
    }));
    vi.stubGlobal('sarah', {
      getConfig: vi.fn().mockResolvedValue({ onboarding: { firstStart: false } }),
      bootReady: vi.fn(),
      bootDone,
      revealDone: vi.fn(),
      splashTts,
      onTransitionStart: vi.fn(),
      onBootStatus: vi.fn((listener: (status: BootStatus) => void) => {
        statusListener = listener;
        return vi.fn();
      }),
    });
    const orb = {
      setLightIntensity: vi.fn(),
      setOrbScale: vi.fn(),
      setOrbOffset: vi.fn(),
      setLightColor: vi.fn(),
      triggerBreak: vi.fn(),
    };
    const { startBootSequence } = await import('../../../src/renderer/dashboard/boot-sequence.js');
    const boot = startBootSequence(orb as never);
    await Promise.resolve();
    await Promise.resolve();
    statusListener?.({ step: 'router-ready' });

    frame?.(performance.now());
    await vi.advanceTimersByTimeAsync(5_000);
    frame?.(performance.now());
    await vi.advanceTimersByTimeAsync(4_100);
    frame?.(performance.now());
    await vi.advanceTimersByTimeAsync(8_100);
    statusListener?.({ step: 'piper-ready' });
    frame?.(performance.now());
    frame?.(performance.now());
    await boot;

    expect(splashTts).not.toHaveBeenCalled();
    expect(bootDone).toHaveBeenCalledOnce();
  });
});
