// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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

function mockDocument(numPages: number) {
  vi.mocked(pdfjsLib.getDocument).mockReturnValue(mockLoadingTask(numPages) as never);
}

/** Builds a loading task for `numPages` (usable with mockReturnValueOnce). */
function mockLoadingTask(numPages: number) {
  return {
    promise: Promise.resolve({
      numPages,
      getPage: async () => fakePage,
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

beforeEach(() => {
  localStorage.clear();
  vi.mocked(pdfjsLib.getDocument).mockReset();
  // jsdom does not implement scrolling.
  Element.prototype.scrollIntoView = vi.fn();
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
  it("renders every page in order when not cancelled", async () => {
    const calls: number[] = [];
    const views = [{ page: {} as never, viewport: {} as never } as never, 1, 2].map(() => ({
      page: {} as never,
      viewport: {} as never,
    }));

    await renderInQueue(
      views,
      async (_view, i) => void calls.push(i),
      () => false,
    );

    expect(calls).toEqual([0, 1, 2]);
  });

  it("stops immediately once cancelled", async () => {
    const calls: number[] = [];
    let cancelled = false;
    const views = [{ page: {} as never, viewport: {} as never }, 1, 2].map(() => ({
      page: {} as never,
      viewport: {} as never,
    }));

    await renderInQueue(
      views,
      async (_view, i) => {
        calls.push(i);
        if (i === 1) cancelled = true; // a zoom change lands mid-run
      },
      () => cancelled,
    );

    expect(calls).toEqual([0, 1]); // page 2 never rendered
  });
});
