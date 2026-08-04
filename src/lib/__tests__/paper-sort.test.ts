import { describe, expect, it } from "vitest";

import { sortPapers } from "@/lib/paper-sort";
import type { Paper } from "@/lib/types";

function paper(id: string): Paper {
  return {
    id,
    title: `Paper ${id}`,
    authors: [],
    published: "2026-07-30",
    summary: "",
    pdfUrl: `https://arxiv.org/pdf/${id}`,
    categories: ["cs.AI"],
  };
}

describe("sortPapers", () => {
  it("keeps the feed order in newest mode", () => {
    const list = [paper("a"), paper("b"), paper("c")];
    expect(sortPapers(list, { b: 99 }, "newest")).toBe(list);
  });

  it("sorts by citation count descending in cited mode", () => {
    const list = [paper("a"), paper("b"), paper("c")];
    const sorted = sortPapers(list, { a: 5, b: 900, c: 42 }, "cited");
    expect(sorted.map((p) => p.id)).toEqual(["b", "c", "a"]);
  });

  it("moves papers without a known count to the bottom", () => {
    const list = [paper("a"), paper("b"), paper("c")];
    const sorted = sortPapers(list, { b: 900 }, "cited");
    expect(sorted.map((p) => p.id)).toEqual(["b", "a", "c"]);
  });

  it("keeps ties stable and leaves an empty list alone", () => {
    const list = [paper("a"), paper("b")];
    expect(sortPapers(list, { a: 7, b: 7 }, "cited").map((p) => p.id)).toEqual(["a", "b"]);
    expect(sortPapers([], {}, "cited")).toEqual([]);
  });
});
