# Plan 054 — Design push + dark theme depth

**Priority:** P1 · **Effort:** L · **Depends on:** 051 (search chrome clean)

## Problem

Round 4 improved structure and tokens, but the product still feels
“template UI,” especially in **dark** mode: flat surfaces, weak
hierarchy, low-contrast muted text, cards that do not separate from the
canvas, toolbars that blend into content.

## Design direction (keep Papyrus identity)

Stay with **premium utilitarian minimalism** already stated in
`index.css` (warm bone light, ink primary, hairline borders). Do **not**
switch to loud gradients or glassmorphism spam.

Push means:

1. Clear **elevation ladder** (bg → sidebar → card → popover).
2. **Dark theme** with true depth (not pure `#000` + gray-400 text).
3. Stronger **type hierarchy** on paper cards and reader header.
4. Consistent control heights and spacing rhythm (4/8/12/16).
5. Focus rings that remain visible on dark.

## Dark theme token targets (`src/index.css`)

Adjust `.dark` / `[data-theme="dark"]` variables so that:

| Token | Intent |
| ----- | ------ |
| `--background` | Deep warm charcoal (slight hue), not pure black |
| `--card` | Noticeably lighter than background (separation) |
| `--muted` | Subtle lift for sidebars / sticky bars |
| `--border` | Visible hairline (~≥ 15% L difference from bg) |
| `--muted-foreground` | **≥ 4.5:1** on card and on background for body-size text |
| `--primary` | Keep ink/accent readable on dark buttons |
| `--accent` | Soft highlight that works for `::selection` |

Also revisit **sepia** only if contrast fails; main effort is dark.

Add or update the contrast unit test from plan 044 if present.

## Surfaces to restyle (concrete)

1. **Top bar** — solid blur or opaque; border-b; no muddy double fills.
2. **Sidebar** — distinct `bg-muted` vs main; active item with clear
   indicator (already has dot — strengthen).
3. **Paper cards** — title weight/size; meta row quieter; hover border
   `primary/30`; padding rhythm from density tokens.
4. **Sticky papers toolbar** — opaque, no transparency gap (regression
   of Round 3 floating-bar fix must remain).
5. **Reader** — header, PDF pane bg (`neutral-950`-ish), AI panel
   slightly elevated; divider visible.
6. **Settings / Notes** — same card language as papers.
7. **Empty states** — StatePanel already exists; match new spacing.

## Work units

### 1. Token pass (dark-first)

Edit CSS variables only first; take screenshots before/after.

**Commit:** `style(theme): deepen dark elevation and contrast tokens`

### 2. Shell + cards

Apply class tweaks to top-bar, sidebar, paper-card, toolbar.

**Commit:** `style(ui): shell and paper card hierarchy`

### 3. Reader chrome

PDF pane + mentor panel contrast; selection bar from 052 inherits.

**Commit:** `style(reader): pane elevation and header clarity`

### 4. Motion restraint

Keep existing `card-in`; do not add noisy transitions. Optional 150ms
hover on cards only.

## Verification

- Screenshots: light / sepia / dark × EN / AR for papers + reader +
  settings.
- Contrast test green.
- Sticky bar CDP probe still delta 0 if script exists.
- No return of search gray slab (051).

## Out of scope

- New illustration system.
- Redesigning the logo wordmark font stack.
- Changing to a different component library.

## Agent anti-patterns

- Do not set dark background to `#000000` and text to `#ffffff` only.
- Do not reintroduce physical `left`/`right` utilities.
- Do not “fix” by adding drop shadows everywhere — one soft level max
  if any.
