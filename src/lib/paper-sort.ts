import type { Paper } from "@/lib/types";

export type PaperSortMode = "newest" | "cited";

/**
 * Orders a loaded paper list. "newest" keeps the feed order (arXiv and
 * Semantic Scholar already return newest/relevance first). "cited"
 * reorders by the citation counts already fetched for the list,
 * descending; papers without a known count stay at the bottom (same
 * contract as the APIs: undefined sort values sort last). Stable for
 * ties, so equal-count papers keep their feed order.
 */
export function sortPapers(
  papers: Paper[],
  citations: Record<string, number>,
  mode: PaperSortMode,
): Paper[] {
  if (mode === "newest") return papers;
  const known = papers.filter((p) => (citations[p.id] ?? 0) > 0);
  const unknown = papers.filter((p) => (citations[p.id] ?? 0) <= 0);
  known.sort((a, b) => (citations[b.id] ?? 0) - (citations[a.id] ?? 0));
  return [...known, ...unknown];
}
