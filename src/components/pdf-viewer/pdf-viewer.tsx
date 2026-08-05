import {
  ChevronLeft,
  ChevronRight,
  FileText,
  Minus,
  Plus,
  RotateCcw,
  Search,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import * as pdfjsLib from "pdfjs-dist";
import type { PDFPageProxy } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
// Positioning rules for the text layer (spans over the canvas).
import "pdfjs-dist/web/pdf_viewer.css";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

// Platform detection for shortcut hints (macOS uses the Command key).
const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform ?? "");

/**
 * Renders pages one at a time, checking cancellation before each page so a
 * newer run (zoom change, reopen) stops the old loop immediately instead
 * of finishing every canvas. Exported for unit tests.
 */
export async function renderInQueue(
  views: PageView[],
  render: (view: PageView, index: number) => Promise<void>,
  isCancelled: () => boolean,
): Promise<void> {
  // Render several pages concurrently: a strictly sequential queue paints
  // slowly on long PDFs, leaving scrolled-to pages black for seconds.
  // Each page takes a unique index before any await, so no page is
  // rendered twice; per-page failures are contained (renderPage catches).
  const CONCURRENCY = 4;
  let next = 0;
  const worker = async () => {
    while (!isCancelled()) {
      const i = next;
      next += 1;
      if (i >= views.length) return;
      try {
        await render(views[i], i);
      } catch {
        // never let one page take down the run
      }
    }
  };
  const workers = Array.from({ length: Math.min(CONCURRENCY, views.length) }, () => worker());
  await Promise.all(workers);
}

interface PdfViewerProps {
  bytes: Uint8Array;
  /** arXiv id: enables reading-position memory across sessions. */
  paperId?: string;
  onSelect: (text: string) => void;
}

// Reading position memory, keyed by paper id.
const POS_KEY = "papyrus-reader-pos";
function readPosition(paperId?: string): number | null {
  if (!paperId) return null;
  try {
    const raw = localStorage.getItem(POS_KEY);
    if (!raw) return null;
    const map = JSON.parse(raw) as Record<string, number>;
    return typeof map[paperId] === "number" ? map[paperId] : null;
  } catch {
    return null;
  }
}
function savePosition(paperId: string | undefined, page: number) {
  if (!paperId) return;
  try {
    const raw = localStorage.getItem(POS_KEY);
    const map = (raw ? JSON.parse(raw) : {}) as Record<string, number>;
    map[paperId] = page;
    localStorage.setItem(POS_KEY, JSON.stringify(map));
  } catch {
    // memory is best-effort
  }
}

interface PageView {
  page: PDFPageProxy;
  viewport: ReturnType<PDFPageProxy["getViewport"]>;
}

/** Surface lifecycle of one rendered page. */
type PageStatus = "pending" | "painting" | "ready" | "failed";

// ---------------------------------------------------------------------------
// Search helpers (pure, exported for unit tests)
// ---------------------------------------------------------------------------

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Wraps every case-insensitive occurrence of `query` in the span's text
 * with <mark> elements. Returns the number of matches found.
 */
export function highlightSpan(span: HTMLElement, query: string): number {
  const text = span.textContent ?? "";
  if (!query.trim() || !text.toLowerCase().includes(query.toLowerCase())) return 0;
  const lower = text.toLowerCase();
  const needle = query.toLowerCase();
  let count = 0;
  let html = "";
  let cursor = 0;
  let idx = lower.indexOf(needle);
  while (idx >= 0) {
    html += `${escapeHtml(text.slice(cursor, idx))}<mark>${escapeHtml(text.slice(idx, idx + needle.length))}</mark>`;
    count += 1;
    cursor = idx + needle.length;
    idx = lower.indexOf(needle, cursor);
  }
  html += escapeHtml(text.slice(cursor));
  span.innerHTML = html;
  return count;
}

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
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [matchCount, setMatchCount] = useState(0);
  const marksRef = useRef<HTMLElement[]>([]);
  const loadingTaskRef = useRef<pdfjsLib.PDFDocumentLoadingTask | null>(null);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

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
    [searchQuery],
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
        // Bump the canvas generation and wait one frame: React commits
        // the fresh canvas elements (and updates the refs) before the
        // queue starts painting.
        canvasGenRef.current += 1;
        setCanvasGen(canvasGenRef.current);
        await new Promise<void>((r) => requestAnimationFrame(() => r()));
        await renderInQueue(
          next,
          (view, index) => renderPage(view, index, () => run !== renderRunRef.current),
          () => run !== renderRunRef.current,
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

  // --- search --------------------------------------------------------------
  const applyHighlights = (layer: HTMLElement, query: string) => {
    layer.querySelectorAll("mark").forEach((m) => {
      const span = m.parentElement;
      if (span) {
        span.innerHTML = escapeHtml(span.textContent ?? "");
      }
    });
    if (!query.trim()) return;
    const marks: HTMLElement[] = [];
    layer.querySelectorAll<HTMLSpanElement>("span").forEach((span) => {
      if (highlightSpan(span, query.trim()) > 0) {
        span.querySelectorAll("mark").forEach((m) => marks.push(m as HTMLElement));
      }
    });
    marksRef.current = [...marksRef.current, ...marks];
  };

  const runSearch = (query: string) => {
    marksRef.current = [];
    layerRefs.current.forEach((layer) => layer && applyHighlights(layer, query));
    setMatchCount(marksRef.current.length);
    if (marksRef.current.length > 0) {
      marksRef.current[0].scrollIntoView({ block: "center" });
    }
  };

  const jumpToMatch = (direction: 1 | -1) => {
    const marks = marksRef.current;
    if (marks.length === 0) return;
    const current = marks.findIndex(
      (m) =>
        m.getBoundingClientRect().top >= -40 &&
        m.getBoundingClientRect().top <= window.innerHeight * 0.6,
    );
    const target = current === -1 ? 0 : (current + direction + marks.length) % marks.length;
    marks[target].scrollIntoView({ block: "center" });
  };

  const clearSearch = () => {
    setSearchQuery("");
    setMatchCount(0);
    marksRef.current = [];
    layerRefs.current.forEach((layer) => {
      layer?.querySelectorAll("mark").forEach((m) => {
        const span = m.parentElement;
        if (span) span.innerHTML = escapeHtml(span.textContent ?? "");
      });
    });
  };

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

  // Remember the reading position whenever the visible page changes. The
  // guard prevents the mount-time save (page 1) from clobbering a stored
  // position before the restore effect has read it.
  const restoreDoneRef = useRef(false);
  useEffect(() => {
    if (!restoreDoneRef.current) return;
    savePosition(paperId, currentPage);
  }, [currentPage, paperId]);

  // Restore the last reading position once the pages have real layout
  // heights (the load effect alone is too early: canvases start at zero
  // height, and a scroll to a zero-height page is a no-op that leaves the
  // scroll tracker on page 1).
  useEffect(() => {
    if (pages.length === 0) return;
    const saved = readPosition(paperId);
    if (saved && saved >= 1 && saved <= pages.length) {
      setCurrentPage(saved);
      const timer = setTimeout(() => {
        pageWrapRefs.current[saved - 1]?.scrollIntoView({ block: "start" });
      }, 250);
      return () => clearTimeout(timer);
    }
  }, [pages.length, paperId]);

  // Enable position saves once the restore pass has run (whether or not a
  // saved position existed).
  useEffect(() => {
    if (pages.length > 0) restoreDoneRef.current = true;
  }, [pages.length]);

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
      {/* toolbar */}
      <div className="flex flex-wrap items-center gap-1.5 border-b bg-muted/30 p-2">
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => goToPage(Math.max(1, currentPage - 1))}
          aria-label={t("reader.prevPage")}
        >
          {/* In RTL the previous page sits to the RIGHT (inline-start). */}
          <ChevronLeft className="size-4 rtl:rotate-180" />
        </Button>
        <span className="font-mono text-[11px] text-muted-foreground" dir="ltr">
          {currentPage} / {pages.length}
        </span>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => goToPage(Math.min(pages.length, currentPage + 1))}
          aria-label={t("reader.nextPage")}
        >
          <ChevronRight className="size-4 rtl:rotate-180" />
        </Button>

        <div className="mx-1 h-4 w-px bg-border" />

        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => setScale((s) => Math.max(0.5, +(s - 0.2).toFixed(2)))}
          aria-label={t("reader.zoomOut")}
        >
          <Minus className="size-4" />
        </Button>
        <span className="w-10 text-center font-mono text-[11px] text-muted-foreground" dir="ltr">
          {Math.round(scale * 100)}%
        </span>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => setScale((s) => Math.min(2.5, +(s + 0.2).toFixed(2)))}
          aria-label={t("reader.zoomIn")}
        >
          <Plus className="size-4" />
        </Button>

        <div className="mx-1 h-4 w-px bg-border" />

        {!searchOpen ? (
          <>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => setSearchOpen(true)}
              aria-label={t("reader.searchInPdf")}
            >
              <Search className="size-4" />
            </Button>
            <kbd>{IS_MAC ? "⌘F" : "Ctrl+F"}</kbd>
          </>
        ) : (
          <div className="flex items-center gap-1.5">
            <Input
              ref={searchInputRef}
              autoFocus
              aria-label={t("reader.searchInPdf")}
              value={searchQuery}
              onChange={(e) => {
                const value = e.target.value;
                setSearchQuery(value);
                // Live search, debounced: the Enter key only jumps between
                // matches, so a stale state on Enter is not a problem.
                if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
                if (value.trim()) {
                  searchTimerRef.current = setTimeout(() => runSearch(value), 250);
                } else {
                  marksRef.current = [];
                  setMatchCount(0);
                  layerRefs.current.forEach((layer) => {
                    layer?.querySelectorAll("mark").forEach((m) => {
                      const span = m.parentElement;
                      if (span) span.innerHTML = escapeHtml(span.textContent ?? "");
                    });
                  });
                }
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  if (e.shiftKey) jumpToMatch(-1);
                  else jumpToMatch(1);
                }
                if (e.key === "Escape") {
                  clearSearch();
                  setSearchOpen(false);
                }
              }}
              placeholder={`${t("reader.searchInPdf")}…`}
              className="h-8 w-40 text-xs"
              dir="auto"
            />
            <span
              aria-live="polite"
              className="min-w-14 text-center text-xs text-muted-foreground"
              dir="ltr"
            >
              {matchCount > 0 ? `${matchCount} ${t("reader.matches")}` : t("reader.noMatches")}
            </span>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => {
                clearSearch();
                setSearchOpen(false);
              }}
              aria-label={t("reader.closeSearch")}
            >
              <X className="size-4" />
            </Button>
          </div>
        )}

        {searchQuery.trim() && (
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => jumpToMatch(1)}
            aria-label={t("reader.nextMatch")}
          >
            <ChevronRight className="size-4 rtl:rotate-180" />
          </Button>
        )}
      </div>

      {/* pages */}
      <div
        ref={containerRef}
        onScroll={onScroll}
        onMouseUp={onMouseUp}
        className="flex-1 overflow-y-auto bg-muted/20 p-4"
        dir="ltr"
      >
        <div className="pdfViewer mx-auto flex w-fit flex-col gap-4">
          {pages.map(({ page, viewport }, i) => (
            <div
              key={page.pageNumber}
              ref={(el) => {
                pageWrapRefs.current[i] = el;
              }}
              /* The surface behind the canvas is always paper-white,
                 regardless of the app theme: a PDF is a light document,
                 and a dark wrapper would read as a black hole in
                 dark/sepia mode while the page paints (or fails). */
              className="relative bg-white shadow-sm"
              style={{ width: viewport.width }}
            >
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
              {pageStatus[i] === "failed" && (
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
          ))}
        </div>
      </div>
    </div>
  );
}
