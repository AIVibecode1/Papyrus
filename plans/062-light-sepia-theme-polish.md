# Plan 062 — Light & Sepia theme polish (surfaces, contrast, scrollbars)

**Priority:** P1 · **Effort:** M · **Depends on:** —

## Problem

Dark is acceptable. **Light** and **Sepia** still feel unfinished:

1. **Scrollbar** looks black / high-contrast on light and sepia → harsh UI.
2. **Surfaces** (cards, inputs, muted bars, side panels) do not always sit
   cleanly on `--background` — some elements feel glued-on or wrong-tint.
3. **Text contrast** needs another pass: body, muted, meta, placeholders
   on light/sepia backgrounds and on elevated cards.
4. Occasional hard-coded fills or non-token borders fight the warm palette.

Dark: **do not redesign**. Only touch dark if a shared rule (e.g. scrollbar
CSS) must apply to all three themes with theme tokens.

## Non-negotiables

- Keep the warm monochrome + single ink primary + soft blue accent system.
- All interactive chrome uses **CSS variables** (`--background`, `--card`,
  `--muted`, `--border`, `--foreground`, `--muted-foreground`, …).
- No pure `#000` / `#fff` scrollbars or chrome on light/sepia.
- WCAG AA: body text ≥ **4.5:1** on background and card; large/meta can
  be ≥ 3:1 only where already intentional — prefer ≥ 4.5 for muted too.
- EN + AR, both directions: scrollbars must not break RTL layout
  (`scrollbar-gutter` if used stays logical).
- pdf.js page canvas stays **paper-white** behind pages (existing rule);
  do not recolor PDF paint surface to sepia (reading accuracy).

## Current anchors (do not invent a parallel system)

| File | Role |
| ---- | ---- |
| `src/index.css` | `:root` (light), `[data-theme="sepia"]`, `.dark` tokens |
| `src/hooks/use-theme.ts` | `data-theme` + `.dark` class |
| Contrast unit test (tokens hex snapshots) | Update when values change |
| Components using `bg-background` / `bg-card` / `bg-muted` / `border-border` | Audit only |

## Work units

### WU1 — Theme-aware scrollbars (user-visible win)

In `src/index.css` `@layer base` (or a dedicated block after tokens):

```css
/* Firefox */
* {
  scrollbar-width: thin;
  scrollbar-color: var(--border) var(--background);
}

/* Chromium / WebView2 / Safari */
*::-webkit-scrollbar {
  width: 10px;
  height: 10px;
}
*::-webkit-scrollbar-track {
  background: var(--background);
}
*::-webkit-scrollbar-thumb {
  background: var(--border);
  border-radius: 999px;
  border: 2px solid var(--background); /* soft inset so thumb isn’t a black bar */
}
*::-webkit-scrollbar-thumb:hover {
  background: var(--muted-foreground);
  opacity: 0.45; /* or a dedicated --scrollbar-thumb-hover token */
}
```

Optional tokens (cleaner):

```css
:root, [data-theme="sepia"], .dark {
  --scrollbar-track: var(--background);
  --scrollbar-thumb: color-mix(in oklch, var(--foreground) 22%, var(--background));
  --scrollbar-thumb-hover: color-mix(in oklch, var(--foreground) 35%, var(--background));
}
```

Use these in `scrollbar-color` and webkit rules so light/sepia stay warm
and dark stays soft charcoal — never pure black thumb on bone paper.

Verify in **Windows WebView2** (user’s primary target): light, sepia, dark.

### WU2 — Light surface ladder (match dark’s clarity)

Dark already has elevation: `bg < card < popover`. Light is almost flat
(`background 0.968` / `card 0.988`) which can make cards dissolve **or**
make muted chrome look dirty if secondary/muted are too gray.

Goals for **light** (`:root`):

1. Clear but gentle ladder: background slightly warmer/dimmer than card.
2. `--border` / `--input` visible on both background and card (not
   vanishing, not heavy).
3. `--muted` and `--secondary` share the same warm hue family (hue ~85),
   not cool gray.
4. `--foreground` strong enough for titles; `--muted-foreground` AA on
   both surfaces.

Suggested direction (tune by eye + contrast test, not copy blindly):

| Token | Intent |
| ----- | ------ |
| `--background` | Soft bone canvas |
| `--card` / `--popover` | Slightly higher L, same hue — readable panels |
| `--muted` | Chip/toolbar wells, still warm |
| `--border` | Hairline that reads on both bg and card |
| `--muted-foreground` | ≥ 4.5:1 on card **and** background |

### WU3 — Sepia pass (same rules, warmer ink)

Sepia must feel **aged paper + brown ink**, not “light with a yellow filter.”

1. Align hue family (~55–80) across bg, card, muted, border.
2. `--foreground` / `--primary` slightly brown-ink, not pure near-black
   that fights the paper.
3. Borders: warm brown-gray at low chroma — no cool gray lines.
4. Accent may stay soft blue **or** shift slightly toward muted teal/ink
   if blue looks neon on paper; keep one accent only.
5. Scrollbar tokens inherit automatically if WU1 uses variables.

### WU4 — Component / hardcoded audit

Search and fix mismatches (prefer tokens):

- `bg-black`, `bg-white`, `text-black`, `text-white`, `#000`, `#fff` in
  UI chrome (not PDF canvas).
- Opacity stacks like `bg-background/80` that go muddy on sepia.
- Inputs: `dark:bg-input/30` style rules that leave light/sepia inputs
  looking like empty holes or wrong gray — ensure light/sepia inputs use
  `bg-transparent` or `bg-card` consistently with borders.
- Skeleton, select dropdown, scroll areas, paper list, sidebar, reader
  chrome, settings cards.

Do **not** restyle markdown content colors beyond token mapping.

### WU5 — Contrast tests update

Update the theme token snapshot / contrast test so light + sepia
`muted-foreground` vs `background` and `card` stay ≥ 4.5:1 after the
retune. If you change oklch values, recompute hex snapshots used in the
test (same approach as existing test).

### WU6 — Visual gate

Manual or CDP screenshots (if scripts exist):

| Surface | Themes |
| ------- | ------ |
| Papers feed + search | light, sepia (dark optional regression) |
| Reader split | light, sepia |
| Settings | light, sepia |
| History / notes if visible | light, sepia |

Check: scrollbar color, card edges, meta text, placeholder text, focus
rings still visible.

## Out of scope

- New fourth theme
- Changing font stack
- PDF page background → sepia (keep white paper for fidelity)
- Dark full redesign
- Motion / layout redesign

## Commits

1. `fix(ui): theme-aware scrollbars for light, sepia, and dark`
2. `fix(ui): retune light and sepia surface tokens and borders`
3. `fix(ui): replace hard-coded chrome colors with theme tokens`
4. `test(ui): refresh contrast snapshots for light and sepia`

## DoD

- [ ] Light scrollbar is soft (track ≈ background, thumb ≈ border/muted), not black
- [ ] Sepia scrollbar matches paper tones
- [ ] Dark scrollbar still acceptable (no regression to pure black bar on charcoal)
- [ ] Cards/inputs/side chrome sit on background without gray “slabs”
- [ ] Title + body + muted text pass contrast checks on light and sepia
- [ ] `tsc` / eslint / unit tests green
- [ ] Quick visual pass EN light, EN sepia, AR sepia (RTL)

## Agent anti-patterns

- Do not set `color-scheme: dark` on light or sepia (that encourages dark scrollbars).
- Do not use `scrollbar-color: black transparent`.
- Do not “fix” by only changing one component class while tokens stay wrong.
- Do not weaken dark elevation ladder while fixing light.
