# Specialist Handoff Runtime — Slice 2 Implementation Plan

**Parent:** `2026-09-04-ai-specialist-provider-hub.md`
**Branch:** `feat/specialist-handoff-runtime`

## Outcome

Sarah can form one provider-neutral coding or research handoff, pause an
`IntentPlan` before any external task receives the goal, and resume the exact
remaining state after a short-lived, single-use confirmation. A fake adapter
proves the complete lifecycle without network or paid API access. Production
capabilities remain unavailable until a real adapter is installed.

## Hard boundaries

- No provider SDK, HTTP request, paid request, or production fake adapter.
- No provider, connection, binding, remote-task, URL, path, or secret field in
  `ActionIntent`, `IntentPlan`, `DecisionContext`, or public router events.
- Pending confirmations live only in memory and disappear on expiry, privacy
  change, cancellation, shutdown, and restart.
- Persisted task metadata contains no goal, prompt, answer, file content, path,
  workspace, credential, or raw provider error.
- Provider acceptance never falls back or resubmits automatically.
- A specialist handoff is the final semantic intent in the MVP.

## Checkpoint A — Suspension and confirmation contracts

1. Add `waiting_confirmation` to plan and step execution state with strict
   invariants for exactly one suspended confirmation step.
2. Add explicit suspend and confirmed-resume transitions; never model consent
   as a waiting Promise.
3. Let `IntentPlanExecutor` return a suspension and later continue from a
   validated frozen state without rerunning successful steps or requesting the
   same confirmation again.
4. Add a specialist confirmation subject/grant bound to plan ID, revision,
   fingerprint, source/confirmation turn, step, exact task, capability,
   privacy/mode, selected binding lease, and expiry.
5. Add an in-memory take-once pending-plan store with supersede/cancel/clear.

## Checkpoint B — Provider-neutral task runtime

1. Add strict task request, status, event, usage, public snapshot, and internal
   accepted-task metadata contracts for coding/research.
2. Add a metadata-only atomic task store with primary/backup recovery and
   optimistic generation checks.
3. Add a narrow adapter port and `SpecialistRuntimeService` with injected
   binding/credential resolution and adapters.
4. Persist the accepted remote reference before reporting success; if
   publication fails, best-effort cancel and fail closed.
5. Pin the accepted adapter/binding, deduplicate sequence/events, reject late
   terminal events, and distinguish cancel requested from provider-confirmed
   canceled.
6. Reconcile restart only through safe retrieve; never call start, resume, or
   resubmit automatically. Otherwise mark the task incomplete.
7. Prove start/progress/question/input/resume/cancel/failure/restart/races with
   fake adapters used only in tests.

## Checkpoint C — Conservative router path

1. Allow either the existing two-to-three intent proposal or exactly one
   coding/research handoff; reject sole action, answer, vision, provider fields,
   hidden clauses, alternatives, and trailing work.
2. Add a conservative specialist-goal candidate gate so explicit imperative
   coding/research goals reach the router even when the worker is warm, while
   explanation questions remain normal worker turns.
3. Enforce terminal-handoff ordering in the plan validator.
4. Coordinate binding selection, pending registration, confirmation output,
   fresh capability/privacy/binding/fingerprint validation, exact resume, and
   runtime start without exposing provider details to the router contracts.
5. Resolve specialist confirmation deterministically before action
   confirmation and never guess when more than one confirmation is pending.

## Checkpoint D — Runtime wiring and acceptance

1. Project provider-neutral runtime readiness into the existing capability
   snapshot; lifecycle shutdown always overrides availability and vision stays
   unavailable.
2. Add provider-neutral task state/events and explicit input/resume/cancel
   controls without raw errors or internal IDs.
3. Construct and reconcile the runtime in Main; clear pending consent and stop
   accepting controls during shutdown.
4. Keep production coding/research unavailable because Slice 2 registers no
   real adapter.
5. Run focused contract tests after every checkpoint, then full typecheck,
   suite, build, diff check, and an independent adversarial audit.

## Acceptance

- `Baue TTS in Sarah ein` can create one inert coding handoff proposal.
- Preparation steps remain succeeded while the plan waits for confirmation.
- No adapter receives the task before a matching current confirmation.
- Text/voice replay, stale binding, wrong fingerprint, expiry, privacy change,
  supersede, shutdown, and restart fail closed.
- Resume runs the exact remaining step once.
- Fake adapters cover task acceptance through terminal and interactive states.
- Relaunch never recreates or silently continues an unconfirmed plan and never
  resubmits an accepted task.
