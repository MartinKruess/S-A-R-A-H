import { randomUUID } from 'crypto';
import { z } from 'zod';
import {
  AiProviderIdSchema,
  AiProviderOperationIdSchema,
  isAiOperationCompatible,
  type AiProviderId,
  type AiProviderOperationId,
} from './ai-provider-contract.js';
import type { TurnId, TurnMode } from './turn-contract.js';

export type SpecialistHandoffCapability = 'coding' | 'research';

export interface SpecialistBindingLease {
  readonly providerId: AiProviderId;
  readonly operationId: AiProviderOperationId;
  readonly connectionId: string;
  readonly bindingId: string;
  readonly revision: number;
  readonly credentialGeneration?: number;
  readonly authKind?: import('./ai-provider-contract.js').AiAuthKind;
}

export interface SpecialistHandoffDisplay {
  readonly providerName: string;
  readonly roleName: string;
  readonly modelName: string;
}

export interface SpecialistHandoffConfirmationSubject {
  readonly planId: string;
  readonly revision: number;
  readonly fingerprint: string;
  readonly sourceTurnId: TurnId;
  readonly stepId: string;
  readonly task: string;
  readonly capability: SpecialistHandoffCapability;
  readonly privateContext: boolean;
  readonly originMode: TurnMode;
  readonly dataEgress: readonly ('goal' | 'workspace_files' | 'conversation_context')[];
  readonly workspaceReference?: string;
  readonly modelId?: string;
  readonly backgroundConsent?: boolean;
  readonly accessMode: 'none' | 'read_only' | 'workspace_write';
  readonly budget: {
    readonly maxTurns: number;
    readonly timeoutMs: number;
    readonly maxOutputTokens?: number;
    readonly maxToolCalls?: number;
  };
  readonly bindingLease: SpecialistBindingLease;
  readonly display: SpecialistHandoffDisplay;
}

export interface SpecialistHandoffConfirmationRequest {
  readonly confirmationId: string;
  readonly subject: SpecialistHandoffConfirmationSubject;
  readonly expiresAt: number;
}

export interface SpecialistHandoffConfirmationGrant {
  readonly grantId: string;
  readonly confirmationTurnId: TurnId;
  readonly subject: SpecialistHandoffConfirmationSubject;
  readonly expiresAt: number;
}

const DEFAULT_CONFIRMATION_TTL_MS = 5 * 60_000;
const UUID = z.uuid();

function validText(value: string, maximum: number): boolean {
  return value.trim().length > 0 && value.length <= maximum;
}

function isValidSubject(subject: SpecialistHandoffConfirmationSubject): boolean {
  const hasWorkspaceEgress = subject.dataEgress.includes('workspace_files');
  return validText(subject.planId, 100)
    && Number.isSafeInteger(subject.revision)
    && subject.revision > 0
    && /^[a-f0-9]{64}$/u.test(subject.fingerprint)
    && validText(subject.sourceTurnId, 100)
    && validText(subject.stepId, 100)
    && validText(subject.task, 4_096)
    && (subject.capability === 'coding' || subject.capability === 'research')
    && typeof subject.privateContext === 'boolean'
    && (subject.originMode === 'chat' || subject.originMode === 'voice')
    && subject.dataEgress.length >= 1
    && subject.dataEgress.length <= 3
    && new Set(subject.dataEgress).size === subject.dataEgress.length
    && subject.dataEgress.every((item) => (
      item === 'goal' || item === 'workspace_files' || item === 'conversation_context'
    ))
    && (subject.workspaceReference === undefined
      || validText(subject.workspaceReference, 500))
    && (subject.accessMode === 'none'
      || subject.accessMode === 'read_only'
      || subject.accessMode === 'workspace_write')
    && Number.isSafeInteger(subject.budget.maxTurns)
    && subject.budget.maxTurns >= 1
    && subject.budget.maxTurns <= 100
    && Number.isSafeInteger(subject.budget.timeoutMs)
    && subject.budget.timeoutMs >= 1_000
    && subject.budget.timeoutMs <= 24 * 60 * 60_000
    && !(subject.accessMode !== 'none' && !subject.workspaceReference)
    && !(hasWorkspaceEgress && !subject.workspaceReference)
    && !(subject.accessMode === 'none' && hasWorkspaceEgress)
    && AiProviderIdSchema.safeParse(subject.bindingLease.providerId).success
    && AiProviderOperationIdSchema.safeParse(subject.bindingLease.operationId).success
    && isAiOperationCompatible(
      subject.bindingLease.providerId,
      subject.capability,
      subject.bindingLease.operationId,
    )
    && UUID.safeParse(subject.bindingLease.connectionId).success
    && UUID.safeParse(subject.bindingLease.bindingId).success
    && Number.isSafeInteger(subject.bindingLease.revision)
    && subject.bindingLease.revision > 0
    && validText(subject.display.providerName, 100)
    && validText(subject.display.roleName, 100)
    && (subject.modelId === undefined || validText(subject.modelId, 200))
    && (subject.backgroundConsent === undefined || typeof subject.backgroundConsent === 'boolean')
    && (subject.bindingLease.credentialGeneration === undefined
      || (Number.isSafeInteger(subject.bindingLease.credentialGeneration) && subject.bindingLease.credentialGeneration > 0))
    && (subject.budget.maxOutputTokens === undefined
      || (Number.isSafeInteger(subject.budget.maxOutputTokens) && subject.budget.maxOutputTokens > 0 && subject.budget.maxOutputTokens <= 100_000))
    && (subject.budget.maxToolCalls === undefined
      || (Number.isSafeInteger(subject.budget.maxToolCalls) && subject.budget.maxToolCalls > 0 && subject.budget.maxToolCalls <= 100))
    && validText(subject.display.modelName, 200);
}

function copySubject(
  subject: SpecialistHandoffConfirmationSubject,
): SpecialistHandoffConfirmationSubject {
  return Object.freeze({
    planId: subject.planId,
    revision: subject.revision,
    fingerprint: subject.fingerprint,
    sourceTurnId: subject.sourceTurnId,
    stepId: subject.stepId,
    task: subject.task,
    capability: subject.capability,
    privateContext: subject.privateContext,
    originMode: subject.originMode,
    dataEgress: Object.freeze([...subject.dataEgress]),
    ...(subject.workspaceReference ? { workspaceReference: subject.workspaceReference } : {}),
    ...(subject.modelId ? { modelId: subject.modelId } : {}),
    ...(subject.backgroundConsent !== undefined ? { backgroundConsent: subject.backgroundConsent } : {}),
    accessMode: subject.accessMode,
    budget: Object.freeze({ ...subject.budget }),
    bindingLease: Object.freeze({ ...subject.bindingLease }),
    display: Object.freeze({ ...subject.display }),
  });
}

function subjectsMatch(
  left: SpecialistHandoffConfirmationSubject,
  right: SpecialistHandoffConfirmationSubject,
): boolean {
  return left.planId === right.planId
    && left.revision === right.revision
    && left.fingerprint === right.fingerprint
    && left.sourceTurnId === right.sourceTurnId
    && left.stepId === right.stepId
    && left.task === right.task
    && left.capability === right.capability
    && left.privateContext === right.privateContext
    && left.originMode === right.originMode
    && left.dataEgress.length === right.dataEgress.length
    && left.dataEgress.every((item, index) => item === right.dataEgress[index])
    && left.workspaceReference === right.workspaceReference
    && left.modelId === right.modelId
    && left.backgroundConsent === right.backgroundConsent
    && left.accessMode === right.accessMode
    && left.budget.maxTurns === right.budget.maxTurns
    && left.budget.timeoutMs === right.budget.timeoutMs
    && left.budget.maxOutputTokens === right.budget.maxOutputTokens
    && left.budget.maxToolCalls === right.budget.maxToolCalls
    && left.bindingLease.providerId === right.bindingLease.providerId
    && left.bindingLease.operationId === right.bindingLease.operationId
    && left.bindingLease.connectionId === right.bindingLease.connectionId
    && left.bindingLease.bindingId === right.bindingLease.bindingId
    && left.bindingLease.revision === right.bindingLease.revision
    && left.bindingLease.credentialGeneration === right.bindingLease.credentialGeneration
    && left.bindingLease.authKind === right.bindingLease.authKind
    && left.display.providerName === right.display.providerName
    && left.display.roleName === right.display.roleName
    && left.display.modelName === right.display.modelName;
}

function freezeRequest(
  confirmationId: string,
  subject: SpecialistHandoffConfirmationSubject,
  expiresAt: number,
): SpecialistHandoffConfirmationRequest {
  return Object.freeze({ confirmationId, subject: copySubject(subject), expiresAt });
}

function freezeGrant(
  grantId: string,
  confirmationTurnId: TurnId,
  subject: SpecialistHandoffConfirmationSubject,
  expiresAt: number,
): SpecialistHandoffConfirmationGrant {
  return Object.freeze({
    grantId,
    confirmationTurnId,
    subject: copySubject(subject),
    expiresAt,
  });
}

/** Owns short-lived, exact and single-use consent for one specialist handoff. */
export class SpecialistHandoffConfirmationGate {
  private readonly pending = new Map<string, SpecialistHandoffConfirmationRequest>();
  private readonly grants = new Map<string, SpecialistHandoffConfirmationGrant>();

  constructor(
    private readonly ttlMs = DEFAULT_CONFIRMATION_TTL_MS,
    private readonly now: () => number = Date.now,
    private readonly createId: () => string = randomUUID,
  ) {
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1) {
      throw new Error('Specialist confirmation TTL must be a positive integer');
    }
  }

  request(
    subject: SpecialistHandoffConfirmationSubject,
  ): SpecialistHandoffConfirmationRequest | null {
    this.removeExpired();
    if (!isValidSubject(subject)) return null;
    const confirmationId = this.createId();
    if (!validText(confirmationId, 100) || this.pending.has(confirmationId)
      || this.grants.has(confirmationId)) return null;
    const request = freezeRequest(confirmationId, subject, this.now() + this.ttlMs);
    this.pending.set(confirmationId, request);
    return request;
  }

  approve(
    confirmationId: string,
    confirmationTurnId: TurnId,
  ): SpecialistHandoffConfirmationGrant | null {
    this.removeExpired();
    if (!validText(confirmationTurnId, 100)) return null;
    const pending = this.pending.get(confirmationId);
    if (!pending) return null;
    this.pending.delete(confirmationId);
    const grant = freezeGrant(
      confirmationId,
      confirmationTurnId,
      pending.subject,
      pending.expiresAt,
    );
    this.grants.set(confirmationId, grant);
    return grant;
  }

  consume(
    grant: SpecialistHandoffConfirmationGrant,
    expectedSubject: SpecialistHandoffConfirmationSubject,
  ): boolean {
    this.removeExpired();
    if (!grant || !isValidSubject(grant.subject) || !isValidSubject(expectedSubject)
      || !validText(grant.grantId, 100) || !validText(grant.confirmationTurnId, 100)
      || !Number.isSafeInteger(grant.expiresAt)) return false;
    const stored = this.grants.get(grant.grantId);
    if (
      !stored
      || stored.confirmationTurnId !== grant.confirmationTurnId
      || stored.expiresAt !== grant.expiresAt
      || !subjectsMatch(stored.subject, grant.subject)
      || !subjectsMatch(stored.subject, expectedSubject)
    ) return false;
    this.grants.delete(grant.grantId);
    return true;
  }

  hasSinglePending(): boolean {
    this.removeExpired();
    return this.pending.size === 1;
  }

  cancel(confirmationId: string): boolean {
    this.removeExpired();
    return this.pending.delete(confirmationId) || this.grants.delete(confirmationId);
  }

  invalidateSourceTurn(turnId: TurnId): void {
    this.removeExpired();
    for (const [id, pending] of this.pending) {
      if (pending.subject.sourceTurnId === turnId) this.pending.delete(id);
    }
    for (const [id, grant] of this.grants) {
      if (grant.subject.sourceTurnId === turnId) this.grants.delete(id);
    }
  }

  clear(): void {
    this.pending.clear();
    this.grants.clear();
  }

  private removeExpired(): void {
    const current = this.now();
    for (const [id, pending] of this.pending) {
      if (pending.expiresAt <= current) this.pending.delete(id);
    }
    for (const [id, grant] of this.grants) {
      if (grant.expiresAt <= current) this.grants.delete(id);
    }
  }
}
