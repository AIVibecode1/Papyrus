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
  /** Per-index render behavior; default resolves. */
  render?: (index: number) => { promise: Promise<void> };
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
        render: () => render(index),
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
