# Plan 002: Component tests for the reader surfaces

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 692c0d0..HEAD -- src/features/reader src/components/pdf-viewer`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none
- **Category**: tests
- **Planned at**: commit `692c0d0`, 2026-08-03

## Why this matters

The two largest UI surfaces — the PDF viewer (`pdf-viewer.tsx`, ~545 lines)
and the reader screen (`reader-view.tsx`, ~400 lines) — have zero component
tests. All their wiring (keyboard shortcuts, reading-position restore, the
selection chip with copy fallback, the pinned ask input, tab switching) is
verified only by manual browser sessions. The recent history proves the
cost: the chunk-flush bug and the message-id collision both lived in store
logic that tests eventually covered, but UI-wiring regressions (wrong
aria-labels, shortcuts firing while typing, the copy button not flipping
state) would ship silently. The test infrastructure already exists
(`@testing-library/react` + jsdom) and is used once (`markdown.test.tsx`);
this plan applies it to the reader surfaces.

## Current state

- `src/features/reader/reader-view.tsx` — the reader screen: header with
  back button (`ArrowLeft` + `rtl:rotate-180`), PDF viewer area, AI panel
  with tabs (walkthrough / ask), selection chip at the panel top
  (`reader.selection` drives it), pinned ask input at the bottom.
- `src/components/pdf-viewer/pdf-viewer.tsx` — pdf.js v6 viewer. Pure
  helpers are already exported for tests:
  ```ts
  export function escapeHtml(text: string): string { ... }   // line 57
  export function highlightSpan(span: HTMLElement, query: string): number { ... } // line 69
  ```
  (these already have coverage in the parser tests — do not duplicate).
  The component itself depends on `pdfjs-dist` (canvas rendering, workers).
- `src/stores/reader.ts` — Zustand store driving both; component tests
  should mock the store's selectors via `useReaderStore` (see the store's
  existing `src/stores/__tests__/reader.test.ts` for the mock pattern).
- Exemplar component test to model after: `src/components/markdown/__tests__/markdown.test.tsx`
  (renders a component, asserts on screen queries, uses `fireEvent`).

Repo conventions: tests live next to the code in `__tests__/` folders;
store tests use `vi.mock` of `@/lib/*` modules; jsdom environment is
configured in the vitest config (the markdown test already runs under it).

## Commands you will need

| Purpose        | Command                                                                   | Expected on success |
| -------------- | ------------------------------------------------------------------------- | ------------------- |
| Tests          | `pnpm exec vitest run`                                                    | all pass            |
| Tests (single) | `pnpm exec vitest run src/features/reader/__tests__/reader-view.test.tsx` | new tests pass      |
| Typecheck      | `pnpm exec tsc --noEmit`                                                  | exit 0              |
| Lint           | `pnpm exec eslint .`                                                      | exit 0              |
| Format         | `pnpm exec prettier --check .`                                            | all files match     |

## Scope

**In scope** (the only files you should modify):

- `src/features/reader/__tests__/reader-view.test.tsx` (create)
- `src/components/pdf-viewer/__tests__/pdf-viewer.test.tsx` (create)
- `src/components/pdf-viewer/pdf-viewer.tsx` (ONLY if a small refactor is
  needed to make the component testable — e.g. accepting an injected
  `renderFn` or exporting the keyboard handler; keep it minimal)
- `plans/README.md` (status row)

**Out of scope** (do NOT touch):

- `src/stores/reader.ts` and its tests — store logic is already covered.
- The pdf.js rendering internals — do not test canvas pixels.
- `dev/mock-ai-server.mjs` — covered by plan 007.

## Git workflow

- Branch: `advisor/002-component-tests-reader-surfaces`
- Commit style: `test: cover reader view and PDF viewer wiring with component tests`
- Do NOT push unless the operator instructed it.

## Steps

### Step 1: reader-view component test

Create `src/features/reader/__tests__/reader-view.test.tsx` that renders
`<ReaderView />` with the real `useReaderStore` (seed state via
`useReaderStore.setState`), mocking `@/lib/pdf` and `@/lib/pdf-text` if the
PDF load path runs (or seed `loadStatus: "ready"` + `pdfBytes` with a tiny
byte array and mock the extraction module). Cover:

1. Header renders the back button with `aria-label="Back to papers"`
   (localized: assert via the i18n value or the key `reader.back`); clicking
   it calls `setView("papers")`.
2. Selection chip appears when `reader.selection` is set: shows the text,
   has a button with `aria-label` matching `reader.copySelection`; clicking
   it flips the label to `reader.copied` and back after the timeout
   (use `vi.useFakeTimers()`).
3. Clear-selection button calls `clearSelection` and the chip disappears.
4. Ask tab: switch to the Ask tab, type in the input, press Enter →
   `reader.ask` was called (mock the store's `ask` via
   `vi.spyOn(useReaderStore.getState(), "ask")`).
5. Walkthrough tab shows "Explain the whole paper" button when sections
   exist and no entries yet; clicking it calls `startWalkthrough`.

For each case, assert with `screen` queries (getByRole / getByLabelText),
not class names.

**Verify**: `pnpm exec vitest run src/features/reader/__tests__/reader-view.test.tsx` → all pass.

### Step 2: pdf-viewer keyboard-shortcut test

Create `src/components/pdf-viewer/__tests__/pdf-viewer.test.tsx`. Mock
`pdfjs-dist` (the module used at import time) with a minimal fake document
so the component mounts without a real PDF: mock `getDocument` to return a
loading task whose `promise` resolves to `{ numPages: 3, getPage: ..., getOutline: ... }`,
and mock the `TextLayer` class. Then cover:

1. Pressing `ArrowRight` on `window` while the container has focus (dispatch
   a `KeyboardEvent` with `{ key: "ArrowRight", bubbles: true }` on
   `window`) advances the page indicator (assert the "N / 3" text).
2. Pressing `ArrowLeft` goes back.
3. Typing in a real `<input>` (focus a rendered input and dispatch the
   event on it) does NOT change the page (the typing guard).
4. `Ctrl+F` opens the find bar (the search input becomes visible with
   `autoFocus`); `Escape` closes it.
5. `highlightSpan`/`escapeHtml` pure behaviors: assert `<mark>` wrapping and
   escaping of `<`, `>`, `&`, `"` (these exist in parser tests — only add if
   not already covered; check `src/lib/__tests__/ai-parser.test.ts` first).

If mounting the full component with a fake pdf.js is not feasible in the
time budget, fall back to exporting and testing the `onKeyDown` handler
logic as a pure function — but prefer the component-level test.

**Verify**: `pnpm exec vitest run src/components/pdf-viewer/__tests__/pdf-viewer.test.tsx` → all pass.

### Step 3: full suite

**Verify**:

1. `pnpm exec vitest run` → all tests pass (94 + new)
2. `pnpm exec tsc --noEmit` → exit 0
3. `pnpm exec eslint .` → exit 0
4. `pnpm exec prettier --check .` → all files match

## Test plan

- New files: the two test files above.
- Pattern to model after: `src/components/markdown/__tests__/markdown.test.tsx`
  (rendering + screen queries) and `src/stores/__tests__/reader.test.ts`
  (store seeding/mocking).
- Fake timers for the copy-confirmation timeout (`vi.useFakeTimers` +
  `vi.advanceTimersByTime(1600)`).

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `src/features/reader/__tests__/reader-view.test.tsx` exists and passes
- [ ] `src/components/pdf-viewer/__tests__/pdf-viewer.test.tsx` exists and passes
- [ ] `pnpm exec vitest run` → all pass; test count grew by the new tests
- [ ] `pnpm exec tsc --noEmit` and `pnpm exec eslint .` exit 0
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The reader-view or pdf-viewer source no longer matches the described
  structure (drift since `692c0d0`).
- Mocking `pdfjs-dist` proves impossible with vitest/jsdom (module
  resolution error that resists one reasonable fix attempt) — report the
  exact error and the alternative (pure-handler tests) instead of fighting it.
- A test requires changing store behavior to pass — that is a product
  change, out of scope.

## Maintenance notes

- When the reader UI changes (new buttons, new tabs), extend these files;
  they are the regression net for all reader wiring.
- The pdf.js mock in Step 2 will need updating when `pdfjs-dist` bumps
  major versions (the API shape changes between majors).
- Reviewer focus: the fake pdf.js document must stay minimal — a full fake
  that grows with the real API becomes maintenance debt itself.
