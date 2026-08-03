# Plan 015: Harden reader rendering and preserve the user’s split

> **Executor instructions**: Follow this plan step by step. Run every verification command. If a STOP condition occurs, stop and report; do not improvise.
>
> **Drift check**: `git diff --stat 7af8261..HEAD -- src/components/pdf-viewer/pdf-viewer.tsx src/features/reader/reader-view.tsx src/components/markdown/markdown.tsx`

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: correctness | performance | tests
- **Planned at**: commit `7af8261`, 2026-08-04

## Why this matters

The PDF reader is the product’s most complex interactive surface: it combines pdf.js canvases, text layers, resize observers, zoom state, selection, and a streaming AI panel. Recent fixes improved it, but the current design still needs characterization tests for the resize/zoom/render state machine and for malformed/zero-size pages. Without these tests, a future change can reintroduce black pages or make the split jump while streaming.

## Current state

- `src/components/pdf-viewer/pdf-viewer.tsx:30-55` renders several pages concurrently and catches per-page failures.
- `src/components/pdf-viewer/pdf-viewer.tsx:220-323` tracks render tasks, cancels them on scale changes, and observes the container only after `pages.length` is non-zero.
- `src/components/pdf-viewer/pdf-viewer.tsx:451-461` renders only a loading status before pages exist, which explains why the observer must be keyed to page readiness.
- `src/features/reader/reader-view.tsx:281-323` uses explicit flex-basis values for the PDF pane and AI aside; the aside must retain `min-w-0`.
- `src/features/reader/reader-view.tsx:166-183` derives busy/walkthrough state from streaming entries.
- Existing viewer tests are in `src/components/pdf-viewer/__tests__/pdf-viewer.test.tsx`; reader view tests are in `src/features/reader/__tests__/reader-view.test.tsx`.

## Commands you will need

| Purpose       | Command                                                                                                       | Expected |
| ------------- | ------------------------------------------------------------------------------------------------------------- | -------- |
| Viewer tests  | `pnpm exec vitest run src/components/pdf-viewer/__tests__/pdf-viewer.test.tsx`                                | all pass |
| Reader tests  | `pnpm exec vitest run src/features/reader/__tests__/reader-view.test.tsx src/stores/__tests__/reader.test.ts` | all pass |
| Full frontend | `pnpm run typecheck && pnpm run lint && pnpm run test && pnpm run format:check`                               | all pass |

## Scope

**In scope**:

- `src/components/pdf-viewer/pdf-viewer.tsx`
- `src/components/pdf-viewer/__tests__/pdf-viewer.test.tsx`
- `src/features/reader/reader-view.tsx`
- `src/features/reader/__tests__/reader-view.test.tsx`
- `src/stores/reader.ts` and its tests only when required to preserve the state contract

**Out of scope**:

- Changing the PDF download security policy
- Replacing pdf.js
- New animation or visual redesign unrelated to reader stability
- Changing the public Paper type

## Steps

### Step 1: Characterize rendering state transitions

Add tests for: initial loading-to-ready observer attachment, resize after pages are ready, manual zoom followed by resize preserving scale, cancellation of an in-flight render, a rejected render continuing other pages, and zero-size/invalid page handling. Use the existing pdf.js mock; do not download live PDFs in unit tests.

**Verify**: targeted viewer tests pass and cover the named transitions.

### Step 2: Make render cancellation explicit and idempotent

Ensure a render task is cancelled at most once, stale text layers cannot overwrite a newer layer, and cleanup runs on unmount as well as scale changes. Keep the concurrency cap bounded and preserve stable page indexes.

**Verify**: targeted viewer tests pass repeatedly (run the file 5 times) with no order-dependent failures.

### Step 3: Characterize split stability during streaming

Add a reader-view test that mounts the desktop split, injects a long unbreakable explanation token while the walkthrough is busy, and asserts the AI pane retains its flex-basis/min-width constraints. Add a test that Continue and Regenerate are mutually clear and that Regenerate replaces the current section entry rather than appending one.

**Verify**: `pnpm exec vitest run src/features/reader/__tests__/reader-view.test.tsx src/stores/__tests__/reader.test.ts` → pass.

### Step 4: Verify RTL and narrow-window behavior

Use the existing i18n test patterns to verify reader toolbar labels, split separator, arrows, and the pinned Ask input remain usable in Arabic and at a narrow viewport. Prefer logical classes and `dir` attributes; do not add physical `left/right` layout rules.

**Verify**: full frontend gates pass.

## Test plan

- Viewer: resize observer lifecycle, render cancellation, concurrent queue, failure isolation, zero-size page.
- Reader: split width under streamed content, Continue/Regenerate state, Arabic labels and keyboard behavior.
- Run targeted tests repeatedly to expose race/order issues.

## Done criteria

- [ ] Every render state transition has a deterministic unit test.
- [ ] A rejected/cancelled page cannot stop unrelated pages from rendering.
- [ ] Manual zoom is preserved through container resize.
- [ ] AI streaming cannot change the persisted split ratio.
- [ ] Arabic and narrow viewport tests pass.
- [ ] Full frontend gates pass and only scoped files change.

## STOP conditions

- The pdf.js mock cannot represent cancellation or rejected render tasks without changing the test harness substantially; report before changing dependencies.
- The split cannot be asserted without browser layout measurement; add a focused browser/DOM test plan rather than weakening the assertion.
- A fix requires changing persisted storage keys or the public Paper shape.

## Maintenance notes

Any future PDF virtualization, page-windowing, or zoom feature must preserve the render-generation token and cancellation contract. Review all changes to `ResizeObserver`, `renderTasksRef`, and the explicit flex-basis styles together.

## Related design direction

The existing README describes the reader as a central feature and the roadmap contains curated selection work. Keep the reader’s visual language editorial and restrained: no generic dashboard cards, no decorative gradients, and no motion that hides loading or error state.
