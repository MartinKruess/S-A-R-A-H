# Bounded Planner and Evaluator MVP

**Scope:** Layer 3 points 4 and 5

## Goal

Activate the existing `SARAH_PROPOSAL_V1` contract for two or three explicit
intents and execute a trusted `IntentPlan` through a small deterministic
executor/evaluator. The existing router model remains the only planning model.

## Product boundary

- Existing single-action and single-worker routing stays unchanged.
- A proposal is accepted only when every clause is grounded by the existing
  validator and the same immutable `DecisionContext` used for routing.
- Execution is serial and stable in plan order for the first MVP. Independent
  means dependency-free, not necessarily concurrent.
- Every action is checked again by the productive `ActionService` immediately
  before its side effect.
- A plan containing a currently denied, preparation-only, or confirmation-only
  action is rejected before any step runs. Turn-spanning group confirmation is
  a separate contract and must not be improvised from the single-action gate.
- Answer steps send only their exact evidence clause to the local worker.
- Specialist handoffs remain unavailable until a real adapter and a
  plan-bound confirmation contract exist.
- No retry, automatic re-planning, alternative tool selection, compensation,
  persistence of plans, or semantic quality judgement is part of this MVP.

## Deterministic evaluation

The execution state is immutably bound to plan id, revision, fingerprint,
source turn, and the exact step ids. A pending step becomes ready only after
all dependencies succeeded. A failed step skips only its dependants;
independent later steps continue. Cancellation marks remaining work canceled.

The final state is:

- `completed` when every step succeeded;
- `partially_completed` when at least one step succeeded and another failed or
  was skipped;
- `failed` when no executable step succeeded;
- `canceled` after an explicit abort.

## Implementation

1. Add immutable plan-execution/evaluation state and unit tests.
2. Add a serial `IntentPlanExecutor` with typed action, answer, confirmation,
   and specialist adapters.
3. Extend router inference with the bounded proposal output and minimized
   decision context while preserving legacy tags.
4. Build one context per routing decision, compile proposals fail-closed, and
   execute valid plans under the current turn abort signal.
5. Add structured plan-action and clause-answer adapters without weakening
   existing policy, confirmation, provenance, privacy, or model exclusivity.
6. Update Layer 3 documentation and run focused tests, full tests, build, and
   diff checks before practical chat/voice acceptance.

## Acceptance

- Two or three supported explicit intents execute once in deterministic order.
- Temporal dependencies wait for predecessor success.
- A failed dependency never executes its dependant.
- Independent branches continue after a neighboring failure.
- Malformed or ungrounded proposals execute nothing and produce one honest
  response.
- The worker sees only the answer clause, not the complete multi-intent input.
- Router and worker are never resident concurrently.
- The original turn has exactly one terminal event.
- Existing single-intent behavior remains green.
