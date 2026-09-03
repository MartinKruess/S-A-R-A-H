import type { ActionName } from '../actions/action-schemas.js';
import { ACTION_SCHEMAS } from '../actions/action-schemas.js';
import { parseTimerRequest, parseTimerSelector } from '../actions/timer-contract.js';
import { groundTimerRequest, groundTimerSelector } from '../actions/timer-grounding.js';
import {
  parseCancelReminderParam,
  parseSetReminderParam,
  serializeCancelReminderParam,
  type ReminderClock,
} from '../actions/reminder-contract.js';
import {
  groundSetReminderRequest,
  isCancelReminderRequestGrounded,
} from '../actions/reminder-grounding.js';
import type { ActionValidation } from '../../core/action-intent.js';

export type GroundedActionResult =
  | { ok: true; param: string; validation: ActionValidation }
  | { ok: false; message: string };

/**
 * Grounds and validates model-produced action parameters against the user text.
 *
 * @category Validation
 */
export function groundActionRequest(
  action: ActionName,
  param: string,
  effectiveText: string,
  reminderClock: ReminderClock,
  reminderCancelFollowupId?: number,
): GroundedActionResult {
  let groundedParam = param;
  let validation: ActionValidation = 'schema_only';
  if (action === 'set_timer') {
    const request = parseTimerRequest(param);
    const canonical = request ? groundTimerRequest(request, effectiveText) : null;
    if (!canonical) {
      return { ok: false, message: 'Ich konnte die Timerdauer nicht eindeutig aus deiner Anfrage übernehmen.' };
    }
    groundedParam = canonical;
    validation = 'semantic_grounding';
  } else if (action === 'cancel_timer') {
    const selector = parseTimerSelector(param);
    const canonical = selector ? groundTimerSelector(selector, effectiveText) : null;
    if (!canonical) {
      return { ok: false, message: 'Diesen Timer kann ich aus deiner Angabe nicht eindeutig zuordnen.' };
    }
    groundedParam = canonical;
    validation = 'semantic_grounding';
  } else if (action === 'set_reminder') {
    const request = parseSetReminderParam(param);
    const grounding = request ? groundSetReminderRequest(request, effectiveText, reminderClock) : null;
    if (!grounding?.ok) {
      const message = grounding?.reason === 'non_future_time'
        ? 'Der genannte Zeitpunkt liegt bereits in der Vergangenheit. Bitte nenne einen zukünftigen Zeitpunkt.'
        : grounding?.reason === 'ungrounded_text'
          ? 'Ich konnte den Inhalt der Erinnerung nicht eindeutig aus deiner Anfrage übernehmen. Bitte nenne Zeitpunkt und Inhalt noch einmal zusammen.'
          : grounding?.reason === 'ungrounded_time'
            ? 'Ich konnte den genannten Zeitpunkt nicht sicher zuordnen. Bitte nenne Zeitpunkt und Inhalt noch einmal zusammen.'
            : 'Bitte nenne den vollständigen Erinnerungswunsch mit eindeutigem Zeitpunkt und Inhalt.';
      return { ok: false, message };
    }
    groundedParam = grounding.canonicalParam;
    validation = 'semantic_grounding';
  } else if (action === 'cancel_reminder') {
    const request = parseCancelReminderParam(param);
    const groundedByFollowupContext = request?.kind === 'id'
      && request.id === reminderCancelFollowupId;
    const canonical = request && (
      groundedByFollowupContext || isCancelReminderRequestGrounded(request, effectiveText)
    ) ? serializeCancelReminderParam(request) : null;
    if (!canonical) {
      return { ok: false, message: 'Diese Erinnerung kann ich aus deiner Angabe nicht eindeutig zuordnen.' };
    }
    groundedParam = canonical;
    validation = 'semantic_grounding';
  }
  const parsed = ACTION_SCHEMAS[action].safeParse(groundedParam);
  if (!parsed.success) return { ok: false, message: 'Das kann ich noch nicht.' };
  return { ok: true, param: String(parsed.data), validation };
}
