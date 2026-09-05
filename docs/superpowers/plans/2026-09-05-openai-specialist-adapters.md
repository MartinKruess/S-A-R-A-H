# OpenAI adapters implementation plan

Status: Responses text/research and Sarah-owned managed Codex login implemented.
Coding execution remains deliberately unavailable: the pinned native read-only
sandbox does not enforce the promised selected-project-only read boundary.
Baseline: dev `47ed1cc`, including merged foundation #54 and runtime #55.
Branch: `feat/openai-specialist-adapters`.

## Scope and decisions

Implement Responses text, Responses research, and supervised Codex App Server.
Keep SDK/process behavior in Main; preserve provider-neutral router contracts.
Do not infer API funding from a ChatGPT subscription. User decision: support
API key and official Codex-managed ChatGPT login for coding. Responses text and
research remain API-key-only. See the authentication compliance addendum below.
No paid smoke tests without user-supplied credentials and explicit budget.

## Original code gaps (baseline before implementation)

- `main.ts` registers no adapters and null selection/credential resolvers.
- `ai-provider-hub-service.ts` has no real health adapter; saved keys are unverified.
- Bindings support only `provider_default`; execution needs a concrete pinned model.
- `router-worker-flow.ts` uses the local worker directly; text is not a task adapter.
- `specialist-handoff-coordinator.ts` currently grants goal-only, access-none
  consent, with no workspace or background-retention configuration.
- Task snapshots carry state/input/usage, not research results and citations.
- Existing specialist IPC provides controls, but the user needs visible task
  results and approval controls before productive adapters can be enabled.

## Implementation order

### 1. Compatibility and contract closure

Verify supported official SDK versions, license, runtime and Windows process
compatibility before adding dependencies. Pin an app-server protocol version and
validate protocol fixtures against that binary's generated schema. Do not use
the host application's private credentials, configuration or Codex home.

Registry metadata checked: `openai@7.10.0` requires Node >=22 and is Apache-2.0;
`@openai/codex@0.153.4` is Apache-2.0 and publishes Windows x64/arm64 native
optional packages. These are candidate pins, not completed runtime validation.

Extend binding configuration with bounded operation-valid model selection and
explicit cloud-text standard opt-in. Existing bindings remain inert until valid
configuration and healthy execution capability exist. Changes invalidate pending
consent through binding revision. A model-list health check proves authentication,
not access to every operation; display these as separate facts.

Add internal credential/binding resolution with acknowledgement, storage-health,
enabled-state and revision checks. Keep fallback before dispatch only; ambiguous
paid dispatch must never cause a second generation elsewhere.

Connection lifecycle is part of the lease: add a monotonic credential/connection
revision and invalidate health/consent on replacement. Never send controls for an
accepted task with a different account key. On deletion, close selection first,
cancel/drain accepted work with its existing identity, then erase credentials;
if remote cancellation cannot be confirmed, disclose that fact without claiming
billing stopped. Keep cancellation-only credentials bounded in memory during
drain, never restore a deleted key or silently persist a second secret copy.

### 2. Shared UI and execution boundaries

Add `TextGenerationAdapter` outside `ModelRuntime`, with normalized deltas,
completion/usage and safe failures. Wire ordinary cloud-text generation only
after deliberate standard selection; private turns always remain local. Do not
silently export memories, history or browser contents. Freeze the allowed text
context policy and disclose it in settings. Keep local VRAM ownership unchanged.
Initial cloud context is current user text plus an application-owned generic
instruction only, with no history, memories, personal system prompt or action
results. Gate on the draft's inherited `privateContext`, not just `/anonymous`
in the latest command. Validate again immediately before network dispatch.

Extend exact task consent with concrete model, research retention disclosure,
workspace reference and access mode. Workspace selection must be explicit and
Main-owned, canonically resolved; a reference is not a model-provided path.
Changed scope/model/workspace invalidates consent. Research remains goal-only.
Research also requires current `webAccessAllowed` at availability, confirmation
and dispatch; AI egress consent cannot override denied web access. Revalidate
permission changes for active work and prevent additional unauthorized calls.
Workspace access never implicitly grants a coding agent unrestricted network
access. Pin token/tool limits in both consent and request, with operation-level
validation and a truthful display of supported versus unsupported limits.

Add bounded, ephemeral result delivery separate from persisted metadata, with
safe text rendering and validated clickable HTTP(S) citations. Do not persist
goals/results or encode them in event IDs. Render task state, cancellation and
request-ID/sequence-bound question/approval controls. Approval is structured,
not arbitrary free text interpreted as permission. Unknown tool approvals deny.

### 3. Responses text

Use official OpenAI SDK, fixed service endpoint, `store:false`, streamed output,
explicit output budget, no SDK automatic retries. Map completion, incomplete,
usage and transport failures honestly. Revalidate connection before dispatch.
Never re-run after a partial answer; sanitize raw provider errors and request data.

### 4. Research

Use a documented research model and web-search source only, with bounded output,
tool and time budgets. Require explicit background-retention task consent.
Persist accepted response reference before publication and poll the same task.
Integrate polling with runtime shutdown, deletion/revocation and deadline rules.
Do not consume the 256-event replay budget for every poll or text delta: emit
bounded meaningful state changes, with content delivered through the result path.

Map queued/in-progress/completed/failed/cancelled/incomplete; retrieving an
existing result is not resubmitting a goal. Local abort alone does not prove
provider cancellation. Handle immediate completion and late acceptance without
losing the result or orphaning known jobs. Expired/unretrievable jobs are
incomplete, never silently recreated. Define remote retention/deletion behavior
from current docs and the actual selected storage mode, not stale assumptions.

### 5. Codex

Supervise a dedicated app-server child with isolated configuration, bounded
JSON-RPC framing, request IDs/timeouts, redacted failures and lifecycle cleanup.
No inherited MCP servers, hooks, plugins, user instructions or account sessions.
Verify Windows sandbox support before enabling workspace access. Never enable
danger-full-access. Fail closed if containment cannot be established.

Map thread/turn IDs internally and persist only safe references. Correlate
progress, questions, approvals and results to the exact task and request.
Do not auto-resume a turn after restart. Unknown approval capabilities are denied;
filesystem changes/commands/downloads require the applicable separate grant.
Task cancellation must interrupt the exact turn and confirm terminal state.
Do not equate runtime `maxTurns` (currently user controls) with autonomous agent
iterations. Keep user-interaction count distinct from provider-supported work
limits; enforce documented limits where available and otherwise advertise only
the actual time/output/tool constraints, never a fictitious spend cap.

Implement both approved authentication paths. Managed login gets its own metadata/billing UI and OS-keyring-only
session storage; it must not be passed to Responses as an API credential.

### 6. Registration and acceptance

Add a shared metadata-only usage sink based on `AiUsageRecordSchema`, called by
text/research/coding completion and partial-failure paths. Pin model identity at
dispatch; deduplicate by application task/turn and usage checkpoint, never sum
cumulative provider totals repeatedly. Persist no prompt, answer or raw error.
Bound retention (90 days and 10,000 records, oldest first); isolated atomic
storage failure must not re-run a charged request or change a completed answer
to a retryable generation failure. Explicitly represent unavailable usage as
unknown, not zero. Test duplicate events, partial usage, missing usage, rotation
and write failures. Monetary values only come from provider-reported usage.

Register verified operations and real readiness in Main. Exercise the full path
from configured binding through router proposal, confirmation, adapter, result
and shutdown. No role becomes available merely because a key exists.

## Verification and audit gates

Before coding, an independent subagent reviews this plan against actual code.
Record findings and resolutions below. Then use separately owned implementation
subtasks and five bounded audit rounds, fixing confirmed issues between rounds:

1. Contract/wiring and role-selection behavior.
2. Consent, privacy, credentials, workspace and tool-approval boundaries.
3. Lifecycle races, cancellation, late acceptance, restart and provider removal.
4. Streaming, result/citation rendering, usage and UI controls.
5. Regression and adversarial cross-boundary review of the OpenAI slice.

Use fake SDK/process transports for success, malformed payloads, revoked keys,
rate limits, partial output, hanging operations and duplicate/late events.
Run targeted tests per change and full tests/typecheck/build for shared impact.
Restore Electron SQLite ABI after tests. Distinguish automated verification,
Windows packaging verification and still-open live-provider acceptance.
Commit only scoped files; PR targets dev, squash merge only with passing gates.
Then repeat code-grounded plan/review/implementation for Anthropic and Perplexity.

## Official sources checked on 2026-09-05

- https://developers.openai.com/api/docs/guides/background
- https://developers.openai.com/api/docs/guides/deep-research
- https://learn.chatgpt.com/docs/app-server

## Independent review

Independent reviewer: `openai_plan_review`; read-only review completed.

- P1 credential rotation/deletion: added credential generation and bounded
  cancellation-before-erasure contract. Rotation during health, confirmation and
  start, plus deletion during polling, are required race tests.
- P1 web policy bypass: added availability/consent/dispatch/live-work checks,
  including separate coding-network permission.
- P2 autonomous budgets: distinguished UI interaction count from actual provider
  work and added pinned token/tool constraints with honest enforcement reporting.
- P2 usage persistence: added shared metadata-only sink, model identity,
  deduplication, retention, missing-usage and write-failure behavior.

Reviewer recommendation: implement after these four additions. The user has now
chosen the documented managed Codex login plus API-key path. All four additions are recorded. No productive
adapter has been implemented or declared available by this document.

## Authentication compliance addendum (user approved)

- OpenAI: only official Codex App Server managed login for subscription-backed
  coding; no cookie/token imports, browser scraping, unofficial auth endpoints,
  experimental external-token mode or subscription-to-Responses proxy.
- Anthropic: Messages and our own Agent SDK adapter use the user's API key.
  No Claude.ai login or Pro/Max session credentials in Sarah. Running the
  unmodified Claude Code binary under Anthropic's separate hosting conditions
  is a different integration and is not implemented by this plan.
- Perplexity: documented API-key access only. No supported subscription-backed
  authentication was established; do not describe that as an identical explicit
  prohibition to Anthropic's rule.
- Implement a closed provider/operation/auth-policy matrix first, with tests for
  all supported and rejected combinations. This policy alone does not activate
  login, extend stored credential schemas or establish live integration readiness.
- Apply that policy at connection creation, binding changes, selection and
  dispatch when each real adapter is wired. Never trust a renderer-selected
  billing label or auth mode; derive the actual mode from the owned connection
  and validated provider session state. Wrong/unknown modes fail closed.
- Keep API and subscription connections separate. Managed credentials stay with
  Codex in an isolated Sarah-owned home and OS keyring, with no plaintext
  fallback. Do not borrow existing host app sessions or bypass workspace rules.
- Before managed activation migrate public/stored connection capacity from three
  to four (OpenAI API + OpenAI managed + Anthropic API + Perplexity API), preserving
  existing encrypted API-key records unchanged. Discriminate API acknowledgement
  from subscription disclosure; do not merely widen the shared API auth enum.
- Bind managed account/session generation to health, consent, task identity and
  controls. Login/logout/account replacement invalidates pending grants and must
  not reroute accepted-task controls through a replacement account.
- On subscription limits or auth failure, do not silently switch to paid API.
  Any change of billing path requires an explicit user choice and new task grant.
- API-key paths require the existing versioned API-cost acknowledgement. Managed
  Codex instead states that the selected ChatGPT plan's access and limits apply;
  it never promises unlimited/free usage or access to the general OpenAI API.
- Before release, recheck current official authentication/terms and required
  notices against the shipped binary/version. Documentation establishes the
  intended supported path, not a blanket legal guarantee for every deployment.
- Tests: forbidden provider/auth combinations, subscription credentials offered
  to Responses, spoofed billing labels, stale session/account change, denied
  keyring, token leakage, logout and no paid fallback after quota exhaustion.

Sources checked 2026-09-05:

- https://learn.chatgpt.com/docs/app-server
- https://learn.chatgpt.com/docs/auth
- https://code.claude.com/docs/en/legal-and-compliance
- https://www.perplexity.ai/help-center/en/articles/10354847-api-payment-and-billing

Authentication addendum independently reviewed by `auth_policy_review`:
no blocker for the isolated policy slice. Both P2 findings (four-connection
migration and managed-session identity) incorporated above before activation.
The original policy-only commit left runtime readiness unchanged. The following
implementation now extends that foundation; the historical slice notes below
do not describe current adapter readiness.

First slice completed:

- `ai-auth-policy.ts`: immutable closed auth/billing/disclosure matrix.
- `ai-provider-hub-store.ts`: binding validation enforces that matrix.
- Public/stored API-only schemas remain unchanged; no new login is advertised.
- Independent code review found one P2 fixture weakness: missing commit ID made
  rejection vacuous. Fixed by deriving from a valid persisted snapshot and
  changing only auth kind; the baseline is asserted readable first.
- Validation: 127 tests across seven affected contract/store/service/IPC/UI-logic
  suites, main and renderer typecheck, and build passed. No network generation,
  live account login, paid request or packaged Electron acceptance performed.

## Implementation and single independent audit — 2026-09-05

- Real Responses streaming text and ID-pinned background research are composed
  in Main, including key health checks, explicit models, consent, results,
  citations, cancellation, metadata-only usage and private-mode exclusion.
- Codex App Server is pinned to 0.153.4 and uses Sarah-owned state and OS keyring.
  Device login/logout/status and the protocol transport are implemented. Native
  initialize/account-read smoke passed without login or generation. Execution
  is NOT advertised: see `src/services/providers/codex/PROTOCOL-NOTES.md`.
- Connection generation is pinned across confirmation/start/control/recovery.
  Recovery can use the exact current acknowledged identity without volatile
  health state; this resolver cannot authorize new generation.
- The user superseded the earlier five-pass proposal with exactly one independent
  implementation audit per provider. `openai_independent_audit` completed that
  audit. Confirmed P1 start/deletion race and restart credential recovery, plus
  P2 non-success usage loss and hidden cancellation uncertainty, were corrected.
- Regression tests cover the fixes. Initial full suite: 2,255 passing tests,
  one opt-in native test skipped. Final post-fix validation is recorded in the PR.
- No paid requests, real account login, actual provider billing comparison, or
  packaged Electron acceptance have been performed. These remain explicit live
  acceptance work, not inferred from fixture tests.
- Dependency audit: new OpenAI dependencies introduced no reported production
  advisory; the existing `systeminformation` high advisory remains out of scope.
