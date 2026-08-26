import { describe, it, expect, vi } from 'vitest';
import { WindowsMediaController, type HelperRunner } from './media-controller.js';

function controller(over: { run?: HelperRunner; platform?: string } = {}) {
  return new WindowsMediaController('C:/fake/media-helper.exe', {
    run: over.run ?? (async () => JSON.stringify({ success: true, app: 'Spotify.exe', status: 'paused' })),
    platform: over.platform ?? 'win32',
  });
}

describe('WindowsMediaController', () => {
  it('sends the correct action + target to the helper', async () => {
    const run = vi.fn<HelperRunner>().mockResolvedValue(JSON.stringify({ success: true, app: 'x', status: 'playing' }));
    const c = controller({ run });
    await c.pause('spotify');
    expect(JSON.parse(run.mock.calls[0][0])).toEqual({ action: 'media_pause', target: 'spotify' });
  });

  it('active session: empty target is passed through', async () => {
    const run = vi.fn<HelperRunner>().mockResolvedValue(JSON.stringify({ success: true, app: 'x', status: 'playing' }));
    await controller({ run }).next('');
    expect(JSON.parse(run.mock.calls[0][0])).toEqual({ action: 'media_next', target: '' });
  });

  it('success → silent ok', async () => {
    expect(await controller().play('')).toEqual({ ok: true });
  });

  it('maps each error code to an honest German speak', async () => {
    const cases: Array<[string, string]> = [
      ['NO_MEDIA_SESSION', 'Ich sehe gerade keine laufende Wiedergabe.'],
      ['NO_MATCHING_SESSION', 'Ich finde gerade keine passende Wiedergabe.'],
      ['ACTION_NOT_SUPPORTED', 'Das kann der aktuelle Player nicht.'],
      ['ACTION_FAILED', 'Das hat gerade nicht geklappt.'],
    ];
    for (const [error, speak] of cases) {
      const c = controller({ run: async () => JSON.stringify({ success: false, error }) });
      expect(await c.pause('')).toEqual({ ok: false, speak });
    }
  });

  it('unparseable helper output → generic speak', async () => {
    const c = controller({ run: async () => 'not json' });
    expect(await c.pause('')).toEqual({ ok: false, speak: 'Das hat gerade nicht geklappt.' });
  });

  it('runner throw (timeout/crash) → generic speak, does not reject', async () => {
    const c = controller({ run: async () => { throw new Error('media-helper timeout'); } });
    expect(await c.next('')).toEqual({ ok: false, speak: 'Das hat gerade nicht geklappt.' });
  });

  it('propagates shutdown abort to the helper runner', async () => {
    let helperSignal: AbortSignal | undefined;
    const run = vi.fn<HelperRunner>((_request, signal) => {
      helperSignal = signal;
      return new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('helper aborted')), { once: true });
      });
    });
    const c = controller({ run });
    const abort = new AbortController();

    const running = c.next('', abort.signal);
    abort.abort();

    await expect(running).rejects.toMatchObject({ name: 'AbortError' });
    expect(helperSignal?.aborted).toBe(true);
  });

  it('non-win32 → unsupported, never runs the helper', async () => {
    const run = vi.fn<HelperRunner>();
    const c = controller({ run, platform: 'linux' });
    expect(await c.pause('')).toEqual({ ok: false, speak: 'Das unterstützt dein System nicht.' });
    expect(run).not.toHaveBeenCalled();
  });
});
