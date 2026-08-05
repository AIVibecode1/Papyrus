# Plan 035 — Search UX completion + live verification checklist

**Priority:** P2 · **Effort:** S · **Depends on:** 030, 031 (seeding + skip-known batch)

## Problem (live evidence)

Search itself works in the built app (verified: skeleton -> new results
in ~1.5s). What is missing is search _polish_ and a repeatable
verification script so regressions like the eternal "loading…" hint or
the floating bar never ship again.

## Scope

1. **Clear affordance**: an X button inside the search box when non-empty
   (one click restores the feed; Escape does the same). Currently the
   user must delete the text manually and the feed does not come back
   until the debounce fires.
2. **Result context**: when a query is active, the status line shows
   `نتائج لـ "…"` (results for "…") and the day navigation hides (search
   ignores dates — verified: query+date is ANDed, which confuses).
3. **Empty results**: the empty state gets a "clear search" action
   (translated), not just text.
4. **Sort during search** already honest after `b614dbe`; Plan 033 makes
   it actually reorder on S2 outage days.
5. **Automated live-verification script** (`dev/cdp-search-verify.mjs`):
   opens the exe over CDP, types a query, asserts skeleton -> results
   change -> clear restores the feed; runs the pinned-bar probe (delta
   0 + opaque) and the canvas probe (0 black). Committed so future
   rounds run it before release.

## Verification gates

- Full frontend gates + new component tests (clear button, Esc, empty
  state action).
- The committed CDP script green against the rebuilt exe.

## Commit strategy

Two commits: `feat(search): clear button + Esc + result context line`
and `test(e2e): committed CDP verification script for search/sticky/pdf`.
