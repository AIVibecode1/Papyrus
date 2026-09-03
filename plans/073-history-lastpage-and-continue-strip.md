# Plan 073: Wire history lastPage and add Continue-reading strip

> **Executor instructions**: History stays automatic and distinct from favorites. Writes must never block `reader.open`.
>
> **Drift check**: Read `src-tauri/src/history.rs`, `src/stores/history.ts`, `src/stores/reader.ts` open path, PDF viewer position memory.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none
- **Category**: direction | correctness
- **Planned at**: Papyrus snapshot v1.1.8 (2026-08-07)

## Why this matters

Reading history records opens but `lastPage` / `last_page` is almost never populated. The product already remembers scroll/page position for PDFs separately. Connecting them enables a small **Continue reading** strip (last 2–3 papers with page) — high value, low scope.

## Current state

- `history.rs`: `ReadingHistoryEntry` includes `last_page: Option<u32>`; cap 200; upsert by `paper_id`.
- `history.ts`: `recordOpen(paper)` builds entry from paper metadata (no page).
- PDF viewer persists position by paper id (existing feature; find the storage key in `pdf-viewer.tsx` / related).
- Papers toolbar already has History mode.

## Commands

| Purpose | Command | Expected |
|---------|---------|----------|
| Tests | `pnpm test -- src/stores/__tests__/history` | pass |
| Typecheck | `pnpm typecheck` | exit 0 |
| Rust | `cargo test --manifest-path src-tauri/Cargo.toml --lib history::` | pass |

## Scope

**In scope**

- `src/stores/history.ts` (+ tests)
- `src-tauri/src/history.rs` only if IPC payload needs page field on record (already on struct)
- `src/stores/reader.ts` — call record with page when known
- PDF position read helper (reuse existing; do not reimplement storage format)
- `src/features/papers/` — small Continue strip component or section above the list
- `src/i18n/locales/en.json` + `ar.json` — new strings only

**Out of scope**

- Collections/tags
- Changing HISTORY_CAP
- Cloud sync
- Redesign of History mode table

## Git workflow

- Branch: `advisor/073-history-continue`
- Commits:
  1. `feat(history): persist lastPage when recording opens`
  2. `feat(papers): continue-reading strip from history`

## Steps

### Step 1: Populate lastPage on record

- When recording after successful PDF load, read the existing saved page for `paper.id` if any (same source the viewer uses to restore position).
- Pass through to `ReadingHistoryEntry.lastPage` / Rust `last_page`.
- On later page changes, **optional**: debounce update history entry page (nice-to-have). Minimum: set page at open/restore time and on reader close if cheap.

**Verify**: history unit test with mocked page → entry has `lastPage`.

### Step 2: Continue-reading strip UI

- Show up to 3 newest history entries at top of papers feed (not in Saved-only or pure search-empty states if that confuses — prefer: hide when `historyMode` or `savedOnly`, show on main feed).
- Each row: title (truncate), relative last opened, optional `p. N`, click → open reader.
- EN + AR strings; logical CSS; reuse card/button patterns from existing paper UI.

**Verify**: component test with one mock entry invokes open (mock reader store).

### Step 3: i18n

- Keys e.g. `papers.continueReading`, `history.page` — both locales.

**Verify**: keys present in en.json and ar.json.

## Test plan

- recordOpen sets lastPage when provided
- upsert keeps newer lastOpenedAt and updates page
- strip renders empty state as null (no banner)
- Model history tests after `src/stores/__tests__/history.test.ts`

## Done criteria

- [ ] New history entries can carry lastPage from reader position
- [ ] Continue strip shows ≤3 items and opens reader
- [ ] EN + AR strings added
- [ ] Tests + typecheck green
- [ ] Failed history write still does not fail open

## STOP conditions

- Page position storage format is undocumented or split across keys — stop and report location rather than inventing a second position store.
- Reader open path refactored so recordOpen is no longer called — restore call sites first.

## Maintenance notes

- Related: offline library UI can later badge the same strip.
- Reviewers: ensure no favorites auto-add.
