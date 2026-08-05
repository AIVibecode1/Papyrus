import { invoke } from "@tauri-apps/api/core";

/**
 * Citation counts (Semantic Scholar, falling back to OpenAlex in the
 * Rust backend). Purely decorative enrichment: any failure returns an
 * empty map and the paper list renders unchanged. Returns the counts
 * plus whether ANY source answered (so the UI can tell "network down"
 * from "papers too fresh to have citation data yet").
 */
export async function fetchCitations(ids: string[]): Promise<{
  counts: Record<string, number>;
  reachable: boolean;
}> {
  if (ids.length === 0) return { counts: {}, reachable: false };
  try {
    if ("__TAURI_INTERNALS__" in window) {
      const [counts, reachable] = await invoke<[Record<string, number>, boolean]>(
        "fetch_citations",
        { ids },
      );
      return { counts, reachable };
    }
    const unique = [...new Set(ids)];
    const body = {
      ids: unique.map((id) => `ARXIV:${id.replace(/v\d+$/, "")}`),
    };
    const res = await fetch(
      "https://api.semanticscholar.org/graph/v1/paper/batch?fields=citationCount",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const entries = (await res.json()) as ({ citationCount?: number } | null)[];
    const counts: Record<string, number> = {};
    for (let i = 0; i < unique.length; i += 1) {
      const count = entries[i]?.citationCount;
      if (typeof count === "number") counts[unique[i]] = count;
    }
    return { counts, reachable: true };
  } catch {
    // Semantic Scholar sends no CORS headers, so the browser dev preview
    // cannot reach it (same situation as arXiv). The desktop app fetches
    // through Rust and gets real data. For the preview only, show clearly
    // sample counts derived from the id so the UI is demonstrable.
    if (import.meta.env.DEV && !("__TAURI_INTERNALS__" in window)) {
      const sample: Record<string, number> = {};
      for (const id of ids) {
        let hash = 0;
        for (const ch of id) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
        sample[id] = 3 + (hash % 38); // 3..40, sample data
      }
      return { counts: sample, reachable: true };
    }
    return { counts: {}, reachable: false };
  }
}
