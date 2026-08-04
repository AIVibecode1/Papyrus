# Plan 028: Design cleanup — palette, focus rings, ARIA, and typography

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check**: `git diff --stat 7e26e2d..HEAD -- src/features/ src/components/ src/index.css`

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none
- **Category**: tech-debt
- **Planned at**: commit `7e26e2d`, 2026-08-04

## Why this matters

The design system is strong (warm OKLCH palette, bundled Geist fonts,
tabular-nums, skip link) but has 10 targeted gaps that undermine the
premium feel: raw amber and emerald colors break the monochrome palette
on three surfaces, plain buttons lack focus rings (WCAG 2.4.7), the
top bar and content widths mismatch, ARIA semantics are wrong on tabs
and navigation, dark-mode borders are too faint, and markdown headings
lack hierarchy. All fixes are within the existing system — no rewrite.

## Current state

- `src/features/papers/paper-list.tsx:275,315,317` — raw amber classes
  (`border-amber-300/60`, `bg-amber-50`, `text-amber-600`)
- `src/features/settings/provider-card.tsx:145` — raw emerald
  (`text-emerald-600 dark:text-emerald-400`)
- `src/components/layout/top-bar.tsx:17` — `max-w-5xl` (1024px)
- `src/App.tsx:39` — `max-w-6xl` (1152px) — mismatch
- `src/features/papers/sidebar.tsx:18-32` — plain `<button>`, no
  `focus-visible:ring`
- `src/components/layout/top-bar.tsx:33-46` — plain `<button>` language
  toggle, no focus ring
- `src/features/papers/today-picks.tsx:51-63` — plain `<button>` pick
  tiles, no focus ring
- `src/features/reader/reader-view.tsx:392,401` — `aria-pressed` on tabs
  (should be `role="tab"` + `aria-selected`)
- `src/features/papers/sidebar.tsx:29` — `aria-pressed` on nav (should
  be `aria-current`)
- `src/index.css:182` — dark-mode `--border` at 12% opacity
- `src/components/markdown/markdown.tsx:73-76` — h1 at `text-lg` (18px)

Conventions: CSS uses Tailwind v4 with OKLCH custom properties defined
in `src/index.css`. Themes: light/sepia/dark via `data-theme` + `.dark`.
The design system says "the only color allowed is the desaturated pastel
blue accent plus semantic red for destructive."

## Commands you will need

| Purpose   | Command                 | Expected on success |
| --------- | ----------------------- | ------------------- |
| Typecheck | `pnpm run typecheck`    | exit 0              |
| Tests     | `pnpm test`             | all pass            |
| Lint      | `pnpm run lint`         | exit 0              |
| Format    | `pnpm run format:check` | all matched         |

## Scope

**In scope**:

- `src/features/papers/paper-list.tsx`
- `src/features/settings/provider-card.tsx`
- `src/components/layout/top-bar.tsx`
- `src/features/papers/sidebar.tsx`
- `src/features/papers/today-picks.tsx`
- `src/features/reader/reader-view.tsx`
- `src/App.tsx`
- `src/index.css`
- `src/components/markdown/markdown.tsx`
- `src/components/ui/card.tsx`

**Out of scope**:

- `src/components/ui/select.tsx` and other shadcn base components
- Any Rust file
- The PDF viewer (plan 025)

## Git workflow

- Branch: `advisor/028-design-cleanup`
- Conventional commits: `style: ...` or `fix(a11y): ...`

## Steps

### Step 1: Replace amber and emerald with palette tokens

In `paper-list.tsx`:

- Line 275: replace the amber classes with `border-border bg-secondary text-secondary-foreground`. Replace `text-amber-600 dark:text-amber-400` (line 317) with `text-muted-foreground`. Replace `text-amber-900 dark:text-amber-200` with `text-foreground`.
- Line 315: replace `border-amber-300/60 dark:border-amber-500/30` with `border-border`.

In `provider-card.tsx`:

- Line 145: replace `text-emerald-600 dark:text-emerald-400` with `text-primary`. The success is conveyed by the `CheckCircle2` icon (already imported) in the ink color.

**Verify**: `pnpm run typecheck` → exit 0

### Step 2: Add focus-visible rings to plain buttons

Add `focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:border-ring` to:

- `sidebar.tsx:18-32` — category buttons
- `top-bar.tsx:33-46` — language toggle buttons
- `today-picks.tsx:51-63` — pick tile buttons

**Verify**: `pnpm run typecheck` → exit 0, `pnpm test` → all pass

### Step 3: Align top bar and content max-width

Change `top-bar.tsx:17` from `max-w-5xl` to `max-w-6xl` to match
`App.tsx:39`.

**Verify**: `pnpm test` → all pass

### Step 4: Fix ARIA semantics on tabs and navigation

In `reader-view.tsx`:

- Add `role="tablist"` to the container div (line ~387).
- Change `aria-pressed` to `role="tab" aria-selected={tab === "walkthrough"}` (line 392) and `role="tab" aria-selected={tab === "ask"}` (line 401).
- Add `role="tabpanel"` to the content containers below.

In `sidebar.tsx:29`:

- Replace `aria-pressed={category === cat.code}` with `aria-current={category === cat.code ? "true" : undefined}`.

In `top-bar.tsx:43`:

- Replace `aria-pressed={i18n.language === lang.code}` with `aria-current={i18n.language === lang.code ? "true" : undefined}`.

Update any tests that assert `aria-pressed` on these elements to assert the new attributes instead.

**Verify**: `pnpm test` → all pass, `pnpm run lint` → exit 0

### Step 5: Tighten dark-mode border opacity and card radius

In `src/index.css:182`, increase the dark-mode `--border` opacity from
12% to 18%:

```
--border: oklch(0.93 0.004 80 / 18%);
```

In `src/index.css:183`, increase `--input` to match:

```
--input: oklch(0.93 0.004 80 / 20%);
```

In `src/components/ui/card.tsx:10`, change `rounded-xl` to `rounded-lg`.

**Verify**: `pnpm run typecheck` → exit 0, `pnpm test` → all pass

### Step 6: Increase markdown h1 size for hierarchy

In `src/components/markdown/markdown.tsx:73`, change h1 from `text-lg`
to `text-xl`. Change h2 (if present) from `text-base` to `text-lg`.

**Verify**: `pnpm test` → all pass

## Done criteria

- [ ] `pnpm run typecheck` exits 0
- [ ] `pnpm test` exits 0
- [ ] `pnpm run lint` exits 0
- [ ] `pnpm run format:check` passes
- [ ] No raw `amber-` or `emerald-` classes remain in the codebase
- [ ] No `aria-pressed` on tab or navigation elements
- [ ] No files outside the in-scope list are modified
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report if:

- Removing amber causes the fallback banner to be invisible in a
  specific theme (test all three: light, sepia, dark).
- A test explicitly depends on `aria-pressed` and cannot be migrated
  to `aria-selected`/`aria-current` without a larger refactor.
- The card radius change breaks a snapshot test.

## Maintenance notes

- If a new semantic state color is needed (warning, info), introduce a
  CSS token instead of a raw Tailwind color class.
- The `role="tablist"` pattern should be applied to any future tab-like
  UI (e.g. a reader view with multiple tabs).
