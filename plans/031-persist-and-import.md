# Plan 031: Persist AI walkthroughs + add import_data

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check**: `git diff --stat 7e26e2d..HEAD -- src/stores/favorites.ts src/stores/reader.ts src-tauri/src/export.rs`

## Status

- **Priority**: P3
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: direction
- **Planned at**: commit `7e26e2d`, 2026-08-04

## Why this matters

Two grounded feature gaps surface from the existing architecture:

1. **Persist walkthroughs**: Favorites store only the `Paper` object. The
   reader store persists chat history per paper but wipes the section
   walkthrough and synthesis on `close()`. Reopening a favorited paper
   costs ~10 API calls to re-stream the explanation. The chat
   persistence pattern (`reader.ts:92-103`) is a direct template.

2. **Import data**: `export_data` writes a JSON file with favorites and
   chat, but there is no `import_data` command. Users cannot move their
   library between machines (the app supports Windows + macOS per
   AGENTS.md). This is a surface asymmetry: export without import.

## Current state

- **`src/stores/favorites.ts:1-61`** — persists `byId: Record<string,
Paper>` to `papyrus-favorites` in localStorage.
- **`src/stores/reader.ts:92-103`** — `persistChat(paperId, list)` and
  `loadChat(paperId)` use `papyrus-reader-chat-v1` in localStorage.
- **`src/stores/reader.ts:198-217`** — `close()` resets `sectionEntries`
  and `synthesis` to empty/null. Chat history is persisted but the
  walkthrough is not.
- **`src-tauri/src/export.rs:28-42`** — `export_data` writes the export
  JSON file. No `import_data` exists.
- **`src-tauri/src/lib.rs:12-27`** — the `invoke_handler` list has no
  `import_data` entry.

Conventions: localStorage keys follow `papyrus-*` naming. Frontend
uses Zustand stores. Rust commands are `#[tauri::command]`. The export
payload's `app` field is `"papyrus"`. Keys are in the keychain and
intentionally NOT exported — that's correct, and import must not restore
keys either.

## Commands you will need

| Purpose   | Command                           | Expected on success |
| --------- | --------------------------------- | ------------------- |
| Typecheck | `pnpm run typecheck`              | exit 0              |
| Frontend  | `pnpm test`                       | all pass            |
| Rust      | `cargo test --lib` (in src-tauri) | all pass            |
| Lint      | `pnpm run lint`                   | exit 0              |

## Scope

**In scope**:

- `src/stores/reader.ts`
- `src/stores/favorites.ts` (if walkthrough is stored alongside favorites)
- `src-tauri/src/export.rs`
- `src-tauri/src/lib.rs` (add invoke handler)
- `src/features/settings/settings-page.tsx` (import button UI)
- New test files as needed

**Out of scope**:

- Keychain import — keys stay in the keychain, never in the export file
- The PDF viewer
- The prompts system

## Git workflow

- Branch: `advisor/031-persist-and-import`
- Conventional commits: `feat(reader): ...`, `feat(settings): ...`

## Steps

### Step 1: Persist section walkthroughs and synthesis

Add `papyrus-reader-walkthrough-v1` to localStorage. Mirror the chat
pattern:

- `persistWalkthrough(paperId, sectionEntries, synthesis)` — called
  after each section completes and after synthesis completes.
- `loadWalkthrough(paperId)` — called in `open()` alongside
  `loadChat`.

In `reader.ts`, add `persistWalkthrough` calls:

- After a section's streaming completes, call `persistWalkthrough`.
- After synthesis completes, call `persistWalkthrough`.

In `open()`, call `loadWalkthrough(paperId)` and populate
`sectionEntries` and `synthesis` from it (if present).

Cap at a reasonable size (e.g. last 5 papers, to avoid bloating
localStorage). Use the same serialization approach as chat.

**Verify**: `pnpm run typecheck` → exit 0, `pnpm test` → all pass

### Step 2: Add import_data Rust command

In `src-tauri/src/export.rs`, add:

```rust
#[derive(Deserialize)]
struct ImportPayload {
    app: String,
    // ... same fields as the export payload
}

#[tauri::command]
pub fn import_data(payload: String) -> Result<ImportSummary, String> {
    // Parse JSON, validate app == "papyrus"
    // Return the favorites and chat entries
    // Do NOT restore keys (they're keychain-only)
}
```

Add `export::import_data` to the `invoke_handler` in `lib.rs`.

**Verify**: `cargo test --lib` → all pass

### Step 3: Add import UI in Settings

In `settings-page.tsx`, add an "Import" button (with an `Upload` icon)
next to the existing "Export my data" button. On click, use Tauri's
dialog plugin to open a file picker, read the JSON, invoke
`import_data`, and merge the returned favorites into the store.

Show a confirmation message with the count of imported items.

**Verify**: `pnpm run typecheck` → exit 0, `pnpm test` → all pass

### Step 4: Add i18n keys

Add `importData`, `importedCount`, `importFailed` to both
`en.json` and `ar.json` under the `settings` namespace.

**Verify**: `pnpm test` → all pass

### Step 5: Add tests

- Frontend: test the settings import button flow (mock invoke).
- Frontend: test that `loadWalkthrough` populates the reader state.
- Rust: test that `import_data` rejects a payload with the wrong `app`
  field, and accepts a valid one.

**Verify**: `pnpm test` → all pass, `cargo test --lib` → all pass

## Done criteria

- [ ] `pnpm run typecheck` exits 0
- [ ] `pnpm test` exits 0; new tests exist and pass
- [ ] `cargo test --lib` exits 0
- [ ] `pnpm run lint` exits 0
- [ ] Opening a favorited paper restores the walkthrough without
      re-streaming
- [ ] Import button appears in Settings and works with a real export file
- [ ] No files outside the in-scope list are modified
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report if:

- The export payload structure doesn't match what `import_data` expects
  (read `export.rs` carefully before writing the import).
- Tauri's file dialog plugin isn't available (check `Cargo.toml` for
  `tauri-plugin-dialog` — if missing, add it or use an `<input
type="file">` fallback).
- localStorage quota is too small for 5 papers' walkthroughs (measure
  before committing to the cap).

## Maintenance notes

- The walkthrough persistence cap means old papers' walkthroughs are
  evicted — users may expect them to persist forever. If the cap is
  low, consider persisting only for favorited papers (which guarantees
  the user wants to keep them).
- `import_data` must be kept in sync with `export_data`'s payload
  structure. Any new field added to the export must also be handled by
  the import (either restored or ignored with a warning).
