# Plan 032 — PDF viewer virtualization (kill the "heavy app" feeling)

**Priority:** P1 · **Effort:** M · **Depends on:** 025, 028 (fresh-canvas fix, live-verified)

## Problem (live evidence)

The PDF viewer eagerly renders EVERY page of the paper. With a real
74-page arXiv paper, pdf.js paints 74 canvases at concurrency 4 straight
through, on the main thread. Measured in the built app over WebView2
CDP: **31.9 fps during load vs 60.4 fps after settle** — scrolling and
clicking stutter for 5–12 seconds on large papers. The user's "the app
is heavy and full of errors" report is this, plus the now-fixed black
pages.

## Approach

Render only the pages near the scroll viewport; defer the rest and paint
them lazily as the user scrolls.

1. Track the scroll container's visible range (scrollTop + clientHeight
   / page height) and render pages in `[visibleStart - margin,
visibleEnd + margin]` (margin ≈ 1.5 viewport heights).
2. Keep the existing sequential queue + concurrency 4, but the queue
   processes visible pages first (priority order), then the deferred
   ones as the user scrolls (IntersectionObserver or scroll handler
   with rAF throttle).
3. Keep the fresh-canvas-per-run generation key (Plan 028 result) — the
   deferred pages simply don't have canvases mounted yet (mount them in
   the pages list, paint on demand; unmounted canvases are invisible
   placeholders with the same layout box to avoid reflow).
4. Keep the search/retry/status machinery; `pending` pages outside the
   margin stay in `pending` state and paint on approach.
5. Cancel in-flight work for pages that scrolled far away (bounded
   queue already exists).

## Verification gates

- `pnpm test`, `pnpm run typecheck`, `pnpm run lint`, `pnpm run format:check`
- CDP live check in the dev preview with the real 74-page PDF: fps during
  load >= 55 while only ~6-8 canvases are mounted; scrolling paints new
  pages before they enter the viewport (no blank flash, no black pages).
- Exe rebuild + CDP: same numbers in the built app (WebView2).

## Commit strategy

One commit: `perf(pdf): virtualize page rendering — only viewport-near
pages paint (32fps -> 60fps during load)`. Tests: the render-queue tests
extend with a "visible-only" priority assertion.
