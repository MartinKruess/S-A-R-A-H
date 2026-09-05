# Anthropic implementation plan

Status: Messages implemented and independently audited; confirmed findings fixed.
Baseline checked: dev `3859edb`. Branch: `feat/anthropic-specialist-adapters`.

## Scope and actual availability

Deliver the Anthropic Messages text adapter using a separately acknowledged API
key. Do not offer Claude Pro/Max login, import subscription tokens, or reuse the
host Claude session. Preserve the existing provider-neutral billing disclosure.
The separate Claude Agent coding operation stays unavailable until containment
has been demonstrated; installing an SDK is not sufficient evidence.

Official sandbox documentation currently says native Windows is unsupported;
macOS, Linux and WSL2 are supported for the Bash sandbox. It also distinguishes
Bash isolation from built-in file tools and host environment inheritance. We
must not advertise that a working Windows process is a safely isolated coding
agent. No automatic WSL/container installation or unsandboxed fallback belongs
to this slice.

## Dependencies and documentation verified

- Proposed exact pin: `@anthropic-ai/sdk@0.124.0`, npm registry license `MIT`.
  Registry lookup completed 2026-09-05; it did not return an `engines` field.
  Official SDK docs support TypeScript >=5 and non-EOL Node >=20. Check the
  actual Electron/Node build and locked transitive dependencies before adding.
- Use the official fixed Anthropic endpoint in Main, explicit API key,
  `maxRetries: 0`, bounded timeout and caller abort signal. No browser SDK mode,
  proxy/custom endpoint, tools, MCP, batches, cache-control or beta fallback.
- Messages streaming is event-based; output usage in `message_delta` is
  cumulative. Cancellation closes the stream, not a guarantee about billing.
- Models API supports explicit paginated discovery; listing authentication is
  not a successful paid Messages generation or proof of every model capability.

## Integration points inherited from Plan 1

- `src/services/providers/text-generation-adapter.ts`: implement its existing
  request/context/result port, including `TextGenerationError.partial`.
- `src/services/providers/cloud-text-service.ts`: reuse deliberate cloud-text
  selection, pinned binding/credential generation, current-text-only context,
  no paid fallback and the shared terminal usage callback. Do not duplicate it.
- `src/services/providers/ai-usage-store.ts`: reuse the one-terminal-checkpoint
  sink. No prompt, response, credential or raw provider error in usage metadata.
- `src/main/ai-provider-runtime.ts`: add text registration and Anthropic health
  dispatch while preserving OpenAI and managed-Codex behavior.
- `ai-provider-hub-service.ts`: reuse acknowledgment, credential rotation,
  disabled connection and health gates. Do not mark `anthropic_claude_agent`
  ready because `anthropic_messages_text` is ready.
- Router inherited private context remains local; do not introduce a separate
  Anthropic routing lane or export conversation history/memory/action output.

## Implementation sequence

1. Re-read the files above after OpenAI completes. Resolve any interface changes
   in this document before coding. Independently review this plan against code.
2. Add the pinned official SDK and inspect lock/build compatibility. Keep the
   client factory injectable for fake-fetch tests; never make paid test calls.
3. Implement `AnthropicTextAdapter`: bounded text-only Messages request with
   explicit model and max tokens. Emit only text deltas. Require `message_stop`
   plus a valid terminal stop reason; truncated/missing completion, unsupported
   tool outcomes and transport errors are incomplete rather than successful.
   Handle unknown additive events without leaking raw events or losing the
   requirement for a real terminal event. Abort stream in cleanup.
4. Preserve usage from `message_start` and merge cumulative `message_delta`
   totals by replacement, never addition. Include input/cache fields correctly;
   do not invent an exact reasoning breakdown when the provider does not report
   one. If the shared schema cannot express unavailable per-field data, amend
   that schema deliberately with regressions instead of treating unknown as
   zero. Never estimate monetary cost from token counts.
5. Add bounded key/model health checks with safe status-only errors, generation-
   bound health caching and explicit model selection. Verify the selected model
   through its documented model lookup or bounded complete discovery rather
   than assuming the first models page is exhaustive. Unknown model remains
   unavailable. Model access cannot silently change the configured model.
6. Register only Messages text, reuse settings cost/opt-in controls and display
   coding as unavailable pending platform isolation work. No false success.

## Coding capability follow-up gate

Before adding a productive Claude Agent operation: inspect the actual pinned
Agent SDK and Electron packaging, isolate config/environment/session, prove
workspace and network containment including all file tools, bind permissions
to user-approved scope, and demonstrate cancellation and cleanup. Windows may
require a separately authorized isolated runtime. Until that work passes,
coding readiness is false and no coding SDK is downloaded speculatively.

## Tests and acceptance

Fake SDK transport tests cover exact text-only request, current model, partial
and completed output, max-token stop, malformed/missing terminal, cumulative
usage, cache fields, rate-limit/auth/stream failures, abort and no retries.
Add integration tests for binding opt-in, key rotation, private context, safe
health errors, usage sink failure and unavailable coding. Existing OpenAI
regressions must remain green. Run typecheck/build and proportional suites.

After implementation, run ONE fresh independent subagent audit as requested,
fix confirmed findings and rerun affected tests. The larger cross-provider
audit remains separate. No provider key is available here; mocked verification
is not live acceptance. A later paid smoke needs user credentials and budget.

## Sources checked 2026-09-05

- https://platform.claude.com/docs/en/cli-sdks-libraries/sdks/typescript
- https://platform.claude.com/docs/en/build-with-claude/streaming
- https://platform.claude.com/docs/en/api/models/list
- https://code.claude.com/docs/en/sandboxing
- https://code.claude.com/docs/en/legal-and-compliance
- npm registry: `npm view @anthropic-ai/sdk version license engines --json`

## Independent plan review

Reviewer `anthropic_plan_review` confirmed the Messages slice and required:

- Extend `isModelSupported` with the connection identity/generation at both hub
  call sites. Store discovered models per exact identity; stale/late health
  results cannot grant another connection or replacement generation access.
- Amend both task and usage-record validation for missing fields. Input tokens
  mean total input including cache reads/writes; cache subcounts stay separate.
  Add optional cache-write tokens and optional reasoning breakdown, with a
  persistence/reload regression. Do not invent unknown values as zero.
- Explicit streaming regressions: max_tokens is incomplete even at message_stop;
  post-delta errors retain partial text/known usage; additive unknown events
  never substitute for a real completion.

These changes are part of implementation. This plan review is separate from
the one independent post-implementation audit still required.

## Implementation result and audit

- Messages streaming, exact-generation model discovery, shared cloud text and
  optional usage subcounts are implemented. The native Windows coding gate is
  unchanged; no Agent SDK dependency or unsandboxed execution was introduced.
- `anthropic_independent_audit` performed the single independent implementation
  audit. One P1 (ambient host auth token) and two P2 findings (environment-driven
  prompt logs and unbounded stalled SSE) were reproduced and fixed.
- Anthropic clients now explicitly reject inherited bearer/custom headers and
  redirects, pin API-only identity, disable SDK logging, and bound body streaming.
  The directly affected OpenAI factories also disable SDK logging and inherited
  organization/project selection. Regression tests exercise hostile synthetic
  environment values and hanging streams without actual credentials.
- Pre-fix full validation: 2,279 tests passed, one opt-in test skipped; build
  passed. Final post-fix checks are recorded in the PR. No paid live acceptance.
- Production dependency audit reports only the existing systeminformation
  advisory; no new reported advisory from the pinned Anthropic SDK.
