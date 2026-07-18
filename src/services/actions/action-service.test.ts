import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ActionService } from './action-service.js';
import type { SearchLike } from './action-service.js';
import { SystemActions } from './system-actions.js';
import type { SpotifyActions } from './spotify-actions.js';
import { MessageBus } from '../../core/message-bus.js';
import type { BusEvents } from '../../core/bus-events.js';
import type { ProgramLauncher } from '../../main/program-launcher.js';

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

function makeService(over: {
  launcher?: Partial<ProgramLauncher>;
  search?: Parameters<typeof makeSearch>[0];
  spotify?: SpotifyActions;
} = {}): { bus: MessageBus; results: BusEvents['action:result'][]; service: ActionService; spotify: SpotifyActions } {
  const bus = new MessageBus();
  const results: BusEvents['action:result'][] = [];
  bus.on('action:result', (msg) => { results.push(msg.data); });
  const launcher = { launch: vi.fn().mockResolvedValue({ ok: true }), ...over.launcher } as ProgramLauncher;
  const search = makeSearch(over.search);
  const system = new SystemActions({ execFn: vi.fn((_c, _a, cb) => cb(null)), platform: 'win32' });
  const spotify = over.spotify ?? makeSpotify();
  const service = new ActionService(bus, { launcher, getPrograms: () => [], search, system, spotify });
  // Production wiring happens in ServiceRegistry.initAll() (bus.on per subscription,
  // before init()) — ActionService itself deliberately never self-subscribes, so tests
  // replicate that wiring here, same as router-service.test.ts does for its subscriptions.
  bus.on('action:request', (msg) => service.onMessage(msg));
  return { bus, results, service, spotify };
}

async function request(bus: MessageBus, action: string, param: string): Promise<void> {
  bus.emit('test', 'action:request', { requestId: 'rid-1', action, param });
  await new Promise((r) => setTimeout(r, 10));
}

describe('ActionService', () => {
  it('emits exactly one action:result per request, silent success without speak', async () => {
    const { bus, results, service } = makeService();
    await service.init();
    await request(bus, 'open_program', 'spotify');
    expect(results).toEqual([{ requestId: 'rid-1', action: 'open_program', ok: true }]);
  });

  it('zod failure → honest refusal, dispatch never runs', async () => {
    const launch = vi.fn();
    const { bus, results, service } = makeService({ launcher: { launch } });
    await service.init();
    await request(bus, 'set_volume', '150');
    expect(results[0]).toEqual({ requestId: 'rid-1', action: 'set_volume', ok: false, speak: 'Das kann ich noch nicht.' });
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
    expect(results[0]).toEqual({ requestId: 'rid-1', action: 'web_search', ok: false, speak: 'Meine Suche klemmt gerade.' });
  });

  it('dispatches spotify_volume to SpotifyActions.setVolume with the parsed number', async () => {
    const spotify = makeSpotify();
    const { bus, service } = makeService({ spotify });
    await service.init();
    await request(bus, 'spotify_volume', '40');
    expect(spotify.setVolume).toHaveBeenCalledWith(40);
  });

  it('dispatches spotify_volume_adjust to SpotifyActions.adjustVolume with the signed number', async () => {
    const spotify = makeSpotify();
    const { bus, service } = makeService({ spotify });
    await service.init();
    await request(bus, 'spotify_volume_adjust', '-25');
    expect(spotify.adjustVolume).toHaveBeenCalledWith(-25);
  });

  it('timer expiry emits action:notify via the bus wiring', async () => {
    vi.useFakeTimers();
    const bus = new MessageBus();
    const notifies: BusEvents['action:notify'][] = [];
    bus.on('action:notify', (msg) => { notifies.push(msg.data); });
    const system = new SystemActions({ execFn: vi.fn((_c, _a, cb) => cb(null)), platform: 'win32' });
    const service = new ActionService(bus, {
      launcher: { launch: vi.fn() } as unknown as ProgramLauncher,
      getPrograms: () => [], search: makeSearch(), system, spotify: makeSpotify(),
    });
    bus.on('action:request', (msg) => service.onMessage(msg));
    await service.init();
    bus.emit('test', 'action:request', { requestId: 'r', action: 'set_timer', param: '1' });
    await vi.advanceTimersByTimeAsync(60_000 + 50);
    expect(notifies).toEqual([{ speak: 'Dein 1-Minuten-Timer ist abgelaufen.' }]);
    vi.useRealTimers();
  });
});
