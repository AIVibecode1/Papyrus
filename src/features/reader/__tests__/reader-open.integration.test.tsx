// Reader boundary integration test: ReaderView -> reader.open ->
// getPdfBytes -> ready -> PdfViewer, then walkthrough -> lazy extraction.
// Nothing here mocks away the store/viewer transition, and the pdf.js
// mock COUNTS getDocument calls so the duplicate-parse regression is
// measurable: opening the reader must parse the document once (viewer),
// not twice (viewer + eager text extraction).
// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import "@/i18n";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ReaderView } from "@/features/reader/reader-view";
import type { Paper, ProviderConfig } from "@/lib/types";
import { usePapersStore } from "@/stores/papers";
import { useReaderStore } from "@/stores/reader";
import { useSettingsStore } from "@/stores/settings";
import { useUiStore } from "@/stores/ui";

vi.mock("@/lib/pdf", () => ({ getPdfBytes: vi.fn() }));
vi.mock("@/lib/reader-ai", () => ({
  streamSectionExplanation: vi.fn(),
  streamSynthesis: vi.fn(),
  streamAsk: vi.fn(),
}));
vi.mock("@/lib/ai", () => ({
  CANCELLED_MARKER: "🛑PAPYRUS_CANCELLED",
  newOperationId: () => "test-op",
  stopExplanation: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

// A counted pdf.js: getDocument feeds BOTH the viewer and the text
// extractor, so its call count is the parse-count measurement.
const getDocumentCalls = vi.hoisted(() => vi.fn());
vi.mock("pdfjs-dist", () => {
  class MockTextLayer {
    constructor() {}
    async render() {}
  }
  return {
    getDocument: getDocumentCalls,
    GlobalWorkerOptions: { workerSrc: "" },
    TextLayer: MockTextLayer,
  };
});

import { getPdfBytes } from "@/lib/pdf";
import { streamSectionExplanation } from "@/lib/reader-ai";

const paper: Paper = {
  id: "2607.00001v1",
  title: "A Test Paper about Encoders",
  authors: ["A. Author"],
  published: "2026-07-30",
  summary: "A short summary.",
  pdfUrl: "https://arxiv.org/pdf/2607.00001v1",
  categories: ["cs.AI"],
};

const provider: ProviderConfig = {
  id: "mock-1",
  name: "Mock AI",
  baseUrl: "http://localhost:8765/v1",
  model: "mock-model",
};

function loadingTask(numPages: number) {
  return {
    promise: Promise.resolve({
      numPages,
      getPage: async (index: number) => ({
        pageNumber: index,
        getViewport: (opts: { scale: number }) => ({
          width: 100 * opts.scale,
          height: 150 * opts.scale,
        }),
        render: () => ({ promise: Promise.resolve() }),
        streamTextContent: () => ({ items: [] }),
        getTextContent: async () => ({ items: [{ str: `Page ${index} text about encoders` }] }),
        cleanup: async () => {},
      }),
      getOutline: async () => null,
      destroy: async () => {},
      cleanup: async () => {},
    }),
    destroy: async () => {},
  };
}

function chunkStream(chunks: string[]) {
  return vi.fn().mockImplementation(
    (opts: { onChunk: (c: string) => void }) =>
      new Promise<void>((resolve) => {
        for (const c of chunks) opts.onChunk(c);
        resolve();
      }),
  );
}

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  getDocumentCalls.mockReturnValue(loadingTask(2) as never);
  vi.mocked(getPdfBytes).mockResolvedValue(new Uint8Array([37, 80, 68, 70, 1, 2, 3]));
  Element.prototype.scrollIntoView = vi.fn();
  useUiStore.setState({ view: "reader" });
  useSettingsStore.setState({ providers: [provider], activeProviderId: provider.id });
  useReaderStore.setState({
    paper: null,
    pdfBytes: null,
    loadStatus: "idle",
    loadError: null,
    sections: [],
    extractStatus: "idle",
    extractError: null,
    sectionIndex: 0,
    sectionEntries: [],
    synthesis: null,
    chat: [],
    selection: null,
  });
});

describe("reader open boundary", () => {
  it("opens the PDF with a single parse and extracts text lazily on walkthrough", async () => {
    vi.mocked(streamSectionExplanation).mockImplementation(chunkStream(["mentor intro!"]));

    await useReaderStore.getState().open(paper);
    expect(useReaderStore.getState().loadStatus).toBe("ready");
    expect(getDocumentCalls).not.toHaveBeenCalled(); // no extraction at open

    render(<ReaderView />);
    await waitFor(() => expect(screen.getByText("1 / 2")).toBeInTheDocument());
    // The viewer is the only pdf.js consumer on the read path: ONE parse,
    // not one for the viewer plus one for eager text extraction.
    expect(getDocumentCalls).toHaveBeenCalledTimes(1);

    // The walkthrough tab shows the entry hint even before extraction.
    fireEvent.click(screen.getByRole("tab", { name: "Walkthrough" }));
    const hint = await screen.findByRole("button", { name: "Explain the whole paper" });
    expect(hint).toBeInTheDocument();

    // Starting the walkthrough triggers the lazy extraction (second parse)
    // and streams the first section explanation.
    fireEvent.click(hint);
    expect(await screen.findByText("mentor intro!")).toBeInTheDocument();
    expect(getDocumentCalls).toHaveBeenCalledTimes(2);
    expect(useReaderStore.getState().sections.length).toBeGreaterThan(0);
    expect(useReaderStore.getState().extractStatus).toBe("done");
  });

  it("shows the extraction error card and retries", async () => {
    // A PDF whose text cannot be read: the reader still opens (visual
    // reading works), but the walkthrough tab explains why. The viewer
    // parse (call 1) is a normal document; the extraction parse (call 2)
    // yields no text.
    getDocumentCalls.mockReturnValueOnce(loadingTask(1) as never).mockReturnValueOnce({
      promise: Promise.resolve({
        numPages: 1,
        getPage: async () => ({
          pageNumber: 1,
          getTextContent: async () => ({ items: [] }),
          cleanup: async () => {},
        }),
        cleanup: async () => {},
      }),
      destroy: async () => {},
    } as never);

    await useReaderStore.getState().open(paper);
    render(<ReaderView />);
    await waitFor(() => expect(screen.getByText("1 / 1")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("tab", { name: "Walkthrough" }));
    fireEvent.click(await screen.findByRole("button", { name: "Explain the whole paper" }));

    expect(await screen.findByText(/No readable text could be extracted/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it("reopens with chat history intact and prefills the papers search from the overview (continuity)", async () => {
    // A previous session left a chat for this paper (localStorage); the
    // notes store hydrates independently and never blocks the reader.
    localStorage.setItem(
      "papyrus-reader-chat-v1",
      JSON.stringify({
        [paper.id]: [
          {
            id: 1,
            role: "user",
            text: "What is an encoder?",
            status: "done",
            error: null,
            selection: null,
          },
          {
            id: 2,
            role: "assistant",
            text: "It maps tokens to vectors.",
            status: "done",
            error: null,
            selection: null,
          },
        ],
      }),
    );

    await useReaderStore.getState().open(paper);
    render(<ReaderView />);
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: "Overview" })).toHaveAttribute(
        "aria-selected",
        "true",
      ),
    );

    // The overview is the landing tab and shows the abstract.
    expect(screen.getByText(paper.summary)).toBeInTheDocument();

    // Chat history for this paper restored on the Chat tab.
    fireEvent.click(screen.getByRole("tab", { name: "Chat" }));
    expect(screen.getByText("What is an encoder?")).toBeInTheDocument();

    // Search-this-title jumps to the papers view with the title field
    // preselected on Semantic Scholar (plan 045 WU4).
    fireEvent.click(screen.getByRole("tab", { name: "Overview" }));
    fireEvent.click(screen.getByRole("button", { name: "Search title on Semantic Scholar" }));

    const papers = usePapersStore.getState();
    expect(useUiStore.getState().view).toBe("papers");
    expect(papers.source).toBe("semanticscholar");
    expect(papers.searchField).toBe("title");
    expect(papers.query).toBe(paper.title);
  });
});
