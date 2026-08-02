# Plan 004: Characterization tests for stores and the browser SSE parser

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
- **Effort**: M
- **Risk**: LOW
- **Depends on**: plans/002 (test runner)
- **Category**: tests
- **Planned at**: working tree, 2026-08-02 (repo has no commits yet)

## Why this matters

The explanation store's streaming state machine, the settings store's key
lifecycle, and the browser SSE parser contain at least three known defects
(stop-status flip after Stop, browser Stop no-op, unguarded chunk appends).
Plans 005, 011, 015, 016 and 017 will change this code. Before any of those
land, this plan pins current behavior with characterization tests so the
refactors have a regression net — and the tests double as a spec of the
desired behavior where noted.

## Current state

- `src/stores/explanation.ts` (91 lines) — `start()` appends chunks via
  `onChunk` and unconditionally sets `status: "streaming"` at line 55; the
  catch classifies stops via `message.includes("Stopped")` at line 68; `stop()`
  sets status `"stopped"` optimistically at lines 78-90.
- `src/stores/settings.ts` (118 lines) — `load` parses localStorage without
  shape validation (lines 39-41); `saveKey`/`deleteKey`/`hasKey` branch on
  `isTauri()`; provider CRUD persists to localStorage.
- `src/lib/ai.ts` — `streamExplanationBrowser` (lines 86-134) parses SSE
  with `TextDecoder({stream:true})` + line splitting; `stopExplanation()`
  (lines 80-84) is a no-op outside Tauri.
- Repo conventions: zustand stores; `vi.mock` for module mocks; path alias
  `@/`.

## Commands you will need

| Purpose   | Command                  | Expected on success |
|-----------|--------------------------|---------------------|
| Test      | `pnpm test`              | all pass            |
| Typecheck | `pnpm exec tsc --noEmit` | exit 0              |

## Scope

**In scope** (the only files you should modify):
- `src/stores/__tests__/explanation.test.ts` (create)
- `src/stores/__tests__/settings.test.ts` (create)
- `src/lib/__tests__/ai-parser.test.ts` (create)

**Out of scope** (do NOT touch):
- Any app source file — this plan only ADDS tests. Bug fixes land in
  plans 005 (cancellation), 011 (browser stop), 015 (coalescing).
  Write the tests to document CURRENT behavior; where current behavior is
  a known defect, mark the test `// KNOWN BUG — fixed by plan 011` etc.
  so it can be flipped when the fix lands.

## Git workflow

Repo has no commits — work directly in the working tree. Do not create
branches or commit unless the operator explicitly instructs it.

## Steps

### Step 1: Explanation store characterization tests

Create `src/stores/__tests__/explanation.test.ts`:

- Mock `@/lib/ai` with `vi.mock` — export a controllable
  `streamExplanation` (`vi.fn()` returning a promise you resolve/reject
  manually, and capturing the `onChunk` callback) and `stopExplanation`
  (`vi.fn()`).
- Tests to write (each pins current behavior):
  1. `start sets loading then done`: resolve the stream with no chunks —
     status goes `loading` → `done`.
  2. `chunks flip status to streaming and append text`: invoke the captured
     `onChunk("a")`, `onChunk("b")` — text is `"ab"`, status `"streaming"`.
  3. `stop marks stopped and prevents further chunk appends` — **current
     behavior is the KNOWN BUG**: after `stop()`, a late `onChunk` still
     appends and flips status back to `"streaming"`. Write the test to
     assert the CURRENT buggy behavior with a comment
     `// KNOWN BUG (plan 011/005 fixes: chunk after stop must be ignored)`.
  4. `error sets status error with message`: reject with `"boom"` →
     status `"error"`, error `"boom"`.
  5. `error containing "Stopped" is classified as stopped` — current
     behavior (fragile string contract, fixed by plan 005's typed marker);
     mark `// KNOWN BUG (plan 005: typed cancellation)`, keep asserting
     current behavior.
- Use `useExplanationStore.getState()`/`setState` and reset state between
  tests (`useExplanationStore.setState({ byPaper: {}, expandedId: null })`).

**Verify**: `pnpm test` → new suite passes, exit 0.

### Step 2: Settings store characterization tests

Create `src/stores/__tests__/settings.test.ts`:

- Mock `@/lib/ai` (`isTauri` → false so the browser path runs; the
  in-memory browser key store is in `@/lib/ai` — exercise `saveKey`/
  `hasKey`/`deleteKey` through the store).
- Clear localStorage in `beforeEach`.
- Tests:
  1. `load with empty storage yields empty providers`.
  2. `addProvider persists and sets active when none active`.
  3. `load with corrupted JSON does not throw` — set
     `localStorage.setItem("papyrus-providers", "not json")` before `load()`;
     assert providers `[]` and `loaded` true. **Current behavior**:
     `load` catches and returns empty — assert THAT (plan 012 extends
     validation; keep this test as the baseline).
  4. `saveKey then hasKey is true` (browser path, in-memory).
  5. `deleteKey makes hasKey false`.
- Reset the module-level browser key map between tests by re-importing or
  deleting keys after each test (`deleteKey` for all used ids).

**Verify**: `pnpm test` → all pass.

### Step 3: Browser SSE parser characterization tests

Create `src/lib/__tests__/ai-parser.test.ts`:

- `streamExplanationBrowser` is not exported. Test it through
  `streamExplanation` with `isTauri()` mocked false
  (`vi.mock("@/lib/ai")` won't work for testing the same module — instead
  mock the global `fetch` and `window`:
  - `vi.stubGlobal("fetch", mockFetch)` returning a `Response`-like object
    with `ok`, `status`, `body` (a `ReadableStream` built from
    `new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } })`),
    and `text()`.
  - `isTauri()` checks `"__TAURI_INTERNALS__" in window` — in node there is
    no `window`; define `globalThis.window = {} as any` in the test (or a
    `setup` file) so `isTauri()` is false.
- Tests:
  1. `parses streamed SSE deltas in order` — feed chunks
     `data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n` then
     `[DONE]`; assert onChunk received `Hello`.
  2. `handles split lines across chunks` — first chunk ends mid-line; assert
     content still parsed (TextDecoder stream:true contract).
  3. `ignores keep-alive lines` — `: ping` comments and non-`data:` lines.
  4. `surfaces HTTP errors` — `ok:false`, `text()` returns body → throws
     with status code.
  5. `clean close without [DONE] exits normally` — **current behavior**:
     loop breaks on `done` — assert it resolves (no throw). Note: the Rust
     parser errors here (fixed by plan 001); the TS side is the reference.

**Verify**: `pnpm test` → all pass.

## Test plan

- Three new suites; pattern for store tests: zustand `getState()` +
  `vi.mock` of `@/lib/ai` (see plan 003's papers test for the established
  pattern); parser tests use `vi.stubGlobal("fetch", ...)`.
- Verification: `pnpm test` → all suites pass, exit 0.

## Done criteria

- [ ] `pnpm test` exits 0 — all suites (smoke, papers, explanation, settings, ai-parser)
- [ ] `pnpm exec tsc --noEmit` exits 0
- [ ] No app source files modified (tests only)
- [ ] KNOWN BUG tests are clearly commented with the plan number that fixes them
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- Any source file in `src/` (outside `__tests__`) needs modification to make
  tests pass — that means current behavior differs from the excerpts; report
  the discrepancy.
- `vi.stubGlobal("fetch", ...)` doesn't work with the node environment —
  switch that one test file to `// @vitest-environment happy-dom` (add
  happy-dom as devDependency) and retry; if that also fails, report.

## Maintenance notes

- Plans 005, 011, 015, 016, 017 flip the KNOWN BUG tests when they land —
  each of those plans lists which tests to update.
- When the AI-layer dedup (plan 016) lands, the parser tests move to
  whatever the single source of truth becomes; the behaviors asserted here
  are the contract.
- The settings store tests document the browser (non-Tauri) path only;
  Tauri-path behavior (real keyring) is exercised manually or in Rust tests.
