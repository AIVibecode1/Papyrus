import { fetchPapers } from "@/lib/arxiv";
import type { Paper } from "@/lib/types";

/** Resolves a note's paper: favorites cache first, then a live arXiv id
 * lookup. S2 ids cannot be resolved via arXiv, so callers fall back to the
 * favorites cache only.
 *
 * Lives outside the NoteCard module because a `.tsx` file exporting both
 * a component and a plain function cannot be Fast Refreshed. */
export async function resolvePaper(paperId: string): Promise<Paper | null> {
  if (paperId.startsWith("s2:")) return null;
  try {
    const { papers } = await fetchPapers("cs.AI", 5, paperId, undefined, 0, "arxiv", "id");
    return papers[0] ?? null;
  } catch {
    return null;
  }
}
