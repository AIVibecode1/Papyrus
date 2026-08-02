# Plan 015: Bound the explanation store's update rate (chunk coalescing)

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
- **Depends on**: plans/004 (characterization tests — the store's text
  accumulation is asserted there)
- **Category**: perf
- **Planned at**: working tree, 2026-08-02 (repo has no commits yet)

## Why this matters

Every SSE delta triggers a full `byPaper` object rebuild plus a string
concat (`cur.text + chunk`) — O(n²) copies over the lifetime of a stream —
and a re-render of the ExplainPanel per chunk. Fast providers emitting
hundreds of deltas per second make the IPC callback and store updates the
bottleneck. At the current prompt's ~300 words it's negligible; the fix is
cheap and bounds the update rate regardless of provider speed or future
longer outputs.

## Current state

- `src/stores/explanation.ts:44-58` — `onChunk` closure:

```ts
        onChunk: (chunk) =>
          set((s) => {
            const cur = s.byPaper[id] ?? {
              status: "streaming" as const,
              text: "",
              error: null,
              providerId: provider.id,
            };
            return {
              byPaper: {
                ...s.byPaper,
                [id]: { ...cur, status: "streaming", text: cur.text + chunk },
              },
            };
          }),
```

- `ExplainPanel` renders `explanation.text` (`explain-panel.tsx:97-108`).
- Plan 005 introduces per-paper generation counters in the same store —
  this plan must compose with them (chunks from stale generations are
  dropped before coalescing matters).

## Commands you will need

| Purpose   | Command                  | Expected on success |
| --------- | ------------------------ | ------------------- |
| Test      | `pnpm test`              | all pass            |
| Typecheck | `pnpm exec tsc --noEmit` | exit 0              |
| Build     | `pnpm run build`         | exit 0              |

## Scope

**In scope** (the only files you should modify):

- `src/stores/explanation.ts`
- `src/stores/__tests__/explanation.test.ts` (update tests to the coalesced contract)

**Out of scope** (do NOT touch):

- `src/lib/ai.ts` (chunk delivery stays as-is); Rust code.

## Git workflow

Repo has no commits — work directly in the working tree. Do not create
branches or commit unless the operator explicitly instructs it.

## Steps

### Step 1: Coalesce chunk appends

Change the store's `PaperExplanation` accumulation from string-concat-per-
chunk to a chunk buffer flushed on a timer:

- Add to `PaperExplanation` (or the store module): keep `text: string` as
  the _committed_ text, plus a transient buffer. Two acceptable designs —
  pick the simpler one that passes the tests:

  **Design A (array join on flush)**: `onChunk` pushes to a local
  `pending: string[]` and schedules a flush via
  `setTimeout(flush, 50)` (or `requestAnimationFrame` when available);
  the flush does `set((s) => { ... text: cur.text + pending.join(""), status: "streaming" })`
  and clears pending. Guard against flushes after completion/stop with the
  plan-005 generation check. Clear the timeout on done/error/stop.
  - In tests, timers need control: use `vi.useFakeTimers()` and advance
    time, or expose the flush for tests. Prefer fake timers.

  **Design B (array in state, join on render)**: `text` becomes
  `chunks: string[]` in the store; the panel joins. Simpler store, but
  touches `ExplainPanel` rendering and the plan-004 tests' expectations.

- **Chosen default**: Design A with a 50 ms flush timer, because it keeps
  `text` semantics identical for the panel and the tests (tests from plan
  004 assert text content — they pass unchanged except where timers need
  advancing).

- Composes with plan 005: the flush callback captures the generation at
  `start()`; if the generation no longer matches when the timer fires, drop
  the pending buffer without touching state.

**Verify**: `pnpm exec tsc --noEmit` → exit 0.

### Step 2: Update the explanation tests

In `src/stores/__tests__/explanation.test.ts`:

- Tests that assert text after `onChunk` calls must now either
  `vi.useFakeTimers()` + advance 50 ms, or await a flush. Update tests 1-5
  from plan 004 accordingly; add one new test:
  `chunks within the same flush window are batched into one store update` —
  assert the store's `set` was called once for two chunks (spy on the
  store's setter via `useExplanationStore.setState` spy, or count renders
  via a subscriber).
- Keep the plan-005 flipped tests intact (generation guard + stop
  behavior still hold).

**Verify**: `pnpm test` → all pass.

## Test plan

- Update `src/stores/__tests__/explanation.test.ts` for fake timers.
- New test: batching (one state update per flush window).
- Verification: `pnpm test` all pass; `pnpm run build` green.

## Done criteria

- [ ] `pnpm test` exits 0 — all suites, including updated explanation tests
- [ ] `pnpm exec tsc --noEmit` exits 0
- [ ] `pnpm run build` exits 0
- [ ] Store updates are bounded to ~20/s regardless of chunk rate
      (design + test-verified)
- [ ] No files outside the two in-scope files modified
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- Plan 004's tests don't exist yet (run 002 + 004 first).
- Plan 005 hasn't landed and the generation guard can't be composed —
  implement without it and note the interaction in the status row.
- Fake timers fight with other async in the store tests (the mocked
  `streamExplanation` promise) — flush manually via an exported test hook
  instead of timers if needed; report the choice.

## Maintenance notes

- If explanations ever grow unbounded (no word cap), consider a hard
  character ceiling in the same flush path.
- The 50 ms flush window is a UX/perf knob; keep it as a named constant.
- Reviewer: confirm the final chunk flushes on stream end (a flush that
  never fires would truncate the tail of every explanation — the done
  transition must flush pending first).
