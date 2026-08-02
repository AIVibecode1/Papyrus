# Plan 022: Archive REF1.md / REF2.md — stale research artifacts that contradict settled decisions

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
- **Category**: docs
- **Planned at**: working tree, 2026-08-02 (repo has no commits yet)

## Why this matters

`REF1.md` and `REF2.md` at the repo root are raw AI-chat research artifacts
from the design phase. Committed as-is, they read as project docs and
actively contradict settled decisions: REF2 recommends a Python sidecar
(`REF2.md:97-104` lists Python as a prerequisite and `npm create
tauri-app@latest`), suggests alternative product names ("PaperLens",
"Q4Papers", "Al-Waraq" — `REF2.md:88-93`), and names providers not in the
shipped presets ("Grok, Claude" — the app ships openai/openrouter/
deepseek/groq/ollama). Per the audit playbook, stale docs that are
actively wrong are worse than missing — a contributor following REF2's
setup advice would fight the real architecture (pure-Rust backend per
AGENTS.md).

## Current state

- `REF1.md` (root) — API research notes; ends with "Would you like
  ready-to-use Python code examples…" (`REF1.md:62`).
- `REF2.md` (root) — build guide; contains the contradictions above.
- The still-valid roadmap signals inside REF2 (`REF2.md:28-30`
  favorites/digest, `:78` GitHub Actions CI) are already captured by
  plans 018 (CI), 025/026 (search/favorites), 027 (failover).

## Commands you will need

| Purpose   | Command            | Expected on success |
|-----------|--------------------|---------------------|
| None      | `git status`       | expected changes only |

## Scope

**In scope** (the only files you should modify):
- `REF1.md`, `REF2.md` (move)
- `docs/research/` (create)
- `README.md` (only if it references REF files — check first)

**Out of scope** (do NOT touch):
- `AGENTS.md` — it's the live governance doc (plan 024 touches its
  "official keychain" claim separately).
- Any code.

## Git workflow

Repo has no commits — work directly in the working tree. Do not create
branches or commit unless the operator explicitly instructs it.

## Steps

### Step 1: Move and mark as historical

1. `mkdir -p docs/research`
2. Move both files: `git mv` won't work (nothing tracked yet) — use plain
   `mv REF1.md docs/research/REF1.md` and same for REF2.
3. Prepend a header to each (keep the rest intact — they're research
   artifacts, not executable docs):

```md
> **ARCHIVED (2026-08-02)** — early design-phase research notes. Decisions
> have since settled: see AGENTS.md. Some content here (Python sidecar,
> alternative names, provider lists) is outdated and must not be followed.
```

**Verify**: `ls docs/research/` shows both files; root has no REF files;
both files start with the ARCHIVED header.

### Step 2: Check for references

- `grep -rn "REF1\|REF2" README.md AGENTS.md docs/ src/` → expect no hits.
  If the README links them, remove/replace those links (docs-only).

**Verify**: grep returns nothing.

## Test plan

- None (docs). Verification: grep + file listing above.

## Done criteria

- [ ] `REF1.md` and `REF2.md` live under `docs/research/` with the ARCHIVED header
- [ ] No references to REF1/REF2 remain in README/AGENTS/docs
- [ ] No code files modified
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- A live doc (AGENTS.md, README) is found to depend on REF content beyond
  a link (e.g. it quotes REF2's roadmap verbatim) — reconcile the
  dependency by folding the quoted content into the live doc first.

## Maintenance notes

- The roadmap signals from REF2 are owned by plans 018/025/026/027 — if
  those plans change, this archive note stays accurate (it only says the
  decisions settled).
- Future research notes should go to `docs/research/` from day one.
