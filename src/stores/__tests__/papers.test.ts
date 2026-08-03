import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Paper } from "@/lib/types";

vi.mock("@/lib/arxiv", () => ({ fetchPapers: vi.fn() }));
vi.mock("@/lib/citations", () => ({ fetchCitations: vi.fn().mockResolvedValue({}) }));

import { fetchPapers } from "@/lib/arxiv";
import { fetchCitations } from "@/lib/citations";
import { usePapersStore } from "@/stores/papers";

const aiPaper: Paper = {
  id: "ai1",
  title: "AI paper",
  authors: ["A. Author"],
  published: "2026-01-01",
  summary: "About AI.",
  pdfUrl: "https://arxiv.org/pdf/1234.0001",
  categories: ["cs.AI"],
};

const lgPaper: Paper = {
  id: "lg1",
  title: "LG paper",
  authors: ["L. Author"],
  published: "2026-01-02",
  summary: "About learning.",
  pdfUrl: "https://arxiv.org/pdf/1234.0002",
  categories: ["cs.LG"],
};

describe("papers store", () => {
  let resolveFirst!: (papers: Paper[]) => void;
  let resolveSecond!: (papers: Paper[]) => void;

  beforeEach(() => {
    vi.mocked(fetchPapers).mockReset();
    // Start on a category other than cs.AI so setCategory("cs.AI") below
    // actually fires a refresh (setCategory no-ops on the same category).
    usePapersStore.setState({
      category: "cs.MATH",
      query: "",
      date: null,
      papers: [],
      loading: false,
      error: null,
      lastUpdated: null,
    });
  });

  it("ignores stale responses", async () => {
    let call = 0;
    vi.mocked(fetchPapers).mockImplementation(() => {
      call += 1;
      return new Promise<Paper[]>((resolve) => {
        if (call === 1) resolveFirst = resolve;
        else resolveSecond = resolve;
      });
    });

    usePapersStore.getState().setCategory("cs.AI");
    usePapersStore.getState().setCategory("cs.LG");

    // Resolve the FIRST (stale) request after the second one started:
    // its result must be dropped entirely.
    resolveFirst([aiPaper]);
    await Promise.resolve();

    const mid = usePapersStore.getState();
    expect(mid.papers).toEqual([]);
    expect(mid.loading).toBe(true);
    expect(mid.category).toBe("cs.LG");

    // The newest request still lands.
    resolveSecond([lgPaper]);
    await Promise.resolve();

    const after = usePapersStore.getState();
    expect(after.papers).toEqual([lgPaper]);
    expect(after.loading).toBe(false);
  });

  it("category switch clears papers immediately", () => {
    usePapersStore.setState({ papers: [aiPaper] });
    usePapersStore.getState().setCategory("cs.LG");

    const state = usePapersStore.getState();
    expect(state.papers).toEqual([]);
    expect(state.category).toBe("cs.LG");
  });

  it("setQuery triggers refresh with the query", async () => {
    const fetchMock = vi.mocked(fetchPapers).mockResolvedValue([aiPaper]);

    usePapersStore.getState().setQuery("transformer");

    // refresh() calls fetchPapers synchronously; the query must reach it.
    expect(fetchMock).toHaveBeenCalledWith("cs.MATH", 20, "transformer", undefined);
    await Promise.resolve();

    const state = usePapersStore.getState();
    expect(state.query).toBe("transformer");
    expect(state.papers).toEqual([aiPaper]);
    expect(state.loading).toBe(false);
  });

  it("setDate triggers refresh for that day", async () => {
    const fetchMock = vi.mocked(fetchPapers).mockResolvedValue([aiPaper]);

    usePapersStore.getState().setDate("2026-08-01");

    // The date must reach the fetch layer as the 4th argument.
    expect(fetchMock).toHaveBeenCalledWith("cs.MATH", 20, undefined, "2026-08-01");
    await Promise.resolve();

    const state = usePapersStore.getState();
    expect(state.date).toBe("2026-08-01");
    expect(state.papers).toEqual([aiPaper]);
    expect(state.loading).toBe(false);
  });

  it("setDate(null) returns to the latest view", async () => {
    const fetchMock = vi.mocked(fetchPapers).mockResolvedValue([aiPaper]);

    usePapersStore.getState().setDate("2026-08-01");
    usePapersStore.getState().setDate(null);

    expect(fetchMock).toHaveBeenLastCalledWith("cs.MATH", 20, undefined, undefined);
    await Promise.resolve();

    expect(usePapersStore.getState().date).toBeNull();
  });

  it("drops stale search responses", async () => {
    let call = 0;
    vi.mocked(fetchPapers).mockImplementation(() => {
      call += 1;
      return new Promise<Paper[]>((resolve) => {
        if (call === 1) resolveFirst = resolve;
        else resolveSecond = resolve;
      });
    });

    usePapersStore.getState().setQuery("transformer");
    usePapersStore.getState().setQuery("attention");

    // Resolve the FIRST (stale) search after the second one started:
    // its result must be dropped entirely.
    resolveFirst([aiPaper]);
    await Promise.resolve();

    const mid = usePapersStore.getState();
    expect(mid.papers).toEqual([]);
    expect(mid.loading).toBe(true);
    expect(mid.query).toBe("attention");

    // The newest search still lands.
    resolveSecond([lgPaper]);
    await Promise.resolve();

    const after = usePapersStore.getState();
    expect(after.papers).toEqual([lgPaper]);
    expect(after.loading).toBe(false);
  });

  it("loadMore appends the next page and dedupes", async () => {
    vi.mocked(fetchPapers)
      .mockResolvedValueOnce([aiPaper])
      .mockResolvedValueOnce([lgPaper, aiPaper]); // page 2 overlaps page 1

    usePapersStore.setState({ category: "cs.AI" });
    await usePapersStore.getState().refresh();
    expect(usePapersStore.getState().papers).toEqual([aiPaper]);

    await usePapersStore.getState().loadMore();

    // The duplicated aiPaper from page 2 must not appear twice.
    expect(usePapersStore.getState().papers).toEqual([aiPaper, lgPaper]);
    // Page 2 was requested with start = current length.
    expect(fetchPapers).toHaveBeenLastCalledWith("cs.AI", 20, undefined, undefined, 1);
    expect(usePapersStore.getState().loadingMore).toBe(false);
  });

  it("loadMore does nothing while loading", async () => {
    vi.mocked(fetchPapers).mockResolvedValue([aiPaper]);
    usePapersStore.setState({ category: "cs.AI", loading: true });

    await usePapersStore.getState().loadMore();

    expect(fetchPapers).toHaveBeenCalledTimes(0);
  });

  it("loadCitations stores the returned counts", async () => {
    vi.mocked(fetchCitations).mockResolvedValue({ ai1: 42 });
    usePapersStore.getState().loadCitations(["ai1", "unknown"]);
    await Promise.resolve();

    expect(usePapersStore.getState().citations).toEqual({ ai1: 42 });
  });

  it("refresh enriches the list with citation counts", async () => {
    vi.mocked(fetchPapers).mockResolvedValue([aiPaper]);
    vi.mocked(fetchCitations).mockResolvedValue({ ai1: 7 });

    usePapersStore.setState({ category: "cs.AI" });
    await usePapersStore.getState().refresh();
    await Promise.resolve();

    expect(fetchCitations).toHaveBeenCalledWith(["ai1"]);
    expect(usePapersStore.getState().citations).toEqual({ ai1: 7 });
  });
});
