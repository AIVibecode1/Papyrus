import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Paper } from "@/lib/types";

vi.mock("@/lib/arxiv", () => ({ fetchPapers: vi.fn() }));

import { fetchPapers } from "@/lib/arxiv";
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
});
