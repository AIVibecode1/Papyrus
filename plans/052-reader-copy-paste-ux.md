# Plan 052 — PDF reader copy / paste that feels native

**Priority:** P1 · **Effort:** M · **Depends on:** —

## Problem

Copying text from the in-app PDF reader is awkward. Users expect
browser-like select → Ctrl/Cmd+C (or right-click Copy). Today the flow
centers on a **toolbar “Copy selection”** button after the reader store
captures selection, with a 500ms clipboard race and silent failures.

## Current path (read these)

- `src/components/pdf-viewer/pdf-viewer.tsx` — pdf.js `TextLayer`,
  selection detection into reader store
- `src/features/reader/reader-view.tsx` — `handleCopySelection`
- `src/stores/reader.ts` — `selection` string

## Goals

1. **Ctrl/Cmd+C** copies the current PDF selection when focus is in the
   viewer (not when typing in chat/notes).
2. **Right-click context menu** on a selection: Copy (and existing
   highlight action if present).
3. Selection stays visible while the user hits the shortcut (text layer
   must not clear selection on button focus steals — prefer keyboard
   path that does not blur).
4. Clear feedback: toast or brief “Copied” on the selection floating
   bar, not only a toolbar icon swap.
5. Multi-page selection: best-effort; if pdf.js only gives one page,
   document limit — still copy what is selected.

## Work units

### 1. Floating selection bar (near selection or top of PDF pane)

When `reader.selection` is non-empty:

```
[ Copy ]  [ Highlight ]  [ Ask ]?
```

- Position: sticky under the PDF toolbar **or** a compact floating bar
  above the bottom of the PDF pane (do not cover the text).
- Copy calls the same robust clipboard helper.
- Does not require hunting for a header icon.

### 2. Keyboard

In pdf-viewer or reader-view keydown handler:

- If selection non-empty and not typing in input → Ctrl/Cmd+C →
  `preventDefault` + copy helper.
- Escape clears selection (optional, if it does not break find-in-page).

### 3. Clipboard helper module

Extract `copyTextToClipboard(text: string): Promise<boolean>` in
`src/lib/clipboard.ts`:

1. `navigator.clipboard.writeText`
2. Fallback textarea + `execCommand('copy')`
3. Return success boolean; UI shows failure string if false

Increase timeout if 500ms is too aggressive on slow Windows webviews
(e.g. 1500ms) but always resolve.

### 4. Text layer CSS

Ensure `.textLayer` allows selection:

- `user-select: text`
- spans not `pointer-events: none` incorrectly after paint
- Selection color uses theme `::selection` (already global)

Fix any overlay (canvas vs textLayer z-index) that makes dragging
feel “stuck.”

### 5. Tests

- Unit: clipboard helper fallback path with mocks.
- Component: with selection set, Copy button invokes helper.
- Keyboard test if jsdom allows.

**Commits:**

1. `feat(reader): clipboard helper + floating selection actions`
2. `feat(reader): Ctrl/Cmd+C copies PDF selection`
3. `fix(pdf): text layer selection hit-testing / user-select`

## Out of scope

- Editing the PDF.
- Paste into PDF.
- OCR for scanned pages (no text layer).

## Agent anti-patterns

- Do not remove the header Copy control until the floating bar works.
- Do not use Tauri clipboard plugins unless web clipboard fails in
  production WebView2 **and** a spike proves need.
