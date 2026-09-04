# AI Provider Hub Foundation — Slice 1 Implementation Plan

**Parent plan:** `2026-09-04-ai-specialist-provider-hub.md`
**Branch:** `feat/ai-provider-hub-foundation`
**Scope:** Local provider catalog, isolated credentials, connection metadata,
role bindings, settings IPC, and German settings UI. No provider request and no
specialist activation.

## Outcome

Users can locally configure API-key connections for OpenAI, Anthropic, and
Perplexity, acknowledge the exact cost warnings, and assign inactive standard or
fallback role bindings. Sarah stores each credential in its own encrypted file,
never returns a credential to the renderer, and truthfully reports every saved
key as `credential_saved_unverified` until a later adapter supplies a health
check.

## Hard boundaries

- Do not add an SDK, `fetch`, model request, authentication probe, or charged
  health check.
- Do not modify `LlmProvider`, `ModelRuntime`, router proposals, `IntentPlan`, the
  executor, or the specialist capability snapshot.
- `coding`, `research`, and `vision` remain `unavailable/no_adapter`.
- Do not extend the OAuth provider schema or write API keys to `connections.enc`.
- Allowlisted provider IDs may cross the settings IPC boundary. Credentials,
  credential fragments, SDK objects, prompts, and raw storage errors may not.
- One saved `api_key` connection per provider is the Slice-1 limit.
- Use `provider_default` as the only model profile until an adapter can discover
  and verify provider models.

## Task 1 — Provider-neutral contracts and fixed catalog

Create `src/core/ai-provider-contract.ts` with strict Zod input schemas and
immutable public types for:

- provider IDs: `openai | anthropic | perplexity`;
- auth kind: `api_key`;
- roles: `text | coding | research`;
- fixed operation IDs for the six approved provider/role combinations;
- health states from `not_configured` through `storage_degraded`;
- catalog entries, public connection snapshots, role bindings, hub snapshots,
  safe mutation results, versioned warning acknowledgements, and normalized
  usage records;
- save-key, delete-connection, replace-bindings, and check-health inputs.

Create `src/services/integrations/ai-provider-catalog.ts` with the three fixed
providers, supported roles/operations, warning versions, exact German warning
text, and fixed official HTTPS pricing/spending-help links. The catalog contains
no executable SDK object and no user data.

Tests:

- exact provider/role/operation matrix;
- immutable catalog and unique IDs;
- warning versions and Anthropic-specific warning;
- only allowlisted official HTTPS help links;
- schemas reject extra fields, unsupported combinations, oversized values, and
  malformed IDs.

## Task 2 — Per-connection encrypted credential store

Create `src/services/integrations/ai-credential-store.ts`:

- root: `<userData>/ai-credentials`;
- one `<validated-uuid>.enc` plus `.bak` per connection;
- AES-256-GCM through the existing crypto/`KeyManager` primitives;
- AAD bound to schema version, connection ID, provider ID, and auth kind;
- strict encrypted record containing only version and API key;
- atomic same-directory temp writes, fsync, generation/commit comparison, and
  fail-closed degraded state per connection;
- exact `has`, internal `read`, `write`, `delete`, and `status` operations;
- no directory traversal, symlink target, arbitrary filename, listing through
  IPC, logging, or plaintext fallback.

Extend final-key-loss detection and archival so the fixed `ai-credentials`
directory prevents silent key replacement and is archived safely as one bounded
encryption-state directory. Existing config, database, and OAuth behavior must
remain unchanged.

Tests:

- roundtrip and no plaintext bytes on disk;
- wrong connection/provider/auth AAD fails;
- primary/backup recovery and conflicting commits fail closed;
- one corrupt connection does not degrade another;
- deleting one connection leaves all other credentials and `connections.enc`
  untouched;
- invalid UUID, traversal, symlink, and interrupted-write cases;
- missing master key with AI credentials cannot create a replacement key;
- final-key-loss recovery archives the bounded directory without widening the
  destructive allowlist.

## Task 3 — Non-secret metadata and binding store

Create `src/services/integrations/ai-provider-hub-store.ts` with its own validated,
atomic primary/backup snapshot. It stores no credential:

- schema version, generation, and commit ID;
- connection ID, provider/auth, display label, acknowledgement versions, and
  timestamps;
- binding ID, connection ID, role, operation, `provider_default`, enabled flag,
  deterministic zero-based fallback position, and revision;
- one connection per provider/auth;
- role/operation compatibility with the fixed catalog;
- no dangling connection references, duplicate positions, or revision rollback.

Do not place connection acknowledgements or credentials in generic renderer-
writable `SarahConfig`.

Tests cover strict parsing, recovery/degraded behavior, provider uniqueness,
dangling bindings, incompatible operations, compact deterministic positions,
and optimistic revision conflicts.

## Task 4 — Local hub service

Create `src/services/integrations/ai-provider-hub-service.ts` with injected
catalog, stores, clock, UUID factory, and an empty health-adapter registry.

Operations:

- `snapshot()` derives truthful public state from metadata and per-connection
  credential status;
- `saveApiKey()` validates the exact current general warning version and, for
  Anthropic, the exact provider-warning version before writing;
- `acknowledgeWarnings()` renews those exact warning versions for an existing
  connection without reading, returning, or replacing its credential;
- `deleteConnection()` removes the credential, acknowledgement, metadata, and
  referencing bindings for exactly one connection;
- `replaceBindings()` enforces expected revision and all catalog invariants;
- `checkHealth()` returns `health_adapter_unavailable` without network traffic
  while preserving `credential_saved_unverified`.

Serialize mutations per provider/connection, recheck revisions at publication,
and expose only stable error codes with German safe messages. Roll back a newly
written credential if metadata publication fails. Never include a key or raw
provider/storage error in an output or log.

Tests:

- stale/missing acknowledgements create no credential file;
- Anthropic requires both acknowledgements;
- successful save remains unverified and performs no network call;
- delete removes only the target connection and its bindings;
- concurrent save/delete and stale revision paths fail deterministically;
- test key strings never occur in serialized snapshots, mutation results,
  errors, or captured logs.

## Task 5 — Typed Main/renderer boundary

Create `src/main/ipc-ai-providers.ts` with strict runtime validation for:

- `ai-provider-hub-list`;
- `ai-provider-save-key`;
- `ai-provider-acknowledge-warnings`;
- `ai-provider-delete`;
- `ai-provider-save-bindings`;
- `ai-provider-check-health`.

Every handler returns a safe result and never throws raw internal errors into the
renderer. Add the typed commands to `src/core/ipc-contract.ts`, expose a separate
`SarahAiProviderHubApi` in `src/core/sarah-api.ts`, and add invoke-only wrappers
to `src/preload.ts`. Do not change the existing OAuth `connections` API.

Wire the stores/service and handlers in `src/main.ts` with lifecycle cleanup.
Startup and settings rendering must not trigger a health or provider request.

Tests cover every channel, invalid/extra payloads, key size/control characters,
unknown IDs, sanitized failures, preload/API shape, and the absence of any key in
serialized outputs.

## Task 6 — German settings UI

Add pure UI logic plus DOM rendering for a separate `KI-Anbieter` area inside
Integrationen while preserving Spotify under normal external services.

Each fixed provider card shows:

- provider name and truthful badge;
- password input that is never prefilled and is cleared after every submission;
- the exact general cost warning and acknowledgement checkbox;
- the additional Claude warning and checkbox only for Anthropic;
- official pricing/spending links opened through the existing safe external-URL
  path;
- save and delete actions;
- a disabled or truthful health-check action while no adapter exists.

The role-binding editor exposes one role per row, deterministic standard/fallback
order, only compatible operations, and the fixed `provider_default` profile.
It visibly states that bindings are not active until provider adapters exist.

Use existing settings components, CSS variables, and German UI language. Add
pure view/action tests for badges, acknowledgement gating, warning selection,
binding ordering/revision, deletion, and key-field clearing.

## Execution order and gates

1. Contracts and catalog.
2. Credential store plus key-loss integration.
3. Metadata/binding store.
4. Hub service.
5. IPC, API, preload, and bootstrap.
6. Pure UI logic, DOM UI, and CSS.
7. Focused tests after each block.
8. Main and renderer typechecks.
9. Full suite, build, and `git diff --check` because storage, IPC, preload, and
   main bootstrap are shared boundaries.
10. Restore the Electron SQLite ABI after Node/Vitest tests.

Slice 1 is complete only when users can configure the three local unverified
connections and inactive role bindings without any network request, credential
leak, OAuth regression, or specialist capability activation.
