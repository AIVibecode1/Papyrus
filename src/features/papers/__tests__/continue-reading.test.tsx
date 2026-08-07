// @vitest-environment jsdom
// Plan 073: the Continue-reading strip. Same pdfjs stub as the other
// reader-surface tests (the reader store's import chain reaches
// pdfjs-dist at module level).
import "@testing-library/jest-dom/vitest";
import "@/i18n";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("pdfjs-dist", () => ({
  getDocument: vi.fn(),
  GlobalWorkerOptions: { workerSrc: "" },
  TextLayer: class {},
}));

import { ContinueReading } from "@/features/papers/continue-reading";
import { useHistoryStore } from "@/stores/history";
import { useReaderStore } from "@/stores/reader";
import { useUiStore } from "@/stores/ui";

const entry = (paperId: string, title: string, lastPage?: number) => ({
  paperId,
  title,
  authors: ["A. Author"],
  published: "2024-01-01",
  pdfUrl: `https://arxiv.org/pdf/${paperId}`,
  categories: ["cs.CL"],
  source: "arxiv" as const,
  lastOpenedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
  ...(lastPage !== undefined ? { lastPage } : {}),
});

beforeEach(() => {
  localStorage.clear();
  useHistoryStore.setState({ entries: [], loaded: true });
  useUiStore.setState({ view: "papers" });
});

describe("ContinueReading", () => {
  it("renders nothing without history entries", () => {
    const { container } = render(<ContinueReading />);
    expect(container.firstChild).toBeNull();
  });

  it("shows at most the three newest entries with the page when known", () => {
    useHistoryStore.setState({
      // The store keeps entries newest-first.
      entries: [
        entry("p4", "Fourth paper", 7),
        entry("p3", "Third paper"),
        entry("p2", "Second paper"),
        entry("p1", "First paper", 3),
      ],
      loaded: true,
    });
    render(<ContinueReading />);
    expect(screen.getByText("Continue reading")).toBeInTheDocument();
    // Only the three newest entries render.
    expect(screen.getByText("Fourth paper")).toBeInTheDocument();
    expect(screen.queryByText("First paper")).not.toBeInTheDocument();
    // Page labels appear only for entries that carry one.
    expect(screen.getByText("p. 7")).toBeInTheDocument();
    expect(screen.queryByText("p. 3")).not.toBeInTheDocument();
  });

  it("opens the reader through the same path as the history list", () => {
    const openSpy = vi.spyOn(useReaderStore.getState(), "open").mockResolvedValue(undefined);
    useHistoryStore.setState({ entries: [entry("p1", "Resume me", 5)], loaded: true });

    render(<ContinueReading />);
    fireEvent.click(screen.getByRole("button", { name: /Resume me/ }));

    expect(openSpy).toHaveBeenCalledWith(expect.objectContaining({ id: "p1", title: "Resume me" }));
    expect(useUiStore.getState().view).toBe("reader");
    openSpy.mockRestore();
  });
});
