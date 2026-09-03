import type { PDFPageProxy } from "pdfjs-dist";

export interface PageView {
  page: PDFPageProxy;
  viewport: ReturnType<PDFPageProxy["getViewport"]>;
}

/**
 * Renders pages one at a time, checking cancellation before each page so a
 * newer run (zoom change, reopen) stops the old loop immediately instead
 * of finishing every canvas. Exported for unit tests.
 */
export async function renderInQueue(
  views: PageView[],
  render: (view: PageView, index: number) => Promise<void>,
  isCancelled: () => boolean,
  range?: { start: number; end: number },
): Promise<void> {
  // Render several pages concurrently: a strictly sequential queue paints
  // slowly on long PDFs, leaving scrolled-to pages black for seconds.
  // Each page takes a unique index before any await, so no page is
  // rendered twice; per-page failures are contained (renderPage catches).
  const CONCURRENCY = 4;
  const start = range?.start ?? 0;
  const end = range ? Math.min(range.end, views.length - 1) : views.length - 1;
  let next = start;
  const worker = async () => {
    while (!isCancelled()) {
      const i = next;
      next += 1;
      if (i > end) return;
      try {
        await render(views[i], i);
      } catch {
        // never let one page take down the run
      }
    }
  };
  const workers = Array.from({ length: Math.min(CONCURRENCY, Math.max(0, end - start + 1)) }, () =>
    worker(),
  );
  await Promise.all(workers);
}
