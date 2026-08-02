# Plan 012: Validate provider config shape when loading from localStorage

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
- **Depends on**: plans/002 (runner — tests)
- **Category**: bug (defensive)
- **Planned at**: working tree, 2026-08-02 (repo has no commits yet)

## Why this matters

`load()` does `JSON.parse(localStorage.getItem(...) ?? "[]") as
ProviderConfig[]` with no runtime shape check. Corrupted or legacy
localStorage — `"null"`, `{}`, `[null]`, partial objects — either throws
on `.map`/`.length` (crashing the Settings page) or yields providers whose
`baseUrl`/`model` are undefined, which then flow into explain requests as
`undefined`. Also `activeProviderId` can dangle to a provider that no
longer exists. Defensive validation at the load boundary is cheap and
makes the app resilient to hand-edited storage.

## Current state

- `src/stores/settings.ts:36-48`:

```ts
  load: () => {
    if (get().loaded) return;
    try {
      const providers = JSON.parse(
        localStorage.getItem(STORAGE_KEY) ?? "[]",
      ) as ProviderConfig[];
      const activeProviderId = localStorage.getItem(ACTIVE_KEY);
      set({ providers, activeProviderId, loaded: true });
    } catch {
      set({ loaded: true });
    }
  },
```

- `ProviderConfig` type: `{ id, name, baseUrl, model }` (all strings),
  `src/lib/types.ts:10-15`.

## Commands you will need

| Purpose   | Command                  | Expected on success |
|-----------|--------------------------|---------------------|
| Test      | `pnpm test`              | all pass            |
| Typecheck | `pnpm exec tsc --noEmit` | exit 0              |
| Build     | `pnpm run build`         | exit 0              |

## Scope

**In scope** (the only files you should modify):
- `src/stores/settings.ts`
- `src/stores/__tests__/settings.test.ts` (extend plan 004's suite)

**Out of scope** (do NOT touch):
- `src/lib/types.ts` (no type changes); any Rust code; the UI.

## Git workflow

Repo has no commits — work directly in the working tree. Do not create
branches or commit unless the operator explicitly instructs it.

## Steps

### Step 1: Add a validator and use it in `load`

In `src/stores/settings.ts`, add a module-level pure function:

```ts
function isProviderConfig(value: unknown): value is ProviderConfig {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" && v.id.length > 0 && v.id.length <= 64 &&
    typeof v.name === "string" && v.name.length > 0 && v.name.length <= 64 &&
    typeof v.baseUrl === "string" && v.baseUrl.length > 0 &&
    typeof v.model === "string" && v.model.length > 0
  );
}
```

Then in `load()`:

- Parse the JSON; if the result is not an array, treat as empty.
- `const providers = (parsed as unknown[]).filter(isProviderConfig);`
- Validate `activeProviderId`: if it's a string but not in the filtered
  providers' ids, set it to `providers[0]?.id ?? null`.
- Keep the existing try/catch (parse errors → empty state).

**Verify**: `pnpm exec tsc --noEmit` → exit 0.

### Step 2: Tests

Extend `src/stores/__tests__/settings.test.ts` (plan 004's suite):

1. `load drops malformed provider entries`: set
   `localStorage.setItem("papyrus-providers", JSON.stringify([{ id: "a", name: "A", baseUrl: "https://x", model: "m" }, null, { id: "b" }, "garbage"]))`
   → after `load()`, `providers` has exactly the one valid entry.
2. `load with non-array JSON yields empty`: storage contains `"{}"` →
   providers `[]`, no throw.
3. `activeProviderId dangling id is repaired`: storage has providers
   `[validA]`, active key `"ghost"` → after load, activeProviderId is the
   valid provider's id.
4. (Existing tests from plan 004 must keep passing — the corrupted-JSON
   test's expected behavior is unchanged: empty providers, no throw.)

Reset localStorage in `beforeEach` (already the pattern from plan 004).

**Verify**: `pnpm test` → all pass.

## Test plan

- 3 new tests in `src/stores/__tests__/settings.test.ts`.
- Verification: `pnpm test` all pass; `pnpm run build` green.

## Done criteria

- [ ] `pnpm test` exits 0
- [ ] `pnpm exec tsc --noEmit` exits 0
- [ ] `pnpm run build` exits 0
- [ ] `load()` filters invalid entries and repairs dangling active id
      (test-covered)
- [ ] No files outside the two in-scope files modified
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- Plan 004's settings suite doesn't exist yet (run 002 + 004 first).
- A field-length constraint conflicts with real usage (e.g. a provider name
  longer than 64 chars is somehow valid) — report; the constraints mirror
  the Rust `validate_provider` limits (ai.rs).

## Maintenance notes

- Keep the validator constraints in sync with Rust `validate_provider`
  (`ai.rs:194-206`): id ≤ 64, name 1-64, model 1-128, baseUrl non-empty.
  If those change, update both.
- Plan 025 (search) and 026 (favorites) add new localStorage slices —
  follow this validator pattern for them.
