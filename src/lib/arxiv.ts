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

export type PaperSource = "arxiv" | "semanticscholar";

/**
 * How the backend interprets the free-text query (plan 041). `id` is the
 * exact arXiv id lookup.
 */
export type SearchField = "all" | "title" | "author" | "abstract" | "id";

export interface FetchPapersResult {
  papers: Paper[];
  /** Set when a non-arXiv source failed and arXiv served the list. */
  fallbackNote: string | null;
}

/**
 * Fetches papers from the chosen source. `arxiv` browses categories and
 * searches fielded terms; `semanticscholar` is search-only and returns
 * citation counts, TLDRs and venues. Inside the desktop app this calls
 * the Rust backend, which enforces per-source rate limits, sanitizes
 * query grammar and falls back to arXiv when a non-arXiv source fails.
 *
 * In a plain browser (Vite dev server outside Tauri) the bundled sample
 * papers are served for arXiv; non-arXiv sources return an empty list
 * (the mock has no S2 data — see the spike §3.1).
 */
export async function fetchPapers(
  category: string,
  maxResults = 20,
  query?: string,
  date?: string,
  start = 0,
  source: PaperSource = "arxiv",
  field: SearchField = "all",
  yearFrom?: number,
  yearTo?: number,
  limitToCategory = true,
): Promise<FetchPapersResult> {
  if ("__TAURI_INTERNALS__" in window) {
    return invoke<[Paper[], string | null]>("fetch_papers", {
      category,
      maxResults,
      query,
      date,
      start,
      source,
      field,
      yearFrom,
      yearTo,
      limitToCategory,
    }).then(([papers, fallbackNote]) => ({ papers, fallbackNote }));
  }

  if (import.meta.env.DEV) {
    if (source !== "arxiv") {
      return { papers: [], fallbackNote: null };
    }
    const mod = await import("@/dev/mock-papers.json");
    const byCategory = mod.default as Record<string, Paper[]>;
    const q = query?.trim().toLowerCase();
    let papers = q
      ? Object.values(byCategory)
          .flat()
          .filter((p) => p.title.toLowerCase().includes(q) || p.summary.toLowerCase().includes(q))
      : (byCategory[category] ?? []);
    if (date) papers = papers.filter((p) => p.published.startsWith(date));
    if (yearFrom != null || yearTo != null) {
      papers = papers.filter((p) => {
        const y = Number(p.published.slice(0, 4));
        return (yearFrom == null || y >= yearFrom) && (yearTo == null || y <= yearTo);
      });
    }
    return { papers: papers.slice(0, maxResults), fallbackNote: null };
  }

  throw new Error("Papers can only be fetched inside the desktop app.");
}
