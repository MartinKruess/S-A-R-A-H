import { describe, expect, it } from 'vitest';
import {
  ActionConfirmationGate,
  SPOKEN_ACTION_CONFIRMATION_PHRASE,
  resolveActionConfirmationIntent,
} from '../../src/core/action-confirmation.js';

describe('ActionConfirmationGate', () => {
  it('accepts a controlled spoken phrase when exactly one proposal is pending', () => {
    const gate = new ActionConfirmationGate();
    gate.request('proposal-turn', 'open_program', 'spotify');

    expect(gate.approveSpoken('vielleicht', 'confirmation-turn')).toBeNull();
    expect(gate.approveSpoken('Bitte bestätigen', 'confirmation-turn')).toBeNull();
    expect(gate.approveSpoken(
      `${SPOKEN_ACTION_CONFIRMATION_PHRASE}.`,
      'confirmation-turn',
    )).toMatchObject({
      confirmationTurnId: 'confirmation-turn',
      action: 'open_program',
      param: 'spotify',
    });
  });

  it('keeps exactly one pending proposal and replaces a different older proposal', () => {
    const gate = new ActionConfirmationGate();
    const firstId = gate.request('proposal-one', 'open_program', 'spotify');
    const secondId = gate.request('proposal-two', 'media_next', '');

    expect(secondId).not.toBe(firstId);
    expect(gate.approve(firstId, 'first-confirmation')).toBeNull();
    expect(gate.approve(secondId, 'second-confirmation')).not.toBeNull();
  });

  it('reuses the same pending ID only inside the same proposal turn', () => {
    const gate = new ActionConfirmationGate();
    const firstId = gate.request('proposal-one', 'open_program', 'spotify');
    const repeatedId = gate.request('proposal-one', 'open_program', 'spotify');
    const replacementId = gate.request('proposal-two', 'open_program', 'spotify');

    expect(repeatedId).toBe(firstId);
    expect(replacementId).not.toBe(firstId);
    expect(gate.hasSinglePending()).toBe(true);
    expect(gate.approve(firstId, 'stale-confirmation')).toBeNull();
    expect(gate.approve(replacementId, 'current-confirmation')).toMatchObject({
      confirmation: { requestedTurnId: 'proposal-two' },
    });
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
    const failedProposalId = gate.request('failed-proposal', 'open_program', 'spotify');
    const retainedProposalId = gate.request('completed-proposal', 'media_next', '');
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
    const restorableId = gate.request('proposal-one', 'media_next', '');
    const restorable = gate.approve(restorableId, 'confirmation-one');
    if (!restorable) throw new Error('expected restorable approval');

    gate.invalidateTurn('confirmation-one');
    expect(gate.restorePending(restorable)).toBe(true);
    expect(gate.approve(restorableId, 'confirmation-two')).not.toBeNull();

    const consumedId = gate.request('proposal-two', 'media_pause', '');
    const consumed = gate.approve(consumedId, 'confirmation-three');
    if (!consumed) throw new Error('expected consumed approval');
    expect(gate.consume(
      consumed.confirmationTurnId,
      consumed.action,
      consumed.param,
      consumed.confirmation,
    )).toBe(true);
    expect(gate.restorePending(consumed)).toBe(false);
    expect(gate.approve(consumedId, 'confirmation-four')).toBeNull();
  });
});
