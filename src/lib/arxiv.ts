import { invoke } from "@tauri-apps/api/core";
import type { Paper } from "@/lib/types";

export const ARXIV_CATEGORIES = [
  { code: "cs.AI", key: "categories.csAI" },
  { code: "cs.LG", key: "categories.csLG" },
  { code: "cs.CL", key: "categories.csCL" },
  { code: "cs.CV", key: "categories.csCV" },
  { code: "cs.NE", key: "categories.csNE" },
  { code: "stat.ML", key: "categories.statML" },
] as const;

export type CategoryCode = (typeof ARXIV_CATEGORIES)[number]["code"];

/**
 * Fetches papers for a category. When `query` is given, the category is
 * ignored and arXiv's `all:` field (title, abstract, authors) is searched
 * instead. When `date` (YYYY-MM-DD) is given, only papers submitted on
 * that day are returned.
 *
 * Inside the desktop app this calls the Rust backend (`fetch_papers` command),
 * which talks to the arXiv API, parses the Atom XML and enforces rate limits.
 *
 * In a plain browser (e.g. the Vite dev server outside Tauri) `invoke` does not
 * exist and arXiv's API sends no CORS headers, so we serve the bundled sample
 * papers from `src/dev/mock-papers.json` (real arXiv data, captured at build time).
 * A search query filters the concatenation of all categories, and a date
 * filters by the published day.
 */
export async function fetchPapers(
  category: string,
  maxResults = 20,
  query?: string,
  date?: string,
  start = 0,
): Promise<Paper[]> {
  if ("__TAURI_INTERNALS__" in window) {
    return invoke<Paper[]>("fetch_papers", { category, maxResults, query, date, start });
  }

  if (import.meta.env.DEV) {
    const mod = await import("@/dev/mock-papers.json");
    const byCategory = mod.default as Record<string, Paper[]>;
    const q = query?.trim().toLowerCase();
    let papers = q
      ? Object.values(byCategory)
          .flat()
          .filter((p) => p.title.toLowerCase().includes(q) || p.summary.toLowerCase().includes(q))
      : (byCategory[category] ?? []);
    if (date) papers = papers.filter((p) => p.published.startsWith(date));
    return papers.slice(0, maxResults);
  }

  throw new Error("Papers can only be fetched inside the desktop app.");
}
