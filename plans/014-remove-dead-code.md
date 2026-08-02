# Plan 014: Remove dead code — unused export, unused shadcn components, dangling lint suppression

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
- **Depends on**: none
- **Category**: tech-debt
- **Planned at**: working tree, 2026-08-02 (repo has no commits yet)

## Why this matters

Three dead items confuse contributors and add surface:

1. `getKeyForProvider` is exported from the settings store but never
   imported — its docstring ("Convenience for the explain flow") suggests
   it's the key path for explanations, which it isn't (the explain flow
   reads keys in Rust).
2. `src/components/ui/separator.tsx` and `src/components/ui/textarea.tsx`
   (shadcn components) have zero importers.
3. `settings-page.tsx:70` carries an `// eslint-disable-next-line
react-hooks/exhaustive-deps` comment in a repo with no ESLint installed —
   it hides the genuine effect-dependency issue it annotates (the
   key-status effect keys on `providers.length` only) and will confuse
   whoever adds lint first (plan 018).

## Current state

- `src/stores/settings.ts:111-113`:

```ts
/** Convenience for the explain flow (browser fallback reads the dev key). */
export function getKeyForProvider(providerId: string): string {
  return getBrowserKey(providerId);
}
```

- `src/features/settings/settings-page.tsx:68-71`:

```ts
useEffect(() => {
  refreshKeyStates();
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, [providers.length]);
```

- `src/components/ui/separator.tsx`, `src/components/ui/textarea.tsx` —
  shadcn-generated, zero importers (verify with grep before deleting).

## Commands you will need

| Purpose   | Command                  | Expected on success |
| --------- | ------------------------ | ------------------- |
| Typecheck | `pnpm exec tsc --noEmit` | exit 0              |
| Build     | `pnpm run build`         | exit 0              |

## Scope

**In scope** (the only files you should modify):

- `src/stores/settings.ts` (remove the export)
- `src/features/settings/settings-page.tsx` (fix the effect deps + remove the suppression comment)
- `src/components/ui/separator.tsx`, `src/components/ui/textarea.tsx` (delete)

**Out of scope** (do NOT touch):

- Other shadcn components (button, card, badge, skeleton, select, input, label — all used).
- Any behavior change beyond the effect-deps fix.

## Git workflow

Repo has no commits — work directly in the working tree. Do not create
branches or commit unless the operator explicitly instructs it.

## Steps

### Step 1: Verify zero importers, then delete

1. `grep -rn "getKeyForProvider" src/` → expect exactly 2 hits: the
   definition and its export (i.e. only `settings.ts` itself). If other
   hits exist, STOP and report.
2. `grep -rn "ui/separator\|ui/textarea\|<Separator\|<Textarea" src/` →
   expect zero hits outside the component files themselves. If hits exist,
   STOP and report.
3. Delete the two component files and remove the `getKeyForProvider`
   export from `settings.ts` (including the now-unused `getBrowserKey`
   import if nothing else uses it — check `grep -n "getBrowserKey" src/`
   after removal; `ai.ts` uses it internally, that's fine).

**Verify**: `pnpm exec tsc --noEmit` → exit 0 (this catches any missed
importer via unused/unknown module errors).

### Step 2: Fix the key-status effect deps properly

In `settings-page.tsx`, the effect should re-run when the provider _set_
changes, not just the length (delete + re-add at constant length leaves
stale badges — the defect plan 004's TEST-02 noted). Rewrite:

```ts
const providerIds = providers.map((p) => p.id).join(",");

useEffect(() => {
  refreshKeyStates();
}, [providerIds]);
```

- Remove the `eslint-disable-next-line` comment.
- `refreshKeyStates` is re-created each render; with `providerIds` as the
  dep, the effect fires when the id set changes. If the linter (future,
  plan 018) complains about `refreshKeyStates` not being a dep, wrap it in
  `useCallback` with `[providers]` deps — do that now if trivial, so plan
  018 lands clean.

**Verify**: `pnpm exec tsc --noEmit` → exit 0; `pnpm run build` → exit 0.

## Test plan

- No new tests (pure deletion + effect-deps fix; the Settings UI behavior
  is covered by plan 004's store tests for the store layer).
- Verification: typecheck + build green.

## Done criteria

- [ ] `grep -rn "getKeyForProvider" src/` → no matches
- [ ] `grep -rn "Separator\|Textarea" src/ --include="*.tsx" --include="*.ts"` →
      no matches
- [ ] `src/components/ui/separator.tsx` and `textarea.tsx` deleted
- [ ] No `eslint-disable` comments remain in `src/`
- [ ] `pnpm exec tsc --noEmit` and `pnpm run build` both exit 0
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- Any importer is found for the "dead" symbols (the audit was wrong) —
  keep the symbol and report.
- The effect-deps rewrite causes a behavior change beyond refresh timing
  (e.g. infinite loop) — revert to the original deps and report.

## Maintenance notes

- Plan 017 (settings-page split) will move this effect into an extracted
  component — the `providerIds` dep pattern should move with it.
- Plan 018 (lint) will add `react-hooks/exhaustive-deps`; this plan's
  cleanup is what makes that rule pass on first run.
