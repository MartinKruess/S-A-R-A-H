# Bounded Multi-Intent Contract Implementation Plan

**Goal:** Define and validate a fail-closed contract that can represent up to three explicit user intents and up to six trusted plan steps without enabling productive multi-intent execution yet.

**Architecture:** The existing router model may later emit an untrusted structured proposal. Deterministic TypeScript code validates evidence, action parameters, limits, and handoff semantics before creating an immutable `IntentPlan`. The model never supplies plan dependencies; TypeScript derives them. No third LLM is introduced. The productive router prompt, executor, DecisionContext, CapabilitySnapshot, and specialist adapters remain outside this feature.

**Tech Stack:** TypeScript, Zod, Vitest; existing `ActionIntent`, action schemas, grounding, turn envelope, and confirmation boundaries.

## Product Decisions

- The MVP proposal accepts two or three explicit intents. Single-intent input keeps the existing production routing behavior; the new format is not active yet.
- A trusted plan contains at most six steps. This contract derives only the mandatory handoff-confirmation step; future deterministic planning code may add capability prerequisites.
- The later local ceiling is five explicit intents; it is not enabled by this MVP contract.
- Ready steps have no model-selected priority or parallel flag. Dependencies and a future executor determine readiness and concurrency.
- The router model cannot choose trusted IDs, provenance, policy outcomes, confirmation grants, providers, paths, or capability state.
- A handoff identifies a specialist capability such as `coding`, not a concrete provider such as Codex or Claude. A future runtime resolves the configured provider after confirmation.
- Every handoff requires an explicit user confirmation before the goal or project context is sent to the specialist.
- Before confirmation, a future runtime may check whether a configured specialist connection is available, but it must not create a task, send the goal, or disclose project data.
- A confirmation authorizes only the immutable handoff snapshot shown to the user. It does not authorize later downloads, installations, file writes, external commitments, or newly planned steps.
- Replanning changes the plan revision and invalidates every earlier plan confirmation.
- If any proposal element is invalid, no partial trusted plan is returned.
- During later execution, an independent branch may continue after another branch fails; a dependent step is skipped unless all dependencies succeeded.
- Completed side effects are not rolled back automatically after a later failure or cancellation.

## Scope

### Included

- shared immutable plan types
- strict untrusted proposal schema
- deterministic proposal-to-plan validation
- clause-scoped action evidence
- action, local-answer, and specialist-handoff step kinds
- deterministically derived dependency contract
- plan snapshot/fingerprint contract for later confirmation
- focused unit and integration tests
- Layer-3 architecture documentation update

### Excluded

- changing the productive router prompt to emit plans
- executing more than one intent
- DecisionContext and CapabilitySnapshot
- inferred program roles such as `my editor -> VS Code`
- derived prerequisites such as automatically opening Spotify
- real Codex, Claude, backend, extern, or vision handoff
- web-search-result injection into the worker
- UI or voice acceptance

## Contract Boundaries

### 1. Clause-scoped evidence

Extend the existing trusted provenance with a bounded source scope:

```ts
export type ActionEvidenceScope =
  | { readonly kind: 'whole_turn' }
  | {
      readonly kind: 'clause';
      readonly intentId: string;
      readonly ordinal: 0 | 1 | 2;
      readonly startOffset: number;
      readonly endOffset: number;
    };
```

Rules:

- `startOffset` is inclusive and `endOffset` is exclusive within the actual `effectiveText`.
- `0 <= startOffset < endOffset <= effectiveText.length`.
- The selected slice must equal the exact trimmed evidence text supplied by the untrusted proposal. A Unicode-normalization mismatch fails closed instead of producing offsets for a different string.
- The raw clause is not copied into `ActionIntent`, bus events, confirmations, or logs.
- Existing single-intent and deterministic shortcut paths use `whole_turn`.
- `ActionConfirmationGate` copies and compares the complete scope so it cannot be changed after approval.

### 2. Untrusted router proposal

Create a strict Zod schema for model output. It accepts exactly this conceptual shape:

```ts
interface RouterPlanProposal {
  readonly intents: readonly RouterIntentProposal[];
}

type RouterIntentProposal =
  | {
      readonly kind: 'action';
      readonly action: string;
      readonly param: string;
      readonly evidence: string;
    }
  | {
      readonly kind: 'answer';
      readonly evidence: string;
    }
  | {
      readonly kind: 'handoff';
      readonly specialist: 'coding' | 'research' | 'vision';
      readonly evidence: string;
    };
```

Rules:

- The complete output is `SARAH_PROPOSAL_V1 ` followed by the JSON object, with no prose or Markdown fences.
- `intents.length` is 2..3.
- Unknown keys, empty evidence, overlapping or unordered evidence, uncovered meaningful text, and overlong text fail closed.
- Alternative connectors such as `oder`/`or` fail closed until a separate choice contract exists.
- The router cannot supply IDs, dependencies, priorities, confirmation fields, policies, or provider names.
- An answer or handoff task is the exact evidence clause; the contract does not accept a second, invented prompt or goal field.
- Proposal parsing never logs raw output or evidence.

### 3. Trusted plan

Create an immutable application-owned representation:

```ts
interface IntentPlan {
  readonly planId: string;
  readonly revision: number;
  readonly sourceTurnId: TurnId;
  readonly privateContext: boolean;
  readonly originMode: TurnMode;
  readonly steps: readonly PlanStep[];
  readonly fingerprint: string;
}

type PlanStep =
  | ActionPlanStep
  | AnswerPlanStep
  | HandoffConfirmationPlanStep
  | SpecialistHandoffPlanStep;
```

Every step receives an application-generated `stepId`, clause evidence with an ordinal, and application-owned dependency IDs. Action and answer intents create one step. A handoff intent deterministically creates two steps: local confirmation followed by specialist handoff.

- `ActionPlanStep` contains the existing `ActionIntent<ActionName>` unchanged except for its new evidence scope.
- The trusted plan accepts only `semantic_grounding`; existing `schema_only` actions stay outside it until their action-specific grounders exist.
- `AnswerPlanStep` represents the exact clause that a future executor may pass to the existing `local_worker`; it does not imply browser access.
- `HandoffConfirmationPlanStep` contains the exact specialist capability and goal shown to the user and performs no external work.
- `SpecialistHandoffPlanStep` depends on that confirmation step and carries the same immutable capability and goal.
- Provider names and connection details are resolved only by a future executor after confirmation.
- The private-context flag and original voice/chat mode are part of the fingerprint so a later confirmation cannot lose its disclosure or response-mode boundary.
- `fingerprint` is computed from the canonical immutable plan payload and excludes runtime status. It is used only as a later confirmation binding, not as provenance.

### 4. Deterministic validation

The proposal converter must:

1. parse strict JSON with the Zod proposal schema;
2. require one unique occurrence of every evidence clause in the actual `effectiveText`;
3. require evidence clauses to be ordered, non-overlapping, and collectively complete except for punctuation and allowlisted connectors;
4. reject unknown action names through the central allowlist;
5. ground every action parameter against only its own evidence slice and reject still-`schema_only` actions;
6. create trusted action provenance from the `TurnEnvelope`, never from model fields;
7. derive explicit temporal dependencies from grounded connector text and add the mandatory confirmation-to-handoff edge;
8. enforce three explicit intents and six total steps;
9. return one structured validation failure without returning a partial plan.

### 5. Confirmation compatibility

This feature defines the immutable plan snapshot but does not execute or approve it.

The later executor must use a separate plan confirmation subject containing `planId`, `revision`, `fingerprint`, and the exact confirmable steps. It must then mint action-scoped, single-use grants consumed by the existing `ActionService`. Plan IDs and step IDs remain outside `ActionProvenance`.

For a small closed plan, the UI may ask for one explicit confirmation that lists every confirmable step. For an open specialist task, only the exact handoff is confirmed. The specialist's later steps are evaluated and confirmed independently.

## Required Files

- Modify `src/core/action-intent.ts` — add `ActionEvidenceScope` to trusted provenance.
- Modify `src/core/action-confirmation.ts` — copy and compare the scope.
- Create `src/core/intent-plan.ts` — immutable trusted plan and step contracts plus canonical fingerprint helper.
- Create `src/services/llm/router-proposal-contract.ts` — strict, versioned proposal schema and parser.
- Create `src/services/llm/router-plan-validator.ts` — clause grounding and deterministic proposal-to-plan converter.
- Modify `src/services/llm/router-action-flow.ts` — populate `whole_turn` for existing single-intent paths only.
- Modify affected test fixtures — include the new required provenance field.
- Create `tests/core/intent-plan.test.ts`.
- Create `tests/services/llm/router-proposal-contract.test.ts`.
- Create `tests/services/llm/router-plan-validator.test.ts`.
- Modify `docs/architecture/layer-model.md` — record the contract foundation without claiming execution.

## Implementation Tasks

### Task 1: Evidence scope

- Add failing tests for immutable copy, matching, and tamper rejection.
- Add the scope type and populate `whole_turn` on every current producer.
- Update confirmation copying/comparison.
- Run focused confirmation, action, and router tests.

### Task 2: Trusted plan types

- Add tests for canonical fingerprint stability and semantic differences.
- Implement immutable action, answer, and handoff step types.
- Keep runtime status outside the immutable plan.
- Use Node's existing cryptography support; add no dependency.

### Task 3: Strict proposal schema

- Add acceptance tests for two and three intents.
- Add rejection tests for one/four intents, unknown fields, model-supplied dependencies, long values, and unsupported specialists.
- Parse JSON fail-closed without changing the productive route parser.

### Task 4: Proposal converter

- Add tests proving clause-local grounding and cross-clause parameter rejection.
- Resolve unique, ordered, non-overlapping evidence slices and application-owned IDs.
- Reuse the central action allowlist and existing action grounding.
- Build trusted provenance from the envelope.
- Return no partial plan on any failure.

### Task 5: Documentation and regression

- Update Layer 3 to distinguish contract implemented from execution absent.
- Run focused tests during implementation.
- Run `npm test`, `npm run build`, and `git diff --check` before commit.
- Do not perform practical Windows/voice acceptance because no productive behavior is enabled.

## Acceptance Examples

Accepted proposal for the currently semantically grounded action set:

> Set a timer for 10 minutes, then remind me about tea in 20 minutes, and build TTS into Sarah.

```text
step-1 action  set_timer(10m)              dependsOn=[]
step-2 action  set_reminder(20m, tea)      dependsOn=[step-1]
step-3 handoff_confirmation coding         dependsOn=[]
step-4 specialist_handoff coding           dependsOn=[step-3]
```

The Spotify example is structurally parseable but still rejected by the trusted converter because program and volume actions currently provide only schema validation. Their action-specific semantic grounders and the dependency from Spotify startup to Spotify-specific playback or volume control belong to the following planning package.

Accepted handoff boundary for:

> Build TTS into Sarah.

```text
step-1 handoff_confirmation specialist=coding
             goal="Build TTS into Sarah"
step-2 specialist_handoff specialist=coding
             goal="Build TTS into Sarah"
             dependsOn=[step-1]
```

The single handoff example demonstrates the trusted Core contract only. Productive routing does not emit or execute this new representation yet; the proposal schema itself requires 2..3 intents in this MVP.

Rejected:

- four explicit intents;
- an action parameter supported only by a neighboring clause;
- a handoff naming a concrete provider selected by the model;
- a handoff without confirmation semantics;
- any dependency, priority, confirmation, policy, ID, or provider field supplied by the router;
- duplicate or ambiguous evidence text;
- any proposal with an unknown action or extra field.

## Completion Boundary

Completion means the new contract can be constructed and tested directly, and all existing single-intent behavior remains green. It does not mean Sarah can yet understand or execute multiple commands in one utterance. Productive use starts only after DecisionContext/CapabilitySnapshot and the bounded executor/evaluator are implemented and practically accepted.
