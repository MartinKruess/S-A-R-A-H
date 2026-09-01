import { describe, expect, it } from 'vitest';
import { prepareTurnEnvelope, type TurnRequest } from '../../src/core/turn-contract.js';

const request: TurnRequest = {
  turnId: 'turn-1',
  source: 'chat',
  mode: 'chat',
  originalText: ' /Projekt Phase 1 ',
  createdAt: '2026-08-26T00:00:00.000Z',
};

describe('prepareTurnEnvelope', () => {
  it('keeps original, normalized, command arguments and effective expansion separate', () => {
    const envelope = prepareTurnEnvelope(request, [
      { command: '/projekt', prompt: 'Fasse das Projekt zusammen.' },
    ]);

    expect(envelope.originalText).toBe(' /Projekt Phase 1 ');
    expect(envelope.normalizedText).toBe('/Projekt Phase 1');
    expect(envelope.command).toEqual({
      kind: 'custom',
      command: '/projekt',
      arguments: 'Phase 1',
      expandedText: 'Fasse das Projekt zusammen.\nZusätzliche Argumente des Nutzers: Phase 1',
    });
    expect(envelope.effectiveText).toBe(
      'Fasse das Projekt zusammen.\nZusätzliche Argumente des Nutzers: Phase 1',
    );
  });
});
