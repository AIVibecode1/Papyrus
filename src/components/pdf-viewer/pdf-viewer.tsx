import { FileText, RotateCcw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import * as pdfjsLib from "pdfjs-dist";
import type { PDFPageProxy } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
// Positioning rules for the text layer (spans over the canvas).
import "pdfjs-dist/web/pdf_viewer.css";

import { Button } from "@/components/ui/button";
import { highlightSpan } from "./search-highlight";
import { renderInQueue } from "./render-queue";
import type { PageView } from "./render-queue";
import { PdfToolbar } from "./pdf-toolbar";
import { usePdfSearch } from "./use-pdf-search";
import { useReadingPosition } from "./use-reading-position";

// Re-exported so existing import paths keep working (unit tests import
// renderInQueue from the viewer module).
export { highlightSpan, renderInQueue };
export { escapeHtml } from "./search-highlight";
export type { PageView };

interface PdfViewerProps {
  bytes: Uint8Array;
  /** arXiv id: enables reading-position memory across sessions. */
  paperId?: string;
  onSelect: (text: string) => void;
}

/** Surface lifecycle of one rendered page. */
type PageStatus = "pending" | "painting" | "ready" | "failed";

// ---------------------------------------------------------------------------
// Viewer
// ---------------------------------------------------------------------------

export function PdfViewer({ bytes, paperId, onSelect }: PdfViewerProps) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRefs = useRef<(HTMLCanvasElement | null)[]>([]);
  const layerRefs = useRef<(HTMLDivElement | null)[]>([]);
  const pageWrapRefs = useRef<(HTMLDivElement | null)[]>([]);
  // Viewports live in a ref so the scale effect can update them without
  // re-triggering itself through state.
  const viewportsRef = useRef<PageView[]>([]);

  const [pages, setPages] = useState<PageView[]>([]);
  const [scale, setScale] = useState(1);
  const [currentPage, setCurrentPage] = useState(1);
  const [error, setError] = useState<string | null>(null);
  // Bumping this re-runs the load effect (the error state's retry action).
  const [reloadKey, setReloadKey] = useState(0);
  // Stable accessors for the hooks below (inline arrows would re-create
  // their callbacks every render and churn the paint effects).
  const getLayers = useCallback(() => layerRefs.current, []);
  const getWrap = useCallback((index: number) => pageWrapRefs.current[index] ?? null, []);
  const {
    searchOpen,
    setSearchOpen,
    searchQuery,
    matchCount,
    searchInputRef,
    applyHighlights,
    jumpToMatch,
    clearSearch,
    handleQueryChange,
  } = usePdfSearch(getLayers);
  const loadingTaskRef = useRef<pdfjsLib.PDFDocumentLoadingTask | null>(null);

  // Current scale mirror + last auto-fit value: a manual zoom wins over
  // the resize re-fit (see the ResizeObserver effect below).
  const scaleRef = useRef(scale);
  const lastFitRef = useRef(0);
  const [repaintTick, setRepaintTick] = useState(0);
  useEffect(() => {
    scaleRef.current = scale;
  }, [scale]);

  // --- load ----------------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    setError(null);
    pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

    (async () => {
      try {
        // Copy the bytes: pdf.js transfers its input buffer to the worker,
        // which would detach a buffer shared with the text extractor.
        const loadingTask = pdfjsLib.getDocument({ data: bytes.slice() });
        loadingTaskRef.current = loadingTask;
        const loaded = await loadingTask.promise;
        if (cancelled) {
          void loadingTask.destroy();
          return;
        }
        void loaded; // kept alive by the loading task; pages come from it
        const pageObjects: PDFPageProxy[] = [];
        for (let i = 1; i <= loaded.numPages; i += 1) {
          pageObjects.push(await loaded.getPage(i));
        }
        if (cancelled) return;
        const first = pageObjects[0].getViewport({ scale: 1 });
        const containerWidth = containerRef.current?.clientWidth ?? 800;
        const fit = Math.max(0.5, Math.min(2.5, (containerWidth - 48) / first.width));
        setScale(fit);
        lastFitRef.current = fit;
        const views = pageObjects.map((page) => ({
          page,
          viewport: page.getViewport({ scale: fit }),
        }));
        viewportsRef.current = views;
        setPages(views);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [bytes, reloadKey]);

  useEffect(
    () => () => {
      void loadingTaskRef.current?.destroy();
    },
    [],
  );

  // --- render pages (scale changes re-render everything) -------------------
  // In-flight render tasks per page index: a newer run (zoom, resize,
  // re-fit) cancels them, so pdf.js never gets a second render() on a
  // canvas whose previous render is still running (that throws, and one
  // thrown page used to kill the whole queue, leaving the rest black).
  const renderTasksRef = useRef(new Map<number, pdfjsLib.RenderTask>());
  // Pages whose final render attempt failed: re-enqueued on the next
  // animation frame so a transient WebView2 busy-canvas can never leave
  // a page black until the user manually zooms.
  const pendingRepaintRef = useRef(new Set<number>());
  // Per-page surface state, so a page that can never paint shows a
  // Retry affordance instead of a silent blank rectangle.
  const [pageStatus, setPageStatus] = useState<Record<number, PageStatus>>({});

  const renderPage = useCallback(
    async (view: PageView, index: number, isCancelled: () => boolean) => {
      const { page, viewport } = view;
      const canvas = canvasRefs.current[index];
      const layer = layerRefs.current[index];
      const wrap = pageWrapRefs.current[index];
      if (!canvas || !layer || !wrap) return;

      // Serialize renders per canvas: a task cancelled by a newer run
      // (zoom, resize, re-fit) may still be winding down in the pdf.js
      // worker. Starting a new render() before it settles makes pdf.js
      // reject with its "same canvas" error, and that page used to be
      // skipped forever, staying black. Wait for the old task first —
      // but bound the wait: a cancelled task whose promise never settles
      // (worker destroyed on reload) must not stall this page forever.
      const previous = renderTasksRef.current.get(index);
      if (previous) {
        // `completed` resolves when the task FULLY stops — including a
        // cancelled task's residual operator chunk — so a fresh render
        // can never interleave with a winding-down one on this canvas.
        // The race bounds the wait: a cancelled task whose promise never
        // settles (worker destroyed on reload) must not stall forever.
        await Promise.race([
          // `completed` exists at runtime (settles when the task FULLY
          // stops, including a cancelled task's residual chunk) but is
          // absent from the shipped typings.
          (
            (previous as unknown as { completed?: Promise<void> }).completed ?? previous.promise
          ).catch(() => {}),
          new Promise<void>((r) => setTimeout(r, 500)),
        ]);
        renderTasksRef.current.delete(index);
      }
      // The run may have been cancelled while we waited. A stale run
      // must never touch the canvas: setting canvas.width clears it to
      // black synchronously, and a later repaint of the same canvas can
      // race it.
      if (isCancelled()) return;

      // HiDPI: the canvas backing store is scaled by devicePixelRatio,
      // the CSS size stays the pdf.js CSS-pixel viewport, and the render
      // transform maps the PDF onto the backing store. Without this the
      // PDF looks blurry on any HiDPI display.
      const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
      const cssWidth = Math.floor(viewport.width);
      const cssHeight = Math.floor(viewport.height);

      setPageStatus((s) => ({ ...s, [index]: "painting" }));

      // One retry after a backoff: transient failures (a canvas still
      // busy from a cancelled run) resolve on the second attempt, so a
      // single hiccup can never leave a black page.
      for (let attempt = 0; ; attempt += 1) {
        if (isCancelled()) return;
        canvas.style.width = `${cssWidth}px`;
        canvas.style.height = `${cssHeight}px`;
        canvas.width = Math.floor(cssWidth * dpr);
        canvas.height = Math.floor(cssHeight * dpr);
        // pdfjs v6 renders with the canvas element directly.
        try {
          const task = page.render({
            canvas,
            viewport,
            transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
          });
          renderTasksRef.current.set(index, task);
          try {
            await task.promise;
          } finally {
            renderTasksRef.current.delete(index);
          }
          break;
        } catch (err) {
          const cancelled =
            err instanceof Error &&
            (err.name === "RenderingCancelledException" ||
              /rendering cancelled/i.test(err.message));
          // Cancelled by a newer run: expected, the new run repaints this
          // canvas. Anything else: retry once with a backoff long enough
          // for WebView2 to actually free the canvas, then hand the page
          // to the repaint queue instead of abandoning it black.
          if (cancelled) return;
          if (attempt >= 1) {
            pendingRepaintRef.current.add(index);
            setPageStatus((s) => ({ ...s, [index]: "failed" }));
            return;
          }
          await new Promise((r) => setTimeout(r, 100));
        }
      }

      layer.innerHTML = "";
      layer.style.width = `${viewport.width}px`;
      layer.style.height = `${viewport.height}px`;
      const textLayer = new pdfjsLib.TextLayer({
        textContentSource: page.streamTextContent(),
        container: layer,
        viewport,
      });
      await textLayer.render();
      // Search highlights survive scale changes only if re-applied.
      if (searchQuery.trim()) applyHighlights(layer, searchQuery);
      setPageStatus((s) => ({ ...s, [index]: "ready" }));
    },
    [searchQuery, applyHighlights],
  );

  /** Manual retry for a page whose final paint attempt failed. */
  const retryPage = useCallback(
    (index: number) => {
      const views = viewportsRef.current;
      if (!views[index]) return;
      const run = renderRunRef.current;
      void renderPage(views[index], index, () => run !== renderRunRef.current);
    },
    [renderPage],
  );

  // Monotonic id of the current render run: bumping it cancels the
  // in-flight run (zoom changes must stop the old loop immediately).
  const renderRunRef = useRef(0);
  // Virtualization window: only pages near the scroll viewport mount
  // canvases. A 74-page paper at 125% display scale pins ~1.4GB of
  // canvas memory in WebView2, and Chromium reclaims that by blanking
  // canvases under pressure — pages "disappearing" while scrolling.
  // Off-screen pages keep a same-height placeholder so the scrollbar
  // never jumps; canvases mount (and render) as they approach.
  const PAGE_MARGIN = 2; // pages kept rendered beyond the viewport
  const [visibleRange, setVisibleRange] = useState<{ start: number; end: number } | null>(null);
  const visibleRangeRef = useRef<{ start: number; end: number } | null>(null);
  // Indices whose current render attempt is done (painted or failed):
  // scroll-in renders only touch pages that still need paint.
  const paintedRef = useRef(new Set<number>());
  const rangeRafRef = useRef<number | null>(null);

  const measureRange = useCallback(() => {
    const el = containerRef.current;
    const wraps = pageWrapRefs.current;
    if (!el || wraps.length === 0) return;
    const h = el.clientHeight;
    // No layout metrics (jsdom, pre-mount): keep null = all pages
    // visible, which is the conservative fallback for tests.
    if (h <= 0) return;
    const top = el.scrollTop;
    const bottom = top + h;
    let first = -1;
    let last = -1;
    for (let i = 0; i < wraps.length; i += 1) {
      const w = wraps[i];
      if (!w) continue;
      const ot = w.offsetTop;
      const ob = ot + w.offsetHeight;
      if (ob <= top) continue;
      if (ot >= bottom) break;
      if (first < 0) first = i;
      last = i;
    }
    const start = Math.max(0, (first < 0 ? 0 : first) - PAGE_MARGIN);
    const end = Math.min(
      wraps.length - 1,
      (last < 0 ? Math.min(wraps.length - 1, PAGE_MARGIN) : last) + PAGE_MARGIN,
    );
    const next = { start, end };
    const cur = visibleRangeRef.current;
    if (!cur || cur.start !== next.start || cur.end !== next.end) {
      visibleRangeRef.current = next;
      setVisibleRange(next);
    }
  }, []);

  // Paint pages as they scroll into the window; forget pages that left
  // (their canvases unmount, so a later return must repaint them).
  useEffect(() => {
    const range = visibleRange;
    if (!range) return;
    for (const i of paintedRef.current) {
      if (i < range.start || i > range.end) paintedRef.current.delete(i);
    }
    const run = renderRunRef.current;
    const views = viewportsRef.current;
    const need: number[] = [];
    for (let i = range.start; i <= range.end; i += 1) {
      if (paintedRef.current.has(i) || !views[i] || !canvasRefs.current[i]) continue;
      // Do NOT mark painted here: the queue's paint-once guard does,
      // right before renderPage. Marking first made the guard skip the
      // page, leaving its fresh canvas blank forever — the
      // disappearing-page bug.
      need.push(i);
    }
    if (need.length === 0) return;
    void renderInQueue(
      views,
      (view, index) => {
        if (paintedRef.current.has(index)) return Promise.resolve();
        paintedRef.current.add(index);
        return renderPage(view, index, () => run !== renderRunRef.current);
      },
      () => run !== renderRunRef.current,
      { start: need[0], end: need[need.length - 1] },
    ).catch(() => {
      // contained: the retry/repaint machinery owns failed pages
    });
  }, [visibleRange, renderPage]);
  // Monotonic id of the current canvas GENERATION: canvases are keyed by
  // it, so every render run mounts FRESH canvas elements. A canvas that
  // had a cancelled render keeps receiving the cancelled task's residual
  // drawing (pdf.js keeps executing its current operator chunk after
  // cancel()), and reusing it for the next render interleaves the two
  // draws — the black-page race. A fresh element has a clean context and
  // the stale task's residual paint lands on the detached old element,
  // invisible.
  const canvasGenRef = useRef(0);
  const [canvasGen, setCanvasGen] = useState(0);

  useEffect(() => {
    // Re-render all pages when the zoom changes. Viewports are updated in
    // the ref and mirrored once into state; the effect itself only depends
    // on `scale`, so it cannot loop. Pages render through a sequential
    // queue that checks cancellation before every page.
    const views = viewportsRef.current;
    if (views.length === 0) return;
    const timer = setTimeout(() => {
      const run = ++renderRunRef.current;
      void (async () => {
        const next = views.map(({ page }) => ({ page, viewport: page.getViewport({ scale }) }));
        viewportsRef.current = next;
        setPages(next);
        setPageStatus({});
        paintedRef.current.clear();
        // Bump the canvas generation and wait one frame: React commits
        // the fresh canvas elements (and updates the refs) before the
        // queue starts painting.
        canvasGenRef.current += 1;
        setCanvasGen(canvasGenRef.current);
        await new Promise<void>((r) => requestAnimationFrame(() => r()));
        // Only pages in the scroll window (plus the margin) paint in the
        // main run; the rest paint as they scroll in. Without layout
        // metrics the range is null and everything renders (tests).
        measureRange();
        const range = visibleRangeRef.current ?? { start: 0, end: next.length - 1 };
        await renderInQueue(
          next,
          (view, index) => {
            if (paintedRef.current.has(index)) return Promise.resolve();
            paintedRef.current.add(index);
            return renderPage(view, index, () => run !== renderRunRef.current);
          },
          () => run !== renderRunRef.current,
          range,
        );
        // Pages whose final render attempt failed are repainted on the
        // next frame at the current scale, so a transient busy-canvas
        // can never leave them black until the user re-zooms.
        if (run === renderRunRef.current && pendingRepaintRef.current.size > 0) {
          const retry = [...pendingRepaintRef.current];
          pendingRepaintRef.current.clear();
          requestAnimationFrame(() => {
            if (run !== renderRunRef.current) return;
            void (async () => {
              for (const i of retry) {
                if (run !== renderRunRef.current) return;
                if (i >= next.length) continue;
                try {
                  await renderPage(next[i], i, () => run !== renderRunRef.current);
                } catch {
                  // contained: one page must never take down the run
                }
              }
            })();
          });
        }
      })();
    }, 150);
    return () => {
      clearTimeout(timer);
      // A newer effect cycle started: cancel any run still in flight.
      renderRunRef.current += 1;
      // Cancel the in-flight tasks but KEEP the entries: a cancelled
      // task's residual operator chunk may still be drawing on the
      // canvas, and the next run must wait for it to fully settle
      // (renderPage awaits `completed`, bounded) before touching the
      // canvas. Dropping the entries here made the wait dead code and
      // let fresh renders interleave with winding-down ones — the
      // black-page race. Entries are removed by renderPage after the
      // wait; never-settling zombies are handled by the bounded race.
      renderTasksRef.current.forEach((task) => task.cancel());
    };
  }, [scale, repaintTick]);

  // Re-fit when the container resizes (window resize or split drag): the
  // initial fit is computed once at load, and WebView2 sometimes leaves
  // canvases black after a resize unless a fresh render happens. The
  // debounce keeps drags from re-rendering every frame. Keyed on
  // pages.length: the container div does not exist while the spinner
  // shows, so a mount-time observer would see a null ref and never attach.
  // A manual zoom wins over re-fitting: once the user zooms, resizes only
  // repaint at the current scale instead of resetting their zoom.
  useEffect(() => {
    if (typeof ResizeObserver === "undefined") return;
    const el = containerRef.current;
    if (!el) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const observer = new ResizeObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const first = viewportsRef.current[0]?.page;
        if (!first) return;
        const width = el.clientWidth;
        const fit = Math.max(
          0.5,
          Math.min(2.5, (width - 48) / first.getViewport({ scale: 1 }).width),
        );
        const userZoomed = Math.abs(scaleRef.current - lastFitRef.current) >= 0.01;
        if (userZoomed) {
          // Keep the user's zoom; a fresh paint clears any stale canvas.
          setRepaintTick((t) => t + 1);
        } else {
          lastFitRef.current = fit;
          setScale(fit);
        }
      }, 200);
    });
    observer.observe(el);
    return () => {
      clearTimeout(timer);
      observer.disconnect();
    };
  }, [pages.length]);

  // --- page tracking + selection ------------------------------------------
  const onScroll = () => {
    const wraps = pageWrapRefs.current;
    for (let i = 0; i < wraps.length; i += 1) {
      const wrap = wraps[i];
      if (!wrap) continue;
      const rect = wrap.getBoundingClientRect();
      if (rect.top <= window.innerHeight * 0.4 && rect.bottom > window.innerHeight * 0.4) {
        setCurrentPage(i + 1);
        break;
      }
    }
    // Keep the virtualization window in step with the scroll, one rAF
    // at a time (a burst of scroll events must not schedule a pile).
    if (rangeRafRef.current !== null) return;
    rangeRafRef.current = requestAnimationFrame(() => {
      rangeRafRef.current = null;
      measureRange();
    });
  };

  const onMouseUp = () => {
    if (!onSelect) return;
    const selection = window.getSelection();
    const text = selection?.toString().trim() ?? "";
    if (text.length < 3) return;
    const node = selection?.anchorNode;
    if (node && node.parentElement?.closest(".textLayer")) {
      onSelect(text.slice(0, 2000));
    }
  };

  const goToPage = (n: number) => {
    // Update the indicator immediately; the scroll tracker agrees once the
    // scroll settles (and in environments where scrolling is a no-op).
    setCurrentPage(n);
    const wrap = pageWrapRefs.current[n - 1];
    wrap?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  // Reading-position memory (restore once layout is real, then save).
  useReadingPosition(paperId, pages.length, currentPage, setCurrentPage, getWrap);

  // Keyboard shortcuts: ArrowLeft/ArrowRight page navigation (ignored while
  // typing), Ctrl/Cmd+F opens the find bar, Escape closes it.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing =
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable);
      if (e.key === "Escape") {
        setSearchOpen(false);
        return;
      }
      if (typing) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
        e.preventDefault();
        setSearchOpen(true);
        requestAnimationFrame(() => {
          searchInputRef.current?.focus();
        });
        return;
      }
      if (e.key === "ArrowLeft" || e.key === "PageUp") {
        e.preventDefault();
        goToPage(Math.max(1, currentPage - 1));
      } else if (e.key === "ArrowRight" || e.key === "PageDown") {
        e.preventDefault();
        goToPage(Math.min(pages.length, currentPage + 1));
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [currentPage, pages.length, paperId]);

  if (error) {
    return (
      <div
        role="alert"
        className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center"
      >
        <FileText className="size-10 text-destructive/70" />
        <p className="text-sm font-medium text-destructive">{t("reader.pdfError")}</p>
        <p dir="ltr" className="max-w-md break-words text-xs text-muted-foreground">
          {error}
        </p>
        {/* Errors are direction, not dead ends: retrying is one click. */}
        <Button variant="outline" size="sm" onClick={() => setReloadKey((k) => k + 1)}>
          <RotateCcw className="size-3.5" />
          {t("reader.retry")}
        </Button>
      </div>
    );
  }

  if (pages.length === 0) {
    return (
      <div
        role="status"
        aria-label={t("reader.pdfLoading")}
        className="flex h-full items-center justify-center"
      >
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <PdfToolbar
        currentPage={currentPage}
        totalPages={pages.length}
        scale={scale}
        onPrevPage={() => goToPage(Math.max(1, currentPage - 1))}
        onNextPage={() => goToPage(Math.min(pages.length, currentPage + 1))}
        onZoomOut={() => setScale((s) => Math.max(0.5, +(s - 0.2).toFixed(2)))}
        onZoomIn={() => setScale((s) => Math.min(2.5, +(s + 0.2).toFixed(2)))}
        searchOpen={searchOpen}
        onOpenSearch={() => setSearchOpen(true)}
        onCloseSearch={() => {
          clearSearch();
          setSearchOpen(false);
        }}
        searchQuery={searchQuery}
        onQueryChange={handleQueryChange}
        matchCount={matchCount}
        onJumpMatch={jumpToMatch}
        searchInputRef={searchInputRef}
      />

      {/* pages */}
      <div
        ref={containerRef}
        onScroll={onScroll}
        onMouseUp={onMouseUp}
        className="flex-1 overflow-y-auto bg-muted/20 p-4"
        dir="ltr"
      >
        <div className="pdfViewer mx-auto flex w-fit flex-col gap-4">
          {pages.map(({ page, viewport }, i) => {
            const inRange =
              visibleRange === null || (i >= visibleRange.start && i <= visibleRange.end);
            return (
              <div
                key={page.pageNumber}
                ref={(el) => {
                  pageWrapRefs.current[i] = el;
                }}
                /* The surface behind the canvas is always paper-white,
                   regardless of the app theme: a PDF is a light document,
                   and a dark wrapper would read as a black hole in
                   dark/sepia mode while the page paints (or fails). The
                   wrapper keeps the page's exact height at all times so
                   the scrollbar never jumps when canvases mount/unmount
                   (virtualization). */
                className="relative bg-white shadow-sm"
                style={{ width: viewport.width, height: viewport.height }}
              >
                {inRange ? (
                  <>
                    <canvas
                      key={`${canvasGen}-${page.pageNumber}`}
                      ref={(el) => {
                        canvasRefs.current[i] = el;
                      }}
                      width={viewport.width}
                      height={viewport.height}
                      aria-hidden="true"
                    />
                    <div
                      ref={(el) => {
                        layerRefs.current[i] = el;
                      }}
                      className="textLayer absolute inset-0"
                    />
                  </>
                ) : (
                  <div className="h-full w-full" aria-hidden="true" />
                )}
                {pageStatus[i] === "failed" && inRange && (
                  <div className="absolute inset-0 flex items-center justify-center bg-white">
                    <button
                      type="button"
                      onClick={() => retryPage(i)}
                      className="inline-flex items-center gap-1.5 rounded-md border border-input bg-background px-3 py-1.5 text-xs text-foreground shadow-sm transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <RotateCcw className="size-3.5" />
                      {t("reader.retryPage")}
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
