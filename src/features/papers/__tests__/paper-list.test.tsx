// @vitest-environment jsdom
// Plan 075 smoke: the papers feed virtualizes (50 papers do not mount
// 50 cards) and the first card still opens the reader.
import "@testing-library/jest-dom/vitest";
import "@/i18n";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("pdfjs-dist", () => ({
  getDocument: vi.fn(),
  GlobalWorkerOptions: { workerSrc: "" },
  TextLayer: class {},
}));

import { PaperList } from "@/features/papers/paper-list";
import type { Paper } from "@/lib/types";
import { useDigestStore } from "@/stores/digest";
import { useFavoritesStore } from "@/stores/favorites";
import { useHistoryStore } from "@/stores/history";
import { usePapersStore } from "@/stores/papers";
import { useReaderStore } from "@/stores/reader";
import { useUiStore } from "@/stores/ui";

const papers: Paper[] = Array.from({ length: 50 }, (_, i) => ({
  id: `2607.00${String(i).padStart(3, "0")}`,
  title: `Paper number ${i}`,
  authors: ["Jane Doe"],
  published: "2026-07-30T00:00:00Z",
  summary: `Abstract for paper ${i}.`,
  pdfUrl: `https://arxiv.org/pdf/2607.000${i}`,
  categories: ["cs.AI"],
}));

beforeEach(() => {
  localStorage.clear();
  Element.prototype.scrollIntoView = vi.fn(); // Radix Select in jsdom
  useUiStore.setState({ view: "papers" });
  useFavoritesStore.setState({ ids: [], byId: {}, loaded: true });
  useHistoryStore.setState({ entries: [], loaded: true });
  useDigestStore.setState({
    picks: { date: null, papers: [] },
    picksDismissed: false,
    backfillActive: false,
  } as never);
  usePapersStore.setState({
    papers,
    loading: false,
    error: null,
    query: "",
    category: "cs.AI",
    source: "arxiv",
    date: null,
  } as never);
});

describe("PaperList virtualization (plan 075)", () => {
  it("does not mount all 50 cards at once", () => {
    render(<PaperList />);
    // The virtualizer mounts the visible window plus overscan only.
    expect(screen.getByText("Paper number 0")).toBeInTheDocument();
    expect(screen.queryByText("Paper number 49")).not.toBeInTheDocument();
  });

  it("opens the reader from a mounted card", () => {
    const openSpy = vi.spyOn(useReaderStore.getState(), "open").mockResolvedValue(undefined);
    render(<PaperList />);

    fireEvent.click(screen.getAllByRole("button", { name: "Read" })[0]);

    expect(openSpy).toHaveBeenCalledWith(expect.objectContaining({ id: papers[0].id }));
    expect(useUiStore.getState().view).toBe("reader");
    openSpy.mockRestore();
  });
});
