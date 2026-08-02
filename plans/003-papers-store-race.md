# Plan 003: Guard the papers store against stale-response races

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
- **Risk**: LOW
- **Depends on**: plans/002 (test runner — the regression test needs `pnpm test`)
- **Category**: bug
- **Planned at**: working tree, 2026-08-02 (repo has no commits yet)

## Why this matters

Rapid category switching (A → B → C) fires overlapping `fetchPapers` calls.
Each `refresh()` captures the category at call time and applies its result
unconditionally — so a slow response for category B can resolve *after* the
response for C, overwriting C's list while the sidebar highlights C. On the
app's core screen the user sees a mismatch: highlighted category, wrong
papers. The Rust backend's 3-second arXiv rate limiter makes overlapping
requests the *normal* case when clicking through categories quickly.

## Current state

- `src/stores/papers.ts` (full file, 44 lines):

```ts
  setCategory: (category) => {
    if (category === get().category) return;
    set({ category, papers: [], error: null });
    void get().refresh();
  },

  refresh: async () => {
    const { category } = get();
    set({ loading: true, error: null });
    try {
      const papers = await fetchPapers(category, PAGE_SIZE);
      set({ papers, loading: false, lastUpdated: Date.now() });
    } catch (err) {
      set({
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },
```

- `fetchPapers` is at `src/lib/arxiv.ts:25-37`; it returns a Promise.
- Repo conventions: Zustand stores in `src/stores/`, strict TS, no `any`.

## Commands you will need

| Purpose   | Command                  | Expected on success |
|-----------|--------------------------|---------------------|
| Test      | `pnpm test`              | all pass            |
| Typecheck | `pnpm exec tsc --noEmit` | exit 0              |
| Build     | `pnpm run build`         | exit 0              |

## Scope

**In scope** (the only files you should modify):
- `src/stores/papers.ts`
- `src/stores/__tests__/papers.test.ts` (create)

**Out of scope** (do NOT touch):
- `src/lib/arxiv.ts` — the fetch layer; the race is in the store.
- Any Rust code; any other store.

## Git workflow

Repo has no commits — work directly in the working tree. Do not create
branches or commit unless the operator explicitly instructs it.

## Steps

### Step 1: Add a request sequence token to the store

In `src/stores/papers.ts`:

- Add a module-level or store-level `let requestSeq = 0;` counter
  (module-level is fine and simplest).
- In `refresh()`:
  1. `const seq = ++requestSeq;`
  2. After `await fetchPapers(...)`: `if (seq !== requestSeq) return;` —
     a newer request has superseded this one; drop the result entirely
     (including NOT clearing `loading`).
  3. In the `catch` block: same guard — `if (seq !== requestSeq) return;`
     so a stale error can't clobber the current state either.
- `setCategory` stays as-is (it already delegates to `refresh`).
- Keep the rest of the store byte-identical.

**Verify**: `pnpm exec tsc --noEmit` → exit 0.

### Step 2: Write the regression test

Create `src/stores/__tests__/papers.test.ts` (pattern: Vitest, zustand
stores are created with `create()` — import `usePapersStore` and read state
via `usePapersStore.getState()`):

- Mock the fetch layer: `vi.mock("@/lib/arxiv", () => ({ fetchPapers: vi.fn() }))`
  and import the mocked `fetchPapers`.
- Test `ignores stale responses`:
  1. `fetchPapers` mock returns controllable promises (resolve manually).
  2. `setCategory("cs.AI")` — capture the first promise's resolve fn.
  3. `setCategory("cs.LG")` — capture the second promise's resolve fn.
  4. Resolve the **first** (stale) promise with "AI papers" — assert state
     `papers` is still `[]` (or whatever the second set produced) and
     `loading` is still `true`.
  5. Resolve the second with "LG papers" — assert `papers` contains the LG
     papers and `loading` is `false`.
- Test `category switch clears papers immediately` (documenting existing
  behavior so it can't regress): after `setCategory`, `papers` is `[]` and
  `category` is the new value.

Note: the store persists nothing; no localStorage involved.

**Verify**: `pnpm test` → both tests pass, exit 0.

## Test plan

- `src/stores/__tests__/papers.test.ts` — two tests (stale-response drop,
  immediate clear). Pattern: `src/lib/__tests__/smoke.test.ts` from plan 002
  for the runner conventions; zustand `getState()`/`setState` for store access.
- Verification: `pnpm test` → all pass.

## Done criteria

- [ ] `pnpm test` exits 0 (smoke + papers tests)
- [ ] `pnpm exec tsc --noEmit` exits 0
- [ ] `pnpm run build` exits 0
- [ ] The stale-response test fails against the pre-fix store (it should —
      verify by temporarily reverting step 1 if unsure; then re-apply)
- [ ] No files outside the two in-scope files modified
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The store code at `papers.ts:25-43` doesn't match the excerpt (drift).
- The mocked module approach fails (e.g. vitest can't resolve `@/lib/arxiv`
  mock) — the `@` alias is configured in vite.config.ts, which vitest
  reads; if it still fails, report the error rather than restructuring.
- Resolving the stale promise still updates state after a reasonable fix
  attempt.

## Maintenance notes

- If pagination or infinite scroll is added later, the same token must
  guard those fetches too.
- The sequence-token pattern is the repo's chosen fix; plan 005 (cancellation)
  uses a different mechanism (typed marker) — do not conflate them.
- Reviewer should confirm the `loading` flag is only cleared by the newest
  request (the classic bug this pattern prevents).
