# Plan 017: Split the settings-page god component

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

- **Priority**: P3
- **Effort**: M
- **Risk**: MED (behavior-preserving refactor of a 345-line component)
- **Depends on**: plans/004 (characterization tests for the settings store),
  plans/006 and 014 (delete-error handling and effect-deps fixes land here first)
- **Category**: tech-debt
- **Planned at**: working tree, 2026-08-02 (repo has no commits yet)

## Why this matters

`src/features/settings/settings-page.tsx` is the largest frontend file
(~345 lines, ~3.5× the repo median) with 11 `useState` hooks covering the
provider form, the list, key-status badges, and test results — four
distinct concerns in one component. Every new settings feature (per-
provider key editing, import/export, plan 025/026 settings) grows the same
file. Splitting it now, under the plan-004 test net, keeps future changes
surgical.

## Current state

- `src/features/settings/settings-page.tsx:34-345` — one component:
  - `SettingsPage` (lines 34+): state at 49-58, `refreshKeyStates`
    (60-66), effect (68-71), `applyPreset` (73-77), `openNewForm` (79-85),
    `openEditForm` (87-93), `handleSave` (95-118), `handleTest` (120-134),
    `handleDelete` (136-144), then the JSX (146-345).
- Store access via `useSettingsStore` (settings.ts).
- Repo conventions: feature folders (`src/features/<name>/`), shadcn
  components, strict TS.

## Commands you will need

| Purpose   | Command                  | Expected on success |
| --------- | ------------------------ | ------------------- |
| Test      | `pnpm test`              | all pass            |
| Typecheck | `pnpm exec tsc --noEmit` | exit 0              |
| Build     | `pnpm run build`         | exit 0              |

## Scope

**In scope** (the only files you should modify):

- `src/features/settings/settings-page.tsx` (slimmed)
- `src/features/settings/provider-form.tsx` (create)
- `src/features/settings/provider-card.tsx` (create)

**Out of scope** (do NOT touch):

- `src/stores/settings.ts` — the store API is the interface; no store changes.
- Any behavior change (this is a pure extraction).

## Git workflow

Repo has no commits — work directly in the working tree. Do not create
branches or commit unless the operator explicitly instructs it.

## Steps

### Step 1: Extract `ProviderForm`

Create `src/features/settings/provider-form.tsx` exporting `ProviderForm`:

- Props: `{ editingId: string | null; initial: { name: string; baseUrl: string; model: string }; onCancel: () => void; onSaved: () => void }`
  (or keep the form state internal and lift only save/cancel — choose the
  signature that minimizes prop drilling; the existing component's state at
  `settings-page.tsx:51-53` moves here: `form`, `preset`, `showKey`,
  `saving`).
- Move: `applyPreset` (73-77), `openNewForm`-related state (the form-open
  boolean stays in the parent), `handleSave` (95-118), the JSX form block
  (the `formOpen && <Card>…` section, ~lines 250-345).
- The preset select + name/URL/model/key fields + save/cancel buttons move
  verbatim (same i18n keys, same classes).

**Verify**: `pnpm exec tsc --noEmit` → exit 0.

### Step 2: Extract `ProviderCard`

Create `src/features/settings/provider-card.tsx` exporting `ProviderCard`:

- Props: `{ provider: ProviderConfig; isActive: boolean; hasKey: boolean; onSetActive: () => void; onEdit: () => void; onDelete: () => Promise<void>; onTest: () => Promise<void>; isTesting: boolean; testResult?: { ok: boolean; msg: string } | null; deleteConfirm: boolean }`
  (adjust to taste; keep it a controlled component so the parent holds
  `confirmDeleteId`/`testingId`/`testResults` or move those in — prefer
  moving `testingId`/`testResults` per-provider INTO the card if it keeps
  the parent simpler; the delete-confirm two-step state can also live in
  the card, with `onDelete` still calling the parent's error-aware handler
  from plan 006).
- Move the card JSX (lines ~172-250) and the test-result rendering.

**Verify**: `pnpm exec tsc --noEmit` → exit 0.

### Step 3: Slim the parent and re-verify

- `SettingsPage` keeps: the header + security note, the "AI Providers"
  heading + Add button, the provider list mapping to `ProviderCard`, the
  `deleteError` display (plan 006), and the `formOpen` toggle rendering
  `ProviderForm`.
- Remove all moved state/handlers from the parent.
- Behavior must be identical: same i18n keys, same test/delete flows, same
  key-status effect (plan 014's `providerIds` deps).

**Verify**:

- `pnpm test` → all pass (plan 004's settings store tests + any UI-adjacent suites)
- `pnpm run build` → exit 0
- Manual smoke (operator or browser preview): add/edit/delete provider,
  test connection, key badge refresh, delete-error path — all unchanged.

## Test plan

- No new tests required (store-level behavior is already covered; the
  split is UI-only). If the extraction accidentally changes a store
  interaction, plan 004's suites will catch it.
- Verification: `pnpm test` + `pnpm run build` green.

## Done criteria

- [ ] `pnpm test` exits 0
- [ ] `pnpm exec tsc --noEmit` exits 0
- [ ] `pnpm run build` exits 0
- [ ] `settings-page.tsx` is under ~150 lines and contains no form-field
      JSX and no provider-card JSX (they live in the new files)
- [ ] `grep -rn "useState" src/features/settings/provider-form.tsx src/features/settings/provider-card.tsx` — state is colocated
- [ ] No files outside the three in-scope files modified
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- Plan 006/014 haven't landed (their changes are inside this file — run
  them first to avoid merge pain).
- The extraction requires changing `useSettingsStore`'s API — the store is
  out of scope; report instead.
- Any i18n key or behavior changes during extraction — revert and report.

## Maintenance notes

- Future settings features (plan 026 favorites settings, per-provider key
  rotation) extend `ProviderCard`/`ProviderForm`, not the page.
- The key-status effect (plan 014) lives in the parent until it needs to
  move; if cards manage their own badge state later, move the effect with
  the `providerIds` dep pattern.
- Reviewer: diff the extracted components against the original JSX line by
  line — any class or label change is a red flag.
