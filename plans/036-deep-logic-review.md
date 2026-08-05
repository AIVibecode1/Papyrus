# Plan 036 — Deep code-logic review round (line-by-line, remaining modules)

**Priority:** P1 · **Effort:** L · **Depends on:** 029 (ai/ split), 030 (test gaps)

## Problem

The user asked for a comprehensive line-by-line review. Rounds 1-2
covered pdf.rs, ai.rs, citations.rs, papers.rs fetch paths and the
reader store. This round audits the modules not yet line-reviewed, with
a specific eye on the races/state bugs that have historically shipped
despite green unit tests (black pages, eternal spinner, floating bar —
all only found by live verification).

## Audit scope (each module: read, list findings, fix, test)

1. **digest.rs + digest store**: backfill loop, concurrency guard, date
   normalization vs timezone, interaction with `refresh`'s cache-first
   path (potential double-fetch on day view).
2. **reader store (reader.ts)**: walkthrough persistence (Plan 031
   result), stop/save races, the CAS on stop, section state, re-open
   behavior.
3. **settings flow**: provider form validation (URL parse, model
   required), keychain load/save error paths, provider test IPC, the
   quick-add presets, last-test badge persistence.
4. **i18n parity**: a script asserting every `en.json` key exists in
   `ar.json` (and vice versa) with identical values' types; run it in
   CI or as a vitest test.
5. **Rust command surface**: every `#[tauri::command]` — arg
   serialization (camelCase discipline — the Phase A lesson), error
   strings never leaking secrets (redact_tokens audit), capability
   permissions match the called commands.
6. **The Tauri capability files**: least privilege re-check against the
   current command list.

## Verification gates

- Every finding fixed in its own commit with a regression test.
- Full gates (frontend + Rust: test, clippy -D warnings, fmt, typecheck,
  lint, format:check).
- The CDP live suite (Plan 035) green against the rebuilt exe.

## Commit strategy

One commit per module audit with a `findings:` list in the body; the
i18n parity check gets its own commit (test + fix any missing keys).
