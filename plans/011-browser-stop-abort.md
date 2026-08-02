# Plan 011: Make the browser-preview Stop button actually stop the stream

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

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: plans/002 (runner), plans/004 (parser tests — update the KNOWN BUG test)
- **Category**: bug (dev-only surface)
- **Planned at**: working tree, 2026-08-02 (repo has no commits yet)

## Why this matters

In the browser preview (no Tauri), `stopExplanation()` is a no-op and the
fetch stream has no AbortController — clicking Stop shows "Stopped." and
then the text keeps streaming and the status flips back to "streaming" (the
plan 004 KNOWN BUG). The preview's whole purpose is exercising the explain
flow, and a lying Stop button undermines that. This aligns the browser path
with the Tauri path (plan 005's typed cancellation).

## Current state

- `src/lib/ai.ts:80-84`:

```ts
export async function stopExplanation(): Promise<void> {
  if (isTauri()) {
    await invoke("stop_explaining");
  }
}
```

- `src/lib/ai.ts:86-134` — `streamExplanationBrowser` uses `fetch(...)`
  with no signal; the loop breaks only on `done`.
- Plan 004 adds `src/lib/__tests__/ai-parser.test.ts` — its stop-related
  expectations (if any) are in the explanation store suite
  (`src/stores/__tests__/explanation.test.ts`), which mocks `@/lib/ai`;
  this plan adds real behavior behind that mock.

## Commands you will need

| Purpose   | Command                  | Expected on success |
| --------- | ------------------------ | ------------------- |
| Test      | `pnpm test`              | all pass            |
| Typecheck | `pnpm exec tsc --noEmit` | exit 0              |
| Build     | `pnpm run build`         | exit 0              |

## Scope

**In scope** (the only files you should modify):

- `src/lib/ai.ts`
- `src/stores/explanation.ts` (only if needed to wire the abort — see steps)
- `src/lib/__tests__/ai-parser.test.ts` (extend, if plan 004 landed)

**Out of scope** (do NOT touch):

- Rust code; `stop_explaining` command semantics.

## Git workflow

Repo has no commits — work directly in the working tree. Do not create
branches or commit unless the operator explicitly instructs it.

## Steps

### Step 1: Add an AbortController registry for browser streams

In `src/lib/ai.ts`:

- Module-level `let activeController: AbortController | null = null;`
- In `streamExplanationBrowser`: create
  `const controller = new AbortController();` set `activeController =
controller`, pass `signal: controller.signal` to `fetch`, and clear
  `activeController` when the stream finishes (in a `finally`-equivalent —
  after the read loop and in a catch wrapper).
- Change `stopExplanation()`:

```ts
export async function stopExplanation(): Promise<void> {
  if (isTauri()) {
    await invoke("stop_explaining");
    return;
  }
  activeController?.abort();
}
```

- When `fetch` aborts, it rejects with an `AbortError` (DOMException named
  `AbortError`). The store (plan 005) matches the typed cancellation marker
  — the browser path has no marker. To keep one contract, in the browser
  catch inside `streamExplanationBrowser`, convert abort errors to the
  shared marker:

```ts
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        throw new Error(CANCELLED_MARKER);
      }
      throw err;
    }
```

(`CANCELLED_MARKER` is defined in this file by plan 005.)

**Verify**: `pnpm exec tsc --noEmit` → exit 0.

### Step 2: Tests

- Extend `src/stores/__tests__/explanation.test.ts` is NOT needed for the
  abort mechanics (the store mocks `@/lib/ai`) — but the plan 004 KNOWN
  BUG test "chunk after stop is ignored" is fixed by plan 005's generation
  counters, and this plan makes the browser stop REAL so the mock-based
  test's `stopExplanation` (a `vi.fn()`) still represents reality.
- Add to `src/lib/__tests__/ai-parser.test.ts` (or a new
  `ai-stop.test.ts`): `stop aborts the in-flight browser stream` — stub
  `fetch` to return a body stream that never ends (or ends after a long
  delay) and whose reader rejects with `AbortError` when the signal
  aborts; call `streamExplanation(...)` (isTauri false), then
  `stopExplanation()`, and assert the promise rejects with an error whose
  message equals `CANCELLED_MARKER`.
- If `DOMException` is unavailable in the node test environment, polyfill
  it in the test (`globalThis.DOMException ??= class extends Error { name = "AbortError" }`)
  or detect abort via `signal.aborted` in the mock reader — choose the
  simplest that keeps the app code clean.

**Verify**: `pnpm test` → all pass.

## Test plan

- New test: browser stop aborts and surfaces the cancellation marker.
- Pattern: plan 004's `ai-parser.test.ts` (stubbed fetch + ReadableStream).
- Verification: `pnpm test` all pass; `pnpm run build` green.

## Done criteria

- [ ] `pnpm test` exits 0 (including the new stop test)
- [ ] `pnpm exec tsc --noEmit` exits 0
- [ ] `pnpm run build` exits 0
- [ ] `stopExplanation` aborts the active browser stream (code inspection + test)
- [ ] No files outside the in-scope list modified
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- Plan 005 hasn't landed and `CANCELLED_MARKER` doesn't exist in `ai.ts` —
  run plan 005 first (or define the marker here and note the duplication;
  prefer running 005 first).
- The abort rejection isn't an `AbortError` in the test environment and the
  detection approach requires app-code changes beyond the sketch.

## Maintenance notes

- The `activeController` registry assumes one active stream (matches the
  MVP single-stream design; plan 005's per-paper generations extend the
  store side).
- When plan 016 (dedup) unifies the parsers, the abort contract (signal →
  marker) is part of the shared contract.
