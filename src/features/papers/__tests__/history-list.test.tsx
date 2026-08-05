// @vitest-environment jsdom
// Plan 060: the history surface. Importing the component pulls in the
// reader store (pdf.js), so the same module mocks the reader tests use
// are applied here.
import "pdfjs-dist";
import "@testing-library/jest-dom/vitest";
import "@/i18n";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { HistoryList, relativeOpened } from "@/features/papers/history-list";
import { useFavoritesStore } from "@/stores/favorites";
import { useHistoryStore } from "@/stores/history";
import { useReaderStore } from "@/stores/reader";
import { useUiStore } from "@/stores/ui";

// pdf.js touches DOMMatrix, which jsdom does not implement.
class DOMMatrixMock {
  a = 1;
  b = 0;
  c = 0;
  d = 1;
  e = 0;
  f = 0;
  m11 = 1;
  m12 = 0;
  m13 = 0;
  m14 = 0;
  m21 = 0;
  m22 = 1;
  m23 = 0;
  m24 = 0;
  m31 = 0;
  m32 = 0;
  m33 = 1;
  m34 = 0;
  m41 = 0;
  m42 = 0;
  m43 = 0;
  m44 = 1;
  multiply() {
    return this;
  }
  translate() {
    return this;
  }
  scale() {
    return this;
  }
  invert() {
    return this;
  }
}

beforeEach(() => {
  vi.stubGlobal("DOMMatrix", DOMMatrixMock);
  vi.stubGlobal("DOMPoint", class {});
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
          lastOpenedAt: new Date().toISOString(),
        },
      ],
    });
    const openSpy = vi.spyOn(useReaderStore.getState(), "open").mockResolvedValue(undefined);

    render(<HistoryList />);
    expect(screen.getByText("Attention Is All You Need")).toBeInTheDocument();
    expect(screen.getByText(/Opened .*ago/)).toBeInTheDocument();

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

describe("relativeOpened", () => {
  it("produces a relative label in the given language", () => {
    const twoHours = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    expect(relativeOpened(twoHours, "en")).toBe("2 hours ago");
    expect(relativeOpened(twoHours, "ar")).toContain("ساعة");
  });

  it("falls back to the raw value for unparseable dates", () => {
    expect(relativeOpened("not-a-date", "en")).toBe("not-a-date");
  });
});
