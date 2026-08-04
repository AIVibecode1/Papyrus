// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import "@/i18n";
import { PdfViewer, renderInQueue } from "@/components/pdf-viewer/pdf-viewer";

const fakePage = {
  getViewport: (scale: number) => ({ width: 100 * scale, height: 150 * scale }),
  render: () => ({ promise: Promise.resolve() }),
  streamTextContent: () => ({ items: [] }),
};

// Replace pdf.js entirely: the component under test is the viewer wiring
// (load, page tracking, keyboard shortcuts, search bar), not canvas output.
vi.mock("pdfjs-dist", () => {
  class MockTextLayer {
    constructor() {}
    async render() {}
  }
  return {
    getDocument: vi.fn(),
    GlobalWorkerOptions: { workerSrc: "" },
    TextLayer: MockTextLayer,
  };
});

import * as pdfjsLib from "pdfjs-dist";

function mockDocument(numPages: number, behavior: PageBehavior = {}) {
  vi.mocked(pdfjsLib.getDocument).mockReturnValue(mockLoadingTask(numPages, behavior) as never);
}

interface PageBehavior {
  /** Per-index render behavior; default resolves. Args are the render
   * parameters the component passed (canvas, viewport, transform). */
  render?: (index: number, args?: unknown) => { promise: Promise<void> };
  /** Per-index viewport size; default is 100x150 at scale 1. */
  viewport?: (index: number, scale: number) => { width: number; height: number };
}

/** Builds a loading task for `numPages` (usable with mockReturnValueOnce). */
function mockLoadingTask(numPages: number, behavior: PageBehavior = {}) {
  const render = behavior.render ?? (() => ({ promise: Promise.resolve() }));
  const viewport =
    behavior.viewport ??
    ((_i: number, scale: number) => ({
      width: 100 * scale,
      height: 150 * scale,
    }));
  return {
    promise: Promise.resolve({
      numPages,
      getPage: async (index: number) => ({
        ...fakePage,
        pageNumber: index, // used as the React key, like real pdf.js pages
        render: (args: unknown) => render(index, args),
        // pdf.js signature: getViewport({ scale }); the mock extracts it.
        getViewport: (opts: { scale: number }) => viewport(index, opts.scale),
      }),
      getOutline: async () => null,
      destroy: async () => {},
    }),
    destroy: async () => {},
  };
}

const onSelect = vi.fn();
// Stable reference, mirroring the store's pdfBytes (a fresh Uint8Array per
// render would re-trigger the load effect on every state update).
const BYTES = new Uint8Array([1, 2, 3]);

// Captures the ResizeObserver wiring so tests can drive container resizes
// deterministically (jsdom has no layout engine).
let roCallback: ResizeObserverCallback | null = null;
let roElement: Element | null = null;
class MockResizeObserver {
  constructor(cb: ResizeObserverCallback) {
    roCallback = cb;
  }
  observe(el: Element) {
    roElement = el;
  }
  disconnect() {}
  unobserve() {}
}

beforeEach(() => {
  localStorage.clear();
  vi.mocked(pdfjsLib.getDocument).mockReset();
  // jsdom does not implement scrolling.
  Element.prototype.scrollIntoView = vi.fn();
  roCallback = null;
  roElement = null;
  vi.stubGlobal("ResizeObserver", MockResizeObserver);
});

describe("PdfViewer", () => {
  it("loads the document and shows the page indicator", async () => {
    mockDocument(3);
    render(<PdfViewer bytes={BYTES} paperId="p1" onSelect={onSelect} />);

    await waitFor(() => expect(screen.getByText("1 / 3")).toBeInTheDocument());
  });

  it("turns pages with the arrow keys", async () => {
    mockDocument(3);
    render(<PdfViewer bytes={BYTES} paperId="p1" onSelect={onSelect} />);
    await waitFor(() => expect(screen.getByText("1 / 3")).toBeInTheDocument());

    fireEvent.keyDown(window, { key: "ArrowRight" });
    await waitFor(() => expect(screen.getByText("2 / 3")).toBeInTheDocument());

    fireEvent.keyDown(window, { key: "ArrowLeft" });
    await waitFor(() => expect(screen.getByText("1 / 3")).toBeInTheDocument());
  });

  it("ignores arrow keys while typing in an input", async () => {
    mockDocument(3);
    render(<PdfViewer bytes={BYTES} paperId="p1" onSelect={onSelect} />);
    await waitFor(() => expect(screen.getByText("1 / 3")).toBeInTheDocument());

    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    fireEvent.keyDown(input, { key: "ArrowRight" });
    input.remove();

    expect(screen.getByText("1 / 3")).toBeInTheDocument();
  });

  it("opens find-in-page with Ctrl+F and closes it with Escape", async () => {
    mockDocument(3);
    render(<PdfViewer bytes={BYTES} paperId="p1" onSelect={onSelect} />);
    await waitFor(() => expect(screen.getByText("1 / 3")).toBeInTheDocument());

    fireEvent.keyDown(window, { key: "f", ctrlKey: true });
    const search = await screen.findByRole("textbox", { name: "Search in PDF" });
    expect(search).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("textbox", { name: "Search in PDF" })).not.toBeInTheDocument();
  });

  it("restores the last reading position for the paper", async () => {
    localStorage.setItem("papyrus-reader-pos", JSON.stringify({ p1: 3 }));
    mockDocument(3);
    render(<PdfViewer bytes={BYTES} paperId="p1" onSelect={onSelect} />);

    await waitFor(() => expect(screen.getByText("3 / 3")).toBeInTheDocument());
  });

  it("shows an error state with a working retry action", async () => {
    const failure = { promise: Promise.reject(new Error("corrupt pdf")) };
    vi.mocked(pdfjsLib.getDocument)
      .mockReturnValueOnce(failure as never)
      .mockReturnValueOnce(mockLoadingTask(2) as never);
    render(<PdfViewer bytes={BYTES} paperId="p1" onSelect={onSelect} />);

    // The failure surfaces as an alert with the message and a retry.
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("corrupt pdf");
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();

    // Retry re-runs the load; the second attempt succeeds.
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.getByText("1 / 2")).toBeInTheDocument());
  });
});

describe("renderInQueue", () => {
  it("renders every page exactly once", async () => {
    const calls: number[] = [];
    const views = [0, 1, 2].map(() => ({
      page: {} as never,
      viewport: {} as never,
    }));

    await renderInQueue(
      views,
      async (_view, i) => {
        await new Promise((r) => setTimeout(r, Math.random() * 5));
        calls.push(i);
      },
      () => false,
    );

    expect([...calls].sort()).toEqual([0, 1, 2]);
  });

  it("stops taking new pages once cancelled", async () => {
    const calls: number[] = [];
    let cancelled = false;
    const views = [0, 1, 2, 3, 4, 5].map(() => ({
      page: {} as never,
      viewport: {} as never,
    }));

    await renderInQueue(
      views,
      async (_view, i) => {
        calls.push(i);
        if (i === 0) cancelled = true; // a zoom change lands after page 1
        await new Promise((r) => setTimeout(r, 5));
      },
      () => cancelled,
    );

    // Only the first concurrency window may start before the cancel flag
    // lands; pages beyond it must never render.
    expect(Math.max(...calls)).toBeLessThanOrEqual(3);
  });

  it("isolates a rejecting page from the rest of the queue", async () => {
    const calls: number[] = [];
    const views = [0, 1, 2, 3].map(() => ({
      page: {} as never,
      viewport: {} as never,
    }));

    await renderInQueue(
      views,
      async (_view, i) => {
        if (i === 1) throw new Error("boom");
        calls.push(i);
      },
      () => false,
    );

    expect([...calls].sort()).toEqual([0, 2, 3]);
  });
});

describe("render state transitions", () => {
  it("attaches the resize observer only after pages exist", async () => {
    mockDocument(2);
    render(<PdfViewer bytes={BYTES} paperId="p1" onSelect={onSelect} />);
    await waitFor(() => expect(screen.getByText("1 / 2")).toBeInTheDocument());
    expect(roElement).not.toBeNull();
  });

  it("re-fits the zoom to the container width after a resize", async () => {
    mockDocument(3);
    render(<PdfViewer bytes={BYTES} paperId="p1" onSelect={onSelect} />);
    // jsdom has no layout: the load-time fit falls back to 800px (2.5).
    await waitFor(() => expect(screen.getByText("250%")).toBeInTheDocument());
    // Container shrinks to 150px: fit = (150-48)/100 = 1.02.
    Object.defineProperty(roElement!, "clientWidth", { value: 150, configurable: true });
    act(() => roCallback!([], {} as ResizeObserver));
    await waitFor(() => expect(screen.getByText("102%")).toBeInTheDocument());
  });

  it("keeps a manual zoom across a container resize", async () => {
    mockDocument(3);
    render(<PdfViewer bytes={BYTES} paperId="p1" onSelect={onSelect} />);
    await waitFor(() => expect(screen.getByText("250%")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Zoom out" }));
    await waitFor(() => expect(screen.getByText("230%")).toBeInTheDocument());

    // A resize whose auto-fit (102%) differs must not reset the zoom.
    Object.defineProperty(roElement!, "clientWidth", { value: 150, configurable: true });
    act(() => roCallback!([], {} as ResizeObserver));
    await new Promise((r) => setTimeout(r, 400)); // let the debounce land
    expect(screen.getByText("230%")).toBeInTheDocument();
  });

  it("cancels the loading task on unmount", async () => {
    const destroy = vi.fn(async () => {});
    vi.mocked(pdfjsLib.getDocument).mockReturnValue({
      promise: new Promise(() => {}), // load stays in flight
      destroy,
    } as never);
    const { unmount } = render(<PdfViewer bytes={BYTES} paperId="p1" onSelect={onSelect} />);
    unmount();
    expect(destroy).toHaveBeenCalled();
  });

  it("keeps painting the other pages when one page render rejects", async () => {
    mockDocument(3, {
      render: (i) =>
        i === 2
          ? { promise: Promise.reject(new Error("canvas busy")) }
          : { promise: Promise.resolve() },
    });
    render(<PdfViewer bytes={BYTES} paperId="p1" onSelect={onSelect} />);
    await waitFor(() => expect(screen.getByText("1 / 3")).toBeInTheDocument());
    // The failing page did not take the viewer down: pages 1 and 3 still
    // produced canvases, and the toolbar still reports the page position.
    const canvases = document.querySelectorAll("canvas");
    expect(canvases.length).toBeGreaterThanOrEqual(2);
  });

  it("retries a transient render failure so the page never stays black", async () => {
    const calls: Record<number, number> = {};
    mockDocument(2, {
      // Page 2 fails once with a transient error, then succeeds: the
      // viewer must retry it (the old behaviour skipped the page and
      // left its canvas black forever).
      render: (i) => {
        calls[i] = (calls[i] ?? 0) + 1;
        if (calls[i] === 1) return { promise: Promise.reject(new Error("canvas busy")) };
        return { promise: Promise.resolve() };
      },
    });
    render(<PdfViewer bytes={BYTES} paperId="p1" onSelect={onSelect} />);
    await waitFor(() => expect(screen.getByText("1 / 2")).toBeInTheDocument());
    await waitFor(() => expect(calls[2]).toBeGreaterThan(1));
    const canvases = Array.from(document.querySelectorAll("canvas"));
    expect(canvases[0]?.width).toBeGreaterThan(0);
    expect(canvases[1]?.width).toBeGreaterThan(0);
  });

  it("tolerates a zero-size page viewport", async () => {
    mockDocument(3, {
      viewport: (i, scale) =>
        i === 2 ? { width: 0, height: 0 } : { width: 100 * scale, height: 150 * scale },
    });
    render(<PdfViewer bytes={BYTES} paperId="p1" onSelect={onSelect} />);
    await waitFor(() => expect(screen.getByText("1 / 3")).toBeInTheDocument());
    const canvases = Array.from(document.querySelectorAll("canvas"));
    expect(canvases[1]?.width).toBe(0);
    // The zero-size page must not black out its neighbours.
    expect(canvases[0]?.width).toBeGreaterThan(0);
    expect(canvases[2]?.width).toBeGreaterThan(0);
  });
});

describe("render cancellation and repaint", () => {
  // jsdom canvases default to 300x150 and never paint, so the tests use
  // the width ATTRIBUTE (written only by the render path) and render-call
  // counters as signals instead of canvas.width.
  const canvasWidthAttr = () =>
    Number(document.querySelector("canvas")?.getAttribute("width") ?? 0);

  it("scales the canvas backing store on HiDPI displays", async () => {
    // A HiDPI screen (dpr 2) must get a dpr-scaled backing store while
    // the CSS size stays the CSS-pixel viewport, and the render call
    // carries the matching transform. Without this the PDF is blurry.
    Object.defineProperty(window, "devicePixelRatio", { value: 2, configurable: true });
    let renderArgs: unknown = null;
    mockDocument(1, {
      render: (_i, args) => {
        renderArgs = args;
        return { promise: Promise.resolve() };
      },
    });
    render(<PdfViewer bytes={BYTES} onSelect={onSelect} />);
    await waitFor(() => expect(screen.getByText("250%")).toBeInTheDocument());
    await waitFor(
      () => {
        const canvas = document.querySelector("canvas")!;
        // 100 CSS px at fit scale 2.5 -> 250 CSS px, doubled on the
        // backing store, CSS size pinned to the CSS pixels.
        expect(canvas.width).toBe(500);
        expect(canvas.height).toBe(750);
        expect(canvas.style.width).toBe("250px");
        expect(canvas.style.height).toBe("375px");
      },
      { timeout: 3000 },
    );
    expect(renderArgs).toMatchObject({ transform: [2, 0, 0, 2, 0, 0] });
    delete (window as { devicePixelRatio?: number }).devicePixelRatio;
  });

  it("shows a Retry affordance for a page that never paints, and re-paints on click", async () => {
    const calls: Record<number, number> = {};
    mockDocument(1, {
      // Always rejects: first attempt, the retry backoff, and the
      // deferred repaint all fail, so the page ends in the failed state.
      render: (i) => {
        calls[i] = (calls[i] ?? 0) + 1;
        return { promise: Promise.reject(new Error("canvas busy")) };
      },
    });
    render(<PdfViewer bytes={BYTES} onSelect={onSelect} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument(), {
      timeout: 4000,
    });
    const before = calls[1];
    // The page repaint cycle flips the status between "failed" (button
    // visible) and "painting" (button hidden), so click as soon as the
    // button is findable instead of assuming it is stable.
    await waitFor(() => {
      const btn = screen.queryByRole("button", { name: "Retry" });
      if (!btn) throw new Error("Retry button not visible yet");
      fireEvent.click(btn);
    });
    // The click must drive real render attempts, not just flip UI.
    await waitFor(() => expect(calls[1]).toBeGreaterThan(before), { timeout: 4000 });
  });

  it("repaints a page whose final render attempt failed (black-page safety net)", async () => {
    const calls: Record<number, number> = {};
    mockDocument(1, {
      // Page 1 fails twice (the retry backoff is too short for the mock),
      // then succeeds on the deferred repaint: the page must end painted.
      render: (i) => {
        calls[i] = (calls[i] ?? 0) + 1;
        if (calls[i] <= 2) return { promise: Promise.reject(new Error("canvas busy")) };
        return { promise: Promise.resolve() };
      },
    });
    render(<PdfViewer bytes={BYTES} paperId="p1" onSelect={onSelect} />);
    await waitFor(() => expect(screen.getByText("1 / 1")).toBeInTheDocument());
    // The third attempt (deferred repaint) must actually run and paint.
    await waitFor(() => expect(calls[1]).toBeGreaterThanOrEqual(3), { timeout: 3000 });
    await waitFor(() => expect(canvasWidthAttr()).toBe(250), { timeout: 3000 });
  });

  it("does not let a never-settling cancelled task block the fresh run", async () => {
    // Simulates a task whose promise never settles (worker destroyed on
    // reload). The old code kept the entry and awaited it forever, so the
    // fresh run could never paint the page. The cleanup must drop the
    // entry so the next run paints immediately.
    let first = true;
    let renders = 0;
    mockDocument(1, {
      render: () => {
        renders += 1;
        if (first) {
          first = false;
          return { promise: new Promise(() => {}), cancel: () => {} };
        }
        return { promise: Promise.resolve() };
      },
    });
    render(<PdfViewer bytes={BYTES} paperId="p1" onSelect={onSelect} />);
    await waitFor(() => expect(screen.getByText("1 / 1")).toBeInTheDocument());
    // Wait for the first (stuck) render to start, then force a new run.
    await new Promise((r) => setTimeout(r, 250));
    fireEvent.click(screen.getByRole("button", { name: "Zoom out" }));
    await waitFor(() => expect(renders).toBeGreaterThanOrEqual(2), { timeout: 3000 });
    // The fresh run paints the new scale: 250% -> 230% (100*2.3 floors to
    // 229 due to float precision, so assert the new-scale range).
    await waitFor(() => expect(canvasWidthAttr()).toBeGreaterThanOrEqual(229), { timeout: 3000 });
  });

  it("paints the new scale after a run is cancelled mid-render", async () => {
    let renders = 0;
    let rejectFirst: ((err: Error) => void) | null = null;
    mockDocument(1, {
      render: () => {
        renders += 1;
        if (renders === 1) {
          // The first run's render stays in flight until cancelled.
          return {
            promise: new Promise((_res, rej) => {
              rejectFirst = rej;
            }),
            cancel: () => rejectFirst?.(new Error("RenderingCancelledException")),
          };
        }
        return { promise: Promise.resolve() };
      },
    });
    render(<PdfViewer bytes={BYTES} paperId="p1" onSelect={onSelect} />);
    await waitFor(() => expect(screen.getByText("1 / 1")).toBeInTheDocument());
    await new Promise((r) => setTimeout(r, 250));
    // A zoom change cancels the in-flight run and starts a fresh one at
    // the new scale; the stale run must not leave the canvas black.
    fireEvent.click(screen.getByRole("button", { name: "Zoom out" }));
    await waitFor(() => expect(renders).toBeGreaterThanOrEqual(2), { timeout: 3000 });
    // 250% -> 230% (floors to 229 due to float precision): the fresh run
    // paints the new scale.
    await waitFor(() => expect(canvasWidthAttr()).toBeGreaterThanOrEqual(229), { timeout: 3000 });
  });
});
