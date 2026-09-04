# Decision Context and Capability Snapshot Plan

**Status:** implemented and verified

**Branch:** `feat/decision-context`

**Scope:** Layer 3 foundation, point 2

## Goal

Give the bounded multi-intent compiler the smallest trustworthy context it needs
to make a valid plan:

- which explicitly configured local program role is meant by phrases such as
  "my editor";
- which relevant preferred sources may guide a later search handoff;
- which local capabilities are currently dispatchable;
- whether the current turn is private and where its text originated.

The context is an immutable, short-lived projection for one turn. It is neither
memory nor execution authority.

## Non-goals

- no automatic learning of preferences or program roles;
- no profile, memory, history, program path, URL or runtime error text in the
  decision context;
- no productive router-prompt activation or action execution;
- no new planner model;
- no inferred specialist availability without an implemented adapter;
- no replacement of the authoritative action policy or live runtime checks.

## Contract

### Turn projection

The context binds to exactly one `TurnEnvelope` and carries:

- turn id and mode;
- the final private-context flag, including inherited private context;
- either direct user input or a custom-command expansion;
- for a custom command, only its name, never arguments or expanded text.

### Explicit program roles

Add a bounded resource configuration for these roles:

- `browser`;
- `code_editor`;
- `music_player`.

A role points to a configured program by name. The context builder resolves it
only when exactly one verified program matches. It publishes the canonical
program name, never its path or process metadata. Missing, stale or ambiguous
bindings are omitted and therefore fail closed. Program names containing URL
or filesystem-path literals are invalid at the core contract boundary.

The MVP may resolve an allowlisted semantic parameter such as
`role:code_editor` for `open_program`. The final action parameter and its local
role resolution are bound into action provenance and the plan fingerprint.

### Preferred source hints

Select at most five link preferences relevant to the current utterance by a
small deterministic token match. Publish only bounded ids and descriptions.
URLs stay in the authoritative configuration and are resolved later by the
search/browser layer. Ids or descriptions containing URL or filesystem-path
literals are omitted by the builder and rejected by the core contract.

This is preference routing, not proof that a source is reachable or correct.

### Decision capability snapshot

Introduce a new `DecisionCapabilitySnapshot` name to avoid collision with the
existing lifecycle leaf `CapabilitySnapshot`.

The snapshot contains only stable availability states and reason codes for:

- router model;
- local answer model;
- actions;
- web search;
- visible browser result;
- reminders;
- media;
- coding, research and vision specialists.

It also records the lifecycle generation and the exclusive model-execution
mode. It must not contain model names, provider details, paths, request ids or
free-form status/error messages.

Availability rules fail closed:

- lifecycle states that do not accept work disable dispatch;
- a model role is available only when ModelRuntime reports it available;
- service availability requires an explicit running/ready signal;
- web search additionally requires web policy permission;
- browser-result actions require a currently visible result;
- media remains `unknown` until a real readiness source exists;
- specialists remain `unavailable/no_adapter` until adapters exist.

The snapshot is advisory. Future execution must re-check live service state and
the exact parameter-dependent action policy immediately before each step.

## Integration boundary

Bind the context only to the inactive `SARAH_PROPOSAL_V1` compiler introduced in
the previous feature:

- require a matching context for proposal validation;
- derive plan privacy from that context;
- bind the original voice/chat mode into the immutable plan;
- reject intents whose required capability is unavailable or unknown;
- resolve only allowlisted explicit program roles;
- keep volatile capability data out of `IntentPlan` and its fingerprint;
- keep resolved action provenance inside the immutable plan.

The production routing prompt and executor remain unchanged. They are the scope
of the following Layer 3 points.

## Implementation steps

1. Add immutable core decision-context and capability contracts with bounded
   factory validation.
2. Extend resource configuration and settings with explicit, unique
   program-role bindings.
3. Add pure capability-snapshot and decision-context builders.
4. Add config-backed program-role parameter resolution and provenance binding.
5. Require the context in the inactive plan validator and enforce capability
   gates.
6. Document the boundary and add focused unit tests.
7. Run affected tests, the full test suite, build and diff checks.

## Acceptance criteria

- The context cannot expose program paths, link URLs, memories, history or
  runtime messages.
- "Open my editor" can compile only through one explicit verified
  `code_editor` binding, with the resolved program and role in provenance.
- Missing or ambiguous roles are rejected rather than guessed.
- Disabled web policy and unavailable services block corresponding plans.
- Media and unimplemented specialists cannot be planned as available.
- Capability changes do not mutate an already-created plan and are not trusted
  as execution authorization.
- Existing single-intent production behavior remains unchanged.
