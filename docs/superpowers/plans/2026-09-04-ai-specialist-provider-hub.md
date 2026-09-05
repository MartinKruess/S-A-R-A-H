# AI Specialist Provider Hub Implementation Plan

**Scope:** Provider-neutral AI connection and role hub plus OpenAI, Anthropic,
and Perplexity adapters.

**Status:** Shared foundation and inert specialist runtime merged into `dev`
through PRs #54/#55. Productive provider adapters remain unimplemented.
The OpenAI implementation plan and authentication decision addendum are in
`2026-09-05-openai-specialist-adapters.md` and the integration decisions spec.

## Goal

Let users connect the three supported AI provider families once and assign each
connection to one or more explicit roles:

- `text` for optional cloud-generated normal answers;
- `coding` for an autonomous coding specialist;
- `research` for long-running, cited research.

The router continues to choose only a provider-neutral role. Application-owned
code selects the configured provider binding, obtains task-specific consent,
starts the correct adapter, and tracks its lifecycle without exposing secrets or
provider details to the router model.

## Plan decomposition decision

Use one architectural plan, but implement it as six ordered slices and separate
feature PRs. Do not build one monolithic PR and do not create three disconnected
provider architectures.

The shared connection, binding, consent, task-state, privacy, and selection
contracts are more important than the similarities between individual HTTP
requests. OpenAI Responses, Codex App Server, Anthropic Messages, Claude Agent,
and Perplexity Agent have different lifecycle and cancellation semantics.

## Prerequisite

- Merge the current bounded-plan work into `dev` before starting implementation.
- Start the first implementation branch from the updated `dev` branch.
- Keep this planning document and the cost-warning requirement together when the
  implementation branch is created.

## Mandatory architecture gates

Slices 1 and 2 are the shared security and lifecycle foundation, not optional
preparation work:

1. Slice 1 must keep AI credentials, connection metadata, and role bindings
   separate from the existing OAuth/Spotify schemas and stores.
2. Slice 2 must define `waiting_confirmation`, pending-plan ownership, exact
   resume, cancellation, expiry, restart, and late-event behavior in the shared
   contracts before a productive provider adapter is integrated.
3. The fake-adapter contract tests are test-first acceptance gates for Slice 2,
   not an exploratory provider playground.
4. No productive OpenAI, Anthropic, or Perplexity adapter branch may begin until
   Slices 1 and 2 have passed their acceptance criteria and are merged into
   `dev`. Compatibility spikes may run earlier, but they must not establish a
   competing runtime or contract.
5. Provider SDK objects must never leave the Main-process adapter boundary.
   Allowlisted provider IDs may appear only in the settings IPC/renderer DTOs
   needed to configure the hub. Provider IDs and provider-specific lifecycle
   states must never cross into the router proposal, `IntentPlan`,
   `DecisionContext`, public router events, or local `ModelRuntime`.

## Current code baseline

### Reusable

- `src/core/intent-plan.ts` already represents provider-neutral `coding`,
  `research`, and `vision` handoffs and deterministically expands a handoff into
  confirmation followed by delegation.
- `src/services/llm/router-proposal-contract.ts` prevents the router from naming
  concrete providers.
- `src/services/llm/router-plan-validator.ts` binds a specialist goal to the exact
  user evidence and the original turn.
- `src/core/decision-context.ts` exposes only bounded role availability, without
  provider IDs, secrets, URLs, or filesystem paths.
- `src/services/llm/intent-plan-executor.ts` already has narrow adapter seams for
  confirmation and specialist delegation.
- `src/services/integrations/token-store.ts` provides useful encrypted-envelope,
  backup, recovery, atomic-write, and fail-closed patterns.
- The existing connection IPC and settings section provide reusable status-row,
  pending-action, error, and refresh patterns.

### Missing or intentionally inactive

- Every specialist is hard-coded as `unavailable/no_adapter` in
  `decision-capability-snapshot.ts`.
- `RouterWorkerFlow` currently fails both specialist confirmation and handoff.
- A single explicit coding or research goal cannot currently produce a handoff;
  the structured proposal contract is enabled only for two or three intents.
- The current plan executor cannot pause for a confirmation turn and resume. A
  waiting adapter would block the very user turn needed to confirm it.
- `LlmProvider` and `ModelRuntime` are optimized for local Ollama text generation
  and exclusive local VRAM residency. They do not represent durable specialist
  jobs and must not be expanded into a universal agent abstraction.
- The connection layer is OAuth/Spotify-specific. Its secret schema cannot store
  API keys or managed Codex account sessions.
- No specialist task, progress, approval, input-required, result, or cancellation
  events exist yet.

## Product decisions encoded by this plan

### Provider families and operation adapters

| Provider family | Role | Operation adapter |
| --- | --- | --- |
| OpenAI | text | OpenAI Responses |
| OpenAI | research | OpenAI Deep Research via Responses |
| OpenAI | coding | Codex App Server |
| Anthropic | text | Anthropic Messages |
| Anthropic | coding | Claude Agent SDK |
| Perplexity | research | Perplexity Agent API |

- Do not use Perplexity as a transparent proxy for OpenAI or Anthropic in the
  initial product.
- Do not implement image, audio, vision, arbitrary OpenAI-compatible endpoints,
  or a free/custom adapter in this plan.
- Do not advertise Managed Claude Agents in the Desktop MVP. Use the local Claude
  Agent SDK, subject to the Windows packaging and sandbox spike.
- Use the user-facing name `Claude Agent`, not `Claude Code`, for the third-party
  integration.

### Connections and role bindings

A connection answers "how Sarah authenticates to this provider." A binding
answers "for which one role and at which fallback position Sarah uses it."

- One visible binding row has exactly one role.
- One provider connection may back multiple binding rows.
- The MVP permits at most one saved account per provider and auth kind. OpenAI
  may therefore have one API connection for Responses and one separately managed
  ChatGPT login for Codex without mixing their billing or credential semantics.
- Role priority is deterministic and per role: one standard binding followed by
  ordered fallbacks.
- The router never receives provider IDs, connection IDs, model IDs, priorities,
  or credentials.
- The local 8B worker remains an implicit built-in `text` binding. A user must
  deliberately make a cloud text binding standard before ordinary answers leave
  the device.
- `text` is a generation role, not a durable specialist handoff. `coding` and
  `research` use the specialist task lifecycle.

### Selection and fallback

- Resolve a binding only after the router has selected a role.
- Selection uses enabled, policy-allowed, healthy bindings in configured order.
- Fallback is allowed only before the first provider has accepted a chargeable
  request, emitted content, created a remote job, or begun a side effect.
- After acceptance, resume, cancel, and follow-up input remain pinned to the same
  adapter and provider task ID.
- Never silently switch an active coding task between Codex and Claude Agent.
- Never retry a potentially charged request merely because a response stream was
  interrupted.

### Consent and private mode

- Saving an API key requires acknowledgement of the current, versioned general
  API-cost warning.
- Anthropic additionally shows the detailed Claude warning already specified in
  `docs/superpowers/specs/2026-09-04-ai-specialist-integration-decisions.md`.
- The warning applies to separately billed API-key paths. If Codex later uses a
  supported ChatGPT-managed login, the UI must describe that subscription path
  accurately instead of claiming it is API-billed.
- Deleting a connection deletes its acknowledgement as well. Reconnection or a
  newer warning version requires a new acknowledgement.
- Normal external text may use the one-time connection/default-role consent in
  ordinary mode; it must not ask on every message.
- Every coding or research handoff requires task-specific confirmation before the
  goal or context is disclosed.
- Private/anonymous turns never call external AI providers in the MVP.
- `webAccessAllowed` and filesystem permissions do not imply consent to export
  data to an AI provider.
- Initial handoff consent authorizes only the displayed goal, provider binding,
  data-egress manifest, and initial access mode. Later file writes, commands,
  downloads, external messages, purchases, or broader access use their own
  provider-tool approvals.

### Cost and usage honesty

- Sarah links to each provider's current pricing and spending-limit controls.
- Sarah does not promise that it can enforce a provider-account spending cap.
- Per-run limits use documented controls such as maximum output tokens, tool
  calls, turns, timeouts, or sandbox scope where available.
- Every adapter normalizes available usage fields into a local usage record:
  provider, role, model, input, cached input, output, reasoning, tool calls, and
  provider-reported cost.
- If a provider does not return monetary cost, Sarah shows tokens only and does
  not calculate a supposedly exact price from a stale hard-coded table.
- Prompts, answers, API keys, and raw provider errors are not written to the usage
  ledger.

## Shared contracts

### AI provider catalog

Create a fixed application-owned catalog with:

- provider ID: `openai | anthropic | perplexity`;
- display name and supported auth modes;
- supported role/operation pairs;
- current general and provider-specific warning versions;
- pricing and spending-limit help links;
- an injected connection-health adapter.

The catalog contains no user credentials and is never model-generated.

### Connection metadata and secret records

Public connection metadata includes:

- application-generated connection ID;
- provider ID and auth kind;
- display label;
- `hasCredential`, warning acknowledgement version, and timestamps;
- safe health state and last checked time.

Secret records contain only the provider credential material needed by the
adapter. They are never returned to the renderer, written to `SarahConfig`, or
included in logs and errors. A Codex ChatGPT-managed session remains owned by
Codex/App Server and the operating-system credential store; Sarah stores only
non-secret connection metadata and does not copy its tokens into the AI key
store.

Use a separate encrypted file per AI connection, with connection- and
provider-bound AAD plus its own backup. This preserves the requested deletion and
corruption isolation: one broken or removed AI connection must not invalidate
Spotify or other AI connections.

### Health state

Use truthful states rather than equating "key exists" with "connected":

- `not_configured`;
- `credential_saved_unverified`;
- `checking`;
- `healthy`;
- `invalid_credentials`;
- `temporarily_unavailable`;
- `storage_degraded`.

Prefer a documented non-chargeable authentication/model-list check. If a
provider requires a charged generation to prove the integration, label the
explicit button "Testanfrage durchführen – kann Kosten verursachen" and never run
it automatically on settings render.

### Role binding

Persist non-secret bindings separately from credentials:

- binding ID and connection ID;
- `text | coding | research` role;
- operation adapter ID;
- provider-specific model ID/profile;
- enabled flag;
- deterministic fallback position;
- revision used to invalidate stale selections and confirmations.

Model IDs belong to bindings because provider APIs require a concrete model and
pricing varies materially by model. Known defaults may be bundled, but available
models should be fetched through a provider adapter when the API supports it.

### Specialist task request

A request contains only bounded application-owned fields:

- task ID, role, exact goal, source turn, plan ID/revision/fingerprint, and step;
- selected binding ID and revision;
- private-context flag and interaction mode;
- explicit data-egress manifest;
- workspace reference and requested access mode for coding;
- configured token/tool/turn/time budget.

History, memories, paths, files, and browser results are opt-in fields, not an
implicit expansion of the goal.

### Specialist handoff confirmation

Create a dedicated `SpecialistHandoffConfirmationGate`; do not reuse
`ActionConfirmationGate`.

The confirmation subject binds:

- plan ID, revision, fingerprint, source turn, and exact handoff step;
- selected binding and binding revision;
- displayed provider/role/model;
- exact goal and data-egress manifest;
- workspace and initial permission mode;
- expiry, confirmation turn, and a single-use grant ID.

Provider selection happens locally before the prompt so the user can see the
actual destination. No provider process, remote job, prompt, workspace data, or
credential leaves the device before confirmation. A changed binding, plan,
privacy state, workspace, or permission request invalidates the grant.

### Pausable plan execution

Extend the plan execution contract with a bounded suspension state instead of
waiting inside one turn:

- a confirmation step may become `waiting_confirmation`;
- the plan execution becomes `waiting_confirmation` and is stored only in an
  in-memory, expiring pending-plan store;
- the request turn emits the confirmation prompt and completes normally;
- an unambiguous `/confirm` or spoken confirmation in a later turn consumes the
  grant, revalidates live policy/capability/binding state, and resumes the exact
  frozen plan state;
- rejection, expiry, shutdown, privacy change, or a different user request
  cancels the pending plan;
- shutdown or application restart permanently invalidates every unconfirmed
  grant and in-memory pending plan; Sarah creates a new proposal and asks again
  instead of restoring or reusing consent;
- already completed local preparation steps remain completed and are not rolled
  back.

This preserves the intended flow: Sarah may open the project first, report the
prepared state, ask whether Codex or Claude Agent should take over, and continue
only after confirmation.

For the MVP, a specialist handoff must be the terminal semantic intent in its
branch. Successful delegation means "the specialist accepted the task", not
"the specialist completed the goal". Later plan steps must not accidentally run
as if a background specialist task had already finished.

### Specialist task lifecycle

Create a separate `SpecialistRuntimeService`, not part of `ModelRuntime`, with:

- `preflight`, `start`, `resume`, `provideInput`, `cancel`, and `snapshot`;
- bounded global and per-provider concurrency;
- adapter-pinned provider task/session handles;
- a minimal task store for provider-accepted background job/thread IDs, binding
  identity, status, timestamps, and safe terminal metadata;
- idempotent controls and monotonically sequenced events;
- shutdown cancellation/draining;
- sanitized stable error codes.

Keep the two forms of pending state distinct:

- An unconfirmed handoff and its frozen plan state are sensitive, ephemeral, and
  exist only in memory. They never survive restart.
- A provider-accepted task may have already incurred cost. Persist only its safe
  correlation metadata before reporting acceptance. On startup, reconcile a
  non-terminal task only through the same pinned adapter and a documented
  retrieve/status operation. Never recreate or automatically resubmit the task.
  If safe reconciliation is unavailable, mark it `incomplete`; any continuation
  requires a new explicit user decision.

Normalized states:

- `queued`;
- `starting`;
- `running`;
- `waiting_for_user`;
- `completed`;
- `failed`;
- `cancel_requested`;
- `canceled`;
- `incomplete`.

Turn cancellation and provider cancellation are not the same fact. If Sarah can
only abort its local transport, keep the task at `cancel_requested` until the
provider confirms cancellation or the result becomes unknown/incomplete.

### Adapter ports

Use two small execution interfaces instead of one universal LLM interface:

1. `TextGenerationAdapter` for streamed ordinary answers and usage.
2. `SpecialistTaskAdapter` for coding/research task lifecycle, events, input,
   resume, cancellation, citations, and artifacts.

Both receive credentials through an internal secret resolver and emit only the
normalized shared contracts. Provider SDK objects never escape the adapter.

## Provider implementation requirements

### OpenAI

#### Responses text adapter

- Use the official OpenAI SDK and Responses API.
- Stream text through `TextGenerationAdapter`.
- Use local conversation/context construction and `store: false` by default.
- Capture documented usage and request IDs without logging prompts or answers.
- Disable automatic cross-provider fallback after the first output/event.

#### Deep Research adapter

- Use Responses with documented research tools and visible clickable citations.
- Treat research as a specialist task, not a normal answer call.
- Background mode requires explicit task consent because the provider retains the
  response temporarily for polling and it is incompatible with ZDR behavior.
- Persist only the minimum remote response ID needed to poll/cancel while Sarah
  is responsible for the job; durably publish that ID before reporting the job as
  accepted so an app restart does not orphan a paid background request. Store no
  prompt or answer in this task record and define an explicit deletion/expiry
  policy.
- Map `queued`, `in_progress`, `completed`, `failed`, `cancelled`, and
  `incomplete` without inventing success.

#### Codex adapter

- Prefer Codex App Server over the small SDK because Sarah needs authentication,
  thread history, approvals, and streamed agent events.
- Run the app server as a supervised local child process registered with the
  application lifecycle.
- Support read-only and workspace-write sandbox modes; never default to full
  access.
- Map Codex approval/input events to specialist events and require separate user
  approval for newly requested capabilities.
- Store only safe thread references and resume the exact selected connection.
- Decide before implementation whether the MVP supports:
  - OpenAI API key only; or
  - both API key and documented ChatGPT-managed login for Codex.
- A ChatGPT-managed Codex path must have different billing copy from the generic
  API-cost warning.
- If ChatGPT-managed login is enabled, configure Codex credential caching to use
  the operating-system credential store and fail closed instead of accepting a
  plaintext `auth.json` fallback controlled by Sarah.

### Anthropic

#### Messages text adapter

- Use the official `@anthropic-ai/sdk` in the main process only.
- Stream SSE text and normalize request/usage metadata.
- Do not expose API keys to the renderer or browser bundle.
- Disable or centrally control SDK automatic retries so an interrupted paid
  request is not silently duplicated.
- Keep provider message objects inside the adapter.

#### Claude Agent adapter

- Use `@anthropic-ai/claude-agent-sdk` and API-key authentication.
- Default to non-persistent sessions and an explicitly selected workspace.
- Map the SDK async event stream, questions, approvals, usage, and terminal
  results to the shared task contract.
- Supervise interrupt/close and the bundled native process during shutdown.
- Complete a Windows/Electron packaging spike before productive integration:
  CommonJS/ESM compatibility, optional native binary inclusion, asar behavior,
  process cleanup, and available sandbox/permission controls.
- If adequate workspace isolation cannot be demonstrated, keep the adapter
  unavailable rather than releasing a broad command-execution path.

### Perplexity

#### Research adapter

- Use the official Perplexity TypeScript SDK and Agent API.
- Use Perplexity-native research configuration, not third-party provider models,
  in the initial adapter.
- Normalize citations, usage, provider-reported cost, tool events, and terminal
  status.
- Implement only retrieve/resume/cancel behavior documented at implementation
  time. A local `AbortController` must not be described as provider-confirmed
  cancellation or guaranteed billing stop.
- If durable background retrieval is not documented and verified, ship the first
  version as a foreground streamed task with an honest `incomplete` state after
  transport loss.

## Implementation slices and branch order

### Slice 1 — AI connection hub foundation

Suggested branch: `feat/ai-provider-hub-foundation`

1. Add provider, connection, health, cost-warning, binding, and usage contracts.
2. Add fixed provider catalog for OpenAI, Anthropic, and Perplexity.
3. Add per-connection encrypted AI credential store with migration-free new
   filename/AAD and isolated backups.
4. Add provider connection service with save/delete/status/check operations,
   warning-version enforcement, race protection, and sanitized errors. Until a
   provider adapter exists, keys remain truthfully `credential_saved_unverified`.
5. Add strict typed IPC/preload APIs; never return a credential or key fragment.
6. Extend the Integrations settings UI with three AI provider cards, password
   input, warnings, acknowledgement, health, test, and delete controls.
7. Add non-secret role binding configuration and UI rows with standard/fallback
   order and model/profile selection.
8. Leave all DecisionContext specialist capabilities unavailable.

Acceptance:

- Connections and bindings can be configured without making an AI request.
- Deleting one connection cannot remove or corrupt another or Spotify.
- Missing acknowledgement prevents key storage.
- Renderer, config snapshots, logs, errors, and tests never contain a saved key.
- No settings render causes a charged request.

### Slice 2 — Specialist runtime, suspension, and fake adapter

Suggested branch: `feat/specialist-handoff-runtime`

1. Write the fake-adapter contract suite first, covering suspension, exact
   resume, expiry, replay, cancellation, restart, stale bindings, duplicate and
   late events, and accepted-task reconciliation.
2. Add the specialist task state machine, normalized events, and usage shape.
3. Add `SpecialistRuntimeService` with injected fake adapters and a minimal
   metadata-only task store.
4. Add the specialist confirmation gate and expiring in-memory pending-plan store.
5. Extend plan execution with `waiting_confirmation` and exact-state resume.
6. Add a structured single-handoff route accepted only for explicit coding or
   research goals; keep ordinary single questions on the existing worker route.
7. Revalidate all actions, bindings, privacy, capabilities, and fingerprints on
   resume.
8. Add specialist task events and explicit input/resume/cancel controls.
9. Reconcile persisted provider-accepted task metadata on startup without
   recreating, resubmitting, or automatically continuing a task.
10. Populate role availability from the runtime only when a healthy binding and
   adapter exist.
11. Keep provider IDs out of the router proposal, IntentPlan, DecisionContext, and
   public router events.

Acceptance:

- "Baue TTS in Sarah ein" can create one inert coding handoff proposal.
- A preparation action can finish, the plan can pause, and confirmation can
  resume the exact remaining step in a later text or voice turn.
- No specialist receives the goal before confirmation.
- Confirmation replay, stale binding, wrong fingerprint, expiry, privacy change,
  and shutdown all fail closed.
- Relaunch cannot restore a pending confirmation or silently resubmit an accepted
  provider task.
- Fake adapters demonstrate start, progress, question, answer, cancel, failure,
  and late-event races without network access.
- Slice 3 cannot start until this acceptance block passes and Slice 2 is merged
  into `dev`.

### Slice 3 — OpenAI adapters

Suggested branch: `feat/openai-specialist-adapters`

1. Perform dependency/runtime compatibility checks.
2. Implement Responses text and Deep Research task adapters.
3. Implement supervised Codex App Server adapter and the selected auth mode.
4. Add OpenAI-specific mapping, redaction, usage, citation, background, approval,
   and lifecycle tests.
5. Activate only the verified OpenAI role capabilities.

### Slice 4 — Anthropic adapters

Suggested branch: `feat/anthropic-specialist-adapters`

1. Perform SDK and bundled Agent binary packaging/sandbox spike.
2. Implement Messages text adapter.
3. Implement Claude Agent coding adapter only if the spike passes.
4. Add retry, SSE, partial failure, process cleanup, permission, usage, and
   warning tests.
5. Activate only verified Anthropic role capabilities.

### Slice 5 — Perplexity research adapter

Suggested branch: `feat/perplexity-research-adapter`

1. Recheck the current documented Agent API lifecycle.
2. Implement research start/stream and only verified retrieve/cancel operations.
3. Normalize citations, reported cost, usage, and task status.
4. Test transport abort versus confirmed provider cancellation explicitly.
5. Activate the Perplexity research capability only after contract tests pass.

### Slice 6 — Cross-provider integration and audit

Suggested branch: `test/ai-specialist-hub-acceptance`

1. Test standard/fallback selection across all provider roles.
2. Test no fallback after chargeable acceptance, output, job creation, or side
   effects.
3. Test provider removal while selected, while waiting for confirmation, and
   while a task is active.
4. Test private mode, shutdown, relaunch, stale events, repeated controls, and
   disconnected network behavior.
5. Run full automated tests, typecheck, build, Electron packaging, and Windows
   process-cleanup checks.
6. Run opt-in paid smoke tests only for credentials the user explicitly supplies.
7. Complete an independent security/privacy/cost audit before merge.

## Testing without paid API access

Most implementation work does not require funded provider accounts:

- strict Zod contract tests;
- injected fake HTTP/SDK clients and scripted async iterables;
- sanitized provider fixtures for success, streaming, duplicate/out-of-order
  events, malformed payloads, partial output, 401/402/403/409/429/5xx, and
  transport failure;
- fake clocks for timeout, expiry, polling, and backoff;
- confirmation replay and stale-selection tests;
- key redaction and no-secret IPC/log assertions;
- connection corruption/deletion isolation tests;
- usage and provider-reported-cost aggregation tests;
- service startup/shutdown, child-process cleanup, and late-event tests;
- renderer logic tests for warnings, acknowledgement, health, and role order.

These tests establish Sarah's contracts and failure handling, not real-provider
acceptance.

## Optional live smoke matrix

Live tests are manual, opt-in, separately budgeted, and never CI requirements.
Use dedicated low-limit keys and the cheapest suitable model/configuration.

1. Save and remove a key without exposing it.
2. Run one tiny text response and verify the real streaming/usage shape.
3. Run one minimal research request and verify citations and cancellation status.
4. Run one read-only coding-agent task with a strict turn/time limit.
5. Compare provider dashboard usage with Sarah's local usage record.
6. Revoke the key provider-side and confirm Sarah reports invalid credentials
   without deleting unrelated connections.

If an adapter has not completed this smoke test, label it "automated contracts
verified; live provider acceptance open" rather than calling it fully tested.

## Main files expected to change

Shared foundation:

- `src/core/config-schema.ts`
- `src/core/ipc-contract.ts`
- `src/core/sarah-api.ts`
- `src/core/decision-context.ts`
- `src/core/intent-plan.ts`
- `src/core/plan-execution-state.ts`
- `src/core/bus-events.ts`
- `src/main.ts`
- `src/main/ipc-connections.ts` or a new AI-specific IPC module
- `src/preload.ts`
- `src/renderer/dashboard/views/sections/connections-section.ts`
- new `src/services/integrations/ai-*` modules
- new `src/services/specialists/*` modules

Router/runtime wiring:

- `src/services/llm/router-proposal-contract.ts`
- `src/services/llm/router-plan-validator.ts`
- `src/services/llm/routing-prompt.ts`
- `src/services/llm/decision-capability-snapshot.ts`
- `src/services/llm/intent-plan-executor.ts`
- `src/services/llm/router-worker-flow.ts`
- `src/services/llm/router-service.ts`

Provider adapters and focused tests are added under dedicated provider folders.
Do not place provider SDK behavior directly in `RouterService`, `ModelRuntime`,
the renderer, or the generic plan contracts.

## Explicitly deferred

- arbitrary/custom AI providers;
- generic OpenAI-compatible base URLs;
- image, audio, vision, and PDF generation adapters;
- Anthropic Managed Agents;
- provider-to-provider task migration;
- automatic price scraping or supposedly exact local dollar estimates;
- automatic purchasing, credit loading, or provider spending-limit changes;
- more than one saved account per provider and auth kind;
- durable sensitive handoff plans across application restarts;
- automatic continuation after restart; accepted metadata-only background tasks
  may be rediscovered, but Sarah must ask before resuming an interrupted agent;
- automatic reverse planning of an open-ended expert task inside the small router.

## Decisions to confirm before Slice 1 implementation

1. **Codex authentication (approved 2026-09-05):** API key plus documented
   Codex-managed ChatGPT login, subject to secure storage and current supported
   app-server behavior; OpenAI text/research remain API-key-only. Anthropic's
   own SDK adapter and Perplexity use API keys, not consumer subscription tokens.
2. **Cloud text behavior:** Recommendation: the configured standard text binding
   may answer without per-message confirmation in ordinary mode; private mode
   remains local-only.
3. **Connection count:** Recommendation: one saved account per provider and auth
   kind for the MVP. This permits a separately billed OpenAI API connection and a
   ChatGPT-managed Codex connection while deferring multiple API accounts.
4. **Provider selection disclosure:** Recommendation: resolve and fingerprint the
   exact provider/model before requesting task consent, then forbid silent changes
   after confirmation.
5. **Usage history:** Recommendation: capture normalized usage records now and
   add a detailed monthly cost dashboard later.

## Definition of done

- The three provider families can be connected and removed independently.
- One connection can appear in multiple single-role binding rows.
- The router chooses only `text`, `coding`, or `research`, never a provider.
- Local code deterministically selects standard/fallback bindings.
- Single and multi-intent coding/research handoffs pause and resume safely across
  confirmation turns.
- No goal or context reaches a specialist before exact consent.
- Private mode remains local-only.
- Provider jobs are correlated, cancellable to the extent honestly documented,
  and protected from late or duplicate events.
- Costs and usage are represented truthfully without implying that Sarah controls
  provider billing.
- Automated tests pass without real API credentials.
- Each productive adapter's live-acceptance status is reported separately.
