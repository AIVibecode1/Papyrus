# Plan 063 — Center search bar in AR/RTL (maximized window)

**Priority:** P1 · **Effort:** S · **Depends on:** —

## Problem

On **Arabic (RTL)**, when the window is **maximized**, the papers search bar
sits on a **corner** instead of staying **centered** like English (LTR).

Screenshots (user): EN search ~center; AR search pinned to the side.

## Root cause

`src/features/papers/papers-toolbar.tsx` top row:

```tsx
<div className="flex flex-wrap items-center justify-between gap-3">
  <div>{/* status: updated / search status */}</div>
  <PapersSearchField ... />  {/* child has w-full max-w-md */}
  <div>{/* Saved / History / Refresh */}</div>
</div>
```

`PapersSearchField` root (`papers-search-field.tsx`):

```tsx
className="flex h-9 w-full max-w-md items-center ..."
```

Issues:

1. **`w-full`** on the search field inside a `flex-wrap` + `justify-between`
   row makes the item fight for full row width and **wrap** unpredictably
   when the window is wide or side labels differ in length (AR vs EN).
2. After wrap (or with uneven side widths), the search aligns to the flex
   **start edge** — in RTL that reads as “stuck in the corner,” not centered.
3. `justify-between` never truly centers the middle control when left/right
   clusters have different widths (common in AR: longer status strings).

Dark/light/sepia are unrelated; this is layout only.

## Goal

In **LTR and RTL**, at normal and maximized widths:

- Search field stays **optically centered** in the toolbar content width.
- Status stays on the **inline-start** side.
- Saved / History / Refresh stay on the **inline-end** side.
- No horizontal overflow; search still `max-w-md`.
- Day picker / year chips row below unchanged.

## Recommended fix (prefer grid)

Replace the top `flex flex-wrap justify-between` row with a **3-column grid**
that is direction-aware via logical properties:

```tsx
<div className="grid grid-cols-1 items-center gap-3 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]">
  {/* Start cluster */}
  <div className="min-w-0 sm:justify-self-start">
    {/* status text + optional citation notes */}
  </div>

  {/* Center: search */}
  <div className="w-full max-w-md justify-self-center sm:w-[min(100%,28rem)]">
    <PapersSearchField ... />
  </div>

  {/* End cluster */}
  <div className="flex flex-wrap items-center gap-2 sm:justify-self-end">
    {/* Saved / History / Refresh */}
  </div>
</div>
```

Then in `papers-search-field.tsx` change root width from `w-full max-w-md`
to **`w-full` only** (parent already caps width), or `w-full max-w-md` but
**remove the need for the field to size the flex row alone**.

### Alternative (absolute center)

```tsx
<div className="relative flex min-h-9 items-center justify-center">
  <div className="absolute inset-inline-start-0 ...">status</div>
  <PapersSearchField className="relative z-10 w-full max-w-md" />
  <div className="absolute inset-inline-end-0 ...">actions</div>
</div>
```

Use only if grid conflicts with citation status chips; grid is preferred
(fewer overlap bugs on small widths).

## Narrow screens

`grid-cols-1` stacks: status → search → actions (acceptable). Do not keep
a broken single-row wrap that pins search to a corner.

## Files

| File | Change |
| ---- | ------ |
| `src/features/papers/papers-toolbar.tsx` | Top row → 3-col grid (or absolute center) |
| `src/features/papers/papers-search-field.tsx` | Width: parent-controlled; avoid `w-full` breaking siblings |
| Optional test / note in existing toolbar test if any | Assert structure classes |

## Out of scope

- Theme tokens / scrollbars (plan 062)
- Changing search field internals (field select, sort)
- Redesigning day picker row

## Verify

1. EN maximized → search centered.
2. AR maximized → search centered (not corner).
3. AR + EN at ~900px width → no overflow, usable stack.
4. Toggle Saved / History → layout stable.
5. Long AR status string (`آخر تحديث …`) does not shove search off-center.

## Commit

`fix(ui): center papers search bar in RTL maximized layout`
