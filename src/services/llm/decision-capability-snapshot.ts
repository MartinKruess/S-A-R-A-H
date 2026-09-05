import type { RuntimeSnapshot } from '../../core/app-lifecycle-controller.js';
import {
  createDecisionCapabilitySnapshot,
  type DecisionCapability,
  type DecisionCapabilitySnapshot,
} from '../../core/decision-context.js';
import type { SpecialistCapability } from '../../core/intent-plan.js';
import type { ServiceStatus } from '../../core/types.js';
import type { ModelRuntimeSnapshot } from './model-runtime.js';

export interface DecisionServiceReadiness {
  readonly actions: ServiceStatus;
  readonly search: ServiceStatus;
  readonly reminders: ServiceStatus;
}

export interface BuildDecisionCapabilitySnapshotInput {
  readonly lifecycle: RuntimeSnapshot;
  readonly modelRuntime: ModelRuntimeSnapshot;
  readonly serviceReadiness: DecisionServiceReadiness;
  readonly searchAcceptingWork: boolean;
  readonly webAccessAllowed: boolean;
  readonly hasVisibleBrowserResult: boolean;
  readonly specialists?: Readonly<Record<SpecialistCapability, DecisionCapability>>;
}

function capability(
  state: DecisionCapability['state'],
  reason: DecisionCapability['reason'],
): DecisionCapability {
  return { state, reason };
}

function lifecycleAcceptsWork(lifecycle: RuntimeSnapshot): boolean {
  return lifecycle.state === 'ready' || lifecycle.state === 'degraded';
}

function modelRuntimeAcceptsWork(modelRuntime: ModelRuntimeSnapshot): boolean {
  return modelRuntime.state === 'ready' || modelRuntime.state === 'degraded';
}

function serviceIsReady(
  lifecycle: RuntimeSnapshot,
  serviceId: 'actions' | 'search' | 'reminders',
  status: ServiceStatus,
): boolean {
  return status === 'running' && lifecycle.capabilities[serviceId]?.state === 'ready';
}

/**
 * Projects current runtime truth into the bounded Layer-3 capability contract.
 *
 * - Requires accepting lifecycle/model states and explicit service readiness.
 * - Applies the persistent web policy before exposing search or browser results.
 * - Omits runtime messages, model/provider identities and resource details.
 *
 * @returns Immutable advisory snapshot; never an execution authorization.
 *
 * @category Transformation Validation
 */
export function buildDecisionCapabilitySnapshot(
  input: BuildDecisionCapabilitySnapshotInput,
): DecisionCapabilitySnapshot {
  const lifecycleReady = lifecycleAcceptsWork(input.lifecycle);
  const modelRuntimeReady = modelRuntimeAcceptsWork(input.modelRuntime);
  const routerLifecycleReady = input.lifecycle.capabilities.router?.state === 'ready';
  const workerLifecycleReady = input.lifecycle.capabilities.local_worker?.state === 'ready';
  const router = !lifecycleReady || !routerLifecycleReady
    ? capability('unavailable', 'lifecycle_unavailable')
    : modelRuntimeReady
      && input.modelRuntime.roles.router.availability === 'available'
      ? capability('available', 'ready')
      : capability('unavailable', 'model_unavailable');
  const localAnswer = !lifecycleReady || !workerLifecycleReady
    ? capability('unavailable', 'lifecycle_unavailable')
    : modelRuntimeReady
      && input.modelRuntime.roles.local_worker.availability === 'available'
      ? capability('available', 'ready')
      : capability('unavailable', 'model_unavailable');

  const actionsReady = lifecycleReady && serviceIsReady(
    input.lifecycle,
    'actions',
    input.serviceReadiness.actions,
  );
  const actions = !lifecycleReady
    ? capability('unavailable', 'lifecycle_unavailable')
    : actionsReady
      ? capability('available', 'ready')
      : capability('unavailable', 'service_unavailable');
  const searchReady = actionsReady && serviceIsReady(
    input.lifecycle,
    'search',
    input.serviceReadiness.search,
  ) && input.searchAcceptingWork;
  const webSearch = !lifecycleReady
    ? capability('unavailable', 'lifecycle_unavailable')
    : !input.webAccessAllowed
      ? capability('unavailable', 'policy_denied')
      : searchReady
        ? capability('available', 'ready')
        : capability('unavailable', 'service_unavailable');
  const visibleBrowserResult = webSearch.state !== 'available'
    ? capability('unavailable', webSearch.reason)
    : input.hasVisibleBrowserResult
      ? capability('available', 'ready')
      : capability('unavailable', 'no_visible_result');
  const remindersReady = actionsReady && serviceIsReady(
    input.lifecycle,
    'reminders',
    input.serviceReadiness.reminders,
  );
  const reminders = !lifecycleReady
    ? capability('unavailable', 'lifecycle_unavailable')
    : remindersReady
      ? capability('available', 'ready')
      : capability('unavailable', 'service_unavailable');
  const media = !lifecycleReady
    ? capability('unavailable', 'lifecycle_unavailable')
    : actionsReady
      ? capability('unknown', 'no_readiness_source')
      : capability('unavailable', 'service_unavailable');
  const noAdapter = capability('unavailable', 'no_adapter');
  const lifecycleUnavailable = capability('unavailable', 'lifecycle_unavailable');
  const specialists = !lifecycleReady
    ? {
        coding: lifecycleUnavailable,
        research: lifecycleUnavailable,
        vision: lifecycleUnavailable,
      }
    : input.specialists ?? {
        coding: noAdapter,
        research: noAdapter,
        vision: noAdapter,
      };

  return createDecisionCapabilitySnapshot({
    lifecycleGeneration: input.lifecycle.generation,
    modelExecutionMode: 'exclusive',
    router,
    localAnswer,
    actions,
    webSearch,
    visibleBrowserResult,
    reminders,
    media,
    specialists,
  });
}
