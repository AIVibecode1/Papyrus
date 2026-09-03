# Plan 070: Reconcile plans index and AGENTS.md to shipped v1.1.8

> **Executor instructions**: Follow step by step. Verify after each step.
> If STOP conditions hit, stop and report — do not invent a new product roadmap.
>
> **Drift check**: Confirm `package.json` / `src-tauri/tauri.conf.json` / `src-tauri/Cargo.toml` all report version **1.1.8** (or newer if already bumped). If the app version is far ahead of this plan, re-read shipped features before editing status tables.

## Status

- **Priority**: P0
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: docs | dx
- **Planned at**: Papyrus snapshot v1.1.8 (2026-08-07 audit dump; no live git SHA)

## Why this matters

`plans/README.md` still presents **Round 4 (040–047)** as the current TODO set (architecture, advanced search, notes, Codex auth, etc.). The running app already ships notes, reading history, advanced search fields/years, theme work, and RTL toolbar centering. Agents that trust the index will re-build finished work or skip real gaps. `AGENTS.md` still frames Semantic Scholar as “can be added later” while S2 is in the fetch path.

## Current state

- `plans/README.md` — header “Current round: 4”, table 040–047 all **TODO**.
- Code already registers: `notes::*`, `history::*`, search field/year APIs, history UI (Plan 060), toolbar grid (Plan 063 comments in `papers-toolbar.tsx`).
- `AGENTS.md` — overview still primary-arXiv with S2 as future-leaning language.
- Version **1.1.8** aligned across package / tauri / Cargo (integrity script exists).

## Commands you will need

| Purpose | Command | Expected |
|---------|---------|----------|
| Integrity | `node dev/check-release-integrity.mjs` | exit 0, prints version |
| Grep shipped modules | `rg -n "history::|notes::|fetch_papers" src-tauri/src/lib.rs` | matches |

## Scope

**In scope**

- `plans/README.md` (or add `plans/AUDIT-IMPROVE-README.md` link section if you must preserve historical Round-4 text — prefer updating the main index with a clear “Shipped / Superseded” section)
- `AGENTS.md` — factual capability list only
- Optionally one line in `README.md` product feature list if it contradicts code

**Out of scope**

- Deleting old plan files 040–047 (keep as history; mark superseded in index)
- Implementing any feature
- Rewriting all historical plan bodies

## Git workflow

- Branch: `advisor/070-reconcile-docs`
- Commit: `docs: reconcile plans index and AGENTS.md with v1.1.8`

## Steps

### Step 1: Inventory shipped vs listed TODO

From the codebase, mark these as **shipped** (evidence in tree), not open Round-4 work:

- Advanced search (field, years, limit-to-category, relevance/sort) — `papers.rs` / toolbar
- Notes — `notes.rs`, notes UI/store
- Reading history — `history.rs`, history store/UI
- Provider keychain + OpenAI-compatible streaming — existing AI module
- Theme tokens / scrollbar work if present in `index.css`
- RTL search centering if `papers-toolbar.tsx` uses the 3-column grid

**Verify**: list at least five shipped items with file evidence in the PR description.

### Step 2: Rewrite `plans/README.md` index

Structure:

1. Short “Current product version: x.y.z” line.
2. **Active / next** table: only truly open plans (e.g. 070+ audit plans once copied, or empty).
3. **Superseded / shipped** table: 040–047 (and 050–063 as appropriate) with status **DONE** or **SUPERSEDED** and one-line “landed in ≤1.1.8” note — do not claim false DONE if a plan was never merged; use **SUPERSEDED by implementation** when code exists without the plan being checked off.
4. Link to `AUDIT-IMPROVE-README.md` if that file is copied into the repo.

**Verify**: no table row claims 041/042 are TODO while notes/search exist in `lib.rs`.

### Step 3: Update `AGENTS.md` Tech Stack / overview

- State arXiv **and** Semantic Scholar as sources (search/citations as implemented).
- Mention notes + reading history as local-first features.
- Keep security rules (keychain, no hardcoded keys) unchanged.

**Verify**: `rg -n "Semantic Scholar|later" AGENTS.md` — no “add later” for S2 if code already has it.

## Test plan

- Docs only: integrity script still passes.
- No new unit tests required.

## Done criteria

- [ ] `plans/README.md` does not list shipped search/notes/history as open TODO
- [ ] `AGENTS.md` matches actual sources and major features
- [ ] `node dev/check-release-integrity.mjs` exits 0
- [ ] No source code under `src/` or `src-tauri/src/` modified

## STOP conditions

- Version files disagree and integrity fails — fix version drift in a separate commit only if already broken; do not expand scope.
- Unclear whether a plan partially landed — mark **PARTIAL** with file pointers; do not delete the plan file.

## Maintenance notes

- After each release, update the index status in the same PR as the version bump.
- Product plan numbers (060+) and audit plan numbers (070+) can coexist; keep one index section for each.
