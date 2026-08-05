# Plan 056 — Release after Round 5 fixes

**Priority:** P1 · **Effort:** S · **Depends on:** 050–055

## Version

- If 1.1.0 already released with broken search: ship **1.1.1** (patch)
  focused on search + chrome + copy + copy/docs.
- If 1.1.0 never widely shipped: can fold into **1.1.1** or **1.2.0**
  only if design push is large enough to market as minor.

Recommendation: **1.1.1** for correctness-first.

Bump together:

- `package.json`
- `src-tauri/tauri.conf.json`
- `src-tauri/Cargo.toml`

## release.md section (do not truncate history)

Must mention:

- Search sorts by **relevance** for queries; category limit defaults **off**
- Search chrome visual fix
- PDF copy/paste improvements
- Clarified OpenAI API vs ChatGPT account (no fake Codex login)
- Dark theme contrast / elevation

## README

- Fix any “Codex” wording that implies ChatGPT app login
- Search feature row: fielded + relevance + year range

## Gates

Full 055 checklist + CI green + installers if tagging.

**Commit:** `release: v1.1.1 search relevance, reader copy, theme, OpenAI clarity`
