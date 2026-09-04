import { randomUUID } from 'node:crypto';
import type {
  ActionIntent,
  ActionParameterResolution,
  ActionProvenance,
} from '../../core/action-intent.js';
import type { ProgramRole } from '../../core/config-schema.js';
import {
  createDecisionContext,
  type DecisionCapability,
  type DecisionContext,
} from '../../core/decision-context.js';
import {
  createIntentPlan,
  type IntentClauseReference,
  type IntentPlan,
  type ValidatedExplicitIntent,
} from '../../core/intent-plan.js';
import type { TurnEnvelope } from '../../core/turn-contract.js';
import {
  ACTION_HINT_STEMS,
  isActionName,
  type ActionName,
} from '../actions/action-schemas.js';
import type { ReminderClock } from '../actions/reminder-contract.js';
import {
  groundActionRequest,
  hasCompleteOpenProgramSemantics,
} from './router-action-grounding.js';
import {
  parseRouterPlanProposal,
  routerPlanProposalSchema,
  type RouterIntentProposal,
  type RouterPlanProposal,
  type RouterProposalParseFailure,
} from './router-proposal-contract.js';

export type RouterPlanFailure =
  | `proposal_${RouterProposalParseFailure}`
  | 'missing_evidence'
  | 'ambiguous_evidence'
  | 'incomplete_evidence'
  | 'unordered_evidence'
  | 'unknown_action'
  | 'insufficient_action_grounding'
  | 'decision_context_mismatch'
  | 'capability_unavailable'
  | 'unresolved_program_role'
  | 'invalid_action'
  | 'invalid_plan';

export type RouterPlanResult =
  | { readonly ok: true; readonly plan: IntentPlan }
  | { readonly ok: false; readonly reason: RouterPlanFailure };

export interface RouterPlanValidationDependencies {
  readonly reminderClock: ReminderClock;
  readonly decisionContext: DecisionContext;
  readonly createIntentId?: () => string;
}

type EvidenceResolution =
  | { readonly ok: true; readonly evidence: IntentClauseReference; readonly text: string }
  | { readonly ok: false; readonly reason: 'missing_evidence' | 'ambiguous_evidence' };

const ALLOWED_CONNECTOR_WORDS: ReadonlySet<string> = new Set([
  'und',
  'sowie',
  'dann',
  'danach',
  'anschließend',
  'anschliessend',
  'daraufhin',
  'außerdem',
  'ausserdem',
  'and',
  'then',
  'afterwards',
  'also',
]);

const SEQUENTIAL_CONNECTOR_WORDS: ReadonlySet<string> = new Set([
  'dann',
  'danach',
  'anschließend',
  'anschliessend',
  'daraufhin',
  'then',
  'afterwards',
]);

const ALTERNATIVE_CONNECTOR_PATTERN = /\b(?:oder|or)\b/u;
const SEQUENTIAL_CONNECTOR_PATTERN = /\b(?:dann|danach|anschliessend|daraufhin|then|afterwards)\b/gu;
const COORDINATING_CONNECTOR_PATTERN = /\b(?:und|sowie|and|also)\b/gu;
const SENTENCE_BOUNDARY_PATTERN = /[;:.!?]+/gu;
const OPTIONAL_INTENT_PREAMBLE = '(?:\\p{L}+\\s*[,;:]?\\s+){0,3}';
const ANSWER_INTENT_START_PATTERN = new RegExp(
  `^${OPTIONAL_INTENT_PREAMBLE}(?:erzahl(?:e|st)?|erklar(?:e|st)?|sag(?:e|st)?|nenn(?:e|st)?|finde(?:st)?|beantworte(?:st)?|diskutiere(?:st)?|was|wie|wann|warum|wer|wo|welch)\\b`,
  'u',
);
const HANDOFF_INTENT_START_PATTERN = new RegExp(
  `^${OPTIONAL_INTENT_PREAMBLE}(?:bau(?:e|st)?|implementiere(?:st)?|pruf(?:e|st)?|ander(?:e|st)?|repariere(?:st)?|schreib(?:e|st)?|analysiere(?:st)?|recherchiere(?:st)?)\\b`,
  'u',
);
const ACTION_INTENT_START_PATTERN = new RegExp(
  `^${OPTIONAL_INTENT_PREAMBLE}(?:offne(?:n|st)?|starte(?:n|st)?|launche(?:n|st)?|suche(?:n|st)?|google(?:st)?|zeige(?:n|st)?|stell(?:e|st)?|setz(?:e|t)?|mach(?:e|st)?|erinner(?:e|st)?|losch(?:e|st)?|entfern(?:e|st)?|brich|stopp(?:e|st)?|pausier(?:e|st)?|spiel(?:e|st)?|sperr(?:e|st)?|erhoh(?:e|st)?|senk(?:e|st)?|reduziere(?:st)?|dreh(?:e|st)?)\\b`,
  'u',
);
const EXPLICIT_INTENT_SIGNAL_PATTERN = /\b(?:erzahl(?:e|st)?|erklar(?:e|st)?|sag(?:e|st)?|nenn(?:e|st)?|finde(?:st)?|beantworte(?:st)?|diskutiere(?:st)?|was|wie|wann|warum|wer|wo|welch\p{L}*|bau(?:e|st)?|implementiere(?:st)?|pruf(?:e|st)?|ander(?:e|st)?|repariere(?:st)?|schreib(?:e|st)?|analysiere(?:st)?|recherchiere(?:st)?|offne(?:n|st)?|starte(?:n|st)?|launche(?:n|st)?|suche(?:n|st)?|google(?:st)?|zeige(?:n|st)?|stell(?:e|st)?|setz(?:e|t)?|mach(?:e|st)?|erinner(?:e|st)?|losch(?:e|st)?|entfern(?:e|st)?|brich|stopp(?:e|st)?|pausier(?:e|st)?|spiel(?:e|st)?|sperr(?:e|st)?|erhoh(?:e|st)?|senk(?:e|st)?|reduziere(?:st)?|dreh(?:e|st)?)\b/u;
const ACTION_SIGNAL_PATTERN = new RegExp(
  `(?:^|[\\s,.!?])(?:${ACTION_HINT_STEMS.map((stem) => normalizedSemanticText(stem)).join('|')})`,
  'u',
);
const QUESTION_INTENT_START_PATTERN = new RegExp(
  `^${OPTIONAL_INTENT_PREAMBLE}(?:was|wie|wann|warum|wer|wo|welch)\\b`,
  'u',
);
const LIST_REMINDERS_QUESTION_PATTERN = /^welch\p{L}*\b.*\b(?:erinnerung\p{L}*|reminder\p{L}*|termin\p{L}*)\b/u;
const CLAUSE_BOUNDARY_PUNCTUATION = /[,;:.!?&]/u;

function connectorWords(text: string): readonly string[] {
  return text
    .replace(/[\s,;:.!?&()[\]{}'"„“‚‘\-–—]+/gu, ' ')
    .trim()
    .toLocaleLowerCase('de-DE')
    .split(' ')
    .filter((word) => word.length > 0);
}

function connectorOrder(text: string): ValidatedExplicitIntent['order'] | null {
  const words = connectorWords(text);
  if (words.some((word) => !ALLOWED_CONNECTOR_WORDS.has(word))) return null;
  return words.some((word) => SEQUENTIAL_CONNECTOR_WORDS.has(word))
    ? 'after_previous'
    : 'independent';
}

function normalizedSemanticText(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .replace(/ß/gu, 'ss')
    .toLocaleLowerCase('de-DE');
}

function hasClauseBoundary(
  effectiveText: string,
  previousEndOffset: number,
  connector: string,
  nextEvidenceText: string,
  nextProposal: RouterIntentProposal,
): boolean {
  const previousCharacter = effectiveText[previousEndOffset - 1] ?? '';
  const hasSeparator = CLAUSE_BOUNDARY_PUNCTUATION.test(connector)
    || CLAUSE_BOUNDARY_PUNCTUATION.test(previousCharacter)
    || connectorWords(connector).length > 0;
  if (!hasSeparator) return false;
  const normalizedNextEvidence = normalizedSemanticText(nextEvidenceText);
  return startsProposedIntent(normalizedNextEvidence, nextProposal);
}

function startsProposedIntent(value: string, proposal: RouterIntentProposal): boolean {
  const wordCount = connectorWords(value).length;
  if (proposal.kind === 'answer') {
    return ANSWER_INTENT_START_PATTERN.test(value)
      && (wordCount >= 2 || QUESTION_INTENT_START_PATTERN.test(value));
  }
  if (proposal.kind === 'handoff') {
    return wordCount >= 2 && HANDOFF_INTENT_START_PATTERN.test(value);
  }
  return ACTION_INTENT_START_PATTERN.test(value)
    || (proposal.action === 'list_reminders' && LIST_REMINDERS_QUESTION_PATTERN.test(value));
}

function startsEmbeddedIntent(value: string): boolean {
  return ANSWER_INTENT_START_PATTERN.test(value)
    || HANDOFF_INTENT_START_PATTERN.test(value)
    || ACTION_INTENT_START_PATTERN.test(value)
    || ACTION_SIGNAL_PATTERN.test(value);
}

function containsExplicitIntentSignal(value: string): boolean {
  return EXPLICIT_INTENT_SIGNAL_PATTERN.test(value);
}

function containsEmbeddedIntent(
  proposal: RouterIntentProposal,
  evidenceText: string,
): boolean {
  const normalized = normalizedSemanticText(evidenceText);
  if (ALTERNATIVE_CONNECTOR_PATTERN.test(normalized)) return true;

  for (const connector of normalized.matchAll(SEQUENTIAL_CONNECTOR_PATTERN)) {
    if (connector.index === undefined) continue;
    const remaining = normalized.slice(connector.index + connector[0].length).trimStart();
    if (startsEmbeddedIntent(remaining)) return true;
  }

  for (const connector of normalized.matchAll(COORDINATING_CONNECTOR_PATTERN)) {
    if (connector.index === undefined) continue;
    const remaining = normalized.slice(connector.index + connector[0].length).trimStart();
    if (proposal.kind === 'action' && proposal.action === 'open_program') return true;
    if (startsEmbeddedIntent(remaining) || containsExplicitIntentSignal(remaining)) return true;
  }

  for (const boundary of normalized.matchAll(SENTENCE_BOUNDARY_PATTERN)) {
    if (boundary.index === undefined) continue;
    const remaining = normalized.slice(boundary.index + boundary[0].length).trimStart();
    if (containsExplicitIntentSignal(remaining)) return true;
  }
  return false;
}

function isUnsupportedSequentialAnswerAfterAction(
  proposal: RouterIntentProposal,
  order: ValidatedExplicitIntent['order'],
  priorIntents: readonly ValidatedExplicitIntent[],
): boolean {
  return proposal.kind === 'answer'
    && order === 'after_previous'
    && priorIntents.some((intent) => intent.kind === 'action');
}

function intentOrdinal(index: number): 0 | 1 | 2 {
  if (index === 0 || index === 1 || index === 2) return index;
  throw new Error('Intent ordinal is outside the bounded contract');
}

function resolveEvidence(
  effectiveText: string,
  evidenceText: string,
  ordinal: 0 | 1 | 2,
  createIntentId: () => string,
): EvidenceResolution {
  const normalizedEvidence = evidenceText.normalize('NFC').trim();
  const startOffset = effectiveText.indexOf(normalizedEvidence);
  if (startOffset < 0) return { ok: false, reason: 'missing_evidence' };
  if (effectiveText.indexOf(normalizedEvidence, startOffset + 1) >= 0) {
    return { ok: false, reason: 'ambiguous_evidence' };
  }
  return {
    ok: true,
    evidence: {
      intentId: createIntentId(),
      ordinal,
      startOffset,
      endOffset: startOffset + normalizedEvidence.length,
    },
    text: normalizedEvidence,
  };
}

function createActionProvenance(
  envelope: TurnEnvelope,
  evidence: IntentClauseReference,
  validation: ActionProvenance['validation'],
  parameterResolution?: ActionParameterResolution,
): ActionProvenance {
  const inputEvidence = envelope.command.kind === 'custom'
    ? {
      evidenceSource: 'custom_command_expansion' as const,
      customCommand: envelope.command.command,
    }
    : { evidenceSource: 'user_text' as const };
  return {
    sourceTurnId: envelope.turnId,
    decisionSource: 'router_model',
    validation,
    evidenceScope: { kind: 'clause', ...evidence },
    ...(parameterResolution ? { parameterResolution } : {}),
    ...inputEvidence,
  };
}

const PROGRAM_ROLE_PHRASES: Readonly<Record<ProgramRole, RegExp>> = {
  browser: /\b(?:browser|internetbrowser)\b/iu,
  code_editor: /\b(?:editor|code[\s-]?editor|entwicklungsumgebung|ide)\b/iu,
  music_player: /\b(?:musik[\s-]?player|audio[\s-]?player|musik[\s-]?app)\b/iu,
};
const OPEN_PROGRAM_REQUEST = /\b(?:offn[a-z]*|start[a-z]*|launch[a-z]*)\b|\bmach\b.{0,60}\bauf\b/u;
const NEGATED_PROGRAM_REQUEST = /\b(?:nicht|nie|niemals|keinesfalls)\b/u;

function normalizedGroundingText(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLocaleLowerCase('de-DE');
}

function resolveProgramRoleAction(
  proposal: Extract<RouterIntentProposal, { kind: 'action' }>,
  evidenceText: string,
  context: DecisionContext,
): { readonly param: string; readonly resolution: ActionParameterResolution } | null {
  if (proposal.action !== 'open_program') return null;
  const match = /^role:(browser|code_editor|music_player)$/u.exec(proposal.param);
  const role = match?.[1] as ProgramRole | undefined;
  const normalizedEvidence = normalizedGroundingText(evidenceText);
  const rolePhrase = role
    ? PROGRAM_ROLE_PHRASES[role].exec(normalizedEvidence)?.[0]
    : undefined;
  if (
    !role
    || !OPEN_PROGRAM_REQUEST.test(normalizedEvidence)
    || NEGATED_PROGRAM_REQUEST.test(normalizedEvidence)
    || !rolePhrase
    || !hasCompleteOpenProgramSemantics(evidenceText, rolePhrase)
  ) return null;
  const bindings = context.programRoles.filter((binding) => binding.role === role);
  if (bindings.length !== 1) return null;
  const binding = bindings[0];
  if (!binding) return null;
  return {
    param: binding.programName,
    resolution: {
      kind: 'program_role',
      role,
      programName: binding.programName,
    },
  };
}

function isCapabilityAvailable(capability: DecisionCapability): boolean {
  return capability.state === 'available';
}

function actionCapabilityAvailable(action: ActionName, context: DecisionContext): boolean {
  if (!isCapabilityAvailable(context.capabilities.actions)) return false;
  if (action === 'web_search') return isCapabilityAvailable(context.capabilities.webSearch);
  if (action === 'show_browser') {
    return isCapabilityAvailable(context.capabilities.visibleBrowserResult);
  }
  if (action === 'set_reminder' && context.turn.privateContext) return false;
  if (action === 'set_reminder' || action === 'list_reminders' || action === 'cancel_reminder') {
    return isCapabilityAvailable(context.capabilities.reminders);
  }
  if (
    action === 'spotify_volume'
    || action === 'spotify_volume_adjust'
    || action === 'media_play'
    || action === 'media_pause'
    || action === 'media_toggle'
    || action === 'media_next'
    || action === 'media_previous'
  ) return isCapabilityAvailable(context.capabilities.media);
  return true;
}

function contextMatchesEnvelope(context: DecisionContext, envelope: TurnEnvelope): boolean {
  if (context.turn.turnId !== envelope.turnId || context.turn.mode !== envelope.mode) return false;
  if (envelope.command.kind === 'anonymous' && !context.turn.privateContext) return false;
  if (envelope.command.kind === 'custom') {
    return context.turn.inputOrigin.kind === 'custom_command_expansion'
      && context.turn.inputOrigin.customCommand === envelope.command.command;
  }
  return context.turn.inputOrigin.kind === 'user_text';
}

function validateActionProposal(
  proposal: Extract<RouterIntentProposal, { kind: 'action' }>,
  evidence: IntentClauseReference,
  evidenceText: string,
  envelope: TurnEnvelope,
  reminderClock: ReminderClock,
  context: DecisionContext,
): ActionIntent<ActionName> | RouterPlanFailure {
  if (!isActionName(proposal.action)) return 'unknown_action';
  if (!actionCapabilityAvailable(proposal.action, context)) return 'capability_unavailable';
  const roleResolution = resolveProgramRoleAction(proposal, evidenceText, context);
  if (proposal.action === 'open_program' && proposal.param.startsWith('role:')) {
    if (!roleResolution) return 'unresolved_program_role';
    return {
      action: proposal.action,
      param: roleResolution.param,
      provenance: createActionProvenance(
        envelope,
        evidence,
        'semantic_grounding',
        roleResolution.resolution,
      ),
    };
  }
  const grounding = groundActionRequest(
    proposal.action,
    proposal.param,
    evidenceText,
    reminderClock,
  );
  if (!grounding.ok) return 'invalid_action';
  if (grounding.validation !== 'semantic_grounding') return 'insufficient_action_grounding';
  const intent: ActionIntent<ActionName> = {
    action: proposal.action,
    param: grounding.param,
    provenance: createActionProvenance(envelope, evidence, grounding.validation),
  };
  return intent;
}

function validateProposalIntent(
  proposal: RouterIntentProposal,
  evidence: IntentClauseReference,
  evidenceText: string,
  order: ValidatedExplicitIntent['order'],
  envelope: TurnEnvelope,
  reminderClock: ReminderClock,
  context: DecisionContext,
): ValidatedExplicitIntent | RouterPlanFailure {
  if (proposal.kind === 'action') {
    const action = validateActionProposal(
      proposal,
      evidence,
      evidenceText,
      envelope,
      reminderClock,
      context,
    );
    return typeof action === 'string' ? action : { kind: 'action', order, intent: action };
  }
  if (proposal.kind === 'answer') {
    if (!isCapabilityAvailable(context.capabilities.localAnswer)) {
      return 'capability_unavailable';
    }
    return { kind: 'answer', order, evidence, text: evidenceText };
  }
  if (!isCapabilityAvailable(context.capabilities.specialists[proposal.specialist])) {
    return 'capability_unavailable';
  }
  return {
    kind: 'handoff',
    order,
    evidence,
    capability: proposal.specialist,
    task: evidenceText,
  };
}

/**
 * @param proposal - Bereits strukturell geprüfter, aber nicht vertrauenswürdiger Router-Vorschlag.
 * @param envelope - Autoritativer Turn mit dem wirksamen Quelltext.
 * @param dependencies - Lokale Clock- und ID-Abhängigkeiten.
 *
 * - Verankert jede Klausel eindeutig und in Nutzerreihenfolge.
 * - Prüft Actions ausschließlich gegen ihre eigene Klausel.
 * - Erzeugt einen lokalen Plan, ohne etwas auszuführen oder zu veröffentlichen.
 *
 * @returns Vollständiger vertrauenswürdiger Plan oder ein einzelner Ablehnungsgrund.
 *
 * @category Validation Business Logic
 */
export function validateRouterPlanProposal(
  proposal: RouterPlanProposal,
  envelope: TurnEnvelope,
  dependencies: RouterPlanValidationDependencies,
): RouterPlanResult {
  const parsedProposal = routerPlanProposalSchema.safeParse(proposal);
  if (!parsedProposal.success) return { ok: false, reason: 'proposal_invalid_schema' };
  let decisionContext: DecisionContext;
  try {
    decisionContext = createDecisionContext(dependencies.decisionContext);
  } catch {
    return { ok: false, reason: 'decision_context_mismatch' };
  }
  if (!contextMatchesEnvelope(decisionContext, envelope)) {
    return { ok: false, reason: 'decision_context_mismatch' };
  }
  const effectiveText = envelope.effectiveText;
  const createIntentId = dependencies.createIntentId ?? randomUUID;
  const intents: ValidatedExplicitIntent[] = [];
  let previousEndOffset = 0;

  for (let index = 0; index < parsedProposal.data.intents.length; index += 1) {
    const proposedIntent = parsedProposal.data.intents[index];
    if (!proposedIntent) return { ok: false, reason: 'invalid_plan' };
    const resolution = resolveEvidence(
      effectiveText,
      proposedIntent.evidence,
      intentOrdinal(index),
      createIntentId,
    );
    if (!resolution.ok) return resolution;
    if (proposedIntent.kind === 'action' && !isActionName(proposedIntent.action)) {
      return { ok: false, reason: 'unknown_action' };
    }
    if (index > 0 && resolution.evidence.startOffset < previousEndOffset) {
      return { ok: false, reason: 'unordered_evidence' };
    }
    if (
      index === 0
      && !startsProposedIntent(normalizedSemanticText(resolution.text), proposedIntent)
    ) {
      return { ok: false, reason: 'incomplete_evidence' };
    }
    const connector = effectiveText.slice(previousEndOffset, resolution.evidence.startOffset);
    const order = connectorOrder(connector);
    if (order === null) return { ok: false, reason: 'incomplete_evidence' };
    if (index > 0 && !hasClauseBoundary(
      effectiveText,
      previousEndOffset,
      connector,
      resolution.text,
      proposedIntent,
    )) {
      return { ok: false, reason: 'incomplete_evidence' };
    }
    if (index === 0 && order === 'after_previous') {
      return { ok: false, reason: 'incomplete_evidence' };
    }
    if (isUnsupportedSequentialAnswerAfterAction(proposedIntent, order, intents)) {
      return { ok: false, reason: 'incomplete_evidence' };
    }
    if (containsEmbeddedIntent(proposedIntent, resolution.text)) {
      return { ok: false, reason: 'incomplete_evidence' };
    }
    previousEndOffset = resolution.evidence.endOffset;
    const intent = validateProposalIntent(
      proposedIntent,
      resolution.evidence,
      resolution.text,
      index === 0 ? 'independent' : order,
      envelope,
      dependencies.reminderClock,
      decisionContext,
    );
    if (typeof intent === 'string') return { ok: false, reason: intent };
    intents.push(intent);
  }

  const trailingConnector = effectiveText.slice(previousEndOffset);
  if (
    connectorOrder(trailingConnector) === null
    || connectorWords(trailingConnector).length > 0
  ) {
    return { ok: false, reason: 'incomplete_evidence' };
  }

  try {
    return {
      ok: true,
      plan: createIntentPlan({
        sourceTurnId: envelope.turnId,
        intents,
        privateContext: decisionContext.turn.privateContext,
        originMode: decisionContext.turn.mode,
      }),
    };
  } catch {
    return { ok: false, reason: 'invalid_plan' };
  }
}

/** Parses and validates a router proposal without dispatching any step. */
export function compileRouterPlanProposal(
  output: string,
  envelope: TurnEnvelope,
  dependencies: RouterPlanValidationDependencies,
): RouterPlanResult {
  const parsed = parseRouterPlanProposal(output);
  if (!parsed.ok) return { ok: false, reason: `proposal_${parsed.reason}` };
  return validateRouterPlanProposal(parsed.proposal, envelope, dependencies);
}
