import { describe, expect, it } from 'vitest';
import { createDecisionCapabilitySnapshot } from '../../../src/core/decision-context.js';
import type { Profile, Resources } from '../../../src/core/config-schema.js';
import type { TurnEnvelope } from '../../../src/core/turn-contract.js';
import { buildDecisionContext } from '../../../src/services/llm/decision-context-builder.js';

const capabilities = createDecisionCapabilitySnapshot({
  lifecycleGeneration: 4,
  modelExecutionMode: 'exclusive',
  router: { state: 'available', reason: 'ready' },
  localAnswer: { state: 'available', reason: 'ready' },
  actions: { state: 'available', reason: 'ready' },
  webSearch: { state: 'available', reason: 'ready' },
  visibleBrowserResult: { state: 'unavailable', reason: 'no_visible_result' },
  reminders: { state: 'available', reason: 'ready' },
  media: { state: 'unknown', reason: 'no_readiness_source' },
  specialists: {
    coding: { state: 'unavailable', reason: 'no_adapter' },
    research: { state: 'unavailable', reason: 'no_adapter' },
    vision: { state: 'unavailable', reason: 'no_adapter' },
  },
});

function envelope(effectiveText: string, command: TurnEnvelope['command'] = { kind: 'none' }): TurnEnvelope {
  return {
    turnId: 'turn-1',
    source: 'chat',
    mode: 'chat',
    originalText: effectiveText,
    normalizedText: effectiveText,
    effectiveText,
    createdAt: '2026-09-03T12:00:00.000Z',
    command,
  };
}

const profile: Pick<Profile, 'linkPreferences'> = {
  linkPreferences: [
    { id: 'booking', description: 'Hotels bevorzugt bei Booking suchen', url: 'https://booking.example/private' },
    { id: 'coding', description: 'Coding-Dokumentation bei W3Schools', url: 'https://w3schools.example/private' },
    { id: 'bikes', description: 'Fahrrad-Routen und Touren', url: 'https://bikes.example/private' },
  ],
};

function resources(): Pick<Resources, 'programs' | 'programRoles'> {
  return {
    programs: [
      {
        name: 'Visual Studio Code',
        path: 'C:\\private\\Code.exe',
        type: 'exe',
        source: 'detected',
        verified: true,
        aliases: ['VS Code'],
      },
      {
        name: 'Spotify',
        path: 'C:\\private\\Spotify.exe',
        type: 'exe',
        source: 'detected',
        verified: true,
        aliases: [],
      },
    ],
    programRoles: [
      { role: 'code_editor', programName: 'Visual Studio Code' },
      { role: 'music_player', programName: 'Spotify' },
    ],
  };
}

describe('buildDecisionContext', () => {
  it('projects verified explicit roles and relevant source hints without paths or URLs', () => {
    const context = buildDecisionContext({
      envelope: envelope('Suche mir ein Hotel und öffne meinen Editor'),
      privateContext: false,
      profile,
      resources: resources(),
      capabilities,
    });

    expect(context.programRoles).toEqual([
      { role: 'code_editor', programName: 'Visual Studio Code' },
      { role: 'music_player', programName: 'Spotify' },
    ]);
    expect(context.preferredSourceHints).toEqual([
      { id: 'booking', description: 'Hotels bevorzugt bei Booking suchen' },
    ]);
    expect(JSON.stringify(context)).not.toContain('C:\\private');
    expect(JSON.stringify(context)).not.toContain('https://');
    expect(Object.isFrozen(context)).toBe(true);
    expect(Object.isFrozen(context.programRoles)).toBe(true);
    expect(Object.isFrozen(context.capabilities)).toBe(true);
  });

  it('omits source hints when their id or description contains a URL literal', () => {
    const context = buildDecisionContext({
      envelope: envelope('Suche Hotels und Fahrräder'),
      privateContext: false,
      profile: {
        linkPreferences: [
          {
            id: 'https://secret.example/hotels',
            description: 'Hotels bevorzugt suchen',
            url: 'https://safe-storage.example/one',
          },
          {
            id: 'bikes',
            description: 'Fahrräder über https://secret.example/routes suchen',
            url: 'https://safe-storage.example/two',
          },
          {
            id: 'plain-domain',
            description: 'Hotels bei booking.example/private suchen',
            url: 'https://safe-storage.example/plain',
          },
          {
            id: 'booking',
            description: 'Hotels bevorzugt bei Booking suchen',
            url: 'https://safe-storage.example/three',
          },
        ],
      },
      resources: resources(),
      capabilities,
    });

    expect(context.preferredSourceHints).toEqual([
      { id: 'booking', description: 'Hotels bevorzugt bei Booking suchen' },
    ]);
    expect(JSON.stringify(context)).not.toContain('secret.example');
    expect(JSON.stringify(context)).not.toContain('booking.example');
  });

  it('omits role bindings whose canonical program name contains a Windows or Unix path', () => {
    const context = buildDecisionContext({
      envelope: envelope('Öffne meinen Editor und meinen Browser'),
      privateContext: false,
      profile,
      resources: {
        programs: [
          {
            name: 'Relative Editor ..\\secret\\Code.exe',
            path: '..\\secret\\Code.exe',
            type: 'exe',
            source: 'manual',
            verified: true,
            aliases: [],
          },
          {
            name: 'Editor C:\\secret\\Code.exe',
            path: 'C:\\secret\\Code.exe',
            type: 'exe',
            source: 'manual',
            verified: true,
            aliases: [],
          },
          {
            name: 'Browser /usr/bin/browser',
            path: '/usr/bin/browser',
            type: 'exe',
            source: 'manual',
            verified: true,
            aliases: [],
          },
          {
            name: 'Spotify',
            path: 'C:\\private\\Spotify.exe',
            type: 'exe',
            source: 'detected',
            verified: true,
            aliases: [],
          },
        ],
        programRoles: [
          { role: 'code_editor', programName: 'Relative Editor ..\\secret\\Code.exe' },
          { role: 'browser', programName: 'Browser /usr/bin/browser' },
          { role: 'music_player', programName: 'Spotify' },
        ],
      },
      capabilities,
    });

    expect(context.programRoles).toEqual([
      { role: 'music_player', programName: 'Spotify' },
    ]);
    expect(JSON.stringify(context)).not.toContain('C:\\secret');
    expect(JSON.stringify(context)).not.toContain('..\\secret');
    expect(JSON.stringify(context)).not.toContain('/usr/bin');
  });

  it('omits stale, unverified, and ambiguous program-role bindings', () => {
    const base = resources();
    const context = buildDecisionContext({
      envelope: envelope('Öffne meinen Editor'),
      privateContext: false,
      profile,
      resources: {
        programRoles: [
          { role: 'browser', programName: 'Missing' },
          { role: 'code_editor', programName: 'Visual Studio Code' },
          { role: 'music_player', programName: 'Spotify' },
        ],
        programs: [
          base.programs[0],
          { ...base.programs[0], path: 'D:\\other\\Code.exe' },
          { ...base.programs[1], verified: false },
        ].filter((program) => program !== undefined),
      },
      capabilities,
    });

    expect(context.programRoles).toEqual([]);
  });

  it('binds inherited and anonymous privacy while minimizing custom-command origin', () => {
    const customContext = buildDecisionContext({
      envelope: envelope('Suche ein Hotel', {
        kind: 'custom',
        command: '/reise',
        arguments: 'secret argument',
        expandedText: 'Suche ein Hotel',
      }),
      privateContext: true,
      profile,
      resources: resources(),
      capabilities,
    });
    const anonymousText = 'Suche ein Hotel';
    const anonymousContext = buildDecisionContext({
      envelope: envelope(anonymousText, {
        kind: 'anonymous',
        command: '/anonymous',
        arguments: anonymousText,
      }),
      privateContext: false,
      profile,
      resources: resources(),
      capabilities,
    });

    expect(customContext.turn).toMatchObject({
      privateContext: true,
      inputOrigin: { kind: 'custom_command_expansion', customCommand: '/reise' },
    });
    expect(JSON.stringify(customContext.turn)).not.toContain('secret argument');
    expect(anonymousContext.turn.privateContext).toBe(true);
    expect(anonymousContext.turn.inputOrigin).toEqual({ kind: 'user_text' });
  });

  it('bounds source hints, removes duplicate ids, and ignores unrelated preferences', () => {
    const linkPreferences = [
      ...Array.from({ length: 8 }, (_, index) => ({
        id: `hotel-${index}`,
        description: `Hotels und Hotelangebote Quelle ${index}`,
        url: `https://example.test/${index}`,
      })),
      { id: 'hotel-0', description: 'Hotels duplicate', url: 'https://duplicate.test' },
      { id: 'unrelated', description: 'Fahrräder und Touren', url: 'https://bikes.test' },
    ];
    const context = buildDecisionContext({
      envelope: envelope('Finde Hotelangebote'),
      privateContext: false,
      profile: { linkPreferences },
      resources: resources(),
      capabilities,
    });

    expect(context.preferredSourceHints).toHaveLength(5);
    expect(new Set(context.preferredSourceHints.map((hint) => hint.id)).size).toBe(5);
    expect(context.preferredSourceHints.some((hint) => hint.id === 'unrelated')).toBe(false);
  });
});
