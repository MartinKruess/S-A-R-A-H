# Perplexity native research adapter

Status: implemented and independently audited after Anthropic merge #57,
baseline dev `b323e33`. Branch: `feat/perplexity-research-adapter`.

## Verified scope

Use the official `@perplexity-ai/perplexity_ai` SDK, candidate pin `0.38.5`
(Apache-2.0; installation/type compatibility still to verify). Native model
`perplexity/sonar` is explicitly listed in the freshly fetched Agent model
catalog. No preset, `models` fallback array, Router API, third-party model,
custom endpoint, or subscription authentication belongs in this slice.

Source: https://docs.perplexity.ai/docs/agent-api/models

## Existing code to reuse

- `SpecialistTaskAdapter`: `start` accepts a remote reference; `activate` runs
  after durable acceptance; `retrieve`, `cancel`, result and policy callbacks.
- Shared Main hub binding/model allowlists, versioned API acknowledgement,
  exact credential generation, connection drain, and recovery-only resolver.
- Provider-neutral research confirmation, goal-only egress, current web-policy
  check, ephemeral bounded results/citations, and metadata-only usage sink.
- OpenAI polling implementation is a lifecycle reference, not a schema to copy.
  In-progress Anthropic work changes text registration; Perplexity adds research
  only and must preserve those changes.

## Concrete API and lifecycle

Fresh official documentation now establishes durable Agent background jobs:
`POST /v1/agent` with `background:true` immediately returns an ID and status;
`GET /v1/agent/{id}` retrieves that same job. Prefer non-streaming creation and
bounded polling for this first slice. This avoids starting a stream before its
first response ID can be durably published. Streaming/reconnection exists but
is not required for the MVP; do not add a second generation on reconnect.

Source: https://docs.perplexity.ai/docs/agent-api/background-mode

Retrieval requires `store:true` or omission; `store:false` produces a 404 on
retrieve. Therefore do not copy OpenAI's `store:false` request. Require explicit
Perplexity background/storage consent, use `store:true`, and disclose remote
storage without inventing a retention duration or deletion guarantee. The
create documentation also states `store:false` may still support continuation;
it must not be described as an unconditional no-retention switch.

The fetched background/retrieve pages and API index did not establish a precise
retention period or an Agent-response DELETE endpoint. Do not reuse the current
generic "temporarily stored for status" prompt or the Sonar API's separate ZDR
claim. Suggested operation-specific German disclosure: "Perplexity speichert
Auftrag und Antwort für diesen Hintergrundauftrag beim Anbieter. Sarah kann den
Status später abrufen. Eine feste Löschfrist oder Löschung durch Sarah ist für
diese Anbindung derzeit nicht bestätigt." Pin a versioned storage disclosure
to the exact operation/model/task consent; a changed disclosure invalidates the
grant. This wording states a known limitation, not a retention guarantee.

Sources:
https://docs.perplexity.ai/api-reference/agent-get
https://docs.perplexity.ai/api-reference/agent-post

`POST /v1/agent/{id}/cancel` is asynchronous: `200`/`cancelling` acknowledges a
request, not completion. Continue bounded polling until a terminal state.
Only `cancelled` confirms cancellation. Local abort, timeout, shutdown, lost
credentials, or failed polling yields an honest incomplete/uncertain result.
Keep the original credential in the accepted task context for cancellation;
never borrow a replacement account or resubmit the goal after restart.

Source: https://docs.perplexity.ai/api-reference/agent-cancel-post

## Implementation steps

1. Inspect installed SDK types before writing calls. Verify `responses.create`,
   `retrieve`, `cancel`, endpoint paths, request options, retry disabling and
   accepted status union against current official docs. If the pinned SDK lacks
   a documented method, use its documented generic request facility or a small
   validated fixed-origin transport; never invent an SDK method.
2. Add `providers/perplexity` client factory and normalized result/usage helpers.
   Disable automatic retries, bound request duration, redact errors. Validate
   exact IDs/model and prohibit redirects carrying credentials to other origins.
3. Implement `perplexity_agent_research`. Require exact API identity, native
   model, role, goal-only manifest, access-none, current policy, and storage
   consent before dispatch. Request only `web_search`, bounded
   `max_output_tokens`, and `max_steps` (application cap 10). The freshly fetched
   API reference allows up to 100 steps, unlike stale search snippets; retain
   the smaller application limit. Steps are not tool-call counts or spend caps:
   do not label `max_steps` as an exact maximum number of tool invocations.
4. Persist acceptance before polling/result publication; cover immediate
   terminal responses. Map queued/in-progress/cancelling/terminal states
   explicitly. Repeated polls must not exhaust the 256-event replay budget.
   Recover only accepted IDs and original credential generation. Policy revoked
   on recovery means cancel, not retrieve-and-continue. Bound deadline cleanup.
5. Extract text and HTTP(S) source annotations into existing safe result UI.
   Normalize provider-reported usage/cost once per checkpoint; missing usage is
   unavailable, not zero. Never persist prompts, answers or raw provider errors.
6. Register native model, availability and operation-specific consent copy in
   Main/settings. Preserve Anthropic/OpenAI defaults and no cross-billing fallback.

## Health gate implementation decision

`GET /v1/models` is documented as public: it checks reachability/model discovery,
not API-key validity. It must never mark arbitrary credentials healthy.
No free authenticated non-mutating health endpoint has been established.
Do not generate/revoke keys as a probe. Preserve strict healthy-only selection.
Implement an explicitly disclosed, separately confirmed minimal paid verification
request: native model, no tools, fixed nonsensitive input, max 8 output tokens,
max_steps 1, background false and store false. An unchecked renderer checkbox
and clear button copy explain that this can incur API charges, not a fixed cost.
The strict health IPC accepts an optional versioned paid-probe acknowledgement;
Main requires the exact version for Perplexity before calling generation once.
Without it no paid request runs and the key remains unverified. A public model
list alone cannot grant health. Validate the actual native-model response and
record reported usage, including incomplete responses, without prompts/results.
No retries or automatic probes on saving keys, opening settings, or restart.
No paid probe runs during build or tests.

Source: https://docs.perplexity.ai/docs/agent-api/openai-compatibility

## Verification and gates

After Anthropic merges, refresh this plan against actual shared ports and have
one independent subagent review it. Then implement and run fake SDK/HTTP tests
for exact native-only requests, acknowledgement/privacy/policy denial, malformed
response, 401/429, immediate completion, cancellation acknowledgement versus
terminal cancellation, restart, key rotation during acceptance, wrong response
ID/model, deadline, source URL validation and deduplicated usage. Full shared
typecheck/build/tests before PR. One independent implementation audit, fix its
confirmed findings, then merge through dev. Larger cross-provider audit remains
the separate final phase. Live account/model/storage behaviour remains explicitly
unverified without user credentials and authorized budget.

## Independent plan review incorporated

`perplexity_plan_review` required four concrete shared-contract additions:

- Pass `storageDisclosureVersion` through selection, confirmation subject,
  copy/comparison, request and adapter validation. Require current version.
- Pass `maxSteps` as a distinct budget through the same chain, capped at 10 for
  this operation; do not translate the existing `maxToolCalls` silently.
- Strictly parse the complete health input and pass it to the health callback.
  Paid probe consent binds expected credential generation as well as version;
  reject stale/wrong-provider consent before network dispatch.
- Probe deadline below the hub's 10-second deadline, with actual abort and no
  late health publication. Unknown remote outcome explicitly warns of possible
  charges. No automatic repeat. The shared SDK logging and host-auth isolation
  corrections from Anthropic must also apply to the Perplexity client.

All are implementation requirements, not claims of already completed tests.

## Implementation and single audit result

- Native Agent research, stored background lifecycle, one-shot separately
  confirmed paid probe, versioned storage disclosure, exact-generation consent,
  bounded steps, safe sources and optional measured usage are implemented.
- The installed official SDK 0.38.5 exposes the documented create/retrieve/cancel
  methods. Fixed origin, redirect rejection, disabled logging and no retries
  are set explicitly. No legacy Sonar endpoint or foreign-model preset is used.
- `perplexity_independent_audit` completed the one independent implementation
  review. P1 late-policy-revocation publication and P2 missing remote cleanup
  after failed recovery were reproduced and corrected, with deferred-response
  regressions. The shared publication guard and equivalent OpenAI recovery
  boundary were hardened at the same time.
- Pre-fix full suite: 2,300 passing tests, one opt-in skipped. Final post-fix
  full-suite/build evidence is recorded in the PR. No real keys, paid probes,
  provider generations, or remote deletion guarantees were tested live.
- The production dependency audit still reports only the pre-existing
  systeminformation advisory, not the added provider SDK.
