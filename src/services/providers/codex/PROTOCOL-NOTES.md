# Codex App Server 0.153.4 acceptance

Official sources checked 2026-09-05:

- https://learn.chatgpt.com/docs/app-server
- https://learn.chatgpt.com/docs/auth

Native Windows x64 `--help` and `app-server generate-ts` succeeded. An opt-in
native test also initialized the isolated process and obtained `account: null`
without login, credentials, generation, or a paid request. The process used
`cli_auth_credentials_store="keyring"`, not the `auto` plaintext fallback.

Generated `v2/SandboxPolicy.ts` in this pinned version supports:

- `readOnly` with `networkAccess: boolean`
- `workspaceWrite` with writable roots and unrestricted default read scope
- external or unrestricted sandboxes (not permitted here)

Unlike current online documentation, this version does not support restricted
readable roots. A selected workspace plus read-only mode therefore does NOT
establish selected-workspace-only file access. The adapter deliberately reports
`codex_workspace_containment_unverified` until Main supplies independently
verified confinement. Managed account setup remains usable separately.

The generated protocol also confirmed thread/turn start, ephemeral threads,
account device-code authentication, account read, token usage, and turn interrupt
shapes used here. Raw generated files were temporary inspection artifacts and
were removed after inspection. Online docs are not substituted for shipped
binary schema evidence.

No account login, OS-keyring write, generation, or packaged Electron smoke test
has been performed. Those require explicit user credentials/acceptance. Current
coding implementation is read-only and denies approvals; it does not advertise
write, download, interactive approval, or autonomous spending-limit support.
