# Plan 004: Bound PDF rendering work (render queue)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 692c0d0..HEAD -- src/components/pdf-viewer`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S (quick win) — full virtualization is explicitly out of scope
- **Risk**: MED
- **Depends on**: plan 002 (its pdf-viewer test pins the keyboard/page
  behavior this plan must not break)
- **Category**: perf
- **Planned at**: commit `692c0d0`, 2026-08-03

## Why this matters

`PdfViewer` renders EVERY page's canvas and text layer immediately on open
and re-renders ALL pages on every zoom change (`pdf-viewer.tsx:150-215`).
Real papers are 70+ pages (observed: 73). Opening such a paper spawns 73
canvas renders + 73 text layers synchronously in a tight loop, and each
zoom step repeats it. On slower machines this is a multi-second UI stall
with a full CPU burst. A render queue that renders pages sequentially
(one at a time, keeping the loop) bounds the burst without changing the
architecture; near-viewport prioritization is a documented future step,
not part of this plan.

## Current state

- `src/components/pdf-viewer/pdf-viewer.tsx:150-215` — the scale effect:
  ```ts
  useEffect(() => {
    const views = viewportsRef.current;
    if (views.length === 0) return;
    const timer = setTimeout(() => {
      void (async () => {
        const next = views.map(({ page }) => ({ page, viewport: page.getViewport({ scale }) }));
        viewportsRef.current = next;
        setPages(next);
        for (let i = 0; i < next.length; i += 1) {
          await renderPage(next[i].page, i, next[i].viewport);
        }
      })();
    }, 150);
    return () => clearTimeout(timer);
  }, [scale]);
  ```
  The initial open path (the load effect, ~line 130-148) uses the same
  sequential `for` loop over all pages.
- `renderPage` (line ~163-190) renders the canvas, then builds the text
  layer, then re-applies search highlights.

## Commands you will need

| Purpose   | Command                        | Expected on success |
| --------- | ------------------------------ | ------------------- |
| Tests     | `pnpm exec vitest run`         | all pass            |
| Typecheck | `pnpm exec tsc --noEmit`       | exit 0              |
| Lint      | `pnpm exec eslint .`           | exit 0              |
| Format    | `pnpm exec prettier --check .` | all files match     |
| Build     | `pnpm exec vite build`         | exit 0              |

## Scope

**In scope**:

- `src/components/pdf-viewer/pdf-viewer.tsx` (the two render loops)
- `src/components/pdf-viewer/__tests__/pdf-viewer.test.tsx` (extend if the
  plan-002 file exists; otherwise create a small test for the queue helper)
- `plans/README.md` (status row)

**Out of scope**:

- Virtualized rendering (render only pages near the viewport) — documented
  as a future step in Maintenance notes; it changes scroll behavior and
  needs its own plan.
- Changing zoom behavior, the 150 ms debounce, or the pdf.js API usage.
- `src/lib/pdf-text.ts` extraction path.

## Git workflow

- Branch: `advisor/004-pdf-render-queue`
- Commit style: `perf: render PDF pages through a sequential queue`
- Do NOT push unless the operator instructed it.

## Steps

### Step 1: Extract a render-queue helper

Add a small module-level helper in `pdf-viewer.tsx` (or a new
`src/components/pdf-viewer/render-queue.ts` if it grows):

```ts
/** Renders pages one at a time; a cancelled run stops scheduling. */
async function renderInQueue(
  pages: PageView[],
  render: (page: PageView, index: number) => Promise<void>,
  isCancelled: () => boolean,
): Promise<void> {
  for (let i = 0; i < pages.length; i += 1) {
    if (isCancelled()) return;
    await render(pages[i], i);
  }
}
```

The cancellation check must run BEFORE each render so a zoom change (which
clears the previous run's cancellation flag) stops the old loop immediately
instead of finishing all 73 pages.

### Step 2: Use the queue in both loops

- Load effect: call `renderInQueue(views, renderPage, () => cancelled)`
  where `cancelled` is the existing load-effect flag (it already exists in
  the load effect; the scale effect has no flag today — add one).
- Scale effect: set `renderRunRef.current = true` at the start of the
  debounced task and `false` on cleanup; the queue's `isCancelled` reads it.
  Keep the existing 150 ms debounce and the `setPages(next)` call BEFORE the
  queue starts (the layout must update immediately, rendering follows).

**Verify**: `pnpm exec tsc --noEmit` → exit 0.

### Step 3: Test the queue

If plan 002 landed, extend `pdf-viewer.test.tsx`; otherwise create
`src/components/pdf-viewer/__tests__/pdf-viewer.test.tsx` with a minimal
fake pdf.js document (see plan 002 Step 2 for the mock shape) and assert:

1. With N pages, the fake render function is called exactly N times in
   order (a `renderCalls: number[]` spy).
2. When the cancellation flag flips after 2 renders, the loop stops and the
   third page is never rendered.
3. A zoom change mid-render cancels the previous run and starts a new one
   (renderCalls reset).

**Verify**: `pnpm exec vitest run src/components/pdf-viewer/__tests__/pdf-viewer.test.tsx` → all pass.

### Step 4: Full suite

**Verify**:

1. `pnpm exec vitest run` → all pass
2. `pnpm exec eslint .` and `pnpm exec prettier --check .` → clean

Manual smoke (dev server, real PDF): open the 73-page sample paper
(`src/dev/sample.pdf` is 2 pages; use a real arXiv paper from the list) —
the page indicator works, zoom in/out re-renders without freezing, and the
UI stays responsive during the initial render.

## Test plan

- Queue unit coverage (Step 3): ordering, cancellation, restart-on-zoom.
- Existing tests: the pdf-viewer helper tests (escapeHtml/highlightSpan)
  and any plan-002 component tests must stay green.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] Both render loops call the queue helper; `grep -n "renderInQueue" src/components/pdf-viewer/pdf-viewer.tsx` → 2 matches
- [ ] `pnpm exec vitest run` → all pass
- [ ] `pnpm exec tsc --noEmit`, `pnpm exec eslint .`, `pnpm exec prettier --check .` → clean
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The loop shapes in the live file differ from the excerpts (drift).
- Cancellation refactoring breaks search re-highlighting (the
  `applyHighlights` call inside `renderPage` depends on `searchQuery`; if
  the queue skips a stale run that should have highlighted, report — do not
  move the highlight logic around).
- A zoom storm (rapid clicks) leaves the viewer blank — report the repro
  steps instead of adding more layers.

## Maintenance notes

- The queue bounds the burst; the real fix for 200-page papers is
  viewport-based virtualization (render pages within a window around the
  scroll position). Design that when PDFs over ~100 pages become common.
- Reviewer focus: cancellation correctness — a stale run must never paint
  over a newer zoom's canvases (the `isCancelled` check before each render
  is load-bearing).
- The scale effect's `setPages(next)` must stay BEFORE the queue so the
  page indicator and layout react instantly even while rendering lags.
