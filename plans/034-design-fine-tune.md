# Plan 034 — Design fine-tune pass (the "needs precise tuning" report)

**Priority:** P2 · **Effort:** M · **Depends on:** 028 (palette/focus/ARIA round)

## Problem

The user asks for very precise design tuning ("التصميم عموماً يحتاج ضبط
دقيق جدا"). This round targets concrete, verifiable visual issues found
in the built app (RTL session, warm monochrome 3-theme system) rather
than subjective restyling. Token-only discipline stays: no raw Tailwind
hues.

## Scope (each item gets before/after evidence)

1. **Pinned bar composition** (verified live): the status text +
   search box + actions row wraps awkwardly at narrow widths; day
   navigation buttons crowd the search box. Give the row a fixed
   two-line layout at < 900px (status/actions line, search line) with
   `flex-wrap` order tuning.
2. **Card density**: title 15px/leading-5, two-line clamp; meta row
   (date · venue · badge) alignment in RTL (`ms/me` audit); abstract
   preview 3-line clamp with a soft gradient mask instead of hard cut.
3. **Focus & keyboard**: visible focus ring on cards (they are
   clickable), consistent `focus-visible` outlines on the day-picker
   arrows and sort dropdown trigger; skip-link target highlighted on
   focus.
4. **Dark mode contrast**: verify text-muted-foreground vs background
   > = 4.5:1 across the three themes (compute and assert in a test with
   > the token values); adjust the low-contrast tokens that fail.
5. **RTL specifics**: day-picker chevrons swap direction; the sort
   dropdown opens on the correct side; the search icon sits at the
   start edge; scrollbar styling in RTL (`scrollbar-gutter` both edges).
6. **Empty/error/loading states**: consistent icon + message + action
   pattern in all three states (list, reader, settings).

## Verification gates

- All frontend gates; new token-contrast unit test.
- CDP screenshots (light + dark + sepia, EN + AR) before/after compared
  by a human pass; the pinned bar probe re-run (delta 0, opaque).

## Commit strategy

One commit per item group (bar, cards, focus, contrast, rtl, states) —
six small commits, each green, each with the changelog row.
