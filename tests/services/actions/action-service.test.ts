import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ActionService } from '../../../src/services/actions/action-service.js';
import type { ActionDeps, SearchLike } from '../../../src/services/actions/action-service.js';
import { SystemActions } from '../../../src/services/actions/system-actions.js';
import type { SpotifyActions } from '../../../src/services/actions/spotify-actions.js';
import type { MediaController, MediaResult } from '../../../src/services/actions/media-controller.js';
import { MessageBus } from '../../../src/core/message-bus.js';
import type { BusEvents } from '../../../src/core/bus-events.js';
import type { ProgramLauncher } from '../../../src/main/program-launcher.js';
import { ActionConfirmationGate, type ConfirmationLevel } from '../../../src/core/action-confirmation.js';
import type { ReminderClock } from '../../../src/services/actions/reminder-contract.js';
import type { TurnPersistencePolicy } from '../../../src/core/memory-policy.js';
import type { ActionIntent } from '../../../src/core/action-intent.js';

const TURN_ID = 'turn-1';

function testIntent(action: string, param: string, sourceTurnId = TURN_ID): ActionIntent {
  return {
    action,
    param,
    provenance: {
      sourceTurnId,
      decisionSource: 'router_model',
      evidenceSource: 'user_text',
      validation: 'schema_only',
      evidenceScope: { kind: 'whole_turn' },
    },
  };
}

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

function makeReminders(): ActionDeps['reminders'] {
  return {
    create: vi.fn().mockImplementation(async (input: { dueLocal: string; text: string }) => ({
      kind: 'reminder' as const,
      id: 1,
      ...input,
    })),
    list: vi.fn().mockResolvedValue([]),
    cancel: vi.fn().mockResolvedValue({ status: 'none', cancelled: [], candidates: [] }),
  };
}

function makeService(over: {
  launcher?: Partial<ProgramLauncher>;
  search?: Parameters<typeof makeSearch>[0];
  spotify?: SpotifyActions;
  media?: MediaController;
  system?: SystemActions;
  drainTimeoutMs?: number;
  confirmationGate?: ActionConfirmationGate;
  confirmationLevel?: ConfirmationLevel;
  webAccessAllowed?: boolean;
  reminders?: ActionDeps['reminders'];
  reminderClock?: ReminderClock;
  reminderPersistencePolicy?: TurnPersistencePolicy;
} = {}): { bus: MessageBus; results: BusEvents['action:result'][]; service: ActionService; spotify: SpotifyActions; media: MediaController; system: SystemActions } {
  const bus = new MessageBus();
  const results: BusEvents['action:result'][] = [];
  bus.on('action:result', (msg) => { results.push(msg.data); });
  const launcher = { launch: vi.fn().mockResolvedValue({ ok: true }), ...over.launcher } as ProgramLauncher;
  const search = makeSearch(over.search);
  const system = over.system ?? new SystemActions({ execFn: vi.fn((_c, _a, cb) => cb(null)), platform: 'win32' });
  const spotify = over.spotify ?? makeSpotify();
  const media = over.media ?? makeMedia();
  const service = new ActionService(
    bus,
    {
      launcher,
      getPrograms: () => [],
      search,
      system,
      spotify,
      media,
      reminders: over.reminders ?? makeReminders(),
      reminderClock: over.reminderClock,
      confirmationGate: over.confirmationGate,
      getConfirmationLevel: () => over.confirmationLevel ?? 'standard',
      getFileAccess: () => 'specific-folders',
      getWebAccessAllowed: () => over.webAccessAllowed ?? true,
      getReminderPersistencePolicy: () => over.reminderPersistencePolicy
        ?? { allowed: true, exclusions: [] },
    },
    { drainTimeoutMs: over.drainTimeoutMs },
  );
  // Production wiring happens in ServiceRegistry.initAll() (bus.on per subscription,
  // before init()) — ActionService itself deliberately never self-subscribes, so tests
  // replicate that wiring here, same as router-service.test.ts does for its subscriptions.
  bus.on('action:request', (msg) => service.onMessage(msg));
  bus.on('action:cancel', (msg) => service.onMessage(msg));
  bus.on('turn:cancel', (msg) => service.onMessage(msg));
  bus.on('turn:terminal', (msg) => service.onMessage(msg));
  return { bus, results, service, spotify, media, system };
}

async function request(
  bus: MessageBus,
  action: string,
  param: string,
  confirmation?: BusEvents['action:request']['confirmation'],
  context?: Pick<BusEvents['action:request'], 'originMode' | 'privateContext'>,
): Promise<void> {
  bus.emit('test', 'action:request', {
    turnId: TURN_ID,
    requestId: 'rid-1',
    ...testIntent(action, param),
    ...(confirmation ? { confirmation } : {}),
    ...context,
  });
  await new Promise((r) => setTimeout(r, 10));
}

describe('ActionService', () => {
  it('runs a web search without per-action confirmation when browser access is enabled', async () => {
    const runSearch = vi.fn<SearchLike['runSearch']>().mockResolvedValue('Ein Treffer.');
    const { bus, results, service } = makeService({
      search: { runSearch },
      confirmationLevel: 'maximal',
      webAccessAllowed: true,
    });
    await service.init();

    await request(bus, 'web_search', 'OWASP');

    expect(runSearch).toHaveBeenCalledOnce();
    expect(results[0]).toMatchObject({ ok: true, speak: 'Ein Treffer.' });
  });

  it('blocks search before the provider when browser access is disabled', async () => {
    const runSearch = vi.fn<SearchLike['runSearch']>();
    const { bus, results, service } = makeService({
      search: { runSearch },
      webAccessAllowed: false,
    });
    await service.init();

    await request(bus, 'web_search', 'OWASP');

    expect(runSearch).not.toHaveBeenCalled();
    expect(results[0]).toMatchObject({
      ok: false,
      speak: 'Der Browserzugriff ist in den Einstellungen deaktiviert.',
    });
  });

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

  it('rejects an action intent whose provenance belongs to another turn', async () => {
    const media = makeMedia();
    const { bus, results, service } = makeService({ media });
    await service.init();

    bus.emit('test', 'action:request', {
      turnId: TURN_ID,
      requestId: 'foreign-provenance',
      ...testIntent('media_next', '', 'another-turn'),
    });
    await vi.waitFor(() => expect(results).toHaveLength(1));

    expect(media.next).not.toHaveBeenCalled();
    expect(results[0]).toMatchObject({
      action: 'media_next',
      ok: false,
      speak: 'Diese Aktion ist nicht eindeutig dem aktuellen Auftrag zugeordnet.',
    });
  });

  it('unknown action name → refusal (defense in depth behind the router check)', async () => {
    const { bus, results, service } = makeService();
    await service.init();
    await request(bus, 'send_all_data', 'x');
    expect(results[0].ok).toBe(false);
    expect(results[0].speak).toBe('Das kann ich noch nicht.');
  });

  it('web_search failure → search-broken speak', async () => {
    const { bus, results, service } = makeService({
      search: { runSearch: vi.fn<SearchLike['runSearch']>().mockRejectedValue(new Error('captcha')) },
    });
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
      getPrograms: () => [], search: makeSearch(), system, spotify: makeSpotify(), media: makeMedia(), reminders: makeReminders(),
      getConfirmationLevel: () => 'standard', getFileAccess: () => 'specific-folders', getWebAccessAllowed: () => true,
    });
    bus.on('action:request', (msg) => service.onMessage(msg));
    await service.init();
    bus.emit('test', 'action:request', {
      turnId: TURN_ID,
      requestId: 'r',
      ...testIntent('set_timer', '1'),
      originMode: 'chat',
      privateContext: true,
    });
    await vi.advanceTimersByTimeAsync(60_000 + 50);
    expect(notifies).toEqual([expect.objectContaining({
      kind: 'timer',
      speak: 'Dein 1-Minuten-Timer ist abgelaufen.',
      originMode: 'chat',
      privateContext: true,
    })]);
    vi.useRealTimers();
  });

  it('parses canonical Timer V2 requests only immediately before SystemActions', async () => {
    const system = new SystemActions({ execFn: vi.fn((_c, _a, cb) => cb(null)), platform: 'win32' });
    const setTimer = vi.spyOn(system, 'setTimer').mockReturnValue({ ok: true });
    const { bus, results, service } = makeService({ system });
    await service.init();

    await request(bus, 'set_timer', '5m30s|Brötchen');

    expect(setTimer).toHaveBeenCalledWith(
      { durationSeconds: 330, label: 'Brötchen' },
      expect.any(AbortSignal),
      { originMode: 'voice', privateContext: false },
    );
    expect(results[0]).toMatchObject({ action: 'set_timer', ok: true });
  });

  it('keeps legacy bare timer integers backward compatible as minutes', async () => {
    const system = new SystemActions({ execFn: vi.fn((_c, _a, cb) => cb(null)), platform: 'win32' });
    const setTimer = vi.spyOn(system, 'setTimer').mockReturnValue({ ok: true });
    const { bus, service } = makeService({ system });
    await service.init();

    await request(bus, 'set_timer', '1');

    expect(setTimer).toHaveBeenCalledWith(
      { durationSeconds: 60 },
      expect.any(AbortSignal),
      { originMode: 'voice', privateContext: false },
    );
  });

  it('resolves and persists a canonical relative reminder', async () => {
    const reminders = makeReminders();
    const nowMs = Date.parse('2026-08-30T10:15:00.000Z');
    const reminderClock: ReminderClock = {
      nowMs: () => nowMs,
      toLocal: (epochMs) => new Date(epochMs).toISOString().slice(0, 16),
    };
    const { bus, results, service } = makeService({ reminders, reminderClock });
    await service.init();

    await request(bus, 'set_reminder', 'after=30m|text=Steuerberater anrufen', undefined, {
      originMode: 'chat',
      privateContext: false,
    });

    expect(reminders.create).toHaveBeenCalledWith({
      dueLocal: '2026-08-30T10:45',
      text: 'Steuerberater anrufen',
      originMode: 'chat',
      privateContext: false,
    }, expect.any(AbortSignal));
    expect(results[0]).toMatchObject({
      action: 'set_reminder',
      ok: true,
      speak: 'Ich erinnere dich um 10:45 Uhr: Steuerberater anrufen.',
    });
  });

  it.each([
    ['at=tomorrow@10:45|text=Steuerberater anrufen', 'Ich erinnere dich morgen um 10:45 Uhr: Steuerberater anrufen.'],
    ['at=date:2026-09-03@10:45|text=Steuerberater anrufen', 'Ich erinnere dich am 3.9.2026 um 10:45 Uhr: Steuerberater anrufen.'],
  ])('uses a natural day label in reminder confirmations for %s', async (param, expectedSpeech) => {
    const nowMs = Date.parse('2026-08-30T10:15:00.000Z');
    const reminderClock: ReminderClock = {
      nowMs: () => nowMs,
      toLocal: (epochMs) => new Date(epochMs).toISOString().slice(0, 16),
    };
    const { bus, results, service } = makeService({ reminderClock });
    await service.init();

    await request(bus, 'set_reminder', param, undefined, {
      originMode: 'chat',
      privateContext: false,
    });

    expect(results[0]).toMatchObject({ ok: true, speak: expectedSpeech });
  });

  it.each([
    {
      name: 'deaktiviertem Memory',
      param: 'after=30m|text=Steuerberater anrufen',
      policy: { allowed: false, exclusions: [] },
      privateContext: false,
    },
    {
      name: 'passendem Ausschluss',
      param: 'after=30m|text=Blutdruck beim Hausarzt messen',
      policy: { allowed: true, exclusions: ['Gesundheit'] },
      privateContext: false,
    },
    {
      name: 'unbedingt privatem Inhalt',
      param: 'after=30m|text=Passwort ist Fuchs-17',
      policy: { allowed: true, exclusions: [] },
      privateContext: false,
    },
    {
      name: 'privatem Kontext',
      param: 'after=30m|text=Steuerberater anrufen',
      policy: { allowed: true, exclusions: [] },
      privateContext: true,
    },
  ] satisfies Array<{
    name: string;
    param: string;
    policy: TurnPersistencePolicy;
    privateContext: boolean;
  }>)('verweigert Reminder-Persistenz bei $name', async ({ param, policy, privateContext }) => {
    const reminders = makeReminders();
    const { bus, results, service } = makeService({
      reminders,
      reminderPersistencePolicy: policy,
    });
    await service.init();

    await request(bus, 'set_reminder', param, undefined, {
      originMode: 'chat',
      privateContext,
    });

    expect(reminders.create).not.toHaveBeenCalled();
    expect(results[0]).toMatchObject({
      action: 'set_reminder',
      ok: false,
      speak: expect.stringContaining('Datenschutzgründen'),
    });
  });

  it('lists reminders chronologically through the reminder service', async () => {
    const reminders = makeReminders();
    vi.mocked(reminders.list).mockResolvedValue([
      { kind: 'reminder', id: 1, dueLocal: '2026-08-30T11:00', text: 'Steuerberater anrufen' },
      { kind: 'reminder', id: 2, dueLocal: '2026-08-30T12:30', text: 'Losfahren' },
    ]);
    const { bus, results, service } = makeService({ reminders });
    await service.init();

    await request(bus, 'list_reminders', 'today');

    expect(reminders.list).toHaveBeenCalledWith('today', expect.any(AbortSignal));
    expect(results[0]).toMatchObject({
      action: 'list_reminders',
      ok: true,
      speak: expect.stringContaining('2 Erinnerungen'),
    });
  });

  it('does not cancel any reminder when the domain reports ambiguity', async () => {
    const reminders = makeReminders();
    vi.mocked(reminders.cancel).mockResolvedValue({
      status: 'ambiguous',
      cancelled: [],
      candidates: [
        { kind: 'reminder', id: 1, dueLocal: '2026-08-30T11:00', text: 'Steuerberater' },
        { kind: 'reminder', id: 2, dueLocal: '2026-08-30T12:00', text: 'Steuerberater' },
      ],
    });
    const { bus, results, service } = makeService({ reminders });
    await service.init();

    await request(bus, 'cancel_reminder', 'text=Steuerberater');

    expect(results[0]).toMatchObject({
      action: 'cancel_reminder',
      ok: false,
      speak: expect.stringContaining('mehrere passende Erinnerungen'),
      reminderCancelAmbiguity: {
        candidates: [
          { id: 1, dueLocal: '2026-08-30T11:00' },
          { id: 2, dueLocal: '2026-08-30T12:00' },
        ],
      },
    });
    expect(results[0].speak).toContain('Die um 17:05 Uhr');
    expect(results[0].reminderCancelAmbiguity?.candidates[0]).not.toHaveProperty('text');
  });

  it.each([
    ['label=Eier', { kind: 'label', label: 'Eier' }],
    ['duration=30s', { kind: 'duration', durationSeconds: 30 }],
    ['all', { kind: 'all' }],
  ] as const)('dispatches cancel_timer selector %s without confirmation', async (param, expected) => {
    const system = new SystemActions({ execFn: vi.fn((_c, _a, cb) => cb(null)), platform: 'win32' });
    const cancelTimers = vi.spyOn(system, 'cancelTimers').mockReturnValue({ ok: true });
    const { bus, results, service } = makeService({ system });
    await service.init();

    await request(bus, 'cancel_timer', param);

    expect(cancelTimers).toHaveBeenCalledWith(expected);
    expect(results[0]).toMatchObject({ action: 'cancel_timer', ok: true });
  });

  it('forwards honest cancel_timer feedback in the correlated action result', async () => {
    const system = new SystemActions({ execFn: vi.fn((_c, _a, cb) => cb(null)), platform: 'win32' });
    vi.spyOn(system, 'cancelTimers').mockReturnValue({
      ok: false,
      speak: 'Es laufen mehrere Timer mit 30 Sekunden. Bitte nenne den Timer-Namen.',
    });
    const { bus, results, service } = makeService({ system });
    await service.init();

    await request(bus, 'cancel_timer', 'duration=30s');

    expect(results[0]).toEqual({
      turnId: TURN_ID,
      requestId: 'rid-1',
      action: 'cancel_timer',
      ok: false,
      speak: 'Es laufen mehrere Timer mit 30 Sekunden. Bitte nenne den Timer-Namen.',
    });
  });

  it.each([
    ['set_timer', '30 seconds'],
    ['cancel_timer', 'Eier'],
  ] as const)('rejects invalid %s parameters before touching SystemActions', async (action, param) => {
    const system = new SystemActions({ execFn: vi.fn((_c, _a, cb) => cb(null)), platform: 'win32' });
    const setTimer = vi.spyOn(system, 'setTimer');
    const cancelTimers = vi.spyOn(system, 'cancelTimers');
    const { bus, results, service } = makeService({ system });
    await service.init();

    await request(bus, action, param);

    expect(setTimer).not.toHaveBeenCalled();
    expect(cancelTimers).not.toHaveBeenCalled();
    expect(results[0]).toMatchObject({ action, ok: false, speak: 'Das kann ich noch nicht.' });
  });

  it('removes a timer when its turn is canceled before the action result is delivered', async () => {
    vi.useFakeTimers();
    const bus = new MessageBus();
    const notifies: BusEvents['action:notify'][] = [];
    bus.on('action:notify', (msg) => { notifies.push(msg.data); });
    const system = new SystemActions({ execFn: vi.fn((_c, _a, cb) => cb(null)), platform: 'win32' });
    const service = new ActionService(bus, {
      launcher: { launch: vi.fn() } as unknown as ProgramLauncher,
      getPrograms: () => [], search: makeSearch(), system, spotify: makeSpotify(), media: makeMedia(), reminders: makeReminders(),
      getConfirmationLevel: () => 'standard', getFileAccess: () => 'specific-folders', getWebAccessAllowed: () => true,
    });
    bus.on('action:request', (msg) => service.onMessage(msg));
    bus.on('turn:cancel', (msg) => service.onMessage(msg));
    await service.init();

    bus.emit('test', 'action:request', {
      turnId: TURN_ID,
      requestId: 'timer',
      ...testIntent('set_timer', '1'),
    });
    bus.emit('test', 'turn:cancel', { turnId: TURN_ID, reason: 'barge-in' });
    await vi.advanceTimersByTimeAsync(60_000 + 50);

    expect(notifies).toEqual([]);
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

  it('refuses a mutating action at maximal level without exact turn/action approval', async () => {
    const media = makeMedia();
    const { bus, results, service } = makeService({ media, confirmationLevel: 'maximal' });
    await service.init();

    await request(bus, 'media_next', '');

    expect(media.next).not.toHaveBeenCalled();
    expect(results[0]).toMatchObject({
      action: 'media_next',
      ok: false,
      speak: 'Diese Aktion wurde nicht bestätigt.',
    });
  });

  it('requires confirmation for a sensitive action at standard but not minimal level', async () => {
    const standard = makeService({ confirmationLevel: 'standard' });
    await standard.service.init();
    await request(standard.bus, 'lock_screen', '');
    expect(standard.results[0]).toMatchObject({ ok: false, speak: 'Diese Aktion wurde nicht bestätigt.' });

    const minimal = makeService({ confirmationLevel: 'minimal' });
    await minimal.service.init();
    await request(minimal.bus, 'lock_screen', '');
    expect(minimal.results[0]).toMatchObject({ ok: true });
  });

  it('requires confirmation at minimal level before cancelling every reminder', async () => {
    const reminders = makeReminders();
    const current = makeService({ reminders, confirmationLevel: 'minimal' });
    await current.service.init();

    await request(current.bus, 'cancel_reminder', 'all');

    expect(reminders.cancel).not.toHaveBeenCalled();
    expect(current.results[0]).toMatchObject({
      action: 'cancel_reminder',
      ok: false,
      speak: 'Diese Aktion wurde nicht bestätigt.',
    });
  });

  it.each(['minimal', 'standard', 'maximal'] as const)(
    'uses the persistent web grant without per-search confirmation at %s level',
    async (confirmationLevel) => {
      const runSearch = vi.fn<SearchLike['runSearch']>().mockResolvedValue('private result');
      const current = makeService({ search: { runSearch }, confirmationLevel });
      await current.service.init();

      await request(current.bus, 'web_search', 'private query');

      expect(runSearch).toHaveBeenCalledOnce();
      expect(current.results[0]).toMatchObject({
        action: 'web_search',
        ok: true,
        speak: 'private result',
      });
    },
  );

  it('never writes action parameters or response text to diagnostic logs', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { bus, service } = makeService({
      search: { runSearch: vi.fn<SearchLike['runSearch']>().mockResolvedValue('private result') },
    });
    await service.init();
    await request(bus, 'web_search', 'private query');
    const logged = [...log.mock.calls, ...warn.mock.calls].flat().join(' ');
    expect(logged).not.toContain('private query');
    expect(logged).not.toContain('private result');
  });

  it('consumes a matching confirmation once and rejects reuse for another request', async () => {
    const confirmationGate = new ActionConfirmationGate();
    const media = makeMedia();
    const { bus, results, service } = makeService({
      media,
      confirmationGate,
      confirmationLevel: 'maximal',
    });
    await service.init();
    const confirmationId = confirmationGate.request(
      'request-turn',
      testIntent('media_next', '', 'request-turn'),
      false,
    );
    const approved = confirmationGate.approve(confirmationId, TURN_ID);
    if (!approved) throw new Error('expected confirmation');
    const confirmation = approved.confirmation;

    bus.emit('test', 'action:request', {
      turnId: TURN_ID,
      requestId: 'approved',
      ...approved.intent,
      confirmation,
      originMode: approved.originMode,
    });
    await vi.waitFor(() => expect(results).toHaveLength(1));
    bus.emit('test', 'action:request', {
      turnId: TURN_ID,
      requestId: 'replay',
      ...approved.intent,
      confirmation,
      originMode: approved.originMode,
    });
    await vi.waitFor(() => expect(results).toHaveLength(2));

    expect(media.next).toHaveBeenCalledOnce();
    expect(results.map((result) => result.ok)).toEqual([true, false]);
  });

  it('does not accept a confirmation for a different turn or action', async () => {
    const confirmationGate = new ActionConfirmationGate();
    const media = makeMedia();
    const { bus, results, service } = makeService({
      media,
      confirmationGate,
      confirmationLevel: 'maximal',
    });
    await service.init();
    const confirmationId = confirmationGate.request(
      'request-turn',
      testIntent('media_next', '', 'request-turn'),
      false,
    );
    const approved = confirmationGate.approve(confirmationId, 'approved-turn');
    if (!approved) throw new Error('expected confirmation');

    bus.emit('test', 'action:request', {
      turnId: TURN_ID,
      requestId: 'wrong-turn',
      ...approved.intent,
      confirmation: approved.confirmation,
      originMode: approved.originMode,
    });
    await vi.waitFor(() => expect(results).toHaveLength(1));
    bus.emit('test', 'action:request', {
      turnId: 'approved-turn',
      requestId: 'wrong-action',
      ...approved.intent,
      action: 'media_pause',
      confirmation: approved.confirmation,
      originMode: approved.originMode,
    });
    await vi.waitFor(() => expect(results).toHaveLength(2));

    expect(media.next).not.toHaveBeenCalled();
    expect(media.pause).not.toHaveBeenCalled();
    expect(results.every((result) => !result.ok)).toBe(true);
  });

  it('rejects a confirmed request when its original private context or mode changes on the bus', async () => {
    const confirmationGate = new ActionConfirmationGate();
    const media = makeMedia();
    const { bus, results, service } = makeService({
      media,
      confirmationGate,
      confirmationLevel: 'maximal',
    });
    await service.init();
    const confirmationId = confirmationGate.request(
      'private-proposal',
      testIntent('media_next', '', 'private-proposal'),
      true,
    );
    const approved = confirmationGate.approve(confirmationId, TURN_ID);
    if (!approved) throw new Error('expected confirmation');

    bus.emit('test', 'action:request', {
      turnId: TURN_ID,
      requestId: 'privacy-downgrade',
      ...approved.intent,
      confirmation: approved.confirmation,
      privateContext: false,
      originMode: approved.originMode,
    });
    await vi.waitFor(() => expect(results).toHaveLength(1));
    expect(results[0]?.ok).toBe(false);
    expect(media.next).not.toHaveBeenCalled();

    bus.emit('test', 'action:request', {
      turnId: TURN_ID,
      requestId: 'mode-changed',
      ...approved.intent,
      confirmation: approved.confirmation,
      privateContext: true,
      originMode: 'voice',
    });
    await vi.waitFor(() => expect(results).toHaveLength(2));
    expect(results[1]?.ok).toBe(false);
    expect(media.next).not.toHaveBeenCalled();

    bus.emit('test', 'action:request', {
      turnId: TURN_ID,
      requestId: 'original-context-preserved',
      ...approved.intent,
      confirmation: approved.confirmation,
      privateContext: true,
      originMode: approved.originMode,
    });
    await vi.waitFor(() => expect(results).toHaveLength(3));
    expect(results[2]?.ok).toBe(true);
    expect(media.next).toHaveBeenCalledOnce();
  });

  it('passes the exact source search request to browser result selection', async () => {
    const showResult = vi.fn<SearchLike['showResult']>().mockResolvedValue({ ok: true });
    const { bus, results, service } = makeService({
      search: { showResult },
      confirmationLevel: 'maximal',
    });
    await service.init();

    bus.emit('test', 'action:request', {
      turnId: TURN_ID,
      requestId: 'show-request',
      ...testIntent('show_browser', '1'),
      sourceRequestId: 'search-a',
    });
    await vi.waitFor(() => expect(results).toHaveLength(1));
    expect(results[0].ok).toBe(true);
    expect(showResult).toHaveBeenCalledOnce();
    expect(showResult).toHaveBeenCalledWith(
      '1',
      expect.objectContaining({ sourceRequestId: 'search-a' }),
      expect.any(AbortSignal),
    );
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
    bus.emit('test', 'action:request', {
      turnId: TURN_ID,
      requestId: 'before',
      ...testIntent('media_next', ''),
    });
    await vi.waitFor(() => expect(actionSignal).toBeDefined());

    await service.destroy();
    bus.emit('test', 'action:request', {
      turnId: TURN_ID,
      requestId: 'after',
      ...testIntent('media_next', ''),
    });
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
    bus.emit('test', 'action:request', {
      turnId: TURN_ID,
      requestId: 'blocked',
      ...testIntent('media_next', ''),
    });
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
      ...testIntent('media_next', ''),
    };

    bus.emit('test', 'action:request', payload);
    bus.emit('test', 'action:request', payload);
    await vi.waitFor(() => expect(results).toHaveLength(1));

    expect(media.next).toHaveBeenCalledOnce();
    expect(results).toHaveLength(1);
  });

  it('refuses an action request after its owning turn is terminal', async () => {
    const media = makeMedia();
    const { bus, results, service } = makeService({ media });
    await service.init();
    bus.emit('test', 'turn:accepted', { turnId: TURN_ID, source: 'chat', mode: 'chat' });
    bus.emit('test', 'turn:terminal', { turnId: TURN_ID, status: 'canceled' });

    bus.emit('test', 'action:request', {
      turnId: TURN_ID,
      requestId: 'too-late',
      ...testIntent('media_next', ''),
    });
    await Promise.resolve();

    expect(media.next).not.toHaveBeenCalled();
    expect(results).toEqual([]);
  });

  it('suppresses a late action result when the turn became terminal in flight', async () => {
    let finish = (_result: MediaResult): void => {};
    let actionSignal: AbortSignal | undefined;
    const media = makeMedia();
    media.next = vi.fn((_target: string, signal?: AbortSignal) => {
      actionSignal = signal;
      return new Promise<MediaResult>((resolve) => { finish = resolve; });
    });
    const { bus, results, service } = makeService({ media });
    await service.init();
    bus.emit('test', 'turn:accepted', { turnId: TURN_ID, source: 'chat', mode: 'chat' });
    bus.emit('test', 'action:request', {
      turnId: TURN_ID,
      requestId: 'in-flight',
      ...testIntent('media_next', ''),
    });
    await vi.waitFor(() => expect(media.next).toHaveBeenCalledOnce());

    bus.emit('test', 'turn:terminal', { turnId: TURN_ID, status: 'error' });
    expect(actionSignal?.aborted).toBe(true);
    finish({ ok: true, speak: 'Zu spät.' });
    await Promise.resolve();
    await Promise.resolve();

    expect(results).toEqual([]);
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
      ...testIntent('media_next', ''),
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
      ...testIntent('media_next', ''),
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
