# Plan 026: Fix rate_limit, loadMore, and reader.stop correctness bugs

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 7e26e2d..HEAD -- src-tauri/src/papers.rs src/stores/papers.ts src/stores/reader.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `7e26e2d`, 2026-08-04

## Why this matters

Three correctness bugs, all with LOW effort to fix but real impact:
(1) The arXiv rate limiter records the timestamp before sleeping, so
concurrent fetches both read the old time and fire simultaneously,
violating the 3-second politeness rule and risking a 429 ban. (2)
`loadMore` doesn't use the `requestSeq` generation guard, so a stale
page-2 from the previous category can clobber a fresh refresh. (3)
`reader.stop()` nulls `activeOperationId` unconditionally, so a new
stream started during the stop's IPC round-trip becomes un-cancellable.

## Current state

- **`src-tauri/src/papers.rs:78-95`** — `rate_limit`:

  ```rust
  async fn rate_limit(source: &str) {
      let interval = source_interval(source);
      let wait_for = {
          let mut last = LAST_REQUESTS
              .get_or_init(|| Mutex::new(std::collections::HashMap::new()))
              .lock()
              .unwrap_or_else(|p| p.into_inner());
          let now = Instant::now();
          let elapsed = last.get(source).map(|t| now.duration_since(*t));
          last.insert(source.to_string(), now);        // <-- inserted BEFORE sleep
          elapsed.map(|e| interval.saturating_sub(e)).unwrap_or_default()
      };
      if !wait_for.is_zero() {
          tokio::time::sleep(wait_for).await;
      }
  }
  ```

- **`src/stores/papers.ts:139-164`** — `loadMore` reads `papers.length`
  as offset and appends with no `requestSeq` check. The `refresh`
  function at lines 98-99 uses `requestSeq` but `loadMore` does not.

- **`src/stores/reader.ts:515-535`** — `stop()`:
  ```typescript
  await stopExplanation(activeOperationId);
  activeOperationId = null; // <-- unconditional null
  ```
  A new `ask`/`explainSection` can set `activeOperationId` between the
  read and the null assignment.

Conventions: Zustand stores use a module-level `requestSeq` counter
(papers.ts). Rust uses `tokio::time::sleep` for async delays. Tests are
in vitest (frontend) and `cargo test --lib` (Rust). Run `pnpm test` and
`cargo test --lib` from the repo root.

## Commands you will need

| Purpose   | Command                           | Expected on success |
| --------- | --------------------------------- | ------------------- |
| Typecheck | `pnpm run typecheck`              | exit 0              |
| Frontend  | `pnpm test`                       | all pass            |
| Rust      | `cargo test --lib` (in src-tauri) | all pass            |
| Lint      | `pnpm run lint`                   | exit 0              |

## Scope

**In scope**:

- `src-tauri/src/papers.rs`
- `src/stores/papers.ts`
- `src/stores/reader.ts`
- `src/stores/__tests__/papers.test.ts` (create if needed)
- `src-tauri/src/papers.rs` (test module, add tests)

**Out of scope**:

- `src/lib/arxiv.ts` — the frontend fetch wrapper, not the limiter
- Any other store or module

## Git workflow

- Branch: `advisor/026-correctness-fixes`
- Commit per step, conventional commits: `fix(papers): ...`
- Do NOT push unless instructed.

## Steps

### Step 1: Fix rate_limit to record timestamp after sleeping

Move `last.insert(source.to_string(), now)` to AFTER the `sleep().await`,
so the next caller sees the sleep-to-completion time and waits the full
interval. The revised structure:

```rust
async fn rate_limit(source: &str) {
    let interval = source_interval(source);
    let wait_for = {
        let mut last = LAST_REQUESTS
            .get_or_init(|| Mutex::new(std::collections::HashMap::new()))
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        let now = Instant::now();
        let elapsed = last.get(source).map(|t| now.duration_since(*t));
        elapsed.map(|e| interval.saturating_sub(e)).unwrap_or_default()
    };
    if !wait_for.is_zero() {
        tokio::time::sleep(wait_for).await;
    }
    LAST_REQUESTS
        .get_or_init(|| Mutex::new(std::collections::HashMap::new()))
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .insert(source.to_string(), Instant::now());
}
```

Add a Rust test: two concurrent calls to `rate_limit("arxiv")` with a
mock clock (or use `Instant` — the second call must wait at least the
configured interval after the first completes).

**Verify**: `cargo test --lib` (in src-tauri) → all pass

### Step 2: Add requestSeq guard to loadMore

In `src/stores/papers.ts`, add at the top of `loadMore`:

```typescript
const seq = ++requestSeq;
```

And before the `set()` at line 156, add:

```typescript
if (seq !== requestSeq) return;
```

This mirrors the guard in `refresh` at lines 98-99 and 127.

Also, ensure `setCategory`, `setQuery`, `setSource`, and `setDate`
(which currently just `set()` state) also bump `requestSeq` so any
in-flight `loadMore` is invalidated.

**Verify**: `pnpm run typecheck` → exit 0, `pnpm test` → all pass

### Step 3: Use compare-and-swap in reader.stop()

In `src/stores/reader.ts`, change the `stop()` function. Capture the id
to stop at the top:

```typescript
const idToStop = activeOperationId;
```

After `await stopExplanation(idToStop)`, only null out `activeOperationId`
if it still matches the captured id:

```typescript
if (activeOperationId === idToStop) {
  activeOperationId = null;
}
```

This ensures that if a new stream started during the IPC round-trip and
set a new `activeOperationId`, the stop does not clobber it.

**Verify**: `pnpm run typecheck` → exit 0, `pnpm test` → all pass

### Step 4: Add tests

Frontend (papers store test if it exists, or create it):

- Test that a stale `loadMore` response does not modify the papers list
  when `refresh` has bumped `requestSeq` in between.

Rust (papers.rs test module):

- Test that `rate_limit` with two concurrent callers enforces the full
  interval between the first and second call's return.

**Verify**: `pnpm test` → all pass, `cargo test --lib` → all pass

## Done criteria

- [ ] `pnpm run typecheck` exits 0
- [ ] `pnpm test` exits 0; new tests exist and pass
- [ ] `cargo test --lib` (in src-tauri) exits 0
- [ ] `pnpm run lint` exits 0
- [ ] No files outside the in-scope list are modified
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report if:

- The code doesn't match the excerpts above.
- `requestSeq` is used differently than expected (e.g. it's not a
  module-level counter).
- The Rust test requires async test infrastructure that isn't already
  in the test module.

## Maintenance notes

- The `requestSeq` bump in `setCategory`/`setQuery` etc. must be kept
  in sync with any new store action that mutates `papers` or `query`.
- The CAS pattern in `stop()` should be applied to any future
  async-stop-and-null pattern in the reader store.
