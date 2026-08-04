import { describe, expect, it } from "vitest";

import { PICKS_LIMIT, pickPapers } from "@/lib/picks";
import type { Paper } from "@/lib/types";

function paper(id: string, title = `Paper ${id}`): Paper {
  return {
    id,
    title,
    authors: [],
    published: "2026-07-30",
    summary: "",
    pdfUrl: `https://arxiv.org/pdf/${id}`,
    categories: ["cs.AI"],
  };
}

function day(papers: Paper[]): Record<string, Paper[]> {
  return { "2026-08-01": papers };
}

describe("pickPapers", () => {
  it("returns the newest day's papers in feed order", () => {
    const byCategory = {
      "cs.AI": {
        "2026-07-30": [paper("a"), paper("b")],
        "2026-08-01": [paper("c"), paper("d")],
      },
    };
    const picks = pickPapers(byCategory, "cs.AI");
    expect(picks.date).toBe("2026-08-01");
    // Fewer than the limit on the newest day: spill into older days,
    // newest first, until the strip is full or history runs out.
    expect(picks.papers.map((p) => p.id)).toEqual(["c", "d", "a", "b"]);
  });

  it("caps at five papers and spills into older days when needed", () => {
    const byCategory = {
      "cs.AI": {
        "2026-08-01": [paper("a"), paper("b")],
        "2026-07-31": [paper("c"), paper("d"), paper("e"), paper("f"), paper("g")],
      },
    };
    const picks = pickPapers(byCategory, "cs.AI");
    expect(picks.papers).toHaveLength(PICKS_LIMIT);
    expect(picks.papers.map((p) => p.id)).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("never duplicates a paper across days", () => {
    const byCategory = {
      "cs.AI": {
        "2026-08-01": [paper("a"), paper("dup")],
        "2026-07-31": [paper("dup"), paper("b"), paper("c"), paper("d"), paper("e")],
      },
    };
    const picks = pickPapers(byCategory, "cs.AI");
    const ids = picks.papers.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(["a", "dup", "b", "c", "d"]);
  });

  it("returns fewer than five when history is thin", () => {
    const byCategory = { "cs.AI": day([paper("only")]) };
    const picks = pickPapers(byCategory, "cs.AI");
    expect(picks.papers.map((p) => p.id)).toEqual(["only"]);
  });

  it("returns empty for a category without history", () => {
    expect(pickPapers({}, "cs.LG")).toEqual({ date: null, papers: [] });
    expect(pickPapers({ "cs.AI": {} }, "cs.AI").papers).toEqual([]);
  });

  it("does not leak papers between categories", () => {
    const byCategory = {
      "cs.AI": day([paper("ai-1")]),
      "cs.LG": day([paper("lg-1")]),
    };
    expect(pickPapers(byCategory, "cs.AI").papers.map((p) => p.id)).toEqual(["ai-1"]);
    expect(pickPapers(byCategory, "cs.LG").papers.map((p) => p.id)).toEqual(["lg-1"]);
  });
});
