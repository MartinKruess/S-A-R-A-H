import { PROGRAM_ROLES, type ProgramRole } from './config-schema.js';
import type { SpecialistCapability } from './intent-plan.js';
import type { TurnId, TurnMode } from './turn-contract.js';

export const MAX_DECISION_TURN_ID_LENGTH = 128;
export const MAX_DECISION_PROGRAM_ROLES = 3;
export const MAX_DECISION_PROGRAM_NAME_LENGTH = 100;
export const MAX_DECISION_SOURCE_HINTS = 5;
export const MAX_DECISION_SOURCE_ID_LENGTH = 128;
export const MAX_DECISION_SOURCE_DESCRIPTION_LENGTH = 240;
export const MAX_DECISION_CUSTOM_COMMAND_LENGTH = 51;

export type DecisionCapabilityState = 'available' | 'unavailable' | 'unknown';

export type DecisionCapabilityReason =
  | 'ready'
  | 'lifecycle_unavailable'
  | 'model_unavailable'
  | 'service_unavailable'
  | 'policy_denied'
  | 'no_visible_result'
  | 'no_readiness_source'
  | 'no_adapter';

export interface DecisionCapability {
  readonly state: DecisionCapabilityState;
  readonly reason: DecisionCapabilityReason;
}

export interface DecisionCapabilitySnapshot {
  readonly lifecycleGeneration: number;
  readonly modelExecutionMode: 'exclusive';
  readonly router: DecisionCapability;
  readonly localAnswer: DecisionCapability;
  readonly actions: DecisionCapability;
  readonly webSearch: DecisionCapability;
  readonly visibleBrowserResult: DecisionCapability;
  readonly reminders: DecisionCapability;
  readonly media: DecisionCapability;
  readonly specialists: Readonly<Record<SpecialistCapability, DecisionCapability>>;
}

export type DecisionInputOrigin =
  | { readonly kind: 'user_text' }
  | {
    readonly kind: 'custom_command_expansion';
    readonly customCommand: string;
  };

export interface DecisionProgramRole {
  readonly role: ProgramRole;
  readonly programName: string;
}

export interface DecisionSourceHint {
  readonly id: string;
  readonly description: string;
}

export interface DecisionContext {
  readonly version: 1;
  readonly turn: Readonly<{
    turnId: TurnId;
    mode: TurnMode;
    privateContext: boolean;
    inputOrigin: DecisionInputOrigin;
  }>;
  readonly programRoles: readonly DecisionProgramRole[];
  readonly preferredSourceHints: readonly DecisionSourceHint[];
  readonly capabilities: DecisionCapabilitySnapshot;
}

const PROGRAM_ROLE_SET: ReadonlySet<ProgramRole> = new Set(PROGRAM_ROLES);

const CAPABILITY_STATES: ReadonlySet<DecisionCapabilityState> = new Set([
  'available',
  'unavailable',
  'unknown',
]);

const CAPABILITY_REASONS: ReadonlySet<DecisionCapabilityReason> = new Set([
  'ready',
  'lifecycle_unavailable',
  'model_unavailable',
  'service_unavailable',
  'policy_denied',
  'no_visible_result',
  'no_readiness_source',
  'no_adapter',
]);

const DECISION_URL_LITERAL = /(?:\b[a-z][a-z\d+.-]*:\/\/|\bwww\.|(?:^|[\s("'`])(?:[a-z\d-]+\.)+[a-z]{2,}(?=$|[\s:\/?#"'`]))/iu;
const DECISION_NETWORK_LITERAL = /(?:\b(?:[a-z][a-z\d-]*|(?:\d{1,3}\.){3}\d{1,3}):\d{1,5}\b|\b(?:\d{1,3}\.){3}\d{1,3}\b|\[[a-f\d:]+\](?::\d{1,5})?|(?:^|[\s("'`])(?:[a-f\d]{0,4}:){2,}[a-f\d]{0,4}(?=$|[\s)"'`]))/iu;
const DECISION_PATH_LITERAL = /(?:^|[\s("'`])(?:[a-z]:[\\/]|\\\\|[~.]?[\\/]|(?:[^\s"'`\\/]+[\\/])+)[^\s"'`]*/iu;

function boundedText(value: string, label: string, maxLength: number): string {
  const normalized = value.normalize('NFC').trim();
  if (!normalized || normalized.length > maxLength) {
    throw new Error(`${label} must contain between 1 and ${maxLength} characters`);
  }
  return normalized;
}

/** Returns whether a semantic planner label contains no URL or filesystem location. */
export function isSafeDecisionLabel(value: string): boolean {
  return !DECISION_URL_LITERAL.test(value)
    && !DECISION_NETWORK_LITERAL.test(value)
    && !DECISION_PATH_LITERAL.test(value);
}

function boundedDecisionLabel(value: string, label: string, maxLength: number): string {
  const bounded = boundedText(value, label, maxLength);
  if (!isSafeDecisionLabel(bounded)) {
    throw new Error(`${label} must not contain a URL or filesystem path`);
  }
  return bounded;
}

function copyCapability(capability: DecisionCapability): DecisionCapability {
  if (!CAPABILITY_STATES.has(capability.state)
    || !CAPABILITY_REASONS.has(capability.reason)) {
    throw new Error('Decision capability contains an unsupported state or reason');
  }
  if (capability.state === 'available' && capability.reason !== 'ready') {
    throw new Error('An available decision capability must use the ready reason');
  }
  if (capability.state === 'unknown' && capability.reason !== 'no_readiness_source') {
    throw new Error('An unknown decision capability must use the no_readiness_source reason');
  }
  if (capability.state === 'unavailable'
    && (capability.reason === 'ready' || capability.reason === 'no_readiness_source')) {
    throw new Error('An unavailable decision capability must use a failure reason');
  }
  return Object.freeze({ state: capability.state, reason: capability.reason });
}

/**
 * Creates the bounded, immutable capability projection used for one routing decision.
 *
 * - Copies stable availability states and reason codes.
 * - Rejects contradictory states and unbounded lifecycle generations.
 * - Carries no runtime messages, model identifiers or provider details.
 *
 * @returns Defensive frozen capability snapshot.
 *
 * @category Validation Transformation
 */
export function createDecisionCapabilitySnapshot(
  input: DecisionCapabilitySnapshot,
): DecisionCapabilitySnapshot {
  if (!Number.isSafeInteger(input.lifecycleGeneration) || input.lifecycleGeneration < 0) {
    throw new Error('Decision capability lifecycle generation must be a non-negative safe integer');
  }
  if (input.modelExecutionMode !== 'exclusive') {
    throw new Error('Decision capability model execution mode must be exclusive');
  }
  const specialists = Object.freeze({
    coding: copyCapability(input.specialists.coding),
    research: copyCapability(input.specialists.research),
    vision: copyCapability(input.specialists.vision),
  });
  return Object.freeze({
    lifecycleGeneration: input.lifecycleGeneration,
    modelExecutionMode: 'exclusive',
    router: copyCapability(input.router),
    localAnswer: copyCapability(input.localAnswer),
    actions: copyCapability(input.actions),
    webSearch: copyCapability(input.webSearch),
    visibleBrowserResult: copyCapability(input.visibleBrowserResult),
    reminders: copyCapability(input.reminders),
    media: copyCapability(input.media),
    specialists,
  });
}

function copyInputOrigin(input: DecisionInputOrigin): DecisionInputOrigin {
  if (input.kind === 'user_text') return Object.freeze({ kind: 'user_text' });
  if (input.kind !== 'custom_command_expansion') {
    throw new Error('Decision input origin is unsupported');
  }
  const customCommand = boundedText(
    input.customCommand,
    'Decision custom command',
    MAX_DECISION_CUSTOM_COMMAND_LENGTH,
  );
  if (!/^\/[a-z0-9_-]{1,50}$/iu.test(customCommand)) {
    throw new Error('Decision custom command has an invalid format');
  }
  return Object.freeze({ kind: 'custom_command_expansion', customCommand });
}

/**
 * Creates the small immutable context for one router or multi-intent decision.
 *
 * - Binds safe turn metadata, explicit resolved preferences and capabilities.
 * - Bounds and deduplicates every collection.
 * - Excludes raw turn text, URLs, paths, memories and runtime messages by contract.
 *
 * @returns Defensive frozen decision context.
 *
 * @category Validation Transformation
 */
export function createDecisionContext(input: DecisionContext): DecisionContext {
  const turnId = boundedText(input.turn.turnId, 'Decision turn id', MAX_DECISION_TURN_ID_LENGTH);
  if (input.turn.mode !== 'chat' && input.turn.mode !== 'voice') {
    throw new Error('Decision turn mode is unsupported');
  }
  if (typeof input.turn.privateContext !== 'boolean') {
    throw new Error('Decision private-context flag must be boolean');
  }
  if (input.version !== 1) throw new Error('Decision context version is unsupported');
  if (input.programRoles.length > MAX_DECISION_PROGRAM_ROLES) {
    throw new Error('Decision context contains too many program roles');
  }
  if (input.preferredSourceHints.length > MAX_DECISION_SOURCE_HINTS) {
    throw new Error('Decision context contains too many preferred source hints');
  }

  const seenRoles = new Set<ProgramRole>();
  const programRoles = input.programRoles.map((binding) => {
    if (!PROGRAM_ROLE_SET.has(binding.role) || seenRoles.has(binding.role)) {
      throw new Error('Decision context contains an unsupported or duplicate program role');
    }
    seenRoles.add(binding.role);
    return Object.freeze({
      role: binding.role,
      programName: boundedDecisionLabel(
        binding.programName,
        'Decision program name',
        MAX_DECISION_PROGRAM_NAME_LENGTH,
      ),
    });
  });

  const seenSourceIds = new Set<string>();
  const preferredSourceHints = input.preferredSourceHints.map((hint) => {
    const id = boundedDecisionLabel(
      hint.id,
      'Decision source id',
      MAX_DECISION_SOURCE_ID_LENGTH,
    );
    if (seenSourceIds.has(id)) {
      throw new Error('Decision context contains a duplicate preferred source id');
    }
    seenSourceIds.add(id);
    return Object.freeze({
      id,
      description: boundedDecisionLabel(
        hint.description,
        'Decision source description',
        MAX_DECISION_SOURCE_DESCRIPTION_LENGTH,
      ),
    });
  });

  return Object.freeze({
    version: 1,
    turn: Object.freeze({
      turnId,
      mode: input.turn.mode,
      privateContext: input.turn.privateContext,
      inputOrigin: copyInputOrigin(input.turn.inputOrigin),
    }),
    programRoles: Object.freeze(programRoles),
    preferredSourceHints: Object.freeze(preferredSourceHints),
    capabilities: createDecisionCapabilitySnapshot(input.capabilities),
  });
}
