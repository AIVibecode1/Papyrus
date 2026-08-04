// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import "@/i18n";
import { ReaderView } from "@/features/reader/reader-view";
import type { Paper } from "@/lib/types";
import { useReaderStore } from "@/stores/reader";
import { useSettingsStore } from "@/stores/settings";
import { useUiStore } from "@/stores/ui";
import type { ProviderConfig } from "@/lib/types";

// Isolate the reader screen from pdf.js: the viewer component has its own
// test file (pdf-viewer.test.tsx). The Markdown renderer (mermaid-lazy)
// is stubbed so the tests assert wiring, not rendering.
vi.mock("@/components/pdf-viewer/pdf-viewer", () => ({
  PdfViewer: () => <div data-testid="pdf-viewer" />,
}));
vi.mock("@/components/markdown/markdown", () => ({
  Markdown: ({ children }: { children: string }) => <div data-testid="markdown">{children}</div>,
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
// The reader store imports pdf-text, which imports pdfjs-dist at module
// level; jsdom lacks DOMMatrix. The viewer itself is mocked above, so a
// stub module is enough to satisfy the import chain.
vi.mock("pdfjs-dist", () => ({
  getDocument: vi.fn(),
  GlobalWorkerOptions: { workerSrc: "" },
  TextLayer: class {},
}));

const paper: Paper = {
  id: "2607.00001v1",
  title: "A Test Paper about Encoders",
  authors: ["A. Author", "B. Author"],
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

beforeEach(() => {
  localStorage.clear();
  useUiStore.setState({ view: "reader" });
  useSettingsStore.setState({ providers: [provider], activeProviderId: provider.id });
  useReaderStore.setState({
    paper,
    pdfBytes: new Uint8Array([37, 80, 68, 70]),
    loadStatus: "ready",
    loadError: null,
    sections: ["Section one about encoders", "Section two about attention"],
    sectionEntries: [],
    synthesis: null,
    chat: [],
    selection: null,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

import { clampSplit } from "@/features/reader/reader-view";

describe("clampSplit", () => {
  it("clamps to the 0.3-0.8 range and falls back for garbage", () => {
    expect(clampSplit(0.5)).toBe(0.5);
    expect(clampSplit(0.9)).toBe(0.8);
    expect(clampSplit(0.1)).toBe(0.3);
    expect(clampSplit(Number.NaN)).toBe(0.62);
    expect(clampSplit(Number.POSITIVE_INFINITY)).toBe(0.62);
  });
});

describe("ReaderView", () => {
  it("shows the back button and returns to the papers view", () => {
    render(<ReaderView />);
    const back = screen.getByRole("button", { name: "Back to papers" });
    fireEvent.click(back);
    expect(useUiStore.getState().view).toBe("papers");
  });

  it("shows the selection chip with copy and clear actions", async () => {
    useReaderStore.setState({ selection: "The encoder maps tokens to vectors." });
    render(<ReaderView />);

    expect(screen.getByText(/The encoder maps tokens to vectors\./)).toBeInTheDocument();

    const copy = screen.getByRole("button", { name: "Copy selection" });
    fireEvent.click(copy);
    // The copied state flips after the clipboard promise settles.
    expect(await screen.findByRole("button", { name: "Copied" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Clear selection" }));
    expect(screen.queryByText(/The encoder maps tokens to vectors\./)).not.toBeInTheDocument();
  });

  it("asks a question from the Ask tab and calls the store", () => {
    const askSpy = vi.spyOn(useReaderStore.getState(), "ask").mockResolvedValue(undefined);
    render(<ReaderView />);

    fireEvent.click(screen.getByRole("button", { name: "Ask" }));
    const input = screen.getByPlaceholderText("Ask about the paper…");
    fireEvent.change(input, { target: { value: "What is an embedding?" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(askSpy).toHaveBeenCalledWith("What is an embedding?", provider, "en");
  });

  it("offers a retry action on a failed answer", () => {
    const retrySpy = vi.spyOn(useReaderStore.getState(), "retryAsk").mockResolvedValue(undefined);
    useReaderStore.setState({
      chat: [
        {
          id: 1,
          role: "user",
          text: "Why does this work?",
          status: "done",
          error: null,
          selection: null,
        },
        {
          id: 2,
          role: "assistant",
          text: "",
          status: "error",
          error: "provider down",
          selection: null,
        },
      ],
    });
    render(<ReaderView />);

    fireEvent.click(screen.getByRole("button", { name: "Ask" }));
    expect(screen.getByText("provider down")).toBeInTheDocument();

    const retry = screen.getByRole("button", { name: "Retry answer" });
    fireEvent.click(retry);
    expect(retrySpy).toHaveBeenCalledWith(provider, "en");
  });

  it("starts the whole-paper walkthrough from the walkthrough tab", () => {
    const startSpy = vi
      .spyOn(useReaderStore.getState(), "startWalkthrough")
      .mockResolvedValue(undefined);
    render(<ReaderView />);

    fireEvent.click(screen.getByRole("button", { name: "Explain the whole paper" }));

    expect(startSpy).toHaveBeenCalledWith(provider, "en");
  });

  it("renders the mocked PDF viewer when the paper is loaded", () => {
    render(<ReaderView />);
    expect(screen.getByTestId("pdf-viewer")).toBeInTheDocument();
  });

  it("keeps the desktop split ratio while streaming a long unbreakable token", () => {
    // Desktop layout: matchMedia reports a wide viewport.
    window.matchMedia = vi.fn().mockReturnValue({
      matches: true,
      media: "(min-width: 1024px)",
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      onchange: null,
      dispatchEvent: vi.fn(),
    }) as never;

    const longToken = "SuperLongUnbreakableToken".repeat(60);
    useReaderStore.setState({
      sectionEntries: [{ text: longToken, status: "streaming", error: null }],
    });
    render(<ReaderView />);

    const aside = document.querySelector("aside");
    expect(aside).not.toBeNull();
    // The AI pane keeps its exact share of the split (0.62 PDF / 0.38 AI)
    // no matter how wide the streamed token is.
    expect(parseFloat(aside?.style.flexBasis ?? "0")).toBeCloseTo(38, 5);
    expect(aside?.className).toContain("min-w-0");
    expect(screen.getByRole("separator")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument();
    expect(aside?.textContent).toContain("SuperLongUnbreakableToken");
    expect(parseFloat(aside?.style.flexBasis ?? "0")).toBeCloseTo(38, 5);
  });

  it("renders Arabic labels and the pinned Ask input in the narrow layout", async () => {
    // Narrow layout: matchMedia reports a small viewport.
    window.matchMedia = vi.fn().mockReturnValue({
      matches: false,
      media: "(min-width: 1024px)",
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      onchange: null,
      dispatchEvent: vi.fn(),
    }) as never;

    const { default: i18n } = await import("@/i18n");
    await i18n.changeLanguage("ar");
    render(<ReaderView />);

    // No desktop split separator on narrow windows.
    expect(screen.queryByRole("separator")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "الشرح الموجّه" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "اسأل" })).toBeInTheDocument();

    // The Ask input stays reachable in Arabic.
    fireEvent.click(screen.getByRole("button", { name: "اسأل" }));
    expect(await screen.findByPlaceholderText("اسأل عن الورقة…")).toBeInTheDocument();

    await i18n.changeLanguage("en");
  });
});
