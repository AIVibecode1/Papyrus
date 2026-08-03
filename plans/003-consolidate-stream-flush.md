# Plan 003: Consolidate the four streaming flush implementations

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 692c0d0..HEAD -- src/stores`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none (but land AFTER plan 002's reader tests, which pin
  the current behavior — see Maintenance notes)
- **Category**: tech-debt
- **Planned at**: commit `692c0d0`, 2026-08-03

## Why this matters

The streaming flush pattern (buffer chunks, flush on a 50 ms timer, apply
on completion, guard against stale generations) is implemented four times:
three near-identical copies in `src/stores/reader.ts` (section walkthrough,
synthesis, chat) and a fourth, behaviorally DIFFERENT variant in
`src/stores/explanation.ts`. The divergence already caused a real bug: the
reader copies guard `status !== "loading" && status !== "streaming"` (the
multi-flush fix), while explanation.ts applies its buffer unconditionally
when the generation matches. A bug fix in one copy does not propagate to
the others — the reader's freeze bug was fixed in reader.ts while
explanation.ts kept its older shape. One shared helper makes the behavior
contract single-source.

## Current state

- `src/stores/reader.ts:177-199` — section flush (excerpt):
  ```ts
  let pending: string[] = [];
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  const clearTimer = () => {
    if (flushTimer !== null) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
  };
  const flush = () => {
    flushTimer = null;
    const buf = pending;
    pending = [];
    if (buf.length === 0) return;
    set((s) => {
      const entry = s.sectionEntries[i];
      if (!entry || (entry.status !== "loading" && entry.status !== "streaming")) return s;
      const entries = [...s.sectionEntries];
      entries[i] = { ...entry, text: entry.text + buf.join(""), status: "streaming" };
      return { sectionEntries: entries };
    });
  };
  ```
  The same shape (with `synthesis` and `chat` targets) repeats at
  `reader.ts:249-285` and `reader.ts:338-370`.
- `src/stores/explanation.ts:51-60` — the 4th variant: same timer/pending
  mechanics but the apply step checks only the generation:
  ```ts
  const flush = () => {
    flushTimer = null;
    const buf = pending;
    pending = [];
    if (buf.length === 0) return;
    set((s) => {
      if (s.generations[id] !== gen) return s;
      ...applies text unconditionally...
    });
  };
  ```
- Both stores use `FLUSH_INTERVAL_MS` (50) and the same chunk-callback
  pattern: `onChunk: (chunk) => { if (gen mismatch) return; pending.push(chunk); if (flushTimer === null) flushTimer = setTimeout(flush, FLUSH_INTERVAL_MS); }`.

Repo conventions: Zustand stores with module-level generation counters;
pure helpers live in `src/lib/` with unit tests in `src/lib/__tests__/`;
the existing multi-flush regression test is `src/stores/__tests__/reader.test.ts`
("keeps appending chunks across multiple flushes") — it streams chunks with
setTimeout delays so several flushes fire.

## Commands you will need

| Purpose   | Command                        | Expected on success |
| --------- | ------------------------------ | ------------------- |
| Tests     | `pnpm exec vitest run`         | all pass            |
| Typecheck | `pnpm exec tsc --noEmit`       | exit 0              |
| Lint      | `pnpm exec eslint .`           | exit 0              |
| Format    | `pnpm exec prettier --check .` | all files match     |

## Scope

**In scope**:

- `src/lib/stream.ts` (create — the shared helper)
- `src/lib/__tests__/stream.test.ts` (create)
- `src/stores/reader.ts` (replace the three inline blocks with helper calls)
- `src/stores/explanation.ts` (replace the inline block with a helper call —
  CAREFUL: see Step 3)
- `plans/README.md` (status row)

**Out of scope**:

- Changing the streaming behavior or the flush interval.
- `src/lib/reader-ai.ts` / `src/lib/ai.ts` — the network layer stays as is.
- Any store state shape changes.

## Git workflow

- Branch: `advisor/003-consolidate-stream-flush`
- Commit style: `refactor: share one streaming flush helper across stores`
- Do NOT push unless the operator instructed it.

## Steps

### Step 1: Write the shared helper

Create `src/lib/stream.ts` exporting a factory:

```ts
export interface StreamBufferOptions<TState> {
  /** Applies buffered text to the store; return the next state or the
      unchanged state when the entry is gone/terminal. */
  apply: (state: TState, text: string) => TState;
  /** True while the stream is still current (generation match). */
  isCurrent: () => boolean;
  intervalMs?: number;
}

export interface StreamBuffer {
  push: (chunk: string) => void;
  flushNow: () => void;
  dispose: () => void;
}

export function createStreamBuffer<TState>(
  set: (fn: (s: TState) => TState) => void,
  opts: StreamBufferOptions<TState>,
): StreamBuffer;
```

Semantics (MUST match the current behavior exactly):

- `push(chunk)`: if `!isCurrent()` drop the chunk; otherwise append to the
  pending buffer and arm the flush timer if not armed.
- `flushNow()`: clear the timer, take the buffer, and if non-empty call
  `set(apply(state, text))` — the caller's `apply` is responsible for the
  status-guard semantics (loading/streaming in reader, generation in
  explanation), because the stores' state shapes differ.
- `dispose()`: clear a pending timer.
- `intervalMs` defaults to 50.

**Verify**: `pnpm exec tsc --noEmit` → exit 0.

### Step 2: Unit-test the helper

Create `src/lib/__tests__/stream.test.ts`:

1. Buffers chunks and applies them as one flush after `intervalMs`
   (fake timers).
2. Multiple flushes keep appending (the multi-flush regression, moved to
   the helper level).
3. Chunks arriving after `isCurrent()` flips false are dropped.
4. `flushNow` applies immediately and clears the pending timer.
5. `dispose` cancels a pending flush (advance timers → nothing applied).
6. Empty buffer → `apply` never called.

**Verify**: `pnpm exec vitest run src/lib/__tests__/stream.test.ts` → all pass.

### Step 3: Rewire reader.ts (mechanical)

In `src/stores/reader.ts`, replace each of the three inline
`pending`/`flushTimer`/`clearTimer`/`flush` blocks with:

```ts
const buffer = createStreamBuffer<ReaderState>(set, {
  isCurrent: () => wtGen === gen, // or chatGen/synthesis gen per site
  apply: (s, text) => {
    const entry = s.sectionEntries[i]; // or synthesis/chat per site
    if (!entry || (entry.status !== "loading" && entry.status !== "streaming")) return s;
    // ...existing per-site immutable update with text appended...
  },
});
```

The `onChunk` callback becomes `buffer.push(chunk)`; the completion path
calls `buffer.flushNow()` instead of `clearTimer(); flush();`; the `stop()`
path and error path call `buffer.dispose()`. Do NOT change the apply
bodies — copy them verbatim into the closure.

**Verify**: `pnpm exec vitest run src/stores/__tests__/reader.test.ts` → all 13 pass (unchanged semantics).

### Step 4: Rewire explanation.ts (behavior-preserving)

In `src/stores/explanation.ts`, replace the inline block with the same
factory call, keeping the generation check semantics exactly as they are
today (`s.generations[id] !== gen` guard inside `apply`). The apply body is
copied verbatim. The DIFFERENT guard shapes between the two stores are
intentional and must be preserved — do not "unify" the guards.

**Verify**: `pnpm exec vitest run src/stores/__tests__/explanation.test.ts` → all pass.

### Step 5: Full suite

**Verify**:

1. `pnpm exec vitest run` → all pass (94 + 6 new helper tests)
2. `pnpm exec tsc --noEmit`, `pnpm exec eslint .`, `pnpm exec prettier --check .` → clean

## Test plan

- New: `src/lib/__tests__/stream.test.ts` (6 cases above).
- Existing: reader + explanation store suites are the regression net —
  especially "keeps appending chunks across multiple flushes" (reader.test.ts)
  and the stop/restart generation tests in both stores.
- If any existing test fails after rewiring, STOP (see below) — semantics
  must be identical.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `grep -c "const flush = " src/stores/reader.ts src/stores/explanation.ts` → 0 matches
- [ ] `grep -rn "createStreamBuffer" src/stores/` → 4 usages (3 reader + 1 explanation)
- [ ] `pnpm exec vitest run` → all pass
- [ ] `pnpm exec tsc --noEmit` and `pnpm exec eslint .` exit 0
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- Any store test fails after rewiring (the refactor must be behavior-identical;
  a failing test means a semantic change slipped in).
- The apply bodies in the live files differ from the excerpts above (drift).
- `set` in the stores is not directly callable in the closure scope (if the
  store's `set` needs threading through, adjust the factory signature —
  that is an allowed design detail, but keep the public semantics).

## Maintenance notes

- The helper is the single place future flush-behavior changes land. When a
  new streaming surface is added (e.g. failover progress events), reuse it.
- Land this AFTER plan 002: component tests pin the UI behavior; store tests
  already pin the flush behavior, but the extra net reduces review risk.
- Reviewer focus: the two stores' guards must remain different (reader
  guards on entry status, explanation on generation) — sameness here would
  be a behavior change, not a cleanup.
