# Plan 006: Stop swallowing keychain-delete failures in the settings UI

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
- **Depends on**: none (pure UI-flow change; no tests required beyond the build gates)
- **Category**: bug
- **Planned at**: working tree, 2026-08-02 (repo has no commits yet)

## Why this matters

Deleting a provider swallows the OS-keychain deletion error
(`deleteKey(id).catch(() => undefined)`). If Credential Manager removal
fails (transient lock, policy, permission), the provider row disappears but
its API key stays in the keychain forever — provider ids are random UUIDs,
so re-adding the same provider never reuses or cleans that orphaned
credential. The app is privacy-first; an unreachable stored credential is a
real (if small) hygiene hole, and the silent failure hides it.

## Current state

- `src/features/settings/settings-page.tsx:136-144`:

```ts
  const handleDelete = async (id: string) => {
    if (confirmDeleteId !== id) {
      setConfirmDeleteId(id);
      return;
    }
    await deleteKey(id).catch(() => undefined);   // <-- line 141: swallowed
    removeProvider(id);
    setConfirmDeleteId(null);
  };
```

- `deleteKey` is `src/stores/settings.ts` — in Tauri it invokes
  `delete_api_key` (Rust `ai.rs:275-281`), which returns `Err(String)` on
  failure; in the browser it deletes from the in-memory map (no failure).
- The store's `removeProvider` (settings.ts) removes the row and fixes up
  `activeProviderId`.
- i18n: keys live in `src/i18n/locales/en.json` / `ar.json`; every
  user-facing string goes through `t()`.

## Commands you will need

| Purpose   | Command                  | Expected on success |
|-----------|--------------------------|---------------------|
| Typecheck | `pnpm exec tsc --noEmit` | exit 0              |
| Build     | `pnpm run build`         | exit 0              |

## Scope

**In scope** (the only files you should modify):
- `src/features/settings/settings-page.tsx`
- `src/i18n/locales/en.json`
- `src/i18n/locales/ar.json`

**Out of scope** (do NOT touch):
- `src/stores/settings.ts` — the store's API stays as-is.
- Any Rust code.

## Git workflow

Repo has no commits — work directly in the working tree. Do not create
branches or commit unless the operator explicitly instructs it.

## Steps

### Step 1: Surface the failure instead of swallowing it

In `settings-page.tsx`:

- Add a `deleteError: string | null` state (next to the other useState
  hooks around line 49-58).
- Rewrite `handleDelete`:

```ts
  const handleDelete = async (id: string) => {
    if (confirmDeleteId !== id) {
      setConfirmDeleteId(id);
      return;
    }
    setDeleteError(null);
    try {
      await deleteKey(id);
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : String(err));
      setConfirmDeleteId(null);
      return; // provider row stays; key was not removed
    }
    removeProvider(id);
    setConfirmDeleteId(null);
  };
```

- Render the error near the provider list header (above the cards), using
  the destructive style already used for test failures
  (see `testResults` rendering around line 235):
  `<p className="text-xs text-destructive">{t("settings.deleteKeyFailed", { error: deleteError })}</p>`
- Clear `deleteError` when opening the add/edit form and on successful delete.

### Step 2: i18n strings

- `en.json`, under `settings`: add
  `"deleteKeyFailed": "Could not remove the API key from your system keychain: {{error}}"`.
- `ar.json`, under `settings`: add the Arabic equivalent, e.g.
  `"deleteKeyFailed": "تعذّر حذف مفتاح API من سلسلة المفاتيح: {{error}}"`.
- Match the existing JSON formatting (2-space indent, same key ordering area).

**Verify**: `pnpm exec tsc --noEmit` → exit 0; `pnpm run build` → exit 0.

## Test plan

- No new automated tests required (UI error path; the store API is covered
  by plan 004's settings suite for the browser path, where delete never
  fails). Manual check in the README-driven dev flow: browser preview,
  Settings → delete provider → row still removed (browser path never
  errors) — confirm no regression in the happy path.

## Done criteria

- [ ] `pnpm exec tsc --noEmit` exits 0
- [ ] `pnpm run build` exits 0
- [ ] `grep -n "catch(() => undefined)" src/` → no matches
- [ ] Both locale files contain the new `deleteKeyFailed` key
- [ ] No files outside the three in-scope files modified
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The settings-page structure differs from the excerpt (drift) — e.g. the
  delete handler moved into a subcomponent (plan 017 may extract one; if
  that already landed, apply this change to the extracted component).
- `deleteKey` gains a different error contract than `Promise<void>` that
  rejects with Error.

## Maintenance notes

- Plan 017 (settings-page split) may move this handler into a
  `ProviderCard` component — the error state should move with it.
- The browser-preview path never fails deletion; the error UI is
  exercisable only in the real Tauri app (Windows Credential Manager).
