import type { Paper } from "@/lib/types";

/** The bounded size of the "Today's picks" strip. */
export const PICKS_LIMIT = 5;

export interface PicksResult {
  /** The newest digest day that contributed papers (context label). */
  date: string | null;
  papers: Paper[];
}

/**
 * Deterministic "Today's picks": up to `limit` papers, newest digest day
 * first, spilling into older days only when a day has fewer papers than
 * the limit. Duplicates are skipped by id, and ordering is purely
 * recency + feed order — never citation counts (fresh papers are not
 * indexed yet, so citations would bias towards old work).
 */
export function pickPapers(
  byCategory: Record<string, Record<string, Paper[]>>,
  category: string,
  limit = PICKS_LIMIT,
): PicksResult {
  const days = byCategory[category] ?? {};
  const dates = Object.keys(days).sort().reverse(); // newest first
  if (dates.length === 0) return { date: null, papers: [] };
  const seen = new Set<string>();
  const papers: Paper[] = [];
  for (const date of dates) {
    for (const paper of days[date] ?? []) {
      if (seen.has(paper.id)) continue;
      seen.add(paper.id);
      papers.push(paper);
      if (papers.length >= limit) return { date: dates[0], papers };
    }
  }
  return { date: dates[0], papers };
}
