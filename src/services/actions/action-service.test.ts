import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ActionService } from './action-service.js';
import type { SearchLike } from './action-service.js';
import { SystemActions } from './system-actions.js';
import type { SpotifyActions } from './spotify-actions.js';
import type { MediaController, MediaResult } from './media-controller.js';
import { MessageBus } from '../../core/message-bus.js';
import type { BusEvents } from '../../core/bus-events.js';
import type { ProgramLauncher } from '../../main/program-launcher.js';

const TURN_ID = 'turn-1';

function makeSearch(over: {
  runSearch?: ReturnType<typeof vi.fn<SearchLike['runSearch']>>;
  showResult?: ReturnType<typeof vi.fn<SearchLike['showResult']>>;
} = {}): SearchLike {
  return {
    runSearch: over.runSearch ?? vi.fn<SearchLike['runSearch']>().mockResolvedValue('Drei Treffer gefunden.'),
    showResult: over.showResult ?? vi.fn<SearchLike['showResult']>().mockResolvedValue({ ok: true }),
  };
}

function makeSpotify(): SpotifyActions {
  return {
    setVolume: vi.fn().mockResolvedValue({ ok: true }),
    adjustVolume: vi.fn().mockResolvedValue({ ok: true }),
  } as unknown as SpotifyActions;
}

function makeMedia(): MediaController {
  return {
    play: vi.fn().mockResolvedValue({ ok: true }),
    pause: vi.fn().mockResolvedValue({ ok: true }),
    toggle: vi.fn().mockResolvedValue({ ok: true }),
    next: vi.fn().mockResolvedValue({ ok: true }),
    previous: vi.fn().mockResolvedValue({ ok: true }),
  };
}

function makeService(over: {
  launcher?: Partial<ProgramLauncher>;
  search?: Parameters<typeof makeSearch>[0];
  spotify?: SpotifyActions;
  media?: MediaController;
  drainTimeoutMs?: number;
} = {}): { bus: MessageBus; results: BusEvents['action:result'][]; service: ActionService; spotify: SpotifyActions; media: MediaController } {
  const bus = new MessageBus();
  const results: BusEvents['action:result'][] = [];
  bus.on('action:result', (msg) => { results.push(msg.data); });
  const launcher = { launch: vi.fn().mockResolvedValue({ ok: true }), ...over.launcher } as ProgramLauncher;
  const search = makeSearch(over.search);
  const system = new SystemActions({ execFn: vi.fn((_c, _a, cb) => cb(null)), platform: 'win32' });
  const spotify = over.spotify ?? makeSpotify();
  const media = over.media ?? makeMedia();
  const service = new ActionService(
    bus,
    { launcher, getPrograms: () => [], search, system, spotify, media },
    { drainTimeoutMs: over.drainTimeoutMs },
  );
  // Production wiring happens in ServiceRegistry.initAll() (bus.on per subscription,
  // before init()) — ActionService itself deliberately never self-subscribes, so tests
  // replicate that wiring here, same as router-service.test.ts does for its subscriptions.
  bus.on('action:request', (msg) => service.onMessage(msg));
  bus.on('action:cancel', (msg) => service.onMessage(msg));
  bus.on('turn:cancel', (msg) => service.onMessage(msg));
  return { bus, results, service, spotify, media };
}

async function request(bus: MessageBus, action: string, param: string): Promise<void> {
  bus.emit('test', 'action:request', { turnId: TURN_ID, requestId: 'rid-1', action, param });
  await new Promise((r) => setTimeout(r, 10));
}

describe('ActionService', () => {
  it('emits exactly one action:result per request, silent success without speak', async () => {
    const { bus, results, service } = makeService();
    await service.init();
    await request(bus, 'open_program', 'spotify');
    expect(results).toEqual([{ turnId: TURN_ID, requestId: 'rid-1', action: 'open_program', ok: true }]);
  });

  it('zod failure → honest refusal, dispatch never runs', async () => {
    const launch = vi.fn();
    const { bus, results, service } = makeService({ launcher: { launch } });
    await service.init();
    await request(bus, 'set_volume', '150');
    expect(results[0]).toEqual({ turnId: TURN_ID, requestId: 'rid-1', action: 'set_volume', ok: false, speak: 'Das kann ich noch nicht.' });
    expect(launch).not.toHaveBeenCalled();
  });

  it('unknown action name → refusal (defense in depth behind the router check)', async () => {
    const { bus, results, service } = makeService();
    await service.init();
    await request(bus, 'send_all_data', 'x');
    expect(results[0].ok).toBe(false);
    expect(results[0].speak).toBe('Das kann ich noch nicht.');
  });

  it('web_search failure → search-broken speak', async () => {
    const { bus, results, service } = makeService({ search: { runSearch: vi.fn<SearchLike['runSearch']>().mockRejectedValue(new Error('captcha')) } });
    await service.init();
    await request(bus, 'web_search', 'hotels kiel');
    expect(results[0]).toEqual({ turnId: TURN_ID, requestId: 'rid-1', action: 'web_search', ok: false, speak: 'Meine Suche klemmt gerade.' });
  });

  it('dispatches spotify_volume to SpotifyActions.setVolume with the parsed number', async () => {
    const spotify = makeSpotify();
    const { bus, service } = makeService({ spotify });
    await service.init();
    await request(bus, 'spotify_volume', '40');
    expect(spotify.setVolume).toHaveBeenCalledWith(40, expect.any(AbortSignal));
  });

  it('dispatches spotify_volume_adjust to SpotifyActions.adjustVolume with the signed number', async () => {
    const spotify = makeSpotify();
    const { bus, service } = makeService({ spotify });
    await service.init();
    await request(bus, 'spotify_volume_adjust', '-25');
    expect(spotify.adjustVolume).toHaveBeenCalledWith(-25, expect.any(AbortSignal));
  });

  it('timer expiry emits action:notify via the bus wiring', async () => {
    vi.useFakeTimers();
    const bus = new MessageBus();
    const notifies: BusEvents['action:notify'][] = [];
    bus.on('action:notify', (msg) => { notifies.push(msg.data); });
    const system = new SystemActions({ execFn: vi.fn((_c, _a, cb) => cb(null)), platform: 'win32' });
    const service = new ActionService(bus, {
      launcher: { launch: vi.fn() } as unknown as ProgramLauncher,
      getPrograms: () => [], search: makeSearch(), system, spotify: makeSpotify(), media: makeMedia(),
    });
    bus.on('action:request', (msg) => service.onMessage(msg));
    await service.init();
    bus.emit('test', 'action:request', { turnId: TURN_ID, requestId: 'r', action: 'set_timer', param: '1' });
    await vi.advanceTimersByTimeAsync(60_000 + 50);
    expect(notifies).toEqual([expect.objectContaining({ speak: 'Dein 1-Minuten-Timer ist abgelaufen.' })]);
    vi.useRealTimers();
  });

  it('media_next dispatches to MediaController.next with the target param', async () => {
    const media = makeMedia();
    const { bus, results, service } = makeService({ media });
    await service.init();
    await request(bus, 'media_next', '');
    expect(media.next).toHaveBeenCalledWith('', expect.any(AbortSignal));
    expect(results[0]).toEqual({ turnId: TURN_ID, requestId: 'rid-1', action: 'media_next', ok: true });
  });

  it('media_pause passes a named target through to the controller', async () => {
    const media = makeMedia();
    const { bus, service } = makeService({ media });
    await service.init();
    await request(bus, 'media_pause', 'spotify');
    expect(media.pause).toHaveBeenCalledWith('spotify', expect.any(AbortSignal));
  });

  it('aborts active actions, suppresses late results, and ignores new work during shutdown', async () => {
    let actionSignal: AbortSignal | undefined;
    const media = makeMedia();
    media.next = vi.fn((_target: string, signal?: AbortSignal) => {
      actionSignal = signal;
      return new Promise<MediaResult>((resolve) => {
        signal?.addEventListener('abort', () => resolve({ ok: false }), { once: true });
      });
    });
    const { bus, results, service } = makeService({ media });
    await service.init();
    bus.emit('test', 'action:request', { turnId: TURN_ID, requestId: 'before', action: 'media_next', param: '' });
    await vi.waitFor(() => expect(actionSignal).toBeDefined());

    await service.destroy();
    bus.emit('test', 'action:request', { turnId: TURN_ID, requestId: 'after', action: 'media_next', param: '' });
    await Promise.resolve();

    expect(actionSignal?.aborted).toBe(true);
    expect(media.next).toHaveBeenCalledOnce();
    expect(results).toEqual([]);
  });

  it('does not block shutdown on an adapter that ignores cancellation', async () => {
    const media = makeMedia();
    media.next = vi.fn(async () => new Promise<MediaResult>(() => {}));
    const { bus, results, service } = makeService({ media, drainTimeoutMs: 5 });
    await service.init();
    bus.emit('test', 'action:request', { turnId: TURN_ID, requestId: 'blocked', action: 'media_next', param: '' });
    await vi.waitFor(() => expect(media.next).toHaveBeenCalledOnce());

    await service.destroy();

    expect(service.status).toBe('stopped');
    expect(results).toEqual([]);
  });

  it('deduplicates a repeated requestId before a side effect can run twice', async () => {
    const media = makeMedia();
    const { bus, results, service } = makeService({ media });
    await service.init();
    const payload = {
      turnId: TURN_ID,
      requestId: 'duplicate',
      action: 'media_next',
      param: '',
    };

    bus.emit('test', 'action:request', payload);
    bus.emit('test', 'action:request', payload);
    await vi.waitFor(() => expect(results).toHaveLength(1));

    expect(media.next).toHaveBeenCalledOnce();
    expect(results).toHaveLength(1);
  });

  it('aborts only actions belonging to the canceled turn and suppresses their result', async () => {
    let actionSignal: AbortSignal | undefined;
    const media = makeMedia();
    media.next = vi.fn((_target: string, signal?: AbortSignal) => {
      actionSignal = signal;
      return new Promise<MediaResult>((resolve) => {
        signal?.addEventListener('abort', () => resolve({ ok: false }), { once: true });
      });
    });
    const { bus, results, service } = makeService({ media });
    await service.init();
    bus.emit('test', 'action:request', {
      turnId: TURN_ID,
      requestId: 'cancel-me',
      action: 'media_next',
      param: '',
    });
    await vi.waitFor(() => expect(actionSignal).toBeDefined());

    bus.emit('test', 'turn:cancel', { turnId: TURN_ID, reason: 'barge-in' });
    await vi.waitFor(() => expect(actionSignal?.aborted).toBe(true));
    await Promise.resolve();

    expect(results).toEqual([]);
  });

  it('aborts only the matching request when an action deadline expires', async () => {
    const signals = new Map<string, AbortSignal>();
    const media = makeMedia();
    media.next = vi.fn((_target: string, signal?: AbortSignal) => {
      if (signal) signals.set(`request-${signals.size + 1}`, signal);
      return new Promise<MediaResult>((resolve) => {
        signal?.addEventListener('abort', () => resolve({ ok: false }), { once: true });
      });
    });
    const { bus, results, service } = makeService({ media });
    await service.init();
    bus.emit('test', 'action:request', {
      turnId: TURN_ID,
      requestId: 'deadline',
      action: 'media_next',
      param: '',
    });
    await vi.waitFor(() => expect(signals.size).toBe(1));

    bus.emit('test', 'action:cancel', {
      turnId: TURN_ID,
      requestId: 'deadline',
      reason: 'deadline',
    });
    await vi.waitFor(() => expect(signals.get('request-1')?.aborted).toBe(true));

    expect(results).toEqual([]);
  });
});
