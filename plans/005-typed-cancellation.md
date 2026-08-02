# Plan 005: Typed cancellation — fix the stop race and the "Stopped" substring contract

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: the repo has **no git commits yet**. Compare
> the "Current state" excerpts against the live files; on any mismatch,
> treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW-MED (touches the cancel primitive; tests cover it)
- **Depends on**: plans/002 (runner) — updates tests from plan 004
- **Category**: bug
- **Planned at**: working tree, 2026-08-02 (repo has no commits yet)

## Why this matters

Two defects in the cancel/stop flow:

1. **Reset race**: `explain_paper` resets the global `CANCEL_EXPLAIN` flag at
   start (`ai.rs:218`). If the user clicks Stop in the narrow window between
   the frontend dispatching `explain_paper` and the async command's body
   running, `stop_explaining` sets the flag first and the reset wipes it —
   the explanation runs anyway while the UI already says "Stopped".
2. **Fragile string contract**: `explanation.ts:68` classifies an error as a
   user stop via `message.includes("Stopped")` matching Rust's
   `"Stopped by the user"` (`ai.rs:148,157`). A provider error that happens
   to contain "Stopped" (e.g. "stream stopped unexpectedly") is mislabeled
   as a user-initiated stop.

## Current state

- `src-tauri/src/ai.rs`:

```rust
static CANCEL_EXPLAIN: AtomicBool = AtomicBool::new(false);   // line 15

#[tauri::command]
pub async fn explain_paper(...) -> Result<(), String> {
    validate_provider(&provider)?;
    CANCEL_EXPLAIN.store(false, Ordering::SeqCst);            // line 218 — the reset
    ...
    stream_chat(...).await.map(|_| ())                        // Err paths return "Stopped by the user"
}

#[tauri::command]
pub fn stop_explaining() {
    CANCEL_EXPLAIN.store(true, Ordering::SeqCst);             // lines 268-270
}
```

- `src/stores/explanation.ts:66-75` (catch block):

```ts
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const status: ExplainStatus = message.includes("Stopped") ? "stopped" : "error";
```

- Repo conventions: strict TS; Rust error strings as `String`; tests in-file
  for Rust, `src/**/__tests__` for TS.

## Commands you will need

| Purpose   | Command                              | Expected on success |
|-----------|--------------------------------------|---------------------|
| Rust test | `cd src-tauri && cargo test --lib`   | all pass            |
| TS test   | `pnpm test`                          | all pass            |
| Typecheck | `pnpm exec tsc --noEmit`             | exit 0              |
| Rust check| `cd src-tauri && cargo check`        | Finished, no warnings |

## Scope

**In scope** (the only files you should modify):
- `src-tauri/src/ai.rs`
- `src/stores/explanation.ts`
- `src/stores/__tests__/explanation.test.ts` (update the KNOWN BUG tests from plan 004)

**Out of scope** (do NOT touch):
- `src/lib/ai.ts` — browser-side stop is plan 011's scope.
- `src-tauri/src/papers.rs`, any other file.

## Git workflow

Repo has no commits — work directly in the working tree. Do not create
branches or commit unless the operator explicitly instructs it.

## Steps

### Step 1: Typed cancellation marker in Rust

In `src-tauri/src/ai.rs`:

- Replace the human string `"Stopped by the user"` (both occurrences,
  lines 148 and 157) with a machine-recognizable constant, e.g.:

```rust
pub const CANCELLED_MARKER: &str = "\u{1F6D1}PAPYRUS_CANCELLED"; // 🛑 prefix; collision-proof
```

- Add a unit test `cancel_returns_marker`: using the existing mock server,
  start a `stream_chat` whose mock stream emits one chunk then sleeps long;
  set `CANCEL_EXPLAIN` to true before the next chunk would arrive, and
  assert the returned `Err` message equals `CANCELLED_MARKER`. Reset the
  flag in the test's cleanup.
- Keep the flag semantics otherwise unchanged (the reset-at-start stays for
  now — step 3 addresses the race on the frontend side where it's cheaper).

**Verify**: `cd src-tauri && cargo test --lib` → all pass.

### Step 2: Frontend matches on the marker, not the word

In `src/stores/explanation.ts` catch block, replace:

```ts
      const status: ExplainStatus = message.includes("Stopped") ? "stopped" : "error";
```

with an exact-marker check. Export the marker from a shared place — since
`src/lib/ai.ts` already mirrors Rust constants, add there:

```ts
export const CANCELLED_MARKER = "\u{1F6D1}PAPYRUS_CANCELLED";
```

and in the store: `const status: ExplainStatus = message.startsWith(CANCELLED_MARKER) ? "stopped" : "error";`

Also normalize the displayed text: when stopped, the UI shows the raw
marker as the error message today (`explanation.ts:72` stores `error:
message`). Change it so that when `status === "stopped"`, `error` is set to
`null` (the panel shows the i18n "Stopped." text anyway).

**Verify**: `pnpm exec tsc --noEmit` → exit 0.

### Step 3: Close the reset race from the frontend

The remaining race (Stop arriving before the command body runs) is closed
by making the store ignore chunks that arrive after a stop:

- In `src/stores/explanation.ts`, add a per-paper generation counter in the
  store state (or module-level `Map<string, number>`): `start()` bumps it
  for that paper id and captures the generation; the `onChunk` closure
  ignores chunks whose generation no longer matches.
- `stop()` bumps the generation for the active paper **before** calling
  `stopExplanation()` — so any chunk already in flight from the old
  generation is dropped, and the status stays `"stopped"` (this also fixes
  the stop-status flip defect from plan 004's KNOWN BUG test).
- The existing tests in `src/stores/__tests__/explanation.test.ts` that
  assert the buggy behavior (tests 3 and 5 from plan 004) must be flipped
  to assert the NEW behavior:
  - chunk after stop is ignored (text unchanged, status stays "stopped")
  - an error `"stream stopped unexpectedly"` (contains the word but not the
    marker) → status `"error"`, not `"stopped"`
  - a rejection with the exact marker → status `"stopped"`, error `null`.

**Verify**: `pnpm test` → all suites pass, including the flipped tests.

## Test plan

- Rust: `cancel_returns_marker` (new, in `ai.rs` tests).
- TS: update `src/stores/__tests__/explanation.test.ts` (flip KNOWN BUG
  tests; add marker-exactness test). Pattern: plan 004's suite.
- Verification: `cargo test --lib` and `pnpm test` both fully green.

## Done criteria

- [ ] `cd src-tauri && cargo test --lib` — all pass
- [ ] `pnpm test` — all pass, including flipped stop tests
- [ ] `pnpm exec tsc --noEmit` exits 0
- [ ] `grep -rn "includes(\"Stopped\")" src/` → no matches
- [ ] `grep -rn "Stopped by the user" src-tauri/src/` → no matches
- [ ] No files outside the three in-scope files modified
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- Plan 004's characterization tests don't exist yet (run plan 002 and 004
  first — this plan's flipped tests depend on them).
- The cancel-flag test is flaky (timing): report and propose a
  deterministic approach (e.g. mock stream that blocks on a channel) rather
  than relaxing the assertion.
- Any other consumer of the `"Stopped"` string is found beyond the two
  listed files.

## Maintenance notes

- The marker string is part of a cross-language contract (Rust emits, TS
  matches). Plan 016 (dedup) should move it into the shared prompt/config
  resource.
- If a future plan makes explanations truly concurrent (multiple papers
  streaming at once), the single global flag must become per-run — the
  generation counters introduced here are the natural foundation.
- Reviewer: confirm no UI path shows the raw marker to the user.
