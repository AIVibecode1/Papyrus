# Plan 025: Fix the PDF black-page-on-resize bug

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 7e26e2d..HEAD -- src/components/pdf-viewer/`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `7e26e2d`, 2026-08-04

## Why this matters

The PDF reader shows black pages when resizing the window and sometimes
during normal use. Two previous fix attempts (v1.0.7, v1.0.8) serialized
renders per canvas and added a retry, but five interacting race conditions
remain. The root cause is not a single race — it is the combination of (1)
no cancellation check inside `renderPage`, (2) the canvas being eagerly
cleared to black on every retry attempt before any cancellation gate,
(3) the retry giving up silently after one 16ms-delayed attempt with no
mechanism to re-enqueue the failed page, (4) `await previous.promise` that
can hang forever if pdf.js never settles a cancelled/destroyed task, and
(5) the cleanup cancelling tasks but never deleting map entries, so stale
`renderPage` invocations that never complete leave zombie entries that
block all future runs for that index.

## Current state

The render logic lives in `src/components/pdf-viewer/pdf-viewer.tsx` (723
lines). The key functions are:

- `renderInQueue` (lines 30-55): dispatches pages to up to 4 concurrent
  workers, checks `isCancelled()` only between page dispatches (line 42),
  not inside `renderPage`.
- `renderPage` (lines 225-290): the per-page render. It awaits
  `previous.promise` at line 239 with no timeout. It sets
  `canvas.width`/`canvas.height` at lines 247-248 unconditionally at the
  top of every retry attempt. The retry loop (246-275) gives up after
  `attempt >= 1` with only a 16ms delay (line 273) and a `console.warn` +
  `return` (270-271). The text-layer render at lines 280-285 happens only
  if the canvas render succeeds.
- The scale effect (lines 296-326): bumps `renderRunRef.current` (304) on
  every `scale`/`repaintTick` change, debounced 150ms (303). The cleanup
  (316-325) cancels in-flight tasks and bumps `renderRunRef` but explicitly
  **keeps** the map entries (comment at 321-324) so `renderPage` can await
  them.
- The resize observer (336-366): debounced 200ms, either re-fits or bumps
  `repaintTick`.

Conventions: the repo uses vitest with jsdom, lucide-react icons, Tailwind
v4, and shadcn/ui. Tests mirror the existing pdf-viewer test patterns in
`src/components/pdf-viewer/__tests__/pdf-viewer.test.tsx`. Run tests with
`pnpm test`, typecheck with `pnpm run typecheck`, lint with `pnpm run lint`.

## Commands you will need

| Purpose   | Command                 | Expected on success |
| --------- | ----------------------- | ------------------- |
| Typecheck | `pnpm run typecheck`    | exit 0, no errors   |
| Tests     | `pnpm test`             | all pass            |
| Lint      | `pnpm run lint`         | exit 0              |
| Format    | `pnpm run format:check` | all matched         |

## Scope

**In scope** (the only files you should modify):

- `src/components/pdf-viewer/pdf-viewer.tsx`
- `src/components/pdf-viewer/__tests__/pdf-viewer.test.tsx`

**Out of scope** (do NOT touch):

- `src-tauri/src/pdf.rs` — PDF download/cache, not the renderer
- `src/lib/pdf-text.ts` — text extraction, confirmed clean
- Any other component or module

## Git workflow

- Branch: `advisor/025-pdf-black-page`
- Commit per step, conventional commits style: `fix(reader): ...`
- Do NOT push or open a PR unless instructed.

## Steps

### Step 1: Pass `isCancelled` into `renderPage` and check it at the key gates

`renderPage` is a `useCallback` (line 225) with no access to the
cancellation function. The `renderInQueue` call at line 309 passes
`() => run !== renderRunRef.current` but `renderPage` cannot see it.

Change `renderPage` to accept an `isCancelled: () => boolean` parameter.
Add early returns at two gates:

1. Right after awaiting `previous.promise` (after line 240): if
   `isCancelled()` return immediately — the run is stale.
2. Right before `page.render({ canvas, viewport })` (before line 251):
   if `isCancelled()` return — don't paint a stale canvas.

Update the call site at line 311 to pass the `isCancelled` callback.

**Verify**: `pnpm run typecheck` → exit 0

### Step 2: Bound the `await previous.promise` with a timeout

At lines 238-241, replace:

```
await previous.promise.catch(() => {});
renderTasksRef.current.delete(index);
```

with a raced timeout:

```
await Promise.race([
  previous.promise.catch(() => {}),
  new Promise((r) => setTimeout(r, 500)),
]);
renderTasksRef.current.delete(index);
```

This ensures that even if pdf.js never settles the cancelled task, the
wait is bounded to 500ms and the map entry is cleared. The next run
won't block on a dead task.

**Verify**: `pnpm run typecheck` → exit 0

### Step 3: Move canvas sizing after the cancellation check

Currently lines 247-248 set `canvas.width`/`canvas.height` at the top of
every retry attempt, before `page.render()`. Moving them AFTER the
cancellation check from Step 1 (gate 2) ensures a cancelled run never
touches the canvas — so it never synchronously clears it to black.

Restructure the retry loop body so the order is:

1. Check `isCancelled()` (Step 1 gate 2) — return if stale.
2. Set `canvas.width`/`canvas.height`.
3. Call `page.render({ canvas, viewport })`.

**Verify**: `pnpm run typecheck` → exit 0

### Step 4: Increase retry backoff and add a deferred-repaint mechanism

The 16ms retry delay (line 273) is too short for WebView2's busy-canvas
window. Increase it to 100ms. Additionally, track indices whose final
render attempt failed:

Add a `pendingRepaintRef = useRef<Set<number>>(new Set())`. When
`renderPage` gives up (the `attempt >= 1` branch, line 269-271), add
the index to `pendingRepaintRef.current` before returning.

After `renderInQueue` completes in the scale effect (after line 313),
add: if `pendingRepaintRef.current.size > 0`, schedule a
`requestAnimationFrame` that re-enqueues just those pages through
`renderPage` (with the current run id and isCancelled check). Clear the
set after scheduling.

**Verify**: `pnpm run typecheck` → exit 0

### Step 5: Clear stale task entries on cancellation

In the effect cleanup (lines 316-325), after calling `task.cancel()` on
each entry (line 320), mark them as cancelled so `renderPage` can skip
them. Replace the "keep entries" design:

Instead of keeping the cancelled entries, delete them from the map and
set a `cancelledRunsRef` Set. Change the `previous` check at line 237-240
to: if the entry is missing (was deleted), skip the await entirely — there
is nothing to wait for. This prevents new runs from blocking on zombie
tasks from cancelled runs.

**Verify**: `pnpm run typecheck` → exit 0, `pnpm test` → all pass

### Step 6: Add regression tests

In `pdf-viewer.test.tsx`, add tests modeled after the existing
`renderInQueue` and render tests:

1. **"cancels stale renderPage when run changes mid-render"**: mock a
   page.render that blocks on a deferred promise. Start a render run,
   then bump `renderRunRef` before the promise resolves. Assert the
   canvas was NOT painted (width stayed 0 or unchanged).

2. **"repaints failed pages on the next frame"**: mock `page.render` to
   fail twice, then succeed. Assert the page eventually renders.

3. **"await previous.promise times out on a never-settling task"**: mock
   a task whose `.promise` never resolves. Assert that a second render
   run for the same index still completes within a reasonable time
   (use vitest fake timers).

**Verify**: `pnpm test` → all pass including new tests, `pnpm run lint` → exit 0

## Test plan

- 3 new tests in `pdf-viewer.test.tsx`, modeled after the existing render
  and zero-size-page tests.
- Existing tests must still pass: the cancellation behavior must not break
  the normal render path tested by existing cases.

## Done criteria

- [ ] `pnpm run typecheck` exits 0
- [ ] `pnpm test` exits 0; 3 new tests exist and pass
- [ ] `pnpm run lint` exits 0
- [ ] `pnpm run format:check` passes
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The code at the locations in "Current state" doesn't match the excerpts
  (the codebase has drifted since this plan was written).
- A step's verification fails twice after a reasonable fix attempt.
- The fix appears to require touching an out-of-scope file.
- You discover that `renderInQueue` has callers outside `pdf-viewer.tsx`
  that would break from the API change.

## Maintenance notes

- Future changes to the render concurrency model (e.g. switching from
  4 workers to a strict sequential queue) must re-check the
  cancellation gates inside `renderPage`.
- The `pendingRepaintRef` mechanism assumes one outstanding repaint
  schedule at a time; if a separate "repaint on demand" feature is added
  later, coordinate with this ref.
