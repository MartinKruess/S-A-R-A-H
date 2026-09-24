import type { ActionName } from '../actions/action-schemas.js';
import { ACTION_SCHEMAS } from '../actions/action-schemas.js';
import { parseTimerRequest, parseTimerSelector } from '../actions/timer-contract.js';
import { groundTimerRequest, groundTimerSelector } from '../actions/timer-grounding.js';
import {
  parseCancelReminderParam,
  parseListReminderParam,
  parseSetReminderParam,
  serializeCancelReminderParam,
  type ReminderClock,
} from '../actions/reminder-contract.js';
import {
  groundSetReminderRequest,
  isCancelReminderRequestGrounded,
} from '../actions/reminder-grounding.js';
import type { ActionValidation } from '../../core/action-intent.js';
import { resolveBrowserResultFollowup } from '../search/browser-result-followup.js';

export type GroundedActionResult =
  | { ok: true; param: string; validation: ActionValidation }
  | { ok: false; message: string };

const OPEN_PROGRAM_SIGNAL = /\b(?:offn\p{L}*|start\p{L}*|launch\p{L}*)\b/u;
const WEB_SEARCH_SIGNAL = /\b(?:such\p{L}*|google\p{L}*)\b/u;
const SPOTIFY_SIGNAL = /\b(?:spotify|musik)\b/u;
const SYSTEM_VOLUME_SIGNAL = /\b(?:system|computer|pc)[\s-]*lautstarke\b|\bsystem\s+volume\b/u;
const VOLUME_OPERATION_SIGNAL = /\b(?:lautstarke|volume|stell\p{L}*|setz\p{L}*|mach\p{L}*)\b/u;
const LOCK_SCREEN_SIGNAL = /\b(?:sperr\p{L}*\s+(?:(?:den|die|das|meinen?)\s+)?(?:bildschirm|computer|pc)|(?:bildschirm|computer|pc)\s+sperr\p{L}*)\b/u;
const NEGATED_ACTION_SIGNAL = /\b(?:nicht|nie|niemals|keinesfalls)\b/u;
const GENERIC_PROGRAM_TOKENS: ReadonlySet<string> = new Set([
  'anwendung', 'app', 'browser', 'editor', 'programm', 'software',
]);
const SEARCH_CONTROL_TOKENS: ReadonlySet<string> = new Set([
  'bitte', 'du', 'mir', 'mal',
  'der', 'die', 'das', 'den', 'dem', 'des',
  'ein', 'eine', 'einen', 'einem', 'einer', 'eines',
  'am', 'an', 'auf', 'bei', 'fur', 'im', 'in', 'mit', 'nach', 'uber', 'von', 'zu',
]);
const OPEN_PROGRAM_CONTROL_TOKENS: ReadonlySet<string> = new Set([
  'bitte', 'doch', 'du', 'einmal', 'fur', 'jetzt', 'mal', 'mich', 'mir', 'sofort',
  'kann', 'kannst', 'konntest', 'mochte', 'mochtest', 'soll', 'sollst', 'wurdest',
  'der', 'die', 'das', 'den', 'dem', 'des',
  'ein', 'eine', 'einen', 'einem', 'einer', 'eines',
  'mein', 'meine', 'meinen', 'meinem', 'meiner', 'meines',
  'anwendung', 'app', 'programm', 'software', 'auf',
]);
const LOCK_SCREEN_CONTROL_TOKENS: ReadonlySet<string> = new Set([
  'bitte', 'doch', 'du', 'einmal', 'jetzt', 'mal', 'mir', 'sofort',
  'kann', 'kannst', 'konntest', 'mochte', 'mochtest', 'soll', 'sollst', 'wurdest',
  'der', 'die', 'das', 'den', 'dem', 'des',
  'mein', 'meine', 'meinen', 'meinem', 'meiner', 'meines',
  'bildschirm', 'computer', 'pc',
]);
const VOLUME_REQUEST_CONTROL_TOKENS: ReadonlySet<string> = new Set([
  'bitte', 'doch', 'du', 'einmal', 'jetzt', 'mal', 'mir', 'sofort',
  'kann', 'kannst', 'konntest', 'soll', 'sollst', 'wurdest',
  'der', 'die', 'das', 'den', 'dem', 'des',
  'mein', 'meine', 'meinen', 'meinem', 'meiner', 'meines',
  'lautstarke', 'volume', 'prozent', 'prozentpunkte',
]);
const LIST_REMINDER_CONTROL_TOKENS: ReadonlySet<string> = new Set([
  'bitte', 'du', 'fur', 'habe', 'haben', 'ich', 'mir', 'noch', 'nur', 'sind',
  'der', 'die', 'das', 'den', 'dem', 'des',
  'ein', 'eine', 'einen', 'einem', 'einer', 'eines',
  'mein', 'meine', 'meinen', 'meinem', 'meiner', 'meines',
  'alle', 'an', 'eingetragen', 'geplant', 'vorhanden',
]);
const UNSUPPORTED_SEARCH_SEMANTIC_TOKENS: ReadonlySet<string> = new Set([
  'aber', 'ausser', 'nicht', 'ohne', 'but', 'except', 'not', 'without',
]);

function normalizedGroundingText(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .replace(/ß/gu, 'ss')
    .toLocaleLowerCase('de-DE');
}

function lexicalTokens(value: string): readonly string[] {
  return normalizedGroundingText(value)
    .split(/[^\p{L}\p{N}]+/gu)
    .filter((token) => token.length > 0);
}

function containsTokenPhrase(text: string, phrase: string): boolean {
  const textTokens = lexicalTokens(text);
  const phraseTokens = lexicalTokens(phrase);
  if (phraseTokens.length === 0 || phraseTokens.length > textTokens.length) return false;
  return textTokens.some((_, start) => phraseTokens.every(
    (token, offset) => textTokens[start + offset] === token,
  ));
}

/**
 * Removes only search-control words, articles and semantically empty prepositions.
 * Coordinating words such as "und" remain part of the query normal form.
 */
function semanticSearchTokens(value: string): readonly string[] | null {
  const tokens = lexicalTokens(value);
  if (tokens.some((token) => UNSUPPORTED_SEARCH_SEMANTIC_TOKENS.has(token))) return null;
  return tokens.filter((token) => (
    !SEARCH_CONTROL_TOKENS.has(token)
    && !token.startsWith('such')
    && !token.startsWith('googl')
  ));
}

function isVolumeRequestControlToken(token: string): boolean {
  return VOLUME_REQUEST_CONTROL_TOKENS.has(token)
    || /^(?:mach|stell|setz|senk|reduzier|erhoh)\p{L}*$/u.test(token)
    || /^\d{1,3}$/u.test(token);
}

/**
 * Binds one relative change to its direction and explicit "um" magnitude.
 * Unqualified changes retain the established 25-point and "etwas" 5-point defaults.
 *
 * @category Validation
 */
function relativeVolumeChange(text: string): number | null {
  const tokens = lexicalTokens(text);
  if (!tokens.every((token) => isVolumeRequestControlToken(token)
    || /^(?:spotify|musik|leiser|lauter|um|etwas)$/u.test(token))) return null;
  const less = /\b(?:leiser|senk\p{L}*|reduzier\p{L}*)\b/u.test(text);
  const more = /\b(?:lauter|erhoh\p{L}*)\b/u.test(text);
  if (less === more) return null;
  const direction = less ? -1 : 1;
  const numbers = text.match(/\d+(?:[.,]\d+)?/gu) ?? [];
  const magnitudeWords = tokens.filter((token) => token === 'um');
  if (numbers.length > 0 || magnitudeWords.length > 0) {
    const magnitude = /\bum\s+(\d{1,3})\b/u.exec(text);
    if (!magnitude || magnitudeWords.length !== 1 || numbers.length !== 1
      || magnitude[1] !== numbers[0] || tokens.includes('etwas')) return null;
    return direction * Number(magnitude[1]);
  }
  if (tokens.includes('prozent') || tokens.includes('prozentpunkte')) return null;
  const slight = /\betwas\s+(?:leiser|lauter)\b/u.test(text);
  if (tokens.includes('etwas') && !slight) return null;
  return direction * (slight ? 5 : 25);
}

/**
 * Binds an absolute percentage to "auf", optionally preceded by "von".
 * Consumes the complete clause; times, conditions and unsupported numeric references require clarification.
 *
 * @category Validation
 */
function absoluteVolumeTarget(text: string, action: 'spotify_volume' | 'set_volume'): number | null {
  const targetToken = action === 'spotify_volume'
    ? /^(?:spotify|musik)$/u
    : /^(?:system|computer|pc)(?:lautstarke)?$/u;
  if (!lexicalTokens(text).every((token) => isVolumeRequestControlToken(token)
    || token === 'auf' || token === 'von' || targetToken.test(token))) return null;
  const targets = [...text.matchAll(
    /\b(?:von\s+(\d{1,3})\s*(?:(?:prozent|%)\s*)?)?auf\s+(\d{1,3})\b/gu,
  )];
  if (targets.length !== 1) return null;
  const target = targets[0]!;
  const expectedNumbers = target[1] === undefined ? [target[2]!] : [target[1], target[2]!];
  const numbers = text.match(/\d+(?:[.,]\d+)?/gu) ?? [];
  if (numbers.length !== expectedNumbers.length
    || numbers.some((number, index) => number !== expectedNumbers[index])) return null;
  return Number(target[2]);
}

function removeFirstTokenPhrase(
  sourceTokens: readonly string[],
  phraseTokens: readonly string[],
): readonly string[] | null {
  if (phraseTokens.length === 0 || phraseTokens.length > sourceTokens.length) return null;
  const start = sourceTokens.findIndex((_, index) => phraseTokens.every(
    (token, offset) => sourceTokens[index + offset] === token,
  ));
  if (start < 0) return null;
  return [...sourceTokens.slice(0, start), ...sourceTokens.slice(start + phraseTokens.length)];
}

function isOpenProgramControlToken(token: string): boolean {
  return OPEN_PROGRAM_CONTROL_TOKENS.has(token)
    || /^(?:offn|start|launch|mach)\p{L}*$/u.test(token);
}

/**
 * Checks that an open-program target plus harmless request words consume the full clause.
 *
 * @category Validation
 */
export function hasCompleteOpenProgramSemantics(effectiveText: string, param: string): boolean {
  const remaining = removeFirstTokenPhrase(lexicalTokens(effectiveText), lexicalTokens(param));
  return remaining !== null
    && remaining.length > 0
    && remaining.every(isOpenProgramControlToken);
}

function hasCompleteLockScreenSemantics(effectiveText: string): boolean {
  const tokens = lexicalTokens(effectiveText);
  return tokens.length > 0 && tokens.every((token) => (
    LOCK_SCREEN_CONTROL_TOKENS.has(token) || /^sperr\p{L}*$/u.test(token)
  ));
}

function isReminderNoun(token: string): boolean {
  return /^(?:erinnerung|reminder|termin)\p{L}*$/u.test(token);
}

function isReminderListVerb(token: string): boolean {
  return /^(?:gib|list|nenn|sag|steh|zeig)\p{L}*$/u.test(token);
}

function isReminderListStatus(token: string): boolean {
  return /^(?:aktiv|ansteh|bevorsteh|offen)\p{L}*$/u.test(token);
}

function hasCompleteListReminderSemantics(
  effectiveText: string,
  scope: 'today' | 'upcoming',
): boolean {
  const tokens = lexicalTokens(effectiveText);
  const hasReminder = tokens.some(isReminderNoun);
  const hasTodayScope = tokens.includes('heute');
  const hasUpcomingScope = tokens.some((token) => token === 'alle' || isReminderListStatus(token));
  if (!hasReminder || (scope === 'today' ? !hasTodayScope : !hasUpcomingScope)) return false;
  return tokens.every((token) => (
    LIST_REMINDER_CONTROL_TOKENS.has(token)
    || isReminderNoun(token)
    || isReminderListVerb(token)
    || isReminderListStatus(token)
    || /^welch\p{L}*$/u.test(token)
    || (scope === 'today' && token === 'heute')
  ));
}

function groundSimpleAction(action: ActionName, param: string, effectiveText: string): boolean {
  const normalized = normalizedGroundingText(effectiveText);
  if (NEGATED_ACTION_SIGNAL.test(normalized)) return false;
  if (action === 'open_program') {
    const programTokens = lexicalTokens(param);
    return programTokens.length > 0
      && programTokens.some((token) => !GENERIC_PROGRAM_TOKENS.has(token))
      && OPEN_PROGRAM_SIGNAL.test(normalized)
      && containsTokenPhrase(effectiveText, param)
      && hasCompleteOpenProgramSemantics(effectiveText, param);
  }
  if (action === 'web_search') {
    const clauseTokens = semanticSearchTokens(effectiveText);
    const queryTokens = semanticSearchTokens(param);
    return WEB_SEARCH_SIGNAL.test(normalized)
      && clauseTokens !== null
      && queryTokens !== null
      && queryTokens.length > 0
      && clauseTokens.length === queryTokens.length
      && clauseTokens.every((token, index) => token === queryTokens[index]);
  }
  if (action === 'show_browser') {
    const resolved = resolveBrowserResultFollowup(effectiveText);
    return resolved !== null
      && normalizedGroundingText(resolved) === normalizedGroundingText(param);
  }
  if (action === 'spotify_volume' || action === 'set_volume') {
    const value = Number(param);
    const targetGrounded = action === 'spotify_volume'
      ? SPOTIFY_SIGNAL.test(normalized)
      : SYSTEM_VOLUME_SIGNAL.test(normalized);
    return targetGrounded
      && VOLUME_OPERATION_SIGNAL.test(normalized)
      && Number.isInteger(value)
      && absoluteVolumeTarget(normalized, action) === value;
  }
  if (action === 'spotify_volume_adjust') {
    const value = Number(param);
    if (!SPOTIFY_SIGNAL.test(normalized) || !Number.isInteger(value) || value === 0) return false;
    return relativeVolumeChange(normalized) === value;
  }
  if (action === 'list_reminders') {
    const scope = parseListReminderParam(param);
    return scope !== null && hasCompleteListReminderSemantics(effectiveText, scope);
  }
  if (action === 'lock_screen') {
    return param === ''
      && LOCK_SCREEN_SIGNAL.test(normalized)
      && hasCompleteLockScreenSemantics(effectiveText);
  }
  return false;
}

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
  } else if (groundSimpleAction(action, param, effectiveText)) {
    validation = 'semantic_grounding';
  }
  const parsed = ACTION_SCHEMAS[action].safeParse(groundedParam);
  if (!parsed.success) return { ok: false, message: 'Das kann ich noch nicht.' };
  return { ok: true, param: String(parsed.data), validation };
}
