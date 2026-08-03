import { ChevronLeft, ChevronRight, FileText, Minus, Plus, Search, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import * as pdfjsLib from "pdfjs-dist";
import type { PDFPageProxy } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
// Positioning rules for the text layer (spans over the canvas).
import "pdfjs-dist/web/pdf_viewer.css";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

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
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [matchCount, setMatchCount] = useState(0);
  const marksRef = useRef<HTMLElement[]>([]);
  const loadingTaskRef = useRef<pdfjsLib.PDFDocumentLoadingTask | null>(null);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

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
  }, [bytes]);

  useEffect(
    () => () => {
      void loadingTaskRef.current?.destroy();
    },
    [],
  );

  // --- render pages (scale changes re-render everything) -------------------
  const renderPage = useCallback(
    async (page: PDFPageProxy, index: number, viewport: PageView["viewport"]) => {
      const canvas = canvasRefs.current[index];
      const layer = layerRefs.current[index];
      const wrap = pageWrapRefs.current[index];
      if (!canvas || !layer || !wrap) return;

      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      // pdfjs v6 renders with the canvas element directly.
      await page.render({ canvas, viewport }).promise;

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
    },
    [searchQuery],
  );

  useEffect(() => {
    // Re-render all pages when the zoom changes. Viewports are updated in
    // the ref and mirrored once into state; the effect itself only depends
    // on `scale`, so it cannot loop.
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
      <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
        <FileText className="size-10 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">{t("reader.pdfError")}</p>
        <p dir="ltr" className="max-w-md text-xs text-muted-foreground/70">
          {error}
        </p>
      </div>
    );
  }

  if (pages.length === 0) {
    return (
      <div className="flex h-full items-center justify-center">
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
          <ChevronLeft className="size-4" />
        </Button>
        <span className="text-xs text-muted-foreground" dir="ltr">
          {currentPage} / {pages.length}
        </span>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => goToPage(Math.min(pages.length, currentPage + 1))}
          aria-label={t("reader.nextPage")}
        >
          <ChevronRight className="size-4" />
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
        <span className="w-10 text-center text-xs text-muted-foreground" dir="ltr">
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
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => setSearchOpen(true)}
            aria-label={t("reader.searchInPdf")}
          >
            <Search className="size-4" />
          </Button>
        ) : (
          <div className="flex items-center gap-1.5">
            <Input
              ref={searchInputRef}
              autoFocus
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
              placeholder={t("reader.searchInPdf")}
              className="h-8 w-40 text-xs"
              dir="auto"
            />
            <span className="min-w-14 text-center text-xs text-muted-foreground" dir="ltr">
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
            <ChevronRight className="size-4" />
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
              className="relative shadow-sm"
              style={{ width: viewport.width }}
            >
              <canvas
                ref={(el) => {
                  canvasRefs.current[i] = el;
                }}
                width={viewport.width}
                height={viewport.height}
              />
              <div
                ref={(el) => {
                  layerRefs.current[i] = el;
                }}
                className="textLayer absolute inset-0"
              />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
