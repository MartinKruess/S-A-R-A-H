import { describe, expect, it } from 'vitest';
import {
  ActionConfirmationGate,
  SPOKEN_ACTION_CONFIRMATION_PHRASE,
  resolveActionConfirmationIntent,
} from '../../src/core/action-confirmation.js';
import type { ActionIntent } from '../../src/core/action-intent.js';

function intent(
  sourceTurnId: string,
  action: ActionIntent['action'],
  param: string,
  provenance: Omit<ActionIntent['provenance'], 'sourceTurnId'> = {
    decisionSource: 'router_model',
    evidenceSource: 'user_text',
    validation: 'semantic_grounding',
    evidenceScope: { kind: 'whole_turn' },
  },
): ActionIntent {
  return {
    action,
    param,
    provenance: { sourceTurnId, ...provenance },
  };
}

describe('ActionConfirmationGate', () => {
  it('accepts a controlled spoken phrase when exactly one proposal is pending', () => {
    const gate = new ActionConfirmationGate();
    gate.request('proposal-turn', intent('proposal-turn', 'open_program', 'spotify'), false);

    expect(gate.approveSpoken('vielleicht', 'confirmation-turn')).toBeNull();
    expect(gate.approveSpoken('Bitte bestätigen', 'confirmation-turn')).toBeNull();
    expect(gate.approveSpoken(
      `${SPOKEN_ACTION_CONFIRMATION_PHRASE}.`,
      'confirmation-turn',
    )).toMatchObject({
      confirmationTurnId: 'confirmation-turn',
      intent: {
        action: 'open_program',
        param: 'spotify',
        provenance: {
          sourceTurnId: 'proposal-turn',
          decisionSource: 'router_model',
          evidenceSource: 'user_text',
          validation: 'semantic_grounding',
          evidenceScope: { kind: 'whole_turn' },
        },
      },
    });
  });

  it('keeps exactly one pending proposal and replaces a different older proposal', () => {
    const gate = new ActionConfirmationGate();
    const firstId = gate.request('proposal-one', intent('proposal-one', 'open_program', 'spotify'), false);
    const secondId = gate.request('proposal-two', intent('proposal-two', 'media_next', ''), false);

    expect(secondId).not.toBe(firstId);
    expect(gate.approve(firstId, 'first-confirmation')).toBeNull();
    expect(gate.approve(secondId, 'second-confirmation')).not.toBeNull();
  });

  it('reuses the same pending ID only inside the same proposal turn', () => {
    const gate = new ActionConfirmationGate();
    const firstId = gate.request('proposal-one', intent('proposal-one', 'open_program', 'spotify'), false);
    const repeatedId = gate.request('proposal-one', intent('proposal-one', 'open_program', 'spotify'), false);
    const replacementId = gate.request('proposal-two', intent('proposal-two', 'open_program', 'spotify'), false);

    expect(repeatedId).toBe(firstId);
    expect(replacementId).not.toBe(firstId);
    expect(gate.hasSinglePending()).toBe(true);
    expect(gate.approve(firstId, 'stale-confirmation')).toBeNull();
    expect(gate.approve(replacementId, 'current-confirmation')).toMatchObject({
      confirmation: { requestedTurnId: 'proposal-two' },
    });
  });

  it('rejects provenance owned by a different proposal turn', () => {
    const gate = new ActionConfirmationGate();

    expect(gate.request(
      'actual-proposal',
      intent('foreign-proposal', 'open_program', 'spotify'),
      false,
    )).toBeNull();
    expect(gate.hasSinglePending()).toBe(false);
  });

  it.each([
    {
      action: 'delete_everything',
      param: '',
      provenance: {
        sourceTurnId: 'proposal-turn',
        decisionSource: 'router_model',
        evidenceSource: 'user_text',
        validation: 'semantic_grounding',
        evidenceScope: { kind: 'whole_turn' },
      },
    },
    {
      action: 'open_program',
      param: 'spotify',
      provenance: {
        sourceTurnId: 'proposal-turn',
        decisionSource: 'forged',
        evidenceSource: 'user_text',
        validation: 'semantic_grounding',
        evidenceScope: { kind: 'whole_turn' },
      },
    },
  ] as ActionIntent[])('does not create a confirmation for a forged runtime intent: %#', (forged) => {
    const gate = new ActionConfirmationGate();

    expect(gate.request('proposal-turn', forged, false)).toBeNull();
    expect(gate.hasSinglePending()).toBe(false);
  });

  it.each([
    'Nein',
    'Bitte abbrechen',
    'Doch nicht',
    'Nicht bestätigen',
    'Lass es sein',
  ])('never treats cancellation or negation as approval: %s', (phrase) => {
    expect(resolveActionConfirmationIntent(phrase)).toBe('cancel');
  });

  it.each([
    'Ja',
    'Ja, ich bestätige das',
    'Du darfst die Aktion ausführen',
    'Mach das',
    'Jetzt buchen',
    SPOKEN_ACTION_CONFIRMATION_PHRASE,
  ])('recognizes a controlled confirmation variant: %s', (phrase) => {
    expect(resolveActionConfirmationIntent(phrase)).toBe('confirm');
  });

  it('does not treat a new object-bearing command as confirmation of an old action', () => {
    expect(resolveActionConfirmationIntent('Ja, mach Spotify auf')).toBe('none');
    expect(resolveActionConfirmationIntent('Eier-Timer abbrechen')).toBe('none');
    expect(resolveActionConfirmationIntent('Erinnerung Steuerberater abbrechen')).toBe('none');
  });

  it.each([
    'Muss ich diese Aktion wirklich bestätigen?',
    'Kann ich diese Aktion später bestätigen?',
    'Ich weiß nicht, ob ich diese Aktion bestätigen soll',
    'Warum soll ich den Auftrag bestätigen?',
    'Was passiert, wenn ich diese Aktion nicht bestätige?',
  ])('does not consume a question about confirmation as approval: %s', (phrase) => {
    expect(resolveActionConfirmationIntent(phrase)).not.toBe('confirm');
  });

  it('invalidates only proposals and approvals owned by a failed turn', () => {
    const gate = new ActionConfirmationGate();
    const failedProposalId = gate.request('failed-proposal', intent('failed-proposal', 'open_program', 'spotify'), false);
    const retainedProposalId = gate.request('completed-proposal', intent('completed-proposal', 'media_next', ''), false);
    const approved = gate.approve(retainedProposalId, 'failed-confirmation');
    if (!approved) throw new Error('expected approval');

    gate.invalidateTurn('failed-proposal');
    gate.invalidateTurn('failed-confirmation');
    gate.invalidateTurn('completed-proposal');

    expect(gate.approve(failedProposalId, 'late-confirmation')).toBeNull();
    expect(gate.restorePending(approved)).toBe(false);
  });

  it('restores an unconsumed approval but never revives one consumed by ActionService', () => {
    const gate = new ActionConfirmationGate();
    const restorableId = gate.request('proposal-one', intent('proposal-one', 'media_next', ''), false);
    const restorable = gate.approve(restorableId, 'confirmation-one');
    if (!restorable) throw new Error('expected restorable approval');

    gate.invalidateTurn('confirmation-one');
    expect(gate.restorePending(restorable)).toBe(true);
    expect(gate.approve(restorableId, 'confirmation-two')).not.toBeNull();

    const consumedId = gate.request('proposal-two', intent('proposal-two', 'media_pause', ''), false);
    const consumed = gate.approve(consumedId, 'confirmation-three');
    if (!consumed) throw new Error('expected consumed approval');
    expect(gate.consume(
      consumed.confirmationTurnId,
      consumed.intent,
      consumed.confirmation,
      false,
    )).toBe(true);
    expect(gate.restorePending(consumed)).toBe(false);
    expect(gate.approve(consumedId, 'confirmation-four')).toBeNull();
  });

  it('preserves custom-command provenance across approval and restore', () => {
    const gate = new ActionConfirmationGate();
    const customIntent = intent('proposal-turn', 'open_program', 'spotify', {
      decisionSource: 'router_model',
      evidenceSource: 'custom_command_expansion',
      customCommand: '/spotify',
      validation: 'semantic_grounding',
      evidenceScope: { kind: 'whole_turn' },
      interactionContext: {
        kind: 'visible_search_result',
        contextTurnId: 'search-turn',
      },
    });
    const confirmationId = gate.request('proposal-turn', customIntent, false);
    const approved = gate.approve(confirmationId, 'confirmation-turn');
    if (!approved) throw new Error('expected approval');

    expect(approved.intent).toEqual(customIntent);
    gate.invalidateTurn('confirmation-turn');
    expect(gate.restorePending(approved)).toBe(true);
    expect(gate.approve(confirmationId, 'second-confirmation')?.intent).toEqual(customIntent);
  });

  it('rejects consumption when provenance differs from the approved intent', () => {
    const gate = new ActionConfirmationGate();
    const approvedIntent = intent('proposal-turn', 'open_program', 'spotify');
    const confirmationId = gate.request('proposal-turn', approvedIntent, false);
    const approved = gate.approve(confirmationId, 'confirmation-turn');
    if (!approved) throw new Error('expected approval');

    const changedIntent = intent('proposal-turn', 'open_program', 'spotify', {
      decisionSource: 'deterministic_shortcut',
      evidenceSource: 'user_text',
      validation: 'semantic_grounding',
      evidenceScope: { kind: 'whole_turn' },
    });
    expect(gate.consume(
      approved.confirmationTurnId,
      changedIntent,
      approved.confirmation,
      false,
    )).toBe(false);
    expect(gate.consume(
      approved.confirmationTurnId,
      approved.intent,
      approved.confirmation,
      false,
    )).toBe(true);
  });

  it('binds confirmation to the exact clause evidence scope', () => {
    const gate = new ActionConfirmationGate();
    const approvedIntent = intent('proposal-turn', 'set_volume', '30', {
      decisionSource: 'router_model',
      evidenceSource: 'user_text',
      validation: 'semantic_grounding',
      evidenceScope: {
        kind: 'clause',
        intentId: 'intent-2',
        ordinal: 1,
        startOffset: 20,
        endOffset: 50,
      },
    });
    const confirmationId = gate.request('proposal-turn', approvedIntent, false);
    if (!confirmationId) throw new Error('expected confirmation request');
    const approved = gate.approve(confirmationId, 'confirmation-turn');
    if (!approved) throw new Error('expected approval');

    const changedScopeIntent = intent('proposal-turn', 'set_volume', '30', {
      ...approvedIntent.provenance,
      evidenceScope: {
        ...approvedIntent.provenance.evidenceScope,
        endOffset: 51,
      },
    });
    expect(gate.consume(
      approved.confirmationTurnId,
      changedScopeIntent,
      approved.confirmation,
      false,
    )).toBe(false);
    expect(gate.consume(
      approved.confirmationTurnId,
      approved.intent,
      approved.confirmation,
      false,
    )).toBe(true);
  });

  it('binds confirmation to the exact program-role parameter resolution', () => {
    const gate = new ActionConfirmationGate();
    const approvedIntent = intent('proposal-turn', 'open_program', 'Visual Studio Code', {
      decisionSource: 'router_model',
      evidenceSource: 'user_text',
      validation: 'semantic_grounding',
      evidenceScope: { kind: 'whole_turn' },
      parameterResolution: {
        kind: 'program_role',
        role: 'code_editor',
        programName: 'Visual Studio Code',
      },
    });
    const confirmationId = gate.request('proposal-turn', approvedIntent, false);
    if (!confirmationId) throw new Error('expected confirmation request');
    const approved = gate.approve(confirmationId, 'confirmation-turn');
    if (!approved) throw new Error('expected approval');

    const changedResolution = intent('proposal-turn', 'open_program', 'Visual Studio Code', {
      ...approvedIntent.provenance,
      parameterResolution: {
        kind: 'program_role',
        role: 'browser',
        programName: 'Visual Studio Code',
      },
    });
    expect(gate.consume(
      approved.confirmationTurnId,
      changedResolution,
      approved.confirmation,
      false,
    )).toBe(false);
    expect(gate.consume(
      approved.confirmationTurnId,
      approved.intent,
      approved.confirmation,
      false,
    )).toBe(true);
  });

  it('binds the original private context and mode through approval, restore, and consume', () => {
    const gate = new ActionConfirmationGate();
    const approvedIntent = intent('private-proposal', 'set_reminder', 'after=10m|text=Geheimnis');
    const confirmationId = gate.request('private-proposal', approvedIntent, true, undefined, 'voice');
    const approved = gate.approve(confirmationId, 'public-confirmation');
    if (!approved) throw new Error('expected approval');

    expect(approved.privateContext).toBe(true);
    expect(approved.originMode).toBe('voice');
    expect(gate.consume(
      approved.confirmationTurnId,
      approved.intent,
      approved.confirmation,
      false,
      undefined,
      'voice',
    )).toBe(false);
    expect(gate.consume(
      approved.confirmationTurnId,
      approved.intent,
      approved.confirmation,
      true,
    )).toBe(false);

    gate.invalidateTurn('public-confirmation');
    expect(gate.restorePending(approved)).toBe(true);
    const restored = gate.approve(confirmationId, 'second-confirmation');
    if (!restored) throw new Error('expected restored approval');
    expect(restored.privateContext).toBe(true);
    expect(restored.originMode).toBe('voice');
    expect(gate.consume(
      restored.confirmationTurnId,
      restored.intent,
      restored.confirmation,
      true,
      undefined,
      'voice',
    )).toBe(true);
  });
});
