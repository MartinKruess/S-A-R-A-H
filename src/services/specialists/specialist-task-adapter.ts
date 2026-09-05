import type {
  AcceptedSpecialistTaskMetadata,
  SpecialistAdapterEvent,
  SpecialistTaskRequest,
  SpecialistTaskStatus,
} from '../../core/specialist-task.js';
import type {
  AiProviderId,
  AiProviderOperationId,
} from '../../core/ai-provider-contract.js';

export interface SpecialistResolvedBinding {
  readonly bindingId: string;
  readonly bindingRevision: number;
  readonly providerId: AiProviderId;
  readonly operationId: AiProviderOperationId;
  readonly connectionId: string;
}

export type SpecialistBindingResolver = (
  role: SpecialistTaskRequest['role'],
) => SpecialistResolvedBinding | null;

export type SpecialistCredentialResolver = (
  connectionId: string,
  providerId: AiProviderId,
) => string | null;

export interface SpecialistAdapterContext {
  readonly resolveCredential: () => string | null;
  readonly emit: (event: SpecialistAdapterEvent) => void;
}

export type SpecialistAdapterPreflightResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: 'unavailable' | 'policy_denied' };

export interface SpecialistAdapterAcceptance {
  readonly remoteRef: string;
  readonly status: Extract<SpecialistTaskStatus, 'queued' | 'running'>;
}

export interface SpecialistTaskAdapter {
  readonly operationId: AiProviderOperationId;
  isReady(): boolean;
  preflight(
    binding: SpecialistResolvedBinding,
    signal?: AbortSignal,
  ): Promise<SpecialistAdapterPreflightResult>;
  start(
    request: SpecialistTaskRequest,
    context: SpecialistAdapterContext,
    signal?: AbortSignal,
  ): Promise<SpecialistAdapterAcceptance>;
  retrieve?(
    task: AcceptedSpecialistTaskMetadata,
    context: SpecialistAdapterContext,
    signal?: AbortSignal,
  ): Promise<SpecialistAdapterEvent | null>;
  resume(
    task: AcceptedSpecialistTaskMetadata,
    context: SpecialistAdapterContext,
    signal?: AbortSignal,
  ): Promise<void>;
  provideInput(
    task: AcceptedSpecialistTaskMetadata,
    input: string,
    context: SpecialistAdapterContext,
    signal?: AbortSignal,
  ): Promise<void>;
  cancel(
    task: AcceptedSpecialistTaskMetadata | SpecialistAdapterAcceptance,
    context: SpecialistAdapterContext,
    signal?: AbortSignal,
  ): Promise<void>;
}

export type { SpecialistAdapterEvent } from '../../core/specialist-task.js';
