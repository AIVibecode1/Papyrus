// @vitest-environment jsdom
// Plan 060: the history surface. Importing the component pulls in the
// reader store, whose import chain reaches pdfjs-dist at module level;
// jsdom lacks DOMMatrix, so the established stub module (same as
// reader-view.test.tsx) satisfies the chain.
import "@testing-library/jest-dom/vitest";
import "@/i18n";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("pdfjs-dist", () => ({
  getDocument: vi.fn(),
  GlobalWorkerOptions: { workerSrc: "" },
  TextLayer: class {},
}));

import { HistoryList } from "@/features/papers/history-list";
import { useFavoritesStore } from "@/stores/favorites";
import { useHistoryStore } from "@/stores/history";
import { useReaderStore } from "@/stores/reader";
import { useUiStore } from "@/stores/ui";

beforeEach(() => {
  localStorage.clear();
  useHistoryStore.setState({ entries: [], loaded: true });
  useFavoritesStore.setState({ ids: [], byId: {}, loaded: true });
  useUiStore.setState({ view: "papers" });
});

describe("HistoryList", () => {
  it("shows the empty state when nothing was opened", () => {
    render(<HistoryList />);
    expect(screen.getByText("Papers you open will show up here.")).toBeInTheDocument();
  });

  it("lists entries and opens the reader through the same path", async () => {
    useHistoryStore.setState({
      entries: [
        {
          paperId: "p1",
          title: "Attention Is All You Need",
          authors: ["Ashish Vaswani"],
          published: "2017-06-12",
          pdfUrl: "https://arxiv.org/pdf/1706.03762",
          categories: ["cs.CL"],
          source: "arxiv",
          // Deterministic: exactly two hours ago so the label is stable.
          lastOpenedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
        },
      ],
    });
    const openSpy = vi.spyOn(useReaderStore.getState(), "open").mockResolvedValue(undefined);

    render(<HistoryList />);
    expect(screen.getByText("Attention Is All You Need")).toBeInTheDocument();
    expect(screen.getByText(/Opened 2 hours ago/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Open paper" }));
    // The Open action navigates to the reader view.
    expect(useUiStore.getState().view).toBe("reader");
    expect(openSpy).toHaveBeenCalled();
  });

  it("saves to favorites without touching history", () => {
    useHistoryStore.setState({
      entries: [
        {
          paperId: "p1",
          title: "A paper",
          authors: [],
          published: "",
          pdfUrl: "https://arxiv.org/pdf/p1",
          categories: [],
          lastOpenedAt: "2026-08-01T00:00:00Z",
        },
      ],
    });

    render(<HistoryList />);
    fireEvent.click(screen.getByRole("button", { name: "Save to favorites" }));
    expect(useFavoritesStore.getState().ids).toContain("p1");
    expect(useHistoryStore.getState().entries).toHaveLength(1);
  });

  it("removes an entry from history", () => {
    useHistoryStore.setState({
      entries: [
        {
          paperId: "p1",
          title: "A paper",
          authors: [],
          published: "",
          pdfUrl: "https://arxiv.org/pdf/p1",
          categories: [],
          lastOpenedAt: "2026-08-01T00:00:00Z",
        },
      ],
    });

    render(<HistoryList />);
    fireEvent.click(screen.getByRole("button", { name: "Remove from history" }));
    expect(useHistoryStore.getState().entries).toEqual([]);
  });
});
