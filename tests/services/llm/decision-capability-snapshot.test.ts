import { describe, expect, it } from 'vitest';
import type { RuntimeSnapshot, RuntimeState } from '../../../src/core/app-lifecycle-controller.js';
import type { ServiceStatus } from '../../../src/core/types.js';
import type { ModelRuntimeSnapshot } from '../../../src/services/llm/model-runtime.js';
import {
  buildDecisionCapabilitySnapshot,
  type BuildDecisionCapabilitySnapshotInput,
} from '../../../src/services/llm/decision-capability-snapshot.js';

function lifecycle(state: RuntimeState = 'ready'): RuntimeSnapshot {
  return {
    state,
    generation: 7,
    updatedAt: 123_456,
    capabilities: {
      actions: { state: 'ready', message: 'C:\\private\\actions.exe' },
      search: { state: 'ready', message: 'https://private.example/search' },
      reminders: { state: 'ready', message: 'private database error' },
    },
  };
}

function modelRuntime(
  routerAvailability: ModelRuntimeSnapshot['roles']['router']['availability'] = 'available',
  workerAvailability: ModelRuntimeSnapshot['roles']['local_worker']['availability'] = 'available',
): ModelRuntimeSnapshot {
  return {
    state: 'ready',
    activeRole: 'router',
    roles: {
      router: {
        model: 'private-router-model',
        availability: routerAvailability,
        residency: 'loaded',
        message: 'private router runtime message',
      },
      local_worker: {
        model: 'private-worker-model',
        availability: workerAvailability,
        residency: 'unloaded',
        message: 'private worker runtime message',
      },
    },
  };
}

function input(
  overrides: Partial<BuildDecisionCapabilitySnapshotInput> = {},
): BuildDecisionCapabilitySnapshotInput {
  return {
    lifecycle: lifecycle(),
    modelRuntime: modelRuntime(),
    serviceReadiness: {
      actions: 'running',
      search: 'running',
      reminders: 'running',
    },
    webAccessAllowed: true,
    hasVisibleBrowserResult: true,
    ...overrides,
  };
}

describe('buildDecisionCapabilitySnapshot', () => {
  it('projects explicit ready inputs without leaking runtime details', () => {
    const snapshot = buildDecisionCapabilitySnapshot(input());

    expect(snapshot).toMatchObject({
      lifecycleGeneration: 7,
      modelExecutionMode: 'exclusive',
      router: { state: 'available', reason: 'ready' },
      localAnswer: { state: 'available', reason: 'ready' },
      actions: { state: 'available', reason: 'ready' },
      webSearch: { state: 'available', reason: 'ready' },
      visibleBrowserResult: { state: 'available', reason: 'ready' },
      reminders: { state: 'available', reason: 'ready' },
      media: { state: 'unknown', reason: 'no_readiness_source' },
      specialists: {
        coding: { state: 'unavailable', reason: 'no_adapter' },
        research: { state: 'unavailable', reason: 'no_adapter' },
        vision: { state: 'unavailable', reason: 'no_adapter' },
      },
    });
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain('private');
    expect(serialized).not.toContain('http');
    expect(serialized).not.toContain('C:\\');
  });

  it.each<RuntimeState>(['registered', 'starting', 'unavailable', 'error', 'stopping', 'stopped'])(
    'fails closed while lifecycle state is %s',
    (state) => {
      const snapshot = buildDecisionCapabilitySnapshot(input({ lifecycle: lifecycle(state) }));

      expect(snapshot.router).toEqual({ state: 'unavailable', reason: 'lifecycle_unavailable' });
      expect(snapshot.localAnswer).toEqual({ state: 'unavailable', reason: 'lifecycle_unavailable' });
      expect(snapshot.actions).toEqual({ state: 'unavailable', reason: 'lifecycle_unavailable' });
      expect(snapshot.webSearch).toEqual({ state: 'unavailable', reason: 'lifecycle_unavailable' });
      expect(snapshot.visibleBrowserResult).toEqual({
        state: 'unavailable',
        reason: 'lifecycle_unavailable',
      });
      expect(snapshot.reminders).toEqual({ state: 'unavailable', reason: 'lifecycle_unavailable' });
      expect(snapshot.media).toEqual({ state: 'unavailable', reason: 'lifecycle_unavailable' });
    },
  );

  it('requires available model roles without requiring both models to be resident', () => {
    const unavailable = buildDecisionCapabilitySnapshot(input({
      modelRuntime: modelRuntime('error', 'unavailable'),
    }));
    const exclusive = buildDecisionCapabilitySnapshot(input());

    expect(unavailable.router).toEqual({ state: 'unavailable', reason: 'model_unavailable' });
    expect(unavailable.localAnswer).toEqual({ state: 'unavailable', reason: 'model_unavailable' });
    expect(exclusive.router.state).toBe('available');
    expect(exclusive.localAnswer.state).toBe('available');
    expect(exclusive.modelExecutionMode).toBe('exclusive');
  });

  it('requires both lifecycle-ready and running services', () => {
    const notRunning: Record<'actions' | 'search' | 'reminders', ServiceStatus> = {
      actions: 'pending',
      search: 'running',
      reminders: 'running',
    };
    const lifecycleNotReady = lifecycle();
    lifecycleNotReady.capabilities.search = { state: 'degraded' };

    const actionsUnavailable = buildDecisionCapabilitySnapshot(input({
      serviceReadiness: notRunning,
    }));
    const searchUnavailable = buildDecisionCapabilitySnapshot(input({
      lifecycle: lifecycleNotReady,
    }));

    expect(actionsUnavailable.actions).toEqual({ state: 'unavailable', reason: 'service_unavailable' });
    expect(actionsUnavailable.webSearch).toEqual({ state: 'unavailable', reason: 'service_unavailable' });
    expect(actionsUnavailable.reminders).toEqual({ state: 'unavailable', reason: 'service_unavailable' });
    expect(searchUnavailable.webSearch).toEqual({ state: 'unavailable', reason: 'service_unavailable' });
  });

  it('applies web policy and visible-result state independently', () => {
    const denied = buildDecisionCapabilitySnapshot(input({ webAccessAllowed: false }));
    const noResult = buildDecisionCapabilitySnapshot(input({ hasVisibleBrowserResult: false }));

    expect(denied.webSearch).toEqual({ state: 'unavailable', reason: 'policy_denied' });
    expect(denied.visibleBrowserResult).toEqual({ state: 'unavailable', reason: 'policy_denied' });
    expect(noResult.webSearch).toEqual({ state: 'available', reason: 'ready' });
    expect(noResult.visibleBrowserResult).toEqual({
      state: 'unavailable',
      reason: 'no_visible_result',
    });
  });

  it('returns a deeply frozen projection detached from mutable inputs', () => {
    const mutableInput = input();
    const snapshot = buildDecisionCapabilitySnapshot(mutableInput);
    mutableInput.lifecycle.generation = 99;
    mutableInput.lifecycle.capabilities.actions = { state: 'error' };
    mutableInput.modelRuntime.roles.router.availability = 'error';

    expect(snapshot.lifecycleGeneration).toBe(7);
    expect(snapshot.router.state).toBe('available');
    expect(snapshot.actions.state).toBe('available');
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.router)).toBe(true);
    expect(Object.isFrozen(snapshot.specialists)).toBe(true);
    expect(Object.isFrozen(snapshot.specialists.coding)).toBe(true);
  });
});
