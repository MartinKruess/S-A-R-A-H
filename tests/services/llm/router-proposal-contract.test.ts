import { describe, expect, it } from 'vitest';
import {
  MAX_ROUTER_PROPOSAL_LENGTH,
  parseRouterPlanProposal,
} from '../../../src/services/llm/router-proposal-contract';

function proposal(intents: readonly object[]): string {
  return `SARAH_PROPOSAL_V1 ${JSON.stringify({ intents })}`;
}

describe('parseRouterPlanProposal', () => {
  it('accepts two or three strict explicit intents', () => {
    const two = parseRouterPlanProposal(proposal([
      { kind: 'action', action: 'open_program', param: 'spotify', evidence: 'Öffne Spotify' },
      { kind: 'answer', evidence: 'erzähl mir etwas über Fahrräder' },
    ]));
    const three = parseRouterPlanProposal(proposal([
      { kind: 'action', action: 'open_program', param: 'spotify', evidence: 'Öffne Spotify' },
      { kind: 'action', action: 'spotify_volume', param: '30', evidence: 'stelle Spotify auf 30 Prozent' },
      { kind: 'handoff', specialist: 'coding', evidence: 'baue TTS in Sarah ein' },
    ]));

    expect(two.ok).toBe(true);
    expect(three.ok).toBe(true);
  });

  it.each([
    [{ kind: 'answer', evidence: 'nur eine Frage' }],
    [
      { kind: 'answer', evidence: 'eins' },
      { kind: 'action', action: 'open_program', param: 'spotify', evidence: 'zwei' },
      { kind: 'handoff', specialist: 'coding', evidence: 'drei' },
      { kind: 'action', action: 'set_volume', param: '30', evidence: 'vier' },
    ],
  ])('rejects unsupported intent counts', (intents) => {
    expect(parseRouterPlanProposal(proposal(intents))).toEqual({
      ok: false,
      reason: 'invalid_schema',
    });
  });

  it('rejects fields that let the model choose planning or authority state', () => {
    expect(parseRouterPlanProposal(proposal([
      {
        kind: 'action',
        action: 'open_program',
        param: 'spotify',
        evidence: 'Öffne Spotify',
        dependsOn: [2],
      },
      {
        kind: 'handoff',
        specialist: 'coding',
        evidence: 'baue TTS ein',
        confirmation: false,
      },
    ]))).toEqual({ ok: false, reason: 'invalid_schema' });
  });

  it.each(['codex', 'claude', 'extern', 'backend'])('rejects concrete or unsupported specialists: %s', (specialist) => {
    expect(parseRouterPlanProposal(proposal([
      { kind: 'answer', evidence: 'erkläre den Auftrag' },
      { kind: 'handoff', specialist, evidence: 'baue TTS ein' },
    ]))).toEqual({ ok: false, reason: 'invalid_schema' });
  });

  it('accepts multiple answer intents within the shared three-intent limit', () => {
    expect(parseRouterPlanProposal(proposal([
      { kind: 'answer', evidence: 'Frage eins' },
      { kind: 'answer', evidence: 'Frage zwei' },
    ])).ok).toBe(true);
  });

  it.each([
    '```json\nSARAH_PROPOSAL_V1 {"intents":[]}\n```',
    'Vorab: SARAH_PROPOSAL_V1 {"intents":[]}',
    'SARAH_PROPOSAL_V2 {"intents":[]}',
    'SARAH_PROPOSAL_V1 {"intents":[',
  ])('rejects unanchored, unsupported, or malformed output', (output) => {
    expect(parseRouterPlanProposal(output).ok).toBe(false);
  });

  it('rejects oversized output before parsing', () => {
    const output = `SARAH_PROPOSAL_V1 ${'x'.repeat(MAX_ROUTER_PROPOSAL_LENGTH)}`;
    expect(parseRouterPlanProposal(output)).toEqual({ ok: false, reason: 'oversized' });
  });
});
