# Plan 051 — Kill the gray rectangle under the search field

**Priority:** P0 · **Effort:** S · **Depends on:** —

## Problem

On the main papers page, the search area (text field + field dropdown)
shows an ugly **gray rectangular band under the typed text** / under the
dropdown value. It looks broken, not intentional.

## Likely causes (inspect in order)

Agent must open the running app (or screenshots) and DevTools, then
confirm which of these is true:

1. **Nested muted surfaces** — a parent `bg-muted/20` or `bg-muted/40`
   wraps the search row while `Input` / `SelectTrigger` also use
   `dark:bg-input/30` or autofill gray → double muddy slab.
2. **Select value slot** — `SelectTrigger` styles force a blocky
   `select-value` flex child that reads as a gray chip under the label.
3. **Browser autofill** — WebView paints `input:-webkit-autofill` with a
   yellow/gray background that ignores Tailwind.
4. **Placeholder vs value stacking** — Radix Select placeholder and value
   both visible (layout bug).
5. **Underline / shadow-xs** looking like a bar on dark theme.

Primary files:

- `src/features/papers/papers-toolbar.tsx` (or search field inside
  `paper-list.tsx` if not extracted)
- `src/components/ui/input.tsx`
- `src/components/ui/select.tsx`
- `src/index.css`

## Target look

One continuous search control group:

```
[ 🔍  ______________ text ______________  ✕ ] [ Field ▾ ] [ Years ▾ ]
```

- Single border around the text field; transparent/clear field fill on
  light; subtle elevated fill on dark (**not** a second gray bar).
- Dropdown triggers: same height as input (`h-9`), **no** extra inner
  gray rectangle; only hairline border + chevron.
- Autofill styles overridden to match theme tokens.

## Work units

### 1. CSS autofill kill-switch

In `src/index.css`:

```css
input:-webkit-autofill,
input:-webkit-autofill:hover,
input:-webkit-autofill:focus {
  -webkit-text-fill-color: var(--foreground);
  transition: background-color 99999s ease-out;
  box-shadow: 0 0 0px 1000px var(--background) inset;
}
```

Use theme-aware background (light vs `.dark`).

### 2. Input + SelectTrigger alignment

- Input: `bg-transparent` in both themes for the papers search instance
  (override `dark:bg-input/30` via className on the search Input only if
  global change is too broad).
- SelectTrigger used next to search: pass `className` that sets
  `bg-transparent dark:bg-transparent shadow-none` and removes the
  muddy fill.
- Ensure `SelectValue` does not render with a background.

### 3. Toolbar structure

- Avoid wrapping the whole search row in `bg-muted/*`.
- Prefer `border bg-card` or bare transparent on the page background.
- Gap between controls with logical spacing only.

### 4. Visual regression check

- Screenshot EN light, EN dark, AR dark — search empty + with text +
  dropdown open.
- No gray slab under characters.

**Commits:**

1. `fix(ui): neutralize autofill and select fill on search chrome`
2. `fix(papers): simplify search toolbar surfaces (no nested muted slab)`

## Tests

- Component test: search input does not carry `dark:bg-input/30` when
  the transparent override is applied (class assertion), if practical.
- Prefer manual/CDP screenshot note in PR.

## Out of scope

- Full visual redesign (054).
- Search ranking (050).
