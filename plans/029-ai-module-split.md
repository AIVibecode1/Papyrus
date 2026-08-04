# Plan 029: Split ai.rs god module into submodules

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check**: `git diff --stat 7e26e2d..HEAD -- src-tauri/src/ai.rs src-tauri/src/lib.rs`

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW
- **Depends on**: 027 (security fixes touch ai.rs first)
- **Category**: tech-debt
- **Planned at**: commit `7e26e2d`, 2026-08-04

## Why this matters

`ai.rs` is 1798 lines mixing keychain, SSE parsing, prompt building, the
operation registry, and command wrappers. Any change to prompts or
streaming forces editing the same massive file with high merge-conflict
risk. The concerns have different churn rates (prompts change often,
keychain rarely). Splitting into submodules is a pure mechanical refactor
with no behavior change, covered by the existing 84-test suite.

## Current state

`src-tauri/src/ai.rs` (1798 lines) contains:

- `OPERATIONS` registry + register/cancel/unregister (lines 19-55)
- `PROMPTS` loader + `system_prompt`/`cancelled_marker` (61-92)
- `ProviderConfig` + `build_chat_url` + `is_loopback_host` (94-165)
- Keychain: `get_key`/`set_key`/`delete_key`/`load_key` (167-207)
- SSE parser `stream_chat` (221-340)
- `redact_tokens`/`truncate`/`validate_provider` (342-398)
- `explain_paper`/`explain_with_failover` (400-499)
- `test_provider` (502-528), `stop_explaining` (533-536)
- Prompt builders: `build_section_messages`/`build_synthesis_messages`/`build_qa_messages` (538-673)
- Streaming commands: `stream_messages`/`explain_section`/`explain_synthesis`/`ask_about_paper` (677-782)
- Keychain commands (784-806)
- Test module ~990 lines (808-1798)

Conventions: modules are declared in `lib.rs` with `mod ai;`. The
`invoke_handler` in `lib.rs:11-26` references `ai::explain_paper` etc.
Commands are `#[tauri::command]` functions. `cargo fmt` and
`cargo clippy -- -D warnings` must pass.

## Commands you will need

| Purpose   | Command                           | Expected on success |
| --------- | --------------------------------- | ------------------- |
| Rust      | `cargo test --lib` (in src-tauri) | 86+ pass            |
| Clippy    | `cargo clippy -- -D warnings`     | no warnings         |
| Fmt       | `cargo fmt -- --check`            | clean               |
| Frontend  | `pnpm test`                       | all pass            |
| Typecheck | `pnpm run typecheck`              | exit 0              |

## Scope

**In scope**:

- `src-tauri/src/ai.rs` → becomes `src-tauri/src/ai/mod.rs`
- New files: `src-tauri/src/ai/registry.rs`, `ai/keychain.rs`,
  `ai/stream.rs`, `ai/prompts.rs`, `ai/commands.rs`
- `src-tauri/src/lib.rs` (update `mod ai;` — stays the same)

**Out of scope**:

- Any behavior change — touch a function's logic and STOP
- `src-tauri/src/papers.rs`, `citations.rs`, `pdf.rs`
- Any frontend file

## Git workflow

- Branch: `advisor/029-ai-module-split`
- Conventional commits: `refactor(ai): split ai.rs into submodules`
- Commit per sub-step so the history is reviewable

## Steps

### Step 1: Create the ai/ directory and move submodules

Create `src-tauri/src/ai/` directory. Create the following files with
their content extracted verbatim from `ai.rs`:

1. `ai/registry.rs` — `OPERATIONS` lazy_static, `OperationRegistry`,
   `register_operation`, `cancel_operation`, `unregister_operation`.
   Imports needed: `tokio::sync::Mutex`, `std::collections::HashMap`,
   `uuid::Uuid`.

2. `ai/keychain.rs` — `get_key`, `set_key`, `delete_key`, `load_key`,
   `is_loopback_host`, `base_url_host` (from plan 027). Import
   `keyring` crate.

3. `ai/stream.rs` — `stream_chat`, `redact_tokens`, `truncate`,
   `explain_with_failover`, `validate_provider`. Import `reqwest`.

4. `ai/prompts.rs` — `PROMPTS` loader, `system_prompt`,
   `cancelled_marker`, `build_section_messages`, `build_synthesis_messages`,
   `build_qa_messages`, `build_messages`. Import `serde_json`.

5. `ai/commands.rs` — all `#[tauri::command]` wrappers:
   `explain_paper`, `test_provider`, `stop_explaining`,
   `explain_section`, `explain_synthesis`, `ask_about_paper`,
   `save_api_key`, `delete_api_key`, `has_api_key`. These call into the
   other submodules. Import `tauri::AppHandle`, etc.

6. `ai/mod.rs` — re-exports the public API: `pub use registry::*;`
   `pub use keychain::*;` `pub use stream::*;` `pub use prompts::*;`
   `pub use commands::*;`

Create `src-tauri/src/ai.rs` as: delete it (or make it a one-liner that
re-exports the module — but the clean path is to rename to `ai/mod.rs`).

**Verify**: `cargo check` (in src-tauri) → compiles, no errors

### Step 2: Move the test module

Split the 990-line test module into the corresponding submodule files
(`ai/registry.rs` gets the registry tests, `ai/stream.rs` gets the
stream/failover/redaction tests, `ai/prompts.rs` gets the prompt tests,
`ai/keychain.rs` gets the keychain test). Each test module becomes
`#[cfg(test)] mod tests { ... }` at the bottom of its file.

**Verify**: `cargo test --lib` → all tests pass

### Step 3: Update lib.rs imports

`lib.rs` should already have `mod ai;` which now resolves to
`ai/mod.rs` automatically. Verify the `invoke_handler` still references
`ai::explain_paper` etc. — these now resolve through the re-exports.

**Verify**: `cargo test --lib` → all pass, `cargo clippy -- -D warnings` → clean

### Step 4: Run frontend gates

The frontend doesn't import `ai.rs` directly, so no TS changes. But the
contract tests (`ai-contract.test.ts`) validate that prompts.json
matches — ensure those still pass.

**Verify**: `pnpm test` → all pass, `pnpm run typecheck` → exit 0

## Done criteria

- [ ] `cargo test --lib` exits 0 (all tests pass)
- [ ] `cargo clippy -- -D warnings` exits 0
- [ ] `cargo fmt -- --check` passes
- [ ] `pnpm test` exits 0
- [ ] `pnpm run typecheck` exits 0
- [ ] `ai.rs` no longer exists as a single file (it's `ai/mod.rs` + submodules)
- [ ] No behavior change — a `git diff` of the compiled logic should be
      empty (all moves, no edits)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report if:

- The split requires changing any function's logic (this must be a pure
  move — if imports break, fix the imports, not the function bodies).
- `keyring` or `reqwest` types don't import cleanly across module
  boundaries (unlikely, but STOP and report the specific error).
- The `#[tauri::command]` attribute doesn't work from a submodule (it
  should — Tauri 2 supports commands in any module path).

## Maintenance notes

- Future prompt changes should now only touch `ai/prompts.rs`.
- Future streaming changes should only touch `ai/stream.rs`.
- The keychain test (`#[ignore] keychain_roundtrip`) stays in
  `ai/keychain.rs` and should be run in CI per DEP-01.
