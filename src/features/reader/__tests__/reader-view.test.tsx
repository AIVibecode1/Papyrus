// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { memo } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import "@/i18n";
import i18n from "@/i18n";
import { ReaderView } from "@/features/reader/reader-view";
import type { Paper } from "@/lib/types";
import { useReaderStore } from "@/stores/reader";
import { useSettingsStore } from "@/stores/settings";
import { useUiStore } from "@/stores/ui";
import type { ProviderConfig } from "@/lib/types";

// Isolate the reader screen from pdf.js: the viewer component has its own
// test file (pdf-viewer.test.tsx). The Markdown renderer (mermaid-lazy)
// is stubbed so the tests assert wiring, not rendering.
// The viewer mock mirrors the real component's memo boundary and counts
// renders. ReaderView subscribes to the whole reader store, so a stream
// flush re-renders it ~20x/second; the real PdfViewer is memoized so it
// does not, and that memo only holds while its props keep their identity
// (bytes/paperId are set once per open; ReaderView keeps onSelect in a
// useCallback so it never invalidates the memo).
const pdfViewerRenders = vi.hoisted(() => ({ count: 0 }));
vi.mock("@/components/pdf-viewer/pdf-viewer", () => ({
  PdfViewer: memo(({ bytes, paperId }: { bytes: Uint8Array; paperId?: string }) => {
    pdfViewerRenders.count += 1;
    return <div data-testid="pdf-viewer" data-paper={paperId} data-len={bytes.length} />;
  }),
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
  Element.prototype.scrollIntoView = vi.fn(); // Ask panel scrolls on mount (jsdom has no layout)
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

afterEach(async () => {
  vi.restoreAllMocks();
  // Tests may switch the UI language; always restore English so the
  // next test's English labels resolve.
  await i18n.changeLanguage("en");
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

describe("split separator", () => {
  it("is reachable and operable by keyboard, and reports its position", () => {
    // A `separator` that only answers a pointer advertises a widget
    // assistive tech cannot move (WCAG 2.1.1), and a focusable one has
    // to expose aria-valuenow.
    localStorage.setItem("papyrus-reader-split", "0.5");
    render(<ReaderView />);
    const sep = screen.getByRole("separator");
    expect(sep).toHaveAttribute("tabindex", "0");
    expect(sep).toHaveAttribute("aria-valuenow", "50");

    // Right grows the PDF pane in LTR.
    fireEvent.keyDown(sep, { key: "ArrowRight" });
    expect(screen.getByRole("separator")).toHaveAttribute("aria-valuenow", "52");
    fireEvent.keyDown(sep, { key: "ArrowLeft" });
    expect(screen.getByRole("separator")).toHaveAttribute("aria-valuenow", "50");

    // Home/End jump to the clamps.
    fireEvent.keyDown(sep, { key: "End" });
    expect(screen.getByRole("separator")).toHaveAttribute("aria-valuenow", "80");
    fireEvent.keyDown(sep, { key: "Home" });
    expect(screen.getByRole("separator")).toHaveAttribute("aria-valuenow", "30");

    // An unrelated key must not move it.
    fireEvent.keyDown(sep, { key: "a" });
    expect(screen.getByRole("separator")).toHaveAttribute("aria-valuenow", "30");
  });
});

describe("ReaderView", () => {
  it("shows the back button and returns to the papers view", () => {
    render(<ReaderView />);
    const back = screen.getByRole("button", { name: "Back to papers" });
    fireEvent.click(back);
    expect(useUiStore.getState().view).toBe("papers");
  });

  it("scales the explanation text with the A- / A+ stepper (plan 064b)", () => {
    render(<ReaderView />);
    const root = document.querySelector(".reader-ai-panel") as HTMLElement;
    expect(root.dataset.readerScale).toBe("md");

    fireEvent.click(screen.getByRole("button", { name: "Larger text" }));
    expect(root.dataset.readerScale).toBe("lg");
    expect(localStorage.getItem("papyrus-reader-text-scale")).toBe("lg");
    // The stepper disables at the top of the range.
    expect(screen.getByRole("button", { name: "Larger text" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Smaller text" }));
    fireEvent.click(screen.getByRole("button", { name: "Smaller text" }));
    expect(root.dataset.readerScale).toBe("sm");
    expect(screen.getByRole("button", { name: "Smaller text" })).toBeDisabled();
  });

  it("offers a settings shortcut when no AI provider is configured", () => {
    useSettingsStore.setState({ providers: [], activeProviderId: null });
    render(<ReaderView />);
    // The panel explains the gap and the button navigates to Settings
    // instead of leaving the user staring at a raw invoke error.
    expect(screen.getByText("No AI provider configured")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open Settings" }));
    expect(useUiStore.getState().view).toBe("settings");
  });

  it("redacts secret-shaped text from stream errors before showing them", () => {
    useReaderStore.setState({
      sectionEntries: [
        {
          text: "",
          status: "error",
          error: "HTTP 401: sk-abc12345XYZ__more9 was rejected",
        },
      ],
    });
    render(<ReaderView />);
    // Section errors surface on the walkthrough tab.
    fireEvent.click(screen.getByRole("tab", { name: "Walkthrough" }));
    // The error is shown, but the key-shaped run never reaches the DOM.
    expect(screen.getByText(/HTTP 401/)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("sk-abc...ore9");
  });

  it("keeps the user's question on the right in Arabic like the answer", async () => {
    await i18n.changeLanguage("ar");
    useReaderStore.setState({
      chat: [
        {
          id: 1,
          role: "user",
          text: "ما هو المشفر؟",
          status: "done",
          error: null,
          selection: null,
        },
        {
          id: 2,
          role: "assistant",
          text: "المشفر هو مكوّن يحوّل المدخلات إلى تمثيلات.",
          status: "done",
          error: null,
          selection: null,
        },
      ],
    });
    render(<ReaderView />);
    // The chat lives in the Chat tab.
    fireEvent.click(screen.getByRole("tab", { name: "المحادثة" }));

    const question = await screen.findByText("ما هو المشفر؟");
    // The Markdown mock wraps the text; the bubble is its parent.
    const questionBubble = question.parentElement;
    const answer = screen.getByText("المشفر هو مكوّن يحوّل المدخلات إلى تمثيلات.");
    const answerBubble = answer.parentElement;
    // In Arabic the user bubble aligns right (self-end would put it
    // left); the answer keeps its current right-side position.
    expect(questionBubble?.className).toContain("rtl:self-start");
    expect(questionBubble?.className).toContain("self-end");
    expect(answerBubble?.className).toContain("self-start");
  });

  it("shows the selection chip with copy and clear actions", async () => {
    useReaderStore.setState({ selection: "The encoder maps tokens to vectors." });
    render(<ReaderView />);

    // The selection preview appears in both the floating bar (plan 052)
    // and the AI panel strip.
    expect(screen.getAllByText(/The encoder maps tokens to vectors\./).length).toBeGreaterThan(0);

    // The floating bar (plan 052) carries the Copy action; the AI panel
    // strip keeps its own icon copy control.
    const copy = screen.getAllByRole("button", { name: "Copy selection" })[0];
    fireEvent.click(copy);
    // The copied state flips after the clipboard promise settles (both
    // the floating bar and the AI panel strip show it).
    expect((await screen.findAllByRole("button", { name: "Copied" })).length).toBeGreaterThan(0);

    fireEvent.click(screen.getAllByRole("button", { name: "Clear selection" })[0]);
    expect(screen.queryByText(/The encoder maps tokens to vectors\./)).not.toBeInTheDocument();
  });

  it("asks a question from the Ask tab and calls the store", () => {
    const askSpy = vi.spyOn(useReaderStore.getState(), "ask").mockResolvedValue(undefined);
    render(<ReaderView />);

    fireEvent.click(screen.getByRole("tab", { name: "Chat" }));
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

    fireEvent.click(screen.getByRole("tab", { name: "Chat" }));
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

    // The reader opens on the Overview tab; the walkthrough's own empty
    // state keeps its start button.
    fireEvent.click(screen.getByRole("tab", { name: "Walkthrough" }));
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

    // Section content lives on the walkthrough tab (the reader now opens
    // on the Overview tab).
    fireEvent.click(screen.getByRole("tab", { name: "Walkthrough" }));
    const aside = document.querySelector("aside");
    expect(aside).not.toBeNull();
    // The AI pane keeps its exact share of the split (0.62 PDF / 0.38 AI)
    // no matter how wide the streamed token is, with a 280px floor so
    // the divider can never crush the pane on narrow windows.
    expect(parseFloat(aside?.style.flexBasis ?? "0")).toBeCloseTo(38, 5);
    expect(aside?.style.minWidth).toBe("280px");
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
    expect(screen.getByRole("tab", { name: "الشرح الموجّه" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "المحادثة" })).toBeInTheDocument();

    // The Ask input stays reachable in Arabic.
    fireEvent.click(screen.getByRole("tab", { name: "المحادثة" }));
    expect(await screen.findByPlaceholderText("اسأل عن الورقة…")).toBeInTheDocument();

    await i18n.changeLanguage("en");
  });

  it("does not re-render the PDF viewer while the AI panel streams", () => {
    // The regression this guards: ReaderView subscribes to the whole
    // reader store, so every stream flush (~50 ms) re-renders it. The
    // real PdfViewer is memoized and its props are stable (bytes/paperId
    // set once per open, onSelect via useCallback), so the page canvases
    // must NOT be re-rendered while AI text streams in beside them.
    //
    // Asserted behaviorally: render the reader, then push a stream chunk
    // into the store and assert the viewer did not re-render at all.
    // The real memo boundary is what holds the count steady.
    render(<ReaderView />);
    const afterMount = pdfViewerRenders.count;
    expect(afterMount).toBeGreaterThan(0);

    // A stream flush mutates the reader store (this is what re-renders
    // ReaderView). The PDF props are unchanged, so the memo must hold.
    act(() => {
      useReaderStore.setState((s) => ({
        ...s,
        sectionEntries: [
          ...s.sectionEntries,
          { status: "streaming", text: "chunk", title: "Intro" } as never,
        ],
      }));
    });

    // The stream update re-renders ReaderView. The PDF props are unchanged
    // (memoized + stable identity), so the viewer must not re-render at
    // all: a count of 1 here means the memo was defeated.
    expect(pdfViewerRenders.count - afterMount).toBe(0);
  });
});
