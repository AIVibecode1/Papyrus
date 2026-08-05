# Plan 044 — RTL / LTR experience + UI/UX fine-tune

**Priority:** P1 · **Effort:** M · **Depends on:** 040, 041, 042

## Problem

Papyrus already has `dir` switching, Arabic strings, and several
`dir="ltr"` islands for paper titles. Users still report that **design
needs precise tuning**, especially when mixing:

- RTL chrome (sidebar, toolbar, settings)
- LTR content (English titles, PDF, KaTeX, Mermaid, code)
- New surfaces from 041–042 (search modes, notes hub)

Round 3 plan 034 listed concrete items; this plan **absorbs** unfinished
034 work and extends it to new features.

## Product outcomes

1. Switching language never breaks focus order, overflow, or icon edges.
2. Search toolbar, year chips, notes hub, and reader notes are correct
   in both directions.
3. Contrast meets WCAG AA for muted text on card backgrounds for all
   three themes (light / sepia / dark).
4. Empty / loading / error states share one pattern.

## Non-negotiables

- Logical CSS properties only for directional layout.
- Paper titles, author lists (Latin), PDF, mermaid, katex, mono ids stay
  LTR islands.
- No raw hue utilities; tokens only.
- Do not rewrite copy for “marketing tone”; keep factual UI strings.

## Out of scope

- New illustration system or motion redesign.
- Changing the three-theme set.
- Full accessibility audit beyond focus rings and contrast listed here.

---

## Work unit 1 — Directional inventory script

Add a dev check (vitest or small node script under `dev/`) that fails if
`src/**/*.{tsx,css}` introduces:

- `\b(ml|mr|pl|pr|left|right)-` classnames (allowlist file comments for
  rare cases)
- `text-left` / `text-right` outside known LTR islands

Or document a manual grep gate in the plan verification section if a
script is too heavy. Prefer automated.

**Commit:** `test(rtl): fail on physical CSS direction utilities`

---

## Work unit 2 — Toolbar & search chrome (041 surfaces)

Verify and fix:

| Element | RTL expectation |
| ------- | --------------- |
| Search icon | `start` edge of field |
| Clear X | `end` edge |
| Mode select | opens with correct side (Radix `dir`) |
| Year chips | wrap with logical gaps |
| Day chevrons | visual direction follows browsing “older/newer”, not mirrored incorrectly — **product rule:** chevron that means “older” should point toward older in reading direction; document the choice and test both langs |
| Sort dropdown | `align="start"` relative to trigger |

**Commit:** `fix(rtl): search toolbar edges, menus, day chevrons`

---

## Work unit 3 — Notes hub & reader notes (042 surfaces)

- Note cards: quote block always `dir="ltr"` if Latin-heavy; body follows
  document dir.
- Delete / save buttons: logical placement.
- Empty states: icon + message + action centered without horizontal
  bias bugs.

**Commit:** `fix(rtl): notes hub and reader notes layout`

---

## Work unit 4 — Paper cards density (from 034)

- Title ~15px / leading-5 / two-line clamp
- Meta row uses `gap` + logical separators
- Abstract preview: 3-line clamp + soft fade mask (mask-image) instead
  of hard cut if feasible without new deps
- Focus-visible ring on clickable card

**Commit:** `style(papers): card density, clamp, focus ring`

---

## Work unit 5 — Contrast tokens

Compute contrast for `--muted-foreground` on `--card` / `--background`
for light, sepia, dark. Adjust token values in `index.css` until ≥ 4.5:1
for body-sized text.

Add a unit test that reads token values (or duplicated hex constants
used in the test) and asserts ratios with a small relative-luminance
helper.

**Commit:** `fix(a11y): raise muted contrast across themes + test`

---

## Work unit 6 — Empty / error / loading consistency

Shared small component or documented pattern:

```tsx
<StatePanel icon={...} title={...} description={...} action={...} />
```

Use in papers list, notes hub, settings key errors (where appropriate).

**Commit:** `refactor(ui): shared empty-error-loading StatePanel`

---

## Work unit 7 — i18n parity

Script or vitest: every key in `en.json` exists in `ar.json` with same
value type (string vs object). Fail CI if missing.

Fix any gaps introduced by 041–043.

**Commit:** `test(i18n): en/ar key parity assertion`

---

## Verification gates

- Full frontend + Rust gates
- Manual screenshots: EN light, AR dark, AR sepia — papers, search
  active, notes hub, reader
- Keyboard: tab through toolbar in AR without focus loss
- Contrast test green

## Commit strategy

Seven small commits as above. Do not squash into one mega style commit.

## Agent anti-patterns

- Do not mirror PDF content.
- Do not force Arabic font on Latin paper titles.
- Do not change i18n keys without updating both locale files.
- Do not use `transform: scaleX(-1)` on the whole app.
