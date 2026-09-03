# Plan 072: Cap import payload size and deepen schema validation

> **Executor instructions**: Import must remain data-only (never eval). Keys must never appear in export/import.
>
> **Drift check**: Read `src-tauri/src/export.rs` `import_data` / `export_data` and `src/lib/export.ts` merge helpers.

## Status

- **Priority**: P0
- **Effort**: M
- **Risk**: LOW–MED
- **Depends on**: none
- **Category**: security | correctness
- **Planned at**: Papyrus snapshot v1.1.8 (2026-08-07)

## Why this matters

`import_data` parses an arbitrary-length `String` as JSON and only checks `app == "papyrus"`, then returns counts. The frontend merges favorites/notes/history/chat. A multi-hundred-MB paste can freeze the UI or spike memory. Malformed objects can partially merge.

## Current state

```rust
// src-tauri/src/export.rs — import_data
let value: serde_json::Value =
    serde_json::from_str(&payload).map_err(|e| format!("Invalid import payload: {e}"))?;
if value.get("app").and_then(|v| v.as_str()) != Some("papyrus") {
    return Err("Not a Papyrus export file".into());
}
// counts only — no byte cap, no per-field schema
```

Frontend: `src/lib/export.ts` builds export and applies import merges (favorites, chat, notes, readingHistory).

Notes already enforce size caps in `notes.rs` (`MAX_NOTE_BYTES`, `MAX_FILE_BYTES`). History has `HISTORY_CAP = 200`.

## Commands

| Purpose | Command | Expected |
|---------|---------|----------|
| Rust tests | `cargo test --manifest-path src-tauri/Cargo.toml --lib export::` | pass |
| TS tests | `pnpm test -- src/lib/__tests__/export.test.ts` | pass |
| Typecheck | `pnpm typecheck` | exit 0 |

## Scope

**In scope**

- `src-tauri/src/export.rs`
- `src/lib/export.ts`
- `src/lib/__tests__/export.test.ts`
- Rust unit tests inside `export.rs` `#[cfg(test)]`

**Out of scope**

- Changing export file location
- Importing API keys (must remain impossible)
- UI redesign of settings import button

## Git workflow

- Branch: `advisor/072-import-hardening`
- Commits:
  1. `fix(import): reject oversize export payloads`
  2. `fix(import): validate favorites/notes/history shapes before merge`

## Steps

### Step 1: Byte cap in Rust before / during parse

- Define e.g. `const MAX_IMPORT_BYTES: usize = 5 * 1024 * 1024;` (5 MiB — tune if tests need more; document the constant).
- If `payload.len() > MAX_IMPORT_BYTES`, return a clear error string (user-facing, no panic).
- Keep JSON-validity check and `app: "papyrus"` check.

**Verify**: unit test oversize payload fails; valid small payload succeeds.

### Step 2: Structural validation (Rust and/or TS)

Minimum:

- `favorites`: array; each element object with string `id` (and other fields required by `Paper` type — match `src/lib/types.ts`).
- `notes`: array; respect id/paperId length expectations consistent with `notes.rs`.
- `readingHistory`: array; require `paperId`, `title`, `lastOpenedAt` strings.
- `chat`: object map of arrays of `{ role, content }` strings; cap roles to `user`|`assistant` if that matches export format.

Prefer validating in **TS before merge** (where types live) **and** rejecting clearly invalid top-level types in Rust so IPC fails fast.

On invalid item: **skip item** or **fail entire import** — pick **fail entire import** for simpler reasoning unless existing UX promises partial import (then skip + count skipped; document).

**Verify**: tests for wrong `app`, non-array favorites, oversize body, happy path counts.

### Step 3: Frontend surfaces the error

- Ensure settings/import UI shows the Rust/TS error string (no silent no-op).
- Do not log payload contents.

**Verify**: existing settings tests still pass; add assertion if import error path exists.

## Test plan

- Oversize string → error
- `{"app":"other"}` → error
- Valid minimal export → summary counts match
- favorites entry missing `id` → reject or skip per chosen policy (assert explicitly)
- Model after existing `export.rs` tests and `src/lib/__tests__/export.test.ts`

## Done criteria

- [ ] Payload above cap fails closed
- [ ] Malformed core sections cannot fully apply as trusted data
- [ ] `cargo test` export module + `pnpm test` export tests pass
- [ ] No API key fields introduced into export schema

## STOP conditions

- Export format versioning conflict with older user backups — add a note and support previous shape if field names differ (`chat` vs nested); do not break known good exports without a migration note in the PR.
- UI has no error channel for import — report; minimal fix is in-scope only if a single existing toast/error state exists.

## Maintenance notes

- If notes/history caps change, keep import validation limits ≥ those caps or truncate with explicit user messaging.
- Reviewers: confirm secrets never round-trip through export JSON.
