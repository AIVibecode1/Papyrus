# Plan 047 — Release vehicle for Round 4

**Priority:** P1 · **Effort:** M · **Depends on:** 040–046 (or a documented subset)

## When to run

Only after the chosen subset of Round 4 plans is green on gates. If some
P1 items are deferred, list them explicitly in `release.md` under
“Known limitations”.

## Scope

1. **Version bump** in lockstep:
   - `package.json`
   - `src-tauri/tauri.conf.json`
   - `src-tauri/Cargo.toml`
   - Confirm they match (Round 3 already used 1.0.11 in some trees —
     inspect disk; bump to **1.1.0** if Round 4 is feature-heavy, or
     **1.0.12** if only small follow-ups shipped).

   **Recommendation:** `1.1.0` if search modes + notes both ship;
   otherwise patch.

2. **release.md** — new section, never truncate old history:
   - Search: fielded query, year range, clear/Esc, status line
   - Notes: hub, reader notes, highlights, export
   - Codex preset + safety notes
   - RTL/UX fixes
   - Reader tabs / continuity
   - Build provenance commit SHA
   - Gate counts (frontend tests, Rust tests)

3. **README.md**
   - Features table rows for Advanced search, Notes, Codex preset
   - Keep security notes accurate
   - macOS download note remains Actions artifacts / draft release

4. **Rebuild installers**
   - `pnpm exec tauri build`
   - Verify FileVersion / bundle version
   - dist freshness checks used in prior releases

5. **Live verification**
   - Search clear restores feed
   - Notes survive restart
   - Codex preset visible; key stays in keychain
   - AR + EN smoke
   - PDF still paints (no regression of black pages)

6. **Push** with repo identity; confirm CI artifacts upload.

## Verification gates

Mandatory full gates + `pnpm run check:release` if defined + clean tree
except intentional untracked files.

## Commit strategy

1. Per-feature commits already done in 040–046
2. One release commit: version + README + release.md
3. Tag `vX.Y.Z` only after local installers verified
4. `release.yml` produces draft GitHub release on tag

## Agent anti-patterns

- Do not tag before notes/search critical bugs from 046 are fixed.
- Do not claim OAuth Codex if only API key preset shipped.
- Do not delete historical release sections.
