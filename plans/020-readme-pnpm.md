# Plan 020: README prerequisites — document pnpm

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
- **Effort**: S
- **Risk**: LOW (docs only)
- **Depends on**: none
- **Category**: dx
- **Planned at**: working tree, 2026-08-02 (repo has no commits yet)

## Why this matters

The README's Development section lists prerequisites ("Rust, Node.js ≥ 20,
and on Windows: Visual Studio Build Tools (C++) + WebView2") and then
instructs `pnpm install` — but never mentions pnpm itself. A contributor
without pnpm runs `npm install`, producing an npm lockfile ecosystem or a
confusing failure. It's the first friction an OSS reader hits.

## Current state

- `README.md:31` (Development section):

```md
Prerequisites: [Rust](https://rustup.rs), Node.js ≥ 20, and on Windows: Visual Studio Build Tools (C++) + WebView2.
```

- `README.md:34-35`: `pnpm install` / `pnpm tauri dev`.

## Commands you will need

| Purpose | Command | Expected on success  |
| ------- | ------- | -------------------- |
| None    | —       | — (docs-only change) |

## Scope

**In scope** (the only files you should modify):

- `README.md`

**Out of scope** (do NOT touch):

- Any code; `package.json` (`packageManager` field is optional — add it
  only if it's missing and trivially safe: `pnpm@10.7.1` — it helps
  corepack users; decide by checking whether the field exists).

## Git workflow

Repo has no commits — work directly in the working tree. Do not create
branches or commit unless the operator explicitly instructs it.

## Steps

### Step 1: Add pnpm to the prerequisites

Rewrite the prerequisites line:

```md
Prerequisites: [Rust](https://rustup.rs), Node.js ≥ 20 (which ships
[corepack](https://nodejs.org/api/corepack.html) — run `corepack enable pnpm`
to get pnpm), [pnpm](https://pnpm.io/installation) ≥ 9, and on Windows:
Visual Studio Build Tools (C++) + WebView2.
```

- If `package.json` lacks a `packageManager` field, add
  `"packageManager": "pnpm@10.7.1"` (check the installed version with
  `pnpm --version` first and use that).

**Verify**: `node -e "JSON.parse(require('fs').readFileSync('package.json'))"` (valid JSON) and the README reads correctly — no command gates for docs.

## Test plan

- None (docs-only). Verification: the README setup section now names pnpm.

## Done criteria

- [ ] `README.md` prerequisites mention pnpm (and corepack path)
- [ ] `package.json` has a `packageManager` field matching the installed
      pnpm version (or was already present — then unchanged)
- [ ] No other files modified
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The installed pnpm version can't be determined (`pnpm --version` fails)
  — use `10` in the `packageManager` field and note it.
- The README's Development section was restructured by another plan
  (plan 018 touches README too — reconcile content, don't duplicate).

## Maintenance notes

- Plan 018 (CI) uses `pnpm/action-setup@v4` with version 10 — keep the
  `packageManager` field and CI version in sync.
